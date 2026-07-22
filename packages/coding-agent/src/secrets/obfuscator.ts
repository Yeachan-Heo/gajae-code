import { createHmac, randomBytes } from "node:crypto";
import type { Message, TextContent } from "@gajae-code/ai";
import { type SessionContext, transferSessionMessageIdentity } from "../session/session-manager";
import { compileSecretRegex } from "./regex";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface SecretEntry {
	type: "plain" | "regex";
	content: string;
	mode?: "obfuscate" | "replace";
	replacement?: string;
	flags?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Deterministic replacement generation
// ═══════════════════════════════════════════════════════════════════════════

const REPLACEMENT_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Generate a deterministic same-length replacement string from a secret value. */
function generateDeterministicReplacement(secret: string): string {
	// Simple hash: use Bun.hash for speed, seed from the secret bytes
	const hash = BigInt(Bun.hash(secret));
	const chars: string[] = [];
	let h = hash;
	for (let i = 0; i < secret.length; i++) {
		// Mix the hash for each character position
		h = h ^ (BigInt(i + 1) * 0x9e3779b97f4a7c15n);
		const idx = Number((h < 0n ? -h : h) % BigInt(REPLACEMENT_CHARS.length));
		chars.push(REPLACEMENT_CHARS[idx]);
	}
	return chars.join("");
}

// ═══════════════════════════════════════════════════════════════════════════
// Placeholder format
// ═══════════════════════════════════════════════════════════════════════════

const PLACEHOLDER_DOMAIN = "gjc.secret-obfuscation.placeholder.v1\0";
const PLACEHOLDER_RE = /#GJC1_[A-Za-z0-9_-]{22}#/g;

/** Build a versioned, authenticated placeholder whose identity depends only on the key and secret. */
function buildPlaceholder(secret: string, key: Uint8Array): string {
	const tag = createHmac("sha256", key)
		.update(PLACEHOLDER_DOMAIN)
		.update(secret, "utf8")
		.digest()
		.subarray(0, 16)
		.toString("base64url");
	return `#GJC1_${tag}#`;
}

// ═══════════════════════════════════════════════════════════════════════════
// SecretObfuscator
// ═══════════════════════════════════════════════════════════════════════════

export class SecretObfuscator {
	/** Key used to authenticate reversible placeholders. */
	#placeholderKey: Uint8Array;

	/** Plain secrets: secret → index (known at construction) */
	#plainMappings = new Map<string, number>();

	/** Regex entries (patterns compiled at construction) */
	#regexEntries: Array<{ regex: RegExp; mode: "obfuscate" | "replace"; replacement?: string }> = [];

	/** All obfuscate-mode mappings: index → { secret, placeholder } */
	#obfuscateMappings = new Map<number, { secret: string; placeholder: string }>();

	/** Replace-mode plain mappings: secret → replacement */
	#replaceMappings = new Map<string, string>();

	/** Replace-mode plain mappings sorted longest-first for deterministic longest-match replacement. */
	#sortedReplaceMappings: Array<{ secret: string; replacement: string }> = [];

	/** Obfuscate-mode plain and regex-discovered mappings sorted longest-first. */
	#sortedObfuscateMappings: Array<{ secret: string; index: number; placeholder: string }> = [];

	/** Reverse lookup for obfuscate-mode secrets to avoid scanning mappings. */
	#obfuscateIndexBySecret = new Map<string, number>();

	/** Reverse lookup for deobfuscation: placeholder → secret */
	#deobfuscateMap = new Map<string, string>();

	/** Combined plain-secret regex cache for single-pass replacement. */
	#combinedPlainRegex: RegExp | undefined;
	#combinedPlainReplacementBySecret = new Map<string, string>();
	#combinedPlainRegexDirty = true;
	#useSequentialPlainReplacement = false;

	/** Next available index for regex match discoveries */
	#nextIndex: number;

	/** Whether any secrets were configured */
	#hasAny: boolean;

	constructor(entries: SecretEntry[], key: Uint8Array = randomBytes(32)) {
		if (key.byteLength !== 32) throw new Error("Secret obfuscation key must be 32 bytes");
		this.#placeholderKey = Uint8Array.from(key);
		let index = 0;
		for (const entry of entries) {
			const mode = entry.mode ?? "obfuscate";

			if (entry.type === "plain") {
				if (mode === "obfuscate") {
					const placeholder = buildPlaceholder(entry.content, this.#placeholderKey);
					this.#plainMappings.set(entry.content, index);
					this.#obfuscateMappings.set(index, { secret: entry.content, placeholder });
					this.#deobfuscateMap.set(placeholder, entry.content);
					this.#obfuscateIndexBySecret.set(entry.content, index);
					index++;
				} else {
					// replace mode
					const replacement = entry.replacement ?? generateDeterministicReplacement(entry.content);
					this.#replaceMappings.set(entry.content, replacement);
				}
			} else {
				// regex type — compiled here, matches discovered during obfuscate()
				try {
					const regex = compileSecretRegex(entry.content, entry.flags);
					this.#regexEntries.push({ regex, mode, replacement: entry.replacement });
				} catch {
					// Invalid regex — skip silently (validation happens at load time)
				}
			}
		}

		this.#nextIndex = index;
		this.#sortedReplaceMappings = [...this.#replaceMappings]
			.sort((a, b) => b[0].length - a[0].length)
			.map(([secret, replacement]) => ({ secret, replacement }));
		this.#sortedObfuscateMappings = [...this.#plainMappings]
			.sort((a, b) => b[0].length - a[0].length)
			.map(([secret, mappingIndex]) => ({
				secret,
				index: mappingIndex,
				placeholder: this.#obfuscateMappings.get(mappingIndex)!.placeholder,
			}));
		this.#hasAny = entries.length > 0;
	}

	hasSecrets(): boolean {
		return this.#hasAny;
	}

	/** Obfuscate all secrets in text. Bidirectional placeholders for obfuscate mode, one-way for replace. */
	obfuscate(text: string): string {
		if (!this.#hasAny) return text;
		let result = this.#obfuscatePlainMappings(text);

		// 3. Process regex entries — discover new matches
		for (const entry of this.#regexEntries) {
			entry.regex.lastIndex = 0;
			const matches = new Set<string>();
			for (;;) {
				const match = entry.regex.exec(result);
				if (match === null) break;
				if (match[0].length === 0) {
					entry.regex.lastIndex++;
					continue;
				}
				matches.add(match[0]);
			}

			for (const matchValue of matches) {
				if (entry.mode === "replace") {
					const replacement = entry.replacement ?? generateDeterministicReplacement(matchValue);
					result = replaceAll(result, matchValue, replacement);
				} else {
					// obfuscate mode — get or create stable index
					let index = this.#findObfuscateIndex(matchValue);
					if (index === undefined) {
						index = this.#nextIndex++;
						const placeholder = buildPlaceholder(matchValue, this.#placeholderKey);
						this.#obfuscateMappings.set(index, { secret: matchValue, placeholder });
						this.#deobfuscateMap.set(placeholder, matchValue);
						this.#obfuscateIndexBySecret.set(matchValue, index);
						this.#insertSortedObfuscateMapping({ secret: matchValue, index, placeholder });
						this.#combinedPlainRegexDirty = true;
					}
					const mapping = this.#obfuscateMappings.get(index)!;
					result = replaceAll(result, matchValue, mapping.placeholder);
				}
			}
		}

		return result;
	}

	/** Deobfuscate obfuscate-mode placeholders back to original secrets. Replace-mode is NOT reversed. */
	deobfuscate(text: string): string {
		if (!this.#hasAny || !text.includes("#")) return text;
		return text.replace(PLACEHOLDER_RE, match => {
			return this.#deobfuscateMap.get(match) ?? match;
		});
	}

	/** Deep-walk an object, deobfuscating all string values. */
	deobfuscateObject<T>(obj: T): T {
		if (!this.#hasAny) return obj;
		return deepWalkStrings(obj, s => this.deobfuscate(s));
	}

	/** Find the obfuscate index for a known secret value. */
	#findObfuscateIndex(secret: string): number | undefined {
		return this.#obfuscateIndexBySecret.get(secret);
	}

	#insertSortedObfuscateMapping(mapping: { secret: string; index: number; placeholder: string }): void {
		let lo = 0;
		let hi = this.#sortedObfuscateMappings.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.#sortedObfuscateMappings[mid]!.secret.length < mapping.secret.length) {
				hi = mid;
			} else {
				lo = mid + 1;
			}
		}
		this.#sortedObfuscateMappings.splice(lo, 0, mapping);
	}

	#obfuscatePlainMappings(text: string): string {
		this.#ensureCombinedPlainRegex();
		if (this.#useSequentialPlainReplacement) return this.#obfuscatePlainMappingsSequential(text);
		if (!this.#combinedPlainRegex) return text;
		return text.replace(
			this.#combinedPlainRegex,
			match => this.#combinedPlainReplacementBySecret.get(match) ?? match,
		);
	}

	#obfuscatePlainMappingsSequential(text: string): string {
		let result = text;
		for (const mapping of this.#sortedReplaceMappings) {
			result = replaceAll(result, mapping.secret, mapping.replacement);
		}
		for (const mapping of this.#sortedObfuscateMappings) {
			result = replaceAll(result, mapping.secret, mapping.placeholder);
		}
		return result;
	}

	#ensureCombinedPlainRegex(): void {
		if (!this.#combinedPlainRegexDirty) return;
		this.#combinedPlainRegexDirty = false;
		this.#combinedPlainReplacementBySecret = new Map<string, string>();

		const mappings = [
			...this.#sortedReplaceMappings.map(mapping => ({ secret: mapping.secret, replacement: mapping.replacement })),
			...this.#sortedObfuscateMappings.map(mapping => ({
				secret: mapping.secret,
				replacement: mapping.placeholder,
			})),
		];

		this.#useSequentialPlainReplacement = mappings.some((mapping, index) =>
			mappings.some(
				(other, otherIndex) =>
					other.secret.length > 0 &&
					(mapping.replacement.includes(other.secret) ||
						(index !== otherIndex &&
							(mapping.secret.includes(other.secret) || other.secret.includes(mapping.secret)))),
			),
		);
		for (const mapping of mappings) {
			if (!this.#combinedPlainReplacementBySecret.has(mapping.secret))
				this.#combinedPlainReplacementBySecret.set(mapping.secret, mapping.replacement);
		}
		this.#combinedPlainRegex =
			mappings.length > 0
				? new RegExp(mappings.map(mapping => escapeRegex(mapping.secret)).join("|"), "g")
				: undefined;
	}
}

export function deobfuscateSessionContext(
	sessionContext: SessionContext,
	obfuscator: SecretObfuscator | undefined,
): SessionContext {
	if (!obfuscator?.hasSecrets()) return sessionContext;
	const messages = obfuscator.deobfuscateObject(sessionContext.messages);
	if (messages === sessionContext.messages) return sessionContext;
	transferSessionMessageIdentity(sessionContext.messages, messages);
	return { ...sessionContext, messages };
}

// ═══════════════════════════════════════════════════════════════════════════
// Message obfuscation (outbound to LLM)
// ═══════════════════════════════════════════════════════════════════════════

/** Obfuscate all text content in LLM messages (for outbound interception). */
export function obfuscateMessages(obfuscator: SecretObfuscator, messages: Message[]): Message[] {
	return messages.map(msg => {
		if (!Array.isArray(msg.content)) return msg;

		let changed = false;
		const content = msg.content.map(block => {
			if (block.type === "text") {
				const obfuscated = obfuscator.obfuscate(block.text);
				if (obfuscated !== block.text) {
					changed = true;
					return { ...block, text: obfuscated } as TextContent;
				}
			}
			return block;
		});

		return changed ? ({ ...msg, content } as typeof msg) : msg;
	});
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Replace all occurrences of `search` in `text` with `replacement`. */
function replaceAll(text: string, search: string, replacement: string): string {
	if (search.length === 0 || !text.includes(search)) return text;
	return text.split(search).join(replacement);
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Deep-walk an object, transforming all string values. */
function deepWalkStrings<T>(obj: T, transform: (s: string) => string): T {
	if (typeof obj === "string") {
		return transform(obj) as unknown as T;
	}
	if (Array.isArray(obj)) {
		let changed = false;
		const result = obj.map(item => {
			const transformed = deepWalkStrings(item, transform);
			if (transformed !== item) changed = true;
			return transformed;
		});
		return (changed ? result : obj) as unknown as T;
	}
	if (obj !== null && typeof obj === "object") {
		let changed = false;
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(obj)) {
			const value = (obj as Record<string, unknown>)[key];
			const transformed = deepWalkStrings(value, transform);
			if (transformed !== value) changed = true;
			result[key] = transformed;
		}
		return (changed ? result : obj) as T;
	}
	return obj;
}

import { createHmac, randomBytes } from "node:crypto";
import type { Message, TextContent } from "@gajae-code/ai/core";
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

/**
 * Domain separator for replace-mode replacement derivation. Distinct from
 * `PLACEHOLDER_DOMAIN` so a value minted under one construction can never be
 * confused with a value minted under the other, even with the same key.
 */
const REPLACEMENT_DOMAIN = "gjc.secret-obfuscation.replacement.v1\0";

/** One HMAC-SHA256 digest block length in bytes. */
const REPLACEMENT_DIGEST_BYTES = 32;

/** Largest accepted byte for uniform rejection sampling (256 - (256 % 62)). */
const REPLACEMENT_REJECT_THRESHOLD = 248;

/**
 * Generate a deterministic, keyed, same-length replacement string from a
 * secret value.
 *
 * COMPATIBILITY CONTRACT (required behavior, must never regress):
 * - Deterministic within a process: the same secret under the same key always
 *   yields the same replacement, independent of entry order or call order.
 * - Same length: `result.length === secret.length` (UTF-16 code units, i.e.
 *   `String.prototype.length` semantics — unchanged from the pre-fix
 *   implementation). Astral-plane characters count as two units, exactly as
 *   they did before.
 * - Allowed characters: output is restricted to `[A-Za-z0-9]` (62 chars).
 * - Explicit `replacement` values in secrets.yml are authoritative and are
 *   never derived; this path runs only when `replacement` is undefined.
 * - Replace mode stays one-way: the derived value is never reversed by
 *   `deobfuscate()`.
 *
 * THREAT MODEL (issue #4166):
 * - Attacker model: an observer sees one or more replacements (model context,
 *   provider-side logs, saved/shared transcripts) and has full knowledge of
 *   the public algorithm. Without the 32-byte obfuscation key they cannot
 *   confirm a candidate secret offline and cannot predict or precompute the
 *   replacement for any secret. The construction is a keyed PRF
 *   (HMAC-SHA256), so output is unpredictable without the key, and keyed
 *   domain separation keeps this construction distinct from the placeholder
 *   construction.
 * - Accepted residual disclosure: the replacement is same-length by design
 *   (required behavior above), so the secret's exact length is still
 *   observable. This is inherent to size-preserving substitution and is
 *   explicitly out of scope; the fix removes the *keyless confirmation*
 *   oracle, not the length signal.
 * - Cross-process stability / key rotation: the process key is generated per
 *   process (`PROCESS_SECRET_OBFUSCATION_KEY`), so derived replacements are
 *   stable within a process and differ across processes or after a key
 *   rotation. This is a deliberate decision, identical in scope to the
 *   obfuscate-mode placeholder behavior. Users who need stable values across
 *   processes or restarts must set an explicit `replacement` in secrets.yml.
 * - Collision/bias: output is a keyed pseudorandom mapping. Two distinct
 *   secrets can in principle collide (birthday bound over the 62^len output
 *   space); for realistic secret lengths this is negligible. Character
 *   distribution is uniform by construction: digest bytes are rejection-
 *   sampled (bytes 248-255 rejected, 256 - (256 % 62) = 248 = 62 * 4), so
 *   every character is exactly equally likely, with no modulo bias.
 * - Empty secrets: a zero-length secret yields an empty replacement and the
 *   obfuscator treats it as a no-op (load-time validation rejects empty
 *   content anyway). Unicode secrets are hashed as UTF-8 bytes, so encoding
 *   is canonical. Very long secrets expand via a counter-based HMAC stream
 *   in O(length) blocks; generation cost is linear in the secret length.
 * - Overlapping secrets and streaming: derivation is per-secret and does not
 *   depend on matching semantics (longest-first overlap handling is
 *   unchanged), and `obfuscate()` runs per complete text payload, so chunked
 *   output (e.g. streamed LLM messages) sees the same deterministic
 *   replacement for the same secret within a process.
 */
function generateDeterministicReplacement(secret: string, key: Uint8Array): string {
	const length = secret.length;
	if (length === 0) return "";
	const chars: string[] = [];
	// CTR-style expansion: HMAC(key, DOMAIN || counter || secret) per 32-byte
	// block. The counter is big-endian and fixed-width, so the stream is
	// unambiguous and never repeats.
	const counter = new Uint8Array(8);
	const counterView = new DataView(counter.buffer);
	let block: Uint8Array | undefined;
	let blockOffset = REPLACEMENT_DIGEST_BYTES;
	let blockIndex = 0;
	while (chars.length < length) {
		if (block === undefined || blockOffset >= REPLACEMENT_DIGEST_BYTES) {
			counterView.setUint32(4, blockIndex, false);
			block = createHmac("sha256", key).update(REPLACEMENT_DOMAIN).update(counter).update(secret, "utf8").digest();
			blockOffset = 0;
			blockIndex++;
		}
		const byte = block[blockOffset++]!;
		if (byte >= REPLACEMENT_REJECT_THRESHOLD) continue;
		chars.push(REPLACEMENT_CHARS[byte % REPLACEMENT_CHARS.length]!);
	}
	return chars.join("");
}

// ═══════════════════════════════════════════════════════════════════════════
// Placeholder format
// ═══════════════════════════════════════════════════════════════════════════

const PLACEHOLDER_DOMAIN = "gjc.secret-obfuscation.placeholder.v1\0";
const PLACEHOLDER_RE = /#GJC1_[A-Za-z0-9_-]{22}#/g;

/**
 * Last-resort outbound mask when substitution leaves a configured secret in
 * place (explicit replacement equal to the secret, or a replacement cycle).
 * Not a reversible `#GJC1_` placeholder.
 */
const OUTBOUND_SECRET_MASK = "#GJC_REDACTED#";

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
					const replacement =
						entry.replacement ?? generateDeterministicReplacement(entry.content, this.#placeholderKey);
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
					const replacement =
						entry.replacement ?? generateDeterministicReplacement(matchValue, this.#placeholderKey);
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

	/** Deep-walk an object, deobfuscating string keys and values, including JSON text. */
	deobfuscateObject<T>(obj: T): T {
		if (!this.#hasAny) return obj;
		return deobfuscateNode(this, obj, 0) as T;
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

	/**
	 * True when a configured plain secret or non-empty regex match occurs in
	 * `text`. Unlike `obfuscate(text) !== text`, a no-op replacement or a
	 * replacement cycle still counts.
	 */
	containsConfiguredSecret(text: string): boolean {
		if (!this.#hasAny || text.length === 0) return false;
		for (const secret of this.#plainMappings.keys()) {
			if (secret.length > 0 && text.includes(secret)) return true;
		}
		for (const secret of this.#replaceMappings.keys()) {
			if (secret.length > 0 && text.includes(secret)) return true;
		}
		for (const entry of this.#regexEntries) {
			entry.regex.lastIndex = 0;
			for (;;) {
				const match = entry.regex.exec(text);
				if (match === null) break;
				if (match[0].length === 0) {
					entry.regex.lastIndex++;
					continue;
				}
				return true;
			}
		}
		return false;
	}

	/**
	 * Substitute secrets for an outbound copy. An explicit replacement equal
	 * to its secret stays. A cycle that restores any other secret is masked.
	 * The mask is not reversed by `deobfuscate()`.
	 */
	scrubOutbound(text: string): string {
		const obfuscated = this.#neutralizeRevealingReplacements(this.obfuscate(text));
		if (!stringRevealsSecret(this, obfuscated, 0)) return obfuscated;
		const masked = this.#neutralizeRevealingReplacements(this.#maskRemainingSecrets(obfuscated));
		return stringRevealsSecret(this, masked, 0) ? OUTBOUND_SECRET_MASK : masked;
	}

	/**
	 * A replacement can be another secret written in JSON string form. Swap
	 * that replacement for the outbound mask wherever it was inserted.
	 */
	#neutralizeRevealingReplacements(text: string): string {
		let result = text;
		for (const [secret, replacement] of this.#replaceMappings) {
			if (replacement.length === 0 || replacement === secret || replacement === OUTBOUND_SECRET_MASK) continue;
			if (!result.includes(replacement) || !stringRevealsSecret(this, replacement, 0)) continue;
			result = replaceAll(result, replacement, OUTBOUND_SECRET_MASK);
		}
		for (const entry of this.#regexEntries) {
			if (
				entry.mode !== "replace" ||
				entry.replacement === undefined ||
				entry.replacement === OUTBOUND_SECRET_MASK
			) {
				continue;
			}
			if (!result.includes(entry.replacement) || !stringRevealsSecret(this, entry.replacement, 0)) continue;
			result = replaceAll(result, entry.replacement, OUTBOUND_SECRET_MASK);
		}
		return result;
	}

	/**
	 * True when `text` still contains a configured secret that was not
	 * explicitly replaced with itself.
	 */
	hasUnintentionalSecret(text: string): boolean {
		if (!this.#hasAny || text.length === 0) return false;
		for (const secret of this.#plainMappings.keys()) {
			if (secret.length > 0 && text.includes(secret)) return true;
		}
		for (const [secret, replacement] of this.#replaceMappings) {
			if (secret.length > 0 && replacement !== secret && text.includes(secret)) return true;
		}
		for (const entry of this.#regexEntries) {
			entry.regex.lastIndex = 0;
			for (;;) {
				const match = entry.regex.exec(text);
				if (match === null) break;
				if (match[0].length === 0) {
					entry.regex.lastIndex++;
					continue;
				}
				if (entry.mode === "replace" && entry.replacement === match[0]) continue;
				return true;
			}
		}
		return false;
	}

	/** Spans of configured secrets. Self-replacements are included only when requested. */
	findSecretSpans(text: string, unintentionalOnly: boolean): Array<[number, number]> {
		const spans: Array<[number, number]> = [];
		if (!this.#hasAny || text.length === 0) return spans;
		const pushLiteral = (secret: string) => {
			if (secret.length === 0) return;
			let from = 0;
			while (from < text.length) {
				const at = text.indexOf(secret, from);
				if (at < 0) break;
				spans.push([at, at + secret.length]);
				from = at + Math.max(secret.length, 1);
			}
		};
		for (const secret of this.#plainMappings.keys()) pushLiteral(secret);
		for (const [secret, replacement] of this.#replaceMappings) {
			if (unintentionalOnly && replacement === secret) continue;
			pushLiteral(secret);
		}
		for (const entry of this.#regexEntries) {
			entry.regex.lastIndex = 0;
			for (;;) {
				const match = entry.regex.exec(text);
				if (match === null) break;
				if (match[0].length === 0) {
					entry.regex.lastIndex++;
					continue;
				}
				if (unintentionalOnly && entry.mode === "replace" && entry.replacement === match[0]) continue;
				spans.push([match.index, match.index + match[0].length]);
			}
		}
		return spans;
	}

	#maskRemainingSecrets(text: string): string {
		let result = text;
		const replaceSecrets = [...this.#replaceMappings.entries()].sort(
			(left, right) => right[0].length - left[0].length,
		);
		for (const [secret, replacement] of replaceSecrets) {
			if (secret.length === 0 || replacement === secret || secret === OUTBOUND_SECRET_MASK) continue;
			if (result.includes(secret)) result = replaceAll(result, secret, OUTBOUND_SECRET_MASK);
		}
		const plainSecrets = [...this.#plainMappings.keys()].sort((left, right) => right.length - left.length);
		for (const secret of plainSecrets) {
			if (secret.length === 0 || secret === OUTBOUND_SECRET_MASK) continue;
			if (result.includes(secret)) result = replaceAll(result, secret, OUTBOUND_SECRET_MASK);
		}
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
				if (matchValue === OUTBOUND_SECRET_MASK) continue;
				if (entry.mode === "replace" && entry.replacement === matchValue) continue;
				result = replaceAll(result, matchValue, OUTBOUND_SECRET_MASK);
			}
		}
		return result;
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

/**
 * Obfuscate text and tool-call arguments. Unsigned thinking text is redacted.
 * A block whose provider replays it under integrity metadata is omitted when a
 * configured secret occurs in those bytes or in the text that would be sent
 * with them, including a secret that is visible only after JSON decoding and a
 * secret that substitution would leave unchanged. OpenAI Responses sends the
 * reasoning item in `thinkingSignature` (and, when present, `providerPayload`
 * history) rather than the thinking prose, so a clean signature is kept and
 * only the prose is redacted. Real image bytes are not scanned. A history
 * content part whose type is an image is the only place an image payload field
 * is left untouched; the same shape inside tool arguments or thinking text is
 * ordinary JSON and is redacted.
 */
export function obfuscateMessages(obfuscator: SecretObfuscator, messages: Message[]): Message[] {
	return messages.map(msg => {
		const payload = scrubHistoryPayload(obfuscator, readProviderPayload(msg));
		const payloadChanged = payload !== readProviderPayload(msg);
		if (!Array.isArray(msg.content)) {
			const content = typeof msg.content === "string" ? scrubProtocolString(obfuscator, msg.content) : msg.content;
			const contentChanged = content !== msg.content;
			if (!contentChanged && !payloadChanged) return msg;
			const next = contentChanged ? { ...msg, content } : { ...msg };
			return payloadChanged ? ({ ...next, providerPayload: payload } as typeof msg) : (next as typeof msg);
		}

		const api = msg.role === "assistant" ? msg.api : undefined;
		let changed = false;
		const content: object[] = [];
		for (const block of msg.content) {
			if (block.type === "text") {
				const obfuscated = obfuscator.scrubOutbound(block.text);
				if (obfuscated !== block.text) {
					changed = true;
					content.push({ ...block, text: obfuscated } as TextContent);
				} else {
					content.push(block);
				}
				continue;
			}
			if (block.type === "thinking") {
				const next = scrubThinkingBlock(obfuscator, block, api);
				if (next === undefined) {
					changed = true;
					continue;
				}
				if (next !== block) changed = true;
				content.push(next);
				continue;
			}
			if (block.type === "redactedThinking") {
				if (textHasSecret(obfuscator, block.data)) {
					changed = true;
					continue;
				}
				content.push(block);
				continue;
			}
			if (block.type === "toolCall") {
				const obfuscatedArguments = scrubJsonNode(obfuscator, block.arguments, 0);
				if (treeHasUnintentionalSecret(obfuscator, obfuscatedArguments, 0)) {
					changed = true;
					continue;
				}
				const dropSignature =
					textHasSecret(obfuscator, block.thoughtSignature) || obfuscatedArguments !== block.arguments;
				if (dropSignature) {
					changed = true;
					const { thoughtSignature: _signature, ...rest } = block;
					content.push({ ...rest, arguments: obfuscatedArguments });
					continue;
				}
			}
			content.push(block);
		}

		if (!changed && !payloadChanged) return msg;
		const next = changed ? { ...msg, content } : { ...msg };
		return payloadChanged ? ({ ...next, providerPayload: payload } as typeof msg) : (next as typeof msg);
	});
}

function textHasSecret(obfuscator: SecretObfuscator, value: string | undefined, depth = 0): boolean {
	if (value === undefined || value.length === 0) return false;
	if (depth >= 4) return obfuscator.containsConfiguredSecret(value);
	const pieces = splitJsonPieces(value);
	if (pieces) {
		for (const piece of pieces) {
			if (piece.kind === "str" && textHasSecret(obfuscator, piece.decoded, depth + 1)) return true;
		}
		return jsonSyntaxContainsSecret(obfuscator, value, pieces, false);
	}
	return obfuscator.containsConfiguredSecret(value);
}

/** Decode a JSON object, array, or string. Other text is not JSON. */
function parseJsonValue(value: string): unknown | undefined {
	const trimmed = value.trim();
	if (trimmed.length < 2) return undefined;
	const first = trimmed[0];
	if (first !== "{" && first !== "[" && first !== '"') return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function valueTreeHasSecret(
	obfuscator: SecretObfuscator,
	value: unknown,
	depth: number,
	seen: WeakSet<object> = new WeakSet(),
): boolean {
	if (typeof value === "string") return textHasSecret(obfuscator, value, depth);
	if (typeof value !== "object" || value === null) return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.some(item => valueTreeHasSecret(obfuscator, item, depth, seen));
	for (const key of Object.keys(value)) {
		if (textHasSecret(obfuscator, key, depth)) return true;
		if (valueTreeHasSecret(obfuscator, (value as Record<string, unknown>)[key], depth, seen)) return true;
	}
	return false;
}

/**
 * Redact a protocol string. JSON string tokens are decoded before matching so
 * escapes are not treated as literal secrets, and non-string tokens such as
 * integers are copied unchanged. A secret that is the whole JSON document
 * becomes `{}` or `[]` so the result stays JSON.
 */
function scrubProtocolString(obfuscator: SecretObfuscator, value: string, depth = 0): string {
	if (depth < 4) {
		const rewritten = mapJsonStrings(value, decoded => scrubProtocolString(obfuscator, decoded, depth + 1));
		if (rewritten !== undefined) {
			const numbered = redactJsonNumberSecrets(obfuscator, rewritten);
			const pieces = splitJsonPieces(numbered);
			if (pieces && jsonSyntaxContainsSecret(obfuscator, numbered, pieces, true)) return jsonSafeFallback(numbered);
			return numbered;
		}
	}
	const masked = obfuscator.scrubOutbound(value);
	return obfuscator.hasUnintentionalSecret(masked) ? OUTBOUND_SECRET_MASK : masked;
}

function stringRevealsSecret(obfuscator: SecretObfuscator, value: string, depth: number): boolean {
	if (depth >= 4) return obfuscator.hasUnintentionalSecret(value);
	const pieces = splitJsonPieces(value);
	if (pieces) {
		for (const piece of pieces) {
			if (piece.kind === "str" && stringRevealsSecret(obfuscator, piece.decoded, depth + 1)) return true;
		}
		return jsonSyntaxContainsSecret(obfuscator, value, pieces, true);
	}
	return obfuscator.hasUnintentionalSecret(value);
}

function jsonSafeFallback(value: string): string {
	const parsed = parseJsonValue(value);
	if (Array.isArray(parsed)) return "[]";
	if (parsed !== null && typeof parsed === "object") return "{}";
	if (typeof parsed === "string") return JSON.stringify(OUTBOUND_SECRET_MASK);
	return OUTBOUND_SECRET_MASK;
}

interface JsonPiece {
	kind: "raw" | "str";
	text: string;
	decoded: string;
	start: number;
	end: number;
}

/** Split a JSON document into raw tokens and decoded string tokens. Numbers stay raw. */
function splitJsonPieces(input: string): JsonPiece[] | undefined {
	const trimmed = input.trim();
	if (trimmed.length < 2) return undefined;
	const first = trimmed[0];
	if (first !== "{" && first !== "[" && first !== '"') return undefined;
	try {
		JSON.parse(input);
	} catch {
		return undefined;
	}
	const pieces: JsonPiece[] = [];
	let cursor = 0;
	while (cursor < input.length) {
		if (input[cursor] !== '"') {
			const start = cursor;
			while (cursor < input.length && input[cursor] !== '"') cursor++;
			pieces.push({ kind: "raw", text: input.slice(start, cursor), decoded: "", start, end: cursor });
			continue;
		}
		const start = cursor;
		const read = readJsonString(input, cursor);
		if (read === undefined) return undefined;
		cursor = read.end;
		pieces.push({
			kind: "str",
			text: input.slice(start, cursor),
			decoded: read.decoded,
			start,
			end: cursor,
		});
	}
	return pieces;
}

function readJsonString(input: string, start: number): { decoded: string; end: number } | undefined {
	let cursor = start + 1;
	let decoded = "";
	while (cursor < input.length) {
		const ch = input[cursor];
		if (ch === '"') return { decoded, end: cursor + 1 };
		if (ch === "\\") {
			cursor++;
			if (cursor >= input.length) return undefined;
			const escaped = input[cursor];
			cursor++;
			if (escaped === '"' || escaped === "\\" || escaped === "/") {
				decoded += escaped;
				continue;
			}
			if (escaped === "b") {
				decoded += "\b";
				continue;
			}
			if (escaped === "f") {
				decoded += "\f";
				continue;
			}
			if (escaped === "n") {
				decoded += "\n";
				continue;
			}
			if (escaped === "r") {
				decoded += "\r";
				continue;
			}
			if (escaped === "t") {
				decoded += "\t";
				continue;
			}
			if (escaped === "u") {
				const hex = input.slice(cursor, cursor + 4);
				if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
				decoded += String.fromCharCode(Number.parseInt(hex, 16));
				cursor += 4;
				continue;
			}
			return undefined;
		}
		if (ch !== undefined && ch.charCodeAt(0) < 0x20) return undefined;
		decoded += ch ?? "";
		cursor++;
	}
	return undefined;
}

function mapJsonStrings(input: string, mapDecoded: (decoded: string) => string): string | undefined {
	const pieces = splitJsonPieces(input);
	if (!pieces) return undefined;
	let changed = false;
	let rebuilt = "";
	for (const piece of pieces) {
		if (piece.kind === "raw") {
			rebuilt += piece.text;
			continue;
		}
		const next = mapDecoded(piece.decoded);
		if (next !== piece.decoded) {
			changed = true;
			rebuilt += JSON.stringify(next);
		} else {
			rebuilt += piece.text;
		}
	}
	return changed ? rebuilt : input;
}

const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/** A configured secret that is a JSON number is replaced. Other number lexemes stay byte-for-byte. */
function redactJsonNumberSecrets(obfuscator: SecretObfuscator, text: string): string {
	const pieces = splitJsonPieces(text);
	if (!pieces) return text;
	let changed = false;
	let rebuilt = "";
	for (const piece of pieces) {
		if (piece.kind === "str") {
			rebuilt += piece.text;
			continue;
		}
		JSON_NUMBER.lastIndex = 0;
		rebuilt += piece.text.replace(JSON_NUMBER, number => {
			if (!obfuscator.hasUnintentionalSecret(number)) return number;
			changed = true;
			const next = obfuscator.scrubOutbound(number);
			return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(next) ? next : JSON.stringify(next);
		});
	}
	return changed ? rebuilt : text;
}

/** A secret in raw JSON syntax, not one that exists only because an escape looks like it. */
function jsonSyntaxContainsSecret(
	obfuscator: SecretObfuscator,
	text: string,
	pieces: JsonPiece[],
	unintentionalOnly: boolean,
): boolean {
	for (const [start, end] of obfuscator.findSecretSpans(text, unintentionalOnly)) {
		const inside = pieces.find(piece => piece.kind === "str" && start >= piece.start && end <= piece.end);
		if (!inside) return true;
		const decodedHasIt = unintentionalOnly
			? obfuscator.hasUnintentionalSecret(inside.decoded)
			: obfuscator.containsConfiguredSecret(inside.decoded);
		if (decodedHasIt) return true;
	}
	return false;
}

/** Walk objects and arrays, including keys. Every string is semantic. */
function scrubJsonNode(obfuscator: SecretObfuscator, value: unknown, depth: number): unknown {
	if (typeof value === "string") return scrubProtocolString(obfuscator, value, depth);
	if (Array.isArray(value)) {
		let changed = false;
		const result = value.map(item => {
			const next = scrubJsonNode(obfuscator, item, depth);
			if (next !== item) changed = true;
			return next;
		});
		return changed ? result : value;
	}
	if (value !== null && typeof value === "object") {
		let changed = false;
		const result: Record<string, unknown> = {};
		const source = value as Record<string, unknown>;
		for (const key of Object.keys(source)) {
			const nextKey = scrubProtocolString(obfuscator, key, depth);
			const nextValue = scrubJsonNode(obfuscator, source[key], depth);
			if (nextKey !== key || nextValue !== source[key]) changed = true;
			Object.defineProperty(result, nextKey, {
				value: nextValue,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return changed ? result : value;
	}
	return value;
}

function treeHasUnintentionalSecret(
	obfuscator: SecretObfuscator,
	value: unknown,
	depth: number,
	seen: WeakSet<object> = new WeakSet(),
): boolean {
	if (typeof value === "string") return stringRevealsSecret(obfuscator, value, depth);
	if (typeof value !== "object" || value === null) return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.some(item => treeHasUnintentionalSecret(obfuscator, item, depth, seen));
	for (const key of Object.keys(value)) {
		if (stringRevealsSecret(obfuscator, key, depth)) return true;
		if (treeHasUnintentionalSecret(obfuscator, (value as Record<string, unknown>)[key], depth, seen)) return true;
	}
	return false;
}

const HISTORY_IMAGE_PART_TYPES = new Set(["input_image", "output_image", "image", "image_url"]);
const IMAGE_PAYLOAD_KEYS = new Set(["image_url", "image", "data", "inline_data", "inlineData"]);

function isDirectHistoryImagePart(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const type = (value as { type?: unknown }).type;
	return typeof type === "string" && HISTORY_IMAGE_PART_TYPES.has(type);
}

/**
 * History message content is the only image boundary. Payload fields on a
 * direct image part stay byte-for-byte. Every other field, including a nested
 * object that merely says type "image", is redacted.
 */
function scrubHistoryMessageContent(obfuscator: SecretObfuscator, content: unknown[]): unknown[] {
	let changed = false;
	const result = content.map(part => {
		if (!isDirectHistoryImagePart(part)) {
			const next = scrubJsonNode(obfuscator, part, 0);
			if (next !== part) changed = true;
			return next;
		}
		let partChanged = false;
		const scrubbed: Record<string, unknown> = {};
		for (const key of Object.keys(part)) {
			const current = part[key];
			if (IMAGE_PAYLOAD_KEYS.has(key)) {
				Object.defineProperty(scrubbed, key, {
					value: current,
					enumerable: true,
					writable: true,
					configurable: true,
				});
				continue;
			}
			const nextKey = scrubProtocolString(obfuscator, key, 0);
			const nextValue = scrubJsonNode(obfuscator, current, 0);
			if (nextKey !== key || nextValue !== current) partChanged = true;
			Object.defineProperty(scrubbed, nextKey, {
				value: nextValue,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		if (partChanged) changed = true;
		return partChanged ? scrubbed : part;
	});
	return changed ? result : content;
}

function historyContentHasUnintentionalSecret(obfuscator: SecretObfuscator, content: unknown[]): boolean {
	for (const part of content) {
		if (!isDirectHistoryImagePart(part)) {
			if (treeHasUnintentionalSecret(obfuscator, part, 0)) return true;
			continue;
		}
		for (const key of Object.keys(part)) {
			if (IMAGE_PAYLOAD_KEYS.has(key)) continue;
			if (obfuscator.hasUnintentionalSecret(key)) return true;
			if (treeHasUnintentionalSecret(obfuscator, part[key], 0)) return true;
		}
	}
	return false;
}

const RESPONSES_APIS = new Set(["openai-responses", "azure-openai-responses", "openai-codex-responses"]);
const SIGNED_TEXT_APIS = new Set(["anthropic-messages", "bedrock-converse-stream"]);

/** Google only replays a thought signature when it is valid base64. */
function signatureIsGoogleThought(signature: string | undefined): boolean {
	if (!signature || signature.length % 4 !== 0) return false;
	return /^[A-Za-z0-9+/]+={0,2}$/.test(signature);
}

/**
 * Decide per provider whether thinking text can be redacted in place.
 * Anthropic, Bedrock, and Google send the thinking text together with a
 * signature, so a secret there drops the block instead of rewriting it.
 * Responses sends `JSON.parse(thinkingSignature)` and leaves the prose off
 * the wire, so a clean signature stays byte-for-byte.
 */
function scrubThinkingBlock<
	T extends {
		type: "thinking";
		thinking: string;
		thinkingSignature?: string;
		itemId?: string;
		summaryText?: string;
		rawText?: string;
	},
>(obfuscator: SecretObfuscator, block: T, api: string | undefined): T | undefined {
	const secretInSignature = textHasSecret(obfuscator, block.thinkingSignature);
	const secretInItemId = textHasSecret(obfuscator, block.itemId);
	const secretInSemantic =
		textHasSecret(obfuscator, block.thinking) ||
		textHasSecret(obfuscator, block.summaryText) ||
		textHasSecret(obfuscator, block.rawText);

	if (api !== undefined && RESPONSES_APIS.has(api)) {
		if (secretInSignature || secretInItemId) return undefined;
		if (!secretInSemantic) return block;
		return finishThinkingText(obfuscator, block);
	}
	if (api === "openai-completions") {
		if (secretInSignature || secretInItemId) return undefined;
		if (!secretInSemantic) return block;
		return finishThinkingText(obfuscator, block);
	}
	if (api?.startsWith("google-")) {
		if (secretInSignature || secretInItemId) return undefined;
		if (signatureIsGoogleThought(block.thinkingSignature) && secretInSemantic) return undefined;
		if (!secretInSemantic) return block;
		return finishThinkingText(obfuscator, block);
	}
	if (api !== undefined && SIGNED_TEXT_APIS.has(api)) {
		const signed = Boolean(block.thinkingSignature?.trim());
		if (secretInSignature || secretInItemId || (signed && secretInSemantic)) return undefined;
		if (!secretInSemantic) return block;
		return finishThinkingText(obfuscator, block);
	}
	const signed = Boolean(block.thinkingSignature?.trim() || block.itemId?.trim());
	if (secretInSignature || secretInItemId || (signed && secretInSemantic)) return undefined;
	if (!secretInSemantic) return block;
	return finishThinkingText(obfuscator, block);
}

function finishThinkingText<
	T extends {
		thinking: string;
		summaryText?: string;
		rawText?: string;
	},
>(obfuscator: SecretObfuscator, block: T): T | undefined {
	const redacted = redactThinkingText(obfuscator, block);
	if (outboundTextLeaks(obfuscator, redacted.thinking)) return undefined;
	if (redacted.summaryText !== undefined && outboundTextLeaks(obfuscator, redacted.summaryText)) return undefined;
	if (redacted.rawText !== undefined && outboundTextLeaks(obfuscator, redacted.rawText)) return undefined;
	return redacted;
}

function outboundTextLeaks(obfuscator: SecretObfuscator, text: string): boolean {
	return stringRevealsSecret(obfuscator, text, 0);
}

function redactThinkingText<
	T extends {
		thinking: string;
		summaryText?: string;
		rawText?: string;
	},
>(obfuscator: SecretObfuscator, block: T): T {
	const thinking = scrubProtocolString(obfuscator, block.thinking);
	const summaryText = block.summaryText !== undefined ? scrubProtocolString(obfuscator, block.summaryText) : undefined;
	const rawText = block.rawText !== undefined ? scrubProtocolString(obfuscator, block.rawText) : undefined;
	if (thinking === block.thinking && summaryText === block.summaryText && rawText === block.rawText) return block;
	return {
		...block,
		thinking,
		...(block.summaryText !== undefined ? { summaryText } : {}),
		...(block.rawText !== undefined ? { rawText } : {}),
	};
}

function readProviderPayload(msg: object): { type?: unknown; items?: unknown } | undefined {
	if (!("providerPayload" in msg)) return undefined;
	return (msg as { providerPayload?: { type?: unknown; items?: unknown } }).providerPayload;
}

/**
 * Native Responses replay prefers `providerPayload.items` over thinking blocks.
 * Reasoning items are opaque and are dropped whole. Tool arguments and message
 * text are semantic and are redacted in place.
 */
function scrubHistoryPayload<T>(obfuscator: SecretObfuscator, payload: T): T {
	if (!payload || typeof payload !== "object") return payload;
	const record = payload as { type?: unknown; items?: unknown };
	if (record.type !== "openaiResponsesHistory" || !Array.isArray(record.items)) return payload;
	let changed = false;
	const items: unknown[] = [];
	for (const item of record.items) {
		const next = scrubHistoryItem(obfuscator, item);
		if (next === undefined) {
			changed = true;
			continue;
		}
		if (next !== item) changed = true;
		items.push(next);
	}
	if (!changed) return payload;
	return { ...record, items } as T;
}

function scrubHistoryItem(obfuscator: SecretObfuscator, item: unknown): unknown | undefined {
	if (!item || typeof item !== "object") {
		return typeof item === "string" && textHasSecret(obfuscator, item) ? undefined : item;
	}
	const record = item as Record<string, unknown>;
	if (record.type === "reasoning") return historyItemHasSecret(obfuscator, record) ? undefined : record;
	if (record.type === "function_call") return rewriteHistoryField(obfuscator, record, "arguments");
	if (record.type === "custom_tool_call") return rewriteHistoryField(obfuscator, record, "input");
	if (record.type === "function_call_output" || record.type === "custom_tool_call_output") {
		return rewriteHistoryField(obfuscator, record, "output");
	}
	if (record.type === "message" && Array.isArray(record.content)) {
		if (opaqueSiblingHasSecret(obfuscator, record, "content")) return undefined;
		const content = scrubHistoryMessageContent(obfuscator, record.content);
		if (historyContentHasUnintentionalSecret(obfuscator, content)) return undefined;
		return content === record.content ? record : { ...record, content };
	}
	return historyItemHasSecret(obfuscator, record) ? undefined : record;
}

function rewriteHistoryField(
	obfuscator: SecretObfuscator,
	item: Record<string, unknown>,
	key: "arguments" | "input" | "output",
): Record<string, unknown> | undefined {
	if (opaqueSiblingHasSecret(obfuscator, item, key)) return undefined;
	if (!(key in item)) return item;
	const next = scrubProtocolValue(obfuscator, item[key]);
	if (treeHasUnintentionalSecret(obfuscator, next, 0)) return undefined;
	return next === item[key] ? item : { ...item, [key]: next };
}

function opaqueSiblingHasSecret(
	obfuscator: SecretObfuscator,
	item: Record<string, unknown>,
	semanticKey: string,
): boolean {
	for (const key of Object.keys(item)) {
		if (key === semanticKey || key === "type") continue;
		if (valueTreeHasSecret(obfuscator, item[key], 0)) return true;
	}
	return false;
}

function scrubProtocolValue(obfuscator: SecretObfuscator, value: unknown, depth = 0): unknown {
	return scrubJsonNode(obfuscator, value, depth);
}

function historyItemHasSecret(obfuscator: SecretObfuscator, item: Record<string, unknown>): boolean {
	return valueTreeHasSecret(obfuscator, item, 0);
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

function deobfuscateNode(obfuscator: SecretObfuscator, value: unknown, depth: number): unknown {
	if (typeof value === "string") {
		if (depth < 4) {
			const rewritten = mapJsonStrings(value, decoded => {
				const next = deobfuscateNode(obfuscator, decoded, depth + 1);
				return typeof next === "string" ? next : decoded;
			});
			if (rewritten !== undefined) return rewritten;
		}
		return obfuscator.deobfuscate(value);
	}
	if (Array.isArray(value)) {
		let changed = false;
		const result = value.map(item => {
			const next = deobfuscateNode(obfuscator, item, depth);
			if (next !== item) changed = true;
			return next;
		});
		return changed ? result : value;
	}
	if (value !== null && typeof value === "object") {
		let changed = false;
		const result: Record<string, unknown> = {};
		const source = value as Record<string, unknown>;
		for (const key of Object.keys(source)) {
			const nextKeyValue = deobfuscateNode(obfuscator, key, depth);
			const nextKey = typeof nextKeyValue === "string" ? nextKeyValue : key;
			const nextValue = deobfuscateNode(obfuscator, source[key], depth);
			if (nextKey !== key || nextValue !== source[key]) changed = true;
			Object.defineProperty(result, nextKey, {
				value: nextValue,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return changed ? result : value;
	}
	return value;
}

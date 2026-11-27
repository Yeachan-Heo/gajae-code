import { extractStructuredApiKeyToken } from "@gajae-code/ai/core";
import type { AuthStorage } from "../session/auth-storage";

/** Credential bytes stay in-process. This neither resolves keys nor refreshes OAuth. */
export function collectSdkStoredSecrets(authStorage: AuthStorage): string[] {
	const secrets = new Set<string>();
	for (const entry of Object.values(authStorage.getAll())) {
		for (const credential of Array.isArray(entry) ? entry : [entry]) {
			if (credential.type === "api_key") {
				if (credential.key) secrets.add(credential.key);
				const token = extractStructuredApiKeyToken(credential.key);
				if (token) secrets.add(token);
			} else {
				if (credential.access) secrets.add(credential.access);
				if (credential.refresh) secrets.add(credential.refresh);
			}
		}
	}
	return [...secrets];
}

export interface StoredSecretMaskOptions {
	/** Mask a trailing prefix of a literal at least this long: text cut off mid-credential. */
	trailingPartial?: number;
	/** Mask a leading suffix of a literal at least this long: text that starts mid-credential. */
	leadingPartial?: number;
}

/** Length of the longest suffix of `text` that is a proper prefix of `pattern`, in linear time. */
function overlap(text: string, pattern: string): number {
	const prefixes = new Uint32Array(pattern.length);
	for (let index = 1, matched = 0; index < pattern.length; index++) {
		while (matched && pattern[index] !== pattern[matched]) matched = prefixes[matched - 1]!;
		if (pattern[index] === pattern[matched]) matched++;
		prefixes[index] = matched;
	}
	let matched = 0;
	for (let index = Math.max(0, text.length - pattern.length + 1); index < text.length; index++) {
		while (matched && text[index] !== pattern[matched]) matched = prefixes[matched - 1]!;
		if (text[index] === pattern[matched]) matched++;
	}
	return matched;
}

function reversed(value: string): string {
	return value.split("").reverse().join("");
}

/**
 * Mark every occurrence of a known credential literal in `masks` (one slot per
 * UTF-16 unit of `text`). Marks accumulate, so overlapping matches form a union
 * and one credential cannot hide another's remainder. Empty literals are ignored.
 */
export function markStoredSecrets(
	text: string,
	secrets: readonly string[],
	masks: Uint8Array,
	options: StoredSecretMaskOptions = {},
): void {
	const { trailingPartial, leadingPartial } = options;
	for (const secret of secrets) {
		if (!secret) continue;
		for (let start = text.indexOf(secret); start !== -1; start = text.indexOf(secret, start + 1))
			masks.fill(1, start, start + secret.length);
		if (trailingPartial !== undefined) {
			const matched = overlap(text, secret);
			if (matched && matched >= trailingPartial) masks.fill(1, text.length - matched, text.length);
		}
		if (leadingPartial !== undefined) {
			const head = reversed(text.slice(0, secret.length - 1));
			const matched = overlap(head, reversed(secret));
			if (matched && matched >= leadingPartial) masks.fill(1, 0, matched);
		}
	}
}

/**
 * Replace each masked run of `text` with `marker`. A mask that touches one half
 * of a UTF-16 surrogate pair covers the whole pair.
 */
export function replaceMaskedRuns(text: string, masks: Uint8Array, marker: string): string {
	for (let index = 0; index + 1 < text.length; index++) {
		const first = text.charCodeAt(index);
		const second = text.charCodeAt(index + 1);
		if (
			first >= 0xd800 &&
			first <= 0xdbff &&
			second >= 0xdc00 &&
			second <= 0xdfff &&
			(masks[index] || masks[index + 1])
		) {
			masks[index] = 1;
			masks[index + 1] = 1;
		}
	}
	const parts: string[] = [];
	for (let index = 0; index < text.length; ) {
		const start = index;
		const masked = masks[index];
		while (index < text.length && masks[index] === masked) index++;
		parts.push(masked ? marker : text.slice(start, index));
	}
	return parts.join("");
}

/** Replace every known credential literal in `text` with `marker`; see {@link markStoredSecrets}. */
export function maskStoredSecrets(
	text: string,
	secrets: readonly string[],
	marker: string,
	options: StoredSecretMaskOptions = {},
): string {
	const masks = new Uint8Array(text.length);
	markStoredSecrets(text, secrets, masks, options);
	return replaceMaskedRuns(text, masks, marker);
}

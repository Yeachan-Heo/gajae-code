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

/**
 * Replace every occurrence of a known credential literal with `marker`.
 *
 * Matches are masked as a union, so an overlapping credential cannot hide
 * another match and leave its remainder visible. A mask that touches one half
 * of a UTF-16 surrogate pair covers the whole pair. With `maskPartialSuffix`,
 * a trailing prefix of any literal (text cut off mid-credential) is masked too.
 * Empty literals are ignored.
 */
export function maskStoredSecrets(
	text: string,
	secrets: readonly string[],
	marker: string,
	maskPartialSuffix = false,
): string {
	const masks = new Uint8Array(text.length);
	for (const secret of secrets) {
		if (!secret) continue;
		for (let start = text.indexOf(secret); start !== -1; start = text.indexOf(secret, start + 1))
			masks.fill(1, start, start + secret.length);
		if (!maskPartialSuffix) continue;
		// Match a possibly cut-off suffix in linear time, even for long
		// credentials with repetitive prefixes.
		const prefixes = new Uint32Array(secret.length);
		for (let index = 1, matched = 0; index < secret.length; index++) {
			while (matched && secret[index] !== secret[matched]) matched = prefixes[matched - 1]!;
			if (secret[index] === secret[matched]) matched++;
			prefixes[index] = matched;
		}
		let matched = 0;
		for (let index = Math.max(0, text.length - secret.length + 1); index < text.length; index++) {
			while (matched && text[index] !== secret[matched]) matched = prefixes[matched - 1]!;
			if (text[index] === secret[matched]) matched++;
		}
		if (matched) masks.fill(1, text.length - matched);
	}
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

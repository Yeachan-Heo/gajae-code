import { isRecord, ptree } from "@gajae-code/utils";

export { isRecord };

import { ToolAbortError } from "../../tools/tool-errors";
import { convertBufferWithMarkit } from "../../utils/markit";
import type { AddressResolver } from "../insane/url-guard";
import { validatePublicHttpUrl } from "../insane/url-guard";
import { MAX_BYTES } from "./types";

export function asRecord(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

export function asString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface BinaryFetchSuccess {
	ok: true;
	buffer: Uint8Array;
	contentDisposition?: string;
}

export type BinaryFetchResult = BinaryFetchSuccess | { ok: false; error?: string };

export interface FetchBinaryOptions {
	publicUrlGuard?: boolean;
	resolver?: AddressResolver;
	maxRedirects?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function readResponseWithLimit(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
	const reader = response.body?.getReader();
	if (!reader) return new Uint8Array(0);

	const chunks: Buffer[] = [];
	let totalBytes = 0;

	try {
		while (true) {
			if (signal?.aborted) {
				await reader.cancel();
				throw new ToolAbortError();
			}
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;

			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel();
				throw new Error(`response exceeds ${maxBytes} bytes`);
			}

			chunks.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock();
	}

	return new Uint8Array(Buffer.concat(chunks, totalBytes));
}

async function guardPublicBinaryUrl(
	rawUrl: string,
	resolver: AddressResolver | undefined,
	context: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
	const guard = await validatePublicHttpUrl(rawUrl, { resolver });
	if (guard.ok) return { ok: true, url: guard.url.toString() };
	return { ok: false, error: `${context}: target URL is not public HTTP(S): ${guard.reason}` };
}

/**
 * Fetch binary content from a URL
 */
export async function fetchBinary(
	url: string,
	timeout: number = 20,
	signal?: AbortSignal,
	options: FetchBinaryOptions = {},
): Promise<BinaryFetchResult> {
	const requestSignal = ptree.combineSignals(signal, timeout * 1000);
	const { publicUrlGuard = true, resolver, maxRedirects = 10 } = options;
	try {
		let currentUrl = url;
		if (publicUrlGuard) {
			const guarded = await guardPublicBinaryUrl(url, resolver, "Blocked binary fetch");
			if (!guarded.ok) return { ok: false, error: guarded.error };
			currentUrl = guarded.url;
		}

		for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
			const response = await fetch(currentUrl, {
				signal: requestSignal,
				headers: {
					"User-Agent": "Mozilla/5.0 (compatible; TextBot/1.0)",
				},
				redirect: "manual",
			});

			if (REDIRECT_STATUSES.has(response.status)) {
				const location = response.headers.get("location");
				if (!location) return { ok: false, error: "Redirect response missing Location header" };
				const redirectUrl = new URL(location, currentUrl).toString();
				if (publicUrlGuard) {
					const guarded = await guardPublicBinaryUrl(redirectUrl, resolver, "Blocked binary redirect");
					if (!guarded.ok) return { ok: false, error: guarded.error };
					currentUrl = guarded.url;
				} else {
					currentUrl = redirectUrl;
				}
				continue;
			}

			if (!response.ok) {
				return { ok: false, error: `HTTP ${response.status}` };
			}

			const contentDisposition = response.headers.get("content-disposition") || undefined;
			const contentLength = response.headers.get("content-length");
			if (contentLength) {
				const size = Number.parseInt(contentLength, 10);
				if (Number.isFinite(size) && size > MAX_BYTES) {
					return { ok: false, error: `content-length ${size} exceeds ${MAX_BYTES}` };
				}
			}
			const buffer = await readResponseWithLimit(response, MAX_BYTES, requestSignal);
			return { ok: true, buffer, contentDisposition };
		}

		return { ok: false, error: `Too many redirects (${maxRedirects})` };
	} catch (err) {
		if (signal?.aborted) throw new ToolAbortError();
		if (requestSignal?.aborted) return { ok: false, error: "aborted" };
		return { ok: false, error: err instanceof Error ? err.message : "Failed to fetch binary" };
	}
}

/**
 * Convert binary content to markdown using markit.
 */
export async function convertWithMarkit(
	buffer: Uint8Array,
	extension: string,
	timeout: number = 20,
	signal?: AbortSignal,
): Promise<{ content: string; ok: boolean; error?: string }> {
	const conversionSignal = ptree.combineSignals(signal, timeout * 1000);
	return convertBufferWithMarkit(buffer, extension, conversionSignal);
}

import type { AuthStorage } from "@gajae-code/ai/core";
import { withHardTimeout } from "./search/providers/utils";

const KAGI_SEARCH_URL = "https://kagi.com/api/v0/search";

interface KagiSearchResultObject {
	t: 0;
	url: string;
	title: string;
	snippet?: string;
	published?: string;
}

interface KagiRelatedSearchesObject {
	t: 1;
	list: string[];
}

type KagiSearchObject = KagiSearchResultObject | KagiRelatedSearchesObject;

interface KagiErrorEntry {
	code?: number;
	msg?: string;
}

interface KagiSearchResponse {
	meta: {
		id: string;
	};
	data: KagiSearchObject[];
	error?: KagiErrorEntry[];
}

interface KagiErrorResponse {
	error?: string | KagiErrorEntry[];
	message?: string;
	detail?: string;
}

export class KagiApiError extends Error {
	readonly statusCode?: number;

	constructor(message: string, statusCode?: number) {
		super(message);
		this.name = "KagiApiError";
		this.statusCode = statusCode;
	}
}

function extractKagiErrorMessage(payload: unknown): string | null {
	if (!payload || typeof payload !== "object") return null;
	const record = payload as Record<string, unknown>;

	for (const value of [record.message, record.detail]) {
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}

	if (typeof record.error === "string" && record.error.trim().length > 0) {
		return record.error.trim();
	}

	if (Array.isArray(record.error)) {
		for (const entry of record.error) {
			if (!entry || typeof entry !== "object") continue;
			const message = (entry as Record<string, unknown>).msg;
			if (typeof message === "string" && message.trim().length > 0) {
				return message.trim();
			}
		}
	}

	return null;
}

function createKagiApiError(statusCode: number, detail?: string): KagiApiError {
	return new KagiApiError(
		detail ? `Kagi API error (${statusCode}): ${detail}` : `Kagi API error (${statusCode})`,
		statusCode,
	);
}

function parseKagiErrorResponse(statusCode: number, responseText: string): KagiApiError {
	const trimmedResponseText = responseText.trim();
	if (trimmedResponseText.length === 0) {
		return createKagiApiError(statusCode);
	}

	try {
		const payload = JSON.parse(trimmedResponseText) as KagiErrorResponse;
		return createKagiApiError(statusCode, extractKagiErrorMessage(payload) ?? trimmedResponseText);
	} catch {
		return createKagiApiError(statusCode, trimmedResponseText);
	}
}

export interface KagiSearchOptions {
	limit?: number;
	sessionId?: string;
	signal?: AbortSignal;
}

export interface KagiSearchSource {
	title: string;
	url: string;
	snippet?: string;
	publishedDate?: string;
}

export interface KagiSearchResult {
	requestId: string;
	sources: KagiSearchSource[];
	relatedQuestions: string[];
}

export async function findKagiApiKey(
	authStorage: AuthStorage,
	sessionId?: string,
	signal?: AbortSignal,
): Promise<string | null> {
	return (await authStorage.getApiKey("kagi", sessionId, { signal })) ?? null;
}

function getAuthHeaders(apiKey: string): Record<string, string> {
	return {
		Authorization: `Bot ${apiKey}`,
		Accept: "application/json",
	};
}

export async function searchWithKagi(
	query: string,
	options: KagiSearchOptions = {},
	authStorage: AuthStorage,
): Promise<KagiSearchResult> {
	const apiKey = await findKagiApiKey(authStorage, options.sessionId, options.signal);
	if (!apiKey) {
		throw new KagiApiError("Kagi credentials not found. Set KAGI_API_KEY or login with 'gjc /login kagi'.");
	}

	const requestUrl = new URL(KAGI_SEARCH_URL);
	requestUrl.searchParams.set("q", query);
	if (options.limit !== undefined) {
		requestUrl.searchParams.set("limit", String(options.limit));
	}

	const response = await fetch(requestUrl, {
		headers: getAuthHeaders(apiKey),
		signal: withHardTimeout(options.signal, "api"),
	});
	if (!response.ok) {
		throw parseKagiErrorResponse(response.status, await response.text());
	}

	const payload = (await response.json()) as KagiSearchResponse;
	if (payload.error && payload.error.length > 0) {
		const firstError = payload.error[0];
		throw createKagiApiError(firstError.code ?? response.status, extractKagiErrorMessage(payload) ?? undefined);
	}

	const sources: KagiSearchSource[] = [];
	const relatedQuestions: string[] = [];

	for (const item of payload.data) {
		if (item.t === 0) {
			sources.push({
				title: item.title,
				url: item.url,
				snippet: item.snippet,
				publishedDate: item.published ?? undefined,
			});
		} else if (item.t === 1) {
			relatedQuestions.push(...item.list);
		}
	}

	return {
		requestId: payload.meta.id,
		sources,
		relatedQuestions,
	};
}

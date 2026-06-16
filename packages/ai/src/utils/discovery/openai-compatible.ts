import { UNK_CONTEXT_WINDOW, UNK_MAX_TOKENS } from "@gajae-code/ai";
import * as z from "zod/v4";
import type { Api, FetchImpl, Model, Provider } from "../../types";

const MODELS_PATH = "/models";

/**
 * Minimal OpenAI-style model entry shape consumed by discovery.
 *
 * Providers may return additional fields; this type only captures
 * fields that are useful for generic normalization.
 */
export interface OpenAICompatibleModelRecord {
	id?: unknown;
	name?: unknown;
	object?: unknown;
	owned_by?: unknown;
	[key: string]: unknown;
}

/**
 * Tolerant envelope for OpenAI-compatible `/models` responses.
 *
 * Common providers return `{ data: [...] }`, but variants such as
 * `{ models: [...] }`, `{ result: [...] }`, or direct arrays are also
 * accepted during extraction.
 */
export interface OpenAICompatibleModelsEnvelope {
	data?: unknown;
	models?: unknown;
	result?: unknown;
	items?: unknown;
	[key: string]: unknown;
}

const openAICompatibleModelRecordSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().optional().nullable(),
		object: z.unknown().optional(),
		owned_by: z.unknown().optional(),
	})
	.loose();

const openAICompatibleModelsEnvelopeSchema = z
	.object({
		data: z.unknown().optional(),
		models: z.unknown().optional(),
		result: z.unknown().optional(),
		items: z.unknown().optional(),
	})
	.loose();

const openAICompatibleModelsPayloadSchema = z.union([z.array(z.unknown()), openAICompatibleModelsEnvelopeSchema]);

type ParsedOpenAICompatibleModelRecord = z.infer<typeof openAICompatibleModelRecordSchema>;

/**
 * Context passed to custom OpenAI-compatible model mappers.
 */
export interface OpenAICompatibleModelMapperContext<TApi extends Api> {
	api: TApi;
	provider: Provider;
	baseUrl: string;
}

/**
 * Options for fetching and normalizing OpenAI-compatible `/models` catalogs.
 */
export interface FetchOpenAICompatibleModelsOptions<TApi extends Api> {
	/** API type assigned to normalized models. */
	api: TApi;
	/** Provider id assigned to normalized models. */
	provider: Provider;
	/** Provider base URL used for both fetch and normalized model records. */
	baseUrl: string;
	/** Optional bearer token for Authorization header. */
	apiKey?: string;
	/** Additional request headers. */
	headers?: Record<string, string>;
	/** Optional AbortSignal for request cancellation. */
	signal?: AbortSignal;
	/** Optional fetch implementation override for testing/custom runtimes. */
	fetch?: FetchImpl;
	/** Optional HTTP status predicate for provider-specific hard failures. */
	throwOnStatus?: (response: Response) => Error | undefined;
	/**
	 * Optional post-normalization filter.
	 * Return false to skip a model.
	 */
	filterModel?: (entry: OpenAICompatibleModelRecord, model: Model<TApi>) => boolean;
	/**
	 * Optional mapper override for provider-specific quirks.
	 * Return null to skip a model.
	 */
	mapModel?: (
		entry: OpenAICompatibleModelRecord,
		defaults: Model<TApi>,
		context: OpenAICompatibleModelMapperContext<TApi>,
	) => Model<TApi> | null;
}

/**
 * Fetches and normalizes an OpenAI-compatible `/models` catalog.
 *
 * Returns `null` on transport/protocol failures.
 * Returns `[]` only when the endpoint responds successfully with no usable models.
 */
export async function fetchOpenAICompatibleModels<TApi extends Api>(
	options: FetchOpenAICompatibleModelsOptions<TApi>,
): Promise<Model<TApi>[] | null> {
	const baseUrl = normalizeBaseUrl(options.baseUrl);
	if (!baseUrl) {
		return null;
	}

	const requestHeaders: Record<string, string> = {
		Accept: "application/json",
		...options.headers,
	};
	if (options.apiKey) {
		requestHeaders.Authorization = `Bearer ${options.apiKey}`;
	}

	const fetchImpl = options.fetch ?? globalThis.fetch;
	let response: Response;
	try {
		response = await fetchImpl(`${baseUrl}${MODELS_PATH}`, {
			method: "GET",
			headers: requestHeaders,
			signal: options.signal,
		});
	} catch {
		return null;
	}

	if (!response.ok) {
		const hardFailure = options.throwOnStatus?.(response);
		if (hardFailure) {
			throw hardFailure;
		}
		return null;
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return null;
	}

	const entries = extractModelEntries(payload);
	if (entries === null) {
		return null;
	}

	const context: OpenAICompatibleModelMapperContext<TApi> = {
		api: options.api,
		provider: options.provider,
		baseUrl,
	};

	const deduped = new Map<string, Model<TApi>>();
	for (const entry of entries) {
		const defaults: Model<TApi> = {
			id: entry.id,
			name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id,
			api: options.api,
			provider: options.provider,
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: UNK_CONTEXT_WINDOW,
			maxTokens: UNK_MAX_TOKENS,
		};

		const mapped = options.mapModel?.(entry, defaults, context) ?? defaults;
		if (!mapped || typeof mapped.id !== "string" || mapped.id.length === 0) {
			continue;
		}
		if (options.filterModel && !options.filterModel(entry, mapped)) {
			continue;
		}
		deduped.set(mapped.id, mapped);
	}

	return Array.from(deduped.values()).sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	if (!trimmed) {
		return "";
	}
	return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function extractModelEntries(payload: unknown): ParsedOpenAICompatibleModelRecord[] | null {
	return extractModelEntriesFromNode(payload);
}

function extractModelEntriesFromNode(node: unknown): ParsedOpenAICompatibleModelRecord[] | null {
	const parsedPayload = openAICompatibleModelsPayloadSchema.safeParse(node);
	if (!parsedPayload.success) {
		return null;
	}
	if (Array.isArray(parsedPayload.data)) {
		const parsedEntries = parsedPayload.data
			.map(entry => openAICompatibleModelRecordSchema.safeParse(entry))
			.flatMap(entry => (entry.success ? [entry.data] : []));
		return parsedEntries;
	}
	for (const candidate of [
		parsedPayload.data.data,
		parsedPayload.data.models,
		parsedPayload.data.result,
		parsedPayload.data.items,
	]) {
		if (candidate === undefined) {
			continue;
		}
		const nested = extractModelEntriesFromNode(candidate);
		if (nested !== null) {
			return nested;
		}
	}

	return null;
}

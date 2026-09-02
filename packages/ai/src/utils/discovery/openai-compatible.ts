import * as net from "node:net";
import { UNK_CONTEXT_WINDOW, UNK_MAX_TOKENS } from "@gajae-code/ai";
import * as z from "zod/v4";
import type { Api, FetchImpl, Model, Provider } from "../../types";
import { toNumber } from "../../utils";

const MODELS_PATH = "/models";
const MAX_MODELS_RESPONSE_BYTES = 1_000_000;
const MAX_CATALOG_MODEL_ID_LENGTH = 200;

function parseIpv6Hextets(host: string): number[] | undefined {
	if (net.isIP(host) !== 6) return undefined;
	const doubleColon = host.indexOf("::");
	if (doubleColon !== host.lastIndexOf("::")) return undefined;
	const parseSide = (value: string): number[] | undefined => {
		if (!value) return [];
		const parts = value.split(":");
		if (parts.some(part => !/^[0-9a-f]{1,4}$/i.test(part))) return undefined;
		return parts.map(part => Number.parseInt(part, 16));
	};
	if (doubleColon < 0) {
		const hextets = parseSide(host);
		return hextets?.length === 8 ? hextets : undefined;
	}
	const left = parseSide(host.slice(0, doubleColon));
	const right = parseSide(host.slice(doubleColon + 2));
	if (!left || !right) return undefined;
	const missing = 8 - left.length - right.length;
	if (missing < 1) return undefined;
	return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function isLoopbackHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "localhost") return true;
	if (net.isIP(host) === 4) return host.split(".", 1)[0] === "127";
	const hextets = parseIpv6Hextets(host);
	if (!hextets) return false;
	const isIpv6Loopback = hextets.slice(0, 7).every(part => part === 0) && hextets[7] === 1;
	const isIpv4MappedLoopback =
		hextets.slice(0, 5).every(part => part === 0) && hextets[5] === 0xffff && hextets[6]! >> 8 === 0x7f;
	return isIpv6Loopback || isIpv4MappedLoopback;
}

/** Catalog identities are rendered and used for routing; unsafe values are dropped, never rewritten. */
export function isSafeCatalogModelId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value.length <= MAX_CATALOG_MODEL_ID_LENGTH &&
		!/[\u0000-\u001f\u007f-\u009f]/u.test(value)
	);
}

/**
 * The two wire families a mixed OpenAI-compatible gateway (e.g. CLIProxyAPI)
 * can front. A gateway exposes an OpenAI-shaped `/v1/models` catalog but may
 * proxy Anthropic models that must be driven through the Anthropic Messages
 * transport rather than OpenAI Chat Completions.
 */
export type DiscoveredApiFamily = "anthropic-messages" | "openai-completions";

const ANTHROPIC_OWNER_PATTERN = /\banthropic\b/i;
const OPENAI_OWNER_PATTERN = /\b(openai|open-ai)\b/i;
// Anthropic model ids are consistently `claude-*` across every gateway; the
// `owned_by` owner string is the primary signal and the id is the fallback.
const ANTHROPIC_MODEL_ID_PATTERN = /(^|[/:])claude[-.]/i;
const OPENAI_MODEL_ID_PATTERN = /(^|[/:])(gpt[-.]?|o[1-9]|codex|text-|chatgpt|davinci|dall-e|gpt-image|whisper|tts-)/i;

/**
 * Infer the wire API family for one discovered model on a mixed
 * OpenAI-compatible gateway.
 *
 * Uses the `owned_by` owner string first (authoritative when the gateway
 * populates it — `"anthropic"` / `"openai"`), then falls back to the model id
 * (`claude-*` → Anthropic, `gpt-*`/`o1`/`codex`/… → OpenAI). Returns
 * `undefined` when neither signal is conclusive so the caller can keep the
 * provider-level default instead of guessing.
 */
export function detectDiscoveredApiFamily(entry: {
	id?: unknown;
	owned_by?: unknown;
}): DiscoveredApiFamily | undefined {
	const owner = typeof entry.owned_by === "string" ? entry.owned_by : "";
	if (ANTHROPIC_OWNER_PATTERN.test(owner)) return "anthropic-messages";
	if (OPENAI_OWNER_PATTERN.test(owner)) return "openai-completions";
	const id = typeof entry.id === "string" ? entry.id : "";
	if (ANTHROPIC_MODEL_ID_PATTERN.test(id)) return "anthropic-messages";
	if (OPENAI_MODEL_ID_PATTERN.test(id)) return "openai-completions";
	return undefined;
}

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
 * Resolves an endpoint for an implicit local provider without allowing an
 * environment override to turn its keyless discovery into a remote request.
 */
export function resolveLoopbackOpenAIBaseUrl(value: string | undefined, fallback: string): string {
	const candidate = value?.trim();
	if (!candidate) return fallback;
	try {
		const parsed = new URL(candidate);
		if ((parsed.protocol === "http:" || parsed.protocol === "https:") && isLoopbackHost(parsed.hostname)) {
			return candidate;
		}
	} catch {
		// Fall back to the fixed loopback endpoint below.
	}
	return fallback;
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
		response = await fetchImpl(buildModelsUrl(baseUrl), {
			method: "GET",
			headers: requestHeaders,
			signal: options.signal
				? AbortSignal.any([options.signal, AbortSignal.timeout(5_000)])
				: AbortSignal.timeout(5_000),
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
		payload = JSON.parse(await readModelsResponse(response));
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
		if (!isSafeCatalogModelId(entry.id)) {
			continue;
		}
		const rawContextWindow = firstPositiveModelNumber(
			UNK_CONTEXT_WINDOW,
			entry.max_model_len,
			entry.context_length,
			entry.context_window,
			entry.max_context_length,
			entry.max_position_embeddings,
		);

		const rawMaxTokens = firstPositiveModelNumber(UNK_MAX_TOKENS, entry.max_tokens, entry.max_output_tokens);

		const defaults: Model<TApi> = {
			id: entry.id,
			name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id,
			api: options.api,
			provider: options.provider,
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: rawContextWindow,
			maxTokens: rawMaxTokens,
		};

		const mapped = options.mapModel?.(entry, defaults, context) ?? defaults;
		if (!mapped || !isSafeCatalogModelId(mapped.id)) {
			continue;
		}
		if (options.filterModel && !options.filterModel(entry, mapped)) {
			continue;
		}
		deduped.set(mapped.id, mapped);
	}

	return Array.from(deduped.values()).sort((left, right) => left.id.localeCompare(right.id));
}

async function readModelsResponse(response: Response): Promise<string> {
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > MAX_MODELS_RESPONSE_BYTES) {
		throw new Error("OpenAI-compatible models response exceeds the size limit");
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > MAX_MODELS_RESPONSE_BYTES) {
				await reader.cancel();
				throw new Error("OpenAI-compatible models response exceeds the size limit");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(body);
}

function normalizeBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	if (!trimmed) {
		return "";
	}
	try {
		const parsed = new URL(trimmed);
		parsed.pathname = parsed.pathname.replace(/\/+$/g, "");
		return parsed.toString();
	} catch {
		return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
	}
}

function buildModelsUrl(baseUrl: string): string {
	try {
		const parsed = new URL(baseUrl);
		parsed.pathname = `${parsed.pathname.replace(/\/+$/g, "")}${MODELS_PATH}`;
		return parsed.toString();
	} catch {
		return `${baseUrl}${MODELS_PATH}`;
	}
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

/**
 * First positive safe integer among candidates, else the fallback.
 *
 * Rejects non-numbers, non-finite values (JSON `1e400` parses to `Infinity`),
 * fractions, values outside the safe integer range, zero, and negatives so a
 * malformed catalog field can never poison compaction thresholds or output
 * budgets.
 */
function firstPositiveModelNumber(fallback: number, ...candidates: readonly unknown[]): number {
	for (const candidate of candidates) {
		const value = toNumber(candidate);
		if (value !== undefined && Number.isSafeInteger(value) && value > 0) {
			return value;
		}
	}
	return fallback;
}

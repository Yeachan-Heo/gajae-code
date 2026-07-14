import { $env } from "@gajae-code/utils";
import type { ResponseInput } from "openai/resources/responses/responses";
import type { CacheRetention, OpenAIResponsesHistoryPayload, ProviderPayload } from "./types";

type OpenAIResponsesReplayItem = ResponseInput[number];

export { isRecord } from "@gajae-code/utils";
export function normalizeSystemPrompts(systemPrompt: readonly string[] | string | undefined | null): string[] {
	if (systemPrompt === undefined || systemPrompt === null) return [];
	const prompts = Array.isArray(systemPrompt) ? systemPrompt : typeof systemPrompt === "string" ? [systemPrompt] : [];
	return prompts.map(prompt => prompt.toWellFormed()).filter(prompt => prompt.length > 0);
}

export function sanitizeJsonStrings(value: unknown): unknown {
	return sanitizeJsonStringsInner(value, new WeakMap<object, unknown>());
}

function sanitizeJsonStringsInner(value: unknown, seen: WeakMap<object, unknown>): unknown {
	if (typeof value === "string") return value.toWellFormed();
	if (!value || typeof value !== "object") return value;

	const cached = seen.get(value);
	if (cached !== undefined) return cached;

	if (Array.isArray(value)) {
		const sanitized: unknown[] = [];
		seen.set(value, sanitized);
		for (const item of value) {
			sanitized.push(sanitizeJsonStringsInner(item, seen));
		}
		return sanitized;
	}

	const sanitized: Record<string, unknown> = {};
	seen.set(value, sanitized);
	for (const [key, nestedValue] of Object.entries(value)) {
		sanitized[key.toWellFormed()] = sanitizeJsonStringsInner(nestedValue, seen);
	}
	return sanitized;
}

export function toNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

export function toPositiveNumber(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return fallback;
	}
	return value;
}

export function toBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

export function normalizeToolCallId(id: string): string {
	const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	return sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
}

type ResponsesToolItemIdPrefix = "fc" | "ctc";

export function normalizeResponsesToolCallId(
	id: string,
	itemPrefix: ResponsesToolItemIdPrefix = "fc",
): { callId: string; itemId: string } {
	const [callId, itemId] = id.split("|");
	if (callId && itemId) {
		const normalizedCallId = truncateResponseItemId(callId, getIdPrefix(callId, "call"));
		const normalizedItemId = normalizeResponsesItemId(itemId, itemPrefix);
		return { callId: normalizedCallId, itemId: normalizedItemId };
	}
	const hash = Bun.hash(id).toString(36);
	const normalizedCallId = id.startsWith("call_") ? truncateResponseItemId(id, "call") : `call_${hash}`;
	return { callId: normalizedCallId, itemId: `${itemPrefix}_${hash}` };
}

function getIdPrefix(id: string, fallback: string): string {
	const prefix = id.match(/^([a-zA-Z][a-zA-Z0-9]*)_/)?.[1];
	return prefix || fallback;
}

function getExplicitIdPrefix(id: string): string | undefined {
	return id.match(/^([a-zA-Z][a-zA-Z0-9]*)_/)?.[1];
}

function normalizeResponsesItemId(itemId: string, fallbackPrefix: ResponsesToolItemIdPrefix): string {
	const prefix = getExplicitIdPrefix(itemId);
	const isAllowedPrefix = prefix
		? fallbackPrefix === "ctc"
			? prefix === "ctc"
			: prefix === "fc" || prefix === "fcr"
		: false;
	if (!prefix || !isAllowedPrefix) {
		return `${fallbackPrefix}_${Bun.hash(itemId).toString(36)}`;
	}
	return truncateResponseItemId(itemId, prefix);
}

/**
 * Truncate an OpenAI Responses API item ID to 64 characters.
 * IDs exceeding the limit are replaced with a hash-based ID using the given prefix.
 */
export function truncateResponseItemId(id: string, prefix: string): string {
	if (id.length <= 64) return id;
	return `${prefix}_${Bun.hash(id).toString(36)}`;
}

export function sanitizeOpenAIResponsesHistoryItemsForReplay(items: Array<Record<string, unknown>>): ResponseInput {
	const normalizedCallIds = new Map<string, string>();
	return items.flatMap(item => {
		const sanitized = sanitizeOpenAIResponsesHistoryItemForReplay(item, normalizedCallIds);
		return sanitized ? [sanitized] : [];
	});
}
const RESERVED_CONTROL_TOKEN_RE = /<\|(?=[A-Za-z0-9_]{1,32}\|>)/g;
/**
 * Neutralize leaked OpenAI Harmony / control tokens (`<|channel|>`, `<|message|>`,
 * `<|call|>`, `<|constrain|>`, `<|recipient|>`, `<|content|>`, ...) in replayed
 * history text. A subagent whose tool-call channel degenerates can dump raw
 * control-token scaffolding into its reply text; once that poisoned text lands in
 * history the Codex / Responses endpoint rejects every subsequent request with
 * `Request blocked (code=invalid_prompt)`, permanently wedging the session because
 * the offending item is re-sent on each turn. Insert a zero-width space after `<`
 * so the delimiter can no longer be tokenized as a reserved control token while the
 * text stays human-readable.
 */
export function neutralizeReservedControlTokens(text: string): string {
	if (!text.includes("<|")) return text;
	return text.replace(RESERVED_CONTROL_TOKEN_RE, "<\u200b|");
}

/**
 * Neutralize leaked reserved control tokens across every string in an outgoing
 * Responses `input` array. This is the request-boundary complement to the
 * replay-history sanitizer: leaked Harmony markers (`<|channel|>analysis`, ...)
 * can enter the payload from assistant reasoning summaries, live-converted
 * message/tool-output text, or user-authored content — not just replayed
 * history — and every gpt-5.6 request that carries one is rejected with
 * `Request blocked (code=invalid_prompt)`. Walking every string (rather than an
 * item-type allowlist) guarantees no leak source is missed as item shapes
 * evolve; the zero-width-space insertion is idempotent (`<\u200b|` no longer
 * matches `<|`) and keeps the text human-readable.
 */
export function neutralizeResponsesInputControlTokens<T>(items: readonly T[]): T[] {
	return items.map(item => deepNeutralizeReservedControlTokens(item) as T);
}

function deepNeutralizeReservedControlTokens(value: unknown): unknown {
	if (typeof value === "string") return neutralizeReservedControlTokens(value);
	if (Array.isArray(value)) return value.map(deepNeutralizeReservedControlTokens);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(value)) {
			out[key] = deepNeutralizeReservedControlTokens(nested);
		}
		return out;
	}
	return value;
}

function stringifyResponsesStringParamForReplay(value: unknown): string {
	if (typeof value === "string") return neutralizeReservedControlTokens(value.toWellFormed());
	try {
		const encoded = JSON.stringify(value);
		if (typeof encoded === "string") return neutralizeReservedControlTokens(encoded.toWellFormed());
	} catch {
		// Fall through to String().
	}
	return neutralizeReservedControlTokens(String(value ?? "").toWellFormed());
}

function normalizeResponsesMessageTextForReplay(value: unknown): string {
	if (typeof value === "string") return neutralizeReservedControlTokens(value.toWellFormed());
	if (value && typeof value === "object") {
		const nestedText = (value as { text?: unknown }).text;
		if (typeof nestedText === "string") return neutralizeReservedControlTokens(nestedText.toWellFormed());
	}
	return stringifyResponsesStringParamForReplay(value);
}

type ResponsesImageDetail = "auto" | "low" | "high";

interface NormalizedResponsesImageUrl {
	readonly imageUrl: string;
	readonly detail?: ResponsesImageDetail;
}

function isResponsesImageDetail(value: unknown): value is ResponsesImageDetail {
	return value === "auto" || value === "low" || value === "high";
}

function normalizeResponsesImageUrlForReplay(value: unknown): NormalizedResponsesImageUrl {
	if (typeof value === "string") return { imageUrl: value.toWellFormed() };
	if (value && typeof value === "object" && "url" in value && typeof value.url === "string") {
		const detail = "detail" in value && isResponsesImageDetail(value.detail) ? value.detail : undefined;
		return {
			imageUrl: value.url.toWellFormed(),
			...(detail ? { detail } : {}),
		};
	}
	return { imageUrl: stringifyResponsesStringParamForReplay(value) };
}

function sanitizeResponsesMessageContentForReplay(content: unknown): unknown {
	if (typeof content === "string") return neutralizeReservedControlTokens(content.toWellFormed());
	if (!Array.isArray(content)) return content;
	return content.map(part => {
		if (!part || typeof part !== "object") return part;
		const sanitizedPart = { ...(part as Record<string, unknown>) };
		if ("text" in sanitizedPart) {
			sanitizedPart.text = normalizeResponsesMessageTextForReplay(sanitizedPart.text);
		}
		if ("image_url" in sanitizedPart) {
			const normalizedImageUrl = normalizeResponsesImageUrlForReplay(sanitizedPart.image_url);
			sanitizedPart.image_url = normalizedImageUrl.imageUrl;
			if (sanitizedPart.type === "image_url") {
				sanitizedPart.type = "input_image";
			}
			if (normalizedImageUrl.detail) {
				sanitizedPart.detail = normalizedImageUrl.detail;
			} else if ("detail" in sanitizedPart && !isResponsesImageDetail(sanitizedPart.detail)) {
				delete sanitizedPart.detail;
			}
		}
		return sanitizedPart;
	});
}

function sanitizeResponsesStringFieldsForReplay(item: Record<string, unknown>): void {
	if (item.type === "message") {
		item.content = sanitizeResponsesMessageContentForReplay(item.content);
	}
	if (item.type === "function_call" && "arguments" in item && typeof item.arguments !== "string") {
		item.arguments = stringifyResponsesStringParamForReplay(item.arguments);
	}
	if (item.type === "custom_tool_call" && "input" in item && typeof item.input !== "string") {
		item.input = stringifyResponsesStringParamForReplay(item.input);
	}
	if ((item.type === "function_call_output" || item.type === "custom_tool_call_output") && "output" in item) {
		item.output =
			typeof item.output === "string"
				? neutralizeReservedControlTokens(item.output.toWellFormed())
				: stringifyResponsesStringParamForReplay(item.output);
	}
}

function sanitizeOpenAIResponsesHistoryItemForReplay(
	item: Record<string, unknown>,
	normalizedCallIds: Map<string, string>,
): OpenAIResponsesReplayItem | undefined {
	if (item.type === "item_reference") return undefined;

	// providerPayload stores raw output items; replay strips fields that are output-only.
	const { id: _id, ...itemWithoutId } = item;
	const sanitizedItem =
		item.type === "computer_call"
			? sanitizeComputerCallForResponsesInput(itemWithoutId)
			: item.type === "image_generation_call"
				? sanitizeImageGenerationCallForResponsesInput(itemWithoutId)
				: itemWithoutId;
	if (typeof item.call_id === "string") {
		sanitizedItem.call_id = normalizeReplayedResponsesHistoryCallId(item.call_id, normalizedCallIds);
	}
	sanitizeResponsesStringFieldsForReplay(sanitizedItem);

	return sanitizedItem as unknown as OpenAIResponsesReplayItem;
}

function sanitizeComputerCallForResponsesInput(item: Record<string, unknown>): Record<string, unknown> {
	// The Responses stream includes the performed computer action on output items,
	// but the create input accepts only the call identity/status fields on replay.
	const { action: _action, actions: _actions, ...inputSafeItem } = item;
	return inputSafeItem;
}

function sanitizeImageGenerationCallForResponsesInput(item: Record<string, unknown>): Record<string, unknown> {
	// Image generation output items include request-time knobs that are not part of
	// the Responses input replay schema. Replaying them verbatim makes OpenAI-compatible
	// endpoints reject the next turn, e.g. `Unknown parameter: input[n].action`.
	const {
		action: _action,
		background: _background,
		output_format: _outputFormat,
		quality: _quality,
		revised_prompt: _revisedPrompt,
		size: _size,
		...inputSafeItem
	} = item;
	return inputSafeItem;
}

function normalizeReplayedResponsesHistoryCallId(value: string, normalizedValues: Map<string, string>): string {
	const normalized = normalizedValues.get(value);
	if (normalized) return normalized;
	const next = truncateResponseItemId(value, getIdPrefix(value, "call"));
	normalizedValues.set(value, next);
	return next;
}

export function createOpenAIResponsesHistoryPayload(
	provider: string,
	items: Array<Record<string, unknown>>,
	incremental = true,
): OpenAIResponsesHistoryPayload {
	return {
		type: "openaiResponsesHistory",
		provider,
		...(incremental ? { dt: true } : {}),
		items,
	};
}

export function getOpenAIResponsesHistoryPayload(
	providerPayload: ProviderPayload | undefined,
	currentProvider: string,
	fallbackProvider?: string,
): OpenAIResponsesHistoryPayload | undefined {
	if (providerPayload?.type !== "openaiResponsesHistory" || !Array.isArray(providerPayload.items)) {
		return undefined;
	}
	const payloadProvider = providerPayload.provider ?? fallbackProvider;
	if (!payloadProvider || payloadProvider !== currentProvider) {
		return undefined;
	}
	return { ...providerPayload, provider: payloadProvider };
}

export function getOpenAIResponsesHistoryItems(
	providerPayload: ProviderPayload | undefined,
	currentProvider: string,
	fallbackProvider?: string,
): Array<Record<string, unknown>> | undefined {
	return getOpenAIResponsesHistoryPayload(providerPayload, currentProvider, fallbackProvider)?.items;
}

/**
 * Resolve cache retention preference.
 *
 * Resolution order: explicit request value → `GJC_CACHE_RETENTION` →
 * legacy `PI_CACHE_RETENTION` → `fallback`. Both env vars act as explicit
 * opt-in (`"long"`) or opt-out (any other value) so a provider-specific
 * `fallback` only applies when nothing else is configured. `fallback`
 * defaults to `"short"` to preserve the historical behaviour for callers
 * that don't pass one.
 */
export function resolveCacheRetention(
	cacheRetention?: CacheRetention,
	fallback: CacheRetention = "short",
): CacheRetention {
	if (cacheRetention) return cacheRetention;
	if ($env.GJC_CACHE_RETENTION === "long") return "long";
	if ($env.GJC_CACHE_RETENTION !== undefined) return "short";
	if ($env.PI_CACHE_RETENTION === "long") return "long";
	if ($env.PI_CACHE_RETENTION !== undefined) return "short";
	return fallback;
}

export function isAnthropicOAuthToken(key: string): boolean {
	return key.includes("sk-ant-oat");
}

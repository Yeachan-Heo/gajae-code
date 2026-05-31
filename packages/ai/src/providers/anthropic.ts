import * as nodeCrypto from "node:crypto";
import * as fs from "node:fs";
import { scheduler } from "node:timers/promises";
import * as tls from "node:tls";
import Anthropic, { type ClientOptions as AnthropicSdkClientOptions } from "@anthropic-ai/sdk";
import type {
	ContentBlockParam,
	MessageCreateParamsStreaming,
	MessageParam,
	RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages";
import {
	$env,
	extractHttpStatusFromError,
	isEnoent,
	isRetryableError,
	isUnexpectedSocketCloseMessage,
	logger,
	readSseEvents,
} from "@gajae-code/utils";
import { hasOpus47ApiRestrictions, mapEffortToAnthropicAdaptiveEffort } from "../model-thinking";
import { calculateCost } from "../models";
import { getEnvApiKey, OUTPUT_FALLBACK_BUFFER } from "../stream";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	FetchImpl,
	ImageContent,
	Message,
	Model,
	ProviderSessionState,
	RedactedThinkingContent,
	ServiceTier,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "../types";
import { resolveServiceTier } from "../types";
import {
	isAnthropicOAuthToken,
	isRecord,
	normalizeSystemPrompts,
	normalizeToolCallId,
	resolveCacheRetention,
} from "../utils";
import { createAbortSourceTracker } from "../utils/abort";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { isFoundryEnabled } from "../utils/foundry";
import { finalizeErrorMessage, type RawHttpRequestDump, rewriteCopilotError } from "../utils/http-inspector";
import { getStreamFirstEventTimeoutMs, getStreamIdleTimeoutMs, iterateWithIdleTimeout } from "../utils/idle-iterator";
import { parseJsonWithRepair, parseStreamingJson } from "../utils/json-parse";
import { parseGitHubCopilotApiKey } from "../utils/oauth/github-copilot";
import { notifyProviderResponse } from "../utils/provider-response";
import { isCopilotTransientModelError } from "../utils/retry";
import { COMBINATOR_KEYS, NO_STRICT, toolWireSchema } from "../utils/schema";
import { spillToDescription } from "../utils/schema/spill";
import { notifyRawSseEvent, wrapFetchForSseDebug } from "../utils/sse-debug";
import {
	buildCopilotDynamicHeaders,
	hasCopilotVisionInput,
	resolveGitHubCopilotBaseUrl,
} from "./github-copilot-headers";
import { transformMessages } from "./transform-messages";
import { NON_VISION_IMAGE_PLACEHOLDER } from "./vision-guard";

export type AnthropicHeaderOptions = {
	apiKey: string;
	baseUrl?: string;
	isOAuth?: boolean;
	extraBetas?: string[];
	stream?: boolean;
	modelHeaders?: Record<string, string>;
	isCloudflareAiGateway?: boolean;
};

export function normalizeAnthropicBaseUrl(baseUrl?: string): string | undefined {
	const trimmed = baseUrl?.trim();
	if (!trimmed) {
		return undefined;
	}
	const withoutTrailingSlashes = trimmed.replace(/\/+$/, "");
	return withoutTrailingSlashes.endsWith("/v1") ? withoutTrailingSlashes.slice(0, -3) : withoutTrailingSlashes;
}

// Build deduplicated beta header string
export function buildBetaHeader(baseBetas: string[], extraBetas: string[]): string {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const beta of [...baseBetas, ...extraBetas]) {
		const trimmed = beta.trim();
		if (trimmed && !seen.has(trimmed)) {
			seen.add(trimmed);
			result.push(trimmed);
		}
	}
	return result.join(",");
}

const claudeCodeBetaDefaults = [
	"claude-code-20250219",
	"oauth-2025-04-20",
	"context-management-2025-06-27",
	"prompt-caching-scope-2026-01-05",
];
const fineGrainedToolStreamingBeta = "fine-grained-tool-streaming-2025-05-14";
const interleavedThinkingBeta = "interleaved-thinking-2025-05-14";
const fastModeBeta = "fast-mode-2026-02-01";

function getHeaderCaseInsensitive(headers: Record<string, string> | undefined, headerName: string): string | undefined {
	if (!headers) return undefined;
	const normalizedName = headerName.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === normalizedName) return value;
	}
	return undefined;
}

function isClaudeCodeClientUserAgent(userAgent: string | undefined): userAgent is string {
	if (!userAgent) return false;
	return userAgent.toLowerCase().startsWith("claude-cli");
}

function isAnthropicApiBaseUrl(baseUrl?: string): boolean {
	if (!baseUrl) return true;
	try {
		const url = new URL(baseUrl);
		return url.protocol.toLowerCase() === "https:" && url.hostname.toLowerCase() === "api.anthropic.com";
	} catch {
		return false;
	}
}

const sharedHeaders = {
	"Accept-Encoding": "gzip, deflate, br, zstd",
	Connection: "keep-alive",
	"Content-Type": "application/json",
	"Anthropic-Version": "2023-06-01",
	"Anthropic-Dangerous-Direct-Browser-Access": "true",
	"X-App": "cli",
};

export function buildAnthropicHeaders(options: AnthropicHeaderOptions): Record<string, string> {
	const oauthToken = options.isOAuth ?? isAnthropicOAuthToken(options.apiKey);
	const extraBetas = options.extraBetas ?? [];
	const stream = options.stream ?? false;
	const betaHeader = buildBetaHeader(claudeCodeBetaDefaults, extraBetas);
	const acceptHeader = stream ? "text/event-stream" : "application/json";
	const modelHeaders = Object.fromEntries(
		Object.entries(options.modelHeaders ?? {}).filter(([key]) => !enforcedHeaderKeys.has(key.toLowerCase())),
	);

	if (options.isCloudflareAiGateway) {
		return {
			...modelHeaders,
			Accept: acceptHeader,
			...sharedHeaders,
			"Anthropic-Beta": betaHeader,
			"cf-aig-authorization": `Bearer ${options.apiKey}`,
		};
	}

	if (oauthToken) {
		const incomingUserAgent = getHeaderCaseInsensitive(options.modelHeaders, "User-Agent");
		const userAgent = isClaudeCodeClientUserAgent(incomingUserAgent)
			? incomingUserAgent
			: `claude-cli/${claudeCodeVersion} (external, cli)`;
		return {
			...modelHeaders,
			...claudeCodeHeaders,
			Accept: acceptHeader,
			Authorization: `Bearer ${options.apiKey}`,
			...sharedHeaders,
			"Anthropic-Beta": betaHeader,
			"User-Agent": userAgent,
		};
	} else if (!isAnthropicApiBaseUrl(options.baseUrl)) {
		return {
			...modelHeaders,
			Accept: acceptHeader,
			Authorization: `Bearer ${options.apiKey}`,
			...sharedHeaders,
			"Anthropic-Beta": betaHeader,
		};
	} else {
		return {
			...modelHeaders,
			Accept: acceptHeader,
			...sharedHeaders,
			"Anthropic-Beta": betaHeader,
			"X-Api-Key": options.apiKey,
		};
	}
}

type AnthropicCacheControl = { type: "ephemeral"; ttl?: "1h" | "5m" };

type AnthropicSamplingParams = MessageCreateParamsStreaming & {
	top_p?: number;
	top_k?: number;
};

const ANTHROPIC_STOP_SEQUENCES_MAX = 4;
let warnedStopSequencesTrim = false;

/**
 * Adaptive thinking `display` is supported starting with Anthropic model Opus 4.7.
 * Older adaptive-thinking models (Opus 4.6, Sonnet 4.6+) reject the field.
 */
function supportsAdaptiveThinkingDisplay(modelId: string): boolean {
	const match = /claude-opus-(\d+)-(\d+)/.exec(modelId);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > 4 || (major === 4 && minor >= 7);
}

const ANTHROPIC_PROVIDER_SESSION_STATE_KEY = "anthropic-messages";

type AnthropicProviderSessionState = ProviderSessionState & {
	strictToolsDisabled: boolean;
	fastModeDisabled: boolean;
};

function createAnthropicProviderSessionState(): AnthropicProviderSessionState {
	const state: AnthropicProviderSessionState = {
		strictToolsDisabled: false,
		fastModeDisabled: false,
		close: () => {
			state.strictToolsDisabled = false;
			state.fastModeDisabled = false;
		},
	};
	return state;
}

function getAnthropicProviderSessionState(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): AnthropicProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const existing = providerSessionState.get(ANTHROPIC_PROVIDER_SESSION_STATE_KEY) as
		| AnthropicProviderSessionState
		| undefined;
	if (existing) return existing;
	const created = createAnthropicProviderSessionState();
	providerSessionState.set(ANTHROPIC_PROVIDER_SESSION_STATE_KEY, created);
	return created;
}

/**
 * Clears the in-session "server rejected fast mode" sticky flag. Call when the
 * caller is explicitly re-arming `serviceTier: "priority"` (e.g. user toggled
 * `/fast on` after a previous turn auto-disabled it) so the next request
 * actually carries `speed: "fast"` again. No-op when the map or state entry
 * hasn't been materialized yet.
 */
export function clearAnthropicFastModeFallback(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): void {
	if (!providerSessionState) return;
	const state = providerSessionState.get(ANTHROPIC_PROVIDER_SESSION_STATE_KEY) as
		| AnthropicProviderSessionState
		| undefined;
	if (state) state.fastModeDisabled = false;
}

function isAnthropicStrictGrammarTooLargeError(error: unknown): boolean {
	if (extractHttpStatusFromError(error) !== 400) return false;
	const message = error instanceof Error ? error.message : String(error);
	const isStrictGrammarTooLarge = /compiled grammar/i.test(message) && /too large/i.test(message);
	const isSchemaCompilationTooComplex =
		/schema/i.test(message) && /too complex/i.test(message) && /compil/i.test(message);
	return /invalid_request_error/i.test(message) && (isStrictGrammarTooLarge || isSchemaCompilationTooComplex);
}

export function isAnthropicFastModeUnsupportedError(error: unknown): boolean {
	const status = extractHttpStatusFromError(error);
	if (status !== 400 && status !== 429) return false;
	const message = error instanceof Error ? error.message : String(error);
	// 400 invalid_request_error — model doesn't accept `speed` at all.
	// Observed: "'Anthropic model-opus-4-5-20251101' does not support the `speed` parameter."
	// Stay tolerant of phrasing drift ("is not supported", quoted vs backticked field).
	if (
		status === 400 &&
		/invalid_request_error/i.test(message) &&
		/\bspeed\b/i.test(message) &&
		/not support/i.test(message)
	) {
		return true;
	}
	// 429 rate_limit_error — account lacks the extra-usage entitlement fast mode requires.
	// Observed: "Extra usage is required for fast mode."
	if (status === 429 && /rate_limit_error/i.test(message) && /fast mode/i.test(message)) {
		return true;
	}
	return false;
}

export function isAnthropicThinkingBlockMutationError(error: unknown): boolean {
	if (extractHttpStatusFromError(error) !== 400) return false;
	const message = error instanceof Error ? error.message : String(error);
	return (
		/invalid_request_error/i.test(message) &&
		/thinking|redacted_thinking/i.test(message) &&
		/latest assistant message/i.test(message) &&
		/cannot be modified/i.test(message)
	);
}

function hasStrictAnthropicTools(params: MessageCreateParamsStreaming): boolean {
	const tools = params.tools as Array<{ strict?: unknown }> | undefined;
	return tools?.some(tool => tool.strict === true) ?? false;
}

/**
 * `speed` lives on `BetaMessageCreateParams` (client.beta.messages) but this
 * provider posts via `client.messages.create`, whose param type doesn't
 * include it. This alias narrows the cast to one place.
 */
type ParamsWithSpeed = MessageCreateParamsStreaming & { speed?: "fast" };

function dropAnthropicFastMode(params: MessageCreateParamsStreaming): void {
	delete (params as ParamsWithSpeed).speed;
}

function dropAnthropicStrictTools(params: MessageCreateParamsStreaming): void {
	const tools = params.tools as Array<{ strict?: unknown }> | undefined;
	if (!tools) return;
	for (const tool of tools) {
		delete tool.strict;
	}
}

function getCacheControl(
	model: Model<"anthropic-messages">,
	baseUrl: string,
	cacheRetention?: CacheRetention,
): { retention: CacheRetention; cacheControl?: AnthropicCacheControl } {
	const retention = resolveCacheRetention(cacheRetention);
	if (retention === "none") {
		return { retention };
	}
	const ttl =
		retention === "long" && isAnthropicApiBaseUrl(baseUrl) && getAnthropicCompat(model).supportsLongCacheRetention
			? "1h"
			: undefined;
	return {
		retention,
		cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
	};
}

// Stealth mode: Mimic Anthropic Code headers and tool prefixing.
export const claudeCodeVersion = "2.1.63";
export const claudeToolPrefix: string = "proxy_";
export const claudeCodeSystemInstruction = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

export function mapStainlessOs(platform: string): "MacOS" | "Windows" | "Linux" | "FreeBSD" | `Other::${string}` {
	switch (platform.toLowerCase()) {
		case "darwin":
			return "MacOS";
		case "windows":
		case "win32":
			return "Windows";
		case "linux":
			return "Linux";
		case "freebsd":
			return "FreeBSD";
		default:
			return `Other::${platform.toLowerCase()}`;
	}
}

export function mapStainlessArch(arch: string): "x64" | "arm64" | "x86" | `other::${string}` {
	switch (arch.toLowerCase()) {
		case "amd64":
		case "x64":
			return "x64";
		case "arm64":
		case "aarch64":
			return "arm64";
		case "386":
		case "x86":
		case "ia32":
			return "x86";
		default:
			return `other::${arch.toLowerCase()}`;
	}
}

export const claudeCodeHeaders = {
	"X-Stainless-Retry-Count": "0",
	"X-Stainless-Runtime-Version": "v24.3.0",
	"X-Stainless-Package-Version": "0.74.0",
	"X-Stainless-Runtime": "node",
	"X-Stainless-Lang": "js",
	"X-Stainless-Arch": mapStainlessArch(process.arch),
	"X-Stainless-Os": mapStainlessOs(process.platform),
	"X-Stainless-Timeout": "600",
} as const;

const enforcedHeaderKeys = new Set(
	[
		...Object.keys(claudeCodeHeaders),
		"Accept",
		"Accept-Encoding",
		"Connection",
		"Content-Type",
		"Anthropic-Version",
		"Anthropic-Dangerous-Direct-Browser-Access",
		"Anthropic-Beta",
		"User-Agent",
		"X-App",
		"Authorization",
		"X-Api-Key",
		"cf-aig-authorization",
	].map(key => key.toLowerCase()),
);

const CLAUDE_BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

function createClaudeBillingHeader(payload: unknown): string {
	const payloadJson = JSON.stringify(payload) ?? "";
	const cch = nodeCrypto.createHash("sha256").update(payloadJson).digest("hex").slice(0, 5);
	const randomBytes = new Uint8Array(2);
	crypto.getRandomValues(randomBytes);
	const buildHash = Array.from(randomBytes, byte => byte.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 3);
	return `${CLAUDE_BILLING_HEADER_PREFIX} cc_version=${claudeCodeVersion}.${buildHash}; cc_entrypoint=cli; cch=${cch};`;
}

const CLAUDE_CLOAKING_USER_ID_REGEX =
	/^user_[0-9a-fA-F]{64}_account_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isClaudeCloakingUserId(userId: string): boolean {
	return CLAUDE_CLOAKING_USER_ID_REGEX.test(userId);
}

/**
 * Real Anthropic Code sends `metadata.user_id` as a JSON-stringified object of the
 * shape `{ device_id, account_uuid, session_id, ...extra }` (see
 * services/api/Anthropic model.ts → getAPIMetadata). Accept that shape so callers that
 * supply a stable `session_id` aren't silently overwritten with fresh entropy
 * on every request, which would inflate the backend session count.
 */
function isClaudeJsonUserId(userId: string): boolean {
	if (userId.length === 0 || userId[0] !== "{") return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(userId);
	} catch {
		return false;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
	const obj = parsed as Record<string, unknown>;
	return typeof obj.session_id === "string" && obj.session_id.length > 0;
}

export function generateClaudeCloakingUserId(): string {
	const userHash = nodeCrypto.randomBytes(32).toString("hex");
	const accountId = nodeCrypto.randomUUID().toLowerCase();
	const sessionId = nodeCrypto.randomUUID().toLowerCase();
	return `user_${userHash}_account_${accountId}_session_${sessionId}`;
}

function resolveAnthropicMetadataUserId(userId: unknown, isOAuthToken: boolean): string | undefined {
	if (typeof userId === "string") {
		if (!isOAuthToken || isClaudeCloakingUserId(userId) || isClaudeJsonUserId(userId)) {
			return userId;
		}
	}

	if (!isOAuthToken) return undefined;
	return generateClaudeCloakingUserId();
}
const ANTHROPIC_BUILTIN_TOOL_NAMES = new Set(["web_search", "code_execution", "text_editor", "computer"]);
export const applyClaudeToolPrefix = (name: string, prefixOverride: string = claudeToolPrefix) => {
	if (!prefixOverride) return name;
	if (ANTHROPIC_BUILTIN_TOOL_NAMES.has(name.toLowerCase())) return name;
	const prefix = prefixOverride.toLowerCase();
	if (name.toLowerCase().startsWith(prefix)) return name;
	return `${prefixOverride}${name}`;
};

export const stripClaudeToolPrefix = (name: string, prefixOverride: string = claudeToolPrefix) => {
	if (!prefixOverride) return name;
	const prefix = prefixOverride.toLowerCase();
	if (!name.toLowerCase().startsWith(prefix)) return name;
	return name.slice(prefixOverride.length);
};

/**
 * Convert content blocks to Anthropic API format
 */
function convertContentBlocks(
	content: (TextContent | ImageContent)[],
	supportsImages = true,
):
	| string
	| Array<
			| { type: "text"; text: string }
			| {
					type: "image";
					source: {
						type: "base64";
						media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
						data: string;
					};
			  }
	  > {
	const textBlocks = content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text.toWellFormed())
		.filter(text => text.trim().length > 0);
	const imageBlocks = content.filter((block): block is ImageContent => block.type === "image");
	const omittedImages = !supportsImages && imageBlocks.length > 0;
	if (imageBlocks.length === 0 || !supportsImages) {
		if (omittedImages) {
			textBlocks.push(NON_VISION_IMAGE_PLACEHOLDER);
		}
		return textBlocks.join("\n").toWellFormed();
	}

	const blocks = [
		...textBlocks.map(text => ({
			type: "text" as const,
			text,
		})),
		...imageBlocks.map(block => ({
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
				data: block.data,
			},
		})),
	];

	if (!textBlocks.length) {
		blocks.unshift({
			type: "text" as const,
			text: "(see attached image)",
		});
	}

	return blocks;
}

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type AnthropicThinkingDisplay = "summarized" | "omitted";

export interface AnthropicOptions extends StreamOptions {
	/**
	 * Enable extended thinking.
	 * For Opus 4.6+: uses adaptive thinking (Anthropic model decides when/how much to think).
	 * For older models: uses budget-based thinking with thinkingBudgetTokens.
	 */
	thinkingEnabled?: boolean;
	/**
	 * Token budget for extended thinking (older models only).
	 * Ignored for Opus 4.6+ which uses adaptive thinking.
	 */
	thinkingBudgetTokens?: number;
	/**
	 * Effort level for adaptive thinking (Opus 4.6+ only).
	 * Controls how much thinking Anthropic model allocates:
	 * - "max": Always thinks with no constraints
	 * - "high": Always thinks, deep reasoning (default)
	 * - "medium": Moderate thinking, may skip for simple queries
	 * - "low": Minimal thinking, skips for simple tasks
	 * Ignored for older models.
	 */
	effort?: AnthropicEffort;
	/**
	 * Optional reasoning level fallback for direct Anthropic provider usage.
	 * Converted to adaptive effort when effort is not explicitly provided.
	 */
	reasoning?: SimpleStreamOptions["reasoning"];
	/**
	 * Controls how Anthropic returns thinking content when the selected thinking
	 * transport supports a display option. Defaults to "summarized" where the
	 * API accepts it.
	 */
	thinkingDisplay?: AnthropicThinkingDisplay;
	interleavedThinking?: boolean;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	betas?: string[] | string;
	/**
	 * Realization of `serviceTier: "priority"` on Anthropic models. When
	 * `"priority"`, sets `speed: "fast"` on the request and appends the
	 * `fast-mode-2026-02-01` beta header. Anthropic rejects unsupported models
	 * with `invalid_request_error`, which triggers an in-provider one-shot
	 * fallback (see `fastModeDisabled` provider state).
	 *
	 * Other `ServiceTier` values are currently ignored on this provider.
	 */
	serviceTier?: ServiceTier;
	/** Force OAuth bearer auth mode for proxy tokens that don't match Anthropic token prefixes. */
	isOAuth?: boolean;
	/**
	 * Pre-built Anthropic client instance. When provided, skips internal client
	 * construction entirely. Use this to inject alternative SDK clients such as
	 * `AnthropicVertex` that shares the same messaging API.
	 */
	client?: Anthropic;
}

export type AnthropicClientOptionsArgs = {
	model: Model<"anthropic-messages">;
	apiKey: string;
	extraBetas?: string[];
	stream?: boolean;
	interleavedThinking?: boolean;
	headers?: Record<string, string>;
	dynamicHeaders?: Record<string, string>;
	isOAuth?: boolean;
	hasTools?: boolean;
	onSseEvent?: AnthropicOptions["onSseEvent"];
	fetch?: FetchImpl;
};

export type AnthropicClientOptionsResult = {
	isOAuthToken: boolean;
	apiKey: string | null;
	authToken?: string | null;
	baseURL?: string;
	maxRetries: number;
	dangerouslyAllowBrowser: boolean;
	defaultHeaders: Record<string, string>;
	logLevel: AnthropicSdkClientOptions["logLevel"];
	fetch?: AnthropicSdkClientOptions["fetch"];
	fetchOptions?: AnthropicSdkClientOptions["fetchOptions"];
};

const CLAUDE_CODE_TLS_CIPHERS = tls.DEFAULT_CIPHERS;

type FoundryTlsOptions = {
	ca?: string | string[];
	cert?: string;
	key?: string;
};

function resolveAnthropicBaseUrl(model: Model<"anthropic-messages">, apiKey?: string): string | undefined {
	if (model.provider === "github-copilot") {
		return normalizeAnthropicBaseUrl(resolveGitHubCopilotBaseUrl(model.baseUrl, apiKey) ?? model.baseUrl);
	}
	if (model.provider === "anthropic" && isFoundryEnabled()) {
		const foundryBaseUrl = normalizeAnthropicBaseUrl($env.FOUNDRY_BASE_URL);
		if (foundryBaseUrl) {
			return foundryBaseUrl;
		}
	}
	if (model.provider === "anthropic") {
		return normalizeAnthropicBaseUrl(model.baseUrl) ?? "https://api.anthropic.com";
	}
	return normalizeAnthropicBaseUrl(model.baseUrl);
}

function parseAnthropicCustomHeaders(rawHeaders: string | undefined): Record<string, string> | undefined {
	const source = rawHeaders?.trim();
	if (!source) return undefined;

	const parsed: Record<string, string> = {};
	for (const token of source.split(/\r?\n|,/)) {
		const entry = token.trim();
		if (!entry) continue;
		const separatorIndex = entry.indexOf(":");
		if (separatorIndex <= 0) continue;
		const key = entry.slice(0, separatorIndex).trim();
		const value = entry.slice(separatorIndex + 1).trim();
		if (!key || !value) continue;
		parsed[key] = value;
	}

	return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function resolveAnthropicCustomHeaders(model: Model<"anthropic-messages">): Record<string, string> | undefined {
	if (model.provider !== "anthropic") return undefined;
	if (!isFoundryEnabled()) return undefined;
	return parseAnthropicCustomHeaders($env.ANTHROPIC_CUSTOM_HEADERS);
}

function looksLikeFilePath(value: string): boolean {
	return value.includes("/") || value.includes("\\") || /\.(pem|crt|cer|key)$/i.test(value);
}

function resolvePemValue(value: string | undefined, name: string): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;

	const inline = trimmed.replace(/\\n/g, "\n");
	if (inline.includes("-----BEGIN")) {
		return inline;
	}

	if (looksLikeFilePath(trimmed)) {
		try {
			return fs.readFileSync(trimmed, "utf8");
		} catch (error) {
			if (isEnoent(error)) {
				throw new Error(`${name} path does not exist: ${trimmed}`);
			}
			throw error;
		}
	}

	return inline;
}

function resolveFoundryTlsOptions(model: Model<"anthropic-messages">): FoundryTlsOptions | undefined {
	if (model.provider !== "anthropic") return undefined;
	if (!isFoundryEnabled()) return undefined;

	const ca = resolvePemValue($env.NODE_EXTRA_CA_CERTS, "NODE_EXTRA_CA_CERTS");
	const cert = resolvePemValue($env.CLAUDE_CODE_CLIENT_CERT, "CLAUDE_CODE_CLIENT_CERT");
	const key = resolvePemValue($env.CLAUDE_CODE_CLIENT_KEY, "CLAUDE_CODE_CLIENT_KEY");

	if ((cert && !key) || (!cert && key)) {
		throw new Error("Both CLAUDE_CODE_CLIENT_CERT and CLAUDE_CODE_CLIENT_KEY must be set for mTLS.");
	}

	const options: FoundryTlsOptions = {};
	if (ca) options.ca = [...tls.rootCertificates, ca];
	if (cert) options.cert = cert;
	if (key) options.key = key;
	return Object.keys(options).length > 0 ? options : undefined;
}

function buildClaudeCodeTlsFetchOptions(
	model: Model<"anthropic-messages">,
	baseUrl: string | undefined,
): AnthropicSdkClientOptions["fetchOptions"] | undefined {
	if (model.provider !== "anthropic") return undefined;
	if (!baseUrl) return undefined;

	let serverName: string;
	try {
		serverName = new URL(baseUrl).hostname;
	} catch {
		return undefined;
	}

	if (!serverName) return undefined;

	const foundryTlsOptions = resolveFoundryTlsOptions(model);

	return {
		tls: {
			rejectUnauthorized: true,
			serverName,
			...(CLAUDE_CODE_TLS_CIPHERS ? { ciphers: CLAUDE_CODE_TLS_CIPHERS } : {}),
			...(foundryTlsOptions ?? {}),
		},
	};
}
function mergeHeaders(...headerSources: (Record<string, string> | undefined)[]): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}
	return merged;
}

// The Anthropic SDK logs malformed SSE frames directly before rethrowing them.
// We surface the resulting provider error ourselves, so keep the SDK quiet.
const ANTHROPIC_SDK_LOG_LEVEL = "off" as const;

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
]);

async function* iterateAnthropicEvents(
	response: Response,
	signal?: AbortSignal,
	onSseEvent?: AnthropicOptions["onSseEvent"],
): AsyncGenerator<RawMessageStreamEvent> {
	if (!response.body) {
		throw new Error("Attempted to iterate over an Anthropic response with no body");
	}

	let sawMessageStart = false;
	let sawMessageEnd = false;

	for await (const sse of readSseEvents(response.body, signal)) {
		notifyRawSseEvent(onSseEvent, sse);
		if (sse.event === "error") {
			throw new Error(sse.data);
		}

		if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
			continue;
		}

		try {
			const event = parseJsonWithRepair<RawMessageStreamEvent>(sse.data);
			if (event.type === "message_start") {
				sawMessageStart = true;
			} else if (event.type === "message_stop") {
				sawMessageEnd = true;
			}
			yield event;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}; raw=${sse.raw.join("\\n")}`,
			);
		}
	}

	if (sawMessageStart && !sawMessageEnd) {
		throw createAnthropicStreamEnvelopeError("stream ended before message_stop");
	}
}

type AnthropicRawResponseRequest = {
	asResponse(): Promise<Response>;
};

function hasAnthropicRawResponseRequest(request: unknown): request is AnthropicRawResponseRequest {
	return isRecord(request) && typeof request.asResponse === "function";
}

type AnthropicStreamWithResponseRequest = {
	withResponse(): Promise<{
		data: AsyncIterable<RawMessageStreamEvent>;
		response: Response;
		request_id: string | null;
	}>;
};

function hasAnthropicStreamWithResponseRequest(request: unknown): request is AnthropicStreamWithResponseRequest {
	return isRecord(request) && typeof request.withResponse === "function";
}

async function getAnthropicStreamResponse(
	request: unknown,
	signal?: AbortSignal,
	onSseEvent?: AnthropicOptions["onSseEvent"],
): Promise<{ events: AsyncIterable<RawMessageStreamEvent>; response: Response; requestId: string | null }> {
	if (hasAnthropicRawResponseRequest(request)) {
		const response = await request.asResponse();
		return {
			events: iterateAnthropicEvents(response, signal, onSseEvent),
			response,
			requestId: response.headers.get("request-id"),
		};
	}
	if (hasAnthropicStreamWithResponseRequest(request)) {
		const { data, response, request_id } = await request.withResponse();
		return { events: data, response, requestId: request_id };
	}
	throw new Error("Anthropic SDK request did not expose a stream response");
}

function getAnthropicCompat(
	model: Model<"anthropic-messages">,
): Required<NonNullable<Model<"anthropic-messages">["compat"]>> {
	return {
		disableStrictTools: model.compat?.disableStrictTools ?? false,
		disableAdaptiveThinking: model.compat?.disableAdaptiveThinking ?? false,
		supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? true,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
	};
}

const PROVIDER_MAX_RETRIES = 3;
const PROVIDER_BASE_DELAY_MS = 2000;

/**
 * Check if an error from the Anthropic SDK is a rate-limit/transient error that
 * should be retried before any content has been emitted.
 *
 * Includes malformed JSON stream-envelope parse errors seen from some
 * Anthropic-compatible proxy endpoints.
 */
/** Transient stream corruption errors where the response was truncated mid-JSON. */
function isTransientStreamParseError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return /json parse error|unterminated string|unexpected end of json input/i.test(error.message);
}

const ANTHROPIC_STREAM_ENVELOPE_ERROR_PREFIX = "Anthropic stream envelope error:";

function createAnthropicStreamEnvelopeError(message: string): Error {
	return new Error(`${ANTHROPIC_STREAM_ENVELOPE_ERROR_PREFIX} ${message}`);
}

const ANTHROPIC_PRE_MESSAGE_START_EVENT_TYPES = new Set([
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
	"message_delta",
	"message_stop",
	"message_start",
]);

function shouldIgnoreAnthropicPreambleEvent(eventType: unknown): boolean {
	if (typeof eventType !== "string") return false;
	if (eventType === "ping") return true;
	return !ANTHROPIC_PRE_MESSAGE_START_EVENT_TYPES.has(eventType);
}

function isTransientStreamEnvelopeError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return (
		error.message.includes(ANTHROPIC_STREAM_ENVELOPE_ERROR_PREFIX) ||
		/stream event order|before message_start|before terminal stop signal/i.test(error.message)
	);
}

function isProviderRetryableStreamEnvelopeError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return /stream event order|before message_start/i.test(error.message);
}

export function isProviderRetryableError(error: unknown, provider?: string): boolean {
	if (!(error instanceof Error)) return false;
	if (provider === "github-copilot" && isCopilotTransientModelError(error)) return true;
	const msg = error.message.toLowerCase();
	if (
		isUnexpectedSocketCloseMessage(msg) ||
		/rate.?limit|too many requests|overloaded|service.?unavailable|internal_error|stream error.*received from peer|1302|timed?\s*out while waiting for the first event|timeout waiting for first/i.test(
			msg,
		) ||
		isTransientStreamParseError(error) ||
		isProviderRetryableStreamEnvelopeError(error)
	) {
		return true;
	}
	return isRetryableError(error);
}

function createEmptyUsage(premiumRequests?: number): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		...(premiumRequests === undefined ? {} : { premiumRequests }),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export type AnthropicUsageLike = {
	cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
	server_tool_use?: { web_search_requests?: number | null; web_fetch_requests?: number | null } | null;
};

/**
 * Capture Anthropic's optional cache-creation TTL breakdown and server-tool-use
 * counters into the harness Usage shape. Only sets fields that were reported, so
 * a `message_delta` that omits `cache_creation` does not clobber the breakdown
 * established at `message_start`.
 */
export function applyAnthropicUsageExtras(usage: Usage, source: AnthropicUsageLike): void {
	const cacheCreation = source.cache_creation;
	if (cacheCreation) {
		const fiveMinute = cacheCreation.ephemeral_5m_input_tokens ?? 0;
		const oneHour = cacheCreation.ephemeral_1h_input_tokens ?? 0;
		if (fiveMinute > 0 || oneHour > 0) {
			usage.cttl = {
				...(fiveMinute > 0 ? { ephemeral5m: fiveMinute } : {}),
				...(oneHour > 0 ? { ephemeral1h: oneHour } : {}),
			};
		}
	}
	const serverToolUse = source.server_tool_use;
	if (serverToolUse) {
		const webSearch = serverToolUse.web_search_requests ?? 0;
		const webFetch = serverToolUse.web_fetch_requests ?? 0;
		if (webSearch > 0 || webFetch > 0) {
			usage.server = {
				...(webSearch > 0 ? { webSearch } : {}),
				...(webFetch > 0 ? { webFetch } : {}),
			};
		}
	}
}

export const streamAnthropic: StreamFunction<"anthropic-messages"> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = Date.now();
		let firstTokenTime: number | undefined;

		const copilotDynamicHeaders =
			model.provider === "github-copilot"
				? buildCopilotDynamicHeaders({
						messages: context.messages,
						hasImages: hasCopilotVisionInput(context.messages),
						premiumMultiplier: model.premiumMultiplier,
						headers: { ...(model.headers ?? {}), ...(options?.headers ?? {}) },
						initiatorOverride: options?.initiatorOverride,
					})
				: undefined;
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: createEmptyUsage(copilotDynamicHeaders?.premiumRequests),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		let rawRequestDump: RawHttpRequestDump | undefined;
		let activeAbortTracker = createAbortSourceTracker(options?.signal);

		try {
			let client: Anthropic;
			let isOAuthToken: boolean;

			if (options?.client) {
				client = options.client;
				isOAuthToken = false;
			} else {
				const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";

				const extraBetas = normalizeExtraBetas(options?.betas);
				const wantsAnthropicPriority = resolveServiceTier(options?.serviceTier, model.provider) === "priority";
				if (wantsAnthropicPriority && !extraBetas.includes(fastModeBeta)) {
					extraBetas.push(fastModeBeta);
				}

				const created = createClient(model, {
					model,
					apiKey,
					extraBetas,
					stream: true,
					interleavedThinking: options?.interleavedThinking ?? true,
					headers: options?.headers,
					dynamicHeaders: copilotDynamicHeaders?.headers,
					isOAuth: options?.isOAuth,
					hasTools: !!context.tools?.length,
					onSseEvent: options?.onSseEvent,
					fetch: options?.fetch,
				});
				client = created.client;
				isOAuthToken = created.isOAuthToken;
			}
			const baseUrl =
				resolveAnthropicBaseUrl(model, options?.apiKey ?? getEnvApiKey(model.provider) ?? "") ??
				"https://api.anthropic.com";
			const providerSessionState = getAnthropicProviderSessionState(options?.providerSessionState);
			let disableStrictTools =
				(providerSessionState?.strictToolsDisabled ?? false) || (model.compat?.disableStrictTools ?? false);
			let strictFallbackErrorMessage: string | undefined;
			let dropFastMode = providerSessionState?.fastModeDisabled ?? false;
			const prepareParams = async (paramsOptions?: {
				repairLatestAssistantThinking?: boolean;
			}): Promise<MessageCreateParamsStreaming> => {
				let nextParams = buildParams(
					model,
					baseUrl,
					context,
					isOAuthToken,
					options,
					disableStrictTools,
					paramsOptions?.repairLatestAssistantThinking === true,
				);
				if (disableStrictTools) {
					dropAnthropicStrictTools(nextParams);
				}
				if (dropFastMode) {
					dropAnthropicFastMode(nextParams);
				}
				const replacementPayload = await options?.onPayload?.(nextParams, model);
				if (replacementPayload !== undefined) {
					nextParams = replacementPayload as typeof nextParams;
				}
				rawRequestDump = {
					provider: model.provider,
					api: output.api,
					model: model.id,
					method: "POST",
					url: `${baseUrl}/v1/messages`,
					body: nextParams,
				};
				return nextParams;
			};
			let params = await prepareParams();

			type Block = (
				| ThinkingContent
				| RedactedThinkingContent
				| TextContent
				| (ToolCall & { partialJson: string })
			) & { index: number };
			const blocks = output.content as Block[];
			const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getStreamIdleTimeoutMs();
			const firstEventTimeoutMs = options?.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs(idleTimeoutMs);
			stream.push({ type: "start", partial: output });
			// Retry loop for transient errors from the stream.
			// Provider-level transport/rate-limit failures: only before any streamed content starts.
			// Malformed envelopes/JSON: only before replay-unsafe text/tool events are visible on this stream.
			let providerRetryAttempt = 0;
			let thinkingRepairAttempted = false;
			while (true) {
				activeAbortTracker = createAbortSourceTracker(options?.signal);
				const firstEventTimeoutAbortError = new Error(
					"Anthropic stream timed out while waiting for the first event",
				);
				const idleTimeoutAbortError = new Error("Anthropic stream stalled while waiting for the next event");
				const { requestSignal } = activeAbortTracker;
				const anthropicRequest = client.messages.create({ ...params, stream: true }, { signal: requestSignal });
				let streamedReplayUnsafeContent = false;

				try {
					const {
						events: anthropicStream,
						response,
						requestId,
					} = await getAnthropicStreamResponse(
						anthropicRequest,
						requestSignal,
						options?.client ? event => options?.onSseEvent?.(event, model) : undefined,
					);
					await notifyProviderResponse(options, response, model, requestId);
					let sawEvent = false;
					let sawMessageStart = false;
					let sawTerminalEnvelope = false;

					for await (const event of iterateWithIdleTimeout(anthropicStream, {
						idleTimeoutMs,
						firstItemTimeoutMs: firstEventTimeoutMs,
						errorMessage: idleTimeoutAbortError.message,
						firstItemErrorMessage: firstEventTimeoutAbortError.message,
						onIdle: () => activeAbortTracker.abortLocally(idleTimeoutAbortError),
						onFirstItemTimeout: () => activeAbortTracker.abortLocally(firstEventTimeoutAbortError),
						abortSignal: options?.signal,
					})) {
						sawEvent = true;

						if (event.type === "message_start") {
							if (sawMessageStart) {
								continue;
							}
							sawMessageStart = true;
							applyAnthropicUsageExtras(output.usage, event.message.usage);
							output.responseId = event.message.id;
							output.usage.input = event.message.usage.input_tokens || 0;
							output.usage.output = event.message.usage.output_tokens || 0;
							output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
							output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
							output.usage.totalTokens =
								output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
							calculateCost(model, output.usage);
							continue;
						}

						if (!sawMessageStart) {
							if (shouldIgnoreAnthropicPreambleEvent(event.type)) {
								continue;
							}
							throw createAnthropicStreamEnvelopeError(`received ${event.type} before message_start`);
						}

						if (event.type === "content_block_start") {
							if (!firstTokenTime) firstTokenTime = Date.now();
							if (event.content_block.type === "text") {
								streamedReplayUnsafeContent = true;
								const block: Block = {
									type: "text",
									text: "",
									index: event.index,
								};
								output.content.push(block);
								stream.push({
									type: "text_start",
									contentIndex: output.content.length - 1,
									partial: output,
								});
							} else if (event.content_block.type === "thinking") {
								const block: Block = {
									type: "thinking",
									thinking: "",
									thinkingSignature: "",
									index: event.index,
								};
								output.content.push(block);
								stream.push({
									type: "thinking_start",
									contentIndex: output.content.length - 1,
									partial: output,
								});
							} else if (event.content_block.type === "redacted_thinking") {
								const block: Block = {
									type: "redactedThinking",
									data: event.content_block.data,
									index: event.index,
								};
								output.content.push(block);
							} else if (event.content_block.type === "tool_use") {
								streamedReplayUnsafeContent = true;
								const block: Block = {
									type: "toolCall",
									id: event.content_block.id,
									name: isOAuthToken
										? stripClaudeToolPrefix(event.content_block.name)
										: event.content_block.name,
									arguments: (event.content_block.input as Record<string, unknown>) ?? {},
									partialJson: "",
									index: event.index,
								};
								output.content.push(block);
								stream.push({
									type: "toolcall_start",
									contentIndex: output.content.length - 1,
									partial: output,
								});
							}
						} else if (event.type === "content_block_delta") {
							if (event.delta.type === "text_delta") {
								const index = blocks.findIndex(b => b.index === event.index);
								const block = blocks[index];
								if (block && block.type === "text") {
									block.text += event.delta.text;
									stream.push({
										type: "text_delta",
										contentIndex: index,
										delta: event.delta.text,
										partial: output,
									});
								}
							} else if (event.delta.type === "thinking_delta") {
								const index = blocks.findIndex(b => b.index === event.index);
								const block = blocks[index];
								if (block && block.type === "thinking") {
									block.thinking += event.delta.thinking;
									stream.push({
										type: "thinking_delta",
										contentIndex: index,
										delta: event.delta.thinking,
										partial: output,
									});
								}
							} else if (event.delta.type === "input_json_delta") {
								const index = blocks.findIndex(b => b.index === event.index);
								const block = blocks[index];
								if (block && block.type === "toolCall") {
									block.partialJson += event.delta.partial_json;
									block.arguments = parseStreamingJson(block.partialJson);
									stream.push({
										type: "toolcall_delta",
										contentIndex: index,
										delta: event.delta.partial_json,
										partial: output,
									});
								}
							} else if (event.delta.type === "signature_delta") {
								const index = blocks.findIndex(b => b.index === event.index);
								const block = blocks[index];
								if (block && block.type === "thinking") {
									block.thinkingSignature = block.thinkingSignature || "";
									block.thinkingSignature += event.delta.signature;
								}
							}
						} else if (event.type === "content_block_stop") {
							const index = blocks.findIndex(b => b.index === event.index);
							const block = blocks[index];
							if (block) {
								delete (block as { index?: number }).index;
								if (block.type === "text") {
									stream.push({
										type: "text_end",
										contentIndex: index,
										content: block.text,
										partial: output,
									});
								} else if (block.type === "thinking") {
									stream.push({
										type: "thinking_end",
										contentIndex: index,
										content: block.thinking,
										partial: output,
									});
								} else if (block.type === "toolCall") {
									block.arguments = parseStreamingJson(block.partialJson);
									delete (block as { partialJson?: string }).partialJson;
									stream.push({
										type: "toolcall_end",
										contentIndex: index,
										toolCall: block,
										partial: output,
									});
								}
							}
						} else if (event.type === "message_delta") {
							const rawStopReason = event.delta.stop_reason as string | null | undefined;
							if (rawStopReason) {
								output.stopReason = mapStopReason(rawStopReason);
								sawTerminalEnvelope = true;
							}
							const stopDetails = event.delta.stop_details;
							if (stopDetails && stopDetails.type === "refusal") {
								const explanation = stopDetails.explanation?.trim();
								const category = stopDetails.category;
								const label = category ? `Refusal (${category})` : "Refusal";
								output.errorMessage = explanation ? `${label}: ${explanation}` : label;
							} else if (output.stopReason === "error" && !output.errorMessage) {
								// Anthropic flagged an error-class stop (refusal / sensitive) without
								// populating stop_details. Surface the raw reason instead of falling
								// through to the generic "unknown error" string when we throw below.
								output.errorMessage =
									rawStopReason === "refusal"
										? "Refusal (no details provided)"
										: rawStopReason === "sensitive"
											? "Content flagged by safety filters"
											: `Anthropic stream ended with stop_reason: ${rawStopReason ?? "unknown"}`;
							}
							if (event.usage.input_tokens != null) {
								output.usage.input = event.usage.input_tokens;
							}
							if (event.usage.output_tokens != null) {
								output.usage.output = event.usage.output_tokens;
							}
							if (event.usage.cache_read_input_tokens != null) {
								output.usage.cacheRead = event.usage.cache_read_input_tokens;
							}
							if (event.usage.cache_creation_input_tokens != null) {
								output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
							}
							applyAnthropicUsageExtras(output.usage, event.usage);
							output.usage.totalTokens =
								output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
							calculateCost(model, output.usage);
						} else if (event.type === "message_stop") {
							sawTerminalEnvelope = true;
						}
					}

					const firstEventTimeoutError = activeAbortTracker.getLocalAbortReason();
					if (firstEventTimeoutError) {
						throw firstEventTimeoutError;
					}
					if (activeAbortTracker.wasCallerAbort()) {
						throw new Error("Request was aborted");
					}
					if (!sawEvent || !sawMessageStart) {
						throw createAnthropicStreamEnvelopeError("stream ended before message_start");
					}
					if (!sawTerminalEnvelope) {
						throw createAnthropicStreamEnvelopeError("stream ended before terminal stop signal");
					}

					if (output.stopReason === "aborted" || output.stopReason === "error") {
						throw new Error(output.errorMessage ?? "An unknown error occurred");
					}
					break;
				} catch (streamError) {
					const streamFailure = activeAbortTracker.getLocalAbortReason() ?? streamError;
					if (
						!disableStrictTools &&
						firstTokenTime === undefined &&
						hasStrictAnthropicTools(params) &&
						isAnthropicStrictGrammarTooLargeError(streamFailure)
					) {
						strictFallbackErrorMessage = await finalizeErrorMessage(streamFailure, rawRequestDump);
						output.errorMessage = strictFallbackErrorMessage;
						if (providerSessionState) {
							providerSessionState.strictToolsDisabled = true;
						}
						disableStrictTools = true;
						params = await prepareParams();
						providerRetryAttempt = 0;
						output.content.length = 0;
						output.responseId = undefined;
						output.providerPayload = undefined;
						output.usage = createEmptyUsage(copilotDynamicHeaders?.premiumRequests);
						output.stopReason = "stop";
						firstTokenTime = undefined;
						continue;
					}
					if (
						!thinkingRepairAttempted &&
						firstTokenTime === undefined &&
						isAnthropicThinkingBlockMutationError(streamFailure)
					) {
						logger.debug("anthropic: repairing latest assistant thinking replay after provider rejection", {
							model: model.id,
							error: streamFailure instanceof Error ? streamFailure.message : String(streamFailure),
						});
						thinkingRepairAttempted = true;
						params = await prepareParams({ repairLatestAssistantThinking: true });
						providerRetryAttempt = 0;
						output.content.length = 0;
						output.responseId = undefined;
						output.providerPayload = undefined;
						output.usage = createEmptyUsage(copilotDynamicHeaders?.premiumRequests);
						output.stopReason = "stop";
						firstTokenTime = undefined;
						continue;
					}
					if (
						!dropFastMode &&
						resolveServiceTier(options?.serviceTier, model.provider) === "priority" &&
						firstTokenTime === undefined &&
						isAnthropicFastModeUnsupportedError(streamFailure)
					) {
						logger.debug("anthropic: fast mode unsupported, retrying without speed", {
							model: model.id,
							error: streamFailure instanceof Error ? streamFailure.message : String(streamFailure),
						});
						if (providerSessionState) {
							providerSessionState.fastModeDisabled = true;
						}
						dropFastMode = true;
						params = await prepareParams();
						providerRetryAttempt = 0;
						output.content.length = 0;
						output.responseId = undefined;
						output.providerPayload = undefined;
						output.usage = createEmptyUsage(copilotDynamicHeaders?.premiumRequests);
						output.stopReason = "stop";
						firstTokenTime = undefined;
						continue;
					}
					const isTransientEnvelopeFailure =
						isTransientStreamParseError(streamFailure) || isTransientStreamEnvelopeError(streamFailure);
					const canRetryTransientEnvelopeFailure = isTransientEnvelopeFailure && !streamedReplayUnsafeContent;
					const canRetryProviderFailure =
						firstTokenTime === undefined && isProviderRetryableError(streamFailure, model.provider);
					if (
						activeAbortTracker.wasCallerAbort() ||
						providerRetryAttempt >= PROVIDER_MAX_RETRIES ||
						(!canRetryTransientEnvelopeFailure && !canRetryProviderFailure)
					) {
						throw streamFailure;
					}
					providerRetryAttempt++;
					const delayMs = PROVIDER_BASE_DELAY_MS * 2 ** (providerRetryAttempt - 1);
					if (options?.providerRetryWait) {
						await options.providerRetryWait(delayMs, options.signal);
					} else {
						await scheduler.wait(delayMs, { signal: options?.signal });
					}
					output.content.length = 0;
					output.responseId = undefined;
					output.errorMessage = strictFallbackErrorMessage;
					output.providerPayload = undefined;
					output.usage = createEmptyUsage(copilotDynamicHeaders?.premiumRequests);
					output.stopReason = "stop";
					firstTokenTime = undefined;
				}
			}

			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			if (dropFastMode && resolveServiceTier(options?.serviceTier, model.provider) === "priority") {
				output.disabledFeatures = [...(output.disabledFeatures ?? []), "priority"];
			}
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				delete (block as { partialJson?: string }).partialJson;
			}
			const firstEventTimeoutError = activeAbortTracker.getLocalAbortReason();
			output.stopReason = activeAbortTracker.wasCallerAbort() ? "aborted" : "error";
			output.errorStatus = extractHttpStatusFromError(error);
			output.errorMessage = firstEventTimeoutError?.message ?? (await finalizeErrorMessage(error, rawRequestDump));
			output.errorMessage = rewriteCopilotError(output.errorMessage, error, model.provider);
			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export type AnthropicSystemBlock = {
	type: "text";
	text: string;
	cache_control?: AnthropicCacheControl;
};
type SystemBlockOptions = {
	includeClaudeCodeInstruction?: boolean;
	extraInstructions?: string[];
	billingPayload?: unknown;
	cacheControl?: AnthropicCacheControl;
};

export function buildAnthropicSystemBlocks(
	systemPrompt: readonly string[] | undefined,
	options: SystemBlockOptions = {},
): AnthropicSystemBlock[] | undefined {
	const { includeClaudeCodeInstruction = false, extraInstructions = [], billingPayload, cacheControl } = options;
	const blocks: AnthropicSystemBlock[] = [];
	const sanitizedPrompts = normalizeSystemPrompts(systemPrompt);
	const trimmedInstructions = extraInstructions.map(instruction => instruction.trim()).filter(Boolean);
	const hasBillingHeader = sanitizedPrompts.some(prompt => prompt.includes(CLAUDE_BILLING_HEADER_PREFIX));

	if (includeClaudeCodeInstruction && !hasBillingHeader) {
		const payloadSeed = billingPayload ?? {
			system: sanitizedPrompts,
			extraInstructions: trimmedInstructions,
		};
		blocks.push(
			{ type: "text", text: createClaudeBillingHeader(payloadSeed) },
			{
				type: "text",
				text: claudeCodeSystemInstruction,
			},
		);
	}

	for (const instruction of trimmedInstructions) {
		blocks.push({ type: "text", text: instruction });
	}

	for (const systemPrompt of sanitizedPrompts) {
		blocks.push({ type: "text", text: systemPrompt });
	}

	// Attach cache_control to the LAST emitted block only. Anthropic breakpoints are cumulative
	// prefix cuts, so a single trailing breakpoint covers every preceding block; spreading
	// cache_control across N blocks wastes slots against the 4-breakpoint cap.
	const lastIndex = blocks.length - 1;
	if (cacheControl && lastIndex >= 0) {
		blocks[lastIndex] = { ...blocks[lastIndex], cache_control: cacheControl };
	}

	return blocks.length > 0 ? blocks : undefined;
}

export function normalizeExtraBetas(betas?: string[] | string): string[] {
	if (!betas) return [];
	const raw = Array.isArray(betas) ? betas : betas.split(",");
	return raw.map(beta => beta.trim()).filter(beta => beta.length > 0);
}

export function buildAnthropicClientOptions(args: AnthropicClientOptionsArgs): AnthropicClientOptionsResult {
	const {
		model,
		apiKey,
		extraBetas = [],
		stream = true,
		interleavedThinking = true,
		headers,
		dynamicHeaders,
		hasTools = false,
		isOAuth,
		onSseEvent,
	} = args;
	const compat = getAnthropicCompat(model);
	const needsInterleavedBeta = interleavedThinking && !supportsAdaptiveThinkingDisplay(model.id);
	const needsFineGrainedToolStreamingBeta = hasTools && !compat.supportsEagerToolInputStreaming;
	const oauthToken = isOAuth ?? isAnthropicOAuthToken(apiKey);
	const baseUrl = resolveAnthropicBaseUrl(model, apiKey);
	const foundryCustomHeaders = resolveAnthropicCustomHeaders(model);
	const tlsFetchOptions = buildClaudeCodeTlsFetchOptions(model, baseUrl);
	const baseFetch = args.fetch ?? fetch;
	const debugFetch = onSseEvent
		? wrapFetchForSseDebug(baseFetch, event => onSseEvent(event, model))
		: args.fetch
			? baseFetch
			: undefined;
	if (model.provider === "github-copilot") {
		const copilotApiKey = parseGitHubCopilotApiKey(apiKey).accessToken;
		const betaFeatures = [...extraBetas];
		if (needsFineGrainedToolStreamingBeta) {
			betaFeatures.push(fineGrainedToolStreamingBeta);
		}
		const defaultHeaders = mergeHeaders(
			{
				Accept: stream ? "text/event-stream" : "application/json",
				"Anthropic-Dangerous-Direct-Browser-Access": "true",
				Authorization: `Bearer ${copilotApiKey}`,
				...(betaFeatures.length > 0 ? { "anthropic-beta": buildBetaHeader([], betaFeatures) } : {}),
			},
			model.headers,
			dynamicHeaders,
			headers,
		);

		return {
			isOAuthToken: false,
			apiKey: null,
			authToken: copilotApiKey,
			baseURL: baseUrl,
			maxRetries: 5,
			dangerouslyAllowBrowser: true,
			defaultHeaders,
			logLevel: ANTHROPIC_SDK_LOG_LEVEL,
			...(debugFetch ? { fetch: debugFetch } : {}),
			...(tlsFetchOptions ? { fetchOptions: tlsFetchOptions } : {}),
		};
	}

	const betaFeatures = [...extraBetas];
	if (needsFineGrainedToolStreamingBeta) {
		betaFeatures.push(fineGrainedToolStreamingBeta);
	}
	if (needsInterleavedBeta) {
		betaFeatures.push(interleavedThinkingBeta);
	}

	const defaultHeaders = buildAnthropicHeaders({
		apiKey,
		baseUrl,
		isOAuth: oauthToken,
		extraBetas: betaFeatures,
		stream,
		modelHeaders: mergeHeaders(model.headers, foundryCustomHeaders, headers, dynamicHeaders),
		isCloudflareAiGateway: model.provider === "cloudflare-ai-gateway",
	});

	if (model.provider === "cloudflare-ai-gateway") {
		return {
			isOAuthToken: false,
			apiKey: null,
			authToken: null,
			baseURL: baseUrl,
			maxRetries: 5,
			dangerouslyAllowBrowser: true,
			defaultHeaders,
			logLevel: ANTHROPIC_SDK_LOG_LEVEL,
			...(debugFetch ? { fetch: debugFetch } : {}),
		};
	}

	return {
		isOAuthToken: oauthToken,
		apiKey: oauthToken ? null : apiKey,
		authToken: oauthToken ? apiKey : undefined,
		baseURL: baseUrl,
		maxRetries: 5,
		dangerouslyAllowBrowser: true,
		defaultHeaders,
		logLevel: ANTHROPIC_SDK_LOG_LEVEL,
		...(debugFetch ? { fetch: debugFetch } : {}),
		...(tlsFetchOptions ? { fetchOptions: tlsFetchOptions } : {}),
	};
}

function createClient(
	model: Model<"anthropic-messages">,
	args: AnthropicClientOptionsArgs,
): { client: Anthropic; isOAuthToken: boolean } {
	const { isOAuthToken: oauthToken, ...clientOptions } = buildAnthropicClientOptions({ ...args, model });
	const client = new Anthropic(clientOptions);
	return { client, isOAuthToken: oauthToken };
}

function disableThinkingIfToolChoiceForced(params: MessageCreateParamsStreaming): void {
	const toolChoice = params.tool_choice;
	if (!toolChoice) return;
	if (toolChoice.type === "any" || toolChoice.type === "tool") {
		delete params.thinking;
		delete params.output_config;
	}
}

function ensureMaxTokensForThinking(params: MessageCreateParamsStreaming, model: Model<"anthropic-messages">): void {
	const thinking = params.thinking;
	if (!thinking || thinking.type !== "enabled") return;

	const budgetTokens = thinking.budget_tokens ?? 0;
	if (budgetTokens <= 0) return;

	const maxTokens = params.max_tokens ?? 0;
	const requiredMaxTokens = budgetTokens + OUTPUT_FALLBACK_BUFFER;
	if (maxTokens < requiredMaxTokens) {
		params.max_tokens = Math.min(requiredMaxTokens, model.maxTokens);
	}
}

type CacheControlBlock = {
	cache_control?: AnthropicCacheControl | null;
};

function applyCacheControlToLastBlock<T extends CacheControlBlock>(
	blocks: T[],
	cacheControl: AnthropicCacheControl,
): void {
	if (blocks.length === 0) return;
	const lastIndex = blocks.length - 1;
	blocks[lastIndex] = { ...blocks[lastIndex], cache_control: cacheControl };
}

function applyCacheControlToLastTextBlock(
	blocks: Array<ContentBlockParam & CacheControlBlock>,
	cacheControl: AnthropicCacheControl,
): void {
	if (blocks.length === 0) return;
	for (let i = blocks.length - 1; i >= 0; i--) {
		if (blocks[i].type === "text") {
			blocks[i] = { ...blocks[i], cache_control: cacheControl };
			return;
		}
	}
	applyCacheControlToLastBlock(blocks, cacheControl);
}

function applyPromptCaching(params: MessageCreateParamsStreaming, cacheControl?: AnthropicCacheControl): void {
	if (!cacheControl) return;

	// Skip if cache_control breakpoints were already placed externally on messages.
	for (const message of params.messages) {
		if (Array.isArray(message.content)) {
			if ((message.content as Array<ContentBlockParam & CacheControlBlock>).some(b => b.cache_control != null))
				return;
		}
	}

	const MAX_CACHE_BREAKPOINTS = 4;
	let cacheBreakpointsUsed = 0;

	if (params.tools && params.tools.length > 0) {
		applyCacheControlToLastBlock(params.tools as Array<CacheControlBlock>, cacheControl);
		cacheBreakpointsUsed++;
	}

	if (cacheBreakpointsUsed >= MAX_CACHE_BREAKPOINTS) return;

	if (params.system && Array.isArray(params.system) && params.system.length > 0) {
		applyCacheControlToLastBlock(params.system, cacheControl);
		cacheBreakpointsUsed++;
	}

	if (cacheBreakpointsUsed >= MAX_CACHE_BREAKPOINTS) return;

	const userIndexes = params.messages
		.map((message, index) => (message.role === "user" ? index : -1))
		.filter(index => index >= 0);

	if (userIndexes.length >= 2) {
		const penultimateUserIndex = userIndexes[userIndexes.length - 2];
		const penultimateUser = params.messages[penultimateUserIndex];
		if (penultimateUser) {
			if (typeof penultimateUser.content === "string") {
				const contentBlock: ContentBlockParam & CacheControlBlock = {
					type: "text",
					text: penultimateUser.content,
					cache_control: cacheControl,
				};
				penultimateUser.content = [contentBlock];
				cacheBreakpointsUsed++;
			} else if (Array.isArray(penultimateUser.content) && penultimateUser.content.length > 0) {
				applyCacheControlToLastTextBlock(
					penultimateUser.content as Array<ContentBlockParam & CacheControlBlock>,
					cacheControl,
				);
				cacheBreakpointsUsed++;
			}
		}
	}

	if (cacheBreakpointsUsed >= MAX_CACHE_BREAKPOINTS) return;

	if (userIndexes.length >= 1) {
		const lastUserIndex = userIndexes[userIndexes.length - 1];
		const lastUser = params.messages[lastUserIndex];
		if (lastUser) {
			if (typeof lastUser.content === "string") {
				const contentBlock: ContentBlockParam & CacheControlBlock = {
					type: "text",
					text: lastUser.content,
					cache_control: cacheControl,
				};
				lastUser.content = [contentBlock];
			} else if (Array.isArray(lastUser.content) && lastUser.content.length > 0) {
				applyCacheControlToLastTextBlock(
					lastUser.content as Array<ContentBlockParam & CacheControlBlock>,
					cacheControl,
				);
			}
		}
	}
}

function normalizeCacheControlBlockTtl(block: CacheControlBlock, seenFiveMinute: { value: boolean }): void {
	const cacheControl = block.cache_control;
	if (!cacheControl) return;
	if (cacheControl.ttl !== "1h") {
		seenFiveMinute.value = true;
		return;
	}
	if (seenFiveMinute.value) {
		delete cacheControl.ttl;
	}
}

function normalizeCacheControlTtlOrdering(params: MessageCreateParamsStreaming): void {
	const seenFiveMinute = { value: false };
	if (params.tools) {
		for (const tool of params.tools as Array<Anthropic.Messages.Tool & CacheControlBlock>) {
			normalizeCacheControlBlockTtl(tool, seenFiveMinute);
		}
	}
	if (params.system && Array.isArray(params.system)) {
		for (const block of params.system as Array<AnthropicSystemBlock & CacheControlBlock>) {
			normalizeCacheControlBlockTtl(block, seenFiveMinute);
		}
	}
	for (const message of params.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content as Array<ContentBlockParam & CacheControlBlock>) {
			normalizeCacheControlBlockTtl(block, seenFiveMinute);
		}
	}
}

function findLastCacheControlIndex<T extends CacheControlBlock>(blocks: T[]): number {
	for (let index = blocks.length - 1; index >= 0; index--) {
		if (blocks[index]?.cache_control != null) return index;
	}
	return -1;
}

function stripCacheControlExceptIndex<T extends CacheControlBlock>(
	blocks: T[],
	preserveIndex: number,
	excessCounter: { value: number },
): void {
	for (let index = 0; index < blocks.length && excessCounter.value > 0; index++) {
		if (index === preserveIndex) continue;
		if (!blocks[index]?.cache_control) continue;
		delete blocks[index].cache_control;
		excessCounter.value--;
	}
}

function stripAllCacheControl<T extends CacheControlBlock>(blocks: T[], excessCounter: { value: number }): void {
	for (const block of blocks) {
		if (excessCounter.value <= 0) return;
		if (!block.cache_control) continue;
		delete block.cache_control;
		excessCounter.value--;
	}
}

function stripMessageCacheControl(
	messages: MessageCreateParamsStreaming["messages"],
	excessCounter: { value: number },
): void {
	for (const message of messages) {
		if (excessCounter.value <= 0) return;
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content as Array<ContentBlockParam & CacheControlBlock>) {
			if (excessCounter.value <= 0) return;
			if (!block.cache_control) continue;
			delete block.cache_control;
			excessCounter.value--;
		}
	}
}

function countCacheControlBreakpoints(params: MessageCreateParamsStreaming): number {
	let total = 0;
	if (params.tools) {
		for (const tool of params.tools as Array<Anthropic.Messages.Tool & CacheControlBlock>) {
			if (tool.cache_control) total++;
		}
	}
	if (params.system && Array.isArray(params.system)) {
		for (const block of params.system as Array<AnthropicSystemBlock & CacheControlBlock>) {
			if (block.cache_control) total++;
		}
	}
	for (const message of params.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content as Array<ContentBlockParam & CacheControlBlock>) {
			if (block.cache_control) total++;
		}
	}
	return total;
}

function enforceCacheControlLimit(params: MessageCreateParamsStreaming, maxBreakpoints: number): void {
	const total = countCacheControlBreakpoints(params);
	if (total <= maxBreakpoints) return;
	const excessCounter = { value: total - maxBreakpoints };
	const systemBlocks =
		params.system && Array.isArray(params.system)
			? (params.system as Array<AnthropicSystemBlock & CacheControlBlock>)
			: [];
	const toolBlocks = (params.tools ?? []) as Array<Anthropic.Messages.Tool & CacheControlBlock>;
	const lastSystemIndex = findLastCacheControlIndex(systemBlocks);
	const lastToolIndex = findLastCacheControlIndex(toolBlocks);
	if (systemBlocks.length > 0) {
		stripCacheControlExceptIndex(systemBlocks, lastSystemIndex, excessCounter);
	}
	if (excessCounter.value <= 0) return;
	if (toolBlocks.length > 0) {
		stripCacheControlExceptIndex(toolBlocks, lastToolIndex, excessCounter);
	}
	if (excessCounter.value <= 0) return;
	stripMessageCacheControl(params.messages, excessCounter);
	if (excessCounter.value <= 0) return;
	if (systemBlocks.length > 0) {
		stripAllCacheControl(systemBlocks, excessCounter);
	}
	if (excessCounter.value <= 0) return;
	if (toolBlocks.length > 0) {
		stripAllCacheControl(toolBlocks, excessCounter);
	}
}
function buildParams(
	model: Model<"anthropic-messages">,
	baseUrl: string,
	context: Context,
	isOAuthToken: boolean,
	options?: AnthropicOptions,
	disableStrictTools = false,
	repairLatestAssistantThinking = false,
): MessageCreateParamsStreaming {
	const { cacheControl } = getCacheControl(model, baseUrl, options?.cacheRetention);
	const params: AnthropicSamplingParams = {
		model: model.id,
		messages: convertAnthropicMessages(context.messages, model, isOAuthToken, { repairLatestAssistantThinking }),
		max_tokens: options?.maxTokens || (model.maxTokens / 3) | 0,
		stream: true,
	};
	if (options?.temperature !== undefined && !options?.thinkingEnabled) {
		params.temperature = options.temperature;
	}

	if (options?.topP !== undefined) {
		params.top_p = options.topP;
	}
	if (options?.topK !== undefined) {
		params.top_k = options.topK;
	}
	if (options?.stopSequences?.length) {
		const seqs = options.stopSequences;
		if (seqs.length > ANTHROPIC_STOP_SEQUENCES_MAX && !warnedStopSequencesTrim) {
			warnedStopSequencesTrim = true;
			logger.warn("anthropic: stop_sequences exceeds 4; extra entries dropped", {
				received: seqs.length,
				kept: ANTHROPIC_STOP_SEQUENCES_MAX,
			});
		}
		params.stop_sequences =
			seqs.length > ANTHROPIC_STOP_SEQUENCES_MAX ? seqs.slice(0, ANTHROPIC_STOP_SEQUENCES_MAX) : seqs;
	}

	// Opus 4.7+ rejects non-default sampling parameters with 400 error.
	if (hasOpus47ApiRestrictions(model.id)) {
		delete params.top_p;
		delete params.top_k;
		delete params.temperature;
	}

	if (context.tools) {
		params.tools = convertTools(
			context.tools,
			isOAuthToken,
			disableStrictTools || model.provider === "github-copilot",
			getAnthropicCompat(model).supportsEagerToolInputStreaming,
		);
	}

	if (model.reasoning) {
		if (options?.thinkingEnabled) {
			const mode = model.thinking?.mode;
			const requestedEffort = options.reasoning;
			const effort =
				options.effort ??
				(requestedEffort ? mapEffortToAnthropicAdaptiveEffort(model, requestedEffort) : undefined);

			const compat = getAnthropicCompat(model);
			if (mode === "anthropic-adaptive" && !compat.disableAdaptiveThinking) {
				// Starting with Anthropic model Opus 4.7, adaptive thinking content is omitted from the
				// response by default. Opt into summarized reasoning so thinking deltas keep
				// streaming with human-readable content for callers that rely on it.
				const adaptive: { type: "adaptive"; display?: AnthropicThinkingDisplay } = { type: "adaptive" };
				if (supportsAdaptiveThinkingDisplay(model.id)) {
					adaptive.display = options.thinkingDisplay ?? "summarized";
				}
				params.thinking = adaptive as typeof params.thinking;
				if (effort) {
					// SDK's OutputConfig.effort type is not yet widened to include the new "xhigh"
					// level introduced with Anthropic model Opus 4.7. Cast until the SDK catches up.
					params.output_config = { effort } as typeof params.output_config;
				}
			} else {
				params.thinking = {
					type: "enabled",
					budget_tokens: options.thinkingBudgetTokens || 1024,
					display: options.thinkingDisplay ?? "summarized",
				} as typeof params.thinking;
				if (mode === "anthropic-budget-effort" && effort) {
					params.output_config = { effort } as typeof params.output_config;
				}
			}
		} else if (options?.thinkingEnabled === false) {
			params.thinking = { type: "disabled" };
		}
	}

	const metadataUserId = resolveAnthropicMetadataUserId(options?.metadata?.user_id, isOAuthToken);
	if (metadataUserId) {
		params.metadata = { user_id: metadataUserId };
	}

	if (resolveServiceTier(options?.serviceTier, model.provider) === "priority") {
		(params as ParamsWithSpeed).speed = "fast";
	}

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			params.tool_choice = { type: options.toolChoice };
		} else if (isOAuthToken && options.toolChoice.name) {
			params.tool_choice = {
				...options.toolChoice,
				name: applyClaudeToolPrefix(options.toolChoice.name),
			};
		} else {
			params.tool_choice = options.toolChoice;
		}
	}

	const shouldInjectClaudeCodeInstruction = isOAuthToken && !model.id.startsWith("claude-3-5-haiku");
	const billingSystemPrompts = normalizeSystemPrompts(context.systemPrompt);
	const billingPayload = shouldInjectClaudeCodeInstruction
		? {
				...params,
				...(billingSystemPrompts.length > 0 ? { system: billingSystemPrompts } : {}),
			}
		: undefined;
	const systemBlocks = buildAnthropicSystemBlocks(context.systemPrompt, {
		includeClaudeCodeInstruction: shouldInjectClaudeCodeInstruction,
		billingPayload,
	});
	if (systemBlocks) {
		params.system = systemBlocks;
	}
	disableThinkingIfToolChoiceForced(params);
	ensureMaxTokensForThinking(params, model);
	applyPromptCaching(params, cacheControl);
	enforceCacheControlLimit(params, 4);
	normalizeCacheControlTtlOrdering(params);

	return params;
}

/**
 * Z.AI's Anthropic-compatible proxy at `api.z.ai/api/anthropic` deserializes
 * tool_result blocks into a Python class that accesses `.id`, even though
 * Anthropic's standard tool_result schema only carries `tool_use_id`. Detect
 * that endpoint so we can emit the non-standard alias for it without
 * polluting requests to api.anthropic.com or other compatible proxies.
 * See: https://github.com/can1357/gajae-code/issues/814
 */
function isZaiAnthropicEndpoint(model: Model<"anthropic-messages">): boolean {
	if (model.provider === "zai") return true;
	const baseUrl = model.baseUrl;
	if (!baseUrl) return false;
	try {
		return new URL(baseUrl).hostname.toLowerCase() === "api.z.ai";
	} catch {
		return false;
	}
}

/**
 * Returns true for providers whose Anthropic-compatible endpoints do NOT
 * implement signature-based thinking-chain integrity (DeepSeek, Z.AI, etc.).
 * For these providers, unsigned thinking blocks must be preserved as
 * `type: "thinking"` instead of being degraded to text.
 */
function isNonSigningAnthropicEndpoint(model: Model<"anthropic-messages">): boolean {
	// Known non-signing providers
	if (model.provider === "zai" || model.provider === "deepseek") return true;
	const baseUrl = model.baseUrl;
	if (!baseUrl) return false;
	try {
		const hostname = new URL(baseUrl).hostname.toLowerCase();
		return hostname === "api.deepseek.com" || hostname.endsWith(".deepseek.com");
	} catch {
		return false;
	}
}

function buildToolResultBlock(model: Model<"anthropic-messages">, msg: ToolResultMessage): ContentBlockParam {
	const block: ContentBlockParam = {
		type: "tool_result",
		tool_use_id: msg.toolCallId,
		content: convertContentBlocks(msg.content, model.input.includes("image")),
		is_error: msg.isError,
	};
	if (isZaiAnthropicEndpoint(model)) {
		// Z.AI workaround (issue #814): include `id` aliased to `tool_use_id`.
		(block as unknown as Record<string, unknown>).id = msg.toolCallId;
	}
	return block;
}

export function convertAnthropicMessages(
	messages: Message[],
	model: Model<"anthropic-messages">,
	isOAuthToken: boolean,
	options?: { repairLatestAssistantThinking?: boolean },
): MessageParam[] {
	const params: MessageParam[] = [];

	const transformedMessages = transformMessages(messages, model, normalizeToolCallId, options);

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (msg.role === "user" || msg.role === "developer") {
			if (!msg.content) continue;

			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) {
					params.push({
						role: "user",
						content: msg.content.toWellFormed(),
					});
				}
			} else {
				const contentBlocks = convertContentBlocks(msg.content, model.input.includes("image"));
				if (typeof contentBlocks === "string") {
					if (contentBlocks.trim().length === 0) continue;
					params.push({
						role: "user",
						content: contentBlocks,
					});
					continue;
				}
				if (contentBlocks.length === 0) continue;
				params.push({
					role: "user",
					content: contentBlocks,
				});
			}
		} else if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];
			const hasSignedThinking = msg.content.some(
				block =>
					block.type === "thinking" && !!block.thinkingSignature && block.thinkingSignature.trim().length > 0,
			);

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({
						type: "text",
						text: block.text.toWellFormed(),
					});
				} else if (block.type === "thinking") {
					if (hasSignedThinking) {
						if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
							if (block.thinking.trim().length === 0) continue;
							blocks.push({
								type: "text",
								text: block.thinking.toWellFormed(),
							});
							continue;
						}
						blocks.push({
							type: "thinking",
							thinking: block.thinking,
							signature: block.thinkingSignature,
						});
						continue;
					}
					if (block.thinking.trim().length === 0) continue;
					if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
						if (isNonSigningAnthropicEndpoint(model)) {
							blocks.push({
								type: "thinking",
								thinking: block.thinking.toWellFormed(),
								signature: "",
							});
						} else {
							blocks.push({
								type: "text",
								text: block.thinking.toWellFormed(),
							});
						}
					} else {
						blocks.push({
							type: "thinking",
							thinking: block.thinking.toWellFormed(),
							signature: block.thinkingSignature,
						});
					}
				} else if (block.type === "redactedThinking") {
					if (block.data.trim().length === 0) continue;
					blocks.push({
						type: "redacted_thinking",
						data: block.data,
					});
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: isOAuthToken ? applyClaudeToolPrefix(block.name) : block.name,
						input: block.arguments ?? {},
					});
				}
			}
			if (blocks.length === 0) continue;
			params.push({
				role: "assistant",
				content: blocks,
			});
		} else if (msg.role === "toolResult") {
			// Collect all consecutive toolResult messages, needed for z.ai Anthropic endpoint
			const toolResults: ContentBlockParam[] = [];

			// Add the current tool result
			toolResults.push(buildToolResultBlock(model, msg));

			// Look ahead for consecutive toolResult messages
			let j = i + 1;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const nextMsg = transformedMessages[j] as ToolResultMessage; // We know it's a toolResult
				toolResults.push(buildToolResultBlock(model, nextMsg));
				j++;
			}

			// Skip the messages we've already processed
			i = j - 1;

			// Add a single user message with all tool results
			params.push({
				role: "user",
				content: toolResults,
			});
		}
	}

	if (params.length > 0 && params[params.length - 1]?.role === "assistant") {
		params.push({ role: "user", content: "Continue." });
	}

	return params;
}

/**
 * JSON Schema whitelist for Anthropic tool `input_schema` nodes.
 *
 * Mirrors the Anthropic Python SDK's `lib/_parse/_transform.py::transform_schema`:
 * we keep only structural/metadata keywords Anthropic's validator honors, and demote
 * anything else into the node's `description` as `\n\n{key: value, ...}` so the model
 * still sees the constraint as a natural-language hint.
 *
 * `Set` (not `Record<string, true>`) because membership is probed against arbitrary
 * user/Zod-derived schema keys: a literal Record would falsely match prototype names
 * like `"toString"` and silently strip valid properties.
 */
const ANTHROPIC_TOOL_SCHEMA_UNIVERSAL_KEEP = new Set([
	"$ref",
	"$defs",
	"$schema",
	"definitions",
	"type",
	"anyOf",
	"oneOf",
	"allOf",
	"enum",
	"const",
	"description",
	"title",
	"default",
	"nullable",
]);
/** Keys preserved on `type: "object"` nodes (in addition to the universal set). */
const ANTHROPIC_TOOL_SCHEMA_OBJECT_KEEP = new Set(["properties", "required", "additionalProperties"]);
/** Keys preserved on `type: "array"` nodes; `minItems` only when its value is 0 or 1. */
const ANTHROPIC_TOOL_SCHEMA_ARRAY_KEEP = new Set(["items", "prefixItems", "minItems"]);
/** Keys preserved on `type: "string"` nodes; `format` only when its value is in the supported list. */
const ANTHROPIC_TOOL_SCHEMA_STRING_KEEP = new Set(["format"]);
/**
 * String `format` values Anthropic accepts; everything else (including `pattern`-style
 * format hints) gets demoted into `description`. Matches `SupportedStringFormats` in the
 * Anthropic SDK's `_transform.py`.
 */
const ANTHROPIC_TOOL_SCHEMA_STRING_FORMATS = new Set([
	"date-time",
	"time",
	"date",
	"duration",
	"email",
	"hostname",
	"uri",
	"ipv4",
	"ipv6",
	"uuid",
]);
const ANTHROPIC_STRICT_TOOL_ALLOWLIST = new Set(["bash", "python", "edit", "find"]);
const MAX_ANTHROPIC_STRICT_TOOLS = 20;
const MAX_ANTHROPIC_STRICT_OPTIONAL_PARAMETERS = 24;
const MAX_ANTHROPIC_STRICT_UNION_PARAMETERS = 16;

/** `minItems` / `maxItems` apply to arrays; Anthropic rejects them on `type: "object"` (including `minItems: 0`/`1`). */
function isJsonSchemaArrayNode(schema: Record<string, unknown>): boolean {
	const t = schema.type;
	if (t === "array") return true;
	if (Array.isArray(t) && t.includes("array") && !t.includes("object")) return true;
	return false;
}

function isJsonSchemaObjectNode(schema: Record<string, unknown>): boolean {
	if (isJsonSchemaArrayNode(schema)) return false;
	if (schema.type === "object") return true;
	if (Array.isArray(schema.type) && schema.type.includes("object")) return true;
	if (isRecord(schema.properties)) return true;
	return false;
}

/**
 * Pick the principal non-null scalar type from a `type` keyword. Anthropic accepts
 * `type` as either a single string or an array (e.g. `["number", "null"]` for a
 * nullable value); the SDK whitelist is keyed off the scalar type, with `"null"`
 * ignored so nullable variants are normalized as their underlying type.
 */
function pickAnthropicScalarType(type: unknown): string | undefined {
	if (typeof type === "string") return type;
	if (Array.isArray(type)) {
		for (const entry of type) {
			if (typeof entry === "string" && entry !== "null") return entry;
		}
	}
	return undefined;
}

function anthropicPerTypeKeep(scalarType: string | undefined): Set<string> | undefined {
	switch (scalarType) {
		case "object":
			return ANTHROPIC_TOOL_SCHEMA_OBJECT_KEEP;
		case "array":
			return ANTHROPIC_TOOL_SCHEMA_ARRAY_KEEP;
		case "string":
			return ANTHROPIC_TOOL_SCHEMA_STRING_KEEP;
		default:
			return undefined;
	}
}

/**
 * Per-schema-object memoization slot for the normalized Anthropic tool form. We stamp
 * the result onto the host via a `Symbol` property (mirroring `utils/schema/stamps.ts`)
 * instead of using a `WeakMap`: it's a single hidden-class slot, so warm reads are
 * direct property access and write-once cycles resolve to the in-progress result.
 */
const kAnthropicToolNormal = Symbol("pi.schema.anthropic.toolNormal");

/**
 * Normalize a JSON Schema node for Anthropic tool `input_schema`.
 *
 * Applies the full whitelist semantics from the Anthropic Python SDK's
 * `lib/_parse/_transform.py::transform_schema`:
 *
 * 1. Universal keys (`$ref`, `$defs`, `type`, `anyOf`/`oneOf`/`allOf`, `enum`, `const`,
 *    `description`, `title`, `default`, `nullable`) are preserved on every node.
 * 2. Per-type keys are kept additively (object → `properties`/`required`/`additionalProperties`,
 *    array → `items`/`prefixItems` plus `minItems` only when 0 or 1, string → `format`
 *    only when in the supported value set).
 * 3. Everything else is demoted into the node's `description` as `\n\n{key: value, ...}`
 *    so the model still sees the constraint as a natural-language hint.
 *
 * Object nodes default to `additionalProperties: false`, but explicit open-map
 * declarations (`additionalProperties: true` or a schema literal — Zod's
 * `z.record(z.string(), z.unknown())` produces `{}`) are preserved. The strict-mode
 * pass downstream demotes those shapes to non-strict instead of fabricating a closed
 * object, so callers like the resolve tool keep working open-map semantics.
 */
export function normalizeAnthropicToolSchema(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(entry => normalizeAnthropicToolSchema(entry));
	if (!isRecord(schema)) return schema;

	const slot = schema as Record<symbol, Record<string, unknown> | undefined>;
	const existing = slot[kAnthropicToolNormal];
	if (existing !== undefined) return existing;

	const result: Record<string, unknown> = {};
	// Pre-stamp before recursion so cyclic schemas resolve to the in-progress object
	// (mirrors the WeakMap-set-before-recurse pattern the original implementation used).
	Object.defineProperty(schema, kAnthropicToolNormal, { value: result, writable: true, configurable: true });

	const scalarType = pickAnthropicScalarType(schema.type);
	const perTypeKeep = anthropicPerTypeKeep(scalarType);
	const spill: Array<[string, unknown]> = [];

	for (const key in schema) {
		if (!Object.hasOwn(schema, key)) continue;
		const value = schema[key];
		if (ANTHROPIC_TOOL_SCHEMA_UNIVERSAL_KEEP.has(key) || perTypeKeep?.has(key)) {
			result[key] = value;
		} else {
			spill.push([key, value]);
		}
	}

	// Per-type conditional keys: prune within the kept set.
	if (scalarType === "string") {
		const format = result.format;
		if (typeof format === "string" && !ANTHROPIC_TOOL_SCHEMA_STRING_FORMATS.has(format)) {
			spill.push(["format", format]);
			delete result.format;
		}
	}
	if (scalarType === "array" && result.minItems !== undefined) {
		const minItems = result.minItems;
		if (!(typeof minItems === "number" && (minItems === 0 || minItems === 1))) {
			spill.push(["minItems", minItems]);
			delete result.minItems;
		}
	}
	if (scalarType === "object" && result.additionalProperties === undefined) {
		result.additionalProperties = false;
	}

	// Recurse on structural keys.
	if (isRecord(result.properties)) {
		const normalizedProperties: Record<string, unknown> = {};
		const sourceProperties = result.properties as Record<string, unknown>;
		for (const propName in sourceProperties) {
			if (!Object.hasOwn(sourceProperties, propName)) continue;
			normalizedProperties[propName] = normalizeAnthropicToolSchema(sourceProperties[propName]);
		}
		result.properties = normalizedProperties;
	}
	if (isRecord(result.additionalProperties)) {
		const normalized = normalizeAnthropicToolSchema(result.additionalProperties);
		if (isRecord(normalized) && Object.keys(normalized).length === 0) {
			result.additionalProperties = true;
		} else {
			result.additionalProperties = normalized;
		}
	}
	if (Array.isArray(result.items)) {
		result.items = result.items.map(item => normalizeAnthropicToolSchema(item));
	} else if (isRecord(result.items)) {
		result.items = normalizeAnthropicToolSchema(result.items);
	}
	if (Array.isArray(result.prefixItems)) {
		result.prefixItems = result.prefixItems.map(item => normalizeAnthropicToolSchema(item));
	}
	for (const key of COMBINATOR_KEYS) {
		const variants = result[key];
		if (Array.isArray(variants)) {
			result[key] = variants.map(variant => normalizeAnthropicToolSchema(variant));
		}
	}
	for (const defsKey of ["$defs", "definitions"] as const) {
		const definitions = result[defsKey];
		if (!isRecord(definitions)) continue;
		const normalizedDefs: Record<string, unknown> = {};
		const sourceDefs = definitions as Record<string, unknown>;
		for (const name in sourceDefs) {
			if (!Object.hasOwn(sourceDefs, name)) continue;
			normalizedDefs[name] = normalizeAnthropicToolSchema(sourceDefs[name]);
		}
		result[defsKey] = normalizedDefs;
	}

	spillToDescription(result, spill);
	return result;
}

type AnthropicToolInputSchema = Anthropic.Messages.Tool["input_schema"];

type AnthropicToolSchemaPlan = {
	inputSchema: AnthropicToolInputSchema;
	strict: boolean;
};

type AnthropicStrictBudget = {
	optionalRemaining: number;
	unionRemaining: number;
	optionalCount: number;
	unionCount: number;
};

function hasAnthropicUnionType(schema: Record<string, unknown>): boolean {
	return Array.isArray(schema.type) || Array.isArray(schema.anyOf);
}

function hasNullVariant(schema: Record<string, unknown>): boolean {
	if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
	return Array.isArray(schema.anyOf) && schema.anyOf.some(variant => isRecord(variant) && variant.type === "null");
}

function makeAnthropicNullableSchema(schema: unknown, budget: AnthropicStrictBudget): unknown | undefined {
	if (isRecord(schema)) {
		if (hasNullVariant(schema)) return schema;
		if (Array.isArray(schema.anyOf)) {
			return { ...schema, anyOf: [...schema.anyOf, { type: "null" }] };
		}
		if (Array.isArray(schema.type)) {
			return { ...schema, type: [...schema.type, "null"] };
		}
	}

	if (budget.unionRemaining <= 0) return undefined;
	budget.unionRemaining--;
	budget.unionCount++;
	return { anyOf: [schema, { type: "null" }] };
}

function normalizeAnthropicStrictSchemaNode(
	schema: unknown,
	budget: AnthropicStrictBudget,
	cache: WeakMap<Record<string, unknown>, Record<string, unknown>>,
): unknown | undefined {
	if (Array.isArray(schema)) {
		const result: unknown[] = [];
		for (const entry of schema) {
			const normalized = normalizeAnthropicStrictSchemaNode(entry, budget, cache);
			if (normalized === undefined) return undefined;
			result.push(normalized);
		}
		return result;
	}

	if (!isRecord(schema)) return schema;

	const cached = cache.get(schema);
	if (cached) return cached;

	// Strict tool use only supports closed objects. Open maps stay available on
	// the non-strict schema plan instead of producing an Anthropic 400.
	if (isJsonSchemaObjectNode(schema) && schema.additionalProperties !== false) {
		return undefined;
	}

	const result: Record<string, unknown> = { ...schema };
	cache.set(schema, result);

	if (hasAnthropicUnionType(result)) {
		if (budget.unionRemaining <= 0) return undefined;
		budget.unionRemaining--;
		budget.unionCount++;
	}

	if (isRecord(result.properties)) {
		const originalRequired = new Set(
			Array.isArray(result.required)
				? result.required.filter((entry): entry is string => typeof entry === "string")
				: [],
		);
		const properties: Record<string, unknown> = {};
		const required: string[] = [];

		for (const [propertyName, propertySchema] of Object.entries(result.properties)) {
			const normalizedProperty = normalizeAnthropicStrictSchemaNode(propertySchema, budget, cache);
			if (normalizedProperty === undefined) return undefined;

			if (originalRequired.has(propertyName)) {
				properties[propertyName] = normalizedProperty;
				required.push(propertyName);
				continue;
			}

			if (budget.optionalRemaining > 0) {
				budget.optionalRemaining--;
				budget.optionalCount++;
				properties[propertyName] = normalizedProperty;
				continue;
			}

			const nullableProperty = makeAnthropicNullableSchema(normalizedProperty, budget);
			if (nullableProperty === undefined) return undefined;
			properties[propertyName] = nullableProperty;
			required.push(propertyName);
		}

		result.properties = properties;
		result.required = required;
	}

	if (Array.isArray(result.items)) {
		const items = normalizeAnthropicStrictSchemaNode(result.items, budget, cache);
		if (items === undefined) return undefined;
		result.items = items;
	} else if (isRecord(result.items)) {
		const items = normalizeAnthropicStrictSchemaNode(result.items, budget, cache);
		if (items === undefined) return undefined;
		result.items = items;
	}
	if (Array.isArray(result.prefixItems)) {
		const prefixItems = normalizeAnthropicStrictSchemaNode(result.prefixItems, budget, cache);
		if (prefixItems === undefined) return undefined;
		result.prefixItems = prefixItems;
	}

	for (const key of COMBINATOR_KEYS) {
		const variants = result[key];
		if (!Array.isArray(variants)) continue;
		const normalizedVariants = normalizeAnthropicStrictSchemaNode(variants, budget, cache);
		if (normalizedVariants === undefined) return undefined;
		result[key] = normalizedVariants;
	}

	for (const defsKey of ["$defs", "definitions"] as const) {
		const definitions = result[defsKey];
		if (!isRecord(definitions)) continue;
		const normalizedDefinitions: Record<string, unknown> = {};
		for (const [definitionName, definitionSchema] of Object.entries(definitions)) {
			const normalizedDefinition = normalizeAnthropicStrictSchemaNode(definitionSchema, budget, cache);
			if (normalizedDefinition === undefined) return undefined;
			normalizedDefinitions[definitionName] = normalizedDefinition;
		}
		result[defsKey] = normalizedDefinitions;
	}

	return result;
}

function normalizeAnthropicStrictSchema(
	schema: Record<string, unknown>,
	optionalRemaining: number,
	unionRemaining: number,
): { schema: Record<string, unknown>; optionalCount: number; unionCount: number } | undefined {
	const budget: AnthropicStrictBudget = {
		optionalRemaining,
		unionRemaining,
		optionalCount: 0,
		unionCount: 0,
	};
	const normalized = normalizeAnthropicStrictSchemaNode(schema, budget, new WeakMap());
	if (!isRecord(normalized)) return undefined;
	return { schema: normalized, optionalCount: budget.optionalCount, unionCount: budget.unionCount };
}

function buildAnthropicBaseToolInputSchema(tool: Tool): Record<string, unknown> {
	const jsonSchema = toolWireSchema(tool);
	return normalizeAnthropicToolSchema({
		...jsonSchema,
		type: "object",
		properties: isRecord(jsonSchema.properties) ? jsonSchema.properties : {},
		required: Array.isArray(jsonSchema.required)
			? jsonSchema.required.filter((entry): entry is string => typeof entry === "string")
			: [],
	}) as Record<string, unknown>;
}

function buildAnthropicToolSchemaPlans(tools: Tool[], disableStrictTools = false): AnthropicToolSchemaPlan[] {
	const plans = tools.map(
		(tool): AnthropicToolSchemaPlan => ({
			inputSchema: buildAnthropicBaseToolInputSchema(tool) as AnthropicToolInputSchema,
			strict: false,
		}),
	);
	if (NO_STRICT || disableStrictTools) return plans;

	const candidateIndexes = tools.flatMap((tool, index) => {
		if (!ANTHROPIC_STRICT_TOOL_ALLOWLIST.has(tool.name)) return [];
		return tool.strict === false ? [] : [index];
	});

	let strictToolCount = 0;
	let strictOptionalParameterCount = 0;
	let strictUnionParameterCount = 0;
	for (const index of candidateIndexes) {
		if (strictToolCount >= MAX_ANTHROPIC_STRICT_TOOLS) break;

		const strictResult = normalizeAnthropicStrictSchema(
			plans[index].inputSchema as Record<string, unknown>,
			MAX_ANTHROPIC_STRICT_OPTIONAL_PARAMETERS - strictOptionalParameterCount,
			MAX_ANTHROPIC_STRICT_UNION_PARAMETERS - strictUnionParameterCount,
		);
		if (!strictResult) continue;

		plans[index] = {
			inputSchema: strictResult.schema as AnthropicToolInputSchema,
			strict: true,
		};
		strictToolCount++;
		strictOptionalParameterCount += strictResult.optionalCount;
		strictUnionParameterCount += strictResult.unionCount;
	}

	return plans;
}

function convertTools(
	tools: Tool[],
	isOAuthToken: boolean,
	disableStrictTools = false,
	supportsEagerToolInputStreaming = true,
): Anthropic.Messages.Tool[] {
	if (!tools) return [];
	const schemaPlans = buildAnthropicToolSchemaPlans(tools, disableStrictTools);

	return tools.map((tool, index) => {
		const plan = schemaPlans[index];
		return {
			name: isOAuthToken ? applyClaudeToolPrefix(tool.name) : tool.name,
			description: tool.description || "",
			input_schema: plan.inputSchema,
			...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
			...(plan.strict ? { strict: true } : {}),
		};
	});
}

function mapStopReason(reason: Anthropic.Messages.StopReason | string): StopReason {
	switch (reason) {
		case "end_turn":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		case "refusal":
			return "error";
		case "pause_turn": // Stop is good enough -> resubmit
			return "stop";
		case "stop_sequence":
			return "stop"; // We don't supply stop sequences, so this should never happen
		case "sensitive": // Content flagged by safety filters (not yet in SDK types)
			return "error";
		default:
			// Handle unknown stop reasons gracefully (API may add new values)
			throw new Error(`Unhandled stop reason: ${reason}`);
	}
}

import * as nodeCrypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
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
	$credentialEnv,
	$env,
	extractHttpStatusFromError,
	isEnoent,
	isRetryableError,
	isUnexpectedSocketCloseMessage,
	logger,
	readSseEvents,
} from "@gajae-code/utils";
import {
	isProviderSafetyStopAdapterInvocation,
	mintProviderSafetyStop,
	PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY,
} from "../adapter-internals/provider-safety-stop";
import {
	hasOpus47ApiRestrictions,
	mapEffortToAnthropicAdaptiveEffort,
	supportsAnthropicAdaptiveThinkingDisplay as supportsAdaptiveThinkingDisplay,
} from "../model-thinking";
import { calculateCost } from "../models";
import { isUsageLimitError } from "../rate-limit-utils";
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
	sanitizeJsonStrings,
} from "../utils";
import { createAbortSourceTracker } from "../utils/abort";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { transportFailureFacts } from "../utils/fallback-transport";
import { isFoundryEnabled } from "../utils/foundry";
import { finalizeErrorMessage, type RawHttpRequestDump, rewriteCopilotError } from "../utils/http-inspector";
import {
	FirstEventTimeoutError,
	getProviderFirstEventTimeoutFallbackMs,
	getProviderStreamIdleTimeoutFallbackMs,
	getStreamFirstEventTimeoutMs,
	getStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
	resolveAnthropicSdkRequestTimeoutMs,
} from "../utils/idle-iterator";
import {
	captureUnicodeEscapeEvidence,
	isCompleteJson,
	parseJsonWithRepair,
	parseStreamingJson,
} from "../utils/json-parse";
import { parseGitHubCopilotApiKey } from "../utils/oauth/github-copilot";
import { GLM_ZCODE_ANTHROPIC_BASE_URL } from "../utils/oauth/glm-zcode";
import { notifyProviderResponse } from "../utils/provider-response";
import { isCopilotTransientModelError } from "../utils/retry";
import { getRetryAfterMsFromHeaders } from "../utils/retry-after";
import { resolveRetryBudget } from "../utils/retry-budget";
import {
	COMBINATOR_KEYS,
	flattenToolRootCombinators,
	isJsonSchemaObjectNode,
	NO_STRICT,
	toolWireSchema,
} from "../utils/schema";
import { spillToDescription } from "../utils/schema/spill";
import { notifyRawSseEvent, wrapFetchForSseDebug } from "../utils/sse-debug";
import {
	isForcedToolChoiceUnsupportedError,
	markToolChoiceIncapability,
	type ResolveToolChoiceResult,
	resolveToolChoice,
} from "../utils/tool-choice-capability";
import {
	buildCopilotDynamicHeaders,
	hasCopilotVisionInput,
	resolveGitHubCopilotBaseUrl,
} from "./github-copilot-headers";
import { hasAdjacentPrivateThinkingBlocks, transformMessages } from "./transform-messages";
import { NON_VISION_IMAGE_PLACEHOLDER } from "./vision-guard";

export type AnthropicHeaderOptions = {
	apiKey: string;
	baseUrl?: string;
	isOAuth?: boolean;
	extraBetas?: string[];
	stream?: boolean;
	modelHeaders?: Record<string, string>;
	isCloudflareAiGateway?: boolean;
	/**
	 * Attach ZCode client "source" headers (User-Agent: ZCode/<ver>, X-Title,
	 * X-ZCode-Agent: glm, X-Platform, etc.) so api.z.ai recognizes the caller as
	 * the ZCode client, exactly like ZCode's `buildZCodeSourceHeaders` does for
	 * GLM providers. glm-zcode only.
	 */
	zcodeSourceHeaders?: boolean;
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

// ZCode bakes its app version and runtime env at build time. Mirror the values
// from the analyzed ZCode 3.1.2 desktop bundle (`resolveRuntimeZCodeEnv` returns
// "production" for non-test builds). Both are overridable for forward-compat.
const ZCODE_APP_VERSION = process.env.ZCODE_APP_VERSION?.trim() || "3.1.2";
const ZCODE_RELEASE_CHANNEL = process.env.ZCODE_RELEASE_CHANNEL?.trim() || "production";

// Mirrors ZCode's `normalizePrintableHeaderValue`: only printable ASCII passes.
function normalizePrintableHeaderValue(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (trimmed && /^[\x20-\x7e]+$/.test(trimmed)) return trimmed;
	return undefined;
}

// Mirrors ZCode's `normalizeOsCategory`.
function normalizeOsCategory(platform: NodeJS.Platform): string {
	switch (platform) {
		case "darwin":
			return "macos";
		case "win32":
			return "windows";
		default:
			return "linux";
	}
}

/**
 * Replicates ZCode's `buildZCodeSourceHeaders()` + GLM `X-ZCode-Agent` tag
 * (host bundle `Bl` / `buildConnectivitySourceHeaders` for GLM providers), so
 * api.z.ai sees gjc's glm-zcode requests as the ZCode client. Dynamic values
 * (platform/arch, locale, timezone, OS version) are resolved at runtime exactly
 * as ZCode does; printable-ASCII-only and conditionally omitted when empty.
 */
export function buildZCodeSourceHeaders(): Record<string, string> {
	const platform = process.platform;
	const arch = process.arch;
	const appVersion = normalizePrintableHeaderValue(ZCODE_APP_VERSION);
	const releaseChannel = normalizePrintableHeaderValue(ZCODE_RELEASE_CHANNEL);
	let locale: string | undefined;
	let timezone: string | undefined;
	try {
		const resolved = Intl.DateTimeFormat().resolvedOptions();
		locale = normalizePrintableHeaderValue(resolved.locale);
		timezone = normalizePrintableHeaderValue(resolved.timeZone);
	} catch {}
	const osVersion = normalizePrintableHeaderValue(os.version());
	const headers: Record<string, string> = {
		"User-Agent": `ZCode/${appVersion ?? "unknown"}`,
		"HTTP-Referer": "https://zcode.z.ai",
		"X-Title": "Z Code@electron",
		"X-Platform": `${platform}-${arch}`,
		"X-Client-Language": locale ?? "unknown",
		"X-Client-Timezone": timezone ?? "unknown",
		"X-Os-Category": normalizeOsCategory(platform),
		"X-ZCode-Agent": "glm",
	};
	if (appVersion) headers["X-ZCode-App-Version"] = appVersion;
	if (releaseChannel) headers["X-Release-Channel"] = releaseChannel;
	if (osVersion) headers["X-Os-Version"] = osVersion;
	return headers;
}

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
		const incomingUserAgent = getHeaderCaseInsensitive(options.modelHeaders, "User-Agent");
		// ZCode merges its source headers LAST for GLM providers (`withZCodeSourceHeaders`
		// → `{ ...base, ...extra, ...source }`), so they win over any incoming User-Agent.
		const zcodeSourceHeaders = options.zcodeSourceHeaders ? buildZCodeSourceHeaders() : undefined;
		return {
			...modelHeaders,
			Accept: acceptHeader,
			Authorization: `Bearer ${options.apiKey}`,
			...sharedHeaders,
			"Anthropic-Beta": betaHeader,
			...(incomingUserAgent ? { "User-Agent": incomingUserAgent } : {}),
			...(zcodeSourceHeaders ?? {}),
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

const ANTHROPIC_PROVIDER_SESSION_STATE_KEY = "anthropic-messages";

/**
 * Scope of a classified replayed-thinking repair currently applied to this
 * session: `latest` drops native thinking from the newest assistant turn, `all`
 * stops replaying native thinking entirely. Persisted across stream
 * re-invocations so a repair that keeps being rejected is not re-attempted from
 * scratch on every turn (issue #4011), and released again by the first stream
 * that completes. Unclassifiable masked `api_error` repairs remain local to the
 * current stream invocation because a transient masked failure must not degrade
 * later turns.
 */
type AnthropicThinkingReplayRepairScope = "none" | "latest" | "all";

/**
 * Repairs are bounded independently of `PROVIDER_MAX_RETRIES` because they do
 * not consume the provider retry budget: without their own ceiling an
 * unacceptable request shape retries forever (issue #4011). The ceiling spans
 * the session rather than a single stream, and only a completed stream re-arms
 * it — an unacceptable shape never completes, so it can never buy more repairs.
 */
const ANTHROPIC_MAX_THINKING_REPAIRS = 1;

type AnthropicPayloadFingerprint = {
	sha256: string;
	bytes: number;
};

type AnthropicThinkingRepairCandidate = {
	scope: Exclude<AnthropicThinkingReplayRepairScope, "none">;
	params: MessageCreateParamsStreaming;
	fingerprint: AnthropicPayloadFingerprint;
};

type AnthropicProviderSessionState = ProviderSessionState & {
	strictToolsDisabled: boolean;
	fastModeDisabled: boolean;
	generatedCacheBudget: GeneratedCacheBudget;
	thinkingReplayRepairScope: AnthropicThinkingReplayRepairScope;
	thinkingReplayRepairAttempts: number;
	thinkingReplayRejectedPayload?: AnthropicPayloadFingerprint;
	/**
	 * Managed-mode escalation for the CPA alias-restore failure (issue #4338):
	 * corrective steering recorded against one exact turn, applied by the next
	 * managed attempt that rebuilds the same turn and released on success.
	 */
	cpaToolAliasSteering?: AnthropicCpaToolAliasSteering;
};

type AnthropicCpaToolAliasSteering = {
	/** Corrective steering text appended to the next build of the same turn. */
	message: string;
	/**
	 * Fingerprint of the last user message when the failure was recorded. The
	 * steering only applies to a rebuild of the same logical turn; a later turn
	 * with a different prompt expires it instead of replaying a stale
	 * correction.
	 */
	turnFingerprint: string;
};

function createAnthropicProviderSessionState(): AnthropicProviderSessionState {
	const state: AnthropicProviderSessionState = {
		strictToolsDisabled: false,
		fastModeDisabled: false,
		generatedCacheBudget: 2,
		thinkingReplayRepairScope: "none",
		thinkingReplayRepairAttempts: 0,
		close: () => {
			state.strictToolsDisabled = false;
			state.fastModeDisabled = false;
			state.generatedCacheBudget = 2;
			state.thinkingReplayRepairScope = "none";
			state.thinkingReplayRepairAttempts = 0;
			state.thinkingReplayRejectedPayload = undefined;
			state.cpaToolAliasSteering = undefined;
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

/**
 * Proxies (e.g. CLIProxyAPI) can deliver Anthropic's 400 body as an in-stream
 * SSE `error` event on an HTTP 200 response; the thrown error then carries no
 * HTTP status at all (issue #3900). Accept both the direct 400 and the
 * statusless SSE shape — the strict `invalid_request_error` message checks in
 * each matcher keep the statusless branch from claiming unrelated failures.
 */
function isAnthropicInvalidRequestStatus(error: unknown): boolean {
	const status = extractHttpStatusFromError(error);
	return status === 400 || status === undefined;
}

export function isAnthropicThinkingBlockMutationError(error: unknown): boolean {
	if (!isAnthropicInvalidRequestStatus(error)) return false;
	const message = error instanceof Error ? error.message : String(error);
	return (
		/invalid_request_error/i.test(message) &&
		/thinking|redacted_thinking/i.test(message) &&
		/latest assistant message/i.test(message) &&
		/cannot be modified/i.test(message)
	);
}

/**
 * 400 shape where a replayed `thinking`/`redacted_thinking` block fails signature
 * validation, e.g. `messages.5.content.24: Invalid \`signature\` in \`thinking\` block`.
 * Unlike the latest-assistant mutation error above, the cited block can sit anywhere
 * in the replayed history, so recovery must repair every assistant message rather
 * than only the latest one.
 */
export function isAnthropicThinkingSignatureInvalidError(error: unknown): boolean {
	if (!isAnthropicInvalidRequestStatus(error)) return false;
	const message = error instanceof Error ? error.message : String(error);
	return (
		/invalid_request_error/i.test(message) &&
		/thinking|redacted_thinking/i.test(message) &&
		/invalid\s+`?signature`?/i.test(message)
	);
}

/**
 * CLIProxyAPI replaces Anthropic's rejection body wholesale instead of forwarding
 * it: the client only ever sees
 * `{"type":"error","error":{"type":"api_error","message":"An error occurred while
 * processing the request."}}`, delivered as an in-stream SSE `error` event on an
 * HTTP 200 response, so neither the status nor the message survives. Captured CPA
 * traces for that masked shape carry the thinking-integrity 400 upstream (issue
 * #3900), and the generic body matches no transient phrase either, so the turn
 * dies unrecoverably. Nothing in the payload names the cause; callers must pair
 * this with a request that actually replays signed thinking blocks before
 * treating it as a thinking-replay rejection.
 */
export function isAnthropicMaskedProxyRejection(error: unknown): boolean {
	const status = extractHttpStatusFromError(error);
	if (status !== undefined && status !== 400) return false;
	const message = error instanceof Error ? error.message : String(error);
	// A body that still names its error type is classified by the strict matchers.
	if (/invalid_request_error/i.test(message)) return false;
	return /"type"\s*:\s*"api_error"/.test(message) && /an error occurred while processing/i.test(message);
}

function fingerprintAnthropicPayload(params: MessageCreateParamsStreaming): AnthropicPayloadFingerprint {
	const body = JSON.stringify({ ...params, stream: true });
	return {
		sha256: nodeCrypto.createHash("sha256").update(body).digest("hex"),
		bytes: Buffer.byteLength(body),
	};
}

function anthropicPayloadChanged(left: AnthropicPayloadFingerprint, right: AnthropicPayloadFingerprint): boolean {
	return left.bytes !== right.bytes || left.sha256 !== right.sha256;
}

function extractAnthropicCitedContentPath(error: unknown): { messageIndex: number; contentIndex: number } | undefined {
	const message = error instanceof Error ? error.message : String(error);
	const match = /messages\.(\d+)\.content\.(\d+)/i.exec(message);
	if (!match) return undefined;
	return { messageIndex: Number(match[1]), contentIndex: Number(match[2]) };
}

function countNativeThinkingBlocks(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	return content.filter(block => {
		if (!isRecord(block)) return false;
		return block.type === "thinking" || block.type === "redacted_thinking";
	}).length;
}

function describeAnthropicOutgoingPath(error: unknown, params: MessageCreateParamsStreaming): string {
	const cited = extractAnthropicCitedContentPath(error);
	const messages = params.messages;
	let latestAssistantIndex = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === "assistant") {
			latestAssistantIndex = index;
			break;
		}
	}
	const latest = latestAssistantIndex >= 0 ? messages[latestAssistantIndex] : undefined;
	const latestThinking = countNativeThinkingBlocks(latest?.content);
	const latestDescription =
		latest === undefined
			? "GJC's outgoing request has no assistant message"
			: `GJC's latest outgoing assistant message is messages[${latestAssistantIndex}] with ${latestThinking} native thinking block(s)`;
	if (!cited) return `${latestDescription}; the rejection did not contain a messages.N.content.M path`;
	const outgoing = messages[cited.messageIndex];
	if (!outgoing) {
		return `Anthropic cited messages.${cited.messageIndex}.content.${cited.contentIndex}, but GJC's outgoing request has only ${messages.length} messages; ${latestDescription}`;
	}
	const contentBlocks = Array.isArray(outgoing.content) ? outgoing.content.length : 1;
	return `Anthropic cited messages.${cited.messageIndex}.content.${cited.contentIndex}, but GJC's outgoing messages[${cited.messageIndex}] has role=${outgoing.role} and ${contentBlocks} content block(s); ${latestDescription}`;
}

function createAnthropicThinkingRepairNoopError(
	error: unknown,
	params: MessageCreateParamsStreaming,
	fingerprint: AnthropicPayloadFingerprint,
	capturedDiagnostic?: string,
): Error {
	const diagnostic = describeAnthropicOutgoingPath(error, params);
	const terminal = new Error(
		`Anthropic thinking-replay repair was not sent because both latest-assistant and all-assistant transforms produced the same ${fingerprint.bytes}-byte payload (sha256=${fingerprint.sha256}). ${diagnostic}. GJC did not resend the rejected body and did not change thinking mode.${capturedDiagnostic ? `\n${capturedDiagnostic}` : ""}`,
	);
	const status = extractHttpStatusFromError(error);
	if (status !== undefined) (terminal as Error & { status?: number }).status = status;
	(terminal as Error & { anthropicHttp400AlreadyCaptured?: boolean }).anthropicHttp400AlreadyCaptured = true;
	return terminal;
}

/**
 * Anthropic rejects a request carrying more than four `cache_control`
 * breakpoints. An Anthropic-compatible gateway may attach its own block-level
 * markers before forwarding, and those never appear in the params we serialize,
 * so no amount of local counting can predict the total. The rejection is the
 * only evidence that our generated marker is one too many, and it is worth
 * exactly one retry with generated caching suppressed.
 *
 * Our own pre-flight `validateCacheControls` failure is deliberately not
 * matched: it carries no `invalid_request_error` wording, so a local bug stays
 * loud instead of being silently retried.
 */
export function isAnthropicCacheBreakpointOverflowError(error: unknown): boolean {
	if (!isAnthropicInvalidRequestStatus(error)) return false;
	const message = error instanceof Error ? error.message : String(error);
	if (!/invalid_request_error/i.test(message)) return false;
	if (!/cache_control/i.test(message)) return false;
	// Observed: "A maximum of 4 blocks with cache_control may be provided. Found 5."
	// Stay tolerant of phrasing drift around the limit and the reported total.
	return /maximum of \d+ blocks/i.test(message) || /at most \d+ blocks/i.test(message);
}

export type AnthropicContextManagementInjectionDiagnostic = {
	strategy: string;
	message: string;
	captureNote: string;
};

const CLEAR_THINKING_STRATEGY_PATTERN = /\b(clear_thinking_[a-z0-9_-]{1,64})\b/i;

function formatAnthropicDiagnosticBaseUrl(requestUrl: unknown): string {
	if (typeof requestUrl !== "string") return "the configured Anthropic base URL";
	try {
		const url = new URL(requestUrl);
		const basePath = url.pathname.replace(/\/v1\/messages\/?$/, "");
		return `${url.origin}${basePath}`;
	} catch {
		return "the configured Anthropic base URL";
	}
}

/**
 * Diagnose a context-management strategy named by an Anthropic 400 but absent
 * from the body GJC sent. This mismatch is evidence of intermediary mutation,
 * not permission to silently enable thinking or retry the request.
 */
export function diagnoseAnthropicContextManagementInjection(
	error: unknown,
	dump: RawHttpRequestDump | undefined,
): AnthropicContextManagementInjectionDiagnostic | undefined {
	if (extractHttpStatusFromError(error) !== 400) return undefined;
	if (dump?.api !== "anthropic-messages" || !isRecord(dump.body)) return undefined;
	if (isAnthropicApiBaseUrl(dump.url)) return undefined;
	if (Object.hasOwn(dump.body, "thinking") || Object.hasOwn(dump.body, "context_management")) return undefined;

	const errorMessage = error instanceof Error ? error.message : String(error);
	if (!/invalid_request_error/i.test(errorMessage)) return undefined;
	const strategy = CLEAR_THINKING_STRATEGY_PATTERN.exec(errorMessage)?.[1];
	if (!strategy) return undefined;
	if (!/\bstrategy\b/i.test(errorMessage) || !/\bthinking\b/i.test(errorMessage)) return undefined;

	const baseUrl = formatAnthropicDiagnosticBaseUrl(dump.url);
	return {
		strategy,
		message: [
			`GJC did not send \`thinking\` or \`context_management\`, but the Anthropic 400 names the \`${strategy}\` context-management strategy.`,
			`An intermediary at ${baseUrl} likely injected that strategy into the outgoing request.`,
			"Enable thinking explicitly for this model, or fix/replace the intermediary so it does not add clear-thinking edits to requests without thinking. GJC did not auto-enable thinking or retry because that would change request cost and semantics.",
		].join("\n"),
		captureNote: `The HTTP 400 references context-management strategy ${strategy}, but this captured outgoing body contains neither thinking nor context_management; an intermediary may have added it after GJC sent the request.`,
	};
}

async function finalizeAnthropicErrorMessage(error: unknown, dump: RawHttpRequestDump | undefined): Promise<string> {
	if (
		error instanceof Error &&
		(error as Error & { anthropicHttp400AlreadyCaptured?: boolean }).anthropicHttp400AlreadyCaptured
	) {
		return error.message;
	}
	const diagnostic = diagnoseAnthropicContextManagementInjection(error, dump);
	if (diagnostic && dump) {
		dump.diagnostics = {
			...(dump.diagnostics ?? {}),
			anthropicContextManagement: {
				strategy: diagnostic.strategy,
				note: diagnostic.captureNote,
			},
		};
	}
	const message = await finalizeErrorMessage(error, dump);
	return diagnostic ? `${message}\n\n${diagnostic.message}` : message;
}

/**
 * CPA's Claude-OAuth layer cloaks downstream tool names into
 * `mcp__<server>__<token>_<base>` aliases upstream. When the model emits a
 * tool call whose alias embeds a token that appears nowhere in the request,
 * CPA cannot restore the name and kills the whole stream with an HTTP 500 SSE
 * `error` event instead of forwarding the call (issue #4338). The signature is
 * precise and machine-parseable: it quotes the rejected alias and the failure
 * mode verbatim. Native Anthropic never emits this phrasing, so the text itself
 * is the route gate.
 */
const CPA_TOOL_ALIAS_RESTORE_PATTERN =
	/cannot restore Claude OAuth MCP tool alias \\?"([^"\\\\]+)\\?": no unique request-local match/i;

/**
 * Aliases observed as `mcp__<server>__<token>_<base>` with a 12-character
 * lowercase-alphanumeric token segment (`find` = `yw7zaf6emg3l` in both
 * captured traces). Tolerate 8-16 chars so extraction survives token-length
 * drift while staying out of the base name; a base that itself contains
 * underscores (`todo_write`) is preserved by the trailing `.+`.
 */
const CPA_TOOL_ALIAS_BASE_PATTERN = /^mcp__[^_]+__[a-z0-9]{8,16}_(.+)$/;

export interface CpaToolAliasRestoreFailure {
	/** The rejected tool-call name exactly as CPA quoted it. */
	alias: string;
	/**
	 * Base tool name parsed out of the alias (`mcp__<server>__<token>_<base>`
	 * → `<base>`), when the alias shape is well-formed. `undefined` for a
	 * malformed alias — callers must then fall back to direct discovery and
	 * never invent a name.
	 */
	baseName?: string;
}

/**
 * Classifies the CPA alias-restore signature and extracts the rejected alias
 * plus its base tool name. Claims only statusless in-stream SSE error events
 * and HTTP 5xx failures: a non-5xx status carrying this text is not the
 * observed CPA delivery shape and is left to the other classifiers.
 */
export function parseCpaToolAliasRestoreFailure(error: unknown): CpaToolAliasRestoreFailure | undefined {
	const status = extractHttpStatusFromError(error);
	if (status !== undefined && status < 500) return undefined;
	const message = error instanceof Error ? error.message : String(error);
	const match = CPA_TOOL_ALIAS_RESTORE_PATTERN.exec(message);
	if (!match) return undefined;
	const alias = match[1]!;
	return { alias, baseName: CPA_TOOL_ALIAS_BASE_PATTERN.exec(alias)?.[1] };
}

export function isCpaToolAliasRestoreFailure(error: unknown): boolean {
	return parseCpaToolAliasRestoreFailure(error) !== undefined;
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

function isClaudeFamilyModel(model: Model<"anthropic-messages">): boolean {
	// Classify the same identifier the request body serializes (`params.model =
	// model.id` in buildParams); a differing `wireModelId` is not dispatched by
	// this transport, so it must not drive the cache decision either.
	const id = model.id;
	const shortId = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
	return shortId.toLowerCase().startsWith("claude-");
}

/**
 * How many breakpoints we are still willing to generate after a gateway has
 * rejected a previous attempt. `explicit` mode normally emits two (a reusable
 * prefix anchor on the last assistant turn plus a refresh point on the current
 * user turn), so stepping down to one still caches the prefix, and only the
 * final step gives caching up entirely.
 */
type GeneratedCacheBudget = 2 | 1 | 0;

function getCacheControl(
	model: Model<"anthropic-messages">,
	baseUrl: string,
	cacheRetention?: CacheRetention,
	generatedCacheBudget: GeneratedCacheBudget = 2,
): { mode: AnthropicCacheMode; cacheControl?: AnthropicCacheControl } {
	if (generatedCacheBudget === 0) return { mode: "none" };
	const retention = resolveCacheRetention(cacheRetention ?? model.cacheRetention, "long");
	if (retention === "none") return { mode: "none" };

	const isCanonicalApi = isAnthropicApiBaseUrl(baseUrl);
	const promptCacheMode = model.compat?.promptCacheMode;
	const mode: AnthropicCacheMode =
		promptCacheMode === "none"
			? "none"
			: promptCacheMode === "explicit"
				? "explicit"
				: promptCacheMode === "automatic"
					? "automatic"
					: isCanonicalApi
						? "automatic"
						: isClaudeFamilyModel(model)
							? "explicit"
							: "none";
	if (mode === "none") return { mode };

	const supportsLongCacheRetention = isCanonicalApi
		? getAnthropicCompat(model).supportsLongCacheRetention
		: model.compat?.supportsLongCacheRetention === true;
	return {
		mode,
		cacheControl: {
			type: "ephemeral",
			...(retention === "long" && supportsLongCacheRetention ? { ttl: "1h" } : {}),
		},
	};
}

// Stealth mode: Mimic Anthropic Code headers and tool prefixing.
export const claudeCodeVersion = "2.1.219";
export const claudeCodeEntrypoint = "sdk-cli";
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
	return `${CLAUDE_BILLING_HEADER_PREFIX} cc_version=${claudeCodeVersion}.${buildHash}; cc_entrypoint=${claudeCodeEntrypoint}; cch=${cch};`;
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
	return `${prefixOverride}${name}`;
};

export const stripClaudeToolPrefix = (name: string, prefixOverride: string = claudeToolPrefix) => {
	if (!prefixOverride) return name;
	if (!name.startsWith(prefixOverride)) return name;
	return name.slice(prefixOverride.length);
};

// Anthropic requires image `data` to be standard (RFC 4648) base64: the standard
// alphabet only, correct quartet grouping, and padding (when present) confined to
// a trailing `=`/`==`. A resident image whose blob went missing bakes a
// human-readable placeholder into `data` (e.g. "[Session resident imageData blob
// missing: …]"), and other callers can pass whitespace, data URLs, or URL-safe
// variants — all of which the API rejects with a 400 `invalid base64 data` that
// fails the *entire* request and bricks the session. Validate the wire format
// strictly and degrade anything that is not standard base64 to text.
//
// Accepts canonical padded forms and their unpadded equivalents; rejects
// length % 4 === 1, misplaced/overlong padding, whitespace, data URLs, URL-safe
// (`-`/`_`) alphabets, prose, and empty input. The pattern has no nested
// quantifier, so even oversized inputs are rejected in linear time.
const ANTHROPIC_BASE64_IMAGE_DATA = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/;
function isAnthropicBase64ImageData(data: string): boolean {
	return data.length > 0 && data.length % 4 !== 1 && ANTHROPIC_BASE64_IMAGE_DATA.test(data);
}

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
	const imageBlocks: ImageContent[] = [];
	for (const block of content) {
		if (block.type !== "image") continue;
		if (isAnthropicBase64ImageData(block.data)) {
			imageBlocks.push(block);
			continue;
		}
		// Non-base64 image payload (e.g. a missing-blob placeholder): degrade to
		// text so one lost image cannot invalidate the entire request.
		const text = block.data.toWellFormed().trim();
		if (text.length > 0) textBlocks.push(text);
	}
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
	requestMaxRetries?: number;
	maxRetryDelayMs?: number;
	streamFirstEventTimeoutMs?: number;
	streamIdleTimeoutMs?: number;
};

export type AnthropicClientOptionsResult = {
	isOAuthToken: boolean;
	apiKey: string | null;
	authToken?: string | null;
	baseURL?: string;
	maxRetries: number;
	timeout?: number;
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

export function resolveGlmZcodeAnthropicBaseUrl(): string {
	const configured = $credentialEnv("ZCODE_PLAN_ANTHROPIC_BASE_URL")?.trim();
	if (!configured || /[\u0000-\u001f\u007f-\u009f]/u.test(configured)) {
		return GLM_ZCODE_ANTHROPIC_BASE_URL;
	}
	try {
		const parsed = new URL(configured);
		if (
			parsed.protocol !== "https:" ||
			parsed.hostname.length === 0 ||
			parsed.username.length > 0 ||
			parsed.password.length > 0 ||
			parsed.search.length > 0 ||
			parsed.hash.length > 0
		) {
			return GLM_ZCODE_ANTHROPIC_BASE_URL;
		}
		return normalizeAnthropicBaseUrl(parsed.toString()) ?? GLM_ZCODE_ANTHROPIC_BASE_URL;
	} catch {
		return GLM_ZCODE_ANTHROPIC_BASE_URL;
	}
}

function resolveAnthropicBaseUrl(model: Model<"anthropic-messages">, apiKey?: string): string | undefined {
	if (model.provider === "github-copilot") {
		return normalizeAnthropicBaseUrl(resolveGitHubCopilotBaseUrl(model.baseUrl, apiKey) ?? model.baseUrl);
	}
	// glm-zcode logs in via ZCode's OAuth but auto-provisions a real Z.AI API key and
	// calls api.z.ai directly (no zcode.z.ai gateway, no captcha). Pin the base so dynamic
	// discovery / stale bundled catalogs / model cache can't redirect it elsewhere.
	if (model.provider === "glm-zcode") {
		return resolveGlmZcodeAnthropicBaseUrl();
	}
	if (model.provider === "anthropic" && isFoundryEnabled()) {
		const foundryBaseUrl = normalizeAnthropicBaseUrl($credentialEnv("FOUNDRY_BASE_URL"));
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

const ANTHROPIC_RETRY_DELAY_CAP_MS = 60_000;
const ANTHROPIC_RATE_LIMIT_HEADER_PREFIX = "anthropic-ratelimit-";

function getSafeAnthropicHeaderEvidence(headers: Headers): string[] {
	const evidence: string[] = [];
	for (const [name, value] of headers) {
		const lowerName = name.toLowerCase();
		if (
			lowerName === "retry-after" ||
			lowerName === "retry-after-ms" ||
			lowerName.startsWith(ANTHROPIC_RATE_LIMIT_HEADER_PREFIX)
		) {
			evidence.push(`${lowerName}=${value}`);
		}
	}
	return evidence.sort();
}

function getStringProperty(source: unknown, key: string): string | undefined {
	if (!isRecord(source)) return undefined;
	const value = source[key];
	return typeof value === "string" ? value : undefined;
}

function appendAnthropicRateLimitEvidence(bodyText: string, headers: Headers): string {
	const evidence = getSafeAnthropicHeaderEvidence(headers);
	if (evidence.length === 0) return bodyText;

	const suffix = ` Anthropic rate-limit evidence: ${evidence.join(", ")}`;
	try {
		const parsed = JSON.parse(bodyText) as unknown;
		if (isRecord(parsed)) {
			const error = parsed.error;
			if (isRecord(error) && typeof error.message === "string" && !error.message.includes(suffix)) {
				return JSON.stringify({ ...parsed, error: { ...error, message: `${error.message}${suffix}` } });
			}
			if (typeof parsed.message === "string" && !parsed.message.includes(suffix)) {
				return JSON.stringify({ ...parsed, message: `${parsed.message}${suffix}` });
			}
		}
	} catch {}

	return bodyText.includes(suffix) ? bodyText : `${bodyText}${suffix}`;
}

function isAnthropicUsageExhaustionResponse(
	bodyText: string,
	headers: Headers,
	retryAfterMs: number | undefined,
	retryDelayCapMs: number,
): boolean {
	const overageReason = headers.get("anthropic-ratelimit-unified-overage-disabled-reason")?.toLowerCase();
	if (overageReason === "out_of_credits") return true;
	if (retryAfterMs !== undefined && retryAfterMs > retryDelayCapMs) return true;

	try {
		const parsed = JSON.parse(bodyText) as unknown;
		const error = isRecord(parsed) ? parsed.error : undefined;
		const type = getStringProperty(error, "type") ?? getStringProperty(parsed, "type");
		const message = getStringProperty(error, "message") ?? getStringProperty(parsed, "message") ?? bodyText;
		return (
			/rate_limit_error/i.test(type ?? "") &&
			(/request would exceed your account.?s rate limit/i.test(message) || /out_of_credits/i.test(message))
		);
	} catch {
		return /request would exceed your account.?s rate limit|out_of_credits/i.test(bodyText);
	}
}

function wrapAnthropicFetchForBoundedRateLimits(baseFetch: FetchImpl, maxRetryDelayMs: number | undefined): FetchImpl {
	const retryDelayCapMs = maxRetryDelayMs ?? ANTHROPIC_RETRY_DELAY_CAP_MS;
	return Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const response = await baseFetch(input, init);
			if (response.status !== 429 || retryDelayCapMs === 0) return response;

			const headers = new Headers(response.headers);
			const retryAfterMs = getRetryAfterMsFromHeaders(headers);
			const bodyText = await response
				.clone()
				.text()
				.catch(() => "");
			if (!isAnthropicUsageExhaustionResponse(bodyText, headers, retryAfterMs, retryDelayCapMs)) return response;

			headers.set("x-should-retry", "false");
			return new Response(appendAnthropicRateLimitEvidence(bodyText, headers), {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		},
		baseFetch.preconnect ? { preconnect: baseFetch.preconnect } : {},
	);
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
): Required<Omit<NonNullable<Model<"anthropic-messages">["compat"]>, "toolChoiceSupport">> &
	Pick<NonNullable<Model<"anthropic-messages">["compat"]>, "toolChoiceSupport"> {
	return {
		disableStrictTools: model.compat?.disableStrictTools ?? false,
		disableAdaptiveThinking: model.compat?.disableAdaptiveThinking ?? false,
		supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? true,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		supportsToolChoice: model.compat?.supportsToolChoice ?? true,
		supportsForcedToolChoice: model.compat?.supportsForcedToolChoice ?? true,
		promptCacheMode: model.compat?.promptCacheMode ?? "none",
		toolChoiceSupport: model.compat?.toolChoiceSupport,
	};
}

const PROVIDER_MAX_RETRIES = 3;
const PROVIDER_BASE_DELAY_MS = 2000;
const ANTHROPIC_CUSTOM_ENDPOINT_FIRST_EVENT_GRACE_MS = 120_000;
const ANTHROPIC_LARGE_REQUEST_BYTES = 1_000_000;
const ANTHROPIC_LARGE_FIRST_EVENT_TIMEOUT_MAX_ATTEMPTS = 1;
const ANTHROPIC_SMALL_FIRST_EVENT_TIMEOUT_MAX_ATTEMPTS = 2;

function classifyAnthropicEndpoint(baseUrl: string): "canonical" | "custom" {
	try {
		const url = new URL(baseUrl);
		return url.protocol.toLowerCase() === "https:" &&
			url.hostname.toLowerCase() === "api.anthropic.com" &&
			(url.port === "" || url.port === "443") &&
			url.username === "" &&
			url.password === "" &&
			url.search === "" &&
			url.hash === "" &&
			(url.pathname === "" || url.pathname === "/")
			? "canonical"
			: "custom";
	} catch {
		return "custom";
	}
}

function resolveAnthropicFirstEventWatchdogMs(
	firstEventTimeoutMs: number | undefined,
	endpointClass: "canonical" | "custom",
	requestBytes: number,
): number | undefined {
	if (
		firstEventTimeoutMs === undefined ||
		firstEventTimeoutMs <= 0 ||
		endpointClass === "canonical" ||
		requestBytes < ANTHROPIC_LARGE_REQUEST_BYTES
	) {
		return firstEventTimeoutMs;
	}
	return firstEventTimeoutMs + ANTHROPIC_CUSTOM_ENDPOINT_FIRST_EVENT_GRACE_MS;
}

function resolveAnthropicFirstEventTimeoutMaxAttempts(requestBytes: number): number {
	return requestBytes >= ANTHROPIC_LARGE_REQUEST_BYTES
		? ANTHROPIC_LARGE_FIRST_EVENT_TIMEOUT_MAX_ATTEMPTS
		: ANTHROPIC_SMALL_FIRST_EVENT_TIMEOUT_MAX_ATTEMPTS;
}

function normalizeStreamFailure(error: unknown): unknown {
	if (error instanceof Error) return error;
	if (error !== null && typeof error === "object") {
		// Structured rejections (e.g. `{ status, error, headers }` from an SDK or
		// injected client) carry transport metadata downstream classification
		// reads; wrap them in a mutable Error but copy every enumerable own
		// property so status/provider-code/header extraction still works.
		let message: string;
		try {
			message = JSON.stringify(error) || String(error);
		} catch {
			message = String(error);
		}
		const wrapper = new Error(message);
		Object.assign(wrapper, error as object);
		return wrapper;
	}
	// Primitive rejections (string/number/boolean/null/undefined): wrap with the
	// same string form downstream matchers already use (String(error)).
	return new Error(String(error));
}

function attachAnthropicGraceFailureFacts(
	error: unknown,
	args: {
		elapsedMs: number;
		requestBytes: number;
		firstEventTimeoutMs: number | undefined;
		endpointClass: "canonical" | "custom";
		awaitingFirstEvent: boolean;
	},
): void {
	if (
		!(error instanceof Error) ||
		!args.awaitingFirstEvent ||
		args.firstEventTimeoutMs === undefined ||
		args.firstEventTimeoutMs <= 0 ||
		args.elapsedMs < args.firstEventTimeoutMs ||
		args.endpointClass !== "custom" ||
		args.requestBytes < ANTHROPIC_LARGE_REQUEST_BYTES
	) {
		return;
	}
	Object.assign(error, {
		requestBytes: args.requestBytes,
		firstEventElapsedMs: args.elapsedMs,
		firstEventTimeoutMs: args.firstEventTimeoutMs,
		endpointClass: args.endpointClass,
		retryMaxAttempts: ANTHROPIC_LARGE_FIRST_EVENT_TIMEOUT_MAX_ATTEMPTS,
	});
}

function createAnthropicFirstEventTimeoutError(args: {
	elapsedMs: number;
	requestBytes: number;
	firstEventTimeoutMs: number | undefined;
	endpointClass: "canonical" | "custom";
	/** Uploads this provider invocation already consumed before the timeout. */
	providerAttemptsConsumed?: number;
}): FirstEventTimeoutError {
	const totalCeiling = resolveAnthropicFirstEventTimeoutMaxAttempts(args.requestBytes);
	// The session counts a whole provider invocation as one attempt, so the
	// ceiling handed up must bound TOTAL uploads across the invocation: subtract
	// the provider replays already spent inside this invocation. A small request
	// whose first upload 529'd and whose replay then timed out has already
	// consumed two uploads; reporting the full two-attempt ceiling would let the
	// session upload a third time.
	const retryMaxAttempts = Math.max(1, totalCeiling - (args.providerAttemptsConsumed ?? 0));
	const timeoutLabel = args.firstEventTimeoutMs === undefined ? "disabled" : `${args.firstEventTimeoutMs}ms`;
	return new FirstEventTimeoutError(
		`Anthropic stream timed out while waiting for the first event (elapsed=${args.elapsedMs}ms request_bytes=${args.requestBytes} endpoint=${args.endpointClass} configured_timeout=${timeoutLabel}; override with PI_STREAM_FIRST_EVENT_TIMEOUT_MS)`,
		{
			requestBytes: args.requestBytes,
			firstEventElapsedMs: args.elapsedMs,
			firstEventTimeoutMs: args.firstEventTimeoutMs,
			endpointClass: args.endpointClass,
			retryMaxAttempts,
		},
	);
}

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

function createAnthropicStreamProgressPredicate(): (event: unknown) => boolean {
	let outputTokens = -1;

	return event => {
		if (!isRecord(event) || typeof event.type !== "string") return false;
		if (
			event.type === "message_start" ||
			event.type === "content_block_start" ||
			event.type === "content_block_stop" ||
			event.type === "message_stop"
		) {
			return true;
		}
		if (event.type === "content_block_delta") {
			if (!isRecord(event.delta)) return false;
			const delta = event.delta;
			return (
				(typeof delta.text === "string" && delta.text.length > 0) ||
				(typeof delta.thinking === "string" && delta.thinking.length > 0) ||
				(typeof delta.partial_json === "string" && delta.partial_json.length > 0) ||
				(typeof delta.signature === "string" && delta.signature.length > 0)
			);
		}
		if (event.type === "message_delta") {
			if (isRecord(event.delta) && event.delta.stop_reason != null) return true;
			if (!isRecord(event.usage) || typeof event.usage.output_tokens !== "number") return false;
			if (event.usage.output_tokens <= outputTokens) return false;
			outputTokens = event.usage.output_tokens;
			return true;
		}
		return false;
	};
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
	if (isUsageLimitError(error.message)) return false;
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

/**
 * Unique request-local tool whose wire name equals the parsed base, if any.
 * Only an exact, singular match is trusted; zero or multiple matches yield
 * `undefined` so the repair never guesses among ambiguous aliases.
 */
function resolveCpaCallableToolName(
	params: MessageCreateParamsStreaming,
	failure: CpaToolAliasRestoreFailure,
): string | undefined {
	if (failure.baseName === undefined) return undefined;
	const tools = params.tools as Array<{ name?: string }> | undefined;
	if (!tools) return undefined;
	let match: string | undefined;
	for (const tool of tools) {
		if (tool.name !== failure.baseName) continue;
		if (match !== undefined) return undefined;
		match = tool.name;
	}
	return match;
}

/**
 * Corrective steering for the one retry after a CPA alias-restore failure. A
 * provable unique callable name is stated deterministically; otherwise the
 * model is directed at tool discovery instead of being handed an invented
 * name, mirroring the agent loop's "not found → discover and activate"
 * guidance. The rejected alias is echoed verbatim so the model knows which
 * call was wrong; nothing else from the request is quoted.
 */
function buildCpaToolAliasSteering(failure: CpaToolAliasRestoreFailure, callableToolName?: string): string {
	const rejected = `Your previous tool call "${failure.alias}" was rejected by the Claude OAuth proxy: the tool name is not callable in this request.`;
	if (callableToolName !== undefined) {
		return `${rejected} The callable tool is "${callableToolName}". Call it by exactly that name; do not construct or reconstruct prefixed or aliased tool names.`;
	}
	return `${rejected} If you need this capability, call \`search_tool_bm25\` to discover and activate the matching tool, then retry.`;
}

/**
 * Actionable terminal error for a CPA alias-restore failure that survived the
 * single corrective attempt. Deliberately statusless: no HTTP status, no
 * transport facts, and no recognizable status phrase, so neither the provider
 * generic 5xx retry nor the managed fallback controller re-sends the unchanged
 * request. Only the rejected alias and the deterministic callable name (when
 * provable) are quoted — never the request body or headers.
 */
function createCpaToolAliasTerminalError(failure: CpaToolAliasRestoreFailure, callableToolName?: string): Error {
	const base = `Claude OAuth proxy rejected tool call "${failure.alias}": the proxy cannot restore the Claude OAuth MCP tool alias (no unique request-local match), and the corrective retry was rejected again.`;
	const guidance =
		callableToolName !== undefined
			? ` The callable tool name is "${callableToolName}"; call it by exactly that name.`
			: ` No unique callable tool name could be determined; discover the correct tool name before retrying.`;
	return new Error(`${base}${guidance} The turn was not re-sent.`);
}

/**
 * Stable identity for the logical turn currently being prompted: the
 * serialized content of the last user message. Fallback rebuilds of the same
 * turn keep the same fingerprint; the next user prompt changes it.
 */
function cpaTurnFingerprint(messages: Message[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "user") continue;
		const content = message.content;
		const serialized = typeof content === "string" ? content : JSON.stringify(content);
		return `${serialized.length}:${serialized}`;
	}
	return "";
}

/**
 * Append corrective steering as a trailing user turn, preserving role
 * alternation by merging into the last user message when it is already a user
 * turn.
 */
function appendCpaSteeringToMessages(params: MessageCreateParamsStreaming, text: string): void {
	const messages = params.messages as MessageParam[];
	const last = messages[messages.length - 1];
	if (last && last.role === "user") {
		last.content = Array.isArray(last.content)
			? [...last.content, { type: "text", text }]
			: `${last.content}\n\n${text}`;
	} else {
		messages.push({ role: "user", content: text });
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
					onSseEvent: options?.onSseEvent
						? event => options.onSseEvent!(event, model, options?.attemptScope)
						: undefined,
					fetch: options?.fetch,
					requestMaxRetries: options?.requestMaxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					streamFirstEventTimeoutMs: options?.streamFirstEventTimeoutMs,
					streamIdleTimeoutMs: options?.streamIdleTimeoutMs,
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
			let droppedForcedToolChoice = false;
			// Exactly one corrective retry per request for the CPA alias-restore
			// signature (issue #4338); recurrence terminalizes instead of resending.
			let cpaAliasRepairApplied = false;
			let thinkingReplayRepairScope: AnthropicThinkingReplayRepairScope =
				providerSessionState?.thinkingReplayRepairScope ?? "none";
			let thinkingReplayRepairAttempts = providerSessionState?.thinkingReplayRepairAttempts ?? 0;
			// A scope inherited from an earlier turn can only have come from the
			// deterministic branch below — the speculative masked-`api_error` probe is
			// never persisted — so a completed stream must not release it.
			let thinkingReplayRepairPersistent = thinkingReplayRepairScope !== "none";
			let generatedCacheBudget: GeneratedCacheBudget = providerSessionState?.generatedCacheBudget ?? 2;
			const prepareParams = async (): Promise<MessageCreateParamsStreaming> => {
				// Degradation state is cumulative: every fallback rebuild must merge all
				// repairs activated so far. Rebuilding from only the immediate call lets
				// a later strict/forced-tool/fast-mode fallback reintroduce the rejected
				// shape (e.g. invalid thinking signatures or forced tool_choice), and
				// the one-shot thinking-repair guard then blocks recovery.
				let nextParams = buildParams(
					model,
					baseUrl,
					context,
					isOAuthToken,
					options,
					disableStrictTools,
					{
						repairLatestAssistantThinking: thinkingReplayRepairScope === "latest",
						repairAllAssistantThinking: thinkingReplayRepairScope === "all",
					},
					generatedCacheBudget,
				);
				if (droppedForcedToolChoice) {
					delete nextParams.tool_choice;
				}
				if (disableStrictTools) {
					dropAnthropicStrictTools(nextParams);
				}
				if (dropFastMode) {
					dropAnthropicFastMode(nextParams);
				}
				const replacementPayload = await options?.onPayload?.(nextParams, model, options?.attemptScope);
				if (replacementPayload !== undefined) {
					nextParams = replacementPayload as typeof nextParams;
				}
				// Managed-mode CPA steering (issue #4338): a previous managed attempt of
				// this exact turn recorded a corrective tool-name message. Apply it only
				// while the turn is unchanged; a different user prompt expires it so a
				// stale correction never leaks into a later turn.
				const cpaSteering = providerSessionState?.cpaToolAliasSteering;
				if (cpaSteering) {
					if (cpaSteering.turnFingerprint === cpaTurnFingerprint(context.messages)) {
						appendCpaSteeringToMessages(nextParams, cpaSteering.message);
					} else {
						providerSessionState.cpaToolAliasSteering = undefined;
					}
				}
				validateCacheControls(nextParams as AnthropicCacheParams);
				return nextParams;
			};
			let params = await prepareParams();
			const setRawRequestDump = (body: MessageCreateParamsStreaming): void => {
				rawRequestDump = {
					provider: model.provider,
					api: output.api,
					model: model.id,
					method: "POST",
					url: `${baseUrl}/v1/messages`,
					body,
				};
			};
			setRawRequestDump(params);
			const inheritedRejectedPayload = providerSessionState?.thinkingReplayRejectedPayload;
			if (
				inheritedRejectedPayload &&
				thinkingReplayRepairScope !== "none" &&
				!anthropicPayloadChanged(inheritedRejectedPayload, fingerprintAnthropicPayload(params))
			) {
				throw createAnthropicThinkingRepairNoopError(
					new Error(
						"invalid_request_error: persisted Anthropic thinking repair did not change the outgoing payload",
					),
					params,
					inheritedRejectedPayload,
				);
			}
			if (providerSessionState?.thinkingReplayRejectedPayload) {
				providerSessionState.thinkingReplayRejectedPayload = undefined;
			}

			type Block = (
				| ThinkingContent
				| RedactedThinkingContent
				| TextContent
				| (ToolCall & { partialJson: string })
			) & { index: number };
			const blocks = output.content as Block[];
			const blocksByAnthropicIndex = new Map<number, Block>();
			const truncatedToolCalls = new Set<ToolCall>();
			// Bounded diagnostic for degraded primitive increments: at most one
			// warning per delta type per stream invocation, naming only the
			// envelope shape (delta type and received typeof) — never the payload.
			const degradedIncrementDiagnostics = new Set<string>();
			const noteDegradedIncrement = (deltaType: string, received: unknown): void => {
				if (degradedIncrementDiagnostics.has(deltaType)) return;
				degradedIncrementDiagnostics.add(deltaType);
				logger.warn("anthropic: degraded non-string stream increment to empty string", {
					model: model.id,
					provider: model.provider,
					deltaType,
					receivedType: received === null ? "null" : typeof received,
				});
			};

			// Derive from the ACTUAL request shape, not the option default: the request
			// only sends `display: "summarized"` on specific paths (adaptive display is
			// omitted for models where supportsAdaptiveThinkingDisplay is false). Defaulting
			// to summarized would mislabel raw thinking as a provider-displayable summary.
			const summarizedThinking =
				(params.thinking as { display?: AnthropicThinkingDisplay } | undefined)?.display === "summarized";
			const reasoningBuffers = new WeakMap<object, string>();
			const getBlockByAnthropicIndex = (anthropicIndex: number) => {
				const block = blocksByAnthropicIndex.get(anthropicIndex);
				if (!block) return { block: undefined, contentIndex: -1 };
				return { block, contentIndex: blocks.indexOf(block) };
			};
			const trackBlockByAnthropicIndex = (anthropicIndex: number, block: Block) => {
				const orphaned = blocksByAnthropicIndex.get(anthropicIndex);
				if (orphaned) {
					if (orphaned.type === "toolCall") {
						orphaned.incompleteArguments = true;
						orphaned.incompleteArgumentsReason = "ambiguous";
						truncatedToolCalls.add(orphaned);
					}
					if (block.type === "toolCall") {
						block.incompleteArguments = true;
						block.incompleteArgumentsReason = "ambiguous";
					}
					throw new Error("Anthropic stream reused an active content block index");
				}
				blocksByAnthropicIndex.set(anthropicIndex, block);
			};
			const resetOutputForRetry = () => {
				output.content.length = 0;
				output.responseId = undefined;
				output.errorKind = undefined;
				output.errorStatus = undefined;
				output.errorMessage = strictFallbackErrorMessage;
				output.providerPayload = undefined;
				output.usage = createEmptyUsage(copilotDynamicHeaders?.premiumRequests);
				output.stopReason = "stop";
				firstTokenTime = undefined;
				truncatedToolCalls.clear();
			};
			const idleTimeoutMs =
				options?.streamIdleTimeoutMs ??
				getStreamIdleTimeoutMs(getProviderStreamIdleTimeoutFallbackMs(model.provider));
			const firstEventFallbackMs = getProviderFirstEventTimeoutFallbackMs(model.provider);
			const firstEventTimeoutMs =
				options?.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs(idleTimeoutMs, firstEventFallbackMs);
			const endpointClass = classifyAnthropicEndpoint(options?.client?.baseURL ?? baseUrl);
			stream.push({ type: "start", partial: output });
			// Retry loop for transient errors from the stream.
			// Provider-level transport/rate-limit failures: only before any streamed content starts.
			// Malformed envelopes/JSON: only before replay-unsafe text/tool events are visible on this stream.
			let providerRetryAttempt = 0;
			// Total uploads this invocation has spent, including corrective-policy
			// replays (strict-tool/forced-tool/fast-mode/thinking/CPA) that reset
			// providerRetryAttempt before `continue`. The timeout ceiling must bound
			// TOTAL uploads, so it reads this counter, not the resettable one.
			let providerUploadCount = 0;
			while (true) {
				let firstEventWaitStartedAt: number | undefined;
				const requestBytes = fingerprintAnthropicPayload(params).bytes;
				const firstEventWatchdogMs = resolveAnthropicFirstEventWatchdogMs(
					firstEventTimeoutMs,
					endpointClass,
					requestBytes,
				);
				const requestUploadCeilingBound =
					endpointClass === "custom" &&
					requestBytes >= ANTHROPIC_LARGE_REQUEST_BYTES &&
					firstEventTimeoutMs !== undefined &&
					firstEventTimeoutMs > 0;
				// Retries reset output.content; drop stale block correlations from the aborted attempt.
				blocksByAnthropicIndex.clear();
				truncatedToolCalls.clear();
				activeAbortTracker = createAbortSourceTracker(options?.signal);
				let firstEventTimeoutAbortError: FirstEventTimeoutError | undefined;
				const idleTimeoutAbortError = new Error("Anthropic stream stalled while waiting for the next event");
				const { requestSignal } = activeAbortTracker;
				setRawRequestDump(params);
				options?.onStreamCreated?.();
				const anthropicRequest = client.messages.create(
					{ ...params, stream: true },
					{
						signal: requestSignal,
						...(requestUploadCeilingBound ? { maxRetries: 0 } : {}),
					},
				);
				let streamedReplayUnsafeContent = false;
				let sawProviderSafetyStop = false;
				let sawFirstSemanticEvent = false;

				try {
					const {
						events: anthropicStream,
						response,
						requestId,
					} = await getAnthropicStreamResponse(
						anthropicRequest,
						requestSignal,
						options?.client ? event => options?.onSseEvent?.(event, model, options?.attemptScope) : undefined,
					);
					await notifyProviderResponse(options, response, model, requestId);
					firstEventWaitStartedAt = Date.now();
					let sawEvent = false;
					let sawMessageStart = false;
					let sawTerminalEnvelope = false;
					let sawMessageStop = false;
					const isProgressEvent = createAnthropicStreamProgressPredicate();

					for await (const event of iterateWithIdleTimeout(anthropicStream, {
						idleTimeoutMs,
						firstItemTimeoutMs: firstEventWatchdogMs,
						errorMessage: idleTimeoutAbortError.message,
						firstItemErrorMessage: "Anthropic stream timed out while waiting for the first event",
						onIdle: () => activeAbortTracker.abortLocally(idleTimeoutAbortError),
						onFirstItemTimeout: () => {
							firstEventTimeoutAbortError = createAnthropicFirstEventTimeoutError({
								elapsedMs: Date.now() - (firstEventWaitStartedAt ?? Date.now()),
								requestBytes,
								firstEventTimeoutMs,
								endpointClass,
								providerAttemptsConsumed: providerUploadCount,
							});
							activeAbortTracker.abortLocally(firstEventTimeoutAbortError);
						},
						abortSignal: options?.signal,
						isProgressItem: event => {
							if (!isRecord(event) || (!sawMessageStart && event.type !== "message_start")) return false;
							const progress = isProgressEvent(event);
							if (progress) sawFirstSemanticEvent = true;
							return progress;
						},
					})) {
						sawEvent = true;
						if (sawMessageStop) {
							throw createAnthropicStreamEnvelopeError("received event after message_stop");
						}
						if (sawProviderSafetyStop) {
							if (event.type === "message_stop") {
								sawTerminalEnvelope = true;
								sawMessageStop = true;
							}
							continue;
						}

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
								trackBlockByAnthropicIndex(event.index, block);
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
								trackBlockByAnthropicIndex(event.index, block);
								// Emit thinking_start FIRST so a reasoning item is open before any
								// summary-start: the Responses SSE encoder only accepts a summary
								// start when state.open.kind === "reasoning", otherwise the
								// reasoning_summary_part.added frame is dropped and deltas arrive
								// out of order.
								stream.push({
									type: "thinking_start",
									contentIndex: output.content.length - 1,
									partial: output,
								});
								if (summarizedThinking) {
									reasoningBuffers.set(block, "");
									stream.push({
										type: "reasoning_summary_start",
										contentIndex: output.content.length - 1,
										partial: output,
									});
								}
							} else if (event.content_block.type === "redacted_thinking") {
								const block: Block = {
									type: "redactedThinking",
									data: event.content_block.data,
									index: event.index,
								};
								output.content.push(block);
								trackBlockByAnthropicIndex(event.index, block);
							} else if (event.content_block.type === "tool_use") {
								streamedReplayUnsafeContent = true;
								const initialArguments: unknown = event.content_block.input;
								if (
									initialArguments === null ||
									typeof initialArguments !== "object" ||
									Array.isArray(initialArguments)
								) {
									throw new Error("Anthropic tool_use started with non-object arguments");
								}
								const block: Block = {
									type: "toolCall",
									id: event.content_block.id,
									name: isOAuthToken
										? stripClaudeToolPrefix(event.content_block.name)
										: event.content_block.name,
									arguments: initialArguments as Record<string, unknown>,
									partialJson: "",
									index: event.index,
								};
								output.content.push(block);
								trackBlockByAnthropicIndex(event.index, block);
								stream.push({
									type: "toolcall_start",
									contentIndex: output.content.length - 1,
									partial: output,
								});
							}
						} else if (event.type === "content_block_delta") {
							if (event.delta.type === "text_delta") {
								const { block, contentIndex: index } = getBlockByAnthropicIndex(event.index);
								if (block && block.type === "text") {
									const rawTextDelta: unknown = event.delta.text;
									if (typeof rawTextDelta !== "string") {
										noteDegradedIncrement("text_delta", rawTextDelta);
									}
									const textDelta = typeof rawTextDelta === "string" ? rawTextDelta : "";
									block.text += textDelta;
									stream.push({
										type: "text_delta",
										contentIndex: index,
										delta: textDelta,
										partial: output,
									});
								}
							} else if (event.delta.type === "thinking_delta") {
								const { block, contentIndex: index } = getBlockByAnthropicIndex(event.index);
								if (block && block.type === "thinking") {
									const rawThinkingDelta: unknown = event.delta.thinking;
									if (typeof rawThinkingDelta !== "string") {
										noteDegradedIncrement("thinking_delta", rawThinkingDelta);
									}
									const thinkingDelta = typeof rawThinkingDelta === "string" ? rawThinkingDelta : "";
									block.thinking += thinkingDelta;
									if (summarizedThinking) {
										const summary = (reasoningBuffers.get(block) ?? "") + thinkingDelta;
										reasoningBuffers.set(block, summary);
										stream.push({
											type: "reasoning_summary_delta",
											contentIndex: index,
											delta: thinkingDelta,
											partial: output,
										});
									} else {
										stream.push({
											type: "thinking_delta",
											contentIndex: index,
											delta: thinkingDelta,
											partial: output,
										});
									}
								}
							} else if (event.delta.type === "input_json_delta") {
								const { block, contentIndex: index } = getBlockByAnthropicIndex(event.index);
								if (block && block.type === "toolCall") {
									const rawJsonDelta: unknown = event.delta.partial_json;
									if (typeof rawJsonDelta !== "string") {
										// Tool-argument fragments are positional JSON text: erasing or
										// coercing any malformed increment (primitive OR object/function)
										// assembles valid-but-wrong arguments — e.g. `{"n":1` + numeric
										// primitive erased to "" + `3}` parses as {"n":13} and executes.
										// Prose/thinking/signature anomalies are safe to degrade; tool
										// arguments fail the turn closed. The payload never enters the
										// error.
										throw new Error(
											"Anthropic stream sent a non-string input_json_delta tool-argument increment; failing the turn instead of assembling wrong tool arguments",
										);
									}
									const jsonDelta = rawJsonDelta;
									block.partialJson += jsonDelta;
									block.arguments = parseStreamingJson(block.partialJson);
									stream.push({
										type: "toolcall_delta",
										contentIndex: index,
										delta: jsonDelta,
										partial: output,
									});
								}
							} else if (event.delta.type === "signature_delta") {
								const { block } = getBlockByAnthropicIndex(event.index);
								if (block && block.type === "thinking") {
									block.thinkingSignature = block.thinkingSignature || "";
									const rawSignatureDelta: unknown = event.delta.signature;
									if (typeof rawSignatureDelta === "string") {
										block.thinkingSignature += rawSignatureDelta;
									} else {
										noteDegradedIncrement("signature_delta", rawSignatureDelta);
									}
								}
							}
						} else if (event.type === "content_block_stop") {
							const { block, contentIndex: index } = getBlockByAnthropicIndex(event.index);
							if (block) {
								blocksByAnthropicIndex.delete(event.index);
								delete (block as { index?: number }).index;
								if (block.type === "text") {
									stream.push({
										type: "text_end",
										contentIndex: index,
										content: block.text,
										partial: output,
									});
								} else if (block.type === "thinking") {
									if (summarizedThinking) {
										const summaryText = reasoningBuffers.get(block) ?? "";
										const mutable = block as {
											provenance?: "summary" | "raw" | "mixed";
											summaryText?: string;
										};
										if (mutable.summaryText === undefined) mutable.summaryText = summaryText;
										if (mutable.provenance === undefined) mutable.provenance = "summary";
										stream.push({
											type: "reasoning_summary_end",
											contentIndex: index,
											content: summaryText,
											partial: output,
										});
									}
									stream.push({
										type: "thinking_end",
										contentIndex: index,
										content: block.thinking,
										partial: output,
									});
								} else if (block.type === "toolCall") {
									if (!isCompleteJson(block.partialJson)) {
										truncatedToolCalls.add(block);
										block.incompleteArguments = true;
										block.incompleteArgumentsReason = "truncated";
									}
									if (block.partialJson.trim()) {
										const parsedArguments: unknown = parseStreamingJson(block.partialJson);
										if (
											parsedArguments === null ||
											typeof parsedArguments !== "object" ||
											Array.isArray(parsedArguments)
										) {
											throw new Error("Anthropic tool_use completed with non-object arguments");
										}
										block.arguments = parsedArguments as Record<string, unknown>;
										captureUnicodeEscapeEvidence(block, block.partialJson);
									}
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
							const stopDetails = event.delta.stop_details;
							const isProviderSafetyStop =
								rawStopReason === "refusal" ||
								rawStopReason === "sensitive" ||
								stopDetails?.type === "refusal" ||
								stopDetails?.type === "sensitive";
							if (rawStopReason) {
								output.stopReason = isProviderSafetyStop ? "error" : mapStopReason(rawStopReason);
								sawTerminalEnvelope = true;
							}
							if (isProviderSafetyStop) {
								sawProviderSafetyStop = true;
								sawTerminalEnvelope = true;
								output.stopReason = "error";
								// Mint the terminal kind with adapter provenance: the
								// structured refusal signal was parsed from the stream
								// delta, so the mark (not the wire field) carries the
								// authority (#4777).
								const authenticated = mintProviderSafetyStop(
									output,
									stopDetails?.type === "refusal" || stopDetails?.type === "sensitive"
										? stopDetails.type
										: rawStopReason === "sensitive"
											? "sensitive"
											: "refusal",
									PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY,
									options?.fetch ?? options?.client,
									isProviderSafetyStopAdapterInvocation(options),
								);
								if (!authenticated) {
									output.transportFailure = {
										kind: "transport",
										status: 500,
										providerCode: "untrusted_safety_stop",
									};
								}
								if (stopDetails?.type === "refusal") {
									const explanation = stopDetails.explanation?.trim();
									const category = stopDetails.category;
									const label = category ? `Refusal (${category})` : "Refusal";
									output.errorMessage = explanation ? `${label}: ${explanation}` : label;
								} else if (!output.errorMessage) {
									output.errorMessage =
										rawStopReason === "refusal"
											? "Refusal (no details provided)"
											: "Content flagged by safety filters";
								}
							} else if (output.stopReason === "error" && !output.errorMessage) {
								// Anthropic flagged an error-class stop without populating stop_details.
								// Surface the raw reason instead of falling through to the generic
								// "unknown error" string when we throw below.
								output.errorMessage = `Anthropic stream ended with stop_reason: ${rawStopReason ?? "unknown"}`;
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
							sawMessageStop = true;
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
					// The first stream that completes is the only evidence available that this
					// session is not the #4011 loop, which never produced one. Release the
					// repair escalation and the budget it consumed: the masked `api_error`
					// branch above fires on an error nobody can classify, so keeping its
					// guess would silently strip native thinking replay from every later
					// turn of the session over what may have been one transient blip.
					//
					// A deterministic rejection ("cannot be modified" / invalid signature) is
					// the opposite case: it cites blocks that stay in this session's history,
					// so releasing the repair here makes the next turn replay the same blocks
					// and spend another rejected round trip on every turn that follows. That
					// repair has to outlive the stream it fixed.
					if (
						providerSessionState &&
						!thinkingReplayRepairPersistent &&
						(thinkingReplayRepairScope !== "none" || thinkingReplayRepairAttempts > 0)
					) {
						providerSessionState.thinkingReplayRepairScope = "none";
						providerSessionState.thinkingReplayRepairAttempts = 0;
					}
					// Release a recorded CPA steering once any stream completes: a
					// successful stream consumed it, and a failed one ends the turn (a
					// later turn's different user prompt would expire it anyway).
					if (providerSessionState?.cpaToolAliasSteering) {
						providerSessionState.cpaToolAliasSteering = undefined;
					}
					break;
				} catch (streamError) {
					const localAbortReason = activeAbortTracker.getLocalAbortReason();
					// Normalize unknown rejections (a primitive string from an injected
					// custom client is a supported surface) to a mutable Error. Boxed
					// primitives silently discard every fact stamped below, which let
					// a ceiling-bound upload slip past the one-attempt ceiling and
					// string-matched corrective branches re-upload the body.
					const streamFailure = localAbortReason ?? normalizeStreamFailure(streamError);
					attachAnthropicGraceFailureFacts(streamFailure, {
						elapsedMs: Date.now() - (firstEventWaitStartedAt ?? Date.now()),
						requestBytes,
						firstEventTimeoutMs,
						endpointClass,
						awaitingFirstEvent: !sawFirstSemanticEvent,
					});
					// A ceiling-bound upload failed before stream iteration began (for
					// example an immediate 529 from withResponse()): the grace clock
					// never started, so the facts above cannot apply, but the one-attempt
					// upload ceiling must still bound the outer provider retry loop.
					// Otherwise the multi-megabyte body is re-uploaded up to the default
					// streamMaxRetries budget despite the ceiling. Once iteration has
					// begun, only the grace-clock path above decides.
					if (requestUploadCeilingBound && firstEventWaitStartedAt === undefined) {
						Object.assign(streamFailure as Error, {
							requestBytes,
							endpointClass,
							retryMaxAttempts: ANTHROPIC_LARGE_FIRST_EVENT_TIMEOUT_MAX_ATTEMPTS,
						});
					}
					const firstEventRetryMaxAttempts =
						typeof (streamFailure as { retryMaxAttempts?: unknown }).retryMaxAttempts === "number"
							? (streamFailure as { retryMaxAttempts: number }).retryMaxAttempts
							: undefined;
					if (localAbortReason || sawProviderSafetyStop) {
						throw streamFailure;
					}
					if (firstEventRetryMaxAttempts !== undefined && providerRetryAttempt + 1 >= firstEventRetryMaxAttempts) {
						throw streamFailure;
					}
					if (
						!options?.fallbackManaged &&
						!options?.disableProviderRetries &&
						!disableStrictTools &&
						firstTokenTime === undefined &&
						hasStrictAnthropicTools(params) &&
						isAnthropicStrictGrammarTooLargeError(streamFailure)
					) {
						strictFallbackErrorMessage = await finalizeErrorMessage(streamFailure, rawRequestDump);
						if (providerSessionState) {
							providerSessionState.strictToolsDisabled = true;
						}
						disableStrictTools = true;
						params = await prepareParams();
						providerRetryAttempt = 0;
						providerUploadCount++;
						resetOutputForRetry();
						continue;
					}
					if (
						!droppedForcedToolChoice &&
						firstTokenTime === undefined &&
						!options?.fallbackManaged &&
						!options?.disableProviderRetries &&
						isSentForcedAnthropicToolChoice(params.tool_choice) &&
						isForcedToolChoiceUnsupportedError(streamFailure, true)
					) {
						const message = await finalizeErrorMessage(streamFailure, rawRequestDump);
						logger.debug("anthropic: forced tool_choice unsupported, retrying with auto tool choice", {
							model: model.id,
							error: message,
						});
						markToolChoiceIncapability(model, "auto", message);
						stream.push({
							type: "toolChoiceIncapability",
							api: output.api,
							provider: model.provider,
							model: model.id,
							requestedLevel: resolveToolChoice(model, options?.toolChoice).requestedLevel,
							resolvedLevel: "auto",
							reason: message,
							registryKey: resolveToolChoice(model, options?.toolChoice).registryKey,
						});
						droppedForcedToolChoice = true;
						params = await prepareParams();
						providerRetryAttempt = 0;
						providerUploadCount++;
						resetOutputForRetry();
						continue;
					}
					const thinkingSignatureInvalid = isAnthropicThinkingSignatureInvalidError(streamFailure);
					const thinkingBlocksImmutable = isAnthropicThinkingBlockMutationError(streamFailure);
					const maskedProxyRejection = isAnthropicMaskedProxyRejection(streamFailure);
					if (
						!options?.fallbackManaged &&
						!options?.disableProviderRetries &&
						thinkingReplayRepairScope === "none" &&
						thinkingReplayRepairAttempts < ANTHROPIC_MAX_THINKING_REPAIRS &&
						firstTokenTime === undefined &&
						(thinkingSignatureInvalid ||
							thinkingBlocksImmutable ||
							// Masked proxy rejection: unclassifiable on its own, so the replayed
							// request shape is the evidence. Without signed thinking blocks in
							// flight there is nothing to repair and the error must surface.
							(maskedProxyRejection && hasNativeThinkingBlocks(params.messages)))
					) {
						const rejectedFingerprint = fingerprintAnthropicPayload(params);
						const scopes: Array<Exclude<AnthropicThinkingReplayRepairScope, "none">> = thinkingSignatureInvalid
							? ["all"]
							: ["latest", "all"];
						let candidate: AnthropicThinkingRepairCandidate | undefined;
						const transforms: Record<string, unknown> = {};
						for (const scope of scopes) {
							thinkingReplayRepairScope = scope;
							const candidateParams = await prepareParams();
							const fingerprint = fingerprintAnthropicPayload(candidateParams);
							const changed = anthropicPayloadChanged(rejectedFingerprint, fingerprint);
							transforms[scope] = { changed, sha256: fingerprint.sha256, bytes: fingerprint.bytes };
							if (changed) {
								candidate = { scope, params: candidateParams, fingerprint };
								break;
							}
						}
						if (rawRequestDump) {
							rawRequestDump.diagnostics = {
								...(rawRequestDump.diagnostics ?? {}),
								anthropicThinkingRepair: {
									rejected: rejectedFingerprint,
									disposition: candidate ? `send-${candidate.scope}` : "no-op-terminal",
									transforms,
									outgoingMismatch: describeAnthropicOutgoingPath(streamFailure, params),
								},
							};
						}
						const captured = await finalizeAnthropicErrorMessage(streamFailure, rawRequestDump);
						logger.warn("anthropic: thinking replay rejected; evaluated bounded repair", {
							model: model.id,
							disposition: candidate ? `send-${candidate.scope}` : "no-op-terminal",
							rejectedSha256: rejectedFingerprint.sha256,
							rejectedBytes: rejectedFingerprint.bytes,
							diagnostic: captured,
						});
						if (!candidate) {
							thinkingReplayRepairScope = "none";
							throw createAnthropicThinkingRepairNoopError(streamFailure, params, rejectedFingerprint, captured);
						}
						const nextScope = candidate.scope;
						thinkingReplayRepairAttempts++;
						logger.debug("anthropic: repairing assistant thinking replay after provider rejection", {
							model: model.id,
							scope: nextScope,
							attempt: thinkingReplayRepairAttempts,
							error: streamFailure instanceof Error ? streamFailure.message : String(streamFailure),
						});
						thinkingReplayRepairScope = nextScope;
						// Anything but the masked probe is caused by blocks that remain in
						// history, so this repair must survive the stream it is about to fix.
						if (!maskedProxyRejection) thinkingReplayRepairPersistent = true;
						if (providerSessionState) {
							providerSessionState.thinkingReplayRepairAttempts = thinkingReplayRepairAttempts;
							if (!maskedProxyRejection) {
								providerSessionState.thinkingReplayRepairScope = nextScope;
							}
						}
						params = candidate.params;
						// The corrective replay uploads the repaired body: count it so the
						// first-event timeout ceiling bounds TOTAL uploads (issue #4464).
						providerUploadCount++;
						// The provider retry budget is deliberately NOT reset here: a repair that
						// keeps being rejected must run out instead of renewing the budget it is
						// supposed to consume (issue #4011).
						resetOutputForRetry();
						continue;
					}
					// Managed attempts never take the repair branch above: the fallback
					// controller owns retries, so the provider must not retry inside the
					// attempt it was handed. That left the repair unreachable for the
					// coding agent, which prompts exclusively through managed attempts —
					// every turn rebuilt the same replay from the same history, drew the
					// same deterministic 400, and the session never converged (issue
					// #4262: one rejected 1.3 MB request every 12s, indefinitely).
					// Recording the escalation costs no round trip and keeps the retry
					// boundary intact: the next managed attempt builds a repaired replay.
					// The masked `api_error` stays out — it names no cause and may be a
					// transient blip, so only a rejection that provably indicts the
					// replayed thinking blocks may cost the session its native replay.
					if (
						options?.fallbackManaged &&
						providerSessionState &&
						providerSessionState.thinkingReplayRepairScope !== "all" &&
						firstTokenTime === undefined &&
						(thinkingSignatureInvalid || thinkingBlocksImmutable) &&
						hasNativeThinkingBlocks(params.messages)
					) {
						const rejectedFingerprint = fingerprintAnthropicPayload(params);
						thinkingReplayRepairScope = "all";
						const candidateParams = await prepareParams();
						const candidateFingerprint = fingerprintAnthropicPayload(candidateParams);
						const changed = anthropicPayloadChanged(rejectedFingerprint, candidateFingerprint);
						if (rawRequestDump) {
							rawRequestDump.diagnostics = {
								...(rawRequestDump.diagnostics ?? {}),
								anthropicThinkingRepair: {
									rejected: rejectedFingerprint,
									disposition: changed ? "record-all-for-managed-retry" : "no-op-terminal",
									transforms: {
										all: { changed, sha256: candidateFingerprint.sha256, bytes: candidateFingerprint.bytes },
									},
									outgoingMismatch: describeAnthropicOutgoingPath(streamFailure, params),
								},
							};
						}
						const captured = await finalizeAnthropicErrorMessage(streamFailure, rawRequestDump);
						logger.warn("anthropic: managed thinking replay rejected; evaluated repair", {
							model: model.id,
							disposition: changed ? "record-all-for-managed-retry" : "no-op-terminal",
							rejectedSha256: rejectedFingerprint.sha256,
							rejectedBytes: rejectedFingerprint.bytes,
							diagnostic: captured,
						});
						if (!changed) {
							thinkingReplayRepairScope = "none";
							throw createAnthropicThinkingRepairNoopError(streamFailure, params, rejectedFingerprint, captured);
						}
						logger.debug("anthropic: recording thinking replay repair for the next managed attempt", {
							model: model.id,
							error: streamFailure instanceof Error ? streamFailure.message : String(streamFailure),
						});
						providerSessionState.thinkingReplayRepairScope = "all";
						providerSessionState.thinkingReplayRejectedPayload = rejectedFingerprint;
					}
					if (
						!options?.fallbackManaged &&
						!options?.disableProviderRetries &&
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
						providerUploadCount++;
						resetOutputForRetry();
						continue;
					}
					if (
						!options?.fallbackManaged &&
						!options?.disableProviderRetries &&
						generatedCacheBudget > 0 &&
						firstTokenTime === undefined &&
						isAnthropicCacheBreakpointOverflowError(streamFailure)
					) {
						// The gateway's own markers already fill Anthropic's four slots, so
						// one of ours is the fifth. We cannot see the others, which makes the
						// rejection the only usable signal — and it says "too many", not
						// "none allowed". So give up one breakpoint at a time instead of all
						// caching at once: an endpoint that leaves a single slot free keeps
						// caching the conversation prefix, which is the marker that matters.
						const nextBudget: GeneratedCacheBudget = generatedCacheBudget === 2 ? 1 : 0;
						logger.debug("anthropic: cache breakpoint limit exceeded, reducing generated breakpoints", {
							model: model.id,
							from: generatedCacheBudget,
							to: nextBudget,
							error: streamFailure instanceof Error ? streamFailure.message : String(streamFailure),
						});
						if (providerSessionState) {
							providerSessionState.generatedCacheBudget = nextBudget;
						}
						generatedCacheBudget = nextBudget;
						params = await prepareParams();
						providerRetryAttempt = 0;
						providerUploadCount++;
						resetOutputForRetry();
						continue;
					}
					// CPA (Claude-OAuth proxy) alias-restore failure (issue #4338): the
					// proxy 500s the whole stream because the model emitted a cloaked
					// `mcp__<server>__<token>_<base>` tool name whose random token segment
					// matches nothing in the request. The generic 5xx retry below would
					// blindly re-send the unchanged request and re-sample the same drift;
					// instead, correct the request exactly once and terminalize on
					// recurrence. The narrow CPA phrase is the route gate, so native
					// Anthropic and non-CPA proxies are untouched.
					const cpaAliasFailure = parseCpaToolAliasRestoreFailure(streamFailure);
					if (cpaAliasFailure && firstTokenTime === undefined) {
						if (options?.fallbackManaged || options?.disableProviderRetries) {
							// The managed fallback controller owns retries: never retry
							// inside the attempt it handed us. Record the corrective
							// steering against this exact turn and surface the raw error;
							// the controller's next attempt rebuilds the request with the
							// steering. Without shared session state there is nowhere to
							// record, so fall through to the controller unchanged.
							if (!providerSessionState) throw streamFailure;
							const turnFingerprint = cpaTurnFingerprint(context.messages);
							if (providerSessionState.cpaToolAliasSteering?.turnFingerprint === turnFingerprint) {
								// The steering was already applied to this attempt and the proxy
								// rejected again: the single corrective attempt is spent. Surface
								// an actionable terminal error instead of another unchanged
								// resend.
								throw createCpaToolAliasTerminalError(
									cpaAliasFailure,
									resolveCpaCallableToolName(params, cpaAliasFailure),
								);
							}
							providerSessionState.cpaToolAliasSteering = {
								message: buildCpaToolAliasSteering(
									cpaAliasFailure,
									resolveCpaCallableToolName(params, cpaAliasFailure),
								),
								turnFingerprint,
							};
							logger.debug("anthropic: recording CPA tool alias steering for the next managed attempt", {
								model: model.id,
								alias: cpaAliasFailure.alias,
								baseName: cpaAliasFailure.baseName,
								error: streamFailure instanceof Error ? streamFailure.message : String(streamFailure),
							});
							throw streamFailure;
						}
						if (!cpaAliasRepairApplied) {
							cpaAliasRepairApplied = true;
							logger.debug("anthropic: repairing CPA tool alias restore failure with corrective steering", {
								model: model.id,
								alias: cpaAliasFailure.alias,
								baseName: cpaAliasFailure.baseName,
								error: streamFailure instanceof Error ? streamFailure.message : String(streamFailure),
							});
							appendCpaSteeringToMessages(
								params,
								buildCpaToolAliasSteering(cpaAliasFailure, resolveCpaCallableToolName(params, cpaAliasFailure)),
							);
							// Exactly one corrective attempt per request: the provider retry
							// budget is deliberately NOT reset, so a persistent failure runs
							// out instead of renewing the budget it is supposed to consume
							// (issue #4011), and the recurrence branch below terminalizes
							// before the generic 5xx retry can re-send the unchanged request.
							// This corrective replay uploads the steered body: count it so the
							// first-event timeout ceiling bounds TOTAL uploads (issue #4464).
							providerUploadCount++;
							resetOutputForRetry();
							continue;
						}
						throw createCpaToolAliasTerminalError(
							cpaAliasFailure,
							resolveCpaCallableToolName(params, cpaAliasFailure),
						);
					}
					const isTransientEnvelopeFailure =
						isTransientStreamParseError(streamFailure) || isTransientStreamEnvelopeError(streamFailure);
					const canRetryTransientEnvelopeFailure = isTransientEnvelopeFailure && !streamedReplayUnsafeContent;
					const canRetryProviderFailure =
						firstTokenTime === undefined && isProviderRetryableError(streamFailure, model.provider);
					if (
						activeAbortTracker.wasCallerAbort() ||
						(firstEventRetryMaxAttempts !== undefined &&
							providerRetryAttempt + 1 >= firstEventRetryMaxAttempts) ||
						providerRetryAttempt >= resolveRetryBudget(options?.streamMaxRetries, PROVIDER_MAX_RETRIES) ||
						(!canRetryTransientEnvelopeFailure && !canRetryProviderFailure)
					) {
						throw streamFailure;
					}
					providerRetryAttempt++;
					providerUploadCount++;
					const delayMs = PROVIDER_BASE_DELAY_MS * 2 ** (providerRetryAttempt - 1);
					if (options?.providerRetryWait) {
						await options.providerRetryWait(delayMs, options.signal);
					} else {
						await scheduler.wait(delayMs, { signal: options?.signal });
					}
					resetOutputForRetry();
				}
			}

			for (const block of blocksByAnthropicIndex.values()) {
				delete (block as { index?: number }).index;
				if (block.type === "toolCall") {
					truncatedToolCalls.add(block);
					block.incompleteArguments = true;
					block.incompleteArgumentsReason = "truncated";
					if (block.partialJson.trim()) {
						block.arguments = parseStreamingJson(block.partialJson);
						captureUnicodeEscapeEvidence(block, block.partialJson);
					}
					delete (block as { partialJson?: string }).partialJson;
				}
			}
			blocksByAnthropicIndex.clear();
			for (const block of output.content) {
				if (block.type === "toolCall" && truncatedToolCalls.has(block)) {
					block.incompleteArguments = true;
					block.incompleteArgumentsReason = "truncated";
				}
			}
			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			if (dropFastMode && resolveServiceTier(options?.serviceTier, model.provider) === "priority") {
				output.disabledFeatures = [...(output.disabledFeatures ?? []), "priority"];
			}
			// Defense-in-depth (#4443): when the provider stream assembles an
			// assistant message whose content carries directly adjacent private
			// blocks, emit a bounded diagnostic naming only the envelope shape —
			// block count and adjacent-pair presence — never raw thinking text,
			// signatures, or redacted payloads. The send-boundary collapse
			// remains the wire source of truth; this is a read-only observation.
			// Scoped to this stream invocation: each completed turn with the
			// defect is a distinct upstream producer worth surfacing, so the
			// diagnostic is not latched across invocations.
			if (hasAdjacentPrivateThinkingBlocks(output.content)) {
				logger.warn("anthropic: stream assembled assistant content with adjacent thinking blocks", {
					model: model.id,
					provider: model.provider,
					contentBlockCount: output.content.length,
					hasAdjacentPrivateBlocks: true,
				});
			}
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				delete (block as { partialJson?: string }).partialJson;
			}
			const localAbortReason = activeAbortTracker.getLocalAbortReason();
			output.stopReason = activeAbortTracker.wasCallerAbort() ? "aborted" : "error";
			output.errorStatus = extractHttpStatusFromError(localAbortReason ?? error);
			output.transportFailure = transportFailureFacts(localAbortReason ?? error) ?? output.transportFailure;
			if (output.errorKind !== "provider_safety_stop" || !output.errorMessage) {
				output.errorMessage =
					localAbortReason?.message ?? (await finalizeAnthropicErrorMessage(error, rawRequestDump));
			}
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
	const boundedFetch = wrapAnthropicFetchForBoundedRateLimits(baseFetch, args.maxRetryDelayMs);
	const debugFetch = onSseEvent ? wrapFetchForSseDebug(boundedFetch, event => onSseEvent(event, model)) : boundedFetch;
	// Bound the connect/headers phase. The first-event watchdog arms only after
	// response headers arrive, so a request whose connection dies before headers
	// was previously governed only by the Anthropic SDK's 10-minute default per
	// attempt times its internal retry budget — observable as an endless spinner
	// right after a completed tool call.
	const sdkTimeoutMs = resolveAnthropicSdkRequestTimeoutMs(
		model.provider,
		args.streamFirstEventTimeoutMs,
		args.streamIdleTimeoutMs,
	);
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
			maxRetries: resolveRetryBudget(args.requestMaxRetries, 5),
			...(sdkTimeoutMs !== undefined ? { timeout: sdkTimeoutMs } : {}),
			dangerouslyAllowBrowser: true,
			defaultHeaders,
			logLevel: ANTHROPIC_SDK_LOG_LEVEL,
			fetch: debugFetch,
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
		zcodeSourceHeaders: model.provider === "glm-zcode",
	});

	if (model.provider === "cloudflare-ai-gateway") {
		return {
			isOAuthToken: false,
			apiKey: null,
			authToken: null,
			baseURL: baseUrl,
			maxRetries: resolveRetryBudget(args.requestMaxRetries, 5),
			...(sdkTimeoutMs !== undefined ? { timeout: sdkTimeoutMs } : {}),
			dangerouslyAllowBrowser: true,
			defaultHeaders,
			logLevel: ANTHROPIC_SDK_LOG_LEVEL,
			fetch: debugFetch,
		};
	}

	// JetBrains AI (Ingrazzio) authenticates with a plain `Authorization: Bearer`
	// token and rejects requests that also carry `X-Api-Key`. `buildAnthropicHeaders`
	// already emits the bearer for non-Anthropic hosts, so keep the SDK from adding
	// its own API-key header on top of it.
	if (model.provider === "jetbrains-junie") {
		return {
			isOAuthToken: false,
			apiKey: null,
			authToken: null,
			baseURL: baseUrl,
			maxRetries: resolveRetryBudget(args.requestMaxRetries, 5),
			...(sdkTimeoutMs !== undefined ? { timeout: sdkTimeoutMs } : {}),
			dangerouslyAllowBrowser: true,
			defaultHeaders,
			logLevel: ANTHROPIC_SDK_LOG_LEVEL,
			fetch: debugFetch,
			...(tlsFetchOptions ? { fetchOptions: tlsFetchOptions } : {}),
		};
	}

	return {
		isOAuthToken: oauthToken,
		apiKey: oauthToken ? null : apiKey,
		authToken: oauthToken ? apiKey : undefined,
		baseURL: baseUrl,
		maxRetries: resolveRetryBudget(args.requestMaxRetries, 5),
		...(sdkTimeoutMs !== undefined ? { timeout: sdkTimeoutMs } : {}),
		dangerouslyAllowBrowser: true,
		defaultHeaders,
		logLevel: ANTHROPIC_SDK_LOG_LEVEL,
		fetch: debugFetch,
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

/**
 * Anthropic rejects extended thinking combined with a forced tool choice, so such a
 * request drops `thinking`/`output_config`. Reports whether the forced-choice branch
 * applied so the caller can keep the replayed history consistent with it.
 */
function disableThinkingIfToolChoiceForced(params: MessageCreateParamsStreaming): boolean {
	const toolChoice = params.tool_choice;
	if (!toolChoice) return false;
	if (toolChoice.type !== "any" && toolChoice.type !== "tool") return false;
	delete params.thinking;
	delete params.output_config;
	return true;
}

function hasNativeThinkingBlocks(messages: MessageParam[]): boolean {
	return messages.some(
		message =>
			Array.isArray(message.content) &&
			message.content.some(block => block.type === "thinking" || block.type === "redacted_thinking"),
	);
}

/**
 * Would the latest assistant turn lose a thinking block on its way to the wire?
 *
 * `convertAnthropicMessages` can only replay a `thinking` block natively when it
 * still carries the bytes Anthropic signed. A block that arrived as a bare
 * start/stop pair — no `thinking_delta`, no `signature_delta` — has neither, so
 * it is silently dropped, and Anthropic rejects the turn it produced for coming
 * back without it. Same for a `redactedThinking` block whose opaque payload is
 * gone. Only the latest assistant message is inspected because that is the turn
 * Anthropic validates against its own output.
 */
function latestAssistantThinkingIsUnreplayable(messages: Message[], model: Model<"anthropic-messages">): boolean {
	const index = messages.findLastIndex(message => message.role === "assistant");
	if (index < 0) return false;

	const assistant = messages[index] as AssistantMessage;
	// Cross-API history degrades to text rather than replaying native blocks, so
	// nothing is lost and nothing needs repairing.
	if (assistant.api !== "anthropic-messages") return false;
	// Endpoints that never sign thinking replay unsigned blocks verbatim.
	const requiresSignature = !isNonSigningAnthropicEndpoint(model);

	return assistant.content.some(block => {
		if (block.type === "redactedThinking") return block.data.trim().length === 0;
		if (block.type !== "thinking") return false;
		// A block with empty text and no signature cannot go back on the wire:
		// `convertAnthropicMessages` drops it, and Anthropic rejects the turn for
		// arriving without it. A block with a valid signature AND non-empty text is
		// replayable. But a signed block whose text was emptied — e.g. by
		// clear_thinking_20251015 — carries a stale signature that signing endpoints
		// reject on replay (issue #4247). Non-signing endpoints replay unsigned
		// blocks verbatim, so only they treat a missing signature as unreplayable.
		const hasSignature = !!block.thinkingSignature?.trim();
		const isEmpty = !block.thinking.trim();
		if (!hasSignature) return requiresSignature;
		if (isEmpty && requiresSignature) return true;
		return false;
	});
}

function mapAnthropicToolChoice(
	toolChoice: NonNullable<ResolveToolChoiceResult["resolvedChoice"]>,
	isOAuthToken: boolean,
): NonNullable<MessageCreateParamsStreaming["tool_choice"]> | undefined {
	if (typeof toolChoice === "string") {
		if (toolChoice === "required") return { type: "any" };
		return { type: toolChoice };
	}
	if ("function" in toolChoice) {
		const name = typeof toolChoice.function === "string" ? toolChoice.function : toolChoice.function.name;
		return { type: "tool", name: isOAuthToken ? applyClaudeToolPrefix(name) : name };
	}
	if ("name" in toolChoice && typeof toolChoice.name === "string") {
		return {
			...toolChoice,
			type: "tool",
			name: isOAuthToken ? applyClaudeToolPrefix(toolChoice.name) : toolChoice.name,
		};
	}
	return toolChoice as NonNullable<MessageCreateParamsStreaming["tool_choice"]>;
}
function isSentForcedAnthropicToolChoice(toolChoice: MessageCreateParamsStreaming["tool_choice"] | undefined): boolean {
	return toolChoice?.type === "any" || toolChoice?.type === "tool";
}

function ensureMaxTokensForThinking(params: MessageCreateParamsStreaming, model: Model<"anthropic-messages">): void {
	const thinking = params.thinking;
	if (thinking?.type !== "enabled") return;

	const budgetTokens = thinking.budget_tokens ?? 0;
	if (budgetTokens <= 0) return;

	const maxTokens = params.max_tokens ?? 0;
	const requiredMaxTokens = budgetTokens + OUTPUT_FALLBACK_BUFFER;
	if (maxTokens < requiredMaxTokens) {
		const modelMaxTokens =
			Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0
				? model.maxTokens
				: Math.max(maxTokens, requiredMaxTokens);
		params.max_tokens = Math.min(requiredMaxTokens, modelMaxTokens);
	}
	// Anthropic requires budget_tokens strictly below max_tokens; when the cap
	// cannot fit the requested budget plus the output buffer, shrink the budget
	// (or disable thinking) instead of sending an invalid pair.
	const cappedBudget = params.max_tokens - OUTPUT_FALLBACK_BUFFER;
	if (cappedBudget < budgetTokens) {
		if (cappedBudget <= 0) {
			params.thinking = { type: "disabled" };
		} else {
			params.thinking = { type: "enabled", budget_tokens: cappedBudget };
		}
	}
}

type CacheControlBlock = {
	cache_control?: AnthropicCacheControl | null;
};

type AnthropicCacheParams = MessageCreateParamsStreaming & {
	cache_control?: AnthropicCacheControl;
};

type AnthropicCacheMode = "automatic" | "explicit" | "none";

function isCacheableContentBlock(block: ContentBlockParam): boolean {
	if (block.type === "thinking" || block.type === "redacted_thinking") return false;
	return block.type !== "text" || block.text.trim().length > 0;
}

function cacheControlError(path: string, reason: string): Error {
	return new Error(`Invalid Anthropic cache_control at ${path}: ${reason}`);
}

function validateCacheControl(control: unknown, path: string, seenFiveMinute: { value: boolean }): void {
	if (!isRecord(control) || control.type !== "ephemeral") {
		throw cacheControlError(path, 'expected { type: "ephemeral" }');
	}
	if (control.ttl !== undefined && control.ttl !== "5m" && control.ttl !== "1h") {
		throw cacheControlError(path, 'ttl must be "5m" or "1h"');
	}
	if (control.ttl === "1h") {
		if (seenFiveMinute.value) throw cacheControlError(path, "1h TTL must precede 5m TTL");
		return;
	}
	seenFiveMinute.value = true;
}

function validateCacheControls(params: AnthropicCacheParams): void {
	const seenFiveMinute = { value: false };
	let count = 0;
	const validate = (control: unknown, path: string): void => {
		if (control == null) return;
		count++;
		validateCacheControl(control, path, seenFiveMinute);
	};
	if (!Array.isArray(params.messages)) throw cacheControlError("messages", "must be an array");

	validate(params.cache_control, "cache_control");
	for (const [index, tool] of (params.tools ?? []).entries()) {
		validate((tool as CacheControlBlock).cache_control, `tools[${index}].cache_control`);
	}
	if (Array.isArray(params.system)) {
		for (const [index, block] of params.system.entries()) {
			validate((block as CacheControlBlock).cache_control, `system[${index}].cache_control`);
		}
	}
	for (const [messageIndex, message] of params.messages.entries()) {
		if (!Array.isArray(message.content)) continue;
		for (const [blockIndex, block] of message.content.entries()) {
			const control = (block as CacheControlBlock).cache_control;
			if (control != null && !isCacheableContentBlock(block)) {
				throw cacheControlError(
					`messages[${messageIndex}].content[${blockIndex}].cache_control`,
					"block is not cacheable",
				);
			}
			validate(control, `messages[${messageIndex}].content[${blockIndex}].cache_control`);
		}
	}
	if (count > 4) throw cacheControlError("cache_control", "at most four total breakpoints are allowed");
}

function applyCacheControlToLastCacheableBlock(
	blocks: Array<ContentBlockParam & CacheControlBlock>,
	cacheControl: AnthropicCacheControl,
): boolean {
	for (let index = blocks.length - 1; index >= 0; index--) {
		const block = blocks[index];
		if (!isCacheableContentBlock(block)) continue;
		blocks[index] = { ...block, cache_control: { ...cacheControl } };
		return true;
	}
	return false;
}

function isHumanUserMessage(message: MessageCreateParamsStreaming["messages"][number]): boolean {
	if (message.role !== "user") return false;
	if (typeof message.content === "string") return true;
	return message.content.some(block => block.type !== "tool_result");
}

function applyExplicitPromptCaching(
	params: AnthropicCacheParams,
	cacheControl: AnthropicCacheControl,
	budget: GeneratedCacheBudget,
): void {
	if (budget === 0) return;
	if (countCacheControlBreakpoints(params) >= 4) return;

	const currentUserIndex = params.messages.findLastIndex(isHumanUserMessage);
	if (currentUserIndex < 0) return;
	const currentUser = params.messages[currentUserIndex];
	if (!currentUser) return;

	// Tool results are encoded as role "user" on the wire but belong to the
	// assistant tool-use turn immediately before them. Anchor the latest completed
	// assistant turn so the reusable prefix advances during an agent tool loop,
	// while keeping the newest tool output outside the cache boundary.
	//
	// This anchor is the higher-value marker of the two: it covers the whole
	// conversation prefix, so a reduced budget is spent here first. It only
	// consumes budget when a marker is actually placed — on a first turn there is
	// no assistant message yet, and the reduced budget must still reach the
	// current-turn marker below rather than emitting nothing at all.
	let remaining: number = budget;
	for (let index = params.messages.length - 1; index >= 0; index--) {
		const message = params.messages[index];
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		if (
			applyCacheControlToLastCacheableBlock(
				message.content as Array<ContentBlockParam & CacheControlBlock>,
				cacheControl,
			)
		) {
			remaining -= 1;
			break;
		}
	}

	if (remaining < 1) return;
	if (countCacheControlBreakpoints(params) >= 4) return;
	if (typeof currentUser.content === "string" && currentUser.content.trim()) {
		currentUser.content = [{ type: "text", text: currentUser.content, cache_control: { ...cacheControl } }];
	} else if (Array.isArray(currentUser.content)) {
		applyCacheControlToLastCacheableBlock(
			currentUser.content as Array<ContentBlockParam & CacheControlBlock>,
			cacheControl,
		);
	}
}

function applyPromptCaching(
	params: AnthropicCacheParams,
	cacheMode: AnthropicCacheMode,
	cacheControl?: AnthropicCacheControl,
	budget: GeneratedCacheBudget = 2,
): void {
	if (!cacheControl || cacheMode === "none" || budget === 0) return;
	validateCacheControls(params);
	if (cacheMode === "automatic") {
		// Automatic mode only ever emits one marker, so any non-zero budget
		// covers it; the zero case already returned above.
		params.cache_control = { ...cacheControl };
		return;
	}
	applyExplicitPromptCaching(params, cacheControl, budget);
	validateCacheControls(params);
}

export function normalizeCacheControlTtlOrdering(params: MessageCreateParamsStreaming): void {
	validateCacheControls(params as AnthropicCacheParams);
}

function countCacheControlBreakpoints(params: AnthropicCacheParams): number {
	let total = params.cache_control ? 1 : 0;
	for (const tool of params.tools ?? []) if ((tool as CacheControlBlock).cache_control) total++;
	if (Array.isArray(params.system)) {
		for (const block of params.system) if ((block as CacheControlBlock).cache_control) total++;
	}
	for (const message of params.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) if ((block as CacheControlBlock).cache_control) total++;
	}
	return total;
}

function enforceCacheControlLimit(params: MessageCreateParamsStreaming, maxBreakpoints: number): void {
	if (maxBreakpoints !== 4) throw new Error("Anthropic supports exactly four cache breakpoints");
	validateCacheControls(params as AnthropicCacheParams);
}

function buildParams(
	model: Model<"anthropic-messages">,
	baseUrl: string,
	context: Context,
	isOAuthToken: boolean,
	options?: AnthropicOptions,
	disableStrictTools = false,
	thinkingRepair?: { repairLatestAssistantThinking?: boolean; repairAllAssistantThinking?: boolean },
	generatedCacheBudget: GeneratedCacheBudget = 2,
): MessageCreateParamsStreaming {
	const { mode: cacheMode, cacheControl } = getCacheControl(
		model,
		baseUrl,
		options?.cacheRetention,
		generatedCacheBudget,
	);

	const params: AnthropicSamplingParams = {
		model: model.id,
		messages: convertAnthropicMessages(context.messages, model, isOAuthToken, thinkingRepair),
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
			// The Claude Code OAuth surface mishandles `strict: true` tools:
			// streamed tool_use blocks arrive with empty/undefined arguments and
			// occasionally corrupted names (works with PI_NO_STRICT=1). Never
			// request strict tool use on OAuth requests.
			disableStrictTools || isOAuthToken || model.provider === "github-copilot",
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
					// SDK OutputConfig.effort typings may lag Anthropic's adaptive effort literals.
					// Cast so newly supported levels can pass through before the SDK catches up.
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
		const resolution = resolveToolChoice(model, options.toolChoice);
		if (resolution.degraded && resolution.supportSource !== "runtime") {
			logger.debug("anthropic: degrading tool_choice for model capability", {
				model: model.id,
				requestedLevel: resolution.requestedLevel,
				resolvedLevel: resolution.resolvedLevel,
				reason: resolution.reason,
				supportSource: resolution.supportSource,
			});
		}
		if (resolution.resolvedChoice) {
			const mappedToolChoice = mapAnthropicToolChoice(resolution.resolvedChoice, isOAuthToken);
			if (mappedToolChoice) {
				params.tool_choice = mappedToolChoice;
			}
		}
	}

	// A forced tool choice strips `thinking` from the request. Signed thinking blocks
	// replayed from history belong to a thinking-enabled request, and Anthropic rejects
	// that pair with `thinking`/`redacted_thinking` blocks "cannot be modified", so the
	// replay has to degrade in the same rebuild. Runs before the billing/system payload
	// snapshot so the attribution hash covers the messages actually sent.
	if (disableThinkingIfToolChoiceForced(params) && hasNativeThinkingBlocks(params.messages)) {
		params.messages = convertAnthropicMessages(context.messages, model, isOAuthToken, {
			...thinkingRepair,
			repairAllAssistantThinking: true,
		});
	}

	// Anthropic compares the latest assistant message against the turn it actually
	// produced, and rejects it when a `thinking`/`redacted_thinking` block that was
	// in that response is missing. A block Anthropic streamed as a start/stop pair
	// with no `thinking_delta` and no `signature_delta` lands in history empty and
	// unsigned, and `convertAnthropicMessages` then drops it: the turn goes back
	// carrying only its `tool_use`, and the request is rejected before a token
	// streams. The rejection is recoverable — the repair drops native thinking from
	// the whole replay — but only after a full round trip has been spent, and the
	// condition is visible locally, so detect it here and degrade in the first
	// build instead of paying for the 400 to discover it.
	if (
		!thinkingRepair?.repairAllAssistantThinking &&
		latestAssistantThinkingIsUnreplayable(context.messages, model) &&
		hasNativeThinkingBlocks(params.messages)
	) {
		params.messages = convertAnthropicMessages(context.messages, model, isOAuthToken, {
			...thinkingRepair,
			repairAllAssistantThinking: true,
		});
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
	ensureMaxTokensForThinking(params, model);
	applyPromptCaching(params as AnthropicCacheParams, cacheMode, cacheControl, generatedCacheBudget);
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
	if (model.provider === "zai" || model.provider === "glm-zcode") return true;
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
	if (model.provider === "zai" || model.provider === "glm-zcode" || model.provider === "deepseek") return true;
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

/**
 * Anthropic rejects a replayed assistant message containing adjacent
 * `thinking`/`redacted_thinking` blocks — even when each block individually
 * carries a valid signature — with a 400 citing the second block: "cannot be
 * modified. These blocks must remain as in the original response." (issue #4416)
 *
 * The adjacency can originate from the provider stream (two `content_block_start`
 * events for `thinking` in one message with no intervening `tool_use`), from a
 * history mutation that removed a separating `tool_use`, or from an earlier
 * conversion phase in `convertAnthropicMessages` that skipped an empty `text`
 * block sitting between two thinking blocks. Because that last path exists, the
 * invariant cannot be enforced in the shared `transformMessages` phase — it must
 * run on the final wire output.
 *
 * This collapses each run of adjacent `thinking`/`redacted_thinking` blocks down
 * to the first block, preserving its bytes, signature, and type verbatim (never
 * concatenating, editing, synthesizing, or choosing the last). Blocks separated
 * by any non-thinking block (`text`, `tool_use`, …) are legitimate
 * interleaved-thinking shape and pass through unchanged. `thinking` and
 * `redacted_thinking` are treated as one adjacency class per the API contract.
 *
 * The pass is O(n) per message and idempotent: an already-collapsed array is a
 * no-op, so re-runs through `convertAnthropicMessages` (e.g. forced-tool-choice
 * or unreplayable-thinking rebuilds) are safe.
 */
function collapseAdjacentThinkingBlocks(messages: MessageParam[]): void {
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		const content = message.content;
		let write = 0;
		let inThinkingRun = false;
		for (let read = 0; read < content.length; read++) {
			const block = content[read];
			if (block === undefined) continue;
			const isThinkingBlock = block.type === "thinking" || block.type === "redacted_thinking";
			if (isThinkingBlock && inThinkingRun) continue; // only the first block of a run survives
			inThinkingRun = isThinkingBlock;
			content[write++] = block;
		}
		if (write < content.length) content.length = write;
	}
}

export function convertAnthropicMessages(
	messages: Message[],
	model: Model<"anthropic-messages">,
	isOAuthToken: boolean,
	options?: { repairLatestAssistantThinking?: boolean; repairAllAssistantThinking?: boolean },
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
						input: sanitizeJsonStrings(block.arguments ?? {}),
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

	// Final send-time invariant (issue #4416): collapse any run of adjacent
	// `thinking`/`redacted_thinking` blocks within one assistant message down to
	// the first block. This runs on the wire output because earlier phases here
	// (e.g. skipping empty text blocks) can themselves create the adjacency.
	collapseAdjacentThinkingBlocks(params);
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
	return flattenToolRootCombinators(
		normalizeAnthropicToolSchema({
			...jsonSchema,
			type: "object",
			properties: isRecord(jsonSchema.properties) ? jsonSchema.properties : {},
			required: Array.isArray(jsonSchema.required)
				? jsonSchema.required.filter((entry): entry is string => typeof entry === "string")
				: [],
		}) as Record<string, unknown>,
	);
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

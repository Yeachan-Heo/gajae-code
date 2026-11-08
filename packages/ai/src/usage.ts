/**
 * Usage reporting types for provider quota/limit endpoints.
 *
 * Provides a normalized schema to represent multiple limit windows, model tiers,
 * and shared quotas across providers.
 */
import * as z from "zod/v4";
import type { Provider } from "./types";
export type UsageUnit = "percent" | "tokens" | "requests" | "usd" | "minutes" | "bytes" | "unknown";

export type UsageStatus = "ok" | "warning" | "exhausted" | "unknown";

/** Authentication rejection, distinct from an unavailable usage report. */
export class UsageAuthenticationError extends Error {
	constructor(provider: Provider) {
		super(`${provider} usage request rejected authentication (HTTP 401)`);
		this.name = "UsageAuthenticationError";
	}
}

/** Time window for a limit (e.g. 5h, 7d, monthly). */
export interface UsageWindow {
	/** Stable identifier (e.g. "5h", "7d", "monthly"). */
	id: string;
	/** Human label (e.g. "5 Hour", "7 Day"). */
	label: string;
	/** Window duration in milliseconds, when known. */
	durationMs?: number;
	/** Absolute reset timestamp in milliseconds since epoch. */
	resetsAt?: number;
}

/** Quantitative usage data. */
export interface UsageAmount {
	/** Amount used in the given unit. */
	used?: number;
	/** Maximum limit in the given unit. */
	limit?: number;
	/** Remaining amount in the given unit. */
	remaining?: number;
	/** Fraction used (0..1). */
	usedFraction?: number;
	/** Fraction remaining (0..1). */
	remainingFraction?: number;
	/** Unit for the amounts (percent, tokens, etc.). */
	unit: UsageUnit;
}

/** Scope metadata describing what the limit applies to. */
export interface UsageScope {
	provider: Provider;
	accountId?: string;
	projectId?: string;
	orgId?: string;
	modelId?: string;
	tier?: string;
	windowId?: string;
	shared?: boolean;
}

/** Normalized limit entry for a single window or quota bucket. */
export interface UsageLimit {
	/** Stable identifier for this limit entry. */
	id: string;
	/** Human label for display. */
	label: string;
	scope: UsageScope;
	window?: UsageWindow;
	amount: UsageAmount;
	status?: UsageStatus;
	notes?: string[];
}

/** Aggregated usage report for a provider. */
export interface UsageReport {
	provider: Provider;
	fetchedAt: number;
	limits: UsageLimit[];
	metadata?: Record<string, unknown>;
	raw?: unknown;
}

/** Antigravity editor-only completion models (tab/inline chat) never consume agent quota. */
const ANTIGRAVITY_EDITOR_ONLY_MODEL = /^(tab_|chat_)/;

export function isAntigravityAgentQuotaModel(modelId: string): boolean {
	return !ANTIGRAVITY_EDITOR_ONLY_MODEL.test(modelId);
}

export type AntigravityQuotaPoolId = "claude-gpt" | "gemini-argon" | "gemini";

/**
 * Canonical quota pool identifier for a Google Antigravity model id. Models in
 * the same pool share a single 5-hour and weekly quota bucket.
 */
export function resolveAntigravityQuotaPool(modelId: string): AntigravityQuotaPoolId | undefined {
	const id = modelId.trim().toLowerCase();
	if (!id || !isAntigravityAgentQuotaModel(id)) return undefined;
	if (id.startsWith("claude") || id.startsWith("gpt-oss") || id.startsWith("gpt-")) return "claude-gpt";
	if (id.startsWith("gemini") && id.includes("argon")) return "gemini-argon";
	if (id.startsWith("gemini")) return "gemini";
	return undefined;
}

/**
 * Display label for the Antigravity quota pool a model draws from. The API
 * returns one entry per model while models share a few quotas (identical
 * remainingFraction/resetTime across members): Claude + GPT-OSS, Gemini 4
 * Argon (weekly), and the remaining Gemini models.
 */
export function antigravityQuotaPoolLabel(modelId: string): string {
	const pool = resolveAntigravityQuotaPool(modelId);
	if (pool === "claude-gpt") return "Claude / GPT-OSS";
	if (pool === "gemini-argon") return "Gemini Argon";
	if (pool === "gemini") return "Gemini";
	return modelId;
}

/**
 * Normalize a limit for display. Antigravity reports may come from the shared
 * usage cache written by older binaries (per-model labels, missing zero
 * fractions), so the pool label is derived from scope.modelId, not the label.
 */
const ANTIGRAVITY_FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000;
const ANTIGRAVITY_WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ANTIGRAVITY_FIVE_HOUR_HORIZON_SKEW_MS = 5 * 60 * 1000;

function normalizeAntigravityDisplayWindow(
	window: UsageWindow | undefined,
	scopeWindowId: string | undefined,
): UsageWindow | undefined {
	if (!window) return undefined;
	const rawId = (window.id || scopeWindowId || "").trim().toLowerCase();
	if (rawId === "5h") {
		return {
			...window,
			id: "5h",
			label: window.label && window.label !== "Default" ? window.label : "5 Hour",
			durationMs: window.durationMs ?? ANTIGRAVITY_FIVE_HOUR_WINDOW_MS,
		};
	}
	if (rawId === "7d" || rawId === "weekly") {
		return {
			...window,
			id: "7d",
			label: window.label && window.label !== "Default" && window.label !== "Weekly" ? window.label : "7 Day",
			durationMs: window.durationMs ?? ANTIGRAVITY_WEEKLY_WINDOW_MS,
		};
	}
	if ((!rawId || rawId === "default") && typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)) {
		const remainingMs = window.resetsAt - Date.now();
		if (remainingMs <= ANTIGRAVITY_FIVE_HOUR_WINDOW_MS + ANTIGRAVITY_FIVE_HOUR_HORIZON_SKEW_MS) {
			return {
				...window,
				id: "5h",
				label: "5 Hour",
				durationMs: ANTIGRAVITY_FIVE_HOUR_WINDOW_MS,
			};
		}
		return {
			...window,
			id: "7d",
			label: "7 Day",
			durationMs: ANTIGRAVITY_WEEKLY_WINDOW_MS,
		};
	}
	return window;
}

function displayLimit(limit: UsageLimit, collapseArgonIntoGemini = false): UsageLimit | undefined {
	const modelId = limit.scope.modelId;
	if (limit.scope.provider !== "google-antigravity" || !modelId) return limit;
	if (!isAntigravityAgentQuotaModel(modelId)) return undefined;
	let amount = limit.amount;
	let status = limit.status;
	const resetsAt = limit.window?.resetsAt;
	if (
		amount.remainingFraction === undefined &&
		amount.usedFraction === undefined &&
		typeof resetsAt === "number" &&
		Number.isFinite(resetsAt)
	) {
		amount = { unit: "percent", remainingFraction: 0, usedFraction: 1, remaining: 0, used: 100, limit: 100 };
		status = "exhausted";
	}
	const window = normalizeAntigravityDisplayWindow(limit.window, limit.scope.windowId);
	const rawPoolLabel = antigravityQuotaPoolLabel(modelId);
	const label =
		rawPoolLabel === "Gemini Argon" && (limit.label === "Gemini" || collapseArgonIntoGemini)
			? "Gemini"
			: rawPoolLabel;
	return {
		...limit,
		label,
		scope: window ? { ...limit.scope, windowId: window.id } : limit.scope,
		window,
		amount,
		status,
	};
}

function usedFractionOf(limit: UsageLimit): number {
	const { amount } = limit;
	if (amount.usedFraction !== undefined) return amount.usedFraction;
	if (amount.remainingFraction !== undefined) return 1 - amount.remainingFraction;
	if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0) return amount.used / amount.limit;
	return -1;
}

function quotaSignature(limit: UsageLimit): string {
	const window = normalizeAntigravityDisplayWindow(limit.window, limit.scope.windowId);
	const windowId = window?.id ?? limit.scope.windowId ?? "default";
	const resetsAt = window?.resetsAt ?? 0;
	const used = Math.round(Math.max(0, usedFractionOf(limit)) * 10_000);
	return `${limit.scope.tier ?? ""}|${windowId}|${resetsAt}|${used}`;
}

/**
 * Collapse limits that render as the same meter: one entry per
 * (label, tier, window) within a single report. Providers such as Antigravity
 * report one model-scoped limit per model while many models draw from one
 * shared quota; credential rotation keeps those per-model limits, display
 * shows the pool once. On Ultra plans where Gemini 4 Argon shares the main
 * Gemini quota bucket (identical window/reset/usage), Argon folds into Gemini;
 * on Pro plans where Argon has a separate weekly quota, it renders separately.
 */
export function collapseUsageLimitsForDisplay(limits: readonly UsageLimit[]): UsageLimit[] {
	const generalGeminiSignatures = new Set<string>();
	for (const raw of limits) {
		const modelId = raw.scope.modelId;
		if (raw.scope.provider !== "google-antigravity" || !modelId) continue;
		if (resolveAntigravityQuotaPool(modelId) === "gemini") {
			generalGeminiSignatures.add(quotaSignature(raw));
		}
	}

	const byKey = new Map<string, UsageLimit>();
	for (const raw of limits) {
		const modelId = raw.scope.modelId;
		const isSharedArgon =
			raw.scope.provider === "google-antigravity" &&
			modelId !== undefined &&
			resolveAntigravityQuotaPool(modelId) === "gemini-argon" &&
			generalGeminiSignatures.has(quotaSignature(raw));
		const limit = displayLimit(raw, isSharedArgon);
		if (!limit) continue;
		const windowId = limit.window?.id ?? limit.scope.windowId ?? "default";
		const key = `${limit.label}|${limit.scope.tier ?? ""}|${windowId}`;
		const existing = byKey.get(key);
		if (!existing || usedFractionOf(limit) > usedFractionOf(existing)) byKey.set(key, limit);
	}
	return Array.from(byKey.values());
}

// ─── Zod schemas (wire-shape validation for the broker `/v1/usage` endpoint) ─

export const usageUnitSchema = z.enum(["percent", "tokens", "requests", "usd", "minutes", "bytes", "unknown"]);
export const usageStatusSchema = z.enum(["ok", "warning", "exhausted", "unknown"]);

export const usageWindowSchema = z.object({
	id: z.string(),
	label: z.string(),
	durationMs: z.number().optional(),
	resetsAt: z.number().optional(),
});

export const usageAmountSchema = z.object({
	used: z.number().optional(),
	limit: z.number().optional(),
	remaining: z.number().optional(),
	usedFraction: z.number().optional(),
	remainingFraction: z.number().optional(),
	unit: usageUnitSchema,
});

export const usageScopeSchema = z.object({
	provider: z.string(),
	accountId: z.string().optional(),
	projectId: z.string().optional(),
	orgId: z.string().optional(),
	modelId: z.string().optional(),
	tier: z.string().optional(),
	windowId: z.string().optional(),
	shared: z.boolean().optional(),
});

export const usageLimitSchema = z.object({
	id: z.string(),
	label: z.string(),
	scope: usageScopeSchema,
	window: usageWindowSchema.optional(),
	amount: usageAmountSchema,
	status: usageStatusSchema.optional(),
	notes: z.array(z.string()).optional(),
});

export const usageReportSchema = z.object({
	provider: z.string(),
	fetchedAt: z.number(),
	limits: z.array(usageLimitSchema),
	metadata: z.record(z.string(), z.unknown()).optional(),
	// `raw` is provider-specific and may be anything; the broker strips it before
	// sending the report over the wire, so accept-but-ignore here.
	raw: z.unknown().optional(),
});

/** Optional logger for usage fetchers. */
export interface UsageLogger {
	debug(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
}

/** Credential bundle for usage endpoints. */
/** MCP OAuth authority carried through usage-triggered refresh. */
export interface UsageMCPOAuthBinding {
	resourceOrigin: string;
	tokenEndpoint: string;
}

export interface UsageCredential {
	type: "api_key" | "oauth";
	apiKey?: string;
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number;
	accountId?: string;
	projectId?: string;
	email?: string;
	enterpriseUrl?: string;
	profileArn?: string;
	/** Organization the OAuth token is scoped to; usage limits are per organization. */
	organizationId?: string;
	organizationName?: string;
	mcpBinding?: UsageMCPOAuthBinding;
	metadata?: Record<string, unknown>;
}

/** Parameters provided to a usage fetcher. */
export interface UsageFetchParams {
	provider: Provider;
	credential: UsageCredential;
	baseUrl?: string;
	signal?: AbortSignal;
}

/** Shared runtime utilities for fetchers. */
export interface UsageFetchContext {
	fetch: typeof fetch;
	logger?: UsageLogger;
	retryWait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

/** Provider implementation for fetching usage information. */
export interface UsageProvider {
	id: Provider;
	fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null>;
	supports?(params: UsageFetchParams): boolean;
}

/** Strategy for usage-based credential ranking. Providers implement this to opt into smart credential selection. */
export interface CredentialRankingStrategy {
	/** Extract the primary (short) and secondary (long) window limits from a usage report. */
	findWindowLimits(report: UsageReport): {
		primary?: UsageLimit;
		secondary?: UsageLimit;
	};
	/** Fallback window durations (ms) when limits don't specify durationMs. */
	windowDefaults: {
		primaryMs: number;
		secondaryMs: number;
	};
	/** Optional: priority boost for specific credential states (e.g., fresh 5h ticker start). */
	hasPriorityBoost?(primary: UsageLimit | undefined): boolean;
}

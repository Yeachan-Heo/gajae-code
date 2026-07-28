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
export interface UsageCredential {
	type: "api_key" | "oauth";
	apiKey?: string;
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number;
	accountId?: string;
	projectId?: string;
	email?: string;
	/** Stable row id from the credential store; never sent to providers. */
	credentialId?: number;
	enterpriseUrl?: string;
	kiroMethod?: "builder-id" | "google" | "github";
	kiroProfileArn?: string;
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
	fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
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

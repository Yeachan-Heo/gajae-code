import { getAntigravityUserAgent } from "../providers/google-gemini-headers";
import type {
	CredentialRankingStrategy,
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageWindow,
} from "../usage";
import { antigravityQuotaPoolLabel, isAntigravityAgentQuotaModel, resolveAntigravityQuotaPool } from "../usage";

// (Refresh is the sole responsibility of AuthStorage; no provider-direct refresh here.)

interface AntigravityQuotaInfo {
	remainingFraction?: number;
	resetTime?: string;
	tier?: string;
	windowId?: string;
	windowLabel?: string;
}

interface AntigravityModelInfo {
	displayName?: string;
	isInternal?: boolean;
	quotaInfo?: AntigravityQuotaInfo | AntigravityQuotaInfo[];
	quotaInfos?: AntigravityQuotaInfo[];
	quotaInfoByTier?: Record<string, AntigravityQuotaInfo | AntigravityQuotaInfo[]>;
}

interface AntigravityUsageResponse {
	models: Record<string, AntigravityModelInfo>;
}

interface AntigravityQuotaSummaryBucket {
	bucketId?: string;
	displayName?: string;
	description?: string;
	window?: string;
	resetTime?: string;
	remainingFraction?: number;
}

interface AntigravityQuotaSummaryGroup {
	displayName?: string;
	description?: string;
	buckets?: AntigravityQuotaSummaryBucket[];
}

interface AntigravityQuotaSummaryResponse {
	groups?: AntigravityQuotaSummaryGroup[];
	buckets?: AntigravityQuotaSummaryBucket[];
}

const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";
const RETRIEVE_USER_QUOTA_SUMMARY_PATH = "/v1internal:retrieveUserQuotaSummary";

export const ANTIGRAVITY_FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000;
export const ANTIGRAVITY_WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Tolerance for slight server/client clock skew around the 5-hour horizon:
 * an untouched 5-hour window reports `resetTime = serverNow + 5h`, which can
 * land a few seconds past `clientNow + 5h`.
 */
const FIVE_HOUR_HORIZON_SKEW_MS = 5 * 60 * 1000;

function clampFraction(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function getUsageStatus(remainingFraction: number | undefined): UsageStatus | undefined {
	if (remainingFraction === undefined) return "unknown";
	if (remainingFraction <= 0) return "exhausted";
	if (remainingFraction <= 0.1) return "warning";
	return "ok";
}

function parseWindow(info: AntigravityQuotaInfo, nowMs: number): UsageWindow | undefined {
	if (!info.resetTime) return undefined;
	const resetAt = Date.parse(info.resetTime);
	if (!Number.isFinite(resetAt)) return undefined;
	const explicitId = info.windowId?.trim();
	const normalizedId = explicitId?.toLowerCase();
	if (normalizedId === "5h") {
		return {
			id: "5h",
			label: info.windowLabel ?? "5 Hour",
			durationMs: ANTIGRAVITY_FIVE_HOUR_WINDOW_MS,
			resetsAt: resetAt,
		};
	}
	if (normalizedId === "7d" || normalizedId === "weekly") {
		return {
			id: "7d",
			label: info.windowLabel ?? "7 Day",
			durationMs: ANTIGRAVITY_WEEKLY_WINDOW_MS,
			resetsAt: resetAt,
		};
	}
	if (explicitId && normalizedId !== "default") {
		return {
			id: explicitId,
			label: info.windowLabel ?? explicitId,
			resetsAt: resetAt,
		};
	}
	// Antigravity enforces both a 5-hour rolling window and a 7-day weekly
	// window per quota pool, and `fetchAvailableModels` reports whichever
	// window is the active bottleneck. Resets within the 5-hour horizon belong
	// to the 5-hour window; resets further out belong to the weekly window.
	const remainingWindowMs = resetAt - nowMs;
	if (remainingWindowMs <= ANTIGRAVITY_FIVE_HOUR_WINDOW_MS + FIVE_HOUR_HORIZON_SKEW_MS) {
		return {
			id: "5h",
			label: info.windowLabel ?? "5 Hour",
			durationMs: ANTIGRAVITY_FIVE_HOUR_WINDOW_MS,
			resetsAt: resetAt,
		};
	}
	return {
		id: "7d",
		label: info.windowLabel ?? "7 Day",
		durationMs: ANTIGRAVITY_WEEKLY_WINDOW_MS,
		resetsAt: resetAt,
	};
}

function buildAmount(info: AntigravityQuotaInfo, hasValidResetTime: boolean): UsageAmount {
	// The endpoint serializes proto3 JSON, which omits zero-valued fields: an
	// exhausted pool arrives as `{ resetTime }` with no `remainingFraction`.
	// Only infer zero when `resetTime` parsed as a valid timestamp.
	const reported = info.remainingFraction ?? (hasValidResetTime ? 0 : undefined);
	const remainingFraction = clampFraction(reported);
	const amount: UsageAmount = { unit: "percent" };
	if (remainingFraction === undefined) return amount;
	const usedFraction = clampFraction(1 - remainingFraction);
	amount.remainingFraction = remainingFraction;
	amount.usedFraction = usedFraction;
	amount.remaining = remainingFraction * 100;
	amount.used = usedFraction !== undefined ? usedFraction * 100 : undefined;
	amount.limit = 100;
	return amount;
}

function normalizeQuotaInfos(info: AntigravityModelInfo): AntigravityQuotaInfo[] {
	const results: AntigravityQuotaInfo[] = [];
	const addInfo = (value: AntigravityQuotaInfo, tier?: string) => {
		results.push({ ...value, ...(tier ? { tier } : {}) });
	};
	const addArray = (values?: AntigravityQuotaInfo[]) => {
		if (!values) return;
		for (const value of values) addInfo(value);
	};

	if (Array.isArray(info.quotaInfo)) {
		addArray(info.quotaInfo);
	} else if (info.quotaInfo) {
		addInfo(info.quotaInfo);
	}
	addArray(info.quotaInfos);

	if (info.quotaInfoByTier) {
		for (const [tier, value] of Object.entries(info.quotaInfoByTier)) {
			if (Array.isArray(value)) {
				for (const entry of value) addInfo(entry, tier);
			} else if (value) {
				addInfo(value, tier);
			}
		}
	}

	return results;
}

/**
 * Return the OAuth access token to use against `/v1internal:*`. AuthStorage is
 * the sole refresh authority (broker-aware, single-flighted, rotation-safe);
 * an expired token short-circuits the probe rather than POSTing the broker
 * sentinel back to Google.
 */
function resolveAccessToken(params: UsageFetchParams): string | undefined {
	const { credential } = params;
	if (!credential.accessToken) return undefined;
	if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now()) {
		return undefined;
	}
	return credential.accessToken;
}

interface AntigravitySummaryQuotas {
	gemini: AntigravityQuotaInfo[];
	claudeGpt: AntigravityQuotaInfo[];
	geminiArgon: AntigravityQuotaInfo[];
}

async function fetchQuotaSummary(
	baseUrl: string,
	accessToken: string,
	projectId: string,
	signal: AbortSignal | undefined,
	ctx: UsageFetchContext,
): Promise<AntigravitySummaryQuotas> {
	const empty: AntigravitySummaryQuotas = { gemini: [], claudeGpt: [], geminiArgon: [] };
	try {
		const response = await ctx.fetch(`${baseUrl}${RETRIEVE_USER_QUOTA_SUMMARY_PATH}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				"User-Agent": getAntigravityUserAgent(),
			},
			body: JSON.stringify({ project: projectId }),
			signal,
		});
		if (!response.ok) return empty;
		const data = (await response.json()) as AntigravityQuotaSummaryResponse;
		const result: AntigravitySummaryQuotas = { gemini: [], claudeGpt: [], geminiArgon: [] };
		for (const group of data.groups ?? []) {
			const groupName = (group.displayName ?? "").toLowerCase();
			for (const bucket of group.buckets ?? []) {
				const bucketId = (bucket.bucketId ?? "").toLowerCase();
				const rawWindow = (bucket.window ?? "").trim().toLowerCase();
				const windowId =
					rawWindow === "5h" || bucketId.endsWith("-5h")
						? "5h"
						: rawWindow === "weekly" || rawWindow === "7d" || bucketId.endsWith("-weekly")
							? "7d"
							: undefined;
				if (!windowId) continue;
				const quota: AntigravityQuotaInfo = {
					windowId,
					windowLabel: windowId === "5h" ? "5 Hour" : "7 Day",
					remainingFraction: bucket.remainingFraction,
					resetTime: bucket.resetTime,
				};
				if (bucketId.startsWith("gemini-argon") || groupName.includes("argon")) {
					result.geminiArgon.push(quota);
				} else if (bucketId.startsWith("3p-") || groupName.includes("claude") || groupName.includes("gpt")) {
					result.claudeGpt.push(quota);
				} else if (bucketId.startsWith("gemini-") || groupName.includes("gemini")) {
					result.gemini.push(quota);
				}
			}
		}
		const sortFiveHourFirst = (a: AntigravityQuotaInfo, b: AntigravityQuotaInfo) =>
			a.windowId === "5h" ? -1 : b.windowId === "5h" ? 1 : 0;
		result.gemini.sort(sortFiveHourFirst);
		result.claudeGpt.sort(sortFiveHourFirst);
		result.geminiArgon.sort(sortFiveHourFirst);
		return result;
	} catch {
		return empty;
	}
}

function modelQuotaSignature(info: AntigravityModelInfo, nowMs: number): string {
	return normalizeQuotaInfos(info)
		.map(q => {
			const win = parseWindow(q, nowMs);
			const amt = buildAmount(q, win?.resetsAt !== undefined);
			return `${q.tier ?? ""}|${win?.id ?? ""}|${win?.resetsAt ?? 0}|${Math.round((amt.usedFraction ?? -1) * 10_000)}`;
		})
		.join(";");
}

async function fetchAntigravityUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	const credential = params.credential;
	if (!credential.projectId) return null;

	const nowMs = Date.now();

	const accessToken = resolveAccessToken(params);
	if (!accessToken) return null;

	const baseUrl = params.baseUrl?.replace(/\/+$/, "") || DEFAULT_ENDPOINT;
	const url = `${baseUrl}${FETCH_AVAILABLE_MODELS_PATH}`;
	const [response, summaryQuotas] = await Promise.all([
		ctx.fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				"User-Agent": getAntigravityUserAgent(),
			},
			body: JSON.stringify({ project: credential.projectId }),
			signal: params.signal,
		}),
		fetchQuotaSummary(baseUrl, accessToken, credential.projectId, params.signal, ctx),
	]);

	if (!response.ok) {
		ctx.logger?.warn("Antigravity usage fetch failed", {
			status: response.status,
			statusText: response.statusText,
		});
		return null;
	}

	const data = (await response.json()) as AntigravityUsageResponse;
	const limits: UsageLimit[] = [];
	let earliestReset: number | undefined;
	const hasSummary =
		summaryQuotas.gemini.length > 0 || summaryQuotas.claudeGpt.length > 0 || summaryQuotas.geminiArgon.length > 0;

	const generalGeminiSigs = new Set<string>();
	for (const [modelId, modelInfo] of Object.entries(data.models ?? {})) {
		if (modelInfo.isInternal === true || !isAntigravityAgentQuotaModel(modelId)) continue;
		if (resolveAntigravityQuotaPool(modelId) === "gemini") {
			generalGeminiSigs.add(modelQuotaSignature(modelInfo, nowMs));
		}
	}

	for (const [modelId, modelInfo] of Object.entries(data.models ?? {})) {
		if (modelInfo.isInternal === true || !isAntigravityAgentQuotaModel(modelId)) continue;
		const pool = resolveAntigravityQuotaPool(modelId);
		const hasCustomTiers = Boolean(modelInfo.quotaInfoByTier);
		let quotaInfos: AntigravityQuotaInfo[];
		let argonSharesGeminiPool = false;

		if (!hasCustomTiers && pool === "claude-gpt" && summaryQuotas.claudeGpt.length > 0) {
			quotaInfos = summaryQuotas.claudeGpt;
		} else if (!hasCustomTiers && pool === "gemini" && summaryQuotas.gemini.length > 0) {
			quotaInfos = summaryQuotas.gemini;
		} else if (!hasCustomTiers && pool === "gemini-argon" && hasSummary) {
			if (summaryQuotas.geminiArgon.length > 0) {
				quotaInfos = summaryQuotas.geminiArgon;
			} else if (summaryQuotas.gemini.length > 0) {
				// Ultra plans include Argon in the shared Gemini quota bucket.
				quotaInfos = summaryQuotas.gemini;
				argonSharesGeminiPool = true;
			} else {
				quotaInfos = normalizeQuotaInfos(modelInfo);
			}
		} else {
			quotaInfos = normalizeQuotaInfos(modelInfo);
			if (pool === "gemini-argon" && generalGeminiSigs.has(modelQuotaSignature(modelInfo, nowMs))) {
				argonSharesGeminiPool = true;
			}
		}

		for (const quotaInfo of quotaInfos) {
			const window = parseWindow(quotaInfo, nowMs);
			const amount = buildAmount(quotaInfo, window?.resetsAt !== undefined);
			if (window?.resetsAt) {
				earliestReset = earliestReset ? Math.min(earliestReset, window.resetsAt) : window.resetsAt;
			}
			const labelBase = argonSharesGeminiPool ? "Gemini" : antigravityQuotaPoolLabel(modelId);
			const label = quotaInfo.tier ? `${labelBase} (${quotaInfo.tier})` : labelBase;
			const windowId = window?.id ?? "default";
			limits.push({
				id: `${modelId}:${quotaInfo.tier ?? "default"}:${windowId}`,
				label,
				scope: {
					provider: params.provider,
					accountId: credential.accountId,
					projectId: credential.projectId,
					modelId,
					tier: quotaInfo.tier,
					windowId,
				},
				window,
				amount,
				status: getUsageStatus(amount.remainingFraction),
			});
		}
	}

	const report: UsageReport = {
		provider: params.provider,
		fetchedAt: nowMs,
		limits,
		metadata: {
			endpoint: url,
			projectId: credential.projectId,
			...(credential.email ? { email: credential.email } : {}),
			...(credential.accountId ? { accountId: credential.accountId } : {}),
		},
		raw: data,
	};

	return report;
}

export const antigravityUsageProvider: UsageProvider = {
	id: "google-antigravity",
	fetchUsage: fetchAntigravityUsage,
	supports: params => params.provider === "google-antigravity",
};

export const antigravityRankingStrategy: CredentialRankingStrategy = {
	findWindowLimits(report) {
		const isUntouchedFiveHour = (limit: UsageLimit): boolean => {
			const windowId = (limit.window?.id ?? limit.scope.windowId)?.toLowerCase();
			const used = limit.amount.usedFraction;
			return windowId === "5h" && typeof used === "number" && Number.isFinite(used) && used === 0;
		};
		const fiveHour = report.limits.find(limit => (limit.window?.id ?? limit.scope.windowId)?.toLowerCase() === "5h");
		const weekly = report.limits.find(limit => {
			const windowId = (limit.window?.id ?? limit.scope.windowId)?.toLowerCase();
			return windowId === "7d" || windowId === "weekly";
		});
		const fallback = report.limits[0];
		const primary = fiveHour ?? weekly ?? fallback;
		const secondary = weekly ?? fiveHour ?? fallback;
		// An untouched 5h window in Antigravity reports a sliding `now + 5h`
		// horizon rather than an active countdown; strip `resetsAt` from that
		// unstarted horizon so `earliest-reset` drains accounts with actively
		// ticking windows (e.g. a weekly window expiring in 12h or a ticking 5h
		// window expiring in 2h) before starting a fresh account's 5h timer.
		const normalizeHorizon = (limit: UsageLimit | undefined): UsageLimit | undefined => {
			if (!limit || !isUntouchedFiveHour(limit) || !limit.window?.resetsAt) return limit;
			const { resetsAt: _slidingResetAt, ...restWindow } = limit.window;
			return { ...limit, window: restWindow };
		};
		return {
			primary: normalizeHorizon(primary),
			secondary: normalizeHorizon(secondary),
		};
	},
	windowDefaults: {
		primaryMs: ANTIGRAVITY_FIVE_HOUR_WINDOW_MS,
		secondaryMs: ANTIGRAVITY_WEEKLY_WINDOW_MS,
	},
};

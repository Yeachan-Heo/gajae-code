/**
 * Kiro usage provider.
 *
 * Kiro meters a subscription credit balance rather than token windows. The
 * authenticated control plane answers `GetUsageLimits` with the plan title, the
 * credit allowance, credits consumed so far, the next reset instant, and the
 * overage configuration, so remaining credits are reported directly instead of
 * being inferred from request accounting.
 *
 * The profile ARN is required by the endpoint and is resolved from the access
 * token via `ListAvailableProfiles`. Kiro access tokens are opaque (not JWTs)
 * and the stored credential carries no email or account id, so the token itself
 * is the only identity input available here.
 */
import {
	KIRO_AWS_UA,
	KIRO_AWS_X_AMZ_UA,
	KIRO_BUILDER_ID_PROFILE_ARN,
	KIRO_MANAGEMENT_URL,
	resolveKiroProfileArn,
} from "../providers/kiro";
import type {
	UsageAmount,
	UsageCredential,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageUnit,
	UsageWindow,
} from "../usage";
import { isRecord } from "../utils";
import { toNumber } from "./shared";

const KIRO_GET_USAGE_LIMITS_TARGET = "AmazonCodeWhispererService.GetUsageLimits";

interface KiroUsageBreakdown {
	resourceType?: unknown;
	displayName?: unknown;
	displayNamePlural?: unknown;
	unit?: unknown;
	currency?: unknown;
	currentUsage?: unknown;
	currentUsageWithPrecision?: unknown;
	usageLimit?: unknown;
	usageLimitWithPrecision?: unknown;
	currentOverages?: unknown;
	currentOveragesWithPrecision?: unknown;
	overageCap?: unknown;
	overageCapWithPrecision?: unknown;
	overageCharges?: unknown;
	overageRate?: unknown;
	nextDateReset?: unknown;
}

interface KiroUsageLimitsPayload {
	nextDateReset?: unknown;
	overageConfiguration?: unknown;
	subscriptionInfo?: unknown;
	usageBreakdownList?: unknown;
}

/** Kiro reports reset instants as epoch seconds; tolerate millisecond values. */
function toEpochMs(value: unknown): number | undefined {
	const seconds = toNumber(value);
	if (seconds === undefined || seconds <= 0) return undefined;
	return seconds > 1_000_000_000_000 ? seconds : seconds * 1000;
}

/**
 * `INVOCATIONS` credits are request-denominated; overage is billed in currency.
 * Anything else stays `unknown` rather than being coerced into a wrong unit.
 */
function resolveUnit(unit: unknown): UsageUnit {
	if (typeof unit !== "string") return "unknown";
	const normalized = unit.trim().toUpperCase();
	if (normalized === "INVOCATIONS" || normalized === "REQUESTS") return "requests";
	if (normalized === "TOKENS") return "tokens";
	if (normalized === "USD") return "usd";
	return "unknown";
}

function buildStatus(amount: UsageAmount): UsageStatus {
	if (amount.usedFraction === undefined) return "unknown";
	if (amount.usedFraction >= 1) return "exhausted";
	if (amount.usedFraction >= 0.9) return "warning";
	return "ok";
}

function buildAmount(breakdown: KiroUsageBreakdown): UsageAmount | undefined {
	// Prefer the precise values; Kiro truncates the integer variants downward.
	const used = toNumber(breakdown.currentUsageWithPrecision) ?? toNumber(breakdown.currentUsage);
	const limit = toNumber(breakdown.usageLimitWithPrecision) ?? toNumber(breakdown.usageLimit);
	if (used === undefined && limit === undefined) return undefined;

	const amount: UsageAmount = { unit: resolveUnit(breakdown.unit) };
	if (used !== undefined) amount.used = used;
	if (limit !== undefined) amount.limit = limit;
	if (used !== undefined && limit !== undefined && limit > 0) {
		amount.remaining = Math.max(limit - used, 0);
		amount.usedFraction = Math.min(Math.max(used / limit, 0), 1);
		amount.remainingFraction = Math.min(Math.max((limit - used) / limit, 0), 1);
	}
	return amount;
}

function buildWindow(breakdown: KiroUsageBreakdown, payloadResetMs: number | undefined): UsageWindow | undefined {
	const resetsAt = toEpochMs(breakdown.nextDateReset) ?? payloadResetMs;
	if (resetsAt === undefined) return undefined;
	return { id: "billing-cycle", label: "Billing cycle", resetsAt };
}

/**
 * Overage is a separate spend lane from the included allowance, so it is
 * reported as notes on the credit limit instead of a second competing limit
 * that would distort remaining-quota ranking.
 */
function buildOverageNotes(breakdown: KiroUsageBreakdown, overageStatus: string | undefined): string[] {
	const notes: string[] = [];
	if (overageStatus) notes.push(`Overage ${overageStatus.toLowerCase()}`);

	const overages = toNumber(breakdown.currentOveragesWithPrecision) ?? toNumber(breakdown.currentOverages);
	const cap = toNumber(breakdown.overageCapWithPrecision) ?? toNumber(breakdown.overageCap);
	if (overages !== undefined && cap !== undefined) notes.push(`Overage ${overages} of ${cap}`);
	else if (overages !== undefined) notes.push(`Overage ${overages}`);

	const charges = toNumber(breakdown.overageCharges);
	const currency = typeof breakdown.currency === "string" ? breakdown.currency : undefined;
	if (charges !== undefined && charges > 0) {
		notes.push(currency ? `Overage charges ${charges} ${currency}` : `Overage charges ${charges}`);
	}
	return notes;
}

function breakdownLabel(breakdown: KiroUsageBreakdown, index: number): string {
	for (const candidate of [breakdown.displayNamePlural, breakdown.displayName, breakdown.resourceType]) {
		if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
	}
	return `Limit #${index + 1}`;
}

function limitId(breakdown: KiroUsageBreakdown, index: number): string {
	const resourceType = typeof breakdown.resourceType === "string" ? breakdown.resourceType.trim() : "";
	return `kiro:${resourceType ? resourceType.toLowerCase() : String(index)}`;
}

/** Never let account identity from `userInfo` reach the report's raw payload. */
function redactPayload(payload: KiroUsageLimitsPayload): Record<string, unknown> {
	const { nextDateReset, overageConfiguration, subscriptionInfo, usageBreakdownList } = payload;
	return { nextDateReset, overageConfiguration, subscriptionInfo, usageBreakdownList };
}

/**
 * Kiro access tokens are opaque and the stored credential carries no email or
 * account id, so a multi-account setup otherwise renders every row as
 * `account N`. The login method plus the profile ARN suffix is the only stable,
 * non-secret discriminator available.
 *
 * The Builder ID ARN is deliberately excluded: every Builder ID credential
 * carries Kiro CLI's single hardcoded profile, so using it as a suffix would
 * attach an identical, meaningless `(AAAACCCCXXXX)` to every Builder ID row
 * without disambiguating anything. Social ARNs are per-account and do
 * discriminate, so they are kept.
 */
function resolveAccountLabel(credential: UsageCredential): string {
	const method = typeof credential.kiroMethod === "string" ? credential.kiroMethod.trim() : "";
	const arn = credential.kiroProfileArn?.trim() ?? "";
	const profile = arn && arn !== KIRO_BUILDER_ID_PROFILE_ARN ? arn.slice(arn.lastIndexOf("/") + 1).trim() : "";
	if (method && profile) return `kiro ${method} (${profile})`;
	if (method) return `kiro ${method}`;
	if (profile) return `kiro (${profile})`;
	// Credentials created before login-method persistence used Builder ID.
	return "kiro builder-id";
}

function unavailableReport(accountLabel: string, nowMs: number, reason: string): UsageReport {
	return {
		provider: "kiro",
		fetchedAt: nowMs,
		limits: [],
		metadata: {
			endpoint: KIRO_MANAGEMENT_URL,
			account: accountLabel,
			unavailableReason: reason,
		},
	};
}

function resolveHttpStatus(error: unknown): number | undefined {
	if (!isRecord(error)) return undefined;
	return typeof error.status === "number" ? error.status : undefined;
}

async function fetchKiroUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== "kiro") return null;
	const { credential } = params;
	if (credential.type !== "oauth" || !credential.accessToken) return null;

	const nowMs = Date.now();
	// AuthStorage owns refresh. An expired token here means the pre-emptive
	// refresh has not landed yet, and the refresh slot may hold the broker
	// sentinel, so skip rather than sending a doomed request.
	if (credential.expiresAt !== undefined && credential.expiresAt <= nowMs) {
		ctx.logger?.debug("Kiro usage token expired; skipping probe", { provider: params.provider });
		return null;
	}

	const accountLabel = resolveAccountLabel(credential);
	// Social credentials carry a server-confirmed ARN. Builder ID uses the
	// shared Kiro CLI profile because its token cannot call ListAvailableProfiles.
	const method = credential.kiroMethod;
	let profileArn =
		credential.kiroProfileArn?.trim() ||
		(method === "builder-id" || method === undefined ? KIRO_BUILDER_ID_PROFILE_ARN : undefined);
	if (!profileArn) {
		try {
			profileArn = await resolveKiroProfileArn(credential.accessToken, ctx.fetch);
		} catch (error) {
			const status = resolveHttpStatus(error);
			const reason = status ? `Profile resolution returned HTTP ${status}` : "Profile resolution failed";
			ctx.logger?.warn("Kiro profile resolution failed", {
				provider: params.provider,
				account: accountLabel ?? "unlabeled",
				...(status ? { status } : {}),
			});
			return unavailableReport(accountLabel, nowMs, reason);
		}
	}

	let payload: unknown;
	try {
		const response = await ctx.fetch(KIRO_MANAGEMENT_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${credential.accessToken}`,
				"Content-Type": "application/x-amz-json-1.0",
				"x-amz-target": KIRO_GET_USAGE_LIMITS_TARGET,
				"User-Agent": KIRO_AWS_UA,
				"x-amz-user-agent": KIRO_AWS_X_AMZ_UA,
				accept: "*/*",
			},
			body: JSON.stringify({ profileArn }),
			signal: params.signal,
		});
		if (!response.ok) {
			ctx.logger?.warn("Kiro usage request failed", {
				provider: params.provider,
				status: response.status,
				account: accountLabel ?? "unlabeled",
			});
			// A non-ok status is an account-scoped fact (entitlement revoked, plan
			// downgraded, profile unauthorized), not a transport hiccup. Returning
			// null erases the account from the usage view entirely, so surface a
			// limitless report that names the account and the reason instead.
			return unavailableReport(accountLabel, nowMs, `GetUsageLimits returned HTTP ${response.status}`);
		}
		payload = await response.json();
	} catch (error) {
		ctx.logger?.warn("Kiro usage request error", { provider: params.provider, error: String(error) });
		return null;
	}

	if (!isRecord(payload)) {
		ctx.logger?.warn("Kiro usage response invalid", { provider: params.provider });
		return null;
	}

	const data = payload as KiroUsageLimitsPayload;
	const breakdowns = Array.isArray(data.usageBreakdownList) ? data.usageBreakdownList : [];
	const payloadResetMs = toEpochMs(data.nextDateReset);
	const subscriptionInfo = isRecord(data.subscriptionInfo) ? data.subscriptionInfo : undefined;
	const subscriptionTitle =
		typeof subscriptionInfo?.subscriptionTitle === "string" ? subscriptionInfo.subscriptionTitle : undefined;
	const subscriptionType = typeof subscriptionInfo?.type === "string" ? subscriptionInfo.type : undefined;
	const overageConfiguration = isRecord(data.overageConfiguration) ? data.overageConfiguration : undefined;
	const overageStatus =
		typeof overageConfiguration?.overageStatus === "string" ? overageConfiguration.overageStatus : undefined;

	const limits: UsageLimit[] = [];
	breakdowns.forEach((entry, index) => {
		if (!isRecord(entry)) return;
		const breakdown = entry as KiroUsageBreakdown;
		const amount = buildAmount(breakdown);
		if (!amount) return;
		const notes = buildOverageNotes(breakdown, overageStatus);
		limits.push({
			id: limitId(breakdown, index),
			label: breakdownLabel(breakdown, index),
			scope: {
				provider: params.provider,
				accountId:
					credential.accountId ??
					(credential.credentialId !== undefined ? `credential:${credential.credentialId}` : accountLabel),
				tier: subscriptionTitle,
				windowId: "billing-cycle",
				shared: true,
			},
			window: buildWindow(breakdown, payloadResetMs),
			amount,
			status: buildStatus(amount),
			...(notes.length > 0 ? { notes } : {}),
		});
	});

	if (limits.length === 0) {
		ctx.logger?.warn("Kiro usage response carried no limits", {
			provider: params.provider,
			account: accountLabel ?? "unlabeled",
		});
		// Keep the account visible with an explicit reason instead of dropping it.
		return {
			provider: params.provider,
			fetchedAt: nowMs,
			limits: [],
			metadata: {
				endpoint: KIRO_MANAGEMENT_URL,
				...(accountLabel ? { account: accountLabel } : {}),
				...(subscriptionTitle ? { subscriptionTitle } : {}),
				...(subscriptionType ? { subscriptionType } : {}),
				unavailableReason: "GetUsageLimits returned no usage breakdown",
			},
			raw: redactPayload(data),
		};
	}

	return {
		provider: params.provider,
		fetchedAt: nowMs,
		limits,
		metadata: {
			endpoint: KIRO_MANAGEMENT_URL,
			...(accountLabel ? { account: accountLabel } : {}),
			...(subscriptionTitle ? { subscriptionTitle } : {}),
			...(subscriptionType ? { subscriptionType } : {}),
			...(overageStatus ? { overageStatus } : {}),
		},
		raw: redactPayload(data),
	};
}

export const kiroUsageProvider: UsageProvider = {
	id: "kiro",
	fetchUsage: fetchKiroUsage,
	supports: params => params.provider === "kiro" && params.credential.type === "oauth",
};

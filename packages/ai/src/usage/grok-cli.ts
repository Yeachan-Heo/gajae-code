import type {
	CredentialRankingStrategy,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
} from "../usage";

interface BillingUsage {
	monthlyLimit: number;
	used: number;
	billingPeriodEnd: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseValNumber(value: unknown): number | undefined {
	return isRecord(value) ? finiteNumber(value.val) : undefined;
}

export function parseGrokCliBillingUsage(payload: unknown): BillingUsage {
	if (!isRecord(payload) || !isRecord(payload.config)) {
		throw new Error("invalid Grok CLI billing payload");
	}
	const monthlyLimit = parseValNumber(payload.config.monthlyLimit);
	const used = parseValNumber(payload.config.used);
	const billingPeriodEnd = payload.config.billingPeriodEnd;
	if (
		monthlyLimit === undefined ||
		used === undefined ||
		typeof billingPeriodEnd !== "string" ||
		!Number.isFinite(new Date(billingPeriodEnd).getTime())
	) {
		throw new Error("invalid Grok CLI billing payload");
	}
	return { monthlyLimit, used, billingPeriodEnd };
}

function normalizeGrokBaseUrl(baseUrl?: string): string {
	return (baseUrl?.trim() || "https://cli-chat-proxy.grok.com/v1").replace(/\/+$/, "");
}

function resolveAccessToken(params: UsageFetchParams): string | undefined {
	const token = params.credential.accessToken ?? params.credential.apiKey ?? process.env.GROK_CLI_OAUTH_TOKEN;
	return token?.trim() || undefined;
}

function buildMonthlyUsageLimit(usage: BillingUsage, nowMs: number): UsageLimit {
	const usedFraction = usage.monthlyLimit > 0 ? usage.used / usage.monthlyLimit : 0;
	const percent = usedFraction * 100;
	const resetsAt = new Date(usage.billingPeriodEnd).getTime();
	return {
		id: "grok-build:7d",
		label: "SuperGrok monthly credits",
		scope: { provider: "grok-build", shared: true, windowId: "7d" },
		window: {
			id: "7d",
			label: "Monthly credits",
			resetsAt,
		},
		amount: {
			unit: "percent",
			used: percent,
			limit: 100,
			remaining: Math.max(0, 100 - percent),
			usedFraction,
			remainingFraction: Math.max(0, 1 - usedFraction),
		},
		status: percent >= 95 ? "exhausted" : percent >= 80 ? "warning" : "ok",
		notes: [
			`${usage.used}/${usage.monthlyLimit} credits used`,
			`resets in ${Math.max(0, Math.round((resetsAt - nowMs) / 3_600_000))}h`,
		],
	};
}

export const grokCliUsageProvider: UsageProvider = {
	id: "grok-build",

	supports(params) {
		return params.provider === "grok-build";
	},

	async fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
		const accessToken = resolveAccessToken(params);
		if (!accessToken) {
			ctx.logger?.warn("Grok Build usage: no access token", { provider: params.provider });
			return null;
		}

		const response = await ctx.fetch(`${normalizeGrokBaseUrl(params.baseUrl)}/billing`, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"x-xai-token-auth": "xai-grok-cli",
				accept: "application/json",
			},
			signal: params.signal,
		});
		if (!response.ok) {
			ctx.logger?.warn("Grok Build billing request failed", { status: response.status, provider: params.provider });
			return null;
		}

		const payload = (await response.json()) as unknown;
		let billing: BillingUsage;
		try {
			billing = parseGrokCliBillingUsage(payload);
		} catch (error) {
			ctx.logger?.warn("Grok Build billing parse failed", { error: String(error) });
			return null;
		}

		const nowMs = Date.now();
		return {
			provider: "grok-build",
			fetchedAt: nowMs,
			limits: [buildMonthlyUsageLimit(billing, nowMs)],
			metadata: {
				email: params.credential.email,
				accountId: params.credential.accountId,
				subscription: true,
			},
			raw: payload,
		};
	},
};

export const grokCliRankingStrategy: CredentialRankingStrategy = {
	findWindowLimits(report) {
		const monthly = report.limits.find(limit => limit.id === "grok-build:7d");
		return { secondary: monthly };
	},
	windowDefaults: { primaryMs: 5 * 60 * 60 * 1000, secondaryMs: 30 * 24 * 60 * 60 * 1000 },
};

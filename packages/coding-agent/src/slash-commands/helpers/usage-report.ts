import type { UsageLimit, UsageReport } from "@gajae-code/ai/core";
import type { SlashCommandRuntime } from "../types";
import { formatDuration, renderAsciiBar } from "./format";

function formatProviderName(provider: string): string {
	return provider
		.split(/[-_]/g)
		.map(part => (part ? part[0].toUpperCase() + part.slice(1) : ""))
		.join(" ");
}

function formatUsageAmount(limit: UsageLimit): string {
	const amount = limit.amount;
	const used = amount.used ?? (amount.usedFraction !== undefined ? amount.usedFraction * 100 : undefined);
	const remainingFraction =
		amount.remainingFraction ??
		(amount.usedFraction !== undefined ? Math.max(0, 1 - amount.usedFraction) : undefined);
	const unit = amount.unit === "percent" ? "%" : ` ${amount.unit}`;
	const usedText = used === undefined ? "unknown used" : `${used.toFixed(2)}${unit} used`;
	const remainingText = remainingFraction === undefined ? "" : ` (${(remainingFraction * 100).toFixed(1)}% left)`;
	return `${usedText}${remainingText}`;
}

function formatUsageReportAccount(report: UsageReport, limit: UsageLimit, index: number): string {
	const email = report.metadata?.email;
	if (typeof email === "string" && email) return email;
	const accountId = report.metadata?.accountId ?? limit.scope.accountId;
	if (typeof accountId === "string" && accountId) return accountId;
	return `account ${index + 1}`;
}

function renderUsageReports(reports: UsageReport[], nowMs: number): string {
	const latestFetchedAt = Math.max(...reports.map(report => report.fetchedAt ?? 0));
	const lines = [`Usage${latestFetchedAt ? ` (${formatDuration(nowMs - latestFetchedAt)} ago)` : ""}`];
	const grouped = new Map<string, UsageReport[]>();
	for (const report of reports) {
		const providerReports = grouped.get(report.provider) ?? [];
		providerReports.push(report);
		grouped.set(report.provider, providerReports);
	}

	for (const [provider, providerReports] of [...grouped.entries()].sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		lines.push("", formatProviderName(provider));
		for (const report of providerReports) {
			if (report.limits.length === 0) {
				const email = typeof report.metadata?.email === "string" ? report.metadata.email : "account";
				lines.push(`- ${email}: no limits reported`);
				continue;
			}
			for (let index = 0; index < report.limits.length; index++) {
				const limit = report.limits[index]!;
				const window = limit.window?.label ?? limit.scope.windowId;
				const tier = limit.scope.tier ? ` (${limit.scope.tier})` : "";
				lines.push(`- ${limit.label}${tier}${window ? ` — ${window}` : ""}`);
				lines.push(`  ${formatUsageReportAccount(report, limit, index)}: ${formatUsageAmount(limit)}`);
				lines.push(`  ${renderAsciiBar(limit.amount.usedFraction)}`);
				if (limit.window?.resetsAt) lines.push(`  resets in ${formatDuration(limit.window.resetsAt - nowMs)}`);
				if (limit.notes && limit.notes.length > 0) lines.push(`  ${limit.notes.join(" • ")}`);
			}
		}
	}
	return ["```", ...lines, "```"].join("\n");
}

/**
 * Build the `/usage` ACP-mode text. Prefers provider-reported limits when the
 * session exposes `fetchUsageReports`; otherwise falls back to the local
 * session-manager tallies.
 */
export async function buildUsageReportText(runtime: SlashCommandRuntime): Promise<string> {
	const provider = runtime.session as SlashCommandRuntime["session"] & {
		fetchUsageReports?: () => Promise<UsageReport[] | null>;
	};
	if (provider.fetchUsageReports) {
		const reports = await provider.fetchUsageReports();
		if (reports && reports.length > 0) return renderUsageReports(reports, Date.now());
	}

	const stats = runtime.session.sessionManager.getUsageStatistics();
	return [
		"Usage",
		`Input tokens: ${stats.input}`,
		`Output tokens: ${stats.output}`,
		`Cache read tokens: ${stats.cacheRead}`,
		`Cache write tokens: ${stats.cacheWrite}`,
		`Premium requests: ${stats.premiumRequests}`,
		`Cost: $${stats.cost.toFixed(6)}`,
	].join("\n");
}

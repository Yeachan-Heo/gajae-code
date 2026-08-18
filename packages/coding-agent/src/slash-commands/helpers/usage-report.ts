import type { UsageLimit, UsageReport } from "@gajae-code/ai/core";
import { sanitizeText } from "@gajae-code/utils";
import {
	type AccountInventoryRow,
	buildAccountInventorySnapshot,
	checkAccountInventory,
} from "../../session/account-inventory";
import { truncateHead } from "../../session/streaming-output";
import type { SlashCommandRuntime } from "../types";
import { formatDuration } from "./format";

function sanitizeAndTruncateOutput(text: string): string {
	const sanitized = sanitizeText(text);
	return truncateHead(sanitized, { maxBytes: 32_768, maxLines: 1_000 }).content;
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

function healthLabel(row: AccountInventoryRow): string {
	if (row.disabled) return `disabled${row.disabledCause ? `: ${row.disabledCause}` : ""}`;
	if (row.health.status === "ok") return "ok";
	if (row.health.status === "failed") return `failed${row.health.reason ? `: ${row.health.reason}` : ""}`;
	if (row.health.status === "unverifiable") return `unverifiable${row.health.reason ? `: ${row.health.reason}` : ""}`;
	return "unknown";
}

/**
 * Reset detail for one limit. The account rows dropped every reset signal when
 * the panel was replaced, which left `/usage` unable to answer the question it
 * exists for: how long until the quota comes back. Two-unit precision, because
 * a single rounded unit reads `7d` at both 6.6 and 7.4 days remaining.
 */
function formatLimitReset(limit: UsageLimit, nowMs: number): string {
	const resetsAt = limit.window?.resetsAt;
	if (resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt <= nowMs) return "";
	const totalMinutes = Math.floor((resetsAt - nowMs) / 60_000);
	const totalHours = Math.floor(totalMinutes / 60);
	let countdown: string;
	if (totalMinutes < 1) countdown = "<1m";
	else if (totalMinutes < 60) countdown = `${totalMinutes}m`;
	else if (totalHours < 48) {
		const minutes = totalMinutes % 60;
		countdown = minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
	} else {
		const days = Math.floor(totalHours / 24);
		const hours = totalHours % 24;
		countdown = hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	}
	const withinADay = resetsAt - nowMs < 24 * 3_600_000;
	const at = new Date(resetsAt).toLocaleString(undefined, {
		month: withinADay ? undefined : "short",
		day: withinADay ? undefined : "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
	return `, resets in ${countdown} (${at})`;
}

/** One limit line: how much is left, and when it comes back. */
export function formatLimitDetail(limit: UsageLimit, nowMs: number): string {
	return `${formatUsageAmount(limit)}${formatLimitReset(limit, nowMs)}`;
}

/**
 * Cache-only usage reports for the interactive panel. Mirrors the plain
 * `/usage` contract exactly — reads the account inventory snapshot, never
 * fetches or probes — so the graphical view can be restored without
 * reintroducing the network call that motivated replacing it.
 */
export function collectCachedUsageReports(runtime: SlashCommandRuntime): UsageReport[] {
	const session = runtime.session;
	const modelRegistry = session.modelRegistry;
	const snapshot = buildAccountInventorySnapshot({
		authStorage: modelRegistry.authStorage,
		modelRegistry,
		sessionId: session.credentialSessionId ?? session.sessionId,
	});
	return snapshot.rows.flatMap(row => (row.usage ? [row.usage.report] : []));
}

function renderAccountRows(rows: AccountInventoryRow[], nowMs: number, checked: boolean): string {
	const lines = [`Accounts${checked ? " (checked)" : " (cache only)"}`];
	if (rows.length === 0) {
		lines.push("No configured accounts or API-key sources discovered.");
		return lines.join("\n");
	}
	for (const row of rows) {
		const identity = row.identityLabel ? ` — ${row.identityLabel}` : "";
		const marker =
			row.routing.marker === "active" ? " [active]" : row.routing.marker === "selected" ? " [selected]" : "";
		const cache = row.usage
			? `, usage ${row.usage.freshness}${formatDuration(Math.max(0, nowMs - row.usage.fetchedAt)) ? ` ${formatDuration(Math.max(0, nowMs - row.usage.fetchedAt))} ago` : ""}`
			: "";
		lines.push(
			`- ${row.id}: ${row.provider}/${row.credentialKind} (${row.sourceLabel})${identity}${marker} — ${healthLabel(row)}${cache}`,
		);
		if (row.usage?.report.limits.length) {
			for (const limit of row.usage.report.limits.slice(0, 8)) {
				lines.push(`  ${sanitizeText(limit.label)}: ${formatLimitDetail(limit, nowMs)}`);
			}
		}
	}
	return lines.join("\n");
}

function buildLegacyUsage(runtime: SlashCommandRuntime): string {
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

export interface UsageReportOptions {
	check?: boolean;
}

/** Build `/usage`; plain mode is cache-only and never fetches or probes. */
export async function buildUsageReportText(
	runtime: SlashCommandRuntime,
	options: UsageReportOptions = {},
): Promise<string> {
	const session = runtime.session;
	const modelRegistry = session.modelRegistry;
	const input = {
		authStorage: modelRegistry.authStorage,
		modelRegistry,
		sessionId: session.credentialSessionId ?? session.sessionId,
	};
	const snapshot = options.check ? await checkAccountInventory(input) : buildAccountInventorySnapshot(input);
	const report = renderAccountRows(snapshot.rows, Date.now(), options.check === true);
	const legacy = buildLegacyUsage(runtime);

	return sanitizeAndTruncateOutput(`${report}\n\n${legacy}`);
}

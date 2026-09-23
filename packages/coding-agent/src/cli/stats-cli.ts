/**
 * Stats CLI command handlers.
 *
 * Handles `gjc stats` subcommand for viewing AI usage statistics.
 */

import { APP_NAME, formatDuration, formatNumber, formatPercent } from "@gajae-code/utils";
import chalk from "chalk";
import { openPath } from "../utils/open";

/**
 * Single-line TTY progress bar. On a non-TTY stream we just stay quiet -
 * the final "Synced ..." summary still prints either way.
 */
function createSyncProgressReporter(): {
	onProgress: (event: { current: number; total: number; sessionFile: string }) => void;
	finish: () => void;
} {
	const stream = process.stderr;
	const isTty = stream.isTTY === true;
	let lastWidth = 0;
	let lastRender = 0;
	return {
		onProgress(event) {
			if (!isTty) return;
			const now = Date.now();
			// Throttle to ~30 fps and always force a render for the last file.
			if (event.current < event.total && now - lastRender < 33) return;
			lastRender = now;
			const label = chalk.dim(shortenSessionFile(event.sessionFile));
			const pct = ((event.current / event.total) * 100).toFixed(0).padStart(3, " ");
			const counter = chalk.cyan(`[${event.current}/${event.total}]`);
			const line = `${counter} ${pct}%  ${label}`;
			const columns = stream.columns ?? 120;
			const trimmed = truncateToColumns(line, columns - 1);
			stream.write(`\r${trimmed.padEnd(lastWidth)}`);
			lastWidth = trimmed.length;
		},
		finish() {
			if (!isTty || lastWidth === 0) return;
			stream.write(`\r${" ".repeat(lastWidth)}\r`);
			lastWidth = 0;
		},
	};
}

function shortenSessionFile(p: string): string {
	const marker = "/sessions/";
	const idx = p.indexOf(marker);
	return idx >= 0 ? p.slice(idx + marker.length) : p;
}

function truncateToColumns(s: string, max: number): string {
	if (max <= 0) return "";
	const width = Bun.stringWidth(s, { countAnsiEscapeCodes: false });
	if (width <= max) return s;
	// Cheap right-trim with an ellipsis - we don't need ANSI-aware slicing
	// because the colored prefix is short and the truncated tail is the
	// dim filename, where dropping bytes is fine.
	return `${s.slice(0, Math.max(0, max - 1))}\u2026`;
}

// =============================================================================
// Types
// =============================================================================

export interface StatsCommandArgs {
	port: number;
	json: boolean;
	summary: boolean;
}

// =============================================================================
// Argument Parser
// =============================================================================

/**
 * Parse stats subcommand arguments.
 * Returns undefined if not a stats command.
 */
export function parseStatsArgs(args: string[]): StatsCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "stats") {
		return undefined;
	}

	const result: StatsCommandArgs = {
		port: 3847,
		json: false,
		summary: false,
	};

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json" || arg === "-j") {
			result.json = true;
		} else if (arg === "--summary" || arg === "-s") {
			result.summary = true;
		} else if ((arg === "--port" || arg === "-p") && i + 1 < args.length) {
			result.port = parseInt(args[++i], 10);
		} else if (arg.startsWith("--port=")) {
			result.port = parseInt(arg.split("=")[1], 10);
		}
	}

	return result;
}

function formatCost(n: number): string {
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

function normalizePremiumRequests(n: number): number {
	return Math.round((n + Number.EPSILON) * 100) / 100;
}

// =============================================================================
// Command Handler
// =============================================================================

export async function runStatsCommand(cmd: StatsCommandArgs): Promise<void> {
	// Lazy import to avoid loading stats module when not needed
	const { getDashboardStats, syncAllSessions, getTotalMessageCount, startServer, closeDb } = await import(
		"@gajae-code/stats"
	);

	// Sync session files first
	const progress = createSyncProgressReporter();
	process.stderr.write("Syncing session files...\n");
	const { processed, files } = await syncAllSessions({ onProgress: progress.onProgress });
	progress.finish();
	const total = await getTotalMessageCount();
	console.log(`Synced ${processed} new entries from ${files} files (${total} total)\n`);

	if (cmd.json) {
		const stats = await getDashboardStats();
		console.log(JSON.stringify(stats, null, 2));
		return;
	}

	if (cmd.summary) {
		await printStatsSummary();
		return;
	}

	// Start the dashboard server
	const { port } = await startServer(cmd.port);
	console.log(chalk.green(`Dashboard available at: http://localhost:${port}`));

	// Open browser
	const url = `http://localhost:${port}`;
	openPath(url);

	console.log("Press Ctrl+C to stop\n");

	// Keep process running
	process.on("SIGINT", () => {
		console.log("\nShutting down...");
		closeDb();
		process.exit(0);
	});

	// Keep the process alive
	await new Promise(() => {});
}

async function printStatsSummary(): Promise<void> {
	const { getDashboardStats } = await import("@gajae-code/stats");
	const stats = await getDashboardStats();
	const { overall, byModel, byFolder, byAgent } = stats;

	console.log(chalk.bold("\n=== AI Usage Statistics ===\n"));

	console.log(chalk.bold("Overall:"));
	console.log(`  Requests: ${formatNumber(overall.totalRequests)} (${formatNumber(overall.failedRequests)} errors)`);
	console.log(`  Error Rate: ${formatPercent(overall.errorRate)}`);
	console.log(`  Total Tokens: ${formatNumber(overall.totalInputTokens + overall.totalOutputTokens)}`);
	console.log(`  Input Tokens: ${formatNumber(overall.totalInputTokens)}`);
	console.log(`  Output Tokens: ${formatNumber(overall.totalOutputTokens)}`);
	console.log(`  Cache Rate: ${formatPercent(overall.cacheRate)}`);
	console.log(`  Total Cost: ${formatCost(overall.totalCost)}`);
	console.log(`  Premium Requests: ${formatNumber(normalizePremiumRequests(overall.totalPremiumRequests ?? 0))}`);
	console.log(`  Avg Duration: ${overall.avgDuration !== null ? formatDuration(overall.avgDuration) : "-"}`);
	console.log(`  Avg TTFT: ${overall.avgTtft !== null ? formatDuration(overall.avgTtft) : "-"}`);
	if (overall.avgTokensPerSecond !== null) {
		console.log(`  Avg Tokens/s: ${overall.avgTokensPerSecond.toFixed(1)}`);
	}

	if (byModel.length > 0) {
		console.log(chalk.bold("\nBy Model:"));
		for (const m of byModel.slice(0, 10)) {
			console.log(
				`  ${m.model}: ${formatNumber(m.totalRequests)} reqs, ${formatCost(m.totalCost)}, ${formatPercent(m.cacheRate)} cache`,
			);
		}
	}

	if (byAgent.length > 0) {
		console.log(chalk.bold("\nBy Agent Role:"));
		for (const agent of byAgent) {
			console.log(
				`  ${agent.agent}: ${formatNumber(agent.totalRequests)} reqs, ${formatNumber(agent.totalInputTokens)} input / ${formatNumber(agent.totalOutputTokens)} output, ${formatPercent(agent.cacheRate)} cache, ${formatCost(agent.totalCost)}`,
			);
		}
	}

	if (byFolder.length > 0) {
		console.log(chalk.bold("\nBy Folder:"));
		for (const f of byFolder.slice(0, 10)) {
			console.log(`  ${f.folder}: ${formatNumber(f.totalRequests)} reqs, ${formatCost(f.totalCost)}`);
		}
	}

	console.log("");
}

// =============================================================================
// Help
// =============================================================================

export function printStatsHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} stats`)} - AI Usage Statistics Dashboard

${chalk.bold("Usage:")}
  ${APP_NAME} stats [options]

${chalk.bold("Options:")}
  -p, --port <port>  Port for the dashboard server (default: 3847)
  -j, --json         Output stats as JSON and exit
  -s, --summary      Print summary to console and exit
  -h, --help         Show this help message

${chalk.bold("Examples:")}
  ${APP_NAME} stats              # Start dashboard server
  ${APP_NAME} stats --json       # Print stats as JSON
  ${APP_NAME} stats --summary    # Print summary to console
  ${APP_NAME} stats --port 8080  # Start on custom port

${chalk.bold("Metrics:")}
  - Total requests and error rate
  - Token usage (input, output, cache)
  - Role usage (default, executor, planner, architect, critic)
  - Cost breakdown
  - Average duration and time to first token (TTFT)
  - Tokens per second throughput
`);
}

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { GjcSessionContext } from "../gjc-runtime/session-layout";
import { resolveGjcSessionForRead, SessionResolutionError } from "../gjc-runtime/session-resolution";
import { computeTaskTokenMetrics, readTaskTokenLogs } from "../task/token-log";
import type { TaskTokenLog } from "../task/types";

const LIVE_RUNNER_SCHEMA_VERSION = 1;
const BINARY_ID = "gjc";

export interface LiveRunReportShape {
	schemaVersion: 1;
	binaryId: string;
	fixtureId: string;
	totals: {
		turns: number;
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		totalTokens: number;
	};
	cacheHitRate: number | null;
	receiptArtifactRatio: number | null;
	spawnDecisions: number | null;
	roi: number | null;
}

const DETERMINISTIC_FIXTURES: Record<string, readonly TaskTokenLog[]> = {
	"fixed-fixture": [
		{
			subagentId: "root",
			agent: "main",
			turn: 1,
			at: "2026-01-01T00:00:00.000Z",
			input: 100,
			output: 20,
			cacheRead: 40,
			cacheWrite: 10,
			totalTokens: 170,
			model: "fixture-model",
		},
		{
			subagentId: "1-executor",
			agent: "executor",
			turn: 1,
			at: "2026-01-01T00:00:01.000Z",
			input: 60,
			output: 15,
			cacheRead: 20,
			cacheWrite: 5,
			totalTokens: 100,
			model: "fixture-model",
		},
	],
};

export function buildFixtureReport(fixtureId: string, logs: readonly TaskTokenLog[]): LiveRunReportShape {
	const metrics = computeTaskTokenMetrics(logs);
	return {
		schemaVersion: LIVE_RUNNER_SCHEMA_VERSION,
		binaryId: BINARY_ID,
		fixtureId,
		totals: {
			turns: metrics.turns,
			inputTokens: metrics.inputTokens,
			outputTokens: metrics.outputTokens,
			cacheReadTokens: metrics.cacheReadTokens,
			cacheWriteTokens: metrics.cacheWriteTokens,
			totalTokens: metrics.totalTokens,
		},
		cacheHitRate: logs.length === 0 ? null : metrics.cacheHitRate,
		receiptArtifactRatio: null,
		spawnDecisions: null,
		roi: null,
	};
}

export async function runFixtureReport(fixtureId: string): Promise<number> {
	let resolved: ResolvedFixtureLogs;
	try {
		resolved = await resolveFixtureLogs(fixtureId);
	} catch (error) {
		// e.g. a corrupt token-log. Fail loudly rather than emitting an all-zero report.
		process.stderr.write(
			`failed to build fixture report for ${fixtureId}: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 1;
	}
	if (resolved.kind === "unknown") {
		// Neither a known deterministic fixture nor a resolvable GJC session. Emit a
		// bounded error on stderr with a non-zero exit rather than a schema-valid
		// all-zero report, which a before/after benchmark would misread as "0 tokens".
		process.stderr.write(`unknown fixture id and no matching GJC session: ${fixtureId}\n`);
		return 1;
	}
	process.stdout.write(JSON.stringify(buildFixtureReport(fixtureId, resolved.logs)));
	return 0;
}

type ResolvedFixtureLogs =
	| { readonly kind: "logs"; readonly logs: readonly TaskTokenLog[] }
	| { readonly kind: "unknown" };

async function resolveFixtureLogs(fixtureId: string): Promise<ResolvedFixtureLogs> {
	const deterministic = DETERMINISTIC_FIXTURES[fixtureId];
	if (deterministic) return { kind: "logs", logs: deterministic };
	let session: GjcSessionContext;
	try {
		session = await resolveGjcSessionForRead(process.cwd(), {
			flagValue: fixtureId,
			envSessionId: process.env.GJC_SESSION_ID,
		});
	} catch (error) {
		if (error instanceof SessionResolutionError) return { kind: "unknown" };
		throw error;
	}
	// resolveGjcSessionForRead accepts any explicit flagValue as a session id
	// without checking the dir exists, so a typo would otherwise yield a
	// schema-valid all-zero report. Require the session root to exist; a real
	// session with no turns yet still reads as a legitimate empty log set.
	if (!(await directoryExists(session.sessionRoot))) return { kind: "unknown" };
	const logs = await readTaskTokenLogs(path.join(session.sessionRoot, "token-logs"));
	return { kind: "logs", logs };
}

async function directoryExists(dir: string): Promise<boolean> {
	try {
		const stat = await fs.stat(dir);
		return stat.isDirectory();
	} catch {
		return false;
	}
}

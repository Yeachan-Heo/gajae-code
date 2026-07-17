import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionRoot } from "../gjc-runtime/session-layout";
import type { TaskTokenLog } from "../task/types";
import { buildFixtureReport, type LiveRunReportShape, runFixtureReport } from "./fixture-report";

function expectParseReportCompatible(report: LiveRunReportShape, fixtureId: string): void {
	expect(report.schemaVersion).toBe(1);
	expect(typeof report.binaryId).toBe("string");
	expect(report.binaryId.length).toBeGreaterThan(0);
	expect(report.fixtureId).toBe(fixtureId);
	for (const value of Object.values(report.totals)) {
		expect(typeof value).toBe("number");
		expect(Number.isFinite(value)).toBe(true);
	}
	expect(report.receiptArtifactRatio).toBeNull();
	expect(report.spawnDecisions).toBeNull();
	expect(report.roi).toBeNull();
}

describe("fixture report", () => {
	it("reports empty logs as a schema-v1 null-cache-hit report", () => {
		const report = buildFixtureReport("empty-fixture", []);

		expectParseReportCompatible(report, "empty-fixture");
		expect(report.totals).toEqual({
			turns: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 0,
		});
		expect(report.cacheHitRate).toBeNull();
	});

	it("sums deterministic fixed-fixture raw token buckets without folding cache into input", () => {
		const logs: TaskTokenLog[] = [
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
		];
		const report = buildFixtureReport("fixed-fixture", logs);
		const inputTokens = logs.reduce((sum, log) => sum + log.input, 0);
		const outputTokens = logs.reduce((sum, log) => sum + log.output, 0);
		const cacheReadTokens = logs.reduce((sum, log) => sum + log.cacheRead, 0);
		const cacheWriteTokens = logs.reduce((sum, log) => sum + log.cacheWrite, 0);
		const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

		expectParseReportCompatible(report, "fixed-fixture");
		expect(report.totals).toEqual({
			turns: logs.length,
			inputTokens,
			outputTokens,
			cacheReadTokens,
			cacheWriteTokens,
			totalTokens,
		});
		expect(report.cacheHitRate).toBe(cacheReadTokens / (inputTokens + cacheReadTokens));
	});

	it("emits only parseReport-compatible schema-v1 fields", () => {
		const report = buildFixtureReport("shape-fixture", [
			{
				subagentId: "root",
				turn: 1,
				at: "2026-01-01T00:00:00.000Z",
				input: 0,
				output: 0,
				cacheRead: 1,
				cacheWrite: 0,
				totalTokens: 1,
			},
		]);

		expect(Object.keys(report).sort()).toEqual([
			"binaryId",
			"cacheHitRate",
			"fixtureId",
			"receiptArtifactRatio",
			"roi",
			"schemaVersion",
			"spawnDecisions",
			"totals",
		]);
		expect(Object.keys(report.totals).sort()).toEqual([
			"cacheReadTokens",
			"cacheWriteTokens",
			"inputTokens",
			"outputTokens",
			"totalTokens",
			"turns",
		]);
		expectParseReportCompatible(report, "shape-fixture");
	});
});

async function captureRun(fixtureId: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const originalCwd = process.cwd();
	const originalStdout = process.stdout.write.bind(process.stdout);
	const originalStderr = process.stderr.write.bind(process.stderr);
	let exitCode = 0;
	let stdout = "";
	let stderr = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
		return true;
	}) as typeof process.stderr.write;
	try {
		exitCode = await runFixtureReport(fixtureId);
		return { stdout, stderr, exitCode };
	} finally {
		process.stdout.write = originalStdout;
		process.stderr.write = originalStderr;
		process.chdir(originalCwd);
	}
}

describe("runFixtureReport CLI degradation", () => {
	it("exits non-zero without emitting JSON for an unknown fixture id", async () => {
		await withTempCwd(async () => {
			const { stdout, stderr, exitCode } = await captureRun("definitely-not-a-real-session-id");
			expect(exitCode).toBe(1);
			expect(stdout).toBe("");
			expect(stderr).toContain("unknown fixture id");
		});
	});

	it("reads only the requested session token-log directory", async () => {
		await withTempCwd(async () => {
			const firstSession = "fixture-session-a";
			const secondSession = "fixture-session-b";
			await writeTokenLog(firstSession, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110 });
			await writeTokenLog(secondSession, { input: 900, output: 90, cacheRead: 0, cacheWrite: 0, totalTokens: 990 });

			const { stdout, exitCode } = await captureRun(firstSession);
			const report = JSON.parse(stdout) as LiveRunReportShape;

			expect(exitCode).toBe(0);
			expect(report.fixtureId).toBe(firstSession);
			expect(report.totals.totalTokens).toBe(110);
		});
	});

	it("emits deterministic PR9 default-candidate fixture reports", async () => {
		await withTempCwd(async () => {
			const { stdout, exitCode } = await captureRun("pr9.read-artifact-spill-threshold.after");
			const report = JSON.parse(stdout) as LiveRunReportShape;

			expect(exitCode).toBe(0);
			expectParseReportCompatible(report, "pr9.read-artifact-spill-threshold.after");
			expect(report.totals.totalTokens).toBe(20_100);
		});
	});

	it("exits non-zero without emitting JSON for a corrupt token-log", async () => {
		await withTempCwd(async () => {
			const id = "corrupt-session";
			const dir = join(sessionRoot(process.cwd(), id), "token-logs");
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "token-log.jsonl"), "not json\n{}\n", "utf-8");
			const { stdout, stderr, exitCode } = await captureRun(id);
			expect(exitCode).toBe(1);
			expect(stdout).toBe("");
			expect(stderr).toContain("failed to build fixture report");
		});
	});
});

async function withTempCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
	const originalCwd = process.cwd();
	const dir = await mkdtemp(join(tmpdir(), "gjc-fixture-report-"));
	process.chdir(dir);
	try {
		await fn(dir);
	} finally {
		// Restore the real cwd BEFORE removing the temp dir, otherwise the process
		// is left sitting in a deleted directory and later tests in the same
		// process fail with ENOENT on relative-path/process.cwd() operations.
		process.chdir(originalCwd);
		await rm(dir, { recursive: true, force: true });
	}
}

async function writeTokenLog(
	sessionId: string,
	metrics: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number },
): Promise<void> {
	const dir = join(sessionRoot(process.cwd(), sessionId), "token-logs");
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "token-log.jsonl"),
		`${JSON.stringify({
			subagentId: "root",
			agent: "main",
			turn: 1,
			at: "2026-01-01T00:00:00.000Z",
			model: "fixture-model",
			...metrics,
		})}\n`,
		"utf-8",
	);
}

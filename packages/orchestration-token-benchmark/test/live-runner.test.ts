import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LIVE_RUNNER_SCHEMA_VERSION,
	LiveRunnerError,
	type LiveRunReport,
	renderMarkdownReport,
	runLiveComparison,
	runOneBinary,
} from "../src/live-runner";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "gjc-live-runner-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

function fakeReport(binaryId: string, fixtureId: string, totalTokens: number): LiveRunReport {
	return {
		schemaVersion: LIVE_RUNNER_SCHEMA_VERSION,
		binaryPath: "fake-overwritten-by-runner",
		binaryId,
		fixtureId,
		totals: {
			turns: 2,
			inputTokens: totalTokens - 30,
			outputTokens: 20,
			cacheReadTokens: 5,
			cacheWriteTokens: 5,
			totalTokens,
		},
		cacheHitRate: null,
		receiptArtifactRatio: null,
		spawnDecisions: null,
		roi: null,
	};
}

async function writeFakeBinary(dir: string, name: string, stdout: string): Promise<string> {
	const path = join(dir, name);
	await Bun.write(
		path,
		`#!/usr/bin/env bun
if (Bun.argv.includes("--version")) {
	process.exit(0);
}
console.log(${JSON.stringify(stdout)});
`,
	);
	await Bun.$`chmod +x ${path}`;
	return path;
}

describe("live runner", () => {
	it("live-runner.fake-old-new.delta", async () => {
		const dir = await tempDir();
		const fixtureId = "fixed-fixture";
		const before = await writeFakeBinary(dir, "gjc-old", JSON.stringify(fakeReport("old", fixtureId, 120)));
		const after = await writeFakeBinary(dir, "gjc-new", JSON.stringify(fakeReport("new", fixtureId, 90)));
		const outputDir = join(dir, "out");

		const report = await runLiveComparison({ beforeBinary: before, afterBinary: after, fixtureId, outputDir });

		expect(report.schemaVersion).toBe(LIVE_RUNNER_SCHEMA_VERSION);
		expect(report.before.binaryPath).toBe(before);
		expect(report.after.binaryPath).toBe(after);
		expect(report.delta.totalTokens).toBe(-30);
		expect(await Bun.file(join(outputDir, "before.json")).exists()).toBe(true);
		expect(await Bun.file(join(outputDir, "after.json")).exists()).toBe(true);
		expect(await Bun.file(join(outputDir, "delta.json")).exists()).toBe(true);
		expect(await Bun.file(join(outputDir, "report.md")).exists()).toBe(true);
	});

	it("live-runner.missing-binary", async () => {
		const dir = await tempDir();
		await expect(runOneBinary(join(dir, "missing-gjc"), "fixed-fixture")).rejects.toMatchObject({
			code: "missing_binary",
		});
	});

	it("live-runner.malformed-report", async () => {
		const dir = await tempDir();
		const binary = await writeFakeBinary(dir, "gjc-malformed", "{not-json");

		await expect(runOneBinary(binary, "fixed-fixture")).rejects.toMatchObject({
			code: "malformed_report",
		});
	});

	it("live-runner.schema-mismatch", async () => {
		const dir = await tempDir();
		const report = { ...fakeReport("wrong-schema", "fixed-fixture", 100), schemaVersion: 999 };
		const binary = await writeFakeBinary(dir, "gjc-wrong-schema", JSON.stringify(report));

		await expect(runOneBinary(binary, "fixed-fixture")).rejects.toMatchObject({
			code: "schema_version_mismatch",
		});
	});

	it("live-runner.markdown-advisory", () => {
		const before = fakeReport("old", "fixed-fixture", 120);
		const after = fakeReport("new", "fixed-fixture", 90);
		before.binaryPath = "/tmp/gjc-old";
		after.binaryPath = "/tmp/gjc-new";

		const markdown = renderMarkdownReport({
			schemaVersion: LIVE_RUNNER_SCHEMA_VERSION,
			before,
			after,
			delta: {
				turns: 0,
				inputTokens: -30,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: -30,
				cacheHitRate: null,
				receiptArtifactRatio: null,
				spawnDecisions: null,
				roi: null,
			},
			regression: null,
		});

		expect(markdown).toContain("ADVISORY");
		expect(markdown).toContain("NON-CI");
		expect(markdown).toContain("NO LIVE ASSERTIONS");
	});

	it("live-runner.no-network", async () => {
		const dir = await tempDir();
		const fixtureId = "fixed-fixture";
		const binary = await writeFakeBinary(
			dir,
			"gjc-local-only",
			JSON.stringify(fakeReport("local-only", fixtureId, 100)),
		);

		const report = await runOneBinary(binary, fixtureId);

		// Automated coverage stops at the local fake-binary spawn boundary. It performs no provider, network,
		// or live-model call and makes no assertion about live-provider behavior.
		expect(report.binaryId).toBe("local-only");
		expect(report.fixtureId).toBe(fixtureId);
	});

	it("keeps bounded errors as LiveRunnerError", async () => {
		const dir = await tempDir();
		try {
			await runOneBinary(join(dir, "missing-gjc"), "fixed-fixture");
		} catch (error) {
			expect(error).toBeInstanceOf(LiveRunnerError);
		}
	});
});

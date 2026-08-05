import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	CheckpointError,
	FLOOR_POLICIES,
	chooseToolCall,
	deferredScenario,
	loadRescopeReference,
	parseArgs,
	resolveDefaultBaseline,
	successfulScenarioResult,
	validateScenarioWorkload,
} from "./verify-rss-checkpoints";

const GIT_COMMIT = "cc5873573ccebc955c5ba3bac7960df79e7b1bcd";
const BINARY_SHA256 = "0abede40edcc6c79cea6e51d5bfcdcf9e6021bde8b998c13d540339f8035884c";

function errorCode(run: () => void): string {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(CheckpointError);
		return (error as CheckpointError).code;
	}
	throw new Error("expected a CheckpointError");
}

function workload(scenario: "S4" | "S5") {
	return {
		scenario,
		observedToolCalls: 1,
		missingScenarioAdvertisements: 0,
		failedScenarioResults: 0,
		successfulToolResults: 1,
		expectedSamples: 1,
		workload: { id: scenario, observedToolCalls: 1 },
	} as const;

}

function structurallyValidBaseline(): string {
	return JSON.stringify({ schemaVersion: 1, metadata: {}, scenarios: [] });
}

describe("VB001 gen-3 harness gates", () => {
	test("exit gate accepts --all --compare, resolves a same-commit default, and emits deferred S6", async () => {
		const options = parseArgs(["--all", "--compare"]);
		expect(options.all).toBe(true);
		expect(options.compare).toBe(true);
		expect(options.baseline).toBeUndefined();

		const tempRoot = await fs.mkdtemp(path.join("/tmp", "gjc-harness-default-baseline-"));
		try {
			const canonical = path.join(tempRoot, `${GIT_COMMIT}.json`);
			await fs.writeFile(canonical, structurallyValidBaseline(), "utf8");
			expect(resolveDefaultBaseline(GIT_COMMIT, tempRoot)).toBe(canonical);

			const deferred = deferredScenario();
			expect(deferred).toMatchObject({
				id: "S6",
				status: "deferred",
				reason: "requires W7/W8 authorization and daemon implementation",
				command: [],
				warmups: 0,
				sampleCount: 0,
			});
			expect(deferred.rssBytes).toBeUndefined();
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("default baseline resolution fails closed for missing, malformed, and foreign-commit checkpoints while explicit baseline wins", async () => {
		const tempRoot = await fs.mkdtemp(path.join("/tmp", "gjc-harness-default-baseline-errors-"));
		try {
			expect(errorCode(() => resolveDefaultBaseline(GIT_COMMIT, tempRoot))).toBe("BaselineDefaultMissing");
			const sameCommitLastRun = path.join(tempRoot, `${GIT_COMMIT}.last-run.json`);
			await fs.writeFile(sameCommitLastRun, structurallyValidBaseline(), "utf8");
			expect(errorCode(() => resolveDefaultBaseline(GIT_COMMIT, tempRoot))).toBe("BaselineDefaultMissing");
			await fs.writeFile(path.join(tempRoot, "other-commit.last-run.json"), structurallyValidBaseline(), "utf8");
			expect(errorCode(() => resolveDefaultBaseline(GIT_COMMIT, tempRoot))).toBe("BaselineDefaultMissing");

			await fs.writeFile(path.join(tempRoot, `${GIT_COMMIT}.json`), "{", "utf8");
			expect(errorCode(() => resolveDefaultBaseline(GIT_COMMIT, tempRoot))).toBe("BaselineReadFailed");

			const explicit = path.join(tempRoot, "explicit.json");
			const options = parseArgs(["--all", "--compare", "--baseline", explicit]);
			expect(options.baseline).toBe(explicit);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("M3 rejects failed and incomplete S4/S5 proof while preserving positive provider probes", () => {
		const s4Marker = "gjc-rss-reference-0123456789abcdef ... of 29960 lines";
		const s5Marker = "GJC_RSS_BASH_BYTES=8388608";
		expect(successfulScenarioResult("S4", s4Marker)).toBe(true);
		expect(successfulScenarioResult("S4", `${s4Marker}\nERROR: read failed`)).toBe(false);
		expect(successfulScenarioResult("S5", s5Marker)).toBe(true);
		expect(successfulScenarioResult("S5", `${s5Marker}\nexit code 1`)).toBe(false);

		expect(chooseToolCall("Read one MiB from /tmp/file-0000.txt", { tools: [{ function: { name: "read" } }] })).toEqual({
			name: "read",
			args: { path: "/tmp/file-0000.txt", truncation: "head" },
		});
		expect(chooseToolCall("Use bash exactly once to produce an 8 MiB output", { tools: [{ function: { name: "bash" } }] })).toEqual(
			expect.objectContaining({ name: "bash" }),
		);
		expect(chooseToolCall("Read one MiB from /tmp/file-0000.txt", { messages: [{ role: "tool", content: "already returned" }] })).toBeUndefined();

		for (const scenario of ["S4", "S5"] as const) {
			const base = workload(scenario);
			expect(errorCode(() => validateScenarioWorkload({ ...base, observedToolCalls: 0 }))).toBe("ScenarioWorkloadMismatch");
			expect(errorCode(() => validateScenarioWorkload({ ...base, missingScenarioAdvertisements: 1 }))).toBe("ScenarioWorkloadAdvertisementMissing");
			expect(errorCode(() => validateScenarioWorkload({ ...base, failedScenarioResults: 1 }))).toBe("ScenarioWorkloadResultFailed");
			expect(errorCode(() => validateScenarioWorkload({ ...base, successfulToolResults: 0 }))).toBe("ScenarioWorkloadProofMissing");
			expect(() => validateScenarioWorkload(base)).not.toThrow();
		}

		expect(errorCode(() => parseArgs(["--scenario", "S4", "--milestone", "W1c"]))).toBe("MilestoneCompareRequired");
		expect(
			errorCode(() =>
				parseArgs(["--scenario", "S4", "--compare", "--baseline", "baseline.json", "--milestone", "W1c", "--write-baseline"]),
			),
		).toBe("MilestoneBaselineWriteRejected");
	});

	test("M6 rejects retired re-scope records and preserves the three-run W1c evidence identity", async () => {
		const policy = FLOOR_POLICIES.W1c;
		const tempRoot = await fs.mkdtemp(path.join("/tmp", "gjc-harness-gates-"));
		try {
			for (const [name, record] of [
				["retired-flag.json", { retired: true }],
				["retired-status.json", { status: "retired" }],
			] as const) {
				const filePath = path.join(tempRoot, name);
				await fs.writeFile(filePath, JSON.stringify(record), "utf8");
				await expect(
					loadRescopeReference(filePath, policy, GIT_COMMIT, BINARY_SHA256, 115_064_832, 114_245_632),
				).rejects.toMatchObject({ code: "RescopeReferenceRetired" });
			}

			// Positive-authorization matrix: a complete record whose status is omitted or
			// malformed must never waive a floor (only status === "accepted" authorizes).
			const completeRecord = {
				schemaVersion: 1,
				status: "accepted",
				milestone: "W1c",
				referenceId: "TEST-REF-001",
				gitCommit: GIT_COMMIT,
				baselineStableTreeMedianBytes: 114_245_632,
				currentStableTreeMedianBytes: 115_064_832,
				repairedHarnessBinarySha256: BINARY_SHA256,
				attributionBasis: "test attribution",
				transferTarget: { milestone: "W3b", minimumImprovementPercent: 15 },
				reason: "test reason",
			};
			const malformedStatuses: Array<[string, unknown]> = [
				["status-omitted.json", undefined],
				["status-null.json", null],
				["status-number.json", 1],
				["status-false.json", false],
				["status-pending.json", "pending"],
			];
			for (const [name, status] of malformedStatuses) {
				const record: Record<string, unknown> = { ...completeRecord };
				if (status === undefined) delete record.status;
				else record.status = status;
				const filePath = path.join(tempRoot, name);
				await fs.writeFile(filePath, JSON.stringify(record), "utf8");
				await expect(
					loadRescopeReference(filePath, policy, GIT_COMMIT, BINARY_SHA256, 115_064_832, 114_245_632),
				).rejects.toMatchObject({ code: "RescopeReferenceRetired" });
			}
			const acceptedPath = path.join(tempRoot, "status-accepted.json");
			await fs.writeFile(acceptedPath, JSON.stringify(completeRecord), "utf8");
			await expect(
				loadRescopeReference(acceptedPath, policy, GIT_COMMIT, BINARY_SHA256, 115_064_832, 114_245_632),
			).resolves.toMatchObject({ referenceId: "TEST-REF-001" });

			const checkpointRoot = path.resolve(import.meta.dir, "../.gjc/rss-checkpoints");
			const expectedMedians = [95_797_248, 103_309_312, 104_808_448];
			for (const [index, expectedMedian] of expectedMedians.entries()) {
				const report = JSON.parse(
					await fs.readFile(path.join(checkpointRoot, `w1c-floor-met-run${index + 1}.json`), "utf8"),
				) as {
					metadata?: { gitCommit?: string; binarySha256?: string };
					scenarios?: Array<{ id?: string; rssBytes?: { stableTree?: { median?: number } } }>;
				};
				expect(report.metadata?.gitCommit).toBe(GIT_COMMIT);
				expect(report.metadata?.binarySha256).toBe(BINARY_SHA256);
				expect(report.scenarios?.find(scenario => scenario.id === "S3")?.rssBytes?.stableTree?.median).toBe(expectedMedian);
			}
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});
});

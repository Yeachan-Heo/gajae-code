import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { evaluateDefaultReduction } from "../src/default-reduction-gate";
import { APPLIED_DEFAULT_REDUCTIONS, HELD_DEFAULT_REDUCTIONS } from "../src/default-reductions.ledger";
import { LIVE_DEFAULT_CANDIDATE_FIXTURE_PAIRS } from "../src/live-runner";

const EXPECTED_APPLIED_REDUCTIONS = [
	{
		name: "task.maxConcurrency.default.32-to-8",
		before: 32,
		after: 8,
		tokenMetricBefore: 32,
		tokenMetricAfter: 8,
	},
	{
		name: "task.forkContext.fullFallback.maxTokens.25000-to-15000",
		before: 25_000,
		after: 15_000,
		tokenMetricBefore: 25_000,
		tokenMetricAfter: 15_000,
	},
	{
		name: "task.forkContext.fullFraction.0.25-to-0.15",
		before: 0.25,
		after: 0.15,
		tokenMetricBefore: 0.25,
		tokenMetricAfter: 0.15,
	},
] as const;
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

function readRepoText(relativePath: string): string {
	return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function extractNumericDefault(settingsSchemaSource: string, settingName: string): number {
	const pattern = new RegExp(`"${settingName}": \\{[\\s\\S]*?default: ([0-9_.]+),`);
	const match = pattern.exec(settingsSchemaSource);
	if (!match?.[1]) throw new Error(`Missing default for ${settingName}`);
	return Number(match[1].replaceAll("_", ""));
}

function extractFullForkFraction(taskSource: string): number {
	const match = /contextWindow \* ([0-9.]+)/.exec(taskSource);
	if (!match?.[1]) throw new Error("Missing full fork-context fraction");
	return Number(match[1]);
}

function extractFullForkFallback(taskSource: string): number {
	const match = /const fallback =[\s\S]*?:\s*([0-9_]+);/.exec(taskSource);
	if (!match?.[1]) throw new Error("Missing full fork-context fallback");
	return Number(match[1].replaceAll("_", ""));
}

describe("default reduction evidence ledger", () => {
	test("allows every applied default reduction", () => {
		for (const entry of APPLIED_DEFAULT_REDUCTIONS) {
			expect(evaluateDefaultReduction(entry.evidence), entry.evidence.name).toEqual({
				outcome: "allowed",
				reasons: [],
			});
		}
	});

	test("pins the complete applied reduction ledger to PR #272 expected entries", () => {
		expect(
			APPLIED_DEFAULT_REDUCTIONS.map(entry => ({
				name: entry.evidence.name,
				before: entry.evidence.before,
				after: entry.evidence.after,
				tokenMetricBefore: entry.evidence.tokenMetricBefore,
				tokenMetricAfter: entry.evidence.tokenMetricAfter,
			})),
		).toEqual([...EXPECTED_APPLIED_REDUCTIONS]);
	});

	test("anchors applied reductions to external defaults and executable benchmark/approval evidence", () => {
		const byName = new Map(APPLIED_DEFAULT_REDUCTIONS.map(entry => [entry.evidence.name, entry]));
		const settingsSchemaSource = readRepoText("packages/coding-agent/src/config/settings-schema.ts");
		const taskSource = readRepoText("packages/coding-agent/src/task/index.ts");

		expect(byName.get("task.maxConcurrency.default.32-to-8")?.evidence.after).toBe(
			extractNumericDefault(settingsSchemaSource, "task.maxConcurrency"),
		);
		expect(byName.get("task.forkContext.fullFallback.maxTokens.25000-to-15000")?.evidence.after).toBe(
			extractFullForkFallback(taskSource),
		);
		expect(byName.get("task.forkContext.fullFraction.0.25-to-0.15")?.evidence.after).toBe(
			extractFullForkFraction(taskSource),
		);

		for (const entry of APPLIED_DEFAULT_REDUCTIONS) {
			expect(entry.evidence.benchmarkEvidence).toEqual({
				suite: "orchestration-token-benchmark",
				command: "bun --cwd=packages/orchestration-token-benchmark test",
				fixtureSuccessCriterion: "after>=before",
				tokenMetricCriterion: "after<before",
				status: "passed",
			});
			expect(entry.evidence.humanApprovalEvidence).toMatchObject({
				approved: true,
				source: "github-pr",
				prNumber: 272,
				approver: "Yeachan-Heo",
			});
			expect(entry.evidence.humanApprovalEvidence?.reference).toStartWith(
				"https://github.com/Yeachan-Heo/gajae-code/pull/272",
			);
		}
	});

	test("blocks drifted ledger evidence even when before/after values still reduce", () => {
		const entry = APPLIED_DEFAULT_REDUCTIONS[0];
		expect(entry).toBeDefined();
		const decision = evaluateDefaultReduction({
			...entry!.evidence,
			fixtureSuccessRateAfter: entry!.evidence.fixtureSuccessRateBefore - 0.01,
		});

		expect(decision.outcome).toBe("blocked");
		expect(decision.reasons).toContain("fixture success rate regressed");
	});

	test("blocks every held default reduction until PR9 live evidence exists", () => {
		for (const entry of HELD_DEFAULT_REDUCTIONS) {
			expect(evaluateDefaultReduction(entry.candidate).outcome, entry.candidate.name).toBe("blocked");
			expect(entry.requiresLiveEvidenceVia).toBe("pr9-live-runner");
			expect(entry.reason).toContain("HELD/BLOCKED");
			expect(entry.reason).toContain("PR9 live before/after runner evidence is required");
		}
	});

	test("keeps held reductions backed by PR9 live fixture pairs", () => {
		const candidatePairs = new Set(LIVE_DEFAULT_CANDIDATE_FIXTURE_PAIRS.map(pair => pair.candidate));
		for (const entry of HELD_DEFAULT_REDUCTIONS) {
			expect(candidatePairs.has(entry.candidate.name), entry.candidate.name).toBe(true);
		}
	});
});

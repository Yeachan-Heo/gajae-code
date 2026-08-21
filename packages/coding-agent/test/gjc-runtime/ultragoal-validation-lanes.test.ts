import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { UltragoalChangeSetPath } from "@gajae-code/coding-agent/gjc-runtime/ultragoal-change-set";
import {
	computeCheckpointChangeSet,
	computeUltragoalReviewSourceHash,
	createUltragoalPlan,
	runNativeUltragoalCommand,
	validateUltragoalQualityGateReadOnly,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";
import { isHighRiskChangePath } from "@gajae-code/coding-agent/gjc-runtime/ultragoal-validation-policy";

const TEST_SESSION_ID = "test-session-4560";

async function tempDir(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "pi-ultragoal-lanes-"));
}

/** Seed a git repo whose working-tree diff is exactly `files`. */
async function seedGitRepo(root: string, files: Record<string, string>): Promise<void> {
	const { $ } = await import("bun");
	await $`git init`.cwd(root).quiet();
	await $`git config user.email test@example.com`.cwd(root).quiet();
	await $`git config user.name test`.cwd(root).quiet();
	await Bun.write(path.join(root, ".gitignore"), ".gjc/\nartifacts/\n");
	for (const file of Object.keys(files)) {
		await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
		await Bun.write(path.join(root, file), "// base\n");
	}
	await $`git add .`.cwd(root).quiet();
	await $`git commit -m base`.cwd(root).quiet();
	for (const [file, content] of Object.entries(files)) {
		await Bun.write(path.join(root, file), content);
	}
}

function baseGate(sourceHash: string, cohortLanes: Record<string, unknown>): Record<string, unknown> {
	return {
		architectReview: {
			architectureStatus: "CLEAR",
			productStatus: "CLEAR",
			codeStatus: "CLEAR",
			recommendation: "APPROVE",
			evidence: "architect synthesis across architecture/product/code",
			commands: ["architect lane"],
			blockers: [],
		},
		executorQa: {
			status: "passed",
			e2eStatus: "passed",
			redTeamStatus: "passed",
			evidence: "executor-built e2e and red-team QA results",
			e2eCommands: ["bun test:e2e"],
			redTeamCommands: ["bun test:red-team"],
			artifactRefs: [
				{ id: "ref-1", kind: "api-package-test-report", path: "artifacts/report.json", description: "api report" },
			],
			contractCoverage: [
				{
					id: "cc-1",
					contractRef: "C1",
					obligation: "exports work",
					status: "covered",
					surfaceEvidenceRefs: ["se-1"],
					adversarialCaseRefs: ["ac-1"],
				},
			],
			surfaceEvidence: [
				{
					id: "se-1",
					contractRef: "C1",
					surface: "api",
					invocation: "bun run probe",
					verdict: "passed",
					artifactRefs: ["ref-1"],
				},
			],
			adversarialCases: [
				{
					id: "ac-1",
					contractRef: "C1",
					scenario: "empty input",
					expectedBehavior: "no throw",
					verdict: "passed",
					artifactRefs: ["ref-1"],
				},
			],
			blockers: [],
		},
		iteration: {
			status: "passed",
			evidence: "clean loop",
			fullRerun: true,
			rerunCommands: ["bun test:e2e"],
			reviewCohort: {
				reviewGeneration: 1,
				sourceHash,
				joined: true,
				lanes: cohortLanes,
			},
			blockers: [],
		},
	};
}

function lane(sourceHash: string, status = "passed"): Record<string, unknown> {
	return { status, sourceHash, evidence: "lane evidence over the frozen source", blockers: [] };
}

describe("ultragoal validation lane selection gate (#4560)", () => {
	let root: string;
	let cleanup: string[] = [];
	let priorSessionId: string | undefined;

	beforeEach(() => {
		cleanup = [];
		priorSessionId = process.env.GJC_SESSION_ID;
	});

	afterEach(async () => {
		for (const dir of cleanup) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
		// Restore the ambient session id so shard order never becomes load-bearing.
		if (priorSessionId === undefined) delete process.env.GJC_SESSION_ID;
		else process.env.GJC_SESSION_ID = priorSessionId;
	});

	async function seedPlan(goalCount: number, files: Record<string, string>): Promise<void> {
		root = await tempDir();
		cleanup.push(root);
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await seedGitRepo(root, files);
		const brief = goalCount === 1 ? "Single low-risk goal" : "@goal: A\na\n@goal: B\nb";
		await createUltragoalPlan({ cwd: root, brief });
		await Bun.write(path.join(root, "artifacts", "report.json"), JSON.stringify({ ok: true }));
	}

	it("classifies embedded auth names and generated native bindings as high risk", () => {
		const path = (value: string, category?: UltragoalChangeSetPath["category"]): UltragoalChangeSetPath => ({
			path: value,
			status: "modified",
			...(category ? { category } : {}),
		});
		expect(isHighRiskChangePath(path("packages/ai/src/my-auth-helper.ts"))).toBe(true);
		expect(isHighRiskChangePath(path("packages/natives/native/index.js", "generated-binding"))).toBe(true);
	});

	async function sourceHash(): Promise<string> {
		const result = await runNativeUltragoalCommand(["quality-gate", "source-hash", "--json"], root);
		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout ?? "{}") as { sourceHash?: unknown };
		if (typeof payload.sourceHash !== "string") throw new Error("expected an authoritative source hash");
		return payload.sourceHash;
	}

	it("prints the same authoritative source hash through the supported CLI surface", async () => {
		await seedPlan(1, { "packages/utils/src/helper.ts": "export const x = 1;\n" });
		const cliHash = await sourceHash();
		const internalHash = computeUltragoalReviewSourceHash(await computeCheckpointChangeSet(root));
		if (!internalHash) throw new Error("expected internal authoritative source hash");
		expect(cliHash).toBe(internalHash);
	});

	it("round-trips the real low-risk lane-selection CLI payload through validation", async () => {
		await seedPlan(1, { "packages/utils/src/helper.ts": "export const x = 1;\n" });
		const frozen = await sourceHash();
		await seedPriorCohort(frozen);
		const selectionResult = await runNativeUltragoalCommand(["quality-gate", "lane-selection", "--json"], root);
		expect(selectionResult.status).toBe(0);
		const selection = JSON.parse(selectionResult.stdout ?? "{}");
		const gate = baseGate(frozen, { qa: lane(frozen) });
		gate.validationLaneSelection = selection.validationLaneSelection;
		const result = await validateUltragoalQualityGateReadOnly({
			cwd: root,
			qualityGateJson: JSON.stringify(gate),
			goalId: "G001",
		});
		expect(result.errors).toEqual([]);
		expect(result.valid).toBe(true);
	});

	it("round-trips the real high-risk native-binding lane-selection CLI payload through validation", async () => {
		await seedPlan(1, { "packages/natives/native/index.js": "export const native = true;\n" });
		const frozen = await sourceHash();
		const selectionResult = await runNativeUltragoalCommand(["quality-gate", "lane-selection", "--json"], root);
		expect(selectionResult.status).toBe(0);
		const selection = JSON.parse(selectionResult.stdout ?? "{}");
		const gate = baseGate(frozen, {
			cleaner: lane(frozen, "CLEAR"),
			architect: lane(frozen, "CLEAR"),
			qa: lane(frozen),
		});
		gate.criticReview = {
			verdict: "OKAY",
			evidence: "terminal critic approved the high-risk boundary",
			blockers: [],
		};
		gate.validationLaneSelection = selection.validationLaneSelection;
		const result = await validateUltragoalQualityGateReadOnly({
			cwd: root,
			qualityGateJson: JSON.stringify(gate),
			goalId: "G001",
		});
		expect(result.errors).toEqual([]);
		expect(result.valid).toBe(true);
	});

	it("hashes an untracked symlink by link identity without reading its external target", async () => {
		if (process.platform === "win32") return;
		await seedPlan(1, { "packages/utils/src/helper.ts": "export const x = 1;\n" });
		const outside = await tempDir();
		cleanup.push(outside);
		const target = path.join(outside, "secret.txt");
		await Bun.write(target, "first secret\n");
		await fs.symlink(target, path.join(root, "external-link"));
		const before = await sourceHash();
		await Bun.write(target, "changed secret\n");
		const after = await sourceHash();
		expect(after).toBe(before);
	});

	/** Append a prior verified complete-checkpoint cohort with `sourceHash`. */
	async function seedPriorCohort(sourceHash: string): Promise<void> {
		const ledgerPath = path.join(root, ".gjc", `_session-${TEST_SESSION_ID}`, "ultragoal", "ledger.jsonl");
		const existing = await Bun.file(ledgerPath).text();
		const event = {
			eventId: "prior-1",
			event: "goal_checkpointed",
			goalId: "G001",
			status: "complete",
			evidence: "prior verified boundary",
			qualityGateJson: { iteration: { reviewCohort: { reviewGeneration: 1, sourceHash, joined: true } } },
		};
		await Bun.write(ledgerPath, `${existing}${JSON.stringify(event)}\n`);
	}

	it("accepts a QA-only cohort with a matching low-risk lane-selection proof", async () => {
		await seedPlan(1, { "packages/utils/src/helper.ts": "export const x = 1;\n" });
		const frozen = await sourceHash();
		await seedPriorCohort(frozen);
		const gate = baseGate(frozen, { qa: lane(frozen) });
		gate.validationLaneSelection = {
			riskClass: "low",
			reasons: ["riskClass=low", "basisUnchanged=true"],
			omittedLanes: ["cleaner", "architect", "terminal-critic"],
		};
		const result = await validateUltragoalQualityGateReadOnly({
			cwd: root,
			qualityGateJson: JSON.stringify(gate),
			goalId: "G001",
		});
		expect(result.errors).toEqual([]);
		expect(result.valid).toBe(true);
	});

	it("rejects the reduced cohort when the runtime computes high risk", async () => {
		await seedPlan(1, { "packages/coding-agent/src/sdk/session.ts": "export const y = 2;\n" });
		const frozen = await sourceHash();
		const gate = baseGate(frozen, { qa: lane(frozen) });
		gate.validationLaneSelection = {
			riskClass: "low",
			reasons: ["riskClass=high", "basisUnchanged=false", "heavyweightReasons=high-risk-paths"],
			omittedLanes: ["cleaner", "architect", "terminal-critic"],
		};
		const result = await validateUltragoalQualityGateReadOnly({
			cwd: root,
			qualityGateJson: JSON.stringify(gate),
			goalId: "G001",
		});
		expect(result.valid).toBe(false);
		expect(result.errors.some(e => e.code === "selection_mismatch")).toBe(true);
		// And the cohort validation still demands the full lanes.
		expect(result.errors.some(e => e.code === "review_cohort_invalid")).toBe(true);
	});

	it("rejects a reduced cohort without any lane-selection proof", async () => {
		await seedPlan(1, { "packages/utils/src/helper.ts": "export const x = 1;\n" });
		const frozen = await sourceHash();
		const gate = baseGate(frozen, { qa: lane(frozen) });
		const result = await validateUltragoalQualityGateReadOnly({
			cwd: root,
			qualityGateJson: JSON.stringify(gate),
			goalId: "G001",
		});
		expect(result.valid).toBe(false);
		expect(result.errors.some(e => e.code === "review_cohort_invalid")).toBe(true);
	});

	it("rejects a selection proof that tries to omit the QA lane", async () => {
		await seedPlan(1, { "packages/utils/src/helper.ts": "export const x = 1;\n" });
		const gate = baseGate(await sourceHash(), {});
		gate.validationLaneSelection = {
			riskClass: "low",
			reasons: ["riskClass=low", "basisUnchanged=false"],
			omittedLanes: ["cleaner", "architect", "qa"],
		};
		const result = await validateUltragoalQualityGateReadOnly({
			cwd: root,
			qualityGateJson: JSON.stringify(gate),
			goalId: "G001",
		});
		expect(result.valid).toBe(false);
		expect(result.errors.some(e => e.code === "qa_lane_mandatory")).toBe(true);
	});

	it("keeps the full cohort mandatory for multi-goal runs even with a declared proof", async () => {
		await seedPlan(2, { "packages/utils/src/helper.ts": "export const x = 1;\n" });
		const frozen = await sourceHash();
		const gate = baseGate(frozen, {
			cleaner: lane(frozen, "CLEAR"),
			architect: lane(frozen, "CLEAR"),
			qa: lane(frozen),
		});
		const full = await validateUltragoalQualityGateReadOnly({
			cwd: root,
			qualityGateJson: JSON.stringify(gate),
			goalId: "G001",
		});
		// Full cohort on a multi-goal run validates (structural pass expected).
		expect(full.errors.filter(e => e.code === "review_cohort_invalid")).toEqual([]);
		const reduced = baseGate(frozen, { qa: lane(frozen) });
		reduced.validationLaneSelection = {
			riskClass: "low",
			reasons: ["riskClass=high", "basisUnchanged=false", "heavyweightReasons=multiple-outstanding-goals"],
			omittedLanes: ["cleaner", "architect", "terminal-critic"],
		};
		const rejected = await validateUltragoalQualityGateReadOnly({
			cwd: root,
			qualityGateJson: JSON.stringify(reduced),
			goalId: "G001",
		});
		expect(rejected.valid).toBe(false);
		expect(rejected.errors.some(e => e.code === "selection_mismatch")).toBe(true);
	});

	it("rejects a reused self-declared cohort hash after the source changes", async () => {
		await seedPlan(1, { "packages/utils/src/helper.ts": "export const x = 1;\n" });
		const frozen = await sourceHash();
		await seedPriorCohort(frozen);
		await Bun.write(path.join(root, "packages/utils/src/helper.ts"), "export const x = 2;\n");
		const gate = baseGate(frozen, { qa: lane(frozen) });
		gate.validationLaneSelection = {
			riskClass: "low",
			reasons: ["riskClass=low", "basisUnchanged=false"],
			omittedLanes: ["cleaner", "architect", "terminal-critic"],
		};
		const result = await validateUltragoalQualityGateReadOnly({
			cwd: root,
			qualityGateJson: JSON.stringify(gate),
			goalId: "G001",
		});
		expect(result.valid).toBe(false);
		expect(result.errors.some(error => error.code === "source_hash_mismatch")).toBe(true);
		expect(result.errors.some(error => error.code === "critic_verdict_not_okay")).toBe(true);
	});

	it("rejects fabricated low-risk selection reasons", async () => {
		await seedPlan(1, { "packages/utils/src/helper.ts": "export const x = 1;\n" });
		const frozen = await sourceHash();
		const gate = baseGate(frozen, { qa: lane(frozen) });
		gate.validationLaneSelection = {
			riskClass: "low",
			reasons: ["model-says-safe"],
			omittedLanes: ["cleaner", "architect", "terminal-critic"],
		};
		const result = await validateUltragoalQualityGateReadOnly({
			cwd: root,
			qualityGateJson: JSON.stringify(gate),
			goalId: "G001",
		});
		expect(result.valid).toBe(false);
		expect(result.errors.some(error => error.code === "reasons_mismatch")).toBe(true);
	});
});

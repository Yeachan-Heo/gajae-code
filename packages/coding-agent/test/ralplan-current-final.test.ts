import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveRalplanCurrentFinal, selectsRalplanApprovalGate } from "../src/gjc-runtime/ralplan-current-final";
import { modeStatePath, sessionPlansDir } from "../src/gjc-runtime/session-layout";
import { createUltragoalPlan } from "../src/gjc-runtime/ultragoal-runtime";
import { assertUltragoalAskAllowed } from "../src/tools/ultragoal-ask-guard";

const SESSION = "session-current-final";

let cwd: string;
let runDir: string;

function sha256(bytes: string): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

interface StageInput {
	stage: string;
	stageN: number;
	body: string;
	autoHandoff?: Record<string, unknown>;
	/** Override the recorded hash so a test can simulate a rewritten artifact. */
	recordedSha?: string;
	/** Write the row for a path that is never created. */
	skipWrite?: boolean;
}

async function writeRun(
	stages: StageInput[],
	options: {
		phase?: string;
		autoHandoff?: string;
		executionBoundary?: "plan-only" | "approval-required";
		admission?: Record<string, unknown>;
		skipState?: boolean;
	} = {},
): Promise<void> {
	await fs.mkdir(runDir, { recursive: true });
	const statePath = modeStatePath(cwd, SESSION, "ralplan");
	await fs.mkdir(path.dirname(statePath), { recursive: true });
	if (!options.skipState) {
		await Bun.write(
			statePath,
			`${JSON.stringify({
				run_id: path.basename(runDir),
				skill: "ralplan",
				active: true,
				current_phase: options.phase ?? "final",
				...(options.executionBoundary ? { execution_boundary: options.executionBoundary } : {}),
				...(options.admission ? { auto_handoff: options.admission } : {}),
			})}\n`,
		);
	}
	if (options.autoHandoff) {
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await Bun.write(
			path.join(cwd, ".gjc", "settings.json"),
			`${JSON.stringify({ gjc: { ralplan: { autoHandoff: options.autoHandoff } } })}\n`,
		);
	}
	const rows: string[] = [];
	for (const stage of stages) {
		const filePath = path.join(runDir, `stage-${String(stage.stageN).padStart(2, "0")}-${stage.stage}.md`);
		if (!stage.skipWrite) await Bun.write(filePath, stage.body);
		rows.push(
			JSON.stringify({
				stage: stage.stage,
				stage_n: stage.stageN,
				path: filePath,
				created_at: "2026-01-01T00:00:00.000Z",
				sha256: stage.recordedSha ?? sha256(stage.body),
				...(stage.autoHandoff ? { auto_handoff: stage.autoHandoff } : {}),
			}),
		);
	}
	await Bun.write(path.join(runDir, "index.jsonl"), `${rows.join("\n")}\n`);
}

const reviewed: StageInput[] = [
	{ stage: "planner", stageN: 1, body: "plan\n" },
	{ stage: "architect", stageN: 2, body: "architect pass\n" },
	{ stage: "critic", stageN: 3, body: "critic pass\n" },
	{ stage: "final", stageN: 4, body: "final\n" },
];

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ralplan-current-final-"));
	runDir = path.join(sessionPlansDir(cwd, SESSION), "ralplan", "2026-01-01-0000-abcd");
});

afterEach(async () => {
	await fs.rm(cwd, { recursive: true, force: true });
});

describe("resolveRalplanCurrentFinal", () => {
	it("returns a descriptor for a reviewed current final", async () => {
		await writeRun(reviewed);
		const resolution = await resolveRalplanCurrentFinal({ cwd, sessionId: SESSION });
		expect(resolution.ok).toBe(true);
		if (!resolution.ok) return;
		expect(resolution.descriptor.runId).toBe("2026-01-01-0000-abcd");
		expect(resolution.descriptor.finalPath).toBe(path.join(runDir, "stage-04-final.md"));
		expect(resolution.descriptor.finalSha256).toBe(sha256("final\n"));
		expect(resolution.descriptor.plannerSha256).toBe(sha256("plan\n"));
		expect(resolution.descriptor.reviewerSha256).toEqual({
			architect: sha256("architect pass\n"),
			critic: sha256("critic pass\n"),
		});
		expect(resolution.descriptor.sessionId).toBe(SESSION);
	});

	it("refuses when there is no run state for this session", async () => {
		await writeRun(reviewed, { skipState: true });
		const resolution = await resolveRalplanCurrentFinal({ cwd, sessionId: SESSION });
		expect(resolution.ok).toBe(false);
		if (resolution.ok) return;
		expect(resolution.refusal.code).toBe("missing_state");
	});

	it("refuses a run that is not in its final phase", async () => {
		await writeRun(reviewed, { phase: "critic" });
		const resolution = await resolveRalplanCurrentFinal({ cwd, sessionId: SESSION });
		expect(resolution.ok).toBe(false);
		if (resolution.ok) return;
		expect(resolution.refusal.code).toBe("run_not_final");
	});

	it("refuses when auto handoff is enabled", async () => {
		await writeRun(reviewed, { autoHandoff: "ultragoal" });
		const resolution = await resolveRalplanCurrentFinal({ cwd, sessionId: SESSION });
		expect(resolution.ok).toBe(false);
		if (resolution.ok) return;
		expect(resolution.refusal.code).toBe("auto_handoff_enabled");
	});

	it("allows only the recorded approval-required boundary when config enables auto handoff", async () => {
		const admission = {
			configuredTarget: "ultragoal",
			effectiveTarget: "off",
			degradationReason: "execution_boundary",
			source: path.join(cwd, ".gjc", "config.yml"),
			executionBoundary: "approval-required",
		};
		await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
		await Bun.write(path.join(cwd, ".gjc", "config.yml"), "gjc:\n  ralplan:\n    autoHandoff: ultragoal\n");
		await writeRun(
			reviewed.map(stage => (stage.stage === "final" ? { ...stage, autoHandoff: admission } : stage)),
			{ executionBoundary: "approval-required", admission },
		);

		const resolution = await resolveRalplanCurrentFinal({ cwd, sessionId: SESSION });
		expect(resolution.ok).toBe(true);
	});

	it("never offers execution approval for a plan-only run", async () => {
		await writeRun(reviewed, { executionBoundary: "plan-only" });
		const resolution = await resolveRalplanCurrentFinal({ cwd, sessionId: SESSION });
		expect(resolution).toMatchObject({
			ok: false,
			refusal: { code: "execution_boundary_plan_only" },
		});
	});

	it("refuses a final that a later revision superseded", async () => {
		await writeRun([...reviewed, { stage: "revision", stageN: 5, body: "revised\n" }]);
		const resolution = await resolveRalplanCurrentFinal({ cwd, sessionId: SESSION });
		expect(resolution.ok).toBe(false);
		if (resolution.ok) return;
		expect(resolution.refusal.code).toBe("final_not_last");
	});

	it("refuses a final whose reviewers predate the current iteration", async () => {
		await writeRun([
			{ stage: "planner", stageN: 1, body: "plan v1\n" },
			{ stage: "architect", stageN: 2, body: "architect v1\n" },
			{ stage: "critic", stageN: 3, body: "critic v1\n" },
			{ stage: "revision", stageN: 4, body: "plan v2\n" },
			{ stage: "final", stageN: 5, body: "final v2\n" },
		]);
		const resolution = await resolveRalplanCurrentFinal({ cwd, sessionId: SESSION });
		expect(resolution.ok).toBe(false);
		if (resolution.ok) return;
		expect(resolution.refusal.code).toBe("missing_reviewers");
	});

	it("refuses a final with no planner stage at all", async () => {
		await writeRun([
			{ stage: "architect", stageN: 1, body: "architect\n" },
			{ stage: "critic", stageN: 2, body: "critic\n" },
			{ stage: "final", stageN: 3, body: "final\n" },
		]);
		const resolution = await resolveRalplanCurrentFinal({ cwd, sessionId: SESSION });
		expect(resolution.ok).toBe(false);
		if (resolution.ok) return;
		expect(resolution.refusal.code).toBe("no_iteration_opener");
	});

	it("refuses a final whose artifact was rewritten after it was recorded", async () => {
		await writeRun(reviewed);
		await Bun.write(path.join(runDir, "stage-04-final.md"), "tampered\n");
		const resolution = await resolveRalplanCurrentFinal({ cwd, sessionId: SESSION });
		expect(resolution.ok).toBe(false);
		if (resolution.ok) return;
		expect(resolution.refusal.code).toBe("hash_mismatch");
	});

	it("refuses when a referenced artifact is missing", async () => {
		await writeRun([...reviewed.slice(0, 3), { ...reviewed[3], skipWrite: true }]);
		const resolution = await resolveRalplanCurrentFinal({ cwd, sessionId: SESSION });
		expect(resolution.ok).toBe(false);
		if (resolution.ok) return;
		expect(resolution.refusal.code).toBe("artifact_missing");
	});

	it("refuses a row that points outside the run directory", async () => {
		await writeRun(reviewed);
		const outsidePath = path.join(cwd, "outside.md");
		await Bun.write(outsidePath, "outside\n");
		await Bun.write(
			path.join(runDir, "index.jsonl"),
			`${[
				JSON.stringify({ stage: "planner", stage_n: 1, path: outsidePath, sha256: sha256("outside\n") }),
				JSON.stringify({
					stage: "architect",
					stage_n: 2,
					path: path.join(runDir, "stage-02-architect.md"),
					sha256: sha256("architect pass\n"),
				}),
				JSON.stringify({
					stage: "critic",
					stage_n: 3,
					path: path.join(runDir, "stage-03-critic.md"),
					sha256: sha256("critic pass\n"),
				}),
				JSON.stringify({
					stage: "final",
					stage_n: 4,
					path: path.join(runDir, "stage-04-final.md"),
					sha256: sha256("final\n"),
				}),
			].join("\n")}\n`,
		);
		const resolution = await resolveRalplanCurrentFinal({ cwd, sessionId: SESSION });
		expect(resolution.ok).toBe(false);
		if (resolution.ok) return;
		expect(resolution.refusal.code).toBe("artifact_outside_run");
	});

	it("refuses a malformed index row instead of skipping it", async () => {
		await writeRun(reviewed);
		const indexPath = path.join(runDir, "index.jsonl");
		const existing = await Bun.file(indexPath).text();
		await Bun.write(indexPath, `${existing}{"stage":"final"\n`);
		const resolution = await resolveRalplanCurrentFinal({ cwd, sessionId: SESSION });
		expect(resolution.ok).toBe(false);
		if (resolution.ok) return;
		expect(resolution.refusal.code).toBe("malformed_index");
	});

	it("refuses another session's run", async () => {
		await writeRun(reviewed);
		const resolution = await resolveRalplanCurrentFinal({ cwd, sessionId: "session-other" });
		expect(resolution.ok).toBe(false);
		if (resolution.ok) return;
		expect(resolution.refusal.code).toBe("missing_state");
	});
});

const ORDINARY_ASK = { questions: [{ id: "q", question: "Which way?", options: [{ label: "A" }] }] };
const RALPLAN_APPROVAL_ASK = {
	questions: [
		{
			id: "gate",
			question: "Approve this final for execution?",
			options: [{ label: "Approve" }],
			workflowGate: { stage: "ralplan", kind: "approval" },
		},
	],
};

describe("ralplan execution approval through the ultragoal ask guard", () => {
	it("recognizes only the ralplan approval gate", () => {
		expect(selectsRalplanApprovalGate(RALPLAN_APPROVAL_ASK)).toBe(true);
		expect(selectsRalplanApprovalGate(ORDINARY_ASK)).toBe(false);
		expect(
			selectsRalplanApprovalGate({
				questions: [{ workflowGate: { stage: "ralplan", kind: "execution" } }],
			}),
		).toBe(false);
		expect(selectsRalplanApprovalGate(undefined)).toBe(false);
		expect(selectsRalplanApprovalGate({})).toBe(false);
	});

	it("admits the approval ask while the goal is still incomplete, and keeps blocking ordinary asks", async () => {
		await createUltragoalPlan({ cwd, brief: "Implement the repair", sessionId: SESSION });
		await writeRun(reviewed);

		await expect(
			assertUltragoalAskAllowed(cwd, { sessionId: SESSION }, undefined, RALPLAN_APPROVAL_ASK),
		).resolves.toBeUndefined();
		// The same blocked goal still refuses an ordinary question.
		await expect(assertUltragoalAskAllowed(cwd, { sessionId: SESSION }, undefined, ORDINARY_ASK)).rejects.toThrow(
			/Ultragoal/,
		);
	});

	it("refuses the approval ask when the final was rewritten", async () => {
		await createUltragoalPlan({ cwd, brief: "Implement the repair", sessionId: SESSION });
		await writeRun(reviewed);
		await Bun.write(path.join(runDir, "stage-04-final.md"), "tampered\n");

		await expect(
			assertUltragoalAskAllowed(cwd, { sessionId: SESSION }, undefined, RALPLAN_APPROVAL_ASK),
		).rejects.toThrow(/refused the ralplan execution approval: .*recorded hash/);
	});

	it("refuses the approval ask when there is no current final at all", async () => {
		await createUltragoalPlan({ cwd, brief: "Implement the repair", sessionId: SESSION });

		await expect(
			assertUltragoalAskAllowed(cwd, { sessionId: SESSION }, undefined, RALPLAN_APPROVAL_ASK),
		).rejects.toThrow(/refused the ralplan execution approval: no ralplan run state/);
	});
});

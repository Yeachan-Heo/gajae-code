import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	appendOrMergeDeepInterviewRound,
	enrichDeepInterviewRoundScoring,
	runDeepInterviewPostCommitEffects,
} from "@gajae-code/coding-agent/gjc-runtime/deep-interview-recorder";
import { runDeepInterviewRepairCommand } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-repair";
import { runNativeDeepInterviewCommand } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-runtime";
import { activeSnapshotPath, modeStatePath } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import { reconcileWorkflowSkillState, runNativeStateCommand } from "@gajae-code/coding-agent/gjc-runtime/state-runtime";
import { syncSkillActiveState } from "@gajae-code/coding-agent/skill-state/active-state";

const TEST_SESSION_ID = "test-session";
const tempRoots: string[] = [];
let priorSessionId: string | undefined;

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-di-hud-sync-"));
	tempRoots.push(dir);
	return dir;
}
async function seedRecorderState(cwd: string): Promise<void> {
	const result = await runNativeDeepInterviewCommand(["--json", "seed recorder state"], cwd);
	expect(result.status).toBe(0);
	const initialized = await runDeepInterviewRepairCommand(
		[
			"initialize-context",
			"--session-id",
			TEST_SESSION_ID,
			"--schema-version",
			"1",
			"--expected-revision",
			"0",
			"--input-json",
			'{"type":"greenfield","threshold":0.05}',
			"--json",
		],
		cwd,
	);
	expect(initialized.status).toBe(0);
}

beforeAll(() => {
	priorSessionId = process.env.GJC_SESSION_ID;
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
});

afterAll(() => {
	if (priorSessionId !== undefined) process.env.GJC_SESSION_ID = priorSessionId;
	else delete process.env.GJC_SESSION_ID;
});

afterEach(async () => {
	for (const dir of tempRoots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function deepInterviewChips(cwd: string): Promise<Record<string, string | undefined>> {
	const raw = JSON.parse(await fs.readFile(activeSnapshotPath(cwd, TEST_SESSION_ID), "utf-8")) as {
		active_skills?: Array<{ skill: string; hud?: { chips?: Array<{ label: string; value?: string }> } }>;
	};
	const entry = (raw.active_skills ?? []).find(skill => skill.skill === "deep-interview");
	return Object.fromEntries((entry?.hud?.chips ?? []).map(chip => [chip.label, chip.value]));
}

describe("deep-interview recorder -> HUD sync", () => {
	it("refreshes active-state HUD round count after recording an answered round", async () => {
		const cwd = await tempDir();
		const statePath = modeStatePath(cwd, TEST_SESSION_ID, "deep-interview");
		await seedRecorderState(cwd);
		await appendOrMergeDeepInterviewRound(
			cwd,
			statePath,
			{
				round: 1,
				questionId: "q1",
				questionText: "What is the core entity?",
				component: "api",
				dimension: "goal",
				ambiguity: 0.8,
				selectedOptions: ["A"],
			},
			{ sessionId: TEST_SESSION_ID },
		);
		const chips = await deepInterviewChips(cwd);
		expect(chips.round).toBe("1");
		expect(chips.phase).toBe("interviewing");
	});

	it("refreshes HUD ambiguity after scoring enrichment", async () => {
		const cwd = await tempDir();
		const statePath = modeStatePath(cwd, TEST_SESSION_ID, "deep-interview");
		await seedRecorderState(cwd);
		await appendOrMergeDeepInterviewRound(
			cwd,
			statePath,
			{ round: 1, questionId: "q1", questionText: "Q?" },
			{ sessionId: TEST_SESSION_ID },
		);
		await enrichDeepInterviewRoundScoring(
			cwd,
			statePath,
			{
				round: 1,
				questionId: "q1",
				scores: { goal: 0.5, constraints: 0.5, criteria: 0.5 },
				ambiguity: 0.45,
			},
			{ sessionId: TEST_SESSION_ID },
		);
		const chips = await deepInterviewChips(cwd);
		expect(chips.round).toBe("1");
		expect(chips.ambiguity).toContain("50%");
	});
	it("suppresses a reversed post-commit HUD completion from an older mode revision", async () => {
		const cwd = await tempDir();
		const statePath = modeStatePath(cwd, TEST_SESSION_ID, "deep-interview");
		const envelope = (roundCount: number) => ({
			current_phase: "interviewing",
			state: {
				rounds: Array.from({ length: roundCount }, (_, index) => ({
					round_key: `k${index + 1}`,
					round: index + 1,
					lifecycle: "answered",
				})),
				established_facts: [],
				threshold: 0.05,
			},
		});
		await runDeepInterviewPostCommitEffects({
			cwd,
			statePath,
			sessionId: TEST_SESSION_ID,
			envelope: envelope(2),
			revision: 2,
			writer: "test",
		});
		await runDeepInterviewPostCommitEffects({
			cwd,
			statePath,
			sessionId: TEST_SESSION_ID,
			envelope: envelope(1),
			revision: 1,
			writer: "test",
		});
		expect((await deepInterviewChips(cwd)).round).toBe("2");
	});
	it("rejects a stale recorder HUD sync after its in-process ordering slot is reinitialized", async () => {
		const cwd = await tempDir();
		const statePath = modeStatePath(cwd, TEST_SESSION_ID, "deep-interview");
		await syncSkillActiveState({
			cwd,
			skill: "deep-interview",
			active: true,
			phase: "interviewing",
			sessionId: TEST_SESSION_ID,
			hud: { version: 1, chips: [{ label: "round", value: "2" }] },
			committedModeRevision: 2,
		});

		await runDeepInterviewPostCommitEffects({
			cwd,
			statePath,
			sessionId: TEST_SESSION_ID,
			envelope: {
				current_phase: "interviewing",
				state: { rounds: [{ round_key: "k1", round: 1, lifecycle: "answered" }], established_facts: [] },
			},
			revision: 1,
			writer: "reinitialized-recorder",
		});

		const activePath = path.join(
			cwd,
			".gjc",
			`_session-${TEST_SESSION_ID}`,
			"state",
			"active",
			"deep-interview.json",
		);
		const active = JSON.parse(await fs.readFile(activePath, "utf-8"));
		expect(active.committed_mode_state_revision).toBe(2);
		expect((await deepInterviewChips(cwd)).round).toBe("2");
	});
});

describe("deep-interview gjc state write preserves recorder rounds", () => {
	it("does not drop recorder-written rounds on a partial scoring write", async () => {
		const cwd = await tempDir();
		const statePath = modeStatePath(cwd, TEST_SESSION_ID, "deep-interview");
		await seedRecorderState(cwd);
		await appendOrMergeDeepInterviewRound(
			cwd,
			statePath,
			{ round: 1, questionId: "q1", questionText: "Q1?" },
			{ sessionId: TEST_SESSION_ID },
		);
		await appendOrMergeDeepInterviewRound(
			cwd,
			statePath,
			{ round: 2, questionId: "q2", questionText: "Q2?" },
			{ sessionId: TEST_SESSION_ID },
		);

		const write = await runNativeStateCommand(
			[
				"write",
				"--mode",
				"deep-interview",
				"--input",
				JSON.stringify({ state: { current_ambiguity: 0.3, topology: { last_targeted_component_id: "api" } } }),
			],
			cwd,
		);
		expect(write.status).toBe(0);

		const onDisk = JSON.parse(await fs.readFile(statePath, "utf-8"));
		expect(onDisk.state.rounds).toHaveLength(2);
		expect(onDisk.state.current_ambiguity).toBe(0.3);
		expect(Object.hasOwn(onDisk, "rounds")).toBe(false);
	});
});

describe("deep-interview reconcile and write produce identical HUD", () => {
	it("derives the same HUD chips for the same normalized payload", async () => {
		const payloadState = {
			rounds: [{ round_key: "k1", round: 1, lifecycle: "scored", ambiguity: 0.4 }],
			current_ambiguity: 0.4,
			threshold: 0.05,
			topology: {
				last_targeted_component_id: "api",
				components: [{ id: "api", status: "active", weakest_dimension: "goal" }],
			},
		};

		const writeCwd = await tempDir();
		await runNativeStateCommand(
			[
				"write",
				"--mode",
				"deep-interview",
				"--input",
				JSON.stringify({ current_phase: "interviewing", state: payloadState }),
			],
			writeCwd,
		);
		const writeChips = await deepInterviewChips(writeCwd);

		const reconcileCwd = await tempDir();
		await reconcileWorkflowSkillState({
			cwd: reconcileCwd,
			mode: "deep-interview",
			sessionId: TEST_SESSION_ID,
			active: true,
			phase: "interviewing",
			payload: { current_phase: "interviewing", state: payloadState },
		});
		const reconcileChips = await deepInterviewChips(reconcileCwd);

		expect(writeChips).toEqual(reconcileChips);
		expect(writeChips.round).toBe("1");
		expect(writeChips.target).toBe("api");
		expect(writeChips.weakest).toBe("goal");
	});
});

describe("deep-interview spec persistence canonicalizes state", () => {
	it("writes canonical nested state for a missing prior state", async () => {
		const cwd = await tempDir();
		const result = await runNativeDeepInterviewCommand(
			["--write", "--stage", "final", "--slug", "canon-missing", "--spec", "# Spec", "--json"],
			cwd,
		);
		expect(result.status).toBe(0);
		const onDisk = JSON.parse(await fs.readFile(modeStatePath(cwd, TEST_SESSION_ID, "deep-interview"), "utf-8"));
		expect(onDisk.current_phase).toBe("handoff");
		expect(onDisk.spec_slug).toBe("canon-missing");
		expect(Array.isArray(onDisk.state?.rounds)).toBe(true);
		expect(Array.isArray(onDisk.state?.established_facts)).toBe(true);
	});

	it("hoists flattened legacy transcript into nested state during spec persistence", async () => {
		const cwd = await tempDir();
		const statePath = modeStatePath(cwd, TEST_SESSION_ID, "deep-interview");
		await fs.mkdir(path.dirname(statePath), { recursive: true });
		await fs.writeFile(
			statePath,
			`${JSON.stringify({
				skill: "deep-interview",
				current_phase: "interviewing",
				rounds: [{ round_key: "k1", round: 1, lifecycle: "scored", ambiguity: 0.4 }],
				current_ambiguity: 0.4,
			})}\n`,
		);
		const result = await runNativeDeepInterviewCommand(
			["--write", "--stage", "final", "--slug", "canon-flat", "--spec", "# Spec", "--json"],
			cwd,
		);
		expect(result.status).toBe(0);
		const onDisk = JSON.parse(await fs.readFile(statePath, "utf-8"));
		expect(onDisk.state.rounds).toHaveLength(1);
		expect(onDisk.state.current_ambiguity).toBe(0.4);
		expect(Object.hasOwn(onDisk, "rounds")).toBe(false);
	});
});

describe("deep-interview handoff canonicalizes caller state", () => {
	it("rewrites a flattened deep-interview caller into canonical nested state on handoff", async () => {
		const cwd = await tempDir();
		const statePath = modeStatePath(cwd, TEST_SESSION_ID, "deep-interview");
		await fs.mkdir(path.dirname(statePath), { recursive: true });
		await fs.writeFile(
			statePath,
			`${JSON.stringify({
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
				rounds: [{ round_key: "k1", round: 1, lifecycle: "scored", ambiguity: 0.4 }],
				current_ambiguity: 0.4,
			})}\n`,
		);
		const result = await runNativeStateCommand(
			["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
			cwd,
		);
		expect(result.status).toBe(0);
		const onDisk = JSON.parse(await fs.readFile(statePath, "utf-8"));
		expect(onDisk.active).toBe(false);
		expect(onDisk.handoff_to).toBe("ralplan");
		expect(onDisk.state.rounds).toHaveLength(1);
		expect(Object.hasOwn(onDisk, "rounds")).toBe(false);
	});
});

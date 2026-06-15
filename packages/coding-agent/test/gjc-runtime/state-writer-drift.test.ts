import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runNativeDeepInterviewCommand } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-runtime";
import { runNativeRalplanCommand } from "@gajae-code/coding-agent/gjc-runtime/ralplan-runtime";
import { migrateAndPersistLegacyState } from "@gajae-code/coding-agent/gjc-runtime/state-migrations";
import { runNativeStateCommand } from "@gajae-code/coding-agent/gjc-runtime/state-runtime";
import { RequiredOnWriteEnvelopeSchema } from "@gajae-code/coding-agent/gjc-runtime/state-schema";
import { writeWorkflowEnvelopeAtomic } from "@gajae-code/coding-agent/gjc-runtime/state-writer";
import {
	type GjcTeamSnapshot,
	persistGjcTeamModeStateSummary,
} from "@gajae-code/coding-agent/gjc-runtime/team-runtime";
import { recordSkillActivation } from "@gajae-code/coding-agent/hooks/skill-state";
import { WORKFLOW_STATE_VERSION } from "@gajae-code/coding-agent/skill-state/workflow-state-contract";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-state-writer-drift-"));
	tempRoots.push(dir);
	return dir;
}

afterAll(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function readJson(filePath: string): Promise<Record<string, unknown>> {
	return JSON.parse(await fs.readFile(filePath, "utf-8")) as Record<string, unknown>;
}

async function readAuditEntries(root: string): Promise<Array<Record<string, unknown>>> {
	try {
		const raw = await fs.readFile(path.join(root, ".gjc", "state", "audit.jsonl"), "utf-8");
		return raw
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

async function expectPersistedEnvelope(filePath: string): Promise<void> {
	const value = await readJson(filePath);
	const parsed = RequiredOnWriteEnvelopeSchema.safeParse(value);
	expect(parsed.success).toBe(true);
	expect(value.version).toBe(WORKFLOW_STATE_VERSION);
}

describe("workflow state writer drift guard", () => {
	it("persists required-on-write envelopes for state write, clear, and handoff", async () => {
		const root = await tempDir();
		const sessionId = "drift-session";
		const deepPath = path.join(root, ".gjc", "state", "sessions", sessionId, "deep-interview-state.json");
		const ralplanPath = path.join(root, ".gjc", "state", "sessions", sessionId, "ralplan-state.json");

		const write = await runNativeStateCommand(
			[
				"write",
				"--mode",
				"deep-interview",
				"--session-id",
				sessionId,
				"--input",
				JSON.stringify({ current_phase: "interviewing" }),
				"--json",
			],
			root,
		);
		expect(write.status).toBe(0);
		await expectPersistedEnvelope(deepPath);

		const clear = await runNativeStateCommand(["clear", "--mode", "deep-interview", "--session-id", sessionId], root);
		expect(clear.status).toBe(0);
		await expectPersistedEnvelope(deepPath);

		const seed = await runNativeStateCommand(
			[
				"write",
				"--mode",
				"deep-interview",
				"--session-id",
				sessionId,
				"--input",
				JSON.stringify({ current_phase: "handoff" }),
				"--force",
			],
			root,
		);
		expect(seed.status).toBe(0);
		const handoff = await runNativeStateCommand(
			["handoff", "--mode", "deep-interview", "--session-id", sessionId, "--to", "ralplan"],
			root,
		);
		expect(handoff.status).toBe(0);
		await expectPersistedEnvelope(deepPath);
		await expectPersistedEnvelope(ralplanPath);
	});

	it("persists required-on-write envelope for ralplan seed", async () => {
		const root = await tempDir();
		const result = await runNativeRalplanCommand(["--json", "scope this change"], root);
		expect(result.status).toBe(0);
		await expectPersistedEnvelope(path.join(root, ".gjc", "state", "ralplan-state.json"));
	});

	it("persists required-on-write envelope for hook initialized mode-state", async () => {
		const root = await tempDir();
		const state = await recordSkillActivation({
			cwd: root,
			text: "$deep-interview clarify this",
			sessionId: "hook-session",
			threadId: "hook-thread",
			nowIso: "2026-01-01T00:00:00.000Z",
		});
		expect(state?.initialized_state_path).toBe(
			path.join(root, ".gjc", "state", "sessions", "hook-session", "deep-interview-state.json"),
		);
		await expectPersistedEnvelope(state?.initialized_state_path ?? "");
	});

	it("persists required-on-write v2 envelope for ralplan persist-run-id from legacy v1 state", async () => {
		const root = await tempDir();
		const statePath = path.join(root, ".gjc", "state", "ralplan-state.json");
		await fs.mkdir(path.dirname(statePath), { recursive: true });
		await fs.writeFile(
			statePath,
			`${JSON.stringify({ version: 1, skill: "ralplan", active: true, current_phase: "planning", updated_at: "2026-01-01T00:00:00.000Z" })}\n`,
			"utf-8",
		);

		const result = await runNativeRalplanCommand(
			["--write", "--stage", "planner", "--stage_n", "1", "--artifact", "# Plan", "--run-id", "legacy-run"],
			root,
		);
		expect(result.status).toBe(0);
		await expectPersistedEnvelope(statePath);
	});

	it("normalizes ralplan persist-run-id when legacy v1 already has the selected run_id", async () => {
		const root = await tempDir();
		const statePath = path.join(root, ".gjc", "state", "ralplan-state.json");
		await fs.mkdir(path.dirname(statePath), { recursive: true });
		await fs.writeFile(
			statePath,
			`${JSON.stringify({ version: 1, skill: "ralplan", active: true, current_phase: "planning", updated_at: "2026-01-01T00:00:00.000Z", run_id: "legacy-run" })}\n`,
			"utf-8",
		);

		const result = await runNativeRalplanCommand(
			["--write", "--stage", "planner", "--stage_n", "1", "--artifact", "# Plan", "--run-id", "legacy-run"],
			root,
		);
		expect(result.status).toBe(0);
		await expectPersistedEnvelope(statePath);
		const persisted = await readJson(statePath);
		expect(persisted.run_id).toBe("legacy-run");
	});

	it("persists required-on-write v2 envelope for ralplan planner-state from legacy v1 state", async () => {
		const root = await tempDir();
		const statePath = path.join(root, ".gjc", "state", "ralplan-state.json");
		await fs.mkdir(path.dirname(statePath), { recursive: true });
		await fs.writeFile(
			statePath,
			`${JSON.stringify({ version: 1, skill: "ralplan", active: true, current_phase: "planning", updated_at: "2026-01-01T00:00:00.000Z", run_id: "legacy-planner" })}\n`,
			"utf-8",
		);

		const result = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"planner",
				"--stage_n",
				"1",
				"--artifact",
				"# Plan",
				"--planner-id",
				"0-Planner",
				"--planner-resumable",
				"true",
			],
			root,
		);
		expect(result.status).toBe(0);
		await expectPersistedEnvelope(statePath);
	});

	it("persists required-on-write envelope for deep-interview seed and spec handoff state", async () => {
		const root = await tempDir();
		const seed = await runNativeDeepInterviewCommand(["--json", "clarify this"], root);
		expect(seed.status).toBe(0);
		const statePath = path.join(root, ".gjc", "state", "deep-interview-state.json");
		await expectPersistedEnvelope(statePath);

		const write = await runNativeDeepInterviewCommand(
			["--write", "--stage", "final", "--slug", "drift", "--spec", "# Spec", "--json"],
			root,
		);
		expect(write.status).toBe(0);
		await expectPersistedEnvelope(statePath);
	});

	it("persists required-on-write envelope for team summary without starting tmux", async () => {
		const root = await tempDir();
		const snapshot: GjcTeamSnapshot = {
			team_name: "drift-team",
			display_name: "Drift Team",
			phase: "running",
			state_dir: path.join(root, ".gjc", "state", "team", "drift-team"),
			tmux_session: "drift-team",
			tmux_session_name: "drift-team",
			tmux_target: "drift-team:",
			task_total: 0,
			task_counts: { pending: 0, blocked: 0, in_progress: 0, completed: 0, failed: 0 },
			workers: [],
			worker_lifecycle_by_id: {},
			notification_summary: {
				total: 0,
				replay_eligible: 0,
				by_state: { pending: 0, sent: 0, queued: 0, deferred: 0, failed: 0, delivered: 0, acknowledged: 0 },
			},
			updated_at: new Date().toISOString(),
		};
		await persistGjcTeamModeStateSummary(snapshot, root);
		await expectPersistedEnvelope(path.join(root, ".gjc", "state", "team-state.json"));
	});

	it("persists required-on-write envelope for explicit legacy migration", async () => {
		const root = await tempDir();
		const statePath = path.join(root, ".gjc", "state", "ralplan-state.json");
		await fs.mkdir(path.dirname(statePath), { recursive: true });
		await fs.writeFile(
			statePath,
			`${JSON.stringify({ version: 1, skill: "ralplan", active: true, current_phase: "planning", updated_at: "2026-01-01T00:00:00.000Z" })}\n`,
			"utf-8",
		);

		const result = await migrateAndPersistLegacyState({ cwd: root, skill: "ralplan", statePath });
		expect(result.migrated).toBe(true);
		await expectPersistedEnvelope(statePath);
	});

	it("rejects incomplete workflow envelopes before atomic write", async () => {
		const root = await tempDir();
		await expect(
			writeWorkflowEnvelopeAtomic(
				path.join(root, ".gjc", "state", "ralplan-state.json"),
				{ skill: "ralplan", active: true, current_phase: "planner" },
				{ cwd: root, receipt: { cwd: root, skill: "ralplan", owner: "gjc-runtime", command: "test incomplete" } },
			),
		).rejects.toThrow(/invalid workflow state envelope/);
	});

	it("rejects an unknown manifest phase on an internal envelope write (#658)", async () => {
		const root = await tempDir();
		await expect(
			writeWorkflowEnvelopeAtomic(
				path.join(root, ".gjc", "state", "ralplan-state.json"),
				{
					skill: "ralplan",
					version: WORKFLOW_STATE_VERSION,
					active: true,
					current_phase: "bogus-phase",
					updated_at: "2026-01-01T00:00:00.000Z",
				},
				{
					cwd: root,
					receipt: { cwd: root, skill: "ralplan", owner: "gjc-runtime", command: "test unknown phase" },
				},
			),
		).rejects.toThrow(/unknown ralplan phase "bogus-phase"/);
	});

	it("allows a valid manifest phase with no direct transition edge (#658 preserves skips)", async () => {
		const root = await tempDir();
		const statePath = path.join(root, ".gjc", "state", "ralplan-state.json");
		// planner -> final has no manifest edge; short-mode skips persist a valid state
		// directly, so the invariant must accept it (it only rejects non-manifest phases).
		await writeWorkflowEnvelopeAtomic(
			statePath,
			{
				skill: "ralplan",
				version: WORKFLOW_STATE_VERSION,
				active: true,
				current_phase: "final",
				updated_at: "2026-01-01T00:00:00.000Z",
			},
			{ cwd: root, receipt: { cwd: root, skill: "ralplan", owner: "gjc-runtime", command: "test skip" } },
		);
		await expectPersistedEnvelope(statePath);
		const persisted = await readJson(statePath);
		expect(persisted.current_phase).toBe("final");
	});

	it("lets a forced write bypass the unknown-phase invariant (#658 preserves forced writes)", async () => {
		const root = await tempDir();
		const statePath = path.join(root, ".gjc", "state", "ralplan-state.json");
		await writeWorkflowEnvelopeAtomic(
			statePath,
			{
				skill: "ralplan",
				version: WORKFLOW_STATE_VERSION,
				active: true,
				current_phase: "bogus-phase",
				updated_at: "2026-01-01T00:00:00.000Z",
			},
			{
				cwd: root,
				receipt: { cwd: root, skill: "ralplan", owner: "gjc-runtime", command: "test forced bypass" },
				audit: { category: "state", verb: "write", owner: "gjc-runtime", skill: "ralplan", forced: true },
			},
		);
		await expectPersistedEnvelope(statePath);
		const persisted = await readJson(statePath);
		expect(persisted.current_phase).toBe("bogus-phase");
	});

	it("flags an invalid phase transition on an internal write but still persists it (#658 transition invariant)", async () => {
		const root = await tempDir();
		const statePath = path.join(root, ".gjc", "state", "ralplan-state.json");
		const base = {
			skill: "ralplan" as const,
			version: WORKFLOW_STATE_VERSION,
			active: true,
			updated_at: "2026-01-01T00:00:00.000Z",
		};
		const opts = {
			cwd: root,
			receipt: { cwd: root, skill: "ralplan" as const, owner: "gjc-runtime" as const, command: "test transition" },
		};
		// Seed a valid active prior phase, then jump planner -> final (no manifest edge).
		await writeWorkflowEnvelopeAtomic(statePath, { ...base, current_phase: "planner" }, opts);

		// The diagnostic-only path must NOT touch stderr (callers may treat stderr as failure
		// or parse machine output): capture stderr across the invalid-edge write.
		const originalWrite = process.stderr.write.bind(process.stderr);
		let stderrCaptured = "";
		process.stderr.write = ((chunk: unknown) => {
			stderrCaptured += typeof chunk === "string" ? chunk : String(chunk);
			return true;
		}) as typeof process.stderr.write;
		try {
			await writeWorkflowEnvelopeAtomic(statePath, { ...base, current_phase: "final" }, opts);
		} finally {
			process.stderr.write = originalWrite;
		}
		expect(stderrCaptured).toBe("");

		// The invalid edge is recorded as audit evidence, not blocked.
		await expectPersistedEnvelope(statePath);
		expect((await readJson(statePath)).current_phase).toBe("final");
		const flagged = (await readAuditEntries(root)).filter(e => e.verb === "invalid_transition_detected");
		expect(flagged.length).toBe(1);
		expect(flagged[0]?.from_phase).toBe("planner");
		expect(flagged[0]?.to_phase).toBe("final");
	});

	it("does not flag a valid manifest phase transition on an internal write (#658)", async () => {
		const root = await tempDir();
		const statePath = path.join(root, ".gjc", "state", "ralplan-state.json");
		const base = {
			skill: "ralplan" as const,
			version: WORKFLOW_STATE_VERSION,
			active: true,
			updated_at: "2026-01-01T00:00:00.000Z",
		};
		const opts = {
			cwd: root,
			receipt: { cwd: root, skill: "ralplan" as const, owner: "gjc-runtime" as const, command: "test valid edge" },
		};
		await writeWorkflowEnvelopeAtomic(statePath, { ...base, current_phase: "planner" }, opts);
		await writeWorkflowEnvelopeAtomic(statePath, { ...base, current_phase: "architect" }, opts);

		expect((await readJson(statePath)).current_phase).toBe("architect");
		const flagged = (await readAuditEntries(root)).filter(e => e.verb === "invalid_transition_detected");
		expect(flagged.length).toBe(0);
	});

	it("lets a forced write bypass the transition invariant (#658)", async () => {
		const root = await tempDir();
		const statePath = path.join(root, ".gjc", "state", "ralplan-state.json");
		const base = {
			skill: "ralplan" as const,
			version: WORKFLOW_STATE_VERSION,
			active: true,
			updated_at: "2026-01-01T00:00:00.000Z",
		};
		await writeWorkflowEnvelopeAtomic(
			statePath,
			{ ...base, current_phase: "planner" },
			{
				cwd: root,
				receipt: { cwd: root, skill: "ralplan", owner: "gjc-runtime", command: "test forced seed" },
			},
		);
		await writeWorkflowEnvelopeAtomic(
			statePath,
			{ ...base, current_phase: "final" },
			{
				cwd: root,
				receipt: { cwd: root, skill: "ralplan", owner: "gjc-runtime", command: "test forced jump" },
				audit: { category: "state", verb: "write", owner: "gjc-runtime", skill: "ralplan", forced: true },
			},
		);

		expect((await readJson(statePath)).current_phase).toBe("final");
		const flagged = (await readAuditEntries(root)).filter(e => e.verb === "invalid_transition_detected");
		expect(flagged.length).toBe(0);
	});

	it("does not flag reactivation from an inactive prior envelope (#658)", async () => {
		const root = await tempDir();
		const statePath = path.join(root, ".gjc", "state", "deep-interview-state.json");
		const opts = {
			cwd: root,
			receipt: {
				cwd: root,
				skill: "deep-interview" as const,
				owner: "gjc-runtime" as const,
				command: "test reactivate",
			},
		};
		// A cleared/terminal prior envelope (active:false, terminal phase) is not a transition
		// source: a fresh kickoff reactivating to the initial phase must not be flagged even
		// though `complete -> interviewing` has no manifest edge.
		await writeWorkflowEnvelopeAtomic(
			statePath,
			{
				skill: "deep-interview",
				version: WORKFLOW_STATE_VERSION,
				active: false,
				current_phase: "complete",
				updated_at: "2026-01-01T00:00:00.000Z",
			},
			opts,
		);
		await writeWorkflowEnvelopeAtomic(
			statePath,
			{
				skill: "deep-interview",
				version: WORKFLOW_STATE_VERSION,
				active: true,
				current_phase: "interviewing",
				updated_at: "2026-01-01T00:00:01.000Z",
			},
			opts,
		);

		expect((await readJson(statePath)).current_phase).toBe("interviewing");
		const flagged = (await readAuditEntries(root)).filter(e => e.verb === "invalid_transition_detected");
		expect(flagged.length).toBe(0);
	});
});

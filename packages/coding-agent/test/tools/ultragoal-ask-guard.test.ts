import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolContext } from "@gajae-code/agent-core";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	activeEntryPath,
	activeSnapshotPath,
	modeStatePath,
	sessionActivityPath,
	transactionJournalPath,
	ultragoalAskHandoffCommitPath,
} from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import { reconcileWorkflowSkillState, runNativeStateCommand } from "@gajae-code/coding-agent/gjc-runtime/state-runtime";
import { stampWorkflowEnvelopeChecksum } from "@gajae-code/coding-agent/gjc-runtime/state-writer";
import { isUltragoalAskBlocked } from "@gajae-code/coding-agent/gjc-runtime/ultragoal-guard";
import {
	addUltragoalSubgoal,
	computeUltragoalPlanGeneration,
	createUltragoalPlan,
	getUltragoalPaths,
	hashStructuredValue,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { syncSkillActiveState } from "@gajae-code/coding-agent/skill-state/active-state";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { AskTool } from "@gajae-code/coding-agent/tools/ask";
import { ToolError } from "@gajae-code/coding-agent/tools/tool-errors";
import { guardToolForUltragoalAsk } from "@gajae-code/coding-agent/tools/ultragoal-ask-guard";

const TEST_SESSION_ID = "ultragoal-ask-guard-test-session";
const ORIGINAL_GJC_SESSION_ID = process.env.GJC_SESSION_ID;
const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-ultragoal-ask-guard-"));
	tempRoots.push(dir);
	return dir;
}

beforeAll(async () => {
	await initTheme(false);
});

afterEach(async () => {
	if (ORIGINAL_GJC_SESSION_ID === undefined) delete process.env.GJC_SESSION_ID;
	else process.env.GJC_SESSION_ID = ORIGINAL_GJC_SESSION_ID;
	delete process.env.GJC_STATE_HANDOFF_FAIL_BEFORE_ASK_COMMIT;
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
	delete process.env.GJC_STATE_HANDOFF_FAIL_AFTER_ASK_COMMIT;
});

function createSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function createContext(select: () => Promise<string | undefined>): AgentToolContext {
	return {
		hasUI: true,
		ui: {
			select: async () => select(),
			editor: async () => undefined,
		},
		abort: () => {},
	} as unknown as AgentToolContext;
}

async function writeActivityMarker(cwd: string, sessionId: string, updatedAt: string): Promise<void> {
	await Bun.write(
		sessionActivityPath(cwd, sessionId),
		`${JSON.stringify({ session_id: sessionId, updated_at: updatedAt, writer: "test" }, null, 2)}\n`,
	);
}

async function writeActiveDeepInterviewState(cwd: string, sessionId: string): Promise<void> {
	await syncSkillActiveState({
		cwd,
		sessionId,
		skill: "deep-interview",
		active: true,
		phase: "interviewing",
	});
}
async function prepareUltragoalCaller(cwd: string, sessionId: string, active = true, phase = "handoff"): Promise<void> {
	const prepared = await runNativeStateCommand(
		[
			"write",
			"--mode",
			"ultragoal",
			"--session-id",
			sessionId,
			"--input",
			JSON.stringify({ active, current_phase: phase }),
			"--json",
		],
		cwd,
	);
	expect(prepared.status, prepared.stderr).toBe(0);
}

async function handoffUltragoal(
	cwd: string,
	sessionId: string,
	callee: "deep-interview" | "ralplan",
	expectedStatus = 0,
): Promise<void> {
	await prepareUltragoalCaller(cwd, sessionId);
	const result = await runNativeStateCommand(
		["handoff", "--mode", "ultragoal", "--to", callee, "--session-id", sessionId, "--json"],
		cwd,
	);
	expect(result.status, result.stderr).toBe(expectedStatus);
}

function stubAskTool(execute: () => Promise<void>): AgentTool {
	return {
		name: "ask",
		label: "Ask",
		summary: "Ask",
		description: "Ask",
		parameters: {} as never,
		strict: true,
		execute: async () => {
			await execute();
			return { content: [{ type: "text", text: "asked" }], details: {} };
		},
	};
}

// Mirrors ExtensionToolWrapper: a prototype `execute` that reads instance state via
// `this`. A detached call (`const exec = tool.execute; exec()`) loses `this` and throws
// "undefined is not an object (evaluating 'this.runner')".
class StubExtensionWrappedAskTool {
	name = "ask";
	label = "Ask";
	summary = "Ask";
	description = "Ask";
	parameters = {} as never;
	strict = true;
	runner = { hasHandlers: () => false };
	executeArgs: unknown[] | null = null;
	async execute(...args: unknown[]): Promise<{ content: { type: "text"; text: string }[]; details: object }> {
		this.runner.hasHandlers();
		this.executeArgs = args;
		return { content: [{ type: "text", text: "asked" }], details: {} };
	}
}

describe("ultragoal ask guard", () => {
	it("allows ask when durable ultragoal state is absent without requiring ambient GJC_SESSION_ID", async () => {
		const cwd = await tempDir();
		const previousSessionId = process.env.GJC_SESSION_ID;
		delete process.env.GJC_SESSION_ID;
		try {
			const diagnostic = await isUltragoalAskBlocked(cwd);
			expect(diagnostic.active).toBe(false);
			expect(diagnostic.source).toBe("absent");
			expect(diagnostic.goalsPath).toBe(path.join(cwd, ".gjc", "ultragoal", "goals.json"));
		} finally {
			if (previousSessionId === undefined) delete process.env.GJC_SESSION_ID;
			else process.env.GJC_SESSION_ID = previousSessionId;
		}
	});

	it("blocks latest session-scoped ultragoal ask when GJC_SESSION_ID is absent", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		delete process.env.GJC_SESSION_ID;

		const diagnostic = await isUltragoalAskBlocked(cwd);

		expect(diagnostic.active).toBe(true);
		expect(diagnostic.source).toBe("goals_json");
		expect(diagnostic.goalsPath).toBe(getUltragoalPaths(cwd, TEST_SESSION_ID).goalsPath);
		expect(diagnostic.message).toContain("record-review-blockers");
	});

	it("blocks SDK-initial-path style wrapped ask while ultragoal is active", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		const execute = vi.fn(async () => {});
		const guarded = guardToolForUltragoalAsk(stubAskTool(execute), () => cwd);

		await expect(guarded.execute("call", {}, undefined, undefined, undefined as never)).rejects.toThrow(ToolError);
		await expect(guarded.execute("call", {}, undefined, undefined, undefined as never)).rejects.toThrow(
			/try-harder nudge/,
		);
		expect(execute).not.toHaveBeenCalled();
	});

	it("preserves `this` for a prototype-method ask tool when ultragoal is inactive (regression)", async () => {
		const cwd = await tempDir();
		const tool = new StubExtensionWrappedAskTool();
		const guarded = guardToolForUltragoalAsk(tool as unknown as AgentTool, () => cwd);

		// Must not throw "undefined is not an object (evaluating 'this.runner')".
		const result = await guarded.execute("call", { foo: 1 }, undefined, undefined, undefined as never);

		expect(result.content[0]).toMatchObject({ type: "text", text: "asked" });
		expect(tool.executeArgs).toEqual(["call", { foo: 1 }, undefined, undefined, undefined]);
	});

	it("blocks an unwrapped AskTool before prompting while ultragoal is active", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		const select = vi.fn(async () => "Yes");
		const tool = new AskTool(createSession(cwd));

		await expect(
			tool.execute(
				"call",
				{ questions: [{ id: "q", question: "Ask?", options: [{ label: "Yes" }] }] },
				undefined,
				undefined,
				createContext(select),
			),
		).rejects.toThrow(/try-harder nudge/);
		expect(select).not.toHaveBeenCalled();
	});
	it("allows active deep-interview ask when latest ultragoal sessions are ambiguous", async () => {
		const cwd = await tempDir();
		const deepSessionId = "deep-interview-active-session";
		const ultragoalSessionA = "ultragoal-ambiguous-a";
		const ultragoalSessionB = "ultragoal-ambiguous-b";
		const tiedActivity = "2026-06-29T00:00:00.000Z";

		process.env.GJC_SESSION_ID = ultragoalSessionA;
		await createUltragoalPlan({ cwd, brief: "Implement the first stale story" });
		process.env.GJC_SESSION_ID = ultragoalSessionB;
		await createUltragoalPlan({ cwd, brief: "Implement the second stale story" });
		delete process.env.GJC_SESSION_ID;

		await writeActivityMarker(cwd, ultragoalSessionA, tiedActivity);
		await writeActivityMarker(cwd, ultragoalSessionB, tiedActivity);
		await writeActiveDeepInterviewState(cwd, deepSessionId);

		const select = vi.fn(async () => "Continue");
		const tool = new AskTool(
			createSession(cwd, {
				getSessionId: () => deepSessionId,
				getActiveSkillState: () => ({ skill: "deep-interview", session_id: deepSessionId }),
			}),
		);

		const result = await tool.execute(
			"call",
			{ questions: [{ id: "q", question: "Continue interview?", options: [{ label: "Continue" }] }] },
			undefined,
			undefined,
			createContext(select),
		);

		expect(select).toHaveBeenCalledTimes(1);
		expect(result.content[0]).toMatchObject({ type: "text" });
	});

	it("allows active deep-interview ask after same-session ultragoal handoff", async () => {
		const cwd = await tempDir();
		const sessionId = "deep-interview-after-ultragoal-handoff";

		process.env.GJC_SESSION_ID = sessionId;
		await createUltragoalPlan({ cwd, brief: "Implement the same-session story" });
		await handoffUltragoal(cwd, sessionId, "deep-interview");

		const select = vi.fn(async () => "Continue");
		const tool = new AskTool(
			createSession(cwd, {
				getSessionId: () => sessionId,
				getActiveSkillState: () => ({ skill: "deep-interview", session_id: sessionId }),
			}),
		);

		const result = await tool.execute(
			"call",
			{ questions: [{ id: "q", question: "Continue interview?", options: [{ label: "Continue" }] }] },
			undefined,
			undefined,
			createContext(select),
		);

		expect(select).toHaveBeenCalledTimes(1);
		expect(result.content[0]).toMatchObject({ type: "text" });
	});
	it("allows ask after a committed same-session ultragoal to ralplan handoff", async () => {
		const cwd = await tempDir();
		const sessionId = "ralplan-after-ultragoal-handoff";

		process.env.GJC_SESSION_ID = sessionId;
		await createUltragoalPlan({ cwd, brief: "Implement the same-session story" });
		await handoffUltragoal(cwd, sessionId, "ralplan");

		const diagnostic = await isUltragoalAskBlocked(cwd, { sessionId });

		expect(diagnostic.active).toBe(false);
		expect(diagnostic.reason).toContain("committed workflow handoff to ralplan");
	});
	it("rejects an inactive ultragoal caller before mutating a handoff", async () => {
		const cwd = await tempDir();
		const sessionId = "inactive-ultragoal-handoff";

		process.env.GJC_SESSION_ID = sessionId;
		await createUltragoalPlan({ cwd, brief: "Implement the same-session story" });
		await prepareUltragoalCaller(cwd, sessionId, false);
		const result = await runNativeStateCommand(
			["handoff", "--mode", "ultragoal", "--to", "deep-interview", "--session-id", sessionId, "--json"],
			cwd,
		);

		expect(result.status).toBe(2);
		await expect(fs.access(modeStatePath(cwd, sessionId, "deep-interview"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(
			fs.access(path.dirname(ultragoalAskHandoffCommitPath(cwd, sessionId, "inactive-handoff"))),
		).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("rejects an ultragoal caller outside the explicit handoff phase", async () => {
		const cwd = await tempDir();
		const sessionId = "wrong-phase-ultragoal-handoff";

		process.env.GJC_SESSION_ID = sessionId;
		await createUltragoalPlan({ cwd, brief: "Implement the same-session story" });
		await prepareUltragoalCaller(cwd, sessionId, true, "pending");
		const result = await runNativeStateCommand(
			["handoff", "--mode", "ultragoal", "--to", "ralplan", "--session-id", sessionId, "--json"],
			cwd,
		);

		expect(result.status).toBe(2);
		await expect(fs.access(modeStatePath(cwd, sessionId, "ralplan"))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("rejects a replacement plan that reuses the authorized run ID", async () => {
		const cwd = await tempDir();
		const sessionId = "reused-plan-run-id-handoff";

		process.env.GJC_SESSION_ID = sessionId;
		const originalPlan = await createUltragoalPlan({ cwd, brief: "Implement the original story" });
		await handoffUltragoal(cwd, sessionId, "deep-interview");
		await createUltragoalPlan({ cwd, brief: "Implement the replacement story" });
		const paths = getUltragoalPaths(cwd, sessionId);
		const replacement = JSON.parse(await fs.readFile(paths.goalsPath, "utf8"));
		replacement.planRunId = originalPlan.planRunId;
		await fs.writeFile(paths.goalsPath, JSON.stringify(replacement, null, 2));

		const diagnostic = await isUltragoalAskBlocked(cwd, { sessionId });

		expect(diagnostic.active).toBe(true);
		expect(diagnostic.source).toBe("goals_json");
	});
	it("rejects a restored same-run plan after sanctioned ledger advancement", async () => {
		const cwd = await tempDir();
		const sessionId = "restored-plan-ledger-generation-handoff";

		process.env.GJC_SESSION_ID = sessionId;
		await createUltragoalPlan({ cwd, brief: "Implement the same-session story" });
		const paths = getUltragoalPaths(cwd, sessionId);
		const authorizedPlan = await fs.readFile(paths.goalsPath, "utf8");
		await handoffUltragoal(cwd, sessionId, "deep-interview");
		await addUltragoalSubgoal({
			cwd,
			title: "Later required work",
			objective: "Implement the later required work",
			evidence: "The original plan needs this required follow-up implementation task.",
			rationale: "The sanctioned steering mutation advances the authoritative ledger.",
		});
		await fs.writeFile(paths.goalsPath, authorizedPlan);

		const diagnostic = await isUltragoalAskBlocked(cwd, { sessionId });

		expect(diagnostic.active).toBe(true);
		expect(diagnostic.source).toBe("goals_json");
	});
	it("strips handoff authority during sanctioned migration", async () => {
		const cwd = await tempDir();
		const sessionId = "migrate-handoff-authority";

		process.env.GJC_SESSION_ID = sessionId;
		await createUltragoalPlan({ cwd, brief: "Implement the same-session story" });
		await handoffUltragoal(cwd, sessionId, "ralplan");
		const migration = await runNativeStateCommand(
			["migrate", "--mode", "ralplan", "--session-id", sessionId, "--json"],
			cwd,
		);

		expect(migration.status, migration.stderr).toBe(0);
		const calleeState = JSON.parse(await fs.readFile(modeStatePath(cwd, sessionId, "ralplan"), "utf8"));
		const diagnostic = await isUltragoalAskBlocked(cwd, { sessionId });
		expect(calleeState.ultragoal_ask_handoff).toBeUndefined();
		expect(diagnostic.active).toBe(true);
	});
	it("cannot revive handoff authority through clear then reconciliation", async () => {
		const cwd = await tempDir();
		const sessionId = "clear-reconcile-handoff-replay";

		process.env.GJC_SESSION_ID = sessionId;
		await createUltragoalPlan({ cwd, brief: "Implement the same-session story" });
		await handoffUltragoal(cwd, sessionId, "deep-interview");
		const cleared = await runNativeStateCommand(
			["clear", "--mode", "deep-interview", "--session-id", sessionId, "--json"],
			cwd,
		);
		expect(cleared.status, cleared.stderr).toBe(0);
		await reconcileWorkflowSkillState({
			cwd,
			mode: "deep-interview",
			sessionId,
			active: true,
			phase: "interviewing",
			payload: {},
		});

		const calleeState = JSON.parse(await fs.readFile(modeStatePath(cwd, sessionId, "deep-interview"), "utf8"));
		const diagnostic = await isUltragoalAskBlocked(cwd, { sessionId });
		expect(calleeState.ultragoal_ask_handoff).toBeUndefined();
		expect(diagnostic.active).toBe(true);
	});
	it("rejects matching mode states without a durable handleHandoff commit", async () => {
		const cwd = await tempDir();
		const sessionId = "missing-handoff-commit";

		process.env.GJC_SESSION_ID = sessionId;
		await createUltragoalPlan({ cwd, brief: "Implement the same-session story" });
		await handoffUltragoal(cwd, sessionId, "deep-interview");
		const callerState = JSON.parse(await fs.readFile(modeStatePath(cwd, sessionId, "ultragoal"), "utf8"));
		await fs.rm(ultragoalAskHandoffCommitPath(cwd, sessionId, callerState.ultragoal_ask_handoff.mutation_id));

		const diagnostic = await isUltragoalAskBlocked(cwd, { sessionId });

		expect(diagnostic.active).toBe(true);
		expect(diagnostic.source).toBe("goals_json");
	});
	it("invalidates handoff ask authority on a later sanctioned state write", async () => {
		const cwd = await tempDir();
		const sessionId = "state-write-after-handoff";

		process.env.GJC_SESSION_ID = sessionId;
		await createUltragoalPlan({ cwd, brief: "Implement the same-session story" });
		await handoffUltragoal(cwd, sessionId, "deep-interview");
		const write = await runNativeStateCommand(
			[
				"write",
				"--mode",
				"deep-interview",
				"--session-id",
				sessionId,
				"--input",
				JSON.stringify({ active: true, current_phase: "interviewing" }),
				"--json",
			],
			cwd,
		);
		expect(write.status, write.stderr).toBe(0);
		const calleeState = JSON.parse(await fs.readFile(modeStatePath(cwd, sessionId, "deep-interview"), "utf8"));
		expect(calleeState.ultragoal_ask_handoff).toBeUndefined();

		const diagnostic = await isUltragoalAskBlocked(cwd, { sessionId });

		expect(diagnostic.active).toBe(true);
		expect(diagnostic.source).toBe("goals_json");
	});
	it("strips captured handoff authority from sanctioned merge and replace writes", async () => {
		for (const replace of [false, true]) {
			const cwd = await tempDir();
			const sessionId = `replayed-handoff-${replace ? "replace" : "merge"}`;

			process.env.GJC_SESSION_ID = sessionId;
			await createUltragoalPlan({ cwd, brief: "Implement the same-session story" });
			await handoffUltragoal(cwd, sessionId, "ralplan");
			const calleePath = modeStatePath(cwd, sessionId, "ralplan");
			const calleeState = JSON.parse(await fs.readFile(calleePath, "utf8"));
			const write = await runNativeStateCommand(
				[
					"write",
					"--mode",
					"ralplan",
					"--session-id",
					sessionId,
					"--input",
					JSON.stringify(calleeState),
					...(replace ? ["--replace"] : []),
					"--json",
				],
				cwd,
			);
			expect(write.status, write.stderr).toBe(0);
			const persisted = JSON.parse(await fs.readFile(calleePath, "utf8"));
			expect(persisted.ultragoal_ask_handoff).toBeUndefined();

			const diagnostic = await isUltragoalAskBlocked(cwd, { sessionId });
			expect(diagnostic.active).toBe(true);
		}
	});
	it("fails closed when handoff crashes after active-state commit but before ask proof", async () => {
		const cwd = await tempDir();
		const sessionId = "handoff-crash-before-proof";

		process.env.GJC_SESSION_ID = sessionId;
		await createUltragoalPlan({ cwd, brief: "Implement the same-session story" });
		process.env.GJC_STATE_HANDOFF_FAIL_BEFORE_ASK_COMMIT = "1";
		await handoffUltragoal(cwd, sessionId, "deep-interview", 1);
		delete process.env.GJC_STATE_HANDOFF_FAIL_BEFORE_ASK_COMMIT;
		const callerState = JSON.parse(await fs.readFile(modeStatePath(cwd, sessionId, "ultragoal"), "utf8"));
		const mutationId = callerState.ultragoal_ask_handoff.mutation_id;
		const journal = JSON.parse(await fs.readFile(transactionJournalPath(cwd, sessionId, mutationId), "utf8"));
		expect(journal).toMatchObject({
			status: "pending",
			steps: ["callee-mode-state", "caller-mode-state", "active-state"],
		});
		await expect(fs.access(ultragoalAskHandoffCommitPath(cwd, sessionId, mutationId))).rejects.toMatchObject({
			code: "ENOENT",
		});

		const diagnostic = await isUltragoalAskBlocked(cwd, { sessionId });
		expect(diagnostic.active).toBe(true);
		expect(diagnostic.source).toBe("goals_json");
	});
	it("fails closed while a crash leaves the durable ask proof journal pending", async () => {
		const cwd = await tempDir();
		const sessionId = "handoff-crash-after-proof";

		process.env.GJC_SESSION_ID = sessionId;
		await createUltragoalPlan({ cwd, brief: "Implement the same-session story" });
		process.env.GJC_STATE_HANDOFF_FAIL_AFTER_ASK_COMMIT = "1";
		await handoffUltragoal(cwd, sessionId, "ralplan", 1);
		delete process.env.GJC_STATE_HANDOFF_FAIL_AFTER_ASK_COMMIT;

		const callerState = JSON.parse(await fs.readFile(modeStatePath(cwd, sessionId, "ultragoal"), "utf8"));
		const mutationId = callerState.ultragoal_ask_handoff.mutation_id;
		const journal = JSON.parse(await fs.readFile(transactionJournalPath(cwd, sessionId, mutationId), "utf8"));
		expect(journal).toMatchObject({
			status: "pending",
			steps: ["callee-mode-state", "caller-mode-state", "active-state", "ask-commit"],
		});
		await fs.access(ultragoalAskHandoffCommitPath(cwd, sessionId, mutationId));

		const diagnostic = await isUltragoalAskBlocked(cwd, { sessionId });
		expect(diagnostic.active).toBe(true);
	});
	it("doctor cleans a verified committed-before-delete handoff journal", async () => {
		const cwd = await tempDir();
		const sessionId = "committed-handoff-journal-recovery";

		process.env.GJC_SESSION_ID = sessionId;
		await createUltragoalPlan({ cwd, brief: "Implement the same-session story" });
		await handoffUltragoal(cwd, sessionId, "deep-interview");
		const callerState = JSON.parse(await fs.readFile(modeStatePath(cwd, sessionId, "ultragoal"), "utf8"));
		const mutationId = callerState.ultragoal_ask_handoff.mutation_id;
		const journalPath = transactionJournalPath(cwd, sessionId, mutationId);
		await fs.mkdir(path.dirname(journalPath), { recursive: true });
		await fs.writeFile(
			journalPath,
			JSON.stringify({
				version: 1,
				mutation_id: mutationId,
				status: "committed",
				created_at: callerState.handoff_at,
				updated_at: callerState.handoff_at,
				caller: "ultragoal",
				callee: "deep-interview",
				paths: [
					modeStatePath(cwd, sessionId, "deep-interview"),
					modeStatePath(cwd, sessionId, "ultragoal"),
					activeSnapshotPath(cwd, sessionId),
					ultragoalAskHandoffCommitPath(cwd, sessionId, mutationId),
				],
				steps: ["callee-mode-state", "caller-mode-state", "active-state", "ask-commit"],
			}),
		);

		const doctor = await runNativeStateCommand(["doctor", "--session-id", sessionId, "--json"], cwd);

		expect(doctor.status, doctor.stdout).toBe(0);
		await expect(fs.access(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("retains and reports tampered committed handoff journals", async () => {
		for (const tamper of [
			"active-entry",
			"ledger-head",
			"checksum",
			"wrong-filename",
			"paths",
			"embedded-removed",
			"embedded-replaced",
			"receipt-extra",
			"receipt-future",
			"snapshot-missing",
			"snapshot-tampered",
			"extra-active-entry",
			"string-revisions",
		] as const) {
			const cwd = await tempDir();
			const sessionId = `committed-handoff-journal-${tamper}`;

			process.env.GJC_SESSION_ID = sessionId;
			await createUltragoalPlan({ cwd, brief: "Implement the same-session story" });
			await handoffUltragoal(cwd, sessionId, "deep-interview");
			const callerState = JSON.parse(await fs.readFile(modeStatePath(cwd, sessionId, "ultragoal"), "utf8"));
			const mutationId = callerState.ultragoal_ask_handoff.mutation_id;
			const callerPath = modeStatePath(cwd, sessionId, "ultragoal");
			const calleePath = modeStatePath(cwd, sessionId, "deep-interview");
			const commitPath = ultragoalAskHandoffCommitPath(cwd, sessionId, mutationId);
			const writeStamped = async (statePath: string, state: Record<string, unknown>, computedAt?: string) =>
				await fs.writeFile(statePath, JSON.stringify(stampWorkflowEnvelopeChecksum(state, statePath, computedAt)));
			const journalPath = transactionJournalPath(
				cwd,
				sessionId,
				tamper === "wrong-filename" ? `${mutationId}:wrong-file` : mutationId,
			);
			if (tamper === "active-entry") {
				const entryPath = activeEntryPath(cwd, sessionId, "deep-interview");
				const entry = JSON.parse(await fs.readFile(entryPath, "utf8"));
				entry.active = false;
				await fs.writeFile(entryPath, JSON.stringify(entry));
			}
			if (tamper === "ledger-head") {
				await fs.appendFile(
					getUltragoalPaths(cwd, sessionId).ledgerPath,
					`${JSON.stringify({ eventId: "tampered-ledger-head", event: "tampered", timestamp: new Date().toISOString() })}\n`,
				);
			}
			if (tamper === "checksum") {
				const statePath = modeStatePath(cwd, sessionId, "deep-interview");
				const state = JSON.parse(await fs.readFile(statePath, "utf8"));
				state.current_phase = "complete";
				await fs.writeFile(statePath, JSON.stringify(state));
			}
			if (tamper === "embedded-removed" || tamper === "embedded-replaced") {
				const state = JSON.parse(await fs.readFile(calleePath, "utf8"));
				if (tamper === "embedded-removed") delete state.ultragoal_ask_handoff;
				else state.ultragoal_ask_handoff = { ...state.ultragoal_ask_handoff, mutation_id: "replaced" };
				await writeStamped(calleePath, state);
			}
			if (tamper === "receipt-extra") {
				const authority = JSON.parse(await fs.readFile(commitPath, "utf8"));
				authority.caller_receipt.extra = "recovery must reject unknown receipt fields";
				await fs.writeFile(commitPath, JSON.stringify(authority));
				for (const statePath of [callerPath, calleePath]) {
					const state = JSON.parse(await fs.readFile(statePath, "utf8"));
					state.ultragoal_ask_handoff = authority;
					state.receipt.extra = "recovery must reject unknown receipt fields";
					await writeStamped(statePath, state);
				}
			}
			if (tamper === "receipt-future") {
				const state = JSON.parse(await fs.readFile(calleePath, "utf8"));
				await writeStamped(calleePath, state, new Date(Date.now() + 60_000).toISOString());
			}
			if (tamper === "snapshot-missing") {
				await fs.rm(activeSnapshotPath(cwd, sessionId));
			}
			if (tamper === "snapshot-tampered") {
				const snapshotPath = activeSnapshotPath(cwd, sessionId);
				const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
				snapshot.phase = "tampered";
				await fs.writeFile(snapshotPath, JSON.stringify(snapshot));
			}
			if (tamper === "extra-active-entry") {
				await fs.writeFile(
					activeEntryPath(cwd, sessionId, "custom-review"),
					JSON.stringify({ skill: "custom-review", session_id: sessionId, active: true, phase: "running" }),
				);
			}
			if (tamper === "string-revisions") {
				const authority = JSON.parse(await fs.readFile(commitPath, "utf8"));
				authority.caller_state_revision = String(authority.caller_state_revision);
				authority.callee_state_revision = String(authority.callee_state_revision);
				await fs.writeFile(commitPath, JSON.stringify(authority));
				for (const statePath of [callerPath, calleePath]) {
					const state = JSON.parse(await fs.readFile(statePath, "utf8"));
					state.state_revision = String(state.state_revision);
					state.ultragoal_ask_handoff = authority;
					await writeStamped(statePath, state);
				}
			}
			await fs.mkdir(path.dirname(journalPath), { recursive: true });
			await fs.writeFile(
				journalPath,
				JSON.stringify({
					version: 1,
					mutation_id: mutationId,
					status: "committed",
					created_at: callerState.handoff_at,
					updated_at: callerState.handoff_at,
					caller: "ultragoal",
					callee: "deep-interview",
					paths:
						tamper === "paths"
							? []
							: [
									modeStatePath(cwd, sessionId, "deep-interview"),
									modeStatePath(cwd, sessionId, "ultragoal"),
									activeSnapshotPath(cwd, sessionId),
									ultragoalAskHandoffCommitPath(cwd, sessionId, mutationId),
								],
					steps: ["callee-mode-state", "caller-mode-state", "active-state", "ask-commit"],
				}),
			);

			const doctor = await runNativeStateCommand(["doctor", "--session-id", sessionId, "--json"], cwd);

			expect(doctor.status, `${tamper}: ${doctor.stdout}`).toBe(1);
			await fs.access(journalPath);
		}
	});
	it("keeps durable handoff proof valid after transient receipt freshness expires", async () => {
		const cwd = await tempDir();
		const sessionId = "durable-handoff-receipt-expiry";

		process.env.GJC_SESSION_ID = sessionId;
		await createUltragoalPlan({ cwd, brief: "Implement the same-session story" });
		await handoffUltragoal(cwd, sessionId, "deep-interview");
		const now = Date.now();
		const spy = vi.spyOn(Date, "now").mockReturnValue(now + 31 * 60_000);
		try {
			const diagnostic = await isUltragoalAskBlocked(cwd, { sessionId });
			expect(diagnostic.active).toBe(false);
		} finally {
			spy.mockRestore();
		}
	});
	it("blocks a committed handoff when a custom workflow is also active", async () => {
		const cwd = await tempDir();
		const sessionId = "custom-overlapping-handoff";

		process.env.GJC_SESSION_ID = sessionId;
		await createUltragoalPlan({ cwd, brief: "Implement the same-session story" });
		await handoffUltragoal(cwd, sessionId, "deep-interview");
		await syncSkillActiveState({
			cwd,
			sessionId,
			skill: "custom-review",
			active: true,
			phase: "running",
		});

		const diagnostic = await isUltragoalAskBlocked(cwd, { sessionId });

		expect(diagnostic.active).toBe(true);
		expect(diagnostic.source).toBe("goals_json");
	});
	it("fails closed on a malformed custom entry after committed handoff", async () => {
		const cwd = await tempDir();
		const sessionId = "malformed-custom-handoff";

		process.env.GJC_SESSION_ID = sessionId;
		await createUltragoalPlan({ cwd, brief: "Implement the same-session story" });
		await handoffUltragoal(cwd, sessionId, "ralplan");
		await Bun.write(activeEntryPath(cwd, sessionId, "custom-review"), "{}\n");

		const diagnostic = await isUltragoalAskBlocked(cwd, { sessionId });

		expect(diagnostic.active).toBe(true);
		expect(diagnostic.source).toBe("durable_state_unreadable");
	});
	it("does not accept callee activation without committed handoff provenance", async () => {
		const cwd = await tempDir();
		const sessionId = "forged-deep-interview-handoff";

		process.env.GJC_SESSION_ID = sessionId;
		await createUltragoalPlan({ cwd, brief: "Implement the same-session story" });
		await writeActiveDeepInterviewState(cwd, sessionId);

		const diagnostic = await isUltragoalAskBlocked(cwd, { sessionId });

		expect(diagnostic.active).toBe(true);
		expect(diagnostic.source).toBe("goals_json");
	});
	it("does not treat active team state as a backward handoff", async () => {
		const cwd = await tempDir();
		const sessionId = "team-with-incomplete-ultragoal";

		process.env.GJC_SESSION_ID = sessionId;
		await createUltragoalPlan({ cwd, brief: "Implement the same-session story" });
		await syncSkillActiveState({
			cwd,
			sessionId,
			skill: "team",
			active: true,
			phase: "running",
		});

		const diagnostic = await isUltragoalAskBlocked(cwd, { sessionId });

		expect(diagnostic.active).toBe(true);
		expect(diagnostic.source).toBe("goals_json");
	});
	it("fails closed on structurally invalid canonical active entries", async () => {
		const cwd = await tempDir();
		const sessionId = "malformed-handoff-entry";

		process.env.GJC_SESSION_ID = sessionId;
		await createUltragoalPlan({ cwd, brief: "Implement the same-session story" });
		await Bun.write(
			activeEntryPath(cwd, sessionId, "deep-interview"),
			`${JSON.stringify({ skill: "deep-interview", session_id: sessionId })}\n`,
		);

		const diagnostic = await isUltragoalAskBlocked(cwd, { sessionId });

		expect(diagnostic.active).toBe(true);
		expect(diagnostic.source).toBe("durable_state_unreadable");
		expect(diagnostic.reason).toContain("boolean active field");
	});
	it("rejects a stale handoff entry from an earlier ultragoal run", async () => {
		const cwd = await tempDir();
		const sessionId = "stale-ultragoal-handoff";

		process.env.GJC_SESSION_ID = sessionId;
		const originalPlan = await createUltragoalPlan({ cwd, brief: "Implement the earlier story" });
		await handoffUltragoal(cwd, sessionId, "deep-interview");
		const replacementPlan = await createUltragoalPlan({ cwd, brief: "Implement the replacement story" });
		const paths = getUltragoalPaths(cwd, sessionId);
		const persistedReplacement = JSON.parse(await fs.readFile(paths.goalsPath, "utf8"));
		persistedReplacement.createdAt = originalPlan.createdAt;
		await fs.writeFile(paths.goalsPath, JSON.stringify(persistedReplacement, null, 2));
		expect(persistedReplacement.createdAt).toBe(originalPlan.createdAt);
		expect(replacementPlan.planRunId).not.toBe(originalPlan.planRunId);

		const diagnostic = await isUltragoalAskBlocked(cwd, { sessionId });

		expect(diagnostic.active).toBe(true);
		expect(diagnostic.source).toBe("goals_json");
	});
	it("keeps ask blocked when ultragoal remains active during an overlapping handoff", async () => {
		const cwd = await tempDir();
		const sessionId = "overlapping-ultragoal-handoff";

		process.env.GJC_SESSION_ID = sessionId;
		await createUltragoalPlan({ cwd, brief: "Implement the same-session story" });
		await writeActiveDeepInterviewState(cwd, sessionId);
		await syncSkillActiveState({
			cwd,
			sessionId,
			skill: "ultragoal",
			active: true,
			phase: "handoff",
		});

		const diagnostic = await isUltragoalAskBlocked(cwd, { sessionId });

		expect(diagnostic.active).toBe(true);
		expect(diagnostic.source).toBe("goals_json");
	});

	it("allows ask when the ultragoal run is verified complete", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		const paths = getUltragoalPaths(cwd);
		const now = new Date().toISOString();
		const plan = JSON.parse(await fs.readFile(paths.goalsPath, "utf8"));
		plan.goals[0].status = "complete";
		plan.goals[0].updatedAt = now;
		plan.goals[0].completedAt = now;
		const eventId = "event-final";
		const qualityGateJson = {};
		const generation = computeUltragoalPlanGeneration({
			plan,
			ledger: [],
			goal: plan.goals[0],
			receiptKind: "final-aggregate",
			beforeStatus: "active",
			excludeEventId: eventId,
		});
		plan.goals[0].completionVerification = {
			schemaVersion: 1,
			receiptId: "receipt-final",
			verifiedAt: now,
			goalId: plan.goals[0].id,
			receiptKind: "final-aggregate",
			goalStatusBeforeCheckpoint: "active",
			gjcGoalMode: plan.gjcGoalMode,
			gjcObjective: plan.gjcObjective,
			qualityGateHash: hashStructuredValue(qualityGateJson),
			planGeneration: generation.planGeneration,
			basis: generation.basis,
			checkpointLedgerEventId: eventId,
		};
		await fs.writeFile(paths.goalsPath, JSON.stringify(plan, null, 2));
		await fs.writeFile(
			paths.ledgerPath,
			`${JSON.stringify({ eventId, event: "goal_checkpointed", goalId: plan.goals[0].id, status: "complete", completionVerification: plan.goals[0].completionVerification, qualityGateJson })}\n`,
		);
		const diagnostic = await isUltragoalAskBlocked(cwd);
		expect(diagnostic.active, diagnostic.reason).toBe(false);
		expect(diagnostic.source).toBe("durable_state");
	});

	it("allows ask when no GJC session resolves even if a stale global ultragoal plan exists", async () => {
		const cwd = await tempDir();
		const previousSessionId = process.env.GJC_SESSION_ID;
		delete process.env.GJC_SESSION_ID;
		try {
			// Legacy/global .gjc/ultragoal with an incomplete plan, but no resolvable
			// session (no env, no _session-* activity marker). Must not block ask.
			const globalDir = path.join(cwd, ".gjc", "ultragoal");
			await fs.mkdir(globalDir, { recursive: true });
			await fs.writeFile(
				path.join(globalDir, "goals.json"),
				JSON.stringify({
					version: 1,
					brief: "Stale run",
					gjcGoalMode: "aggregate",
					goals: [{ id: "G001", title: "Leftover", objective: "Leftover", status: "pending" }],
				}),
			);

			const diagnostic = await isUltragoalAskBlocked(cwd);

			expect(diagnostic.active).toBe(false);
			expect(diagnostic.source).toBe("absent");
		} finally {
			if (previousSessionId === undefined) delete process.env.GJC_SESSION_ID;
			else process.env.GJC_SESSION_ID = previousSessionId;
		}
	});
});

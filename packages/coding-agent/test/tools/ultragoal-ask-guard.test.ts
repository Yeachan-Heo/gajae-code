import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolContext } from "@gajae-code/agent-core";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import * as deepInterviewRecorder from "@gajae-code/coding-agent/gjc-runtime/deep-interview-recorder";
import {
	activeSnapshotPath,
	auditPath,
	modeStatePath,
	sessionActivityPath,
} from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import { isUltragoalAskBlocked, isUltragoalPauseBlocked } from "@gajae-code/coding-agent/gjc-runtime/ultragoal-guard";
import {
	addUltragoalSubgoal,
	computeUltragoalPlanGeneration,
	createUltragoalPlan,
	getUltragoalPaths,
	hashStructuredValue,
	readUltragoalLedger,
	recordUltragoalBlockerClassification,
	recordUltragoalCriticVerdict,
	recordUltragoalHumanBlockedAskReserved,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { AskTool, isBuiltinAskTool } from "@gajae-code/coding-agent/tools/ask";
import { BUILTIN_TOOL_DESCRIPTORS, LazyAgentTool } from "@gajae-code/coding-agent/tools/descriptors";
import { wrapToolWithMetaNotice } from "@gajae-code/coding-agent/tools/output-meta";
import { listPendingAsks } from "@gajae-code/coding-agent/tools/pending-asks";
import { ToolError } from "@gajae-code/coding-agent/tools/tool-errors";
import {
	guardToolForUltragoalAsk,
	isHumanBlockedAskReceiptCurrent,
} from "@gajae-code/coding-agent/tools/ultragoal-ask-guard";

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
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
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
	const now = new Date().toISOString();
	const activeState = {
		version: 1,
		active: true,
		skill: "deep-interview",
		phase: "interviewing",
		updated_at: now,
		session_id: sessionId,
		active_skills: [
			{
				skill: "deep-interview",
				phase: "interviewing",
				active: true,
				updated_at: now,
				session_id: sessionId,
			},
		],
	};
	await Bun.write(activeSnapshotPath(cwd, sessionId), `${JSON.stringify(activeState, null, 2)}\n`);
	await Bun.write(
		modeStatePath(cwd, sessionId, "deep-interview"),
		`${JSON.stringify({ active: true, current_phase: "interviewing", session_id: sessionId }, null, 2)}\n`,
	);
}

function stubAskTool(execute: () => Promise<void>): AgentTool {
	const tool: AgentTool = {
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
	return tool;
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

class PrivateMetadataAskTool {
	#name = "ask";
	#description = "Ask the user a question";

	label = "Ask";
	summary = "Ask";
	parameters = {} as never;
	strict = true;

	get name(): string {
		return this.#name;
	}

	get description(): string {
		return this.#description;
	}

	async execute(): Promise<{ content: { type: "text"; text: string }[]; details: object }> {
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
		const guarded = guardToolForUltragoalAsk(
			stubAskTool(execute),
			() => cwd,
			() => ({ sessionId: TEST_SESSION_ID }),
		);

		await expect(guarded.execute("call", {}, undefined, undefined, undefined as never)).rejects.toThrow(ToolError);
		await expect(guarded.execute("call", {}, undefined, undefined, undefined as never)).rejects.toThrow(
			/try-harder nudge/,
		);
		expect(execute).not.toHaveBeenCalled();
	});

	it("isolates wrapped Ask from another session's durable run and stale environment", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement session A's story" });
		// A foreign session's active-skill snapshot on disk is still not this Ask's scope.
		await writeActiveDeepInterviewState(cwd, TEST_SESSION_ID);
		const ledgerFile = Bun.file(getUltragoalPaths(cwd, TEST_SESSION_ID).ledgerPath);
		const ledgerBefore = await ledgerFile.text();
		const execute = vi.fn(async () => {});
		const guarded = guardToolForUltragoalAsk(
			stubAskTool(execute),
			() => cwd,
			() => ({ sessionId: " ordinary-ask-session-b " }),
		);
		const result = await guarded.execute("call", {}, undefined, undefined, undefined as never);
		expect(result.content).toEqual([{ type: "text", text: "asked" }]);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(await ledgerFile.text()).toBe(ledgerBefore);
	});

	it("permits an anonymous Ask instead of GJC_SESSION_ID's durable run", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement session A's story" });
		const ledgerFile = Bun.file(getUltragoalPaths(cwd, TEST_SESSION_ID).ledgerPath);
		const ledgerBefore = await ledgerFile.text();
		for (const sessionId of [undefined, "", "   "]) {
			const execute = vi.fn(async () => {});
			const guarded = guardToolForUltragoalAsk(
				stubAskTool(execute),
				() => cwd,
				() => ({ sessionId }),
			);
			const result = await guarded.execute("call", {}, undefined, undefined, undefined as never);
			expect(result.content).toEqual([{ type: "text", text: "asked" }]);
			expect(execute).toHaveBeenCalledTimes(1);
		}
		expect(await ledgerFile.text()).toBe(ledgerBefore);
	});

	it("permits an anonymous Ask instead of an auto-detected session's durable run", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement session A's story" });
		await writeActivityMarker(cwd, TEST_SESSION_ID, new Date().toISOString());
		delete process.env.GJC_SESSION_ID;
		const execute = vi.fn(async () => {});
		const guarded = guardToolForUltragoalAsk(
			stubAskTool(execute),
			() => cwd,
			() => ({}),
		);
		const result = await guarded.execute("call", {}, undefined, undefined, undefined as never);
		expect(result.content).toEqual([{ type: "text", text: "asked" }]);
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("allows ordinary unwrapped Ask in session B without changing session A's ledger", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement session A's story" });
		const ledgerFile = Bun.file(getUltragoalPaths(cwd, TEST_SESSION_ID).ledgerPath);
		const ledgerBefore = await ledgerFile.text();
		const select = vi.fn(async () => "Continue");
		const tool = new AskTool(createSession(cwd, { getSessionId: () => "ordinary-ask-session-b" }));
		await tool.execute(
			"call",
			{ questions: [{ id: "q", question: "Continue intake?", options: [{ label: "Continue" }] }] },
			undefined,
			undefined,
			createContext(select),
		);
		expect(select).toHaveBeenCalledTimes(1);
		expect(await ledgerFile.text()).toBe(ledgerBefore);
	});

	it("binds the wrapped ask to the caller even when a different session owns the ambient run", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the existing session's story" });
		await writeActivityMarker(cwd, TEST_SESSION_ID, new Date().toISOString());
		const ownerSessionId = " caller-owns-the-run ";
		process.env.GJC_SESSION_ID = "unrelated-environment-session";
		const execute = vi.fn(async () => {});
		const guarded = guardToolForUltragoalAsk(
			stubAskTool(execute),
			() => cwd,
			() => ({ sessionId: ownerSessionId }),
		);
		const result = await guarded.execute("call", {}, undefined, undefined, undefined as never);
		expect(result.content).toEqual([{ type: "text", text: "asked" }]);
		expect(execute).toHaveBeenCalledTimes(1);
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

	it("keeps guarding a tool that carries the guard marker of earlier versions", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		const execute = vi.fn(async () => {});
		const claimsToBeGuarded = Object.assign(stubAskTool(execute), {
			[Symbol.for("gajae-code.ultragoalAskGuard")]: true,
		});
		const guarded = guardToolForUltragoalAsk(
			claimsToBeGuarded,
			() => cwd,
			() => ({ sessionId: TEST_SESSION_ID }),
		);

		await expect(guarded.execute("call", {}, undefined, undefined, undefined as never)).rejects.toThrow(ToolError);
		expect(execute).not.toHaveBeenCalled();
	});

	it("guards a tool again when the same tool is wrapped a second time", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		const execute = vi.fn(async () => {});
		const tool = stubAskTool(execute);
		const context = () => ({ sessionId: TEST_SESSION_ID });
		// The session builder and the session each wrap the registry entry.
		guardToolForUltragoalAsk(tool, () => cwd, context);
		const second = guardToolForUltragoalAsk(tool, () => cwd, context);

		expect(second).not.toBe(tool);
		await expect(second.execute("call", {}, undefined, undefined, undefined as never)).rejects.toThrow(ToolError);
		expect(execute).not.toHaveBeenCalled();
	});

	it("preserves private-field metadata getters and avoids double-guarding", () => {
		const tool = new PrivateMetadataAskTool();
		const guarded = guardToolForUltragoalAsk(tool as unknown as AgentTool, () => process.cwd());

		expect(guarded.name).toBe("ask");
		expect(guarded.description).toBe("Ask the user a question");
		const guardedAgain = guardToolForUltragoalAsk(guarded, () => process.cwd());
		expect(guardedAgain).toBe(guarded);
	});

	it("blocks an unwrapped AskTool before prompting while ultragoal is active", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		const select = vi.fn(async () => "Yes");
		const tool = new AskTool(createSession(cwd, { getSessionId: () => TEST_SESSION_ID }));

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

	it("blocks active deep-interview ask when the same session has active ultragoal state", async () => {
		const cwd = await tempDir();
		const sessionId = "deep-interview-with-ultragoal-state";

		process.env.GJC_SESSION_ID = sessionId;
		await createUltragoalPlan({ cwd, brief: "Implement the same-session story" });
		delete process.env.GJC_SESSION_ID;
		await writeActiveDeepInterviewState(cwd, sessionId);

		const select = vi.fn(async () => "Continue");
		const tool = new AskTool(
			createSession(cwd, {
				getSessionId: () => sessionId,
				getActiveSkillState: () => ({ skill: "deep-interview", session_id: sessionId }),
			}),
		);

		await expect(
			tool.execute(
				"call",
				{ questions: [{ id: "q", question: "Continue interview?", options: [{ label: "Continue" }] }] },
				undefined,
				undefined,
				createContext(select),
			),
		).rejects.toThrow(/try-harder nudge/);
		expect(select).not.toHaveBeenCalled();
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
		const qualityGateJson = {
			criticReview: {
				verdict: "OKAY",
				evidence: "critic approved the final aggregate completion",
				blockers: [],
			},
		};
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
		expect(diagnostic.active).toBe(false);
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

describe("ultragoal ask guard with a verified human-only blocker", () => {
	const OTHER_SESSION_ID = "ultragoal-ask-guard-other-session";

	function guardedAsk(cwd: string, sessionId: string) {
		const execute = vi.fn(async () => {});
		const guarded = guardToolForUltragoalAsk(
			stubAskTool(execute),
			() => cwd,
			() => ({ sessionId }),
		);
		const params = { questions: [{ id: "q", question: "Which credentials?", options: [{ label: "Vault" }] }] };
		return { execute, ask: () => guarded.execute("call", params, undefined, undefined, undefined as never) };
	}

	async function recordVerifiedHumanBlock(cwd: string, verdict: "OKAY" | "REJECT" = "OKAY"): Promise<void> {
		const classification = await recordUltragoalBlockerClassification({
			cwd,
			classification: "human_blocked",
			evidence: "User must provide production API credentials",
		});
		await recordUltragoalCriticVerdict({
			cwd,
			terminus: "pause",
			verdict,
			evidence: "critic reviewed the human-only blocker",
			...(verdict === "OKAY" ? {} : { blockers: ["Credentials exist in the local vault"] }),
			classificationEventId: classification.eventId,
		});
	}

	it("[DISABLED] human-blocked ask admission is disabled until independent provenance can be verified", async () => {
		// Human-blocked admission is currently disabled because the receipt can be forged by the
		// active agent process itself. The feature requires independent provenance verification
		// (e.g., signed attestation or verified timestamp from an external reviewer/process).
		// See: packages/coding-agent/src/tools/ultragoal-ask-guard.ts:118
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		const { ask } = guardedAsk(cwd, TEST_SESSION_ID);

		await expect(ask()).rejects.toThrow(
			/human-blocked ask admission is disabled until independent provenance can be verified/,
		);
	});

	it.skip("admits ask without consuming a nudge once the pause receipt is clean", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		// Use the real AskTool instead of a stub, since only built-in instances can handle human-blocked asks.
		const tool = askTool(cwd);
		const select = vi.fn(async () => "Vault");

		const result = await tool.execute("call-1", QUESTION, undefined, undefined, createContext(select));

		expect(result.content).toBeDefined();
		expect(select).toHaveBeenCalledTimes(1);
		expect(await answeredAskRows(cwd)).toBe(1);
		// The admission is spent after one answer.
		expect((await isUltragoalPauseBlocked(cwd, { sessionId: TEST_SESSION_ID })).askSpent).toBe(true);
	});

	it("keeps blocking ask when the human_blocked classification has no critic verdict", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordUltragoalBlockerClassification({
			cwd,
			classification: "human_blocked",
			evidence: "User must provide production API credentials",
		});
		const { execute, ask } = guardedAsk(cwd, TEST_SESSION_ID);

		await expect(ask()).rejects.toThrow(ToolError);
		expect(execute).not.toHaveBeenCalled();
	});

	it("keeps blocking ask when the terminal critic rejected the classification", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd, "REJECT");
		const { execute, ask } = guardedAsk(cwd, TEST_SESSION_ID);

		await expect(ask()).rejects.toThrow(ToolError);
		expect(execute).not.toHaveBeenCalled();
	});

	it("blocks ask again once a newer resolvable classification supersedes the receipt", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		await recordUltragoalBlockerClassification({
			cwd,
			classification: "resolvable",
			evidence: "Credentials turned out to be in the local vault",
		});
		const { execute, ask } = guardedAsk(cwd, TEST_SESSION_ID);

		await expect(ask()).rejects.toThrow(ToolError);
		expect(execute).not.toHaveBeenCalled();
	});

	it("never admits ask from another session's pause receipt", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = OTHER_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the asking session's story" });
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the receipt owner's story" });
		await recordVerifiedHumanBlock(cwd);
		// The ambient session still names the receipt owner while another session asks.
		const { execute, ask } = guardedAsk(cwd, OTHER_SESSION_ID);

		await expect(ask()).rejects.toThrow(ToolError);
		expect(execute).not.toHaveBeenCalled();
	});

	it("fails closed when the plan is missing even though a clean receipt was recorded", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		await fs.rm(getUltragoalPaths(cwd, TEST_SESSION_ID).goalsPath);
		const { execute, ask } = guardedAsk(cwd, TEST_SESSION_ID);

		await expect(ask()).rejects.toThrow(/source: durable_state_unreadable/);
		expect(execute).not.toHaveBeenCalled();
	});

	const QUESTION = { questions: [{ id: "q", question: "Which credentials?", options: [{ label: "Vault" }] }] };

	function askTool(cwd: string, overrides: Partial<ToolSession> = {}): AskTool {
		const tool = AskTool.createIf(createSession(cwd, { getSessionId: () => TEST_SESSION_ID, ...overrides }));
		if (!tool) throw new Error("AskTool.createIf returned null");
		return tool;
	}

	async function answeredAskRows(cwd: string): Promise<number> {
		const ledger = await readUltragoalLedger(cwd, TEST_SESSION_ID);
		return ledger.filter(event => event.event === "human_blocked_ask_answered").length;
	}

	it.skip("spends the receipt on the first answered ask and refuses the next one", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		const select = vi.fn(async () => "Vault");
		const tool = askTool(cwd);

		await tool.execute("call-1", QUESTION, undefined, undefined, createContext(select));
		await expect(tool.execute("call-2", QUESTION, undefined, undefined, createContext(select))).rejects.toThrow(
			ToolError,
		);

		expect(select).toHaveBeenCalledTimes(1);
		expect(await answeredAskRows(cwd)).toBe(1);
		// Only the ask admission is spent: the run may still park on the same receipt.
		expect((await isUltragoalPauseBlocked(cwd, { sessionId: TEST_SESSION_ID })).blocked).toBe(false);
	});

	it.skip("leaves the receipt unspent when the user cancels the ask", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		const tool = askTool(cwd);

		await expect(
			tool.execute(
				"call-1",
				QUESTION,
				undefined,
				undefined,
				createContext(async () => undefined),
			),
		).rejects.toThrow(/cancelled/);
		expect(await answeredAskRows(cwd)).toBe(0);

		const select = vi.fn(async () => "Vault");
		await tool.execute("call-2", QUESTION, undefined, undefined, createContext(select));
		expect(select).toHaveBeenCalledTimes(1);
		expect(await answeredAskRows(cwd)).toBe(1);
	});

	it.skip("admits one more ask after a newly verified human-only blocker", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		const select = vi.fn(async () => "Vault");
		const tool = askTool(cwd);
		await tool.execute("call-1", QUESTION, undefined, undefined, createContext(select));

		await recordVerifiedHumanBlock(cwd);
		await tool.execute("call-2", QUESTION, undefined, undefined, createContext(select));
		await expect(tool.execute("call-3", QUESTION, undefined, undefined, createContext(select))).rejects.toThrow(
			ToolError,
		);

		expect(select).toHaveBeenCalledTimes(2);
		expect(await answeredAskRows(cwd)).toBe(2);
	});

	it.skip("does not reopen ask when only the pause verdict is recorded again", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		const classification = await recordUltragoalBlockerClassification({
			cwd,
			classification: "human_blocked",
			evidence: "User must provide production API credentials",
		});
		const recordVerdict = () =>
			recordUltragoalCriticVerdict({
				cwd,
				terminus: "pause",
				verdict: "OKAY",
				evidence: "critic reviewed the human-only blocker",
				classificationEventId: classification.eventId,
			});
		await recordVerdict();
		const select = vi.fn(async () => "Vault");
		const tool = askTool(cwd);
		await tool.execute("call-1", QUESTION, undefined, undefined, createContext(select));

		await recordVerdict();
		await expect(tool.execute("call-2", QUESTION, undefined, undefined, createContext(select))).rejects.toThrow(
			ToolError,
		);
		expect(select).toHaveBeenCalledTimes(1);
	});

	it.skip("admits only one of two asks issued in parallel", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		const select = vi.fn(async () => "Vault");
		const tool = askTool(cwd);

		const settled = await Promise.allSettled([
			tool.execute("call-1", QUESTION, undefined, undefined, createContext(select)),
			tool.execute("call-2", QUESTION, undefined, undefined, createContext(select)),
		]);

		expect(settled.map(outcome => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
		expect(select).toHaveBeenCalledTimes(1);
		expect(await answeredAskRows(cwd)).toBe(1);
	});

	it("refuses an ask that carries more than one question without spending anything", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		const ledgerFile = Bun.file(getUltragoalPaths(cwd, TEST_SESSION_ID).ledgerPath);
		const ledgerBefore = await ledgerFile.text();
		const select = vi.fn(async () => "Vault");
		const two = { questions: [QUESTION.questions[0], { ...QUESTION.questions[0], id: "q2" }] };

		await expect(askTool(cwd).execute("call-1", two, undefined, undefined, createContext(select))).rejects.toThrow(
			/exactly one question/,
		);

		expect(select).not.toHaveBeenCalled();
		expect(await ledgerFile.text()).toBe(ledgerBefore);
	});

	it.skip("keeps the admission closed when the answer cannot be recorded", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		const ledgerPath = getUltragoalPaths(cwd, TEST_SESSION_ID).ledgerPath;
		const ledgerBefore = await Bun.file(ledgerPath).text();
		// Break the ledger while the question is open, then restore it untouched.
		const select = vi.fn(async () => {
			await fs.rm(ledgerPath);
			await fs.mkdir(ledgerPath);
			return "Vault";
		});
		const tool = askTool(cwd);

		const answered = await tool.execute("call-1", QUESTION, undefined, undefined, createContext(select));
		expect(answered.content).toBeDefined();
		await fs.rm(ledgerPath, { recursive: true });
		await fs.writeFile(ledgerPath, ledgerBefore);
		expect(await answeredAskRows(cwd)).toBe(0);

		await expect(tool.execute("call-2", QUESTION, undefined, undefined, createContext(select))).rejects.toThrow(
			/already answered/,
		);
		expect(select).toHaveBeenCalledTimes(1);
	});

	it.skip("keeps the admission spent on disk when the answer cannot be recorded", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		const ledgerPath = getUltragoalPaths(cwd, TEST_SESSION_ID).ledgerPath;
		let ledgerWhileOpen = "";
		// Snapshot the ledger as it stands while the question is open, then break it
		// so the answer row cannot be written.
		const select = vi.fn(async () => {
			ledgerWhileOpen = await Bun.file(ledgerPath).text();
			await fs.rm(ledgerPath);
			await fs.mkdir(ledgerPath);
			return "Vault";
		});

		await askTool(cwd).execute("call-1", QUESTION, undefined, undefined, createContext(select));
		await fs.rm(ledgerPath, { recursive: true });
		await Bun.write(ledgerPath, ledgerWhileOpen);

		// What a restarted process sees: no answer row, but the admission is spent.
		expect(await answeredAskRows(cwd)).toBe(0);
		const pause = await isUltragoalPauseBlocked(cwd, { sessionId: TEST_SESSION_ID });
		expect(pause.askSpent).toBe(true);
	});

	it.skip("refuses to open the question when the reservation cannot be recorded", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		const ledgerPath = getUltragoalPaths(cwd, TEST_SESSION_ID).ledgerPath;
		const select = vi.fn(async () => "Vault");
		const tool = askTool(cwd);
		// The guard reads the ledger first; break only the write that follows it.
		const ledgerText = await Bun.file(ledgerPath).text();
		const chmod = await fs.stat(ledgerPath);
		await fs.chmod(ledgerPath, 0o444);
		try {
			await expect(tool.execute("call-1", QUESTION, undefined, undefined, createContext(select))).rejects.toThrow(
				/could not be reserved/,
			);
		} finally {
			await fs.chmod(ledgerPath, chmod.mode);
		}
		expect(select).not.toHaveBeenCalled();
		expect(await Bun.file(ledgerPath).text()).toBe(ledgerText);

		await tool.execute("call-2", QUESTION, undefined, undefined, createContext(select));
		expect(select).toHaveBeenCalledTimes(1);
	});

	async function currentReceipt(cwd: string): Promise<{ sessionId: string; classificationEventId: string }> {
		const pause = await isUltragoalPauseBlocked(cwd, { sessionId: TEST_SESSION_ID });
		return { sessionId: TEST_SESSION_ID, classificationEventId: pause.classificationEventId! };
	}

	it.skip("holds plan writes behind the reservation recheck", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		const receipt = await currentReceipt(cwd);
		let planWritten = false;
		let planWrittenDuringRecheck: boolean | undefined;
		let steer: Promise<unknown> | undefined;

		const reserved = await recordUltragoalHumanBlockedAskReserved({ cwd, ...receipt }, async () => {
			steer = addUltragoalSubgoal({
				cwd,
				title: "New required goal",
				objective: "Covers a requirement found late",
				evidence: "review found a missing requirement",
				rationale: "scope grew",
			}).then(() => {
				planWritten = true;
			});
			await Bun.sleep(300);
			planWrittenDuringRecheck = planWritten;
			return isHumanBlockedAskReceiptCurrent(cwd, receipt);
		});
		await steer;

		expect(planWrittenDuringRecheck).toBe(false);
		expect(reserved).toBe(true);
		expect(planWritten).toBe(true);
	});

	it.skip("refuses a human-blocked ask without an interactive UI", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		const headless = { hasUI: false, abort: () => {} } as unknown as AgentToolContext;

		await expect(askTool(cwd).execute("call-1", QUESTION, undefined, undefined, headless)).rejects.toThrow(
			/only in an interactive session/,
		);
		expect(await answeredAskRows(cwd)).toBe(0);
		const ledger = await readUltragoalLedger(cwd, TEST_SESSION_ID);
		expect(ledger.some(event => event.event === "human_blocked_ask_reserved")).toBe(false);
	});

	it.skip("refuses to reserve a receipt superseded by a newer classification after the guard ran", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		const stale = await currentReceipt(cwd);
		await recordUltragoalBlockerClassification({
			cwd,
			classification: "resolvable",
			evidence: "Credentials were found in the local vault",
		});

		const reserved = await recordUltragoalHumanBlockedAskReserved({ cwd, ...stale }, () =>
			isHumanBlockedAskReceiptCurrent(cwd, stale),
		);

		expect(reserved).toBe(false);
		const ledger = await readUltragoalLedger(cwd, TEST_SESSION_ID);
		expect(ledger.some(event => event.event === "human_blocked_ask_reserved")).toBe(false);
	});

	it.skip("reserves a receipt that still names the current verified blocker", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		const receipt = await currentReceipt(cwd);

		const reserve = () =>
			recordUltragoalHumanBlockedAskReserved({ cwd, ...receipt }, () =>
				isHumanBlockedAskReceiptCurrent(cwd, receipt),
			);

		expect(await reserve()).toBe(true);
		expect(await reserve()).toBe(false);
	});

	it.skip("keeps the admission open when the ask timeout auto-selects an answer", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		const tool = new AskTool(
			createSession(cwd, {
				getSessionId: () => TEST_SESSION_ID,
				settings: Settings.isolated({ "ask.timeout": 0.001 }),
			}),
		);
		const timedOutContext = {
			hasUI: true,
			ui: {
				select: async (
					_prompt: string,
					options: string[],
					dialogOptions?: { initialIndex?: number; onTimeout?: () => void },
				) => {
					dialogOptions?.onTimeout?.();
					return options[dialogOptions?.initialIndex ?? 0];
				},
				editor: async () => undefined,
			},
			abort: () => {},
		} as unknown as AgentToolContext;

		const timedOut = await tool.execute("call-1", QUESTION, undefined, undefined, timedOutContext);
		expect(timedOut.details?.timedOut).toBe(true);
		expect(await answeredAskRows(cwd)).toBe(0);

		const select = vi.fn(async () => "Vault");
		await askTool(cwd).execute("call-2", QUESTION, undefined, undefined, createContext(select));
		expect(select).toHaveBeenCalledTimes(1);
		expect(await answeredAskRows(cwd)).toBe(1);
	});

	it.skip("keeps the admission open when the user asks about the choices instead of answering", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		// Only a round-shaped question offers the "Ask about these choices" entry.
		const roundQuestion = {
			questions: [
				{
					id: "q",
					question: "Round 1 | Component: credentials | Ambiguity: 40%\n\nWhich credentials?",
					options: [{ label: "Vault" }],
				},
			],
		};
		const clarifyingContext = {
			hasUI: true,
			ui: {
				select: async (
					_prompt: string,
					_options: string[],
					dialogOptions?: { clarificationInput?: { optionLabel: string; onSubmit: (text: string) => void } },
				) => {
					dialogOptions?.clarificationInput?.onSubmit("Which vault?");
					return dialogOptions?.clarificationInput?.optionLabel;
				},
				editor: async () => undefined,
			},
			abort: () => {},
		} as unknown as AgentToolContext;

		const clarified = await askTool(cwd).execute("call-1", roundQuestion, undefined, undefined, clarifyingContext);
		expect(clarified.details?.clarificationQuestion).toBe("Which vault?");
		expect(await answeredAskRows(cwd)).toBe(0);

		const select = vi.fn(async () => "Vault");
		await askTool(cwd).execute("call-2", QUESTION, undefined, undefined, createContext(select));
		expect(select).toHaveBeenCalledTimes(1);
		expect(await answeredAskRows(cwd)).toBe(1);
	});

	it.skip("spends the receipt through the session tool wrapper as well", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		const select = vi.fn(async () => "Vault");
		const guarded = guardToolForUltragoalAsk(
			askTool(cwd) as unknown as AgentTool,
			() => cwd,
			() => ({ sessionId: TEST_SESSION_ID }),
		);

		await guarded.execute("call-1", QUESTION, undefined, undefined, createContext(select));
		await expect(guarded.execute("call-2", QUESTION, undefined, undefined, createContext(select))).rejects.toThrow(
			ToolError,
		);

		expect(select).toHaveBeenCalledTimes(1);
		expect(await answeredAskRows(cwd)).toBe(1);
	});

	// Issue 1: Receipt freshness atomicity with reservation
	// The reservation must check and commit atomically with the plan generation.
	// Without the fix, a concurrent plan modification could make the receipt stale
	// between the check and the reservation append.
	it.skip("[Issue 1] records successful reservation when receipt is current", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);

		const receipt = await currentReceipt(cwd);

		// When stillAdmissible is called, it checks if receipt is still current
		const stillAdmissible = () => isHumanBlockedAskReceiptCurrent(cwd, receipt);

		// First reservation should succeed
		const reserved1 = await recordUltragoalHumanBlockedAskReserved({ cwd, ...receipt }, stillAdmissible);
		expect(reserved1).toBe(true);

		// Second reservation should fail (already spent)
		const reserved2 = await recordUltragoalHumanBlockedAskReserved({ cwd, ...receipt }, stillAdmissible);
		expect(reserved2).toBe(false);
	});

	// Issue 2: Enforce one-question settlement for custom ask tools
	// Only the built-in AskTool should be admitted for human-blocked asks.
	// Custom tools named "ask" should be rejected.
	it.skip("refuses admission for custom ask tools to prevent bypass of settlement accounting", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);

		const customAskTool = {
			name: "ask",
			label: "Ask",
			summary: "Ask",
			description: "Ask",
			parameters: {} as never,
			strict: true,
			execute: async () => {
				return {
					content: [{ type: "text" as const, text: "custom ask" }],
					details: {},
				};
			},
		} as unknown as AgentTool;

		const guarded = guardToolForUltragoalAsk(
			customAskTool,
			() => cwd,
			() => ({ sessionId: TEST_SESSION_ID }),
		);

		const select = vi.fn(async () => "Vault");
		await expect(guarded.execute("call-1", QUESTION, undefined, undefined, createContext(select))).rejects.toThrow(
			/custom ask tools are not permitted/,
		);
	});

	// Regression test for P2 finding #1: timeout result not 'User selected' and admission retryable
	it.skip("[P2 #1] does not record timeout auto-selection as a human answer", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);

		const tool = new AskTool(
			createSession(cwd, {
				getSessionId: () => TEST_SESSION_ID,
				settings: Settings.isolated({ "ask.timeout": 0.001 }),
			}),
		);

		// First call: timeout auto-selects the recommended option
		const timedOutContext = {
			hasUI: true,
			ui: {
				select: async (
					_prompt: string,
					options: string[],
					dialogOptions?: { initialIndex?: number; onTimeout?: () => void },
				) => {
					dialogOptions?.onTimeout?.();
					return options[dialogOptions?.initialIndex ?? 0];
				},
				editor: async () => undefined,
			},
			abort: () => {},
		} as unknown as AgentToolContext;

		const timedOut = await tool.execute("call-1", QUESTION, undefined, undefined, timedOutContext);
		expect(timedOut.details?.timedOut).toBe(true);
		// Timeout did not record an answer
		expect(await answeredAskRows(cwd)).toBe(0);

		// Second call: human selects an answer
		const select = vi.fn(async () => "Vault");
		const answered = await tool.execute("call-2", QUESTION, undefined, undefined, createContext(select));
		expect(answered.content).toBeDefined();
		// Now the answer is recorded
		expect(await answeredAskRows(cwd)).toBe(1);
	});

	// Regression test for P2 finding #2: marker-write failure keeps the reservation committed
	it.skip("[P2 #2] keeps reservation durable when activity marker write fails", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);

		const receipt = await currentReceipt(cwd);
		const originalWrite = Bun.write;

		// Spy on Bun.write and fail only the activity marker write
		vi.spyOn(Bun, "write").mockImplementation(async (dest: unknown, data: unknown) => {
			const destStr = typeof dest === "string" ? dest : "unknown";
			// Fail the activity marker write, but let the ledger write succeed
			if (destStr.includes("activity")) {
				throw new Error("Simulated activity marker write failure");
			}
			return originalWrite(dest as Parameters<typeof Bun.write>[0], data as Parameters<typeof Bun.write>[1]);
		});

		try {
			// Despite the marker write failure, the reservation should still succeed
			const reserved = await recordUltragoalHumanBlockedAskReserved({ cwd, ...receipt }, () =>
				isHumanBlockedAskReceiptCurrent(cwd, receipt),
			);

			// The reservation should be recorded despite marker failure
			expect(reserved).toBe(true);

			// Second reservation should fail (already spent)
			const reserved2 = await recordUltragoalHumanBlockedAskReserved({ cwd, ...receipt }, () =>
				isHumanBlockedAskReceiptCurrent(cwd, receipt),
			);
			expect(reserved2).toBe(false);
		} finally {
			vi.restoreAllMocks();
		}
	});

	// Regression test for P2 finding #3: SDK/remote answer cannot settle a human-blocked ask
	it.skip("[P2 #3] does not allow SDK/remote settlement of human-blocked asks", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);

		const receipt = await currentReceipt(cwd);

		// Try to record a reservation and then answer through the runtime,
		// bypassing the tool's execute method
		const reserved = await recordUltragoalHumanBlockedAskReserved({ cwd, ...receipt }, () =>
			isHumanBlockedAskReceiptCurrent(cwd, receipt),
		);
		expect(reserved).toBe(true);

		// A second tool call should still fail because only the tool's execute
		// method with proper UI context can settle the ask
		const select = vi.fn(async () => "Vault");
		const tool = askTool(cwd);

		await expect(tool.execute("call-2", QUESTION, undefined, undefined, createContext(select))).rejects.toThrow(
			ToolError,
		);
	});

	// Regression test for P2 finding #4: custom tool with old Symbol.for marker is not built-in
	it.skip("[P2 #4] rejects custom tool even when it sets the old Symbol.for marker", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);

		// A custom tool tries to spoof by setting the old Symbol.for marker
		// This would bypass the old Symbol-based check, but not the WeakSet-based check
		const BUILTIN_ASK_TOOL = Symbol.for("gajae-code.builtinAskTool");
		const customAskToolWithForgedMarker = {
			name: "ask",
			label: "Ask",
			summary: "Ask",
			description: "Ask",
			parameters: {} as never,
			strict: true,
			// Try to set the old forgeable marker
			[BUILTIN_ASK_TOOL]: true as any,
			execute: async () => {
				return {
					content: [{ type: "text" as const, text: "forged ask" }],
					details: {},
				};
			},
		} as unknown as AgentTool;

		// Verify that even with the old marker set, the tool is NOT recognized as built-in
		// (because the WeakSet check requires being marked during AskTool construction)
		expect(isBuiltinAskTool(customAskToolWithForgedMarker)).toBe(false);

		// When wrapped, the guard should reject it for human-blocked asks
		const guarded = guardToolForUltragoalAsk(
			customAskToolWithForgedMarker,
			() => cwd,
			() => ({ sessionId: TEST_SESSION_ID }),
		);

		const select = vi.fn(async () => "Vault");
		await expect(guarded.execute("call-1", QUESTION, undefined, undefined, createContext(select))).rejects.toThrow(
			/custom ask tools are not permitted/,
		);
	});

	function guardedFor(cwd: string, tool: unknown): AgentTool {
		return guardToolForUltragoalAsk(
			tool as AgentTool,
			() => cwd,
			() => ({ sessionId: TEST_SESSION_ID }),
		);
	}

	/** A dialog that reports the `ask.timeout` expiry and returns the auto-selected option. */
	function timedOutContext(): AgentToolContext {
		return {
			hasUI: true,
			ui: {
				select: async (
					_prompt: string,
					options: string[],
					dialogOptions?: { initialIndex?: number; onTimeout?: () => void },
				) => {
					dialogOptions?.onTimeout?.();
					return options[dialogOptions?.initialIndex ?? 0];
				},
				editor: async () => undefined,
			},
			abort: () => {},
		} as unknown as AgentToolContext;
	}

	it.skip("admits the built-in ask behind the registry's lazy facade", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		const session = createSession(cwd, { getSessionId: () => TEST_SESSION_ID });
		const descriptor = BUILTIN_TOOL_DESCRIPTORS.ask;
		// Deferred and notice-wrapped, as discovery mode registers it: nothing is loaded before the call.
		const facade = wrapToolWithMetaNotice(
			new LazyAgentTool(descriptor, undefined, () => descriptor.load(session), session),
		);
		const guarded = guardedFor(cwd, facade);
		const select = vi.fn(async () => "Vault");

		const result = await guarded.execute("call-1", QUESTION, undefined, undefined, createContext(select));

		expect(result.content).toEqual([{ type: "text", text: "User selected: Vault" }]);
		expect(select).toHaveBeenCalledTimes(1);
		expect(await answeredAskRows(cwd)).toBe(1);
	});

	it.skip("refuses a lazy facade whose implementation is not the built-in ask", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		const execute = vi.fn(async () => {});
		const facade = new LazyAgentTool(BUILTIN_TOOL_DESCRIPTORS.ask, undefined, () => stubAskTool(execute));

		await expect(
			guardedFor(cwd, facade).execute(
				"call-1",
				QUESTION,
				undefined,
				undefined,
				createContext(async () => "Vault"),
			),
		).rejects.toThrow(/custom ask tools are not permitted/);
		expect(execute).not.toHaveBeenCalled();
	});

	it.skip("refuses a tool that names a built-in ask as its implementation", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		const execute = vi.fn(async () => {});
		const builtin = askTool(cwd);
		const lookAlike = Object.assign(stubAskTool(execute), {
			materialize: async () => builtin,
			getIsBuiltinAskTool: () => true,
		});

		await expect(
			guardedFor(cwd, lookAlike).execute(
				"call-1",
				QUESTION,
				undefined,
				undefined,
				createContext(async () => "Vault"),
			),
		).rejects.toThrow(/custom ask tools are not permitted/);
		expect(execute).not.toHaveBeenCalled();
	});

	it.skip("refuses an AskTool subclass that replaces execute", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		const execute = vi.fn(async () => {});
		class UnsettledAskTool extends AskTool {
			override async execute(): Promise<never> {
				await execute();
				throw new Error("the subclass ran");
			}
		}
		const subclass = new UnsettledAskTool(createSession(cwd, { getSessionId: () => TEST_SESSION_ID }));

		expect(isBuiltinAskTool(subclass)).toBe(false);
		expect(isBuiltinAskTool(askTool(cwd))).toBe(true);
		await expect(
			guardedFor(cwd, subclass).execute(
				"call-1",
				QUESTION,
				undefined,
				undefined,
				createContext(async () => "Vault"),
			),
		).rejects.toThrow(/custom ask tools are not permitted/);
		expect(execute).not.toHaveBeenCalled();
	});

	it.skip("answers a human-blocked ask on the attended UI only", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		const awaitAnswer = vi.fn(async () => "Vault");
		const tool = askTool(cwd, { getAskAnswerSource: () => ({ awaitAnswer }) });
		const publishedWhileOpen: number[] = [];
		const context = {
			hasUI: true,
			ui: {
				select: async () => {
					publishedWhileOpen.push(listPendingAsks(TEST_SESSION_ID).length);
					return "Other (type your own)";
				},
				editor: async () => {
					publishedWhileOpen.push(listPendingAsks(TEST_SESSION_ID).length);
					return "The staging vault";
				},
			},
			abort: () => {},
		} as unknown as AgentToolContext;

		const result = await tool.execute("call-1", QUESTION, undefined, undefined, context);

		expect(result.content).toEqual([{ type: "text", text: "User provided custom input: The staging vault" }]);
		// Neither the selector nor the custom-input editor was offered to a remote responder.
		expect(publishedWhileOpen).toEqual([0, 0]);
		expect(awaitAnswer).not.toHaveBeenCalled();
		expect(await answeredAskRows(cwd)).toBe(1);
	});

	it.skip("reports a timeout as no answer and records no interview round for it", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		const recorder = vi
			.spyOn(deepInterviewRecorder, "appendOrMergeDeepInterviewRound")
			.mockResolvedValue(undefined as never);
		try {
			const tool = askTool(cwd, {
				getDeepInterviewAskStage: () => "post-topology",
				settings: Settings.isolated({ "ask.timeout": 0.001 }),
			});
			const question = {
				questions: [
					{
						...QUESTION.questions[0],
						deepInterview: { round: 2, component: "Scope", dimension: "Constraints", ambiguity: 0.42 },
					},
				],
			};

			const timedOut = await tool.execute("call-1", question, undefined, undefined, timedOutContext());

			expect(timedOut.content).toEqual([{ type: "text", text: "Ask timed out without user response" }]);
			expect(recorder).not.toHaveBeenCalled();

			// The user's own answer to the same question is still recorded.
			await tool.execute(
				"call-2",
				question,
				undefined,
				undefined,
				createContext(async () => "Vault"),
			);

			expect(recorder).toHaveBeenCalledTimes(1);
		} finally {
			recorder.mockRestore();
		}
	});

	it.skip("settles the ask on the rows that were written when their audit entry fails", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		// Every ledger append from here on writes its row and then fails its audit entry.
		const audit = auditPath(cwd, TEST_SESSION_ID);
		await fs.rm(audit, { force: true });
		await fs.mkdir(audit, { recursive: true });
		const tool = askTool(cwd, { settings: Settings.isolated({ "ask.timeout": 0.001 }) });

		// Reserved and released: the question opened, and the release was not lost.
		const timedOut = await tool.execute("call-1", QUESTION, undefined, undefined, timedOutContext());
		expect(timedOut.details?.timedOut).toBe(true);
		const afterTimeout = (await readUltragoalLedger(cwd, TEST_SESSION_ID)).map(event => event.event);
		expect(afterTimeout.slice(-2)).toEqual(["human_blocked_ask_reserved", "human_blocked_ask_released"]);

		// The same tool can ask again, and the answer spends the admission.
		const select = vi.fn(async () => "Vault");
		await tool.execute("call-2", QUESTION, undefined, undefined, createContext(select));
		expect(select).toHaveBeenCalledTimes(1);
		expect(await answeredAskRows(cwd)).toBe(1);
		expect((await isUltragoalPauseBlocked(cwd, { sessionId: TEST_SESSION_ID })).askSpent).toBe(true);
	});
});

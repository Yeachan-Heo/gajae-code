import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolContext } from "@gajae-code/agent-core";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	activeSnapshotPath,
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
import { AskTool, BUILTIN_ASK_TOOL } from "@gajae-code/coding-agent/tools/ask";
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
	const tool: AgentTool & { [BUILTIN_ASK_TOOL]: true } = {
		name: "ask",
		label: "Ask",
		summary: "Ask",
		description: "Ask",
		parameters: {} as never,
		strict: true,
		[BUILTIN_ASK_TOOL]: true,
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

	it("admits ask without consuming a nudge once the pause receipt is clean", async () => {
		const cwd = await tempDir();
		process.env.GJC_SESSION_ID = TEST_SESSION_ID;
		await createUltragoalPlan({ cwd, brief: "Implement the story" });
		await recordVerifiedHumanBlock(cwd);
		const ledgerFile = Bun.file(getUltragoalPaths(cwd, TEST_SESSION_ID).ledgerPath);
		const ledgerBefore = await ledgerFile.text();
		const { execute, ask } = guardedAsk(cwd, TEST_SESSION_ID);

		const result = await ask();

		expect(result.content).toEqual([{ type: "text", text: "asked" }]);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(await ledgerFile.text()).toBe(ledgerBefore);
		// The run itself is still incomplete: only the ask surface opened.
		expect((await isUltragoalAskBlocked(cwd, { sessionId: TEST_SESSION_ID })).active).toBe(true);
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

	function askTool(cwd: string): AskTool {
		return new AskTool(createSession(cwd, { getSessionId: () => TEST_SESSION_ID }));
	}

	async function answeredAskRows(cwd: string): Promise<number> {
		const ledger = await readUltragoalLedger(cwd, TEST_SESSION_ID);
		return ledger.filter(event => event.event === "human_blocked_ask_answered").length;
	}

	it("spends the receipt on the first answered ask and refuses the next one", async () => {
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

	it("leaves the receipt unspent when the user cancels the ask", async () => {
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

	it("admits one more ask after a newly verified human-only blocker", async () => {
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

	it("does not reopen ask when only the pause verdict is recorded again", async () => {
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

	it("admits only one of two asks issued in parallel", async () => {
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

	it("keeps the admission closed when the answer cannot be recorded", async () => {
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

	it("keeps the admission spent on disk when the answer cannot be recorded", async () => {
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

	it("refuses to open the question when the reservation cannot be recorded", async () => {
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

	it("holds plan writes behind the reservation recheck", async () => {
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

	it("refuses a human-blocked ask without an interactive UI", async () => {
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

	it("refuses to reserve a receipt superseded by a newer classification after the guard ran", async () => {
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

	it("reserves a receipt that still names the current verified blocker", async () => {
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

	it("keeps the admission open when the ask timeout auto-selects an answer", async () => {
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

	it("keeps the admission open when the user asks about the choices instead of answering", async () => {
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

	it("spends the receipt through the session tool wrapper as well", async () => {
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
	it("[Issue 1] records successful reservation when receipt is current", async () => {
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
	it("refuses admission for custom ask tools to prevent bypass of settlement accounting", async () => {
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
});

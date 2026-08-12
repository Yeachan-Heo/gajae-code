/**
 * R1 + R3 focused contracts:
 * - D1/D2: `getLastModelChangeRole` keyed ONLY on the nearest `model_change`
 *   (six parity cases); `hasExplicitDefaultModel` isolated to legacy `models.default`
 *   inference.
 * - D5/D5a: synchronous context builders throw the exported, instanceof-stable
 *   `SessionContextTooLargeError` past the budget with scratch released; strict
 *   inspection maps to a discriminated `context_too_large` result; startup mapping
 *   (`SessionManager.open`) and `openExistingStrict` stay result-based.
 * - D7: the AgentSession overflow seam compacts exactly once (`willRetry:false`,
 *   `continueAfterMaintenance:false`) and retries exactly once; a skipped forced
 *   compaction rethrows the original typed error with zero retries.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { Agent, AgentBusyError, type AgentMessage } from "@gajae-code/agent-core";
import * as compactionModule from "@gajae-code/agent-core/compaction";
import { getBundledModel } from "@gajae-code/ai";
import { TempDir } from "@gajae-code/utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { HindsightSessionState } from "../../src/hindsight/state";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import {
	buildSessionContext,
	RESUME_TRANSCRIPT_MAX_BYTES,
	SessionContextTooLargeError,
	type SessionEntry,
	SessionManager,
	SessionManagerTestHooks,
} from "../../src/session/session-manager";
import { FileSessionStorage } from "../../src/session/session-storage";
import { assistantMsg, userMsg } from "../utilities";

const TEST_BUDGET_BYTES = 64 * 1024 * 1024;
const BIG_TEXT = "x".repeat(40_000_000);
// 2 × chars + 16 B per the accountant formula: comfortably over the 64 MiB budget.
const BIG_MEASURED_BYTES = 2 * BIG_TEXT.length + 16;

function bigAssistantEntry(): Extract<SessionEntry, { type: "message" }> {
	return {
		type: "message",
		id: "big-message",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: assistantMsg(BIG_TEXT),
	};
}
// Pin the session-context budget to 64 MiB for this file only, in-process via the
// test hook. This does not leak into spawned subprocesses (unlike process.env) and
// keeps the 40 MiB fixtures deterministic under any production default.
beforeAll(() => {
	SessionManagerTestHooks.sessionContextBudgetBytesOverride = TEST_BUDGET_BYTES;
});
afterAll(() => {
	delete SessionManagerTestHooks.sessionContextBudgetBytesOverride;
});

describe("R1 nearest model-change role + hasExplicitDefaultModel isolation", () => {
	function freshManager(): SessionManager {
		return SessionManager.inMemory();
	}

	it("(a) reviewer-only model change resolves to reviewer", () => {
		const manager = freshManager();
		manager.appendModelChange("anthropic/model", "reviewer");
		expect(manager.getLastModelChangeRole()).toBe("reviewer");
	});

	it("(b) temporary-only model change resolves to temporary", () => {
		const manager = freshManager();
		manager.appendModelChange("anthropic/model", "temporary");
		expect(manager.getLastModelChangeRole()).toBe("temporary");
	});

	it("(c) interleaved default -> reviewer -> temporary resolves to the nearest (temporary)", () => {
		const manager = freshManager();
		manager.appendModelChange("anthropic/one", "default");
		manager.appendModelChange("anthropic/two", "reviewer");
		manager.appendModelChange("anthropic/three", "temporary");
		expect(manager.getLastModelChangeRole()).toBe("temporary");
	});

	it("(d) no model_change resolves to undefined", () => {
		const manager = freshManager();
		manager.appendMessage(userMsg("hello"));
		expect(manager.getLastModelChangeRole()).toBeUndefined();
	});

	it("(e) legacy-only assistant inference resolves to undefined while models.default is inferred", () => {
		const manager = freshManager();
		manager.appendMessage(assistantMsg("legacy"));
		expect(manager.getLastModelChangeRole()).toBeUndefined();
		// hasExplicitDefaultModel never feeds the role getter; legacy inference
		// into models.default is unaffected by the getter.
		expect(manager.buildSessionContext().models.default).toBe("anthropic/test");
	});

	it("(f) explicit default then legacy inference resolves to default and blocks inference", () => {
		const manager = freshManager();
		manager.appendModelChange("anthropic/explicit", "default");
		manager.appendMessage(assistantMsg("legacy"));
		expect(manager.getLastModelChangeRole()).toBe("default");
		expect(manager.buildSessionContext().models.default).toBe("anthropic/explicit");
	});

	it("hasExplicitDefaultModel isolation: a reviewer-only change does not block legacy models.default inference", () => {
		const manager = freshManager();
		manager.appendModelChange("anthropic/reviewer-model", "reviewer");
		manager.appendMessage(assistantMsg("legacy"));
		expect(manager.getLastModelChangeRole()).toBe("reviewer");
		// The flag keys only on an explicit default role, so assistant inference
		// still fills models.default — proving the flag is isolated from the getter.
		expect(manager.buildSessionContext().models.default).toBe("anthropic/test");
	});
});

describe("R3 synchronous context preflight (D5/D5a)", () => {
	it("free buildSessionContext throws the exported instanceof-stable error over the budget", () => {
		const entries = [bigAssistantEntry()];
		expect(BIG_MEASURED_BYTES).toBeGreaterThan(TEST_BUDGET_BYTES);
		try {
			buildSessionContext(entries);
			throw new Error("Expected SessionContextTooLargeError");
		} catch (error) {
			expect(error).toBeInstanceOf(SessionContextTooLargeError);
			if (error instanceof SessionContextTooLargeError) {
				expect(error.code).toBe("context_too_large");
				expect(error.name).toBe("SessionContextTooLargeError");
				expect(error.measuredBytes).toBeGreaterThan(error.budgetBytes);
				expect(error.budgetBytes).toBe(TEST_BUDGET_BYTES);
			}
		}
	});

	it("SessionManager.buildSessionContext throws with scratch released (revision counters unchanged; later builds succeed)", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(userMsg("small"));
		manager.appendMessage(assistantMsg(BIG_TEXT));
		const before = manager.revisionSnapshot();
		expect(() => manager.buildSessionContext()).toThrow(SessionContextTooLargeError);
		expect(manager.revisionSnapshot()).toEqual(before);
		// Scratch was not cached: an independent small build remains unaffected.
		const smallManager = SessionManager.inMemory();
		smallManager.appendMessage(userMsg("after"));
		expect(smallManager.buildSessionContext().messages.length).toBe(1);
	});

	it("buildPreparedNewSessionContext propagates the typed synchronous overflow", async () => {
		const manager = SessionManager.inMemory();
		const prepared = await manager.prepareNewSession();
		try {
			manager.appendPreparedCustomMessageEntry(prepared, "oversized", BIG_TEXT, true);
			expect(() => manager.buildPreparedNewSessionContext(prepared)).toThrow(SessionContextTooLargeError);
		} finally {
			await manager.discardPreparedNewSession(prepared);
			await manager.close();
		}
	});
	it("strict inspection maps a builder overflow to a discriminated context_too_large result, never malformed", async () => {
		const tempDir = TempDir.createSync("@pi-context-overflow-inspect-");
		try {
			const storage = new FileSessionStorage();
			const sessionFile = path.join(tempDir.path(), "oversized.jsonl");
			const header = JSON.stringify({
				type: "session",
				version: 5,
				id: "oversized-session",
				timestamp: new Date().toISOString(),
				cwd: tempDir.path(),
			});
			storage.writeTextSync(sessionFile, `${header}\n${JSON.stringify(bigAssistantEntry())}\n`);
			expect(storage.statSync(sessionFile).size).toBeLessThan(RESUME_TRANSCRIPT_MAX_BYTES);

			const inspected = await SessionManager.inspectSessionTailReadOnly(sessionFile, storage);
			expect(inspected).toMatchObject({ kind: "error", reason: "context_too_large" });
			if ("size" in inspected) {
				expect(inspected.size).toBeGreaterThan(TEST_BUDGET_BYTES);
			}
		} finally {
			tempDir.removeSync();
		}
	});

	it("openExistingStrict returns a discriminated context_too_large result; SessionManager.open maps it to the typed throw", async () => {
		const tempDir = TempDir.createSync("@pi-context-overflow-open-");
		try {
			const storage = new FileSessionStorage();
			const sessionFile = path.join(tempDir.path(), "oversized.jsonl");
			const header = JSON.stringify({
				type: "session",
				version: 5,
				id: "oversized-session",
				timestamp: new Date().toISOString(),
				cwd: tempDir.path(),
			});
			storage.writeTextSync(sessionFile, `${header}\n${JSON.stringify(bigAssistantEntry())}\n`);

			const stat = storage.statSync(sessionFile);
			const snapshot = storage.readSnapshotSync(sessionFile);
			const identity = {
				canonicalPath: path.resolve(sessionFile),
				sessionId: "oversized-session",
				dev: stat.dev,
				ino: stat.ino,
				nlink: stat.nlink,
				size: stat.size,
				mtimeMs: stat.mtimeMs,
				mtimeNs: stat.mtimeNs,
				ctimeNs: stat.ctimeNs,
				sha256: createHash("sha256").update(snapshot.bytes).digest("hex"),
			};
			const opened = await SessionManager.openExistingStrict(identity, undefined, storage);
			expect(opened).toMatchObject({ kind: "error", reason: "context_too_large" });

			// Throwing startup owner maps the discriminated reason to the exported error.
			// The managed destination path routes through inspectResumeSessionFile,
			// which reports `context_too_large` before any create/rewrite authority.
			const managedDestination = SessionManager.managedDestination(tempDir.path(), tempDir.path(), storage);
			await expect(SessionManager.open(sessionFile, managedDestination, storage)).rejects.toThrow(
				SessionContextTooLargeError,
			);
		} finally {
			tempDir.removeSync();
		}
	});
});

describe("R3 AgentSession overflow compact-once seam (D7)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;
	let compactSpy: ReturnType<typeof vi.spyOn>;

	async function makeSession(
		settingsOverrides: Record<string, unknown> = {},
		sessionOverrides: Record<string, unknown> = {},
	): Promise<void> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model to exist");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": false,
				"contextPromotion.enabled": false,
				"todo.reminders": false,
				...settingsOverrides,
			}),
			modelRegistry,
			...sessionOverrides,
		});
		session.subscribe(() => {});
	}

	function appendConversation(seed = "seed"): void {
		for (let i = 0; i < 4; i++) {
			const user = userMsg(`${seed} user ${i}`);
			const assistant = assistantMsg(`${seed} assistant ${i}`);
			session.agent.appendMessage(user);
			sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			sessionManager.appendMessage(assistant);
		}
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-context-overflow-seam-");
		await makeSession();
		compactSpy = vi.spyOn(compactionModule, "compact");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	it("buildDisplaySessionContext preserves the synchronous typed overflow without compaction", () => {
		sessionManager.appendMessage(assistantMsg(BIG_TEXT));
		expect(() => session.buildDisplaySessionContext()).toThrow(SessionContextTooLargeError);
		expect(compactSpy).not.toHaveBeenCalled();
	});
	it("rethrows the original typed error with zero retries when forced compaction cannot make progress", async () => {
		appendConversation("seed");
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const overflow = new SessionContextTooLargeError(70 * 1024 * 1024);
		const buildSpy = vi.spyOn(sessionManager, "buildSessionContext").mockImplementationOnce(() => {
			throw overflow;
		});

		// Default keepRecentTokens leaves nothing eligible to compact: the forced
		// run reports skipped and the ORIGINAL error surfaces without a retry.
		await expect(session.prompt("overflow")).rejects.toBe(overflow);
		expect(buildSpy).toHaveBeenCalledTimes(1);
		expect(compactSpy).not.toHaveBeenCalled();
		expect(promptSpy).not.toHaveBeenCalled();
	});

	it("compacts exactly once (willRetry false, no continuation) then retries exactly once and succeeds", async () => {
		// Small keep window so the forced overflow compaction has work to do.
		await session.dispose();
		await makeSession({ "compaction.keepRecentTokens": 1 });
		appendConversation("seed");
		const hindsight = new HindsightSessionState({
			sessionId: "overflow-recall",
			client: {} as never,
			bankId: "overflow-recall-bank",
			config: {
				autoRetain: false,
				autoRecall: false,
				mentalModelsEnabled: false,
				debug: false,
			} as never,
			session,
			missionsSet: new Set(),
		});
		hindsight.lastRecallSnippet = "<memories>overflow recall</memories>";
		const recallReadSpy = vi.spyOn(hindsight, "getRecallSnippetForInjection");
		const recallMarkSpy = vi.spyOn(hindsight, "markRecallSnippetInjected");
		session.setHindsightSessionState(hindsight);
		session.queueDeferredMessageForTests(
			{
				role: "custom",
				customType: "overflow-pending",
				content: "accepted exactly once",
				display: false,
				attribution: "agent",
				timestamp: Date.now(),
			},
			false,
		);
		const submitted: AgentMessage[][] = [];
		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async (messages, options) => {
			submitted.push(messages as AgentMessage[]);
			if (!Array.isArray(options)) options?.onRunAccepted?.(undefined as never, { consumedQueuedMessages: [] });
		});
		const realContext = sessionManager.buildSessionContext();
		const overflow = new SessionContextTooLargeError(70 * 1024 * 1024);
		const buildSpy = vi
			.spyOn(sessionManager, "buildSessionContext")
			.mockImplementationOnce(() => {
				throw overflow;
			})
			.mockImplementationOnce(() => realContext);
		const firstKeptEntryId = sessionManager.getBranch()[0]?.id ?? "root";
		compactSpy.mockResolvedValue({
			summary: "compacted",
			firstKeptEntryId,
			tokensBefore: 1,
		});

		await session.prompt("overflow");

		// The observable seam retries the accepted prompt after rebuilding context; internal compaction reads vary by storage mode.
		expect(buildSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(submitted).toHaveLength(1);
		expect(
			submitted[0]?.filter(message => message.role === "custom" && message.customType === "overflow-pending"),
		).toHaveLength(1);
		expect(
			submitted[0]?.filter(message => message.role === "custom" && message.customType === "hindsight-recall"),
		).toHaveLength(1);
		expect(recallMarkSpy).toHaveBeenCalledTimes(1);
		expect(recallReadSpy).toHaveBeenCalledTimes(1);
		expect(session.getPendingNextTurnMessagesForTests()).toEqual([]);
	});
	it("preserves pending and recall ownership across AgentBusy before acceptance", async () => {
		const hindsight = new HindsightSessionState({
			sessionId: "busy-recall",
			client: {} as never,
			bankId: "busy-recall-bank",
			config: {
				autoRetain: false,
				autoRecall: false,
				mentalModelsEnabled: false,
				debug: false,
			} as never,
			session,
			missionsSet: new Set(),
		});
		hindsight.lastRecallSnippet = "<memories>busy recall</memories>";
		const recallReadSpy = vi.spyOn(hindsight, "getRecallSnippetForInjection");
		const recallMarkSpy = vi.spyOn(hindsight, "markRecallSnippetInjected");
		session.setHindsightSessionState(hindsight);
		session.queueDeferredMessageForTests(
			{
				role: "custom",
				customType: "busy-pending",
				content: "preserve until accepted",
				display: false,
				attribution: "agent",
				timestamp: Date.now(),
			},
			false,
		);
		const submitted: AgentMessage[][] = [];
		vi.spyOn(session.agent, "waitForIdle").mockImplementation(async () => {
			session.setGoalModeState({
				enabled: true,
				mode: "active",
				goal: {
					id: "busy-goal",
					objective: "Reflect live idle-wait state",
					status: "active",
					tokensUsed: 0,
					timeUsedSeconds: 0,
					createdAt: 0,
					updatedAt: 0,
				},
			});
		});
		const promptSpy = vi
			.spyOn(session.agent, "prompt")
			.mockImplementationOnce(async messages => {
				submitted.push(messages as AgentMessage[]);
				throw new AgentBusyError();
			})
			.mockImplementationOnce(async (messages, options) => {
				submitted.push(messages as AgentMessage[]);
				if (!Array.isArray(options)) options?.onRunAccepted?.(undefined as never, { consumedQueuedMessages: [] });
			});

		await session.prompt("busy");

		expect(promptSpy).toHaveBeenCalledTimes(2);
		for (const messages of submitted) {
			expect(
				messages.filter(message => message.role === "custom" && message.customType === "busy-pending"),
			).toHaveLength(1);
			expect(
				messages.filter(message => message.role === "custom" && message.customType === "hindsight-recall"),
			).toHaveLength(1);
		}
		expect(
			submitted[0]?.filter(message => message.role === "custom" && message.customType === "goal-mode-context"),
		).toEqual([]);
		expect(
			submitted[1]?.filter(message => message.role === "custom" && message.customType === "goal-mode-context"),
		).toHaveLength(1);
		expect(recallReadSpy).toHaveBeenCalledTimes(1);
		expect(recallMarkSpy).toHaveBeenCalledTimes(1);
		expect(session.getPendingNextTurnMessagesForTests()).toEqual([]);
	});
	it("does not replay pending next-turn context after an accepted provider failure", async () => {
		session.queueDeferredMessageForTests(
			{
				role: "custom",
				customType: "accepted-failure-pending",
				content: "consume on acceptance",
				display: false,
				attribution: "agent",
				timestamp: Date.now(),
			},
			false,
		);
		const hindsight = new HindsightSessionState({
			sessionId: "accepted-failure-recall",
			client: {} as never,
			bankId: "accepted-failure-recall-bank",
			config: {
				autoRetain: false,
				autoRecall: false,
				mentalModelsEnabled: false,
				debug: false,
			} as never,
			session,
			missionsSet: new Set(),
		});
		hindsight.lastRecallSnippet = "<memories>accepted failure recall</memories>";
		const recallReadSpy = vi.spyOn(hindsight, "getRecallSnippetForInjection");
		const recallMarkSpy = vi.spyOn(hindsight, "markRecallSnippetInjected");
		session.setHindsightSessionState(hindsight);
		const submitted: AgentMessage[][] = [];
		const providerFailure = new Error("accepted provider failure");
		const promptSpy = vi
			.spyOn(session.agent, "prompt")
			.mockImplementationOnce(async (messages, options) => {
				submitted.push(messages as AgentMessage[]);
				if (!Array.isArray(options)) options?.onRunAccepted?.(undefined as never, { consumedQueuedMessages: [] });
				throw providerFailure;
			})
			.mockImplementationOnce(async (messages, options) => {
				submitted.push(messages as AgentMessage[]);
				if (!Array.isArray(options)) options?.onRunAccepted?.(undefined as never, { consumedQueuedMessages: [] });
			});

		await expect(session.prompt("first")).rejects.toBe(providerFailure);
		expect(session.getPendingNextTurnMessagesForTests()).toEqual([]);
		await session.prompt("second");
		expect(promptSpy).toHaveBeenCalledTimes(2);
		expect(
			submitted[1]?.filter(
				message => message.role === "custom" && message.customType === "accepted-failure-pending",
			),
		).toEqual([]);
		expect(
			submitted[1]?.filter(message => message.role === "custom" && message.customType === "hindsight-recall"),
		).toEqual([]);
		expect(recallReadSpy).toHaveBeenCalledTimes(2);
		expect(recallMarkSpy).toHaveBeenCalledTimes(1);
	});
	it("preserves a claimed roster across forced overflow compaction and commits it exactly once", async () => {
		await session.dispose();
		const registry = new AgentRegistry();
		registry.register({
			id: "1-Worker",
			displayName: "1-Worker display",
			rosterLabel: "1-Worker label",
			kind: "sub",
			status: "running",
			session: null,
		});
		await makeSession({ "compaction.keepRecentTokens": 1 }, { agentId: "0-Main", agentRegistry: registry });
		appendConversation("roster-seed");
		const submitted: AgentMessage[][] = [];
		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async (messages, options) => {
			submitted.push(messages as AgentMessage[]);
			if (!Array.isArray(options)) options?.onRunAccepted?.(undefined as never, { consumedQueuedMessages: [] });
		});
		const realContext = sessionManager.buildSessionContext();
		const overflow = new SessionContextTooLargeError(70 * 1024 * 1024);
		const buildSpy = vi
			.spyOn(sessionManager, "buildSessionContext")
			.mockImplementationOnce(() => {
				throw overflow;
			})
			.mockImplementationOnce(() => realContext);
		const firstKeptEntryId = sessionManager.getBranch()[0]?.id ?? "root";
		compactSpy.mockResolvedValue({
			summary: "compacted",
			firstKeptEntryId,
			tokensBefore: 1,
		});

		await session.prompt("roster-overflow");

		// Exactly one compaction, one retry, and one accepted prompt commit the claimed roster once.
		expect(buildSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(submitted).toHaveLength(1);
		expect(
			submitted[0]?.filter(message => message.role === "custom" && message.customType === "irc-peer-roster"),
		).toHaveLength(1);
	});
	it("rethrows the original overflow after bounded failed compaction attempts without continuation", async () => {
		await session.dispose();
		await makeSession({ "compaction.keepRecentTokens": 1 });
		appendConversation("failure");
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const overflow = new SessionContextTooLargeError(70 * 1024 * 1024);
		const buildSpy = vi.spyOn(sessionManager, "buildSessionContext").mockImplementationOnce(() => {
			throw overflow;
		});
		compactSpy.mockRejectedValue(new Error("forced compaction failed"));

		await expect(session.prompt("overflow")).rejects.toBe(overflow);
		expect(buildSpy).toHaveBeenCalledTimes(1);
		// The forced workflow may include bounded maintenance-model fallbacks before stopping.
		expect(compactSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
		expect(compactSpy.mock.calls.length).toBeLessThanOrEqual(4);
		expect(promptSpy).not.toHaveBeenCalled();
	});
	it("keeps synchronous overflow protection on while the async recovery switch is disabled", async () => {
		await session.dispose();
		authStorage.close();
		await makeSession({ "sessionMemory.contextOverflowRecovery": false });
		appendConversation("disabled");
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const overflow = new SessionContextTooLargeError(70 * 1024 * 1024);
		const buildSpy = vi.spyOn(sessionManager, "buildSessionContext").mockImplementationOnce(() => {
			throw overflow;
		});

		await expect(session.prompt("overflow")).rejects.toBe(overflow);
		expect(buildSpy).toHaveBeenCalledTimes(1);
		expect(compactSpy).not.toHaveBeenCalled();
		expect(promptSpy).not.toHaveBeenCalled();
	});
});

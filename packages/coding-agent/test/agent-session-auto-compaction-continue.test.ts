import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, AgentBusyError } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { loadExtensions } from "@gajae-code/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@gajae-code/coding-agent/extensibility/extensions/runner";
import { AgentSession, type AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { FallbackChainController } from "@gajae-code/coding-agent/session/fallback-chain-controller";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import * as native from "@gajae-code/natives";
import { getProjectAgentDir, logger, TempDir, withTimeout } from "@gajae-code/utils";

const runtimeSignalStoreKey = "__gjcAutoContinueSignals";
type RuntimeSignalGlobal = typeof globalThis & { [runtimeSignalStoreKey]?: string[] };

function getRuntimeSignals(): string[] {
	const globalWithSignals = globalThis as RuntimeSignalGlobal;
	if (!globalWithSignals[runtimeSignalStoreKey]) globalWithSignals[runtimeSignalStoreKey] = [];
	return globalWithSignals[runtimeSignalStoreKey];
}

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 190000,
			output: 1000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 191000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		...overrides,
	} as AssistantMessage;
}

async function advancePostPrompt(ms: number): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, ms));
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("AgentSession auto-compaction continuation", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	async function createSession(settings: Record<string, unknown> = {}, extensionExtra = "", managed = false) {
		tempDir = TempDir.createSync("@pi-auto-compaction-continue-");
		vi.useRealTimers();
		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const extensionPath = path.join(extensionsDir, "compaction-short-circuit.ts");
		fs.writeFileSync(
			extensionPath,
			[
				"export default function(pi) {",
				'\tpi.on("session_before_compact", async (event) => {',
				'\t\treturn { compaction: { summary: "compacted", shortSummary: undefined, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details: {} } };',
				"\t});",
				'\tpi.on("auto_compaction_start", async (event) => {',
				`\t\tconst signals = globalThis.${runtimeSignalStoreKey} ?? (globalThis.${runtimeSignalStoreKey} = []);`,
				'\t\tsignals.push("compaction:start:" + event.reason);',
				"\t});",
				'\tpi.on("auto_compaction_end", async (event) => {',
				`\t\tconst signals = globalThis.${runtimeSignalStoreKey} ?? (globalThis.${runtimeSignalStoreKey} = []);`,
				'\t\tsignals.push("compaction:end:" + (event.aborted ? "aborted" : "ok"));',
				"\t});",
				extensionExtra,
				"}",
			].join("\n"),
		);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const destination = managed ? SessionManager.managedDestination(tempDir.path(), tempDir.path()) : tempDir.path();
		sessionManager = SessionManager.create(tempDir.path(), destination);
		getRuntimeSignals().length = 0;
		const extensionsResult = await loadExtensions([extensionPath], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		const bundledModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundledModel) throw new Error("Expected built-in anthropic model to exist");
		const model = { ...bundledModel, contextWindow: 200_000 };
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.autoContinue": true,
				"contextPromotion.enabled": false,
				"todo.reminders": false,
				...settings,
			}),
			modelRegistry,
			extensionRunner,
		});
		session.setTodoPhases([{ name: "Test", tasks: [{ content: "Keep working", status: "in_progress" }] }]);
	}

	beforeEach(async () => {
		await createSession();
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.useRealTimers();
		getRuntimeSignals().length = 0;
		vi.restoreAllMocks();
	});

	async function driveCompaction(message = assistantMessage()) {
		sessionManager.appendMessage(message);
		session.agent.emitExternalEvent({ type: "message_end", message });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [message] });
		for (let i = 0; i < 20; i++) await Promise.resolve();
		await session.waitForIdle();
	}

	it("threshold default starts one synthetic auto-continue prompt without re-compacting", async () => {
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		const events: string[] = [];
		session.subscribe(event => events.push(event.type));
		await driveCompaction();
		await advancePostPrompt(50);
		await session.waitForIdle();
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(promptSpy.mock.calls[0]?.[0]).toEqual(
			expect.arrayContaining([expect.objectContaining({ role: "developer", attribution: "agent" })]),
		);
		expect(getRuntimeSignals().filter(signal => signal === "compaction:start:threshold")).toHaveLength(1);
		const endIndex = events.indexOf("auto_compaction_end");
		expect(events.slice(endIndex + 1)).not.toContain("agent_end");
		expect(promptSpy.mock.invocationCallOrder[0]).toBeGreaterThan(0);
	});

	it("appends canonical work state to hook-provided compaction summaries", async () => {
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-hook-summary",
				objective: "Preserve hook compaction state",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: 0,
				updatedAt: 0,
			},
		});
		for (let index = 0; index < 8; index++) {
			sessionManager.appendMessage({
				role: "user",
				content: "hook summary context ".repeat(10_000),
				timestamp: Date.now() + index,
			});
		}
		vi.spyOn(session.agent, "prompt").mockResolvedValue();
		await driveCompaction();
		await advancePostPrompt(50);
		await session.waitForIdle();
		const compactionEntry = sessionManager.getBranch().findLast(entry => entry.type === "compaction");
		if (compactionEntry?.type !== "compaction") throw new Error("Expected compaction entry");
		expect(compactionEntry.summary).toContain("compacted");
		expect(compactionEntry.summary).toContain("<compaction-state>");
		expect(compactionEntry.summary).toContain("Active goal: Preserve hook compaction state");
		expect(compactionEntry.summary).toContain("Open todos: Keep working");
	});

	it.skipIf(process.platform !== "darwin")(
		"persists repeated disk-backed compactions through native exact replacement",
		async () => {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
			await createSession({ "compaction.keepRecentTokens": 1 }, "", true);

			const replaceSpy = vi.spyOn(native, "exactReplacePath");
			const rewriteSpy = vi.spyOn(sessionManager, "rewriteEntries");
			vi.spyOn(session.agent, "prompt").mockResolvedValue();
			for (let index = 0; index < 8; index++) {
				sessionManager.appendMessage({
					role: "user",
					content: [{ type: "text", text: `disk-backed compaction context ${index} `.repeat(10_000) }],
					timestamp: Date.now() + index,
				});
			}

			await driveCompaction();
			await advancePostPrompt(50);
			await session.waitForIdle();
			const firstBranch = sessionManager.getBranch();
			const firstCompaction = firstBranch.findLast(entry => entry.type === "compaction");
			if (firstCompaction?.type !== "compaction") throw new Error("Expected first compaction");
			expect(firstBranch.findIndex(entry => entry.id === firstCompaction.firstKeptEntryId)).toBeGreaterThan(0);
			expect(rewriteSpy).toHaveBeenCalled();
			const firstReplacementCount = replaceSpy.mock.calls.length;
			expect(firstReplacementCount).toBeGreaterThan(0);

			for (let index = 0; index < 8; index++) {
				sessionManager.appendMessage({
					role: "user",
					content: [{ type: "text", text: `subsequent disk-backed context ${index} `.repeat(10_000) }],
					timestamp: Date.now() + 100 + index,
				});
			}
			await driveCompaction();
			await advancePostPrompt(50);
			await session.waitForIdle();

			expect(replaceSpy.mock.calls.length).toBeGreaterThan(firstReplacementCount);
			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected managed session file");
			const persisted = fs.readFileSync(sessionFile, "utf8");
			expect(persisted.match(/"type":"compaction"/g)).toHaveLength(2);
			expect(getRuntimeSignals().filter(signal => signal === "compaction:end:ok")).toHaveLength(2);
		},
	);

	it("discards the compaction-triggering agent_end so it never leaks as terminal readiness", async () => {
		// Regression: the async event-handler / extension barriers added to defer
		// agent_end must not resurrect the pre-compaction turn's agent_end after
		// auto_compaction_end. That turn is being auto-continued, so its agent_end is
		// not terminal; with the continuation stubbed (emitting no agent_end),
		// subscribers must observe zero agent_end events.
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		const events: string[] = [];
		session.subscribe(event => events.push(event.type));
		await driveCompaction();
		await advancePostPrompt(50);
		await session.waitForIdle();
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(events).toContain("auto_compaction_end");
		expect(events.filter(type => type === "agent_end")).toHaveLength(0);
	});

	it("overflow with non-resumable tail starts one synthetic auto-continue prompt", async () => {
		const warnSpy = vi.spyOn(logger, "warn");
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const { promise: promptCalled, resolve: onPromptCalled } = Promise.withResolvers<void>();
		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			onPromptCalled();
		});
		const overflow = assistantMessage({
			stopReason: "error",
			errorMessage: "prompt is too long: 1000001 tokens > 1000000 maximum",
		});
		await driveCompaction(overflow);
		await withTimeout(promptCalled, 1000, "Overflow auto-continue prompt timed out");
		await session.waitForIdle();
		expect(continueSpy).not.toHaveBeenCalled();
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(promptSpy.mock.calls[0]?.[0]).toEqual(
			expect.arrayContaining([expect.objectContaining({ role: "developer", attribution: "agent" })]),
		);
		expect(
			warnSpy.mock.calls.some(call => String(call[0]).includes("Cannot continue from message role: assistant")),
		).toBe(false);
		expect(
			warnSpy.mock.calls.some(
				call =>
					call[0] === "Auto-compaction continuation skipped" &&
					JSON.stringify(call[1]).includes('"source":"overflow_retry"') &&
					JSON.stringify(call[1]).includes('"reason":"auto_continue_disabled_non_resumable_tail"'),
			),
		).toBe(false);
	});

	it("resumable overflow retry stays parked for a paused human-wait goal", async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		await createSession({ "compaction.keepRecentTokens": 1 });
		session.setGoalModeState({
			enabled: false,
			mode: "active",
			goal: {
				id: "goal-overflow-paused",
				objective: "Wait for human input",
				status: "paused",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: 0,
				updatedAt: 0,
			},
		});
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		const endEvents: Extract<AgentSessionEvent, { type: "auto_compaction_end" }>[] = [];
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") endEvents.push(event);
		});
		for (let index = 0; index < 4; index++) {
			sessionManager.appendMessage({
				role: "user",
				content: `paused seed user ${index}`,
				timestamp: Date.now() + index * 2,
			});
			sessionManager.appendMessage(assistantMessage({ timestamp: Date.now() + index * 2 + 1 }));
		}
		sessionManager.appendMessage({
			role: "user",
			content: "paused resumable retry boundary",
			timestamp: Date.now() + 100,
		});
		const overflow = assistantMessage({
			stopReason: "error",
			errorMessage: "prompt is too long: 1000001 tokens > 1000000 maximum",
			timestamp: Date.now() + 101,
		});
		const originalReplaceMessages = session.agent.replaceMessages.bind(session.agent);
		vi.spyOn(session.agent, "replaceMessages").mockImplementation(messages => {
			originalReplaceMessages(messages);
			const tail = session.agent.state.messages.at(-1);
			if (tail?.role === "assistant" && tail.stopReason === "error") {
				session.agent.appendMessage({
					role: "user",
					content: "paused resumable retry boundary",
					timestamp: Date.now() + 102,
				});
				session.agent.appendMessage(overflow);
			}
		});
		await driveCompaction(overflow);
		await advancePostPrompt(200);
		await session.waitForIdle();
		expect(continueSpy).not.toHaveBeenCalled();
		expect(promptSpy).not.toHaveBeenCalled();
		expect(endEvents.at(-1)?.willRetry).toBe(false);
	});

	it("overflow with compaction disabled skips compaction and starts one synthetic auto-continue prompt", async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		await createSession({ "compaction.enabled": false });
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const { promise: promptCalled, resolve: onPromptCalled } = Promise.withResolvers<void>();
		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			onPromptCalled();
		});
		const overflow = assistantMessage({
			stopReason: "error",
			errorMessage: "prompt is too long: 1000001 tokens > 1000000 maximum",
		});
		await driveCompaction(overflow);
		await withTimeout(promptCalled, 1000, "Disabled-compaction overflow prompt timed out");
		await session.waitForIdle();
		expect(continueSpy).not.toHaveBeenCalled();
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(getRuntimeSignals().some(signal => signal.startsWith("compaction:start:"))).toBe(false);
	});

	it("overflow with autoContinue false and non-resumable tail logs disabled skip reason", async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		await createSession({ "compaction.autoContinue": false });
		const warnSpy = vi.spyOn(logger, "warn");
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		const endEvents: Extract<AgentSessionEvent, { type: "auto_compaction_end" }>[] = [];
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") endEvents.push(event);
		});
		const overflow = assistantMessage({
			stopReason: "error",
			errorMessage: "prompt is too long: 1000001 tokens > 1000000 maximum",
		});
		await driveCompaction(overflow);
		await session.waitForIdle();
		expect(continueSpy).not.toHaveBeenCalled();
		expect(promptSpy).not.toHaveBeenCalled();
		expect(endEvents.at(-1)).toMatchObject({
			continuationSkipReason: "auto_continue_disabled_non_resumable_tail",
			willRetry: false,
		});
		expect(
			warnSpy.mock.calls.some(
				call =>
					call[0] === "Auto-compaction continuation skipped" &&
					JSON.stringify(call[1]).includes('"source":"overflow_retry"') &&
					JSON.stringify(call[1]).includes('"reason":"auto_continue_disabled_non_resumable_tail"'),
			),
		).toBe(true);
	});

	it("overflow with resumable rebuilt tail strips failed turn and continues once", async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		await createSession({ "compaction.keepRecentTokens": 1 });
		const warnSpy = vi.spyOn(logger, "warn");
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		const events: string[] = [];
		session.subscribe(event => events.push(event.type));

		for (let i = 0; i < 4; i++) {
			sessionManager.appendMessage({ role: "user", content: `seed user ${i}`, timestamp: Date.now() + i * 2 });
			sessionManager.appendMessage(assistantMessage({ timestamp: Date.now() + i * 2 + 1 }));
		}
		sessionManager.appendMessage({
			role: "user",
			content: "latest resumable retry boundary",
			timestamp: Date.now() + 100,
		});
		const overflow = assistantMessage({
			stopReason: "error",
			errorMessage: "prompt is too long: 1000001 tokens > 1000000 maximum",
			timestamp: Date.now() + 101,
		});
		const originalReplaceMessages = session.agent.replaceMessages.bind(session.agent);
		vi.spyOn(session.agent, "replaceMessages").mockImplementation(messages => {
			originalReplaceMessages(messages);
			const tail = session.agent.state.messages.at(-1);
			if (tail?.role === "assistant" && tail.stopReason === "error") {
				session.agent.appendMessage({
					role: "user",
					content: "latest resumable retry boundary",
					timestamp: Date.now() + 102,
				});
				session.agent.appendMessage(overflow);
			}
		});
		await driveCompaction(overflow);
		await advancePostPrompt(200);
		await session.waitForIdle();
		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(promptSpy).not.toHaveBeenCalled();
		expect(events.filter(type => type === "agent_end")).toHaveLength(0);

		expect(
			warnSpy.mock.calls.some(
				call =>
					call[0] === "Auto-compaction continuation skipped" &&
					JSON.stringify(call[1]).includes('"reason":"not_resumable_tail"'),
			),
		).toBe(false);
		const tail = session.agent.state.messages.at(-1);
		expect(tail?.role).not.toBe("assistant");
		expect(JSON.stringify(tail)).not.toContain("prompt is too long: 1000001 tokens > 1000000 maximum");
	});

	it("starts synthetic continuation when no generation supersedes it", async () => {
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		await driveCompaction();
		expect(promptSpy).toHaveBeenCalledTimes(1);
	});

	it("flushes the predecessor terminal event when a queued continuation is cancelled before agent.continue", async () => {
		session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "Queued" }],
			display: false,
			timestamp: Date.now(),
		});
		const resetAttemptBudgetSpy = vi.spyOn(FallbackChainController.prototype, "resetAttemptBudget");
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const compactionFinished = Promise.withResolvers<void>();
		const events: string[] = [];
		session.subscribe(event => {
			events.push(event.type);
			if (event.type === "auto_compaction_end") compactionFinished.resolve();
		});
		const message = assistantMessage();
		sessionManager.appendMessage(message);
		session.agent.emitExternalEvent({ type: "message_end", message });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [message] });
		await compactionFinished.promise;
		for (let index = 0; index < 100; index++) {
			if (session.hasPostPromptWork) break;
			await Promise.resolve();
		}
		expect(session.hasPostPromptWork).toBe(true);

		await session.abort();
		await session.waitForIdle();
		for (let index = 0; index < 20; index++) await Promise.resolve();

		expect(continueSpy).not.toHaveBeenCalled();
		expect(events.filter(type => type === "agent_end")).toHaveLength(1);
		expect(resetAttemptBudgetSpy).not.toHaveBeenCalled();
	});

	it("threshold queued-followup continuation suppresses predecessor terminal readiness", async () => {
		session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "Queued" }],
			display: false,
			timestamp: Date.now(),
		});
		const warnSpy = vi.spyOn(logger, "warn");
		const resetAttemptBudgetSpy = vi.spyOn(FallbackChainController.prototype, "resetAttemptBudget");
		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async options => {
			options?.onRunAccepted?.();
		});
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		const events: string[] = [];
		session.subscribe(event => events.push(event.type));

		await driveCompaction();
		await advancePostPrompt(200);
		await session.waitForIdle();
		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(resetAttemptBudgetSpy).toHaveBeenCalledTimes(1);
		expect(promptSpy).not.toHaveBeenCalled();
		expect(events.filter(type => type === "agent_end")).toHaveLength(0);
		expect(warnSpy.mock.calls.some(call => JSON.stringify(call).includes("AgentBusyError"))).toBe(false);
	});

	it("idle maintenance does not continue", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		await session.runIdleCompaction();
		await advancePostPrompt(200);
		await session.waitForIdle();
		expect(continueSpy).not.toHaveBeenCalled();
		expect(promptSpy).not.toHaveBeenCalled();
	});

	it("autoContinue false without queue does not continue", async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		await createSession({ "compaction.autoContinue": false });
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		await driveCompaction();
		await advancePostPrompt(200);
		await session.waitForIdle();
		expect(continueSpy).not.toHaveBeenCalled();
		expect(promptSpy).not.toHaveBeenCalled();
	});

	it("handoff threshold path schedules hardened auto-continue prompt", async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		await createSession({ "compaction.strategy": "handoff" });
		vi.spyOn(session, "handoff").mockResolvedValue({ document: "handoff", savedPath: "handoff.md" });
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		await driveCompaction();
		await advancePostPrompt(50);
		await session.waitForIdle();
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(getRuntimeSignals()).toContain("compaction:end:ok");
	});
	it("reschedules an AgentBusyError racing the overflow-retry continue until delivery", async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		await createSession({ "compaction.keepRecentTokens": 1 });
		const warnSpy = vi.spyOn(logger, "warn");
		const debugSpy = vi.spyOn(logger, "debug");
		const continueSpy = vi
			.spyOn(session.agent, "continue")
			.mockRejectedValueOnce(new AgentBusyError())
			.mockResolvedValue();
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();

		for (let i = 0; i < 4; i++) {
			sessionManager.appendMessage({ role: "user", content: `seed user ${i}`, timestamp: Date.now() + i * 2 });
			sessionManager.appendMessage(assistantMessage({ timestamp: Date.now() + i * 2 + 1 }));
		}
		sessionManager.appendMessage({
			role: "user",
			content: "latest resumable retry boundary",
			timestamp: Date.now() + 100,
		});
		const overflow = assistantMessage({
			stopReason: "error",
			errorMessage: "prompt is too long: 1000001 tokens > 1000000 maximum",
			timestamp: Date.now() + 101,
		});
		const originalReplaceMessages = session.agent.replaceMessages.bind(session.agent);
		vi.spyOn(session.agent, "replaceMessages").mockImplementation(messages => {
			originalReplaceMessages(messages);
			const tail = session.agent.state.messages.at(-1);
			if (tail?.role === "assistant" && tail.stopReason === "error") {
				session.agent.appendMessage({
					role: "user",
					content: "latest resumable retry boundary",
					timestamp: Date.now() + 102,
				});
				session.agent.appendMessage(overflow);
			}
		});
		await driveCompaction(overflow);
		await advancePostPrompt(300);
		await session.waitForIdle();

		expect(continueSpy).toHaveBeenCalledTimes(2);
		expect(promptSpy).not.toHaveBeenCalled();
		expect(warnSpy.mock.calls.some(call => JSON.stringify(call).includes("AgentBusyError"))).toBe(false);
		expect(warnSpy.mock.calls.some(call => call[0] === "agent.continue failed after scheduling")).toBe(false);
		expect(warnSpy.mock.calls.some(call => call[0] === "Auto-compaction continuation failed")).toBe(false);
		expect(debugSpy.mock.calls.some(call => call[0] === "agent.continue busy after scheduling; rescheduling")).toBe(
			true,
		);
	});

	it("reschedules an AgentBusyError racing the queued-followup continue until delivery", async () => {
		session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "Queued" }],
			display: false,
			timestamp: Date.now(),
		});
		const warnSpy = vi.spyOn(logger, "warn");
		const debugSpy = vi.spyOn(logger, "debug");
		const resetAttemptBudgetSpy = vi.spyOn(FallbackChainController.prototype, "resetAttemptBudget");
		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementationOnce(async () => {
			throw new AgentBusyError();
		});
		continueSpy.mockImplementationOnce(async options => {
			options?.onRunAccepted?.();
		});
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		const events: string[] = [];
		session.subscribe(event => events.push(event.type));

		await driveCompaction();
		await advancePostPrompt(300);
		await session.waitForIdle();

		expect(continueSpy).toHaveBeenCalledTimes(2);
		expect(resetAttemptBudgetSpy).toHaveBeenCalledTimes(1);
		expect(promptSpy).not.toHaveBeenCalled();
		expect(events.filter(type => type === "agent_end")).toHaveLength(0);
		expect(warnSpy.mock.calls.some(call => JSON.stringify(call).includes("AgentBusyError"))).toBe(false);
		expect(debugSpy.mock.calls.some(call => call[0] === "agent.continue busy after scheduling; rescheduling")).toBe(
			true,
		);
	});

	it("preserves synthetic auto-continue prompt delivery across an AgentBusyError", async () => {
		const warnSpy = vi.spyOn(logger, "warn");
		const debugSpy = vi.spyOn(logger, "debug");
		const promptSpy = vi
			.spyOn(session.agent, "prompt")
			.mockRejectedValueOnce(new AgentBusyError())
			.mockResolvedValue();
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const events: string[] = [];
		session.subscribe(event => events.push(event.type));

		await driveCompaction();
		await advancePostPrompt(300);
		await session.waitForIdle();

		expect(promptSpy).toHaveBeenCalledTimes(2);
		expect(continueSpy).not.toHaveBeenCalled();
		expect(events.filter(type => type === "agent_end")).toHaveLength(0);
		expect(warnSpy.mock.calls.some(call => JSON.stringify(call).includes("AgentBusyError"))).toBe(false);
		expect(debugSpy.mock.calls.some(call => call[0] === "Auto-compaction continuation busy; rescheduling")).toBe(
			false,
		);
	});

	it("keeps spoofed AgentBusyError names on the unexpected-failure warn path", async () => {
		const warnSpy = vi.spyOn(logger, "warn");
		const debugSpy = vi.spyOn(logger, "debug");
		const spoofedBusy = Object.assign(new Error("spoofed busy"), { name: "AgentBusyError" });
		const promptSpy = vi.spyOn(session.agent, "prompt").mockRejectedValue(spoofedBusy);

		await driveCompaction();
		await advancePostPrompt(100);
		await session.waitForIdle();

		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(debugSpy.mock.calls.some(call => call[0] === "Auto-compaction continuation busy; rescheduling")).toBe(
			false,
		);
		expect(
			warnSpy.mock.calls.some(
				call =>
					call[0] === "Auto-compaction continuation failed" && JSON.stringify(call[1]).includes("spoofed busy"),
			),
		).toBe(true);
	});
});

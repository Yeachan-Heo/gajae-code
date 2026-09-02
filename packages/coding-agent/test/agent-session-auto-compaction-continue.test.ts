import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
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

	it("drains a queued follow-up through continueQueuedMessages after an overflow no-op would replay", async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		// A tiny history inside the keep-recent window leaves nothing to summarize,
		// so prepareCompaction returns undefined and overflow recovery takes the
		// terminal overflow-no-op branch with a resumable non-assistant tail.
		await createSession({ "compaction.keepRecentTokens": 100_000 });
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const continueQueuedMessagesSpy = vi.spyOn(session.agent, "continueQueuedMessages").mockResolvedValue();
		const events: Array<Extract<AgentSessionEvent, { type: "auto_compaction_end" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") events.push(event);
		});

		sessionManager.appendMessage({ role: "user", content: "resumable boundary", timestamp: Date.now() - 1 });
		session.agent.appendMessage({ role: "user", content: "resumable boundary", timestamp: Date.now() - 1 });
		session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "Queued follow-up" }],
			display: false,
			timestamp: Date.now(),
		});
		const overflow = assistantMessage({
			stopReason: "error",
			errorMessage: "prompt is too long: 1000001 tokens > 1000000 maximum",
			timestamp: Date.now() + 1,
		});
		await driveCompaction(overflow);
		await advancePostPrompt(200);
		await session.waitForIdle();

		// The explicit queued_continue drain must consume the queued message
		// instead of replaying the oversized non-assistant tail.
		expect(continueQueuedMessagesSpy).toHaveBeenCalledTimes(1);
		expect(continueSpy).not.toHaveBeenCalled();
		expect(events).toEqual([
			expect.objectContaining({
				type: "auto_compaction_end",
				action: "context-full",
				skipped: true,
				errorMessage: expect.stringContaining("nothing eligible to compact"),
			}),
		]);
	});

	it("drains a queued steer through continueQueuedMessages after an overflow no-op would replay", async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		await createSession({ "compaction.keepRecentTokens": 100_000 });
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const continueQueuedMessagesSpy = vi.spyOn(session.agent, "continueQueuedMessages").mockResolvedValue();

		sessionManager.appendMessage({ role: "user", content: "resumable boundary", timestamp: Date.now() - 1 });
		session.agent.appendMessage({ role: "user", content: "resumable boundary", timestamp: Date.now() - 1 });
		// Seed the steering queue directly: steer() only admits into a live run.
		session.agent.restoreSteering([
			{
				role: "user",
				content: [{ type: "text", text: "Queued steer" }],
				attribution: "user",
				timestamp: Date.now(),
			},
		]);
		const overflow = assistantMessage({
			stopReason: "error",
			errorMessage: "prompt is too long: 1000001 tokens > 1000000 maximum",
			timestamp: Date.now() + 1,
		});
		await driveCompaction(overflow);
		await advancePostPrompt(200);
		await session.waitForIdle();

		expect(continueQueuedMessagesSpy).toHaveBeenCalledTimes(1);
		expect(continueSpy).not.toHaveBeenCalled();
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
		const continueSpy = vi.spyOn(session.agent, "continue");
		const continueQueuedMessagesSpy = vi
			.spyOn(session.agent, "continueQueuedMessages")
			.mockImplementation(async options => {
				options?.onRunAccepted?.(undefined as never, { consumedQueuedMessages: [] });
			});
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		const events: string[] = [];
		session.subscribe(event => events.push(event.type));

		await driveCompaction();
		await advancePostPrompt(200);
		await session.waitForIdle();
		expect(continueSpy).not.toHaveBeenCalled();
		expect(continueQueuedMessagesSpy).toHaveBeenCalledTimes(1);
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
	it("queues emergency-compaction continuation behind the active session admission", async () => {
		const promptStarted = Promise.withResolvers<void>();
		const releasePrompt = Promise.withResolvers<void>();
		let promptCalls = 0;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			if (++promptCalls !== 1) return;
			promptStarted.resolve();
			await releasePrompt.promise;
			const message = assistantMessage();
			sessionManager.appendMessage(message);
			session.agent.emitExternalEvent({ type: "message_end", message });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [message] });
		});

		const activePrompt = session.prompt("active work");
		await promptStarted.promise;
		expect(promptSpy).toHaveBeenCalledTimes(1);
		releasePrompt.resolve();
		await activePrompt;
		await session.waitForIdle();
		expect(promptSpy).toHaveBeenCalledTimes(2);
	});

	it("queues a no-context emergency continuation until selection admission releases", async () => {
		const selectionEntered = Promise.withResolvers<void>();
		const releaseSelection = Promise.withResolvers<void>();
		const selection = session.withSdkControlMutation(async () => {
			selectionEntered.resolve();
			await releaseSelection.promise;
		});
		await selectionEntered.promise;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		const message = assistantMessage();
		sessionManager.appendMessage(message);
		session.agent.emitExternalEvent({ type: "message_end", message });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [message] });
		for (let i = 0; i < 20; i++) await Promise.resolve();

		expect(promptSpy).not.toHaveBeenCalled();
		releaseSelection.resolve();
		await selection;
		await session.waitForIdle();
		expect(promptSpy).toHaveBeenCalledTimes(1);
	});

	it("does not deadlock default selection waiting for an inherited emergency continuation", async () => {
		const promptStarted = Promise.withResolvers<void>();
		const releasePrompt = Promise.withResolvers<void>();
		const order: string[] = [];
		let promptCalls = 0;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			if (++promptCalls !== 1) {
				order.push("continuation");
				return;
			}
			promptStarted.resolve();
			await releasePrompt.promise;
			const message = assistantMessage();
			sessionManager.appendMessage(message);
			session.agent.emitExternalEvent({ type: "message_end", message });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [message] });
		});

		const activePrompt = session.prompt("active work");
		await promptStarted.promise;
		const currentModel = session.model;
		if (!currentModel) throw new Error("Expected session model");
		const selectionModel = { ...currentModel, id: "selection-model" };
		const selection = session.setDefaultModelSelection(selectionModel, undefined, {
			onAfterMutation: () => order.push("selection"),
		});
		releasePrompt.resolve();
		await activePrompt;
		await selection;
		await session.waitForIdle();

		expect(promptSpy).toHaveBeenCalledTimes(2);
		expect(order).toEqual(["continuation", "selection"]);
		expect(session.model).toBe(selectionModel);
	});

	it("does not deadlock default selection waiting for an ownerless emergency continuation", async () => {
		const releaseStartupBarrier = Promise.withResolvers<void>();
		session.extendStartupTurnBarrier(releaseStartupBarrier.promise);
		const compactionEnded = Promise.withResolvers<void>();
		const runtimeSignals = getRuntimeSignals();
		const pushRuntimeSignal = runtimeSignals.push.bind(runtimeSignals);
		vi.spyOn(runtimeSignals, "push").mockImplementation((...signals) => {
			const length = pushRuntimeSignal(...signals);
			if (signals.includes("compaction:end:ok")) compactionEnded.resolve();
			return length;
		});
		const order: string[] = [];
		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			order.push("continuation");
		});
		const currentModel = session.model;
		if (!currentModel) throw new Error("Expected session model");
		const selectionModel = { ...currentModel, id: "ownerless-selection-model" };
		const selectionValidated = Promise.withResolvers<void>();
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, ...args) => {
			const apiKey = await originalGetApiKey(model, ...args);
			if (model === selectionModel) selectionValidated.resolve();
			return apiKey;
		});
		const message = assistantMessage();
		sessionManager.appendMessage(message);
		session.agent.emitExternalEvent({ type: "message_end", message });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [message] });
		await compactionEnded.promise;

		const selection = session.setDefaultModelSelection(selectionModel, undefined, {
			onAfterMutation: () => order.push("selection"),
		});
		await selectionValidated.promise;
		for (let i = 0; i < 10; i++) await Promise.resolve();
		releaseStartupBarrier.resolve();
		await selection;
		await session.waitForIdle();

		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(order).toEqual(["continuation", "selection"]);
		expect(session.model).toBe(selectionModel);
	});

	it("keeps an ownerless emergency continuation scheduled later behind selection", async () => {
		const currentModel = session.model;
		if (!currentModel) throw new Error("Expected session model");
		const selectionModel = { ...currentModel, id: "selection-before-ownerless-model" };
		const selectionValidationStarted = Promise.withResolvers<void>();
		const releaseSelectionValidation = Promise.withResolvers<void>();
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, ...args) => {
			if (model === selectionModel) {
				selectionValidationStarted.resolve();
				await releaseSelectionValidation.promise;
			}
			return originalGetApiKey(model, ...args);
		});
		const order: string[] = [];
		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			order.push("continuation");
		});
		const selection = session.setDefaultModelSelection(selectionModel, undefined, {
			onAfterMutation: () => order.push("selection"),
		});
		await selectionValidationStarted.promise;
		const message = assistantMessage();
		sessionManager.appendMessage(message);
		session.agent.emitExternalEvent({ type: "message_end", message });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [message] });
		releaseSelectionValidation.resolve();

		await selection;
		await session.waitForIdle();

		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(order).toEqual(["selection", "continuation"]);
		expect(session.model).toBe(selectionModel);
	});
	it("keeps waitForIdle pending while a deferred continuation waits behind selection", async () => {
		const currentModel = session.model;
		if (!currentModel) throw new Error("Expected session model");
		const selectionModel = { ...currentModel, id: "selection-deferred-idle-model" };
		const selectionValidationStarted = Promise.withResolvers<void>();
		const releaseSelectionValidation = Promise.withResolvers<void>();
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, ...args) => {
			if (model === selectionModel) {
				selectionValidationStarted.resolve();
				await releaseSelectionValidation.promise;
			}
			return originalGetApiKey(model, ...args);
		});
		const order: string[] = [];
		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			order.push("continuation");
		});
		const selection = session.setDefaultModelSelection(selectionModel, undefined, {
			onAfterMutation: () => order.push("selection"),
		});
		await selectionValidationStarted.promise;
		const message = assistantMessage();
		sessionManager.appendMessage(message);
		session.agent.emitExternalEvent({ type: "message_end", message });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [message] });
		// The continuation is now parked behind the pending selection fence,
		// having claimed the predecessor agent_end: external waitForIdle must
		// not report the session idle while that continuation is still waiting
		// on the fence, even once every other in-flight work settles.
		let idleReported = false;
		const idle = session.waitForIdle().then(() => {
			idleReported = true;
		});
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(idleReported).toBe(false);
		releaseSelectionValidation.resolve();

		await selection;
		await idle;
		await session.waitForIdle();

		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(order).toEqual(["selection", "continuation"]);
		expect(session.model).toBe(selectionModel);
	});
	it("does not deadlock when a second selection reserves while a continuation waits behind the first", async () => {
		const currentModel = session.model;
		if (!currentModel) throw new Error("Expected session model");
		const firstModel = { ...currentModel, id: "overlapping-selection-one" };
		const secondModel = { ...currentModel, id: "overlapping-selection-two" };
		const firstValidationStarted = Promise.withResolvers<void>();
		const releaseFirstValidation = Promise.withResolvers<void>();
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, ...args) => {
			if (model === firstModel) {
				firstValidationStarted.resolve();
				await releaseFirstValidation.promise;
			}
			return originalGetApiKey(model, ...args);
		});
		const order: string[] = [];
		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			order.push("continuation");
		});
		// Selection A reserves generation 1 and parks inside credential probing.
		const first = session.setDefaultModelSelection(firstModel, undefined, {
			onAfterMutation: () => order.push("selection-one"),
		});
		await firstValidationStarted.promise;
		// A continuation defers behind A's fence.
		const message = assistantMessage();
		sessionManager.appendMessage(message);
		session.agent.emitExternalEvent({ type: "message_end", message });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [message] });
		for (let i = 0; i < 10; i++) await Promise.resolve();
		// Selection B reserves generation 2 while A is still parked and the
		// generation-1 continuation is still deferred behind A's fence.
		const second = session.setDefaultModelSelection(secondModel, undefined, {
			onAfterMutation: () => order.push("selection-two"),
		});
		releaseFirstValidation.resolve();

		await Promise.all([first, second]);
		await session.waitForIdle();

		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(order).toContain("selection-one");
		expect(order).toContain("selection-two");
		expect(order).toContain("continuation");
		expect(session.model).toBe(secondModel);
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
		const continueSpy = vi.spyOn(session.agent, "continue");
		const continueQueuedMessagesSpy = vi
			.spyOn(session.agent, "continueQueuedMessages")
			.mockImplementationOnce(async () => {
				throw new AgentBusyError();
			});
		continueQueuedMessagesSpy.mockImplementationOnce(async options => {
			options?.onRunAccepted?.(undefined as never, { consumedQueuedMessages: [] });
		});
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		const events: string[] = [];
		session.subscribe(event => events.push(event.type));

		await driveCompaction();
		await advancePostPrompt(300);
		await session.waitForIdle();

		expect(continueSpy).not.toHaveBeenCalled();
		expect(continueQueuedMessagesSpy).toHaveBeenCalledTimes(2);
		expect(resetAttemptBudgetSpy).toHaveBeenCalledTimes(1);
		expect(promptSpy).not.toHaveBeenCalled();
		expect(events.filter(type => type === "agent_end")).toHaveLength(0);
		expect(warnSpy.mock.calls.some(call => JSON.stringify(call).includes("AgentBusyError"))).toBe(false);
		expect(debugSpy.mock.calls.some(call => call[0] === "agent.continue busy after scheduling; rescheduling")).toBe(
			true,
		);
	});

	it("bounds a persistently busy AgentBusyError with capped exponential backoff, then gives up", async () => {
		session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "Queued" }],
			display: false,
			timestamp: Date.now(),
		});
		const warnSpy = vi.spyOn(logger, "warn");
		const debugSpy = vi.spyOn(logger, "debug");
		// Instant waits: without a cap the reschedule loop never terminates, so this
		// test hangs instead of passing against the unpatched fixed-100ms spin.
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const continueSpy = vi.spyOn(session.agent, "continue");
		const continueQueuedMessagesSpy = vi
			.spyOn(session.agent, "continueQueuedMessages")
			.mockRejectedValue(new AgentBusyError());
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();

		await driveCompaction();
		await advancePostPrompt(300);
		await session.waitForIdle();

		// 1 initial attempt + 50 bounded reschedules, then the loop stops for good.
		expect(continueSpy).not.toHaveBeenCalled();
		expect(continueQueuedMessagesSpy).toHaveBeenCalledTimes(51);
		await advancePostPrompt(300);
		await session.waitForIdle();
		expect(continueSpy).not.toHaveBeenCalled();
		expect(continueQueuedMessagesSpy).toHaveBeenCalledTimes(51);

		const busyDebugs = debugSpy.mock.calls.filter(
			call => call[0] === "agent.continue busy after scheduling; rescheduling",
		);
		expect(busyDebugs).toHaveLength(50);
		// Capped exponential backoff: 100ms base doubling up to a 5s ceiling.
		const rescheduleDelays = busyDebugs.map(call => (call[1] as { delayMs: number }).delayMs);
		expect(rescheduleDelays).toEqual([100, 200, 400, 800, 1600, 3200, ...Array(44).fill(5000)]);

		const exhaustedWarns = warnSpy.mock.calls.filter(
			call => call[0] === "agent.continue busy reschedule budget exhausted; giving up",
		);
		expect(exhaustedWarns).toHaveLength(1);
		expect(exhaustedWarns[0]?.[1]).toMatchObject({ attempts: 50 });
		// Giving up still routes through the standard failure handlers.
		expect(warnSpy.mock.calls.some(call => call[0] === "agent.continue failed after scheduling")).toBe(true);
		expect(warnSpy.mock.calls.some(call => call[0] === "Auto-compaction continuation failed")).toBe(true);
		expect(promptSpy).not.toHaveBeenCalled();
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

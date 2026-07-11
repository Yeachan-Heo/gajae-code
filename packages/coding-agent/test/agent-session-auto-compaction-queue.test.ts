import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { estimateMessageTokensHeuristic } from "@gajae-code/agent-core/compaction";
import type { AssistantMessage, ToolResultMessage } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { loadExtensions } from "@gajae-code/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@gajae-code/coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir, withTimeout } from "@gajae-code/utils";

const runtimeSignalStoreKey = "__gjcRuntimeSignals";

type RuntimeSignalGlobal = typeof globalThis & { [runtimeSignalStoreKey]?: string[] };

function getRuntimeSignals(): string[] {
	const globalWithSignals = globalThis as RuntimeSignalGlobal;
	if (!globalWithSignals[runtimeSignalStoreKey]) {
		globalWithSignals[runtimeSignalStoreKey] = [];
	}
	return globalWithSignals[runtimeSignalStoreKey];
}

/**
 * Regression test: auto-compaction completion should resume the agent loop when
 * there are queued agent-level messages (follow-up/steering/custom).
 */
describe("AgentSession auto-compaction queue resume", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let streamCallCount: number;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-auto-compaction-queue-");
		vi.useFakeTimers();

		// Provide an extension that short-circuits compaction so the test doesn't
		// make any LLM calls.
		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const extensionPath = path.join(extensionsDir, "compaction-short-circuit.ts");
		fs.writeFileSync(
			extensionPath,
			[
				"export default function(pi) {",
				'\tpi.on("session_before_compact", async (event) => {',
				`\t\tconst signals = globalThis.${runtimeSignalStoreKey} ?? (globalThis.${runtimeSignalStoreKey} = []);`,
				'\t\tsignals.push("ratio:" + (event.preparation.tokenCorrection?.ratio ?? "none"));',
				"\t\treturn {",
				"\t\t\tcompaction: {",
				'\t\t\t\tsummary: "compacted",',
				"\t\t\t\tshortSummary: undefined,",
				"\t\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,",
				"\t\t\t\ttokensBefore: event.preparation.tokensBefore,",
				"\t\t\t\tdetails: {},",
				"\t\t\t},",
				"\t\t};",
				"\t});",
				'\tpi.on("auto_compaction_start", async (event) => {',
				`\t\tconst signals = globalThis.${runtimeSignalStoreKey} ?? (globalThis.${runtimeSignalStoreKey} = []);`,
				'\t\tsignals.push("compaction:start:" + event.reason);',
				"\t});",
				'\tpi.on("auto_compaction_end", async (event) => {',
				`\t\tconst signals = globalThis.${runtimeSignalStoreKey} ?? (globalThis.${runtimeSignalStoreKey} = []);`,
				'\t\tsignals.push("compaction:end:" + (event.aborted ? "aborted" : "ok"));',
				"\t});",
				'\tpi.on("todo_reminder", async (event) => {',
				`\t\tconst signals = globalThis.${runtimeSignalStoreKey} ?? (globalThis.${runtimeSignalStoreKey} = []);`,
				'\t\tsignals.push("todo:" + event.attempt + "/" + event.maxAttempts);',
				"\t});",
				"}",
			].join("\n"),
		);

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		getRuntimeSignals().length = 0;

		const extensionsResult = await loadExtensions([extensionPath], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected built-in anthropic model to exist");
		}
		const sessionModel = { ...model, contextWindow: 200_000, maxTokens: 128_000 };
		streamCallCount = 0;

		const agent = new Agent({
			initialState: {
				model: sessionModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: () => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const message: AssistantMessage = {
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "claude-sonnet-4-5",
						stopReason: "stop",
						usage: {
							input: 100,
							output: 10,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 110,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});

		// Seed a minimal session branch so prepareCompaction() returns a preparation.
		sessionManager.appendMessage({
			role: "user",
			content: "hello",
			timestamp: Date.now(),
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.autoContinue": false,
				"todo.reminders": true,
				"todo.reminders.max": 3,
			}),
			modelRegistry,
			extensionRunner,
		});
		session.setResourceSampler(() => ({ heapUsedBytes: 0, providerBytes: 0, messageCount: 0, imageBytes: 0 }));
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.useRealTimers();
		getRuntimeSignals().length = 0;
		vi.restoreAllMocks();
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		vi.useRealTimers();

		session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "Queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		expect(session.agent.hasQueuedMessages()).toBe(true);

		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		// Wait for auto_compaction_end event to know when the async handler is done
		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		// Build a fake AssistantMessage with high token usage to trigger threshold
		// compaction (contextWindow=200000, threshold ~80%).
		const assistantMsg = {
			role: "assistant" as const,
			content: [],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 190000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		// Drive auto-compaction through the event flow:
		// message_end → stores #lastAssistantMessage
		// agent_end   → #checkCompaction → shouldCompact → #runAutoCompaction
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		// Wait for compaction completion, then verify waitForIdle blocks on queued continuation.
		await withTimeout(compactionDone, 1000, "Threshold queued compaction timed out");
		await Promise.resolve();
		const idlePromise = session.waitForIdle();
		let idleResolved = false;
		void idlePromise.then(() => {
			idleResolved = true;
		});
		await Promise.resolve();
		expect(idleResolved).toBe(false);
		await withTimeout(idlePromise, 1000, "Queued continuation did not become idle");

		expect(continueSpy).toHaveBeenCalledTimes(1);
		const runtimeSignals = getRuntimeSignals();
		expect(runtimeSignals).toContain("compaction:start:threshold");
		expect(runtimeSignals.some(signal => signal.startsWith("compaction:end:"))).toBe(true);
	});
	it("does not reserve model output capability for threshold maintenance", async () => {
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 110_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 111_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await Promise.resolve();
		await Promise.resolve();

		expect(getRuntimeSignals()).not.toContain("compaction:start:threshold");
		expect(sessionManager.getBranch().some(entry => entry.type === "compaction")).toBe(false);
	});

	it("runs pre-continue compaction before resuming queued messages", async () => {
		vi.useRealTimers();
		session.settings.set("compaction.thresholdTokens", 1000);
		session.settings.set("compaction.keepRecentTokens", 1);
		session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "Queued custom" }],
			display: false,
			timestamp: Date.now(),
		});
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const { promise: firstCompactionDone, resolve: onFirstCompactionDone } = Promise.withResolvers<void>();
		const { promise: secondCompactionDone, resolve: onSecondCompactionDone } = Promise.withResolvers<void>();
		let compactionEndCount = 0;
		session.subscribe(event => {
			if (event.type !== "auto_compaction_end") return;
			compactionEndCount++;
			if (compactionEndCount === 1) onFirstCompactionDone();
			if (compactionEndCount === 2) onSecondCompactionDone();
		});
		const assistantMsg: AssistantMessage = {
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
		};

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await withTimeout(firstCompactionDone, 1000, "Initial queued compaction timed out");
		const largeToolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "queued-large-read",
			toolName: "read",
			content: [{ type: "text", text: "x".repeat(10_000) }],
			isError: false,
			timestamp: Date.now(),
		};
		sessionManager.appendMessage(largeToolResult);
		session.agent.appendMessage(largeToolResult);
		await withTimeout(secondCompactionDone, 1000, "Pre-continue compaction timed out");
		await session.waitForIdle();

		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(getRuntimeSignals().filter(signal => signal === "compaction:start:threshold")).toHaveLength(2);
	});

	it("compacts before a new prompt when tool results push context over threshold", async () => {
		vi.useRealTimers();
		session.settings.set("compaction.thresholdTokens", 1000);
		session.settings.set("compaction.keepRecentTokens", 1);

		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Ready for tool output" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 800,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 850,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		const largeToolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "tool-large-read",
			toolName: "read",
			content: [{ type: "text", text: "x".repeat(10_000) }],
			isError: false,
			timestamp: Date.now(),
		};

		sessionManager.appendMessage(assistantMsg);
		sessionManager.appendMessage(largeToolResult);
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		await session.prompt("next prompt after large read");

		expect(streamCallCount).toBe(1);
		expect(getRuntimeSignals()).toContain("compaction:start:threshold");
		expect(sessionManager.getBranch().some(entry => entry.type === "compaction")).toBe(true);
	});

	it("compacts before agent-initiated task notifications that would overflow the next turn", async () => {
		vi.useRealTimers();
		session.settings.set("compaction.thresholdTokens", 1000);
		session.settings.set("compaction.keepRecentTokens", 1);

		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Ready for monitor notification" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 800,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 850,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		sessionManager.appendMessage(assistantMsg);
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		await session.sendCustomMessage(
			{
				customType: "task-notification",
				content: `<task-notification>\n${"x".repeat(10_000)}\n</task-notification>`,
				display: false,
				attribution: "agent",
				details: { taskId: "monitor-large-output", monitor: true },
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);

		expect(streamCallCount).toBe(1);
		expect(getRuntimeSignals()).toContain("compaction:start:threshold");
		expect(sessionManager.getBranch().some(entry => entry.type === "compaction")).toBe(true);
	});

	it("keeps display context usage on cheap heuristic estimation for custom messages", () => {
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Ready for custom context" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 110,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		const customContent = "hello ".repeat(1000);

		sessionManager.appendMessage(assistantMsg);
		sessionManager.appendCustomMessageEntry(
			"task-notification",
			customContent,
			false,
			{ taskId: "display" },
			"agent",
		);
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		const usage = session.getContextUsage();
		if (!usage) {
			throw new Error("Expected context usage to be available");
		}
		const llmCustomMessage = convertToLlm([
			{
				role: "custom",
				customType: "task-notification",
				content: customContent,
				display: false,
				attribution: "agent",
				timestamp: Date.now(),
			},
		])[0];
		if (!llmCustomMessage) {
			throw new Error("Expected custom message to convert to an LLM message");
		}

		// Anchor = total context tokens of the last successful assistant
		// (input 100 + output 10): the next request replays that assistant's
		// own output, so prompt-only anchoring would undercount it.
		expect(usage.tokens).toBe(110 + estimateMessageTokensHeuristic(llmCustomMessage));
	});

	it("skips error/aborted assistants when anchoring context estimates", () => {
		const usageOf = (input: number, output: number) => ({
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		const base = {
			role: "assistant" as const,
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			timestamp: Date.now(),
		};
		const anchored: AssistantMessage = {
			...base,
			content: [{ type: "text", text: "ok" }],
			stopReason: "stop",
			usage: usageOf(500, 40),
		};
		const aborted: AssistantMessage = {
			...base,
			content: [{ type: "text", text: "partial output ".repeat(200) }],
			stopReason: "aborted",
			usage: usageOf(9999, 0),
		};

		sessionManager.appendMessage(anchored);
		sessionManager.appendMessage(aborted);
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		const usage = session.getContextUsage();
		if (!usage) {
			throw new Error("Expected context usage to be available");
		}
		const llmAborted = convertToLlm([aborted])[0];
		if (!llmAborted) {
			throw new Error("Expected aborted message to convert to an LLM message");
		}
		// The aborted turn's partial usage must not anchor the estimate; it is
		// charged heuristically as trailing context after the last successful
		// anchor (total 540).
		expect(usage.tokens).toBe(540 + estimateMessageTokensHeuristic(llmAborted));
	});

	it("excludes the anchor assistant's own output from the token-correction denominator", async () => {
		vi.useRealTimers();
		// Keep window small so prepareCompaction actually finds a cut point.
		session.settings.set("compaction.keepRecentTokens", 1000);
		const anchor: AssistantMessage = {
			role: "assistant",
			// Large assistant output: before the fix it inflated the correction
			// denominator even though it is the anchor request's *response*, not
			// part of that request's prompt, collapsing the ratio toward the
			// 0.5 clamp and growing the kept window.
			content: [{ type: "text", text: "a".repeat(40_000) }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1500,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1600,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		sessionManager.appendMessage({ role: "user", content: "u".repeat(4000), timestamp: Date.now() });
		sessionManager.appendMessage(anchor);
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		await session.compact();

		const ratioSignal = getRuntimeSignals().find(signal => signal.startsWith("ratio:"));
		if (!ratioSignal) {
			throw new Error("Expected session_before_compact to report a correction ratio");
		}
		const ratio = Number(ratioSignal.slice("ratio:".length));
		// prompt tokens 1500 vs ~1k-token heuristic prompt prefix → ratio well
		// above 1. With the assistant's 40k-char output in the denominator the
		// raw ratio would be ~0.13 and clamp to 0.5.
		expect(ratio).toBeGreaterThan(1);
		expect(ratio).toBeLessThanOrEqual(2);
	});

	it("runs pre-prompt handoff maintenance before sending the oversized prompt", async () => {
		vi.useRealTimers();
		session.settings.set("compaction.strategy", "handoff");
		session.settings.set("compaction.thresholdTokens", 1000);

		const handoffSpy = vi.spyOn(session, "handoff").mockImplementation(async () => {
			expect(streamCallCount).toBe(0);
			return { document: "handoff document" };
		});
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Ready for tool output" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 800,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 850,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		const largeToolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "tool-large-read",
			toolName: "read",
			content: [{ type: "text", text: "x".repeat(10_000) }],
			isError: false,
			timestamp: Date.now(),
		};

		sessionManager.appendMessage(assistantMsg);
		sessionManager.appendMessage(largeToolResult);
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		await session.prompt("next prompt after large read");

		expect(handoffSpy).toHaveBeenCalledTimes(1);
		expect(streamCallCount).toBe(1);
		expect(getRuntimeSignals()).toContain("compaction:start:threshold");
	});

	it("forwards todo reminder lifecycle signals to extensions", async () => {
		vi.useRealTimers();
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		session.setTodoPhases([
			{
				name: "Execution",
				tasks: [{ content: "Finish pending task", status: "in_progress" }],
			},
		]);

		const { promise: reminderDone, resolve: onReminderDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "todo_reminder") onReminderDone();
		});

		const assistantMsg = {
			role: "assistant" as const,
			content: [],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await withTimeout(reminderDone, 1000, "Todo reminder timed out");
		await Promise.resolve();

		expect(getRuntimeSignals()).toContain("todo:1/3");
		await withTimeout(
			(async () => {
				while (continueSpy.mock.calls.length === 0) {
					await Bun.sleep(5);
				}
			})(),
			1000,
			"Todo reminder continuation did not run",
		);
		await withTimeout(session.waitForIdle(), 1000, "Todo reminder continuation did not become idle");
		expect(continueSpy).toHaveBeenCalledTimes(1);
	});
});

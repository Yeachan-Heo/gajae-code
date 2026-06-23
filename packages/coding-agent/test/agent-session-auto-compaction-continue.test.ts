import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { loadExtensions } from "@gajae-code/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@gajae-code/coding-agent/extensibility/extensions/runner";
import { AgentSession, type AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
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

	async function createSession(settings: Record<string, unknown> = {}, extensionExtra = "") {
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
		if (!model) throw new Error("Expected built-in anthropic model to exist");
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

	it("threshold default with queued message uses queued continuation only", async () => {
		session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "Queued" }],
			display: false,
			timestamp: Date.now(),
		});
		const warnSpy = vi.spyOn(logger, "warn");
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		await driveCompaction();
		await advancePostPrompt(200);
		await session.waitForIdle();
		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(promptSpy).not.toHaveBeenCalled();
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
});

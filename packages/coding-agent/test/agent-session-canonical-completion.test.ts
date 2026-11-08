import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import { type AssistantMessage, type ToolResultMessage, z } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir, withTimeout } from "@gajae-code/utils";

function assistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "terminal" }],
		api: "anthropic-messages",
		provider: "github-copilot",
		model: "claude-sonnet-4-5",
		stopReason: "error",
		errorMessage: "GitHub Copilot authentication failed",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

describe("AgentSession canonical completion", () => {
	let tempDir: TempDir | undefined;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			vi.restoreAllMocks();
			authStorage?.close();
			tempDir?.removeSync();
		}
	});

	async function setup(options?: {
		spill?: boolean;
		onAuthRemoval?: () => void;
		streamFn?: Agent["streamFn"];
		tools?: AgentTool[];
	}) {
		tempDir = TempDir.createSync("@gjc-canonical-completion-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		if (options?.onAuthRemoval) {
			vi.spyOn(authStorage, "remove").mockImplementation(async () => options.onAuthRemoval?.());
		}
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		if (options?.streamFn) authStorage.setRuntimeApiKey("anthropic", "test-key");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: options?.tools ?? [], messages: [] },
			...(options?.streamFn ? { streamFn: options.streamFn, getApiKey: () => "test-key" } : {}),
		});
		const manager = SessionManager.inMemory(tempDir.path());
		const settings = Settings.isolated({
			"tools.preAdmissionArtifactSpill": options?.spill ?? false,
			"compaction.enabled": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		return { agent, manager, session };
	}

	it("does not treat a released predecessor as the terminal assistant's failed append", async () => {
		const removed: string[] = [];
		const { agent, manager, session } = await setup({ onAuthRemoval: () => removed.push("removed") });
		const originalAppend = manager.appendMessage.bind(manager);
		vi.spyOn(manager, "appendMessage").mockImplementation(message => {
			if (message.role === "assistant") throw new Error("assistant publication failed");
			return originalAppend(message);
		});
		agent.emitExternalEvent({
			type: "message_end",
			message: { role: "user", content: "committed", timestamp: Date.now() },
		});
		const terminal = assistant();
		agent.emitExternalEvent({ type: "message_end", message: terminal });
		agent.emitExternalEvent({ type: "agent_end", messages: [terminal] });
		await withTimeout(session.awaitSessionSettlement(), 5_000, "Failed terminal admission did not settle");
		expect(removed).toEqual([]);
		expect(
			manager
				.getBranch()
				.filter(entry => entry.type === "message")
				.map(entry => entry.message.role),
		).toEqual(["user"]);
	});

	it("releases scheduling after a failed predecessor without treating the successor as failed", async () => {
		const removed: string[] = [];
		const { agent, manager, session } = await setup({ onAuthRemoval: () => removed.push("removed") });
		const originalAppend = manager.appendMessage.bind(manager);
		vi.spyOn(manager, "appendMessage").mockImplementation(message => {
			if (message.role === "user") throw new Error("predecessor publication failed");
			return originalAppend(message);
		});
		agent.emitExternalEvent({
			type: "message_end",
			message: { role: "user", content: "failed", timestamp: Date.now() },
		});
		const terminal = assistant();
		agent.emitExternalEvent({ type: "message_end", message: terminal });
		agent.emitExternalEvent({ type: "agent_end", messages: [terminal] });
		await withTimeout(session.awaitSessionSettlement(), 5_000, "Failed predecessor blocked its successor");
		expect(
			manager
				.getBranch()
				.filter(entry => entry.type === "message")
				.map(entry => entry.message.role),
		).toEqual(["assistant"]);
		expect(removed).toEqual(["removed"]);
	});

	it("joins its own pending admission, not only the already released predecessor", async () => {
		const removed: string[] = [];
		const { agent, manager, session } = await setup({ spill: true, onAuthRemoval: () => removed.push("removed") });
		const spillGate = Promise.withResolvers<void>();
		const spillEntered = Promise.withResolvers<void>();
		vi.spyOn(manager, "saveArtifact").mockImplementation(async () => {
			spillEntered.resolve();
			await spillGate.promise;
			return { uri: "artifact://1", bytes: 4, sha256: "0".repeat(64) } as never;
		});
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "held",
			toolName: "read",
			content: [{ type: "text", text: "x".repeat(40_000) }],
			isError: false,
			timestamp: Date.now(),
		};
		agent.emitExternalEvent({ type: "message_end", message: toolResult });
		const terminal = assistant();
		agent.emitExternalEvent({ type: "message_end", message: terminal });
		agent.emitExternalEvent({ type: "agent_end", messages: [terminal] });
		try {
			await withTimeout(spillEntered.promise, 5_000, "Tool-result spill did not enter before terminal admission");
			expect(removed).toEqual([]);
		} finally {
			spillGate.resolve();
		}
		await withTimeout(session.awaitSessionSettlement(), 5_000, "Terminal admission did not settle");
		expect(
			manager
				.getBranch()
				.filter(entry => entry.type === "message")
				.map(entry => entry.message.role),
		).toEqual(["toolResult", "assistant"]);
		expect(removed).toEqual(["removed"]);
	});

	it("settles an active auto-retry when its recovering assistant cannot be published", async () => {
		tempDir = TempDir.createSync("@gjc-canonical-retry-failure-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		const mock = createMockModel({
			responses: [
				{ throw: "503 service unavailable: overloaded_error retry-after-ms=5" },
				{ content: ["retry response that cannot be published"] },
			],
			handler: { content: ["later turn"] },
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const manager = SessionManager.inMemory(tempDir.path());
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		const retryStarted = Promise.withResolvers<void>();
		const retryEnds: Array<{ success: boolean; finalError?: string }> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStarted.resolve();
			if (event.type === "auto_retry_end") retryEnds.push(event);
		});
		const originalAppend = manager.appendMessage.bind(manager);
		const append = vi.spyOn(manager, "appendMessage").mockImplementation(message => {
			if (message.role === "assistant" && message.stopReason !== "error") {
				throw new Error("retry assistant publication failed");
			}
			return originalAppend(message);
		});

		const prompt = session.prompt("trigger retry");
		await withTimeout(retryStarted.promise, 5_000, "Provider failure did not start an auto-retry");
		await withTimeout(prompt, 5_000, "Failed retry admission stranded the owning prompt");
		await withTimeout(session.waitForIdle(), 5_000, "Failed retry admission stranded session idle");
		expect(
			append.mock.calls.some(([message]) => message.role === "assistant" && message.stopReason !== "error"),
		).toBe(true);
		expect(retryEnds).toContainEqual(
			expect.objectContaining({
				success: false,
				finalError: expect.stringContaining("retry assistant publication failed"),
			}),
		);
		expect(retryEnds.some(event => event.success)).toBe(false);
		expect(session.isRetrying).toBe(false);
		expect(session.isStreaming).toBe(false);
	}, 20_000);

	it("keeps retry ownership when an extension fails after a successful canonical append", async () => {
		tempDir = TempDir.createSync("@gjc-canonical-extension-failure-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		const mock = createMockModel({
			responses: [
				{ throw: "503 service unavailable: overloaded_error retry-after-ms=5" },
				{ throw: "503 service unavailable: overloaded_error retry-after-ms=5" },
				{ content: ["recovered after extension failure"] },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const manager = SessionManager.inMemory(tempDir.path());
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		let assistantDeliveries = 0;
		let secondAppendVisible = false;
		const extensionRunner = {
			emitBeforeAgentStart: async () => undefined,
			hasHandlers: () => false,
			emit: async (event: { type: string; message?: AssistantMessage }) => {
				if (event.type !== "message_end" || event.message?.role !== "assistant") return;
				if (++assistantDeliveries === 2) {
					secondAppendVisible =
						manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "assistant")
							.length === 2;
					throw new Error("extension failed after append");
				}
			},
		} as never;
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			extensionRunner,
		});
		const retryEnds: Array<{ success: boolean; finalError?: string }> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEnds.push(event);
		});
		await withTimeout(session.prompt("retry through an extension error"), 20_000, "Retry did not settle");
		await withTimeout(session.waitForIdle(), 5_000, "Retry did not become idle");
		expect(assistantDeliveries).toBe(3);
		expect(secondAppendVisible).toBe(true);
		expect(
			manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "assistant"),
		).toHaveLength(3);
		expect(retryEnds.filter(event => !event.success)).toEqual([]);
		expect(retryEnds.filter(event => event.success)).toHaveLength(1);
		expect(session.isRetrying).toBe(false);
	});

	it("holds accepted managed tools behind the emitted assistant's canonical predecessor", async () => {
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "first", name: "probe", arguments: {} }] },
				{ content: ["complete"] },
			],
		});
		let executions = 0;
		const tool: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "Probe",
			parameters: z.object({}),
			execute: async () => {
				executions++;
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		const { agent, manager, session } = await setup({ spill: true, streamFn: mock.stream, tools: [tool] });
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(manager, "saveArtifact").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return { uri: "artifact://1", bytes: 4, sha256: "0".repeat(64) } as never;
		});
		let injected = false;
		agent.subscribe(event => {
			if (injected || event.type !== "message_start" || event.message.role !== "assistant") return;
			injected = true;
			agent.emitExternalEvent({
				type: "message_end",
				message: {
					role: "toolResult",
					toolCallId: "prior",
					toolName: "probe",
					content: [{ type: "text", text: "x".repeat(40_000) }],
					isError: false,
					timestamp: Date.now(),
				},
			});
		});
		const run = session.prompt("test accepted tool");
		try {
			await withTimeout(entered.promise, 5_000, "Predecessor spill did not start");
			expect(executions).toBe(0);
			expect(mock.calls).toHaveLength(1);
		} finally {
			release.resolve();
		}
		await withTimeout(run, 5_000, "Managed run did not settle after publication");
		expect(executions).toBe(1);
		expect(mock.calls).toHaveLength(2);
	});

	it("stops a later exclusive tool and provider after the first result cannot publish", async () => {
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "first", name: "probe", arguments: {} },
						{ type: "toolCall", id: "second", name: "probe", arguments: {} },
					],
				},
			],
		});
		const dispatched: string[] = [];
		const tool: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "Probe",
			concurrency: "exclusive",
			parameters: z.object({}),
			execute: async id => {
				dispatched.push(id);
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		const { manager, session } = await setup({ streamFn: mock.stream, tools: [tool] });
		const append = manager.appendMessage.bind(manager);
		vi.spyOn(manager, "appendMessage").mockImplementation(message => {
			if (message.role === "toolResult" && message.toolCallId === "first")
				throw new Error("result publication failed");
			return append(message);
		});
		await withTimeout(session.prompt("execute"), 5_000, "Failed result stranded producer");
		await withTimeout(session.waitForIdle(), 5_000, "Failed result stranded session");
		expect(dispatched).toEqual(["first"]);
		expect(mock.calls).toHaveLength(1);
	});

	it("releases the canonical lane before a reentrant message observer publishes a successor", async () => {
		const { agent, manager, session } = await setup();
		const observed: string[][] = [];
		session.subscribe(event => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			observed.push(manager.getBranch().flatMap(entry => (entry.type === "message" ? [entry.message.role] : [])));
			agent.emitExternalEvent({
				type: "message_end",
				message: { role: "user", content: "observer follow-up", timestamp: Date.now() },
			});
		});
		const terminal = assistant();
		agent.emitExternalEvent({ type: "message_end", message: terminal });
		await withTimeout(session.awaitSessionSettlement(), 5_000, "Reentrant observer blocked canonical admission");
		expect(observed).toEqual([["assistant"]]);
		expect(
			manager
				.getBranch()
				.filter(entry => entry.type === "message")
				.map(entry => entry.message.role),
		).toEqual(["assistant", "user"]);
	});
});

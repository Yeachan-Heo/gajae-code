import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import * as compactionModule from "@gajae-code/agent-core/compaction";
import type { AssistantMessage, ToolCall } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { ExtensionRunner, loadExtensions } from "@gajae-code/coding-agent/extensibility/extensions";
import { AgentSession, type AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

describe("AgentSession handoff", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let events: AgentSessionEvent[];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-handoff-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected built-in anthropic model to exist");
		}

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
			}),
			modelRegistry,
		});

		session.subscribe(event => {
			events.push(event);
		});

		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		});
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("prepares contribution artifacts without switching the active session", async () => {
		const beforeSessionFile = session.sessionFile;
		const beforeSessionId = session.sessionId;
		const result = await session.prepareContributionPrep({ artifactRoot: path.join(tempDir.path(), "prep") });

		expect(result.manifestPath).toEndWith("manifest.json");
		expect(session.sessionFile).toBe(beforeSessionFile);
		expect(session.sessionId).toBe(beforeSessionId);
		expect(
			sessionManager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === "handoff"),
		).toHaveLength(0);
	});

	it("persists active model when starting a new session", async () => {
		const created = await session.newSession();
		expect(created).toBe(true);
		expect(sessionManager.buildSessionContext().models.default).toBe("anthropic/claude-sonnet-4-5");
	});

	it("does not run auto-compaction after handoff turn completes", async () => {
		const handoffText = "## Goal\nContinue from here";
		const generateHandoffSpy = vi.spyOn(compactionModule, "generateHandoff").mockResolvedValue(handoffText);

		const result = await session.handoff();
		await Bun.sleep(20);

		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(result?.document).toBe(handoffText);
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);
		expect(events.filter(event => event.type === "auto_compaction_end")).toHaveLength(0);
		expect(sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(0);
	});

	it("does not run auto maintenance after final yield", async () => {
		session.settings.set("compaction.strategy", "handoff");
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const yieldCall: ToolCall = {
			type: "toolCall",
			id: "call_yield_done",
			name: "yield",
			arguments: { result: { data: { done: true } } },
		};
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [yieldCall],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "toolUse",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		const handoffSpy = vi.spyOn(session, "handoff").mockResolvedValue({ document: "handoff document" });
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: yieldCall.id,
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data: { done: true } },
			},
			isError: false,
		});
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await Bun.sleep(20);

		expect(handoffSpy).not.toHaveBeenCalled();
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);
		expect(events.filter(event => event.type === "auto_compaction_end")).toHaveLength(0);
	});

	it("persists handoff session immediately with previous session as parent", async () => {
		const previousSessionFile = session.sessionFile;
		if (!previousSessionFile) {
			throw new Error("Expected previous session file");
		}

		const handoffText = "## Goal\nContinue from here";
		vi.spyOn(compactionModule, "generateHandoff").mockResolvedValue(handoffText);

		const result = await session.handoff();
		const handoffSessionFile = session.sessionFile;
		if (!handoffSessionFile) {
			throw new Error("Expected handoff session file");
		}

		type PersistedEntry = {
			type?: string;
			parentSession?: string;
			customType?: string;
			display?: boolean;
			model?: string;
		};
		const handoffEntries = (await Bun.file(handoffSessionFile).text())
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as PersistedEntry);

		expect(result?.document).toBe(handoffText);
		expect(session.getLastAssistantText()).toBeUndefined();
		expect(session.hasCopyCandidateAssistantMessage()).toBe(false);
		expect(session.getLastVisibleHandoffText()).toBe(
			`<handoff-context>\n${handoffText}\n</handoff-context>\n\nThe above is a handoff document from a previous session. Use this context to continue the work seamlessly.`,
		);
		expect(handoffSessionFile).not.toBe(previousSessionFile);
		expect(handoffEntries[0]).toMatchObject({ type: "session", parentSession: previousSessionFile });
		expect(
			handoffEntries.some(
				entry => entry.type === "custom_message" && entry.customType === "handoff" && entry.display,
			),
		).toBe(true);
		expect(
			handoffEntries.some(entry => entry.type === "model_change" && entry.model === "anthropic/claude-sonnet-4-5"),
		).toBe(true);

		const previousSessionText = await Bun.file(previousSessionFile).text();
		expect(previousSessionText).toContain('"text":"seed"');
	});

	it("does not run auto maintenance when strategy is off", async () => {
		session.settings.set("compaction.strategy", "off");
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "maintenance trigger" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		const handoffSpy = vi.spyOn(session, "handoff");
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await Bun.sleep(20);

		expect(handoffSpy).not.toHaveBeenCalled();
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);
		expect(events.filter(event => event.type === "auto_compaction_end")).toHaveLength(0);
	});

	it("restores context-full strategy when enabling auto-compaction from off strategy", () => {
		session.settings.set("compaction.enabled", true);
		session.settings.set("compaction.strategy", "off");

		expect(session.autoCompactionEnabled).toBe(false);
		session.setAutoCompactionEnabled(true);
		expect(session.settings.get("compaction.strategy")).toBe("context-full");
		expect(session.autoCompactionEnabled).toBe(true);
	});

	it("falls back to context-full maintenance for overflow when strategy is handoff", async () => {
		session.settings.set("compaction.strategy", "handoff");
		session.settings.set("contextPromotion.enabled", false);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}
		const handoffSpy = vi.spyOn(session, "handoff");

		const overflowAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "overflow" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "error",
			errorMessage: "maximum context length is 200000 tokens, however you requested 200001 tokens",
			usage: {
				input: 120_000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		session.agent.emitExternalEvent({ type: "message_end", message: overflowAssistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowAssistant] });
		await Bun.sleep(20);

		expect(handoffSpy).not.toHaveBeenCalled();
		const startEvents = events.filter(event => event.type === "auto_compaction_start");
		expect(startEvents).toHaveLength(1);
		expect(startEvents[0]).toMatchObject({ type: "auto_compaction_start", reason: "overflow" });
		const endEvents = events.filter(event => event.type === "auto_compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]).not.toMatchObject({
			errorMessage: "Auto-handoff failed: no handoff document was generated",
		});
	});

	it("uses handoff strategy for threshold-triggered auto maintenance", async () => {
		session.settings.set("compaction.strategy", "handoff");
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "maintenance trigger" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		const handoffSpy = vi.spyOn(session, "handoff").mockResolvedValue({ document: "handoff document" });

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await Bun.sleep(20);

		expect(handoffSpy).toHaveBeenCalledTimes(1);
		expect(handoffSpy).toHaveBeenCalledWith(expect.stringContaining("Threshold-triggered maintenance"), {
			autoTriggered: true,
			signal: expect.anything(),
		});
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(1);
		const endEvents = events.filter(event => event.type === "auto_compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]).toMatchObject({ type: "auto_compaction_end", aborted: false, willRetry: false });
	});

	it("completes threshold-triggered auto-handoff while the original prompt is still unwinding", async () => {
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected built-in anthropic model to exist");
		}

		await session.dispose();
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		});

		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "text", text: "maintenance trigger" }],
					stopReason: "stop",
					usage: {
						input: 190_000,
						output: 1_000,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 191_000,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			],
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.strategy": "handoff",
				"compaction.thresholdPercent": 1,
				"contextPromotion.enabled": false,
			}),
			modelRegistry,
		});
		session.subscribe(event => {
			events.push(event);
		});

		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoff")
			.mockResolvedValue("## Goal\nContinue from here");
		await session.prompt("Trigger threshold handoff");

		expect(mock.calls).toHaveLength(1);
		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		const endEvents = events.filter(event => event.type === "auto_compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]).toMatchObject({ type: "auto_compaction_end", action: "handoff", aborted: false });
		expect(endEvents[0]).not.toMatchObject({ errorMessage: expect.any(String) });
		expect(sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(0);
	});

	it("falls back to context-full when handoff strategy returns no document", async () => {
		session.settings.set("compaction.strategy", "handoff");
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "maintenance trigger" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		const handoffSpy = vi.spyOn(session, "handoff").mockResolvedValue(undefined);

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await Bun.sleep(20);

		expect(handoffSpy).toHaveBeenCalledTimes(1);
		const endEvents = events.filter(event => event.type === "auto_compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]).toMatchObject({
			type: "auto_compaction_end",
			action: "context-full",
			aborted: false,
			willRetry: false,
		});
		expect(endEvents[0]).not.toMatchObject({
			errorMessage: "Auto-handoff failed: no handoff document was generated",
		});
	});

	it("resets to the base system prompt before generating a handoff", async () => {
		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}
		await session.dispose();
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const extensionsResult = await loadExtensions([], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		const emitBeforeAgentStart = vi.spyOn(extensionRunner, "emitBeforeAgentStart").mockResolvedValueOnce({
			systemPrompt: ["Hook override"],
		});
		vi.spyOn(extensionRunner, "emit").mockResolvedValue(undefined);

		const mock = createMockModel({
			responses: [{ content: ["normal response"] }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
		});
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		});

		await session.prompt("hello from user");
		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoff")
			.mockResolvedValue("## Goal\nContinue from here");
		await session.handoff();

		expect(emitBeforeAgentStart).toHaveBeenCalledTimes(1);
		expect(mock.calls.map(c => c.context.systemPrompt?.join("\n\n") ?? "")).toEqual(["Hook override"]);
		const handoffCall = generateHandoffSpy.mock.calls[0];
		if (!handoffCall) throw new Error("Expected generateHandoff call");
		expect(handoffCall[3].systemPrompt).toEqual(["Test"]);
	});

	it("saves auto-handoff document as an artifact when enabled", async () => {
		session.settings.set("compaction.handoffSaveToDisk", true);

		const handoffText = "## Goal\nContinue from here";
		vi.spyOn(compactionModule, "generateHandoff").mockResolvedValue(handoffText);

		const result = await session.handoff(undefined, { autoTriggered: true });
		expect(result?.savedPath).toMatch(/^artifact:\/\/\d+$/);
		if (!result?.savedPath) throw new Error("Expected handoff artifact URI");
		const artifactPath = await session.sessionManager.getArtifactPath(result.savedPath.slice("artifact://".length));
		expect(artifactPath).toBeDefined();
		if (!artifactPath) throw new Error("Expected handoff artifact path");
		const savedText = await Bun.file(artifactPath).text();
		expect(savedText).toContain(handoffText);
	});

	it("does not save manual handoff document when save setting is enabled", async () => {
		session.settings.set("compaction.handoffSaveToDisk", true);

		vi.spyOn(compactionModule, "generateHandoff").mockResolvedValue("## Goal\nManual handoff");

		const result = await session.handoff();
		expect(result?.savedPath).toBeUndefined();
	});

	it("does not start handoff prompt when provided signal is already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();

		const generateHandoffSpy = vi.spyOn(compactionModule, "generateHandoff");

		await expect(session.handoff(undefined, { signal: controller.signal })).rejects.toThrow("Handoff cancelled");
		expect(generateHandoffSpy).not.toHaveBeenCalled();
	});

	it("aborts handoff generation when provided signal is cancelled", async () => {
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const cancelled = Promise.withResolvers<string>();
		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoff")
			.mockImplementation((_messages, _model, _apiKey, _options, signal) => {
				started.resolve();
				const onAbort = () => {
					const error = new Error("aborted");
					error.name = "AbortError";
					cancelled.reject(error);
				};
				if (signal?.aborted) {
					onAbort();
				} else {
					signal?.addEventListener("abort", onAbort, { once: true });
				}
				return cancelled.promise;
			});

		const handoffPromise = session.handoff(undefined, { signal: controller.signal });
		await started.promise;
		controller.abort();

		await expect(handoffPromise).rejects.toThrow("Handoff cancelled");
		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(generateHandoffSpy.mock.calls[0]?.[4]?.aborted).toBe(true);
	});

	it("refuses a manual handoff while a response is streaming and does not mutate the session", async () => {
		const generateHandoffSpy = vi.spyOn(compactionModule, "generateHandoff");
		const beforeId = session.sessionId;
		const beforeFile = session.sessionFile;
		session.agent.state.isStreaming = true;
		try {
			await expect(session.handoff()).rejects.toThrow(/stream/i);
		} finally {
			session.agent.state.isStreaming = false;
		}
		expect(generateHandoffSpy).not.toHaveBeenCalled();
		expect(session.sessionId).toBe(beforeId);
		expect(session.sessionFile).toBe(beforeFile);
	});

	it("still allows an auto-triggered handoff even if the streaming flag is set", async () => {
		vi.spyOn(compactionModule, "generateHandoff").mockResolvedValue("## Goal\nauto");
		session.agent.state.isStreaming = true;
		try {
			const result = await session.handoff(undefined, { autoTriggered: true });
			expect(result?.document).toBe("## Goal\nauto");
		} finally {
			session.agent.state.isStreaming = false;
		}
	});

	it("is non-destructive when the post-generation switch fails: session stays active and document is retained", async () => {
		const handoffText = "## Goal\nContinue from here";
		vi.spyOn(compactionModule, "generateHandoff").mockResolvedValue(handoffText);
		const beforeId = session.sessionId;
		const beforeFile = session.sessionFile;
		const beforeMessageCount = session.agent.state.messages.length;

		// Force a failure in the injection step, after the session switch has begun.
		const appendSpy = vi.spyOn(sessionManager, "appendCustomMessageEntry").mockImplementationOnce(() => {
			throw new Error("inject boom");
		});

		let caught: unknown;
		try {
			await session.handoff();
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("inject boom");
		// Generated document is preserved for copy/retry.
		expect((caught as { handoffDocument?: string }).handoffDocument).toBe(handoffText);
		// The active session is fully restored (non-destructive failure).
		expect(session.sessionId).toBe(beforeId);
		expect(session.sessionFile).toBe(beforeFile);
		expect(session.agent.state.messages.length).toBe(beforeMessageCount);
		// No handoff custom entry leaked into the restored session.
		expect(
			sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "handoff"),
		).toHaveLength(0);

		appendSpy.mockRestore();

		// A subsequent handoff succeeds normally after the recovered failure.
		const result = await session.handoff();
		expect(result?.document).toBe(handoffText);
		expect(session.sessionId).not.toBe(beforeId);
	});

	it.each([
		[
			"newSession throws before mutating (partial-switch guard)",
			() => vi.spyOn(sessionManager, "newSession").mockRejectedValueOnce(new Error("newSession boom")),
			"newSession boom",
		],
		[
			"ensureOnDisk throws after the switch (persistence failure)",
			() => vi.spyOn(sessionManager, "ensureOnDisk").mockRejectedValueOnce(new Error("ensure boom")),
			"ensure boom",
		],
		[
			"display rebuild throws after persistence (post-ensureOnDisk, orphan cleanup)",
			() =>
				vi.spyOn(session, "buildDisplaySessionContext").mockImplementationOnce(() => {
					throw new Error("display boom");
				}),
			"display boom",
		],
	])("is non-destructive when %s", async (_label, installFault, expectedMessage) => {
		const handoffText = "## Goal\nContinue from here";
		vi.spyOn(compactionModule, "generateHandoff").mockResolvedValue(handoffText);
		const beforeId = session.sessionId;
		const beforeFile = session.sessionFile;
		const beforeMessageCount = session.agent.state.messages.length;

		const faultSpy = installFault();

		let caught: unknown;
		try {
			await session.handoff();
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain(expectedMessage);
		expect((caught as { handoffDocument?: string }).handoffDocument).toBe(handoffText);
		// Active session fully restored.
		expect(session.sessionId).toBe(beforeId);
		expect(session.sessionFile).toBe(beforeFile);
		expect(session.agent.state.messages.length).toBe(beforeMessageCount);
		expect(
			sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "handoff"),
		).toHaveLength(0);

		faultSpy.mockRestore();

		// Recovery: a subsequent handoff succeeds.
		const result = await session.handoff();
		expect(result?.document).toBe(handoffText);
		expect(session.sessionId).not.toBe(beforeId);
	});
	it("retains the committed successor when a post-commit step fails (no rollback)", async () => {
		const handoffText = "## Goal\nContinue from here";
		vi.spyOn(compactionModule, "generateHandoff").mockResolvedValue(handoffText);
		const beforeId = session.sessionId;
		// clearKind("async-result") runs at the commit boundary, after `committed`
		// is set. A failure there must NOT roll back the already-committed switch.
		vi.spyOn(session.yieldQueue, "clearKind").mockImplementationOnce(() => {
			throw new Error("post-commit boom");
		});

		const result = await session.handoff();

		// Post-commit failure is retained, not rolled back: the handoff succeeded.
		expect(result?.document).toBe(handoffText);
		expect(session.sessionId).not.toBe(beforeId);
		expect(
			sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "handoff"),
		).toHaveLength(1);
	});

	it("fences background async idle delivery during a handoff transition", async () => {
		const unregister = session.yieldQueue.register("handoff-fence-test", {
			build: survivors => ({
				role: "user" as const,
				content: [{ type: "text" as const, text: `entries:${survivors.length}` }],
				timestamp: Date.now(),
			}),
		});
		const promptSpy = vi.spyOn(session.agent, "prompt");
		const gate = Promise.withResolvers<void>();
		vi.spyOn(compactionModule, "generateHandoff").mockImplementation(async () => {
			await gate.promise;
			return "## Goal\nContinue";
		});

		const handoffPromise = session.handoff();
		await Bun.sleep(5); // let handoff engage the delivery fence and enter generation

		// A background completion lands mid-handoff. The session is not streaming, so
		// without the fence this would schedule an idle flush that calls agent.prompt.
		session.yieldQueue.enqueue("handoff-fence-test", { done: true });
		await Bun.sleep(30);
		expect(promptSpy).not.toHaveBeenCalled();

		gate.resolve();
		await handoffPromise;
		// The fenced predecessor delivery was dropped at commit, never delivered.
		expect(promptSpy).not.toHaveBeenCalled();
		unregister();
	});
	it("rejects a concurrent handoff while one is in progress (single-flight)", async () => {
		const gate = Promise.withResolvers<void>();
		vi.spyOn(compactionModule, "generateHandoff").mockImplementation(async () => {
			await gate.promise;
			return "## Goal\nContinue";
		});
		const first = session.handoff();
		await Bun.sleep(5); // let the first handoff engage the transition

		await expect(session.handoff()).rejects.toThrow(/already in progress/i);

		gate.resolve();
		await first;
	});

	it("rejects an external prompt turn while a handoff is in progress", async () => {
		const gate = Promise.withResolvers<void>();
		vi.spyOn(compactionModule, "generateHandoff").mockImplementation(async () => {
			await gate.promise;
			return "## Goal\nContinue";
		});
		const handoffPromise = session.handoff();
		await Bun.sleep(5);

		// The admission barrier fences external turns for the whole transition.
		await expect(session.prompt("hello during handoff")).rejects.toThrow(/handoff is in progress/i);

		gate.resolve();
		await handoffPromise;
	});

	it("rejects steer/follow-up turn starters while a handoff is in progress", async () => {
		const gate = Promise.withResolvers<void>();
		vi.spyOn(compactionModule, "generateHandoff").mockImplementation(async () => {
			await gate.promise;
			return "## Goal\nContinue";
		});
		const handoffPromise = session.handoff();
		await Bun.sleep(5);

		// The bypass turn-start paths (steer/follow-up/sendUserMessage) are fenced too.
		await expect(session.steer("steer during handoff")).rejects.toThrow(/handoff is in progress/i);
		await expect(session.followUp("follow-up during handoff")).rejects.toThrow(/handoff is in progress/i);
		await expect(session.sendUserMessage("msg", { deliverAs: "followUp" })).rejects.toThrow(
			/handoff is in progress/i,
		);

		gate.resolve();
		await handoffPromise;
	});

	it("retains the generated document when a turn starts during generation (late busy)", async () => {
		const handoffText = "## Goal\nGenerated before the late race";
		vi.spyOn(compactionModule, "generateHandoff").mockImplementation(async () => {
			// A turn begins after generation started but before the switch.
			session.agent.state.isStreaming = true;
			return handoffText;
		});

		let caught: unknown;
		try {
			await session.handoff();
		} catch (error) {
			caught = error;
		} finally {
			session.agent.state.isStreaming = false;
		}

		expect(caught).toBeInstanceOf(Error);
		expect((caught as { code?: string }).code).toBe("busy");
		// The generated document is retained on the late-busy rejection for copy/retry.
		expect((caught as { handoffDocument?: string }).handoffDocument).toBe(handoffText);
		// Non-destructive: the current session is unchanged.
		expect(
			sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "handoff"),
		).toHaveLength(0);
	});

	it("releases the turn fence on the committed successor (no over-fencing after handoff)", async () => {
		vi.spyOn(compactionModule, "generateHandoff").mockResolvedValue("## Goal\nContinue");
		const result = await session.handoff();
		expect(result?.document).toBeDefined();

		// The transition fence is released at commit (before session_switch), so a
		// turn starter on the committed successor is NOT rejected as "handoff in
		// progress". (#queueFollowUp resolves after enqueue; the continuation runs
		// detached.)
		let rejection: unknown;
		try {
			await session.followUp("after handoff");
		} catch (error) {
			rejection = error;
		}
		expect(String((rejection as Error | undefined)?.message ?? "")).not.toMatch(/handoff is in progress/i);
	});

	it("owns the shared transition lease and rejects every other identity transition (handoff → others)", async () => {
		const gate = Promise.withResolvers<void>();
		vi.spyOn(compactionModule, "generateHandoff").mockImplementation(async () => {
			await gate.promise;
			return "## Goal\nContinue";
		});
		const handoffPromise = session.handoff();
		await Bun.sleep(5); // let handoff acquire the shared session-transition lease

		// Every session-identity transition acquires the same lease at its entry, so
		// each is rejected as "busy" while the handoff owns it. This proves the lease
		// is shared (not a handoff-only guard) and covers the newly-wrapped fork /
		// clearContext / navigateTree paths alongside compact / new / switch / branch.
		const attempts: Array<[string, () => Promise<unknown>]> = [
			["compact", () => session.compact()],
			["newSession", () => session.newSession()],
			["switchSession", () => session.switchSession(path.join(tempDir.path(), "other.session"))],
			["branch", () => session.branch("missing-entry")],
			["clearContext", () => session.clearContext()],
			["fork", () => session.fork()],
			["navigateTree", () => session.navigateTree("missing-target")],
		];
		for (const [name, run] of attempts) {
			let caught: unknown;
			try {
				await run();
			} catch (error) {
				caught = error;
			}
			expect(caught, `${name} should reject while a handoff owns the lease`).toBeInstanceOf(Error);
			expect((caught as { code?: string }).code).toBe("busy");
			expect(String((caught as Error).message)).toMatch(/while a handoff transition is in progress/i);
		}

		// No competing transition mutated the session: still no successor/handoff entry.
		expect(
			sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "handoff"),
		).toHaveLength(0);

		gate.resolve();
		await handoffPromise;
	});

	it("rejects a handoff before mutation while a non-handoff transition owns the lease (compact → handoff)", async () => {
		session.settings.set("compaction.keepRecentTokens", 1);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "large response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 4000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 4100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		sessionManager.appendMessage({ role: "user", content: "u".repeat(8000), timestamp: Date.now() });
		sessionManager.appendMessage(assistant);
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		const branch = sessionManager.getBranch();
		const firstKeptEntryId = branch[branch.length - 1]!.id;
		const gate = Promise.withResolvers<void>();
		// Deferred compaction call: compact() has already acquired the shared lease and
		// awaits here, so the lease is held deterministically without any timing race.
		vi.spyOn(compactionModule, "compact").mockImplementation(async () => {
			await gate.promise;
			return {
				summary: "compacted",
				shortSummary: "short",
				firstKeptEntryId,
				tokensBefore: 4100,
				details: {},
			};
		});

		const compactPromise = session.compact();
		await Bun.sleep(5); // compact acquires the lease, then suspends on the deferred call

		let caught: unknown;
		try {
			await session.handoff();
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as { code?: string }).code).toBe("busy");
		expect(String((caught as Error).message)).toMatch(/while a compact transition is in progress/i);
		// Reverse-direction symmetry: handoff is rejected at its own lease acquisition,
		// before any session mutation — no compaction entry was appended yet.
		expect(sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(0);

		gate.resolve();
		await compactPromise.catch(() => {});
	});
});

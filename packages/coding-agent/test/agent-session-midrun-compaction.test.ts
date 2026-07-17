import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentEvent, type AgentTool, type StreamFn } from "@gajae-code/agent-core";

import type { AssistantMessage, Model, StopReason } from "@gajae-code/ai";

import { getBundledModel } from "@gajae-code/ai/models";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { loadExtensions } from "@gajae-code/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@gajae-code/coding-agent/extensibility/extensions/runner";
import type { AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { getLatestCompactionEntry, SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";

/**
 * Reproduction for issue #2035: threshold auto-compaction used to run only at
 * `agent_end` and before a user prompt, so a single uninterrupted tool loop grew
 * straight through the compaction margin and died with provider
 * `context_length_exceeded`. The cooperative mid-run maintenance checkpoint now
 * bounds that run in place before the next model call.
 */
describe("AgentSession mid-run compaction (issue #2035)", () => {
	const THRESHOLD = 100_000;
	let tempDir: TempDir;
	let session: AgentSession;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let sessionManager: SessionManager;
	let streamCallCount: number;
	let responder: (call: number) => AssistantMessage;
	let events: AgentSessionEvent[];
	let toolExecutionGate: Promise<void> | undefined;
	let onToolExecutionStart: (() => void) | undefined;

	const model = { ...getBundledModel("anthropic", "claude-sonnet-4-5")!, contextWindow: 200_000, maxTokens: 32_768 };

	function assistant(opts: {
		content: AssistantMessage["content"];
		totalTokens: number;
		stopReason: StopReason;
		errorMessage?: string;
	}): AssistantMessage {
		return {
			role: "assistant",
			content: opts.content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: opts.totalTokens,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: opts.totalTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: opts.stopReason,
			errorMessage: opts.errorMessage,
			timestamp: Date.now() + streamCallCount,
		};
	}

	function toolCallTurn(totalTokens: number): AssistantMessage {
		return assistant({
			content: [{ type: "toolCall", id: `call-${streamCallCount}`, name: "noop", arguments: {} }],
			totalTokens,
			stopReason: "toolUse",
		});
	}

	async function waitFor(predicate: () => boolean): Promise<void> {
		const deadline = Date.now() + 1_000;
		while (!predicate()) {
			if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
			await Bun.sleep(1);
		}
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-midrun-compaction-");
		streamCallCount = 0;
		events = [];
		toolExecutionGate = undefined;
		onToolExecutionStart = undefined;
		responder = () =>
			assistant({ content: [{ type: "text", text: "done" }], totalTokens: 5_000, stopReason: "stop" });

		// Extension short-circuits compaction so no LLM call is made for it.
		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const extensionPath = path.join(extensionsDir, "compaction-short-circuit.ts");
		fs.writeFileSync(
			extensionPath,
			[
				"export default function(pi) {",
				'\tpi.on("session_before_compact", async (event) => ({',
				"\t\tcompaction: {",
				'\t\t\tsummary: "compacted summary",',
				"\t\t\tshortSummary: undefined,",
				"\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,",
				"\t\t\ttokensBefore: event.preparation.tokensBefore,",
				"\t\t\tdetails: {},",
				"\t\t},",
				"\t}));",
				"}",
			].join("\n"),
		);

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const loaded = await loadExtensions([extensionPath], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);

		const noopTool: AgentTool = {
			name: "noop",
			label: "Noop",
			description: "Mock no-op tool",
			parameters: z.object({}),
			execute: async () => {
				onToolExecutionStart?.();
				await toolExecutionGate;
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		};

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [noopTool], messages: [] },
			convertToLlm,
			streamFn: () => {
				const call = ++streamCallCount;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const message = responder(call);
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: message.stopReason as never, message });
				});
				return stream;
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.strategy": "context-full",
			"compaction.thresholdTokens": THRESHOLD,
			"compaction.keepRecentTokens": 10,
			"compaction.autoContinue": true,
			"contextPromotion.enabled": false,
		});
		settings.setModelRole("default", "anthropic/claude-sonnet-4-5");
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });
		session.setResourceSampler(() => ({ heapUsedBytes: 0, providerBytes: 0, messageCount: 0, imageBytes: 0 }));
		session.subscribe(event => events.push(event));
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	/** Seed a few small prior turns so prepareCompaction has content to summarize. */
	async function preseed(): Promise<void> {
		for (let i = 0; i < 3; i++) {
			session.agent.emitExternalEvent({
				type: "message_end",
				message: {
					role: "user",
					content: `earlier request ${i} with a bit of context`,
					timestamp: Date.now(),
				} as never,
			});
			session.agent.emitExternalEvent({
				type: "message_end",
				message: assistant({
					content: [{ type: "text", text: `earlier reply ${i}` }],
					totalTokens: 2_000,
					stopReason: "stop",
				}),
			});
		}
		await Bun.sleep(10);
	}

	function compactionReasons(): string[] {
		return events
			.filter(
				(e): e is Extract<AgentSessionEvent, { type: "auto_compaction_start" }> =>
					e.type === "auto_compaction_start",
			)
			.map(e => e.reason);
	}

	function assistantTurns(): AssistantMessage[] {
		return session.messages.filter((m): m is AssistantMessage => m.role === "assistant");
	}

	function assistantFor(
		selectedModel: Model,
		opts: {
			content: AssistantMessage["content"];
			totalTokens: number;
			stopReason: StopReason;
			errorMessage?: string;
		},
	): AssistantMessage {
		return {
			role: "assistant",
			content: opts.content,
			api: selectedModel.api,
			provider: selectedModel.provider,
			model: selectedModel.id,
			usage: {
				input: opts.totalTokens,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: opts.totalTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: opts.stopReason,
			errorMessage: opts.errorMessage,
			timestamp: Date.now(),
		};
	}

	async function buildLoopSession(options: {
		model?: Model;
		settings?: Record<string, unknown>;
		responder: (call: number) => AssistantMessage;
		toolResultText?: string;
		extensionSource?: string;
		partialForStream?: (message: AssistantMessage) => AssistantMessage;

		afterStreamStart?: (options: Parameters<StreamFn>[2]) => Promise<void>;
	}): Promise<{
		session: AgentSession;
		events: AgentSessionEvent[];
		agentEvents: AgentEvent[];
		streamCallCount: () => number;
	}> {
		const selectedModel = options.model ?? model;
		const loopSessionManager = SessionManager.inMemory();
		let extensionRunner: ExtensionRunner | undefined;
		if (options.extensionSource) {
			const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
			fs.mkdirSync(extensionsDir, { recursive: true });
			const extensionPath = path.join(extensionsDir, `midrun-loop-${Date.now()}-${Math.random()}.ts`);
			fs.writeFileSync(extensionPath, options.extensionSource);
			const loaded = await loadExtensions([extensionPath], tempDir.path());
			extensionRunner = new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				tempDir.path(),
				loopSessionManager,
				modelRegistry,
			);
		}
		const noopTool: AgentTool = {
			name: "noop",
			label: "Noop",
			description: "Mock no-op tool",
			parameters: z.object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: options.toolResultText ?? "ok" }] }),
		};
		let calls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: selectedModel, systemPrompt: ["Test"], tools: [noopTool], messages: [] },
			convertToLlm,
			cursorOnToolResult: async message => message,
			streamFn: (_selectedModel, _context, streamOptions) => {
				const call = ++calls;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					void (async () => {
						const message = options.responder(call);
						const partial = options.partialForStream?.(message) ?? message;
						stream.push({ type: "start", partial });
						await options.afterStreamStart?.(streamOptions);
						stream.push({ type: "done", reason: message.stopReason as never, message });
					})();
				});
				return stream;
			},
		});
		const loopSettings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.strategy": "context-full",
			"compaction.thresholdTokens": THRESHOLD,
			"compaction.keepRecentTokens": 10,
			"compaction.autoContinue": true,
			"contextPromotion.enabled": false,
			...options.settings,
		});
		loopSettings.setModelRole("default", `${selectedModel.provider}/${selectedModel.id}`);
		const loopSession = new AgentSession({
			agent,
			sessionManager: loopSessionManager,
			settings: loopSettings,
			modelRegistry,
			extensionRunner,
		});
		loopSession.setResourceSampler(() => ({ heapUsedBytes: 0, providerBytes: 0, messageCount: 0, imageBytes: 0 }));
		const loopEvents: AgentSessionEvent[] = [];
		const loopAgentEvents: AgentEvent[] = [];
		loopSession.subscribe(event => loopEvents.push(event));
		loopSession.agent.subscribe(event => loopAgentEvents.push(event));
		return {
			session: loopSession,
			events: loopEvents,
			agentEvents: loopAgentEvents,
			streamCallCount: () => calls,
		};
	}

	async function seedLoop(session: AgentSession, messages: readonly unknown[]): Promise<void> {
		for (const message of messages) {
			session.agent.emitExternalEvent({ type: "message_end", message: message as never });
		}
		await Bun.sleep(10);
	}

	async function seedCompactableLoop(session: AgentSession, selectedModel: Model = model): Promise<void> {
		await seedLoop(
			session,
			Array.from({ length: 3 }, (_, index) => [
				{ role: "user", content: `earlier request ${index}`, timestamp: Date.now() },
				assistantFor(selectedModel, {
					content: [{ type: "text", text: `earlier response ${index}` }],
					totalTokens: 1_000,
					stopReason: "stop",
				}),
			]).flat(),
		);
	}

	function shortCircuitExtensionSource(): string {
		return [
			"export default function(pi) {",
			'\tpi.on("session_before_compact", async (event) => ({',
			"\t\tcompaction: {",
			'\t\t\tsummary: "compacted summary",',
			"\t\t\tshortSummary: undefined,",
			"\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,",
			"\t\t\ttokensBefore: event.preparation.tokensBefore,",
			"\t\t\tdetails: {},",
			"\t\t},",
			"\t}));",
			"}",
		].join("\n");
	}

	function gatedShortCircuitExtensionSource(): string {
		return [
			"export default function(pi) {",
			'\tpi.on("session_before_compact", async (event) => {',
			"\t\tconst gate = globalThis.__midrunE2ECompactionGate;",
			'\t\tif (gate) await Promise.race([gate, new Promise(resolve => event.signal.addEventListener("abort", resolve, { once: true }))]);',
			"\t\treturn {",
			"\t\t\tcompaction: {",
			'\t\t\t\tsummary: "compacted summary",',
			"\t\t\t\tshortSummary: undefined,",
			"\t\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,",
			"\t\t\t\ttokensBefore: event.preparation.tokensBefore,",
			"\t\t\t\tdetails: {},",
			"\t\t\t},",
			"\t\t};",
			"\t});",
			"}",
		].join("\n");
	}

	it("runs threshold maintenance mid-loop and resumes without a provider overflow", async () => {
		await preseed();
		// First model call crosses the threshold while still calling tools; later
		// calls stop. Without mid-run maintenance the loop would keep growing.
		responder = call =>
			call === 1
				? toolCallTurn(THRESHOLD + 80_000)
				: assistant({ content: [{ type: "text", text: "done" }], totalTokens: 5_000, stopReason: "stop" });

		await session.prompt("go");
		await session.waitForIdle();

		// Mid-run maintenance fired (threshold reason) and a fresh compaction landed.
		expect(compactionReasons()).toContain("threshold");
		expect(getLatestCompactionEntry(session.sessionManager.getBranch())).not.toBeNull();
		// The loop was interrupted for maintenance and resumed for exactly one more
		// model call — no provider overflow, no synthetic auto-continue prompt.
		expect(streamCallCount).toBe(2);
		expect(assistantTurns().some(m => m.stopReason === "error")).toBe(false);
		expect(
			session.messages.some(m =>
				JSON.stringify((m as { content?: unknown }).content ?? "").includes(
					"Resume work on the user's most recent intent",
				),
			),
		).toBe(false);
	});

	it("without the maintenance hook, a long tool loop grows past the threshold into provider overflow", async () => {
		await preseed();
		// Disable the cooperative checkpoint to reproduce the original gap.
		session.agent.setMaintainContext(undefined);
		responder = call => {
			if (call === 1) return toolCallTurn(THRESHOLD + 80_000);
			if (call === 2) return toolCallTurn(THRESHOLD + 150_000);
			if (call === 3)
				return assistant({
					content: [{ type: "text", text: "" }],
					totalTokens: 0,
					stopReason: "error",
					errorMessage: "context_length_exceeded: Your input exceeds the context window of this model.",
				});
			return assistant({ content: [{ type: "text", text: "recovered" }], totalTokens: 4_000, stopReason: "stop" });
		};

		await session.prompt("go");
		await session.waitForIdle();

		// The loop grew across multiple past-threshold tool turns with NO mid-run
		// threshold maintenance; overflow was only handled reactively afterward.
		const overThresholdToolTurns = assistantTurns().filter(
			m => m.stopReason === "toolUse" && (m.usage?.totalTokens ?? 0) > THRESHOLD,
		);
		expect(overThresholdToolTurns.length).toBeGreaterThanOrEqual(2);
		expect(streamCallCount).toBeGreaterThanOrEqual(3);
		// No proactive mid-run threshold maintenance ran: the first compaction was
		// the reactive overflow recovery, which is only reachable once the provider
		// rejected the request with context_length_exceeded. A pre-prompt "threshold"
		// pass may follow, but never precedes the overflow.
		expect(compactionReasons()[0]).toBe("overflow");
	});
	it("T2 drains paired tool results and two steering messages before the single maintenance continuation", async () => {
		await preseed();
		responder = call =>
			call === 1
				? toolCallTurn(THRESHOLD + 80_000)
				: assistant({ content: [{ type: "text", text: "done" }], totalTokens: 5_000, stopReason: "stop" });
		const toolGate = Promise.withResolvers<void>();
		const toolStarted = Promise.withResolvers<void>();
		toolExecutionGate = toolGate.promise;
		onToolExecutionStart = toolStarted.resolve;
		const agentEvents: AgentEvent[] = [];
		const unsubscribe = session.agent.subscribe(event => agentEvents.push(event));
		try {
			const run = session.prompt("go");
			await toolStarted.promise;
			await session.steer("first distinct steering");
			await session.steer("second distinct steering");
			toolGate.resolve();
			await run;
			await session.waitForIdle();
		} finally {
			unsubscribe();
			toolExecutionGate = undefined;
			onToolExecutionStart = undefined;
		}

		const branchMessages = session.sessionManager
			.getBranch()
			.flatMap(entry =>
				entry.type === "message"
					? [entry.message as { role?: string; toolCallId?: string; content?: unknown }]
					: [],
			);
		expect(branchMessages.filter(message => message.toolCallId === "call-1")).toHaveLength(1);
		expect(
			branchMessages.filter(
				message => message.role === "user" && JSON.stringify(message.content).includes("first distinct steering"),
			),
		).toHaveLength(1);
		expect(
			branchMessages.filter(
				message => message.role === "user" && JSON.stringify(message.content).includes("second distinct steering"),
			),
		).toHaveLength(1);
		expect(
			agentEvents.filter(event => event.type === "agent_end" && event.stopReason === "maintenance"),
		).toHaveLength(1);
		expect(events.filter(event => event.type === "agent_end" && event.stopReason === "maintenance")).toHaveLength(0);
		expect(getLatestCompactionEntry(session.sessionManager.getBranch())).not.toBeNull();
		expect(streamCallCount).toBe(2);
	});
	it("T2 completes the real pruned lifecycle without entering compaction", async () => {
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		const codex = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!codex) throw new Error("Expected bundled Codex model");
		const loop = await buildLoopSession({
			model: codex,
			responder: call =>
				call === 1
					? assistantFor(codex, {
							content: [{ type: "toolCall", id: "pruned-lifecycle-call", name: "noop", arguments: {} }],
							totalTokens: THRESHOLD + 1,
							stopReason: "toolUse",
						})
					: assistantFor(codex, {
							content: [{ type: "text", text: "pruned completion" }],
							totalTokens: 5_000,
							stopReason: "stop",
						}),
		});
		let closed = 0;
		loop.session.providerSessionState.set("openai-codex-responses", { close: () => closed++ });
		try {
			await seedLoop(loop.session, [
				{ role: "user", content: "old request", timestamp: Date.now() },
				...Array.from({ length: 3 }, (_, index) => ({
					role: "toolResult",
					toolCallId: `old-prunable-${index}`,
					toolName: "bash",
					content: [{ type: "text", text: "x".repeat(120_000) }],
					timestamp: Date.now(),
				})),
			]);
			await loop.session.prompt("go", { skipCompactionCheck: true });
			await loop.session.waitForIdle();

			expect(
				loop.agentEvents.filter(
					event =>
						event.type === "agent_end" &&
						event.stopReason === "maintenance" &&
						event.maintenanceOutcome === "pruned",
				),
			).toHaveLength(1);
			expect(
				loop.events.filter(event => event.type === "agent_end" && event.stopReason === "maintenance"),
			).toHaveLength(0);
			expect(loop.events.filter(event => event.type === "agent_end")).toHaveLength(1);
			expect(loop.events.some(event => event.type === "auto_compaction_start")).toBe(false);
			expect(getLatestCompactionEntry(loop.session.sessionManager.getBranch())).toBeNull();
			expect(closed).toBe(1);
			expect(loop.streamCallCount()).toBe(2);
		} finally {
			await loop.session.dispose();
		}
	});
	it("T3 exercises the Cursor split path without retaining the original usage anchor", async () => {
		let originalAnchor: AssistantMessage | undefined;
		let bufferedCursorResult = false;
		const cursorStart = Promise.withResolvers<void>();

		const loop = await buildLoopSession({
			extensionSource: shortCircuitExtensionSource(),
			responder: call => {
				if (call === 1) {
					originalAnchor = assistantFor(model, {
						content: [
							{ type: "text", text: "Cursor preamble and continuation" },
							{ type: "toolCall", id: "cursor-call", name: "noop", arguments: {} },
						],
						totalTokens: THRESHOLD + 80_000,
						stopReason: "toolUse",
					});
					return originalAnchor;
				}
				return assistantFor(model, {
					content: [{ type: "text", text: "done" }],
					totalTokens: 5_000,
					stopReason: "stop",
				});
			},
			partialForStream: message => ({
				...message,
				content: [
					{ type: "text", text: "Cursor preamble" },
					{ type: "toolCall", id: "cursor-call", name: "noop", arguments: {} },
				],
			}),
			afterStreamStart: async streamOptions => {
				if (bufferedCursorResult) return;
				bufferedCursorResult = true;
				await cursorStart.promise;

				await streamOptions?.cursorOnToolResult?.({
					role: "toolResult",
					toolCallId: "cursor-server-result",
					toolName: "noop",
					content: [{ type: "text", text: "Cursor server-side result" }],
					isError: false,
					timestamp: Date.now(),
				});
			},
		});
		const unsubscribeCursorStart = loop.session.agent.subscribe(event => {
			if (event.type === "message_start" && event.message.role === "assistant") cursorStart.resolve();
		});

		try {
			await seedLoop(loop.session, [
				{ role: "user", content: "earlier request", timestamp: Date.now() },
				assistantFor(model, {
					content: [{ type: "text", text: "earlier response" }],
					totalTokens: 1_000,
					stopReason: "stop",
				}),
			]);
			await loop.session.prompt("go");
			await loop.session.waitForIdle();

			expect(originalAnchor).toBeDefined();
			expect(loop.session.messages.includes(originalAnchor!)).toBe(false);
			expect(
				loop.agentEvents.filter(event => event.type === "agent_end" && event.stopReason === "maintenance"),
			).toHaveLength(1);
			expect(loop.streamCallCount()).toBe(2);
		} finally {
			unsubscribeCursorStart();
			await loop.session.dispose();
		}
	});

	it("keeps a maintenance agent_end private during a zero-inflight idle-steer continuation", async () => {
		const loop = await buildLoopSession({
			extensionSource: shortCircuitExtensionSource(),
			responder: call => {
				if (call === 1 || call === 3) {
					return assistantFor(model, {
						content: [{ type: "text", text: "done" }],
						totalTokens: 5_000,
						stopReason: "stop",
					});
				}
				return assistantFor(model, {
					content: [{ type: "toolCall", id: "idle-steer-call", name: "noop", arguments: {} }],
					totalTokens: THRESHOLD + 80_000,
					stopReason: "toolUse",
				});
			},
		});
		try {
			await loop.session.prompt("initial");
			await loop.session.waitForIdle();
			loop.events.length = 0;
			loop.agentEvents.length = 0;

			await loop.session.steer("idle continuation");
			await loop.session.waitForIdle();

			expect(
				loop.agentEvents.filter(event => event.type === "agent_end" && event.stopReason === "maintenance"),
			).toHaveLength(1);
			expect(
				loop.events.filter(event => event.type === "agent_end" && event.stopReason === "maintenance"),
			).toHaveLength(0);
			expect(loop.events.filter(event => event.type === "agent_end")).toHaveLength(1);
			expect(loop.streamCallCount()).toBe(3);
		} finally {
			await loop.session.dispose();
		}
	});
	it("publishes an aborted maintenance settlement when no prompt is in flight", async () => {
		const loop = await buildLoopSession({
			responder: () =>
				assistantFor(model, { content: [{ type: "text", text: "unused" }], totalTokens: 1, stopReason: "stop" }),
		});
		try {
			loop.session.agent.emitExternalEvent({
				type: "agent_end",
				messages: [],
				stopReason: "maintenance",
				maintenanceOutcome: "aborted",
			});
			await Bun.sleep(0);
			expect(
				loop.events.filter(
					event =>
						event.type === "agent_end" &&
						event.stopReason === "maintenance" &&
						event.maintenanceOutcome === "aborted",
				),
			).toHaveLength(1);
		} finally {
			await loop.session.dispose();
		}
	});

	it("does not continue when a later raw agent subscriber aborts a maintenance checkpoint", async () => {
		const loop = await buildLoopSession({
			extensionSource: shortCircuitExtensionSource(),
			responder: call =>
				call === 1
					? assistantFor(model, {
							content: [{ type: "toolCall", id: "raw-subscriber-cancel-call", name: "noop", arguments: {} }],
							totalTokens: THRESHOLD + 80_000,
							stopReason: "toolUse",
						})
					: assistantFor(model, {
							content: [{ type: "text", text: "late continuation" }],
							totalTokens: 5_000,
							stopReason: "stop",
						}),
		});
		const unsubscribe = loop.session.agent.subscribe(event => {
			if (event.type === "agent_end" && event.stopReason === "maintenance") void loop.session.abort();
		});
		try {
			await seedCompactableLoop(loop.session);
			await loop.session.prompt("go");
			await loop.session.waitForIdle();
			expect(loop.streamCallCount()).toBe(1);
		} finally {
			unsubscribe();
			await loop.session.dispose();
		}
	});
	it("T4 abort, dispose, and disconnect the real loop without a late model call", async () => {
		for (const operation of ["abort", "dispose", "disconnect"] as const) {
			const gate = Promise.withResolvers<void>();
			(globalThis as { __midrunE2ECompactionGate?: Promise<void> }).__midrunE2ECompactionGate = gate.promise;
			const compactionStarted = Promise.withResolvers<void>();
			const loop = await buildLoopSession({
				extensionSource: gatedShortCircuitExtensionSource(),
				responder: call =>
					call === 1
						? assistantFor(model, {
								content: [{ type: "toolCall", id: `${operation}-race-call`, name: "noop", arguments: {} }],
								totalTokens: THRESHOLD + 80_000,
								stopReason: "toolUse",
							})
						: assistantFor(model, {
								content: [{ type: "text", text: "late continuation" }],
								totalTokens: 5_000,
								stopReason: "stop",
							}),
			});
			const unsubscribe = loop.session.subscribe(event => {
				if (event.type === "auto_compaction_start") compactionStarted.resolve();
			});
			try {
				await seedCompactableLoop(loop.session);
				const prompt = loop.session.prompt("go");
				await compactionStarted.promise;
				expect(loop.session.activeMidRunBarrierCountForTests).toBe(1);

				if (operation === "abort") await loop.session.abort();
				else if (operation === "dispose") await loop.session.dispose();
				else await loop.session.newSession();

				expect(loop.session.activeMidRunBarrierCountForTests).toBe(0);
				expect(getLatestCompactionEntry(loop.session.sessionManager.getBranch())).toBeNull();
				gate.resolve();
				await prompt;
				await Bun.sleep(10);
				expect(loop.streamCallCount()).toBe(1);
				expect(
					loop.agentEvents.filter(
						event =>
							event.type === "agent_end" &&
							event.stopReason === "maintenance" &&
							event.maintenanceOutcome === "aborted",
					),
				).toHaveLength(1);
			} finally {
				unsubscribe();
				gate.resolve();
				(globalThis as { __midrunE2ECompactionGate?: Promise<void> }).__midrunE2ECompactionGate = undefined;
				if (operation !== "dispose") await loop.session.dispose();
			}
		}
	});

	it("T4 joins held prune maintenance for dispose and disconnect before teardown", async () => {
		for (const operation of ["dispose", "disconnect"] as const) {
			authStorage.setRuntimeApiKey("openai-codex", "test-key");
			const codex = modelRegistry.find("openai-codex", "gpt-5.5");
			if (!codex) throw new Error("Expected bundled Codex model");
			let closed = 0;
			const loop = await buildLoopSession({
				model: codex,
				responder: call =>
					call === 1
						? assistantFor(codex, {
								content: [{ type: "toolCall", id: `${operation}-prune-call`, name: "noop", arguments: {} }],
								totalTokens: THRESHOLD + 80_000,
								stopReason: "toolUse",
							})
						: assistantFor(codex, {
								content: [{ type: "text", text: "late continuation" }],
								totalTokens: 5_000,
								stopReason: "stop",
							}),
			});
			loop.session.providerSessionState.set("openai-codex-responses", { close: () => closed++ });
			const rewriteGate = Promise.withResolvers<void>();
			const rewriteEntered = Promise.withResolvers<void>();
			const manager = loop.session.sessionManager as unknown as { rewriteEntries: () => Promise<void> };
			const originalRewriteEntries = manager.rewriteEntries.bind(manager);
			manager.rewriteEntries = async () => {
				rewriteEntered.resolve();
				await rewriteGate.promise;
				await originalRewriteEntries();
			};
			try {
				// Five 30k-token outputs leave 90k pruneable after the 40k protection
				// window, enough to avert the 100k threshold from the 180k usage anchor.
				await seedLoop(loop.session, [
					{ role: "user", content: "old request", timestamp: Date.now() },
					...Array.from({ length: 5 }, (_, index) => ({
						role: "toolResult",
						toolCallId: `${operation}-prunable-${index}`,
						toolName: "bash",
						content: [{ type: "text", text: "x".repeat(120_000) }],
						timestamp: Date.now(),
					})),
				]);
				const prompt = loop.session.prompt("go", { skipCompactionCheck: true });
				await rewriteEntered.promise;
				const cancellation = operation === "dispose" ? loop.session.dispose() : loop.session.newSession();
				await waitFor(() => loop.session.activeMidRunBarrierCountForTests === 0);
				expect(loop.streamCallCount()).toBe(1);

				rewriteGate.resolve();
				await Promise.all([prompt, cancellation]);
				await loop.session.waitForIdle();

				expect(
					loop.agentEvents.filter(
						event =>
							event.type === "agent_end" &&
							event.stopReason === "maintenance" &&
							event.maintenanceOutcome === "aborted",
					),
				).toHaveLength(1);
				expect(closed).toBeGreaterThanOrEqual(1);
				expect(loop.streamCallCount()).toBe(1);
			} finally {
				manager.rewriteEntries = originalRewriteEntries;
				rewriteGate.resolve();
				if (operation !== "dispose") await loop.session.dispose();
			}
		}
	});

	it("T4 joins held promotion maintenance for dispose and disconnect before teardown", async () => {
		for (const operation of ["dispose", "disconnect"] as const) {
			authStorage.setRuntimeApiKey("openai-codex", "test-key");
			const spark = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
			const large = modelRegistry.find("openai-codex", "gpt-5.5");
			if (!spark || !large) throw new Error("Expected bundled Codex promotion models");
			const startModel = { ...spark, contextWindow: 150_000 };
			const promotionGate = Promise.withResolvers<void>();
			const promotionLookupEntered = Promise.withResolvers<void>();
			const registry = modelRegistry as unknown as {
				getApiKey: (candidate: Model, sessionId?: string) => Promise<string | undefined>;
			};
			const originalGetApiKey = registry.getApiKey.bind(registry);
			registry.getApiKey = async (candidate, sessionId) => {
				if (candidate.provider === large.provider && candidate.id === large.id) {
					promotionLookupEntered.resolve();
					await promotionGate.promise;
				}
				return originalGetApiKey(candidate, sessionId);
			};
			const loop = await buildLoopSession({
				model: startModel,
				settings: { "contextPromotion.enabled": true },
				responder: call =>
					call === 1
						? assistantFor(startModel, {
								content: [{ type: "toolCall", id: `${operation}-promotion-call`, name: "noop", arguments: {} }],
								totalTokens: THRESHOLD + 80_000,
								stopReason: "toolUse",
							})
						: assistantFor(startModel, {
								content: [{ type: "text", text: "late continuation" }],
								totalTokens: 5_000,
								stopReason: "stop",
							}),
			});
			try {
				await seedCompactableLoop(loop.session, startModel);
				const prompt = loop.session.prompt("go");
				await promotionLookupEntered.promise;
				const cancellation = operation === "dispose" ? loop.session.dispose() : loop.session.newSession();
				await waitFor(() => loop.session.activeMidRunBarrierCountForTests === 0);
				expect(loop.streamCallCount()).toBe(1);

				promotionGate.resolve();
				await Promise.all([prompt, cancellation]);
				await loop.session.waitForIdle();

				expect(
					loop.agentEvents.filter(
						event =>
							event.type === "agent_end" &&
							event.stopReason === "maintenance" &&
							event.maintenanceOutcome === "aborted",
					),
				).toHaveLength(1);
				expect(loop.session.model?.id).toBe(startModel.id);
				expect(loop.streamCallCount()).toBe(1);
			} finally {
				registry.getApiKey = originalGetApiKey;
				promotionGate.resolve();
				if (operation !== "dispose") await loop.session.dispose();
			}
		}
	});
	it("T5 treats hook cancellation as a compaction veto and continues the active run", async () => {
		const loop = await buildLoopSession({
			extensionSource: [
				"export default function(pi) {",
				'\tpi.on("session_before_compact", async () => ({ cancel: true }));',
				"}",
			].join("\n"),
			responder: call =>
				call === 1
					? assistantFor(model, {
							content: [{ type: "toolCall", id: "hook-cancel-call", name: "noop", arguments: {} }],
							totalTokens: THRESHOLD + 80_000,
							stopReason: "toolUse",
						})
					: assistantFor(model, {
							content: [{ type: "text", text: "late continuation" }],
							totalTokens: 5_000,
							stopReason: "stop",
						}),
		});
		try {
			await seedCompactableLoop(loop.session);
			await loop.session.prompt("go");
			await loop.session.waitForIdle();

			expect(
				loop.agentEvents.filter(event => event.type === "agent_end" && event.stopReason === "maintenance"),
			).toHaveLength(0);
			expect(loop.events.filter(event => event.type === "agent_end")).toHaveLength(1);
			expect(loop.streamCallCount()).toBe(2);
			expect(getLatestCompactionEntry(loop.session.sessionManager.getBranch())).toBeNull();
		} finally {
			await loop.session.dispose();
		}
	});

	it("T5 aborts from auto_compaction_start before preparation and never continues", async () => {
		const loop = await buildLoopSession({
			extensionSource: shortCircuitExtensionSource(),
			responder: call =>
				call === 1
					? assistantFor(model, {
							content: [{ type: "toolCall", id: "start-abort-call", name: "noop", arguments: {} }],
							totalTokens: THRESHOLD + 80_000,
							stopReason: "toolUse",
						})
					: assistantFor(model, {
							content: [{ type: "text", text: "late continuation" }],
							totalTokens: 5_000,
							stopReason: "stop",
						}),
		});
		const unsubscribe = loop.session.subscribe(event => {
			if (event.type === "auto_compaction_start") void loop.session.abort();
		});
		try {
			await seedCompactableLoop(loop.session);
			await loop.session.prompt("go");
			await loop.session.waitForIdle();

			expect(
				loop.agentEvents.filter(
					event =>
						event.type === "agent_end" &&
						event.stopReason === "maintenance" &&
						event.maintenanceOutcome === "aborted",
				),
			).toHaveLength(1);
			expect(
				loop.events.filter(
					event =>
						event.type === "agent_end" &&
						event.stopReason === "maintenance" &&
						event.maintenanceOutcome === "aborted",
				),
			).toHaveLength(1);
			expect(loop.streamCallCount()).toBe(1);
			expect(getLatestCompactionEntry(loop.session.sessionManager.getBranch())).toBeNull();
		} finally {
			unsubscribe();
			await loop.session.dispose();
		}
	});

	it("B1 reports aborted when cancellation lands just after compaction append and schedules no continuation", async () => {
		const loop = await buildLoopSession({
			extensionSource: shortCircuitExtensionSource(),
			responder: call =>
				call === 1
					? assistantFor(model, {
							content: [{ type: "toolCall", id: "post-append-call", name: "noop", arguments: {} }],
							totalTokens: THRESHOLD + 80_000,
							stopReason: "toolUse",
						})
					: assistantFor(model, {
							content: [{ type: "text", text: "late continuation" }],
							totalTokens: 5_000,
							stopReason: "stop",
						}),
		});
		const unsubscribe = loop.session.subscribe(event => {
			if (event.type === "auto_compaction_end" && event.result) void loop.session.abort();
		});
		try {
			await seedCompactableLoop(loop.session);
			await loop.session.prompt("go");
			await loop.session.waitForIdle();

			expect(
				loop.agentEvents.filter(
					event =>
						event.type === "agent_end" &&
						event.stopReason === "maintenance" &&
						event.maintenanceOutcome === "aborted",
				),
			).toHaveLength(1);
			expect(loop.streamCallCount()).toBe(1);
			expect(getLatestCompactionEntry(loop.session.sessionManager.getBranch())).not.toBeNull();
		} finally {
			unsubscribe();
			await loop.session.dispose();
		}
	});
	it("B1 aborts during prune and does not continue after the rewrite finishes", async () => {
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		const codex = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!codex) throw new Error("Expected bundled Codex model");
		let closed = 0;
		const loop = await buildLoopSession({
			model: codex,
			responder: call =>
				call === 1
					? assistantFor(codex, {
							content: [{ type: "toolCall", id: "prune-race-call", name: "noop", arguments: {} }],
							totalTokens: THRESHOLD + 80_000,
							stopReason: "toolUse",
						})
					: assistantFor(codex, {
							content: [{ type: "text", text: "late continuation" }],
							totalTokens: 5_000,
							stopReason: "stop",
						}),
		});
		loop.session.providerSessionState.set("openai-codex-responses", { close: () => closed++ });
		const rewriteGate = Promise.withResolvers<void>();
		const rewriteEntered = Promise.withResolvers<void>();
		const manager = loop.session.sessionManager as unknown as {
			rewriteEntries: () => Promise<void>;
		};
		const originalRewriteEntries = manager.rewriteEntries.bind(manager);
		manager.rewriteEntries = async () => {
			rewriteEntered.resolve();
			await rewriteGate.promise;
			await originalRewriteEntries();
		};
		try {
			// Five 30k-token outputs leave 90k pruneable after the 40k protection
			// window, enough to avert the 100k threshold from the 180k usage anchor.
			await seedLoop(loop.session, [
				{ role: "user", content: "old request", timestamp: Date.now() },
				...Array.from({ length: 5 }, (_, index) => ({
					role: "toolResult" as const,
					toolCallId: `old-prunable-output-${index}`,
					toolName: "bash",
					content: [{ type: "text" as const, text: "x".repeat(120_000) }],
					timestamp: Date.now(),
				})),
			]);
			const prompt = loop.session.prompt("go", { skipCompactionCheck: true });
			await rewriteEntered.promise;
			const abort = loop.session.abort();
			rewriteGate.resolve();
			await Promise.all([prompt, abort]);
			await loop.session.waitForIdle();
			await Bun.sleep(10);

			expect(loop.streamCallCount()).toBe(1);
			expect(getLatestCompactionEntry(loop.session.sessionManager.getBranch())).toBeNull();
			expect(loop.session.agent.state.messages).toEqual(loop.session.buildDisplaySessionContext().messages);
			expect(closed).toBe(1);
		} finally {
			manager.rewriteEntries = originalRewriteEntries;
			await loop.session.dispose();
		}
	});

	it("B1 aborts during promotion target resolution before the model can switch or continue", async () => {
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		const spark = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		const large = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!spark || !large) throw new Error("Expected codex promotion models");
		const startModel = { ...spark, contextWindow: 150_000 };
		const promotionGate = Promise.withResolvers<void>();
		const promotionLookupEntered = Promise.withResolvers<void>();
		const registry = modelRegistry as unknown as {
			getApiKey: (candidate: Model, sessionId?: string) => Promise<string | undefined>;
		};
		const originalGetApiKey = registry.getApiKey.bind(registry);
		registry.getApiKey = async (candidate, sessionId) => {
			if (candidate.provider === large.provider && candidate.id === large.id) {
				promotionLookupEntered.resolve();
				await promotionGate.promise;
			}
			return originalGetApiKey(candidate, sessionId);
		};
		const loop = await buildLoopSession({
			model: startModel,
			settings: { "contextPromotion.enabled": true },
			responder: call =>
				call === 1
					? assistantFor(startModel, {
							content: [{ type: "toolCall", id: "promotion-race-call", name: "noop", arguments: {} }],
							totalTokens: THRESHOLD + 80_000,
							stopReason: "toolUse",
						})
					: assistantFor(startModel, {
							content: [{ type: "text", text: "late continuation" }],
							totalTokens: 5_000,
							stopReason: "stop",
						}),
		});
		try {
			await seedCompactableLoop(loop.session, startModel);
			const prompt = loop.session.prompt("go");
			await promotionLookupEntered.promise;
			const abort = loop.session.abort();
			promotionGate.resolve();
			await Promise.all([prompt, abort]);
			await loop.session.waitForIdle();

			expect(loop.session.model?.id).toBe(startModel.id);
			expect(loop.streamCallCount()).toBe(1);
			expect(getLatestCompactionEntry(loop.session.sessionManager.getBranch())).toBeNull();
		} finally {
			registry.getApiKey = originalGetApiKey;
			await loop.session.dispose();
		}
	});
	it("T7 promotes through the real loop, resets the provider epoch, and continues exactly once", async () => {
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		const spark = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		const large = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!spark || !large) throw new Error("Expected codex promotion models");
		const startModel = { ...spark, contextWindow: 150_000 };
		const loop = await buildLoopSession({
			model: startModel,
			settings: { "contextPromotion.enabled": true },
			responder: call =>
				call === 1
					? assistantFor(startModel, {
							content: [{ type: "toolCall", id: "promotion-call", name: "noop", arguments: {} }],
							totalTokens: THRESHOLD + 80_000,
							stopReason: "toolUse",
						})
					: assistantFor(large, {
							content: [{ type: "text", text: "promoted completion" }],
							totalTokens: 5_000,
							stopReason: "stop",
						}),
		});
		let closed = 0;
		const previousProviderSessionState = loop.session.providerSessionState;
		previousProviderSessionState.set("openai-codex-responses", { close: () => closed++ });
		try {
			await seedCompactableLoop(loop.session, startModel);
			await loop.session.prompt("go");
			await loop.session.waitForIdle();

			expect(loop.session.model?.contextWindow).toBeGreaterThan(startModel.contextWindow!);
			expect(loop.session.providerSessionState).not.toBe(previousProviderSessionState);
			expect(closed).toBe(0);
			expect(getLatestCompactionEntry(loop.session.sessionManager.getBranch())).toBeNull();
			expect(
				loop.agentEvents.filter(
					event =>
						event.type === "agent_end" &&
						event.stopReason === "maintenance" &&
						event.maintenanceOutcome === "promoted",
				),
			).toHaveLength(1);
			expect(loop.streamCallCount()).toBe(2);
		} finally {
			await loop.session.dispose();
		}
	});
	it("T8 prevents the CJK-heavy provider overflow that occurs without mid-run maintenance", async () => {
		const cjk = "가".repeat(16_000);
		let maintainedOverflow = false;
		const maintained = await buildLoopSession({
			extensionSource: shortCircuitExtensionSource(),
			toolResultText: cjk,
			responder: call => {
				if (call === 1) {
					return assistantFor(model, {
						content: [{ type: "toolCall", id: "cjk-call", name: "noop", arguments: {} }],
						totalTokens: THRESHOLD - 5_000,
						stopReason: "toolUse",
					});
				}
				if (!getLatestCompactionEntry(maintained.session.sessionManager.getBranch())) {
					maintainedOverflow = true;
					return assistantFor(model, {
						content: [],
						totalTokens: 0,
						stopReason: "error",
						errorMessage: "context_length_exceeded: CJK-heavy context overflow",
					});
				}
				return assistantFor(model, {
					content: [{ type: "text", text: "compacted before overflow" }],
					totalTokens: 5_000,
					stopReason: "stop",
				});
			},
		});
		try {
			await seedCompactableLoop(maintained.session);
			await maintained.session.prompt("go");
			await maintained.session.waitForIdle();
			expect(maintained.session.activeMidRunMaintenanceCountForTests).toBe(0);

			expect(THRESHOLD - 5_000 + cjk.length / 4).toBeLessThan(THRESHOLD);
			expect(maintainedOverflow).toBe(false);
			expect(
				maintained.events.some(event => event.type === "auto_compaction_start" && event.reason === "threshold"),
			).toBe(true);
			expect(maintained.streamCallCount()).toBe(2);
		} finally {
			await maintained.session.dispose();
		}

		let counterfactualOverflow = false;
		const counterfactual = await buildLoopSession({
			extensionSource: shortCircuitExtensionSource(),
			toolResultText: cjk,
			responder: call => {
				if (call === 1) {
					return assistantFor(model, {
						content: [{ type: "toolCall", id: "cjk-counterfactual-call", name: "noop", arguments: {} }],
						totalTokens: THRESHOLD - 5_000,
						stopReason: "toolUse",
					});
				}
				if (call === 2) {
					counterfactualOverflow = true;
					return assistantFor(model, {
						content: [],
						totalTokens: 0,
						stopReason: "error",
						errorMessage: "context_length_exceeded: CJK-heavy context overflow",
					});
				}
				return assistantFor(model, {
					content: [{ type: "text", text: "recovered after reactive compaction" }],
					totalTokens: 5_000,
					stopReason: "stop",
				});
			},
		});
		try {
			counterfactual.session.agent.setMaintainContext(undefined);
			await seedCompactableLoop(counterfactual.session);
			await counterfactual.session.prompt("go");
			await counterfactual.session.waitForIdle();

			expect(counterfactualOverflow).toBe(true);
			expect(counterfactual.streamCallCount()).toBeGreaterThanOrEqual(2);
		} finally {
			await counterfactual.session.dispose();
		}
	});
});

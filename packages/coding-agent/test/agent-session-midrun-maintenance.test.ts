import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentContext } from "@gajae-code/agent-core";
import type { AssistantMessage, Model, ProviderSessionState, Usage } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { loadExtensions } from "@gajae-code/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@gajae-code/coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { getLatestCompactionEntry, SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir } from "@gajae-code/utils";

/**
 * Outcome-contract coverage for cooperative mid-run context maintenance
 * (issue #2035, `AgentSession#runMidRunMaintenance` via the test seam). The
 * decision anchors on the last assistant's `usage.totalTokens` plus trailing
 * tool/steering deltas; the action reuses prune → promote → compact and returns
 * one of `not-needed | pruned | compacted | promoted | failed | aborted`.
 */
describe("AgentSession mid-run maintenance outcomes", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const THRESHOLD = 100_000;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-midrun-maintenance-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	function codexModel(contextWindow: number): Model {
		const model = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!model) throw new Error("Expected bundled openai-codex model to exist");
		return { ...model, contextWindow, maxTokens: 32_768 };
	}

	async function shortCircuitExtensionRunner(sessionManager: SessionManager): Promise<ExtensionRunner> {
		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const extensionPath = path.join(extensionsDir, "compaction-short-circuit.ts");
		fs.writeFileSync(
			extensionPath,
			[
				"export default function(pi) {",
				'\tpi.on("session_before_compact", async (event) => {',
				"\t\tconst gate = globalThis.__midrunCompactGate;",
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
			].join("\n"),
		);
		const loaded = await loadExtensions([extensionPath], tempDir.path());
		return new ExtensionRunner(loaded.extensions, loaded.runtime, tempDir.path(), sessionManager, modelRegistry);
	}

	function usage(totalTokens: number, input = totalTokens, output = 0): Usage {
		return {
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}

	function assistant(model: Model, u: Usage, text = "ok"): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: u,
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
	}

	async function buildSession(options: {
		contextWindow?: number;
		shortCircuit?: boolean;
		settings?: Record<string, unknown>;
	}): Promise<AgentSession> {
		const model = codexModel(options.contextWindow ?? 200_000);
		const sessionManager = SessionManager.inMemory();
		const extensionRunner = options.shortCircuit ? await shortCircuitExtensionRunner(sessionManager) : undefined;
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.strategy": "context-full",
			"compaction.thresholdTokens": THRESHOLD,
			"contextPromotion.enabled": false,
			...options.settings,
		});
		return new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });
	}

	/** Seed the agent state + session branch with message_end events, then settle persistence. */
	async function seed(s: AgentSession, messages: readonly unknown[]): Promise<void> {
		for (const message of messages) {
			s.agent.emitExternalEvent({ type: "message_end", message: message as never });
		}
		await Bun.sleep(10);
	}

	/**
	 * Seed a multi-turn conversation whose older turns are summarizable, so
	 * prepareCompaction returns a real preparation. The last assistant carries
	 * `finalUsageTotal` (the mid-run estimate anchor). Pair with a low
	 * `compaction.keepRecentTokens` so the small-content branch still compacts.
	 */
	async function seedCompactableConversation(s: AgentSession, finalUsageTotal: number): Promise<void> {
		const m = s.model!;
		await seed(s, [
			{ role: "user", content: "first request: analyze the earlier work in detail", timestamp: Date.now() },
			assistant(m, usage(1_000), "earlier response one with some content"),
			{ role: "user", content: "second request: continue the analysis thoroughly", timestamp: Date.now() },
			assistant(m, usage(1_000), "earlier response two with more content"),
			{ role: "user", content: "third request: keep going with the plan", timestamp: Date.now() },
			assistant(m, usage(finalUsageTotal), "final response near the window"),
		]);
	}

	function contextOf(s: AgentSession): AgentContext {
		return { systemPrompt: s.state.systemPrompt, messages: s.messages, tools: [] };
	}

	async function waitFor(predicate: () => boolean): Promise<void> {
		const deadline = Date.now() + 1_000;
		while (!predicate()) {
			if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
			await Bun.sleep(1);
		}
	}

	it("estimates on last-assistant totalTokens, not the prompt-only anchor", async () => {
		session = await buildSession({});
		const model = session.model!;
		// input(prompt-only)=50k but totalTokens(input+output)=100k. The mid-run
		// estimate must use totalTokens, so it cannot be near the 50k prompt anchor.
		const estimate = session.estimateMidRunContextTokensForTests([
			{ role: "user", content: "hi", timestamp: Date.now() } as never,
			assistant(model, usage(100_000, 50_000, 50_000)),
		]);
		expect(estimate).toBeGreaterThanOrEqual(100_000);
	});

	it("adds trailing tool-result deltas to the totalTokens anchor", async () => {
		session = await buildSession({});
		const model = session.model!;
		const base = [{ role: "user", content: "hi", timestamp: Date.now() } as never, assistant(model, usage(90_000))];
		const withTrailing = [
			...base,
			{
				role: "toolResult",
				toolCallId: "t1",
				toolName: "read",
				content: [{ type: "text", text: "x".repeat(40_000) }],
				timestamp: Date.now(),
			} as never,
		];
		const baseEstimate = session.estimateMidRunContextTokensForTests(base);
		const trailingEstimate = session.estimateMidRunContextTokensForTests(withTrailing);
		expect(baseEstimate).toBe(90_000);
		expect(trailingEstimate).toBeGreaterThan(baseEstimate);
	});

	it("returns not-needed below the threshold", async () => {
		session = await buildSession({});
		const model = session.model!;
		await seed(session, [
			{ role: "user", content: "hi", timestamp: Date.now() } as never,
			assistant(model, usage(10_000)),
		]);
		expect(await session.runMidRunMaintenanceForTests(contextOf(session))).toBe("not-needed");
	});

	it("returns not-needed at exactly the threshold and maintains just past it", async () => {
		session = await buildSession({ shortCircuit: true, settings: { "compaction.keepRecentTokens": 10 } });
		const model = session.model!;
		await seed(session, [
			{ role: "user", content: "hi", timestamp: Date.now() } as never,
			assistant(model, usage(THRESHOLD)),
		]);
		// shouldCompact is strictly greater-than, so exactly-at-threshold does not maintain.
		expect(await session.runMidRunMaintenanceForTests(contextOf(session))).toBe("not-needed");

		const over = await buildSession({ shortCircuit: true, settings: { "compaction.keepRecentTokens": 10 } });
		await seedCompactableConversation(over, THRESHOLD + 5_000);
		expect(
			await over.runMidRunMaintenanceForTests({
				systemPrompt: over.state.systemPrompt,
				messages: over.messages,
				tools: [],
			}),
		).toBe("compacted");
		await over.dispose();
	});

	it("returns not-needed when auto maintenance is disabled or strategy is off", async () => {
		session = await buildSession({ settings: { "compaction.strategy": "off" } });
		const model = session.model!;
		await seed(session, [
			{ role: "user", content: "hi", timestamp: Date.now() } as never,
			assistant(model, usage(THRESHOLD * 3)),
		]);
		expect(await session.runMidRunMaintenanceForTests(contextOf(session))).toBe("not-needed");
	});

	it("compacts above the threshold and resets the codex provider session (prompt-cache epoch)", async () => {
		session = await buildSession({ shortCircuit: true, settings: { "compaction.keepRecentTokens": 10 } });
		const closeSpy = () => {
			closed++;
		};
		let closed = 0;
		session.providerSessionState.set("openai-codex-responses", { close: closeSpy } satisfies ProviderSessionState);

		await seedCompactableConversation(session, THRESHOLD * 3);
		const before = getLatestCompactionEntry(session.sessionManager.getBranch());
		const outcome = await session.runMidRunMaintenanceForTests(contextOf(session));

		expect(outcome).toBe("compacted");
		const after = getLatestCompactionEntry(session.sessionManager.getBranch());
		expect(after).not.toBeNull();
		expect(after?.id).not.toBe(before?.id ?? null);
		// History was rewritten, so the codex websocket session (previous_response_id)
		// was closed to start a clean provider/prompt-cache epoch.
		expect(closed).toBe(1);
	});

	it("selects a larger-context promotion target instead of compacting", async () => {
		const sessionManager = SessionManager.inMemory();
		const sparkModel = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		const largeModel = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!sparkModel || !largeModel) throw new Error("Expected codex spark + large models");
		const startModel = { ...sparkModel, contextWindow: 150_000 };
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: startModel, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.strategy": "context-full",
				"compaction.thresholdTokens": THRESHOLD,
				"contextPromotion.enabled": true,
			}),
			modelRegistry,
		});
		let closed = 0;
		const previousProviderSessionState = session.providerSessionState;
		previousProviderSessionState.set("openai-codex-responses", {
			close: () => closed++,
		} satisfies ProviderSessionState);
		await seed(session, [
			{ role: "user", content: "hi", timestamp: Date.now() } as never,
			assistant(startModel, usage(THRESHOLD * 1.2)),
			assistant(startModel, usage(THRESHOLD * 1.2)),
		]);

		const outcome = await session.runMidRunMaintenanceForTests(contextOf(session));
		expect(outcome).toBe("promoted");
		expect(session.model?.contextWindow).toBeGreaterThan(startModel.contextWindow!);
		expect(session.providerSessionState).not.toBe(previousProviderSessionState);
		expect(closed).toBe(0);
		expect(getLatestCompactionEntry(session.sessionManager.getBranch())).toBeNull();
	});

	it("rolls back a temporary promotion scope when cancellation lands after the model switch", async () => {
		const sessionManager = SessionManager.inMemory();
		const sparkModel = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		const largeModel = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!sparkModel || !largeModel) throw new Error("Expected codex spark + large models");
		const startModel = { ...sparkModel, contextWindow: 150_000 };
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: startModel, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.strategy": "context-full",
				"compaction.thresholdTokens": THRESHOLD,
				"contextPromotion.enabled": true,
			}),
			modelRegistry,
		});
		const previousProviderSessionState = session.providerSessionState;
		previousProviderSessionState.set("openai-codex-responses", { close: () => {} });
		await seed(session, [
			{ role: "user", content: "hi", timestamp: Date.now() } as never,
			assistant(startModel, usage(THRESHOLD * 1.2)),
		]);
		const cancellation = new AbortController();
		const originalSetModelTemporary = session.setModelTemporary.bind(session);
		session.setModelTemporary = async (...args) => {
			const scope = await originalSetModelTemporary(...args);
			cancellation.abort();
			return scope;
		};

		const outcome = await session.runMidRunMaintenanceForTests(contextOf(session), {
			signal: cancellation.signal,
			awaitEventDrain: async () => {},
		});

		expect(outcome).toBe("aborted");
		expect(session.model?.id).toBe(startModel.id);
		expect(session.providerSessionState).toBe(previousProviderSessionState);
	});

	it("returns failed when compaction cannot proceed (no compaction backend)", async () => {
		// No short-circuit extension and the runtime model registry exposes no
		// usable compaction candidate, so #runAutoCompaction skips without a new
		// compaction entry — reported as an explicit failure so the run still resumes.
		session = await buildSession({ shortCircuit: false });
		const model = session.model!;
		await seed(session, [
			{ role: "user", content: "hi", timestamp: Date.now() } as never,
			assistant(model, usage(THRESHOLD * 3)),
			assistant(model, usage(THRESHOLD * 3)),
		]);
		const outcome = await session.runMidRunMaintenanceForTests(contextOf(session));
		expect(outcome).toBe("failed");
		expect(getLatestCompactionEntry(session.sessionManager.getBranch())).toBeNull();
	});

	it("does not double-compact while a compaction is already in flight", async () => {
		session = await buildSession({ shortCircuit: true, settings: { "compaction.keepRecentTokens": 10 } });
		await seedCompactableConversation(session, THRESHOLD * 3);
		// Block a long-lived idle compaction at session_before_compact so
		// isCompacting stays true, then confirm the mid-run checkpoint yields the
		// context instead of stacking a second (double) compaction underneath it.
		const gate = Promise.withResolvers<void>();
		(globalThis as { __midrunCompactGate?: Promise<void> }).__midrunCompactGate = gate.promise;
		try {
			const inFlight = session.runIdleCompaction();
			const deadline = Date.now() + 1_000;
			while (!session.isCompacting && Date.now() < deadline) await Bun.sleep(5);
			expect(session.isCompacting).toBe(true);

			const outcome = await session.runMidRunMaintenanceForTests(contextOf(session));
			expect(outcome).toBe("not-needed");

			gate.resolve();
			await inFlight;
		} finally {
			(globalThis as { __midrunCompactGate?: Promise<void> }).__midrunCompactGate = undefined;
		}
	});
	it("T2 canonically persists paired tool results and distinct steering before a prune rewrite", async () => {
		session = await buildSession({ shortCircuit: true });
		let closed = 0;
		session.providerSessionState.set("openai-codex-responses", {
			close: () => closed++,
		} satisfies ProviderSessionState);
		const m = session.model!;
		const pairedToolResult = {
			role: "toolResult",
			toolCallId: "paired-result",
			toolName: "noop",
			content: [{ type: "text", text: "paired output" }],
			timestamp: Date.now(),
		};
		await seed(session, [
			{ role: "user", content: "earlier request", timestamp: Date.now() },
			{
				role: "toolResult",
				toolCallId: "old-output-1",
				toolName: "bash",
				content: [{ type: "text", text: "x".repeat(120_000) }],
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "old-output-3",
				toolName: "bash",
				content: [{ type: "text", text: "z".repeat(120_000) }],
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "old-output-2",
				toolName: "bash",
				content: [{ type: "text", text: "y".repeat(120_000) }],
				timestamp: Date.now(),
			},
			assistant(m, usage(THRESHOLD + 1)),
			pairedToolResult,
			{ role: "user", content: "first distinct steering", timestamp: Date.now() },
			{ role: "user", content: "second distinct steering", timestamp: Date.now() },
		]);

		expect(await session.runMidRunMaintenanceForTests(contextOf(session))).toBe("pruned");
		const persisted = session.sessionManager
			.getBranch()
			.flatMap(entry =>
				entry.type === "message"
					? [entry.message as { role?: string; toolCallId?: string; content?: unknown }]
					: [],
			);
		expect(persisted.filter(message => message.toolCallId === "paired-result")).toHaveLength(1);
		expect(
			persisted.filter(message => message.role === "user" && message.content === "first distinct steering"),
		).toHaveLength(1);
		expect(
			persisted.filter(message => message.role === "user" && message.content === "second distinct steering"),
		).toHaveLength(1);
		expect(closed).toBe(1);
		expect(getLatestCompactionEntry(session.sessionManager.getBranch())).toBeNull();
	});

	it("cleans a held EventStream consumer barrier before it can flush or rewrite", async () => {
		for (const operation of ["abort", "dispose", "disconnect"] as const) {
			const s = await buildSession({ shortCircuit: true });
			session = s;
			await seed(s, [
				{ role: "user", content: "barrier request", timestamp: Date.now() },
				assistant(s.model!, usage(THRESHOLD * 3)),
			]);
			const stream = new AssistantMessageEventStream();
			const consumerReady = Promise.withResolvers<void>();
			const heldConsumer = Promise.withResolvers<void>();
			const consumer = (async () => {
				for await (const _event of stream) {
					consumerReady.resolve();
					await heldConsumer.promise;
				}
			})();
			stream.push({ type: "start", partial: assistant(s.model!, usage(1)) });
			await consumerReady.promise;
			let flushCount = 0;
			const manager = s.sessionManager as unknown as { flush: () => Promise<void> };
			const originalFlush = manager.flush.bind(manager);
			manager.flush = async () => {
				flushCount++;
				return originalFlush();
			};
			const maintenance = s.runMidRunMaintenanceForTests(contextOf(s), {
				signal: new AbortController().signal,
				awaitEventDrain: signal => stream.waitForConsumerDrain(signal),
			});
			await waitFor(
				() => s.activeMidRunBarrierCountForTests === 1 && stream.pendingConsumerDrainCountForTests === 1,
			);
			expect(flushCount).toBe(0);

			if (operation === "abort") await s.abort();
			else if (operation === "dispose") await s.dispose();
			else await s.newSession();

			expect(s.activeMidRunBarrierCountForTests).toBe(0);
			expect(stream.pendingConsumerDrainCountForTests).toBe(0);
			if (operation === "abort") expect(flushCount).toBe(0);

			expect(await maintenance).toBe("aborted");
			expect(getLatestCompactionEntry(s.sessionManager.getBranch())).toBeNull();
			heldConsumer.resolve();
			stream.end();
			await consumer;
			if (operation === "abort") expect(flushCount).toBe(0);
		}
	});

	it("T6 attempts identical provider-response anchors at most once", async () => {
		session = await buildSession({ shortCircuit: false });
		await seed(session, [
			{ role: "user", content: "anti-wedge request", timestamp: Date.now() },
			assistant(session.model!, usage(THRESHOLD * 3)),
		]);
		expect(await session.runMidRunMaintenanceForTests(contextOf(session))).toBe("failed");
		expect(await session.runMidRunMaintenanceForTests(contextOf(session))).toBe("not-needed");
	});
});

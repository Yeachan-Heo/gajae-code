import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool, type StreamFn } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession, WorkerIntegrationRequestScheduler } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";

describe("AgentSession abort timeout", () => {
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage?.close();
		authStorage = undefined;
		// Clear the reference before removal so one failed cleanup cannot
		// cascade into every later test's afterEach retrying the same stale dir.
		const dir = tempDir;
		tempDir = undefined;
		if (dir) {
			for (let attempt = 0; ; attempt++) {
				try {
					dir.removeSync();
					break;
				} catch (error) {
					if (process.platform !== "win32") throw error;
					const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
					if (code !== "EBUSY" && code !== "EPERM") throw error;
					// Windows reports EBUSY while the just-closed auth DB handle (or an
					// AV scan of it) still holds the directory; retry briefly, then
					// leave the disposable temp dir behind rather than failing the test.
					if (attempt >= 10) {
						process.emitWarning(`Leaving locked test temp directory behind: ${dir.path()} (${String(error)})`);
						break;
					}
					await Bun.sleep(50);
				}
			}
		}
		vi.restoreAllMocks();
	});

	it("bounds abort cleanup when the underlying agent never becomes idle", async () => {
		tempDir = TempDir.createSync("@gjc-abort-timeout-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model to exist");

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
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});

		const forcedAbort = vi.spyOn(agent, "forceAbort");
		vi.spyOn(agent, "waitForIdle").mockImplementation(() => new Promise<void>(() => {}));

		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
		});

		await session.abort({ timeoutMs: 10 });

		expect(forcedAbort).toHaveBeenCalledTimes(1);
		expect(session.isStreaming).toBe(false);
		expect(notices.some(message => message.includes("Abort cleanup timed out"))).toBe(true);
	});

	it("aborts and quarantines only the captured prompt domain while a successor remains live", async () => {
		tempDir = TempDir.createSync("@gjc-exact-prompt-abort-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model to exist");
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
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});

		const first = agent.resourceLedger.open("captured-a");
		const successor = agent.resourceLedger.open("successor-b");
		if (!first || !successor) throw new Error("Expected prompt cancellation domains");
		const cancellationAware = Promise.withResolvers<void>();
		first.signal.addEventListener("abort", () => cancellationAware.resolve(), { once: true });
		const firstProducer = agent.resourceLedger.reserveProducer(
			"captured-a",
			first,
			"post_prompt",
			"cancellation-aware",
		);
		if (!firstProducer.ok) throw new Error("Expected first producer reservation");
		firstProducer.lease.track("post_prompt", "cancellation-aware-child", cancellationAware.promise);
		firstProducer.lease.closeDiscovery();
		agent.resourceLedger.seal("captured-a");

		expect(await session.abortPromptAndWait("captured-a", { graceMs: 100 })).toEqual({ status: "settled" });
		expect(first.signal.aborted).toBe(true);
		expect(successor.signal.aborted).toBe(false);

		const hanging = Promise.withResolvers<void>();
		const hangingDomain = agent.resourceLedger.open("captured-hanging");
		if (!hangingDomain) throw new Error("Expected hanging prompt domain");
		const hangingProducer = agent.resourceLedger.reserveProducer(
			"captured-hanging",
			hangingDomain,
			"post_prompt",
			"hanging",
		);
		if (!hangingProducer.ok) throw new Error("Expected hanging producer reservation");
		hangingProducer.lease.track("post_prompt", "hanging-child", hanging.promise);
		hangingProducer.lease.closeDiscovery();
		agent.resourceLedger.seal("captured-hanging");

		const proof = await session.abortPromptAndWait("captured-hanging", { graceMs: 5 });
		expect(proof).toMatchObject({
			status: "unfenced",
			reason: "resources_pending",
			pending: [{ kind: "post_prompt", label: "hanging-child" }],
		});
		expect(hangingDomain.signal.aborted).toBe(true);
		expect(successor.signal.aborted).toBe(false);
		expect(await session.abortPromptAndWait("captured-hanging", { graceMs: 0 })).toMatchObject({
			status: "unfenced",
			reason: "quarantined",
			pending: [{ kind: "post_prompt", label: "hanging-child" }],
		});

		agent.resourceLedger.seal("successor-b");
		hanging.resolve();
	});

	it("settles a never-resolving worker integration request after aborting it", async () => {
		let aborted = false;
		const scheduler = new WorkerIntegrationRequestScheduler(
			signal =>
				new Promise<void>(() => {
					signal.addEventListener("abort", () => {
						aborted = true;
					});
				}),
			10,
		);

		scheduler.enqueue();
		await scheduler.flush();

		expect(aborted).toBe(true);
	});

	function wedgedTurnHarness(): {
		makeAgent: () => Agent;
		releaseWedge: () => void;
		hasWedgeStarted: () => boolean;
		blockSuccessors: () => void;
		releaseSuccessors: () => void;
	} {
		const mock = createMockModel();
		if (!authStorage) throw new Error("Expected auth storage");
		authStorage.setRuntimeApiKey(mock.model.provider, "test-key");
		const makeResponse = (text: string): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
			api: mock.model.api,
			provider: mock.model.provider,
			model: mock.model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const streamFn: StreamFn = () => {
			const stream = new AssistantMessageEventStream();
			const response = makeResponse("recovered");
			queueMicrotask(() => {
				stream.push({ type: "start", partial: response });
				stream.push({ type: "done", reason: "stop", message: response });
				stream.end(response);
			});
			return stream;
		};
		const wedgeGate = Promise.withResolvers<void>();
		const successorGate = Promise.withResolvers<void>();
		let transformCalls = 0;
		let blockSuccessors = false;
		return {
			makeAgent: () =>
				new Agent({
					getApiKey: () => "test-key",
					initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
					streamFn,
					// The first turn's context transform models a hook that ignores
					// its abort signal: the agent loop awaits transformContext bare
					// (not raced against the signal), so cooperative abort cleanup
					// cannot settle and only the timeout budget can recover the
					// session. Every later turn passes straight through.
					transformContext: async messages => {
						transformCalls++;
						if (transformCalls === 1) await wedgeGate.promise;
						else if (blockSuccessors) await successorGate.promise;
						return messages;
					},
				}),
			releaseWedge: () => wedgeGate.resolve(),
			hasWedgeStarted: () => transformCalls >= 1,
			blockSuccessors: () => {
				blockSuccessors = true;
			},
			releaseSuccessors: () => successorGate.resolve(),
		};
	}

	it("returns from a timed-out abort and admits a successor when the stream ignores abort", async () => {
		tempDir = TempDir.createSync("@gjc-abort-wedged-stream-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const harness = wedgedTurnHarness();
		const agent = harness.makeAgent();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
		const activeSession = session;
		const notices: string[] = [];
		let agentEnds = 0;
		activeSession.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
			if (event.type === "agent_end") agentEnds++;
		});

		const wedgedPrompt = activeSession.prompt("Start a turn that ignores abort.");
		try {
			const deadline = Date.now() + 1_000;
			while (!(harness.hasWedgeStarted() && activeSession.isStreaming)) {
				if (Date.now() >= deadline) throw new Error("Timed out waiting for the wedged turn to start");
				await Bun.sleep(1);
			}

			// Before the abandoned-prompt tracking this await never returned: the
			// aborted-turn drain kept waiting on the wedged prompt's in-flight
			// count, which only drops when the wedged `agent.prompt(...)` settles.
			await activeSession.abort({ timeoutMs: 25, cause: "user_interrupt" });
			expect(notices.some(message => message.includes("forced session recovery"))).toBe(true);
			// The forced terminal agent_end published instead of parking behind the
			// abandoned prompt's in-flight count.
			expect(agentEnds).toBe(1);
			expect(Boolean(activeSession.isStreaming)).toBe(false);
			await Promise.race([
				activeSession.waitForIdle(),
				Bun.sleep(250).then(() => {
					throw new Error("Forced recovery left session settlement waiting on the abandoned prompt");
				}),
			]);

			// A later abort must not wedge on the abandoned prompt either.
			await activeSession.abort({ timeoutMs: 25 });

			// Prompt admission is unwedged: a successor prompt runs to completion.
			await activeSession.prompt("Prompt after forced recovery.");
			expect(agentEnds).toBe(2);
		} finally {
			harness.releaseWedge();
			await wedgedPrompt.catch(() => undefined);
		}
	});

	it("lets a bounded abort force recovery for a wedged unbounded abort sharing the unwind", async () => {
		tempDir = TempDir.createSync("@gjc-abort-shared-unwind-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const harness = wedgedTurnHarness();
		const agent = harness.makeAgent();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
		const activeSession = session;
		const notices: string[] = [];
		let agentEnds = 0;
		activeSession.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
			if (event.type === "agent_end") agentEnds++;
		});

		const wedgedPrompt = activeSession.prompt("Start a turn that ignores abort.");
		try {
			const deadline = Date.now() + 1_000;
			while (!(harness.hasWedgeStarted() && activeSession.isStreaming)) {
				if (Date.now() >= deadline) throw new Error("Timed out waiting for the wedged turn to start");
				await Bun.sleep(1);
			}

			// An unbounded abort wedges on cooperative cleanup (waitForIdle never
			// settles) and owns the shared unwind.
			const unboundedAbort = activeSession.abort({ cause: "tool_abort" });
			let unboundedSettled = false;
			void unboundedAbort.then(() => {
				unboundedSettled = true;
			});
			await Bun.sleep(10);
			expect(unboundedSettled).toBe(false);

			// The bounded abort races the shared unwind with its own budget and
			// forces recovery on the first abort's behalf; before that, it awaited
			// the wedged unwind with its timeoutMs silently discarded.
			const boundedStarted = Date.now();
			await Promise.all([
				activeSession.abort({ timeoutMs: 25, cause: "user_interrupt" }),
				activeSession.abort({ timeoutMs: 0, cause: "user_interrupt" }),
			]);
			expect(Date.now() - boundedStarted).toBeLessThan(45);
			expect(notices.filter(message => message.includes("forced session recovery"))).toHaveLength(1);
			await unboundedAbort;
			expect(agentEnds).toBe(1);

			// Prompt admission is unwedged for both aborts' waiters.
			await activeSession.prompt("Prompt after forced recovery.");
		} finally {
			harness.releaseWedge();
			await wedgedPrompt.catch(() => undefined);
		}
	});

	it("keeps a successor observable while an abandoned prompt settles later", async () => {
		tempDir = TempDir.createSync("@gjc-abort-zombie-settlement-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const harness = wedgedTurnHarness();
		const agent = harness.makeAgent();
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
		const activeSession = session;
		const wedgedPrompt = activeSession.prompt("Start a turn that ignores abort.");
		try {
			const deadline = Date.now() + 1_000;
			while (!(harness.hasWedgeStarted() && activeSession.isStreaming)) {
				if (Date.now() >= deadline) throw new Error("Timed out waiting for the wedged turn to start");
				await Bun.sleep(1);
			}

			await activeSession.abort({ timeoutMs: 25, cause: "user_interrupt" });

			harness.blockSuccessors();
			const successorPrompt = activeSession.prompt("Successor stays active during zombie settlement.");
			await Bun.sleep(10);
			expect(Boolean(activeSession.isStreaming)).toBe(true);

			harness.releaseWedge();
			await Bun.sleep(10);
			expect(Boolean(activeSession.isStreaming)).toBe(true);

			harness.releaseSuccessors();
			await Promise.all([successorPrompt, wedgedPrompt.catch(() => undefined)]);
			expect(Boolean(activeSession.isStreaming)).toBe(false);
		} finally {
			harness.releaseWedge();
			await wedgedPrompt.catch(() => undefined);
		}
	});

	it("recovers when the provider event stream itself never settles after abort", async () => {
		tempDir = TempDir.createSync("@gjc-abort-wedged-provider-stream-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const mock = createMockModel();
		authStorage.setRuntimeApiKey(mock.model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const heldStream = new AssistantMessageEventStream();
		const response: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "recovered" }],
			api: mock.model.api,
			provider: mock.model.provider,
			model: mock.model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		let streamCalls = 0;
		const streamFn: StreamFn = () => {
			streamCalls++;
			if (streamCalls === 1) return heldStream;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: response });
				stream.push({ type: "done", reason: "stop", message: response });
				stream.end(response);
			});
			return stream;
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
		const activeSession = session;
		const agentEnds: string[] = [];
		activeSession.subscribe(event => {
			if (event.type === "agent_end") agentEnds.push(event.stopReason ?? "unknown");
		});

		const wedgedPrompt = activeSession.prompt("Start a provider stream that never settles.");
		try {
			const deadline = Date.now() + 1_000;
			while (!(heldStream.hasActiveConsumer && activeSession.isStreaming)) {
				if (Date.now() >= deadline) throw new Error("Timed out waiting for provider stream consumption");
				await Bun.sleep(1);
			}

			await activeSession.abort({ timeoutMs: 25, cause: "user_interrupt" });
			expect(agentEnds).toHaveLength(1);
			expect(Boolean(activeSession.isStreaming)).toBe(false);

			await activeSession.prompt("Successor after wedged provider stream.");
			expect(streamCalls).toBe(2);
			expect(agentEnds).toHaveLength(2);
		} finally {
			heldStream.end(response);
			await wedgedPrompt.catch(() => undefined);
		}
	});

	it("bounds dispose, lets an abort-ignoring run settle cooperatively, and drops its late events", async () => {
		tempDir = TempDir.createSync("@gjc-dispose-timeout-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const mock = createMockModel();
		authStorage.setRuntimeApiKey(mock.model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.inMemory();
		const heldStream = new AssistantMessageEventStream();
		const releaseHeldTool = Promise.withResolvers<void>();
		const response: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "held-tool-call", name: "hold", arguments: {} }],
			api: mock.model.api,
			provider: mock.model.provider,
			model: mock.model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		let streamStarted = false;
		let toolStarted = false;
		const holdTool: AgentTool = {
			name: "hold",
			label: "Hold",
			description: "A test tool that ignores cancellation until released",
			parameters: z.object({}),
			execute: async () => {
				toolStarted = true;
				await releaseHeldTool.promise;
				return { content: [{ type: "text" as const, text: "released" }] };
			},
		};
		const streamFn: StreamFn = () => {
			queueMicrotask(() => {
				heldStream.push({ type: "start", partial: response });
				streamStarted = true;
				heldStream.push({ type: "done", reason: "toolUse", message: response });
			});
			return heldStream;
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [holdTool], messages: [] },
			streamFn,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
		});
		const activeSession = session;
		let teardownStarted = false;
		let agentEndsAfterTeardownStarted = 0;
		activeSession.subscribe(event => {
			if (teardownStarted && event.type === "agent_end") agentEndsAfterTeardownStarted++;
		});

		const prompt = activeSession.prompt("Start a stream that ignores abort.");
		let disposed = false;
		// Keep a regression from consuming the suite's hook timeout and hiding the
		// failed elapsed-time assertion. A correct dispose returns before this fires.
		const safetyRelease = setTimeout(() => {
			releaseHeldTool.resolve();
			heldStream.end(response);
		}, 5_000);
		safetyRelease.unref?.();
		try {
			const deadline = Date.now() + 1_000;
			while (!(streamStarted && toolStarted && activeSession.isStreaming)) {
				if (Date.now() >= deadline) throw new Error("Timed out waiting for the abort-ignoring run to stream");
				await Bun.sleep(1);
			}

			const originalForceAbort = agent.forceAbort.bind(agent);
			const forceAbortResults: boolean[] = [];
			const forcedAbort = vi.spyOn(agent, "forceAbort").mockImplementation(reason => {
				const result = originalForceAbort(reason);
				forceAbortResults.push(result);
				return result;
			});

			teardownStarted = true;
			const started = Date.now();
			await activeSession.dispose();
			disposed = true;
			const elapsed = Date.now() - started;

			// Since #3894 the agent loop emits a synthetic aborted result for tool
			// calls that outlive their signal, so the turn terminates on its own and
			// `waitForIdle` settles well inside the 2s force-abort budget. Burning
			// that budget would mean the loop is hanging again.
			expect(elapsed).toBeLessThan(2_000);
			expect(forcedAbort).not.toHaveBeenCalled();
			expect(forceAbortResults).toEqual([]);
			expect(agent.state.isStreaming).toBe(false);

			const branchIdsAfterDispose = sessionManager.getBranch().map(entry => entry.id);
			releaseHeldTool.resolve();
			heldStream.end(response);
			await prompt;
			await Bun.sleep(10);

			expect(sessionManager.getBranch().map(entry => entry.id)).toEqual(branchIdsAfterDispose);
			expect(agentEndsAfterTeardownStarted).toBe(0);
		} finally {
			clearTimeout(safetyRelease);
			releaseHeldTool.resolve();
			heldStream.end(response);
			try {
				await prompt;
			} finally {
				if (!disposed) await activeSession.dispose();
				session = undefined;
			}
		}
	});
});

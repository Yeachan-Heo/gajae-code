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
		tempDir?.removeSync();
		tempDir = undefined;
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

	it("bounds dispose, force-invalidates an abort-ignoring run, and drops its late events", async () => {
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

			expect(elapsed).toBeLessThan(6_000);
			expect(forcedAbort).toHaveBeenCalledTimes(1);
			expect(forceAbortResults).toEqual([true]);
			expect(agent.state.isStreaming).toBe(false);

			const branchIdsAfterDispose = sessionManager.getBranch().map(entry => entry.id);
			releaseHeldTool.resolve();
			heldStream.end(response);
			await prompt;
			await Bun.sleep(10);

			expect(sessionManager.getBranch().map(entry => entry.id)).toEqual(branchIdsAfterDispose);
			expect(agentEndsAfterTeardownStarted).toBe(0);
		} finally {
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

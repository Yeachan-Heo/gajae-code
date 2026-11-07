import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentEvent } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { AsyncJobManager } from "../../src/async/job-manager";
import { kNoAuth, type ModelRegistry } from "../../src/config/model-registry";

import { Settings } from "../../src/config/settings";
import type { LoadExtensionsResult } from "../../src/extensibility/extensions/types";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { ManagedTaskPersistence, runSubprocess, runSubprocessOnce } from "../../src/task/executor";
import type { AgentDefinition } from "../../src/task/types";
import { EventBus } from "../../src/utils/event-bus";

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createPauseSession(options: CreateAgentSessionOptions, subagentId: string): AgentSession {
	const manager = options.sessionManager;
	if (!manager) throw new Error("Expected injected session manager");
	let disposal: Promise<void> | undefined;
	const dispose = (): Promise<void> =>
		(disposal ??= (async () => {
			const outcome = await manager.closeStrict();
			if (outcome.kind !== "closed") throw outcome.error;
		})());
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };
	let prompts = 0;
	const emit = (event: AgentEvent) => {
		for (const listener of listeners) listener(event);
	};
	const session = {
		state,
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: manager,
		getActiveToolNames: () => ["yield"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		setConfiguredModelChain: () => {},
		getConfiguredModelChain: () => undefined,
		seedDefaultFallbackResolution: () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _promptOptions?: PromptOptions) => {
			prompts += 1;
			AsyncJobManager.instance()?.getLiveHandle(subagentId)?.requestPause();
			const message = assistantMessage("paused output");
			state.messages.push(message);
			emit({ type: "message_end", message });
			emit({
				type: "agent_end",
				messages: [message],
				stopReason: options.shouldPause?.() === true ? "paused" : "completed",
			});
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		abort: async () => {},
		dispose,
		awaitDisposeCompletion: dispose,
		get promptCount() {
			return prompts;
		},
	};
	return session as unknown as AgentSession;
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: {} as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

describe("runSubprocess pause/resume integration", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		const manager = AsyncJobManager.instance();
		if (manager) await manager.dispose({ timeoutMs: 100 });
		AsyncJobManager.setInstance(undefined);
	});

	it("wires live pause requests into Agent shouldPause and returns a paused result without aborting", async () => {
		const subagentId = "stable-subagent-id";
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		AsyncJobManager.setInstance(manager);
		let capturedOptions: CreateAgentSessionOptions | undefined;
		let session: AgentSession | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			const actualOptions = options ?? {};
			capturedOptions = actualOptions;
			session = createPauseSession(actualOptions, subagentId);
			return createSessionResult(session);
		});
		const agent: AgentDefinition = {
			name: "executor",
			description: "test executor",
			systemPrompt: "test",
			source: "bundled",
		};

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "do paused work",
			index: 0,
			id: subagentId,
			subagentId,
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [],
				getApiKey: async () => kNoAuth,
			} as unknown as ModelRegistry,
			enableLsp: false,
		});

		expect(capturedOptions?.shouldPause?.()).toBe(true);
		expect(result.paused).toBe(true);
		expect(result.aborted).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.error).toBeUndefined();
		expect(manager.getLiveHandle(subagentId)).toBeUndefined();
	});

	it("joins late SDK construction and strict disposal after abort before runner completion", async () => {
		const subagentId = "late-sdk-abort";
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		AsyncJobManager.setInstance(manager);
		const entered = Promise.withResolvers<CreateAgentSessionOptions>();
		const construction = Promise.withResolvers<CreateAgentSessionResult>();
		const closing = Promise.withResolvers<void>();
		const allowClose = Promise.withResolvers<void>();
		const events: string[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options?.sessionManager) throw new Error("Expected injected session manager");
			entered.resolve(options);
			return construction.promise;
		});
		const removeHandle = vi.spyOn(manager, "removeLiveHandle");
		let completed = false;
		let result: Awaited<ReturnType<typeof runSubprocessOnce>> | undefined;
		const jobId = manager.register(
			"task",
			"late construction",
			async ({ signal }) => {
				result = await runSubprocessOnce({
					cwd: "/tmp",
					agent: { name: "executor", description: "test", systemPrompt: "test", source: "bundled" },
					task: "abort during construction",
					index: 0,
					id: subagentId,
					subagentId,
					signal,
					asyncJobManager: manager,
					settings: Settings.isolated(),
					enableLsp: false,
					modelRegistry: {
						refresh: async () => {},
						getAvailable: () => [],
						getApiKey: async () => kNoAuth,
					} as unknown as ModelRegistry,
				});
				events.push("runner completed");
				completed = true;
				return "cancelled";
			},
			{ ownerId: "parent" },
		);
		const job = manager.getJob(jobId)!;
		const options = await entered.promise;
		const sessionManager = options.sessionManager!;
		const closeStrict = sessionManager.closeStrict.bind(sessionManager);
		vi.spyOn(sessionManager, "closeStrict").mockImplementation(async () => {
			closing.resolve();
			await allowClose.promise;
			const outcome = await closeStrict();
			if (outcome.kind === "closed") events.push("manager closed");
			return outcome;
		});
		const session = createPauseSession(options, subagentId);
		const retainedDisposal = session.awaitDisposeCompletion.bind(session);
		vi.spyOn(session, "dispose").mockImplementation(async () => {
			void retainedDisposal().catch(() => {});
			throw new Error("public disposal deadline");
		});
		vi.spyOn(session, "awaitDisposeCompletion").mockImplementation(async () => {
			await retainedDisposal();
			events.push("retained disposal joined");
		});
		try {
			manager.cancel(jobId);
			await Promise.resolve();
			expect(completed).toBe(false);
			construction.resolve(createSessionResult(session));
			await closing.promise;
			expect(completed).toBe(false);
			expect(events).toEqual([]);
			expect(removeHandle).not.toHaveBeenCalled();
			allowClose.resolve();
			await job.promise;
			expect(events).toEqual(["manager closed", "retained disposal joined", "runner completed"]);
			expect(completed).toBe(true);
			expect(result?.aborted).toBe(true);
			expect(result?.error ?? "").not.toContain("Cleanup failure");
			expect(manager.getLiveHandle(subagentId)).toBeUndefined();
		} finally {
			construction.resolve(createSessionResult(session));
			allowClose.resolve();
			await job.promise;
		}
	});

	it("makes managed publication failure terminal even after a pause", async () => {
		const subagentId = "paused-publication-failure";
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		AsyncJobManager.setInstance(manager);
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			const session = createPauseSession(options ?? {}, subagentId);
			return createSessionResult(session);
		});
		const persistence = Object.create(ManagedTaskPersistence.prototype) as ManagedTaskPersistence;
		vi.spyOn(persistence, "openSession").mockResolvedValue(SessionManager.inMemory("/tmp"));
		vi.spyOn(persistence, "publishOutput").mockRejectedValue(new Error("selector commit failed"));
		const result = await runSubprocess({
			cwd: "/tmp",
			agent: {
				name: "executor",
				description: "test executor",
				systemPrompt: "test",
				source: "bundled",
			},
			task: "pause before failed publication",
			index: 0,
			id: subagentId,
			subagentId,
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [],
				getApiKey: async () => kNoAuth,
			} as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir: "/tmp/managed-artifacts",
			managedPersistence: persistence,
		});
		expect(result.paused).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("Managed output publication failed: selector commit failed");
		expect(result.retryFailure?.errorMessage).toContain("selector commit failed");
	});
});

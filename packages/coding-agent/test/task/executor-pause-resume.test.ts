import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentEvent } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { AsyncJobManager } from "../../src/async/job-manager";
import { Settings } from "../../src/config/settings";
import type { LoadExtensionsResult } from "../../src/extensibility/extensions/types";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "../../src/session/agent-session";
import { runSubprocess } from "../../src/task/executor";
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
		sessionManager: {
			appendSessionInit: () => {},
		},
		getActiveToolNames: () => ["yield"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
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
		dispose: async () => {},
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
			} as unknown as import("../../src/config/model-registry").ModelRegistry,
			enableLsp: false,
		});

		expect(capturedOptions?.shouldPause?.()).toBe(true);
		expect(result.paused).toBe(true);
		expect(result.aborted).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.error).toBeUndefined();
		expect(manager.getLiveHandle(subagentId)).toBeUndefined();
	});
});

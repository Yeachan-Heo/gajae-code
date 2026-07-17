import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Message } from "@gajae-code/ai";
import { AsyncJobManager } from "../../src/async";
import { Settings } from "../../src/config/settings";
import type { CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent } from "../../src/session/agent-session";
import { TaskTool } from "../../src/task";
import * as discoveryModule from "../../src/task/discovery";
import type { AgentDefinition, TaskParams } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import { EventBus } from "../../src/utils/event-bus";

const TEST_AGENT: AgentDefinition = {
	name: "executor",
	description: "Bounded implementation agent",
	systemPrompt: "You are an executor.",
	source: "bundled",
	tools: ["yield"],
};

function createAssistantMessage(text: string): Message {
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

function createYieldingSession(output: string): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as Message[] };
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const assistantMessage = createAssistantMessage(output);

	return {
		state,
		agent: { state: { systemPrompt: ["child-system"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		setActiveToolsByName: async () => {},
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
		prompt: async () => {
			state.messages.push(assistantMessage);
			emit({
				type: "tool_execution_end",
				toolCallId: "yield-call",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
			emit({
				type: "agent_end",
				messages: [assistantMessage],
				stopReason: "completed",
			});
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => state.messages.at(-1),
		abort: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
}

function createSession(sessionFile: string | null): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => sessionFile,
		getArtifactsDir: () => (sessionFile ? sessionFile.slice(0, -6) : null),
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: {} as CreateAgentSessionResult["extensionsResult"],
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

async function runDetachedTask(tool: TaskTool): Promise<string> {
	const manager = new AsyncJobManager({ onJobComplete: async () => {} });
	AsyncJobManager.setInstance(manager);
	const started = await tool.execute("tool-call", {
		agent: "executor",
		tasks: [{ id: "NoSession", description: "produce output", assignment: "Return a result." }],
	} as TaskParams);
	const jobId = started.details?.async?.jobId;
	if (!jobId) throw new Error("Expected detached task job id");
	await manager.waitForAll();
	const resultText = manager.getJob(jobId)?.resultText;
	await manager.dispose({ timeoutMs: 100 });
	return resultText ?? "";
}

describe("task no-session output refs", () => {
	afterEach(() => {
		AsyncJobManager.resetForTests();
		vi.restoreAllMocks();
	});

	it("does not advertise agent:// output refs when the parent has no session artifacts directory", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [TEST_AGENT], projectAgentsDir: null });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(createYieldingSession("child full output that would otherwise be in an artifact")),
		);

		const tool = await TaskTool.create(createSession(null));
		const resultText = await runDetachedTask(tool);

		expect(resultText).toContain("Task completed; output artifact unavailable.");
		expect(resultText).not.toContain("agent://0-NoSession");
		expect(resultText).not.toContain('ref="agent://');
		expect(resultText).not.toContain("output stored in agent://");
	});
});

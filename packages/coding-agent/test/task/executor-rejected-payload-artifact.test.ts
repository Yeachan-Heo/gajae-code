import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { AsyncJobManager } from "../../src/async/job-manager";
import { kNoAuth } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { LoadExtensionsResult } from "../../src/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent } from "../../src/session/agent-session";
import { runSubprocess } from "../../src/task/executor";
import type { AgentDefinition } from "../../src/task/types";
import { EventBus } from "../../src/utils/event-bus";

function createMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "submitted rejected payload" }],
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

function createSession(data: unknown): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const message = createMessage();
	const emit = (event: AgentEvent) => {
		for (const listener of listeners) listener(event);
	};
	return {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
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
			return () => listeners.splice(listeners.indexOf(listener), 1);
		},
		prompt: async () => {
			emit({ type: "message_end", message });
			emit({
				type: "tool_execution_end",
				toolCallId: "yield-large-rejection",
				toolName: "yield",
				result: { content: [], details: { status: "success", data } },
			});
			emit({ type: "agent_end", messages: [message], stopReason: "completed" });
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => message,
		abort: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
}

describe("rejected payload output artifact", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		const manager = AsyncJobManager.instance();
		if (manager) await manager.dispose({ timeoutMs: 100 });
		AsyncJobManager.setInstance(undefined);
	});

	it("truncates only the inline output and preserves the complete rejected envelope artifact", async () => {
		AsyncJobManager.setInstance(new AsyncJobManager({ onJobComplete: async () => {} }));
		const data = { findings: "x".repeat(500_100), tail: "ARTIFACT-LOSSLESS-TAIL-SENTINEL" };
		const session = createSession(data);
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session,
			extensionsResult: {} as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} as CreateAgentSessionResult);
		const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-rejected-payload-"));
		const id = "0-RejectedPayload";
		const agent: AgentDefinition = { name: "executor", description: "test", systemPrompt: "test", source: "bundled" };

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "submit rejected payload",
			index: 0,
			id,
			subagentId: id,
			artifactsDir,
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [],
				getApiKey: async () => kNoAuth,
			} as unknown as import("../../src/config/model-registry").ModelRegistry,
			enableLsp: false,
			outputSchema: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"] },
		});

		const artifact = fs.readFileSync(path.join(artifactsDir, `${id}.md`), "utf8");
		expect(result.truncated).toBe(true);
		expect(result.output.length).toBeLessThan(artifact.length);
		expect(JSON.parse(artifact).data).toEqual(data);
		fs.rmSync(artifactsDir, { recursive: true, force: true });
	});
});

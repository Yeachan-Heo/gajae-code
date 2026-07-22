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
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent } from "../../src/session/agent-session";
import { runSubprocess } from "../../src/task/executor";
import type { AgentDefinition } from "../../src/task/types";
import { EventBus } from "../../src/utils/event-bus";

// A session whose turn completes producing NO assistant output text — mirrors a
// failed/no-op resume leg whose rawOutput is empty.
function createEmptyOutputSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentEvent) => {
		for (const listener of listeners) listener(event);
	};
	const emptyMessage: AssistantMessage = {
		role: "assistant",
		content: [],
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
		stopReason: "error",
		errorMessage: "Provider rejected the request (invalid tool_use/tool_result pairing).",
		timestamp: Date.now(),
	};
	const session = {
		state: { messages: [] as AssistantMessage[] },
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
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async () => {
			emit({ type: "message_end", message: emptyMessage });
			emit({ type: "agent_end", messages: [emptyMessage], stopReason: "completed" });
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => emptyMessage,
		abort: async () => {},
		dispose: async () => {},
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

describe("runSubprocess artifact preservation", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		const manager = AsyncJobManager.instance();
		if (manager) await manager.dispose({ timeoutMs: 100 });
		AsyncJobManager.setInstance(undefined);
	});

	it("does not overwrite an existing output artifact with empty output", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		AsyncJobManager.setInstance(manager);
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options?: CreateAgentSessionOptions) => {
			void options;
			return createSessionResult(createEmptyOutputSession());
		});

		const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifact-preserve-"));
		const id = "0-Preserve";
		const priorArtifact = path.join(artifactsDir, `${id}.md`);
		fs.writeFileSync(priorArtifact, "PRIOR SUCCESS OUTPUT");

		const agent: AgentDefinition = {
			name: "executor",
			description: "test executor",
			systemPrompt: "test",
			source: "bundled",
		};

		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "resume that produces nothing",
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
		});

		// The prior success artifact must survive an empty-output leg.
		expect(fs.readFileSync(priorArtifact, "utf8")).toBe("PRIOR SUCCESS OUTPUT");
		fs.rmSync(artifactsDir, { recursive: true, force: true });
	});
});

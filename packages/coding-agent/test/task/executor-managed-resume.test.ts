import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { AsyncJobManager } from "../../src/async/job-manager";
import { kNoAuth } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { LoadExtensionsResult } from "../../src/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { runSubprocess } from "../../src/task/executor";
import type { AgentDefinition } from "../../src/task/types";
import { EventBus } from "../../src/utils/event-bus";

const originalAgentDir = getAgentDir();
const cleanupRoots: string[] = [];

function createSuccessfulResumeSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "resumed successfully" }],
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
	const emit = (event: AgentEvent) => {
		for (const listener of listeners) listener(event);
	};
	return {
		state: { messages: [message] },
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
			emit({ type: "message_end", message });
			emit({
				type: "tool_execution_end",
				toolCallId: "yield-call",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { resumed: true } },
				},
				isError: false,
			});
			emit({ type: "agent_end", messages: [message], stopReason: "completed" });
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => message,
		abort: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: {} as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

describe("runSubprocess managed child resume", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		const manager = AsyncJobManager.instance();
		if (manager) await manager.dispose({ timeoutMs: 100 });
		AsyncJobManager.setInstance(undefined);
		setAgentDir(originalAgentDir);
		await Promise.all(cleanupRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
	});

	it("opens a trusted child session inside managed storage for resume", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-child-resume-"));
		cleanupRoots.push(root);
		const agentDir = path.join(root, "agent");
		const cwd = path.join(root, "repo");
		await fs.mkdir(cwd, { recursive: true });
		setAgentDir(agentDir);

		const parent = SessionManager.create(cwd);
		const parentFile = parent.getSessionFile();
		if (!parentFile) throw new Error("Expected managed parent session file");
		await parent.close();
		const artifactsDir = parentFile.slice(0, -6);
		await fs.mkdir(artifactsDir, { recursive: true });

		const childFile = path.join(artifactsDir, "0-ManagedChild.jsonl");
		await Bun.write(
			childFile,
			`${[
				JSON.stringify({
					type: "session",
					version: 5,
					id: "managed-child-session",
					timestamp: new Date().toISOString(),
					cwd,
				}),
				JSON.stringify({
					type: "message",
					id: "managed-child-message",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: "initial child turn", timestamp: Date.now() },
				}),
			].join("\n")}\n`,
		);

		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		AsyncJobManager.setInstance(manager);
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(createSuccessfulResumeSession()));
		const agent: AgentDefinition = {
			name: "executor",
			description: "test executor",
			systemPrompt: "test",
			source: "bundled",
		};

		const result = await runSubprocess({
			cwd,
			agent,
			task: "resume managed child",
			index: 0,
			id: "0-ManagedChild",
			subagentId: "0-ManagedChild",
			runMode: "message",
			resumeMessage: "continue",
			sessionFile: childFile,
			artifactsDir,
			persistArtifacts: true,
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [],
				getApiKey: async () => kNoAuth,
			} as unknown as import("../../src/config/model-registry").ModelRegistry,
			enableLsp: false,
		});

		expect(result.exitCode).toBe(0);
		expect(result.error).toBeUndefined();
		expect(result.extractedToolData?.yield).toEqual([
			{ status: "success", data: { resumed: true }, error: undefined },
		]);
	});
});

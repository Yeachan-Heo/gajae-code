import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Message } from "@gajae-code/ai";
import { Snowflake } from "@gajae-code/utils";
import { AsyncJobManager } from "../../src/async";
import { Settings } from "../../src/config/settings";
import { InternalUrlRouter } from "../../src/internal-urls";
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
					// Executor finalizes task output from yield details.data when present.
					content: [{ type: "text", text: output }],
					details: { status: "success", data: { result: output } },
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

function createSession(sessionFile: string | null, sessionId = "test-in-memory-session"): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => sessionFile,
		getSessionId: () => sessionId,
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

async function runDetachedTask(
	tool: TaskTool,
	task: { id: string; description: string; assignment: string } = {
		id: "NoSession",
		description: "produce output",
		assignment: "Return a result.",
	},
): Promise<string> {
	const manager = new AsyncJobManager({ onJobComplete: async () => {} });
	AsyncJobManager.setInstance(manager);
	const started = await tool.execute("tool-call", {
		agent: "executor",
		tasks: [task],
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
		InternalUrlRouter.resetForTests();
		vi.restoreAllMocks();
	});

	it("advertises durable agent:// output refs for in-memory parents and keeps them readable", async () => {
		const childOutput = "child full output that must remain readable after task return";
		const sessionId = `durable-read-${Snowflake.next()}`;
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [TEST_AGENT], projectAgentsDir: null });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(createYieldingSession(childOutput)));

		const session = createSession(null, sessionId);
		const tool = await TaskTool.create(session);
		const resultText = await runDetachedTask(tool);

		const uriMatch = resultText.match(/agent:\/\/(\d+-NoSession)/);
		expect(uriMatch).toBeTruthy();
		const outputId = uriMatch![1]!;
		const outputUri = `agent://${outputId}`;
		expect(resultText).toContain(`output stored in ${outputUri}`);
		expect(resultText).not.toContain("Task completed; output artifact unavailable.");

		const artifactsDir = session.getArtifactsDir?.();
		expect(artifactsDir).toBeTruthy();
		expect(artifactsDir).toContain(path.join("gjc-task-session", sessionId));

		const outputPath = path.join(artifactsDir!, `${outputId}.md`);
		expect(await Bun.file(outputPath).exists()).toBe(true);
		const onDisk = await Bun.file(outputPath).text();
		// Yield finalization persists JSON-serialized yield data; the distinctive payload must survive.
		expect(onDisk).toContain(childOutput);

		const authorized = session.getAuthorizedArtifactsDirs?.() ?? [];
		expect(authorized.some(dir => path.resolve(dir) === path.resolve(artifactsDir!))).toBe(true);

		const resolved = await InternalUrlRouter.instance().resolve(outputUri, {
			cwd: session.cwd,
			getArtifactsDir: () => session.getArtifactsDir?.() ?? null,
			getAuthorizedArtifactsDirs: () => session.getAuthorizedArtifactsDirs?.() ?? [],
		});
		expect(resolved.content).toBe(onDisk);
		expect(resolved.content).toContain(childOutput);

		// Cleanup durable root allocated for this test session
		await fs.rm(artifactsDir!, { recursive: true, force: true });
	});

	it("lets a second detached task resolve the first task's agent:// via the same in-memory parent", async () => {
		const firstOutput = "architect findings for sibling review";
		const secondOutput = "critic reviewed prior output";
		const sessionId = `sibling-read-${Snowflake.next()}`;
		let call = 0;
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [TEST_AGENT], projectAgentsDir: null });
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			call += 1;
			const text = call === 1 ? firstOutput : secondOutput;
			return createSessionResult(createYieldingSession(text));
		});

		const session = createSession(null, sessionId);
		const tool = await TaskTool.create(session);

		const firstText = await runDetachedTask(tool, {
			id: "Architect",
			description: "review code",
			assignment: "Produce findings.",
		});
		const firstUriMatch = firstText.match(/agent:\/\/(\d+-Architect)/);
		expect(firstUriMatch).toBeTruthy();
		const firstUri = `agent://${firstUriMatch![1]!}`;

		const prior = await InternalUrlRouter.instance().resolve(firstUri, {
			cwd: session.cwd,
			getArtifactsDir: () => session.getArtifactsDir?.() ?? null,
			getAuthorizedArtifactsDirs: () => session.getAuthorizedArtifactsDirs?.() ?? [],
		});
		expect(prior.content).toContain(firstOutput);

		const secondText = await runDetachedTask(tool, {
			id: "Critic",
			description: "review prior findings",
			assignment: `Read ${firstUri} and critique.`,
		});
		const secondUriMatch = secondText.match(/agent:\/\/(\d+-Critic)/);
		expect(secondUriMatch).toBeTruthy();

		// Durable root still holds both outputs for same-session descendants
		const artifactsDir = session.getArtifactsDir?.();
		expect(artifactsDir).toBeTruthy();
		expect(await Bun.file(path.join(artifactsDir!, `${firstUriMatch![1]!}.md`)).text()).toContain(firstOutput);
		expect(await Bun.file(path.join(artifactsDir!, `${secondUriMatch![1]!}.md`)).text()).toContain(secondOutput);

		const stillReadable = await InternalUrlRouter.instance().resolve(firstUri, {
			cwd: session.cwd,
			getArtifactsDir: () => session.getArtifactsDir?.() ?? null,
			getAuthorizedArtifactsDirs: () => session.getAuthorizedArtifactsDirs?.() ?? [],
		});
		expect(stillReadable.content).toContain(firstOutput);

		await fs.rm(artifactsDir!, { recursive: true, force: true });
	});

	it("does not advertise agent:// when durable artifact allocation fails", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [TEST_AGENT], projectAgentsDir: null });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(createYieldingSession("output that must not get a dead URI")),
		);

		const realMkdir = fs.mkdir.bind(fs);
		vi.spyOn(fs, "mkdir").mockImplementation(async (dirPath, options) => {
			const target = String(dirPath);
			if (target.includes(`${path.sep}gjc-task-session${path.sep}`) || target.endsWith(`${path.sep}gjc-task-session`)) {
				throw new Error("EACCES: permission denied");
			}
			return realMkdir(dirPath, options as { recursive?: boolean; mode?: number });
		});

		const session = createSession(null, `alloc-fail-${Snowflake.next()}`);
		const tool = await TaskTool.create(session);
		const resultText = await runDetachedTask(tool);

		expect(resultText).toContain("Task completed; output artifact unavailable.");
		expect(resultText).not.toMatch(/agent:\/\/\d+-NoSession/);
		expect(resultText).not.toContain('ref="agent://');
		expect(resultText).not.toContain("output stored in agent://");
		expect(session.getArtifactsDir?.()).toBeNull();
	});
});

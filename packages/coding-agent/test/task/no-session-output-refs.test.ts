import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@gajae-code/ai";
import { Snowflake } from "@gajae-code/utils";
import { AsyncJobManager } from "../../src/async";
import { Settings } from "../../src/config/settings";
import { InternalUrlRouter } from "../../src/internal-urls";
import type { CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent } from "../../src/session/agent-session";
import { ArtifactManager } from "../../src/session/artifacts";
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

function matchAgentOutputId(text: string, taskId: string): RegExpMatchArray | null {
	return text.match(new RegExp(`agent://((?:\\d+-[A-Za-z0-9][A-Za-z0-9_-]{0,47}\\.)*\\d+-${taskId})`));
}

function agentOutputIndex(id: string): number {
	return Number.parseInt(id.split(".").at(-1)!.split("-")[0]!, 10);
}

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

type TestToolSession = ToolSession & { disposeSession: () => Promise<void> };

function createSession(sessionFile: string | null, sessionId = "test-in-memory-session"): TestToolSession {
	const cleanups = new Set<() => Promise<void> | void>();
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => sessionFile,
		getSessionId: () => sessionId,
		getArtifactsDir: () => (sessionFile ? sessionFile.slice(0, -6) : null),
		getSessionSpawns: () => "*",
		registerSessionCleanup: (cleanup: () => Promise<void> | void) => {
			cleanups.add(cleanup);
			return () => cleanups.delete(cleanup);
		},
		disposeSession: async () => {
			const pending = Array.from(cleanups);
			cleanups.clear();
			await Promise.all(pending.map(async cleanup => await cleanup()));
		},
	} as unknown as TestToolSession;
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
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(createYieldingSession(childOutput)),
		);

		const session = createSession(null, sessionId);
		const tool = await TaskTool.create(session);
		const resultText = await runDetachedTask(tool);

		const uriMatch = matchAgentOutputId(resultText, "NoSession");
		expect(uriMatch).toBeTruthy();
		const outputId = uriMatch![1]!;
		const outputUri = `agent://${outputId}`;
		expect(resultText).toContain(`output stored in ${outputUri}`);
		expect(resultText).not.toContain("Task completed; output artifact unavailable.");

		const artifactsDir = session.getArtifactsDir?.();
		expect(artifactsDir).toBeTruthy();
		expect(path.dirname(artifactsDir!)).toBe(path.resolve(os.tmpdir()));
		expect(path.basename(artifactsDir!)).toStartWith("gjc-task-session-");
		expect(artifactsDir).not.toContain(sessionId);

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

		await session.disposeSession();
		expect(await Bun.file(artifactsDir!).exists()).toBe(false);
		expect(session.getArtifactsDir?.()).toBeNull();
	});

	it("shares one root and ID space with authorized descendants but denies foreign trees", async () => {
		const firstOutput = "architect findings for sibling review";
		const secondOutput = "architect second-pass output";
		const sessionId = `sibling-read-${Snowflake.next()}`;
		let call = 0;
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [TEST_AGENT], projectAgentsDir: null });
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			call += 1;
			return createSessionResult(createYieldingSession(call === 1 ? firstOutput : secondOutput));
		});

		const session = createSession(null, sessionId);
		const priorAuthorizedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-prior-authorized-"));
		await Bun.write(path.join(priorAuthorizedRoot, "0-Historical.md"), "historical output");
		session.getAuthorizedArtifactsDirs = () => [priorAuthorizedRoot];
		const firstTool = await TaskTool.create(session);
		const secondTool = await TaskTool.create(session);
		const firstText = await runDetachedTask(firstTool, {
			id: "Architect",
			description: "review code",
			assignment: "Produce findings.",
		});
		const firstUriMatch = matchAgentOutputId(firstText, "Architect");
		expect(firstUriMatch).toBeTruthy();
		expect(agentOutputIndex(firstUriMatch![1]!)).toBe(0);
		const firstUri = `agent://${firstUriMatch![1]!}`;
		const firstArtifactsDir = session.getArtifactsDir?.();
		expect(firstArtifactsDir).toBeTruthy();

		const descendantRead = await InternalUrlRouter.instance().resolve(firstUri, {
			cwd: session.cwd,
			getArtifactsDir: () => null,
			getAuthorizedArtifactsDirs: () => session.getAuthorizedArtifactsDirs?.() ?? [],
		});
		expect(descendantRead.content).toContain(firstOutput);

		const secondText = await runDetachedTask(secondTool, {
			id: "Architect",
			description: "review prior findings",
			assignment: `Read ${firstUri} and critique.`,
		});
		const secondUriMatch = matchAgentOutputId(secondText, "Architect");
		expect(secondUriMatch).toBeTruthy();
		expect(secondUriMatch![1]).not.toBe(firstUriMatch![1]);
		expect(agentOutputIndex(secondUriMatch![1]!)).toBeGreaterThan(agentOutputIndex(firstUriMatch![1]!));

		const artifactsDir = session.getArtifactsDir?.();
		expect(artifactsDir).toBe(firstArtifactsDir);
		expect(await Bun.file(path.join(artifactsDir!, `${firstUriMatch![1]!}.md`)).text()).toContain(firstOutput);
		expect(await Bun.file(path.join(artifactsDir!, `${secondUriMatch![1]!}.md`)).text()).toContain(secondOutput);

		const foreignRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-foreign-"));
		try {
			await expect(
				InternalUrlRouter.instance().resolve(firstUri, {
					cwd: session.cwd,
					getArtifactsDir: () => foreignRoot,
					getAuthorizedArtifactsDirs: () => [],
				}),
			).rejects.toThrow(`agent://${firstUriMatch![1]!} not found`);
		} finally {
			await fs.rm(foreignRoot, { recursive: true, force: true });
			await session.disposeSession();
			await fs.rm(priorAuthorizedRoot, { recursive: true, force: true });
		}
		expect(await Bun.file(artifactsDir!).exists()).toBe(false);
	});

	it("adopts its owned manager instead of a foreign manager without a primary root", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [TEST_AGENT], projectAgentsDir: null });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(createYieldingSession("owned manager output")),
		);
		const foreignRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-foreign-manager-"));
		const foreignManager = new ArtifactManager(foreignRoot);
		const session = createSession(null, `foreign-manager-${Snowflake.next()}`);
		session.getArtifactManager = () => foreignManager;
		const tool = await TaskTool.create(session);
		const resultText = await runDetachedTask(tool);
		expect(matchAgentOutputId(resultText, "NoSession")).toBeTruthy();
		const artifactsDir = session.getArtifactsDir?.();
		expect(artifactsDir).toBeTruthy();
		expect(path.resolve(session.getArtifactManager?.()?.dir ?? "")).toBe(path.resolve(artifactsDir!));
		expect((await fs.readdir(foreignRoot)).filter(name => name.endsWith(".md"))).toHaveLength(0);
		await session.disposeSession();
		expect(session.getArtifactManager?.()).toBe(foreignManager);
		await fs.rm(foreignRoot, { recursive: true, force: true });
	});

	it("does not allocate durable output when session cleanup is unavailable", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [TEST_AGENT], projectAgentsDir: null });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(createYieldingSession("must remain unavailable")),
		);
		const session = createSession(null, `no-cleanup-${Snowflake.next()}`);
		session.registerSessionCleanup = undefined;
		const tool = await TaskTool.create(session);
		const resultText = await runDetachedTask(tool);
		expect(resultText).toContain("Task completed; output artifact unavailable.");
		expect(resultText).not.toContain("agent://");
		expect(session.getArtifactsDir?.()).toBeNull();
	});

	it("namespaces identical task IDs across independent authorized roots", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [TEST_AGENT], projectAgentsDir: null });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(createYieldingSession("independent root output")),
		);
		const firstSession = createSession(null, `root-a-${Snowflake.next()}`);
		const secondSession = createSession(null, `root-b-${Snowflake.next()}`);
		const firstText = await runDetachedTask(await TaskTool.create(firstSession));
		const secondText = await runDetachedTask(await TaskTool.create(secondSession));
		const firstId = matchAgentOutputId(firstText, "NoSession")?.[1];
		const secondId = matchAgentOutputId(secondText, "NoSession")?.[1];
		expect(firstId).toBeTruthy();
		expect(secondId).toBeTruthy();
		expect(firstId).not.toBe(secondId);
		const roots = [firstSession.getArtifactsDir?.(), secondSession.getArtifactsDir?.()].filter(
			(root): root is string => Boolean(root),
		);
		expect(roots).toHaveLength(2);
		for (const id of [firstId!, secondId!]) {
			const resolved = await InternalUrlRouter.instance().resolve(`agent://${id}`, {
				cwd: "/tmp",
				getArtifactsDir: () => null,
				getAuthorizedArtifactsDirs: () => roots,
			});
			expect(resolved.content).toContain("independent root output");
		}
		await Promise.all([firstSession.disposeSession(), secondSession.disposeSession()]);
	});

	it("rolls back durable authorization when cleanup registration throws", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [TEST_AGENT], projectAgentsDir: null });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(createYieldingSession("must not survive cleanup registration failure")),
		);
		const session = createSession(null, `cleanup-throw-${Snowflake.next()}`);
		session.registerSessionCleanup = () => {
			throw new Error("cleanup registry unavailable");
		};
		const resultText = await runDetachedTask(await TaskTool.create(session));
		expect(resultText).toContain("Task completed; output artifact unavailable.");
		expect(matchAgentOutputId(resultText, "NoSession")).toBeNull();
		expect(session.getArtifactsDir?.()).toBeNull();
		expect(session.getAuthorizedArtifactsDirs?.() ?? []).toEqual([]);
	});

	it("keeps a failed-allocation child and its resume non-durable, then retries a later batch", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [TEST_AGENT], projectAgentsDir: null });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(createYieldingSession("output that must remain durable")),
		);
		vi.spyOn(fs, "mkdtemp").mockRejectedValueOnce(new Error("EACCES: permission denied"));

		const session = createSession(null, `alloc-fail-${Snowflake.next()}`);
		const tool = await TaskTool.create(session);
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		AsyncJobManager.setInstance(manager);
		const execute = async () => {
			const started = await tool.execute("tool-call", {
				agent: "executor",
				tasks: [{ id: "NoSession", description: "produce output", assignment: "Return a result." }],
			} as TaskParams);
			const jobId = started.details?.async?.jobId;
			if (!jobId) throw new Error("Expected detached task job id");
			await manager.waitForAll();
			return manager.getJob(jobId)?.resultText ?? "";
		};

		const failedText = await execute();
		expect(failedText).toContain("Task completed; output artifact unavailable.");
		expect(matchAgentOutputId(failedText, "NoSession")).toBeNull();
		expect(session.getArtifactsDir?.()).toBeNull();

		const record = manager.getSubagentRecords()[0];
		expect(record?.resumable).toBe(true);
		const resumed = manager.resumeSubagent(record!.subagentId, undefined, "continue");
		expect(resumed.ok).toBe(true);
		await manager.waitForAll();
		const resumedText = manager.getJob(resumed.jobId!)?.resultText ?? "";
		expect(resumedText).toContain("Task completed; output artifact unavailable.");
		expect(matchAgentOutputId(resumedText, record!.subagentId)).toBeNull();
		expect(session.getArtifactsDir?.()).toBeNull();

		const retriedText = await execute();
		expect(matchAgentOutputId(retriedText, "NoSession")).toBeTruthy();
		const artifactsDir = session.getArtifactsDir?.();
		expect(artifactsDir).toBeTruthy();
		await manager.dispose({ timeoutMs: 100 });
		await session.disposeSession();
		expect(await Bun.file(artifactsDir!).exists()).toBe(false);
	});
});

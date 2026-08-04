import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel, type Message } from "@gajae-code/ai";
import { getAgentDir, Snowflake, setAgentDir } from "@gajae-code/utils";
import { AsyncJobManager } from "../../src/async";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { ExtensionRunner } from "../../src/extensibility/extensions/runner";
import * as internalUrls from "../../src/internal-urls";
import type { CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import { AgentSession, type AgentSessionEvent } from "../../src/session/agent-session";
import { ArtifactManager } from "../../src/session/artifacts";
import { AuthStorage } from "../../src/session/auth-storage";
import { CURRENT_SESSION_VERSION, SessionManager, SessionManagerTestHooks } from "../../src/session/session-manager";
import { FileSessionStorage } from "../../src/session/session-storage";
import { TaskTool } from "../../src/task";
import * as discoveryModule from "../../src/task/discovery";
import type { AgentDefinition, TaskParams } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import { EventBus } from "../../src/utils/event-bus";

const { InternalUrlRouter } = internalUrls;

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

async function pathExists(target: string): Promise<boolean> {
	return fs.stat(target).then(
		() => true,
		() => false,
	);
}

async function waitForPathRemoval(target: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (!(await pathExists(target))) return;
		await Bun.sleep(5);
	}
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
		expect(await pathExists(artifactsDir!)).toBe(false);
		expect(session.getArtifactsDir?.()).toBeNull();
	});

	it("keeps a nested subagent on the adopted parent artifact store", async () => {
		const grandchildOutput = "grandchild output that must land in the shared parent root";
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [TEST_AGENT], projectAgentsDir: null });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(createYieldingSession(grandchildOutput)),
		);

		const parentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-parent-root-"));
		const parentManager = new ArtifactManager(parentRoot);
		// A subagent session file lives inside the parent artifact root, and its
		// SessionManager adopts the parent manager instead of exposing its own dir.
		const session = createSession(path.join(parentRoot, "0-Child.jsonl"), `nested-${Snowflake.next()}`);
		session.getArtifactsDir = () => null;
		session.getArtifactManager = () => parentManager;
		session.isArtifactManagerAuthorized = manager => manager === parentManager;

		try {
			const resultText = await runDetachedTask(await TaskTool.create(session));
			const outputId = matchAgentOutputId(resultText, "NoSession")?.[1];
			expect(outputId).toBeTruthy();

			const sharedOutput = path.join(parentRoot, `${outputId}.md`);
			expect(await Bun.file(sharedOutput).text()).toContain(grandchildOutput);
			expect(await Bun.file(path.join(parentRoot, "0-Child", `${outputId}.md`)).exists()).toBe(false);

			const resolved = await InternalUrlRouter.instance().resolve(`agent://${outputId}`, {
				cwd: session.cwd,
				getArtifactsDir: () => parentRoot,
				getAuthorizedArtifactsDirs: () => [parentRoot],
			});
			expect(resolved.content).toContain(grandchildOutput);
		} finally {
			await session.disposeSession();
			await fs.rm(parentRoot, { recursive: true, force: true });
		}
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
		expect(await pathExists(artifactsDir!)).toBe(false);
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

	it("reuses an authorized ephemeral manager and preserves one numeric artifact ID space", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [TEST_AGENT], projectAgentsDir: null });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(createYieldingSession("shared ephemeral manager output")),
		);
		const owner = SessionManager.inMemory("/tmp");
		expect(await owner.saveArtifact("before task", "bash")).toBe("0");
		const manager = owner.getArtifactManager()!;
		const root = manager.dir;
		const session = createSession(null, `ephemeral-manager-${Snowflake.next()}`);
		session.getArtifactManager = () => owner.getArtifactManager();
		session.isArtifactManagerAuthorized = candidate => owner.isArtifactManagerAuthorized(candidate);

		const resultText = await runDetachedTask(await TaskTool.create(session));
		const outputId = matchAgentOutputId(resultText, "NoSession")?.[1];
		expect(outputId).toBeTruthy();
		expect(await Bun.file(path.join(root, `${outputId}.md`)).exists()).toBe(true);
		expect(session.getArtifactsDir?.()).toBeNull();
		expect(session.getArtifactManager?.()).toBe(manager);
		expect(await owner.saveArtifact("after task", "bash")).toBe("1");
		expect((await fs.readdir(root)).filter(name => /^\d+\..*\.log$/.test(name)).sort()).toEqual([
			"0.bash.log",
			"1.bash.log",
		]);

		await session.disposeSession();
		await owner.close();
		expect(
			await fs.stat(root).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});

	it("adopts a task-first fallback manager before later parent artifact saves", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [TEST_AGENT], projectAgentsDir: null });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(createYieldingSession("task-first child output")),
		);
		const owner = SessionManager.inMemory("/tmp");
		const session = createSession(null, `task-first-${Snowflake.next()}`);
		session.getArtifactManager = () => owner.getArtifactManager();
		session.isArtifactManagerAuthorized = candidate => owner.isArtifactManagerAuthorized(candidate);
		session.adoptArtifactManager = manager => owner.adoptArtifactManager(manager);
		session.releaseArtifactManager = manager => owner.releaseArtifactManager(manager);
		session.getAuthorizedArtifactsDirs = () => {
			const manager = owner.getArtifactManager();
			return manager ? [manager.dir] : [];
		};

		const resultText = await runDetachedTask(await TaskTool.create(session));
		const outputId = matchAgentOutputId(resultText, "NoSession")?.[1];
		expect(outputId).toBeTruthy();
		const adoptedManager = owner.getArtifactManager();
		expect(adoptedManager).toBeTruthy();
		expect(session.getArtifactManager?.()).toBe(adoptedManager);
		expect(owner.isArtifactManagerAuthorized(adoptedManager!)).toBe(true);

		const childArtifactId = await adoptedManager!.save("child task artifact", "task");
		const parentArtifactId = await owner.saveArtifact("later parent artifact", "bash");
		expect(childArtifactId).toBe("0");
		expect(parentArtifactId).toBe("1");
		expect(session.getAuthorizedArtifactsDirs?.().map(dir => path.resolve(dir))).toEqual([
			path.resolve(adoptedManager!.dir),
		]);

		const context = {
			cwd: session.cwd,
			getArtifactsDir: () => session.getArtifactsDir?.() ?? null,
			getAuthorizedArtifactsDirs: () => session.getAuthorizedArtifactsDirs?.() ?? [],
		};
		const childResolved = await InternalUrlRouter.instance().resolve(`artifact://${childArtifactId}`, context);
		const parentResolved = await InternalUrlRouter.instance().resolve(`artifact://${parentArtifactId}`, context);
		expect(childResolved.content).toBe("child task artifact");
		expect(parentResolved.content).toBe("later parent artifact");
		expect(await Bun.file(path.join(adoptedManager!.dir, `${outputId}.md`)).exists()).toBe(true);

		const root = adoptedManager!.dir;
		await session.disposeSession();
		await owner.close();
		expect(await pathExists(root)).toBe(false);
	});

	it("linearizes parent first-save with first task artifact initialization", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [TEST_AGENT], projectAgentsDir: null });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(createYieldingSession("concurrent task output")),
		);
		const owner = SessionManager.inMemory("/tmp");
		const session = createSession(null, `concurrent-artifacts-${Snowflake.next()}`);
		session.getArtifactManager = () => owner.getArtifactManager();
		session.isArtifactManagerAuthorized = candidate => owner.isArtifactManagerAuthorized(candidate);
		session.adoptArtifactManager = manager => owner.adoptArtifactManager(manager);
		session.releaseArtifactManager = manager => owner.releaseArtifactManager(manager);
		session.getAuthorizedArtifactsDirs = () => {
			const manager = owner.getArtifactManager();
			return manager ? [manager.dir] : [];
		};
		const initializationEntered = Promise.withResolvers<void>();
		const releaseInitialization = Promise.withResolvers<void>();
		const taskEnsureEntered = Promise.withResolvers<void>();
		SessionManagerTestHooks.beforeEphemeralArtifactManagerInstall = async () => {
			initializationEntered.resolve();
			await releaseInitialization.promise;
		};
		session.ensureArtifactManager = async () => {
			taskEnsureEntered.resolve();
			return owner.ensureArtifactManager();
		};

		let root: string | undefined;
		try {
			const tool = await TaskTool.create(session);
			const parentSave = owner.saveArtifact("concurrent parent artifact", "bash");
			await initializationEntered.promise;
			const taskRun = runDetachedTask(tool);
			await taskEnsureEntered.promise;
			expect(owner.getArtifactManager()).toBeNull();
			releaseInitialization.resolve();

			const [parentArtifactId, resultText] = await Promise.all([parentSave, taskRun]);
			expect(parentArtifactId).toBe("0");
			expect(matchAgentOutputId(resultText, "NoSession")).toBeTruthy();
			const canonicalManager = owner.getArtifactManager();
			expect(canonicalManager).toBeTruthy();
			expect(session.getArtifactManager?.()).toBe(canonicalManager);
			expect(owner.isArtifactManagerAuthorized(canonicalManager!)).toBe(true);
			root = canonicalManager!.dir;

			const childArtifactId = await canonicalManager!.save("concurrent child artifact", "task");
			expect(childArtifactId).toBe("1");
			expect(session.getAuthorizedArtifactsDirs?.().map(dir => path.resolve(dir))).toEqual([path.resolve(root)]);
			const context = {
				cwd: session.cwd,
				getArtifactsDir: () => session.getArtifactsDir?.() ?? null,
				getAuthorizedArtifactsDirs: () => session.getAuthorizedArtifactsDirs?.() ?? [],
			};
			expect((await InternalUrlRouter.instance().resolve("artifact://0", context)).content).toBe(
				"concurrent parent artifact",
			);
			expect((await InternalUrlRouter.instance().resolve("artifact://1", context)).content).toBe(
				"concurrent child artifact",
			);
			expect((await fs.readdir(root)).filter(name => /^\.artifact-id-|^\d+\..*\.log$/.test(name)).sort()).toEqual([
				".artifact-id-0",
				".artifact-id-1",
				"0.bash.log",
				"1.task.log",
			]);
		} finally {
			SessionManagerTestHooks.beforeEphemeralArtifactManagerInstall = undefined;
			releaseInitialization.resolve();
			await session.disposeSession();
			await owner.close();
		}
		if (!root) throw new Error("Expected canonical artifact root");
		expect(await pathExists(root)).toBe(false);
		expect(owner.getArtifactManager()).toBeNull();
	});

	it("keeps the canonical manager owned when task authorization registration fails", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [TEST_AGENT], projectAgentsDir: null });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(createYieldingSession("canonical rollback output")),
		);
		const owner = SessionManager.inMemory("/tmp");
		const session = createSession(null, `canonical-rollback-${Snowflake.next()}`);
		session.getArtifactManager = () => owner.getArtifactManager();
		session.isArtifactManagerAuthorized = candidate => owner.isArtifactManagerAuthorized(candidate);
		session.ensureArtifactManager = () => owner.ensureArtifactManager();
		session.getAuthorizedArtifactsDirs = () => {
			const manager = owner.getArtifactManager();
			return manager ? [manager.dir] : [];
		};
		session.registerSessionCleanup = () => {
			throw new Error("cleanup registry unavailable");
		};

		const resultText = await runDetachedTask(await TaskTool.create(session));
		expect(resultText).toContain("Task completed; output artifact unavailable.");
		expect(matchAgentOutputId(resultText, "NoSession")).toBeNull();
		const manager = owner.getArtifactManager();
		expect(manager).toBeTruthy();
		expect(owner.isArtifactManagerAuthorized(manager!)).toBe(true);
		expect(session.getArtifactsDir?.()).toBeNull();
		expect(await owner.saveArtifact("parent survives task rollback", "bash")).toBe("0");
		const resolved = await InternalUrlRouter.instance().resolve("artifact://0", {
			cwd: session.cwd,
			getArtifactsDir: () => null,
			getAuthorizedArtifactsDirs: () => session.getAuthorizedArtifactsDirs?.() ?? [],
		});
		expect(resolved.content).toBe("parent survives task rollback");

		const root = manager!.dir;
		await owner.close();
		expect(await pathExists(root)).toBe(false);
		expect(owner.isArtifactManagerAuthorized(manager!)).toBe(false);
	});

	it("keeps SessionManager ephemeral artifacts readable when resume rolls back after adoption", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-ephemeral-resume-rollback-"));
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		let runtime: AgentSession | undefined;
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled test model");
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			const owner = SessionManager.inMemory(cwd, new FileSessionStorage());
			runtime = new AgentSession({
				agent: new Agent({
					getApiKey: () => "test-key",
					initialState: { model, systemPrompt: ["Test"], tools: [] },
				}),
				sessionManager: owner,
				settings: Settings.isolated(),
				modelRegistry: new ModelRegistry(authStorage, path.join(cwd, "models.yml")),
			});

			expect(await owner.saveArtifact("ephemeral predecessor", "bash")).toBe("0");
			const predecessorManager = owner.getArtifactManager()!;
			const predecessorRoot = predecessorManager.dir;
			const targetFile = path.join(cwd, "existing-populated.jsonl");
			await Bun.write(
				targetFile,
				`${JSON.stringify({
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: "ephemeral-rollback-target",
					timestamp: "2026-08-04T00:00:00.000Z",
					cwd,
				})}\n${JSON.stringify({
					type: "message",
					id: "target-message",
					parentId: null,
					timestamp: "2026-08-04T00:00:01.000Z",
					message: { role: "user", content: "target", timestamp: 1 },
				})}\n`,
			);
			const context = {
				cwd,
				getArtifactsDir: () => owner.getArtifactManager()?.dir ?? null,
				getAuthorizedArtifactsDirs: () => {
					const manager = owner.getArtifactManager();
					return manager ? [manager.dir] : [];
				},
			};

			const ensureOnDisk = vi
				.spyOn(owner, "ensureOnDisk")
				.mockRejectedValueOnce(new Error("injected post-adoption resume failure"));
			await expect(runtime.switchSession(targetFile)).rejects.toThrow("injected post-adoption resume failure");
			ensureOnDisk.mockRestore();
			expect(owner.getArtifactManager()).toBe(predecessorManager);
			expect(owner.isArtifactManagerAuthorized(predecessorManager)).toBe(true);
			expect(await pathExists(predecessorRoot)).toBe(true);
			expect((await InternalUrlRouter.instance().resolve("artifact://0", context)).content).toBe(
				"ephemeral predecessor",
			);

			expect(await runtime.switchSession(targetFile)).toBe(true);
			await waitForPathRemoval(predecessorRoot);
			expect(await pathExists(predecessorRoot)).toBe(false);
			expect(owner.isArtifactManagerAuthorized(predecessorManager)).toBe(false);
			expect(owner.getArtifactManager()?.dir).toBe(targetFile.slice(0, -6));
		} finally {
			if (runtime) await runtime.dispose();
			authStorage.close();
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("stages task fallback authority for managed legacy-local resume and restores it on rollback", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-task-first-resume-"));
		const agentDir = path.join(cwd, "agent");
		const originalAgentDir = getAgentDir();
		setAgentDir(agentDir);
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		let runtime: AgentSession | undefined;
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled test model");
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			const destination = SessionManager.managedDestination(cwd, agentDir);
			const target = SessionManager.create(cwd, destination);
			target.appendMessage({ role: "user", content: "managed target", timestamp: 1 });
			await target.ensureOnDisk();
			const targetFile = target.getSessionFile();
			if (!targetFile) throw new Error("Expected managed target session file");
			const targetSessionId = target.getSessionId();
			const targetLocalRoot = internalUrls.resolveLocalRoot({
				isManagedDestination: () => true,
				getSessionId: () => targetSessionId,
			});
			await target.close();
			const legacyLocalDir = path.join(targetFile.slice(0, -6), "local");
			await fs.mkdir(legacyLocalDir, { recursive: true });
			await Bun.write(path.join(legacyLocalDir, "legacy.txt"), "managed legacy payload");

			const owner = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
			const currentFile = owner.getSessionFile();
			expect(currentFile).toBeTruthy();
			expect(currentFile).not.toBe(targetFile);
			runtime = new AgentSession({
				agent: new Agent({
					getApiKey: () => "test-key",
					initialState: { model, systemPrompt: ["Test"], tools: [] },
				}),
				sessionManager: owner,
				settings: Settings.isolated(),
				modelRegistry: new ModelRegistry(authStorage, path.join(cwd, "models.yml")),
			});
			const fallbackRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-task-fallback-"));
			const fallbackManager = new ArtifactManager(fallbackRoot);
			expect(await fallbackManager.save("fallback predecessor", "task")).toBe("0");
			owner.adoptArtifactManager(fallbackManager);
			runtime.registerToolSessionTransitionCleanup(async () => {
				owner.releaseArtifactManager(fallbackManager);
				await fs.rm(fallbackRoot, { recursive: true, force: true });
			});

			const readiness = vi
				.spyOn(internalUrls, "initializeLocalRoot")
				.mockRejectedValueOnce(new Error("injected managed local-root failure"));
			await expect(runtime.switchSession(targetFile)).rejects.toThrow("injected managed local-root failure");
			readiness.mockRestore();
			expect(owner.getSessionFile()).toBe(currentFile);
			expect(owner.getArtifactManager()).toBe(fallbackManager);
			expect(owner.isArtifactManagerAuthorized(fallbackManager)).toBe(true);
			expect(await fallbackManager.getPath("0")).toBe(path.join(fallbackRoot, "0.task.log"));
			expect(await Bun.file((await fallbackManager.getPath("0"))!).text()).toBe("fallback predecessor");
			expect(await pathExists(path.join(targetLocalRoot, ".gjc-local-legacy-migrated-v1"))).toBe(false);

			expect(await runtime.switchSession(targetFile)).toBe(true);
			expect(await pathExists(fallbackRoot)).toBe(false);
			expect(owner.isArtifactManagerAuthorized(fallbackManager)).toBe(false);
			const localPath = internalUrls.resolveLocalUrlToPath("local://legacy.txt", {
				getArtifactsDir: () => owner.getArtifactsDir(),
				isManagedDestination: () => owner.isManagedDestination(),
				getManagedLegacyLocalMigrationSource: () => owner.getManagedLegacyLocalMigrationSource(),
				getSessionId: () => owner.getSessionId(),
			});
			expect(await Bun.file(localPath).text()).toBe("managed legacy payload");
			expect(path.dirname(localPath)).toBe(targetLocalRoot);
			const migrationMarker = await Bun.file(
				path.join(path.dirname(localPath), ".gjc-local-legacy-migrated-v1"),
			).text();
			expect(["verified\n", "cleanup_pending\n"]).toContain(migrationMarker);
			expect(migrationMarker).not.toBe("absent\n");
			expect(path.resolve(localPath)).not.toStartWith(path.resolve(legacyLocalDir));
		} finally {
			if (runtime) await runtime.dispose();
			authStorage.close();
			setAgentDir(originalAgentDir);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("settles a live detached task before resume retires its captured artifact root", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-detached-task-resume-"));
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		const asyncManager = new AsyncJobManager({ onJobComplete: async () => {} });
		AsyncJobManager.setInstance(asyncManager);
		let runtime: AgentSession | undefined;
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-20250514");
			if (!model) throw new Error("Expected bundled test model");
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			const owner = SessionManager.inMemory(cwd, new FileSessionStorage());
			runtime = new AgentSession({
				agent: new Agent({
					getApiKey: () => "test-key",
					initialState: { model, systemPrompt: ["Test"], tools: [] },
				}),
				sessionManager: owner,
				settings: Settings.isolated(),
				modelRegistry: new ModelRegistry(authStorage, path.join(cwd, "models.yml")),
				agentId: "owner",
			});
			expect(await owner.saveArtifact("predecessor artifact", "bash")).toBe("0");
			const predecessorManager = owner.getArtifactManager()!;
			const predecessorRoot = predecessorManager.dir;
			const lateWriteFinished = Promise.withResolvers<void>();
			const lateWriteObservedRoot = Promise.withResolvers<boolean>();
			const jobId = asyncManager.register(
				"task",
				"detached predecessor task",
				async ({ signal }) => {
					if (!signal.aborted)
						await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
					lateWriteObservedRoot.resolve(await pathExists(predecessorRoot));
					await Bun.write(path.join(predecessorRoot, "late-task.md"), "settled before retirement");
					lateWriteFinished.resolve();
					return "cancelled";
				},
				{
					id: "detached-predecessor-job",
					ownerId: "owner",
					metadata: { subagent: { id: "detached-child", agent: "executor", agentSource: "bundled" } },
				},
			);
			asyncManager.registerSubagentRecord({
				subagentId: "detached-child",
				ownerId: "owner",
				currentJobId: jobId,
				historicalJobIds: [],
				status: "running",
				sessionFile: null,
				resumable: true,
			});

			const targetFile = path.join(cwd, "detached-target.jsonl");
			await Bun.write(
				targetFile,
				`${JSON.stringify({
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: "detached-target",
					timestamp: "2026-08-04T00:00:00.000Z",
					cwd,
				})}\n${JSON.stringify({
					type: "message",
					id: "detached-target-message",
					parentId: null,
					timestamp: "2026-08-04T00:00:01.000Z",
					message: { role: "user", content: "successor", timestamp: 1 },
				})}\n`,
			);

			expect(await runtime.switchSession(targetFile)).toBe(true);
			await lateWriteFinished.promise;
			expect(await lateWriteObservedRoot.promise).toBe(true);
			await waitForPathRemoval(predecessorRoot);
			expect(await pathExists(predecessorRoot)).toBe(false);
			await Bun.sleep(25);
			expect(await pathExists(predecessorRoot)).toBe(false);
			expect(asyncManager.getSubagentRecord("detached-child")).toBeUndefined();
			expect(asyncManager.getJob(jobId)?.status).not.toBe("running");
			expect(owner.isArtifactManagerAuthorized(predecessorManager)).toBe(false);
			const successorManager = owner.getArtifactManager();
			expect(successorManager).toBeTruthy();
			expect(successorManager!.dir).toBe(targetFile.slice(0, -6));
			expect(await Bun.file(path.join(successorManager!.dir, "late-task.md")).exists()).toBe(false);
			expect(await owner.saveArtifact("successor artifact", "bash")).toBe("0");
		} finally {
			if (runtime) await runtime.dispose();
			await asyncManager.dispose({ timeoutMs: 100 });
			AsyncJobManager.setInstance(undefined);
			authStorage.close();
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
	it("retires a task-first fallback on resume and restores the persisted artifact root", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [TEST_AGENT], projectAgentsDir: null });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(createYieldingSession("task-first resume output")),
		);
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-first-resume-"));
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		let runtime: AgentSession | undefined;
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled test model");
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
			const owner = SessionManager.inMemory(cwd, new FileSessionStorage());
			let hookSession: TestToolSession | undefined;
			let hookFallbackManager: ArtifactManager | undefined;
			let hookFallbackRoot: string | undefined;
			let hookObservation:
				| { rootExists: boolean; fallbackAuthorized: boolean; currentManager: ArtifactManager | null }
				| undefined;
			const extensionRunner = {
				hasHandlers: vi.fn(() => false),
				emit: vi.fn(async (event: { type: string }) => {
					if (event.type !== "session_switch" || !hookSession || !hookFallbackManager || !hookFallbackRoot) return;
					hookObservation = {
						rootExists: await pathExists(hookFallbackRoot),
						fallbackAuthorized: owner.isArtifactManagerAuthorized(hookFallbackManager),
						currentManager: hookSession.getArtifactManager?.() ?? null,
					};
				}),
			} as unknown as ExtensionRunner;
			runtime = new AgentSession({
				agent: new Agent({
					getApiKey: () => "test-key",
					initialState: { model, systemPrompt: ["Test"], tools: [] },
				}),
				sessionManager: owner,
				settings: Settings.isolated(),
				modelRegistry,
				extensionRunner,
			});

			let transitionCleanupCount = 0;
			const session = createSession(null, `task-first-resume-${Snowflake.next()}`);
			hookSession = session;
			session.getArtifactManager = () => owner.getArtifactManager();
			session.isArtifactManagerAuthorized = candidate => owner.isArtifactManagerAuthorized(candidate);
			session.adoptArtifactManager = manager => owner.adoptArtifactManager(manager);
			session.releaseArtifactManager = manager => owner.releaseArtifactManager(manager);
			session.getAuthorizedArtifactsDirs = () => {
				const manager = owner.getArtifactManager();
				return manager ? [manager.dir] : [];
			};
			let disposalCleanupCount = 0;
			runtime.registerToolSessionCleanup(() => {
				disposalCleanupCount++;
			});
			session.registerSessionCleanup = cleanup =>
				runtime!.registerToolSessionTransitionCleanup(async () => {
					transitionCleanupCount++;
					await cleanup();
				});

			const targetFile = path.join(cwd, "existing-populated.jsonl");
			await Bun.write(
				targetFile,
				`${JSON.stringify({
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: "persisted-target",
					timestamp: "2026-08-04T00:00:00.000Z",
					cwd,
				})}\n${JSON.stringify({
					type: "message",
					id: "persisted-message",
					parentId: null,
					timestamp: "2026-08-04T00:00:01.000Z",
					message: { role: "user", content: "persisted target", timestamp: 1 },
				})}\n`,
			);
			const persistedManager = new ArtifactManager(targetFile.slice(0, -6));
			expect(await persistedManager.save("persisted before restart", "read")).toBe("0");

			await runDetachedTask(await TaskTool.create(session));
			const fallbackManager = owner.getArtifactManager();
			expect(fallbackManager).toBeTruthy();
			expect(await fallbackManager!.save("task predecessor artifact", "task")).toBe("0");
			expect(await owner.saveArtifact("parent predecessor artifact", "bash")).toBe("1");
			const fallbackRoot = fallbackManager!.dir;
			hookFallbackManager = fallbackManager!;
			hookFallbackRoot = fallbackRoot;

			const ensureOnDisk = vi
				.spyOn(owner, "ensureOnDisk")
				.mockRejectedValueOnce(new Error("injected pre-commit failure"));
			await expect(runtime.switchSession(targetFile)).rejects.toThrow("injected pre-commit failure");
			ensureOnDisk.mockRestore();
			expect(transitionCleanupCount).toBe(0);
			expect(disposalCleanupCount).toBe(0);
			expect(await pathExists(fallbackRoot)).toBe(true);
			expect(owner.getArtifactManager()).toBe(fallbackManager);
			expect(owner.isArtifactManagerAuthorized(fallbackManager!)).toBe(true);
			expect(session.getArtifactManager?.()).toBe(fallbackManager);

			expect(await runtime.switchSession(targetFile)).toBe(true);
			expect(await pathExists(fallbackRoot)).toBe(false);
			expect(transitionCleanupCount).toBe(1);
			expect(disposalCleanupCount).toBe(0);
			const resumedManager = owner.getArtifactManager();
			expect(resumedManager).toBeTruthy();
			expect(resumedManager).not.toBe(fallbackManager);
			expect(resumedManager!.dir).toBe(targetFile.slice(0, -6));
			expect(owner.isArtifactManagerAuthorized(fallbackManager!)).toBe(false);
			expect(owner.isArtifactManagerAuthorized(resumedManager!)).toBe(true);
			expect(session.getArtifactManager?.()).toBe(resumedManager);
			expect(hookObservation).toEqual({
				rootExists: false,
				fallbackAuthorized: false,
				currentManager: resumedManager,
			});

			const context = {
				cwd,
				getArtifactsDir: () => session.getArtifactsDir?.() ?? null,
				getAuthorizedArtifactsDirs: () => session.getAuthorizedArtifactsDirs?.() ?? [],
			};
			expect((await InternalUrlRouter.instance().resolve("artifact://0", context)).content).toBe(
				"persisted before restart",
			);
			expect(await owner.saveArtifact("persisted after resume", "bash")).toBe("1");
			expect((await InternalUrlRouter.instance().resolve("artifact://1", context)).content).toBe(
				"persisted after resume",
			);

			expect(disposalCleanupCount).toBe(0);
			await runtime.dispose();
			expect(disposalCleanupCount).toBe(1);
			runtime = undefined;
			const reopened = await SessionManager.open(targetFile, cwd);
			try {
				const artifactPath = await reopened.getArtifactPath("0");
				expect(artifactPath).toBe(path.join(targetFile.slice(0, -6), "0.read.log"));
				expect(await Bun.file(artifactPath!).text()).toBe("persisted before restart");
			} finally {
				await reopened.close();
			}
		} finally {
			if (runtime) await runtime.dispose();
			authStorage.close();
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("rejects a lexically nested foreign manager without exact session proof", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [TEST_AGENT], projectAgentsDir: null });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(createYieldingSession("foreign manager rejection output")),
		);
		const foreignRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-lexical-foreign-"));
		const foreignManager = new ArtifactManager(foreignRoot);
		const sessionFile = path.join(foreignRoot, "0-Child.jsonl");
		const session = createSession(sessionFile, `lexical-foreign-${Snowflake.next()}`);
		session.getArtifactsDir = () => null;
		session.getArtifactManager = () => foreignManager;
		session.isArtifactManagerAuthorized = () => false;
		try {
			const resultText = await runDetachedTask(await TaskTool.create(session));
			const outputId = matchAgentOutputId(resultText, "NoSession")?.[1];
			expect(outputId).toBeTruthy();
			expect(await Bun.file(path.join(foreignRoot, `${outputId}.md`)).exists()).toBe(false);
			expect(await Bun.file(path.join(sessionFile.slice(0, -6), `${outputId}.md`)).exists()).toBe(true);
		} finally {
			await session.disposeSession();
			await fs.rm(foreignRoot, { recursive: true, force: true });
		}
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
		expect(await pathExists(artifactsDir!)).toBe(false);
	});
});

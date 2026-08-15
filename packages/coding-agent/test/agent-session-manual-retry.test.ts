import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@gajae-code/agent-core";
import { type AssistantMessage, getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

function lastAgentMessage(session: AgentSession): AssistantMessage {
	const message = session.agent.state.messages.at(-1);
	if (message?.role !== "assistant") {
		throw new Error("Expected trailing assistant message");
	}
	return message as AssistantMessage;
}

function getTestModel() {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Expected bundled Anthropic test model to exist");
	}
	return model;
}

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function isBusyRmError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EBUSY";
}

async function removeTempDirWithRetry(tempDir: TempDir): Promise<void> {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		try {
			await fs.rm(tempDir.path(), { recursive: true, force: true });
			return;
		} catch (error) {
			if (!isBusyRmError(error)) {
				throw error;
			}
			if (attempt === 9) {
				return;
			}
			await Bun.sleep(100);
		}
	}
}

describe("AgentSession manual retry", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-manual-retry-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		await removeTempDirWithRetry(tempDir);
	});

	it("removes the failed assistant turn and continues with a fresh attempt", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{ throw: "manual retry test failure" },
				{ content: ["recovered after manual retry"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		session.subscribe(() => {});

		await session.prompt("fail once");
		await session.waitForIdle();
		expect(lastAgentMessage(session).stopReason).toBe("error");

		await expect(session.retry()).resolves.toBe(true);
		await session.waitForIdle();

		expect(mock.calls.length).toBe(2);
		expect(lastAgentMessage(session).stopReason).toBe("stop");
		expect(lastAgentMessage(session).content).toContainEqual({ type: "text", text: "recovered after manual retry" });
	});

	it("does not start a retry deferred behind selection after abort", async () => {
		const model = getTestModel();
		const mock = createMockModel({ responses: [{ throw: "manual retry test failure" }] });
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const modelRegistry = new ModelRegistry(authStorage);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
		});
		session.subscribe(() => {});
		await session.prompt("fail once");
		await session.waitForIdle();
		const selectionModel = { ...model, id: "selection-holds-retry" };
		const selectionValidationStarted = Promise.withResolvers<void>();
		const releaseSelectionValidation = Promise.withResolvers<void>();
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		spyOn(modelRegistry, "getApiKey").mockImplementation(async (selectedModel, ...args) => {
			if (selectedModel === selectionModel) {
				selectionValidationStarted.resolve();
				await releaseSelectionValidation.promise;
			}
			return originalGetApiKey(selectedModel, ...args);
		});

		const selection = session.setDefaultModelSelection(selectionModel, undefined);
		await selectionValidationStarted.promise;
		await expect(session.retry()).resolves.toBe(true);
		await session.abort();
		releaseSelectionValidation.resolve();
		await selection;
		await session.waitForIdle();

		expect(mock.calls.length).toBe(1);
		expect(session.model).toBe(selectionModel);
	});

	it("continues from a persisted user tail left by a process crash", async () => {
		const model = getTestModel();
		const mock = createMockModel({
			responses: [{ content: ["resumed after crash"], stopReason: "stop" }],
		});
		const messages: AgentMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "continue this after restart" }],
				timestamp: Date.now(),
			},
		];
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages,
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		session.subscribe(() => {});

		await expect(session.retry()).resolves.toBe(true);
		await session.waitForIdle();

		expect(mock.calls.length).toBe(1);
		expect(lastAgentMessage(session).content).toContainEqual({ type: "text", text: "resumed after crash" });
	});

	it("drops an unresolved tool-use assistant tail before crash retry", async () => {
		const model = getTestModel();
		const mock = createMockModel({
			responses: [{ content: ["reran after tool crash"], stopReason: "stop" }],
		});
		const messages: AgentMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "use a tool" }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } }],
				usage: emptyUsage(),
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		];
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages,
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		session.subscribe(() => {});

		await expect(session.retry()).resolves.toBe(true);
		await session.waitForIdle();

		expect(mock.calls.length).toBe(1);
		expect(
			session.agent.state.messages.some(message => message.role === "assistant" && message.stopReason === "toolUse"),
		).toBe(false);
		expect(lastAgentMessage(session).content).toContainEqual({ type: "text", text: "reran after tool crash" });
	});

	it("returns false when the trailing assistant turn succeeded", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [{ content: ["already done"], stopReason: "stop" }],
		});
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		session.subscribe(() => {});

		await session.prompt("succeed");
		await session.waitForIdle();

		await expect(session.retry()).resolves.toBe(false);
		expect(mock.calls.length).toBe(1);
		expect(lastAgentMessage(session).content).toContainEqual({ type: "text", text: "already done" });
	});
});

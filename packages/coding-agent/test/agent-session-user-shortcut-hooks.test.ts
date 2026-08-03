import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import * as pythonExecutor from "@gajae-code/coding-agent/eval/py/executor";
import * as bashExecutor from "@gajae-code/coding-agent/exec/bash-executor";
import type { ExtensionRunner } from "@gajae-code/coding-agent/extensibility/extensions";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionAppendPersistenceError, SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

describe("AgentSession user shortcut hooks", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-user-shortcut-hooks-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		authStorage = undefined;
		tempDir.removeSync();
	});

	function createSession(extensionRunner?: ExtensionRunner): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
		});
		return session;
	}

	it("invokes user_bash hook and honors replacement result", async () => {
		const replacement = {
			output: "hooked bash output",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 18,
			outputLines: 1,
			outputBytes: 18,
		};
		const emitUserBash = vi.fn().mockResolvedValue({ result: replacement });
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "user_bash"),
			emitUserBash,
		} as unknown as ExtensionRunner;
		const executeBashSpy = vi.spyOn(bashExecutor, "executeBash");

		createSession(extensionRunner);
		const result = await session.executeBash("echo hello", undefined, { excludeFromContext: true });

		expect(emitUserBash).toHaveBeenCalledWith({
			type: "user_bash",
			command: "echo hello",
			excludeFromContext: true,
			cwd: expect.any(String),
		});
		expect(executeBashSpy).not.toHaveBeenCalled();
		expect(result).toEqual(replacement);
		const bashMessage = session.messages.at(-1);
		expect(bashMessage?.role).toBe("bashExecution");
		expect(bashMessage).toMatchObject({
			output: "hooked bash output",
			excludeFromContext: true,
		});
	});
	it("reconciles an immediate shell result that committed before append failure", async () => {
		const replacement = {
			output: "hooked bash output",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 18,
			outputLines: 1,
			outputBytes: 18,
		};
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "user_bash"),
			emitUserBash: vi.fn().mockResolvedValue({ result: replacement }),
		} as unknown as ExtensionRunner;
		createSession(extensionRunner);
		const manager = session.sessionManager;
		const appendMessage = manager.appendMessage.bind(manager);
		let injected = false;
		vi.spyOn(manager, "appendMessage").mockImplementation(message => {
			if (!injected && message.role === "bashExecution") {
				injected = true;
				const entryId = appendMessage(message);
				throw new SessionAppendPersistenceError("current_append", entryId, new Error("uncertain append"));
			}
			return appendMessage(message);
		});
		vi.spyOn(manager, "recoverPersistenceFailure").mockResolvedValue();

		const result = await session.executeBash("echo hello");

		expect(result).toEqual(replacement);
		expect(
			manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "bashExecution"),
		).toHaveLength(1);
		expect(session.messages.filter(message => message.role === "bashExecution")).toHaveLength(1);
	});
	it("persists deferred shell results before terminal publication", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		authStorage?.setRuntimeApiKey("anthropic", "test-key");
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		const result = {
			output: "done",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 4,
			outputLines: 1,
			outputBytes: 4,
		};
		const displayIdentity = {};
		let durableBeforePublication = false;
		const unsubscribeRaw = agent.subscribe(event => {
			if (event.type === "agent_end") void session.recordBashResult("deferred", result, { displayIdentity });
		});
		const published = Promise.withResolvers<void>();
		const unsubscribe = session.subscribe(event => {
			if (event.type !== "agent_end") return;
			const entryId = session.getBashExecutionEntryId(displayIdentity);
			durableBeforePublication =
				entryId !== undefined &&
				session.sessionManager
					.getBranch()
					.some(
						entry => entry.id === entryId && entry.type === "message" && entry.message.role === "bashExecution",
					);
			published.resolve();
		});

		await session.prompt("Finish the turn");
		await published.promise;
		unsubscribeRaw();
		unsubscribe();

		expect(durableBeforePublication).toBe(true);
		expect(session.hasPendingBashMessages).toBe(false);
		expect(session.messages.filter(message => message.role === "bashExecution")).toHaveLength(1);
	});
	it("reconciles a deferred shell result that committed before append failure", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		authStorage?.setRuntimeApiKey("anthropic", "test-key");
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		const manager = session.sessionManager;
		const appendMessage = manager.appendMessage.bind(manager);
		let injected = false;
		vi.spyOn(manager, "appendMessage").mockImplementation(message => {
			if (!injected && message.role === "bashExecution") {
				injected = true;
				const entryId = appendMessage(message);
				throw new SessionAppendPersistenceError("current_append", entryId, new Error("uncertain append"));
			}
			return appendMessage(message);
		});
		vi.spyOn(manager, "recoverPersistenceFailure").mockResolvedValue();
		const result = {
			output: "done",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 4,
			outputLines: 1,
			outputBytes: 4,
		};
		const unsubscribe = agent.subscribe(event => {
			if (event.type === "agent_end") void session.recordBashResult("deferred", result);
		});

		await session.prompt("Finish the turn");
		unsubscribe();

		expect(
			manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "bashExecution"),
		).toHaveLength(1);
		expect(session.messages.filter(message => message.role === "bashExecution")).toHaveLength(1);
		expect(session.hasPendingBashMessages).toBe(false);
	});

	it("reconciles a retry that commits after the first append was proven absent", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		authStorage?.setRuntimeApiKey("anthropic", "test-key");
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		const manager = session.sessionManager;
		const appendMessage = manager.appendMessage.bind(manager);
		let bashAppendAttempts = 0;
		vi.spyOn(manager, "appendMessage").mockImplementation(message => {
			if (message.role !== "bashExecution") return appendMessage(message);
			bashAppendAttempts++;
			if (bashAppendAttempts === 1) {
				throw new SessionAppendPersistenceError("current_append", "not-committed", new Error("known failure"));
			}
			const entryId = appendMessage(message);
			throw new SessionAppendPersistenceError("current_append", entryId, new Error("uncertain retry"));
		});
		vi.spyOn(manager, "recoverPersistenceFailure").mockResolvedValue();
		const result = {
			output: "done",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 4,
			outputLines: 1,
			outputBytes: 4,
		};
		const unsubscribe = agent.subscribe(event => {
			if (event.type === "agent_end") void session.recordBashResult("deferred", result);
		});

		await session.prompt("Finish the turn");
		unsubscribe();

		expect(bashAppendAttempts).toBe(2);
		expect(
			manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "bashExecution"),
		).toHaveLength(1);
		expect(session.messages.filter(message => message.role === "bashExecution")).toHaveLength(1);
		expect(session.hasPendingBashMessages).toBe(false);
	});
	it("reconciles a committed deferred shell append after recovery rejects", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		authStorage?.setRuntimeApiKey("anthropic", "test-key");
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		const manager = session.sessionManager;
		const appendMessage = manager.appendMessage.bind(manager);
		let bashAppendAttempts = 0;
		let committedEntryId: string | undefined;
		vi.spyOn(manager, "appendMessage").mockImplementation(message => {
			if (message.role !== "bashExecution") return appendMessage(message);
			bashAppendAttempts++;
			if (bashAppendAttempts === 1) {
				committedEntryId = appendMessage(message);
				throw new SessionAppendPersistenceError(
					"current_append",
					committedEntryId,
					new Error("uncertain committed append"),
				);
			}
			return appendMessage(message);
		});
		const recover = vi
			.spyOn(manager, "recoverPersistenceFailure")
			.mockRejectedValueOnce(new Error("rehydration unavailable"))
			.mockRejectedValueOnce(new Error("rehydration still unavailable"))
			.mockResolvedValue();
		const result = {
			output: "done",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 4,
			outputLines: 1,
			outputBytes: 4,
		};
		const unsubscribe = agent.subscribe(event => {
			if (event.type === "agent_end") void session.recordBashResult("deferred", result);
		});

		await expect(session.prompt("First turn")).rejects.toThrow("rehydration still unavailable");
		unsubscribe();
		expect(session.hasPendingBashMessages).toBe(true);

		await session.prompt("Second turn");

		expect(recover).toHaveBeenCalledTimes(3);
		expect(bashAppendAttempts).toBe(1);
		expect(committedEntryId).toBeDefined();
		expect(
			manager
				.getBranch()
				.filter(
					entry =>
						entry.id === committedEntryId && entry.type === "message" && entry.message.role === "bashExecution",
				),
		).toHaveLength(1);
		expect(session.messages.filter(message => message.role === "bashExecution")).toHaveLength(1);
		expect(session.hasPendingBashMessages).toBe(false);
	});
	it("retries a failed terminal publication without losing the deferred shell result", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		authStorage?.setRuntimeApiKey("anthropic", "test-key");
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		const manager = session.sessionManager;
		const appendMessage = manager.appendMessage.bind(manager);
		let bashAppendAttempts = 0;
		vi.spyOn(manager, "appendMessage").mockImplementation(message => {
			if (message.role !== "bashExecution") return appendMessage(message);
			bashAppendAttempts++;
			if (bashAppendAttempts <= 2) {
				throw new SessionAppendPersistenceError(
					"current_append",
					`not-committed-${bashAppendAttempts}`,
					new Error("known failure"),
				);
			}
			return appendMessage(message);
		});
		const recover = vi
			.spyOn(manager, "recoverPersistenceFailure")
			.mockRejectedValueOnce(new Error("rehydration unavailable"))
			.mockRejectedValueOnce(new Error("rehydration still unavailable"))
			.mockResolvedValue();
		const result = {
			output: "done",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 4,
			outputLines: 1,
			outputBytes: 4,
		};
		const unsubscribe = agent.subscribe(event => {
			if (event.type === "agent_end") void session.recordBashResult("deferred", result);
		});

		await expect(session.prompt("First turn")).rejects.toThrow("rehydration still unavailable");
		unsubscribe();
		expect(session.hasPendingBashMessages).toBe(true);

		await session.prompt("Second turn");

		expect(recover).toHaveBeenCalledTimes(4);
		expect(bashAppendAttempts).toBe(3);
		expect(
			manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "bashExecution"),
		).toHaveLength(1);
		expect(session.messages.filter(message => message.role === "bashExecution")).toHaveLength(1);
		expect(session.hasPendingBashMessages).toBe(false);
	});
	it("dequeues only durable deferred shell records after a partial failure", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		authStorage?.setRuntimeApiKey("anthropic", "test-key");
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		const manager = session.sessionManager;
		const appendMessage = manager.appendMessage.bind(manager);
		let secondAppendAttempts = 0;
		vi.spyOn(manager, "appendMessage").mockImplementation(message => {
			if (message.role !== "bashExecution" || message.command === "first") return appendMessage(message);
			secondAppendAttempts++;
			if (secondAppendAttempts === 1)
				throw new SessionAppendPersistenceError(
					"current_append",
					"second-not-committed",
					new Error("known failure"),
				);
			return appendMessage(message);
		});
		vi.spyOn(manager, "recoverPersistenceFailure")
			.mockRejectedValueOnce(new Error("rehydration unavailable"))
			.mockRejectedValueOnce(new Error("rehydration still unavailable"))
			.mockResolvedValue();
		const result = {
			output: "done",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 4,
			outputLines: 1,
			outputBytes: 4,
		};
		const unsubscribe = agent.subscribe(event => {
			if (event.type !== "agent_end") return;
			void session.recordBashResult("first", result);
			void session.recordBashResult("second", result);
		});

		await expect(session.prompt("First turn")).rejects.toThrow("rehydration still unavailable");
		unsubscribe();
		expect(
			manager
				.getBranch()
				.flatMap(entry =>
					entry.type === "message" && entry.message.role === "bashExecution" ? [entry.message.command] : [],
				),
		).toEqual(["first"]);
		expect(session.hasPendingBashMessages).toBe(true);

		await session.prompt("Second turn");

		expect(secondAppendAttempts).toBe(2);
		expect(
			manager
				.getBranch()
				.flatMap(entry =>
					entry.type === "message" && entry.message.role === "bashExecution" ? [entry.message.command] : [],
				),
		).toEqual(["first", "second"]);
		expect(session.messages.filter(message => message.role === "bashExecution")).toHaveLength(2);
		expect(session.hasPendingBashMessages).toBe(false);
	});
	it("shares terminal retry settlement between concurrent public waiters and emits once", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		authStorage?.setRuntimeApiKey("anthropic", "test-key");
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		const manager = session.sessionManager;
		const appendMessage = manager.appendMessage.bind(manager);
		let bashAppendAttempts = 0;
		vi.spyOn(manager, "appendMessage").mockImplementation(message => {
			if (message.role !== "bashExecution") return appendMessage(message);
			bashAppendAttempts++;
			if (bashAppendAttempts === 1)
				throw new SessionAppendPersistenceError("current_append", "not-committed", new Error("known failure"));
			return appendMessage(message);
		});
		vi.spyOn(manager, "recoverPersistenceFailure")
			.mockRejectedValueOnce(new Error("rehydration unavailable"))
			.mockRejectedValueOnce(new Error("rehydration still unavailable"))
			.mockResolvedValue();
		const claimProducerOriginal = agent.resourceLedger.claimProducer.bind(agent.resourceLedger);
		let leaseCloseCount = 0;
		const claimProducer = vi.spyOn(agent.resourceLedger, "claimProducer").mockImplementation((...args) => {
			const claim = claimProducerOriginal(...args);
			if (claim.ok) {
				const closeDiscovery = claim.lease.closeDiscovery.bind(claim.lease);
				vi.spyOn(claim.lease, "closeDiscovery").mockImplementation(() => {
					leaseCloseCount++;
					closeDiscovery();
				});
			}
			return claim;
		});
		const publicTerminals: Array<string | undefined> = [];
		session.subscribe(event => {
			if (event.type === "agent_end") publicTerminals.push(event.stopReason);
		});
		const result = {
			output: "done",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 4,
			outputLines: 1,
			outputBytes: 4,
		};
		const unsubscribe = agent.subscribe(event => {
			if (event.type === "agent_end") void session.recordBashResult("deferred", result);
		});

		await expect(session.prompt("First turn")).rejects.toThrow("rehydration still unavailable");
		unsubscribe();

		const firstWaiter = session.waitForIdle();
		const secondWaiter = session.dispose();
		await expect(Promise.all([firstWaiter, secondWaiter])).resolves.toEqual([undefined, undefined]);

		expect(bashAppendAttempts).toBe(2);
		expect(publicTerminals).toHaveLength(1);
		expect(claimProducer).toHaveBeenCalledTimes(1);
		expect(leaseCloseCount).toBe(1);
	});
	it("invokes user_python hook and honors replacement result", async () => {
		const replacement = {
			output: "hooked python output",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 20,
			outputLines: 1,
			outputBytes: 20,
			displayOutputs: [],
			stdinRequested: false,
		};
		const emitUserPython = vi.fn().mockResolvedValue({ result: replacement });
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "user_python"),
			emitUserPython,
		} as unknown as ExtensionRunner;
		const executePythonSpy = vi.spyOn(pythonExecutor, "executePython");

		createSession(extensionRunner);
		const result = await session.executePython("print('hi')", undefined, { excludeFromContext: true });

		expect(emitUserPython).toHaveBeenCalledWith({
			type: "user_python",
			code: "print('hi')",
			excludeFromContext: true,
			cwd: expect.any(String),
		});
		expect(executePythonSpy).not.toHaveBeenCalled();
		expect(result).toEqual(replacement);
		const pythonMessage = session.messages.at(-1);
		expect(pythonMessage?.role).toBe("pythonExecution");
		expect(pythonMessage).toMatchObject({
			output: "hooked python output",
			excludeFromContext: true,
		});
	});

	it("falls back to normal execution when hook does not return a replacement", async () => {
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "user_bash" || eventType === "user_python"),
			emitUserBash: vi.fn().mockResolvedValue({}),
			emitUserPython: vi.fn().mockResolvedValue(undefined),
		} as unknown as ExtensionRunner;
		vi.spyOn(bashExecutor, "executeBash").mockResolvedValue({
			output: "bash fallback",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 13,
			outputLines: 1,
			outputBytes: 13,
		});
		vi.spyOn(pythonExecutor, "executePython").mockResolvedValue({
			output: "python fallback",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 15,
			outputLines: 1,
			outputBytes: 15,
			displayOutputs: [],
			stdinRequested: false,
		});

		createSession(extensionRunner);
		const bashResult = await session.executeBash("pwd", undefined, { excludeFromContext: true });
		const pythonResult = await session.executePython("1+1", undefined, { excludeFromContext: false });

		expect(bashResult.output).toBe("bash fallback");
		expect(pythonResult.output).toBe("python fallback");
		expect(bashExecutor.executeBash).toHaveBeenCalledTimes(1);
		expect(pythonExecutor.executePython).toHaveBeenCalledTimes(1);
		expect(
			session.messages.some(message => message.role === "bashExecution" && message.excludeFromContext === true),
		).toBe(true);
		expect(
			session.messages.some(message => message.role === "pythonExecution" && message.excludeFromContext === false),
		).toBe(true);
	});
});

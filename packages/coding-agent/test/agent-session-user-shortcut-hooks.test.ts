import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import * as pythonExecutor from "@gajae-code/coding-agent/eval/py/executor";
import * as bashExecutor from "@gajae-code/coding-agent/exec/bash-executor";
import type { ExtensionRunner, UserBashEventResult } from "@gajae-code/coding-agent/extensibility/extensions";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
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

	describe("bash hook preflight ownership", () => {
		const replacement: bashExecutor.BashResult = {
			output: "hook-success-marker",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 19,
			outputLines: 1,
			outputBytes: 19,
		};

		function createGatedHook() {
			const entered = Promise.withResolvers<void>();
			const hook = Promise.withResolvers<UserBashEventResult | undefined>();
			const extensionRunner = {
				hasHandlers: vi.fn((eventType: string) => eventType === "user_bash"),
				emit: vi.fn().mockResolvedValue(undefined),
				emitUserBash: vi.fn(() => {
					entered.resolve();
					return hook.promise;
				}),
			} as unknown as ExtensionRunner;
			createSession(extensionRunner);
			return { entered, hook };
		}

		it("aborting a pending hook prevents fallback execution until the hook settles", async () => {
			const { entered, hook } = createGatedHook();
			const executeBashSpy = vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(replacement);
			const onPersisted = vi.fn();
			const execution = session.executeBash("echo fallback-marker", undefined, { onPersisted });
			await entered.promise;
			const runningDuringHook = session.isBashRunning;
			session.abortBash();
			const runningAfterAbort = session.isBashRunning;
			hook.resolve(undefined);
			const result = await execution;

			expect(runningDuringHook).toBe(true);
			expect(runningAfterAbort).toBe(true);
			expect(executeBashSpy).not.toHaveBeenCalled();
			expect(result).toMatchObject({ cancelled: true, exitCode: undefined });
			expect(result.output).not.toContain(replacement.output);
			expect(session.messages).toEqual([]);
			expect(session.sessionManager.getEntries().filter(entry => entry.type === "message")).toEqual([]);
			expect(onPersisted).not.toHaveBeenCalled();
			expect(session.isBashRunning).toBe(false);
		});

		it("aborting a pending hook discards a later successful replacement", async () => {
			const { entered, hook } = createGatedHook();
			const executeBashSpy = vi.spyOn(bashExecutor, "executeBash");
			const onPersisted = vi.fn();
			const execution = session.executeBash("echo replacement-marker", undefined, { onPersisted });
			await entered.promise;
			session.abortBash();
			hook.resolve({ result: replacement });
			const result = await execution;

			expect(executeBashSpy).not.toHaveBeenCalled();
			expect(result).toMatchObject({ cancelled: true, exitCode: undefined });
			expect(result.output).not.toContain(replacement.output);
			expect(session.messages).toEqual([]);
			expect(session.sessionManager.getEntries().filter(entry => entry.type === "message")).toEqual([]);
			expect(onPersisted).not.toHaveBeenCalled();
			expect(session.isBashRunning).toBe(false);
		});

		it.each([
			undefined,
			{ result: replacement },
		])("disposal during a pending hook fences stale work (%j)", async hookResult => {
			const { entered, hook } = createGatedHook();
			const executeBashSpy = vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(replacement);
			const onPersisted = vi.fn();
			const execution = session.executeBash("echo disposed-marker", undefined, { onPersisted });
			await entered.promise;
			const disposal = session.dispose();
			hook.resolve(hookResult);
			const result = await execution;
			await disposal;

			expect(executeBashSpy).not.toHaveBeenCalled();
			expect(result).toMatchObject({ cancelled: true, exitCode: undefined });
			expect(session.messages).toEqual([]);
			expect(session.sessionManager.getEntries().filter(entry => entry.type === "message")).toEqual([]);
			expect(onPersisted).not.toHaveBeenCalled();
			expect(session.isBashRunning).toBe(false);
		});

		it.each([
			undefined,
			{ result: replacement },
		])("session replacement during a pending hook fences stale work (%j)", async hookResult => {
			const { entered, hook } = createGatedHook();
			const executeBashSpy = vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(replacement);
			const onPersisted = vi.fn();
			const previousSessionId = session.sessionId;
			const execution = session.executeBash("echo predecessor-marker", undefined, { onPersisted });
			await entered.promise;
			const replaced = await session.newSession();
			hook.resolve(hookResult);
			const result = await execution;

			expect(replaced).toBe(true);
			expect(session.sessionId).not.toBe(previousSessionId);
			expect(executeBashSpy).not.toHaveBeenCalled();
			expect(result).toMatchObject({ cancelled: true, exitCode: undefined });
			expect(session.messages).toEqual([]);
			expect(session.sessionManager.getEntries().filter(entry => entry.type === "message")).toEqual([]);
			expect(onPersisted).not.toHaveBeenCalled();
			expect(session.isBashRunning).toBe(false);
		});

		it.each([
			"none",
			"abort",
			"dispose",
		])("hook rejection clears running ownership and preserves the rejection (cancellation=%s)", async cancellation => {
			const { entered, hook } = createGatedHook();
			const executeBashSpy = vi.spyOn(bashExecutor, "executeBash");
			const failure = new Error("hook failure marker");
			const execution = session.executeBash("echo rejected-marker");
			await entered.promise;
			const runningDuringHook = session.isBashRunning;
			if (cancellation === "abort") session.abortBash();
			const disposal = cancellation === "dispose" ? session.dispose() : undefined;
			hook.reject(failure);
			await expect(execution).rejects.toBe(failure);
			await disposal;

			expect(runningDuringHook).toBe(true);
			expect(session.isBashRunning).toBe(false);
			expect(executeBashSpy).not.toHaveBeenCalled();
			expect(session.messages).toEqual([]);
		});

		it("manager identity replacement without an abort fences a pending hook", async () => {
			const { entered, hook } = createGatedHook();
			const executeBashSpy = vi.spyOn(bashExecutor, "executeBash").mockResolvedValue(replacement);
			const previousSessionId = session.sessionId;
			const onPersisted = vi.fn();
			const execution = session.executeBash("echo stale-identity-marker", undefined, { onPersisted });
			await entered.promise;
			await session.sessionManager.newSession();
			hook.resolve(undefined);
			const result = await execution;

			expect(session.sessionId).not.toBe(previousSessionId);
			expect(executeBashSpy).not.toHaveBeenCalled();
			expect(result).toMatchObject({ cancelled: true, exitCode: undefined });
			expect(session.messages).toEqual([]);
			expect(session.sessionManager.getEntries().filter(entry => entry.type === "message")).toEqual([]);
			expect(onPersisted).not.toHaveBeenCalled();
			expect(session.isBashRunning).toBe(false);
		});

		it("normal replacement preserves context exclusion and persistence notification", async () => {
			const { entered, hook } = createGatedHook();
			const executeBashSpy = vi.spyOn(bashExecutor, "executeBash");
			const onPersisted = vi.fn();
			const execution = session.executeBash("echo handled-marker", undefined, {
				excludeFromContext: true,
				onPersisted,
			});
			await entered.promise;
			const runningDuringHook = session.isBashRunning;
			hook.resolve({ result: replacement });
			const result = await execution;

			expect(runningDuringHook).toBe(true);
			expect(result).toBe(replacement);
			expect(executeBashSpy).not.toHaveBeenCalled();
			expect(session.messages).toMatchObject([
				{ role: "bashExecution", output: replacement.output, excludeFromContext: true, cancelled: false },
			]);
			expect(session.sessionManager.getEntries().filter(entry => entry.type === "message")).toMatchObject([
				{ message: { role: "bashExecution", output: replacement.output, excludeFromContext: true } },
			]);
			expect(onPersisted).toHaveBeenCalledTimes(1);
			expect(session.isBashRunning).toBe(false);
		});

		it.each([
			false,
			true,
		])("fallback retains ownership through executor settlement (cancelled=%s)", async cancelled => {
			const { entered, hook } = createGatedHook();
			const fallbackEntered = Promise.withResolvers<void>();
			const fallback = Promise.withResolvers<bashExecutor.BashResult>();
			const executeBashSpy = vi.spyOn(bashExecutor, "executeBash").mockImplementation(() => {
				fallbackEntered.resolve();
				return fallback.promise;
			});
			const onPersisted = vi.fn();
			const onChunk = vi.fn();
			const execution = session.executeBash("echo normal-fallback-marker", onChunk, { onPersisted });
			await entered.promise;
			hook.resolve(undefined);
			await fallbackEntered.promise;
			const runningDuringFallback = session.isBashRunning;
			if (cancelled) session.abortBash();
			const runningBeforeSettlement = session.isBashRunning;
			const fallbackResult: bashExecutor.BashResult = cancelled
				? {
						output: "[Command cancelled]\n",
						exitCode: undefined,
						cancelled: true,
						truncated: false,
						totalLines: 0,
						totalBytes: 0,
						outputLines: 0,
						outputBytes: 0,
					}
				: replacement;
			fallback.resolve(fallbackResult);
			const result = await execution;

			expect(runningDuringFallback).toBe(true);
			expect(runningBeforeSettlement).toBe(true);
			expect(executeBashSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(cancelled);
			expect(result).toBe(fallbackResult);
			expect(executeBashSpy).toHaveBeenCalledTimes(1);
			expect(executeBashSpy).toHaveBeenCalledWith(
				"echo normal-fallback-marker",
				expect.objectContaining({ onChunk, sessionKey: session.sessionId, signal: expect.any(AbortSignal) }),
			);
			expect(session.messages).toMatchObject([{ role: "bashExecution", output: fallbackResult.output, cancelled }]);
			expect(onPersisted).toHaveBeenCalledTimes(1);
			expect(session.isBashRunning).toBe(false);
		});

		it("fallback rejection releases ownership without recording a result", async () => {
			const { entered, hook } = createGatedHook();
			const failure = new Error("fallback failure marker");
			const executeBashSpy = vi.spyOn(bashExecutor, "executeBash").mockRejectedValue(failure);
			const onPersisted = vi.fn();
			const execution = session.executeBash("echo failed-fallback-marker", undefined, { onPersisted });
			await entered.promise;
			hook.resolve(undefined);
			await expect(execution).rejects.toBe(failure);

			expect(executeBashSpy).toHaveBeenCalledTimes(1);
			expect(session.messages).toEqual([]);
			expect(onPersisted).not.toHaveBeenCalled();
			expect(session.isBashRunning).toBe(false);
		});
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

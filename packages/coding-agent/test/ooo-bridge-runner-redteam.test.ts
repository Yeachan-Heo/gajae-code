import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@gajae-code/ai";
import type { ExecResult } from "@gajae-code/coding-agent/exec/exec";
import {
	createExactPrefixCommandBridge,
	createOuroborosOooBridge,
	EXTENSION_HANDLER_TIMEOUT_MS,
	type Extension,
	type ExtensionHandler,
	ExtensionRunner,
	type ExtensionRuntime,
	type InputEvent,
	type InputEventResult,
	OOO_BRIDGE_RECURSION_ENV,
	OOO_BRIDGE_TIMEOUT_ENV,
	testSetExtensionHandlerTimeoutMs,
} from "@gajae-code/coding-agent/extensibility/extensions";
import type { MCPRequestOptions, MCPServerConnection, MCPToolCallResult } from "../src/runtime-mcp";

function extensionWith(handler: ExtensionHandler<InputEvent, InputEventResult>): Extension {
	return {
		path: "ooo-bridge-redteam-test",
		resolvedPath: "ooo-bridge-redteam-test",
		handlers: new Map([["input", [handler]]]),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	} as unknown as Extension;
}

function runnerWith(handler: ExtensionHandler<InputEvent, InputEventResult>): ExtensionRunner {
	return new ExtensionRunner(
		[extensionWith(handler)],
		{ flagValues: new Map(), pendingProviderRegistrations: [] } as unknown as ExtensionRuntime,
		"/tmp",
		{} as never,
		{} as never,
	);
}

describe("ooo bridge runner red-team", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env[OOO_BRIDGE_RECURSION_ENV];
		delete process.env[OOO_BRIDGE_TIMEOUT_ENV];
		testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
	});

	it("installed bridge returns handled for terminal dispatch errors instead of passing input to the model", async () => {
		const dispatcher = {
			run: async (): Promise<ExecResult> => ({ stdout: "", stderr: "dispatch failed", code: 2, killed: false }),
		};
		const dispatchSpy = vi.spyOn(dispatcher, "run");
		const handler = createExactPrefixCommandBridge({
			prefix: "ooo",
			command: "ouroboros",
			args: ["dispatch"],
			dispatch: dispatcher.run,
		});

		const result = await runnerWith(handler).emitInput("ooo status", undefined, "interactive");

		expect(result).toEqual({ handled: true });
		expect(dispatchSpy).toHaveBeenCalledTimes(1);
	});

	it("runner preserves image-bearing input on continue and withholds it when handled", async () => {
		const image = { type: "image", data: "abc", mimeType: "image/png" } satisfies ImageContent;
		const continueHandler = createExactPrefixCommandBridge({
			prefix: "ooo",
			command: "ouroboros",
			args: ["dispatch"],
			dispatch: async (): Promise<ExecResult> => ({ stdout: "", stderr: "", code: 78, killed: false }),
		});
		const handledHandler = createExactPrefixCommandBridge({
			prefix: "ooo",
			command: "ouroboros",
			args: ["dispatch"],
			dispatch: async (): Promise<ExecResult> => ({ stdout: "", stderr: "", code: 0, killed: false }),
		});

		expect(await runnerWith(continueHandler).emitInput("ooo status", [image], "interactive")).toEqual({});
		expect(await runnerWith(handledHandler).emitInput("ooo status", [image], "interactive")).toEqual({
			handled: true,
		});
	});

	it("runner dispatches interactive source but passes through rpc and extension sources", async () => {
		const dispatcher = {
			run: async (): Promise<ExecResult> => ({ stdout: "", stderr: "", code: 0, killed: false }),
		};
		const dispatchSpy = vi.spyOn(dispatcher, "run");
		const handler = createExactPrefixCommandBridge({
			prefix: "ooo",
			command: "ouroboros",
			args: ["dispatch"],
			dispatch: dispatcher.run,
		});
		const runner = runnerWith(handler);

		expect(await runner.emitInput("ooo status", undefined, "interactive")).toEqual({ handled: true });
		expect(await runner.emitInput("ooo status", undefined, "sdk")).toEqual({});
		expect(await runner.emitInput("ooo status", undefined, "extension")).toEqual({});
		expect(dispatchSpy).toHaveBeenCalledTimes(1);
	});

	it("aborts and fences an MCP call that settles after the runner timeout", async () => {
		const connection = { name: "late-settlement" } as MCPServerConnection;
		const deferred = Promise.withResolvers<MCPToolCallResult>();
		let observedSignal: AbortSignal | undefined;
		const invoke = vi.fn(
			(
				_connection: MCPServerConnection,
				_tool: string,
				_args?: Record<string, unknown>,
				options?: MCPRequestOptions,
			) => {
				observedSignal = options?.signal;
				return deferred.promise;
			},
		);
		const disconnect = vi.fn(async () => {});
		const handler = createOuroborosOooBridge({
			connect: vi.fn(async () => connection),
			callTool: invoke,
			disconnect,
		});
		const runner = runnerWith(handler);
		testSetExtensionHandlerTimeoutMs(5);

		expect(await runner.emitInput("ooo interview Slow", undefined, "interactive")).toEqual({});
		expect(observedSignal?.aborted).toBe(true);
		expect(disconnect).toHaveBeenCalledWith(connection);

		deferred.resolve({
			content: [{ type: "text", text: "Session interview_late\n\nLate question?" }],
			_meta: { session_id: "interview_late", phase: "start" },
		});
		await Bun.sleep(10);

		expect(await runner.emitInput("ordinary prompt", undefined, "interactive")).toEqual({});
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it("serializes overlapping continuation answers for one interview session", async () => {
		const connection = { name: "serialized-answers" } as MCPServerConnection;
		const firstAnswer = Promise.withResolvers<MCPToolCallResult>();
		const secondAnswer = Promise.withResolvers<MCPToolCallResult>();
		const invoke = vi
			.fn<
				(
					_connection: MCPServerConnection,
					_tool: string,
					_args?: Record<string, unknown>,
					_options?: MCPRequestOptions,
				) => Promise<MCPToolCallResult>
			>()
			.mockResolvedValueOnce({
				content: [{ type: "text", text: "Session interview_serial\n\nFirst question?" }],
				_meta: { session_id: "interview_serial", phase: "start" },
			})
			.mockImplementationOnce(() => firstAnswer.promise)
			.mockImplementationOnce(() => secondAnswer.promise);
		const runner = runnerWith(
			createOuroborosOooBridge({
				connect: vi.fn(async () => connection),
				callTool: invoke,
				disconnect: vi.fn(async () => {}),
			}),
		);

		await runner.emitInput("ooo interview Serialize", undefined, "interactive");
		const first = runner.emitInput("first answer", undefined, "interactive");
		await Bun.sleep(0);
		const second = runner.emitInput("second answer", undefined, "interactive");
		await Bun.sleep(10);
		expect(invoke).toHaveBeenCalledTimes(2);
		expect(invoke.mock.calls[1]?.[2]).toEqual({
			cwd: "/tmp",
			session_id: "interview_serial",
			answer: "first answer",
		});

		firstAnswer.resolve({
			content: [{ type: "text", text: "Session interview_serial\n\nSecond question?" }],
			_meta: { session_id: "interview_serial", phase: "answer" },
		});
		await first;
		await Bun.sleep(0);
		expect(invoke).toHaveBeenCalledTimes(3);
		expect(invoke.mock.calls[2]?.[2]).toEqual({
			cwd: "/tmp",
			session_id: "interview_serial",
			answer: "second answer",
		});

		secondAnswer.resolve({
			content: [{ type: "text", text: "Interview completed. Session ID: interview_serial" }],
			_meta: { session_id: "interview_serial", phase: "complete", completed: true },
		});
		expect(await second).toEqual({
			handled: true,
			text: "Interview completed. Session ID: interview_serial",
		});
	});
});

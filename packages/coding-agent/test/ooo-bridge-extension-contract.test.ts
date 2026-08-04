import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@gajae-code/ai";
import type { ExtensionAPI } from "@gajae-code/coding-agent";
import type { ExecResult } from "@gajae-code/coding-agent/exec/exec";
import {
	createExactPrefixCommandBridge,
	createOuroborosOooBridge,
	type ExtensionContext,
	type ExtensionHandler,
	type InputEvent,
	type InputEventResult,
	OOO_BRIDGE_RECURSION_ENV,
	OOO_BRIDGE_TIMEOUT_ENV,
} from "@gajae-code/coding-agent/extensibility/extensions";
import activateOooBridge from "../examples/extensions/ooo-bridge";
import type { MCPRequestOptions, MCPServerConnection, MCPToolCallResult } from "../src/runtime-mcp";
import * as runtimeMcpModule from "../src/runtime-mcp";

function input(text: string, source?: InputEvent["source"], images?: ImageContent[]): InputEvent {
	return { type: "input", text, source, images } as InputEvent;
}

function context(notify: (message: string, level: "info" | "warning" | "error") => void = () => {}): ExtensionContext {
	return {
		cwd: "/tmp",
		ui: { notify },
	} as unknown as ExtensionContext;
}

function image(): ImageContent {
	return { type: "image", data: "abc", mimeType: "image/png" };
}

function createHandler(code: number, output = "") {
	const dispatcher = {
		run: async (): Promise<ExecResult> => ({ stdout: output, stderr: "", code, killed: false }),
	};
	const dispatchSpy = vi.spyOn(dispatcher, "run");
	const handler = createExactPrefixCommandBridge({
		prefix: "ooo",
		command: "ouroboros",
		args: ["dispatch"],
		dispatch: dispatcher.run,
	});
	return { handler, dispatchSpy };
}

describe("ooo bridge extension contract", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env[OOO_BRIDGE_RECURSION_ENV];
		delete process.env[OOO_BRIDGE_TIMEOUT_ENV];
		delete process.env.OUROBOROS_CLI;
	});

	it("routes exact-prefix ooo input to ouroboros dispatch and returns successful output", async () => {
		const { handler, dispatchSpy } = createHandler(0, "visible output");
		const ctx = context();

		const result = await handler(input("ooo status", "interactive"), ctx);

		expect(result).toEqual({ handled: true, text: "visible output" });
		expect(dispatchSpy).toHaveBeenCalledWith("ouroboros", ["dispatch", "ooo status"], ctx, { timeout: undefined });
	});

	it.each(["oook", "oooize", "oooo", "/ooo", " ooo", "οοο", "ооо", "ｏｏｏ"])("does not over-match %p", async text => {
		const { handler, dispatchSpy } = createHandler(0);
		const imageContent = image();

		const result = await handler(input(text, "interactive", [imageContent]), context());

		expect(result).toEqual({});
		expect(dispatchSpy).not.toHaveBeenCalled();
	});

	it.each([
		["ooo", "ooo"],
		["ooo status", "ooo status"],
		["ooo   ", "ooo   "],
		["ooo\targ", "ooo\targ"],
	])("matches exact prefix and preserves whitespace for %p", async (text, expectedArg) => {
		const { handler, dispatchSpy } = createHandler(0);

		const result = await handler(input(text, "interactive"), context());

		expect(result).toEqual({ handled: true });
		expect(dispatchSpy).toHaveBeenCalledWith("ouroboros", ["dispatch", expectedArg], expect.anything(), {
			timeout: undefined,
		});
	});

	it.each([
		"ooo\nsecond line",
		"ooo ; rm -rf /",
		"ooo `touch nope`",
		"ooo $(touch nope)",
	])("passes dangerous or multiline text as a single argv for %p", async text => {
		const { handler, dispatchSpy } = createHandler(0);

		const result = await handler(input(text, "interactive"), context());

		expect(result).toEqual(text.startsWith("ooo\n") ? {} : { handled: true });
		if (text.startsWith("ooo\n")) {
			expect(dispatchSpy).not.toHaveBeenCalled();
		} else {
			expect(dispatchSpy).toHaveBeenCalledWith(
				"ouroboros",
				["dispatch", text],
				expect.anything(),
				expect.anything(),
			);
		}
	});

	it("does not crash on very long args", async () => {
		const { handler, dispatchSpy } = createHandler(0);
		const text = `ooo ${"x".repeat(100_000)}`;

		const result = await handler(input(text, "interactive"), context());

		expect(result).toEqual({ handled: true });
		expect(dispatchSpy).toHaveBeenCalledWith("ouroboros", ["dispatch", text], expect.anything(), expect.anything());
	});

	it("maps dispatch exit code 78 to continue pass-through", async () => {
		const { handler, dispatchSpy } = createHandler(78);

		const result = await handler(input("ooo status", "interactive"), context());

		expect(result).toEqual({});
		expect(dispatchSpy).toHaveBeenCalledTimes(1);
	});

	it("surfaces non-zero non-78 dispatch failures as handled terminal input", async () => {
		const dispatcher = {
			run: async (): Promise<ExecResult> => ({ stdout: "", stderr: "dispatch failed", code: 2, killed: false }),
		};
		const dispatchSpy = vi.spyOn(dispatcher, "run");
		const notifyTarget = { notify: (_message: string, _type?: "info" | "warning" | "error") => {} };
		const notifySpy = vi.spyOn(notifyTarget, "notify");
		const handler = createExactPrefixCommandBridge({
			prefix: "ooo",
			command: "ouroboros",
			args: ["dispatch"],
			dispatch: dispatcher.run,
		});
		const ctx = { ...context(), ui: notifyTarget } as ExtensionContext;

		const result = await handler(input("ooo status", "interactive"), ctx);

		expect(result).toEqual({ handled: true });
		expect(dispatchSpy).toHaveBeenCalledTimes(1);
		expect(notifySpy).toHaveBeenCalledWith("dispatch failed", "error");
	});

	it("handles a missing ouroboros executable without passing the input to the model", async () => {
		const dispatcher = { run: async () => Promise.reject(new Error('Executable not found in $PATH: "ouroboros"')) };
		const notifyTarget = { notify: (_message: string, _type?: "info" | "warning" | "error") => {} };
		const notifySpy = vi.spyOn(notifyTarget, "notify");
		const handler = createExactPrefixCommandBridge({
			prefix: "ooo",
			command: "ouroboros",
			args: ["dispatch"],
			dispatch: dispatcher.run,
		});

		expect(
			await handler(input("ooo interview", "interactive"), {
				...context(),
				ui: notifyTarget,
			} as ExtensionContext),
		).toEqual({ handled: true });
		expect(notifySpy).toHaveBeenCalledWith('Executable not found in $PATH: "ouroboros"', "error");
	});

	it("dispatch exception or timeout is handled and notified instead of falling through", async () => {
		process.env[OOO_BRIDGE_TIMEOUT_ENV] = "5";
		const dispatcher = { run: async () => Promise.reject(new Error("handler timed out after 5ms")) };
		const dispatchSpy = vi.spyOn(dispatcher, "run");
		const notifyTarget = { notify: (_message: string, _type?: "info" | "warning" | "error") => {} };
		const notifySpy = vi.spyOn(notifyTarget, "notify");
		const handler = createExactPrefixCommandBridge({
			prefix: "ooo",
			command: "ouroboros",
			args: ["dispatch"],
			dispatch: dispatcher.run,
		});

		const result = await handler(input("ooo status", "interactive"), {
			...context(),
			ui: notifyTarget,
		} as ExtensionContext);

		expect(result).toEqual({ handled: true });
		expect(dispatchSpy).toHaveBeenCalledWith("ouroboros", ["dispatch", "ooo status"], expect.anything(), {
			timeout: 5,
		});
		expect(notifySpy).toHaveBeenCalledWith("handler timed out after 5ms", "error");
	});

	it("missing ctx.ui does not throw on dispatch failure", async () => {
		const { handler } = createHandler(1, "failed");

		const result = await handler(input("ooo status", "interactive"), { cwd: "/tmp" } as ExtensionContext);

		expect(result).toEqual({ handled: true });
	});

	it("passes through rpc and extension sources while interactive and absent sources dispatch", async () => {
		const { handler, dispatchSpy } = createHandler(0);

		expect(await handler(input("ooo status", "interactive"), context())).toEqual({ handled: true });
		expect(await handler(input("ooo status", undefined), context())).toEqual({ handled: true });
		expect(await handler(input("ooo status", "sdk"), context())).toEqual({});
		expect(await handler(input("ooo status", "extension"), context())).toEqual({});
		expect(dispatchSpy).toHaveBeenCalledTimes(2);
	});

	it("recursion guard depth greater than one prevents nested dispatch", async () => {
		process.env[OOO_BRIDGE_RECURSION_ENV] = "2";
		const { handler, dispatchSpy } = createHandler(0);

		const result = await handler(input("ooo status", "interactive"), context());

		expect(result).toEqual({});
		expect(dispatchSpy).not.toHaveBeenCalled();
	});

	it("preserves image-bearing input when not handled and does not return images when handled", async () => {
		const imageContent = image();
		const passthrough = createHandler(78).handler;
		const handled = createHandler(0).handler;

		expect(await passthrough(input("ooo status", "interactive", [imageContent]), context())).toEqual({});
		expect(await handled(input("ooo status", "interactive", [imageContent]), context())).toEqual({ handled: true });
	});

	it("concurrent emitInput calls are independent", async () => {
		const dispatcher = {
			run: async (_command: string, args: string[]): Promise<ExecResult> => ({
				stdout: args[1] ?? "",
				stderr: "",
				code: 0,
				killed: false,
			}),
		};
		const dispatchSpy = vi.spyOn(dispatcher, "run");
		const handler = createExactPrefixCommandBridge({
			prefix: "ooo",
			command: "ouroboros",
			args: ["dispatch"],
			dispatch: dispatcher.run,
		});

		const [first, second] = await Promise.all([
			handler(input("ooo one", "interactive"), context()),
			handler(input("ooo two", "interactive"), context()),
		]);

		expect(first).toEqual({ handled: true, text: "ooo one" });
		expect(second).toEqual({ handled: true, text: "ooo two" });
		expect(dispatchSpy.mock.calls.map(call => call[1])).toEqual([
			["dispatch", "ooo one"],
			["dispatch", "ooo two"],
		]);
	});

	it("ships an example that registers ooo interview through the compatible CLI override", async () => {
		process.env.OUROBOROS_CLI = "/opt/ouroboros/bin/ouroboros";
		const connection = { name: "ouroboros-ooo-bridge" } as MCPServerConnection;
		const connectSpy = vi.spyOn(runtimeMcpModule, "connectToServer").mockResolvedValue(connection);
		const callSpy = vi.spyOn(runtimeMcpModule, "callTool").mockResolvedValue({
			content: [{ type: "text", text: "Session interview_abc123\n\nWhat should it build?" }],
			_meta: { session_id: "interview_abc123", phase: "start" },
		} as MCPToolCallResult);
		const registrations: Array<{ event: string; handler: unknown }> = [];
		activateOooBridge({
			on(event: string, handler: unknown): void {
				registrations.push({ event, handler });
			},
			pi: { createOuroborosOooBridge },
		} as unknown as ExtensionAPI);

		expect(registrations.map(registration => registration.event)).toEqual(["input", "session_switch"]);
		const handler = registrations.find(registration => registration.event === "input")?.handler as ExtensionHandler<
			InputEvent,
			InputEventResult
		>;
		const ctx = context();

		expect(await handler(input("ooo interview Build a CLI", "interactive"), ctx)).toEqual({
			handled: true,
			text: "Session interview_abc123\n\nWhat should it build?",
		});
		expect(connectSpy).toHaveBeenCalledWith(
			"ouroboros-ooo-bridge",
			{
				type: "stdio",
				command: "/opt/ouroboros/bin/ouroboros",
				args: ["mcp", "serve", "--runtime", "gjc"],
				cwd: ctx.cwd,
			},
			{ signal: expect.any(AbortSignal) },
		);
		expect(callSpy).toHaveBeenCalledWith(
			connection,
			"ouroboros_interview",
			{
				cwd: ctx.cwd,
				initial_context: "Build a CLI",
			},
			{ signal: expect.any(AbortSignal) },
		);
	});

	it("correlates ordinary answers to one interview and stops claiming input after completion", async () => {
		const connection = { name: "ouroboros-ooo-bridge" } as MCPServerConnection;
		const connect = vi.fn(async () => connection);
		const disconnect = vi.fn(async () => {});
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
				content: [{ type: "text", text: "Session interview_roundtrip\n\nWhich platforms?" }],
				_meta: { session_id: "interview_roundtrip", phase: "start" },
			})
			.mockResolvedValueOnce({
				content: [{ type: "text", text: "Interview completed. Session ID: interview_roundtrip" }],
				_meta: { session_id: "interview_roundtrip", phase: "complete", completed: true },
			});
		const handler = createOuroborosOooBridge({ connect, callTool: invoke, disconnect });
		const ctx = context();

		expect(await handler(input("ooo interview Build a CLI", "interactive"), ctx)).toEqual({
			handled: true,
			text: "Session interview_roundtrip\n\nWhich platforms?",
		});
		expect(await handler(input("Linux and macOS", "interactive"), ctx)).toEqual({
			handled: true,
			text: "Interview completed. Session ID: interview_roundtrip",
		});
		expect(invoke.mock.calls.map(call => call[2])).toEqual([
			{ cwd: ctx.cwd, initial_context: "Build a CLI" },
			{ cwd: ctx.cwd, session_id: "interview_roundtrip", answer: "Linux and macOS" },
		]);
		expect(connect).toHaveBeenCalledTimes(1);
		expect(disconnect).toHaveBeenCalledWith(connection);
		expect(await handler(input("normal prompt", "interactive"), ctx)).toEqual({});
		expect(invoke).toHaveBeenCalledTimes(2);
	});

	it("clears interview and cached transport after an MCP failure", async () => {
		const firstConnection = { name: "first" } as MCPServerConnection;
		const secondConnection = { name: "second" } as MCPServerConnection;
		const connect = vi.fn(async () => (connect.mock.calls.length === 1 ? firstConnection : secondConnection));
		const disconnect = vi.fn(async () => {});
		const invoke = vi
			.fn<typeof runtimeMcpModule.callTool>()
			.mockResolvedValueOnce({
				content: [{ type: "text", text: "Session interview_failure\n\nFirst question?" }],
				_meta: { session_id: "interview_failure", phase: "start" },
			})
			.mockRejectedValueOnce(new Error("dead transport"))
			.mockResolvedValueOnce({
				content: [{ type: "text", text: "Session interview_fresh\n\nFresh question?" }],
				_meta: { session_id: "interview_fresh", phase: "start" },
			});
		const handler = createOuroborosOooBridge({ connect, callTool: invoke, disconnect });
		const notify = vi.fn();
		const ctx = context(notify);

		await handler(input("ooo interview Initial", "interactive"), ctx);
		expect(await handler(input("answer", "interactive"), ctx)).toEqual({ handled: true });
		expect(notify).toHaveBeenCalledWith("dead transport", "error");
		expect(disconnect).toHaveBeenCalledWith(firstConnection);
		expect(await handler(input("ordinary prompt", "interactive"), ctx)).toEqual({});
		await handler(input("ooo interview Fresh", "interactive"), ctx);
		expect(connect).toHaveBeenCalledTimes(2);
		expect(invoke.mock.calls[2]?.[2]).toEqual({ cwd: ctx.cwd, initial_context: "Fresh" });
	});

	it("bypasses UI controls, resets session controls, and preserves ordinary answers", async () => {
		const connection = { name: "controls" } as MCPServerConnection;
		const invoke = vi
			.fn<typeof runtimeMcpModule.callTool>()
			.mockResolvedValueOnce({
				content: [{ type: "text", text: "Session interview_controls\n\nChoose a target?" }],
				_meta: { session_id: "interview_controls", phase: "start" },
			})
			.mockResolvedValueOnce({
				content: [{ type: "text", text: "Session interview_fresh_controls\n\nChoose again?" }],
				_meta: { session_id: "interview_fresh_controls", phase: "start" },
			})
			.mockResolvedValueOnce({
				content: [{ type: "text", text: "Interview completed. Session ID: interview_fresh_controls" }],
				_meta: { session_id: "interview_fresh_controls", phase: "complete", completed: true },
			});
		const disconnect = vi.fn(async () => {});
		const handler = createOuroborosOooBridge({
			connect: vi.fn(async () => connection),
			callTool: invoke,
			disconnect,
		});
		const ctx = context();

		await handler(input("ooo interview Controls", "interactive"), ctx);
		for (const control of ["/help", ".", "c"]) {
			expect(await handler(input(control, "interactive"), ctx)).toEqual({});
		}
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(await handler(input("/clear", "interactive"), ctx)).toEqual({});
		expect(disconnect).toHaveBeenCalledWith(connection);
		expect(await handler(input("ordinary prompt", "interactive"), ctx)).toEqual({});

		await handler(input("ooo interview Fresh controls", "interactive"), ctx);
		expect(await handler(input("Linux", "interactive"), ctx)).toEqual({
			handled: true,
			text: "Interview completed. Session ID: interview_fresh_controls",
		});
		expect(invoke.mock.calls[2]?.[2]).toEqual({
			cwd: ctx.cwd,
			session_id: "interview_fresh_controls",
			answer: "Linux",
		});
	});

	it("canonical ouroboros helper uses the same exact-prefix contract", async () => {
		const handler = createOuroborosOooBridge();
		expect(await handler(input("not ooo", "interactive"), context())).toEqual({});
	});
});

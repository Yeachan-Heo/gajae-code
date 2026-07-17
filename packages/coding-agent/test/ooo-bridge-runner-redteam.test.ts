import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@gajae-code/ai";
import type { ExecResult } from "@gajae-code/coding-agent/exec/exec";
import {
	createExactPrefixCommandBridge,
	type Extension,
	ExtensionRunner,
	type ExtensionRuntime,
	OOO_BRIDGE_RECURSION_ENV,
	OOO_BRIDGE_TIMEOUT_ENV,
} from "@gajae-code/coding-agent/extensibility/extensions";

function extensionWith(handler: ReturnType<typeof createExactPrefixCommandBridge>): Extension {
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

function runnerWith(handler: ReturnType<typeof createExactPrefixCommandBridge>): ExtensionRunner {
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
});

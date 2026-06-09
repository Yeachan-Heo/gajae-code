import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ExecResult } from "@gajae-code/coding-agent/exec/exec";
import {
	createExactPrefixCommandBridge,
	createOuroborosOooBridge,
	type Extension,
	type ExtensionContext,
	ExtensionRunner,
	type ExtensionRuntime,
	type InputEvent,
	OOO_BRIDGE_RECURSION_ENV,
} from "@gajae-code/coding-agent/extensibility/extensions";

function input(text: string, source: InputEvent["source"] = "interactive"): InputEvent {
	return { type: "input", text, source };
}

function context(): ExtensionContext {
	return {
		cwd: "/tmp",
		ui: { notify: () => {} },
	} as unknown as ExtensionContext;
}

describe("ooo bridge extension contract", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env[OOO_BRIDGE_RECURSION_ENV];
	});

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

	it("routes exact-prefix ooo input to ouroboros dispatch and handles exit zero", async () => {
		const { handler, dispatchSpy } = createHandler(0);
		const ctx = context();

		const result = await handler(input("ooo status"), ctx);

		expect(result).toEqual({ handled: true });
		expect(dispatchSpy).toHaveBeenCalledWith("ouroboros", ["dispatch", "ooo status"], ctx, { timeout: undefined });
	});

	it.each([
		["ooo", true],
		["ooo status", true],
		["please ooo status", false],
		["oook", false],
		["oooize", false],
		["oooo", false],
		["/ooo", false],
	])("matches exact prefix boundary for %p", async (text, shouldMatch) => {
		const { handler, dispatchSpy } = createHandler(0);

		const result = await handler(input(text), context());

		expect(result).toEqual(shouldMatch ? { handled: true } : {});
		expect(dispatchSpy).toHaveBeenCalledTimes(shouldMatch ? 1 : 0);
	});

	it("maps dispatch exit code 78 to continue pass-through", async () => {
		const { handler, dispatchSpy } = createHandler(78);

		const result = await handler(input("ooo status"), context());

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

		const result = await handler(input("ooo status"), ctx);

		expect(result).toEqual({ handled: true });
		expect(dispatchSpy).toHaveBeenCalledTimes(1);
		expect(notifySpy).toHaveBeenCalledWith("dispatch failed", "error");
	});

	it("runner treats non-zero non-78 bridge dispatch failures as terminal instead of model pass-through", async () => {
		const dispatcher = {
			run: async (): Promise<ExecResult> => ({ stdout: "", stderr: "dispatch failed", code: 2, killed: false }),
		};
		vi.spyOn(dispatcher, "run");
		const handler = createExactPrefixCommandBridge({
			prefix: "ooo",
			command: "ouroboros",
			args: ["dispatch"],
			dispatch: dispatcher.run,
		});
		const extension = {
			path: "ooo-bridge-test",
			resolvedPath: "ooo-bridge-test",
			handlers: new Map([["input", [handler]]]),
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		} as unknown as Extension;
		const runner = new ExtensionRunner(
			[extension],
			{ flagValues: new Map(), pendingProviderRegistrations: [] } as unknown as ExtensionRuntime,
			"/tmp",
			{} as never,
			{} as never,
		);

		const result = await runner.emitInput("ooo status", undefined, "interactive");

		expect(result).toEqual({ handled: true });
	});

	it("passes through extension-originated input to avoid recursion", async () => {
		const { handler, dispatchSpy } = createHandler(0);

		const result = await handler(input("ooo status", "extension"), context());

		expect(result).toEqual({});
		expect(dispatchSpy).not.toHaveBeenCalled();
	});

	it("recursion guard prevents nested dispatch", async () => {
		process.env[OOO_BRIDGE_RECURSION_ENV] = "1";
		const { handler, dispatchSpy } = createHandler(0);

		const result = await handler(input("ooo status"), context());

		expect(result).toEqual({});
		expect(dispatchSpy).not.toHaveBeenCalled();
	});

	it("canonical ouroboros helper uses the same exact-prefix contract", async () => {
		const handler = createOuroborosOooBridge();
		expect(await handler(input("not ooo"), context())).toEqual({});
	});
});

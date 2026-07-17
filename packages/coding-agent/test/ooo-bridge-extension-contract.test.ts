import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@gajae-code/ai";
import type { ExecResult } from "@gajae-code/coding-agent/exec/exec";
import {
	createExactPrefixCommandBridge,
	createOuroborosOooBridge,
	type ExtensionContext,
	type InputEvent,
	OOO_BRIDGE_RECURSION_ENV,
	OOO_BRIDGE_TIMEOUT_ENV,
} from "@gajae-code/coding-agent/extensibility/extensions";

function input(text: string, source?: InputEvent["source"], images?: ImageContent[]): InputEvent {
	return { type: "input", text, source, images } as InputEvent;
}

function context(): ExtensionContext {
	return {
		cwd: "/tmp",
		ui: { notify: () => {} },
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
	});

	it("routes exact-prefix ooo input to ouroboros dispatch and handles exit zero", async () => {
		const { handler, dispatchSpy } = createHandler(0);
		const ctx = context();

		const result = await handler(input("ooo status", "interactive"), ctx);

		expect(result).toEqual({ handled: true });
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

		expect(first).toEqual({ handled: true });
		expect(second).toEqual({ handled: true });
		expect(dispatchSpy.mock.calls.map(call => call[1])).toEqual([
			["dispatch", "ooo one"],
			["dispatch", "ooo two"],
		]);
	});

	it("canonical ouroboros helper uses the same exact-prefix contract", async () => {
		const handler = createOuroborosOooBridge();
		expect(await handler(input("not ooo", "interactive"), context())).toEqual({});
	});
});

import { describe, expect, it } from "bun:test";
import { resolveLaunchDisposition } from "@gajae-code/coding-agent/main";

const base = {
	stdinIsTTY: true,
	pipedInput: undefined as string | undefined,
	hasMessages: false,
	print: false,
	mode: undefined as string | undefined,
};

describe("resolveLaunchDisposition", () => {
	it("launches interactive on a TTY with no flags", () => {
		expect(resolveLaunchDisposition({ ...base })).toEqual({ autoPrint: false, isInteractive: true });
	});

	it("auto-prints piped stdin content (existing behavior)", () => {
		expect(resolveLaunchDisposition({ ...base, stdinIsTTY: false, pipedInput: "review this" })).toEqual({
			autoPrint: true,
			isInteractive: false,
		});
	});

	it("auto-prints when stdin is non-TTY but EMPTY and a prompt was passed (the `gjc <words> </dev/null` orphan case)", () => {
		expect(resolveLaunchDisposition({ ...base, stdinIsTTY: false, hasMessages: true })).toEqual({
			autoPrint: true,
			isInteractive: false,
		});
	});

	it("fails fast when stdin is non-TTY and there is nothing to run (previously: forever-hang in the TUI event loop)", () => {
		const disposition = resolveLaunchDisposition({ ...base, stdinIsTTY: false });
		expect(disposition.isInteractive).toBe(false);
		expect(disposition.autoPrint).toBe(false);
		expect(disposition.nonInteractiveError).toContain("stdin is not a TTY");
	});

	it("leaves explicit --print untouched on non-TTY stdin", () => {
		expect(resolveLaunchDisposition({ ...base, stdinIsTTY: false, print: true })).toEqual({
			autoPrint: false,
			isInteractive: false,
		});
	});

	it("leaves --mode launches untouched (rpc/acp/bridge legitimately run over non-TTY stdio)", () => {
		expect(resolveLaunchDisposition({ ...base, stdinIsTTY: false, mode: "rpc" })).toEqual({
			autoPrint: false,
			isInteractive: false,
		});
	});

	it("explicit --print wins over piped-input auto-print", () => {
		expect(resolveLaunchDisposition({ ...base, stdinIsTTY: false, pipedInput: "x", print: true })).toEqual({
			autoPrint: false,
			isInteractive: false,
		});
	});
});

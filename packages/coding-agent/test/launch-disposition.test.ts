import { describe, expect, it } from "bun:test";
import { NON_TTY_NO_INPUT_ERROR, resolveLaunchDisposition } from "../src/main";

const base = {
	stdinIsTTY: true,
	pipedInput: undefined as string | undefined,
	hasPreparedInput: false,
	print: false,
	mode: undefined as string | undefined,
};

describe("resolveLaunchDisposition", () => {
	it("launches interactive on a TTY with no flags", () => {
		expect(resolveLaunchDisposition({ ...base })).toEqual({ autoPrint: false, isInteractive: true });
	});

	it("keeps a TTY launch with a positional prompt interactive (initial prompt runs inside the TUI)", () => {
		expect(resolveLaunchDisposition({ ...base, hasPreparedInput: true })).toEqual({
			autoPrint: false,
			isInteractive: true,
		});
	});

	it("auto-prints piped stdin content", () => {
		expect(resolveLaunchDisposition({ ...base, stdinIsTTY: false, pipedInput: "review this" })).toEqual({
			autoPrint: true,
			isInteractive: false,
		});
	});

	it("auto-prints prepared positional/@file input on non-TTY stdin (the `gjc <words> </dev/null` orphan case)", () => {
		expect(resolveLaunchDisposition({ ...base, stdinIsTTY: false, hasPreparedInput: true })).toEqual({
			autoPrint: true,
			isInteractive: false,
		});
	});

	it("auto-prints prepared input even when stdin never produced content (open pipe, no EOF)", () => {
		// pipedInput is undefined here because the call site skips reading stdin
		// entirely when prepared input exists — an open pipe must not block it.
		expect(
			resolveLaunchDisposition({ ...base, stdinIsTTY: false, pipedInput: undefined, hasPreparedInput: true }),
		).toEqual({ autoPrint: true, isInteractive: false });
	});

	it("fails fast when stdin is non-TTY and there is nothing to run (previously: forever-hang in the TUI event loop)", () => {
		const disposition = resolveLaunchDisposition({ ...base, stdinIsTTY: false });
		expect(disposition.isInteractive).toBe(false);
		expect(disposition.autoPrint).toBe(false);
		expect(disposition.nonInteractiveError).toBe(NON_TTY_NO_INPUT_ERROR);
	});

	it("leaves explicit --print untouched on non-TTY stdin", () => {
		expect(resolveLaunchDisposition({ ...base, stdinIsTTY: false, print: true })).toEqual({
			autoPrint: false,
			isInteractive: false,
		});
	});

	it("leaves --mode launches untouched (rpc/acp/bridge legitimately run over non-TTY stdio)", () => {
		for (const mode of ["rpc", "acp", "bridge", "json", "text"]) {
			expect(resolveLaunchDisposition({ ...base, stdinIsTTY: false, mode })).toEqual({
				autoPrint: false,
				isInteractive: false,
			});
		}
	});

	it("explicit --print wins over piped-input auto-print", () => {
		expect(resolveLaunchDisposition({ ...base, stdinIsTTY: false, pipedInput: "x", print: true })).toEqual({
			autoPrint: false,
			isInteractive: false,
		});
	});
});

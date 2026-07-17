import { describe, expect, it } from "bun:test";
import { buildMacOSNoFileLimitWarning, parseNoFileLimit, warnIfMacOSNoFileLimitTooLow } from "../src/cli/nofile-limit";

describe("macOS nofile limit preflight", () => {
	it("parses finite ulimit output", () => {
		expect(parseNoFileLimit("256\n")).toBe(256);
		expect(parseNoFileLimit("4096")).toBe(4096);
		expect(parseNoFileLimit("unlimited\n")).toBeUndefined();
		expect(parseNoFileLimit("not-a-number")).toBeUndefined();
	});

	it("warns with realistic macOS remediation for low limits", () => {
		const chunks: string[] = [];
		warnIfMacOSNoFileLimitTooLow({
			platform: "darwin",
			env: {},
			execFileSync: (() => "256\n") as never,
			writeStderr: text => chunks.push(text),
		});
		const output = chunks.join("");
		expect(output).toContain("ulimit -n = 256");
		expect(output).toContain("ulimit -n 4096");
		expect(output).toContain("sudo launchctl limit maxfiles 4096 65536");
		expect(output).toContain("Avoid using huge values such as 2147483646");
	});

	it("does not warn on non-macOS, skipped, or adequate limits", () => {
		for (const deps of [
			{ platform: "linux" as const, env: {}, execFileSync: (() => "256\n") as never },
			{ platform: "darwin" as const, env: { GJC_SKIP_NOFILE_CHECK: "1" }, execFileSync: (() => "256\n") as never },
			{ platform: "darwin" as const, env: {}, execFileSync: (() => "4096\n") as never },
		]) {
			const chunks: string[] = [];
			warnIfMacOSNoFileLimitTooLow({ ...deps, writeStderr: text => chunks.push(text) });
			expect(chunks).toEqual([]);
		}
	});

	it("keeps the standalone message actionable", () => {
		expect(buildMacOSNoFileLimitWarning(256)).toContain("Set GJC_SKIP_NOFILE_CHECK=1");
	});
});

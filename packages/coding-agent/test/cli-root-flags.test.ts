import { describe, expect, it } from "bun:test";
import { assertLocalLaunchArgs, parseArgs } from "../src/cli/args";
import { ROOT_LAUNCH_FLAGS } from "../src/cli/root-flags";
import { parseLaunchWorktreeMode } from "../src/gjc-runtime/launch-worktree";

const FLAG_VALUES: Record<string, string> = {
	"mcp-config": "/tmp/gjc-mcp.json",
};

describe("CLI root flag parity", () => {
	it("keeps every advertised flag connected to its runtime parser", () => {
		for (const [name, descriptor] of Object.entries(ROOT_LAUNCH_FLAGS)) {
			if (name === "worktree") {
				expect(parseLaunchWorktreeMode(["--worktree", "feature/root-flags"]).mode).toEqual({
					enabled: true,
					detached: false,
					name: "feature/root-flags",
				});
				continue;
			}

			const argv = [`--${name}`];
			if (name === "default") argv.unshift("--mpreset", "test");
			if (descriptor.kind === "string") argv.push(descriptor.options?.[0] ?? FLAG_VALUES[name] ?? "value");
			expect(() => assertLocalLaunchArgs(parseArgs(argv))).not.toThrow();
		}
	});

	it("keeps compact worktree forms and the literal delimiter intact", () => {
		for (const flag of ["-wfeature/root-flags", "-w=feature/root-flags"]) {
			expect(() => parseArgs([flag])).not.toThrow();
			expect(parseLaunchWorktreeMode([flag]).mode).toEqual({
				enabled: true,
				detached: false,
				name: "feature/root-flags",
			});
		}
		expect(parseLaunchWorktreeMode(["--worktree", "--", "--modle", "@prompt.md"]).remainingArgs).toEqual([
			"--",
			"--modle",
			"@prompt.md",
		]);
	});

	it("rejects ACP-only extension and skill flags while forwarding local startup flags", () => {
		for (const [args, expected] of [
			[["--hook", "/tmp/hook.ts"], "--hook"],
			[["--extension", "/tmp/extension.ts"], "--extension"],
			[["-e", "/tmp/extension.ts"], "--extension"],
			[["--no-extensions"], "--no-extensions"],
			[["--skills", "git-*"], "--skills"],
		] as const) {
			expect(() => assertLocalLaunchArgs(parseArgs([...args]))).toThrow(`Unknown option: ${expected}`);
		}
		expect(() => assertLocalLaunchArgs(parseArgs(["--no-skills"]))).not.toThrow();
	});

	it("rejects unknown options by default while preserving dash-prefixed prompt text after --", () => {
		expect(() => parseArgs(["--modle", "opus"])).toThrow("Unknown option: --modle");
		expect(parseArgs(["--", "--modle", "@prompt.md"])).toMatchObject({
			messages: ["--modle"],
			fileArgs: ["prompt.md"],
		});
	});
});

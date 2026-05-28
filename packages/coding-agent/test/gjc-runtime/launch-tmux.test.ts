import { describe, expect, it } from "bun:test";
import type { Args } from "@gajae-code/coding-agent/cli/args";
import {
	applyGjcTmuxProfile,
	buildDefaultTmuxLaunchPlan,
	buildGjcTmuxProfileCommands,
	GJC_DEFAULT_TMUX_SESSION,
	GJC_TMUX_LAUNCHED_ENV,
	launchDefaultTmuxIfNeeded,
	type TmuxSpawnOptions,
} from "@gajae-code/coding-agent/gjc-runtime/launch-tmux";

function args(overrides: Partial<Args> = {}): Args {
	return {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		...overrides,
	};
}

const interactiveTty = { stdin: true, stdout: true };

describe("default GJC tmux launch", () => {
	it("does not plan tmux for interactive root launch without --tmux", () => {
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"] }),
			rawArgs: ["hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
		});

		expect(plan).toBeUndefined();
	});

	it("plans an interactive --tmux root launch inside the gajae_code tmux session", () => {
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
		});

		expect(plan?.sessionName).toBe(GJC_DEFAULT_TMUX_SESSION);
		expect(plan?.tmuxCommand).toBe("tmux");
		expect(plan?.newSessionArgs.slice(0, 6)).toEqual(["new-session", "-d", "-s", "gajae_code", "-c", "/repo"]);
		expect(plan?.innerCommand).toContain(`${GJC_TMUX_LAUNCHED_ENV}=1`);
		expect(plan?.innerCommand).toContain(
			"'/bin/bun' '/repo/packages/coding-agent/src/cli.ts' '--tmux' 'hello world'",
		);
	});

	it("builds a session-scoped tmux profile without global tmux mutation", () => {
		const commands = buildGjcTmuxProfileCommands("gjc-session:0", {});
		const args = commands.map(command => command.args);

		expect(args).toContainEqual(["set-option", "-t", "gjc-session:0", "mouse", "on"]);
		expect(args).toContainEqual(["set-option", "-t", "gjc-session:0", "@gjc-profile", "1"]);
		expect(args).toContainEqual(["set-option", "-t", "gjc-session:0", "set-clipboard", "on"]);
		expect(args).toContainEqual([
			"set-window-option",
			"-t",
			"gjc-session:0",
			"mode-style",
			"fg=colour231,bg=colour60",
		]);
		expect(args.flat()).not.toContain("-g");
		expect(buildGjcTmuxProfileCommands("gjc-session:0", { GJC_TMUX_PROFILE: "false" })).toEqual([]);
		expect(
			buildGjcTmuxProfileCommands("gjc-session:0", { GJC_MOUSE: "off" }).flatMap(command => command.args),
		).not.toContain("mouse");
	});

	it("applies the tmux profile only to the requested target", () => {
		const calls: { command: string; args: string[] }[] = [];
		const result = applyGjcTmuxProfile({
			tmuxCommand: "tmux",
			target: "%7",
			cwd: "/repo",
			env: {},
			spawnSync: (command, spawnArgs) => {
				calls.push({ command, args: spawnArgs });
				return { exitCode: 0 };
			},
		});

		expect(result.skipped).toBe(false);
		expect(result.failures).toEqual([]);
		expect(calls).toHaveLength(4);
		expect(calls.every(call => call.command === "tmux")).toBe(true);
		expect(calls.every(call => call.args.includes("-t") && call.args.includes("%7"))).toBe(true);
		expect(calls.flatMap(call => call.args)).not.toContain("-g");
	});

	it("does not wrap non-interactive or already wrapped launches", () => {
		const common = {
			rawArgs: [],
			cwd: "/repo",
			argv: ["/usr/local/bin/gjc"],
			execPath: "/bin/bun",
			platform: "darwin" as const,
			tty: interactiveTty,
			tmuxAvailable: true,
		};

		expect(buildDefaultTmuxLaunchPlan({ ...common, parsed: args({ print: true }), env: {} })).toBeUndefined();
		expect(buildDefaultTmuxLaunchPlan({ ...common, parsed: args({ mode: "json" }), env: {} })).toBeUndefined();
		expect(
			buildDefaultTmuxLaunchPlan({ ...common, parsed: args({ tmux: true }), env: { TMUX: "/tmp/tmux" } }),
		).toBeUndefined();
		expect(
			buildDefaultTmuxLaunchPlan({
				...common,
				parsed: args({ tmux: true }),
				env: { [GJC_TMUX_LAUNCHED_ENV]: "1" },
			}),
		).toBeUndefined();
	});

	it("attaches an existing gajae_code session without mutating its profile when creation fails", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ tmux: true }),
			rawArgs: [],
			cwd: "/repo",
			env: {},
			argv: ["/usr/local/bin/gjc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				return { exitCode: calls.length === 1 ? 1 : 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls).toHaveLength(2);
		expect(calls[0].args[0]).toBe("new-session");
		expect(calls.at(-1)?.args).toEqual(["attach-session", "-t", "gajae_code"]);
	});

	it("falls through to direct launch when tmux is unavailable", () => {
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ tmux: true }),
			rawArgs: [],
			cwd: "/repo",
			env: {},
			argv: ["/usr/local/bin/gjc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: false,
		});

		expect(plan).toBeUndefined();
	});
});

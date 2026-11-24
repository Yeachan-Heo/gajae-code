import { describe, expect, test } from "bun:test";
import {
	ASIDE_INSTALL_COMMAND,
	ASIDE_USAGE,
	asideCliCandidates,
	createAsideHandler,
	formatAsideMcpRegistration,
	parseAsideArgv,
	posixQuote,
	probeAsideCli,
	resolveAsideCliPath,
	windowsPowerShellQuote,
} from "./helpers/aside";

function runtimeHarness() {
	const output: string[] = [];
	return {
		runtime: {
			session: {},
			settings: {},
			cwd: "/tmp",
			output: async (message: string) => {
				output.push(message);
			},
		} as never,
		output,
	};
}

describe("Aside CLI probe", () => {
	test("lists installer symlink then the macOS app bundle", () => {
		expect(asideCliCandidates("/Users/demo")).toEqual([
			"/Users/demo/.local/bin/aside",
			"/Users/demo/.aside/cli/Aside CLI.app/Contents/MacOS/aside",
		]);
	});

	test("prefers the installer symlink over PATH", () => {
		const path = resolveAsideCliPath("/Users/demo", {
			isExecutable: filePath => filePath === "/Users/demo/.local/bin/aside",
			which: () => "/opt/homebrew/bin/aside",
		});
		expect(path).toBe("/Users/demo/.local/bin/aside");
	});

	test("falls back to PATH when local candidates are missing", () => {
		const probe = probeAsideCli("/Users/demo", {
			isExecutable: filePath => filePath === "/opt/homebrew/bin/aside",
			which: command => (command === "aside" ? "/opt/homebrew/bin/aside" : null),
		});
		expect(probe).toEqual({ ok: true, path: "/opt/homebrew/bin/aside" });
	});

	test("reports searched locations when nothing is executable", () => {
		const probe = probeAsideCli("/Users/demo", {
			isExecutable: () => false,
			which: () => null,
		});
		expect(probe.ok).toBe(false);
		if (probe.ok) throw new Error("expected a miss");
		expect(probe.searched).toContain("/Users/demo/.local/bin/aside");
		expect(probe.searched).toContain("PATH (aside)");
		expect(probe.manualInstallCommand).toBe(ASIDE_INSTALL_COMMAND);
	});
});

describe("posixQuote", () => {
	test("quotes paths that contain spaces", () => {
		expect(posixQuote("/Users/demo/.aside/cli/Aside CLI.app/Contents/MacOS/aside")).toBe(
			"'/Users/demo/.aside/cli/Aside CLI.app/Contents/MacOS/aside'",
		);
	});

	test("leaves simple paths unquoted", () => {
		expect(posixQuote("/Users/demo/.local/bin/aside")).toBe("/Users/demo/.local/bin/aside");
	});

	test("quotes native Windows paths for PowerShell", () => {
		expect(windowsPowerShellQuote("C:\\Users\\demo\\Aside CLI\\aside.exe")).toBe(
			"'C:\\Users\\demo\\Aside CLI\\aside.exe'",
		);
		expect(windowsPowerShellQuote("C:\\Users\\O'Brien\\aside.exe")).toBe("'C:\\Users\\O''Brien\\aside.exe'");
		// PowerShell treats U+2018 through U+201B as single quotes too.
		expect(windowsPowerShellQuote("C:\\Users\\O\u2019Brien\\aside.exe")).toBe(
			"'C:\\Users\\O\u2019\u2019Brien\\aside.exe'",
		);
	});

	test("selects PowerShell quoting for native Windows MCP commands", () => {
		const cliPath = "C:\\Users\\demo\\Aside CLI\\aside.exe";
		expect(formatAsideMcpRegistration(cliPath, "win32")).toContain(
			`gjc mcp add aside ${windowsPowerShellQuote(cliPath)} mcp --project`,
		);
	});
});

describe("parseAsideArgv", () => {
	test("preserves empty quoted arguments and escaped quotes", () => {
		expect(parseAsideArgv('exec --message "" it\\\'s')).toEqual({
			ok: true,
			args: ["exec", "--message", "", "it's"],
		});
		expect(parseAsideArgv('exec "say \\"hello\\""')).toEqual({
			ok: true,
			args: ["exec", 'say "hello"'],
		});
	});

	test("rejects unterminated quotes and escapes", () => {
		expect(parseAsideArgv('exec "unterminated')).toEqual({ ok: false, error: "unterminated quote" });
		expect(parseAsideArgv("exec trailing\\")).toEqual({ ok: false, error: "unfinished escape" });
	});
});

describe("/aside slash command", () => {
	test("prints usage for help verbs without probing", async () => {
		const handle = createAsideHandler({
			homedir: () => "/missing",
			isExecutable: () => false,
			which: () => null,
			exec: async () => {
				throw new Error("exec should not run for /aside help");
			},
		});
		const { runtime, output } = runtimeHarness();
		expect(await handle({ name: "aside", args: "help", text: "/aside help" }, runtime)).toEqual({ consumed: true });
		expect(output).toEqual([ASIDE_USAGE]);
	});

	test("guides installation when the CLI is missing", async () => {
		const handle = createAsideHandler({
			homedir: () => "/Users/demo",
			isExecutable: () => false,
			which: () => null,
			exec: async () => {
				throw new Error("exec should not run when CLI is missing");
			},
		});
		const { runtime, output } = runtimeHarness();
		expect(await handle({ name: "aside", args: "", text: "/aside" }, runtime)).toEqual({ consumed: true });
		expect(output[0]).toContain("Aside CLI was not found.");
		expect(output[0]).toContain(ASIDE_INSTALL_COMMAND);
		expect(output[0]).toContain(ASIDE_USAGE);
	});

	test("status prints the resolved path and version", async () => {
		const execCalls: string[][] = [];
		const handle = createAsideHandler({
			homedir: () => "/Users/demo",
			isExecutable: filePath => filePath === "/Users/demo/.local/bin/aside",
			which: () => null,
			exec: async (_command, args) => {
				execCalls.push(args);
				return { stdout: "1.26.810\n", stderr: "", code: 0, killed: false };
			},
		});
		const { runtime, output } = runtimeHarness();
		expect(await handle({ name: "aside", args: "", text: "/aside" }, runtime)).toEqual({ consumed: true });
		expect(execCalls).toEqual([["--version"]]);
		expect(output[0]).toContain("Aside CLI: /Users/demo/.local/bin/aside");
		expect(output[0]).toContain("Version: 1.26.810");
		expect(output[0]).toContain(ASIDE_USAGE);
	});

	test("sanitizes version output before rendering status", async () => {
		const handle = createAsideHandler({
			homedir: () => "/Users/demo",
			isExecutable: filePath => filePath === "/Users/demo/.local/bin/aside",
			which: () => null,
			exec: async () => ({ stdout: "\x1b]0;pwned\x071.26.810\n", stderr: "", code: 0, killed: false }),
		});
		const { runtime, output } = runtimeHarness();
		await handle({ name: "aside", args: "", text: "/aside" }, runtime);
		expect(output[0]).toContain("Version: 1.26.810");
		expect(output[0]).not.toContain("pwned");
	});

	test("freeform prompts run aside exec with a single prompt argument", async () => {
		const execCalls: Array<{ command: string; args: string[] }> = [];
		const handle = createAsideHandler({
			homedir: () => "/Users/demo",
			isExecutable: filePath => filePath === "/Users/demo/.local/bin/aside",
			which: () => null,
			exec: async (command, args) => {
				execCalls.push({ command, args });
				return { stdout: "ok", stderr: "", code: 0, killed: false };
			},
		});
		const { runtime, output } = runtimeHarness();
		expect(
			await handle(
				{ name: "aside", args: "Summarize the current page", text: "/aside Summarize the current page" },
				runtime,
			),
		).toEqual({ consumed: true });
		expect(execCalls).toEqual([
			{ command: "/Users/demo/.local/bin/aside", args: ["exec", "Summarize the current page"] },
		]);
		expect(output).toEqual(["ok"]);
	});

	test("exec passes quoted argv through without a shell", async () => {
		const execCalls: string[][] = [];
		const handle = createAsideHandler({
			homedir: () => "/Users/demo",
			isExecutable: filePath => filePath === "/Users/demo/.local/bin/aside",
			which: () => null,
			exec: async (_command, args) => {
				execCalls.push(args);
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		});
		const { runtime, output } = runtimeHarness();
		expect(
			await handle(
				{
					name: "aside",
					args: 'exec --session abc "Continue later"',
					text: '/aside exec --session abc "Continue later"',
				},
				runtime,
			),
		).toEqual({ consumed: true });
		expect(execCalls).toEqual([["exec", "--session", "abc", "Continue later"]]);
		expect(output).toEqual(["Aside CLI exited 0 with no output."]);
	});

	test("leading flags are forwarded to aside exec", async () => {
		const execCalls: string[][] = [];
		const handle = createAsideHandler({
			homedir: () => "/Users/demo",
			isExecutable: filePath => filePath === "/Users/demo/.local/bin/aside",
			which: () => null,
			exec: async (_command, args) => {
				execCalls.push(args);
				return { stdout: "continued", stderr: "", code: 0, killed: false };
			},
		});
		const { runtime } = runtimeHarness();
		await handle({ name: "aside", args: "--session abc Continue", text: "/aside --session abc Continue" }, runtime);
		expect(execCalls).toEqual([["exec", "--session", "abc", "Continue"]]);
	});

	test("mcp prints a quoted registration command and does not spawn stdio", async () => {
		const handle = createAsideHandler({
			homedir: () => "/Users/demo",
			isExecutable: filePath => filePath.includes("Aside CLI.app"),
			which: () => null,
			exec: async () => {
				throw new Error("mcp must not spawn aside mcp");
			},
		});
		const { runtime, output } = runtimeHarness();
		const cliPath = "/Users/demo/.aside/cli/Aside CLI.app/Contents/MacOS/aside";
		expect(await handle({ name: "aside", args: "mcp", text: "/aside mcp" }, runtime)).toEqual({ consumed: true });
		expect(output).toEqual([formatAsideMcpRegistration(cliPath)]);
		expect(output[0]).toContain(`gjc mcp add aside ${posixQuote(cliPath)} mcp --project`);
		expect(output[0]).not.toContain("aside mcp\n");
	});

	test("rejects unexpected MCP arguments without probing or spawning", async () => {
		const handle = createAsideHandler({
			homedir: () => "/missing",
			isExecutable: () => false,
			which: () => null,
			exec: async () => {
				throw new Error("mcp must not spawn");
			},
		});
		const { runtime, output } = runtimeHarness();
		expect(await handle({ name: "aside", args: "mcp unexpected", text: "/aside mcp unexpected" }, runtime)).toEqual({
			consumed: true,
		});
		expect(output).toEqual(["Usage: /aside mcp"]);
	});

	test("repl refuses to run inside GJC", async () => {
		const handle = createAsideHandler({
			homedir: () => "/Users/demo",
			isExecutable: filePath => filePath === "/Users/demo/.local/bin/aside",
			which: () => null,
			exec: async () => {
				throw new Error("repl must not spawn");
			},
		});
		const { runtime, output } = runtimeHarness();
		expect(await handle({ name: "aside", args: "repl", text: "/aside repl" }, runtime)).toEqual({ consumed: true });
		expect(output[0]).toContain("needs a real terminal TTY");
		expect(output[0]).toContain("/Users/demo/.local/bin/aside repl");
	});

	test("rejects unexpected REPL arguments without probing or spawning", async () => {
		const handle = createAsideHandler({
			homedir: () => "/missing",
			isExecutable: () => false,
			which: () => null,
			exec: async () => {
				throw new Error("repl must not spawn");
			},
		});
		const { runtime, output } = runtimeHarness();
		expect(await handle({ name: "aside", args: "repl unexpected", text: "/aside repl unexpected" }, runtime)).toEqual(
			{
				consumed: true,
			},
		);
		expect(output).toEqual(["Usage: /aside repl"]);
	});

	test("account forwards subcommands", async () => {
		const execCalls: string[][] = [];
		const handle = createAsideHandler({
			homedir: () => "/Users/demo",
			isExecutable: filePath => filePath === "/Users/demo/.local/bin/aside",
			which: () => null,
			exec: async (_command, args) => {
				execCalls.push(args);
				return { stdout: "u0", stderr: "", code: 0, killed: false };
			},
		});
		const { runtime, output } = runtimeHarness();
		expect(await handle({ name: "aside", args: "account list", text: "/aside account list" }, runtime)).toEqual({
			consumed: true,
		});
		expect(execCalls).toEqual([["account", "list"]]);
		expect(output).toEqual(["u0"]);
	});

	test("nonzero CLI exit is consumed with a non-zero status", async () => {
		const handle = createAsideHandler({
			homedir: () => "/Users/demo",
			isExecutable: filePath => filePath === "/Users/demo/.local/bin/aside",
			which: () => null,
			exec: async () => ({ stdout: "no daemon", stderr: "", code: 1, killed: false }),
		});
		const { runtime, output } = runtimeHarness();
		expect(await handle({ name: "aside", args: "account status", text: "/aside account status" }, runtime)).toEqual({
			consumed: true,
			exitCode: 1,
		});
		expect(output).toEqual(["no daemon\n(exit 1)"]);
	});

	test("timeout results are consumed with a non-zero status", async () => {
		const handle = createAsideHandler({
			homedir: () => "/Users/demo",
			isExecutable: filePath => filePath === "/Users/demo/.local/bin/aside",
			which: () => null,
			exec: async () => ({ stdout: "partial", stderr: "", code: 0, killed: true }),
		});
		const { runtime, output } = runtimeHarness();
		expect(await handle({ name: "aside", args: "exec Continue", text: "/aside exec Continue" }, runtime)).toEqual({
			consumed: true,
			exitCode: 1,
		});
		expect(output).toEqual(["partial\nAside CLI timed out or was cancelled."]);
	});

	test("sanitizes CLI control sequences before rendering output", async () => {
		const handle = createAsideHandler({
			homedir: () => "/Users/demo",
			isExecutable: filePath => filePath === "/Users/demo/.local/bin/aside",
			which: () => null,
			exec: async () => ({ stdout: "\x1b]0;pwned\x07safe", stderr: "", code: 0, killed: false }),
		});
		const { runtime, output } = runtimeHarness();
		await handle({ name: "aside", args: "account status", text: "/aside account status" }, runtime);
		expect(output).toEqual(["safe"]);
	});
});

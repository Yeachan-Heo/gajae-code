import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "../src/cli/args";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

function extractRegisteredCommands(source: string): string[] {
	const commandsBlock = source.match(/const commands: CommandEntry\[\] = \[([\s\S]*?)\];/);
	if (!commandsBlock) return [];
	return [...commandsBlock[1].matchAll(/\bname:\s*"([^"]+)"/g)].map(match => match[1]);
}

describe("GJC public CLI command surface", () => {
	it("registers launch plus retained workflow/runtime utility endpoints", async () => {
		const source = await Bun.file(cliEntry).text();
		expect(extractRegisteredCommands(source)).toEqual([
			"codex-native-hook",
			"state",
			"setup",
			"skills",
			"session",
			"team",
			"ultragoal",
			"ralplan",
			"contribute-pr",
			"deep-interview",
			"update",
			"launch",
		]);
	});

	it("exposes the update command help without launching the TUI", () => {
		const result = Bun.spawnSync(["bun", cliEntry, "update", "--help"], {
			cwd: repoRoot,
			stderr: "pipe",
			stdout: "pipe",
		});
		const stdout = result.stdout.toString();
		const stderr = result.stderr.toString();
		const combined = `${stdout}\n${stderr}`;

		expect(result.exitCode, combined).toBe(0);
		expect(stdout).toContain("Check for and install updates");
		expect(combined).not.toContain("What's New");
		expect(combined).not.toContain("chatContainer");
	});

	it("documents the native CLI surface in command help", async () => {
		for (const command of ["ralplan", "deep-interview", "state"]) {
			const result = Bun.spawnSync(["bun", cliEntry, command, "--help"], {
				cwd: repoRoot,
				stderr: "pipe",
				stdout: "pipe",
			});
			const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;

			expect(result.exitCode, output).toBe(0);
			expect(output).not.toContain("GJC_RUNTIME_BINARY");
			expect(output).not.toContain("private runtime");
		}
	});

	it("documents team dry-run state behavior in command help", async () => {
		const result = Bun.spawnSync(["bun", cliEntry, "team", "--help"], {
			cwd: repoRoot,
			stderr: "pipe",
			stdout: "pipe",
		});
		const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;

		expect(result.exitCode, output).toBe(0);
		expect(output).toContain("--dry-run");
		expect(output).toContain(".gjc/state/team");
		expect(output).toContain("do not commit");
	});

	it("does not capture absolute-path prompts as startup slash commands", () => {
		const parsed = parseArgs(["/tmp/request.md", "--model", "opus", "summarize"]);

		expect(parsed.model).toBe("opus");
		expect(parsed.messages).toEqual(["/tmp/request.md", "summarize"]);
	});

	it("keeps startup slash payload intact after normal CLI flags", () => {
		const parsed = parseArgs([
			"--no-lsp",
			"/provider",
			"add",
			"--compat",
			"anthropic",
			"--provider",
			"minimax",
			"--base-url",
			"https://api.minimax.io/anthropic",
			"--api-key-env",
			"MINIMAX_APIKEY",
			"--model",
			"MiniMax-M2.7-highspeed",
		]);

		expect(parsed.noLsp).toBe(true);
		expect(parsed.provider).toBeUndefined();
		expect(parsed.model).toBeUndefined();
		expect(parsed.messages).toEqual([
			"/provider add --compat anthropic --provider minimax --base-url https://api.minimax.io/anthropic --api-key-env MINIMAX_APIKEY --model MiniMax-M2.7-highspeed",
		]);
	});

	it("keeps CLI slash-command invocations as one initial message", () => {
		const parsed = parseArgs([
			"/provider",
			"add",
			"--compat",
			"anthropic",
			"--provider",
			"minimax",
			"--base-url",
			"https://api.minimax.io/anthropic",
			"--api-key-env",
			"MINIMAX_APIKEY",
			"--model",
			"MiniMax-M2.7-highspeed",
		]);

		expect(parsed.messages).toEqual([
			"/provider add --compat anthropic --provider minimax --base-url https://api.minimax.io/anthropic --api-key-env MINIMAX_APIKEY --model MiniMax-M2.7-highspeed",
		]);
	});

	it("routes bare setup as the default workflow-skill setup command", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-setup-command-home-"));
		try {
			const result = Bun.spawnSync(["bun", cliEntry, "setup", "--json"], {
				cwd: repoRoot,
				env: { ...process.env, HOME: home, GJC_CODING_AGENT_DIR: path.join(home, ".gjc", "agent") },
				stderr: "pipe",
				stdout: "pipe",
			});
			const stdout = result.stdout.toString();
			const stderr = result.stderr.toString();

			expect(result.exitCode, stderr).toBe(0);
			const payload = JSON.parse(stdout) as { written?: number; targetRoot?: string };
			expect(payload.written).toBe(6);
			expect(payload.targetRoot).toContain(path.join(home, ".gjc", "agent"));
		} finally {
			await fs.rm(home, { recursive: true, force: true });
		}
	}, 15_000);
});

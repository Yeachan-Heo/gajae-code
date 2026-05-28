import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

function extractRegisteredCommands(source: string): string[] {
	const commandsBlock = source.match(/const commands: CommandEntry\[\] = \[([\s\S]*?)\];/);
	if (!commandsBlock) return [];
	return [...commandsBlock[1].matchAll(/\{ name: "([^"]+)"/g)].map(match => match[1]);
}

describe("GJC public CLI command surface", () => {
	it("registers launch plus retained workflow/runtime utility endpoints", async () => {
		const source = await Bun.file(cliEntry).text();
		expect(extractRegisteredCommands(source)).toEqual([
			"codex-native-hook",
			"question",
			"state",
			"setup",
			"update",
			"team",
			"ultragoal",
			"ralplan",
			"deep-interview",
			"launch",
		]);
	});

	it("routes bare setup as the default workflow-skill setup command", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-setup-command-home-"));
		try {
			const result = Bun.spawnSync(["bun", cliEntry, "setup", "--json"], {
				cwd: repoRoot,
				env: { ...process.env, HOME: home },
				stderr: "pipe",
				stdout: "pipe",
			});
			const stdout = result.stdout.toString();
			const stderr = result.stderr.toString();

			expect(result.exitCode, stderr).toBe(0);
			const payload = JSON.parse(stdout) as { written?: number; targetRoot?: string };
			expect(payload.written).toBe(4);
			expect(payload.targetRoot).toContain(path.join(home, ".gjc", "agent"));
		} finally {
			await fs.rm(home, { recursive: true, force: true });
		}
	}, 15_000);

	it("routes bare update as the update command", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-update-command-home-"));
		try {
			const result = Bun.spawnSync(["bun", cliEntry, "update", "--help"], {
				cwd: repoRoot,
				env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: path.join(home, ".gjc", "agent") },
				stderr: "pipe",
				stdout: "pipe",
			});
			const stdout = result.stdout.toString();
			const stderr = result.stderr.toString();

			expect(result.exitCode, stderr).toBe(0);
			expect(stdout).toContain("Check for and install updates");
		} finally {
			await fs.rm(home, { recursive: true, force: true });
		}
	}, 15_000);
});

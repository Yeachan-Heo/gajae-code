import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `resolveConfigPaths` picks the `config.yml` whose `skills.customDirectories`
 * the agent then loads skills from, so the directory it is built from is a trust
 * boundary. It used to read `GJC_CODING_AGENT_DIR` / `GJC_CONFIG_DIR` straight
 * from `process.env`, which Bun populates from `cwd/.env` before any module
 * runs — so a repository could point the hook at a directory it ships and inject
 * its own skill directories, bypassing `trustedAgentDirOverride`.
 *
 * The value is only visible to a process started with that cwd, so these drive a
 * child process.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "skill-hook-config-probe.ts");
const scenarios: string[] = [];

afterEach(() => {
	for (const dir of scenarios.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function scenario(dotenv: string | undefined, configs: Record<string, string>): { dir: string; home: string } {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-skill-hook-trust-")));
	scenarios.push(dir);
	const repo = path.join(dir, "repo");
	const home = path.join(dir, "home");
	fs.mkdirSync(repo, { recursive: true });
	fs.mkdirSync(path.join(home, ".gjc", "agent"), { recursive: true });
	if (dotenv !== undefined) fs.writeFileSync(path.join(repo, ".env"), dotenv);
	for (const [relative, body] of Object.entries(configs)) {
		const target = path.join(dir, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, body);
	}
	return { dir, home };
}

async function customDirectoriesIn(dir: string, home: string): Promise<string[]> {
	const proc = Bun.spawn([process.execPath, PROBE], {
		cwd: path.join(dir, "repo"),
		env: { ...process.env, HOME: home, GJC_CODING_AGENT_DIR: undefined, GJC_CONFIG_DIR: undefined },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	if ((await proc.exited) !== 0) throw new Error(`probe failed: ${err}`);
	return JSON.parse(out.trim()) as string[];
}

function skillConfig(directory: string): string {
	return `skills:\n  customDirectories:\n    - ${directory}\n`;
}

describe("skill hook agent-dir trust boundary", () => {
	it("ignores an agent dir the project .env points at", async () => {
		const { dir, home } = scenario(`GJC_CODING_AGENT_DIR=${path.join("/tmp", "planted")}\n`, {});
		const planted = path.join(dir, "planted");
		fs.mkdirSync(planted, { recursive: true });
		fs.writeFileSync(path.join(planted, "config.yml"), skillConfig("/tmp/attacker-skills"));

		// Point the .env at the planted dir inside this scenario.
		fs.writeFileSync(path.join(dir, "repo", ".env"), `GJC_CODING_AGENT_DIR=${planted}\n`);

		expect(await customDirectoriesIn(dir, home)).not.toContain("/tmp/attacker-skills");
	});

	it("still honors config in the trusted agent dir", async () => {
		const { dir, home } = scenario(undefined, {});
		fs.writeFileSync(path.join(home, ".gjc", "agent", "config.yml"), skillConfig("/tmp/legit-skills"));

		expect(await customDirectoriesIn(dir, home)).toContain("/tmp/legit-skills");
	});

	it("ignores a config dir name the project .env points at", async () => {
		const { dir, home } = scenario("GJC_CONFIG_DIR=.evil\n", {});
		fs.mkdirSync(path.join(home, ".evil", "agent"), { recursive: true });
		fs.writeFileSync(path.join(home, ".evil", "agent", "config.yml"), skillConfig("/tmp/evil-skills"));

		expect(await customDirectoriesIn(dir, home)).not.toContain("/tmp/evil-skills");
	});
});

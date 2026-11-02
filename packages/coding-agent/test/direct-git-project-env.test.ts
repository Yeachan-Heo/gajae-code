import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Several GJC subsystems run `git` directly instead of through `utils/git.ts`:
 * `gjc --worktree` launch, ultragoal checkpoints, harness and autoresearch
 * status, plugin installs, contribution prep, ralplan, and the coordinator. A
 * repository `.env` must not be able to make that git run repository code via
 * `GIT_CONFIG_*` (`core.hooksPath`, `core.fsmonitor`). Each case plants a hook
 * through the project `.env`, runs the real caller from that project, and
 * checks the hook marker.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "direct-git-project-env-probe.ts");
const PLANTED_KEYS = [
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_KEY_0",
	"GIT_CONFIG_VALUE_0",
	"GIT_CONFIG_KEY_1",
	"GIT_CONFIG_VALUE_1",
];
const GIT_IDENTITY = {
	GIT_AUTHOR_NAME: "a",
	GIT_AUTHOR_EMAIL: "a@b",
	GIT_COMMITTER_NAME: "a",
	GIT_COMMITTER_EMAIL: "a@b",
};

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-direct-git-env-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Project {
	cwd: string;
	marker: string;
	hook: string;
}

/** A repository with one commit whose `.env` points git at a planted hook. */
function project(): Project {
	const cwd = tempDir();
	const marker = path.join(cwd, "hook-ran");
	const hook = path.join(cwd, "hook.sh");
	fs.writeFileSync(hook, `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 });
	const hooks = path.join(cwd, ".githooks");
	fs.mkdirSync(hooks);
	fs.copyFileSync(hook, path.join(hooks, "post-checkout"));
	fs.chmodSync(path.join(hooks, "post-checkout"), 0o755);
	fs.writeFileSync(path.join(cwd, ".gitignore"), "hook-ran\n.env\n");
	for (const argv of [
		["git", "init", "-q"],
		["git", "add", ".gitignore"],
		["git", "commit", "-q", "-m", "init"],
	]) {
		const result = Bun.spawnSync(argv, { cwd, env: { ...process.env, ...GIT_IDENTITY } });
		if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${result.stderr.toString()}`);
	}
	fs.writeFileSync(
		path.join(cwd, ".env"),
		`GIT_CONFIG_COUNT=2\nGIT_CONFIG_KEY_0=core.hooksPath\nGIT_CONFIG_VALUE_0=${hooks}\nGIT_CONFIG_KEY_1=core.fsmonitor\nGIT_CONFIG_VALUE_1=${hook}\n`,
	);
	return { cwd, marker, hook };
}

async function runProbe(
	target: Project,
	op: string,
	noEnvFile: boolean,
	extraEnv: Record<string, string> = {},
): Promise<boolean> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !PLANTED_KEYS.includes(key)) env[key] = value;
	}
	const home = tempDir();
	Object.assign(env, { HOME: home, GJC_CODING_AGENT_DIR: path.join(home, "agent") }, GIT_IDENTITY, extraEnv);
	const argv = noEnvFile ? ["bun", "--no-env-file", PROBE, op] : ["bun", PROBE, op];
	const proc = Bun.spawn(argv, { cwd: target.cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	if ((await proc.exited) !== 0) throw new Error(`probe failed: ${stderr}`);
	expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "")).toEqual({ done: true });
	return fs.existsSync(target.marker);
}

describe.skipIf(process.platform === "win32")("direct git callers ignore project .env hooks", () => {
	for (const op of ["launch-worktree", "checkpoint"]) {
		for (const noEnvFile of [false, true]) {
			it(`does not run a project git hook from ${op} (${noEnvFile ? "--no-env-file" : "autoload"})`, async () => {
				expect(await runProbe(project(), op, noEnvFile)).toBe(false);
			}, 30_000);
		}
	}

	it("still runs a core.fsmonitor the operator exported", async () => {
		const target = project();
		// A value the launching shell exported, different from the project's, still applies.
		const exported = target.hook.replace(target.cwd, `${target.cwd}/.`);
		const operator = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: exported };
		expect(await runProbe(target, "checkpoint", true, operator)).toBe(true);
	}, 30_000);
});

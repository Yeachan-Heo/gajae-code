import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The bisect tool runs the agent's `run` predicate with `sh -c` at every
 * candidate commit. That is the same kind of command the bash tool runs, so a
 * repository `.env` must not be able to hand it hook variables either. Each
 * case plants a `NODE_OPTIONS` preload in the project `.env`, bisects with a
 * predicate that starts `node`, and checks the preload marker.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "bisect-project-env-probe.ts");
const GIT_IDENTITY = {
	GIT_AUTHOR_NAME: "a",
	GIT_AUTHOR_EMAIL: "a@b",
	GIT_COMMITTER_NAME: "a",
	GIT_COMMITTER_EMAIL: "a@b",
};

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-bisect-env-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Project {
	cwd: string;
	marker: string;
	preload: string;
}

/** A repository with PASS, FAIL 1, FAIL 2 commits; the preload and `.env` are ignored files outside history. */
function project(): Project {
	const cwd = tempDir();
	const marker = path.join(cwd, "preload-ran");
	const preload = path.join(cwd, "preload.cjs");
	fs.writeFileSync(path.join(cwd, ".gitignore"), "preload-ran\npreload.cjs\n.env\n");
	const git = (args: string[]) => {
		const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...GIT_IDENTITY } });
		if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	};
	git(["init", "-q"]);
	for (const flag of ["PASS", "FAIL 1", "FAIL 2"]) {
		fs.writeFileSync(path.join(cwd, "flag.txt"), `${flag}\n`);
		git(["add", "."]);
		git(["commit", "-q", "-m", flag]);
	}
	fs.writeFileSync(preload, `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "ran\\n");\n`);
	fs.writeFileSync(path.join(cwd, ".env"), `NODE_OPTIONS=--require ${preload}\n`);
	return { cwd, marker, preload };
}

async function runProbe(target: Project, noEnvFile: boolean, extraEnv: Record<string, string> = {}): Promise<boolean> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && key !== "NODE_OPTIONS") env[key] = value;
	}
	const home = tempDir();
	Object.assign(env, { HOME: home, GJC_CODING_AGENT_DIR: path.join(home, "agent") }, GIT_IDENTITY, extraEnv);
	delete env.TMUX;
	delete env.TMUX_PANE;
	const argv = noEnvFile ? ["bun", "--no-env-file", PROBE] : ["bun", PROBE];
	const proc = Bun.spawn(argv, { cwd: target.cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	if ((await proc.exited) !== 0) throw new Error(`probe failed: ${stderr}`);
	expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "")).toEqual({ done: true });
	return fs.existsSync(target.marker);
}

describe.skipIf(process.platform === "win32" || !Bun.which("node"))(
	"bisect predicate ignores project .env hooks",
	() => {
		for (const noEnvFile of [false, true]) {
			it(`does not let a project NODE_OPTIONS preload run in the predicate (${noEnvFile ? "--no-env-file" : "autoload"})`, async () => {
				expect(await runProbe(project(), noEnvFile)).toBe(false);
			}, 60_000);
		}

		it("keeps an operator-exported NODE_OPTIONS", async () => {
			const target = project();
			// A value the launching shell exported, different from the project's, still applies.
			expect(await runProbe(target, true, { NODE_OPTIONS: `--require=${target.preload}` })).toBe(true);
		}, 60_000);
	},
);

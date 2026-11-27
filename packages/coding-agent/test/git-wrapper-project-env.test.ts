import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * GJC's own git and gh wrappers (`utils/git.ts`) run `git commit` for `/commit`,
 * `git push`/`git fetch` for the github tool and autoresearch, and `gh` for the
 * github tool. A repository `.env` must not be able to make those commands run
 * repository code. Each case plants a hook through the project `.env`, runs the
 * real wrapper in a subprocess from that project, and checks the hook marker.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "git-wrapper-project-env-probe.ts");
const PLANTED_KEYS = [
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_KEY_0",
	"GIT_CONFIG_VALUE_0",
	"GIT_SSH_COMMAND",
	"GIT_ASKPASS",
	"SSH_ASKPASS",
	"SSH_ASKPASS_REQUIRE",
	"GH_PAGER",
	"GH_FORCE_TTY",
	"PAGER",
];

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-git-wrapper-env-"));
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

function project(): Project {
	const cwd = tempDir();
	const marker = path.join(cwd, "hook-ran");
	const hook = path.join(cwd, "hook.sh");
	fs.writeFileSync(hook, `#!/bin/sh\necho ran >> "${marker}"\ncat >/dev/null\n`, { mode: 0o755 });
	const env = {
		...process.env,
		GIT_AUTHOR_NAME: "a",
		GIT_AUTHOR_EMAIL: "a@b",
		GIT_COMMITTER_NAME: "a",
		GIT_COMMITTER_EMAIL: "a@b",
	};
	for (const argv of [
		["git", "init", "-q"],
		["git", "commit", "-q", "--allow-empty", "-m", "init"],
		["git", "remote", "add", "origin", "ssh://git@127.0.0.1:1/probe.git"],
	]) {
		const result = Bun.spawnSync(argv, { cwd, env });
		if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${result.stderr.toString()}`);
	}
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
	Object.assign(env, {
		HOME: home,
		GJC_CODING_AGENT_DIR: path.join(home, "agent"),
		GIT_AUTHOR_NAME: "a",
		GIT_AUTHOR_EMAIL: "a@b",
		GIT_COMMITTER_NAME: "a",
		GIT_COMMITTER_EMAIL: "a@b",
	});
	Object.assign(env, extraEnv);
	const argv = noEnvFile ? ["bun", "--no-env-file", PROBE, op] : ["bun", PROBE, op];
	const proc = Bun.spawn(argv, { cwd: target.cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	if ((await proc.exited) !== 0) throw new Error(`probe failed: ${stderr}`);
	expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "")).toEqual({ done: true });
	return fs.existsSync(target.marker);
}

/** An askpass program: records the call and answers the prompt without reading stdin. */
function askpassScript(target: Project): string {
	const askpass = path.join(target.cwd, "askpass.sh");
	fs.writeFileSync(askpass, `#!/bin/sh\necho ran >> "${target.marker}"\necho probe\n`, { mode: 0o755 });
	return askpass;
}

/** Serve a git remote that always demands HTTP Basic credentials. */
async function withAuthRemote<T>(run: (remote: string) => Promise<T>): Promise<T> {
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () =>
			new Response("auth required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="probe"' } }),
	});
	try {
		return await run(`http://127.0.0.1:${server.port}/probe.git`);
	} finally {
		server.stop(true);
	}
}

describe.skipIf(process.platform === "win32")("git and gh wrappers ignore project .env hooks", () => {
	it("does not run a project core.hooksPath pre-commit hook on commit", async () => {
		const target = project();
		const hooks = path.join(target.cwd, ".githooks");
		fs.mkdirSync(hooks);
		fs.copyFileSync(target.hook, path.join(hooks, "pre-commit"));
		fs.chmodSync(path.join(hooks, "pre-commit"), 0o755);
		fs.writeFileSync(path.join(target.cwd, "file.txt"), "x");
		Bun.spawnSync(["git", "add", "file.txt"], { cwd: target.cwd });
		fs.writeFileSync(
			path.join(target.cwd, ".env"),
			"GIT_CONFIG_COUNT=1\nGIT_CONFIG_KEY_0=core.hooksPath\nGIT_CONFIG_VALUE_0=.githooks\n",
		);
		expect(await runProbe(target, "commit", false)).toBe(false);
	});

	it("does not run a project GIT_SSH_COMMAND on push", async () => {
		const target = project();
		fs.writeFileSync(path.join(target.cwd, ".env"), `GIT_SSH_COMMAND=${target.hook}\n`);
		expect(await runProbe(target, "push", false)).toBe(false);
	});

	// With no `GIT_ASKPASS` or `core.askPass`, git asks `SSH_ASKPASS` for HTTP
	// credentials, even with `GIT_TERMINAL_PROMPT=0`. A local remote that always
	// answers 401 makes `git fetch` prompt.
	it("does not run a project SSH_ASKPASS for a git credential prompt", async () => {
		const target = project();
		const askpass = askpassScript(target);
		fs.writeFileSync(path.join(target.cwd, ".env"), `SSH_ASKPASS=${askpass}\nSSH_ASKPASS_REQUIRE=force\n`);
		expect(
			await withAuthRemote(remote => runProbe(target, "fetch-http", false, { GJC_TEST_HTTP_REMOTE: remote })),
		).toBe(false);
		expect(
			await withAuthRemote(remote => runProbe(target, "fetch-http", true, { GJC_TEST_HTTP_REMOTE: remote })),
		).toBe(false);
	}, 30_000);

	it("still runs an SSH_ASKPASS the operator exported", async () => {
		const target = project();
		const askpass = askpassScript(target);
		fs.writeFileSync(path.join(target.cwd, ".env"), `SSH_ASKPASS=${askpass}\n`);
		const exported = askpass.replace(target.cwd, `${target.cwd}/.`);
		expect(
			await withAuthRemote(remote =>
				runProbe(target, "fetch-http", true, { GJC_TEST_HTTP_REMOTE: remote, SSH_ASKPASS: exported }),
			),
		).toBe(true);
	}, 30_000);

	// Wrapper calls that pass their own variables (e.g. `GIT_INDEX_FILE` for task
	// worktree trees) spread the process environment. Under `--no-env-file` (the
	// compiled-binary condition) Bun does not autoload, but `@gajae-code/utils/env`
	// still copies the project `.env` into it. A `git` shim on PATH records
	// whether a planted helper variable reached the git process.
	it("does not forward project git helper variables on the explicit-env path (--no-env-file)", async () => {
		const target = project();
		const realGit = Bun.which("git");
		if (!realGit) throw new Error("git not found");
		const shimDir = path.join(target.cwd, "shim");
		fs.mkdirSync(shimDir);
		fs.writeFileSync(
			path.join(shimDir, "git"),
			`#!/bin/sh\n[ -n "$GIT_SSH_COMMAND$GIT_CONFIG_COUNT" ] && echo leaked >> "${target.marker}"\nexec "${realGit}" "$@"\n`,
			{ mode: 0o755 },
		);
		fs.writeFileSync(
			path.join(target.cwd, ".env"),
			`GIT_SSH_COMMAND=${target.hook}\nGIT_CONFIG_COUNT=1\nGIT_CONFIG_KEY_0=core.hooksPath\nGIT_CONFIG_VALUE_0=.githooks\n`,
		);
		const leaked = await runProbe(target, "read-tree", true, { PATH: `${shimDir}:${process.env.PATH ?? ""}` });
		expect(leaked).toBe(false);
	});

	// `gh` output is captured, so a pager must never be selectable by the
	// project. A `gh` shim records the pager settings the wrapper hands to gh.
	it("does not hand a project GH_PAGER/GH_FORCE_TTY to gh", async () => {
		const target = project();
		const shimDir = path.join(target.cwd, "shim");
		fs.mkdirSync(shimDir);
		fs.writeFileSync(
			path.join(shimDir, "gh"),
			`#!/bin/sh\n[ "$GH_PAGER" = "${target.hook}" ] || [ -n "$GH_FORCE_TTY" ] && echo leaked >> "${target.marker}"\nexit 0\n`,
			{ mode: 0o755 },
		);
		fs.writeFileSync(path.join(target.cwd, ".env"), `GH_FORCE_TTY=1\nGH_PAGER=${target.hook}\n`);
		expect(await runProbe(target, "gh", false, { PATH: `${shimDir}:${process.env.PATH ?? ""}` })).toBe(false);
	});

	it("still runs a core.hooksPath the operator configured outside the project .env", async () => {
		const target = project();
		const hooks = path.join(target.cwd, ".githooks");
		fs.mkdirSync(hooks);
		fs.copyFileSync(target.hook, path.join(hooks, "pre-commit"));
		fs.chmodSync(path.join(hooks, "pre-commit"), 0o755);
		Bun.spawnSync(["git", "config", "core.hooksPath", ".githooks"], { cwd: target.cwd });
		fs.writeFileSync(path.join(target.cwd, "file.txt"), "x");
		Bun.spawnSync(["git", "add", "file.txt"], { cwd: target.cwd });
		expect(await runProbe(target, "commit", false)).toBe(true);
	});
});

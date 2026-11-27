import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Besides the github tool, GJC starts `gh` on its own: the status line looks up
 * the current branch's PR, and the star reminder checks the star. Those calls
 * must get the same environment as the github tool's `gh`: no project-dotenv
 * hook variables, and never a pager or forced TTY.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "gh-status-project-env-probe.ts");

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-gh-status-env-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Run the callers from a project whose `.env` sets `NODE_OPTIONS` and `GH_PAGER`; return one log line per `gh` call. */
async function runProbe(noEnvFile: boolean, extraEnv: Record<string, string> = {}): Promise<string[]> {
	const cwd = tempDir();
	const log = path.join(cwd, "gh-log");
	const shimDir = path.join(cwd, "shim");
	fs.mkdirSync(shimDir);
	fs.writeFileSync(
		path.join(shimDir, "gh"),
		`#!/bin/sh\necho "node_options=\${NODE_OPTIONS:-} pager=\${GH_PAGER:-} tty=\${GH_FORCE_TTY:-}" >> "${log}"\nexit 1\n`,
		{ mode: 0o755 },
	);
	fs.writeFileSync(
		path.join(cwd, ".env"),
		"NODE_OPTIONS=--require ./planted.cjs\nGH_PAGER=./pager.sh\nGH_FORCE_TTY=1\n",
	);

	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !["NODE_OPTIONS", "GH_PAGER", "GH_FORCE_TTY"].includes(key)) env[key] = value;
	}
	const home = tempDir();
	Object.assign(
		env,
		{ HOME: home, GJC_CODING_AGENT_DIR: path.join(home, "agent"), PATH: `${shimDir}:${process.env.PATH ?? ""}` },
		extraEnv,
	);
	const argv = noEnvFile ? ["bun", "--no-env-file", PROBE] : ["bun", PROBE];
	const proc = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	if ((await proc.exited) !== 0) throw new Error(`probe failed: ${stderr}`);
	expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "")).toEqual({ done: true });
	return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
}

describe.skipIf(process.platform === "win32")("status-line and star-reminder gh calls ignore project .env", () => {
	for (const noEnvFile of [false, true]) {
		it(`runs gh without project hooks, pager, or forced TTY (${noEnvFile ? "--no-env-file" : "autoload"})`, async () => {
			expect(await runProbe(noEnvFile)).toEqual(["node_options= pager=cat tty=", "node_options= pager=cat tty="]);
		}, 30_000);
	}

	it("keeps an operator-exported NODE_OPTIONS", async () => {
		expect(await runProbe(true, { NODE_OPTIONS: "--require=./operator.cjs" })).toEqual([
			"node_options=--require=./operator.cjs pager=cat tty=",
			"node_options=--require=./operator.cjs pager=cat tty=",
		]);
	}, 30_000);
});

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The ssh tool starts `ssh` (control master, host probe, the command itself)
 * and, when installed, `sshfs` and `mountpoint`. A repository `.env` must not
 * be able to hand those programs a hook variable such as `NODE_OPTIONS`,
 * `LD_PRELOAD`, or `GIT_SSH_COMMAND`. Shims on PATH log each invocation and
 * whether the planted variable reached it.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "ssh-project-env-probe.ts");
const SHIMS = ["ssh", "sshfs", "mountpoint"] as const;

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-ssh-env-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Run the executor from a project whose `.env` declares `NODE_OPTIONS`; return `<program> <leaked|clean>` lines. */
async function runProbe(noEnvFile: boolean, extraEnv: Record<string, string> = {}): Promise<string[]> {
	const cwd = tempDir();
	const log = path.join(cwd, "shim-log");
	const shimDir = path.join(cwd, "shim");
	fs.mkdirSync(shimDir);
	for (const name of SHIMS) {
		// `mountpoint` reports "not mounted" so sshfs is attempted; everything else succeeds silently.
		const exit = name === "mountpoint" ? 1 : 0;
		fs.writeFileSync(
			path.join(shimDir, name),
			`#!/bin/sh\nif [ -n "$NODE_OPTIONS" ]; then echo "${name} leaked" >> "${log}"; else echo "${name} clean" >> "${log}"; fi\nexit ${exit}\n`,
			{ mode: 0o755 },
		);
	}
	fs.writeFileSync(path.join(cwd, ".env"), "NODE_OPTIONS=--require ./planted.cjs\n");

	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && key !== "NODE_OPTIONS") env[key] = value;
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

describe.skipIf(process.platform === "win32")("ssh tool ignores project .env hooks", () => {
	for (const noEnvFile of [false, true]) {
		it(`does not hand a project NODE_OPTIONS to ssh, sshfs, or mountpoint (${noEnvFile ? "--no-env-file" : "autoload"})`, async () => {
			const lines = await runProbe(noEnvFile);
			// Every program the executor starts ran, and none received the project value.
			for (const name of SHIMS) expect(lines).toContain(`${name} clean`);
			expect(lines.filter(line => line.endsWith("leaked"))).toEqual([]);
		}, 30_000);
	}

	it("keeps an operator-exported NODE_OPTIONS", async () => {
		const lines = await runProbe(true, { NODE_OPTIONS: "--require=./operator.cjs" });
		for (const name of SHIMS) expect(lines).toContain(`${name} leaked`);
	}, 30_000);
});

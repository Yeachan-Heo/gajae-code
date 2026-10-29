import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The recipe tool is on by default, and building it at session start runs each
 * runner's detection program in the project: `cargo metadata`, `just --dump`,
 * and `task --list-all`. A repository `.env` must not be able to hand those
 * programs a hook variable such as `NODE_OPTIONS` or `LD_PRELOAD`. Shims on PATH
 * log each invocation and whether the planted variable reached it.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "recipe-detection-project-env-probe.ts");
const PROGRAMS = ["cargo", "just", "task"] as const;

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-recipe-env-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Detect runners in a project whose `.env` declares `NODE_OPTIONS`; return `<program> <leaked|clean>` lines. */
async function runProbe(noEnvFile: boolean, extraEnv: Record<string, string> = {}): Promise<string[]> {
	const cwd = tempDir();
	const log = path.join(cwd, "shim-log");
	const shimDir = path.join(cwd, "shim");
	fs.mkdirSync(shimDir);
	for (const name of PROGRAMS) {
		fs.writeFileSync(
			path.join(shimDir, name),
			`#!/bin/sh\nif [ -n "$NODE_OPTIONS" ]; then echo "${name} leaked" >> "${log}"; else echo "${name} clean" >> "${log}"; fi\nexit 1\n`,
			{ mode: 0o755 },
		);
	}
	fs.writeFileSync(path.join(cwd, "Cargo.toml"), '[package]\nname = "probe"\nversion = "0.1.0"\n');
	fs.writeFileSync(path.join(cwd, "justfile"), "build:\n\ttrue\n");
	fs.writeFileSync(path.join(cwd, "Taskfile.yml"), "version: '3'\ntasks:\n  build:\n    cmds: [true]\n");
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
	return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").sort() : [];
}

describe.skipIf(process.platform === "win32")("recipe runner detection ignores project .env hooks", () => {
	for (const noEnvFile of [false, true]) {
		it(`does not hand a project NODE_OPTIONS to cargo, just, or task (${noEnvFile ? "--no-env-file" : "autoload"})`, async () => {
			expect(await runProbe(noEnvFile)).toEqual(["cargo clean", "just clean", "task clean"]);
		}, 30_000);
	}

	it("keeps an operator-exported NODE_OPTIONS", async () => {
		expect(await runProbe(true, { NODE_OPTIONS: "--require=./operator.cjs" })).toEqual([
			"cargo leaked",
			"just leaked",
			"task leaked",
		]);
	}, 30_000);
});

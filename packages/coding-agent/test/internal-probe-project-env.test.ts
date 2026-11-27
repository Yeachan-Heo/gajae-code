import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * GJC spawns small helpers on its own while it starts: `ps` to record process
 * identity for file locks and launch-worktree reservations, and `tmux -V` to
 * tell tmux from psmux. A repository `.env` must not be able to make those
 * helpers run repository code. Each case plants an `LD_PRELOAD` module in the
 * project `.env`, runs the real probe from that project, and checks the marker
 * the module's constructor writes.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "internal-probe-project-env-probe.ts");
const compiler = Bun.which("cc") ?? Bun.which("gcc");
const OPS = [
	{ op: "ps", needs: "ps" },
	{ op: "tmux", needs: "tmux" },
] as const;

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-internal-probe-env-"));
	tempDirs.push(dir);
	return dir;
}

let preloadDir = "";
let marker = "";
let preload = "";

beforeAll(() => {
	if (process.platform !== "linux" || !compiler) return;
	preloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-internal-probe-preload-"));
	marker = path.join(preloadDir, "preload-ran");
	preload = path.join(preloadDir, "preload.so");
	const source = path.join(preloadDir, "preload.c");
	fs.writeFileSync(
		source,
		// Record which program loaded the module: an operator-exported preload
		// also loads into the probe's own `bun`, which must not count as a hit.
		`#define _GNU_SOURCE\n#include <errno.h>\n#include <stdio.h>\n__attribute__((constructor)) static void ran(void) { FILE *f = fopen(${JSON.stringify(marker)}, "a"); if (f) { fprintf(f, "%s\\n", program_invocation_short_name); fclose(f); } }\n`,
	);
	const result = Bun.spawnSync([compiler, "-shared", "-fPIC", "-o", preload, source], { stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`preload build failed: ${result.stderr.toString()}`);
});

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	if (marker) fs.rmSync(marker, { force: true });
});

afterAll(() => {
	if (preloadDir) fs.rmSync(preloadDir, { recursive: true, force: true });
});

/** Whether the planted module loaded into the probed helper program. */
async function runProbe(
	op: string,
	program: string,
	noEnvFile: boolean,
	extraEnv: Record<string, string> = {},
): Promise<boolean> {
	const cwd = tempDir();
	fs.writeFileSync(path.join(cwd, ".env"), `LD_PRELOAD=${preload}\n`);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && key !== "LD_PRELOAD") env[key] = value;
	}
	const home = tempDir();
	Object.assign(env, { HOME: home, GJC_CODING_AGENT_DIR: path.join(home, "agent") }, extraEnv);
	const argv = noEnvFile ? ["bun", "--no-env-file", PROBE, op] : ["bun", PROBE, op];
	const proc = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	if ((await proc.exited) !== 0) throw new Error(`probe failed: ${stderr}`);
	expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "")).toEqual({ done: true });
	if (!fs.existsSync(marker)) return false;
	return fs.readFileSync(marker, "utf8").split("\n").includes(program);
}

describe.skipIf(process.platform !== "linux" || !compiler)("internal probes ignore project .env loader hooks", () => {
	for (const { op, needs } of OPS) {
		const available = Bun.which(needs) !== null;
		for (const noEnvFile of [false, true]) {
			it.skipIf(!available)(
				`does not let a project LD_PRELOAD run in the ${op} probe (${noEnvFile ? "--no-env-file" : "autoload"})`,
				async () => {
					expect(await runProbe(op, needs, noEnvFile)).toBe(false);
				},
				30_000,
			);
		}

		it.skipIf(!available)(
			`keeps an operator-exported LD_PRELOAD for the ${op} probe`,
			async () => {
				// The launching shell exported a different spelling of the path than
				// the project declares, so it is the operator's choice and still applies.
				const exported = path.join(preloadDir, ".", "preload.so").replace(preloadDir, `${preloadDir}/.`);
				expect(await runProbe(op, needs, true, { LD_PRELOAD: exported })).toBe(true);
			},
			30_000,
		);
	}
});

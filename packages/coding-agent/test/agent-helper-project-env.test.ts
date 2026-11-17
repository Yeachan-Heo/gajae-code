import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * GJC launches helper programs during a session: the configured
 * `completion.notifyCommand` after each turn, the browser tool's browser (puppeteer
 * Chromium, an `app.path` executable, or a `chrome` profile), and
 * the `insane` web engine (python3 -> node -> Chromium). A repository `.env`
 * must not be able to make those helpers run repository code. Each case plants
 * a `NODE_OPTIONS` preload in the project `.env`, runs the real launcher from
 * that project with a `node` stand-in for the helper, and checks the marker.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "agent-helper-project-env-probe.ts");
const OPS = ["notify", "browser", "app-path", "chrome-profile", "insane"] as const;

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-agent-helper-env-"));
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

function project(): Project {
	const cwd = tempDir();
	const marker = path.join(cwd, "preload-ran");
	const preload = path.join(cwd, "preload.cjs");
	fs.writeFileSync(preload, `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "ran\\n");\n`);
	fs.writeFileSync(path.join(cwd, ".env"), `NODE_OPTIONS=--require ${preload}\n`);
	return { cwd, marker, preload };
}

async function runProbe(
	target: Project,
	op: string,
	noEnvFile: boolean,
	extraEnv: Record<string, string> = {},
): Promise<boolean> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && key !== "NODE_OPTIONS") env[key] = value;
	}
	const home = tempDir();
	Object.assign(
		env,
		// The browser case must not download Chromium; an operator executable path short-circuits resolution.
		{ HOME: home, GJC_CODING_AGENT_DIR: path.join(home, "agent"), PUPPETEER_EXECUTABLE_PATH: process.execPath },
		extraEnv,
	);
	const argv = noEnvFile ? ["bun", "--no-env-file", PROBE, op] : ["bun", PROBE, op];
	const proc = Bun.spawn(argv, { cwd: target.cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	if ((await proc.exited) !== 0) throw new Error(`probe failed: ${stderr}`);
	expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "")).toEqual({ done: true });
	return fs.existsSync(target.marker);
}

describe.skipIf(process.platform === "win32" || !Bun.which("node"))("session helpers ignore project .env hooks", () => {
	for (const op of OPS) {
		for (const noEnvFile of [false, true]) {
			it(`does not let a project NODE_OPTIONS preload run in the ${op} helper (${noEnvFile ? "--no-env-file" : "autoload"})`, async () => {
				expect(await runProbe(project(), op, noEnvFile)).toBe(false);
			}, 30_000);
		}

		it(`keeps an operator-exported NODE_OPTIONS for the ${op} helper`, async () => {
			const target = project();
			// A value the launching shell exported, different from the project's, still applies.
			expect(await runProbe(target, op, true, { NODE_OPTIONS: `--require=${target.preload}` })).toBe(true);
		}, 30_000);
	}

	// Linux Chrome/Chromium are GTK programs: GTK loads `GTK_MODULES`/`GTK3_MODULES`
	// from `GTK_PATH`. The browser stand-in records whether any of them reached it.
	for (const op of ["app-path", "chrome-profile"] as const) {
		for (const noEnvFile of [false, true]) {
			it(`does not hand project GTK module variables to the ${op} browser (${noEnvFile ? "--no-env-file" : "autoload"})`, async () => {
				const target = project();
				fs.writeFileSync(
					path.join(target.cwd, ".env"),
					`GTK_MODULES=planted\nGTK3_MODULES=planted\nGTK_PATH=${target.cwd}\n`,
				);
				expect(await runProbe(target, op, noEnvFile)).toBe(false);
			}, 30_000);
		}

		it(`keeps an operator-exported GTK_MODULES for the ${op} browser`, async () => {
			const target = project();
			fs.writeFileSync(path.join(target.cwd, ".env"), "GTK_MODULES=planted\n");
			expect(await runProbe(target, op, true, { GTK_MODULES: "operator" })).toBe(true);
		}, 30_000);
	}
});

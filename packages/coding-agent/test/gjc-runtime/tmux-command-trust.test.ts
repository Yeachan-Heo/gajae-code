import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `resolveGjcTmuxCommand` selects the multiplexer binary. Bun loads `cwd/.env`
 * into `process.env` before the module runs, so the refusal is only visible
 * from a process whose cwd is the project that declares `GJC_TMUX_COMMAND`.
 */

const PROBE = path.join(import.meta.dir, "../fixtures/tmux-command-trust-probe.ts");
const CLEARED_ENV = [
	"GJC_TMUX_COMMAND",
	"GJC_TEAM_TMUX_COMMAND",
	"GJC_PSMUX_COMMAND",
	"GJC_PSMUX_DETECTION",
	"GJC_PSMUX_FORCE_DETECT",
] as const;

setDefaultTimeout(30_000);

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeExecutable(file: string, marker: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `#!/bin/sh\nprintf 'ran\\n' >> ${JSON.stringify(marker)}\nprintf 'tmux 3.4\\n'\n`, {
		mode: 0o755,
	});
}

function project(): { dir: string; planted: string; plantedMarker: string; defaultMarker: string; bin: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-tmux-command-trust-"));
	tempDirs.push(dir);
	const plantedMarker = path.join(dir, "planted-ran");
	const defaultMarker = path.join(dir, "default-ran");
	const planted = path.join(dir, "planted-tmux");
	const bin = path.join(dir, "bin");
	writeExecutable(planted, plantedMarker);
	writeExecutable(path.join(bin, "tmux"), defaultMarker);
	return { dir, planted, plantedMarker, defaultMarker, bin };
}

async function resolveIn(dir: string, bin: string, dotenv?: string, overrides: Record<string, string> = {}) {
	if (dotenv !== undefined) fs.writeFileSync(path.join(dir, ".env"), dotenv);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	for (const key of CLEARED_ENV) delete env[key];
	env.PATH = `${bin}${path.delimiter}${env.PATH ?? ""}`;
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as { command: string; envCommand: string | null };
}

describe("tmux command project dotenv trust", () => {
	it("ignores a project .env GJC_TMUX_COMMAND and runs the default tmux binary", async () => {
		const { dir, planted, plantedMarker, defaultMarker, bin } = project();
		const resolved = await resolveIn(dir, bin, `GJC_TMUX_COMMAND=${planted}\n`);
		expect(resolved.envCommand).toBe(planted);
		expect(resolved.command).toBe("tmux");
		expect(fs.existsSync(plantedMarker)).toBe(false);
		expect(fs.existsSync(defaultMarker)).toBe(true);
	});

	it("still ignores a project command after the dotenv file is removed", async () => {
		const { dir, planted, plantedMarker, defaultMarker, bin } = project();
		const resolved = await resolveIn(dir, bin, `GJC_TMUX_COMMAND=${planted}\n`, {
			GJC_TMUX_COMMAND_PROBE_DROP: "unlink",
		});
		expect(resolved.envCommand).toBe(planted);
		expect(resolved.command).toBe("tmux");
		expect(fs.existsSync(plantedMarker)).toBe(false);
		expect(fs.existsSync(defaultMarker)).toBe(true);
	});

	it("still ignores a project command after the process cwd changes", async () => {
		const { dir, planted, plantedMarker, defaultMarker, bin } = project();
		const resolved = await resolveIn(dir, bin, `GJC_TMUX_COMMAND=${planted}\n`, {
			GJC_TMUX_COMMAND_PROBE_DROP: "chdir",
		});
		expect(resolved.envCommand).toBe(planted);
		expect(resolved.command).toBe("tmux");
		expect(fs.existsSync(plantedMarker)).toBe(false);
		expect(fs.existsSync(defaultMarker)).toBe(true);
	});

	it("ignores a dynamic project declaration without executing the expanded binary", async () => {
		const { dir, planted, plantedMarker, defaultMarker, bin } = project();
		const resolved = await resolveIn(dir, bin, "GJC_TMUX_COMMAND=$PLANTED_TMUX\n", { PLANTED_TMUX: planted });
		expect(resolved.envCommand).toBe(planted);
		expect(resolved.command).toBe("tmux");
		expect(fs.existsSync(plantedMarker)).toBe(false);
		expect(fs.existsSync(defaultMarker)).toBe(true);
	});

	it("keeps an operator GJC_TMUX_COMMAND the project does not declare", async () => {
		const { dir, plantedMarker, defaultMarker, bin } = project();
		const operator = path.join(dir, "missing-operator-tmux");
		const resolved = await resolveIn(dir, bin, "OTHER=1\n", { GJC_TMUX_COMMAND: operator });
		expect(resolved.envCommand).toBe(operator);
		expect(resolved.command).toBe(operator);
		expect(fs.existsSync(plantedMarker)).toBe(false);
		expect(fs.existsSync(defaultMarker)).toBe(false);
	});

	it("keeps an operator value when the project declares a different static command", async () => {
		const { dir, planted, plantedMarker, defaultMarker, bin } = project();
		const operator = path.join(dir, "missing-operator-tmux");
		const resolved = await resolveIn(dir, bin, `GJC_TMUX_COMMAND=${planted}\n`, { GJC_TMUX_COMMAND: operator });
		expect(resolved.envCommand).toBe(operator);
		expect(resolved.command).toBe(operator);
		expect(fs.existsSync(plantedMarker)).toBe(false);
		expect(fs.existsSync(defaultMarker)).toBe(false);
	});
});

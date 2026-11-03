import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Reading a YouTube URL runs `yt-dlp` for metadata and subtitles. A repository
 * `.env` must not be able to hand it a hook variable such as `LD_PRELOAD` or
 * `NODE_OPTIONS`. A `yt-dlp` shim on PATH logs what each call received.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "ytdlp-project-env-probe.ts");

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-ytdlp-env-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Read a YouTube URL from a project whose `.env` declares `NODE_OPTIONS`; return one line per `yt-dlp` call. */
async function runProbe(noEnvFile: boolean, extraEnv: Record<string, string> = {}): Promise<string[]> {
	const cwd = tempDir();
	const log = path.join(cwd, "shim-log");
	const shimDir = path.join(cwd, "shim");
	fs.mkdirSync(shimDir);
	fs.writeFileSync(path.join(shimDir, "yt-dlp"), `#!/bin/sh\necho "node=\${NODE_OPTIONS:-}" >> "${log}"\nexit 1\n`, {
		mode: 0o755,
	});
	fs.writeFileSync(path.join(cwd, ".env"), "NODE_OPTIONS=--require ./planted.cjs\n");

	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && key !== "NODE_OPTIONS") env[key] = value;
	}
	const home = tempDir();
	Object.assign(
		env,
		{ HOME: home, GJC_CODING_AGENT_DIR: path.join(home, "agent"), PATH: `${shimDir}:/usr/bin:/bin` },
		extraEnv,
	);
	const argv = [process.execPath, ...(noEnvFile ? ["--no-env-file"] : []), PROBE];
	const proc = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	if ((await proc.exited) !== 0) throw new Error(`probe failed: ${stderr}`);
	expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "")).toEqual({ done: true });
	return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
}

describe.skipIf(process.platform === "win32")("YouTube reader runs yt-dlp without project .env hooks", () => {
	for (const noEnvFile of [false, true]) {
		it(`does not hand a project NODE_OPTIONS to yt-dlp (${noEnvFile ? "--no-env-file" : "autoload"})`, async () => {
			const lines = await runProbe(noEnvFile);
			expect(lines.length).toBeGreaterThan(0);
			expect(lines.filter(line => line !== "node=")).toEqual([]);
		}, 30_000);
	}

	it("keeps an operator-exported NODE_OPTIONS", async () => {
		const lines = await runProbe(true, { NODE_OPTIONS: "--require=./operator.cjs" });
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.filter(line => line !== "node=--require=./operator.cjs")).toEqual([]);
	}, 30_000);
});

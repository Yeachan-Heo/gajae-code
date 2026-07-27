import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The Kimi usage base URL becomes the endpoint the usage request sends
 * `Authorization: Bearer <accessToken>` to, so whatever can set it receives the
 * user's Kimi access token.
 *
 * `Bun.env === process.env`, and the env module merges the caller's `cwd/.env`
 * into it. `projectEnv` is parsed at module load from `process.cwd()`, so these
 * drive a child process with a controlled cwd.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "kimi-usage-baseurl-probe.ts");
const KEY = "KIMI_CODE_BASE_URL";

interface Resolved {
	fromEnv: string;
	callerWins: string;
}

const tempDirs: string[] = [];

function projectDir(dotenv?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-kimi-usage-trust-"));
	tempDirs.push(dir);
	if (dotenv !== undefined) fs.writeFileSync(path.join(dir, ".env"), dotenv);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function resolveIn(cwd: string, overrides: Record<string, string> = {}): Promise<Resolved> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	// Never let the outer environment leak a base URL into the child.
	delete env[KEY];
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as Resolved;
}

describe("Kimi usage base URL trust boundary", () => {
	it("uses the built-in base when nothing overrides it", async () => {
		expect((await resolveIn(projectDir())).fromEnv).not.toContain("attacker.example");
	});

	it("ignores a KIMI_CODE_BASE_URL planted by the project .env", async () => {
		const cwd = projectDir("KIMI_CODE_BASE_URL=https://attacker.example\n");
		expect((await resolveIn(cwd)).fromEnv).not.toContain("attacker.example");
	});

	it("still honors an inherited KIMI_CODE_BASE_URL", async () => {
		expect((await resolveIn(projectDir(), { KIMI_CODE_BASE_URL: "https://kimi.internal" })).fromEnv).toBe(
			"https://kimi.internal",
		);
	});

	it("does not let the project .env override an inherited base URL", async () => {
		const cwd = projectDir("KIMI_CODE_BASE_URL=https://attacker.example\n");
		expect((await resolveIn(cwd, { KIMI_CODE_BASE_URL: "https://kimi.internal" })).fromEnv).toBe(
			"https://kimi.internal",
		);
	});

	it("keeps an explicit caller base URL ahead of the environment", async () => {
		const cwd = projectDir("KIMI_CODE_BASE_URL=https://attacker.example\n");
		expect((await resolveIn(cwd)).callerWins).toBe("https://caller.internal");
	});
});

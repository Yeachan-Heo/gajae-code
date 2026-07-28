import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `resolveAccessToken()` supplies the bearer for the Grok billing/usage call. Its
 * last fallback read `process.env.GROK_CLI_OAUTH_TOKEN`, and `Bun.env` is
 * `process.env` with the caller's `cwd/.env` merged in, so repository content
 * could decide which account that call authenticates as.
 *
 * `projectEnv` is parsed at module load from `process.cwd()`, so these drive a
 * child process with a controlled cwd.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "grok-usage-token-probe.ts");
const KEY = "GROK_CLI_OAUTH_TOKEN";

interface Resolved {
	fromEnv: string | null;
	storedWins: string | null;
}

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-grok-token-trust-"));
	tempDirs.push(dir);
	return dir;
}

function projectDir(dotenv?: string): string {
	const dir = tempDir();
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
	delete env[KEY];
	// `$credentialEnv` also consults the agent `.env`, the GJC config `.env`,
	// `~/.env` and the login shell rc files; keep all of them neutral.
	env.HOME = tempDir();
	env.GJC_CODING_AGENT_DIR = tempDir();
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as Resolved;
}

describe("Grok usage token trust boundary", () => {
	it("resolves no token when nothing supplies one", async () => {
		expect((await resolveIn(projectDir())).fromEnv).toBeNull();
	});

	it("ignores a GROK_CLI_OAUTH_TOKEN planted by the project .env", async () => {
		expect((await resolveIn(projectDir("GROK_CLI_OAUTH_TOKEN=attacker-token\n"))).fromEnv).toBeNull();
	});

	it("still honors an inherited GROK_CLI_OAUTH_TOKEN", async () => {
		expect((await resolveIn(projectDir(), { GROK_CLI_OAUTH_TOKEN: "operator-token" })).fromEnv).toBe(
			"operator-token",
		);
	});

	it("does not let the project .env override an inherited token", async () => {
		const resolved = await resolveIn(projectDir("GROK_CLI_OAUTH_TOKEN=attacker-token\n"), {
			GROK_CLI_OAUTH_TOKEN: "operator-token",
		});
		expect(resolved.fromEnv).toBe("operator-token");
	});

	it("keeps a stored credential ahead of the environment", async () => {
		const resolved = await resolveIn(projectDir("GROK_CLI_OAUTH_TOKEN=attacker-token\n"), {
			GROK_CLI_OAUTH_TOKEN: "operator-token",
		});
		expect(resolved.storedWins).toBe("stored-token");
	});
});

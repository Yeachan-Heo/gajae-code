import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `findApiKey()` supplies the credential for every Exa MCP call, and that key
 * travels in the request URL (`?exaApiKey=…`). So whatever can set it decides
 * which account the agent's searches run through — and therefore who can see
 * those queries.
 *
 * `Bun.env === process.env`, and the env module merges the caller's `cwd/.env`
 * into it. `projectEnv` is parsed at module load from `process.cwd()`, so these
 * drive a child process with a controlled cwd.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "exa-api-key-probe.ts");
const KEY = "EXA_API_KEY";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-exa-key-trust-"));
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

async function keyIn(cwd: string, overrides: Record<string, string> = {}): Promise<string | null> {
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
	return (JSON.parse(stdout.trim()) as { apiKey: string | null }).apiKey;
}

describe("Exa API key trust boundary", () => {
	it("resolves no key when nothing supplies one", async () => {
		expect(await keyIn(projectDir())).toBeNull();
	});

	it("ignores an EXA_API_KEY planted by the project .env", async () => {
		expect(await keyIn(projectDir("EXA_API_KEY=attacker-key\n"))).toBeNull();
	});

	it("still honors an inherited EXA_API_KEY", async () => {
		expect(await keyIn(projectDir(), { EXA_API_KEY: "operator-key" })).toBe("operator-key");
	});

	it("does not let the project .env override an inherited key", async () => {
		expect(await keyIn(projectDir("EXA_API_KEY=attacker-key\n"), { EXA_API_KEY: "operator-key" })).toBe(
			"operator-key",
		);
	});
});

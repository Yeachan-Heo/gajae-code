import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Three Smithery reads decide where credentials go and where registry data comes
 * from:
 *
 * - `SMITHERY_URL` serves the CLI auth session and the verification URL the user
 *   is sent to (`smithery-auth.ts:39`).
 * - `SMITHERY_API_URL` is the base every request carries
 *   `Authorization: Bearer <apiKey>` to, and whose `/connect` routes return the
 *   connection records the agent consumes (`smithery-connect.ts:42`, `:109`).
 * - `SMITHERY_API_KEY` is that credential.
 *
 * `Bun.env === process.env`, and the env module merges the caller's `cwd/.env`
 * into it. `projectEnv` is parsed at module load from `process.cwd()`, so these
 * drive a child process with a controlled cwd.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "smithery-env-probe.ts");
const KEYS = ["SMITHERY_URL", "SMITHERY_API_URL", "SMITHERY_API_KEY"] as const;

interface Resolved {
	url: string;
	apiKey: string | null;
	apiBaseUrl: string;
}

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-smithery-trust-"));
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
	for (const key of KEYS) delete env[key];
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

const PLANTED = [
	"SMITHERY_URL=https://attacker.example",
	"SMITHERY_API_URL=https://attacker.example/api",
	"SMITHERY_API_KEY=attacker-key",
].join("\n");

describe("Smithery env trust boundary", () => {
	it("uses the built-in endpoints and no key by default", async () => {
		const resolved = await resolveIn(projectDir());
		expect(resolved.url).toBe("https://smithery.ai");
		expect(resolved.apiBaseUrl).toBe("https://api.smithery.ai");
		expect(resolved.apiKey).toBeNull();
	});

	it("ignores Smithery endpoints planted by the project .env", async () => {
		const resolved = await resolveIn(projectDir(PLANTED));
		expect(resolved.url).toBe("https://smithery.ai");
		expect(resolved.apiBaseUrl).toBe("https://api.smithery.ai");
	});

	it("ignores a Smithery API key planted by the project .env", async () => {
		expect((await resolveIn(projectDir(PLANTED))).apiKey).toBeNull();
	});

	it("still honors inherited Smithery configuration", async () => {
		const resolved = await resolveIn(projectDir(), {
			SMITHERY_URL: "https://smithery.internal",
			SMITHERY_API_URL: "https://api.smithery.internal",
			SMITHERY_API_KEY: "operator-key",
		});
		expect(resolved.url).toBe("https://smithery.internal");
		expect(resolved.apiBaseUrl).toBe("https://api.smithery.internal");
		expect(resolved.apiKey).toBe("operator-key");
	});

	it("does not let the project .env override inherited configuration", async () => {
		const resolved = await resolveIn(projectDir(PLANTED), {
			SMITHERY_URL: "https://smithery.internal",
			SMITHERY_API_KEY: "operator-key",
		});
		expect(resolved.url).toBe("https://smithery.internal");
		expect(resolved.apiKey).toBe("operator-key");
	});
});

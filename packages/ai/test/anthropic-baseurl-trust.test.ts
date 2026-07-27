import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `resolveAnthropicBaseUrlFromEnv()` feeds `buildAnthropicAuthConfig()`, whose
 * result `buildAnthropicUrl()` turns into `${baseUrl}/v1/messages` while the
 * headers carry the Anthropic API key / OAuth token. `isFoundryEnabled()` picks
 * the Foundry branch of that resolution and gates the mTLS material.
 *
 * `Bun.env === process.env`, and the env module merges the caller's `cwd/.env`
 * into it, so without a trust boundary a repository could plant `.env` and have
 * authenticated requests delivered to an endpoint of its choosing.
 *
 * `projectEnv` is parsed at module load from `process.cwd()`, so these drive a
 * child process with a controlled cwd.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "anthropic-baseurl-probe.ts");
const KEYS = ["ANTHROPIC_BASE_URL", "FOUNDRY_BASE_URL", "CLAUDE_CODE_USE_FOUNDRY"] as const;

interface Resolved {
	foundryEnabled: boolean;
	baseUrl: string | null;
}

const tempDirs: string[] = [];

function projectDir(dotenv?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-anthropic-baseurl-trust-"));
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
	// Never let the outer environment leak an endpoint override into the child.
	for (const key of KEYS) delete env[key];
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as Resolved;
}

describe("Anthropic endpoint trust boundary", () => {
	it("resolves no env base URL and no Foundry mode by default", async () => {
		expect(await resolveIn(projectDir())).toEqual({ foundryEnabled: false, baseUrl: null });
	});

	it("ignores an ANTHROPIC_BASE_URL planted by the project .env", async () => {
		const cwd = projectDir("ANTHROPIC_BASE_URL=https://attacker.example\n");
		expect((await resolveIn(cwd)).baseUrl).toBeNull();
	});

	it("ignores a Foundry opt-in planted by the project .env", async () => {
		const cwd = projectDir("CLAUDE_CODE_USE_FOUNDRY=1\nFOUNDRY_BASE_URL=https://attacker.example\n");
		const resolved = await resolveIn(cwd);
		expect(resolved.foundryEnabled).toBe(false);
		expect(resolved.baseUrl).toBeNull();
	});

	it("ignores a planted FOUNDRY_BASE_URL even when Foundry is legitimately enabled", async () => {
		const cwd = projectDir("FOUNDRY_BASE_URL=https://attacker.example\n");
		const resolved = await resolveIn(cwd, { CLAUDE_CODE_USE_FOUNDRY: "1" });
		expect(resolved.foundryEnabled).toBe(true);
		expect(resolved.baseUrl).toBeNull();
	});

	it("still honors an inherited ANTHROPIC_BASE_URL", async () => {
		const resolved = await resolveIn(projectDir(), { ANTHROPIC_BASE_URL: "https://gateway.internal/" });
		expect(resolved.baseUrl).toBe("https://gateway.internal");
	});

	it("still honors an inherited Foundry configuration", async () => {
		const resolved = await resolveIn(projectDir(), {
			CLAUDE_CODE_USE_FOUNDRY: "true",
			FOUNDRY_BASE_URL: "https://foundry.internal",
		});
		expect(resolved.foundryEnabled).toBe(true);
		expect(resolved.baseUrl).toBe("https://foundry.internal");
	});

	it("does not let the project .env override an inherited base URL", async () => {
		const cwd = projectDir("ANTHROPIC_BASE_URL=https://attacker.example\n");
		expect((await resolveIn(cwd, { ANTHROPIC_BASE_URL: "https://gateway.internal" })).baseUrl).toBe(
			"https://gateway.internal",
		);
	});
});

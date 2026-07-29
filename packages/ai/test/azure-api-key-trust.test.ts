import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The Azure client falls back to `AZURE_OPENAI_API_KEY` when the caller passes no
 * key. `Bun.env === process.env`, and the env module merges the caller's
 * `cwd/.env` into it, so reading that fallback through the merged view let
 * repository content supply the credential the client authenticates with. The
 * codebase reserves `$credentialEnv` for exactly this: "provider credential
 * resolution must not use this merged view because it includes the caller's
 * cwd/.env".
 *
 * `projectEnv` is parsed at module load from `process.cwd()`, so these drive a
 * child process with a controlled cwd.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "azure-api-key-probe.ts");
const KEY = "AZURE_OPENAI_API_KEY";

interface Resolved {
	resolved: string | null;
	callerWins: string | null;
}

const tempDirs: string[] = [];

function projectDir(dotenv?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-azure-key-trust-"));
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
	// Never let the outer environment leak a key into the child.
	delete env[KEY];
	// `$credentialEnv` also consults the user's `~/.env`, shell rc files, and agent
	// directory. Keep those trusted sources neutral so developer configuration
	// cannot change the expected no-key case or mask project-env rejection.
	env.HOME = projectDir();
	env.GJC_CODING_AGENT_DIR = projectDir();
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as Resolved;
}

describe("Azure client API key trust boundary", () => {
	it("resolves no key when nothing supplies one", async () => {
		expect((await resolveIn(projectDir())).resolved).toBeNull();
	});

	it("ignores an AZURE_OPENAI_API_KEY planted by the project .env", async () => {
		const cwd = projectDir("AZURE_OPENAI_API_KEY=attacker-supplied-key\n");
		expect((await resolveIn(cwd)).resolved).toBeNull();
	});

	it("still honors an inherited AZURE_OPENAI_API_KEY", async () => {
		const resolved = await resolveIn(projectDir(), { AZURE_OPENAI_API_KEY: "operator-key" });
		expect(resolved.resolved).toBe("operator-key");
	});

	it("does not let the project .env override an inherited key", async () => {
		const cwd = projectDir("AZURE_OPENAI_API_KEY=attacker-supplied-key\n");
		expect((await resolveIn(cwd, { AZURE_OPENAI_API_KEY: "operator-key" })).resolved).toBe("operator-key");
	});

	it("keeps an explicit caller key ahead of the environment", async () => {
		const cwd = projectDir("AZURE_OPENAI_API_KEY=attacker-supplied-key\n");
		expect((await resolveIn(cwd)).callerWins).toBe("caller-supplied-key");
	});
});

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Image generation resolves two things from the environment: the OpenAI base URL
 * that becomes the endpoint for authenticated image requests, and a
 * `GOOGLE_API_KEY` fallback used when the trusted `getEnvApiKey("google")` lookup
 * finds nothing.
 *
 * `Bun.env === process.env`, and the env module merges the caller's `cwd/.env`
 * into it, so without a trust boundary a repository could plant `.env` and choose
 * where image requests go, or supply the credential they authenticate with.
 *
 * `projectEnv` is parsed at module load from `process.cwd()`, so these drive a
 * child process with a controlled cwd.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "image-gen-env-probe.ts");
const KEYS = ["OPENAI_BASE_URL", "GOOGLE_API_KEY"] as const;
const OPENAI_DEFAULT = "https://api.openai.com/v1";

interface Resolved {
	baseUrl: string;
	googleKey: string | null;
}

const tempDirs: string[] = [];

function projectDir(dotenv?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-image-gen-env-trust-"));
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
	// Never let the outer environment leak an override into the child.
	for (const key of KEYS) delete env[key];
	// `$credentialEnv` also consults the user's `~/.env`, shell rc files, and agent
	// directory. Keep those trusted sources neutral so developer configuration
	// cannot change the expected default or mask a project-env rejection.
	env.HOME = projectDir();
	env.GJC_CODING_AGENT_DIR = projectDir();
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as Resolved;
}

describe("image generation env trust boundary", () => {
	it("uses the hosted default and no key when nothing is configured", async () => {
		const resolved = await resolveIn(projectDir());
		expect(resolved.baseUrl).toBe(OPENAI_DEFAULT);
		expect(resolved.googleKey).toBeNull();
	});

	it("ignores an OPENAI_BASE_URL planted by the project .env", async () => {
		const cwd = projectDir("OPENAI_BASE_URL=https://attacker.example/v1\n");
		expect((await resolveIn(cwd)).baseUrl).toBe(OPENAI_DEFAULT);
	});

	it("ignores a GOOGLE_API_KEY planted by the project .env", async () => {
		const cwd = projectDir("GOOGLE_API_KEY=attacker-supplied-key\n");
		expect((await resolveIn(cwd)).googleKey).toBeNull();
	});

	it("still honors inherited values", async () => {
		const resolved = await resolveIn(projectDir(), {
			OPENAI_BASE_URL: "https://gateway.internal/v1",
			GOOGLE_API_KEY: "operator-key",
		});
		expect(resolved.baseUrl).toBe("https://gateway.internal/v1");
		expect(resolved.googleKey).toBe("operator-key");
	});

	it("does not let the project .env override inherited values", async () => {
		const cwd = projectDir("OPENAI_BASE_URL=https://attacker.example/v1\nGOOGLE_API_KEY=attacker-supplied-key\n");
		const resolved = await resolveIn(cwd, {
			OPENAI_BASE_URL: "https://gateway.internal/v1",
			GOOGLE_API_KEY: "operator-key",
		});
		expect(resolved.baseUrl).toBe("https://gateway.internal/v1");
		expect(resolved.googleKey).toBe("operator-key");
	});
});

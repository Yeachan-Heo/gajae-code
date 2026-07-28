import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * SearXNG resolves its endpoint and its basic-auth material from the environment
 * and then sends that credential to that endpoint (`Authorization: Basic|Bearer`).
 * `Bun.env === process.env`, and the env module merges the caller's `cwd/.env`
 * into it, so without a trust boundary a repository could redirect the search and
 * hand over the credential.
 *
 * The wrinkle that kept this provider out of the earlier sweep: basic auth treats
 * an intentionally **empty** username or password as meaningful (`alice:` and
 * `:s3cret` are both valid), while `$credentialEnv` collapses empty to
 * `undefined`. Both properties are asserted here.
 *
 * `projectEnv` is parsed at module load from `process.cwd()`, so these drive a
 * child process with a controlled cwd.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "searxng-env-probe.ts");
const KEYS = ["SEARXNG_ENDPOINT", "SEARXNG_TOKEN", "SEARXNG_BASIC_USERNAME", "SEARXNG_BASIC_PASSWORD"] as const;

interface Resolved {
	endpoint: string | null;
	token: string | null;
	basicUsername: string | null;
	basicPassword: string | null;
}

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-searxng-trust-"));
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
	"SEARXNG_ENDPOINT=https://attacker.example",
	"SEARXNG_TOKEN=attacker-token",
	"SEARXNG_BASIC_USERNAME=attacker",
	"SEARXNG_BASIC_PASSWORD=attacker-pass",
].join("\n");

describe("SearXNG env trust boundary", () => {
	it("resolves nothing when the environment supplies nothing", async () => {
		expect(await resolveIn(projectDir())).toEqual({
			endpoint: null,
			token: null,
			basicUsername: null,
			basicPassword: null,
		});
	});

	it("ignores an endpoint and credentials planted by the project .env", async () => {
		expect(await resolveIn(projectDir(PLANTED))).toEqual({
			endpoint: null,
			token: null,
			basicUsername: null,
			basicPassword: null,
		});
	});

	it("ignores an intentionally empty value planted by the project .env", async () => {
		const resolved = await resolveIn(projectDir("SEARXNG_BASIC_PASSWORD=\nSEARXNG_BASIC_USERNAME=\n"));
		expect(resolved.basicPassword).toBeNull();
		expect(resolved.basicUsername).toBeNull();
	});

	it("still honors inherited SearXNG configuration", async () => {
		const resolved = await resolveIn(projectDir(), {
			SEARXNG_ENDPOINT: "https://searx.internal",
			SEARXNG_TOKEN: "operator-token",
		});
		expect(resolved.endpoint).toBe("https://searx.internal");
		expect(resolved.token).toBe("operator-token");
	});

	it("preserves an intentionally empty inherited password", async () => {
		const resolved = await resolveIn(projectDir(), {
			SEARXNG_ENDPOINT: "https://searx.internal",
			SEARXNG_BASIC_USERNAME: "alice",
			SEARXNG_BASIC_PASSWORD: "",
		});
		expect(resolved.basicUsername).toBe("alice");
		expect(resolved.basicPassword).toBe("");
	});

	it("preserves an intentionally empty inherited username", async () => {
		const resolved = await resolveIn(projectDir(), {
			SEARXNG_ENDPOINT: "https://searx.internal",
			SEARXNG_BASIC_USERNAME: "",
			SEARXNG_BASIC_PASSWORD: "s3cret",
		});
		expect(resolved.basicUsername).toBe("");
		expect(resolved.basicPassword).toBe("s3cret");
	});

	it("does not let the project .env override inherited configuration", async () => {
		const resolved = await resolveIn(projectDir(PLANTED), { SEARXNG_ENDPOINT: "https://searx.internal" });
		expect(resolved.endpoint).toBe("https://searx.internal");
	});
});

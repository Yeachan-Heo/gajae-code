import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `resolveProviderBaseUrlFromEnv()` feeds both `getProviderBaseUrl()` and the
 * provider override that is baked into `model.baseUrl`, which the provider
 * resolvers use as the request endpoint carrying the provider credential. It is
 * generic: `getProviderBaseUrlEnvKeys()` derives `<PROVIDER>_BASE_URL` for any
 * provider on top of the explicit aliases, so this one resolver decides the
 * endpoint for every provider — and can re-admit a redirect that the
 * provider-level resolvers already reject.
 *
 * `Bun.env === process.env`, and the env module merges the caller's `cwd/.env`
 * into it. `projectEnv` is parsed at module load from `process.cwd()`, so these
 * drive a child process with a controlled cwd.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "provider-baseurl-registry-probe.ts");
const KEYS = ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "GOOGLE_BASE_URL", "GEMINI_BASE_URL"] as const;

interface Resolved {
	anthropic: string | null;
	openai: string | null;
	google: string | null;
}

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-provider-baseurl-trust-"));
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
	// Never let the outer environment leak an endpoint override into the child.
	for (const key of KEYS) delete env[key];
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE, tempDir()], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as Resolved;
}

function expectNoRedirect(value: string | null): void {
	// A blocked value is either absent or a legitimate default; never the attacker host.
	expect(value ?? "").not.toContain("attacker.example");
}

describe("provider base URL registry trust boundary", () => {
	it("ignores provider base URLs planted by the project .env", async () => {
		const cwd = projectDir(
			[
				"ANTHROPIC_BASE_URL=https://attacker.example",
				"OPENAI_BASE_URL=https://attacker.example/v1",
				"GOOGLE_BASE_URL=https://attacker.example/g",
			].join("\n"),
		);

		const resolved = await resolveIn(cwd);

		expectNoRedirect(resolved.anthropic);
		expectNoRedirect(resolved.openai);
		expectNoRedirect(resolved.google);
	});

	it("ignores a planted alias for the same provider", async () => {
		// GEMINI_BASE_URL is an alias for the google provider.
		const cwd = projectDir("GEMINI_BASE_URL=https://attacker.example/g\n");
		expectNoRedirect((await resolveIn(cwd)).google);
	});

	it("still honors inherited provider base URLs", async () => {
		const resolved = await resolveIn(projectDir(), {
			ANTHROPIC_BASE_URL: "https://anthropic.internal",
			OPENAI_BASE_URL: "https://openai.internal/v1",
		});
		expect(resolved.anthropic).toBe("https://anthropic.internal");
		expect(resolved.openai).toBe("https://openai.internal/v1");
	});

	it("does not let the project .env override an inherited base URL", async () => {
		const cwd = projectDir("ANTHROPIC_BASE_URL=https://attacker.example\n");
		const resolved = await resolveIn(cwd, { ANTHROPIC_BASE_URL: "https://anthropic.internal" });
		expect(resolved.anthropic).toBe("https://anthropic.internal");
	});
});

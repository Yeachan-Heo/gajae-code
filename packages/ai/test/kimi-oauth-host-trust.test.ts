import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The Kimi OAuth host receives the device-authorization request, the
 * authorization-code exchange, and the refresh call that carries the existing
 * refresh token (`/api/oauth/device_authorization` and `/api/oauth/token`), so
 * whatever can set it can collect the user's Kimi credentials.
 *
 * `Bun.env === process.env`, and the env module merges the caller's `cwd/.env`
 * into it. `projectEnv` is parsed at module load from `process.cwd()`, so these
 * drive a child process with a controlled cwd.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "kimi-oauth-host-probe.ts");
const KEYS = ["KIMI_CODE_OAUTH_HOST", "KIMI_OAUTH_HOST"] as const;

const tempDirs: string[] = [];

function projectDir(dotenv?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-kimi-oauth-trust-"));
	tempDirs.push(dir);
	if (dotenv !== undefined) fs.writeFileSync(path.join(dir, ".env"), dotenv);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function hostIn(cwd: string, overrides: Record<string, string> = {}): Promise<string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	// Never let the outer environment leak a host override into the child.
	for (const key of KEYS) delete env[key];
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return (JSON.parse(stdout.trim()) as { host: string }).host;
}

describe("Kimi OAuth host trust boundary", () => {
	it("uses the built-in host when nothing overrides it", async () => {
		expect(await hostIn(projectDir())).not.toContain("attacker.example");
	});

	it("ignores a KIMI_CODE_OAUTH_HOST planted by the project .env", async () => {
		const cwd = projectDir("KIMI_CODE_OAUTH_HOST=https://attacker.example\n");
		expect(await hostIn(cwd)).not.toContain("attacker.example");
	});

	it("ignores the legacy KIMI_OAUTH_HOST planted by the project .env", async () => {
		const cwd = projectDir("KIMI_OAUTH_HOST=https://attacker.example\n");
		expect(await hostIn(cwd)).not.toContain("attacker.example");
	});

	it("still honors an inherited KIMI_CODE_OAUTH_HOST", async () => {
		expect(await hostIn(projectDir(), { KIMI_CODE_OAUTH_HOST: "https://kimi.internal" })).toBe(
			"https://kimi.internal",
		);
	});

	it("still honors the inherited legacy alias", async () => {
		expect(await hostIn(projectDir(), { KIMI_OAUTH_HOST: "https://kimi-legacy.internal" })).toBe(
			"https://kimi-legacy.internal",
		);
	});

	it("keeps the primary name ahead of the legacy alias", async () => {
		const host = await hostIn(projectDir(), {
			KIMI_CODE_OAUTH_HOST: "https://kimi.internal",
			KIMI_OAUTH_HOST: "https://kimi-legacy.internal",
		});
		expect(host).toBe("https://kimi.internal");
	});

	it("does not let the project .env override an inherited host", async () => {
		const cwd = projectDir("KIMI_CODE_OAUTH_HOST=https://attacker.example\n");
		expect(await hostIn(cwd, { KIMI_CODE_OAUTH_HOST: "https://kimi.internal" })).toBe("https://kimi.internal");
	});
});

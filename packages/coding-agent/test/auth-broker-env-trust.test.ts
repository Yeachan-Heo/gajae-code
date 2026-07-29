import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `resolveAuthBrokerConfig()` decides whether the agent's credential store is the
 * local SQLite file or a remote broker: `discoverAuthStorage()` builds an
 * `AuthBrokerClient` / `RemoteAuthCredentialStore` from its result and uses that
 * as the `AuthStorage` for every provider. So whatever can set the URL and token
 * can serve the credentials the agent authenticates with and receive the ones it
 * writes back.
 *
 * `Bun.env === process.env`, and the env module merges the caller's `cwd/.env`
 * into it. `projectEnv` is parsed at module load from `process.cwd()`, so these
 * drive a child process with a controlled cwd.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "auth-broker-config-probe.ts");
const KEYS = ["GJC_AUTH_BROKER_URL", "GJC_AUTH_BROKER_TOKEN"] as const;

interface Resolved {
	config: { url: string; token: string } | null;
	error: string | null;
}

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-auth-broker-trust-"));
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
	// Never let the outer environment leak broker settings into the child, and keep
	// the probe away from the developer's real agent dir / config.yml.
	for (const key of KEYS) delete env[key];
	env.GJC_CODING_AGENT_DIR = tempDir();
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as Resolved;
}

describe("auth broker configuration trust boundary", () => {
	it("resolves no broker when nothing configures one", async () => {
		const resolved = await resolveIn(projectDir());
		expect(resolved.config).toBeNull();
		expect(resolved.error).toBeNull();
	});

	it("ignores a broker URL and token planted by the project .env", async () => {
		const cwd = projectDir(
			["GJC_AUTH_BROKER_URL=https://attacker.example", "GJC_AUTH_BROKER_TOKEN=attacker-token"].join("\n"),
		);
		const resolved = await resolveIn(cwd);
		expect(resolved.config).toBeNull();
		expect(resolved.error).toBeNull();
	});

	it("ignores a planted broker URL even without a planted token", async () => {
		// A planted URL alone must not reach the throw-on-missing-token path either.
		const cwd = projectDir("GJC_AUTH_BROKER_URL=https://attacker.example\n");
		const resolved = await resolveIn(cwd);
		expect(resolved.config).toBeNull();
		expect(resolved.error).toBeNull();
	});

	it("still honors a broker inherited from the launching shell", async () => {
		const resolved = await resolveIn(projectDir(), {
			GJC_AUTH_BROKER_URL: "https://broker.internal",
			GJC_AUTH_BROKER_TOKEN: "operator-token",
		});
		expect(resolved.config).toEqual({ url: "https://broker.internal", token: "operator-token" });
	});

	it("does not let the project .env override an inherited broker", async () => {
		const cwd = projectDir(
			["GJC_AUTH_BROKER_URL=https://attacker.example", "GJC_AUTH_BROKER_TOKEN=attacker-token"].join("\n"),
		);
		const resolved = await resolveIn(cwd, {
			GJC_AUTH_BROKER_URL: "https://broker.internal",
			GJC_AUTH_BROKER_TOKEN: "operator-token",
		});
		expect(resolved.config).toEqual({ url: "https://broker.internal", token: "operator-token" });
	});
});

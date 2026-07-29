import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Both of these decide the identity the agent authenticates to Google as:
 *
 * - `GOOGLE_APPLICATION_CREDENTIALS` is read as a service-account / authorized-user
 *   file and exchanged for an access token (`loadAdcCredentials`).
 * - `GOOGLE_CLOUD_API_KEY` is used directly as the Vertex API key.
 *
 * `Bun.env === process.env`, and the env module merges the caller's `cwd/.env`
 * into it, so without a trust boundary a repository could ship a key file and
 * point the agent at it. `stream.ts` already resolves the same ADC variable
 * through `$credentialEnv`.
 *
 * `projectEnv` is parsed at module load from `process.cwd()`, so these drive a
 * child process with a controlled cwd.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "google-credentials-probe.ts");
const KEYS = ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_API_KEY"] as const;

interface Resolved {
	adcPath: string | null;
	vertexApiKey: string | null;
	callerKeyWins: string | null;
}

const tempDirs: string[] = [];

function projectDir(dotenv?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-google-cred-trust-"));
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
	// Never let the outer environment leak Google credentials into the child.
	for (const key of KEYS) delete env[key];
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as Resolved;
}

describe("Google credential trust boundary", () => {
	it("resolves nothing when the environment supplies nothing", async () => {
		const resolved = await resolveIn(projectDir());
		expect(resolved.adcPath).toBeNull();
		expect(resolved.vertexApiKey).toBeNull();
	});

	it("ignores a service-account path planted by the project .env", async () => {
		const cwd = projectDir("GOOGLE_APPLICATION_CREDENTIALS=./attacker-service-account.json\n");
		expect((await resolveIn(cwd)).adcPath).toBeNull();
	});

	it("ignores a Vertex API key planted by the project .env", async () => {
		const cwd = projectDir("GOOGLE_CLOUD_API_KEY=attacker-key\n");
		expect((await resolveIn(cwd)).vertexApiKey).toBeNull();
	});

	it("still honors inherited Google credentials", async () => {
		const resolved = await resolveIn(projectDir(), {
			GOOGLE_APPLICATION_CREDENTIALS: "/opt/gcp/sa.json",
			GOOGLE_CLOUD_API_KEY: "operator-key",
		});
		expect(resolved.adcPath).toBe("/opt/gcp/sa.json");
		expect(resolved.vertexApiKey).toBe("operator-key");
	});

	it("does not let the project .env override inherited credentials", async () => {
		const cwd = projectDir(
			["GOOGLE_APPLICATION_CREDENTIALS=./attacker-service-account.json", "GOOGLE_CLOUD_API_KEY=attacker-key"].join(
				"\n",
			),
		);
		const resolved = await resolveIn(cwd, {
			GOOGLE_APPLICATION_CREDENTIALS: "/opt/gcp/sa.json",
			GOOGLE_CLOUD_API_KEY: "operator-key",
		});
		expect(resolved.adcPath).toBe("/opt/gcp/sa.json");
		expect(resolved.vertexApiKey).toBe("operator-key");
	});

	it("keeps an explicit caller API key ahead of the environment", async () => {
		const cwd = projectDir("GOOGLE_CLOUD_API_KEY=attacker-key\n");
		expect((await resolveIn(cwd)).callerKeyWins).toBe("caller-key");
	});
});

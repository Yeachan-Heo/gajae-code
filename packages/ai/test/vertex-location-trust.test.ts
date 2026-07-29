import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The Vertex location is interpolated into the request **host**
 * (`${location}-aiplatform.googleapis.com`, `google-vertex.ts:84`) and the URL is
 * sent with `Authorization: Bearer <accessToken>` (`:51`, `:55`). A value
 * containing `/` terminates the authority component, so `evil.example.com/`
 * resolves to origin `https://evil.example.com` and the Google access token
 * leaves Google entirely.
 *
 * Two independent defences are asserted: the value cannot come from the caller's
 * project `.env` at all, and no source may turn a region label into an authority.
 *
 * `projectEnv` is parsed at module load from `process.cwd()`, so these drive a
 * child process with a controlled cwd.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "vertex-location-probe.ts");
const KEYS = ["GOOGLE_CLOUD_LOCATION", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"] as const;

interface Resolved {
	location: string | null;
	origin: string | null;
	error: string | null;
}

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-vertex-location-trust-"));
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

describe("Vertex location trust boundary", () => {
	it("resolves no location when nothing supplies one", async () => {
		const resolved = await resolveIn(projectDir());
		expect(resolved.location).toBeNull();
		expect(resolved.error).toContain("requires a location");
	});

	it("ignores a host-injecting location planted by the project .env", async () => {
		const resolved = await resolveIn(projectDir("GOOGLE_CLOUD_LOCATION=evil.example.com/\n"));
		expect(resolved.origin).toBeNull();
		expect(resolved.location).toBeNull();
	});

	it("ignores an ordinary location planted by the project .env", async () => {
		expect((await resolveIn(projectDir("GOOGLE_CLOUD_LOCATION=us-central1\n"))).location).toBeNull();
	});

	it("still honors an inherited region", async () => {
		const resolved = await resolveIn(projectDir(), { GOOGLE_CLOUD_LOCATION: "us-central1" });
		expect(resolved.location).toBe("us-central1");
		expect(resolved.origin).toBe("https://us-central1-aiplatform.googleapis.com");
	});

	it("still honors the global region", async () => {
		const resolved = await resolveIn(projectDir(), { GOOGLE_CLOUD_LOCATION: "global" });
		expect(resolved.origin).toBe("https://aiplatform.googleapis.com");
	});

	it.each([
		"evil.example.com/",
		"evil.example.com/x",
		"us-central1/../..",
		"a@evil.example.com",
	])("rejects the authority-shaped location %p even from a trusted source", async value => {
		const resolved = await resolveIn(projectDir(), { GOOGLE_CLOUD_LOCATION: value });
		expect(resolved.origin).toBeNull();
		expect(resolved.error).toContain("Invalid Vertex AI location");
	});
});

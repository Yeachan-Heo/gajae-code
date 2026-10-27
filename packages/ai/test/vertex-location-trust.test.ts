import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __resetVertexTokenCache } from "../src/providers/google-auth";
import { streamGoogleVertex } from "../src/providers/google-vertex";
import type { Model } from "../src/types";

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

	it.each(["evil.example.com/", "evil.example.com/x", "us-central1/../..", "a@evil.example.com"])(
		"rejects the authority-shaped location %p even from a trusted source",
		async value => {
			const resolved = await resolveIn(projectDir(), { GOOGLE_CLOUD_LOCATION: value });
			expect(resolved.origin).toBeNull();
			expect(resolved.error).toContain("Invalid Vertex AI location");
		},
	);
});

// #1270
describe("Vertex global endpoint requests", () => {
	const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
	const METADATA_TOKEN_URL =
		"http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

	const context = {
		messages: [{ role: "user" as const, content: "hello", timestamp: 0 }],
	};

	const model: Model<"google-vertex"> = {
		id: "gemini-3.1-pro-preview",
		name: "Gemini 3.1 Pro Preview",
		api: "google-vertex",
		provider: "google-vertex",
		baseUrl: "https://{location}-aiplatform.googleapis.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	};

	const originalApiKey = Bun.env.GOOGLE_CLOUD_API_KEY;
	const originalCredentials = Bun.env.GOOGLE_APPLICATION_CREDENTIALS;

	afterEach(() => {
		__resetVertexTokenCache();
		if (originalApiKey === undefined) delete Bun.env.GOOGLE_CLOUD_API_KEY;
		else Bun.env.GOOGLE_CLOUD_API_KEY = originalApiKey;
		if (originalCredentials === undefined) delete Bun.env.GOOGLE_APPLICATION_CREDENTIALS;
		else Bun.env.GOOGLE_APPLICATION_CREDENTIALS = originalCredentials;
	});

	it("uses the global Vertex AI service host for locations/global", async () => {
		delete Bun.env.GOOGLE_CLOUD_API_KEY;
		delete Bun.env.GOOGLE_APPLICATION_CREDENTIALS;

		const urls: string[] = [];
		const stream = streamGoogleVertex(model, context, {
			project: "vertex-project",
			location: "global",
			fetch: async input => {
				const url = input instanceof Request ? input.url : input.toString();
				urls.push(url);
				// The assertion below is about the Vertex model URL; local user ADC may
				// hit OAuth before the model request, while CI without ADC uses metadata.
				if (url === METADATA_TOKEN_URL || url === OAUTH_TOKEN_URL) {
					return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }));
				}
				return new Response('{"error":{"message":"stop after capture"}}', { status: 400 });
			},
		});

		await stream.result();

		expect(urls).toContain(
			"https://aiplatform.googleapis.com/v1/projects/vertex-project/locations/global/publishers/google/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse",
		);
	});
});

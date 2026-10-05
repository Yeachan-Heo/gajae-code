import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { captureEndpointConfiguration, type EndpointConfiguration, hookFetch } from "@gajae-code/utils";
import { __resetVertexTokenCache } from "../src/providers/google-auth";
import { streamGoogleVertex } from "../src/providers/google-vertex";
import { streamSimple } from "../src/stream";
import type { Context, Model } from "../src/types";

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

function createVertexSseResponse(): Response {
	const payload = {
		candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
	};
	return new Response(`data: ${JSON.stringify(payload)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
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

	it("pins ADC project and location on actual Vertex requests across scopes", async () => {
		const envKeys = [
			"GOOGLE_CLOUD_LOCATION",
			"GOOGLE_CLOUD_PROJECT",
			"GCLOUD_PROJECT",
			"GOOGLE_APPLICATION_CREDENTIALS",
			"GOOGLE_CLOUD_API_KEY",
		] as const;
		const previousEnv = new Map(envKeys.map(key => [key, Bun.env[key]]));
		const credentialPath = path.join(tempDir(), "authorized-user-adc.json");
		fs.writeFileSync(
			credentialPath,
			JSON.stringify({
				type: "authorized_user",
				client_id: "vertex-test-client",
				client_secret: "vertex-test-secret",
				refresh_token: "vertex-test-refresh-token",
			}),
		);
		const requests: Array<{ url: string; authorization: string | null }> = [];
		let tokenExchanges = 0;
		const model: Model<"google-vertex"> = {
			id: "gemini-2.5-flash",
			name: "Gemini 2.5 Flash",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 8192,
		};
		const context: Context = { messages: [{ role: "user", content: "use ADC", timestamp: Date.now() }] };

		try {
			for (const key of envKeys) delete Bun.env[key];
			Bun.env.GCLOUD_PROJECT = "scope-a-project";
			Bun.env.GOOGLE_CLOUD_LOCATION = "us-west1";
			const scopeA = captureEndpointConfiguration();
			Bun.env.GOOGLE_CLOUD_PROJECT = "scope-b-project";
			Bun.env.GCLOUD_PROJECT = "lower-priority-project";
			Bun.env.GOOGLE_CLOUD_LOCATION = "asia-northeast1";
			const scopeB = captureEndpointConfiguration();
			Bun.env.GOOGLE_APPLICATION_CREDENTIALS = credentialPath;

			using _hook = hookFetch(async (input, init) => {
				const request = input instanceof Request ? input : new Request(String(input), init);
				if (request.url === "https://oauth2.googleapis.com/token") {
					tokenExchanges += 1;
					const form = new URLSearchParams(await request.clone().text());
					expect(form.get("grant_type")).toBe("refresh_token");
					expect(form.get("refresh_token")).toBe("vertex-test-refresh-token");
					return Response.json({ access_token: `adc-access-${tokenExchanges}`, expires_in: 3600 });
				}
				requests.push({ url: request.url, authorization: request.headers.get("authorization") });
				return createVertexSseResponse();
			});

			__resetVertexTokenCache();
			await streamSimple(model, context, { endpointConfiguration: scopeA, streamMaxRetries: 0 }).result();
			__resetVertexTokenCache();
			await streamSimple(model, context, { endpointConfiguration: scopeB, streamMaxRetries: 0 }).result();
			__resetVertexTokenCache();
			await streamGoogleVertex(model, context, {
				endpointConfiguration: scopeA,
				project: "explicit-project",
				location: "global",
			}).result();

			const beforeForgedHandle = requests.length + tokenExchanges;
			expect(() =>
				streamGoogleVertex(model, context, {
					endpointConfiguration: Object.freeze({}) as EndpointConfiguration,
				}),
			).toThrow("Invalid endpoint configuration handle");
			expect(requests.length + tokenExchanges).toBe(beforeForgedHandle);

			for (const key of ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"] as const) {
				delete Bun.env[key];
			}
			const capturedAbsence = captureEndpointConfiguration();
			Bun.env.GOOGLE_CLOUD_PROJECT = "scope-c-project";
			Bun.env.GOOGLE_CLOUD_LOCATION = "us-central1";
			__resetVertexTokenCache();
			const absentResult = await streamGoogleVertex(model, context, {
				endpointConfiguration: capturedAbsence,
			}).result();
			expect(absentResult.stopReason).toBe("error");
			expect(absentResult.errorMessage).toContain("requires a project ID");
			expect(requests).toHaveLength(3);
			expect(tokenExchanges).toBe(3);

			expect(requests.map(request => request.url)).toEqual([
				"https://us-west1-aiplatform.googleapis.com/v1/projects/scope-a-project/locations/us-west1/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
				"https://asia-northeast1-aiplatform.googleapis.com/v1/projects/scope-b-project/locations/asia-northeast1/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
				"https://aiplatform.googleapis.com/v1/projects/explicit-project/locations/global/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
			]);
			expect(requests.map(request => request.authorization)).toEqual([
				"Bearer adc-access-1",
				"Bearer adc-access-2",
				"Bearer adc-access-3",
			]);
		} finally {
			__resetVertexTokenCache();
			for (const key of envKeys) {
				const previous = previousEnv.get(key);
				if (previous === undefined) delete Bun.env[key];
				else Bun.env[key] = previous;
			}
		}
	});
});

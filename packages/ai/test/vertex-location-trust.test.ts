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

describe("Vertex retained endpoint requests", () => {
	it("retains routing across callers while sharing live ADC and using the global service host (#1270)", async () => {
		const cwd = projectDir();
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (value !== undefined) env[key] = value;
		}
		for (const key of [...KEYS, "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_API_KEY"]) delete env[key];
		env.HOME = tempDir();
		env.GJC_CODING_AGENT_DIR = tempDir();
		const source = `
import * as assert from "node:assert/strict";
import { captureEndpointConfiguration, type EndpointConfiguration } from ${JSON.stringify(path.resolve(import.meta.dir, "../../utils/src/index.ts"))};
import { __resetVertexTokenCache } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/providers/google-auth.ts"))};
import { streamGoogleVertex } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/providers/google-vertex.ts"))};
import { stream, streamSimple } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/stream.ts"))};
import type { Context, FetchImpl, Model } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/types.ts"))};

const model: Model<"google-vertex"> = {
	id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview",
	api: "google-vertex", provider: "google-vertex",
	baseUrl: "https://{location}-aiplatform.googleapis.com", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 65_536,
};
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
const credentialPath = ${JSON.stringify(path.join(cwd, "authorized-user-adc.json"))};
async function writeCredentials(refreshToken: string) {
	await Bun.write(credentialPath, JSON.stringify({
		type: "authorized_user", client_id: "vertex-client", client_secret: "vertex-secret",
		refresh_token: refreshToken, token_uri: "https://evil.invalid/token",
	}));
}
const requests: Array<{ url: string; authorization: string | null; apiKey: string | null }> = [];
const refreshTokens: Array<string | null> = [];
const fetchImpl: FetchImpl = async (input, init) => {
	const request = input instanceof Request ? input : new Request(String(input), init);
	if (request.url === "https://oauth2.googleapis.com/token") {
		const form = new URLSearchParams(await request.text());
		assert.equal(form.get("grant_type"), "refresh_token");
		assert.equal(form.get("client_id"), "vertex-client");
		assert.equal(form.get("client_secret"), "vertex-secret");
		refreshTokens.push(form.get("refresh_token"));
		return Response.json({ access_token: "adc-access-" + refreshTokens.length, expires_in: 3600 });
	}
	assert.equal(new URL(request.url).hostname.endsWith("aiplatform.googleapis.com"), true);
	requests.push({ url: request.url, authorization: request.headers.get("authorization"), apiKey: request.headers.get("x-goog-api-key") });
	return new Response("data: " + JSON.stringify({
		candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
	}) + "\\n\\n", { headers: { "content-type": "text/event-stream" } });
};
// Fail closed even if a provider ignores the explicitly injected transport.
globalThis.fetch = fetchImpl;
Bun.env.GCLOUD_PROJECT = "scope-a-project";
Bun.env.GOOGLE_CLOUD_LOCATION = "us-west1";
const scopeA = captureEndpointConfiguration();
Bun.env.GOOGLE_CLOUD_PROJECT = "scope-b-project";
Bun.env.GCLOUD_PROJECT = "lower-priority-project";
Bun.env.GOOGLE_CLOUD_LOCATION = "asia-northeast1";
const scopeB = captureEndpointConfiguration();
// ADC is supplied after capture and is shared across endpoint scopes.
await writeCredentials("refresh-before");
Bun.env.GOOGLE_APPLICATION_CREDENTIALS = credentialPath;
for (const [caller, endpointConfiguration] of [[stream, scopeA], [streamSimple, scopeB]] as const) {
	const result = await caller(model, context, { endpointConfiguration, fetch: fetchImpl, streamMaxRetries: 0 }).result();
	assert.notEqual(result.stopReason, "error", result.errorMessage);
}
assert.deepEqual(refreshTokens, ["refresh-before"]);
await writeCredentials("refresh-after");
__resetVertexTokenCache();
const explicit = await streamGoogleVertex(model, context, {
	endpointConfiguration: scopeA, project: "explicit-project", location: "global", fetch: fetchImpl,
}).result();
assert.notEqual(explicit.stopReason, "error", explicit.errorMessage);
assert.deepEqual(refreshTokens, ["refresh-before", "refresh-after"]);
assert.deepEqual(requests.map(request => request.url), [
	"https://us-west1-aiplatform.googleapis.com/v1/projects/scope-a-project/locations/us-west1/publishers/google/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse",
	"https://asia-northeast1-aiplatform.googleapis.com/v1/projects/scope-b-project/locations/asia-northeast1/publishers/google/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse",
	"https://aiplatform.googleapis.com/v1/projects/explicit-project/locations/global/publishers/google/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse",
]);
assert.deepEqual(requests.map(request => request.authorization), ["Bearer adc-access-1", "Bearer adc-access-1", "Bearer adc-access-2"]);
const beforeInvalid = requests.length + refreshTokens.length;
for (const forged of [Object.freeze({}), JSON.parse(JSON.stringify(scopeA))]) {
	assert.throws(() => streamGoogleVertex(model, context, {
		endpointConfiguration: forged as EndpointConfiguration, apiKey: "explicit-key", fetch: fetchImpl,
	}), /Invalid endpoint configuration handle/);
}
assert.equal(requests.length + refreshTokens.length, beforeInvalid);
for (const key of ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"]) delete Bun.env[key];
const absent = captureEndpointConfiguration();
Bun.env.GOOGLE_CLOUD_PROJECT = "late-project";
Bun.env.GOOGLE_CLOUD_LOCATION = "us-central1";
const missingProject = await streamGoogleVertex(model, context, { endpointConfiguration: absent, fetch: fetchImpl }).result();
assert.equal(missingProject.stopReason, "error");
assert.match(missingProject.errorMessage ?? "", /requires a project ID/);
const missingLocation = await streamGoogleVertex(model, context, { endpointConfiguration: absent, project: "explicit-project", fetch: fetchImpl }).result();
assert.equal(missingLocation.stopReason, "error");
assert.match(missingLocation.errorMessage ?? "", /requires a location/);
assert.equal(requests.length + refreshTokens.length, beforeInvalid);
// API keys remain live rather than captured, and use the express-mode endpoint.
Bun.env.GOOGLE_CLOUD_API_KEY = "live-key";
const express = await streamGoogleVertex(model, context, { endpointConfiguration: absent, fetch: fetchImpl }).result();
assert.notEqual(express.stopReason, "error", express.errorMessage);
assert.deepEqual(requests.at(-1), {
	url: "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse",
	authorization: null, apiKey: "live-key",
});
assert.equal(refreshTokens.length, 2);
`;
		const proc = Bun.spawn([process.execPath, "--eval", source], { cwd, env, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		expect({ exitCode: await proc.exited, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
	});
});

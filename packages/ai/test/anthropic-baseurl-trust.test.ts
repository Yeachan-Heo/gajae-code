import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `resolveAnthropicBaseUrlFromEnv()` feeds `buildAnthropicAuthConfig()`, whose
 * result `buildAnthropicUrl()` turns into `${baseUrl}/v1/messages` while the
 * headers carry the Anthropic API key / OAuth token. `isFoundryEnabled()` picks
 * the Foundry branch of that resolution and gates the mTLS material.
 *
 * `Bun.env === process.env`, and the env module merges the caller's `cwd/.env`
 * into it, so without a trust boundary a repository could plant `.env` and have
 * authenticated requests delivered to an endpoint of its choosing.
 *
 * `projectEnv` is parsed at module load from `process.cwd()`, so these drive a
 * child process with a controlled cwd.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "anthropic-baseurl-probe.ts");
const KEYS = ["ANTHROPIC_BASE_URL", "FOUNDRY_BASE_URL", "CLAUDE_CODE_USE_FOUNDRY"] as const;

interface Resolved {
	foundryEnabled: boolean;
	baseUrl: string | null;
}

const tempDirs: string[] = [];

function projectDir(dotenv?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-anthropic-baseurl-trust-"));
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
	// Never let the outer environment leak an endpoint override into the child.
	for (const key of KEYS) delete env[key];
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as Resolved;
}

// Keep SDK imports, HOME, credentials, and fetch replacement inside an isolated
// process. In particular, never inherit developer credentials or config paths.
async function requestBoundaryIn(body: string): Promise<void> {
	const cwd = projectDir();
	const home = path.join(cwd, "home");
	fs.mkdirSync(home);
	const env: Record<string, string> = {
		HOME: home,
		USERPROFILE: home,
		GJC_CONFIG_DIR: path.join(home, "config"),
		GJC_CODING_AGENT_DIR: path.join(home, "agent"),
		NODE_ENV: "test",
	};
	for (const key of ["PATH", "TMPDIR", "SystemRoot"]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	const source = `
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import Anthropic from ${JSON.stringify(import.meta.resolve("@anthropic-ai/sdk"))};
import { captureEndpointConfiguration } from ${JSON.stringify(new URL("../../utils/src/index.ts", import.meta.url).href)};
import { streamAnthropic, buildAnthropicClientOptions } from ${JSON.stringify(new URL("../src/providers/anthropic.ts", import.meta.url).href)};

let globalFetchCalls = 0;
globalThis.fetch = async () => {
	globalFetchCalls++;
	throw new Error("Unexpected global fetch: real network is forbidden");
};
const model = {
	id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6",
	api: "anthropic-messages", provider: "anthropic",
	baseUrl: "https://explicit-model.example", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000, maxTokens: 8192,
};
const zcode = { ...model, provider: "glm-zcode", baseUrl: "https://ignored-catalog.example" };
const context = { messages: [{ role: "user", content: "route this request", timestamp: 0 }] };
const requests = [];
const fetchOverride = async (input, init) => {
	const request = new Request(input, init);
	const payload = request.headers.get("content-encoding") === "gzip"
		? JSON.parse(gunzipSync(Buffer.from(await request.arrayBuffer())).toString("utf8"))
		: await request.json();
	requests.push({
		url: request.url, apiKey: request.headers.get("x-api-key"),
		authorization: request.headers.get("authorization"), model: payload.model,
	});
	assert.equal(payload.stream, true);
	assert.ok(JSON.stringify(payload.messages).includes("route this request"));
	const frames = [
		{ type: "message_start", message: {
			id: "msg_endpoint_retention", type: "message", role: "assistant", model: model.id,
			content: [], stop_reason: null, stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 0 },
		} },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "retained endpoint" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(frames.map(frame => "event: " + frame.type + "\\ndata: " + JSON.stringify(frame) + "\\n\\n").join(""), {
		headers: { "content-type": "text/event-stream" },
	});
};
const send = async (target, endpointConfiguration, extra = {}) => {
	const result = await streamAnthropic(target, context, {
		endpointConfiguration, fetch: fetchOverride,
		requestMaxRetries: 0, streamMaxRetries: 0,
		streamFirstEventTimeoutMs: 2000, streamIdleTimeoutMs: 2000,
		...extra,
	}).result();
	assert.equal(result.stopReason, "stop", JSON.stringify({ error: result.errorMessage, urls: requests.map(request => request.url), globalFetchCalls }));
	assert.deepEqual(result.content.map(block => block.type === "text" ? block.text : block.type), ["retained endpoint"]);
};
${body}
assert.equal(globalFetchCalls, 0);
console.log("endpoint-boundary-ok");
`;
	const proc = Bun.spawn([process.execPath, "--eval", source], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	expect(await proc.exited, stderr).toBe(0);
	expect(stdout.trim()).toBe("endpoint-boundary-ok");
}

describe("Anthropic endpoint trust boundary", () => {
	it("resolves no env base URL and no Foundry mode by default", async () => {
		expect(await resolveIn(projectDir())).toEqual({ foundryEnabled: false, baseUrl: null });
	});

	it("ignores an ANTHROPIC_BASE_URL planted by the project .env", async () => {
		const cwd = projectDir("ANTHROPIC_BASE_URL=https://attacker.example\n");
		expect((await resolveIn(cwd)).baseUrl).toBeNull();
	});

	it("ignores a Foundry opt-in planted by the project .env", async () => {
		const cwd = projectDir("CLAUDE_CODE_USE_FOUNDRY=1\nFOUNDRY_BASE_URL=https://attacker.example\n");
		const resolved = await resolveIn(cwd);
		expect(resolved.foundryEnabled).toBe(false);
		expect(resolved.baseUrl).toBeNull();
	});

	it("ignores a planted FOUNDRY_BASE_URL even when Foundry is legitimately enabled", async () => {
		const cwd = projectDir("FOUNDRY_BASE_URL=https://attacker.example\n");
		const resolved = await resolveIn(cwd, { CLAUDE_CODE_USE_FOUNDRY: "1" });
		expect(resolved.foundryEnabled).toBe(true);
		expect(resolved.baseUrl).toBeNull();
	});

	it("still honors an inherited ANTHROPIC_BASE_URL", async () => {
		const resolved = await resolveIn(projectDir(), { ANTHROPIC_BASE_URL: "https://gateway.internal/" });
		expect(resolved.baseUrl).toBe("https://gateway.internal");
	});

	it("still honors an inherited Foundry configuration", async () => {
		const resolved = await resolveIn(projectDir(), {
			CLAUDE_CODE_USE_FOUNDRY: "true",
			FOUNDRY_BASE_URL: "https://foundry.internal",
		});
		expect(resolved.foundryEnabled).toBe(true);
		expect(resolved.baseUrl).toBe("https://foundry.internal");
	});

	it("does not let the project .env override an inherited base URL", async () => {
		const cwd = projectDir("ANTHROPIC_BASE_URL=https://attacker.example\n");
		expect((await resolveIn(cwd, { ANTHROPIC_BASE_URL: "https://gateway.internal" })).baseUrl).toBe(
			"https://gateway.internal",
		);
	});

	it("retains Foundry mode and URLs while resolving current credentials on SDK requests", async () => {
		await requestBoundaryIn(`
Bun.env.CLAUDE_CODE_USE_FOUNDRY = "1";
Bun.env.FOUNDRY_BASE_URL = "https://foundry-a.example/";
Bun.env.ANTHROPIC_FOUNDRY_API_KEY = "obsolete-at-capture";
const a = captureEndpointConfiguration();
Bun.env.FOUNDRY_BASE_URL = "https://foundry-b.example";
const b = captureEndpointConfiguration();
Bun.env.CLAUDE_CODE_USE_FOUNDRY = "0";
const disabled = captureEndpointConfiguration();
delete Bun.env.CLAUDE_CODE_USE_FOUNDRY;
delete Bun.env.FOUNDRY_BASE_URL;
const absent = captureEndpointConfiguration();
Bun.env.CLAUDE_CODE_USE_FOUNDRY = "0";
Bun.env.FOUNDRY_BASE_URL = "https://live-later.example";
Bun.env.ANTHROPIC_FOUNDRY_API_KEY = "current-foundry-a";
await send(model, a);
Bun.env.ANTHROPIC_FOUNDRY_API_KEY = "current-foundry-b";
await send(model, a);
await send(model, b, { apiKey: "explicit-key" });
Bun.env.CLAUDE_CODE_USE_FOUNDRY = "1";
Bun.env.ANTHROPIC_API_KEY = "current-standard-key";
await send(model, disabled);
await send(model, absent);
await send(model, undefined);
assert.deepEqual(requests.map(r => r.url), [
	"https://foundry-a.example/v1/messages", "https://foundry-a.example/v1/messages",
	"https://foundry-b.example/v1/messages", "https://explicit-model.example/v1/messages",
	"https://explicit-model.example/v1/messages", "https://live-later.example/v1/messages",
]);
assert.deepEqual(requests.map(r => r.apiKey), [
	"current-foundry-a", "current-foundry-b", "explicit-key",
	"current-standard-key", "current-standard-key", "current-foundry-b",
]);
assert.deepEqual(requests.map(r => r.authorization), [
	"Bearer current-foundry-a", "Bearer current-foundry-b", "Bearer explicit-key",
	"Bearer current-standard-key", "Bearer current-standard-key", "Bearer current-foundry-b",
]);
assert.deepEqual(requests.map(r => r.model), Array(6).fill(model.id));
`);
	});

	it("retains ZCode base URLs and captured absence without retaining its API key", async () => {
		await requestBoundaryIn(`
Bun.env.ZCODE_PLAN_ANTHROPIC_BASE_URL = "https://zcode-a.example/api/anthropic/";
Bun.env.GLM_ZCODE_API_KEY = "obsolete-zcode-key";
const a = captureEndpointConfiguration();
Bun.env.ZCODE_PLAN_ANTHROPIC_BASE_URL = "https://zcode-b.example/api/anthropic";
const b = captureEndpointConfiguration();
delete Bun.env.ZCODE_PLAN_ANTHROPIC_BASE_URL;
const absent = captureEndpointConfiguration();
Bun.env.ZCODE_PLAN_ANTHROPIC_BASE_URL = "https://zcode-live.example/api/anthropic";
Bun.env.GLM_ZCODE_API_KEY = "current-zcode-a";
await send(zcode, a);
Bun.env.GLM_ZCODE_API_KEY = "current-zcode-b";
await send(zcode, a);
await send(zcode, b, { apiKey: "explicit-zcode-key" });
await send(zcode, absent);
await send(zcode, undefined);
assert.deepEqual(requests.map(r => r.url), [
	"https://zcode-a.example/api/anthropic/v1/messages", "https://zcode-a.example/api/anthropic/v1/messages",
	"https://zcode-b.example/api/anthropic/v1/messages", "https://api.z.ai/api/anthropic/v1/messages",
	"https://zcode-live.example/api/anthropic/v1/messages",
]);
assert.deepEqual(requests.map(r => r.apiKey), [
	"current-zcode-a", "current-zcode-b", "explicit-zcode-key", "current-zcode-b", "current-zcode-b",
]);
assert.deepEqual(requests.map(r => r.authorization), [
	"Bearer current-zcode-a", "Bearer current-zcode-b", "Bearer explicit-zcode-key",
	"Bearer current-zcode-b", "Bearer current-zcode-b",
]);
assert.deepEqual(requests.map(r => r.model), Array(5).fill(model.id));
`);
	});

	it("preserves explicit SDK client/transport precedence and canonical OAuth auth", async () => {
		await requestBoundaryIn(`
Bun.env.CLAUDE_CODE_USE_FOUNDRY = "1";
Bun.env.FOUNDRY_BASE_URL = "https://captured-foundry.example";
const captured = captureEndpointConfiguration();
let ignoredTransportCalls = 0;
const client = new Anthropic({
	baseURL: "https://explicit-client.example", apiKey: "explicit-client-key",
	fetch: fetchOverride, maxRetries: 0,
});
await send(model, captured, {
	client, apiKey: "ignored-option-key",
	fetch: async () => { ignoredTransportCalls++; throw new Error("client transport must win"); },
});
assert.equal(ignoredTransportCalls, 0);
delete Bun.env.CLAUDE_CODE_USE_FOUNDRY;
delete Bun.env.FOUNDRY_BASE_URL;
const canonicalCapture = captureEndpointConfiguration();
Bun.env.CLAUDE_CODE_USE_FOUNDRY = "1";
Bun.env.FOUNDRY_BASE_URL = "https://live-untrusted-for-oauth.example";
await send({ ...model, baseUrl: "https://api.anthropic.com" }, canonicalCapture, {
	apiKey: "sk-ant-oat01-fixture-only", isOAuth: true,
});
assert.deepEqual(requests, [
	{ url: "https://explicit-client.example/v1/messages", apiKey: "explicit-client-key", authorization: null, model: model.id },
	{ url: "https://api.anthropic.com/v1/messages", apiKey: null, authorization: "Bearer sk-ant-oat01-fixture-only", model: model.id },
]);
`);
	});

	it("rejects forged and serialized handles synchronously before client or fetch access", async () => {
		await requestBoundaryIn(`
const captured = captureEndpointConfiguration();
let clientReads = 0;
let transportCalls = 0;
for (const invalid of [Object.freeze({}), JSON.parse(JSON.stringify(captured)), { ...captured }]) {
	const options = {
		endpointConfiguration: invalid,
		get client() { clientReads++; throw new Error("client accessed before validation"); },
		fetch: async () => { transportCalls++; throw new Error("transport accessed before validation"); },
	};
	assert.throws(() => streamAnthropic(model, context, options), /Invalid endpoint configuration handle/);
	assert.throws(() => buildAnthropicClientOptions({
		model, apiKey: "fixture-key", endpointConfiguration: invalid, fetch: options.fetch,
	}), /Invalid endpoint configuration handle/);
}
assert.equal(clientReads, 0);
assert.equal(transportCalls, 0);
assert.equal(requests.length, 0);
`);
	});
});

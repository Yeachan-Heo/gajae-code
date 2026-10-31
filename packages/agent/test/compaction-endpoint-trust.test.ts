import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The remote-compaction endpoint is built from `OPENAI_BASE_URL` and carries the
 * OpenAI credential. `Bun.env === process.env`, and the env module merges the
 * caller's `cwd/.env` into it, so without a trust boundary a repository could
 * plant `.env` and have compaction requests delivered to an endpoint of its
 * choosing.
 *
 * `projectEnv` is parsed at module load from `process.cwd()`, so these drive a
 * child process with a controlled cwd.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "compaction-endpoint-probe.ts");
const tempDirs: string[] = [];

function projectDir(dotenv?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-compaction-endpoint-trust-"));
	tempDirs.push(dir);
	if (dotenv !== undefined) fs.writeFileSync(path.join(dir, ".env"), dotenv);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function endpointIn(cwd: string, overrides: Record<string, string> = {}): Promise<string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	// Never let the outer environment leak an endpoint override into the child.
	delete env.OPENAI_BASE_URL;
	const home = path.join(cwd, ".home");
	fs.mkdirSync(home, { recursive: true });
	env.HOME = home;
	env.USERPROFILE = home;
	env.GJC_CODING_AGENT_DIR = path.join(home, "agent");
	delete env.PI_CODING_AGENT_DIR;
	delete env.GJC_CONFIG_DIR;
	delete env.PI_CONFIG_DIR;
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return (JSON.parse(stdout.trim()) as { endpoint: string }).endpoint;
}

async function routingScenario(body: string, dotenv?: string): Promise<void> {
	const cwd = projectDir(dotenv);
	const home = path.join(cwd, ".home");
	fs.mkdirSync(home);
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: home,
		USERPROFILE: home,
		GJC_CONFIG_DIR: path.join(home, "config"),
		GJC_CODING_AGENT_DIR: path.join(home, "agent"),
	};
	const root = path.resolve(import.meta.dir, "../../..");
	const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(path.join(root, name)).href);
	const script = `
import assert from "node:assert/strict";
import { captureEndpointConfiguration, hookFetch } from ${moduleUrl("packages/utils/src/index.ts")};
import { compact, generateSummary, generateHandoff } from ${moduleUrl("packages/agent/src/compaction/compaction.ts")};
import { generateBranchSummary } from ${moduleUrl("packages/agent/src/compaction/branch-summarization.ts")};
import { requestOpenAiRemoteCompaction, getPreservedOpenAiRemoteCompactionData } from ${moduleUrl("packages/agent/src/compaction/openai.ts")};
import { completeSimple } from ${moduleUrl("packages/ai/src/index.ts")};
const model = {
 id: "gpt-4o", name: "fixture", api: "openai-completions", provider: "openai",
 baseUrl: "https://api.openai.com/v1", reasoning: false, input: ["text"],
 cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
};
const messages = [{ role: "user", content: "retain this", timestamp: 1 }];
const preparation = () => ({
 firstKeptEntryId: "kept", messagesToSummarize: [], turnPrefixMessages: [], recentMessages: messages,
 isSplitTurn: false, tokensBefore: 1, previousSummary: "existing summary",
 fileOps: { read: new Set(), written: new Set(), edited: new Set() },
 settings: { enabled: true, reserveTokens: 1024, keepRecentTokens: 1024, remoteEnabled: true },
 tokenCorrection: { ratio: 1, keepRecentTokensCorrected: 0 },
});
const requests = [];
let failNative = false;
using hook = hookFetch(async (input, init) => {
 const request = input instanceof Request ? input : new Request(String(input), init);
 requests.push({ url: request.url, authorization: request.headers.get("authorization") });
 if (request.url.includes("/responses/compact")) {
  return failNative ? new Response("unavailable", { status: 503 }) : Response.json({ output: [{ type: "compaction_summary", summary: "remote preserve summary" }] });
 }
 if (request.url.endsWith("/generic")) return Response.json({ summary: "generic summary" });
 const chunk = { id: "fixture", object: "chat.completion.chunk", created: 1, model: model.id,
  choices: [{ index: 0, delta: { role: "assistant", content: "maintenance summary" }, finish_reason: null }] };
 const done = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
 return new Response("data: " + JSON.stringify(chunk) + "\\n\\ndata: " + JSON.stringify(done) + "\\n\\ndata: [DONE]\\n\\n", { headers: { "content-type": "text/event-stream" } });
});
const native = (endpointConfiguration, apiKey = "current-key", override = {}) => requestOpenAiRemoteCompaction(
 { ...model, ...override }, apiKey, [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
 "compact", undefined, { endpointConfiguration },
);
${body}
`;
	const child = Bun.spawn([process.execPath, "--eval", script], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	expect(await child.exited, `${stdout}\n${stderr}`).toBe(0);
}

describe("remote compaction endpoint trust boundary", () => {
	it("retains routing and captured absence without freezing live credentials or omitted scopes", async () => {
		await routingScenario(
			`
const absent = captureEndpointConfiguration();
Bun.env.OPENAI_BASE_URL = "https://retained.example/v1";
const retained = captureEndpointConfiguration();
Bun.env.OPENAI_BASE_URL = "https://live.example/v1";
await native(absent);
await native(retained, "rotated-one");
await native(retained, "rotated-two");
await native(undefined);
assert.deepEqual(requests, [
 { url: "https://api.openai.com/v1/responses/compact", authorization: "Bearer current-key" },
 { url: "https://retained.example/v1/responses/compact", authorization: "Bearer rotated-one" },
 { url: "https://retained.example/v1/responses/compact", authorization: "Bearer rotated-two" },
 { url: "https://live.example/v1/responses/compact", authorization: "Bearer current-key" },
]);
`,
			"OPENAI_BASE_URL=https://attacker.example/v1\n",
		);
	});

	it("uses identical provider/native routing for canonical, explicit-port and lookalike URLs", async () => {
		await routingScenario(`
Bun.env.OPENAI_BASE_URL = "https://retained.example/v1";
const endpointConfiguration = captureEndpointConfiguration();
Bun.env.OPENAI_BASE_URL = "https://live.example/v1";
for (const [baseUrl, expected] of [
 ["https://API.OPENAI.COM/v1/", "https://retained.example/v1"],
 ["https://api.openai.com:8443/v1", "https://api.openai.com:8443/v1"],
 ["https://proxy.example/api.openai.com/v1", "https://proxy.example/api.openai.com/v1"],
 ["https://api.openai.com.proxy.example/v1", "https://api.openai.com.proxy.example/v1"],
]) {
 await completeSimple({ ...model, baseUrl }, { messages }, { apiKey: "provider-key", endpointConfiguration });
 await native(endpointConfiguration, "native-key", { baseUrl });
 assert.deepEqual(requests.splice(0).map(request => request.url), [expected + "/chat/completions", expected + "/responses/compact"]);
}
await requestOpenAiRemoteCompaction({ ...model, baseUrl: "https://explicit.example/v1" }, "oauth-key", [], "compact", undefined,
 { authCredentialType: "oauth", endpointConfiguration });
assert.deepEqual(requests, [{ url: "https://api.openai.com/v1/responses/compact", authorization: "Bearer oauth-key" }]);
`);
	});

	it("propagates retained routing through native maintenance, split summaries, fallback, handoff and branch summary", async () => {
		await routingScenario(`
Bun.env.OPENAI_BASE_URL = "https://retained.example/v1";
const endpointConfiguration = captureEndpointConfiguration();
Bun.env.OPENAI_BASE_URL = "https://live.example/v1";
const options = { endpointConfiguration, maintenanceCall: true, sessionId: "session", providerSessionId: "provider-session" };
const result = await compact(preparation(), model, "current-key", undefined, undefined, options);
assert.equal(result.summary, "existing summary");
assert.deepEqual(getPreservedOpenAiRemoteCompactionData(result.preserveData).compactionItem,
 { type: "compaction_summary", summary: "remote preserve summary" });
assert.equal(getPreservedOpenAiRemoteCompactionData(result.preserveData).replacementHistory.length, 1);
failNative = true;
const split = preparation();
split.messagesToSummarize = messages;
split.turnPrefixMessages = messages;
split.isSplitTurn = true;
const health = [];
const fallback = await compact(split, model, "current-key", undefined, undefined,
 { ...options, remoteCompactionFallbackHealth: { recordRemoteCompactionFallback: event => health.push(event) } });
assert.match(fallback.summary, /maintenance summary/);
assert.equal(health[0].kind, "fallback");
assert.equal(await generateSummary(messages, model, 1024, "current-key", undefined, undefined, undefined, options), "maintenance summary");
assert.equal(await generateHandoff(messages, model, "current-key", { ...options, systemPrompt: ["fixture"] }), "maintenance summary");
const branch = await generateBranchSummary([{ type: "message", id: "entry", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: messages[0] }],
 { ...options, model, apiKey: "current-key", signal: new AbortController().signal });
assert.match(branch.summary, /maintenance summary/);
assert.equal(requests.length, 7);
assert.ok(requests.every(request => request.url.startsWith("https://retained.example/v1/")));
assert.ok(requests.every(request => request.authorization === "Bearer current-key"));
assert.equal(await generateSummary(messages, model, 1024, "current-key", undefined, undefined, undefined,
 { ...options, remoteEndpoint: "https://generic.example/generic" }), "generic summary");
assert.equal(requests.at(-1).url, "https://generic.example/generic");
`);
	});

	it("keeps OAuth canonical through native fallback, disabled remote, split summary, handoff and branch maintenance", async () => {
		await routingScenario(`
Bun.env.OPENAI_BASE_URL = "https://captured-custom.example/v1";
const endpointConfiguration = captureEndpointConfiguration();
delete Bun.env.OPENAI_BASE_URL;
const options = { endpointConfiguration, authCredentialType: "oauth", maintenanceCall: true };
failNative = true;
for (const remoteEnabled of [true, false]) {
 const split = preparation();
 split.settings.remoteEnabled = remoteEnabled;
 split.messagesToSummarize = messages;
 split.turnPrefixMessages = messages;
 split.isSplitTurn = true;
 const result = await compact(split, model, "fixture-oauth", undefined, undefined, options);
 assert.match(result.summary, /maintenance summary/);
}
assert.equal(await generateSummary(messages, model, 1024, "fixture-oauth", undefined, undefined, undefined, options), "maintenance summary");
assert.equal(await generateHandoff(messages, model, "fixture-oauth", { ...options, systemPrompt: ["fixture"] }), "maintenance summary");
const branch = await generateBranchSummary([{ type: "message", id: "entry", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: messages[0] }],
 { ...options, model, apiKey: "fixture-oauth", signal: new AbortController().signal });
assert.match(branch.summary, /maintenance summary/);
assert.equal(requests.length, 8);
assert.ok(requests.every(request => request.url.startsWith("https://api.openai.com/v1/")), JSON.stringify(requests.map(request => request.url)));
assert.ok(requests.every(request => request.authorization === "Bearer fixture-oauth"));
`);
	});

	it("preserves query routing when appending native compaction paths", async () => {
		await routingScenario(`
Bun.env.OPENAI_BASE_URL = "https://retained.example/v1?route=tenant%2Fone";
const endpointConfiguration = captureEndpointConfiguration();
delete Bun.env.OPENAI_BASE_URL;
await native(endpointConfiguration);
await native(endpointConfiguration, "key", { baseUrl: "https://explicit.example/v1/?route=two" });
await native(endpointConfiguration, "key", { provider: "openai-codex", baseUrl: "https://codex.example/backend-api/codex?route=three" });
assert.deepEqual(requests.map(request => request.url), [
 "https://retained.example/v1/responses/compact?route=tenant%2Fone",
 "https://explicit.example/v1/responses/compact?route=two",
 "https://codex.example/backend-api/codex/responses/compact?route=three",
]);
`);
	});

	it("rejects forged handles before fetch, conversion, generic routes and empty early returns", async () => {
		await routingScenario(`
const endpointConfiguration = Object.freeze({});
let conversions = 0;
const convertToLlm = () => { conversions++; throw new Error("conversion must not run"); };
const options = { endpointConfiguration, convertToLlm, remoteEndpoint: "https://generic.example/generic" };
for (const call of [
 () => compact(preparation(), model, "key", undefined, undefined, options),
 () => native(endpointConfiguration),
 () => native(endpointConfiguration, "key", { provider: "openai-codex" }),
 () => generateSummary(messages, model, 1024, "key", undefined, undefined, undefined, options),
 () => generateHandoff(messages, model, "key", { ...options, systemPrompt: [] }),
 () => generateBranchSummary([], { ...options, model, apiKey: "key", signal: new AbortController().signal }),
]) await assert.rejects(call, /Invalid endpoint configuration handle/);
assert.equal(conversions, 0);
assert.equal(requests.length, 0);
`);
	});

	it("uses the hosted default when nothing sets a base URL", async () => {
		expect(await endpointIn(projectDir())).toStartWith("https://api.openai.com/");
	});

	it("ignores an OPENAI_BASE_URL planted by the project .env", async () => {
		const cwd = projectDir("OPENAI_BASE_URL=https://attacker.example/v1\n");
		const endpoint = await endpointIn(cwd);
		expect(endpoint).not.toContain("attacker.example");
		expect(endpoint).toStartWith("https://api.openai.com/");
	});

	it("still honors an inherited OPENAI_BASE_URL", async () => {
		const endpoint = await endpointIn(projectDir(), { OPENAI_BASE_URL: "https://gateway.internal/v1" });
		expect(endpoint).toStartWith("https://gateway.internal/v1");
	});

	it("does not let the project .env override an inherited base URL", async () => {
		const cwd = projectDir("OPENAI_BASE_URL=https://attacker.example/v1\n");
		const endpoint = await endpointIn(cwd, { OPENAI_BASE_URL: "https://gateway.internal/v1" });
		expect(endpoint).toStartWith("https://gateway.internal/v1");
	});
});

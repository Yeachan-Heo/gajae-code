import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isDefaultOpenAIBaseUrl } from "@gajae-code/utils";

describe("isDefaultOpenAIBaseUrl", () => {
	it.each([
		["https://api.openai.com/v1", true],
		["https://api.openai.com", true],
		["https://api.openai.com/", true],
		["HTTPS://API.OPENAI.COM/v1", true],
		["https://api.openai.com:443/v1", true],
		["https://api.openai.com:8443/v1", false],
		["https://custom.example/v1", false],
		["https://api.openai.com/custom/v1", false],
		["not a URL", false],
	] as const)("classifies %s as %s", (url, expected) => {
		expect(isDefaultOpenAIBaseUrl(url)).toBe(expected);
	});
});

describe("OpenAI endpoint routing", () => {
	it("preserves an explicit custom port despite a captured proxy", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "openai-endpoint-port-"));
		try {
			const script = `
import { captureEndpointConfiguration } from ${JSON.stringify(import.meta.resolve("@gajae-code/utils"))};
import { streamSimple } from ${JSON.stringify(new URL("../src/stream.ts", import.meta.url).pathname)};
import { streamOpenAIResponses } from ${JSON.stringify(new URL("../src/providers/openai-responses.ts", import.meta.url).pathname)};
import { streamOpenAICompletions } from ${JSON.stringify(new URL("../src/providers/openai-completions.ts", import.meta.url).pathname)};
import { strict as assert } from "node:assert";
Bun.env.OPENAI_BASE_URL = "https://captured-proxy.example/v1";
const endpointConfiguration = captureEndpointConfiguration();
Bun.env.OPENAI_BASE_URL = "https://later-proxy.example/v1";
const requests = [];
const authorizations = [];
const models = [];
const customFetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  requests.push(request.url);
  authorizations.push(request.headers.get("authorization"));
  models.push((await request.json()).model);
  const completions = request.url.includes("chat/completions");
  const event = completions
    ? { id: "chat_port", object: "chat.completion.chunk", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }
    : { type: "response.completed", response: { id: "resp_port", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0 } } };
  return new Response("data: " + JSON.stringify(event) + "\\n\\n" + (completions ? "data: [DONE]\\n\\n" : ""), { headers: { "content-type": "text/event-stream" } });
};
globalThis.fetch = async () => { throw new Error("explicit fetch was bypassed"); };
for (const [api, stream] of [["openai-responses", streamOpenAIResponses], ["openai-completions", streamOpenAICompletions]]) {
  const model = { id: "gpt-4o-mini", name: "port", api, provider: "openai", baseUrl: "https://api.openai.com:8443/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
  const result = await stream(model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, { endpointConfiguration, apiKey: "test-key", fetch: customFetch, requestMaxRetries: 0 }).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
}
assert.deepEqual(requests, ["https://api.openai.com:8443/v1/responses", "https://api.openai.com:8443/v1/chat/completions"]);
for (const [api, stream] of [["openai-responses", streamOpenAIResponses], ["openai-completions", streamOpenAICompletions]]) {
  const model = { id: "gpt-4o-mini", name: "routing", api, provider: "openai", baseUrl: "HTTPS://API.OPENAI.COM/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
  const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
  const suffix = api === "openai-responses" ? "/responses" : "/chat/completions";
  const start = requests.length;
  async function send(handle, extra = {}, simple = false) {
    const result = await (simple ? streamSimple : stream)(model, context, { endpointConfiguration: handle, fetch: customFetch, requestMaxRetries: 0, ...extra }).result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
  }
  Bun.env.OPENAI_API_KEY = "live-key-a";
  await send(endpointConfiguration, {}, true);
  Bun.env.OPENAI_API_KEY = "live-key-b";
  await send(endpointConfiguration);
  const later = captureEndpointConfiguration();
  await send(later);
  delete Bun.env.OPENAI_BASE_URL;
  const absent = captureEndpointConfiguration();
  Bun.env.OPENAI_BASE_URL = "https://later-proxy.example/v1";
  await send(absent);
  await send(undefined);
  await send(endpointConfiguration, { apiKey: "oauth-token", authCredentialType: "oauth" });
  assert.deepEqual(requests.slice(start), ["https://captured-proxy.example/v1" + suffix, "https://captured-proxy.example/v1" + suffix, "https://later-proxy.example/v1" + suffix, "https://api.openai.com/v1" + suffix, "https://later-proxy.example/v1" + suffix, "https://api.openai.com/v1" + suffix]);
  assert.deepEqual(authorizations.slice(start), ["Bearer live-key-a", "Bearer live-key-b", "Bearer live-key-b", "Bearer live-key-b", "Bearer live-key-b", "Bearer oauth-token"]);
  const oauthResult = await stream({ ...model, baseUrl: "https://explicit.example:8443/v1" }, context, { endpointConfiguration, apiKey: "oauth-explicit-token", authCredentialType: "oauth", fetch: customFetch, requestMaxRetries: 0 }).result();
  assert.equal(oauthResult.stopReason, "stop", oauthResult.errorMessage);
  assert.equal(requests.at(-1), "https://api.openai.com/v1" + suffix);
  const count = requests.length;
  for (const extra of [{}, { authCredentialType: "oauth" }]) {
    assert.throws(() => stream(model, context, { endpointConfiguration: Object.freeze({}), apiKey: "forged", fetch: customFetch, ...extra }), /Invalid endpoint configuration handle/);
  }
  assert.equal(requests.length, count);
}
assert.equal(models.length, requests.length);
assert.ok(models.every(model => model === "gpt-4o-mini"));
`;
			const child = Bun.spawn([process.execPath, "--eval", script], {
				cwd: home,
				env: {
					PATH: Bun.env.PATH ?? "",
					HOME: home,
					USERPROFILE: home,
					GJC_CONFIG_DIR: path.join(home, "config"),
					GJC_CODING_AGENT_DIR: path.join(home, "agent"),
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
		} finally {
			await fs.rm(home, { recursive: true, force: true });
		}
	});
});

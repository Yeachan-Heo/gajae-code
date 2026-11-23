import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { captureEndpointConfiguration, type EndpointConfiguration } from "@gajae-code/utils";
import { CustomApiRegistry } from "../src/api-registry";
import { complete, completeSimple, getEnvApiKey, stream, streamSimple } from "../src/stream";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, StreamOptions } from "../src/types";
import { AssistantMessageEventStream } from "../src/utils/event-stream";

const context: Context = { messages: [] };

function customModel(): Model<Api> {
	return {
		id: "endpoint-dispatch-model",
		name: "Endpoint dispatch model",
		api: "endpoint-dispatch-test",
		provider: "openai",
		baseUrl: "https://dispatch.invalid/v1",
		reasoning: false,
		input: ["text"],
		output: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
}

function customResult(model: Model<Api>, text: string): AssistantMessageEventStream {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
	const events = new AssistantMessageEventStream();
	events.push({ type: "start", partial: message });
	events.push({ type: "done", reason: "stop", message });
	events.end(message);
	return events;
}

async function consume(events: AssistantMessageEventStream): Promise<AssistantMessage> {
	const types: string[] = [];
	for await (const event of events) types.push(event.type);
	expect(types).toEqual(["start", "done"]);
	return events.result();
}

describe("endpoint configuration dispatch boundaries", () => {
	it("passes the original capture and options through stream, complete, streamSimple and completeSimple", async () => {
		const endpointConfiguration = captureEndpointConfiguration();
		const registry = new CustomApiRegistry();
		const model = customModel();
		const seen: Array<{ kind: string; model: Model<Api>; context: Context; options: StreamOptions | undefined }> = [];
		registry.register(
			model.api,
			(receivedModel, receivedContext, options) => {
				seen.push({ kind: "simple", model: receivedModel, context: receivedContext, options });
				return customResult(receivedModel, `simple-${seen.length}`);
			},
			"endpoint-configuration-test",
			(receivedModel, receivedContext, options) => {
				seen.push({ kind: "generic", model: receivedModel, context: receivedContext, options });
				return customResult(receivedModel, `generic-${seen.length}`);
			},
		);
		const options: SimpleStreamOptions = {
			endpointConfiguration,
			customApiRegistry: registry,
			apiKey: "deterministic-test-key",
			temperature: 0.25,
			maxTokens: 128,
		};
		try {
			const results = [
				await consume(stream(model, context, options)),
				await complete(model, context, options),
				await consume(streamSimple(model, context, options)),
				await completeSimple(model, context, options),
			];
			expect(results.map(result => result.content)).toEqual([
				[{ type: "text", text: "generic-1" }],
				[{ type: "text", text: "generic-2" }],
				[{ type: "text", text: "simple-3" }],
				[{ type: "text", text: "simple-4" }],
			]);
			expect(seen.map(call => call.kind)).toEqual(["generic", "generic", "simple", "simple"]);
			for (const call of seen) {
				expect(call.model).toBe(model);
				expect(call.context).toBe(context);
				expect(call.options?.endpointConfiguration).toBe(endpointConfiguration);
				expect(call.options?.customApiRegistry).toBe(registry);
				expect(call.options?.apiKey).toBe("deterministic-test-key");
				expect(call.options?.temperature).toBe(0.25);
				expect(call.options?.maxTokens).toBe(128);
			}
		} finally {
			registry.dispose();
		}
	});

	it("rejects forged, spread and serialized captures before callbacks or API-key preflight", async () => {
		const captured = captureEndpointConfiguration();
		const handles: unknown[] = [{}, { ...captured }, JSON.parse(JSON.stringify(captured)), structuredClone(captured)];
		const registry = new CustomApiRegistry();
		const model = customModel();
		let callbacks = 0;
		let apiKeyReads = 0;
		let authCallbacks = 0;
		registry.register(
			model.api,
			receivedModel => {
				callbacks += 1;
				return customResult(receivedModel, "unexpected-simple");
			},
			undefined,
			receivedModel => {
				callbacks += 1;
				return customResult(receivedModel, "unexpected-generic");
			},
		);
		try {
			for (const handle of handles) {
				const options: SimpleStreamOptions = {
					endpointConfiguration: handle as EndpointConfiguration,
					customApiRegistry: registry,
					get apiKey(): string {
						apiKeyReads += 1;
						throw new Error("API-key preflight must not run");
					},
					onAuthError: async () => {
						authCallbacks += 1;
						return "unexpected-refreshed-key";
					},
				};
				expect(() => stream(model, context, options)).toThrow("Invalid endpoint configuration handle");
				await expect(complete(model, context, options)).rejects.toThrow("Invalid endpoint configuration handle");
				expect(() => streamSimple(model, context, options)).toThrow("Invalid endpoint configuration handle");
				await expect(completeSimple(model, context, options)).rejects.toThrow(
					"Invalid endpoint configuration handle",
				);
				expect(() => getEnvApiKey("openai", handle as EndpointConfiguration)).toThrow(
					"Invalid endpoint configuration handle",
				);
			}
			expect(callbacks).toBe(0);
			expect(apiKeyReads).toBe(0);
			expect(authCallbacks).toBe(0);
		} finally {
			registry.dispose();
		}
	});

	it("captures routing presence and absence without freezing live credentials or consulting project secrets", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-endpoint-dispatch-"));
		const home = path.join(root, "home");
		const cwd = path.join(root, "project");
		const agent = path.join(home, ".gjc", "agent");
		try {
			await fs.mkdir(agent, { recursive: true });
			await fs.mkdir(cwd);
			await Bun.write(
				path.join(cwd, ".env"),
				"OPENAI_API_KEY=project-secret\nPROJECT_BASE_URL=https://project.invalid\n",
			);
			const source = `
import assert from "node:assert/strict";
import { captureEndpointConfiguration, readEndpointConfiguration } from ${JSON.stringify(path.resolve(import.meta.dir, "../../utils/src/env.ts"))};
import { complete, completeSimple, getEnvApiKey, getEnvApiKeyEnvNames, getEnvApiKeyEnvName, getEnvApiKeyCredentialSource, getEnvApiKeyCredentialSources, getGoogleVertexCredentialSource, stream, streamSimple } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/stream.ts"))};

const absent = captureEndpointConfiguration();
assert.equal(getEnvApiKey("openai", absent), undefined);
const model = ${JSON.stringify({ ...customModel(), api: "openai-completions" })};
const context = { messages: [] };
const options = { endpointConfiguration: absent };
assert.throws(() => stream(model, context, options), /No API key for provider: openai/);
await assert.rejects(complete(model, context, options), /No API key for provider: openai/);
assert.throws(() => streamSimple(model, context, options), /No API key for provider: openai/);
await assert.rejects(completeSimple(model, context, options), /No API key for provider: openai/);

Bun.env.GOOGLE_CLOUD_PROJECT = "project-a";
Bun.env.ISOLATED_BASE_URL = "https://captured.invalid/v1";
Bun.env.AZURE_OPENAI_API_VERSION = "captured-version";
Bun.env.OPENAI_API_KEY = "live-key-a";
const captured = captureEndpointConfiguration();
Bun.env.GOOGLE_CLOUD_PROJECT = "project-b";
Bun.env.ISOLATED_BASE_URL = "https://live.invalid/v1";
Bun.env.AZURE_OPENAI_API_VERSION = "live-version";
Bun.env.OPENAI_API_KEY = "live-key-b";

assert.equal(Object.isFrozen(captured), true);
assert.deepEqual(Reflect.ownKeys(captured), []);
assert.throws(() => readEndpointConfiguration(captured, "OPENAI_API_KEY"), /Not an endpoint-routing environment variable/);

Bun.env.CLAUDE_CODE_USE_FOUNDRY = "0";
const foundryDisabled = captureEndpointConfiguration();
Bun.env.CLAUDE_CODE_USE_FOUNDRY = "1";
Bun.env.ANTHROPIC_FOUNDRY_API_KEY = "foundry-key-before-rotation";
const foundryEnabled = captureEndpointConfiguration();
Bun.env.CLAUDE_CODE_USE_FOUNDRY = "0";
Bun.env.ANTHROPIC_FOUNDRY_API_KEY = "foundry-key-after-rotation";
Bun.env.ANTHROPIC_OAUTH_TOKEN = "anthropic-live-oauth";
Bun.env.ANTHROPIC_API_KEY = "anthropic-live-api-key";
assert.equal(getEnvApiKey("anthropic", foundryEnabled), "foundry-key-after-rotation");
assert.equal(getEnvApiKey("anthropic", foundryDisabled), "anthropic-live-oauth");
assert.equal(getEnvApiKey("anthropic"), "anthropic-live-oauth");
for (const [handle, expectedNames] of [
  [foundryEnabled, ["ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]],
  [foundryDisabled, ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]],
]) {
  assert.deepEqual(getEnvApiKeyEnvNames("anthropic", handle), expectedNames);
  assert.equal(await getEnvApiKeyEnvName("anthropic", handle), expectedNames[0]);
  assert.deepEqual(await getEnvApiKeyCredentialSources("anthropic", { endpointConfiguration: handle }),
    expectedNames.map(name => ({ kind: "environment", name })));
  assert.deepEqual(await getEnvApiKeyCredentialSource("anthropic", { endpointConfiguration: handle }),
    { kind: "environment", name: expectedNames[0] });
}

let fetchCalls = 0;
const forbiddenFetch = async () => {
  fetchCalls += 1;
  throw new Error("Diagnostic credential fetch must not run for forged handles");
};
for (const forged of [{}, { ...foundryEnabled }, JSON.parse(JSON.stringify(foundryEnabled))]) {
  assert.throws(() => getEnvApiKeyEnvNames("anthropic", forged), /Invalid endpoint configuration handle/);
  await assert.rejects(getEnvApiKeyEnvName("anthropic", forged), /Invalid endpoint configuration handle/);
  for (const provider of ["anthropic", "amazon-bedrock", "google-vertex"]) {
    const options = { endpointConfiguration: forged, fetch: forbiddenFetch };
    await assert.rejects(getEnvApiKeyCredentialSource(provider, options), /Invalid endpoint configuration handle/);
    await assert.rejects(getEnvApiKeyCredentialSources(provider, options), /Invalid endpoint configuration handle/);
  }
  await assert.rejects(getGoogleVertexCredentialSource({ endpointConfiguration: forged, fetch: forbiddenFetch }),
    /Invalid endpoint configuration handle/);
}
assert.equal(fetchCalls, 0);
console.log(JSON.stringify({
  absentProject: readEndpointConfiguration(absent, "GOOGLE_CLOUD_PROJECT") ?? null,
  absentBaseUrl: readEndpointConfiguration(absent, "ISOLATED_BASE_URL") ?? null,
  rejectedProjectBaseUrl: readEndpointConfiguration(absent, "PROJECT_BASE_URL") ?? null,
  capturedProject: readEndpointConfiguration(captured, "GOOGLE_CLOUD_PROJECT"),
  capturedBaseUrl: readEndpointConfiguration(captured, "ISOLATED_BASE_URL"),
  capturedVersion: readEndpointConfiguration(captured, "AZURE_OPENAI_API_VERSION"),
  liveProject: readEndpointConfiguration(undefined, "GOOGLE_CLOUD_PROJECT"),
  liveBaseUrl: readEndpointConfiguration(undefined, "ISOLATED_BASE_URL"),
  liveVersion: readEndpointConfiguration(undefined, "AZURE_OPENAI_API_VERSION"),
  keyThroughAbsent: getEnvApiKey("openai", absent),
  keyThroughCaptured: getEnvApiKey("openai", captured),
}));
`;
			const child = Bun.spawn([process.execPath, "--no-env-file", "-e", source], {
				cwd,
				env: {
					PATH: process.env.PATH ?? "/usr/bin:/bin",
					HOME: home,
					USERPROFILE: home,
					GJC_CODING_AGENT_DIR: agent,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
			expect(JSON.parse(stdout)).toEqual({
				absentProject: null,
				absentBaseUrl: null,
				rejectedProjectBaseUrl: null,
				capturedProject: "project-a",
				capturedBaseUrl: "https://captured.invalid/v1",
				capturedVersion: "captured-version",
				liveProject: "project-b",
				liveBaseUrl: "https://live.invalid/v1",
				liveVersion: "live-version",
				keyThroughAbsent: "live-key-b",
				keyThroughCaptured: "live-key-b",
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

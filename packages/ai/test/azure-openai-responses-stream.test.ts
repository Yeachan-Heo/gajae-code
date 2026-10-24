import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AzureOpenAIResponsesOptions, streamAzureOpenAIResponses } from "../src/providers/azure-openai-responses";
import { getEnvApiKey } from "../src/stream";
import type { Context, Model, Tool } from "../src/types";
import { classifyFallbackTrigger } from "../src/utils/fallback-transport";

const originalFetch = global.fetch;

const azureModel: Model<"azure-openai-responses"> = {
	id: "gpt-5-mini",
	name: "GPT-5 Mini",
	api: "azure-openai-responses",
	provider: "azure",
	baseUrl: "https://example.openai.azure.com/openai/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const firstClassAzureModel: Model<"azure-openai-responses"> = {
	...azureModel,
	id: "gpt-4.1",
	name: "GPT-4.1",
	provider: "azure-openai",
};

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function createSseResponse(events: unknown[]): Response {
	const sse = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(sse));
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createAssistantMessage(text: string, textSignature?: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text, ...(textSignature ? { textSignature } : {}) }],
		api: "azure-openai-responses" as const,
		provider: "azure" as const,
		model: "gpt-5-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

async function captureAzurePayload(
	context: Context,
	model: Model<"azure-openai-responses"> = azureModel,
	options: Partial<AzureOpenAIResponsesOptions> = {},
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamAzureOpenAIResponses(model, context, {
		apiKey: "test-key",
		azureBaseUrl: model.baseUrl,
		azureApiVersion: "v1",
		...options,
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload as Record<string, unknown>),
	});
	return promise;
}

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("azure openai first-class provider auth", () => {
	it("resolves azure-openai provider ids from AZURE_OPENAI_API_KEY", () => {
		const originalApiKey = Bun.env.AZURE_OPENAI_API_KEY;
		try {
			Bun.env.AZURE_OPENAI_API_KEY = "azure-test-key";
			expect(getEnvApiKey("azure-openai")).toBe("azure-test-key");
		} finally {
			if (originalApiKey === undefined) delete Bun.env.AZURE_OPENAI_API_KEY;
			else Bun.env.AZURE_OPENAI_API_KEY = originalApiKey;
		}
	});

	it("uses AZURE_OPENAI_API_KEY for first-class azure-openai/gpt-* stream auth", async () => {
		const originalApiKey = Bun.env.AZURE_OPENAI_API_KEY;
		try {
			Bun.env.AZURE_OPENAI_API_KEY = "azure-env-key";
			const payload = await captureAzurePayload(
				{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
				firstClassAzureModel,
				{},
			);

			expect(payload.model).toBe("gpt-4.1");
			expect(getEnvApiKey(firstClassAzureModel.provider)).toBe("azure-env-key");
		} finally {
			if (originalApiKey === undefined) delete Bun.env.AZURE_OPENAI_API_KEY;
			else Bun.env.AZURE_OPENAI_API_KEY = originalApiKey;
		}
	});
});

describe("azure openai responses streaming", () => {
	it("retains Azure routing and absence through SDK requests without retaining credentials", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "azure-endpoint-retention-"));
		try {
			const script = `
import { captureEndpointConfiguration } from ${JSON.stringify(import.meta.resolve("@gajae-code/utils"))};
import { streamAzureOpenAIResponses } from ${JSON.stringify(new URL("../src/providers/azure-openai-responses.ts", import.meta.url).pathname)};
import { streamSimple } from ${JSON.stringify(new URL("../src/stream.ts", import.meta.url).pathname)};
import { strict as assert } from "node:assert";
const model = ${JSON.stringify(firstClassAzureModel)};
const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
const requests = [];
const customFetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  requests.push({ url: request.url, key: request.headers.get("api-key"), body: await request.json() });
  return new Response("data: " + JSON.stringify({ type: "response.completed", response: { id: "resp_azure", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0 } } }) + "\\n\\n", { headers: { "content-type": "text/event-stream" } });
};
globalThis.fetch = async () => { throw new Error("custom fetch bypassed"); };
const keys = ["AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_RESOURCE_NAME", "AZURE_OPENAI_DEPLOYMENT_NAME_MAP", "AZURE_OPENAI_API_VERSION"];
Bun.env.AZURE_OPENAI_RESOURCE_NAME = "captured-resource";
Bun.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = "gpt-4.1=captured-deployment";
Bun.env.AZURE_OPENAI_API_VERSION = "2025-01-01";
Bun.env.AZURE_OPENAI_API_KEY = "old-key";
const captured = captureEndpointConfiguration();
Bun.env.AZURE_OPENAI_BASE_URL = "https://later.azure.example/openai/v1";
Bun.env.AZURE_OPENAI_RESOURCE_NAME = "later-resource";
Bun.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = "gpt-4.1=later-deployment";
Bun.env.AZURE_OPENAI_API_VERSION = "2026-02-02";
const later = captureEndpointConfiguration();
async function send(endpointConfiguration, extra = {}, simple = true) {
  const result = await (simple ? streamSimple : streamAzureOpenAIResponses)(model, context, { endpointConfiguration, fetch: customFetch, requestMaxRetries: 0, ...extra }).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
}
Bun.env.AZURE_OPENAI_API_KEY = "live-key-a";
await send(captured);
Bun.env.AZURE_OPENAI_API_KEY = "live-key-b";
await send(captured);
await send(later);
for (const key of keys) delete Bun.env[key];
const absent = captureEndpointConfiguration();
Bun.env.AZURE_OPENAI_BASE_URL = "https://must-not-inherit.example/openai/v1";
Bun.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = "gpt-4.1=must-not-inherit";
Bun.env.AZURE_OPENAI_API_VERSION = "2099-01-01";
await send(absent);
await send(captured, { apiKey: "explicit-key", azureBaseUrl: "https://explicit.azure.example:8443/openai/v1", azureDeploymentName: "explicit-deployment", azureApiVersion: "2028-04-04" }, false);
assert.deepEqual(requests.map(r => new URL(r.url).origin), ["https://captured-resource.openai.azure.com", "https://captured-resource.openai.azure.com", "https://later.azure.example", "https://example.openai.azure.com", "https://explicit.azure.example:8443"]);
assert.deepEqual(requests.map(r => new URL(r.url).searchParams.get("api-version")), ["2025-01-01", "2025-01-01", "2026-02-02", "v1", "2028-04-04"]);
assert.deepEqual(requests.map(r => r.body.model), ["captured-deployment", "captured-deployment", "later-deployment", "gpt-4.1", "explicit-deployment"]);
assert.deepEqual(requests.map(r => r.key), ["live-key-a", "live-key-b", "live-key-b", "live-key-b", "explicit-key"]);
assert.throws(() => streamAzureOpenAIResponses(model, context, { endpointConfiguration: Object.freeze({}), apiKey: "forged", fetch: customFetch }), /Invalid endpoint configuration handle/);
assert.equal(requests.length, 5);
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

	it("awaits and sends the onPayload replacement", async () => {
		let sentBody: Record<string, unknown> | undefined;
		global.fetch = vi.fn(async (_input, init) => {
			sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return createSseResponse([
				{
					type: "response.completed",
					response: { status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0 } },
				},
			]);
		}) as unknown as typeof fetch;

		await streamAzureOpenAIResponses(
			azureModel,
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			{
				apiKey: "test-key",
				azureBaseUrl: azureModel.baseUrl,
				azureApiVersion: "v1",
				onPayload: async payload => {
					await Bun.sleep(1);
					return { ...(payload as Record<string, unknown>), middlewareMarker: "applied" };
				},
			},
		).result();

		expect(sentBody?.middlewareMarker).toBe("applied");
	});

	it("serializes each system prompt as an Azure Responses system input item for non-reasoning models", async () => {
		const payload = await captureAzurePayload({
			systemPrompt: ["First instruction", "", "Second instruction"],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		});

		expect(payload.input).toEqual([
			{ role: "system", content: "First instruction" },
			{ role: "system", content: "Second instruction" },
			{ role: "user", content: [{ type: "input_text", text: "Say hello" }] },
		]);
	});

	it("uses developer role for Azure Responses reasoning model system prompts", async () => {
		const reasoningModel: Model<"azure-openai-responses"> = {
			...azureModel,
			reasoning: true,
		};
		const payload = await captureAzurePayload(
			{
				systemPrompt: ["Reasoning instruction", "Second instruction"],
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			},
			reasoningModel,
		);

		expect(payload.input).toEqual([
			{ role: "developer", content: "Reasoning instruction" },
			{ role: "developer", content: "Second instruction" },
			{ role: "user", content: [{ type: "input_text", text: "Say hello" }] },
			{
				role: "developer",
				content: [{ type: "input_text", text: "# Juice: 0 !important" }],
			},
		]);
	});

	it("keeps Azure Responses prompt_cache_key separate from Anthropic cache controls", async () => {
		const payload = await captureAzurePayload(
			{
				systemPrompt: ["Cache-stable instruction"],
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			},
			azureModel,
			{ sessionId: "azure-session" },
		);

		expect(payload.prompt_cache_key).toBe("azure-session");
		expect(payload.prompt_cache_retention).toBeUndefined();
		expect(payload.cache_control).toBeUndefined();
	});

	it("rewrites oneOf tool schemas to anyOf for Azure Responses", async () => {
		const tool: Tool = {
			name: "choose",
			description: "choose a branch",
			parameters: {
				type: "object",
				properties: {
					item: {
						oneOf: [
							{
								type: "object",
								properties: { kind: { const: "a" }, value: { type: "string" } },
								required: ["kind", "value"],
								additionalProperties: false,
							},
							{
								type: "object",
								properties: { kind: { const: "b" }, count: { type: "integer" } },
								required: ["kind", "count"],
								additionalProperties: false,
							},
						],
					},
				},
				required: ["item"],
			},
		};

		const payload = await captureAzurePayload({
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			tools: [tool],
		});

		const tools = payload.tools as Array<{ parameters: { properties: { item: Record<string, unknown> } } }>;
		expect(tools[0].parameters.properties.item.oneOf).toBeUndefined();
		expect(Array.isArray(tools[0].parameters.properties.item.anyOf)).toBe(true);
	});

	it("surfaces nested response.failed provider errors", async () => {
		global.fetch = vi.fn(async () =>
			createSseResponse([
				{
					type: "response.failed",
					response: {
						error: { code: "server_error", message: "backend exploded" },
					},
				},
			]),
		) as unknown as typeof fetch;

		const result = await streamAzureOpenAIResponses(
			azureModel,
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			{ apiKey: "test-key", azureBaseUrl: azureModel.baseUrl, azureApiVersion: "v1" },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("server_error: backend exploded");
	});

	it("surfaces response.failed incomplete reasons", async () => {
		global.fetch = vi.fn(async () =>
			createSseResponse([
				{
					type: "response.failed",
					response: {
						incomplete_details: { reason: "max_output_tokens" },
					},
				},
			]),
		) as unknown as typeof fetch;

		const result = await streamAzureOpenAIResponses(
			azureModel,
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			{ apiKey: "test-key", azureBaseUrl: azureModel.baseUrl, azureApiVersion: "v1" },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("incomplete: max_output_tokens");
	});

	it("surfaces response.completed failed status_details errors", async () => {
		global.fetch = vi.fn(async () =>
			createSseResponse([
				{
					type: "response.completed",
					response: {
						status: "failed",
						status_details: {
							error: { code: "server_error", message: "backend exploded late" },
						},
					},
				},
			]),
		) as unknown as typeof fetch;

		const result = await streamAzureOpenAIResponses(
			azureModel,
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			{ apiKey: "test-key", azureBaseUrl: azureModel.baseUrl, azureApiVersion: "v1" },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("server_error: backend exploded late");
	});
	it("preserves the typed capacity-overload code from both terminal envelope shapes", async () => {
		// Azure shares the Responses parser, so the typed code survives provider
		// finalization here too and classifies as a server fallback trigger. The
		// session's bare-default replay admission is scoped to the generic
		// `openai-responses` API and is unaffected by this.
		for (const response of [
			{ error: { code: "server_is_overloaded", message: "Our servers are currently overloaded." } },
			{
				status: "failed",
				error: { code: "server_is_overloaded", message: "Our servers are currently overloaded." },
			},
		]) {
			const type = "status" in response ? "response.completed" : "response.failed";
			global.fetch = vi.fn(async () => createSseResponse([{ type, response }])) as unknown as typeof fetch;

			const result = await streamAzureOpenAIResponses(
				azureModel,
				{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
				{ apiKey: "test-key", azureBaseUrl: azureModel.baseUrl, azureApiVersion: "v1" },
			).result();

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("server_is_overloaded: Our servers are currently overloaded.");
			expect(result.transportFailure).toMatchObject({
				kind: "transport",
				providerCode: "server_is_overloaded",
				openaiErrorCode: "server_is_overloaded",
			});
			expect(result.transportFailure?.status).toBeUndefined();
			expect(classifyFallbackTrigger(result.transportFailure)).toEqual({ class: "server" });
		}
	});

	it("leaves near-miss and case-variant Azure overload codes untyped", async () => {
		for (const code of ["server_is_overloaded_now", "SERVER_IS_OVERLOADED"]) {
			global.fetch = vi.fn(async () =>
				createSseResponse([
					{
						type: "response.failed",
						response: { error: { code, message: "Our servers are currently overloaded." } },
					},
				]),
			) as unknown as typeof fetch;

			const result = await streamAzureOpenAIResponses(
				azureModel,
				{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
				{ apiKey: "test-key", azureBaseUrl: azureModel.baseUrl, azureApiVersion: "v1" },
			).result();

			expect(result.stopReason).toBe("error");
			expect(result.transportFailure).toBeUndefined();
		}
	});

	it("preserves assistant message phase when rebuilding fallback replay history", async () => {
		const payload = await captureAzurePayload({
			messages: [
				{ role: "user", content: "first user", timestamp: Date.now() },
				createAssistantMessage(
					"Commentary answer",
					JSON.stringify({ v: 1, id: "msg_commentary", phase: "final_answer" }),
				),
				{ role: "user", content: "follow-up", timestamp: Date.now() },
			],
		});

		expect(payload.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "first user" }] },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Commentary answer", annotations: [] }],
				status: "completed",
				id: "msg_commentary",
				phase: "final_answer",
			},
			{ role: "user", content: [{ type: "input_text", text: "follow-up" }] },
		]);
	});

	it("keeps legacy plain-string text signatures when rebuilding fallback replay history", async () => {
		const payload = await captureAzurePayload({
			messages: [
				{ role: "user", content: "first user", timestamp: Date.now() },
				createAssistantMessage("Legacy answer", "msg_legacy"),
				{ role: "user", content: "follow-up", timestamp: Date.now() },
			],
		});

		expect(payload.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "first user" }] },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Legacy answer", annotations: [] }],
				status: "completed",
				id: "msg_legacy",
			},
			{ role: "user", content: [{ type: "input_text", text: "follow-up" }] },
		]);
	});
});

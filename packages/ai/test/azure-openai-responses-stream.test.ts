import { afterEach, describe, expect, it, vi } from "bun:test";
import { captureEndpointConfiguration, type EndpointConfiguration, hookFetch } from "@gajae-code/utils";
import { type AzureOpenAIResponsesOptions, streamAzureOpenAIResponses } from "../src/providers/azure-openai-responses";
import { streamOpenAIResponses } from "../src/providers/openai-responses";
import { getEnvApiKey, streamSimple } from "../src/stream";
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

	it("routes captured Azure config through simple dispatch and preserves live auth", async () => {
		const envKeys = [
			"AZURE_OPENAI_BASE_URL",
			"AZURE_OPENAI_RESOURCE_NAME",
			"AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
			"AZURE_OPENAI_API_VERSION",
		] as const;
		const previousEnv = new Map(envKeys.map(key => [key, Bun.env[key]]));
		const requests: Array<{ url: string; apiKey: string | null; body: Record<string, unknown> }> = [];
		const context: Context = { messages: [{ role: "user", content: "route this request", timestamp: Date.now() }] };
		const currentClassModel = firstClassAzureModel;
		try {
			delete Bun.env.AZURE_OPENAI_BASE_URL;
			Bun.env.AZURE_OPENAI_RESOURCE_NAME = "scope-a-resource";
			Bun.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = "gpt-4.1=scope-a-deployment";
			Bun.env.AZURE_OPENAI_API_VERSION = "2025-01-01";
			const scopeA = captureEndpointConfiguration();

			Bun.env.AZURE_OPENAI_RESOURCE_NAME = "scope-b-resource";
			Bun.env.AZURE_OPENAI_BASE_URL = "https://scope-b-base.openai.azure.com/openai/v1";
			Bun.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = "gpt-4.1=scope-b-deployment";
			Bun.env.AZURE_OPENAI_API_VERSION = "2026-02-02";
			const scopeB = captureEndpointConfiguration();

			using _hook = hookFetch(async (input, init) => {
				const request = input instanceof Request ? input : new Request(String(input), init);
				requests.push({
					url: request.url,
					apiKey: request.headers.get("api-key"),
					body: (await request.clone().json()) as Record<string, unknown>,
				});
				return createSseResponse([
					{
						type: "response.completed",
						response: { status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0 } },
					},
				]);
			});

			await streamSimple(currentClassModel, context, {
				endpointConfiguration: scopeA,
				apiKey: "shared-current-key-a",
				requestMaxRetries: 0,
			}).result();
			await streamSimple(currentClassModel, context, {
				endpointConfiguration: scopeA,
				apiKey: "shared-current-key-b",
				requestMaxRetries: 0,
			}).result();
			await streamSimple(currentClassModel, context, {
				endpointConfiguration: scopeB,
				apiKey: "shared-current-key-c",
				requestMaxRetries: 0,
			}).result();

			for (const key of envKeys) delete Bun.env[key];
			const capturedAbsence = captureEndpointConfiguration();
			Bun.env.AZURE_OPENAI_BASE_URL = "https://scope-c-base.openai.azure.com/openai/v1";
			Bun.env.AZURE_OPENAI_RESOURCE_NAME = "scope-c-resource";
			Bun.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = "gpt-4.1=scope-c-deployment";
			Bun.env.AZURE_OPENAI_API_VERSION = "2027-03-03";
			await streamSimple(currentClassModel, context, {
				endpointConfiguration: capturedAbsence,
				apiKey: "shared-current-key-d",
				requestMaxRetries: 0,
			}).result();

			await streamAzureOpenAIResponses(currentClassModel, context, {
				endpointConfiguration: scopeA,
				apiKey: "explicit-key",
				azureBaseUrl: "https://explicit.azure.example/openai/v1",
				azureDeploymentName: "explicit-deployment",
				azureApiVersion: "2028-04-04",
				requestMaxRetries: 0,
			}).result();

			const beforeForgedHandle = requests.length;
			expect(() =>
				streamAzureOpenAIResponses(currentClassModel, context, {
					endpointConfiguration: Object.freeze({}) as EndpointConfiguration,
					apiKey: "must-not-dial",
				}),
			).toThrow("Invalid endpoint configuration handle");
			expect(requests).toHaveLength(beforeForgedHandle);

			expect(requests.map(request => new URL(request.url).origin)).toEqual([
				"https://scope-a-resource.openai.azure.com",
				"https://scope-a-resource.openai.azure.com",
				"https://scope-b-base.openai.azure.com",
				"https://example.openai.azure.com",
				"https://explicit.azure.example",
			]);
			expect(requests.map(request => new URL(request.url).searchParams.get("api-version"))).toEqual([
				"2025-01-01",
				"2025-01-01",
				"2026-02-02",
				"v1",
				"2028-04-04",
			]);
			expect(requests.map(request => request.body.model)).toEqual([
				"scope-a-deployment",
				"scope-a-deployment",
				"scope-b-deployment",
				"gpt-4.1",
				"explicit-deployment",
			]);
			expect(requests.map(request => request.apiKey)).toEqual([
				"shared-current-key-a",
				"shared-current-key-b",
				"shared-current-key-c",
				"shared-current-key-d",
				"explicit-key",
			]);
		} finally {
			for (const key of envKeys) {
				const previous = previousEnv.get(key);
				if (previous === undefined) delete Bun.env[key];
				else Bun.env[key] = previous;
			}
		}
	});
});

describe("OpenAI endpoint configuration requests", () => {
	it("pins Responses and Completions SDK requests across URL scopes and absence", async () => {
		const previousBaseUrl = Bun.env.OPENAI_BASE_URL;
		const requests: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = [];
		const responsesModel: Model<"openai-responses"> = {
			id: "gpt-5-mini",
			name: "GPT-5 Mini",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const completionsModel: Model<"openai-completions"> = {
			...responsesModel,
			api: "openai-completions",
			id: "gpt-4o-mini",
			name: "GPT-4o Mini",
		};
		const context: Context = { messages: [{ role: "user", content: "pin this request", timestamp: Date.now() }] };
		const responseEvents = [
			{ type: "response.created", response: { id: "resp_endpoint", status: "in_progress", output: [] } },
			{
				type: "response.completed",
				response: {
					id: "resp_endpoint",
					status: "completed",
					output: [],
					usage: { input_tokens: 0, output_tokens: 0 },
				},
			},
		];
		const completionSse = (): Response => {
			const chunks = [
				{
					id: "chatcmpl_endpoint",
					object: "chat.completion.chunk",
					created: 1,
					model: "gpt-4o-mini",
					choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
				},
				{
					id: "chatcmpl_endpoint",
					object: "chat.completion.chunk",
					created: 1,
					model: "gpt-4o-mini",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				},
			];
			const body = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		};
		try {
			Bun.env.OPENAI_BASE_URL = "https://scope-a-openai.example/v1";
			const scopeA = captureEndpointConfiguration();
			Bun.env.OPENAI_BASE_URL = "https://scope-b-openai.example/v1";
			const scopeB = captureEndpointConfiguration();
			using _hook = hookFetch(async (input, init) => {
				const request = input instanceof Request ? input : new Request(String(input), init);
				const body = (await request.clone().json()) as Record<string, unknown>;
				requests.push({ url: request.url, authorization: request.headers.get("authorization"), body });
				return new URL(request.url).pathname.endsWith("/chat/completions")
					? completionSse()
					: createSseResponse(responseEvents);
			});

			await streamSimple(responsesModel, context, {
				endpointConfiguration: scopeA,
				apiKey: "responses-key-a",
				requestMaxRetries: 0,
			}).result();
			await streamSimple(completionsModel, context, {
				endpointConfiguration: scopeA,
				apiKey: "completions-key-a",
				requestMaxRetries: 0,
			}).result();
			await streamSimple(responsesModel, context, {
				endpointConfiguration: scopeB,
				apiKey: "responses-key-b",
				requestMaxRetries: 0,
			}).result();

			delete Bun.env.OPENAI_BASE_URL;
			const capturedAbsence = captureEndpointConfiguration();
			Bun.env.OPENAI_BASE_URL = "https://scope-c-openai.example/v1";
			await streamSimple(responsesModel, context, {
				endpointConfiguration: capturedAbsence,
				apiKey: "responses-key-c",
				requestMaxRetries: 0,
			}).result();
			await streamOpenAIResponses({ ...responsesModel, baseUrl: "https://explicit-openai.example/v1" }, context, {
				endpointConfiguration: scopeA,
				apiKey: "explicit-openai-key",
				requestMaxRetries: 0,
			}).result();
			await streamOpenAIResponses(responsesModel, context, {
				endpointConfiguration: scopeA,
				apiKey: "openai-oauth-token",
				authCredentialType: "oauth",
				requestMaxRetries: 0,
			}).result();

			expect(requests.map(request => request.url)).toEqual([
				"https://scope-a-openai.example/v1/responses",
				"https://scope-a-openai.example/v1/chat/completions",
				"https://scope-b-openai.example/v1/responses",
				"https://api.openai.com/v1/responses",
				"https://explicit-openai.example/v1/responses",
				"https://api.openai.com/v1/responses",
			]);
			expect(requests.map(request => request.authorization)).toEqual([
				"Bearer responses-key-a",
				"Bearer completions-key-a",
				"Bearer responses-key-b",
				"Bearer responses-key-c",
				"Bearer explicit-openai-key",
				"Bearer openai-oauth-token",
			]);
			expect(requests.map(request => request.body.model)).toEqual([
				"gpt-5-mini",
				"gpt-4o-mini",
				"gpt-5-mini",
				"gpt-5-mini",
				"gpt-5-mini",
				"gpt-5-mini",
			]);
			const beforeForgedHandle = requests.length;
			expect(() =>
				streamOpenAIResponses(responsesModel, context, {
					endpointConfiguration: Object.freeze({}) as EndpointConfiguration,
					apiKey: "oauth-key",
					authCredentialType: "oauth",
				}),
			).toThrow("Invalid endpoint configuration handle");
			expect(requests).toHaveLength(beforeForgedHandle);
		} finally {
			if (previousBaseUrl === undefined) delete Bun.env.OPENAI_BASE_URL;
			else Bun.env.OPENAI_BASE_URL = previousBaseUrl;
		}
	});
});

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import { Readable } from "node:stream";
import type { Model } from "@gajae-code/ai";
import type { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { SETTINGS_SCHEMA } from "@gajae-code/coding-agent/config/settings-schema";
import type { CustomToolContext } from "@gajae-code/coding-agent/extensibility/custom-tools";
import type { ReadonlySessionManager } from "@gajae-code/coding-agent/session/session-manager";
import {
	getImageGenToolsWithRegistry,
	imageGenTool,
	setConfiguredImageModel,
	setPreferredImageProvider,
} from "@gajae-code/coding-agent/tools/image-gen";

const originalFetch = global.fetch;
const originalOpenRouterKey = Bun.env.OPENROUTER_API_KEY;
const originalGeminiKey = Bun.env.GEMINI_API_KEY;
const originalGoogleKey = Bun.env.GOOGLE_API_KEY;
const originalOpenAIBaseUrl = Bun.env.OPENAI_BASE_URL;
const originalCustomImageKey = Bun.env.TEST_CUSTOM_IMAGE_API_KEY;
const generatedImagePaths: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(generatedImagePaths.splice(0).map(imagePath => fs.rm(imagePath, { force: true })));
	global.fetch = originalFetch;
	if (originalOpenRouterKey === undefined) {
		delete Bun.env.OPENROUTER_API_KEY;
	} else {
		Bun.env.OPENROUTER_API_KEY = originalOpenRouterKey;
	}
	if (originalOpenAIBaseUrl === undefined) {
		delete Bun.env.OPENAI_BASE_URL;
	} else {
		Bun.env.OPENAI_BASE_URL = originalOpenAIBaseUrl;
	}
	if (originalGeminiKey === undefined) {
		delete Bun.env.GEMINI_API_KEY;
	} else {
		Bun.env.GEMINI_API_KEY = originalGeminiKey;
	}
	if (originalGoogleKey === undefined) {
		delete Bun.env.GOOGLE_API_KEY;
	} else {
		Bun.env.GOOGLE_API_KEY = originalGoogleKey;
	}
	if (originalCustomImageKey === undefined) {
		delete Bun.env.TEST_CUSTOM_IMAGE_API_KEY;
	} else {
		Bun.env.TEST_CUSTOM_IMAGE_API_KEY = originalCustomImageKey;
	}
	setPreferredImageProvider("auto");
	setConfiguredImageModel(null);
});

function clearFallbackImageProviderEnv(): void {
	delete Bun.env.OPENROUTER_API_KEY;
	delete Bun.env.GEMINI_API_KEY;
	delete Bun.env.GOOGLE_API_KEY;
}

const MAX_IMAGE_BYTES = 35 * 1024 * 1024;
const OPENROUTER_MODEL = {
	api: "google-generative-ai",
	provider: "google",
	id: "gemini-3-pro-image-preview",
	name: "Gemini 3 Pro Image Preview",
	baseUrl: "https://generativelanguage.googleapis.com",
} as Model;

function makeOpenRouterCtx(): CustomToolContext {
	return {
		sessionManager: {
			getCwd: () => "/tmp",
			getSessionId: () => "test-session",
		} as unknown as ReadonlySessionManager,
		modelRegistry: {} as ModelRegistry,
		model: OPENROUTER_MODEL,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	};
}

function mockOpenRouterResponse(imageUrl: string): void {
	setPreferredImageProvider("openrouter");
	Bun.env.OPENROUTER_API_KEY = "test-openrouter-key";
	const fetchMock: typeof fetch = (async () =>
		new Response(
			JSON.stringify({
				choices: [{ message: { images: [{ image_url: { url: imageUrl } }] } }],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		)) as unknown as typeof fetch;
	fetchMock.preconnect = originalFetch.preconnect;
	global.fetch = fetchMock;
}

function imageResponse(
	body: string | Uint8Array | Array<string | Uint8Array>,
	options: {
		status?: number;
		headers?: http.IncomingHttpHeaders;
		peer?: string;
		rawHeaders?: string[];
	} = {},
): http.IncomingMessage {
	const chunks = Array.isArray(body) ? body : [body];
	const message = Readable.from(chunks) as unknown as http.IncomingMessage;
	const peer = Object.hasOwn(options, "peer") ? options.peer : "8.8.8.8";
	Object.defineProperties(message, {
		headers: { value: options.headers ?? {} },
		httpVersion: { value: "1.1" },
		rawHeaders: { value: options.rawHeaders ?? [] },
		socket: { value: { remoteAddress: peer } },
		statusCode: { value: options.status ?? 200 },
		statusMessage: { value: "Test" },
	});
	return message;
}

function mockImageRequests(nextResponse?: (options: https.RequestOptions, call: number) => http.IncomingMessage) {
	const requests: https.RequestOptions[] = [];
	const clients: Array<EventEmitter & { destroy: (error?: Error) => void; end: () => void }> = [];
	const opened = Promise.withResolvers<void>();
	const request = ((options: https.RequestOptions, callback?: (message: http.IncomingMessage) => void) => {
		requests.push(options);
		const client = new EventEmitter() as EventEmitter & { destroy: (error?: Error) => void; end: () => void };
		client.destroy = vi.fn(() => client.emit("close"));
		client.end = () => {
			opened.resolve();
			if (nextResponse) queueMicrotask(() => callback?.(nextResponse(options, requests.length)));
		};
		clients.push(client);
		return client as unknown as http.ClientRequest;
	}) as typeof http.request;
	vi.spyOn(http, "request").mockImplementation(request);
	vi.spyOn(https, "request").mockImplementation(request as typeof https.request);
	return { requests, clients, opened: opened.promise };
}

async function executeOpenRouter(signal?: AbortSignal) {
	const result = await imageGenTool.execute(
		"call-openrouter",
		{ subject: "a cat" },
		undefined,
		makeOpenRouterCtx(),
		signal,
	);
	generatedImagePaths.push(...(result.details?.imagePaths ?? []));
	return result;
}

describe("imageGenTool", () => {
	it("e2e writes OpenAI Responses image_generation WebP output to a temp file", async () => {
		delete Bun.env.OPENAI_BASE_URL;
		let requestUrl: string | undefined;
		let requestBody: unknown;

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input.toString();
			requestBody = JSON.parse(String(init?.body));
			return new Response(
				JSON.stringify({
					output: [
						{
							type: "image_generation_call",
							result: Buffer.from("fake-webp").toString("base64"),
							revised_prompt: "A crisp tabby cat portrait.",
							status: "completed",
						},
					],
					usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const model = {
			api: "openai-responses",
			provider: "openai",
			id: "gpt-5.5",
			name: "GPT 5.5",
			baseUrl: "https://api.openai.com/v1",
		} as Model;
		const ctx: CustomToolContext = {
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => "test-openai-key",
				getApiKeyForProvider: async () => undefined,
			} as unknown as ModelRegistry,
			model,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-1", { subject: "a cat", aspect_ratio: "16:9" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://api.openai.com/v1/responses");
		expect(requestBody).toMatchObject({
			model: "gpt-5.5",
			tools: [{ type: "image_generation", output_format: "webp", size: "1536x1024", action: "generate" }],
			tool_choice: { type: "image_generation" },
			store: false,
		});
		expect(result.details?.provider).toBe("openai");
		expect(result.details?.imageCount).toBe(1);
		expect(result.details?.images[0]?.mimeType).toBe("image/webp");
		expect(result.details?.revisedPrompt).toBe("A crisp tabby cat portrait.");
		expect(result.details?.imagePaths).toHaveLength(1);
		const savedPath = result.details?.imagePaths[0];
		if (!savedPath) throw new Error("Expected generated image path");
		expect(savedPath.endsWith(".webp")).toBe(true);
		expect(await Bun.file(savedPath).bytes()).toEqual(Buffer.from("fake-webp"));
	});

	it("uses OPENAI_BASE_URL for OpenAI image generation when active model still has the default OpenAI URL", async () => {
		Bun.env.OPENAI_BASE_URL = "https://openai-proxy.example.com/v1";
		let requestUrl: string | undefined;

		const fetchMock: typeof fetch = (async (input: string | URL | Request) => {
			requestUrl = input.toString();
			return new Response(
				JSON.stringify({
					output: [
						{
							type: "image_generation_call",
							result: Buffer.from("fake-webp").toString("base64"),
							status: "completed",
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const model = {
			api: "openai-responses",
			provider: "openai",
			id: "gpt-5.5",
			name: "GPT 5.5",
			baseUrl: "https://api.openai.com/v1",
		} as Model;
		const ctx: CustomToolContext = {
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => "test-openai-key",
				getApiKeyForProvider: async () => undefined,
			} as unknown as ModelRegistry,
			model,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-1", { subject: "a cat" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://openai-proxy.example.com/v1/responses");
	});

	it("keeps OAuth OpenAI image generation on the default API base URL when OPENAI_BASE_URL is set", async () => {
		Bun.env.OPENAI_BASE_URL = "https://openai-proxy.example.com/v1";
		let requestUrl: string | undefined;

		const fetchMock: typeof fetch = (async (input: string | URL | Request) => {
			requestUrl = input.toString();
			return new Response(
				JSON.stringify({
					output: [{ type: "image_generation_call", result: Buffer.from("fake-webp").toString("base64") }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const model = {
			api: "openai-responses",
			provider: "openai",
			id: "gpt-5.5",
			name: "GPT 5.5",
			baseUrl: "",
		} as Model;
		const ctx: CustomToolContext = {
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => "oauth-token",
				getApiKeyForProvider: async () => undefined,
				getSessionCredentialType: () => "oauth",
			} as unknown as ModelRegistry,
			model,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-1", { subject: "a cat" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://api.openai.com/v1/responses");
	});
	it("routes configured custom image models through their configured base URL", async () => {
		let requestUrl: string | undefined;
		let requestBody: unknown;
		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input.toString();
			requestBody = JSON.parse(String(init?.body));
			return new Response(
				JSON.stringify({
					output: [{ type: "image_generation_call", result: Buffer.from("fake-webp").toString("base64") }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;
		Bun.env.TEST_CUSTOM_IMAGE_API_KEY = "test-custom-key";
		setConfiguredImageModel({
			provider: "custom",
			model: "proxy-image-model",
			customUrl: "https://images.example.test/v1/",
			customKeyEnv: "TEST_CUSTOM_IMAGE_API_KEY",
		});

		const result = await imageGenTool.execute("call-custom", { subject: "a cat" }, undefined, makeOpenRouterCtx());
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://images.example.test/v1/responses");
		expect(requestBody).toMatchObject({ model: "proxy-image-model", tool_choice: { type: "image_generation" } });
		expect(result.details?.provider).toBe("openai");
	});
});

const ANTIGRAVITY_URL = "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse";

function antigravitySseResponse(): Response {
	const chunk = {
		response: {
			candidates: [
				{
					content: {
						role: "model",
						parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from("fake-png").toString("base64") } }],
					},
				},
			],
		},
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const ANTIGRAVITY_MODEL = {
	api: "google-gemini-cli",
	provider: "google-antigravity",
	id: "gemini-3-pro-image",
	name: "Gemini 3 Pro Image (Antigravity)",
	baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
} as Model;

function makeAntigravityCtx(modelRegistry: Partial<ModelRegistry>): CustomToolContext {
	return {
		sessionManager: {
			getCwd: () => "/tmp",
			getSessionId: () => "test-session",
		} as unknown as ReadonlySessionManager,
		modelRegistry: modelRegistry as unknown as ModelRegistry,
		model: ANTIGRAVITY_MODEL,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	};
}

describe("providers.image settings schema", () => {
	it("accepts antigravity and does not include openai-codex", () => {
		const values = SETTINGS_SCHEMA["providers.image"].values as readonly string[];
		expect(values).toContain("antigravity");
		expect(values).not.toContain("openai-codex");
	});
});

describe("imageGenTool antigravity provider", () => {
	it("uses structured getOAuthAccess metadata (access token + projectId) for the request", async () => {
		setPreferredImageProvider("antigravity");
		let requestUrl: string | undefined;
		let authorization: string | undefined;
		let requestBody: { project?: string } | undefined;

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input.toString();
			authorization = new Headers(init?.headers).get("authorization") ?? undefined;
			requestBody = JSON.parse(String(init?.body));
			return antigravitySseResponse();
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const ctx = makeAntigravityCtx({
			authStorage: {
				getOAuthAccess: async () => ({ accessToken: "oauth-token", projectId: "project-1" }),
			} as unknown as ModelRegistry["authStorage"],
			getApiKeyForProvider: async () => {
				throw new Error("getApiKeyForProvider should not be called when OAuth metadata is present");
			},
		});

		const result = await imageGenTool.execute("call-1", { subject: "a cat" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe(ANTIGRAVITY_URL);
		expect(authorization).toBe("Bearer oauth-token");
		expect(requestBody?.project).toBe("project-1");
		expect(result.details?.provider).toBe("antigravity");
		expect(result.details?.imageCount).toBe(1);
	});

	it("falls back to JSON-parsed getApiKeyForProvider credentials when OAuth access is absent", async () => {
		setPreferredImageProvider("antigravity");
		let authorization: string | undefined;
		let requestBody: { project?: string } | undefined;

		const fetchMock: typeof fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			authorization = new Headers(init?.headers).get("authorization") ?? undefined;
			requestBody = JSON.parse(String(init?.body));
			return antigravitySseResponse();
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const ctx = makeAntigravityCtx({
			authStorage: {
				getOAuthAccess: async () => undefined,
			} as unknown as ModelRegistry["authStorage"],
			getApiKeyForProvider: async () => JSON.stringify({ token: "json-token", projectId: "project-json" }),
		});

		const result = await imageGenTool.execute("call-1", { subject: "a cat" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(authorization).toBe("Bearer json-token");
		expect(requestBody?.project).toBe("project-json");
	});

	it("does not register for malformed JSON credentials without a token field", async () => {
		setPreferredImageProvider("antigravity");
		clearFallbackImageProviderEnv();

		const modelRegistry = {
			authStorage: {
				getOAuthAccess: async () => undefined,
			} as unknown as ModelRegistry["authStorage"],
			getApiKeyForProvider: async () => JSON.stringify({ projectId: "project-without-token" }),
		} as unknown as ModelRegistry;

		const tools = await getImageGenToolsWithRegistry(modelRegistry, ANTIGRAVITY_MODEL);
		expect(tools).toHaveLength(0);
	});

	it("does not register for empty or whitespace antigravity credentials", async () => {
		setPreferredImageProvider("antigravity");
		clearFallbackImageProviderEnv();

		for (const credential of ["", "   \n\t  "]) {
			const modelRegistry = {
				authStorage: {
					getOAuthAccess: async () => undefined,
				} as unknown as ModelRegistry["authStorage"],
				getApiKeyForProvider: async () => credential,
			} as unknown as ModelRegistry;

			const tools = await getImageGenToolsWithRegistry(modelRegistry, ANTIGRAVITY_MODEL);
			expect(tools).toHaveLength(0);
		}
	});

	it("accepts JSON credentials with accessToken and honors projectId", async () => {
		setPreferredImageProvider("antigravity");
		let authorization: string | undefined;
		let requestBody: { project?: string } | undefined;

		const fetchMock: typeof fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			authorization = new Headers(init?.headers).get("authorization") ?? undefined;
			requestBody = JSON.parse(String(init?.body));
			return antigravitySseResponse();
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const ctx = makeAntigravityCtx({
			authStorage: {
				getOAuthAccess: async () => undefined,
			} as unknown as ModelRegistry["authStorage"],
			getApiKeyForProvider: async () =>
				JSON.stringify({ accessToken: "access-token-json", projectId: "project-access" }),
		});

		const result = await imageGenTool.execute("call-1", { subject: "a cat" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(authorization).toBe("Bearer access-token-json");
		expect(requestBody?.project).toBe("project-access");
		expect(result.details?.provider).toBe("antigravity");
	});

	it("registers OAuth access without projectId but fails loudly before fetch", async () => {
		setPreferredImageProvider("antigravity");
		let fetchCalled = false;
		const fetchMock: typeof fetch = (async () => {
			fetchCalled = true;
			return antigravitySseResponse();
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const modelRegistry = {
			authStorage: {
				getOAuthAccess: async () => ({ accessToken: "oauth-token-without-project" }),
			} as unknown as ModelRegistry["authStorage"],
			getApiKeyForProvider: async () => {
				throw new Error("getApiKeyForProvider should not be called when OAuth access token is present");
			},
		} as unknown as ModelRegistry;

		const tools = await getImageGenToolsWithRegistry(modelRegistry, ANTIGRAVITY_MODEL);
		expect(tools).toHaveLength(1);

		const ctx = makeAntigravityCtx(modelRegistry);
		await expect(imageGenTool.execute("call-1", { subject: "a cat" }, undefined, ctx)).rejects.toThrow(
			/projectId.*google-antigravity|google-antigravity.*projectId/s,
		);
		await expect(imageGenTool.execute("call-2", { subject: "a cat" }, undefined, ctx)).rejects.toThrow(/login/);
		expect(fetchCalled).toBe(false);
	});

	it("registers the tool for a raw-token-only credential but fails loudly without a projectId", async () => {
		setPreferredImageProvider("antigravity");
		let fetchCalled = false;
		const fetchMock: typeof fetch = (async () => {
			fetchCalled = true;
			return antigravitySseResponse();
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const modelRegistry = {
			authStorage: {
				getOAuthAccess: async () => undefined,
			} as unknown as ModelRegistry["authStorage"],
			getApiKeyForProvider: async () => "raw-token",
		} as unknown as ModelRegistry;

		const tools = await getImageGenToolsWithRegistry(modelRegistry, ANTIGRAVITY_MODEL);
		expect(tools).toHaveLength(1);

		const ctx = makeAntigravityCtx(modelRegistry);
		await expect(imageGenTool.execute("call-1", { subject: "a cat" }, undefined, ctx)).rejects.toThrow(
			/projectId.*google-antigravity|google-antigravity.*projectId/s,
		);
		await expect(imageGenTool.execute("call-2", { subject: "a cat" }, undefined, ctx)).rejects.toThrow(/login/);
		expect(fetchCalled).toBe(false);
	});
});

describe("imageGenTool OpenRouter remote images", () => {
	it("downloads a public image through a connection pinned to the approved DNS answer", async () => {
		mockOpenRouterResponse("https://images.example/cat.png");
		const dnsLookup = vi
			.spyOn(dns, "lookup")
			.mockImplementation((async () => [{ address: "8.8.8.8", family: 4 }]) as unknown as typeof dns.lookup);
		const { requests } = mockImageRequests(() =>
			imageResponse("remote-png", {
				headers: { "content-type": "image/png", "content-length": "10" },
				peer: "::ffff:8.8.8.8",
			}),
		);

		const result = await executeOpenRouter();

		expect(result.details?.provider).toBe("openrouter");
		expect(result.details?.images[0]).toEqual({
			data: Buffer.from("remote-png").toString("base64"),
			mimeType: "image/png",
		});
		expect(dnsLookup).toHaveBeenCalledTimes(1);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			agent: false,
			insecureHTTPParser: false,
			maxHeaderSize: 16 * 1024,
			rejectUnauthorized: true,
			servername: "images.example",
		});
		expect(requests[0]?.headers).toMatchObject({
			Accept: "image/*",
			"Accept-Encoding": "identity",
			Connection: "close",
			Host: "images.example",
		});
		const lookupCallback = vi.fn();
		requests[0]?.lookup?.("images.example", { all: true }, lookupCallback);
		expect(lookupCallback).toHaveBeenCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
	});

	it("accepts a pinned connection when Bun does not expose peer metadata", async () => {
		mockOpenRouterResponse("https://images.example/cat.png");
		vi.spyOn(dns, "lookup").mockImplementation((async () => [
			{ address: "8.8.8.8", family: 4 },
		]) as unknown as typeof dns.lookup);
		const { requests } = mockImageRequests(() =>
			imageResponse("remote-png", {
				headers: { "content-type": "image/png" },
				peer: undefined,
			}),
		);

		const result = await executeOpenRouter();

		expect(result.details?.images[0]).toEqual({
			data: Buffer.from("remote-png").toString("base64"),
			mimeType: "image/png",
		});
		expect(requests).toHaveLength(1);
	});

	it("preserves provider-returned data URLs without opening a network request", async () => {
		const encoded = Buffer.from("inline-png").toString("base64");
		mockOpenRouterResponse(`data:image/png;base64,${encoded}`);
		const { requests } = mockImageRequests(() => imageResponse("unexpected"));

		const result = await executeOpenRouter();

		expect(result.details?.images[0]).toEqual({ data: encoded, mimeType: "image/png" });
		expect(requests).toHaveLength(0);
	});

	it("rejects a connected peer outside the URL guard's approved DNS answers", async () => {
		mockOpenRouterResponse("https://images.example/cat.png");
		vi.spyOn(dns, "lookup").mockImplementation((async () => [
			{ address: "8.8.8.8", family: 4 },
		]) as unknown as typeof dns.lookup);
		const response = imageResponse("remote-png", {
			headers: { "content-type": "image/png" },
			peer: "1.1.1.1",
		});
		const destroy = vi.spyOn(response, "destroy");
		mockImageRequests(() => response);

		await expect(executeOpenRouter()).rejects.toThrow(/unapproved connected peer/);
		expect(destroy).toHaveBeenCalled();
	});

	it("rejects oversized raw response headers before reading the image body", async () => {
		mockOpenRouterResponse("http://8.8.8.8/cat.png");
		const response = imageResponse("remote-png", {
			headers: { "content-type": "image/png" },
			rawHeaders: ["Content-Type", "image/png", "X-Large", "a".repeat(16 * 1024)],
		});
		const destroy = vi.spyOn(response, "destroy");
		mockImageRequests(() => response);

		await expect(executeOpenRouter()).rejects.toThrow(/headers exceed the maximum size of 16 KiB/);
		expect(destroy).toHaveBeenCalled();
	});

	it("rejects an initial non-public image URL before opening a request", async () => {
		mockOpenRouterResponse("http://127.0.0.1/private.png");
		const { requests } = mockImageRequests(() => imageResponse("unexpected"));

		await expect(executeOpenRouter()).rejects.toThrow(/not public HTTP\(S\)/);
		expect(requests).toHaveLength(0);
	});

	it("revalidates and rejects a non-public redirect target", async () => {
		mockOpenRouterResponse("http://8.8.8.8/cat.png");
		const { requests } = mockImageRequests(() =>
			imageResponse("", { status: 302, headers: { location: "http://127.0.0.1/private.png" } }),
		);

		await expect(executeOpenRouter()).rejects.toThrow(/not public HTTP\(S\)/);
		expect(requests).toHaveLength(1);
	});

	it("rejects redirect chains beyond the fixed limit", async () => {
		mockOpenRouterResponse("http://8.8.8.8/cat.png");
		const { requests } = mockImageRequests(() =>
			imageResponse("", { status: 302, headers: { location: "/next.png" } }),
		);

		await expect(executeOpenRouter()).rejects.toThrow(/Too many redirects/);
		expect(requests).toHaveLength(6);
	});

	it("rejects an image whose Content-Length exceeds the image byte cap", async () => {
		mockOpenRouterResponse("http://8.8.8.8/cat.png");
		const response = imageResponse("", {
			headers: { "content-type": "image/png", "content-length": String(MAX_IMAGE_BYTES + 1) },
		});
		const destroy = vi.spyOn(response, "destroy");
		mockImageRequests(() => response);

		await expect(executeOpenRouter()).rejects.toThrow(/maximum size of 35 MiB/);
		expect(destroy).toHaveBeenCalled();
	});

	it("stops a chunked image before buffering beyond the image byte cap", async () => {
		mockOpenRouterResponse("http://8.8.8.8/cat.png");
		const response = imageResponse([new Uint8Array(MAX_IMAGE_BYTES), new Uint8Array([1])], {
			headers: { "content-type": "image/png" },
		});
		const destroy = vi.spyOn(response, "destroy");
		mockImageRequests(() => response);

		await expect(executeOpenRouter()).rejects.toThrow(/maximum size of 35 MiB/);
		expect(destroy).toHaveBeenCalled();
	});

	it("rejects absent and non-image Content-Type headers before buffering", async () => {
		for (const headers of [{}, { "content-type": "text/plain" }]) {
			mockOpenRouterResponse("http://8.8.8.8/cat.png");
			const response = imageResponse("not-an-image", { headers });
			const destroy = vi.spyOn(response, "destroy");
			mockImageRequests(() => response);

			await expect(executeOpenRouter()).rejects.toThrow(/image Content-Type/);
			expect(destroy).toHaveBeenCalled();
			vi.restoreAllMocks();
		}
	});

	it("bounds non-success response previews", async () => {
		mockOpenRouterResponse("http://8.8.8.8/cat.png");
		const response = imageResponse(new Uint8Array(8 * 1024 + 1), { status: 502 });
		const destroy = vi.spyOn(response, "destroy");
		mockImageRequests(() => response);

		await expect(executeOpenRouter()).rejects.toThrow(/preview limit/);
		expect(destroy).toHaveBeenCalled();
	});

	it("destroys an in-flight image request when the caller cancels", async () => {
		mockOpenRouterResponse("http://8.8.8.8/cat.png");
		const controller = new AbortController();
		const { clients, opened } = mockImageRequests();
		const operation = executeOpenRouter(controller.signal);
		await opened;
		controller.abort(new Error("caller cancelled"));

		await expect(operation).rejects.toThrow(/caller cancelled/);
		expect(clients[0]?.destroy).toHaveBeenCalled();
	});

	it("destroys an in-flight image request when the shared image deadline expires", async () => {
		mockOpenRouterResponse("http://8.8.8.8/cat.png");
		const deadline = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
		const { clients, opened } = mockImageRequests();
		const operation = executeOpenRouter();
		await opened;
		deadline.abort(new DOMException("image deadline", "TimeoutError"));

		await expect(operation).rejects.toThrow(/image deadline/);
		expect(clients[0]?.destroy).toHaveBeenCalled();
	});
});

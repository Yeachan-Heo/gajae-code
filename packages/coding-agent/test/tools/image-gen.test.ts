import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import type { Model } from "@gajae-code/ai";
import type { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { SETTINGS_SCHEMA } from "@gajae-code/coding-agent/config/settings-schema";
import type { CustomToolContext } from "@gajae-code/coding-agent/extensibility/custom-tools";
import type { ReadonlySessionManager } from "@gajae-code/coding-agent/session/session-manager";
import {
	getImageGenToolsWithRegistry,
	imageGenTool,
	setPreferredImageProvider,
} from "@gajae-code/coding-agent/tools/image-gen";

const originalFetch = global.fetch;
const originalOpenRouterKey = Bun.env.OPENROUTER_API_KEY;
const originalGeminiKey = Bun.env.GEMINI_API_KEY;
const originalGoogleKey = Bun.env.GOOGLE_API_KEY;
const originalOpenAIBaseUrl = Bun.env.OPENAI_BASE_URL;
const generatedImagePaths: string[] = [];

afterEach(async () => {
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
	setPreferredImageProvider("auto");
});

function clearFallbackImageProviderEnv(): void {
	delete Bun.env.OPENROUTER_API_KEY;
	delete Bun.env.GEMINI_API_KEY;
	delete Bun.env.GOOGLE_API_KEY;
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

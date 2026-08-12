import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import type { Model } from "@gajae-code/ai";
import type { ModelRegistry } from "../src/config/model-registry";
import type { CustomToolContext } from "../src/extensibility/custom-tools/types";
import type { ReadonlySessionManager } from "../src/session/session-manager";
import { createImageGenTool, imageGenTool } from "../src/tools/image-gen";

const originalFetch = global.fetch;
const originalOpenAIBaseUrl = process.env.OPENAI_BASE_URL;

const generatedImagePaths: string[] = [];

const activeModel = {
	id: "gpt-5.5",
	name: "GPT 5.5",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
} as Model;

function makeContext(
	modelRegistry: ModelRegistry,
	sessionId = "image-isolation-session",
	model: Model = activeModel,
): CustomToolContext {
	return {
		sessionManager: {
			getCwd: () => "/tmp",
			getSessionId: () => sessionId,
		} as unknown as ReadonlySessionManager,
		modelRegistry,
		model,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	};
}

afterEach(async () => {
	global.fetch = originalFetch;
	if (originalOpenAIBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
	else process.env.OPENAI_BASE_URL = originalOpenAIBaseUrl;

	await Promise.all(generatedImagePaths.splice(0).map(imagePath => fs.rm(imagePath, { force: true })));
});

describe("image generation session isolation", () => {
	it("keeps immutable per-instance endpoint, model, and selector state isolated from mutations and the module global", async () => {
		delete process.env.OPENAI_BASE_URL;
		const requests: Array<{ url: string; model: string; authorization: string | null }> = [];
		const selectors: Array<{ kind: string; value: string } | undefined> = [];
		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { model?: string };
			requests.push({
				url: input.toString(),
				model: body.model ?? "",
				authorization: new Headers(init?.headers).get("authorization"),
			});
			return new Response(
				JSON.stringify({
					output: [{ type: "image_generation_call", result: Buffer.from("fake-webp").toString("base64") }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const registry = {
			getApiKey: async (
				_model: Model,
				_sessionId?: string,
				options?: { credentialSelector?: { kind: string; value: string } },
			) => {
				selectors.push(options?.credentialSelector);
				return "isolated-image-key";
			},
			getSessionCredentialType: () => "api_key",
		} as unknown as ModelRegistry;
		const firstConfig = {
			provider: "custom" as const,
			model: "first-image-model",
			customUrl: "https://first-images.example.invalid/v1/",
			credentialSelector: { kind: "id" as const, value: "first-credential" },
		};
		const secondConfig = {
			provider: "custom" as const,
			model: "second-image-model",
			customUrl: "https://second-images.example.invalid/v1/",
			credentialSelector: { kind: "id" as const, value: "second-credential" },
		};
		const firstTool = createImageGenTool(firstConfig);
		const secondTool = createImageGenTool(secondConfig);

		firstConfig.model = "mutated-model";
		firstConfig.customUrl = "https://mutated-images.example.invalid/v1/";
		firstConfig.credentialSelector.value = "mutated-credential";
		secondConfig.model = "mutated-second-model";
		secondConfig.customUrl = "https://mutated-second-images.example.invalid/v1/";
		secondConfig.credentialSelector.value = "mutated-second-credential";

		const firstResult = await firstTool.execute("first-call", { subject: "a cat" }, undefined, makeContext(registry));
		const secondResult = await secondTool.execute(
			"second-call",
			{ subject: "a dog" },
			undefined,
			makeContext(registry),
		);
		generatedImagePaths.push(...(firstResult.details?.imagePaths ?? []), ...(secondResult.details?.imagePaths ?? []));

		const defaultResult = await imageGenTool.execute(
			"default-call",
			{ subject: "a bird" },
			undefined,
			makeContext(registry),
		);
		generatedImagePaths.push(...(defaultResult.details?.imagePaths ?? []));

		expect(requests).toEqual([
			{
				url: "https://first-images.example.invalid/v1/responses",
				model: "first-image-model",
				authorization: "Bearer isolated-image-key",
			},
			{
				url: "https://second-images.example.invalid/v1/responses",
				model: "second-image-model",
				authorization: "Bearer isolated-image-key",
			},
			{
				url: "https://api.openai.com/v1/responses",
				model: "gpt-5.5",
				authorization: "Bearer isolated-image-key",
			},
		]);
		expect(selectors).toEqual([
			{ kind: "id", value: "first-credential" },
			{ kind: "id", value: "second-credential" },
			undefined,
		]);
	});

	it("keeps concurrent session-dependent credentials, endpoints, models, and selectors bound without global bleed", async () => {
		delete process.env.OPENAI_BASE_URL;
		const sessions = {
			"session-one": {
				key: "session-one-image-key",
				selector: { kind: "id" as const, value: "session-one-selector" },
				url: "https://session-one-images.example.invalid/v1/responses",
				model: "session-one-image-model",
			},
			"session-two": {
				key: "session-two-image-key",
				selector: { kind: "id" as const, value: "session-two-selector" },
				url: "https://session-two-images.example.invalid/v1/responses",
				model: "session-two-image-model",
			},
		} as const;
		const requests: Array<{ url: string; model: string; authorization: string | null }> = [];
		const selectors: Array<{ sessionId: string; selector: { kind: string; value: string } | undefined }> = [];
		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { model?: string };
			requests.push({
				url: input.toString(),
				model: body.model ?? "",
				authorization: new Headers(init?.headers).get("authorization"),
			});
			return new Response(
				JSON.stringify({
					output: [{ type: "image_generation_call", result: Buffer.from("session-image").toString("base64") }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		fetchMock.preconnect = originalFetch.preconnect;
		global.fetch = fetchMock;

		const registry = {
			getApiKey: async (
				_model: Model,
				sessionId?: string,
				options?: { credentialSelector?: { kind: string; value: string } },
			) => {
				if (!sessionId || !(sessionId in sessions)) throw new Error("unknown image session");
				const expected = sessions[sessionId as keyof typeof sessions];
				selectors.push({ sessionId, selector: options?.credentialSelector });
				await Promise.resolve();
				return expected.key;
			},
			getSessionCredentialType: () => "api_key",
		} as unknown as ModelRegistry;
		const firstTool = createImageGenTool({
			provider: "custom",
			model: sessions["session-one"].model,
			customUrl: "https://session-one-images.example.invalid/v1",
			credentialSelector: sessions["session-one"].selector,
		});
		const secondTool = createImageGenTool({
			provider: "custom",
			model: sessions["session-two"].model,
			customUrl: "https://session-two-images.example.invalid/v1",
			credentialSelector: sessions["session-two"].selector,
		});

		const [firstResult, secondResult] = await Promise.all([
			firstTool.execute("session-one-call", { subject: "a cat" }, undefined, makeContext(registry, "session-one")),
			secondTool.execute("session-two-call", { subject: "a dog" }, undefined, makeContext(registry, "session-two")),
		]);
		generatedImagePaths.push(...(firstResult.details?.imagePaths ?? []), ...(secondResult.details?.imagePaths ?? []));

		expect(requests.sort((a, b) => a.url.localeCompare(b.url))).toEqual([
			{
				url: sessions["session-one"].url,
				model: sessions["session-one"].model,
				authorization: `Bearer ${sessions["session-one"].key}`,
			},
			{
				url: sessions["session-two"].url,
				model: sessions["session-two"].model,
				authorization: `Bearer ${sessions["session-two"].key}`,
			},
		]);
		expect(selectors.sort((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual([
			{ sessionId: "session-one", selector: sessions["session-one"].selector },
			{ sessionId: "session-two", selector: sessions["session-two"].selector },
		]);
	});
});

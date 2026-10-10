import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeModelCache } from "../src/model-cache";
import { resolveProviderModels } from "../src/model-manager";
import { getBundledModel } from "../src/models";
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
	opencodeGoModelManagerOptions,
	opencodeZenModelManagerOptions,
	UNK_CONTEXT_WINDOW,
	UNK_MAX_TOKENS,
} from "../src/provider-models/openai-compat";
import { streamSimple } from "../src/stream";
import type { Api, Context, Model } from "../src/types";

const id = "union-alpha";
const metadata = {
	id,
	name: "Union Alpha Free",
	api: "anthropic-messages",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 262_144,
	maxTokens: 131_072,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const providers = [
	["opencode-go", "https://opencode.ai/zen/go", opencodeGoModelManagerOptions],
	["opencode-zen", "https://opencode.ai/zen", opencodeZenModelManagerOptions],
] as const;

function anthropicResponse(): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_union",
				type: "message",
				role: "assistant",
				model: id,
				content: [],
				usage: { input_tokens: 5, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

afterEach(() => vi.restoreAllMocks());

describe("OpenCode Union Alpha", () => {
	test("curates the exact Go id even when models.dev omits transport and capabilities", () => {
		const models = mapModelsDevToModels(
			{
				"opencode-go": {
					models: { [id]: { name: id, tool_call: true }, "union-alpha-other": { tool_call: true } },
				},
			},
			MODELS_DEV_PROVIDER_DESCRIPTORS,
		);
		expect(models.find(model => model.provider === "opencode-go" && model.id === id)).toMatchObject({
			...metadata,
			baseUrl: "https://opencode.ai/zen/go",
		});
		expect(models.find(model => model.id === "union-alpha-other")?.api).toBe("openai-completions");
	});

	for (const [provider, baseUrl, managerOptions] of providers) {
		test(`${provider} pins the documented transport over generic models.dev metadata`, () => {
			const models = mapModelsDevToModels(
				{
					[provider === "opencode-zen" ? "opencode" : provider]: {
						models: { [id]: { tool_call: true, provider: { npm: "@ai-sdk/openai-compatible" } } },
					},
				},
				MODELS_DEV_PROVIDER_DESCRIPTORS,
			);
			expect(models.find(model => model.provider === provider && model.id === id)).toMatchObject({
				api: "anthropic-messages",
				baseUrl,
			});
		});

		test(`${provider} bundles the reviewed Union Alpha contract`, () => {
			expect(getBundledModel(provider, id)).toMatchObject({ ...metadata, provider, baseUrl });
		});

		test.each([
			"https://relay.example.test/custom/v1",
			"  https://relay.example.test/custom/v1///  ",
		])(`${provider} preserves configured origin %s while selecting the Messages base`, async customBaseUrl => {
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
				Object.assign(async () => Response.json({ data: [{ id }] }), {
					preconnect: globalThis.fetch.preconnect,
				}),
			);
			const options = managerOptions({ apiKey: "test-key", baseUrl: customBaseUrl });
			const dynamic = await options.fetchDynamicModels?.();
			expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://relay.example.test/custom/v1/models");
			expect(dynamic?.find(model => model.id === id)).toMatchObject({
				...metadata,
				baseUrl: "https://relay.example.test/custom",
			});
		});

		test(`${provider} keeps Anthropic routing through id-only discovery and cache reuse`, async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "union-alpha-"));
			try {
				const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
					Object.assign(async () => Response.json({ data: [{ id }] }), {
						preconnect: globalThis.fetch.preconnect,
					}),
				);
				const options = {
					...managerOptions({ apiKey: "test-key" }),
					staticModels: [getBundledModel(provider, id)],
					cacheDbPath: path.join(directory, "models.db"),
				};
				const dynamic = await options.fetchDynamicModels?.();
				expect(dynamic?.find(model => model.id === id)).toMatchObject({ ...metadata, provider, baseUrl });
				const online = await resolveProviderModels<Api>(options, "online");
				expect(online.models.find(model => model.id === id)).toMatchObject({ ...metadata, provider, baseUrl });
				const count = fetchSpy.mock.calls.length;
				const offline = await resolveProviderModels<Api>(options, "offline");
				expect(offline.models).toEqual(online.models);
				expect(fetchSpy).toHaveBeenCalledTimes(count);
			} finally {
				await fs.rm(directory, { recursive: true, force: true });
			}
		});

		test.each([
			"offline",
			"online-if-uncached",
		] as const)(`${provider} repairs pre-catalogue discovery cache during %s`, async strategy => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "union-alpha-cache-"));
			try {
				const cacheDbPath = path.join(directory, "models.db");
				const now = 1_700_000_000_000;
				const placeholder: Model = {
					id,
					name: id,
					provider,
					api: "openai-completions",
					baseUrl: `${baseUrl}/v1`,
					reasoning: false,
					input: ["text"],
					cost: metadata.cost,
					contextWindow: UNK_CONTEXT_WINDOW,
					maxTokens: UNK_MAX_TOKENS,
				};
				const provenance = "same-credential-and-endpoint";
				writeModelCache(
					provider,
					now,
					[placeholder],
					true,
					Bun.hash(JSON.stringify([placeholder])).toString(36),
					cacheDbPath,
					[id],
					provenance,
				);
				const fetchDynamicModels = vi.fn(async () => null);
				const result = await resolveProviderModels(
					{
						providerId: provider,
						staticModels: [getBundledModel(provider, id)],
						fetchDynamicModels,
						cacheDbPath,
						now: () => now,
						cacheDynamicModelProvenance: provenance,
					},
					strategy,
				);
				expect(result.models.find(model => model.id === id)).toMatchObject({ ...metadata, provider, baseUrl });
				expect(fetchDynamicModels).not.toHaveBeenCalled();
			} finally {
				await fs.rm(directory, { recursive: true, force: true });
			}
		});

		test(`${provider} preserves nearby mixed-protocol routes on a custom discovery endpoint`, async () => {
			const neighbors =
				provider === "opencode-go"
					? [
							["qwen3.8-flash", "anthropic-messages"],
							["muse-spark-1.3-contributor", "openai-responses"],
							["glm-5.1", "openai-completions"],
						]
					: [
							["claude-sonnet-4-6", "anthropic-messages"],
							["gpt-5.5", "openai-responses"],
							["glm-5.1", "openai-completions"],
						];
			vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: neighbors.map(([id]) => ({ id })) }));
			const models = await managerOptions({
				apiKey: "test-key",
				baseUrl: "https://relay.example.test/custom/v1",
			}).fetchDynamicModels?.();
			for (const [id, api] of neighbors) {
				expect(models?.find(model => model.id === id)).toMatchObject({
					id,
					api,
					baseUrl:
						api === "anthropic-messages"
							? "https://relay.example.test/custom"
							: "https://relay.example.test/custom/v1",
				});
			}
		});

		test(`${provider} dispatches Messages with images, tools and stable Go session identity`, async () => {
			const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
			const capture = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				requests.push({
					url: input instanceof Request ? input.url : String(input),
					headers: new Headers(init?.headers),
					body: JSON.parse(String(init?.body)) as Record<string, unknown>,
				});
				return anthropicResponse();
			};
			vi.spyOn(globalThis, "fetch").mockImplementation(
				Object.assign(capture, { preconnect: globalThis.fetch.preconnect }),
			);
			const context: Context = {
				messages: [
					{
						role: "user",
						timestamp: 1,
						content: [
							{ type: "text", text: "Inspect this image" },
							{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
						],
					},
				],
				tools: [{ name: "lookup", description: "Look up a value", parameters: { type: "object", properties: {} } }],
			};
			for (let turn = 0; turn < 2; turn++) {
				const result = await streamSimple(getBundledModel(provider, id), context, {
					apiKey: "test-key",
					providerSessionId: "opaque-union-session",
					sessionId: `generic-session-${turn}`,
				}).result();
				expect(result.stopReason).toBe("stop");
				expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "ok" }));
			}
			expect(requests).toHaveLength(2);
			for (const request of requests) {
				expect(request.url).toBe(`${baseUrl}/v1/messages`);
				expect(request.headers.get("x-opencode-session")).toBe(
					provider === "opencode-go" ? "opaque-union-session" : null,
				);
				expect(request.body.model).toBe(id);
				expect(request.body.tools).toEqual([
					expect.objectContaining({
						name: "lookup",
						input_schema: expect.objectContaining({ type: "object", properties: {} }),
					}),
				]);
				expect(request.body.messages).toEqual([
					expect.objectContaining({
						role: "user",
						content: expect.arrayContaining([
							expect.objectContaining({
								type: "image",
								source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
							}),
						]),
					}),
				]);
			}
		});
	}
});

import { describe, expect, it } from "bun:test";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages";
import { normalizeCacheControlTtlOrdering, streamAnthropic } from "@gajae-code/ai/providers/anthropic";
import { clearGitLabDuoDirectAccessCache, streamGitLabDuo } from "@gajae-code/ai/providers/gitlab-duo";
import type { CacheRetention, Context, Model, TJsonSchema } from "@gajae-code/ai/types";

const canonicalModel: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

type CacheControl = { type: string; ttl?: string };
type Payload = MessageCreateParamsStreaming & { cache_control?: CacheControl };

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function context(messages: Context["messages"] = [{ role: "user", content: "Continue", timestamp: 1 }]): Context {
	return {
		systemPrompt: ["Stable instructions", "Second stable instruction"],
		tools: [
			{
				name: "lookup",
				description: "Looks up an answer.",
				parameters: { type: "object", properties: {} } as TJsonSchema,
			},
		],
		messages,
	};
}

function capturePayload(
	model: Model<"anthropic-messages">,
	input: Context,
	onPayload?: (payload: Payload) => Payload | undefined,
	cacheRetention?: CacheRetention,
): Promise<Payload> {
	const { promise, resolve } = Promise.withResolvers<Payload>();
	streamAnthropic(model, input, {
		apiKey: "sk-ant-api-test",
		isOAuth: false,
		signal: abortedSignal(),
		cacheRetention,
		onPayload: payload => {
			const replacement = onPayload?.(payload as Payload);
			resolve((replacement ?? payload) as Payload);
			return replacement;
		},
	});
	return promise;
}
function captureGitLabPayload(model: Model<"anthropic-messages">, cacheRetention?: CacheRetention): Promise<Payload> {
	clearGitLabDuoDirectAccessCache();
	const { promise, resolve } = Promise.withResolvers<Payload>();
	streamGitLabDuo(model, context(), {
		apiKey: "glpat-test",
		signal: abortedSignal(),
		cacheRetention,
		fetch: async input => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === "https://gitlab.com/api/v4/ai/third_party_agents/direct_access") {
				return new Response(
					JSON.stringify({ token: "direct-token", headers: { "x-gitlab-instance-id": "test" } }),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			}
			throw new Error(`Unexpected GitLab Duo fetch: ${url}`);
		},
		onPayload: payload => {
			resolve(payload as Payload);
		},
	});
	return promise;
}

function cacheParams(overrides: Partial<Payload> = {}): Payload {
	return {
		model: canonicalModel.id,
		max_tokens: 1,
		stream: true,
		messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
		...overrides,
	};
}

function cacheControls(payload: Payload): CacheControl[] {
	const controls: CacheControl[] = [];
	if (payload.cache_control) controls.push(payload.cache_control);
	for (const tool of payload.tools ?? []) {
		const control = (tool as { cache_control?: CacheControl }).cache_control;
		if (control) controls.push(control);
	}
	if (Array.isArray(payload.system)) {
		for (const block of payload.system) {
			const control = (block as { cache_control?: CacheControl }).cache_control;
			if (control) controls.push(control);
		}
	}
	for (const message of payload.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			const control = (block as { cache_control?: CacheControl }).cache_control;
			if (control) controls.push(control);
		}
	}
	return controls;
}

describe("Anthropic prompt caching", () => {
	const explicitCompatibleModel: Model<"anthropic-messages"> = {
		...canonicalModel,
		baseUrl: "https://proxy.example.test/anthropic",
		compat: { promptCacheMode: "explicit" },
	};
	const automaticCompatibleModel: Model<"anthropic-messages"> = {
		...canonicalModel,
		baseUrl: "https://proxy.example.test/anthropic",
		compat: { promptCacheMode: "automatic" },
	};

	it("defaults canonical Anthropic to automatic and compatible Claude gateways to explicit caching", async () => {
		const nonClaudeModel: Model<"anthropic-messages"> = {
			...canonicalModel,
			id: "custom-compatible-model",
			name: "Custom compatible model",
			baseUrl: "https://proxy.example.test/anthropic",
		};
		const [canonical, proxiedClaude, automatic, nonClaude] = await Promise.all([
			capturePayload(canonicalModel, context()),
			capturePayload({ ...canonicalModel, baseUrl: "https://proxy.example.test/anthropic" }, context()),
			capturePayload(automaticCompatibleModel, context()),
			capturePayload(nonClaudeModel, context()),
		]);

		expect(canonical.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		// Compatible Claude gateways default to explicit block markers because many
		// proxies add their own controls or do not understand the root field.
		expect(proxiedClaude.cache_control).toBeUndefined();
		expect(
			(proxiedClaude.messages.at(-1)?.content as Array<{ cache_control?: CacheControl }>)[0]?.cache_control,
		).toEqual({
			type: "ephemeral",
		});
		// A verified gateway can explicitly opt into top-level automatic caching.
		expect(automatic.cache_control).toEqual({ type: "ephemeral" });
		expect(cacheControls(automatic)).toEqual([{ type: "ephemeral" }]);
		// Non-Claude models on unknown compatible endpoints still get no generated caching.
		expect(nonClaude.cache_control).toBeUndefined();
	});
	it("classifies the dispatched model id and honors every cache opt-out", async () => {
		const proxyUrl = "https://proxy.example.test/anthropic";
		const cases: Array<{
			name: string;
			model: Model<"anthropic-messages">;
			options?: { cacheRetention?: "none" | "short" | "long" };
			expected: CacheControl | undefined;
		}> = [
			{
				name: "prefixed claude id on non-canonical gateway",
				model: { ...canonicalModel, id: "anthropic/claude-sonnet-4-5", baseUrl: proxyUrl },
				expected: { type: "ephemeral" },
			},
			{
				name: "uppercase claude id on non-canonical gateway",
				model: { ...canonicalModel, id: "CLAUDE-OPUS-5", baseUrl: proxyUrl },
				expected: { type: "ephemeral" },
			},
			{
				name: "non-canonical claude with explicit long retention opt-in",
				model: { ...canonicalModel, baseUrl: proxyUrl, compat: { supportsLongCacheRetention: true } },
				expected: { type: "ephemeral", ttl: "1h" },
			},
			{
				name: "promptCacheMode none disables generated caching",
				model: { ...canonicalModel, baseUrl: proxyUrl, compat: { promptCacheMode: "none" } },
				expected: undefined,
			},
			{
				name: "per-request cacheRetention none disables caching on canonical",
				model: canonicalModel,
				options: { cacheRetention: "none" },
				expected: undefined,
			},
			{
				name: "id containing -claude- but not starting claude- is not cached",
				model: { ...canonicalModel, id: "my-claude-helper", baseUrl: proxyUrl },
				expected: undefined,
			},
			{
				name: "promptCacheMode automatic opts a non-Claude endpoint into top-level caching",
				model: {
					...canonicalModel,
					id: "custom-compatible-model",
					baseUrl: proxyUrl,
					compat: { promptCacheMode: "automatic" },
				},
				expected: { type: "ephemeral" },
			},
			{
				name: "wireModelId override does not drive the decision; dispatched id governs",
				model: {
					...canonicalModel,
					id: "local-alias",
					wireModelId: "claude-sonnet-4-5",
					baseUrl: proxyUrl,
				},
				expected: undefined,
			},
			{
				name: "wireModelId override to a non-claude wire id still follows dispatched id",
				model: {
					...canonicalModel,
					id: "claude-sonnet-4-5",
					wireModelId: "local-alias",
					baseUrl: proxyUrl,
				},
				expected: { type: "ephemeral" },
			},
		];

		for (const { name, model, options, expected } of cases) {
			const payload = await capturePayload(model, context(), undefined, options?.cacheRetention);
			expect(payload.model, name).toBe(model.id);
			expect(cacheControls(payload), name).toEqual(expected ? [expected] : []);
		}
	});
	it("preserves configured cache retention through GitLab Duo and lets request options win", async () => {
		const gitlabModel: Model<"anthropic-messages"> = {
			...canonicalModel,
			id: "duo-chat-sonnet-4-6",
			name: "Duo Chat Sonnet 4.6",
			provider: "gitlab-duo",
			baseUrl: "https://cloud.gitlab.com/ai/v1/proxy/anthropic/",
			cacheRetention: "none",
		};

		const configuredNone = await captureGitLabPayload(gitlabModel);
		const requestOverride = await captureGitLabPayload(gitlabModel, "short");

		expect(configuredNone.model).toBe("claude-sonnet-4-6");
		expect(cacheControls(configuredNone)).toEqual([]);
		expect(requestOverride.model).toBe("claude-sonnet-4-6");
		expect(cacheControls(requestOverride)).toEqual([{ type: "ephemeral" }]);
	});

	it("counts top-level automatic and caller controls together without mutating a callback replacement", async () => {
		const replacement = cacheParams({
			cache_control: { type: "ephemeral", ttl: "1h" },
			tools: [
				{
					name: "first",
					description: "first",
					input_schema: { type: "object", properties: {} },
					cache_control: { type: "ephemeral", ttl: "1h" },
				},
			],
			system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }],
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "current question", cache_control: { type: "ephemeral" } }],
				},
			],
		});
		const before = structuredClone(replacement);
		const payload = await capturePayload(canonicalModel, context(), () => replacement);

		expect(payload).toBe(replacement);
		expect(replacement).toEqual(before);
		expect(cacheControls(payload)).toHaveLength(4);
	});

	it("accepts zero, one, and four ordered caller controls across tools, system, and messages", () => {
		const cases: Payload[] = [
			cacheParams(),
			cacheParams({
				tools: [
					{
						name: "tool",
						description: "tool",
						input_schema: { type: "object", properties: {} },
						cache_control: { type: "ephemeral", ttl: "1h" },
					},
				],
			}),
			cacheParams({
				tools: [
					{
						name: "tool",
						description: "tool",
						input_schema: { type: "object", properties: {} },
						cache_control: { type: "ephemeral", ttl: "1h" },
					},
				],
				system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral", ttl: "1h" } }],
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "stable answer", cache_control: { type: "ephemeral" } }],
					},
					{
						role: "user",
						content: [{ type: "text", text: "current question", cache_control: { type: "ephemeral" } }],
					},
				],
			}),
		];
		for (const params of cases) {
			const before = structuredClone(params);
			expect(() => normalizeCacheControlTtlOrdering(params)).not.toThrow();
			expect(params).toEqual(before);
		}
	});

	it("accepts nullable cache controls as absent without mutation", () => {
		const params = cacheParams({
			cache_control: null,
			tools: [
				{
					name: "tool",
					description: "tool",
					input_schema: { type: "object", properties: {} },
					cache_control: null,
				},
			],
			system: [{ type: "text", text: "stable", cache_control: null }],
			messages: [{ role: "user", content: [{ type: "text", text: "question", cache_control: null }] }],
		} as Payload);
		const before = structuredClone(params);

		expect(() => normalizeCacheControlTtlOrdering(params)).not.toThrow();
		expect(params).toEqual(before);
		expect(cacheControls(params)).toHaveLength(0);
	});

	it("fails closed for invalid callback controls and never normalizes caller objects", () => {
		const cases: Array<{ name: string; params: Payload }> = [
			{
				name: "five controls",
				params: cacheParams({
					cache_control: { type: "ephemeral" },
					tools: Array.from({ length: 4 }, (_, index) => ({
						name: `tool-${index}`,
						description: "tool",
						input_schema: { type: "object", properties: {} },
						cache_control: { type: "ephemeral" },
					})),
				}),
			},
			{
				name: "five-minute before one-hour",
				params: cacheParams({
					system: [{ type: "text", text: "short", cache_control: { type: "ephemeral" } }],
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: "long", cache_control: { type: "ephemeral", ttl: "1h" } }],
						},
					],
				}),
			},
			{
				name: "thinking target",
				params: {
					...cacheParams(),
					messages: [
						{
							role: "assistant",
							content: [
								{
									type: "thinking",
									thinking: "private",
									signature: "sig",
									cache_control: { type: "ephemeral" },
								},
							],
						},
					],
				} as unknown as Payload,
			},
			{
				name: "empty text target",
				params: cacheParams({
					messages: [
						{ role: "user", content: [{ type: "text", text: "", cache_control: { type: "ephemeral" } }] },
					],
				}),
			},
		];
		for (const { name, params } of cases) {
			const before = structuredClone(params);
			expect(() => normalizeCacheControlTtlOrdering(params)).toThrow(`Invalid Anthropic cache_control`);
			expect(params, name).toEqual(before);
		}
	});

	it("refreshes only the current explicit candidate at history deltas 19 and 20", async () => {
		for (const historyLength of [19, 20]) {
			const payload = await capturePayload(
				explicitCompatibleModel,
				context([
					...Array.from({ length: historyLength }, (_, index) => ({
						role: "user" as const,
						content: `history ${index}`,
						timestamp: index + 1,
					})),
					{ role: "user", content: "refresh", timestamp: historyLength + 1 },
				]),
			);
			const historicalBlocks = payload.messages
				.slice(0, -1)
				.flatMap(message => (Array.isArray(message.content) ? message.content : [])) as Array<{
				cache_control?: CacheControl;
			}>;
			const currentBlocks = payload.messages.at(-1)?.content as Array<{ cache_control?: CacheControl }>;
			expect(historicalBlocks.some(block => block.cache_control)).toBe(false);
			expect(currentBlocks.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
		}
	});

	it("uses the final mixed tool_result/text user content as the explicit refresh point", async () => {
		const payload = await capturePayload(
			explicitCompatibleModel,
			context([
				{ role: "user", content: "Question", timestamp: 1 },
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "lookup",
					content: [{ type: "text", text: "Answer" }],
					isError: false,
					timestamp: 2,
				},
				{ role: "user", content: "Use the answer", timestamp: 3 },
			]),
		);
		expect(
			(payload.messages.at(-1)?.content as Array<{ cache_control?: CacheControl }>).at(-1)?.cache_control,
		).toEqual({
			type: "ephemeral",
		});
	});

	it("advances explicit caching to the latest assistant tool-use turn without caching its result", async () => {
		const payload = await capturePayload(
			explicitCompatibleModel,
			context([
				{ role: "user", content: "Question", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: {} }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: canonicalModel.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "lookup",
					content: [{ type: "text", text: "Answer" }],
					isError: false,
					timestamp: 3,
				},
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_2", name: "lookup", arguments: {} }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: canonicalModel.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 4,
				},
				{
					role: "toolResult",
					toolCallId: "call_2",
					toolName: "lookup",
					content: [{ type: "text", text: "Second answer" }],
					isError: false,
					timestamp: 5,
				},
			]),
		);
		const firstAssistantContent = payload.messages[1]?.content as Array<{ cache_control?: CacheControl }>;
		const latestAssistantContent = payload.messages[3]?.content as Array<{ cache_control?: CacheControl }>;
		const firstUserContent = payload.messages[0]?.content as Array<{ cache_control?: CacheControl }>;
		const toolResultContent = payload.messages.at(-1)?.content as Array<{ cache_control?: CacheControl }>;

		expect(firstUserContent.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
		expect(firstAssistantContent.some(block => block.cache_control)).toBe(false);
		expect(latestAssistantContent.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
		expect(toolResultContent.some(block => block.cache_control)).toBe(false);
	});

	it("keeps explicit markers off tools, system/schema, and thinking blocks", async () => {
		const payload = await capturePayload(
			explicitCompatibleModel,
			context([
				{
					role: "assistant",
					content: [{ type: "thinking", thinking: "private", thinkingSignature: "sig" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: canonicalModel.id,
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
				},
				{ role: "user", content: "", timestamp: 2 },
			]),
		);
		expect(payload.tools?.[0]).toMatchObject({ input_schema: { type: "object", properties: {} } });
		expect(payload.tools?.some(tool => (tool as { cache_control?: CacheControl }).cache_control)).toBe(false);
		expect(Array.isArray(payload.system) && payload.system.some(block => block.cache_control)).toBe(false);
		expect(cacheControls(payload)).toEqual([{ type: "ephemeral" }]);
		expect(payload.messages.at(-1)?.content).toEqual([
			{ type: "text", text: "Continue.", cache_control: { type: "ephemeral" } },
		]);
	});
});

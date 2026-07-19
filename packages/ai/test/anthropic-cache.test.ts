import { describe, expect, it } from "bun:test";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages";
import { normalizeCacheControlTtlOrdering, streamAnthropic } from "@gajae-code/ai/providers/anthropic";
import type { Context, Model, TJsonSchema } from "@gajae-code/ai/types";

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
): Promise<Payload> {
	const { promise, resolve } = Promise.withResolvers<Payload>();
	streamAnthropic(model, input, {
		apiKey: "sk-ant-api-test",
		isOAuth: false,
		signal: abortedSignal(),
		onPayload: payload => {
			const replacement = onPayload?.(payload as Payload);
			resolve((replacement ?? payload) as Payload);
			return replacement;
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

	it("defaults canonical Anthropic to automatic and requires compatible endpoints to opt into explicit caching", async () => {
		const [canonical, compatible, explicit] = await Promise.all([
			capturePayload(canonicalModel, context()),
			capturePayload({ ...canonicalModel, baseUrl: "https://proxy.example.test/anthropic" }, context()),
			capturePayload(explicitCompatibleModel, context()),
		]);

		expect(canonical.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(compatible.cache_control).toBeUndefined();
		expect(explicit.cache_control).toBeUndefined();
		expect(explicit.tools?.every(tool => !(tool as { cache_control?: CacheControl }).cache_control)).toBe(true);
		expect(!Array.isArray(explicit.system) || explicit.system.every(block => !block.cache_control)).toBe(true);
		expect((explicit.messages.at(-1)?.content as Array<{ cache_control?: CacheControl }>)[0]?.cache_control).toEqual({
			type: "ephemeral",
		});
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

	it("does not treat a tool-result-only wire user turn as the explicit human refresh", async () => {
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
			]),
		);
		const firstUserContent = payload.messages[0]?.content as Array<{ cache_control?: CacheControl }>;
		const toolResultContent = payload.messages.at(-1)?.content as Array<{ cache_control?: CacheControl }>;

		expect(firstUserContent.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
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

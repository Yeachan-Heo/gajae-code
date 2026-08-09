import { afterEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@gajae-code/ai/models";
import { streamOpenAICompletions } from "@gajae-code/ai/providers/openai-completions";
import { streamOpenAIResponses } from "@gajae-code/ai/providers/openai-responses";
import type { Context, Model, OpenAICompat, ProviderSessionState, Tool } from "@gajae-code/ai/types";
import * as z from "zod/v4";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

const testTool: Tool = {
	name: "echo",
	description: "Echo input",
	parameters: z.object({
		text: z.string(),
	}),
};

const looseYieldTool: Tool = {
	name: "yield",
	description: "Submit result",
	strict: false,
	parameters: {
		type: "object",
		additionalProperties: false,
		properties: {
			result: {
				anyOf: [
					{
						type: "object",
						additionalProperties: false,
						properties: {
							data: {
								type: "object",
								additionalProperties: true,
							},
						},
						required: ["data"],
					},
				],
			},
		},
		required: ["result"],
	},
};

const testContext: Context = {
	messages: [
		{
			role: "user",
			content: "say hi",
			timestamp: Date.now(),
		},
	],
	tools: [testTool],
};

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function toRecord(value: unknown): Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function getYieldDataSchema(parameters: unknown): Record<string, unknown> {
	const resultSchema = toRecord(toRecord(parameters).properties).result;
	const variants = toRecord(resultSchema).anyOf;
	if (!Array.isArray(variants)) return {};
	for (const variant of variants) {
		const dataSchema = toRecord(toRecord(variant).properties).data;
		if (dataSchema !== undefined) return toRecord(dataSchema);
	}
	return {};
}

function createSseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function captureCompletionsPayload(
	model: Model<"openai-completions">,
	context: Context = testContext,
): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamOpenAICompletions(model, context, {
		apiKey: "test-key",
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload),
	});
	return promise;
}

function captureResponsesPayload(model: Model<"openai-responses">, context: Context = testContext): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamOpenAIResponses(model, context, {
		apiKey: "test-key",
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload),
	});
	return promise;
}

describe("OpenAI tool strict mode", () => {
	it("sends strict=true for openai-completions tool schemas", async () => {
		const model: Model<"openai-completions"> = {
			...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
			api: "openai-completions",
		};

		const payload = (await captureCompletionsPayload(model)) as {
			tools?: Array<{ function?: { strict?: boolean } }>;
		};
		expect(payload.tools?.[0]?.function?.strict).toBe(true);
	});

	it("omits strict for openai-completions when compatibility disables strict mode", async () => {
		const model: Model<"openai-completions"> = {
			...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
			api: "openai-completions",
			compat: { supportsStrictMode: false } satisfies OpenAICompat,
		};

		const payload = (await captureCompletionsPayload(model)) as {
			tools?: Array<{ function?: { strict?: boolean } }>;
		};
		expect(payload.tools?.[0]?.function?.strict).toBeUndefined();
	});

	it("keeps loose yield schemas non-strict for openai-completions", async () => {
		const model: Model<"openai-completions"> = {
			...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
			api: "openai-completions",
		};
		const payload = (await captureCompletionsPayload(model, {
			...testContext,
			tools: [looseYieldTool],
		})) as {
			tools?: Array<{ function?: { strict?: boolean; parameters?: Record<string, unknown> } }>;
		};
		const fn = payload.tools?.[0]?.function;

		expect(fn?.strict).toBeUndefined();
		expect(getYieldDataSchema(fn?.parameters).additionalProperties).toBe(true);
	});

	it("sends strict=true for openai-completions tool schemas on GitHub Copilot", async () => {
		const model = getBundledModel("github-copilot", "gpt-4o") as Model<"openai-completions">;

		const payload = (await captureCompletionsPayload(model)) as {
			tools?: Array<{ function?: { strict?: boolean } }>;
		};
		expect(payload.tools?.[0]?.function?.strict).toBe(true);
	});

	it("sends strict=true for openai-completions tool schemas on OpenRouter", async () => {
		const model = getBundledModel("openrouter", "anthropic/claude-sonnet-4") as Model<"openai-completions">;

		const payload = (await captureCompletionsPayload(model)) as {
			tools?: Array<{ function?: { strict?: boolean } }>;
		};
		expect(payload.tools?.[0]?.function?.strict).toBe(true);
	});

	it("omits stream_options usage requests for Cerebras chat completions", async () => {
		const model = getBundledModel("cerebras", "gpt-oss-120b") as Model<"openai-completions">;

		const payload = (await captureCompletionsPayload(model)) as {
			stream_options?: { include_usage?: boolean };
		};
		expect(payload.stream_options).toBeUndefined();
	});

	it("uses uniformly non-strict tool schemas when provider requires all-or-none strictness", async () => {
		const model: Model<"openai-completions"> = {
			...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
			api: "openai-completions",
			compat: { toolStrictMode: "all_strict" } satisfies OpenAICompat,
		};
		const context: Context = {
			...testContext,
			tools: [
				testTool,
				{
					name: "dynamic_map",
					description: "Dynamic object map",
					parameters: z.object({
						values: z.record(z.string(), z.string()).optional(),
					}),
				},
			],
		};

		const payload = (await captureCompletionsPayload(model, context)) as {
			tools?: Array<{ function?: { strict?: boolean } }>;
		};
		expect(payload.tools).toHaveLength(2);
		expect(payload.tools?.every(tool => tool.function?.strict === undefined)).toBe(true);
	});

	it("surfaces captured JSON error bodies when the SDK reports no body", async () => {
		const model: Model<"openai-completions"> = {
			...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
			api: "openai-completions",
		};
		global.fetch = Object.assign(
			async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
				new Response(
					JSON.stringify({
						message: "Tools with mixed values for 'strict' are not allowed.",
						type: "invalid_request_error",
						param: "tools",
						code: "wrong_api_format",
					}),
					{
						status: 422,
						headers: { "content-type": "application/json" },
					},
				),
			{ preconnect: originalFetch.preconnect },
		);

		const result = await streamOpenAICompletions(model, testContext, { apiKey: "test-key" }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Tools with mixed values for 'strict' are not allowed.");
		expect(result.errorMessage).toContain("param=tools");
		expect(result.errorMessage).toContain("code=wrong_api_format");
	});

	it("retries with non-strict tool schemas after strict-mode request errors", async () => {
		const model: Model<"openai-completions"> = {
			...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
			api: "openai-completions",
			compat: { toolStrictMode: "all_strict" } satisfies OpenAICompat,
		};
		const strictFlags: boolean[][] = [];
		global.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const bodyText = typeof init?.body === "string" ? init.body : "";
				const payload = JSON.parse(bodyText) as {
					tools?: Array<{ function?: { strict?: boolean } }>;
				};
				strictFlags.push((payload.tools ?? []).map(tool => tool.function?.strict === true));
				if (strictFlags.length === 1) {
					return new Response(
						JSON.stringify({
							message: "Strict tool schema validation failed.",
							type: "invalid_request_error",
							param: "tools",
							code: "wrong_api_format",
						}),
						{
							status: 422,
							headers: { "content-type": "application/json" },
						},
					);
				}
				return createSseResponse([
					{
						id: "chatcmpl-retry",
						object: "chat.completion.chunk",
						created: 0,
						model: model.id,
						choices: [{ index: 0, delta: { content: "Hello" } }],
					},
					{
						id: "chatcmpl-retry",
						object: "chat.completion.chunk",
						created: 0,
						model: model.id,
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					},
					"[DONE]",
				]);
			},
			{ preconnect: originalFetch.preconnect },
		);

		const result = await streamOpenAICompletions(model, testContext, { apiKey: "test-key" }).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toContainEqual({ type: "text", text: "Hello" });
		expect(strictFlags).toEqual([[true], [false]]);
	});

	it("keeps OpenRouter Anthropic tools non-strict after compiled grammar errors", async () => {
		const model = getBundledModel("openrouter", "anthropic/claude-sonnet-4") as Model<"openai-completions">;
		const providerSessionState = new Map<string, ProviderSessionState>();
		const strictFlags: boolean[][] = [];
		let attempt = 0;
		global.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				attempt += 1;
				const bodyText = typeof init?.body === "string" ? init.body : "";
				const payload = JSON.parse(bodyText) as {
					tools?: Array<{ function?: { strict?: boolean } }>;
				};
				strictFlags.push((payload.tools ?? []).map(tool => tool.function?.strict === true));
				if (attempt === 1) {
					return new Response(
						JSON.stringify({
							type: "error",
							error: {
								type: "invalid_request_error",
								message:
									"The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.",
							},
							request_id: "req_test",
						}),
						{
							status: 400,
							headers: { "content-type": "application/json" },
						},
					);
				}
				return createSseResponse([
					{
						id: "chatcmpl-openrouter-retry",
						object: "chat.completion.chunk",
						created: 0,
						model: model.id,
						choices: [{ index: 0, delta: { content: attempt === 2 ? "Recovered" : "Later" } }],
					},
					{
						id: "chatcmpl-openrouter-retry",
						object: "chat.completion.chunk",
						created: 0,
						model: model.id,
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					},
					"[DONE]",
				]);
			},
			{ preconnect: originalFetch.preconnect },
		);

		const result = await streamOpenAICompletions(model, testContext, {
			apiKey: "test-key",
			providerSessionState,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toContain("compiled grammar is too large");
		expect(result.content).toContainEqual({ type: "text", text: "Recovered" });
		expect(strictFlags).toEqual([[true], [false]]);

		const nextResult = await streamOpenAICompletions(model, testContext, {
			apiKey: "test-key",
			providerSessionState,
		}).result();

		expect(nextResult.stopReason).toBe("stop");
		expect(nextResult.content).toContainEqual({ type: "text", text: "Later" });
		expect(strictFlags).toEqual([[true], [false], [false]]);
	});

	it("does not disable OpenRouter Anthropic strict tools for unrelated invalid requests", async () => {
		const model = getBundledModel("openrouter", "anthropic/claude-sonnet-4") as Model<"openai-completions">;
		const providerSessionState = new Map<string, ProviderSessionState>();
		const strictFlags: boolean[][] = [];
		global.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const bodyText = typeof init?.body === "string" ? init.body : "";
				const payload = JSON.parse(bodyText) as {
					tools?: Array<{ function?: { strict?: boolean } }>;
				};
				strictFlags.push((payload.tools ?? []).map(tool => tool.function?.strict === true));
				return new Response(
					JSON.stringify({
						type: "error",
						error: { type: "invalid_request_error", message: "Some other validation error." },
						request_id: "req_test",
					}),
					{
						status: 400,
						headers: { "content-type": "application/json" },
					},
				);
			},
			{ preconnect: originalFetch.preconnect },
		);

		const result = await streamOpenAICompletions(model, testContext, {
			apiKey: "test-key",
			providerSessionState,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Some other validation error");
		expect(strictFlags).toEqual([[true]]);
	});

	it("sends strict=true for openai-responses tool schemas on OpenAI", async () => {
		const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;

		const payload = (await captureResponsesPayload(model)) as {
			tools?: Array<{ strict?: boolean }>;
		};
		expect(payload.tools?.[0]?.strict).toBe(true);
	});

	it("keeps loose yield schemas non-strict for openai-responses", async () => {
		const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
		const payload = (await captureResponsesPayload(model, {
			...testContext,
			tools: [looseYieldTool],
		})) as {
			tools?: Array<{ strict?: boolean; parameters?: Record<string, unknown> }>;
		};
		const tool = payload.tools?.[0];

		expect(tool?.strict).toBeUndefined();
		expect(getYieldDataSchema(tool?.parameters).additionalProperties).toBe(true);
	});

	it("sends strict=true for openai-responses tool schemas on GitHub Copilot", async () => {
		const model = getBundledModel("github-copilot", "gpt-5-mini") as Model<"openai-responses">;

		const payload = (await captureResponsesPayload(model)) as {
			tools?: Array<{ strict?: boolean }>;
		};
		expect(payload.tools?.[0]?.strict).toBe(true);
	});
});

const reservedNameContext: Context = {
	...testContext,
	tools: [
		testTool,
		{
			name: "web_search",
			description: "Search the web",
			parameters: z.object({ query: z.string() }),
		},
		{
			name: "report_finding",
			description: "Report a review finding",
			parameters: z.object({ note: z.string() }),
		},
	],
};

describe("provider-reserved tool declarations", () => {
	it("omits reserved declarations but keeps every other tool on opencode-go openai-responses", async () => {
		const model = getBundledModel("opencode-go", "grok-4.5") as Model<"openai-responses">;

		const payload = (await captureResponsesPayload(model, reservedNameContext)) as {
			tools?: Array<{ name?: string }>;
		};
		expect(payload.tools?.map(tool => tool.name)).toEqual(["echo", "report_finding"]);
	});

	it("omits reserved declarations but keeps every other tool on opencode-go openai-completions", async () => {
		const model = getBundledModel("opencode-go", "kimi-k2.5") as Model<"openai-completions">;

		const payload = (await captureCompletionsPayload(model, reservedNameContext)) as {
			tools?: Array<{ function?: { name?: string } }>;
		};
		expect(payload.tools?.map(tool => tool.function?.name)).toEqual(["echo", "report_finding"]);
	});

	it("keeps web_search on an openai-responses provider that does not reserve it", async () => {
		const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;

		const payload = (await captureResponsesPayload(model, reservedNameContext)) as {
			tools?: Array<{ name?: string }>;
		};
		expect(payload.tools?.map(tool => tool.name)).toEqual(["echo", "web_search", "report_finding"]);
	});

	it("keeps web_search on an openai-completions provider that does not reserve it", async () => {
		const model: Model<"openai-completions"> = {
			...(getBundledModel("openai", "gpt-4o-mini") as unknown as Model<"openai-completions">),
			api: "openai-completions",
		};

		const payload = (await captureCompletionsPayload(model, reservedNameContext)) as {
			tools?: Array<{ function?: { name?: string } }>;
		};
		expect(payload.tools?.map(tool => tool.function?.name)).toEqual(["echo", "web_search", "report_finding"]);
	});
});

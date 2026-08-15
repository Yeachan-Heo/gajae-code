import { afterEach, describe, expect, it, vi } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { streamAnthropic } from "../src/providers/anthropic";
import type { Context, FetchImpl, Model } from "../src/types";
import { waitForDelayOrAbort } from "./helpers";

const model: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const context: Context = {
	messages: [{ role: "user", content: "Say hi", timestamp: Date.now() }],
};

function contextWithBytes(bytes: number): Context {
	return {
		messages: [{ role: "user", content: "x".repeat(bytes), timestamp: Date.now() }],
	};
}

function customModel(baseUrl: string): Model<"anthropic-messages"> {
	return { ...model, baseUrl };
}

type MockAnthropicEvent = Record<string, unknown>;
type MockAnthropicStream = AsyncIterable<MockAnthropicEvent>;

type MockAnthropicRequest = {
	withResponse(): Promise<{
		data: MockAnthropicStream;
		response: Response;
		request_id: string | null;
	}>;
};

async function waitForAbortAndThrowAbortError(signal: AbortSignal | undefined): Promise<never> {
	if (signal?.aborted) {
		throw new Error("Request was aborted.");
	}

	const { promise, reject } = Promise.withResolvers<void>();
	const onAbort = () => reject(new Error("Request was aborted."));
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		await promise;
		throw new Error("Anthropic mock stream unexpectedly resumed");
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

function createSuccessfulAnthropicEvents(text: string): MockAnthropicEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_retry_success",
				usage: {
					input_tokens: 12,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text },
		},
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: {
				input_tokens: 12,
				output_tokens: 4,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		},
	];
}

function createAnthropicMockStream({
	signal,
	connectDelayMs = 0,
	eventDelayMs = 0,
	events,
	hangAfterEvents = false,
}: {
	signal: AbortSignal | undefined;
	connectDelayMs?: number;
	eventDelayMs?: number;
	events?: MockAnthropicEvent[];
	hangAfterEvents?: boolean;
}): MockAnthropicRequest {
	const response = new Response(null, {
		status: 200,
		headers: { "request-id": "req_mock" },
	});

	const stream: MockAnthropicStream = {
		async *[Symbol.asyncIterator]() {
			if (!events) {
				await waitForAbortAndThrowAbortError(signal);
				return;
			}
			if (eventDelayMs > 0) {
				await waitForDelayOrAbort(eventDelayMs, signal);
			}
			for (const event of events) {
				yield event;
			}
			if (hangAfterEvents) {
				await waitForAbortAndThrowAbortError(signal);
			}
		},
	};

	return {
		async withResponse() {
			if (connectDelayMs > 0) {
				await waitForDelayOrAbort(connectDelayMs, signal);
			}
			return {
				data: stream,
				response,
				request_id: response.headers.get("request-id"),
			};
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("anthropic first-event timeouts", () => {
	it("surfaces the canonical first-event timeout without an internal provider replay", async () => {
		let attempt = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempt += 1;
			return createAnthropicMockStream({
				signal: requestOptions?.signal,
				events: attempt === 1 ? undefined : createSuccessfulAnthropicEvents("must not replay"),
			}) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, context, {
			client,
			streamFirstEventTimeoutMs: 1,
			streamMaxRetries: 0,
			providerRetryWait,
		}).result();

		expect(attempt).toBe(1);
		expect(providerRetryWait).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Anthropic stream timed out while waiting for the first event");
		expect(result.errorMessage).toContain("elapsed=");
		expect(result.errorMessage).toContain("request_bytes=");
		expect(result.errorMessage).toContain("endpoint=canonical");
		expect(result.errorMessage).toContain("PI_STREAM_FIRST_EVENT_TIMEOUT_MS");
		expect(result.transportFailure?.providerCode).toBe("stream_first_event_timeout");
		expect(result.transportFailure?.endpointClass).toBe("canonical");
		expect(result.transportFailure?.retryMaxAttempts).toBe(2);
		expect(result.transportFailure?.requestBytes).toBeGreaterThan(0);
	});

	it("counts a consumed provider replay when reporting the timeout attempt ceiling", async () => {
		// The session counts a whole provider invocation as one attempt, so the
		// ceiling must bound TOTAL uploads: a small request whose first upload
		// 529'd (provider replay consumed one upload) and whose replay then timed
		// out must report the REMAINING ceiling, not the full two-attempt budget —
		// otherwise the session uploads the request a third time.
		let attempt = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempt += 1;
			if (attempt === 1) {
				return {
					async withResponse(): Promise<never> {
						const error = new Error("529 Overloaded");
						(error as Error & { status: number }).status = 529;
						throw error;
					},
				} as never;
			}
			const response = new Response(null, { status: 200 });
			const data: MockAnthropicStream = {
				async *[Symbol.asyncIterator]() {
					// Never yields a first event; resolves on abort so the process settles.
					await new Promise<void>(resolve => {
						const timer = setTimeout(resolve, 10_000);
						requestOptions?.signal?.addEventListener(
							"abort",
							() => {
								clearTimeout(timer);
								resolve();
							},
							{ once: true },
						);
					});
				},
			};
			return {
				async withResponse() {
					return { data, response, request_id: null };
				},
			} as never;
		}) as unknown as Anthropic["messages"]["create"];

		const result = await streamAnthropic(model, context, {
			client: { messages: { create } } as Anthropic,
			streamFirstEventTimeoutMs: 30,
			requestMaxRetries: 0,
			providerRetryWait: async () => {},
		}).result();

		expect(attempt).toBe(2);
		expect(result.stopReason).toBe("error");
		expect(result.transportFailure?.providerCode).toBe("stream_first_event_timeout");
		expect(result.transportFailure?.retryMaxAttempts).toBe(1);
	});

	it("does not upload a multi-megabyte body again after a full-window first-event timeout", async () => {
		let attempts = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempts += 1;
			return createAnthropicMockStream({ signal: requestOptions?.signal }) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, contextWithBytes(1_670_000), {
			client: { messages: { create } } as Anthropic,
			streamFirstEventTimeoutMs: 1,
			providerRetryWait,
		}).result();

		expect(attempts).toBe(1);
		expect(providerRetryWait).not.toHaveBeenCalled();
		expect(result.transportFailure).toMatchObject({
			providerCode: "stream_first_event_timeout",
			endpointClass: "canonical",
			retryMaxAttempts: 1,
		});
		expect(result.transportFailure?.requestBytes).toBeGreaterThan(1_000_000);
		expect(result.usage.totalTokens).toBe(0);
		expect(result.duration).toBeGreaterThanOrEqual(result.transportFailure?.firstEventElapsedMs ?? 0);
	});

	it("leaves a small first-event timeout replay to the session attempt ceiling", async () => {
		let attempts = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempts += 1;
			return createAnthropicMockStream({ signal: requestOptions?.signal }) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, context, {
			client: { messages: { create } } as Anthropic,
			streamFirstEventTimeoutMs: 1,
			providerRetryWait,
		}).result();

		expect(attempts).toBe(1);
		expect(providerRetryWait).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		expect(result.transportFailure).toMatchObject({
			providerCode: "stream_first_event_timeout",
			retryMaxAttempts: 2,
		});
		expect(result.usage.totalTokens).toBe(0);
	});

	it("gives custom endpoints bounded grace so a late 529 surfaces instead of a timeout", async () => {
		let attempts = 0;
		const providerRetryWait = vi.fn(async () => {});
		const create = ((_body: unknown) => {
			attempts += 1;
			const response = new Response(null, { status: 200 });
			const data: MockAnthropicStream = {
				[Symbol.asyncIterator]() {
					return {
						async next(): Promise<IteratorResult<MockAnthropicEvent>> {
							await Bun.sleep(5);
							const error = new Error(
								'529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
							);
							(error as Error & { status: number; error: { type: string } }).status = 529;
							(error as Error & { status: number; error: { type: string } }).error = {
								type: "overloaded_error",
							};
							throw error;
						},
					};
				},
			};
			return {
				async withResponse() {
					return { data, response, request_id: null };
				},
			} as never;
		}) as unknown as Anthropic["messages"]["create"];

		const injectedClient = {
			baseURL: "https://user:password@api.anthropic.com:8443/v1?token=secret",
			messages: { create },
		} as Anthropic;
		const result = await streamAnthropic(model, contextWithBytes(1_670_000), {
			client: injectedClient,
			streamFirstEventTimeoutMs: 1,
			providerRetryWait,
		}).result();

		expect(attempts).toBe(1);
		expect(providerRetryWait).not.toHaveBeenCalled();
		expect(result.errorStatus).toBe(529);
		expect(result.errorMessage).toContain("overloaded_error");
		expect(result.errorMessage).not.toContain("timed out while waiting for the first event");
		expect(result.errorMessage).not.toContain("password");
		expect(result.errorMessage).not.toContain("token=secret");
		expect(result.transportFailure).toMatchObject({
			requestBytes: expect.any(Number),
			endpointClass: "custom",
			retryMaxAttempts: 1,
		});
	});

	it("retains the large-request ceiling for a statusless socket failure during grace", async () => {
		let attempts = 0;
		const providerRetryWait = vi.fn(async () => {});
		const create = ((_body: unknown) => {
			attempts += 1;
			const response = new Response(null, { status: 200 });
			const data: MockAnthropicStream = {
				[Symbol.asyncIterator]() {
					return {
						async next(): Promise<IteratorResult<MockAnthropicEvent>> {
							await Bun.sleep(5);
							throw new Error("socket hang up");
						},
					};
				},
			};
			return {
				async withResponse() {
					return { data, response, request_id: null };
				},
			} as never;
		}) as unknown as Anthropic["messages"]["create"];
		const injectedClient = { baseURL: "https://proxy.example", messages: { create } } as unknown as Anthropic;

		const result = await streamAnthropic(model, contextWithBytes(1_670_000), {
			client: injectedClient,
			streamFirstEventTimeoutMs: 1,
			providerRetryWait,
		}).result();

		expect(attempts).toBe(1);
		expect(providerRetryWait).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("socket hang up");
		expect(result.transportFailure).toMatchObject({
			requestBytes: expect.any(Number),
			firstEventTimeoutMs: 1,
			endpointClass: "custom",
			retryMaxAttempts: 1,
		});
	});

	it("normalizes a primitive-string rejection so the upload ceiling survives", async () => {
		// An injected custom client (options.client is a supported surface) may
		// reject withResponse() with a plain string. Stamping facts on the boxed
		// temporary silently discarded them, so a ceiling-bound request slipped
		// past the one-attempt ceiling and a string-matched corrective branch
		// (CPA tool-alias restore) re-uploaded the multi-megabyte body.
		let attempts = 0;
		const create = ((_body: unknown) => {
			attempts += 1;
			return {
				async withResponse(): Promise<never> {
					throw 'cannot restore Claude OAuth MCP tool alias "mcp__srv__tok_tool": no unique request-local match';
				},
			} as never;
		}) as unknown as Anthropic["messages"]["create"];
		const injectedClient = { baseURL: "https://proxy.example", messages: { create } } as unknown as Anthropic;

		const result = await streamAnthropic(customModel("https://proxy.example"), contextWithBytes(1_670_000), {
			client: injectedClient,
			streamFirstEventTimeoutMs: 100,
		}).result();

		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.transportFailure).toMatchObject({
			requestBytes: expect.any(Number),
			endpointClass: "custom",
			retryMaxAttempts: 1,
		});
	});
	it("preserves transport metadata when normalizing a structured non-Error rejection", async () => {
		// Structured rejections from an injected client (e.g. `{ status, error,
		// headers }`) must keep their transport metadata through normalization so
		// status/provider-code extraction and managed-fallback classification
		// still work — the wrapper must not collapse them to "[object Object]".
		let attempts = 0;
		const create = ((_body: unknown) => {
			attempts += 1;
			return {
				async withResponse(): Promise<never> {
					throw {
						status: 529,
						error: { type: "overloaded_error", message: "Overloaded" },
						headers: { "request-id": "req_structured" },
					};
				},
			} as never;
		}) as unknown as Anthropic["messages"]["create"];
		const injectedClient = { baseURL: "https://proxy.example", messages: { create } } as unknown as Anthropic;

		const result = await streamAnthropic(customModel("https://proxy.example"), contextWithBytes(1_670_000), {
			client: injectedClient,
			streamFirstEventTimeoutMs: 100,
		}).result();

		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(529);
		expect(result.transportFailure).toMatchObject({
			status: 529,
			anthropicErrorType: "overloaded_error",
			requestBytes: expect.any(Number),
			endpointClass: "custom",
			retryMaxAttempts: 1,
		});
	});

	it("does not run strict-tool corrective replay after a large grace ceiling is reached", async () => {
		let attempts = 0;
		const create = ((_body: unknown) => {
			attempts += 1;
			const response = new Response(null, { status: 200 });
			const data: MockAnthropicStream = {
				[Symbol.asyncIterator]() {
					return {
						async next(): Promise<IteratorResult<MockAnthropicEvent>> {
							await Bun.sleep(5);
							const error = new Error("400 invalid_request_error: compiled grammar is too large");
							(error as Error & { status: number }).status = 400;
							throw error;
						},
					};
				},
			};
			return {
				async withResponse() {
					return { data, response, request_id: null };
				},
			} as never;
		}) as unknown as Anthropic["messages"]["create"];
		const injectedClient = { baseURL: "https://proxy.example", messages: { create } } as unknown as Anthropic;
		const strictContext: Context = {
			...contextWithBytes(1_670_000),
			tools: [
				{
					name: "edit",
					description: "Edit a value",
					strict: true,
					parameters: { type: "object", properties: {} },
				},
			],
		};

		const result = await streamAnthropic(model, strictContext, {
			client: injectedClient,
			streamFirstEventTimeoutMs: 1,
		}).result();

		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("compiled grammar is too large");
		expect(result.transportFailure?.retryMaxAttempts).toBe(1);
	});
	it("counts forced-tool corrective replays when reporting the timeout attempt ceiling", async () => {
		// A corrective replay (forced-tool fallback) resets providerRetryAttempt
		// before `continue`, so the earlier providerRetryAttempt-based accounting
		// reported the full two-attempt ceiling after two uploads had already
		// happened — licensing a third upload of the corrected request. Use this
		// route rather than strict-tool fallback because GJC_NO_STRICT/PI_NO_STRICT
		// intentionally removes strict markers before the request is sent.
		let attempts = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempts += 1;
			if (attempts === 1) {
				// Corrective path: forced tool_choice unsupported 400.
				return {
					async withResponse(): Promise<never> {
						const error = new Error("400 invalid_request_error: forced tool_choice is not supported");
						(error as Error & { status: number }).status = 400;
						throw error;
					},
				} as never;
			}
			// Corrected request then hangs until the first-event timeout.
			const response = new Response(null, { status: 200 });
			const data: MockAnthropicStream = {
				async *[Symbol.asyncIterator]() {
					await new Promise<void>(resolve => {
						const timer = setTimeout(resolve, 10_000);
						requestOptions?.signal?.addEventListener(
							"abort",
							() => {
								clearTimeout(timer);
								resolve();
							},
							{ once: true },
						);
					});
				},
			};
			return {
				async withResponse() {
					return { data, response, request_id: null };
				},
			} as never;
		}) as unknown as Anthropic["messages"]["create"];
		const injectedClient = { baseURL: "https://proxy.example", messages: { create } } as unknown as Anthropic;
		const forcedToolContext: Context = {
			messages: [{ role: "user", content: "small forced-tool request", timestamp: Date.now() }],
			tools: [
				{
					name: "edit",
					description: "Edit a value",
					parameters: { type: "object", properties: {} },
				},
			],
		};
		const forcedToolModel = { ...model, id: "claude-sonnet-4-5-timeout-forced-tool" };

		const result = await streamAnthropic(forcedToolModel, forcedToolContext, {
			client: injectedClient,
			streamFirstEventTimeoutMs: 30,
			toolChoice: { type: "tool", name: "edit" },
		}).result();

		expect(attempts).toBe(2);
		expect(result.stopReason).toBe("error");
		expect(result.transportFailure?.providerCode).toBe("stream_first_event_timeout");
		// Two uploads consumed (initial + corrective); small-request ceiling is 2,
		// so the remaining ceiling must be 1 — not the full 2.
		expect(result.transportFailure?.retryMaxAttempts).toBe(1);
	});
	it("counts a thinking-replay repair upload when reporting the timeout attempt ceiling", async () => {
		// The thinking-replay repair branch does not reset providerRetryAttempt,
		// so the resettable counter alone cannot see its corrective upload. A
		// small request whose repaired replay then times out must report the
		// REMAINING one-attempt ceiling, not the full two-attempt budget.
		const user = { role: "user" as const, content: "continue", timestamp: Date.now() };
		const thinkingAssistant = {
			role: "assistant" as const,
			content: [
				{ type: "thinking" as const, thinking: "signed reasoning", thinkingSignature: "sig_repair" },
				{ type: "text" as const, text: "prior answer" },
			],
			api: "anthropic-messages" as const,
			provider: "anthropic",
			model: model.id,
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
		const repairContext: Context = {
			messages: [user, thinkingAssistant, { ...user, content: "next prompt", timestamp: Date.now() + 1 }],
		};
		let attempts = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempts += 1;
			if (attempts === 1) {
				return {
					async withResponse(): Promise<never> {
						const error = new Error(
							"400 invalid_request_error: messages.1.content.0: Invalid `signature` in `thinking` block",
						);
						(error as Error & { status: number }).status = 400;
						throw error;
					},
				} as never;
			}
			// Repaired request then hangs until the first-event timeout.
			const response = new Response(null, { status: 200 });
			const data: MockAnthropicStream = {
				async *[Symbol.asyncIterator]() {
					await new Promise<void>(resolve => {
						const timer = setTimeout(resolve, 10_000);
						requestOptions?.signal?.addEventListener(
							"abort",
							() => {
								clearTimeout(timer);
								resolve();
							},
							{ once: true },
						);
					});
				},
			};
			return {
				async withResponse() {
					return { data, response, request_id: null };
				},
			} as never;
		}) as unknown as Anthropic["messages"]["create"];
		const injectedClient = { baseURL: "https://proxy.example", messages: { create } } as unknown as Anthropic;

		const result = await streamAnthropic(customModel("https://proxy.example"), repairContext, {
			client: injectedClient,
			streamFirstEventTimeoutMs: 30,
		}).result();

		expect(attempts).toBe(2);
		expect(result.stopReason).toBe("error");
		expect(result.transportFailure?.providerCode).toBe("stream_first_event_timeout");
		// Two uploads consumed (rejected replay + repaired replay); the small
		// ceiling is 2, so one attempt remains — not the full two.
		expect(result.transportFailure?.retryMaxAttempts).toBe(1);
	});

	it("counts a CPA alias-repair upload when reporting the timeout attempt ceiling", async () => {
		// The CPA alias-repair branch re-uploads the steered body without
		// touching providerRetryAttempt. Its corrective upload must consume the
		// timeout ceiling the same way, so the repaired request that then times
		// out reports the remaining one-attempt ceiling (issue #4464).
		const alias = "mcp__jzi2uzmxd57z__1olzmojrukyw_find";
		const findTool = {
			name: "find",
			description: "Find files",
			parameters: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] },
		};
		const cpaContext: Context = {
			messages: [{ role: "user", content: "find the config", timestamp: Date.now() }],
			tools: [findTool],
		};
		let attempts = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempts += 1;
			if (attempts === 1) {
				return {
					async withResponse(): Promise<never> {
						const error = new Error(
							`500 {"type":"error","error":{"type":"api_error","message":"restore Claude OAuth tool name from streaming response: cannot restore Claude OAuth MCP tool alias \\"${alias}\\": no unique request-local match"}}`,
						);
						(error as Error & { status: number }).status = 500;
						throw error;
					},
				} as never;
			}
			const response = new Response(null, { status: 200 });
			const data: MockAnthropicStream = {
				async *[Symbol.asyncIterator]() {
					await new Promise<void>(resolve => {
						const timer = setTimeout(resolve, 10_000);
						requestOptions?.signal?.addEventListener(
							"abort",
							() => {
								clearTimeout(timer);
								resolve();
							},
							{ once: true },
						);
					});
				},
			};
			return {
				async withResponse() {
					return { data, response, request_id: null };
				},
			} as never;
		}) as unknown as Anthropic["messages"]["create"];
		const injectedClient = { baseURL: "https://proxy.example", messages: { create } } as unknown as Anthropic;

		const result = await streamAnthropic(customModel("https://proxy.example"), cpaContext, {
			client: injectedClient,
			streamFirstEventTimeoutMs: 30,
		}).result();

		expect(attempts).toBe(2);
		expect(result.stopReason).toBe("error");
		expect(result.transportFailure?.providerCode).toBe("stream_first_event_timeout");
		expect(result.transportFailure?.retryMaxAttempts).toBe(1);
	});

	it("does not treat a delayed pre-message_start content block as semantic progress", async () => {
		let attempts = 0;
		const create = ((_body: unknown) => {
			attempts += 1;
			const response = new Response(null, { status: 200 });
			const data: MockAnthropicStream = {
				async *[Symbol.asyncIterator]() {
					await Bun.sleep(5);
					yield {
						type: "content_block_start",
						index: 0,
						content_block: { type: "text", text: "invalid preamble" },
					};
				},
			};
			return {
				async withResponse() {
					return { data, response, request_id: null };
				},
			} as never;
		}) as unknown as Anthropic["messages"]["create"];
		const injectedClient = { baseURL: "https://proxy.example", messages: { create } } as unknown as Anthropic;

		const result = await streamAnthropic(model, contextWithBytes(1_670_000), {
			client: injectedClient,
			streamFirstEventTimeoutMs: 1,
		}).result();

		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("received content_block_start before message_start");
		expect(result.transportFailure?.retryMaxAttempts).toBe(1);
	});

	it("does not attach first-event grace ceilings after message_start progress", async () => {
		const create = ((_body: unknown) => {
			const response = new Response(null, { status: 200 });
			const data: MockAnthropicStream = {
				async *[Symbol.asyncIterator]() {
					yield {
						type: "message_start",
						message: {
							id: "msg_progress_before_failure",
							usage: {
								input_tokens: 12,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						},
					};
					await Bun.sleep(5);
					const error = new Error("529 Overloaded after message_start");
					(error as Error & { status: number }).status = 529;
					throw error;
				},
			};
			return {
				async withResponse() {
					return { data, response, request_id: null };
				},
			} as never;
		}) as unknown as Anthropic["messages"]["create"];
		const injectedClient = { baseURL: "https://proxy.example", messages: { create } } as unknown as Anthropic;

		const result = await streamAnthropic(model, contextWithBytes(1_670_000), {
			client: injectedClient,
			streamFirstEventTimeoutMs: 1,
			streamIdleTimeoutMs: 5000,
			streamMaxRetries: 0,
		}).result();

		expect(result.errorStatus).toBe(529);
		expect(result.transportFailure?.retryMaxAttempts).toBeUndefined();
		expect(result.transportFailure?.requestBytes).toBeUndefined();
	});

	it("honors caller abort while a custom endpoint is inside its bounded grace", async () => {
		let attempts = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempts += 1;
			return createAnthropicMockStream({ signal: requestOptions?.signal }) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5);

		const result = await streamAnthropic(customModel("https://proxy.example"), contextWithBytes(1_670_000), {
			client: { messages: { create } } as Anthropic,
			signal: controller.signal,
			streamFirstEventTimeoutMs: 1,
		}).result();

		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).not.toContain("timed out while waiting for the first event");
	});

	it("surfaces redacted timeout facts after large custom-endpoint grace expires", async () => {
		vi.useFakeTimers();
		let attempts = 0;
		const streamStarted = Promise.withResolvers<void>();
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempts += 1;
			streamStarted.resolve();
			return createAnthropicMockStream({ signal: requestOptions?.signal }) as never;
		}) as unknown as Anthropic["messages"]["create"];

		const resultPromise = streamAnthropic(
			customModel("https://user:password@proxy.example/v1?token=secret"),
			contextWithBytes(1_670_000),
			{
				client: { messages: { create } } as Anthropic,
				streamFirstEventTimeoutMs: 1,
			},
		).result();
		await streamStarted.promise;
		for (let index = 0; index < 20 && vi.getTimerCount() === 0; index++) {
			await Promise.resolve();
		}
		expect(vi.getTimerCount()).toBeGreaterThan(0);
		vi.advanceTimersByTime(120_001);
		await Promise.resolve();
		await Promise.resolve();
		const result = await resultPromise;

		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("elapsed=120001ms");
		expect(result.errorMessage).toContain("endpoint=custom");
		expect(result.errorMessage).toContain("configured_timeout=1ms");
		expect(result.errorMessage).not.toContain("password");
		expect(result.errorMessage).not.toContain("token=secret");
		expect(result.transportFailure).toMatchObject({
			endpointClass: "custom",
			firstEventTimeoutMs: 1,
			retryMaxAttempts: 1,
		});
		expect(result.transportFailure?.requestBytes).toBeGreaterThan(1_000_000);
	});

	it("does not extend the configured first-event window for a small custom-endpoint request", async () => {
		let attempts = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempts += 1;
			return createAnthropicMockStream({ signal: requestOptions?.signal }) as never;
		}) as unknown as Anthropic["messages"]["create"];

		const result = await streamAnthropic(customModel("https://proxy.example"), context, {
			client: { messages: { create } } as Anthropic,
			streamFirstEventTimeoutMs: 1,
			streamMaxRetries: 0,
		}).result();

		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.transportFailure).toMatchObject({
			endpointClass: "custom",
			retryMaxAttempts: 2,
		});
		expect(result.duration).toBeLessThan(1_000);
	});

	it("preserves an explicit zero first-event timeout for a large custom-endpoint request", async () => {
		const controller = new AbortController();
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			return createAnthropicMockStream({ signal: requestOptions?.signal }) as never;
		}) as unknown as Anthropic["messages"]["create"];
		setTimeout(() => controller.abort(), 5);

		const result = await streamAnthropic(customModel("https://proxy.example"), contextWithBytes(1_670_000), {
			client: { messages: { create } } as Anthropic,
			signal: controller.signal,
			streamFirstEventTimeoutMs: 0,
		}).result();

		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).not.toContain("timed out while waiting for the first event");
	});

	it("surfaces large retry-after Anthropic 429s instead of first-event timeouts", async () => {
		let attempts = 0;
		const fetchMock = (async () => {
			attempts += 1;
			return new Response(
				JSON.stringify({
					type: "error",
					error: {
						type: "rate_limit_error",
						message: "This request would exceed your account's rate limit. Please try again later.",
					},
				}),
				{
					status: 429,
					headers: {
						"content-type": "application/json",
						"retry-after": "62291",
						"anthropic-ratelimit-unified-status": "rejected",
						"anthropic-ratelimit-unified-7d-status": "rejected",
						"anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
					},
				},
			);
		}) as FetchImpl;
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			streamFirstEventTimeoutMs: 1,
			providerRetryWait,
		}).result();

		expect(attempts).toBe(1);
		expect(providerRetryWait).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(429);
		expect(result.errorMessage).toContain("rate_limit_error");
		expect(result.errorMessage).toContain("This request would exceed your account's rate limit");
		expect(result.errorMessage).toContain("retry-after-ms=62291000");
		expect(result.errorMessage).toContain("anthropic-ratelimit-unified-overage-disabled-reason=out_of_credits");
		expect(result.errorMessage).not.toContain("timed out while waiting for the first event");
	});

	it("disables Anthropic SDK retries for a large custom request with a first-event ceiling", async () => {
		let attempts = 0;
		const fetchMock = (async () => {
			attempts += 1;
			return new Response(
				JSON.stringify({
					type: "error",
					error: { type: "overloaded_error", message: "Overloaded" },
				}),
				{ status: 529, headers: { "content-type": "application/json" } },
			);
		}) as FetchImpl;

		const result = await streamAnthropic(customModel("https://proxy.example"), contextWithBytes(1_670_000), {
			apiKey: "test-key",
			fetch: fetchMock,
			requestMaxRetries: 5,
			streamMaxRetries: 0,
			streamFirstEventTimeoutMs: 1,
		}).result();

		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(529);
		expect(result.errorMessage).toContain("overloaded_error");
	});
	it("does not re-upload a ceiling-bound request through the outer provider retry loop", async () => {
		let attempts = 0;
		const fetchMock = (async () => {
			attempts += 1;
			return new Response(
				JSON.stringify({
					type: "error",
					error: { type: "overloaded_error", message: "Overloaded" },
				}),
				{ status: 529, headers: { "content-type": "application/json" } },
			);
		}) as FetchImpl;

		const result = await streamAnthropic(customModel("https://proxy.example"), contextWithBytes(1_670_000), {
			apiKey: "test-key",
			fetch: fetchMock,
			requestMaxRetries: 5,
			// streamMaxRetries deliberately unset: the default budget must not
			// re-upload a ceiling-bound body that failed before stream iteration.
			streamFirstEventTimeoutMs: 1,
		}).result();

		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(529);
		expect(result.transportFailure).toMatchObject({
			requestBytes: expect.any(Number),
			endpointClass: "custom",
			retryMaxAttempts: 1,
		});
	});

	it("does not arm the Anthropic first-event watchdog before the stream connects", async () => {
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			return createAnthropicMockStream({
				signal: requestOptions?.signal,
				// Setup delay must dwarf the configured window so a watchdog that
				// (incorrectly) arms at request setup fires during the connect delay,
				// while the correct iteration-start arming still receives the
				// immediate events comfortably inside the window. The 1ms/2ms pair
				// this test used previously left the verdict to scheduler latency.
				connectDelayMs: 300,
				events: createSuccessfulAnthropicEvents("delayed connect"),
			}) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const result = await streamAnthropic(model, context, {
			client,
			streamFirstEventTimeoutMs: 100,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "delayed connect" }]);
	});

	it("does not count delayed response setup as first-event grace elapsed", async () => {
		const create = ((_body: unknown) => {
			const response = new Response(null, { status: 200 });
			const data: MockAnthropicStream = {
				[Symbol.asyncIterator]() {
					return {
						async next(): Promise<IteratorResult<MockAnthropicEvent>> {
							const error = new Error("529 immediately after delayed response setup");
							(error as Error & { status: number }).status = 529;
							throw error;
						},
					};
				},
			};
			return {
				async withResponse() {
					// Setup delay must dwarf the configured window so a clock that
					// (incorrectly) starts at request setup classifies this failure
					// as post-window, while the correct iteration-start clock does
					// not. The window itself must dwarf the few milliseconds of
					// unavoidable async-throw propagation so the boundary is not
					// decided by scheduler latency (the 1ms/5ms pair this test used
					// previously made the outcome a coin flip on runner speed).
					await Bun.sleep(300);
					return { data, response, request_id: null };
				},
			} as never;
		}) as unknown as Anthropic["messages"]["create"];
		const injectedClient = { baseURL: "https://proxy.example", messages: { create } } as unknown as Anthropic;

		const result = await streamAnthropic(model, contextWithBytes(1_670_000), {
			client: injectedClient,
			streamFirstEventTimeoutMs: 100,
			streamMaxRetries: 0,
		}).result();

		expect(result.errorStatus).toBe(529);
		expect(result.transportFailure?.retryMaxAttempts).toBeUndefined();
		expect(result.transportFailure?.firstEventElapsedMs).toBeUndefined();
	});

	it("retries an in-window 529 after delayed response setup under the default retry budget", async () => {
		// The complement of the grace ceiling: a failure that lands inside the
		// configured first-event window (setup excluded) is an ordinary transient
		// provider failure and must keep its provider retry budget — the delayed
		// setup must not turn it into an exhausted one-attempt ceiling.
		let attempts = 0;
		const create = ((_body: unknown) => {
			attempts += 1;
			if (attempts === 1) {
				const response = new Response(null, { status: 200 });
				const data: MockAnthropicStream = {
					[Symbol.asyncIterator]() {
						return {
							async next(): Promise<IteratorResult<MockAnthropicEvent>> {
								const error = new Error("529 immediately after delayed response setup");
								(error as Error & { status: number }).status = 529;
								throw error;
							},
						};
					},
				};
				return {
					async withResponse() {
						await Bun.sleep(300);
						return { data, response, request_id: null };
					},
				} as never;
			}
			return createAnthropicMockStream({
				signal: undefined,
				events: createSuccessfulAnthropicEvents("recovered after delayed setup"),
			}) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const injectedClient = { baseURL: "https://proxy.example", messages: { create } } as unknown as Anthropic;
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, contextWithBytes(1_670_000), {
			client: injectedClient,
			streamFirstEventTimeoutMs: 100,
			providerRetryWait,
		}).result();

		expect(attempts).toBe(2);
		expect(providerRetryWait).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "recovered after delayed setup" }]);
	});

	it("accepts an eventual first event inside the configured window", async () => {
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			return createAnthropicMockStream({
				signal: requestOptions?.signal,
				eventDelayMs: 2,
				events: createSuccessfulAnthropicEvents("eventual first byte"),
			}) as never;
		}) as unknown as Anthropic["messages"]["create"];

		const result = await streamAnthropic(model, context, {
			client: { messages: { create } } as Anthropic,
			streamFirstEventTimeoutMs: 20,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "eventual first byte" }]);
	});

	it("keeps caller aborts as aborted instead of retrying them as first-event timeouts", async () => {
		let attempt = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempt += 1;
			return createAnthropicMockStream({ signal: requestOptions?.signal }) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const controller = new AbortController();
		setTimeout(() => controller.abort(), 1);

		const result = await streamAnthropic(model, context, {
			client,
			signal: controller.signal,
			streamFirstEventTimeoutMs: 10,
		}).result();

		expect(attempt).toBe(1);
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).not.toBe("Anthropic stream timed out while waiting for the first event");
		expect((result.errorMessage ?? "").toLowerCase()).toContain("abort");
	});

	it("stops a transient provider retry when the caller aborts during backoff", async () => {
		let attempts = 0;
		const create = ((_body: unknown) => {
			attempts += 1;
			return {
				async withResponse() {
					const error = new Error("529 Overloaded");
					(error as Error & { status: number }).status = 529;
					throw error;
				},
			} as never;
		}) as unknown as Anthropic["messages"]["create"];
		const controller = new AbortController();
		const providerRetryWait = vi.fn(async (_delayMs: number, signal?: AbortSignal) => {
			controller.abort();
			await waitForDelayOrAbort(1, signal);
		});

		const result = await streamAnthropic(model, context, {
			client: { messages: { create } } as Anthropic,
			signal: controller.signal,
			providerRetryWait,
		}).result();

		expect(attempts).toBe(1);
		expect(providerRetryWait).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("aborted");
	});
	it("fails hung Anthropic streams between tool-call events instead of waiting forever", async () => {
		let attempt = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempt += 1;
			return createAnthropicMockStream({
				signal: requestOptions?.signal,
				events: [
					{
						type: "message_start",
						message: {
							id: "msg_stalled_tool",
							usage: {
								input_tokens: 12,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						},
					},
					{
						type: "content_block_start",
						index: 0,
						content_block: {
							type: "tool_use",
							id: "toolu_stalled_todo",
							name: "todo_write",
							input: {},
						},
					},
				],
				hangAfterEvents: true,
			}) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const result = await streamAnthropic(model, context, {
			client,
			streamFirstEventTimeoutMs: 5000,
			streamIdleTimeoutMs: 1,
		}).result();

		expect(attempt).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Anthropic stream stalled while waiting for the next event");
		expect(result.content).toEqual([
			{
				type: "toolCall",
				id: "toolu_stalled_todo",
				name: "todo_write",
				arguments: {},
			},
		]);
	});

	it("does not let Anthropic ping events keep a stalled response alive", async () => {
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			const response = new Response(null, { status: 200, headers: { "request-id": "req_ping_stall" } });
			const data: MockAnthropicStream = {
				async *[Symbol.asyncIterator]() {
					yield {
						type: "message_start",
						message: {
							id: "msg_ping_stall",
							usage: {
								input_tokens: 12,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						},
					};
					yield {
						type: "content_block_start",
						index: 0,
						content_block: { type: "text", text: "" },
					};
					yield {
						type: "content_block_delta",
						index: 0,
						delta: { type: "text_delta", text: "checking" },
					};
					while (!requestOptions?.signal?.aborted) {
						await Bun.sleep(1);
						yield { type: "ping" };
					}
				},
			};
			return {
				async withResponse() {
					return { data, response, request_id: "req_ping_stall" };
				},
			} as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const result = await streamAnthropic(model, context, {
			client,
			streamFirstEventTimeoutMs: 5000,
			streamIdleTimeoutMs: 5,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Anthropic stream stalled while waiting for the next event");
	});

	it("does not let pre-message_start pings rearm the first-event deadline", async () => {
		const controller = new AbortController();
		const abortFallback = setTimeout(() => controller.abort(), 50);
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			const response = new Response(null, { status: 200 });
			const data: MockAnthropicStream = {
				async *[Symbol.asyncIterator]() {
					while (!requestOptions?.signal?.aborted) {
						await Bun.sleep(1);
						yield { type: "ping" };
					}
				},
			};
			return {
				async withResponse() {
					return { data, response, request_id: null };
				},
			} as never;
		}) as unknown as Anthropic["messages"]["create"];

		const result = await streamAnthropic(model, context, {
			client: { messages: { create } } as Anthropic,
			signal: controller.signal,
			streamFirstEventTimeoutMs: 5,
			streamIdleTimeoutMs: 5000,
			streamMaxRetries: 0,
		}).result();
		clearTimeout(abortFallback);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("timed out while waiting for the first event");
	});
});

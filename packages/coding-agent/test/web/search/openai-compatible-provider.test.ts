import { afterEach, describe, expect, it, vi } from "bun:test";
import { hookFetch } from "@gajae-code/utils";
import type { AuthStorage } from "../../../src/session/auth-storage";
import { OpenAICompatibleSearchProvider } from "../../../src/web/search/providers/openai-compatible";
import { runWithSearchTimeout, SEARCH_LLM_TIMEOUT_MS } from "../../../src/web/search/providers/utils";
import { type ActiveSearchModelContext, SearchProviderError } from "../../../src/web/search/types";

function auth(keys: Record<string, string> = {}): AuthStorage {
	return {
		getApiKey: (provider: string) => keys[provider],
	} as unknown as AuthStorage;
}

const baseCtx: ActiveSearchModelContext = {
	provider: "custom",
	modelId: "gpt-5-mini",
	api: "openai-responses",
	baseUrl: "https://llm.example/v1",
	headers: { "X-Test": "yes" },
};

function params(ctx: ActiveSearchModelContext = baseCtx, store = auth({ custom: "sk-custom" })) {
	return { query: "news", systemPrompt: "search", authStorage: store, activeModelContext: ctx };
}

const streamCitation = { type: "url_citation", url: "https://stream.example", title: "Stream", text: "quoted" };
const completedSnapshot = {
	id: "stream-response",
	status: "completed",
	output: [
		{ type: "message", status: "completed", content: [{ text: "grounded answer", annotations: [streamCitation] }] },
	],
};

function sse(data: unknown, event?: string): string {
	return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}

function streamedResponse(data: string, fragmentBytes = Infinity): Response {
	const bytes = new TextEncoder().encode(data);
	let offset = 0;
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				if (offset >= bytes.length) {
					controller.close();
					return;
				}
				const end = Math.min(offset + fragmentBytes, bytes.length);
				controller.enqueue(bytes.subarray(offset, end));
				offset = end;
			},
		}),
		{ headers: { "Content-Type": "text/event-stream; charset=utf-8" } },
	);
}

function openBody(data: string) {
	const read = Promise.withResolvers<void>();
	const cancelled = Promise.withResolvers<unknown>();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(data));
		},
		pull() {
			read.resolve();
		},
		cancel(reason) {
			cancelled.resolve(reason);
		},
	});
	return { body, read: read.promise, cancelled: cancelled.promise };
}

afterEach(() => vi.restoreAllMocks());

describe("OpenAI-compatible web search provider", () => {
	it("sends Responses requests with the web_search tool", async () => {
		let body: { model?: unknown; tools?: unknown; stream?: unknown } | undefined;
		using _hook = hookFetch(async (_input, init) => {
			body = JSON.parse(String(init?.body)) as { model?: unknown; tools?: unknown; stream?: unknown };
			return Response.json({
				id: "r1",
				output_text: "answer",
				output: [{ content: [{ annotations: [{ type: "url_citation", url: "https://a.example", title: "A" }] }] }],
			});
		});
		await new OpenAICompatibleSearchProvider().search(params());
		expect(body?.tools).toEqual([{ type: "web_search" }]);
		expect(body?.model).toBe("gpt-5-mini");
		expect(body?.stream).toBe(true);
	});

	it("falls back to Chat Completions with web_search_options when /responses is absent", async () => {
		for (const status of [404, 405]) {
			let body:
				| { messages?: Array<{ content?: unknown }>; web_search_options?: unknown; stream?: unknown }
				| undefined;
			const urls: string[] = [];
			const requestHeaders: Headers[] = [];
			using _hook = hookFetch(async (input, init) => {
				const url = String(input);
				urls.push(url);
				requestHeaders.push(new Headers(init?.headers));
				if (url.endsWith("/responses")) return new Response("unavailable", { status });
				body = JSON.parse(String(init?.body)) as {
					messages?: Array<{ content?: unknown }>;
					web_search_options?: unknown;
					stream?: unknown;
				};
				return Response.json({
					choices: [
						{
							message: {
								content: "answer",
								annotations: [{ type: "url_citation", url: "https://b.example", title: "B" }],
							},
						},
					],
				});
			});
			const result = await new OpenAICompatibleSearchProvider().search(
				params({ ...baseCtx, api: "openai-completions" }),
			);
			expect(urls).toEqual(["https://llm.example/v1/responses", "https://llm.example/v1/chat/completions"]);
			expect(requestHeaders).toHaveLength(2);
			for (const headers of requestHeaders) {
				expect(headers.get("Authorization")).toBe("Bearer sk-custom");
				expect(headers.get("X-Test")).toBe("yes");
			}
			expect(body?.web_search_options).toEqual({});
			expect(body?.stream).toBe(true);
			expect(body?.messages?.[1]?.content).toBe("news");
			expect(result.sources).toEqual([{ title: "B", url: "https://b.example", snippet: undefined }]);
		}
	});

	it("succeeds on streaming-only servers without probing a non-streaming request", async () => {
		const bodies: Record<string, unknown>[] = [];
		using _hook = hookFetch(async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			bodies.push(body);
			if (body.stream !== true) return new Response("Stream must be set to true", { status: 400 });
			return streamedResponse(sse({ type: "response.completed", response: completedSnapshot }));
		});
		const result = await new OpenAICompatibleSearchProvider().search(params());
		expect(bodies).toHaveLength(1);
		expect(bodies[0]?.stream).toBe(true);
		expect(result.answer).toBe("grounded answer");
		expect(result.sources).toEqual([{ title: "Stream", url: "https://stream.example", snippet: "quoted" }]);
	});

	it("does not retry or fall back on HTTP errors other than 404/405", async () => {
		for (const status of [400, 401, 403, 429, 500]) {
			const urls: string[] = [];
			using _hook = hookFetch(async input => {
				urls.push(String(input));
				return new Response("Stream must be set to true", { status });
			});
			await expect(new OpenAICompatibleSearchProvider().search(params())).rejects.toMatchObject({
				provider: "openai-compatible",
				status,
			});
			expect(urls).toEqual(["https://llm.example/v1/responses"]);
		}
	});

	it("keeps HTTP error classification ahead of SSE parsing", async () => {
		for (const status of [401, 402, 403, 429]) {
			using _hook = hookFetch(
				async () =>
					new Response("quota exhausted", {
						status,
						headers: { "Content-Type": "text/event-stream" },
					}),
			);
			await expect(new OpenAICompatibleSearchProvider().search(params())).rejects.toMatchObject({
				provider: "openai-compatible",
				status,
				message: "openai-compatible: credits exhausted",
			});
		}
	});

	it("uses the terminal Responses snapshot across fragmented CRLF and UTF-8 SSE", async () => {
		const snapshot = {
			id: "resp-fragmented",
			status: "completed",
			output: [
				{ type: "web_search_call", status: "completed" },
				{
					type: "message",
					status: "completed",
					content: [
						{
							text: "서울 café",
							annotations: [
								streamCitation,
								streamCitation,
								{ type: "url_citation", url: "https://second.example", title: "Second" },
							],
						},
					],
				},
			],
		};
		const terminal = JSON.stringify({ response: snapshot }, null, 2)
			.split("\n")
			.map(line => `data: ${line}`)
			.join("\n");
		const data = [
			": keepalive\n\n",
			sse({ type: "response.created", response: { id: "ignored-initial-id", status: "in_progress" } }),
			sse({ type: "response.output_text.delta", delta: "duplicated stale delta" }),
			sse({ type: "response.output_item.done", output_index: 1, item: snapshot.output[1] }),
			`event: response.completed\n${terminal}\n\n`,
			"data: [DONE]\n\n",
		]
			.join("")
			.replaceAll("\n", "\r\n");
		using _hook = hookFetch(async () => streamedResponse(data, 1));
		const result = await new OpenAICompatibleSearchProvider().search({ ...params(), limit: 1 });
		expect(result.answer).toBe("서울 café");
		expect(result.requestId).toBe("resp-fragmented");
		expect(result.sources).toEqual([{ title: "Stream", url: "https://stream.example", snippet: "quoted" }]);
		expect(result.citations).toEqual([
			{ title: "Stream", url: "https://stream.example", citedText: "quoted" },
			{ title: "Second", url: "https://second.example", citedText: undefined },
		]);
	});

	it("keeps JSON and both Responses terminal event forms equivalent", async () => {
		let terminalType: string | undefined;
		using _hook = hookFetch(async () =>
			terminalType
				? streamedResponse(sse({ type: terminalType, response: completedSnapshot }).trimEnd())
				: Response.json(completedSnapshot),
		);
		const expected = await new OpenAICompatibleSearchProvider().search(params());
		for (const type of ["response.completed", "response.done"]) {
			terminalType = type;
			expect(await new OpenAICompatibleSearchProvider().search(params())).toEqual(expected);
		}
	});

	it("cancels absent Responses bodies before streaming Chat fallback and accumulates first-choice annotations", async () => {
		for (const status of [404, 405]) {
			const absent = openBody("unavailable");
			let absentCancelled = false;
			void absent.cancelled.then(() => {
				absentCancelled = true;
			});
			const requests: Record<string, unknown>[] = [];
			const data = [
				sse({ id: "chat-stream", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }),
				sse({
					choices: [
						{
							index: 1,
							delta: {
								content: "ignored",
								annotations: [{ type: "url_citation", url: "https://ignored.example" }],
							},
							finish_reason: "length",
						},
						{ index: 0, delta: { content: "grounded ", annotations: [streamCitation] } },
					],
				}),
				sse({ choices: [{ index: 0, delta: { content: "answer" } }] }),
				sse({
					choices: [
						{
							index: 0,
							delta: {
								annotations: [
									streamCitation,
									{ type: "url_citation", url_citation: { url: "https://second.example", title: "Second" } },
								],
							},
						},
					],
				}),
				sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
				"data: [DONE]\n\n",
			].join("");
			const chat = openBody(data);
			using _hook = hookFetch(async (input, init) => {
				requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
				if (String(input).endsWith("/responses")) return new Response(absent.body, { status });
				expect(absentCancelled).toBe(true);
				expect(absent.body.locked).toBe(false);
				return new Response(chat.body, { headers: { "Content-Type": "text/event-stream" } });
			});
			const result = await new OpenAICompatibleSearchProvider().search({ ...params(), numSearchResults: 1 });
			expect(requests.map(request => request.stream)).toEqual([true, true]);
			expect(requests[1]?.web_search_options).toEqual({});
			expect(result.answer).toBe("grounded answer");
			expect(result.requestId).toBe("chat-stream");
			expect(result.sources).toEqual([{ title: "Stream", url: "https://stream.example", snippet: "quoted" }]);
			expect(result.citations).toHaveLength(2);
			await chat.cancelled;
			expect(chat.body.locked).toBe(false);
		}
	});

	it("retains positive Chat search usage before or after stop for inline citation recovery", async () => {
		for (const usageAfterStop of [false, true]) {
			const usage = sse({ choices: [], tool_usage: { web_search: { num_requests: 2 } } });
			const answer = sse({
				id: "chat-inline",
				choices: [{ index: 0, delta: { content: "See [Bun](https://bun.com/)." }, finish_reason: "stop" }],
			});
			const data =
				(usageAfterStop ? answer + usage : usage + answer) +
				sse({ choices: [], tool_usage: { web_search: { num_requests: 0 } } }) +
				"data: [DONE]\n\n";
			using _hook = hookFetch(async input =>
				String(input).endsWith("/responses")
					? new Response("not found", { status: 404 })
					: streamedResponse(data, 3),
			);
			const result = await new OpenAICompatibleSearchProvider().search(params());
			expect(result.sources.map(source => source.url)).toEqual(["https://bun.com/"]);
			expect(result.requestId).toBe("chat-inline");
			expect(result.citations).toBeUndefined();
		}
	});

	it("rejects completed ungrounded streams, including guessed URLs and unrelated annotations", async () => {
		for (const chat of [false, true]) {
			for (const numRequests of [undefined, 0, -1, "1"]) {
				const toolUsage = { web_search: { num_requests: numRequests } };
				const content = "See https://guessed.example/ for details.";
				const annotations = [{ type: "source", url: "https://metadata.example" }];
				const data = chat
					? `${sse({
							tool_usage: toolUsage,
							choices: [{ index: 0, delta: { content, annotations }, finish_reason: "stop" }],
						})}data: [DONE]\n\n`
					: sse({
							type: "response.completed",
							response: {
								status: "completed",
								tool_usage: toolUsage,
								output: [{ content: [{ text: content, annotations }] }],
							},
						});
				using _hook = hookFetch(async input =>
					chat && String(input).endsWith("/responses")
						? new Response("not found", { status: 404 })
						: streamedResponse(data),
				);
				await expect(new OpenAICompatibleSearchProvider().search(params())).rejects.toMatchObject({
					provider: "openai-compatible",
					status: 424,
				});
			}
		}
	});

	it("does not merge earlier search evidence into nonempty canonical Responses output", async () => {
		const answer = { type: "message", content: [{ text: "See [Bun](https://bun.com/)." }] };
		for (const searched of [false, true]) {
			const data =
				sse({
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "web_search_call", status: "completed" },
				}) +
				sse({
					type: "response.completed",
					response: {
						status: "completed",
						output: searched ? [{ type: "web_search_call", status: "completed" }, answer] : [answer],
					},
				});
			using _hook = hookFetch(async () => streamedResponse(data));
			const search = new OpenAICompatibleSearchProvider().search(params());
			if (searched) {
				expect((await search).sources.map(source => source.url)).toEqual(["https://bun.com/"]);
			} else {
				await expect(search).rejects.toMatchObject({ provider: "openai-compatible", status: 424 });
			}
		}
	});

	it("reconstructs sparse Responses terminal output from completed indexed items without duplicating them", async () => {
		for (const output of [undefined, []]) {
			const finalMessage = {
				type: "message",
				status: "completed",
				content: [{ type: "output_text", text: "서울 café", annotations: [streamCitation] }],
			};
			const data = [
				sse({ type: "response.output_text.delta", delta: "must not accumulate this" }),
				sse({ type: "response.output_item.done", output_index: 4, item: completedSnapshot.output[0] }),
				sse({
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "web_search_call", status: "completed" },
				}),
				sse({ type: "response.output_item.done", output_index: 2, item: { type: "reasoning", summary: [] } }),
				sse({ type: "response.output_item.done", output_index: 4, item: finalMessage }),
				sse({ type: "response.completed", response: { id: "sparse-response", status: "completed", output } }),
				"data: [DONE]\n\n",
			].join("");
			using _hook = hookFetch(async () => streamedResponse(data, 1));
			const result = await new OpenAICompatibleSearchProvider().search({ ...params(), limit: 1 });
			expect(result.answer).toBe("서울 café");
			expect(result.requestId).toBe("sparse-response");
			expect(result.sources).toEqual([{ title: "Stream", url: "https://stream.example", snippet: "quoted" }]);
			expect(result.citations).toEqual([{ title: "Stream", url: "https://stream.example", citedText: "quoted" }]);
		}
	});

	it("recovers inline sources from sparse Responses output only with independent search proof", async () => {
		for (const proof of ["item", "usage", "none"]) {
			const message = {
				type: "message",
				status: "completed",
				content: [
					{ type: "output_text", text: "Read [Bun 1.3](https://bun.com/blog/bun-v1.3.0).", annotations: [] },
				],
			};
			const data = [
				proof === "item"
					? sse({
							type: "response.output_item.done",
							output_index: 0,
							item: { type: "web_search_call", status: "completed" },
						})
					: "",
				sse({ type: "response.output_item.done", output_index: 4, item: message }),
				sse({
					type: "response.completed",
					response: {
						id: "sparse-inline",
						status: "completed",
						output: [],
						tool_usage: proof === "usage" ? { web_search: { num_requests: 4 } } : undefined,
					},
				}),
			].join("");
			using _hook = hookFetch(async () => streamedResponse(data));
			const search = new OpenAICompatibleSearchProvider().search(params());
			if (proof === "none") {
				await expect(search).rejects.toMatchObject({ provider: "openai-compatible", status: 424 });
				continue;
			}
			const result = await search;
			expect(result.answer).toBe(message.content[0]?.text);
			expect(result.sources.map(source => source.url)).toEqual(["https://bun.com/blog/bun-v1.3.0"]);
			expect(result.requestId).toBe("sparse-inline");
		}
	});

	it("orders reconstructed messages by output_index and keeps a nonempty terminal output authoritative", async () => {
		const message = (text: string) => ({
			type: "message",
			status: "completed",
			content: [{ text, annotations: [streamCitation] }],
		});
		for (const canonical of [false, true]) {
			const data = [
				sse({ type: "response.output_item.done", output_index: 8, item: message("second") }),
				sse({ type: "response.output_item.done", output_index: 2, item: message("first") }),
				sse({
					type: "response.done",
					response: { status: "completed", output: canonical ? [message("canonical only")] : [] },
				}),
			].join("");
			using _hook = hookFetch(async () => streamedResponse(data));
			const result = await new OpenAICompatibleSearchProvider().search(params());
			expect(result.answer).toBe(canonical ? "canonical only" : "first\nsecond");
			expect(result.citations).toHaveLength(1);
		}
	});

	it("rejects malformed or unfinished Responses output_item.done entries", async () => {
		const item = completedSnapshot.output[0];
		const invalidEvents = [
			...[undefined, -1, 1.5, "0"].map(outputIndex => ({ output_index: outputIndex, item })),
			...[
				undefined,
				null,
				[],
				{},
				{ content: [] },
				{ ...item, status: undefined },
				{ ...item, status: "in_progress" },
				{ ...item, status: "incomplete" },
				{ ...item, content: "secret" },
				{ ...item, content: [{ annotations: "secret" }] },
			].map(value => ({ output_index: 0, item: value })),
		];
		for (const event of invalidEvents) {
			const data =
				sse({ type: "response.output_item.done", ...event }) +
				sse({ type: "response.completed", response: completedSnapshot });
			using _hook = hookFetch(async () => streamedResponse(data));
			try {
				await new OpenAICompatibleSearchProvider().search(params());
				throw new Error("Expected malformed completed item to fail");
			} catch (error) {
				expect(error).toMatchObject({ provider: "openai-compatible", status: 502 });
				expect((error as Error).message).not.toContain("secret");
				expect((error as Error).message.length).toBeLessThan(200);
			}
		}
	});

	it("rejects completed output items, EOF, or DONE without a successful Responses terminal", async () => {
		const doneItems = sse({ type: "response.output_item.done", output_index: 0, item: completedSnapshot.output[0] });
		for (const data of [
			"",
			"data: [DONE]\n\n",
			doneItems,
			`${doneItems}data: [DONE]\n\n`,
			doneItems + sse({ type: "response.failed", response: { status: "failed", output: [] } }),
			doneItems + sse({ type: "response.incomplete", response: { status: "incomplete", output: [] } }),
		]) {
			using _hook = hookFetch(async () => streamedResponse(data));
			await expect(new OpenAICompatibleSearchProvider().search(params())).rejects.toMatchObject({
				provider: "openai-compatible",
				status: 502,
			});
		}
	});

	it("rejects failed, incomplete, error, and malformed Responses terminals without exposing event data", async () => {
		const secret = "stream-secret";
		const invalid = [
			sse({ type: "response.failed", response: { ...completedSnapshot, error: { message: secret } } }),
			sse({ type: "response.incomplete", response: completedSnapshot }),
			sse({ type: "error", message: secret }),
			sse({ error: { message: secret } }),
			`event: error\ndata: ${secret}\n\n`,
			sse({ type: "response.completed", response: completedSnapshot }, "response.failed"),
			...[
				undefined,
				null,
				[],
				{},
				{ ...completedSnapshot, status: "failed" },
				{ ...completedSnapshot, status: "incomplete" },
				{ ...completedSnapshot, status: "in_progress" },
				{ ...completedSnapshot, status: undefined },
				{ ...completedSnapshot, error: { message: secret } },
				{ ...completedSnapshot, incomplete_details: { reason: secret } },
				{ ...completedSnapshot, output: secret },
				{ ...completedSnapshot, output: [{ content: [{ annotations: secret }] }] },
			].map(response => sse({ type: "response.done", response })),
			`data: ${secret.repeat(1_000)}\n\n`,
			sse(null),
			sse([]),
			sse(secret),
		];
		for (const data of invalid) {
			using _hook = hookFetch(async () => streamedResponse(data));
			try {
				await new OpenAICompatibleSearchProvider().search(params());
				throw new Error("Expected malformed stream to fail");
			} catch (error) {
				expect(error).toBeInstanceOf(SearchProviderError);
				expect(error).toMatchObject({ provider: "openai-compatible", status: 502 });
				expect((error as Error).message).not.toContain(secret);
				expect((error as Error).message.length).toBeLessThan(200);
			}
		}
	});

	it("rejects unsuccessful canonical output items in both SSE and JSON responses", async () => {
		for (const type of ["response.completed", "response.done"]) {
			for (const status of ["failed", "incomplete", "in_progress"]) {
				for (const output of [
					[{ ...completedSnapshot.output[0], status }],
					[
						{ type: "web_search_call", status },
						{ type: "message", status: "completed", content: [{ text: "See https://inline.example/source" }] },
					],
				]) {
					const snapshot = { ...completedSnapshot, output };
					let streamed = true;
					using _hook = hookFetch(async () =>
						streamed ? streamedResponse(sse({ type, response: snapshot })) : Response.json(snapshot),
					);
					await expect(new OpenAICompatibleSearchProvider().search(params())).rejects.toMatchObject({
						provider: "openai-compatible",
						status: 502,
					});
					streamed = false;
					await expect(new OpenAICompatibleSearchProvider().search(params())).rejects.toMatchObject({
						provider: "openai-compatible",
						status: 502,
					});
				}
			}
		}
	});

	it("rejects unsuccessful JSON response snapshots and Chat completions", async () => {
		const invalidResponses = [
			{ ...completedSnapshot, status: "failed" },
			{ ...completedSnapshot, status: "incomplete" },
			{ ...completedSnapshot, incomplete_details: { reason: "max_output_tokens" } },
			{ ...completedSnapshot, error: { message: "provider failed" } },
			{ ...completedSnapshot, output: [{ ...completedSnapshot.output[0], status: "incomplete" }] },
		];
		for (const responseBody of invalidResponses) {
			using _hook = hookFetch(async () => Response.json(responseBody));
			await expect(new OpenAICompatibleSearchProvider().search(params())).rejects.toMatchObject({
				provider: "openai-compatible",
				status: 502,
			});
		}
		for (const finishReason of ["length", "content_filter", "tool_calls", null]) {
			using _hook = hookFetch(async input =>
				String(input).endsWith("/responses")
					? new Response("not found", { status: 404 })
					: Response.json({
							choices: [
								{
									message: { content: "partial", annotations: [streamCitation] },
									finish_reason: finishReason,
								},
							],
						}),
			);
			await expect(
				new OpenAICompatibleSearchProvider().search(params({ ...baseCtx, api: "openai-completions" })),
			).rejects.toMatchObject({ provider: "openai-compatible", status: 502 });
		}
	});

	it("requires the first Chat choice to finish successfully before DONE or EOF", async () => {
		for (const finishReason of [
			undefined,
			null,
			"length",
			"content_filter",
			"tool_calls",
			"function_call",
			"unknown",
		]) {
			for (const ending of ["", "data: [DONE]\n\n"]) {
				const data =
					sse({
						choices: [
							{
								index: 0,
								delta: { content: "partial", annotations: [streamCitation] },
								finish_reason: finishReason,
							},
						],
					}) + ending;
				using _hook = hookFetch(async input =>
					String(input).endsWith("/responses")
						? new Response("not found", { status: 404 })
						: streamedResponse(data),
				);
				await expect(new OpenAICompatibleSearchProvider().search(params())).rejects.toMatchObject({
					provider: "openai-compatible",
					status: 502,
				});
			}
		}
	});

	it("does not use another Chat choice's completion or grounding for the first choice", async () => {
		for (const firstCompleted of [false, true]) {
			const data = `${sse({
				choices: [
					{
						index: 0,
						delta: { content: "See https://guessed.example/" },
						finish_reason: firstCompleted ? "stop" : null,
					},
					{
						index: 1,
						delta: { content: "grounded answer", annotations: [streamCitation] },
						finish_reason: "stop",
					},
				],
			})}data: [DONE]\n\n`;
			using _hook = hookFetch(async input =>
				String(input).endsWith("/responses") ? new Response("not found", { status: 404 }) : streamedResponse(data),
			);
			await expect(new OpenAICompatibleSearchProvider().search(params())).rejects.toMatchObject({
				provider: "openai-compatible",
				status: firstCompleted ? 424 : 502,
			});
		}
	});

	it("rejects malformed Chat chunks and failures even after a grounded stop", async () => {
		const stopped = sse({
			choices: [{ index: 0, delta: { content: "answer", annotations: [streamCitation] }, finish_reason: "stop" }],
		});
		for (const invalid of [
			sse({ choices: "secret" }),
			sse({ choices: [{ index: 0, delta: "secret" }] }),
			sse({ choices: [{ index: 0, delta: { content: { secret: true } } }] }),
			sse({ choices: [{ index: 0, delta: { annotations: "secret" } }] }),
			sse({ choices: [{ index: 0, delta: { content: "extra text" } }] }),
			sse({ error: { message: "secret" } }),
			"event: error\ndata: secret\n\n",
			"data: secret\n\n",
		]) {
			using _hook = hookFetch(async input =>
				String(input).endsWith("/responses")
					? new Response("not found", { status: 404 })
					: streamedResponse(`${stopped + invalid}data: [DONE]\n\n`),
			);
			try {
				await new OpenAICompatibleSearchProvider().search(params());
				throw new Error("Expected malformed stream to fail");
			} catch (error) {
				expect(error).toMatchObject({ provider: "openai-compatible", status: 502 });
				expect((error as Error).message).not.toContain("secret");
				expect((error as Error).message.length).toBeLessThan(200);
			}
		}
	});

	it("keeps completed Chat streams equivalent to JSON, including a stop followed by EOF", async () => {
		const message = { content: "grounded answer", annotations: [streamCitation] };
		let streamed = false;
		using _hook = hookFetch(async input => {
			if (String(input).endsWith("/responses")) return new Response("not found", { status: 404 });
			return streamed
				? streamedResponse(
						sse({ id: "chat-parity", choices: [{ index: 0, delta: message, finish_reason: "stop" }] }),
					)
				: Response.json({ id: "chat-parity", choices: [{ message, finish_reason: "stop" }] });
		});
		const expected = await new OpenAICompatibleSearchProvider().search(params());
		streamed = true;
		expect(await new OpenAICompatibleSearchProvider().search(params())).toEqual(expected);
	});

	it("cancels and releases open SSE bodies on Responses completion, malformed events, and premature DONE", async () => {
		for (const data of [
			sse({ type: "response.completed", response: completedSnapshot }),
			"data: secret-malformed\n\n",
			"data: [DONE]\n\n",
			"event: response.incomplete\ndata: {}\n\n",
		]) {
			const stream = openBody(data);
			using _hook = hookFetch(
				async () => new Response(stream.body, { headers: { "Content-Type": "text/event-stream" } }),
			);
			const search = new OpenAICompatibleSearchProvider().search(params());
			if (data.includes("response.completed")) {
				expect((await search).requestId).toBe("stream-response");
			} else {
				await expect(search).rejects.toMatchObject({ provider: "openai-compatible", status: 502 });
			}
			await stream.cancelled;
			expect(stream.body.locked).toBe(false);
		}
	});

	it("preserves midstream caller abort identity and cancels the body, including after Chat stop", async () => {
		for (const chat of [false, true]) {
			const ac = new AbortController();
			const abort = new DOMException("caller cancelled", "AbortError");
			const data = chat
				? sse({
						choices: [
							{ index: 0, delta: { content: "answer", annotations: [streamCitation] }, finish_reason: "stop" },
						],
					})
				: sse({ type: "response.output_text.delta", delta: "partial" });
			const stream = openBody(data);
			using _hook = hookFetch(async input =>
				chat && String(input).endsWith("/responses")
					? new Response("not found", { status: 404 })
					: new Response(stream.body, { headers: { "Content-Type": "text/event-stream" } }),
			);
			const search = new OpenAICompatibleSearchProvider().search({ ...params(), signal: ac.signal });
			await stream.read;
			ac.abort(abort);
			await expect(search).rejects.toBe(abort);
			expect(await stream.cancelled).toBe(abort);
			expect(stream.body.locked).toBe(false);
		}
	});

	it("applies the composed LLM hard timeout to a body stalled after response headers", async () => {
		const timeout = new AbortController();
		const timedOut = new DOMException("hard timeout", "TimeoutError");
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
		const ac = new AbortController();
		let captured: AbortSignal | null | undefined;
		const stream = openBody(sse({ type: "response.created", response: { status: "in_progress" } }));
		using _hook = hookFetch(async (_input, init) => {
			captured = init?.signal;
			return new Response(stream.body, { headers: { "Content-Type": "text/event-stream" } });
		});
		const search = runWithSearchTimeout(undefined, () =>
			new OpenAICompatibleSearchProvider().search({ ...params(), signal: ac.signal }),
		);
		await stream.read;
		timeout.abort(timedOut);
		await expect(search).rejects.toBe(timedOut);
		expect(timeoutSpy).toHaveBeenCalledWith(SEARCH_LLM_TIMEOUT_MS);
		expect(captured).not.toBe(ac.signal);
		expect(captured?.aborted).toBe(true);
		expect(captured?.reason).toBe(timedOut);
		expect(await stream.cancelled).toBe(timedOut);
		expect(stream.body.locked).toBe(false);
	});

	it("preserves abort identity while reading a JSON body", async () => {
		const ac = new AbortController();
		const abort = new DOMException("JSON read cancelled", "AbortError");
		const stream = openBody('{"output_text":"partial');
		using _hook = hookFetch(
			async () => new Response(stream.body, { headers: { "Content-Type": "application/json" } }),
		);
		const search = new OpenAICompatibleSearchProvider().search({ ...params(), signal: ac.signal });
		await stream.read;
		ac.abort(abort);
		await expect(search).rejects.toBe(abort);
		expect(await stream.cancelled).toBe(abort);
		expect(stream.body.locked).toBe(false);
	});

	it("preserves abort errors raised by the SSE body independently of the caller signal", async () => {
		const abort = new DOMException("transport aborted", "AbortError");
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.error(abort);
			},
		});
		using _hook = hookFetch(async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
		await expect(new OpenAICompatibleSearchProvider().search(params())).rejects.toBe(abort);
		expect(body.locked).toBe(false);
	});

	it("rejects missing SSE bodies and cancels an already-aborted response body", async () => {
		{
			using _hook = hookFetch(async () => new Response(null, { headers: { "Content-Type": "text/event-stream" } }));
			await expect(new OpenAICompatibleSearchProvider().search(params())).rejects.toMatchObject({
				provider: "openai-compatible",
				status: 502,
			});
		}
		const ac = new AbortController();
		const abort = new DOMException("cancelled after headers", "AbortError");
		const stream = openBody(sse({ type: "response.completed", response: completedSnapshot }));
		using _hook = hookFetch(async () => {
			ac.abort(abort);
			return new Response(stream.body, { headers: { "Content-Type": "text/event-stream" } });
		});
		await expect(new OpenAICompatibleSearchProvider().search({ ...params(), signal: ac.signal })).rejects.toBe(abort);
		await stream.cancelled;
		expect(stream.body.locked).toBe(false);
	});

	it("preserves resolved credentials, headers, wire model, and request parameters on streaming fallback", async () => {
		const ac = new AbortController();
		const resolveCredentials = vi.fn(async () => ({
			apiKey: "sk-rotated",
			headers: {
				authorization: "Bearer explicit",
				"X-Resolved": "fresh",
				"content-type": "application/custom+json",
			},
		}));
		const bodies: Record<string, unknown>[] = [];
		const signals: (AbortSignal | null | undefined)[] = [];
		using _hook = hookFetch(async (input, init) => {
			const headers = new Headers(init?.headers);
			expect(headers.get("Authorization")).toBe("Bearer explicit");
			expect(headers.get("X-Resolved")).toBe("fresh");
			expect(headers.get("X-Test")).toBeNull();
			expect(headers.get("Content-Type")).toBe("application/custom+json");
			bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			signals.push(init?.signal);
			return String(input).endsWith("/responses")
				? new Response("unavailable", { status: 404 })
				: streamedResponse(
						sse({
							choices: [
								{
									index: 0,
									delta: { content: "answer", annotations: [streamCitation] },
									finish_reason: "stop",
								},
							],
						}),
					);
		});
		const result = await new OpenAICompatibleSearchProvider().search({
			...params({ ...baseCtx, wireModelId: "actual-wire-model", resolveCredentials }, auth()),
			sessionId: "search-session",
			signal: ac.signal,
			temperature: 0.3,
			maxOutputTokens: 512,
		});
		expect(resolveCredentials).toHaveBeenCalledTimes(1);
		expect(resolveCredentials).toHaveBeenCalledWith({ sessionId: "search-session", signal: ac.signal });
		expect(bodies[0]).toMatchObject({
			model: "actual-wire-model",
			stream: true,
			temperature: 0.3,
			max_output_tokens: 512,
		});
		expect(bodies[1]).toMatchObject({ model: "actual-wire-model", stream: true, temperature: 0.3, max_tokens: 512 });
		expect(signals[0]).toBeInstanceOf(AbortSignal);
		expect(signals[1]).toBe(signals[0]);
		expect(result.model).toBe("actual-wire-model");
	});

	it("bounds stream transport failures without leaking body data", async () => {
		const secret = "transport-secret";
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.error(new Error(secret.repeat(1_000)));
			},
		});
		using _hook = hookFetch(async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
		try {
			await new OpenAICompatibleSearchProvider().search(params());
			throw new Error("Expected transport failure");
		} catch (error) {
			expect(error).toMatchObject({ provider: "openai-compatible", status: 502 });
			expect((error as Error).message).not.toContain(secret);
			expect((error as Error).message.length).toBeLessThan(200);
		}
		expect(body.locked).toBe(false);
	});

	it("prefers /responses for search even when the model's chat wire is openai-completions", async () => {
		const urls: string[] = [];
		using _hook = hookFetch(async input => {
			urls.push(String(input));
			return Response.json({
				id: "r-pref",
				output: [
					{ type: "web_search_call", status: "completed", action: { type: "search" } },
					{
						type: "message",
						content: [
							{
								type: "output_text",
								text: "grounded",
								annotations: [{ type: "url_citation", url: "https://r.example", title: "R" }],
							},
						],
					},
				],
			});
		});
		const result = await new OpenAICompatibleSearchProvider().search(
			params({ ...baseCtx, api: "openai-completions" }),
		);
		expect(urls).toHaveLength(1);
		expect(urls[0]?.endsWith("/responses")).toBe(true);
		expect(result.sources).toEqual([{ title: "R", url: "https://r.example", snippet: undefined }]);
	});

	it("parses citations into sources", async () => {
		using _hook = hookFetch(async () =>
			Response.json({
				output_text: "answer",
				output: [
					{
						content: [
							{
								text: "answer",
								annotations: [{ type: "url_citation", url: "https://c.example", title: "C", text: "quote" }],
							},
						],
					},
				],
			}),
		);
		const result = await new OpenAICompatibleSearchProvider().search(params());
		expect(result.provider).toBe("openai-compatible");
		expect(result.sources).toEqual([{ title: "C", url: "https://c.example", snippet: "quote" }]);
	});

	it("throws 424 when the response has no citations", async () => {
		using _hook = hookFetch(async () => Response.json({ output_text: "plain answer" }));
		await expect(new OpenAICompatibleSearchProvider().search(params())).rejects.toMatchObject({
			provider: "openai-compatible",
			status: 424,
		});
	});

	it("wraps invalid JSON success bodies without exposing their contents", async () => {
		const body = `not-json-${"sensitive ".repeat(1_000)}`;
		using _hook = hookFetch(async () => new Response(body));
		try {
			await new OpenAICompatibleSearchProvider().search(params());
			throw new Error("Expected malformed response to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "openai-compatible", status: 502 });
			expect((error as Error).message).toContain("invalid JSON");
			expect((error as Error).message).not.toContain("sensitive");
			expect((error as Error).message.length).toBeLessThan(200);
		}
	});

	it("rejects scalar and array success bodies as malformed provider responses", async () => {
		for (const body of [null, 42, "scalar-root-secret", []]) {
			using _hook = hookFetch(async () => Response.json(body));
			try {
				await new OpenAICompatibleSearchProvider().search(params());
				throw new Error("Expected malformed response to fail");
			} catch (error) {
				expect(error).toMatchObject({ provider: "openai-compatible", status: 502 });
				expect((error as Error).message).not.toContain("scalar-root-secret");
				expect((error as Error).message.length).toBeLessThan(200);
			}
		}
	});

	it("rejects wrong-shaped consumed arrays without exposing response bodies", async () => {
		const secret = "wrong-shaped-array-secret";
		const malformedBodies = [
			{ output: `${secret}-output` },
			{ choices: `${secret}-choices` },
			{ output: [{ content: `${secret}-content` }] },
			{ output: [{ content: [{ annotations: `${secret}-output-annotations` }] }] },
			{ choices: [{ message: { annotations: `${secret}-choice-annotations` } }] },
		];

		for (const body of malformedBodies) {
			using _hook = hookFetch(async () => Response.json(body));
			try {
				await new OpenAICompatibleSearchProvider().search(params());
				throw new Error("Expected malformed response to fail");
			} catch (error) {
				expect(error).toMatchObject({ provider: "openai-compatible", status: 502 });
				expect((error as Error).message).not.toContain(secret);
				expect((error as Error).message.length).toBeLessThan(200);
			}
		}
	});

	it("skips non-object response entries while retaining citations and string request ids", async () => {
		using _hook = hookFetch(async () =>
			Response.json({
				id: "string-request-id",
				output: [
					null,
					42,
					{
						content: [
							null,
							"text",
							{
								annotations: [null, { type: "url_citation", url: "https://entries.example", title: "Entries" }],
							},
						],
					},
				],
				choices: [
					null,
					42,
					{ message: null },
					{
						message: {
							annotations: [null, { type: "url_citation", url: "https://entries.example", title: "Entries" }],
						},
					},
				],
			}),
		);
		const result = await new OpenAICompatibleSearchProvider().search(params());
		expect(result.requestId).toBe("string-request-id");
		expect(result.sources).toEqual([{ title: "Entries", url: "https://entries.example", snippet: undefined }]);
	});

	it("omits non-string response ids", async () => {
		using _hook = hookFetch(async () =>
			Response.json({
				id: 42,
				output: [
					{ content: [{ annotations: [{ type: "url_citation", url: "https://id.example", title: "ID" }] }] },
				],
			}),
		);
		const result = await new OpenAICompatibleSearchProvider().search(params());
		expect(result.requestId).toBeUndefined();
	});

	it("classifies non-success responses without parsing them as successful bodies", async () => {
		const body = "non-success-body-secret";
		using _hook = hookFetch(async () => new Response(body, { status: 500 }));
		try {
			await new OpenAICompatibleSearchProvider().search(params());
			throw new Error("Expected HTTP failure");
		} catch (error) {
			expect(error).toMatchObject({ provider: "openai-compatible", status: 500 });
			expect((error as Error).message).toContain(body);
			expect((error as Error).message).not.toContain("invalid JSON");
		}
	});

	it("preserves abort errors from fetch", async () => {
		const abort = new Error("Aborted");
		abort.name = "AbortError";
		using _hook = hookFetch(async () => {
			throw abort;
		});
		await expect(new OpenAICompatibleSearchProvider().search(params())).rejects.toBe(abort);
	});

	it("does not accept non-url_citation source metadata as a citation (no masking)", async () => {
		using _hook = hookFetch(async () =>
			Response.json({
				output_text: "answer with stray metadata",
				// A response that ignored web_search but carries unrelated URL-bearing
				// objects (type "source", bare url fields) MUST NOT be treated as a search result.
				output: [
					{
						content: [
							{ text: "answer", annotations: [{ type: "source", url: "https://nope.example", title: "Nope" }] },
						],
					},
				],
				sources: [{ url: "https://also-nope.example" }],
				metadata: { citation: { url: "https://still-nope.example" } },
			}),
		);
		await expect(new OpenAICompatibleSearchProvider().search(params())).rejects.toMatchObject({
			provider: "openai-compatible",
			status: 424,
		});
	});

	it("does not fetch without an exact active-provider key", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		await expect(new OpenAICompatibleSearchProvider().search(params(baseCtx, auth()))).rejects.toBeInstanceOf(
			SearchProviderError,
		);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("keeps concurrent request context isolated", async () => {
		const seen: string[] = [];
		using _hook = hookFetch(async (input, init) => {
			seen.push(`${input}:${(init?.headers as Record<string, string>).Authorization}`);
			return Response.json({
				output_text: "answer",
				output: [{ content: [{ annotations: [{ type: "url_citation", url: "https://d.example", title: "D" }] }] }],
			});
		});
		const provider = new OpenAICompatibleSearchProvider();
		await Promise.all([
			provider.search(params({ ...baseCtx, provider: "a", baseUrl: "https://a.example/v1" }, auth({ a: "sk-a" }))),
			provider.search(params({ ...baseCtx, provider: "b", baseUrl: "https://b.example/v1" }, auth({ b: "sk-b" }))),
		]);
		expect(seen).toContain("https://a.example/v1/responses:Bearer sk-a");
		expect(seen).toContain("https://b.example/v1/responses:Bearer sk-b");
	});

	it("passes a composed abort signal to fetch", async () => {
		const ac = new AbortController();
		let captured: AbortSignal | undefined | null;
		using _hook = hookFetch(async (_input, init) => {
			captured = init?.signal;
			return Response.json({
				output_text: "answer",
				output: [{ content: [{ annotations: [{ type: "url_citation", url: "https://e.example", title: "E" }] }] }],
			});
		});
		await new OpenAICompatibleSearchProvider().search({
			...params(baseCtx, auth({ custom: "sk" })),
			signal: ac.signal,
		});
		expect(captured).toBeInstanceOf(AbortSignal);
		expect(captured).not.toBe(ac.signal);
	});
});

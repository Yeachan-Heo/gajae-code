import { describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import {
	isCpaToolAliasRestoreFailure,
	parseCpaToolAliasRestoreFailure,
	streamAnthropic,
} from "@gajae-code/ai/providers/anthropic";
import type { Context, Model, ProviderSessionState, Tool, UserMessage } from "@gajae-code/ai/types";

const model: Model<"anthropic-messages"> = {
	api: "anthropic-messages",
	provider: "anthropic",
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6",
	baseUrl: "https://api.anthropic.com",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8_192,
	contextWindow: 200_000,
	reasoning: true,
};

type MockAnthropicEvent = Record<string, unknown>;
type MockAnthropicRequest = {
	withResponse(): Promise<{
		data: AsyncIterable<MockAnthropicEvent>;
		response: Response;
		request_id: string | null;
	}>;
};

// Exact public signature from issue #4338 (both captured CPA traces): the proxy
// 500s the stream with an SSE `error` event naming the rejected cloaked alias
// and the failure mode. Only synthetic fixtures derived from the public issue
// are used — no private capture content is ingested.
const CPA_ALIAS_FIND = "mcp__jzi2uzmxd57z__1olzmojrukyw_find";
const CPA_ALIAS_SEARCH = "mcp__jzi2uzmxd57z__cn0i1zsn4b0j_search";

function cpaAliasErrorMessage(alias: string): string {
	return `{"type":"error","error":{"type":"api_error","message":"restore Claude OAuth tool name from streaming response: cannot restore Claude OAuth MCP tool alias \\"${alias}\\": no unique request-local match"}}`;
}

function createCpaAlias500(alias: string): MockAnthropicRequest {
	return {
		async withResponse() {
			const error = Object.assign(new Error(`500 ${cpaAliasErrorMessage(alias)}`), { status: 500 });
			throw error;
		},
	};
}

function createStatuslessCpaAliasError(alias: string): MockAnthropicRequest {
	return {
		async withResponse() {
			throw new Error(cpaAliasErrorMessage(alias));
		},
	};
}

function createGeneric500(): MockAnthropicRequest {
	return {
		async withResponse() {
			const error = Object.assign(
				new Error(
					'500 {"type":"error","error":{"type":"api_error","message":"An error occurred while processing the request."}}',
				),
				{ status: 500 },
			);
			throw error;
		},
	};
}

function createSuccessfulRequest(): MockAnthropicRequest {
	const response = new Response(null, {
		status: 200,
		headers: { "request-id": "req_cpa_recovered" },
	});
	const events: MockAnthropicEvent[] = [
		{
			type: "message_start",
			message: {
				id: "msg_cpa_recovered",
				usage: {
					input_tokens: 1,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "recovered" } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		},
		{ type: "message_stop" },
	];

	return {
		async withResponse() {
			return {
				data: {
					async *[Symbol.asyncIterator]() {
						for (const event of events) yield event;
					},
				},
				response,
				request_id: response.headers.get("request-id"),
			};
		},
	};
}

// A stream that yields one content block (so firstTokenTime is set) and then
// dies with the CPA signature: the repair must NOT fire after partial content.
function createPartialThenCpaAliasError(alias: string): MockAnthropicRequest {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_cpa_partial" } });
	return {
		async withResponse() {
			return {
				data: {
					async *[Symbol.asyncIterator]() {
						yield {
							type: "message_start",
							message: {
								id: "msg_cpa_partial",
								usage: {
									input_tokens: 1,
									output_tokens: 0,
									cache_read_input_tokens: 0,
									cache_creation_input_tokens: 0,
								},
							},
						};
						yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
						yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } };
						throw new Error(cpaAliasErrorMessage(alias));
					},
				},
				response,
				request_id: response.headers.get("request-id"),
			};
		},
	};
}

// A stream that yields one `tool_use` content block (the rejected cloaked
// alias itself, so `firstTokenTime` is set by the very block CPA rejects)
// and then dies with the CPA signature: the repair must NOT fire, since the
// `toolcall_start` event has already been published live before the failure
// can be classified.
function createPartialToolUseThenCpaAliasError(alias: string): MockAnthropicRequest {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_cpa_tool_use_partial" } });
	return {
		async withResponse() {
			return {
				data: {
					async *[Symbol.asyncIterator]() {
						yield {
							type: "message_start",
							message: {
								id: "msg_cpa_tool_use_partial",
								usage: {
									input_tokens: 1,
									output_tokens: 0,
									cache_read_input_tokens: 0,
									cache_creation_input_tokens: 0,
								},
							},
						};
						yield {
							type: "content_block_start",
							index: 0,
							content_block: { type: "tool_use", id: "toolu_cpa_partial", name: alias, input: {} },
						};
						const error = Object.assign(new Error(`500 ${cpaAliasErrorMessage(alias)}`), { status: 500 });
						throw error;
					},
				},
				response,
				request_id: response.headers.get("request-id"),
			};
		},
	};
}

// A stream that yields one `thinking` content block (firstTokenTime is set by
// any content_block_start, not only tool_use) and then dies with the CPA
// signature: the managed ineligible path must treat this exactly like a
// mid-stream tool_use failure.
function createPartialThinkingThenCpaAliasError(alias: string): MockAnthropicRequest {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_cpa_thinking_partial" } });
	return {
		async withResponse() {
			return {
				data: {
					async *[Symbol.asyncIterator]() {
						yield {
							type: "message_start",
							message: {
								id: "msg_cpa_thinking_partial",
								usage: {
									input_tokens: 1,
									output_tokens: 0,
									cache_read_input_tokens: 0,
									cache_creation_input_tokens: 0,
								},
							},
						};
						yield { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } };
						yield { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hm" } };
						const error = Object.assign(new Error(`500 ${cpaAliasErrorMessage(alias)}`), { status: 500 });
						throw error;
					},
				},
				response,
				request_id: response.headers.get("request-id"),
			};
		},
	};
}

const findTool: Tool = {
	name: "find",
	description: "Find files",
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};
const searchTool: Tool = {
	name: "search",
	description: "Search the workspace",
	parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};
const bashTool: Tool = {
	name: "bash",
	description: "Run a shell command",
	parameters: { type: "object", properties: {} },
};

function makeContext(messages: UserMessage[], tools: Tool[]): Context {
	return { messages, tools };
}

function userMessage(content: string): UserMessage {
	return { role: "user", content, timestamp: Date.now() };
}

/** The merged text of the last user turn of a captured request body. */
function lastUserContent(params: unknown): string {
	const messages = (params as { messages: Array<{ role: string; content: string }> }).messages ?? [];
	const last = [...messages].reverse().find(message => message.role === "user");
	return last?.content ?? "";
}

describe("CPA tool alias restore failure classification (issue #4338)", () => {
	it("claims the exact 500 SSE signature and extracts the base tool", () => {
		const error = Object.assign(new Error(`500 ${cpaAliasErrorMessage(CPA_ALIAS_FIND)}`), { status: 500 });
		expect(isCpaToolAliasRestoreFailure(error)).toBe(true);
		expect(parseCpaToolAliasRestoreFailure(error)).toEqual({ alias: CPA_ALIAS_FIND, baseName: "find" });
	});

	it("claims the statusless in-stream SSE error event form", () => {
		const error = new Error(cpaAliasErrorMessage(CPA_ALIAS_SEARCH));
		expect(isCpaToolAliasRestoreFailure(error)).toBe(true);
		expect(parseCpaToolAliasRestoreFailure(error)).toEqual({ alias: CPA_ALIAS_SEARCH, baseName: "search" });
	});

	it("preserves underscore-bearing base names (todo_write)", () => {
		const alias = "mcp__jzi2uzmxd57z__mr6er53iidr3_todo_write";
		const error = new Error(cpaAliasErrorMessage(alias));
		expect(isCpaToolAliasRestoreFailure(error)).toBe(true);
		expect(parseCpaToolAliasRestoreFailure(error)).toEqual({ alias, baseName: "todo_write" });
	});

	it("still claims a malformed alias but yields no base name", () => {
		// The signature is present but the alias has no `_<base>` tail to parse:
		// the classifier must not crash and must not invent a base name.
		const malformed = "mcp__jzi2uzmxd57z__1olzmojrukyw";
		const error = new Error(cpaAliasErrorMessage(malformed));
		expect(isCpaToolAliasRestoreFailure(error)).toBe(true);
		expect(parseCpaToolAliasRestoreFailure(error)).toEqual({ alias: malformed, baseName: undefined });
	});

	it("rejects unrelated 500s, non-5xx statuses, and non-Error inputs", () => {
		// The generic masked CPA rejection body must stay on its own classifier.
		const masked = Object.assign(
			new Error(
				'500 {"type":"error","error":{"type":"api_error","message":"An error occurred while processing the request."}}',
			),
			{ status: 500 },
		);
		expect(isCpaToolAliasRestoreFailure(masked)).toBe(false);
		// The signature on a 400 (or any non-5xx) status is not the observed CPA
		// delivery shape and must not be claimed.
		const fourHundred = Object.assign(new Error(`400 ${cpaAliasErrorMessage(CPA_ALIAS_FIND)}`), { status: 400 });
		expect(isCpaToolAliasRestoreFailure(fourHundred)).toBe(false);
		// A thinking-immutability 400 stays with its own matchers.
		const thinking = Object.assign(
			new Error(
				'400 {"type":"error","error":{"type":"invalid_request_error","message":"The `thinking` blocks in the latest assistant message cannot be modified."}}',
			),
			{ status: 400 },
		);
		expect(isCpaToolAliasRestoreFailure(thinking)).toBe(false);
		expect(isCpaToolAliasRestoreFailure(undefined)).toBe(false);
		expect(isCpaToolAliasRestoreFailure("unrelated error text")).toBe(false);
	});
});

describe("CPA tool alias restore failure recovery (issue #4338)", () => {
	it("repairs once with corrective steering naming the unique callable tool", async () => {
		const bodies: unknown[] = [];
		let attempt = 0;
		const create = ((body: unknown) => {
			bodies.push(JSON.parse(JSON.stringify(body)));
			attempt += 1;
			return (attempt === 1 ? createCpaAlias500(CPA_ALIAS_FIND) : createSuccessfulRequest()) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const context = makeContext([userMessage("find me the config")], [findTool, searchTool, bashTool]);
		const result = await streamAnthropic(model, context, { client }).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(bodies).toHaveLength(2);
		// The first request carries no steering; the corrective retry names the
		// deterministic callable tool and never guesses.
		expect(lastUserContent(bodies[0])).not.toContain("callable tool");
		const repaired = lastUserContent(bodies[1]);
		expect(repaired).toContain(`Your previous tool call "${CPA_ALIAS_FIND}"`);
		expect(repaired).toContain('The callable tool is "find"');
		expect(repaired).not.toContain("search_tool_bm25");
	});

	it("terminalizes after exactly one corrective attempt on recurrence", async () => {
		const bodies: unknown[] = [];
		const create = ((body: unknown) => {
			bodies.push(JSON.parse(JSON.stringify(body)));
			return createCpaAlias500(CPA_ALIAS_FIND) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const context = makeContext([userMessage("find me the config")], [findTool, searchTool, bashTool]);
		const result = await streamAnthropic(model, context, { client }).result();

		// Exactly 2 requests: the initial one and the single corrective retry.
		// The generic 5xx budget (3 more blind resends) must never fire, and the
		// terminal error must carry no status/transport facts so neither the
		// provider nor the managed fallback controller re-sends.
		expect(bodies).toHaveLength(2);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(CPA_ALIAS_FIND);
		expect(result.errorMessage).toContain("corrective retry was rejected again");
		expect(result.errorMessage).toContain('callable tool name is "find"');
		expect(result.errorMessage).toContain("The turn was not re-sent");
		expect(result.errorMessage).not.toContain("cannot restore Claude OAuth MCP tool alias");
		expect(result.errorStatus).toBeUndefined();
		expect(result.transportFailure).toBeUndefined();
	});

	it("repairs a statusless SSE error event and still bounds the retry", async () => {
		const bodies: unknown[] = [];
		let attempt = 0;
		const create = ((body: unknown) => {
			bodies.push(JSON.parse(JSON.stringify(body)));
			attempt += 1;
			if (attempt === 1) return createStatuslessCpaAliasError(CPA_ALIAS_FIND) as never;
			if (attempt === 2) return createCpaAlias500(CPA_ALIAS_SEARCH) as never;
			return createSuccessfulRequest() as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const context = makeContext([userMessage("search for it")], [findTool, searchTool, bashTool]);
		const result = await streamAnthropic(model, context, { client }).result();

		// The first repair corrects `find`; the SECOND CPA failure (a different
		// alias) is recurrence for this request and terminalizes — one corrective
		// attempt per request, never a loop.
		expect(bodies).toHaveLength(2);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(CPA_ALIAS_SEARCH);
	});

	it("steers to direct discovery when no unique callable tool matches", async () => {
		const bodies: unknown[] = [];
		let attempt = 0;
		const create = ((body: unknown) => {
			bodies.push(JSON.parse(JSON.stringify(body)));
			attempt += 1;
			if (attempt === 1) return createCpaAlias500(CPA_ALIAS_FIND) as never;
			return createSuccessfulRequest() as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		// `find` is not offered in this request, so no deterministic callable
		// name exists: the repair must direct the model at tool discovery instead
		// of inventing a name.
		const context = makeContext([userMessage("find me the config")], [searchTool, bashTool]);
		const result = await streamAnthropic(model, context, { client }).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies).toHaveLength(2);
		const repaired = lastUserContent(bodies[1]);
		expect(repaired).toContain("search_tool_bm25");
		expect(repaired).not.toContain('The callable tool is "');
	});

	it("surfaces an actionable terminal error instead of repairing after partial content has streamed", async () => {
		const bodies: unknown[] = [];
		const create = ((body: unknown) => {
			bodies.push(JSON.parse(JSON.stringify(body)));
			return createPartialThenCpaAliasError(CPA_ALIAS_FIND) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const context = makeContext([userMessage("find me the config")], [findTool, searchTool, bashTool]);
		const result = await streamAnthropic(model, context, { client }).result();

		// A token was already emitted (a `text` block, not `tool_use`): no
		// corrective retry, no blind resend. GJC's own actionable message
		// surfaces instead of the raw proxy JSON, and the wording is
		// content-type-agnostic ("response content", not "tool call") since
		// this fixture never streams a tool_use block at all.
		expect(bodies).toHaveLength(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(CPA_ALIAS_FIND);
		expect(result.errorMessage).toContain(
			"Repair could not be safely attempted because response content had already begun streaming to the client",
		);
		expect(result.errorMessage).toContain("The turn was not re-sent");
		expect(result.errorMessage).not.toContain("cannot restore Claude OAuth MCP tool alias");
		expect(result.errorStatus).toBeUndefined();
		expect(result.transportFailure).toBeUndefined();
	});

	it("surfaces an actionable terminal error when a tool_use block has already streamed", async () => {
		const bodies: unknown[] = [];
		const create = ((body: unknown) => {
			bodies.push(JSON.parse(JSON.stringify(body)));
			return createPartialToolUseThenCpaAliasError(CPA_ALIAS_FIND) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const context = makeContext([userMessage("find me the config")], [findTool, searchTool, bashTool]);
		const result = await streamAnthropic(model, context, { client }).result();

		// The rejected tool_use block itself already published a live
		// `toolcall_start` event before the CPA failure could be classified:
		// no corrective retry, no blind resend. GJC's own actionable message
		// surfaces instead of the raw proxy JSON.
		expect(bodies).toHaveLength(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(CPA_ALIAS_FIND);
		expect(result.errorMessage).toContain(
			"Repair could not be safely attempted because response content had already begun streaming to the client",
		);
		expect(result.errorMessage).toContain("The turn was not re-sent");
		expect(result.errorMessage).not.toContain("cannot restore Claude OAuth MCP tool alias");
		expect(result.errorStatus).toBeUndefined();
		expect(result.transportFailure).toBeUndefined();
	});

	it("leaves unrelated 500s on the generic retry path untouched", async () => {
		const bodies: unknown[] = [];
		const create = ((body: unknown) => {
			bodies.push(JSON.parse(JSON.stringify(body)));
			return createGeneric500() as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const context = makeContext([userMessage("hello")], [findTool, searchTool, bashTool]);
		const result = await streamAnthropic(model, context, {
			client,
			providerRetryWait: async () => {},
		}).result();

		// Generic server errors keep their existing bounded retry behavior (1
		// initial + 3 retries) and never pick up CPA steering.
		expect(bodies).toHaveLength(4);
		expect(result.stopReason).toBe("error");
		for (const body of bodies) {
			expect(JSON.stringify(body)).not.toContain("callable tool");
		}
	});
});

describe("CPA tool alias restore failure under managed fallback (issue #4338)", () => {
	it("records steering for the same turn and converges on the next managed attempt", async () => {
		const bodies: unknown[] = [];
		let attempt = 0;
		const create = ((body: unknown) => {
			bodies.push(JSON.parse(JSON.stringify(body)));
			attempt += 1;
			if (attempt === 1) return createCpaAlias500(CPA_ALIAS_FIND) as never;
			return createSuccessfulRequest() as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;
		const providerSessionState = new Map<string, ProviderSessionState>();

		const context = makeContext([userMessage("find me the config")], [findTool, searchTool, bashTool]);
		const options = { client, fallbackManaged: true, providerSessionState };

		const first = await streamAnthropic(model, context, options).result();
		// The managed controller owns retries: the provider surfaces the raw
		// error after exactly one request, carrying server-class transport facts
		// so the controller retries the turn.
		expect(first.stopReason).toBe("error");
		expect(bodies).toHaveLength(1);
		expect(lastUserContent(bodies[0])).not.toContain("callable tool");
		expect(first.transportFailure?.status).toBe(500);

		const second = await streamAnthropic(model, context, options).result();
		// The next managed attempt rebuilt the same turn with the recorded
		// corrective steering and succeeded.
		expect(second.stopReason).toBe("stop");
		expect(bodies).toHaveLength(2);
		expect(lastUserContent(bodies[1])).toContain('The callable tool is "find"');

		// A later turn with a different user prompt must not inherit the stale
		// steering: the successful stream released it.
		const nextTurn = await streamAnthropic(
			model,
			makeContext([userMessage("different turn")], [findTool]),
			options,
		).result();
		expect(nextTurn.stopReason).toBe("stop");
		expect(bodies).toHaveLength(3);
		expect(lastUserContent(bodies[2])).not.toContain("callable tool");
	});

	it("terminalizes on recurrence after the steering was already applied", async () => {
		const bodies: unknown[] = [];
		const create = ((body: unknown) => {
			bodies.push(JSON.parse(JSON.stringify(body)));
			return createCpaAlias500(CPA_ALIAS_FIND) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;
		const providerSessionState = new Map<string, ProviderSessionState>();

		const context = makeContext([userMessage("find me the config")], [findTool, searchTool, bashTool]);
		const options = { client, fallbackManaged: true, providerSessionState };

		const first = await streamAnthropic(model, context, options).result();
		expect(first.stopReason).toBe("error");
		expect(bodies).toHaveLength(1);

		const second = await streamAnthropic(model, context, options).result();
		// The second attempt consumed the recorded steering and was rejected
		// again: the actionable terminal error must surface with no transport
		// facts so the fallback controller does not re-send unchanged.
		expect(bodies).toHaveLength(2);
		expect(lastUserContent(bodies[1])).toContain('The callable tool is "find"');
		expect(second.stopReason).toBe("error");
		expect(second.errorMessage).toContain("corrective retry was rejected again");
		expect(second.errorStatus).toBeUndefined();
		expect(second.transportFailure).toBeUndefined();
	});

	it("does not repair a managed attempt that shares no session state", async () => {
		const bodies: unknown[] = [];
		const create = ((body: unknown) => {
			bodies.push(JSON.parse(JSON.stringify(body)));
			return createCpaAlias500(CPA_ALIAS_FIND) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const context = makeContext([userMessage("find me the config")], [findTool, searchTool, bashTool]);
		const result = await streamAnthropic(model, context, { client, fallbackManaged: true }).result();

		expect(bodies).toHaveLength(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("cannot restore Claude OAuth MCP tool alias");
	});
});

describe("CPA ineligible repair after streamed content (PR #4790 fix-forward)", () => {
	it("records steering and rethrows raw with transport facts when a managed attempt fails mid-stream", async () => {
		const bodies: unknown[] = [];
		const create = ((body: unknown) => {
			bodies.push(JSON.parse(JSON.stringify(body)));
			return createPartialToolUseThenCpaAliasError(CPA_ALIAS_FIND) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;
		const providerSessionState = new Map<string, ProviderSessionState>();

		const context = makeContext([userMessage("find me the config")], [findTool, searchTool, bashTool]);
		const options = { client, fallbackManaged: true, providerSessionState };

		const first = await streamAnthropic(model, context, options).result();
		// The staged ManagedAttemptTransaction never published the streamed
		// events, so the controller's rebuild is replay-safe: the provider
		// records the steering for this exact turn and surfaces the RAW failure
		// with its 500 transport facts intact so the fallback controller can
		// discard the attempt and rebuild the turn with the steering.
		expect(bodies).toHaveLength(1);
		expect(first.stopReason).toBe("error");
		expect(first.errorStatus).toBe(500);
		expect(first.transportFailure?.status).toBe(500);
		// The staged toolcall_start never reached a live consumer, so the
		// surfaced message stays the raw proxy error, not the ineligible error.
		expect(first.errorMessage).toContain("cannot restore Claude OAuth MCP tool alias");
		expect(first.errorMessage).not.toContain("Repair could not be safely attempted");

		const second = await streamAnthropic(model, context, options).result();
		// The steered rebuild streamed content again and failed mid-stream once
		// more: the fingerprint is already recorded, so the attempt terminalizes
		// with the actionable ineligible error and no transport facts.
		expect(bodies).toHaveLength(2);
		expect(lastUserContent(bodies[1])).toContain('The callable tool is "find"');
		expect(second.stopReason).toBe("error");
		expect(second.errorMessage).toContain("Repair could not be safely attempted");
		expect(second.errorMessage).toContain("The turn was not re-sent");
		expect(second.errorStatus).toBeUndefined();
		expect(second.transportFailure).toBeUndefined();
	});

	it("records steering and rethrows raw when a managed attempt fails after streamed thinking", async () => {
		const bodies: unknown[] = [];
		const create = ((body: unknown) => {
			bodies.push(JSON.parse(JSON.stringify(body)));
			return createPartialThinkingThenCpaAliasError(CPA_ALIAS_FIND) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;
		const providerSessionState = new Map<string, ProviderSessionState>();

		const context = makeContext([userMessage("find me the config")], [findTool, searchTool, bashTool]);
		const first = await streamAnthropic(model, context, {
			client,
			fallbackManaged: true,
			providerSessionState,
		}).result();

		// firstTokenTime is stamped by any content_block_start — including
		// thinking — so this is the same managed ineligible path: raw failure
		// with transport facts so the controller owns the retry.
		expect(bodies).toHaveLength(1);
		expect(first.stopReason).toBe("error");
		expect(first.transportFailure?.status).toBe(500);
		expect(first.errorMessage).toContain("cannot restore Claude OAuth MCP tool alias");
	});

	it("terminalizes with the actionable ineligible error in a managed attempt without session state", async () => {
		const bodies: unknown[] = [];
		const create = ((body: unknown) => {
			bodies.push(JSON.parse(JSON.stringify(body)));
			return createPartialToolUseThenCpaAliasError(CPA_ALIAS_FIND) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const context = makeContext([userMessage("find me the config")], [findTool, searchTool, bashTool]);
		const result = await streamAnthropic(model, context, { client, fallbackManaged: true }).result();

		// Nowhere to record steering: keep the actionable terminal error path.
		expect(bodies).toHaveLength(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Repair could not be safely attempted");
		expect(result.errorMessage).toContain("The turn was not re-sent");
		expect(result.errorStatus).toBeUndefined();
		expect(result.transportFailure).toBeUndefined();
	});

	it("names the unique callable tool when OAuth wire names are proxy_-prefixed", async () => {
		const bodies: unknown[] = [];
		const create = ((body: unknown) => {
			// Production Claude-OAuth shape: convertTools() prefixes every wire
			// tool name with proxy_ (isOAuthToken=true), while the parsed alias
			// base stays the bare name. options.client forces isOAuthToken=false
			// in these fixtures, so emulate the wire shape directly.
			const cloaked = JSON.parse(JSON.stringify(body)) as { tools?: Array<{ name: string }> };
			if (Array.isArray(cloaked.tools)) {
				cloaked.tools = cloaked.tools.map(tool => ({ ...tool, name: `proxy_${tool.name}` }));
			}
			bodies.push(cloaked);
			return createPartialToolUseThenCpaAliasError(CPA_ALIAS_FIND) as never;
		}) as unknown as Anthropic["messages"]["create"];
		const client = { messages: { create } } as Anthropic;

		const context = makeContext([userMessage("find me the config")], [findTool, searchTool, bashTool]);
		const result = await streamAnthropic(model, context, { client }).result();

		// stripClaudeToolPrefix normalization resolves proxy_find -> "find":
		// the terminal error names the callable tool instead of falling back
		// to discovery guidance.
		expect(bodies).toHaveLength(1);
		const firstBody = bodies[0] as { tools?: Array<{ name: string }> } | undefined;
		expect(firstBody?.tools).toEqual(
			[{ name: "proxy_find" }, { name: "proxy_search" }, { name: "proxy_bash" }].map(t =>
				expect.objectContaining(t),
			) as never,
		);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain('The callable tool name is "find"');
		expect(result.errorMessage).not.toContain("No unique callable tool name could be determined");
	});
});

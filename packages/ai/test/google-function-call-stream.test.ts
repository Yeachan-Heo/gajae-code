import { beforeEach, describe, expect, it } from "bun:test";
import { streamGoogle } from "../src/providers/google";
import { convertMessages, type GoogleSharedStreamOptions } from "../src/providers/google-shared";
import type { GenerateContentResponse, Part } from "../src/providers/google-types";
import { streamGoogleVertex } from "../src/providers/google-vertex";
import type { AssistantMessageEvent, Context, ToolResultMessage } from "../src/types";
import { clearToolChoiceIncapabilityRegistryForTests } from "../src/utils/tool-choice-capability";
import {
	collectEvents,
	createBaseModel,
	createErrorResponse,
	createSseResponse,
	expectSingleCleanFallbackEvents,
} from "./openai-tool-choice-test-helpers";

type NativeApi = "google-generative-ai" | "google-vertex";

const context: Context = {
	messages: [{ role: "user", content: "write the file", timestamp: 1 }],
	tools: [
		{
			name: "write",
			description: "Write a file",
			parameters: {
				type: "object",
				properties: { content: { type: "string" }, nested: { type: "object" }, items: { type: "array" } },
			},
		},
	],
};

function chunk(...parts: Part[]): GenerateContentResponse {
	return { candidates: [{ content: { parts } }] };
}

const stop: GenerateContentResponse = { candidates: [{ finishReason: "STOP" }] };

function openStream(
	api: NativeApi,
	responses: Response | Response[],
	options: GoogleSharedStreamOptions = {},
	id = "gemini-4-argon",
	version = "v1",
	requestContext: Context = context,
) {
	const queue = Array.isArray(responses) ? [...responses] : [responses];
	const requests: { url: string; body: Record<string, unknown> }[] = [];
	const streamOptions: GoogleSharedStreamOptions = {
		apiKey: "offline-synthetic-key",
		...options,
		fetch: async (input, init) => {
			requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
			const response = queue.shift();
			if (!response) throw new Error("Unexpected extra request");
			return response;
		},
	};
	const stream =
		api === "google-vertex"
			? streamGoogleVertex({ ...createBaseModel("google-vertex"), provider: api, id }, requestContext, streamOptions)
			: streamGoogle(
					{
						...createBaseModel("google-generative-ai"),
						provider: api,
						id,
						baseUrl: `https://google.example.test/${version}`,
					},
					requestContext,
					streamOptions,
				);
	return { stream, requests };
}

function completedCalls(events: AssistantMessageEvent[]) {
	return events.filter(event => event.type === "toolcall_end").map(event => event.toolCall);
}

function expectNoDispatch(events: AssistantMessageEvent[]): void {
	expect(events.filter(event => event.type.startsWith("toolcall_"))).toHaveLength(0);
	expect(events.filter(event => event.type === "done")).toHaveLength(0);
	expect(events.filter(event => event.type === "error")).toHaveLength(1);
}

beforeEach(() => clearToolChoiceIncapabilityRegistryForTests());

for (const api of ["google-generative-ai", "google-vertex"] as const) {
	describe(`${api} streamed function arguments`, () => {
		it("replays captured todo container markers without losing nested operations", async () => {
			const parts: Part[] = await Bun.file(
				new URL("./fixtures/google-streamed-todo-containers.json", import.meta.url),
			).json();
			const { stream, requests } = openStream(
				api,
				createSseResponse([...parts.map(part => chunk(part)), stop]),
				{},
				"gemini-4-argon",
				"v1",
				{
					messages: [{ role: "user", content: "update synthetic tasks", timestamp: 1 }],
					tools: [
						{
							name: "todo_write",
							description: "Update synthetic tasks",
							parameters: { type: "object", properties: { ops: { type: "array" } } },
						},
					],
				},
			);
			const events = await collectEvents(stream);
			const result = await stream.result();
			expect(result.stopReason).toBe("toolUse");
			expect(completedCalls(events)).toEqual([
				{
					type: "toolCall",
					name: "todo_write",
					id: "eeEFgsaA",
					arguments: {
						ops: [
							{
								op: "init",
								list: [
									{
										phase: "Synthetic",
										items: ["Complete synthetic checks", "Build synthetic tables"],
									},
								],
							},
							{ op: "done", phase: "Synthetic", task: "Complete synthetic checks" },
							{ op: "start", phase: "Synthetic", task: "Build synthetic tables" },
						],
					},
				},
			]);
			expect(result.content).toEqual(completedCalls(events));
			expect(events.filter(event => event.type === "toolcall_start")).toHaveLength(1);
			expect(requests).toHaveLength(1);
		});

		it.each([
			{
				label: "empty root object",
				fragments: [{ jsonPath: `\${}` }, { jsonPath: `\${}` }],
				expected: {},
			},
			{
				label: "explicit false continuation flags",
				fragments: [
					{ jsonPath: "$.object{}", willContinue: false },
					{ jsonPath: "$.array[]", willContinue: false },
					{ jsonPath: `\${}`, willContinue: false },
				],
				expected: { object: {}, array: [] },
			},
			{
				label: "empty nested objects and arrays",
				fragments: [
					{ jsonPath: "$.nested.empty{}" },
					{ jsonPath: "$.nested.items[]" },
					{ jsonPath: "$.items[0]{}" },
					{ jsonPath: "$.items[1][]" },
					{ jsonPath: "$.items[]" },
					{ jsonPath: "$.nested{}" },
					{ jsonPath: `\${}` },
				],
				expected: { nested: { empty: {}, items: [] }, items: [{}, []] },
			},
			{
				label: "repeated markers before and after children",
				fragments: [
					{ jsonPath: `\${}` },
					{ jsonPath: "$.nested{}" },
					{ jsonPath: "$.items[]" },
					{ jsonPath: "$.nested.value", numberValue: 1 },
					{ jsonPath: "$.items[0]", boolValue: true },
					{ jsonPath: '$["nested"]{}' },
					{ jsonPath: '$["items"][]' },
					{ jsonPath: "$.items[]" },
					{ jsonPath: `\${}` },
				],
				expected: { nested: { value: 1 }, items: [true] },
			},
			{
				label: "quoted literal marker keys",
				fragments: [
					{ jsonPath: '$["literal[]"]', stringValue: "array suffix" },
					{ jsonPath: "$['literal{}']", stringValue: "object suffix" },
					{ jsonPath: '$["container[]"][]' },
					{ jsonPath: "$['container{}']{}" },
				],
				expected: {
					"literal[]": "array suffix",
					"literal{}": "object suffix",
					"container[]": [],
					"container{}": {},
				},
			},
			{
				label: "maximum concrete path depth",
				fragments: [{ jsonPath: `$${".a".repeat(128)}{}` }],
				expected: Array.from({ length: 128 }).reduce<object>(value => ({ a: value }), {}),
			},
		])("accepts container markers for $label", async ({ fragments, expected }) => {
			const { stream } = openStream(
				api,
				createSseResponse([chunk({ functionCall: { name: "write", partialArgs: [...fragments] } }), stop]),
			);
			const events = await collectEvents(stream);
			expect((await stream.result()).stopReason).toBe("toolUse");
			expect(completedCalls(events).map(call => call.arguments)).toEqual([expected]);
		});

		it.each(
			[
				[{ jsonPath: "$.a[]", stringValue: "" }],
				[{ jsonPath: "$.a{}", numberValue: 0 }],
				[{ jsonPath: "$.a[]", boolValue: false }],
				[{ jsonPath: `\${}`, nullValue: null }],
				[{ jsonPath: "$.a[]", willContinue: true }],
				[{ jsonPath: "$[]" }],
				[{ jsonPath: "$[0]{}" }],
				[{ jsonPath: "$.__proto__{}" }],
				[{ jsonPath: '$["__pro\\u0074o__"][]' }],
				[{ jsonPath: "$.constructor{}" }],
				[{ jsonPath: "$['prototype'][]" }],
				[{ jsonPath: `$${".a".repeat(129)}{}` }],
				[{ jsonPath: "$.a[][]" }],
				[{ jsonPath: "$.a{}{}" }],
				[{ jsonPath: "$.a[].b{}" }],
				[{ jsonPath: "$.a[?(@.x)]{}" }],
				[{ jsonPath: "$.a[1]{}" }],
				[{ jsonPath: "$.a", numberValue: 1 }, { jsonPath: "$.a{}" }],
				[{ jsonPath: "$.a", stringValue: "open", willContinue: true }, { jsonPath: "$.a[]" }],
				[{ jsonPath: "$.a{}" }, { jsonPath: "$.a", boolValue: true }],
				[{ jsonPath: "$.a[]" }, { jsonPath: "$.a{}" }],
				[{ jsonPath: "$.a{}" }, { jsonPath: "$.a[]" }],
				[{ jsonPath: "$.a[0]", numberValue: 1 }, { jsonPath: "$.a{}" }],
				[{ jsonPath: "$.a.b", numberValue: 1 }, { jsonPath: "$.a[]" }],
				[{ jsonPath: "$.a[]" }, { jsonPath: "$.a.b", numberValue: 1 }],
				[{ jsonPath: "$.a{}" }, { jsonPath: "$.a[0]", numberValue: 1 }],
			].map(fragments => ({ fragments })),
		)("rejects invalid container fragments %j", async ({ fragments }) => {
			const { stream } = openStream(
				api,
				createSseResponse([chunk({ functionCall: { name: "write", partialArgs: fragments } }), stop]),
			);
			const events = await collectEvents(stream);
			expectNoDispatch(events);
			expect((await stream.result()).content).toEqual([]);
		});

		it.each([
			"EOF",
			"STOP",
			"MAX_TOKENS",
		])("does not treat container markers as call completion at %s", async ending => {
			const { stream } = openStream(
				api,
				createSseResponse([
					chunk({
						functionCall: {
							name: "write",
							partialArgs: [{ jsonPath: "$.items[]" }, { jsonPath: `\${}` }],
							willContinue: true,
						},
					}),
					...(ending === "EOF" ? [] : [{ candidates: [{ finishReason: ending }] }]),
				]),
			);
			const events = await collectEvents(stream);
			expectNoDispatch(events);
			expect((await stream.result()).errorMessage).toContain("incomplete function call");
		});

		it("does not let container markers finish an open descendant string", async () => {
			const { stream } = openStream(
				api,
				createSseResponse([
					chunk({
						functionCall: {
							name: "write",
							partialArgs: [
								{ jsonPath: "$.items[0].value", stringValue: "open", willContinue: true },
								{ jsonPath: "$.items[0]{}" },
								{ jsonPath: "$.items[]" },
								{ jsonPath: `\${}` },
							],
						},
					}),
					stop,
				]),
			);
			const events = await collectEvents(stream);
			expectNoDispatch(events);
			expect((await stream.result()).errorMessage).toContain("incomplete argument string");
		});

		it.each([
			{ modelId: "gemini-3.1-pro", serverId: true },
			{ modelId: "gemini-3.1-pro", serverId: false },
			{ modelId: "gemini-4-argon", serverId: true },
			{ modelId: "gemini-4-argon", serverId: false },
		])("round-trips sequential calls on $modelId with server ID=$serverId", async ({ modelId, serverId }) => {
			const opaqueId = `call:/+|?=&${"opaque.segment-".repeat(20)}:end`;
			const secondId = `${opaqueId}/second`;
			const first = openStream(
				api,
				createSseResponse([
					chunk({
						functionCall: { name: "write", ...(serverId && { id: opaqueId }), willContinue: true },
						thoughtSignature: "Zmlyc3Q=",
					}),
					chunk({
						functionCall: {
							partialArgs: [{ jsonPath: "$.content", stringValue: "first ", willContinue: true }],
							willContinue: true,
						},
					}),
					chunk({ functionCall: { partialArgs: [{ jsonPath: "$.content", stringValue: "body" }] } }),
					chunk({ functionCall: { name: "write", id: secondId, willContinue: true } }),
					chunk({
						functionCall: { partialArgs: [{ jsonPath: "$.content", stringValue: "second body" }] },
						thoughtSignature: "c2Vjb25k",
					}),
					stop,
				]),
				{},
				modelId,
			);
			const events = await collectEvents(first.stream);
			const assistant = await first.stream.result();
			const calls = completedCalls(events);
			expect(assistant.stopReason).toBe("toolUse");
			expect(calls).toHaveLength(2);
			const firstId = calls[0]!.id;
			if (serverId) {
				expect(firstId).toBe(opaqueId);
			} else {
				expect(firstId).toMatch(/^write_\d+_\d+$/);
				expect(firstId).not.toBe(secondId);
			}
			expect(calls).toEqual([
				{
					type: "toolCall",
					id: firstId,
					name: "write",
					arguments: { content: "first body" },
					thoughtSignature: "Zmlyc3Q=",
				},
				{
					type: "toolCall",
					id: secondId,
					name: "write",
					arguments: { content: "second body" },
					thoughtSignature: "c2Vjb25k",
				},
			]);
			expect(assistant.content).toEqual(calls);
			const results: ToolResultMessage[] = calls.map((call, index) => ({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: `result ${index + 1}` }],
				isError: false,
				timestamp: index + 2,
			}));
			const second = openStream(api, createSseResponse([chunk({ text: "done" }), stop]), {}, modelId, "v1", {
				...context,
				messages: [...context.messages, assistant, ...results],
			});
			expect((await second.stream.result()).stopReason).toBe("stop");
			expect(first.requests).toHaveLength(1);
			expect(second.requests).toHaveLength(1);
			expect(second.requests[0]?.body.contents).toEqual([
				{ role: "user", parts: [{ text: "write the file" }] },
				{
					role: "model",
					parts: [
						{
							functionCall: { id: firstId, name: "write", args: { content: "first body" } },
							thoughtSignature: "Zmlyc3Q=",
						},
						{
							functionCall: { id: secondId, name: "write", args: { content: "second body" } },
							thoughtSignature: "c2Vjb25k",
						},
					],
				},
				{
					role: "user",
					parts: [
						{ functionResponse: { id: firstId, name: "write", response: { output: "result 1" } } },
						{ functionResponse: { id: secondId, name: "write", response: { output: "result 2" } } },
					],
				},
			]);
		});

		it("keeps older native Gemini requests free of call IDs and argument streaming", async () => {
			const modelId = "gemini-2.5-pro";
			const first = openStream(
				api,
				createSseResponse([
					chunk({
						functionCall: { name: "write", id: "older-id", args: { content: "body" } },
						thoughtSignature: "c2ln",
					}),
					stop,
				]),
				{},
				modelId,
			);
			const assistant = await first.stream.result();
			expect(assistant.stopReason).toBe("toolUse");
			const second = openStream(api, createSseResponse([chunk({ text: "done" }), stop]), {}, modelId, "v1", {
				...context,
				messages: [
					...context.messages,
					assistant,
					{
						role: "toolResult",
						toolCallId: "older-id",
						toolName: "write",
						content: [{ type: "text", text: "ok" }],
						isError: false,
						timestamp: 2,
					},
				],
			});
			expect((await second.stream.result()).stopReason).toBe("stop");
			expect(first.requests[0]?.body.toolConfig).toBeUndefined();
			expect(second.requests[0]?.body.toolConfig).toBeUndefined();
			expect(second.requests[0]?.body.contents).toEqual([
				{ role: "user", parts: [{ text: "write the file" }] },
				{
					role: "model",
					parts: [{ functionCall: { name: "write", args: { content: "body" } }, thoughtSignature: "c2ln" }],
				},
				{
					role: "user",
					parts: [{ functionResponse: { name: "write", response: { output: "ok" } } }],
				},
			]);
		});

		it("enables native v1 argument streaming and assembles large strings, objects and dense arrays", async () => {
			const large = '한글\n"\\'.repeat(20_000);
			const parts: Part[] = [
				{ functionCall: { name: "write", willContinue: true } },
				{
					functionCall: {
						partialArgs: [{ jsonPath: "$.content", stringValue: large, willContinue: true }],
						willContinue: true,
					},
				},
				{ functionCall: { partialArgs: [{ jsonPath: "$.content", stringValue: "tail" }], willContinue: true } },
				{
					functionCall: {
						partialArgs: [
							{ jsonPath: "$.nested.enabled", boolValue: true },
							{ jsonPath: "$.nested.count", numberValue: 2.5 },
							{ jsonPath: "$.nested.이름", stringValue: "value" },
							{ jsonPath: "$.items[1].value", nullValue: "NULL_VALUE" },
							{ jsonPath: "$.items[0]", stringValue: "first" },
							{ jsonPath: "$.nested[\"quote\\\"key\"]['apostrophe\\'key']", stringValue: "escaped" },
							{ jsonPath: '$.nested["back\\\\slash"]["\\u0061.b"]', boolValue: false },
						],
						willContinue: true,
					},
				},
				{ functionCall: { id: "late-id", willContinue: true } },
				{ thoughtSignature: "c2lnbmF0dXJl" },
				{ functionCall: {} },
			];
			let rawEvents = 0;
			const { stream, requests } = openStream(api, createSseResponse([...parts.map(part => chunk(part)), stop]), {
				onSseEvent: () => {
					rawEvents++;
				},
			});
			const events = await collectEvents(stream);
			const result = await stream.result();
			const expected = {
				content: `${large}tail`,
				nested: {
					enabled: true,
					count: 2.5,
					이름: "value",
					'quote"key': { "apostrophe'key": "escaped" },
					"back\\slash": { "a.b": false },
				},
				items: ["first", { value: null }],
			};
			expect(requests[0]?.url).toContain("/v1/");
			expect(requests[0]?.body.toolConfig).toEqual({
				functionCallingConfig: { mode: "AUTO", streamFunctionCallArguments: true },
			});
			expect(result.stopReason).toBe("toolUse");
			expect(completedCalls(events)).toEqual([
				{
					type: "toolCall",
					id: "late-id",
					name: "write",
					arguments: expected,
					thoughtSignature: "c2lnbmF0dXJl",
				},
			]);
			expect(events.filter(event => event.type === "toolcall_start")).toHaveLength(1);
			const deltas = events.filter(event => event.type === "toolcall_delta");
			expect(deltas).toHaveLength(1);
			expect(JSON.parse(deltas.map(event => event.delta).join(""))).toEqual(expected);
			expect(rawEvents).toBe(parts.length + 1);
		});

		it("handles empty structural chunks, late identity, valueless string endings and sequential calls exactly once", async () => {
			const { stream } = openStream(
				api,
				createSseResponse([
					chunk({ functionCall: {} }),
					chunk({ functionCall: { willContinue: true } }),
					chunk({
						functionCall: {
							partialArgs: [{ jsonPath: "$.content", stringValue: "first", willContinue: true }],
							willContinue: true,
						},
					}),
					chunk({ functionCall: { name: "write", willContinue: true }, thoughtSignature: "Zmlyc3Q=" }),
					chunk({ functionCall: { partialArgs: [{ jsonPath: "$.content" }], id: "first-id" } }),
					chunk({ functionCall: {} }),
					chunk({ functionCall: { name: "write", willContinue: true } }),
					chunk({
						functionCall: {
							partialArgs: [{ jsonPath: "$.content", stringValue: "second" }],
							willContinue: false,
						},
					}),
					chunk({ thoughtSignature: "c2Vjb25k" }),
					chunk(
						{
							functionCall: { name: "write", args: { content: "ordinary", nested: {}, items: [] } },
							thoughtSignature: "dGhpcmQ=",
						},
						{ functionCall: { name: "write" } },
					),
					stop,
				]),
			);
			const events = await collectEvents(stream);
			const result = await stream.result();
			const calls = completedCalls(events);
			expect(calls).toHaveLength(4);
			expect(calls.map(call => call.arguments)).toEqual([
				{ content: "first" },
				{ content: "second" },
				{ content: "ordinary", nested: {}, items: [] },
				{},
			]);
			expect(calls.map(call => call.thoughtSignature)).toEqual(["Zmlyc3Q=", "c2Vjb25k", "dGhpcmQ=", undefined]);
			expect(calls[0]?.id).toBe("first-id");
			expect(new Set(calls.map(call => call.id)).size).toBe(4);
			expect(events.filter(event => event.type === "toolcall_start")).toHaveLength(4);
			expect(events.filter(event => event.type === "toolcall_delta")).toHaveLength(4);
			expect(result.content).toEqual(calls);
			expect(result.stopReason).toBe("toolUse");
		});

		it("accepts repeated identity, canonical path aliases and empty string terminators", async () => {
			const { stream } = openStream(
				api,
				createSseResponse([
					chunk({
						functionCall: {
							name: "write",
							id: "stable",
							partialArgs: [
								{ jsonPath: "$.content", stringValue: "text", willContinue: true },
								{ jsonPath: "$.items[0][0]", nullValue: null },
								{ jsonPath: "$.items[0][1]", nullValue: 0 },
								{ jsonPath: "$.items[1][0]", numberValue: 0 },
							],
							willContinue: true,
						},
					}),
					chunk({
						functionCall: {
							name: "write",
							id: "stable",
							partialArgs: [{ jsonPath: '$["content"]', stringValue: "" }],
						},
					}),
					stop,
				]),
			);
			const events = await collectEvents(stream);
			expect((await stream.result()).stopReason).toBe("toolUse");
			expect(completedCalls(events)).toEqual([
				{
					type: "toolCall",
					name: "write",
					id: "stable",
					arguments: { content: "text", items: [[null, null], [0]] },
				},
			]);
		});

		it("rejects reuse of a completed call ID rather than dispatching it under a new ID", async () => {
			const call: Part = {
				functionCall: {
					name: "write",
					id: "same-id",
					partialArgs: [{ jsonPath: "$.content", stringValue: "once" }],
				},
			};
			const { stream } = openStream(api, createSseResponse([chunk(call), chunk(call), stop]));
			const events = await collectEvents(stream);
			expect(completedCalls(events)).toHaveLength(1);
			expect(events.filter(event => event.type === "toolcall_start")).toHaveLength(1);
			expect(events.filter(event => event.type === "done")).toHaveLength(0);
			expect((await stream.result()).errorMessage).toContain("duplicate call id");
		});

		it("holds full args when the call itself continues", async () => {
			const { stream } = openStream(
				api,
				createSseResponse([
					chunk({ functionCall: { args: { content: "complete" }, willContinue: true } }),
					chunk({ functionCall: { name: "write", id: "full-id", willContinue: true } }),
					chunk({ functionCall: {}, thoughtSignature: "c2ln" }),
					stop,
				]),
			);
			const events = await collectEvents(stream);
			expect((await stream.result()).stopReason).toBe("toolUse");
			expect(completedCalls(events)).toEqual([
				{
					type: "toolCall",
					name: "write",
					id: "full-id",
					arguments: { content: "complete" },
					thoughtSignature: "c2ln",
				},
			]);
		});

		it("treats empty partialArgs as absent alongside full args and on idle terminal markers", async () => {
			const { stream } = openStream(
				api,
				createSseResponse([
					chunk({ functionCall: { partialArgs: [] } }),
					chunk({ functionCall: { name: "write", args: { content: "ok" }, partialArgs: [] } }),
					chunk({ functionCall: { partialArgs: [], willContinue: false } }),
					stop,
				]),
			);
			const events = await collectEvents(stream);
			expect((await stream.result()).stopReason).toBe("toolUse");
			expect(completedCalls(events).map(call => call.arguments)).toEqual([{ content: "ok" }]);
			expect(events.filter(event => event.type === "toolcall_start")).toHaveLength(1);
		});

		it("does not mark empty partialArgs as fragments before later full args", async () => {
			const { stream } = openStream(
				api,
				createSseResponse([
					chunk({ functionCall: { name: "write", partialArgs: [], willContinue: true } }),
					chunk({ functionCall: { args: { content: "ok" } } }),
					stop,
				]),
			);
			const events = await collectEvents(stream);
			expect((await stream.result()).stopReason).toBe("toolUse");
			expect(completedCalls(events).map(call => call.arguments)).toEqual([{ content: "ok" }]);
		});

		for (const argumentsPart of [
			{ args: { content: "ok" } },
			{ partialArgs: [{ jsonPath: "$.content", stringValue: "ok" }] },
		]) {
			it.each([
				undefined,
				false,
			])(`honors call continuation on empty partialArgs after ${JSON.stringify(argumentsPart)} with terminal %s`, async willContinue => {
				const { stream } = openStream(
					api,
					createSseResponse([
						chunk({ functionCall: { name: "write", ...argumentsPart, willContinue: true } }),
						chunk({ functionCall: { partialArgs: [], willContinue: true } }),
						chunk({ functionCall: { id: "late-id", partialArgs: [], willContinue } }),
						stop,
					]),
				);
				const events = await collectEvents(stream);
				expect((await stream.result()).stopReason).toBe("toolUse");
				expect(completedCalls(events)).toEqual([
					{
						type: "toolCall",
						name: "write",
						id: "late-id",
						arguments: { content: "ok" },
					},
				]);
			});
		}

		it("preserves streaming on forced-tool retry and subsequent capability-cached requests", async () => {
			const id = "gemini-4-argon-tool-retry";
			const reply = () =>
				createSseResponse([
					chunk({ functionCall: { name: "write", willContinue: true } }),
					chunk({ functionCall: { partialArgs: [{ jsonPath: "$.content", stringValue: "ok" }] } }),
					stop,
				]);
			const { stream, requests } = openStream(
				api,
				[createErrorResponse("forced tool_choice is not supported"), reply()],
				{
					toolChoice: "required",
					onPayload: payload => {
						const params = payload as { config?: Record<string, unknown> };
						return { ...params, config: { ...params.config, customInjected: "kept" } };
					},
				},
				id,
			);
			const events = await collectEvents(stream);
			expect((await stream.result()).stopReason).toBe("toolUse");
			expect(requests).toHaveLength(2);
			expect(requests[0]?.body.toolConfig).toEqual({
				functionCallingConfig: { mode: "ANY", streamFunctionCallArguments: true },
			});
			expect(requests[1]?.body).toEqual({
				...requests[0]?.body,
				toolConfig: { functionCallingConfig: { mode: "AUTO", streamFunctionCallArguments: true } },
			});
			expect(completedCalls(events)).toHaveLength(1);
			expectSingleCleanFallbackEvents(events);
			const cached = openStream(api, reply(), { toolChoice: "required" }, id);
			expect((await cached.stream.result()).stopReason).toBe("toolUse");
			expect(cached.requests[0]?.body.toolConfig).toEqual({
				functionCallingConfig: { mode: "AUTO", streamFunctionCallArguments: true },
			});
		});

		it.each([
			"gemini-4-argon",
			"gemini-2.5-pro",
		])("preserves complete JSON-owned keys and request configuration for %s", async id => {
			const args = JSON.parse(
				'{"content":"complete","constructor":{"prototype":"data"},"prototype":"ordinary","__proto__":{"polluted":true},"nested":{"constructor":"nested","prototype":true,"__proto__":{"polluted":true}},"items":[{"constructor":"item","prototype":0,"__proto__":{"polluted":true}}]}',
			);
			const { stream, requests } = openStream(
				api,
				createSseResponse([chunk({ functionCall: { name: "write", args, id: "full-id" } }), stop]),
				{ toolChoice: "required" },
				id,
			);
			const events = await collectEvents(stream);
			const calls = completedCalls(events);
			const result = await stream.result();
			expect(result.stopReason).toBe("toolUse");
			expect(calls).toEqual([{ type: "toolCall", name: "write", id: "full-id", arguments: args }]);
			expect(result.content).toEqual(calls);
			const actual = calls[0]!.arguments;
			expect(JSON.stringify(actual)).toBe(JSON.stringify(args));
			for (const object of [actual, actual.nested, (actual.items as unknown[])[0]]) {
				expect(Object.hasOwn(object as object, "__proto__")).toBe(true);
				expect(Object.getPrototypeOf(object)).toBe(Object.prototype);
			}
			expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
			expect(requests[0]?.body.toolConfig).toEqual({
				functionCallingConfig:
					id === "gemini-2.5-pro" ? { mode: "ANY" } : { mode: "ANY", streamFunctionCallArguments: true },
			});
		});

		it.each(["EOF", "STOP", "MAX_TOKENS"])("does not dispatch an unfinished call at %s", async ending => {
			const { stream } = openStream(
				api,
				createSseResponse([
					chunk({
						functionCall: {
							name: "write",
							partialArgs: [{ jsonPath: "$.content", stringValue: "apparently complete" }],
							willContinue: true,
						},
					}),
					...(ending === "EOF" ? [] : [{ candidates: [{ finishReason: ending }] }]),
				]),
			);
			const events = await collectEvents(stream);
			const result = await stream.result();
			expectNoDispatch(events);
			expect(result.content).toEqual([]);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("incomplete function call");
		});

		it("does not expose incomplete progress or dispatch on a transport reset", async () => {
			const encoder = new TextEncoder();
			let pulls = 0;
			const response = new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						if (pulls++ === 0) {
							controller.enqueue(
								encoder.encode(
									`data: ${JSON.stringify(
										chunk({
											functionCall: {
												name: "write",
												partialArgs: [
													{ jsonPath: "$.content", stringValue: "partial", willContinue: true },
												],
												willContinue: true,
											},
										}),
									)}\n\n`,
								),
							);
						} else controller.error(new Error("ECONNRESET synthetic"));
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
			let rawEvents = 0;
			const { stream } = openStream(api, response, {
				onSseEvent: () => {
					rawEvents++;
				},
			});
			const events = await collectEvents(stream);
			const result = await stream.result();
			expectNoDispatch(events);
			expect(result.content).toEqual([]);
			expect(result.errorMessage).toContain("ECONNRESET");
			expect(rawEvents).toBe(1);
		});

		it("does not dispatch a terminal chunk after abort", async () => {
			const controller = new AbortController();
			let rawEvents = 0;
			const { stream } = openStream(
				api,
				createSseResponse([
					chunk({
						functionCall: {
							name: "write",
							partialArgs: [{ jsonPath: "$.content", stringValue: "partial" }],
							willContinue: true,
						},
					}),
					chunk({ functionCall: {} }),
					stop,
				]),
				{
					signal: controller.signal,
					onSseEvent: () => {
						if (++rawEvents === 2) controller.abort();
					},
				},
			);
			const events = await collectEvents(stream);
			const result = await stream.result();
			expectNoDispatch(events);
			expect(result.stopReason).toBe("aborted");
			expect(result.content).toEqual([]);
		});

		it.each([
			"$",
			"$[0]",
			"content",
			"$..content",
			"$.a.*",
			"$.a[-1]",
			"$.a[01]",
			"$.a[1.5]",
			"$.a[4294967295]",
			"$.a[9007199254740992]",
			"$.a[4294967294]",
			"$.a[2]",
			"$.a[?(@.x)]",
			"$.a[0:2]",
			'$["unfinished]',
			'$["bad\\q"]',
			"$.a trailing",
			"$.__proto__.polluted",
			'$["__pro\\u0074o__"].polluted',
			"$.constructor.prototype.polluted",
			"$['prototype']",
			`$${".a".repeat(129)}`,
		])("rejects unsafe or invalid path %s without exposing a tool call", async jsonPath => {
			const { stream } = openStream(
				api,
				createSseResponse([
					chunk({ functionCall: { name: "write", partialArgs: [{ jsonPath, stringValue: "unsafe" }] } }),
					stop,
				]),
			);
			const events = await collectEvents(stream);
			expectNoDispatch(events);
			expect((await stream.result()).content).toEqual([]);
			expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
		});

		it.each([
			{
				label: "unfinished string",
				fragments: [{ jsonPath: "$.content", stringValue: "open", willContinue: true }],
			},
			{
				label: "completed value overwrite",
				fragments: [
					{ jsonPath: "$.content", stringValue: "one" },
					{ jsonPath: "$.content", stringValue: "two" },
				],
			},
			{
				label: "scalar to object",
				fragments: [
					{ jsonPath: "$.a", numberValue: 1 },
					{ jsonPath: "$.a.b", boolValue: true },
				],
			},
			{
				label: "object to scalar",
				fragments: [
					{ jsonPath: "$.a.b", boolValue: true },
					{ jsonPath: "$.a", stringValue: "x" },
				],
			},
			{
				label: "array to object",
				fragments: [
					{ jsonPath: "$.a[0]", numberValue: 1 },
					{ jsonPath: "$.a.b", numberValue: 2 },
				],
			},
			{
				label: "string to number",
				fragments: [
					{ jsonPath: "$.a", stringValue: "x", willContinue: true },
					{ jsonPath: "$.a", numberValue: 2 },
				],
			},
			{ label: "non-string continuation", fragments: [{ jsonPath: "$.a", boolValue: true, willContinue: true }] },
			{ label: "missing value", fragments: [{ jsonPath: "$.a" }] },
			{ label: "ambiguous value", fragments: [{ jsonPath: "$.a", stringValue: "x", numberValue: 1 }] },
			{ label: "invalid number", fragments: [{ jsonPath: "$.a", numberValue: "1" }] },
			{ label: "invalid boolean", fragments: [{ jsonPath: "$.a", boolValue: 0 }] },
			{ label: "invalid null", fragments: [{ jsonPath: "$.a", nullValue: false }] },
			{ label: "invalid continuation", fragments: [{ jsonPath: "$.a", stringValue: "x", willContinue: "true" }] },
		])("rejects $label", async ({ fragments }) => {
			const { stream } = openStream(
				api,
				createSseResponse([
					{ candidates: [{ content: { parts: [{ functionCall: { name: "write", partialArgs: fragments } }] } }] },
					stop,
				]),
			);
			const events = await collectEvents(stream);
			expectNoDispatch(events);
			expect((await stream.result()).content).toEqual([]);
		});

		it.each([
			{ name: "other" },
			{ id: "other-id" },
			{ args: { content: "replacement" } },
		])("rejects conflicting identity or mixed full args: %j", async terminal => {
			const { stream } = openStream(
				api,
				createSseResponse([
					chunk({
						functionCall: {
							name: "write",
							id: "first-id",
							partialArgs: [{ jsonPath: "$.content", stringValue: "original" }],
							willContinue: true,
						},
					}),
					chunk({ functionCall: terminal }),
					stop,
				]),
			);
			const events = await collectEvents(stream);
			expectNoDispatch(events);
			expect((await stream.result()).errorMessage).toContain("conflicting");
		});

		it.each([
			'{"name":"write","partialArgs":[{"jsonPath":"$.a","numberValue":1e400}]}',
			'{"name":"write","args":null}',
			'{"name":"write","args":[]}',
			'{"name":"write","args":"invalid root"}',
			'{"partialArgs":null}',
			'{"partialArgs":{}}',
			'{"partialArgs":""}',
			'{"partialArgs":false}',
			'{"partialArgs":0}',
			'{"name":"write","args":{"content":"ok"},"partialArgs":[{"jsonPath":"$.content","stringValue":"conflict"}]}',
			'{"partialArgs":[{"jsonPath":"$.a","stringValue":"missing name"}]}',
			'{"name":"write","willContinue":"false"}',
		])("rejects malformed wire call %s", async call => {
			const raw = `{"candidates":[{"content":{"parts":[{"functionCall":${call}}]}}]}`;
			const { stream } = openStream(api, createSseResponse([raw, stop]));
			const events = await collectEvents(stream);
			expectNoDispatch(events);
			expect((await stream.result()).content).toEqual([]);
		});
	});
}

it.each([
	{ api: "google-gemini-cli", modelId: "gemini-2.5-pro", idPolicy: "omit" },
	{ api: "google-gemini-cli", modelId: "gemini-3.1-pro", idPolicy: "omit" },
	{ api: "google-gemini-cli", modelId: "gemini-4-argon", idPolicy: "omit" },
	{ api: "google-gemini-cli", modelId: "claude-sonnet-4-5", idPolicy: "sanitize" },
	{ api: "google-vertex", modelId: "claude-sonnet-4-5", idPolicy: "omit" },
	{ api: "google-vertex", modelId: "gemini-4-argon", idPolicy: "opaque" },
	{ api: "google-generative-ai", modelId: "gemini-3.1-pro", idPolicy: "opaque" },
] as const)("preserves $api/$modelId history ID policy: $idPolicy", async ({ api, modelId, idPolicy }) => {
	const opaqueId = `call:/+|${"x".repeat(80)}:end`;
	const { stream } = openStream(
		"google-generative-ai",
		createSseResponse([chunk({ functionCall: { name: "write", id: opaqueId, args: { content: "body" } } }), stop]),
	);
	const assistant = await stream.result();
	expect(assistant.stopReason).toBe("toolUse");
	const contents = convertMessages(
		{ ...createBaseModel(api), provider: api, id: modelId },
		{
			...context,
			messages: [
				...context.messages,
				assistant,
				{
					role: "toolResult",
					toolCallId: opaqueId,
					toolName: "write",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 2,
				},
			],
		},
	);
	const expectedId =
		idPolicy === "omit" ? {} : { id: idPolicy === "sanitize" ? `call____${"x".repeat(56)}` : opaqueId };
	expect(contents.map(content => content.role)).toEqual(["user", "model", "user"]);
	expect(contents[1]?.parts?.map(part => part.functionCall)).toEqual([
		{ name: "write", args: { content: "body" }, ...expectedId },
	]);
	expect(contents[2]?.parts).toEqual([
		{ functionResponse: { name: "write", response: { output: "ok" }, ...expectedId } },
	]);
});

it("also enables streamed arguments on the v1beta1 native endpoint", async () => {
	const { stream, requests } = openStream(
		"google-generative-ai",
		createSseResponse([
			chunk({ functionCall: { name: "write", partialArgs: [{ jsonPath: "$.content", stringValue: "ok" }] } }),
			stop,
		]),
		{},
		"gemini-3.1-pro",
		"v1beta1",
	);
	expect((await stream.result()).stopReason).toBe("toolUse");
	expect(requests[0]?.url).toContain("/v1beta1/");
	expect(requests[0]?.body.toolConfig).toEqual({
		functionCallingConfig: { mode: "AUTO", streamFunctionCallArguments: true },
	});
});

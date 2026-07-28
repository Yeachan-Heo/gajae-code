import { describe, expect, test } from "bun:test";
import { Effort } from "../src/model-thinking";
import { crc32 } from "../src/providers/aws-eventstream";
import {
	buildKiroRequest,
	KIRO_ORIGIN,
	type KiroRequest,
	parseKiroAccessContext,
	resetKiroProfileArnCache,
	resolveKiroProfileArn,
	streamKiro,
} from "../src/providers/kiro";
import { resolveLazyStreamFirstEventFallbackMs } from "../src/providers/register-builtins";
import type { AssistantMessage, AssistantMessageEvent, Model, ProviderSessionState } from "../src/types";
import { fetchKiroModels } from "../src/utils/discovery/kiro";

const BUILDER_ID_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";

const model: Model<"kiro-streaming"> = {
	id: "claude-haiku-4.5",
	name: "claude-haiku-4.5",
	api: "kiro-streaming",
	provider: "kiro",
	baseUrl: "https://runtime.us-east-1.kiro.dev/",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
};

function kiroEventFrame(
	eventType: string,
	payload: Record<string, unknown>,
	messageType: "event" | "exception" | "error" = "event",
): Uint8Array {
	const encodedHeaders: number[] = [];
	for (const [name, value] of Object.entries({ ":message-type": messageType, ":event-type": eventType })) {
		const nameBytes = Buffer.from(name, "utf8");
		const valueBytes = Buffer.from(value, "utf8");
		encodedHeaders.push(nameBytes.length, ...nameBytes, 7, (valueBytes.length >> 8) & 0xff, valueBytes.length & 0xff);
		encodedHeaders.push(...valueBytes);
	}
	const headerBytes = Uint8Array.from(encodedHeaders);
	const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
	const totalLength = 16 + headerBytes.length + payloadBytes.length;
	const frame = new Uint8Array(totalLength);
	const view = new DataView(frame.buffer);
	view.setUint32(0, totalLength, false);
	view.setUint32(4, headerBytes.length, false);
	view.setUint32(8, crc32(frame.subarray(0, 8)), false);
	frame.set(headerBytes, 12);
	frame.set(payloadBytes, 12 + headerBytes.length);
	view.setUint32(totalLength - 4, crc32(frame.subarray(0, totalLength - 4)), false);
	return frame;
}

async function collectKiroEvents(frames: Uint8Array[]): Promise<AssistantMessageEvent[]> {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					for (const frame of frames) controller.enqueue(frame);
					controller.close();
				},
			}),
			{ status: 200 },
		)) as unknown as typeof fetch;
	try {
		const events: AssistantMessageEvent[] = [];
		const stream = streamKiro(
			model,
			{ messages: [{ role: "user", content: "Use the tool", timestamp: 1 }] },
			{ apiKey: "test-token", profileArn: BUILDER_ID_PROFILE_ARN },
		);
		for await (const event of stream) events.push(event);
		return events;
	} finally {
		globalThis.fetch = originalFetch;
	}
}

describe("Kiro provider", () => {
	test("reuses one conversation id across provider-session turns", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch;
		const providerSessionState = new Map<string, ProviderSessionState>();
		const conversationIds: string[] = [];
		const authToken = "test-token";
		try {
			for (let turn = 0; turn < 2; turn += 1) {
				const stream = streamKiro(
					model,
					{ messages: [{ role: "user", content: `turn ${turn}`, timestamp: turn + 1 }] },
					{
						apiKey: authToken,
						profileArn: BUILDER_ID_PROFILE_ARN,
						providerSessionState,
						onPayload: payload => {
							conversationIds.push((payload as KiroRequest).conversationState.conversationId);
						},
					},
				);
				await stream.result();
			}
		} finally {
			globalThis.fetch = originalFetch;
			for (const state of providerSessionState.values()) state.close();
		}
		expect(conversationIds).toHaveLength(2);
		expect(conversationIds[1]).toBe(conversationIds[0]);
	});

	test("honors fetch, payload replacement, response, and header hooks", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new Error("Kiro bypassed the request-scoped fetch override");
		}) as unknown as typeof fetch;
		const authToken = "test-token";
		let fetchCalls = 0;
		let sentContent: string | undefined;
		const observed: { sentHeader?: string | null } = {};
		let responseStatus: number | undefined;
		try {
			const stream = streamKiro(
				model,
				{ messages: [{ role: "user", content: "original", timestamp: 1 }] },
				{
					apiKey: authToken,
					profileArn: BUILDER_ID_PROFILE_ARN,
					headers: { "x-gjc-hook": "present" },
					fetch: async (_input, init) => {
						fetchCalls += 1;
						const payload = JSON.parse(String(init?.body)) as KiroRequest;
						sentContent = payload.conversationState.currentMessage.userInputMessage.content;
						observed.sentHeader = new Headers(init?.headers).get("x-gjc-hook");
						return new Response(
							new ReadableStream<Uint8Array>({
								start(controller) {
									controller.enqueue(kiroEventFrame("metadataEvent", { stopReason: "END_TURN" }));
									controller.close();
								},
							}),
							{ status: 200, headers: { "x-amzn-requestid": "request-1" } },
						);
					},
					onPayload: async payload => {
						const replacement = structuredClone(payload as KiroRequest);
						replacement.conversationState.currentMessage.userInputMessage.content = "replaced";
						return replacement;
					},
					onResponse: metadata => {
						responseStatus = metadata.status;
					},
				},
			);
			const result = await stream.result();
			expect(result.stopReason).toBe("stop");
		} finally {
			globalThis.fetch = originalFetch;
		}
		expect(fetchCalls).toBe(1);
		expect(sentContent).toBe("replaced");
		expect(observed.sentHeader).toBe("present");
		expect(responseStatus).toBe(200);
	});

	test("forwards the caller signal and headers through profile resolution", async () => {
		resetKiroProfileArnCache();
		const authToken = "profile-hook-token";
		const controller = new AbortController();
		const requests: Array<{
			signal: AbortSignal | null | undefined;
			header: string | null;
			authorization: string | null;
			target: string | null;
		}> = [];
		const stream = streamKiro(
			model,
			{ messages: [{ role: "user", content: "profile", timestamp: 1 }] },
			{
				apiKey: authToken,
				signal: controller.signal,
				headers: {
					"x-gjc-profile-hook": "present",
					Authorization: "Bearer override",
					"x-amz-target": "Override.Target",
				},
				fetch: async (_input, init) => {
					requests.push({
						signal: init?.signal,
						header: new Headers(init?.headers).get("x-gjc-profile-hook"),
						authorization: new Headers(init?.headers).get("Authorization"),
						target: new Headers(init?.headers).get("x-amz-target"),
					});
					if (requests.length === 1) return Response.json({ profiles: [{ arn: BUILDER_ID_PROFILE_ARN }] });
					return new Response(
						new ReadableStream<Uint8Array>({
							start(streamController) {
								streamController.enqueue(kiroEventFrame("metadataEvent", { stopReason: "END_TURN" }));
								streamController.close();
							},
						}),
						{ status: 200 },
					);
				},
			},
		);
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(2);
		expect(requests.map(request => request.signal)).toEqual([controller.signal, controller.signal]);
		expect(requests.map(request => request.header)).toEqual(["present", "present"]);
		expect(requests.map(request => request.authorization)).toEqual([`Bearer ${authToken}`, `Bearer ${authToken}`]);
		expect(requests.map(request => request.target)).toEqual([
			"AmazonCodeWhispererService.ListAvailableProfiles",
			"AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
		]);
	});

	test("honors the request retry budget and emits accurate attempt headers", async () => {
		const authToken = "test-token";
		const attemptHeaders: Array<string | null> = [];
		const stream = streamKiro(
			model,
			{ messages: [{ role: "user", content: "retry", timestamp: 1 }] },
			{
				apiKey: authToken,
				profileArn: BUILDER_ID_PROFILE_ARN,
				requestMaxRetries: 2,
				maxRetryDelayMs: 0,
				fetch: async (_input, init) => {
					attemptHeaders.push(new Headers(init?.headers).get("amz-sdk-request"));
					if (attemptHeaders.length < 3) return new Response(null, { status: 500 });
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(kiroEventFrame("metadataEvent", { stopReason: "END_TURN" }));
								controller.close();
							},
						}),
						{ status: 200 },
					);
				},
			},
		);
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(attemptHeaders).toEqual(["attempt=1; max=3", "attempt=2; max=3", "attempt=3; max=3"]);
	});

	test("falls back to the Kiro retry budget for a non-finite override", async () => {
		const authToken = "test-token";
		const attemptHeaders: Array<string | null> = [];
		const stream = streamKiro(
			model,
			{ messages: [{ role: "user", content: "retry", timestamp: 1 }] },
			{
				apiKey: authToken,
				profileArn: BUILDER_ID_PROFILE_ARN,
				requestMaxRetries: Number.NaN,
				maxRetryDelayMs: 0,
				fetch: async (_input, init) => {
					attemptHeaders.push(new Headers(init?.headers).get("amz-sdk-request"));
					if (attemptHeaders.length < 3) return new Response(null, { status: 500 });
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(kiroEventFrame("metadataEvent", { stopReason: "END_TURN" }));
								controller.close();
							},
						}),
						{ status: 200 },
					);
				},
			},
		);
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(attemptHeaders).toEqual(["attempt=1; max=3", "attempt=2; max=3", "attempt=3; max=3"]);
	});

	test("closes an unterminated tool lifecycle and marks it incomplete", async () => {
		const events = await collectKiroEvents([
			kiroEventFrame("toolUseEvent", { toolUseId: "tu-1", name: "echo", input: '{"a":' }),
			kiroEventFrame("metadataEvent", { stopReason: "TOOL_USE" }),
		]);

		expect(events.map(event => event.type)).toEqual([
			"start",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		const end = events.find(event => event.type === "toolcall_end");
		if (end?.type !== "toolcall_end") throw new Error("Expected toolcall_end");
		expect(end.toolCall.incompleteArguments).toBe(true);
		expect("partialJson" in end.toolCall).toBe(false);
	});

	test("emits start before done for an empty successful event stream", async () => {
		const events = await collectKiroEvents([]);
		expect(events.map(event => event.type)).toEqual(["start", "done"]);
	});

	test("does not let trailing metadata erase a terminal stop reason", async () => {
		const maxTokenEvents = await collectKiroEvents([
			kiroEventFrame("metadataEvent", { stopReason: "MAX_TOKENS" }),
			kiroEventFrame("metadataEvent", { requestId: "late-metadata" }),
			kiroEventFrame("metadataEvent", { stopReason: "END_TURN" }),
		]);
		const maxTokenDone = maxTokenEvents.find(event => event.type === "done");
		expect(maxTokenDone?.type === "done" ? maxTokenDone.reason : undefined).toBe("length");

		const toolEvents = await collectKiroEvents([
			kiroEventFrame("toolUseEvent", { toolUseId: "tu-metadata", name: "echo", input: {}, stop: true }),
			kiroEventFrame("metadataEvent", { stopReason: "TOOL_USE" }),
			kiroEventFrame("metadataEvent", { requestId: "late-metadata" }),
			kiroEventFrame("metadataEvent", { stopReason: "END_TURN" }),
		]);
		const toolDone = toolEvents.find(event => event.type === "done");
		expect(toolDone?.type === "done" ? toolDone.reason : undefined).toBe("toolUse");
	});

	test("closes an open tool lifecycle before surfacing a mid-stream exception", async () => {
		const events = await collectKiroEvents([
			kiroEventFrame("toolUseEvent", { toolUseId: "tu-error", name: "echo", input: '{"a":' }),
			kiroEventFrame("serviceException", { message: "boom" }, "exception"),
		]);

		expect(events.map(event => event.type)).toEqual([
			"start",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"error",
		]);
		const end = events.find(event => event.type === "toolcall_end");
		if (end?.type !== "toolcall_end") throw new Error("Expected toolcall_end");
		expect(end.toolCall.incompleteArguments).toBe(true);
	});

	test("keeps the first completed tool call when its id is repeated", async () => {
		const events = await collectKiroEvents([
			kiroEventFrame("toolUseEvent", { toolUseId: "tu-1", name: "echo", input: '{"a":1}', stop: true }),
			kiroEventFrame("toolUseEvent", { toolUseId: "tu-1", name: "echo2", input: '{"b":2}', stop: true }),
		]);

		const endings = events.filter(event => event.type === "toolcall_end");
		expect(endings).toHaveLength(1);
		expect(events.some(event => event.type === "error")).toBe(false);
		expect(events.some(event => event.type === "done")).toBe(true);
		const end = endings[0];
		if (end?.type !== "toolcall_end") throw new Error("Expected toolcall_end");
		expect(end.toolCall.name).toBe("echo");
		expect(end.toolCall.arguments).toEqual({ a: 1 });
	});

	test("preserves object-form tool arguments when the event stops immediately", async () => {
		const events = await collectKiroEvents([
			kiroEventFrame("toolUseEvent", { toolUseId: "tu-object", name: "echo", input: { value: "x" }, stop: true }),
			kiroEventFrame("metadataEvent", { stopReason: "TOOL_USE" }),
		]);

		const end = events.find(event => event.type === "toolcall_end");
		if (end?.type !== "toolcall_end") throw new Error("Expected toolcall_end");
		expect(end.toolCall.arguments).toEqual({ value: "x" });
	});

	test("accepts complete object-form tool arguments even when the stop marker is absent", async () => {
		const events = await collectKiroEvents([
			kiroEventFrame("toolUseEvent", { toolUseId: "tu-object-eof", name: "echo", input: { value: "x" } }),
			kiroEventFrame("metadataEvent", { stopReason: "TOOL_USE" }),
		]);

		const end = events.find(event => event.type === "toolcall_end");
		if (end?.type !== "toolcall_end") throw new Error("Expected toolcall_end");
		expect(end.toolCall.arguments).toEqual({ value: "x" });
		expect(end.toolCall.incompleteArguments).toBeUndefined();
	});

	test("accepts complete string-form tool arguments when the stop marker is absent", async () => {
		const events = await collectKiroEvents([
			kiroEventFrame("toolUseEvent", { toolUseId: "tu-string-eof", name: "echo", input: '{"a":1}' }),
			kiroEventFrame("metadataEvent", { stopReason: "TOOL_USE" }),
		]);

		const end = events.find(event => event.type === "toolcall_end");
		if (end?.type !== "toolcall_end") throw new Error("Expected toolcall_end");
		expect(end.toolCall.arguments).toEqual({ a: 1 });
		expect(end.toolCall.incompleteArguments).toBeUndefined();
	});

	test("marks a stop-flagged tool call incomplete when its JSON is truncated", async () => {
		const events = await collectKiroEvents([
			kiroEventFrame("toolUseEvent", {
				toolUseId: "tu-truncated",
				name: "write",
				input: '{"path":"a",',
				stop: true,
			}),
			kiroEventFrame("metadataEvent", { stopReason: "TOOL_USE" }),
		]);

		const end = events.find(event => event.type === "toolcall_end");
		if (end?.type !== "toolcall_end") throw new Error("Expected toolcall_end");
		expect(end.toolCall.incompleteArguments).toBe(true);
	});

	test("extracts the token and profile ARN from the structured Kiro credential payload", () => {
		const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/GOOGLE";
		expect(
			parseKiroAccessContext(
				JSON.stringify({
					token: "social-token",
					kiroMethod: "google",
					kiroProfileArn: profileArn,
				}),
			),
		).toEqual({ token: "social-token", profileArn });
	});

	test("treats a bare access token as the credential payload", () => {
		expect(parseKiroAccessContext("plain-token")).toEqual({ token: "plain-token" });
	});

	test("omits the upstream message, account id, and ARN from resolution failures", async () => {
		resetKiroProfileArnCache();
		const fetcher = async (): Promise<Response> =>
			new Response(
				JSON.stringify({
					__type: "com.amazon.codewhisperer#ValidationException",
					message: "profile arn:aws:codewhisperer:us-east-1:123456789012:profile/SECRET is invalid",
				}),
				{ status: 400 },
			);
		const error = await resolveKiroProfileArn("token", fetcher).catch((cause: unknown) => cause);
		const message = error instanceof Error ? error.message : String(error);
		expect(message).toBe("Kiro profile resolution failed: HTTP 400");
		expect(message).not.toContain("123456789012");
		expect(message).not.toContain("arn:aws:codewhisperer");
	});
	test("builds native history, tool call, and tool result payloads", () => {
		const request = buildKiroRequest(
			model,
			{
				systemPrompt: ["Be concise."],
				tools: [
					{
						name: "echo_value",
						description: "Echo a value",
						parameters: {
							type: "object",
							properties: { value: { type: "string" } },
							required: ["value"],
						},
					},
				],
				messages: [
					{ role: "user", content: "Use the tool", timestamp: 1 },
					{
						role: "assistant",
						api: "kiro-streaming",
						provider: "kiro",
						model: model.id,
						content: [
							{
								type: "toolCall",
								id: "call_QKsJSt3a0VVwVELmiM3GxIWK|fc_018d34fca8cceb25016a662d98ed6081918f20fcf4dfda78c9",
								name: "echo_value",
								arguments: { value: "x" },
							},
						],
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
						toolCallId: "call_QKsJSt3a0VVwVELmiM3GxIWK|fc_018d34fca8cceb25016a662d98ed6081918f20fcf4dfda78c9",
						toolName: "echo_value",
						content: [{ type: "text", text: "done" }],
						isError: false,
						timestamp: 3,
					},
				],
			},
			BUILDER_ID_PROFILE_ARN,
		);

		expect(request.profileArn).toBe(BUILDER_ID_PROFILE_ARN);
		expect(request.conversationState.history[1]).toEqual({
			assistantResponseMessage: {
				content: "",
				toolUses: [
					{
						toolUseId: "df38b111802bf381130da07069c1b3a38a503eeb01a129129877ba2cf8eb3b8e",
						name: "echo_value",
						input: { value: "x" },
					},
				],
			},
		});
		const current = request.conversationState.currentMessage.userInputMessage;
		expect(current.content).toBe("");
		const firstHistory = request.conversationState.history[0];
		if (!firstHistory || !("userInputMessage" in firstHistory)) throw new Error("Expected initial user history");
		expect(firstHistory.userInputMessage.content).toContain("Be concise.");
		expect(current.userInputMessageContext.toolResults).toEqual([
			{
				toolUseId: "df38b111802bf381130da07069c1b3a38a503eeb01a129129877ba2cf8eb3b8e",
				status: "success",
				content: [{ text: "done" }],
			},
		]);
		const historyToolResults = request.conversationState.history.flatMap(entry =>
			"userInputMessage" in entry ? (entry.userInputMessage.userInputMessageContext.toolResults ?? []) : [],
		);
		expect([...historyToolResults, ...(current.userInputMessageContext.toolResults ?? [])]).toHaveLength(1);
		expect(current.userInputMessageContext.tools?.[0].toolSpecification.name).toBe("echo_value");
		const assistantHistory = request.conversationState.history[1];
		if (!assistantHistory || !("assistantResponseMessage" in assistantHistory)) {
			throw new Error("Expected assistant history");
		}
		const ids = assistantHistory.assistantResponseMessage.toolUses?.map(tool => tool.toolUseId) ?? [];
		expect(ids.every(id => /^[A-Za-z0-9_-]{1,64}$/.test(id))).toBe(true);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("maps profile effort to Kiro adaptive reasoning fields", () => {
		const context = {
			messages: [{ role: "user" as const, content: "Think", timestamp: 1 }],
		};
		const reasoningModel = { ...model, reasoning: true };
		expect(
			buildKiroRequest(reasoningModel, context, BUILDER_ID_PROFILE_ARN, Effort.XHigh).additionalModelRequestFields,
		).toEqual({
			thinking: { type: "adaptive", display: "summarized" },
			reasoning: { effort: "xhigh" },
		});
		expect(buildKiroRequest(reasoningModel, context, BUILDER_ID_PROFILE_ARN).additionalModelRequestFields).toEqual({
			thinking: { type: "disabled" },
		});
	});

	test("repairs orphan tool calls before Kiro serialization", () => {
		const orphan: AssistantMessage = {
			role: "assistant",
			api: "kiro-streaming",
			provider: "kiro",
			model: model.id,
			content: [{ type: "toolCall", id: "orphan|call", name: "echo_value", arguments: {} }],
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
		};
		const request = buildKiroRequest(
			model,
			{
				messages: [
					{ role: "user", content: "Use the tool", timestamp: 1 },
					orphan,
					{ role: "user", content: "Continue", timestamp: 3 },
				],
			},
			BUILDER_ID_PROFILE_ARN,
		);
		const repaired = request.conversationState.history[2];
		expect(repaired).toEqual({
			userInputMessage: {
				content: "",
				userInputMessageContext: {
					envState: {
						operatingSystem: process.platform === "darwin" ? "macos" : process.platform,
						currentWorkingDirectory: process.cwd(),
					},
					toolResults: [
						{
							toolUseId: "17efecc8baf02b3ee24c0ed48de4a5b6a4e9b03fcfdc0f028df5a668008a83c4",
							status: "error",
							content: [{ text: "No result provided" }],
						},
					],
				},
				origin: KIRO_ORIGIN,
				modelId: model.id,
			},
		});
	});

	test("discovers and normalizes the authenticated model catalog", async () => {
		const requests: Request[] = [];
		const resolvedProfileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/PROPLUS";
		const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
			requests.push(request);
			if (request.headers.get("x-amz-target") === "AmazonCodeWhispererService.ListAvailableProfiles") {
				return Response.json({ profiles: [{ arn: resolvedProfileArn, profileName: "QDefaultProfile" }] });
			}
			return Response.json({
				defaultModel: { modelId: "auto" },
				models: [
					{
						modelId: "claude-haiku-4.5",
						modelName: "Claude Haiku 4.5",
						tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 },
					},
				],
			});
		};
		const models = await fetchKiroModels({ accessToken: "token", fetcher });
		expect(requests[0]?.headers.get("x-amz-target")).toBe("AmazonCodeWhispererService.ListAvailableProfiles");
		expect(requests[1]?.headers.get("x-amz-target")).toBe("AmazonCodeWhispererService.ListAvailableModels");
		expect(requests[1]?.headers.get("authorization")).toBe("Bearer token");
		expect(models).toEqual([
			expect.objectContaining({
				id: "claude-haiku-4.5",
				api: "kiro-streaming",
				provider: "kiro",
				contextWindow: 200_000,
				maxTokens: 64_000,
			}),
		]);
		const body = JSON.parse(await requests[1]!.text()) as Record<string, unknown>;
		expect(body).toEqual({ origin: KIRO_ORIGIN, profileArn: resolvedProfileArn });
	});
	test("rejects image content instead of substituting a placeholder", () => {
		const context = {
			messages: [
				{
					role: "user" as const,
					content: [
						{ type: "text" as const, text: "look" },
						{ type: "image" as const, data: "AAAA", mimeType: "image/png" },
					],
					timestamp: 1,
				},
			],
		};
		expect(() => buildKiroRequest(model, context, BUILDER_ID_PROFILE_ARN)).toThrow(
			"Kiro transport does not support image input (received image/png)",
		);
	});

	test("rejects images in tool results before message repair can discard them", () => {
		const context = {
			messages: [
				{
					role: "toolResult" as const,
					toolCallId: "image-call",
					toolName: "screenshot",
					content: [{ type: "image" as const, data: "AAAA", mimeType: "image/png" }],
					isError: false,
					timestamp: 1,
				},
			],
		};
		expect(() => buildKiroRequest(model, context, BUILDER_ID_PROFILE_ARN)).toThrow(
			"Kiro transport does not support image input (received image/png)",
		);
	});

	test("downgrades a trailing orphan tool result to one stale user message", () => {
		const request = buildKiroRequest(
			model,
			{
				messages: [
					{ role: "user", content: "before orphan", timestamp: 0 },
					{
						role: "toolResult",
						toolCallId: "orphan-error",
						toolName: "echo",
						content: [{ type: "text", text: "FAILED_BADLY" }],
						isError: true,
						timestamp: 1,
					},
				],
			},
			BUILDER_ID_PROFILE_ARN,
		);
		const current = request.conversationState.currentMessage.userInputMessage;
		expect(current.content).toContain("<stale-tool-result");
		expect(current.content).toContain("FAILED_BADLY");
		expect(current.userInputMessageContext.toolResults).toBeUndefined();
		expect(JSON.stringify(request).match(/FAILED_BADLY/g)).toHaveLength(1);
	});

	test("isolates memoized profile ARNs per access token and clears on reset", async () => {
		resetKiroProfileArnCache();
		const targets: string[] = [];
		const fetcher = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const token = String(new Headers(init?.headers).get("authorization"));
			targets.push(token);
			return Response.json({ profiles: [{ arn: `arn:aws:codewhisperer:us-east-1:1:profile/${token}` }] });
		};

		// Distinct tokens resolve independently: neither inherits the other's ARN.
		expect(await resolveKiroProfileArn("token-a", fetcher)).toContain("Bearer token-a");
		expect(await resolveKiroProfileArn("token-b", fetcher)).toContain("Bearer token-b");
		expect(targets).toEqual(["Bearer token-a", "Bearer token-b"]);

		// A repeat lookup for an already-resolved token performs no round trip.
		expect(await resolveKiroProfileArn("token-a", fetcher)).toContain("Bearer token-a");
		expect(targets).toHaveLength(2);

		// Reset drops the memoized entries, so the next lookup resolves again.
		resetKiroProfileArnCache();
		expect(await resolveKiroProfileArn("token-a", fetcher)).toContain("Bearer token-a");
		expect(targets).toEqual(["Bearer token-a", "Bearer token-b", "Bearer token-a"]);
	});

	test("coalesces concurrent profile ARN resolutions for one access token", async () => {
		resetKiroProfileArnCache();
		let calls = 0;
		const fetcher = async (): Promise<Response> => {
			calls += 1;
			await Bun.sleep(10);
			return Response.json({ profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:1:profile/ONE" }] });
		};

		const results = await Promise.all([
			resolveKiroProfileArn("shared-token", fetcher),
			resolveKiroProfileArn("shared-token", fetcher),
			resolveKiroProfileArn("shared-token", fetcher),
		]);
		expect(calls).toBe(1);
		expect(new Set(results)).toEqual(new Set(["arn:aws:codewhisperer:us-east-1:1:profile/ONE"]));
	});

	test("does not let an in-flight pre-reset ARN repopulate the cache", async () => {
		resetKiroProfileArnCache();
		let release!: (response: Response) => void;
		const pendingResponse = new Promise<Response>(resolve => {
			release = resolve;
		});
		const staleResolution = resolveKiroProfileArn("reset-token", async () => pendingResponse);

		resetKiroProfileArnCache();
		release(Response.json({ profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:1:profile/STALE" }] }));
		expect(await staleResolution).toEndWith("/STALE");

		let freshCalls = 0;
		const fresh = await resolveKiroProfileArn("reset-token", async () => {
			freshCalls += 1;
			return Response.json({ profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:1:profile/FRESH" }] });
		});
		expect(fresh).toEndWith("/FRESH");
		expect(freshCalls).toBe(1);
	});

	test("deduplicates discovered models and detects reasoning only from schema properties", async () => {
		const fetcher = async (): Promise<Response> =>
			Response.json({
				models: [
					{
						modelId: "plain",
						additionalModelRequestFieldsSchema: {
							type: "object",
							description: 'The word "thinking" here is prose only',
							properties: {},
						},
					},
					{ modelId: "plain", modelName: "duplicate" },
					{
						modelId: "reasoning",
						additionalModelRequestFieldsSchema: { type: "object", properties: { thinking: { type: "object" } } },
					},
				],
			});

		const models = await fetchKiroModels({ accessToken: "token", profileArn: BUILDER_ID_PROFILE_ARN, fetcher });
		expect(models?.map(discovered => discovered.id)).toEqual(["plain", "reasoning"]);
		expect(models?.find(discovered => discovered.id === "plain")?.reasoning).toBe(false);
		expect(models?.find(discovered => discovered.id === "reasoning")?.reasoning).toBe(true);
	});

	test("returns null when profile resolution fails during discovery", async () => {
		resetKiroProfileArnCache();
		const fetcher = async (): Promise<Response> => new Response("denied", { status: 403 });
		await expect(fetchKiroModels({ accessToken: "revoked-token", fetcher })).resolves.toBeNull();
	});

	test("keeps Kiro's first-event floor out of provider-name routing", () => {
		expect(resolveLazyStreamFirstEventFallbackMs("kiro")).toBeUndefined();
		expect(resolveLazyStreamFirstEventFallbackMs("anthropic")).toBeUndefined();
	});
});

/**
 * Tests for Kiro native reasoning support via reasoningContentEvent
 * and additionalModelRequestFields.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Effort } from "../src/model-thinking";
import { crc32 } from "../src/providers/aws-eventstream";
import { buildKiroAdditionalModelRequestFields, streamKiroApiKey } from "../src/providers/kiro-api-key";
import { streamKiroCodeWhisperer } from "../src/providers/kiro-codewhisperer";
import type { KiroAdditionalModelRequestFields } from "../src/providers/kiro-reasoning-parser";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "../src/types";

const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/social-profile";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function encodeStringHeader(name: string, value: string): Uint8Array {
	const nameBytes = new TextEncoder().encode(name);
	const valueBytes = new TextEncoder().encode(value);
	const header = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
	const view = new DataView(header.buffer);
	let offset = 0;
	view.setUint8(offset, nameBytes.length);
	offset += 1;
	header.set(nameBytes, offset);
	offset += nameBytes.length;
	view.setUint8(offset, 7);
	offset += 1;
	view.setUint16(offset, valueBytes.length, false);
	offset += 2;
	header.set(valueBytes, offset);
	return header;
}

function encodeEventStreamFrame(eventType: string, payload: Record<string, unknown>): Uint8Array {
	const headers = [
		encodeStringHeader(":message-type", "event"),
		encodeStringHeader(":event-type", eventType),
		encodeStringHeader(":content-type", "application/json"),
	];
	const headerLength = headers.reduce((total, header) => total + header.length, 0);
	const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
	const frameLength = 4 + 4 + 4 + headerLength + payloadBytes.length + 4;
	const frame = new Uint8Array(frameLength);
	const view = new DataView(frame.buffer);
	view.setUint32(0, frameLength, false);
	view.setUint32(4, headerLength, false);
	view.setUint32(8, crc32(frame.subarray(0, 8)), false);
	let offset = 12;
	for (const header of headers) {
		frame.set(header, offset);
		offset += header.length;
	}
	frame.set(payloadBytes, offset);
	view.setUint32(frameLength - 4, crc32(frame.subarray(0, frameLength - 4)), false);
	return frame;
}

function eventStreamResponse(events: Array<{ type: string; payload: Record<string, unknown> }>): Response {
	const frames = events.map(e => encodeEventStreamFrame(e.type, e.payload));
	const length = frames.reduce((total, frame) => total + frame.length, 0);
	const body = new Uint8Array(length);
	let offset = 0;
	for (const frame of frames) {
		body.set(frame, offset);
		offset += frame.length;
	}
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "application/vnd.amazon.eventstream" },
	});
}

async function runStream(
	events: Array<{ type: string; payload: Record<string, unknown> }>,
	model: Model<"kiro-codewhisperer-stream">,
	options: { reasoning?: Effort | boolean } = {},
): Promise<{
	request: Record<string, unknown>;
	message: AssistantMessage;
	eventTypes: string[];
	streamEvents: AssistantMessageEvent[];
}> {
	let request: Record<string, unknown> | undefined;
	(globalThis.fetch as any) = async (_input: string | URL | Request, init?: RequestInit) => {
		if (!(init?.body instanceof Uint8Array)) throw new Error("expected encoded Kiro request body");
		request = JSON.parse(new TextDecoder().decode(init.body)) as Record<string, unknown>;
		return eventStreamResponse(events);
	};
	let message: AssistantMessage | undefined;
	const eventTypes: string[] = [];
	const streamEvents: AssistantMessageEvent[] = [];
	for await (const event of streamKiroCodeWhisperer(
		model,
		{ messages: [{ role: "user", content: "Test", timestamp: 1 }] } satisfies Context,
		{ apiKey: JSON.stringify({ token: "social-access-token", profileArn: PROFILE_ARN }), ...options },
	)) {
		eventTypes.push(event.type);
		streamEvents.push(event);
		if (event.type === "done") message = event.message;
	}
	if (!request || !message) throw new Error("Stream did not produce a request and final message");
	return { request, message, eventTypes, streamEvents };
}

describe("Kiro native reasoning", () => {
	test("buildKiroAdditionalModelRequestFields returns correct format for Claude 4.6+", () => {
		const model: Model<"kiro-codewhisperer-stream"> = {
			id: "claude-opus-4.6",
			name: "Claude Opus 4.6",
			api: "kiro-codewhisperer-stream",
			provider: "kiro",
			baseUrl: "",
			reasoning: true,
			input: ["text"],
			output: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		};

		const fields = buildKiroAdditionalModelRequestFields(model, Effort.High);
		expect(fields).toBeDefined();
		expect((fields as any)?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect((fields as any)?.output_config?.effort).toBe(Effort.High);
	});

	test("buildKiroAdditionalModelRequestFields returns undefined for Claude when reasoning disabled", () => {
		const model: Model<"kiro-codewhisperer-stream"> = {
			id: "claude-opus-4.6",
			name: "Claude Opus 4.6",
			api: "kiro-codewhisperer-stream",
			provider: "kiro",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			output: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		};

		const fields = buildKiroAdditionalModelRequestFields(model, false);
		expect(fields).toBeUndefined();
	});

	test("buildKiroAdditionalModelRequestFields returns correct format for GPT 5.6", () => {
		const model: Model<"kiro-codewhisperer-stream"> = {
			id: "gpt-5.6-luna",
			name: "GPT 5.6 Luna",
			api: "kiro-codewhisperer-stream",
			provider: "kiro",
			baseUrl: "",
			reasoning: true,
			input: ["text"],
			output: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272_000,
			maxTokens: 128_000,
		};

		const fields = buildKiroAdditionalModelRequestFields(model, Effort.High);
		expect(fields).toBeDefined();
		expect((fields as any)?.reasoning).toBeDefined();
		expect((fields as any)?.reasoning?.effort).toBe(Effort.High);
	});

	test("parses reasoningContentEvent with text", async () => {
		const model: Model<"kiro-codewhisperer-stream"> = {
			id: "claude-opus-4.6",
			name: "Claude Opus 4.6",
			api: "kiro-codewhisperer-stream",
			provider: "kiro",
			baseUrl: "",
			reasoning: true,
			input: ["text"],
			output: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		};

		const { message, eventTypes } = await runStream(
			[
				{ type: "reasoningContentEvent", payload: { text: "thinking " } },
				{ type: "reasoningContentEvent", payload: { text: "about problem" } },
				{ type: "assistantResponseEvent", payload: { content: "answer" } },
			],
			model,
			{ reasoning: Effort.High },
		);

		const thinkingBlock = message.content.find(b => b.type === "thinking");
		expect(thinkingBlock).toBeDefined();
		expect((thinkingBlock as any)?.thinking).toBe("thinking about problem");
		expect(eventTypes).toContain("thinking_start");
		expect(eventTypes).toContain("thinking_delta");
	});

	test("parses reasoningContentEvent with signature", async () => {
		const model: Model<"kiro-codewhisperer-stream"> = {
			id: "claude-opus-4.6",
			name: "Claude Opus 4.6",
			api: "kiro-codewhisperer-stream",
			provider: "kiro",
			baseUrl: "",
			reasoning: true,
			input: ["text"],
			output: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		};

		const { message } = await runStream(
			[
				{ type: "reasoningContentEvent", payload: { signature: "abc123" } },
				{ type: "assistantResponseEvent", payload: { content: "answer" } },
			],
			model,
		);

		const thinkingBlock = message.content.find(b => b.type === "thinking");
		expect(thinkingBlock).toBeDefined();
		expect((thinkingBlock as any)?.thinkingSignature).toBe("kiro:signature:abc123");
	});

	test("parses reasoningContentEvent with redactedContent", async () => {
		const model: Model<"kiro-codewhisperer-stream"> = {
			id: "claude-opus-4.6",
			name: "Claude Opus 4.6",
			api: "kiro-codewhisperer-stream",
			provider: "kiro",
			baseUrl: "",
			reasoning: true,
			input: ["text"],
			output: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		};

		const { message } = await runStream(
			[
				{
					type: "reasoningContentEvent",
					payload: { redactedContent: "private_data_blob" },
				},
				{ type: "assistantResponseEvent", payload: { content: "answer" } },
			],
			model,
		);

		const thinkingBlock = message.content.find(b => b.type === "thinking");
		expect(thinkingBlock).toBeDefined();
		expect((thinkingBlock as any)?.thinkingSignature).toBe("kiro:redactedContent:private_data_blob");
	});

	test("two-turn replay with thinking signature", async () => {
		const model: Model<"kiro-codewhisperer-stream"> = {
			id: "claude-opus-4.6",
			name: "Claude Opus 4.6",
			api: "kiro-codewhisperer-stream",
			provider: "kiro",
			baseUrl: "",
			reasoning: true,
			input: ["text"],
			output: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		};

		// First turn with reasoning: build request and capture assistant message with signature
		const { message: firstMessage } = await runStream(
			[
				{ type: "reasoningContentEvent", payload: { text: "analyzing...", signature: "sig1" } },
				{ type: "assistantResponseEvent", payload: { content: "result" } },
			],
			model,
			{ reasoning: Effort.High },
		);

		const thinkingBlock = firstMessage.content.find(
			b => b.type === "thinking" && (b as any).thinkingSignature === "kiro:signature:sig1",
		);
		expect(thinkingBlock).toBeDefined();

		// Second turn: build request with first turn's message in history
		let secondRequest: Record<string, unknown> | undefined;
		(globalThis.fetch as any) = async (_input: string | URL | Request, init?: RequestInit) => {
			if (!(init?.body instanceof Uint8Array)) throw new Error("expected encoded Kiro request body");
			secondRequest = JSON.parse(new TextDecoder().decode(init.body)) as Record<string, unknown>;
			return eventStreamResponse([{ type: "assistantResponseEvent", payload: { content: "follow-up answer" } }]);
		};

		const secondMessage: AssistantMessage | undefined = await (async () => {
			for await (const event of streamKiroCodeWhisperer(
				model,
				{
					messages: [
						{ role: "user", content: "First question", timestamp: 1 },
						firstMessage,
						{ role: "user", content: "Second question", timestamp: 2 },
					],
				} satisfies Context,
				{
					apiKey: JSON.stringify({ token: "social-access-token", profileArn: PROFILE_ARN }),
					reasoning: Effort.High,
				},
			)) {
				if (event.type === "done") return event.message;
			}
			return undefined;
		})();

		expect(secondMessage).toBeDefined();
		expect(secondRequest).toBeDefined();

		// Verify the second request's history includes the first turn's thinking signature
		const history = (secondRequest as any)?.conversationState?.history;
		expect(history).toBeDefined();
		expect(Array.isArray(history)).toBe(true);

		// First message in history should be the first user message
		const firstHistoryUserMsg = history?.[0];
		expect(firstHistoryUserMsg?.userInputMessage?.content).toBe("First question");

		// Second message in history should be the assistant's response with signature
		const assistantHistoryMsg = history?.[1];
		expect(assistantHistoryMsg?.assistantResponseMessage).toBeDefined();
		expect(assistantHistoryMsg?.assistantResponseMessage?.content).toContain("result");
		expect((assistantHistoryMsg?.assistantResponseMessage as any)?.reasoningContent?.signature).toBe("sig1");
	});

	test("prompt prefix is absent when native fields are sent", async () => {
		const model: Model<"kiro-codewhisperer-stream"> = {
			id: "claude-opus-4.6",
			name: "Claude Opus 4.6",
			api: "kiro-codewhisperer-stream",
			provider: "kiro",
			baseUrl: "",
			reasoning: true,
			input: ["text"],
			output: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		};

		const originalSystemPrompt = "You are a helpful assistant.";
		let request: Record<string, unknown> | undefined;
		(globalThis.fetch as any) = async (_input: string | URL | Request, init?: RequestInit) => {
			if (!(init?.body instanceof Uint8Array)) throw new Error("expected encoded Kiro request body");
			request = JSON.parse(new TextDecoder().decode(init.body)) as Record<string, unknown>;
			return eventStreamResponse([{ type: "assistantResponseEvent", payload: { content: "answer" } }]);
		};

		for await (const _event of streamKiroCodeWhisperer(
			model,
			{
				systemPrompt: [originalSystemPrompt],
				messages: [{ role: "user", content: "Test", timestamp: 1 }],
			} satisfies Context,
			{ apiKey: JSON.stringify({ token: "social-access-token", profileArn: PROFILE_ARN }), reasoning: Effort.High },
		)) {
			if (_event.type === "done") break;
		}

		expect(request).toBeDefined();
		const content = (request as any)?.conversationState?.currentMessage?.userInputMessage?.content;
		expect(content).toBeDefined();

		// When native reasoning is enabled (additionalModelRequestFields is sent),
		// the prompt should not include the thinking mode prefix
		expect(content).not.toContain("<thinking_mode>");
		expect(content).not.toContain("<max_thinking_length>");
		expect(content).toContain(originalSystemPrompt);

		// additionalModelRequestFields should be present
		expect((request as any)?.additionalModelRequestFields).toBeDefined();
		expect(((request as any)?.additionalModelRequestFields as any)?.thinking?.type).toBe("adaptive");
	});
});

function kiroModel(id: string): Model<"kiro-codewhisperer-stream"> {
	return {
		id,
		name: id,
		api: "kiro-codewhisperer-stream",
		provider: "kiro",
		baseUrl: "",
		reasoning: true,
		input: ["text"],
		output: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	};
}

describe("Kiro native reasoning field matrix", () => {
	const adaptive = (effort: string) => ({
		thinking: { type: "adaptive", display: "summarized" },
		output_config: { effort },
	});
	test.each([
		["claude-opus-4.6", Effort.High, adaptive("high")],
		["claude-opus-4-8", Effort.Medium, adaptive("medium")],
		["claude-sonnet-5.5", Effort.Low, adaptive("low")],
		["kimi-k3", Effort.High, adaptive("high")],
		["claude-opus-4.6", Effort.Minimal, adaptive("low")],
		["claude-opus-4.6", true, adaptive("medium")],
		["claude-opus-4.6", false, undefined],
		["claude-opus-4.5", Effort.High, undefined],
		["claude-sonnet-4-5", Effort.High, undefined],
		["claude-opus-4.9", Effort.High, adaptive("high")],
		["claude-opus-6", Effort.High, adaptive("high")],
		["claude-sonnet-4", Effort.High, undefined],
		["claude-haiku-4.5", Effort.High, undefined],
		["gpt-6-sol", Effort.High, { reasoning: { effort: "high" } }],
		["gpt-6.1-terra", Effort.Low, { reasoning: { effort: "low" } }],
		["gpt-5.6-luna", Effort.High, { reasoning: { effort: "high" } }],
		["gpt-5-6-terra", Effort.XHigh, { reasoning: { effort: "xhigh" } }],
		["gpt-5.6-sol", false, { reasoning: { effort: "none" } }],
		["gpt-5.6-sol", undefined, undefined],
		["gpt-5.5", Effort.High, undefined],
		["deepseek-3.2", Effort.High, undefined],
	] as Array<
		[string, Effort | boolean | undefined, KiroAdditionalModelRequestFields | undefined]
	>)("%s with reasoning %p", (id, reasoning, expected) => {
		expect(buildKiroAdditionalModelRequestFields(kiroModel(id), reasoning)).toEqual(expected);
	});
});

describe("Kiro native reasoning stream lifecycle (OAuth)", () => {
	test("reasoning -> text -> reasoning opens a new thinking block and closes each once", async () => {
		const events: Array<{ type: string; index?: number }> = [];
		(globalThis.fetch as any) = async () =>
			eventStreamResponse([
				{ type: "reasoningContentEvent", payload: { text: "A", signature: "sigA" } },
				{ type: "assistantResponseEvent", payload: { content: "answer" } },
				{ type: "reasoningContentEvent", payload: { text: "B", signature: "sigB" } },
			]);
		let message: AssistantMessage | undefined;
		for await (const event of streamKiroCodeWhisperer(
			kiroModel("claude-opus-4.6"),
			{ messages: [{ role: "user", content: "Test", timestamp: 1 }] },
			{ apiKey: JSON.stringify({ token: "social-access-token", profileArn: PROFILE_ARN }), reasoning: Effort.High },
		)) {
			if (event.type.startsWith("thinking_")) events.push({ type: event.type, index: (event as any).contentIndex });
			if (event.type === "done") message = event.message;
		}
		const thinking = message?.content.filter(b => b.type === "thinking") as any[];
		expect(thinking.map(b => [b.thinking, b.thinkingSignature])).toEqual([
			["A", "kiro:signature:sigA"],
			["B", "kiro:signature:sigB"],
		]);
		const starts = events.filter(e => e.type === "thinking_start").map(e => e.index);
		const ends = events.filter(e => e.type === "thinking_end").map(e => e.index);
		expect(starts).toHaveLength(2);
		expect(ends).toEqual(starts);
	});
});

async function runApiKey(
	model: Model<"kiro-codewhisperer-stream">,
	context: Context,
	responseFrames: Record<string, unknown>[],
	reasoning?: Effort | boolean,
): Promise<{ request: any; message: AssistantMessage }> {
	let request: any;
	(globalThis.fetch as any) = async (_input: string | URL | Request, init?: RequestInit) => {
		request = JSON.parse(String(init?.body));
		return new Response(responseFrames.map(f => JSON.stringify(f)).join(""), { status: 200 });
	};
	let message: AssistantMessage | undefined;
	for await (const event of streamKiroApiKey(model, context, {
		apiKey: "ksk_test-secret",
		region: "us-east-1",
		reasoning,
	})) {
		if (event.type === "done" || event.type === "error") message = (event as any).message ?? (event as any).error;
	}
	if (!request || !message) throw new Error("API-key stream produced no request or message");
	return { request, message };
}

describe("Kiro native reasoning (API key transport)", () => {
	test("sends native fields without the prompt prefix", async () => {
		const { request } = await runApiKey(
			kiroModel("claude-opus-4.6"),
			{ systemPrompt: ["sys"], messages: [{ role: "user", content: "Test", timestamp: 1 }] },
			[{ content: "ok" }],
			Effort.High,
		);
		expect(request.additionalModelRequestFields).toEqual({
			thinking: { type: "adaptive", display: "summarized" },
			output_config: { effort: "high" },
		});
		expect(JSON.stringify(request)).not.toContain("<thinking_mode>");
	});

	test("'none' on Claude sends neither native fields nor the prompt prefix", async () => {
		const { request } = await runApiKey(
			kiroModel("claude-opus-4.6"),
			{ systemPrompt: ["sys"], messages: [{ role: "user", content: "Test", timestamp: 1 }] },
			[{ content: "ok" }],
			"none" as unknown as Effort,
		);
		expect(request.additionalModelRequestFields).toBeUndefined();
		expect(JSON.stringify(request)).not.toContain("<thinking_mode>");
	});

	test("explicit off on GPT sends effort none", async () => {
		const { request } = await runApiKey(
			kiroModel("gpt-5.6-sol"),
			{ messages: [{ role: "user", content: "Test", timestamp: 1 }] },
			[{ content: "ok" }],
			false,
		);
		expect(request.additionalModelRequestFields).toEqual({ reasoning: { effort: "none" } });
	});

	test("parses reasoning frames and replays the raw signature on the next turn", async () => {
		const model = kiroModel("claude-opus-4.6");
		const { message: first } = await runApiKey(
			model,
			{ messages: [{ role: "user", content: "Q1", timestamp: 1 }] },
			[{ text: "thinking", signature: "sigK" }, { content: "result" }],
			Effort.High,
		);
		const thinking = first.content.find(b => b.type === "thinking") as any;
		expect(thinking?.thinking).toBe("thinking");
		expect(thinking?.thinkingSignature).toBe("kiro:signature:sigK");

		const { request } = await runApiKey(
			model,
			{
				messages: [
					{ role: "user", content: "Q1", timestamp: 1 },
					first,
					{ role: "user", content: "Q2", timestamp: 2 },
				],
			},
			[{ content: "ok" }],
			Effort.High,
		);
		const assistant = request.conversationState.history.find((h: any) => h.assistantResponseMessage);
		expect(assistant.assistantResponseMessage.reasoningContent).toEqual({ signature: "sigK" });
	});
});

describe("Kiro reasoning replay decoding (OAuth)", () => {
	const turn = (signatures: Array<string | undefined>): AssistantMessage =>
		({
			role: "assistant",
			content: [
				...signatures.map(sig => ({ type: "thinking", thinking: "t", thinkingSignature: sig })),
				{ type: "text", text: "r" },
			],
			api: "kiro-codewhisperer-stream",
			provider: "kiro",
			model: "claude-opus-4.6",
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
		}) as unknown as AssistantMessage;

	async function replayed(signatures: Array<string | undefined>): Promise<unknown> {
		let request: any;
		(globalThis.fetch as any) = async (_input: string | URL | Request, init?: RequestInit) => {
			request = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array));
			return eventStreamResponse([{ type: "assistantResponseEvent", payload: { content: "ok" } }]);
		};
		for await (const _ of streamKiroCodeWhisperer(
			kiroModel("claude-opus-4.6"),
			{
				messages: [
					{ role: "user", content: "Q1", timestamp: 1 },
					turn(signatures),
					{ role: "user", content: "Q2", timestamp: 2 },
				],
			},
			{ apiKey: JSON.stringify({ token: "social-access-token", profileArn: PROFILE_ARN }), reasoning: Effort.High },
		)) {
		}
		return request.conversationState.history.find((h: any) => h.assistantResponseMessage).assistantResponseMessage
			.reasoningContent;
	}

	test.each([
		[["kiro:redactedContent:blob"], { redactedContent: "blob" }],
		[["kiro:signature:"], undefined],
		[["kiro:unknown:x"], undefined],
		[["anthropic-native-signature"], undefined],
		[["kiro:signature:first", "kiro:signature:last"], { signature: "last" }],
		[["kiro:signature:keep", "kiro:unknown:x"], { signature: "keep" }],
	] as const)("%p replays %p", async (signatures, expected) => {
		expect(await replayed([...signatures])).toEqual(expected);
	});
});

function chunkedResponse(chunks: string[]): Response {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		}),
		{ status: 200 },
	);
}

async function collectApiKey(chunks: string[]): Promise<{ types: string[]; message: AssistantMessage }> {
	(globalThis.fetch as any) = async () => chunkedResponse(chunks);
	const types: string[] = [];
	let message: AssistantMessage | undefined;
	for await (const event of streamKiroApiKey(
		kiroModel("claude-opus-4.6"),
		{ messages: [{ role: "user", content: "Test", timestamp: 1 }] },
		{ apiKey: "ksk_test-secret", region: "us-east-1", reasoning: Effort.High },
	)) {
		types.push(event.type);
		if (event.type === "done") message = event.message;
		if (event.type === "error") message = event.error;
	}
	if (!message) throw new Error("no terminal event");
	return { types, message };
}

describe("Kiro native reasoning quarantine (API key transport)", () => {
	test("a refusal in a later read discards native reasoning already received", async () => {
		const { types, message } = await collectApiKey([
			JSON.stringify({ text: "withheld", signature: "sig" }),
			JSON.stringify({
				stopReason: "CONTENT_FILTERED",
				stopDetails: { refusal: { category: "CYBER", explanation: "refused" } },
			}),
		]);
		expect(types.filter(t => t.startsWith("thinking_"))).toEqual([]);
		expect(message.content).toEqual([]);
	});

	test("reasoning after successful completion is fenced out", async () => {
		const { message } = await collectApiKey([
			JSON.stringify({ text: "early", signature: "early-sig" }) + JSON.stringify({ content: "answer" }),
			JSON.stringify({ stopReason: "COMPLETED" }),
			JSON.stringify({ text: "late", signature: "late-sig" }),
		]);
		const thinking = message.content.filter(b => b.type === "thinking") as any[];
		expect(thinking.map(b => [b.thinking, b.thinkingSignature])).toEqual([["early", "kiro:signature:early-sig"]]);
	});

	test("inline and native reasoning merge into one signed thinking block ahead of text", async () => {
		const { message } = await collectApiKey([
			JSON.stringify({ content: "<thinking>I</thinking>A" }),
			JSON.stringify({ text: "N", redactedContent: "blob" }),
		]);
		expect(message.content.map(b => b.type)).toEqual(["thinking", "text"]);
		const thinking = message.content[0] as any;
		expect(thinking.thinking).toBe("IN");
		expect(thinking.thinkingSignature).toBe("kiro:redactedContent:blob");
	});
});

describe("Kiro native reasoning boundaries (OAuth)", () => {
	test("pending inline text is flushed before a native reasoning block opens", async () => {
		const { message } = await runStream(
			[
				{ type: "assistantResponseEvent", payload: { content: "literal <think" } },
				{ type: "reasoningContentEvent", payload: { text: "N" } },
			],
			kiroModel("claude-opus-4.6"),
			{ reasoning: Effort.High },
		);
		expect(message.content.map(b => [b.type, (b as any).text ?? (b as any).thinking])).toEqual([
			["text", "literal <think"],
			["thinking", "N"],
		]);
	});

	test("an open inline <thinking> region survives an interleaved native reasoning block", async () => {
		const { streamEvents, message } = await runStream(
			[
				{ type: "assistantResponseEvent", payload: { content: "<thinking>I" } },
				{ type: "reasoningContentEvent", payload: { text: "N" } },
				{ type: "assistantResponseEvent", payload: { content: "J</thinking>A" } },
			],
			kiroModel("claude-opus-4.6"),
			{ reasoning: Effort.High },
		);
		expect(message.content.map(b => [b.type, (b as any).text ?? (b as any).thinking])).toEqual([
			["thinking", "I"],
			["thinking", "N"],
			["thinking", "J"],
			["text", "A"],
		]);
		const lifecycle = streamEvents
			.filter(e => e.type.endsWith("_start") || e.type.endsWith("_end"))
			.filter(e => e.type !== "start")
			.map(e => `${e.type}:${(e as any).contentIndex}`);
		expect(lifecycle).toEqual([
			"thinking_start:0",
			"thinking_end:0",
			"thinking_start:1",
			"thinking_end:1",
			"thinking_start:2",
			"thinking_end:2",
			"text_start:3",
		]);
	});

	test("a closing tag split around a native reasoning event still ends the inline region", async () => {
		const { message } = await runStream(
			[
				{ type: "assistantResponseEvent", payload: { content: "<thinking>I</thin" } },
				{ type: "reasoningContentEvent", payload: { text: "N" } },
				{ type: "assistantResponseEvent", payload: { content: "king>A" } },
			],
			kiroModel("claude-opus-4.6"),
			{ reasoning: Effort.High },
		);
		expect(message.content.map(b => [b.type, (b as any).text ?? (b as any).thinking])).toEqual([
			["thinking", "I"],
			["thinking", "N"],
			["text", "A"],
		]);
	});
});

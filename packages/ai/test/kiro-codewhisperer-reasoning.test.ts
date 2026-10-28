import { afterEach, describe, expect, test, vi } from "bun:test";
import { Effort } from "../src/model-thinking";
import { crc32 } from "../src/providers/aws-eventstream";
import { streamKiroCodeWhisperer } from "../src/providers/kiro-codewhisperer";
import type { AssistantMessage, Context, Model } from "../src/types";

const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/social-profile";
const claudeModel = {
	id: "claude-opus-4-6",
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
} satisfies Model<"kiro-codewhisperer-stream">;

const gptModel = {
	id: "gpt-4o-reasoning",
	name: "GPT-4o with Reasoning",
	api: "kiro-codewhisperer-stream",
	provider: "kiro",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	output: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
} satisfies Model<"kiro-codewhisperer-stream">;

afterEach(() => {
	vi.restoreAllMocks();
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

function encodeAssistantContentFrame(content: string): Uint8Array {
	const headers = [
		encodeStringHeader(":message-type", "event"),
		encodeStringHeader(":event-type", "assistantResponseEvent"),
		encodeStringHeader(":content-type", "application/json"),
	];
	const headerLength = headers.reduce((total, header) => total + header.length, 0);
	const payload = new TextEncoder().encode(JSON.stringify({ content }));
	const frameLength = 4 + 4 + 4 + headerLength + payload.length + 4;
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
	frame.set(payload, offset);
	view.setUint32(frameLength - 4, crc32(frame.subarray(0, frameLength - 4)), false);
	return frame;
}

function eventStreamResponse(contents: readonly string[]): Response {
	const frames = contents.map(encodeAssistantContentFrame);
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
	contents: readonly string[],
	options: { reasoning?: Effort | boolean; model?: Model<"kiro-codewhisperer-stream"> } = {},
): Promise<{ request: Record<string, unknown>; message: AssistantMessage; eventTypes: string[] }> {
	let request: Record<string, unknown> | undefined;
	const mockFetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		if (!(init?.body instanceof Uint8Array)) throw new Error("expected encoded Kiro request body");
		request = JSON.parse(new TextDecoder().decode(init.body)) as Record<string, unknown>;
		return eventStreamResponse(contents);
	};
	vi.spyOn(globalThis, "fetch").mockImplementation(mockFetch as unknown as typeof globalThis.fetch);
	let message: AssistantMessage | undefined;
	const eventTypes: string[] = [];
	const model = options.model ?? claudeModel;
	const { model: _, ...opts } = options;
	for await (const event of streamKiroCodeWhisperer(
		model,
		{ messages: [{ role: "user", content: "Summarize this", timestamp: 1 }] } satisfies Context,
		{ apiKey: JSON.stringify({ token: "social-access-token", profileArn: PROFILE_ARN }), ...opts },
	)) {
		eventTypes.push(event.type);
		if (event.type === "done") message = event.message;
	}
	if (!request || !message) throw new Error("Kiro stream did not produce a request and final message");
	return { request, message, eventTypes };
}

describe("Kiro OAuth reasoning", () => {
	test("forwards reasoning effort and separates inline thinking from answer text across chunks", async () => {
		const { request, message, eventTypes } = await runStream(
			["Answer ", "<think", "ing>private ", "thought</thinking> visible"],
			{ reasoning: Effort.High },
		);
		const conversationState = request.conversationState as {
			profileArn?: string;
			currentMessage: { userInputMessage: { content: string } };
		};

		expect(conversationState.profileArn).toBe(PROFILE_ARN);
		expect(conversationState.currentMessage.userInputMessage.content).toBe(
			"<thinking_mode>enabled</thinking_mode><max_thinking_length>30000</max_thinking_length>\n\nSummarize this",
		);
		expect(message.content).toEqual([
			{ type: "text", text: "Answer " },
			{ type: "thinking", thinking: "private thought" },
			{ type: "text", text: " visible" },
		]);
		expect(eventTypes).toContain("thinking_start");
		expect(eventTypes).toContain("thinking_delta");
		expect(eventTypes).toContain("thinking_end");
		expect(
			message.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map(block => block.text)
				.join(""),
		).toBe("Answer  visible");
	});

	test("keeps unclosed thinking private and preserves a partial opening marker as text", async () => {
		const unclosed = await runStream(["before<thinking>private unfinished"]);
		expect(unclosed.message.content).toEqual([
			{ type: "text", text: "before" },
			{ type: "thinking", thinking: "private unfinished" },
		]);
		expect(
			unclosed.request.conversationState as { currentMessage: { userInputMessage: { content: string } } },
		).toMatchObject({ currentMessage: { userInputMessage: { content: "Summarize this" } } });

		const partialMarker = await runStream(["literal <think"]);
		expect(partialMarker.message.content).toEqual([{ type: "text", text: "literal <think" }]);
	});

	test("sends native thinking config for Claude models", async () => {
		const { request } = await runStream(["Answer"], { reasoning: Effort.High });
		const additionalFields = request.additionalModelRequestFields as {
			thinking?: { type: string; display: string };
		};

		// Claude models should use additionalModelRequestFields.thinking
		expect(additionalFields.thinking).toEqual({ type: "adaptive", display: "summarized" });
	});

	test("sends thinking config for Claude models with any explicit effort", async () => {
		const effortTests: Array<[Effort | boolean, boolean]> = [
			[Effort.Minimal, true],
			[Effort.Low, true],
			[Effort.Medium, true],
			[Effort.High, true],
			[Effort.XHigh, true],
			[Effort.Max, true],
			[true, true],
			[false, false], // explicit false: no thinking config
		];

		for (const [effort, shouldHaveThinking] of effortTests) {
			const { request } = await runStream(["Answer"], { reasoning: effort });
			const additionalFields = request.additionalModelRequestFields as {
				thinking?: { type: string; display: string };
			};

			if (shouldHaveThinking) {
				expect(additionalFields.thinking).toEqual({ type: "adaptive", display: "summarized" });
			} else {
				expect(additionalFields?.thinking).toBeUndefined();
			}
		}
	});

	test("sends native reasoning effort for GPT models", async () => {
		const { request } = await runStream(["Answer"], { reasoning: Effort.High, model: gptModel });
		const additionalFields = request.additionalModelRequestFields as {
			reasoning?: { effort?: string };
		};

		// GPT models should use additionalModelRequestFields.reasoning.effort
		expect(additionalFields.reasoning).toEqual({ effort: "high" });
	});

	test("maps reasoning efforts correctly for GPT models and disables with effort: none", async () => {
		const effortTests: Array<[Effort | boolean, string | undefined]> = [
			[Effort.Minimal, "low"],
			[Effort.Low, "low"],
			[Effort.Medium, "medium"],
			[Effort.High, "high"],
			[Effort.XHigh, "high"],
			[Effort.Max, "high"],
			[true, undefined], // true: no explicit effort
			[false, "none"], // false: explicitly disable with effort: "none"
		];

		for (const [effort, expected] of effortTests) {
			const { request } = await runStream(["Answer"], { reasoning: effort, model: gptModel });
			const additionalFields = request.additionalModelRequestFields as {
				reasoning?: { effort?: string };
			};

			if (expected) {
				expect(additionalFields.reasoning?.effort).toBe(expected);
			} else {
				expect(additionalFields?.reasoning).toBeUndefined();
			}
		}
	});

	test("builds request with additionalModelRequestFields for thinking and reasoning", async () => {
		// Test that the request is properly built with additionalModelRequestFields
		const claudeRequest = await runStream(["Answer"], { reasoning: Effort.High });
		expect(claudeRequest.request.additionalModelRequestFields).toBeDefined();
		expect(claudeRequest.request.additionalModelRequestFields).toEqual({
			thinking: { type: "adaptive", display: "summarized" },
		});

		const gptRequest = await runStream(["Answer"], { reasoning: Effort.High, model: gptModel });
		expect(gptRequest.request.additionalModelRequestFields).toBeDefined();
		expect(gptRequest.request.additionalModelRequestFields).toEqual({
			reasoning: { effort: "high" },
		});

		// Test that effort: "none" is sent for GPT when reasoning is explicitly false
		const gptDisabledRequest = await runStream(["Answer"], { reasoning: false, model: gptModel });
		expect(gptDisabledRequest.request.additionalModelRequestFields).toEqual({
			reasoning: { effort: "none" },
		});
	});
});

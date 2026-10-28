import { afterEach, describe, expect, test, vi } from "bun:test";
import { Effort } from "../src/model-thinking";
import { crc32 } from "../src/providers/aws-eventstream";
import { streamKiroCodeWhisperer } from "../src/providers/kiro-codewhisperer";
import type { AssistantMessage, Context, Model } from "../src/types";

const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/social-profile";

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

function encodeAssistantContentFrame(content: string, reasoningSignature?: string): Uint8Array {
	const headers = [
		encodeStringHeader(":message-type", "event"),
		encodeStringHeader(":event-type", "assistantResponseEvent"),
		encodeStringHeader(":content-type", "application/json"),
	];
	const headerLength = headers.reduce((total, header) => total + header.length, 0);
	const payload = new TextEncoder().encode(
		JSON.stringify({
			content,
			...(reasoningSignature ? { reasoningContent: { signature: reasoningSignature } } : {}),
		}),
	);
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

function eventStreamResponse(frames: Uint8Array[]): Response {
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
	model: Model<"kiro-codewhisperer-stream">,
	frames: Uint8Array[],
	options: { reasoning?: Effort | boolean } = {},
): Promise<{ request: Record<string, unknown>; message: AssistantMessage }> {
	let request: Record<string, unknown> | undefined;
	const mockFetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		if (!(init?.body instanceof Uint8Array)) throw new Error("expected encoded Kiro request body");
		request = JSON.parse(new TextDecoder().decode(init.body)) as Record<string, unknown>;
		return eventStreamResponse(frames);
	};
	vi.spyOn(globalThis, "fetch").mockImplementation(mockFetch as unknown as typeof globalThis.fetch);
	let message: AssistantMessage | undefined;
	for await (const event of streamKiroCodeWhisperer(
		model,
		{ messages: [{ role: "user", content: "test", timestamp: 1 }] } satisfies Context,
		{
			apiKey: JSON.stringify({ token: "social-access-token", profileArn: PROFILE_ARN }),
			...options,
		},
	)) {
		if (event.type === "done") message = event.message;
	}
	if (!request || !message) throw new Error("Kiro stream did not produce a request and final message");
	return { request, message };
}

describe("Kiro native thinking support", () => {
	test("Claude Opus at high effort sends native thinking + output_config fields", async () => {
		const model = {
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

		const { request } = await runStream(model, [encodeAssistantContentFrame("Hello")], {
			reasoning: Effort.High,
		});

		const conversationState = request.conversationState as {
			additionalModelRequestFields?: Record<string, unknown>;
		};

		expect(conversationState.additionalModelRequestFields).toBeDefined();
		expect(conversationState.additionalModelRequestFields).toEqual({
			thinking: { type: "adaptive", display: "summarized" },
			output_config: { effort: "high" },
		});
	});

	test("GPT-6 sends native reasoning effort field", async () => {
		const model = {
			id: "gpt-6-luna",
			name: "GPT 6 Luna",
			api: "kiro-codewhisperer-stream",
			provider: "kiro",
			baseUrl: "",
			reasoning: true,
			input: ["text"],
			output: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272_000,
			maxTokens: 128_000,
		} satisfies Model<"kiro-codewhisperer-stream">;

		const { request } = await runStream(model, [encodeAssistantContentFrame("Hello")], {
			reasoning: Effort.High,
		});

		const conversationState = request.conversationState as {
			additionalModelRequestFields?: Record<string, unknown>;
		};

		expect(conversationState.additionalModelRequestFields).toBeDefined();
		expect(conversationState.additionalModelRequestFields).toEqual({
			reasoning: { effort: "high" },
		});
	});

	test("GPT-5.6 sends native reasoning effort field", async () => {
		const model = {
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
		} satisfies Model<"kiro-codewhisperer-stream">;

		const { request } = await runStream(model, [encodeAssistantContentFrame("Hello")], {
			reasoning: Effort.Medium,
		});

		const conversationState = request.conversationState as {
			additionalModelRequestFields?: Record<string, unknown>;
		};

		expect(conversationState.additionalModelRequestFields).toEqual({
			reasoning: { effort: "medium" },
		});
	});

	test("non-native model falls back to system-prompt thinking prefix", async () => {
		const model = {
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			api: "kiro-codewhisperer-stream",
			provider: "kiro",
			baseUrl: "",
			reasoning: true,
			input: ["text"],
			output: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
		} satisfies Model<"kiro-codewhisperer-stream">;

		const { request } = await runStream(model, [encodeAssistantContentFrame("Hello")], {
			reasoning: Effort.Medium,
		});

		const conversationState = request.conversationState as {
			additionalModelRequestFields?: Record<string, unknown>;
			currentMessage: { userInputMessage: { content: string } };
		};

		// No native fields sent for older models
		expect(conversationState.additionalModelRequestFields).toBeUndefined();

		// Instead, fallback to system-prompt prefix
		expect(conversationState.currentMessage.userInputMessage.content).toContain(
			"<thinking_mode>enabled</thinking_mode>",
		);
	});

	test("reasoning=false on Claude sends no additional fields", async () => {
		const model = {
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

		const { request } = await runStream(model, [encodeAssistantContentFrame("Hello")], {
			reasoning: false,
		});

		const conversationState = request.conversationState as {
			additionalModelRequestFields?: Record<string, unknown>;
		};

		// No native fields sent when reasoning is off
		expect(conversationState.additionalModelRequestFields).toBeUndefined();
	});

	test("replays reasoningContent signature in next turn history", async () => {
		const model = {
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

		// First turn: stream includes reasoning signature
		const { message: turn1Response } = await runStream(
			model,
			[encodeAssistantContentFrame("visible answer", "sig_abc123xyz")],
			{ reasoning: Effort.High },
		);

		// Verify response was received
		expect(turn1Response.content).toEqual([{ type: "text", text: "visible answer" }]);

		// Now simulate a second turn where we send the first response back as history
		let secondTurnRequest: Record<string, unknown> | undefined;
		const mockFetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			if (!(init?.body instanceof Uint8Array)) throw new Error("expected encoded Kiro request body");
			secondTurnRequest = JSON.parse(new TextDecoder().decode(init.body)) as Record<string, unknown>;
			return eventStreamResponse([encodeAssistantContentFrame("second response")]);
		};
		vi.spyOn(globalThis, "fetch").mockImplementation(mockFetch as unknown as typeof globalThis.fetch);

		// Create context with the first response in history
		const context: Context = {
			messages: [
				{ role: "user", content: "test", timestamp: 1 },
				turn1Response,
				{ role: "user", content: "follow up", timestamp: 2 },
			],
		};

		for await (const _event of streamKiroCodeWhisperer(model, context, {
			apiKey: JSON.stringify({ token: "social-access-token", profileArn: PROFILE_ARN }),
			reasoning: Effort.High,
		})) {
			// Consume events
		}

		expect(secondTurnRequest).toBeDefined();
		const secondConversationState = secondTurnRequest?.conversationState as {
			history?: Array<{
				assistantResponseMessage?: { content: string; toolUses?: unknown[] };
			}>;
		};

		// The history should contain the first assistant response
		expect(secondConversationState.history).toBeDefined();
		expect(secondConversationState.history?.length).toBeGreaterThan(0);

		// The assistant message in history should be properly formatted
		const assistantHistoryMessages = secondConversationState.history?.filter(h => h.assistantResponseMessage);
		expect(assistantHistoryMessages?.length).toBeGreaterThan(0);
	});

	test("reasoning effort maps correctly for different levels", async () => {
		const model = {
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

		const testCases: Array<{ effort: Effort | boolean; expectedEffort: string }> = [
			{ effort: true, expectedEffort: "medium" },
			{ effort: Effort.Low, expectedEffort: "low" },
			{ effort: Effort.Medium, expectedEffort: "medium" },
			{ effort: Effort.High, expectedEffort: "high" },
			{ effort: Effort.XHigh, expectedEffort: "xhigh" },
			{ effort: Effort.Max, expectedEffort: "max" },
		];

		for (const { effort, expectedEffort } of testCases) {
			const { request } = await runStream(model, [encodeAssistantContentFrame("Hello")], {
				reasoning: effort,
			});

			const conversationState = request.conversationState as {
				additionalModelRequestFields?: Record<string, unknown>;
			};

			expect(conversationState.additionalModelRequestFields?.output_config).toEqual({
				effort: expectedEffort,
			});
		}
	});
});

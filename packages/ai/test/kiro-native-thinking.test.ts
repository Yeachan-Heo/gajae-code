import { afterEach, describe, expect, test, vi } from "bun:test";
import { Effort, enrichModelThinking } from "../src/model-thinking";
import { crc32 } from "../src/providers/aws-eventstream";
import { streamKiroApiKey } from "../src/providers/kiro-api-key";
import { streamKiroCodeWhisperer } from "../src/providers/kiro-codewhisperer";
import type { AssistantMessage, Context, Model } from "../src/types";

// Issue #7405: Kiro forwards `additionalModelRequestFields` to Claude 4.6+ and GPT 5.6+.
// Both auth transports (social-login CodeWhisperer and ksk_ API key) must send the same
// native fields, stream `reasoningContent`, and replay its signature on the next turn.

const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/social-profile";
const PREFIX_MARKER = "<thinking_mode>enabled</thinking_mode>";

afterEach(() => {
	vi.restoreAllMocks();
});

function kiroModel(id: string): Model<"kiro-codewhisperer-stream"> {
	return enrichModelThinking({
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
	} satisfies Model<"kiro-codewhisperer-stream">);
}

type ReasoningFrame = { text?: string; signature?: string; redactedContent?: string };
type Frame = { content?: string; reasoningContent?: ReasoningFrame };

function encodeStringHeader(name: string, value: string): Uint8Array {
	const nameBytes = new TextEncoder().encode(name);
	const valueBytes = new TextEncoder().encode(value);
	const header = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
	const view = new DataView(header.buffer);
	header.set([nameBytes.length], 0);
	header.set(nameBytes, 1);
	view.setUint8(1 + nameBytes.length, 7);
	view.setUint16(2 + nameBytes.length, valueBytes.length, false);
	header.set(valueBytes, 4 + nameBytes.length);
	return header;
}

function encodeEventStreamFrame(frame: Frame): Uint8Array {
	const headers = [
		encodeStringHeader(":message-type", "event"),
		encodeStringHeader(":event-type", "assistantResponseEvent"),
		encodeStringHeader(":content-type", "application/json"),
	];
	const headerLength = headers.reduce((total, header) => total + header.length, 0);
	const payload = new TextEncoder().encode(JSON.stringify(frame));
	const frameLength = 12 + headerLength + payload.length + 4;
	const bytes = new Uint8Array(frameLength);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, frameLength, false);
	view.setUint32(4, headerLength, false);
	view.setUint32(8, crc32(bytes.subarray(0, 8)), false);
	let offset = 12;
	for (const header of headers) {
		bytes.set(header, offset);
		offset += header.length;
	}
	bytes.set(payload, offset);
	view.setUint32(frameLength - 4, crc32(bytes.subarray(0, frameLength - 4)), false);
	return bytes;
}

type Transport = "codewhisperer" | "apiKey";
const TRANSPORTS: Transport[] = ["codewhisperer", "apiKey"];

function mockResponse(transport: Transport, frames: readonly Frame[]): Response {
	if (transport === "apiKey") {
		return new Response(frames.map(frame => JSON.stringify(frame)).join(""), { status: 200 });
	}
	const encoded = frames.map(encodeEventStreamFrame);
	const body = new Uint8Array(encoded.reduce((total, frame) => total + frame.length, 0));
	let offset = 0;
	for (const frame of encoded) {
		body.set(frame, offset);
		offset += frame.length;
	}
	return new Response(body, { status: 200, headers: { "Content-Type": "application/vnd.amazon.eventstream" } });
}

interface Run {
	conversationState: {
		additionalModelRequestFields?: Record<string, unknown>;
		currentMessage: { userInputMessage: { content: string } };
		history?: Array<{ assistantResponseMessage?: { content: string; reasoningContent?: Record<string, unknown> } }>;
	};
	message: AssistantMessage;
	eventTypes: string[];
}

async function run(
	transport: Transport,
	model: Model<"kiro-codewhisperer-stream">,
	options: { reasoning?: Effort | boolean; messages?: Context["messages"]; frames?: readonly Frame[] } = {},
): Promise<Run> {
	let request: Run["conversationState"] | undefined;
	const frames = options.frames ?? [{ content: "Hello" }];
	vi.spyOn(globalThis, "fetch").mockImplementation((async (_input: unknown, init?: RequestInit) => {
		const raw = init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init?.body);
		request = (JSON.parse(raw) as { conversationState: Run["conversationState"] }).conversationState;
		return mockResponse(transport, frames);
	}) as unknown as typeof globalThis.fetch);
	const context: Context = { messages: options.messages ?? [{ role: "user", content: "test", timestamp: 1 }] };
	const stream =
		transport === "apiKey"
			? streamKiroApiKey(model, context, {
					apiKey: "ksk_test-secret",
					region: "us-east-1",
					reasoning: options.reasoning,
				})
			: streamKiroCodeWhisperer(model, context, {
					apiKey: JSON.stringify({ token: "social-access-token", profileArn: PROFILE_ARN }),
					reasoning: options.reasoning,
				});
	let message: AssistantMessage | undefined;
	const eventTypes: string[] = [];
	for await (const event of stream) {
		eventTypes.push(event.type);
		if (event.type === "done") message = event.message;
		if (event.type === "error") throw new Error(event.error.errorMessage);
	}
	if (!request || !message) throw new Error(`${transport} stream did not produce a request and final message`);
	return { conversationState: request, message, eventTypes };
}

function promptText(state: Run["conversationState"]): string {
	return JSON.stringify(state);
}

describe.each(TRANSPORTS)("Kiro native thinking (%s transport)", transport => {
	test("Opus 4.7 at high effort sends adaptive summarized thinking and no prompt prefix", async () => {
		const { conversationState } = await run(transport, kiroModel("claude-opus-4-7"), { reasoning: Effort.High });
		expect(conversationState.additionalModelRequestFields).toEqual({
			thinking: { type: "adaptive", display: "summarized" },
			output_config: { effort: "high" },
		});
		expect(promptText(conversationState)).not.toContain(PREFIX_MARKER);
	});

	test("Sonnet 4.6 sends adaptive thinking without the display field it rejects", async () => {
		const { conversationState } = await run(transport, kiroModel("claude-sonnet-4.6"), { reasoning: Effort.Low });
		expect(conversationState.additionalModelRequestFields).toEqual({
			thinking: { type: "adaptive" },
			output_config: { effort: "low" },
		});
	});

	test("GPT 5.10 sends reasoning.effort (numeric, not lexicographic, version gate)", async () => {
		const { conversationState } = await run(transport, kiroModel("gpt-5.10-terra"), { reasoning: Effort.High });
		expect(conversationState.additionalModelRequestFields).toEqual({ reasoning: { effort: "high" } });
		expect(promptText(conversationState)).not.toContain(PREFIX_MARKER);
	});

	test("GPT 5.6 with reasoning off sends effort none", async () => {
		const { conversationState } = await run(transport, kiroModel("gpt-5-6-terra"));
		expect(conversationState.additionalModelRequestFields).toEqual({ reasoning: { effort: "none" } });
	});

	test("models without a native field keep the prompt-prefix fallback", async () => {
		const { conversationState } = await run(transport, kiroModel("claude-sonnet-4.5"), { reasoning: Effort.High });
		expect(conversationState.additionalModelRequestFields).toBeUndefined();
		expect(promptText(conversationState)).toContain(PREFIX_MARKER);
	});

	test("streams reasoningContent.text as a thinking block and keeps redacted payloads out of it", async () => {
		const { message, eventTypes } = await run(transport, kiroModel("claude-opus-4-7"), {
			reasoning: Effort.High,
			frames: [
				{ reasoningContent: { text: "step one, " } },
				{ reasoningContent: { text: "step two", signature: "sig-abc" } },
				{ reasoningContent: { redactedContent: "b3BhcXVl" } },
				{ content: "Answer" },
			],
		});
		// toMatchObject: the ksk_ transport leaves its internal `index` on final blocks (pre-existing).
		expect(message.content).toMatchObject([
			{ type: "thinking", thinking: "step one, step two", thinkingSignature: "sig-abc" },
			{ type: "text", text: "Answer" },
		]);
		expect(eventTypes).toContain("thinking_start");
		expect(eventTypes).toContain("thinking_end");
		expect(JSON.stringify(message)).not.toContain("b3BhcXVl");
	});

	test("replays the turn-N reasoning signature as reasoningContent.signature on turn N+1", async () => {
		const first = await run(transport, kiroModel("claude-opus-4-7"), {
			reasoning: Effort.High,
			frames: [{ reasoningContent: { text: "plan", signature: "sig-turn-1" } }, { content: "Done" }],
		});
		const { conversationState } = await run(transport, kiroModel("claude-opus-4-7"), {
			reasoning: Effort.High,
			messages: [
				{ role: "user", content: "first", timestamp: 1 },
				first.message,
				{ role: "user", content: "second", timestamp: 2 },
			],
		});
		const replayed = conversationState.history?.find(
			entry => entry.assistantResponseMessage,
		)?.assistantResponseMessage;
		expect(replayed?.reasoningContent).toEqual({ signature: "sig-turn-1" });
		expect(replayed?.content).toContain("Done");
	});
});

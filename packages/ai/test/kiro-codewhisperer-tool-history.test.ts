/**
 * Issue #6079: the OAuth CodeWhisperer transport must replay tool calls as
 * structured `toolUses` and link each tool result to the toolUseId it answers.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { streamKiroCodeWhisperer } from "../src/providers/kiro-codewhisperer";
import type { AssistantMessage, Context, Model } from "../src/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const model = {
	id: "test-model",
	name: "Test",
	api: "kiro-codewhisperer-stream" as const,
	provider: "kiro" as const,
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	output: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
} satisfies Model<"kiro-codewhisperer-stream">;

function assistantWithToolCalls(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "Reading both files." },
			{ type: "toolCall", id: "tool-a", name: "read", arguments: { path: "a.ts" } },
			{ type: "toolCall", id: "tool-b", name: "read", arguments: { path: "b.png" } },
		],
		api: "kiro-codewhisperer-stream",
		provider: "kiro",
		model: "test-model",
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
}

async function captureRequestBody(context: Context): Promise<any> {
	let body: string | undefined;
	globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		body = new TextDecoder().decode(init?.body as Uint8Array);
		return new Response("error", { status: 500 });
	}) as unknown as typeof fetch;
	try {
		for await (const _event of streamKiroCodeWhisperer(model, context, { apiKey: "token", region: "us-east-1" })) {
			break;
		}
	} catch {
		// The mocked 500 ends the stream; only the request body matters here.
	}
	if (!body) throw new Error("request was not sent");
	return JSON.parse(body);
}

describe("Kiro CodeWhisperer tool history #6079", () => {
	test("replays tool calls as structured toolUses and links results by toolUseId", async () => {
		const request = await captureRequestBody({
			messages: [
				{ role: "user", content: "compare a and b", timestamp: 1 },
				assistantWithToolCalls(),
				{
					role: "toolResult",
					toolCallId: "tool-a",
					toolName: "read",
					content: [{ type: "text", text: "export const a = 1;" }],
					isError: false,
					timestamp: 3,
				},
				{
					role: "toolResult",
					toolCallId: "tool-b",
					toolName: "read",
					content: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
					isError: true,
					timestamp: 4,
				},
				{ role: "user", content: "now summarize", timestamp: 5 },
			],
		});

		const history = request.conversationState.history;
		expect(history).toHaveLength(3);

		const assistant = history[1].assistantResponseMessage;
		expect(assistant.content).toBe("Reading both files.");
		expect(assistant.content).not.toContain("tool-a");
		expect(assistant.toolUses).toEqual([
			{ toolUseId: "tool-a", name: "read", input: { path: "a.ts" } },
			{ toolUseId: "tool-b", name: "read", input: { path: "b.png" } },
		]);

		// Both parallel results answer the same assistant turn in one user entry.
		const results = history[2].userInputMessage;
		expect(results.content).toBe("Tool results provided.");
		expect(results.userInputMessageContext.toolResults).toEqual([
			{ toolUseId: "tool-a", status: "success", content: [{ text: "export const a = 1;" }] },
			{ toolUseId: "tool-b", status: "error", content: [{ text: "[image omitted]" }] },
		]);

		const declared = new Set(assistant.toolUses.map((use: { toolUseId: string }) => use.toolUseId));
		for (const result of results.userInputMessageContext.toolResults) {
			expect(declared.has(result.toolUseId)).toBe(true);
		}
	});

	test("sends a trailing tool result as the current message's toolResults", async () => {
		const request = await captureRequestBody({
			messages: [
				{ role: "user", content: "read a", timestamp: 1 },
				assistantWithToolCalls(),
				{
					role: "toolResult",
					toolCallId: "tool-a",
					toolName: "read",
					content: [{ type: "text", text: "export const a = 1;" }],
					isError: false,
					timestamp: 3,
				},
			],
		});

		const current = request.conversationState.currentMessage.userInputMessage;
		expect(current.userInputMessageContext.toolResults).toEqual([
			{ toolUseId: "tool-a", status: "success", content: [{ text: "export const a = 1;" }] },
		]);
		expect(request.conversationState.history[1].assistantResponseMessage.toolUses).toHaveLength(2);
	});
});

/**
 * Request-body contracts verified against the live Kiro service:
 * - `userInputMessage.origin` must be set, or the service ignores `modelId` and
 *   answers every request with `auto`.
 * - The trailing results of a parallel tool batch must all travel in
 *   `currentMessage`; leaving earlier ones as a history entry is rejected with
 *   HTTP 400 `TOOL_USE_RESULT_MISMATCH`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { streamKiroCodeWhisperer } from "../src/providers/kiro-codewhisperer";
import type { AssistantMessage, Context, Model, ToolResultMessage } from "../src/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const model = {
	id: "claude-opus-5-5",
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

function assistantCalling(...ids: string[]): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map(id => ({ type: "toolCall" as const, id, name: "read", arguments: { path: `${id}.ts` } })),
		api: "kiro-codewhisperer-stream",
		provider: "kiro",
		model: model.id,
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

function result(id: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text: `body of ${id}` }],
		isError: false,
		timestamp: 3,
	};
}

async function captureRequestBody(context: Context): Promise<any> {
	let body: string | undefined;
	globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		body = new TextDecoder().decode(init?.body as Uint8Array);
		return new Response("error", { status: 500 });
	}) as unknown as typeof fetch;
	for await (const _event of streamKiroCodeWhisperer(model, context, { apiKey: "token", region: "us-east-1" })) {
		// The mocked 500 ends the stream; only the request body matters here.
	}
	if (!body) throw new Error("request was not sent");
	return JSON.parse(body);
}

type WireEntry = { userInputMessage?: { origin?: string; modelId?: string } };

describe("Kiro CodeWhisperer request body", () => {
	test("sets origin on every user message so modelId is honored", async () => {
		const request = await captureRequestBody({
			messages: [
				{ role: "user", content: "read a", timestamp: 1 },
				assistantCalling("tool-a"),
				result("tool-a"),
				{ role: "user", content: "now summarize", timestamp: 4 },
			],
		});
		const userEntries = [...request.conversationState.history, request.conversationState.currentMessage].filter(
			(entry: WireEntry) => entry.userInputMessage,
		);
		expect(userEntries).toHaveLength(3);
		for (const entry of userEntries as WireEntry[]) {
			expect(entry.userInputMessage?.origin).toBe("AI_EDITOR");
			expect(entry.userInputMessage?.modelId).toBe("claude-opus-5.5");
		}
	});

	test("sends every trailing parallel tool result in currentMessage", async () => {
		const request = await captureRequestBody({
			messages: [
				{ role: "user", content: "read three files", timestamp: 1 },
				assistantCalling("tool-a", "tool-b", "tool-c"),
				result("tool-a"),
				result("tool-b"),
				result("tool-c"),
			],
		});
		const { history, currentMessage } = request.conversationState;
		// user prompt + assistant tool calls; no separate history entry for tool-a/tool-b.
		expect(history).toHaveLength(2);
		expect(history[1].assistantResponseMessage.toolUses.map((use: { toolUseId: string }) => use.toolUseId)).toEqual([
			"tool-a",
			"tool-b",
			"tool-c",
		]);
		expect(
			currentMessage.userInputMessage.userInputMessageContext.toolResults.map(
				(r: { toolUseId: string }) => r.toolUseId,
			),
		).toEqual(["tool-a", "tool-b", "tool-c"]);
	});

	test("keeps an earlier completed parallel batch grouped in history", async () => {
		const request = await captureRequestBody({
			messages: [
				{ role: "user", content: "read", timestamp: 1 },
				assistantCalling("tool-a", "tool-b"),
				result("tool-a"),
				result("tool-b"),
				assistantCalling("tool-c"),
				result("tool-c"),
			],
		});
		const { history, currentMessage } = request.conversationState;
		expect(history).toHaveLength(4);
		expect(
			history[2].userInputMessage.userInputMessageContext.toolResults.map((r: { toolUseId: string }) => r.toolUseId),
		).toEqual(["tool-a", "tool-b"]);
		expect(
			currentMessage.userInputMessage.userInputMessageContext.toolResults.map(
				(r: { toolUseId: string }) => r.toolUseId,
			),
		).toEqual(["tool-c"]);
	});
});

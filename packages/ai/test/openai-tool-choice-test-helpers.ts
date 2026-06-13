import { expect } from "bun:test";
import type { Api, AssistantMessageEvent, Context, Model, Tool } from "../src/types";

export const testTool: Tool = {
	name: "search",
	description: "Search for information",
	parameters: {
		type: "object",
		properties: {
			query: { type: "string" },
		},
		required: ["query"],
	},
};

export const testContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
	tools: [testTool],
};

export function createBaseModel<TApi extends Api>(api: TApi): Model<TApi> {
	return {
		id: `${api}-test-model`,
		name: `${api} test model`,
		api,
		provider: "custom",
		baseUrl: "https://proxy.example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	} as Model<TApi>;
}

export function createSseResponse(events: unknown[]): Response {
	const payload = `${events
		.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
		.join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

export function createErrorResponse(message: string, status = 400): Response {
	return new Response(JSON.stringify({ error: { message } }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

export async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

export function expectSingleCleanFallbackEvents(events: AssistantMessageEvent[]): void {
	expect(events.filter(event => event.type === "start")).toHaveLength(1);
	expect(events.filter(event => event.type === "done" || event.type === "error")).toHaveLength(1);
	expect(events.filter(event => event.type === "toolChoiceIncapability")).toHaveLength(1);
	const fallbackIndex = events.findIndex(event => event.type === "toolChoiceIncapability");
	expect(fallbackIndex).toBeGreaterThanOrEqual(0);
	expect(
		events
			.slice(0, fallbackIndex)
			.some(event => event.type === "text_start" || event.type === "text_delta" || event.type === "toolcall_start"),
	).toBe(false);
}

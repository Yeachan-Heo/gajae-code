import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentEvent } from "@gajae-code/agent-core";
import type { AssistantMessage, ToolCall } from "@gajae-code/ai";
import {
	getStreamingEditToolCallForEvent,
	type StreamingEditParsedCacheEntry,
} from "@gajae-code/coding-agent/session/agent-session";

function eventFor(argumentsValue: unknown): AgentEvent {
	const toolCall: ToolCall = {
		type: "toolCall",
		id: "call-edit",
		name: "edit",
		arguments: argumentsValue as ToolCall["arguments"],
	};
	const message: AssistantMessage = {
		role: "assistant",
		content: [toolCall],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	return {
		type: "message_update",
		message,
		assistantMessageEvent: {
			type: "toolcall_delta",
			contentIndex: 0,
			delta: String(argumentsValue),
			partial: message,
		},
	};
}

describe("AgentSession streaming edit parsed-state cache", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});
	it("parses one unique tool-call args version once across pre-cache and abort consumers", () => {
		const cache = new Map<string, StreamingEditParsedCacheEntry>();
		const args = JSON.stringify({ path: "file.ts", diff: "-old\n+new\n", op: "update" });
		const event = eventFor(args);
		const parseSpy = vi.spyOn(JSON, "parse");
		const resolvePath = vi.fn((filePath: string) => `/repo/${filePath}`);

		const precacheParsed = getStreamingEditToolCallForEvent(event, cache, resolvePath);
		const abortParsed = getStreamingEditToolCallForEvent(event, cache, resolvePath);

		expect(precacheParsed?.diff).toBe("-old\n+new\n");
		expect(abortParsed).toBe(precacheParsed);
		expect(parseSpy).toHaveBeenCalledTimes(1);
		expect(resolvePath).toHaveBeenCalledTimes(1);
	});

	it("does not cache invalid partial JSON across a later valid args version", () => {
		const cache = new Map<string, StreamingEditParsedCacheEntry>();
		const parseSpy = vi.spyOn(JSON, "parse");
		const resolvePath = vi.fn((filePath: string) => `/repo/${filePath}`);

		const invalid = getStreamingEditToolCallForEvent(eventFor('{"path":"file.ts","diff":"-old'), cache, resolvePath);
		const valid = getStreamingEditToolCallForEvent(
			eventFor(JSON.stringify({ path: "file.ts", diff: "-old\n+new\n", op: "update" })),
			cache,
			resolvePath,
		);

		expect(invalid).toBeUndefined();
		expect(valid?.path).toBe("file.ts");
		expect(valid?.diff).toBe("-old\n+new\n");
		expect(parseSpy).toHaveBeenCalledTimes(2);
		expect(resolvePath).toHaveBeenCalledTimes(1);
	});
});

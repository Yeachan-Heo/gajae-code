import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
	mapAgentSessionEventToAcpSessionUpdates,
	mapAgentWireEventPayloadToAcpSessionUpdates,
} from "../../src/modes/acp/acp-event-mapper";
import { AGENT_WIRE_EVENT_TYPES } from "../../src/modes/shared/agent-wire/event-contract";
import { toAgentWireEventPayload } from "../../src/modes/shared/agent-wire/event-envelope";
import type { AgentSessionEvent } from "../../src/session/agent-session";
import { EVENT_FIXTURES } from "../agent-wire/fixtures";

const SESSION_ID = "sess";
const WHITELISTED_EMPTY_EVENT_TYPES = [
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"auto_retry_start",
	"auto_retry_end",
	"retry_fallback_applied",
	"retry_fallback_succeeded",
	"ttsr_triggered",
	"irc_message",
	"notice",
	"thinking_level_changed",
	"goal_updated",
] as const;

function makeAssistantMessage(id: string, text: string) {
	return {
		id,
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "claude-sonnet-4-20250514",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 1,
	};
}

function makeParityOptions() {
	const progressByMessage = new WeakMap<object, { textEmitted: boolean; thoughtEmitted: boolean }>();
	return {
		cwd: "/tmp/acp-redteam",
		getMessageId: (message: unknown) =>
			typeof message === "object" && message !== null && "id" in message && typeof message.id === "string"
				? message.id
				: undefined,
		getMessageProgress: (message: unknown) => {
			if (typeof message !== "object" || message === null) return undefined;
			const existing = progressByMessage.get(message);
			if (existing) return existing;
			const progress = { textEmitted: false, thoughtEmitted: false };
			progressByMessage.set(message, progress);
			return progress;
		},
		getToolArgs: (toolCallId: string) =>
			toolCallId === "t1" ? { command: "echo canonical fallback args" } : undefined,
	};
}

function textChunks(updates: ReturnType<typeof mapAgentSessionEventToAcpSessionUpdates>): string[] {
	return updates.flatMap(notification => {
		const update = notification.update as { sessionUpdate?: string; content?: { type?: string; text?: string } };
		return update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text"
			? [update.content.text ?? ""]
			: [];
	});
}

describe("ACP canonical payload red-team", () => {
	it("keeps canonical wire payload mapping identical to direct session-event mapping for every registered event type", () => {
		expect(Object.keys(EVENT_FIXTURES).sort()).toEqual([...AGENT_WIRE_EVENT_TYPES].sort());

		for (const type of AGENT_WIRE_EVENT_TYPES) {
			const fixture = EVENT_FIXTURES[type];
			expect(
				mapAgentWireEventPayloadToAcpSessionUpdates(
					toAgentWireEventPayload(fixture),
					SESSION_ID,
					makeParityOptions(),
				),
				type,
			).toEqual(mapAgentSessionEventToAcpSessionUpdates(fixture, SESSION_ID, makeParityOptions()));
		}
	});

	it("returns no ACP notifications for every explicit whitelist event type", () => {
		for (const type of WHITELISTED_EMPTY_EVENT_TYPES) {
			expect(mapAgentSessionEventToAcpSessionUpdates(EVENT_FIXTURES[type], SESSION_ID), type).toEqual([]);
			expect(
				mapAgentWireEventPayloadToAcpSessionUpdates(toAgentWireEventPayload(EVENT_FIXTURES[type]), SESSION_ID),
				type,
			).toEqual([]);
		}
	});

	it("preserves tool lifecycle ordering and stable toolCallId from start through update to end", () => {
		const events = [
			EVENT_FIXTURES.tool_execution_start,
			EVENT_FIXTURES.tool_execution_update,
			EVENT_FIXTURES.tool_execution_end,
		] as AgentSessionEvent[];
		const updates = events.flatMap(event => mapAgentSessionEventToAcpSessionUpdates(event, SESSION_ID));

		expect(updates).toHaveLength(3);
		expect(updates.map(notification => (notification.update as { sessionUpdate?: string }).sessionUpdate)).toEqual([
			"tool_call",
			"tool_call_update",
			"tool_call_update",
		]);
		expect(updates.map(notification => (notification.update as { toolCallId?: string }).toolCallId)).toEqual([
			"t1",
			"t1",
			"t1",
		]);
		expect((updates[1]!.update as { status?: string }).status).toBe("in_progress");
		expect((updates[2]!.update as { status?: string }).status).toBe("completed");
	});

	it("does not emit duplicate final assistant text after a realistic streamed assistant message", () => {
		const message = makeAssistantMessage("m-no-dupe", "final assistant answer");
		const progress = { textEmitted: false, thoughtEmitted: false };
		const options = {
			getMessageId: (candidate: unknown) => (candidate === message ? "m-no-dupe" : undefined),
			getMessageProgress: (candidate: unknown) => (candidate === message ? progress : undefined),
		};

		const streamed = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "message_update",
				message,
				assistantMessageEvent: { type: "text_delta", delta: "final assistant answer" },
			} as unknown as AgentSessionEvent,
			SESSION_ID,
			options,
		);
		const ended = mapAgentSessionEventToAcpSessionUpdates(
			{ type: "message_end", message } as AgentSessionEvent,
			SESSION_ID,
			options,
		);
		const chunks = textChunks([...streamed, ...ended]);

		expect(streamed).toHaveLength(1);
		expect(ended).toEqual([]);
		expect(chunks).toEqual(["final assistant answer"]);
	});

	it("does not import dispatchRpcCommand from the ACP agent or event mapper", () => {
		const sourcePaths = [
			path.join(import.meta.dir, "../../src/modes/acp/acp-agent.ts"),
			path.join(import.meta.dir, "../../src/modes/acp/acp-event-mapper.ts"),
		];

		for (const sourcePath of sourcePaths) {
			const source = readFileSync(sourcePath, "utf8");
			expect(source.match(/import[^;]*dispatchRpcCommand/s), sourcePath).toBeNull();
		}
	});
});

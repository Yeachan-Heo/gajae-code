import { describe, expect, it } from "bun:test";
import path from "node:path";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import acpProtocolSchema from "@agentclientprotocol/sdk/schema/schema.json" with { type: "json" };
import { fromJSONSchema } from "zod/v4";
import type * as z from "zod/v4/core";
import {
	buildToolCallStartUpdate,
	mapAgentSessionEventToAcpSessionUpdates,
	mapAgentWireEventPayloadToAcpSessionUpdates,
	normalizeReplayToolArguments,
} from "../src/modes/acp/acp-event-mapper";
import { toAgentWireEventPayload } from "../src/modes/shared/agent-wire/event-envelope";
import type { AgentSessionEvent } from "../src/session/agent-session";
import { expectAcpStructure, expectAcpStructureRejects } from "./helpers/acp-schema";

const zSessionNotification = fromJSONSchema({
	$schema: acpProtocolSchema.$schema,
	$ref: "#/$defs/SessionNotification",
	$defs: acpProtocolSchema.$defs,
} as unknown as z.JSONSchema.JSONSchema);

function makeAssistantMessage(text: string) {
	return {
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
		timestamp: Date.now(),
	};
}

function getChunkMessageId(event: { update: object }): string | undefined {
	const update = event.update as { messageId?: string | null };
	return typeof update.messageId === "string" ? update.messageId : undefined;
}

function expectAcpNotifications(updates: SessionNotification[]): void {
	for (const update of updates) {
		expectAcpStructure(zSessionNotification, update);
	}
}

describe("ACP event mapper", () => {
	it("attaches a stable messageId to live assistant chunks", () => {
		const assistantMessage = makeAssistantMessage("chunk");
		const getMessageId = (message: unknown): string | undefined =>
			message === assistantMessage ? "a80f1ff7-4f0a-4e6b-9f09-c94857b62a4a" : undefined;

		const textUpdates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "message_update",
				message: assistantMessage,
				assistantMessageEvent: { type: "text_delta", delta: "chunk" },
			} as AgentSessionEvent,
			"session-1",
			{ getMessageId },
		);
		const thoughtUpdates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "message_update",
				message: assistantMessage,
				assistantMessageEvent: { type: "thinking_delta", delta: "plan" },
			} as AgentSessionEvent,
			"session-1",
			{ getMessageId },
		);

		expect(textUpdates).toHaveLength(1);
		expect(thoughtUpdates).toHaveLength(1);
		expectAcpNotifications([...textUpdates, ...thoughtUpdates]);
		expect(textUpdates[0] ? getChunkMessageId(textUpdates[0]) : undefined).toBe(
			"a80f1ff7-4f0a-4e6b-9f09-c94857b62a4a",
		);
		expect(thoughtUpdates[0] ? getChunkMessageId(thoughtUpdates[0]) : undefined).toBe(
			"a80f1ff7-4f0a-4e6b-9f09-c94857b62a4a",
		);
	});

	it("maps canonical wire payloads the same as direct events", () => {
		const assistantMessage = makeAssistantMessage("wire chunk");
		const messageEvent = {
			type: "message_update",
			message: assistantMessage,
			assistantMessageEvent: { type: "text_delta", delta: "wire chunk" },
		} as AgentSessionEvent;
		const toolStartEvent = {
			type: "tool_execution_start",
			toolCallId: "toolu_wire_1",
			toolName: "bash",
			args: { command: "bun test" },
		} as AgentSessionEvent;

		expect(mapAgentWireEventPayloadToAcpSessionUpdates(toAgentWireEventPayload(toolStartEvent), "session-1")).toEqual(
			mapAgentSessionEventToAcpSessionUpdates(toolStartEvent, "session-1"),
		);
		expect(mapAgentWireEventPayloadToAcpSessionUpdates(toAgentWireEventPayload(messageEvent), "session-1")).toEqual(
			mapAgentSessionEventToAcpSessionUpdates(messageEvent, "session-1"),
		);
	});

	it("returns no ACP updates for whitelisted unrepresented events", () => {
		expect(
			mapAgentSessionEventToAcpSessionUpdates({ type: "agent_start" } as AgentSessionEvent, "session-1"),
		).toEqual([]);
		expect(
			mapAgentSessionEventToAcpSessionUpdates(
				{ type: "notice", level: "info", message: "visible elsewhere" } as AgentSessionEvent,
				"session-1",
			),
		).toEqual([]);
	});

	it("maps model fallback switches to one ACP session notice", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "model_fallback_switched",
				eventId: "fallback-1",
				from: "anthropic/claude-sonnet",
				to: "openai/gpt-5",
				reason: "rate_limit",
				role: "default",
				scope: "session",
				activeIndex: 1,
				chainLength: 2,
				attemptsUsed: 3,
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		expect(updates[0]!.update).toEqual({
			sessionUpdate: "session_info_update",
			_meta: {
				gjcModelFallbackSwitched: true,
				gjcModelFallbackEventId: "fallback-1",
				gjcModelFallbackFrom: "anthropic/claude-sonnet",
				gjcModelFallbackTo: "openai/gpt-5",
				gjcModelFallbackReason: "rate_limit",
				gjcModelFallbackRole: "default",
				gjcModelFallbackScope: "session",
				gjcModelFallbackActiveIndex: 1,
				gjcModelFallbackChainLength: 2,
				gjcModelFallbackAttemptsUsed: 3,
			},
		});
	});

	it("maps automatic compaction lifecycle events to ACP session metadata", () => {
		const start = mapAgentSessionEventToAcpSessionUpdates(
			{ type: "auto_compaction_start", reason: "threshold", action: "context-full" } as AgentSessionEvent,
			"session-1",
		);
		const end = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "auto_compaction_end",
				action: "context-full",
				result: undefined,
				aborted: false,
				willRetry: true,
				skipped: true,
				errorMessage: "retrying after maintenance",
				continuationSkipReason: "auto_continue_disabled_non_resumable_tail",
			} as AgentSessionEvent,
			"session-1",
		);

		expect(start).toEqual([
			{
				sessionId: "session-1",
				update: {
					sessionUpdate: "session_info_update",
					_meta: {
						gjcPhase: "compacting",
						gjcCompactionState: "start",
						gjcCompactionTrigger: "threshold",
						gjcCompactionAction: "context-full",
						running: true,
						gjcRunning: true,
					},
				},
			},
		]);
		expect(end).toEqual([
			{
				sessionId: "session-1",
				update: {
					sessionUpdate: "session_info_update",
					_meta: {
						gjcPhase: "responding",
						gjcCompactionState: "end",
						gjcCompactionAction: "context-full",
						gjcCompactionAborted: false,
						gjcCompactionWillRetry: true,
						gjcCompactionSkipped: true,
						gjcCompactionErrorMessage: "retrying after maintenance",
						gjcCompactionContinuationSkipReason: "auto_continue_disabled_non_resumable_tail",
						running: true,
						gjcRunning: true,
					},
				},
			},
		]);
		expectAcpNotifications([...start, ...end]);
	});

	it("returns idle metadata when compaction finishes outside a prompt", () => {
		const [notification] = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "auto_compaction_end",
				action: "handoff",
				result: undefined,
				aborted: true,
				willRetry: false,
			} as AgentSessionEvent,
			"session-1",
			{ compactionEndPhase: "idle" },
		);

		expect(notification?.update._meta).toMatchObject({
			gjcPhase: "idle",
			gjcCompactionState: "end",
			gjcCompactionAction: "handoff",
			gjcCompactionAborted: true,
			running: false,
			gjcRunning: false,
		});
		expectAcpNotifications(notification ? [notification] : []);
	});

	it("emits final assistant text when no text deltas were observed", () => {
		const assistantMessage = makeAssistantMessage("final response");
		const progress = { textEmitted: false, thoughtEmitted: false };

		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "message_end",
				message: assistantMessage,
			} as AgentSessionEvent,
			"session-1",
			{ getMessageProgress: message => (message === assistantMessage ? progress : undefined) },
		);

		expect(updates).toEqual([
			{
				sessionId: "session-1",
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "final response" },
					messageId: undefined,
				},
			},
		]);
		expectAcpNotifications(updates);
		expect(progress.textEmitted).toBe(true);
	});

	it("does not duplicate final assistant text after streaming deltas", () => {
		const assistantMessage = makeAssistantMessage("streamed response");
		const progress = { textEmitted: false, thoughtEmitted: false };
		const options = {
			getMessageProgress: (message: unknown) => (message === assistantMessage ? progress : undefined),
		};

		const deltaUpdates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "message_update",
				message: assistantMessage,
				assistantMessageEvent: { type: "text_delta", delta: "streamed response" },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const doneUpdates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "message_end",
				message: assistantMessage,
			} as AgentSessionEvent,
			"session-1",
			options,
		);

		expect(deltaUpdates).toHaveLength(1);
		expectAcpNotifications(deltaUpdates);
		expect(doneUpdates).toEqual([]);
	});

	it("emits a diff ToolCallContent for each per-file edit result", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-1",
				toolName: "edit",
				isError: false,
				result: {
					content: [{ type: "text", text: "applied" }],
					details: {
						diff: "--- a/foo\n+++ b/foo\n",
						perFileResults: [
							{ path: "foo.ts", diff: "...", oldText: "before\n", newText: "after\n" },
							{ path: "bar.ts", diff: "...", oldText: undefined, newText: "created\n" },
							{ path: "skipped.ts", diff: "", isError: true, errorText: "boom" },
						],
					},
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; path?: string; oldText?: string | null; newText?: string }>;
			locations?: { path: string }[];
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		const diffBlocks = update.content?.filter(block => block.type === "diff") ?? [];
		expect(diffBlocks).toEqual([
			{ type: "diff", path: "foo.ts", oldText: "before\n", newText: "after\n" },
			{ type: "diff", path: "bar.ts", oldText: null, newText: "created\n" },
		]);
		expect(update.locations).toEqual([{ path: "foo.ts" }, { path: "bar.ts" }, { path: "skipped.ts" }]);
	});

	it("emits a diff ToolCallContent for single-file edit details", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-single",
				toolName: "edit",
				isError: false,
				result: {
					content: [{ type: "text", text: "applied" }],
					details: {
						path: "single.ts",
						diff: "--- a/single.ts\n+++ b/single.ts\n",
						oldText: "before\n",
						newText: "after\n",
					},
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; path?: string; oldText?: string | null; newText?: string }>;
			locations?: { path: string }[];
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.content?.filter(block => block.type === "diff")).toEqual([
			{ type: "diff", path: "single.ts", oldText: "before\n", newText: "after\n" },
		]);
		expect(update.locations).toEqual([{ path: "single.ts" }]);
	});

	it("emits locations on tool_execution_update from args", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-2",
				toolName: "edit",
				args: { path: "src/foo.ts" },
				partialResult: { content: [{ type: "text", text: "in progress" }] },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as { sessionUpdate: string; locations?: { path: string }[] };
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.locations).toEqual([{ path: "src/foo.ts" }]);
	});

	it("preserves command text when a command tool update replaces content", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-3",
				toolName: "bash",
				args: { command: "npm run check" },
				partialResult: { details: { terminalId: "term-1" } },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; terminalId?: string; content?: { type: string; text?: string } }>;
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.content).toContainEqual({ type: "content", content: { type: "text", text: "$ npm run check" } });
		expect(update.content).toContainEqual({ type: "terminal", terminalId: "term-1" });
		expect(update.content).not.toContainEqual({
			type: "content",
			content: { type: "text", text: '{"details":{"terminalId":"term-1"}}' },
		});
	});

	it("preserves command text when tool update details accompany empty content", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-terminal-empty-content",
				toolName: "bash",
				args: { command: "echo hi" },
				partialResult: { content: [], details: { terminalId: "term-1" } },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; terminalId?: string; content?: { type: string; text?: string } }>;
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.content).toContainEqual({ type: "content", content: { type: "text", text: "$ echo hi" } });
		expect(update.content).toContainEqual({ type: "terminal", terminalId: "term-1" });
		expect(update.content).not.toContainEqual({
			type: "content",
			content: { type: "text", text: '{"content":[],"details":{"terminalId":"term-1"}}' },
		});
	});

	it("keeps terminal content alongside readable text", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-terminal-update-text",
				toolName: "bash",
				args: { command: "echo hi" },
				partialResult: {
					content: [{ type: "text", text: "running" }],
					details: { terminalId: "term-1" },
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; terminalId?: string; content?: { type: string; text?: string } }>;
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.content).toContainEqual({ type: "content", content: { type: "text", text: "running" } });
		expect(update.content).toContainEqual({ type: "terminal", terminalId: "term-1" });
	});

	it("keeps terminal content alongside readable end text", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-end",
				toolName: "bash",
				isError: false,
				result: {
					content: [{ type: "text", text: "done" }],
					details: { terminalId: "term-1" },
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; terminalId?: string; content?: { type: string; text?: string } }>;
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.content).toContainEqual({ type: "content", content: { type: "text", text: "done" } });
		expect(update.content).toContainEqual({ type: "terminal", terminalId: "term-1" });
	});

	it("preserves command text when a command tool final update replaces content", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-final-command",
				toolName: "bash",
				isError: false,
				result: {
					content: [{ type: "text", text: "done" }],
					details: { terminalId: "term-1" },
				},
			} as AgentSessionEvent,
			"session-1",
			{
				getToolArgs: toolCallId =>
					toolCallId === "tc-terminal-final-command" ? { command: "npm run check" } : undefined,
			},
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; terminalId?: string; content?: { type: string; text?: string } }>;
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.content).toContainEqual({ type: "content", content: { type: "text", text: "$ npm run check" } });
		expect(update.content).toContainEqual({ type: "content", content: { type: "text", text: "done" } });
		expect(update.content).toContainEqual({ type: "terminal", terminalId: "term-1" });
	});

	it("keeps terminal content alongside readable error and message fields", () => {
		const errorUpdates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-error",
				toolName: "bash",
				isError: true,
				result: { errorMessage: "command failed", details: { terminalId: "term-1" } },
			} as AgentSessionEvent,
			"session-1",
		);
		const messageUpdates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-message",
				toolName: "bash",
				isError: false,
				result: { message: "command completed", details: { terminalId: "term-1" } },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(errorUpdates).toHaveLength(1);
		expect(messageUpdates).toHaveLength(1);
		expectAcpNotifications([...errorUpdates, ...messageUpdates]);
		const errorUpdate = errorUpdates[0]!.update as {
			content?: Array<{ type: string; terminalId?: string; content?: { type: string; text?: string } }>;
		};
		const messageUpdate = messageUpdates[0]!.update as {
			content?: Array<{ type: string; terminalId?: string; content?: { type: string; text?: string } }>;
		};

		expect(errorUpdate.content).toContainEqual({ type: "terminal", terminalId: "term-1" });
		expect(errorUpdate.content).toContainEqual({
			type: "content",
			content: { type: "text", text: "command failed" },
		});
		expect(messageUpdate.content).toContainEqual({ type: "terminal", terminalId: "term-1" });
		expect(messageUpdate.content).toContainEqual({
			type: "content",
			content: { type: "text", text: "command completed" },
		});
	});

	it("keeps plain command output visible without terminal details", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-plain-output",
				toolName: "bash",
				isError: false,
				result: "hello from stdout",
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			content?: Array<{ type: string; content?: { type: string; text?: string } }>;
		};

		expect(update.content).toEqual([{ type: "content", content: { type: "text", text: "hello from stdout" } }]);
	});

	it("embeds only terminal content from direct terminalId", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-direct-terminal",
				toolName: "bash",
				isError: false,
				result: { terminalId: "term-1" },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			content?: Array<{ type: string; terminalId?: string }>;
		};
		expect(update.content).toEqual([{ type: "terminal", terminalId: "term-1" }]);
	});

	it("does not duplicate existing terminal content", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-dedup",
				toolName: "bash",
				isError: false,
				result: {
					content: [{ type: "terminal", terminalId: "term-1" }],
					details: { terminalId: "term-1" },
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			content?: Array<{ type: string; terminalId?: string }>;
		};
		expect(update.content?.filter(item => item.type === "terminal" && item.terminalId === "term-1")).toHaveLength(1);
	});
	it("shows bash commands in visible tool call content", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "toolu_bash_1",
				toolName: "bash",
				args: { command: "npm run check", cwd: "/repo" },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			toolCallId?: string;
			title?: string;
			kind?: string;
			status?: string;
			rawInput?: unknown;
			content?: unknown;
		};
		expect(update.sessionUpdate).toBe("tool_call");
		expect(update.toolCallId).toBe("toolu_bash_1");
		expect(update.title).toBe("bash: npm run check");
		expect(update.kind).toBe("execute");
		expect(update.status).toBe("pending");
		expect(update.rawInput).toEqual({ command: "npm run check", cwd: "/repo" });
		expect(update.content).toEqual([{ type: "content", content: { type: "text", text: "$ npm run check" } }]);
	});

	it("maps shell and exec tool starts as execute", () => {
		for (const toolName of ["shell", "exec"] as const) {
			const updates = mapAgentSessionEventToAcpSessionUpdates(
				{
					type: "tool_execution_start",
					toolCallId: `toolu_${toolName}_1`,
					toolName,
					args: { command: "echo hi" },
				} as AgentSessionEvent,
				"session-1",
			);

			expect(updates).toHaveLength(1);
			expectAcpNotifications(updates);
			const update = updates[0]!.update as {
				sessionUpdate: string;
				kind?: string;
				content?: unknown;
			};
			expect(update.sessionUpdate).toBe("tool_call");
			expect(update.kind).toBe("execute");
			expect(update.content).toEqual([{ type: "content", content: { type: "text", text: "$ echo hi" } }]);
		}
	});

	it("builds replayed bash tool calls from JSON string arguments", () => {
		const replayArgs = normalizeReplayToolArguments(JSON.stringify({ command: "npm test", cwd: "/repo" }));
		const update = buildToolCallStartUpdate({
			toolCallId: "toolu_replay_1",
			toolName: "bash",
			args: replayArgs.args,
			status: "completed",
		});

		expectAcpStructure(zSessionNotification, { sessionId: "session-1", update });
		expect(update).toMatchObject({
			sessionUpdate: "tool_call",
			toolCallId: "toolu_replay_1",
			title: "bash: npm test",
			kind: "execute",
			status: "completed",
			rawInput: { command: "npm test", cwd: "/repo" },
			content: [{ type: "content", content: { type: "text", text: "$ npm test" } }],
		});
	});

	it("builds replayed read tool-call locations against the replay cwd", () => {
		const replayArgs = normalizeReplayToolArguments(JSON.stringify({ path: "src/foo.ts" }));
		const update = buildToolCallStartUpdate({
			toolCallId: "toolu_replay_read",
			toolName: "read",
			args: replayArgs.args,
			cwd: path.resolve("/repo"),
			status: "completed",
		});

		expectAcpStructure(zSessionNotification, { sessionId: "session-1", update });
		expect(update).toMatchObject({
			sessionUpdate: "tool_call",
			toolCallId: "toolu_replay_read",
			title: "read: src/foo.ts",
			kind: "read",
			status: "completed",
			rawInput: { path: "src/foo.ts" },
			locations: [{ path: path.resolve("/repo", "src/foo.ts") }],
		});
		expect("content" in update).toBe(false);
	});

	it("keeps malformed replay arguments as raw input without command content", () => {
		const replayArgs = normalizeReplayToolArguments("{not json");
		const update = buildToolCallStartUpdate({
			toolCallId: "toolu_replay_bad",
			toolName: "bash",
			args: replayArgs.args,
			status: "completed",
		});

		expectAcpStructure(zSessionNotification, { sessionId: "session-1", update });
		expect(update).toMatchObject({
			sessionUpdate: "tool_call",
			toolCallId: "toolu_replay_bad",
			title: "bash",
			kind: "execute",
			status: "completed",
			rawInput: "{not json",
		});
		expect("content" in update).toBe(false);
	});

	it("keeps object replay arguments unchanged and builds command content", () => {
		const rawArgs = { command: "bun test", cwd: "/repo" };
		const replayArgs = normalizeReplayToolArguments(rawArgs);
		const update = buildToolCallStartUpdate({
			toolCallId: "toolu_replay_object",
			toolName: "bash",
			args: replayArgs.args,
			status: "completed",
		});

		expect(replayArgs.args).toBe(rawArgs);
		expectAcpStructure(zSessionNotification, { sessionId: "session-1", update });
		expect(update).toMatchObject({
			title: "bash: bun test",
			status: "completed",
			rawInput: rawArgs,
			content: [{ type: "content", content: { type: "text", text: "$ bun test" } }],
		});
	});
	it("does not add command text content to non-command tool starts", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "toolu_read_1",
				toolName: "read",
				args: { path: "README.md" },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			title?: string;
			kind?: string;
			rawInput?: unknown;
			locations?: { path: string }[];
			content?: unknown;
		};
		expect(update.sessionUpdate).toBe("tool_call");
		expect(update.title).toBe("read: README.md");
		expect(update.kind).toBe("read");
		expect(update.rawInput).toEqual({ path: "README.md" });
		expect(update.locations).toEqual([{ path: "README.md" }]);
		expect("content" in update).toBe(false);
	});
	it("resolves tool_execution_start locations against mapper cwd", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "toolu_read_cwd",
				toolName: "read",
				args: { path: "src/file.ts" },
			} as AgentSessionEvent,
			"session-1",
			{ cwd: "/repo" },
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as { sessionUpdate: string; locations?: { path: string }[]; content?: unknown };
		expect(update.sessionUpdate).toBe("tool_call");
		expect(update.locations).toEqual([{ path: path.resolve("/repo", "src/file.ts") }]);
		expect("content" in update).toBe(false);
	});
	it("emits distinct locations for move-style path arguments", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-move",
				toolName: "move",
				args: { path: "src/current.ts", oldPath: "src/old.ts", newPath: "src/new.ts" },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as { sessionUpdate: string; locations?: { path: string }[] };
		expect(update.sessionUpdate).toBe("tool_call");
		expect(update.locations).toEqual([{ path: "src/current.ts" }, { path: "src/old.ts" }, { path: "src/new.ts" }]);
	});

	it("rejects mutated ACP notification discriminators", () => {
		const [notification] = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-schema",
				toolName: "read",
				args: { path: "package.json" },
			} as AgentSessionEvent,
			"session-1",
		);

		expectAcpStructure(zSessionNotification, notification);
		expectAcpStructureRejects(zSessionNotification, {
			...notification,
			update: { ...notification!.update, sessionUpdate: "tool_call_updates" },
		});
		expectAcpStructureRejects(zSessionNotification, { ...notification, sessionId: 42 });
	});
});

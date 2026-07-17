/**
 * One representative `AgentSessionEvent` fixture per registered event type.
 * Fixtures intentionally embed sensitive-looking raw content (assistant text,
 * raw args, raw command output) so redaction can be asserted by tests.
 */

import type { AgentWireEventType } from "../../src/modes/shared/agent-wire/event-contract";
import type { AgentSessionEvent } from "../../src/session/agent-session";

/** A raw secret marker that must NEVER appear in bounded owner evidence. */
export const RAW_SECRET = "RAW_SECRET_MUST_NOT_LEAK";

function ev(value: unknown): AgentSessionEvent {
	return value as AgentSessionEvent;
}

const message = (id: string) => ({
	id,
	role: "assistant",
	content: [{ type: "text", text: RAW_SECRET }],
});

export const EVENT_FIXTURES: Record<AgentWireEventType, AgentSessionEvent> = {
	agent_start: ev({ type: "agent_start" }),
	agent_end: ev({ type: "agent_end", messages: [], stopReason: "completed" }),
	turn_start: ev({ type: "turn_start" }),
	turn_end: ev({ type: "turn_end", message: message("m-turn"), toolResults: [] }),
	message_start: ev({ type: "message_start", message: message("m1") }),
	message_update: ev({
		type: "message_update",
		message: message("m1"),
		assistantMessageEvent: { type: "text_delta", delta: RAW_SECRET },
	}),
	message_end: ev({ type: "message_end", message: message("m1") }),
	tool_execution_start: ev({
		type: "tool_execution_start",
		toolCallId: "t1",
		toolName: "bash",
		args: { command: `echo ${RAW_SECRET}` },
	}),
	tool_execution_update: ev({
		type: "tool_execution_update",
		toolCallId: "t1",
		toolName: "bash",
		args: { command: `echo ${RAW_SECRET}` },
		partialResult: { status: "running", output: RAW_SECRET },
	}),
	tool_execution_end: ev({
		type: "tool_execution_end",
		toolCallId: "t1",
		toolName: "bash",
		result: { status: "completed", output: RAW_SECRET },
		isError: false,
	}),
	auto_compaction_start: ev({ type: "auto_compaction_start", reason: "threshold", action: "context-full" }),
	auto_compaction_end: ev({
		type: "auto_compaction_end",
		action: "context-full",
		result: undefined,
		aborted: false,
		willRetry: false,
	}),
	auto_retry_start: ev({
		type: "auto_retry_start",
		attempt: 1,
		maxAttempts: 3,
		delayMs: 100,
		errorMessage: RAW_SECRET,
	}),
	auto_retry_end: ev({ type: "auto_retry_end", success: true, attempt: 1 }),
	ttsr_triggered: ev({ type: "ttsr_triggered", rules: [{ id: "r1" }, { id: "r2" }] }),
	todo_reminder: ev({ type: "todo_reminder", todos: [], attempt: 1, maxAttempts: 3 }),
	todo_auto_clear: ev({ type: "todo_auto_clear" }),
	irc_message: ev({ type: "irc_message", message: { type: "custom", text: RAW_SECRET } }),
	subagent_steer_message: ev({
		type: "subagent_steer_message",
		message: {
			type: "custom",
			customType: "subagent:steer",
			text: RAW_SECRET,
			details: { observationId: "obs-1", from: "1-Parent", to: "2-Child", body: RAW_SECRET, state: "queued" },
		},
	}),
	notice: ev({ type: "notice", level: "error", message: RAW_SECRET, source: "tool" }),
	model_fallback_switched: ev({
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
	}),
	thinking_level_changed: ev({ type: "thinking_level_changed", thinkingLevel: "high" }),
	goal_updated: ev({ type: "goal_updated", goal: { objective: RAW_SECRET } }),
};

/**
 * Canonical AgentSession event observation: the single semantic mapping from
 * `AgentSessionEvent` (and non-event wire frames) to bounded owner observations.
 *
 * This is the one place that derives `AgentWireOwnerObservation`s. Harness (and
 * any other owner control plane) consumes these instead of re-parsing the wire
 * protocol with private knowledge.
 *
 * Hard rule: evidence is BOUNDED — only ids, names, categories, statuses,
 * cursors, timestamps, and short codes/messages. Never assistant text, message
 * deltas, command output, raw args, or raw tool results.
 */
import type { AgentSessionEvent } from "../../../session/agent-session";
import type { AgentWireEventPayload, AgentWireOwnerObservation } from "./event-contract";
import { toAgentWireEventPayload } from "./event-envelope";

const TEST_RE = /\b(bun test|npm test|yarn test|pnpm test|jest|vitest|pytest|go test|cargo test|mocha|ava)\b/i;
const TOOL_STATUS_CODES = new Set([
	"aborted",
	"blocked",
	"cancelled",
	"complete",
	"completed",
	"error",
	"failed",
	"ok",
	"pending",
	"running",
	"skipped",
	"success",
	"timeout",
]);

/** True when a tool name or command indicates a test-runner invocation. */
export function isTestRunnerTool(toolName?: unknown, command?: unknown): boolean {
	const name = typeof toolName === "string" ? toolName : "";
	const cmd = typeof command === "string" ? command : "";
	if (/test/i.test(name) && name !== "edit" && name !== "read") return true;
	return TEST_RE.test(cmd);
}

function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
	return typeof v === "number" ? v : undefined;
}
/** Only accept a known closed-vocabulary tool status; reject arbitrary strings. */
export function boundedStatus(v: unknown): string | undefined {
	if (typeof v !== "string") return undefined;
	const status = v.trim().toLowerCase();
	return TOOL_STATUS_CODES.has(status) ? status : undefined;
}
/** Accept only identifier-shaped tokens (e.g. RPC command names); reject free text. */
export function boundedToken(v: unknown): string | undefined {
	if (typeof v !== "string") return undefined;
	return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(v) ? v : undefined;
}
function recordObject(v: unknown): Record<string, unknown> | undefined {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function idOf(v: unknown): string | null {
	const record = recordObject(v);
	return str(record?.id) ?? null;
}
/** Extract a bounded tool command for test detection only — never persisted. */
function toolCommand(args: unknown): string | undefined {
	const record = recordObject(args);
	const c = record?.command ?? record?.cmd ?? record?.commandLine;
	return typeof c === "string" ? c : undefined;
}
/** Derive a bounded tool status from a result/partialResult/isError shape. */
function resultStatus(result: unknown, isError?: boolean): string | undefined {
	if (isError === true) return "error";
	const record = recordObject(result);
	if (!record) return undefined;
	if (record.isError === true) return "error";
	return boundedStatus(record.status) ?? boundedStatus(recordObject(record.details)?.status);
}

function obs(
	event: AgentSessionEvent,
	partial: Omit<AgentWireOwnerObservation, "eventType">,
): AgentWireOwnerObservation {
	return { eventType: event.type, ...partial };
}

/**
 * Map a single `AgentSessionEvent` to its bounded owner observation, or null
 * when the event carries no owner-facing signal.
 */
export function observeAgentSessionEvent(event: AgentSessionEvent): AgentWireOwnerObservation | null {
	switch (event.type) {
		case "agent_start":
			return obs(event, {
				kind: "rpc_agent_started",
				signal: "SessionStart",
				evidence: {},
				severity: "info",
				semantic: true,
				coalesceKey: null,
			});
		case "turn_start":
			return obs(event, {
				kind: "rpc_turn_started",
				signal: "prompt-accepted",
				evidence: {},
				severity: "info",
				semantic: true,
				coalesceKey: null,
			});
		case "turn_end":
			return obs(event, {
				kind: "rpc_turn_ended",
				signal: null,
				evidence: {},
				severity: "info",
				semantic: false,
				coalesceKey: null,
			});
		case "message_start":
		case "message_update":
		case "message_end": {
			const messageId = idOf(event.message);
			return obs(event, {
				kind: "rpc_message_activity",
				signal: null,
				evidence: { phase: event.type, messageId },
				severity: "info",
				semantic: false,
				coalesceKey: `message:${messageId ?? "msg"}`,
			});
		}
		case "tool_execution_start": {
			const test = isTestRunnerTool(event.toolName, toolCommand(event.args));
			return obs(event, {
				kind: "rpc_tool_started",
				signal: test ? "test-running" : "tool-call",
				evidence: { toolId: str(event.toolCallId) ?? null, toolName: str(event.toolName) ?? null },
				severity: "info",
				semantic: true,
				coalesceKey: null,
			});
		}
		case "tool_execution_update": {
			const test = isTestRunnerTool(event.toolName, toolCommand(event.args));
			return obs(event, {
				kind: "rpc_tool_updated",
				signal: test ? "test-running" : null,
				evidence: { toolId: str(event.toolCallId) ?? null, status: resultStatus(event.partialResult) ?? null },
				severity: "info",
				semantic: false,
				coalesceKey: `tool:${str(event.toolCallId) ?? "tool"}`,
			});
		}
		case "tool_execution_end": {
			const test = isTestRunnerTool(event.toolName);
			const status = resultStatus(event.result, event.isError);
			return obs(event, {
				kind: "rpc_tool_ended",
				signal: test ? "test-running" : "tool-call",
				evidence: {
					toolId: str(event.toolCallId) ?? null,
					toolName: str(event.toolName) ?? null,
					status: status ?? null,
				},
				severity: status === "error" ? "warn" : "info",
				semantic: true,
				coalesceKey: null,
			});
		}
		case "auto_compaction_start":
		case "auto_compaction_end":
			return obs(event, {
				kind: "rpc_compaction",
				signal: null,
				evidence: { phase: event.type },
				severity: "info",
				semantic: false,
				coalesceKey: null,
			});
		case "auto_retry_start":
			return obs(event, {
				kind: "rpc_retry",
				signal: null,
				evidence: { phase: event.type, attempt: num(event.attempt) ?? null },
				severity: "warn",
				semantic: false,
				coalesceKey: null,
			});
		case "auto_retry_end":
			return obs(event, {
				kind: "rpc_retry",
				signal: null,
				evidence: { phase: event.type, success: event.success === true },
				severity: "warn",
				semantic: false,
				coalesceKey: null,
			});
		case "retry_fallback_applied":
		case "retry_fallback_succeeded":
			return obs(event, {
				kind: "rpc_retry_fallback",
				signal: null,
				evidence: { phase: event.type, role: str(event.role) ?? null },
				severity: "warn",
				semantic: false,
				coalesceKey: null,
			});
		case "ttsr_triggered":
			return obs(event, {
				kind: "rpc_ttsr",
				signal: "error",
				evidence: { ruleCount: Array.isArray(event.rules) ? event.rules.length : 0 },
				severity: "warn",
				semantic: true,
				coalesceKey: null,
			});
		case "todo_reminder":
		case "todo_auto_clear":
			return obs(event, {
				kind: "rpc_todo",
				signal: null,
				evidence: { phase: event.type },
				severity: "info",
				semantic: false,
				coalesceKey: null,
			});
		case "irc_message":
			return obs(event, {
				kind: "rpc_irc",
				signal: null,
				evidence: {},
				severity: "info",
				semantic: false,
				coalesceKey: null,
			});
		case "subagent_steer_message": {
			const details = recordObject(event.message.details);
			return obs(event, {
				kind: "rpc_subagent_steer",
				signal: null,
				evidence: {
					from: str(details?.from) ?? null,
					to: str(details?.to) ?? null,
					state: str(details?.state) ?? null,
					observationId: str(details?.observationId) ?? null,
				},
				severity: "info",
				semantic: false,
				coalesceKey: null,
			});
		}
		case "notice": {
			const level = event.level;
			return obs(event, {
				kind: "rpc_notice",
				signal: level === "error" ? "error" : null,
				evidence: { level },
				severity: level === "info" ? "info" : "warn",
				semantic: level === "error",
				coalesceKey: null,
			});
		}
		case "thinking_level_changed":
			return obs(event, {
				kind: "rpc_thinking",
				signal: null,
				evidence: { thinkingLevel: str(event.thinkingLevel) ?? null },
				severity: "info",
				semantic: false,
				coalesceKey: null,
			});
		case "goal_updated":
			return obs(event, {
				kind: "rpc_goal",
				signal: null,
				evidence: { hasGoal: event.goal != null },
				severity: "info",
				semantic: false,
				coalesceKey: null,
			});
		case "agent_end":
			return obs(event, {
				kind: "rpc_agent_completed",
				signal: "completed",
				evidence: { stopReason: str(event.stopReason) ?? "completed" },
				severity: "info",
				semantic: true,
				coalesceKey: null,
			});
		default:
			return assertNeverEvent(event);
	}
}

function assertNeverEvent(event: never): null {
	void (event as AgentSessionEvent);
	return null;
}

/** Build the rich event payload (renderer-facing) for an `AgentSessionEvent`. */
export { toAgentWireEventPayload };

/** Observe the bounded owner signal carried by a rich event payload. */
export function observeAgentWireEventPayload(payload: AgentWireEventPayload): AgentWireOwnerObservation | null {
	return observeAgentSessionEvent(payload.event);
}

function ownerFrame(
	frameType: string,
	partial: Omit<AgentWireOwnerObservation, "frameType">,
): AgentWireOwnerObservation {
	return { frameType, ...partial };
}

/**
 * Map a single outbound RPC wire frame (docs/rpc.md) to a bounded owner
 * observation, or null when the frame carries no owner-facing signal. Event
 * frames delegate to {@link observeAgentWireEventPayload}; non-event frames are
 * mapped here so owners never re-parse protocol semantics privately.
 */
export function observeRpcOutboundFrame(frame: Record<string, unknown>): AgentWireOwnerObservation | null {
	const type = str(frame.type);
	if (!type || type === "ready") return null;

	switch (type) {
		case "response": {
			if (frame.success === false) {
				const error = recordObject(frame.error);
				return ownerFrame(type, {
					kind: "rpc_response_failed",
					signal: "error",
					evidence: {
						command: boundedToken(frame.command) ?? null,
						id: boundedToken(frame.id) ?? null,
						code: boundedToken(error?.code) ?? null,
					},
					severity: "warn",
					semantic: false,
					coalesceKey: null,
				});
			}
			return null;
		}
		case "event": {
			const payload = recordObject(frame.payload);
			const event = recordObject(payload?.event);
			if (!event) return null;
			return observeAgentSessionEvent(event as unknown as AgentSessionEvent);
		}
		case "workflow_gate":
			return ownerFrame(type, {
				kind: "rpc_workflow_gate",
				signal: null,
				evidence: {
					gate_id: str(frame.gate_id) ?? null,
					kind: str(frame.kind) ?? null,
					stage: str(frame.stage) ?? null,
				},
				severity: "info",
				semantic: true,
				coalesceKey: null,
			});
		case "extension_ui_request":
			return ownerFrame(type, {
				kind: "rpc_extension_request",
				signal: "tool-call",
				evidence: { id: str(frame.id) ?? null, method: str(frame.method) ?? null },
				severity: "info",
				semantic: false,
				coalesceKey: null,
			});
		case "extension_error":
			return ownerFrame(type, {
				kind: "rpc_extension_error",
				signal: "error",
				evidence: {
					extensionPath: str(frame.extensionPath) ?? null,
					event: boundedToken(frame.event) ?? null,
				},
				severity: "critical",
				semantic: true,
				coalesceKey: null,
			});
		case "host_tool_call":
		case "host_tool_cancel":
			return ownerFrame(type, {
				kind: type === "host_tool_cancel" ? "rpc_host_tool_cancel" : "rpc_host_tool_call",
				signal: "tool-call",
				evidence: { id: str(frame.id) ?? null, toolName: str(frame.toolName) ?? null },
				severity: "info",
				semantic: false,
				coalesceKey: null,
			});
		case "host_uri_request":
		case "host_uri_cancel":
			return ownerFrame(type, {
				kind: type === "host_uri_cancel" ? "rpc_host_uri_cancel" : "rpc_host_uri_request",
				signal: "tool-call",
				evidence: {
					id: str(frame.id) ?? null,
					operation: str(frame.operation) ?? null,
					scheme: str(frame.scheme) ?? null,
				},
				severity: "info",
				semantic: false,
				coalesceKey: null,
			});
		default:
			return null;
	}
}

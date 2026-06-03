/**
 * Pure mapping from `gjc --mode rpc` event frames (docs/rpc.md) to bounded owner event kinds
 * and {@link ObservedSignal}s. The owner feeds raw frames through this mapper and emits the
 * result via its single-writer #emit — the mapper itself performs NO IO and NO appends.
 *
 * Hard rule: evidence is BOUNDED — only ids, names, categories, statuses, cursors, timestamps,
 * and short codes/messages. Never assistant text, message deltas, command output, or raw args.
 */
import type { ObservedSignal } from "./types";

export interface MappedFrame {
	/** Owner event kind (rpc_*). */
	kind: string;
	/** Bounded observed signal, or null when the frame carries no user-facing signal. */
	signal: ObservedSignal | null;
	/** Bounded evidence — ids/names/statuses/cursors/timestamps/short codes only. */
	evidence: Record<string, unknown>;
	/** Severity for the emitted event. */
	severity: "info" | "warn" | "critical";
	/** Never-drop frames (must be enqueued in order, never coalesced away). */
	semantic: boolean;
	/** Coalescing key for high-frequency non-semantic frames (message id / tool id); null otherwise. */
	coalesceKey: string | null;
}

const TEST_RE = /\b(bun test|npm test|yarn test|pnpm test|jest|vitest|pytest|go test|cargo test|mocha|ava)\b/i;

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
function boundedMessage(v: unknown): string | undefined {
	const s = typeof v === "string" ? v : undefined;
	return s === undefined ? undefined : s.slice(0, 200);
}

/**
 * Map a single RPC frame. Returns null for frames that carry no observability value
 * (or that the adapter handles itself: `ready`, `response`).
 */
export function mapRpcFrame(frame: Record<string, unknown>): MappedFrame | null {
	const type = str(frame.type);
	if (!type || type === "ready" || type === "response") return null;

	switch (type) {
		case "agent_start":
			return {
				kind: "rpc_agent_started",
				signal: "SessionStart",
				evidence: {},
				severity: "info",
				semantic: true,
				coalesceKey: null,
			};
		case "turn_start":
			return {
				kind: "rpc_turn_started",
				signal: "prompt-accepted",
				evidence: {},
				severity: "info",
				semantic: true,
				coalesceKey: null,
			};
		case "turn_end":
			return {
				kind: "rpc_turn_ended",
				signal: null,
				evidence: {},
				severity: "info",
				semantic: false,
				coalesceKey: null,
			};
		case "message_start":
		case "message_update":
		case "message_end":
			return {
				kind: "rpc_message_activity",
				signal: null,
				evidence: { phase: type, messageId: str(frame.messageId) ?? null },
				severity: "info",
				semantic: false,
				coalesceKey: `message:${str(frame.messageId) ?? "msg"}`,
			};
		case "tool_execution_start": {
			const toolName = str(frame.toolName);
			const test = isTestRunnerTool(toolName, frame.command ?? frame.commandLine);
			return {
				kind: "rpc_tool_started",
				signal: test ? "test-running" : "tool-call",
				evidence: { toolId: str(frame.toolCallId) ?? null, toolName: toolName ?? null },
				severity: "info",
				semantic: true,
				coalesceKey: null,
			};
		}
		case "tool_execution_update": {
			const toolName = str(frame.toolName);
			const test = isTestRunnerTool(toolName, frame.command);
			return {
				kind: "rpc_tool_updated",
				signal: test ? "test-running" : null,
				evidence: { toolId: str(frame.toolCallId) ?? null, status: str(frame.status) ?? null },
				severity: "info",
				semantic: false,
				coalesceKey: `tool:${str(frame.toolCallId) ?? "tool"}`,
			};
		}
		case "tool_execution_end": {
			const toolName = str(frame.toolName);
			const test = isTestRunnerTool(toolName, frame.command);
			return {
				kind: "rpc_tool_ended",
				signal: test ? "test-running" : "tool-call",
				evidence: {
					toolId: str(frame.toolCallId) ?? null,
					toolName: toolName ?? null,
					status: str(frame.status) ?? null,
					exitCode: num(frame.exitCode) ?? null,
				},
				severity: str(frame.status) === "error" ? "warn" : "info",
				semantic: true,
				coalesceKey: null,
			};
		}
		case "host_tool_call":
		case "host_tool_cancel":
			return {
				kind: "rpc_host_tool",
				signal: "tool-call",
				evidence: { toolName: str(frame.toolName) ?? null },
				severity: "info",
				semantic: false,
				coalesceKey: null,
			};
		case "host_uri_request":
		case "host_uri_cancel":
			return {
				kind: "rpc_host_uri",
				signal: "tool-call",
				evidence: { operation: str(frame.operation) ?? null },
				severity: "info",
				semantic: false,
				coalesceKey: null,
			};
		case "auto_compaction_start":
		case "auto_compaction_end":
			return {
				kind: "rpc_compaction",
				signal: null,
				evidence: { phase: type },
				severity: "info",
				semantic: false,
				coalesceKey: null,
			};
		case "auto_retry_start":
		case "auto_retry_end":
			return {
				kind: "rpc_retry",
				signal: null,
				evidence: { phase: type, reason: boundedMessage(frame.reason) ?? null },
				severity: "warn",
				semantic: false,
				coalesceKey: null,
			};
		case "ttsr_triggered":
			return {
				kind: "rpc_ttsr",
				signal: "error",
				evidence: { reason: boundedMessage(frame.reason) ?? null },
				severity: "warn",
				semantic: true,
				coalesceKey: null,
			};
		case "todo_reminder":
		case "todo_auto_clear":
			return {
				kind: "rpc_todo",
				signal: null,
				evidence: { phase: type },
				severity: "info",
				semantic: false,
				coalesceKey: null,
			};
		case "extension_ui_request":
			return {
				kind: "rpc_extension_request",
				signal: "tool-call",
				evidence: { method: str(frame.method) ?? null },
				severity: "info",
				semantic: false,
				coalesceKey: null,
			};
		case "extension_error":
			return {
				kind: "rpc_extension_error",
				signal: "error",
				evidence: {
					code: str(frame.error) ? boundedMessage(frame.error) : null,
					extensionPath: str(frame.extensionPath) ?? null,
				},
				severity: "critical",
				semantic: true,
				coalesceKey: null,
			};
		case "agent_end": {
			const failed =
				Boolean(frame.error) ||
				frame.aborted === true ||
				str(frame.outcome) === "failed" ||
				str(frame.outcome) === "aborted";
			return failed
				? {
						kind: "rpc_agent_failed",
						signal: "error",
						evidence: { outcome: str(frame.outcome) ?? "failed" },
						severity: "critical",
						semantic: true,
						coalesceKey: null,
					}
				: {
						kind: "rpc_agent_completed",
						signal: "completed",
						evidence: { outcome: "completed" },
						severity: "info",
						semantic: true,
						coalesceKey: null,
					};
		}
		default:
			return null;
	}
}

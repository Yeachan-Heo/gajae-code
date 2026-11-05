import type { AgentMessage } from "@gajae-code/agent-core";
import type { StopReason, TextContent, ToolCall, ToolResultMessage } from "@gajae-code/ai/core";
import type { SecretObfuscator } from "../secrets/obfuscator";
import {
	BTW_MAX_TOOL_STATUS_LINE_UTF8_BYTES,
	BTW_MAX_TOOL_STATUS_TOTAL_UTF8_BYTES,
	type BtwRoleTextMessage,
	truncateUtf8,
	utf8ByteLength,
} from "./btw-contract";

export type BtwToolStatus = "ok" | "error" | "aborted" | "running";

/** Maps raw status text to its provider-safe form. Applied to the whole line head before any byte budget. */
export type BtwStatusSanitizer = (text: string) => string;

/** Typed liveness facts of the main agent, read once when the scope is frozen. */
export interface BtwProjectionEvidence {
	/** True while the main agent run is active (`AgentState.isStreaming`). */
	runActive: boolean;
	/** Tool calls with a `tool_execution_start` and no `tool_execution_end` yet (`AgentState.pendingToolCalls`). */
	pendingToolCallIds: ReadonlySet<string>;
}

export interface BtwProjectionOptions extends BtwProjectionEvidence {
	/** Required: there is no default sanitizer. See {@link createBtwStatusSanitizer}. */
	sanitize: BtwStatusSanitizer;
}

/**
 * Bind the session's active outbound secret set (the same `SecretObfuscator`
 * that `obfuscateMessages` applies to every main-agent request) to a text
 * sanitizer. Without an obfuscator, or with an empty secret set, there is
 * nothing to scrub and the text is returned unchanged.
 */
export function createBtwStatusSanitizer(obfuscator: SecretObfuscator | undefined): BtwStatusSanitizer {
	if (!obfuscator?.hasSecrets()) return text => text;
	return text => obfuscator.obfuscate(text);
}

const MAX_TARGET_RAW_CHARS = 1024;
const CONTROL_AND_BIDI = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;
/** A bare command word that is unambiguously terminated; `FOO=1 cmd`, quotes, `$`, and paths never match. */
const BASH_PROGRAM = /^([A-Za-z][A-Za-z0-9_.+-]{0,63})(?=$|[\s;&|])/;
const SHELL_RESERVED_WORDS: ReadonlySet<string> = new Set([
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"for",
	"while",
	"until",
	"do",
	"done",
	"case",
	"esac",
	"select",
	"function",
	"time",
	"coproc",
	"in",
]);

function toSingleLine(text: string): string {
	return text.replace(CONTROL_AND_BIDI, " ").replace(/\s+/g, " ").trim();
}

function pathLikeTarget(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	if (value.trim().length === 0 || value.length > MAX_TARGET_RAW_CHARS) return undefined;
	// A URL may carry credentials in its authority or query; only local path-like values are projected.
	if (value.includes("://")) return undefined;
	return value;
}

function singleEntryTarget(value: unknown): string | undefined {
	return Array.isArray(value) && value.length === 1 ? pathLikeTarget(value[0]) : undefined;
}

function bashProgramTarget(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const program = BASH_PROGRAM.exec(value.trimStart())?.[1];
	if (program === undefined || SHELL_RESERVED_WORDS.has(program)) return undefined;
	return program;
}

/**
 * Per-tool allow-list of the one argument that names the target, taken from the
 * real tool schemas: `read`/`write` `path`; `edit` `path` (replace, patch and
 * hashline modes) or `file` (vim mode; apply_patch has neither, so no target);
 * `find`/`search` `paths` only when it holds exactly one entry; `bash`
 * `command`, reduced to a bare first command word. Any other tool gets no
 * target.
 */
function resolveTarget(name: string, args: ToolCall["arguments"]): string | undefined {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
	switch (name) {
		case "read":
		case "write":
			return pathLikeTarget(args.path);
		case "edit":
			return args.path === undefined ? pathLikeTarget(args.file) : pathLikeTarget(args.path);
		case "find":
		case "search":
			return singleEntryTarget(args.paths);
		case "bash":
			return bashProgramTarget(args.command);
		default:
			return undefined;
	}
}

interface BtwToolCallRecord {
	id: string;
	name: string;
	target: string | undefined;
	ownerIndex: number;
	ownerStopReason: StopReason;
	ownerIsLastAssistant: boolean;
}

/**
 * Status from typed evidence only; result and error text is never read.
 * `undefined` means no typed evidence exists, so no line is produced.
 */
function resolveStatus(
	call: BtwToolCallRecord,
	result: ToolResultMessage | undefined,
	evidence: BtwProjectionEvidence,
): BtwToolStatus | undefined {
	if (result !== undefined) {
		if (!result.isError) return "ok";
		// The loop answers every call of an aborted assistant message with an error result.
		return call.ownerStopReason === "aborted" ? "aborted" : "error";
	}
	if (call.ownerStopReason === "aborted") return "aborted";
	if (evidence.pendingToolCallIds.has(call.id)) return "running";
	if (evidence.runActive && call.ownerIsLastAssistant && call.ownerStopReason === "toolUse") return "running";
	return undefined;
}

/**
 * The whole line head is sanitized before any byte budget is applied, so a
 * secret that would straddle the cut is replaced first and can never be left
 * as a partial prefix. The status suffix is a closed vocabulary and always kept.
 */
function formatStatusLine(
	call: BtwToolCallRecord,
	status: BtwToolStatus,
	sanitize: BtwStatusSanitizer,
): string | undefined {
	const suffix = `: ${status}`;
	const rawHead = `[tool] ${call.name}${call.target === undefined ? "" : ` ${call.target}`}`;
	const head = toSingleLine(sanitize(rawHead));
	if (head.length === 0) return undefined;
	const budget = BTW_MAX_TOOL_STATUS_LINE_UTF8_BYTES - utf8ByteLength(suffix);
	return `${truncateUtf8(head, budget).trimEnd()}${suffix}`;
}

interface BtwStatusEntry {
	ownerIndex: number;
	line: string;
}

/** Keep the newest contiguous run of lines that fits the total budget; the oldest are dropped first. */
function newestWithinBudget(entries: readonly BtwStatusEntry[]): readonly BtwStatusEntry[] {
	let total = 0;
	let start = entries.length;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const cost = utf8ByteLength(entries[index]!.line) + 1;
		if (total + cost > BTW_MAX_TOOL_STATUS_TOTAL_UTF8_BYTES) break;
		total += cost;
		start = index;
	}
	return entries.slice(start);
}

function collectStatusLines(messages: readonly AgentMessage[], options: BtwProjectionOptions): Map<number, string[]> {
	let lastAssistantIndex = -1;
	messages.forEach((message, index) => {
		if (message.role === "assistant") lastAssistantIndex = index;
	});

	const calls: BtwToolCallRecord[] = [];
	const callIdCounts = new Map<string, number>();
	const resultsById = new Map<string, ToolResultMessage[]>();
	messages.forEach((message, index) => {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				callIdCounts.set(block.id, (callIdCounts.get(block.id) ?? 0) + 1);
				if (typeof block.name !== "string" || block.name.trim().length === 0) continue;
				calls.push({
					id: block.id,
					name: block.name,
					target: block.incompleteArguments === true ? undefined : resolveTarget(block.name, block.arguments),
					ownerIndex: index,
					ownerStopReason: message.stopReason,
					ownerIsLastAssistant: index === lastAssistantIndex,
				});
			}
		} else if (message.role === "toolResult") {
			const existing = resultsById.get(message.toolCallId);
			if (existing) existing.push(message);
			else resultsById.set(message.toolCallId, [message]);
		}
	});

	const entries: BtwStatusEntry[] = [];
	for (const call of calls) {
		// An id shared by several calls or several results cannot be linked exactly.
		if (callIdCounts.get(call.id) !== 1) continue;
		const results = resultsById.get(call.id);
		if (results !== undefined && results.length !== 1) continue;
		const status = resolveStatus(call, results?.[0], options);
		if (status === undefined) continue;
		const line = formatStatusLine(call, status, options.sanitize);
		if (line !== undefined) entries.push({ ownerIndex: call.ownerIndex, line });
	}

	const linesByOwner = new Map<number, string[]>();
	for (const { ownerIndex, line } of newestWithinBudget(entries)) {
		const lines = linesByOwner.get(ownerIndex);
		if (lines) lines.push(line);
		else linesByOwner.set(ownerIndex, [line]);
	}
	return linesByOwner;
}

/**
 * Freeze the visible text of the main conversation for a side-chat scope.
 * Only user/assistant text blocks are carried. Tool activity is reduced to
 * `[tool] <name> <allow-listed-target>: ok|error|aborted|running` lines appended
 * to the assistant message that issued the call. Thinking, images, custom and
 * developer messages, provider payloads, full arguments and tool output are
 * never read into the projection. The input messages are not modified.
 */
export function projectBtwVisibleText(
	messages: readonly AgentMessage[],
	options: BtwProjectionOptions,
): BtwRoleTextMessage[] {
	const statusLines = collectStatusLines(messages, options);
	const projected: BtwRoleTextMessage[] = [];
	messages.forEach((message, index) => {
		if (message.role !== "user" && message.role !== "assistant") return;
		const text = (
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((block): block is TextContent => block.type === "text")
						.map(block => block.text)
						.join("")
		).trim();
		const lines = message.role === "assistant" ? (statusLines.get(index) ?? []) : [];
		const combined = text.length > 0 ? [text, ...lines].join("\n") : lines.join("\n");
		if (!combined) return;
		projected.push({ role: message.role, text: combined });
	});
	return projected;
}

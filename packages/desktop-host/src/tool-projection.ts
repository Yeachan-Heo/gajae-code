import type { CreateAgentSessionResult } from "@gajae-code/coding-agent/sdk";
import type { DesktopMessage } from "./protocol";
import {
	DESKTOP_TOOL_LIMITS,
	type DesktopToolCall,
	type DesktopToolCallStats,
	type DesktopToolCallStatus,
	type DesktopToolDetail,
	type DesktopToolFamily,
} from "./tool-protocol";

type Session = CreateAgentSessionResult["session"];

/** The `tool.detail` refusal while call details are not projected; it never stands in for data. */
export const TOOL_DETAIL_UNAVAILABLE = "Tool call details are not available yet.";

/**
 * Strings longer than this are withheld instead of redacted, so redaction never allocates without
 * bound. Exact-secret matching must see the whole string before any cut, so a longer string has
 * no safe prefix to show.
 */
export const MAX_REDACTION_CHARS = 8 * 1024 * 1024;
/** One tool name in `DesktopToolCallStats.activated`. */
const ACTIVATED_NAME_LIMIT = 100;
/** Array entries one subject reads, before the subject's own length bound applies. */
const SUBJECT_ENTRIES = 20;

const record = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const count = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Redact the whole string, then cut its head; undefined when it cannot be shown safely. */
function redactedHead(value: unknown, limit: number, redact: (text: string) => string): string | undefined {
	if (typeof value !== "string" || !value || value.length > MAX_REDACTION_CHARS) return undefined;
	const safe = redact(value);
	return safe.length > MAX_REDACTION_CHARS ? undefined : safe.slice(0, limit);
}

/** A `toolCall` block of an assistant message, as the SDK stores it. */
export interface ToolCallSource {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	/** The model's stated intent: the SDK's extracted `intent`, else the traced `_i` argument. */
	intent?: string;
}

/** The well-formed tool calls of an assistant message, in order. */
export function toolCallBlocks(message: unknown): ToolCallSource[] {
	const value = record(message);
	if (value?.role !== "assistant" || !Array.isArray(value.content)) return [];
	const calls: ToolCallSource[] = [];
	for (const part of value.content) {
		const block = record(part);
		if (block?.type !== "toolCall" || typeof block.id !== "string" || !block.id || typeof block.name !== "string")
			continue;
		const args = record(block.arguments) ?? {};
		const intent =
			typeof block.intent === "string" ? block.intent : typeof args._i === "string" ? args._i : undefined;
		calls.push({ id: block.id, name: block.name, arguments: args, ...(intent?.trim() ? { intent } : {}) });
	}
	return calls;
}

/** One piece of a subject: a raw argument value, redacted whole before anything else happens. */
interface SubjectPart {
	value: unknown;
	/** Keep only the first non-empty line (commands and code). */
	firstLine?: boolean;
	/** Remove `user:password@` from a URL. */
	url?: boolean;
}
interface ToolSpec {
	family: DesktopToolFamily;
	/** Reads only the fields this tool allowlists; every other argument stays off the row. */
	subject?(args: Record<string, unknown>): { prefix?: string; parts: SubjectPart[] };
}

const entries = (value: unknown): unknown[] => (Array.isArray(value) ? value.slice(0, SUBJECT_ENTRIES) : []);
const paths = (value: unknown): SubjectPart[] => entries(value).map(item => ({ value: item }));
const shell = (field: string) => (args: Record<string, unknown>) => ({
	prefix: "$ ",
	parts: [{ value: args[field], firstLine: true }],
});

/**
 * The row allowlist: tool name → display family and the argument fields its subject is built
 * from. A tool missing here, including every MCP tool, shows its name and no subject.
 */
const TOOLS: Readonly<Record<string, ToolSpec>> = {
	read: { family: "read", subject: args => ({ parts: [{ value: args.path, url: true }] }) },
	write: { family: "write", subject: args => ({ parts: [{ value: args.path }] }) },
	edit: { family: "edit", subject: args => ({ parts: [{ value: args.path }] }) },
	ast_edit: { family: "edit", subject: args => ({ parts: paths(args.paths) }) },
	search: { family: "search", subject: args => ({ parts: [{ value: args.pattern }, ...paths(args.paths)] }) },
	ast_grep: { family: "search", subject: args => ({ parts: [{ value: args.pat }, ...paths(args.paths)] }) },
	find: { family: "find", subject: args => ({ parts: paths(args.paths) }) },
	bash: { family: "shell", subject: shell("command") },
	ssh: { family: "shell", subject: shell("command") },
	python: { family: "shell", subject: args => ({ parts: [{ value: args.code, firstLine: true }] }) },
	eval: {
		family: "shell",
		subject: args => ({ parts: [{ value: record(entries(args.cells)[0])?.code, firstLine: true }] }),
	},
	web_search: { family: "web", subject: args => ({ parts: [{ value: args.query }] }) },
	task: { family: "task", subject: args => ({ parts: [{ value: args.agent }] }) },
	todo_write: {
		family: "todo",
		subject: args => {
			const first = record(entries(args.ops)[0]);
			return { parts: [{ value: first?.op }, { value: first?.task ?? first?.phase ?? first?.text }] };
		},
	},
	search_tool_bm25: { family: "tool-search", subject: args => ({ parts: [{ value: args.query }] }) },
	skill: { family: "other", subject: args => ({ parts: [{ value: args.name }] }) },
};

export function toolFamily(name: string): DesktopToolFamily {
	return Object.hasOwn(TOOLS, name) ? TOOLS[name]!.family : "other";
}

function withoutUserInfo(text: string): string {
	return text.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]*@/i, "$1");
}

/** The one-line subject: each allowlisted value redacted in full, then joined, then cut. */
function subject(name: string, args: Record<string, unknown>, redact: (text: string) => string): string | undefined {
	const spec = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
	const shape = spec?.subject?.(args);
	if (!shape) return undefined;
	const pieces: string[] = [];
	let length = 0;
	for (const part of shape.parts) {
		if (length > DESKTOP_TOOL_LIMITS.subject) break;
		if (typeof part.value !== "string" || part.value.length > MAX_REDACTION_CHARS) continue;
		let text = redact(part.value);
		if (text.length > MAX_REDACTION_CHARS) continue;
		if (part.firstLine) text = text.split("\n").find(line => line.trim()) ?? "";
		if (part.url) text = withoutUserInfo(text);
		text = text.replace(/\s+/g, " ").trim();
		if (!text) continue;
		pieces.push(text);
		length += text.length;
	}
	if (pieces.length === 0) return undefined;
	return `${shape.prefix ?? ""}${pieces.join(" · ")}`.slice(0, DESKTOP_TOOL_LIMITS.subject);
}

function intentLine(intent: string | undefined, redact: (text: string) => string): string | undefined {
	const text = redactedHead(intent, MAX_REDACTION_CHARS, redact)?.replace(/\s+/g, " ").trim();
	return text ? text.slice(0, DESKTOP_TOOL_LIMITS.intent) : undefined;
}

/** First text block of a tool result, for the few markers the SDK only states in text. */
function resultText(result: Record<string, unknown>): string {
	const content = result.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	for (const part of content) {
		const block = record(part);
		if (block?.type === "text" && typeof block.text === "string") return block.text;
	}
	return "";
}

/**
 * Settled status of a `toolResult` message. The agent loop states an aborted or skipped call only
 * in its result text ("Tool execution was aborted", "Skipped due to queued …"); a tool that keeps
 * working after it returns says so in `details.async.state`.
 */
export function toolResultStatus(result: unknown): DesktopToolCallStatus {
	const value = record(result) ?? {};
	if (value.isError === true) {
		const text = resultText(value);
		return text.startsWith("Tool execution was aborted") || text.startsWith("Skipped due to queued")
			? "cancelled"
			: "failed";
	}
	const state = record(record(value.details)?.async)?.state;
	return state === "running" || state === "queued" || state === "paused" ? "background" : "done";
}

/** Count `+`/`-` lines of an SDK diff (`+12|text`, `-3|text`, ` 4|text`, `@@ … @@`). */
export function diffLineCounts(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

/** The diffs an edit result reports: one per file of a multi-file edit, else the single diff. */
export function editDiffs(details: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
	const perFile = Array.isArray(details?.perFileResults)
		? details.perFileResults.map(record).filter(item => item !== undefined)
		: [];
	if (perFile.length > 0) return perFile;
	return details && typeof details.diff === "string" ? [details] : [];
}

function lineCount(text: unknown): number | undefined {
	if (typeof text !== "string" || text.length > MAX_REDACTION_CHARS) return undefined;
	if (!text) return 0;
	return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** `Command exited with code N` / `Command terminated by SIG (exit code N)` ends a failed bash result. */
function exitCode(text: string): number | undefined {
	const tail = text.slice(-200);
	const match = /(?:Command exited with code (\d+)|\(exit code (\d+)\))\s*$/.exec(tail);
	return match ? count(Number(match[1] ?? match[2])) : undefined;
}

function stats(
	call: ToolCallSource | undefined,
	family: DesktopToolFamily,
	result: Record<string, unknown> | undefined,
	redact: (text: string) => string,
): DesktopToolCallStats | undefined {
	const details = record(result?.details);
	const out: DesktopToolCallStats = {};
	if (family === "edit" && details) {
		const diffs = editDiffs(details);
		let added = 0;
		let removed = 0;
		for (const item of diffs) {
			if (typeof item.diff !== "string" || item.diff.length > MAX_REDACTION_CHARS) continue;
			const lines = diffLineCounts(item.diff);
			added += lines.added;
			removed += lines.removed;
		}
		if (diffs.length > 0) Object.assign(out, { added, removed });
		const files = count(details.filesTouched) ?? (diffs.length > 1 ? diffs.length : undefined);
		if (files !== undefined) out.files = files;
	} else if (family === "write" && call && result?.isError !== true) {
		const lines = lineCount(call.arguments.content);
		if (lines !== undefined) out.added = lines;
	} else if (family === "search" && details) {
		const matches = count(details.matchCount);
		if (matches !== undefined) out.matches = matches;
		const files = count(details.fileCount);
		if (files !== undefined) out.files = files;
	} else if (family === "find" && details) {
		const files = count(details.fileCount);
		if (files !== undefined) out.files = files;
	} else if (family === "shell" && result?.isError === true) {
		const code = exitCode(resultText(result));
		if (code !== undefined) out.exitCode = code;
	} else if (family === "tool-search" && Array.isArray(details?.activated_tools)) {
		const activated: string[] = [];
		for (const name of details.activated_tools.slice(0, DESKTOP_TOOL_LIMITS.statsActivated)) {
			const text = redactedHead(name, ACTIVATED_NAME_LIMIT, redact);
			if (text) activated.push(text);
		}
		out.activated = activated;
	} else if (family === "task" && call && Array.isArray(call.arguments.tasks)) {
		out.tasks = call.arguments.tasks.length;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** True when the call has arguments `tool.detail` would show beyond the row. */
export function hasDetail(call: ToolCallSource | undefined, result: unknown): boolean {
	if (call && Object.keys(call.arguments).some(key => !key.startsWith("_"))) return true;
	const details = record(record(result)?.details);
	return editDiffs(details).length > 0 || Array.isArray(details?.tools) || Array.isArray(details?.phases);
}

/**
 * Call metadata for a transcript row. Every string is redacted whole before it is cut. `detail`
 * is the caller's statement that this Host answers `tool.detail` for the row's session.
 */
export function projectToolCall(
	input: {
		callId: string;
		toolName: string;
		call?: ToolCallSource;
		/** The `toolResult` message; absent while the call has not settled. */
		result?: unknown;
		status: DesktopToolCallStatus;
		detail: boolean;
	},
	redact: (text: string) => string,
): DesktopToolCall {
	const family = toolFamily(input.toolName);
	const shown = input.call ? subject(input.toolName, input.call.arguments, redact) : undefined;
	const intent = intentLine(input.call?.intent, redact);
	const facts = stats(input.call, family, record(input.result), redact);
	return {
		callId: redactedHead(input.callId, 512, redact) ?? "",
		status: input.status,
		family,
		...(shown ? { subject: shown } : {}),
		...(intent ? { intent } : {}),
		...(facts ? { stats: facts } : {}),
		detail: input.detail && hasDetail(input.call, input.result),
	};
}

/** Execution state the agent loop reports between a call's `message_end` and its result. */
interface LiveCall {
	/** `tool_execution_start` was seen; `pendingToolCalls` alone misses the gap after its end. */
	started: boolean;
	/** Latest streamed output text, unredacted and uncut until it is projected. */
	tail?: string;
}

/** Live call state per SDK session. A session that is dropped takes its entry with it. */
const liveCalls = new WeakMap<object, Map<string, LiveCall>>();

/**
 * Receives every event of a live SDK session, before the Host's own handling, so running calls
 * can be tracked between `message_end` and their result. It must not throw.
 */
export function observeToolEvent(session: Session, event: { readonly type: string }): void {
	try {
		if (event.type === "agent_start" || event.type === "agent_end") {
			liveCalls.delete(session);
			return;
		}
		const value = event as unknown as Record<string, unknown>;
		if (event.type === "message_end") {
			const message = record(value.message);
			if (message?.role === "toolResult" && typeof message.toolCallId === "string")
				liveCalls.get(session)?.delete(message.toolCallId);
			return;
		}
		if (
			(event.type !== "tool_execution_start" && event.type !== "tool_execution_update") ||
			typeof value.toolCallId !== "string"
		)
			return;
		const calls = liveCalls.get(session) ?? new Map<string, LiveCall>();
		liveCalls.set(session, calls);
		const call = calls.get(value.toolCallId) ?? { started: false };
		call.started = true;
		if (event.type === "tool_execution_update") {
			// Bash also sends content-less updates (a terminal id, an input prompt); they keep the tail.
			const text = resultText(record(value.partialResult) ?? {});
			if (text) call.tail = text;
		}
		calls.set(value.toolCallId, call);
	} catch {
		// Observation is best effort; the Host's own event handling must continue.
	}
}

/** Streamed output kept on a running row: the newest characters, after redaction. */
export const LIVE_TAIL_LIMIT = 4_000;
/** Live rows one projection synthesizes, newest last. */
const LIVE_ROWS_LIMIT = 64;

/**
 * Rows for calls that have no result yet, only while the session streams: `preparing` while the
 * streaming message is still writing the call, `running` once the agent loop executes it, and
 * `waiting` in between. Saved history never produces them. Each row's id is `call:<callId>`; a
 * call whose result is already in `session.messages` gets no row, so one id never appears twice.
 */
export function projectLiveToolCalls(
	session: Pick<Session, "isStreaming" | "messages" | "state"> | undefined,
	streamingMessage: unknown,
	redact: (text: string) => string,
): DesktopMessage[] {
	try {
		if (!session?.isStreaming) return [];
		const messages = session.messages;
		const settled = new Set<string>();
		const pending: ToolCallSource[] = [];
		// The current turn starts after the newest user message; every result follows its call.
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = record(messages[index]);
			if (message?.role === "user") break;
			if (message?.role === "toolResult" && typeof message.toolCallId === "string") settled.add(message.toolCallId);
			else if (message?.role === "assistant")
				pending.unshift(...toolCallBlocks(message).filter(call => !settled.has(call.id)));
		}
		const preparing = toolCallBlocks(streamingMessage);
		const running = session.state.pendingToolCalls;
		const tracked = liveCalls.get(session as object);
		const rows: DesktopMessage[] = [];
		const seen = new Set<string>();
		for (const call of [...pending, ...preparing].slice(-LIVE_ROWS_LIMIT)) {
			if (seen.has(call.id)) continue;
			seen.add(call.id);
			const live = tracked?.get(call.id);
			const status: DesktopToolCallStatus = preparing.includes(call)
				? "preparing"
				: running.has(call.id) || live?.started
					? "running"
					: "waiting";
			const tail = status === "running" ? liveTail(live?.tail, redact) : undefined;
			rows.push({
				id: `call:${call.id}`,
				role: "tool",
				toolName: redactedHead(call.name, 100, redact) ?? "",
				text: tail?.text ?? "",
				...(tail?.truncated ? { truncated: true } : {}),
				tool: projectToolCall({ callId: call.id, toolName: call.name, call, status, detail: true }, redact),
			});
		}
		return rows;
	} catch {
		return [];
	}
}

function liveTail(
	text: string | undefined,
	redact: (text: string) => string,
): { text: string; truncated: boolean } | undefined {
	if (!text || text.length > MAX_REDACTION_CHARS) return undefined;
	const safe = redact(text);
	if (safe.length > MAX_REDACTION_CHARS) return undefined;
	return { text: safe.slice(-LIVE_TAIL_LIMIT), truncated: safe.length > LIVE_TAIL_LIMIT };
}

/**
 * Answers `tool.detail` for a live session. `tool.detail` is a projected control method, so the
 * Host does not redact this result when it emits it: every string must pass through `redact`
 * before any cut. Until call details are projected this fails closed.
 */
export function projectToolDetail(
	_session: Session,
	_streamingMessage: unknown,
	_callId: string,
	_redact: (text: string) => string,
): DesktopToolDetail {
	throw new Error(TOOL_DETAIL_UNAVAILABLE);
}

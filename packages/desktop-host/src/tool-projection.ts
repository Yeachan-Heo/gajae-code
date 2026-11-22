import type { CreateAgentSessionResult } from "@gajae-code/coding-agent/sdk";
import type { DesktopMessage } from "./protocol";
import { projectTodos } from "./session-state";
import {
	DESKTOP_TOOL_LIMITS,
	type DesktopToolCall,
	type DesktopToolCallStats,
	type DesktopToolCallStatus,
	type DesktopToolDetail,
	type DesktopToolDiff,
	type DesktopToolFamily,
	type DesktopToolSearchDetail,
	type DesktopToolSearchMatch,
} from "./tool-protocol";

type Session = CreateAgentSessionResult["session"];

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

/** Length of the longest suffix of `text` that is a proper prefix of `secret`. */
function secretStartAtEnd(text: string, secret: string): number {
	const first = secret.charCodeAt(0);
	for (let at = Math.max(0, text.length - secret.length + 1); at < text.length; at++)
		if (text.charCodeAt(at) === first && secret.startsWith(text.slice(at))) return text.length - at;
	return 0;
}

/** Length of the longest prefix of `text` that is a proper suffix of `secret`. */
function secretEndAtStart(text: string, secret: string): number {
	const last = secret.charCodeAt(secret.length - 1);
	for (let end = Math.min(text.length, secret.length - 1); end > 0; end--)
		if (text.charCodeAt(end - 1) === last && secret.endsWith(text.slice(0, end))) return end;
	return 0;
}

/**
 * Already-redacted text of a value that is still growing, with any part of a known secret at its
 * edges withheld: at its end, text that could be the start of a secret whose rest has not arrived
 * (a streamed argument, a running command's newest output); with `start`, text at its beginning
 * that could be the end of one (the SDK keeps only a command's newest output, so that tail can
 * begin inside a secret). It reads the redacted text, so a whole secret is already masked and is
 * never cut into a visible prefix. Unlike the assistant-text stream redactor it needs no fixed
 * hold-back: each frame projects the whole value again, so only an actual partial match is held.
 */
export function withholdPartialSecrets(text: string, secrets: Iterable<string>, start = false): string {
	let head = 0;
	let tail = 0;
	for (const secret of secrets) {
		if (secret.length < 2) continue;
		tail = Math.max(tail, secretStartAtEnd(text, secret));
		if (start) head = Math.max(head, secretEndAtStart(text, secret));
	}
	return head + tail >= text.length ? "" : text.slice(head, text.length - tail);
}

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
	/** Keep only the file headers of an edit envelope (`*** Update File: a.ts`, `§a.ts`). */
	headers?: boolean;
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
	write: { family: "write", subject: args => ({ parts: [{ value: args.path ?? args.file_path }] }) },
	// Replace, patch and headerless hashline edits name `path`; vim names `file`. apply_patch and
	// hashline envelopes name their files in header lines, which win over `path` as in the SDK;
	// only those header lines are read, never content lines.
	edit: {
		family: "edit",
		subject: args =>
			typeof args.input === "string" && EDIT_HEADER.test(args.input)
				? { parts: [{ value: args.input, headers: true }] }
				: { parts: [{ value: args.path ?? args.file_path ?? args.file }] },
	},
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

/** A file header line of an apply_patch (`*** Update File: a.ts`) or hashline (`§a.ts`) envelope. */
const EDIT_HEADER = /^(?:\*\*\* (?:Add|Update|Delete) File: |§)(.+)$/m;

/** File paths named by the header lines of an edit envelope, in order. */
function editHeaders(input: string): string[] {
	const paths: string[] = [];
	for (const line of input.split("\n")) {
		const match = EDIT_HEADER.exec(line.replace(/\r$/, "").trimEnd());
		const path = match?.[1]?.trim();
		if (path && !paths.includes(path)) paths.push(path);
		if (paths.length >= SUBJECT_ENTRIES) break;
	}
	return paths;
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
		if (part.headers) text = editHeaders(text).join(" · ");
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
 * `argument` redacts the call's argument values (subject and intent); it defaults to `redact`,
 * and a call whose arguments still stream passes one that also withholds partial secrets.
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
	argument: (text: string) => string = redact,
): DesktopToolCall {
	const family = toolFamily(input.toolName);
	const shown = input.call ? subject(input.toolName, input.call.arguments, argument) : undefined;
	const intent = intentLine(input.call?.intent, argument);
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
	secrets: Iterable<string> = [],
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
			const tail = status === "running" ? liveTail(live?.tail, redact, secrets) : undefined;
			const tool = projectToolCall(
				{ callId: call.id, toolName: call.name, call, status, detail: true },
				redact,
				status === "preparing" ? growing(redact, secrets) : redact,
			);
			rows.push({
				// The redacted id, like `tool.callId`: a row id is display data too.
				id: `call:${tool.callId}`,
				role: "tool",
				toolName: redactedHead(call.name, 100, redact) ?? "",
				text: tail?.text ?? "",
				...(tail?.truncated ? { truncated: true } : {}),
				tool,
			});
		}
		return rows;
	} catch {
		return [];
	}
}

/** Redaction for argument values the streaming message is still writing. */
function growing(redact: (text: string) => string, secrets: Iterable<string>): (text: string) => string {
	return text => withholdPartialSecrets(redact(text), secrets);
}

function liveTail(
	text: string | undefined,
	redact: (text: string) => string,
	secrets: Iterable<string>,
): { text: string; truncated: boolean } | undefined {
	if (!text || text.length > MAX_REDACTION_CHARS) return undefined;
	const redacted = redact(text);
	if (redacted.length > MAX_REDACTION_CHARS) return undefined;
	// Output is still arriving at its end, and the SDK may have cut its start.
	const safe = withholdPartialSecrets(redacted, secrets, true);
	return { text: safe.slice(-LIVE_TAIL_LIMIT), truncated: safe.length > LIVE_TAIL_LIMIT };
}

/** The `tool.detail` answer for a call id the session no longer holds. It never echoes the id. */
export const TOOL_DETAIL_GONE = "This tool call is no longer available.";
/** Nesting and node bounds for pretty-printed arguments; the string bound applies after them. */
const ARGS_DEPTH = 24;
const ARGS_NODES = 20_000;
const withheld = "[withheld: display limit]";

/** Cut to `limit` without leaving half of a surrogate pair at the end. */
function cut(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const head = text.slice(0, limit);
	return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

/**
 * A copy of an argument value with every string key and leaf redacted whole. Redacting before
 * `JSON.stringify` matters: escaping (quotes, backslashes, control characters) would otherwise
 * hide a secret from exact matching.
 */
function redactValue(
	value: unknown,
	redact: (text: string) => string,
	budget: { nodes: number; cut: boolean },
	depth = 0,
): unknown {
	if (budget.nodes-- <= 0 || depth > ARGS_DEPTH) {
		budget.cut = true;
		return withheld;
	}
	if (typeof value === "string") {
		if (value.length > MAX_REDACTION_CHARS) {
			budget.cut = true;
			return withheld;
		}
		const safe = redact(value);
		return safe.length > MAX_REDACTION_CHARS ? withheld : safe;
	}
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.map(item => redactValue(item, redact, budget, depth + 1));
	const object = record(value);
	if (!object) return undefined;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(object)) {
		const safeKey = typeof key === "string" && key.length <= MAX_REDACTION_CHARS ? redact(key) : withheld;
		out[safeKey] = redactValue(item, redact, budget, depth + 1);
	}
	return out;
}

/** Pretty JSON of the arguments without `_`-prefixed (provider and harness) keys. */
function prettyArgs(
	args: Record<string, unknown>,
	omit: readonly string[],
	redact: (text: string) => string,
): { text: string; truncated: boolean } | undefined {
	const shown = Object.fromEntries(
		Object.entries(args).filter(([key]) => !key.startsWith("_") && !omit.includes(key)),
	);
	if (Object.keys(shown).length === 0) return undefined;
	const budget = { nodes: ARGS_NODES, cut: false };
	const text = JSON.stringify(redactValue(shown, redact, budget), null, 2);
	return {
		text: cut(text, DESKTOP_TOOL_LIMITS.args),
		truncated: budget.cut || text.length > DESKTOP_TOOL_LIMITS.args,
	};
}

/** The full command or script of a shell-family call. */
function commandText(name: string, args: Record<string, unknown>): { field: string; text: unknown } | undefined {
	if (name === "bash" || name === "ssh") return { field: "command", text: args.command };
	if (name === "python") return { field: "code", text: args.code };
	if (name === "eval" && Array.isArray(args.cells)) {
		const code = args.cells.map(cell => record(cell)?.code).filter(code => typeof code === "string");
		return { field: "cells", text: code.join("\n\n") };
	}
	return undefined;
}

/**
 * The file an edit call names for its `index`th result, when the result does not say: `path`,
 * `file_path` or `file`, else the envelope's header lines (read after the whole input is redacted).
 */
function callPath(call: ToolCallSource | undefined, index: number, redact: (text: string) => string): unknown {
	const args = call?.arguments;
	const named = args?.path ?? args?.file_path ?? args?.file;
	if (typeof named === "string" || typeof args?.input !== "string" || args.input.length > MAX_REDACTION_CHARS)
		return named;
	return editHeaders(redact(args.input))[index];
}

function diffEntries(
	call: ToolCallSource | undefined,
	family: DesktopToolFamily,
	result: Record<string, unknown> | undefined,
	redact: (text: string) => string,
): { diff: DesktopToolDiff[]; truncated: boolean } | undefined {
	const details = record(result?.details);
	// An edit's diff arrives already numbered by the SDK and is redacted as it stands. A write's
	// content is redacted whole first: numbering its lines would split a secret that spans them.
	const content = family === "write" && result?.isError !== true ? call?.arguments.content : undefined;
	const written = typeof content === "string" && content.length <= MAX_REDACTION_CHARS ? redact(content) : undefined;
	const sources: Array<{ path: unknown; diff: unknown; redacted?: boolean; op?: unknown; error?: unknown }> =
		family === "edit"
			? editDiffs(details).map((item, index) => ({
					path: item.path ?? details?.path ?? callPath(call, index, redact),
					diff: item.diff,
					op: item.op,
					error: item.isError === true ? (item.displayErrorText ?? item.errorText) : undefined,
				}))
			: written !== undefined
				? [
						{
							// The same fields the row subject names the file by.
							path: call?.arguments.path ?? call?.arguments.file_path,
							diff: written
								.replace(/\n$/, "")
								.split("\n")
								.map((line, index) => `+${index + 1}|${line}`)
								.join("\n"),
							redacted: true,
						},
					]
				: [];
	if (sources.length === 0) return undefined;
	let remaining = DESKTOP_TOOL_LIMITS.diff;
	let truncated = false;
	const diff: DesktopToolDiff[] = [];
	for (const source of sources.slice(0, 64)) {
		const path = redactedHead(source.path, DESKTOP_TOOL_LIMITS.subject, redact) ?? "";
		const full =
			typeof source.diff !== "string"
				? ""
				: source.redacted
					? source.diff
					: source.diff.length <= MAX_REDACTION_CHARS
						? redact(source.diff)
						: "";
		if (typeof source.diff === "string" && !full && source.diff) truncated = true;
		const lines = diffLineCounts(full);
		const text = cut(full, Math.max(0, remaining));
		if (text.length < full.length) truncated = true;
		remaining -= text.length;
		const error = redactedHead(source.error, DESKTOP_TOOL_LIMITS.description, redact);
		diff.push({
			path,
			diff: text,
			...lines,
			...(source.op === "create" || source.op === "update" || source.op === "delete" ? { op: source.op } : {}),
			...(error ? { error } : {}),
		});
	}
	return { diff, truncated: truncated || sources.length > 64 };
}

function toolSearchDetail(
	result: Record<string, unknown> | undefined,
	redact: (text: string) => string,
): DesktopToolSearchDetail | undefined {
	const details = record(result?.details);
	if (!details || !Array.isArray(details.tools)) return undefined;
	const names = (value: unknown) =>
		(Array.isArray(value) ? value : [])
			.slice(0, DESKTOP_TOOL_LIMITS.searchMatches)
			.map(name => redactedHead(name, ACTIVATED_NAME_LIMIT, redact))
			.filter(name => name !== undefined);
	const matches: DesktopToolSearchMatch[] = [];
	for (const item of details.tools.slice(0, DESKTOP_TOOL_LIMITS.searchMatches)) {
		const match = record(item);
		const name = redactedHead(match?.name, ACTIVATED_NAME_LIMIT, redact);
		if (!match || !name) continue;
		const description = redactedHead(match.description, MAX_REDACTION_CHARS, redact)?.replace(/\s+/g, " ").trim();
		const server = redactedHead(match.server_name, ACTIVATED_NAME_LIMIT, redact);
		matches.push({
			name,
			label: redactedHead(match.label, ACTIVATED_NAME_LIMIT, redact) ?? name,
			...(description ? { description: cut(description, DESKTOP_TOOL_LIMITS.description) } : {}),
			...(server ? { mcpServer: server } : {}),
		});
	}
	return {
		query: redactedHead(details.query, DESKTOP_TOOL_LIMITS.subject, redact) ?? "",
		activated: names(details.activated_tools),
		matches,
		total: details.tools.length,
	};
}

/**
 * The call with `callId` and the result that answers it: the newest such call, checked in the
 * streaming message first. Row ids are redacted, so a stored id matches by its redacted form too.
 */
function findCall(
	session: Pick<Session, "messages">,
	streamingMessage: unknown,
	callId: string,
	redact: (text: string) => string,
): { call?: ToolCallSource; result?: Record<string, unknown>; streaming?: true } | undefined {
	const matches = (id: unknown) =>
		typeof id === "string" && (id === callId || redactedHead(id, 512, redact) === callId);
	const streaming = toolCallBlocks(streamingMessage).find(call => matches(call.id));
	if (streaming) return { call: streaming, streaming: true };
	const messages = session.messages;
	let result: Record<string, unknown> | undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = record(messages[index]);
		if (!result && message?.role === "toolResult" && matches(message.toolCallId)) result = message;
		else if (message?.role === "assistant") {
			const call = toolCallBlocks(message).find(item => matches(item.id));
			if (call) return { call, ...(result ? { result } : {}) };
		}
	}
	return result ? { result } : undefined;
}

/**
 * Answers `tool.detail` for a live session: the full command, pretty-printed arguments, per-file
 * diffs, tool-search matches or the resulting task list, whichever apply to the call.
 * `tool.detail` is a projected control method, so the Host does not redact this result when it
 * emits it: every string here is redacted whole before any `DESKTOP_TOOL_LIMITS` cut. A call the
 * streaming message is still writing also withholds any partly written secret among `secrets`.
 */
export function projectToolDetail(
	session: Pick<Session, "messages">,
	streamingMessage: unknown,
	callId: string,
	redactText: (text: string) => string,
	secrets: Iterable<string> = [],
): DesktopToolDetail {
	const found = findCall(session, streamingMessage, callId, redactText);
	if (!found) throw new Error(TOOL_DETAIL_GONE);
	const { call, result } = found;
	const redact = found.streaming ? growing(redactText, secrets) : redactText;
	const name = call?.name ?? (typeof result?.toolName === "string" ? result.toolName : "");
	const family = toolFamily(name);
	const detail: DesktopToolDetail = { callId };
	let truncated = false;
	let omit: string[] = [];
	const command = call && family === "shell" ? commandText(name, call.arguments) : undefined;
	if (command) {
		omit = [command.field];
		const text = redactedHead(command.text, MAX_REDACTION_CHARS, redact);
		if (text) {
			detail.command = cut(text, DESKTOP_TOOL_LIMITS.args);
			if (text.length > DESKTOP_TOOL_LIMITS.args) truncated = true;
		}
	}
	const diffs = diffEntries(call, family, result, redact);
	if (diffs) {
		detail.diff = diffs.diff;
		truncated ||= diffs.truncated;
	}
	const search = family === "tool-search" ? toolSearchDetail(result, redact) : undefined;
	if (search) detail.toolSearch = search;
	const phases = family === "todo" ? record(result?.details)?.phases : undefined;
	if (phases !== undefined) {
		const todos = projectTodos({ getTodoPhases: () => phases as never }, redact).todos;
		if (todos) detail.todo = todos;
	}
	// The generic view: everything not shown by a section above, never `_`-prefixed keys.
	const sectioned = detail.diff !== undefined || detail.toolSearch !== undefined || detail.todo !== undefined;
	const args = call && !sectioned ? prettyArgs(call.arguments, omit, redact) : undefined;
	if (args) {
		detail.args = args.text;
		truncated ||= args.truncated;
	}
	return truncated ? { ...detail, truncated: true } : detail;
}

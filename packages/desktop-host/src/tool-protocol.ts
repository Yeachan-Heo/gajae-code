/**
 * Tool-call and tool-catalog wire types shared by the Host and the renderer. The renderer program
 * includes this module through `protocol.ts`, so it must never import the SDK.
 */
import type { DesktopTodoPhase } from "./protocol";

/**
 * Bounds every Host projection applies after redaction, in string length. Exact-secret
 * redaction always sees the whole source string before any cut.
 */
export const DESKTOP_TOOL_LIMITS = {
	/** One-line call subject. */
	subject: 300,
	/** The model's stated intent for a call. */
	intent: 200,
	/** Names in `DesktopToolCallStats.activated`. */
	statsActivated: 8,
	/** Pretty-printed arguments, or the full command, in one `DesktopToolDetail`. */
	args: 16_000,
	/** All `DesktopToolDiff.diff` text of one `DesktopToolDetail` together. */
	diff: 64_000,
	/** Entries in `DesktopToolSearchDetail.matches` and `DesktopToolSearchDetail.activated`. */
	searchMatches: 20,
	/** Entries in `DesktopToolList.tools`. */
	catalog: 400,
	/** One `DesktopToolInfo.description` or `DesktopToolSearchMatch.description`. */
	description: 240,
} as const;

/**
 * Display family that picks a card's icon and verb. Examples: `read` (read), `write` (write),
 * `edit` (edit, ast_edit), `search` (search, ast_grep), `find` (find), `shell` (bash, python),
 * `web` (web_search, fetch), `task` (task), `todo` (todo_write), `tool-search` (search_tool_bm25).
 * Everything else, including MCP tools, is `other` and keeps its raw tool name.
 */
export type DesktopToolFamily =
	| "read"
	| "write"
	| "edit"
	| "search"
	| "find"
	| "shell"
	| "web"
	| "task"
	| "todo"
	| "tool-search"
	| "other";

/**
 * Lifecycle of one call. `preparing` (its arguments are still streaming), `waiting` (its
 * assistant message is complete but execution has not started) and `running` exist only while
 * the session streams; saved history never invents them. `background` means the tool returned
 * while its work continues. A settled call is `done`, `failed` or `cancelled`.
 */
export type DesktopToolCallStatus =
	| "preparing"
	| "waiting"
	| "running"
	| "background"
	| "done"
	| "failed"
	| "cancelled";

/** Summary-line facts; each one is omitted when the tool did not report it. */
export interface DesktopToolCallStats {
	/** Lines added by an edit or write. */
	added?: number;
	/** Lines removed by an edit or write. */
	removed?: number;
	/** Files an edit touched or a find listed. */
	files?: number;
	/** Matches a search reported. */
	matches?: number;
	/** Exit code of a shell call. */
	exitCode?: number;
	/** Tool names a tool search activated. */
	activated?: string[];
}

/**
 * Call metadata on a `role: "tool"` message (`DesktopMessage.tool`). Every string is redacted
 * before it is cut. A row without it renders from `toolName` and `text` alone.
 */
export interface DesktopToolCall {
	/** SDK tool-call id: the same for the streaming, running and settled row of one call. */
	callId: string;
	status: DesktopToolCallStatus;
	family: DesktopToolFamily;
	/** One line from an allowlisted argument: a path, `$ command`, pattern, query or URL. */
	subject?: string;
	/** The model's stated intent for the call. */
	intent?: string;
	stats?: DesktopToolCallStats;
	/** True when `tool.detail` has more to show for this call. */
	detail: boolean;
}

/** One file of an edit or write. */
export interface DesktopToolDiff {
	path: string;
	/** Unified diff text. */
	diff: string;
	added: number;
	removed: number;
	op?: "create" | "update" | "delete";
	/** Why this file was not changed by a multi-file edit. */
	error?: string;
}

/** One ranked result of a tool search. */
export interface DesktopToolSearchMatch {
	name: string;
	label: string;
	description?: string;
	/** Server name for an MCP tool. */
	mcpServer?: string;
}

export interface DesktopToolSearchDetail {
	query: string;
	activated: string[];
	matches: DesktopToolSearchMatch[];
	/** Matches the tool reported before `matches` was capped. */
	total: number;
}

/**
 * Result of `tool.detail {sessionId, callId}`: what an expanded card shows beyond its output.
 * Only the sections that apply to the call are present.
 */
export interface DesktopToolDetail {
	callId: string;
	/** Pretty-printed JSON of the call arguments, without `_`-prefixed keys. */
	args?: string;
	/** Full command (shell) or script (python) text. */
	command?: string;
	diff?: DesktopToolDiff[];
	toolSearch?: DesktopToolSearchDetail;
	/** The task list as this `todo_write` call left it. */
	todo?: DesktopTodoPhase[];
	/** At least one section was cut to its `DESKTOP_TOOL_LIMITS` bound. */
	truncated?: boolean;
}

/** How a tool enters the session's registry. */
export type DesktopToolOrigin = "essential" | "discoverable" | "other";

/** One entry of the `tools.list` catalog. */
export interface DesktopToolInfo {
	name: string;
	label: string;
	/** One line from the tool's summary or the first sentence of its description. */
	description?: string;
	active: boolean;
	origin: DesktopToolOrigin;
	/** Activated by a tool search in this session. */
	discovered: boolean;
	/** Excluded from the model until a tool search finds it. */
	hidden?: boolean;
	/** Server name for an MCP tool. */
	mcpServer?: string;
}

/** Result of `tools.list`. */
export interface DesktopToolList {
	/** Every name `tools.set` accepts. */
	available: string[];
	/** Names currently active for the model. */
	active: string[];
	/** Per-tool metadata; omitted by a Host that does not project the catalog. */
	tools?: DesktopToolInfo[];
	/** Whether a tool search can activate discoverable tools; omitted with `tools`. */
	discovery?: { enabled: boolean };
}

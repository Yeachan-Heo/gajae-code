import type { DesktopMessage } from "@gajae-code/desktop-host/protocol";
import type {
	DesktopToolCall,
	DesktopToolDetail,
	DesktopToolDiff,
	DesktopToolFamily,
} from "@gajae-code/desktop-host/tool-protocol";
import {
	Bot,
	ChevronRight,
	CircleAlert,
	CircleSlash,
	Clock,
	FilePen,
	FilePlus,
	FileText,
	FolderSearch,
	Globe,
	Hourglass,
	ListChecks,
	LoaderCircle,
	type LucideIcon,
	PackageSearch,
	SquareTerminal,
	TextSearch,
	Wrench,
} from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { type MessageKey, t } from "./i18n";
import { MessageBlocks } from "./MessageBlocks";
import { TodoToolBody } from "./TodoToolBody";
import { ToolSearchBody } from "./ToolSearchBody";

/** What a family-specific body receives inside an expanded tool card. */
export interface ToolCallBodyProps {
	message: DesktopMessage;
	/** The `tool.detail` result once it has loaded; absent before then and when unavailable. */
	detail?: DesktopToolDetail;
	/** The row's generic bounded output, for a body that has nothing better to show. */
	output: ReactNode;
}

/** Icon and verbs per family; `other` shows the raw tool name instead of a verb. */
const FAMILIES: Record<
	Exclude<DesktopToolFamily, "other">,
	{ icon: LucideIcon; done: MessageKey; live: MessageKey }
> = {
	read: { icon: FileText, done: "tools.verbRead", live: "tools.verbReadLive" },
	write: { icon: FilePlus, done: "tools.verbWrite", live: "tools.verbWriteLive" },
	edit: { icon: FilePen, done: "tools.verbEdit", live: "tools.verbEditLive" },
	search: { icon: TextSearch, done: "tools.verbSearch", live: "tools.verbSearchLive" },
	find: { icon: FolderSearch, done: "tools.verbFind", live: "tools.verbFindLive" },
	shell: { icon: SquareTerminal, done: "tools.verbShell", live: "tools.verbShellLive" },
	web: { icon: Globe, done: "tools.verbWeb", live: "tools.verbWebLive" },
	task: { icon: Bot, done: "tools.verbTask", live: "tools.verbTaskLive" },
	todo: { icon: ListChecks, done: "tools.verbTodo", live: "tools.verbTodoLive" },
	"tool-search": { icon: PackageSearch, done: "tools.verbToolSearch", live: "tools.verbToolSearchLive" },
};

/** A call that has not produced its result yet; only a streaming session reports these. */
export function isLiveToolStatus(status: DesktopToolCall["status"]): boolean {
	return status === "preparing" || status === "waiting" || status === "running";
}

/** The summary verb: present tense while the call is live, past tense once it has a result. */
export function toolVerb(tool: DesktopToolCall, toolName: string | undefined): string {
	if (tool.family === "other") return toolName || t("support.toolFallback");
	const family = FAMILIES[tool.family];
	return t(isLiveToolStatus(tool.status) ? family.live : family.done);
}

const plural = (count: number, one: MessageKey, many: MessageKey) => (count === 1 ? t(one) : t(many, { count }));

/** Small result facts. A fact the tool did not report is omitted, never shown as zero. */
function ToolFacts({ tool }: { tool: DesktopToolCall }) {
	const stats = tool.stats;
	if (!stats) return null;
	const facts: ReactNode[] = [];
	if (tool.family === "write") {
		if (stats.added !== undefined) facts.push(plural(stats.added, "tools.factLinesOne", "tools.factLines"));
	} else if (stats.added !== undefined || stats.removed !== undefined) {
		facts.push(
			<span key="diff" title={t("tools.factDiff", { added: stats.added ?? 0, removed: stats.removed ?? 0 })}>
				<span className="tool-fact-added">+{stats.added ?? 0}</span>{" "}
				<span className="tool-fact-removed">−{stats.removed ?? 0}</span>
			</span>,
		);
	}
	if (stats.matches !== undefined) facts.push(plural(stats.matches, "tools.factMatchesOne", "tools.factMatches"));
	if (stats.files !== undefined) facts.push(plural(stats.files, "tools.factFilesOne", "tools.factFiles"));
	if (stats.tasks !== undefined) facts.push(plural(stats.tasks, "tools.factTasksOne", "tools.factTasks"));
	if (stats.exitCode !== undefined) facts.push(t("tools.factExit", { code: stats.exitCode }));
	if (stats.activated?.length)
		facts.push(
			<span key="activated" title={t("tools.factActivatedNames", { names: stats.activated.join(", ") })}>
				{t("tools.factActivated", { count: stats.activated.length })}
			</span>,
		);
	if (facts.length === 0) return null;
	return (
		<span className="tool-call-facts">
			{facts.map((fact, index) => (
				<span key={index}>
					{index > 0 && " · "}
					{fact}
				</span>
			))}
		</span>
	);
}

/**
 * Status text for a call that has not simply finished. A finished call shows none: success is
 * never invented. A live call's present-tense verb already says it runs, so only a raw tool name
 * carries the `Running` text.
 */
function ToolStatus({ tool }: { tool: DesktopToolCall }) {
	switch (tool.status) {
		case "done":
			return null;
		case "failed":
			return (
				<span className="tool-call-status tool-failure">
					<CircleAlert aria-hidden="true" /> {t("support.failed")}
				</span>
			);
		case "cancelled":
			return (
				<span className="tool-call-status tool-call-cancelled">
					<CircleSlash aria-hidden="true" /> {t("support.cancelled")}
				</span>
			);
		case "background":
			return (
				<span className="tool-call-status tool-call-background">
					<Hourglass aria-hidden="true" /> {t("tools.statusBackground")}
				</span>
			);
		case "running":
			return (
				<span className="tool-call-status tool-call-running">
					<LoaderCircle aria-hidden="true" />
					{tool.family === "other" && ` ${t("tools.statusRunning")}`}
				</span>
			);
		default:
			return (
				<span className="tool-call-status tool-call-waiting">
					<Clock aria-hidden="true" />{" "}
					{t(tool.status === "preparing" ? "tools.statusPreparing" : "tools.statusWaiting")}
				</span>
			);
	}
}

/** One call on one line: family icon, verb, monospace subject (full text on hover), facts, status. */
export function ToolCallLine({ tool, toolName }: { tool: DesktopToolCall; toolName?: string }) {
	const Icon = tool.family === "other" ? Wrench : FAMILIES[tool.family].icon;
	return (
		<span className="tool-call-line">
			<Icon className="tool-call-icon" aria-hidden="true" />
			<span className={`tool-call-verb${tool.family === "other" ? " tool-name" : ""}`}>
				{toolVerb(tool, toolName)}
			</span>
			{/* Literal spaces keep the parts apart in accessible text; flex layout ignores them. */}{" "}
			{tool.subject && (
				<code className="tool-call-subject" title={tool.subject}>
					{tool.subject}
				</code>
			)}{" "}
			<span className="tool-call-meta">
				<ToolFacts tool={tool} /> <ToolStatus tool={tool} />
			</span>
		</span>
	);
}

/** Where an expanded card loads `tool.detail`. */
export interface ToolDetailSource {
	load(callId: string): Promise<DesktopToolDetail>;
	/** The conversation's project directory: diff headers name files inside it relative to it. */
	directory?: string;
}

/**
 * The detail loader for cards below it. A transcript entry provides one for its conversation
 * while connected; without one (the showcase, static renders, a closed connection) an expandable
 * card says its details are unavailable.
 */
export const ToolDetailContext = createContext<ToolDetailSource | null>(null);

/** What the expanded body shows above the output. */
export type ToolDetailState =
	| { kind: "unavailable" }
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "ready"; detail: DesktopToolDetail };

/** One diff line: the SDK writes `+12|text`, `-3|text` or ` 4|text`; anything else is shown as is. */
function DiffLine({ line }: { line: string }) {
	const kind = line.startsWith("+")
		? "tool-diff-add"
		: line.startsWith("-")
			? "tool-diff-remove"
			: line.startsWith("@@")
				? "tool-diff-hunk"
				: "tool-diff-context";
	const numbered = /^([+\- ])(\d+)\|(.*)$/s.exec(line);
	return (
		<span className={`tool-diff-line ${kind}`}>
			{numbered ? (
				<>
					<span className="tool-diff-number" aria-hidden="true">
						{numbered[2]}
					</span>
					<span className="tool-diff-sign">{numbered[1]}</span>
					{numbered[3]}
				</>
			) : (
				line
			)}
		</span>
	);
}

/**
 * `path` relative to `directory` when the path lies inside it, otherwise unchanged. Both arrive
 * already redacted by the Host; only a whole leading directory is removed, on a separator
 * boundary, so a sibling such as `/work/app2` is never shortened against `/work/app`.
 */
export function projectRelativePath(path: string, directory: string | undefined): string {
	const base = directory?.replace(/[\\/]+$/, "");
	if (!base || path.length <= base.length + 1 || !path.startsWith(base)) return path;
	const separator = path[base.length];
	return separator === "/" || separator === "\\" ? path.slice(base.length + 1) : path;
}

/** A diff header's file name: relative inside the project, with the full path on hover. */
function FilePath({ path, directory }: { path: string; directory: string | undefined }) {
	const shown = projectRelativePath(path, directory);
	return (
		<code className="tool-diff-path" title={shown === path ? undefined : path}>
			{shown}
		</code>
	);
}

/** Per-file diffs of an edit, or the content a write left in its file. */
function ToolDiffs({ diffs, written }: { diffs: DesktopToolDiff[]; written: boolean }) {
	const directory = useContext(ToolDetailContext)?.directory;
	return (
		<div className="tool-detail-section">
			<span className="tool-detail-heading">{t(written ? "tools.detailWritten" : "tools.detailChanges")}</span>
			{diffs.map((file, index) => (
				<div className="tool-diff-file" key={index}>
					<div className="tool-diff-header">
						<FilePath path={file.path} directory={directory} />
						{file.op === "create" && <span className="tool-diff-op">{t("tools.diffCreated")}</span>}
						{file.op === "delete" && <span className="tool-diff-op">{t("tools.diffDeleted")}</span>}
						{/* Only the counts a file has; a file whose edit failed changed nothing. */}
						{!written && !file.error && (file.added > 0 || file.removed > 0) && (
							<span
								className="tool-call-facts"
								title={t("tools.factDiff", { added: file.added, removed: file.removed })}
							>
								{file.added > 0 && <span className="tool-fact-added">+{file.added}</span>}
								{file.added > 0 && file.removed > 0 && " "}
								{file.removed > 0 && <span className="tool-fact-removed">−{file.removed}</span>}
							</span>
						)}
					</div>
					{file.error && <p className="tool-diff-error">{file.error}</p>}
					{file.diff ? (
						<pre className="tool-diff">
							{file.diff.split("\n").map((line, line_index) => (
								<DiffLine key={line_index} line={line} />
							))}
						</pre>
					) : (
						!file.error && <p className="tool-detail-note">{t("tools.diffEmpty")}</p>
					)}
				</div>
			))}
		</div>
	);
}

/**
 * The part of an expanded card that comes from `tool.detail`: its loading, failure or
 * unavailable state, else the full command, per-file diffs and remaining arguments. Task-list and
 * tool-search sections belong to their family bodies.
 */
export function ToolCallDetails({ family, state }: { family: DesktopToolFamily; state: ToolDetailState }) {
	if (state.kind === "unavailable") return <p className="tool-detail-note">{t("tools.detailUnavailable")}</p>;
	if (state.kind === "loading")
		return (
			<p className="tool-detail-note" role="status">
				{t("tools.detailLoading")}
			</p>
		);
	if (state.kind === "error")
		return (
			<div className="error-banner tool-detail-error" role="alert">
				<CircleAlert aria-hidden="true" />
				<div className="error-content">{t("tools.detailFailed", { reason: state.message })}</div>
			</div>
		);
	const { detail } = state;
	return (
		<>
			{detail.truncated && <small className="truncation-notice">{t("tools.detailTruncated")}</small>}
			{detail.command !== undefined && (
				<div className="tool-detail-section">
					<span className="tool-detail-heading">{t("tools.detailCommand")}</span>
					<pre className="bounded-output tool-detail-code">{detail.command}</pre>
				</div>
			)}
			{detail.diff && detail.diff.length > 0 && <ToolDiffs diffs={detail.diff} written={family === "write"} />}
			{detail.args !== undefined && (
				<div className="tool-detail-section">
					<span className="tool-detail-heading">{t("tools.detailArguments")}</span>
					<pre className="bounded-output tool-detail-code">{detail.args}</pre>
				</div>
			)}
		</>
	);
}

function ToolOutput({ message }: { message: DesktopMessage }) {
	const blocks = message.blocks;
	const hasContent = blocks
		? blocks.some(block => block.type === "image" || block.type === "image-unavailable" || !!block.text.trim())
		: !!message.text.trim();
	return (
		<div className="tool-output">
			{hasContent ? (
				blocks ? (
					<MessageBlocks blocks={blocks} tool />
				) : (
					<pre className="bounded-output">{message.text}</pre>
				)
			) : (
				<pre className="bounded-output">{t("support.noOutput")}</pre>
			)}
		</div>
	);
}

function LegacyToolRow({ message }: { message: DesktopMessage }) {
	return (
		<article className={`message ${message.role} ${message.isError ? "message-error" : ""}`}>
			<strong className="role-label">{t("support.roleTool")}</strong>
			{message.truncated && <small className="truncation-notice">{t("support.truncated")}</small>}
			<details className="tool-disclosure">
				<summary>
					<ChevronRight className="disclosure-chevron" aria-hidden="true" />
					<span className="tool-name">{message.toolName || t("support.toolFallback")}</span>
					{message.excludeFromContext && <small> · {t("support.excludedFromContext")}</small>}
					{message.cancelled ? (
						<small> · {t("support.cancelled")}</small>
					) : (
						message.isError && (
							<span className="tool-failure">
								<CircleAlert aria-hidden="true" /> · {t("support.failed")}
							</span>
						)
					)}
				</summary>
				<ToolOutput message={message} />
			</details>
		</article>
	);
}

/**
 * Loads `tool.detail` the first time the card is open, and again when the call's status changes
 * while it is open (a running call's diff exists only once it settles). A failed load retries
 * on the next open.
 */
function useToolDetail(tool: DesktopToolCall, open: boolean): ToolDetailState | undefined {
	const source = useContext(ToolDetailContext);
	const [state, setState] = useState<ToolDetailState | undefined>();
	const loaded = useRef<{ source: ToolDetailSource; callId: string; status: string } | null>(null);
	const request = useRef(0);
	// A flag, not a request bump: a development StrictMode remount must keep the first load.
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	useEffect(() => {
		if (!open || !tool.detail || !source) return;
		const previous = loaded.current;
		if (previous?.source === source && previous.callId === tool.callId && previous.status === tool.status) return;
		loaded.current = { source, callId: tool.callId, status: tool.status };
		const id = ++request.current;
		setState(current => (current?.kind === "ready" ? current : { kind: "loading" }));
		source.load(tool.callId).then(
			detail => {
				if (alive.current && request.current === id) setState({ kind: "ready", detail });
			},
			(error: unknown) => {
				if (!alive.current || request.current !== id) return;
				loaded.current = null;
				setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
			},
		);
	}, [open, source, tool.callId, tool.detail, tool.status]);
	if (!tool.detail) return undefined;
	if (!source) return { kind: "unavailable" };
	return state ?? { kind: "loading" };
}

function ToolCallRow({
	message,
	tool,
	defaultOpen,
}: {
	message: DesktopMessage;
	tool: DesktopToolCall;
	defaultOpen: boolean;
}) {
	const [open, setOpen] = useState(defaultOpen);
	const state = useToolDetail(tool, open);
	const Body = tool.family === "todo" ? TodoToolBody : tool.family === "tool-search" ? ToolSearchBody : undefined;
	const output = <ToolOutput message={message} />;
	const detail = state?.kind === "ready" ? state.detail : undefined;
	// A stopped call reaches the Host as an errored result, but cancelling is not a failure.
	const failed = message.isError === true && tool.status !== "cancelled";
	return (
		<article
			className={`message ${message.role} tool-call${failed ? " message-error" : ""}`}
			data-tool-family={tool.family}
			data-tool-status={tool.status}
		>
			<strong className="role-label">{t("support.roleTool")}</strong>
			{message.truncated && <small className="truncation-notice">{t("support.truncated")}</small>}
			<details
				className="tool-disclosure"
				open={defaultOpen || undefined}
				onToggle={event => setOpen(event.currentTarget.open)}
			>
				<summary>
					<ChevronRight className="disclosure-chevron" aria-hidden="true" />
					<span className="tool-call-head">
						<ToolCallLine tool={tool} toolName={message.toolName} />{" "}
						{tool.intent && <span className="tool-call-intent">{tool.intent}</span>}
					</span>
				</summary>
				{/* Nothing is requested or rendered for a closed card. */}
				{open && state && (
					<div className="tool-call-details">
						<ToolCallDetails family={tool.family} state={state} />
					</div>
				)}
				{state && open && Body === undefined && (
					<span className="tool-detail-heading tool-output-heading">{t("tools.detailOutput")}</span>
				)}
				{Body ? <Body message={message} detail={detail} output={output} /> : output}
			</details>
		</article>
	);
}

/**
 * One `role: "tool"` transcript row: a native disclosure whose summary names the call and its
 * state and whose body loads the call's details on first expand above the bounded output.
 * `todo` and `tool-search` calls get their own body. A row without call metadata (older history,
 * managed sessions) keeps the plain tool-name row. `defaultOpen` is for design examples.
 */
export function ToolCallCard({ message, defaultOpen = false }: { message: DesktopMessage; defaultOpen?: boolean }) {
	return message.tool ? (
		<ToolCallRow message={message} tool={message.tool} defaultOpen={defaultOpen} />
	) : (
		<LegacyToolRow message={message} />
	);
}

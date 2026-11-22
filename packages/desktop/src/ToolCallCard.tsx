import type { DesktopMessage } from "@gajae-code/desktop-host/protocol";
import type { DesktopToolCall, DesktopToolDetail, DesktopToolFamily } from "@gajae-code/desktop-host/tool-protocol";
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
import type { ReactNode } from "react";
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

/**
 * One `role: "tool"` transcript row: a native disclosure whose summary names the tool and its
 * state and whose body is the bounded output. `todo` and `tool-search` calls get their own body.
 * A row without call metadata (older history, managed sessions) keeps the plain tool-name row.
 */
export function ToolCallCard({ message }: { message: DesktopMessage }) {
	const blocks = message.blocks;
	const hasContent = blocks
		? blocks.some(block => block.type === "image" || block.type === "image-unavailable" || !!block.text.trim())
		: !!message.text.trim();
	const output = (
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
	const tool = message.tool;
	if (!tool)
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
					{output}
				</details>
			</article>
		);
	const Body = tool.family === "todo" ? TodoToolBody : tool.family === "tool-search" ? ToolSearchBody : undefined;
	return (
		<article
			className={`message ${message.role} tool-call${message.isError ? " message-error" : ""}`}
			data-tool-family={tool.family}
			data-tool-status={tool.status}
		>
			<strong className="role-label">{t("support.roleTool")}</strong>
			{message.truncated && <small className="truncation-notice">{t("support.truncated")}</small>}
			<details className="tool-disclosure">
				<summary>
					<ChevronRight className="disclosure-chevron" aria-hidden="true" />
					<span className="tool-call-head">
						<ToolCallLine tool={tool} toolName={message.toolName} />{" "}
						{tool.intent && <span className="tool-call-intent">{tool.intent}</span>}
					</span>
				</summary>
				{Body ? <Body message={message} output={output} /> : output}
			</details>
		</article>
	);
}

import type { DesktopMessage, DesktopSession } from "@gajae-code/desktop-host/protocol";
import type { DesktopToolDetail, DesktopToolFamily } from "@gajae-code/desktop-host/tool-protocol";
import { ChevronRight, CircleAlert } from "lucide-react";
import { Fragment, type ReactNode, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { request } from "./bridge";
import { type MessageKey, t } from "./i18n";
import { ToolCallLine, ToolDetailContext, type ToolDetailSource } from "./ToolCallCard";

/** One rendered transcript entry. */
export interface TranscriptItem {
	/**
	 * Stable identity for the React key and the `data-transcript-message` scroll anchor: the key
	 * of the entry's first message, which is `tool:<callId>` for a call whose id is unique in the
	 * transcript, otherwise the message id. A tool run keeps the key it was first shown with while
	 * any of its members is still in the window (see `TranscriptRuns`).
	 */
	key: string;
	/** The entry's messages in transcript order. */
	messages: DesktopMessage[];
	/** The same key rule per message, aligned with `messages`; a call keeps its key from running to settled. */
	memberKeys: string[];
	/**
	 * True for a run of tool calls: consecutive rows with call metadata plus the reasoning-only
	 * assistant rows between them. A run of one call renders through the same tree as a group, so
	 * a second call joining it never remounts the first card.
	 */
	tools: boolean;
}

function transcriptKeys(messages: readonly DesktopMessage[]): string[] {
	const calls = new Map<string, number>();
	for (const message of messages) {
		const callId = message.tool?.callId;
		if (callId) calls.set(callId, (calls.get(callId) ?? 0) + 1);
	}
	return messages.map(message => {
		const callId = message.tool?.callId;
		return callId && calls.get(callId) === 1 ? `tool:${callId}` : message.id;
	});
}

/** Only rows with call metadata group; a user-typed `!` shell row or an older row never does. */
const groupable = (message: DesktopMessage) => message.role === "tool" && message.tool !== undefined;

/** An assistant row that shows nothing but reasoning, as between two calls of one turn. */
function reasoningOnly(message: DesktopMessage): boolean {
	if (message.role !== "assistant" || message.text.trim() || !message.blocks?.length) return false;
	return (
		message.blocks.every(block => block.type === "thinking" || (block.type === "text" && !block.text.trim())) &&
		message.blocks.some(block => block.type === "thinking" && !!block.text.trim())
	);
}

/**
 * The tool runs one conversation view has shown, by member key. The Host sends only its newest
 * rows, so once a run is longer than that window its first call leaves on every new call, and a
 * key taken from the first member would remount the group (losing its open state, expanded cards
 * and loaded details). A run that still holds a member of a remembered run keeps that run's key
 * instead. Only the latest grouping is remembered, so the memory stays the window's size.
 */
export class TranscriptRuns {
	#keys = new Map<string, string>();
	/** The run key a member belonged to in the latest grouping. */
	get(memberKey: string): string | undefined {
		return this.#keys.get(memberKey);
	}
	/** Replace the memory with this grouping's runs. */
	remember(spans: readonly Span[], keys: readonly string[]): void {
		const next = new Map<string, string>();
		for (const span of spans)
			if (span.tools) for (let i = span.start; i <= span.end; i++) next.set(keys[i]!, span.key);
		this.#keys = next;
	}
}

interface Span {
	start: number;
	end: number;
	key: string;
	tools: boolean;
}

/**
 * Entries over the whole list. A run takes the remembered key of its earliest member that has
 * one, unless an earlier entry already took it or it is another entry's own key, so keys stay
 * unique when a run splits or the list is rearranged; otherwise it takes its first member's key.
 */
function spans(messages: readonly DesktopMessage[], keys: readonly string[], runs?: TranscriptRuns): Span[] {
	const result: Span[] = [];
	for (let start = 0; start < messages.length; ) {
		let end = start;
		const tools = groupable(messages[start]!);
		if (tools) {
			for (let next = start + 1; next < messages.length; next++) {
				if (groupable(messages[next]!)) end = next;
				else if (!reasoningOnly(messages[next]!)) break;
			}
		}
		result.push({ start, end, key: keys[start]!, tools });
		start = end + 1;
	}
	if (!runs) return result;
	const own = new Set(result.map(span => span.key));
	const taken = new Set<string>();
	for (const span of result) {
		if (span.tools)
			for (let i = span.start; i <= span.end; i++) {
				const remembered = runs.get(keys[i]!);
				if (remembered && !taken.has(remembered) && (remembered === span.key || !own.has(remembered))) {
					span.key = remembered;
					break;
				}
			}
		taken.add(span.key);
	}
	return result;
}

/**
 * Entries for the newest `limit` messages. Entries and keys are computed over the whole
 * transcript, so an entry's key never depends on how much history is rendered; a tool run that
 * starts before the cut is included whole, which keeps its key and its first message together.
 * With the conversation's `runs`, a run keeps its key as the Host's window slides, and the
 * grouping is remembered for the next call; calling it again with the same messages gives the
 * same keys, so a repeated render is harmless.
 */
export function groupTranscript(
	messages: readonly DesktopMessage[],
	limit: number,
	runs?: TranscriptRuns,
): TranscriptItem[] {
	const keys = transcriptKeys(messages);
	const all = spans(messages, keys, runs);
	runs?.remember(all, keys);
	const cut = messages.length - Math.min(messages.length, Math.max(0, limit));
	return all
		.filter(span => span.end >= cut)
		.map(span => ({
			key: span.key,
			messages: messages.slice(span.start, span.end + 1),
			memberKeys: keys.slice(span.start, span.end + 1),
			tools: span.tools,
		}));
}

/**
 * Index in `messages` of the first message of the entry whose key is `key`, or -1. Pass the same
 * `runs` as `groupTranscript`, so a run's remembered key resolves to its current first message.
 */
export function transcriptAnchorIndex(messages: readonly DesktopMessage[], key: string, runs?: TranscriptRuns): number {
	const keys = transcriptKeys(messages);
	return spans(messages, keys, runs).find(span => span.key === key)?.start ?? keys.indexOf(key);
}

/** Conversation views whose run memory is kept; an older one starts again from first members. */
const RUN_MEMORY_LIMIT = 32;

/**
 * The run memory for one conversation view, by conversation and control generation. A new
 * generation remounts the transcript anyway, so it starts with an empty memory.
 */
export function useTranscriptRuns(sessionId: string, generation: number | null): TranscriptRuns {
	const views = useRef(new Map<string, TranscriptRuns>());
	const id = `${sessionId}:${generation}`;
	const runs = views.current.get(id) ?? new TranscriptRuns();
	views.current.delete(id);
	views.current.set(id, runs);
	for (const oldest of views.current.keys()) {
		if (views.current.size <= RUN_MEMORY_LIMIT) break;
		views.current.delete(oldest);
	}
	return runs;
}

const KINDS: Record<DesktopToolFamily, { one: MessageKey; many: MessageKey }> = {
	read: { one: "tools.groupReadOne", many: "tools.groupRead" },
	write: { one: "tools.groupWriteOne", many: "tools.groupWrite" },
	edit: { one: "tools.groupEditOne", many: "tools.groupEdit" },
	search: { one: "tools.groupSearchOne", many: "tools.groupSearch" },
	find: { one: "tools.groupFindOne", many: "tools.groupFind" },
	shell: { one: "tools.groupShellOne", many: "tools.groupShell" },
	web: { one: "tools.groupWebOne", many: "tools.groupWeb" },
	task: { one: "tools.groupTaskOne", many: "tools.groupTask" },
	todo: { one: "tools.groupTodoOne", many: "tools.groupTodo" },
	"tool-search": { one: "tools.groupToolSearchOne", many: "tools.groupToolSearch" },
	other: { one: "tools.groupOtherOne", many: "tools.groupOther" },
};

/** "3 reads, 2 commands": call counts per family, in order of first appearance. */
export function toolRunKinds(calls: readonly DesktopMessage[]): string {
	const counts = new Map<DesktopToolFamily, number>();
	for (const call of calls) if (call.tool) counts.set(call.tool.family, (counts.get(call.tool.family) ?? 0) + 1);
	return [...counts]
		.map(([family, count]) => (count === 1 ? t(KINDS[family].one) : t(KINDS[family].many, { count })))
		.join(t("tools.groupKindSeparator"));
}

export interface ToolRunProps {
	item: TranscriptItem;
	renderMessage: (message: DesktopMessage) => ReactNode;
	/** Design examples only: the group starts expanded. */
	initialOpen?: boolean;
}

/**
 * A run of tool calls. Two or more calls fold behind one collapsed summary that counts them,
 * names their kinds and failures, and always shows the newest call's line. The group opens or
 * closes only when the reader asks, except that a single card the reader had expanded stays
 * visible when a second call joins it.
 */
export function ToolRun({ item, renderMessage, initialOpen = false }: ToolRunProps) {
	const calls = item.messages.filter(message => message.tool);
	const grouped = calls.length >= 2;
	const [open, setOpen] = useState(initialOpen);
	const root = useRef<HTMLDivElement>(null);
	const wasGrouped = useRef(grouped);
	const itemsId = useId();
	useLayoutEffect(() => {
		if (grouped && !wasGrouped.current && root.current?.querySelector("details[open]")) setOpen(true);
		wasGrouped.current = grouped;
	}, [grouped]);
	const newest = calls[calls.length - 1];
	const failed = calls.filter(call => call.tool?.status === "failed").length;
	// Child positions stay fixed (null holes for a single call), so cards keep their state.
	return (
		<div ref={root} className={`message tool-run${grouped ? " tool-group" : ""}`} data-tool-count={calls.length}>
			{grouped ? <strong className="role-label">{t("support.roleTool")}</strong> : null}
			{grouped && newest?.tool ? (
				<button
					type="button"
					className="tool-group-summary"
					aria-expanded={open}
					aria-controls={itemsId}
					onClick={() => setOpen(value => !value)}
				>
					<ChevronRight className="disclosure-chevron" data-open={open || undefined} aria-hidden="true" />
					<span className="tool-group-head">
						<span className="tool-group-title">
							<span className="tool-group-count">{t("tools.groupCount", { count: calls.length })}</span>{" "}
							<span className="tool-group-kinds">· {toolRunKinds(calls)}</span>
							{failed > 0 && (
								<>
									{" "}
									<span className="tool-group-failed">
										<CircleAlert aria-hidden="true" /> {t("tools.groupFailed", { count: failed })}
									</span>
								</>
							)}
						</span>{" "}
						<span className="tool-group-latest">
							<ToolCallLine tool={newest.tool} toolName={newest.toolName} />
						</span>
					</span>
				</button>
			) : null}
			<div className="tool-run-items" id={itemsId} hidden={grouped && !open}>
				{item.messages.map((message, index) => (
					<Fragment key={item.memberKeys[index] ?? message.id}>{renderMessage(message)}</Fragment>
				))}
			</div>
		</div>
	);
}

export interface TranscriptEntryProps {
	item: TranscriptItem;
	/** The conversation the entry belongs to. */
	session: DesktopSession;
	/** The conversation's project directory, for project-relative file paths in tool details. */
	directory?: string;
	connected: boolean;
	renderMessage: (message: DesktopMessage) => ReactNode;
}

/** `tool.detail` for one conversation, checked to be a detail for the requested call. */
function toolDetailSource(sessionId: string, directory: string | undefined): ToolDetailSource {
	return {
		...(directory ? { directory } : {}),
		async load(callId) {
			const value = await request<unknown>("tool.detail", { sessionId, callId });
			if (!value || typeof value !== "object" || (value as { callId?: unknown }).callId !== callId)
				throw new Error(t("tools.detailInvalid"));
			return value as DesktopToolDetail;
		},
	};
}

/**
 * Renders one entry with its conversation's detail loader: a tool run through `ToolRun`, any
 * other entry message by message through `renderMessage`.
 */
export function TranscriptEntry({ item, session, directory, connected, renderMessage }: TranscriptEntryProps) {
	const source = useMemo(
		() => (connected ? toolDetailSource(session.id, directory) : null),
		[connected, session.id, directory],
	);
	return (
		<ToolDetailContext.Provider value={source}>
			{item.tools ? (
				<ToolRun item={item} renderMessage={renderMessage} />
			) : (
				item.messages.map((message, index) => (
					<Fragment key={item.memberKeys[index] ?? message.id}>{renderMessage(message)}</Fragment>
				))
			)}
		</ToolDetailContext.Provider>
	);
}

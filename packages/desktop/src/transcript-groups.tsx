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
	 * transcript, otherwise the message id.
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
 * Entries for the newest `limit` messages. Entries and keys are computed over the whole
 * transcript, so an entry's key never depends on how much history is rendered; a tool run that
 * starts before the cut is included whole, which keeps its key and its first message together.
 */
export function groupTranscript(messages: readonly DesktopMessage[], limit: number): TranscriptItem[] {
	const keys = transcriptKeys(messages);
	const cut = messages.length - Math.min(messages.length, Math.max(0, limit));
	const items: TranscriptItem[] = [];
	for (let start = 0; start < messages.length; ) {
		let end = start;
		if (groupable(messages[start]!)) {
			for (let next = start + 1; next < messages.length; next++) {
				if (groupable(messages[next]!)) end = next;
				else if (!reasoningOnly(messages[next]!)) break;
			}
		}
		if (end >= cut)
			items.push({
				key: keys[start]!,
				messages: messages.slice(start, end + 1),
				memberKeys: keys.slice(start, end + 1),
				tools: groupable(messages[start]!),
			});
		start = end + 1;
	}
	return items;
}

/** Index in `messages` of the first message of the entry whose key is `key`, or -1. */
export function transcriptAnchorIndex(messages: readonly DesktopMessage[], key: string): number {
	return transcriptKeys(messages).indexOf(key);
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
	connected: boolean;
	renderMessage: (message: DesktopMessage) => ReactNode;
}

/** `tool.detail` for one conversation, checked to be a detail for the requested call. */
function toolDetailSource(sessionId: string): ToolDetailSource {
	return {
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
export function TranscriptEntry({ item, session, connected, renderMessage }: TranscriptEntryProps) {
	const source = useMemo(() => (connected ? toolDetailSource(session.id) : null), [connected, session.id]);
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

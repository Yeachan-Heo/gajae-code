import type { DesktopMessage, DesktopSession } from "@gajae-code/desktop-host/protocol";
import type { DesktopToolInfo, DesktopToolOrigin } from "@gajae-code/desktop-host/tool-protocol";
import { Search } from "lucide-react";
import type { KeyboardEvent, RefObject } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { request } from "./bridge";
import { Button, ErrorBanner, Modal } from "./components";
import { t } from "./i18n";

/** A validated `tools.list` answer: one entry per name `tools.set` accepts, in SDK order. */
export interface ToolCatalog {
	tools: DesktopToolInfo[];
	/** Names active for the model, in SDK order; `tools[].active` mirrors it. */
	active: string[];
	/** Absent from a Host that does not project the catalog. */
	discovery?: { enabled: boolean };
}

const ORIGINS: readonly DesktopToolOrigin[] = ["essential", "discoverable", "other"];
const UNSETTLED = new Set(["preparing", "waiting", "running"]);

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isToolInfo(value: unknown): value is DesktopToolInfo {
	if (!value || typeof value !== "object") return false;
	const tool = value as Record<string, unknown>;
	return (
		typeof tool.name === "string" &&
		typeof tool.label === "string" &&
		(tool.description === undefined || typeof tool.description === "string") &&
		typeof tool.active === "boolean" &&
		ORIGINS.some(origin => origin === tool.origin) &&
		typeof tool.discovered === "boolean" &&
		(tool.hidden === undefined || typeof tool.hidden === "boolean") &&
		(tool.mcpServer === undefined || typeof tool.mcpServer === "string")
	);
}

/**
 * Validates a `tools.list` answer. Every `available` name gets an entry, so a list the Host cut
 * to its catalog bound, or an older Host's names-only answer, still lists every tool; activity
 * always comes from `active`. Returns null for a malformed answer.
 */
export function parseToolList(value: unknown): ToolCatalog | null {
	if (!value || typeof value !== "object") return null;
	const list = value as Record<string, unknown>;
	if (!isStringArray(list.available) || !isStringArray(list.active)) return null;
	if (list.tools !== undefined && (!Array.isArray(list.tools) || !list.tools.every(isToolInfo))) return null;
	const discovery = list.discovery;
	if (
		discovery !== undefined &&
		(!discovery || typeof discovery !== "object" || typeof (discovery as { enabled?: unknown }).enabled !== "boolean")
	)
		return null;
	const described = new Map((list.tools ?? []).map(tool => [tool.name, tool]));
	const active = new Set(list.active);
	const tools = [...new Set(list.available)].map(
		(name): DesktopToolInfo => ({
			...(described.get(name) ?? { name, label: name, origin: "other", discovered: false }),
			active: active.has(name),
		}),
	);
	return {
		tools,
		active: list.active,
		...(discovery ? { discovery: { enabled: (discovery as { enabled: boolean }).enabled } } : {}),
	};
}

/** Case-insensitive, width-insensitive form used by the search field and the text it searches. */
export function normalizeToolSearch(text: string): string {
	return text.normalize("NFKC").toLowerCase();
}

/** Tools whose name, label or description contains every whitespace-separated query term. */
export function filterToolCatalog(tools: DesktopToolInfo[], query: string): DesktopToolInfo[] {
	const terms = normalizeToolSearch(query).trim().split(/\s+/u).filter(Boolean);
	if (terms.length === 0) return tools;
	return tools.filter(tool => {
		const text = normalizeToolSearch(`${tool.name} ${tool.label} ${tool.description ?? ""}`);
		return terms.every(term => text.includes(term));
	});
}

/**
 * True when the Host refused `tools.list` because this conversation's SDK owner is another
 * process. The Host's refusal text is the only signal it sends (`#dispatchManaged` in
 * desktop-host `host.ts`), so this match is the one place that depends on it.
 */
export function isToolCatalogUnsupported(message: string): boolean {
	return message.includes("does not support desktop tools.list");
}

/** Ids of settled tool-search results in a transcript; a running or synthesized call row is not one yet. */
export function toolSearchResultIds(messages: DesktopMessage[]): string[] {
	return messages
		.filter(
			message =>
				message.role === "tool" &&
				(message.tool?.family === "tool-search" || message.toolName === "search_tool_bm25") &&
				!(message.tool && UNSETTLED.has(message.tool.status)),
		)
		.map(message => message.id);
}

/**
 * Names to send with `tools.set`: the catalog's active set in SDK order with the edits applied.
 * Save passes a catalog read just before it, so a tool that became active while the dialog was
 * open (an MCP reconnect, a tool search) stays on unless the user turned it off.
 */
export function editedToolNames(catalog: ToolCatalog, edits: ReadonlyMap<string, boolean>): string[] {
	const active = new Set(catalog.active);
	return [
		...catalog.active.filter(name => edits.get(name) !== false),
		...catalog.tools.filter(tool => !active.has(tool.name) && edits.get(tool.name) === true).map(tool => tool.name),
	];
}

function byName(left: DesktopToolInfo, right: DesktopToolInfo): number {
	return left.name.localeCompare(right.name);
}

function ToolTags({ tool, id }: { tool: DesktopToolInfo; id: string }) {
	const tags: Array<{ kind: string; text: string }> = [];
	if (tool.origin === "essential") tags.push({ kind: "essential", text: t("catalog.tagEssential") });
	if (tool.discovered) tags.push({ kind: "found", text: t("catalog.tagFound") });
	else if (tool.hidden) tags.push({ kind: "hidden", text: t("catalog.tagHidden") });
	if (tool.mcpServer) tags.push({ kind: "mcp", text: t("catalog.tagMcp", { server: tool.mcpServer }) });
	if (tags.length === 0) return null;
	return (
		<span className="tool-catalog-tags" id={id}>
			{tags.map(tag => (
				<span className={`tool-catalog-tag tool-catalog-tag-${tag.kind}`} key={tag.kind}>
					{tag.text}
				</span>
			))}
		</span>
	);
}

/** Moves focus between the list's checkboxes like the model picker moves between its rows. */
function navigateRows(event: KeyboardEvent<HTMLDivElement>) {
	if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
	const boxes = [...event.currentTarget.querySelectorAll<HTMLInputElement>("input[type=checkbox]:not(:disabled)")];
	const active = document.activeElement;
	const index = active instanceof HTMLInputElement ? boxes.indexOf(active) : -1;
	if (index < 0) return;
	event.preventDefault();
	const next =
		event.key === "Home"
			? 0
			: event.key === "End"
				? boxes.length - 1
				: Math.max(0, Math.min(boxes.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
	boxes[next]?.focus();
}

export interface ToolCatalogPanelProps {
	/** The last good read; null until the first one lands. */
	catalog: ToolCatalog | null;
	/** A `tools.list` read is in flight. */
	reading: boolean;
	/** A `tools.set` save is in flight. */
	saving: boolean;
	/** The Host cannot list tools for this conversation. */
	unavailable?: boolean;
	/** The last read or save failure. */
	error?: string;
	/** Offer the retry action beside `error`: a read failed. */
	onRetry?: () => void;
	notice?: string;
	query: string;
	onQueryChange(query: string): void;
	/** Checked state the user changed and has not saved, by tool name. */
	edits: ReadonlyMap<string, boolean>;
	onToggle(name: string, checked: boolean): void;
	/** Why Save is unavailable even with edits: a turn owns the conversation, or the connection is down. */
	saveBlocked?: "running" | "disconnected";
	onSave(): void;
	/** A tool search changed the tools while edits were unsaved: Save waits for a reload, which keeps the edits. */
	searchChanged?: boolean;
	onReload?: () => void;
	searchRef?: RefObject<HTMLInputElement | null>;
}

/**
 * The Tools dialog body: search, counts, Active and Available sections and the Save footer. It
 * owns no requests, so the showcase renders every state of it directly. Rows stay in the section
 * of their saved state, so checking a box never moves the focused row.
 */
export function ToolCatalogPanel({
	catalog,
	reading,
	saving,
	unavailable,
	error,
	onRetry,
	notice,
	query,
	onQueryChange,
	edits,
	onToggle,
	saveBlocked,
	onSave,
	searchChanged,
	onReload,
	searchRef,
}: ToolCatalogPanelProps) {
	const id = useId();
	const root = useRef<HTMLDivElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const focused = useRef<string | null>(null);
	const shown = useRef(catalog);
	// A re-read can move the focused row to the other section, which remounts it, or remove the
	// Reload button that was clicked. Put focus back on that tool, otherwise on the search field.
	useLayoutEffect(() => {
		const replaced = shown.current !== null && shown.current !== catalog;
		shown.current = catalog;
		if (!catalog || !replaced || (document.activeElement && document.activeElement !== document.body)) return;
		const box = [...(list.current?.querySelectorAll<HTMLInputElement>("input[type=checkbox]") ?? [])].find(
			item => item.dataset.toolName === focused.current,
		);
		(box ?? root.current?.querySelector<HTMLInputElement>(".model-search input"))?.focus();
	}, [catalog]);
	if (unavailable)
		return (
			<div className="tool-catalog">
				<div className="empty model-empty tool-catalog-unavailable">{t("catalog.unavailable")}</div>
			</div>
		);
	const dirty = edits.size;
	const tools = catalog?.tools ?? [];
	const matches = filterToolCatalog(tools, query);
	const sections = [
		{ key: "active", title: t("catalog.activeSection"), rows: matches.filter(tool => tool.active).sort(byName) },
		{
			key: "available",
			title: t("catalog.availableSection"),
			rows: matches.filter(tool => !tool.active).sort(byName),
		},
	].filter(section => section.rows.length > 0);
	const activeCount = tools.filter(tool => tool.active).length;
	const reason =
		saveBlocked === "running"
			? t("catalog.saveWhileRunning")
			: saveBlocked === "disconnected"
				? t("catalog.saveDisconnected")
				: "";
	return (
		<div
			className="tool-catalog"
			ref={root}
			onFocus={event => {
				focused.current = event.target instanceof HTMLInputElement ? (event.target.dataset.toolName ?? null) : null;
			}}
		>
			{error && (
				<div className="tool-catalog-failure">
					<ErrorBanner>{error}</ErrorBanner>
					{onRetry && (
						<Button disabled={reading} onClick={onRetry}>
							{t("catalog.retry")}
						</Button>
					)}
				</div>
			)}
			{!catalog ? (
				reading && <p className="tool-catalog-loading">{t("catalog.loading")}</p>
			) : (
				<>
					<div className="tool-catalog-head">
						<label className="model-search">
							<span className="sr-only">{t("catalog.searchLabel")}</span>
							<Search size={16} aria-hidden="true" />
							<input
								ref={searchRef}
								value={query}
								// An empty registry has nothing to search.
								disabled={tools.length === 0}
								placeholder={t("catalog.searchPlaceholder")}
								onChange={event => onQueryChange(event.target.value)}
								onKeyDown={event => {
									if (event.key !== "ArrowDown") return;
									event.preventDefault();
									list.current
										?.querySelector<HTMLInputElement>("input[type=checkbox]:not(:disabled)")
										?.focus();
								}}
							/>
						</label>
						<p className="tool-catalog-summary muted">
							{t("catalog.counts", { active: activeCount, available: tools.length - activeCount })}
							{catalog.discovery && tools.length > 0 && (
								<>
									{" · "}
									{catalog.discovery.enabled ? t("catalog.discoveryOn") : t("catalog.discoveryOff")}
								</>
							)}
						</p>
					</div>
					{searchChanged && (
						<div className="tool-catalog-changed" role="status">
							<p>{t("catalog.searchChanged")}</p>
							<Button disabled={reading || saving} onClick={onReload}>
								{t("catalog.reload")}
							</Button>
						</div>
					)}
					<div ref={list} className="tool-catalog-list" onKeyDown={navigateRows}>
						{tools.length === 0 ? (
							<p className="empty model-empty">{t("catalog.empty")}</p>
						) : sections.length === 0 ? (
							<p className="empty model-empty">{t("catalog.noMatches", { query: query.trim() })}</p>
						) : (
							sections.map(section => (
								<section
									className="tool-catalog-section"
									key={section.key}
									aria-labelledby={`${id}-${section.key}`}
								>
									<h3 id={`${id}-${section.key}`}>
										{section.title} <span className="tool-catalog-count">{section.rows.length}</span>
									</h3>
									<ul>
										{section.rows.map((tool, index) => {
											const rowId = `${id}-${section.key}-${index}`;
											const checked = edits.get(tool.name) ?? tool.active;
											const showLabel = normalizeToolSearch(tool.label) !== normalizeToolSearch(tool.name);
											const described = [
												tool.description ? `${rowId}-description` : "",
												tool.origin === "essential" || tool.discovered || tool.hidden || tool.mcpServer
													? `${rowId}-tags`
													: "",
											]
												.filter(Boolean)
												.join(" ");
											return (
												<li
													className="tool-catalog-row"
													key={tool.name}
													data-edited={edits.has(tool.name) || undefined}
												>
													<label className="tool-catalog-option">
														<input
															type="checkbox"
															data-tool-name={tool.name}
															checked={checked}
															disabled={saving}
															aria-labelledby={`${rowId}-title`}
															aria-describedby={described || undefined}
															onChange={event => onToggle(tool.name, event.target.checked)}
														/>
														<span className="tool-catalog-main">
															<span className="tool-catalog-title" id={`${rowId}-title`}>
																<code className="tool-catalog-name">{tool.name}</code>
																{showLabel && <span className="tool-catalog-label">{tool.label}</span>}
															</span>
															{tool.description && (
																<span className="tool-catalog-description" id={`${rowId}-description`}>
																	{tool.description}
																</span>
															)}
															<ToolTags tool={tool} id={`${rowId}-tags`} />
														</span>
													</label>
												</li>
											);
										})}
									</ul>
								</section>
							))
						)}
					</div>
				</>
			)}
			{catalog && (
				<footer className="tool-catalog-footer">
					<div className="tool-catalog-status">
						{reason && <p className="tool-catalog-reason">{reason}</p>}
						<p role="status">
							{saving
								? t("catalog.saving")
								: notice ||
									(dirty === 1
										? t("catalog.unsavedOne")
										: dirty > 1
											? t("catalog.unsaved", { count: dirty })
											: "")}
						</p>
					</div>
					<Button
						className="primary"
						disabled={
							!!saveBlocked || saving || reading || dirty === 0 || searchChanged || (!!error && !!onRetry)
						}
						onClick={onSave}
					>
						{t("catalog.save")}
					</Button>
				</footer>
			)}
		</div>
	);
}

/** The request owner of one open dialog; closing the dialog retires it. */
interface ToolsDialogOwner {
	sessionId: string;
	active: boolean;
	busy: boolean;
	/** A read was asked for while a request was in flight; it runs when that one settles. */
	again: boolean;
	/** The last save landed, so the next successful read replaces every edit with the saved state. */
	clearEdits: boolean;
}

export interface ToolCatalogDialogProps {
	/** The conversation whose tools are listed. App mounts one dialog per open. */
	session: DesktopSession;
	connected: boolean;
	onClose(): void;
}

/**
 * The Tools dialog: reads `tools.list` once per open, after each save, and again when a new
 * tool-search result lands while nothing is edited; saves with `tools.set` the user's changes
 * applied to a `tools.list` read made just before saving.
 * Save waits while a turn owns the conversation, because an explicit selection made during a
 * turn cancels a tool search that is still activating tools.
 */
export function ToolCatalogDialog({ session, connected, onClose }: ToolCatalogDialogProps) {
	const sessionId = session.id;
	const [catalog, setCatalog] = useState<ToolCatalog | null>(null);
	const [reading, setReading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [unavailable, setUnavailable] = useState(false);
	const [error, setError] = useState<{ text: string; read: boolean } | null>(null);
	const [notice, setNotice] = useState("");
	const [edits, setEdits] = useState<ReadonlyMap<string, boolean>>(new Map());
	const [query, setQuery] = useState("");
	const [searchChanged, setSearchChanged] = useState(false);
	const ownerRef = useRef<ToolsDialogOwner | null>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const editsRef = useRef(edits);
	editsRef.current = edits;
	const current = (owner: ToolsDialogOwner) => owner.active && ownerRef.current === owner;
	const settle = (owner: ToolsDialogOwner) => {
		owner.busy = false;
		if (!current(owner) || !owner.again) return;
		owner.again = false;
		void read(owner);
	};
	const read = async (owner: ToolsDialogOwner) => {
		if (!current(owner)) return;
		if (owner.busy) {
			owner.again = true;
			return;
		}
		owner.busy = true;
		setReading(true);
		setError(null);
		try {
			const value = parseToolList(await request<unknown>("tools.list", { sessionId }));
			if (!current(owner)) return;
			if (!value) throw new Error(t("catalog.invalid"));
			const clear = owner.clearEdits;
			owner.clearEdits = false;
			setCatalog(value);
			setSearchChanged(false);
			setEdits(previous => {
				if (clear) return new Map();
				const known = new Map(value.tools.map(tool => [tool.name, tool.active]));
				return new Map([...previous].filter(([name, checked]) => known.has(name) && known.get(name) !== checked));
			});
		} catch (failure) {
			if (!current(owner)) return;
			const text = failure instanceof Error ? failure.message : t("shell.requestFailed");
			if (isToolCatalogUnsupported(text)) setUnavailable(true);
			else setError({ text, read: true });
		} finally {
			if (current(owner)) setReading(false);
			settle(owner);
		}
	};
	const save = async () => {
		const owner = ownerRef.current;
		if (!owner || !current(owner) || owner.busy || !catalog) return;
		owner.busy = true;
		setSaving(true);
		setError(null);
		setNotice("");
		let saved = false;
		try {
			// `tools.set` takes the whole list, so build it from the tools active now, not at the last read.
			const fresh = parseToolList(await request<unknown>("tools.list", { sessionId }));
			if (!current(owner)) return;
			if (!fresh) throw new Error(t("catalog.invalid"));
			await request("tools.set", { sessionId, names: editedToolNames(fresh, editsRef.current) });
			saved = true;
		} catch (failure) {
			if (current(owner))
				setError({ text: failure instanceof Error ? failure.message : t("shell.requestFailed"), read: false });
		} finally {
			if (current(owner)) setSaving(false);
			if (saved && current(owner)) {
				setNotice(t("catalog.saved"));
				owner.clearEdits = true;
				owner.again = true;
			}
			settle(owner);
		}
	};
	useEffect(() => {
		// A development StrictMode remount of the same open resumes its read instead of sending another.
		const resumed = ownerRef.current?.sessionId === sessionId ? ownerRef.current : null;
		const owner: ToolsDialogOwner = resumed ?? {
			sessionId,
			active: true,
			busy: false,
			again: false,
			clearEdits: false,
		};
		owner.active = true;
		ownerRef.current = owner;
		if (!resumed) void read(owner);
		return () => {
			owner.active = false;
		};
	}, [sessionId]);
	// Move focus into the search field once the first list lands, unless the user already moved it.
	const loaded = catalog !== null;
	useEffect(() => {
		if (!loaded) return;
		const dialog = searchRef.current?.closest("dialog");
		const focus = document.activeElement;
		if (!dialog || (focus && focus !== document.body && focus !== dialog && !focus.classList.contains("modal-close")))
			return;
		searchRef.current?.focus();
	}, [loaded]);
	// A tool search that lands while the dialog is open can turn tools on: re-read, or flag it over unsaved edits.
	const searchIds = toolSearchResultIds(session.messages);
	const searchKey = searchIds.join("\n");
	const seen = useRef<Set<string> | null>(null);
	useEffect(() => {
		const ids = searchKey ? searchKey.split("\n") : [];
		if (!seen.current) {
			seen.current = new Set(ids);
			return;
		}
		const fresh = ids.filter(item => !seen.current?.has(item));
		if (fresh.length === 0) return;
		for (const item of fresh) seen.current.add(item);
		const owner = ownerRef.current;
		if (!owner || !current(owner) || unavailable) return;
		if (editsRef.current.size > 0) setSearchChanged(true);
		else void read(owner);
	}, [searchKey]);
	const running = session.status === "running" || session.status === "waiting";
	return (
		<Modal title={t("catalog.title")} onClose={onClose} className="tool-catalog-dialog">
			<ToolCatalogPanel
				catalog={catalog}
				reading={reading}
				saving={saving}
				unavailable={unavailable}
				error={error?.text}
				onRetry={
					error?.read
						? () => {
								const owner = ownerRef.current;
								if (owner) void read(owner);
							}
						: undefined
				}
				notice={notice}
				query={query}
				onQueryChange={setQuery}
				edits={edits}
				onToggle={(name, checked) => {
					setNotice("");
					setEdits(previous => {
						const next = new Map(previous);
						const saved = catalog?.tools.find(tool => tool.name === name)?.active;
						if (saved === checked) next.delete(name);
						else next.set(name, checked);
						return next;
					});
				}}
				// Saving shows its own progress; the Host marks the conversation busy for that request.
				saveBlocked={!connected ? "disconnected" : running && !saving ? "running" : undefined}
				onSave={() => void save()}
				searchChanged={searchChanged}
				onReload={() => {
					const owner = ownerRef.current;
					if (owner) void read(owner);
				}}
				searchRef={searchRef}
			/>
		</Modal>
	);
}

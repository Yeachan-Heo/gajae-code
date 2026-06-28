/**
 * Session observer overlay component.
 *
 * Picker mode: lists main + active subagent sessions with live status.
 * Viewer mode: renders a scrollable, interactive transcript of the selected subagent's session
 *   by reading its JSONL session file — shows thinking, text, tool calls, results
 *   with expand/collapse per entry and breadcrumb navigation for nested sub-agents.
 *
 * Lifecycle:
 *   - shortcut opens picker
 *   - Enter on a subagent -> viewer
 *   - shortcut while in viewer -> back to picker (or pop breadcrumb)
 *   - Esc from viewer -> back to picker (or pop breadcrumb)
 *   - Esc from picker -> close overlay
 *   - Enter on main session -> close overlay (jump back)
 */
import type { ToolResultMessage } from "@gajae-code/ai";
import { Container, Markdown, type MarkdownTheme, matchesKey, resolveTerminalColumns } from "@gajae-code/tui";
import { formatDuration, formatNumber, logger } from "@gajae-code/utils";
import type { KeyId } from "../../config/keybindings";
import { isSilentAbort } from "../../session/messages";
import type { SessionMessageEntry } from "../../session/session-manager";
import { parseSessionEntries } from "../../session/session-manager";
import { PREVIEW_LIMITS, replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { getMarkdownTheme, theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

/** Max thinking characters in collapsed state */
const MAX_THINKING_CHARS_COLLAPSED = 200;
/** Max thinking characters in expanded state */
const MAX_THINKING_CHARS_EXPANDED = 4000;
/** Max tool args characters to display */
const MAX_TOOL_ARGS_CHARS = 500;
/** Lines per page for PageUp/PageDown */
const PAGE_SIZE = 15;
/** Left indent for content under entry headers */
const INDENT = "    ";

/** Compute the max content width for the current terminal, accounting for indent and chrome. */
function contentWidth(indent = INDENT): number {
	return Math.max(TRUNCATE_LENGTHS.SHORT, resolveTerminalColumns() - indent.length - 2);
}

/** Sanitize a line for TUI display: replace tabs, then truncate to viewport width. */
function sanitizeLine(text: string, maxWidth?: number): string {
	return truncateToWidth(replaceTabs(text), maxWidth ?? contentWidth());
}

/** Represents a rendered entry in the viewer for selection/expand tracking */
interface ViewerEntry {
	lineStart: number;
	lineCount: number;
	kind: "thinking" | "text" | "toolCall" | "user";
}

/** Breadcrumb item for nested session navigation */
interface BreadcrumbItem {
	sessionId: string;
	label: string;
	sessionFile: string;
}

export class SessionObserverOverlayComponent extends Container {
	#registry: SessionObserverRegistry;
	#onDone: () => void;
	#selectedSessionId?: string;
	#observeKeys: KeyId[];
	#transcriptCache?: { path: string; bytesRead: number; entries: SessionMessageEntry[]; model?: string };

	// Scroll state
	#scrollOffset = 0;
	#renderedLines: string[] = [];
	#viewportHeight = 20;
	#wasAtBottom = true;

	// Entry selection & expand/collapse
	#viewerEntries: ViewerEntry[] = [];
	#selectedEntryIndex = 0;
	#expandedEntries = new Set<number>();

	// Breadcrumb navigation
	#navigationStack: BreadcrumbItem[] = [];

	// Cached header/footer for viewer (rebuilt on refresh)
	#viewerHeaderLines: string[] = [];
	#viewerFooterLines: string[] = [];
	// Markdown rendering
	#mdTheme: MarkdownTheme = getMarkdownTheme();

	constructor(registry: SessionObserverRegistry, onDone: () => void, observeKeys: KeyId[]) {
		super();
		this.#registry = registry;
		this.#onDone = onDone;
		this.#observeKeys = observeKeys;

		// Jump directly to the most recently active sub-agent
		const mostRecent = this.#getMostRecentSubagent();
		if (mostRecent) {
			this.#selectedSessionId = mostRecent.id;
			this.#setupViewer();
		} else {
			// No sub-agents — close immediately
			queueMicrotask(() => this.#onDone());
		}
	}

	/** Find the most recently updated sub-agent session (prefer active ones) */
	#getMostRecentSubagent(): ObservableSession | undefined {
		const sessions = this.#registry.getSessions().filter(s => s.kind === "subagent");
		if (sessions.length === 0) return undefined;
		// Prefer active sessions, then sort by lastUpdate descending
		const active = sessions.filter(s => s.status === "active");
		const pool = active.length > 0 ? active : sessions;
		return pool.sort((a, b) => b.lastUpdate - a.lastUpdate)[0];
	}

	override render(width: number): string[] {
		return this.#renderViewer(width);
	}

	#setupViewer(): void {
		this.children = [];
		this.#scrollOffset = 0;
		this.#selectedEntryIndex = 0;
		this.#expandedEntries.clear();
		this.#wasAtBottom = true;
		this.#rebuildViewerContent();
		// Auto-scroll to bottom and select last entry on init
		if (this.#viewerEntries.length > 0) {
			this.#selectedEntryIndex = this.#viewerEntries.length - 1;
			this.#wasAtBottom = true;
			this.#rebuildViewerContent();
		}
	}

	/** Rebuild content from live registry data */
	refreshFromRegistry(): void {
		if (this.#selectedSessionId) {
			// Keep auto-scrolling to bottom unless the user navigated away from the last entry
			this.#wasAtBottom = this.#selectedEntryIndex >= this.#viewerEntries.length - 1;
			this.#rebuildViewerContent();
		}
	}

	/** Rebuild the transcript content lines (called on setup and refresh) */
	#rebuildViewerContent(): void {
		const sessions = this.#registry.getSessions();
		const session = sessions.find(s => s.id === this.#selectedSessionId);

		// Load transcript first so model info is available for header
		let messageEntries: SessionMessageEntry[] | null = null;
		if (session?.sessionFile) {
			messageEntries = this.#loadTranscript(session.sessionFile);
		}

		// Header
		this.#viewerHeaderLines = [];
		const breadcrumb = this.#buildBreadcrumb(session);
		this.#viewerHeaderLines.push(theme.fg("accent", breadcrumb));
		if (session) {
			const statusColor = session.status === "active" ? "success" : session.status === "failed" ? "error" : "dim";
			const statusText = theme.fg(statusColor, `[${session.status}]`);
			const agentTag = session.agent ? theme.fg("dim", ` ${session.agent}`) : "";
			const subagentIds = this.#getSubagentSessionIds();
			const posIdx = subagentIds.indexOf(this.#selectedSessionId ?? "");
			const posLabel =
				subagentIds.length > 1 && posIdx >= 0 ? theme.fg("dim", ` (${posIdx + 1}/${subagentIds.length})`) : "";
			const modelName = this.#transcriptCache?.model;
			const modelLabel = modelName ? theme.fg("muted", ` · ${modelName}`) : "";
			this.#viewerHeaderLines.push(`${theme.bold(session.label)} ${statusText}${agentTag}${posLabel}${modelLabel}`);
		}

		// Content
		const contentLines: string[] = [];
		this.#viewerEntries = [];

		if (!session) {
			contentLines.push(theme.fg("dim", "Session no longer available."));
		} else if (!session.sessionFile) {
			contentLines.push(theme.fg("dim", "No session file available yet."));
		} else if (!messageEntries) {
			contentLines.push(theme.fg("dim", "Unable to read session file."));
		} else if (messageEntries.length === 0) {
			contentLines.push(theme.fg("dim", "No messages yet."));
		} else {
			this.#buildTranscriptLines(messageEntries, contentLines);
		}
		this.#renderedLines = contentLines;

		// Footer
		this.#viewerFooterLines = [];
		const statsLine = this.#buildStatsLine(session);
		if (statsLine) this.#viewerFooterLines.push(statsLine);
		this.#viewerFooterLines.push(
			theme.fg("dim", "j/k:scroll  Enter:expand  [/]/←→:cycle agents  Esc/Ctrl+S:close  g/G:top/bottom"),
		);

		// Auto-scroll to bottom if we were at bottom
		if (this.#wasAtBottom) {
			this.#scrollOffset = Math.max(0, contentLines.length - this.#viewportHeight);
		}
	}

	/** Produce the final viewer output for the overlay system */
	#renderViewer(width: number): string[] {
		const termHeight = process.stdout.rows || 40;

		// Compute viewport: total height minus header chrome and footer chrome
		// Header: border(1) + headerLines + border(1) = headerLines.length + 2
		// Footer: spacer(1) + scrollInfo(1) + footerLines + border(1) = footerLines.length + 2
		const headerChrome = this.#viewerHeaderLines.length + 2;
		const footerChrome = this.#viewerFooterLines.length + 2;
		this.#viewportHeight = Math.max(5, termHeight - headerChrome - footerChrome);

		// Clamp scroll offset
		const maxScroll = Math.max(0, this.#renderedLines.length - this.#viewportHeight);
		this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, maxScroll));

		const lines: string[] = [];

		// --- Header ---
		lines.push(...new DynamicBorder().render(width));
		for (const hl of this.#viewerHeaderLines) {
			lines.push(` ${hl}`);
		}
		lines.push(...new DynamicBorder().render(width));

		// --- Scrolled content viewport ---
		const visibleLines = this.#renderedLines.slice(this.#scrollOffset, this.#scrollOffset + this.#viewportHeight);
		for (const vl of visibleLines) {
			lines.push(` ${vl}`);
		}
		// Pad to fill viewport if content is shorter
		const pad = this.#viewportHeight - visibleLines.length;
		for (let i = 0; i < pad; i++) {
			lines.push("");
		}

		// --- Footer ---
		const scrollInfo =
			this.#renderedLines.length > this.#viewportHeight
				? ` ${theme.fg("dim", `[${this.#scrollOffset + 1}-${Math.min(this.#scrollOffset + this.#viewportHeight, this.#renderedLines.length)}/${this.#renderedLines.length}]`)}`
				: "";
		lines.push("");
		lines.push(` ${this.#viewerFooterLines[0] ?? ""}${scrollInfo}`);
		for (let i = 1; i < this.#viewerFooterLines.length; i++) {
			lines.push(` ${this.#viewerFooterLines[i]}`);
		}
		lines.push(...new DynamicBorder().render(width));

		return lines;
	}

	#buildBreadcrumb(session: ObservableSession | undefined): string {
		const parts: string[] = ["Session Observer"];
		for (const item of this.#navigationStack) {
			parts.push(item.label);
		}
		if (session) parts.push(session.label);
		return parts.join(" > ");
	}

	#buildStatsLine(session: ObservableSession | undefined): string {
		const progress = session?.progress;
		if (!progress) return "";
		const stats: string[] = [];
		if (progress.toolCount > 0) stats.push(`${formatNumber(progress.toolCount)} tools`);
		// Current per-turn context — what the user reads as "how full is the context".
		// Falls back to cumulative billing volume (Σ-prefixed) when context size is unknown.
		if (progress.contextTokens && progress.contextTokens > 0) {
			const ctx =
				progress.contextWindow && progress.contextWindow > 0
					? `${formatNumber(progress.contextTokens)}/${formatNumber(progress.contextWindow)} ctx`
					: `${formatNumber(progress.contextTokens)} ctx`;
			stats.push(ctx);
			if (progress.tokens > 0) stats.push(`Σ${formatNumber(progress.tokens)}`);
		} else if (progress.tokens > 0) {
			stats.push(`Σ${formatNumber(progress.tokens)}`);
		}
		if (progress.durationMs > 0) stats.push(formatDuration(progress.durationMs));
		const parts: string[] = [];
		if (stats.length > 0) parts.push(theme.fg("dim", stats.join(theme.sep.dot)));
		if (progress.cost > 0) parts.push(theme.fg("statusLineCost", `$${progress.cost.toFixed(2)}`));
		return parts.join(theme.sep.dot);
	}

	#buildTranscriptLines(messageEntries: SessionMessageEntry[], lines: string[]): void {
		// Build a tool call ID -> tool result map
		const toolResults = new Map<string, ToolResultMessage>();
		for (const entry of messageEntries) {
			if (entry.message.role === "toolResult") {
				toolResults.set(entry.message.toolCallId, entry.message);
			}
		}

		let entryIndex = 0;
		for (const entry of messageEntries) {
			const msg = entry.message;

			if (msg.role === "assistant") {
				// Handle error messages with empty content
				if (msg.content.length === 0 && msg.errorMessage && !isSilentAbort(msg.errorMessage)) {
					const startLine = lines.length;
					const isSelected = entryIndex === this.#selectedEntryIndex;
					const cursor = isSelected ? theme.fg("accent", "▶") : " ";
					lines.push("");
					const errorLines = msg.errorMessage.split("\n");
					const maxWidth = contentWidth();
					lines.push(`${cursor} ${theme.fg("error", `✗ Error: ${sanitizeLine(errorLines[0], maxWidth)}`)}`);
					for (let i = 1; i < errorLines.length; i++) {
						lines.push(`${INDENT}${theme.fg("error", sanitizeLine(errorLines[i], maxWidth))}`);
					}
					this.#viewerEntries.push({ lineStart: startLine, lineCount: lines.length - startLine, kind: "text" });
					entryIndex++;
				} else {
					for (const content of msg.content) {
						if (content.type === "thinking" && content.thinking.trim()) {
							const startLine = lines.length;
							const isExpanded = this.#expandedEntries.has(entryIndex);
							const isSelected = entryIndex === this.#selectedEntryIndex;
							this.#renderThinkingLines(lines, content.thinking.trim(), isExpanded, isSelected);
							this.#viewerEntries.push({
								lineStart: startLine,
								lineCount: lines.length - startLine,
								kind: "thinking",
							});
							entryIndex++;
						} else if (content.type === "text" && content.text.trim()) {
							const startLine = lines.length;
							const isExpanded = this.#expandedEntries.has(entryIndex);
							const isSelected = entryIndex === this.#selectedEntryIndex;
							this.#renderTextLines(lines, content.text.trim(), isExpanded, isSelected);
							this.#viewerEntries.push({
								lineStart: startLine,
								lineCount: lines.length - startLine,
								kind: "text",
							});
							entryIndex++;
						} else if (content.type === "toolCall") {
							const startLine = lines.length;
							const isExpanded = this.#expandedEntries.has(entryIndex);
							const isSelected = entryIndex === this.#selectedEntryIndex;
							const result = toolResults.get(content.id);
							this.#renderToolCallLines(lines, content, result, isExpanded, isSelected);
							this.#viewerEntries.push({
								lineStart: startLine,
								lineCount: lines.length - startLine,
								kind: "toolCall",
							});
							entryIndex++;
						}
					}
				}
			} else if (msg.role === "user" || msg.role === "developer") {
				const text =
					typeof msg.content === "string"
						? msg.content
						: msg.content
								.filter((b): b is { type: "text"; text: string } => b.type === "text")
								.map(b => b.text)
								.join("\n");
				if (text.trim()) {
					const startLine = lines.length;
					const isSelected = entryIndex === this.#selectedEntryIndex;
					const isExpanded = this.#expandedEntries.has(entryIndex);
					const label = msg.role === "developer" ? "System" : "User";
					const cursor = isSelected ? theme.fg("accent", "▶") : " ";
					lines.push("");
					if (isExpanded) {
						lines.push(`${cursor} ${theme.fg("dim", `[${label}]`)}`);
						const mdLines = this.#renderMarkdownToLines(text.trim());
						for (const ml of mdLines) {
							lines.push(ml);
						}
					} else {
						const firstLine = text.trim().split("\n")[0];
						const totalLines = text.trim().split("\n").length;
						const hint = totalLines > 1 ? theme.fg("dim", ` (${totalLines} lines)`) : "";
						lines.push(
							`${cursor} ${theme.fg("dim", `[${label}]`)} ${theme.fg("muted", sanitizeLine(firstLine, TRUNCATE_LENGTHS.TITLE))}${hint}`,
						);
					}
					this.#viewerEntries.push({ lineStart: startLine, lineCount: lines.length - startLine, kind: "user" });
					entryIndex++;
				}
			}
		}
	}

	/** Render markdown text into indented lines using the theme's markdown renderer */
	#renderMarkdownToLines(text: string, indent: string = INDENT): string[] {
		const width = Math.max(40, resolveTerminalColumns() - indent.length - 4);
		const md = new Markdown(text, 0, 0, this.#mdTheme);
		const rendered = md.render(width);
		return rendered.map(line => `${indent}${line.trimEnd()}`);
	}

	#renderThinkingLines(lines: string[], thinking: string, expanded: boolean, selected: boolean): void {
		const cursor = selected ? theme.fg("accent", "▶") : " ";
		const maxChars = expanded ? MAX_THINKING_CHARS_EXPANDED : MAX_THINKING_CHARS_COLLAPSED;
		const truncated = thinking.length > maxChars;
		const expandLabel = !expanded && truncated ? theme.fg("dim", " ↵") : "";

		lines.push("");
		lines.push(`${cursor} ${theme.fg("dim", "💭 Thinking")}${expandLabel}`);

		const displayText = truncated ? `${thinking.slice(0, maxChars)}...` : thinking;
		if (expanded) {
			// Expanded thinking: render as markdown for readable formatting
			const mdLines = this.#renderMarkdownToLines(displayText);
			const maxLines = 100;
			for (let i = 0; i < Math.min(mdLines.length, maxLines); i++) {
				lines.push(mdLines[i]);
			}
			if (mdLines.length > maxLines) {
				lines.push(`${INDENT}${theme.fg("dim", `... ${mdLines.length - maxLines} more lines`)}`);
			}
		} else {
			// Collapsed thinking: brief italic preview
			const thinkingLines = displayText.split("\n");
			const maxLines = PREVIEW_LIMITS.COLLAPSED_LINES;
			for (let i = 0; i < Math.min(thinkingLines.length, maxLines); i++) {
				lines.push(`${INDENT}${theme.fg("thinkingText", sanitizeLine(thinkingLines[i]))}`);
			}
			if (thinkingLines.length > maxLines) {
				lines.push(`${INDENT}${theme.fg("dim", `... ${thinkingLines.length - maxLines} more lines`)}`);
			}
		}
	}

	#renderTextLines(lines: string[], text: string, expanded: boolean, selected: boolean): void {
		const cursor = selected ? theme.fg("accent", "▶") : " ";

		lines.push("");
		lines.push(`${cursor} ${theme.fg("muted", "Response")}`);

		if (expanded) {
			// Expanded: full markdown rendering
			const mdLines = this.#renderMarkdownToLines(text);
			for (const ml of mdLines) {
				lines.push(ml);
			}
		} else {
			// Collapsed: first few lines as plain text
			const textLines = text.split("\n");
			const maxLines = PREVIEW_LIMITS.COLLAPSED_LINES;
			const maxWidth = contentWidth();
			for (let i = 0; i < Math.min(textLines.length, maxLines); i++) {
				lines.push(`${INDENT}${sanitizeLine(textLines[i], maxWidth)}`);
			}
			if (textLines.length > maxLines) {
				lines.push(`${INDENT}${theme.fg("dim", `... ${textLines.length - maxLines} more lines`)}`);
			}
		}
	}

	#renderToolCallLines(
		lines: string[],
		call: { id: string; name: string; arguments: Record<string, unknown>; intent?: string },
		result: ToolResultMessage | undefined,
		expanded: boolean,
		selected: boolean,
	): void {
		const cursor = selected ? theme.fg("accent", "▶") : " ";
		lines.push("");

		// Tool call header
		const intentStr = call.intent ? theme.fg("dim", ` ${sanitizeLine(call.intent, TRUNCATE_LENGTHS.SHORT)}`) : "";
		lines.push(`${cursor} ${theme.fg("accent", "▸")} ${theme.bold(theme.fg("muted", call.name))}${intentStr}`);

		// Key arguments
		const argSummary = this.#formatToolArgs(call.name, call.arguments);
		if (argSummary) {
			lines.push(`${INDENT}${theme.fg("dim", sanitizeLine(argSummary, contentWidth()))}`);
		}

		// Tool result
		if (result) {
			this.#renderToolResultLines(lines, result, expanded);
		}
	}

	#renderToolResultLines(lines: string[], result: ToolResultMessage, expanded: boolean): void {
		const textParts = result.content
			.filter((p): p is { type: "text"; text: string } => p.type === "text")
			.map(p => p.text);
		const text = textParts.join("\n").trim();

		if (result.isError) {
			const errorLines = text.split("\n");
			const maxErrorLines = expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
			const maxWidth = contentWidth();
			lines.push(`${INDENT}${theme.fg("error", `✗ ${sanitizeLine(errorLines[0] || "Error", maxWidth)}`)}`);
			for (let i = 1; i < Math.min(errorLines.length, maxErrorLines); i++) {
				lines.push(`${INDENT}  ${theme.fg("error", sanitizeLine(errorLines[i], maxWidth))}`);
			}
			if (errorLines.length > maxErrorLines) {
				lines.push(`${INDENT}  ${theme.fg("dim", `... ${errorLines.length - maxErrorLines} more lines`)}`);
			}
			return;
		}

		if (!text) {
			lines.push(`${INDENT}${theme.fg("dim", "✓ done")}`);
			return;
		}

		const resultLines = text.split("\n");
		const maxLines = expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.OUTPUT_COLLAPSED;

		// Status line
		const statusPrefix = `${INDENT}${theme.fg("success", "✓")}`;

		if (resultLines.length === 1 && text.length < TRUNCATE_LENGTHS.LONG) {
			lines.push(`${statusPrefix} ${theme.fg("dim", sanitizeLine(text))}`);
			return;
		}

		lines.push(`${statusPrefix} ${theme.fg("dim", `${resultLines.length} lines`)}`);
		const displayLines = resultLines.slice(0, maxLines);
		for (const rl of displayLines) {
			lines.push(`${INDENT}  ${theme.fg("dim", sanitizeLine(rl))}`);
		}
		if (resultLines.length > maxLines) {
			lines.push(`${INDENT}  ${theme.fg("dim", `... ${resultLines.length - maxLines} more`)}`);
		}
	}

	#formatToolArgs(toolName: string, args: Record<string, unknown>): string {
		switch (toolName) {
			case "read":
			case "write":
			case "edit":
				return args.path ? `path: ${args.path}` : "";
			case "search":
				return [
					args.pattern ? `pattern: ${args.pattern}` : "",
					Array.isArray(args.paths) ? `paths: ${args.paths.join(", ")}` : "",
				]
					.filter(Boolean)
					.join(", ");
			case "find":
				return Array.isArray(args.paths) ? `paths: ${args.paths.join(", ")}` : "";
			case "bash": {
				const cmd = args.command;
				return typeof cmd === "string" ? replaceTabs(cmd) : "";
			}
			case "lsp":
				return [args.action, args.file, args.symbol].filter(Boolean).join(" ");
			case "ast_grep":
			case "ast_edit":
				return args.path ? `path: ${args.path}` : "";
			case "task": {
				const tasks = args.tasks;
				return Array.isArray(tasks) ? `${tasks.length} task(s)` : "";
			}
			default: {
				const parts: string[] = [];
				let total = 0;
				for (const [key, value] of Object.entries(args)) {
					if (key.startsWith("_")) continue;
					const v = typeof value === "string" ? value : JSON.stringify(value);
					const entry = `${key}: ${replaceTabs(v ?? "")}`;
					if (total + entry.length > MAX_TOOL_ARGS_CHARS) break;
					parts.push(entry);
					total += entry.length;
				}
				return parts.join(", ");
			}
		}
	}

	#loadTranscript(sessionFile: string): SessionMessageEntry[] | null {
		if (this.#transcriptCache && this.#transcriptCache.path !== sessionFile) {
			this.#transcriptCache = undefined;
		}

		const fromByte = this.#transcriptCache?.bytesRead ?? 0;
		const result = readFileIncremental(sessionFile, fromByte);
		if (!result) {
			logger.debug("Session observer: failed to read session file", { path: sessionFile });
			return this.#transcriptCache?.entries ?? null;
		}

		if (result.newSize < fromByte) {
			this.#transcriptCache = undefined;
			return this.#loadTranscript(sessionFile);
		}

		if (!this.#transcriptCache) {
			this.#transcriptCache = { path: sessionFile, bytesRead: 0, entries: [] };
		}

		if (result.text.length > 0) {
			const lastNewline = result.text.lastIndexOf("\n");
			if (lastNewline >= 0) {
				const completeChunk = result.text.slice(0, lastNewline + 1);
				const newEntries = parseSessionEntries(completeChunk);
				for (const entry of newEntries) {
					if (entry.type === "message") {
						this.#transcriptCache.entries.push(entry);
						// Extract model from first assistant message
						const msg = entry.message;
						if (!this.#transcriptCache.model && msg.role === "assistant") {
							this.#transcriptCache.model = msg.model;
						}
					} else if (entry.type === "model_change") {
						this.#transcriptCache.model = entry.model;
					}
				}
				this.#transcriptCache.bytesRead = fromByte + Buffer.byteLength(completeChunk, "utf-8");
			}
		}
		return this.#transcriptCache.entries;
	}

	#navigateBack(): boolean {
		if (this.#navigationStack.length === 0) return false;
		const prev = this.#navigationStack.pop()!;
		this.#selectedSessionId = prev.sessionId;
		this.#transcriptCache = undefined;
		this.#scrollOffset = 0;
		this.#selectedEntryIndex = 0;
		this.#expandedEntries.clear();
		this.#rebuildViewerContent();
		return true;
	}

	handleInput(keyData: string): void {
		// Ctrl+S (observe key) always closes the overlay
		for (const key of this.#observeKeys) {
			if (matchesKey(keyData, key)) {
				this.#onDone();
				return;
			}
		}

		this.#handleViewerInput(keyData);
	}

	#handleViewerInput(keyData: string): void {
		const entryCount = this.#viewerEntries.length;

		// Escape — pop breadcrumb navigation or close overlay
		if (matchesKey(keyData, "escape")) {
			if (!this.#navigateBack()) {
				this.#onDone();
			}
			return;
		}

		// j / down — move selection down
		if (keyData === "j" || matchesKey(keyData, "down")) {
			if (entryCount > 0) {
				this.#selectedEntryIndex = Math.min(this.#selectedEntryIndex + 1, entryCount - 1);
			}
			this.#rebuildAndScroll();
			return;
		}

		// k / up — move selection up
		if (keyData === "k" || matchesKey(keyData, "up")) {
			if (entryCount > 0) {
				this.#selectedEntryIndex = Math.max(this.#selectedEntryIndex - 1, 0);
			}
			this.#rebuildAndScroll();
			return;
		}

		// Page Down
		if (matchesKey(keyData, "pageDown")) {
			if (entryCount > 0) {
				const prevIndex = this.#selectedEntryIndex;
				this.#selectedEntryIndex = Math.min(this.#selectedEntryIndex + 5, entryCount - 1);
				// If selection didn't move (bottom of list or single oversized entry), fall back to line scroll
				if (this.#selectedEntryIndex === prevIndex) {
					this.#scrollOffset = Math.min(
						this.#scrollOffset + PAGE_SIZE,
						Math.max(0, this.#renderedLines.length - this.#viewportHeight),
					);
				}
			} else {
				this.#scrollOffset = Math.min(
					this.#scrollOffset + PAGE_SIZE,
					Math.max(0, this.#renderedLines.length - this.#viewportHeight),
				);
			}
			this.#rebuildAndScroll();
			return;
		}

		// Page Up
		if (matchesKey(keyData, "pageUp")) {
			if (entryCount > 0) {
				const prevIndex = this.#selectedEntryIndex;
				this.#selectedEntryIndex = Math.max(this.#selectedEntryIndex - 5, 0);
				// If selection didn't move (top of list or single oversized entry), fall back to line scroll
				if (this.#selectedEntryIndex === prevIndex) {
					this.#scrollOffset = Math.max(this.#scrollOffset - PAGE_SIZE, 0);
				}
			} else {
				this.#scrollOffset = Math.max(this.#scrollOffset - PAGE_SIZE, 0);
			}
			this.#rebuildAndScroll();
			return;
		}

		// Enter — toggle expand/collapse, or dive into nested session
		if (matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
			if (entryCount > 0 && this.#selectedEntryIndex < entryCount) {
				// Toggle expand/collapse
				if (this.#expandedEntries.has(this.#selectedEntryIndex)) {
					this.#expandedEntries.delete(this.#selectedEntryIndex);
				} else {
					this.#expandedEntries.add(this.#selectedEntryIndex);
				}
				this.#rebuildAndScroll();
			}
			return;
		}

		// G — jump to bottom
		if (keyData === "G") {
			if (entryCount > 0) this.#selectedEntryIndex = entryCount - 1;
			this.#scrollOffset = Math.max(0, this.#renderedLines.length - this.#viewportHeight);
			this.#rebuildAndScroll();
			return;
		}

		// g — jump to top
		if (keyData === "g") {
			this.#selectedEntryIndex = 0;
			this.#scrollOffset = 0;
			this.#rebuildAndScroll();
			return;
		}

		// ] / → / Tab — next sub-agent session
		if (keyData === "]" || matchesKey(keyData, "tab") || matchesKey(keyData, "right")) {
			this.#cycleSession(1);
			return;
		}

		// [ / ← / Shift+Tab — previous sub-agent session
		if (keyData === "[" || matchesKey(keyData, "shift+tab") || matchesKey(keyData, "left")) {
			this.#cycleSession(-1);
			return;
		}
	}

	/** Get the ordered list of sub-agent session IDs (excludes main) */
	#getSubagentSessionIds(): string[] {
		return this.#registry
			.getSessions()
			.filter(s => s.kind === "subagent")
			.map(s => s.id);
	}

	/** Cycle to next (+1) or previous (-1) sub-agent session */
	#cycleSession(direction: 1 | -1): void {
		const ids = this.#getSubagentSessionIds();
		if (ids.length <= 1) return;
		const currentIdx = ids.indexOf(this.#selectedSessionId ?? "");
		if (currentIdx < 0) return;
		const nextIdx = (currentIdx + direction + ids.length) % ids.length;
		this.#selectedSessionId = ids[nextIdx];
		this.#transcriptCache = undefined;
		this.#scrollOffset = 0;
		this.#selectedEntryIndex = 0;
		this.#expandedEntries.clear();
		this.#wasAtBottom = true;
		this.#rebuildViewerContent();
		// Auto-scroll to bottom: select last entry
		if (this.#viewerEntries.length > 0) {
			this.#selectedEntryIndex = this.#viewerEntries.length - 1;
			this.#wasAtBottom = true;
			this.#rebuildViewerContent();
		}
	}

	/** Rebuild transcript lines (which depend on selectedEntryIndex/expandedEntries) and scroll to selection */
	#rebuildAndScroll(): void {
		// Resume auto-scrolling once selection returns to the last entry
		this.#wasAtBottom = this.#selectedEntryIndex >= this.#viewerEntries.length - 1;
		this.#rebuildViewerContent();
		this.#scrollToSelectedEntry();
	}

	#scrollToSelectedEntry(): void {
		if (this.#viewerEntries.length === 0) return;
		const entry = this.#viewerEntries[this.#selectedEntryIndex];
		if (!entry) return;

		const entryTop = entry.lineStart;
		const entryBottom = entry.lineStart + entry.lineCount;

		if (entry.lineCount >= this.#viewportHeight) {
			// Entry taller than viewport: only snap when it's completely out of view.
			// If the viewport overlaps the entry at all, the user may be paging within it.
			if (this.#scrollOffset + this.#viewportHeight <= entryTop) {
				// Viewport is entirely above the entry — snap to entry top
				this.#scrollOffset = Math.max(0, entryTop - 1);
			} else if (this.#scrollOffset >= entryBottom) {
				// Viewport is entirely below the entry — snap to show entry bottom
				this.#scrollOffset = Math.max(0, entryBottom - this.#viewportHeight);
			}
			// Otherwise: viewport overlaps the entry — don't override manual scroll
		} else {
			// Entry fits in viewport: ensure it's fully visible
			if (entryTop < this.#scrollOffset) {
				this.#scrollOffset = Math.max(0, entryTop - 1);
			}
			if (entryBottom > this.#scrollOffset + this.#viewportHeight) {
				this.#scrollOffset = Math.max(0, entryBottom - this.#viewportHeight + 1);
			}
		}
	}
}

// Sync helpers for render path
import * as fs from "node:fs";

function readFileIncremental(filePath: string, fromByte: number): { text: string; newSize: number } | null {
	try {
		const stat = fs.statSync(filePath);
		if (stat.size <= fromByte) return { text: "", newSize: stat.size };
		const buf = Buffer.alloc(stat.size - fromByte);
		const fd = fs.openSync(filePath, "r");
		try {
			fs.readSync(fd, buf, 0, buf.length, fromByte);
		} finally {
			fs.closeSync(fd);
		}
		return { text: buf.toString("utf-8"), newSize: stat.size };
	} catch {
		return null;
	}
}

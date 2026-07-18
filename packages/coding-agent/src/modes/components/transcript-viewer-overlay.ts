import {
	Container,
	Markdown,
	type MarkdownTheme,
	type MouseEvent,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@gajae-code/tui";
import { sanitizeText } from "@gajae-code/utils";
import { getMarkdownTheme, theme } from "../theme/theme";
import type { TranscriptItemRegistry, TranscriptSourcePayload } from "../transcript-item-registry";
import { DynamicBorder } from "./dynamic-border";

const INDENT = "    ";
const PAGE_SIZE = 15;
const PREVIEW_LINES = 4;

export type TranscriptViewerEntry = {
	id: string;
	kind: string;
	label?: string;
	payload: TranscriptSourcePayload;
	copyable?: boolean;
	foldable?: boolean;
	rawViewable?: boolean;
	getDisplayText?: (expanded: boolean) => string;
};

export type TranscriptViewerOverlayOptions = {
	title?: string;
	getEntries: () => readonly TranscriptViewerEntry[];
	onClose: () => void;
	requestRender?: () => void;
	copyToClipboard?: (text: string) => void;
	onError?: (message: string) => void;
	enterExpands?: boolean;
	initialSelection?: "first" | "latest";
	followTail?: boolean;
	getHeaderLines?: () => readonly string[];
	getFooterLines?: () => readonly string[];
	maxExpandedLines?: number;
	footerControls?: string;
	getEntryText?: (entry: TranscriptViewerEntry, expanded: boolean) => string;
};

type RenderedEntry = { lineStart: number; lineCount: number };

/** Message-agnostic, modal transcript browser over resolved projection entries. */
export class TranscriptViewerOverlay extends Container {
	#options: TranscriptViewerOverlayOptions;
	#entries: readonly TranscriptViewerEntry[] = [];
	#renderedEntries: RenderedEntry[] = [];
	#expanded = new Set<string>();
	#raw = new Set<string>();
	#selected = 0;
	#scrollOffset = 0;
	#viewportHeight = 20;
	#lines: string[] = [];
	#fullscreen = false;
	#mdTheme: MarkdownTheme = getMarkdownTheme();
	#width = 80;
	#initialized = false;
	#contentOrigin = 3;
	#followTailPending = false;
	#skipFollowTailOnce = false;
	#followTailActive = false;

	constructor(options: TranscriptViewerOverlayOptions) {
		super();
		this.#options = options;
		this.#followTailActive = options.followTail === true;
		this.refresh();
	}

	get selectedEntryId(): string | undefined {
		return this.#entries[this.#selected]?.id;
	}
	get isFullscreen(): boolean {
		return this.#fullscreen;
	}
	refresh(identityMap?: ReadonlyMap<string, string>): void {
		const previous = this.selectedEntryId;
		const previousPosition = this.#selected;
		const reconciledPrevious = previous ? (identityMap?.get(previous) ?? previous) : undefined;
		const wasAtTail = this.#selected >= this.#entries.length - 1;
		this.#entries = this.#options.getEntries();
		const reconciledIndex = reconciledPrevious
			? this.#entries.findIndex(entry => entry.id === reconciledPrevious)
			: -1;
		if (this.#options.initialSelection === "latest" && !this.#initialized)
			this.#selected = Math.max(0, this.#entries.length - 1);
		else if (reconciledIndex >= 0) this.#selected = reconciledIndex;
		else this.#selected = Math.min(previousPosition, Math.max(0, this.#entries.length - 1));
		this.#followTailPending = Boolean(
			this.#followTailActive && !this.#skipFollowTailOnce && (wasAtTail || !this.#initialized),
		);
		if (this.#initialized && this.#followTailActive && wasAtTail && !this.#skipFollowTailOnce)
			this.#selected = Math.max(0, this.#entries.length - 1);
		this.#skipFollowTailOnce = false;
		this.#initialized = true;
		this.#rebuild();
	}
	override render(width: number): string[] {
		this.#width = Math.max(1, width);
		this.refresh();
		const defaultHeader = this.#fullscreen
			? [theme.fg("accent", "Transcript block")]
			: [theme.fg("accent", sanitizeText(this.#options.title ?? "Transcript"))];
		const header = this.#fullscreen
			? defaultHeader
			: [...defaultHeader, ...(this.#options.getHeaderLines?.() ?? []).map(sanitizeText)];
		const defaultFooter = this.#fullscreen
			? [theme.fg("dim", "Esc:back  j/k:scroll  PgUp/PgDn:page")]
			: [
					theme.fg(
						"dim",
						sanitizeText(
							this.#options.footerControls ??
								"j/k:select  Space:expand  Enter:fullscreen  y:copy  Y:metadata  r:raw  g/G:top/bottom  Esc:close",
						),
					),
				];
		const scrollRange =
			this.#lines.length > this.#viewportHeight
				? theme.fg(
						"dim",
						`[${this.#scrollOffset + 1}-${Math.min(this.#scrollOffset + this.#viewportHeight, this.#lines.length)}/${this.#lines.length}]`,
					)
				: "";
		const footer = this.#fullscreen
			? defaultFooter
			: [...(this.#options.getFooterLines?.() ?? []).map(sanitizeText), scrollRange, ...defaultFooter].filter(
					Boolean,
				);
		this.#viewportHeight = Math.max(5, (process.stdout.rows || 40) - header.length - footer.length - 5);
		this.#contentOrigin = header.length + 2;
		const maxScroll = Math.max(0, this.#lines.length - this.#viewportHeight);
		if (this.#followTailPending) {
			this.#scrollOffset = maxScroll;
			this.#followTailPending = false;
		}
		this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, maxScroll));
		const visible = this.#lines.slice(this.#scrollOffset, this.#scrollOffset + this.#viewportHeight);
		const lines = [
			...new DynamicBorder().render(this.#width),
			...header.map(line => ` ${line}`),
			...new DynamicBorder().render(this.#width),
		];
		lines.push(...visible.map(line => ` ${line}`));
		for (let i = visible.length; i < this.#viewportHeight; i++) lines.push("");
		lines.push("", ...footer.map(line => ` ${line}`), ...new DynamicBorder().render(this.#width));
		return lines.map(line => truncateToWidth(line, this.#width));
	}

	handleMouse(event: MouseEvent): void {
		if (event.kind !== "click" || this.#fullscreen) return;
		// Render has a border, header, and border before the first viewport row.
		const contentLine = this.#scrollOffset + (event.localY ?? event.y) - this.#contentOrigin;
		const index = this.#renderedEntries.findIndex(
			entry => contentLine >= entry.lineStart && contentLine < entry.lineStart + entry.lineCount,
		);
		if (index < 0) return;
		this.#followTailActive = false;
		this.#selected = index;
		this.#move(0);
		this.#requestRender();
	}
	handleInput(keyData: string): void {
		if (matchesKey(keyData, "escape")) {
			if (this.#fullscreen) {
				this.#fullscreen = false;
				this.#scrollOffset = 0;
				this.#requestRender();
			} else this.#options.onClose();
			return;
		}
		if (this.#fullscreen) {
			this.#scroll(keyData);
			return;
		}
		const count = this.#entries.length;
		if (keyData === "j" || matchesKey(keyData, "down")) {
			this.#move(1);
			return;
		}
		if (keyData === "k" || matchesKey(keyData, "up")) {
			this.#move(-1);
			return;
		}
		if (matchesKey(keyData, "pageDown")) {
			this.#page(1);
			return;
		}
		if (matchesKey(keyData, "pageUp")) {
			this.#page(-1);
			return;
		}
		if (keyData === "g") {
			this.#followTailActive = false;
			this.#followTailPending = false;
			this.#selected = 0;
			this.#scrollOffset = 0;
			this.#requestRender();
			return;
		}
		if (keyData === "G") {
			this.#followTailActive = true;
			this.#followTailPending = true;
			this.#selected = Math.max(0, count - 1);
			this.#scrollOffset = this.#lines.length;
			this.#requestRender();
			return;
		}
		if (keyData === " " || (this.#options.enterExpands && (matchesKey(keyData, "enter") || keyData === "\r"))) {
			this.#toggleExpand();
			return;
		}
		if (!this.#options.enterExpands && (matchesKey(keyData, "enter") || keyData === "\r")) {
			this.#followTailActive = false;
			this.#fullscreen = true;
			this.#scrollOffset = 0;
			this.#requestRender();
			return;
		}
		if (keyData === "y") {
			this.#copy(false);
			return;
		}
		if (keyData === "Y") {
			this.#copy(true);
			return;
		}
		if (keyData === "r") {
			const entry = this.#entries[this.#selected];
			if (entry?.rawViewable !== false) {
				this.#raw.has(entry.id) ? this.#raw.delete(entry.id) : this.#raw.add(entry.id);
				this.#requestRender();
			}
		}
	}

	#scroll(keyData: string): void {
		this.#followTailActive = false;
		this.#followTailPending = false;
		if (keyData === "j" || matchesKey(keyData, "down") || matchesKey(keyData, "pageDown"))
			this.#scrollOffset += PAGE_SIZE;
		if (keyData === "k" || matchesKey(keyData, "up") || matchesKey(keyData, "pageUp"))
			this.#scrollOffset -= PAGE_SIZE;
		this.#requestRender();
	}
	#move(delta: number): void {
		this.#selected = Math.max(0, Math.min(this.#selected + delta, this.#entries.length - 1));
		if (delta !== 0) {
			this.#followTailActive = false;
			this.#followTailPending = false;
		}
		this.#rebuild();
		const entry = this.#renderedEntries[this.#selected];
		if (entry) {
			const entryBottom = entry.lineStart + entry.lineCount;
			if (entry.lineCount >= this.#viewportHeight) {
				if (this.#scrollOffset + this.#viewportHeight <= entry.lineStart)
					this.#scrollOffset = Math.max(0, entry.lineStart - 1);
				else if (this.#scrollOffset >= entryBottom)
					this.#scrollOffset = Math.max(0, entryBottom - this.#viewportHeight);
			} else {
				if (entry.lineStart < this.#scrollOffset) this.#scrollOffset = Math.max(0, entry.lineStart - 1);
				if (entryBottom > this.#scrollOffset + this.#viewportHeight)
					this.#scrollOffset = Math.max(0, entryBottom - this.#viewportHeight + 1);
			}
		}
		this.#requestRender();
	}
	#page(direction: 1 | -1): void {
		this.#followTailActive = false;
		this.#followTailPending = false;
		this.#selected = Math.max(0, Math.min(this.#selected + direction * 5, this.#entries.length - 1));
		this.#scrollOffset += direction * PAGE_SIZE;
		this.#requestRender();
	}
	#toggleExpand(): void {
		this.#followTailActive = false;
		const entry = this.#entries[this.#selected];
		if (!entry || entry.foldable === false) return;
		const expanding = !this.#expanded.has(entry.id);
		if (expanding) this.#expanded.add(entry.id);
		else this.#expanded.delete(entry.id);
		this.#rebuild();
		if (expanding) {
			this.#scrollOffset = this.#renderedEntries[this.#selected]?.lineStart ?? 0;
			this.#skipFollowTailOnce = true;
		}
		this.#requestRender();
	}
	resetSourceState(): void {
		this.#expanded.clear();
		this.#raw.clear();
		this.#scrollOffset = 0;
		this.#initialized = false;
		this.#fullscreen = false;
		this.#skipFollowTailOnce = false;
		this.#followTailPending = false;
		this.#followTailActive = this.#options.followTail === true;
	}

	#copy(metadata: boolean): void {
		const entry = this.#entries[this.#selected];
		if (!entry || entry.copyable === false) return;
		try {
			this.#options.copyToClipboard?.(
				metadata ? JSON.stringify(entry.payload.metadata, null, 2) : entry.payload.text,
			);
		} catch {
			this.#options.onError?.("Failed to copy transcript entry to clipboard.");
		}
	}
	#requestRender(): void {
		this.#options.requestRender?.();
	}
	#rebuild(): void {
		const lines: string[] = [];
		this.#renderedEntries = [];
		const display = this.#fullscreen ? this.#entries.slice(this.#selected, this.#selected + 1) : this.#entries;
		const contentWidth = Math.max(1, this.#width - INDENT.length - 1);
		for (const entry of display) {
			const start = lines.length;
			const selected = entry.id === this.selectedEntryId;
			const expanded = this.#fullscreen || this.#expanded.has(entry.id);
			const raw = this.#raw.has(entry.id);
			lines.push("");
			lines.push(
				`${selected ? theme.fg("accent", "▶") : " "} ${theme.fg("muted", `[${sanitizeText(entry.label ?? entry.kind)}]`)}`,
			);
			const text = sanitizeText(
				(raw
					? entry.payload.text
					: (this.#options.getEntryText?.(entry, expanded) ??
						entry.getDisplayText?.(expanded) ??
						entry.payload.text)
				).trim(),
			);
			if (raw)
				for (const line of text.split("\n"))
					for (const wrapped of wrapTextWithAnsi(line, contentWidth)) lines.push(`${INDENT}${wrapped}`);
			else if (expanded) {
				const rendered = this.#markdown(text, contentWidth);
				const limit = this.#options.maxExpandedLines ?? Number.POSITIVE_INFINITY;
				lines.push(...rendered.slice(0, limit));
				if (rendered.length > limit)
					lines.push(`${INDENT}${theme.fg("dim", `... ${rendered.length - limit} more lines`)}`);
			} else {
				const preview = text.split("\n").slice(0, PREVIEW_LINES);
				for (const line of preview) lines.push(`${INDENT}${truncateToWidth(line, contentWidth)}`);
				if (text.split("\n").length > PREVIEW_LINES) lines.push(`${INDENT}${theme.fg("dim", "... more (Space)")}`);
			}
			this.#renderedEntries.push({ lineStart: start, lineCount: lines.length - start });
		}
		this.#lines = lines.length ? lines : [theme.fg("dim", "No transcript entries yet.")];
	}
	#markdown(text: string, width: number): string[] {
		return new Markdown(text, 0, 0, this.#mdTheme).render(width).map(line => `${INDENT}${line.trimEnd()}`);
	}
}

/** Main-session adapter over the registry's canonical payload resolver. */
export function transcriptViewerEntries(registry: TranscriptItemRegistry): TranscriptViewerEntry[] {
	return registry.items().flatMap(item => {
		const payload = registry.resolveSourcePayload(item.id);
		if (!payload) return [];
		const capabilities = registry.capabilities(item.id);
		const label =
			item.kind === "assistant-text"
				? "Response"
				: item.kind === "assistant-thinking"
					? "Thinking"
					: item.kind === "tool"
						? "Tool"
						: item.kind === "user"
							? "User"
							: item.kind;
		return [{ id: item.id, kind: item.kind, label, payload, ...capabilities }];
	});
}

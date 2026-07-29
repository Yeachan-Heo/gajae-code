import * as crypto from "node:crypto";
import {
	type Component,
	padding,
	renderComponentWithViewportAnchors,
	TERMINAL,
	truncateToWidth,
	type ViewportAnchorProvider,
	type ViewportAnchorRender,
	visibleWidth,
	withTerminalGraphicsFallback,
	wrapTextWithAnsi,
} from "@gajae-code/tui";
import type { IrcObservationLedger, IrcObservationRecord } from "../irc-observation-ledger";
import { formatIrcMessageBlock, projectIrcText } from "../utils/irc-message";

export const IRC_SIDEBAR_WIDTH_RATIO = 0.3;
const IRC_SIDEBAR_MIN_WIDTH = 30;
const IRC_SEPARATOR_WIDTH = 3;
export const IRC_SIDEBAR_MAX_RENDER_ROWS = 2_048;
const IRC_SIDEBAR_MAX_RENDER_SOURCE_UTF8_BYTES = 64 * 1_024;
const IRC_SIDEBAR_OLDER_MESSAGES_ELISION = "… older IRC messages elided …";
const IRC_SIDEBAR_MESSAGE_ELISION = "  … message elided …";

export const __ircSidebarPerfCounters = {
	enabled: false,
	projectionMemoHits: 0,
	projectionMemoMisses: 0,
	recordsVisited: 0,
	sourceBytes: 0,
	rows: 0,
	styledCacheHits: 0,
	styledCacheMisses: 0,
	wrapCalls: 0,
	snapshot() {
		return {
			projectionMemoHits: this.projectionMemoHits,
			projectionMemoMisses: this.projectionMemoMisses,
			recordsVisited: this.recordsVisited,
			sourceBytes: this.sourceBytes,
			rows: this.rows,
			styledCacheHits: this.styledCacheHits,
			styledCacheMisses: this.styledCacheMisses,
			wrapCalls: this.wrapCalls,
		};
	},
	enable(): void {
		this.enabled = true;
	},
	disable(): void {
		this.enabled = false;
	},
	reset(): void {
		this.projectionMemoHits = 0;
		this.projectionMemoMisses = 0;
		this.recordsVisited = 0;
		this.sourceBytes = 0;
		this.rows = 0;
		this.styledCacheHits = 0;
		this.styledCacheMisses = 0;
		this.wrapCalls = 0;
	},
};

/** Computes transcript/sidebar widths while preserving at least half the terminal for the transcript. */
export function computeIrcSplitWidths(width: number): {
	leftWidth: number;
	separatorWidth: number;
	rightWidth: number;
} {
	const normalizedWidth = Math.max(0, Math.floor(width));
	const transcriptFloor = Math.floor(normalizedWidth * 0.5);
	const preferredSidebar = Math.max(IRC_SIDEBAR_MIN_WIDTH, Math.floor(normalizedWidth * IRC_SIDEBAR_WIDTH_RATIO));
	const sidebarWidth = Math.max(
		0,
		Math.min(preferredSidebar, normalizedWidth - IRC_SEPARATOR_WIDTH - transcriptFloor),
	);
	if (sidebarWidth < IRC_SIDEBAR_MIN_WIDTH) return { leftWidth: normalizedWidth, separatorWidth: 0, rightWidth: 0 };
	return {
		leftWidth: normalizedWidth - IRC_SEPARATOR_WIDTH - sidebarWidth,
		separatorWidth: IRC_SEPARATOR_WIDTH,
		rightWidth: sidebarWidth,
	};
}
/**
 * Resolves the single shared work-lane geometry. The left lane is used by both
 * transcript and todo content whenever the IRC lane is effective.
 */
export function computeIrcWorkLaneWidths(
	width: number,
	sidebarVisible: boolean,
): { leftWidth: number; separatorWidth: number; rightWidth: number } {
	const fullWidth = Math.max(0, Math.floor(width));
	return sidebarVisible
		? computeIrcSplitWidths(fullWidth)
		: { leftWidth: fullWidth, separatorWidth: 0, rightWidth: 0 };
}

export class IrcLeftLaneComponent implements Component {
	constructor(
		private readonly content: Component,
		private readonly isSidebarVisible: (width: number) => boolean,
	) {}

	render(width: number): string[] {
		const layout = computeIrcWorkLaneWidths(width, this.isSidebarVisible(width));
		return this.content.render(layout.leftWidth);
	}

	invalidate(): void {
		this.content.invalidate?.();
	}
}

type SemanticLine = Readonly<{
	kind: "header" | "body" | "elision" | "blank";
	text: string;
	sender?: string;
	recipient?: string;
	time?: string;
}>;
export type IrcSidebarSemanticProjection = Readonly<{ token: string; lines: readonly SemanticLine[] }>;
const projectionMemo = new WeakMap<
	IrcObservationLedger,
	{ epoch: number; width: number; projection: IrcSidebarSemanticProjection }
>();

function semanticProjectionToken(lines: readonly SemanticLine[]): string {
	const hash = crypto.createHash("sha256");
	const length = Buffer.allocUnsafe(4);
	const writeField = (value: string | undefined): void => {
		length.writeUInt32BE(value === undefined ? 0xffffffff : Buffer.byteLength(value, "utf8"));
		hash.update(length);
		if (value !== undefined) hash.update(value, "utf8");
	};

	hash.update("gjc:irc:sidebar-semantic-projection:v1\0");
	length.writeUInt32BE(lines.length);
	hash.update(length);
	for (const line of lines) {
		writeField(line.kind);
		writeField(line.text);
		writeField(line.sender);
		writeField(line.recipient);
		writeField(line.time);
	}
	return hash.digest("hex");
}

function projectRecord(
	record: IrcObservationRecord,
	width: number,
	maxRows: number,
	maxSourceUtf8Bytes: number,
): { lines: SemanticLine[]; sourceUtf8Bytes: number; truncated: boolean } {
	const bodyWidth = Math.max(1, width - 2);
	const sourceLimit = Math.min(maxSourceUtf8Bytes, Math.max(0, maxRows - 1) * bodyWidth);
	const clipped = projectIrcText(record.text, sourceLimit);
	const block = formatIrcMessageBlock({ ...record, text: clipped.text });
	const lines: SemanticLine[] = [
		{
			kind: "header",
			text: `${block.sender} → ${block.recipient} · ${block.time}`,
			sender: block.sender,
			recipient: block.recipient,
			time: block.time,
		},
	];
	let truncated = clipped.truncated;
	body: for (const bodyLine of block.bodyLines) {
		if (__ircSidebarPerfCounters.enabled) __ircSidebarPerfCounters.wrapCalls++;
		for (const wrappedLine of wrapTextWithAnsi(bodyLine, bodyWidth)) {
			if (lines.length >= maxRows) {
				truncated = true;
				break body;
			}
			lines.push({ kind: "body", text: `  ${wrappedLine}` });
		}
	}
	if (truncated && maxRows > 1) {
		const marker: SemanticLine = { kind: "elision", text: IRC_SIDEBAR_MESSAGE_ELISION };
		if (lines.length >= maxRows) lines[maxRows - 1] = marker;
		else lines.push(marker);
	}
	return { lines, sourceUtf8Bytes: clipped.utf8Bytes, truncated };
}

/** The authoritative bounded, display-neutral IRC sidebar projection. */
export function getIrcSidebarSemanticProjection(
	ledger: IrcObservationLedger,
	width: number,
): IrcSidebarSemanticProjection {
	if (width <= 0) return { token: "", lines: [] };
	const memo = projectionMemo.get(ledger);
	const cachedProjection = memo?.epoch === ledger.mutationEpoch && memo.width === width ? memo.projection : undefined;
	if (cachedProjection) {
		if (__ircSidebarPerfCounters.enabled) __ircSidebarPerfCounters.projectionMemoHits++;
		return cachedProjection;
	}
	if (__ircSidebarPerfCounters.enabled) __ircSidebarPerfCounters.projectionMemoMisses++;
	const newestFirstBlocks: SemanticLine[][] = [];
	let renderedRows = 0;
	let renderedSourceUtf8Bytes = 0;
	let omittedOlderRecords = false;
	const records = ledger.getSidebarRecords();
	for (let index = records.length - 1; index >= 0; index--) {
		if (__ircSidebarPerfCounters.enabled) __ircSidebarPerfCounters.recordsVisited++;
		const separatorRows = newestFirstBlocks.length > 0 ? 1 : 0;
		const availableRows = IRC_SIDEBAR_MAX_RENDER_ROWS - renderedRows - separatorRows - 2;
		const availableSourceUtf8Bytes = IRC_SIDEBAR_MAX_RENDER_SOURCE_UTF8_BYTES - renderedSourceUtf8Bytes;
		const minimumRecordRows = records[index].text.length > 0 ? 2 : 1;
		if (availableRows < minimumRecordRows || (availableSourceUtf8Bytes <= 0 && records[index].text.length > 0)) {
			omittedOlderRecords = true;
			break;
		}
		const projected = projectRecord(records[index], width, availableRows, availableSourceUtf8Bytes);
		newestFirstBlocks.push(projected.lines);
		renderedRows += separatorRows + projected.lines.length;
		renderedSourceUtf8Bytes += projected.sourceUtf8Bytes;
		if (__ircSidebarPerfCounters.enabled) __ircSidebarPerfCounters.sourceBytes += projected.sourceUtf8Bytes;
		if (projected.truncated) {
			omittedOlderRecords = index > 0;
			break;
		}
	}
	const lines: SemanticLine[] = omittedOlderRecords
		? [{ kind: "elision", text: IRC_SIDEBAR_OLDER_MESSAGES_ELISION }]
		: [];
	for (const block of newestFirstBlocks.reverse()) {
		if (lines.length > 0) lines.push({ kind: "blank", text: "" });
		lines.push(...block);
	}
	const bounded = lines.slice(0, IRC_SIDEBAR_MAX_RENDER_ROWS);
	if (__ircSidebarPerfCounters.enabled) __ircSidebarPerfCounters.rows += bounded.length;
	const projection = { token: semanticProjectionToken(bounded), lines: bounded };
	projectionMemo.set(ledger, { epoch: ledger.mutationEpoch, width, projection });
	return projection;
}

export function getIrcSidebarSemanticToken(ledger: IrcObservationLedger, width: number): string {
	return getIrcSidebarSemanticProjection(ledger, width).token;
}

export interface IrcSidebarTheme {
	fg(color: "dim" | "accent", text: string): string;
	bold(text: string): string;
	readonly boxSharp: { readonly vertical: string };
}
export type IrcSidebarThemeSource = IrcSidebarTheme | (() => IrcSidebarTheme);

/** Read-only IRC history alongside the active transcript. */
export class IrcSplitViewComponent implements ViewportAnchorProvider {
	#visible = false;
	#themeGeneration = 0;
	#styledMemo:
		| { token: string; width: number; themeGeneration: number; theme: IrcSidebarTheme; lines: string[] }
		| undefined;

	constructor(
		private readonly leftPane: Component,
		private readonly ledger: IrcObservationLedger,
		private readonly componentTheme: IrcSidebarThemeSource,
	) {}
	get visible(): boolean {
		return this.#visible;
	}
	effectiveSidebarVisible(width = process.stdout.columns ?? 0): boolean {
		return this.#visible && computeIrcSplitWidths(width).rightWidth > 0;
	}
	setVisible(visible: boolean): void {
		if (this.#visible !== visible) {
			this.#visible = visible;
			this.invalidate();
		}
	}
	invalidateTheme(): void {
		this.#themeGeneration++;
		this.#styledMemo = undefined;
	}
	resetSource(): void {
		projectionMemo.delete(this.ledger);
		this.#styledMemo = undefined;
	}
	render(width: number): string[] {
		return this.renderWithViewportAnchors(width).lines;
	}
	#renderSidebar(width: number, componentTheme: IrcSidebarTheme): string[] {
		const projection = getIrcSidebarSemanticProjection(this.ledger, width);
		const cached = this.#styledMemo;
		if (
			cached?.token === projection.token &&
			cached.width === width &&
			cached.themeGeneration === this.#themeGeneration &&
			cached.theme === componentTheme
		) {
			if (__ircSidebarPerfCounters.enabled) __ircSidebarPerfCounters.styledCacheHits++;
			return cached.lines;
		}
		if (__ircSidebarPerfCounters.enabled) __ircSidebarPerfCounters.styledCacheMisses++;
		const lines = projection.lines.map(line => {
			if (line.kind === "header")
				return truncateToWidth(
					`${componentTheme.fg("accent", componentTheme.bold(line.sender!))} → ${line.recipient} · ${componentTheme.fg("dim", line.time!)}`,
					width,
				);
			return truncateToWidth(line.kind === "elision" ? componentTheme.fg("dim", line.text) : line.text, width);
		});
		this.#styledMemo = {
			token: projection.token,
			width,
			themeGeneration: this.#themeGeneration,
			theme: componentTheme,
			lines,
		};
		return lines;
	}
	renderWithViewportAnchors(width: number): ViewportAnchorRender {
		if (!this.#visible) return renderComponentWithViewportAnchors(this.leftPane, width);
		const componentTheme = typeof this.componentTheme === "function" ? this.componentTheme() : this.componentTheme;
		const { leftWidth, separatorWidth, rightWidth } = computeIrcWorkLaneWidths(width, this.#visible);
		if (rightWidth === 0) return renderComponentWithViewportAnchors(this.leftPane, width);
		const separator = separatorWidth > 0 ? componentTheme.fg("dim", ` ${componentTheme.boxSharp.vertical} `) : "";
		const leftRender = withTerminalGraphicsFallback(
			() => renderComponentWithViewportAnchors(this.leftPane, leftWidth),
			{ allowCursorNeutralImages: true },
		);
		const rightLines = this.#renderSidebar(rightWidth, componentTheme);
		const lineCount = Math.max(leftRender.lines.length, rightLines.length);
		const lines: string[] = [];
		const anchors: ViewportAnchorRender["anchors"] = [];
		const leftOffset = lineCount - leftRender.lines.length;
		const rightOffset = lineCount - rightLines.length;
		for (let index = 0; index < lineCount; index++) {
			const leftIndex = index - leftOffset;
			const leftRaw = leftRender.lines[leftIndex] ?? "";
			const right = truncateToWidth(rightLines[index - rightOffset] ?? "", rightWidth);
			if (TERMINAL.isImageLine(leftRaw)) lines.push(leftRaw + padding(leftWidth) + separator + right);
			else {
				const left = truncateToWidth(leftRaw, leftWidth);
				lines.push(left + padding(Math.max(0, leftWidth - visibleWidth(left))) + separator + right);
			}
			anchors.push(leftRender.anchors[leftIndex] ?? null);
		}
		return { lines, anchors };
	}
	invalidate(): void {
		this.leftPane.invalidate?.();
	}
}

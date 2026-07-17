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

	// The sidebar yields entirely rather than rendering below its readable minimum.
	if (sidebarWidth < IRC_SIDEBAR_MIN_WIDTH) {
		return { leftWidth: normalizedWidth, separatorWidth: 0, rightWidth: 0 };
	}

	return {
		leftWidth: normalizedWidth - IRC_SEPARATOR_WIDTH - sidebarWidth,
		separatorWidth: IRC_SEPARATOR_WIDTH,
		rightWidth: sidebarWidth,
	};
}

function styleSender(componentTheme: IrcSidebarTheme, sender: string): string {
	return componentTheme.fg("accent", componentTheme.bold(sender));
}

function renderSidebarRecord(
	record: IrcObservationRecord,
	width: number,
	componentTheme: IrcSidebarTheme,
	maxRows: number,
	maxSourceUtf8Bytes: number,
): { lines: string[]; sourceUtf8Bytes: number; truncated: boolean } {
	const bodyWidth = Math.max(1, width - 2);
	const sourceLimit = Math.min(maxSourceUtf8Bytes, Math.max(0, maxRows - 1) * bodyWidth);
	const clipped = projectIrcText(record.text, sourceLimit);
	const block = formatIrcMessageBlock({ ...record, text: clipped.text });
	const sender = styleSender(componentTheme, block.sender);
	const time = componentTheme.fg("dim", block.time);
	const lines = [truncateToWidth(`${sender} → ${block.recipient} · ${time}`, width)];
	let truncated = clipped.truncated;

	body: for (const bodyLine of block.bodyLines) {
		for (const wrappedLine of wrapTextWithAnsi(bodyLine, bodyWidth)) {
			if (lines.length >= maxRows) {
				truncated = true;
				break body;
			}
			lines.push(truncateToWidth(`  ${wrappedLine}`, width));
		}
	}
	if (truncated && maxRows > 1) {
		const marker = componentTheme.fg("dim", IRC_SIDEBAR_MESSAGE_ELISION);
		if (lines.length >= maxRows) lines[maxRows - 1] = truncateToWidth(marker, width);
		else lines.push(truncateToWidth(marker, width));
	}
	return { lines, sourceUtf8Bytes: clipped.utf8Bytes, truncated };
}

function renderSidebarRecords(ledger: IrcObservationLedger, width: number, componentTheme: IrcSidebarTheme): string[] {
	if (width <= 0) return [];

	const records = ledger.getSidebarRecords();
	const newestFirstBlocks: string[][] = [];
	let renderedRows = 0;
	let renderedSourceUtf8Bytes = 0;
	let omittedOlderRecords = false;
	for (let index = records.length - 1; index >= 0; index--) {
		const separatorRows = newestFirstBlocks.length > 0 ? 1 : 0;
		const availableRows = IRC_SIDEBAR_MAX_RENDER_ROWS - renderedRows - separatorRows - 2;
		const availableSourceUtf8Bytes = IRC_SIDEBAR_MAX_RENDER_SOURCE_UTF8_BYTES - renderedSourceUtf8Bytes;
		const minimumRecordRows = records[index].text.length > 0 ? 2 : 1;
		if (availableRows < minimumRecordRows || (availableSourceUtf8Bytes <= 0 && records[index].text.length > 0)) {
			omittedOlderRecords = true;
			break;
		}

		const rendered = renderSidebarRecord(
			records[index],
			width,
			componentTheme,
			availableRows,
			availableSourceUtf8Bytes,
		);
		newestFirstBlocks.push(rendered.lines);
		renderedRows += separatorRows + rendered.lines.length;
		renderedSourceUtf8Bytes += rendered.sourceUtf8Bytes;
		if (rendered.truncated) {
			omittedOlderRecords = index > 0;
			break;
		}
	}

	const lines: string[] = [];
	if (omittedOlderRecords) {
		lines.push(truncateToWidth(componentTheme.fg("dim", IRC_SIDEBAR_OLDER_MESSAGES_ELISION), width));
	}
	for (const block of newestFirstBlocks.reverse()) {
		if (lines.length > 0) lines.push("");
		lines.push(...block);
	}
	return lines.slice(0, IRC_SIDEBAR_MAX_RENDER_ROWS);
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
		if (this.#visible === visible) return;
		this.#visible = visible;
		this.invalidate();
	}

	render(width: number): string[] {
		return this.renderWithViewportAnchors(width).lines;
	}

	renderWithViewportAnchors(width: number): ViewportAnchorRender {
		if (!this.#visible) return renderComponentWithViewportAnchors(this.leftPane, width);

		const componentTheme = typeof this.componentTheme === "function" ? this.componentTheme() : this.componentTheme;
		const { leftWidth, separatorWidth, rightWidth } = computeIrcSplitWidths(width);
		if (rightWidth === 0) return renderComponentWithViewportAnchors(this.leftPane, width);

		const separatorText = componentTheme.fg("dim", ` ${componentTheme.boxSharp.vertical} `);
		const separator = separatorWidth > 0 ? separatorText : "";
		const leftRender = withTerminalGraphicsFallback(
			() => renderComponentWithViewportAnchors(this.leftPane, leftWidth),
			{ allowCursorNeutralImages: true },
		);
		const rightLines = renderSidebarRecords(this.ledger, rightWidth, componentTheme);
		const lineCount = Math.max(leftRender.lines.length, rightLines.length);
		const lines: string[] = [];
		const anchors: ViewportAnchorRender["anchors"] = [];

		const leftOffset = lineCount - leftRender.lines.length;
		const rightOffset = lineCount - rightLines.length;
		for (let index = 0; index < lineCount; index++) {
			const leftIndex = index - leftOffset;
			const leftRaw = leftRender.lines[leftIndex] ?? "";
			const right = truncateToWidth(rightLines[index - rightOffset] ?? "", rightWidth);
			if (TERMINAL.isImageLine(leftRaw)) {
				lines.push(leftRaw + padding(leftWidth) + separator + right);
			} else {
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

import type { Component } from "../tui";

import {
	annotateViewportAnchorGraphemes,
	applyBackgroundToLine,
	extractViewportAnchorRows,
	padding,
	replaceTabs,
	type ViewportAnchorSpan,
	visibleWidth,
	wrapTextWithAnsi,
} from "../utils";

/**
 * Text component - displays multi-line text with word wrapping
 */
export class Text implements Component {
	#text: string;
	#paddingX: number; // Left/right padding
	#paddingY: number; // Top/bottom padding
	#customBgFn?: (text: string) => string;

	// Cache for rendered output
	#cachedText?: string;
	#cachedWidth?: number;
	#cachedLines?: string[];
	#cachedAnchorSpans?: Array<ViewportAnchorSpan | null>;

	constructor(text: string = "", paddingX: number = 1, paddingY: number = 1, customBgFn?: (text: string) => string) {
		this.#text = text;
		this.#paddingX = paddingX;
		this.#paddingY = paddingY;
		this.#customBgFn = customBgFn;
	}

	getText(): string {
		return this.#text;
	}

	setText(text: string): void {
		this.#text = text;
		this.#cachedText = undefined;
		this.#cachedWidth = undefined;
		this.#cachedLines = undefined;
		this.#cachedAnchorSpans = undefined;
	}

	setCustomBgFn(customBgFn?: (text: string) => string): void {
		this.#customBgFn = customBgFn;
		this.#cachedText = undefined;
		this.#cachedWidth = undefined;
		this.#cachedLines = undefined;
		this.#cachedAnchorSpans = undefined;
	}

	invalidate(): void {
		this.#cachedText = undefined;
		this.#cachedWidth = undefined;
		this.#cachedLines = undefined;
		this.#cachedAnchorSpans = undefined;
	}

	render(width: number): string[] {
		return this.#render(width, false).lines;
	}

	#render(width: number, includeAnchors: boolean): { lines: string[]; spans?: Array<ViewportAnchorSpan | null> } {
		if (
			this.#cachedLines &&
			this.#cachedText === this.#text &&
			this.#cachedWidth === width &&
			(!includeAnchors || this.#cachedAnchorSpans !== undefined)
		) {
			return { lines: this.#cachedLines, spans: this.#cachedAnchorSpans };
		}

		if (!this.#text || this.#text.trim() === "") {
			const result: string[] = [];
			this.#cachedText = this.#text;
			this.#cachedWidth = width;
			this.#cachedLines = result;
			this.#cachedAnchorSpans = includeAnchors ? [] : undefined;
			return { lines: result, spans: this.#cachedAnchorSpans };
		}

		const normalizedText = replaceTabs(this.#text);
		const contentWidth = Math.max(1, width - this.#paddingX * 2);
		let wrappedLines: string[];
		let wrappedSpans: Array<ViewportAnchorSpan | null> | undefined;
		if (includeAnchors) {
			const markedText = annotateViewportAnchorGraphemes(normalizedText);
			const extracted = extractViewportAnchorRows(wrapTextWithAnsi(markedText.text, contentWidth), markedText.token);
			wrappedLines = extracted.lines;
			wrappedSpans = extracted.spans;
		} else {
			wrappedLines = wrapTextWithAnsi(normalizedText, contentWidth);
		}

		const leftMargin = padding(this.#paddingX);
		const rightMargin = padding(this.#paddingX);
		const contentLines: string[] = [];
		for (const line of wrappedLines) {
			const lineWithMargins = leftMargin + line + rightMargin;
			if (this.#customBgFn) contentLines.push(applyBackgroundToLine(lineWithMargins, width, this.#customBgFn));
			else contentLines.push(lineWithMargins + padding(Math.max(0, width - visibleWidth(lineWithMargins))));
		}
		const emptyLine = padding(width);
		const emptyLines = Array.from({ length: this.#paddingY }, () =>
			this.#customBgFn ? applyBackgroundToLine(emptyLine, width, this.#customBgFn) : emptyLine,
		);
		const result = [...emptyLines, ...contentLines, ...emptyLines];
		const spans = wrappedSpans && [...emptyLines.map(() => null), ...wrappedSpans, ...emptyLines.map(() => null)];
		this.#cachedText = this.#text;
		this.#cachedWidth = width;
		this.#cachedLines = result;
		this.#cachedAnchorSpans = spans;
		return { lines: result.length > 0 ? result : [""], spans };
	}

	renderWithViewportAnchorSource(
		width: number,
		source: { id: string },
	): {
		lines: string[];
		anchors: Array<({ id: string } & ViewportAnchorSpan) | null>;
	} {
		const { lines, spans } = this.#render(width, true);
		if (!spans) throw new Error("Viewport anchor source render completed without row spans");
		return {
			lines,
			anchors: spans.map(span => (span ? { id: source.id, ...span } : null)),
		};
	}
}

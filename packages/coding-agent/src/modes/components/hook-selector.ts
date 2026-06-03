/**
 * Generic selector component for hooks.
 * Displays a list of string options with keyboard navigation.
 */
import {
	Container,
	Markdown,
	matchesKey,
	padding,
	renderInlineMarkdown,
	replaceTabs,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@gajae-code/tui";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { matchesAppExternalEditor, matchesSelectCancel } from "../../modes/utils/keybinding-matchers";
import { CountdownTimer } from "./countdown-timer";
import { DynamicBorder } from "./dynamic-border";

export interface HookSelectorOptions {
	tui?: TUI;
	timeout?: number;
	onTimeout?: () => void;
	initialIndex?: number;
	outline?: boolean;
	maxVisible?: number;
	onLeft?: () => void;
	onRight?: () => void;
	onExternalEditor?: () => void;
	helpText?: string;
	/**
	 * When true, the focused option's label wraps across multiple rows so the
	 * full text is visible. Non-focused options remain single-row with the
	 * existing `…` truncation hint. When unset/false, rendering is
	 * byte-identical to the previous implementation for all consumers.
	 */
	wrapFocused?: boolean;
	scrollTitleRows?: number;
}

class OutlinedList extends Container {
	#lines: string[] = [];

	setLines(lines: string[]): void {
		this.#lines = lines;
		this.invalidate();
	}

	render(width: number): string[] {
		const borderColor = (text: string) => theme.fg("border", text);
		const horizontal = borderColor(theme.boxSharp.horizontal.repeat(Math.max(1, width)));
		const innerWidth = Math.max(1, width - 2);
		const content = this.#lines.map(line => {
			const normalized = replaceTabs(line);
			const fitted = truncateToWidth(normalized, innerWidth);
			const pad = Math.max(0, innerWidth - visibleWidth(fitted));
			return `${borderColor(theme.boxSharp.vertical)}${fitted}${padding(pad)}${borderColor(theme.boxSharp.vertical)}`;
		});
		return [horizontal, ...content, horizontal];
	}
}

class ScrollableTitle extends Container {
	#markdown: Markdown;
	#maxRows: number;
	#scrollOffset = 0;
	#lastMaxScrollOffset = 0;

	constructor(title: string, maxRows: number) {
		super();
		this.#maxRows = Math.max(1, Math.floor(maxRows));
		this.#markdown = new Markdown(title, 1, 0, getMarkdownTheme(), { color: t => theme.fg("accent", t) });
	}

	setText(text: string): void {
		this.#markdown.setText(text);
		this.#scrollOffset = 0;
		this.invalidate();
	}

	scrollBy(rows: number): void {
		if (rows === 0) return;
		const nextOffset = Math.max(0, Math.min(this.#lastMaxScrollOffset, this.#scrollOffset + rows));
		if (nextOffset === this.#scrollOffset) return;
		this.#scrollOffset = nextOffset;
		this.invalidate();
	}

	render(width: number): string[] {
		const lines = this.#markdown.render(width);
		const maxScrollOffset = Math.max(0, lines.length - this.#maxRows);
		this.#lastMaxScrollOffset = maxScrollOffset;
		this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, maxScrollOffset));

		const visibleLines = lines.slice(this.#scrollOffset, this.#scrollOffset + this.#maxRows);
		if (maxScrollOffset === 0 || visibleLines.length === 0) {
			return visibleLines;
		}

		const indicator =
			this.#scrollOffset === 0
				? theme.fg("dim", " PgDn↓")
				: this.#scrollOffset >= maxScrollOffset
					? theme.fg("dim", " PgUp↑")
					: theme.fg("dim", " PgUp/PgDn↕");
		const lastIndex = visibleLines.length - 1;
		const availableWidth = Math.max(1, width - visibleWidth(indicator));
		const fittedLine = truncateToWidth(visibleLines[lastIndex] ?? "", availableWidth);
		visibleLines[lastIndex] = `${fittedLine}${indicator}`;
		return visibleLines;
	}
}

/**
 * Width-aware list child that owns wrapped focused-option layout.
 *
 * Single layout owner for the `wrapFocused` branch: row budgeting, sibling
 * selection, marker placement, and finalized row construction all happen
 * inside `render(width)` using the actual incoming width. The outer host
 * (`HookSelectorComponent`) feeds it `options`, `selectedIndex`, and
 * `maxVisibleRows`; everything that depends on terminal width is recomputed
 * on each render so resize Just Works.
 *
 * `maxVisibleRows` is a sibling budget before it is a hard cap: surrounding
 * options shrink first so the focused option is never clipped. The single
 * allowed overflow exception is when the focused option's wrapped block
 * alone exceeds the budget — in that case the focused option is rendered
 * fully with zero siblings.
 */
class FocusAwareList extends Container {
	#options: string[] = [];
	#selectedIndex = 0;
	#maxVisibleRows = 0;
	#outline: boolean;

	constructor(outline: boolean) {
		super();
		this.#outline = outline;
	}

	setState(options: string[], selectedIndex: number, maxVisibleRows: number): void {
		this.#options = options;
		this.#selectedIndex = Math.max(0, Math.min(selectedIndex, options.length - 1));
		this.#maxVisibleRows = Math.max(1, maxVisibleRows);
		this.invalidate();
	}

	render(width: number): string[] {
		if (this.#options.length === 0) return this.#outline ? this.#wrapOutline([], width) : [];

		const mdTheme = getMarkdownTheme();
		const innerWidth = this.#outline ? Math.max(1, width - 2) : Math.max(1, width);

		// Selected/non-selected prefixes mirror the legacy `#updateList` shape.
		const styledSelectedPrefix = theme.fg("accent", `${theme.nav.cursor} `);
		const nonSelectedPrefix = "  ";
		const prefixWidth = visibleWidth(styledSelectedPrefix);
		const continuationPrefix = " ".repeat(prefixWidth);
		const availableLabelWidth = Math.max(1, innerWidth - prefixWidth);

		// Render the focused label up front so we can measure how many rows it
		// will consume at the current width and budget siblings accordingly.
		const focusedLabel = renderInlineMarkdown(this.#options[this.#selectedIndex] ?? "", mdTheme, t =>
			theme.fg("accent", t),
		);
		const focusedWrappedSegments = wrapTextWithAnsi(focusedLabel, availableLabelWidth);
		const focusedRows = Math.max(1, focusedWrappedSegments.length);

		// Decide whether the position marker is going to be shown. We make a
		// pessimistic first pass assuming the marker is needed; if the window
		// ends up covering every option we drop it.
		const totalOptions = this.#options.length;
		const willHaveSiblings = totalOptions > 1;
		const wouldNeedMarker = willHaveSiblings; // tentative; refined below
		const markerSlot = wouldNeedMarker ? 1 : 0;

		// Sibling budget. If the focused block alone is over budget, render it
		// fully with zero siblings (only allowed overflow exception).
		const siblingBudget = Math.max(0, this.#maxVisibleRows - focusedRows - markerSlot);

		// Distribute sibling slots around focus, preferring closest options.
		const availableAbove = this.#selectedIndex;
		const availableBelow = totalOptions - this.#selectedIndex - 1;
		let above = Math.min(availableAbove, Math.floor(siblingBudget / 2));
		let below = Math.min(availableBelow, siblingBudget - above);
		// Transfer unused quota across the focus when one side has fewer
		// options than its share.
		const unusedBelow = siblingBudget - above - below;
		if (unusedBelow > 0) above = Math.min(availableAbove, above + unusedBelow);
		const unusedAbove = siblingBudget - above - below;
		if (unusedAbove > 0) below = Math.min(availableBelow, below + unusedAbove);

		const startIndex = this.#selectedIndex - above;
		const endIndex = this.#selectedIndex + below + 1;
		const showMarker = startIndex > 0 || endIndex < totalOptions;

		const rows: string[] = [];
		for (let i = startIndex; i < endIndex; i++) {
			if (i === this.#selectedIndex) {
				// Emit focused wrapped rows. Cursor only on row 0; continuation
				// rows are whitespace-aligned under the label start.
				for (let r = 0; r < focusedWrappedSegments.length; r++) {
					const segment = focusedWrappedSegments[r] ?? "";
					rows.push(r === 0 ? styledSelectedPrefix + segment : continuationPrefix + segment);
				}
			} else {
				const label = renderInlineMarkdown(this.#options[i] ?? "", mdTheme, t => theme.fg("text", t));
				// Non-focused rows stay single-line. Truncate here so the
				// outline (post-padded by `#wrapOutline`) and non-outline
				// paths render the same `…` hint for over-wide labels.
				const fittedLabel = truncateToWidth(label, availableLabelWidth);
				rows.push(nonSelectedPrefix + fittedLabel);
			}
		}

		if (showMarker) {
			rows.push(theme.fg("dim", `  (${this.#selectedIndex + 1}/${totalOptions})`));
		}

		return this.#outline ? this.#wrapOutline(rows, width) : rows;
	}

	#wrapOutline(rows: string[], width: number): string[] {
		// Mirror the outline border drawn by `OutlinedList.render(width)`. The
		// rows passed in are already constrained to `innerWidth` by
		// `wrapTextWithAnsi`, so we only normalize tabs and pad — no further
		// truncation, which would clip wrapped focused labels.
		const borderColor = (text: string) => theme.fg("border", text);
		const horizontal = borderColor(theme.boxSharp.horizontal.repeat(Math.max(1, width)));
		const innerWidth = Math.max(1, width - 2);
		const content = rows.map(line => {
			const normalized = replaceTabs(line);
			const fitted = truncateToWidth(normalized, innerWidth);
			const pad = Math.max(0, innerWidth - visibleWidth(fitted));
			return `${borderColor(theme.boxSharp.vertical)}${fitted}${padding(pad)}${borderColor(theme.boxSharp.vertical)}`;
		});
		return [horizontal, ...content, horizontal];
	}
}

export class HookSelectorComponent extends Container {
	#options: string[];
	#selectedIndex: number;
	#maxVisible: number;
	#listContainer: Container | undefined;
	#outlinedList: OutlinedList | undefined;
	#focusAwareList: FocusAwareList | undefined;
	#onSelectCallback: (option: string) => void;
	#onCancelCallback: () => void;
	#titleComponent: Markdown | ScrollableTitle;
	#scrollableTitle: ScrollableTitle | undefined;
	#baseTitle: string;
	#countdown: CountdownTimer | undefined;
	#onLeftCallback: (() => void) | undefined;
	#onRightCallback: (() => void) | undefined;
	#onExternalEditorCallback: (() => void) | undefined;
	#wrapFocused: boolean;
	#outline: boolean;
	#scrollTitleRows: number | undefined;
	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: HookSelectorOptions,
	) {
		super();

		this.#options = options;
		this.#selectedIndex = Math.min(opts?.initialIndex ?? 0, options.length - 1);
		this.#maxVisible = Math.max(3, opts?.maxVisible ?? 12);
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		this.#baseTitle = title;
		this.#onLeftCallback = opts?.onLeft;
		this.#onRightCallback = opts?.onRight;
		this.#onExternalEditorCallback = opts?.onExternalEditor;
		this.#wrapFocused = opts?.wrapFocused === true;
		this.#outline = opts?.outline === true;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		const scrollTitleRows =
			opts?.scrollTitleRows === undefined ? undefined : Math.max(1, Math.floor(opts.scrollTitleRows));
		this.#scrollTitleRows = scrollTitleRows;
		if (scrollTitleRows === undefined) {
			this.#titleComponent = new Markdown(title, 1, 0, getMarkdownTheme(), { color: t => theme.fg("accent", t) });
		} else {
			this.#scrollableTitle = new ScrollableTitle(title, scrollTitleRows);
			this.#titleComponent = this.#scrollableTitle;
		}
		this.addChild(this.#titleComponent);
		this.addChild(new Spacer(1));

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.#countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				s => this.#titleComponent.setText(`${this.#baseTitle} (${s}s)`),
				() => {
					opts?.onTimeout?.();
					// Auto-select current option on timeout (typically the first/recommended option)
					const selected = this.#options[this.#selectedIndex];
					if (selected) {
						this.#onSelectCallback(selected);
					} else {
						this.#onCancelCallback();
					}
				},
			);
		}

		if (this.#wrapFocused) {
			// Width-aware child owns wrapped layout. It handles both outline
			// and non-outline rendering paths internally so the cursor signal
			// + continuation indent are identical across branches.
			this.#focusAwareList = new FocusAwareList(this.#outline);
			this.addChild(this.#focusAwareList);
		} else if (this.#outline) {
			this.#outlinedList = new OutlinedList();
			this.addChild(this.#outlinedList);
		} else {
			this.#listContainer = new Container();
			this.addChild(this.#listContainer);
		}
		this.addChild(new Spacer(1));
		const controlsHint = opts?.helpText ?? "up/down navigate  enter select  esc cancel";
		this.addChild(new Text(theme.fg("dim", controlsHint), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.#updateList();
	}

	#updateList(): void {
		if (this.#wrapFocused && this.#focusAwareList) {
			this.#focusAwareList.setState(this.#options, this.#selectedIndex, this.#maxVisible);
			return;
		}

		// Legacy branch — byte-identical to the previous implementation. Any
		// change here is a regression against
		// `BASELINE_OUTLINED_RENDER_80_STRIPPED` in
		// `packages/coding-agent/test/hook-selector-overflow.test.ts`.
		const lines: string[] = [];
		const startIndex = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(this.#maxVisible / 2), this.#options.length - this.#maxVisible),
		);
		const endIndex = Math.min(startIndex + this.#maxVisible, this.#options.length);

		const mdTheme = getMarkdownTheme();
		for (let i = startIndex; i < endIndex; i++) {
			const isSelected = i === this.#selectedIndex;
			const label = isSelected
				? renderInlineMarkdown(this.#options[i], mdTheme, t => theme.fg("accent", t))
				: renderInlineMarkdown(this.#options[i], mdTheme, t => theme.fg("text", t));
			const prefix = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			lines.push(prefix + label);
		}

		if (startIndex > 0 || endIndex < this.#options.length) {
			lines.push(theme.fg("dim", `  (${this.#selectedIndex + 1}/${this.#options.length})`));
		}
		if (this.#outlinedList) {
			this.#outlinedList.setLines(lines);
			return;
		}
		this.#listContainer?.clear();
		for (const line of lines) {
			this.#listContainer?.addChild(new Text(line, 1, 0));
		}
	}

	handleInput(keyData: string): void {
		// Reset countdown on any interaction
		this.#countdown?.reset();

		if (this.#scrollTitleRows !== undefined && matchesKey(keyData, "pageUp")) {
			this.#scrollableTitle?.scrollBy(-this.#scrollTitleRows);
			return;
		}
		if (this.#scrollTitleRows !== undefined && matchesKey(keyData, "pageDown")) {
			this.#scrollableTitle?.scrollBy(this.#scrollTitleRows);
			return;
		}
		if (matchesKey(keyData, "up") || keyData === "k") {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			this.#updateList();
		} else if (matchesKey(keyData, "down") || keyData === "j") {
			this.#selectedIndex = Math.min(this.#options.length - 1, this.#selectedIndex + 1);
			this.#updateList();
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selected = this.#options[this.#selectedIndex];
			if (selected) this.#onSelectCallback(selected);
		} else if (matchesKey(keyData, "left")) {
			this.#onLeftCallback?.();
		} else if (matchesKey(keyData, "right")) {
			this.#onRightCallback?.();
		} else if (this.#onExternalEditorCallback && matchesAppExternalEditor(keyData)) {
			this.#onExternalEditorCallback();
		} else if (matchesSelectCancel(keyData)) {
			this.#onCancelCallback();
		}
	}

	dispose(): void {
		this.#countdown?.dispose();
	}
}

/**
 * Generic selector component for hooks.
 * Displays a list of string options with keyboard navigation.
 */
import {
	type AutocompleteProvider,
	Container,
	Editor,
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
import { getEditorTheme, getMarkdownTheme, theme } from "../../modes/theme/theme";
import {
	matchesAppExternalEditor,
	matchesAppInterrupt,
	matchesSelectCancel,
} from "../../modes/utils/keybinding-matchers";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
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
	/**
	 * Maximum visible rows for the inline editor in bounded scroll-title selectors.
	 * The editor keeps the full draft and scrolls within this height.
	 */
	inlineEditorMaxHeight?: number;
	/**
	 * Maximum visible autocomplete rows for the inline editor in a bounded selector.
	 * The Editor retains its normal minimum and scroll indicator behavior.
	 */
	inlineAutocompleteMaxVisible?: number;
	/**
	 * Compact bounded-selector chrome while the inline editor is active.
	 * Used only when the terminal cannot fit the normal editor and dropdown rows.
	 */
	compactInlineInput?: boolean;
	/**
	 * Inline free-text entry for the option with this label (e.g. the ask
	 * tool's "Other (type your own)"). Selecting it keeps the title and option
	 * list on screen and opens a prompt-style editor below the list instead of
	 * replacing the whole selector. Enter submits via `onSubmit`; Escape
	 * returns to option selection.
	 */
	customInput?: {
		optionLabel: string;
		onSubmit: (text: string) => void;
	};
	clarificationInput?: {
		optionLabel: string;
		onSubmit: (text: string) => void;
		allowEmpty?: boolean;
	};
	/**
	 * Autocomplete provider for the inline custom-input editor. When present,
	 * the "Other (type your own)" editor gains the same `@` file-link and `/`
	 * completion behavior as the main prompt editor.
	 */
	autocompleteProvider?: AutocompleteProvider;
	/**
	 * Maps raw single-key accelerators to option labels. Unset maps preserve
	 * the legacy selector key handling exactly.
	 */
	acceleratorMap?: Readonly<Record<string, string>>;
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
	#lastRenderWidth?: number;

	constructor(title: string, maxRows: number) {
		super();
		this.#maxRows = Math.max(1, Math.floor(maxRows));
		this.#markdown = new Markdown(title, 1, 0, getMarkdownTheme(), { color: t => theme.fg("accent", t) });
	}

	setText(text: string, resetScroll = true): void {
		this.#markdown.setText(text);
		if (resetScroll) this.#scrollOffset = 0;
		this.invalidate();
	}
	setMaxRows(maxRows: number): void {
		const wasAtBottom = this.#lastMaxScrollOffset > 0 && this.#scrollOffset >= this.#lastMaxScrollOffset;
		this.#maxRows = Math.max(1, Math.floor(maxRows));
		if (wasAtBottom) this.#scrollOffset = Number.MAX_SAFE_INTEGER;
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
		const wasAtBottom = this.#lastMaxScrollOffset > 0 && this.#scrollOffset >= this.#lastMaxScrollOffset;
		let lines: string[];
		if (this.#lastRenderWidth !== undefined && this.#lastRenderWidth !== width) {
			const previous = this.#markdown.renderWithViewportAnchorSource(this.#lastRenderWidth, { id: "title" });
			const previousOffset = Math.min(this.#scrollOffset, previous.anchors.length - 1);
			const previousAnchor =
				previous.anchors[previousOffset] ??
				previous.anchors.slice(previousOffset + 1).find(anchor => anchor !== null) ??
				previous.anchors.slice(0, previousOffset).findLast(anchor => anchor !== null);
			const reflowed = this.#markdown.renderWithViewportAnchorSource(width, { id: "title" });
			lines = reflowed.lines;
			if (previousAnchor) {
				const anchoredLine = reflowed.anchors.findIndex(
					anchor =>
						anchor !== null &&
						anchor.graphemeStart <= previousAnchor.graphemeStart &&
						previousAnchor.graphemeStart < anchor.graphemeEnd,
				);
				if (anchoredLine >= 0) this.#scrollOffset = anchoredLine;
			}
		} else {
			lines = this.#markdown.render(width);
		}
		this.#lastRenderWidth = width;
		if (lines.length <= this.#maxRows) {
			this.#lastMaxScrollOffset = 0;
			this.#scrollOffset = 0;
			return lines;
		}

		if (this.#maxRows < 3) {
			const maxScrollOffset = Math.max(0, lines.length - this.#maxRows);
			this.#lastMaxScrollOffset = maxScrollOffset;
			this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, maxScrollOffset));

			return lines.slice(this.#scrollOffset, this.#scrollOffset + this.#maxRows);
		}

		if (wasAtBottom) {
			// The previous render may have reached the bottom after converging
			// away the bottom indicator. Re-anchor before recomputing indicators
			// so a timer repaint cannot resurrect a stale `▼ more` row.
			this.#scrollOffset = Math.max(0, lines.length - (this.#maxRows - 1));
		}
		let showTopIndicator = this.#scrollOffset > 0;
		let showBottomIndicator = !wasAtBottom;
		let contentRows = 1;
		let maxScrollOffset = 0;

		for (let i = 0; i < 4; i++) {
			contentRows = Math.max(1, this.#maxRows - (showTopIndicator ? 1 : 0) - (showBottomIndicator ? 1 : 0));
			maxScrollOffset = Math.max(0, lines.length - contentRows);
			this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, maxScrollOffset));

			const nextShowTopIndicator = this.#scrollOffset > 0;
			const nextShowBottomIndicator = this.#scrollOffset + contentRows < lines.length;
			if (nextShowTopIndicator === showTopIndicator && nextShowBottomIndicator === showBottomIndicator) {
				break;
			}
			showTopIndicator = nextShowTopIndicator;
			showBottomIndicator = nextShowBottomIndicator;
		}

		this.#lastMaxScrollOffset = maxScrollOffset;

		const visibleLines = lines.slice(this.#scrollOffset, this.#scrollOffset + contentRows);
		const result: string[] = [];
		if (showTopIndicator) result.push(theme.fg("dim", truncateToWidth("▲ more", width)));
		result.push(...visibleLines);
		if (showBottomIndicator) result.push(theme.fg("dim", truncateToWidth("▼ more", width)));
		return result.slice(0, this.#maxRows);
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
 * `maxVisibleRows` is a hard viewport budget for every rendered option-list
 * row. Surrounding options shrink first; if the focused option alone would
 * exceed the remaining budget, it is compacted to contextual rows plus an
 * omitted-rows marker so controls stay reachable for untrusted long labels.
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

		// Reserve one row when a non-full focused block and its sibling window
		// cannot both fit. A full focused block keeps its existing priority.
		const totalOptions = this.#options.length;
		const mustCompactFocused = focusedWrappedSegments.length > this.#maxVisibleRows;
		const mustMarkClippedSiblings =
			focusedWrappedSegments.length < this.#maxVisibleRows &&
			focusedWrappedSegments.length + totalOptions - 1 > this.#maxVisibleRows;
		const positionMarkerSlot = (mustCompactFocused || mustMarkClippedSiblings) && totalOptions > 1 ? 1 : 0;
		const focusedBudget = Math.max(1, this.#maxVisibleRows - positionMarkerSlot);
		const focusedSegments = this.#capFocusedSegments(focusedWrappedSegments, focusedBudget, availableLabelWidth);
		const focusedRows = Math.max(1, focusedSegments.length);

		// Sibling budget. If the focused block consumes the available viewport,
		// render it with zero siblings and the reserved position marker.
		const siblingBudget = Math.max(0, this.#maxVisibleRows - focusedRows - positionMarkerSlot);

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
				for (let r = 0; r < focusedSegments.length; r++) {
					const segment = focusedSegments[r] ?? "";
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

		if (showMarker && rows.length < this.#maxVisibleRows) {
			rows.push(theme.fg("dim", `  (${this.#selectedIndex + 1}/${totalOptions})`));
		}

		return this.#outline ? this.#wrapOutline(rows, width) : rows;
	}

	#capFocusedSegments(segments: string[], maxRows: number, availableLabelWidth: number): string[] {
		const rows = segments.length > 0 ? segments : [""];
		const budget = Math.max(1, Math.floor(maxRows));
		if (rows.length <= budget) return rows;

		if (budget === 1) {
			return [truncateToWidth(rows[0] ?? "", availableLabelWidth)];
		}

		if (budget === 2) {
			return [rows[0] ?? "", truncateToWidth(`… ${rows.length - 1} wrapped rows omitted …`, availableLabelWidth)];
		}

		const tailRows = Math.max(1, Math.floor((budget - 2) / 2));
		const headRows = Math.max(1, budget - 1 - tailRows);
		const omittedRows = Math.max(1, rows.length - headRows - tailRows);
		const marker = truncateToWidth(`… ${omittedRows} wrapped rows omitted …`, availableLabelWidth);
		return [...rows.slice(0, headRows), marker, ...rows.slice(rows.length - tailRows)];
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
	#inlineEditorMaxHeight: number | undefined;
	#customInput: { optionLabel: string; onSubmit: (text: string) => void } | undefined;
	#clarificationInput: { optionLabel: string; onSubmit: (text: string) => void; allowEmpty?: boolean } | undefined;
	#activeInput: { onSubmit: (text: string) => void; allowEmpty?: boolean } | undefined;
	#inputArea: Container;
	#inlineEditor: Editor | undefined;
	#helpTextComponent: Text;
	#baseHelpText: string;
	#tui: TUI | undefined;
	#autocompleteProvider: AutocompleteProvider | undefined;
	#acceleratorMap: Readonly<Record<string, string>> | undefined;
	#inlineAutocompleteMaxVisible: number | undefined;
	#compactInlineInput: boolean;
	#titleSpacer: Spacer;
	#inputSpacer: Spacer;
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
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		this.#baseTitle = title;
		this.#onLeftCallback = opts?.onLeft;
		this.#onRightCallback = opts?.onRight;
		this.#onExternalEditorCallback = opts?.onExternalEditor;
		this.#wrapFocused = opts?.wrapFocused === true;
		this.#outline = opts?.outline === true;
		this.#customInput = opts?.customInput;
		this.#clarificationInput = opts?.clarificationInput;
		this.#tui = opts?.tui;
		this.#autocompleteProvider = opts?.autocompleteProvider;
		this.#acceleratorMap = opts?.acceleratorMap;
		this.#inlineAutocompleteMaxVisible =
			opts?.inlineAutocompleteMaxVisible === undefined
				? undefined
				: Math.max(3, Math.floor(opts.inlineAutocompleteMaxVisible));
		this.#compactInlineInput = opts?.compactInlineInput === true;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		const scrollTitleRows =
			opts?.scrollTitleRows === undefined ? undefined : Math.max(1, Math.floor(opts.scrollTitleRows));
		this.#maxVisible = Math.max(scrollTitleRows === undefined ? 3 : 1, opts?.maxVisible ?? 12);
		this.#scrollTitleRows = scrollTitleRows;
		this.#inlineEditorMaxHeight =
			opts?.inlineEditorMaxHeight === undefined ? undefined : Math.max(1, Math.floor(opts.inlineEditorMaxHeight));
		if (scrollTitleRows === undefined) {
			this.#titleComponent = new Markdown(title, 1, 0, getMarkdownTheme(), { color: t => theme.fg("accent", t) });
		} else {
			this.#scrollableTitle = new ScrollableTitle(title, scrollTitleRows);
			this.#titleComponent = this.#scrollableTitle;
		}
		this.addChild(this.#titleComponent);
		this.#titleSpacer = new Spacer(1);
		this.addChild(this.#titleSpacer);

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.#countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				s => {
					if (this.#scrollableTitle) {
						this.#scrollableTitle.setText(`${this.#baseTitle} (${s}s)`, false);
					} else {
						this.#titleComponent.setText(`${this.#baseTitle} (${s}s)`);
					}
				},
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
		this.#inputArea = new Container();
		this.addChild(this.#inputArea);
		this.#inputSpacer = new Spacer(1);
		this.addChild(this.#inputSpacer);
		this.#baseHelpText = opts?.helpText ?? "up/down navigate  enter select  esc cancel";
		this.#helpTextComponent = new Text(theme.fg("dim", this.#baseHelpText), 1, 0);
		this.addChild(this.#helpTextComponent);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.#updateList();
	}

	hasActiveInlineInput(): boolean {
		return this.#inlineEditor !== undefined;
	}
	/**
	 * Update the bounded selector's title/list row budgets after a terminal resize.
	 * The existing title scroll offset, option focus, and inline editor remain intact.
	 */
	setLayoutBudget(
		maxVisible: number,
		scrollTitleRows: number,
		inlineEditorMaxHeight = this.#inlineEditorMaxHeight,
		inlineAutocompleteMaxVisible = this.#inlineAutocompleteMaxVisible,
		compactInlineInput = this.#compactInlineInput,
	): void {
		if (!this.#scrollableTitle) return;
		const titleRows = Math.max(1, Math.floor(scrollTitleRows));
		this.#maxVisible = Math.max(1, Math.floor(maxVisible));
		this.#scrollTitleRows = titleRows;
		this.#inlineEditorMaxHeight =
			inlineEditorMaxHeight === undefined ? undefined : Math.max(1, Math.floor(inlineEditorMaxHeight));
		this.#inlineAutocompleteMaxVisible =
			inlineAutocompleteMaxVisible === undefined ? undefined : Math.max(3, Math.floor(inlineAutocompleteMaxVisible));
		this.#compactInlineInput = compactInlineInput;
		if (this.#inlineEditor) {
			this.#inlineEditor.setMaxHeight(this.#inlineEditorMaxHeight);
			if (this.#inlineAutocompleteMaxVisible !== undefined) {
				this.#inlineEditor.setAutocompleteMaxVisible(this.#inlineAutocompleteMaxVisible);
			}
			this.#inlineEditor.setAutocompleteProvider(this.#compactInlineInput ? undefined : this.#autocompleteProvider);
		}
		this.#setCompactInputSpacing(this.#inlineEditor !== undefined && this.#compactInlineInput);
		this.#scrollableTitle.setMaxRows(titleRows);
		this.#updateList();
		this.invalidate();
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

		if (this.#scrollTitleRows !== undefined && !this.#inlineEditor?.isAutocompleteOpen()) {
			const titlePageRows = Math.max(1, this.#scrollTitleRows - 2);
			if (matchesKey(keyData, "pageUp")) {
				this.#scrollableTitle?.scrollBy(-titlePageRows);
				return;
			}
			if (matchesKey(keyData, "pageDown")) {
				this.#scrollableTitle?.scrollBy(titlePageRows);
				return;
			}
			if (!this.#inlineEditor && matchesKey(keyData, "ctrl+u")) {
				this.#scrollableTitle?.scrollBy(-titlePageRows);
				return;
			}
			if (!this.#inlineEditor && matchesKey(keyData, "ctrl+d")) {
				this.#scrollableTitle?.scrollBy(titlePageRows);
				return;
			}
		}
		if (this.#inlineEditor) {
			this.#handleInputModeKey(keyData, this.#inlineEditor);
			return;
		}
		const acceleratedOption = this.#acceleratorMap?.[keyData.toLowerCase()];
		if (acceleratedOption && this.#options.includes(acceleratedOption)) {
			this.#onSelectCallback(acceleratedOption);
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
			if (!selected) return;
			if (this.#customInput && selected === this.#customInput.optionLabel) {
				this.#enterInputMode(this.#customInput);
				return;
			}
			if (this.#clarificationInput && selected === this.#clarificationInput.optionLabel) {
				this.#enterInputMode(this.#clarificationInput);
				return;
			}
			this.#onSelectCallback(selected);
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

	/** Keys while the inline custom-input editor is open below the option list. */
	#handleInputModeKey(keyData: string, editor: Editor): void {
		// While the autocomplete dropdown is open, every key belongs to the
		// editor (navigate/apply/cancel the suggestion) instead of submitting
		// or backing out of input mode.
		if (editor.isAutocompleteOpen()) {
			editor.handleInput(keyData);
			return;
		}
		// Escape backs out to option selection instead of cancelling the dialog,
		// so a stray Esc never throws away the question context.
		if (matchesKey(keyData, "escape") || matchesAppInterrupt(keyData)) {
			this.#exitInputMode();
			return;
		}
		if (matchesAppExternalEditor(keyData)) {
			void this.#openExternalEditor(editor);
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return")) {
			const text = editor.getExpandedText();
			if (this.#activeInput?.allowEmpty === false && text.trim() === "") {
				return;
			}
			this.#activeInput?.onSubmit(text);
			return;
		}
		editor.handleInput(keyData);
	}

	#setCompactInputSpacing(compact: boolean): void {
		this.#titleSpacer.setLines(compact ? 0 : 1);
		this.#inputSpacer.setLines(compact ? 0 : 1);
	}
	#enterInputMode(input: { onSubmit: (text: string) => void; allowEmpty?: boolean }): void {
		if (this.#inlineEditor) return;
		this.#activeInput = input;
		// Stop the auto-select countdown for good: the user is actively typing,
		// matching the old behavior where the separate editor had no timeout.
		if (this.#countdown) {
			this.#countdown.dispose();
			this.#countdown = undefined;
			if (this.#scrollableTitle) {
				this.#scrollableTitle.setText(this.#baseTitle, false);
			} else {
				this.#titleComponent.setText(this.#baseTitle);
			}
		}
		const editor = new Editor(getEditorTheme());
		editor.setBorderVisible(false);
		editor.setPromptGutter("> ");
		editor.disableSubmit = true;
		editor.setMaxHeight(this.#inlineEditorMaxHeight);
		if (this.#inlineAutocompleteMaxVisible !== undefined) {
			editor.setAutocompleteMaxVisible(this.#inlineAutocompleteMaxVisible);
		}
		// Mark the inline editor focused only when mirroring the app's hardware-cursor
		// mode, so it emits CURSOR_MARKER at the input caret for IME preedit anchoring
		// without changing legacy non-hardware-cursor layout.
		const useTerminalCursor = this.#tui?.getShowHardwareCursor() ?? false;
		editor.focused = useTerminalCursor;
		editor.setUseTerminalCursor(useTerminalCursor);
		if (this.#autocompleteProvider && !this.#compactInlineInput) {
			editor.setAutocompleteProvider(this.#autocompleteProvider);
		}
		this.#inlineEditor = editor;
		this.#setCompactInputSpacing(this.#compactInlineInput);
		if (!this.#compactInlineInput) this.#inputArea.addChild(new Spacer(1));
		this.#inputArea.addChild(editor);
		const helpText =
			this.#scrollTitleRows === undefined
				? "enter submit  esc back to options  ctrl+g external editor"
				: "enter submit  esc back to options  ctrl+g external editor  PgUp/PgDn: question · Wheel: transcript";
		this.#helpTextComponent.setText(theme.fg("dim", helpText));
		this.invalidate();
	}

	#exitInputMode(): void {
		if (!this.#inlineEditor) return;
		this.#inlineEditor = undefined;
		this.#activeInput = undefined;
		this.#inputArea.clear();
		this.#setCompactInputSpacing(false);
		this.#helpTextComponent.setText(theme.fg("dim", this.#baseHelpText));
		this.invalidate();
	}

	async #openExternalEditor(editor: Editor): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd || !this.#tui) return;

		const currentText = editor.getExpandedText();
		try {
			this.#tui.stop();
			const result = await openInEditor(editorCmd, currentText);
			if (result !== null) {
				editor.setText(result);
			}
		} finally {
			this.#tui.start();
			this.#tui.requestRender(true);
		}
	}

	dispose(): void {
		this.#countdown?.dispose();
	}
}

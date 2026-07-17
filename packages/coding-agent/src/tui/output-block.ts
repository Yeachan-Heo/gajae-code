/**
 * Bordered output container with optional header and sections.
 */
import {
	ImageProtocol,
	isTerminalGraphicsFallbackActive,
	padding,
	TERMINAL,
	visibleWidth,
	wrapTextWithAnsi,
} from "@gajae-code/tui";
import type { Theme } from "../modes/theme/theme";
import { containsSixelSequence, getSixelLineMask } from "../utils/sixel";
import type { State } from "./types";
import type { RenderCache } from "./utils";
import { getStateBgColor, Hasher, padToWidth, truncateToWidth } from "./utils";

export interface OutputBlockOptions {
	header?: string;
	headerMeta?: string;
	state?: State;
	sections?: Array<{ label?: string; lines: string[] }>;
	width: number;
	applyBg?: boolean;
}

export function renderOutputBlock(options: OutputBlockOptions, theme: Theme): string[] {
	const { header, headerMeta, state, sections = [], width, applyBg = true } = options;
	const h = theme.boxSharp.horizontal;
	const v = theme.boxSharp.vertical;
	const cap = h.repeat(3);
	const lineWidth = Math.max(0, width);
	// Border colors: running/pending use accent, success uses dim (gray), error/warning keep their colors
	const borderColor: "error" | "warning" | "accent" | "dim" =
		state === "error"
			? "error"
			: state === "warning"
				? "warning"
				: state === "running" || state === "pending"
					? "accent"
					: "dim";
	const border = (text: string) => theme.fg(borderColor, text);
	const bgFn = (() => {
		if (!state || !applyBg) return undefined;
		const bgAnsi = theme.getBgAnsi(getStateBgColor(state));
		// Keep block background stable even if inner content contains SGR resets (e.g. "\x1b[0m"),
		// which would otherwise clear the outer background mid-line.
		return (text: string) => {
			const stabilized = text
				.replace(/\x1b\[(?:0)?m/g, m => `${m}${bgAnsi}`)
				.replace(/\x1b\[49m/g, m => `${m}${bgAnsi}`);
			return `${bgAnsi}${stabilized}\x1b[49m`;
		};
	})();

	const buildBarLine = (leftChar: string, rightChar: string, label?: string, meta?: string): string => {
		const left = border(`${leftChar}${cap}`);
		const right = border(rightChar);
		if (lineWidth <= 0) return left + right;
		const labelText = [label, meta].filter(Boolean).join(theme.sep.dot);
		const rawLabel = labelText ? ` ${labelText} ` : " ";
		const leftWidth = visibleWidth(left);
		const rightWidth = visibleWidth(right);
		const maxLabelWidth = Math.max(0, lineWidth - leftWidth - rightWidth);
		const trimmedLabel = truncateToWidth(rawLabel, maxLabelWidth);
		const labelWidth = visibleWidth(trimmedLabel);
		const fillCount = Math.max(0, lineWidth - leftWidth - labelWidth - rightWidth);
		return `${left}${trimmedLabel}${border(h.repeat(fillCount))}${right}`;
	};

	const contentPrefix = border(`${v} `);
	const contentSuffix = border(v);
	const contentWidth = Math.max(0, lineWidth - visibleWidth(contentPrefix) - visibleWidth(contentSuffix));
	const lines: string[] = [];

	lines.push(
		padToWidth(buildBarLine(theme.boxSharp.topLeft, theme.boxSharp.topRight, header, headerMeta), lineWidth, bgFn),
	);

	const hasSections = sections.length > 0;
	const normalizedSections = hasSections ? sections : [{ lines: [] }];

	for (let i = 0; i < normalizedSections.length; i++) {
		const section = normalizedSections[i];
		if (section.label) {
			lines.push(
				padToWidth(buildBarLine(theme.boxSharp.teeRight, theme.boxSharp.teeLeft, section.label), lineWidth, bgFn),
			);
		}
		const allLines = section.lines.flatMap(l => l.split("\n"));
		const fallbackActive = isTerminalGraphicsFallbackActive();
		const sixelLineMask =
			fallbackActive || TERMINAL.imageProtocol === ImageProtocol.Sixel ? getSixelLineMask(allLines) : undefined;
		for (let lineIndex = 0; lineIndex < allLines.length; lineIndex++) {
			const sixelLine = sixelLineMask?.[lineIndex] ?? false;
			if (sixelLine && !fallbackActive) {
				lines.push(allLines[lineIndex]!);
				continue;
			}
			if (sixelLine && sixelLineMask?.[lineIndex - 1] && !containsSixelSequence(allLines[lineIndex]!)) continue;
			const line = sixelLine ? "[SIXEL image hidden while IRC sidebar is visible]" : allLines[lineIndex]!;
			const wrappedLines = wrapTextWithAnsi(line.trimEnd(), contentWidth);
			for (const wrappedLine of wrappedLines) {
				const innerPadding = padding(Math.max(0, contentWidth - visibleWidth(wrappedLine)));
				const fullLine = `${contentPrefix}${wrappedLine}${innerPadding}${contentSuffix}`;
				lines.push(padToWidth(fullLine, lineWidth, bgFn));
			}
		}
	}

	const bottomLeft = border(`${theme.boxSharp.bottomLeft}${cap}`);
	const bottomRight = border(theme.boxSharp.bottomRight);
	const bottomFillCount = Math.max(0, lineWidth - visibleWidth(bottomLeft) - visibleWidth(bottomRight));
	const bottomLine = `${bottomLeft}${border(h.repeat(bottomFillCount))}${bottomRight}`;
	lines.push(padToWidth(bottomLine, lineWidth, bgFn));

	return lines;
}

/**
 * Cached wrapper around `renderOutputBlock`.
 *
 * Since output blocks are re-rendered on every frame (via `render(width)` closures),
 * but their content rarely changes, this cache avoids redundant `visibleWidth()` and
 * `padding()` computations on ~99% of render calls.
 */
export class CachedOutputBlock {
	#cache?: RenderCache;

	/** Render with caching. Returns cached result if options haven't changed. */
	render(options: OutputBlockOptions, theme: Theme): string[] {
		const key = this.#buildKey(options);
		if (this.#cache?.key === key) return this.#cache.lines;
		const lines = renderOutputBlock(options, theme);
		this.#cache = { key, lines };
		return lines;
	}

	/** Invalidate the cache, forcing a rebuild on next render. */
	invalidate(): void {
		this.#cache = undefined;
	}

	#buildKey(options: OutputBlockOptions): bigint {
		const h = new Hasher();
		h.u32(options.width);
		h.optional(options.header);
		h.optional(options.headerMeta);
		h.optional(options.state);
		h.bool(options.applyBg ?? true);
		h.bool(isTerminalGraphicsFallbackActive());
		if (options.sections) {
			for (const s of options.sections) {
				h.optional(s.label);
				for (const line of s.lines) {
					h.str(line);
				}
			}
		}
		return h.digest();
	}
}

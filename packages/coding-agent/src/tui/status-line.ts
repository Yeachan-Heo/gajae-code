/**
 * Standardized status header rendering for tool output.
 */
import type { Theme, ThemeColor } from "../modes/theme/theme";
import type { ToolUIStatus } from "../tools/render-utils";
import { formatStatusIcon } from "../tools/render-utils";

export interface StatusLineOptions {
	icon?: ToolUIStatus;
	spinnerFrame?: number;
	title: string;
	titleColor?: ThemeColor;
	description?: string;
	badge?: { label: string; color: ThemeColor };
	meta?: string[];
}

/**
 * Sanitize untrusted text embedded in status lines while preserving caller-provided
 * SGR color/style sequences (e.g. `theme.fg`) and intentional OSC 8 hyperlinks.
 *
 * Strips arbitrary OSC, DCS, non-SGR CSI escape sequences, C0/C1 control characters, and
 * directional formatting overrides, while flattening newlines to keep single-row
 * layout intact. Preserves well-formed OSC 8 file hyperlinks (`fileHyperlink()`).
 */
export function sanitizeStatusLineText(text: string): string {
	return text
		.replace(/[\r\n]+/gu, " ")
		.replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "")
		// Strip OSC sequences EXCEPT well-formed OSC 8 hyperlinks (\x1b]8;...ST)
		.replace(/\x1b\](?!8;)[^\x1b\x07]*(?:\x07|\x1b\\)/gu, "")
		.replace(/\u009d(?!8;)[^\u009c\x07]*(?:\u009c|\x07)/gu, "")
		.replace(/\x1bP[\s\S]*?(?:\x1b\\|\x07)/gu, "")
		.replace(/\u0090[\s\S]*?(?:\u009c|\x07)/gu, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-ln-~]/gu, "")
		.replace(/\u009b[0-?]*[ -/]*[@-ln-~]/gu, "")
		.replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/gu, "")
		// Preserve SGR (ESC[...m), OSC 8 (ESC]8;...), and ST (ESC\)
		.replace(/\x1b(?!\[[\d;:]*m|\]8;|\\)/gu, "")
		.replace(/[\x80-\x9c\x9e-\x9f]/gu, "")
		.replace(/\u009d(?!8;)/gu, "");
}

export function renderStatusLine(options: StatusLineOptions, theme: Theme): string {
	const icon = options.icon ? formatStatusIcon(options.icon, theme, options.spinnerFrame) : "";
	const titleColor = options.titleColor ?? "accent";
	const title = theme.fg(titleColor, sanitizeStatusLineText(options.title));
	let line = icon ? `${icon} ${title}` : title;

	if (options.description) {
		line += `: ${theme.fg("muted", sanitizeStatusLineText(options.description))}`;
	}

	if (options.badge) {
		const { label, color } = options.badge;
		line += ` ${theme.fg(color, `${theme.format.bracketLeft}${sanitizeStatusLineText(label)}${theme.format.bracketRight}`)}`;
	}

	const meta = options.meta?.map(sanitizeStatusLineText).filter(value => value.trim().length > 0) ?? [];
	if (meta.length > 0) {
		line += ` ${theme.fg("dim", meta.join(theme.sep.dot))}`;
	}

	return line;
}

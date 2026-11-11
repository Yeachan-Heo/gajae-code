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

const WELL_FORMED_FILE_OSC8_RE = /^\x1b\]8;[^\x1b\x07;]*;file:\/\/[^\x1b\x07\s]*(?:\x1b\\|\x07)$/;
const WELL_FORMED_OSC8_CLOSURE_RE = /^\x1b\]8;;(?:\x1b\\|\x07)$/;
const BIDI_CONTROL_RE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/**
 * Sanitize untrusted text embedded in status lines while preserving caller-provided
 * SGR color/style sequences (e.g. `theme.fg`) and intentional OSC 8 file hyperlinks.
 *
 * Uses a linear-time 1-pass scanner to avoid quadratic backtracking on repeated
 * unterminated control introducers, stripping arbitrary OSC, DCS, non-SGR CSI,
 * C0/C1 controls, and directional overrides, while flattening newlines and tabs to single spaces.
 */
export function sanitizeStatusLineText(text: string): string {
	const normalized = text.replace(/[\r\n\t]+/gu, " ").replace(BIDI_CONTROL_RE, "");
	let result = "";
	const length = normalized.length;
	let index = 0;

	while (index < length) {
		const char = normalized[index]!;
		const code = char.charCodeAt(0);

		if (char === "\x1b") {
			if (index + 1 >= length) {
				index++;
				continue;
			}
			const next = normalized[index + 1];

			if (next === "[") {
				let cursor = index + 2;
				while (
					cursor < length &&
					((normalized.charCodeAt(cursor) >= 48 && normalized.charCodeAt(cursor) <= 57) ||
						normalized[cursor] === ";" ||
						normalized[cursor] === ":")
				) {
					cursor++;
				}
				if (cursor < length && normalized[cursor] === "m") {
					result += normalized.slice(index, cursor + 1);
					index = cursor + 1;
					continue;
				}
				while (cursor < length && normalized.charCodeAt(cursor) < 0x40) {
					cursor++;
				}
				if (cursor < length && normalized.charCodeAt(cursor) >= 0x40 && normalized.charCodeAt(cursor) <= 0x7e) {
					cursor++;
				}
				index = cursor;
				continue;
			}

			if (next === "]") {
				let cursor = index + 2;
				while (cursor < length) {
					if (normalized[cursor] === "\x07") {
						cursor++;
						break;
					}
					if (normalized[cursor] === "\x1b" && cursor + 1 < length && normalized[cursor + 1] === "\\") {
						cursor += 2;
						break;
					}
					if (normalized[cursor] === "\x1b") {
						break;
					}
					cursor++;
				}
				const seq = normalized.slice(index, cursor);
				if (WELL_FORMED_FILE_OSC8_RE.test(seq) || WELL_FORMED_OSC8_CLOSURE_RE.test(seq)) {
					result += seq;
				} else if (!(seq.endsWith("\x07") || seq.endsWith("\x1b\\"))) {
					index++;
					continue;
				}
				index = cursor;
				continue;
			}

			if (next === "P") {
				let cursor = index + 2;
				while (cursor < length) {
					if (normalized[cursor] === "\x07") {
						cursor++;
						break;
					}
					if (normalized[cursor] === "\x1b" && cursor + 1 < length && normalized[cursor + 1] === "\\") {
						cursor += 2;
						break;
					}
					if (normalized[cursor] === "\x1b") {
						break;
					}
					cursor++;
				}
				index = cursor;
				continue;
			}

			index++;
			continue;
		}

		if (code < 0x20 || code === 0x7f) {
			index++;
			continue;
		}

		if (code >= 0x80 && code <= 0x9f) {
			if (code === 0x9d || code === 0x90) {
				index++;
				while (
					index < length &&
					normalized.charCodeAt(index) !== 0x9c &&
					normalized[index] !== "\x07" &&
					!(normalized[index] === "\x1b" && index + 1 < length && normalized[index + 1] === "\\")
				) {
					index++;
				}
				if (index < length) {
					if (normalized[index] === "\x1b" && index + 1 < length && normalized[index + 1] === "\\") {
						index += 2;
					} else {
						index++;
					}
				}
				continue;
			}
			index++;
			continue;
		}

		result += char;
		index++;
	}

	return result;
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

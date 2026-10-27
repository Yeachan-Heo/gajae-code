/**
 * Standardized status header rendering for tool output.
 */
import { sanitizeDisplayLine } from "@gajae-code/utils";
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

export function renderStatusLine(options: StatusLineOptions, theme: Theme): string {
	const icon = options.icon ? formatStatusIcon(options.icon, theme, options.spinnerFrame) : "";
	const titleColor = options.titleColor ?? "accent";
	const title = theme.fg(titleColor, sanitizeDisplayLine(options.title));
	let line = icon ? `${icon} ${title}` : title;

	if (options.description) {
		line += `: ${theme.fg("muted", sanitizeDisplayLine(options.description))}`;
	}

	if (options.badge) {
		const { label, color } = options.badge;
		line += ` ${theme.fg(color, `${theme.format.bracketLeft}${sanitizeDisplayLine(label)}${theme.format.bracketRight}`)}`;
	}

	const meta = options.meta?.map(sanitizeDisplayLine).filter(value => value.trim().length > 0) ?? [];
	if (meta.length > 0) {
		line += ` ${theme.fg("dim", meta.join(theme.sep.dot))}`;
	}

	return line;
}

import { replaceTabs, truncateToWidth } from "@gajae-code/tui";
import { sanitizeDisplayLine } from "@gajae-code/utils";
import { toProjectProgressSnapshot } from "../../progress/progress-snapshot";
import type { ProjectProgressReport } from "../../progress/project-progress";
import { type ProgressRenderStyle, renderProgressSnapshot } from "../../progress/render-progress";

/** Bound untrusted durable text (objectives, titles, HUD values) to one sanitized display line of `max` columns. */
export function clipProgressText(text: string, max: number): string {
	return truncateToWidth(sanitizeDisplayLine(replaceTabs(text)).trim(), max);
}

/** TUI view: the `session.progress` snapshot rendered with column-aware clipping and theme colours. */
export function renderProgressReportLines(report: ProjectProgressReport, style?: ProgressRenderStyle): string[] {
	return renderProgressSnapshot(toProjectProgressSnapshot(report), {
		clip: clipProgressText,
		...(style ? { style } : {}),
	});
}

/** Plain text view: identical to what production ACP renders from the `session.progress` query. */
export function renderProgressReportText(report: ProjectProgressReport): string {
	return renderProgressSnapshot(toProjectProgressSnapshot(report)).join("\n");
}

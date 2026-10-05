import { replaceTabs, truncateToWidth } from "@gajae-code/tui";
import { sanitizeDisplayLine } from "@gajae-code/utils";
import {
	type ProgressRenderStyle,
	type ProjectProgressReport,
	renderProjectProgress,
} from "../../progress/project-progress";

/** Bound untrusted durable text (objectives, titles, HUD values) to one sanitized display line. */
export function clipProgressText(text: string, max: number): string {
	return truncateToWidth(sanitizeDisplayLine(replaceTabs(text)).trim(), max);
}

export function renderProgressReportLines(report: ProjectProgressReport, style?: ProgressRenderStyle): string[] {
	return renderProjectProgress(report, { clip: clipProgressText, ...(style ? { style } : {}) });
}

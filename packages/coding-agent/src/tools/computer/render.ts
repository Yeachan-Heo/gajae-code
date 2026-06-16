import type { Component } from "@gajae-code/tui";
import { Text } from "@gajae-code/tui";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme } from "../../modes/theme/theme";
import type { ComputerToolDetails } from "../computer";
import { formatBadge, formatErrorMessage } from "../render-utils";

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function summarizeArgs(args: unknown): string {
	const input = asRecord(args);
	const action = typeof input.action === "string" ? input.action : "computer";
	const parts = [action];
	if (typeof input.x === "number" && typeof input.y === "number") parts.push(`@ ${input.x},${input.y}`);
	if (typeof input.to_x === "number" && typeof input.to_y === "number") parts.push(`→ ${input.to_x},${input.to_y}`);
	if (typeof input.scroll_x === "number" || typeof input.scroll_y === "number") {
		parts.push(`scroll ${input.scroll_x ?? 0},${input.scroll_y ?? 0}`);
	}
	if (Array.isArray(input.keys)) parts.push(`keys ${input.keys.join("+")}`);
	if (typeof input.ms === "number") parts.push(`${input.ms}ms`);
	return parts.join(" ");
}

export function summarizeComputerDetails(
	details: ComputerToolDetails | undefined,
	isError: boolean,
	theme: Theme,
): string {
	if (!details) return isError ? "Computer action failed" : "Computer action completed";
	const parts: string[] = [details.action];
	if (details.x !== undefined && details.y !== undefined) parts.push(`@ ${details.x},${details.y}`);
	if (details.toX !== undefined && details.toY !== undefined) parts.push(`→ ${details.toX},${details.toY}`);
	if (details.scrollX !== undefined || details.scrollY !== undefined)
		parts.push(`scroll ${details.scrollX ?? 0},${details.scrollY ?? 0}`);
	if (details.screenshot) {
		const shot = details.screenshot;
		parts.push(`screenshot ${shot.widthPx}x${shot.heightPx}`);
		if (shot.pngBytes !== undefined) parts.push(`${shot.pngBytes} bytes`);
		if (shot.captureId) parts.push(`capture ${shot.captureId}`);
	}
	if (details.supervisor) parts.push(`supervisor ${details.supervisor}`);
	if (details.code) parts.push(theme.fg(isError ? "error" : "muted", details.code));
	return parts.join(" ");
}

export const computerToolRenderer = {
	renderCall(args: unknown, _options: RenderResultOptions, theme: Theme): Component {
		return new Text(`${formatBadge("computer", "accent", theme)} ${summarizeArgs(args)}`);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		_options: RenderResultOptions,
		theme: Theme,
	): Component {
		if (result.isError) {
			const details = result.details as ComputerToolDetails | undefined;
			return new Text(
				formatErrorMessage(details?.message ?? result.content.find(c => c.type === "text")?.text, theme),
			);
		}
		return new Text(
			`${formatBadge("computer", "success", theme)} ${summarizeComputerDetails(result.details as ComputerToolDetails | undefined, false, theme)}`,
		);
	},
	mergeCallAndResult: true,
};

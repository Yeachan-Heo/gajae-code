/**
 * Narrow-width survival row for the status rail.
 *
 * The rail evicts segments continuously as the terminal narrows. Without this
 * row the last thing left at very small widths is the `…+N` overflow marker —
 * the three things a user actually needs (how much context is left, whether a
 * goal is running, which model is answering) are exactly what the generic
 * eviction throws away first or last by accident.
 *
 * This row keeps them, in priority order, by stepping each item down its own
 * ladder instead of dropping it:
 *
 *   full form -> shortened form -> single glyph -> dropped
 *
 * Context % is never dropped and is the last survivor; the model name is
 * dropped first of the three. The row is rendered as bare colored text with no
 * group padding or end caps, so — like the overflow marker — it can survive at
 * widths where a normal segment group cannot.
 */

import { visibleWidth } from "@gajae-code/tui";
import { formatNumber } from "@gajae-code/utils";
import { theme } from "../../theme/theme";
import { getContextUsageLevel, getContextUsageThemeColor } from "./context-thresholds";
import { shortenModelId } from "./model-name";
import { goalStatusDisplay } from "./segments";
import type { SegmentContext } from "./types";

const SEPARATOR = "·";

/** Which priority items the active layout is supposed to be carrying. */
export interface PriorityItemSet {
	context: boolean;
	goal: boolean;
	model: boolean;
}

function contextForms(ctx: SegmentContext): { full: string; short: string } | null {
	const window = ctx.contextWindow;
	if (!(window > 0)) return null;

	const raw = ctx.contextPercent;
	const pct = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
	const color = pct === null ? "statusLineContext" : getContextUsageThemeColor(getContextUsageLevel(pct, window));

	return {
		full: theme.fg(color, `${pct === null ? "?" : `${pct.toFixed(1)}%`}/${formatNumber(window)}`),
		short: theme.fg(color, pct === null ? "?" : `${Math.round(pct)}%`),
	};
}

function goalForms(ctx: SegmentContext): { label: string; glyph: string } | null {
	const display = goalStatusDisplay(ctx);
	if (!display) return null;

	const glyph = display.icon || "G";
	return {
		label: theme.fg(display.color, display.icon ? `${display.icon} Goal` : "Goal"),
		glyph: theme.fg(display.color, glyph),
	};
}

function modelForms(ctx: SegmentContext): { short: string; glyph: string } {
	const model = ctx.session.state.model;
	const name = shortenModelId(model?.id ?? model?.name);
	return {
		short: theme.fg("statusLineModel", name),
		glyph: theme.fg("statusLineModel", theme.icon.model || name.slice(0, 1)),
	};
}

/**
 * Widest priority row that fits `width`, or null when even the minimal form
 * cannot fit (callers then fall back to the overflow marker).
 *
 * Returns null when neither context nor goal is available: the model name alone
 * is the lowest-priority item and never justifies replacing the normal rail.
 */
export function buildPriorityRow(ctx: SegmentContext, width: number, include: PriorityItemSet): string | null {
	if (width <= 0) return null;

	const context = include.context ? contextForms(ctx) : null;
	const goal = include.goal ? goalForms(ctx) : null;
	const model = include.model ? modelForms(ctx) : null;
	if (!context && !goal) return null;

	// Ordered widest-first. Every item degrades through its own forms before any
	// item is dropped, and drops run lowest-priority first (model, then goal).
	const ladder: readonly (readonly (string | null)[])[] = [
		[context?.full ?? null, goal?.label ?? null, model?.short ?? null],
		[context?.full ?? null, goal?.glyph ?? null, model?.short ?? null],
		[context?.full ?? null, goal?.glyph ?? null, model?.glyph ?? null],
		[context?.short ?? null, goal?.glyph ?? null, model?.glyph ?? null],
		[context?.short ?? null, goal?.glyph ?? null, null],
		[context?.short ?? null, null, null],
	];

	const separator = theme.fg("dim", SEPARATOR);
	for (const candidate of ladder) {
		const parts = candidate.filter((part): part is string => part !== null);
		if (parts.length === 0) continue;
		const row = parts.join(separator);
		if (visibleWidth(row) <= width) return row;
	}

	return null;
}

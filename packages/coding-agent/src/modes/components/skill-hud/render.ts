import { truncateToWidth, visibleWidth } from "@gajae-code/tui";
import {
	collapsePlanningPipeline,
	type SkillActiveEntry,
	type WorkflowHudChip,
} from "../../../skill-state/active-state";
import { workflowReceiptStatus } from "../../../skill-state/workflow-state-contract";
import { theme } from "../../theme/theme";

const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// C0 except TAB/LF/CR, plus DEL and C1. Deleted after the CSI strip so a spared
// ESC cannot be glued to a later "]" and form a new OSC. This is not a sequence scan.
const HUD_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const MAX_HUD_ROWS = 2;

type WidthTier = "wide" | "medium" | "tight";
type HudToken = { text: string; mandatory: boolean; startsEntry?: boolean; reserveAfter?: number };

function color(role: "border" | "accent" | "dim" | "muted" | "warning" | "error", text: string): string {
	return theme?.fg(role, text) ?? text;
}

function statusSymbol(kind: "warning" | "error"): string {
	return theme?.status[kind] ?? (kind === "error" ? "[!!]" : "[!]");
}

function sanitizeHudPart(value: string | undefined): string {
	return (value ?? "")
		.replace(ANSI_PATTERN, "")
		.replace(HUD_CONTROL_CHARS, "")
		.replace(/[\r\n\t]+/g, " ")
		.trim();
}

function compareEntries(a: SkillActiveEntry, b: SkillActiveEntry): number {
	return a.skill.localeCompare(b.skill) || (a.phase ?? "").localeCompare(b.phase ?? "");
}

function compareChips(a: WorkflowHudChip, b: WorkflowHudChip): number {
	return (a.priority ?? 50) - (b.priority ?? 50) || a.label.localeCompare(b.label);
}

function tierForWidth(width: number): WidthTier {
	return width >= 100 ? "wide" : width >= 60 ? "medium" : "tight";
}

function severityOf(chip: WorkflowHudChip): "error" | "warning" | undefined {
	return chip.severity === "error" || chip.severity === "blocked"
		? "error"
		: chip.severity === "warning"
			? "warning"
			: undefined;
}

function severityGlyph(severity: WorkflowHudChip["severity"]): string {
	if (severity === "error" || severity === "blocked") return color("error", statusSymbol("error"));
	if (severity === "warning") return color("warning", statusSymbol("warning"));
	return "";
}

function formatChip(chip: WorkflowHudChip): string | null {
	const label = sanitizeHudPart(chip.label);
	const value = sanitizeHudPart(chip.value);
	if (!label) return null;
	const body = value ? `${label}=${value}` : label;
	const role = severityOf(chip);
	return role ? color(role, body) : color("dim", body);
}

function keyMetricChip(skill: string, chips: readonly WorkflowHudChip[]): WorkflowHudChip | undefined {
	const preferredBySkill: Record<string, readonly string[]> = {
		"deep-interview": ["ambiguity"],
		ralplan: ["iter", "round", "stage"],
		ultragoal: ["goals", "current"],
		autoresearch: ["exp", "experiments"],
	};
	const preferred = preferredBySkill[skill] ?? [];
	return (
		preferred.map(label => chips.find(chip => chip.label === label && !severityOf(chip))).find(Boolean) ??
		chips.find(chip => !severityOf(chip))
	);
}

function buildEntryTokens(entry: SkillActiveEntry, tier: WidthTier, width: number): HudToken[] {
	const skill = sanitizeHudPart(entry.skill);
	const phase = sanitizeHudPart(entry.phase);
	const base = phase ? `${skill}:${phase}` : skill;
	const chips = [...(entry.hud?.chips ?? [])].sort(compareChips);
	if (entry.stale === true) chips.unshift({ label: "stale", priority: 0, severity: "warning" });
	if (workflowReceiptStatus(entry.receipt) === "stale") {
		chips.unshift({ label: "receipt", value: "stale", priority: 1, severity: "warning" });
	}

	const severity =
		chips.find(chip => chip.severity === "error" || chip.severity === "blocked")?.severity ??
		chips.find(chip => chip.severity === "warning")?.severity;
	const glyph = severityGlyph(severity);
	const baseText = color("accent", tier === "tight" ? skill : base);
	if (
		tier === "tight" &&
		glyph &&
		visibleWidth(glyph) <= width &&
		visibleWidth(baseText) + 1 + visibleWidth(glyph) > width
	) {
		return [{ text: glyph, mandatory: true, startsEntry: true }];
	}
	const tokens: HudToken[] = [
		{
			text: baseText,
			mandatory: true,
			startsEntry: true,
			reserveAfter: glyph ? visibleWidth(` ${glyph}`) : 0,
		},
	];
	if (glyph) tokens.push({ text: glyph, mandatory: true });

	if (tier === "medium") {
		const metric = keyMetricChip(skill, chips);
		const metricText = metric ? formatChip(metric) : null;
		if (metricText) tokens.push({ text: metricText, mandatory: false });
		return tokens;
	}

	const summary = sanitizeHudPart(entry.hud?.summary);
	if (summary) tokens.push({ text: color("muted", summary), mandatory: false });
	for (const chip of chips) {
		const formatted = formatChip(chip);
		if (formatted) tokens.push({ text: formatted, mandatory: false });
	}
	return tokens;
}

function appendOverflowMarker(row: string, width: number, protectedToken?: string): string {
	if (!row || width <= 0) return row;
	if (protectedToken) {
		const tokenIndex = row.lastIndexOf(protectedToken);
		if (tokenIndex >= 0) {
			const prefix = row.slice(0, tokenIndex);
			const tokenWidth = visibleWidth(protectedToken);
			const plainPrefix = Bun.stripANSI(prefix).trimEnd();
			const needsMarker = !plainPrefix.endsWith("…");
			const prefixWidth = Math.max(0, width - tokenWidth - (needsMarker ? 1 : 0));
			return `${truncateToWidth(prefix, prefixWidth)}${needsMarker ? "…" : ""}${protectedToken}`;
		}
	}
	return truncateToWidth(`${row}…`, width);
}

/**
 * Render the HUD as physical rows rather than embedding a newline in one row.
 * The bottom-pinned TUI layout counts array elements as rows; a newline inside
 * one element corrupts that accounting and can overwrite the editor.
 */
export function renderSkillHudBar(entries: readonly SkillActiveEntry[], width: number): string[] | null {
	const visible = collapsePlanningPipeline(entries.filter(entry => entry.active !== false));
	const active = visible.filter(entry => sanitizeHudPart(entry.skill)).sort(compareEntries);
	if (active.length === 0 || width <= 0) return null;

	const tier = tierForWidth(width);
	const rail = color("border", "◆");
	const separator = color("dim", " + ");
	const firstPrefix = visibleWidth(rail) + 1 <= width ? `${rail} ` : "";
	const continuationPrefix = firstPrefix ? " ".repeat(visibleWidth(firstPrefix)) : "";
	const rows: string[] = [];
	let row = firstPrefix;
	let rowIndex = 0;
	let hasToken = false;
	let omitted = false;
	let lastSeverityToken: string | undefined;

	const tryAppend = (token: HudToken, allowTruncate: boolean): boolean => {
		let joiner = hasToken ? (token.startsEntry ? separator : " ") : "";
		let available = width - visibleWidth(row) - visibleWidth(joiner);
		if (!hasToken && visibleWidth(row) > 0 && visibleWidth(token.text) > available) {
			row = "";
			joiner = "";
			available = width;
		}
		if (available <= 0) return false;
		const textAvailable = Math.max(0, available - (allowTruncate ? (token.reserveAfter ?? 0) : 0));
		const text =
			visibleWidth(token.text) <= textAvailable
				? token.text
				: allowTruncate
					? truncateToWidth(token.text, textAvailable)
					: "";
		if (!text || visibleWidth(text) <= 0) return false;
		row = `${row}${joiner}${text}`;
		hasToken = true;
		return true;
	};

	const startNextRow = (): boolean => {
		if (rowIndex >= MAX_HUD_ROWS - 1) return false;
		if (hasToken) rows.push(truncateToWidth(row, width));
		rowIndex += 1;
		row = continuationPrefix;
		hasToken = false;
		return true;
	};

	for (const entry of active) {
		for (const token of buildEntryTokens(entry, tier, width)) {
			const append = (allowTruncate: boolean): boolean => {
				const appended = tryAppend(token, allowTruncate);
				if (appended && token.mandatory && !token.startsEntry) lastSeverityToken = token.text;
				return appended;
			};
			if (append(false)) continue;
			if (startNextRow() && append(false)) continue;
			if (append(true)) continue;
			if (token.mandatory && startNextRow() && append(true)) continue;
			omitted = true;
			break;
		}
		if (omitted) break;
	}

	if (hasToken) rows.push(truncateToWidth(row, width));
	if (omitted && rows.length > 0) {
		const last = rows.length - 1;
		rows[last] = appendOverflowMarker(rows[last] ?? "", width, lastSeverityToken);
	}
	return rows.length > 0 ? rows.slice(0, MAX_HUD_ROWS) : null;
}

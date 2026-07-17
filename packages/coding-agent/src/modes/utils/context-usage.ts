import type { AgentMessage } from "@gajae-code/agent-core";
import type { CompactionSettings } from "@gajae-code/agent-core/compaction";
import {
	effectiveReserveTokens,
	estimateMessageTokensHeuristic,
	resolveThresholdTokens,
} from "@gajae-code/agent-core/compaction";
import type { Model } from "@gajae-code/ai";
import { formatNumber } from "@gajae-code/utils";
import type { AgentSession } from "../../session/agent-session";
import { computeNonMessageBreakdown } from "../../session/context-estimation";
import type { theme as Theme } from "../theme/theme";

export {
	computeNonMessageTokens,
	estimateSkillsTokens,
	estimateToolSchemaTokens,
} from "../../session/context-estimation";

const GRID_COLS = 20;
const GRID_ROWS = 10;
const GRID_CELLS = GRID_COLS * GRID_ROWS;
const GRID_GUTTER = "   ";

const CELL_FILLED = "⛁";
const CELL_FILLED_MESSAGES = "⛃";
const CELL_FREE = "⛶";
const CELL_BUFFER = "⛝";

type CategoryId = "systemPrompt" | "systemContext" | "rules" | "tools" | "skills" | "messages" | "lastUserTurn";

interface CategoryInfo {
	id: CategoryId;
	label: string;
	tokens: number;
	color: "accent" | "warning" | "success" | "userMessageText" | "customMessageLabel";
	glyph: string;
}

export interface ContextBreakdown {
	model: Model | undefined;
	contextWindow: number;
	categories: CategoryInfo[];
	lastUserTurnTokens: number;
	estimatedCategoryTotal: number;
	usedTokens: number | null;
	source: "provider_anchor" | "heuristic" | "unknown";
	autoCompactBufferTokens: number;
	freeTokens: number;
}

function splitLastUserTurn(messages: readonly AgentMessage[]): {
	regularMessagesTokens: number;
	lastUserTurnTokens: number;
} {
	let lastUserIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") {
			lastUserIndex = i;
			break;
		}
	}

	let regularMessagesTokens = 0;
	let lastUserTurnTokens = 0;
	for (let i = 0; i < messages.length; i++) {
		const tokens = estimateMessageTokensHeuristic(messages[i]);
		if (i === lastUserIndex) {
			lastUserTurnTokens = tokens;
		} else {
			regularMessagesTokens += tokens;
		}
	}
	return { regularMessagesTokens, lastUserTurnTokens };
}

/**
 * Compute a breakdown of estimated context usage by category for the active
 * session and model.
 */
export function computeContextBreakdown(
	session: AgentSession,
	options: { messages?: readonly AgentMessage[] } = {},
): ContextBreakdown {
	const model = session.model;
	const contextWindow = model?.contextWindow ?? 0;

	const convo = options.messages ?? session.messages ?? [];
	const { regularMessagesTokens, lastUserTurnTokens } = splitLastUserTurn(convo);

	// The rendered system prompt already contains the skill descriptions and the
	// markdown tool descriptions. To present a non-overlapping breakdown:
	//   System prompt = total system prompt text - skills section (tool descriptions stay)
	//   Tools         = JSON tool schema sent separately on the wire
	//   Skills        = the skill list embedded in the system prompt
	//   Messages      = conversation messages
	const { rulesTokens, skillsTokens, toolsTokens, systemContextTokens, systemPromptTokens } =
		computeNonMessageBreakdown(session);

	const categories: CategoryInfo[] = [
		{ id: "systemPrompt", label: "System", tokens: systemPromptTokens, color: "accent", glyph: CELL_FILLED },
		{ id: "rules", label: "Rules", tokens: rulesTokens, color: "warning", glyph: CELL_FILLED },
		{ id: "tools", label: "Tools", tokens: toolsTokens, color: "warning", glyph: CELL_FILLED },
		{
			id: "systemContext",
			label: "Context files",
			tokens: systemContextTokens,
			color: "customMessageLabel",
			glyph: CELL_FILLED,
		},
		{ id: "skills", label: "Skills", tokens: skillsTokens, color: "success", glyph: CELL_FILLED },
		{
			id: "messages",
			label: "Messages",
			tokens: regularMessagesTokens,
			color: "userMessageText",
			glyph: CELL_FILLED_MESSAGES,
		},
		{
			id: "lastUserTurn",
			label: "Last user turn",
			tokens: lastUserTurnTokens,
			color: "userMessageText",
			glyph: CELL_FILLED_MESSAGES,
		},
	];

	const estimatedCategoryTotal = categories.reduce((sum, c) => sum + c.tokens, 0);
	const contextUsage = session.getContextUsage?.();
	const source = contextUsage?.source ?? "heuristic";
	const usedTokens = source === "unknown" ? null : (contextUsage?.tokens ?? estimatedCategoryTotal);
	const tokensForFreeSpace = usedTokens ?? estimatedCategoryTotal;

	let autoCompactBufferTokens = 0;
	if (contextWindow > 0) {
		const compactionSettings = session.settings.getGroup("compaction") as CompactionSettings;
		if (compactionSettings.enabled && compactionSettings.strategy !== "off") {
			const threshold = resolveThresholdTokens(contextWindow, compactionSettings);
			autoCompactBufferTokens = Math.max(0, contextWindow - threshold);
		} else {
			autoCompactBufferTokens = 0;
		}
		// Even when fully disabled, fall back to a sensible reserve floor for display.
		if (autoCompactBufferTokens === 0 && compactionSettings.enabled) {
			autoCompactBufferTokens = effectiveReserveTokens(contextWindow, compactionSettings);
		}
	}
	autoCompactBufferTokens = Math.min(autoCompactBufferTokens, Math.max(0, contextWindow - tokensForFreeSpace));

	const freeTokens = Math.max(0, contextWindow - tokensForFreeSpace - autoCompactBufferTokens);

	return {
		model,
		contextWindow,
		categories,
		lastUserTurnTokens,
		estimatedCategoryTotal,
		usedTokens,
		source,
		autoCompactBufferTokens,
		freeTokens,
	};
}

interface CellSpec {
	glyph: string;
	color: "accent" | "warning" | "success" | "userMessageText" | "customMessageLabel" | "muted" | "dim";
}

function planCells(breakdown: ContextBreakdown): CellSpec[] {
	const cells: CellSpec[] = [];
	const window = breakdown.contextWindow;

	if (window <= 0) {
		for (let i = 0; i < GRID_CELLS; i++) {
			cells.push({ glyph: CELL_FREE, color: "dim" });
		}
		return cells;
	}

	const tokensPerCell = window / GRID_CELLS;

	const ratioCells = (tokens: number): number => {
		if (tokens <= 0) return 0;
		return Math.max(1, Math.round(tokens / tokensPerCell));
	};

	const categoryCounts = breakdown.categories.map(category => ({
		category,
		count: ratioCells(category.tokens),
	}));

	let bufferCount = ratioCells(breakdown.autoCompactBufferTokens);

	let usedCount = categoryCounts.reduce((sum, c) => sum + c.count, 0);

	// Prevent the visualization from over-running the grid.
	const maxUsable = GRID_CELLS - bufferCount;
	if (usedCount > maxUsable) {
		// Scale categories proportionally down to fit.
		let overflow = usedCount - maxUsable;
		// Trim from the largest categories first to preserve visibility for small ones.
		const order = [...categoryCounts].sort((a, b) => b.count - a.count);
		for (const entry of order) {
			while (overflow > 0 && entry.count > 1) {
				entry.count -= 1;
				overflow -= 1;
			}
		}
		usedCount = categoryCounts.reduce((sum, c) => sum + c.count, 0);
		if (usedCount + bufferCount > GRID_CELLS) {
			bufferCount = Math.max(0, GRID_CELLS - usedCount);
		}
	}

	for (const { category, count } of categoryCounts) {
		for (let i = 0; i < count; i++) {
			cells.push({ glyph: category.glyph, color: category.color });
		}
	}

	const freeCount = Math.max(0, GRID_CELLS - cells.length - bufferCount);
	for (let i = 0; i < freeCount; i++) {
		cells.push({ glyph: CELL_FREE, color: "dim" });
	}
	for (let i = 0; i < bufferCount; i++) {
		cells.push({ glyph: CELL_BUFFER, color: "warning" });
	}

	// Pad to exactly GRID_CELLS in case rounding undershot.
	while (cells.length < GRID_CELLS) {
		cells.push({ glyph: CELL_FREE, color: "dim" });
	}
	return cells.slice(0, GRID_CELLS);
}

function percentString(part: number, whole: number, fractionDigits = 1): string {
	if (whole <= 0) return "0%";
	const pct = (part / whole) * 100;
	if (pct > 0 && pct < 0.05) return "<0.1%";
	return `${pct.toFixed(fractionDigits)}%`;
}

function buildLegendLines(breakdown: ContextBreakdown, theme: typeof Theme): string[] {
	const lines: string[] = [];
	const {
		model,
		contextWindow,
		categories,
		estimatedCategoryTotal,
		usedTokens,
		source,
		autoCompactBufferTokens,
		freeTokens,
	} = breakdown;

	const modelName = model?.name ?? model?.id ?? "no model";
	const modelId = model?.id ?? "unknown";
	const windowLabel = formatNumber(contextWindow).toLowerCase();
	const totalSourceLabel =
		source === "provider_anchor"
			? "provider-reported"
			: source === "unknown"
				? "estimated; exact count unknown until next response"
				: "estimated";

	lines.push(theme.bold(`${modelName}`) + theme.fg("dim", ` (${windowLabel} context)`));
	lines.push(theme.fg("muted", `${modelId}[${windowLabel}]`));
	if (usedTokens === null) {
		lines.push(
			`${theme.bold("unknown")}${theme.fg("dim", `/${windowLabel} tokens`)}` +
				theme.fg("muted", " (exact count unknown until next response)"),
		);
	} else {
		lines.push(
			`${theme.bold(formatNumber(usedTokens))}${theme.fg("dim", `/${windowLabel} tokens`)}` +
				theme.fg("muted", ` (${percentString(usedTokens, contextWindow)}) (${totalSourceLabel})`),
		);
	}
	if (source !== "unknown" && usedTokens !== null && estimatedCategoryTotal !== usedTokens) {
		lines.push(
			theme.fg(
				"muted",
				`Estimated category total: ${formatNumber(estimatedCategoryTotal)} tokens (composition below is estimated)`,
			),
		);
	}
	lines.push("");
	lines.push(theme.fg("muted", "Estimated usage by category"));

	for (const category of categories) {
		const dot = theme.fg(category.color, category.glyph);
		const label = category.label;
		const tokens = formatNumber(category.tokens);
		const pct = percentString(category.tokens, contextWindow);
		lines.push(`${dot} ${label}: ${theme.bold(tokens)} ${theme.fg("dim", `tokens (${pct})`)}`);
	}

	const freeDot = theme.fg("dim", CELL_FREE);
	const freeLabel = usedTokens === null ? "Free space (estimated)" : "Free space";
	lines.push(
		`${freeDot} ${freeLabel}: ${theme.bold(formatNumber(freeTokens))} ${theme.fg("dim", `(${percentString(freeTokens, contextWindow)})`)}`,
	);

	if (autoCompactBufferTokens > 0) {
		const bufferDot = theme.fg("warning", CELL_BUFFER);
		lines.push(
			`${bufferDot} Autocompact buffer: ${theme.bold(formatNumber(autoCompactBufferTokens))} ${theme.fg(
				"dim",
				`tokens (${percentString(autoCompactBufferTokens, contextWindow)})`,
			)}`,
		);
	}

	return lines;
}

/**
 * Render a colorful context-usage panel as ANSI text. Output is a series of
 * lines pairing the grid (left) with the legend (right).
 */
export function renderContextUsage(breakdown: ContextBreakdown, theme: typeof Theme): string {
	if (breakdown.contextWindow <= 0) {
		return theme.fg("muted", "Context usage is unavailable: no model is selected for this session.");
	}

	const cells = planCells(breakdown);
	const legend = buildLegendLines(breakdown, theme);

	const totalLines = Math.max(GRID_ROWS, legend.length);
	const lines: string[] = [];

	for (let row = 0; row < totalLines; row++) {
		let gridSegment = "";
		if (row < GRID_ROWS) {
			const rowCells: string[] = [];
			for (let col = 0; col < GRID_COLS; col++) {
				const cell = cells[row * GRID_COLS + col];
				rowCells.push(theme.fg(cell.color, cell.glyph));
			}
			gridSegment = rowCells.join(" ");
		} else {
			// Pad with blanks the same visible width as a grid row so legend lines
			// past the grid stay aligned with their column.
			const blank = " ".repeat(GRID_COLS * 2 - 1);
			gridSegment = blank;
		}

		const legendSegment = legend[row] ?? "";
		const line = legendSegment.length > 0 ? `${gridSegment}${GRID_GUTTER}${legendSegment}` : gridSegment;
		lines.push(line);
	}

	return lines.join("\n");
}

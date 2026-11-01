/**
 * Hierarchical tree list rendering helper.
 */

import { replaceTabs } from "@gajae-code/tui";
import { sanitizeText } from "@gajae-code/utils";
import type { Theme } from "../modes/theme/theme";
import { formatMoreItems } from "../tools/render-utils";
import type { TreeContext } from "./types";
import { getTreeBranch, getTreeContinuePrefix } from "./utils";

/**
 * Tool renderers pass raw match lines or line groups into `renderItem`, which
 * then applies theme colors. Strip controls first so OSC bytes are not wrapped
 * into the styled string. Objects (file entries, todos) are left unchanged.
 */
function sanitizeTreeItem<T>(item: T): T {
	if (typeof item === "string") return sanitizeText(item) as T;
	if (Array.isArray(item)) {
		return item.map(part => (typeof part === "string" ? sanitizeText(part) : part)) as T;
	}
	return item;
}

export interface TreeListOptions<T> {
	items: T[];
	expanded?: boolean;
	maxCollapsed?: number;
	/** Strict total-line budget for collapsed mode. When set (and not expanded),
	 *  rendered item lines plus the trailing summary line must fit within this budget.
	 */
	maxCollapsedLines?: number;
	itemType?: string;
	/** Called once per item with `isLast: false` during budget calculation;
	 *  line count MUST NOT vary based on `isLast`. */
	renderItem: (item: T, context: TreeContext) => string | string[];
}

export function renderTreeList<T>(options: TreeListOptions<T>, theme: Theme): string[] {
	const { items, expanded = false, maxCollapsed = 8, maxCollapsedLines, itemType = "item", renderItem } = options;
	const maxItems = expanded ? items.length : Math.min(items.length, maxCollapsed);
	const linesBudget = !expanded && maxCollapsedLines !== undefined ? maxCollapsedLines : Infinity;

	// Pre-render each candidate item once.
	// isLast cannot be known at this point (fittingCount is not yet determined);
	// renderItem implementations MUST NOT vary line count based on isLast.
	const preRendered: string[][] = [];
	for (let i = 0; i < maxItems; i++) {
		const rendered = renderItem(sanitizeTreeItem(items[i]!), {
			index: i,
			isLast: false,
			depth: 0,
			theme,
			prefix: "",
			continuePrefix: "",
		});
		preRendered.push(Array.isArray(rendered) ? rendered : rendered ? [rendered] : []);
	}

	// Determine how many items fit within the line budget.
	let fittingCount = maxItems;
	let fittedLineCount = 0;
	if (linesBudget !== Infinity) {
		fittingCount = 0;
		for (let i = 0; i < maxItems; i++) {
			const count = preRendered[i]!.length;
			const remainingAfter = items.length - (i + 1);
			const reservedSummaryLines = remainingAfter > 0 ? 1 : 0;
			if (fittedLineCount + count + reservedSummaryLines > linesBudget) break;
			fittedLineCount += count;
			fittingCount = i + 1;
		}
	}

	const remaining = items.length - fittingCount;
	const hasSummary = !expanded && remaining > 0 && (linesBudget === Infinity || fittedLineCount < linesBudget);

	// Emit pre-rendered content with correct isLast-based branch prefixes.
	const lines: string[] = [];
	for (let i = 0; i < fittingCount; i++) {
		const isLast = !hasSummary && i === fittingCount - 1;
		const branch = getTreeBranch(isLast, theme);
		const prefix = `${theme.fg("dim", branch)} `;
		const continuePrefix = `${theme.fg("dim", getTreeContinuePrefix(isLast, theme))}`;
		const itemLines = preRendered[i]!;
		if (itemLines.length === 0) continue;
		lines.push(`${prefix}${replaceTabs(itemLines[0]!)}`);
		for (let j = 1; j < itemLines.length; j++) {
			lines.push(`${continuePrefix}${replaceTabs(itemLines[j]!)}`);
		}
	}

	if (hasSummary) {
		lines.push(`${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", formatMoreItems(remaining, itemType))}`);
	}

	return lines;
}

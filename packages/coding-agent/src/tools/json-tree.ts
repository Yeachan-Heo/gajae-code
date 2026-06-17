/**
 * JSON tree rendering utilities shared across tool renderers.
 */
import { INTENT_FIELD } from "@gajae-code/agent-core";
import type { Theme } from "../modes/theme/theme";
import { truncateToWidth } from "./render-utils";

/** Max depth for JSON tree rendering */
export const JSON_TREE_MAX_DEPTH_COLLAPSED = 2;
export const JSON_TREE_MAX_DEPTH_EXPANDED = 6;
export const JSON_TREE_MAX_LINES_COLLAPSED = 6;
export const JSON_TREE_MAX_LINES_EXPANDED = 200;
export const JSON_TREE_SCALAR_LEN_COLLAPSED = 60;
export const JSON_TREE_SCALAR_LEN_EXPANDED = 2000;

const HIDDEN_ARG_KEYS = { [INTENT_FIELD]: 1, __partialJson: 1 };

const ARGS_INLINE_PAIR_SEP = ", ";
const ARGS_INLINE_PAIR_SEP_WIDTH = Bun.stringWidth(ARGS_INLINE_PAIR_SEP);
const ARGS_INLINE_MORE = "…";
const ARGS_INLINE_MORE_WIDTH = Bun.stringWidth(ARGS_INLINE_MORE);

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Format a scalar value for inline display.
 */
export function formatScalar(value: unknown, maxLen: number): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number") return String(value);
	if (typeof value === "string") {
		const escaped = value.replace(/\n/g, "\\n").replace(/\t/g, "\\t");
		const truncated = truncateToWidth(escaped, maxLen);
		return `"${truncated}"`;
	}
	if (Array.isArray(value)) return `[${value.length} items]`;
	if (typeof value === "object") {
		const keys = Object.keys(value);
		return `{${keys.length} keys}`;
	}
	return String(value);
}

/**
 * Format args inline for collapsed view.
 */
export function formatArgsInline(args: Record<string, unknown>, maxWidth: number): string {
	let result = "";
	let width = 0;
	for (const key in args) {
		if (key in HIDDEN_ARG_KEYS) continue;
		const value = args[key];
		const sep = width > 0 ? ARGS_INLINE_PAIR_SEP : "";
		const sepW = width > 0 ? ARGS_INLINE_PAIR_SEP_WIDTH : 0;
		const current = width + sepW;
		const cap = maxWidth - current - ARGS_INLINE_MORE_WIDTH;
		if (cap <= 0) {
			return `${result}${ARGS_INLINE_MORE}`;
		}
		const valueMaxLen = Math.min(maxWidth - current, 24);
		const valueStr = formatScalar(value, valueMaxLen);
		const piece = `${key}=${valueStr}`;
		const pieceW = Bun.stringWidth(piece);
		if (pieceW > cap) {
			return `${result}${sep}${truncateToWidth(piece, cap)}`;
		}
		result += sep + piece;
		width = current + pieceW;
	}
	return result;
}

/**
 * Build tree prefix for nested rendering.
 */
function buildTreePrefix(theme: Theme, ancestors: readonly boolean[]): string {
	return ancestors.map(hasNext => (hasNext ? `${theme.tree.vertical}  ` : "   ")).join("");
}

function splitByDisplayWidth(value: string, maxWidth: number): string[] {
	const width = Math.max(1, maxWidth);
	const fragments: string[] = [];
	let current = "";
	let currentWidth = 0;
	for (const char of value) {
		const charWidth = Math.max(1, Bun.stringWidth(char));
		if (current && currentWidth + charWidth > width) {
			fragments.push(current);
			current = "";
			currentWidth = 0;
		}
		current += char;
		currentWidth += charWidth;
	}
	if (current || fragments.length === 0) fragments.push(current);
	return fragments;
}

/**
 * Render a JSON value as tree lines.
 */
export function renderJsonTreeLines(
	value: unknown,
	theme: Theme,
	maxDepth: number,
	maxLines: number,
	maxScalarLen: number,
): { lines: string[]; truncated: boolean } {
	const lines: string[] = [];
	let truncated = false;

	const iconObject = theme.styledSymbol("icon.folder", "muted");
	const iconArray = theme.styledSymbol("icon.package", "muted");
	const iconScalar = theme.styledSymbol("icon.file", "muted");

	const pushLine = (line: string): boolean => {
		if (lines.length >= maxLines) {
			truncated = true;
			return false;
		}
		lines.push(line);
		return true;
	};

	const renderNode = (val: unknown, key: string | undefined, ancestors: boolean[], isLast: boolean, depth: number) => {
		if (lines.length >= maxLines) {
			truncated = true;
			return;
		}

		const connector = isLast ? theme.tree.last : theme.tree.branch;
		const prefix = `${buildTreePrefix(theme, ancestors)}${theme.fg("dim", connector)} `;

		ancestors.push(!isLast);
		try {
			// Handle scalars
			if (val === null || val === undefined || typeof val !== "object") {
				const label = key ? theme.fg("muted", key) : theme.fg("muted", "value");
				if (typeof val === "string") {
					const escaped = val.replace(/\n/g, "\\n").replace(/\t/g, "\\t");
					const marker = "…";
					const firstFragmentWidth = Math.max(1, maxScalarLen - 2);
					const continuationWidth = Math.max(1, maxScalarLen - Bun.stringWidth(marker) - 1);
					const firstFragments = splitByDisplayWidth(escaped, firstFragmentWidth);
					const firstFragment = firstFragments[0] ?? "";
					const remainder = firstFragments.slice(1).join("");
					const continuationFragments = remainder ? splitByDisplayWidth(remainder, continuationWidth) : [];
					const fragments = [firstFragment, ...continuationFragments];
					const lineBudget = Math.max(1, maxLines - lines.length);
					const visibleCount = Math.min(fragments.length, lineBudget);
					const continuePrefix = buildTreePrefix(theme, ancestors);
					const isStringTruncated = visibleCount < fragments.length;

					for (let i = 0; i < visibleCount; i++) {
						const isFirst = i === 0;
						const isFinalVisible = i === visibleCount - 1;
						const suffix = isStringTruncated && isFinalVisible ? `${marker}"` : isFinalVisible ? '"' : "";
						const rendered = isFirst ? `"${fragments[i]}${suffix}` : `↳ ${fragments[i]}${suffix}`;
						const line = isFirst
							? `${prefix}${iconScalar} ${label}: ${theme.fg("dim", rendered)}`
							: `${continuePrefix}   ${theme.fg("dim", rendered)}`;
						if (!pushLine(line)) break;
					}
					if (isStringTruncated) truncated = true;
					return;
				}

				const scalar = formatScalar(val, maxScalarLen);
				pushLine(`${prefix}${iconScalar} ${label}: ${theme.fg("dim", scalar)}`);
				return;
			}

			// Handle arrays
			if (Array.isArray(val)) {
				const header = key ? theme.fg("muted", key) : theme.fg("muted", "array");
				pushLine(`${prefix}${iconArray} ${header}`);
				if (val.length === 0) {
					pushLine(
						`${buildTreePrefix(theme, ancestors)}${theme.fg("dim", theme.tree.last)} ${theme.fg("dim", "[]")}`,
					);
					return;
				}
				if (depth >= maxDepth) {
					pushLine(
						`${buildTreePrefix(theme, ancestors)}${theme.fg("dim", theme.tree.last)} ${theme.fg("dim", "…")}`,
					);
					return;
				}
				for (let i = 0; i < val.length; i++) {
					renderNode(val[i], `[${i}]`, ancestors, i === val.length - 1, depth + 1);
					if (lines.length >= maxLines) {
						truncated = true;
						return;
					}
				}
				return;
			}

			// Handle objects
			if (!isRecord(val)) return;

			const header = key ? theme.fg("muted", key) : theme.fg("muted", "object");
			pushLine(`${prefix}${iconObject} ${header}`);
			if (depth >= maxDepth) {
				pushLine(`${buildTreePrefix(theme, ancestors)}${theme.fg("dim", theme.tree.last)} ${theme.fg("dim", "…")}`);
				return;
			}
			const keys = Object.keys(val);
			if (keys.length === 0) {
				pushLine(
					`${buildTreePrefix(theme, ancestors)}${theme.fg("dim", theme.tree.last)} ${theme.fg("dim", "{}")}`,
				);
				return;
			}
			for (let i = 0; i < keys.length; i++) {
				const childKey = keys[i];
				const child = val[childKey];
				renderNode(child, childKey, ancestors, i === keys.length - 1, depth + 1);
				if (lines.length >= maxLines) {
					truncated = true;
					return;
				}
			}
		} finally {
			ancestors.pop();
		}
	};

	// Render root level
	if (isRecord(value)) {
		for (const key in value) {
			if (key in HIDDEN_ARG_KEYS) continue;
			renderNode(value[key], key, [], true, 1);
			if (lines.length >= maxLines) {
				truncated = true;
				break;
			}
		}
	} else if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			renderNode(value[i], `[${i}]`, [], i === value.length - 1, 1);
			if (lines.length >= maxLines) {
				truncated = true;
				break;
			}
		}
	} else {
		renderNode(value, undefined, [], true, 0);
	}

	return { lines, truncated };
}

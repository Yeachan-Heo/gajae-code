import { wrapTextWithAnsi } from "@gajae-code/tui";
import { sanitizeText } from "@gajae-code/utils";
import { renderJsonTreeLines } from "../../tools/json-tree";
import { renderStatusLine } from "../../tui";
import type { Theme } from "../theme/theme";
import { validateDisplayLine } from "./ansi-display-validator";
import { renderDiff } from "./diff";

export const MAX_TOOL_ARGS_CHARS = 500;
export const TOOL_RESULT_MAX_EXPANDED_LINES = 100;
export const INPUT_MAX_SOURCE_BYTES = 1_048_576;
export const INPUT_MAX_SOURCE_LINES = 50_000;
export const INPUT_MAX_SCALAR_LEN = 8_192;
export const INPUT_MAX_JSON_DEPTH = 32;
export const INPUT_MAX_JSON_NODES = 20_000;

export type ToolDisplaySections = {
	callLines: string[];
	statusLines: string[];
	resultText: string;
};

/**
 * Produces final, terminal-safe rich display lines for an expanded tool entry.
 * It owns validation, width-aware wrapping, and the result-only visible cap.
 */
export function renderToolDisplayLines(
	descriptor: ToolTranscriptRenderDescriptor,
	contentWidth: number,
	theme: Theme,
): string[] {
	const bounded =
		descriptor.inputTruncated || exceedsInputBudget(descriptor) ? truncatedDescriptor(descriptor) : descriptor;
	const sections = bounded.inputTruncated ? truncatedPlainSections(bounded) : richSections(bounded, theme);
	const wrap = (lines: string[]) =>
		balanceWrappedSgr(lines.flatMap(line => wrapTextWithAnsi(validateDisplayLine(line), Math.max(1, contentWidth))));
	const result = cappedResultLines(sections.resultText);
	const resultLines = wrap(result.lines);
	const shown = resultLines.slice(0, TOOL_RESULT_MAX_EXPANDED_LINES);
	if (result.omittedLineCount > 0) shown.push(`... ${result.omittedLineCount} more lines`);
	else if (resultLines.length > TOOL_RESULT_MAX_EXPANDED_LINES)
		shown.push(`... ${resultLines.length - TOOL_RESULT_MAX_EXPANDED_LINES} more lines`);
	return [...wrap(sections.callLines), ...wrap(sections.statusLines), ...shown];
}

function truncatedPlainSections(descriptor: ToolTranscriptRenderDescriptor): ToolDisplaySections {
	return {
		callLines: [descriptor.name, ...composeToolCall(descriptor).split("\n").filter(Boolean)],
		statusLines: [!descriptor.hasResult ? "⏳ pending" : descriptor.isError ? "✗ Error" : "✓ done"],
		resultText: `... input truncated for rendering (press r for raw)\n${boundedPlainResult(descriptor.resultContent)}`,
	};
}

function truncatedDescriptor(descriptor: ToolTranscriptRenderDescriptor): ToolTranscriptRenderDescriptor {
	return {
		...descriptor,
		name: descriptor.name.slice(0, 256),
		args: exceedsStructuredInputBudget(descriptor.args) ? {} : descriptor.args,
		intent: exceedsScalarInputBudget(descriptor.intent) ? undefined : descriptor.intent,
		resultContent: boundedPlainResult(descriptor.resultContent),
		details: undefined,
		detailsData: undefined,
		inputTruncated: true,
	};
}

function balanceWrappedSgr(lines: string[]): string[] {
	let active: string[] = [];
	return lines.map(line => {
		const prefix = active.join("");
		const matches = [...line.matchAll(/\x1b\[([0-9;]*)m/g)];
		for (const match of matches) {
			if (
				match[1]!
					.split(";")
					.some(parameter => ["0", "22", "23", "24", "25", "27", "28", "29", "39", "49"].includes(parameter))
			)
				active = [];
			else active = [match[0]];
		}
		const last = matches.at(-1);
		return `${prefix}${line}${prefix || (last && !last[1]!.split(";").includes("0")) ? "\x1b[0m" : ""}`;
	});
}

function plainSections(descriptor: ToolTranscriptRenderDescriptor, theme: Theme): ToolDisplaySections {
	return {
		callLines: [theme.fg("accent", descriptor.name), ...composeToolCall(descriptor).split("\n").filter(Boolean)],
		statusLines: [statusLine(descriptor, theme)],
		resultText: boundedPlainResult(descriptor.resultContent),
	};
}

function richSections(descriptor: ToolTranscriptRenderDescriptor, theme: Theme): ToolDisplaySections {
	const sections = plainSections(descriptor, theme);
	const diff = extractDiff(descriptor.detailsData) ?? descriptor.details;
	if ((descriptor.name === "edit" || descriptor.name === "write" || descriptor.name === "apply_patch") && diff) {
		sections.resultText = renderDiff(diff, { filePath: extractPath(descriptor.detailsData) });
	} else if (descriptor.detailsData && typeof descriptor.detailsData === "object") {
		sections.resultText = renderJsonTreeLines(
			descriptor.detailsData,
			theme,
			INPUT_MAX_JSON_DEPTH,
			TOOL_RESULT_MAX_EXPANDED_LINES * 2,
			INPUT_MAX_SCALAR_LEN,
		).lines.join("\n");
	}
	return sections;
}

function statusLine(descriptor: ToolTranscriptRenderDescriptor, theme: Theme): string {
	const status = !descriptor.hasResult
		? "⏳ pending"
		: descriptor.isError
			? `✗ ${descriptor.resultContent.split("\n", 1)[0]?.trim() || "Error"}`
			: "✓ done";
	return renderStatusLine(
		{ title: status, titleColor: descriptor.isError ? "error" : descriptor.hasResult ? "success" : "warning" },
		theme,
	);
}

function boundedPlainResult(text: string): string {
	const boundedBytes =
		Buffer.byteLength(text) > INPUT_MAX_SOURCE_BYTES
			? Buffer.from(text).subarray(0, INPUT_MAX_SOURCE_BYTES).toString()
			: text;
	let end = boundedBytes.length;
	let lineCount = 1;
	for (let index = 0; index < boundedBytes.length; index++) {
		if (boundedBytes[index] !== "\n") continue;
		if (lineCount === INPUT_MAX_SOURCE_LINES) {
			end = index;
			break;
		}
		lineCount += 1;
	}
	return boundedBytes.slice(0, end);
}

function cappedResultLines(result: string): { lines: string[]; omittedLineCount: number } {
	let lineCount = 1;
	let prefixEnd = result.length;
	for (let index = 0; index < result.length; index++) {
		if (result[index] !== "\n") continue;
		if (lineCount === TOOL_RESULT_MAX_EXPANDED_LINES) prefixEnd = index;
		lineCount += 1;
	}
	return {
		lines: result.slice(0, prefixEnd).split("\n"),
		omittedLineCount: Math.max(0, lineCount - TOOL_RESULT_MAX_EXPANDED_LINES),
	};
}

function extractDiff(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.diff === "string") return record.diff;
	if (Array.isArray(record.perFileResults))
		return record.perFileResults
			.map(item =>
				item && typeof item === "object" && typeof (item as Record<string, unknown>).diff === "string"
					? (item as Record<string, unknown>).diff
					: "",
			)
			.filter(Boolean)
			.join("\n");
	return undefined;
}

function extractPath(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	return typeof record.path === "string" ? record.path : undefined;
}

/**
 * Field-specific input budgets:
 * - resultContent is bounded by total bytes and lines.
 * - args and detailsData are bounded by cumulative bytes, per-scalar length, depth, and nodes.
 * - intent and details are bounded by per-scalar length.
 */
function exceedsInputBudget(descriptor: ToolTranscriptRenderDescriptor): boolean {
	return (
		exceedsResultContentBudget(descriptor.resultContent) ||
		exceedsStructuredInputBudget(descriptor.args) ||
		exceedsScalarInputBudget(descriptor.intent) ||
		exceedsScalarInputBudget(descriptor.details) ||
		exceedsStructuredInputBudget(descriptor.detailsData)
	);
}

function exceedsResultContentBudget(value: string): boolean {
	return Buffer.byteLength(value) > INPUT_MAX_SOURCE_BYTES || value.split("\n").length - 1 > INPUT_MAX_SOURCE_LINES;
}

function exceedsScalarInputBudget(value: unknown): boolean {
	return typeof value === "string" && value.length > INPUT_MAX_SCALAR_LEN;
}

function exceedsStructuredInputBudget(value: unknown): boolean {
	let nodes = 0;
	let bytes = 0;
	let exceeded = false;
	const visit = (item: unknown, depth: number): void => {
		if (exceeded) return;
		nodes++;
		if (nodes > INPUT_MAX_JSON_NODES || depth > INPUT_MAX_JSON_DEPTH) {
			exceeded = true;
			return;
		}
		if (typeof item === "string") {
			bytes += Buffer.byteLength(item);
			if (item.length > INPUT_MAX_SCALAR_LEN || bytes > INPUT_MAX_SOURCE_BYTES) exceeded = true;
			return;
		}
		if (Array.isArray(item)) for (const child of item) visit(child, depth + 1);
		else if (item && typeof item === "object") for (const child of Object.values(item)) visit(child, depth + 1);
	};
	visit(value, 0);
	return exceeded;
}

export type ToolTranscriptRenderDescriptor = Readonly<{
	name: string;
	args: Record<string, unknown>;
	intent?: string;
	resultContent: string;
	details?: string;
	detailsData?: unknown;
	isError: boolean;
	isPartial: boolean;
	hasResult: boolean;
	inputTruncated: boolean;
}>;

export type BuildToolTranscriptEntryInput = {
	canonicalPayload: import("../transcript-item-registry").TranscriptSourcePayload;
	renderDescriptor: ToolTranscriptRenderDescriptor;
	capabilities: import("../transcript-item-registry").TranscriptItemCapabilities;
	identity: { id: string; label: string; display?: "full" };
};

/**
 * Shared tool projection for the main transcript and session observer.
 * `payload` is canonical/copyable source; display is derived only from the
 * sanitized, frozen descriptor. The observer's whole-entry 100-line cap and
 * the main view's tool-only result cap intentionally remain surface-specific.
 */
export function buildToolTranscriptEntry(
	input: BuildToolTranscriptEntryInput,
): import("./transcript-viewer-overlay").TranscriptViewerEntry {
	const { canonicalPayload: payload, renderDescriptor, capabilities, identity } = input;
	const fields: ToolTranscriptFields = {
		name: renderDescriptor.name,
		args: renderDescriptor.args,
		intent: renderDescriptor.intent,
		resultText: renderDescriptor.resultContent,
		isError: renderDescriptor.isError,
		hasResult: renderDescriptor.hasResult,
	};
	return {
		id: identity.id,
		kind: "tool",
		label: identity.label,
		payload,
		renderDescriptor,
		...capabilities,
		richRenderEligible: identity.display !== "full",
		getDisplayText: expanded =>
			identity.display === "full" ? composeToolText(fields) : toolDisplayText(fields, expanded),
	};
}

/** Sanitizes and freezes all display-only values before tool formatting. */
export function createToolTranscriptRenderDescriptor(input: {
	name: unknown;
	args: unknown;
	intent?: unknown;
	resultContent: unknown;
	details?: unknown;
	detailsData?: unknown;
	isError?: unknown;
	isPartial?: unknown;
	hasResult?: unknown;
	inputTruncated?: unknown;
}): ToolTranscriptRenderDescriptor {
	const argsTruncated = exceedsStructuredInputBudget(input.args);
	const detailsDataTruncated = exceedsStructuredInputBudget(input.detailsData);
	return freezeDisplayValue({
		name: sanitizeString(input.name),
		args: argsTruncated ? {} : ((sanitizeDisplayValue(input.args) ?? {}) as Record<string, unknown>),
		intent: typeof input.intent === "string" ? sanitizeString(input.intent) : undefined,
		resultContent: sanitizeString(input.resultContent),
		details: typeof input.details === "string" ? sanitizeString(input.details) : undefined,
		detailsData: detailsDataTruncated ? undefined : sanitizeDisplayValue(input.detailsData),
		isError: Boolean(input.isError),
		isPartial: Boolean(input.isPartial),
		hasResult: Boolean(input.hasResult),
		inputTruncated: Boolean(input.inputTruncated) || argsTruncated || detailsDataTruncated,
	});
}

function sanitizeString(value: unknown): string {
	return typeof value === "string" ? sanitizeText(value) : "";
}

function sanitizeDisplayValue(value: unknown): unknown {
	if (typeof value === "string") return sanitizeText(value);
	if (Array.isArray(value)) return value.map(sanitizeDisplayValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [sanitizeText(key), sanitizeDisplayValue(item)]),
	);
}

function freezeDisplayValue<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const item of Object.values(value)) freezeDisplayValue(item);
		Object.freeze(value);
	}
	return value;
}

type ToolCallFields = {
	name: string;
	args: Record<string, unknown>;
	intent?: string;
};

type ToolResultFields = {
	resultText: string;
	isError: boolean;
	hasResult: boolean;
};

export type ToolTranscriptFields = ToolCallFields & ToolResultFields;

export function formatToolArgs(name: string, args: Record<string, unknown>): string {
	if (name === "read" || name === "write" || name === "edit") return args.path ? `path: ${args.path}` : "";
	if (name === "bash") return typeof args.command === "string" ? args.command.replaceAll("\t", "    ") : "";
	if (name === "search")
		return [
			args.pattern ? `pattern: ${args.pattern}` : "",
			Array.isArray(args.paths) ? `paths: ${args.paths.join(", ")}` : "",
		]
			.filter(Boolean)
			.join(", ");
	return Object.entries(args)
		.filter(([key]) => !key.startsWith("_"))
		.map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
		.join(", ")
		.slice(0, MAX_TOOL_ARGS_CHARS);
}

export function composeToolCall({ name, args, intent }: ToolCallFields): string {
	return [formatToolArgs(name, args), intent].filter(Boolean).join("\n");
}

export function composeToolResult({ resultText, isError, hasResult }: ToolResultFields): string {
	const text = resultText.trim();
	if (!hasResult) return "⏳ pending";
	if (isError) return `✗ ${text || "Error"}`;
	return text || "✓ done";
}

export function composeToolText(fields: ToolTranscriptFields): string {
	return [composeToolCall(fields), composeToolResult(fields)].filter(Boolean).join("\n");
}

/**
 * Caps result output without allocating an array for every source line. The final
 * line count still requires scanning the result so the omitted-line count is exact.
 */
function expandedToolResult(result: string): string {
	let lineCount = 1;
	let prefixEnd = result.length;
	for (let index = 0; index < result.length; index++) {
		if (result[index] !== "\n") continue;
		if (lineCount === TOOL_RESULT_MAX_EXPANDED_LINES) prefixEnd = index;
		lineCount += 1;
	}
	const prefix = result.slice(0, prefixEnd);
	return lineCount > TOOL_RESULT_MAX_EXPANDED_LINES
		? `${prefix}\n... ${lineCount - TOOL_RESULT_MAX_EXPANDED_LINES} more lines`
		: prefix;
}

export function toolDisplayText(fields: ToolTranscriptFields, expanded: boolean): string {
	const call = composeToolCall(fields);
	if (!expanded) return call;
	return [call, expandedToolResult(composeToolResult(fields))].filter(Boolean).join("\n");
}

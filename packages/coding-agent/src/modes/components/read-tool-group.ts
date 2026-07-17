import type { Component } from "@gajae-code/tui";
import { Container, Text } from "@gajae-code/tui";
import { InternalUrlRouter } from "../../internal-urls";
import { getLanguageFromPath, theme } from "../../modes/theme/theme";
import { splitPathAndSel } from "../../tools/path-utils";
import { PREVIEW_LIMITS, shortenPath } from "../../tools/render-utils";
import { renderCodeCell } from "../../tui";
import type { ToolExecutionHandle } from "./tool-execution";

/**
 * Read calls whose target is resolved through {@link InternalUrlRouter} are
 * rendered as full tool executions (not collapsed into the read group) so the
 * resolved content is visible. `path` is the canonical arg; `file_path` is the
 * legacy alias still tolerated by the read tool schema.
 */
function readArgsTarget(args: unknown): string | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const record = args as Record<string, unknown>;
	return typeof record.path === "string"
		? record.path
		: typeof record.file_path === "string"
			? record.file_path
			: undefined;
}

export function readArgsHaveTarget(args: unknown): boolean {
	return readArgsTarget(args) !== undefined;
}

export function readArgsTargetInternalUrl(args: unknown): boolean {
	const target = readArgsTarget(args);
	if (!target) return false;
	return InternalUrlRouter.instance().canHandle(target);
}

type ReadRenderArgs = {
	path?: string;
	file_path?: string;
	// Legacy field from the old schema; tolerated for rebuilt transcripts.
	sel?: string;
};

type ReadToolSuffixResolution = {
	from: string;
	to: string;
};

type ReadToolResultDetails = {
	suffixResolution?: {
		from?: string;
		to?: string;
	};
	conflictCount?: number;
};

type ReadToolGroupOptions = {
	showContentPreview?: boolean;
};

function getSuffixResolution(details: ReadToolResultDetails | undefined): ReadToolSuffixResolution | undefined {
	if (typeof details?.suffixResolution?.from !== "string" || typeof details.suffixResolution.to !== "string") {
		return undefined;
	}
	return { from: details.suffixResolution.from, to: details.suffixResolution.to };
}

type ReadEntry = {
	toolCallId: string;
	path: string;
	status: "pending" | "success" | "warning" | "error";
	correctedFrom?: string;
	contentText?: string;
	conflictCount?: number;
};

/** Number of code lines to show in collapsed preview mode */
const COLLAPSED_PREVIEW_LINES = PREVIEW_LIMITS.OUTPUT_COLLAPSED;

export class ReadToolGroupComponent extends Container implements ToolExecutionHandle {
	#entries = new Map<string, ReadEntry>();
	#text: Text;
	#expanded = false;
	#manuallyExpanded: boolean | undefined;
	#showContentPreview: boolean;

	constructor(options: ReadToolGroupOptions = {}) {
		super();
		this.#showContentPreview = options.showContentPreview ?? false;
		this.#text = new Text("", 0, 0);
		this.addChild(this.#text);
		this.#updateDisplay();
	}

	updateArgs(args: ReadRenderArgs, toolCallId?: string): void {
		if (!toolCallId) return;
		const basePath = args.file_path || args.path || "";
		const rawPath = args.sel ? `${basePath}:${args.sel}` : basePath;
		const entry: ReadEntry = this.#entries.get(toolCallId) ?? {
			toolCallId,
			path: rawPath,
			status: "pending",
		};
		entry.path = rawPath;
		this.#entries.set(toolCallId, entry);
		this.#updateDisplay();
	}

	updateResult(
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		isPartial = false,
		toolCallId?: string,
	): void {
		if (!toolCallId) return;
		const entry = this.#entries.get(toolCallId);
		if (!entry) return;
		if (isPartial) return;
		const details = result.details as ReadToolResultDetails | undefined;
		const suffixResolution = getSuffixResolution(details);
		if (suffixResolution) {
			entry.path = suffixResolution.to;
			entry.correctedFrom = suffixResolution.from;
		} else {
			entry.correctedFrom = undefined;
		}
		const conflictCount =
			typeof details?.conflictCount === "number" && details.conflictCount > 0 ? details.conflictCount : undefined;
		entry.conflictCount = conflictCount;
		entry.status = result.isError ? "error" : suffixResolution ? "warning" : "success";
		// Store the text content for preview/expanded display
		const textContent = result.content?.find(c => c.type === "text")?.text;
		if (textContent !== undefined) {
			entry.contentText = textContent;
		}
		this.#updateDisplay();
	}

	setArgsComplete(_toolCallId?: string): void {
		this.#updateDisplay();
	}

	/** Applies automatic expansion unless this renderer instance has an explicit fold choice. */
	setExpanded(expanded: boolean): void {
		if (this.#manuallyExpanded !== undefined) return;
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	/**
	 * Applies and pins an explicit fold choice for this renderer instance only.
	 * Transcript rebuilds recreate components from global state and drop this pin.
	 */
	setManuallyExpanded(expanded: boolean): void {
		this.#manuallyExpanded = expanded;
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	getComponent(): Component {
		return this;
	}

	#updateDisplay(): void {
		const entries = [...this.#entries.values()];

		// Clear previous children and rebuild the summary and preview blocks.
		this.clear();
		this.#text = new Text("", 0, 0);

		if (entries.length === 0) {
			this.#text.setText(` ${theme.format.bullet} ${theme.fg("toolTitle", theme.bold("Read"))}`);
			this.addChild(this.#text);
			return;
		}

		if (entries.length === 1) {
			const entry = entries[0];
			if (!this.#shouldRenderPreview(entry)) {
				const statusSymbol = this.#formatStatus(entry.status);
				const pathDisplay = this.#formatPath(entry);
				this.#text.setText(
					` ${statusSymbol} ${theme.fg("toolTitle", theme.bold("Read"))} ${pathDisplay}`.trimEnd(),
				);
				this.addChild(this.#text);
			}
			if (this.#shouldRenderPreview(entry)) {
				this.#addContentPreview(entry);
			}
			return;
		}

		const header = `${theme.fg("toolTitle", theme.bold("Read"))}${theme.fg("dim", ` (${entries.length})`)}`;
		const lines = [` ${theme.format.bullet} ${header}`];
		const entriesWithoutPreview = entries.filter(entry => !this.#shouldRenderPreview(entry));
		const total = entriesWithoutPreview.length;
		for (const [index, entry] of entriesWithoutPreview.entries()) {
			const connector = index === total - 1 ? theme.tree.last : theme.tree.branch;
			const statusSymbol = this.#formatStatus(entry.status);
			const pathDisplay = this.#formatPath(entry);
			lines.push(`   ${theme.fg("dim", connector)} ${statusSymbol} ${pathDisplay}`.trimEnd());
		}

		this.#text.setText(lines.join("\n"));
		this.addChild(this.#text);

		for (const entry of entries) {
			if (this.#shouldRenderPreview(entry)) {
				this.#addContentPreview(entry);
			}
		}
	}

	/**
	 * Add a code-cell content preview below the entry summary.
	 * When collapsed: shows first COLLAPSED_PREVIEW_LINES lines with "… N more lines (Ctrl+O for more)" hint.
	 * When expanded: shows full content.
	 */
	#addContentPreview(entry: ReadEntry): void {
		const lang = getLanguageFromPath(splitPathAndSel(entry.path).path);
		const filePath = shortenPath(entry.path);
		const correctionSuffix = entry.correctedFrom ? ` (corrected from ${shortenPath(entry.correctedFrom)})` : "";
		const title = filePath ? `Read ${filePath}${correctionSuffix}` : "Read";
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		const expanded = this.#expanded;
		const component: Component = {
			render: (width: number) => {
				if (cachedLines && cachedWidth === width) return cachedLines;
				cachedLines = renderCodeCell(
					{
						code: entry.contentText ?? "",
						language: lang,
						title,
						status: entry.status === "success" ? "complete" : entry.status,
						expanded,
						codeMaxLines: expanded ? undefined : COLLAPSED_PREVIEW_LINES,
						width,
					},
					theme,
				);
				cachedWidth = width;
				return cachedLines;
			},
			invalidate: () => {
				cachedWidth = undefined;
				cachedLines = undefined;
			},
		};
		this.addChild(component);
	}

	#shouldRenderPreview(entry: ReadEntry): boolean {
		return this.#showContentPreview && entry.contentText !== undefined;
	}

	#formatPath(entry: ReadEntry): string {
		const filePath = shortenPath(entry.path);
		let pathDisplay = filePath ? theme.fg("accent", filePath) : theme.fg("toolOutput", "…");
		if (entry.correctedFrom) {
			pathDisplay += theme.fg("dim", ` (corrected from ${shortenPath(entry.correctedFrom)})`);
		}
		if (entry.conflictCount && entry.conflictCount > 0) {
			const n = entry.conflictCount;
			pathDisplay += ` ${theme.fg("warning", `(⚠ ${n} conflict${n === 1 ? "" : "s"})`)}`;
		}
		return pathDisplay;
	}

	#formatStatus(status: ReadEntry["status"]): string {
		if (status === "success") {
			return theme.fg("success", theme.status.success);
		}
		if (status === "warning") {
			return theme.fg("warning", theme.status.warning);
		}
		if (status === "error") {
			return theme.fg("error", theme.status.error);
		}
		return theme.fg("dim", theme.status.pending);
	}
}

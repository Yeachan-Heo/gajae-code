/**
 * Component for displaying bash command execution with streaming output.
 */

import {
	Container,
	Ellipsis,
	ImageProtocol,
	isTerminalGraphicsFallbackActive,
	type Loader,
	TERMINAL,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@gajae-code/tui";
import { sanitizeText } from "@gajae-code/utils";
import { theme } from "../../modes/theme/theme";
import type { TruncationMeta } from "../../tools/output-meta";
import {
	containsSixelSequence,
	getSixelLineMask,
	isSixelPassthroughEnabled,
	sanitizeWithOptionalSixelPassthrough,
} from "../../utils/sixel";
import {
	buildExecutionFrame,
	buildStatusFooter,
	createCollapsedPreview,
	type ExecutionStatus,
	resolveExecutionStatus,
} from "./execution-shared";

// Preview line limit when not expanded (matches tool execution behavior)
const PREVIEW_LINES = 20;
const STREAMING_PREVIEW_LINE_CAP = PREVIEW_LINES * 5;
const MAX_DISPLAY_LINE_CHARS = 4000;
// Minimum interval between processing incoming chunks for display (ms).
// Chunks arriving faster than this are accumulated and processed in one batch.
const CHUNK_THROTTLE_MS = 50;

export class BashExecutionComponent extends Container {
	#outputLines: string[] = [];
	#fullOutputChunks: string[] = [];
	#fullOutputText?: string;
	#fullOutputLines?: string[];
	#pendingOutputChunks: string[] = [];
	#flushTimer?: NodeJS.Timeout;
	#status: ExecutionStatus = "running";
	#exitCode: number | undefined = undefined;
	#loader: Loader;
	#truncation?: TruncationMeta;
	#expanded = false;
	#displayDirty = false;
	#displayBuiltWithGraphicsFallback: boolean | undefined;
	#contentContainer: Container;
	#headerText: Text;
	#ui: TUI;

	constructor(
		private readonly command: string,
		ui: TUI,
		excludeFromContext = false,
	) {
		super();
		this.#ui = ui;

		// Use dim border for excluded-from-context commands (!! prefix)
		const colorKey = excludeFromContext ? "dim" : "bashMode";
		const { contentContainer, loader } = buildExecutionFrame(this, ui, colorKey);
		this.#contentContainer = contentContainer;
		this.#loader = loader;

		// Command header: terse shell rail, no extra render work on streaming chunks.
		const shellLabel = excludeFromContext ? "shell · no context" : "shell";
		this.#headerText = new Text(
			`${theme.fg(colorKey, theme.bold(shellLabel))} ${theme.fg("dim", "·")} ${theme.fg(
				colorKey,
				theme.bold(`$ ${command}`),
			)}`,
			1,
			0,
		);
		this.#contentContainer.addChild(this.#headerText);
		this.#contentContainer.addChild(this.#loader);
	}

	/**
	 * Set whether the output is expanded (shows full output) or collapsed (preview only).
	 */
	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.#displayDirty = false;
		this.#updateDisplay();
	}

	appendOutput(chunk: string): void {
		const clean = sanitizeWithOptionalSixelPassthrough(chunk, sanitizeText);
		if (clean.length === 0) return;

		// Keep every chunk for expanded output. Only the preview update is
		// throttled; dropping chunks here makes live output lose arbitrary middle
		// sections even when the executor captured them successfully.
		this.#fullOutputChunks.push(clean);
		this.#fullOutputText = undefined;
		this.#fullOutputLines = undefined;
		this.#pendingOutputChunks.push(clean);
		if (this.#flushTimer) return;
		this.#flushTimer = setTimeout(() => {
			this.#flushTimer = undefined;
			this.#flushPendingOutput();
		}, CHUNK_THROTTLE_MS);
	}

	#flushPendingOutput(): void {
		if (this.#pendingOutputChunks.length === 0) return;
		const chunk = this.#pendingOutputChunks.join("");
		this.#pendingOutputChunks = [];

		const incomingLines = chunk.split("\n");
		if (this.#outputLines.length > 0 && incomingLines.length > 0) {
			const lastIndex = this.#outputLines.length - 1;
			const mergedLines = [`${this.#outputLines[lastIndex]}${incomingLines[0]}`, ...incomingLines.slice(1)];
			const clampedMergedLines = this.#clampLinesPreservingSixel(mergedLines);
			this.#outputLines[lastIndex] = clampedMergedLines[0] ?? "";
			this.#outputLines.push(...clampedMergedLines.slice(1));
		} else {
			this.#outputLines.push(...this.#clampLinesPreservingSixel(incomingLines));
		}

		// Keep the collapsed preview bounded. The complete stream remains in
		// #fullOutputChunks for expanded rendering and getOutput().
		if (this.#outputLines.length > STREAMING_PREVIEW_LINE_CAP) {
			this.#outputLines = this.#outputLines.slice(-STREAMING_PREVIEW_LINE_CAP);
		}

		this.#displayDirty = true;
		this.#ui.requestRender();
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		options?: { output?: string; truncation?: TruncationMeta },
	): void {
		if (this.#flushTimer) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = undefined;
		}
		this.#flushPendingOutput();
		this.#exitCode = exitCode;
		this.#status = resolveExecutionStatus(exitCode, cancelled);
		this.#truncation = options?.truncation;
		if (options?.output !== undefined && this.#fullOutputChunks.length === 0) {
			this.#setOutput(options.output);
		}

		// Stop loader
		this.#loader.stop();

		this.#updateDisplay();
	}

	override render(width: number): string[] {
		const fallbackActive = isTerminalGraphicsFallbackActive();
		if (this.#displayDirty || this.#displayBuiltWithGraphicsFallback !== fallbackActive) {
			this.#displayDirty = false;
			this.#updateDisplay();
		}
		return super.render(width);
	}

	override dispose(): void {
		if (this.#flushTimer) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = undefined;
		}
		this.#pendingOutputChunks = [];
		super.dispose();
	}

	#updateDisplay(): void {
		const fallbackActive = isTerminalGraphicsFallbackActive();
		const availableLines = this.#expanded ? this.#getFullOutputLines() : this.#outputLines;
		const sixelLineMask =
			fallbackActive || (TERMINAL.imageProtocol === ImageProtocol.Sixel && isSixelPassthroughEnabled())
				? getSixelLineMask(availableLines)
				: undefined;
		const hasSixelOutput = sixelLineMask?.some(Boolean) ?? false;
		const selectedLines =
			this.#expanded || (hasSixelOutput && !fallbackActive) ? availableLines : availableLines.slice(-PREVIEW_LINES);
		const hiddenLineCount = availableLines.length - selectedLines.length;

		// Rebuild content container
		// Detach (not dispose): #headerText and the running #loader are persistent,
		// reused instances re-added below. A disposing clear() would stop the loader's
		// animation timer mid-run. Final teardown still stops the loader via the
		// component's recursive dispose().
		this.#contentContainer.detachAll();

		// Command header
		this.#contentContainer.addChild(this.#headerText);

		// Output
		if (selectedLines.length > 0) {
			if (fallbackActive && hasSixelOutput) {
				const displayLines: string[] = [];
				const selectedStart = availableLines.length - selectedLines.length;
				for (const [selectedIndex, line] of selectedLines.entries()) {
					const index = selectedStart + selectedIndex;
					if (sixelLineMask?.[index]) {
						// Emit one placeholder per visible SIXEL block: at a true sequence
						// start, at the top of a collapsed slice that begins mid-sequence,
						// or when the line itself opens a new sequence.
						const isBlockStart = selectedIndex === 0 || !sixelLineMask[index - 1] || containsSixelSequence(line);
						if (isBlockStart) {
							displayLines.push(theme.fg("muted", "[SIXEL image hidden while IRC sidebar is visible]"));
						}
					} else {
						displayLines.push(theme.fg("muted", line));
					}
				}
				this.#contentContainer.addChild(new Text(`\n${displayLines.join("\n")}`, 1, 0));
			} else if (this.#expanded || hasSixelOutput) {
				const displayText = selectedLines
					.map((line, selectedIndex) => {
						const index = availableLines.length - selectedLines.length + selectedIndex;
						return sixelLineMask?.[index] ? line : theme.fg("muted", line);
					})
					.join("\n");
				this.#contentContainer.addChild(new Text(`\n${displayText}`, 1, 0));
			} else {
				// Use shared visual truncation utility, recomputed per render width
				const styledOutput = selectedLines.map(line => theme.fg("muted", line)).join("\n");
				this.#contentContainer.addChild(createCollapsedPreview(`\n${styledOutput}`, PREVIEW_LINES));
			}
		}

		// Loader or status
		if (this.#status === "running") {
			this.#contentContainer.addChild(this.#loader);
		} else {
			const footer = buildStatusFooter({
				status: this.#status,
				exitCode: this.#exitCode,
				truncation: this.#truncation,
				hiddenLineCount,
				suppressHiddenCount: hasSixelOutput && !fallbackActive,
			});
			if (footer) this.#contentContainer.addChild(footer);
		}
		this.#displayBuiltWithGraphicsFallback = fallbackActive;
	}

	#clampDisplayLine(line: string): string {
		const visible = visibleWidth(line);
		if (visible <= MAX_DISPLAY_LINE_CHARS) {
			return line;
		}
		const omitted = visible - MAX_DISPLAY_LINE_CHARS;
		return `${truncateToWidth(line, MAX_DISPLAY_LINE_CHARS, Ellipsis.Omit)}… [${omitted} visible columns omitted]`;
	}

	#clampLinesPreservingSixel(lines: string[]): string[] {
		if (lines.length === 0) return [];
		const sixelLineMask = getSixelLineMask(lines);
		if (!sixelLineMask.some(Boolean)) {
			return lines.map(line => this.#clampDisplayLine(line));
		}
		return lines.map((line, index) => (sixelLineMask[index] ? line : this.#clampDisplayLine(line)));
	}

	#setOutput(output: string): void {
		const clean = sanitizeWithOptionalSixelPassthrough(output, sanitizeText);
		this.#fullOutputChunks = clean ? [clean] : [];
		this.#fullOutputText = clean;
		this.#fullOutputLines = clean ? this.#clampLinesPreservingSixel(clean.split("\n")) : [];
		this.#outputLines = this.#fullOutputLines.slice(-STREAMING_PREVIEW_LINE_CAP);
	}

	#getFullOutput(): string {
		if (this.#fullOutputText === undefined) {
			this.#fullOutputText = this.#fullOutputChunks.join("");
		}
		return this.#fullOutputText;
	}

	#getFullOutputLines(): string[] {
		if (this.#fullOutputLines === undefined) {
			const fullOutput = this.#getFullOutput();
			this.#fullOutputLines = fullOutput ? this.#clampLinesPreservingSixel(fullOutput.split("\n")) : [];
		}
		return this.#fullOutputLines;
	}

	/**
	 * Get the raw output for creating BashExecutionMessage.
	 */
	getOutput(): string {
		return this.#getFullOutputLines().join("\n");
	}

	/**
	 * Get the command that was executed.
	 */
	getCommand(): string {
		return this.command;
	}
}

import type { AgentTool } from "@gajae-code/agent-core";
import {
	type AnimationRegistration,
	Box,
	type Component,
	Container,
	getImageDimensions,
	Image,
	ImageProtocol,
	imageFallback,
	isTerminalGraphicsFallbackActive,
	registerAnimationCallback,
	Spacer,
	TERMINAL,
	Text,
	type TUI,
} from "@gajae-code/tui";
import { getProjectDir, logger, sanitizeText } from "@gajae-code/utils";
import { EDIT_MODE_STRATEGIES, type EditMode, type PerFileDiffPreview } from "../../edit";
import type { Theme } from "../../modes/theme/theme";
import { theme } from "../../modes/theme/theme";
import { BASH_DEFAULT_PREVIEW_LINES } from "../../tools/bash";
import { EVAL_DEFAULT_PREVIEW_LINES } from "../../tools/eval";
import {
	formatArgsInline,
	JSON_TREE_MAX_DEPTH_COLLAPSED,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_COLLAPSED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_COLLAPSED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
	renderJsonTreeLines,
} from "../../tools/json-tree";
import { formatExpandHint, replaceTabs, resolveImageOptions, truncateToWidth } from "../../tools/render-utils";
import { toolRenderers } from "../../tools/renderers";
import { renderStatusLine } from "../../tui";
import { containsSixelSequence, getSixelLineMask, sanitizeWithOptionalSixelPassthrough } from "../../utils/sixel";
import { renderDiff } from "./diff";

function ensureInvalidate(component: unknown): Component {
	const c = component as { render: Component["render"]; invalidate?: () => void };
	if (!c.invalidate) {
		c.invalidate = () => {};
	}
	return c as Component;
}

const SIXEL_FALLBACK_PLACEHOLDER = "[SIXEL image hidden while IRC sidebar is visible]";

function replaceSixelOutputForGraphicsFallback(text: string): string {
	const lines = text.split("\n");
	const sixelLineMask = getSixelLineMask(lines);
	if (!sixelLineMask.some(Boolean)) return text;

	return lines
		.flatMap((line, index) => {
			if (!sixelLineMask[index]) return [line];
			return index === 0 || !sixelLineMask[index - 1] || containsSixelSequence(line)
				? [SIXEL_FALLBACK_PLACEHOLDER]
				: [];
		})
		.join("\n");
}

function cloneToolArgs<T>(args: T): T {
	if (args === null || args === undefined) return args;
	try {
		return structuredClone(args);
	} catch {
		return args;
	}
}

// Built-in tool renderers that treat call args as read-only, so streaming UI can
// avoid per-delta defensive clone churn. Kept here (not in the tool renderer
// registry) because it is a rendering-perf capability of these renderers, not a
// tool-registration concern.
const READONLY_ARG_RENDERER_TOOLS = new Set(["bash", "recipe", "eval", "edit", "apply_patch"]);

function argsCanBeSharedWithRenderer(toolName: string, tool: AgentTool | undefined): boolean {
	return !tool?.renderCall && !tool?.renderResult && READONLY_ARG_RENDERER_TOOLS.has(toolName);
}

function partialJsonLength(args: unknown): number {
	const value = args && typeof args === "object" ? (args as { __partialJson?: unknown }).__partialJson : undefined;
	return typeof value === "string" ? value.length : -1;
}

/**
 * Drop trailing removal/hunk-header lines that appear in a streaming diff
 * before the matching `+added` lines have arrived. Without this, a partial
 * apply_patch / hashline preview shows `-old` first and then visibly grows
 * the `+new` block beneath it — the "removals first, additions catching up"
 * jitter. Once the next streaming tick brings the additions in, the trailing
 * block reappears alongside them.
 */
function stripTrailingUnbalancedRemoval(diff: string | undefined): string | undefined {
	if (!diff) return diff;
	const lines = diff.split("\n");
	let lastAddIdx = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].startsWith("+")) {
			lastAddIdx = i;
			break;
		}
	}
	let hasTrailingUnbalanced = false;
	for (let i = lastAddIdx + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith("-") || line.startsWith("@@")) {
			hasTrailingUnbalanced = true;
			break;
		}
	}
	if (!hasTrailingUnbalanced) return diff;
	if (lastAddIdx === -1) return "";
	return lines.slice(0, lastAddIdx + 1).join("\n");
}

function stabilizeStreamingPreviews(previews: PerFileDiffPreview[]): PerFileDiffPreview[] {
	let changed = false;
	const next = previews.map(preview => {
		if (!preview.diff) return preview;
		const trimmed = stripTrailingUnbalancedRemoval(preview.diff);
		if (trimmed === preview.diff) return preview;
		changed = true;
		return { ...preview, diff: trimmed ?? "" };
	});
	return changed ? next : previews;
}

function isEditLikeToolName(toolName: string): boolean {
	return toolName === "edit" || toolName === "apply_patch";
}

function resolveEditModeForTool(toolName: string, tool: AgentTool | undefined): EditMode | undefined {
	if (toolName === "apply_patch") return "apply_patch";
	if (toolName !== "edit") return undefined;
	return (tool as { mode?: EditMode } | undefined)?.mode;
}

export interface ToolExecutionOptions {
	showImages?: boolean; // default: true (only used if terminal supports images)
	editFuzzyThreshold?: number;
	editAllowFuzzy?: boolean;
	hashlineAutoDropPureInsertDuplicates?: boolean;
}

export interface ToolExecutionHandle {
	updateArgs(args: any, toolCallId?: string): void;
	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError?: boolean;
		},
		isPartial?: boolean,
		toolCallId?: string,
	): void;
	setArgsComplete(toolCallId?: string): void;
	setExpanded(expanded: boolean): void;
	/**
	 * Applies an explicit fold choice for this renderer instance. The pin lasts
	 * only for this instance; transcript rebuilds recreate it from global state.
	 * Optional for source compatibility: this interface is publicly exported and
	 * pre-existing structural implementers must keep compiling. Dispatchers must
	 * guard with `typeof handle.setManuallyExpanded === "function"` and fall
	 * back to {@link setExpanded}.
	 */
	setManuallyExpanded?(expanded: boolean): void;
}

/**
 * Component that renders a tool call with its result (updateable)
 */
export class ToolExecutionComponent extends Container {
	#contentBox: Box; // Used for custom tools and bash visual truncation
	#contentText: Text; // For built-in tools (with its own padding/bg)
	#multiFileBoxes: (Box | Spacer)[] = []; // Extra boxes for multi-file edit results
	#imageComponents: Image[] = [];
	#imageSpacers: Spacer[] = [];
	#toolName: string;
	#toolLabel: string;
	#args: any;
	#expanded = false;
	#manuallyExpanded: boolean | undefined;
	#showImages: boolean;
	#editFuzzyThreshold: number | undefined;
	#editAllowFuzzy: boolean | undefined;
	#hashlineAutoDropPureInsertDuplicates: boolean | undefined;
	#isPartial = true;
	#tool?: AgentTool;
	#ui: TUI;
	#cwd: string;
	#result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError?: boolean;
		details?: any;
	};
	#textOutputCache?: {
		content: unknown;
		showImages: boolean;
		terminalImageProtocol: unknown;
		graphicsFallbackActive: boolean;
		output: string;
	};
	#displayBuiltWithGraphicsFallback: boolean | undefined;
	// Edit preview state
	#editMode?: EditMode;
	#editDiffPreview?: PerFileDiffPreview[];
	#editDiffAbort?: AbortController;
	#editDiffLastArgsKey?: string;
	#argsIdentityVersion = 0;
	#lastArgsReference: any;
	#shareArgsWithRenderer = false;
	// Cached converted images for Kitty protocol (which requires PNG), keyed by index
	#convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	// Spinner animation for partial task results
	#spinnerFrame?: number;
	#spinnerAnimation?: AnimationRegistration;
	// Track if args are still being streamed (for edit/write spinner)
	#argsComplete = false;
	#renderState: {
		spinnerFrame?: number;
		expanded: boolean;
		isPartial: boolean;
		renderContext?: Record<string, unknown>;
	} = {
		expanded: false,
		isPartial: true,
	};

	constructor(
		toolName: string,
		args: any,
		options: ToolExecutionOptions = {},
		tool: AgentTool | undefined,
		ui: TUI,
		cwd: string = getProjectDir(),
		_toolCallId?: string,
	) {
		super();
		this.#toolName = toolName;
		this.#toolLabel = tool?.label ?? toolName;
		this.#showImages = options.showImages ?? true;
		this.#editFuzzyThreshold = options.editFuzzyThreshold;
		this.#editAllowFuzzy = options.editAllowFuzzy;
		this.#hashlineAutoDropPureInsertDuplicates = options.hashlineAutoDropPureInsertDuplicates;
		this.#tool = tool;
		this.#ui = ui;
		this.#cwd = cwd;
		this.#shareArgsWithRenderer = argsCanBeSharedWithRenderer(toolName, tool);
		this.#lastArgsReference = args;
		this.#args = this.#shareArgsWithRenderer ? args : cloneToolArgs(args);

		this.addChild(new Spacer(1));

		// Always create both - contentBox for custom tools/bash/tools with renderers, contentText for other built-ins.
		// Vertical padding is 0: block separation comes solely from the leading Spacer
		// (1 blank line above each block), matching reference TUIs (083.2).
		this.#contentBox = new Box(1, 0, (text: string) => theme.bg("toolPendingBg", text));
		this.#contentText = new Text("", 1, 0, (text: string) => theme.bg("toolPendingBg", text));

		// Use Box for custom tools or built-in tools that have renderers
		const hasRenderer = toolName in toolRenderers;
		const hasCustomRenderer = !!(tool?.renderCall || tool?.renderResult);
		if (hasCustomRenderer || hasRenderer) {
			this.addChild(this.#contentBox);
		} else {
			this.addChild(this.#contentText);
		}

		this.#editMode = resolveEditModeForTool(toolName, tool);

		this.#updateDisplay();
		void this.#runPreviewDiff();
	}

	updateArgs(args: any, _toolCallId?: string): void {
		if (args !== this.#lastArgsReference) {
			this.#lastArgsReference = args;
			this.#argsIdentityVersion += 1;
		}
		this.#args = this.#shareArgsWithRenderer ? args : cloneToolArgs(args);
		this.#updateSpinnerAnimation();
		void this.#runPreviewDiff();
		this.#updateDisplay();
	}

	/**
	 * Signal that args are complete (tool is about to execute).
	 * This triggers an immediate final diff computation for edit-like tools.
	 */
	setArgsComplete(_toolCallId?: string): void {
		this.#argsComplete = true;
		this.#updateSpinnerAnimation();
		void this.#runPreviewDiff();
	}

	async #runPreviewDiff(): Promise<void> {
		const editMode = this.#editMode;
		if (!editMode) return;
		const strategy = EDIT_MODE_STRATEGIES[editMode];
		if (!strategy) return;

		const args = this.#args;
		if (args == null || typeof args !== "object") return;

		const partialJson = (args as { __partialJson?: string }).__partialJson;
		let effectiveArgs: unknown;
		try {
			effectiveArgs = strategy.extractCompleteEdits(args, partialJson);
		} catch {
			effectiveArgs = args;
		}

		// Coalesce duplicate computes without serializing multi-KB streamed args every delta.
		const argsKey = [
			this.#toolName,
			this.#argsIdentityVersion,
			partialJsonLength(args),
			this.#argsComplete ? 1 : 0,
		].join(":");
		if (argsKey === this.#editDiffLastArgsKey) return;
		this.#editDiffLastArgsKey = argsKey;

		this.#editDiffAbort?.abort();
		const controller = new AbortController();
		this.#editDiffAbort = controller;

		try {
			const isStreaming = !this.#argsComplete;
			const previews = await strategy.computeDiffPreview(effectiveArgs, {
				cwd: this.#cwd,
				signal: controller.signal,
				fuzzyThreshold: this.#editFuzzyThreshold,
				allowFuzzy: this.#editAllowFuzzy,
				hashlineAutoDropPureInsertDuplicates: this.#hashlineAutoDropPureInsertDuplicates,
				isStreaming,
			});
			if (controller.signal.aborted) return;
			if (previews) {
				this.#editDiffPreview = isStreaming ? stabilizeStreamingPreviews(previews) : previews;
				this.#updateDisplay();
				this.#ui.requestRender();
			}
		} catch (err) {
			if (controller.signal.aborted) return;
			logger.warn("Edit preview diff failed", { tool: this.#toolName, error: String(err) });
		}
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError?: boolean;
		},
		isPartial = false,
		_toolCallId?: string,
	): void {
		this.#textOutputCache = undefined;
		this.#result = result;
		this.#isPartial = isPartial;
		// When tool is complete, ensure args are marked complete so spinner stops
		if (!isPartial) {
			this.#argsComplete = true;
		}
		this.#updateSpinnerAnimation();
		this.#updateDisplay();
		// Convert non-PNG images to PNG for Kitty protocol (async)
		this.#maybeConvertImagesForKitty();
	}

	/**
	 * Get all image blocks from result content and details.images.
	 * Some tools (like generate_image) store images in details to avoid bloating model context.
	 */
	#getAllImageBlocks(): Array<{ data?: string; mimeType?: string }> {
		if (!this.#result) return [];
		const contentImages = this.#result.content?.filter((c: any) => c.type === "image") || [];
		const detailImages = this.#result.details?.images || [];
		return [...contentImages, ...detailImages];
	}

	/**
	 * Convert non-PNG images to PNG for Kitty graphics protocol.
	 * Kitty requires PNG format (f=100), so JPEG/GIF/WebP won't display.
	 */
	#maybeConvertImagesForKitty(): void {
		// Only needed for Kitty protocol
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty) return;
		if (!this.#result) return;

		const imageBlocks = this.#getAllImageBlocks();

		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			// Skip if already PNG or already converted
			if (img.mimeType === "image/png") continue;
			if (this.#convertedImages.has(i)) continue;

			// Convert async - catch errors from processing
			const index = i;
			new Bun.Image(Buffer.from(img.data, "base64"))
				.png()
				.toBase64()
				.then(data => {
					this.#convertedImages.set(index, { data, mimeType: "image/png" });
					this.#updateDisplay();
					this.#ui.requestRender();
				})
				.catch(() => {
					// Ignore conversion failures - display will use original image format
				});
		}
	}

	/**
	 * Start or stop spinner animation based on whether this is a partial task result.
	 */
	#updateSpinnerAnimation(): void {
		// Spinner for: task tool with partial result, or edit/write while args streaming
		const isStreamingArgs = !this.#argsComplete && (isEditLikeToolName(this.#toolName) || this.#toolName === "write");
		const isBackgroundAsyncTask =
			this.#toolName === "task" &&
			(this.#result?.details as { async?: { state?: string } } | undefined)?.async?.state === "running";
		const isPartialTask = this.#isPartial && this.#toolName === "task" && !isBackgroundAsyncTask;
		const needsSpinner = isStreamingArgs || isPartialTask;
		if (needsSpinner && !this.#spinnerAnimation) {
			this.#spinnerAnimation = registerAnimationCallback(() => {
				const frameCount = theme.spinnerFrames.length;
				if (frameCount === 0) return;
				this.#spinnerFrame = ((this.#spinnerFrame ?? -1) + 1) % frameCount;
				this.#renderState.spinnerFrame = this.#spinnerFrame;
				this.#ui.requestRender();
			}, 80);
		} else if (!needsSpinner && this.#spinnerAnimation) {
			this.#spinnerAnimation.unregister();
			this.#spinnerAnimation = undefined;
		}
	}

	/**
	 * Stop spinner animation and cleanup resources.
	 */
	stopAnimation(): void {
		if (this.#spinnerAnimation) {
			this.#spinnerAnimation.unregister();
			this.#spinnerAnimation = undefined;
			this.#spinnerFrame = undefined;
		}
		this.#editDiffAbort?.abort();
		this.#editDiffAbort = undefined;
	}

	override dispose(): void {
		this.stopAnimation();
		super.dispose();
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

	setShowImages(show: boolean): void {
		this.#showImages = show;
		this.#textOutputCache = undefined;
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.#updateDisplay();
	}

	override render(width: number): string[] {
		if (this.#displayBuiltWithGraphicsFallback !== isTerminalGraphicsFallbackActive()) {
			this.#updateDisplay();
		}
		return super.render(width);
	}

	#updateDisplay(): void {
		// Set background based on state
		const bgFn = this.#isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: this.#result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		// Sync shared mutable render state for component closures
		this.#renderState.expanded = this.#expanded;
		this.#renderState.isPartial = this.#isPartial;
		this.#renderState.spinnerFrame = this.#spinnerFrame;

		// Check for custom tool rendering
		if (this.#tool && (this.#tool.renderCall || this.#tool.renderResult)) {
			const tool = this.#tool;
			const mergeCallAndResult = Boolean((tool as { mergeCallAndResult?: boolean }).mergeCallAndResult);
			// Custom tools use Box for flexible component rendering
			const inline = Boolean((tool as { inline?: boolean }).inline);
			this.#contentBox.setBgFn(inline ? undefined : bgFn);
			this.#contentBox.clear();

			// Render call component
			const shouldRenderCall = !this.#result || !mergeCallAndResult;
			if (shouldRenderCall && tool.renderCall) {
				try {
					const callComponent = tool.renderCall(this.#getCallArgsForRender(), this.#renderState, theme);
					if (callComponent) {
						this.#contentBox.addChild(ensureInvalidate(callComponent));
					}
				} catch (err) {
					logger.warn("Tool renderer failed", { tool: this.#toolName, error: String(err) });
					// Fall back to default on error
					this.#contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.#toolLabel)), 0, 0));
				}
			} else {
				// No custom renderCall, show tool name
				this.#contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.#toolLabel)), 0, 0));
			}

			// Render result component if we have a result
			if (this.#result && tool.renderResult) {
				try {
					const renderResult = tool.renderResult as (
						result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
						options: { expanded: boolean; isPartial: boolean; spinnerFrame?: number },
						theme: Theme,
						args?: unknown,
					) => Component;
					const resultComponent = renderResult(
						{
							content: this.#result.content as any,
							details: this.#result.details,
							isError: this.#result.isError,
						},
						this.#renderState,
						theme,
						this.#args,
					);
					if (resultComponent) {
						this.#contentBox.addChild(ensureInvalidate(resultComponent));
					}
				} catch (err) {
					logger.warn("Tool renderer failed", { tool: this.#toolName, error: String(err) });
					// Fall back to showing raw output on error
					const output = this.#getTextOutput();
					if (output) {
						this.#contentBox.addChild(new Text(theme.fg("toolOutput", replaceTabs(output)), 0, 0));
					}
				}
			} else if (this.#result) {
				// Has result but no custom renderResult
				const output = this.#getTextOutput();
				if (output) {
					this.#contentBox.addChild(new Text(theme.fg("toolOutput", replaceTabs(output)), 0, 0));
				}
			}
		} else if (this.#toolName in toolRenderers) {
			// Built-in tools with renderers
			const renderer = toolRenderers[this.#toolName];

			// Clean up previous multi-file boxes
			for (const box of this.#multiFileBoxes) {
				this.removeChild(box);
			}
			this.#multiFileBoxes = [];

			// Check for multi-file edit results
			const perFileResults = this.#result?.details?.perFileResults as
				| Array<{ path: string; isError?: boolean }>
				| undefined;
			if (perFileResults && perFileResults.length > 1) {
				// Multi-file: render each file as its own Box (identical to separate tool calls)
				this.#contentBox.setBgFn(undefined);
				this.#contentBox.clear();

				const renderContext = this.#buildRenderContext();
				this.#renderState.renderContext = renderContext;

				for (let i = 0; i < perFileResults.length; i++) {
					const fileResult = perFileResults[i];
					if (i > 0) {
						const spacer = new Spacer(1);
						this.#multiFileBoxes.push(spacer);
						this.addChild(spacer);
					}
					const fileBgFn = fileResult.isError
						? (text: string) => theme.bg("toolErrorBg", text)
						: (text: string) => theme.bg("toolSuccessBg", text);
					const fileBox = new Box(1, 0, fileBgFn);
					try {
						const resultComponent = renderer.renderResult(
							{ content: [], details: fileResult, isError: fileResult.isError },
							this.#renderState,
							theme,
						);
						if (resultComponent) {
							fileBox.addChild(ensureInvalidate(resultComponent));
						}
					} catch (err) {
						logger.warn("Tool renderer failed", { tool: this.#toolName, error: String(err) });
					}
					this.#multiFileBoxes.push(fileBox);
					this.addChild(fileBox);
				}

				// Show pending indicator for remaining files
				const totalFiles = this.#args?.edits
					? new Set((this.#args.edits as any[]).map((e: any) => e?.path).filter(Boolean)).size
					: 0;
				const remaining = Math.max(0, totalFiles - perFileResults.length);
				if (remaining > 0 && this.#isPartial) {
					const pendingSpacer = new Spacer(1);
					this.#multiFileBoxes.push(pendingSpacer);
					this.addChild(pendingSpacer);
					const pendingBox = new Box(1, 0, (text: string) => theme.bg("toolPendingBg", text));
					const pendingText = renderStatusLine(
						{
							icon: "pending",
							title: "Edit",
							description: theme.fg("dim", `${remaining} more file${remaining > 1 ? "s" : ""} pending…`),
						},
						theme,
					);
					pendingBox.addChild(new Text(pendingText, 0, 0));
					this.#multiFileBoxes.push(pendingBox);
					this.addChild(pendingBox);
				}
			} else {
				// Single-file or no result: standard rendering
				// Inline renderers skip background styling
				this.#contentBox.setBgFn(renderer.inline ? undefined : bgFn);
				this.#contentBox.clear();

				const renderContext = this.#buildRenderContext();
				this.#renderState.renderContext = renderContext;

				const shouldRenderCall = !this.#result || !renderer.mergeCallAndResult;
				if (shouldRenderCall) {
					// Render call component
					try {
						const callComponent = renderer.renderCall(this.#getCallArgsForRender(), this.#renderState, theme);
						if (callComponent) {
							this.#contentBox.addChild(ensureInvalidate(callComponent));
						}
					} catch (err) {
						logger.warn("Tool renderer failed", { tool: this.#toolName, error: String(err) });
						// Fall back to default on error
						this.#contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.#toolLabel)), 0, 0));
					}
				}

				// Render result component if we have a result
				if (this.#result) {
					try {
						const resultComponent = renderer.renderResult(
							{
								content: this.#result.content as any,
								details: this.#result.details,
								isError: this.#result.isError,
							},
							this.#renderState,
							theme,
							this.#getCallArgsForRender(),
						);
						if (resultComponent) {
							this.#contentBox.addChild(ensureInvalidate(resultComponent));
						}
					} catch (err) {
						logger.warn("Tool renderer failed", { tool: this.#toolName, error: String(err) });
						// Fall back to showing raw output on error
						const output = this.#getTextOutput();
						if (output) {
							this.#contentBox.addChild(new Text(theme.fg("toolOutput", replaceTabs(output)), 0, 0));
						}
					}
				}
			}
		} else {
			// Other built-in tools: use Text directly with caching
			this.#contentText.setCustomBgFn(bgFn);
			this.#contentText.setText(this.#formatToolExecution());
		}

		// Handle images (same for both custom and built-in)
		for (const img of this.#imageComponents) {
			this.removeChild(img);
		}
		this.#imageComponents = [];
		for (const spacer of this.#imageSpacers) {
			this.removeChild(spacer);
		}
		this.#imageSpacers = [];

		if (this.#result) {
			const imageBlocks = this.#getAllImageBlocks();

			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (TERMINAL.imageProtocol && this.#showImages && img.data && img.mimeType) {
					// Use converted PNG for Kitty protocol if available
					const converted = this.#convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;

					// For Kitty, skip non-PNG images that haven't been converted yet
					if (TERMINAL.imageProtocol === ImageProtocol.Kitty && imageMimeType !== "image/png") {
						continue;
					}

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.#imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ ...resolveImageOptions(), refetch: () => imageData },
					);
					this.#imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}
		this.#displayBuiltWithGraphicsFallback = isTerminalGraphicsFallbackActive();
	}

	#getCallArgsForRender(): any {
		if (!isEditLikeToolName(this.#toolName)) {
			return this.#args;
		}
		const previews = this.#editDiffPreview;
		if (!previews || previews.length === 0) {
			return this.#args;
		}
		// Single-file previews feed the existing `previewDiff` channel consumed
		// by `formatStreamingDiff` in the renderer.
		const first = previews[0];
		if (!first?.diff) {
			return this.#args;
		}
		return { ...(this.#args as Record<string, unknown>), previewDiff: first.diff };
	}

	/**
	 * Build render context for tools that need extra state (bash, python, edit)
	 */
	#buildRenderContext(): Record<string, unknown> {
		const context: Record<string, unknown> = {};
		const normalizeTimeoutSeconds = (value: unknown, maxSeconds: number): number | undefined => {
			if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
			return Math.max(1, Math.min(maxSeconds, value));
		};

		if (this.#toolName === "bash") {
			// Bash needs render context even before a result exists. The renderer uses the pending-call args
			// plus this context to keep the inline command preview visible while tool-call JSON is still streaming.
			if (this.#result) {
				// Pass raw output and expanded state - renderer handles width-aware truncation
				const output = this.#getTextOutput().trimEnd();
				context.output = output;
			}
			context.expanded = this.#expanded;
			context.previewLines = BASH_DEFAULT_PREVIEW_LINES;
			context.timeout = normalizeTimeoutSeconds(this.#args?.timeout, 3600);
		} else if (this.#toolName === "eval" && this.#result) {
			const output = this.#getTextOutput().trimEnd();
			context.output = output;
			context.expanded = this.#expanded;
			context.previewLines = EVAL_DEFAULT_PREVIEW_LINES;
		} else if (isEditLikeToolName(this.#toolName)) {
			context.editMode = this.#editMode;
			const previews = this.#editDiffPreview;
			if (previews && previews.length > 0) {
				const first = previews[0];
				if (first?.diff || first?.error) {
					context.editDiffPreview = first.error
						? { error: first.error }
						: { diff: first.diff ?? "", firstChangedLine: first.firstChangedLine };
				}
				if (previews.length > 1) {
					context.perFileDiffPreview = previews;
				}
			}
			if (!previews?.some(preview => preview.diff)) {
				const editMode = this.#editMode;
				const strategy = editMode ? EDIT_MODE_STRATEGIES[editMode] : undefined;
				const fallback = strategy?.renderStreamingFallback(this.#args, theme);
				if (fallback) context.editStreamingFallback = fallback;
			}
			context.renderDiff = renderDiff;
		}

		return context;
	}

	#getTextOutput(): string {
		if (!this.#result) return "";

		const content = this.#result.content;
		const terminalImageProtocol = TERMINAL.imageProtocol;
		const graphicsFallbackActive = isTerminalGraphicsFallbackActive();
		const cached = this.#textOutputCache;
		if (
			cached?.content === content &&
			cached.showImages === this.#showImages &&
			cached.terminalImageProtocol === terminalImageProtocol &&
			cached.graphicsFallbackActive === graphicsFallbackActive
		) {
			return cached.output;
		}

		const textParts: string[] = [];
		for (const block of content ?? []) {
			if (block.type !== "text") continue;
			const text = sanitizeWithOptionalSixelPassthrough(block.text || "", sanitizeText);
			textParts.push(graphicsFallbackActive ? replaceSixelOutputForGraphicsFallback(text) : text);
		}
		let output = textParts.join("\n");

		const imageBlocks = this.#getAllImageBlocks();
		if (imageBlocks.length > 0 && (!terminalImageProtocol || !this.#showImages)) {
			const imageIndicators = imageBlocks
				.map((img: any) => {
					const dims = img.data ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
					return imageFallback(img.mimeType, dims);
				})
				.join("\n");
			output = output ? `${output}\n${imageIndicators}` : imageIndicators;
		}

		this.#textOutputCache = {
			content,
			showImages: this.#showImages,
			terminalImageProtocol,
			graphicsFallbackActive,
			output,
		};
		return output;
	}

	/**
	 * Format a generic tool execution (fallback for tools without custom renderers)
	 */
	#formatToolExecution(): string {
		const lines: string[] = [];
		const icon = this.#isPartial ? "pending" : this.#result?.isError ? "error" : "success";
		lines.push(renderStatusLine({ icon, title: this.#toolLabel }, theme));

		const argsObject = this.#args && typeof this.#args === "object" ? (this.#args as Record<string, unknown>) : null;
		if (!this.#expanded && argsObject && Object.keys(argsObject).length > 0) {
			const preview = formatArgsInline(argsObject, 70);
			if (preview) {
				lines.push(` ${theme.fg("dim", theme.tree.last)} ${theme.fg("dim", preview)}`);
			}
		}

		if (this.#expanded && this.#args !== undefined) {
			lines.push("");
			lines.push(theme.fg("dim", "Args"));
			const tree = renderJsonTreeLines(
				this.#args,
				theme,
				JSON_TREE_MAX_DEPTH_EXPANDED,
				JSON_TREE_MAX_LINES_EXPANDED,
				JSON_TREE_SCALAR_LEN_EXPANDED,
			);
			lines.push(...tree.lines);
			if (tree.truncated) {
				lines.push(theme.fg("dim", "…"));
			}
			lines.push("");
		}

		if (!this.#result) {
			return lines.join("\n");
		}

		const textContent = this.#getTextOutput().trimEnd();
		if (!textContent) {
			lines.push(theme.fg("dim", "(no output)"));
			return lines.join("\n");
		}

		if (textContent.startsWith("{") || textContent.startsWith("[")) {
			try {
				const parsed = JSON.parse(textContent);
				const maxDepth = this.#expanded ? JSON_TREE_MAX_DEPTH_EXPANDED : JSON_TREE_MAX_DEPTH_COLLAPSED;
				const maxLines = this.#expanded ? JSON_TREE_MAX_LINES_EXPANDED : JSON_TREE_MAX_LINES_COLLAPSED;
				const maxScalarLen = this.#expanded ? JSON_TREE_SCALAR_LEN_EXPANDED : JSON_TREE_SCALAR_LEN_COLLAPSED;
				const tree = renderJsonTreeLines(parsed, theme, maxDepth, maxLines, maxScalarLen);

				if (tree.lines.length > 0) {
					lines.push(...tree.lines);
					if (!this.#expanded) {
						lines.push(formatExpandHint(theme, this.#expanded, true));
					} else if (tree.truncated) {
						lines.push(theme.fg("dim", "…"));
					}
					return lines.join("\n");
				}
			} catch {
				// Fall through to raw output
			}
		}

		const outputLines = textContent.split("\n");
		const maxOutputLines = this.#expanded ? 12 : 4;
		const displayLines = outputLines.slice(0, maxOutputLines);

		for (const line of displayLines) {
			lines.push(theme.fg("toolOutput", truncateToWidth(replaceTabs(line), 80)));
		}

		if (outputLines.length > maxOutputLines) {
			const remaining = outputLines.length - maxOutputLines;
			lines.push(`${theme.fg("dim", `… ${remaining} more lines`)} ${formatExpandHint(theme, this.#expanded, true)}`);
		} else if (!this.#expanded) {
			lines.push(formatExpandHint(theme, this.#expanded, true));
		}

		return lines.join("\n");
	}
}

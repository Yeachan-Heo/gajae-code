/**
 * Minimal TUI implementation with differential rendering
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { $flag, $pickflag, getDebugLogPath, logger, onDefaultTabWidthChange } from "@gajae-code/utils";
import { getKeybindings } from "./keybindings";
import { isKeyRelease } from "./keys";
import { renderMetrics } from "./metrics";
import type { Terminal } from "./terminal";
import {
	encodeKittyPlacementDelete,
	extractKittyPlacementReferences,
	ImageProtocol,
	isImageProtocolForced,
	isUnderTerminalMultiplexer,
	type KittyPlacementReference,
	setCellDimensions,
	setTerminalImageProtocol,
	TERMINAL,
} from "./terminal-capabilities";
import {
	Ellipsis,
	extractSegments,
	isPrintableAscii,
	normalizeTerminalOutput,
	sliceByColumn,
	sliceWithWidth,
	truncateLinesToWidth,
	truncateToWidth,
	visibleWidth,
	visibleWidths,
} from "./utils";

const SEGMENT_RESET = "\x1b[0m";
/**
 * Per-line terminator written at the end of every non-image line. Closes both
 * SGR state and any in-flight OSC 8 hyperlink so styles/links cannot bleed
 * across lines in scrollback. Applied by {@link TUI.#applyLineResets} before
 * diffing so the latest frame mirrors emitted bytes.
 */
const LINE_TERMINATOR = "\x1b[0m\x1b]8;;\x07";
const MOUSE_SELECTION_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Discrete mouse-wheel notch size in terminal rows (xterm/less-style). */
export const DEFAULT_WHEEL_LINES = 3;

/** DA1 (`CSI ? … c`) and XTSMGRAPHICS (`CSI ? … S`) replies to the sixel probe. */
const DEVICE_REPORT_PATTERN = /^\x1b\[\?[\d;]*[cS]$/u;

function stripTerminalControls(text: string): string {
	return Bun.stripANSI(text)
		.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/gu, "")
		.replace(/\x1b[P_^X][\s\S]*?\x1b\\/gu, "")
		.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/gu, "")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "");
}
const CSI_PARAMETER = (value: number): boolean => value >= 0x30 && value <= 0x3f;
const CSI_INTERMEDIATE = (value: number): boolean => value >= 0x20 && value <= 0x2f;
const CSI_FINAL = (value: number): boolean => value >= 0x40 && value <= 0x7e;

function csiEnd(bytes: string, start: number): number | undefined {
	for (let index = start; index < bytes.length; index += 1) {
		const value = bytes.charCodeAt(index);
		if (CSI_FINAL(value)) return index;
		if (!CSI_PARAMETER(value) && !CSI_INTERMEDIATE(value)) return undefined;
	}
	return undefined;
}

/**
 * Remove component-owned erase controls and incomplete CSI fragments before
 * persistent bytes enter a shared render transaction. Erase controls cannot
 * repair native scrollback; dropping only the control preserves surrounding text
 * and keeps later frames renderable.
 */
function stripTerminalEraseControls(bytes: string): string {
	let sanitized = "";
	for (let index = 0; index < bytes.length; index += 1) {
		const value = bytes.charCodeAt(index);
		const isEscapeCsi = value === 0x1b && bytes.charCodeAt(index + 1) === 0x5b;
		const isEightBitCsi = value === 0x9b;
		if (value === 0x1b && index === bytes.length - 1) break;
		if (!isEscapeCsi && !isEightBitCsi) {
			sanitized += bytes[index];
			continue;
		}

		const start = isEightBitCsi ? index + 1 : index + 2;
		const end = csiEnd(bytes, start);
		if (end === undefined) {
			// Drop the CSI introducer and its complete parameter/intermediate prefix.
			// If an invalid delimiter follows, revisit it as ordinary text.
			let next = start;
			while (next < bytes.length) {
				const nextValue = bytes.charCodeAt(next);
				if (!CSI_PARAMETER(nextValue) && !CSI_INTERMEDIATE(nextValue)) break;
				next += 1;
			}
			index = next - 1;
			continue;
		}
		const final = bytes.charCodeAt(end);
		if (final !== 0x4a && final !== 0x4b) {
			sanitized += bytes.slice(index, end + 1);
		}
		index = end;
	}
	return sanitized;
}
type InputListenerResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputListenerResult;

/**
 * Component interface - all components must implement this
 */
export type MouseEvent = {
	kind: "wheel" | "click" | "drag" | "release";
	direction?: -1 | 1;
	button?: 0;
	/** Terminal cell coordinates, one-based. */
	x: number;
	y: number;
	/** Focused-overlay cell coordinates, one-based when dispatched to an overlay. */
	localX?: number;
	localY?: number;
};

type OverlayMouseBounds = {
	row: number;
	col: number;
	width: number;
	height: number;
	termWidth: number;
	termHeight: number;
};

export type MouseSelectionPoint = {
	line: number;
	column: number;
};

/** Parse xterm SGR mouse reports for wheel, left-click, drag, and release events. */
export function parseSgrMouseEvent(data: string): MouseEvent | undefined {
	const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
	if (!match) return undefined;
	const button = Number(match[1]);
	const x = Number(match[2]);
	const y = Number(match[3]);
	const terminator = match[4];
	if (![button, x, y].every(Number.isSafeInteger) || x < 1 || y < 1) return undefined;

	const baseButton = button & 3;
	if (button & 64) {
		if (terminator !== "M") return undefined;
		if (baseButton === 0) return { kind: "wheel", direction: -1, x, y };
		if (baseButton === 1) return { kind: "wheel", direction: 1, x, y };
		return undefined;
	}
	if (baseButton !== 0) return undefined;
	if (terminator === "m") return { kind: "release", button: 0, x, y };
	if (button & 32) return { kind: "drag", button: 0, x, y };
	return { kind: "click", button: 0, x, y };
}

export interface Component {
	/**
	 * Render the component to lines for the given viewport width
	 * @param width - Current viewport width
	 * @returns Array of strings, each representing a line
	 */
	render(width: number): string[];

	/**
	 * Optional handler for keyboard input when component has focus
	 */
	handleInput?(data: string): void;

	/** Optional handler for terminal mouse events when component has focus. */
	handleMouse?(event: MouseEvent): void;

	/**
	 * If true, component receives key release events (Kitty protocol).
	 * Default is false - release events are filtered out.
	 */
	wantsKeyRelease?: boolean;

	/**
	 * Invalidate any cached rendering state.
	 * Called when theme changes or when component needs to re-render from scratch.
	 */
	invalidate(): void;

	/**
	 * Optional cleanup hook. Called once when the component is permanently
	 * removed from the tree via removeChild/clear/dispose. Implementations MUST
	 * be idempotent. Components meant to be re-added should be detached, not
	 * removed/cleared.
	 */
	dispose?(): void;
}

/**
 * Interface for components that can receive focus and display a hardware cursor.
 * When focused, the component should emit CURSOR_MARKER at the cursor position
 * in its render output. TUI will find this marker and position the hardware
 * cursor there for proper IME candidate window positioning.
 */
export interface Focusable {
	/** Set by TUI when focus changes. Component should emit CURSOR_MARKER when true. */
	focused: boolean;
}

/** Type guard to check if a component implements Focusable */
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 * TUI finds and strips this marker, then positions the hardware cursor there.
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

export { visibleWidth };

/** Durable source identifier for a semantically anchored viewport row. */
export type ViewportAnchorId = string;
/** Immutable renderer-owned details of the most recently rendered viewport. */
export interface TuiViewportObservation {
	transcriptCapacity: number;
	pinBoundary: { row: number; pinned: boolean };
	manualHistory: boolean;
	newOutputNoticeVisible: boolean;
	outputRevision: string | null;
	focused: boolean;
	cursor: { row: number; col: number; visible: boolean } | null;
	selection: { start: MouseSelectionPoint; end: MouseSelectionPoint } | null;
	semanticAnchor: (ViewportAnchorRow & { frameRow: number }) | null;
}

export interface ViewportAnchorRow {
	id: ViewportAnchorId;
	graphemeStart: number;
	graphemeEnd: number;
	cellStart: number;
	cellEnd: number;
}

export interface ViewportAnchorRender {
	lines: string[];
	anchors: Array<ViewportAnchorRow | null>;
}

export interface ViewportAnchorProvider extends Component {
	renderWithViewportAnchors(width: number): ViewportAnchorRender;
}

export interface ViewportAnchorSource {
	id: ViewportAnchorId;
}

/** Identity and monotonic revision of the logical output producer. */
export type ViewportOutputSource = {
	identity: string;
	revision: bigint;
};
export interface ViewportAnchorSourceRenderer extends Component {
	renderWithViewportAnchorSource(width: number, source: ViewportAnchorSource): ViewportAnchorRender;
}

export function isViewportAnchorProvider(component: Component): component is ViewportAnchorProvider {
	if (!("renderWithViewportAnchors" in component) || typeof component.renderWithViewportAnchors !== "function") {
		return false;
	}
	return !(
		component instanceof Container &&
		component.renderWithViewportAnchors === Container.prototype.renderWithViewportAnchors &&
		component.render !== Container.prototype.render
	);
}

export function isViewportAnchorSourceRenderer(component: Component): component is ViewportAnchorSourceRenderer {
	return (
		"renderWithViewportAnchorSource" in component && typeof component.renderWithViewportAnchorSource === "function"
	);
}

export function renderComponentWithViewportAnchors(component: Component, width: number): ViewportAnchorRender {
	if (isViewportAnchorProvider(component)) {
		const rendered = component.renderWithViewportAnchors(width);
		if (rendered.anchors.length !== rendered.lines.length) {
			throw new Error(
				`Viewport anchor provider returned ${rendered.anchors.length} anchors for ${rendered.lines.length} lines`,
			);
		}
		return rendered;
	}
	const lines = component.render(width);
	return { lines, anchors: lines.map(() => null) };
}

export function renderComponentWithViewportAnchorSource(
	component: Component,
	width: number,
	source: ViewportAnchorSource,
): ViewportAnchorRender {
	if (!isViewportAnchorSourceRenderer(component)) {
		throw new TypeError("Viewport anchor sources require renderer-owned row metadata");
	}
	const rendered = component.renderWithViewportAnchorSource(width, source);
	if (rendered.anchors.length !== rendered.lines.length) {
		throw new Error(
			`Viewport anchor source renderer returned ${rendered.anchors.length} anchors for ${rendered.lines.length} lines`,
		);
	}
	return rendered;
}

/**
 * Anchor position for overlays
 */
export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

/**
 * Margin configuration for overlays
 */
export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

/** Value that can be absolute (number) or percentage (string like "50%") */
export type SizeValue = number | `${number}%`;

/** Parse a SizeValue into absolute value given a reference size */
function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	// Parse percentage string like "50%"
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

const DISABLED_ENV_VALUES = new Set(["0", "false", "off", "no"]);

function envIsEnabled(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized !== undefined && normalized.length > 0 && !DISABLED_ENV_VALUES.has(normalized);
}
function isWindowsTerminalSession(env: Record<string, string | undefined> = Bun.env): boolean {
	return envIsEnabled(env.WT_SESSION) || env.TERM_PROGRAM === "Windows_Terminal";
}

/**
 * Detect terminal multiplexers where scrollback clearing and height-change
 * redraws are hostile. Delegates to the shared capability predicate so the
 * renderer and graphics-protocol selection agree on what counts as a
 * multiplexed host.
 */
function isMultiplexerSession(env: Record<string, string | undefined> = Bun.env): boolean {
	return isUnderTerminalMultiplexer(env as NodeJS.ProcessEnv);
}

/**
 * Startup sixel capability probe policy (pure; exported for tests):
 * - Never probe when PI_FORCE_IMAGE_PROTOCOL is set — an explicit
 *   configuration (including "off") is authoritative.
 * - Never probe inside a terminal multiplexer: tmux advertises DA1 ";4"
 *   whenever it was compiled with sixel support, regardless of whether the
 *   attached client terminal can render sixel, so a positive reply is not
 *   end-to-end evidence. Graphics under a multiplexer are strictly opt-in
 *   via PI_FORCE_IMAGE_PROTOCOL=sixel.
 * - Probe Windows Terminal (>=1.22 renders sixel but exposes no env marker).
 */
export function shouldProbeSixelCapability(
	env: NodeJS.ProcessEnv = Bun.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (isImageProtocolForced()) return false;
	if (isUnderTerminalMultiplexer(env)) return false;
	return platform === "win32" && Boolean(env.WT_SESSION?.trim());
}

function isViewportSensitiveHost(
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform,
	includeNativeWindows: boolean,
	includeProcessTerminal: boolean,
): boolean {
	const underMultiplexer = isMultiplexerSession(env);
	if (underMultiplexer) {
		// Preserve the documented opt-in for the legacy clear/replay path. This
		// must take precedence over the process-terminal capability because tmux
		// and screen sessions commonly expose a real process terminal as well.
		return !envIsEnabled(env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER);
	}
	return isWindowsTerminalSession(env) || includeProcessTerminal || (includeNativeWindows && platform === "win32");
}
/**
 * True when repainting only the live viewport is safer than clearing/replaying
 * the full transcript. Real process terminals are viewport-sensitive because
 * their native scrollback position is not observable by the renderer. Native
 * Windows console hosts are also recognized from platform identity when that
 * process-terminal capability is unavailable.
 */
export function shouldUseViewportRepaintForHost(
	env: Record<string, string | undefined> = Bun.env,
	platform: NodeJS.Platform = process.platform,
	options: { includeNativeWindows?: boolean; includeProcessTerminal?: boolean } = {},
): boolean {
	const includeNativeWindows = options.includeNativeWindows ?? true;
	const includeProcessTerminal = options.includeProcessTerminal ?? false;
	return isViewportSensitiveHost(env, platform, includeNativeWindows, includeProcessTerminal);
}

/**
 * Viewport-repaint host gate resolved against a terminal's reported capability.
 *
 * `includeNativeWindows` exists so a Windows console host that cannot report
 * `isProcessTerminal` is still recognized from platform identity. It is a
 * fallback, so it must not outrank a terminal that has answered: a terminal
 * reporting `false` is not a native console host, and letting win32 override it
 * gives every non-process terminal on Windows — embedders, pipes, and the
 * render regression suite — viewport-repaint semantics. Those hosts then never
 * replay durable history, so contracted rows survive as duplicates.
 */
export function shouldUseViewportRepaintForTerminal(
	isProcessTerminal: boolean | undefined,
	env: Record<string, string | undefined> = Bun.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	return shouldUseViewportRepaintForHost(env, platform, {
		includeNativeWindows: isProcessTerminal !== false,
		includeProcessTerminal: isProcessTerminal === true,
	});
}

/**
 * Options for overlay positioning and sizing.
 * Values can be absolute numbers or percentage strings (e.g., "50%").
 */
export interface OverlayOptions {
	// === Sizing ===
	/** Width in columns, or percentage of terminal width (e.g., "50%") */
	width?: SizeValue;
	/** Minimum width in columns */
	minWidth?: number;
	/** Maximum height in rows, or percentage of terminal height (e.g., "50%") */
	maxHeight?: SizeValue;

	// === Positioning - anchor-based ===
	/** Anchor point for positioning (default: 'center') */
	anchor?: OverlayAnchor;
	/** Horizontal offset from anchor position (positive = right) */
	offsetX?: number;
	/** Vertical offset from anchor position (positive = down) */
	offsetY?: number;

	// === Positioning - percentage or absolute ===
	/** Row position: absolute number, or percentage (e.g., "25%" = 25% from top) */
	row?: SizeValue;
	/** Column position: absolute number, or percentage (e.g., "50%" = centered horizontally) */
	col?: SizeValue;

	// === Margin from terminal edges ===
	/** Margin from terminal edges. Number applies to all sides. */
	margin?: OverlayMargin | number;

	// === Visibility ===
	/**
	 * Control overlay visibility based on terminal dimensions.
	 * If provided, overlay is only rendered when this returns true.
	 * Called each render cycle with current terminal dimensions.
	 */
	visible?: (termWidth: number, termHeight: number) => boolean;
}

/**
 * Handle returned by showOverlay for controlling the overlay
 */
export interface OverlayHandle {
	/** Permanently remove the overlay (cannot be shown again) */
	hide(): void;
	/** Temporarily hide or show the overlay */
	setHidden(hidden: boolean): void;
	/** Check if overlay is temporarily hidden */
	isHidden(): boolean;
}

/**
 * Container - a component that contains other components
 */
export class Container implements ViewportAnchorProvider {
	children: Component[] = [];
	#disposed = false;
	#viewportAnchorSources = new Map<Component, ViewportAnchorSource>();

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.#viewportAnchorSources.delete(component);
			component.dispose?.();
		}
	}

	/** Remove a child without disposing it (for detach-then-readd reuse). */
	detachChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.#viewportAnchorSources.delete(component);
		}
	}

	clear(): void {
		for (const child of this.children) child.dispose?.();
		this.children = [];
		this.#viewportAnchorSources.clear();
	}

	/** Remove all children without disposing them (for detach-then-readd reuse). */
	detachAll(): void {
		this.children = [];
		this.#viewportAnchorSources.clear();
	}

	/** Registers a direct child as eligible for semantic viewport anchoring. */
	setViewportAnchorSource(component: Component, source: ViewportAnchorSource | null): void {
		if (source !== null && !isViewportAnchorSourceRenderer(component)) {
			throw new TypeError("Viewport anchor sources require renderer-owned row metadata");
		}
		if (source === null) this.#viewportAnchorSources.delete(component);
		else this.#viewportAnchorSources.set(component, source);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const child of this.children) child.dispose?.();
		this.#viewportAnchorSources.clear();
	}

	invalidate(): void {
		for (const child of this.children) child.invalidate?.();
	}

	render(width: number): string[] {
		return this.renderWithViewportAnchors(width).lines;
	}

	renderWithViewportAnchors(width: number): ViewportAnchorRender {
		width = Math.max(1, width);
		const lines: string[] = [];
		const anchors: Array<ViewportAnchorRow | null> = [];
		for (const child of this.children) {
			const source = this.#viewportAnchorSources.get(child);
			const rendered =
				source === undefined
					? safeRenderComponentWithViewportAnchors(child, width, "container-child")
					: safeRenderComponentWithViewportAnchorSource(child, width, source, "container-anchor-child");
			for (let index = 0; index < rendered.lines.length; index++) {
				lines.push(rendered.lines[index]);
				anchors.push(rendered.anchors[index] ?? null);
			}
		}
		return { lines, anchors };
	}
}

const MAX_REPORTED_RENDER_ERRORS = 200;
const reportedRenderErrors = new Set<string>();

/**
 * Render a component's lines without letting a thrown error escape the frame.
 *
 * The TUI render loop ({@link TUI.#doRender}) runs inside a `nextTick`/`setTimeout`
 * with no try/catch, and the process installs a fail-fast `uncaughtException`
 * handler that exits. So a single component whose `render()` throws (e.g. a tool
 * renderer fed an optional/undefined field) used to take down the whole app —
 * fatal on whatever happened to trigger the frame (a keystroke, resize, or a
 * command such as `/background`). Isolate the failure: log it once, emit a
 * visible fallback line, and keep rendering the rest of the tree.
 */
function renderFailure(component: Component, where: string, err: unknown): string[] {
	const name = component?.constructor?.name ?? "Component";
	const key = `${where}:${name}:${err instanceof Error ? err.message : String(err)}`;
	if (!reportedRenderErrors.has(key)) {
		if (reportedRenderErrors.size >= MAX_REPORTED_RENDER_ERRORS) reportedRenderErrors.clear();
		reportedRenderErrors.add(key);
		logger.error("Component render failed; emitting fallback line", {
			where,
			component: name,
			error: err instanceof Error ? err.message : String(err),
			stack: err instanceof Error ? err.stack : undefined,
		});
	}
	return [`[render error: ${name}]`];
}

let viewportAnchorRenderFailureCount = 0;

function safeRenderComponent(component: Component, width: number, where: string): string[] {
	try {
		return component.render(width).map(stripTerminalEraseControls);
	} catch (err) {
		return renderFailure(component, where, err);
	}
}

function safeRenderComponentWithViewportAnchors(
	component: Component,
	width: number,
	where: string,
): ViewportAnchorRender {
	try {
		return renderComponentWithViewportAnchors(component, width);
	} catch (err) {
		viewportAnchorRenderFailureCount += 1;
		const lines = renderFailure(component, where, err);
		return { lines, anchors: lines.map(() => null) };
	}
}

function safeRenderComponentWithViewportAnchorSource(
	component: Component,
	width: number,
	source: ViewportAnchorSource,
	where: string,
): ViewportAnchorRender {
	try {
		return renderComponentWithViewportAnchorSource(component, width, source);
	} catch (err) {
		viewportAnchorRenderFailureCount += 1;
		const lines = renderFailure(component, where, err);
		return { lines, anchors: lines.map(() => null) };
	}
}

type LineNormalizationCacheEntry = {
	normalized: string;
	terminated: string;
	width: number | undefined;
};

type ViewportAnchorFrame = {
	startRow: number;
	anchors: Array<ViewportAnchorRow | null>;
};

type ManualViewportAnchor = {
	id: ViewportAnchorId;
	graphemeIndex: number;
	cellOffset: number;
	desiredScreenRow: number;
};

type TuiRenderCounterSnapshot = {
	debugRedrawEnvReads: number;
	debugRedrawAppendWrites: number;
	differentialGuardVisibleWidthCalls: number;
};
type RenderCommitWaiter = {
	resolve: (committed: boolean) => void;
	timer: NodeJS.Timeout;
};

type KittyPlacementOwner = "transcript" | "suffix" | "overlay";

type KittyPlacementSpan = KittyPlacementReference & {
	row: number;
	owner: KittyPlacementOwner;
};

type KittyPlacementRegion = {
	top: number;
	bottom: number;
};

type KittyPlacementDeletePlan = {
	deletedKeys: Set<string>;
	output: string;
};

function reflowBoundaryText(line: string): string {
	return Bun.stripANSI(line).replace(/\s+/g, "");
}

function findSafeReflowSuffixStart(previousFrameLines: string[], nextFrameLines: string[]): number {
	const previousVisibleRows = previousFrameLines.map(line => Bun.stripANSI(line).replace(/[ \t]+$/g, ""));
	const nextVisibleRows = nextFrameLines.map(line => Bun.stripANSI(line).replace(/[ \t]+$/g, ""));
	for (let index = 0; index < Math.min(previousVisibleRows.length, nextVisibleRows.length); index++) {
		if (
			reflowBoundaryText(previousFrameLines[index]) === reflowBoundaryText(nextFrameLines[index]) &&
			previousVisibleRows[index] !== nextVisibleRows[index]
		) {
			return -1;
		}
	}
	if (previousFrameLines.length === 0) return 0;

	const previousRows = previousFrameLines.map(reflowBoundaryText);
	let lastContentRow = previousRows.length - 1;
	while (lastContentRow >= 0 && previousRows[lastContentRow].length === 0) lastContentRow -= 1;
	if (lastContentRow < 0) {
		for (let index = 0; index < previousFrameLines.length; index++) {
			if (reflowBoundaryText(nextFrameLines[index] ?? "").length > 0) return 0;
		}
		return previousFrameLines.length;
	}
	const trailingEmptyRows = previousRows.length - lastContentRow - 1;
	const hasMeaningfulWhitespace = previousVisibleRows.slice(0, lastContentRow + 1).some(line => /\s/.test(line));
	const previousMeaningfulText = previousVisibleRows.slice(0, lastContentRow + 1).join("");
	const previousText = previousRows.join("");
	// Wrapping can insert physical rows between characters from the prior frame;
	// compare the non-whitespace content as an ordered subsequence.

	const completionBoundaries: number[] = [];
	let boundary = 0;
	for (const row of previousRows) {
		if (row.length === 0) continue;
		boundary += row.length;
		completionBoundaries.push(boundary);
	}

	let matchedLength = 0;
	let matchStartedAt = -1;
	const completedAt: number[] = [];
	for (let index = 0; index < nextFrameLines.length; index++) {
		const rowText = reflowBoundaryText(nextFrameLines[index]);
		const matchedBeforeRow = matchedLength;
		for (let rowOffset = 0; rowOffset < rowText.length && matchedLength < previousText.length; rowOffset++) {
			if (rowText[rowOffset] === previousText[matchedLength]) {
				if (matchedLength === 0) matchStartedAt = index;
				matchedLength += 1;
			}
		}
		while (
			completedAt.length < completionBoundaries.length &&
			matchedLength >= completionBoundaries[completedAt.length]
		) {
			completedAt.push(index);
		}
		// A row that partially matches an old row but includes extra content is an
		// in-place mutation, not a reflow continuation. Completely unmatched
		// nonempty rows before the old frame is consumed are ambiguous too.
		const matchedInRow = matchedLength - matchedBeforeRow;
		if (
			matchedLength < previousText.length &&
			((matchedInRow > 0 && matchedInRow !== rowText.length) ||
				(matchedInRow === 0 && rowText.length > 0 && matchStartedAt < 0))
		)
			return -1;
		if (matchedLength === previousText.length) {
			if (
				(hasMeaningfulWhitespace || nextVisibleRows.slice(0, index + 1).some(line => /\s/.test(line))) &&
				nextVisibleRows.slice(0, index + 1).join("") !== previousMeaningfulText
			)
				return -1;
			// A match that starts after the prior logical frame is necessarily
			// sourced from the appended suffix. It cannot prove that the old
			// frame reflowed; repaint the frame conservatively instead.
			if (matchStartedAt < 0 || matchStartedAt >= previousFrameLines.length) return -1;
			// Completing the final old row before the current row ends is ambiguous:
			// the row may have been mutated in place and wrapped below it.
			if (completedAt.length === completionBoundaries.length && rowText.length > matchedInRow) return -1;
			let trailingMatched = 0;
			while (
				trailingMatched < trailingEmptyRows &&
				index + 1 + trailingMatched < nextFrameLines.length &&
				reflowBoundaryText(nextFrameLines[index + 1 + trailingMatched]).length === 0
			) {
				trailingMatched += 1;
			}
			if (trailingMatched !== trailingEmptyRows) return -1;

			// If the final old row was completed by a continuation row, the
			// completion index already includes that reflow row. Do not advance
			// past it again: the first appended row may itself be wrapped.
			// A trailing final-row exclusion requires direct evidence that the final
			// row itself wrapped. Earlier completion gaps cannot establish that.
			return Math.min(nextFrameLines.length, index + 1 + trailingMatched);
		}
	}
	return -1;
}
function findStableLogicalAppendBoundary(previousFrameLines: string[], nextFrameLines: string[]): number {
	if (previousFrameLines.length === 0 || nextFrameLines.length <= previousFrameLines.length) return -1;
	for (let index = 0; index < previousFrameLines.length; index++) {
		if (nextFrameLines[index] !== previousFrameLines[index]) return -1;
	}
	return previousFrameLines.length;
}
function hasDistinctPostContractionRows(
	latestFrameLines: string[],
	nextFrameLines: string[],
	durableFrameLines: string[],
	nextRawLines: string[],
	durableRawLines: string[],
): boolean {
	if (nextFrameLines.length <= latestFrameLines.length || nextFrameLines.length > durableFrameLines.length)
		return false;
	for (let index = latestFrameLines.length; index < nextFrameLines.length; index += 1) {
		if (nextRawLines[index] !== durableRawLines[index]) return true;
	}
	return false;
}

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
export class TUI extends Container {
	terminal: Terminal;
	#previousLines: string[] = [];
	// Latest logical frame, including rows shown only by a transient viewport paint.
	#latestRenderedLines: string[] = [];
	#latestRenderedTranscriptLineCount = 0;
	#latestRenderedSuffixLineCount = 0;
	#latestRenderedPlacementOwners = new Map<string, KittyPlacementOwner>();
	#kittyPlacementSpans: KittyPlacementSpan[] = [];
	#latestRaw: string[] = [];
	#durableLineCount = 0;
	#durableRenderedLines: string[] = [];
	#durableRawLines: string[] = [];
	#restartDurableLineCount = 0;
	#restartDurableRenderedLines: string[] = [];
	#restartDurableRawLines: string[] = [];
	#restartDurableWidth = 0;
	#transcriptIdentityReplaced = false;
	#lineNormalizationCache = new Map<string, LineNormalizationCacheEntry>();
	#lineEmitWidthCache = new Map<string, number>();
	#lineTruncationCache = new Map<string, string>();
	#lineNormalizationCacheLimit = 0;
	#lineTruncationCacheLimit = 0;
	#previousWidth = 0;
	#previousHeight = 0;
	#focusedComponent: Component | null = null;
	#inputListeners = new Set<InputListener>();

	/** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
	onDebug?: () => void;
	#renderRequested = false;
	#nextRenderGeneration = 0;
	#renderRequestedGeneration = 0;
	#committedRenderGeneration = 0;
	#renderCommitWaiters = new Map<number, Set<RenderCommitWaiter>>();
	#lastRenderWriteSucceeded = false;
	#resizeRenderQueued = false;
	#resizeRenderMutationQueued = false;
	#renderMutationQueued = false;
	#renderTimer: NodeJS.Timeout | undefined;
	#widthSettleTimer: NodeJS.Timeout | undefined;
	#widthSettleRepairPending = false;
	#widthSettleRenderQueued = false;
	#tabWidthRepairPending = false;
	#forcedRenderQueued = false;
	#restartViewportRepaintPending = false;
	#lastObservedWidth = 0;
	// Trailing debounce for the settled width repair. Instance-local: taken from
	// options.widthSettleMs when provided (deterministic harnesses pass 0 to
	// disable), otherwise from GJC_TUI_WIDTH_SETTLE_MS / PI_TUI_WIDTH_SETTLE_MS,
	// otherwise 1000. Sampled once at construction.
	#widthSettleMs: number = TUI.#readWidthSettleMs();
	static readonly #WIDTH_SETTLE_MS = 1000;

	static #readWidthSettleMs(): number {
		const raw = Bun.env.GJC_TUI_WIDTH_SETTLE_MS ?? Bun.env.PI_TUI_WIDTH_SETTLE_MS;
		if (raw === undefined || raw === "") return TUI.#WIDTH_SETTLE_MS;
		const parsed = Number.parseInt(raw, 10);
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : TUI.#WIDTH_SETTLE_MS;
	}
	#lastRenderAt = 0;
	static readonly #MIN_RENDER_INTERVAL_MS = 16;
	// Input-priority scheduling: an input keystroke must never be starved behind a
	// pending normal (frame-budget) render timer. When set, an input-priority render
	// is queued for the next tick and supersedes any pending normal timer.
	#inputRenderPending = false;

	#cursorRow = 0; // Logical cursor row (end of rendered content)
	#hardwareCursorRow = 0; // Actual terminal cursor row (may differ due to IME positioning)
	#viewportTopRow = 0; // Content row currently mapped to screen row 0
	#scrollbackResumeViewportTop: number | undefined; // Reflowed history below this frontier is already committed
	#nativeScrollbackViewportTop = 0;
	#nativeScrollbackAdmissionPending = false;
	#transcriptIdentityResetPending = false;
	#manualViewportTop: number | undefined;
	#viewportAnchorComponent: Component | null = null;
	#viewportAnchorFrame: ViewportAnchorFrame | null = null;
	#manualViewportAnchor: ManualViewportAnchor | null = null;
	#manualViewportFallbackAnchors: ManualViewportAnchor[] = [];
	#reconcileMissingViewportAnchor = false;
	#lastCursorPosition: { row: number; col: number } | null = null;
	#latestViewportObservation: TuiViewportObservation | null = null;
	#sixelProbePendingDa = false;
	#sixelProbePendingGraphics = false;
	#sixelProbeBuffer = "";
	#sixelProbeTimeout?: NodeJS.Timeout;
	#sixelProbeUnsubscribe?: () => void;
	#showHardwareCursor = $pickflag("GJC_HARDWARE_CURSOR", "PI_HARDWARE_CURSOR");
	#debugRedraw = TUI.#readDebugRedrawFlag();
	#legacyMultiplexerFullRender = false;
	// macOS: steady-block cursor anchors CJK IME overlays; disable with GJC_TUI_IME_CURSOR=0.
	readonly #useImeBlockCursor = $flag("GJC_TUI_IME_CURSOR", process.platform === "darwin");
	// showHardwareCursor=false but cursor is shown for IME anchoring (macOS).
	#imeCursorActive = false;
	#clearOnShrink = $pickflag("GJC_CLEAR_ON_SHRINK", "PI_CLEAR_ON_SHRINK");

	// Default-on: reuse the previous normalized off-screen prefix and only normalize/diff the
	// visible window, bounding per-frame work on huge transcripts. Output stays byte-identical;
	// set PI_TUI_VIRTUAL_VIEWPORT=0 to restore legacy full-transcript normalization.
	#virtualViewport = $flag("PI_TUI_VIRTUAL_VIEWPORT", true);
	#maxLinesRendered = 0; // Line count from last render, used for viewport calculation
	#fullRedrawCount = 0;
	#stopped = false;
	#terminalUnavailable = false;
	#bottomPinnedComponent: Component | null = null;
	#pendingTerminalCleanup: Array<{ payload: string; onDelivered?: () => void }> = [];
	#mouseSelectionStart: MouseSelectionPoint | null = null;
	#mouseSelectionEnd: MouseSelectionPoint | null = null;
	#mouseSelectionDragged = false;
	#viewportOutputSource: ViewportOutputSource | null = null;
	#manualOutputNotice = false;
	#manualTranscriptLineCount = 0;
	#manualSuffixLineCount = 0;
	#committedTranscriptRows: Array<number | null> = [];
	#paintedManualOutputNotice = false;

	#unsubscribeTabWidthChange?: () => void;
	static #renderCounters: TuiRenderCounterSnapshot = {
		debugRedrawEnvReads: 0,
		debugRedrawAppendWrites: 0,
		differentialGuardVisibleWidthCalls: 0,
	};

	static resetRenderCountersForTest(): void {
		TUI.#renderCounters = {
			debugRedrawEnvReads: 0,
			debugRedrawAppendWrites: 0,
			differentialGuardVisibleWidthCalls: 0,
		};
	}

	static getRenderCountersForTest(): TuiRenderCounterSnapshot {
		return { ...TUI.#renderCounters };
	}

	static #readDebugRedrawFlag(): boolean {
		TUI.#renderCounters.debugRedrawEnvReads += 1;
		return $pickflag("GJC_DEBUG_REDRAW", "PI_DEBUG_REDRAW");
	}

	#appendDebugRedrawLog(message: string): void {
		TUI.#renderCounters.debugRedrawAppendWrites += 1;
		fs.appendFileSync(getDebugLogPath(), message);
	}

	#visibleWidthForDifferentialGuard(line: string): number {
		const cached = this.#lineEmitWidthCache.get(line);
		if (cached !== undefined) return cached;
		TUI.#renderCounters.differentialGuardVisibleWidthCalls += 1;
		return visibleWidth(line);
	}
	#recordDurableLines(lines: string[], rawLines: string[], start: number, end: number): void {
		const retainedLength = Math.max(this.#durableRenderedLines.length, this.#durableLineCount);
		if (this.#durableRenderedLines.length < retainedLength) this.#durableRenderedLines.length = retainedLength;
		if (this.#durableRawLines.length < retainedLength) this.#durableRawLines.length = retainedLength;
		for (let index = start; index <= end && index < lines.length; index += 1) {
			this.#durableRenderedLines[index] = lines[index]!;
			this.#durableRawLines[index] = rawLines[index] ?? lines[index]!;
		}
	}

	// Overlay stack for modal components rendered on top of base content
	overlayStack: {
		component: Component;
		options?: OverlayOptions;
		preFocus: Component | null;
		hidden: boolean;
		mouseBounds?: OverlayMouseBounds;
	}[] = [];

	constructor(
		terminal: Terminal,
		showHardwareCursor?: boolean,
		private readonly options: {
			enableMouse?: boolean;
			copySelection?: (text: string) => void | Promise<void>;
			/**
			 * Trailing debounce for the settled width repair, in ms. `0` disables the
			 * settled repair (deterministic harnesses need this — a wall-clock-timed
			 * full replay lands at nondeterministic logical positions). Defaults to
			 * `GJC_TUI_WIDTH_SETTLE_MS` / `PI_TUI_WIDTH_SETTLE_MS`, then 1000.
			 */
			widthSettleMs?: number;
		} = {},
	) {
		super();
		this.terminal = terminal;
		this.#legacyMultiplexerFullRender =
			isMultiplexerSession(Bun.env) && envIsEnabled(Bun.env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER);
		if (showHardwareCursor !== undefined) {
			this.#showHardwareCursor = showHardwareCursor;
		}
		if (options.widthSettleMs !== undefined && Number.isFinite(options.widthSettleMs) && options.widthSettleMs >= 0) {
			this.#widthSettleMs = options.widthSettleMs;
		}
		this.#imeCursorActive = !this.#showHardwareCursor && this.#useImeBlockCursor;
		this.#unsubscribeTabWidthChange = onDefaultTabWidthChange(() => {
			this.#lineTruncationCache.clear();
			this.#lineNormalizationCache.clear();
			this.#lineEmitWidthCache.clear();
			this.#tabWidthRepairPending = true;
			this.requestRender(true, "tab-width-change");
		});
	}

	override dispose(): void {
		this.#unsubscribeTabWidthChange?.();
		this.#unsubscribeTabWidthChange = undefined;
		super.dispose();
	}

	get fullRedraws(): number {
		return this.#fullRedrawCount;
	}

	getShowHardwareCursor(): boolean {
		return this.#showHardwareCursor;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.#showHardwareCursor === enabled) return;
		this.#showHardwareCursor = enabled;
		this.#imeCursorActive = !enabled && this.#useImeBlockCursor;
		if (!enabled) {
			this.#hideCursor();
		}
		this.requestRender();
	}
	getClearOnShrink(): boolean {
		return this.#clearOnShrink;
	}

	setClearOnShrink(enabled: boolean): void {
		this.#clearOnShrink = enabled;
	}

	setFocus(component: Component | null): void {
		// Clear focused flag on old component
		if (isFocusable(this.#focusedComponent)) {
			this.#focusedComponent.focused = false;
		}

		this.#focusedComponent = component;

		// Set focused flag on new component
		if (isFocusable(component)) {
			component.focused = true;
		}
	}
	/** Returns the currently focused component without exposing mutable focus state. */
	getFocusedComponent(): Component | null {
		return this.#focusedComponent;
	}

	/** Returns a defensive snapshot of the latest renderer-owned viewport anchors. */
	getViewportAnchorSnapshot(): { startRow: number; anchors: Array<ViewportAnchorRow | null> } | null {
		if (this.#viewportAnchorFrame === null) return null;
		return {
			startRow: this.#viewportAnchorFrame.startRow,
			anchors: this.#viewportAnchorFrame.anchors.map(anchor => (anchor ? { ...anchor } : null)),
		};
	}

	/** Returns a defensive snapshot of renderer-owned viewport geometry. */
	getViewportObservation(): TuiViewportObservation | null {
		const observation = this.#latestViewportObservation;
		return observation
			? {
					...observation,
					pinBoundary: { ...observation.pinBoundary },
					cursor: observation.cursor ? { ...observation.cursor } : null,
					selection: observation.selection
						? { start: { ...observation.selection.start }, end: { ...observation.selection.end } }
						: null,
					semanticAnchor: observation.semanticAnchor ? { ...observation.semanticAnchor } : null,
				}
			: null;
	}

	/** Selects a zero-based painted viewport cell range using the same renderer path as mouse dragging. */
	setViewportSelection(start: MouseSelectionPoint, end: MouseSelectionPoint): void {
		if (!this.options.copySelection) return;
		// Non-finite coordinates would survive the clamp below as NaN, latch
		// #mouseSelectionDragged, and force a repaint every frame while reporting a
		// NaN selection through getViewportObservation(). Reject them the same way
		// scrollViewportBy does rather than storing an unpaintable selection.
		if (![start.line, start.column, end.line, end.column].every(value => Number.isFinite(value))) return;
		const map = (point: MouseSelectionPoint): MouseSelectionPoint | null => {
			const row = Math.max(0, Math.min(this.terminal.rows - 1, point.line));
			const column = Math.max(0, Math.min(this.terminal.columns - 1, point.column));
			return this.#mouseSelectionPoint({ x: column + 1, y: row + 1, kind: "drag" });
		};
		const mappedStart = map(start);
		const mappedEnd = map(end);
		if (mappedStart === null || mappedEnd === null) {
			this.#clearMouseSelection();
			this.requestRender(false, "selection");
			return;
		}
		this.#mouseSelectionStart = mappedStart;
		this.#mouseSelectionEnd = mappedEnd;
		this.#mouseSelectionDragged = true;
		this.requestRender(false, "selection");
	}

	override removeChild(component: Component): void {
		this.#invalidateFocusForRemovedTree(component);
		super.removeChild(component);
	}

	override clear(): void {
		for (const child of this.children) this.#invalidateFocusForRemovedTree(child);
		super.clear();
	}

	#invalidateFocusForRemovedTree(component: Component): void {
		if (this.#focusedComponent !== null && this.#containsComponent(component, this.#focusedComponent)) {
			this.setFocus(null);
		}
	}

	#containsComponent(root: Component, target: Component): boolean {
		if (root === target) return true;
		return root instanceof Container && root.children.some(child => this.#containsComponent(child, target));
	}

	setBottomPinnedComponent(component: Component | null): void {
		this.#bottomPinnedComponent = component;
		this.requestRender();
	}

	/** Report the logical output producer revision without coupling TUI to message types. */
	setViewportOutputSource(source: ViewportOutputSource | null): void {
		const previous = this.#viewportOutputSource;
		if (
			(source === null && previous === null) ||
			(source !== null &&
				previous !== null &&
				source.identity === previous.identity &&
				source.revision === previous.revision)
		) {
			renderMetrics.recordStructuralCounter("viewportOutputSourceEqualNoops");
			return;
		}
		const identityReset = source === null || previous === null || previous.identity !== source.identity;
		// Same-identity revisions are a high-water mark. A delayed stale observation
		// must not lower it, because observing that revision again would otherwise
		// look like fresh output while the user owns the manual viewport.
		if (!identityReset && source.revision < previous.revision) return;
		if (!identityReset && source.revision > previous.revision && this.#manualViewportTop !== undefined) {
			this.#manualOutputNotice = true;
		}
		if (identityReset || this.#manualViewportTop === undefined) this.#manualOutputNotice = false;
		this.#viewportOutputSource = source;
		this.requestRender();
	}

	/** Register the direct child whose rows are eligible for semantic viewport anchoring. */
	setViewportAnchorComponent(component: Component | null): void {
		if (component !== null && !isViewportAnchorProvider(component)) {
			throw new TypeError("Viewport anchor components must provide renderer-owned row metadata");
		}
		if (this.#viewportAnchorComponent === component) return;
		this.#viewportAnchorComponent = component;
		this.#viewportAnchorFrame = null;
	}
	/** Returns the direct component registered as the semantic viewport anchor source. */
	getViewportAnchorComponent(): Component | null {
		return this.#viewportAnchorComponent;
	}

	/** Clear manual viewport ownership and durable history before replacing the transcript identity. */
	resetViewportAnchorIntent(): void {
		this.#manualViewportTop = undefined;
		this.#manualViewportAnchor = null;
		this.#manualViewportFallbackAnchors = [];
		this.#reconcileMissingViewportAnchor = false;
		this.#viewportAnchorFrame = null;
		this.#scrollbackResumeViewportTop = undefined;
		this.#nativeScrollbackViewportTop = 0;
		this.#nativeScrollbackAdmissionPending = false;
		this.#transcriptIdentityResetPending = true;
		this.#manualOutputNotice = false;
		this.#paintedManualOutputNotice = false;
		this.#committedTranscriptRows = [];
		// The old transcript identity is being replaced wholesale, which supersedes
		// any stale old-width artifact a deferred settle repair would have fixed.
		// Cancel both the armed timer and a pending deferred repair so an unrelated
		// later render cannot trigger an out-of-window full clear+replay.
		if (this.#widthSettleTimer) {
			clearTimeout(this.#widthSettleTimer);
			this.#widthSettleTimer = undefined;
		}
		this.#widthSettleRepairPending = false;
		// Replacing the transcript identity starts a new durable history namespace.
		this.#durableLineCount = 0;
		this.#durableRenderedLines.length = 0;
		this.#durableRawLines.length = 0;
		this.#transcriptIdentityReplaced = true;
	}

	/** Allow one semantic-neighbor reconciliation after a definitive same-transcript rebuild. */
	prepareViewportAnchorForTranscriptRebuild(): void {
		if (this.#manualViewportAnchor !== null) this.#reconcileMissingViewportAnchor = true;
	}

	/** Reveal a semantic viewport anchor without changing the rendered content width. */
	revealViewportAnchor(id: ViewportAnchorId, alignment: "top" | "center" | "bottom"): boolean {
		const height = this.terminal.rows;
		const width = this.terminal.columns;
		const frame = this.#viewportAnchorFrame;
		const transcriptCapacity = this.#manualTranscriptCapacity(height);
		if (height <= 0 || width <= 0 || transcriptCapacity === 0 || this.#previousLines.length === 0 || frame === null)
			return false;

		let selectedRow = frame.anchors.findIndex(anchor => anchor?.id === id);
		if (alignment === "bottom") {
			for (let row = frame.anchors.length - 1; row >= 0; row--) {
				if (frame.anchors[row]?.id === id) {
					selectedRow = row;
					break;
				}
			}
		}
		const selected = selectedRow < 0 ? null : frame.anchors[selectedRow];
		if (selected === null) return false;

		const desiredScreenRow =
			alignment === "top" ? 0 : alignment === "center" ? Math.floor(transcriptCapacity / 2) : transcriptCapacity - 1;
		const targetViewportTop = Math.max(0, frame.startRow + selectedRow - desiredScreenRow);
		this.#manualViewportAnchor = {
			id: selected.id,
			graphemeIndex:
				alignment === "bottom"
					? Math.max(selected.graphemeStart, selected.graphemeEnd - 1)
					: selected.graphemeStart,
			cellOffset: alignment === "bottom" ? Math.max(selected.cellStart, selected.cellEnd - 1) : selected.cellStart,
			desiredScreenRow,
		};
		const firstCandidateRow = Math.max(0, targetViewportTop - frame.startRow);
		const lastCandidateRow = Math.min(frame.anchors.length, targetViewportTop + transcriptCapacity - frame.startRow);
		const fallbacks: ManualViewportAnchor[] = [];
		for (let row = firstCandidateRow; row < lastCandidateRow; row++) {
			const anchor = frame.anchors[row];
			if (anchor === null || row === selectedRow) continue;
			fallbacks.push({
				id: anchor.id,
				graphemeIndex: anchor.graphemeStart,
				cellOffset: anchor.cellStart,
				desiredScreenRow: row + frame.startRow - targetViewportTop,
			});
		}
		fallbacks.sort(
			(a, b) =>
				Math.abs(a.desiredScreenRow - this.#manualViewportAnchor!.desiredScreenRow) -
				Math.abs(b.desiredScreenRow - this.#manualViewportAnchor!.desiredScreenRow),
		);
		this.#manualViewportFallbackAnchors = fallbacks;
		this.#manualViewportTop = this.#viewportTopRow;
		this.#reconcileMissingViewportAnchor = false;
		this.requestRender();
		return true;
	}

	scrollViewportBy(
		deltaRows: number,
		options?: {
			/** edge: PageUp/PageDown pin; stable: preserve/center pin for fine wheel motion */
			pin?: "edge" | "stable";
		},
	): boolean {
		const height = this.terminal.rows;
		const width = this.terminal.columns;
		if (height <= 0 || width <= 0 || this.#previousLines.length === 0) return false;
		if (!Number.isFinite(deltaRows)) return false;
		const delta = Math.trunc(deltaRows);
		if (delta === 0) return false;
		const previousManualViewportTop = this.#manualViewportTop;
		const previousManualViewportAnchor = this.#manualViewportAnchor;
		const previousManualViewportFallbackAnchors = this.#manualViewportFallbackAnchors;
		const previousReconcileMissingViewportAnchor = this.#reconcileMissingViewportAnchor;

		const direction: -1 | 1 = delta < 0 ? -1 : 1;
		const pin = options?.pin ?? "stable";
		const transcriptCapacity = this.#manualTranscriptCapacity(height);
		const maxViewportTop = Math.max(0, this.#manualTranscriptLineCount - transcriptCapacity);
		let currentViewportTop = Math.max(0, Math.min(maxViewportTop, this.#manualViewportTop ?? this.#viewportTopRow));
		const frame = this.#viewportAnchorFrame;
		if (this.#manualViewportAnchor !== null) {
			if (frame === null) return false;
			const resolvedViewportTop = this.#resolveManualAnchor(frame);
			if (resolvedViewportTop === null) return false;
			currentViewportTop = Math.max(0, Math.min(maxViewportTop, resolvedViewportTop));
		}
		const targetViewportTop = Math.max(0, Math.min(maxViewportTop, currentViewportTop + delta));
		// Downward input at an already-live bottom is a no-op; it must not silently
		// acquire manual ownership and freeze the next semantic output. Manual owners
		// that reach the same boundary transition through the existing live transaction.
		if (direction > 0 && targetViewportTop === maxViewportTop) {
			if (this.#manualViewportTop === undefined && currentViewportTop === maxViewportTop) return true;
			if (this.#manualViewportTop !== undefined) return this.followLiveViewport();
		}
		if (frame !== null) {
			const desiredScreenRow =
				this.#manualViewportAnchor?.desiredScreenRow ??
				(pin === "edge"
					? direction < 0
						? 0
						: Math.max(0, transcriptCapacity - 1)
					: Math.floor(transcriptCapacity / 2));
			const targetRow = targetViewportTop + desiredScreenRow - frame.startRow;
			let selected: { row: number; anchor: ViewportAnchorRow } | undefined;
			const firstCandidateRow = Math.max(0, targetViewportTop - frame.startRow);
			const lastCandidateRow = Math.min(
				frame.anchors.length,
				targetViewportTop + transcriptCapacity - frame.startRow,
			);
			for (let row = firstCandidateRow; row < lastCandidateRow; row++) {
				const anchor = frame.anchors[row];
				if (anchor === null) continue;
				if (
					selected === undefined ||
					Math.abs(row - targetRow) < Math.abs(selected.row - targetRow) ||
					(Math.abs(row - targetRow) === Math.abs(selected.row - targetRow) &&
						(direction < 0 ? row < selected.row : row > selected.row))
				)
					selected = { row, anchor };
			}
			if (selected === undefined) {
				// A page can consist entirely of non-semantic rows such as tool output,
				// transient panels, or pinned chrome. Fall back to numeric viewport
				// ownership so PageUp/PageDown can continue through those rows instead
				// of becoming an intermittent no-op. A later page with an eligible row
				// will establish a fresh semantic anchor.
				this.#manualViewportAnchor = null;
				this.#manualViewportFallbackAnchors = [];
				this.#reconcileMissingViewportAnchor = false;
			} else {
				this.#manualViewportAnchor = {
					id: selected.anchor.id,
					graphemeIndex:
						direction < 0
							? selected.anchor.graphemeStart
							: Math.max(selected.anchor.graphemeStart, selected.anchor.graphemeEnd - 1),
					cellOffset:
						direction < 0
							? selected.anchor.cellStart
							: Math.max(selected.anchor.cellStart, selected.anchor.cellEnd - 1),
					desiredScreenRow: selected.row + frame.startRow - targetViewportTop,
				};
				const fallbacks: ManualViewportAnchor[] = [];
				for (let row = firstCandidateRow; row < lastCandidateRow; row++) {
					const anchor = frame.anchors[row];
					if (anchor === null || row === selected.row) continue;
					fallbacks.push({
						id: anchor.id,
						graphemeIndex:
							direction < 0 ? anchor.graphemeStart : Math.max(anchor.graphemeStart, anchor.graphemeEnd - 1),
						cellOffset: direction < 0 ? anchor.cellStart : Math.max(anchor.cellStart, anchor.cellEnd - 1),
						desiredScreenRow: row + frame.startRow - targetViewportTop,
					});
				}
				fallbacks.sort(
					(a, b) =>
						Math.abs(a.desiredScreenRow - this.#manualViewportAnchor!.desiredScreenRow) -
						Math.abs(b.desiredScreenRow - this.#manualViewportAnchor!.desiredScreenRow),
				);
				this.#manualViewportFallbackAnchors = fallbacks;
			}
		}
		this.#manualViewportTop = targetViewportTop;
		let contentPainted = false;
		const painted = this.#repaintViewportFromLines(
			this.#previousLines,
			width,
			height,
			targetViewportTop,
			null,
			"manual viewport scroll",
			this.#manualViewportAnchor !== null,
			() => {
				contentPainted = true;
				this.#manualTranscriptLineCount = this.#latestRenderedTranscriptLineCount;
				this.#manualSuffixLineCount = this.#latestRenderedSuffixLineCount;
			},
			false,
			this.#kittyPlacementSpans,
			this.#kittyPlacementSpansForLines(this.#previousLines, this.#latestRenderedPlacementOwners),
			{
				transcriptLineCount: this.#latestRenderedTranscriptLineCount,
				suffixLineCount: this.#latestRenderedSuffixLineCount,
			},
			true,
		);
		if (!contentPainted) {
			this.#manualViewportTop = previousManualViewportTop;
			this.#manualViewportAnchor = previousManualViewportAnchor;
			this.#manualViewportFallbackAnchors = previousManualViewportFallbackAnchors;
			this.#reconcileMissingViewportAnchor = previousReconcileMissingViewportAnchor;
		}
		return painted;
	}

	scrollViewportPages(direction: -1 | 1): boolean {
		const height = this.terminal.rows;
		return this.scrollViewportBy(direction * Math.max(1, this.#manualTranscriptCapacity(height) - 1), {
			pin: "edge",
		});
	}

	followLiveViewport(): boolean {
		if (this.#manualViewportTop === undefined) return false;
		const height = this.terminal.rows;
		const width = this.terminal.columns;
		const paddedLiveLines = this.#padBeforeBottomPinnedComponent(
			this.#latestRenderedLines,
			height,
			this.#latestRenderedSuffixLineCount,
		);
		const liveLines = paddedLiveLines.lines;
		const liveTranscriptLineCount = this.#latestRenderedTranscriptLineCount;
		const liveSuffixLineCount = this.#latestRenderedSuffixLineCount + paddedLiveLines.insertedBlankRows;
		const liveKittyPlacementSpans = this.#kittyPlacementSpansForLines(liveLines, this.#latestRenderedPlacementOwners);
		let liveCursorPosition = this.#lastCursorPosition;
		if (liveCursorPosition !== null && liveCursorPosition.row >= paddedLiveLines.insertionRow) {
			liveCursorPosition = {
				...liveCursorPosition,
				row: liveCursorPosition.row + paddedLiveLines.insertedBlankRows,
			};
		}
		const liveViewportTop = Math.max(0, liveLines.length - height);
		return this.#repaintViewportFromLines(
			liveLines,
			width,
			height,
			liveViewportTop,
			liveCursorPosition,
			"manual viewport follow live",
			false,
			() => {
				this.#manualViewportTop = undefined;
				this.#manualViewportAnchor = null;
				this.#manualViewportFallbackAnchors = [];
				this.#reconcileMissingViewportAnchor = false;
				this.#manualOutputNotice = false;
				this.#committedTranscriptRows = [];
				this.#paintedManualOutputNotice = false;
				this.#lastCursorPosition = liveCursorPosition;
				this.#previousLines = liveLines;
				this.#manualTranscriptLineCount = liveTranscriptLineCount;
				this.#manualSuffixLineCount = liveSuffixLineCount;
				this.#latestRenderedLines = liveLines.slice();
				if (this.#scrollbackResumeViewportTop === undefined) {
					this.#nativeScrollbackViewportTop = liveViewportTop;
				}
				this.#nativeScrollbackAdmissionPending = liveLines.length > this.#durableLineCount;
				// Repairs deferred while the user was reading scrollback run only
				// after the transactional live repaint has committed.
				if (this.#widthSettleRepairPending || this.#tabWidthRepairPending) {
					this.requestRender(
						true,
						this.#tabWidthRepairPending ? "tab-width-change.deferred" : "resize.width-settled.deferred",
					);
				}
			},
			true,
			this.#kittyPlacementSpans,
			liveKittyPlacementSpans,
			{ transcriptLineCount: liveTranscriptLineCount, suffixLineCount: liveSuffixLineCount },
		);
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		const entry = { component, options, preFocus: this.#focusedComponent, hidden: false, mouseBounds: undefined };

		this.overlayStack.push(entry);
		// Only focus if overlay is actually visible
		if (this.#isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.#hideCursor();
		this.requestRender();

		// Return handle for controlling this overlay
		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					entry.mouseBounds = undefined;

					this.overlayStack.splice(index, 1);
					// Restore focus if this overlay had focus
					if (this.#focusedComponent === component) {
						const topVisible = this.#getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) this.#hideCursor();
					this.requestRender();
				}
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				entry.mouseBounds = undefined;

				// Update focus when hiding/showing
				if (hidden) {
					// If this overlay had focus, move focus to next visible or preFocus
					if (this.#focusedComponent === component) {
						const topVisible = this.#getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					// Restore focus to this overlay when showing (if it's actually visible)
					if (this.#isOverlayVisible(entry)) {
						this.setFocus(component);
					}
				}
				this.requestRender();
			},
			isHidden: () => entry.hidden,
		};
	}

	/** Hide the topmost overlay and restore previous focus. */
	hideOverlay(): void {
		const overlay = this.overlayStack.pop();
		if (!overlay) return;
		overlay.mouseBounds = undefined;
		// Find topmost visible overlay, or fall back to preFocus
		const topVisible = this.#getTopmostVisibleOverlay();
		this.setFocus(topVisible?.component ?? overlay.preFocus);
		if (this.overlayStack.length === 0) this.#hideCursor();
		this.requestRender();
	}

	/** Check if there are any visible overlays */
	hasOverlay(): boolean {
		return this.overlayStack.some(o => this.#isOverlayVisible(o));
	}

	/** Check if an overlay entry is currently visible */
	#isOverlayVisible(entry: (typeof this.overlayStack)[number]): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		return true;
	}

	/** Find the topmost visible overlay, if any */
	#getTopmostVisibleOverlay(): (typeof this.overlayStack)[number] | undefined {
		for (let i = this.overlayStack.length - 1; i >= 0; i--) {
			if (this.#isOverlayVisible(this.overlayStack[i])) {
				return this.overlayStack[i];
			}
		}
		return undefined;
	}

	override invalidate(): void {
		super.invalidate();
		for (const overlay of this.overlayStack) overlay.component.invalidate?.();
		for (const overlay of this.overlayStack) overlay.mouseBounds = undefined;
	}

	start(): void {
		this.#stopped = false;
		this.#terminalUnavailable = false;
		// Seed the observed width so a spurious post-start resize event (iTerm2 tab
		// activation, the self-sent SIGWINCH after resume) is not read as a reflow.
		this.#lastObservedWidth = this.terminal.columns;
		this.terminal.setMouseEnabled?.(this.options.enableMouse === true);
		this.terminal.start(
			data => this.#handleInput(data),
			() => {
				this.invalidate();
				this.requestResizeRender();
			},
		);
		this.flushTerminalCleanup();
		this.#hideCursor();
		this.#querySixelSupport();
		this.#queryCellSize();
		this.requestRender(true);
	}

	/**
	 * Wait for a specific render request generation to be written successfully.
	 *
	 * Render requests are coalesced, so committing a newer generation also commits
	 * every older generation represented by that frame. A stopped or unavailable
	 * terminal resolves waiters false so UI callers can fail open instead of
	 * holding a session operation behind a dead renderer.
	 */
	waitForRenderCommit(generation: number, timeoutMs = 250): Promise<boolean> {
		if (generation <= 0 || generation <= this.#committedRenderGeneration) return Promise.resolve(true);
		if (this.#stopped || !this.terminalAvailable) return Promise.resolve(false);
		return new Promise<boolean>(resolve => {
			const waiter: RenderCommitWaiter = {
				resolve,
				timer: setTimeout(
					() => {
						const waiters = this.#renderCommitWaiters.get(generation);
						if (waiters) {
							waiters.delete(waiter);
							if (waiters.size === 0) this.#renderCommitWaiters.delete(generation);
						}
						resolve(false);
					},
					Math.max(0, timeoutMs),
				),
			};
			waiter.timer.unref?.();
			const waiters = this.#renderCommitWaiters.get(generation) ?? new Set();
			waiters.add(waiter);
			this.#renderCommitWaiters.set(generation, waiters);
		});
	}

	#settleRenderCommitWaiters(committed: boolean, generation = Number.POSITIVE_INFINITY): void {
		if (committed) this.#committedRenderGeneration = Math.max(this.#committedRenderGeneration, generation);
		for (const [waiterGeneration, waiters] of this.#renderCommitWaiters) {
			if (committed && waiterGeneration > generation) continue;
			this.#renderCommitWaiters.delete(waiterGeneration);
			for (const waiter of waiters) {
				clearTimeout(waiter.timer);
				waiter.resolve(committed);
			}
		}
	}

	#commitRenderGeneration(generation: number): void {
		if (generation <= 0) return;
		if (this.#lastRenderWriteSucceeded) this.#settleRenderCommitWaiters(true, generation);
		else if (this.#stopped || !this.terminalAvailable) this.#settleRenderCommitWaiters(false, generation);
	}

	get terminalAvailable(): boolean {
		return !this.#terminalUnavailable && this.terminal.available;
	}

	#markTerminalUnavailable(settleRenderWaiters = true): void {
		this.#terminalUnavailable = true;
		this.#stopped = true;
		this.#renderRequested = false;
		if (settleRenderWaiters) this.#settleRenderCommitWaiters(false);
		if (this.#renderTimer) {
			clearTimeout(this.#renderTimer);
			this.#renderTimer = undefined;
			if (renderMetrics.enabled) renderMetrics.setTimerGauge("tui.renderTimer", 0);
		}
		this.#clearSixelProbeState();
	}

	#writeTerminal(data: string, deferRenderFailure = false): boolean {
		return this.#guardTerminalOperation(() => this.terminal.write(data), !deferRenderFailure);
	}

	#hideCursor(): boolean {
		return this.#guardTerminalOperation(() => this.terminal.hideCursor());
	}

	#showCursor(): boolean {
		return this.#guardTerminalOperation(() => this.terminal.showCursor());
	}

	#guardTerminalOperation(operation: () => void, settleRenderWaiters = true): boolean {
		if (!this.terminalAvailable) {
			this.#markTerminalUnavailable(settleRenderWaiters);
			return false;
		}
		try {
			operation();
		} catch {
			this.#markTerminalUnavailable(settleRenderWaiters);
			return false;
		}
		if (!this.terminal.available) {
			this.#markTerminalUnavailable(settleRenderWaiters);
			return false;
		}
		return true;
	}

	addInputListener(listener: InputListener): () => void {
		this.#inputListeners.add(listener);
		return () => {
			this.#inputListeners.delete(listener);
		};
	}

	removeInputListener(listener: InputListener): void {
		this.#inputListeners.delete(listener);
	}

	#querySixelSupport(): void {
		if (TERMINAL.imageProtocol) return;
		if (!this.#isSixelProbeCandidate()) return;
		if (!process.stdin.isTTY || !process.stdout.isTTY) return;

		this.#clearSixelProbeState();
		this.#sixelProbePendingDa = true;
		this.#sixelProbePendingGraphics = true;
		this.#sixelProbeUnsubscribe = this.addInputListener(data => this.#handleSixelProbeInput(data));
		if (!this.#writeTerminal("\x1b[c")) return;
		if (!this.#writeTerminal("\x1b[?2;1;0S")) return;
		this.#sixelProbeTimeout = setTimeout(() => {
			this.#finishSixelProbe(false);
		}, 250);
	}

	#isSixelProbeCandidate(): boolean {
		return shouldProbeSixelCapability();
	}

	#handleSixelProbeInput(data: string): InputListenerResult {
		if (!this.#sixelProbePendingDa && !this.#sixelProbePendingGraphics) {
			return undefined;
		}

		this.#sixelProbeBuffer += data;
		let passthrough = "";
		let probeOutcome: boolean | null = null;

		while (this.#sixelProbeBuffer.length > 0) {
			const daMatch = this.#sixelProbeBuffer.match(/\x1b\[\?([0-9;]+)c/u);
			const graphicsMatch = this.#sixelProbeBuffer.match(/\x1b\[\?2;(\d+);([0-9;]+)S/u);

			if (!daMatch && !graphicsMatch) break;

			const daIndex = daMatch?.index ?? Number.POSITIVE_INFINITY;
			const graphicsIndex = graphicsMatch?.index ?? Number.POSITIVE_INFINITY;
			const useDa = daIndex <= graphicsIndex;
			const match = useDa ? daMatch : graphicsMatch;
			if (!match || match.index === undefined) break;

			passthrough += this.#sixelProbeBuffer.slice(0, match.index);
			this.#sixelProbeBuffer = this.#sixelProbeBuffer.slice(match.index + match[0].length);

			if (useDa && this.#sixelProbePendingDa) {
				this.#sixelProbePendingDa = false;
				const params = (match[1] ?? "")
					.split(";")
					.map(value => Number.parseInt(value, 10))
					.filter(value => Number.isFinite(value));
				// The first DA1 parameter is the device/operating class (e.g. 1,
				// 62, 64), not an extension attribute: `CSI ?4;6c` identifies a
				// VT132, it does not advertise sixel. Only the parameters after
				// the class carry attributes like 4 (sixel graphics).
				const hasSixelAttribute = params.slice(1).includes(4);
				if (hasSixelAttribute) {
					this.#sixelProbePendingGraphics = false;
					probeOutcome = true;
				} else if (!this.#sixelProbePendingGraphics) {
					probeOutcome = false;
				}
			} else if (!useDa && this.#sixelProbePendingGraphics) {
				this.#sixelProbePendingGraphics = false;
				// XTSMGRAPHICS reply is `CSI ? 2 ; Ps ; ... S` where Ps=0 means
				// success and 1/2/3 are errors (tmux answers our unsupported
				// read with `CSI ?2;3;0S`). Only a success reply proves sixel.
				const status = Number.parseInt(match[1] ?? "", 10);
				const supportsSixel = status === 0;
				if (supportsSixel) {
					this.#sixelProbePendingDa = false;
					probeOutcome = true;
				} else if (!this.#sixelProbePendingDa) {
					probeOutcome = false;
				}
			}
		}

		if (this.#sixelProbePendingDa || this.#sixelProbePendingGraphics) {
			const partialStart = this.#getSixelProbePartialStart(this.#sixelProbeBuffer);
			if (partialStart >= 0) {
				passthrough += this.#sixelProbeBuffer.slice(0, partialStart);
				this.#sixelProbeBuffer = this.#sixelProbeBuffer.slice(partialStart);
			} else {
				passthrough += this.#sixelProbeBuffer;
				this.#sixelProbeBuffer = "";
			}
		} else {
			passthrough += this.#sixelProbeBuffer;
			this.#sixelProbeBuffer = "";
		}

		if (probeOutcome !== null) {
			this.#finishSixelProbe(probeOutcome);
		}

		if (passthrough.length === 0) {
			return { consume: true };
		}

		return { data: passthrough };
	}

	#getSixelProbePartialStart(buffer: string): number {
		const lastEsc = buffer.lastIndexOf("\x1b");
		if (lastEsc < 0) return -1;
		const tail = buffer.slice(lastEsc);
		if (/^\x1b\[\?[0-9;]*$/u.test(tail)) {
			return lastEsc;
		}
		return -1;
	}

	#clearSixelProbeState(): void {
		if (this.#sixelProbeTimeout) {
			clearTimeout(this.#sixelProbeTimeout);
			this.#sixelProbeTimeout = undefined;
		}
		if (this.#sixelProbeUnsubscribe) {
			this.#sixelProbeUnsubscribe();
			this.#sixelProbeUnsubscribe = undefined;
		}
		this.#sixelProbePendingDa = false;
		this.#sixelProbePendingGraphics = false;
		this.#sixelProbeBuffer = "";
	}

	#finishSixelProbe(supported: boolean): void {
		this.#clearSixelProbeState();
		if (!supported || TERMINAL.imageProtocol) return;

		setTerminalImageProtocol(ImageProtocol.Sixel);
		this.#queryCellSize();
		this.invalidate();
		this.requestRender(true);
	}
	#queryCellSize(): void {
		// Only query if terminal supports images (cell size is only used for image rendering)
		if (!TERMINAL.imageProtocol) {
			return;
		}
		// Query terminal for cell size in pixels: CSI 16 t
		// Response format: CSI 6 ; height ; width t
		this.#writeTerminal("\x1b[16t");
	}

	stop(): void {
		this.flushTerminalCleanup();
		const placementCleanup = this.#kittyPlacementDeletePlan(this.#kittyPlacementSpans, [], [], true).output;
		if (placementCleanup.length > 0 && this.#writeTerminal(placementCleanup)) this.#kittyPlacementSpans = [];
		this.#clearSixelProbeState();
		this.#stopped = true;
		this.#settleRenderCommitWaiters(false);
		if (this.#renderTimer) {
			clearTimeout(this.#renderTimer);
			this.#renderTimer = undefined;
			if (renderMetrics.enabled) renderMetrics.setTimerGauge("tui.renderTimer", 0);
		}
		if (this.#widthSettleTimer) {
			clearTimeout(this.#widthSettleTimer);
			this.#widthSettleTimer = undefined;
		}
		// An armed TIMER dies with the session, but a repair already deferred while
		// the user was reading scrollback must survive a temporary stop/start
		// (Ctrl-Z resume, external editor): manual viewport ownership survives
		// restart, so followLiveViewport() still needs the pending repair. Without
		// manual ownership the flags are moot — start() issues a forced full render.
		if (this.#manualViewportTop === undefined) {
			this.#widthSettleRepairPending = false;
			this.#tabWidthRepairPending = false;
		}
		// Move the cursor after the frame actually displayed to prevent
		// overwriting/artifacts on exit. The latest logical frame can differ while
		// a semantic viewport retains the previously painted frame.
		const displayedFrameLines = this.#previousLines.length || this.#latestRenderedLines.length;
		if (displayedFrameLines > 0) {
			const targetRow = displayedFrameLines; // Line after the last content
			const lineDiff = targetRow - this.#hardwareCursorRow;
			if (lineDiff > 0) {
				this.#writeTerminal(`\x1b[${lineDiff}B`);
			} else if (lineDiff < 0) {
				this.#writeTerminal(`\x1b[${-lineDiff}A`);
			}
			this.#writeTerminal("\r\n");
		}

		if (this.#useImeBlockCursor) {
			this.#writeTerminal("\x1b[0 q");
		}
		this.#showCursor();
		try {
			this.terminal.stop();
		} catch {
			this.#markTerminalUnavailable();
		}
		// Teardown normally releases the retained rendered transcript. A temporary
		// non-manual restart keeps only the durable baseline until its first render:
		// that render can admit a raw-prefix-proven append without replaying history.
		this.#restartViewportRepaintPending =
			this.#manualViewportTop === undefined && (this.#previousLines.length > 0 || this.#maxLinesRendered > 0);
		if (this.#restartViewportRepaintPending) {
			this.#restartDurableLineCount = this.#durableLineCount;
			this.#restartDurableRenderedLines = this.#durableRenderedLines.slice();
			this.#restartDurableRawLines = this.#durableRawLines.slice();
			this.#restartDurableWidth = this.#previousWidth;
		} else {
			this.#restartDurableLineCount = 0;
			this.#restartDurableRenderedLines = [];
			this.#restartDurableRawLines = [];
			this.#restartDurableWidth = 0;
		}
		this.#latestRenderedLines = [];
		this.#kittyPlacementSpans = [];
		this.#latestRaw = [];
		this.#durableLineCount = 0;
		this.#nativeScrollbackAdmissionPending = false;
		this.#durableRenderedLines.length = 0;
		this.#durableRawLines.length = 0;
		this.#previousLines = [];
		this.#transcriptIdentityReplaced = false;
		this.#lineNormalizationCache.clear();
		this.#lineTruncationCache.clear();
		this.#lineEmitWidthCache.clear();
		this.#previousWidth = 0;
		this.#previousHeight = 0;
		this.#resizeRenderQueued = false;
		this.#resizeRenderMutationQueued = false;
		this.#renderMutationQueued = false;
		this.#widthSettleRenderQueued = false;
		this.#forcedRenderQueued = false;
	}

	/** Host gate for viewport-repaint decisions, resolved against this terminal. */
	#viewportRepaintHost(): boolean {
		return shouldUseViewportRepaintForTerminal(this.terminal.isProcessTerminal);
	}

	/**
	 * Viewport-repaint-aware resize render request.
	 *
	 * A forced repaint resets `#previousWidth`/`#previousHeight` to -1, which makes
	 * `#doRender` treat the frame as a dimension change. Repaints stay anchored to
	 * the live viewport so native scrollback is never replayed or erased.
	 *
	 * Spurious resize events (SIGWINCH with unchanged dimensions — iTerm2 tab
	 * switches and window focus changes, the self-sent SIGWINCH after resume)
	 * must not force either: only force when the grid size actually changed since
	 * the last committed frame.
	 */
	requestResizeRender(): void {
		// Width is tracked against the last OBSERVED terminal width, not against
		// #previousWidth (the last committed frame). Those diverge whenever resize
		// events coalesce inside one frame budget: a 100->90->100 burst would leave
		// #previousWidth at 100 the whole time, so a commit-keyed debounce would
		// never see the second transition and could skip the only repair frame.
		const observedWidth = this.terminal.columns;
		const widthChanged = observedWidth !== this.#lastObservedWidth;
		this.#lastObservedWidth = observedWidth;
		const heightChanged = this.#previousHeight !== this.terminal.rows;
		if (widthChanged) this.#scheduleWidthSettleRedraw();
		this.requestRender(heightChanged && !this.#viewportRepaintHost(), "resize");
	}

	/**
	 * Width reflow leaves artifacts that the immediate resize frame does not always
	 * repair: lines wrapped at the old column count can survive as stale bands — in
	 * the live viewport and in scrollback history. The immediate frame is unchanged
	 * by this timer — `#doRender` still promotes a real width change to
	 * `fullRender`/`viewportRepaint` on the spot. What this adds is a single
	 * trailing repair #WIDTH_SETTLE_MS after the last observed width change.
	 *
	 * The settled repair is a FULL transcript replay on every host, including
	 * viewport-repaint hosts (tmux/screen/zellij, Windows Terminal, process
	 * terminals) where per-SIGWINCH forced redraws are normally suppressed. That
	 * per-event replay is the storm `resize-replay-storm.test.ts` pins against;
	 * the debounce is what makes the full replay safe here — it happens once per
	 * settled width sequence, so scrollback artifacts are repaired without
	 * replaying the transcript on every resize event.
	 *
	 * Every observed width sequence gets exactly one repair, including one that
	 * ends back at its starting width. Skipping the drag-and-return case would
	 * require proving that a frame committed at the final geometry *after* the
	 * final resize event, which the render pipeline does not guarantee; one extra
	 * repaint is cheaper than a missed repair.
	 *
	 * Height-only changes are unaffected: they reflow nothing and keep their
	 * existing behavior.
	 */
	#scheduleWidthSettleRedraw(): void {
		if (this.#widthSettleMs <= 0) return;
		if (this.#widthSettleTimer) clearTimeout(this.#widthSettleTimer);
		this.#widthSettleTimer = setTimeout(() => {
			this.#widthSettleTimer = undefined;
			if (this.#stopped) return;
			this.#widthSettleRepairPending = true;
			// While the user is reading scrollback (manual viewport), a forced
			// clear+replay would rip them out of history mid-read. Keep the flag
			// armed instead; followLiveViewport() runs the deferred repair the
			// moment they return to live.
			if (this.#manualViewportTop !== undefined) return;
			this.requestRender(true, "resize.width-settled");
		}, this.#widthSettleMs);
		this.#widthSettleTimer.unref?.();
	}

	requestRender(force = false, source = "unknown"): void {
		this.requestRenderWithGeneration(force, source);
	}

	requestRenderWithGeneration(force = false, source = "unknown"): number {
		const generation = ++this.#nextRenderGeneration;
		this.#renderRequestedGeneration = Math.max(this.#renderRequestedGeneration, generation);
		this.#requestRenderCore(force, source, generation);
		return generation;
	}

	#requestRenderCore(force: boolean, source: string, generation: number): void {
		if (!this.terminalAvailable) {
			this.#markTerminalUnavailable();
			return;
		}
		if (renderMetrics.enabled) renderMetrics.recordRequest(source);
		const widthSettleRequest = source.startsWith("resize.width-settled");
		const mutationRequest = source !== "resize" && !widthSettleRequest;
		if (source === "resize") {
			this.#resizeRenderQueued = true;
			if (this.#renderRequested && this.#renderMutationQueued) {
				// A resize request coalesced into an already pending mutation means
				// the component changed before that frame settled. Preserve this
				// bit regardless of which request arrived first.
				this.#resizeRenderMutationQueued = true;
			}
		} else if (mutationRequest) {
			if (this.#resizeRenderQueued && this.#renderRequested) {
				// A mutation request coalesced into the pending resize frame means
				// the component changed before that frame settled. Keep this bit
				// separate from the terminal resize itself so a resize-only repaint
				// remains transient.
				this.#resizeRenderMutationQueued = true;
			}
			this.#renderMutationQueued = true;
		}
		if (widthSettleRequest) this.#widthSettleRenderQueued = true;
		if (force) {
			// A forced full redraw supersedes any queued input-priority render.
			this.#inputRenderPending = false;
			if (!widthSettleRequest) this.#forcedRenderQueued = true;
			if (!widthSettleRequest) {
				this.#previousWidth = -1; // -1 triggers widthChanged
				this.#previousHeight = -1; // -1 triggers heightChanged
			}
			this.#lineNormalizationCacheLimit = 0;
			this.#lineTruncationCacheLimit = 0;
			if (this.#latestRenderedLines.length === 0) {
				this.#cursorRow = 0;
				this.#hardwareCursorRow = 0;
				this.#viewportTopRow = 0;
				this.#maxLinesRendered = 0;
			}
			if (this.#renderTimer) {
				clearTimeout(this.#renderTimer);
				this.#renderTimer = undefined;
				if (renderMetrics.enabled) renderMetrics.setTimerGauge("tui.renderTimer", 0);
			}
			this.#renderRequested = true;
			process.nextTick(() => {
				if (this.#stopped || !this.#renderRequested) {
					this.#settleRenderCommitWaiters(false, generation);
					return;
				}
				const requestedGeneration = this.#renderRequestedGeneration;
				this.#renderRequestedGeneration = 0;
				this.#renderRequested = false;
				this.#lastRenderAt = performance.now();
				this.#lastRenderWriteSucceeded = false;
				const t0 = renderMetrics.now();
				this.#doRender();
				this.#commitRenderGeneration(requestedGeneration);
				if (renderMetrics.enabled) renderMetrics.recordRender(renderMetrics.now() - t0);
			});
			return;
		}
		// Input-priority path: expedite so the keystroke echoes within the next tick
		// instead of waiting for (or behind) the frame-budget timer. Re-entrant input
		// requests in the same turn coalesce via #inputRenderPending, so at most one
		// expedited render commits per event-loop turn (no repaint storms). This only
		// changes WHEN #doRender runs; the render output path is unchanged.
		if (source === "input" || source === "editor.input") {
			if (!this.#inputRenderPending) {
				this.#inputRenderPending = true;
				this.#renderRequested = true;
				process.nextTick(() => this.#commitExpeditedRender());
			}
			return;
		}
		if (this.#renderRequested) return;
		this.#renderRequested = true;
		process.nextTick(() => this.#scheduleRender());
		return;
	}

	#scheduleRender(): void {
		if (this.#stopped || this.#renderTimer || !this.#renderRequested) {
			return;
		}
		const elapsed = performance.now() - this.#lastRenderAt;
		const delay = Math.max(0, TUI.#MIN_RENDER_INTERVAL_MS - elapsed);
		this.#renderTimer = setTimeout(() => {
			this.#renderTimer = undefined;
			if (renderMetrics.enabled) renderMetrics.setTimerGauge("tui.renderTimer", 0);
			if (this.#stopped || !this.#renderRequested) {
				return;
			}
			const requestedGeneration = this.#renderRequestedGeneration;
			this.#renderRequestedGeneration = 0;
			this.#renderRequested = false;
			this.#lastRenderAt = performance.now();
			this.#lastRenderWriteSucceeded = false;
			const t0 = renderMetrics.now();
			this.#doRender();
			this.#commitRenderGeneration(requestedGeneration);
			if (renderMetrics.enabled) renderMetrics.recordRender(renderMetrics.now() - t0);
			if (this.#renderRequested) {
				this.#scheduleRender();
			}
		}, delay);
		if (renderMetrics.enabled) renderMetrics.setTimerGauge("tui.renderTimer", 1);
	}

	// Commit a single input-priority render on the next tick, cancelling any normal
	// frame-budget timer scheduled in the same turn. nextTick always precedes a
	// pending setTimeout, so the keystroke is never starved behind streaming renders.
	#commitExpeditedRender(): void {
		if (!this.#inputRenderPending) return; // cancelled (e.g., by a forced render)
		this.#inputRenderPending = false;
		if (this.#stopped || !this.#renderRequested) {
			return;
		}
		if (this.#renderTimer) {
			clearTimeout(this.#renderTimer);
			this.#renderTimer = undefined;
			if (renderMetrics.enabled) renderMetrics.setTimerGauge("tui.renderTimer", 0);
		}
		const requestedGeneration = this.#renderRequestedGeneration;
		this.#renderRequestedGeneration = 0;
		this.#renderRequested = false;
		this.#lastRenderAt = performance.now();
		this.#lastRenderWriteSucceeded = false;
		const t0 = renderMetrics.now();
		this.#doRender();
		this.#commitRenderGeneration(requestedGeneration);
		if (renderMetrics.enabled) renderMetrics.recordRender(renderMetrics.now() - t0);
	}

	#handleInput(data: string): void {
		if (this.#inputListeners.size > 0) {
			let current = data;
			for (const listener of this.#inputListeners) {
				const result = listener(current);
				if (result?.consume) {
					return;
				}
				if (result?.data !== undefined) {
					current = result.data;
				}
			}
			if (current.length === 0) {
				return;
			}
			data = current;
		}

		const mouse = parseSgrMouseEvent(data);
		if (mouse) {
			// Coordinates outside the current terminal cannot name a visible cell.
			if (mouse.x > this.terminal.columns || mouse.y > this.terminal.rows) return;
			if (mouse.kind === "wheel") {
				this.#clearMouseSelection();
				this.scrollViewportBy(mouse.direction! * DEFAULT_WHEEL_LINES, { pin: "stable" });
			} else if (mouse.kind === "click") {
				this.#beginMouseSelection(mouse);
				const focusedOverlay = this.overlayStack.find(o => o.component === this.#focusedComponent);
				if (focusedOverlay) {
					if (!this.#isOverlayVisible(focusedOverlay)) {
						focusedOverlay.mouseBounds = undefined;
						return;
					}
					const bounds = focusedOverlay.mouseBounds;
					if (bounds?.termWidth !== this.terminal.columns || bounds.termHeight !== this.terminal.rows) {
						return;
					}

					if (
						!bounds ||
						mouse.x < bounds.col + 1 ||
						mouse.x > bounds.col + bounds.width ||
						mouse.y < bounds.row + 1 ||
						mouse.y > bounds.row + bounds.height
					)
						return;
					this.#focusedComponent?.handleMouse?.({
						...mouse,
						localX: mouse.x - bounds.col,
						localY: mouse.y - bounds.row,
					});
				} else this.#focusedComponent?.handleMouse?.(mouse);
			} else if (mouse.kind === "drag") {
				this.#updateMouseSelection(mouse);
			} else {
				this.#finishMouseSelection(mouse);
			}
			this.requestRender(false, "mouse");
			return;
		}
		// SGR-looking reports, including malformed reports, are terminal controls.
		if (data.startsWith("\x1b[<")) return;

		// Consume terminal cell size responses without blocking unrelated input.
		if (this.#consumeCellSizeResponse(data)) {
			return;
		}

		// DA1 and XTSMGRAPHICS replies belong to the sixel probe, whose listener runs
		// above. Reaching this point means the probe already finished, timed out, or
		// was cleared by a stop()/start() cycle while the terminal still owed the
		// reply. These are terminal-to-host reports, never user input, so drop them
		// instead of typing them into the focused component.
		if (DEVICE_REPORT_PATTERN.test(data)) {
			return;
		}
		// Global debug key handler (registry: tui.global.debug, default Shift+Ctrl+D)
		if (getKeybindings().matches(data, "tui.global.debug") && this.onDebug) {
			this.onDebug();
			return;
		}

		// If focused component is an overlay, verify it's still visible
		// (visibility can change due to terminal resize or visible() callback)
		const focusedOverlay = this.overlayStack.find(o => o.component === this.#focusedComponent);
		if (focusedOverlay && !this.#isOverlayVisible(focusedOverlay)) {
			// Focused overlay is no longer visible, redirect to topmost visible overlay
			const topVisible = this.#getTopmostVisibleOverlay();
			if (topVisible) {
				this.setFocus(topVisible.component);
			} else {
				// No visible overlays, restore to preFocus
				this.setFocus(focusedOverlay.preFocus);
			}
		}

		// Pass input to focused component (including Ctrl+C)
		// The focused component can decide how to handle Ctrl+C
		if (this.#focusedComponent?.handleInput) {
			// Filter out key release events unless component opts in
			if (isKeyRelease(data) && !this.#focusedComponent.wantsKeyRelease) {
				return;
			}
			this.#focusedComponent.handleInput(data);
			this.requestRender(false, "input");
		}
	}

	#mouseSelectionPoint(mouse: MouseEvent): MouseSelectionPoint | null {
		if (this.#manualViewportTop === undefined) {
			return { line: this.#viewportTopRow + mouse.y - 1, column: mouse.x - 1 };
		}
		const line = this.#committedTranscriptRows[mouse.y - 1];
		return line === null || line === undefined || line < 0 || line >= this.#manualTranscriptLineCount
			? null
			: { line, column: mouse.x - 1 };
	}

	#beginMouseSelection(mouse: MouseEvent): void {
		if (!this.options.copySelection) return;
		const point = this.#mouseSelectionPoint(mouse);
		if (point === null) {
			this.#clearMouseSelection();
			return;
		}
		this.#mouseSelectionStart = point;
		this.#mouseSelectionEnd = point;
		this.#mouseSelectionDragged = false;
	}

	#updateMouseSelection(mouse: MouseEvent): void {
		if (this.#mouseSelectionStart === null) return;
		const point = this.#mouseSelectionPoint(mouse);
		if (point === null) return;
		this.#mouseSelectionEnd = point;
		this.#mouseSelectionDragged = true;
	}

	#finishMouseSelection(mouse: MouseEvent): void {
		if (this.#mouseSelectionStart === null) return;
		const point = this.#mouseSelectionPoint(mouse);
		if (point !== null) this.#mouseSelectionEnd = point;
		if (!this.#mouseSelectionDragged || !this.options.copySelection) {
			this.#clearMouseSelection();
			return;
		}
		const text = this.#extractMouseSelection();
		if (!text) {
			this.#clearMouseSelection();
			return;
		}
		try {
			const result = this.options.copySelection(text);
			if (result) void result.catch(() => {});
		} catch {
			// Clipboard failures are reported by the host callback and must not break terminal input.
		}
	}

	#clearMouseSelection(): void {
		this.#mouseSelectionStart = null;
		this.#mouseSelectionEnd = null;
		this.#mouseSelectionDragged = false;
	}

	#orderedMouseSelection(): { start: MouseSelectionPoint; end: MouseSelectionPoint } | null {
		const start = this.#mouseSelectionStart;
		const end = this.#mouseSelectionEnd;
		if (start === null || end === null) return null;
		if (start.line < end.line || (start.line === end.line && start.column <= end.column)) return { start, end };
		return { start: end, end: start };
	}

	#mouseSelectionColumns(line: number, text: string): { start: number; end: number } | null {
		const selection = this.#orderedMouseSelection();
		if (selection === null || line < selection.start.line || line > selection.end.line) return null;
		const lineWidth = visibleWidth(text);
		let start = line === selection.start.line ? selection.start.column : 0;
		let end = line === selection.end.line ? selection.end.column + 1 : lineWidth;
		start = Math.max(0, Math.min(lineWidth, start));
		end = Math.max(0, Math.min(lineWidth, end));

		let column = 0;
		for (const part of MOUSE_SELECTION_SEGMENTER.segment(text)) {
			const next = column + Math.max(1, visibleWidth(part.segment));
			if (column < start && start < next) start = column;
			if (column < end && end < next) end = next;
			column = next;
		}
		return { start, end };
	}

	#extractMouseSelection(): string {
		const selection = this.#orderedMouseSelection();
		if (selection === null) return "";
		const selected: string[] = [];
		const selectionLines = this.#manualViewportTop === undefined ? this.#latestRenderedLines : this.#previousLines;
		for (let lineIndex = selection.start.line; lineIndex <= selection.end.line; lineIndex++) {
			const line = selectionLines[lineIndex];
			if (line === undefined || TERMINAL.isImageLine(line)) {
				selected.push("");
				continue;
			}
			const plain = stripTerminalControls(line);
			const columns = this.#mouseSelectionColumns(lineIndex, plain);
			if (columns === null || columns.end <= columns.start) {
				selected.push("");
				continue;
			}
			selected.push(sliceByColumn(plain, columns.start, columns.end - columns.start, false));
		}
		return selected.join("\n");
	}

	#applyMouseSelection(lines: string[]): string[] {
		if (!this.#mouseSelectionDragged) return lines;
		const selection = this.#orderedMouseSelection();
		if (selection === null) return lines;
		const highlighted = lines;
		for (let lineIndex = selection.start.line; lineIndex <= selection.end.line; lineIndex++) {
			const line = highlighted[lineIndex];
			if (line === undefined || TERMINAL.isImageLine(line)) continue;
			const plain = stripTerminalControls(line);
			const width = visibleWidth(plain);
			const columns = this.#mouseSelectionColumns(lineIndex, plain);
			if (columns === null || columns.end <= columns.start) continue;
			const before = sliceByColumn(line, 0, columns.start, false);
			const selected = sliceByColumn(line, columns.start, columns.end - columns.start, false).replace(
				/\x1b\[[0-9;]*m/gu,
				control => `${control}\x1b[7m`,
			);
			const after = sliceByColumn(line, columns.end, Math.max(0, width - columns.end), false);
			highlighted[lineIndex] = `${before}\x1b[7m${selected}\x1b[27m${after}`;
		}
		return highlighted;
	}

	#consumeCellSizeResponse(data: string): boolean {
		// Response format: ESC [ 6 ; height ; width t
		const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
		if (!match) {
			return false;
		}

		const heightPx = parseInt(match[1], 10);
		const widthPx = parseInt(match[2], 10);
		if (heightPx <= 0 || widthPx <= 0) {
			return true;
		}

		setCellDimensions({ widthPx, heightPx });
		// Invalidate all components so images re-render with correct dimensions.
		this.invalidate();
		this.requestRender();
		return true;
	}

	/**
	 * Resolve overlay layout from options.
	 * Returns { width, row, col, maxHeight } for rendering.
	 */
	#resolveOverlayLayout(
		options: OverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	): { width: number; row: number; col: number; maxHeight: number | undefined } {
		const opt = options ?? {};

		// Parse margin (clamp to non-negative)
		const margin =
			typeof opt.margin === "number"
				? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
				: (opt.margin ?? {});
		const marginTop = Math.max(0, margin.top ?? 0);
		const marginRight = Math.max(0, margin.right ?? 0);
		const marginBottom = Math.max(0, margin.bottom ?? 0);
		const marginLeft = Math.max(0, margin.left ?? 0);

		// Available space after margins
		const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
		const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

		// === Resolve width ===
		let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
		// Apply minWidth
		if (opt.minWidth !== undefined) {
			width = Math.max(width, opt.minWidth);
		}
		// Clamp to available space
		width = Math.max(1, Math.min(width, availWidth));

		// === Resolve maxHeight ===
		let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
		// Clamp to available space
		if (maxHeight !== undefined) {
			maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
		}

		// Effective overlay height (may be clamped by maxHeight)
		const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

		// === Resolve position ===
		let row: number;
		let col: number;

		if (opt.row !== undefined) {
			if (typeof opt.row === "string") {
				// Percentage: 0% = top, 100% = bottom (overlay stays within bounds)
				const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxRow = Math.max(0, availHeight - effectiveHeight);
					const percent = parseFloat(match[1]) / 100;
					row = marginTop + Math.floor(maxRow * percent);
				} else {
					// Invalid format, fall back to center
					row = this.#resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
				}
			} else {
				// Absolute row position
				row = opt.row;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			row = this.#resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
		}

		if (opt.col !== undefined) {
			if (typeof opt.col === "string") {
				// Percentage: 0% = left, 100% = right (overlay stays within bounds)
				const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxCol = Math.max(0, availWidth - width);
					const percent = parseFloat(match[1]) / 100;
					col = marginLeft + Math.floor(maxCol * percent);
				} else {
					// Invalid format, fall back to center
					col = this.#resolveAnchorCol("center", width, availWidth, marginLeft);
				}
			} else {
				// Absolute column position
				col = opt.col;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			col = this.#resolveAnchorCol(anchor, width, availWidth, marginLeft);
		}

		// Apply offsets
		if (opt.offsetY !== undefined) row += opt.offsetY;
		if (opt.offsetX !== undefined) col += opt.offsetX;

		// Clamp to terminal bounds (respecting margins)
		row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
		col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

		return { width, row, col, maxHeight };
	}

	#resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
		switch (anchor) {
			case "top-left":
			case "top-center":
			case "top-right":
				return marginTop;
			case "bottom-left":
			case "bottom-center":
			case "bottom-right":
				return marginTop + availHeight - height;
			case "left-center":
			case "center":
			case "right-center":
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	#resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
		switch (anchor) {
			case "top-left":
			case "left-center":
			case "bottom-left":
				return marginLeft;
			case "top-right":
			case "right-center":
			case "bottom-right":
				return marginLeft + availWidth - width;
			case "top-center":
			case "center":
			case "bottom-center":
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}

	/** Composite all overlays into content lines (in stack order, later = on top). */
	#compositeOverlays(
		lines: string[],
		termWidth: number,
		termHeight: number,
		placementOwners?: Map<string, KittyPlacementOwner>,
	): string[] {
		if (this.overlayStack.length === 0) return lines;
		const result = [...lines];
		for (const entry of this.overlayStack) entry.mouseBounds = undefined;

		// Pre-render all visible overlays and calculate positions
		const rendered: { overlayLines: string[]; row: number; col: number; w: number }[] = [];
		let minLinesNeeded = result.length;

		for (const entry of this.overlayStack) {
			// Skip invisible overlays (hidden or visible() returns false)
			if (!this.#isOverlayVisible(entry)) continue;

			const { component, options } = entry;

			// Get layout with height=0 first to determine width and maxHeight
			// (width and maxHeight don't depend on overlay height)
			const { width, maxHeight } = this.#resolveOverlayLayout(options, 0, termWidth, termHeight);

			// Render component at calculated width
			let overlayLines = safeRenderComponent(component, width, "overlay");

			// Apply maxHeight if specified
			if (maxHeight !== undefined && overlayLines.length > maxHeight) {
				overlayLines = overlayLines.slice(0, maxHeight);
			}

			// Get final row/col with actual overlay height
			const { row, col } = this.#resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);

			rendered.push({ overlayLines, row, col, w: width });
			entry.mouseBounds = { row, col, width, height: overlayLines.length, termWidth, termHeight };
			minLinesNeeded = Math.max(minLinesNeeded, row + overlayLines.length);
		}

		// Ensure result is tall enough for overlay placement.
		// NOTE: Do not pad to maxLinesRendered.
		// maxLinesRendered tracks the terminal "working area" (max lines ever rendered) and can be much larger
		// than the current content. Padding to it can cause the renderer to output hundreds/thousands of blank
		// lines, effectively scrolling the terminal when an overlay is shown.
		const workingHeight = Math.max(result.length, minLinesNeeded);

		// Extend result with empty lines if content is too short for overlay placement
		while (result.length < workingHeight) {
			result.push("");
		}

		const viewportStart = Math.max(0, workingHeight - termHeight);

		// Track which lines were modified for final verification
		const modifiedLines = new Set<number>();

		// Composite each overlay
		for (const { overlayLines, row, col, w } of rendered) {
			for (let i = 0; i < overlayLines.length; i++) {
				const idx = viewportStart + row + i;
				if (idx >= 0 && idx < result.length) {
					// Defensive: truncate overlay line to declared width before compositing
					// (components should already respect width, but this ensures it)
					const truncatedOverlayLine =
						visibleWidth(overlayLines[i]) > w ? sliceByColumn(overlayLines[i], 0, w, true) : overlayLines[i];
					if (placementOwners !== undefined) {
						for (const placement of extractKittyPlacementReferences(truncatedOverlayLine)) {
							placementOwners.set(this.#kittyPlacementKey(placement), "overlay");
						}
					}
					result[idx] = this.#compositeLineAt(result[idx], truncatedOverlayLine, col, w, termWidth);
					modifiedLines.add(idx);
				}
			}
		}

		// Final verification: ensure no composited line exceeds terminal width
		// This is a belt-and-suspenders safeguard - compositeLineAt should already
		// guarantee this, but we verify here to prevent crashes from any edge cases
		// Only check lines that were actually modified (optimization)
		for (const idx of modifiedLines) {
			const lineWidth = visibleWidth(result[idx]);
			if (lineWidth > termWidth) {
				result[idx] = sliceByColumn(result[idx], 0, termWidth, true);
			}
		}

		return result;
	}

	/** Splice overlay content into a base line at a specific column. Single-pass optimized. */
	#compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string {
		if (TERMINAL.isImageLine(baseLine)) return baseLine;

		// Single pass through baseLine extracts both before and after segments
		const afterStart = startCol + overlayWidth;
		const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);

		// Extract overlay with width tracking (strict=true to exclude wide chars at boundary)
		const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);

		// Pad segments to target widths
		const beforePad = Math.max(0, startCol - base.beforeWidth);
		const overlayPad = Math.max(0, overlayWidth - overlay.width);
		const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
		const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
		const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
		const afterPad = Math.max(0, afterTarget - base.afterWidth);

		// Compose result
		const r = SEGMENT_RESET;
		const result =
			base.before +
			" ".repeat(beforePad) +
			r +
			overlay.text +
			" ".repeat(overlayPad) +
			r +
			base.after +
			" ".repeat(afterPad);

		// CRITICAL: Always verify and truncate to terminal width.
		// This is the final safeguard against width overflow which would crash the TUI.
		// Width tracking can drift from actual visible width due to:
		// - Complex ANSI/OSC sequences (hyperlinks, colors)
		// - Wide characters at segment boundaries
		// - Edge cases in segment extraction
		const resultWidth = visibleWidth(result);
		if (resultWidth <= totalWidth) {
			return result;
		}
		// Truncate with strict=true to ensure we don't exceed totalWidth
		return sliceByColumn(result, 0, totalWidth, true);
	}

	/**
	 * Find and extract cursor position from rendered lines.
	 * Searches for CURSOR_MARKER, calculates its position, and strips it from the output.
	 * Only scans the bottom terminal height lines (visible viewport).
	 * @param lines - Rendered lines to search
	 * @param height - Terminal height (visible viewport size)
	 * @returns Cursor position { row, col } or null if no marker found
	 */
	#extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
		// Only scan the bottom `height` lines (visible viewport)
		const viewportTop = Math.max(0, lines.length - height);
		for (let row = lines.length - 1; row >= viewportTop; row--) {
			const line = lines[row];
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1) {
				// Calculate visual column (width of text before marker)
				const beforeMarker = line.slice(0, markerIndex);
				const col = Math.max(0, Math.min(Math.max(0, this.terminal.columns - 1), visibleWidth(beforeMarker)));

				// Strip marker from the line
				lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);

				return { row, col };
			}
		}
		return null;
	}

	/**
	 * Append the per-line terminator ({@link LINE_TERMINATOR}) to every
	 * non-image line and normalize for terminal rendering. Mutates the input
	 * array in place so downstream diffing/storage sees exactly the bytes
	 * written to the terminal — without this, the diff cache disagrees with
	 * emitted output and OSC 8 hyperlink state can leak across lines.
	 */
	#normalizeLineForRender(line: string): LineNormalizationCacheEntry {
		const cached = this.#lineNormalizationCache.get(line);
		if (cached !== undefined) return cached;
		const normalized = normalizeTerminalOutput(line);
		const terminated = normalized + (normalized.includes("\x1b]8;") ? LINE_TERMINATOR : SEGMENT_RESET);
		const entry = { normalized, terminated, width: undefined };
		this.#lineNormalizationCache.set(line, entry);
		return entry;
	}

	#trimLineCachesForRender(lineCount: number): void {
		const limit = Math.max(1, lineCount * 2);
		this.#lineNormalizationCacheLimit = limit;
		this.#lineTruncationCacheLimit = limit;
		while (this.#lineNormalizationCache.size > limit) {
			const key = this.#lineNormalizationCache.keys().next().value;
			if (key === undefined) break;
			const entry = this.#lineNormalizationCache.get(key);
			if (entry !== undefined) this.#lineEmitWidthCache.delete(entry.terminated);
			this.#lineNormalizationCache.delete(key);
		}
		while (this.#lineTruncationCache.size > limit) {
			const key = this.#lineTruncationCache.keys().next().value;
			if (key === undefined) break;
			this.#lineTruncationCache.delete(key);
		}
		while (this.#lineEmitWidthCache.size > limit * 2) {
			const key = this.#lineEmitWidthCache.keys().next().value;
			if (key === undefined) break;
			this.#lineEmitWidthCache.delete(key);
		}
	}

	getLineRenderCacheStats(): {
		normalizationSize: number;
		truncationSize: number;
		normalizationLimit: number;
		truncationLimit: number;
	} {
		return {
			normalizationSize: this.#lineNormalizationCache.size,
			truncationSize: this.#lineTruncationCache.size,
			normalizationLimit: this.#lineNormalizationCacheLimit,
			truncationLimit: this.#lineTruncationCacheLimit,
		};
	}

	#normalizeLinesForEmit(lines: string[], width: number, start = 0): string[] {
		const widthCheckIndexes: number[] = [];
		const widthCheckLines: string[] = [];
		for (let i = start; i < lines.length; i++) {
			const line = lines[i];
			if (TERMINAL.isImageLine(line)) continue;
			const entry = this.#normalizeLineForRender(line);
			const { normalized, terminated } = entry;
			if (isPrintableAscii(normalized) && normalized.length <= width) {
				entry.width = normalized.length;
				this.#lineEmitWidthCache.set(terminated, normalized.length);
				lines[i] = terminated;
				continue;
			}
			widthCheckIndexes.push(i);
			widthCheckLines.push(normalized);
		}

		const widths = widthCheckLines.length === 0 ? [] : visibleWidths(widthCheckLines);
		const truncateIndexes: number[] = [];
		const truncateLines: string[] = [];
		for (let i = 0; i < widthCheckIndexes.length; i++) {
			const lineIndex = widthCheckIndexes[i];
			const normalized = widthCheckLines[i];
			const measuredWidth = widths[i] ?? 0;
			if (measuredWidth <= width) {
				const entry = this.#normalizeLineForRender(lines[lineIndex]);
				entry.width = measuredWidth;
				this.#lineEmitWidthCache.set(entry.terminated, measuredWidth);
				lines[lineIndex] = entry.terminated;
				continue;
			}

			const key = `${width}\0${normalized}`;
			const cached = this.#lineTruncationCache.get(key);
			if (cached !== undefined) {
				this.#lineEmitWidthCache.set(cached, visibleWidth(cached));
				lines[lineIndex] = cached;
				continue;
			}
			truncateIndexes.push(lineIndex);
			truncateLines.push(normalized);
		}

		const truncated = truncateLines.length === 0 ? [] : truncateLinesToWidth(truncateLines, width, Ellipsis.Omit);
		for (let i = 0; i < truncateIndexes.length; i++) {
			const lineIndex = truncateIndexes[i];
			const normalized = truncateLines[i];
			const truncatedLine = truncated[i] ?? "";
			const terminated = truncatedLine + (truncatedLine.includes("\x1b]8;") ? LINE_TERMINATOR : SEGMENT_RESET);
			this.#lineTruncationCache.set(`${width}\0${normalized}`, terminated);
			this.#lineEmitWidthCache.set(terminated, visibleWidth(truncatedLine));
			lines[lineIndex] = terminated;
		}

		return lines;
	}

	#applyLineResetsAndTruncate(lines: string[], width: number): string[] {
		this.#normalizeLinesForEmit(lines, width);
		this.#trimLineCachesForRender(lines.length);
		return lines;
	}

	#padLineToWidth(line: string, width: number): string {
		if (TERMINAL.isImageLine(line)) return line;
		const lineWidth = this.#visibleWidthForDifferentialGuard(line);
		return lineWidth >= width ? line : line + " ".repeat(width - lineWidth);
	}

	#kittyPlacementKey(reference: KittyPlacementReference): string {
		return `${reference.imageId}:${reference.placementId}`;
	}

	#kittyPlacementSpansForLines(
		lines: string[],
		owners: ReadonlyMap<string, KittyPlacementOwner>,
	): KittyPlacementSpan[] {
		const placements: KittyPlacementSpan[] = [];
		for (let row = 0; row < lines.length; row++) {
			for (const placement of extractKittyPlacementReferences(lines[row])) {
				placements.push({
					...placement,
					row,
					owner: owners.get(this.#kittyPlacementKey(placement)) ?? "transcript",
				});
			}
		}
		return placements;
	}

	#kittyPlacementIntersectsRegion(placement: KittyPlacementSpan, region: KittyPlacementRegion): boolean {
		return placement.row < region.bottom && placement.row + placement.rows > region.top;
	}

	#kittyPlacementDeletePlan(
		previous: KittyPlacementSpan[],
		next: KittyPlacementSpan[],
		overwrittenRegions: KittyPlacementRegion[],
		deleteAll = false,
		overwrittenOwners: KittyPlacementOwner[] = [],
	): KittyPlacementDeletePlan {
		const deletedKeys = new Set<string>();
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty) return { deletedKeys, output: "" };
		const nextByKey = new Map(next.map(placement => [this.#kittyPlacementKey(placement), placement]));
		let output = "";
		for (const placement of previous) {
			const key = this.#kittyPlacementKey(placement);
			if (deletedKeys.has(key)) continue;
			const candidate = nextByKey.get(key);
			const changed =
				candidate === undefined || candidate.row !== placement.row || candidate.rows !== placement.rows;
			const overwritten =
				deleteAll ||
				overwrittenOwners.includes(placement.owner) ||
				overwrittenRegions.some(region => this.#kittyPlacementIntersectsRegion(placement, region));
			if (!changed && !overwritten) continue;
			deletedKeys.add(key);
			output += encodeKittyPlacementDelete(placement);
		}
		return { deletedKeys, output };
	}

	#kittyCommittedPlacementsAfterPaint(
		previous: KittyPlacementSpan[],
		next: KittyPlacementSpan[],
		deletePlan: KittyPlacementDeletePlan,
		emittedRegions: KittyPlacementRegion[],
	): KittyPlacementSpan[] {
		const committed = new Map<string, KittyPlacementSpan>();
		for (const placement of previous) {
			const key = this.#kittyPlacementKey(placement);
			if (!deletePlan.deletedKeys.has(key)) committed.set(key, placement);
		}
		for (const placement of next) {
			if (!emittedRegions.some(region => placement.row >= region.top && placement.row < region.bottom)) continue;
			committed.set(this.#kittyPlacementKey(placement), placement);
		}
		return [...committed.values()];
	}

	#kittyViewportTopIncludingPlacementAnchors(viewportTop: number, placements: KittyPlacementSpan[]): number {
		let resolvedTop = viewportTop;
		let changed: boolean;
		do {
			const priorTop = resolvedTop;
			for (const placement of placements) {
				if (placement.row < resolvedTop && placement.row + placement.rows > resolvedTop) {
					resolvedTop = placement.row;
				}
			}
			changed = resolvedTop !== priorTop;
		} while (changed);
		return resolvedTop;
	}

	#pinnedChildLines(component: Component, renderedChildren: Map<Component, string[]>): string[] {
		const lines = renderedChildren.get(component);
		if (lines === undefined) throw new Error("Missing rendered direct child for pinned suffix");
		return lines;
	}

	#constrainedPinnedChildLines(lines: string[], remaining: number): string[] {
		let cursorLine = -1;
		for (let index = 0; index < lines.length; index++) {
			if (lines[index].includes(CURSOR_MARKER)) {
				cursorLine = index;
				break;
			}
		}
		if (cursorLine < 0) return lines.slice(-remaining);
		const start = Math.max(0, Math.min(cursorLine, lines.length - remaining));
		return lines.slice(start, start + remaining);
	}

	#componentContains(root: Component, target: Component | null): boolean {
		if (target === null) return false;
		if (root === target) return true;
		return root instanceof Container && root.children.some(child => this.#componentContains(child, target));
	}

	#constrainPinnedSuffix(lines: string[], height: number, renderedChildren: Map<Component, string[]>): string[] {
		const component = this.#bottomPinnedComponent;
		if (component === null || height <= 0) return lines;
		const pinnedStart = this.children.indexOf(component);
		if (pinnedStart < 0) return lines;

		let suffixRowCount = 0;
		for (let index = pinnedStart; index < this.children.length; index++) {
			suffixRowCount += this.#pinnedChildLines(this.children[index], renderedChildren).length;
		}
		if (suffixRowCount <= height) return lines;

		renderMetrics.recordStructuralCounter("pinnedSuffixOverflowFrames");
		let focusedChild: Component | null = null;
		for (let index = pinnedStart; index < this.children.length; index++) {
			const child = this.children[index];
			if (this.#componentContains(child, this.#focusedComponent)) {
				focusedChild = child;
				break;
			}
		}
		const selectedRowCounts = new Map<Component, number>();
		let remaining = height;
		const allocate = (child: Component, maximumRows?: number): void => {
			if (remaining === 0) return;
			const rows = this.#pinnedChildLines(child, renderedChildren);
			const alreadySelected = selectedRowCounts.get(child) ?? 0;
			const count = Math.min(rows.length - alreadySelected, maximumRows ?? rows.length, remaining);
			if (count === 0) return;
			selectedRowCounts.set(child, alreadySelected + count);
			remaining -= count;
		};

		// Reserve the focused cursor row before the status boundary, then let later
		// decorative children compete in reverse order. A deferred allocation lets the
		// focused child retain adjacent rows only after those priorities are satisfied.
		if (focusedChild !== null) allocate(focusedChild, 1);
		if (component !== focusedChild) allocate(component);
		for (let index = this.children.length - 1; index >= pinnedStart; index--) {
			const child = this.children[index];
			if (child !== focusedChild && child !== component) allocate(child);
		}
		if (focusedChild !== null) allocate(focusedChild);

		const transcriptEnd = lines.length - suffixRowCount;
		lines.length = transcriptEnd;
		let selectedRows = 0;
		for (let index = pinnedStart; index < this.children.length; index++) {
			const child = this.children[index];
			const count = selectedRowCounts.get(child);
			if (count === undefined) continue;
			const constrained = this.#constrainedPinnedChildLines(this.#pinnedChildLines(child, renderedChildren), count);
			selectedRows += constrained.length;
			for (const row of constrained) lines.push(row);
		}
		renderMetrics.recordStructuralCounter("pinnedSuffixSelectedRows", selectedRows);
		return lines;
	}

	#padBeforeBottomPinnedComponent(
		lines: string[],
		height: number,
		pinnedLineCount: number,
	): { lines: string[]; insertionRow: number; insertedBlankRows: number } {
		if (pinnedLineCount <= 0 || lines.length >= height) {
			return { lines, insertionRow: lines.length, insertedBlankRows: 0 };
		}

		const insertedBlankRows = height - lines.length;
		const insertionRow = Math.max(0, lines.length - pinnedLineCount);
		const padded = [...lines];
		padded.splice(insertionRow, 0, ...Array.from({ length: insertedBlankRows }, () => ""));
		return { lines: padded, insertionRow, insertedBlankRows };
	}
	#manualTranscriptCapacity(height: number, suffixLineCount = this.#manualSuffixLineCount): number {
		const noticeRows = this.#manualOutputNotice && height > suffixLineCount ? 1 : 0;
		return Math.max(0, height - suffixLineCount - noticeRows);
	}
	#resolveManualAnchor(frame: ViewportAnchorFrame): number | null {
		const anchor = this.#manualViewportAnchor;
		if (anchor === null) return null;
		const row = frame.anchors.findIndex(
			candidate =>
				candidate !== null &&
				candidate.id === anchor.id &&
				candidate.graphemeStart <= anchor.graphemeIndex &&
				anchor.graphemeIndex < candidate.graphemeEnd &&
				candidate.cellStart <= anchor.cellOffset &&
				anchor.cellOffset < candidate.cellEnd,
		);
		return row < 0 ? null : Math.max(0, frame.startRow + row - anchor.desiredScreenRow);
	}

	#resolvePreparedManualAnchor(frame: ViewportAnchorFrame): number | null {
		const previous = this.#manualViewportAnchor;
		for (const fallback of this.#manualViewportFallbackAnchors) {
			this.#manualViewportAnchor = fallback;
			const resolved = this.#resolveManualAnchor(frame);
			if (resolved !== null) return resolved;
		}
		const targetRow = Math.max(
			0,
			Math.min(
				frame.anchors.length - 1,
				(this.#manualViewportTop ?? 0) + (previous?.desiredScreenRow ?? 0) - frame.startRow,
			),
		);
		let selectedRow = -1;
		for (let distance = 0; distance < frame.anchors.length; distance++) {
			for (const row of [targetRow - distance, targetRow + distance]) {
				if (row < 0 || row >= frame.anchors.length || frame.anchors[row] === null) continue;
				selectedRow = row;
				break;
			}
			if (selectedRow >= 0) break;
		}
		const selected = selectedRow >= 0 ? frame.anchors[selectedRow] : null;
		if (selected === null) return null;
		this.#manualViewportAnchor = {
			id: selected.id,
			graphemeIndex: selected.graphemeStart,
			cellOffset: selected.cellStart,
			desiredScreenRow: previous?.desiredScreenRow ?? 0,
		};
		return this.#resolveManualAnchor(frame);
	}

	#repaintViewportFromLines(
		lines: string[],
		width: number,
		height: number,
		viewportTop: number,
		cursorPos: { row: number; col: number } | null,
		reason: string,
		allowPastLiveBottom = false,
		onPainted?: () => void,
		paintLive = false,
		placementsToClear: KittyPlacementSpan[] = this.#kittyPlacementSpans,
		placementsToPaint: KittyPlacementSpan[] = placementsToClear,
		geometry?: { transcriptLineCount: number; suffixLineCount: number },
		avoidScrollback = true,
	): boolean {
		const paintManual = this.#manualViewportTop !== undefined && !paintLive;
		const transcriptLineCount = geometry?.transcriptLineCount ?? this.#manualTranscriptLineCount;
		const suffixLineCount = geometry?.suffixLineCount ?? this.#manualSuffixLineCount;
		if (height <= 0 || width <= 0) return false;
		const maxViewportTop = Math.max(
			0,
			!paintManual
				? lines.length - (allowPastLiveBottom ? 1 : height)
				: allowPastLiveBottom
					? lines.length - 1
					: transcriptLineCount - this.#manualTranscriptCapacity(height, suffixLineCount),
		);
		let nextViewportTop = Math.max(0, Math.min(maxViewportTop, viewportTop));
		if (paintManual)
			nextViewportTop = this.#kittyViewportTopIncludingPlacementAnchors(nextViewportTop, placementsToPaint);
		const transcriptCapacity = paintManual ? this.#manualTranscriptCapacity(height, suffixLineCount) : height;
		const noticeRows = paintManual && this.#manualOutputNotice && height > suffixLineCount ? 1 : 0;
		const deletePlan = this.#kittyPlacementDeletePlan(
			placementsToClear,
			placementsToPaint,
			[{ top: this.#viewportTopRow, bottom: this.#viewportTopRow + height }],
			false,
			paintManual ? ["suffix", "overlay"] : [],
		);
		const emittedRegions: KittyPlacementRegion[] = paintManual
			? [
					{ top: nextViewportTop, bottom: nextViewportTop + transcriptCapacity },
					{ top: transcriptLineCount, bottom: transcriptLineCount + suffixLineCount },
				]
			: [{ top: nextViewportTop, bottom: nextViewportTop + height }];
		let buffer = `\x1b[?2026h${deletePlan.output}`;
		buffer += "\x1b[H";
		const committedTranscriptRows: Array<number | null> = [];
		for (let screenRow = 0; screenRow < height; screenRow++) {
			if (screenRow > 0) buffer += avoidScrollback ? "\r\x1b[1B" : "\r\n";
			const lineIndex = nextViewportTop + screenRow;
			const suffixRow = screenRow - transcriptCapacity - noticeRows;
			const line =
				paintManual && screenRow === transcriptCapacity && noticeRows > 0
					? "New output — type to follow"
					: paintManual && suffixRow >= 0
						? (lines[transcriptLineCount + suffixRow] ?? "")
						: paintManual && lineIndex >= transcriptLineCount
							? ""
							: (lines[lineIndex] ?? "");
			committedTranscriptRows.push(
				screenRow < transcriptCapacity && lineIndex < transcriptLineCount ? lineIndex : null,
			);
			const isImage = TERMINAL.isImageLine(line);
			if (avoidScrollback && isImage) buffer += "\x1b7\x1b[2K";
			if (!isImage && this.#visibleWidthForDifferentialGuard(line) > width) {
				let truncatedLine = truncateToWidth(line, width, Ellipsis.Omit);
				truncatedLine += truncatedLine.includes("\x1b]8;") ? LINE_TERMINATOR : SEGMENT_RESET;
				buffer += this.#padLineToWidth(truncatedLine, width);
			} else {
				buffer += this.#padLineToWidth(line, width);
			}
			if (avoidScrollback && isImage) buffer += "\x1b8";
		}
		if (avoidScrollback) buffer += "\r";

		const finalPhysicalRow = nextViewportTop + Math.max(0, height - 1);
		let cursorSeq = "\x1b[?25l";
		let cursorToRow = finalPhysicalRow;
		if (cursorPos && cursorPos.row >= nextViewportTop && cursorPos.row < nextViewportTop + height) {
			const cursor = this.#cursorControlSequence(cursorPos, lines.length, finalPhysicalRow);
			cursorSeq = cursor.seq;
			cursorToRow = cursor.toRow;
		}
		buffer += cursorSeq;
		buffer += "\x1b[?2026l";
		let contentWritten = false;
		const writeSucceeded = this.#writeRenderBufferAndReanchorImeCursor(buffer, cursorPos, lines.length, () => {
			contentWritten = true;
			this.#hardwareCursorRow = cursorToRow;
			this.#committedTranscriptRows = committedTranscriptRows;
			this.#cursorRow = Math.max(0, lines.length - 1);
			this.#maxLinesRendered = lines.length;
			this.#viewportTopRow = nextViewportTop;
			if (paintManual) this.#manualViewportTop = nextViewportTop;
			this.#kittyPlacementSpans = this.#kittyCommittedPlacementsAfterPaint(
				placementsToClear,
				placementsToPaint,
				deletePlan,
				emittedRegions,
			);
			onPainted?.();
			this.#paintedManualOutputNotice = paintManual && this.#manualOutputNotice;
			this.#recordPaintedViewportObservation(nextViewportTop, height, paintManual);
		});
		if (!contentWritten) return false;

		if (this.#debugRedraw) {
			const msg = `[${new Date().toISOString()}] viewportRepaint: ${reason} (lines=${lines.length}, height=${height}, viewportTop=${nextViewportTop})\n`;
			this.#appendDebugRedrawLog(msg);
		}
		return writeSucceeded;
	}
	#recordPaintedViewportObservation(viewportTop: number, height: number, paintManual: boolean): void {
		const transcriptCapacity = this.#manualTranscriptCapacity(height);
		const anchorFrame = this.#viewportAnchorFrame;
		const semanticAnchor =
			anchorFrame === null
				? null
				: (this.#committedTranscriptRows
						.map((transcriptRow, screenRow) => {
							if (transcriptRow === null) return null;
							const anchor = anchorFrame.anchors[transcriptRow - anchorFrame.startRow];
							return anchor ? { ...anchor, frameRow: screenRow } : null;
						})
						.find(anchor => anchor !== null) ?? null);
		const cursor = this.#lastCursorPosition;
		let cursorRow: number | null = null;
		if (cursor !== null) {
			if (paintManual && cursor.row >= this.#manualTranscriptLineCount) {
				const noticeRows = this.#manualOutputNotice && height > this.#manualSuffixLineCount ? 1 : 0;
				cursorRow = transcriptCapacity + noticeRows + (cursor.row - this.#manualTranscriptLineCount);
			} else if (paintManual) {
				cursorRow = this.#committedTranscriptRows.indexOf(cursor.row);
			} else {
				cursorRow = cursor.row - viewportTop;
			}
		}
		const cursorVisible = cursorRow !== null && cursorRow >= 0 && cursorRow < height;
		const selectedRange = this.#mouseSelectionDragged ? this.#orderedMouseSelection() : null;
		const paintedSelection =
			selectedRange === null
				? null
				: {
						start: { line: selectedRange.start.line - viewportTop, column: selectedRange.start.column },
						end: { line: selectedRange.end.line - viewportTop, column: selectedRange.end.column },
					};
		this.#latestViewportObservation = {
			transcriptCapacity,
			pinBoundary: { row: transcriptCapacity, pinned: this.#bottomPinnedComponent !== null },
			manualHistory: paintManual,
			newOutputNoticeVisible: paintManual && this.#paintedManualOutputNotice,
			outputRevision: this.#viewportOutputSource?.revision.toString() ?? null,
			focused: this.#focusedComponent !== null,
			cursor: cursor
				? { row: cursorVisible ? cursorRow! : cursor.row, col: cursor.col, visible: cursorVisible }
				: null,
			selection: paintedSelection,
			semanticAnchor,
		};
	}

	#refreshPaintedLiveViewportObservation(height: number): void {
		this.#committedTranscriptRows = Array.from({ length: height }, (_, screenRow) => {
			const transcriptRow = this.#viewportTopRow + screenRow;
			return transcriptRow < this.#manualTranscriptLineCount ? transcriptRow : null;
		});
		this.#paintedManualOutputNotice = false;
		this.#recordPaintedViewportObservation(this.#viewportTopRow, height, false);
	}

	#doRender(): void {
		if (this.#stopped || !this.terminalAvailable) return;
		const transcriptIdentityReplaced = this.#transcriptIdentityReplaced;
		const restartViewportRepaintPending = this.#restartViewportRepaintPending;
		const resizeRenderMutationQueued = this.#resizeRenderMutationQueued;
		const widthSettleRenderQueued = this.#widthSettleRenderQueued;
		const tabWidthRepairPending = this.#tabWidthRepairPending;
		const forcedRenderQueued = this.#forcedRenderQueued;
		this.#resizeRenderQueued = false;
		this.#resizeRenderMutationQueued = false;
		this.#renderMutationQueued = false;
		this.#widthSettleRenderQueued = false;
		this.#tabWidthRepairPending = tabWidthRepairPending && this.#manualViewportTop !== undefined;
		this.#forcedRenderQueued = false;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		let viewportTop = Math.max(0, this.#maxLinesRendered - height);
		let prevViewportTop = this.#viewportTopRow;
		let hardwareCursorRow = this.#hardwareCursorRow;
		const computeLineDiff = (targetRow: number): number => {
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};

		const renderTreeStart = renderMetrics.now();
		const renderedLines: string[] = [];
		const renderedChildren = new Map<Component, string[]>();
		let anchorFrame: ViewportAnchorFrame | null = null;
		let previousKittyPlacementSpans = this.#kittyPlacementSpans;
		const placementOwners = new Map<string, KittyPlacementOwner>();
		const pinnedChildIndex =
			this.#bottomPinnedComponent === null ? -1 : this.children.indexOf(this.#bottomPinnedComponent);
		const hasStickySuffix = pinnedChildIndex >= 0;
		const anchorRenderFailureCountBefore = viewportAnchorRenderFailureCount;
		for (let childIndex = 0; childIndex < this.children.length; childIndex++) {
			const child = this.children[childIndex];
			const rendered = safeRenderComponentWithViewportAnchors(child, width, "tui-child");
			const safeLines = rendered.lines.map(stripTerminalEraseControls);
			renderedChildren.set(child, safeLines);
			const childStart = renderedLines.length;
			if (child === this.#viewportAnchorComponent && rendered.anchors.some(anchor => anchor !== null)) {
				anchorFrame = { startRow: childStart, anchors: rendered.anchors };
			}
			const owner: KittyPlacementOwner = hasStickySuffix && childIndex >= pinnedChildIndex ? "suffix" : "transcript";
			for (let lineIndex = 0; lineIndex < rendered.lines.length; lineIndex++) {
				const line = rendered.lines[lineIndex]!;
				for (const placement of extractKittyPlacementReferences(line)) {
					placementOwners.set(this.#kittyPlacementKey(placement), owner);
				}
				renderedLines.push(safeLines[lineIndex] ?? line);
			}
		}
		const sourceTranscriptLineCount = hasStickySuffix
			? this.children
					.slice(0, pinnedChildIndex)
					.reduce((count, child) => count + this.#pinnedChildLines(child, renderedChildren).length, 0)
			: renderedLines.length;
		const anchorRenderFailed = viewportAnchorRenderFailureCount !== anchorRenderFailureCountBefore;
		let newLines = this.#constrainPinnedSuffix(renderedLines, height, renderedChildren);
		this.#viewportAnchorFrame = anchorFrame;
		if (renderMetrics.enabled) renderMetrics.recordHelper("renderTree", renderMetrics.now() - renderTreeStart);

		if (hasStickySuffix && height > 0 && this.#manualViewportTop === undefined) {
			newLines = this.#padBeforeBottomPinnedComponent(
				newLines,
				height,
				newLines.length - sourceTranscriptLineCount,
			).lines;
		}
		const nextTranscriptLineCount = sourceTranscriptLineCount;
		const nextSuffixLineCount = hasStickySuffix ? Math.max(0, newLines.length - nextTranscriptLineCount) : 0;

		// Composite overlays into the rendered lines (before differential compare)
		if (this.overlayStack.length > 0) {
			newLines = this.#compositeOverlays(newLines, width, height, placementOwners);
		}

		// Extract cursor position (marker must be found before diff comparison)
		const cursorPos = this.#extractCursorPosition(newLines, height);
		this.#lastCursorPosition = cursorPos;

		newLines = this.#applyMouseSelection(newLines);

		// Terminate every non-image line so the latest frame mirrors emitted bytes
		// (closes SGR + OSC 8 hyperlink state). Must run after cursor extraction
		// because the marker is embedded mid-line, and before any diff/full render
		// path so cache comparisons stay byte-accurate.
		// Width/height change detection (used for normalization reuse and repaint decisions).
		const widthChanged = this.#previousWidth !== 0 && this.#previousWidth !== width;
		const widthMetadataChanged = this.#previousWidth > 0 && this.#previousWidth !== width;
		if (widthMetadataChanged) {
			// Emitted widths are viewport-dependent for truncated rows. The no-repair
			// resize path reuses the latest frame during repaint, so discard carried
			// width metadata before any differential guard reads it.
			this.#lineEmitWidthCache.clear();
		}
		const heightChanged = this.#previousHeight !== 0 && this.#previousHeight !== height;
		const initialRender = this.#previousLines.length === 0 && this.#maxLinesRendered === 0;
		let coalescedWidthAppend = false;

		// Normalize/truncate lines for emission. The virtual viewport is default-on;
		// PI_TUI_VIRTUAL_VIEWPORT=0 opts out. When enabled, reuse the previous frame's
		// normalized prefix when the off-screen raw prefix is unchanged (raw value equality
		// short-circuit for cached components), so only the visible window is
		// re-normalized and the diff starts at the window. Output is byte-identical to the
		// full path (reused entries are deterministic normalizations of identical raw lines).
		const VIEWPORT_NORMALIZE_OVERSCAN = 8;
		const rawLines = newLines.slice();
		const total = rawLines.length;
		let diffStart = 0;
		let usedWindowNormalize = false;
		if (
			this.#virtualViewport &&
			!widthChanged &&
			this.#latestRaw.length > 0 &&
			this.#latestRenderedLines.length === this.#latestRaw.length
		) {
			const winTop = Math.max(0, total - height - VIEWPORT_NORMALIZE_OVERSCAN);
			if (winTop <= this.#latestRenderedLines.length && winTop <= this.#latestRaw.length) {
				let stable = true;
				for (let i = 0; i < winTop; i++) {
					if (rawLines[i] !== this.#latestRaw[i]) {
						stable = false;
						break;
					}
				}
				if (stable) {
					const windowed = this.#latestRenderedLines.slice(0, winTop);
					for (let i = winTop; i < total; i++) {
						windowed.push(rawLines[i]);
					}
					this.#normalizeLinesForEmit(windowed, width, winTop);
					this.#trimLineCachesForRender(total);
					newLines = windowed;
					diffStart = winTop;
					usedWindowNormalize = true;
				}
			}
		}
		if (!usedWindowNormalize) {
			newLines = this.#applyLineResetsAndTruncate(rawLines.slice(), width);
		}
		if (renderMetrics.enabled) {
			renderMetrics.recordLineCount("rendered", total);
			renderMetrics.recordLineCount("normalized", total - diffStart);
			renderMetrics.recordLineCount("measured", total - diffStart);
			if (usedWindowNormalize) renderMetrics.recordLineCount("offscreenScan", diffStart);
		}
		const nextKittyPlacementSpans = this.#kittyPlacementSpansForLines(newLines, placementOwners);
		const previousLogicalFrame = this.#latestRenderedLines.slice();
		const previousRawFrame = this.#latestRaw.slice();
		const previousRenderedLength = previousLogicalFrame.length;
		this.#latestRenderedLines = newLines;
		this.#latestRenderedTranscriptLineCount = nextTranscriptLineCount;
		this.#latestRenderedSuffixLineCount = nextSuffixLineCount;
		this.#latestRenderedPlacementOwners = placementOwners;
		const naturalViewportTop = Math.max(0, newLines.length - height);
		const priorLogicalLineCount = Math.max(this.#previousLines.length, this.#maxLinesRendered);
		if (this.#transcriptIdentityResetPending) {
			this.#transcriptIdentityResetPending = false;
		} else if (
			newLines.length < priorLogicalLineCount &&
			(naturalViewportTop < prevViewportTop || this.#manualViewportTop !== undefined)
		) {
			this.#scrollbackResumeViewportTop = Math.max(
				this.#scrollbackResumeViewportTop ?? 0,
				this.#nativeScrollbackViewportTop,
			);
		}

		if (this.#manualViewportTop !== undefined) {
			const committedManualViewportTop = this.#manualViewportTop;
			const committedManualViewportAnchor = this.#manualViewportAnchor;
			const committedManualViewportFallbackAnchors = this.#manualViewportFallbackAnchors;
			const committedReconcileMissingViewportAnchor = this.#reconcileMissingViewportAnchor;
			const restoreManualIntent = (): void => {
				this.#manualViewportTop = committedManualViewportTop;
				this.#manualViewportAnchor = committedManualViewportAnchor;
				this.#manualViewportFallbackAnchors = committedManualViewportFallbackAnchors;
				this.#reconcileMissingViewportAnchor = committedReconcileMissingViewportAnchor;
			};
			let contentPainted = false;
			let resolvedAnchorTop = anchorFrame === null ? null : this.#resolveManualAnchor(anchorFrame);
			if (
				this.#manualViewportAnchor !== null &&
				resolvedAnchorTop === null &&
				this.#reconcileMissingViewportAnchor
			) {
				resolvedAnchorTop = anchorFrame === null ? null : this.#resolvePreparedManualAnchor(anchorFrame);
				this.#reconcileMissingViewportAnchor = false;
				if (resolvedAnchorTop === null) {
					this.#manualViewportAnchor = null;
					this.#manualViewportFallbackAnchors = [];
				}
			}
			if (this.#manualViewportAnchor !== null && resolvedAnchorTop === null) {
				if (anchorRenderFailed) {
					// Keep semantic intent armed for recovery, but render the diagnostic frame
					// instead of masking a provider failure behind stale transcript content.
					contentPainted = false;
					this.#repaintViewportFromLines(
						newLines,
						width,
						height,
						this.#manualViewportTop,
						null,
						"failed semantic viewport render",
						true,
						() => {
							contentPainted = true;
							this.#previousLines = newLines;
							this.#previousWidth = width;
							this.#previousHeight = height;
							this.#manualTranscriptLineCount = nextTranscriptLineCount;
							this.#manualSuffixLineCount = nextSuffixLineCount;
						},
						false,
						previousKittyPlacementSpans,
						nextKittyPlacementSpans,
						{ transcriptLineCount: nextTranscriptLineCount, suffixLineCount: nextSuffixLineCount },
						true,
					);
					if (contentPainted) {
						this.#latestRenderedLines = newLines;
						if (this.#virtualViewport) this.#latestRaw = rawLines;
					} else restoreManualIntent();
					return;
				}
				// A formerly valid semantic target is temporarily absent (provider removal,
				// replacement, eviction, or object deletion). Keep the last resolved frame
				// instead of silently reinterpreting manual intent as a numeric viewport.
				// Keep the committed physical baseline first: #latestRenderedLines may already
				// reflect source changes that are intentionally hidden until the anchor recovers.
				const retainedLines =
					this.#previousLines.length > 0
						? this.#previousLines
						: previousLogicalFrame.length > 0
							? previousLogicalFrame
							: newLines;
				contentPainted = false;
				this.#repaintViewportFromLines(
					retainedLines,
					width,
					height,
					this.#manualViewportTop,
					null,
					"unresolved semantic viewport render",
					true,
					() => {
						contentPainted = true;
						this.#previousWidth = width;
						this.#previousHeight = height;
					},
					false,
					previousKittyPlacementSpans,
				);
				if (!contentPainted) restoreManualIntent();
				return;
			}
			const nextViewportTop = resolvedAnchorTop ?? this.#manualViewportTop;
			if (
				!this.#mouseSelectionDragged &&
				this.#previousWidth === width &&
				this.#previousHeight === height &&
				nextViewportTop === this.#manualViewportTop &&
				this.#manualOutputNotice === this.#paintedManualOutputNotice &&
				this.#latestRenderedLines.length === newLines.length &&
				this.#latestRenderedLines.every((line, index) => line === newLines[index]) &&
				newLines.length === this.#previousLines.length &&
				newLines.every((line, index) => line === this.#previousLines[index])
			) {
				return;
			}
			this.#manualViewportTop = nextViewportTop;
			this.#reconcileMissingViewportAnchor = false;
			contentPainted = false;
			this.#repaintViewportFromLines(
				newLines,
				width,
				height,
				nextViewportTop,
				null,
				"manual viewport render",
				this.#manualViewportAnchor !== null,
				() => {
					contentPainted = true;
					this.#previousLines = newLines;
					this.#previousWidth = width;
					this.#previousHeight = height;
					this.#paintedManualOutputNotice = this.#manualOutputNotice;
					this.#manualTranscriptLineCount = nextTranscriptLineCount;
					this.#manualSuffixLineCount = nextSuffixLineCount;
				},
				false,
				previousKittyPlacementSpans,
				nextKittyPlacementSpans,
				{ transcriptLineCount: nextTranscriptLineCount, suffixLineCount: nextSuffixLineCount },
			);
			if (!contentPainted) restoreManualIntent();
			return;
		}
		// Helper to clear scrollback and viewport and render all new lines
		const shouldPreserveScrollbackOnFullClear = this.#viewportRepaintHost() || this.#legacyMultiplexerFullRender;
		let viewportRepaint: (
			reason: string,
			targetViewportTopOrAllowPastLiveBottom?: number | boolean,
			allowPastLiveBottom?: boolean,
		) => boolean;
		const fullRender = (clear: boolean, reason = "full render", forceScrollbackClear = false): void => {
			if (
				clear &&
				!forceScrollbackClear &&
				shouldPreserveScrollbackOnFullClear &&
				this.#scrollbackResumeViewportTop !== undefined
			) {
				viewportRepaint(`preserving full replay blocked after scrollback-unsafe contraction: ${reason}`);
				return;
			}
			this.#fullRedrawCount += 1;
			if (renderMetrics.enabled) renderMetrics.recordFullRedraw(reason);
			const deletePlan = this.#kittyPlacementDeletePlan(
				previousKittyPlacementSpans,
				nextKittyPlacementSpans,
				[],
				clear,
			);
			let buffer = `\x1b[?2026h${deletePlan.output}`; // Begin synchronized output
			// Skip clearing scrollback (3J) in hosts where clear/replay can snap the
			// native viewport away from the live prompt (tmux/screen, Windows ConPTY) —
			// unless the caller explicitly needs history erased (the settled width
			// repair, where a replay WITHOUT 3J would stack the new transcript on top
			// of the stale-width copy instead of replacing it).
			if (clear)
				buffer +=
					!forceScrollbackClear && shouldPreserveScrollbackOnFullClear ? "\x1b[2J\x1b[H" : "\x1b[2J\x1b[H\x1b[3J";
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				// Lines were pre-terminated/normalized by #applyLineResets; image
				// lines were left untouched there.
				buffer += newLines[i];
			}
			const cursorRow = Math.max(0, newLines.length - 1);
			const { seq, toRow } = this.#cursorControlSequence(cursorPos, newLines.length, cursorRow);
			buffer += seq;
			buffer += "\x1b[?2026l"; // End synchronized output
			if (
				!this.#writeRenderBufferAndReanchorImeCursor(buffer, cursorPos, newLines.length, () => {
					this.#cursorRow = cursorRow;
					this.#hardwareCursorRow = toRow;
					this.#maxLinesRendered = clear ? newLines.length : Math.max(this.#maxLinesRendered, newLines.length);
					this.#viewportTopRow = Math.max(0, this.#maxLinesRendered - height);
					this.#nativeScrollbackViewportTop = clear
						? this.#viewportTopRow
						: Math.max(this.#nativeScrollbackViewportTop, this.#viewportTopRow);
					if (clear && (forceScrollbackClear || !shouldPreserveScrollbackOnFullClear)) {
						this.#scrollbackResumeViewportTop = undefined;
					}
					this.#previousLines = newLines;
					this.#previousWidth = width;
					this.#previousHeight = height;
					this.#kittyPlacementSpans = this.#kittyCommittedPlacementsAfterPaint(
						previousKittyPlacementSpans,
						nextKittyPlacementSpans,
						deletePlan,
						[{ top: Number.NEGATIVE_INFINITY, bottom: Number.POSITIVE_INFINITY }],
					);
					this.#manualTranscriptLineCount = nextTranscriptLineCount;
					this.#manualSuffixLineCount = nextSuffixLineCount;
					this.#refreshPaintedLiveViewportObservation(height);
					this.#durableLineCount = newLines.length;
					this.#durableRenderedLines = newLines.slice();
					this.#durableRawLines = rawLines.slice();
					this.#transcriptIdentityReplaced = false;
				})
			)
				return;
			if (this.#virtualViewport) this.#latestRaw = rawLines;
		};

		viewportRepaint = (
			reason: string,
			targetViewportTopOrAllowPastLiveBottom: number | boolean = Math.max(0, newLines.length - height),
			allowPastLiveBottom = false,
		): boolean => {
			const targetViewportTop =
				typeof targetViewportTopOrAllowPastLiveBottom === "number"
					? targetViewportTopOrAllowPastLiveBottom
					: Math.max(0, newLines.length - height);
			const paintPastLiveBottom =
				typeof targetViewportTopOrAllowPastLiveBottom === "boolean"
					? targetViewportTopOrAllowPastLiveBottom
					: allowPastLiveBottom;
			return this.#repaintViewportFromLines(
				newLines,
				width,
				height,
				targetViewportTop,
				cursorPos,
				reason,
				paintPastLiveBottom,
				() => {
					this.#previousLines = newLines;
					this.#previousWidth = width;
					this.#previousHeight = height;
					this.#manualTranscriptLineCount = nextTranscriptLineCount;
					this.#manualSuffixLineCount = nextSuffixLineCount;
					this.#refreshPaintedLiveViewportObservation(height);
					this.#latestRenderedLines = newLines.slice();
					if (this.#virtualViewport) this.#latestRaw = rawLines.slice();
				},
				false,
				previousKittyPlacementSpans,
				nextKittyPlacementSpans,
				{ transcriptLineCount: nextTranscriptLineCount, suffixLineCount: nextSuffixLineCount },
				true,
			);
		};
		if (transcriptIdentityReplaced && !initialRender) {
			fullRender(true, "transcript identity replaced", true);
			return;
		}
		if (tabWidthRepairPending && !initialRender) {
			fullRender(true, "tab width changed", true);
			return;
		}
		// A width change may only use the durable append path when the current raw
		// frame proves that the previous raw frame is an unchanged prefix. Otherwise
		// component reflow (including row-count growth) is indistinguishable from an
		// append, so repaint the live viewport without replaying durable history.
		// Resize-only frames must never enter this path: a row-count increase caused
		// solely by reflow is not durable content and must remain a viewport repaint.
		let retainedLength = -1;
		if (widthChanged && !initialRender) {
			// Raw-prefix equality only proves a durable row prefix when every retained
			// raw row fits at both widths. Otherwise find the conservative physical
			// reflow boundary before appending the mutation suffix.
			let rawPrefixProven = false;
			if (this.#virtualViewport && rawLines.length > previousRawFrame.length) {
				const previousWidth = this.#previousWidth;
				if (previousWidth > 0) {
					rawPrefixProven = true;
					const durableWidth = Math.min(previousWidth, width);
					for (let i = 0; i < previousRawFrame.length; i++) {
						if (rawLines[i] !== previousRawFrame[i] || visibleWidth(rawLines[i]) > durableWidth) {
							rawPrefixProven = false;
							break;
						}
					}
					if (rawPrefixProven) retainedLength = previousRawFrame.length;
				}
			}
			if (rawPrefixProven) {
				// Raw rows can expand into a different number of physical rows at
				// the new width (components may also expose width-sensitive rows).
				// Derive the retained boundary from rendered frames so reflow
				// continuations are not committed as durable output.
				retainedLength = findSafeReflowSuffixStart(previousLogicalFrame, newLines);
				if (retainedLength < 0) rawPrefixProven = false;
			}
			if (!rawPrefixProven) {
				// A raw row that exceeded the old/new width may have been truncated in
				// the previous frame. Match the rendered frame so a resize cannot
				// mistake that truncation for a stable durable boundary.
				const previousFrameLines = previousLogicalFrame;
				const hasPresentationMetadata =
					previousRawFrame.some(line => !TERMINAL.isImageLine(line) && Bun.stripANSI(line) !== line) ||
					rawLines.some(line => !TERMINAL.isImageLine(line) && Bun.stripANSI(line) !== line);
				const stableLogicalBoundary = hasPresentationMetadata
					? -1
					: findStableLogicalAppendBoundary(previousFrameLines, rawLines);
				retainedLength =
					stableLogicalBoundary >= 0
						? stableLogicalBoundary
						: hasPresentationMetadata
							? -1
							: findSafeReflowSuffixStart(previousFrameLines, rawLines);
			}
		}
		const distinctPostContractionRows = hasDistinctPostContractionRows(
			previousLogicalFrame,
			newLines,
			this.#durableRenderedLines,
			rawLines,
			this.#durableRawLines,
		);
		const durableAppend = newLines.length > this.#durableLineCount || distinctPostContractionRows;
		// A stale durable frontier can sit behind a transient reflow frame. Coalesced
		// resize/mutation output is an append only when the desired frame also grew
		// beyond that frame; otherwise CRLF would commit reflow rows a second time.
		const logicalAppend = newLines.length > previousRenderedLength;
		if (widthSettleRenderQueued && this.#widthSettleRepairPending && !initialRender) {
			// The debounced repair is the only permitted full clear/replay after a
			// resize storm. It must run before resize-only admission so old-width
			// wraps are replaced in native scrollback as well as the live viewport.
			this.#widthSettleRepairPending = false;
			fullRender(true, "width settled", true);
			return;
		}
		const useViewportRepaintPath = this.#viewportRepaintHost();
		const widthReflowRequired =
			this.#previousWidth > 0 &&
			rawLines.some(
				line => !TERMINAL.isImageLine(line) && visibleWidth(line) > Math.min(this.#previousWidth, width),
			);
		if (
			widthChanged &&
			!this.#legacyMultiplexerFullRender &&
			!initialRender &&
			(!resizeRenderMutationQueued ||
				!durableAppend ||
				!logicalAppend ||
				retainedLength < 0 ||
				retainedLength >= newLines.length) &&
			useViewportRepaintPath
		) {
			// Resize-only frames, and frames without a proven append suffix, repaint
			// the live viewport without replaying durable history. Only on viewport-
			// repaint hosts (multiplexers, Windows Terminal, process terminals); plain
			// terminals fall through to fullRender so the whole frame is replayed.
			if (forcedRenderQueued) this.#fullRedrawCount += 1;
			viewportRepaint(`terminal width changed (${this.#previousWidth} -> ${width})`, true, true);
			return;
		}
		if (widthChanged && !initialRender && resizeRenderMutationQueued) {
			this.#latestRenderedLines = newLines.slice(0, retainedLength);
			if (this.#virtualViewport) this.#latestRaw = rawLines.slice(0, retainedLength);
			coalescedWidthAppend = true;
		}

		const debugRedraw = this.#debugRedraw;
		const logRedraw = (reason: string): void => {
			if (!debugRedraw) return;
			const msg = `[${new Date().toISOString()}] fullRender: ${reason} (new=${newLines.length}, height=${height})\n`;
			this.#appendDebugRedrawLog(msg);
		};

		if (restartViewportRepaintPending && initialRender) {
			const restartAppendProven =
				width === this.#restartDurableWidth &&
				rawLines.length >= this.#restartDurableLineCount &&
				rawLines
					.slice(0, this.#restartDurableLineCount)
					.every((line, index) => line === this.#restartDurableRawLines[index]);
			if (restartAppendProven && rawLines.length > this.#restartDurableLineCount) {
				const appendBuffer = `\x1b[?2026h${newLines.slice(this.#restartDurableLineCount).join("\r\n")}\x1b[?2026l`;
				if (!this.#writeTerminal(appendBuffer)) return;
				// The append already reached native scrollback. Advance both the live
				// frontier and the retained restart baseline before the viewport write:
				// a subsequent terminal failure must not re-admit this suffix on restart.
				this.#durableLineCount = newLines.length;
				this.#durableRenderedLines = newLines.slice();
				this.#durableRawLines = rawLines.slice();
				this.#restartDurableLineCount = newLines.length;
				this.#restartDurableRenderedLines = newLines.slice();
				this.#restartDurableRawLines = rawLines.slice();
				this.#restartDurableWidth = width;
			}
			if (viewportRepaint("restart after temporary stop")) {
				if (restartAppendProven) {
					this.#durableLineCount = newLines.length;
					this.#durableRenderedLines = newLines.slice();
					this.#durableRawLines = rawLines.slice();
				} else {
					this.#durableLineCount = this.#restartDurableLineCount;
					this.#durableRenderedLines = this.#restartDurableRenderedLines.slice();
					this.#durableRawLines = this.#restartDurableRawLines.slice();
				}
				this.#restartDurableLineCount = 0;
				this.#restartDurableRenderedLines = [];
				this.#restartDurableRawLines = [];
				this.#restartDurableWidth = 0;
				this.#restartViewportRepaintPending = false;
			}
			return;
		}
		// First render - just output everything without clearing (assumes clean screen)
		if (initialRender) {
			logRedraw("first render");
			fullRender(false, "first render");
			return;
		}

		// Width changes always need a full re-render because wrapping changes, unless
		// a proven coalesced append is continuing through the durable append path.
		if (widthChanged && !coalescedWidthAppend) {
			if (!widthReflowRequired) {
				this.#widthSettleRepairPending = false;
				logRedraw(`terminal width changed without reflow (${this.#previousWidth} -> ${width})`);
				if (useViewportRepaintPath) {
					viewportRepaint(`terminal width changed without reflow (${this.#previousWidth} -> ${width})`);
				} else {
					fullRender(true, "terminal width changed without reflow");
				}
				return;
			}
			if (useViewportRepaintPath) {
				logRedraw(`terminal width changed (${this.#previousWidth} -> ${width})`);
				// In viewport-repaint sessions a per-event full replay can either pile
				// the transcript back onto scrollback (tmux/screen) or visibly jump to
				// the transcript top (Windows Terminal). Repaint the viewport only,
				// mirroring the height-change branch and neutralizing fake width
				// changes from requestRender(true).
				viewportRepaint(`terminal width changed (${this.#previousWidth} -> ${width})`);
			} else {
				logRedraw(`terminal width changed (${this.#previousWidth} -> ${width})`);
				fullRender(true, "terminal width changed");
			}
			return;
		}

		// Height changes normally need a full re-render to keep the visible viewport aligned,
		// but Termux changes height when the software keyboard shows or hides.
		// In that environment, a full redraw causes the entire history to replay on every toggle.
		if (heightChanged) {
			if (useViewportRepaintPath) {
				viewportRepaint(`terminal height changed (${this.#previousHeight} -> ${height})`);
				return;
			}
			logRedraw(`terminal height changed (${this.#previousHeight} -> ${height})`);
			fullRender(true, "terminal height changed");
			return;
		}

		// Content shrunk below the previous render and no overlays - re-render to clear empty rows
		// (overlays need the padding, so only do this when no overlays are active)
		// Configurable via setClearOnShrink() or GJC_CLEAR_ON_SHRINK=0 env var
		if (this.#clearOnShrink && newLines.length < this.#previousLines.length && this.overlayStack.length === 0) {
			logRedraw(`clearOnShrink (prev=${this.#previousLines.length}, new=${newLines.length})`);
			if (useViewportRepaintPath) {
				viewportRepaint(`clearOnShrink (prev=${this.#previousLines.length}, new=${newLines.length})`);
			} else {
				fullRender(true, "clearOnShrink");
			}
			return;
		}

		// Find first and last changed lines
		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.#previousLines.length);
		if (renderMetrics.enabled) renderMetrics.recordLineCount("diffed", maxLines - diffStart);
		// When the off-screen prefix was reused (virtual viewport), it is verified
		// unchanged (raw value equality), so the diff can safely start at the window boundary.
		for (let i = diffStart; i < maxLines; i++) {
			const oldLine = i < this.#previousLines.length ? this.#previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";

			if (oldLine !== newLine) {
				if (firstChanged === -1) {
					firstChanged = i;
				}
				lastChanged = i;
			}
		}
		// Regrowth entirely within rows already committed before a contraction is
		// a viewport repaint, never a new scrollback append.
		if (
			!initialRender &&
			!coalescedWidthAppend &&
			newLines.length > this.#previousLines.length &&
			newLines.length <= this.#durableLineCount &&
			!distinctPostContractionRows
		) {
			viewportRepaint("content regrowth within durable history", true, true);
			return;
		}
		const appendedLines = newLines.length > this.#previousLines.length || durableAppend;
		if (appendedLines) {
			if (
				this.#nativeScrollbackAdmissionPending &&
				this.#durableLineCount <= firstChanged &&
				previousLogicalFrame.length < newLines.length &&
				firstChanged >= previousLogicalFrame.length
			) {
				// Following a manual viewport repaints the live frame in place, so its
				// newest rows are not yet in native scrollback. Advance by a newline
				// before emitting the new frontier; the terminal admits the existing
				// bottom row without replaying its bytes.
				firstChanged = previousLogicalFrame.length;
			} else if (coalescedWidthAppend && retainedLength >= 0) {
				// The terminal reflows the retained prefix during a resize. Emit only
				// the proven durable suffix; replaying the reflowed prefix would append
				// historical rows to native scrollback a second time.
				firstChanged = retainedLength;
			} else if (firstChanged === -1 || (durableAppend && firstChanged === previousLogicalFrame.length)) {
				// A resize repaint updates #latestRenderedLines without committing the
				// reflowed viewport rows to scrollback. Never rewind the suffix start
				// below that repaint boundary: doing so re-emits reflow rows on the
				// following real append. A contraction can still retain a higher
				// durable boundary, hence the maximum.
				firstChanged =
					durableAppend && !coalescedWidthAppend && !distinctPostContractionRows
						? Math.max(this.#durableLineCount, previousLogicalFrame.length)
						: previousLogicalFrame.length;
			}
			lastChanged = newLines.length - 1;
		}
		let appendStart =
			appendedLines &&
			firstChanged > 0 &&
			(firstChanged === this.#previousLines.length ||
				firstChanged === previousLogicalFrame.length ||
				firstChanged === this.#durableLineCount);
		if (firstChanged >= 0) {
			const changedTop = firstChanged;
			let expanded: boolean;
			do {
				const priorTop = firstChanged;
				const priorBottom = lastChanged + 1;
				for (const placement of previousKittyPlacementSpans) {
					const placementBottom = placement.row + placement.rows;
					if (placement.row >= priorBottom || placementBottom <= priorTop) continue;
					firstChanged = Math.min(firstChanged, placement.row);
					lastChanged = Math.max(lastChanged, placementBottom - 1);
				}
				expanded = firstChanged !== priorTop || lastChanged + 1 !== priorBottom;
			} while (expanded);
			if (firstChanged !== changedTop) appendStart = false;
		}

		// No changes - but still need to update hardware cursor position if it moved
		if (firstChanged === -1) {
			this.#viewportTopRow = Math.max(0, this.#maxLinesRendered - height);
			if (this.#writeCursorPosition(cursorPos, newLines.length)) this.#refreshPaintedLiveViewportObservation(height);
			return;
		}

		const nextLiveViewportTop = Math.max(0, newLines.length - height);
		if (newLines.length < this.#previousLines.length && nextLiveViewportTop !== prevViewportTop) {
			viewportRepaint(`content contraction changed viewport top (${prevViewportTop} -> ${nextLiveViewportTop})`);
			return;
		}
		if (
			appendedLines &&
			nextLiveViewportTop > prevViewportTop &&
			previousKittyPlacementSpans.some(placement =>
				this.#kittyPlacementIntersectsRegion(placement, {
					top: prevViewportTop,
					bottom: prevViewportTop + height,
				}),
			)
		) {
			viewportRepaint(
				`content append moved a Kitty placement viewport (${prevViewportTop} -> ${nextLiveViewportTop})`,
			);
			return;
		}
		if (distinctPostContractionRows) this.#scrollbackResumeViewportTop = undefined;
		if (
			appendedLines &&
			this.#scrollbackResumeViewportTop !== undefined &&
			nextLiveViewportTop > prevViewportTop &&
			!distinctPostContractionRows
		) {
			const resumeViewportTop = this.#scrollbackResumeViewportTop;
			if (nextLiveViewportTop <= resumeViewportTop) {
				viewportRepaint(
					`content expansion below committed scrollback frontier (${prevViewportTop} -> ${nextLiveViewportTop}, frontier=${resumeViewportTop})`,
				);
				return;
			}

			const previousLines = this.#previousLines;
			const previousWidth = this.#previousWidth;
			const previousHeight = this.#previousHeight;
			if (
				!viewportRepaint(
					`staging committed scrollback frontier before resumed admission (${prevViewportTop} -> ${resumeViewportTop} -> ${nextLiveViewportTop})`,
					resumeViewportTop,
				)
			) {
				return;
			}
			previousKittyPlacementSpans = this.#kittyPlacementSpans;
			this.#previousLines = previousLines;
			this.#previousWidth = previousWidth;
			this.#previousHeight = previousHeight;
			prevViewportTop = resumeViewportTop;
			viewportTop = resumeViewportTop;
			hardwareCursorRow = this.#hardwareCursorRow;
			firstChanged = resumeViewportTop;
			appendStart = false;
			this.#scrollbackResumeViewportTop = undefined;
		}
		// All changes are in deleted lines (nothing to render, just clear)
		if (firstChanged >= newLines.length) {
			if (this.#previousLines.length > newLines.length) {
				const deletePlan = this.#kittyPlacementDeletePlan(previousKittyPlacementSpans, nextKittyPlacementSpans, [
					{ top: firstChanged, bottom: lastChanged + 1 },
				]);
				let buffer = `\x1b[?2026h${deletePlan.output}`;
				// Move to end of new content (clamp to 0 for empty content)
				const targetRow = Math.max(0, newLines.length - 1);
				const lineDiff = computeLineDiff(targetRow);
				if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;
				else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;
				buffer += "\r";
				// Clear extra lines without scrolling
				const extraLines = this.#previousLines.length - newLines.length;
				if (extraLines > height) {
					logRedraw(`extraLines > height (${extraLines} > ${height})`);
					viewportRepaint(`extraLines > height (${extraLines} > ${height})`);
					return;
				}
				const clearStartOffset = newLines.length > 0 && extraLines > 0 ? 1 : 0;
				if (clearStartOffset > 0) {
					buffer += `\x1b[${clearStartOffset}B`;
				}
				for (let i = 0; i < extraLines; i++) {
					buffer += `\r${" ".repeat(width)}`;
					if (i < extraLines - 1) buffer += "\x1b[1B";
				}
				const moveUp = extraLines - 1 + clearStartOffset;
				if (moveUp > 0) {
					buffer += `\x1b[${moveUp}A`;
				}
				const { seq, toRow } = this.#cursorControlSequence(cursorPos, newLines.length, targetRow);
				buffer += seq;
				buffer += "\x1b[?2026l";
				if (
					!this.#writeRenderBufferAndReanchorImeCursor(buffer, cursorPos, newLines.length, () => {
						this.#cursorRow = targetRow;
						this.#hardwareCursorRow = toRow;
						this.#previousLines = newLines;
						this.#previousWidth = width;
						this.#previousHeight = height;
						this.#maxLinesRendered = newLines.length;
						this.#viewportTopRow = Math.max(0, newLines.length - height);
						this.#kittyPlacementSpans = this.#kittyCommittedPlacementsAfterPaint(
							previousKittyPlacementSpans,
							nextKittyPlacementSpans,
							deletePlan,
							[],
						);
						this.#manualTranscriptLineCount = nextTranscriptLineCount;
						this.#manualSuffixLineCount = nextSuffixLineCount;
						this.#refreshPaintedLiveViewportObservation(height);
					})
				)
					return;
				this.#latestRenderedLines = newLines;
				if (this.#virtualViewport) this.#latestRaw = rawLines;
				this.#transcriptIdentityReplaced = false;
			}
			this.#latestRenderedLines = newLines;
			if (this.#virtualViewport) this.#latestRaw = rawLines;
			this.#durableLineCount = Math.max(this.#durableLineCount, newLines.length);
			this.#previousWidth = width;
			this.#previousHeight = height;
			this.#maxLinesRendered = newLines.length;
			this.#viewportTopRow = Math.max(0, newLines.length - height);
			this.#manualTranscriptLineCount = nextTranscriptLineCount;
			this.#manualSuffixLineCount = nextSuffixLineCount;
			this.#refreshPaintedLiveViewportObservation(height);
			return;
		}

		// Differential rendering can only touch what was actually visible. If a
		// streaming status/header line changes above a live-following viewport, keep
		// the terminal pinned by diffing from the visible top instead of clearing and
		// replaying the transcript. Historical mutations repaint the viewport so
		// native scrollback is never replayed or repaired.
		// When a historical mutation is accompanied by growth, commit only the
		// changed visible suffix. This advances native scrollback without replaying
		// the mutated off-screen prefix; the latest frame is updated below so each
		// appended row is emitted exactly once.
		if (firstChanged < prevViewportTop && appendedLines) {
			// A substitution above the viewport (a streaming status line, say) leaves
			// every later row at its original index, so the visible suffix can still be
			// committed. An insertion *inside* the off-screen prefix instead displaces
			// committed content down across the scrollback frontier: the rows this
			// frame would commit already sit in native scrollback under their old
			// index, so emitting them appends a second copy — a pending tool block
			// stranded above its own completed copy, with the rows between duplicated.
			//
			// Rendered bytes carry no row identity, so no test on them can prove which
			// logical row moved: a substitution changes rows without moving anything,
			// an insertion moves everything without necessarily changing any given row,
			// and a run of repeated rows makes a plain append look exactly like a
			// displacement. Since the two are not always distinguishable, look for the
			// harm rather than the cause, and require both halves of it.
			//
			// First, a displacement moves the whole visible region down by one uniform
			// offset, so the previously visible rows must reappear almost intact
			// `offset` rows lower. Second — and this is what an append behind repeated
			// rows cannot fake — the rows that displacement pulls into the top of the
			// visible region must be exactly the last `offset` rows already committed
			// to native scrollback. That second half is the damage itself: those rows
			// are about to be emitted a second time. Rows merely rewritten in place
			// push nothing back into view, so they still commit their suffix.
			const shift = newLines.length - this.#previousLines.length;
			const visibleRows = this.#previousLines.length - prevViewportTop;
			if (shift > 0 && prevViewportTop > diffStart && visibleRows > 1) {
				for (let offset = 1; offset <= Math.min(shift, prevViewportTop, visibleRows - 1); offset++) {
					let recommittedRows = 0;
					for (let j = 0; j < offset; j++) {
						if (this.#previousLines[prevViewportTop - offset + j] === newLines[prevViewportTop + j]) {
							recommittedRows += 1;
						}
					}
					if (recommittedRows < offset) continue;
					let displacedRows = 0;
					for (let i = prevViewportTop; i < this.#previousLines.length; i++) {
						if (this.#previousLines[i] === newLines[i + offset]) displacedRows += 1;
					}
					if (displacedRows < visibleRows - offset) continue;
					const reason = `offscreen insertion displaced committed rows (${firstChanged} < ${prevViewportTop}, offset=${offset}/${visibleRows})`;
					logRedraw(reason);
					if (useViewportRepaintPath) viewportRepaint(reason);
					else fullRender(true, reason);
					return;
				}
			}
			let suffixStart = -1;
			for (let i = Math.max(diffStart, prevViewportTop); i < maxLines; i++) {
				const oldLine = i < this.#previousLines.length ? this.#previousLines[i] : "";
				const newLine = i < newLines.length ? newLines[i] : "";
				if (oldLine !== newLine) {
					suffixStart = i;
					break;
				}
			}
			if (suffixStart >= 0) {
				firstChanged = suffixStart;
				appendStart =
					firstChanged > 0 &&
					(firstChanged === previousLogicalFrame.length || firstChanged === this.#durableLineCount);
			}
		}
		// A transient width-reflow repaint can leave the latest logical frame
		// above the durable boundary: those reflowed rows are visible, but were
		// intentionally not committed to native scrollback. If a later update
		// has the same row count and changes only that off-screen prefix,
		// `durableAppend` is true solely because the boundary is stale. Treat it
		// as a viewport repaint rather than moving through or replaying history.
		if (
			firstChanged < prevViewportTop &&
			newLines.length === previousLogicalFrame.length &&
			this.#latestRenderedLines.length > this.#durableLineCount
		) {
			logRedraw("offscreen mutation after transient reflow");
			viewportRepaint("offscreen mutation after transient reflow");
			return;
		}

		if (firstChanged < prevViewportTop && !durableAppend) {
			logRedraw(`firstChanged < viewportTop (${firstChanged} < ${prevViewportTop})`);
			if (useViewportRepaintPath) {
				viewportRepaint(`firstChanged < viewportTop (${firstChanged} < ${prevViewportTop})`);
			} else {
				fullRender(true, "firstChanged < viewportTop");
			}
			return;
		}
		// Render from first changed line to end
		// Build buffer with all updates wrapped in synchronized output
		const deletePlan = this.#kittyPlacementDeletePlan(previousKittyPlacementSpans, nextKittyPlacementSpans, [
			{ top: firstChanged, bottom: lastChanged + 1 },
		]);
		let buffer = `\x1b[?2026h${deletePlan.output}`; // Begin synchronized output
		const prevViewportBottom = prevViewportTop + height - 1;
		const nativeScrollbackAdmission =
			appendedLines &&
			this.#nativeScrollbackAdmissionPending &&
			this.#durableLineCount <= firstChanged &&
			previousLogicalFrame.length < newLines.length &&
			firstChanged >= previousLogicalFrame.length &&
			appendStart;
		if (nativeScrollbackAdmission) {
			// A live repaint can leave the hardware cursor one row beyond the
			// logical frontier when the bottom row wrapped at terminal width.
			// Let the geometry branch perform the native scroll from that row;
			// moving back first would only advance a blank row.
			appendStart = false;
		}
		const moveTargetRow = coalescedWidthAppend
			? newLines.length - 1
			: nativeScrollbackAdmission
				? firstChanged
				: appendStart
					? firstChanged - 1
					: firstChanged;
		if (moveTargetRow > prevViewportBottom) {
			if (nativeScrollbackAdmission) {
				// The logical cursor row can be one row ahead of the physical xterm
				// cursor after a live viewport repaint (a full-width row leaves a
				// pending wrap). CUD is bounded by the terminal's scroll margin, so
				// moving by one viewport height reliably reaches the physical bottom
				// without replaying any transcript bytes.
				buffer += `\x1b[${Math.max(1, height)}B`;
			} else {
				const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
				const moveToBottom = height - 1 - currentScreenRow;
				if (moveToBottom > 0) {
					buffer += `\x1b[${moveToBottom}B`;
				}
			}
			const scroll = moveTargetRow - prevViewportBottom;
			// Native admission follows a repaint at the live bottom. Use IND rather
			// than LF so the terminal performs one unambiguous scroll without
			// reinterpreting a pending wrapped row.
			buffer += (nativeScrollbackAdmission ? "\r\x1bD" : "\r\n").repeat(scroll);
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		// Move cursor to first changed line (use hardwareCursorRow for actual position)
		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) {
			buffer += `\x1b[${lineDiff}B`; // Move down
		} else if (lineDiff < 0) {
			buffer += `\x1b[${-lineDiff}A`; // Move up
		}

		buffer += appendStart ? "\r\n" : "\r"; // Move to column 0

		// Only render changed lines (firstChanged to lastChanged), not all lines to end
		// This reduces flicker when only a single line changes (e.g., spinner animation)
		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) buffer += "\r\n";
			buffer += "\x1b[2K";
			const line = newLines[i];
			let truncatedLine = line;
			const isImage = TERMINAL.isImageLine(line);
			const lineWidth = isImage ? 0 : this.#visibleWidthForDifferentialGuard(line);
			if (!isImage && lineWidth > width) {
				if (debugRedraw) {
					const debugData = [
						`[TUI Truncate] ${new Date().toISOString()}`,
						`Line ${i} truncated: ${lineWidth} > ${width}`,
						`Content preview: ${line.slice(0, 100)}...`,
						"",
					].join("\n");
					try {
						this.#appendDebugRedrawLog(debugData);
					} catch {
						// Ignore write errors - truncation should still work
					}
				}
				truncatedLine = truncateToWidth(line, width, Ellipsis.Omit);
				// Re-append the terminator: truncateToWidth removes trailing
				// content past the visible-width budget, which may also drop the
				// terminator appended by #applyLineResets. Match the conditional
				// OSC 8 close strategy used there.
				truncatedLine += truncatedLine.includes("\x1b]8;") ? LINE_TERMINATOR : SEGMENT_RESET;
			}
			// Non-image lines are pre-terminated/normalized by #applyLineResets;
			// truncated lines re-append LINE_TERMINATOR above.
			buffer += this.#padLineToWidth(truncatedLine, width);
		}

		// Track where cursor ended up after rendering
		let finalCursorRow = renderEnd;

		// If we had more lines before, clear them and move cursor back
		if (this.#previousLines.length > newLines.length) {
			// Move to end of new content first if we stopped before it
			if (renderEnd < newLines.length - 1) {
				const moveDown = newLines.length - 1 - renderEnd;
				buffer += `\x1b[${moveDown}B`;
				finalCursorRow = newLines.length - 1;
			}
			const extraLines = this.#previousLines.length - newLines.length;
			for (let i = newLines.length; i < this.#previousLines.length; i++) {
				buffer += `\r\n${" ".repeat(width)}`;
			}
			// Move cursor back to end of new content
			buffer += `\x1b[${extraLines}A`;
		}

		const { seq, toRow } = this.#cursorControlSequence(cursorPos, newLines.length, finalCursorRow);
		buffer += seq;
		buffer += "\x1b[?2026l"; // End synchronized output

		if ($pickflag("GJC_TUI_DEBUG", "PI_TUI_DEBUG")) {
			const debugDir = "/tmp/tui";
			fs.mkdirSync(debugDir, { recursive: true });
			const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
			const debugData = [
				`firstChanged: ${firstChanged}`,
				`viewportTop: ${viewportTop}`,
				`cursorRow: ${this.#cursorRow}`,
				`height: ${height}`,
				`lineDiff: ${lineDiff}`,
				`hardwareCursorRow: ${hardwareCursorRow}`,
				`hardwareCursorRow (post): ${this.#hardwareCursorRow}`,
				`renderEnd: ${renderEnd}`,
				`finalCursorRow: ${finalCursorRow}`,
				`cursorPos: ${JSON.stringify(cursorPos)}`,
				`newLines.length: ${newLines.length}`,
				`latestRenderedLines.length: ${this.#latestRenderedLines.length}`,
				"",
				"=== newLines ===",
				JSON.stringify(newLines, null, 2),
				"",
				"=== latestRenderedLines ===",
				JSON.stringify(this.#latestRenderedLines, null, 2),
				"",
				"=== buffer ===",
				JSON.stringify(buffer),
			].join("\n");
			fs.writeFileSync(debugPath, debugData);
		}

		// Write entire buffer at once. Once those bytes are accepted, the painted
		// frame and geometry are authoritative even when the optional IME cursor
		// write subsequently detaches the terminal.
		if (
			!this.#writeRenderBufferAndReanchorImeCursor(buffer, cursorPos, newLines.length, () => {
				this.#hardwareCursorRow = toRow;
				this.#cursorRow = Math.max(0, newLines.length - 1);
				this.#maxLinesRendered = newLines.length;
				this.#viewportTopRow = Math.max(0, newLines.length - height);
				this.#nativeScrollbackViewportTop = Math.max(this.#nativeScrollbackViewportTop, this.#viewportTopRow);
				this.#previousLines = newLines;
				this.#previousWidth = width;
				this.#previousHeight = height;
				this.#kittyPlacementSpans = this.#kittyCommittedPlacementsAfterPaint(
					previousKittyPlacementSpans,
					nextKittyPlacementSpans,
					deletePlan,
					[{ top: firstChanged, bottom: renderEnd + 1 }],
				);
				this.#manualTranscriptLineCount = nextTranscriptLineCount;
				this.#manualSuffixLineCount = nextSuffixLineCount;
				this.#refreshPaintedLiveViewportObservation(height);
			})
		)
			return;
		this.#latestRenderedLines = newLines;
		if (this.#virtualViewport) this.#latestRaw = rawLines;
		this.#durableLineCount = Math.max(this.#durableLineCount, newLines.length);
		this.#recordDurableLines(newLines, rawLines, firstChanged, renderEnd);
		this.#nativeScrollbackAdmissionPending = false;
		this.#transcriptIdentityReplaced = false;
	}

	/**
	 * Build cursor control sequences to position the hardware cursor for the IME
	 * candidate window. Returns escape sequences and the resulting cursor row for
	 * the caller to update `#hardwareCursorRow`. The sequences should be appended
	 * into the caller's own synchronized output block to avoid a flicker between
	 * content and cursor frames.
	 */
	#cursorControlSequence(
		cursorPos: { row: number; col: number } | null,
		totalLines: number,
		fromRow: number,
	): { seq: string; toRow: number } {
		if (!cursorPos || totalLines <= 0) {
			const hide = this.#useImeBlockCursor ? "\x1b[0 q\x1b[?25l" : "\x1b[?25l";
			return { seq: hide, toRow: fromRow };
		}

		// Clamp cursor position to valid range
		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const targetCol = Math.max(0, cursorPos.col);

		// Move cursor from current position to target
		const rowDelta = targetRow - fromRow;
		let seq = "";
		if (rowDelta > 0) {
			seq += `\x1b[${rowDelta}B`; // Move down
		} else if (rowDelta < 0) {
			seq += `\x1b[${-rowDelta}A`; // Move up
		}
		// Move to absolute column (1-indexed)
		seq += `\x1b[${targetCol + 1}G`;
		if (this.#showHardwareCursor || this.#imeCursorActive) {
			seq += this.#useImeBlockCursor ? "\x1b[2 q\x1b[?25h" : "\x1b[?25h";
		} else {
			seq += "\x1b[?25l";
		}

		return { seq, toRow: targetRow };
	}

	/** Retain terminal cleanup until a write succeeds, even after its component is disposed. */
	queueTerminalCleanup(payload: string, onDelivered?: () => void): void {
		this.#pendingTerminalCleanup.push({ payload, onDelivered });
		this.flushTerminalCleanup();
	}

	/** Retry queued terminal cleanup after terminal recovery or before shutdown. */
	flushTerminalCleanup(): void {
		while (this.#pendingTerminalCleanup.length > 0) {
			const pending = this.#pendingTerminalCleanup[0];
			if (!this.#writeTerminal(pending.payload)) return;
			this.#pendingTerminalCleanup.shift();
			pending.onDelivered?.();
		}
	}

	/**
	 * Register an emitter whose payload is delivered after each shared render
	 * transaction. The emitter is an exempt physical overlay: its bytes are
	 * deliberately kept out of the shared transcript write.
	 */
	setPostRenderEmitter(emitter: (() => string | null) | undefined): void {
		this.#postRenderEmitter = emitter;
	}

	#postRenderEmitter: (() => string | null) | undefined;

	#writeRenderBufferAndReanchorImeCursor(
		buffer: string,
		cursorPos: { row: number; col: number } | null,
		totalLines: number,
		onBufferWritten?: () => void,
	): boolean {
		if (!this.#writeTerminal(buffer)) {
			return false;
		}
		onBufferWritten?.();
		this.#lastRenderWriteSucceeded = true;

		const overlay = this.#postRenderEmitter?.();
		if (overlay) {
			// DECSC/DECRC keep the hardware cursor stable; the dedicated
			// synchronized block prevents visible tearing while the overlay
			// area is cleared and redrawn.
			const overlayBuffer = `\x1b[?2026h\x1b7${overlay}\x1b8\x1b[?2026l`;
			// Overlay delivery is outside shared transcript ownership. The
			// shared write has already committed even when this exempt write
			// fails, so do not make callers retry the shared bytes.
			if (!this.#writeTerminal(overlayBuffer, true)) {
				return true;
			}
		}
		if (!this.#imeCursorActive) return true;
		// Cursor positioning is outside shared transcript ownership. A failure still
		// makes the terminal unavailable, but cannot uncommit the shared frame. The
		// onBufferWritten callback has already run; the return value propagates
		// terminal availability so callers can detect the detach.
		const cursorWritten = this.#writeCursorPosition(cursorPos, totalLines, true);
		return cursorWritten;
	}

	/**
	 * Write the hardware cursor position to the terminal as a standalone
	 * synchronized output block. Use when there is no surrounding render buffer
	 * to embed the sequences into.
	 */
	#writeCursorPosition(
		cursorPos: { row: number; col: number } | null,
		totalLines: number,
		deferRenderFailure = false,
	): boolean {
		if (!cursorPos || totalLines <= 0) {
			return deferRenderFailure
				? this.#guardTerminalOperation(() => this.terminal.hideCursor(), false)
				: this.#hideCursor();
		}
		const { seq, toRow } = this.#cursorControlSequence(cursorPos, totalLines, this.#hardwareCursorRow);
		// No \x1b[?2026h/l wrapper: synchronized output flushes terminal state and discards macOS IME composition.
		if (!this.#writeTerminal(seq, deferRenderFailure)) {
			return false;
		}
		this.#hardwareCursorRow = toRow;
		return true;
	}
}

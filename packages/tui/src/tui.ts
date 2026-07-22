/**
 * Minimal TUI implementation with differential rendering
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { $flag, getDebugLogPath, logger, onDefaultTabWidthChange } from "@gajae-code/utils";
import { getKeybindings } from "./keybindings";
import { isKeyRelease } from "./keys";
import { renderMetrics } from "./metrics";
import type { Terminal } from "./terminal";
import {
	ImageProtocol,
	isImageProtocolForced,
	isUnderTerminalMultiplexer,
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
 * diffing so `#previousLines` mirrors what was actually written.
 */
const LINE_TERMINATOR = "\x1b[0m\x1b]8;;\x07";

type InputListenerResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputListenerResult;

/**
 * Component interface - all components must implement this
 */
export type MouseEvent = {
	kind: "wheel" | "click";
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

/** Parse xterm SGR mouse reports. Drag and button-release reports are ignored. */
export function parseSgrMouseEvent(data: string): MouseEvent | undefined {
	const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
	if (!match) return undefined;
	const button = Number(match[1]);
	const x = Number(match[2]);
	const y = Number(match[3]);
	const terminator = match[4];
	if (![button, x, y].every(Number.isSafeInteger) || x < 1 || y < 1) return undefined;

	if (button & 32 || terminator === "m") return undefined;
	if (button === 64) return { kind: "wheel", direction: -1, x, y };
	if (button === 65) return { kind: "wheel", direction: 1, x, y };
	if (button === 0) return { kind: "click", button, x, y };
	return undefined;
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

function isTermuxSession(env: Record<string, string | undefined> = Bun.env): boolean {
	return Boolean(env.TERMUX_VERSION);
}

const DISABLED_ENV_VALUES = new Set(["0", "false", "off", "no"]);
const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "on", "y"]);

function envIsEnabled(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized !== undefined && normalized.length > 0 && !DISABLED_ENV_VALUES.has(normalized);
}

function envFlagEnabled(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized !== undefined && TRUTHY_ENV_VALUES.has(normalized);
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

function useLegacyMultiplexerFullRender(env: Record<string, string | undefined> = Bun.env): boolean {
	return envFlagEnabled(env.PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER);
}

function isViewportSensitiveHost(
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform,
	includeNativeWindows: boolean,
	includeProcessTerminal: boolean,
): boolean {
	return (
		isMultiplexerSession(env) ||
		isWindowsTerminalSession(env) ||
		includeProcessTerminal ||
		(includeNativeWindows && platform === "win32")
	);
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
	const multiplexed = isMultiplexerSession(env);
	const includeNativeWindows = options.includeNativeWindows ?? true;
	const includeProcessTerminal = options.includeProcessTerminal ?? false;
	return (
		isViewportSensitiveHost(env, platform, includeNativeWindows, includeProcessTerminal) &&
		!(multiplexed && useLegacyMultiplexerFullRender(env))
	);
}

function useViewportRepaintPath(terminal: Terminal): boolean {
	if (terminal.isProcessTerminal !== true) return false;
	return shouldUseViewportRepaintForHost(Bun.env, process.platform, {
		includeNativeWindows: true,
		includeProcessTerminal: true,
	});
}

function allowsHostNeutralOverflowRepaint(
	terminal: Terminal,
	env: Record<string, string | undefined> = Bun.env,
): boolean {
	return (
		terminal.isProcessTerminal === true &&
		!isTermuxSession(env) &&
		!(isMultiplexerSession(env) && useLegacyMultiplexerFullRender(env))
	);
}

function shouldPreserveScrollbackOnFullClear(terminal: Terminal): boolean {
	if (terminal.isProcessTerminal !== true) return false;
	return isViewportSensitiveHost(Bun.env, process.platform, true, true);
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
		return component.render(width);
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

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
export class TUI extends Container {
	terminal: Terminal;
	#previousLines: string[] = [];
	#latestRenderedLines: string[] = [];
	/**
	 * Raw (pre-normalization) lines from the previous frame, kept only when the
	 * virtual-viewport flag is on. Used to detect whether the off-screen prefix is
	 * unchanged (by raw value equality, with a fast reference short-circuit when components
	 * return stable string instances) so its normalized form can be reused (bounded normalize).
	 */
	#previousRaw: string[] = [];
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
	#renderTimer: NodeJS.Timeout | undefined;
	#lastRenderAt = 0;
	static readonly #MIN_RENDER_INTERVAL_MS = 16;
	// Input-priority scheduling: an input keystroke must never be starved behind a
	// pending normal (frame-budget) render timer. When set, an input-priority render
	// is queued for the next tick and supersedes any pending normal timer.
	#inputRenderPending = false;

	#cursorRow = 0; // Logical cursor row (end of rendered content)
	#hardwareCursorRow = 0; // Actual terminal cursor row (may differ due to IME positioning)
	#viewportTopRow = 0; // Content row currently mapped to screen row 0
	#manualViewportTop: number | undefined;
	#viewportAnchorComponent: Component | null = null;
	#viewportAnchorFrame: ViewportAnchorFrame | null = null;
	#manualViewportAnchor: ManualViewportAnchor | null = null;
	#manualViewportFallbackAnchors: ManualViewportAnchor[] = [];
	#reconcileMissingViewportAnchor = false;
	#lastCursorPosition: { row: number; col: number } | null = null;
	#sixelProbePendingDa = false;
	#sixelProbePendingGraphics = false;
	#sixelProbeBuffer = "";
	#sixelProbeTimeout?: NodeJS.Timeout;
	#sixelProbeUnsubscribe?: () => void;
	#showHardwareCursor = $flag("PI_HARDWARE_CURSOR");
	#debugRedraw = TUI.#readDebugRedrawFlag();
	// macOS: steady-block cursor anchors CJK IME overlays; disable with GJC_TUI_IME_CURSOR=0.
	readonly #useImeBlockCursor = $flag("GJC_TUI_IME_CURSOR", process.platform === "darwin");
	// showHardwareCursor=false but cursor is shown for IME anchoring (macOS).
	#imeCursorActive = false;
	#clearOnShrink = $flag("PI_CLEAR_ON_SHRINK"); // Clear empty rows when content shrinks (default: off)
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
		return $flag("PI_DEBUG_REDRAW");
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
		private readonly options: { enableMouse?: boolean } = {},
	) {
		super();
		this.terminal = terminal;
		if (showHardwareCursor !== undefined) {
			this.#showHardwareCursor = showHardwareCursor;
		}
		this.#imeCursorActive = !this.#showHardwareCursor && this.#useImeBlockCursor;
		this.#unsubscribeTabWidthChange = onDefaultTabWidthChange(() => {
			this.#lineTruncationCache.clear();
			this.#lineNormalizationCache.clear();
			this.#lineEmitWidthCache.clear();
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

	/**
	 * Set whether to trigger full re-render when content shrinks.
	 * When true (default), empty rows are cleared when content shrinks.
	 * When false, empty rows remain (reduces redraws on slower terminals).
	 */
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

	setBottomPinnedComponent(component: Component | null): void {
		this.#bottomPinnedComponent = component;
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

	/** Clear manual viewport ownership before replacing the transcript identity namespace. */
	resetViewportAnchorIntent(): void {
		this.#manualViewportTop = undefined;
		this.#manualViewportAnchor = null;
		this.#manualViewportFallbackAnchors = [];
		this.#reconcileMissingViewportAnchor = false;
		this.#viewportAnchorFrame = null;
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
		if (height <= 0 || width <= 0 || this.#previousLines.length === 0 || frame === null) return false;

		const selectedRow = frame.anchors.findIndex(anchor => anchor?.id === id);
		const selected = selectedRow < 0 ? null : frame.anchors[selectedRow];
		if (selected === null) return false;

		const desiredScreenRow = alignment === "top" ? 0 : alignment === "center" ? Math.floor(height / 2) : height - 1;
		const targetViewportTop = Math.max(0, frame.startRow + selectedRow - desiredScreenRow);
		this.#manualViewportAnchor = {
			id: selected.id,
			graphemeIndex: selected.graphemeStart,
			cellOffset: selected.cellStart,
			desiredScreenRow,
		};
		const firstCandidateRow = Math.max(0, targetViewportTop - frame.startRow);
		const lastCandidateRow = Math.min(frame.anchors.length, targetViewportTop + height - frame.startRow);
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

	scrollViewportPages(direction: -1 | 1): boolean {
		const height = this.terminal.rows;
		const width = this.terminal.columns;
		if (height <= 0 || width <= 0 || this.#previousLines.length === 0) return false;
		const maxViewportTop = Math.max(0, this.#previousLines.length - height);
		let currentViewportTop = Math.max(0, Math.min(maxViewportTop, this.#manualViewportTop ?? this.#viewportTopRow));
		const frame = this.#viewportAnchorFrame;
		if (this.#manualViewportAnchor !== null) {
			if (frame === null) return false;
			const resolvedViewportTop = this.#resolveManualAnchor(frame);
			if (resolvedViewportTop === null) return false;
			currentViewportTop = Math.max(0, Math.min(maxViewportTop, resolvedViewportTop));
		}
		const targetViewportTop = Math.max(
			0,
			Math.min(maxViewportTop, currentViewportTop + direction * Math.max(1, height - 1)),
		);
		if (frame !== null) {
			const desiredScreenRow = this.#manualViewportAnchor?.desiredScreenRow ?? (direction < 0 ? 0 : height - 1);
			const targetRow = targetViewportTop + desiredScreenRow - frame.startRow;
			let selected: { row: number; anchor: ViewportAnchorRow } | undefined;
			const firstCandidateRow = Math.max(0, targetViewportTop - frame.startRow);
			const lastCandidateRow = Math.min(frame.anchors.length, targetViewportTop + height - frame.startRow);
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
		return this.#repaintViewportFromLines(
			this.#previousLines,
			width,
			height,
			targetViewportTop,
			null,
			"manual viewport scroll",
			this.#manualViewportAnchor !== null,
		);
	}

	followLiveViewport(): boolean {
		if (this.#manualViewportTop === undefined) return false;
		const height = this.terminal.rows;
		const width = this.terminal.columns;
		const liveLines = this.#latestRenderedLines;
		const liveViewportTop = Math.max(0, liveLines.length - height);
		this.#manualViewportTop = undefined;
		this.#manualViewportAnchor = null;
		this.#manualViewportFallbackAnchors = [];
		this.#reconcileMissingViewportAnchor = false;
		const repainted = this.#repaintViewportFromLines(
			liveLines,
			width,
			height,
			liveViewportTop,
			this.#lastCursorPosition,
			"manual viewport follow live",
		);
		if (repainted) this.#previousLines = liveLines;
		return repainted;
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

	get terminalAvailable(): boolean {
		return !this.#terminalUnavailable && this.terminal.available;
	}

	#markTerminalUnavailable(): void {
		this.#terminalUnavailable = true;
		this.#stopped = true;
		this.#renderRequested = false;
		if (this.#renderTimer) {
			clearTimeout(this.#renderTimer);
			this.#renderTimer = undefined;
			if (renderMetrics.enabled) renderMetrics.setTimerGauge("tui.renderTimer", 0);
		}
		this.#clearSixelProbeState();
	}

	#writeTerminal(data: string): boolean {
		return this.#guardTerminalOperation(() => this.terminal.write(data));
	}

	#hideCursor(): boolean {
		return this.#guardTerminalOperation(() => this.terminal.hideCursor());
	}

	#showCursor(): boolean {
		return this.#guardTerminalOperation(() => this.terminal.showCursor());
	}

	#guardTerminalOperation(operation: () => void): boolean {
		if (!this.terminalAvailable) {
			this.#markTerminalUnavailable();
			return false;
		}
		try {
			operation();
		} catch {
			this.#markTerminalUnavailable();
			return false;
		}
		if (!this.terminal.available) {
			this.#markTerminalUnavailable();
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
		this.#clearSixelProbeState();
		this.#stopped = true;
		if (this.#renderTimer) {
			clearTimeout(this.#renderTimer);
			this.#renderTimer = undefined;
			if (renderMetrics.enabled) renderMetrics.setTimerGauge("tui.renderTimer", 0);
		}
		// Move cursor to the end of the content to prevent overwriting/artifacts on exit
		if (this.#previousLines.length > 0) {
			const targetRow = this.#previousLines.length; // Line after the last content
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
		// Teardown: release the retained rendered transcript so a stopped TUI does
		// not pin a flat copy of every emitted line for the process lifetime.
		// Safe across temporary stop/start (Ctrl-Z resume, external editor): start()
		// issues a forced render that rebuilds this state and fully redraws, and
		// focus/listener state is intentionally preserved so input routing survives
		// a resume.
		this.#previousLines = [];
		this.#latestRenderedLines = [];
		this.#previousRaw = [];
		this.#lineNormalizationCache.clear();
		this.#lineTruncationCache.clear();
		this.#lineEmitWidthCache.clear();
		this.#previousWidth = 0;
		this.#previousHeight = 0;
	}

	/**
	 * Viewport-repaint-aware resize render request.
	 *
	 * A forced full redraw (`requestRender(true)`) resets `#previousWidth`/`#previousHeight`
	 * to -1, which makes `#doRender` treat the frame as a width change and fall into the
	 * `fullRender` path. In terminal multiplexers that path skips the scrollback-clearing
	 * `3J` escape (users navigate scrollback history), so replaying every transcript line
	 * piles it back on top of scrollback — the "top of screen scrolls down to the prompt at
	 * high speed" resize storm. Windows Terminal/ConPTY can also visibly jump to
	 * the transcript top during streaming redraws, so viewport-repaint sessions
	 * keep force off and let `#doRender` repaint only the live viewport. Set
	 * `PI_TUI_LEGACY_MULTIPLEXER_FULL_RENDER=1` to restore the legacy tmux redraw.
	 *
	 * Spurious resize events (SIGWINCH with unchanged dimensions — iTerm2 tab
	 * switches and window focus changes, the self-sent SIGWINCH after resume)
	 * must not force either: on hosts still using the `fullRender` path (legacy
	 * multiplexer opt-in, non-process terminals) the forced redraw clears
	 * scrollback (`2J`/`H`/`3J`) and replays the whole transcript, which can
	 * park the native viewport at the transcript top. Only force when the grid
	 * size actually changed since the last committed frame; a plain diff render
	 * is a no-op otherwise.
	 */
	requestResizeRender(): void {
		const dimensionsChanged =
			this.#previousWidth !== this.terminal.columns || this.#previousHeight !== this.terminal.rows;
		this.requestRender(dimensionsChanged && !useViewportRepaintPath(this.terminal), "resize");
	}

	requestRender(force = false, source = "unknown"): void {
		if (!this.terminalAvailable) {
			this.#markTerminalUnavailable();
			return;
		}
		if (renderMetrics.enabled) renderMetrics.recordRequest(source);
		if (force) {
			const preserveViewportCursor = useViewportRepaintPath(this.terminal);
			// A forced full redraw supersedes any queued input-priority render.
			this.#inputRenderPending = false;
			this.#previousLines = [];
			this.#latestRenderedLines = [];
			this.#previousRaw = [];
			this.#lineNormalizationCache.clear();
			this.#lineTruncationCache.clear();
			this.#lineEmitWidthCache.clear();
			this.#previousWidth = -1; // -1 triggers widthChanged, forcing a full clear
			this.#previousHeight = -1; // -1 triggers heightChanged, forcing a full clear
			this.#lineNormalizationCacheLimit = 0;
			this.#lineTruncationCacheLimit = 0;
			if (!preserveViewportCursor) {
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
					return;
				}
				this.#renderRequested = false;
				this.#lastRenderAt = performance.now();
				const t0 = renderMetrics.now();
				this.#doRender();
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
			this.#renderRequested = false;
			this.#lastRenderAt = performance.now();
			const t0 = renderMetrics.now();
			this.#doRender();
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
		this.#renderRequested = false;
		this.#lastRenderAt = performance.now();
		const t0 = renderMetrics.now();
		this.#doRender();
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
			if (mouse.kind === "wheel") this.scrollViewportPages(mouse.direction!);
			else {
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
	#compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
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
				const col = visibleWidth(beforeMarker);

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
				this.#lineEmitWidthCache.set(cached, width);
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
			this.#lineEmitWidthCache.set(terminated, width);
			lines[lineIndex] = terminated;
		}

		return lines;
	}

	#applyLineResetsAndTruncate(lines: string[], width: number): string[] {
		this.#normalizeLinesForEmit(lines, width);
		this.#trimLineCachesForRender(lines.length);
		return lines;
	}

	#padBeforeBottomPinnedComponent(
		lines: string[],
		height: number,
		renderedChildren: Map<Component, string[]>,
	): string[] {
		const component = this.#bottomPinnedComponent;
		if (component === null || lines.length >= height) return lines;

		let pinnedStart = -1;
		for (let i = this.children.length - 1; i >= 0; i--) {
			if (this.children[i] === component) {
				pinnedStart = i;
				break;
			}
		}
		if (pinnedStart < 0) return lines;

		let pinnedLineCount = 0;
		for (let i = pinnedStart; i < this.children.length; i++) {
			pinnedLineCount += (renderedChildren.get(this.children[i]) ?? []).length;
		}

		const blankRows = height - lines.length;
		const insertAt = Math.max(0, lines.length - pinnedLineCount);
		const padded = [...lines];
		padded.splice(insertAt, 0, ...Array.from({ length: blankRows }, () => ""));
		return padded;
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
	): boolean {
		if (height <= 0 || width <= 0) return false;
		const maxViewportTop = Math.max(0, lines.length - (allowPastLiveBottom ? 1 : height));
		const nextViewportTop = Math.max(0, Math.min(maxViewportTop, viewportTop));
		const currentScreenRow = Math.max(0, Math.min(height - 1, this.#hardwareCursorRow - this.#viewportTopRow));
		let buffer = "\x1b[?2026h";
		if (currentScreenRow > 0) {
			buffer += `\x1b[${currentScreenRow}A`;
		}
		buffer += "\r";

		for (let screenRow = 0; screenRow < height; screenRow++) {
			if (screenRow > 0) buffer += "\r\n";
			buffer += "\x1b[2K";
			const lineIndex = nextViewportTop + screenRow;
			if (lineIndex >= lines.length) continue;
			const line = lines[lineIndex];
			const isImage = TERMINAL.isImageLine(line);
			if (!isImage && this.#visibleWidthForDifferentialGuard(line) > width) {
				let truncatedLine = truncateToWidth(line, width, Ellipsis.Omit);
				truncatedLine += truncatedLine.includes("\x1b]8;") ? LINE_TERMINATOR : SEGMENT_RESET;
				buffer += truncatedLine;
			} else {
				buffer += line;
			}
		}

		const finalPhysicalRow = nextViewportTop + Math.max(0, height - 1);
		let cursorSeq = "\x1b[?25l";
		let cursorToRow = finalPhysicalRow;
		if (cursorPos && cursorPos.row >= nextViewportTop && cursorPos.row < nextViewportTop + height) {
			const cursor = this.#cursorControlSequence(cursorPos, lines.length, finalPhysicalRow);
			cursorSeq = cursor.seq;
			cursorToRow = cursor.toRow;
		}
		this.#hardwareCursorRow = cursorToRow;
		buffer += cursorSeq;
		buffer += "\x1b[?2026l";
		if (!this.#writeRenderBufferAndReanchorImeCursor(buffer, cursorPos, lines.length)) return false;

		if (this.#debugRedraw) {
			const msg = `[${new Date().toISOString()}] viewportRepaint: ${reason} (lines=${lines.length}, height=${height}, viewportTop=${nextViewportTop})\n`;
			this.#appendDebugRedrawLog(msg);
		}

		this.#cursorRow = Math.max(0, lines.length - 1);
		this.#maxLinesRendered = lines.length;
		this.#viewportTopRow = nextViewportTop;
		return true;
	}

	#doRender(): void {
		if (this.#stopped || !this.terminalAvailable) return;
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

		// Render direct children once so the registered transcript component retains row ownership.
		const renderTreeStart = renderMetrics.now();
		const renderedLines: string[] = [];
		const renderedChildren = new Map<Component, string[]>();
		let anchorFrame: ViewportAnchorFrame | null = null;
		const anchorRenderFailureCountBefore = viewportAnchorRenderFailureCount;
		for (const child of this.children) {
			const rendered = safeRenderComponentWithViewportAnchors(child, width, "tui-child");
			renderedChildren.set(child, rendered.lines);
			if (child === this.#viewportAnchorComponent && rendered.anchors.some(anchor => anchor !== null)) {
				anchorFrame = { startRow: renderedLines.length, anchors: rendered.anchors };
			}
			for (const line of rendered.lines) renderedLines.push(line);
		}
		const anchorRenderFailed = viewportAnchorRenderFailureCount !== anchorRenderFailureCountBefore;
		let newLines = renderedLines;
		this.#viewportAnchorFrame = anchorFrame;
		if (renderMetrics.enabled) renderMetrics.recordHelper("renderTree", renderMetrics.now() - renderTreeStart);

		if (this.#bottomPinnedComponent !== null && height > 0) {
			newLines = this.#padBeforeBottomPinnedComponent(newLines, height, renderedChildren);
		}

		// Composite overlays into the rendered lines (before differential compare)
		if (this.overlayStack.length > 0) {
			newLines = this.#compositeOverlays(newLines, width, height);
		}

		// Extract cursor position (marker must be found before diff comparison)
		const cursorPos = this.#extractCursorPosition(newLines, height);
		this.#lastCursorPosition = cursorPos;

		// Terminate every non-image line so #previousLines mirrors emitted bytes
		// (closes SGR + OSC 8 hyperlink state). Must run after cursor extraction
		// because the marker is embedded mid-line, and before any diff/full render
		// path so cache comparisons stay byte-accurate.
		// Width/height change detection (used for both normalization reuse and full-redraw decisions).
		const widthChanged = this.#previousWidth !== 0 && this.#previousWidth !== width;
		const heightChanged = this.#previousHeight !== 0 && this.#previousHeight !== height;

		// Normalize/truncate lines for emission. With the opt-in virtual-viewport flag
		// (PI_TUI_VIRTUAL_VIEWPORT) we reuse the previous frame's normalized prefix when the
		// off-screen raw prefix is unchanged (raw value equality per line; fast reference
		// short-circuit for cached components), so only the visible window is
		// re-normalized and the diff starts at the window. Output is byte-identical to the
		// full path (reused entries are deterministic normalizations of identical raw lines).
		const VIEWPORT_NORMALIZE_OVERSCAN = 8;
		const rawLines = newLines;
		const total = rawLines.length;
		let diffStart = 0;
		let usedWindowNormalize = false;
		if (
			this.#virtualViewport &&
			!widthChanged &&
			this.#previousRaw.length > 0 &&
			this.#previousLines.length === this.#previousRaw.length
		) {
			const winTop = Math.max(0, total - height - VIEWPORT_NORMALIZE_OVERSCAN);
			if (winTop <= this.#previousLines.length && winTop <= this.#previousRaw.length) {
				let stable = true;
				for (let i = 0; i < winTop; i++) {
					if (rawLines[i] !== this.#previousRaw[i]) {
						stable = false;
						break;
					}
				}
				if (stable) {
					const windowed = this.#previousLines.slice(0, winTop);
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
			newLines = this.#applyLineResetsAndTruncate(this.#virtualViewport ? rawLines.slice() : rawLines, width);
		}
		if (this.#virtualViewport) {
			this.#previousRaw = rawLines;
		}
		if (renderMetrics.enabled) {
			renderMetrics.recordLineCount("rendered", total);
			renderMetrics.recordLineCount("normalized", total - diffStart);
			renderMetrics.recordLineCount("measured", total - diffStart);
			if (usedWindowNormalize) renderMetrics.recordLineCount("offscreenScan", diffStart);
		}
		this.#latestRenderedLines = newLines;

		if (this.#manualViewportTop !== undefined) {
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
					this.#repaintViewportFromLines(
						newLines,
						width,
						height,
						this.#manualViewportTop,
						null,
						"failed semantic viewport render",
						true,
					);
					this.#previousLines = newLines;
					this.#previousWidth = width;
					this.#previousHeight = height;
					return;
				}
				// A formerly valid semantic target is temporarily absent (provider removal,
				// replacement, eviction, or object deletion). Keep the last resolved frame
				// instead of silently reinterpreting manual intent as a numeric viewport.
				const retainedLines = this.#previousLines.length > 0 ? this.#previousLines : newLines;
				this.#repaintViewportFromLines(
					retainedLines,
					width,
					height,
					this.#manualViewportTop,
					null,
					"unresolved semantic viewport render",
					true,
				);
				this.#previousWidth = width;
				this.#previousHeight = height;
				return;
			}
			const nextViewportTop = resolvedAnchorTop ?? this.#manualViewportTop;
			if (
				this.#previousWidth === width &&
				this.#previousHeight === height &&
				nextViewportTop === this.#manualViewportTop &&
				newLines.length === this.#previousLines.length &&
				newLines.every((line, index) => line === this.#previousLines[index])
			) {
				return;
			}
			this.#manualViewportTop = nextViewportTop;
			this.#reconcileMissingViewportAnchor = false;
			if (
				this.#repaintViewportFromLines(
					newLines,
					width,
					height,
					nextViewportTop,
					null,
					"manual viewport render",
					this.#manualViewportAnchor !== null,
				)
			) {
				this.#previousLines = newLines;
				this.#previousWidth = width;
				this.#previousHeight = height;
			}
			return;
		}
		// Helper to clear scrollback and viewport and render all new lines
		const fullRender = (clear: boolean, reason = "full render"): void => {
			this.#fullRedrawCount += 1;
			if (renderMetrics.enabled) renderMetrics.recordFullRedraw(reason);
			let buffer = "\x1b[?2026h"; // Begin synchronized output
			// Skip clearing scrollback (3J) in hosts where clear/replay can snap the
			// native viewport away from the live prompt (tmux/screen, Windows ConPTY).
			if (clear)
				buffer += shouldPreserveScrollbackOnFullClear(this.terminal) ? "\x1b[2J\x1b[H" : "\x1b[2J\x1b[H\x1b[3J";
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				// Lines were pre-terminated/normalized by #applyLineResets; image
				// lines were left untouched there.
				buffer += newLines[i];
			}
			this.#cursorRow = Math.max(0, newLines.length - 1);
			const { seq, toRow } = this.#cursorControlSequence(cursorPos, newLines.length, this.#cursorRow);
			this.#hardwareCursorRow = toRow;
			buffer += seq;
			buffer += "\x1b[?2026l"; // End synchronized output
			if (!this.#writeRenderBufferAndReanchorImeCursor(buffer, cursorPos, newLines.length)) return;
			// Reset max lines when clearing, otherwise track growth
			if (clear) {
				this.#maxLinesRendered = newLines.length;
			} else {
				this.#maxLinesRendered = Math.max(this.#maxLinesRendered, newLines.length);
			}
			this.#viewportTopRow = Math.max(0, this.#maxLinesRendered - height);
			this.#previousLines = newLines;
			this.#previousWidth = width;
			this.#previousHeight = height;
		};

		const viewportRepaint = (reason: string): void => {
			this.#fullRedrawCount += 1;
			if (renderMetrics.enabled) renderMetrics.recordFullRedraw(reason);
			const nextViewportTop = Math.max(0, newLines.length - height);
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			let buffer = "\x1b[?2026h";
			if (currentScreenRow > 0) {
				buffer += `\x1b[${currentScreenRow}A`;
			}
			buffer += "\r";
			for (let screenRow = 0; screenRow < height; screenRow++) {
				if (screenRow > 0) buffer += "\r\n";
				buffer += "\x1b[2K";
				const lineIndex = nextViewportTop + screenRow;
				if (lineIndex >= newLines.length) continue;
				const line = newLines[lineIndex];
				const isImage = TERMINAL.isImageLine(line);
				if (!isImage && this.#visibleWidthForDifferentialGuard(line) > width) {
					let truncatedLine = truncateToWidth(line, width, Ellipsis.Omit);
					truncatedLine += truncatedLine.includes("\x1b]8;") ? LINE_TERMINATOR : SEGMENT_RESET;
					buffer += truncatedLine;
				} else {
					buffer += line;
				}
			}

			const finalPhysicalRow = nextViewportTop + Math.max(0, height - 1);
			let cursorSeq = "\x1b[?25l";
			let cursorToRow = finalPhysicalRow;
			if (cursorPos && cursorPos.row >= nextViewportTop && cursorPos.row < nextViewportTop + height) {
				const cursor = this.#cursorControlSequence(cursorPos, newLines.length, finalPhysicalRow);
				cursorSeq = cursor.seq;
				cursorToRow = cursor.toRow;
			}
			this.#hardwareCursorRow = cursorToRow;
			buffer += cursorSeq;
			buffer += "\x1b[?2026l";
			if (!this.#writeRenderBufferAndReanchorImeCursor(buffer, cursorPos, newLines.length)) return;

			if (this.#debugRedraw) {
				const msg = `[${new Date().toISOString()}] viewportRepaint: ${reason} (prev=${this.#previousLines.length}, new=${newLines.length}, height=${height}, viewportTop=${nextViewportTop})\n`;
				this.#appendDebugRedrawLog(msg);
			}
			// Viewport repaint deliberately prioritizes the live viewport over
			// historical scrollback repair. After offscreen changes, #previousLines
			// tracks the desired logical transcript, not every byte emitted into the
			// terminal scrollback.
			this.#cursorRow = Math.max(0, newLines.length - 1);
			this.#maxLinesRendered = newLines.length;
			this.#viewportTopRow = nextViewportTop;
			this.#previousLines = newLines;
			this.#previousWidth = width;
			this.#previousHeight = height;
		};

		const debugRedraw = this.#debugRedraw;
		const logRedraw = (reason: string): void => {
			if (!debugRedraw) return;
			const msg = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${this.#previousLines.length}, new=${newLines.length}, height=${height})\n`;
			this.#appendDebugRedrawLog(msg);
		};

		// First render - just output everything without clearing (assumes clean screen)
		if (this.#previousLines.length === 0 && !widthChanged && !heightChanged) {
			logRedraw("first render");
			fullRender(false, "first render");
			return;
		}

		// Width changes always need a full re-render because wrapping changes.
		if (widthChanged) {
			logRedraw(`terminal width changed (${this.#previousWidth} -> ${width})`);
			if (useViewportRepaintPath(this.terminal)) {
				// In viewport-repaint sessions a full replay can either pile the transcript
				// back onto scrollback (tmux/screen) or visibly jump to the transcript top
				// (Windows Terminal). Repaint the viewport only, mirroring the height-change
				// branch and neutralizing fake width changes from requestRender(true).
				viewportRepaint(`terminal width changed (${this.#previousWidth} -> ${width})`);
			} else {
				fullRender(true, "terminal width changed");
			}
			return;
		}

		// Height changes normally need a full re-render to keep the visible viewport aligned,
		// but Termux changes height when the software keyboard shows or hides.
		// In that environment, a full redraw causes the entire history to replay on every toggle.
		if (heightChanged) {
			if (useViewportRepaintPath(this.terminal)) {
				viewportRepaint(`terminal height changed (${this.#previousHeight} -> ${height})`);
				return;
			}
			logRedraw(`terminal height changed (${this.#previousHeight} -> ${height})`);
			fullRender(true, "terminal height changed");
			return;
		}

		// Content shrunk below the previous render and no overlays - re-render to clear empty rows
		// (overlays need the padding, so only do this when no overlays are active)
		// Configurable via setClearOnShrink() or PI_CLEAR_ON_SHRINK=0 env var
		if (this.#clearOnShrink && newLines.length < this.#previousLines.length && this.overlayStack.length === 0) {
			logRedraw(`clearOnShrink (prev=${this.#previousLines.length}, new=${newLines.length})`);
			if (
				useViewportRepaintPath(this.terminal) ||
				((this.#previousLines.length > height || newLines.length > height) &&
					allowsHostNeutralOverflowRepaint(this.terminal))
			) {
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
		const appendedLines = newLines.length > this.#previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) {
				firstChanged = this.#previousLines.length;
			}
			lastChanged = newLines.length - 1;
		}
		const appendStart = appendedLines && firstChanged === this.#previousLines.length && firstChanged > 0;

		// No changes - but still need to update hardware cursor position if it moved
		if (firstChanged === -1) {
			this.#writeCursorPosition(cursorPos, newLines.length);
			this.#viewportTopRow = Math.max(0, this.#maxLinesRendered - height);
			return;
		}

		const nextLiveViewportTop = Math.max(0, newLines.length - height);
		if (newLines.length < this.#previousLines.length && nextLiveViewportTop !== prevViewportTop) {
			viewportRepaint(`content contraction changed viewport top (${prevViewportTop} -> ${nextLiveViewportTop})`);
			return;
		}
		// All changes are in deleted lines (nothing to render, just clear)
		if (firstChanged >= newLines.length) {
			if (this.#previousLines.length > newLines.length) {
				let buffer = "\x1b[?2026h";
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
					if (useViewportRepaintPath(this.terminal)) {
						viewportRepaint(`extraLines > height (${extraLines} > ${height})`);
					} else {
						fullRender(true, "extraLines > height");
					}
					return;
				}
				const clearStartOffset = newLines.length > 0 && extraLines > 0 ? 1 : 0;
				if (clearStartOffset > 0) {
					buffer += `\x1b[${clearStartOffset}B`;
				}
				for (let i = 0; i < extraLines; i++) {
					buffer += "\r\x1b[2K";
					if (i < extraLines - 1) buffer += "\x1b[1B";
				}
				const moveUp = extraLines - 1 + clearStartOffset;
				if (moveUp > 0) {
					buffer += `\x1b[${moveUp}A`;
				}
				this.#cursorRow = targetRow;
				const { seq, toRow } = this.#cursorControlSequence(cursorPos, newLines.length, targetRow);
				this.#hardwareCursorRow = toRow;
				buffer += seq;
				buffer += "\x1b[?2026l";
				if (!this.#writeRenderBufferAndReanchorImeCursor(buffer, cursorPos, newLines.length)) return;
			}
			this.#previousLines = newLines;
			this.#previousWidth = width;
			this.#previousHeight = height;
			this.#maxLinesRendered = newLines.length;
			this.#viewportTopRow = Math.max(0, newLines.length - height);
			return;
		}

		// Differential rendering can only touch what was actually visible. If a
		// streaming status/header line changes above a live-following viewport, keep
		// the terminal pinned by diffing from the visible top instead of clearing and
		// replaying the transcript. If the user paged away, keep the historical
		// full-redraw behavior so scrollback is repaired rather than snapping them
		// back to live.
		if (firstChanged < prevViewportTop) {
			logRedraw(`firstChanged < viewportTop (${firstChanged} < ${prevViewportTop})`);
			if (
				useViewportRepaintPath(this.terminal) ||
				(newLines.length <= this.#previousLines.length &&
					(this.#previousLines.length > height || newLines.length > height) &&
					allowsHostNeutralOverflowRepaint(this.terminal))
			) {
				viewportRepaint(`firstChanged < viewportTop (${firstChanged} < ${prevViewportTop})`);
				return;
			}
			fullRender(true, "firstChanged < viewportTop");
			return;
		}

		// Render from first changed line to end
		// Build buffer with all updates wrapped in synchronized output
		let buffer = "\x1b[?2026h"; // Begin synchronized output
		const prevViewportBottom = prevViewportTop + height - 1;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) {
				buffer += `\x1b[${moveToBottom}B`;
			}
			const scroll = moveTargetRow - prevViewportBottom;
			buffer += "\r\n".repeat(scroll);
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
			buffer += "\x1b[2K"; // Clear current line
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
			buffer += truncatedLine;
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
				buffer += "\r\n\x1b[2K";
			}
			// Move cursor back to end of new content
			buffer += `\x1b[${extraLines}A`;
		}

		const { seq, toRow } = this.#cursorControlSequence(cursorPos, newLines.length, finalCursorRow);
		this.#hardwareCursorRow = toRow;
		buffer += seq;
		buffer += "\x1b[?2026l"; // End synchronized output

		if ($flag("PI_TUI_DEBUG")) {
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
				`previousLines.length: ${this.#previousLines.length}`,
				"",
				"=== newLines ===",
				JSON.stringify(newLines, null, 2),
				"",
				"=== previousLines ===",
				JSON.stringify(this.#previousLines, null, 2),
				"",
				"=== buffer ===",
				JSON.stringify(buffer),
			].join("\n");
			fs.writeFileSync(debugPath, debugData);
		}

		// Write entire buffer at once
		if (!this.#writeRenderBufferAndReanchorImeCursor(buffer, cursorPos, newLines.length)) return;

		// Track cursor position for next render.
		// cursorRow tracks end of content (for viewport calculation).
		// #hardwareCursorRow was already updated by #cursorControlSequence above.
		this.#cursorRow = Math.max(0, newLines.length - 1);
		// Track content height for viewport calculation
		this.#maxLinesRendered = newLines.length;
		this.#viewportTopRow = Math.max(0, newLines.length - height);

		this.#previousLines = newLines;
		this.#previousWidth = width;
		this.#previousHeight = height;
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
	 * Register an emitter whose escape payload is appended to every render
	 * write (inside its own synchronized-output block, cursor saved/restored).
	 * Used for absolute-positioned overlays such as pixel-image pets that live
	 * outside the line-based component model. Return null to emit nothing.
	 */
	setPostRenderEmitter(emitter: (() => string | null) | undefined): void {
		this.#postRenderEmitter = emitter;
	}

	#postRenderEmitter: (() => string | null) | undefined;

	#writeRenderBufferAndReanchorImeCursor(
		buffer: string,
		cursorPos: { row: number; col: number } | null,
		totalLines: number,
	): boolean {
		const overlay = this.#postRenderEmitter?.();
		if (overlay) {
			// DECSC/DECRC keep the hardware cursor stable; the dedicated
			// synchronized block prevents visible tearing while the overlay
			// area is cleared and redrawn.
			buffer += `\x1b[?2026h\x1b7${overlay}\x1b8\x1b[?2026l`;
		}
		if (!this.#writeTerminal(buffer)) return false;
		if (!this.#imeCursorActive) return true;
		return this.#writeCursorPosition(cursorPos, totalLines);
	}

	/**
	 * Write the hardware cursor position to the terminal as a standalone
	 * synchronized output block. Use when there is no surrounding render buffer
	 * to embed the sequences into.
	 */
	#writeCursorPosition(cursorPos: { row: number; col: number } | null, totalLines: number): boolean {
		if (!cursorPos || totalLines <= 0) {
			return this.#hideCursor();
		}
		const { seq, toRow } = this.#cursorControlSequence(cursorPos, totalLines, this.#hardwareCursorRow);
		this.#hardwareCursorRow = toRow;
		// No \x1b[?2026h/l wrapper: synchronized output flushes terminal state and discards macOS IME composition.
		return this.#writeTerminal(seq);
	}
}

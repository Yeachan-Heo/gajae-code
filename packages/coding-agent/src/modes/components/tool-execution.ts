import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { type AgentTool, isToolFailureEnvelope } from "@gajae-code/agent-core";
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
	Markdown,
	registerAnimationCallback,
	Spacer,
	TERMINAL,
	Text,
	type TUI,
} from "@gajae-code/tui";
import { getProjectDir, logger, sanitizeText } from "@gajae-code/utils";
import { EDIT_MODE_STRATEGIES, type EditMode, type PerFileDiffPreview } from "../../edit";
import { type EditRenderContext, getPerFileEditRenderArgs, getPerFileEditRenderContext } from "../../edit/renderer";
import { getEditRequestTargetInventory, orderedDistinctPaths } from "../../edit/streaming";
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
import {
	containsSixelSequence,
	getSixelLineMask,
	isSixelPassthroughEnabled,
	sanitizeWithOptionalSixelPassthrough,
} from "../../utils/sixel";
import { renderDiff } from "./diff";

const SGR_FINAL = 0x6d;

function isPaintHex(code: number): boolean {
	return (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66);
}

function isFileOscParam(params: string): boolean {
	if (params.length !== 11 || !params.startsWith("id=")) return false;
	for (let i = 3; i < 11; i++) if (!isPaintHex(params.charCodeAt(i))) return false;
	return true;
}

const FILE_URI_MARK = "!&'()*+,-./:=?_%~";

function isFileOscUri(uri: string): boolean {
	if (!uri.startsWith("file://")) return false;
	for (let i = 0; i < uri.length; i++) {
		const code = uri.charCodeAt(i);
		const alphaNum =
			(code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
		if (!alphaNum && !FILE_URI_MARK.includes(uri[i]!)) return false;
	}
	return true;
}

/** Renderer file hyperlinks only. Title, clipboard, and other OSC bodies are not kept. */
function isSafeFileOsc8(body: string): boolean {
	if (body.length < 2 || body.charCodeAt(0) !== 0x38 || body.charCodeAt(1) !== 0x3b) return false;
	const semi = body.indexOf(";", 2);
	if (semi < 0) return false;
	const params = body.slice(2, semi);
	const uri = body.slice(semi + 1);
	if (params !== "" && !isFileOscParam(params)) return false;
	return uri === "" || isFileOscUri(uri);
}

function isDroppedPaintControl(code: number): boolean {
	if (code === 0x09 || code === 0x0a) return false;
	return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

type PaintSpan = { next: number; keep: boolean };

function consumeCsi(line: string, index: number): PaintSpan {
	let cursor = index;
	while (cursor < line.length) {
		const code = line.charCodeAt(cursor);
		if (code >= 0x40 && code <= 0x7e) return { next: cursor + 1, keep: code === SGR_FINAL };
		const isParam = (code >= 0x30 && code <= 0x3f) || (code >= 0x20 && code <= 0x2f);
		if (!isParam) return { next: cursor, keep: false };
		cursor++;
	}
	return { next: line.length, keep: false };
}

function isSixelDcs(line: string, start: number, end: number): boolean {
	if (TERMINAL.imageProtocol !== ImageProtocol.Sixel) return false;
	let cursor = start + 2;
	while (cursor < end && "0123456789;".includes(line[cursor] ?? "")) cursor++;
	if (line.charCodeAt(cursor) !== 0x71) return false;
	for (cursor++; cursor < end; cursor++) {
		const code = line.charCodeAt(cursor);
		if (code !== 0x09 && (code < 0x20 || code > 0x7e)) return false;
	}
	return cursor === end;
}

function consumeStringTerm(line: string, index: number, keep: (end: number) => boolean, keepBel: boolean): PaintSpan {
	let cursor = index;
	while (cursor < line.length) {
		const code = line.charCodeAt(cursor);
		if (code === 0x07) return { next: cursor + 1, keep: keepBel && keep(cursor) };
		if (code === 0x1b) {
			if (line.charCodeAt(cursor + 1) === 0x5c) return { next: cursor + 2, keep: keep(cursor) };
			return { next: cursor, keep: false };
		}
		cursor++;
	}
	return { next: line.length, keep: false };
}

function consumeEscape(line: string, start: number): PaintSpan {
	if (start + 1 >= line.length) return { next: line.length, keep: false };
	const kind = line.charCodeAt(start + 1);
	if (kind === 0x5b) return consumeCsi(line, start + 2);
	if (kind === 0x5d)
		return consumeStringTerm(line, start + 2, end => isSafeFileOsc8(line.slice(start + 2, end)), true);
	if (kind === 0x50 || kind === 0x5e || kind === 0x5f) {
		return consumeStringTerm(line, start + 2, end => kind === 0x50 && isSixelDcs(line, start, end), false);
	}
	return { next: Math.min(line.length, start + 2), keep: false };
}

/**
 * Drop terminal controls from one painted tool line.
 * SGR color and a renderer file hyperlink stay. The child render already
 * chose the edit operation from the original path.
 */
export function sanitizePaintedToolLine(line: string): string {
	let needs = false;
	for (let i = 0; i < line.length; i++) {
		const code = line.charCodeAt(i);
		if (code === 0x1b || code === 0x9b || isDroppedPaintControl(code)) {
			needs = true;
			break;
		}
	}
	if (!needs) return line;
	let out = "";
	for (let i = 0; i < line.length; ) {
		const code = line.charCodeAt(i);
		if (code === 0x1b || code === 0x9b) {
			const span = code === 0x1b ? consumeEscape(line, i) : consumeCsi(line, i + 1);
			if (span.next <= i) {
				i++;
				continue;
			}
			if (span.keep) out += line.slice(i, span.next);
			i = span.next;
			continue;
		}
		if (!isDroppedPaintControl(code)) out += line[i];
		i++;
	}
	return out.length === line.length ? line : out;
}

function filterPaintedLines(lines: string[], sixel: boolean): string[] {
	if (!sixel || !isSixelPassthroughEnabled()) return lines.map(sanitizePaintedToolLine);
	const text = lines.join("\n");
	let out = "";
	let i = 0;
	while (i < text.length) {
		const at = text.indexOf("\x1bP", i);
		out += text
			.slice(i, at < 0 ? text.length : at)
			.split("\n")
			.map(sanitizePaintedToolLine)
			.join("\n");
		if (at < 0) break;
		const mark = takePaintedSixel(text, at);
		if (mark > 0) out += text.slice(at, mark);
		else if (mark === -2) out += text.slice(at).split("\n").map(sanitizePaintedToolLine).join("\n");
		if (mark === -1 || mark === -2) break;
		i = mark > 0 ? mark : -mark;
	}
	return out.split("\n");
}

function takePaintedSixel(text: string, at: number): number {
	let i = at + 2;
	while (i < text.length && "0123456789;".includes(text[i] ?? "")) i++;
	if (text.charCodeAt(i) !== 0x71) return -2;
	let ok = true;
	for (i++; i < text.length; i++) {
		const code = text.charCodeAt(i);
		const end = code === 0x07 ? i + 1 : code === 0x1b && text.charCodeAt(i + 1) === 0x5c ? i + 2 : 0;
		if (end) return ok ? end : -end;
		if (code !== 0x09 && code !== 0x0a && code !== 0x0d && (code < 0x20 || code > 0x7e)) ok = false;
	}
	return -1;
}

// Keyed mac beside each Image/Markdown line. A shared line budget dropped copy
// markers once a card grew past it; the mac travels with the row instead.
const PAINT_PREFIX = "\x1b_AGJC_PAINT:";
const MAC_HEX = 32;
const TRUST_KEY = randomBytes(32);
const paintedWrap = new WeakMap<object, Component>();
let paintArmed = false;
let trustDepth = 0;

function trustMac(payload: string): string {
	return createHmac("sha256", TRUST_KEY).update(payload).digest("hex").slice(0, MAC_HEX);
}

function stampLine(line: string): string {
	return `${PAINT_PREFIX}${trustMac(line)}:${line.length}\x1b\\${line}`;
}

function isHexMac(mac: string): boolean {
	if (mac.length !== MAC_HEX) return false;
	for (let i = 0; i < mac.length; i++) {
		const code = mac.charCodeAt(i);
		const hex = (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66);
		if (!hex) return false;
	}
	return true;
}

function macMatches(mac: string, payload: string): boolean {
	if (!isHexMac(mac)) return false;
	const expect = trustMac(payload);
	const left = Buffer.from(mac);
	const right = Buffer.from(expect);
	if (left.length !== right.length) return false;
	try {
		return timingSafeEqual(left, right);
	} catch {
		return false;
	}
}

function armTrustedPaint(): void {
	if (paintArmed) return;
	paintArmed = true;
	let rendererDepth = 0;
	for (const Ctor of [Image, Markdown]) {
		const proto = Ctor.prototype as { render: (width: number) => string[] };
		const render = proto.render;
		proto.render = function (this: Component, width: number) {
			rendererDepth++;
			try {
				const lines = render.call(this, width);
				if (rendererDepth !== 1 || trustDepth === 0) return lines;
				const stamped = new Array<string>(lines.length);
				for (let i = 0; i < lines.length; i++) stamped[i] = stampLine(lines[i] ?? "");
				return stamped;
			} finally {
				rendererDepth--;
			}
		};
	}
}

function isSgrSpan(line: string, start: number): number {
	const code = line.charCodeAt(start);
	const eight = code === 0x9b;
	if (!eight && !(code === 0x1b && line.charCodeAt(start + 1) === 0x5b)) return -1;
	let cursor = eight ? start + 1 : start + 2;
	while (cursor < line.length) {
		const param = line.charCodeAt(cursor);
		if (param >= 0x40 && param <= 0x7e) return param === 0x6d ? cursor + 1 : -1;
		if (!((param >= 0x30 && param <= 0x3f) || (param >= 0x20 && param <= 0x2f))) return -1;
		cursor++;
	}
	return -1;
}

function isPaintPadding(line: string, start: number, end: number): boolean {
	let cursor = start;
	while (cursor < end) {
		if (line.charCodeAt(cursor) === 0x20) {
			cursor++;
			continue;
		}
		const next = isSgrSpan(line, cursor);
		if (next < 0 || next > end) return false;
		cursor = next;
	}
	return true;
}

function unwrapStamped(line: string): string | undefined {
	const at = line.indexOf(PAINT_PREFIX);
	if (at < 0) return undefined;
	if (!isPaintPadding(line, 0, at)) return undefined;
	let cursor = at + PAINT_PREFIX.length;
	if (cursor + MAC_HEX >= line.length) return undefined;
	const mac = line.slice(cursor, cursor + MAC_HEX);
	cursor += MAC_HEX;
	if (line.charCodeAt(cursor) !== 0x3a) return undefined;
	cursor++;
	const lenStart = cursor;
	while (cursor < line.length) {
		const code = line.charCodeAt(cursor);
		if (code < 0x30 || code > 0x39) break;
		cursor++;
	}
	if (cursor === lenStart || line.charCodeAt(cursor) !== 0x1b || line.charCodeAt(cursor + 1) !== 0x5c) {
		return undefined;
	}
	const len = Number(line.slice(lenStart, cursor));
	if (!Number.isSafeInteger(len)) return undefined;
	const payloadStart = cursor + 2;
	const payloadEnd = payloadStart + len;
	if (payloadEnd > line.length) return undefined;
	const payload = line.slice(payloadStart, payloadEnd);
	if (!macMatches(mac, payload)) return undefined;
	if (!isPaintPadding(line, payloadEnd, line.length)) return undefined;
	if (at === 0 && payloadEnd === line.length) return payload;
	return line.slice(0, at) + payload + line.slice(payloadEnd);
}

function filterOneLine(line: string, sixel: boolean): string {
	return filterPaintedLines([line], sixel)[0] ?? "";
}

function settleTrustedLines(lines: string[], sixel: boolean): string[] {
	if (trustDepth > 1) return lines;
	if (sixel) {
		const out: string[] = [];
		let raw: string[] = [];
		const flush = () => {
			if (raw.length === 0) return;
			out.push(...filterPaintedLines(raw, true));
			raw = [];
		};
		for (const line of lines) {
			const trusted = unwrapStamped(line ?? "");
			if (trusted !== undefined) {
				flush();
				out.push(trusted);
				continue;
			}
			raw.push(line ?? "");
		}
		flush();
		return out;
	}
	const out = new Array<string>(lines.length);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		out[i] = unwrapStamped(line) ?? filterOneLine(line, false);
	}
	return out;
}

function filterTrustedRender(render: (width: number) => string[], width: number, sixel: boolean): string[] {
	trustDepth++;
	try {
		return settleTrustedLines(render(width), sixel);
	} finally {
		trustDepth--;
	}
}

function sealChildren(component: { children?: Component[] }, sixel: boolean): void {
	const kids = component.children;
	if (!kids) return;
	for (let n = 0; n < kids.length; n++) {
		const child = kids[n];
		if (child) ensureInvalidate(child, sixel);
	}
}

function ensureInvalidate(component: unknown, sixel = false): Component {
	const inner = component as Component & {
		children?: Component[];
		addChild?: (child: Component) => void;
		replaceChildren?: (children: Component[]) => void;
	};
	armTrustedPaint();
	if (!inner.invalidate) inner.invalidate = () => {};
	const cached = paintedWrap.get(inner);
	if (cached) return cached;
	const builtinImage = inner instanceof Image && inner.render === Image.prototype.render;
	const builtinMarkdown = inner instanceof Markdown && inner.render === Markdown.prototype.render;
	if (builtinImage || builtinMarkdown) {
		paintedWrap.set(inner, inner);
		return inner;
	}
	if ((inner instanceof Box || inner instanceof Container) && inner.addChild && inner.children) {
		const add = inner.addChild.bind(inner);
		const render = inner.render.bind(inner);
		inner.addChild = child => {
			ensureInvalidate(child, sixel);
			add(child);
		};
		if (inner instanceof Container) {
			const replace = inner.replaceChildren.bind(inner);
			inner.replaceChildren = children => {
				for (const child of children) ensureInvalidate(child, sixel);
				replace(children);
			};
		}
		inner.render = width => {
			sealChildren(inner, sixel);
			return filterTrustedRender(render, width, sixel);
		};
		sealChildren(inner, sixel);
		paintedWrap.set(inner, inner);
		return inner;
	}
	const render = inner.render.bind(inner);
	inner.render = width => filterTrustedRender(render, width, sixel);
	paintedWrap.set(inner, inner);
	return inner;
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

function previewPayloadKey(args: unknown): string | undefined {
	const partialJson =
		args && typeof args === "object" ? (args as { __partialJson?: unknown }).__partialJson : undefined;
	return typeof partialJson === "string" ? `${partialJson.length}:${partialJson}` : undefined;
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

function previewsAreEqual(a: PerFileDiffPreview[] | undefined, b: PerFileDiffPreview[]): boolean {
	return (
		a?.length === b.length &&
		a.every((preview, index) => {
			const next = b[index];
			return (
				preview.path === next?.path &&
				preview.diff === next.diff &&
				preview.error === next.error &&
				preview.firstChangedLine === next.firstChangedLine
			);
		})
	);
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
	/** Internal observer for visible asynchronous renderer mutations. */
	onVisibleTranscriptMutation?: () => void;
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
	/**
	 * Internal capability for dispatchers that need exact synchronous visible-output
	 * detection. Optional so existing structural handles remain source compatible.
	 */
	consumeVisibleTranscriptChange?(): boolean;
}

/**
 * Component that renders a tool call with its result (updateable)
 */
export class ToolExecutionComponent extends Container {
	#contentBox: Box; // Used for custom tools and bash visual truncation
	#contentText: Text; // For built-in tools (with its own padding/bg)
	#usesContentBox: boolean; // Which of the two the constructor put in the tree
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
	// Cached converted images for Kitty protocol (which requires PNG), keyed by index and source.
	#convertedImages: Map<number, { data: string; mimeType: string; source: string }> = new Map();
	#imageConversionGenerations = new Map<number, number>();
	#imageConversionsInFlight = new Map<number, string>();

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
	#onVisibleTranscriptMutation?: () => void;
	#visibleTranscriptChanged = false;
	#visibleProjection = "";
	#disposed = false;

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
		this.#onVisibleTranscriptMutation = options.onVisibleTranscriptMutation;

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
		this.#usesContentBox = hasCustomRenderer || hasRenderer;
		if (this.#usesContentBox) {
			this.addChild(this.#contentBox);
		} else {
			this.addChild(this.#contentText);
		}

		this.#editMode = resolveEditModeForTool(toolName, tool);

		this.#updateDisplay();
		this.#visibleProjection = this.#captureLogicalVisibleProjection();

		void this.#runPreviewDiff();
	}

	updateArgs(args: any, _toolCallId?: string): void {
		const argsChanged = !Bun.deepEquals(this.#args, args);
		if (!argsChanged && !this.#editMode) return;

		if (args !== this.#lastArgsReference) {
			this.#lastArgsReference = args;
			this.#argsIdentityVersion += 1;
		}
		this.#args = argsChanged ? (this.#shareArgsWithRenderer ? args : cloneToolArgs(args)) : this.#args;
		this.#updateSpinnerAnimation();
		void this.#runPreviewDiff();
		this.#updateDisplay();
		this.#markVisibleMutationIfChanged();
	}

	/**
	 * Signal that args are complete (tool is about to execute).
	 * This triggers an immediate final diff computation for edit-like tools.
	 */
	setArgsComplete(_toolCallId?: string): void {
		this.#argsComplete = true;
		this.#updateSpinnerAnimation();
		void this.#runPreviewDiff();
		this.#updateDisplay();
		this.#markVisibleMutationIfChanged();
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

		// The streamed partial JSON is the exact payload snapshot. Its length alone
		// cannot distinguish same-size replacements. Completed calls lack that
		// snapshot, so retain identity invalidation for their distinct arg objects.
		const argsKey = [
			this.#toolName,
			previewPayloadKey(args) ?? `identity:${this.#argsIdentityVersion}`,
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
			if (this.#disposed || controller.signal.aborted) return;
			if (previews) {
				const nextPreview = isStreaming ? stabilizeStreamingPreviews(previews) : previews;
				const changed = !previewsAreEqual(this.#editDiffPreview, nextPreview);
				this.#editDiffPreview = nextPreview;
				this.#updateDisplay();
				this.#ui.requestRender();
				if (changed) this.#markVisibleMutationIfChanged(true);
			}
		} catch (err) {
			if (this.#disposed || controller.signal.aborted) return;
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
		if (this.#isPartial === isPartial && Bun.deepEquals(this.#result, result)) return;
		this.#textOutputCache = undefined;
		this.#result = result;
		this.#invalidateStaleKittyConversions();
		this.#isPartial = isPartial;
		// When tool is complete, ensure args are marked complete so spinner stops
		if (!isPartial) {
			this.#argsComplete = true;
		}
		this.#updateSpinnerAnimation();
		this.#updateDisplay();
		// Convert non-PNG images to PNG for Kitty protocol (async)
		this.#maybeConvertImagesForKitty();
		this.#markVisibleMutationIfChanged();
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

	#imageSource(image: { data?: string; mimeType?: string }): string | undefined {
		return image.data && image.mimeType ? `${image.mimeType}\u0000${image.data}` : undefined;
	}

	#invalidateStaleKittyConversions(): void {
		const images = this.#getAllImageBlocks();
		const indices = new Set<number>();
		for (let index = 0; index < images.length; index++) {
			const source = this.#imageSource(images[index]);
			if (!source) continue;
			indices.add(index);
			if (this.#convertedImages.get(index)?.source !== source) this.#convertedImages.delete(index);
			if (this.#imageConversionsInFlight.get(index) !== source) {
				this.#imageConversionsInFlight.delete(index);
				this.#imageConversionGenerations.set(index, (this.#imageConversionGenerations.get(index) ?? 0) + 1);
			}
		}
		for (const index of this.#convertedImages.keys()) {
			if (!indices.has(index)) this.#convertedImages.delete(index);
		}
		for (const index of this.#imageConversionsInFlight.keys()) {
			if (!indices.has(index)) {
				this.#imageConversionsInFlight.delete(index);
				this.#imageConversionGenerations.set(index, (this.#imageConversionGenerations.get(index) ?? 0) + 1);
			}
		}
	}

	/** Convert non-PNG images to PNG for Kitty graphics protocol. */
	#maybeConvertImagesForKitty(): void {
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty) return;
		for (const [index, image] of this.#getAllImageBlocks().entries()) {
			const source = this.#imageSource(image);
			if (!source || image.mimeType === "image/png") continue;
			if (
				this.#convertedImages.get(index)?.source === source ||
				this.#imageConversionsInFlight.get(index) === source
			)
				continue;
			const generation = this.#imageConversionGenerations.get(index) ?? 0;
			this.#imageConversionsInFlight.set(index, source);
			new Bun.Image(Buffer.from(image.data!, "base64"))
				.png()
				.toBase64()
				.then(data => {
					if (
						this.#disposed ||
						this.#imageConversionGenerations.get(index) !== generation ||
						this.#imageConversionsInFlight.get(index) !== source ||
						this.#imageSource(this.#getAllImageBlocks()[index] ?? {}) !== source
					)
						return;
					this.#imageConversionsInFlight.delete(index);
					this.#convertedImages.set(index, { data, mimeType: "image/png", source });
					this.#updateDisplay();
					this.#ui.requestRender();
					this.#markVisibleMutationIfChanged(true);
				})
				.catch(() => {
					if (
						this.#disposed ||
						this.#imageConversionGenerations.get(index) !== generation ||
						this.#imageConversionsInFlight.get(index) !== source
					)
						return;
					this.#imageConversionsInFlight.delete(index);
				});
		}
	}

	#captureLogicalVisibleProjection(): string {
		const rendered = this.render(10_000).join("\n");
		// The sticky-viewport source tracks semantic transcript output, not just
		// the literal pixels. A result-first collapsed edit card intentionally
		// hides in-flight diff previews, so preview resolution changes the
		// rendered text by nothing — yet it is still semantic progress the
		// viewport must re-anchor on (the preview becomes visible the moment the
		// user expands, and downstream snapshot/replay keys off this revision).
		// Fold a compact fingerprint of resolved-preview state into the logical
		// projection so it advances independently of the sparse collapsed render.
		const preview = this.#editDiffPreview;
		if (!preview || preview.length === 0) return rendered;
		const fingerprint = preview
			.map(file => `${file.path}:${file.diff ? "1" : "0"}:${file.firstChangedLine ?? ""}:${file.error ? "1" : "0"}`)
			.join("|");
		return `${rendered}\u0000preview:${fingerprint}`;
	}

	#markVisibleMutationIfChanged(notify = false): void {
		const projection = this.#captureLogicalVisibleProjection();
		if (projection === this.#visibleProjection) return;
		this.#visibleProjection = projection;
		this.#markVisibleMutation(notify);
	}

	#markVisibleMutation(notify = false): void {
		if (notify) {
			this.#onVisibleTranscriptMutation?.();
			return;
		}
		this.#visibleTranscriptChanged = true;
	}

	consumeVisibleTranscriptChange(): boolean {
		const changed = this.#visibleTranscriptChanged;
		this.#visibleTranscriptChanged = false;
		return changed;
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
				if (this.#disposed) return;
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
		if (this.#disposed) return;
		this.#disposed = true;
		this.#imageConversionGenerations.clear();
		this.#imageConversionsInFlight.clear();
		this.#convertedImages.clear();
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

		// A call the loop rejected carries the loop's failure envelope in place of the
		// tool's own details. A renderer owns only its own detail shape, so handing it
		// the envelope either throws — leaving the TUI's bare `[render error: Box]`
		// fallback line — or paints the tool's own card while the rejection reason is
		// dropped. The reason is the only content left, so render it the way a tool
		// without a renderer already reports failure.
		if (this.#usesContentBox && this.#result?.isError && isToolFailureEnvelope(this.#result.details)) {
			for (const box of this.#multiFileBoxes) {
				this.removeChild(box);
			}
			this.#multiFileBoxes = [];
			this.#contentBox.setBgFn(bgFn);
			this.#contentBox.clear();
			this.#contentBox.addChild(new Text(renderStatusLine({ icon: "error", title: this.#toolLabel }, theme), 0, 0));
			const reason = this.#getTextOutput().trimEnd();
			if (reason) {
				this.#contentBox.addChild(new Text(theme.fg("toolOutput", replaceTabs(reason)), 0, 0));
			}
		} else if (this.#tool && (this.#tool.renderCall || this.#tool.renderResult)) {
			// Custom tool rendering
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
						this.#contentBox.addChild(ensureInvalidate(callComponent, this.#toolName === "bash"));
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
						this.#contentBox.addChild(ensureInvalidate(resultComponent, this.#toolName === "bash"));
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
			const requestedEditFiles = isEditLikeToolName(this.#toolName)
				? getEditRequestTargetInventory(this.#args, this.#editMode, { isPartial: this.#isPartial }).paths.length
				: 0;
			if (perFileResults && (perFileResults.length > 1 || (this.#isPartial && requestedEditFiles > 1))) {
				// Multi-file: render each file as its own Box (identical to separate tool calls)
				this.#contentBox.setBgFn(undefined);
				this.#contentBox.clear();

				const renderContext = this.#buildRenderContext();
				this.#renderState.renderContext = renderContext;
				const callArgs = this.#getCallArgsForRender();

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
						const fileRenderState = {
							...this.#renderState,
							renderContext: getPerFileEditRenderContext(renderContext as EditRenderContext, fileResult.path) as
								| Record<string, unknown>
								| undefined,
						};
						const resultComponent = renderer.renderResult(
							{ content: [], details: fileResult, isError: fileResult.isError },
							fileRenderState,
							theme,
							getPerFileEditRenderArgs(callArgs, fileResult.path, this.#editMode),
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
				const requestedFiles = getEditRequestTargetInventory(this.#args, this.#editMode, {
					isPartial: this.#isPartial,
				}).paths.length;
				const representedFiles = orderedDistinctPaths(perFileResults.map(file => file.path)).length;
				const remaining = Math.max(0, requestedFiles - representedFiles);
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
							this.#contentBox.addChild(ensureInvalidate(resultComponent, this.#toolName === "bash"));
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
				if (previews.some(preview => preview.path.length > 0)) {
					context.perFileDiffPreview = previews;
				}
			}
			if (this.#expanded && !previews?.some(preview => preview.diff)) {
				const editMode = this.#editMode;
				const strategy = editMode ? EDIT_MODE_STRATEGIES[editMode] : undefined;
				const fallback = strategy?.renderStreamingPlaceholder(this.#args, theme);
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

import { encodeSixel } from "@gajae-code/natives";
import { $env, $pickenv } from "@gajae-code/utils";

export enum ImageProtocol {
	Kitty = "\x1b_G",
	Iterm2 = "\x1b]1337;File=",
	Sixel = "\x1bPq",
}

const ITERM2_MULTIPART_IMAGE_PREFIX = "\x1b]1337;MultipartFile=";

export enum NotifyProtocol {
	Bell = "\x07",
	Osc99 = "\x1b]99;;",
	Osc9 = "\x1b]9;",
}

export type TerminalId = "kitty" | "ghostty" | "wezterm" | "iterm2" | "vscode" | "alacritty" | "base" | "trueColor";

const SIXEL_DCS_START_REGEX = /\x1bP(?:[0-9;]*)q/u;
/** Terminal capability details used for rendering and protocol selection. */
export class TerminalInfo {
	constructor(
		public readonly id: TerminalId,
		public readonly imageProtocol: ImageProtocol | null,
		public readonly trueColor: boolean,
		public readonly hyperlinks: boolean,
		public readonly notifyProtocol: NotifyProtocol = NotifyProtocol.Bell,
	) {}

	isImageLine(line: string): boolean {
		if (!this.imageProtocol) return false;
		if (this.imageProtocol === ImageProtocol.Sixel) {
			return SIXEL_DCS_START_REGEX.test(line.slice(0, 128));
		}
		if (this.imageProtocol === ImageProtocol.Iterm2) {
			const prefix = line.slice(0, 64);
			return prefix.includes(ImageProtocol.Iterm2) || prefix.includes(ITERM2_MULTIPART_IMAGE_PREFIX);
		}
		return line.slice(0, 64).includes(this.imageProtocol);
	}

	formatNotification(message: string): string {
		if (this.notifyProtocol === NotifyProtocol.Bell) {
			return NotifyProtocol.Bell;
		}
		return `${this.notifyProtocol}${message}\x1b\\`;
	}

	sendNotification(message: string): void {
		if (isNotificationSuppressed()) return;
		process.stdout.write(this.formatNotification(message));
	}
}

export function isNotificationSuppressed(): boolean {
	const value = $env.PI_NOTIFICATIONS;
	if (!value) return false;
	return value === "off" || value === "0" || value === "false";
}

const MULTIPLEXER_DISABLED_ENV_VALUES = new Set(["0", "false", "off", "no"]);

function multiplexerEnvEnabled(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized !== undefined && normalized.length > 0 && !MULTIPLEXER_DISABLED_ENV_VALUES.has(normalized);
}

/**
 * Returns whether the process runs under a terminal multiplexer (tmux, GNU
 * screen, or zellij). Recognizes the same host markers as the renderer's
 * multiplexer predicate in tui.ts so capability selection and viewport-repaint
 * policy agree on what counts as a multiplexed host. Multiplexers intercept
 * graphics escapes and OSC 8 hyperlinks instead of forwarding them to the
 * outer terminal.
 */
export function isUnderTerminalMultiplexer(env: NodeJS.ProcessEnv = Bun.env): boolean {
	if (
		multiplexerEnvEnabled(env.TMUX) ||
		multiplexerEnvEnabled(env.TMUX_PANE) ||
		multiplexerEnvEnabled(env.STY) ||
		multiplexerEnvEnabled(env.ZELLIJ) ||
		multiplexerEnvEnabled(env.GJC_TMUX_LAUNCHED)
	) {
		return true;
	}
	const term = env.TERM?.trim().toLowerCase() ?? "";
	return term.startsWith("tmux") || term.startsWith("screen");
}

let terminalGraphicsFallbackDepth = 0;
let cursorNeutralImageAllowedDepth = 0;

export interface TerminalGraphicsFallbackOptions {
	/**
	 * Permit cursor-neutral image escapes (kitty `a=p,C=1` placements) to render
	 * inside this fallback scope. Cursor-advancing protocols (iTerm2/SIXEL)
	 * remain suppressed. A nested scope without this option revokes the
	 * permission for its own subtree.
	 */
	allowCursorNeutralImages?: boolean;
}

/**
 * Synchronously suppress terminal graphics while rendering a text-only surface.
 * Nested scopes remain active until the outermost scope exits.
 */
export function withTerminalGraphicsFallback<T>(fn: () => T, options?: TerminalGraphicsFallbackOptions): T {
	terminalGraphicsFallbackDepth++;
	const allow = options?.allowCursorNeutralImages === true;
	if (allow) cursorNeutralImageAllowedDepth++;
	try {
		return fn();
	} finally {
		if (allow) cursorNeutralImageAllowedDepth--;
		terminalGraphicsFallbackDepth--;
	}
}

/** Returns whether terminal graphics are currently suppressed by a render scope. */
export function isTerminalGraphicsFallbackActive(): boolean {
	return terminalGraphicsFallbackDepth > 0;
}

/**
 * Returns whether cursor-neutral image escapes may render despite an active
 * graphics-fallback scope. True only when every active fallback scope opted in.
 */
export function isCursorNeutralImagePermittedInFallback(): boolean {
	return terminalGraphicsFallbackDepth > 0 && cursorNeutralImageAllowedDepth === terminalGraphicsFallbackDepth;
}

function getForcedImageProtocol(): ImageProtocol | null | undefined {
	const raw = $pickenv("GJC_FORCE_IMAGE_PROTOCOL", "PI_FORCE_IMAGE_PROTOCOL")?.trim().toLowerCase();
	if (!raw) return undefined;
	if (raw === "kitty") return ImageProtocol.Kitty;
	if (raw === "iterm2" || raw === "iterm") return ImageProtocol.Iterm2;
	if (raw === "sixel") return ImageProtocol.Sixel;
	if (raw === "off" || raw === "none" || raw === "0" || raw === "false") return null;
	return null;
}

/**
 * Returns whether PI_FORCE_IMAGE_PROTOCOL explicitly configures the image
 * protocol, including an explicit "off". An explicit configuration is
 * authoritative: runtime capability probes must not override it.
 */
export function isImageProtocolForced(): boolean {
	return getForcedImageProtocol() !== undefined;
}

function parseMajorMinorVersion(versionRaw?: string): { major: number; minor: number } | null {
	if (!versionRaw) return null;
	const match = /^(\d+)\.(\d+)/u.exec(versionRaw.trim());
	if (!match) return null;
	const major = Number.parseInt(match[1] ?? "", 10);
	const minor = Number.parseInt(match[2] ?? "", 10);
	if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
	return { major, minor };
}

/**
 * Returns true when running in Windows Terminal with known SIXEL support.
 *
 * Windows Terminal introduced SIXEL support in preview 1.22.
 */
export function isWindowsTerminalPreviewSixelSupported(
	env: NodeJS.ProcessEnv = Bun.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (platform !== "win32") return false;
	if (!env.WT_SESSION) return false;
	if (env.TERM_PROGRAM && env.TERM_PROGRAM.toLowerCase() !== "windows_terminal") {
		return false;
	}
	const version = parseMajorMinorVersion(env.TERM_PROGRAM_VERSION);
	if (!version) return false;
	return version.major > 1 || (version.major === 1 && version.minor >= 22);
}
function getFallbackImageProtocol(terminalId: TerminalId): ImageProtocol | null {
	if (!process.stdout.isTTY) return null;
	if (terminalId === "vscode" || terminalId === "alacritty") return null;
	const term = Bun.env.TERM?.toLowerCase() ?? "";
	if (term.includes("ghostty")) {
		return ImageProtocol.Kitty;
	}
	return null;
}
const KNOWN_TERMINALS = Object.freeze({
	// Fallback terminals
	base: new TerminalInfo("base", null, false, false, NotifyProtocol.Bell),
	trueColor: new TerminalInfo("trueColor", null, true, false, NotifyProtocol.Bell),
	// Recognized terminals
	kitty: new TerminalInfo("kitty", ImageProtocol.Kitty, true, true, NotifyProtocol.Osc99),
	ghostty: new TerminalInfo("ghostty", ImageProtocol.Kitty, true, true, NotifyProtocol.Osc9),
	wezterm: new TerminalInfo("wezterm", ImageProtocol.Kitty, true, true, NotifyProtocol.Osc9),
	iterm2: new TerminalInfo("iterm2", ImageProtocol.Iterm2, true, true, NotifyProtocol.Osc9),
	vscode: new TerminalInfo("vscode", null, true, true, NotifyProtocol.Bell),
	alacritty: new TerminalInfo("alacritty", null, true, true, NotifyProtocol.Bell),
});

export const TERMINAL_ID: TerminalId = (() => {
	function caseEq(a: string, b: string): boolean {
		return a.toLowerCase() === b.toLowerCase(); // For compiler to pattern match
	}

	const {
		KITTY_WINDOW_ID,
		GHOSTTY_RESOURCES_DIR,
		WEZTERM_PANE,
		ITERM_SESSION_ID,
		VSCODE_PID,
		ALACRITTY_WINDOW_ID,
		TERM_PROGRAM,
		TERM,
		COLORTERM,
	} = Bun.env;

	if (KITTY_WINDOW_ID) return "kitty";
	if (GHOSTTY_RESOURCES_DIR) return "ghostty";
	if (WEZTERM_PANE) return "wezterm";
	if (ITERM_SESSION_ID) return "iterm2";
	if (VSCODE_PID) return "vscode";
	if (ALACRITTY_WINDOW_ID) return "alacritty";

	if (TERM_PROGRAM) {
		if (caseEq(TERM_PROGRAM, "kitty")) return "kitty";
		if (caseEq(TERM_PROGRAM, "ghostty")) return "ghostty";
		if (caseEq(TERM_PROGRAM, "wezterm")) return "wezterm";
		if (caseEq(TERM_PROGRAM, "iterm.app")) return "iterm2";
		if (caseEq(TERM_PROGRAM, "vscode")) return "vscode";
		if (caseEq(TERM_PROGRAM, "alacritty")) return "alacritty";
	}

	if (TERM?.toLowerCase().includes("ghostty")) return "ghostty";

	if (COLORTERM) {
		if (caseEq(COLORTERM, "truecolor") || caseEq(COLORTERM, "24bit")) return "trueColor";
	}
	return "base";
})();

export const TERMINAL = (() => {
	const terminal = getTerminalInfo(TERMINAL_ID);
	const forcedImageProtocol = getForcedImageProtocol();
	let resolved = terminal;
	if (forcedImageProtocol !== undefined) {
		resolved = new TerminalInfo(
			terminal.id,
			forcedImageProtocol,
			terminal.trueColor,
			terminal.hyperlinks,
			terminal.notifyProtocol,
		);
	} else if (!terminal.imageProtocol) {
		const fallbackImageProtocol = getFallbackImageProtocol(terminal.id);
		if (fallbackImageProtocol) {
			resolved = new TerminalInfo(
				terminal.id,
				fallbackImageProtocol,
				terminal.trueColor,
				terminal.hyperlinks,
				terminal.notifyProtocol,
			);
		}
	}
	const underMultiplexer = isUnderTerminalMultiplexer();
	// tmux and screen multiplexers do not reliably forward OSC 8 hyperlinks
	// to the outer terminal, so force them off regardless of detected terminal.
	if (resolved.hyperlinks && underMultiplexer) {
		resolved = new TerminalInfo(
			resolved.id,
			resolved.imageProtocol,
			resolved.trueColor,
			false,
			resolved.notifyProtocol,
		);
	}
	// Multiplexers (tmux/screen/zellij) consume raw kitty/iTerm2 graphics
	// escapes instead of forwarding them (no DCS passthrough wrapping is
	// emitted), so a detected image protocol draws nothing while its
	// out-of-band cursor writes corrupt the frame. Graphics are therefore
	// unconditionally suppressed under a multiplexer; the runtime sixel probe
	// never runs there (tmux advertises DA1 ";4" from compile-time support
	// regardless of the attached client), and PI_FORCE_IMAGE_PROTOCOL=sixel
	// is the only opt-in for chains that render sixel end-to-end.
	if (resolved.imageProtocol && forcedImageProtocol === undefined && underMultiplexer) {
		resolved = new TerminalInfo(resolved.id, null, resolved.trueColor, resolved.hyperlinks, resolved.notifyProtocol);
	}
	return resolved;
})();

type MutableTerminalInfo = {
	imageProtocol: ImageProtocol | null;
};

type ImageProtocolChangeListener = (imageProtocol: ImageProtocol | null) => void;
const imageProtocolChangeListeners = new Set<ImageProtocolChangeListener>();

/**
 * Subscribe to runtime image-protocol changes (e.g. the asynchronous sixel
 * capability probe enabling graphics after startup). Returns an unsubscribe
 * function. Listeners fire only on actual changes.
 */
export function onImageProtocolChanged(listener: ImageProtocolChangeListener): () => void {
	imageProtocolChangeListeners.add(listener);
	return () => {
		imageProtocolChangeListeners.delete(listener);
	};
}

/**
 * Override terminal image protocol at runtime after capability probes complete.
 */
export function setTerminalImageProtocol(imageProtocol: ImageProtocol | null): void {
	const mutable = TERMINAL as unknown as MutableTerminalInfo;
	if (mutable.imageProtocol === imageProtocol) return;
	mutable.imageProtocol = imageProtocol;
	for (const listener of imageProtocolChangeListeners) {
		try {
			listener(imageProtocol);
		} catch {
			// Listener failures must not break protocol switching.
		}
	}
}

export function getTerminalInfo(terminalId: TerminalId): TerminalInfo {
	return KNOWN_TERMINALS[terminalId];
}

export interface CellDimensions {
	widthPx: number;
	heightPx: number;
}

export interface ImageDimensions {
	widthPx: number;
	heightPx: number;
}

export interface ImageRenderOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	preserveAspectRatio?: boolean;
	/**
	 * Kitty-only: stable placement id (`p=`). Re-emitting the same image id +
	 * placement id *replaces* the existing placement instead of stacking a new
	 * copy, which makes diff-renderer repaints idempotent. Callers that render
	 * a persistent component should allocate one id per component instance.
	 */
	placementId?: number;
	/**
	 * Kitty-only: stable image id (`i=`). Defaults to a content hash of the
	 * base64 payload ({@link kittyImageId}). Pass a precomputed id to avoid
	 * re-hashing large payloads on every render.
	 */
	imageId?: number;
	/**
	 * Kitty-only: sink for the out-of-band data transmission (`a=t`) emitted
	 * the first time an image id is rendered. Defaults to the process-wide
	 * writer configured via {@link setKittyTransmitWriter} (stdout).
	 */
	onTransmit?: (sequence: string) => void;
}

/**
 * Derive a stable 32-bit non-zero kitty image id (`i=`) from image content
 * (FNV-1a over the base64 payload). Identical content maps to the same id, so
 * retransmission replaces the stored image instead of accumulating copies.
 */
export function kittyImageId(base64Data: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < base64Data.length; i++) {
		hash ^= base64Data.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	hash >>>= 0;
	return hash === 0 ? 1 : hash;
}

// Default cell dimensions - updated by TUI when terminal responds to query
let cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 };

export function getCellDimensions(): CellDimensions {
	return cellDimensions;
}

export function setCellDimensions(dims: CellDimensions): void {
	cellDimensions = dims;
}

export function encodeKitty(
	base64Data: string,
	options: {
		columns?: number;
		rows?: number;
		imageId?: number;
		placementId?: number;
	} = {},
): string {
	const CHUNK_SIZE = 4096;

	const params: string[] = ["a=T", "f=100", "q=2"];

	if (options.columns) params.push(`c=${options.columns}`);
	if (options.rows) params.push(`r=${options.rows}`);
	if (options.imageId) {
		params.push(`i=${options.imageId}`);
		// A placement id is only meaningful together with an image id. Same
		// i= + p= replaces the previous placement (kitty graphics spec), so
		// re-emitting this sequence never duplicates the image on screen.
		if (options.placementId) params.push(`p=${options.placementId}`);
	}

	if (base64Data.length <= CHUNK_SIZE) {
		return `\x1b_G${params.join(",")};${base64Data}\x1b\\`;
	}

	const chunks: string[] = [];
	let offset = 0;
	let isFirst = true;

	while (offset < base64Data.length) {
		const chunk = base64Data.slice(offset, offset + CHUNK_SIZE);
		const isLast = offset + CHUNK_SIZE >= base64Data.length;

		if (isFirst) {
			chunks.push(`\x1b_G${params.join(",")},m=1;${chunk}\x1b\\`);
			isFirst = false;
		} else if (isLast) {
			chunks.push(`\x1b_Gm=0;${chunk}\x1b\\`);
		} else {
			chunks.push(`\x1b_Gm=1;${chunk}\x1b\\`);
		}

		offset += CHUNK_SIZE;
	}

	return chunks.join("");
}

/** Kitty image ids already uploaded to the terminal in this process. */
const transmittedKittyImageIds = new Set<number>();

/** Test hook: forget which kitty image ids were transmitted. */
export function resetKittyTransmissions(): void {
	transmittedKittyImageIds.clear();
}

let kittyTransmitWriter: (sequence: string) => void = sequence => {
	process.stdout.write(sequence);
};

/**
 * Override where out-of-band kitty data transmissions (`a=t`) are written.
 * The default writes directly to stdout: a transmit-only escape is
 * cursor-neutral (it uploads pixel data without drawing anything), so the
 * only ordering requirement is that it reaches the terminal before the
 * placement escape that references it — which the synchronous write during
 * render guarantees. Tests use this to capture transmissions.
 */
export function setKittyTransmitWriter(writer: (sequence: string) => void): void {
	kittyTransmitWriter = writer;
}

/**
 * Encode a kitty transmit-only (`a=t`) escape: uploads image data under a
 * stable id without creating a placement. Chunked at 4096 bytes per spec.
 *
 * This is deliberately separate from placement: re-sending data (`a=t`/`a=T`)
 * for an existing image id deletes the image and ALL of its placements, so
 * data must be uploaded exactly once per id and repaints must go through
 * {@link encodeKittyPlacement} only.
 */
export function encodeKittyTransmit(base64Data: string, imageId: number): string {
	const CHUNK_SIZE = 4096;
	const params = ["a=t", "f=100", "q=2", `i=${imageId}`];

	if (base64Data.length <= CHUNK_SIZE) {
		return `\x1b_G${params.join(",")};${base64Data}\x1b\\`;
	}

	const chunks: string[] = [];
	let offset = 0;
	let isFirst = true;

	while (offset < base64Data.length) {
		const chunk = base64Data.slice(offset, offset + CHUNK_SIZE);
		const isLast = offset + CHUNK_SIZE >= base64Data.length;

		if (isFirst) {
			chunks.push(`\x1b_G${params.join(",")},m=1;${chunk}\x1b\\`);
			isFirst = false;
		} else if (isLast) {
			chunks.push(`\x1b_Gm=0;${chunk}\x1b\\`);
		} else {
			chunks.push(`\x1b_Gm=1;${chunk}\x1b\\`);
		}

		offset += CHUNK_SIZE;
	}

	return chunks.join("");
}

/**
 * Encode a kitty placement-only (`a=p`) escape referencing previously
 * transmitted data. Re-emitting the same i=/p= pair replaces that one
 * placement (never stacks, never touches sibling placements), and C=1
 * keeps the cursor where it is so the escape can be emitted from the
 * component's first row without cursor-up tricks.
 */
export function encodeKittyPlacement(options: {
	imageId: number;
	placementId: number;
	columns: number;
	rows: number;
}): string {
	return `\x1b_Ga=p,i=${options.imageId},p=${options.placementId},c=${options.columns},r=${options.rows},C=1,q=2\x1b\\`;
}

export function encodeITerm2(
	base64Data: string,
	options: {
		width?: number | string;
		height?: number | string;
		name?: string;
		preserveAspectRatio?: boolean;
		inline?: boolean;
	} = {},
): string {
	const params: string[] = [`inline=${options.inline !== false ? 1 : 0}`];

	if (options.width !== undefined) params.push(`width=${options.width}`);
	if (options.height !== undefined) params.push(`height=${options.height}`);
	if (options.name) {
		const nameBase64 = Buffer.from(options.name).toBase64();
		params.push(`name=${nameBase64}`);
	}
	if (options.preserveAspectRatio === false) {
		params.push("preserveAspectRatio=0");
	}

	return `\x1b]1337;File=${params.join(";")}:${base64Data}\x07`;
}

export function calculateImageRows(
	imageDimensions: ImageDimensions,
	targetWidthCells: number,
	cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 },
): number {
	const targetWidthPx = targetWidthCells * cellDimensions.widthPx;
	const scale = targetWidthPx / imageDimensions.widthPx;
	const scaledHeightPx = imageDimensions.heightPx * scale;
	const rows = Math.ceil(scaledHeightPx / cellDimensions.heightPx);
	return Math.max(1, rows);
}

function calculateImageFit(
	imageDimensions: ImageDimensions,
	options: ImageRenderOptions,
	cellDims: CellDimensions,
): { columns: number; rows: number } {
	const maxColumns = options.maxWidthCells !== undefined ? Math.max(1, Math.floor(options.maxWidthCells)) : undefined;
	const maxRows = options.maxHeightCells !== undefined ? Math.max(1, Math.floor(options.maxHeightCells)) : undefined;

	if (maxColumns === undefined && maxRows === undefined) {
		const columns = Math.max(1, Math.ceil(imageDimensions.widthPx / cellDims.widthPx));
		const rows = Math.max(1, Math.ceil(imageDimensions.heightPx / cellDims.heightPx));
		return { columns, rows };
	}

	const maxWidthPx = maxColumns !== undefined ? maxColumns * cellDims.widthPx : Number.POSITIVE_INFINITY;
	const maxHeightPx = maxRows !== undefined ? maxRows * cellDims.heightPx : Number.POSITIVE_INFINITY;
	const scale = Math.min(maxWidthPx / imageDimensions.widthPx, maxHeightPx / imageDimensions.heightPx);
	const fittedWidthPx = imageDimensions.widthPx * scale;
	const fittedHeightPx = imageDimensions.heightPx * scale;

	const columns = Math.max(1, Math.floor(fittedWidthPx / cellDims.widthPx));
	const rows = Math.max(1, Math.ceil(fittedHeightPx / cellDims.heightPx));

	return {
		columns: maxColumns !== undefined ? Math.min(columns, maxColumns) : columns,
		rows: maxRows !== undefined ? Math.min(rows, maxRows) : rows,
	};
}

export function getPngDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 24) {
			return null;
		}

		if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
			return null;
		}

		const width = buffer.readUInt32BE(16);
		const height = buffer.readUInt32BE(20);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

export function getJpegDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 2) {
			return null;
		}

		if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
			return null;
		}

		let offset = 2;
		while (offset < buffer.length - 9) {
			if (buffer[offset] !== 0xff) {
				offset++;
				continue;
			}

			const marker = buffer[offset + 1];

			if (marker >= 0xc0 && marker <= 0xc2) {
				const height = buffer.readUInt16BE(offset + 5);
				const width = buffer.readUInt16BE(offset + 7);
				return { widthPx: width, heightPx: height };
			}

			if (offset + 3 >= buffer.length) {
				return null;
			}
			const length = buffer.readUInt16BE(offset + 2);
			if (length < 2) {
				return null;
			}
			offset += 2 + length;
		}

		return null;
	} catch {
		return null;
	}
}

export function getGifDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 10) {
			return null;
		}

		const sig = buffer.slice(0, 6).toString("ascii");
		if (sig !== "GIF87a" && sig !== "GIF89a") {
			return null;
		}

		const width = buffer.readUInt16LE(6);
		const height = buffer.readUInt16LE(8);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

export function getWebpDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 30) {
			return null;
		}

		const riff = buffer.slice(0, 4).toString("ascii");
		const webp = buffer.slice(8, 12).toString("ascii");
		if (riff !== "RIFF" || webp !== "WEBP") {
			return null;
		}

		const chunk = buffer.slice(12, 16).toString("ascii");
		if (chunk === "VP8 ") {
			if (buffer.length < 30) return null;
			const width = buffer.readUInt16LE(26) & 0x3fff;
			const height = buffer.readUInt16LE(28) & 0x3fff;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8L") {
			if (buffer.length < 25) return null;
			const bits = buffer.readUInt32LE(21);
			const width = (bits & 0x3fff) + 1;
			const height = ((bits >> 14) & 0x3fff) + 1;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8X") {
			if (buffer.length < 30) return null;
			const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
			const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
			return { widthPx: width, heightPx: height };
		}

		return null;
	} catch {
		return null;
	}
}

export function getImageDimensions(base64Data: string, mimeType: string): ImageDimensions | null {
	if (mimeType === "image/png") {
		return getPngDimensions(base64Data);
	}
	if (mimeType === "image/jpeg") {
		return getJpegDimensions(base64Data);
	}
	if (mimeType === "image/gif") {
		return getGifDimensions(base64Data);
	}
	if (mimeType === "image/webp") {
		return getWebpDimensions(base64Data);
	}
	return null;
}

export interface RenderedImage {
	sequence: string;
	rows: number;
	/**
	 * True when the escape neither moves the cursor nor carries pixel data
	 * (kitty `a=p,C=1` placements). Cursor-neutral sequences can be emitted
	 * from the component's first row; cursor-advancing protocols
	 * (iTerm2/SIXEL) must draw from the last reserved row instead.
	 */
	cursorNeutral?: boolean;
}

export function renderImage(
	base64Data: string,
	imageDimensions: ImageDimensions,
	options: ImageRenderOptions = {},
): RenderedImage | null {
	if (!TERMINAL.imageProtocol) {
		return null;
	}

	const cellDims = getCellDimensions();
	const fit = calculateImageFit(imageDimensions, options, cellDims);

	if (TERMINAL.imageProtocol === ImageProtocol.Kitty) {
		const imageId = options.imageId ?? kittyImageId(base64Data);
		const placementId = options.placementId ?? 1;
		// Upload data once per image id (out-of-band; the transmit escape is
		// cursor-neutral), then return only a tiny placement escape. Repaints
		// re-emit just the placement, which replaces/moves that placement —
		// re-sending data (a=T/a=t) for an existing id would delete the image
		// and ALL of its placements (breaking sibling components showing the
		// same content) and would re-send multi-MB payloads on every repaint.
		if (!transmittedKittyImageIds.has(imageId)) {
			transmittedKittyImageIds.add(imageId);
			(options.onTransmit ?? kittyTransmitWriter)(encodeKittyTransmit(base64Data, imageId));
		}
		const sequence = encodeKittyPlacement({ imageId, placementId, columns: fit.columns, rows: fit.rows });
		return { sequence, rows: fit.rows, cursorNeutral: true };
	}

	if (TERMINAL.imageProtocol === ImageProtocol.Sixel) {
		try {
			const targetWidthPx = Math.max(1, fit.columns * cellDims.widthPx);
			const targetHeightPx = Math.max(1, fit.rows * cellDims.heightPx);
			const decoded = new Uint8Array(Buffer.from(base64Data, "base64"));
			const sequence = encodeSixel(decoded, targetWidthPx, targetHeightPx);
			return { sequence, rows: fit.rows };
		} catch {
			return null;
		}
	}
	if (TERMINAL.imageProtocol === ImageProtocol.Iterm2) {
		const sequence = encodeITerm2(base64Data, {
			width: fit.columns,
			height: "auto",
			preserveAspectRatio: options.preserveAspectRatio ?? true,
		});
		return { sequence, rows: fit.rows };
	}

	return null;
}

export function imageFallback(mimeType: string, dimensions?: ImageDimensions, filename?: string): string {
	const parts: string[] = [];
	if (filename) parts.push(filename);
	parts.push(`[${mimeType}]`);
	if (dimensions) parts.push(`${dimensions.widthPx}x${dimensions.heightPx}`);
	return `[Image: ${parts.join(" ")}]`;
}
export type Iterm2Capability = { readonly key: string; readonly value: string };
export type Iterm2CapabilityReply = "complete-f" | "missing-f" | "invalid-f" | undefined;

const ITERM2_CAPABILITY_REPLY_REGEX = /\x1b\]1337;Capabilities(?:=|:)([^\x07\x1b]*)(?:\x07|\x1b\\)/gu;
const ITERM2_FEATURE_TOKEN_REGEX = /^[A-Z][a-z]*[0-9]*$/u;

/**
 * Classifies complete iTerm2 capability replies. An absent result means the
 * input does not yet contain a complete capability frame.
 */
export function parseITerm2CapabilityReply(input: Uint8Array | string): Iterm2CapabilityReply {
	const value = typeof input === "string" ? input : new TextDecoder().decode(input);
	let complete = false;
	for (const match of value.matchAll(ITERM2_CAPABILITY_REPLY_REGEX)) {
		complete = true;
		const featureString = match[1] ?? "";
		const tokens: string[] = featureString.match(/[A-Z][a-z]*[0-9]*/gu) ?? [];
		if (tokens.join("") !== featureString || !tokens.every(token => ITERM2_FEATURE_TOKEN_REGEX.test(token))) {
			return "invalid-f";
		}
		if (tokens.includes("F")) return "complete-f";
	}
	return complete ? "missing-f" : undefined;
}

const ITERM2_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const ITERM2_MAX_CAPABILITY_BYTES = 4096;

function assertIterm2Base64(value: string): void {
	if (value.length % 4 !== 0 || !ITERM2_BASE64.test(value)) throw new Error("Invalid RFC 4648 base64");
}

export function encodeITerm2Multipart(
	base64Data: string,
	options: { width?: number | string; height?: number | string } = {},
): string[] {
	assertIterm2Base64(base64Data);
	const validate = (value: number | string, label: string): number | string => {
		if (
			typeof value === "number" &&
			(!Number.isFinite(value) || !Number.isInteger(value) || value <= 0 || value > 0xffff)
		)
			throw new Error(`Invalid iTerm2 ${label}`);
		if (typeof value === "string" && !/^[A-Za-z0-9]+$/u.test(value)) throw new Error(`Invalid iTerm2 ${label}`);
		return value;
	};
	const width = validate(options.width ?? "auto", "width");
	const height = validate(options.height ?? "auto", "height");
	const size = Buffer.from(base64Data, "base64").byteLength;
	const name = Buffer.from("gajae-pet.gif").toString("base64");
	const records = [
		`\x1b]1337;MultipartFile=;name=${name};size=${size};width=${width};height=${height};inline=1;preserveAspectRatio=0:\x07`,
	];
	for (let i = 0; i < base64Data.length; i += 200) {
		records.push(`\x1b]1337;FilePart=${base64Data.slice(i, i + 200)}\x07`);
	}
	records.push("\x1b]1337;FileEnd\x07");
	for (const record of records) {
		if (Buffer.byteLength(`\x1bPtmux;${record.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`, "utf8") > 256)
			throw new Error("iTerm2 record exceeds tmux limit");
	}
	return records;
}

export function wrapITerm2RecordForTmux(record: string): string {
	const wrapped = `\x1bPtmux;${record.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
	if (Buffer.byteLength(wrapped, "utf8") > 256) throw new Error("iTerm2 record exceeds tmux limit");
	return wrapped;
}

export function wrapITerm2RecordsForTmux(records: readonly string[]): string[] {
	return records.map(wrapITerm2RecordForTmux);
}

function parseIterm2CapabilityString(value: string): Iterm2Capability[] {
	const out: Iterm2Capability[] = [];
	for (const pair of value.split(";")) {
		const i = pair.indexOf("=");
		if (i > 0) out.push({ key: pair.slice(0, i), value: pair.slice(i + 1) });
		else if (i < 0 && pair.length > 0) out.push({ key: pair, value: "" });
	}
	return out;
}

export function parseITerm2Capabilities(input: string): Iterm2Capability[] {
	const parser = new Iterm2CapabilitiesParser();
	return parser.push(input);
}

export class Iterm2CapabilitiesParser {
	#buffer = "";
	push(input: Uint8Array | string): Iterm2Capability[] {
		this.#buffer += typeof input === "string" ? input : new TextDecoder().decode(input);
		const out: Iterm2Capability[] = [];
		while (true) {
			const marker = this.#buffer.indexOf("\x1b]1337;Capabilities=");
			if (marker < 0) {
				this.#buffer = this.#buffer.slice(-32);
				break;
			}
			const valueStart = marker + "\x1b]1337;Capabilities=".length;
			let end = -1;
			for (let i = valueStart; i < this.#buffer.length; i++) {
				if (this.#buffer[i] === "\x07") {
					end = i + 1;
					break;
				}
				if (this.#buffer[i] === "\x1b" && this.#buffer[i + 1] === "\\") {
					end = i + 2;
					break;
				}
				if (i - valueStart > ITERM2_MAX_CAPABILITY_BYTES) {
					end = -2;
					break;
				}
			}
			if (end === -1) break;
			if (end === -2) {
				this.#buffer = this.#buffer.slice(valueStart + 1);
				continue;
			}
			const terminatorLength = this.#buffer[end - 2] === "\x1b" ? 2 : 1;
			out.push(...parseIterm2CapabilityString(this.#buffer.slice(valueStart, end - terminatorLength)));
			this.#buffer = this.#buffer.slice(end);
		}
		return out;
	}
	reset(): void {
		this.#buffer = "";
	}
}

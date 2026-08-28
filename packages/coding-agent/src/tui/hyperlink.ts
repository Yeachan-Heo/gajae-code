/**
 * OSC 8 terminal hyperlink support for file paths.
 *
 * Wraps display text in `ESC ] 8 ; id=HASH ; URI ESC \ TEXT ESC ] 8 ; ; ESC \`
 * sequences when the active terminal supports hyperlinks and the user setting
 * permits it. Falls back to plain text when disabled.
 */
import { TERMINAL } from "@gajae-code/tui";
import { settings } from "../config/settings";
import {
	LocalProtocolHandler,
	parseInternalUrl,
	resolveLocalUrlToPath,
	resolveMemoryUrlToPath,
} from "../internal-urls";
import type { LocalProtocolOptions } from "../internal-urls/local-protocol";

const OSC = "\x1b]";
const ST = "\x1b\\";

/** Stable 8-char hex ID derived from a URI — hints terminals to coalesce identical adjacent links. */
function buildLinkId(uri: string): string {
	let h = 0;
	for (let i = 0; i < uri.length; i++) {
		// FNV-1a-inspired mix — good enough for a UI hint, no deps
		h = (Math.imul(31, h) + uri.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

/** Build a `file://` URI for an absolute path with optional line/col query params. */
function buildFileUri(absPath: string, opts?: { line?: number; col?: number }): string {
	// Normalize backslashes for Windows paths before constructing the URL.
	const normalized = absPath.replaceAll("\\", "/");
	const prefix = normalized.startsWith("/") ? "file://" : "file:///";
	// Split on slashes, encode each component, reassemble.
	const encoded = normalized
		.split("/")
		.map(segment => encodeURIComponent(segment))
		.join("/");
	const params: string[] = [];
	if (opts?.line !== undefined) params.push(`line=${opts.line}`);
	if (opts?.col !== undefined) params.push(`col=${opts.col}`);
	const query = params.length > 0 ? `?${params.join("&")}` : "";
	return `${prefix}${encoded}${query}`;
}

/**
 * Returns true when OSC 8 hyperlinks should be emitted.
 *
 * Respects `tui.hyperlinks` setting:
 * - `"off"`: never
 * - `"auto"`: when `process.stdout.isTTY`, `NO_COLOR` is unset, and the detected terminal reports hyperlink support
 * - `"always"`: unconditionally (useful for viewers that support OSC 8 without advertising it)
 */
export function isHyperlinkEnabled(): boolean {
	const mode = settings.get("tui.hyperlinks");
	if (mode === "off") return false;
	if (mode === "always") return true;
	// auto: respect terminal capabilities and NO_COLOR
	if (Bun.env.NO_COLOR) return false;
	if (!process.stdout.isTTY) return false;
	return TERMINAL.hyperlinks;
}

/**
 * Wrap `displayText` in an OSC 8 hyperlink pointing at the given absolute file path.
 *
 * Returns `displayText` unchanged when hyperlinks are disabled or when
 * the text already contains an OSC 8 sequence (prevents double-wrapping).
 *
 * The caller is responsible for passing an absolute path. Relative paths
 * produce invalid `file://` URIs and are accepted silently to avoid runtime
 * errors in renderer hot paths.
 *
 * @param absPath - Absolute filesystem path
 * @param displayText - Text to render as the hyperlink anchor (may contain ANSI codes)
 * @param opts - Optional line/col position appended as `?line=N&col=M` query params
 */
export function fileHyperlink(absPath: string, displayText: string, opts?: { line?: number; col?: number }): string {
	if (!isHyperlinkEnabled()) return displayText;
	// Do not double-wrap if the text already embeds an OSC 8 sequence.
	if (displayText.includes("\x1b]8;")) return displayText;
	const uri = buildFileUri(absPath, opts);
	const id = buildLinkId(uri);
	return `${OSC}8;id=${id};${uri}${ST}${displayText}${OSC}8;;${ST}`;
}

/**
 * Synchronously resolve a filesystem-backed internal URL (e.g. `local://foo.md`,
 * `memory://root/notes.md`) to its absolute filesystem path. Returns `undefined`
 * for inputs that aren't fs-backed, aren't resolvable in the current session
 * registry, or fail to parse.
 *
 * Used by renderers to wrap fs-backed internal URLs in OSC 8 hyperlinks even
 * when the resolved path isn't yet available from tool result details (e.g.
 * during the call/streaming phase before a result lands).
 *
 * Async-resolved schemes (`artifact://`, `agent://`, `skill://`, `rule://`,
 * `gjc://`) are not handled here — those rely on `details.resolvedPath` set
 * by the read tool's router resolution.
 */
export function tryResolveInternalUrlSync(
	input: string,
	options?: { localProtocolOptions?: LocalProtocolOptions; memoryRoot?: string },
): string | undefined {
	try {
		if (input.startsWith("local://")) {
			const opts = options?.localProtocolOptions ?? LocalProtocolHandler.resolveOptions();
			if (!opts) return undefined;
			return resolveLocalUrlToPath(input, opts);
		}
		if (input.startsWith("memory://")) {
			if (!options?.memoryRoot) return undefined;
			const url = parseInternalUrl(input);
			return resolveMemoryUrlToPath(url, options.memoryRoot);
		}
	} catch {
		return undefined;
	}
	return undefined;
}

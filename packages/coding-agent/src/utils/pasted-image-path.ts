/**
 * Resolve pasted editor text to an image file path.
 *
 * Terminals insert a shell-escaped filesystem path when a file is drag-dropped
 * onto them (e.g. macOS `Screenshot\ 2026-07-07\ at\ 11.06.38 PM.png`, where
 * the visible "space" before AM/PM is U+202F and stays unescaped). When the
 * entire paste is a single path to an existing image file, the interactive
 * editor attaches the image and inserts an `[image N]` placeholder instead of
 * leaving the raw path in the prompt.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE_FILE_EXTENSION_PATTERN = /\.(?:png|jpe?g|gif|webp)$/i;

export interface DecodePastedPathOptions {
	/**
	 * Platform whose path semantics apply when decoding (shell unescaping,
	 * `file://` drive letters / UNC hosts). Defaults to `process.platform`;
	 * injectable so tests can pin the win32 contract from any host.
	 */
	platform?: NodeJS.Platform;
	/** Home directory for `~/` expansion. Defaults to `os.homedir()`. */
	homedir?: string;
}

export interface ResolvePastedImagePathOptions extends DecodePastedPathOptions {
	/** Base directory for relative paths. Defaults to `process.cwd()`. */
	cwd?: string;
}

/**
 * Convert a `file://` URI to a filesystem path for the given platform, or
 * `undefined` when the URI is invalid.
 *
 * The production path (injected platform === host platform, always true
 * outside tests) delegates to Node's `fileURLToPath`. When tests inject a
 * foreign platform, a mirror of `fileURLToPath`'s rules is applied instead —
 * Bun (1.3) accepts but ignores `fileURLToPath`'s `windows` option, so the
 * native call cannot emulate a foreign platform.
 */
function decodeFileUrl(candidate: string, platform: NodeJS.Platform): string | undefined {
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return undefined;
	}
	if (url.protocol !== "file:") return undefined;

	if (platform === process.platform) {
		try {
			return fileURLToPath(url);
		} catch {
			return undefined;
		}
	}

	// Foreign-platform mirror of fileURLToPath (tests only).
	if (/%2f/i.test(url.pathname) || (platform === "win32" && /%5c/i.test(url.pathname))) return undefined;
	let pathname: string;
	try {
		pathname = decodeURIComponent(url.pathname);
	} catch {
		return undefined;
	}
	if (platform === "win32") {
		if (url.hostname && url.hostname !== "localhost") {
			// UNC: file://server/share/img.png -> \\server\share\img.png
			return `\\\\${url.hostname}${pathname.replaceAll("/", "\\")}`;
		}
		// Drive letter required: file:///C:/x -> C:\x
		if (!/^\/[A-Za-z]:/.test(pathname)) return undefined;
		return pathname.slice(1).replaceAll("/", "\\");
	}
	if (url.hostname && url.hostname !== "localhost") return undefined;
	return pathname;
}

/**
 * Decode pasted text into a filesystem path candidate. No filesystem access.
 *
 * Handles terminal drag-drop shell escaping (`\ `, `\(`, ...; skipped on
 * win32 where `\` is the path separator), quoted paths, `file://` URIs
 * (drive-letter, `file://localhost`, and UNC forms on win32), and `~/`
 * expansion. Returns `undefined` when the text is empty, spans multiple
 * lines, or is an invalid `file://` URI.
 */
export function decodePastedPathCandidate(text: string, options?: DecodePastedPathOptions): string | undefined {
	const platform = options?.platform ?? process.platform;
	let candidate = text.trim();
	if (!candidate || /[\r\n]/.test(candidate)) return undefined;

	// Quoted paths (some terminals quote instead of escaping).
	if (
		candidate.length >= 2 &&
		(candidate.startsWith('"') || candidate.startsWith("'")) &&
		candidate.endsWith(candidate[0])
	) {
		candidate = candidate.slice(1, -1);
	}

	if (candidate.startsWith("file://")) {
		const decoded = decodeFileUrl(candidate, platform);
		if (decoded === undefined) return undefined;
		candidate = decoded;
	} else if (platform !== "win32") {
		// Terminal drag-drop escapes shell-special characters (`\ `, `\(`, ...).
		// Skipped on Windows where `\` is the path separator.
		candidate = candidate.replace(/\\(.)/g, "$1");
	}

	if (candidate.startsWith("~/")) {
		candidate = path.join(options?.homedir ?? os.homedir(), candidate.slice(2));
	}

	return candidate;
}

/**
 * Sniff the file header for a supported image signature (PNG, JPEG, GIF,
 * WEBP). Prevents existing non-image files with image-looking extensions
 * (e.g. a text file named `not-image.png`) from being treated as image
 * candidates — consuming such a paste would lose the raw path when the
 * image loader later rejects the content.
 */
function hasSupportedImageMagic(filePath: string): boolean {
	let fd: number;
	try {
		fd = fs.openSync(filePath, "r");
	} catch {
		return false;
	}
	try {
		// Zero-filled; short reads leave trailing zeros so comparisons fail safely.
		const header = Buffer.alloc(12);
		fs.readSync(fd, header, 0, 12, 0);
		if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) return true; // PNG
		if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return true; // JPEG
		const ascii6 = header.toString("latin1", 0, 6);
		if (ascii6 === "GIF87a" || ascii6 === "GIF89a") return true; // GIF
		if (header.toString("latin1", 0, 4) === "RIFF" && header.toString("latin1", 8, 12) === "WEBP") return true; // WEBP
		return false;
	} catch {
		return false;
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Returns the resolved path when the whole pasted text is a single path to an
 * existing image file (verified by extension AND content signature),
 * otherwise `undefined` (the paste is inserted as text).
 */
export function resolvePastedImagePath(text: string, options?: ResolvePastedImagePathOptions): string | undefined {
	const candidate = decodePastedPathCandidate(text, options);
	if (!candidate || !IMAGE_FILE_EXTENSION_PATTERN.test(candidate)) return undefined;

	const resolved = path.resolve(options?.cwd ?? process.cwd(), candidate);
	try {
		if (!fs.statSync(resolved).isFile()) return undefined;
	} catch {
		return undefined;
	}
	if (!hasSupportedImageMagic(resolved)) return undefined;
	return resolved;
}

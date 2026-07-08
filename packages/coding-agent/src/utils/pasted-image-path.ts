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

const IMAGE_FILE_EXTENSION_PATTERN = /\.(?:png|jpe?g|gif|webp)$/i;

export interface ResolvePastedImagePathOptions {
	/** Base directory for relative paths. Defaults to `process.cwd()`. */
	cwd?: string;
	/** Home directory for `~/` expansion. Defaults to `os.homedir()`. */
	homedir?: string;
}

/**
 * Returns the resolved path when the whole pasted text is a single path to an
 * existing image file, otherwise `undefined` (the paste is inserted as text).
 *
 * Handles terminal drag-drop shell escaping (`\ `, `\(`, ...), quoted paths,
 * `file://` URIs, and `~/` expansion.
 */
export function resolvePastedImagePath(text: string, options?: ResolvePastedImagePathOptions): string | undefined {
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

	// file:// URIs (e.g. dropped from a file manager).
	if (candidate.startsWith("file://")) {
		try {
			candidate = decodeURIComponent(candidate.slice("file://".length));
		} catch {
			return undefined;
		}
	} else if (process.platform !== "win32") {
		// Terminal drag-drop escapes shell-special characters (`\ `, `\(`, ...).
		// Skipped on Windows where `\` is the path separator.
		candidate = candidate.replace(/\\(.)/g, "$1");
	}

	if (candidate.startsWith("~/")) {
		candidate = path.join(options?.homedir ?? os.homedir(), candidate.slice(2));
	}

	if (!IMAGE_FILE_EXTENSION_PATTERN.test(candidate)) return undefined;

	const resolved = path.resolve(options?.cwd ?? process.cwd(), candidate);
	try {
		if (!fs.statSync(resolved).isFile()) return undefined;
	} catch {
		return undefined;
	}
	return resolved;
}

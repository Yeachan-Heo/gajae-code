/**
 * Resolve line-display mode for file-like outputs (read, grep, @file mentions).
 */

import { resolveEditMode } from "./edit-mode";

export interface FileDisplayMode {
	lineNumbers: boolean;
	hashLines: boolean;
}

/** Session-like object providing settings and tool availability for display mode resolution. */
export interface FileDisplayModeSession {
	settings: {
		get(key: "readLineNumbers" | "edit.mode"): unknown;
	};
}

/**
 * Computes effective line display mode from session settings/env.
 * When `raw` is true, neither line numbers nor any addressing is applied.
 */
export function resolveFileDisplayMode(
	session: FileDisplayModeSession,
	options?: { raw?: boolean; immutable?: boolean },
): FileDisplayMode {
	const { settings } = session;
	const raw = options?.raw === true;
	return {
		hashLines: false,
		lineNumbers: !raw && settings.get("readLineNumbers") === true,
	};
}

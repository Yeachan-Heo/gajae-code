import { CString, dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";
import * as os from "node:os";

/** Resolve the TTY device path for stdin (fd 0) via POSIX `ttyname(3)`. */
export function getTtyPath(): string | null {
	if (os.platform() === "linux") {
		// Linux: /proc/self/fd/0 is a symlink to /dev/pts/N
		try {
			const ttyPath = fs.readlinkSync("/proc/self/fd/0");
			if (ttyPath.startsWith("/dev/")) {
				return ttyPath;
			}
		} catch {
			return null;
		}
	} else if (os.platform() !== "win32") {
		try {
			const libName = os.platform() === "darwin" ? "libSystem.B.dylib" : "libc.so.6";
			const lib = dlopen(libName, {
				ttyname: { args: [FFIType.i32], returns: FFIType.ptr },
			});
			try {
				const result = lib.symbols.ttyname(0);
				return result ? new CString(result).toString() : null;
			} finally {
				lib.close();
			}
		} catch {
			return null;
		}
	}
	return null;
}
/**
 * Get a stable identifier for the current terminal.
 * Uses the TTY device path (e.g., /dev/pts/3), falling back to environment
 * variables for terminal multiplexers or terminal emulators.
 * Returns null if no terminal can be identified (e.g., piped input).
 */
export function getTerminalId(): string | null {
	// Inside tmux the stdin TTY path is unstable (it tracks the attached
	// client, not the pane), which spawns duplicate sessions and breaks
	// /resume. Prefer the stable per-pane TMUX_PANE identifier instead.
	if (process.env.TMUX && process.env.TMUX_PANE) {
		return `tmux-${process.env.TMUX_PANE}`;
	}

	// TTY device path — most reliable, unique per terminal tab
	if (process.stdin.isTTY) {
		try {
			const ttyPath = getTtyPath();
			if (ttyPath?.startsWith("/dev/")) {
				return ttyPath.slice(5).replace(/\//g, "-"); // /dev/pts/3 -> pts-3
			}
		} catch {}
	}

	// Fallback to terminal-specific env vars
	const kittyId = process.env.KITTY_WINDOW_ID;
	if (kittyId) return `kitty-${kittyId}`;

	const tmuxPane = process.env.TMUX_PANE;
	if (tmuxPane) return `tmux-${tmuxPane}`;

	const terminalSessionId = process.env.TERM_SESSION_ID; // macOS Terminal.app
	if (terminalSessionId) return `apple-${terminalSessionId}`;

	const wtSession = process.env.WT_SESSION; // Windows Terminal
	if (wtSession) return `wt-${wtSession}`;

	return null;
}

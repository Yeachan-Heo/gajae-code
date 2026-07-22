/**
 * Shared source-vs-compiled runtime detection for daemon spawning.
 *
 * Centralizes the logic previously embedded in `ensureTelegramDaemonRunning`
 * so session autostart, reload, and status reporting agree on how a daemon
 * process is launched and whether a reload can pick up amended source.
 */

import * as path from "node:path";

export interface GjcRuntimeSpawnInfo {
	execPath: string;
	mode: "source" | "compiled";
	/** Prefix prepended before the gjc subcommand args; `[Bun.main]` in source mode, otherwise `[]`. */
	argsPrefix: string[];
	/** True only when respawn loads edited TypeScript directly (source/dev mode). */
	reloadPicksUpSourceEdits: boolean;
	/** Set in compiled mode to explain that a rebuild is required before reload picks up source edits. */
	warning?: string;
}

const COMPILED_RELOAD_WARNING =
	"Compiled binary: reload respawns the same binary. Rebuild the binary first for amended source to take effect.";

/**
 * Resolve how to spawn a detached gjc subcommand for the current runtime.
 *
 * Source/dev mode (bun/node) prepends the entry script (`Bun.main`) so the
 * respawn loads edited source. A compiled single-file binary self-spawns its
 * own subcommand directly and cannot pick up workspace source edits.
 */
export function resolveGjcRuntimeSpawnInfo(execPath: string = process.execPath): GjcRuntimeSpawnInfo {
	const base = path.basename(execPath).toLowerCase();
	const fromSource = base === "bun" || base === "node" || base.startsWith("bun") || base.startsWith("node");
	const sourceEntry = fromSource ? path.resolve(import.meta.dir, "../../bin/gjc.js") : undefined;
	if (fromSource) {
		return {
			execPath,
			mode: "source",
			argsPrefix: sourceEntry ? [sourceEntry] : [],
			reloadPicksUpSourceEdits: true,
		};
	}
	return {
		execPath,
		mode: "compiled",
		argsPrefix: [],
		reloadPicksUpSourceEdits: false,
		warning: COMPILED_RELOAD_WARNING,
	};
}

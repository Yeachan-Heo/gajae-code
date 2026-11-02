/**
 * Runs one of GJC's internal process probes from the current (project)
 * directory the way the app does: `@gajae-code/utils/env` loads first (copying
 * the project `.env` into the process environment), then the probe spawns its
 * helper (`ps` for process identity, `tmux -V` for multiplexer detection).
 * Only whether a planted loader preload ran matters, so probe results are ignored.
 */
import "@gajae-code/utils/env";
import { processStartTime } from "../../src/config/file-lock";
import { clearPsmuxDetectionCache, resolveGjcTmuxBinary } from "../../src/gjc-runtime/psmux-detect";

const op = process.argv[2];
if (op === "ps") processStartTime(process.pid);
else if (op === "tmux") {
	clearPsmuxDetectionCache();
	resolveGjcTmuxBinary({ env: { ...process.env, GJC_PSMUX_FORCE_DETECT: "1" }, platform: "linux" });
} else throw new Error(`unknown op ${op}`);
console.log(JSON.stringify({ done: true }));
process.exit(0);

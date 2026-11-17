/**
 * Arms the publication watchdog from a caller-chosen cwd. The parent plants a
 * decoy worker at the compiled-binary relative path and sets PI_COMPILED.
 * Source mode must load the worker next to this package, not that decoy.
 *
 * Usage: bun publication-liveness-worker-source-child.ts
 */
import * as fs from "node:fs";
import { armPublicationLivenessWatchdog } from "../src/sdk/broker/publication-liveness-watchdog";

const sentinel = process.env.HOSTILE_SENTINEL;
if (!sentinel) {
	fs.writeSync(2, "missing HOSTILE_SENTINEL\n");
	process.exit(2);
}

await armPublicationLivenessWatchdog({ role: "source-worker-guard" }, 60_000, 5_000);
if (fs.existsSync(sentinel)) {
	fs.writeSync(2, "hostile publication liveness worker executed\n");
	process.exit(3);
}
fs.writeSync(1, "armed\n");

// Prints the log directories in effect and, with GJC_PROBE_WRITE=1, drives a
// real `logger.error()` so the caller can assert the rotating transport lands
// where the resolver says it will. Spawned with a controlled cwd so the caller
// can plant a project `.env`: the trust snapshot behind `getEffectiveLogsDir()`
// is taken at module load from `process.cwd()`.
import * as fs from "node:fs";
import * as path from "node:path";
import { getEffectiveLogPath, getEffectiveLogsDir, getLogPath, getLogsDir } from "../../src/dirs";
import * as logger from "../../src/logger";

const MARKER = "gjc_log_dir_trust_probe_marker";

/** `getLogsDir()` throws when no trustworthy home is available; report that as null. */
function attempt(resolve: () => string): string | null {
	try {
		return resolve();
	} catch {
		return null;
	}
}

/** The first candidate directory holding a `gjc.*.log` that contains the marker. */
async function findMarkerDir(candidates: string[]): Promise<string | null> {
	for (const dir of candidates) {
		let entries: string[];
		try {
			entries = await fs.promises.readdir(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.startsWith("gjc.") || !entry.endsWith(".log")) continue;
			const text = await fs.promises.readFile(path.join(dir, entry), "utf8").catch(() => "");
			if (text.includes(MARKER)) return dir;
		}
	}
	return null;
}

const result: {
	effectiveLogsDir: string | null;
	effectiveLogPath: string | null;
	logsDir: string | null;
	logPath: string | null;
	markerDir: string | null;
} = {
	effectiveLogsDir: attempt(getEffectiveLogsDir),
	effectiveLogPath: attempt(getEffectiveLogPath),
	logsDir: attempt(getLogsDir),
	logPath: attempt(getLogPath),
	markerDir: null,
};

if (process.env.GJC_PROBE_WRITE === "1") {
	logger.error(MARKER);
	// Both candidates are searched so a transport that wrote to the *canonical*
	// directory is reported rather than silently read as "nothing written yet".
	const candidates = [result.effectiveLogsDir, result.logsDir].filter((dir): dir is string => dir !== null);
	// winston's file transport is async: poll instead of reading once.
	for (let attemptIndex = 0; attemptIndex < 50 && result.markerDir === null; attemptIndex++) {
		result.markerDir = await findMarkerDir(candidates);
		if (result.markerDir === null) await new Promise(resolve => setTimeout(resolve, 100));
	}
}

console.log(JSON.stringify(result));

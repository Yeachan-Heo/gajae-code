/**
 * Shared helpers for reading Linux `/proc/<pid>/stat` process start time.
 *
 * The `comm` field (field 2, wrapped in parentheses) may itself contain spaces
 * and parentheses, so the only robust anchor is the *last* `)` in the stat
 * string. Field 22 (the process start time in clock ticks since boot) is the
 * 20th whitespace-separated token after that closing paren (index 19).
 *
 * Every caller previously parsed this format independently, with subtly
 * different failure handling. This module fails closed: any malformed input
 * (missing `)`, non-numeric field 22, unreadable `/proc` file, non-Linux
 * platform) yields `null` rather than an inconsistent sentinel.
 */

import * as nodeFsSync from "node:fs";
import * as nodeFs from "node:fs/promises";

/**
 * Parse field 22 (process start time, in clock ticks since boot) from one
 * `/proc/<pid>/stat` record. Returns the raw numeric token, or `null` when the
 * record shape is malformed or field 22 is absent/non-numeric.
 */
export function parseLinuxProcStartTime(stat: string | null | undefined): string | null {
	if (!stat || stat.includes("\0") || stat.includes("\r")) return null;
	const record = stat.endsWith("\n") ? stat.slice(0, -1) : stat;
	if (!record || record.includes("\n")) return null;

	const open = record.indexOf(" (");
	const close = record.lastIndexOf(")");
	if (open < 1 || close <= open + 1 || !/^[1-9]\d*$/.test(record.slice(0, open))) return null;

	const suffix = record.slice(close + 1);
	if (!/^[ \t]+/.test(suffix)) return null;
	const fields = suffix.trim().split(/[ \t]+/);
	if (fields.length < 20 || !/^[RSDTtXZPI]$/.test(fields[0])) return null;

	const startTime = fields[19];
	return /^\d+$/.test(startTime) ? startTime : null;
}

/**
 * Read `/proc/<pid>/stat` synchronously and return the parsed start time.
 * Returns `null` on non-Linux platforms, unreadable files, or malformed input.
 */
export function readLinuxProcStartTimeSync(pid: number): string | null {
	if (process.platform !== "linux") return null;
	if (!Number.isSafeInteger(pid) || pid <= 0) return null;
	let stat: string;
	try {
		stat = nodeFsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return null;
	}
	return parseLinuxProcStartTime(stat);
}

/**
 * Read `/proc/<pid>/stat` asynchronously and return the parsed start time.
 * Returns `null` on non-Linux platforms, unreadable files, or malformed input.
 */
export async function readLinuxProcStartTime(pid: number): Promise<string | null> {
	if (process.platform !== "linux") return null;
	if (!Number.isSafeInteger(pid) || pid <= 0) return null;
	let stat: string;
	try {
		stat = await nodeFs.readFile(`/proc/${pid}/stat`, "utf8");
	} catch {
		return null;
	}
	return parseLinuxProcStartTime(stat);
}

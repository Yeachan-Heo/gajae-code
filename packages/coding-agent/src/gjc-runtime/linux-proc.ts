/**
 * Shared helpers for reading Linux `/proc/<pid>/stat` process identity fields.
 *
 * The `comm` field (field 2, wrapped in parentheses) may itself contain spaces
 * and parentheses, so the only robust anchor is the *last* `)` in the stat
 * string. Field 22 (the process start time in clock ticks since boot) is the
 * 20th whitespace-separated token after that closing paren (index 19). Field 7
 * (`tty_nr`) is the 5th token after the closing paren (index 4).
 */

import * as nodeFsSync from "node:fs";
import * as nodeFs from "node:fs/promises";

export interface LinuxProcStatIdentity {
	startTime: string;
	ttyDevice: string;
}

export type LinuxProcPidProbeResult =
	| ({ kind: "live" } & LinuxProcStatIdentity)
	| { kind: "absent" }
	| {
			kind: "unverifiable";
			reason: "unsupported_platform" | "invalid_pid" | "permission_denied" | "read_error" | "malformed_stat";
	  };

function parseLinuxProcIdentity(stat: string | null | undefined): LinuxProcStatIdentity | null {
	if (!stat || stat.includes("\0") || stat.includes("\r")) return null;
	const record = stat.endsWith("\n") ? stat.slice(0, -1) : stat;
	if (!record || record.includes("\n")) return null;

	const open = record.indexOf(" (");
	const close = record.lastIndexOf(")");
	if (open < 1 || close <= open + 1 || !/^[1-9]\d*$/.test(record.slice(0, open))) return null;

	const suffix = record.slice(close + 1);
	if (!/^[ \t]+/.test(suffix)) return null;
	const fields = suffix.trim().split(/[ \t]+/);
	if (fields.length < 20 || !/^[A-Za-z]$/.test(fields[0])) return null;
	const ttyDevice = fields[4];
	const startTime = fields[19];
	if (!ttyDevice || !/^-?\d+$/.test(ttyDevice) || !/^\d+$/.test(startTime)) return null;
	return { startTime, ttyDevice };
}

function classifyProcReadError(error: unknown): Extract<LinuxProcPidProbeResult, { kind: "absent" | "unverifiable" }> {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (code === "ENOENT" || code === "ESRCH") return { kind: "absent" };
	if (code === "EACCES" || code === "EPERM") return { kind: "unverifiable", reason: "permission_denied" };
	return { kind: "unverifiable", reason: "read_error" };
}

/** Parse field 22 (start time) from a `/proc/<pid>/stat` record. */
export function parseLinuxProcStartTime(stat: string | null | undefined): string | null {
	return parseLinuxProcIdentity(stat)?.startTime ?? null;
}

/** Parse field 7 (`tty_nr`) from a `/proc/<pid>/stat` record. */
export function parseLinuxProcTtyDevice(stat: string | null | undefined): string | null {
	return parseLinuxProcIdentity(stat)?.ttyDevice ?? null;
}

export function probeLinuxProcPidSync(pid: number): LinuxProcPidProbeResult {
	if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: "unverifiable", reason: "invalid_pid" };
	if (process.platform !== "linux") return { kind: "unverifiable", reason: "unsupported_platform" };
	let stat: string;
	try {
		stat = nodeFsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch (error) {
		return classifyProcReadError(error);
	}
	const identity = parseLinuxProcIdentity(stat);
	return identity ? { kind: "live", ...identity } : { kind: "unverifiable", reason: "malformed_stat" };
}

export async function probeLinuxProcPid(pid: number): Promise<LinuxProcPidProbeResult> {
	if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: "unverifiable", reason: "invalid_pid" };
	if (process.platform !== "linux") return { kind: "unverifiable", reason: "unsupported_platform" };
	let stat: string;
	try {
		stat = await nodeFs.readFile(`/proc/${pid}/stat`, "utf8");
	} catch (error) {
		return classifyProcReadError(error);
	}
	const identity = parseLinuxProcIdentity(stat);
	return identity ? { kind: "live", ...identity } : { kind: "unverifiable", reason: "malformed_stat" };
}

/**
 * Read `/proc/<pid>/stat` synchronously and return the parsed start time.
 * Returns `null` when the probe is absent or unverifiable.
 */
export function readLinuxProcStartTimeSync(pid: number): string | null {
	const probe = probeLinuxProcPidSync(pid);
	return probe.kind === "live" ? probe.startTime : null;
}

/**
 * Read `/proc/<pid>/stat` asynchronously and return the parsed start time.
 * Returns `null` when the probe is absent or unverifiable.
 */
export async function readLinuxProcStartTime(pid: number): Promise<string | null> {
	const probe = await probeLinuxProcPid(pid);
	return probe.kind === "live" ? probe.startTime : null;
}

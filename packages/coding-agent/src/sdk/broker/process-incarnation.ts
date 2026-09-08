import { dlopen, ptr } from "bun:ffi";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";
import { probeLinuxProcPidSync, readLinuxProcStartTimeSync } from "../../gjc-runtime/linux-proc";

const DARWIN_PROC_PIDTBSDINFO = 3;
const DARWIN_PROC_BSDINFO_SIZE = 136;
const DARWIN_PROC_BSDINFO_START_SECONDS_OFFSET = 120;
const DARWIN_PROC_BSDINFO_START_MICROSECONDS_OFFSET = 128;
const DARWIN_CTL_KERN = 1;
const DARWIN_KERN_PROC = 14;
const DARWIN_KERN_PROC_PID = 1;
/**
 * Read buffer for one `struct kinfo_proc`. The record measures 648 bytes on
 * 64-bit Darwin; the surplus keeps a larger record from failing with ENOMEM,
 * and `sysctl` reports the length it actually wrote.
 */
const DARWIN_KINFO_PROC_BUFFER_SIZE = 1024;
/** Byte offset of `kp_proc.p_stat` inside a 64-bit Darwin `struct kinfo_proc`. */
const DARWIN_KINFO_PROC_STATUS_OFFSET = 36;
/** Byte offset of `kp_proc.p_pid`, used to confirm the record layout. */
const DARWIN_KINFO_PROC_PID_OFFSET = 40;
/** Shortest record that still carries both the status byte and the PID. */
const DARWIN_KINFO_PROC_MIN_SIZE = DARWIN_KINFO_PROC_PID_OFFSET + 4;
/** `SZOMB` from `sys/proc.h`: exited, still holding a PID until the parent reaps it. */
const DARWIN_SZOMB = 5;
/** `Z` in field 3 of `/proc/<pid>/stat`: exited, awaiting a parent `wait()`. */
const LINUX_ZOMBIE_STATE = "Z";
const POWERSHELL_PROCESS_INCARNATION_COMMAND = "powershell.exe";
const WIN32_PROCESS_INCARNATION_OUTPUT = /^(\d+)\t(0|[1-9]\d*)(?:\r?\n)?$/;
const MAX_WINDOWS_FILETIME_TICKS = 18_446_744_073_709_551_615n;

const darwinProcLibrary =
	process.platform === "darwin"
		? (() => {
				try {
					return dlopen("/usr/lib/libproc.dylib", {
						proc_pidinfo: {
							args: ["i32", "i32", "u64", "ptr", "i32"],
							returns: "i32",
						},
					});
				} catch {
					return undefined;
				}
			})()
		: undefined;

const darwinSysctlLibrary =
	process.platform === "darwin"
		? (() => {
				try {
					return dlopen("/usr/lib/libSystem.B.dylib", {
						sysctl: {
							args: ["ptr", "u32", "ptr", "ptr", "ptr", "u64"],
							returns: "i32",
						},
					});
				} catch {
					return undefined;
				}
			})()
		: undefined;

type ProcessIncarnationCommandResult = { exitCode: number | null; stdout: string } | undefined;

export type ProcessIncarnationCommandRunner = (
	command: string,
	args: readonly string[],
) => ProcessIncarnationCommandResult;

export interface ProcessIncarnationOptions {
	platform?: typeof process.platform;
	runCommand?: ProcessIncarnationCommandRunner;
}

/** Options for the process-status probe, which reads the kernel directly. */
export interface ProcessStatusOptions {
	platform?: typeof process.platform;
}

/**
 * Hard ceiling on the PowerShell incarnation probe (#4544). A wedged
 * powershell.exe (profile policy, constrained language mode, AV interception)
 * must never block its caller indefinitely — the broker probes liveness inside
 * its heartbeat pass, and an unbounded synchronous spawn there starves the
 * machine-global session-index lock every later launch contends for.
 * `killSignal: "SIGKILL"` means even a TERM-ignoring process is reaped.
 */
const WIN32_INCARNATION_TIMEOUT_MS = 5_000;

function runProcessIncarnationCommand(command: string, args: readonly string[]): ProcessIncarnationCommandResult {
	try {
		const result = Bun.spawnSync([command, ...args], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
			windowsHide: true,
			timeout: WIN32_INCARNATION_TIMEOUT_MS,
			killSignal: "SIGKILL",
		});
		return { exitCode: result.exitCode, stdout: Buffer.from(result.stdout).toString("utf8") };
	} catch {
		return undefined;
	}
}

function windowsProcessIncarnationCommand(pid: number): { command: string; args: string[] } {
	return {
		command: POWERSHELL_PROCESS_INCARNATION_COMMAND,
		args: [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			[
				"$ErrorActionPreference = 'Stop'",
				"$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
				`$process = Get-Process -Id ${pid} -ErrorAction Stop`,
				"$filetime = [UInt64]($process.StartTime.ToUniversalTime().ToFileTimeUtc())",
				'[Console]::Out.WriteLine(("{0}`t{1}" -f $process.Id, $filetime))',
			].join("; "),
		],
	};
}

function isWindowsFiletimeTicks(value: string): boolean {
	if (!/^(?:0|[1-9]\d*)$/.test(value)) return false;
	try {
		return BigInt(value) <= MAX_WINDOWS_FILETIME_TICKS;
	} catch {
		return false;
	}
}

function parseWin32ProcessIncarnation(pid: number, output: string): string | undefined {
	const match = WIN32_PROCESS_INCARNATION_OUTPUT.exec(output);
	if (!match || match[1] !== String(pid) || !isWindowsFiletimeTicks(match[2])) return undefined;
	return `windows:${match[2]}`;
}

/** Parse the microsecond-resolution start timestamp returned by Darwin proc_pidinfo. */
export function parseDarwinProcessIncarnation(info: Uint8Array): string | undefined {
	if (info.byteLength < DARWIN_PROC_BSDINFO_SIZE) return undefined;
	try {
		const view = new DataView(info.buffer, info.byteOffset, info.byteLength);
		const seconds = view.getBigUint64(DARWIN_PROC_BSDINFO_START_SECONDS_OFFSET, true);
		const microseconds = view.getBigUint64(DARWIN_PROC_BSDINFO_START_MICROSECONDS_OFFSET, true);
		if (seconds === 0n || microseconds >= 1_000_000n) return undefined;
		return `darwin:${seconds}:${microseconds}`;
	} catch {
		return undefined;
	}
}

/**
 * Parse the BSD process status byte (`kp_proc.p_stat`) from a Darwin
 * `kinfo_proc` record describing `expectedPid`.
 *
 * The status is only returned when the record also carries that exact PID at
 * the offset this layout predicts. A kernel whose struct does not match would
 * otherwise hand back an unrelated byte that could read as a valid status, so
 * the PID doubles as a layout check and a wrong guess degrades to `undefined`
 * instead of a confident wrong answer.
 */
export function parseDarwinProcessStatus(
	info: Uint8Array,
	byteLength: number,
	expectedPid: number,
): number | undefined {
	if (byteLength < DARWIN_KINFO_PROC_MIN_SIZE || info.byteLength < DARWIN_KINFO_PROC_MIN_SIZE) return undefined;
	try {
		const view = new DataView(info.buffer, info.byteOffset, info.byteLength);
		if (view.getInt32(DARWIN_KINFO_PROC_PID_OFFSET, true) !== expectedPid) return undefined;
		return view.getUint8(DARWIN_KINFO_PROC_STATUS_OFFSET);
	} catch {
		return undefined;
	}
}

/**
 * True only when the OS positively confirms `pid` is a zombie: the process has
 * exited but its parent has not reaped it, so the kernel keeps the PID slot
 * occupied.
 *
 * This is the blind spot of every `process.kill(pid, 0)` liveness probe. The
 * signal lands on a live PID slot and succeeds, so a zombie reads as alive and
 * ownership records keyed on that PID can never be reclaimed. A daemon spawned
 * `detached` stays a child of its launcher until that launcher exits, so a
 * daemon that dies while its launcher is still running becomes exactly this
 * kind of unreapable owner.
 *
 * Absence of proof is never treated as proof: an unreadable probe, an
 * unsupported platform, or a missing PID all return `false` and leave the
 * caller's existing liveness answer intact. Only a kernel-reported zombie
 * status flips the result. On Darwin the `sysctl` path reports the status of
 * processes owned by other users too, so this stays authoritative where the
 * permission-limited `proc_pidinfo` probe is not.
 */
export function isZombieProcess(pid: number, options: ProcessStatusOptions = {}): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	const platform = options.platform ?? process.platform;
	if (platform === "linux") {
		const probe = probeLinuxProcPidSync(pid);
		return probe.kind === "live" && probe.state === LINUX_ZOMBIE_STATE;
	}
	if (platform !== "darwin" || !darwinSysctlLibrary) return false;
	try {
		const mib = new Int32Array([DARWIN_CTL_KERN, DARWIN_KERN_PROC, DARWIN_KERN_PROC_PID, pid]);
		const info = new Uint8Array(DARWIN_KINFO_PROC_BUFFER_SIZE);
		const length = new BigUint64Array([BigInt(info.byteLength)]);
		const rc = darwinSysctlLibrary.symbols.sysctl(ptr(mib), mib.length, ptr(info), ptr(length), null, 0n);
		if (rc !== 0) return false;
		// An unknown PID answers with rc === 0 and a zero-length record, which the
		// parser rejects as too short to carry a status.
		return parseDarwinProcessStatus(info, Number(length[0]), pid) === DARWIN_SZOMB;
	} catch {
		return false;
	}
}

/** Whether `value` is a canonical process-incarnation string (`linux:`/`darwin:`/`windows:`). */
export function isProcessIncarnation(value: unknown): value is string {
	return (
		typeof value === "string" &&
		(/^(?:linux:\d+|darwin:[1-9]\d*:\d+)$/.test(value) ||
			(value.startsWith("windows:") && isWindowsFiletimeTicks(value.slice("windows:".length))))
	);
}

/** A PID is reusable; bind it to the strongest OS-provided process start incarnation available. */
export function processIncarnation(pid: number, options: ProcessIncarnationOptions = {}): string | undefined {
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
	const platform = options.platform ?? process.platform;
	if (platform === process.platform && options.runCommand === undefined) {
		try {
			const nativeProcess = nativeProcessBindings().Process.fromPid(pid) as { incarnation?: unknown } | null;
			// null is the native binding's authoritative absent-process result: the
			// process is dead or its PID was never opened.  Returning undefined here
			// avoids repeatedly spawning powershell.exe (whose Get-Process uses the same
			// OpenProcess path and therefore cannot recover a valid incarnation either)
			// during the broker's ~5 s liveness polling, which on Windows 11 produces a
			// visible console window flash on every probe (#4362, #4367).
			if (nativeProcess === null) return undefined;
			if (isProcessIncarnation(nativeProcess?.incarnation)) return nativeProcess.incarnation;
		} catch {
			// Fall through to the platform-specific reader.
		}
	}
	if (platform === "linux") {
		const startTicks = readLinuxProcStartTimeSync(pid);
		return startTicks ? `linux:${startTicks}` : undefined;
	}
	if (platform === "darwin") {
		const info = new Uint8Array(DARWIN_PROC_BSDINFO_SIZE);
		try {
			const bytesRead = darwinProcLibrary?.symbols.proc_pidinfo(
				pid,
				DARWIN_PROC_PIDTBSDINFO,
				0,
				ptr(info),
				info.byteLength,
			);
			return bytesRead === DARWIN_PROC_BSDINFO_SIZE ? parseDarwinProcessIncarnation(info) : undefined;
		} catch {
			return undefined;
		}
	}
	if (platform === "win32") {
		const command = windowsProcessIncarnationCommand(pid);
		let result: ProcessIncarnationCommandResult;
		try {
			result = (options.runCommand ?? runProcessIncarnationCommand)(command.command, command.args);
		} catch {
			return undefined;
		}
		return result?.exitCode === 0 && typeof result.stdout === "string"
			? parseWin32ProcessIncarnation(pid, result.stdout)
			: undefined;
	}
	return undefined;
}

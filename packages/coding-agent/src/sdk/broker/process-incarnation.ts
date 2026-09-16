import { dlopen, ptr } from "bun:ffi";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";
import { readLinuxProcStartTimeSync } from "../../gjc-runtime/linux-proc";

const DARWIN_PROC_PIDTBSDINFO = 3;
const DARWIN_PROC_BSDINFO_SIZE = 136;
const DARWIN_PROC_BSDINFO_START_SECONDS_OFFSET = 120;
const DARWIN_PROC_BSDINFO_START_MICROSECONDS_OFFSET = 128;
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

type ProcessIncarnationCommandResult = { exitCode: number | null; stdout: string } | undefined;

export type ProcessIncarnationCommandRunner = (
	command: string,
	args: readonly string[],
) => ProcessIncarnationCommandResult;

export interface ProcessIncarnationOptions {
	platform?: typeof process.platform;
	runCommand?: ProcessIncarnationCommandRunner;
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

/** Whether `value` is a canonical process-incarnation string (`linux:`/`darwin:`/`windows:`). */
export function isProcessIncarnation(value: unknown): value is string {
	return (
		typeof value === "string" &&
		(/^(?:linux:\d+|darwin:[1-9]\d*:\d+)$/.test(value) ||
			(value.startsWith("windows:") && isWindowsFiletimeTicks(value.slice("windows:".length))))
	);
}

/**
 * Read-only, non-mutating observation of whether a pid currently names a
 * verifiable process incarnation.
 *
 * - `status: "present"` carries the exact kernel-reported identity evidence
 *   (the same value `processIncarnation` returns).
 * - `status: "absent"` is positive OS-confirmed death proof (POSIX
 *   `kill(pid, 0)` returning `ESRCH`, or Windows `OpenProcess` failing with
 *   the exact code the kernel reports for an unresolved client id) — never a
 *   permission failure or an ambiguous disappearance.
 * - `status: "unknown"` covers every inconclusive case (invalid pid, missing
 *   or unavailable native addon, permission denial, platform limitation).
 *   Callers MUST NOT treat this as death proof.
 */
export type ProcessIncarnationObservation =
	| { status: "present"; incarnation: string }
	| { status: "absent" }
	| { status: "unknown"; reasonCode: string };

/** Raw shape returned by the native `Process.observe` binding. */
export type NativeProcessObserveResult = { status?: unknown; incarnation?: unknown; reasonCode?: unknown };

export interface ObserveProcessIncarnationOptions {
	/**
	 * Injectable native observe function, used by tests to exercise error
	 * classification (malformed shapes, unavailable addon) without a global
	 * mock. Defaults to the real `Process.observe` binding.
	 */
	observe?: (pid: number) => NativeProcessObserveResult;
}

/**
 * Read-only process-incarnation observation for `pid`, distinguishing a
 * proved-live incarnation from positive OS-confirmed absence from every
 * inconclusive outcome. Never signals, kills, reaps, waits on, or spawns any
 * process — it only reads existing native process-table state via
 * `Process.observe`.
 *
 * `pid` must be a positive safe integer; any other value (including `0`,
 * negative, `NaN`, or non-integer) is reported as `unknown` rather than
 * risking an ambiguous platform-specific interpretation (`0`/negative PIDs
 * address process groups on POSIX, not a single process).
 */
export function observeProcessIncarnation(
	pid: number,
	options: ObserveProcessIncarnationOptions = {},
): ProcessIncarnationObservation {
	if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fff_ffff) {
		return { status: "unknown", reasonCode: "invalid_pid" };
	}
	try {
		const observe =
			options.observe ?? (nativeProcessBindings().Process as { observe?: (pid: number) => unknown }).observe;
		if (typeof observe !== "function") {
			// Older addon build predating Process.observe: liveness cannot be
			// determined through this path, and that is not death proof.
			return { status: "unknown", reasonCode: "observe_unavailable" };
		}
		const result = observe(pid) as NativeProcessObserveResult;
		if (result?.status === "present" && isProcessIncarnation(result.incarnation) && result.reasonCode === undefined) {
			return { status: "present", incarnation: result.incarnation };
		}
		if (result?.status === "absent" && result.incarnation === undefined && result.reasonCode === undefined) {
			return { status: "absent" };
		}
		if (
			result?.status === "unknown" &&
			result.incarnation === undefined &&
			typeof result.reasonCode === "string" &&
			/^[a-z][a-z0-9_]{0,63}$/.test(result.reasonCode)
		) {
			return { status: "unknown", reasonCode: result.reasonCode };
		}
		// A native result shape that matches none of the above (e.g. "present"
		// without a canonical incarnation) is a contract mismatch, not evidence of
		// anything — report unknown rather than guessing.
		return { status: "unknown", reasonCode: "malformed_observation" };
	} catch {
		// The native addon is missing/unloadable on this host. Not proof of
		// death: the caller has no OS confirmation either way.
		return { status: "unknown", reasonCode: "native_addon_unavailable" };
	}
}

/** A PID is reusable; bind it to the strongest OS-provided process start incarnation available. */
export function processIncarnation(pid: number, options: ProcessIncarnationOptions = {}): string | undefined {
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
	const platform = options.platform ?? process.platform;
	if (platform === process.platform && options.runCommand === undefined) {
		try {
			const nativeProcess = nativeProcessBindings().Process.fromPid(pid) as { incarnation?: unknown } | null;
			// A null native reference cannot provide an incarnation: the process
			// may be absent or inaccessible. Returning undefined here
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

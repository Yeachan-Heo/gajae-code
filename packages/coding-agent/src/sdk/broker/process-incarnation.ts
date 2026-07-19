import { dlopen, ptr } from "bun:ffi";
import { Process } from "@gajae-code/natives";
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

function runProcessIncarnationCommand(command: string, args: readonly string[]): ProcessIncarnationCommandResult {
	try {
		const result = Bun.spawnSync([command, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
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

/** A PID is reusable; bind it to the strongest OS-provided process start incarnation available. */
export function processIncarnation(pid: number, options: ProcessIncarnationOptions = {}): string | undefined {
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
	const platform = options.platform ?? process.platform;
	if (platform === process.platform && options.runCommand === undefined) {
		try {
			const nativeProcess = Process.fromPid(pid) as { incarnation?: unknown } | null;
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

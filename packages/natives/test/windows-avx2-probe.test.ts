/**
 * Regression for https://github.com/Yeachan-Heo/gajae-code/issues/4652.
 *
 * The native loader's AVX2 probe used to spawn an unhidded
 * `powershell.exe -Command [System.Runtime.Intrinsics.X86.Avx2]::IsSupported`
 * from every GJC process start on Windows. Two failures:
 *
 *   1. Console flash: `childProcess.spawnSync` had no `windowsHide`, so any
 *      detached, console-less parent (SDK broker, session hosts) made Windows
 *      allocate a visible OpenConsole/WindowsTerminal window per probe.
 *   2. Wrong variant: stock Windows PowerShell 5.1 runs on .NET Framework,
 *      which has no `System.Runtime.Intrinsics.X86.Avx2`, so the probe always
 *      failed and AVX2-capable machines silently selected the baseline addon.
 *
 * The fix probes `kernel32.dll!IsProcessorFeaturePresent(PF_AVX2)` in-process
 * via `bun:ffi` (no subprocess, no window) and keeps a `windowsHide`n
 * PowerShell 5.1-compatible P/Invoke fallback that fails safe to baseline.
 *
 * These tests are structural: they assert spawn options, command shape, and
 * selection outcomes against injected probe/command doubles, so they run on
 * POSIX CI without needing a real Windows console flash to observe.
 */
import { describe, expect, it, vi } from "bun:test";
import * as childProcess from "node:child_process";
import * as hostDetect from "../../../scripts/host-detect";
import { detectWin32Avx2Support as detectWin32Avx2SupportScript } from "../../../scripts/host-detect";
import { detectWin32Avx2Support, getAddonFilenames } from "../native/loader-state.js";

function win32SpawnResult(stdout: string) {
	return { error: null, status: 0, stdout, stderr: "" };
}

describe("windows AVX2 probe hides its subprocess (#4652)", () => {
	it("spawns PowerShell with windowsHide: true", () => {
		const calls: Array<{ command: unknown; args: unknown; options: unknown }> = [];
		const spawnSync = vi.spyOn(childProcess, "spawnSync").mockImplementation(((
			command: string,
			args: string[],
			options: object,
		) => {
			calls.push({ command, args, options });
			return win32SpawnResult("True\r\n");
		}) as unknown as typeof childProcess.spawnSync);

		try {
			// In-process probe unavailable → hidden PowerShell fallback runs.
			expect(detectWin32Avx2Support(() => undefined)).toBe(true);
			expect(calls.length).toBe(1);
			expect(calls[0]?.options).toMatchObject({ windowsHide: true, encoding: "utf-8" });
			expect(calls[0]?.command).toBe("powershell.exe");
		} finally {
			spawnSync.mockRestore();
		}
	});

	it("powershell fallback command is PowerShell 5.1 compatible", () => {
		const spawnSync = vi.spyOn(childProcess, "spawnSync").mockReturnValue(win32SpawnResult("True") as never);
		try {
			expect(detectWin32Avx2Support(() => undefined)).toBe(true);
			const args = (spawnSync.mock.calls[0]?.[1] ?? []) as string[];
			const commandText = args.join(" ");
			// P/Invoke through Add-Type works on .NET Framework (5.1) and .NET (pwsh 7+).
			expect(commandText).toContain("IsProcessorFeaturePresent");
			expect(commandText).toContain("DllImport");
			expect(commandText).toContain("40");
			// The 5.1-incompatible type probe must be gone.
			expect(commandText).not.toContain("System.Runtime.Intrinsics");
			expect(commandText).not.toContain("Avx2]::IsSupported");
		} finally {
			spawnSync.mockRestore();
		}
	});

	it("prefers the in-process kernel32 probe without spawning", () => {
		const spawnSync = vi.spyOn(childProcess, "spawnSync");
		try {
			expect(detectWin32Avx2Support(() => true)).toBe(true);
			expect(detectWin32Avx2Support(() => false)).toBe(false);
			expect(spawnSync).not.toHaveBeenCalled();
		} finally {
			spawnSync.mockRestore();
		}
	});

	it("fails safe to baseline when every probe fails", () => {
		const spawnSync = vi.spyOn(childProcess, "spawnSync").mockReturnValue(win32SpawnResult("") as never);
		try {
			// PowerShell wrote nothing (failed Add-Type, missing powershell.exe, …).
			expect(detectWin32Avx2Support(() => undefined)).toBe(false);
			// Non-zero exit → runCommand returns null → baseline.
			spawnSync.mockReturnValue({ error: null, status: 1, stdout: "", stderr: "" } as never);
			expect(detectWin32Avx2Support(() => undefined)).toBe(false);
		} finally {
			spawnSync.mockRestore();
		}
	});

	it("variant selection maps detection onto addon filenames", () => {
		expect(getAddonFilenames({ tag: "win32-x64", arch: "x64", variant: "modern" })).toEqual([
			"pi_natives.win32-x64-modern.node",
			"pi_natives.win32-x64-baseline.node",
			"pi_natives.win32-x64.node",
		]);
		// Detection false (probe failure or non-AVX2 CPU) selects baseline first;
		// a modern-only disk layout is still tolerated by the baseline→default order.
		expect(getAddonFilenames({ tag: "win32-x64", arch: "x64", variant: "baseline" })).toEqual([
			"pi_natives.win32-x64-baseline.node",
			"pi_natives.win32-x64.node",
		]);
	});

	it("non-Windows x64 platforms never spawn a probe subprocess", async () => {
		// resolveCpuVariant only consults detectAvx2Support on x64; linux reads
		// /proc/cpuinfo and darwin runs sysctl — neither uses PowerShell. The
		// win32 branch is unreachable for other platforms, which we pin by
		// asserting the PowerShell entry point is only referenced from the
		// win32 probe helper.
		const source = await Bun.file(`${import.meta.dir}/../native/loader-state.js`).text();
		const win32Branch = source.slice(source.indexOf('process.platform === "win32"'));
		const probeBlock = win32Branch.slice(0, win32Branch.indexOf("return false;"));
		expect(probeBlock).toContain("detectWin32Avx2Support");
		expect(probeBlock).not.toContain("powershell.exe");
		// The fallback's powershell spawn only happens through runCommand, which
		// is windowsHide-guarded (asserted above).
		expect(source).toMatch(/spawnSync\(command, args, \{ encoding: "utf-8", windowsHide: true \}\)/);
	});
});

describe("scripts/host-detect Windows AVX2 detection (#4652)", () => {
	it("uses the in-process kernel32 result without spawning PowerShell", () => {
		const command = vi.fn(() => "false");
		expect(detectWin32Avx2SupportScript(() => true, command)).toBe(true);
		expect(command).not.toHaveBeenCalled();
	});

	it("treats a negative kernel32 result as authoritative", () => {
		const command = vi.fn(() => "true");
		expect(detectWin32Avx2SupportScript(() => false, command)).toBe(false);
		expect(command).not.toHaveBeenCalled();
	});

	it("falls back to a PowerShell 5.1-compatible P/Invoke probe", () => {
		const command = vi.fn((_file: string, args: string[]) => {
			const commandText = args.join(" ");
			expect(commandText).toContain("IsProcessorFeaturePresent");
			expect(commandText).toContain("DllImport");
			expect(commandText).toContain("40");
			expect(commandText).not.toContain("System.Runtime.Intrinsics");
			return "True";
		});

		expect(detectWin32Avx2SupportScript(() => undefined, command)).toBe(true);
		expect(command).toHaveBeenCalledTimes(1);
		expect(command.mock.calls[0]?.[0]).toBe("powershell.exe");
	});

	it("fails safe to baseline when the fallback fails", () => {
		expect(
			detectWin32Avx2SupportScript(
				() => undefined,
				() => null,
			),
		).toBe(false);
		expect(
			detectWin32Avx2SupportScript(
				() => undefined,
				() => "False",
			),
		).toBe(false);
		expect(
			detectWin32Avx2SupportScript(
				() => undefined,
				() => "garbage",
			),
		).toBe(false);
	});

	it("spawns the fallback with windowsHide", () => {
		const spawnSync = vi.spyOn(Bun, "spawnSync").mockReturnValue({
			exitCode: 0,
			stdout: Buffer.from("True\n", "utf8"),
			stderr: Buffer.alloc(0),
			success: true,
			signalCode: null,
			resourceUsage: undefined,
		} as unknown as Bun.SyncSubprocess<"pipe", "pipe">);
		try {
			expect(hostDetect.detectWin32Avx2Support(() => undefined)).toBe(true);
			expect(spawnSync).toHaveBeenCalledTimes(1);
			const options = spawnSync.mock.calls[0]?.[1];
			expect(options).toMatchObject({ windowsHide: true, stdout: "pipe", stderr: "pipe" });
		} finally {
			spawnSync.mockRestore();
		}
	});

	it("non-win32 host detection paths do not invoke the Windows probe", async () => {
		const source = await Bun.file(`${import.meta.dir}/../../../scripts/host-detect.ts`).text();
		const win32Branch = source.slice(source.indexOf('if (process.platform === "win32")'));
		const block = win32Branch.slice(0, win32Branch.indexOf("\t}") + 2).trim();
		expect(block).toBe('if (process.platform === "win32") {\n\t\treturn detectWin32Avx2Support();\n\t}');
		// The old PowerShell-only System.Runtime.Intrinsics type probe (which
		// reads false on stock PowerShell 5.1) must be gone from the code.
		const intrinsicsProbe = source.match(/System\.Runtime\.Intrinsics[^\n]*Avx2/);
		expect(intrinsicsProbe).toBeNull();
	});
});

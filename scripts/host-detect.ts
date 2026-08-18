import { dlopen } from "bun:ffi";
import * as fs from "node:fs";

// `IsProcessorFeaturePresent(PF_AVX2_INSTRUCTIONS_AVAILABLE)` — the kernel's
// authoritative AVX2 answer, usable in-process on every supported Windows build.
const WIN32_PF_AVX2_INSTRUCTIONS_AVAILABLE = 40;

function runCommand(command: string, args: string[]): string | null {
	try {
		const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true });
		if (result.exitCode !== 0) return null;
		return result.stdout.toString("utf-8").trim();
	} catch {
		return null;
	}
}

function probeWin32Avx2InProcess(): boolean | undefined {
	try {
		const kernel32 = dlopen("kernel32.dll", {
			IsProcessorFeaturePresent: { args: ["i32"], returns: "bool" },
		});
		return Boolean(kernel32.symbols.IsProcessorFeaturePresent(WIN32_PF_AVX2_INSTRUCTIONS_AVAILABLE));
	} catch {
		return undefined;
	}
}

/**
 * Hidden PowerShell fallback for runtimes without FFI. `Add-Type` P/Invoke
 * works on both stock Windows PowerShell 5.1 (.NET Framework, which has no
 * System.Runtime.Intrinsics) and pwsh 7+. Failures fail safe to `false`.
 */
export function detectWin32Avx2Support(
	probe: () => boolean | undefined = probeWin32Avx2InProcess,
	command: (file: string, args: string[]) => string | null = runCommand,
): boolean {
	const probed = probe();
	if (probed !== undefined) return probed;

	const output = command("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		"Add-Type -Namespace GjcNative -Name Cpu -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern bool IsProcessorFeaturePresent(int feature);'; " +
			`[GjcNative.Cpu]::IsProcessorFeaturePresent(${WIN32_PF_AVX2_INSTRUCTIONS_AVAILABLE})`,
	]);
	return output !== null && output.toLowerCase() === "true";
}

export function detectHostAvx2Support(): boolean {
	if (process.arch !== "x64") return false;

	if (process.platform === "linux") {
		try {
			const cpuInfo = fs.readFileSync("/proc/cpuinfo", "utf8");
			return /\bavx2\b/i.test(cpuInfo);
		} catch {
			return false;
		}
	}

	if (process.platform === "darwin") {
		const leaf7 = runCommand("sysctl", ["-n", "machdep.cpu.leaf7_features"]);
		if (leaf7 && /\bAVX2\b/i.test(leaf7)) return true;
		const features = runCommand("sysctl", ["-n", "machdep.cpu.features"]);
		return Boolean(features && /\bAVX2\b/i.test(features));
	}

	if (process.platform === "win32") {
		return detectWin32Avx2Support();
	}

	return false;
}

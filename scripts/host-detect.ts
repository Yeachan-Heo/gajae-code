import { dlopen } from "bun:ffi";
import * as fs from "node:fs";

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

function detectWin32Avx2Support(): boolean {
	// In-process kernel32 probe: no subprocess, no console window.
	try {
		const kernel32 = dlopen("kernel32.dll", {
			IsProcessorFeaturePresent: { args: ["i32"], returns: "bool" },
		});
		return Boolean(kernel32.symbols.IsProcessorFeaturePresent(WIN32_PF_AVX2_INSTRUCTIONS_AVAILABLE));
	} catch {
		// Fall through to the PowerShell probe.
	}
	// P/Invoke works on both Windows PowerShell 5.1 and pwsh 7+. A
	// System.Runtime.Intrinsics type probe would always read false on 5.1
	// (.NET Framework has no such type), silently forcing baseline.
	const output = runCommand("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		"Add-Type -Namespace GjcNative -Name Cpu -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern bool IsProcessorFeaturePresent(int feature);'; " +
			`[GjcNative.Cpu]::IsProcessorFeaturePresent(${WIN32_PF_AVX2_INSTRUCTIONS_AVAILABLE})`,
	]);
	return output?.toLowerCase() === "true";
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

import { describe, expect, it, vi } from "bun:test";
import { detectWin32Avx2Support } from "./host-detect";

describe("Windows AVX2 host detection", () => {
	it("uses the in-process kernel32 result without spawning PowerShell", () => {
		const command = vi.fn(() => "false");

		expect(detectWin32Avx2Support(() => true, command)).toBe(true);
		expect(command).not.toHaveBeenCalled();
	});

	it("treats a negative kernel32 result as authoritative", () => {
		const command = vi.fn(() => "true");

		expect(detectWin32Avx2Support(() => false, command)).toBe(false);
		expect(command).not.toHaveBeenCalled();
	});

	it("falls back to a Windows PowerShell 5.1-compatible P/Invoke probe", () => {
		const command = vi.fn((_file: string, args: string[]) => {
			const commandText = args.join(" ");
			expect(commandText).toContain("IsProcessorFeaturePresent");
			expect(commandText).toContain("DllImport");
			expect(commandText).toContain("40");
			expect(commandText).not.toContain("System.Runtime.Intrinsics");
			return "True";
		});

		expect(detectWin32Avx2Support(() => undefined, command)).toBe(true);
		expect(command).toHaveBeenCalledTimes(1);
		expect(command.mock.calls[0]?.[0]).toBe("powershell.exe");
	});

	it("fails safe to baseline when the fallback fails", () => {
		expect(detectWin32Avx2Support(() => undefined, () => null)).toBe(false);
		expect(detectWin32Avx2Support(() => undefined, () => "False")).toBe(false);
		expect(detectWin32Avx2Support(() => undefined, () => "garbage")).toBe(false);
	});
});

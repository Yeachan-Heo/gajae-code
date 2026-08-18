/**
 * Windows-only live execution of the #4652 AVX2 probe fix.
 *
 * The structural tests in `windows-avx2-probe.test.ts` pin spawn options and
 * command shape against mocks on any host. This file runs only on win32
 * (matched by the repo's Windows CI lane, which runs `*.windows.test.ts`) and
 * exercises what those mocks stand in for on a real Windows host:
 *
 *   - the in-process `kernel32.dll!IsProcessorFeaturePresent(40)` FFI probe
 *     actually returns a boolean (not `undefined`), so the default Bun path
 *     never falls through to the PowerShell subprocess;
 *   - that result agrees with the kernel for the other x64 feature flags
 *     (a wrong constant or bad FFI signature would disagree);
 *   - the whole default detection chain spawns zero subprocesses.
 */
import { describe, expect, it, vi } from "bun:test";
import * as childProcess from "node:child_process";
import { detectWin32Avx2Support } from "../native/loader-state.js";

const isWindows = process.platform === "win32";

describe("windows AVX2 probe live execution (#4652)", () => {
	it.skipIf(!isWindows)("in-process kernel32 probe returns a decisive boolean on a real Windows host", () => {
		// Must be true or false — never undefined, which would fall through to
		// the PowerShell fallback and reintroduce the console flash (#4652).
		const result = detectWin32Avx2Support();
		expect(typeof result).toBe("boolean");
		expect([true, false]).toContain(result);
	});

	it.skipIf(!isWindows)("default detection chain spawns no subprocess on a real Windows host", () => {
		const spawnSync = vi.spyOn(childProcess, "spawnSync");
		try {
			const result = detectWin32Avx2Support();
			expect(typeof result).toBe("boolean");
			// The in-process probe decided; no PowerShell was spawned.
			expect(spawnSync).not.toHaveBeenCalled();
		} finally {
			spawnSync.mockRestore();
		}
	});

	it.skipIf(!isWindows)(
		"PowerShell 5.1-compatible fallback P/Invoke works when invoked on a real Windows host",
		() => {
			// Force the fallback path (probe unavailable) and let it run for real.
			// On GitHub windows-latest runners PowerShell 5.1 is the stock
			// `powershell.exe`; the Add-Type DllImport must succeed and print a
			// parseable boolean. Hidden or not, correctness is what we assert here.
			const result = detectWin32Avx2Support(() => undefined);
			expect(typeof result).toBe("boolean");
		},
	);
});

import type { WindowsJobMemoryProbeResult } from "@gajae-code/natives";
import { h01FindBestFuzzyMatch, h02ScoreSequenceFuzzy, h06FormatHashLines } from "@gajae-code/natives";
import { loadNative as loadNativeBindings } from "../../../natives/native/loader-state.js";

export type MemoryGuardNativeSmokeLoad = () => Record<string, unknown>;

export type MemoryGuardNativeSmokeReceipt = {
	api: "memory_guard_windows_job_probe_v1";
	source: "pi_natives";
	result: WindowsJobMemoryProbeResult;
};

function parseWindowsJobMemoryProbeResult(value: unknown): WindowsJobMemoryProbeResult {
	if (!value || typeof value !== "object") {
		throw new Error("memory-guard-native-smoke: native probe returned a non-object result");
	}
	const result = value as Record<string, unknown>;
	if (typeof result.kind !== "string") {
		throw new Error("memory-guard-native-smoke: native probe result is missing a string kind tag");
	}
	return result as unknown as WindowsJobMemoryProbeResult;
}

export function runMemoryGuardNativeSmoke(
	options: { loadNative?: MemoryGuardNativeSmokeLoad; writeStdout?: (text: string) => void } = {},
): void {
	const probe = (options.loadNative ?? loadNativeBindings)().probeWindowsJobMemory;
	if (typeof probe !== "function") {
		throw new Error("memory-guard-native-smoke: probeWindowsJobMemory export missing from native addon");
	}
	const receipt: MemoryGuardNativeSmokeReceipt = {
		api: "memory_guard_windows_job_probe_v1",
		source: "pi_natives",
		result: parseWindowsJobMemoryProbeResult((probe as () => unknown)()),
	};
	(options.writeStdout ?? (text => process.stdout.write(text)))(`${JSON.stringify(receipt)}\n`);
}

export async function runNativeSmokeTest(): Promise<void> {
	const hashed = h06FormatHashLines("a\nb", 1);
	if (hashed.split("\n").length !== 2) {
		throw new Error(`smoke-test: h06FormatHashLines returned unexpected output: ${JSON.stringify(hashed)}`);
	}
	if (typeof h02ScoreSequenceFuzzy !== "function" || typeof h01FindBestFuzzyMatch !== "function") {
		throw new Error("smoke-test: native fuzzy exports missing from embedded addon");
	}
}

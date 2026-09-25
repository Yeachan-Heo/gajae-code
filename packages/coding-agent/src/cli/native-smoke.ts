import type { WindowsJobMemoryProbeResult } from "@gajae-code/natives";

import { loadNative as loadNativeBindings } from "../../../natives/native/loader-state.js";

interface NativeSmokeDiffChange {
	value: string;
	count: number;
	added: boolean;
	removed: boolean;
}

interface NativeSmokeDiffRun {
	count: number;
	added: boolean;
	removed: boolean;
}

interface NativeSmokePatchHunk {
	lines: string[];
}

interface NativeSmokeBindings {
	editFindMatch?: (
		content: string,
		target: string,
		allowFuzzy: boolean,
		threshold?: number | null,
	) => { matched?: { actualText: string; startIndex: number; startLine: number; confidence: number } };
	editSeekSequence?: (
		lines: string[],
		pattern: string[],
		start: number,
		eof: boolean,
		allowFuzzy: boolean,
	) => { index?: number; confidence: number; strategy?: string };
	h06FormatHashLines(text: string, startLine?: number): string;
	diffLines(oldText: string, newText: string): NativeSmokeDiffChange[];
	diffLineRuns(oldText: string, newText: string): NativeSmokeDiffRun[];
	structuredPatchHunks(oldText: string, newText: string, context?: number): NativeSmokePatchHunk[];
	diffWords(oldText: string, newText: string): NativeSmokeDiffChange[];
	DiffStream?: unknown;
	PowerAssertion?: { start?: unknown };
}

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
	const native = loadNativeBindings() as unknown as NativeSmokeBindings;

	if (typeof native.h06FormatHashLines !== "function") {
		throw new Error("smoke-test: native h06FormatHashLines export missing from embedded addon");
	}

	const hashed = native.h06FormatHashLines("a\nb", 1);
	if (hashed.split("\n").length !== 2) {
		throw new Error(`smoke-test: h06FormatHashLines returned unexpected output: ${JSON.stringify(hashed)}`);
	}
	if (typeof native.editFindMatch !== "function" || typeof native.editSeekSequence !== "function") {
		throw new Error("smoke-test: native pi-edit matcher exports missing from embedded addon");
	}
	if (native.editFindMatch("alpha", "alpha", false, 0.95).matched?.actualText !== "alpha") {
		throw new Error("smoke-test: editFindMatch returned an unexpected result");
	}
	if (native.editSeekSequence(["before", "target"], ["target"], 0, false, true).index !== 1) {
		throw new Error("smoke-test: editSeekSequence returned an unexpected result");
	}

	const oldText = "old word\n";
	const newText = "new word\n";
	if (
		typeof native.diffLines !== "function" ||
		typeof native.diffLineRuns !== "function" ||
		typeof native.structuredPatchHunks !== "function" ||
		typeof native.diffWords !== "function" ||
		typeof native.DiffStream !== "function"
	) {
		throw new Error("smoke-test: native diff exports missing from embedded addon");
	}

	const lineChanges = native.diffLines(oldText, newText);
	if (!lineChanges.some(change => change.removed && change.value === oldText)) {
		throw new Error("smoke-test: native diffLines did not return the removed input");
	}
	if (!native.diffLineRuns(oldText, newText).some(run => run.added)) {
		throw new Error("smoke-test: native diffLineRuns did not return added tokens");
	}
	if (!native.structuredPatchHunks(oldText, newText, 3).some(hunk => hunk.lines.includes("+new word"))) {
		throw new Error("smoke-test: native structuredPatchHunks did not return the added line");
	}
	const wordChanges = native.diffWords("old word", "new word");
	if (!wordChanges.some(change => change.removed) || !wordChanges.some(change => change.added)) {
		throw new Error("smoke-test: native diffWords did not return added and removed words");
	}
	if (typeof native.DiffStream !== "function") {
		throw new Error("smoke-test: native DiffStream export missing from embedded addon");
	}
	if (typeof native.PowerAssertion?.start !== "function") {
		throw new Error("smoke-test: PowerAssertion export missing from embedded addon");
	}
}

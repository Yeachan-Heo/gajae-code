export interface NativeDiffChange {
	value: string;
	count: number;
	added: boolean;
	removed: boolean;
}

export interface NativeDiffRun {
	count: number;
	added: boolean;
	removed: boolean;
}

export interface NativePatchHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: string[];
}

interface NativeDiffBindings {
	diffLines(oldText: string, newText: string): NativeDiffChange[];
	diffLineRuns(oldText: string, newText: string): NativeDiffRun[];
	structuredPatchHunks(oldText: string, newText: string, context?: number): NativePatchHunk[];
	diffWords(oldText: string, newText: string): NativeDiffChange[];
}

let nativeDiffBindings: NativeDiffBindings | undefined;

export function getNativeDiffBindings(): NativeDiffBindings {
	if (!nativeDiffBindings) nativeDiffBindings = require("@gajae-code/natives") as NativeDiffBindings;
	return nativeDiffBindings;
}

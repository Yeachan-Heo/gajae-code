/** Native parser for OpenAI's `*** Begin Patch` envelope. */

import { ParseError } from "../diff";
import type { PatchInput } from "../modes/patch";

interface NativeApplyPatchEntry {
	path: string;
	op: PatchInput["op"];
	rename?: string;
	diff?: string;
}

interface NativeApplyPatchBindings {
	editParseApplyPatch(input: string, streaming: boolean): NativeApplyPatchEntry[];
}

function parseWithNative(patchText: string, streaming: boolean): PatchInput[] {
	try {
		const native = require("@gajae-code/natives") as NativeApplyPatchBindings;
		return native.editParseApplyPatch(patchText, streaming);
	} catch (error) {
		if (error instanceof ParseError) throw error;
		throw new ParseError(error instanceof Error ? error.message : String(error));
	}
}

export function parseApplyPatch(patchText: string): PatchInput[] {
	return parseWithNative(patchText, false);
}

/** Best-effort native parser for in-progress previews. */
export function parseApplyPatchStreaming(patchText: string): PatchInput[] {
	return parseWithNative(patchText, true);
}

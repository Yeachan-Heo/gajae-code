/**
 * Multi-file orchestrator for the OpenAI code backend `apply_patch` envelope.
 *
 * Decoupled from tool-registration: takes raw patch text + options, parses
 * it, and applies each hunk via the existing single-file `applyPatch` in
 * `../modes/patch.ts`. A future OpenAI freeform/grammar tool variant can
 * call this directly with the raw grammar output.
 *
 * Per spec §6.1, hunks are applied in order and NOT atomically — if hunk
 * N fails, hunks `0..N-1` are already on disk. We surface that by
 * returning the per-file results alongside the error when it happens.
 */

import { ApplyPatchError } from "../diff";
import {
	type ApplyPatchOptions,
	type ApplyPatchResult,
	applyPatch,
	type PatchInput,
	preflightPatchMkdir,
} from "../modes/patch";
import { parseApplyPatch } from "./parser";

export * from "./parser";

export interface ApplyCodexPatchResult {
	/** Single-file apply results in the order they were attempted. */
	results: ApplyPatchResult[];
	/** Affected file paths grouped by operation, for the §9.1 summary. */
	affected: {
		added: string[];
		modified: string[];
		deleted: string[];
	};
}

/**
 * Apply a full OpenAI code backend `*** Begin Patch` envelope.
 *
 * Note: renames are reported under `modified` with the original path (spec
 * §9.1), not as a delete + add.
 */
export async function applyCodexPatch(patchText: string, options: ApplyPatchOptions): Promise<ApplyCodexPatchResult> {
	const hunks = parseApplyPatch(patchText);

	if (hunks.length === 0) {
		throw new ApplyPatchError("No files were modified.");
	}

	const results: ApplyPatchResult[] = [];
	const affected = {
		added: [] as string[],
		modified: [] as string[],
		deleted: [] as string[],
	};

	// Containment is checked for every hunk before the first write. A later
	// I/O failure still leaves earlier hunks applied, per spec §6.1.
	for (const hunk of hunks) {
		await preflightPatchMkdir(hunk, options);
	}
	for (const hunk of hunks) {
		const result = await applyPatch(hunk, options);
		results.push(result);
		recordAffected(affected, hunk, result);
	}

	return { results, affected };
}

function recordAffected(
	affected: ApplyCodexPatchResult["affected"],
	hunk: PatchInput,
	_result: ApplyPatchResult,
): void {
	switch (hunk.op) {
		case "create":
			affected.added.push(hunk.path);
			break;
		case "delete":
			affected.deleted.push(hunk.path);
			break;
		case "update":
			affected.modified.push(hunk.path);
			break;
	}
}

/**
 * Format the A/M/D summary described in spec §9.1.
 */
export function formatApplyCodexPatchSummary(affected: ApplyCodexPatchResult["affected"]): string {
	const lines = ["Success. Updated the following files:"];
	for (const p of affected.added) lines.push(`A ${p}`);
	for (const p of affected.modified) lines.push(`M ${p}`);
	for (const p of affected.deleted) lines.push(`D ${p}`);
	return lines.join("\n");
}

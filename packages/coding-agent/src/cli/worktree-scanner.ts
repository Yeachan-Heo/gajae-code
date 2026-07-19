import type { BigIntStats, Dir } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import * as path from "node:path";

export const MAX_ENTRIES = 1024;
export const MAX_DEPTH = 2;

export type WorktreeRootErrorCode = "root-unreadable" | "root-invalid";

export class WorktreeRootError extends Error {
	constructor(readonly code: WorktreeRootErrorCode) {
		super(code);
		this.name = "WorktreeRootError";
	}
}

export interface ScanWorktreesOptions {
	root: string;
}

export type WorktreeKind = "pr-checkout" | "task-isolation" | "empty" | "stray" | "overflow" | "unsupported";

export interface WorktreeDiagnostic {
	path: string;
	kind: WorktreeKind;
	reasonCode: string;
	message: string;
}

interface Identity {
	dev: bigint;
	ino: bigint;
}

interface ScanState {
	visited: number;
	halted: boolean;
	diagnostics: WorktreeDiagnostic[];
	root: string;
}

interface LevelResult {
	seen: number;
	handled: number;
}

function codeOf(error: unknown): string | undefined {
	return (error as { code?: string }).code;
}

function displayPath(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]/g, character => {
		const code = character.charCodeAt(0);
		return `\\x${code.toString(16).padStart(2, "0").toUpperCase()}`;
	});
}

function addDiagnostic(
	state: ScanState,
	candidate: string,
	kind: WorktreeKind,
	reasonCode: string,
	message: string,
): void {
	state.diagnostics.push({ path: displayPath(candidate), kind, reasonCode, message });
}

function chargeEntry(state: ScanState): boolean {
	if (state.visited >= MAX_ENTRIES) {
		if (!state.halted)
			addDiagnostic(
				state,
				state.root,
				"overflow",
				"overflow",
				`scan limit exceeded: ${MAX_ENTRIES} entries; preserved`,
			);
		state.halted = true;
		return false;
	}
	state.visited++;
	return true;
}

function sameIdentity(identity: Identity, stat: BigIntStats): boolean {
	return identity.dev === stat.dev && identity.ino === stat.ino;
}

async function stableDirectory(candidate: string, identity: Identity): Promise<boolean> {
	try {
		const stat = await lstat(candidate, { bigint: true });
		return stat.isDirectory() && !stat.isSymbolicLink() && sameIdentity(identity, stat);
	} catch {
		return false;
	}
}

function replaceWithRaceDiagnostic(state: ScanState, candidate: string, diagnosticStart: number): void {
	state.diagnostics.splice(diagnosticStart);
	addDiagnostic(
		state,
		candidate,
		"unsupported",
		"metadata-raced",
		"filesystem metadata changed during scan; preserved",
	);
}

async function markerStat(marker: string): Promise<BigIntStats | undefined> {
	try {
		return await lstat(marker, { bigint: true });
	} catch (error) {
		const code = codeOf(error);
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw error;
	}
}

async function inspectCandidate(candidate: string, state: ScanState, depth: number): Promise<boolean> {
	const diagnosticStart = state.diagnostics.length;
	let stat: BigIntStats;
	try {
		stat = await lstat(candidate, { bigint: true });
	} catch (error) {
		addDiagnostic(
			state,
			candidate,
			"unsupported",
			codeOf(error) === "ENOENT" || codeOf(error) === "ENOTDIR" ? "metadata-raced" : "scan-error",
			"cannot inspect directory; preserved",
		);
		return true;
	}
	if (stat.isSymbolicLink()) {
		addDiagnostic(
			state,
			candidate,
			"unsupported",
			"unsupported-link",
			"link or reparse point encountered; preserved",
		);
		return true;
	}
	if (!stat.isDirectory()) return false;
	const identity: Identity = { dev: stat.dev, ino: stat.ino };

	try {
		const git = await markerStat(path.join(candidate, ".git"));
		if (git?.isSymbolicLink() || git?.isFile() || git?.isDirectory()) {
			if (!(await stableDirectory(candidate, identity))) {
				replaceWithRaceDiagnostic(state, candidate, diagnosticStart);
				return true;
			}
			if (git.isSymbolicLink())
				addDiagnostic(
					state,
					candidate,
					"unsupported",
					"unsupported-link",
					"link or reparse point encountered; preserved",
				);
			else addDiagnostic(state, candidate, "pr-checkout", "worktree-metadata", ".git metadata observed; preserved");
			return true;
		}

		const merged = await markerStat(path.join(candidate, "merged"));
		if (merged?.isSymbolicLink() || merged?.isDirectory()) {
			if (!(await stableDirectory(candidate, identity))) {
				replaceWithRaceDiagnostic(state, candidate, diagnosticStart);
				return true;
			}
			if (merged.isSymbolicLink())
				addDiagnostic(
					state,
					candidate,
					"unsupported",
					"unsupported-link",
					"link or reparse point encountered; preserved",
				);
			else
				addDiagnostic(state, candidate, "task-isolation", "task-isolation", "task-isolation directory; preserved");
			return true;
		}
	} catch {
		addDiagnostic(state, candidate, "unsupported", "scan-error", "cannot inspect directory; preserved");
		return true;
	}

	if (!(await stableDirectory(candidate, identity))) {
		replaceWithRaceDiagnostic(state, candidate, diagnosticStart);
		return true;
	}

	if (depth >= MAX_DEPTH) {
		const level = await scanLevel(candidate, state, depth + 1);
		if (!(await stableDirectory(candidate, identity))) {
			replaceWithRaceDiagnostic(state, candidate, diagnosticStart);
			return true;
		}
		if (level.handled === 0 && !state.halted)
			addDiagnostic(
				state,
				candidate,
				level.seen === 0 ? "empty" : "stray",
				level.seen === 0 ? "empty" : "stray",
				level.seen === 0 ? "empty directory; preserved" : "unrecognized directory contents; preserved",
			);
		return true;
	}

	const level = await scanLevel(candidate, state, depth + 1);
	if (!(await stableDirectory(candidate, identity))) {
		replaceWithRaceDiagnostic(state, candidate, diagnosticStart);
		return true;
	}
	if (level.handled === 0 && !state.halted)
		addDiagnostic(
			state,
			candidate,
			level.seen === 0 ? "empty" : "stray",
			level.seen === 0 ? "empty" : "stray",
			level.seen === 0 ? "empty directory; preserved" : "unrecognized directory contents; preserved",
		);
	return true;
}

async function scanLevel(dir: string, state: ScanState, depth: number): Promise<LevelResult> {
	let directory: Dir;
	try {
		directory = await opendir(dir);
	} catch (error) {
		if (dir === state.root)
			throw new WorktreeRootError(codeOf(error) === "ENOTDIR" ? "root-invalid" : "root-unreadable");
		addDiagnostic(state, dir, "unsupported", "scan-error", "cannot inspect directory; preserved");
		return { seen: 0, handled: 1 };
	}

	let seen = 0;
	let handled = 0;
	for await (const entry of directory) {
		seen++;
		if (!chargeEntry(state)) break;
		if (depth <= MAX_DEPTH && (entry.isDirectory() || entry.isSymbolicLink())) {
			if (await inspectCandidate(path.join(dir, entry.name), state, depth)) handled++;
		}
		if (state.halted) break;
	}
	return { seen, handled };
}

export async function scanWorktrees(options: ScanWorktreesOptions): Promise<WorktreeDiagnostic[]> {
	let root: BigIntStats;
	try {
		root = await lstat(options.root, { bigint: true });
	} catch (error) {
		if (codeOf(error) === "ENOENT") return [];
		throw new WorktreeRootError("root-unreadable");
	}
	if (root.isSymbolicLink() || !root.isDirectory()) throw new WorktreeRootError("root-invalid");

	const rootIdentity: Identity = { dev: root.dev, ino: root.ino };
	const state: ScanState = { visited: 0, halted: false, diagnostics: [], root: options.root };
	await scanLevel(options.root, state, 1);
	if (!(await stableDirectory(options.root, rootIdentity))) throw new WorktreeRootError("root-invalid");
	return state.diagnostics;
}

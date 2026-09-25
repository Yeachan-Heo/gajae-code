/**
 * Per-session cache of file contents as they were rendered to the model by
 * the `read` and `search` tools in the current agent session.
 *
 * Used by hashline-mode anchor-stale recovery: if the model authored anchors
 * against a version of the file that no longer matches what is on disk —
 * because a subagent, the user, a linter, or a formatter modified the file
 * between the read and the edit — we replay the edits against the cached
 * pre-edit snapshot and 3-way-merge the result onto the live file.
 *
 * Scoped per `ToolSession`: the cache lives on the session object itself, so
 * different sessions never share snapshots and entries get reclaimed when
 * the session goes out of scope. Each session keeps a small LRU window of
 * paths; the newest generation always reflects what *this* session most
 * recently saw, so it stays correct by construction even when this session
 * writes the file itself — the next read after the write refreshes the entry.
 *
 * When newly observed lines disagree with the newest generation (the file
 * changed, e.g. because this session just edited it), the previous generation
 * is retained behind the new one instead of being discarded. A model commonly
 * issues a follow-up edit with anchors from its original read after its own
 * edit shifted lines; recovery replays those anchors against the older
 * generation they were authored for.
 */
import { LRUCache } from "lru-cache/raw";
import type { ToolSession } from "../tools";

const MAX_PATHS_PER_SESSION = 30;
/** Snapshot generations retained per path (newest first). */
const MAX_GENERATIONS_PER_PATH = 4;

export interface FileReadSnapshot {
	/** 1-indexed line number → exact line content as observed by `read`/`search`. */
	lines: Map<number, string>;
	/** Total line count when the snapshot is known to cover the whole file. */
	lineCount?: number;
	recordedAt: number;
}

export class FileReadCache {
	#snapshots = new LRUCache<string, FileReadSnapshot[]>({ max: MAX_PATHS_PER_SESSION });

	/** Look up the most recent snapshot for `absPath`, or `null` if absent. */
	get(absPath: string): FileReadSnapshot | null {
		return this.#snapshots.get(absPath)?.[0] ?? null;
	}

	/** Every retained snapshot generation for `absPath`, newest first. */
	generations(absPath: string): readonly FileReadSnapshot[] {
		return this.#snapshots.get(absPath) ?? [];
	}

	/** Record a contiguous run of lines (e.g. from a `read` tool). `startLine` is 1-indexed. */
	recordContiguous(absPath: string, startLine: number, lines: readonly string[]): void {
		if (lines.length === 0) return;
		const entries: Array<readonly [number, string]> = lines.map((line, idx) => [startLine + idx, line] as const);
		this.#record(absPath, entries);
	}

	/** Record the complete content of a file (e.g. the result of an edit this session wrote). */
	recordFull(absPath: string, lines: readonly string[]): void {
		const entries: Array<readonly [number, string]> = lines.map((line, idx) => [idx + 1, line] as const);
		this.#record(absPath, entries, lines.length);
	}

	/** Record sparse `(lineNumber, content)` pairs (e.g. `search` matches plus context). */
	recordSparse(absPath: string, entries: Iterable<readonly [number, string]>): void {
		const arr = Array.from(entries);
		if (arr.length === 0) return;
		this.#record(absPath, arr);
	}

	/** Drop the snapshot for a single path. */
	invalidate(absPath: string): void {
		this.#snapshots.delete(absPath);
	}

	/** Drop every snapshot. */
	clear(): void {
		this.#snapshots.clear();
	}

	#record(absPath: string, entries: ReadonlyArray<readonly [number, string]>, lineCount?: number): void {
		const generations = this.#snapshots.get(absPath);
		const newest = generations?.[0];
		if (generations && newest && !hasConflict(newest, entries, lineCount)) {
			for (const [lineNum, content] of entries) newest.lines.set(lineNum, content);
			if (lineCount !== undefined) newest.lineCount = lineCount;
			newest.recordedAt = Date.now();
			// `get` above already touched LRU recency for this key.
			return;
		}
		// First observation, or the file changed since the newest generation:
		// start a fresh generation and keep the older ones behind it.
		const fresh: FileReadSnapshot = { lines: new Map(entries), lineCount, recordedAt: Date.now() };
		this.#snapshots.set(absPath, [fresh, ...(generations ?? [])].slice(0, MAX_GENERATIONS_PER_PATH));
	}
}

function hasConflict(
	existing: FileReadSnapshot,
	incoming: ReadonlyArray<readonly [number, string]>,
	incomingLineCount: number | undefined,
): boolean {
	for (const [lineNum, content] of incoming) {
		const prior = existing.lines.get(lineNum);
		if (prior !== undefined && prior !== content) return true;
		if (existing.lineCount !== undefined && lineNum > existing.lineCount) return true;
	}
	if (incomingLineCount !== undefined) {
		if (existing.lineCount !== undefined && existing.lineCount !== incomingLineCount) return true;
		for (const lineNum of existing.lines.keys()) if (lineNum > incomingLineCount) return true;
	}
	return false;
}

/**
 * Look up (or lazily create) the file-read cache attached to a session. The
 * cache is stored as `session.fileReadCache` so it lives exactly as long as
 * the session itself.
 */
export function getFileReadCache(session: ToolSession): FileReadCache {
	if (!session.fileReadCache) session.fileReadCache = new FileReadCache();
	return session.fileReadCache;
}

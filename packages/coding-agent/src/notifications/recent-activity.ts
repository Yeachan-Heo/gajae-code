/**
 * Recent-activity session picker (G006).
 *
 * Ranks GJC sessions by session-history file mtime (most recent first) and
 * enriches each with terminal-breadcrumb info, so a remote lifecycle client can
 * pick a repo to create in or a recent session to resume without typing raw
 * paths. Dependency-light + injectable so it is unit-testable over a temp dir.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** One ranked recent-session entry surfaced to the picker. */
export interface RecentSessionEntry {
	/** Session id (the `.jsonl` file stem). */
	sessionId: string;
	/** Working directory / repo path, when recoverable from the header. */
	path?: string;
	/** Branch, when recoverable from the header. */
	branch?: string;
	/** A short title (first user message), when recoverable. */
	title?: string;
	/** Absolute path of the session history (state) file. */
	sessionStateFile: string;
	/** Last-activity epoch-millis (history file mtime). */
	mtimeMs: number;
	/** True when a terminal breadcrumb points at this session file. */
	currentTerminal?: boolean;
}

export interface RecentActivityDeps {
	/** Root holding `<encoded-cwd>/<sessionId>.jsonl` history files. */
	sessionsRoot: string;
	/** Optional breadcrumb session-file paths (current terminals). */
	breadcrumbPaths?: string[];
	/** Max entries to return (default 20). */
	limit?: number;
	/** Injection seam for tests. */
	readFirstLine?: (file: string) => string | undefined;
}

function defaultReadFirstLine(file: string): string | undefined {
	try {
		const buf = fs.readFileSync(file, "utf8");
		const nl = buf.indexOf("\n");
		return nl === -1 ? buf : buf.slice(0, nl);
	} catch {
		return undefined;
	}
}

/** Best-effort header metadata extraction from a session file's first line. */
function headerMeta(line: string | undefined): { id?: string; path?: string; branch?: string; title?: string } {
	if (!line) return {};
	try {
		const obj = JSON.parse(line) as Record<string, unknown>;
		// Session headers vary; pull common fields defensively.
		const id = typeof obj.id === "string" ? obj.id : undefined;
		const cwd =
			typeof obj.cwd === "string" ? obj.cwd : typeof obj.projectDir === "string" ? obj.projectDir : undefined;
		const branch = typeof obj.branch === "string" ? obj.branch : undefined;
		const title = typeof obj.title === "string" ? obj.title : undefined;
		return { id, path: cwd, branch, title };
	} catch {
		return {};
	}
}

/**
 * The authoritative session id for a history file: the header `id` when present,
 * else the filename stem with a leading `<timestamp>_` prefix stripped (matching
 * SessionManager's `<isoTimestamp>_<id>.jsonl` naming), else the bare stem.
 */
function sessionIdForFile(stem: string, headerId: string | undefined): string {
	if (headerId) return headerId;
	const m = stem.match(/^\d{4}-\d{2}-\d{2}T[\d:.-]+Z?_(.+)$/);
	return m?.[1] ?? stem;
}

/**
 * List recent sessions ranked by history-file mtime (newest first).
 *
 * Scans `<sessionsRoot>/<encoded-cwd>/<sessionId>.jsonl`, stats each file, and
 * returns up to `limit` entries enriched with header metadata and a
 * `currentTerminal` flag for any breadcrumb-referenced session file.
 */
export function listRecentSessions(deps: RecentActivityDeps): RecentSessionEntry[] {
	const limit = deps.limit ?? 20;
	const readFirstLine = deps.readFirstLine ?? defaultReadFirstLine;
	const breadcrumbs = new Set((deps.breadcrumbPaths ?? []).map(p => path.resolve(p)));

	let projectDirs: string[];
	try {
		projectDirs = fs
			.readdirSync(deps.sessionsRoot, { withFileTypes: true })
			.filter(d => d.isDirectory())
			.map(d => path.join(deps.sessionsRoot, d.name));
	} catch {
		return [];
	}

	const entries: RecentSessionEntry[] = [];
	for (const dir of projectDirs) {
		let files: string[];
		try {
			files = fs.readdirSync(dir).filter(name => name.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const name of files) {
			const file = path.join(dir, name);
			let mtimeMs: number;
			try {
				mtimeMs = fs.statSync(file).mtimeMs;
			} catch {
				continue;
			}
			const meta = headerMeta(readFirstLine(file));
			entries.push({
				sessionId: sessionIdForFile(name.slice(0, -".jsonl".length), meta.id),
				path: meta.path,
				branch: meta.branch,
				title: meta.title,
				sessionStateFile: file,
				mtimeMs,
				currentTerminal: breadcrumbs.has(path.resolve(file)) || undefined,
			});
		}
	}

	entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return entries.slice(0, limit);
}

/**
 * ACP `session/list` is the saved-conversation-history surface (issue #7565).
 *
 * The broker index only retains sessions whose last event is inside its retention
 * window (`DEFAULT_SESSION_RETENTION_MAX_AGE_MS`), so the ACP layer merges the index
 * rows with the readonly managed-transcript scan that `session/load` and
 * `session/resume` already resolve through (`session.list` + `resolveSessionId`).
 * Only transcripts that lookup would resolve are listed, so every row stays openable.
 *
 * Pagination serves one immutable snapshot per traversal: the first page pays for the
 * index read and the transcript scan, every continuation page is a slice of that
 * snapshot plus bounded metadata reads for the rows it returns.
 */
import { randomUUID } from "node:crypto";
import type { SessionInfo } from "@agentclientprotocol/sdk";
import { AcpSdkAdapterError } from "../../sdk/acp";
import { resolveRecentSessionScopes } from "../../sdk/lifecycle/recent-sessions";
import {
	type ListManagedSessionCandidatesResult,
	listManagedSessionCandidates,
	type ManagedSessionScope,
	resolveManagedSessionScope,
} from "../../sdk/session-directory";
import { readSessionMetadata } from "../../sdk/session-readonly/metadata";

export const ACP_SESSION_PAGE_SIZE = 50;
export const ACP_SESSION_LIST_CURSOR_TTL_MS = 15 * 60 * 1_000;
/** Concurrent traversals retained per ACP connection; the oldest is evicted first. */
export const ACP_SESSION_LIST_MAX_SNAPSHOTS = 16;
const ACP_SESSION_TITLE_MAX_CHARS = 120;

/** A broker index row narrowed to what the history listing needs. */
export interface AcpIndexedSessionRow {
	sessionId: string;
	cwd: string;
	title?: string;
	/** Latest activity known for the indexed session, epoch ms. */
	activityMs?: number;
}

/** A saved transcript that the ACP load/resume lookup resolves to exactly one file. */
export interface AcpSavedTranscriptRow {
	sessionId: string;
	cwd: string;
	path: string;
	mtimeMs: number;
}

export interface AcpSessionHistoryRow {
	sessionId: string;
	cwd: string;
	title?: string;
	activityMs?: number;
	transcriptPath?: string;
}

/**
 * Keep only candidates the broker's `resolveSessionId` lookup accepts: exactly one owned
 * file for the id, no invalid candidate claiming the id, and a complete file identity.
 */
function resolvableTranscripts(
	listed: Extract<ListManagedSessionCandidatesResult, { kind: "complete" }>,
	cwd: string,
): AcpSavedTranscriptRow[] {
	const invalidIds = new Set(listed.invalid.flatMap(candidate => candidate.sessionId ?? []));
	const counts = new Map<string, number>();
	for (const candidate of listed.owned) counts.set(candidate.sessionId, (counts.get(candidate.sessionId) ?? 0) + 1);
	return listed.owned
		.filter(
			candidate =>
				counts.get(candidate.sessionId) === 1 &&
				!invalidIds.has(candidate.sessionId) &&
				candidate.identity.nlink !== undefined &&
				candidate.identity.ctimeNs !== undefined,
		)
		.map(candidate => ({
			sessionId: candidate.sessionId,
			cwd,
			path: candidate.path,
			mtimeMs: candidate.identity.mtimeMs,
		}));
}

async function scanScope(scope: ManagedSessionScope, cwd: string): Promise<AcpSavedTranscriptRow[]> {
	const listed = await listManagedSessionCandidates({ scope });
	if (listed.kind !== "complete")
		throw new AcpSdkAdapterError("unavailable", `Saved ACP sessions could not be listed: ${listed.message}`);
	return resolvableTranscripts(listed, cwd);
}

/**
 * List openable saved transcripts. With a cwd, only that workspace's managed scope is
 * read and rows carry `canonicalCwd`; a cwd with no resolvable scope has no openable
 * transcripts. Without a cwd, every validated workspace scope under the agent's
 * session root is read and rows carry the scope's canonical workspace path.
 */
export async function listAcpSavedTranscripts(input: {
	agentDir: string;
	cwd?: string;
	canonicalCwd?: string;
}): Promise<AcpSavedTranscriptRow[]> {
	if (input.cwd !== undefined) {
		const resolved = await resolveManagedSessionScope({ cwd: input.cwd, agentDir: input.agentDir });
		if (resolved.kind !== "resolved") return [];
		return await scanScope(resolved.scope, input.canonicalCwd ?? resolved.scope.canonicalCwd);
	}
	const scopes = await resolveRecentSessionScopes({ agentDir: input.agentDir, allWorkspaces: true });
	if (scopes.kind !== "complete")
		throw new AcpSdkAdapterError("unavailable", `Saved ACP sessions could not be listed: ${scopes.message}`);
	const rows: AcpSavedTranscriptRow[] = [];
	for (const scope of scopes.scopes) rows.push(...(await scanScope(scope, scope.canonicalCwd)));
	return rows;
}

function compareHistoryRows(left: AcpSessionHistoryRow, right: AcpSessionHistoryRow): number {
	if (left.activityMs !== right.activityMs) {
		if (left.activityMs === undefined) return 1;
		if (right.activityMs === undefined) return -1;
		return right.activityMs - left.activityMs;
	}
	return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0;
}

function maxActivity(left: number | undefined, right: number | undefined): number | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return Math.max(left, right);
}

/**
 * Merge index rows and saved transcripts into one row per session id, ordered by last
 * activity (newest first; ties and rows without activity by session id).
 *
 * `indexedIds` names every id the broker index holds, including rows filtered out by
 * cwd: the index is the authority for a session's workspace, so a transcript whose id
 * the index places elsewhere is not re-listed under another cwd.
 */
export function mergeAcpSessionHistory(
	indexed: readonly AcpIndexedSessionRow[],
	indexedIds: ReadonlySet<string>,
	transcripts: readonly AcpSavedTranscriptRow[],
): AcpSessionHistoryRow[] {
	const rows = new Map<string, AcpSessionHistoryRow>();
	for (const row of indexed) {
		if (rows.has(row.sessionId)) continue;
		rows.set(row.sessionId, {
			sessionId: row.sessionId,
			cwd: row.cwd,
			...(row.title ? { title: row.title } : {}),
			...(row.activityMs === undefined ? {} : { activityMs: row.activityMs }),
		});
	}
	const transcriptsById = new Map<string, AcpSavedTranscriptRow[]>();
	for (const transcript of transcripts) {
		const group = transcriptsById.get(transcript.sessionId);
		if (group) group.push(transcript);
		else transcriptsById.set(transcript.sessionId, [transcript]);
	}
	for (const [sessionId, group] of transcriptsById) {
		const indexedRow = rows.get(sessionId);
		// An indexed session keeps its own workspace; only that scope's transcript joins it.
		const candidates = indexedRow ? group.filter(transcript => transcript.cwd === indexedRow.cwd) : group;
		if (!indexedRow && indexedIds.has(sessionId)) continue;
		// The same id saved under two workspaces lists the most recent copy.
		const newest = candidates.reduce<AcpSavedTranscriptRow | undefined>(
			(best, transcript) => (best === undefined || transcript.mtimeMs > best.mtimeMs ? transcript : best),
			undefined,
		);
		if (!newest) continue;
		if (indexedRow) {
			indexedRow.transcriptPath = newest.path;
			indexedRow.activityMs = maxActivity(indexedRow.activityMs, newest.mtimeMs);
			continue;
		}
		rows.set(sessionId, {
			sessionId,
			cwd: newest.cwd,
			activityMs: newest.mtimeMs,
			transcriptPath: newest.path,
		});
	}
	return [...rows.values()].sort(compareHistoryRows);
}

function oneLineTitle(text: string): string | undefined {
	const line = text.replace(/\s+/gu, " ").trim();
	if (!line) return undefined;
	const chars = [...line];
	return chars.length > ACP_SESSION_TITLE_MAX_CHARS
		? `${chars.slice(0, ACP_SESSION_TITLE_MAX_CHARS - 1).join("")}…`
		: line;
}

/**
 * Render one page of rows as ACP `SessionInfo`. Live metadata published by this
 * connection names a row first, then the index title, then the transcript title or
 * first user message, then the session id. `updatedAt` is the snapshot activity the
 * rows were ordered by.
 */
export async function acpSessionInfos(
	rows: readonly AcpSessionHistoryRow[],
	liveMetadata: ReadonlyMap<string, { title?: string }>,
): Promise<SessionInfo[]> {
	const unnamed = rows.filter(row => !liveMetadata.get(row.sessionId)?.title && !row.title && row.transcriptPath);
	const transcriptTitles = new Map<string, string>();
	if (unnamed.length > 0) {
		for (const info of await readSessionMetadata(unnamed.map(row => row.transcriptPath!))) {
			const title =
				(info.title ? oneLineTitle(info.title) : undefined) ??
				(info.messageCount > 0 ? oneLineTitle(info.firstMessage) : undefined);
			if (title) transcriptTitles.set(info.path, title);
		}
	}
	return rows.map(row => ({
		sessionId: row.sessionId,
		cwd: row.cwd,
		title:
			liveMetadata.get(row.sessionId)?.title ||
			row.title ||
			(row.transcriptPath ? transcriptTitles.get(row.transcriptPath) : undefined) ||
			row.sessionId,
		...(row.activityMs === undefined ? {} : { updatedAt: new Date(row.activityMs).toISOString() }),
	}));
}

interface AcpSessionListSnapshot {
	cwd: string | undefined;
	rows: readonly AcpSessionHistoryRow[];
	expiresAt: number;
}

export interface AcpSessionListPage {
	rows: readonly AcpSessionHistoryRow[];
	nextCursor?: string;
}

/**
 * Opaque `session/list` cursors over immutable per-traversal snapshots. A cursor is
 * `<snapshot>.<offset>`, so a retried page request returns the same rows. Rows never
 * move between pages of one traversal; a new traversal starts without a cursor.
 */
export class AcpSessionListCursors {
	readonly #snapshots = new Map<string, AcpSessionListSnapshot>();
	readonly #now: () => number;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	start(cwd: string | undefined, rows: readonly AcpSessionHistoryRow[]): AcpSessionListPage {
		if (rows.length <= ACP_SESSION_PAGE_SIZE) return { rows };
		this.#prune();
		const token = randomUUID();
		this.#snapshots.set(token, { cwd, rows, expiresAt: this.#now() + ACP_SESSION_LIST_CURSOR_TTL_MS });
		while (this.#snapshots.size > ACP_SESSION_LIST_MAX_SNAPSHOTS) {
			const oldest = this.#snapshots.keys().next().value;
			if (oldest === undefined) break;
			this.#snapshots.delete(oldest);
		}
		return this.#page(token, rows, 0);
	}

	resume(cursor: string, cwd: string | undefined): AcpSessionListPage {
		const match = /^([0-9a-f-]{36})\.(\d{1,9})$/u.exec(cursor);
		const snapshot = match ? this.#snapshots.get(match[1]) : undefined;
		if (!match || !snapshot || snapshot.expiresAt <= this.#now()) {
			if (match) this.#snapshots.delete(match[1]);
			throw new AcpSdkAdapterError(
				"invalid_input",
				`Invalid or expired ACP session cursor: ${cursor}. Restart session/list without a cursor.`,
			);
		}
		if (snapshot.cwd !== cwd)
			throw new AcpSdkAdapterError("invalid_input", "ACP session cursor was issued for a different cwd.");
		const offset = Number(match[2]);
		if (offset <= 0 || offset >= snapshot.rows.length)
			throw new AcpSdkAdapterError("invalid_input", `Invalid ACP session cursor: ${cursor}`);
		return this.#page(match[1], snapshot.rows, offset);
	}

	clear(): void {
		this.#snapshots.clear();
	}

	#page(token: string, rows: readonly AcpSessionHistoryRow[], offset: number): AcpSessionListPage {
		const end = offset + ACP_SESSION_PAGE_SIZE;
		return {
			rows: rows.slice(offset, end),
			...(end < rows.length ? { nextCursor: `${token}.${end}` } : {}),
		};
	}

	#prune(): void {
		const now = this.#now();
		for (const [token, snapshot] of this.#snapshots) if (snapshot.expiresAt <= now) this.#snapshots.delete(token);
	}
}

/**
 * Boundary session resolution for GJC workflow state.
 *
 * This is the impure companion to the pure `session-layout.ts`. Only CLI /
 * runtime entrypoints call these resolvers; low-level readers and writers
 * receive an explicit `gjcSessionId` (or a path produced by the pure helper) so
 * no module silently picks a session.
 *
 * Resolution order:
 *   1. explicit `--session-id` flag (blank is invalid, never suppressed)
 *   2. payload `session_id`
 *   3. `GJC_SESSION_ID` env var
 *   4. latest-activity-marker auto-detect (READ/STATUS/CLEAR only)
 *
 * Writes require one of (1)-(3). Auto-detect fails closed on zero candidates or
 * ambiguous ties.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	GJC_SESSION_ACTIVITY_FILE,
	type GjcSessionContext,
	type GjcSessionSource,
	gjcRoot,
	sessionIdFromDirName,
	sessionRoot,
} from "./session-layout";

/** Window within which two activity timestamps are treated as an ambiguous tie. */
export const LATEST_SESSION_TIE_WINDOW_MS = 1000;

export interface SessionIdSources {
	/** Raw `--session-id` value: `undefined` = flag absent; `""` = present-but-blank (invalid). */
	flagValue?: string | undefined;
	payloadSessionId?: unknown;
	envSessionId?: string | undefined;
}

export class SessionResolutionError extends Error {
	constructor(
		message: string,
		readonly code: "blank_flag" | "no_session" | "ambiguous" | "missing_for_write",
	) {
		super(message);
		this.name = "SessionResolutionError";
	}
}

interface ResolvedFromSources {
	gjcSessionId: string;
	source: GjcSessionSource;
}

/**
 * Resolve a session id from explicit sources only (flag -> payload -> env).
 * Returns `undefined` when none is present. A blank explicit flag throws.
 */
export function resolveSessionIdFromSources(sources: SessionIdSources): ResolvedFromSources | undefined {
	const { flagValue, payloadSessionId, envSessionId } = sources;
	if (flagValue !== undefined) {
		const trimmed = flagValue.trim();
		if (trimmed === "") {
			throw new SessionResolutionError(
				"--session-id was provided but blank; pass a non-empty session id or omit the flag",
				"blank_flag",
			);
		}
		return { gjcSessionId: trimmed, source: "flag" };
	}
	if (typeof payloadSessionId === "string" && payloadSessionId.trim() !== "") {
		return { gjcSessionId: payloadSessionId.trim(), source: "payload" };
	}
	if (typeof envSessionId === "string" && envSessionId.trim() !== "") {
		return { gjcSessionId: envSessionId.trim(), source: "env" };
	}
	return undefined;
}

/** Resolve session context for a WRITE command. Errors when no explicit id is present. */
export function resolveGjcSessionForWrite(cwd: string, sources: SessionIdSources): GjcSessionContext {
	const resolved = resolveSessionIdFromSources(sources);
	if (!resolved) {
		throw new SessionResolutionError(
			"a session id is required to write state: pass --session-id, payload session_id, or set GJC_SESSION_ID",
			"missing_for_write",
		);
	}
	return {
		gjcSessionId: resolved.gjcSessionId,
		sessionRoot: sessionRoot(cwd, resolved.gjcSessionId),
		source: resolved.source,
	};
}

/**
 * Resolve session context for a READ/STATUS/CLEAR command. Falls back to the
 * latest active session by activity marker when no explicit id is present.
 */
export async function resolveGjcSessionForRead(cwd: string, sources: SessionIdSources): Promise<GjcSessionContext> {
	const resolved = resolveSessionIdFromSources(sources);
	if (resolved) {
		return {
			gjcSessionId: resolved.gjcSessionId,
			sessionRoot: sessionRoot(cwd, resolved.gjcSessionId),
			source: resolved.source,
		};
	}
	const latest = await detectLatestSession(cwd);
	return { gjcSessionId: latest.gjcSessionId, sessionRoot: latest.sessionRoot, source: "latest" };
}

interface SessionCandidate {
	gjcSessionId: string;
	sessionRoot: string;
	activityMs: number;
}

/**
 * Scan `.gjc/_session-*` directories and select the most-recently-active one by
 * its activity marker. Never uses raw directory mtime. Throws on zero candidates
 * or an ambiguous tie.
 */
export async function detectLatestSession(cwd: string): Promise<GjcSessionContext> {
	const candidates = await collectActiveSessionCandidates(cwd);
	if (candidates.length === 0) {
		throw new SessionResolutionError(
			"no active GJC session found: pass --session-id or set GJC_SESSION_ID",
			"no_session",
		);
	}
	candidates.sort((a, b) => b.activityMs - a.activityMs);
	const [first, second] = candidates;
	if (second && first.activityMs - second.activityMs <= LATEST_SESSION_TIE_WINDOW_MS) {
		const tied = candidates
			.filter(c => first.activityMs - c.activityMs <= LATEST_SESSION_TIE_WINDOW_MS)
			.map(c => c.gjcSessionId);
		throw new SessionResolutionError(
			`ambiguous latest session among [${tied.join(", ")}]: pass --session-id or set GJC_SESSION_ID`,
			"ambiguous",
		);
	}
	return { gjcSessionId: first.gjcSessionId, sessionRoot: first.sessionRoot, source: "latest" };
}

async function collectActiveSessionCandidates(cwd: string): Promise<SessionCandidate[]> {
	const root = gjcRoot(cwd);
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const candidates: SessionCandidate[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const gjcSessionId = sessionIdFromDirName(entry.name);
		if (!gjcSessionId) continue;
		const dir = path.join(root, entry.name);
		const activityMs = await readActivityMs(path.join(dir, GJC_SESSION_ACTIVITY_FILE));
		// Sessions with no readable activity marker are considered inactive and
		// are not selected for auto-detect.
		if (activityMs === undefined) continue;
		candidates.push({ gjcSessionId, sessionRoot: dir, activityMs });
	}
	return candidates;
}

async function readActivityMs(markerPath: string): Promise<number | undefined> {
	let raw: string;
	try {
		raw = await fs.readFile(markerPath, "utf-8");
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as { updated_at?: unknown };
		if (typeof parsed.updated_at === "string") {
			const ms = Date.parse(parsed.updated_at);
			if (!Number.isNaN(ms)) return ms;
		}
	} catch {
		// fall through to mtime
	}
	try {
		const stat = await fs.stat(markerPath);
		return stat.mtimeMs;
	} catch {
		return undefined;
	}
}

export interface ActivityMarkerInfo {
	writer: string;
	/** Relative generated path that was just written, for diagnostics. */
	path?: string;
}

/**
 * Best-effort write of the per-session activity marker. State-command callers
 * MUST treat a thrown error as a command failure (auto-detect depends on it);
 * non-critical writers may swallow it.
 */
export async function writeSessionActivityMarker(
	cwd: string,
	gjcSessionId: string,
	info: ActivityMarkerInfo,
): Promise<void> {
	const markerPath = path.join(sessionRoot(cwd, gjcSessionId), GJC_SESSION_ACTIVITY_FILE);
	await fs.mkdir(path.dirname(markerPath), { recursive: true });
	const payload = {
		session_id: gjcSessionId,
		updated_at: new Date().toISOString(),
		writer: info.writer,
		...(info.path ? { path: info.path } : {}),
	};
	await fs.writeFile(markerPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

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
import type { Dirent } from "node:fs";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	canonicalSessionRoot,
	GJC_SESSION_ACTIVITY_FILE,
	GJC_SESSION_PREFIX,
	type GjcSessionContext,
	type GjcSessionLayout,
	type GjcSessionSource,
	gjcRoot,
	gjcSessionsRoot,
	legacySessionRoot,
	sessionDirName,
	sessionIdFromDirName,
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
		readonly code: "blank_flag" | "unsafe_session" | "no_session" | "ambiguous" | "duplicate" | "missing_for_write",
	) {
		super(message);
		this.name = "SessionResolutionError";
	}
}

function assertSafeResolvedSessionId(sessionId: string): void {
	if (sessionId === "." || sessionId === ".." || /[/\\]/.test(sessionId)) {
		throw new SessionResolutionError(
			"session id must be a single path component (no separators or traversal)",
			"unsafe_session",
		);
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
		assertSafeResolvedSessionId(trimmed);
		return { gjcSessionId: trimmed, source: "flag" };
	}
	if (typeof payloadSessionId === "string" && payloadSessionId.trim() !== "") {
		const trimmed = payloadSessionId.trim();
		assertSafeResolvedSessionId(trimmed);
		return { gjcSessionId: trimmed, source: "payload" };
	}
	if (typeof envSessionId === "string" && envSessionId.trim() !== "") {
		const trimmed = envSessionId.trim();
		assertSafeResolvedSessionId(trimmed);
		return { gjcSessionId: trimmed, source: "env" };
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
	return resolveExistingSessionContext(cwd, resolved.gjcSessionId, resolved.source);
}

/**
 * Resolve session context for a READ/STATUS/CLEAR command. Falls back to the
 * latest active session by activity marker when no explicit id is present.
 */
export async function resolveGjcSessionForRead(cwd: string, sources: SessionIdSources): Promise<GjcSessionContext> {
	const resolved = resolveSessionIdFromSources(sources);
	if (resolved) return resolveExistingSessionContext(cwd, resolved.gjcSessionId, resolved.source);
	return detectLatestSession(cwd);
}

interface SessionCandidate {
	gjcSessionId: string;
	sessionRoot: string;
	layout: GjcSessionLayout;
	activityMs: number;
}

/**
 * Scan canonical and legacy `_session-*` directories and select the
 * most-recently-active one by its activity marker. Never uses raw directory
 * mtime. Throws on zero candidates, duplicate ids, or an ambiguous tie.
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
	return {
		gjcSessionId: first.gjcSessionId,
		sessionRoot: first.sessionRoot,
		layout: first.layout,
		source: "latest",
	};
}

function duplicateSessionError(gjcSessionId: string): SessionResolutionError {
	return new SessionResolutionError(`duplicate GJC session roots for session id "${gjcSessionId}"`, "duplicate");
}

function isDirectory(root: string): boolean {
	try {
		const stat = fsSync.lstatSync(root);
		if (stat.isSymbolicLink()) {
			throw new SessionResolutionError(`GJC session root must not be a symbolic link: ${root}`, "unsafe_session");
		}
		if (!stat.isDirectory()) throw new Error(`GJC session root is not a directory: ${root}`);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function resolveExistingSessionContext(cwd: string, gjcSessionId: string, source: GjcSessionSource): GjcSessionContext {
	const canonicalRoot = canonicalSessionRoot(cwd, gjcSessionId);
	const legacyRoot = legacySessionRoot(cwd, gjcSessionId);
	const hasCanonical = isDirectory(canonicalRoot);
	const hasLegacy = isDirectory(legacyRoot);
	if (hasCanonical && hasLegacy) throw duplicateSessionError(gjcSessionId);
	if (hasLegacy) return { gjcSessionId, sessionRoot: legacyRoot, layout: "legacy", source };
	return {
		gjcSessionId,
		sessionRoot: canonicalRoot,
		layout: "canonical",
		source,
	};
}

async function collectActiveSessionCandidates(cwd: string): Promise<SessionCandidate[]> {
	const roots: readonly [GjcSessionLayout, string][] = [
		["canonical", gjcSessionsRoot(cwd)],
		["legacy", gjcRoot(cwd)],
	];
	const sessions = new Map<string, { sessionRoot: string; layout: GjcSessionLayout }>();
	for (const [layout, root] of roots) {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(root, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		for (const entry of entries) {
			if (!entry.name.startsWith(GJC_SESSION_PREFIX)) continue;
			const gjcSessionId = sessionIdFromDirName(entry.name);
			if (!gjcSessionId || entry.name !== sessionDirName(gjcSessionId) || !entry.isDirectory()) {
				throw new SessionResolutionError(
					`invalid GJC session root entry: ${path.join(root, entry.name)}`,
					"unsafe_session",
				);
			}
			assertSafeResolvedSessionId(gjcSessionId);
			const sessionRoot = path.join(root, entry.name);
			if (sessions.has(gjcSessionId)) throw duplicateSessionError(gjcSessionId);
			sessions.set(gjcSessionId, { sessionRoot, layout });
		}
	}
	const candidates: SessionCandidate[] = [];
	for (const [gjcSessionId, session] of sessions) {
		const activityMs = await readActivityMs(path.join(session.sessionRoot, GJC_SESSION_ACTIVITY_FILE));
		// Sessions with no readable activity marker are considered inactive and
		// are not selected for auto-detect.
		if (activityMs === undefined) continue;
		candidates.push({ gjcSessionId, ...session, activityMs });
	}
	return candidates;
}

async function readActivityMs(markerPath: string): Promise<number | undefined> {
	let raw: string;
	try {
		raw = await fs.readFile(markerPath, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
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
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
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
 * non-critical writers may swallow it. This context-first variant writes to an
 * already admitted session root so callers preserve layout affinity.
 */
export async function writeSessionActivityMarkerForSession(
	session: GjcSessionContext,
	info: ActivityMarkerInfo,
): Promise<void> {
	const markerPath = path.join(session.sessionRoot, GJC_SESSION_ACTIVITY_FILE);
	await fs.mkdir(path.dirname(markerPath), { recursive: true });
	const payload = {
		session_id: session.gjcSessionId,
		updated_at: new Date().toISOString(),
		writer: info.writer,
		...(info.path ? { path: info.path } : {}),
	};
	await fs.writeFile(markerPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

export async function writeSessionActivityMarker(
	cwd: string,
	gjcSessionId: string,
	info: ActivityMarkerInfo,
): Promise<void> {
	const session = resolveExistingSessionContext(cwd, gjcSessionId, "payload");
	await writeSessionActivityMarkerForSession(session, info);
}

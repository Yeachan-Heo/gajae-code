/**
 * Typed, redacted projection from the coordinator's bounded status into the
 * chat transmitted-data allowlist (docs/telegram-remote.md "Transmitted-data
 * contract"). Projections are built field-by-field from raw records — never by
 * spreading — so non-allowlisted fields (raw tail, transcripts, tool IO, diffs,
 * file contents, env, secrets, absolute paths) can never reach chat.
 */
import { MESSAGES } from "./messages";
import type { CoordinationStatus, RawRecord, SessionStatus, SessionSummary, SessionView, TurnActivity } from "./types";

const ACTIVE_TURN_STATUSES = new Set(["delivering", "active", "waiting_for_answer", "completing"]);
const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "cancelled", "superseded"]);

const NAME_MAX_LEN = 48;
const BRANCH_MAX_LEN = 64;
const BLOCKER_MAX_LEN = 120;
// Short display id: keep <=12 ids as-is, otherwise `first8…last4` so a long raw id never reaches chat.
const SHORT_ID_KEEP_MAX = 12;
const SHORT_ID_PREFIX = 8;
const SHORT_ID_SUFFIX = 4;
// Terminal/dead sessions stay browseable for 24h after their last activity.
export const RETENTION_DEFAULT_MS = 24 * 60 * 60 * 1000;
// Coordinator session states that map to a non-recoverable, gone/retained-dead session.
// Fail-closed: any of these (or live === false) projects to `dead` so control guards refuse.
const DEAD_SESSION_STATES = new Set(["stale", "unavailable", "dead"]);
// Terminal projected statuses (no further work expected from the session).
const TERMINAL_STATUSES = new Set<SessionStatus>(["done", "failed", "cancelled", "dead"]);
// Strict ISO-8601 instant; anything else in a timestamp key is treated as withheld.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Read a string field, returning null for anything that is not a non-empty string. */
function readString(record: RawRecord, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Read an ISO-8601 timestamp field; reject anything else so hostile text cannot ride a timestamp key. */
function readTimestamp(record: RawRecord | null, key: string): string | null {
	if (!record) return null;
	const value = readString(record, key);
	return value && ISO_TIMESTAMP.test(value) ? value : null;
}

/** Collapse to a single line, strip control chars, and length-cap. */
function sanitizeLine(value: string, maxLen: number): string {
	const cleaned = value
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}

function indexBySessionId(records: RawRecord[]): Map<string, RawRecord> {
	const index = new Map<string, RawRecord>();
	for (const record of records) {
		const id = readString(record, "session_id");
		if (id) index.set(id, record);
	}
	return index;
}

/** Most recent active or otherwise relevant turn for a session. */
function turnsForSession(turns: RawRecord[], sessionId: string): RawRecord[] {
	return turns
		.filter(turn => readString(turn, "session_id") === sessionId)
		.sort((a, b) => (readString(a, "updated_at") ?? "").localeCompare(readString(b, "updated_at") ?? ""));
}

function activeTurnOf(sessionTurns: RawRecord[]): RawRecord | null {
	for (let i = sessionTurns.length - 1; i >= 0; i--) {
		const status = readString(sessionTurns[i] as RawRecord, "status");
		if (status && ACTIVE_TURN_STATUSES.has(status)) return sessionTurns[i] as RawRecord;
	}
	return null;
}

/**
 * Derive the bounded status enum from session state, the active turn, and the latest turn.
 *
 * Precedence is locked by fixtures (test/projection.test.ts) so dependent browsing/notifier
 * code never re-guesses status semantics:
 *  1. liveness false / `stale` state -> `dead`
 *  2. waiting_for_answer turn or `needs_user_input` state -> `waiting_for_input`
 *  3. deliberate blocker signal (`state === "blocked"` or `blocked === true`) -> `blocked`
 *  4. `errored` state or `failed` latest turn -> `failed`
 *  5. `cancelled` latest turn -> `cancelled`
 *  6. `completed` state -> `done`
 *  7. `running`/active turn/`ready_for_input`/`booting` -> `working`
 *  8. `completed`/`superseded` latest turn (no live state) -> `done`
 */
export function deriveStatus(
	sessionState: RawRecord | null,
	activeTurn: RawRecord | null,
	latestTurn: RawRecord | null = null,
): SessionStatus {
	if (sessionState && sessionState.live === false) return "dead";
	const state = sessionState ? readString(sessionState, "state") : null;
	if (state && DEAD_SESSION_STATES.has(state)) return "dead";
	const activeStatus = activeTurn ? readString(activeTurn, "status") : null;
	const latestStatus = latestTurn ? readString(latestTurn, "status") : null;
	if (activeStatus === "waiting_for_answer" || state === "needs_user_input") return "waiting_for_input";
	if (state === "blocked" || sessionState?.blocked === true) return "blocked";
	if (state === "errored" || latestStatus === "failed") return "failed";
	if (latestStatus === "cancelled") return "cancelled";
	if (state === "completed") return "done";
	if (state === "running" || activeStatus !== null || state === "ready_for_input" || state === "booting") {
		return "working";
	}
	if (latestStatus === "completed" || latestStatus === "superseded") return "done";
	return "working";
}

/** True for projected statuses that represent no further expected work. */
export function isTerminalStatus(status: SessionStatus): boolean {
	return TERMINAL_STATUSES.has(status);
}

/** Short display id: `<=12` chars stay as-is, longer raw ids collapse to `first8…last4`. */
export function shortSessionId(rawSessionId: string): string {
	// Strip control chars / collapse whitespace, but do NOT length-cap here: capping would
	// inject its own ellipsis and corrupt the first8…last4 form. Renderers escape the result.
	const cleaned = rawSessionId
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length <= SHORT_ID_KEEP_MAX) return cleaned;
	return `${cleaned.slice(0, SHORT_ID_PREFIX)}…${cleaned.slice(-SHORT_ID_SUFFIX)}`;
}

/**
 * Render an ISO instant as a coarse relative time (`just now`, `5m ago`, `2h ago`, `3d ago`).
 * Invalid/missing timestamps and future instants fall back safely.
 */
export function formatRelativeTime(iso: string | null, now: number): string {
	if (!iso || !ISO_TIMESTAMP.test(iso)) return MESSAGES.withheld;
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return MESSAGES.withheld;
	const deltaMs = now - then;
	if (deltaMs < 60_000) return "just now";
	const minutes = Math.floor(deltaMs / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

/**
 * Eligibility helper for browsing: a terminal/dead session stays listed until its last
 * activity is older than the retention window; live (non-terminal) sessions are always eligible.
 */
export function isWithinRetention(
	status: SessionStatus,
	lastActivityAt: string | null,
	now: number,
	ttlMs: number = RETENTION_DEFAULT_MS,
): boolean {
	if (!isTerminalStatus(status)) return true;
	if (!lastActivityAt || !ISO_TIMESTAMP.test(lastActivityAt)) return false;
	const then = Date.parse(lastActivityAt);
	if (Number.isNaN(then)) return false;
	return now - then <= ttlMs;
}

/** Derive the bounded turn-activity enum, with no turn body or content. */
export function deriveTurnActivity(sessionTurns: RawRecord[], activeTurn: RawRecord | null): TurnActivity {
	if (activeTurn) {
		return readString(activeTurn, "status") === "waiting_for_answer" ? "waiting_for_answer" : "active";
	}
	if (sessionTurns.some(turn => readString(turn, "status") === "queued")) return "queued";
	if (sessionTurns.some(turn => TERMINAL_TURN_STATUSES.has(readString(turn, "status") ?? ""))) return "terminal";
	return "none";
}

function deriveName(session: RawRecord, sessionId: string, branch: string | null): string {
	const repo = readString(session, "repo");
	if (repo && branch) return sanitizeLine(`${repo}@${branch}`, NAME_MAX_LEN);
	return shortSessionId(sessionId);
}

function deriveBranch(session: RawRecord, sessionState: RawRecord | null): string | null {
	const branch = readString(session, "branch") ?? (sessionState ? readString(sessionState, "branch") : null);
	return branch ? sanitizeLine(branch, BRANCH_MAX_LEN) : null;
}

function deriveLastActivity(session: RawRecord, sessionState: RawRecord | null): string | null {
	return (
		readTimestamp(sessionState, "updated_at") ??
		readTimestamp(session, "updated_at") ??
		readTimestamp(session, "created_at")
	);
}

function deriveBlocker(sessionState: RawRecord | null, status: SessionStatus): string | null {
	if (status !== "blocked" || !sessionState) return null;
	const reason = readString(sessionState, "reason");
	return reason ? sanitizeLine(reason, BLOCKER_MAX_LEN) : null;
}

/** Shared, allowlisted derivation for a single coordinator session. */
interface DerivedSession {
	sessionId: string;
	name: string;
	status: SessionStatus;
	branch: string | null;
	lastActivityAt: string | null;
	sessionState: RawRecord | null;
	sessionTurns: RawRecord[];
	activeTurn: RawRecord | null;
}

function deriveSession(session: RawRecord, sessionStates: RawRecord[], turns: RawRecord[]): DerivedSession | null {
	const sessionId = readString(session, "session_id");
	if (!sessionId) return null;
	const sessionState = indexBySessionId(sessionStates).get(sessionId) ?? null;
	const sessionTurns = turnsForSession(turns, sessionId);
	const activeTurn = activeTurnOf(sessionTurns);
	const latestTurn = sessionTurns.length > 0 ? (sessionTurns[sessionTurns.length - 1] as RawRecord) : null;
	const branch = deriveBranch(session, sessionState);
	return {
		sessionId: shortSessionId(sessionId),
		name: deriveName(session, sessionId, branch),
		status: deriveStatus(sessionState, activeTurn, latestTurn),
		branch,
		lastActivityAt: deriveLastActivity(session, sessionState),
		sessionState,
		sessionTurns,
		activeTurn,
	};
}

/** Project one coordinator session into the allowlisted list summary. */
export function projectSessionSummary(
	session: RawRecord,
	sessionStates: RawRecord[],
	turns: RawRecord[],
): SessionSummary | null {
	const derived = deriveSession(session, sessionStates, turns);
	if (!derived) return null;
	// Field-by-field projection: only allowlisted fields are copied.
	return {
		sessionId: derived.sessionId,
		name: derived.name,
		status: derived.status,
		branch: derived.branch,
		lastActivityAt: derived.lastActivityAt,
	};
}

/** Project one coordinator session into the allowlisted open-session view. */
export function projectSessionView(
	session: RawRecord,
	sessionStates: RawRecord[],
	turns: RawRecord[],
): SessionView | null {
	const derived = deriveSession(session, sessionStates, turns);
	if (!derived) return null;
	// Field-by-field projection: never spread, so the chat surface cannot silently widen.
	return {
		sessionId: derived.sessionId,
		name: derived.name,
		status: derived.status,
		branch: derived.branch,
		lastActivityAt: derived.lastActivityAt,
		activeTurn: deriveTurnActivity(derived.sessionTurns, derived.activeTurn),
		blockerSummary: deriveBlocker(derived.sessionState, derived.status),
	};
}

/** Project the whole coordination status into list summaries. */
export function projectSessionSummaries(status: CoordinationStatus): SessionSummary[] {
	return status.sessions
		.map(session => projectSessionSummary(session, status.sessionStates, status.turns))
		.filter((summary): summary is SessionSummary => summary !== null);
}

/** Find and project a single session by id. */
export function findSessionView(status: CoordinationStatus, sessionId: string): SessionView | null {
	const session = status.sessions.find(record => readString(record, "session_id") === sessionId);
	return session ? projectSessionView(session, status.sessionStates, status.turns) : null;
}

/** The coordinator turn id of a session's active turn, for `/stop`. */
export function activeTurnId(status: CoordinationStatus, sessionId: string): string | null {
	const activeTurn = activeTurnOf(turnsForSession(status.turns, sessionId));
	return activeTurn ? readString(activeTurn, "turn_id") : null;
}

/** Render the allowlisted summaries into a concise chat message. */
export function renderSessionsList(summaries: SessionSummary[]): string {
	if (summaries.length === 0) return MESSAGES.noSessions;
	return summaries
		.map(summary => {
			const branch = summary.branch ? ` · ${summary.branch}` : "";
			return `• ${summary.name} · ${summary.status}${branch}\n  ${summary.sessionId}`;
		})
		.join("\n");
}

/** Render the allowlisted open-session view into a concise chat message. */
export function renderSessionView(view: SessionView, now?: number): string {
	const last =
		now !== undefined ? formatRelativeTime(view.lastActivityAt, now) : (view.lastActivityAt ?? MESSAGES.withheld);
	const lines = [
		view.name,
		`id: ${view.sessionId}`,
		`status: ${view.status}`,
		`turn: ${view.activeTurn}`,
		`branch: ${view.branch ?? MESSAGES.withheld}`,
		`last: ${last}`,
	];
	if (view.status === "blocked") {
		lines.push(`blocked: ${view.blockerSummary ?? MESSAGES.withheld}`);
	}
	return lines.join("\n");
}

/** Escape a dynamic value for Telegram HTML parse mode (`&`, `<`, `>`). */
export function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function chunkForDelivery(text: string, maxLen = 4096): string[] {
	if (text.trim().length === 0) return [];
	const chunks: string[] = [];
	let rawChunk = "";
	let escapedLen = 0;
	for (const char of text) {
		const escaped = escapeHtml(char);
		if (rawChunk && escapedLen + escaped.length > maxLen) {
			chunks.push(escapeHtml(rawChunk));
			rawChunk = "";
			escapedLen = 0;
		}
		rawChunk += char;
		escapedLen += escaped.length;
	}
	if (rawChunk) chunks.push(escapeHtml(rawChunk));
	return chunks;
}

export function formatExitAlert(): string {
	return "RPC session exited. Attachment marked stale.";
}

export function formatLivenessAlert(): string {
	return "RPC session timed out. Attachment marked stale.";
}

export function formatSendFailure(retryAfterMs?: number): string {
	return typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0
		? `Final answer delivery paused; retry after ${Math.ceil(retryAfterMs / 1000)}s.`
		: "Final answer delivery paused; retry later.";
}

/** Read the exact raw coordinator session_id from a record (never truncated). */
export function readSessionId(record: RawRecord): string | null {
	return readString(record, "session_id");
}

/**
 * Project sessions into ordered rows pairing the EXACT raw session_id (for opaque
 * callback tokens / coordinator calls) with the allowlisted display summary (for
 * rendering). Display ids stay escaped/capped; the raw id never reaches chat.
 */
export function projectSessionRows(
	status: CoordinationStatus,
): Array<{ rawSessionId: string; summary: SessionSummary }> {
	const rows: Array<{ rawSessionId: string; summary: SessionSummary }> = [];
	for (const session of status.sessions) {
		const rawSessionId = readSessionId(session);
		const summary = projectSessionSummary(session, status.sessionStates, status.turns);
		if (rawSessionId && summary) rows.push({ rawSessionId, summary });
	}
	return rows;
}

/** Render the allowlisted summaries as HTML (presentation only; same fields). */
export function renderSessionsListHtml(summaries: SessionSummary[]): string {
	if (summaries.length === 0) return escapeHtml(MESSAGES.noSessions);
	const rows = summaries.map(summary => {
		const branch = summary.branch ? ` · ${escapeHtml(summary.branch)}` : "";
		return `• <b>${escapeHtml(summary.name)}</b> · ${escapeHtml(summary.status)}${branch}\n  <code>${escapeHtml(summary.sessionId)}</code>`;
	});
	return `<b>Sessions</b>\n${rows.join("\n")}`;
}

/** Render the allowlisted open-session view as HTML (presentation only; same fields). */
export function renderSessionViewHtml(view: SessionView, now?: number): string {
	const last =
		now !== undefined
			? formatRelativeTime(view.lastActivityAt, now)
			: view.lastActivityAt
				? escapeHtml(view.lastActivityAt)
				: MESSAGES.withheld;
	const lines = [
		`<b>${escapeHtml(view.name)}</b>`,
		`id: <code>${escapeHtml(view.sessionId)}</code>`,
		`status: <b>${escapeHtml(view.status)}</b>`,
		`turn: ${escapeHtml(view.activeTurn)}`,
		`branch: ${view.branch ? escapeHtml(view.branch) : MESSAGES.withheld}`,
		`last: ${last}`,
	];
	if (view.status === "blocked") {
		lines.push(`blocked: ${view.blockerSummary ? escapeHtml(view.blockerSummary) : MESSAGES.withheld}`);
	}
	return lines.join("\n");
}

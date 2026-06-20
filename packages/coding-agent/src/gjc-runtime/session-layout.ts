/**
 * Pure path layout for session-scoped GJC workflow state.
 *
 * Every generated/runtime artifact for a GJC session lives under
 * `<cwd>/.gjc/_session-{encodedSessionId}/...`. The `_session-` prefix is what
 * discriminates a session directory from shared, user-authored/installed config
 * (settings.json, secrets.yml, agents/, gjc-plugins/, agent/, python-env/, user
 * skills/commands), which always stays at the `.gjc/` root.
 *
 * This module is PURE and acyclic: every export is a deterministic function of
 * its arguments. It never reads `process.env` and never touches the filesystem.
 * Session resolution (flag/payload/env/latest-activity-marker) and any
 * filesystem scanning live in `session-resolution.ts`, the boundary module.
 */
import * as path from "node:path";

export const GJC_DIR = ".gjc";
export const GJC_SESSION_PREFIX = "_session-";
export const GJC_SESSION_ACTIVITY_FILE = ".session-activity.json";

/** Source that produced a resolved GJC session id, for audit/diagnostics. */
export type GjcSessionSource = "flag" | "payload" | "env" | "latest";

export interface GjcSessionContext {
	gjcSessionId: string;
	sessionRoot: string;
	source: GjcSessionSource;
}

/**
 * Encode a session id into a single safe path segment. Matches the historical
 * encoding used across the runtimes so ids round-trip identically:
 * `encodeURIComponent` plus dot-escaping (dots are legal in filenames but we
 * avoid `.`/`..` traversal ambiguity).
 */
export function encodeSessionSegment(value: string): string {
	return encodeURIComponent(value).replaceAll(".", "%2E");
}

/** Inverse of {@link encodeSessionSegment}. */
export function decodeSessionSegment(segment: string): string {
	return decodeURIComponent(segment.replaceAll("%2E", "."));
}

/** Throw when a session id is missing or blank; never let blank suppress callers. */
export function assertNonEmptyGjcSessionId(value: string | undefined, source: string): asserts value is string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`a non-empty GJC session id is required (${source})`);
	}
}

/**
 * Assert a value is safe to use as a single path segment: non-blank and free of
 * path separators or `.`/`..` traversal. Use for already-safe identifiers
 * (skill modes, slugs) where we want identical filenames but fail closed on
 * traversal rather than silently normalizing out of the intended directory.
 */
export function assertSafePathComponent(value: string, label: string): void {
	const trimmed = value.trim();
	if (trimmed === "") throw new Error(`${label} is required`);
	if (trimmed === "." || trimmed === ".." || /[/\\]/.test(trimmed)) {
		throw new Error(`${label} must be a safe path component (no separators or traversal): ${value}`);
	}
}

/** The shared `.gjc/` root (holds shared config; never session-scoped). */
export function gjcRoot(cwd: string): string {
	return path.join(cwd, GJC_DIR);
}

/** The per-session root directory: `<cwd>/.gjc/_session-{encodedId}`. */
export function sessionRoot(cwd: string, gjcSessionId: string): string {
	assertNonEmptyGjcSessionId(gjcSessionId, "sessionRoot");
	return path.join(gjcRoot(cwd), `${GJC_SESSION_PREFIX}${encodeSessionSegment(gjcSessionId)}`);
}

/** Directory name (no path) for a session id, e.g. `_session-abc`. */
export function sessionDirName(gjcSessionId: string): string {
	assertNonEmptyGjcSessionId(gjcSessionId, "sessionDirName");
	return `${GJC_SESSION_PREFIX}${encodeSessionSegment(gjcSessionId)}`;
}

/** Return the decoded session id for a `_session-*` directory name, else undefined. */
export function sessionIdFromDirName(name: string): string | undefined {
	if (!name.startsWith(GJC_SESSION_PREFIX)) return undefined;
	const suffix = name.slice(GJC_SESSION_PREFIX.length);
	if (suffix === "") return undefined;
	let decoded: string;
	try {
		decoded = decodeSessionSegment(suffix);
	} catch {
		return undefined;
	}
	return decoded.trim() === "" ? undefined : decoded;
}

/** Authoritative per-session activity marker path. */
export function sessionActivityPath(cwd: string, gjcSessionId: string): string {
	return path.join(sessionRoot(cwd, gjcSessionId), GJC_SESSION_ACTIVITY_FILE);
}

// ---- Top-level per-category subdir resolvers ----

export function sessionStateDir(cwd: string, gjcSessionId: string): string {
	return path.join(sessionRoot(cwd, gjcSessionId), "state");
}
export function sessionSpecsDir(cwd: string, gjcSessionId: string): string {
	return path.join(sessionRoot(cwd, gjcSessionId), "specs");
}
export function sessionPlansDir(cwd: string, gjcSessionId: string): string {
	return path.join(sessionRoot(cwd, gjcSessionId), "plans");
}
export function sessionUltragoalDir(cwd: string, gjcSessionId: string): string {
	return path.join(sessionRoot(cwd, gjcSessionId), "ultragoal");
}
export function sessionAuditDir(cwd: string, gjcSessionId: string): string {
	return path.join(sessionRoot(cwd, gjcSessionId), "audit");
}
export function sessionReportsDir(cwd: string, gjcSessionId: string): string {
	return path.join(sessionRoot(cwd, gjcSessionId), "reports");
}
export function sessionLogsDir(cwd: string, gjcSessionId: string): string {
	return path.join(sessionRoot(cwd, gjcSessionId), "logs");
}
export function sessionRuntimeDir(cwd: string, gjcSessionId: string): string {
	return path.join(sessionRoot(cwd, gjcSessionId), "runtime");
}
export function sessionRlmDir(cwd: string, gjcSessionId: string): string {
	return path.join(sessionRoot(cwd, gjcSessionId), "rlm");
}

// ---- Nested resolvers under <sessionRoot>/state ----

export function activeStateDir(cwd: string, gjcSessionId: string): string {
	return path.join(sessionStateDir(cwd, gjcSessionId), "active");
}
export function activeSnapshotPath(cwd: string, gjcSessionId: string): string {
	return path.join(sessionStateDir(cwd, gjcSessionId), "skill-active-state.json");
}
export function activeEntryPath(cwd: string, gjcSessionId: string, skill: string): string {
	const normalized = skill.trim();
	if (normalized === "") throw new Error("skill is required");
	return path.join(activeStateDir(cwd, gjcSessionId), `${encodeSessionSegment(normalized)}.json`);
}
export function modeStatePath(cwd: string, gjcSessionId: string, mode: string): string {
	const normalized = mode.trim();
	assertSafePathComponent(normalized, "mode");
	return path.join(sessionStateDir(cwd, gjcSessionId), `${normalized}-state.json`);
}
export function auditPath(cwd: string, gjcSessionId: string): string {
	return path.join(sessionStateDir(cwd, gjcSessionId), "audit.jsonl");
}
export function transactionJournalPath(cwd: string, gjcSessionId: string, mutationId: string): string {
	return path.join(sessionStateDir(cwd, gjcSessionId), "transactions", `${encodeSessionSegment(mutationId)}.json`);
}
export function teamStateRoot(cwd: string, gjcSessionId: string): string {
	return path.join(sessionStateDir(cwd, gjcSessionId), "team");
}
export function workflowGatePath(cwd: string, gjcSessionId: string, gateId: string): string {
	return path.join(sessionStateDir(cwd, gjcSessionId), "workflow-gates", `${encodeSessionSegment(gateId)}.json`);
}
export function harnessStateRoot(cwd: string, gjcSessionId: string): string {
	return path.join(sessionStateDir(cwd, gjcSessionId), "harness");
}
export function coordinatorMcpStateRoot(cwd: string, gjcSessionId: string): string {
	return path.join(sessionStateDir(cwd, gjcSessionId), "coordinator-mcp");
}

// ---- Nested resolvers under other top-level categories ----

export function tmuxRuntimeSessionPath(cwd: string, gjcSessionId: string, slug: string): string {
	const normalized = slug.trim();
	assertSafePathComponent(normalized, "slug");
	return path.join(sessionRuntimeDir(cwd, gjcSessionId), "tmux-sessions", `${normalized}.json`);
}
export function rlmArtifactRoot(cwd: string, gjcSessionId: string, rlmSessionId: string): string {
	const normalized = rlmSessionId.trim();
	if (normalized === "") throw new Error("rlmSessionId is required");
	return path.join(sessionRlmDir(cwd, gjcSessionId), encodeSessionSegment(normalized));
}

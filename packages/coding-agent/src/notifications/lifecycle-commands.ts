/**
 * Paired-chat /session_* command grammar (G009).
 *
 * Pure parser + shared target validator for the Telegram session-lifecycle
 * commands. The daemon parses an inbound paired-chat message here, then attaches
 * transport identity (chatId/updateId/token/requestId) and routes the resulting
 * frame to the orchestrator. Keeping this pure makes the grammar, the MVP
 * prompt-rejection, and target validation unit-testable without the daemon.
 *
 * MVP scope: an initial prompt (`-- <prompt>`) is REJECTED with usage text — no
 * prompt text ever enters a frame, audit, log, or response until daemon-owned
 * 0600 prompt refs are designed.
 */
import * as os from "node:os";
import type { SessionCloseTarget, SessionCreateTarget, SessionLifecycleResponse, SessionResumeTarget } from "./index";

export type LifecycleCommandVerb = "session_create" | "session_close" | "session_resume";

/** A parsed, validated lifecycle command (transport identity added by caller). */
export type ParsedLifecycleCommand =
	| { kind: "create"; target: SessionCreateTarget }
	| { kind: "close"; target: SessionCloseTarget }
	| { kind: "resume"; target: SessionResumeTarget }
	| { kind: "recent"; which: "create" | "resume" | "all" }
	| { kind: "usage"; message: string }
	| { kind: "reject"; reason: "invalid_target" | "prompt_unsupported"; message: string }
	| { kind: "none" };

const USAGE = [
	"Session commands:",
	"/session_create path <dir>",
	"/session_create worktree <repo> <branch>",
	"/session_create dir <newdir>",
	"/session_close <sessionId>",
	"/session_resume <sessionId|prefix>",
	"/session_recent [create|resume]",
].join("\n");

/** True when the text begins a /session_* command (cheap pre-gate). */
export function isLifecycleCommandText(text: string | undefined): boolean {
	if (!text) return false;
	return /^\/session_(create|close|resume|recent)\b/.test(text.trim());
}

/**
 * Parse a paired-chat message into a lifecycle command. Returns `none` for
 * non-lifecycle text, `usage`/`reject` for malformed input (no side effect), or
 * a validated `create`/`close`/`resume`/`recent` intent.
 *
 * The caller MUST have already enforced paired-chat authorization; this function
 * performs grammar + target validation only.
 */
export function parseLifecycleCommand(text: string | undefined): ParsedLifecycleCommand {
	if (!isLifecycleCommandText(text)) return { kind: "none" };
	const raw = (text ?? "").trim();

	// MVP: reject any initial-prompt separator outright (no prompt handling yet).
	if (/\s--(\s|$)/.test(raw)) {
		return {
			kind: "reject",
			reason: "prompt_unsupported",
			message: `Initial prompts (\`-- <prompt>\`) are not supported yet. Create the session, then send a normal message in its thread.\n\n${USAGE}`,
		};
	}

	const [command, ...args] = raw.split(/\s+/);

	if (command === "/session_recent") {
		const which = args[0];
		if (which === undefined || which === "create" || which === "resume") {
			return { kind: "recent", which: which ?? "all" };
		}
		return { kind: "usage", message: USAGE };
	}

	if (command === "/session_close") {
		if (args.length !== 1) return { kind: "usage", message: USAGE };
		const sessionId = args[0]!;
		if (!isSafeIdentifier(sessionId)) {
			return { kind: "reject", reason: "invalid_target", message: `Invalid session id.\n\n${USAGE}` };
		}
		return { kind: "close", target: { sessionId } };
	}

	if (command === "/session_resume") {
		if (args.length !== 1) return { kind: "usage", message: USAGE };
		const idOrPrefix = args[0]!;
		if (!isSafeIdentifier(idOrPrefix)) {
			return { kind: "reject", reason: "invalid_target", message: `Invalid session id/prefix.\n\n${USAGE}` };
		}
		return { kind: "resume", target: { sessionIdOrPrefix: idOrPrefix } };
	}

	// /session_create <kind> ...
	const kind = args[0];
	if (kind === "path") {
		if (args.length !== 2) return { kind: "usage", message: USAGE };
		const p = normalizeLifecyclePath(args[1]!);
		if (!p) return { kind: "reject", reason: "invalid_target", message: `Invalid path.\n\n${USAGE}` };
		return { kind: "create", target: { kind: "existing_path", path: p } };
	}
	if (kind === "dir") {
		if (args.length !== 2) return { kind: "usage", message: USAGE };
		const p = normalizeLifecyclePath(args[1]!);
		if (!p) return { kind: "reject", reason: "invalid_target", message: `Invalid dir.\n\n${USAGE}` };
		return { kind: "create", target: { kind: "plain_dir", path: p } };
	}
	if (kind === "worktree") {
		if (args.length !== 3) return { kind: "usage", message: USAGE };
		const repo = normalizeLifecyclePath(args[1]!);
		const branch = args[2]!;
		if (!repo) return { kind: "reject", reason: "invalid_target", message: `Invalid repo path.\n\n${USAGE}` };
		if (!isSafeBranch(branch)) {
			return { kind: "reject", reason: "invalid_target", message: `Invalid branch name.\n\n${USAGE}` };
		}
		return { kind: "create", target: { kind: "worktree", repo, branch } };
	}
	return { kind: "usage", message: USAGE };
}

/** The canonical usage text (exported for the daemon's help replies). */
export function lifecycleUsage(): string {
	return USAGE;
}

/**
 * Shared target validator reused at the policy/effect boundary (after paired-chat
 * auth, before any side effect). Returns null when valid, or an `invalid_target`
 * reason. The orchestrator remains authoritative; this is a defensive pre-check
 * the parser and any other entry point share.
 */
export function validateLifecycleTarget(
	verb: LifecycleCommandVerb,
	target: SessionCreateTarget | SessionCloseTarget | SessionResumeTarget,
): { ok: true } | { ok: false; reason: "invalid_target"; message: string } {
	const bad = (message: string) => ({ ok: false as const, reason: "invalid_target" as const, message });
	if (verb === "session_create") {
		const t = target as SessionCreateTarget;
		if (t.kind === "existing_path" || t.kind === "plain_dir") {
			return normalizeLifecyclePath(t.path) ? { ok: true } : bad("invalid path");
		}
		if (t.kind === "worktree") {
			if (!normalizeLifecyclePath(t.repo)) return bad("invalid repo path");
			return isSafeBranch(t.branch) ? { ok: true } : bad("invalid branch");
		}
		return bad("unknown create target");
	}
	if (verb === "session_close") {
		const t = target as SessionCloseTarget;
		return isSafeIdentifier(t.sessionId) ? { ok: true } : bad("invalid session id");
	}
	const t = target as SessionResumeTarget;
	return isSafeIdentifier(t.sessionIdOrPrefix) ? { ok: true } : bad("invalid session id/prefix");
}

// --- Safety primitives (defensive; the full-trust paired chat is accepted, but
// we still reject obviously malformed/injection-shaped inputs early). ---

export function normalizeLifecyclePath(value: string): string | undefined {
	if (!isSafePath(value)) return undefined;
	if (value === "~") return os.homedir() || undefined;
	if (value.startsWith("~/")) {
		const home = os.homedir();
		return home ? `${home}${value.slice(1)}` : undefined;
	}
	if (value.startsWith("~")) return undefined;
	return value;
}
function isSafeIdentifier(value: string): boolean {
	return /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

function isSafePath(value: string): boolean {
	// Reject empty, shell-metacharacter, or newline-bearing paths. Absolute or
	// relative are both allowed (full-trust chat), but not injection shapes.
	if (value.length === 0 || value.length > 4096) return false;
	if (/[\n\r\0]/.test(value)) return false;
	return !/[;&|`$(){}<>*?!\\"']/.test(value);
}

function isSafeBranch(value: string): boolean {
	// Defense-in-depth: also reject leading-hyphen names so a branch can never be
	// mistaken for a CLI flag downstream.
	return /^[A-Za-z0-9._/-]{1,255}$/.test(value) && !value.includes("..") && !value.startsWith("-");
}

/**
 * Map a lifecycle response/error to a user-facing Telegram message (G010).
 *
 * Only derives text from sessionId, mode, reason, a safe message, and candidate
 * {sessionId,path} — never a token or prompt. Each error reason gets tailored,
 * actionable copy; an "in progress" pending response is surfaced distinctly.
 */
export function formatLifecycleOutcome(r: SessionLifecycleResponse): string {
	switch (r.type) {
		case "session_create_response":
			return `\u{1f680} Launching session ${r.sessionId} in tmux. It will appear once ready \u2014 check /session_recent.`;
		case "session_close_response":
			return `\u2705 Closed session ${r.sessionId} (history preserved \u2014 you can resume it later).`;
		case "session_resume_response":
			return r.mode === "reattached"
				? `\u2705 Reattached to live session ${r.sessionId}.`
				: `\u{1f680} Cold-restarting session ${r.sessionId} from saved history in tmux \u2014 check /session_recent.`;
		case "session_lifecycle_error":
			break;
		default:
			return "Unknown lifecycle response.";
	}
	if (r.reason === "ambiguous_target" && r.candidates?.length) {
		const list = r.candidates.map(c => `\u2022 ${c.sessionId}${c.path ? ` (${c.path})` : ""}`).join("\n");
		return `\u2753 Multiple sessions match \u2014 reply with the exact id:\n${list}`;
	}
	switch (r.reason) {
		case "unauthorized":
			return "\u26d4 Not authorized for session lifecycle commands.";
		case "rate_limited":
			return "\u23f3 Too many create requests \u2014 please wait a bit and try again.";
		case "duplicate_conflict":
			return "\u26a0\ufe0f That command id was already used for a different request; send a fresh command.";
		case "invalid_target":
			return `\u26a0\ufe0f Invalid target. ${r.message}`;
		case "spawn_failed":
			return "\u26a0\ufe0f The session failed to start. Nothing was left running.";
		case "discovery_timeout":
		case "readiness_timeout":
			return "\u23f3 The session did not become ready in time. It may still be starting \u2014 check /session_recent.";
		case "close_refused":
			return "\u26a0\ufe0f Close refused: that session is not GJC-managed or did not match.";
		case "not_found":
			return "\u2753 No matching session was found.";
		case "terminal_uncertain":
			return /in progress/i.test(r.message)
				? "\u23f3 That request is already in progress \u2014 hold on."
				: "\u26a0\ufe0f Outcome uncertain. Check /session_recent before retrying so you don't double-spawn.";
		default:
			return `\u26a0\ufe0f ${r.reason}: ${r.message}`;
	}
}

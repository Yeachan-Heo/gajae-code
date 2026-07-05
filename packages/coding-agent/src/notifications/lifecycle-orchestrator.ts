/**
 * Telegram session-lifecycle orchestrator (G005 core).
 *
 * Owns the daemon-side policy for remote session create / close / resume:
 * strict paired-chat gating, a durable + atomic idempotency state machine,
 * per-chat create rate limiting, audit logging with token/prompt redaction, and
 * dispatch to injected effects (spawn / close / resume). It is deliberately
 * effect-injected so the decision logic is unit-testable and the same code path
 * is exercised end-to-end by a real-tmux integration smoke.
 *
 * The Rust control ingress (crates/gjc-notifications control server) has already
 * authenticated frames before they reach here; this module never sees or logs
 * the raw control token.
 */
import * as crypto from "node:crypto";

import type { LifecycleErrorReason, ResumeCandidate, SessionCreateFrame, SessionLifecycleRequest } from "./index";

/** Durable idempotency state for a single lifecycle request. */
export type LedgerState = "in_progress" | "success" | "failure" | "terminal_uncertain";

/** One persisted idempotency entry, keyed by `chatId:updateId`. */
export interface LedgerEntry {
	requestHash: string;
	state: LedgerState;
	requestId: string;
	verb: SessionLifecycleRequest["type"];
	intendedSessionId?: string;
	startupPromptRef?: string;
	createdAt: number;
	updatedAt: number;
	targetSummary: Record<string, unknown>;
	sessionId?: string;
	tmuxSession?: string;
	sessionStateFile?: string;
	endpointUrl?: string;
	/** Close effect outcome: whether the tmux process is confirmed gone. */
	processGone?: boolean;
	reason?: LifecycleErrorReason;
}

/** The full on-disk ledger document. */
export interface LedgerDoc {
	version: 1;
	entries: Record<string, LedgerEntry>;
}

/** Persistence boundary: atomic + fsynced read/write of the ledger document. */
export interface LedgerStore {
	read(): Promise<LedgerDoc>;
	/** Write atomically (temp + fsync + rename) under a per-ledger lock. */
	write(doc: LedgerDoc): Promise<void>;
}

/** One audit line. Tokens and raw prompts are NEVER included. */
export interface AuditEvent {
	ts: string;
	event:
		| "accepted"
		| "rejected"
		| "duplicate_reack"
		| "rate_limited"
		| "spawn_started"
		| "recovered_in_progress"
		| "success"
		| "failure"
		| "terminal_uncertain";
	chatId: string;
	updateId: number;
	requestId: string;
	requestHash: string;
	verb: SessionLifecycleRequest["type"];
	targetSummary: Record<string, unknown>;
	sessionId?: string;
	tmuxSession?: string;
	reason?: LifecycleErrorReason;
	/** Prompt byte length only (never the prompt text). */
	promptBytes?: number;
	/** Prompt content hash only (never the prompt text). */
	promptHash?: string;
}

export interface CreateEffectResult {
	sessionId: string;
	tmuxSession: string;
	sessionStateFile?: string;
	endpointUrl: string;
	topicThreadId: string;
}

export interface ResumeEffectResult extends CreateEffectResult {
	mode: "reattached" | "cold_restarted";
}

/** Injected effects + policy. Pure orchestration calls into these. */
export interface OrchestratorDeps {
	/** The single paired chat id. Anything else is rejected before parsing. */
	pairedChatId: string;
	now: () => number;
	store: LedgerStore;
	audit: (event: AuditEvent) => Promise<void> | void;
	/** Per-chat create rate limiter: returns true when allowed. */
	allowCreate: (chatId: string, nowMs: number) => boolean;
	/** Persist the once-consumed 0600 startup-prompt file; returns its ref. */
	writeStartupPrompt: (requestId: string, prompt: string | undefined) => Promise<string | undefined>;
	/** Spawn a session for a create/cold-restart. */
	spawnCreate: (
		frame: SessionCreateFrame,
		ids: { lifecycleRequestId: string; intendedSessionId: string; startupPromptRef?: string },
	) => Promise<CreateEffectResult>;
	closeSession: (target: {
		sessionId: string;
		tmuxSession?: string;
		sessionStateFile?: string;
	}) => Promise<{ processGone: boolean }>;
	resumeSession: (target: {
		sessionIdOrPrefix: string;
		path?: string;
	}) => Promise<ResumeEffectResult | { ambiguous: ResumeCandidate[] } | { notFound: true }>;
	newLifecycleRequestId: () => string;
	newSessionId: () => string;
}

/** A redaction-safe summary of a request target (never includes the token). */
export function summarizeTarget(frame: SessionLifecycleRequest): Record<string, unknown> {
	switch (frame.type) {
		case "session_create":
			return frame.target.kind === "worktree"
				? { kind: "worktree", repo: frame.target.repo, branch: frame.target.branch }
				: { kind: frame.target.kind, path: frame.target.path };
		case "session_close":
			return { sessionId: frame.target.sessionId };
		case "session_resume":
			return { sessionIdOrPrefix: frame.target.sessionIdOrPrefix };
	}
}

/**
 * Stable request hash over the meaningful (non-token) request content. Used to
 * detect a duplicate update id reused with a DIFFERENT body (conflict).
 */
export function requestHash(frame: SessionLifecycleRequest): string {
	const canonical = JSON.stringify({
		type: frame.type,
		target: summarizeTarget(frame),
		startupPromptRef: "startupPromptRef" in frame ? frame.startupPromptRef : undefined,
		force: frame.type === "session_close" ? frame.force === true : undefined,
	});
	return crypto.createHash("sha256").update(canonical).digest("hex");
}

export function ledgerKey(chatId: string, updateId: number): string {
	return `${chatId}:${updateId}`;
}

/** How a freshly-arrived request relates to the durable ledger. */
export type DuplicateClass =
	| { kind: "new" }
	| { kind: "reack_success"; entry: LedgerEntry }
	| { kind: "reack_failure"; entry: LedgerEntry }
	| { kind: "in_progress"; entry: LedgerEntry }
	| { kind: "terminal_uncertain"; entry: LedgerEntry }
	| { kind: "conflict"; entry: LedgerEntry };

/** Classify a request against an existing ledger entry (pure). */
export function classifyDuplicate(existing: LedgerEntry | undefined, hash: string): DuplicateClass {
	if (!existing) return { kind: "new" };
	if (existing.requestHash !== hash) return { kind: "conflict", entry: existing };
	switch (existing.state) {
		case "success":
			return { kind: "reack_success", entry: existing };
		case "failure":
			return { kind: "reack_failure", entry: existing };
		case "in_progress":
			return { kind: "in_progress", entry: existing };
		case "terminal_uncertain":
			return { kind: "terminal_uncertain", entry: existing };
	}
}

/** The structured outcome the daemon translates into a wire response frame. */
export type LifecycleOutcome =
	| { status: "ok"; entry: LedgerEntry; mode?: "reattached" | "cold_restarted" }
	| { status: "error"; reason: LifecycleErrorReason; message: string; candidates?: ResumeCandidate[] }
	| { status: "pending"; entry: LedgerEntry };

/**
 * Handle one authenticated lifecycle request. Enforces paired-chat gating,
 * idempotency, and rate limiting BEFORE any side effect, then dispatches.
 */
export async function handleLifecycleRequest(
	frame: SessionLifecycleRequest,
	deps: OrchestratorDeps,
): Promise<LifecycleOutcome> {
	const nowMs = deps.now();
	const hash = requestHash(frame);
	const key = ledgerKey(frame.chatId, frame.updateId);
	const targetSummary = summarizeTarget(frame);

	const baseAudit = {
		ts: new Date(nowMs).toISOString(),
		chatId: frame.chatId,
		updateId: frame.updateId,
		requestId: frame.requestId,
		requestHash: hash,
		verb: frame.type,
		targetSummary,
	} as const;

	// 1. Strict paired-chat gating — BEFORE touching paths/processes or the ledger.
	if (frame.chatId !== deps.pairedChatId) {
		await deps.audit({ ...baseAudit, event: "rejected", reason: "unauthorized" });
		return { status: "error", reason: "unauthorized", message: "chat not paired" };
	}

	// 2. Durable idempotency.
	const doc = await deps.store.read();
	const dup = classifyDuplicate(doc.entries[key], hash);
	switch (dup.kind) {
		case "conflict":
			await deps.audit({ ...baseAudit, event: "rejected", reason: "duplicate_conflict" });
			return { status: "error", reason: "duplicate_conflict", message: "update id reused with different body" };
		case "reack_success":
			await deps.audit({ ...baseAudit, event: "duplicate_reack", sessionId: dup.entry.sessionId });
			return { status: "ok", entry: dup.entry };
		case "reack_failure":
			await deps.audit({ ...baseAudit, event: "duplicate_reack", reason: dup.entry.reason });
			return {
				status: "error",
				reason: dup.entry.reason ?? "terminal_uncertain",
				message: "previously failed; send a new update to retry",
			};
		case "in_progress":
			// A retry arrived while the first attempt is still running: never
			// respawn — report pending so the caller waits for the original.
			await deps.audit({ ...baseAudit, event: "recovered_in_progress", sessionId: dup.entry.intendedSessionId });
			return { status: "pending", entry: dup.entry };
		case "terminal_uncertain":
			await deps.audit({ ...baseAudit, event: "recovered_in_progress", reason: "terminal_uncertain" });
			return {
				status: "error",
				reason: "terminal_uncertain",
				message: "prior attempt outcome unknown; manual check",
			};
		case "new":
			break;
	}

	// 3. Per-chat create rate limit (create only).
	if (frame.type === "session_create" && !deps.allowCreate(frame.chatId, nowMs)) {
		await deps.audit({ ...baseAudit, event: "rate_limited", reason: "rate_limited" });
		return { status: "error", reason: "rate_limited", message: "create rate limit exceeded" };
	}

	// 4. Close is intentionally force-only until a graceful close contract exists.
	if (frame.type === "session_close" && frame.force !== true) {
		await deps.audit({ ...baseAudit, event: "rejected", reason: "invalid_target" });
		return {
			status: "error",
			reason: "invalid_target",
			message: "session_close requires force=true; graceful close is not supported",
		};
	}

	// 5. Preallocate ids + write in_progress (fsynced) BEFORE any spawn.
	const lifecycleRequestId = frame.type === "session_create" ? frame.lifecycleRequestId : deps.newLifecycleRequestId();
	const intendedSessionId =
		frame.type === "session_create" ? frame.intendedSessionId || deps.newSessionId() : deps.newSessionId();
	let startupPromptRef: string | undefined;
	let promptBytes: number | undefined;
	let promptHash: string | undefined;

	const entry: LedgerEntry = {
		requestHash: hash,
		state: "in_progress",
		requestId: frame.requestId,
		verb: frame.type,
		intendedSessionId,
		createdAt: nowMs,
		updatedAt: nowMs,
		targetSummary,
	};
	doc.entries[key] = entry;
	await deps.store.write(doc);
	await deps.audit({ ...baseAudit, event: "accepted", sessionId: intendedSessionId });

	try {
		if (frame.type === "session_create") {
			startupPromptRef = await deps.writeStartupPrompt(frame.requestId, undefined);
			entry.startupPromptRef = startupPromptRef;
			await deps.audit({ ...baseAudit, event: "spawn_started", sessionId: intendedSessionId });
			const result = await deps.spawnCreate(frame, { lifecycleRequestId, intendedSessionId, startupPromptRef });
			Object.assign(entry, {
				state: "success",
				updatedAt: deps.now(),
				sessionId: result.sessionId,
				tmuxSession: result.tmuxSession,
				sessionStateFile: result.sessionStateFile,
				endpointUrl: result.endpointUrl,
			});
			await deps.store.write(doc);
			await deps.audit({
				...baseAudit,
				event: "success",
				sessionId: result.sessionId,
				tmuxSession: result.tmuxSession,
				promptBytes,
				promptHash,
			});
			return { status: "ok", entry };
		}

		if (frame.type === "session_close") {
			const closed = await deps.closeSession(frame.target);
			Object.assign(entry, {
				state: "success",
				updatedAt: deps.now(),
				sessionId: frame.target.sessionId,
				tmuxSession: frame.target.tmuxSession,
				processGone: closed.processGone,
			});
			await deps.store.write(doc);
			await deps.audit({ ...baseAudit, event: "success", sessionId: frame.target.sessionId });
			return { status: "ok", entry };
		}

		// session_resume
		const resumed = await deps.resumeSession(frame.target);
		if ("ambiguous" in resumed) {
			Object.assign(entry, { state: "failure", updatedAt: deps.now(), reason: "ambiguous_target" });
			await deps.store.write(doc);
			await deps.audit({ ...baseAudit, event: "failure", reason: "ambiguous_target" });
			return {
				status: "error",
				reason: "ambiguous_target",
				message: "multiple sessions match; pick one",
				candidates: resumed.ambiguous,
			};
		}
		if ("notFound" in resumed) {
			Object.assign(entry, { state: "failure", updatedAt: deps.now(), reason: "not_found" });
			await deps.store.write(doc);
			await deps.audit({ ...baseAudit, event: "failure", reason: "not_found" });
			return { status: "error", reason: "not_found", message: "no matching session found" };
		}
		Object.assign(entry, {
			state: "success",
			updatedAt: deps.now(),
			sessionId: resumed.sessionId,
			tmuxSession: resumed.tmuxSession,
			endpointUrl: resumed.endpointUrl,
		});
		await deps.store.write(doc);
		await deps.audit({ ...baseAudit, event: "success", sessionId: resumed.sessionId });
		return { status: "ok", entry, mode: resumed.mode };
	} catch (err) {
		// A side effect may have occurred; do not repeat it automatically. Mark
		// terminal-uncertain so a retry reconciles instead of duplicating work.
		let reason: LifecycleErrorReason = "terminal_uncertain";
		if (frame.type === "session_create") reason = "spawn_failed";
		if (frame.type === "session_close") reason = "close_refused";
		Object.assign(entry, {
			state: "terminal_uncertain",
			updatedAt: deps.now(),
			reason,
		});
		await deps.store.write(doc);
		await deps.audit({ ...baseAudit, event: "terminal_uncertain", reason });
		return { status: "error", reason: "terminal_uncertain", message: `${frame.type} effect failed: ${String(err)}` };
	}
}

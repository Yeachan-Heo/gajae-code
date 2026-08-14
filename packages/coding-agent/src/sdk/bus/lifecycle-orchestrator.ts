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
 * The Rust control ingress (crates/gjc-sdk control server) has already
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
	resumeMode?: ResumeEffectResult["mode"];
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

/** Redacted audit-v2 event. */
export interface AuditEvent {
	schemaVersion: 2;
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
	chatRef: string;
	updateId: number;
	requestRef: string;
	verb: SessionLifecycleRequest["type"];
	targetKind: CanonicalTargetKind;
	targetRef: string;
	reason?: LifecycleErrorReason;
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
	/** In-memory, derived 32-byte audit-v2 HMAC key. */
	auditRedactionKey: Uint8Array;
	now: () => number;
	store: LedgerStore;
	audit: (event: AuditEvent) => Promise<void> | void;
	/** Resolves the returned tmux provider once per request for psmux preflight. */
	isPsmuxProvider: () => boolean;
	/** Per-chat create rate limiter: returns true when allowed. */
	allowCreate: (chatId: string, nowMs: number) => boolean;
	/** Persist the once-consumed 0600 startup-prompt file after durably recording its ref. */
	writeStartupPrompt: (
		requestId: string,
		prompt: string | undefined,
		persistRef: (ref: string) => Promise<void>,
	) => Promise<string | undefined>;
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
}

export type CanonicalTargetKind = "existing_path" | "worktree" | "plain_dir" | "session_close" | "session_resume";

function isUnicodeScalarString(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			if (index + 1 >= value.length) return false;
			const next = value.charCodeAt(++index);
			if (next < 0xdc00 || next > 0xdfff) return false;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function jsonString(value: string): string {
	if (!isUnicodeScalarString(value)) throw new Error("invalid_target");
	return JSON.stringify(value);
}

export function canonicalTarget(frame: SessionLifecycleRequest): string {
	switch (frame.type) {
		case "session_create":
			switch (frame.target.kind) {
				case "existing_path":
					return `{"kind":"existing_path","path":${jsonString(frame.target.path)}}`;
				case "worktree":
					return `{"kind":"worktree","repo":${jsonString(frame.target.repo)},"branch":${jsonString(frame.target.branch)}}`;
				case "plain_dir":
					return `{"kind":"plain_dir","path":${jsonString(frame.target.path)}}`;
			}
			throw new Error("invalid_target");
		case "session_close":
			return `{"kind":"session_close","sessionId":${jsonString(frame.target.sessionId)},"tmuxSession":${frame.target.tmuxSession === undefined ? "null" : jsonString(frame.target.tmuxSession)},"sessionStateFile":${frame.target.sessionStateFile === undefined ? "null" : jsonString(frame.target.sessionStateFile)}}`;
		case "session_resume":
			return `{"kind":"session_resume","sessionIdOrPrefix":${jsonString(frame.target.sessionIdOrPrefix)},"path":${frame.target.path === undefined ? "null" : jsonString(frame.target.path)}}`;
	}
}

export function canonicalRequest(frame: SessionLifecycleRequest): string {
	const target = canonicalTarget(frame);
	const startupPromptRef =
		frame.type === "session_create" && frame.startupPromptRef !== undefined
			? jsonString(frame.startupPromptRef)
			: "null";
	const modelPreset =
		frame.type === "session_create" && frame.modelPreset !== undefined ? jsonString(frame.modelPreset) : "null";
	const force = frame.type === "session_close" ? (frame.force === true ? "true" : "false") : "null";
	return `{"type":${jsonString(frame.type)},"target":${target},"startupPromptRef":${startupPromptRef},"modelPreset":${modelPreset},"force":${force}}`;
}

function requestHashFromCanonical(canonical: string): string {
	return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function requestHash(frame: SessionLifecycleRequest): string {
	return requestHashFromCanonical(canonicalRequest(frame));
}

export function auditRedactionRef(key: Uint8Array, domain: string, value: string): string {
	if (key.byteLength !== 32) throw new Error("invalid_audit_redaction_key");
	return crypto.createHmac("sha256", key).update(domain, "utf8").update(value, "utf8").digest("hex");
}

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
	let hash: string;
	let canonicalRequestBytes: string;
	let canonicalTargetBytes: string;
	try {
		canonicalRequestBytes = canonicalRequest(frame);
		canonicalTargetBytes = canonicalTarget(frame);
		hash = requestHashFromCanonical(canonicalRequestBytes);
	} catch {
		return { status: "error", reason: "invalid_target", message: "invalid lifecycle target" };
	}
	if (deps.auditRedactionKey.byteLength !== 32) throw new Error("invalid_audit_redaction_key");
	const key = ledgerKey(frame.chatId, frame.updateId);
	const targetSummary = summarizeTarget(frame);
	const targetKind: CanonicalTargetKind =
		frame.type === "session_create"
			? frame.target.kind
			: frame.type === "session_close"
				? "session_close"
				: "session_resume";
	const baseAudit = {
		schemaVersion: 2 as const,
		ts: new Date(nowMs).toISOString(),
		chatRef: auditRedactionRef(deps.auditRedactionKey, "gjc.lifecycle.audit.v2.chat\0", frame.chatId),
		updateId: frame.updateId,
		requestRef: auditRedactionRef(deps.auditRedactionKey, "gjc.lifecycle.audit.v2.request\0", canonicalRequestBytes),
		verb: frame.type,
		targetKind,
		targetRef: auditRedactionRef(deps.auditRedactionKey, "gjc.lifecycle.audit.v2.target\0", canonicalTargetBytes),
	} as const;

	// 1. Strict paired-chat gating — BEFORE touching paths/processes or the ledger.
	if (frame.chatId !== deps.pairedChatId) {
		await deps.audit({ ...baseAudit, event: "rejected", reason: "unauthorized" });
		return { status: "error", reason: "unauthorized", message: "chat not paired" };
	}
	if (frame.type === "session_close" && frame.force !== true) {
		await deps.audit({ ...baseAudit, event: "rejected", reason: "invalid_target" });
		return {
			status: "error",
			reason: "invalid_target",
			message: "session_close requires force=true; graceful close is not supported",
		};
	}
	const suppliedStartupPromptRef =
		frame.type === "session_create" || frame.type === "session_resume" ? frame.startupPromptRef : undefined;
	if (suppliedStartupPromptRef !== undefined) {
		return {
			status: "error",
			reason: "invalid_target",
			message: "startup prompt capability transport is unavailable; retry without a startup prompt",
		};
	}
	if (deps.isPsmuxProvider()) {
		await deps.audit({ ...baseAudit, event: "rejected", reason: "unsupported_platform" });
		return {
			status: "error",
			reason: "unsupported_platform",
			message:
				"Remote session lifecycle is unavailable on this psmux host because GJC cannot prove immutable session identity. No lifecycle action was performed. Use a local GJC terminal with a supported tmux provider.",
		};
	}

	// 4. Durable idempotency.
	const doc = await deps.store.read();
	const existing = doc.entries[key];
	if (
		frame.type === "session_close" &&
		existing?.verb === "session_close" &&
		existing.requestHash === hash &&
		existing.state === "success" &&
		typeof existing.sessionId === "string" &&
		existing.processGone === false
	) {
		existing.state = "terminal_uncertain";
		existing.reason = "terminal_uncertain";
		existing.updatedAt = deps.now();
		delete existing.processGone;
		await deps.store.write(doc);
	}
	const dup = classifyDuplicate(doc.entries[key], hash);
	switch (dup.kind) {
		case "conflict":
			await deps.audit({ ...baseAudit, event: "rejected", reason: "duplicate_conflict" });
			return { status: "error", reason: "duplicate_conflict", message: "update id reused with different body" };
		case "reack_success":
			await deps.audit({ ...baseAudit, event: "duplicate_reack" });
			return { status: "ok", entry: dup.entry, ...(dup.entry.resumeMode ? { mode: dup.entry.resumeMode } : {}) };
		case "reack_failure":
			if (dup.entry.reason === undefined) throw new Error("invalid lifecycle failure ledger entry");
			await deps.audit({ ...baseAudit, event: "duplicate_reack", reason: dup.entry.reason });
			return {
				status: "error",
				reason: dup.entry.reason,
				message: "previously failed; send a new update to retry",
			};
		case "in_progress":
			// A retry arrived while the first attempt is still running: never
			// respawn — report pending so the caller waits for the original.
			await deps.audit({ ...baseAudit, event: "recovered_in_progress" });
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

	// 5. Per-chat create rate limit (create only).
	if (frame.type === "session_create" && !deps.allowCreate(frame.chatId, nowMs)) {
		await deps.audit({ ...baseAudit, event: "rate_limited", reason: "rate_limited" });
		return { status: "error", reason: "rate_limited", message: "create rate limit exceeded" };
	}

	// 6. Persist immutable create ids + write in_progress (fsynced) BEFORE any spawn.
	if (frame.type === "session_create" && (!frame.lifecycleRequestId || !frame.intendedSessionId))
		return { status: "error", reason: "invalid_target", message: "create lifecycle ids must be non-empty" };
	let startupPromptRef: string | undefined;

	const entry: LedgerEntry = {
		requestHash: hash,
		state: "in_progress",
		requestId: frame.requestId,
		verb: frame.type,
		intendedSessionId: frame.type === "session_create" ? frame.intendedSessionId : undefined,
		createdAt: nowMs,
		updatedAt: nowMs,
		targetSummary,
	};
	doc.entries[key] = entry;
	await deps.store.write(doc);
	await deps.audit({ ...baseAudit, event: "accepted" });

	try {
		if (frame.type === "session_create") {
			startupPromptRef = await deps.writeStartupPrompt(frame.requestId, frame.startupPromptRef, async ref => {
				entry.startupPromptRef = ref;
				await deps.store.write(doc);
			});
			entry.startupPromptRef = startupPromptRef;
			await deps.audit({ ...baseAudit, event: "spawn_started" });
			const result = await deps.spawnCreate(frame, {
				lifecycleRequestId: frame.lifecycleRequestId,
				intendedSessionId: frame.intendedSessionId,
				startupPromptRef,
			});
			Object.assign(entry, {
				state: "success",
				updatedAt: deps.now(),
				sessionId: result.sessionId,
				tmuxSession: result.tmuxSession,
				sessionStateFile: result.sessionStateFile,
				endpointUrl: result.endpointUrl,
			});
			await deps.store.write(doc);
			await deps.audit({ ...baseAudit, event: "success" });
			return { status: "ok", entry };
		}

		if (frame.type === "session_close") {
			const closed = await deps.closeSession(frame.target);
			if (!closed.processGone) {
				Object.assign(entry, {
					state: "terminal_uncertain",
					updatedAt: deps.now(),
					reason: "terminal_uncertain",
					sessionId: frame.target.sessionId,
					tmuxSession: frame.target.tmuxSession,
				});
				await deps.store.write(doc);
				await deps.audit({ ...baseAudit, event: "terminal_uncertain", reason: "terminal_uncertain" });
				return {
					status: "error",
					reason: "terminal_uncertain",
					message: "session_close could not confirm process disappearance; manual check",
				};
			}
			Object.assign(entry, {
				state: "success",
				updatedAt: deps.now(),
				sessionId: frame.target.sessionId,
				tmuxSession: frame.target.tmuxSession,
				processGone: true,
			});
			await deps.store.write(doc);
			await deps.audit({ ...baseAudit, event: "success" });
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
			resumeMode: resumed.mode,
		});
		await deps.store.write(doc);
		await deps.audit({ ...baseAudit, event: "success" });
		return { status: "ok", entry, mode: resumed.mode };
	} catch (err) {
		if (typeof err === "object" && err !== null && "startupPromptRef" in err) {
			const failedPromptRef = Reflect.get(err, "startupPromptRef");
			if (typeof failedPromptRef === "string") entry.startupPromptRef = failedPromptRef;
		}
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

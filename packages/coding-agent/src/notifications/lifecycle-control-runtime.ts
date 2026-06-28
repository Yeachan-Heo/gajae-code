/**
 * Wires the authenticated Rust control endpoint (NotificationControlServer) to
 * the lifecycle orchestrator with REAL daemon-side effects: a daemon-safe tmux
 * launcher (create / cold-restart), force-close, and reattach-or-cold-restart
 * resume. Kept separate from telegram-daemon.ts so the effects + wiring are
 * unit-testable; the daemon calls {@link attachLifecycleControl} once it owns
 * the control server.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
	buildGjcTmuxExactOptionTarget,
	buildGjcTmuxProfileCommands,
	resolveGjcTmuxCommand,
} from "../gjc-runtime/tmux-common";
import {
	findGjcTmuxSessionByName,
	forceCloseGjcTmuxSession,
	listGjcTmuxSessions,
	statusGjcTmuxSession,
} from "../gjc-runtime/tmux-sessions";
import type { ResumeCandidate, SessionCreateFrame, SessionLifecycleRequest, SessionLifecycleResponse } from "./index";
import { normalizeLifecyclePath } from "./lifecycle-commands";
import {
	type AuditEvent,
	type CreateEffectResult,
	handleLifecycleRequest,
	type LedgerDoc,
	type LedgerStore,
	type LifecycleOutcome,
	type OrchestratorDeps,
	type ResumeEffectResult,
} from "./lifecycle-orchestrator";
import { listRecentSessions } from "./recent-activity";

/** Minimal view of the native control server this runtime depends on. */
export interface ControlServerLike {
	onLifecycleRequest(
		cb: (err: Error | null, req: { kind: string; requestId: string; payloadJson: string }) => void,
	): void;
	respond(responseJson: string): void;
}

/**
 * A startable control server (the native NotificationControlServer, or a fake in
 * tests). Extends {@link ControlServerLike} with the start/stop lifecycle the
 * daemon owns.
 */
export interface LifecycleControlServer extends ControlServerLike {
	start(): Promise<unknown>;
	stop(): void;
}

/** Factory the daemon uses to construct a control server bound to its ownership. */
export type LifecycleControlServerFactory = (input: {
	token: string;
	ownerId: string;
	agentDir: string;
}) => LifecycleControlServer;

/** Atomic + fsynced file-backed idempotency ledger store. */
export function fileLedgerStore(idempotencyFile: string): LedgerStore {
	return {
		async read(): Promise<LedgerDoc> {
			try {
				return JSON.parse(fs.readFileSync(idempotencyFile, "utf8")) as LedgerDoc;
			} catch {
				return { version: 1, entries: {} };
			}
		},
		async write(doc: LedgerDoc): Promise<void> {
			fs.mkdirSync(path.dirname(idempotencyFile), { recursive: true });
			const tmp = `${idempotencyFile}.${process.pid}.${Date.now()}.tmp`;
			const fd = fs.openSync(tmp, "w", 0o600);
			fs.writeSync(fd, JSON.stringify(doc));
			fs.fsyncSync(fd);
			fs.closeSync(fd);
			fs.renameSync(tmp, idempotencyFile);
			// fsync the parent directory so the rename itself is durable across a
			// crash / power loss (the temp-file fsync alone does not persist the
			// directory entry).
			try {
				const dirFd = fs.openSync(path.dirname(idempotencyFile), "r");
				try {
					fs.fsyncSync(dirFd);
				} finally {
					fs.closeSync(dirFd);
				}
			} catch {
				// Some platforms reject directory fsync; the rename is still atomic.
			}
		},
	};
}

/** Append-only JSONL audit sink (0600). Never receives tokens or raw prompts. */
export function fileAudit(auditPath: string): (e: AuditEvent) => void {
	return (e: AuditEvent) => {
		fs.mkdirSync(path.dirname(auditPath), { recursive: true });
		fs.appendFileSync(auditPath, `${JSON.stringify(e)}\n`, { mode: 0o600 });
	};
}

/** Simple per-chat sliding-window create rate limiter. */
export function createRateLimiter(maxPerWindow: number, windowMs: number): (chatId: string, nowMs: number) => boolean {
	const hits = new Map<string, number[]>();
	return (chatId: string, nowMs: number) => {
		const arr = (hits.get(chatId) ?? []).filter(t => nowMs - t < windowMs);
		if (arr.length >= maxPerWindow) {
			hits.set(chatId, arr);
			return false;
		}
		arr.push(nowMs);
		hits.set(chatId, arr);
		return true;
	};
}

function tmuxSessionNameFor(sessionId: string): string {
	return `gjc_lc_${sessionId}`;
}

/** Build the `gjc` argv for a create target (existing path / worktree / dir).
 *
 *  The launched session id is carried via `GJC_SESSION_ID` in the child env (see
 *  {@link daemonSpawnCreate}); the root `gjc` launcher has no `--session-id`
 *  flag, so it must never appear in argv. Only flags the launch parser actually
 *  supports are emitted (`--worktree <branch>` for worktree targets). */
export function buildCreateArgv(
	frame: SessionCreateFrame,
	_ids: { intendedSessionId: string; startupPromptRef?: string },
): { cwd: string; args: string[] } {
	if (frame.target.kind === "worktree") {
		const cwd = normalizeLifecyclePath(frame.target.repo);
		if (!cwd) throw new Error("invalid_lifecycle_repo_path");
		// Use the `--worktree=<branch>` form so the branch is a single argv token:
		// a flag-shaped branch (e.g. `-x`) can never be mis-parsed as a separate
		// launcher flag / detached-mode trigger.
		return { cwd, args: [`--worktree=${frame.target.branch}`] };
	}
	const cwd = normalizeLifecyclePath(frame.target.path);
	if (!cwd) throw new Error("invalid_lifecycle_path");
	return { cwd, args: [] };
}

/** Real daemon-safe tmux launcher: detached `tmux new-session -d` + GJC tags. */
export function daemonSpawnCreate(env: NodeJS.ProcessEnv = process.env) {
	return async (
		frame: SessionCreateFrame,
		ids: { lifecycleRequestId: string; intendedSessionId: string; startupPromptRef?: string },
	): Promise<CreateEffectResult> => {
		const tmux = resolveGjcTmuxCommand(env);
		const name = tmuxSessionNameFor(ids.intendedSessionId);
		const { cwd, args } = buildCreateArgv(frame, ids);
		// A `plain_dir` target is a NEW working directory: create it before spawn
		// so `/session_create dir <newdir>` works as documented.
		if (frame.target.kind === "plain_dir") {
			fs.mkdirSync(cwd, { recursive: true });
		}
		// Detached: no interactive TTY needed (daemon-safe).
		const childEnv: Record<string, string> = {
			GJC_TMUX_LAUNCHED: "1",
			GJC_NOTIFICATIONS: "1",
			GJC_SESSION_ID: ids.intendedSessionId,
			GJC_LIFECYCLE_REQUEST_ID: ids.lifecycleRequestId,
		};
		if (ids.startupPromptRef) childEnv.GJC_STARTUP_PROMPT_REF = ids.startupPromptRef;
		const envPairs = Object.entries(childEnv)
			.map(([k, v]) => `${k}=${shellQuote(v)}`)
			.join(" ");
		const command = `cd ${shellQuote(cwd)} && exec env ${envPairs} gjc ${args.map(shellQuote).join(" ")}`;
		const created = Bun.spawnSync([tmux, "new-session", "-d", "-s", name, "sh", "-c", command], {
			stdout: "pipe",
			stderr: "pipe",
			env,
		});
		if (created.exitCode !== 0) {
			throw new Error(created.stderr.toString().trim() || "gjc_lifecycle_spawn_failed");
		}
		const target = buildGjcTmuxExactOptionTarget(name);
		const metaCommands = buildGjcTmuxProfileCommands(target, env, {
			sessionId: ids.intendedSessionId,
			project: cwd,
		});
		for (const cmd of metaCommands) {
			Bun.spawnSync([tmux, ...cmd.args], { stdout: "pipe", stderr: "pipe", env });
		}
		const status = statusGjcTmuxSession(name, env);
		return {
			sessionId: ids.intendedSessionId,
			tmuxSession: name,
			sessionStateFile: status.sessionStateFile,
			endpointUrl: "",
			topicThreadId: "",
		};
	};
}

/** Real force-close effect (GJC-managed only, id-matched). */
export function daemonCloseSession(env: NodeJS.ProcessEnv = process.env) {
	return async (target: { sessionId: string; tmuxSession?: string; sessionStateFile?: string }) => {
		const name = target.tmuxSession ?? tmuxSessionNameFor(target.sessionId);
		forceCloseGjcTmuxSession(name, env, target.sessionId, target.sessionStateFile);
		return { processGone: findGjcTmuxSessionByName(name, env) === undefined };
	};
}

/** Real resume effect: reattach if a live GJC session matches; else resolve the
 *  prefix against saved history and fail closed (`ambiguous`/`notFound`) before
 *  cold-restarting exactly one resolved session via the daemon-safe launcher. */
export function daemonResumeSession(env: NodeJS.ProcessEnv = process.env, opts: { sessionsRoot?: string } = {}) {
	return async (target: {
		sessionIdOrPrefix: string;
		path?: string;
	}): Promise<ResumeEffectResult | { ambiguous: ResumeCandidate[] } | { notFound: true }> => {
		const live = listGjcTmuxSessions(env).filter(
			s => s.sessionId === target.sessionIdOrPrefix || s.sessionId?.startsWith(target.sessionIdOrPrefix),
		);
		if (live.length > 1) {
			return {
				ambiguous: live.map(s => ({ sessionId: s.sessionId ?? s.name, path: s.project })),
			};
		}
		if (live.length === 1) {
			const s = live[0]!;
			return {
				sessionId: s.sessionId ?? s.name,
				tmuxSession: s.name,
				sessionStateFile: s.sessionStateFile,
				endpointUrl: "",
				topicThreadId: "",
				mode: "reattached",
			};
		}
		// Dead: resolve the id/prefix against saved session history BEFORE cold
		// restart, so an unknown or ambiguous prefix fails closed instead of
		// blindly spawning `gjc --resume <prefix>` against a non-authoritative id.
		let resumeId = target.sessionIdOrPrefix;
		if (opts.sessionsRoot) {
			const saved = listRecentSessions({ sessionsRoot: opts.sessionsRoot, limit: 1000 });
			const prefixed = saved.filter(
				s => s.sessionId === target.sessionIdOrPrefix || s.sessionId.startsWith(target.sessionIdOrPrefix),
			);
			const exact = prefixed.filter(s => s.sessionId === target.sessionIdOrPrefix);
			const resolved = exact.length > 0 ? exact : prefixed;
			if (resolved.length === 0) return { notFound: true };
			if (resolved.length > 1) {
				return { ambiguous: resolved.map(s => ({ sessionId: s.sessionId, path: s.path })) };
			}
			resumeId = resolved[0]!.sessionId;
		}
		const tmux = resolveGjcTmuxCommand(env);
		const name = tmuxSessionNameFor(resumeId);
		const command = `exec env GJC_TMUX_LAUNCHED=1 GJC_NOTIFICATIONS=1 gjc --resume ${shellQuote(resumeId)}`;
		const r = Bun.spawnSync([tmux, "new-session", "-d", "-s", name, "sh", "-c", command], {
			stdout: "pipe",
			stderr: "pipe",
			env,
		});
		if (r.exitCode !== 0) throw new Error(r.stderr.toString().trim() || "gjc_lifecycle_resume_failed");
		const tgt = buildGjcTmuxExactOptionTarget(name);
		for (const cmd of buildGjcTmuxProfileCommands(tgt, env, { sessionId: resumeId })) {
			Bun.spawnSync([tmux, ...cmd.args], { stdout: "pipe", stderr: "pipe", env });
		}
		return {
			sessionId: resumeId,
			tmuxSession: name,
			endpointUrl: "",
			topicThreadId: "",
			mode: "cold_restarted",
		};
	};
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Translate an orchestrator outcome into a wire response frame. */
export function outcomeToResponse(frame: SessionLifecycleRequest, outcome: LifecycleOutcome): SessionLifecycleResponse {
	if (outcome.status === "error" || outcome.status === "pending") {
		const reason = outcome.status === "pending" ? "terminal_uncertain" : outcome.reason;
		return {
			type: "session_lifecycle_error",
			requestId: frame.requestId,
			status: "error",
			reason,
			message: outcome.status === "pending" ? "request already in progress" : outcome.message,
			...(outcome.status === "error" && outcome.candidates ? { candidates: outcome.candidates } : {}),
		};
	}
	const e = outcome.entry;
	if (frame.type === "session_create") {
		return {
			type: "session_create_response",
			requestId: frame.requestId,
			status: "ok",
			lifecycleRequestId: frame.lifecycleRequestId,
			sessionId: e.sessionId ?? e.intendedSessionId ?? "",
			matchedBy: "spawn_marker",
			endpoint: { url: e.endpointUrl ?? "", token: "" },
			topic: { chatId: frame.chatId, threadId: "" },
			target: frame.target,
		};
	}
	if (frame.type === "session_close") {
		return {
			type: "session_close_response",
			requestId: frame.requestId,
			status: "ok",
			sessionId: e.sessionId ?? "",
			processGone: e.processGone ?? false,
			historyPreserved: true,
			// The killed session's per-session endpoint record is reaped by the
			// daemon's dead-PID scan (scanRoots), so it is effectively stale.
			endpointStale: e.processGone ?? false,
		};
	}
	return {
		type: "session_resume_response",
		requestId: frame.requestId,
		status: "ok",
		sessionId: e.sessionId ?? "",
		mode: outcome.mode ?? "reattached",
		endpoint: { url: e.endpointUrl ?? "", token: "" },
		topic: { chatId: frame.chatId, threadId: "" },
	};
}

/**
 * Wire a control server's lifecycle requests through the orchestrator.
 *
 * Handlers run on a single serial queue (a promise chain): the daemon owns the
 * one control endpoint, so serializing here makes each request's ledger
 * read -> classify -> write atomic with respect to every other request. Two
 * identical updates that arrive nearly simultaneously can no longer both
 * classify as `new` and both spawn — the second sees the first's persisted
 * `in_progress`/`success` entry and re-acks instead.
 */
export function attachLifecycleControl(server: ControlServerLike, deps: OrchestratorDeps): void {
	let queue: Promise<void> = Promise.resolve();
	server.onLifecycleRequest((err, req) => {
		if (err) return;
		let frame: SessionLifecycleRequest;
		try {
			frame = JSON.parse(req.payloadJson) as SessionLifecycleRequest;
		} catch {
			return;
		}
		queue = queue
			.then(async () => {
				const outcome = await handleLifecycleRequest(frame, deps);
				server.respond(JSON.stringify(outcomeToResponse(frame, outcome)));
			})
			.catch(() => {
				// A handler failure must not break the queue for later requests.
			});
	});
}

/** Assemble real orchestrator deps for the daemon (ledger/audit under agentDir). */
export function buildOrchestratorDeps(input: {
	pairedChatId: string;
	agentNotificationsDir: string;
	/** Root of saved session histories (`<agentDir>/sessions`), for resume resolution. */
	sessionsRoot?: string;
	env?: NodeJS.ProcessEnv;
}): OrchestratorDeps {
	const env = input.env ?? process.env;
	return {
		pairedChatId: input.pairedChatId,
		now: () => Date.now(),
		store: fileLedgerStore(path.join(input.agentNotificationsDir, "telegram-lifecycle-idempotency.json")),
		audit: fileAudit(path.join(input.agentNotificationsDir, "telegram-lifecycle-audit.jsonl")),
		allowCreate: createRateLimiter(3, 10 * 60 * 1000),
		writeStartupPrompt: async (requestId, prompt) => {
			if (prompt === undefined) return undefined;
			const ref = path.join(input.agentNotificationsDir, `startup-prompt-${requestId}`);
			fs.mkdirSync(path.dirname(ref), { recursive: true });
			const fd = fs.openSync(ref, "w", 0o600);
			fs.writeSync(fd, prompt);
			fs.fsyncSync(fd);
			fs.closeSync(fd);
			return ref;
		},
		spawnCreate: daemonSpawnCreate(env),
		closeSession: daemonCloseSession(env),
		resumeSession: daemonResumeSession(env, { sessionsRoot: input.sessionsRoot }),
		newLifecycleRequestId: () => `lc-${crypto.randomUUID()}`,
		newSessionId: () => `s${crypto.randomUUID().slice(0, 8)}`,
	};
}

/**
 * Default production factory: a real native NotificationControlServer bound to
 * the daemon's control token, owner id, and agent dir.
 */
export const createNativeControlServer: LifecycleControlServerFactory = ({ token, ownerId, agentDir }) => {
	// Lazy require so loading this module (for the orchestrator / wiring / tests)
	// never eagerly resolves the native addon — only a real production start does.
	const { NotificationControlServer } = require("@gajae-code/natives") as typeof import("@gajae-code/natives");
	return new NotificationControlServer(token, ownerId, agentDir) as unknown as LifecycleControlServer;
};

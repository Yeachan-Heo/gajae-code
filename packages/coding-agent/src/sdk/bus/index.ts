/// <reference path="./natives-augment.d.ts" />
/**
 * Notifications extension.
 *
 * Hosts a per-session loopback WebSocket notification server (the Rust core via
 * N-API) and bridges GJC session events + the `ask` tool to it so a remote client
 * (e.g. a Telegram bot) can both see action-needed signals and answer them
 * through SDK-native session capabilities:
 *
 * - `ask` (interactive): registers an {@link AskAnswerSource}; the ask tool races
 *   the local UI against a remote reply. First valid answer wins; a local answer
 *   aborts the remote wait (and broadcasts `action_resolved` resolvedBy=local).
 * - `ask` (workflow gate): observes emitted workflow gates and resolves the real
 *   gate on a remote reply via `ctx.workflowGate`.
 * - `turn_end` -> `action_needed` (kind `idle`, deduped per turn).
 * - `session_shutdown` -> `session_closed` frame, stop server, deregister answer source.
 *
 * Enable with Settings notifications config, `GJC_NOTIFICATIONS=1` (a token is
 * generated), or `GJC_NOTIFICATIONS_TOKEN`.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { ImageContent, TextContent } from "@gajae-code/ai";
import { NotificationServer, nativeBuildInfo } from "@gajae-code/natives";
import { logger, postmortem, VERSION } from "@gajae-code/utils";
import { Settings } from "../../config/settings";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../extensibility/extensions";
import type {
	WorkflowGateEmitter,
	WorkflowGateTerminalController,
	WorkflowGateTerminalProof,
} from "../../modes/shared/agent-wire/workflow-gate-broker";
import { parseThinkingLevel } from "../../thinking";
import type {
	AskAnswerRequest,
	AskAnswerSourceResult,
	AskRemoteControl,
	AskRemoteInteraction,
	AskRemoteReceipt,
	AskSelectedAckOutcome,
	AskSettlement,
	AskSettlementResult,
} from "../../tools";
import { registerAskAnswerSource, registerWorkflowGateEmitterListener } from "../../tools/ask-answer-registry";
import { ensureBroker } from "../broker/ensure";
import { SessionIndex } from "../broker/session-index";
import { SessionSdkHost, shouldHostSdk } from "../host";
import { type ControlSurface, dispatchControl } from "../host/control";
import { CursorRegistry, QueryHandlers, RevisionStore, type SessionSurface } from "../host/query";
import { projectQ10Models } from "../models.js";
import { OPERATIONS } from "../protocol/operation-registry";
import {
	lifecycleStartupCapabilityForApi,
	normalizeSdkStartupFailure,
	type SdkStartupFailure,
} from "../startup-capability";

import { registerTelegramFileSink } from "./attachment-registry";
import { ensureDiscordDaemon, ensureSlackDaemon } from "./chat-daemon-control";
import {
	getNotificationConfig,
	isDiscordConfigured,
	isSessionNotificationsEnabled,
	isSlackConfigured,
	isTelegramConfigured,
	type NotificationConfig,
	type NotificationSettingsReader,
	sessionTag,
} from "./config";
import { telegramControlCommandUsage } from "./config-commands";
import { imageAttachmentsFromMessage, notificationActionPayload, summaryFromMessage } from "./helpers";
import { assertNativeRuntimeCompatibility } from "./native-runtime-compatibility";
import { NotificationSessionController, type NotificationSessionRuntime } from "./session-control";
import { type EnsureDaemonResult, ensureTelegramDaemonRunningDetailed } from "./telegram-daemon";

// ===========================================================================
// Session lifecycle control protocol (TypeScript mirror of the Rust wire
// contract in `crates/gjc-sdk/src/lifecycle.rs`).
//
// These describe the frames exchanged over the daemon-owned, session-independent
// control endpoint for remote session create / close / resume. Field names are
// camelCase on the wire; `type`/`kind` discriminators are snake_case. The Rust
// ingress authenticates and forwards; the daemon (TypeScript) owns all policy,
// spawn orchestration, idempotency, rate limiting, audit, and UX.
// ===========================================================================

/** Where a `session_create` should run. Discriminated by `kind`. */
export type SessionCreateTarget =
	| { kind: "existing_path"; path: string }
	| { kind: "worktree"; repo: string; branch: string }
	| { kind: "plain_dir"; path: string };

/** Identifies the session a `session_close` targets. */
export interface SessionCloseTarget {
	sessionId: string;
	/** Expected GJC-managed tmux session name (defense-in-depth match). */
	tmuxSession?: string;
	/** Expected `@gjc-session-state-file` tag (defense-in-depth match). */
	sessionStateFile?: string;
}

/** Identifies the session a `session_resume` targets. */
export interface SessionResumeTarget {
	sessionIdOrPrefix: string;
	/** Optional repo/working-dir hint to disambiguate matches. */
	path?: string;
}

/** Create a new session. */
export interface SessionCreateFrame {
	type: "session_create";
	requestId: string;
	/** Deterministic lifecycle marker preallocated by the daemon before spawn. */
	lifecycleRequestId: string;
	/** Session id the daemon preallocated and propagates to the child. */
	intendedSessionId: string;
	/** Telegram update id (idempotency key on the daemon side). */
	updateId: number;
	chatId: string;
	/** Control-endpoint token authorizing this frame. */
	token: string;
	target: SessionCreateTarget;
	/** Reserved for a future capability transport; any supplied value is rejected before lifecycle acceptance. */
	startupPromptRef?: string;
	/** Model profile preset to activate for the spawned session (--mpreset). */
	modelPreset?: string;
}

/** Close (hard-kill, history preserved) a session. */
export interface SessionCloseFrame {
	type: "session_close";
	requestId: string;
	updateId: number;
	chatId: string;
	token: string;
	target: SessionCloseTarget;
	/** Required force-only close flag; false/omitted is rejected by daemon policy. */
	force?: boolean;
}

/** Resume a session (reattach if alive, else cold-restart from history). */
export interface SessionResumeFrame {
	type: "session_resume";
	requestId: string;
	updateId: number;
	chatId: string;
	token: string;
	target: SessionResumeTarget;
	/** Reserved for a future capability transport; any supplied value is rejected before lifecycle acceptance. */
	startupPromptRef?: string;
}

/** Any client -> ingress lifecycle request frame. */
export type SessionLifecycleRequest = SessionCreateFrame | SessionCloseFrame | SessionResumeFrame;

/** Terminal status of a lifecycle request. */
export type LifecycleStatus = "ok" | "error";

/** A connected session's per-session endpoint, returned to the control client. */
export interface LifecycleEndpoint {
	url: string;
	token: string;
}

/** The Telegram topic/thread a session is surfaced in. */
export interface LifecycleTopic {
	chatId: string;
	threadId: string;
}

/** How a create request was correlated to its spawned session. */
export type MatchedBy = "spawn_marker" | "session_ready";

/** Response to a successful `session_create`. */
export interface SessionCreateResponseFrame {
	type: "session_create_response";
	requestId: string;
	status: LifecycleStatus;
	lifecycleRequestId: string;
	sessionId: string;
	matchedBy: MatchedBy;
	endpoint: LifecycleEndpoint;
	topic: LifecycleTopic;
	target: SessionCreateTarget;
}

/** Response to a successful `session_close`. */
export interface SessionCloseResponseFrame {
	type: "session_close_response";
	requestId: string;
	status: LifecycleStatus;
	sessionId: string;
	processGone: boolean;
	historyPreserved: boolean;
	endpointStale: boolean;
}

/** Whether a resume reattached to a live session or cold-restarted a dead one. */
export type ResumeMode = "reattached" | "cold_restarted";

/** Response to a successful `session_resume`. */
export interface SessionResumeResponseFrame {
	type: "session_resume_response";
	requestId: string;
	status: LifecycleStatus;
	sessionId: string;
	mode: ResumeMode;
	endpoint: LifecycleEndpoint;
	topic: LifecycleTopic;
}

/** Machine-readable reason a lifecycle request failed. */
export type LifecycleErrorReason =
	| "unauthorized"
	| "rate_limited"
	| "duplicate_conflict"
	| "invalid_target"
	| "ambiguous_target"
	| "spawn_failed"
	| "discovery_timeout"
	| "readiness_timeout"
	| "close_refused"
	| "not_found"
	| "terminal_uncertain"
	| "unsupported_platform";

/** A candidate returned with an `ambiguous_target` resume error. */
export interface ResumeCandidate {
	sessionId: string;
	path?: string;
	/** Last-activity epoch-millis (session history file mtime), if known. */
	mtimeMs?: number;
}

/** A structured lifecycle error frame. */
export interface SessionLifecycleErrorFrame {
	type: "session_lifecycle_error";
	requestId: string;
	status: LifecycleStatus;
	reason: LifecycleErrorReason;
	message: string;
	candidates?: ResumeCandidate[];
}

/** Any ingress -> client lifecycle response frame. */
export type SessionLifecycleResponse =
	| SessionCreateResponseFrame
	| SessionCloseResponseFrame
	| SessionResumeResponseFrame
	| SessionLifecycleErrorFrame;

/**
 * Replayable per-session readiness signal (mirror of the Rust `session_ready`
 * frame). Buffered and replayed to late clients so WS-open alone never implies
 * the session is live and surfaced.
 */
export interface SessionReadyFrame {
	type: "session_ready";
	sessionId: string;
	lifecycleRequestId?: string;
	startupPromptRef?: string;
	repo?: string;
	branch?: string;
	title?: string;
}

/** Resolve the git dir for `cwd`, handling worktrees where `.git` is a file. */
function gitDir(cwd: string): string | undefined {
	const dot = path.join(cwd, ".git");
	try {
		if (fs.statSync(dot).isDirectory()) return dot;
		const m = fs
			.readFileSync(dot, "utf8")
			.trim()
			.match(/^gitdir:\s*(.+)$/);
		if (m) return path.resolve(cwd, m[1]);
	} catch {}
	return undefined;
}

/** Best-effort current branch from `.git/HEAD` (no git spawn). */
function readGitBranch(cwd: string): string | undefined {
	const gd = gitDir(cwd);
	if (!gd) return undefined;
	try {
		const head = fs.readFileSync(path.join(gd, "HEAD"), "utf8").trim();
		const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
		return m ? m[1] : head.slice(0, 12);
	} catch {
		return undefined;
	}
}

/** Resolve the shared git dir (the main repo's `.git`) for a possibly-linked worktree. */
function gitCommonDir(gd: string): string {
	try {
		const raw = fs.readFileSync(path.join(gd, "commondir"), "utf8").trim();
		if (raw) return path.resolve(gd, raw);
	} catch {}
	return gd;
}

/**
 * Best-effort real repository name (no git spawn): resolves the main worktree
 * root directory so linked worktrees report the repo (e.g. `gajae-code`)
 * instead of the worktree directory (e.g. `feat-foo-01047f11`).
 */
export function readGitRepoName(cwd: string): string | undefined {
	const gd = gitDir(cwd);
	if (!gd) return undefined;
	const commonDir = gitCommonDir(gd);
	// Strip the trailing `.git` to land on the main worktree root directory.
	const repoRoot = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
	const name = path.basename(repoRoot);
	return name && name !== ".git" ? name : undefined;
}

/** Build the one-time identity header fields for a session thread. */
function buildIdentity(
	cwd: string,
	sessionName?: string,
): {
	repo: string;
	branch: string;
	machine: string;
	title?: string;
} {
	const repo = readGitRepoName(cwd) ?? (path.basename(cwd) || cwd);
	const branch = readGitBranch(cwd) ?? "(detached)";
	// Send repo/branch and the raw session title separately; the consumer
	// composes the topic name ("{repo}/{branch}" before the session title is
	// auto-generated, then "{repo}/{branch} - {session title}" once it exists).
	return { repo, branch, machine: os.hostname(), title: sessionName };
}

/** Compact cwd label for remote session identity; never emits the full host path by default. */
function compactCwd(cwd: string): string | undefined {
	const home = os.homedir();
	const resolved = path.resolve(cwd);
	if (resolved === home) return "~";
	const base = path.basename(resolved);
	return base || path.parse(resolved).root || undefined;
}

const execFileAsync = promisify(execFile);

/** Best-effort working-tree diff stat for the context update (no throw). */
async function readGitDiffStat(cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", cwd, "diff", "--stat", "--no-color"], {
			timeout: 3000,
			maxBuffer: 256 * 1024,
		});
		const trimmed = stdout.trim();
		return trimmed ? trimmed.slice(0, 1500) : undefined;
	} catch {
		return undefined;
	}
}

class DiffQueryError extends Error {
	constructor(
		readonly code: "not_git_repository" | "diff_too_large",
		message: string,
	) {
		super(message);
	}
}

interface PendingInteractiveAsk {
	resolve: (result: AskAnswerSourceResult) => void;
	options: string[];
	controls: readonly AskRemoteControl[];
	actionId?: string;
	retireForDirectControl: () => RetireStatus;
	reissue: () => boolean;
	complete: (actionId: string) => void;
	completeDirect: () => void;
	fail: (actionId: string) => void;
}

interface UnattendedGatePresentation {
	gateId: string;
	sessionId: string;
	question: string;
	options: string[];
	controls: readonly AskRemoteControl[];
	multi: boolean;
	allowEmpty: boolean;
	navigationLabel?: "Next" | "Done";
	selectedOptions: string[];
	workflowGateId?: string;
	onActivated?: (actionId: string, lease: { actionId: string; registrationEpoch: number }) => void;
	onClosed?: () => void;
}

type RetireStatus = "retired" | "already_terminal" | "claimed" | "stale";
type DirectControlOutcome = "accepted" | "rejected" | "unknown";

function parseRetireStatus(status: string): RetireStatus {
	if (status === "retired" || status === "already_terminal" || status === "claimed" || status === "stale")
		return status;
	throw new Error(`Unexpected native retirement status: ${status}`);
}

function isTerminalProof(status: RetireStatus): status is "retired" | "already_terminal" {
	return status === "retired" || status === "already_terminal";
}

export class PresentationArbiter {
	private readonly presentations = new Map<string, UnattendedGatePresentation>();
	private readonly routes = new Map<string, string>();
	private active: { actionId: string; gateId: string; registrationEpoch: number } | undefined;
	private readonly queue: string[] = [];
	private readonly retries = new Map<string, { attempts: number; exhausted: boolean; nextAt: number }>();
	private readonly retiredProofs = new Map<string, WorkflowGateTerminalProof>();
	private readonly directControls = new Map<string, number>();
	/** Explicit terminal proof for a direct control fenced before native publication. */
	private readonly queuedDirectControls = new Set<string>();
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private retryTimerGateId: string | undefined;
	private retryTimerGeneration = 0;
	private readonly terminalCancellationTimers = new Map<string, ReturnType<typeof setTimeout>>();

	private headGeneration = 0;
	private observedHead: string | undefined;
	static readonly maxRegistrationAttempts = 3;
	static readonly retryBaseDelayMs = 50;
	static readonly retryMaxDelayMs = 1_000;
	/** Bound an unavailable interactive answer source without discarding its head silently. */
	static readonly terminalCancellationDelayMs = 250;

	#observeHead(): number {
		const head = this.queue[0];
		if (head !== this.observedHead) {
			this.observedHead = head;
			this.headGeneration++;
			if (this.retryTimer) {
				clearTimeout(this.retryTimer);
				this.retryTimer = undefined;
				this.retryTimerGateId = undefined;
			}
		}
		return this.headGeneration;
	}

	#clearTerminalCancellation(gateId: string): void {
		const timer = this.terminalCancellationTimers.get(gateId);
		if (timer) clearTimeout(timer);
		this.terminalCancellationTimers.delete(gateId);
	}

	#scheduleTerminalCancellation(gateId: string): void {
		const presentation = this.presentations.get(gateId);
		if (presentation?.workflowGateId || this.terminalCancellationTimers.has(gateId)) return;
		this.terminalCancellationTimers.set(
			gateId,
			setTimeout(() => {
				this.terminalCancellationTimers.delete(gateId);
				if (this.retries.get(gateId)?.exhausted && this.queue[0] === gateId) {
					logger.warn("interactive_presentation_terminally_cancelled", { gateId });
					this.cancel(gateId, "registration_exhausted");
				}
			}, PresentationArbiter.terminalCancellationDelayMs),
		);
	}

	#promote(): void {
		this.#observeHead();
		const gateId = this.queue[0];
		const retry = gateId ? this.retries.get(gateId) : undefined;
		if (!this.active && gateId && !this.directControls.has(gateId) && !retry?.exhausted) {
			if (retry && retry.nextAt > Date.now()) this.#scheduleRetry(gateId);
			else this.reissue(gateId);
		}
	}

	#scheduleRetry(gateId: string): void {
		const retry = this.retries.get(gateId);
		if (!retry || retry.exhausted || this.queue[0] !== gateId) return;
		const generation = this.#observeHead();
		if (this.retryTimer && this.retryTimerGateId === gateId && this.retryTimerGeneration === generation) return;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimerGateId = gateId;
		this.retryTimerGeneration = generation;
		const delay = Math.max(0, retry.nextAt - Date.now());
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			const matchesHead = this.queue[0] === gateId && this.#observeHead() === generation;
			this.retryTimerGateId = undefined;
			if (matchesHead) this.reconcile();
		}, delay);
	}

	/** Revalidates the live endpoint queue head before bounded recovery. */
	reconcile(): void {
		this.#observeHead();
		const gateId = this.queue[0];
		const retry = gateId ? this.retries.get(gateId) : undefined;
		if (
			!gateId ||
			!this.presentations.has(gateId) ||
			this.active ||
			this.directControls.has(gateId) ||
			retry?.exhausted
		)
			return;
		if (retry && retry.nextAt > Date.now()) {
			this.#scheduleRetry(gateId);
			return;
		}
		this.#promote();
	}

	/** Explicit production recovery for a previously exhausted endpoint queue head. */
	recover(gateId = this.queue[0]): void {
		if (!gateId || this.queue[0] !== gateId || !this.presentations.has(gateId)) return;
		this.retries.delete(gateId);
		this.#clearTerminalCancellation(gateId);

		this.#observeHead();
		this.reconcile();
	}

	hasActivePresentation(): boolean {
		return this.active !== undefined;
	}

	retireForDirectControl(gateId: string): RetireStatus {
		if (!this.active || this.active.gateId !== gateId) return "stale";
		const active = this.active;
		this.directControls.set(gateId, this.queue.indexOf(gateId));
		const status = parseRetireStatus(this.server.retireIfUnclaimed(active).status);
		if (isTerminalProof(status)) {
			this.routes.delete(active.actionId);
			this.active = undefined;
			this.retiredProofs.set(gateId, status);
			return status;
		}
		this.directControls.delete(gateId);
		return status;
	}

	prepareDirectControl(
		gateId: string,
	): { status: "retired" | "queued"; ordinal: number } | { status: "claimed" | "stale" } {
		const ordinal = this.queue.indexOf(gateId);
		if (this.active?.gateId === gateId) {
			const status = this.retireForDirectControl(gateId);
			return status === "retired"
				? { status, ordinal }
				: { status: status === "already_terminal" ? "stale" : status };
		}
		if (!this.presentations.has(gateId) || ordinal < 0 || this.directControls.has(gateId)) return { status: "stale" };
		// Fence the queued entry before awaiting durable resolution; promotion cannot
		// republish it until the control has a known terminal outcome.
		this.directControls.set(gateId, ordinal);
		this.queuedDirectControls.add(gateId);
		return { status: "queued", ordinal };
	}

	finishDirectControl(
		gateId: string,
		prepared: { status: "retired" | "queued"; ordinal: number },
		outcome: DirectControlOutcome,
	): void {
		if (outcome === "accepted") {
			this.directControls.delete(gateId);
			this.complete(gateId);
			return;
		}
		if (outcome === "unknown") {
			// A durable/store/advance failure may have committed. Remove local authority
			// rather than minting a fresh action against an uncertain durable state.
			this.directControls.delete(gateId);
			this.complete(gateId);
			logger.warn("workflow_gate_direct_control_uncertain", { gateId });
			return;
		}
		this.directControls.delete(gateId);
		this.queuedDirectControls.delete(gateId);
		this.retiredProofs.delete(gateId);
		if (!this.presentations.has(gateId)) return;
		const current = this.queue.indexOf(gateId);
		if (current >= 0) this.queue.splice(current, 1);
		this.queue.splice(Math.min(prepared.ordinal, this.queue.length), 0, gateId);
		this.reconcile();
	}

	constructor(
		private readonly server: NotificationServer,
		private readonly redact: () => boolean,
		private readonly tag: string,
	) {}

	retain(presentation: UnattendedGatePresentation): void {
		const alreadyPresent = this.presentations.has(presentation.gateId);
		if (!alreadyPresent) this.queue.push(presentation.gateId);
		this.presentations.set(presentation.gateId, presentation);
		// A fresh durable replay is explicit production recovery after transient N-API exhaustion.
		if (alreadyPresent) this.recover(presentation.gateId);
		else this.#promote();
	}

	routeFor(actionId: string): string | undefined {
		return this.routes.get(actionId);
	}

	presentationFor(actionId: string): UnattendedGatePresentation | undefined {
		const gateId = this.routes.get(actionId);
		return gateId ? this.presentations.get(gateId) : undefined;
	}

	/** The native generic claim has already resolved this old action. */
	toggle(actionId: string, label: string): boolean {
		const presentation = this.presentationFor(actionId);
		if (!presentation?.multi || !presentation.options.includes(label)) return false;
		this.routes.delete(actionId);
		if (this.active?.actionId === actionId) this.active = undefined;
		const selected = new Set(presentation.selectedOptions);
		if (selected.has(label)) selected.delete(label);
		else selected.add(label);
		presentation.selectedOptions = [...selected];
		this.reissue(presentation.gateId);
		return true;
	}

	/** Clears an interactive route only when it is still the route that settled. */
	completeInteractive(gateId: string, actionId: string): void {
		if (this.routes.get(actionId) !== gateId) return;
		this.routes.delete(actionId);
		if (this.active?.actionId === actionId) this.active = undefined;
		for (const routeGateId of this.routes.values()) {
			if (routeGateId === gateId) return;
		}
		const presentation = this.presentations.get(gateId);
		if (!presentation) return;
		this.presentations.delete(gateId);
		this.directControls.delete(gateId);
		this.queuedDirectControls.delete(gateId);
		this.retiredProofs.delete(gateId);
		this.retries.delete(gateId);
		this.#clearTerminalCancellation(gateId);

		const index = this.queue.indexOf(gateId);
		if (index >= 0) this.queue.splice(index, 1);
		presentation.onClosed?.();
		this.#promote();
	}

	/** Clears an interactive presentation after its route was retired for direct control. */
	completeDirect(gateId: string): void {
		const presentation = this.presentations.get(gateId);
		if (!presentation) return;
		this.presentations.delete(gateId);
		this.directControls.delete(gateId);
		this.queuedDirectControls.delete(gateId);
		this.retiredProofs.delete(gateId);
		this.retries.delete(gateId);
		this.#clearTerminalCancellation(gateId);

		const index = this.queue.indexOf(gateId);
		if (index >= 0) this.queue.splice(index, 1);
		presentation.onClosed?.();
		this.#promote();
	}

	/** Cancelling the source revokes every interactive route for its presentation. */
	#discardInteractive(gateId: string): void {
		const active = this.active;
		if (active?.gateId === gateId) {
			try {
				this.server.retireIfUnclaimed(active);
			} catch (error) {
				logger.warn(`notifications: interactive route retirement failed: ${String(error)}`);
			}
		}
		for (const [actionId, routeGateId] of this.routes) {
			if (routeGateId !== gateId) continue;
			this.routes.delete(actionId);
			if (this.active?.actionId === actionId) this.active = undefined;
		}
		const presentation = this.presentations.get(gateId);
		if (!presentation) return;
		this.presentations.delete(gateId);
		this.directControls.delete(gateId);
		this.queuedDirectControls.delete(gateId);
		this.retiredProofs.delete(gateId);
		this.retries.delete(gateId);
		this.#clearTerminalCancellation(gateId);

		const index = this.queue.indexOf(gateId);
		if (index >= 0) this.queue.splice(index, 1);
		presentation.onClosed?.();
		this.#promote();
	}

	reissueAfterFailure(actionId: string): void {
		const gateId = this.routes.get(actionId);
		if (!gateId) return;
		this.routes.delete(actionId);
		if (this.active?.actionId === actionId) this.active = undefined;
		this.reconcile();
	}

	reissue(gateId: string): string | undefined {
		const presentation = this.presentations.get(gateId);
		if (!presentation || this.directControls.has(gateId) || this.active) return undefined;
		const actionId = `${presentation.workflowGateId ? "gate-interaction" : "ask"}:${crypto.randomUUID()}`;
		this.routes.set(actionId, gateId);
		try {
			const lease = this.server.registerArbitratedAsk(
				JSON.stringify(
					notificationActionPayload(
						{
							type: "action_needed",
							id: actionId,
							kind: "ask",
							sessionId: presentation.sessionId,
							...(presentation.workflowGateId ? { workflowGateId: presentation.workflowGateId } : {}),
							question:
								presentation.selectedOptions.length > 0
									? `(${presentation.selectedOptions.length} selected) ${presentation.question}`
									: presentation.question,
							options: presentation.options,
							controls: presentation.multi
								? [
										{
											id: "navigation_forward",
											kind: "navigation",
											label: presentation.navigationLabel ?? "Done",
											enabled: presentation.allowEmpty || presentation.selectedOptions.length > 0,
										},
									]
								: presentation.controls,
						},
						{ redact: this.redact(), sessionTag: this.tag },
					),
				),
				true,
			);
			if (lease.actionId !== actionId) throw new Error("native arbitrated action id mismatch");
			this.active = { actionId, gateId, registrationEpoch: lease.registrationEpoch };
			this.retries.delete(gateId);
			presentation.onActivated?.(actionId, lease);
			return actionId;
		} catch {
			this.routes.delete(actionId);
			const previous = this.retries.get(gateId);
			const attempts = (previous?.attempts ?? 0) + 1;
			const exhausted = attempts >= PresentationArbiter.maxRegistrationAttempts;
			const delay = Math.min(
				PresentationArbiter.retryMaxDelayMs,
				PresentationArbiter.retryBaseDelayMs * 2 ** (attempts - 1),
			);
			this.retries.set(gateId, { attempts, exhausted, nextAt: Date.now() + delay });
			logger.warn("workflow_gate_presentation_retry", {
				gateId,
				attempts,
				maxAttempts: PresentationArbiter.maxRegistrationAttempts,
				exhausted,
				delayMs: exhausted ? undefined : delay,
			});
			// Exhaustion fences this queue head. Ordinary asks then terminally cancel
			// through the same cancellation path so their caller cannot wait forever;
			// durable workflow gates remain fenced for explicit recovery or cancellation.
			if (exhausted) this.#scheduleTerminalCancellation(gateId);
			else this.#scheduleRetry(gateId);
			return undefined;
		}
	}

	closeInteraction(actionId: string, reason: string): boolean {
		const gateId = this.routes.get(actionId);
		const active = this.active;
		if (!gateId || !active || active.actionId !== actionId) {
			if (gateId) this.directControls.set(gateId, this.queue.indexOf(gateId));
			logger.error(`notifications: terminalize ${actionId} lacks an exact active lease`);
			return false;
		}
		const status = parseRetireStatus(this.server.retireIfUnclaimed(active).status);
		if (isTerminalProof(status)) {
			this.routes.delete(actionId);
			this.active = undefined;
			void reason;
			return true;
		}
		this.directControls.set(gateId, this.queue.indexOf(gateId));
		logger.error(`notifications: terminalize ${actionId} returned ${status}`);
		return false;
	}

	complete(gateId: string): WorkflowGateTerminalProof {
		let proof = this.retiredProofs.get(gateId);
		for (const [actionId, routeGateId] of this.routes) {
			if (routeGateId !== gateId) continue;
			if (!this.closeInteraction(actionId, "gate_complete"))
				throw new Error(`workflow gate ${gateId} presentation lacks exact terminal proof`);
			proof = "retired";
		}
		const presentation = this.presentations.get(gateId);
		if (!proof && this.queuedDirectControls.has(gateId)) proof = "not_published";
		if (!proof && presentation)
			throw new Error(`workflow gate ${gateId} presentation lacks an active terminal lease`);
		this.presentations.delete(gateId);
		this.directControls.delete(gateId);
		this.queuedDirectControls.delete(gateId);
		this.retiredProofs.delete(gateId);
		this.retries.delete(gateId);
		this.#clearTerminalCancellation(gateId);

		const index = this.queue.indexOf(gateId);
		if (index >= 0) this.queue.splice(index, 1);
		presentation?.onClosed?.();
		this.#promote();
		return proof ?? "already_terminal";
	}

	cancelInteractive(): void {
		for (const [gateId, presentation] of this.presentations) {
			if (!presentation.workflowGateId) this.#discardInteractive(gateId);
		}
	}

	cancel(gateId: string, reason: string): void {
		this.#discardInteractive(gateId);
		void reason;
	}

	dispose(): void {
		for (const gateId of [...this.presentations.keys()]) this.cancel(gateId, "session_shutdown");
	}
}

interface SessionRuntime {
	server: NotificationServer;
	host: SessionSdkHost;
	/** Owns stateRoot-backed revisions and removes their spills on terminal shutdown. */
	revisions: RevisionStore;
	/** Releases all snapshot pins before the revision store is closed. */
	cursors: CursorRegistry;
	/** Current endpoint session identity; never re-key an existing host across a switch. */
	id: string;
	idleSeq: number;
	/** Interactive asks awaiting a remote answer, by action id. */
	pendingInteractive: Map<string, PendingInteractiveAsk>;
	/** Deregisters this session's ask answer source. */
	disposeAnswerSource: () => void;
	/** Deregisters this session's Telegram file sink. */
	disposeFileSink: () => void;
	/** Deregisters this session's workflow-gate listener. */
	disposeGateListener: () => void;
	/** Whether notification-only delivery and answer resources are active. */
	notificationsActive: boolean;
	/** Set as soon as terminal teardown is requested, before startup settles. */
	stopping: boolean;
	/** Recreates notification-only resources after `/notify on`. */
	enableNotifications: () => void;
	/** Deregisters canonical workflow-gate terminal cleanup. */
	disposeGateTerminalController: () => void;
	disposeAckRecoveryParticipant: () => void;
	disposeGateEmitterListener: () => void;
	waitForGateResolutionQuiescence: () => Promise<void>;
	workflowGate?: WorkflowGateEmitter;
	gatePresentations?: PresentationArbiter;
	redact: boolean;
	/** True only after the exact host generation was registered with the broker index. */
	brokerRegistrationActive: boolean;
	/** Terminal cleanup proof retained across retries; each owner is released at most once after proof. */
	hostStopped: boolean;
	serverStopped: boolean;
	brokerRegistrationReleased: boolean;
	verbosity: "lean" | "verbose";
	sessionTag: string;
	/** Whether the agent loop is currently running (drives the typing indicator). */
	busy: boolean;
	/** Prompt command/turn identities awaiting their corresponding agent_start. */
	pendingPromptCorrelations: Array<{ commandId: string; turnId: string }>;
	/** Identity bound to the agent lifecycle currently in flight. */
	activePromptCorrelation?: { commandId: string; turnId: string };
	/** Records a correlated prompt terminal boundary after agent unwind. */
	/** Atomically claims a correlated prompt terminal boundary after agent unwind. */
	recordPromptTerminal: (correlation: { commandId: string; turnId: string } | undefined) => boolean;
	/** Records correlated lifecycle frames for replay and delivers them only to the accepted requester after acknowledgement. */
	emitPromptLifecycle: (
		correlation: { commandId: string; turnId: string } | undefined,
		frame:
			| { type: "agent_start" | "agent_end"; sessionId: string; commandId?: string; turnId?: string }
			| {
					type: "agent_failed";
					sessionId: string;
					commandId: string;
					turnId: string;
					error: { code: string; message: string };
			  },
	) => void;
	/** Inbound Telegram update ids injected but not yet consumed by a turn. */
	pendingInbound: Set<number>;
	/** Latest assistant text of the in-flight turn (from message_update). */
	currentTurnText?: string;
	/** Assistant text already flushed before an ask this turn (turn-scoped dedupe
	 * so turn_end does not re-emit the pre-ask lead-in). Reset each turn. */
	preAskFlushedText?: string;
	/** Live streaming: opt-in flag, monotonic per-turn ref, and emit throttle state. */
	stream: boolean;
	turnSeq?: number;
	liveRef?: string;
	lastLiveAt?: number;
	lastLiveText?: string;
	/** True between turn_end and the next turn_start: drops late async message_update
	 * frames so a stale live edit can never be emitted after the finalized turn. */
	turnClosed?: boolean;
	/** Cancels the postmortem cleanup that emits `session_closed` on process teardown. */
	cancelPostmortemCleanup: () => void;
	/** Stops optional broker presence heartbeats. */
	stopBrokerHeartbeat: () => void;
}

/** Request-local requester authority for stable ControlSurface dispatches. */
const controlRequesterContext = new AsyncLocalStorage<string>();
type SessionStartStatus = "started" | "already" | "disabled" | "failed";
type SessionStartResult = {
	status: SessionStartStatus;
	runtime?: SessionRuntime;
	failure?: SdkStartupFailure;
};

function pushSessionFrame(
	runtime: Pick<SessionRuntime, "server" | "host">,
	frame: { type: string; [key: string]: unknown },
): void {
	runtime.host.emitEvent({ kind: frame.type, payload: frame });
	runtime.server.pushFrame(JSON.stringify(frame));
}

/** Agent lifecycle is SDK session truth, independent of optional chat delivery. */
function emitAgentLifecycle(
	runtime: Pick<SessionRuntime, "server" | "host">,
	frame: { type: "agent_start" | "agent_end"; sessionId: string; commandId?: string; turnId?: string },
): void {
	try {
		const json = JSON.stringify(frame);
		runtime.host.emitEvent({ kind: frame.type, payload: frame });
		runtime.server.pushFrame(json);
	} catch (error) {
		logger.warn(`sdk: lifecycle delivery failed: ${String(error)}`);
	}
}

interface ResolvedSettings {
	settings: Settings | undefined;
	cfg: NotificationConfig;
	settingsAvailable: boolean;
}

const TELEGRAM_FILE_REDACTION_ERROR = "Telegram file attachments are disabled while notifications redaction is on.";

const defaultConfig: NotificationConfig = {
	enabled: false,
	botToken: undefined,
	chatId: undefined,
	discord: {
		botToken: undefined,
	},
	slack: {
		botToken: undefined,
		channelId: undefined,
	},
	redact: false,
	verbosity: "lean",
	sessionScope: "all",
	idleTimeoutMs: 60_000,
	rich: { enabled: true },
	richDraft: { enabled: false },
	topics: {},
};

export function notificationsEnabled(): boolean {
	return process.env.GJC_NOTIFICATIONS === "1" || Boolean(process.env.GJC_NOTIFICATIONS_TOKEN);
}

// Live streaming (opt-in): emit throttled non-finalized `turn_stream` frames as
// the assistant message streams so remote clients can edit ONE message live. The
// finalized frame (turn_end) carries the same messageRef and stays authoritative,
// so a dropped live frame self-heals. Off unless GJC_NOTIFICATIONS_STREAM=1.
function streamingEnabled(): boolean {
	return process.env.GJC_NOTIFICATIONS_STREAM === "1";
}
function streamIntervalMs(): number {
	return Math.max(200, Number(process.env.GJC_NOTIFICATIONS_STREAM_INTERVAL_MS) || 500);
}
// Max chars of a turn's assistant text carried by the FINALIZED turn_stream (and
// the pre-ask capture). Finalized turns default to the bounded full-turn ceiling
// because split-capable clients such as the Telegram daemon schedule each
// splitTelegramHtml chunk through the shared rate-limit pool. Operators who want
// glanceable summaries can lower this with GJC_NOTIFICATIONS_TURN_MAX. The value
// is always clamped to a finite [280, TURN_TEXT_MAX_CEILING] range so the cap can
// never be unbounded. Live frames are intentionally NOT raised — they stay one
// editable preview message rather than fanning a long in-progress turn across
// sends.
const TURN_TEXT_MAX_CEILING = 40_000;
function turnTextMax(): number {
	const raw = Number(process.env.GJC_NOTIFICATIONS_TURN_MAX);
	if (!Number.isFinite(raw) || raw <= 0) return TURN_TEXT_MAX_CEILING;
	return Math.min(TURN_TEXT_MAX_CEILING, Math.max(280, raw));
}
function resolveNotificationConfig(settings: Settings): NotificationConfig {
	const reader = settings as Partial<NotificationSettingsReader>;
	return typeof reader.getNotificationSettingsSnapshot === "function"
		? getNotificationConfig(reader as NotificationSettingsReader)
		: defaultConfig;
}

function resolveSettings(settingsOverride?: Settings): ResolvedSettings {
	if (settingsOverride)
		return { settings: settingsOverride, cfg: resolveNotificationConfig(settingsOverride), settingsAvailable: true };
	try {
		const settings = Settings.instance;
		return { settings, cfg: getNotificationConfig(settings), settingsAvailable: true };
	} catch {
		return { settings: undefined, cfg: defaultConfig, settingsAvailable: false };
	}
}

function resolveToken(): string {
	// `GJC_NOTIFICATIONS_TOKEN` remains an enablement compatibility flag, never
	// a reusable endpoint credential. Every host identity gets fresh authority.
	return crypto.randomBytes(24).toString("base64url");
}

function parseAnswer(answerJson: string): unknown {
	try {
		return JSON.parse(answerJson);
	} catch {
		return answerJson;
	}
}

/** Map a client answer to the option LABEL the local UI would return (or free text). */
function mapAnswerToLabel(answerJson: string, options: string[]): string | undefined {
	const answer = parseAnswer(answerJson);
	if (typeof answer === "number") return options[answer];
	if (typeof answer === "string") return answer;
	if (answer && typeof answer === "object") {
		const sel = (answer as { selected?: unknown; custom?: unknown }).selected;
		if (Array.isArray(sel) && sel.length > 0) {
			const first = sel[0];
			return typeof first === "number" ? options[first] : String(first);
		}
		const custom = (answer as { custom?: unknown }).custom;
		if (typeof custom === "string") return custom;
	}
	return undefined;
}

/** Workflow-gate answer shape. */
interface GateAnswer {
	selected: string[];
	other?: boolean;
	custom?: string;
}

/**
 * Discriminated result of mapping a client answer to a workflow-gate answer.
 * `ok: false` means the reply is invalid and the caller must close the exact
 * claim/receipt and reissue the interaction rather than durably accepting it.
 */
type GateAnswerResult = { ok: true; answer: GateAnswer } | { ok: false; reason: string };

/**
 * Map a client answer to the workflow-gate answer shape.
 *
 * The protocol defines a numeric reply as an option index, so a number outside
 * `options` is invalid: it must NOT be converted into free text that passes the
 * ask schema and triggers a misleading success acknowledgement.
 * Only JSON strings enter the free-text/Other path.
 */
export function mapAnswerToGate(answerJson: string, options: string[]): GateAnswerResult {
	const answer = parseAnswer(answerJson);
	if (typeof answer === "number") {
		const label = options[answer];
		return label === undefined
			? { ok: false, reason: "numeric_selector_out_of_range" }
			: { ok: true, answer: { selected: [label] } };
	}
	if (typeof answer === "string") {
		return {
			ok: true,
			answer: options.includes(answer) ? { selected: [answer] } : { selected: [], other: true, custom: answer },
		};
	}
	if (answer && typeof answer === "object") {
		const obj = answer as { selected?: unknown; custom?: unknown };
		const selected = Array.isArray(obj.selected)
			? obj.selected.map(s => (typeof s === "number" ? (options[s] ?? String(s)) : String(s)))
			: [];
		const custom = typeof obj.custom === "string" ? obj.custom : undefined;
		return { ok: true, answer: { selected, other: custom !== undefined, custom } };
	}
	return { ok: true, answer: { selected: [] } };
}

interface NotificationControlCommandPayload {
	name?: unknown;
	action?: unknown;
	level?: unknown;
	global?: unknown;
	selector?: unknown;
	instructions?: unknown;
}

export interface NotificationControlCommandResult {
	status: "ok" | "error" | "unavailable";
	message: string;
	modelChoices?: Array<{ selector: string; label: string }>;
}

function parseControlCommandPayload(json: string | undefined): NotificationControlCommandPayload | undefined {
	if (!json) return undefined;
	try {
		const parsed = JSON.parse(json) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as NotificationControlCommandPayload) : undefined;
	} catch {
		return undefined;
	}
}

function formatCompactTokenCount(value: number | null | undefined): string {
	if (value == null) return "unknown";
	if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1))}m`;
	if (value >= 1_000) return `${Number((value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1))}k`;
	return value.toLocaleString();
}

function formatContextUsageLine(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	if (!usage) return "Context usage unavailable.";
	const tokens = formatCompactTokenCount(usage.tokens);
	const window = formatCompactTokenCount(usage.contextWindow);
	const pct = usage.percent == null ? "unknown" : `${usage.percent.toFixed(1)}%`;
	return `Context: ${tokens}/${window} ${pct}`;
}

function formatLocalUsage(ctx: ExtensionContext): string {
	const stats = ctx.sessionManager.getUsageStatistics();
	return [
		"Usage",
		`Input tokens: ${stats.input}`,
		`Output tokens: ${stats.output}`,
		`Cache read tokens: ${stats.cacheRead}`,
		`Cache write tokens: ${stats.cacheWrite}`,
		`Premium requests: ${stats.premiumRequests}`,
		`Cost: $${stats.cost.toFixed(6)}`,
	].join("\n");
}

interface SafeUsageWindow {
	kind: "5h" | "7d";
	usedFraction?: number;
	resetsAt?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function classifyUsageWindow(limit: Record<string, unknown>): "5h" | "7d" | undefined {
	const window = isRecord(limit.window) ? limit.window : undefined;
	const scope = isRecord(limit.scope) ? limit.scope : undefined;
	const ids = [window?.id, scope?.windowId, limit.id];
	for (const id of ids) {
		if (typeof id !== "string") continue;
		const normalized = id.toLowerCase();
		if (normalized === "5h" || normalized === "7d") return normalized;
	}
	const durationMs = window?.durationMs;
	if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) return undefined;
	if (Math.abs(durationMs - 5 * 60 * 60_000) <= 30 * 60_000) return "5h";
	if (Math.abs(durationMs - 7 * 24 * 60 * 60_000) <= 12 * 60 * 60_000) return "7d";
	return undefined;
}

function getUsageUsedFraction(amount: Record<string, unknown> | undefined): number | undefined {
	if (!amount) return undefined;
	const usedFraction = amount.usedFraction;
	if (typeof usedFraction === "number" && Number.isFinite(usedFraction)) return usedFraction;
	const used = amount.used;
	if (typeof used !== "number" || !Number.isFinite(used)) return undefined;
	if (amount.unit === "percent") return used / 100;
	const limit = amount.limit;
	return typeof limit === "number" && Number.isFinite(limit) && limit !== 0 ? used / limit : undefined;
}

function formatStableResetTime(value: number): string | undefined {
	if (!Number.isFinite(value)) return undefined;
	try {
		return new Date(value)
			.toISOString()
			.replace("T", " ")
			.replace(/\.\d{3}Z$/, " UTC");
	} catch {
		return undefined;
	}
}

function shouldReplaceUsageWindow(current: SafeUsageWindow, candidate: SafeUsageWindow): boolean {
	if (candidate.usedFraction !== undefined) {
		if (current.usedFraction === undefined || candidate.usedFraction > current.usedFraction) return true;
		if (candidate.usedFraction < current.usedFraction) return false;
	}
	if (current.usedFraction !== undefined && candidate.usedFraction === undefined) return false;
	if (candidate.resetsAt === undefined) return false;
	return current.resetsAt === undefined || candidate.resetsAt < current.resetsAt;
}

function formatRemoteUsageWindows(reports: unknown): string[] {
	if (!Array.isArray(reports)) return [];
	const windows = new Map<SafeUsageWindow["kind"], SafeUsageWindow>();
	for (const report of reports) {
		if (!isRecord(report) || !Array.isArray(report.limits)) continue;
		for (const value of report.limits) {
			if (!isRecord(value)) continue;
			const kind = classifyUsageWindow(value);
			if (!kind) continue;
			const window = isRecord(value.window) ? value.window : undefined;
			const amount = isRecord(value.amount) ? value.amount : undefined;
			const usedFraction = getUsageUsedFraction(amount);
			const resetsAt = window?.resetsAt;
			const candidate: SafeUsageWindow = {
				kind,
				...(typeof usedFraction === "number" && Number.isFinite(usedFraction) ? { usedFraction } : {}),
				...(typeof resetsAt === "number" && Number.isFinite(resetsAt) ? { resetsAt } : {}),
			};
			const current = windows.get(kind);
			if (!current || shouldReplaceUsageWindow(current, candidate)) windows.set(kind, candidate);
		}
	}
	return (["5h", "7d"] as const).flatMap(kind => {
		const window = windows.get(kind);
		if (!window) return [];
		const details = [kind === "5h" ? "5-hour limit" : "Weekly limit"];
		if (window.usedFraction !== undefined) details.push(`${Number((window.usedFraction * 100).toFixed(1))}% used`);
		const resetTime = window.resetsAt === undefined ? undefined : formatStableResetTime(window.resetsAt);
		if (resetTime) details.push(`resets ${resetTime}`);
		return [details.join(" — ")];
	});
}

async function formatUsage(ctx: ExtensionContext, api: ExtensionAPI): Promise<string> {
	const local = formatLocalUsage(ctx);
	try {
		const windows = formatRemoteUsageWindows(await api.fetchUsageReportsForControl());
		return windows.length > 0 ? `${local}\n\nUsage windows\n${windows.join("\n")}` : local;
	} catch {
		logger.warn("notifications: usage report fetch failed");
		return local;
	}
}

function formatReasoningSettings(api: ExtensionAPI): string {
	const level = api.getThinkingLevel() ?? ThinkingLevel.Off;
	const display = api.getThinkingVisibility() === "visible" ? "on" : "off";
	return [
		"🧠 Reasoning Settings",
		`Effort: ${level}`,
		`Scope: ${api.getThinkingScopeForControl()}`,
		`Display: ${display}`,
		telegramControlCommandUsage("reasoning"),
	].join("\n");
}

const TELEGRAM_MODEL_CHOICE_LIMIT = 40;

function getModelChoices(ctx: ExtensionContext): Array<{ selector: string; label: string }> {
	const choices = new Map<string, { selector: string; label: string }>();
	for (const model of ctx.modelRegistry.getAvailable()) {
		const selector = `${model.provider}/${model.id}`;
		if (!choices.has(selector)) {
			choices.set(selector, { selector, label: selector.replace(/[\u0000-\u001F\u007F]/g, " ") });
		}
	}
	return [...choices.values()]
		.sort((left, right) => left.selector.localeCompare(right.selector))
		.slice(0, TELEGRAM_MODEL_CHOICE_LIMIT);
}

const CONTROL_COMMAND_FAILURE_MESSAGE = "Control command failed.";
const STALE_MODEL_BUTTON_MESSAGE = "Button is stale. Run /model again.";

export async function executeNotificationControlCommand(
	command: NotificationControlCommandPayload | undefined,
	ctx: ExtensionContext,
	api: ExtensionAPI,
	expectedSessionId?: string,
): Promise<NotificationControlCommandResult> {
	try {
		return await executeNotificationControlCommandUnchecked(command, ctx, api, expectedSessionId);
	} catch {
		logger.warn("notifications: control command failed");
		return { status: "error", message: CONTROL_COMMAND_FAILURE_MESSAGE };
	}
}

async function executeNotificationControlCommandUnchecked(
	command: NotificationControlCommandPayload | undefined,
	ctx: ExtensionContext,
	api: ExtensionAPI,
	expectedSessionId?: string,
): Promise<NotificationControlCommandResult> {
	if (!command || typeof command.name !== "string") return { status: "error", message: "Invalid control command." };
	switch (command.name) {
		case "reasoning": {
			const global = command.global === true;
			if (command.action === "status") return { status: "ok", message: formatReasoningSettings(api) };
			if (command.action === "cycle") {
				const next = api.cycleThinkingLevel();
				return next
					? { status: "ok", message: formatReasoningSettings(api) }
					: { status: "unavailable", message: "Reasoning effort unavailable for this session." };
			}
			if (command.action === "set" && typeof command.level === "string") {
				const requestedLevel = command.level.toLowerCase();
				const level = requestedLevel === "none" ? "off" : requestedLevel === "reset" ? "inherit" : requestedLevel;
				const parsed = parseThinkingLevel(level);
				if (!parsed) return { status: "error", message: "Invalid reasoning effort." };
				await api.setThinkingLevelForControl(parsed, global);
				return { status: "ok", message: formatReasoningSettings(api) };
			}
			if (command.action === "show" || command.action === "hide") {
				await api.setThinkingVisibilityForControl(command.action === "show" ? "visible" : "hidden", global);
				return { status: "ok", message: formatReasoningSettings(api) };
			}
			return { status: "error", message: "Invalid reasoning command." };
		}
		case "usage":
			return { status: "ok", message: await formatUsage(ctx, api) };
		case "context":
			return { status: "ok", message: formatContextUsageLine(ctx) };
		case "model": {
			const choices = getModelChoices(ctx);
			if (command.action === "list") {
				return choices.length > 0
					? { status: "ok", message: "Select a model.", modelChoices: choices }
					: { status: "unavailable", message: "No models are available for this session." };
			}
			if (command.action !== "set" || typeof command.selector !== "string") {
				return { status: "error", message: "Invalid model selection." };
			}
			const model = ctx.modelRegistry
				.getAvailable()
				.find(candidate => `${candidate.provider}/${candidate.id}` === command.selector);
			if (!model) return { status: "error", message: "Invalid model selection." };
			if (!(await api.setModelTemporaryForControl(model, expectedSessionId)))
				return { status: "unavailable", message: "Model unavailable for this session." };
			return { status: "ok", message: `Model set to ${command.selector}.` };
		}
		case "compact": {
			const before = ctx.getContextUsage()?.tokens;
			await ctx.compact(typeof command.instructions === "string" ? command.instructions : undefined);
			const after = ctx.getContextUsage()?.tokens;
			if (before != null && after != null)
				return {
					status: "ok",
					message: `Compaction complete. Tokens: ${before} -> ${after} (saved ${before - after}).`,
				};
			return { status: "ok", message: "Compaction complete." };
		}
		default:
			return { status: "error", message: "Unknown control command." };
	}
}

function selectedAckOutcome(value: { status: string; messageId?: number; reason?: string }): AskSelectedAckOutcome {
	if (value.status === "delivered" && typeof value.messageId === "number") {
		return { status: "delivered", messageId: value.messageId };
	}
	if (value.status === "failed") {
		switch (value.reason) {
			case "unsupported":
			case "no_participant":
			case "ambiguous_participant":
			case "route_missing":
			case "expired":
			case "cancelled":
			case "telegram_rejected":
			case "session_closed":
				return { status: "failed", reason: value.reason };
			default:
				return { status: "failed", reason: "session_closed" };
		}
	}
	switch (value.reason) {
		case "transport_ambiguous":
		case "origin_disconnected":
		case "host_timeout":
		case "shutdown":
			return { status: "unknown", reason: value.reason };
		default:
			return { status: "unknown", reason: "host_timeout" };
	}
}

async function requestLiveSelectedAck(
	native: {
		requestAskSelectedAck(
			replyReceiptId: string,
			requestJson: string,
		): Promise<{ status: string; messageId?: number; reason?: string }>;
	},
	input: { replyReceiptId: string; actionId: string; commitKey: string; deadlineAt: number },
): Promise<AskSelectedAckOutcome> {
	const requestId = `ack:${crypto.randomUUID()}`;
	try {
		return selectedAckOutcome(
			await native.requestAskSelectedAck(
				input.replyReceiptId,
				JSON.stringify({
					mode: "live",
					requestId,
					commitKey: input.commitKey,
					actionId: input.actionId,
					deadlineAt: input.deadlineAt,
				}),
			),
		);
	} catch (error) {
		logger.warn(`notifications: Selected acknowledgement failed: ${String(error)}`);
		return { status: "unknown", reason: "host_timeout" };
	}
}

async function requestRecoveredSelectedAck(
	native: {
		requestRecoveredAskSelectedAck(
			requestJson: string,
		): Promise<{ status: string; messageId?: number; reason?: string }>;
	},
	input: { sessionId: string; actionId: string; commitKey: string; deadlineAt: number },
): Promise<AskSelectedAckOutcome> {
	try {
		return selectedAckOutcome(
			await native.requestRecoveredAskSelectedAck(
				JSON.stringify({
					mode: "recovery",
					requestId: `ack:${crypto.randomUUID()}`,
					commitKey: input.commitKey,
					sessionId: input.sessionId,
					actionId: input.actionId,
					deadlineAt: input.deadlineAt,
				}),
			),
		);
	} catch (error) {
		logger.warn(`notifications: recovered Selected acknowledgement failed: ${String(error)}`);
		return { status: "unknown", reason: "host_timeout" };
	}
}

/** Register the interactive `ask` answer source for a session (the ask tool
 * races the local UI against a remote reply). Returns the deregister disposer. */
function registerInteractiveAnswerSource(
	id: string,
	pendingInteractive: Map<string, PendingInteractiveAsk>,
	presentationArbiter: PresentationArbiter,
): () => void {
	return registerAskAnswerSource(id, {
		awaitAnswer(question, options, signal) {
			const result = this.awaitAnswerRequest?.({ question, options, interaction: "selector", controls: [] }, signal);
			if (!result) return Promise.resolve(undefined);
			return result.then(answer => {
				if (!answer || typeof answer === "string") return answer;
				return answer.interaction.kind === "value" ? answer.interaction.value : undefined;
			});
		},
		awaitAnswerRequest(request: AskAnswerRequest, signal?: AbortSignal): Promise<AskAnswerSourceResult> {
			if (signal?.aborted) return Promise.resolve(undefined);
			const presentationId = `interactive:${crypto.randomUUID()}`;
			return new Promise<AskAnswerSourceResult>(resolve => {
				let settled = false;
				const settle = (result: AskAnswerSourceResult) => {
					if (settled) return;
					settled = true;
					resolve(result);
				};
				const pending: PendingInteractiveAsk = {
					resolve: settle,
					options: request.options,
					controls: request.controls,
					retireForDirectControl: () => presentationArbiter.retireForDirectControl(presentationId),
					reissue: () => {
						if (!pending.actionId) return false;
						presentationArbiter.reissueAfterFailure(pending.actionId);
						return true;
					},
					complete: actionId => presentationArbiter.completeInteractive(presentationId, actionId),
					completeDirect: () => presentationArbiter.completeDirect(presentationId),
					fail: actionId => presentationArbiter.completeInteractive(presentationId, actionId),
				};
				presentationArbiter.retain({
					gateId: presentationId,
					sessionId: id,
					question: request.question,
					options: request.options,
					controls: request.controls,
					multi: false,
					allowEmpty: false,
					selectedOptions: [],
					onActivated: (actionId, lease) => {
						if (pending.actionId && pendingInteractive.get(pending.actionId) === pending)
							pendingInteractive.delete(pending.actionId);
						pending.actionId = actionId;
						pendingInteractive.set(actionId, pending);
						void lease;
					},
					onClosed: () => {
						if (pending.actionId && pendingInteractive.get(pending.actionId) === pending)
							pendingInteractive.delete(pending.actionId);
						settle(undefined);
					},
				});
				signal?.addEventListener("abort", () => {
					presentationArbiter.cancel(presentationId, "interactive_abort");
				});
			});
		},
	});
}

/** Extract the session id from a `<timestamp>_<uuid>.jsonl` session file path. */
function sessionIdFromFile(file: string | undefined): string | undefined {
	if (!file) return undefined;
	const base = path.basename(file).replace(/\.jsonl$/, "");
	const underscore = base.indexOf("_");
	return underscore >= 0 ? base.slice(underscore + 1) : undefined;
}

function safeLifecycleRequestId(value: string | undefined): string | undefined {
	return value && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : undefined;
}

function validateProviderDefinitions(capability: string, definitions: unknown): void {
	if (capability !== "host_tools" && capability !== "host_uri") return;
	const invalid = (message: string): never => {
		throw Object.assign(new Error(message), { code: "invalid_input" });
	};
	if (!Array.isArray(definitions)) invalid(`${capability} definitions must be an array.`);
	for (const definition of definitions as unknown[]) {
		if (!definition || typeof definition !== "object" || Array.isArray(definition))
			invalid(`${capability} definitions must contain objects.`);
		const entry = definition as Record<string, unknown>;
		if (capability === "host_tools") {
			if (typeof entry.name !== "string" || entry.name.trim() === "")
				invalid("host_tools definitions require a non-empty string name.");
			if (typeof entry.description !== "string") invalid("host_tools definitions require a string description.");
			if (!entry.parameters || typeof entry.parameters !== "object" || Array.isArray(entry.parameters))
				invalid("host_tools definitions require an object parameters.");
		} else if (
			typeof entry.scheme !== "string" ||
			!/^[a-z][a-z0-9+.-]*$/.test(entry.scheme) ||
			["http", "https", "file", "ws", "wss"].includes(entry.scheme)
		) {
			invalid("host_uri definitions require a non-reserved URI scheme.");
		}
	}
}

const UNINSTALLED_CONTROL_OPERATIONS = new Set(["auth.login", "host_tools.register", "host_uri.register"]);

const CONTROL_BINDINGS: Readonly<Record<string, string | undefined>> = {
	"model.cycle": "cycleModel",
	"thinking.cycle": "cycleThinkingLevel",
	"queue.steering_mode.set": "setQueueMode",
	"queue.follow_up_mode.set": "setQueueMode",
	"queue.interrupt_mode.set": "setQueueMode",
	"todo.replace": "sdkControl",
	"permission_mode.set": "sdkControl",
	"skill.invoke": "invokeSkill",
	"mode.plan.set": "setPlanMode",
	"mode.goal.operate": "operateGoal",

	"compaction.auto.set": "sdkControl",
	"retry.auto.set": "sdkControl",
	"retry.abort": "sdkControl",
	"bash.execute": "sdkControl",
	"bash.abort": "sdkControl",
	"session.new": "sdkControl",
	"session.fork": "sdkControl",
	"session.resume": "sdkControl",
	"session.close": "sdkControl",
	"session.switch": "sdkControl",
	"session.branch": "sdkControl",
	"session.rename": "sdkControl",
	"session.handoff": "sdkControl",
	"session.export_html": "sdkControl",
	"runtime.reload": "sdkControl",
	"service_tier.set": "sdkControl",
	"queue.message.remove": "sdkControl",
	"queue.message.move": "sdkControl",
	"queue.message.update": "sdkControl",
	"extension.set_enabled": "sdkControl",
	"session.delete": "sdkControl",
	"session.cwd.move": "sdkControl",
	"retry.last": "sdkControl",
	"retry.now": "sdkControl",
	"bash.background": "sdkControl",
};
const QUERY_BINDINGS: Readonly<Record<string, string | undefined>> = {
	"skill.list/state": "getSkillState",
	"config.list/get": "getConfigItems",
	"session.branch_candidates": "getBranchCandidates",
	"extensions.list": "getExtensions",
	"artifact.read": "getArtifactRange",

	"runtime.jobs.list": "getJobs",
};

function hasTerminalArbitrationCapability(
	workflowGate: WorkflowGateEmitter | undefined,
): workflowGate is WorkflowGateEmitter &
	Required<
		Pick<
			WorkflowGateEmitter,
			"resolveGate" | "prepareTerminalization" | "clearPreparedTerminalization" | "registerGateTerminalController"
		>
	> {
	return (
		typeof workflowGate?.resolveGate === "function" &&
		typeof workflowGate.prepareTerminalization === "function" &&
		typeof workflowGate.clearPreparedTerminalization === "function" &&
		typeof workflowGate.registerGateTerminalController === "function"
	);
}

function installedOperations(ctx: ExtensionContext, kind: "control" | "query"): Set<string> {
	const bindings = new Set(ctx.sdkBindings?.() ?? []);
	const required = kind === "control" ? CONTROL_BINDINGS : QUERY_BINDINGS;
	const candidates = OPERATIONS.filter(
		operation =>
			operation.kind === kind &&
			(kind !== "control" ||
				(!UNINSTALLED_CONTROL_OPERATIONS.has(operation.sdkId) &&
					((operation.sdkId !== "workflow.gate_answer" && operation.sdkId !== "workflow.plan_approve") ||
						hasTerminalArbitrationCapability(ctx.workflowGate)) &&
					(!required[operation.sdkId] || bindings.has(required[operation.sdkId]!)))),
	);
	return new Set(candidates.map(operation => operation.sdkId));
}

function sdkQuerySurface(
	ctx: ExtensionContext,
	id: string,
	api: ExtensionAPI,
	getInstalledDefinitions: (capability: string) => unknown | undefined = () => undefined,
	getLiveState: () => { isStreaming: boolean; steeringQueueDepth: number; followupQueueDepth: number } = () => ({
		isStreaming: false,
		steeringQueueDepth: 0,
		followupQueueDepth: 0,
	}),
	configOverrides: ReadonlyMap<string, unknown> = new Map(),
): SessionSurface {
	const metadata = () => ({
		sessionId: id,
		name: ctx.sessionManager.getSessionName(),
		cwd: ctx.cwd,
		kind: ctx.sessionMetadata?.kind ?? "main",
	});
	const lastAssistantText = () => {
		for (const entry of ctx.sessionManager.getBranch().toReversed()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const { content } = entry.message;
			if (typeof content === "string") return content;
			if (Array.isArray(content))
				return content
					.filter(
						(block): block is { type: "text"; text: string } =>
							block.type === "text" && typeof block.text === "string",
					)
					.map(block => block.text)
					.join("");
		}
		return undefined;
	};
	const getDiff = async () => {
		try {
			const { stdout } = await execFileAsync("git", ["diff", "--no-ext-diff"], {
				cwd: ctx.cwd,
				maxBuffer: 1024 * 1024,
			});
			return stdout
				.split(/^diff --git /m)
				.filter(Boolean)
				.map(section => {
					const header = section.split("\n", 1)[0] ?? "";
					const match = /a\/(.+?) b\/(.+)$/.exec(header);
					return { id: match?.[2] ?? header, path: match?.[2] ?? header, body: `diff --git ${section}` };
				});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr ?? "") : "";
			if (/not a git repository/i.test(`${detail}\n${stderr}`))
				throw new DiffQueryError("not_git_repository", "diff queries require a Git working tree");
			if (/maxbuffer|ERR_CHILD_PROCESS_STDIO_MAXBUFFER/i.test(detail))
				throw new DiffQueryError("diff_too_large", "diff exceeds the 1 MiB query limit");
			throw error;
		}
	};
	return {
		getTranscriptEntries: () =>
			typeof (ctx as Partial<ExtensionContext>).getTranscript === "function" ? ctx.getTranscript() : [],
		getContextSnapshot: () => ({
			usage: ctx.getContextUsage(),
			systemPrompt: ctx.getSystemPrompt(),
			...getLiveState(),
		}),
		getGoalState: () =>
			typeof (ctx as Partial<ExtensionContext>).getGoalState === "function" ? ctx.getGoalState() : undefined,
		getTodoState: () =>
			typeof (ctx as Partial<ExtensionContext>).getTodoState === "function" ? ctx.getTodoState() : [],
		getDiff,
		getUsage: () => ctx.sessionManager.getUsageStatistics(),
		getModels: () => {
			const models = ctx.modelRegistry.getAll();
			const currentModel = ctx.model;
			const currentThinkingLevel = api.getThinkingLevel();
			return projectQ10Models({ models, currentModel, currentThinkingLevel });
		},
		getSkillState: () => ctx.getSkillState(),
		getGates: () => {
			const workflowGate = ctx.workflowGate;
			if (!workflowGate) return [];
			return (
				workflowGate.listWorkflowGateQueryRecords?.() ??
				workflowGate.listPendingGates?.().map(gate => ({
					...gate,
					id: `pending:${gate.gate_id}`,
					tag: "pending" as const,
				})) ??
				[]
			);
		},
		getConfigItems: () => {
			const items = ctx.getConfigItems();
			return items && typeof items === "object" && !Array.isArray(items)
				? { ...(items as Record<string, unknown>), ...Object.fromEntries(configOverrides) }
				: items;
		},

		getSessionMetadata: metadata,
		getStats: () => ctx.sessionManager.getUsageStatistics(),
		getBranchCandidates: () => ctx.getBranchCandidates(),
		getLastAssistant: lastAssistantText,

		getCapabilities: () => ({
			operations: [...installedOperations(ctx, "control"), ...installedOperations(ctx, "query")],
			hostTools: getInstalledDefinitions("host_tools") !== undefined,
		}),
		getAuthProviders: () => [...new Set(ctx.modelRegistry.getAll().map(model => model.provider))],
		getTools: () => {
			const tools = typeof (ctx as Partial<ExtensionContext>).getAllTools === "function" ? ctx.getAllTools() : [];
			return tools.length > 0 ? tools : (getInstalledDefinitions("host_tools") ?? []);
		},
		getQueueMessages: () => ctx.getQueuedMessages(),
		getExtensions: () => ctx.getExtensions(),
		getArtifactRange: (id, offset, length) => ctx.getArtifactRange?.(id, offset, length),
		getJobs: () => ctx.getJobs(),
		installedQueries: installedOperations(ctx, "query"),
	};
}

function containsSecretConfigKey(value: unknown, seen = new Set<object>()): boolean {
	if (!value || typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.some(item => containsSecretConfigKey(item, seen));
	return Object.entries(value as Record<string, unknown>).some(
		([key, nested]) =>
			/(?:token|secret|password|api[_-]?key|credential|authorization)/i.test(key) ||
			containsSecretConfigKey(nested, seen),
	);
}

function sdkControlSurface(
	ctx: ExtensionContext,
	pendingInteractive: Map<string, PendingInteractiveAsk>,
	gatePresentations: PresentationArbiter | undefined,
	api: ExtensionAPI,
	isBusy: () => boolean,
	onPromptAccepted: (
		correlation: { commandId: string; turnId: string },
		requesterConnectionId?: string,
	) => void = () => {},
	onPromptFailed: (correlation: { commandId: string; turnId: string }, error: unknown) => void = () => {},
	acceptGateResolution: () => boolean,
	trackGateResolution: <T>(resolution: Promise<T>) => Promise<T>,
	settings?: Settings,
	configOverrides: Map<string, unknown> = new Map(),
	configRevision: { current: number } = { current: 0 },
): ControlSurface {
	const unavailable = (operation: string, reason: string) => () => {
		throw Object.assign(new Error(`${operation} is unavailable: ${reason}`), { code: "unavailable" });
	};
	const bindings = new Set(ctx.sdkBindings?.() ?? []);
	const missingExpectedSessionAudits = new Set<"workflow.gate_answer" | "workflow.plan_approve">();
	const auditMissingExpectedSessionId = (operation: "workflow.gate_answer" | "workflow.plan_approve") => {
		if (missingExpectedSessionAudits.has(operation)) return;
		missingExpectedSessionAudits.add(operation);
		logger.warn("workflow_control_missing_expected_session_id", { operation });
	};
	const reconcileUnknownGateFailure = (gateId: string): "pending" | "terminal" | "unavailable" => {
		const pending = ctx.workflowGate?.listPendingGates;
		if (!pending) return "unavailable";
		try {
			return pending().some(gate => gate.gate_id === gateId) ? "pending" : "terminal";
		} catch {
			logger.warn("workflow_gate_reconciliation_unavailable", { gateId });
			return "unavailable";
		}
	};
	const reconcileDirectControlFailure = (gateId: string): DirectControlOutcome => {
		const durable = reconcileUnknownGateFailure(gateId);
		if (durable === "pending") return "rejected";
		if (durable === "terminal") return "accepted";
		try {
			ctx.workflowGate?.quarantineGate?.(gateId);
		} catch {
			// The local arbiter still fails closed when the durable fence is unavailable.
		}
		return "unknown";
	};
	const sendSteer = (text: string) => {
		api.sendUserMessage(text, { deliverAs: "steer" });
		return { commandId: crypto.randomUUID(), accepted: true };
	};
	const resolveModel = (id: string) => {
		const [provider, ...modelId] = id.split("/");
		const model =
			modelId.length > 0
				? ctx.modelRegistry.find(provider, modelId.join("/"))
				: ctx.modelRegistry.getAll().find(candidate => candidate.id === id);
		if (!model) throw Object.assign(new Error(`Model ${id} was not found.`), { code: "invalid_input" });
		return model;
	};
	const unavailablePerSession = (operation: string) =>
		unavailable(operation, "the registry classifies it outside the per-session extension host");
	const typed = (operation: string, input: Record<string, unknown> = {}) => {
		if (!bindings.has("sdkControl") || !ctx.sdkControl)
			return unavailable(operation, "no typed session seam is installed")();
		return ctx.sdkControl(operation, input);
	};
	const pendingPreflightCancellations = new Set<() => void>();
	const cancelPendingPreflights = () => {
		for (const cancel of pendingPreflightCancellations) cancel();
	};
	const isSessionBusy = () => isBusy() || ctx.isIdle?.() === false;
	const awaitAbortReady = async () => {
		cancelPendingPreflights();
		await (ctx.abort as () => unknown)();
		while (isSessionBusy()) {
			await Bun.sleep(10);
		}
	};
	const submitPrompt = async (
		text: string,
		images: unknown,
		forceFresh = false,
		deliverAs?: "steer" | "followUp",
		rejectWhenBusy = false,
		requesterConnectionId?: string,
	) => {
		if (forceFresh && isSessionBusy()) {
			throw Object.assign(new Error("Previous turn did not finish aborting before replacement prompt submission."), {
				code: "busy",
			});
		}
		if (rejectWhenBusy && isSessionBusy())
			throw Object.assign(
				new Error("turn.prompt is unavailable while the agent is busy; use turn.steer explicitly."),
				{
					code: "busy",
				},
			);
		const promptImages = Array.isArray(images) ? (images as { data: string; mimeType?: string }[]) : [];
		const content: string | (TextContent | ImageContent)[] =
			promptImages.length > 0
				? [
						...(text ? [{ type: "text", text } as TextContent] : []),
						...promptImages.map(
							img => ({ type: "image", data: img.data, mimeType: img.mimeType ?? "image/jpeg" }) as ImageContent,
						),
					]
				: text;
		const commandId = crypto.randomUUID();
		const turnId = crypto.randomUUID();
		type PreflightTerminalResult = { status: "accepted" } | { status: "rejected"; error: unknown };
		const preflight = Promise.withResolvers<PreflightTerminalResult>();
		let preflightSettled = false;
		let accepted = false;
		const correlation = { commandId, turnId };
		const settlePreflight = (result: PreflightTerminalResult) => {
			if (preflightSettled) return;
			preflightSettled = true;
			preflight.resolve(result);
		};
		const cancelPreflight = () =>
			settlePreflight({
				status: "rejected",
				error: Object.assign(new Error("Prompt preflight was cancelled before execution."), { code: "busy" }),
			});
		pendingPreflightCancellations.add(cancelPreflight);
		const onPreflightAccepted = () => {
			if (preflightSettled) return;
			accepted = true;
			onPromptAccepted(correlation, requesterConnectionId);
			settlePreflight({ status: "accepted" });
		};
		// Do not acknowledge the prompt until AgentSession's async preflight
		// succeeds. The terminal result records correlation before agent_start can fire.
		let submission: Promise<void> | undefined;
		try {
			submission = Promise.resolve(
				api.sendUserMessage(content, {
					...(deliverAs ? { deliverAs } : !forceFresh && isBusy() ? { deliverAs: "steer" as const } : {}),
					onPreflightAccepted,
				}),
			);
		} catch (error) {
			if (accepted) onPromptFailed(correlation, error);
			else settlePreflight({ status: "rejected", error });
		}
		if (submission) {
			void submission.then(
				() => {
					if (!accepted)
						settlePreflight({
							status: "rejected",
							error: Object.assign(new Error("Prompt submission completed without preflight acceptance."), {
								code: "busy",
							}),
						});
				},
				error => {
					if (accepted) onPromptFailed(correlation, error);
					else settlePreflight({ status: "rejected", error });
				},
			);
		}
		try {
			const result = await preflight.promise;
			if (result.status === "rejected") throw result.error;
			return { commandId, turnId, accepted: true };
		} finally {
			pendingPreflightCancellations.delete(cancelPreflight);
		}
	};
	const surface: ControlSurface & { cancelPendingPreflights(): void } = {
		prompt: (text, images) => submitPrompt(text, images, false, undefined, true, controlRequesterContext.getStore()),
		steer: text => sendSteer(text),
		followUp: text => submitPrompt(text, undefined, false, "followUp", false, controlRequesterContext.getStore()),
		abort: () => {
			cancelPendingPreflights();
			ctx.abort();
			return { aborted: true };
		},
		abortAndPrompt: async text => {
			await awaitAbortReady();
			return await submitPrompt(text, undefined, true, undefined, false, controlRequesterContext.getStore());
		},
		cancelPendingPreflights,
		answerAsk: (id, answer) => {
			const pending = pendingInteractive.get(id);
			if (!pending) throw Object.assign(new Error(`Ask ${id} was not found.`), { code: "resource_gone" });
			const outcome = pending.retireForDirectControl();
			if (outcome === "claimed")
				throw Object.assign(new Error("The active action is already being answered."), { code: "action_claimed" });
			if (outcome === "stale") throw Object.assign(new Error(`Ask ${id} was not found.`), { code: "resource_gone" });
			if (pendingInteractive.get(id) === pending) pendingInteractive.delete(id);
			pending.resolve(mapAnswerToLabel(JSON.stringify(answer), pending.options));
			pending.completeDirect();
			return { resolved: true };
		},
		answerGate: async (id, response, expectedSessionId) => {
			if (!acceptGateResolution())
				throw Object.assign(new Error("Workflow gate is no longer answerable."), { code: "resource_gone" });
			if (expectedSessionId === undefined) auditMissingExpectedSessionId("workflow.gate_answer");
			if (expectedSessionId !== undefined && expectedSessionId !== ctx.sessionManager.getSessionId())
				throw Object.assign(new Error("Workflow gate session does not match this endpoint."), {
					code: "resource_gone",
				});
			const presentations = gatePresentations;
			if (!presentations)
				throw Object.assign(new Error("Workflow gates are unavailable for this session."), {
					code: "resource_gone",
				});
			const prepared = presentations.prepareDirectControl(id);
			if (!prepared || prepared.status === "stale")
				throw Object.assign(new Error("Workflow gate is no longer answerable."), { code: "resource_gone" });
			if (prepared.status === "claimed")
				throw Object.assign(new Error("The active action is already being answered."), { code: "action_claimed" });
			if (prepared.status !== "queued" && prepared.status !== "retired")
				throw new Error(`Unexpected direct control preparation: ${prepared.status}`);
			if (
				ctx.workflowGate?.prepareTerminalization?.(
					id,
					prepared.status === "queued" ? "not_published" : "retired",
				) !== true
			) {
				presentations.finishDirectControl(id, prepared, "rejected");
				throw Object.assign(new Error("Workflow gate lacks a terminalization proof."), { code: "resource_gone" });
			}
			try {
				const resolution = await trackGateResolution(
					ctx.workflowGate?.resolveGate?.({
						gate_id: id,
						answer: response,
						idempotency_key: id,
					}) ?? unavailable("workflow.gate_answer", "workflow gates are unavailable for this session")(),
				);
				const status = (resolution as { status?: unknown }).status;
				if (status === "accepted" || status === "rejected") {
					if (status === "rejected") ctx.workflowGate?.clearPreparedTerminalization?.(id);
					presentations.finishDirectControl(id, prepared, status);
					return resolution;
				}
			} catch (error) {
				const outcome = reconcileDirectControlFailure(id);
				if (outcome === "rejected") ctx.workflowGate?.clearPreparedTerminalization?.(id);
				presentations.finishDirectControl(id, prepared, outcome);
				if (outcome === "unknown")
					throw Object.assign(new Error("Workflow gate resolution outcome is uncertain."), {
						code: "terminal_uncertain",
					});
				throw error;
			}
			const outcome = reconcileDirectControlFailure(id);
			if (outcome === "rejected") ctx.workflowGate?.clearPreparedTerminalization?.(id);
			presentations.finishDirectControl(id, prepared, outcome);
			logger.warn("workflow_gate_direct_control_uncertain_outcome", {
				operation: "workflow.gate_answer",
				gateId: id,
				outcome,
			});
			throw Object.assign(new Error("Workflow gate resolution outcome is uncertain."), {
				code: "terminal_uncertain",
			});
		},
		approvePlan: async (id, choice, expectedSessionId) => {
			if (!acceptGateResolution())
				throw Object.assign(new Error("Workflow plan is no longer answerable."), { code: "resource_gone" });
			if (expectedSessionId === undefined) auditMissingExpectedSessionId("workflow.plan_approve");
			if (expectedSessionId !== undefined && expectedSessionId !== ctx.sessionManager.getSessionId())
				throw Object.assign(new Error("Workflow plan session does not match this endpoint."), {
					code: "resource_gone",
				});
			const presentations = gatePresentations;
			if (!presentations)
				throw Object.assign(new Error("Workflow gates are unavailable for this session."), {
					code: "resource_gone",
				});
			const prepared = presentations.prepareDirectControl(id);
			if (!prepared || prepared.status === "stale")
				throw Object.assign(new Error("Workflow plan is no longer answerable."), { code: "resource_gone" });
			if (prepared.status === "claimed")
				throw Object.assign(new Error("The active action is already being answered."), { code: "action_claimed" });
			if (prepared.status !== "queued" && prepared.status !== "retired")
				throw new Error(`Unexpected direct control preparation: ${prepared.status}`);
			if (
				ctx.workflowGate?.prepareTerminalization?.(
					id,
					prepared.status === "queued" ? "not_published" : "retired",
				) !== true
			) {
				presentations.finishDirectControl(id, prepared, "rejected");
				throw Object.assign(new Error("Workflow plan lacks a terminalization proof."), { code: "resource_gone" });
			}
			try {
				const resolution = await trackGateResolution(
					ctx.workflowGate?.resolveGate?.({
						gate_id: id,
						answer: choice,
						idempotency_key: id,
					}) ?? unavailable("workflow.plan_approve", "workflow gates are unavailable for this session")(),
				);
				const status = (resolution as { status?: unknown }).status;
				if (status === "accepted" || status === "rejected") {
					if (status === "rejected") ctx.workflowGate?.clearPreparedTerminalization?.(id);
					presentations.finishDirectControl(id, prepared, status);
					return resolution;
				}
			} catch (error) {
				const outcome = reconcileDirectControlFailure(id);
				if (outcome === "rejected") ctx.workflowGate?.clearPreparedTerminalization?.(id);
				presentations.finishDirectControl(id, prepared, outcome);
				if (outcome === "unknown")
					throw Object.assign(new Error("Workflow plan resolution outcome is uncertain."), {
						code: "terminal_uncertain",
					});
				throw error;
			}
			const outcome = reconcileDirectControlFailure(id);
			if (outcome === "rejected") ctx.workflowGate?.clearPreparedTerminalization?.(id);
			presentations.finishDirectControl(id, prepared, outcome);
			logger.warn("workflow_gate_direct_control_uncertain_outcome", {
				operation: "workflow.plan_approve",
				gateId: id,
				outcome,
			});
			throw Object.assign(new Error("Workflow plan resolution outcome is uncertain."), {
				code: "terminal_uncertain",
			});
		},
		invokeSkill: (name, args) => {
			if (!bindings.has("invokeSkill") || !ctx.invokeSkill)
				return unavailable("skill.invoke", "no skill invocation seam is installed")();

			if (typeof args !== "undefined" && typeof args !== "string")
				throw Object.assign(new Error("skill.invoke args must be a string."), { code: "invalid_input" });
			return ctx.invokeSkill(name, args);
		},
		setPlanMode: on => {
			if (!bindings.has("setPlanMode") || !ctx.setPlanMode)
				return unavailable("mode.plan.set", "no plan-mode seam is installed")();

			if (typeof on !== "boolean")
				throw Object.assign(new Error("mode.plan.set requires a boolean on value."), { code: "invalid_input" });

			return { state: ctx.setPlanMode(on) };
		},
		operateGoal: (op, objective) => {
			if (!bindings.has("operateGoal") || !ctx.operateGoal)
				return unavailable("mode.goal.operate", "no goal-mode seam is installed")();
			if (!["create", "get", "resume", "pause", "complete", "drop"].includes(op))
				throw Object.assign(new Error("mode.goal.operate requires a supported op."), { code: "invalid_input" });
			if (objective !== undefined && typeof objective !== "string")
				throw Object.assign(new Error("mode.goal.operate objective must be a string."), { code: "invalid_input" });
			return ctx.operateGoal(op as "create" | "get" | "resume" | "pause" | "complete" | "drop", objective);
		},
		replaceTodo: items => typed("todo.replace", { items }),
		setModel: async (id, requestedThinkingLevel) => {
			const model = resolveModel(id);
			if (requestedThinkingLevel === undefined) return { changed: await api.setModel(model) };
			const thinkingLevel =
				typeof requestedThinkingLevel === "string" ? parseThinkingLevel(requestedThinkingLevel) : undefined;
			if (!thinkingLevel || thinkingLevel === ThinkingLevel.Inherit)
				throw Object.assign(
					new Error("model.set thinkingLevel must be off, minimal, low, medium, high, xhigh, or max."),
					{ code: "invalid_input" },
				);
			return typed("model.set", { id: `${model.provider}/${model.id}`, thinkingLevel });
		},
		cycleModel: async () => {
			if (!bindings.has("cycleModel"))
				return unavailable("model.cycle", "no session model-cycle seam is installed")();
			return { changed: (await ctx.cycleModel()) !== undefined };
		},
		setThinking: level => {
			api.setThinkingLevel(level as ThinkingLevel);
			return { changed: true };
		},
		cycleThinking: () => {
			if (!bindings.has("cycleThinkingLevel"))
				return unavailable("thinking.cycle", "no session thinking-cycle seam is installed")();
			return { level: ctx.cycleThinkingLevel() };
		},
		setPermissionMode: mode => typed("permission_mode.set", { mode }),
		setQueueMode: (kind, mode) => {
			if (!bindings.has("setQueueMode"))
				return unavailable(`queue.${kind}_mode.set`, "no session queue-mode seam is installed")();
			if (!ctx.setQueueMode(kind as "steering" | "follow_up" | "interrupt", mode))
				throw Object.assign(new Error("Invalid queue mode."), { code: "invalid_input" });
			return { changed: true };
		},
		runCompaction: async () => {
			try {
				await ctx.compact();
				return { started: true };
			} catch (error) {
				throw Object.assign(
					new Error(error instanceof Error ? error.message : "Compaction is unavailable for the current state."),
					{ code: "invalid_request" },
				);
			}
		},
		setAutoCompaction: on => typed("compaction.auto.set", { on }),
		setAutoRetry: on => typed("retry.auto.set", { on }),
		abortRetry: () => typed("retry.abort"),
		executeBash: cmd => typed("bash.execute", { cmd }),
		abortBash: () => typed("bash.abort"),
		newSession: () => typed("session.new"),
		forkSession: () => typed("session.fork"),
		resumeSession: id => typed("session.resume", { id }),
		closeSession: () => typed("session.close"),
		switchSession: id => typed("session.switch", { id }),
		branchSession: entryId => typed("session.branch", { entryId }),
		renameSession: name => typed("session.rename", { name }),
		handoffSession: target => typed("session.handoff", { target }),
		exportHtml: () => typed("session.export_html"),
		patchConfig: patch => {
			if (!patch || typeof patch !== "object" || Array.isArray(patch))
				throw Object.assign(new Error("config.patch requires an object."), { code: "invalid_input" });
			if (containsSecretConfigKey(patch))
				throw Object.assign(new Error("config.patch rejects secret fields at the SDK host."), {
					code: "invalid_input",
				});
			if (!settings) return unavailable("config.patch", "configuration settings are unavailable for this session")();
			const entries = Object.entries(patch as Record<string, unknown>);
			for (const [key, value] of entries) settings.set(key as never, value as never);
			for (const [key, value] of entries) configOverrides.set(key, value);
			configRevision.current += 1;
			return { patched: entries.map(([key]) => key), revision: String(configRevision.current) };
		},

		reloadRuntime: components => typed("runtime.reload", { components }),
		login: unavailablePerSession("auth.login"),
		registerHostTools: unavailablePerSession("host_tools.register"),
		registerHostUri: unavailablePerSession("host_uri.register"),
		setServiceTier: tier => typed("service_tier.set", { tier }),
		setActiveTools: async names => {
			await api.setActiveTools(
				Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [],
			);
			return { changed: true };
		},
		removeQueueMessage: id => typed("queue.message.remove", { id }),
		moveQueueMessage: (id, position) => typed("queue.message.move", { id, ...position }),
		updateQueueMessage: (id, patch) => typed("queue.message.update", { id, patch }),
		setExtensionEnabled: (id, on) => typed("extension.set_enabled", { id, on }),
		clearContext: async confirm => {
			if (!confirm)
				throw Object.assign(new Error("context.clear requires confirmation."), { code: "confirmation_required" });
			return { cleared: await ctx.clearContext() };
		},
		deleteSession: (id, confirm) => {
			if (!confirm)
				throw Object.assign(new Error("session.delete requires confirmation."), { code: "confirmation_required" });
			return typed("session.delete", { id });
		},
		moveCwd: path => typed("session.cwd.move", { path }),
		retryLast: () => typed("retry.last"),
		retryNow: () => typed("retry.now"),
		backgroundBash: () => typed("bash.background"),
		installedOperations: installedOperations(ctx, "control"),
		revisionProvider: resource => (resource === "config" ? String(configRevision.current) : undefined),
	};
	return surface;
}

/** Parse only v3 frames carried through the existing control-command seam. */
function sdkInboundFrame(commandJson: string | undefined): Record<string, unknown> | undefined {
	if (!commandJson) return undefined;
	try {
		const frame = JSON.parse(commandJson) as unknown;
		if (!frame || typeof frame !== "object") return undefined;
		const type = (frame as Record<string, unknown>).type;
		return type === "control_request" ||
			type === "query_request" ||
			type === "event_replay" ||
			type === "register_provider" ||
			type === "provider_heartbeat" ||
			type === "lease_release" ||
			type === "reverse_response"
			? (frame as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

export function createNotificationsExtension(
	api: ExtensionAPI,
	options: {
		settings?: Settings;
		ensureTelegramDaemon?: (input: {
			settings: Settings;
			cwd: string;
			sessionId: string;
		}) => Promise<EnsureDaemonResult>;
		/** Suppress auto-delivery for a GJC-spawned child under `sessionScope=primary`. */
		spawnedByGjc?: boolean;
		controller?: NotificationSessionController;

		onSdkRequest?: (kind: "control" | "query", connectionId: string, frame: Record<string, unknown>) => void;
	} = {},
): void {
	const lifecycleStartupCapability = lifecycleStartupCapabilityForApi(api);
	const runtimes = new Map<string, SessionRuntime>();
	const controller =
		options.controller ??
		new NotificationSessionController({
			eligible: true,
			getConfig: () => resolveSettings(options.settings).cfg,
		});

	// Failed terminal teardown remains fenced from normal runtime lookup while the
	// exact runtime object retains authority for an explicit idempotent retry.
	const cleanupRetries = new Map<string, SessionRuntime>();
	const sessionStartPromises = new Map<string, Promise<SessionStartResult>>();
	let activeRuntimeId: string | undefined;
	let identityControlInFlight = false;
	let deferredIdentityRotation: { event: { previousSessionFile?: string }; ctx: ExtensionContext } | undefined;

	async function ensureTelegramOwner(
		settings: Settings,
		cwd: string,
		id: string,
	): Promise<"ready" | "blocked_identity"> {
		if (options.ensureTelegramDaemon) {
			return (await options.ensureTelegramDaemon({ settings, cwd, sessionId: id })) === "blocked"
				? "blocked_identity"
				: "ready";
		}
		return (await ensureTelegramDaemonRunningDetailed({ settings, cwd, sessionId: id })) === "blocked_identity"
			? "blocked_identity"
			: "ready";
	}
	async function ensureConfiguredDaemons(
		settings: Settings,
		cfg: NotificationConfig,
		cwd: string,
		id: string,
	): Promise<boolean> {
		if (isTelegramConfigured(cfg)) {
			if ((await ensureTelegramOwner(settings, cwd, id)) === "blocked_identity") return false;
		}
		if (isDiscordConfigured(cfg)) await ensureDiscordDaemon(settings);
		if (isSlackConfigured(cfg)) await ensureSlackDaemon(settings);
		return true;
	}
	const identityControlOperations = new Set([
		"session.new",
		"session.fork",
		"session.resume",
		"session.switch",
		"session.branch",
	]);
	const sessionId = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();
	const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

	async function stopSession(
		id: string,
		reason: "session" | "notifications" = "session",
		expectedRuntime?: SessionRuntime,
	): Promise<boolean> {
		const retryRuntime = cleanupRetries.get(id);
		const activeRuntime = runtimes.get(id);
		const requestedRuntime = retryRuntime ?? activeRuntime;
		if (expectedRuntime && requestedRuntime !== expectedRuntime) return false;
		if (reason === "session" && requestedRuntime) requestedRuntime.stopping = true;
		if (reason === "session" && requestedRuntime) {
			// Fence the exact runtime before awaiting its startup promise: a late start
			// must observe removal and clean itself up rather than becoming reachable.
			if (runtimes.get(id) === requestedRuntime) runtimes.delete(id);
			if (activeRuntimeId === id) activeRuntimeId = undefined;
		}
		const pendingStart = sessionStartPromises.get(id);
		if (pendingStart)
			void pendingStart
				.catch(() => {})
				.then(() => {
					if (runtimes.get(id) === requestedRuntime || cleanupRetries.get(id) === requestedRuntime)
						void stopSession(id, reason, requestedRuntime);
				});
		const rt = requestedRuntime;

		if (expectedRuntime && rt !== expectedRuntime) return false;

		if (!rt) {
			if (activeRuntimeId === id) activeRuntimeId = undefined;
			return false;
		}
		if (reason === "notifications" && rt.host.started) {
			rt.notificationsActive = false;
			try {
				rt.disposeAnswerSource();
			} catch {}
			try {
				rt.disposeFileSink();
			} catch {}
			rt.gatePresentations?.cancelInteractive();
			for (const pending of rt.pendingInteractive.values()) pending.resolve(undefined);
			rt.pendingInteractive.clear();
			return true;
		}
		// Keep this exact object authoritative for the full terminal release, including
		// the interval before a failed owner can be recorded for a later retry.
		cleanupRetries.set(id, rt);

		try {
			rt.cancelPostmortemCleanup();
		} catch {}
		try {
			rt.stopBrokerHeartbeat();
		} catch {}
		try {
			rt.disposeAnswerSource();
		} catch {}
		try {
			rt.disposeFileSink();
		} catch {}
		try {
			rt.disposeGateListener();
		} catch {}
		await rt.waitForGateResolutionQuiescence();
		try {
			rt.disposeAckRecoveryParticipant();
		} catch {}
		try {
			rt.disposeGateEmitterListener();
		} catch {}
		rt.gatePresentations?.dispose();
		try {
			rt.disposeGateTerminalController();
		} catch {}
		let hostStopped = rt.hostStopped;
		let brokerRegistrationReleased = rt.brokerRegistrationReleased;
		const ownerReleaseFailures: unknown[] = [];

		if (!hostStopped) {
			try {
				const stopped = await rt.host.stop();
				hostStopped = stopped === "stopped";
				brokerRegistrationReleased = !rt.brokerRegistrationActive || hostStopped;
				if (rt.brokerRegistrationActive && hostStopped) rt.brokerRegistrationActive = false;
				if (hostStopped) {
					rt.hostStopped = true;
					rt.brokerRegistrationReleased = brokerRegistrationReleased;
				}
			} catch (e) {
				ownerReleaseFailures.push(e);
				logger.warn(`sdk host: stop failed: ${String(e)}`);
			}
		}
		rt.host.reverse.dispose();
		// Resolve any still-pending interactive asks so the ask tool is not left hanging.
		for (const pending of rt.pendingInteractive.values()) pending.resolve(undefined);
		rt.pendingInteractive.clear();
		try {
			rt.cursors.close();
			await rt.revisions.close();
		} catch (e) {
			ownerReleaseFailures.push(e);
			logger.warn(`sdk query snapshots: close failed: ${String(e)}`);
		}
		let closeFrameSent = false;
		try {
			pushSessionFrame(rt, { type: "session_closed", sessionId: id });
			closeFrameSent = true;
		} catch (e) {
			logger.warn(`notifications: session_closed failed: ${String(e)}`);
		}
		if (closeFrameSent) await sleep(100);
		let serverStopped = rt.serverStopped;
		if (!serverStopped) {
			try {
				await rt.server.stopAndWait();
				serverStopped = true;
				rt.serverStopped = true;
			} catch (e) {
				ownerReleaseFailures.push(e);
				logger.warn(`notifications: stop failed: ${String(e)}`);
			}
		}
		lifecycleStartupCapability?.rollback?.recordStop(rt.host.generation, {
			runtimeRemoved: true,
			hostStopped: rt.hostStopped && rt.serverStopped,
			brokerRegistrationReleased: rt.brokerRegistrationReleased,
		});
		if (ownerReleaseFailures.length > 0) {
			cleanupRetries.set(id, rt);
			throw new AggregateError(ownerReleaseFailures, `SDK notification runtime ${id} owner release failed.`);
		}
		if (cleanupRetries.get(id) === rt) cleanupRetries.delete(id);
		return true;
	}

	function isNotificationEligibleContext(ctx: ExtensionContext): boolean {
		return ctx.sessionMetadata?.kind !== "sub";
	}

	async function startSession(ctx: ExtensionContext): Promise<SessionStartResult> {
		const id = sessionId(ctx);
		const lifecycleRequestId = safeLifecycleRequestId(process.env.GJC_LIFECYCLE_REQUEST_ID);
		const { settings, cfg, settingsAvailable } = resolveSettings(options.settings);
		const notificationsEnabledForSession = controller.query(ctx).effectiveEnabled;
		const sdkEnabledForSession = shouldHostSdk(settings, isNotificationEligibleContext(ctx));
		const lifecycleRequired = lifecycleStartupCapability !== undefined;
		const failLifecycleStartup = (
			reason: "disabled" | "ineligible" | "failed",
			error?: unknown,
		): SessionStartResult => {
			const failure =
				lifecycleStartupCapability?.normalizeFailure("startup", reason, error) ??
				normalizeSdkStartupFailure("startup", reason, error);

			lifecycleStartupCapability?.settleFailure(failure);
			return { status: reason === "disabled" ? "disabled" : "failed", failure };
		};
		const throwIfLifecycleStopped = (): void => {
			if (lifecycleStartupCapability?.cancelled || runtime?.stopping || runtimes.get(id) !== runtime)
				throw new Error("Lifecycle SDK startup was cancelled.");
		};

		if (
			!lifecycleRequired &&
			(!isNotificationEligibleContext(ctx) || (!notificationsEnabledForSession && !sdkEnabledForSession))
		)
			return { status: "disabled" };
		if (lifecycleRequired && !isNotificationEligibleContext(ctx)) return failLifecycleStartup("ineligible");
		const pendingStart = sessionStartPromises.get(id);
		if (pendingStart) return pendingStart;
		const retainedCleanup = cleanupRetries.get(id);
		if (retainedCleanup) return failLifecycleStartup("failed", "SDK notification runtime cleanup is still pending.");
		const existingRuntime = runtimes.get(id);
		if (existingRuntime) {
			activeRuntimeId = id;
			if (lifecycleRequired) {
				if (existingRuntime.host.started) lifecycleStartupCapability?.settleStarted();
				else return failLifecycleStartup("failed", "SDK host is not started.");
			}
			return { status: "already", runtime: existingRuntime };
		}

		const stateRoot = path.join(ctx.cwd, ".gjc", "state");
		const lifecycleAgentDir = lifecycleRequired ? settings?.getAgentDir?.() : undefined;
		if (lifecycleRequired && !lifecycleAgentDir)
			return failLifecycleStartup("failed", "Lifecycle SDK startup requires an agent directory.");

		const gateOptions = new Map<string, string[]>();
		const pendingInteractive = new Map<string, PendingInteractiveAsk>();
		const pendingPromptCorrelations: Array<{ commandId: string; turnId: string }> = [];
		const tag = sessionTag(id);
		const redact = cfg.redact;
		const verbosity = cfg.verbosity;
		let runtime: SessionRuntime | undefined;

		// The SDK can always answer now (interactive via the answer source, or the
		// workflow gate), so the endpoint advertises a resolver. Validate the native
		// build information and required capability while lifecycle startup can settle
		// a structured failure instead of leaving the lifecycle caller pending.
		const token = resolveToken();
		let server: NotificationServer;
		try {
			assertNativeRuntimeCompatibility({
				runtimeVersion: VERSION,
				nativeVersion: nativeBuildInfo().version,
				notificationServer: NotificationServer.prototype,
			});
			server = new NotificationServer(id, token, stateRoot, true);
		} catch (error) {
			if (lifecycleRequired) return failLifecycleStartup("failed", error);
			throw error;
		}
		const gatePresentations = new PresentationArbiter(server, () => runtime?.redact ?? redact, tag);
		let inboundSdkFrame: ((connectionId: string, frame: Record<string, unknown>) => void) | undefined;
		let stopBrokerHeartbeat = () => {};
		const inFlightGateResolutions = new Set<Promise<void>>();
		const trackGateResolution = <T>(resolution: Promise<T>): Promise<T> => {
			const quiesced = resolution.then(
				() => {},
				() => {},
			);
			inFlightGateResolutions.add(quiesced);
			void quiesced.finally(() => inFlightGateResolutions.delete(quiesced));
			return resolution;
		};

		const revisions = new RevisionStore(id, Date.now, { storageDir: stateRoot });
		let host: SessionSdkHost | undefined;
		const installProviderDefinitions = (capability: string, definitions: unknown) => {
			validateProviderDefinitions(capability, definitions);
			if (capability !== "permission") return;
			ctx.setSdkPermissionProvider?.(async (toolCall, permissionOptions, signal) => {
				const result = await host!.reverse.request("permission", "request", {
					toolCall,
					options: permissionOptions,
					aborted: signal?.aborted === true,
				});
				if (!result || typeof result !== "object")
					throw new Error("permission provider returned an invalid response");
				const response = result as { outcome?: unknown; optionId?: unknown; kind?: unknown };
				if (response.outcome === "cancelled") return { outcome: "cancelled" };
				if (response.outcome === "selected" && typeof response.optionId === "string")
					return {
						outcome: "selected",
						optionId: response.optionId,
						...(typeof response.kind === "string"
							? { kind: response.kind as "allow_once" | "allow_always" | "reject_once" | "reject_always" }
							: {}),
					};
				throw new Error("permission provider returned an invalid response");
			});
		};
		const removeProviderDefinitions = (capability: string) => {
			if (capability === "permission") ctx.setSdkPermissionProvider?.(undefined);
		};

		const configOverrides = new Map<string, unknown>();
		const configRevision = { current: 0 };
		const PROMPT_SUBMISSION_CAPACITY = 128;
		const PROMPT_SUBMISSION_TTL_MS = 5 * 60_000;
		const PROMPT_TERMINAL_TOMBSTONE_CAPACITY = 256;
		const PROMPT_TERMINAL_TOMBSTONE_TTL_MS = 15 * 60_000;
		const promptSubmissionKey = (correlation: { commandId: string; turnId: string }) =>
			`${correlation.commandId}:${correlation.turnId}`;
		type PromptLifecycleFrame =
			| { type: "agent_start" | "agent_end"; sessionId: string; commandId?: string; turnId?: string }
			| {
					type: "agent_failed";
					sessionId: string;
					commandId: string;
					turnId: string;
					error: { code: string; message: string };
			  };
		type PromptSubmission = {
			acknowledged: boolean;
			connectionId: string;
			abandoned: boolean;
			failed: boolean;
			error: unknown;
			terminal: boolean;
			createdAt: number;
			bufferedLifecycle: PromptLifecycleFrame[];
		};
		const promptSubmissions = new Map<string, PromptSubmission>();
		const promptTerminalTombstones = new Map<string, number>();
		const removePendingPromptCorrelation = (correlation: { commandId: string; turnId: string }) => {
			const pendingIndex = pendingPromptCorrelations.findIndex(
				candidate => candidate.commandId === correlation.commandId && candidate.turnId === correlation.turnId,
			);
			if (pendingIndex !== -1) pendingPromptCorrelations.splice(pendingIndex, 1);
		};
		const addTerminalTombstone = (key: string, now = Date.now()) => {
			promptTerminalTombstones.delete(key);
			promptTerminalTombstones.set(key, now + PROMPT_TERMINAL_TOMBSTONE_TTL_MS);
			while (promptTerminalTombstones.size > PROMPT_TERMINAL_TOMBSTONE_CAPACITY)
				promptTerminalTombstones.delete(promptTerminalTombstones.keys().next().value!);
		};
		const finalizePrompt = (key: string, correlation: { commandId: string; turnId: string }) => {
			promptSubmissions.delete(key);
			removePendingPromptCorrelation(correlation);
			addTerminalTombstone(key);
		};
		const cleanupPromptRecords = (now = Date.now()) => {
			for (const [key, expiresAt] of promptTerminalTombstones)
				if (expiresAt <= now) promptTerminalTombstones.delete(key);
			for (const [key, submission] of promptSubmissions)
				if (submission.createdAt + PROMPT_SUBMISSION_TTL_MS <= now) {
					const [commandId, turnId] = key.split(":", 2);
					if (commandId && turnId) finalizePrompt(key, { commandId, turnId });
				}
		};
		const abandonPrompt = (submission: PromptSubmission) => {
			submission.abandoned = true;
			submission.bufferedLifecycle.length = 0;
		};
		const emitPromptLifecycle = (
			correlation: { commandId: string; turnId: string } | undefined,
			frame: PromptLifecycleFrame,
		) => {
			cleanupPromptRecords();
			if (!correlation || !runtime) {
				emitAgentLifecycle(runtime!, frame as Extract<PromptLifecycleFrame, { type: "agent_start" | "agent_end" }>);
				return;
			}
			const key = promptSubmissionKey(correlation);
			const submission = promptSubmissions.get(key);
			if (!submission) return;
			runtime.host.emitEvent({ kind: frame.type, payload: frame });
			if (submission.abandoned) {
				if (submission.terminal) finalizePrompt(key, correlation);
				return;
			}
			if (!submission.acknowledged) {
				submission.bufferedLifecycle.push(frame);
				return;
			}
			try {
				runtime.server.sendTo(submission.connectionId, JSON.stringify(frame));
			} catch (error) {
				logger.warn(`sdk: correlated lifecycle delivery failed: ${String(error)}`);
				abandonPrompt(submission);
			}
			if (submission.terminal) finalizePrompt(key, correlation);
		};
		const flushPromptLifecycle = (key: string, submission: PromptSubmission) => {
			for (const frame of submission.bufferedLifecycle.splice(0)) {
				try {
					server.sendTo(submission.connectionId, JSON.stringify(frame));
				} catch (error) {
					logger.warn(`sdk: buffered correlated lifecycle delivery failed: ${String(error)}`);
					abandonPrompt(submission);
					break;
				}
			}
			if (submission.terminal) {
				const [commandId, turnId] = key.split(":", 2);
				if (commandId && turnId) finalizePrompt(key, { commandId, turnId });
			}
		};
		const recordPromptAccepted = (
			correlation: { commandId: string; turnId: string },
			requesterConnectionId?: string,
		) => {
			if (!requesterConnectionId) return;
			cleanupPromptRecords();
			while (promptSubmissions.size >= PROMPT_SUBMISSION_CAPACITY) {
				const oldest = promptSubmissions.entries().next().value as [string, PromptSubmission] | undefined;
				if (!oldest) break;
				const [key] = oldest;
				const [commandId, turnId] = key.split(":", 2);
				if (commandId && turnId) finalizePrompt(key, { commandId, turnId });
			}
			pendingPromptCorrelations.push(correlation);
			promptSubmissions.set(promptSubmissionKey(correlation), {
				acknowledged: false,
				connectionId: requesterConnectionId,
				abandoned: false,
				failed: false,
				error: undefined,
				terminal: false,
				createdAt: Date.now(),
				bufferedLifecycle: [],
			});
		};
		const recordPromptTerminal = (correlation: { commandId: string; turnId: string } | undefined) => {
			if (!correlation) return false;
			cleanupPromptRecords();
			const key = promptSubmissionKey(correlation);
			if (promptTerminalTombstones.has(key)) return false;
			const submission = promptSubmissions.get(key);
			if (!submission || submission.terminal) return false;
			submission.terminal = true;
			return true;
		};
		const emitPromptFailure = (correlation: { commandId: string; turnId: string }, error: unknown) => {
			const submission = promptSubmissions.get(promptSubmissionKey(correlation));
			if (!submission || !runtime || !recordPromptTerminal(correlation)) return;
			const candidate = error as { code?: unknown; message?: unknown };
			emitPromptLifecycle(correlation, {
				type: "agent_failed",
				sessionId: runtime.id,
				...correlation,
				error: {
					code: typeof candidate.code === "string" ? candidate.code : "internal",
					message: typeof candidate.message === "string" ? candidate.message : "Prompt submission failed.",
				},
			});
		};
		const recordPromptFailure = (correlation: { commandId: string; turnId: string }, error: unknown) => {
			const submission = promptSubmissions.get(promptSubmissionKey(correlation));
			if (!submission) return;
			submission.failed = true;
			submission.error = error;
			removePendingPromptCorrelation(correlation);
			emitPromptFailure(correlation, error);
		};
		const acknowledgePrompt = (connectionId: string, correlation: { commandId: string; turnId: string }) => {
			const key = promptSubmissionKey(correlation);
			const submission = promptSubmissions.get(key);
			if (!submission || submission.abandoned || submission.connectionId !== connectionId) return;
			submission.acknowledged = true;
			flushPromptLifecycle(key, submission);
		};

		const cursors = new CursorRegistry(token, revisions);
		const queryHandlers = new QueryHandlers(
			sdkQuerySurface(
				ctx,
				id,
				api,
				capability => host?.reverse.getInstalledDefinitions(capability),
				() => {
					// Live session truth: the agent loop drives rt.busy on
					// agent_start/agent_end regardless of whether notifications are
					// active, and ctx.isIdle() is the session's own idle signal.
					const counts = ctx.getPendingMessageCounts();
					return {
						isStreaming: runtime?.busy === true || !ctx.isIdle(),
						steeringQueueDepth: counts.steering,
						followupQueueDepth: counts.followUp,
					};
				},
				configOverrides,
			),
			id,
			revisions,
			cursors,
		);
		const controlSurface = sdkControlSurface(
			ctx,
			pendingInteractive,
			gatePresentations,
			api,
			() => runtime?.busy === true || pendingPromptCorrelations.length > 0,
			recordPromptAccepted,
			recordPromptFailure,
			() => runtime?.stopping !== true,
			trackGateResolution,
			settings,
			configOverrides,
			configRevision,
		);
		const abandonPromptResponse = (connectionId: string, frame: Record<string, unknown>) => {
			if (
				frame.type !== "control_response" ||
				frame.ok !== true ||
				!frame.result ||
				typeof frame.result !== "object"
			)
				return;
			const result = frame.result as { accepted?: unknown; commandId?: unknown; turnId?: unknown };
			if (result.accepted !== true || typeof result.commandId !== "string" || typeof result.turnId !== "string")
				return;
			const submission = promptSubmissions.get(
				promptSubmissionKey({ commandId: result.commandId, turnId: result.turnId }),
			);
			if (!submission || submission.acknowledged || submission.connectionId !== connectionId) return;
			abandonPrompt(submission);
		};

		const sendSdkFrame = (connectionId: string, frame: Record<string, unknown>) => {
			const json = JSON.stringify(frame);
			if (connectionId.startsWith("seam:")) {
				try {
					pushSessionFrame(runtime!, {
						type: "control_command_result",
						sessionId: runtime!.id,
						requestId: connectionId.slice("seam:".length),
						status: "ok",
						message: json,
					});
				} catch (error) {
					logger.warn(`sdk: seam response delivery failed for ${connectionId}: ${String(error)}`);
					abandonPromptResponse(connectionId, frame);
					throw error;
				}
				return;
			}
			try {
				server.sendTo(connectionId, json);
			} catch (error) {
				logger.warn(`sdk: directed response delivery failed for ${connectionId}: ${String(error)}`);
				abandonPromptResponse(connectionId, frame);
				throw error;
			}
		};

		host = new SessionSdkHost({
			sessionId: id,
			stateRoot,
			token,
			sendFrame: (connectionId, frame) => sendSdkFrame(connectionId, frame),
			installProviderDefinitions,
			onProviderDefinitionsRemoved: removeProviderDefinitions,
			onFrame: handler => {
				inboundSdkFrame = handler;
				return () => {
					inboundSdkFrame = undefined;
				};
			},
			onRequest: options.onSdkRequest,
			afterControlResponse: async (connectionId, request, response) => {
				if (
					(request.operation === "turn.prompt" ||
						request.operation === "turn.follow_up" ||
						request.operation === "turn.abort_and_prompt") &&
					response.ok === true &&
					response.result &&
					typeof response.result === "object" &&
					!Array.isArray(response.result)
				) {
					const result = response.result as { accepted?: unknown; commandId?: unknown; turnId?: unknown };
					if (
						result.accepted === true &&
						typeof result.commandId === "string" &&
						typeof result.turnId === "string"
					)
						acknowledgePrompt(connectionId, { commandId: result.commandId, turnId: result.turnId });
				}

				if (request.operation === "session.close" && response.ok === true) ctx.shutdown();
				if (typeof request.operation === "string" && identityControlOperations.has(request.operation)) {
					const pending = deferredIdentityRotation;
					deferredIdentityRotation = undefined;
					identityControlInFlight = false;
					if (response.ok === true && pending) await rotateSessionAuthority(pending.event, pending.ctx);
				}
			},
			control: async (connectionId, frame) => {
				const request = frame as {
					id?: unknown;
					operation?: unknown;
					input?: unknown;
					expectedRevision?: unknown;
					idempotencyKey?: unknown;
					confirm?: unknown;
				};
				const requestId = typeof request.id === "string" ? request.id : "";
				const operation = typeof request.operation === "string" ? request.operation : "";
				const rotatesIdentity = identityControlOperations.has(operation);
				if (rotatesIdentity && identityControlInFlight)
					return {
						id: requestId,
						ok: false,
						error: { code: "conflict", message: "session identity mutation is already active" },
					};
				if (rotatesIdentity) identityControlInFlight = true;
				const response = await controlRequesterContext.run(connectionId, () =>
					dispatchControl(
						controlSurface,
						OPERATIONS.find(row => row.kind === "control" && row.sdkId === operation),
						{
							id: requestId,
							operation,
							input: request.input,
							expectedRevision:
								typeof request.expectedRevision === "string" ? request.expectedRevision : undefined,
							idempotencyKey: typeof request.idempotencyKey === "string" ? request.idempotencyKey : undefined,
							confirm: request.confirm === true,
						},
					),
				);
				if (rotatesIdentity && response.ok !== true) {
					identityControlInFlight = false;
					deferredIdentityRotation = undefined;
				}
				return response;
			},
			query: async (connectionId, frame) => {
				const request = frame as { id?: unknown; query?: unknown; input?: unknown; cursor?: unknown };
				const response = await queryHandlers.dispatch({
					id: typeof request.id === "string" ? request.id : undefined,
					query: typeof request.query === "string" ? request.query : "",
					input:
						request.input && typeof request.input === "object" && !Array.isArray(request.input)
							? (request.input as Record<string, unknown>)
							: undefined,
					cursor: typeof request.cursor === "string" ? request.cursor : undefined,
					connectionId,
				});
				return { type: "query_response", ...response };
			},
		});

		// Install the runtime before either transport can expose the host. session_start
		// is deliberately fire-and-forget, so agent lifecycle events and direct v3
		// seam replies can otherwise arrive between server.start() and the old
		// registration below. Keeping this state live first makes those frames
		// replayable rather than dropping them (or dereferencing an absent runtime).
		runtime = {
			server,
			host,
			revisions,
			cursors,
			id,
			idleSeq: 0,
			pendingInteractive,
			brokerRegistrationActive: false,
			hostStopped: false,
			serverStopped: false,
			brokerRegistrationReleased: false,
			disposeAnswerSource: () => {},
			disposeFileSink: () => {},
			disposeGateListener: () => {},
			notificationsActive: false,
			enableNotifications: () => {},
			disposeGateTerminalController: () => {},
			disposeAckRecoveryParticipant: () => {},
			disposeGateEmitterListener: () => {},
			waitForGateResolutionQuiescence: async () => {
				await Promise.allSettled(inFlightGateResolutions);
			},
			workflowGate: undefined,
			gatePresentations,
			stopping: false,
			cancelPostmortemCleanup: () => {},
			stopBrokerHeartbeat,

			redact,
			verbosity,
			stream: streamingEnabled(),
			sessionTag: tag,
			busy: false,
			pendingPromptCorrelations,
			activePromptCorrelation: undefined,
			recordPromptTerminal,
			emitPromptLifecycle,
			pendingInbound: new Set<number>(),
		};
		runtimes.set(id, runtime);
		activeRuntimeId = id;
		const startSettled = Promise.withResolvers<SessionStartResult>();
		sessionStartPromises.set(id, startSettled.promise);
		const finishStartup = (result: SessionStartResult): void => {
			if (lifecycleRequired) {
				if (result.status === "started") lifecycleStartupCapability?.settleStarted();
				else
					lifecycleStartupCapability?.settleFailure(
						result.failure ??
							lifecycleStartupCapability?.normalizeFailure(
								"startup",
								result.status === "disabled" ? "disabled" : "failed",
							) ??
							normalizeSdkStartupFailure("startup", result.status === "disabled" ? "disabled" : "failed"),
					);
			}
			if (sessionStartPromises.get(id) === startSettled.promise) sessionStartPromises.delete(id);
			startSettled.resolve(result);
		};
		const cleanupAbandonedStartup = async (): Promise<void> => {
			try {
				await server.stopAndWait();
			} catch {}
			try {
				await host.stop();
				host.reverse.dispose();
			} catch {}
			try {
				cursors.close();
				await revisions.close();
			} catch {}
		};

		try {
			server.onSdkFrame((err, inbound) => {
				if (err || !inbound) return;
				try {
					inboundSdkFrame?.(inbound.connectionId, JSON.parse(inbound.json) as Record<string, unknown>);
				} catch {}
			});
			server.onConnectionClose((_err, connectionId) => {
				if (!connectionId) return;
				host.handleDisconnect(connectionId);
				for (const submission of promptSubmissions.values())
					if (submission.connectionId === connectionId) abandonPrompt(submission);
			});

			server.onReply((err, reply) => {
				if (err || !reply) return;
				if (runtime?.stopping || runtimes.get(id) !== runtime) {
					try {
						server.closeClaimInvalid(reply.replyReceiptId, "session_stopping");
					} catch {}
					return;
				}
				const native = server as unknown as {
					resolveClaim(receiptId: string, answerJson?: string, idempotencyKey?: string): void;
					closeClaimInvalid(receiptId: string, reason: string): void;
					requestAskSelectedAck(
						receiptId: string,
						requestJson: string,
					): Promise<{ status: string; messageId?: number; reason?: string }>;
				};
				const pending = pendingInteractive.get(reply.id);
				if (pending) {
					if (pendingInteractive.get(reply.id) === pending) pendingInteractive.delete(reply.id);
					let interaction: AskRemoteInteraction | undefined;
					try {
						const answer = JSON.parse(reply.answerJson) as unknown;
						if (typeof answer === "object" && answer && "controlId" in answer) {
							const controlId = (answer as { controlId?: unknown }).controlId;
							if (
								controlId === "navigation_forward" &&
								pending.controls.some(control => control.id === controlId && control.enabled)
							) {
								interaction = { kind: "control", controlId };
							}
						} else {
							const value = mapAnswerToLabel(reply.answerJson, pending.options);
							if (value !== undefined) interaction = { kind: "value", value };
						}
					} catch {}
					if (!interaction) {
						try {
							native.closeClaimInvalid(reply.replyReceiptId, "invalid_answer");
						} catch {}
						if (!pending.reissue()) pending.resolve(undefined);
						return;
					}
					let settled: Promise<AskSettlementResult> | undefined;
					const receipt: AskRemoteReceipt = {
						source: "remote",
						interaction,
						settle(settlement: AskSettlement): Promise<AskSettlementResult> {
							if (settled) return settled;
							settled = Promise.resolve().then(async () => {
								if (settlement.kind === "invalid") {
									try {
										native.closeClaimInvalid(reply.replyReceiptId, settlement.reason);
									} catch (error) {
										pending.fail(reply.id);
										throw error;
									}
									pending.reissue();
									return { kind: "invalid_closed" };
								}
								try {
									if (settlement.kind === "resolve_without_commit") {
										native.resolveClaim(
											reply.replyReceiptId,
											reply.answerJson,
											reply.idempotencyKey ?? undefined,
										);
										pending.complete(reply.id);
										return { kind: "resolved_without_commit" };
									}
									const ack = await requestLiveSelectedAck(native, {
										replyReceiptId: reply.replyReceiptId,
										actionId: reply.id,
										commitKey: `${reply.id}:${reply.idempotencyKey ?? reply.replyReceiptId}`,
										deadlineAt: Date.now() + 8_000,
									});
									native.resolveClaim(
										reply.replyReceiptId,
										reply.answerJson,
										reply.idempotencyKey ?? undefined,
									);
									pending.complete(reply.id);
									return { kind: "committed", ack };
								} catch (error) {
									try {
										native.closeClaimInvalid(reply.replyReceiptId, "settlement_failed");
									} catch {}
									pending.fail(reply.id);
									throw error;
								}
							});
							return settled;
						},
					};
					pending.resolve(receipt);
					return;
				}
				const gate = runtime?.workflowGate;
				const workflowGateActive =
					gate?.isUnattended?.() === true &&
					typeof gate.onGateEmitted === "function" &&
					typeof gate.resolveGateFromNotification === "function";
				const gateId = gatePresentations.routeFor(reply.id);
				if (gate && workflowGateActive && gateId && gate.resolveGateFromNotification) {
					const presentation = gatePresentations.presentationFor(reply.id);
					const rawAnswer = parseAnswer(reply.answerJson);
					if (presentation?.multi) {
						const option =
							typeof rawAnswer === "number"
								? presentation.options[rawAnswer]
								: typeof rawAnswer === "string" && presentation.options.includes(rawAnswer)
									? rawAnswer
									: undefined;
						if (option !== undefined) {
							native.resolveClaim(reply.replyReceiptId, reply.answerJson, reply.idempotencyKey ?? undefined);
							if (!gatePresentations.toggle(reply.id, option)) gatePresentations.reissue(gateId);
							return;
						}
					}
					let answer: unknown;
					if (
						presentation?.multi &&
						typeof rawAnswer === "object" &&
						rawAnswer !== null &&
						(rawAnswer as { controlId?: unknown }).controlId === "navigation_forward"
					) {
						if (!presentation.allowEmpty && presentation.selectedOptions.length === 0) {
							native.closeClaimInvalid(reply.replyReceiptId, "invalid_control");
							gatePresentations.closeInteraction(reply.id, "invalid_control");
							gatePresentations.reissue(gateId);
							return;
						}
						answer = { selected: presentation.selectedOptions };
					} else if (
						typeof rawAnswer === "object" &&
						rawAnswer !== null &&
						(rawAnswer as { action?: unknown }).action === "clarify"
					) {
						answer = rawAnswer;
					} else if (presentation?.multi && typeof rawAnswer === "string") {
						answer = { selected: presentation.selectedOptions, other: true, custom: rawAnswer };
					} else {
						const mapped = mapAnswerToGate(reply.answerJson, gateOptions.get(gateId) ?? []);
						if (!mapped.ok) {
							// A numeric selector outside options is invalid (issue #2030): close the
							// exact claim/receipt and reissue the interaction — never a success ack.
							native.closeClaimInvalid(reply.replyReceiptId, mapped.reason);
							gatePresentations.closeInteraction(reply.id, mapped.reason);
							gatePresentations.reissue(gateId);
							return;
						}
						answer = mapped.answer;
					}
					const resolution = gate
						.resolveGateFromNotification(
							{ gate_id: gateId, answer, idempotency_key: reply.idempotencyKey ?? undefined },
							{
								interactionActionId: reply.id,
								replyReceiptId: reply.replyReceiptId,
								answerJson: reply.answerJson,
								idempotencyKey: reply.idempotencyKey ?? undefined,
								resolveClaim: () =>
									native.resolveClaim(
										reply.replyReceiptId,
										reply.answerJson,
										reply.idempotencyKey ?? undefined,
									),
								closeClaimInvalid: reason => {
									native.closeClaimInvalid(reply.replyReceiptId, reason);
									gatePresentations.closeInteraction(reply.id, reason);
									gatePresentations.reconcile();
								},
								requestSelectedAck: input =>
									requestLiveSelectedAck(native, {
										replyReceiptId: input.replyReceiptId,
										actionId: input.actionId,
										commitKey: input.commitKey,
										deadlineAt: input.daemonDeadlineAt,
									}),
							},
						)
						.catch(() => {
							let durable: "pending" | "terminal" | "unavailable" = "unavailable";
							try {
								if (gate.listPendingGates)
									durable = gate.listPendingGates().some(candidate => candidate.gate_id === gateId)
										? "pending"
										: "terminal";
							} catch {
								// Durable state is unavailable; remain fail-closed.
							}
							if (durable === "pending") gatePresentations.reconcile();
							else {
								if (durable === "unavailable") {
									try {
										gate.quarantineGate?.(gateId);
									} catch {
										// The presentation remains fail-closed when the durable fence is unavailable.
									}
								}
								gatePresentations.complete(gateId);
							}
							logger.warn("workflow_gate_notification_resolution_failed", { gateId, durable });
						});
					trackGateResolution(resolution);
					return;
				}
				try {
					server.closeClaimInvalid(reply.replyReceiptId, "unknown_action");
				} catch (error) {
					logger.warn(`notifications: closeClaimInvalid failed: ${String(error)}`);
				}
			});

			// Inbound free-text injection / in-thread config command from a session
			// thread (forwarded by the daemon over the WS, fail-closed at the daemon).
			server.onInbound((err, inbound) => {
				if (err || !inbound) return;
				if (inbound.kind === "control_command") {
					const frame = sdkInboundFrame(inbound.commandJson);
					if (frame) {
						inboundSdkFrame?.(`seam:${inbound.requestId ?? "notification"}`, frame);
						return;
					}
				}

				if (inbound.kind === "user_message") {
					// Inject as a user turn (steers/continues the agent; the resulting
					// turn streams back via the turn_end handler even when not idle).
					// Record the update id so it can be acked as "consumed" on the next
					// turn_start, and steer (vs start a fresh turn) when already busy.
					const text = inbound.text ?? "";
					const images = inbound.images ?? [];
					if (!text && images.length === 0) return;
					if (runtime && typeof inbound.updateId === "number") runtime.pendingInbound.add(inbound.updateId);
					const content: string | (TextContent | ImageContent)[] =
						images.length > 0
							? [
									...(text ? [{ type: "text", text } as TextContent] : []),
									...images.map(
										img =>
											({
												type: "image",
												data: img.data,
												mimeType: img.mime ?? "image/jpeg",
											}) as ImageContent,
									),
								]
							: text;
					try {
						api.sendUserMessage(content, runtime?.busy ? { deliverAs: "steer" } : undefined);
					} catch (e) {
						logger.warn(`notifications: sendUserMessage failed: ${String(e)}`);
					}
					return;
				}
				if (inbound.kind === "config_command") {
					if (!runtime) return;
					const update: {
						type: "config_update";
						sessionId: string;
						verbosity?: "lean" | "verbose";
						redact?: boolean;
					} = {
						type: "config_update",
						sessionId: runtime.id,
					};
					if (inbound.verbosity === "lean" || inbound.verbosity === "verbose") {
						runtime.verbosity = inbound.verbosity;
						update.verbosity = inbound.verbosity;
					}
					if (typeof inbound.redact === "boolean") {
						runtime.redact = inbound.redact;
						update.redact = inbound.redact;
					}
					if (update.verbosity !== undefined || update.redact !== undefined) {
						try {
							pushSessionFrame(runtime, update);
						} catch (error) {
							logger.warn(`notifications: config_update failed: ${String(error)}`);
						}
					}
				}
				if (inbound.kind === "control_command") {
					if (!runtime || !inbound.requestId) return;
					const activeRuntime = runtime;
					if (inbound.sessionId !== activeRuntime.id) {
						pushSessionFrame(activeRuntime, {
							type: "control_command_result",
							sessionId: activeRuntime.id,
							requestId: inbound.requestId,
							updateId: inbound.updateId,
							status: "error",
							message: STALE_MODEL_BUTTON_MESSAGE,
						});
						return;
					}
					void executeNotificationControlCommand(
						parseControlCommandPayload(inbound.commandJson),
						ctx,
						api,
						inbound.sessionId,
					).then(result => {
						if (runtime !== activeRuntime) return;
						pushSessionFrame(activeRuntime, {
							type: "control_command_result",
							sessionId: activeRuntime.id,
							requestId: inbound.requestId,
							updateId: inbound.updateId,
							status: result.status,
							message: result.message,
							modelChoices: result.modelChoices,
						});
					});
				}
			});

			await host.start();
			lifecycleStartupCapability?.rollback?.recordGeneration(host.generation);
			throwIfLifecycleStopped();
			if (runtimes.get(id) !== runtime) {
				finishStartup({ status: "failed" });
				await cleanupAbandonedStartup();
				return { status: "failed" };
			}
			if (notificationsEnabledForSession && settingsAvailable && settings) {
				try {
					if (!(await ensureConfiguredDaemons(settings, cfg, ctx.cwd, id))) {
						const result = failLifecycleStartup("failed", "Telegram daemon ownership is blocked.");
						finishStartup(result);
						await cleanupAbandonedStartup();
						return result;
					}
				} catch (error) {
					const result = failLifecycleStartup("failed", error);
					finishStartup(result);
					await cleanupAbandonedStartup();
					return result;
				}
			}

			// Startup contract: identity is committed to the replayable SDK event log
			// immediately after the host starts, before awaiting notification transport
			// startup. Native frames are ephemeral, so ensure configured daemon owners
			// before broadcasting identity; late SDK consumers still recover it from
			// event_replay.
			const identityHeader = {
				type: "identity_header",
				sessionId: id,
				...buildIdentity(ctx.cwd, ctx.sessionManager.getSessionName()),
			};
			host.emitEvent({ kind: identityHeader.type, payload: identityHeader });
			const endpoint = await server.start();
			throwIfLifecycleStopped();
			if (runtimes.get(id) !== runtime) {
				finishStartup({ status: "failed" });
				await cleanupAbandonedStartup();
				return { status: "failed" };
			}

			server.pushFrame(JSON.stringify(identityHeader));
			const agentDir = lifecycleAgentDir ?? settings?.getAgentDir?.();
			if (lifecycleRequired && !agentDir) throw new Error("Lifecycle SDK host requires an agent directory.");

			if (agentDir) {
				try {
					await ensureBroker({ agentDir });
					throwIfLifecycleStopped();
					const index = await new SessionIndex(agentDir).open();
					throwIfLifecycleStopped();
					const locator = { repo: path.resolve(ctx.cwd), stateRoot };
					const endpointMtimeMs = fs.statSync(path.join(stateRoot, "sdk", `${id}.json`)).mtimeMs;
					await host.registerWithBroker({
						// The endpoint is written before registration. Its exact mtime
						// binds this index generation to that discovery record.
						register: async input => {
							await index.append({
								type: "host_registered",
								...input,
								locator,
								pid: process.pid,
								endpointMtimeMs,
								...(lifecycleRequestId ? { lifecycleRequestId } : {}),
							});
						},
						unregister: async input => {
							await index.append({
								type: "host_unregistered",
								...input,
								locator,
								pid: process.pid,
								...(lifecycleRequestId ? { lifecycleRequestId } : {}),
							});
						},
					});
					throwIfLifecycleStopped();
					runtime.brokerRegistrationActive = true;
					const timer = setInterval(() => {
						void index
							.append({
								type: "host_heartbeat",
								sessionId: id,
								locator,
								endpointGeneration: host.generation,
								pid: process.pid,
							})
							.catch(error => logger.warn(`sdk broker heartbeat failed: ${String(error)}`));
					}, 5_000);
					stopBrokerHeartbeat = () => clearInterval(timer);
				} catch (brokerError) {
					if (lifecycleRequired) throw brokerError;
					logger.warn(`sdk broker registration skipped: ${String(brokerError)}`);
				}
			}

			runtime.stopBrokerHeartbeat = stopBrokerHeartbeat;
			const startedRuntime = runtime;
			runtime.enableNotifications = () => {
				const runtime = startedRuntime;
				if (runtime.notificationsActive) return;
				runtime.notificationsActive = true;
				runtime.disposeAnswerSource = registerInteractiveAnswerSource(
					runtime.id,
					pendingInteractive,
					gatePresentations,
				);
				runtime.disposeFileSink = registerTelegramFileSink(runtime.id, async file => {
					if (runtime.redact) return { ok: false, error: TELEGRAM_FILE_REDACTION_ERROR };
					try {
						const data = await fs.promises.readFile(file.path);
						pushSessionFrame(runtime, {
							type: "file_attachment",
							sessionId: runtime.id,
							name: path.basename(file.path),
							data: data.toString("base64"),
							caption: file.caption,
						});
						return { ok: true };
					} catch (e) {
						return { ok: false, error: e instanceof Error ? e.message : String(e) };
					}
				});
			};
			const activeRuntime = runtime;
			// A native terminal close (SIGHUP), SIGTERM, Ctrl+C exit, or fatal error
			// skips AgentSession.dispose(), so the `session_shutdown` extension event
			// never fires and the daemon-side topic would be orphaned. postmortem
			// awaits registered cleanups on those paths, so send the graceful
			// `session_closed` frame from there too. stopSession() cancels this
			// registration on every other teardown path, so it never double-fires.
			runtime.cancelPostmortemCleanup = postmortem.register(`notifications-session-closed:${id}`, async () => {
				await stopSession(runtime!.id);
			});
			logger.info(`notifications: serving session ${id} at ${endpoint.url}`);
			// A workflow-gate emitter can be installed after session startup.
			// Attach dynamically so the SDK bus presents every durable gate.
			const attachWorkflowGate = (gate: WorkflowGateEmitter | undefined): void => {
				if (activeRuntime.workflowGate === gate) return;
				activeRuntime.disposeGateListener();
				activeRuntime.disposeAckRecoveryParticipant();
				gatePresentations.dispose();
				activeRuntime.disposeGateTerminalController();
				activeRuntime.disposeGateListener = () => {};
				activeRuntime.disposeGateTerminalController = () => {};
				activeRuntime.disposeAckRecoveryParticipant = () => {};
				activeRuntime.workflowGate = undefined;
				gateOptions.clear();
				if (typeof gate?.onGateEmitted !== "function" || typeof gate.resolveGateFromNotification !== "function") {
					return;
				}
				activeRuntime.workflowGate = gate;
				if (hasTerminalArbitrationCapability(gate)) {
					const controller: WorkflowGateTerminalController = {
						completeGateInteractions: gateId => gatePresentations.complete(gateId),
						cancelGateInteractions: (gateId, reason) => gatePresentations.cancel(gateId, reason),
					};
					try {
						activeRuntime.disposeGateTerminalController = gate.registerGateTerminalController(controller);
					} catch (error) {
						logger.warn(`notifications: gate terminal controller unavailable: ${String(error)}`);
					}
				}
				activeRuntime.disposeGateListener = gate.onGateEmitted(g => {
					const options = (g.options ?? []).map(o => String((o as { label?: unknown }).label ?? ""));
					gateOptions.set(g.gate_id, options);
					const promptCtx = g.context as { prompt?: unknown; title?: unknown } | undefined;
					const question =
						(typeof promptCtx?.prompt === "string" && promptCtx.prompt) ||
						(typeof promptCtx?.title === "string" && promptCtx.title) ||
						"Question";
					const stageState =
						typeof g.context?.stage_state === "object" && g.context.stage_state !== null
							? (g.context.stage_state as Record<string, unknown>)
							: {};
					gatePresentations.retain({
						gateId: g.gate_id,
						workflowGateId: g.gate_id,
						sessionId: id,
						question,
						options,
						controls: [],
						multi: stageState.multi === true,
						allowEmpty: stageState.allow_empty === true,
						navigationLabel: stageState.navigation_label === "Next" ? "Next" : "Done",
						selectedOptions: [],
					});
				});
				if (gate.setAckRecoveryParticipant) {
					const native = server as unknown as {
						requestRecoveredAskSelectedAck(
							requestJson: string,
						): Promise<{ status: string; messageId?: number; reason?: string }>;
					};
					gate.setAckRecoveryParticipant({
						requestRecoveredAskSelectedAck: input =>
							requestRecoveredSelectedAck(native, {
								sessionId: input.sessionId,
								actionId: input.actionId,
								commitKey: input.commitKey,
								deadlineAt: input.deadlineAt,
							}),
					});
					activeRuntime.disposeAckRecoveryParticipant = () => gate.setAckRecoveryParticipant?.(null);
				}
				void gate.recoverAcceptedGates?.();
			};
			activeRuntime.disposeGateEmitterListener = registerWorkflowGateEmitterListener(id, attachWorkflowGate);
			if (ctx.workflowGate) attachWorkflowGate(ctx.workflowGate);
			if (notificationsEnabledForSession) runtime.enableNotifications();
			finishStartup({ status: "started", runtime });
			return { status: "started", runtime };
		} catch (e) {
			logger.warn(`notifications: failed to start server: ${String(e)}`);
			const result = failLifecycleStartup("failed", e);
			finishStartup(result);
			if (!(await stopSession(id, "session", runtime))) await cleanupAbandonedStartup();
			return { ...result, runtime };
		}
	}

	const sessionRuntime: NotificationSessionRuntime<ExtensionContext> = {
		isRunning: binding => runtimes.get(binding.sessionId)?.notificationsActive === true,
		start: async binding => {
			if (sessionStartPromises.has(binding.sessionId)) {
				const result = await startSession(binding.context);
				if (result.status !== "started" && result.status !== "already") return result.status;
				const runtime = runtimes.get(binding.sessionId);
				if (!runtime || sessionId(binding.context) !== binding.sessionId || activeRuntimeId !== binding.sessionId) {
					return "failed";
				}
				runtime.enableNotifications();
				return "started";
			}
			const runtime = runtimes.get(binding.sessionId);
			if (runtime) {
				runtime.enableNotifications();
				return "started";
			}
			const result = await startSession(binding.context);
			return result.status === "started" || result.status === "already" ? "started" : result.status;
		},
		stop: async binding => await stopSession(binding.sessionId, "notifications"),
		ensureTelegramDaemon: async binding => {
			const { settings, settingsAvailable } = resolveSettings(options.settings);
			if (!settingsAvailable || !settings) return "blocked_identity";
			try {
				return await ensureTelegramOwner(settings, binding.cwd, binding.sessionId);
			} catch {
				return "blocked_identity";
			}
		},
	};
	controller.attachRuntime(sessionRuntime);

	api.registerCommand("notify", {
		description: "Control notifications for this session (on, off, status).",
		async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
			const id = sessionId(ctx);
			const command = args.trim().split(/\s+/, 1)[0]?.toLowerCase() || "status";
			const resolved = resolveSettings(options.settings);
			const enabledWithoutLocalOff = isSessionNotificationsEnabled({
				cfg: resolved.cfg,
				env: process.env,
				sessionDisabled: false,
			});

			if (command === "off") {
				const result = await controller.setLocalEnabled(ctx, false);
				ctx.ui.notify(
					result.outcome === "stopped"
						? "Notifications disabled for this session."
						: "Notifications already disabled for this session.",
					"info",
				);
				return;
			}

			if (command === "on") {
				if (!isNotificationEligibleContext(ctx)) {
					ctx.ui.notify("Notifications are disabled for subagent sessions.", "warning");
					return;
				}
				if (process.env.GJC_NOTIFICATIONS === "0") {
					ctx.ui.notify(
						"Notifications remain disabled: GJC_NOTIFICATIONS=0 is an authoritative opt-out.",
						"warning",
					);
					return;
				}
				if (!enabledWithoutLocalOff) {
					ctx.ui.notify(
						"Notifications are not configured. Run `gjc notify setup` or set GJC_NOTIFICATIONS=1.",
						"warning",
					);
					return;
				}
				const result = await controller.setLocalEnabled(ctx, true);
				const enabled = result.status.running && result.status.effectiveEnabled;
				const rotated = sessionId(ctx) !== id;
				const failed = result.outcome === "failed" || (!enabled && !rotated && activeRuntimeId !== id);
				ctx.ui.notify(
					enabled
						? "Notifications enabled for this session."
						: rotated
							? "Notifications were not enabled because the active session changed during startup."
							: failed
								? "Notifications failed to start for this session."
								: "Notifications were not enabled because daemon ownership could not be proved.",
					enabled ? "info" : rotated ? "warning" : failed ? "error" : "warning",
				);
				return;
			}

			if (command !== "status") {
				ctx.ui.notify("Usage: /notify status | /notify on | /notify off", "warning");
				return;
			}

			const status = controller.query(ctx);
			const runtime = runtimes.get(id);
			ctx.ui.notify(
				`Notifications ${status.running ? "running" : status.effectiveEnabled ? "enabled" : "disabled"} for this session; redaction ${(runtime?.redact ?? resolved.cfg.redact) ? "on" : "off"}; verbosity ${runtime?.verbosity ?? resolved.cfg.verbosity}${status.locallyEnabled ? "" : "; locally off"}.`,
				"info",
			);
		},
	});

	api.on("session_start", async (_event, ctx) => {
		await startSession(ctx);
		await controller.reconcileCurrentSession(ctx);
	});

	// A session endpoint's token and generation are authority for exactly one
	// session id. `/new`, fork, and resume must all tear down A before publishing
	// B. Chat implementations may preserve a topic as metadata, but it must never
	// preserve A's endpoint or credentials as B's control/viewing authority.
	const rotateSessionAuthority = async (
		event: { previousSessionFile?: string },
		ctx: ExtensionContext,
	): Promise<void> => {
		const newId = sessionId(ctx);
		const prevId = activeRuntimeId ?? sessionIdFromFile(event.previousSessionFile);
		if (prevId && prevId !== newId) {
			controller.rekeySession(prevId, newId);
			await stopSession(prevId);
		}
		await startSession(ctx);
		await controller.reconcileCurrentSession(ctx);
	};
	api.on("session_switch", async (event, ctx) => {
		if (identityControlInFlight) {
			deferredIdentityRotation = { event, ctx };
			return;
		}
		await rotateSessionAuthority(event, ctx);
	});
	api.on("session_branch", async (event, ctx) => {
		if (identityControlInFlight) {
			deferredIdentityRotation = { event, ctx };
			return;
		}
		await rotateSessionAuthority(event, ctx);
	});

	// Drive the live typing indicator: mark busy when the agent loop starts so
	// the daemon shows "typing…" in the thread while the agent is thinking,
	// before any turn output exists. Cleared on `agent_end` below.
	api.on("agent_start", (_event, ctx) => {
		const id = sessionId(ctx);
		const rt = runtimes.get(id);
		if (!rt) return;
		// Streaming state is SDK-visible session truth (context.get isStreaming);
		// it is tracked regardless of whether notifications are active.
		rt.busy = true;
		const correlation = rt.pendingPromptCorrelations.shift();
		rt.activePromptCorrelation = correlation;
		rt.emitPromptLifecycle(correlation, { type: "agent_start", sessionId: id, ...correlation });
		try {
			// `activity` is the native live-host lifecycle surface. The separately
			// emitted agent_start above is replayable with command/turn correlation.
			pushSessionFrame(rt, { type: "activity", sessionId: id, state: "busy" });
		} catch (e) {
			logger.warn(`notifications: activity (busy) failed: ${String(e)}`);
		}
	});

	// Each turn that starts has absorbed any messages injected from the thread,
	// so ack them as "consumed": the daemon flips the queued reaction on the
	// originating Telegram message to the consumed (double-check) reaction.
	api.on("turn_start", (_event, ctx) => {
		const id = sessionId(ctx);
		const rt = runtimes.get(id);
		if (!rt?.notificationsActive) return;
		// A new turn is live: re-open the live-stream window (see turnClosed).
		rt.turnClosed = false;
		if (rt.pendingInbound.size === 0) return;
		for (const updateId of rt.pendingInbound) {
			try {
				pushSessionFrame(rt, { type: "inbound_ack", sessionId: id, updateId, state: "consumed" });
			} catch (e) {
				logger.warn(`notifications: inbound_ack failed: ${String(e)}`);
			}
		}
		rt.pendingInbound.clear();
	});

	// Idle fires on `agent_end` (the agent loop settling to await the user), NOT
	// per `turn_end`. turn_end fires once per turn iteration, so a single
	// user-visible idle previously produced many idle pings (the flood); agent_end
	// fires exactly once per settle, yielding exactly one idle notification.
	api.on("agent_end", (_event, ctx) => {
		const id = sessionId(ctx);
		const rt = runtimes.get(id);
		if (!rt) return;
		// Clear the streaming flag for SDK consumers even when notifications are off.
		rt.busy = false;
		const correlation = rt.activePromptCorrelation;
		if (correlation) {
			if (rt.recordPromptTerminal(correlation))
				rt.emitPromptLifecycle(correlation, { type: "agent_end", sessionId: id, ...correlation });
		} else {
			rt.emitPromptLifecycle(undefined, { type: "agent_end", sessionId: id });
		}
		try {
			pushSessionFrame(rt, { type: "activity", sessionId: id, state: "idle" });
		} catch (e) {
			logger.warn(`notifications: activity (idle) failed: ${String(e)}`);
		}
		if (!rt.notificationsActive) return;
		void rt.workflowGate?.recoverAcceptedGates?.();
		const seq = rt.idleSeq++;
		// Re-assert the identity header so the daemon renames the topic once the
		// session title has been auto-generated ("{repo}/{branch} - {title}"). The
		// daemon only renames when the title actually changed.
		try {
			pushSessionFrame(rt, {
				type: "identity_header",
				sessionId: id,
				...buildIdentity(ctx.cwd, ctx.sessionManager.getSessionName()),
			});
		} catch {}
		try {
			rt.server.noteIdle(
				JSON.stringify(
					notificationActionPayload(
						{
							id: `idle:${id}#${seq}`,
							kind: "idle",
							sessionId: id,
							summary: undefined,
						},
						{ redact: rt.redact, sessionTag: rt.sessionTag },
					),
				),
			);
		} catch (e) {
			logger.warn(`notifications: noteIdle failed: ${String(e)}`);
		}

		// On idle, stream a context update with metadata (token/model usage +
		// working-tree diff) unless redaction is on. The agent's last message is
		// NOT repeated here — it is already streamed once via `turn_stream`.
		if (!rt.redact && rt.verbosity === "verbose") {
			const usage = (
				ctx as { getContextUsage?: () => { tokens: number | null; contextWindow: number } | undefined }
			).getContextUsage?.();
			const model = (ctx as { getModel?: () => { id?: string } | undefined }).getModel?.();
			const tokenUsage = usage && usage.tokens != null ? `${usage.tokens}/${usage.contextWindow}` : undefined;
			const modelId = model?.id;
			void readGitDiffStat(ctx.cwd).then(diff => {
				const cwd = compactCwd(ctx.cwd);
				if (!diff && !tokenUsage && !modelId && !cwd) return;
				try {
					pushSessionFrame(rt, {
						type: "context_update",
						sessionId: id,
						tokenUsage,
						model: modelId,
						diff,
						cwd,
					});
				} catch (e) {
					logger.warn(`notifications: context_update failed: ${String(e)}`);
				}
			});
		}
	});

	// Stream viable agent output per turn (the live thread mirror). Unlike idle,
	// turn output is expected to be multiple messages — one per turn that
	// produced assistant text. Tool-only turns yield no text and are skipped.
	// Redaction suppresses streamed content (only the one-time identity header
	// survives redaction). The daemon coalesces/throttles these via its shared
	// rate-limit pool before sending to Telegram.
	// Push the in-flight turn's assistant text as a finalized turn_stream, deduped
	// against what was already flushed for this turn (the pre-ask lead-in).
	const flushTurnText = (rt: SessionRuntime, id: string, text: string | undefined, finalAnswer: boolean): void => {
		if (!text || text === rt.preAskFlushedText || !rt.notificationsActive) return;
		rt.preAskFlushedText = text;
		// Decision A: a stream-enabled turn must finalize as an in-place edit of ONE
		// live message, never a fresh (rich-promotable) send. If live frames were
		// async-queued and none landed before this flush, allocate the per-turn ref
		// now so the finalized frame always carries a messageRef → the daemon keeps it
		// editable (HTML edit) and never rich-promotes a streamed final.
		if (finalAnswer && rt.stream && rt.liveRef === undefined) {
			rt.turnSeq = (rt.turnSeq ?? 0) + 1;
			rt.liveRef = String(rt.turnSeq);
		}
		try {
			pushSessionFrame(rt, {
				type: "turn_stream",
				sessionId: id,
				phase: "finalized",
				finalAnswer,
				text,
				...(rt.liveRef ? { messageRef: rt.liveRef } : {}),
			});
		} catch (e) {
			logger.warn(`notifications: pushFrame (turn) failed: ${String(e)}`);
		}
	};

	// Emit the assistant text that precedes an ask BEFORE the ask's action_needed
	// is broadcast, so the remote (e.g. Telegram) shows the lead-in first instead
	// of only after the ask resolves at turn_end. The text is captured on
	// message_end (which, like tool_execution_start, is on the awaited extension
	// path and ordered before it — unlike message_update, which is queued async),
	// then flushed here before the ask tool's execute calls registerAsk.
	api.on("tool_execution_start", (event, ctx) => {
		if (event.toolName !== "ask") return;
		const id = sessionId(ctx);
		const rt = runtimes.get(id);
		if (!rt?.notificationsActive || rt.redact) return;
		flushTurnText(rt, id, rt.currentTurnText, false);
	});

	api.on("turn_end", (event, ctx) => {
		const id = sessionId(ctx);
		const rt = runtimes.get(id);
		if (!rt?.notificationsActive) return;
		const text = rt.redact ? undefined : summaryFromMessage(event.message, turnTextMax());
		if (text) flushTurnText(rt, id, text, true);
		// Reset per-turn streaming state so the next turn starts fresh and a later
		// turn with identical text is not falsely deduped.
		rt.currentTurnText = undefined;
		rt.preAskFlushedText = undefined;
		rt.liveRef = undefined;
		// Close the live-stream window: any message_update queued after turn_end is
		// dropped so it can never emit a stale live edit past the finalized turn.
		rt.turnClosed = true;
		rt.lastLiveAt = undefined;
		rt.lastLiveText = undefined;
	});

	// Live streaming (opt-in): push throttled in-progress assistant text as
	// non-finalized turn_stream frames so remote clients edit one message as the
	// turn streams. The finalized frame (turn_end) carries the same messageRef and
	// lands the authoritative text. Suppressed under redaction.
	api.on("message_update", (event, ctx) => {
		const id = sessionId(ctx);
		const rt = runtimes.get(id);
		if (!rt?.notificationsActive || !rt.stream || rt.redact || rt.turnClosed) return;
		if ((event.message as { role?: unknown }).role !== "assistant") return;
		if (rt.liveRef === undefined) {
			rt.turnSeq = (rt.turnSeq ?? 0) + 1;
			rt.liveRef = String(rt.turnSeq);
		}
		const now = Date.now();
		if (now - (rt.lastLiveAt ?? 0) < streamIntervalMs()) return;
		const text = summaryFromMessage(event.message, 3500);
		if (!text || text === rt.lastLiveText) return;
		rt.lastLiveAt = now;
		rt.lastLiveText = text;
		try {
			pushSessionFrame(rt, { type: "turn_stream", sessionId: id, phase: "live", text, messageRef: rt.liveRef });
		} catch (e) {
			logger.warn(`notifications: pushFrame (live) failed: ${String(e)}`);
		}
	});

	// Stream agent-produced images (computer/browser/tool screenshots) as
	// image_attachment frames; suppressed when redaction is on.
	api.on("message_end", (event, ctx) => {
		const id = sessionId(ctx);
		const rt = runtimes.get(id);
		if (!rt?.notificationsActive || rt.redact) return;
		// Capture the in-flight ASSISTANT text here (message_end is on the awaited
		// extension path and ordered before tool_execution_start) so the pre-ask
		// flush can emit it before the ask prompt. Role-scoped: message_end also
		// fires for the user prompt, which must never be mirrored back as turn output.
		if ((event.message as { role?: unknown }).role === "assistant") {
			const turnText = summaryFromMessage(event.message, turnTextMax());
			if (turnText) rt.currentTurnText = turnText;
		}
		for (const img of imageAttachmentsFromMessage(event.message)) {
			try {
				pushSessionFrame(rt, {
					type: "image_attachment",
					sessionId: id,
					source: img.source,
					mime: img.mime,
					data: img.data,
				});
			} catch (e) {
				logger.warn(`notifications: image_attachment failed: ${String(e)}`);
			}
		}
	});

	api.on("session_shutdown", async (_event, ctx) => {
		const controllerStop =
			typeof ctx.sessionManager.getCwd === "function" ? controller.stopCurrentSession(ctx) : Promise.resolve(false);
		void controllerStop.catch(error => logger.warn(`notifications: controller shutdown failed: ${String(error)}`));
		await stopSession(sessionId(ctx));
	});
}

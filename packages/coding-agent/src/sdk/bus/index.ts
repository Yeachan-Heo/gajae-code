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
import { type RunSettlementProof, ThinkingLevel } from "@gajae-code/agent-core";
import type { ImageContent, TextContent, Tool } from "@gajae-code/ai/core";
import type { NotificationServer as NativeNotificationServer } from "@gajae-code/natives";

type NativeSdkBusBindings = Pick<typeof import("@gajae-code/natives"), "NotificationServer" | "nativeBuildInfo">;
let nativeSdkBusBindings: NativeSdkBusBindings | undefined;

/**
 * Lazy native access for the SDK bus. `require` is synchronous on purpose:
 * `startSession` must reach its `sessionStartPromises` registration without an
 * intervening microtask yield, or two concurrent starts (two `/notify on`
 * calls) each build a runtime and the loser observes a foreign registration.
 */
function sdkBusNatives(): NativeSdkBusBindings {
	nativeSdkBusBindings ??= require("@gajae-code/natives") as NativeSdkBusBindings;
	return nativeSdkBusBindings;
}

type NotificationServer = NativeNotificationServer;

import { $credentialEnv, logger, postmortem, VERSION } from "@gajae-code/utils";

import { AsyncJobManager } from "../../async";
import { Settings, validateSettingPatch } from "../../config/settings";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../extensibility/extensions";
import { INTERACTIVE_SELECTOR_RESUME_ORIGIN } from "../../extensibility/shared-events";
import { toAgentWireEventPayload } from "../../modes/shared/agent-wire/event-envelope";
import {
	NotificationGatePolicyChangedError,
	type WorkflowGateEmitter,
	type WorkflowGateTerminalController,
	type WorkflowGateTerminalProof,
} from "../../modes/shared/agent-wire/workflow-gate-broker";
import type { AgentSessionEvent } from "../../session/agent-session";
import type { ClientBridge } from "../../session/client-bridge";
import {
	boundTerminalRetentionState,
	findOwnedRegistrationsForTurn,
	isOwnedAttemptRegistrationIncomplete,
	settleOwnedWork,
} from "../../session/terminal-abort";
import { parseThinkingLevel } from "../../thinking";
import type {
	AskAnswerRequest,
	AskAnswerSource,
	AskAnswerSourceResult,
	AskRemoteControl,
	AskRemoteInteraction,
	AskRemoteReceipt,
	AskSelectedAckOutcome,
	AskSettlement,
	AskSettlementResult,
} from "../../tools";
import { RECOMMENDED_SUFFIX } from "../../tools/ask";
import {
	GJC_ASK_TIMEOUT_CODE,
	registerAskAnswerSource,
	registerWorkflowGateEmitterListener,
} from "../../tools/ask-answer-registry";
import { acpFinalTextFromMessage } from "../acp/final-text";
import { ensureBroker } from "../broker/ensure";
import { publishSessionHostRuntimeEvidence, type SessionHostRuntimePublication } from "../broker/lifecycle";
import { processIncarnation } from "../broker/process-incarnation";
import { resolveSessionLocator, SessionIndex } from "../broker/session-index";
import {
	CAP_GATED_FRAME_KINDS,
	createSdkSurfaceFactory,
	masterAttestationForEffectiveHost,
	reattestMasterSessionIdentity,
	type SessionSdkHost,
	SessionSdkSessionRuntime,
	shouldHostSdk,
	TOOL_ACTIVITY_CAPABILITY,
	verifyMasterCapabilityFrame,
} from "../host";
import { type AbortScope, type ControlSurface, dispatchControl, TypedControlError } from "../host/control";
import { BROKER_RUNTIME_CLOSE_CAPABILITY_FIELD } from "../host/control/runtime-gate";
import { isAutoroutingInactive, markAutoroutingInactive } from "../host/internal-autorouting-state";
import { CursorRegistry, QueryHandlers, RevisionStore, type SessionSurface } from "../host/query";
import type { SdkFrame } from "../host/types";
import {
	parseSyntheticModelId,
	resolveSyntheticModelSelection,
	SYNTHETIC_PROVIDER_ID,
	syntheticModelInputError,
	syntheticNamespaceCollision,
} from "../model-profile-model";
import { formatPromptFailureForLocalLog, sanitizePromptFailure } from "../prompt-failure";
import { PROMPT_CLIENT_REF_MAX_LENGTH, type SdkPromptTerminalOutcome } from "../prompt-status";
import { OPERATIONS } from "../protocol/operation-registry";
import {
	lifecycleStartupCapabilityForApi,
	normalizeSdkStartupFailure,
	type SdkStartupFailure,
} from "../startup-capability";
import type { TurnResultContent } from "../turn-result";
import { registerTelegramFileSink } from "./attachment-registry";
import { ensureDiscordDaemon, ensureSlackDaemon } from "./chat-daemon-control";
import {
	getCurrentTelegramActivationMarker,
	getNotificationConfig,
	isProviderEffectivelyEnabled,
	isSlackComplete,
	isTelegramSessionEligible,
	type NotificationConfig,
	type NotificationSettingsReader,
	resolveGenericNotificationSessionEligibility,
	tokenFingerprint,
} from "./config";
import { telegramControlCommandUsage } from "./config-commands";
import {
	isNativeControlDrainAvailable,
	runIdentityControlSuccessPath,
	type TerminalSendOutcome,
} from "./control-drain-lease";
import { ConversationStore } from "./conversation-store";
import {
	createSlackBindingActivationGate,
	EXISTING_THREAD_BIND_ENV,
	isExistingThreadBindingRequested,
} from "./existing-thread-readiness";
import { imageAttachmentsFromMessage, notificationActionPayload, summaryFromMessage, truncate } from "./helpers";
import {
	createKindAwareReconciliation,
	type KindAwareReconciliation,
	type ReconciliationKind,
} from "./kind-aware-reconciliation";
import { assertNativeRuntimeCompatibility } from "./native-runtime-compatibility";
import { proposedTelegramIdentity } from "./notification-orchestration";
import { createPromptReconciliation } from "./prompt-reconciliation";
import {
	createReconciliationStore,
	type DurableTerminalScopeRecord,
	type EvictedTerminalKeyEntry,
	resolveReconciliationSessionFile,
} from "./reconciliation-store";
import { NotificationSessionController, type NotificationSessionRuntime } from "./session-control";
import type { SlackConversation } from "./slack-conversation";
import {
	ASK_SELECTED_ACK_CAPABILITY,
	type EnsureDaemonResult,
	ensureTelegramDaemonRunningDetailed,
	POSITIONED_NOTIFICATION_EFFECTS_CAPABILITY,
} from "./telegram-daemon";

export type {
	IdentityControlSuccessPathInput,
	IdentityControlTerminalPathInput,
	TerminalSendOutcome,
} from "./control-drain-lease";
export {
	isNativeControlDrainAvailable,
	runIdentityControlSuccessPath,
	runIdentityControlTerminalPath,
} from "./control-drain-lease";

export type NotificationInboundAdmission =
	| { outcome: "accept" }
	| { outcome: "drop"; reason: "inbound_fenced" | "policy_suspended" }
	| { outcome: "defer"; reason: "policy_suspended" };

/** Exact production admission decision for daemon-originated session inbound. */
export function notificationInboundAdmission(input: {
	inboundFenced: boolean;
	policySuspended: boolean;
	notificationOrigin: boolean;
	controlCommand: boolean;
}): NotificationInboundAdmission {
	if (input.inboundFenced) return { outcome: "drop", reason: "inbound_fenced" };
	if (input.policySuspended && input.notificationOrigin) {
		// Valid control commands are not dropped: they are deferred while policy is
		// provisional and executed on activate. A terminal `dropped` ack would
		// contradict that later execution and invite client-side retry duplication.
		if (input.controlCommand) return { outcome: "defer", reason: "policy_suspended" };
		return { outcome: "drop", reason: "policy_suspended" };
	}
	return { outcome: "accept" };
}

const PROMPT_SETTLEMENT_DIAGNOSTIC_ENTRY_LIMIT = 8;
const PROMPT_SETTLEMENT_DIAGNOSTIC_MAX_AGE_MS = 86_400_000;
/**
 * Upper bound on the failure reason copied into the local operator log. Mirrors
 * the 512-char bound documented for reconciliation failure messages so a runaway
 * provider error cannot flood the log file.
 */
const PROMPT_TERMINAL_FAILURE_REASON_LOG_MAX = 512;
/**
 * #4743: bounded wait for durable reconciliation quiescence during session
 * teardown. Expiry is OBSERVABLE (owner-release failure), never silently
 * treated as drained. Read per drain so the env override is effective for
 * deterministic tests.
 */
const sdkReconciliationDrainTimeoutMs = (): number => {
	const override = Number(process.env.GJC_SDK_RECONCILIATION_DRAIN_TIMEOUT_MS);
	return override > 0 ? override : 5_000;
};
/**
 * #4743: the two reconciliation failure codes that mean durable state may be
 * lost. Both must reach the teardown owner; every other owner-release failure
 * stays retryable through the retained `cleanupRetries` entry.
 */
const RECONCILIATION_DURABILITY_FAILURE_CODES: ReadonlySet<string> = new Set([
	"reconciliation_persist_failed",
	"reconciliation_drain_timeout",
]);
function reconciliationFailureCode(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const code = (value as { code?: unknown }).code;
	return typeof code === "string" && RECONCILIATION_DURABILITY_FAILURE_CODES.has(code) ? code : undefined;
}
/**
 * Flatten an owner-release failure to its durability-failure members. Aggregates
 * nest (the store batches a drained window's failures, and owner release batches
 * every release failure), so recursion is required to reach the coded leaves.
 */
function reconciliationDurabilityFailures(error: unknown): unknown[] {
	if (error instanceof AggregateError) return error.errors.flatMap(member => reconciliationDurabilityFailures(member));
	return reconciliationFailureCode(error) === undefined ? [] : [error];
}
type PromptTerminalDiagnostic = {
	reason?: unknown;
	loopStopReason?: string;
	assistantStopReason?: string;
	errorKind?: string;
	intentionalCancellation?: boolean;
};

type PromptTerminalExtra = {
	finalText?: string;
	error?: { code: string; message: string };
	diagnostic?: PromptTerminalDiagnostic;
	diagnosticAlreadyLogged?: boolean;
};

function formatPromptTerminalFailureReason(reason: unknown): string {
	let rawReason: string;
	if (reason instanceof Error) rawReason = reason.message;
	else if (typeof reason === "string") rawReason = reason;
	else if (reason === undefined || reason === null) return "unreported";
	else
		try {
			rawReason = String(reason);
		} catch {
			return "unreported";
		}
	return rawReason ? rawReason.slice(0, PROMPT_TERMINAL_FAILURE_REASON_LOG_MAX) : "unreported";
}

/**
 * Thrown from a serialized durable terminal-scope transaction when the
 * idempotency key is already owned by a DIFFERENT input (scope). The generic
 * dispatch cache normally rejects this before the surface, but after its
 * 256-entry eviction two concurrent requests can both pass the earlier
 * snapshot check; the atomic recheck inside the transaction must reject the
 * second instead of appending a duplicate-key row (review thread P2).
 */
class TerminalIdempotencyConflictError extends Error {
	constructor() {
		super("Idempotency key was reused with different input.");
	}
}

function endpointAuthorityDigest(url: string, token: string): string {
	const parsed = new URL(url);
	parsed.hash = "";
	parsed.search = "";
	parsed.hostname = parsed.hostname.toLowerCase();
	return crypto.createHash("sha256").update(`${parsed.toString()} ${token}`, "utf8").digest("hex");
}
export function formatPromptSettlementDiagnostic(
	proof: Extract<RunSettlementProof, { status: "unfenced" }>,
	now = Date.now(),
): string {
	const pending = proof.pending.slice(0, PROMPT_SETTLEMENT_DIAGNOSTIC_ENTRY_LIMIT).map(entry => ({
		kind: entry.kind,
		labelHash: crypto.createHash("sha256").update(entry.label).digest("hex").slice(0, 16),
		ageMs: Math.max(0, Math.min(PROMPT_SETTLEMENT_DIAGNOSTIC_MAX_AGE_MS, now - entry.registeredAt)),
	}));
	return JSON.stringify({
		reason: proof.reason,
		pending,
		omitted: Math.max(0, proof.pending.length - pending.length),
	});
}

// ===========================================================================
// Session lifecycle presentation contract
// ===========================================================================
// Provider-neutral lifecycle command targets and credential-free presentation outcomes.
// SessionLifecycleService owns request authorization/idempotency; these types contain no
// control endpoint, process, tmux, session-state, or SDK endpoint authority.

/** Where a `session_create` should run. Discriminated by `kind`. */
export type SessionCreateTarget =
	| { kind: "existing_path"; path: string }
	| { kind: "worktree"; repo: string; branch: string }
	| { kind: "plain_dir"; path: string };

/** Identifies the session a `session_close` targets. */
export interface SessionCloseTarget {
	sessionId: string;
}

/** Identifies the session a `session_resume` targets. */
export interface SessionResumeTarget {
	sessionIdOrPrefix: string;
	/** Optional repo/working-dir hint to disambiguate matches. */
	path?: string;
}

export type LifecycleStatus = "ok" | "error";

export interface SessionCreateResponseFrame {
	type: "session_create_response";
	requestId: string;
	status: LifecycleStatus;
	sessionId: string;
	target: SessionCreateTarget;
}

export interface SessionCloseResponseFrame {
	type: "session_close_response";
	requestId: string;
	status: LifecycleStatus;
	sessionId: string;
}

export type ResumeMode = "reattached" | "cold_restarted";

export interface SessionResumeResponseFrame {
	type: "session_resume_response";
	requestId: string;
	status: LifecycleStatus;
	sessionId: string;
	mode: ResumeMode;
}

export type LifecycleErrorReason =
	| "unauthorized"
	| "rate_limited"
	| "duplicate_conflict"
	| "invalid_target"
	| "ambiguous_target"
	| "spawn_failed"
	| "discovery_timeout"
	| "readiness_timeout"
	| "worktree_preparation_timeout"
	| "dependency_preparation_timeout"
	| "close_refused"
	| "not_found"
	| "terminal_uncertain"
	| "unsupported_platform";

export interface ResumeCandidate {
	sessionId: string;
	path?: string;
	mtimeMs?: number;
}

export interface SessionLifecycleErrorFrame {
	type: "session_lifecycle_error";
	requestId: string;
	status: LifecycleStatus;
	reason: LifecycleErrorReason;
	message: string;
	candidates?: ResumeCandidate[];
}

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
	sessionName: string | undefined,
	telegramTopicsEnabled: boolean,
): {
	repo: string;
	branch: string;
	machine: string;
	title?: string;
	telegramTopicsEnabled: boolean;
} {
	const repo = readGitRepoName(cwd) ?? (path.basename(cwd) || cwd);
	const branch = readGitBranch(cwd) ?? "(detached)";
	// Send repo/branch and the raw session title separately; the consumer
	// composes the topic name ("{repo}/{branch}" before the session title is
	// auto-generated, then "{repo}/{branch} - {session title}" once it exists).
	return { repo, branch, machine: os.hostname(), title: sessionName, telegramTopicsEnabled };
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
	recommendedIndex?: number;
	multi: boolean;
	allowEmpty: boolean;
	navigationLabel?: "Next" | "Done";
	selectedOptions: string[];
	workflowGateId?: string;
	onActivated?: (actionId: string, lease: { actionId: string; registrationEpoch: number }) => void;
	onClosed?: () => void;
}
function recommendedIndexFromGateOptions(options: readonly unknown[]): number | undefined {
	const descriptions = options.map(option => (option as { description?: unknown }).description);
	const recommended = descriptions.filter(description => description === "recommended");
	return recommended.length === 1 &&
		descriptions.every(description => description === undefined || description === "recommended")
		? descriptions.indexOf("recommended")
		: undefined;
}

type RetireStatus = "retired" | "already_terminal" | "claimed" | "stale";
type DirectControlOutcome = "accepted" | "rejected" | "unknown";

interface PresentationRetentionOptions {
	publish?: boolean;
	sourceEpoch?: number;
}

type PreparedDirectControl =
	| { status: "retired"; ordinal: number }
	| {
			status: "queued";
			ordinal: number;
			/** Exact proof retained from a previously published route, if any. */
			terminalProof?: "retired" | "already_terminal";
	  };

interface DirectControlPreparationLease {
	gateId: string;
	presentation: UnattendedGatePresentation;
	presentationGeneration: number;
	sourceEpoch?: number;
}

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
	/** Gate ids that have had a successfully registered presentation in this retention lifetime. */
	private readonly publishedGateIds = new Set<string>();
	private readonly directControls = new Map<string, number>();
	/** Binds an in-flight direct control to the exact retained presentation it retired. */
	private readonly directControlPreparations = new WeakMap<object, DirectControlPreparationLease>();
	/** Retained presentation identity generations fence same-gate replays. */
	private readonly presentationGenerations = new WeakMap<UnattendedGatePresentation, number>();
	private readonly presentationSourceEpochs = new WeakMap<UnattendedGatePresentation, number | undefined>();
	private presentationGeneration = 0;
	/** Explicit terminal proof for a direct control fenced before native publication. */
	private readonly queuedDirectControls = new Set<string>();
	/** Retained presentations that must wait for committed notification policy. */
	private readonly deferredPublications = new Map<string, number | undefined>();
	private publicationSuspended = false;
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

	#clearRetry(gateId: string): void {
		this.retries.delete(gateId);
		this.#clearTerminalCancellation(gateId);
		if (this.retryTimerGateId !== gateId) return;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
		this.retryTimerGateId = undefined;
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
		if (
			!this.publicationSuspended &&
			!this.active &&
			gateId &&
			!this.deferredPublications.has(gateId) &&
			!this.directControls.has(gateId) &&
			!retry?.exhausted
		) {
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
			this.publicationSuspended ||
			this.deferredPublications.has(gateId) ||
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
		if (
			!gateId ||
			this.queue[0] !== gateId ||
			!this.presentations.has(gateId) ||
			this.publicationSuspended ||
			this.deferredPublications.has(gateId)
		)
			return;
		this.retries.delete(gateId);
		this.#clearTerminalCancellation(gateId);

		this.#observeHead();
		this.reconcile();
	}

	hasActivePresentation(): boolean {
		return this.active !== undefined;
	}

	#bindDirectControl(
		gateId: string,
		presentation: UnattendedGatePresentation,
		prepared: PreparedDirectControl,
	): PreparedDirectControl {
		const presentationGeneration = this.presentationGenerations.get(presentation);
		if (presentationGeneration === undefined)
			throw new Error(`workflow gate ${gateId} presentation lacks a retention generation`);
		this.directControlPreparations.set(prepared, {
			gateId,
			presentation,
			presentationGeneration,
			sourceEpoch: this.presentationSourceEpochs.get(presentation),
		});
		return prepared;
	}

	#isCurrentDirectControl(gateId: string, prepared: PreparedDirectControl): boolean {
		const lease = this.directControlPreparations.get(prepared);
		if (!lease || lease.gateId !== gateId) return false;
		const presentation = this.presentations.get(gateId);
		return (
			presentation === lease.presentation &&
			this.presentationGenerations.get(presentation) === lease.presentationGeneration &&
			this.presentationSourceEpochs.get(presentation) === lease.sourceEpoch
		);
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

	prepareDirectControl(gateId: string): PreparedDirectControl | { status: "claimed" | "stale" } {
		const ordinal = this.queue.indexOf(gateId);
		const presentation = this.presentations.get(gateId);
		if (this.active?.gateId === gateId) {
			const status = this.retireForDirectControl(gateId);
			if (status !== "retired") return { status: status === "already_terminal" ? "stale" : status };
			if (!presentation) return { status: "stale" };
			return this.#bindDirectControl(gateId, presentation, { status, ordinal });
		}
		if (!presentation || ordinal < 0 || this.directControls.has(gateId)) return { status: "stale" };
		const terminalProof = this.retiredProofs.get(gateId);
		if (terminalProof !== "retired" && terminalProof !== "already_terminal" && this.publishedGateIds.has(gateId))
			return { status: "stale" };
		// Fence the queued entry before awaiting durable resolution; promotion cannot
		// republish it until the control has a known terminal outcome.
		this.directControls.set(gateId, ordinal);
		this.queuedDirectControls.add(gateId);
		return this.#bindDirectControl(
			gateId,
			presentation,
			terminalProof === "retired" || terminalProof === "already_terminal"
				? { status: "queued", ordinal, terminalProof }
				: { status: "queued", ordinal },
		);
	}

	finishDirectControl(gateId: string, prepared: PreparedDirectControl, outcome: DirectControlOutcome): void {
		// The emitter may have been replaced while the durable resolution was in
		// flight. Never let that old completion act on a replacement presentation
		// that happens to reuse the same gate id.
		if (!this.#isCurrentDirectControl(gateId, prepared)) return;
		this.directControlPreparations.delete(prepared);
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
		if (!this.presentations.has(gateId)) return;
		const current = this.queue.indexOf(gateId);
		if (current >= 0) this.queue.splice(current, 1);
		this.queue.splice(Math.min(prepared.ordinal, this.queue.length), 0, gateId);
		this.reconcile();
	}

	constructor(
		private readonly server: NotificationServer,
		private readonly redact: () => boolean,
	) {}

	/** Gate retention remains available while notification publication is suspended. */
	setPublicationSuspended(suspended: boolean): void {
		this.publicationSuspended = suspended;
		if (!suspended) this.#promote();
	}

	/** Publish only deferred presentations from the still-authoritative source. */
	activateDeferred(sourceEpoch?: number): void {
		for (const [gateId, deferredEpoch] of this.deferredPublications) {
			if (sourceEpoch !== undefined && deferredEpoch !== undefined && deferredEpoch !== sourceEpoch) continue;
			this.deferredPublications.delete(gateId);
			this.#clearRetry(gateId);
		}
		this.#promote();
	}

	retain(presentation: UnattendedGatePresentation, options: PresentationRetentionOptions = {}): void {
		if (options.publish === false || this.publicationSuspended) {
			this.deferredPublications.set(presentation.gateId, options.sourceEpoch);
			this.#clearRetry(presentation.gateId);
		} else {
			this.deferredPublications.delete(presentation.gateId);
		}
		const existing = this.presentations.get(presentation.gateId);
		if (
			existing &&
			this.active?.gateId === presentation.gateId &&
			(existing.options.length !== presentation.options.length ||
				existing.options.some((option, index) => presentation.options[index] !== option))
		) {
			const active = this.active;
			let status: RetireStatus;
			try {
				status = parseRetireStatus(this.server.retireIfUnclaimed(active).status);
			} catch (error) {
				logger.warn(`interactive presentation replay retirement failed: ${String(error)}`);
				return;
			}
			if (!isTerminalProof(status)) return;
			this.routes.delete(active.actionId);
			this.active = undefined;
			this.retiredProofs.set(presentation.gateId, status);
		}
		const alreadyPresent = existing !== undefined;
		if (existing?.multi && presentation.multi) {
			presentation.selectedOptions = existing.selectedOptions.filter(option =>
				presentation.options.includes(option),
			);
		}
		if (!alreadyPresent) this.queue.push(presentation.gateId);
		this.presentationGenerations.set(presentation, ++this.presentationGeneration);
		this.presentationSourceEpochs.set(presentation, options.sourceEpoch);
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
		// Native claim resolution terminalized the published route; preserve that
		// exact proof if the replacement publication cannot be registered.
		this.retiredProofs.set(presentation.gateId, "already_terminal");
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
		this.publishedGateIds.delete(gateId);
		this.deferredPublications.delete(gateId);
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
		this.publishedGateIds.delete(gateId);
		this.deferredPublications.delete(gateId);
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
		this.publishedGateIds.delete(gateId);
		this.deferredPublications.delete(gateId);
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
		if (
			!presentation ||
			this.publicationSuspended ||
			this.deferredPublications.has(gateId) ||
			this.directControls.has(gateId) ||
			this.active
		)
			return undefined;
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
							...(presentation.multi
								? {
										selectedOptionIndices: presentation.options.flatMap((option, index) =>
											presentation.selectedOptions.includes(option) ? [index] : [],
										),
									}
								: {}),
							...(presentation.recommendedIndex === undefined
								? {}
								: { recommendedIndex: presentation.recommendedIndex }),
							// A presentation that carries its own controls (the ask tool's
							// Next/Done) keeps them; a durable workflow gate presents none,
							// so its navigation control is synthesized here.
							controls:
								presentation.controls.length > 0
									? presentation.controls
									: presentation.multi
										? [
												{
													id: "navigation_forward",
													kind: "navigation",
													label: presentation.navigationLabel ?? "Done",
													enabled: presentation.allowEmpty || presentation.selectedOptions.length > 0,
												},
											]
										: [],
						},
						{ redact: this.redact() },
					),
				),
				true,
			);
			if (lease.actionId !== actionId) throw new Error("native arbitrated action id mismatch");
			this.active = { actionId, gateId, registrationEpoch: lease.registrationEpoch };
			this.publishedGateIds.add(gateId);
			// A replacement route now has its own exact proof; do not reuse a
			// terminal proof retained for the route it replaced.
			this.retiredProofs.delete(gateId);
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
			// Preserve the exact lease proof after removing the route. A later
			// terminalization must not fall back to a broad publication-suspended
			// heuristic and misclassify a previously published lease as not_published.
			this.publishedGateIds.add(gateId);
			this.retiredProofs.set(gateId, status);
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
			proof = this.retiredProofs.get(gateId) ?? proof;
		}
		const presentation = this.presentations.get(gateId);
		if (!proof && this.queuedDirectControls.has(gateId)) proof = "not_published";
		if (!proof && this.deferredPublications.has(gateId)) proof = "not_published";
		if (!proof && this.publicationSuspended && presentation) proof = "not_published";
		if (!proof && presentation)
			throw new Error(`workflow gate ${gateId} presentation lacks an active terminal lease`);
		this.presentations.delete(gateId);
		this.publishedGateIds.delete(gateId);
		this.deferredPublications.delete(gateId);
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
		const publicationSuspended = this.publicationSuspended;
		this.publicationSuspended = true;
		for (const gateId of [...this.presentations.keys()]) this.cancel(gateId, "session_shutdown");
		this.deferredPublications.clear();
		this.publicationSuspended = publicationSuspended;
	}
}

interface SessionRuntime {
	server: NotificationServer;
	host: SessionSdkHost;
	/** Delivers one ring-positioned event envelope to every attached subscriber
	 *  connection, applying the same capability gate as event replay. */
	broadcastEventFrame: (event: SdkFrame) => string[];
	/** Delivers one positioned event and returns opaque receipts only for the
	 *  notification-effect generations that accepted it. */
	broadcastEventFrameWithReceipts: (event: SdkFrame) => string[];
	/** Owns stateRoot-backed revisions and removes their spills on terminal shutdown. */
	revisions: RevisionStore;
	/** Releases all snapshot pins before the revision store is closed. */
	cursors: CursorRegistry;
	/** Current endpoint session identity; never re-key an existing host across a switch. */
	id: string;
	/** Discovery scope is fixed before publication; a live default endpoint is never rotated in place. */
	endpointScope: "default" | "chat";
	idleSeq: number;
	/** Stops delayed session-name observation when this runtime loses authority. */
	stopSessionNameObserver: () => void;
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
	/** Provider ownership state is independent from the already-published core SDK runtime. */
	notificationOwnerState: "ready" | "retry" | "blocked";
	/**
	 * Ownership-relevant configuration identity this runtime's owner state was
	 * proved under. A settled outcome may only be applied while it still matches,
	 * so a credential/destination/enablement change forces a re-proof.
	 */
	notificationOwnerKey?: string;
	/** Rejects new SDK frames while a leased terminal response drains. */
	inboundFenced: boolean;
	/** Set as soon as terminal teardown is requested, before startup settles. */
	stopping: boolean;
	/** Recreates notification-only resources after `/notify on`. */
	enableNotifications: () => void;
	/** Deregisters canonical workflow-gate terminal cleanup. */
	disposeGateTerminalController: () => void;
	disposeAckRecoveryParticipant: () => void;
	disposeGateEmitterListener: () => void;
	/** Aborts and fences side turns while notification delivery is disabled. */
	disableEphemeralTurns: () => void;
	waitForGateResolutionQuiescence: () => Promise<void>;
	/** Awaits durable quiescence of every reconciliation transaction this runtime
	 *  admitted, joining their producers first. Never swallows evidence: producer
	 *  and store rejections are returned in `failures`, and a bounded-deadline
	 *  expiry is returned as `timedOut` (#4743). */
	drainDurableReconciliation: () => Promise<{ timedOut: boolean; failures: unknown[] }>;
	trackGateResolution: <T>(resolution: Promise<T>) => Promise<T>;
	workflowGate?: WorkflowGateEmitter;
	gatePresentations?: PresentationArbiter;
	redact: boolean;
	/** Last stable policy's redaction state, retained while provisional policy is held. */
	committedRedact: boolean;
	/** Provisional policy suppresses delivery without changing committed-side effects. */
	policySuspended: boolean;
	/** Monotonic policy epoch fences asynchronous notification delivery. */
	policyGeneration: number;
	/** Monotonic source lease epoch for workflow-gate presentation retention. */
	workflowGatePublicationEpoch: number;
	/** True only after the exact host generation was registered with the broker index. */
	brokerRegistrationActive: boolean;
	/** Terminal cleanup proof retained across retries; each owner is released at most once after proof. */
	hostStopped: boolean;
	serverStopped: boolean;
	/** This runtime's own host-liveness publication; only its teardown may retract it. */
	evidencePublication?: SessionHostRuntimePublication;
	brokerRegistrationReleased: boolean;
	verbosity: "lean" | "verbose";
	/** Whether the agent loop is currently running (drives the typing indicator). */
	busy: boolean;
	/** Prompt command/turn identities awaiting their corresponding agent_start. */
	pendingPromptCorrelations: Array<{ commandId: string; turnId: string }>;
	/** SDK run tokens bind an accepted queued follow-up to only its matching agent_start. */
	pendingPromptCorrelationsBySdkRunToken: Map<string, { commandId: string; turnId: string }>;
	/** Identity bound to the agent lifecycle currently in flight. */
	activePromptCorrelation?: { commandId: string; turnId: string };
	/** Binds the executing Agent run to a correlated prompt so cleanup targets only it. */
	bindPromptExecutionHandle: (correlation: { commandId: string; turnId: string }, handle: string | undefined) => void;
	/** Reads the durable non-terminal claim for a correlated prompt, if any. */
	peekPromptPendingOutcome: (correlation: {
		commandId: string;
		turnId: string;
	}) => SdkPromptTerminalOutcome | undefined;
	/** Claims, fences, finalizes, and publishes exactly one normalized prompt terminal. */
	terminalizePrompt: (
		correlation: { commandId: string; turnId: string },
		outcome: SdkPromptTerminalOutcome,
		extra?: PromptTerminalExtra,
	) => Promise<void>;
	/** Transitions the authoritative reconciliation record at lifecycle ingress; terminal outcomes settle once. */
	notePromptReconciliation: (
		correlation: { commandId: string; turnId: string } | undefined,
		frame: { type: "agent_start" | "agent_end" } | { type: "agent_failed"; error: unknown },
	) => void | Promise<void>;
	/** Settles and emits one sanitized correlated prompt failure. */
	emitPromptFailure: (correlation: { commandId: string; turnId: string }, error: unknown) => void;
	/** Records correlated lifecycle frames for replay and delivers them only to the accepted requester after acknowledgement. */
	emitPromptLifecycle: (
		correlation: { commandId: string; turnId: string } | undefined,
		frame:
			| {
					type: "agent_start" | "agent_end";
					sessionId: string;
					commandId?: string;
					turnId?: string;
					finalText?: string;
					outcome?: SdkPromptTerminalOutcome;
			  }
			| {
					type: "agent_failed";
					sessionId: string;
					commandId: string;
					turnId: string;
					error: { code: string; message: string };
					outcome?: SdkPromptTerminalOutcome;
			  },
	) => void;
	/** Publishes one canonical agent-wire event to the client that owns the active prompt. */
	emitPromptEvent: (event: AgentSessionEvent) => void;
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
	/** Finalized while provisional policy was held; flush exactly once on stable activation. */
	pendingFinal?: {
		window: number;
		receipts: Array<{ text: string; messageRef?: string; origin: "user" | "autonomous" | "continuation" }>;
	};
	/** Monotonic user-request boundary for deferred lean delivery. */
	settlementWindow: number;
	/** Provenance of the currently executing assistant turn. */
	currentTurnSettlementOrigin?: "user" | "autonomous" | "continuation";
	/** Immutable settlement boundary captured when the current turn begins. */
	currentTurnSettlementWindow?: number;
	/**
	 * Lean-mode deferred receipts for the current user-request settlement window.
	 * Ordinary tool-loop turns retain latest-turn-wins behaviour. An autonomous
	 * continuation has no new user request, so it appends instead of erasing the
	 * prior receipt. The small fixed receipt bound prevents an unbounded idle wait
	 * from retaining the full transcript.
	 */
	pendingSettled?: {
		window: number;
		receipts: Array<{ text: string; messageRef?: string; origin: "user" | "autonomous" | "continuation" }>;
	};
	/** SDK control frames received during provisional ownership; replayed only after stable activation. */
	deferredInboundControls: Array<() => void>;
	/** Started tool calls awaiting a terminal activity frame, keyed by tool call id. */
	inFlightTools: Map<
		string,
		{ toolName: string; args?: unknown; pendingPhase?: "completed" | "failed" | "cancelled" }
	>;
	/** Cancels the postmortem cleanup that emits `session_closed` on process teardown. */
	cancelPostmortemCleanup: () => void;
	/** Disposes side-turn resources when their owning logical session becomes unavailable. */
	abortEphemeralTurns: () => void;
}

const SENSITIVE_MODEL_LABEL =
	/(?:\b(?:https?|wss?):\/\/|\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b|\b(?:api[-_ ]?key|access[-_ ]?token|bearer|secret|password|account(?:\s*id)?|email|exception|stack trace)\b|\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b)/i;
const TOOL_SUMMARY_MAX = 280;

/** Stable projection of the tool-owned safe-display seam (never the full Tool surface). */
type SafeSummaryTool = Pick<Tool, "safeSummary" | "safeSummaryFields">;

export function projectToolSummary(
	tool: SafeSummaryTool | undefined,
	kind: "args" | "result",
	value: unknown,
): string | undefined {
	let summary: string | undefined;
	try {
		if (tool?.safeSummary) {
			summary = tool.safeSummary(kind, value);
		} else {
			const fields = tool?.safeSummaryFields?.[kind];
			if (fields) {
				const source =
					value && typeof value === "object" && !Array.isArray(value)
						? (value as Record<string, unknown>)
						: undefined;
				if (source) {
					const projected: Record<string, unknown> = {};
					for (const field of fields) if (Object.hasOwn(source, field)) projected[field] = source[field];
					summary = JSON.stringify(projected);
				}
			}
		}
	} catch {
		return undefined;
	}
	if (typeof summary !== "string") return undefined;
	const normalized = summary.replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, " ").trim();
	if (!normalized || SENSITIVE_MODEL_LABEL.test(normalized)) return undefined;
	return truncate(normalized, TOOL_SUMMARY_MAX);
}

/** Request-local requester authority for stable ControlSurface dispatches. */
const controlRequesterContext = new AsyncLocalStorage<string>();
type SessionStartStatus = "started" | "already" | "disabled" | "failed";
type SessionStartResult = {
	status: SessionStartStatus;
	runtime?: SessionRuntime;
	failure?: SdkStartupFailure;
	suppressExtensionError?: boolean;
};

/** Ring append plus positioned live broadcast. An event retained for replay
 *  must also reach already-attached subscribers live as the same positioned
 *  envelope, or they can only observe it by issuing another replay. */
function emitSessionEvent(
	runtime: Pick<SessionRuntime, "host" | "broadcastEventFrame">,
	frame: { type: string; [key: string]: unknown },
	payload: Record<string, unknown> = frame,
): string[] {
	return runtime.broadcastEventFrame(runtime.host.emitEvent({ kind: frame.type, payload }));
}

function emitSessionEventWithReceipts(
	runtime: Pick<SessionRuntime, "host" | "broadcastEventFrameWithReceipts">,
	frame: { type: string; [key: string]: unknown },
): string[] {
	return runtime.broadcastEventFrameWithReceipts(runtime.host.emitEvent({ kind: frame.type, payload: frame }));
}

function pushSessionFrame(
	runtime: Pick<SessionRuntime, "server" | "host" | "broadcastEventFrame">,
	frame: { type: string; [key: string]: unknown },
): boolean {
	const positionedRecipients = emitSessionEvent(runtime, frame);
	if (frame.type === "turn_stream") {
		const rawAccepted = runtime.server.pushTurnStreamUnchecked(
			String(frame.sessionId),
			frame.phase === "live" ? "live" : "finalized",
			String(frame.text),
			typeof frame.finalAnswer === "boolean" ? frame.finalAnswer : undefined,
			typeof frame.messageRef === "string" ? frame.messageRef : undefined,
			positionedRecipients,
		);
		// A retained lean settlement may be consumed only after either the
		// positioned or legacy raw transport accepts the lead-in. Older native addons
		// return undefined here, which deliberately fails closed unless the
		// positioned leg has already proved acceptance.
		return positionedRecipients.length > 0 || rawAccepted === true;
	}
	runtime.server.pushFrame(JSON.stringify(frame), positionedRecipients);
	return positionedRecipients.length > 0;
}

async function pushTerminalSessionFrame(
	runtime: Pick<SessionRuntime, "server" | "host" | "broadcastEventFrame">,
	frame: { type: "session_closed"; sessionId: string },
): Promise<boolean> {
	emitSessionEvent(runtime, frame);
	// Terminal shutdown still uses the acknowledged native leg: the positioned
	// send is best-effort and the server must not stop before a socket writer has
	// settled this final frame.
	return await runtime.server.pushFrameAndWait(JSON.stringify(frame), 1_000);
}

function pushFileAttachment(
	runtime: Pick<SessionRuntime, "server" | "host" | "broadcastEventFrame">,
	frame: { type: "file_attachment"; sessionId: string; name: string; mime?: string; caption?: string },
	data: Buffer,
): void {
	const positionedRecipients = emitSessionEvent(runtime, frame, { ...frame, data: data.toString("base64") });
	runtime.server.pushFileAttachmentUnchecked(
		frame.sessionId,
		frame.name,
		frame.mime,
		data,
		frame.caption,
		positionedRecipients,
	);
}

/** Agent lifecycle is SDK session truth, independent of optional chat delivery. */
function emitAgentLifecycle(
	runtime: Pick<SessionRuntime, "server" | "host" | "broadcastEventFrame">,
	frame: { type: "agent_start" | "agent_end"; sessionId: string; commandId?: string; turnId?: string },
): void {
	try {
		const json = JSON.stringify(frame);
		const positionedRecipients = emitSessionEvent(runtime, frame);
		runtime.server.pushFrame(json, positionedRecipients);
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
	sound: "all",
	idleTimeoutMs: 60_000,
	rich: { enabled: true },
	richDraft: { enabled: false },
	toolActivity: { enabled: false },
	streaming: { enabled: true },
	topics: {},
	btw: { enabled: true },
};

/**
 * Whether the notifications control channel is enabled.
 *
 * Trusted sources only: enabling it opens the session control/answer channel, so
 * a repository must not be able to turn it on. `$env` merges the caller's
 * `cwd/.env` into `process.env`; the sibling resolvers in `config.ts` and
 * `session-control.ts` already read an injected env record rather than the merged
 * view, and this direct read was the outlier.
 */
export function notificationsEnabled(): boolean {
	return $credentialEnv("GJC_NOTIFICATIONS") === "1" || Boolean($credentialEnv("GJC_NOTIFICATIONS_TOKEN"));
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

function createSdkUiAskAnswerSource(
	requestElicitation: (params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
): AskAnswerSource {
	const awaitAnswerRequest = async (
		request: AskAnswerRequest,
		signal?: AbortSignal,
	): Promise<AskAnswerSourceResult> => {
		if (signal?.aborted) return undefined;
		const choices = new Map<string, AskRemoteInteraction>();
		const oneOf =
			request.interaction === "selector"
				? [
						...request.options.map((label, index) => {
							const value = `option:${index}`;
							choices.set(value, { kind: "value", value: label });
							return { const: value, title: label };
						}),
						...request.controls
							.filter(control => control.enabled)
							.map(control => {
								const value = `control:${control.id}`;
								choices.set(value, { kind: "control", controlId: control.id });
								return { const: value, title: control.label };
							}),
					]
				: [];
		const response = await requestElicitation(
			{
				mode: "form",
				message: request.question,
				requestedSchema: {
					type: "object",
					properties: {
						value: { type: "string", ...(oneOf.length > 0 ? { oneOf } : {}) },
					},
					required: ["value"],
				},
			},
			signal,
		);
		if (signal?.aborted || !isRecord(response) || response.action !== "accept") return undefined;
		const value = isRecord(response.content) ? response.content.value : undefined;
		if (typeof value !== "string") return undefined;
		if (request.interaction !== "selector") return value;
		const interaction = choices.get(value);
		if (!interaction) return undefined;
		if (interaction.kind === "value") return interaction.value;
		let settled: Promise<AskSettlementResult> | undefined;
		return {
			source: "remote",
			interaction,
			settle(settlement) {
				if (!settled) {
					settled = Promise.resolve(
						settlement.kind === "commit"
							? { kind: "committed", ack: { status: "failed", reason: "unsupported" } }
							: settlement.kind === "invalid"
								? { kind: "invalid_closed" }
								: { kind: "resolved_without_commit" },
					);
				}
				return settled;
			},
		};
	};
	return {
		async awaitAnswer(question, options, signal) {
			const answer = await awaitAnswerRequest({ question, options, interaction: "selector", controls: [] }, signal);
			if (!answer || typeof answer === "string") return answer;
			return answer.interaction.kind === "value" ? answer.interaction.value : undefined;
		},
		awaitAnswerRequest,
	};
}

/**
 * Ask-answer source that bridges workflow-gate asks to the ACP permission
 * channel (`session/request_permission`). Used when the client does not
 * advertise ACP form elicitation (e.g. Paseo): the gate question is sent as
 * a permission request whose options are the answer choices, and the
 * selected optionId maps back to the answer. Only selector asks are bridged;
 * free-text asks have no permission-option representation and stay
 * unanswered (unchanged from today). Auto-approval follows the client's
 * permission mode, so gates never self-approve under `prompt`.
 */
export function createSdkPermissionAskAnswerSource(
	requestPermission: (params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
): AskAnswerSource {
	const awaitAnswerRequest = async (
		request: AskAnswerRequest,
		signal?: AbortSignal,
	): Promise<AskAnswerSourceResult> => {
		if (signal?.aborted) return undefined;
		if (request.interaction !== "selector") return undefined;
		// AskTool appends its synthetic "Other"/clarification transition entries
		// at the end; a free-text editor this channel cannot complete. Remove
		// exactly those trailing entries so a legitimate option that happens to
		// share a transition label is preserved and recommendedIndex stays valid.
		const transitionCount =
			typeof request.transitionCount === "number" &&
			Number.isInteger(request.transitionCount) &&
			request.transitionCount > 0
				? Math.min(request.transitionCount, request.options.length)
				: 0;
		const bridgedOptions =
			transitionCount > 0 ? request.options.slice(0, request.options.length - transitionCount) : request.options;
		// An ask with no model-supplied choices leaves only the synthetic
		// transition entries; do not send an unanswerable permission request.
		// An ask with no model-supplied choices leaves only the synthetic
		// transition entries; do not send an unanswerable permission request
		// unless an enabled control can still commit something.
		if (bridgedOptions.length === 0 && !request.controls.some(control => control.enabled)) return undefined;
		const recommendedLabel =
			typeof request.recommendedIndex === "number" &&
			Number.isInteger(request.recommendedIndex) &&
			request.recommendedIndex >= 0 &&
			request.recommendedIndex < bridgedOptions.length
				? bridgedOptions[request.recommendedIndex]
				: undefined;
		const selectedOptions = request.selectedOptions;
		const markSelection = selectedOptions !== undefined && selectedOptions.length > 0;
		const choices = new Map<string, AskRemoteInteraction>();
		const options: Array<Record<string, unknown>> = bridgedOptions.map((label, index) => {
			const optionId = `option:${index}`;
			choices.set(optionId, { kind: "value", value: label });
			const selected = markSelection && selectedOptions?.includes(label) === true;
			const name = markSelection ? `${selected ? "[x] " : "[ ] "}${label}` : label;
			return {
				optionId,
				name: label === recommendedLabel ? `${name}${RECOMMENDED_SUFFIX}` : name,
				kind: "allow_once",
			};
		});
		for (const control of request.controls) {
			if (!control.enabled) continue;
			const optionId = `control:${control.id}`;
			choices.set(optionId, { kind: "control", controlId: control.id });
			options.push({ optionId, name: control.label, kind: "allow_once" });
		}
		const requestController = new AbortController();
		const onRequestAbort = () => requestController.abort();
		signal?.addEventListener("abort", onRequestAbort, { once: true });
		const {
			promise: requestPromise,
			resolve: resolveRequest,
			reject: rejectRequest,
		} = Promise.withResolvers<unknown>();
		const timeoutTimer =
			request.timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						requestController.abort();
						resolveRequest(undefined);
					}, request.timeoutMs);
		void requestPermission(
			{
				toolCall: {
					toolCallId: crypto.randomUUID(),
					toolName: "ask",
					title: request.question,
					rawInput: { question: request.question },
				},
				options,
			},
			requestController.signal,
		).then(
			value => {
				resolveRequest(value);
			},
			error => {
				rejectRequest(error);
			},
		);
		const askTimeoutError = Object.assign(new Error("ask timed out"), { code: GJC_ASK_TIMEOUT_CODE });
		let response: unknown;
		try {
			response = await requestPromise;
		} catch (error) {
			if (requestController.signal.aborted && !signal?.aborted) throw askTimeoutError;
			throw error;
		} finally {
			if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
			signal?.removeEventListener("abort", onRequestAbort);
		}
		if (signal?.aborted) return undefined;
		// The configured ask timeout elapsed with no answer: throw the marked
		// timeout error so the ask tool distinguishes it from a genuine
		// cancellation (which must never auto-select) and its own
		// auto-selection-on-timeout policy stays authoritative.
		if (requestController.signal.aborted) throw askTimeoutError;
		if (!isRecord(response)) return undefined;
		// ACP clients (e.g. Paseo) return `{ outcome: { outcome, optionId } }`;
		// accept the flat legacy shape as well.
		const outcome = isRecord(response.outcome) ? response.outcome : response;
		if (outcome.outcome === "cancelled") return undefined;
		if (outcome.outcome !== "selected" || typeof outcome.optionId !== "string") return undefined;
		const interaction = choices.get(outcome.optionId);
		if (!interaction) return undefined;
		if (interaction.kind === "value") return interaction.value;
		let settled: Promise<AskSettlementResult> | undefined;
		return {
			source: "remote",
			interaction,
			settle(settlement) {
				if (!settled) {
					settled = Promise.resolve(
						settlement.kind === "commit"
							? { kind: "committed", ack: { status: "failed", reason: "unsupported" } }
							: settlement.kind === "invalid"
								? { kind: "invalid_closed" }
								: { kind: "resolved_without_commit" },
					);
				}
				return settled;
			},
		};
	};
	return {
		async awaitAnswer(question, options, signal) {
			const answer = await awaitAnswerRequest({ question, options, interaction: "selector", controls: [] }, signal);
			if (!answer || typeof answer === "string") return answer;
			return answer.interaction.kind === "value" ? answer.interaction.value : undefined;
		},
		awaitAnswerRequest,
	};
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
					recommendedIndex: request.recommendedIndex,
					// The ask tool owns the multi-select loop and re-issues one request per
					// toggle; carrying its selection here is what makes the toggle visible
					// on a remote transport instead of an identical repeated prompt.
					multi: request.multi === true,
					allowEmpty: false,
					selectedOptions: [...(request.selectedOptions ?? [])],
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

function hasTerminalArbitrationCapability(
	workflowGate: WorkflowGateEmitter | undefined,
): workflowGate is WorkflowGateEmitter &
	Required<
		Pick<
			WorkflowGateEmitter,
			| "resolveGate"
			| "recoverAcceptedGates"
			| "lookupCompletedResolution"
			| "prepareTerminalization"
			| "clearPreparedTerminalization"
			| "registerGateTerminalController"
		>
	> {
	return (
		typeof workflowGate?.resolveGate === "function" &&
		typeof workflowGate.recoverAcceptedGates === "function" &&
		typeof workflowGate.lookupCompletedResolution === "function" &&
		typeof workflowGate.prepareTerminalization === "function" &&
		typeof workflowGate.clearPreparedTerminalization === "function" &&
		typeof workflowGate.registerGateTerminalController === "function"
	);
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
	settings: Settings | undefined = undefined,
	turnResultLookup: (selector: {
		kind: "prompt" | "skill";
		commandId?: string;
		turnId?: string;
		clientRef?: string;
	}) => unknown = () => ({ status: "unknown" }),
	steerStatusLookup: (selector: { commandId?: string; turnId?: string; clientRef?: string }) => unknown = () => ({
		status: "unknown",
	}),
	getRuntimeHost: () => SessionSdkHost | undefined = () => undefined,
): SessionSurface {
	return createSdkSurfaceFactory({
		ctx,
		id,
		api,
		getInstalledDefinitions,
		getLiveState,
		configOverrides,
		settings,
		turnResultLookup,
		steerStatusLookup,
		hostTools: () => getInstalledDefinitions("host_tools") !== undefined,
		getRuntimeHost,
	}).query;
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

function captureConfigOverridesShadow(settings: Settings, configOverrides: Map<string, unknown>): Map<string, unknown> {
	const before = new Map<string, unknown>();
	for (const key of configOverrides.keys()) {
		try {
			before.set(key, settings.get(key as never));
		} catch {
			before.set(key, undefined);
		}
	}
	return before;
}

function reconcileConfigOverridesShadow(
	settings: Settings,
	configOverrides: Map<string, unknown>,
	before: ReadonlyMap<string, unknown>,
): void {
	for (const [key, prior] of before) {
		let current: unknown;
		try {
			current = settings.get(key as never);
		} catch {
			current = undefined;
		}
		if (!deepStructuralEqual(current, prior)) configOverrides.delete(key);
	}
}

function deepStructuralEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) && Array.isArray(right))
		return left.length === right.length && left.every((value, index) => deepStructuralEqual(value, right[index]));
	if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const leftKeys = Object.keys(leftRecord);
	const rightKeys = Object.keys(rightRecord);
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every(key => deepStructuralEqual(leftRecord[key], rightRecord[key]))
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
		clientRef?: string,
		trackReconciliation?: boolean,
		preflightAbort?: () => void | Promise<void>,
		reconciliationKind?: ReconciliationKind,
		sdkRunToken?: string,
	) => void | Promise<void> = () => {},
	onPromptFailed: (
		correlation: { commandId: string; turnId: string },
		error: unknown,
	) => void | Promise<void> = () => {},
	onPromptAcceptFailed: (correlation: { commandId: string; turnId: string }) => void = () => {},
	acceptGateResolution: () => boolean,
	trackGateResolution: <T>(resolution: Promise<T>) => Promise<T>,
	admitPrompt: (clientRef?: string) => void,
	releasePromptAdmission: (clientRef?: string) => void,
	awaitReconciliationReady: () => Promise<void> = async () => {},
	settings?: Settings,
	configOverrides: Map<string, unknown> = new Map(),
	configRevision: { current: number } = { current: 0 },
	abortOwnedPrompt: (
		connectionId: string | undefined,
	) => Promise<{ aborted: true; disposition: "cancelled" | "already_terminal" | "idle" }> = async () => ({
		aborted: true,
		disposition: "idle",
	}),
	abortTerminalPrompt: (
		connectionId: string | undefined,
		scope: AbortScope,
		idempotencyKey?: string,
		preflightCancel?: {
			hasPending: () => boolean;
			cancel: () => void;
		},
		// True only when NO OTHER connection has a pending preflight admission;
		// the session-wide preflight seam must not be invoked while another
		// connection's active preflight could be cancelled by it (review P1).
		noOtherConnectionPreflights?: () => boolean,
	) => Promise<
		| {
				ok: true;
				outcome:
					| "stopped"
					| "stopped_owned"
					| "no_active_turn"
					| "already_terminal"
					| "no_store"
					| "no_effect"
					| "no_effect_replay"
					| "pending_replay"
					| "uncertain_replay";
				stored?: { responseState: string; responsePayloadHash: string; terminalPublished: boolean };
		  }
		| { ok: false; reason: "worker_unsettled" | "owned_unsettled" | "conflict" | "reservation_failed" }
	> = async () => ({ ok: true, outcome: "no_active_turn" }),
	skillRecon?: {
		admit: (clientRef?: string) => void;
		release: (clientRef?: string) => void;
		noteAccepted: (
			correlation: { commandId: string; turnId: string },
			clientRef?: string,
			extra?: { skillName?: string },
		) => Promise<void>;
		cancel: (correlation: { commandId: string; turnId: string }) => Promise<void>;
		noteTransition: (
			correlation: { commandId: string; turnId: string } | undefined,
			frame:
				| { type: "agent_start" | "agent_end"; content?: TurnResultContent }
				| { type: "agent_failed"; error: unknown; content?: TurnResultContent },
		) => Promise<void>;
		lookup: (selector: { commandId?: string; turnId?: string; clientRef?: string }) => unknown;
		reserveSteer?: KindAwareReconciliation["reserveSteer"];
		settleSteer?: KindAwareReconciliation["settleSteer"];
	},
	terminalAbortSeams?: {
		getTerminalTurnEpoch: () => number | undefined;
		cancelPendingPreflightForTerminalAbort: () => void;
		captureTerminalAbortSteeringSnapshot?: () => void;
		discardTerminalAbortSteeringSnapshot?: (token: number) => void;
		rebindTerminalAbortSteeringSnapshot?: (token: number) => void;
	},
	// #4743: registers fire-and-forget reconciliation producers (accepted
	// executions and post-response publications) so session teardown can join
	// them before reporting durable quiescence.
	trackReconciliationProducer?: (producer: Promise<unknown>) => void,
): ControlSurface & {
	cancelPendingPreflights(): Promise<void>;
	cancelPendingPreflightsForConnection(connectionId: string): Promise<void>;
} {
	const unavailable = (operation: string, reason: string) => () => {
		throw Object.assign(new Error(`${operation} is unavailable: ${reason}`), { code: "unavailable" });
	};
	const bindings = new Set(ctx.sdkBindings?.() ?? []);
	const surfacePolicy = createSdkSurfaceFactory({
		ctx,
		id: ctx.sessionManager.getSessionId(),
		api,
	}).policy;
	const missingExpectedSessionAudits = new Set<"workflow.gate_answer" | "workflow.plan_approve">();
	const auditMissingExpectedSessionId = (operation: "workflow.gate_answer" | "workflow.plan_approve") => {
		if (missingExpectedSessionAudits.has(operation)) return;
		missingExpectedSessionAudits.add(operation);
		logger.warn("workflow_control_missing_expected_session_id", { operation });
	};
	const reconcileUnknownGateFailure = (
		workflowGate: WorkflowGateEmitter,
		gateId: string,
	): "pending" | "terminal" | "unavailable" => {
		const pending = workflowGate.listPendingGates;
		if (!pending) return "unavailable";
		try {
			return pending().some(gate => gate.gate_id === gateId) ? "pending" : "terminal";
		} catch {
			logger.warn("workflow_gate_reconciliation_unavailable", { gateId });
			return "unavailable";
		}
	};
	const reconcileDirectControlFailure = (workflowGate: WorkflowGateEmitter, gateId: string): DirectControlOutcome => {
		const durable = reconcileUnknownGateFailure(workflowGate, gateId);
		if (durable === "pending") return "rejected";
		if (durable === "terminal") return "accepted";
		try {
			workflowGate.quarantineGate?.(gateId);
		} catch {
			// The local arbiter still fails closed when the durable fence is unavailable.
		}
		return "unknown";
	};
	const sendSteer = async (text: string, clientRef?: string) => {
		if (clientRef === undefined) {
			const correlation = { commandId: crypto.randomUUID(), turnId: crypto.randomUUID() };
			await api.sendUserMessage(text, { deliverAs: "steer" });
			return { ...correlation, accepted: true };
		}
		const normalizedClientRef = clientRef.trim();
		if (!skillRecon?.reserveSteer || !skillRecon.settleSteer)
			throw Object.assign(new Error("Steer reconciliation is unavailable."), { code: "unavailable" });
		const reservation = await skillRecon.reserveSteer(normalizedClientRef, text);
		if (reservation.replay) return { sessionId: ctx.sessionManager.getSessionId(), ...reservation.result };
		try {
			await api.sendUserMessage(text, { deliverAs: "steer" });
			return {
				sessionId: ctx.sessionManager.getSessionId(),
				...(await skillRecon.settleSteer(normalizedClientRef, "accepted")),
			};
		} catch (error) {
			return {
				sessionId: ctx.sessionManager.getSessionId(),
				...(await skillRecon.settleSteer(normalizedClientRef, "rejected", error)),
			};
		}
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
	/**
	 * `config.patch` records patched values in `configOverrides` so query
	 * readback shows them, but a serialized activation that rewrites the same
	 * setting (e.g. `modelRoles` cleared by persist-default activation) does not
	 * touch the shadow — leaving `config.list/get` reporting a stale patch as
	 * authoritative. After the admitted mutation completes, drop any shadowed
	 * key whose live settings value changed so the durable value wins.
	 */

	/**
	 * Route a synthetic `gajae-code/<profile>` model selection into the
	 * session-scoped activation transaction. ACP model selection never writes a
	 * global profile default; persistence remains an explicit TUI choice. Only
	 * an absent or `off` thinking level is forwarded (synthetic rows advertise
	 * `validLevels: ["off"]`); any other level is rejected before admission.
	 * A user-defined provider under the reserved namespace fails closed rather
	 * than being shadowed. With a thinking level, the typed host surface returns
	 * the pinned `DefaultModelSelectionResult`-shaped result.
	 */
	const setSyntheticModel = async (id: string, requestedThinkingLevel: unknown) => {
		const hasLevel = requestedThinkingLevel !== undefined;
		const thinkingLevel =
			typeof requestedThinkingLevel === "string" ? parseThinkingLevel(requestedThinkingLevel) : undefined;
		if (
			hasLevel &&
			(!thinkingLevel || thinkingLevel === ThinkingLevel.Inherit || thinkingLevel !== ThinkingLevel.Off)
		)
			throw syntheticModelInputError('model.set thinkingLevel for a synthetic profile must be "off".');
		const profiles = ctx.modelRegistry.getModelProfiles();
		const resolved = resolveSyntheticModelSelection(id, profiles, ctx.modelRegistry.getError?.());
		if (syntheticNamespaceCollision(ctx.modelRegistry.getAll(), ctx.modelRegistry.getConfiguredProviderIds?.() ?? []))
			throw syntheticModelInputError(
				`The ${SYNTHETIC_PROVIDER_ID} namespace is reserved; synthetic preset selection is disabled while a provider of the same name is configured.`,
			);
		const setDefaultModelProfile = ctx.setDefaultModelProfile;
		if (!bindings.has("setDefaultModelProfile") || !setDefaultModelProfile)
			return unavailable("model.set", "no default model-profile seam is installed")();
		await setDefaultModelProfile(resolved.canonicalName, {
			persistDefault: false,
			...(hasLevel ? { thinkingLevelOverride: ThinkingLevel.Off } : {}),
		});
		return hasLevel
			? {
					provider: SYNTHETIC_PROVIDER_ID,
					modelId: resolved.canonicalName,
					thinkingLevel: ThinkingLevel.Off,
				}
			: { changed: true };
	};
	const unavailablePerSession = (operation: string) =>
		unavailable(operation, "the registry classifies it outside the per-session extension host");
	const typed = (operation: string, input: Record<string, unknown> = {}) => {
		if (!bindings.has("sdkControl") || !ctx.sdkControl)
			return unavailable(operation, "no typed session seam is installed")();
		return ctx.sdkControl(operation, input);
	};
	const pendingPreflightCancellations = new Map<string, { connectionId?: string; cancel: () => Promise<void> }>();
	const preflightKey = (connectionId: string | undefined, correlation: { commandId: string; turnId: string }) =>
		`${connectionId ?? ""}\0${correlation.commandId}\0${correlation.turnId}`;
	const cancelPendingPreflights = async () => {
		await Promise.all([...pendingPreflightCancellations.values()].map(async entry => await entry.cancel()));
	};
	const cancelPendingPreflightsForConnection = async (connectionId: string) => {
		await Promise.all(
			[...pendingPreflightCancellations.values()]
				.filter(entry => entry.connectionId === connectionId)
				.map(async entry => await entry.cancel()),
		);
	};
	const isSessionBusy = () => isBusy() || ctx.isIdle?.() === false;
	const awaitAbortReady = async () => {
		await cancelPendingPreflights();
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
		clientRef?: string,
		trackReconciliation = false,
	) => {
		const trimmedClientRef = typeof clientRef === "string" ? clientRef.trim() : undefined;
		if (clientRef !== undefined && (!trimmedClientRef || trimmedClientRef.length > PROMPT_CLIENT_REF_MAX_LENGTH))
			throw Object.assign(new Error("clientRef must be a non-empty string of at most 128 characters."), {
				code: "invalid_input",
			});
		if (trackReconciliation) {
			// Restart recovery must be committed before a tracked prompt reserves capacity,
			// otherwise it can admit against pre-hydration state or a lost clientRef.
			try {
				await awaitReconciliationReady();
			} catch {
				throw Object.assign(new Error("Prompt reconciliation state is unavailable; retry after restart."), {
					code: "unavailable",
				});
			}
			admitPrompt(trimmedClientRef);
		}
		try {
			if (forceFresh && isSessionBusy()) {
				throw Object.assign(
					new Error("Previous turn did not finish aborting before replacement prompt submission."),
					{
						code: "busy",
					},
				);
			}
			if (rejectWhenBusy && isSessionBusy())
				throw Object.assign(
					new Error("turn.prompt is unavailable while the agent is busy; use turn.steer explicitly."),
					{
						code: "busy",
					},
				);
		} catch (error) {
			if (trackReconciliation) releasePromptAdmission(trimmedClientRef);
			throw error;
		}
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
		const sdkRunToken = deliverAs === "followUp" ? crypto.randomUUID() : undefined;
		type PreflightTerminalResult = { status: "accepted" } | { status: "rejected"; error: unknown };
		const preflight = Promise.withResolvers<PreflightTerminalResult>();
		const preflightController = new AbortController();
		const cancellationError = Object.assign(new Error("Prompt preflight was cancelled before execution."), {
			code: "busy",
		});
		let preflightSettled = false;
		let accepting = false;
		let accepted = false;
		let submission: Promise<void> | undefined;
		const submissionSettled = Promise.withResolvers<void>();
		let cancellation: Promise<void> | undefined;
		const correlation = { commandId, turnId };
		const key = preflightKey(requesterConnectionId, correlation);
		const settlePreflight = (result: PreflightTerminalResult) => {
			if (preflightSettled) return;
			preflightSettled = true;
			preflight.resolve(result);
		};
		// This is retained by the accepted durable record. It settles only this
		// submission; terminal authority remains with the pending cancellation owner.
		const settleSubmission = async () => {
			preflightController.abort();
			await submissionSettled.promise;
		};
		const cancelPreflight = () => {
			cancellation ??= (async () => {
				preflightController.abort();
				if (!accepting) settlePreflight({ status: "rejected", error: cancellationError });
				const ownedCancellation = await abortOwnedPrompt(requesterConnectionId);
				if (ownedCancellation.disposition === "idle") await settleSubmission();
			})();
			return cancellation;
		};
		pendingPreflightCancellations.set(key, {
			connectionId: requesterConnectionId,
			cancel: cancelPreflight,
		});
		const settleAccepted = async () => {
			if (preflightSettled) return;
			accepting = true;
			try {
				await onPromptAccepted(
					correlation,
					requesterConnectionId,
					trimmedClientRef,
					trackReconciliation,
					settleSubmission,
					"prompt",
					sdkRunToken,
				);
			} catch (error) {
				accepting = false;
				// Durable acceptance failed, so the prompt was never accepted: reject the
				// control preflight and rethrow so the awaiting session does not execute it.
				onPromptAcceptFailed(correlation);
				settlePreflight({ status: "rejected", error });
				throw error;
			}
			accepting = false;
			accepted = true;
			// #4743: an accepted run owns a durable terminal publication when it
			// settles; teardown joins it via this latch (never-accepted preflights
			// produce no durable write and stay unjoined by design).
			trackReconciliationProducer?.(submissionSettled.promise);
			pendingPreflightCancellations.delete(key);
			settlePreflight({ status: "accepted" });
			if (preflightController.signal.aborted) throw cancellationError;
		};
		// Durable fence preferred; keep legacy onPreflightAccepted for hosts/tests that only fire the sync hook.
		const onPreflightAcceptCommit = settleAccepted;
		const onPreflightAccepted = () => {
			// Legacy fire-and-forget hook: the rejection is already reported through the
			// preflight promise, so swallow it here instead of leaking an unhandled rejection.
			void settleAccepted().catch(() => {});
		};
		// Do not acknowledge the prompt until AgentSession's async preflight
		// succeeds. The terminal result records correlation before agent_start can fire.
		try {
			submission = Promise.resolve(
				api.sendUserMessage(content, {
					...(deliverAs ? { deliverAs } : !forceFresh && isBusy() ? { deliverAs: "steer" as const } : {}),
					onPreflightAcceptCommit,
					onPreflightAccepted,
					preflightSignal: preflightController.signal,
					...(sdkRunToken ? { sdkRunToken } : {}),
				}),
			);
		} catch (error) {
			submissionSettled.resolve();
			if (accepted && !preflightController.signal.aborted)
				trackReconciliationProducer?.(Promise.resolve(onPromptFailed(correlation, error)));
			else settlePreflight({ status: "rejected", error });
		}
		if (submission) {
			// #4743: the continuation may settle long after teardown (a cancelled
			// preflight stays pending forever by design), so the EXECUTION is never
			// joined — only its reconciliation publications are tracked below.
			void submission.then(
				() => {
					if (!accepted)
						settlePreflight({
							status: "rejected",
							error: Object.assign(new Error("Prompt submission completed without preflight acceptance."), {
								code: "busy",
							}),
						});
					submissionSettled.resolve();
				},
				error => {
					if (accepted && !preflightController.signal.aborted)
						trackReconciliationProducer?.(Promise.resolve(onPromptFailed(correlation, error)));
					else settlePreflight({ status: "rejected", error });
					submissionSettled.resolve();
				},
			);
		}
		try {
			const result = await preflight.promise;
			if (result.status === "rejected") throw result.error;
			return { commandId, turnId, accepted: true, ...(trimmedClientRef ? { clientRef: trimmedClientRef } : {}) };
		} catch (error) {
			if (trackReconciliation) releasePromptAdmission(trimmedClientRef);
			throw error;
		} finally {
			pendingPreflightCancellations.delete(key);
		}
	};
	const surface: ControlSurface & {
		cancelPendingPreflights(): Promise<void>;
		cancelPendingPreflightsForConnection(connectionId: string): Promise<void>;
	} = {
		prompt: (text, images, clientRef) =>
			submitPrompt(text, images, false, undefined, true, controlRequesterContext.getStore(), clientRef, true),
		steer: (text, clientRef) => sendSteer(text, clientRef),
		followUp: text => submitPrompt(text, undefined, false, "followUp", false, controlRequesterContext.getStore()),
		abort: async () => {
			const requesterConnectionId = controlRequesterContext.getStore();
			const pendingPreflight = [...pendingPreflightCancellations.values()].some(
				entry => entry.connectionId === requesterConnectionId,
			);
			if (pendingPreflight) {
				// Fire-and-forget the cancel: the preflight signal is aborted
				// immediately (synchronously inside cancelPreflight), but the
				// full cleanup (settleRun awaiting executionSettled) may be
				// gated by a durable acceptance commit that this same abort
				// path fences. Awaiting it would deadlock. The response is
				// published once the pending writes settle.
				if (requesterConnectionId) void cancelPendingPreflightsForConnection(requesterConnectionId);
				else void cancelPendingPreflights();
				return { aborted: true, disposition: "preflight_cancelled" };
			}
			return await abortOwnedPrompt(requesterConnectionId);
		},
		abortTerminal: async (input, idempotencyKey) => {
			// Terminal abort (C04 mode:"terminal", approved plan): stop the root
			// worker's current turn and block only its own continuation routes.
			// Left-running owned work (background Bash/task jobs, detached
			// subagents) keeps running and its completions are delivered normally
			// through the existing followUp/prompt path as a fresh turn — owned
			// delivery is intentionally NOT suppressed.
			const requesterConnectionId = controlRequesterContext.getStore();
			// Capture the requester's preflight entries AT ADMISSION: a successor
			// prompt pipelined by the same connection while the abort awaits must
			// never be cancelled as part of this abort (review thread P1).
			const capturedRequesterPreflights = requesterConnectionId
				? [...pendingPreflightCancellations.values()].filter(entry => entry.connectionId === requesterConnectionId)
				: [...pendingPreflightCancellations.values()].filter(entry => entry.connectionId === undefined);
			const cancelCapturedPreflights = () => {
				for (const entry of capturedRequesterPreflights) entry.cancel();
			};
			// Preflight cancellation happens INSIDE abortTerminalPrompt, AFTER the
			// durable admission/replay decision: a no-store request or a same-key
			// replay/conflict must NOT cancel a pending prompt — only a newly
			// admitted abort may (review thread P2).
			const scope: AbortScope = input.scope === "owned" ? "owned" : "turn";
			const outcome = await abortTerminalPrompt(
				requesterConnectionId,
				scope,
				idempotencyKey,
				{
					hasPending: () => capturedRequesterPreflights.length > 0,
					cancel: cancelCapturedPreflights,
				},
				// The seam cancels the SESSION-WIDE preflight controller; the
				// internal per-connection map lets the queued requester's abort
				// verify no OTHER connection has a pending admission before
				// invoking it (review thread P1).
				() =>
					![...pendingPreflightCancellations.values()].some(entry => entry.connectionId !== requesterConnectionId),
			);
			// Preflight cancellation happens ONLY for a NEWLY ADMITTED abort,
			// after the durable admission/replay decision inside
			// abortTerminalPrompt: a no-store request or a same-key
			// replay/conflict must never cancel a pending prompt (review
			// thread P2). A turn.prompt still in PREFLIGHT has no
			// promptSubmissions entry, so the new no-active abort cancels the
			// connection's pending preflights and invalidates the underlying
			// session preflight — otherwise the prompt could start after this
			// abort.
			// Treat ANY outcome carrying the durable replay marker as a
			// non-admission: after the in-memory dispatch entry expires or a
			// restart, a SUCCESSFUL replay returns stopped/stopped_owned with
			// `stored`, and cancelling the requester's unrelated in-preflight
			// prompt there would give an idempotency replay real effects (review
			// thread P1). Only a newly admitted abort may cancel preflights.
			const outcomeIsNewAdmission =
				outcome.ok &&
				outcome.stored === undefined &&
				outcome.outcome !== "no_store" &&
				outcome.outcome !== "no_effect";
			if (outcomeIsNewAdmission && capturedRequesterPreflights.length > 0) {
				// Cancel ONLY the preflight entries captured when the abort was
				// admitted: a successor prompt pipelined by the same connection
				// while the abort was completing must never be cancelled as part of
				// this abort (review thread P1). The session seam stays
				// requester-gated so an unrelated connection's prompt is not
				// failed: it cancels the SESSION-WIDE preflight controller, so it
				// is invoked only when no OTHER connection has a pending admission
				// (review thread P1).
				cancelCapturedPreflights();
				const otherConnectionPreflights = [...pendingPreflightCancellations.values()].some(
					entry => entry.connectionId !== requesterConnectionId,
				);
				if (!otherConnectionPreflights) terminalAbortSeams?.cancelPendingPreflightForTerminalAbort?.();
			}
			if (!outcome.ok && outcome.reason === "conflict") {
				// Throw a typed control error instead of returning a nested result
				// so dispatchControl produces a TOP-LEVEL ok:false response with
				// code idempotency_conflict (the generic cache does the same for
				// in-cache conflicts; this path covers the evicted/restart case).
				throw new TypedControlError("idempotency_conflict", "Idempotency key was reused with different input.");
			}
			if (!outcome.ok) {
				return {
					ok: true,
					selection: scope,
					turn: "uncertain",
					ownedWork: scope === "turn" ? "left_running" : "uncertain",
					automaticDelivery: scope === "turn" ? "enabled" : "none",
					resumeOnOwnedCompletion: scope === "turn",
					reason: outcome.reason,
				};
			}
			if (outcome.outcome === "no_active_turn" || outcome.outcome === "already_terminal") {
				// No active root turn to stop: process-local no-effect, no fence.
				return {
					ok: true,
					selection: scope,
					turn: "no_active_turn",
					terminal: "terminal_no_effect",
					...(outcome.stored ? { replay: outcome.stored } : {}),
				};
			}
			if (outcome.outcome === "no_store") {
				// No file-backed reconciliation owner: terminal admission is gated
				// off before any fence/stop/cleanup (plan AC 5).
				return {
					ok: true,
					selection: scope,
					turn: "no_store",
					terminal: "terminal_no_effect",
				};
			}
			if (outcome.outcome === "no_effect") {
				// Initial marker could not be persisted before any destructive work
				// (AC 10): process-local no-effect, no fence, no stop. A
				// marker-failure reservation replays through this same outcome, so
				// one idempotency key always returns the same result after
				// eviction/restart.
				return {
					ok: true,
					selection: scope,
					turn: "no_effect",
					terminal: "terminal_no_effect",
					...(outcome.stored ? { replay: outcome.stored } : {}),
				};
			}
			if (outcome.outcome === "no_effect_replay") {
				// Durable idle/already-terminal reservation replayed: exact
				// no_active_turn, so a same-key retry after eviction/restart never
				// aborts an unrelated later turn.
				return {
					ok: true,
					selection: scope,
					turn: "no_active_turn",
					terminal: "terminal_no_effect",
					...(outcome.stored ? { replay: outcome.stored } : {}),
				};
			}
			if (outcome.outcome === "pending_replay" || outcome.outcome === "uncertain_replay") {
				// A crashed or restart-settled attempt left a non-stopped durable
				// marker (AC 4/41): replay safe uncertainty without re-running the
				// stop/cleanup/event, carrying the stored immutable row.
				return {
					ok: true,
					selection: scope,
					turn: "uncertain",
					ownedWork: scope === "turn" ? "left_running" : "uncertain",
					automaticDelivery: scope === "turn" ? "enabled" : "none",
					resumeOnOwnedCompletion: scope === "turn",
					reason: outcome.outcome === "pending_replay" ? "replay_pending" : "replay_uncertain",
					...(outcome.stored ? { replay: outcome.stored } : {}),
				};
			}
			if (outcome.outcome === "stopped_owned") {
				// scope:"owned" stopped the exact captured owned work and proved
				// quiescence (every captured generation/entry terminal); stopped
				// work can never resume the agent.
				return {
					ok: true,
					selection: "owned",
					turn: "stopped",
					ownedWork: "stopped",
					automaticDelivery: "none",
					resumeOnOwnedCompletion: false,
					...(outcome.stored ? { replay: outcome.stored } : {}),
				};
			}
			return {
				ok: true,
				selection: "turn",
				turn: "stopped",
				ownedWork: "left_running",
				automaticDelivery: "enabled",
				resumeOnOwnedCompletion: true,
				...(outcome.stored ? { replay: outcome.stored } : {}),
			};
		},
		abortAndPrompt: async text => {
			await awaitAbortReady();
			return await submitPrompt(text, undefined, true, undefined, false, controlRequesterContext.getStore());
		},
		cancelPendingPreflights,
		cancelPendingPreflightsForConnection,
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
		answerGate: async (id, response, expectedSessionId, idempotencyKey) => {
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
			const workflowGate = ctx.workflowGate;
			if (!hasTerminalArbitrationCapability(workflowGate))
				throw Object.assign(new Error("Workflow gates are unavailable for this session."), {
					code: "resource_gone",
				});
			const gateResponse = {
				gate_id: id,
				answer: response,
				idempotency_key: idempotencyKey ?? id,
			};
			const completed = workflowGate.lookupCompletedResolution(gateResponse);
			if (completed.kind === "completed") return completed.resolution;
			if (completed.kind === "accepted_incomplete") {
				await trackGateResolution(workflowGate.recoverAcceptedGates());
				const recovered = workflowGate.lookupCompletedResolution(gateResponse);
				if (recovered.kind === "completed") return recovered.resolution;
				throw Object.assign(new Error("Workflow gate resolution outcome is uncertain."), {
					code: "terminal_uncertain",
				});
			}
			const prepared = presentations.prepareDirectControl(id);
			if (!prepared || prepared.status === "stale")
				throw Object.assign(new Error("Workflow gate is no longer answerable."), { code: "resource_gone" });
			if (prepared.status === "claimed")
				throw Object.assign(new Error("The active action is already being answered."), { code: "action_claimed" });
			if (prepared.status !== "queued" && prepared.status !== "retired")
				throw new Error(`Unexpected direct control preparation: ${prepared.status}`);
			const terminalProof = prepared.status === "retired" ? "retired" : (prepared.terminalProof ?? "not_published");
			if (workflowGate.prepareTerminalization(id, terminalProof) !== true) {
				presentations.finishDirectControl(id, prepared, "rejected");
				throw Object.assign(new Error("Workflow gate lacks a terminalization proof."), { code: "resource_gone" });
			}
			try {
				const resolution = await trackGateResolution(workflowGate.resolveGate(gateResponse));
				const status = (resolution as { status?: unknown }).status;
				if (status === "accepted" || status === "rejected") {
					if (status === "rejected") workflowGate.clearPreparedTerminalization(id);
					presentations.finishDirectControl(id, prepared, status);
					return resolution;
				}
			} catch (error) {
				const outcome = reconcileDirectControlFailure(workflowGate, id);
				if (outcome === "rejected") workflowGate.clearPreparedTerminalization(id);
				presentations.finishDirectControl(id, prepared, outcome);
				if (outcome === "unknown")
					throw Object.assign(new Error("Workflow gate resolution outcome is uncertain."), {
						code: "terminal_uncertain",
					});
				throw error;
			}
			const outcome = reconcileDirectControlFailure(workflowGate, id);
			if (outcome === "rejected") workflowGate.clearPreparedTerminalization(id);
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
			const workflowGate = ctx.workflowGate;
			if (!hasTerminalArbitrationCapability(workflowGate))
				throw Object.assign(new Error("Workflow gates are unavailable for this session."), {
					code: "resource_gone",
				});
			const gateResponse = { gate_id: id, answer: choice, idempotency_key: id };
			const completed = workflowGate.lookupCompletedResolution(gateResponse);
			if (completed.kind === "completed") return completed.resolution;
			if (completed.kind === "accepted_incomplete") {
				await trackGateResolution(workflowGate.recoverAcceptedGates());
				const recovered = workflowGate.lookupCompletedResolution(gateResponse);
				if (recovered.kind === "completed") return recovered.resolution;
				throw Object.assign(new Error("Workflow plan resolution outcome is uncertain."), {
					code: "terminal_uncertain",
				});
			}
			const prepared = presentations.prepareDirectControl(id);
			if (!prepared || prepared.status === "stale")
				throw Object.assign(new Error("Workflow plan is no longer answerable."), { code: "resource_gone" });
			if (prepared.status === "claimed")
				throw Object.assign(new Error("The active action is already being answered."), { code: "action_claimed" });
			if (prepared.status !== "queued" && prepared.status !== "retired")
				throw new Error(`Unexpected direct control preparation: ${prepared.status}`);
			const terminalProof = prepared.status === "retired" ? "retired" : (prepared.terminalProof ?? "not_published");
			if (workflowGate.prepareTerminalization(id, terminalProof) !== true) {
				presentations.finishDirectControl(id, prepared, "rejected");
				throw Object.assign(new Error("Workflow plan lacks a terminalization proof."), { code: "resource_gone" });
			}
			try {
				const resolution = await trackGateResolution(workflowGate.resolveGate(gateResponse));
				const status = (resolution as { status?: unknown }).status;
				if (status === "accepted" || status === "rejected") {
					if (status === "rejected") workflowGate.clearPreparedTerminalization(id);
					presentations.finishDirectControl(id, prepared, status);
					return resolution;
				}
			} catch (error) {
				const outcome = reconcileDirectControlFailure(workflowGate, id);
				if (outcome === "rejected") workflowGate.clearPreparedTerminalization(id);
				presentations.finishDirectControl(id, prepared, outcome);
				if (outcome === "unknown")
					throw Object.assign(new Error("Workflow plan resolution outcome is uncertain."), {
						code: "terminal_uncertain",
					});
				throw error;
			}
			const outcome = reconcileDirectControlFailure(workflowGate, id);
			if (outcome === "rejected") workflowGate.clearPreparedTerminalization(id);
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
		invokeSkill: async (name, args, clientRef) => {
			if (!bindings.has("invokeSkill") || !ctx.invokeSkill)
				return unavailable("skill.invoke", "no skill invocation seam is installed")();

			if (typeof args !== "undefined" && typeof args !== "string")
				throw Object.assign(new Error("skill.invoke args must be a string."), { code: "invalid_input" });
			const trimmedClientRef =
				typeof clientRef === "string" ? clientRef.trim() : clientRef === undefined ? undefined : "";
			if (clientRef !== undefined && (!trimmedClientRef || trimmedClientRef.length > 128))
				throw Object.assign(new Error("clientRef must be a non-empty string of at most 128 characters."), {
					code: "invalid_input",
				});
			const commandId = crypto.randomUUID();
			const turnId = crypto.randomUUID();
			const correlation = { commandId, turnId };
			const requesterConnectionId = controlRequesterContext.getStore();
			if (skillRecon) {
				try {
					await awaitReconciliationReady();
				} catch {
					throw Object.assign(new Error("Skill reconciliation state is unavailable; retry after restart."), {
						code: "unavailable",
					});
				}
				skillRecon.admit(trimmedClientRef);
			}
			const cancellationError = Object.assign(new Error("Skill preflight was cancelled before execution."), {
				code: "busy",
			});
			const preflightController = new AbortController();
			const { promise: acceptedP, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
			let phase: "pending" | "accepting" | "accepted" | "rejected" = "pending";
			let promptOwned = false;
			let durableSkillAccepted = false;
			let admissionReleased = false;
			const releaseAdmission = () => {
				if (admissionReleased || durableSkillAccepted) return;
				admissionReleased = true;
				skillRecon?.release(trimmedClientRef);
			};
			const settleAccept = (value: Record<string, unknown>) => {
				if (phase !== "pending" && phase !== "accepting") return;
				phase = "accepted";
				resolve(value);
			};
			const settleReject = (error: unknown) => {
				if (phase === "accepted" || phase === "rejected") return;
				phase = "rejected";
				reject(error);
			};
			const executionSettled = Promise.withResolvers<void>();
			let cancellation: Promise<void> | undefined;
			const key = preflightKey(requesterConnectionId, correlation);
			// This is retained by the accepted durable record. It settles only this
			// invocation; terminal authority remains with the pending cancellation owner.
			const settleRun = async () => {
				preflightController.abort();
				await executionSettled.promise;
			};
			const cancelPreflight = () => {
				cancellation ??= (async () => {
					preflightController.abort();
					if (phase === "pending") {
						releaseAdmission();
						settleReject(cancellationError);
					}
					const ownedCancellation = await abortOwnedPrompt(requesterConnectionId);
					if (ownedCancellation.disposition === "idle") {
						await settleRun();
						if (durableSkillAccepted && skillRecon) await skillRecon.cancel(correlation);
					}
				})();
				return cancellation;
			};
			pendingPreflightCancellations.set(key, {
				connectionId: requesterConnectionId,
				cancel: cancelPreflight,
			});
			let prepared: { name: string; path: string; lineCount?: number; cleanedArgs?: string } | undefined;
			let run: Promise<unknown>;
			try {
				run = Promise.resolve(
					ctx.invokeSkill(name, args as string | undefined, {
						preflightSignal: preflightController.signal,
						onSkillPrepared: meta => {
							prepared = meta;
						},
						onPreflightAcceptCommit: async () => {
							if (preflightController.signal.aborted) throw cancellationError;
							phase = "accepting";
							const meta = prepared ?? { name: String(name), path: "" };
							const acceptedValue = {
								accepted: true,
								commandId,
								turnId,
								name: meta.name,
								path: meta.path,
								...(meta.lineCount !== undefined ? { lineCount: meta.lineCount } : {}),
								...(meta.cleanedArgs !== undefined ? { args: meta.cleanedArgs } : {}),
								...(trimmedClientRef ? { clientRef: trimmedClientRef } : {}),
							};
							try {
								await onPromptAccepted(
									correlation,
									requesterConnectionId,
									undefined,
									false,
									settleRun,
									"skill",
								);
								promptOwned = requesterConnectionId !== undefined;
								if (skillRecon) {
									await skillRecon.noteAccepted(correlation, trimmedClientRef, { skillName: meta.name });
									durableSkillAccepted = true;
									// #4743: a durably accepted skill owns a terminal
									// publication; teardown joins this latch (bounded by the
									// drain deadline).
									trackReconciliationProducer?.(executionSettled.promise);
								}
							} catch (error) {
								onPromptAcceptFailed(correlation);
								releaseAdmission();
								settleReject(error);
								throw error;
							}
							pendingPreflightCancellations.delete(key);
							settleAccept(acceptedValue);
							if (preflightController.signal.aborted) throw cancellationError;
						},
					}),
				);
			} catch (error) {
				releaseAdmission();
				settleReject(error);
				run = Promise.reject(error);
			}
			// #4743: the skill execution itself may outlive teardown (a cancelled
			// preflight never settles by design), so only its reconciliation
			// PUBLICATIONS are tracked — created synchronously the moment the
			// execution settles, so a publication fired during teardown is always
			// joined before the drain reports quiescence.
			void run.then(
				result => {
					if (phase === "pending") {
						pendingPreflightCancellations.delete(key);
						settleAccept({
							accepted: true,
							commandId,
							turnId,
							...(typeof result === "object" && result ? (result as object) : {}),
							...(trimmedClientRef ? { clientRef: trimmedClientRef } : {}),
						});
					} else if (durableSkillAccepted && skillRecon) {
						trackReconciliationProducer?.(
							skillRecon.noteTransition(correlation, {
								type: "agent_end",
								...(typeof result === "string"
									? { content: { version: 1, type: "text", text: result, byteLength: 0, truncated: false } }
									: {}),
							}),
						);
					}
					executionSettled.resolve();
				},
				error => {
					if (phase === "pending" || phase === "accepting") {
						releaseAdmission();
						settleReject(error);
					} else if (phase === "accepted" && promptOwned && !preflightController.signal.aborted) {
						trackReconciliationProducer?.(Promise.resolve(onPromptFailed(correlation, error)));
					}
					if (durableSkillAccepted && skillRecon && !preflightController.signal.aborted)
						trackReconciliationProducer?.(
							skillRecon.noteTransition(correlation, { type: "agent_failed", error }),
						);
					executionSettled.resolve();
				},
			);
			try {
				return await acceptedP;
			} finally {
				pendingPreflightCancellations.delete(key);
			}
		},
		setPlanMode: async on => {
			if (!bindings.has("setPlanMode") || !ctx.setPlanMode)
				return unavailable("mode.plan.set", "no plan-mode seam is installed")();

			if (typeof on !== "boolean")
				throw Object.assign(new Error("mode.plan.set requires a boolean on value."), { code: "invalid_input" });

			return { state: await ctx.setPlanMode(on) };
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
			if (parseSyntheticModelId(id) !== undefined) return setSyntheticModel(id, requestedThinkingLevel);
			const model = resolveModel(id);
			if (requestedThinkingLevel === undefined) {
				// The extension seam is not admission-bound, so serialize it (and the
				// Q13 shadow capture/reconcile) against config.patch through the
				// session admission boundary.
				const run = async () => {
					const shadowBefore = settings ? captureConfigOverridesShadow(settings, configOverrides) : undefined;
					const changed = await api.setModel(model);
					if (settings && shadowBefore) reconcileConfigOverridesShadow(settings, configOverrides, shadowBefore);
					return { changed };
				};
				return typeof (ctx as Partial<ExtensionContext>).withSdkControlMutation === "function"
					? ctx.withSdkControlMutation!(run)
					: run();
			}
			const thinkingLevel =
				typeof requestedThinkingLevel === "string" ? parseThinkingLevel(requestedThinkingLevel) : undefined;
			if (!thinkingLevel || thinkingLevel === ThinkingLevel.Inherit)
				throw Object.assign(
					new Error("model.set thinkingLevel must be off, minimal, low, medium, high, xhigh, or max."),
					{ code: "invalid_input" },
				);
			// The typed concrete selection already admits internally; run the Q13
			// shadow capture/reconcile inside that same admission via internal
			// hooks so a concurrent config.patch cannot race the snapshot.
			let shadowBefore: Map<string, unknown> | undefined;
			const capture = () =>
				(shadowBefore = settings ? captureConfigOverridesShadow(settings, configOverrides) : undefined);
			const reconcile = () => {
				if (settings && shadowBefore) reconcileConfigOverridesShadow(settings, configOverrides, shadowBefore);
			};
			const result = await typed("model.set", {
				id: `${model.provider}/${model.id}`,
				thinkingLevel,
				...(settings ? { onBeforeMutation: capture, onAfterMutation: reconcile } : {}),
			});
			return result;
		},
		setModelProfile: async id => {
			if (!bindings.has("setModelProfile") || !ctx.setModelProfile)
				return unavailable("model.profile.set", "no model-profile activation seam is installed")();
			if (!id) throw Object.assign(new Error("model.profile.set requires a profile id."), { code: "invalid_input" });
			if (!ctx.modelRegistry.getModelProfile(id))
				throw Object.assign(new Error(`Model profile ${id} was not found.`), { code: "invalid_input" });
			return { changed: await ctx.setModelProfile(id), id };
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
			if (!ctx.setQueueMode(kind as "steering" | "follow_up" | "tool_interrupt", mode))
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
		closeSession: capability =>
			typed(
				"session.close",
				capability === undefined ? {} : { [BROKER_RUNTIME_CLOSE_CAPABILITY_FIELD]: capability },
			),
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
			const patchIssues = validateSettingPatch(patch as Record<string, unknown>);
			if (patchIssues.length > 0) {
				const detail = patchIssues.map(issue => `${issue.path} (${issue.detail})`).join("; ");
				throw Object.assign(new Error(`config.patch rejects invalid settings: ${detail}`), {
					code: "invalid_input",
				});
			}
			if (!settings) return unavailable("config.patch", "configuration settings are unavailable for this session")();
			const applyPatch = async () => {
				const entries = Object.entries(patch as Record<string, unknown>);
				for (const [key, value] of entries) settings.set(key as never, value as never);
				for (const [key, value] of entries) configOverrides.set(key, value);
				configRevision.current += 1;
				return { patched: entries.map(([key]) => key), revision: String(configRevision.current) };
			};
			// Serialize config mutations against synthetic profile activation and
			// default-model selection so an interleaved patch can never be lost or
			// clobbered by an activation rollback (plan criterion 8).
			if (typeof (ctx as Partial<ExtensionContext>).withSdkControlMutation === "function") {
				return ctx.withSdkControlMutation!(applyPatch);
			}
			return applyPatch();
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
		installedOperations: surfacePolicy.installedControls,
		revisionProvider: resource => (resource === "config" ? String(configRevision.current) : undefined),
	};
	return surface;
}

const EPHEMERAL_TURN_DEADLINE_MS = 120_000;
const EPHEMERAL_TURN_TTL_MS = 300_000;
const EPHEMERAL_TURN_MAX_RECORDS = 256;
const EPHEMERAL_TURN_MAX_ACTIVE_PER_SESSION = 2;
const EPHEMERAL_TURN_MAX_RESULT_BYTES = 262_144;

interface EphemeralTurnTuple {
	sessionId: string;
	requestId: string;
	updateId: number;
	messageId: number;
	threadId: string;
}

type EphemeralTurnStatus = "ok" | "busy" | "timeout" | "cancelled" | "session_unavailable" | "failed";

interface EphemeralTurnAuthority {
	sessionId: string;
	endpointDigest: string;
	eventGeneration: number;
}

interface EphemeralTurnEvent {
	tuple: EphemeralTurnTuple;
	authority: EphemeralTurnAuthority;
	status: EphemeralTurnStatus;
	text?: string;
	completedAt: number;
	expiresAt: number;
}

interface EphemeralTurnTombstone {
	tuple: EphemeralTurnTuple;
	authority: EphemeralTurnAuthority;
	status: EphemeralTurnStatus;
	completedAt: number;
	expiresAt: number;
}

interface ActiveEphemeralTurn {
	tuple: EphemeralTurnTuple;
	authority: EphemeralTurnAuthority;
	connectionId: string;
	staleConnectionIds: Set<string>;
	controller: AbortController;
	subscribers: Set<string>;
	deadline: NodeJS.Timeout;
	abortListener: () => void;
}

function ephemeralTuple(frame: Record<string, unknown>): EphemeralTurnTuple | undefined {
	const { sessionId, requestId, updateId, messageId, threadId } = frame;
	return typeof sessionId === "string" &&
		typeof requestId === "string" &&
		typeof updateId === "number" &&
		Number.isSafeInteger(updateId) &&
		typeof messageId === "number" &&
		Number.isSafeInteger(messageId) &&
		messageId > 0 &&
		typeof threadId === "string"
		? { sessionId, requestId, updateId, messageId, threadId }
		: undefined;
}

function sameEphemeralTuple(left: EphemeralTurnTuple, right: EphemeralTurnTuple): boolean {
	return (
		left.sessionId === right.sessionId &&
		left.requestId === right.requestId &&
		left.updateId === right.updateId &&
		left.messageId === right.messageId &&
		left.threadId === right.threadId
	);
}

function ephemeralTupleKey(tuple: EphemeralTurnTuple): string {
	return JSON.stringify([tuple.sessionId, tuple.requestId, tuple.updateId, tuple.messageId, tuple.threadId]);
}

/** Host-owned, bounded idempotency and cancellation lifecycle for v3 side turns. */
export class EphemeralTurnHost {
	#active = new Map<string, ActiveEphemeralTurn>();
	#terminalEvents = new Map<string, EphemeralTurnEvent>();
	#tombstones = new Map<string, EphemeralTurnTombstone>();
	#expiryTimer: NodeJS.Timeout | undefined;
	#disposed = false;
	#enabled = true;
	#now: () => number;
	#sendTo: (connectionId: string, frame: Record<string, unknown>) => void;
	#execute: (question: string, signal: AbortSignal) => Promise<{ replyText: string }>;
	#authority: EphemeralTurnAuthority | undefined;

	constructor(
		sendTo: (connectionId: string, frame: Record<string, unknown>) => void,
		execute: (question: string, signal: AbortSignal) => Promise<{ replyText: string }>,
		now: () => number = Date.now,
	) {
		this.#sendTo = sendTo;
		this.#execute = execute;
		this.#now = now;
	}

	configureAuthority(authority: EphemeralTurnAuthority): void {
		if (this.#authority && !this.#sameAuthority(this.#authority, authority))
			for (const active of [...this.#active.values()]) active.controller.abort("session_unavailable");
		this.#authority = { ...authority };
	}

	disable(): void {
		if (this.#disposed) return;
		this.#enabled = false;
		for (const active of this.#active.values()) active.controller.abort("session_unavailable");
		this.#terminalEvents.clear();
		this.#tombstones.clear();
		if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
		this.#expiryTimer = undefined;
	}

	enable(): void {
		if (!this.#disposed) this.#enabled = true;
	}

	dispose(): void {
		this.#disposed = true;
		for (const active of this.#active.values()) active.controller.abort("session_unavailable");
		if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
		this.#expiryTimer = undefined;
		this.#terminalEvents.clear();
		this.#tombstones.clear();
	}

	handle(connectionId: string, frame: Record<string, unknown>): boolean {
		if (!this.#enabled) return frame.type === "ephemeral_turn" || frame.type === "ephemeral_turn_cancel";
		if (frame.type === "ephemeral_turn") return this.#start(connectionId, frame);
		if (frame.type === "ephemeral_turn_cancel") return this.#cancel(connectionId, frame);
		return false;
	}

	sessionUnavailable(sessionId: string): void {
		for (const active of [...this.#active.values()])
			if (active.tuple.sessionId === sessionId) active.controller.abort("session_unavailable");
	}

	/** Testable event-ring eviction boundary; tombstones remain idempotency authority. */
	evictTerminalEvents(): void {
		this.#terminalEvents.clear();
	}

	#start(connectionId: string, frame: Record<string, unknown>): boolean {
		const tuple = ephemeralTuple(frame);
		const question = typeof frame.question === "string" ? frame.question.trim() : "";
		const authority = this.#authority;
		if (!tuple || !question || !authority || tuple.sessionId !== authority.sessionId) return true;
		this.#purge();
		const key = ephemeralTupleKey(tuple);
		const active = this.#active.get(key);
		if (active) {
			if (!this.#sameAuthority(active.authority, authority)) {
				active.controller.abort("session_unavailable");
				return true;
			}
			if (active.connectionId === connectionId || active.staleConnectionIds.has(connectionId)) return true;
			active.staleConnectionIds.add(active.connectionId);
			active.connectionId = connectionId;
			active.subscribers = new Set([connectionId]);
			return true;
		}
		const event = this.#terminalEvents.get(key);
		if (event) {
			if (this.#sameAuthority(event.authority, authority))
				this.#send(connectionId, event.tuple, event.status, event.text);
			return true;
		}
		const tombstone = this.#tombstones.get(key);
		if (tombstone) {
			if (this.#sameAuthority(tombstone.authority, authority)) this.#send(connectionId, tombstone.tuple, "failed");
			return true;
		}
		for (const candidate of this.#tombstones.values()) {
			if (candidate.tuple.sessionId === tuple.sessionId && candidate.tuple.requestId === tuple.requestId) {
				logger.warn("notifications: ephemeral request id conflict", {
					sessionId: tuple.sessionId,
					requestId: tuple.requestId,
				});
				return true;
			}
		}
		for (const candidate of this.#active.values()) {
			if (candidate.tuple.sessionId === tuple.sessionId && candidate.tuple.requestId === tuple.requestId) {
				logger.warn("notifications: ephemeral request id conflict", {
					sessionId: tuple.sessionId,
					requestId: tuple.requestId,
				});
				return true;
			}
		}
		const activeForSession = [...this.#active.values()].filter(
			candidate => candidate.tuple.sessionId === tuple.sessionId,
		).length;
		if (activeForSession >= EPHEMERAL_TURN_MAX_ACTIVE_PER_SESSION) {
			const completedAt = this.#now();
			this.#finish(key, {
				tuple,
				authority: { ...authority },
				status: "busy",
				completedAt,
				expiresAt: completedAt + EPHEMERAL_TURN_TTL_MS,
			});
			this.#send(connectionId, tuple, "busy");
			return true;
		}
		const controller = new AbortController();
		const abortListener = () => this.#complete(key, this.#abortStatus(controller.signal));
		const record: ActiveEphemeralTurn = {
			tuple,
			authority: { ...authority },
			connectionId,
			controller,
			subscribers: new Set([connectionId]),
			staleConnectionIds: new Set(),
			deadline: setTimeout(() => controller.abort("timeout"), EPHEMERAL_TURN_DEADLINE_MS),
			abortListener,
		};
		this.#active.set(key, record);
		controller.signal.addEventListener("abort", abortListener, { once: true });
		void this.#execute(question, controller.signal).then(
			result =>
				this.#complete(
					key,
					controller.signal.aborted ? this.#abortStatus(controller.signal) : "ok",
					result.replyText,
				),
			() => this.#complete(key, controller.signal.aborted ? this.#abortStatus(controller.signal) : "failed"),
		);
		return true;
	}

	#cancel(connectionId: string, frame: Record<string, unknown>): boolean {
		const tuple = ephemeralTuple(frame);
		const authority = this.#authority;
		if (!tuple || frame.reason !== "daemon_shutdown" || !authority || tuple.sessionId !== authority.sessionId)
			return true;
		const active = this.#active.get(ephemeralTupleKey(tuple));
		if (
			!active ||
			!sameEphemeralTuple(active.tuple, tuple) ||
			active.connectionId !== connectionId ||
			!this.#sameAuthority(active.authority, authority)
		)
			return true;
		active.controller.abort("cancelled");
		return true;
	}

	#abortStatus(signal: AbortSignal): EphemeralTurnStatus {
		return signal.reason === "timeout"
			? "timeout"
			: signal.reason === "session_unavailable"
				? "session_unavailable"
				: "cancelled";
	}

	#sameAuthority(left: EphemeralTurnAuthority, right: EphemeralTurnAuthority): boolean {
		return (
			left.sessionId === right.sessionId &&
			left.endpointDigest === right.endpointDigest &&
			left.eventGeneration === right.eventGeneration
		);
	}

	#complete(key: string, status: EphemeralTurnStatus, text?: string): void {
		const active = this.#active.get(key);
		if (!active) return;
		clearTimeout(active.deadline);
		active.controller.signal.removeEventListener("abort", active.abortListener);
		this.#active.delete(key);
		if (this.#disposed || !this.#enabled) return;
		const terminalTextIsValid =
			typeof text === "string" &&
			text.trim().length > 0 &&
			Buffer.byteLength(text, "utf8") <= EPHEMERAL_TURN_MAX_RESULT_BYTES;
		const terminalStatus = status === "ok" && !terminalTextIsValid ? "failed" : status;
		const completedAt = this.#now();
		const terminal: EphemeralTurnEvent = {
			tuple: active.tuple,
			authority: active.authority,
			status: terminalStatus,
			...(terminalStatus === "ok" ? { text: text ?? "" } : {}),
			completedAt,
			expiresAt: completedAt + EPHEMERAL_TURN_TTL_MS,
		};
		this.#finish(key, terminal);
		for (const connectionId of active.subscribers) {
			try {
				this.#send(connectionId, terminal.tuple, terminal.status, terminal.text);
			} catch {
				// Directed SDK delivery has already logged the disconnected route.
			}
		}
	}

	#finish(key: string, terminal: EphemeralTurnEvent): void {
		this.#terminalEvents.set(key, terminal);
		this.#tombstones.set(key, {
			tuple: terminal.tuple,
			authority: terminal.authority,
			status: terminal.status,
			completedAt: terminal.completedAt,
			expiresAt: terminal.expiresAt,
		});
		this.#purge();
		while (this.#terminalEvents.size > EPHEMERAL_TURN_MAX_RECORDS)
			this.#terminalEvents.delete(this.#terminalEvents.keys().next().value!);
		while (this.#tombstones.size > EPHEMERAL_TURN_MAX_RECORDS) {
			const oldestKey = this.#tombstones.keys().next().value!;
			this.#tombstones.delete(oldestKey);
			this.#terminalEvents.delete(oldestKey);
		}
		this.#scheduleExpiry();
	}

	#send(connectionId: string, tuple: EphemeralTurnTuple, status: EphemeralTurnStatus, text?: string): void {
		this.#sendTo(connectionId, {
			type: "ephemeral_turn_result",
			...tuple,
			status,
			...(status === "ok" ? { text: text ?? "" } : {}),
		});
	}

	#purge(): void {
		const now = this.#now();
		for (const [key, tombstone] of this.#tombstones) {
			if (tombstone.expiresAt > now) continue;
			this.#tombstones.delete(key);
			this.#terminalEvents.delete(key);
		}
	}

	#scheduleExpiry(): void {
		if (this.#disposed) return;
		if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
		const nextExpiry = [...this.#tombstones.values()].reduce(
			(earliest, tombstone) => Math.min(earliest, tombstone.expiresAt),
			Number.POSITIVE_INFINITY,
		);
		if (!Number.isFinite(nextExpiry)) {
			this.#expiryTimer = undefined;
			return;
		}
		this.#expiryTimer = setTimeout(
			() => {
				this.#expiryTimer = undefined;
				if (this.#disposed) return;
				this.#purge();
				this.#scheduleExpiry();
			},
			Math.max(0, nextExpiry - this.#now()),
		);
		this.#expiryTimer.unref();
	}
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
/**
 * Ensures every configured chat-provider daemon is ready.
 *
 * This runs strictly AFTER the SDK publishes session identity and its core
 * endpoint, through the detached ownership coordinator: chat providers are
 * optional notification adapters, never session authority. A rejected ensure
 * therefore degrades notification delivery only — the coordinator records it
 * as `failed`, adapters stay withheld, and a later reconcile re-attempts.
 */
export async function ensureConfiguredProviderDaemons(
	settings: Settings,
	cfg: NotificationConfig,
	ensureProviderDaemon: (provider: "discord" | "slack", settings: Settings) => Promise<unknown> = (
		provider,
		configuredSettings,
	) => (provider === "discord" ? ensureDiscordDaemon(configuredSettings) : ensureSlackDaemon(configuredSettings)),
): Promise<void> {
	if (isProviderEffectivelyEnabled(cfg, "discord")) await ensureProviderDaemon("discord", settings);
	if (isProviderEffectivelyEnabled(cfg, "slack")) await ensureProviderDaemon("slack", settings);
}

/**
 * Classify whether a session identity event must await notification endpoint startup.
 * Only an interactive selector resume may defer this ancillary startup; all other
 * events, including branches and unknown origins, fail closed to awaiting it.
 */
export function shouldAwaitNotificationStartup(event: {
	type: "session_switch" | "session_branch";
	transition?: { origin: string };
}): boolean {
	return event.type !== "session_switch" || event.transition?.origin !== INTERACTIVE_SELECTOR_RESUME_ORIGIN;
}

export function createNotificationsExtension(
	api: ExtensionAPI,
	options: {
		settings?: Settings;
		ensureTelegramDaemon?: (input: { settings: Settings }) => Promise<EnsureDaemonResult>;
		ensureProviderDaemon?: (provider: "discord" | "slack", settings: Settings) => Promise<unknown>;
		/** Suppress auto-delivery for a GJC-spawned child under `sessionScope=primary`. */
		spawnedByGjc?: boolean;
		controller?: NotificationSessionController;
		/** Whether this host mode can own the root SDK endpoint. Default: true. */
		sdkHostModeSupported?: boolean;
		/** In-memory master capability for private broker verification only. */
		masterCapability?: string;
		/** Opaque direct-role epoch this effective host may adopt. */
		masterAttestationEpoch?: string;
		/** Stable master lineage identity retained across session switches/branches. */
		masterOwnerSessionId?: string;
		onSdkRequest?: (kind: "control" | "query", connectionId: string, frame: Record<string, unknown>) => void;
		runBtwTurn?: (question: string, signal: AbortSignal) => Promise<{ replyText: string }>;
		/** Observes settlement of optional session-branch startup after reconciliation completes. */
		onBranchStartupSettled?: (receipt: { sessionId: string; status: SessionStartResult["status"] }) => void;
		readNotificationFile?: (path: string) => Promise<Buffer>;
		readNotificationDiffStat?: (cwd: string) => Promise<string | undefined>;
		/**
		 * INTERNAL terminal-abort session seams, threaded directly from the owning
		 * session — deliberately NOT on the public ExtensionContext so third-party
		 * extensions cannot observe attempt epochs or cancel the session-global
		 * preflight outside the durable admission path (review thread P2).
		 */
		terminalAbortSeams?: {
			getTerminalTurnEpoch: () => number | undefined;
			cancelPendingPreflightForTerminalAbort: () => void;
			captureTerminalAbortSteeringSnapshot?: () => void;
			discardTerminalAbortSteeringSnapshot?: (token: number) => void;
			rebindTerminalAbortSteeringSnapshot?: (token: number) => void;
			abortPromptAndWaitWithTerminal: (
				handle: string,
				options: { graceMs: number; terminal?: { scope: "turn" | "owned"; expectedEpoch?: number } },
			) => Promise<RunSettlementProof>;
		};
	} = {},
): void {
	const terminalAbortSeams = options.terminalAbortSeams;
	const lifecycleStartupCapability = lifecycleStartupCapabilityForApi(api);
	// Telegram session eligibility follows the user's configuration, not how the
	// session happened to be launched. Any session may own a forum topic and
	// receive notifications once Telegram is configured and effectively active;
	// gating this on coordinator/lifecycle provenance silently denied every
	// ordinary interactive session (the daemon refuses an identity header that
	// declares itself ineligible, so nothing was ever delivered).
	const telegramTopicsEnabled = (): boolean => isTelegramSessionEligible(resolveSettings(options.settings).cfg);
	const runtimes = new Map<string, SessionRuntime>();
	const controller =
		options.controller ??
		new NotificationSessionController({
			eligible: true,
			getConfig: () => resolveSettings(options.settings).cfg,
			spawnedByGjc: options.spawnedByGjc,
		});

	// Failed terminal teardown remains fenced from normal runtime lookup while the
	// exact runtime object retains authority for an explicit idempotent retry.
	const cleanupRetries = new Map<string, SessionRuntime>();
	const sessionStartPromises = new Map<string, Promise<SessionStartResult>>();
	const forceIsolatedChatSessions = new Set<string>();
	const branchStartupTasks = new Set<Promise<void>>();
	const sessionLifecycleTasks = new Set<Promise<void>>();
	let activeRuntimeId: string | undefined;
	let identityControlInFlight = false;
	let deferredIdentityRotation:
		| {
				event: { previousSessionFile?: string; transition?: { origin: string } };
				ctx: ExtensionContext;
				awaitStartup: boolean;
		  }
		| undefined;
	let extensionShuttingDown = false;
	const consumedMasterNonces = new Map<string, number>();

	async function ensureTelegramOwner(settings: Settings): Promise<"ready" | "blocked_identity"> {
		if (!telegramTopicsEnabled()) return "blocked_identity";
		if (options.ensureTelegramDaemon) {
			return (await options.ensureTelegramDaemon({ settings })) === "blocked" ? "blocked_identity" : "ready";
		}
		return (await ensureTelegramDaemonRunningDetailed({ settings })) === "blocked_identity"
			? "blocked_identity"
			: "ready";
	}
	type ConfiguredDaemonOwnerResult = "ready" | "blocked_identity" | "blocked_identity_with_sibling";
	async function ensureConfiguredDaemonOwners(
		settings: Settings,
		cfg: NotificationConfig,
	): Promise<ConfiguredDaemonOwnerResult> {
		if (telegramTopicsEnabled() && isProviderEffectivelyEnabled(cfg, "telegram")) {
			const telegramMarker = getCurrentTelegramActivationMarker(cfg);
			if (telegramMarker) {
				if (!isProviderEffectivelyEnabled(cfg, "discord") && !isProviderEffectivelyEnabled(cfg, "slack")) {
					return "blocked_identity";
				}
				await ensureConfiguredProviderDaemons(settings, cfg, options.ensureProviderDaemon);
				return "blocked_identity_with_sibling";
			}
			const telegram = await ensureTelegramOwner(settings);
			if (telegram === "blocked_identity") {
				if (!isProviderEffectivelyEnabled(cfg, "discord") && !isProviderEffectivelyEnabled(cfg, "slack")) {
					return "blocked_identity";
				}
				await ensureConfiguredProviderDaemons(settings, cfg, options.ensureProviderDaemon);
				return "blocked_identity_with_sibling";
			}
		}
		await ensureConfiguredProviderDaemons(settings, cfg, options.ensureProviderDaemon);
		return "ready";
	}

	/**
	 * Single-flight chat-daemon ownership acquisition.
	 *
	 * Chat daemons are optional notification adapters, never session authority,
	 * so NO session-lifecycle path (startSession, reconcile, authority rotation)
	 * may await ownership — a wedged ensure would hold `session/new` open. This
	 * coordinator keeps at most one ensure in flight and exposes it as a
	 * settle-or-pending read: {@link peekDaemonOwnership} answers `undefined`
	 * while an ensure is still running, and callers proceed without it. Exactly
	 * one ensure runs at a time, so two callers can never race two outcomes onto
	 * the same runtime.
	 */
	type DaemonOwnershipOutcome = ConfiguredDaemonOwnerResult | "failed";
	let daemonOwnershipInFlight: { key: string; task: Promise<DaemonOwnershipOutcome> } | undefined;
	let daemonOwnershipSettled: DaemonOwnershipOutcome | undefined;
	let daemonOwnershipSettledKey: string | undefined;

	/**
	 * Identity of the ownership-relevant configuration. A settled outcome is
	 * only reusable while this is unchanged: toggling enablement, credentials,
	 * destination, or the activation marker must force a fresh ensure, while a
	 * delivery-only change (redaction, verbosity) must not.
	 */
	function daemonOwnershipKey(cfg: NotificationConfig): string {
		// Secrets are keyed by non-reversible fingerprint, never by raw value or
		// length: a same-length credential rotation MUST invalidate the outcome.
		const fingerprint = (secret: string | undefined): string | null =>
			secret === undefined || secret.length === 0 ? null : tokenFingerprint(secret);
		return JSON.stringify([
			isProviderEffectivelyEnabled(cfg, "telegram"),
			isProviderEffectivelyEnabled(cfg, "discord"),
			isProviderEffectivelyEnabled(cfg, "slack"),
			fingerprint(cfg.botToken),
			cfg.chatId ?? null,
			fingerprint(cfg.discord.botToken),
			cfg.discord.applicationId ?? null,
			cfg.discord.guildId ?? null,
			cfg.discord.parentChannelId ?? null,
			fingerprint(cfg.slack.botToken),
			fingerprint(cfg.slack.appToken),
			cfg.slack.workspaceId ?? null,
			cfg.slack.channelId ?? null,
			// Slack's inbound actor authorization is part of the daemon's durable
			// identity: rotating the paired user must re-prove ownership, or the
			// previous user keeps command authority through a stale outcome.
			cfg.slack.authorizedUserId ?? null,
			getCurrentTelegramActivationMarker(cfg) ?? null,
			// Redaction and verbosity are ordinarily delivery policy, applied
			// in-process. For Discord/Slack they are also part of the DAEMON's
			// durable identity (chatDaemonIdentity) and are snapshotted into the
			// provider's presentation engine at construction, so only a daemon
			// re-proof can retire a presenter still rendering under the old policy.
			// Key them exactly when such a provider is effective, so a Telegram-only
			// session is not churned by an in-process policy change.
			isProviderEffectivelyEnabled(cfg, "discord") || isProviderEffectivelyEnabled(cfg, "slack")
				? `${String(cfg.redact)}:${cfg.verbosity}`
				: null,
		]);
	}

	function peekDaemonOwnership(cfg: NotificationConfig): DaemonOwnershipOutcome | undefined {
		if (daemonOwnershipInFlight) return undefined;
		return daemonOwnershipSettledKey === daemonOwnershipKey(cfg) ? daemonOwnershipSettled : undefined;
	}

	function kickDaemonOwnership(
		settings: Settings,
		cfg: NotificationConfig,
		onSettled?: (outcome: DaemonOwnershipOutcome, key: string) => void,
	): void {
		const key = daemonOwnershipKey(cfg);
		const existing = daemonOwnershipInFlight;
		// Only an ensure for the SAME configuration can serve this caller. An
		// in-flight ensure for a different key is superseded: its outcome proves
		// nothing about this configuration, and its callbacks are key-checked.
		if (existing && existing.key === key) {
			if (onSettled)
				void existing.task.then(
					outcome => onSettled(outcome, key),
					() => {},
				);
			return;
		}
		daemonOwnershipSettled = undefined;
		daemonOwnershipSettledKey = undefined;
		const task = (async (): Promise<DaemonOwnershipOutcome> => {
			try {
				return await ensureConfiguredDaemonOwners(settings, cfg);
			} catch (error) {
				logger.warn(
					`notifications: provider daemon ownership unavailable; core SDK remains available: ${String(error)}`,
				);
				return "failed";
			}
		})();
		daemonOwnershipInFlight = { key, task };
		void task.then(outcome => {
			if (daemonOwnershipInFlight?.task === task) {
				daemonOwnershipInFlight = undefined;
				daemonOwnershipSettled = outcome;
				daemonOwnershipSettledKey = key;
			}
			onSettled?.(outcome, key);
		});
	}

	/**
	 * Apply one settled ownership outcome to exactly one runtime.
	 *
	 * Four guards keep a late or superseded outcome harmless: the runtime must
	 * still be the registered one for its id and not be stopping (a replacement
	 * session never inherits a predecessor's outcome), the state must still be
	 * `retry` (an outcome that lost a race must never downgrade a runtime whose
	 * adapters are already active), and the outcome must have been proved under
	 * the exact configuration this runtime is waiting on — an outcome proved for
	 * a superseded configuration can never authorize adapters. A `failed` ensure
	 * leaves the state retryable.
	 */
	function applyDaemonOwnership(
		id: string,
		runtime: SessionRuntime,
		outcome: DaemonOwnershipOutcome,
		isolateChatEndpoint: boolean,
		key: string,
	): void {
		if (runtimes.get(id) !== runtime || runtime.stopping) return;
		if (runtime.notificationOwnerState !== "retry") return;
		if (runtime.notificationOwnerKey !== key) return;
		if (outcome === "failed") return;
		runtime.notificationOwnerState =
			outcome === "ready" || (outcome === "blocked_identity_with_sibling" && isolateChatEndpoint)
				? "ready"
				: "blocked";
		if (outcome === "blocked_identity") {
			logger.warn("notifications: Telegram daemon ownership is blocked; core SDK remains available.");
		}
		if (outcome === "blocked_identity_with_sibling" && !isolateChatEndpoint) {
			logger.warn(
				"notifications: Telegram ownership changed after core publication; preserving the canonical endpoint and withholding adapters.",
			);
		}
	}

	const identityControlOperations = new Set([
		"session.new",
		"session.fork",
		"session.resume",
		"session.switch",
		"session.branch",
	]);
	const sessionId = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();

	async function stopSession(
		id: string,
		reason: "session" | "notifications" = "session",
		expectedRuntime?: SessionRuntime,
	): Promise<boolean> {
		const retryRuntime = cleanupRetries.get(id);
		const activeRuntime = runtimes.get(id);
		const requestedRuntime = retryRuntime ?? activeRuntime;
		if (expectedRuntime && requestedRuntime !== expectedRuntime) return false;
		if (reason === "session" && requestedRuntime) {
			requestedRuntime.inboundFenced = true;
			requestedRuntime.stopping = true;
			requestedRuntime.abortEphemeralTurns();
		}
		if (reason === "session" && requestedRuntime) requestedRuntime.stopSessionNameObserver();
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
						void stopSession(id, reason, requestedRuntime).catch(error =>
							// A retained owner-release failure keeps the exact runtime in
							// cleanupRetries for a later retry; log it rather than letting a
							// fire-and-forget rejection become a fatal unhandled rejection.
							logger.error(`notifications: SDK notification runtime cleanup failed: ${String(error)}`),
						);
				});
		const rt = requestedRuntime;

		if (expectedRuntime && rt !== expectedRuntime) return false;

		if (!rt) {
			if (activeRuntimeId === id) activeRuntimeId = undefined;
			return false;
		}
		if (reason === "notifications" && rt.host.started) {
			rt.notificationsActive = false;
			rt.disableEphemeralTurns();
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
			rt.disposeAnswerSource();
		} catch {}
		try {
			rt.disposeFileSink();
		} catch {}
		try {
			rt.disposeGateListener();
		} catch {}
		try {
			rt.workflowGate?.setRuntimeTurnProvider?.(null);
		} catch {}
		try {
			const delivered = await pushTerminalSessionFrame(rt, { type: "session_closed", sessionId: id });
			if (!delivered) logger.warn("notifications: session_closed socket delivery was not acknowledged");
		} catch (e) {
			logger.warn(`notifications: session_closed failed: ${String(e)}`);
		}
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
		let serverStopped = rt.serverStopped;
		if (!serverStopped) {
			try {
				await rt.server.stopAndWait();
				serverStopped = true;
				rt.serverStopped = true;
				// This runtime no longer serves an SDK endpoint, so it withdraws its
				// own evidence — and only its own. A predecessor's deferred teardown
				// runs while an identity successor is already serving, and clearing
				// that live runtime's reader would manufacture "no evidence" for a
				// host whose clients are still attached.
				rt.evidencePublication?.retract();
				rt.evidencePublication = undefined;
			} catch (e) {
				ownerReleaseFailures.push(e);
				logger.warn(`notifications: stop failed: ${String(e)}`);
			}
		}
		// #4743: terminal release must not be reported while a reconciliation
		// publication this runtime admitted — or the execution that will produce it —
		// is still in flight. Observe durable quiescence AFTER the endpoint stopped
		// serving (no new admissions) and BEFORE the terminal release is recorded.
		// Both failure shapes stay observable as owner-release failures: a drained
		// window containing a failed write (reconciliation_persist_failed evidence
		// preserved through the store drain) and a deadline expiry (non-quiescent,
		// never silently treated as drained).
		try {
			const drained = await rt.drainDurableReconciliation();
			for (const failure of drained.failures) {
				ownerReleaseFailures.push(failure);
				logger.warn(`sdk reconciliation publication failed during teardown: ${String(failure)}`);
			}
			if (drained.timedOut) {
				const timeoutError = Object.assign(
					new Error(
						`SDK reconciliation drain timed out after ${sdkReconciliationDrainTimeoutMs()}ms; reconciliation state may be non-quiescent.`,
					),
					{ code: "reconciliation_drain_timeout" },
				);
				ownerReleaseFailures.push(timeoutError);
				logger.warn("sdk reconciliation drain timed out; proceeding with non-quiescent state");
			}
		} catch (e) {
			ownerReleaseFailures.push(e);
			logger.warn(`sdk reconciliation drain failed: ${String(e)}`);
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

	function canDeliverAsync(runtime: SessionRuntime, generation: number): boolean {
		return (
			runtimes.get(runtime.id) === runtime &&
			!runtime.stopping &&
			runtime.notificationsActive &&
			!runtime.redact &&
			runtime.policyGeneration === generation
		);
	}

	async function startSession(ctx: ExtensionContext): Promise<SessionStartResult> {
		const id = sessionId(ctx);
		const { settings, cfg, settingsAvailable } = resolveSettings(options.settings);
		const notificationsEnabledForSession = controller.query(ctx).genericSessionEnabled;
		const sdkEnabledForSession =
			(options.sdkHostModeSupported ?? true) && shouldHostSdk(settings, isNotificationEligibleContext(ctx));
		const lifecycleRequired = lifecycleStartupCapability !== undefined;
		const lifecycleRequestId = lifecycleRequired
			? safeLifecycleRequestId(lifecycleStartupCapability.lifecycleRequestId)
			: safeLifecycleRequestId(process.env.GJC_LIFECYCLE_REQUEST_ID);
		/** The broker-issued readiness intent for this exact lifecycle-managed session. */
		const lifecycleReadiness = lifecycleStartupCapability?.readiness ?? "immediate";
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
		let isolateChatEndpoint = forceIsolatedChatSessions.delete(id);
		if (
			!isolateChatEndpoint &&
			notificationsEnabledForSession &&
			settingsAvailable &&
			settings &&
			isProviderEffectivelyEnabled(cfg, "telegram") &&
			(isProviderEffectivelyEnabled(cfg, "discord") || isProviderEffectivelyEnabled(cfg, "slack")) &&
			typeof cfg.botToken === "string" &&
			typeof cfg.chatId === "string"
		) {
			const marker = getCurrentTelegramActivationMarker(cfg);
			if (marker) isolateChatEndpoint = true;
			else {
				const identity = await proposedTelegramIdentity({ settings, botToken: cfg.botToken, chatId: cfg.chatId });
				isolateChatEndpoint = identity.status === "foreign" || identity.status === "unknown";
			}
		}
		const endpointStateRoot = isolateChatEndpoint ? path.join(stateRoot, "chat") : stateRoot;
		const lifecycleAgentDir = lifecycleRequired ? settings?.getAgentDir?.() : undefined;
		if (lifecycleRequired && !lifecycleAgentDir)
			return failLifecycleStartup("failed", "Lifecycle SDK startup requires an agent directory.");

		const pendingInteractive = new Map<string, PendingInteractiveAsk>();
		const pendingPromptCorrelations: Array<{ commandId: string; turnId: string }> = [];
		const pendingPromptCorrelationsBySdkRunToken = new Map<string, { commandId: string; turnId: string }>();
		let runtime: SessionRuntime | undefined;

		// The SDK can always answer now (interactive via the answer source, or the
		// workflow gate), so the endpoint advertises a resolver. Validate the native
		// build information and required capability while lifecycle startup can settle
		// a structured failure instead of leaving the lifecycle caller pending.
		const token = resolveToken();
		let server: NotificationServer;
		try {
			const { NotificationServer, nativeBuildInfo } = sdkBusNatives();
			assertNativeRuntimeCompatibility({
				runtimeVersion: VERSION,
				nativeVersion: nativeBuildInfo().version,
				notificationServer: NotificationServer.prototype,
			});
			server = new NotificationServer(id, token, endpointStateRoot, true);
		} catch (error) {
			if (lifecycleRequired) return failLifecycleStartup("failed", error);
			throw error;
		}
		const gatePresentations = new PresentationArbiter(server, () => runtime?.redact ?? true);
		gatePresentations.setPublicationSuspended(true);
		let inboundSdkFrame: ((connectionId: string, frame: Record<string, unknown>) => void) | undefined;
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
		let sdkRuntime: SessionSdkSessionRuntime | undefined;
		let disposeUiAnswerSource: (() => void) | undefined;
		let disposePermissionAnswerSource: (() => void) | undefined;
		let permissionCapabilityActive = false;
		const installPermissionAnswerSource = () => {
			if (disposeUiAnswerSource || disposePermissionAnswerSource) return;
			disposePermissionAnswerSource = registerAskAnswerSource(
				id,
				createSdkPermissionAskAnswerSource(
					async (params, signal) => await host!.reverse.request("permission", "request", params, signal),
				),
				"protocol",
			);
		};
		const installProviderDefinitions = (capability: string, definitions: unknown) => {
			validateProviderDefinitions(capability, definitions);
			if (capability === "permission") {
				ctx.setSdkPermissionProvider?.(async (toolCall, permissionOptions, signal) => {
					const result = await host!.reverse.request(
						"permission",
						"request",
						{
							toolCall,
							options: permissionOptions,
						},
						signal,
					);
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
				permissionCapabilityActive = true;
				// Clients without ACP form elicitation (e.g. Paseo) still surface
				// workflow-gate asks through the permission channel; a client that
				// advertises `elicitation.form` keeps the richer `ui` source instead.
				installPermissionAnswerSource();
				return;
			}
			if (capability === "ui") {
				disposeUiAnswerSource?.();
				disposeUiAnswerSource = registerAskAnswerSource(
					id,
					createSdkUiAskAnswerSource(
						async (params, signal) => await host!.reverse.request("ui", "ui.elicit", params, signal),
					),
					"protocol",
				);
				disposePermissionAnswerSource?.();
				disposePermissionAnswerSource = undefined;
				return;
			}
			if (capability !== "fs") return;
			// Only advertise the methods the client actually declared; a read-only client
			// must keep using the local write path instead of failing against the bridge.
			const names = new Set(
				(Array.isArray(definitions) ? definitions : [])
					.map(definition =>
						definition && typeof definition === "object" ? (definition as { name?: unknown }).name : undefined,
					)
					.filter((name): name is string => typeof name === "string"),
			);
			const canRead = names.size === 0 || names.has("fs.readTextFile");
			const canWrite = names.size === 0 || names.has("fs.writeTextFile");
			const bridge: ClientBridge = {
				capabilities: { readTextFile: canRead, writeTextFile: canWrite },
				deferAgentInitiatedTurns: true,
				async readTextFile(params) {
					const result = await host!.reverse.request("fs", "fs.readTextFile", params);
					if (
						!result ||
						typeof result !== "object" ||
						typeof (result as { content?: unknown }).content !== "string"
					)
						throw new Error("fs provider returned an invalid read response");
					return (result as { content: string }).content;
				},
				async writeTextFile(params) {
					await host!.reverse.request("fs", "fs.writeTextFile", params);
				},
			};
			if (!canRead) delete bridge.readTextFile;
			if (!canWrite) delete bridge.writeTextFile;
			ctx.setSdkClientBridge?.(bridge);
		};
		const removeProviderDefinitions = (capability: string) => {
			if (capability === "permission") {
				ctx.setSdkPermissionProvider?.(undefined);
				permissionCapabilityActive = false;
				disposePermissionAnswerSource?.();
				disposePermissionAnswerSource = undefined;
			}
			if (capability === "fs") ctx.setSdkClientBridge?.(undefined);
			if (capability === "ui") {
				disposeUiAnswerSource?.();
				disposeUiAnswerSource = undefined;
				// The permission lease may still be live; restore its ask source so
				// later headless asks keep an ACP answer channel.
				if (permissionCapabilityActive) installPermissionAnswerSource();
			}
		};

		const hostCapCache = new Map<string, ReadonlySet<string>>();

		const configOverrides = new Map<string, unknown>();
		const configRevision = { current: 0 };
		const PROMPT_SUBMISSION_CAPACITY = 128;
		const PROMPT_SUBMISSION_TTL_MS = 5 * 60_000;
		const PROMPT_TERMINAL_TOMBSTONE_CAPACITY = 256;
		const PROMPT_TERMINAL_TOMBSTONE_TTL_MS = 15 * 60_000;
		// SDK-owned terminalization grace; injectable in tests, never a user setting.
		const PROMPT_TERMINALIZATION_GRACE_MS = 10_000;
		// Fixed grace for exact owned-job stop before the second quiescence proof.
		const OWNED_SETTLEMENT_GRACE_MS = 500;
		const promptSubmissionKey = (correlation: { commandId: string; turnId: string }) =>
			`${correlation.commandId}:${correlation.turnId}`;
		type PromptLifecycleFrame =
			| {
					type: "agent_start" | "agent_end";
					sessionId: string;
					commandId?: string;
					turnId?: string;
					finalText?: string;
					outcome?: SdkPromptTerminalOutcome;
			  }
			| {
					type: "agent_failed";
					sessionId: string;
					commandId: string;
					turnId: string;
					error: { code: string; message: string };
					outcome?: SdkPromptTerminalOutcome;
			  };
		type PromptSubmission = {
			acknowledged: boolean;
			connectionId: string;
			abandoned: boolean;
			failed: boolean;
			terminal: boolean;
			retainCorrelation: boolean;
			/** Fatal/uncertain closure: transport-level only, never a semantic terminal. */
			fatal?: boolean;
			createdAt: number;
			deadlineMs: number;
			deadlineTimer?: Parameters<typeof clearTimeout>[0];
			phase: "active" | "outcome_claimed" | "terminalizing" | "publication_closed" | "delivered";
			outcome?: SdkPromptTerminalOutcome;
			/** Agent-owned resource run captured at acceptance; cleanup targets only this handle. */
			executionHandle?: string;
			/** Cancels accepted skill preparation before an execution handle exists. */
			preflightAbort?: () => void | Promise<void>;
			reconciliationKind: ReconciliationKind;
			bufferedFrames: Array<PromptLifecycleFrame | Record<string, unknown>>;
		};
		const promptSubmissions = new Map<string, PromptSubmission>();
		/** Connections fenced by a fatal prompt closure; their later frames are refused. */
		const fencedConnections = new Set<string>();
		/**
		 * Live positioned-event delivery to attached subscribers. The native
		 * broadcast channel round-trips a closed frame enum and cannot carry the
		 * positioned event envelope, so each envelope rides the validated directed
		 * leg instead — to every connection that completed capability negotiation
		 * or an event replay, which is exactly the attached-subscriber set. Fenced
		 * connections are excluded like their inbound frames, and capability-gated
		 * kinds follow the same gate replay applies, so live and replay delivery
		 * stay one truth per connection. Only notification adapters that explicitly
		 * negotiate positioned-only effects are returned for matching raw exclusion;
		 * ordinary direct SDK subscribers retain both public surfaces from #4570.
		 */
		const broadcastEventFrame = (event: SdkFrame): string[] => {
			const gated = CAP_GATED_FRAME_KINDS.has(String(event.kind));
			const json = JSON.stringify(event);
			const recipients: string[] = [];
			for (const [connectionId, capabilities] of hostCapCache) {
				if (fencedConnections.has(connectionId)) continue;
				if (gated && !capabilities.has(TOOL_ACTIVITY_CAPABILITY)) continue;
				try {
					server.sendTo(connectionId, json);
					if (capabilities.has(POSITIONED_NOTIFICATION_EFFECTS_CAPABILITY)) recipients.push(connectionId);
				} catch {
					// Broadcasts are best effort; directed responses surface send failures.
				}
			}
			return recipients;
		};
		const broadcastEventFrameWithReceipts = (event: SdkFrame): string[] => {
			const gated = CAP_GATED_FRAME_KINDS.has(String(event.kind));
			const json = JSON.stringify(event);
			const receipts: string[] = [];
			for (const [connectionId, capabilities] of hostCapCache) {
				if (fencedConnections.has(connectionId)) continue;
				if (gated && !capabilities.has(TOOL_ACTIVITY_CAPABILITY)) continue;
				try {
					const receipt = server.sendToWithReceipt(connectionId, json);
					if (capabilities.has(POSITIONED_NOTIFICATION_EFFECTS_CAPABILITY)) receipts.push(receipt);
				} catch {
					// Rejected positioned sends remain eligible for the atomic raw fallback.
				}
			}
			return receipts;
		};
		let cancelPreflightsForConnection: ((connectionId: string) => Promise<void>) | undefined;
		const promptTerminalTombstones = new Map<string, { connectionId: string; expiresAt: number }>();
		// Authoritative bounded reconciliation state for canonical Q26 turn.result
		// (contract documented in ./prompt-reconciliation and ../prompt-status).
		// Active records never age into terminal; documented TTL/capacity
		// eviction is the only removal, after which lookups report `unknown`.
		const persistedSessionFile =
			typeof ctx.sessionManager?.getSessionFile === "function" ? ctx.sessionManager.getSessionFile() : null;
		const reconciliationSessionId =
			typeof ctx.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : "";
		const sessionFile = reconciliationSessionId
			? resolveReconciliationSessionFile(persistedSessionFile, stateRoot, String(reconciliationSessionId))
			: null;
		const durableStore =
			sessionFile && reconciliationSessionId
				? createReconciliationStore({ sessionFile, sessionId: String(reconciliationSessionId) })
				: null;
		const kindReconciliation = createKindAwareReconciliation({ store: durableStore });
		// #4743: reconciliation publications and the executions that produce them
		// are fire-and-forget at their call sites; without joining the PRODUCERS a
		// drain can observe an empty queue and return just before a still-running
		// skill enqueues its terminal publication — the teardown race again, by
		// another route. Every void-ed producer registers here and the teardown
		// drain joins the set before awaiting store quiescence.
		const reconciliationProducers = new Set<Promise<unknown>>();
		const trackReconciliationProducer = (producer: Promise<unknown>): void => {
			reconciliationProducers.add(producer);
			// Deliberately a two-arm handler, NOT `finally`: `finally` returns a derived
			// promise that re-rejects when the producer rejects, and nothing observes
			// that derived promise — a failed durable write would become an unhandled
			// rejection and kill the resident process. The two-arm form always resolves,
			// while the ORIGINAL producer keeps its rejection for the teardown drain to
			// inspect (#4743).
			const forget = (): void => {
				reconciliationProducers.delete(producer);
			};
			void producer.then(forget, forget);
		};
		// Restart recovery must commit before any prompt is admitted; otherwise a new
		// admission can race the hydrated full-state replacement.
		let reconciliationReady: Promise<void> = durableStore ? kindReconciliation.hydrateFromStore() : Promise.resolve();
		// Never let a hydration rejection become an unhandled rejection; tracked prompts
		// re-await the same promise and fail closed below.
		void reconciliationReady.catch(() => {});
		const awaitReconciliationReady = async () => {
			const observed = reconciliationReady;
			try {
				await observed;
			} catch {
				if (reconciliationReady === observed) {
					reconciliationReady = durableStore ? kindReconciliation.hydrateFromStore() : Promise.resolve();
					void reconciliationReady.catch(() => {});
				}
				await reconciliationReady;
			}
		};
		// Backward-compatible process-local prompt reconciler kept for unit-test isolation;
		// production path uses kindReconciliation for prompt+skill.
		const reconciliation = createPromptReconciliation();
		const admitPromptSubmission = (clientRef?: string) => kindReconciliation.admit("prompt", clientRef);
		const notePromptReconciliationAccepted = async (
			correlation: { commandId: string; turnId: string },
			clientRef?: string,
		) => {
			await kindReconciliation.noteAccepted("prompt", correlation, clientRef);
		};
		const releasePromptAdmission = (clientRef?: string) => kindReconciliation.releaseAdmission("prompt", clientRef);
		const removePendingPromptCorrelation = (correlation: { commandId: string; turnId: string }) => {
			const pendingIndex = pendingPromptCorrelations.findIndex(
				candidate => candidate.commandId === correlation.commandId && candidate.turnId === correlation.turnId,
			);
			if (pendingIndex !== -1) pendingPromptCorrelations.splice(pendingIndex, 1);
			for (const [sdkRunToken, candidate] of pendingPromptCorrelationsBySdkRunToken) {
				if (candidate.commandId === correlation.commandId && candidate.turnId === correlation.turnId)
					pendingPromptCorrelationsBySdkRunToken.delete(sdkRunToken);
			}
		};
		const addTerminalTombstone = (key: string, connectionId: string, now = Date.now()) => {
			promptTerminalTombstones.delete(key);
			promptTerminalTombstones.set(key, { connectionId, expiresAt: now + PROMPT_TERMINAL_TOMBSTONE_TTL_MS });
			while (promptTerminalTombstones.size > PROMPT_TERMINAL_TOMBSTONE_CAPACITY)
				promptTerminalTombstones.delete(promptTerminalTombstones.keys().next().value!);
		};
		const finalizePrompt = (key: string, correlation: { commandId: string; turnId: string }) => {
			const submission = promptSubmissions.get(key);
			if (submission?.deadlineTimer) clearTimeout(submission.deadlineTimer);
			promptSubmissions.delete(key);
			removePendingPromptCorrelation(correlation);
			if (submission) addTerminalTombstone(key, submission.connectionId);
		};
		const expirePromptDelivery = (key: string, submission: PromptSubmission) => {
			if (!submission.terminal) return;
			if (submission.deadlineTimer) clearTimeout(submission.deadlineTimer);
			promptSubmissions.delete(key);
			// A fatal closure is transport-level, not a committed semantic terminal: the
			// durable record stays authoritative, so it must never leave a tombstone.
			if (submission.fatal) return;
			const [commandId, turnId] = key.split(":", 2);
			if (!commandId || !turnId) return;
			removePendingPromptCorrelation({ commandId, turnId });
			addTerminalTombstone(key, submission.connectionId);
		};
		const cleanupPromptRecords = (now = Date.now()) => {
			kindReconciliation.cleanup();
			reconciliation.cleanup();
			for (const [key, tombstone] of promptTerminalTombstones)
				if (tombstone.expiresAt <= now) promptTerminalTombstones.delete(key);
			// Age-based eviction applies only after terminal publication has
			// settled (`delivered`) or for fatal transport-level closures, which
			// never publish by design. Active and terminal-in-progress records
			// (`outcome_claimed`/`terminalizing`/`publication_closed`) must
			// survive past the TTL so a long-running prompt's terminal event is
			// never dropped before it reaches the positioned ring (#4691).
			for (const [key, submission] of promptSubmissions)
				if (
					submission.terminal &&
					(submission.phase === "delivered" || submission.fatal === true) &&
					submission.createdAt + PROMPT_SUBMISSION_TTL_MS <= now
				)
					expirePromptDelivery(key, submission);
		};
		const abandonPrompt = (submission: PromptSubmission) => {
			submission.abandoned = true;
			submission.bufferedFrames.length = 0;
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
			emitSessionEvent(runtime, frame);
			if (submission.abandoned) {
				if (submission.terminal) finalizePrompt(key, correlation);
				return;
			}
			if (!submission.acknowledged) {
				submission.bufferedFrames.push(frame);
				return;
			}
			try {
				runtime.server.sendTo(submission.connectionId, JSON.stringify(frame));
			} catch (error) {
				logger.warn(`sdk: correlated lifecycle delivery failed: ${String(error)}`);
				abandonPrompt(submission);
			}
			if (submission.terminal) {
				submission.phase = "delivered";
				finalizePrompt(key, correlation);
			}
		};
		const emitPromptEvent = (event: AgentSessionEvent) => {
			if (!runtime?.activePromptCorrelation) return;
			cleanupPromptRecords();
			const correlation = runtime.activePromptCorrelation;
			const submission = promptSubmissions.get(promptSubmissionKey(correlation));
			if (!submission || submission.abandoned) return;
			const frame = {
				type: "event",
				kind: event.type,
				payload: toAgentWireEventPayload(event),
				...correlation,
			};
			if (!submission.acknowledged) {
				submission.bufferedFrames.push(frame);
				return;
			}
			try {
				runtime.server.sendTo(submission.connectionId, JSON.stringify(frame));
			} catch (error) {
				logger.warn(`sdk: correlated agent event delivery failed: ${String(error)}`);
				abandonPrompt(submission);
			}
		};
		const flushPromptLifecycle = (key: string, submission: PromptSubmission) => {
			for (const frame of submission.bufferedFrames.splice(0)) {
				try {
					server.sendTo(submission.connectionId, JSON.stringify(frame));
				} catch (error) {
					logger.warn(`sdk: buffered correlated lifecycle delivery failed: ${String(error)}`);
					abandonPrompt(submission);
					break;
				}
			}
			if (submission.terminal) {
				submission.phase = "delivered";
				const [commandId, turnId] = key.split(":", 2);
				if (commandId && turnId) finalizePrompt(key, { commandId, turnId });
			}
		};
		const recordPromptAccepted = async (
			correlation: { commandId: string; turnId: string },
			requesterConnectionId?: string,
			clientRef?: string,
			trackReconciliation = false,
			preflightAbort?: () => void | Promise<void>,
			reconciliationKind: ReconciliationKind = "prompt",
			sdkRunToken?: string,
		) => {
			if (!requesterConnectionId) {
				// No delivery owner: tracked prompts cannot be reconciled. Release
				// their admission reservation instead of leaking the active slot.
				if (trackReconciliation) releasePromptAdmission(clientRef);
				return;
			}
			// Register delivery ownership synchronously before any await so post-accept
			// failures that race the durable write still emit correlated terminals.
			cleanupPromptRecords();
			while (promptSubmissions.size >= PROMPT_SUBMISSION_CAPACITY) {
				// Capacity eviction likewise never drops a terminal-in-progress
				// record (#4691): only publication-settled or fatal deliveries can
				// be reclaimed; otherwise admission fails closed.
				const oldestTerminal = [...promptSubmissions.entries()].find(
					([, submission]) =>
						submission.terminal && (submission.phase === "delivered" || submission.fatal === true),
				);
				if (!oldestTerminal)
					throw Object.assign(
						new Error("Too many active prompt submissions; reconcile or await terminal state."),
						{ code: "reconciliation_capacity" },
					);
				expirePromptDelivery(oldestTerminal[0], oldestTerminal[1]);
			}
			if (sdkRunToken) pendingPromptCorrelationsBySdkRunToken.set(sdkRunToken, correlation);
			else pendingPromptCorrelations.push(correlation);
			const submission: PromptSubmission = {
				acknowledged: false,
				connectionId: requesterConnectionId,
				abandoned: false,
				failed: false,
				terminal: false,
				retainCorrelation: trackReconciliation,
				createdAt: Date.now(),
				deadlineMs: settings?.get("sdk.promptDeadlineMs") ?? 1_800_000,
				phase: "active",
				// Bound to the Agent run at `agent_start`; acceptance precedes execution.
				executionHandle: undefined,
				...(preflightAbort ? { preflightAbort } : {}),
				reconciliationKind,
				bufferedFrames: [],
			};
			promptSubmissions.set(promptSubmissionKey(correlation), submission);
			if (trackReconciliation) await notePromptReconciliationAccepted(correlation, clientRef);
			submission.deadlineTimer = setTimeout(() => {
				void terminalizePrompt(
					correlation,
					{
						kind: "failed",
						code: "prompt_deadline_exceeded",
						message: "Prompt deadline exceeded.",
						provenance: "deadline",
					},
					{ fence: true },
					{ diagnostic: { reason: "Prompt deadline exceeded." } },
				);
			}, submission.deadlineMs);
		};
		/** Roll back process-local registration when durable acceptance failed. */
		const discardPromptAcceptance = (correlation: { commandId: string; turnId: string }) => {
			const submission = promptSubmissions.get(promptSubmissionKey(correlation));
			if (submission?.deadlineTimer) clearTimeout(submission.deadlineTimer);
			promptSubmissions.delete(promptSubmissionKey(correlation));
			removePendingPromptCorrelation(correlation);
		};
		const recordPromptTerminal = (correlation: { commandId: string; turnId: string } | undefined) => {
			if (!correlation) return false;
			const submission = promptSubmissions.get(promptSubmissionKey(correlation));
			if (!submission || submission.terminal) return false;
			submission.terminal = true;
			submission.phase = "publication_closed";
			return true;
		};
		/**
		 * Fail-closed teardown: the durable claim survives for restart recovery, but the
		 * waiting client must still reject exactly once, so an infrastructure failure frame
		 * is delivered before the connection is released.
		 */
		const failPromptClosed = (
			correlation: { commandId: string; turnId: string },
			submission: PromptSubmission,
			code: string,
			message: string,
		) => {
			if (submission.deadlineTimer) clearTimeout(submission.deadlineTimer);
			if (!submission.terminal) {
				submission.terminal = true;
				submission.fatal = true;
				submission.phase = "publication_closed";
				// Deliver the transport failure directly to the accepted requester instead of
				// `emitPromptLifecycle`: this must never enter the resumable semantic event
				// ring, finalize reconciliation, or tombstone the correlation, because the
				// durable claim stays authoritative for Q26 and restart recovery.
				// Delivered regardless of acknowledgement: a pre-ack fatal failure must still
				// settle the waiting request instead of leaving it pending forever.
				if (runtime)
					try {
						runtime.server.sendTo(
							submission.connectionId,
							JSON.stringify({
								type: "agent_failed",
								sessionId: runtime.id,
								...correlation,
								error: { code, message },
							}),
						);
					} catch (error) {
						logger.warn(`sdk: fatal prompt closure delivery failed: ${String(error)}`);
					}
			}
			// Fence the endpoint. The native transport exposes no close primitive, so the
			// connection is marked failed (every later inbound frame from it is refused),
			// its reverse leases are released, and its deliveries are abandoned. The durable
			// record stays active for Q26 and restart recovery.
			if (cancelPreflightsForConnection)
				void cancelPreflightsForConnection(submission.connectionId).catch(error =>
					logger.warn(`sdk: failed to cancel fenced preflight: ${String(error)}`),
				);
			fencedConnections.add(submission.connectionId);
			host?.handleDisconnect(submission.connectionId);
			for (const [key, owned] of promptSubmissions)
				if (owned.connectionId === submission.connectionId) {
					abandonPrompt(owned);
					const [commandId, turnId] = key.split(":", 2);
					if (commandId && turnId) removePendingPromptCorrelation({ commandId, turnId });
				}
			if (
				runtime?.activePromptCorrelation?.commandId === correlation.commandId &&
				runtime.activePromptCorrelation.turnId === correlation.turnId
			)
				runtime.activePromptCorrelation = undefined;
		};
		const bindPromptExecutionHandle = (
			correlation: { commandId: string; turnId: string },
			handle: string | undefined,
		) => {
			const submission = promptSubmissions.get(promptSubmissionKey(correlation));
			if (submission) {
				submission.executionHandle = handle;
				submission.preflightAbort = undefined;
			}
		};
		const terminalizePrompt = async (
			correlation: { commandId: string; turnId: string },
			requestedOutcome: SdkPromptTerminalOutcome,
			// Cleanup-initiated claims (cancel, deadline, owner disconnect) must abort the
			// run and prove settlement. A natural `agent_end`/`agent_failed` already unwound,
			// so aborting there would cancel the next turn instead of fencing this one.
			options: { fence?: boolean; terminal?: { scope: AbortScope; steeringSnapshotToken?: number } } = {},
			extra?: PromptTerminalExtra,
			capture?: {
				proof?: RunSettlementProof & {
					terminalScope?: { scopeId: string; abortedAttemptEpoch: number; lineageIdHash: string };
				};
				/** Whether the correlated agent_end event was published (AC 19). */
				published?: boolean;
				/** Whether terminalization reached the durable terminal (fail-closed paths leave this unset). */
				terminalized?: boolean;
			},
		) => {
			const receiptState = extra?.finalText?.trim() ? "present" : "missing";
			const submission = promptSubmissions.get(promptSubmissionKey(correlation));
			if (!submission || submission.terminal || submission.phase !== "active") return;
			submission.phase = "outcome_claimed";
			// Capture the attempt epoch BEFORE the durable claim: a successor
			// prompt admitted while the claim is awaited advances the epoch, so
			// the seam must refuse to fence the successor's lineage (review
			// thread P1).
			const terminalExpectedEpoch = options.terminal ? terminalAbortSeams?.getTerminalTurnEpoch?.() : undefined;
			let winner: SdkPromptTerminalOutcome;
			try {
				winner = await kindReconciliation.claimPendingOutcome(
					submission.reconciliationKind,
					correlation,
					requestedOutcome,
					receiptState,
				);
			} catch (error) {
				// The claim is the durability boundary: without it nothing may be published
				// and the endpoint must fail closed so the client rejects exactly once. The
				// last durable record stays active for restart recovery.
				logger.warn(`sdk: prompt claim persistence failed: ${String(error)}`);
				failPromptClosed(correlation, submission, "terminal_uncertain", "Prompt reconciliation is unavailable.");
				return;
			}
			submission.outcome = winner;
			submission.phase = "terminalizing";
			if (options.fence) {
				// Terminal fencing goes through a BUS-PRIVATE session capability
				// (never the extension context, whose abortPromptAndWait has no
				// terminal option): a JavaScript extension cannot register a
				// closed terminal scope without the SDK's durable admission
				// (review thread P2).
				// Only the handle captured for this correlation may be fenced; a later run
				// must never be aborted by an older prompt's cleanup.
				if (
					typeof terminalAbortSeams?.abortPromptAndWaitWithTerminal !== "function" ||
					!submission.executionHandle
				) {
					failPromptClosed(
						correlation,
						submission,
						"terminal_uncertain",
						"Prompt resources could not be fenced with an exact run handle.",
					);
					return;
				}
				// Rebind the steering snapshot to the current turn before the
				// settlement: the token was captured under the abort's admission
				// turn, which may differ from the now-active turn that the
				// settlement will fence. Without the rebind the session rejects
				// the still-old token as unknown_run (review thread P1).
				if (options.terminal?.steeringSnapshotToken !== undefined) {
					terminalAbortSeams?.rebindTerminalAbortSteeringSnapshot?.(options.terminal.steeringSnapshotToken);
				}
				let proof: RunSettlementProof;
				try {
					proof = await terminalAbortSeams.abortPromptAndWaitWithTerminal(submission.executionHandle, {
						graceMs: PROMPT_TERMINALIZATION_GRACE_MS,
						// Terminal abort registers the continuation fence for the
						// aborted turn before the run is interrupted (see
						// AgentSession.abortPromptAndWait). Ordinary cancels pass no
						// terminal option and register nothing. The request-time epoch
						// travels with the scope so the seam refuses to fence a
						// successor turn admitted while the durable claim was awaited.
						...(options.terminal
							? { terminal: { ...options.terminal, expectedEpoch: terminalExpectedEpoch } }
							: {}),
					});
				} catch (error) {
					logger.warn(`sdk: prompt resource fencing failed: ${String(error)}`);
					failPromptClosed(
						correlation,
						submission,
						"terminal_uncertain",
						"Prompt resources could not be settled before terminalization.",
					);
					return;
				}
				if (proof?.status !== "settled") {
					logger.warn(`sdk: prompt resource settlement unfenced: ${formatPromptSettlementDiagnostic(proof)}`);
					// No settlement proof: never publish a normal terminal. The durable
					// pending claim stays active so restart recovery finalizes it.
					failPromptClosed(
						correlation,
						submission,
						"terminal_uncertain",
						"Prompt resources did not settle before the terminalization grace expired.",
					);
					return;
				}
				if (capture) capture.proof = proof;
			}
			try {
				await kindReconciliation.finalizeOutcome(
					submission.reconciliationKind,
					correlation,
					winner,
					extra?.error,
					extra?.finalText,
				);
			} catch (error) {
				// The durable pending claim survives; publishing an unpersisted terminal
				// would contradict it, so fail the endpoint closed instead.
				logger.warn(`sdk: prompt terminal persistence failed: ${String(error)}`);
				failPromptClosed(correlation, submission, "terminal_uncertain", "Prompt reconciliation is unavailable.");
				return;
			}
			if (submission.deadlineTimer) clearTimeout(submission.deadlineTimer);
			if (!recordPromptTerminal(correlation)) return;
			if (!runtime) {
				// The runtime (and with it the positioned ring) is gone, so the
				// terminal can never be published from this process; expire the
				// delivery record immediately instead of stranding a
				// publication_closed record that cleanup may no longer evict (#4691).
				const strandedKey = promptSubmissionKey(correlation);
				const stranded = promptSubmissions.get(strandedKey);
				if (stranded) expirePromptDelivery(strandedKey, stranded);
				return;
			}
			if (
				winner.kind === "failed" &&
				extra?.diagnostic?.intentionalCancellation !== true &&
				extra?.diagnosticAlreadyLogged !== true
			) {
				const diagnostic = extra?.diagnostic;
				logger.error("sdk_prompt_terminal_failed", {
					sessionId: id,
					commandId: correlation.commandId,
					turnId: correlation.turnId,
					code: winner.code,
					provenance: winner.provenance,
					...(diagnostic?.loopStopReason ? { loopStopReason: diagnostic.loopStopReason } : {}),
					...(diagnostic?.assistantStopReason ? { assistantStopReason: diagnostic.assistantStopReason } : {}),
					...(diagnostic?.errorKind ? { errorKind: diagnostic.errorKind } : {}),
					reason: formatPromptTerminalFailureReason(diagnostic?.reason),
				});
			}
			try {
				if (winner.kind === "failed") {
					emitPromptLifecycle(correlation, {
						type: "agent_failed",
						sessionId: runtime.id,
						...correlation,
						error: extra?.error ?? { code: winner.code, message: winner.message },
						outcome: winner,
					});
				} else {
					emitPromptLifecycle(correlation, {
						type: "agent_end",
						sessionId: runtime.id,
						...correlation,
						...(extra?.finalText ? { finalText: extra.finalText } : {}),
						outcome: winner,
						// Terminal abort: one correlated existing agent_end carries bounded
						// scope/turn/ownedWork/automatic metadata before the first terminal
						// success. ownedWork is pre-proof here (owned cleanup settles it in
						// the terminal response); later owned-completion feedback uses the
						// ordinary fresh-turn event path, never a second terminal event.
						...(options.terminal
							? {
									terminal: {
										scope: options.terminal.scope,
										turn: "stopped",
										ownedWork: options.terminal.scope === "turn" ? "left_running" : "uncertain",
										automaticDelivery: options.terminal.scope === "turn" ? "enabled" : "none",
										resumeOnOwnedCompletion: options.terminal.scope === "turn",
									},
								}
							: {}),
					});
				}
				// The correlated event was published (AC 19): record the outcome so
				// the durable terminal-scope record carries terminalPublished:true.
				// terminalized marks a genuinely landed durable terminal — the
				// submission may already have been finalized/deleted for an
				// acknowledged prompt, so the callback must not re-derive success
				// from promptSubmissions after this point (P1).
				if (capture) {
					capture.published = true;
					capture.terminalized = true;
				}
			} catch (error) {
				// Event publication failed: the semantic terminal stands but the
				// event bit stays false (no second event is ever emitted on replay).
				logger.warn(`sdk: prompt terminal event publication failed: ${String(error)}`);
				// Publication was attempted and failed, so retaining the delivery
				// record can no longer serve publication; expire it (with its
				// dedupe tombstone) instead of stranding a publication_closed
				// record that cleanup may no longer evict (#4691).
				const failedKey = promptSubmissionKey(correlation);
				const stranded = promptSubmissions.get(failedKey);
				if (stranded?.terminal) expirePromptDelivery(failedKey, stranded);
			}
		};
		const emitPromptFailure = async (correlation: { commandId: string; turnId: string }, error: unknown) => {
			logger.error("SDK prompt submission failed", {
				commandId: correlation.commandId,
				turnId: correlation.turnId,
				error: formatPromptFailureForLocalLog(error),
			});
			const sanitized = sanitizePromptFailure(error);
			const outcome: SdkPromptTerminalOutcome = {
				kind: "failed",
				code: "prompt_failed",
				message: sanitized.message,
				provenance: "agent_failed",
			};
			// This rejection bypasses `agent_end`, so record its local-only reason at
			// the accepted submission failure boundary before terminalization begins.
			logger.error("sdk_prompt_terminal_failed", {
				sessionId: id,
				commandId: correlation.commandId,
				turnId: correlation.turnId,
				code: outcome.code,
				provenance: outcome.provenance,
				reason: formatPromptTerminalFailureReason(error),
			});
			await terminalizePrompt(
				correlation,
				outcome,
				{},
				// The normalized outcome and wire error retain the fixed safe token.
				// Mark the diagnostic as recorded so terminalization does not duplicate it.
				{ error: sanitized, diagnostic: { reason: error }, diagnosticAlreadyLogged: true },
			);
		};
		const recordPromptFailure = async (correlation: { commandId: string; turnId: string }, error: unknown) => {
			const submission = promptSubmissions.get(promptSubmissionKey(correlation));
			if (!submission) return;
			submission.failed = true;
			removePendingPromptCorrelation(correlation);
			if (
				runtime?.activePromptCorrelation?.commandId === correlation.commandId &&
				runtime.activePromptCorrelation.turnId === correlation.turnId
			)
				runtime.activePromptCorrelation = undefined;
			await emitPromptFailure(correlation, error);
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
				settings,
				selector => kindReconciliation.lookupResult(selector.kind, selector),
				selector => kindReconciliation.lookupSteer(selector),
				() => host,
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
			() =>
				runtime?.busy === true ||
				pendingPromptCorrelations.length > 0 ||
				pendingPromptCorrelationsBySdkRunToken.size > 0,
			recordPromptAccepted,
			recordPromptFailure,
			discardPromptAcceptance,
			() => runtime?.stopping !== true,
			trackGateResolution,
			admitPromptSubmission,
			releasePromptAdmission,
			awaitReconciliationReady,
			settings,
			configOverrides,
			configRevision,
			async connectionId => {
				const active = [...promptSubmissions.entries()].find(
					([, submission]) => submission.connectionId === connectionId && !submission.terminal,
				);
				if (!active) return { aborted: true, disposition: "idle" as const };
				const [key, submission] = active;
				const [commandId, turnId] = key.split(":", 2);
				if (commandId && turnId) {
					const hasExecutionHandle = Boolean(submission.executionHandle);
					const cancellationOutcome: SdkPromptTerminalOutcome = {
						kind: "stopped",
						reason: "cancelled",
						provenance: "client_cancel",
					};
					if (!hasExecutionHandle && submission.preflightAbort) {
						try {
							await kindReconciliation.claimPendingOutcome(
								submission.reconciliationKind,
								{ commandId, turnId },
								cancellationOutcome,
							);
						} catch (error) {
							logger.warn(`sdk: accepted preflight cancellation claim failed: ${String(error)}`);
							failPromptClosed(
								{ commandId, turnId },
								submission,
								"terminal_uncertain",
								"Accepted prompt cancellation could not be persisted.",
							);
							return { aborted: true, disposition: "cancelled" as const };
						}
						try {
							await submission.preflightAbort();
						} catch (error) {
							logger.warn(`sdk: accepted preflight cancellation failed: ${String(error)}`);
							failPromptClosed(
								{ commandId, turnId },
								submission,
								"terminal_uncertain",
								"Accepted prompt preparation could not be settled before cancellation.",
							);
							return { aborted: true, disposition: "cancelled" as const };
						}
					}
					await terminalizePrompt({ commandId, turnId }, cancellationOutcome, {
						fence: hasExecutionHandle || !submission.preflightAbort,
					});
				}
				return { aborted: true, disposition: "cancelled" as const };
			},
			async (connectionId, scope, idempotencyKey, preflightCancel, noOtherConnectionPreflights) => {
				// Capture the steering snapshot at ADMISSION (before the durable
				// marker transaction): client steering admitted while the abort
				// is in flight classifies as post-snapshot and is preserved at
				// abortPromptAndWait (review thread P1).
				const steeringSnapshotToken = terminalAbortSeams?.captureTerminalAbortSteeringSnapshot?.();
				// Hash the EXACT response payload this abort will return: the durable
				// row stores it at finalization so the response-state advance requires
				// equality instead of trusting a non-pending placeholder (review
				// thread P2).
				const hashResult = (value: unknown): string =>
					crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
				// The public uncertain disposition the client receives for an
				// {ok:false, reason} outcome (single source for finalization hashes).
				const hashPublicUncertain = (reason: "worker_unsettled" | "owned_unsettled"): string =>
					hashResult({
						ok: true,
						selection: scope,
						turn: "uncertain",
						ownedWork: scope === "turn" ? "left_running" : "uncertain",
						automaticDelivery: scope === "turn" ? "enabled" : "none",
						resumeOnOwnedCompletion: scope === "turn",
						reason,
					});
				// Terminal abort stops the root turn through the same durable
				// terminalization as ordinary client cancel, then verifies the
				// terminal actually landed before claiming "stopped". The fence
				// for the aborted turn is registered by the session (via the
				// terminal option on abortPromptAndWait) so a later left-running
				// owned completion classifies by exact source. A fatal
				// fail-closed path (no exact run handle or unsettled resources)
				// reports safe uncertainty, never a fabricated stop.
				if (!durableStore?.path) {
					// No FILE-BACKED reconciliation owner: terminal admission is
					// gated off (plan AC 5) before any fence, stop, or cleanup. A
					// memory-only store (path null, e.g. an unsafe session header
					// id) must not report durable success — restart would lose the
					// idempotency row and a same-key retry could affect a later
					// turn (review thread P2).
					return { ok: true as const, outcome: "no_store" as const };
				}
				// Await the startup reconciliation hydration before ANY snapshot or
				// terminal-scope transaction, so a same-key retry immediately after
				// a restarted endpoint becomes reachable replays the durable row
				// instead of racing the still-pending store load (P2).
				await reconciliationReady;
				// Same-key replay/conflict: a durable terminal-scope record already
				// exists for this bounded idempotency key. Same key + same
				// normalized input -> return the stored dispositions exactly, never
				// re-run cleanup, never a second event. Same key + different input
				// (scope change) -> deterministic conflict (AC 3).
				const keyHash = idempotencyKey
					? crypto.createHash("sha256").update(idempotencyKey).digest("hex")
					: undefined;
				const inputHash = crypto
					.createHash("sha256")
					.update(JSON.stringify({ mode: "terminal", scope }))
					.digest("hex");
				if (keyHash) {
					const existing = durableStore.snapshotTerminalScopes().find(s => s.idempotencyKeyHash === keyHash);
					if (!existing) {
						// The completed row may have been evicted by the retention
						// cap; its compact key tombstone survives, so a same-key
						// retry replays as already-handled instead of aborting an
						// unrelated later prompt. Look the tombstone up by keyHash
						// FIRST: reusing the key with the OTHER scope must return
						// idempotency_conflict, not bypass the conflict path
						// (review thread P1).
						const tombstone = durableStore.snapshotTerminalKeys().find(k => k.keyHash === keyHash);
						if (tombstone) {
							if (tombstone.inputHash !== inputHash) {
								return { ok: false as const, reason: "conflict" as const };
							}
							// The evicted row's compact tombstone carries its
							// disposition, so the replay reconstructs the ORIGINAL
							// result (stopped/stopped_owned/uncertain/no_effect)
							// with the stored response/publication state instead of
							// collapsing everything to no_effect (review thread P2).
							const storedRow = {
								responseState: tombstone.responseState ?? "",
								responsePayloadHash: tombstone.responsePayloadHash ?? "",
								terminalPublished: tombstone.terminalPublished === true,
							};
							if (tombstone.turnDisposition === "stopped") {
								return {
									ok: true as const,
									outcome: (tombstone.ownedWorkDisposition === "stopped" ? "stopped_owned" : "stopped") as
										| "stopped"
										| "stopped_owned",
									stored: storedRow,
								};
							}
							if (tombstone.turnDisposition === "uncertain") {
								return { ok: true as const, outcome: "uncertain_replay" as const, stored: storedRow };
							}
							if (tombstone.turnDisposition === "no_effect_marker_failure") {
								// Marker failure before any destructive work: replay the SAME
								// no_effect result, so eviction/restart can never turn it into
								// a fabricated no_active_turn (review thread P2).
								return { ok: true as const, outcome: "no_effect" as const, stored: storedRow };
							}
							if (tombstone.turnDisposition === "no_effect_reserved") {
								// A transitional reservation evicted mid-flight: the result was
								// never finalized, so replay safe uncertainty — never a
								// fabricated no_active_turn (review thread P2).
								return { ok: true as const, outcome: "uncertain_replay" as const, stored: storedRow };
							}
							// Idle/already-terminal reservation: replay as no_active_turn so a
							// same-key retry after eviction/restart never aborts an unrelated
							// later turn.
							return { ok: true as const, outcome: "no_effect_replay" as const, stored: storedRow };
						}
					}
					if (existing) {
						if (existing.selection !== scope || existing.idempotencyInputHash !== inputHash) {
							return { ok: false as const, reason: "conflict" as const };
						}
						// Replay every persisted durable row (AC 18/19/41) WITHOUT
						// re-running the stop, cleanup, or event, carrying the stored
						// response state, payload hash, and publication bit so the
						// client sees the exact immutable row.
						const storedRow = {
							responseState: existing.responseState,
							responsePayloadHash: existing.responsePayloadHash,
							terminalPublished: existing.terminalPublished === true,
						};
						if (existing.turnDisposition === "stopped") {
							return {
								ok: true as const,
								outcome: (existing.ownedWorkDisposition === "stopped" ? "stopped_owned" : "stopped") as
									| "stopped"
									| "stopped_owned",
								stored: storedRow,
							};
						}
						if (existing.turnDisposition === "pending") {
							// A crashed attempt left an incomplete marker: replay the
							// plan's pending row (AC 4/41) — safe uncertainty, NO
							// re-run of the stop, cleanup, or event.
							return { ok: true as const, outcome: "pending_replay" as const, stored: storedRow };
						}
						if (existing.turnDisposition === "no_effect_marker_failure") {
							// Marker failure before any destructive work: replay the SAME
							// no_effect result the request returned, never a fabricated
							// no_active_turn (review thread P2).
							return { ok: true as const, outcome: "no_effect" as const, stored: storedRow };
						}
						if (existing.turnDisposition === "no_effect_reserved") {
							// A transitional reservation: the abort may still transition to
							// active, so a duplicate must never claim no_active_turn over a
							// provisional row (review thread P2).
							return { ok: true as const, outcome: "uncertain_replay" as const, stored: storedRow };
						}
						if (existing.turnDisposition === "no_effect") {
							// A durable idle/already-terminal reservation: replay the exact
							// no_active_turn result so a same-key retry after
							// eviction/restart never aborts an unrelated later turn and
							// never turns the reservation into a no_effect marker failure.
							return { ok: true as const, outcome: "no_effect_replay" as const, stored: storedRow };
						}
						// uncertain (restart-settled) or any other durable state: safe
						// uncertainty replay, never a re-run (AC 41 restart row).
						return { ok: true as const, outcome: "uncertain_replay" as const, stored: storedRow };
					}
				}
				// Durable terminal-state writes below go through the shared
				// `boundTerminalRetentionState` bound (see
				// `session/terminal-abort.ts`), which the SDK-only host runtime uses
				// too: idle aborts with unique keys cannot grow the reconciliation
				// document, only the oldest COMPLETED rows are evicted, and evicted
				// keys are retained as compact tombstones (review thread P2).
				// Set when the no-effect reservation finds an existing SAME-input row
				// or tombstone: the caller replays it instead of returning a no-active
				// result over the original row's replay authority (review thread P2).
				let existingReplay: DurableTerminalScopeRecord | EvictedTerminalKeyEntry | undefined;
				// Finalize THIS abort's transitional no_effect_reserved reservation to
				// plain no_effect once the recheck confirms there is no active turn to
				// stop: a later same-key retry then replays the deterministic
				// no_active_turn result instead of reservation uncertainty. Only OUR
				// row (exact key+input, still reserved) is touched (review thread P2).
				const finalizeNoEffectReservation = async (payloadHash: string): Promise<void> => {
					if (!keyHash) return;
					// The same-key retry delivers the replay envelope; store its hash
					// too so a written replay can advance the finalized row (review
					// thread P2).
					const replayPayloadHash = hashResult({
						ok: true,
						selection: scope,
						turn: "no_active_turn",
						terminal: "terminal_no_effect",
						replay: {
							responseState: "pending",
							responsePayloadHash: payloadHash,
							terminalPublished: false,
						},
					});
					try {
						await durableStore.transactTerminalState(state => {
							const scopes: DurableTerminalScopeRecord[] = state.scopes.map(record =>
								record.idempotencyKeyHash === keyHash &&
								record.idempotencyInputHash === inputHash &&
								record.turnDisposition === "no_effect_reserved"
									? {
											...record,
											turnDisposition: "no_effect",
											responsePayloadHash: payloadHash,
											replayPayloadHash,
										}
									: record,
							);
							// Finalized reservations become evictable completed rows: apply
							// the SAME bounded retention as reserveTerminalNoEffect so a
							// burst of idle aborts cannot grow the document (review
							// thread P2).
							return boundTerminalRetentionState(state.keys, scopes);
						});
					} catch {
						// Best-effort: the row stays reserved (replays as uncertainty)
						// rather than failing the abort (review thread P2).
					}
				};
				// Finalize pending markers through the SAME bounded retention as the
				// admission writes: mapping pending rows to completed dispositions
				// (uncertain/stopped) must evict the oldest completed rows and
				// retain tombstones, or a burst of concurrent distinct-key aborts of
				// one slow turn leaves an arbitrarily large reconciliation document
				// (review thread P2).
				const transactBoundedTerminalScopes = async (
					mutate: (scopes: DurableTerminalScopeRecord[]) => DurableTerminalScopeRecord[],
				): Promise<void> => {
					await durableStore.transactTerminalState(state => {
						return boundTerminalRetentionState(state.keys, mutate(state.scopes));
					});
				};
				const replayExisting = (row: DurableTerminalScopeRecord | EvictedTerminalKeyEntry) => {
					const storedRow = {
						responseState: row.responseState ?? "",
						responsePayloadHash: row.responsePayloadHash ?? "",
						terminalPublished: row.terminalPublished === true,
					};
					if (row.turnDisposition === "stopped") {
						return {
							ok: true as const,
							outcome: (row.ownedWorkDisposition === "stopped" ? "stopped_owned" : "stopped") as
								| "stopped"
								| "stopped_owned",
							stored: storedRow,
						};
					}
					if (row.turnDisposition === "pending") {
						return { ok: true as const, outcome: "pending_replay" as const, stored: storedRow };
					}
					if (row.turnDisposition === "uncertain") {
						return { ok: true as const, outcome: "uncertain_replay" as const, stored: storedRow };
					}
					if (row.turnDisposition === "no_effect_marker_failure") {
						return { ok: true as const, outcome: "no_effect" as const, stored: storedRow };
					}
					if (row.turnDisposition === "no_effect_reserved") {
						// A transitional reservation never finalized: replay safe
						// uncertainty, never a fabricated no_active_turn (review
						// thread P2).
						return { ok: true as const, outcome: "uncertain_replay" as const, stored: storedRow };
					}
					return { ok: true as const, outcome: "no_effect_replay" as const, stored: storedRow };
				};
				const reserveTerminalNoEffect = async (
					reason: "idle" | "marker_failure" = "idle",
				): Promise<"ok" | "failed" | "conflict"> => {
					if (!keyHash) return "ok";
					try {
						await durableStore.transactTerminalState(state => {
							// Atomic recheck: a concurrent request may have committed a
							// DIFFERENT input under this key after the earlier snapshot
							// check (the 256-entry dispatch cache evicted the in-flight
							// entry). Appending a second same-key row would make later
							// replay's .find() by key hash ambiguous and could report a
							// conflict for a request that already succeeded; reject the
							// conflicting input inside the transaction instead (review
							// thread P2).
							const conflicting = state.scopes.find(s => s.idempotencyKeyHash === keyHash);
							if (conflicting && conflicting.idempotencyInputHash !== inputHash)
								throw new TerminalIdempotencyConflictError();
							// A SAME-input live row is durable replay authority (the
							// original in-flight abort's marker): never replace it with a
							// no-effect reservation, or the successful abort would replay
							// later as no_active_turn. Leave the store unchanged and let
							// the caller replay the existing row (review thread P2).
							if (conflicting) {
								existingReplay = conflicting;
								return { scopes: state.scopes, keys: state.keys };
							}
							// A concurrent admission may ALSO have evicted a same-key row
							// into the tombstone collection after this request's snapshot;
							// recheck keys so a different input can never install a fresh
							// marker over existing durable replay authority (review
							// thread P2). A same-input tombstone already carries the
							// reservation: leave the store unchanged and replay it.
							const tombstone = state.keys.find(s => s.keyHash === keyHash);
							if (tombstone) {
								if (tombstone.inputHash !== inputHash) throw new TerminalIdempotencyConflictError();
								existingReplay = tombstone;
								return { scopes: state.scopes, keys: state.keys };
							}
							const retained = state.scopes.filter(
								s => !(s.idempotencyKeyHash === keyHash && s.idempotencyInputHash === inputHash),
							);
							const preBound: DurableTerminalScopeRecord[] = [
								...retained,
								{
									selection: scope,
									idempotencyKeyHash: keyHash,
									idempotencyInputHash: inputHash,
									// Idle reservations write a TRANSITIONAL reserved disposition: the
									// prompt may become active while the reservation is awaited, and a
									// duplicate must never claim no_active_turn over a provisional row
									// — the row is finalized to plain no_effect only when the recheck
									// confirms no active turn. Marker-failure reservations use a
									// distinct final disposition so replay returns the SAME no_effect
									// result instead of a fabricated no_active_turn (review thread
									// P2).
									turnDisposition:
										reason === "marker_failure" ? "no_effect_marker_failure" : "no_effect_reserved",
									ownedWorkDisposition: "not_requested",
									automaticDeliveryDisposition: scope === "turn" ? "enabled" : "none",
									resumeOnOwnedCompletion: scope === "turn",
									turnContinuationFence: {
										state: "retained",
										abortedAttemptEpoch: 0,
										blockedContinuationIds: [],
										predecessorTombstones: [],
										ownedCompletionPolicy: scope === "turn" ? "enabled" : "disabled",
									},
									responseState: "pending",
									// marker_failure rows are FINAL as written (the abort
									// returns the public no_effect result immediately, with no
									// later finalization), so store the public payload hash;
									// idle reservations are finalized by
									// finalizeNoEffectReservation (review thread P2).
									responsePayloadHash:
										reason === "marker_failure"
											? hashResult({
													ok: true,
													selection: scope,
													turn: "no_effect",
													terminal: "terminal_no_effect",
												})
											: inputHash,
									acceptedAt: Date.now(),
								} satisfies DurableTerminalScopeRecord,
							];
							// Compact key tombstones for rows evicted by the cap are
							// retained ATOMICALLY with the scope write (review thread P2).
							return boundTerminalRetentionState(state.keys, preBound);
						});
						return "ok";
					} catch (error) {
						if (error instanceof TerminalIdempotencyConflictError) return "conflict";
						logger.warn(`sdk: terminal no-effect reservation failed: ${String(error)}`);
						return "failed";
					}
				};
				let active = [...promptSubmissions.entries()].find(
					([, submission]) => submission.connectionId === connectionId && !submission.terminal,
				);
				if (!active) {
					// DURABLY reserve the key even for a no-active-turn abort: the
					// generic idempotency cache is in-memory only, so after restart
					// or eviction a same-key retry while a later prompt is active
					// must replay this no-effect row instead of aborting an
					// unrelated turn (review thread P2). No active turn means no
					// fence epoch; the marker uses sentinel 0. The reservation is
					// bounded (see reserveTerminalNoEffect).
					const reservation = await reserveTerminalNoEffect();
					if (reservation === "conflict") return { ok: false as const, reason: "conflict" as const };
					if (reservation === "failed") {
						// Without the durable reservation a same-key retry after
						// eviction/restart could abort an unrelated later turn, so a
						// failed reservation must NOT report success.
						return { ok: false as const, reason: "reservation_failed" as const };
					}
					// A SAME-input row/tombstone existed while the reservation awaited
					// the store: it is durable replay authority — replay its stored
					// result instead of returning no_active_turn over it (review
					// thread P2).
					if (existingReplay) return replayExisting(existingReplay);
					// RE-SCAN after the async reservation: the requester's prompt may
					// have moved from preflight to accepted during the filesystem
					// write. Returning no_active_turn here would leave the accepted
					// prompt to start (its pending-preflight entry may already be
					// removed, so the surface cleanup skips both cancellation seams)
					// and the durable no-effect row would block a same-key retry from
					// stopping it — fall through to the pre-run / active fencing path
					// when a submission now exists (review thread P1).
					active = [...promptSubmissions.entries()].find(
						([, submission]) => submission.connectionId === connectionId && !submission.terminal,
					);
					if (!active) {
						// Close the remaining acceptance race: cancel the requester's
						// preflights HERE, in the same synchronous region as the
						// rescan (no await boundary between the scan and the cancel,
						// as the surface-level post-check had), so a prompt accepted
						// in that window cannot start with its preflight entry
						// already removed (review thread P1).
						if (preflightCancel?.hasPending()) {
							preflightCancel.cancel();
							// The seam cancels the SESSION-WIDE preflight controller:
							// invoke it only when no OTHER connection has a pending
							// admission, or this queued requester's abort would fail an
							// unrelated connection's active preflight (review thread P1).
							if (noOtherConnectionPreflights?.() !== false)
								terminalAbortSeams?.cancelPendingPreflightForTerminalAbort?.();
						}
						// No prompt won the race: finalize the reserved row so a later
						// same-key retry (including after restart) replays this
						// deterministic no_active_turn result instead of reservation
						// uncertainty (review thread P2).
						const no_active_turnResult = { ok: true as const, outcome: "no_active_turn" as const };
						// Hash the PUBLIC disposition the client receives (abortTerminal
						// transforms the outcome into {ok,selection,turn,terminal}); the
						// response-state observer hashes response.result, so hashing the
						// internal outcome shape could never match (review thread P2).
						await finalizeNoEffectReservation(
							hashResult({ ok: true, selection: scope, turn: "no_active_turn", terminal: "terminal_no_effect" }),
						);
						return no_active_turnResult;
					}
				}
				const [commandId, turnId] = active[0].split(":", 2);
				if (!commandId || !turnId) {
					const reservation = await reserveTerminalNoEffect();
					if (reservation === "conflict") return { ok: false as const, reason: "conflict" as const };
					if (reservation === "failed") {
						// Same durable-reservation guarantee as the no-active path.
						return { ok: false as const, reason: "reservation_failed" as const };
					}
					if (existingReplay) return replayExisting(existingReplay);
					const already_terminalResult = { ok: true as const, outcome: "already_terminal" as const };
					// Hash the PUBLIC disposition the client receives (abortTerminal
					// transforms the outcome into {ok,selection,turn,terminal}); the
					// response-state observer hashes response.result, so hashing the
					// internal outcome shape could never match (review thread P2).
					await finalizeNoEffectReservation(
						hashResult({ ok: true, selection: scope, turn: "no_active_turn", terminal: "terminal_no_effect" }),
					);
					return already_terminalResult;
				}
				// Accepted-but-not-started window: the submission exists but
				// agent_start has not bound executionHandle yet, and the preflight
				// cancellation entry was already removed after accept. Cancel the
				// in-flight session preflight so the pending #promptWithMessage
				// cannot continue into the agent, and FINALIZE the accepted prompt
				// as a pre-run client cancellation WITHOUT terminalizing — there is
				// no run handle to fence, and terminalizePrompt's missing-handle
				// fail-closed path would wrongly fence the SDK connection and leave
				// reconciliation unfinalized for a prompt that will never run
				// (review thread P2).
				if (!active[1].executionHandle) {
					// Persist the durable no-effect reservation BEFORE cancelling the
					// session preflight: a failed reservation must NOT leave the
					// prompt cancelled with no durable row (a later same-key retry
					// after eviction/restart could then abort an unrelated turn —
					// review thread P2).
					const reservation = await reserveTerminalNoEffect();
					if (reservation === "conflict") return { ok: false as const, reason: "conflict" as const };
					if (reservation === "failed") {
						return { ok: false as const, reason: "reservation_failed" as const };
					}
					if (existingReplay) return replayExisting(existingReplay);
					// RECHCK after the async write: agent_start may have bound the
					// execution handle during the reservation, so this is no longer
					// a pre-run cancellation — fall through to the ACTIVE-turn
					// fencing path below (terminalizePrompt with fence) instead of
					// finalizing without abortPromptAndWait (review thread P2).
					if (!active[1].executionHandle) {
						// REVALIDATE the captured submission: another abort may have
						// terminalized it during the reservation while a NEW prompt
						// entered preflight — cancelling the session-global preflight
						// for the stale capture would abort that unrelated prompt.
						// Only proceed when this exact nonterminal submission is still
						// authoritative (review thread P1).
						const currentSubmission = promptSubmissions.get(promptSubmissionKey({ commandId, turnId }));
						if (currentSubmission !== active[1] || currentSubmission.terminal) {
							// The captured submission is no longer authoritative: finalize
							// our provisional reservation so the durable row reflects the
							// settled outcome rather than lingering mid-transition (review
							// thread P2).
							const already_terminalResult = { ok: true as const, outcome: "already_terminal" as const };
							// Hash the PUBLIC disposition the client receives (abortTerminal
							// transforms the outcome into {ok,selection,turn,terminal}); the
							// response-state observer hashes response.result, so hashing the
							// internal outcome shape could never match (review thread P2).
							await finalizeNoEffectReservation(
								hashResult({
									ok: true,
									selection: scope,
									turn: "no_active_turn",
									terminal: "terminal_no_effect",
								}),
							);
							return already_terminalResult;
						}
						if (preflightCancel?.hasPending()) {
							preflightCancel.cancel();
							// The seam cancels the SESSION-WIDE preflight controller:
							// invoke it only when no OTHER connection has a pending
							// admission (review thread P1).
							if (noOtherConnectionPreflights?.() !== false)
								terminalAbortSeams?.cancelPendingPreflightForTerminalAbort?.();
						}
						await terminalizePrompt(
							{ commandId, turnId },
							{ kind: "stopped", reason: "cancelled", provenance: "client_cancel" },
							{},
						);
						// No prompt won the race: finalize the reserved row so a later
						// same-key retry replays this deterministic no_active_turn result
						// instead of reservation uncertainty (review thread P2).
						const no_active_turnResult = { ok: true as const, outcome: "no_active_turn" as const };
						// Hash the PUBLIC disposition the client receives (abortTerminal
						// transforms the outcome into {ok,selection,turn,terminal}); the
						// response-state observer hashes response.result, so hashing the
						// internal outcome shape could never match (review thread P2).
						await finalizeNoEffectReservation(
							hashResult({ ok: true, selection: scope, turn: "no_active_turn", terminal: "terminal_no_effect" }),
						);
						return no_active_turnResult;
					}
				}
				// Plan ordered step 4: write the bounded INITIAL MARKER (key/input
				// hashes, pending dispositions, publication false, response pending)
				// BEFORE any fence/stop/event effect, so a crash between the stop
				// and the semantic CAS still leaves a same-key retry that replays
				// deterministically instead of re-running effects. Marker failure is
				// process-local no-effect (AC 10) — nothing destructive has run yet.
				const markerEpoch = terminalAbortSeams?.getTerminalTurnEpoch?.();
				if (markerEpoch === undefined) return { ok: true as const, outcome: "no_effect" as const };
				let pendingReplay: DurableTerminalScopeRecord | undefined;
				let tombstoneReplay: EvictedTerminalKeyEntry | undefined;
				try {
					// Write the marker and any evicted-row key tombstones in ONE
					// atomic document transaction so a crash cannot leave the
					// durable store with neither the row nor its tombstone
					// (review thread P2). The marker itself stays pending (never
					// evicted); only completed rows are bounded.
					await durableStore.transactTerminalState(state => {
						// Atomic recheck: a concurrent request may have committed a
						// DIFFERENT input under this key after the earlier snapshot
						// check (dispatch-cache eviction), and the filter below must
						// never wipe that row — replacing it would let a later replay
						// of the SUCCEEDED request report a conflict (review thread
						// P2). A same-input PENDING row is an in-flight duplicate:
						// replay it instead of installing a second marker, so the
						// duplicate cannot race terminalization and flip the row to
						// uncertain while the original returns stopped (review
						// thread P2).
						const conflicting = state.scopes.find(s => keyHash && s.idempotencyKeyHash === keyHash);
						if (conflicting) {
							if (conflicting.idempotencyInputHash !== inputHash) throw new TerminalIdempotencyConflictError();
							if (conflicting.turnDisposition === "pending") {
								pendingReplay = conflicting;
								return { scopes: state.scopes, keys: state.keys };
							}
						}
						// A concurrent admission may ALSO have evicted a same-key row
						// into the tombstone collection after this request's snapshot;
						// recheck keys so a different input can never install a fresh
						// marker over existing durable replay authority (review
						// thread P2). A same-input tombstone already carries replay
						// authority: never install a second marker here.
						const tombstone = state.keys.find(s => keyHash && s.keyHash === keyHash);
						if (tombstone) {
							if (tombstone.inputHash !== inputHash) throw new TerminalIdempotencyConflictError();
							tombstoneReplay = tombstone;
							return { scopes: state.scopes, keys: state.keys };
						}
						const retained = state.scopes.filter(s => !(keyHash && s.idempotencyKeyHash === keyHash));
						const preBound: DurableTerminalScopeRecord[] = [
							...retained,
							{
								selection: scope,
								...(keyHash ? { idempotencyKeyHash: keyHash, idempotencyInputHash: inputHash } : {}),
								turnDisposition: "pending",
								terminalPublished: false,
								ownedWorkDisposition: "not_requested",
								automaticDeliveryDisposition: scope === "turn" ? "enabled" : "none",
								resumeOnOwnedCompletion: scope === "turn",
								turnContinuationFence: {
									state: "retained",
									abortedAttemptEpoch: markerEpoch,
									blockedContinuationIds: [],
									predecessorTombstones: [],
									ownedCompletionPolicy: scope === "turn" ? "enabled" : "disabled",
								},
								responseState: "pending",
								responsePayloadHash: inputHash,
								acceptedAt: Date.now(),
							} satisfies DurableTerminalScopeRecord,
						];
						return boundTerminalRetentionState(state.keys, preBound);
					});
				} catch (error) {
					if (error instanceof TerminalIdempotencyConflictError) {
						// A different input won the durable key race inside the
						// transaction; reject rather than replacing its row.
						return { ok: false as const, reason: "conflict" as const };
					}
					logger.warn(`sdk: terminal initial marker persistence failed: ${String(error)}`);
					// No durable marker exists: do NOT acknowledge success without a
					// durable row — a same-key retry after restart/expiry would miss
					// replay and could abort an unrelated later prompt. Persist a
					// bounded marker-failure reservation first (review thread P2).
					const reservation = await reserveTerminalNoEffect("marker_failure");
					if (reservation === "conflict") return { ok: false as const, reason: "conflict" as const };
					if (reservation === "failed") {
						return { ok: false as const, reason: "reservation_failed" as const };
					}
					if (existingReplay) return replayExisting(existingReplay);
					return { ok: true as const, outcome: "no_effect" as const };
				}
				if (pendingReplay) {
					// An in-flight duplicate of this exact key+input was already
					// admitted; replay its pending row WITHOUT re-running the stop,
					// cleanup, or event.
					return {
						ok: true as const,
						outcome: "pending_replay" as const,
						stored: {
							responseState: pendingReplay.responseState,
							responsePayloadHash: pendingReplay.responsePayloadHash,
							terminalPublished: pendingReplay.terminalPublished === true,
						},
					};
				}
				if (tombstoneReplay) {
					// The key gained durable replay authority via an eviction
					// tombstone while this request was in flight; never install a
					// second marker or run the stop. Reconstruct the ORIGINAL stored
					// result exactly as the same-key replay path would (review
					// thread P2).
					const storedRow = {
						responseState: tombstoneReplay.responseState ?? "",
						responsePayloadHash: tombstoneReplay.responsePayloadHash ?? "",
						terminalPublished: tombstoneReplay.terminalPublished === true,
					};
					if (tombstoneReplay.turnDisposition === "stopped") {
						return {
							ok: true as const,
							outcome: (tombstoneReplay.ownedWorkDisposition === "stopped" ? "stopped_owned" : "stopped") as
								| "stopped"
								| "stopped_owned",
							stored: storedRow,
						};
					}
					if (tombstoneReplay.turnDisposition === "uncertain") {
						return { ok: true as const, outcome: "uncertain_replay" as const, stored: storedRow };
					}
					if (tombstoneReplay.turnDisposition === "no_effect_marker_failure") {
						return { ok: true as const, outcome: "no_effect" as const, stored: storedRow };
					}
					return { ok: true as const, outcome: "no_effect_replay" as const, stored: storedRow };
				}
				const captured: {
					proof?: RunSettlementProof & {
						terminalScope?: { scopeId: string; abortedAttemptEpoch: number; lineageIdHash: string };
					};
					published?: boolean;
					terminalized?: boolean;
				} = {};
				await terminalizePrompt(
					{ commandId, turnId },
					{ kind: "stopped", reason: "cancelled", provenance: "client_cancel" },
					{
						fence: true,
						terminal: { scope, ...(steeringSnapshotToken !== undefined ? { steeringSnapshotToken } : {}) },
					},
					undefined,
					captured,
				);
				// Success is decided by the terminalizePrompt outcome, NOT by the
				// submission record: an already-acknowledged prompt is finalized
				// (deleted) during emission, so a lookup here can return undefined
				// even for a landed terminal (P1). fail-closed paths leave
				// terminalized unset.
				if (captured.terminalized !== true) {
					// A CONCURRENT abort won the shared submission: settle THIS
					// request's pending marker to a completed uncertainty state so
					// the retention bound can evict it — otherwise concurrent
					// distinct-key aborts leave pending rows that grow the
					// reconciliation document unboundedly until restart (review
					// thread P2).
					try {
						await transactBoundedTerminalScopes(scopes =>
							scopes.map(scopeRecord => {
								const isMarker =
									(keyHash !== undefined && scopeRecord.idempotencyKeyHash === keyHash) ||
									(keyHash === undefined &&
										scopeRecord.selection === scope &&
										scopeRecord.turnDisposition === "pending");
								if (!isMarker) return scopeRecord;
								const responsePayloadHash = hashPublicUncertain("worker_unsettled");
								return {
									...scopeRecord,
									turnDisposition: "uncertain" as const,
									ownedWorkDisposition: "uncertain" as const,
									// Hash the public worker_unsettled disposition the client
									// receives, or the response can never advance the row
									// (review thread P2).
									responsePayloadHash,
									// A same-key retry delivers the replay envelope (with the
									// replay reason); store its hash so the written replay can
									// advance the row (review thread P2).
									replayPayloadHash: hashResult({
										ok: true,
										selection: scope,
										turn: "uncertain",
										ownedWork: scope === "turn" ? "left_running" : "uncertain",
										automaticDelivery: scope === "turn" ? "enabled" : "none",
										resumeOnOwnedCompletion: scope === "turn",
										reason: "replay_uncertain",
										replay: {
											responseState: "pending",
											responsePayloadHash,
											terminalPublished: captured.published === true,
										},
									}),
									// Preserve the captured publication bit: if agent_end
									// was already published before settlement failed, the
									// implementation will NOT publish a second event, so the
									// durable row must not claim publication never occurred
									// (review thread P2).
									terminalPublished: captured.published === true,
								};
							}),
						);
					} catch (error) {
						logger.warn(`sdk: terminal losing-marker settle failed: ${String(error)}`);
					}
					return { ok: false as const, reason: "worker_unsettled" as const };
				}
				// For scope:"owned", stop the exact captured owned work and prove
				// quiescence before claiming stopped. Exactness comes from the
				// registered five-tuples of this turn's lineage+epoch; foreign or
				// unclassified work is never swept and yields uncertainty.
				const terminalScope = captured.proof?.terminalScope;
				let ownedStopped = true;
				// Owned settlement failed (incomplete authority, unavailable
				// manager, or a job that did not unwind within the grace):
				// transition this request's PENDING marker to completed
				// uncertainty BEFORE returning — otherwise distinct-key retries
				// accumulate non-evictable pending rows and same-key retries
				// misleadingly replay pending (review thread P2).
				const settleMarkerToUncertain = async (
					reason: "worker_unsettled" | "owned_unsettled",
				): Promise<{ ok: false; reason: "worker_unsettled" | "owned_unsettled" }> => {
					// The EXACT response payload is stored at finalization so the
					// response-state advance requires equality (review thread P2).
					// The EXACT PUBLIC payload is stored at finalization: abortTerminal
					// maps {ok:false, reason} to the uncertain disposition the client
					// receives, and the response-state observer hashes response.result,
					// so the internal outcome shape can never match (review thread P2).
					const result = { ok: false as const, reason };
					const responsePayloadHash = hashPublicUncertain(reason);
					// A same-key retry delivers the replay envelope (with the replay
					// reason); store its hash so the written replay can advance the
					// row (review thread P2).
					const replayPayloadHash = hashResult({
						ok: true,
						selection: scope,
						turn: "uncertain",
						ownedWork: scope === "turn" ? "left_running" : "uncertain",
						automaticDelivery: scope === "turn" ? "enabled" : "none",
						resumeOnOwnedCompletion: scope === "turn",
						reason: "replay_uncertain",
						replay: {
							responseState: "pending",
							responsePayloadHash,
							terminalPublished: captured.published === true,
						},
					});
					try {
						await transactBoundedTerminalScopes(scopes =>
							scopes.map(scopeRecord => {
								const isMarker =
									(keyHash !== undefined && scopeRecord.idempotencyKeyHash === keyHash) ||
									(keyHash === undefined &&
										scopeRecord.selection === scope &&
										scopeRecord.turnDisposition === "pending");
								if (!isMarker) return scopeRecord;
								return {
									...scopeRecord,
									turnDisposition: "uncertain" as const,
									ownedWorkDisposition: "uncertain" as const,
									responsePayloadHash,
									replayPayloadHash,
									// Preserve the captured publication bit: if agent_end
									// was already published before settlement failed, the
									// implementation will NOT publish a second event, so the
									// durable row must not claim publication never occurred
									// (review thread P2).
									terminalPublished: captured.published === true,
								};
							}),
						);
					} catch (error) {
						logger.warn(`sdk: terminal owned-uncertain marker settle failed: ${String(error)}`);
					}
					return result;
				};
				const settleOwnedUncertain = async () => await settleMarkerToUncertain("owned_unsettled");
				if (!terminalScope) {
					// The terminal scope was NOT registered (process-wide
					// saturation refused admission): no continuation fence bounds
					// the aborted turn. FAIL CLOSED to uncertainty — never report
					// stopped/stopped_owned without a registered fence (review
					// thread P2).
					return await settleMarkerToUncertain("worker_unsettled");
				}
				if (scope === "owned") {
					// The attempt's registration set may be KNOWN incomplete
					// (registry saturation skipped a tuple under the 8192 cap):
					// fail closed to uncertainty instead of settling an
					// incomplete set and claiming stopped_owned while a live job
					// keeps running (review thread P2).
					if (
						terminalScope &&
						isOwnedAttemptRegistrationIncomplete(terminalScope.lineageIdHash, terminalScope.abortedAttemptEpoch)
					) {
						return await settleOwnedUncertain();
					}
					const exactJobs = terminalScope
						? findOwnedRegistrationsForTurn(terminalScope.lineageIdHash, terminalScope.abortedAttemptEpoch)
						: [];
					if (exactJobs.length > 0) {
						// Resolve the manager from the ABORTING ENDPOINT (session)
						// captured on the registrations — the process-global
						// instance is the last-created session, so using it could
						// cancel another session's same-id foreign job and report
						// stopped_owned while the aborting session's job keeps
						// running (review thread P1). Fall back to the global for
						// legacy endpoint-less registrations.
						const endpointId = exactJobs[0]?.endpointId;
						const manager = AsyncJobManager.forEndpoint(endpointId) ?? AsyncJobManager.instance();
						if (!manager) {
							return await settleOwnedUncertain();
						}
						ownedStopped = (await settleOwnedWork(manager, exactJobs, OWNED_SETTLEMENT_GRACE_MS)) === "stopped";
						if (!ownedStopped) return await settleOwnedUncertain();
					}
				}
				// Semantic CAS: advance the INITIAL MARKER (matched by key hash, or
				// by selection+epoch when keyless) to the final dispositions through
				// the same full-document owner (plan step 15). The prompt terminal
				// is already durable; a failed write fails closed to safe
				// uncertainty — never a stopped disposition the record cannot prove.
				try {
					await transactBoundedTerminalScopes(scopes =>
						scopes.map(scopeRecord => {
							const isMarker =
								(keyHash !== undefined && scopeRecord.idempotencyKeyHash === keyHash) ||
								(keyHash === undefined &&
									scopeRecord.selection === scope &&
									scopeRecord.turnDisposition === "pending");
							if (!isMarker) return scopeRecord;
							const ownedWorkDisposition =
								scope === "turn" ? "left_running" : ownedStopped ? "stopped" : "uncertain";
							// Hash the EXACT public result the client receives: the surface
							// returns {ok: true, selection, turn, ...} and the delivery
							// observer hashes response.result, so the stored hash must
							// include ok or payloadMatches would never match a fresh
							// stopped/stopped_owned response and the durable responseState
							// would stay pending after a successful write (review thread
							// P2).
							const payloadHash = crypto
								.createHash("sha256")
								.update(
									JSON.stringify({
										ok: true,
										selection: scope,
										turn: "stopped",
										ownedWork: ownedWorkDisposition,
										automaticDelivery: scope === "turn" ? "enabled" : "none",
										resumeOnOwnedCompletion: scope === "turn",
									}),
								)
								.digest("hex");
							// A same-key retry delivers the replay envelope; store its
							// hash too so a written replay can advance the pending row
							// (review thread P2).
							const replayPayloadHash = crypto
								.createHash("sha256")
								.update(
									JSON.stringify({
										ok: true,
										selection: scope,
										turn: "stopped",
										ownedWork: ownedWorkDisposition,
										automaticDelivery: scope === "turn" ? "enabled" : "none",
										resumeOnOwnedCompletion: scope === "turn",
										replay: {
											responseState: "pending",
											responsePayloadHash: payloadHash,
											terminalPublished: captured.published === true,
										},
									}),
								)
								.digest("hex");
							return {
								...scopeRecord,
								turnDisposition: "stopped" as const,
								terminalPublished: captured.published === true,
								ownedWorkDisposition,
								turnContinuationFence: {
									...scopeRecord.turnContinuationFence,
									abortedAttemptEpoch:
										terminalScope?.abortedAttemptEpoch ??
										scopeRecord.turnContinuationFence.abortedAttemptEpoch,
								},
								responsePayloadHash: payloadHash,
								replayPayloadHash,
								terminalAt: Date.now(),
							};
						}),
					);
				} catch (error) {
					logger.warn(`sdk: terminal scope persistence failed: ${String(error)}`);
					// The prompt terminalization succeeded but the final marker
					// write failed: best-effort transition the pending marker to
					// completed uncertainty so same-key retries do not replay a
					// stale pending row and repeated failures do not accumulate
					// non-evictable rows (review thread P2).
					return await settleMarkerToUncertain("worker_unsettled");
				}
				if (scope === "owned") {
					return { ok: true as const, outcome: "stopped_owned" as const };
				}
				return { ok: true as const, outcome: "stopped" as const };
			},
			{
				admit: (clientRef?: string) => kindReconciliation.admit("skill", clientRef),
				release: (clientRef?: string) => kindReconciliation.releaseAdmission("skill", clientRef),
				noteAccepted: (correlation, clientRef, extra) =>
					kindReconciliation.noteAccepted("skill", correlation, clientRef, extra),
				cancel: async correlation => {
					const outcome = await kindReconciliation.claimPendingOutcome("skill", correlation, {
						kind: "stopped",
						reason: "cancelled",
						provenance: "client_cancel",
					});
					await kindReconciliation.finalizeOutcome("skill", correlation, outcome);
				},
				noteTransition: (correlation, frame) => kindReconciliation.noteTransition("skill", correlation, frame),
				lookup: selector => kindReconciliation.lookup("skill", selector),
				reserveSteer: kindReconciliation.reserveSteer,
				settleSteer: kindReconciliation.settleSteer,
			},
			terminalAbortSeams,
			// #4743: join fire-and-forget reconciliation producers at teardown.
			trackReconciliationProducer,
		);
		cancelPreflightsForConnection = controlSurface.cancelPendingPreflightsForConnection;
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

		const sendSdkFrame = (connectionId: string, frame: Record<string, unknown>): "written" | "dropped" => {
			if (extensionShuttingDown || runtime?.stopping || runtimes.get(id) !== runtime) {
				// Deliberate drop (AC 17/20): no write, no post-write hook, no fallback.
				abandonPromptResponse(connectionId, frame);
				return "dropped";
			}
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
				return "written";
			}
			try {
				server.sendTo(connectionId, json);
			} catch (error) {
				logger.warn(`sdk: directed response delivery failed for ${connectionId}: ${String(error)}`);
				abandonPromptResponse(connectionId, frame);
				throw error;
			}
			return "written";
		};

		/**
		 * Existing-thread preparation.
		 *
		 * A prepared session withholds its readiness signal so
		 * `gjc notify bind-thread` can adopt an operator-supplied Slack root before
		 * any stock root is published; activation then publishes readiness once and
		 * the daemon adopts that root.
		 *
		 * Preparation has exactly two authorities, and they never overlap. A
		 * broker lifecycle-managed session is prepared only by the broker-issued,
		 * session-scoped readiness intent on its launch request, which the
		 * lifecycle wait completes on the prepared signal instead of readiness. A
		 * manual/source session keeps the explicit `GJC_NOTIFY_BIND_EXISTING_THREAD`
		 * opt-in, which is refused for lifecycle-managed sessions so an inherited
		 * process-global flag can never silently defer a broker-created session.
		 *
		 * The activation gate is the existing-thread bind authority itself: it
		 * proves a daemon-owned mapping exists at this exact endpoint generation,
		 * so activation before a binding fails closed with no grace period. It can
		 * only be built from a configured, enabled Slack target plus the agent
		 * directory holding that mapping, so a preparation request that cannot
		 * produce one has no bind authority at all and is refused here. Degrading
		 * such a request to ordinary immediate readiness would answer "prepare" with
		 * a session that publishes its own root anyway, and preparing without the
		 * gate would hand back a prepared session that activates with no binding.
		 */
		const preparationAgentDir = settings?.getAgentDir?.();
		const slackBindTarget =
			notificationsEnabledForSession && isSlackComplete(cfg)
				? { teamId: cfg.slack.workspaceId, channelId: cfg.slack.channelId }
				: undefined;
		const envRequestsPreparation = isExistingThreadBindingRequested(process.env);
		if (envRequestsPreparation && lifecycleRequired)
			return failLifecycleStartup(
				"failed",
				`${EXISTING_THREAD_BIND_ENV}=1 is not supported for broker lifecycle-managed sessions; use the broker readiness intent.`,
			);
		const preparesExistingThread = lifecycleRequired ? lifecycleReadiness === "deferred" : envRequestsPreparation;
		const activationGate =
			preparesExistingThread && preparationAgentDir && slackBindTarget
				? createSlackBindingActivationGate({
						store: new ConversationStore<SlackConversation>({ agentDir: preparationAgentDir, kind: "slack" }),
						teamId: slackBindTarget.teamId,
						channelId: slackBindTarget.channelId,
					})
				: undefined;
		if (preparesExistingThread && !activationGate) {
			const missing = slackBindTarget
				? "an agent directory"
				: "a configured Slack notification target for this session";
			if (lifecycleRequired)
				return failLifecycleStartup(
					"failed",
					`Existing-thread preparation requires ${missing} to prove the existing-thread binding.`,
				);
			throw new Error(`${EXISTING_THREAD_BIND_ENV}=1 requires ${missing} to prove the existing-thread binding.`);
		}

		sdkRuntime = new SessionSdkSessionRuntime({
			masterOwnerSessionId: options.masterOwnerSessionId,
			transport: {
				sessionId: id,
				stateRoot,
				token,
				sendFrame: (connectionId, frame) => sendSdkFrame(connectionId, frame),
				onFrame: handler => {
					inboundSdkFrame = handler as (connectionId: string, frame: SdkFrame) => void;
					return () => {
						inboundSdkFrame = undefined;
					};
				},
				start: async () => await server.start(),
				stop: async () => await server.stopAndWait(),
				broadcastFrame: frame => broadcastEventFrame(frame),
			},
			...(preparesExistingThread ? { readiness: "deferred" as const } : {}),
			...(activationGate ? { activationGate } : {}),
			...(settings ? { settings } : {}),
			...(configOverrides ? { configOverrides } : {}),
			masterCapabilityVerify: frame =>
				verifyMasterCapabilityFrame({
					frame,
					expectedCapability: options.masterCapability,
					expectedEpoch: options.masterAttestationEpoch,
					replay: consumedMasterNonces,
				}),
			connectionCapabilities: connectionId => hostCapCache.get(connectionId),
			installProviderDefinitions,
			onProviderDefinitionsRemoved: removeProviderDefinitions,
			onRequest: options.onSdkRequest,
			onControlResponseDelivery: async (_connectionId, request, response, outcome) => {
				// Terminal abort: persist the monotonic response-state transition
				// (AC 18) — pending -> sent on a written response, pending -> failed
				// on a rejected/dropped write. A same-key retry then replays the
				// stored disposition with the matching response state.
				if (
					request.operation === "turn.abort" &&
					typeof request.input === "object" &&
					request.input !== null &&
					(request.input as { mode?: unknown }).mode === "terminal" &&
					typeof request.idempotencyKey === "string" &&
					durableStore
				) {
					const keyHash = crypto.createHash("sha256").update(request.idempotencyKey).digest("hex");
					// Match the NORMALIZED terminal input hash too: a same-key
					// request with a different scope (conflict after in-memory
					// eviction) must never advance the ORIGINAL pending marker's
					// response state — only the response for the exact input that
					// produced the record may transition it (review thread P2).
					// Strictly validate first: a MALFORMED retry (e.g. scope:"bogus")
					// rejected by dispatch must not match a prior valid scope:"turn"
					// row through the "not owned => turn" fallback.
					const input = request.input as Record<string, unknown>;
					const mode = input.mode;
					const rawScope = input.scope;
					if (mode !== "terminal") return;
					if (rawScope !== undefined && rawScope !== "turn" && rawScope !== "owned") return;
					for (const key of Object.keys(input)) if (key !== "mode" && key !== "scope") return;
					const scopeInput = rawScope === "owned" ? "owned" : "turn";
					const inputHash = crypto
						.createHash("sha256")
						.update(JSON.stringify({ mode: "terminal", scope: scopeInput }))
						.digest("hex");
					try {
						// Same hydration barrier as the abort path: never race a still
						// pending store load with the response-state transition (P2).
						await reconciliationReady;
						// Update the matching LIVE scope OR its evicted compact
						// tombstone atomically: if the row was moved to
						// evictedTerminalKeys by the 256-row retention cap while this
						// write was in flight, scanning only live scope rows would
						// leave the tombstone responseState:"pending" and a same-key
						// replay after cache expiry/restart would report a false
						// durable delivery state (review thread P2).
						// Hash the ACTUAL written response payload: the durable state may only
						// advance when the written response corresponds to the row's payload.
						// When more than 256 concurrent requests evict an in-flight abort from
						// the dispatch cache, a same-key retry can return pending_replay while
						// the original is still terminalizing — matching only key+input would
						// mark the original marker sent for the retry's uncertainty response,
						// and the original's later stopped CAS would replace the payload hash
						// without resetting the state, making durable replay claim the stopped
						// payload was sent when only the pending response was written (review
						// thread P2). A final non-pending row whose stored hash is the input
						// placeholder (no_effect/uncertain) still advances: its own response is
						// the only one written for it.
						const responsePayloadHash =
							response && typeof response === "object" && "result" in response
								? crypto
										.createHash("sha256")
										.update(JSON.stringify((response as { result: unknown }).result))
										.digest("hex")
								: undefined;
						// Require EXACT payload equality: finalization now stores the precise
						// final response hash for every disposition (including uncertainty and
						// no-effect), so a pending_replay retry whose payload differs can never
						// mark the durable row sent (review thread P2). A same-key retry
						// delivers the replay-shaped payload (replay envelope, and the replay
						// reason for uncertainty), so finalization also stores its hash and the
						// written replay response advances the row exactly like the original
						// response would (review thread P2).
						const payloadMatches = (record: { responsePayloadHash?: string; replayPayloadHash?: string }) =>
							responsePayloadHash !== undefined &&
							(record.responsePayloadHash === responsePayloadHash ||
								record.replayPayloadHash === responsePayloadHash);
						const nextResponseState: "sent" | "failed" = outcome === "written" ? "sent" : "failed";
						await durableStore.transactTerminalState(state => ({
							scopes: state.scopes.map(scope =>
								scope.idempotencyKeyHash === keyHash &&
								scope.idempotencyInputHash === inputHash &&
								scope.responseState === "pending" &&
								payloadMatches(scope)
									? { ...scope, responseState: nextResponseState }
									: scope,
							),
							keys: state.keys.map(key =>
								key.keyHash === keyHash &&
								key.inputHash === inputHash &&
								key.responseState === "pending" &&
								payloadMatches(key)
									? { ...key, responseState: nextResponseState }
									: key,
							),
						}));
					} catch (error) {
						logger.warn(`sdk: terminal response-state persistence failed: ${String(error)}`);
					}
				}
			},
			beforeControlResponse: async (_connectionId, request, response, sendTerminal) => {
				if (typeof request.operation !== "string" || !identityControlOperations.has(request.operation)) return;
				const pending = deferredIdentityRotation;
				deferredIdentityRotation = undefined;
				identityControlInFlight = false;
				if (response.ok !== true || !pending) return;

				const predecessorId = activeRuntimeId ?? sessionIdFromFile(pending.event.previousSessionFile);
				if (!predecessorId) throw new Error("notifications: identity control predecessor is unknown.");
				let terminalAttempted = false;
				let terminalOutcome: TerminalSendOutcome | undefined;
				try {
					terminalOutcome = await runIdentityControlSuccessPath({
						fence: () => {
							const predecessor = runtimes.get(predecessorId);
							if (!predecessor || predecessor.stopping || predecessor.serverStopped)
								throw new Error(`notifications: predecessor runtime ${predecessorId} cannot be fenced.`);
							predecessor.inboundFenced = true;
						},
						ensurePredecessorSendCapable: () => {
							const predecessor = runtimes.get(predecessorId);
							if (!predecessor || predecessor.stopping || predecessor.serverStopped)
								throw new Error(`notifications: predecessor runtime ${predecessorId} is not send-capable.`);
						},
						startSuccessor: async () => {
							const successorId = sessionId(pending.ctx);
							try {
								await rotateSessionAuthority(pending.event, pending.ctx, true, {
									deferPredecessorStop: true,
								});
								const successor = runtimes.get(successorId);
								if (!successor?.host.started || activeRuntimeId !== successorId)
									throw new Error(`notifications: successor runtime ${successorId} was not ready.`);
							} catch (error) {
								(response as Record<string, unknown>).ok = false;
								delete (response as Record<string, unknown>).result;
								(response as Record<string, unknown>).error = {
									code: "unavailable",
									message: error instanceof Error ? error.message : "Successor session was not ready.",
								};
							}
						},
						sendTerminal: async () => {
							terminalAttempted = true;
							try {
								await sendTerminal();
								return "written";
							} catch {
								return "write_failed";
							}
						},
						stopPredecessor: async () => {
							try {
								await stopSession(predecessorId);
							} catch (error) {
								if (!terminalAttempted) throw error;
								logger.error(`notifications: deferred predecessor cleanup failed: ${String(error)}`);
							}
						},
						requireNativeControlDrain:
							(request as { requireNativeControlDrain?: unknown }).requireNativeControlDrain === true,
					});
				} catch (error) {
					if (!terminalAttempted) throw error;
					logger.error(
						`notifications: identity terminal delivery failed (${terminalOutcome ?? "unknown"}): ${String(error)}`,
					);
				}
			},
			afterControlResponse: async (connectionId, request, response) => {
				if (
					(request.operation === "turn.prompt" ||
						request.operation === "turn.follow_up" ||
						request.operation === "turn.abort_and_prompt" ||
						request.operation === "skill.invoke") &&
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
				const requireNativeControlDrain =
					(request as { requireNativeControlDrain?: unknown }).requireNativeControlDrain === true ||
					(!!request.input &&
						typeof request.input === "object" &&
						!Array.isArray(request.input) &&
						(request.input as { requireNativeControlDrain?: unknown }).requireNativeControlDrain === true);
				if (requireNativeControlDrain && !isNativeControlDrainAvailable())
					return {
						id: requestId,
						ok: false,
						error: {
							code: "unavailable",
							message: "SDK identity control requires the native control-drain lease.",
						},
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
		if (isAutoroutingInactive(api)) markAutoroutingInactive(sdkRuntime.host);
		host = sdkRuntime.host;

		// Install the runtime before either transport can expose the host. session_start
		// is deliberately fire-and-forget, so agent lifecycle events and direct v3
		// seam replies can otherwise arrive between server.start() and the old
		// registration below. Keeping this state live first makes those frames
		// replayable rather than dropping them (or dereferencing an absent runtime).
		runtime = {
			server,
			host,
			broadcastEventFrame,
			broadcastEventFrameWithReceipts,
			revisions,
			cursors,
			id,
			endpointScope: isolateChatEndpoint ? "chat" : "default",
			idleSeq: 0,
			stopSessionNameObserver: () => {},
			pendingInteractive,
			brokerRegistrationActive: false,
			hostStopped: false,
			serverStopped: false,
			brokerRegistrationReleased: false,
			disposeAnswerSource: () => {},
			disposeFileSink: () => {},
			disposeGateListener: () => {},
			notificationsActive: false,
			notificationOwnerState: "ready",
			enableNotifications: () => {},
			disposeGateTerminalController: () => {},
			disposeAckRecoveryParticipant: () => {},
			// #4743: session teardown must observe durable quiescence of every
			// reconciliation transaction this runtime admitted, INCLUDING the ones
			// whose producers (accepted skill/prompt executions and their post-
			// response publications) are still running when teardown starts — an
			// empty queue proves nothing about work that has not been enqueued yet.
			// Order: join producers → join kind-aware mutations → join the store
			// chain (which also surfaces persistence-failure evidence). All under a
			// finite deadline whose expiry is reported as a NON-QUIESCENT result so
			// the caller records an owner-release failure instead of silently
			// treating a hung write as drained.
			drainDurableReconciliation: async (): Promise<{ timedOut: boolean; failures: unknown[] }> => {
				// One failed write surfaces twice by design — once as the producer's
				// rejection and once through the store's failure window — and both carry
				// the same coded error object, so identity dedupe keeps the reported
				// evidence at one entry per real failure without dropping distinct ones.
				const seen = new Set<unknown>();
				const failures: unknown[] = [];
				const record = (failure: unknown): void => {
					if (seen.has(failure)) return;
					seen.add(failure);
					failures.push(failure);
				};
				const quiescent = (async () => {
					while (true) {
						const producers = [...reconciliationProducers];
						// `allSettled` joins ALL producers even when one rejects, but its
						// results are INSPECTED: a rejected terminal publication is evidence
						// the caller must see, not something the join consumes before the
						// store's own failure window opens (#4743).
						for (const settled of await Promise.allSettled(producers))
							if (settled.status === "rejected") record(settled.reason);
						// Both drains below surface store-recorded persistence failures by
						// rejecting; collect and keep draining so one failed write cannot
						// hide a later producer's work from the join.
						try {
							await kindReconciliation.drain();
						} catch (e) {
							record(e);
						}
						// Direct store writes (terminal-scope response-state advance) bypass
						// the kind-aware chain; join them too.
						try {
							await durableStore?.drain?.();
						} catch (e) {
							record(e);
						}
						await Bun.sleep(0);
						if ([...reconciliationProducers].every(producer => producers.includes(producer))) {
							return { timedOut: false, failures };
						}
					}
				})();
				return await Promise.race([
					quiescent,
					// A deadline expiry reports the failures observed SO FAR alongside the
					// timeout: evidence already collected must not be dropped because the
					// remaining wait ran out.
					Bun.sleep(sdkReconciliationDrainTimeoutMs()).then(() => ({ timedOut: true, failures })),
				]);
			},
			disposeGateEmitterListener: () => {},
			trackGateResolution,
			waitForGateResolutionQuiescence: async () => {
				await Promise.allSettled(inFlightGateResolutions);
			},
			workflowGate: undefined,
			gatePresentations,
			stopping: false,
			inboundFenced: false,
			abortEphemeralTurns: () => {},
			disableEphemeralTurns: () => {},
			cancelPostmortemCleanup: () => {},

			redact: true,
			// Provisional policy withholds delivery. This is not a committed redaction
			// decision: terminal text may be retained in the bounded settlement window
			// until the parsed policy either clears it for redaction or activates it.
			committedRedact: false,
			policySuspended: true,
			verbosity: "lean",
			stream: false,
			settlementWindow: 0,
			policyGeneration: 0,
			workflowGatePublicationEpoch: 0,
			busy: false,
			pendingPromptCorrelations,
			pendingPromptCorrelationsBySdkRunToken,
			activePromptCorrelation: undefined,
			bindPromptExecutionHandle,
			peekPromptPendingOutcome: correlation => {
				const kind =
					promptSubmissions.get(promptSubmissionKey(correlation))?.reconciliationKind ?? ("prompt" as const);
				return kindReconciliation.peekPendingOutcome(kind, correlation);
			},
			terminalizePrompt: (correlation, outcome, extra) => terminalizePrompt(correlation, outcome, {}, extra),
			notePromptReconciliation: (correlation, frame) => {
				const kind = correlation
					? (promptSubmissions.get(promptSubmissionKey(correlation))?.reconciliationKind ?? ("prompt" as const))
					: "prompt";
				return kindReconciliation.noteTransition(kind, correlation, frame);
			},
			emitPromptFailure,
			emitPromptLifecycle,
			emitPromptEvent,
			pendingInbound: new Set<number>(),
			inFlightTools: new Map<
				string,
				{ toolName: string; args?: unknown; pendingPhase?: "completed" | "failed" | "cancelled" }
			>(),
			deferredInboundControls: [],
		};
		const initializedRuntime = runtime;
		runtimes.set(id, initializedRuntime);
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
				await stopSession(id, "session", initializedRuntime);
			} catch (error) {
				// stopSession fences the exact runtime before releasing its owners and records
				// the lifecycle rollback proof even when one release needs a later retry.
				logger.error(`notifications: SDK notification runtime cleanup failed: ${String(error)}`);
			}
		};

		const ephemeralTurns = new EphemeralTurnHost(sendSdkFrame, async (question, signal) => {
			if (!options.runBtwTurn) throw new Error("Ephemeral turns are unavailable.");
			const generation = initializedRuntime.policyGeneration;
			if (initializedRuntime.policySuspended) throw new Error("Notification policy is provisional.");
			const result = await options.runBtwTurn(question, signal);
			if (
				initializedRuntime.policySuspended ||
				initializedRuntime.policyGeneration !== generation ||
				runtimes.get(id) !== initializedRuntime
			)
				throw new Error("Notification policy changed during the ephemeral turn.");
			return result;
		});
		initializedRuntime.abortEphemeralTurns = () => ephemeralTurns.dispose();
		initializedRuntime.disableEphemeralTurns = () => ephemeralTurns.disable();
		const sendEndpointStale = (connectionId: string, frame: Record<string, unknown>) => {
			const id = typeof frame.id === "string" ? frame.id : undefined;
			if (!id) return;
			const error = { code: "endpoint_stale", message: "session endpoint is stale." };
			const responseType =
				frame.type === "control_request"
					? "control_response"
					: frame.type === "query_request"
						? "query_response"
						: frame.type === "global_request"
							? "global_response"
							: undefined;
			if (!responseType) return;
			try {
				server.sendTo(connectionId, JSON.stringify({ type: responseType, id, ok: false, error }));
			} catch {}
		};
		const sendMalformed = (connectionId: string, message: string): void => {
			try {
				server.sendTo(
					connectionId,
					JSON.stringify({ type: "protocol_error", ok: false, error: { code: "invalid_frame", message } }),
				);
			} catch {}
		};
		const sendInboundAck = (
			connectionId: string,
			inbound: { sessionId: string; updateId?: number },
			state: "accepted" | "rejected" | "dropped",
			reason?: "inbound_fenced" | "policy_suspended" | "invalid_input" | "injection_failed",
		): void => {
			if (typeof inbound.updateId !== "number") return;
			try {
				server.sendTo(
					connectionId,
					JSON.stringify({
						type: "inbound_ack",
						sessionId: inbound.sessionId,
						updateId: inbound.updateId,
						state,
						...(reason ? { reason } : {}),
					}),
				);
			} catch {}
		};
		try {
			server.onSdkFrame((err, inbound) => {
				if (err) {
					if (inbound?.connectionId) sendMalformed(inbound.connectionId, err.message);
					return;
				}
				if (!inbound) return;
				try {
					const frame = JSON.parse(inbound.json) as unknown;
					if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
						sendMalformed(inbound.connectionId, "SDK frame must be a JSON object.");
						return;
					}
					const typedFrame = frame as Record<string, unknown>;
					if (typeof typedFrame.type !== "string" || typedFrame.type.length === 0) {
						sendMalformed(inbound.connectionId, "SDK frame type must be a non-empty string.");
						return;
					}
					if (inbound.connectionId && fencedConnections.has(inbound.connectionId)) {
						sendEndpointStale(inbound.connectionId, typedFrame);
						return;
					}
					if (initializedRuntime.inboundFenced) {
						sendEndpointStale(inbound.connectionId, typedFrame);
						return;
					}
					if (typedFrame.type === "ephemeral_turn" || typedFrame.type === "ephemeral_turn_cancel") return;
					if (typedFrame.type === "event_replay") {
						const capabilities = Array.isArray(typedFrame.capabilities) ? typedFrame.capabilities : [];
						hostCapCache.set(
							inbound.connectionId,
							new Set(capabilities.filter((capability): capability is string => typeof capability === "string")),
						);
					}
					inboundSdkFrame?.(inbound.connectionId, typedFrame);
				} catch (error) {
					sendMalformed(
						inbound.connectionId,
						error instanceof SyntaxError ? "SDK frame is not valid JSON." : String(error),
					);
				}
			});
			// Required: the negotiated-capability callback is how the TS host learns
			// each connection's caps for replay-frame gating. If the linked
			// @gajae-code/natives binary predates it (linked/deduped installs where the
			// version did not change), fail loudly with an actionable message instead of
			// silently shipping a half-wired capability bridge.
			if (typeof server.onNegotiatedCapabilities !== "function") {
				throw new Error(
					"@gajae-code/natives is out of date: missing onNegotiatedCapabilities. Rebuild the native addon (bun --cwd=packages/natives run build).",
				);
			}
			if (
				typeof server.supportsPositionedRawExclusion !== "function" ||
				server.supportsPositionedRawExclusion() !== true
			) {
				throw new Error(
					"@gajae-code/natives is out of date: missing positioned raw-fan-out exclusion. Rebuild the native addon (bun --cwd=packages/natives run build).",
				);
			}
			if (typeof server.sendToWithReceipt !== "function" || typeof server.queueIdleAfterDirected !== "function") {
				throw new Error(
					"@gajae-code/natives is out of date: missing recipient-bound dependent delivery. Rebuild the native addon (bun --cwd=packages/natives run build).",
				);
			}
			server.onNegotiatedCapabilities((_err, connectionId, capabilities) => {
				if (connectionId) hostCapCache.set(connectionId, new Set(capabilities));
			});
			server.onConnectionClose((_err, connectionId) => {
				if (!connectionId) return;
				void controlSurface
					.cancelPendingPreflightsForConnection(connectionId)
					.catch(error => logger.warn(`sdk: failed to cancel disconnected preflight: ${String(error)}`));
				host.handleDisconnect(connectionId);
				hostCapCache.delete(connectionId);
				// The socket is gone, so its fence has nothing left to refuse. Dropping the
				// entry keeps the set bounded by live connections instead of growing forever.
				fencedConnections.delete(connectionId);
				// Deliberate deviation from the plan's "claim prompt_failed on old-owner
				// disconnect": that would break the shipped Q26 reconnect contract, where a
				// client may drop its socket and reconcile the still-running prompt without
				// duplicate execution (see test/sdk-host-wiring.test.ts "turn.prompt_status
				// reconciles an accepted prompt across client reconnect"). A closed socket
				// therefore only abandons delivery; ACP rejects its own local waiter once and
				// terminal authority stays with the eventual normalized SDK outcome.
				for (const submission of promptSubmissions.values())
					if (submission.connectionId === connectionId) {
						abandonPrompt(submission);
					}
			});

			server.onReply((err, reply) => {
				if (err || !reply) return;
				if (
					runtime?.inboundFenced ||
					runtime?.stopping ||
					runtime?.policySuspended ||
					runtimes.get(id) !== runtime
				) {
					try {
						server.closeClaimInvalid(reply.replyReceiptId, "session_stopping");
					} catch {}
					return;
				}
				const replyGeneration = runtime.policyGeneration;
				const replyIsCurrent = (): boolean =>
					runtimes.get(id) === runtime &&
					!runtime.stopping &&
					!runtime.policySuspended &&
					runtime.policyGeneration === replyGeneration;
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
								if (!replyIsCurrent()) {
									try {
										native.closeClaimInvalid(reply.replyReceiptId, "policy_changed");
									} catch {}
									pending.fail(reply.id);
									return { kind: "invalid_closed" };
								}
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
									if (!replyIsCurrent()) {
										native.closeClaimInvalid(reply.replyReceiptId, "policy_changed");
										pending.fail(reply.id);
										return { kind: "invalid_closed" };
									}
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
					gate?.supportsRemoteGateAnswers?.() === true &&
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
						const mapped = mapAnswerToGate(reply.answerJson, presentation?.options ?? []);
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
								resolveClaim: () => {
									if (!replyIsCurrent()) {
										native.closeClaimInvalid(reply.replyReceiptId, "policy_changed");
										throw new NotificationGatePolicyChangedError();
									}
									native.resolveClaim(
										reply.replyReceiptId,
										reply.answerJson,
										reply.idempotencyKey ?? undefined,
									);
								},
								closeClaimInvalid: reason => {
									native.closeClaimInvalid(reply.replyReceiptId, reason);
									gatePresentations.closeInteraction(reply.id, reason);
									gatePresentations.reconcile();
								},
								requestSelectedAck: async input => {
									if (!replyIsCurrent()) throw new NotificationGatePolicyChangedError();
									const ack = await requestLiveSelectedAck(native, {
										replyReceiptId: input.replyReceiptId,
										actionId: input.actionId,
										commitKey: input.commitKey,
										deadlineAt: input.daemonDeadlineAt,
									});
									if (!replyIsCurrent()) throw new NotificationGatePolicyChangedError();
									return ack;
								},
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
			server.onInbound(async (err, inbound) => {
				if (err || !inbound) return;
				const notificationOrigin = hostCapCache.get(inbound.connectionId)?.has(ASK_SELECTED_ACK_CAPABILITY);
				const admission = notificationInboundAdmission({
					inboundFenced: initializedRuntime.inboundFenced,
					policySuspended: runtime?.policySuspended ?? false,
					notificationOrigin: notificationOrigin ?? false,
					controlCommand: inbound.kind === "control_command",
				});
				if (admission.outcome === "drop" && admission.reason === "inbound_fenced") {
					sendInboundAck(inbound.connectionId, inbound, "dropped", admission.reason);
					// A fenced predecessor keeps its native server alive for the terminal
					// response, so the daemon can still deliver here after it has already
					// ACKed the user's Telegram message. Dropping without a diagnostic
					// made that loss undiscoverable (2026-08-14 incident).
					logger.warn(
						`notifications: inbound ${inbound.kind} dropped: runtime is inbound-fenced (updateId=${String(
							(inbound as { updateId?: unknown }).updateId ?? "none",
						)})`,
					);
					return;
				}
				const authenticatedInbound = inbound as typeof inbound & {
					connectionId: string;
					messageId?: number;
					reason?: string;
				};
				if (admission.outcome === "defer") {
					// Provisional policy defers valid control commands to activate(); they are
					// NOT dropped, so no terminal dropped acknowledgement is emitted. The
					// control_command_result frame after execution is the authoritative reply.
					const frame = sdkInboundFrame(inbound.commandJson);
					if (frame) {
						const suspendedRuntime = runtime;
						runtime.deferredInboundControls.push(() => {
							if (
								runtimes.get(id) === suspendedRuntime &&
								!suspendedRuntime.stopping &&
								!suspendedRuntime.policySuspended
							)
								inboundSdkFrame?.(`seam:${inbound.requestId ?? "notification"}`, frame);
						});
					}
					return;
				}
				if (admission.outcome === "drop") {
					sendInboundAck(authenticatedInbound.connectionId, authenticatedInbound, "dropped", admission.reason);
					logger.warn(
						`notifications: inbound ${inbound.kind} dropped: notification policy is suspended (updateId=${String(
							(inbound as { updateId?: unknown }).updateId ?? "none",
						)})`,
					);
					return;
				}
				if (inbound.kind === "control_command") {
					const frame = sdkInboundFrame(inbound.commandJson);
					if (frame) {
						inboundSdkFrame?.(`seam:${inbound.requestId ?? "notification"}`, frame);
						return;
					}
				}
				if (
					(inbound.kind === "ephemeral_turn" || inbound.kind === "ephemeral_turn_cancel") &&
					!runtime?.notificationsActive
				)
					return;
				if (inbound.kind === "ephemeral_turn" || inbound.kind === "ephemeral_turn_cancel") {
					ephemeralTurns.handle(authenticatedInbound.connectionId, {
						type: authenticatedInbound.kind,
						sessionId: authenticatedInbound.sessionId,
						requestId: authenticatedInbound.requestId,
						updateId: authenticatedInbound.updateId,
						messageId: authenticatedInbound.messageId,
						threadId: authenticatedInbound.threadId,
						...(authenticatedInbound.kind === "ephemeral_turn"
							? { question: authenticatedInbound.text }
							: { reason: authenticatedInbound.reason }),
					});
					return;
				}

				if (inbound.kind === "user_message") {
					// Inject as a user turn (steers/continues the agent; the resulting
					// turn streams back via the turn_end handler even when not idle).
					// Session-side acceptance is explicit: the daemon must not leave its
					// optimistic queued reaction in place when this live host rejects/drop.
					const text = inbound.text ?? "";
					const images = inbound.images ?? [];
					if (!text && images.length === 0) {
						sendInboundAck(authenticatedInbound.connectionId, authenticatedInbound, "rejected", "invalid_input");
						return;
					}
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
					let acceptedSent = false;
					const acceptAdmission = (): void => {
						// Fired by AgentSession's preflight acceptance: after admission has
						// committed but before the turn starts. Registering the update id and
						// acking here means turn_start can no longer race ahead of the
						// pendingInbound registration it consumes.
						if (acceptedSent) return;
						acceptedSent = true;
						if (runtime && typeof inbound.updateId === "number") runtime.pendingInbound.add(inbound.updateId);
						sendInboundAck(authenticatedInbound.connectionId, authenticatedInbound, "accepted");
					};
					try {
						// sendUserMessage is async and settles only after the full prompt, so
						// acceptance is signalled by the preflight-acceptance callback instead
						// of after the await; a rejection (preflight, admission, or later)
						// still reaches the catch and maps to a rejected ack.
						await api.sendUserMessage(content, {
							...(runtime?.busy ? { deliverAs: "steer" as const } : {}),
							onPreflightAcceptCommit: acceptAdmission,
							onPreflightAccepted: acceptAdmission,
						});
						acceptAdmission();
					} catch (e) {
						sendInboundAck(
							authenticatedInbound.connectionId,
							authenticatedInbound,
							"rejected",
							"injection_failed",
						);
						logger.warn(`notifications: sendUserMessage failed: ${String(e)}`);
					}
					return;
				}
				if (inbound.kind === "config_command") {
					if (!runtime) return;
					if (runtime.policySuspended) return;
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
						if (inbound.redact && !runtime.committedRedact) {
							terminalizeInFlightTools(runtime, runtime.id, "cancelled");
						}
						runtime.committedRedact = inbound.redact;
						runtime.redact = inbound.redact;
						update.redact = inbound.redact;
					}
					if (update.verbosity !== undefined || update.redact !== undefined) {
						runtime.policyGeneration++;
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

			await sdkRuntime.startHost();
			lifecycleStartupCapability?.rollback?.recordGeneration(host.generation);
			throwIfLifecycleStopped();
			if (runtimes.get(id) !== runtime) {
				finishStartup({ status: "failed" });
				await cleanupAbandonedStartup();
				return { status: "failed" };
			}

			// Fail-closed daemon isolation: the chat daemons (Telegram, Discord,
			// Slack) are optional notification adapters, never session authority.
			// No daemon ownership is acquired, awaited, or verified before core
			// publication — a slow, wedged, blocked, or crashed daemon must degrade
			// ONLY notification delivery, never an ACP/MCP session open. Native
			// frames are ephemeral, so publish identity first; late SDK consumers
			// recover it from event_replay.
			const identityHeader = {
				type: "identity_header",
				sessionId: id,
				...buildIdentity(ctx.cwd, ctx.sessionManager.getSessionName(), telegramTopicsEnabled()),
			};
			emitSessionEvent(initializedRuntime, identityHeader);
			const endpoint = await sdkRuntime.startTransport();
			initializedRuntime.notificationOwnerState = "ready";
			if (notificationsEnabledForSession && settingsAvailable && settings) {
				// Daemon ownership is acquired AFTER the core SDK endpoint is
				// published, and is deliberately NOT tracked in
				// `sessionLifecycleTasks`: shutdown joins that set, so a wedged
				// ensure tracked there would hang teardown. Every write the settled
				// outcome performs is identity-guarded instead. Until it settles the
				// owner state stays "retry", so activate() withholds notification
				// adapters and a later reconcile re-attempts.
				initializedRuntime.notificationOwnerState = "retry";
				initializedRuntime.notificationOwnerKey = daemonOwnershipKey(cfg);
				const ownershipRuntime = initializedRuntime;
				kickDaemonOwnership(settings, cfg, (outcome, key) => {
					applyDaemonOwnership(id, ownershipRuntime, outcome, isolateChatEndpoint, key);
					// Adapters activate only through reconciliation, so re-run it once
					// ownership is known. Detached: no lifecycle path awaits this.
					if (runtimes.get(id) !== ownershipRuntime || ownershipRuntime.stopping || extensionShuttingDown) return;
					void controller
						.reconcileCurrentSession(ctx)
						.catch(error => logger.warn(`notifications: post-ownership reconciliation failed: ${String(error)}`));
				});
			}

			// The native server owns the only authoritative view of this host's live
			// SDK client sockets; publish it so a detached session host can bound its
			// own lifetime without probing the OS (#4010). The handle is this
			// runtime's alone, so only this runtime's teardown can retract it.
			initializedRuntime.evidencePublication = publishSessionHostRuntimeEvidence({
				attachedClients: () => server.clientCount(),
				workInFlight: () =>
					initializedRuntime.busy ||
					initializedRuntime.pendingPromptCorrelations.length > 0 ||
					initializedRuntime.pendingPromptCorrelationsBySdkRunToken.size > 0,
			});
			ephemeralTurns.configureAuthority({
				sessionId: id,
				endpointDigest: endpointAuthorityDigest(endpoint.url, token),
				eventGeneration: host.generation,
			});
			throwIfLifecycleStopped();
			if (runtimes.get(id) !== runtime) {
				finishStartup({ status: "failed" });
				await cleanupAbandonedStartup();
				return { status: "failed" };
			}

			server.pushFrame(JSON.stringify(identityHeader));
			let publishedSessionName = identityHeader.title;
			const sessionNameObserver = setInterval(() => {
				if (runtime?.stopping || runtimes.get(id) !== runtime) return;
				if (ctx.sessionManager.getSessionId() !== id) return;
				const sessionName = ctx.sessionManager.getSessionName();
				if (!sessionName || sessionName === publishedSessionName) return;
				publishedSessionName = sessionName;
				const identity = {
					type: "identity_header",
					sessionId: id,
					...buildIdentity(ctx.cwd, sessionName, telegramTopicsEnabled()),
				};
				const positionedRecipients = emitSessionEvent(initializedRuntime, identity);
				server.pushFrame(JSON.stringify(identity), positionedRecipients);
			}, 250);
			sessionNameObserver.unref?.();
			runtime.stopSessionNameObserver = () => clearInterval(sessionNameObserver);
			const sessionNameAfterStartup =
				ctx.sessionManager.getSessionId() === id ? ctx.sessionManager.getSessionName() : undefined;
			if (sessionNameAfterStartup && sessionNameAfterStartup !== publishedSessionName) {
				publishedSessionName = sessionNameAfterStartup;
				const identity = {
					type: "identity_header",
					sessionId: id,
					...buildIdentity(ctx.cwd, sessionNameAfterStartup, telegramTopicsEnabled()),
				};
				const positionedRecipients = emitSessionEvent(initializedRuntime, identity);
				server.pushFrame(JSON.stringify(identity), positionedRecipients);
			}
			const agentDir = lifecycleAgentDir ?? settings?.getAgentDir?.();
			if (lifecycleRequired && !agentDir) throw new Error("Lifecycle SDK host requires an agent directory.");
			if (lifecycleRequired && !lifecycleRequestId)
				throw new Error("Lifecycle SDK host requires a capability-bound request identity.");

			if (agentDir) {
				try {
					await ensureBroker({ agentDir });
					throwIfLifecycleStopped();
					const index = await new SessionIndex(agentDir).open();
					throwIfLifecycleStopped();
					const locator = await resolveSessionLocator(ctx.cwd, endpointStateRoot);
					const endpointPath = path.join(endpointStateRoot, "sdk", `${id}.json`);
					const endpointMtimeMs = fs.statSync(endpointPath).mtimeMs;
					const endpointIdentity = fs.statSync(endpointPath, { bigint: true });
					const endpointFileId = `${endpointIdentity.dev}:${endpointIdentity.ino}`;
					const hostProcessIncarnation = processIncarnation(process.pid);
					const direct = await reattestMasterSessionIdentity({
						index,
						locator,
						masterCapability: options.masterCapability,
						attestationEpoch: options.masterAttestationEpoch,
						ownerSessionId: options.masterOwnerSessionId,
						sessionId: id,
						pid: process.pid,
						processIncarnation: hostProcessIncarnation,
					});
					throwIfLifecycleStopped();
					await host.registerWithBroker({
						// The endpoint is written before registration. Its exact mtime
						// binds this index generation to that discovery record.
						register: async input => {
							const masterRole = masterAttestationForEffectiveHost({
								masterCapability: options.masterCapability,
								attestationEpoch: options.masterAttestationEpoch,
								ownerSessionId: options.masterOwnerSessionId,
								sessionId: input.sessionId,
								pid: process.pid,
								processIncarnation: hostProcessIncarnation,
								direct,
							});
							await index.append({
								type: "host_registered",
								...input,
								locator,
								pid: process.pid,
								// A pid alone cannot survive its own reuse, and the marker that
								// binds it lives in the workspace state root this host can outlive.
								// Publishing the incarnation into broker-owned storage is what keeps
								// teardown identity provable after that workspace is gone.
								...(hostProcessIncarnation ? { processIncarnation: hostProcessIncarnation } : {}),
								endpointMtimeMs,
								endpointFileId,
								...(masterRole ? { masterRole } : {}),
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
					initializedRuntime.brokerRegistrationActive = true;
					// Host liveness is derived from alive(pid) when the index is read; heartbeats
					// are deliberately not appended to the durable session index.
				} catch (brokerError) {
					if (lifecycleRequired) throw brokerError;
					logger.warn(`sdk broker registration skipped: ${String(brokerError)}`);
				}
			}

			const startedRuntime = initializedRuntime;
			initializedRuntime.enableNotifications = () => {
				const runtime = startedRuntime;
				if (runtime.notificationsActive) return;
				ephemeralTurns.enable();
				runtime.notificationsActive = true;
				runtime.disposeAnswerSource = registerInteractiveAnswerSource(
					runtime.id,
					pendingInteractive,
					gatePresentations,
				);
				runtime.disposeFileSink = registerTelegramFileSink(runtime.id, async file => {
					const generation = runtime.policyGeneration;
					if (!canDeliverAsync(runtime, generation)) return { ok: false, error: TELEGRAM_FILE_REDACTION_ERROR };
					try {
						const data = await (options.readNotificationFile ?? fs.promises.readFile)(file.path);
						if (!canDeliverAsync(runtime, generation)) {
							return { ok: false, error: TELEGRAM_FILE_REDACTION_ERROR };
						}
						if (file.mime?.startsWith("image/")) {
							pushSessionFrame(runtime, {
								type: "image_attachment",
								sessionId: runtime.id,
								source: "telegram_send",
								mime: file.mime,
								caption: file.caption,
								data: data.toString("base64"),
							});
						} else {
							pushFileAttachment(
								runtime,
								{
									type: "file_attachment",
									sessionId: runtime.id,
									name: path.basename(file.path),
									mime: file.mime,
									caption: file.caption,
								},
								data,
							);
						}
						return { ok: true };
					} catch (e) {
						return { ok: false, error: e instanceof Error ? e.message : String(e) };
					}
				});
			};
			const activeRuntime = initializedRuntime;
			// A native terminal close (SIGHUP), SIGTERM, Ctrl+C exit, or fatal error
			// skips AgentSession.dispose(), so the `session_shutdown` extension event
			// never fires and the daemon-side topic would be orphaned. postmortem
			// awaits registered cleanups on those paths, so send the graceful
			// `session_closed` frame from there too. stopSession() cancels this
			// registration on every other teardown path, so it never double-fires.
			initializedRuntime.cancelPostmortemCleanup = postmortem.register(
				`notifications-session-closed:${id}`,
				async () => {
					await stopSession(initializedRuntime.id);
				},
			);
			logger.info(`notifications: serving session ${id} at ${endpoint.url}`);
			// A workflow-gate emitter can be installed after session startup.
			// Attach dynamically so the SDK bus presents every durable gate.
			const attachWorkflowGate = (gate: WorkflowGateEmitter | undefined): void => {
				if (activeRuntime.workflowGate === gate) return;
				const sourceEpoch = ++activeRuntime.workflowGatePublicationEpoch;
				activeRuntime.disposeGateListener();
				activeRuntime.workflowGate?.setRuntimeTurnProvider?.(null);
				activeRuntime.disposeAckRecoveryParticipant();
				gatePresentations.dispose();
				activeRuntime.disposeGateTerminalController();
				activeRuntime.disposeGateListener = () => {};
				activeRuntime.disposeGateTerminalController = () => {};
				activeRuntime.disposeAckRecoveryParticipant = () => {};
				activeRuntime.workflowGate = undefined;
				if (typeof gate?.onGateEmitted !== "function" || typeof gate.resolveGateFromNotification !== "function") {
					return;
				}
				activeRuntime.workflowGate = gate;
				gate.setRuntimeTurnProvider?.(() => activeRuntime.activePromptCorrelation?.turnId);
				const isCurrentSource = (): boolean =>
					activeRuntime.workflowGate === gate && activeRuntime.workflowGatePublicationEpoch === sourceEpoch;
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
				const presentGate = (
					g: Parameters<NonNullable<WorkflowGateEmitter["onGateEmitted"]>>[0] extends (gate: infer Gate) => void
						? Gate
						: never,
				): void => {
					if (!isCurrentSource()) return;
					const rawGateOptions = g.options ?? [];
					const options = rawGateOptions.map(o => String((o as { label?: unknown }).label ?? ""));
					const recommendedIndex = recommendedIndexFromGateOptions(rawGateOptions);
					const promptCtx = g.context as { prompt?: unknown; title?: unknown } | undefined;
					const question =
						(typeof promptCtx?.prompt === "string" && promptCtx.prompt) ||
						(typeof promptCtx?.title === "string" && promptCtx.title) ||
						"Question";
					const stageState =
						typeof g.context?.stage_state === "object" && g.context.stage_state !== null
							? (g.context.stage_state as Record<string, unknown>)
							: {};
					gatePresentations.retain(
						{
							gateId: g.gate_id,
							workflowGateId: g.gate_id,
							sessionId: id,
							question,
							options,
							...(recommendedIndex === undefined ? {} : { recommendedIndex }),
							controls: [],
							multi: stageState.multi === true,
							allowEmpty: stageState.allow_empty === true,
							navigationLabel: stageState.navigation_label === "Next" ? "Next" : "Done",
							selectedOptions: [],
						},
						{
							publish: !activeRuntime.policySuspended,
							sourceEpoch,
						},
					);
				};
				activeRuntime.disposeGateListener = gate.onGateEmitted(g => {
					presentGate(g);
				});
				if (gate.setAckRecoveryParticipant) {
					const native = server as unknown as {
						requestRecoveredAskSelectedAck(
							requestJson: string,
						): Promise<{ status: string; messageId?: number; reason?: string }>;
					};
					gate.setAckRecoveryParticipant({
						requestRecoveredAskSelectedAck: async input => {
							const generation = activeRuntime.policyGeneration;
							if (activeRuntime.policySuspended) return { status: "failed", reason: "cancelled" };
							const outcome = await requestRecoveredSelectedAck(native, {
								sessionId: input.sessionId,
								actionId: input.actionId,
								commitKey: input.commitKey,
								deadlineAt: input.deadlineAt,
							});
							if (activeRuntime.policySuspended || activeRuntime.policyGeneration !== generation)
								return { status: "failed", reason: "cancelled" };
							return outcome;
						},
					});
					activeRuntime.disposeAckRecoveryParticipant = () => gate.setAckRecoveryParticipant?.(null);
				}
				void (typeof gate.recoverAcceptedGates === "function"
					? trackGateResolution(gate.recoverAcceptedGates()).catch(() => {})
					: Promise.resolve());
			};
			activeRuntime.disposeGateEmitterListener = registerWorkflowGateEmitterListener(id, attachWorkflowGate);
			if (ctx.workflowGate) attachWorkflowGate(ctx.workflowGate);
			finishStartup({ status: "started", runtime: initializedRuntime });
			return { status: "started", runtime: initializedRuntime };
		} catch (e) {
			logger.warn(`notifications: failed to start server: ${String(e)}`);
			const result = failLifecycleStartup("failed", e);
			finishStartup(result);
			let suppressExtensionError = false;
			let stopped = false;
			try {
				stopped = await stopSession(id, "session", runtime);
			} catch (error) {
				// A secondary owner-release failure during abandoned-startup cleanup is
				// retained for an explicit later retry via cleanupRetries; log it rather
				// than letting it escape startSession and surface a red extension error
				// through session_start / session_switch / session_branch.
				logger.error(`notifications: SDK notification runtime cleanup failed: ${String(error)}`);
				suppressExtensionError = true;
			}
			if (!stopped) await cleanupAbandonedStartup();
			return { ...result, runtime, suppressExtensionError };
		}
	}

	const sessionRuntime: NotificationSessionRuntime<ExtensionContext> = {
		isRunning: binding => {
			const runtime = runtimes.get(binding.sessionId);
			return runtime?.notificationsActive === true && runtime.notificationOwnerState === "ready";
		},
		start: async binding => {
			if (sessionStartPromises.has(binding.sessionId)) {
				const result = await startSession(binding.context);
				if (result.status !== "started" && result.status !== "already") return result.status;
				const runtime = runtimes.get(binding.sessionId);
				if (!runtime || sessionId(binding.context) !== binding.sessionId || activeRuntimeId !== binding.sessionId) {
					return "failed";
				}
				return "started";
			}
			const runtime = runtimes.get(binding.sessionId);
			if (runtime) {
				if (runtime.notificationOwnerState === "retry") {
					const { cfg, settings, settingsAvailable } = resolveSettings(options.settings);
					if (!settingsAvailable || !settings) return "failed";
					// Settle-or-pending: never await ownership on this path. A pending
					// ensure leaves the state retryable and adapters withheld; its
					// settle callback applies the outcome and re-reconciles.
					const settled = peekDaemonOwnership(cfg);
					const isolated = runtime.endpointScope === "chat";
					runtime.notificationOwnerKey = daemonOwnershipKey(cfg);
					if (settled === undefined) {
						kickDaemonOwnership(settings, cfg, (outcome, key) =>
							applyDaemonOwnership(binding.sessionId, runtime, outcome, isolated, key),
						);
					} else {
						applyDaemonOwnership(binding.sessionId, runtime, settled, isolated, runtime.notificationOwnerKey);
					}
				}
				return "started";
			}
			const result = await startSession(binding.context);
			return result.status === "started" || result.status === "already" ? "started" : result.status;
		},
		stop: async binding => await stopSession(binding.sessionId, "notifications"),
		isolateTelegram: async binding => {
			const runtime = runtimes.get(binding.sessionId);
			if (runtime) {
				if (runtime.endpointScope === "default") {
					runtime.notificationOwnerState = "blocked";
					return "failed";
				}
				return "started";
			}
			forceIsolatedChatSessions.add(binding.sessionId);
			const result = await startSession(binding.context);
			if (result.status !== "started" && result.status !== "already") {
				forceIsolatedChatSessions.delete(binding.sessionId);
			}
			return result.status === "started" || result.status === "already" ? "started" : result.status;
		},
		refreshPolicy: (binding, policy) => {
			const runtime = runtimes.get(binding.sessionId);
			if (!runtime) return;
			if (policy.mode === "provisional") {
				runtime.policyGeneration++;
				runtime.policySuspended = true;
				runtime.gatePresentations?.setPublicationSuspended(true);
				runtime.redact = true;
				runtime.verbosity = "lean";
				runtime.stream = false;
				for (const [toolCallId, tool] of runtime.inFlightTools) {
					runtime.inFlightTools.set(toolCallId, {
						toolName: tool.toolName,
						...(tool.pendingPhase ? { pendingPhase: tool.pendingPhase } : {}),
					});
				}
				return;
			}
			const wasPolicySuspended = runtime.policySuspended;
			const redactionEnabled = policy.redact && !runtime.committedRedact;
			runtime.policyGeneration++;
			runtime.committedRedact = policy.redact;
			runtime.policySuspended = false;
			runtime.redact = policy.redact;
			runtime.verbosity = policy.verbosity;
			runtime.stream = policy.stream;
			if (redactionEnabled) {
				runtime.pendingFinal = undefined;
				runtime.pendingSettled = undefined;
				terminalizeInFlightTools(runtime, runtime.id, "cancelled", true);
			} else if (wasPolicySuspended && !policy.redact) settleProvisionalToolTerminals(runtime, runtime.id);
		},
		activate: binding => {
			const runtime = runtimes.get(binding.sessionId);
			if (!runtime || runtime.stopping) return;
			// Activation is only valid after the controller commits a stable policy;
			// never expose deferred presentations while provisional policy is held.
			if (runtime.policySuspended) return;
			if (runtime.notificationOwnerState !== "ready") return;
			runtime.enableNotifications();
			runtime.gatePresentations?.setPublicationSuspended(false);
			runtime.gatePresentations?.activateDeferred(runtime.workflowGatePublicationEpoch);
			flushPendingFinal(runtime, runtime.id);
			flushPendingSettled(runtime, runtime.id);
			for (const processControl of runtime.deferredInboundControls.splice(0)) processControl();
		},
		reproveOwnership: async binding => {
			// PROVIDER-NEUTRAL ownership re-proof. Reconciliation calls this for any
			// effective chat provider, not just Telegram: a Discord-only or
			// Slack-only credential/destination/actor change must withhold adapters
			// exactly like a Telegram one, or the old identity keeps delivery and
			// (for Slack) inbound command authority through a stale outcome.
			//
			// Never awaits the ensure itself — only the adapter teardown, which is
			// local. Lifecycle paths must not block on daemon ownership.
			const { settings, settingsAvailable, cfg } = resolveSettings(options.settings);
			if (!settingsAvailable || !settings) return;
			const key = daemonOwnershipKey(cfg);
			const sessionIdForOwnership = binding.sessionId;
			// The binding is released when reconciliation returns, so capture the
			// context eagerly: the settle callback runs strictly later.
			const ownershipCtx = binding.context;
			const runtime = runtimes.get(sessionIdForOwnership);
			if (!runtime || runtime.notificationOwnerKey === key) return;
			// The ownership-relevant configuration changed under a runtime whose
			// LOCAL adapters were authorized for the OLD configuration. Withhold
			// them first (`stop` with reason "notifications" tears down adapters
			// and answer sources while leaving the core SDK host untouched), then
			// re-prove.
			//
			// SCOPE: this does NOT revoke an already-attached external Discord or
			// Slack daemon's SessionRouter attachment. Such a daemon can still
			// observe host events and reach the host's inbound/control paths until
			// it notices the change itself. Closing that requires one coherent
			// authenticated chat-attachment authority boundary at the Router layer
			// (provenance per connection, revocation on re-proof and on
			// last-provider disable, covering replies and raw v3 frames uniformly).
			// That is tracked as a follow-up; per-callback heuristics here were
			// tried and reverted because they were bypassable and, on a blocked
			// identity, silently refused legitimate Telegram inbound forever.
			runtime.notificationOwnerKey = key;
			runtime.notificationOwnerState = "retry";
			if (runtime.notificationsActive) await stopSession(sessionIdForOwnership, "notifications");
			kickDaemonOwnership(settings, cfg, (outcome, outcomeKey) => {
				const current = runtimes.get(sessionIdForOwnership);
				if (!current) return;
				applyDaemonOwnership(sessionIdForOwnership, current, outcome, current.endpointScope === "chat", outcomeKey);
				if (current.stopping || extensionShuttingDown) return;
				// One detached reconciliation so adapters activate once the new
				// configuration is proved. No lifecycle path awaits this.
				void controller
					.reconcileCurrentSession(ownershipCtx)
					.catch(error => logger.warn(`notifications: post-ownership reconciliation failed: ${String(error)}`));
			});
		},
		ensureTelegramDaemon: async binding => {
			const { settings, settingsAvailable, cfg } = resolveSettings(options.settings);
			if (!settingsAvailable || !settings) return "blocked_identity";
			// Reconciliation runs on awaited session-lifecycle paths (session_start,
			// switch, branch, fork, resume), so this preflight must NEVER await a
			// daemon ensure. A pending ensure answers "pending": reconciliation
			// proceeds without activating adapters, and the settle callback
			// re-reconciles once ownership is known.
			const sessionIdForOwnership = binding.sessionId;
			const ownershipCtx = binding.context;
			const settled = peekDaemonOwnership(cfg);
			if (settled === undefined) {
				kickDaemonOwnership(settings, cfg, (outcome, outcomeKey) => {
					const current = runtimes.get(sessionIdForOwnership);
					if (!current) return;
					applyDaemonOwnership(
						sessionIdForOwnership,
						current,
						outcome,
						current.endpointScope === "chat",
						outcomeKey,
					);
					if (current.stopping || extensionShuttingDown) return;
					void controller
						.reconcileCurrentSession(ownershipCtx)
						.catch(error => logger.warn(`notifications: post-ownership reconciliation failed: ${String(error)}`));
				});
				return "pending";
			}
			if (settled === "failed") return "failed";
			return settled === "ready" ? "ready" : "blocked_identity";
		},
	};
	controller.attachRuntime(sessionRuntime);

	api.registerCommand("notify", {
		description: "Control notifications for this session (on, off, status).",
		async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
			const id = sessionId(ctx);
			const command = args.trim().split(/\s+/, 1)[0]?.toLowerCase() || "status";
			const resolved = resolveSettings(options.settings);
			const manualEligibilityEnv =
				process.env.GJC_NOTIFICATIONS === "0" ? { ...process.env, GJC_NOTIFICATIONS: undefined } : process.env;
			const enabledWithoutLocalOff = resolveGenericNotificationSessionEligibility({
				cfg: resolved.cfg,
				env: manualEligibilityEnv,
				sessionDisabled: false,
				spawnedByGjc: options.spawnedByGjc,
			}).enabled;

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
				if (!enabledWithoutLocalOff) {
					ctx.ui.notify(
						"Notifications are not configured. Run `gjc notify setup` or set GJC_NOTIFICATIONS=1.",
						"warning",
					);
					return;
				}
				const result = await controller.setLocalEnabled(ctx, true);
				const enabled = result.status.running && result.status.genericSessionEnabled;
				const rotated = sessionId(ctx) !== id;
				if (rotated) await stopSession(id);
				const failed = result.outcome === "failed" || (!enabled && !rotated && activeRuntimeId !== id);
				ctx.ui.notify(
					rotated
						? "Notifications were not enabled because the active session changed during startup."
						: enabled
							? "Notifications enabled for this session."
							: failed
								? "Notifications failed to start for this session."
								: "Notifications were not enabled because daemon ownership could not be proved.",
					rotated ? "warning" : enabled ? "info" : failed ? "error" : "warning",
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
				`Notifications ${status.running ? "running" : status.genericSessionEnabled ? "enabled" : "disabled"} for this session; admission ${status.genericEligibilitySource}; redaction ${(runtime?.redact ?? resolved.cfg.redact) ? "on" : "off"}; verbosity ${runtime?.verbosity ?? resolved.cfg.verbosity}${status.locallyEnabled ? "" : "; locally off"}.`,
				"info",
			);
		},
	});

	const startAndReconcileSession = async (ctx: ExtensionContext): Promise<void> => {
		const result = await startSession(ctx);
		if (result.status === "started" || result.status === "already") {
			await controller.reconcileCurrentSession(ctx);
			return;
		}
		if (
			!lifecycleStartupCapability &&
			result.status === "failed" &&
			!extensionShuttingDown &&
			!result.suppressExtensionError
		)
			throw new Error(`notifications: SDK startup failed: ${result.failure?.message ?? "Unknown startup failure."}`);
	};

	api.on("session_start", async (_event, ctx) => {
		const task = startAndReconcileSession(ctx);
		// Track full start+reconcile so settled startups join replacement-token
		// reconcile before owner release. Pending native startup (/notify on) stays
		// nonblocking: shutdown only awaits these tasks when sessionStartPromises is clear.
		sessionLifecycleTasks.add(task);
		try {
			await task;
		} finally {
			sessionLifecycleTasks.delete(task);
		}
	});

	// A session endpoint's token and generation are authority for exactly one
	// session id. `/new`, fork, and resume must all tear down A before publishing
	// B. Chat implementations may preserve a topic as metadata, but it must never
	// preserve A's endpoint or credentials as B's control/viewing authority.
	const reconcileBackgroundStartup = (
		id: string,
		ctx: ExtensionContext,
		startup: Promise<SessionStartResult>,
	): Promise<void> =>
		startup
			.then(async result => {
				if (
					result.status !== "started" ||
					extensionShuttingDown ||
					sessionId(ctx) !== id ||
					activeRuntimeId !== id ||
					!runtimes.has(id)
				)
					return;
				await controller.reconcileCurrentSession(ctx);
			})
			.catch(error => logger.warn(`notifications: deferred startup reconciliation failed: ${String(error)}`));

	const trackBranchStartup = (id: string, ctx: ExtensionContext, startup: Promise<SessionStartResult>): void => {
		let status: SessionStartResult["status"] = "failed";
		void startup.then(
			result => {
				status = result.status;
			},
			() => {},
		);
		const task = reconcileBackgroundStartup(id, ctx, startup);
		branchStartupTasks.add(task);
		void task.finally(() => {
			branchStartupTasks.delete(task);
			try {
				options.onBranchStartupSettled?.({ sessionId: id, status });
			} catch (error) {
				logger.warn(`notifications: branch startup receipt failed: ${String(error)}`);
			}
		});
	};

	const preparePredecessorForTerminal = async (id: string): Promise<void> => {
		const predecessor = runtimes.get(id);
		if (!predecessor || cleanupRetries.has(id))
			throw new Error(`notifications: predecessor runtime ${id} is not safely send-capable.`);
		predecessor.inboundFenced = true;
		predecessor.stopSessionNameObserver();
		// Release broker/host authority while leaving the native server alive for
		// the one accepted terminal response. stopAndWait is deferred to stopSession.
		const stopped = await predecessor.host.stop();
		if (stopped !== "stopped" && predecessor.host.started)
			throw new Error(`notifications: predecessor runtime ${id} host release was not proven.`);
		predecessor.hostStopped = true;
		predecessor.brokerRegistrationReleased = !predecessor.brokerRegistrationActive || predecessor.hostStopped;
		if (predecessor.brokerRegistrationActive && predecessor.hostStopped) predecessor.brokerRegistrationActive = false;
		predecessor.host.reverse.dispose();
	};

	const rotateSessionAuthority = async (
		event: { previousSessionFile?: string },
		ctx: ExtensionContext,
		awaitStartup: boolean,
		options: { deferPredecessorStop?: boolean } = {},
	): Promise<void> => {
		if (extensionShuttingDown) return;
		const newId = sessionId(ctx);
		const prevId = activeRuntimeId ?? sessionIdFromFile(event.previousSessionFile);
		if (prevId === newId) {
			const pendingStartup = sessionStartPromises.get(newId);
			if (pendingStartup) {
				if (awaitStartup) {
					const result = await pendingStartup;
					if (!lifecycleStartupCapability && result.status === "failed")
						throw new Error(
							`notifications: SDK startup failed: ${result.failure?.message ?? "Unknown startup failure."}`,
						);
					if (!extensionShuttingDown && runtimes.has(newId) && activeRuntimeId === newId)
						await controller.reconcileCurrentSession(ctx);
				} else {
					trackBranchStartup(newId, ctx, pendingStartup);
				}
				return;
			}
			if (runtimes.has(newId)) {
				await controller.reconcileCurrentSession(ctx);
				return;
			}
		}
		if (prevId && prevId !== newId) {
			controller.rekeySession(prevId, newId);
			if (options.deferPredecessorStop) {
				await preparePredecessorForTerminal(prevId);
			} else {
				const stopped = await stopSession(prevId);
				if (cleanupRetries.has(prevId) || runtimes.has(prevId) || sessionStartPromises.has(prevId))
					throw new Error(`notifications: predecessor runtime ${prevId} release is uncertain.`);
				if (!stopped && activeRuntimeId === prevId)
					throw new Error(`notifications: predecessor runtime ${prevId} release was not proven.`);
			}
		}
		if (extensionShuttingDown) return;
		const startup = startSession(ctx);
		if (awaitStartup) {
			const result = await startup;
			if (!lifecycleStartupCapability && result.status === "failed")
				throw new Error(
					`notifications: SDK startup failed: ${result.failure?.message ?? "Unknown startup failure."}`,
				);
			if (extensionShuttingDown) {
				await stopSession(newId);
				return;
			}
			await controller.reconcileCurrentSession(ctx);
			return;
		}
		trackBranchStartup(newId, ctx, startup);
	};
	api.on("session_switch", async (event, ctx) => {
		const awaitStartup = shouldAwaitNotificationStartup(event);
		if (identityControlInFlight) {
			deferredIdentityRotation = { event, ctx, awaitStartup };
			return;
		}
		await rotateSessionAuthority(event, ctx, awaitStartup);
	});
	api.on("session_branch", async (event, ctx) => {
		if (identityControlInFlight) {
			deferredIdentityRotation = { event, ctx, awaitStartup: true };
			return;
		}
		await rotateSessionAuthority(event, ctx, true);
	});

	const terminalizeInFlightTools = (
		rt: SessionRuntime,
		id: string,
		phase: "cancelled" | "failed",
		allowSafeRedactedFrame = false,
	): void => {
		if (rt.policySuspended && !allowSafeRedactedFrame) {
			for (const [toolCallId, tool] of rt.inFlightTools) {
				rt.inFlightTools.set(toolCallId, {
					toolName: tool.toolName,
					pendingPhase: tool.pendingPhase ?? phase,
				});
			}
			return;
		}
		if (rt.notificationsActive && (!rt.redact || allowSafeRedactedFrame)) {
			for (const [toolCallId, { toolName }] of rt.inFlightTools) {
				try {
					pushSessionFrame(rt, { type: "tool_activity", sessionId: id, toolCallId, toolName, phase });
				} catch (e) {
					logger.warn(`notifications: synthetic tool_activity failed: ${String(e)}`);
				}
			}
		}
		rt.inFlightTools.clear();
	};

	const settleProvisionalToolTerminals = (rt: SessionRuntime, id: string): void => {
		for (const [toolCallId, tool] of rt.inFlightTools) {
			if (!tool.pendingPhase) continue;
			try {
				if (rt.notificationsActive && !rt.redact) {
					pushSessionFrame(rt, {
						type: "tool_activity",
						sessionId: id,
						toolCallId,
						toolName: tool.toolName,
						phase: tool.pendingPhase,
					});
				}
			} catch (e) {
				logger.warn(`notifications: provisional tool_activity settlement failed: ${String(e)}`);
			} finally {
				rt.inFlightTools.delete(toolCallId);
			}
		}
	};

	const resetTurnStreamState = (rt: SessionRuntime): void => {
		rt.currentTurnText = undefined;
		rt.preAskFlushedText = undefined;
		rt.liveRef = undefined;
		rt.turnClosed = true;
		rt.lastLiveAt = undefined;
		rt.lastLiveText = undefined;
	};

	/**
	 * Session messages historically omitted attribution for direct user prompts;
	 * that wire shape remains user-originated. Explicit agent attribution always
	 * wins, including on a role:"user" internal resource notification.
	 */
	const isUserSettlementBoundary = (message: { role?: unknown; attribution?: unknown }): boolean =>
		message.attribution === "user" || (message.role === "user" && message.attribution === undefined);
	const isFrameworkPromptContext = (message: { role?: unknown; customType?: unknown }): boolean =>
		message.role === "custom" && message.customType === "volatile-project-context";

	type SettlementOrigin = "user" | "autonomous" | "continuation";

	const deferLeanReceipt = (
		rt: SessionRuntime,
		text: string,
		messageRef?: string,
		window: number = rt.currentTurnSettlementWindow ?? rt.settlementWindow,
		origin: SettlementOrigin = rt.currentTurnSettlementOrigin ?? "continuation",
	): void => {
		if (window !== rt.settlementWindow) return;
		const receipt = { text, ...(messageRef ? { messageRef } : {}), origin };
		const pending = rt.pendingSettled;
		if (!pending || pending.window !== window) {
			rt.pendingSettled = { window, receipts: [receipt] };
			return;
		}
		if (origin === "autonomous") {
			const prior = pending.receipts[pending.receipts.length - 1];
			if (prior?.text === text) return;
			// Keep the user-request receipt plus the newest autonomous outcome.
			pending.receipts = [pending.receipts[0]!, receipt];
			return;
		}
		if (origin === "continuation" && pending.receipts[0]?.origin === "user") {
			pending.receipts = [pending.receipts[0]!, receipt];
			return;
		}
		pending.receipts = [receipt];
	};

	const deferProvisionalReceipt = (rt: SessionRuntime, text: string | undefined, messageRef?: string): void => {
		if (!text) return;
		const window = rt.currentTurnSettlementWindow ?? rt.settlementWindow;
		if (window !== rt.settlementWindow) return;
		const origin = rt.currentTurnSettlementOrigin ?? "continuation";
		const receipt = { text, ...(messageRef ? { messageRef } : {}), origin };
		const pending = rt.pendingFinal;
		if (!pending || pending.window !== window) {
			rt.pendingFinal = { window, receipts: [receipt] };
			return;
		}
		if (origin === "autonomous") {
			if (pending.receipts[pending.receipts.length - 1]?.text === text) return;
			pending.receipts = [pending.receipts[0]!, receipt];
			return;
		}
		if (origin === "continuation" && pending.receipts[0]?.origin === "user") {
			pending.receipts = [pending.receipts[0]!, receipt];
			return;
		}
		pending.receipts = [receipt];
	};

	const hasUserSettlementReceipt = (rt: SessionRuntime): boolean => rt.pendingSettled?.receipts[0]?.origin === "user";
	const composeSettlementText = (receipts: ReadonlyArray<{ text: string }>): string =>
		receipts.map(receipt => receipt.text).join("\n\n");

	const consumePublishedSettlement = (rt: SessionRuntime, text: string, window: number): void => {
		const pending = rt.pendingSettled;
		if (!pending || pending.window !== window) return;
		if (composeSettlementText(pending.receipts) === text) {
			rt.pendingSettled = undefined;
			return;
		}
		const receipts = pending.receipts.filter(receipt => receipt.text !== text);
		if (receipts.length === pending.receipts.length) return;
		rt.pendingSettled = receipts.length ? { ...pending, receipts } : undefined;
	};

	const flushPendingFinal = (rt: SessionRuntime, id: string): void => {
		const pending = rt.pendingFinal;
		if (!pending) return;
		rt.pendingFinal = undefined;
		if (pending.window !== rt.settlementWindow) return;
		if (pending.receipts.length && rt.notificationsActive && !rt.redact) {
			// Under lean, hold intermediate finals until agent_end when the agent is still
			// running so provisional-policy activation cannot reintroduce per-turn spam.
			// A receipt retained from an idle reached during provisional policy has the
			// same settlement window. Merge it before either path publishes so stable
			// activation emits one composed terminal receipt, not two messages.
			if (rt.verbosity === "lean" && (rt.busy || rt.pendingSettled?.window === pending.window)) {
				for (const receipt of pending.receipts)
					deferLeanReceipt(rt, receipt.text, receipt.messageRef, pending.window, receipt.origin);
			} else {
				const text = composeSettlementText(pending.receipts);
				const messageRef = pending.receipts.length === 1 ? pending.receipts[0]?.messageRef : undefined;
				try {
					pushSessionFrame(rt, {
						type: "turn_stream",
						sessionId: id,
						phase: "finalized",
						finalAnswer: true,
						text,
						...(messageRef ? { messageRef } : {}),
					});
				} catch (error) {
					logger.warn(`notifications: pushFrame (pending turn) failed: ${String(error)}`);
				}
			}
		}
		resetTurnStreamState(rt);
	};

	/** Emit the deferred lean settled answer exactly once (agent_end / idle). */
	const flushPendingSettled = (rt: SessionRuntime, id: string): void => {
		const settled = rt.pendingSettled;
		if (!settled?.receipts.length || !rt.notificationsActive || rt.redact || rt.policySuspended) return;
		const text = composeSettlementText(settled.receipts);
		// A composition represents multiple finalized turns. It must be a fresh
		// terminal message rather than editing either constituent turn's stream.
		const messageRef = settled.receipts.length === 1 ? settled.receipts[0]?.messageRef : undefined;
		const previousLiveRef = rt.liveRef;
		if (messageRef) rt.liveRef = messageRef;
		try {
			if (flushTurnText(rt, id, text, true)) rt.pendingSettled = undefined;
		} finally {
			if (!messageRef) rt.liveRef = previousLiveRef;
		}
	};

	// Drive the live typing indicator: mark busy when the agent loop starts so
	// the daemon shows "typing…" in the thread while the agent is thinking,
	// before any turn output exists. Cleared on `agent_end` below.
	api.on("agent_start", async (event, ctx) => {
		const id = sessionId(ctx);
		const rt = runtimes.get(id);
		if (!rt) return;
		// Streaming state is SDK-visible session truth (context.get isStreaming);
		// it is tracked regardless of whether notifications are active.
		rt.busy = true;
		// The first prompt message arrives after turn_start. A pre-existing deferred
		// receipt means a message-less run is autonomous until a direct user prompt
		// authoritatively overrides it; otherwise start unbound.
		if (!rt.currentTurnSettlementOrigin && rt.pendingSettled) {
			rt.currentTurnSettlementOrigin = "autonomous";
			rt.currentTurnSettlementWindow = rt.settlementWindow;
		} else if (!rt.currentTurnSettlementOrigin) rt.currentTurnSettlementWindow = undefined;
		// A continuation re-enters the agent loop inside the same prompt and emits
		// another `agent_start`. Only a queued follow-up's exact SDK token may
		// claim its correlation; unrelated queue work must not consume it.
		const sdkRunToken = event.sdkRunToken;
		const correlation =
			rt.activePromptCorrelation ??
			(sdkRunToken
				? rt.pendingPromptCorrelationsBySdkRunToken.get(sdkRunToken)
				: rt.pendingPromptCorrelations.shift());
		if (sdkRunToken && correlation) rt.pendingPromptCorrelationsBySdkRunToken.delete(sdkRunToken);
		const continuation = rt.activePromptCorrelation !== undefined;
		rt.activePromptCorrelation = correlation;
		if (correlation && !continuation) rt.bindPromptExecutionHandle(correlation, ctx.getActivePromptHandle());
		if (continuation) return;
		await rt.notePromptReconciliation(correlation, { type: "agent_start" });
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
		if (!rt) return;
		rt.turnSeq = (rt.turnSeq ?? 0) + 1;
		// Agent-loop prompts arrive after turn_start. Retain already-bound logical
		// provenance across tool/message-less continuation turns; a user prompt can
		// still authoritatively override framework-injected context below.
		if (!rt.notificationsActive) return;
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

	// `agent_failed` is an additive correlated diagnostic. The terminal
	// `agent_end` handler below remains the sole owner of prompt terminalization;
	// publishing this frame here lets clients surface the real failure while they
	// continue waiting for the durable terminal boundary.
	api.on("agent_failed", async (event, ctx) => {
		const id = sessionId(ctx);
		const rt = runtimes.get(id);
		if (!rt) return;
		const correlation = rt.activePromptCorrelation;
		if (!correlation) return;
		const error = sanitizePromptFailure(event.error);
		rt.emitPromptLifecycle(correlation, {
			type: "agent_failed",
			sessionId: id,
			...correlation,
			error,
		});
	});

	// Idle fires on `agent_end` (the agent loop settling to await the user), NOT
	// per `turn_end`. turn_end fires once per turn iteration, so a single
	// user-visible idle previously produced many idle pings (the flood); agent_end
	// fires exactly once per settle, yielding exactly one idle notification.
	api.on("agent_end", async (event, ctx) => {
		const id = sessionId(ctx);
		const rt = runtimes.get(id);
		if (!rt) return;
		// Clear the streaming flag for SDK consumers even when notifications are off.
		rt.busy = false;
		const correlation = rt.activePromptCorrelation;
		if (correlation) {
			const assistants = (Array.isArray(event.messages) ? [...event.messages].reverse() : []).filter(
				message => message && typeof message === "object" && (message as { role?: unknown }).role === "assistant",
			) as Array<{ stopReason?: unknown; errorKind?: unknown }>;
			const finalAssistant = assistants[0];
			const pendingOutcome = rt.peekPromptPendingOutcome(correlation);
			let outcome: SdkPromptTerminalOutcome;
			if (pendingOutcome) outcome = pendingOutcome;
			else if (finalAssistant?.stopReason === "length")
				outcome = { kind: "stopped", reason: "max_tokens", provenance: "agent" };
			else if (finalAssistant?.errorKind === "provider_safety_stop")
				outcome = { kind: "stopped", reason: "refusal", provenance: "agent" };
			// A missing/normal final assistant with a non-failing loop stop reason is a
			// normal turn end; only explicit error/aborted assistants or non-completed
			// loop stop reasons are failures. Text is never parsed.
			else if (
				(event.stopReason === undefined || event.stopReason === "completed") &&
				finalAssistant?.stopReason !== "error" &&
				finalAssistant?.stopReason !== "aborted"
			)
				outcome = { kind: "stopped", reason: "end_turn", provenance: "agent" };
			else
				outcome = {
					kind: "failed",
					code: "prompt_failed",
					message: "Prompt submission failed.",
					provenance: "agent_failed",
				};
			const successAssistant = assistants.find(
				message => (message as { stopReason?: unknown }).stopReason === "stop",
			);
			const finalText = successAssistant ? acpFinalTextFromMessage(successAssistant).text : "";
			// The normalized outcome is the ACP contract; existing SDK clients keep the
			// legacy failure discriminator on the wire and in the reconciliation record.
			const terminalAssistant = assistants.find(
				message =>
					(message as { stopReason?: unknown }).stopReason === "error" ||
					(message as { stopReason?: unknown }).stopReason === "aborted",
			) as { stopReason?: "error" | "aborted"; errorMessage?: unknown; errorKind?: unknown } | undefined;
			const legacyCode =
				event.stopReason === "cancelled"
					? "cancelled"
					: terminalAssistant?.stopReason === "error"
						? "agent_error"
						: terminalAssistant?.stopReason === "aborted"
							? "aborted"
							: undefined;
			// The SDK wire outcome and ACP error envelope use a fixed safe token by
			// contract (see `sanitizePromptFailure`). Assistant failure messages may
			// still remain in the local session transcript; terminalization copies only
			// a bounded reason into the local operator log.
			await rt.terminalizePrompt(correlation, outcome, {
				...(finalText ? { finalText } : {}),
				...(outcome.kind === "failed"
					? {
							diagnostic: {
								reason: terminalAssistant?.errorMessage,
								loopStopReason: event.stopReason ?? "none",
								assistantStopReason: terminalAssistant?.stopReason ?? "none",
								...(event.stopReason === "cancelled" ? { intentionalCancellation: true } : {}),
								...(typeof terminalAssistant?.errorKind === "string"
									? { errorKind: terminalAssistant.errorKind }
									: {}),
							},
						}
					: {}),
				...(outcome.kind === "failed" && legacyCode
					? {
							// Only the legacy discriminator is preserved; provider text is never
							// retained, matching `sanitizePromptFailure`.
							error: { code: legacyCode, message: "Prompt submission failed." },
						}
					: {}),
			});
		} else {
			rt.emitPromptLifecycle(undefined, { type: "agent_end", sessionId: id });
		}
		rt.activePromptCorrelation = undefined;
		terminalizeInFlightTools(rt, id, event.stopReason === "cancelled" ? "cancelled" : "failed");
		try {
			pushSessionFrame(rt, { type: "activity", sessionId: id, state: "idle" });
		} catch (e) {
			logger.warn(`notifications: activity (idle) failed: ${String(e)}`);
		}
		if (!rt.notificationsActive) return;
		void (typeof rt.workflowGate?.recoverAcceptedGates === "function"
			? rt.trackGateResolution(rt.workflowGate.recoverAcceptedGates()).catch(() => {})
			: Promise.resolve());
		const seq = rt.idleSeq++;
		// Re-assert the identity header so the daemon renames the topic once the
		// session title has been auto-generated ("{repo}/{branch} - {title}"). The
		// daemon only renames when the title actually changed. Bind the dependent
		// idle to the exact connection generations that accepted this positioned
		// identity; native raw fallbacks enqueue identity and idle as one bounded
		// writer command for the remaining snapshot cohort.
		try {
			const identity = {
				type: "identity_header",
				sessionId: id,
				...buildIdentity(ctx.cwd, ctx.sessionManager.getSessionName(), telegramTopicsEnabled()),
			} as const;
			const receipts = emitSessionEventWithReceipts(rt, identity);
			const outcome = rt.server.queueIdleAfterDirected(
				JSON.stringify(identity),
				receipts,
				JSON.stringify(
					notificationActionPayload(
						{
							id: `idle:${id}#${seq}`,
							kind: "idle",
							sessionId: id,
							summary: undefined,
						},
						{ redact: rt.redact },
					),
				),
			);
			if (outcome.status === "rejected" || outcome.status === "partial") {
				logger.warn(
					`notifications: dependent idle ${outcome.status} (${outcome.queuedCount}/${outcome.recipientCount} recipients queued)`,
				);
			}
		} catch (error) {
			logger.warn(`notifications: recipient-bound identity/idle delivery failed: ${String(error)}`);
		}

		// Lean: emit the latest deferred assistant answer exactly once at idle.
		// Intermediate tool-turn narration was held on turn_end; ask lead-ins were
		// already flushed immediately and deduped via preAskFlushedText.
		flushPendingSettled(rt, id);
		// A terminal idle closes the logical settlement run. The next agent_start
		// must establish provenance from its own prompt messages.
		rt.currentTurnSettlementOrigin = undefined;
		rt.currentTurnSettlementWindow = undefined;

		// On idle, stream a context update with metadata (token/model usage +
		// working-tree diff) unless redaction is on. Under verbose the agent's last
		// message is already streamed per turn_end; lean flushes it just above.
		if (!rt.redact && rt.verbosity === "verbose") {
			const usage = (
				ctx as { getContextUsage?: () => { tokens: number | null; contextWindow: number } | undefined }
			).getContextUsage?.();
			const model = (ctx as { getModel?: () => { id?: string } | undefined }).getModel?.();
			const tokenUsage = usage && usage.tokens != null ? `${usage.tokens}/${usage.contextWindow}` : undefined;
			const modelId = model?.id;
			const generation = rt.policyGeneration;
			void (options.readNotificationDiffStat ?? readGitDiffStat)(ctx.cwd).then(diff => {
				if (!canDeliverAsync(rt, generation)) return;
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

	// Stream viable agent output. Verbose mirrors each turn that produced assistant
	// text. Lean defers the latest answer until agent_end (idle) so tool-heavy runs
	// do not flood remote clients with intermediate narration; ask lead-ins still
	// flush immediately. Tool-only turns yield no text and are skipped. Redaction
	// suppresses streamed content (only the one-time identity header survives).
	// The daemon coalesces/throttles these via its shared rate-limit pool.
	// Push the in-flight turn's assistant text as a finalized turn_stream, deduped
	// against what was already flushed for this turn (the pre-ask lead-in).
	const flushTurnText = (rt: SessionRuntime, id: string, text: string | undefined, finalAnswer: boolean): boolean => {
		if (!text || text === rt.preAskFlushedText || !rt.notificationsActive || rt.policySuspended) return false;
		const hadUserSettlementReceipt = hasUserSettlementReceipt(rt);
		const settlementWindow = rt.currentTurnSettlementWindow ?? rt.settlementWindow;
		// Decision A: a stream-enabled turn must finalize as an in-place edit of ONE
		// live message, never a fresh (rich-promotable) send. If live frames were
		// async-queued and none landed before this flush, reuse the per-turn ref
		// assigned at turn_start so the finalized frame remains editable (HTML edit)
		// and never rich-promotes a streamed final.
		if (finalAnswer && rt.stream && rt.liveRef === undefined && rt.turnSeq !== undefined) {
			rt.liveRef = String(rt.turnSeq);
		}
		try {
			const published = pushSessionFrame(rt, {
				type: "turn_stream",
				sessionId: id,
				phase: "finalized",
				finalAnswer,
				text,
				...(rt.liveRef ? { messageRef: rt.liveRef } : {}),
			});
			if (!published) return false;
			rt.preAskFlushedText = text;
			if (!finalAnswer) {
				// A successfully published ask lead-in settles only exact matching
				// receipts from the same user-request window. Distinct retained user
				// receipts remain eligible for the idle summary (#4458).
				consumePublishedSettlement(rt, text, settlementWindow);
				// Ask lead-ins supersede deferred lean narration from earlier turns so
				// agent_end does not re-emit stale intermediate text (#2863 review).
				// Preserve the pre-publish user-receipt decision even when the exact
				// match above consumed that receipt.
				if (rt.currentTurnSettlementOrigin !== "autonomous" && !hadUserSettlementReceipt)
					rt.pendingSettled = undefined;
			}
			return true;
		} catch (e) {
			logger.warn(`notifications: pushFrame (turn) failed: ${String(e)}`);
			return false;
		}
	};

	// Emit the assistant text that precedes an ask BEFORE the ask's action_needed
	// is broadcast, so the remote (e.g. Telegram) shows the lead-in first instead
	// of only after the ask resolves at turn_end. The text is captured on
	// message_end (which, like tool_execution_start, is on the awaited extension
	// path and ordered before it — unlike message_update, which is queued async),
	// then flushed here before the ask tool's execute calls registerAsk.
	api.on("tool_execution_start", (event, ctx) => {
		const id = sessionId(ctx);
		const rt = runtimes.get(id);
		rt?.emitPromptEvent(event);
		if (event.toolName === "ask") {
			if (!rt?.notificationsActive || rt.redact) return;
			if (rt.currentTurnSettlementWindow !== undefined && rt.currentTurnSettlementWindow !== rt.settlementWindow)
				return;
			flushTurnText(rt, id, rt.currentTurnText, false);
		}
		if (!rt?.notificationsActive || rt.redact) return;
		rt.inFlightTools.set(event.toolCallId, { toolName: event.toolName, args: event.args });
		try {
			pushSessionFrame(rt, {
				type: "tool_activity",
				sessionId: id,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				phase: "started",
			});
		} catch (e) {
			logger.warn(`notifications: tool_activity start failed: ${String(e)}`);
		}
	});

	api.on("tool_execution_update", (event, ctx) => {
		const rt = runtimes.get(sessionId(ctx));
		rt?.emitPromptEvent(event);
	});

	api.on("tool_execution_end", (event, ctx) => {
		const id = sessionId(ctx);
		const rt = runtimes.get(id);
		if (!rt) return;
		rt.emitPromptEvent(event);
		const inFlight = rt.inFlightTools.get(event.toolCallId);
		if (!inFlight) return;
		if (!rt.notificationsActive) {
			rt.inFlightTools.delete(event.toolCallId);
			return;
		}
		if (rt.policySuspended) {
			if (!inFlight.pendingPhase) {
				rt.inFlightTools.set(event.toolCallId, {
					toolName: inFlight.toolName,
					pendingPhase: event.isError ? "failed" : "completed",
				});
			}
			return;
		}
		if (rt.redact) {
			rt.inFlightTools.delete(event.toolCallId);
			return;
		}
		try {
			const frame: {
				type: "tool_activity";
				sessionId: string;
				toolCallId: string;
				toolName: string;
				phase: "completed" | "failed";
				isError: boolean;
				argsSummary?: string;
				resultSummary?: string;
			} = {
				type: "tool_activity",
				sessionId: id,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				phase: event.isError ? "failed" : "completed",
				isError: event.isError,
			};
			if (rt.verbosity === "verbose") {
				const tool = ctx.resolveTool(event.toolName);
				const argsSummary = projectToolSummary(tool, "args", inFlight?.args);
				const resultSummary = projectToolSummary(tool, "result", event.result);
				if (argsSummary !== undefined) frame.argsSummary = argsSummary;
				if (resultSummary !== undefined) frame.resultSummary = resultSummary;
			}
			pushSessionFrame(rt, frame);
		} catch (e) {
			logger.warn(`notifications: tool_activity end failed: ${String(e)}`);
		} finally {
			rt.inFlightTools.delete(event.toolCallId);
		}
	});

	api.on("reasoning_summary_end", (event, ctx) => {
		const id = sessionId(ctx);
		const rt = runtimes.get(id);
		if (!rt?.notificationsActive || rt.redact || rt.verbosity !== "verbose") return;
		if (!event.message || typeof event.message !== "object" || !("content" in event.message)) return;
		const content = event.message.content;
		if (!Array.isArray(content)) return;
		const block = content[event.contentIndex];
		if (block?.type !== "thinking" || (block.provenance !== "summary" && block.provenance !== "mixed")) return;
		// CoT boundary: emit ONLY the canonical provider-marked summaryText. Never
		// fall back to the event payload, which could carry inconsistent/mutated text.
		const text = block.summaryText;
		if (typeof text !== "string" || text === "") return;
		try {
			pushSessionFrame(rt, {
				type: "reasoning_summary",
				sessionId: id,
				text,
				// Coalesce on the reasoning block's stable itemId carried on the event, NOT
				// the mutable rt.turnSeq: a streamed reasoning_summary_end is queued async and
				// turn_start for the next iteration advances turnSeq synchronously first, so
				// reading turnSeq here could bind turn N's summary to turn N+1. Absent an
				// itemId, omit turnRef (threaded-render sends a fresh non-editable message).
				...((block as { itemId?: string }).itemId ? { turnRef: (block as { itemId?: string }).itemId } : {}),
			});
		} catch (e) {
			logger.warn(`notifications: reasoning_summary failed: ${String(e)}`);
		}
	});

	api.on("turn_end", (event, ctx) => {
		const id = sessionId(ctx);
		const rt = runtimes.get(id);
		if (!rt || (!rt.notificationsActive && !rt.policySuspended)) return;
		const text = rt.policySuspended
			? rt.committedRedact
				? undefined
				: summaryFromMessage(event.message, turnTextMax())
			: rt.redact
				? undefined
				: summaryFromMessage(event.message, turnTextMax());
		if (rt.policySuspended) {
			deferProvisionalReceipt(rt, text, rt.liveRef);
			rt.turnClosed = true;
			return;
		}
		if (text) {
			if (rt.currentTurnSettlementWindow !== undefined && rt.currentTurnSettlementWindow !== rt.settlementWindow) {
				resetTurnStreamState(rt);
				return;
			}
			if (rt.verbosity === "verbose") {
				// Verbose: one finalized turn_stream per turn with assistant text.
				flushTurnText(rt, id, text, true);
			} else if (text !== rt.preAskFlushedText) {
				// Lean: hold the latest answer until agent_end. Skip when this turn
				// already flushed the same text as an ask lead-in (no duplicate at idle).
				deferLeanReceipt(rt, text, rt.liveRef);
			} else {
				// Lead-in already flushed: drop any older deferred settled text so idle
				// does not re-emit intermediate narration after the ask prompt (#2863).
				if (rt.currentTurnSettlementOrigin === "user" || !hasUserSettlementReceipt(rt))
					rt.pendingSettled = undefined;
			}
		}
		resetTurnStreamState(rt);
	});

	// Live streaming (opt-in + verbose only): push throttled in-progress assistant
	// text as non-finalized turn_stream frames so remote clients edit one message
	// as the turn streams. Lean keeps settled-answer-only delivery; live frames
	// are suppressed even when the stream preference is on. The finalized frame
	// (turn_end / agent_end) carries the same messageRef and lands the authoritative
	// text. Suppressed under redaction.
	api.on("message_update", (event, ctx) => {
		const id = sessionId(ctx);
		const rt = runtimes.get(id);
		rt?.emitPromptEvent(event);
		if (!rt?.notificationsActive || !rt.stream || rt.redact || rt.turnClosed || rt.verbosity !== "verbose") return;
		if ((event.message as { role?: unknown }).role !== "assistant") return;
		if (rt.liveRef === undefined && rt.turnSeq !== undefined) {
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
		rt?.emitPromptEvent(event);
		if (rt) {
			const message = event.message as { role?: unknown; attribution?: unknown; customType?: unknown };
			if (isUserSettlementBoundary(message)) {
				const openingTurn = rt.currentTurnSettlementOrigin !== "user";
				const supersedingSettledTurn =
					rt.currentTurnSettlementOrigin === "user" &&
					(rt.pendingSettled !== undefined || rt.pendingFinal !== undefined);
				// A provider batch can carry several user messages after one turn_start.
				// They share that turn's boundary. A later user submission after the old
				// turn has produced a receipt opens a new window but must not relabel the
				// already-running turn as its response.
				if (openingTurn || supersedingSettledTurn) rt.settlementWindow++;
				if (openingTurn || supersedingSettledTurn) {
					rt.currentTurnSettlementWindow = rt.settlementWindow;
					rt.currentTurnSettlementOrigin = "user";
				}
				rt.pendingSettled = undefined;
				rt.pendingFinal = undefined;
			} else if (message.role !== "assistant") {
				// The assembled direct prompt can contain framework context after its
				// user message. A user boundary is authoritative for this turn.
				if (rt.currentTurnSettlementOrigin !== "user" || !isFrameworkPromptContext(message)) {
					rt.currentTurnSettlementWindow = rt.settlementWindow;
					rt.currentTurnSettlementOrigin = "autonomous";
				}
			}
		}
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
		extensionShuttingDown = true;
		identityControlInFlight = false;
		deferredIdentityRotation = undefined;
		const id = sessionId(ctx);
		// Join settled start+reconcile before owner release. Keep pending native
		// startup (/notify on) nonblocking — do not await sessionLifecycleTasks while
		// sessionStartPromises still has this id.
		if (!sessionStartPromises.has(id)) await Promise.allSettled([...sessionLifecycleTasks]);
		await Promise.allSettled([...branchStartupTasks]);
		const rt = runtimes.get(id);
		if (rt) terminalizeInFlightTools(rt, id, "cancelled");
		// Startup is only genuinely in flight when a `sessionStartPromises` entry
		// exists. Once startup has settled, the host is broker-visible and its
		// post-start `reconcileCurrentSession` may already have minted a
		// replacement notification-root token whose unregister is still awaiting
		// its file lock and atomic registry write. Returning before that settles
		// leaves a stale `sessions[id]` row that the retained older token is
		// correctly fenced from removing, so shutdown must join it.
		const startupWasPending = sessionStartPromises.has(id);
		const controllerStop =
			typeof ctx.sessionManager.getCwd === "function" ? controller.stopCurrentSession(ctx) : Promise.resolve(false);
		const settledControllerStop = controllerStop.catch(error => {
			logger.warn(`notifications: controller shutdown failed: ${String(error)}`);
			return false;
		});
		if (startupWasPending) void settledControllerStop;
		// #4743: a durability failure has no later retry cycle at terminal quit, so it
		// must reach the teardown owner instead of being logged into silence. Held
		// until the controller queue below is joined so the failure never truncates
		// the rest of teardown.
		let reconciliationTeardownFailure: Error | undefined;
		try {
			await stopSession(id);
		} catch (error) {
			// A retained owner-release failure keeps the exact runtime in
			// cleanupRetries for an explicit later retry; log it rather than
			// surfacing a red extension error at
			// shutdown. On terminal quit there is no later retry cycle, so log at
			// error severity (matching the postmortem cleanup precedent).
			logger.error(`notifications: SDK notification runtime cleanup failed: ${String(error)}`);
			// Endpoint-release failures (host/server stop) stay swallowed: they are
			// retryable through the retained cleanupRetries entry and observable in
			// lifecycle rollback proof. Reconciliation durability failures are not —
			// a committed publication that never reached disk, or a drain whose
			// deadline expired, is state loss the owner must be told about.
			const durable = reconciliationDurabilityFailures(error);
			if (durable.length > 0)
				reconciliationTeardownFailure = Object.assign(
					new Error(
						`SDK reconciliation teardown failed for session ${id}: ${durable
							.map(failure => reconciliationFailureCode(failure) ?? "unknown")
							.join(", ")}.`,
					),
					{ code: "sdk_reconciliation_teardown_failed", failures: durable },
				);
		}
		// Keep shutdown nonblocking only while native startup is genuinely
		// pending (the `/notify on` path); otherwise await the controller queue so
		// completed-start reconciliation and its replacement-token cleanup are
		// joined before lifecycle shutdown returns.
		if (!startupWasPending) await settledControllerStop;
		if (reconciliationTeardownFailure) throw reconciliationTeardownFailure;
	});
}

/**
 * Notifications extension.
 *
 * Hosts a per-session loopback WebSocket notification server (the Rust core via
 * N-API) and bridges GJC session events + the `ask` tool to it so a remote client
 * (e.g. a Telegram bot) can both see action-needed signals and ANSWER them —
 * without requiring RPC/unattended mode:
 *
 * - `ask` (interactive): registers an {@link AskAnswerSource}; the ask tool races
 *   the local UI against a remote reply. First valid answer wins; a local answer
 *   aborts the remote wait (and broadcasts `action_resolved` resolvedBy=local).
 * - `ask` (unattended/RPC): observes emitted workflow gates and resolves the real
 *   gate on a remote reply via `ctx.workflowGate`.
 * - `turn_end` -> `action_needed` (kind `idle`, deduped per turn).
 * - `session_shutdown` -> `session_closed` frame, stop server, deregister answer source.
 *
 * Enable with Settings notifications config, `GJC_NOTIFICATIONS=1` (a token is
 * generated), or `GJC_NOTIFICATIONS_TOKEN`.
 */

import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { ImageContent, TextContent } from "@gajae-code/ai";
import { NotificationServer } from "@gajae-code/natives";
import { logger, postmortem } from "@gajae-code/utils";
import { Settings } from "../config/settings";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../extensibility/extensions";
import type {
	WorkflowGateEmitter,
	WorkflowGateTerminalController,
} from "../modes/shared/agent-wire/unattended-session";
import { parseThinkingLevel } from "../thinking";
import type {
	AskAnswerRequest,
	AskAnswerSourceResult,
	AskRemoteControl,
	AskRemoteInteraction,
	AskRemoteReceipt,
	AskSelectedAckOutcome,
	AskSettlement,
	AskSettlementResult,
} from "../tools";
import { registerAskAnswerSource, registerWorkflowGateEmitterListener } from "../tools/ask-answer-registry";
import { registerTelegramFileSink } from "./attachment-registry";
import {
	getNotificationConfig,
	isSessionNotificationsEnabled,
	isTelegramConfigured,
	type NotificationConfig,
	sessionTag,
} from "./config";
import { imageAttachmentsFromMessage, notificationActionPayload, summaryFromMessage } from "./helpers";
import { ensureTelegramDaemonRunning } from "./telegram-daemon";

// ===========================================================================
// Session lifecycle control protocol (TypeScript mirror of the Rust wire
// contract in `crates/gjc-notifications/src/lifecycle.rs`).
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
	/** Reference to the daemon-written, once-consumed startup-prompt file. */
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
	| "terminal_uncertain";

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

interface PendingInteractiveAsk {
	resolve: (result: AskAnswerSourceResult) => void;
	options: string[];
	controls: readonly AskRemoteControl[];
	reissue: () => boolean;
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
}

/** Keeps transport interaction ids separate from durable workflow gate ids. */
class GatePresentationRegistry {
	private readonly presentations = new Map<string, UnattendedGatePresentation>();
	private readonly routes = new Map<string, string>();

	constructor(
		private readonly server: NotificationServer,
		private readonly redact: () => boolean,
		private readonly tag: string,
	) {}

	retain(presentation: UnattendedGatePresentation): void {
		this.presentations.set(presentation.gateId, presentation);
	}

	routeFor(actionId: string): string | undefined {
		return this.routes.get(actionId);
	}

	presentationFor(actionId: string): UnattendedGatePresentation | undefined {
		const gateId = this.routes.get(actionId);
		return gateId ? this.presentations.get(gateId) : undefined;
	}

	toggle(actionId: string, label: string): boolean {
		const presentation = this.presentationFor(actionId);
		if (!presentation?.multi || !presentation.options.includes(label)) return false;
		this.closeInteraction(actionId, "toggle");
		const selected = new Set(presentation.selectedOptions);
		if (selected.has(label)) selected.delete(label);
		else selected.add(label);
		presentation.selectedOptions = [...selected];
		this.reissue(presentation.gateId);
		return true;
	}

	reissue(gateId: string): string | undefined {
		const presentation = this.presentations.get(gateId);
		if (!presentation) return undefined;
		const actionId = `gate-interaction:${crypto.randomUUID()}`;
		this.routes.set(actionId, gateId);
		try {
			this.server.registerAsk(
				JSON.stringify(
					notificationActionPayload(
						{
							id: actionId,
							kind: "ask",
							sessionId: presentation.sessionId,
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
								: [],
						},
						{ redact: this.redact(), sessionTag: this.tag },
					),
				),
				true,
			);
			return actionId;
		} catch (error) {
			this.routes.delete(actionId);
			logger.warn(`notifications: registerAsk (gate interaction) failed: ${String(error)}`);
			return undefined;
		}
	}

	closeInteraction(actionId: string, reason: string): void {
		this.routes.delete(actionId);
		try {
			this.server.resolveLocal(actionId, undefined);
		} catch {
			// The native claim close already terminalizes this action when applicable.
		}
		void reason;
	}

	complete(gateId: string): void {
		for (const [actionId, routeGateId] of this.routes) {
			if (routeGateId !== gateId) continue;
			this.closeInteraction(actionId, "gate_complete");
		}
		this.presentations.delete(gateId);
	}

	cancel(gateId: string, reason: string): void {
		this.complete(gateId);
		void reason;
	}

	dispose(): void {
		for (const gateId of [...this.presentations.keys()]) this.cancel(gateId, "session_shutdown");
	}
}

interface SessionRuntime {
	server: NotificationServer;
	idleSeq: number;
	/** Interactive asks awaiting a remote answer, by action id. */
	pendingInteractive: Map<string, PendingInteractiveAsk>;
	/** Deregisters this session's ask answer source. */
	disposeAnswerSource: () => void;
	/** Deregisters this session's Telegram file sink. */
	disposeFileSink: () => void;
	/** Deregisters this session's unattended workflow-gate listener. */
	disposeGateListener: () => void;
	/** Deregisters canonical workflow-gate terminal cleanup. */
	disposeGateTerminalController: () => void;
	disposeAckRecoveryParticipant: () => void;
	disposeGateEmitterListener: () => void;
	workflowGate?: WorkflowGateEmitter;
	gatePresentations?: GatePresentationRegistry;
	redact: boolean;
	verbosity: "lean" | "verbose";
	sessionTag: string;
	/** Whether the agent loop is currently running (drives the typing indicator). */
	busy: boolean;
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
		channelId: undefined,
	},
	slack: {
		botToken: undefined,
		channelId: undefined,
	},
	redact: false,
	verbosity: "lean",
	idleTimeoutMs: 60_000,
	rich: { enabled: true },
	richDraft: { enabled: false },
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
function resolveSettings(settingsOverride?: Settings): ResolvedSettings {
	if (settingsOverride)
		return { settings: settingsOverride, cfg: getNotificationConfig(settingsOverride), settingsAvailable: true };
	try {
		const settings = Settings.instance;
		return { settings, cfg: getNotificationConfig(settings), settingsAvailable: true };
	} catch {
		return { settings: undefined, cfg: defaultConfig, settingsAvailable: false };
	}
}

function resolveToken(): string {
	return process.env.GJC_NOTIFICATIONS_TOKEN ?? crypto.randomBytes(24).toString("base64url");
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

/** Workflow-gate answer shape (unattended mode). */
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
 * Map a client answer to the workflow-gate answer shape (unattended mode).
 *
 * The protocol defines a numeric reply as an option index, so a number outside
 * `options` is invalid (issue #2030): it must NOT be converted into a free-text
 * `Other` that passes the ask schema and triggers a misleading success ack.
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
	instructions?: unknown;
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

function cycleTelegramThinking(api: ExtensionAPI): ThinkingLevel | undefined {
	const levels = [
		ThinkingLevel.Off,
		ThinkingLevel.Minimal,
		ThinkingLevel.Low,
		ThinkingLevel.Medium,
		ThinkingLevel.High,
		ThinkingLevel.XHigh,
		ThinkingLevel.Max,
	];
	const current = api.getThinkingLevel() ?? ThinkingLevel.Off;
	const currentIndex = levels.indexOf(current as (typeof levels)[number]);
	const next = levels[(currentIndex + 1) % levels.length];
	if (!next) return undefined;
	api.setThinkingLevel(next);
	return api.getThinkingLevel() ?? next;
}

export async function executeNotificationControlCommand(
	command: NotificationControlCommandPayload | undefined,
	ctx: ExtensionContext,
	api: ExtensionAPI,
): Promise<{ status: "ok" | "error" | "unavailable"; message: string }> {
	if (!command || typeof command.name !== "string") return { status: "error", message: "Invalid control command." };
	switch (command.name) {
		case "reasoning": {
			const current = api.getThinkingLevel() ?? ThinkingLevel.Off;
			if (command.action === "status") return { status: "ok", message: `Reasoning effort: ${current}` };
			if (command.action === "cycle") {
				const next = cycleTelegramThinking(api);
				return next
					? { status: "ok", message: `Reasoning effort set to ${next}.` }
					: { status: "unavailable", message: "Reasoning effort unavailable for this session." };
			}
			if (command.action === "set" && typeof command.level === "string") {
				const parsed = parseThinkingLevel(command.level);
				if (!parsed) return { status: "error", message: "Invalid reasoning effort." };
				api.setThinkingLevel(parsed);
				return { status: "ok", message: `Reasoning effort set to ${api.getThinkingLevel() ?? ThinkingLevel.Off}.` };
			}
			return { status: "error", message: "Invalid reasoning command." };
		}
		case "usage":
			return { status: "ok", message: formatLocalUsage(ctx) };
		case "context":
			return { status: "ok", message: formatContextUsageLine(ctx) };
		case "compact": {
			const before = ctx.getContextUsage()?.tokens;
			try {
				await ctx.compact(typeof command.instructions === "string" ? command.instructions : undefined);
			} catch (err) {
				return {
					status: "error",
					message: `Compaction failed: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
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
	server: NotificationServer,
	pendingInteractive: Map<string, PendingInteractiveAsk>,
	getRedact: () => boolean,
	tag: string,
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
			const register = (askId: string): boolean => {
				try {
					server.registerAsk(
						JSON.stringify(
							notificationActionPayload(
								{
									id: askId,
									kind: "ask",
									sessionId: id,
									question: request.question,
									options: request.options,
									controls: request.controls,
								},
								{ redact: getRedact(), sessionTag: tag },
							),
						),
						true,
					);
					return true;
				} catch (error) {
					logger.warn(`notifications: registerAsk failed: ${String(error)}`);
					return false;
				}
			};
			let activeAskId = `ask:${crypto.randomUUID()}`;
			if (!register(activeAskId)) return Promise.resolve(undefined);
			return new Promise<AskAnswerSourceResult>(resolve => {
				const pending: PendingInteractiveAsk = {
					resolve,
					options: request.options,
					controls: request.controls,
					reissue: () => {
						const nextAskId = `ask:${crypto.randomUUID()}`;
						if (!register(nextAskId)) return false;
						activeAskId = nextAskId;
						pendingInteractive.set(nextAskId, pending);
						return true;
					},
				};
				pendingInteractive.set(activeAskId, pending);
				signal?.addEventListener("abort", () => {
					if (!pendingInteractive.delete(activeAskId)) return;
					try {
						server.resolveLocal(activeAskId, undefined);
					} catch {}
					resolve(undefined);
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

export function createNotificationsExtension(api: ExtensionAPI, options: { settings?: Settings } = {}): void {
	const runtimes = new Map<string, SessionRuntime>();
	const disabledSessions = new Set<string>();
	const sessionId = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();
	const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

	async function stopSession(id: string): Promise<boolean> {
		const rt = runtimes.get(id);
		if (!rt) return false;
		runtimes.delete(id);
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
			rt.disposeGateTerminalController();
		} catch {}
		try {
			rt.disposeAckRecoveryParticipant();
		} catch {}
		try {
			rt.disposeGateEmitterListener();
		} catch {}
		rt.gatePresentations?.dispose();
		// Resolve any still-pending interactive asks so the ask tool is not left hanging.
		for (const pending of rt.pendingInteractive.values()) pending.resolve(undefined);
		rt.pendingInteractive.clear();
		let closeFrameSent = false;
		try {
			rt.server.pushFrame(JSON.stringify({ type: "session_closed", sessionId: id }));
			closeFrameSent = true;
		} catch (e) {
			logger.warn(`notifications: session_closed failed: ${String(e)}`);
		}
		if (closeFrameSent) await sleep(100);
		try {
			rt.server.stop();
		} catch (e) {
			logger.warn(`notifications: stop failed: ${String(e)}`);
		}
		return true;
	}

	function isEnabledForSession(id: string, cfg: NotificationConfig): boolean {
		return isSessionNotificationsEnabled({ cfg, env: process.env, sessionDisabled: disabledSessions.has(id) });
	}

	function isNotificationEligibleContext(ctx: ExtensionContext): boolean {
		return ctx.sessionMetadata?.kind !== "sub";
	}

	async function startSession(ctx: ExtensionContext): Promise<"started" | "already" | "disabled" | "failed"> {
		const id = sessionId(ctx);
		const { settings, cfg, settingsAvailable } = resolveSettings(options.settings);
		if (!isNotificationEligibleContext(ctx) || !isEnabledForSession(id, cfg)) return "disabled";
		if (runtimes.has(id)) return "already";

		const stateRoot = path.join(ctx.cwd, ".gjc", "state");
		const gateOptions = new Map<string, string[]>();
		const pendingInteractive = new Map<string, PendingInteractiveAsk>();
		const tag = sessionTag(id);
		const redact = cfg.redact;
		const verbosity = cfg.verbosity;
		let runtime: SessionRuntime | undefined;

		// The SDK can always answer now (interactive via the answer source, or the
		// unattended gate), so the endpoint advertises a resolver.
		const server = new NotificationServer(id, resolveToken(), stateRoot, true);
		const gatePresentations = new GatePresentationRegistry(server, () => runtime?.redact ?? redact, tag);

		server.onReply((err, reply) => {
			if (err || !reply) return;
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
				pendingInteractive.delete(reply.id);
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
								native.closeClaimInvalid(reply.replyReceiptId, settlement.reason);
								return { kind: "invalid_closed" };
							}
							if (settlement.kind === "resolve_without_commit") {
								native.resolveClaim(reply.replyReceiptId, reply.answerJson, reply.idempotencyKey ?? undefined);
								return { kind: "resolved_without_commit" };
							}
							const ack = await requestLiveSelectedAck(native, {
								replyReceiptId: reply.replyReceiptId,
								actionId: reply.id,
								commitKey: `${reply.id}:${reply.idempotencyKey ?? reply.replyReceiptId}`,
								deadlineAt: Date.now() + 8_000,
							});
							native.resolveClaim(reply.replyReceiptId, reply.answerJson, reply.idempotencyKey ?? undefined);
							return { kind: "committed", ack };
						});
						return settled;
					},
				};
				pending.resolve(receipt);
				return;
			}
			const gate = runtime?.workflowGate;
			const unattended =
				gate?.isUnattended?.() === true &&
				typeof gate.onGateEmitted === "function" &&
				typeof gate.resolveGate === "function";
			const gateId = gatePresentations.routeFor(reply.id);
			if (unattended && gateId && gate?.resolveGateFromNotification) {
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
				void gate
					.resolveGateFromNotification(
						{ gate_id: gateId, answer, idempotency_key: reply.idempotencyKey ?? undefined },
						{
							interactionActionId: reply.id,
							replyReceiptId: reply.replyReceiptId,
							answerJson: reply.answerJson,
							idempotencyKey: reply.idempotencyKey ?? undefined,
							resolveClaim: () =>
								native.resolveClaim(reply.replyReceiptId, reply.answerJson, reply.idempotencyKey ?? undefined),
							closeClaimInvalid: reason => {
								native.closeClaimInvalid(reply.replyReceiptId, reason);
								gatePresentations.closeInteraction(reply.id, reason);
								gatePresentations.reissue(gateId);
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
					.catch(error => logger.warn(`notifications: resolveGateFromNotification failed: ${String(error)}`));
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
										({ type: "image", data: img.data, mimeType: img.mime ?? "image/jpeg" }) as ImageContent,
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
					sessionId: id,
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
						runtime.server.pushFrame(JSON.stringify(update));
					} catch (e) {
						logger.warn(`notifications: config_update failed: ${String(e)}`);
					}
				}
			}
			if (inbound.kind === "control_command") {
				if (!runtime || !inbound.requestId) return;
				void executeNotificationControlCommand(parseControlCommandPayload(inbound.commandJson), ctx, api)
					.then(result => {
						runtime?.server.pushFrame(
							JSON.stringify({
								type: "control_command_result",
								sessionId: id,
								requestId: inbound.requestId,
								updateId: inbound.updateId,
								status: result.status,
								message: result.message,
							}),
						);
					})
					.catch(err => {
						try {
							runtime?.server.pushFrame(
								JSON.stringify({
									type: "control_command_result",
									sessionId: id,
									requestId: inbound.requestId,
									updateId: inbound.updateId,
									status: "error",
									message: `Control command failed: ${err instanceof Error ? err.message : String(err)}`,
								}),
							);
						} catch (pushErr) {
							logger.warn(`notifications: control_command_result failed: ${String(pushErr)}`);
						}
					});
			}
		});

		try {
			const endpoint = await server.start();

			// Interactive answer source: the ask tool races the local UI against this.
			const disposeAnswerSource = registerInteractiveAnswerSource(
				id,
				server,
				pendingInteractive,
				() => runtime?.redact ?? redact,
				tag,
			);
			const disposeFileSink = registerTelegramFileSink(id, async file => {
				if (runtime?.redact ?? redact) {
					return { ok: false, error: TELEGRAM_FILE_REDACTION_ERROR };
				}

				try {
					const data = await fs.promises.readFile(file.path);
					server.pushFrame(
						JSON.stringify({
							type: "file_attachment",
							sessionId: id,
							name: path.basename(file.path),
							data: data.toString("base64"),
							caption: file.caption,
						}),
					);
					return { ok: true };
				} catch (e) {
					return { ok: false, error: e instanceof Error ? e.message : String(e) };
				}
			});

			runtime = {
				server,
				idleSeq: 0,
				pendingInteractive,
				disposeAnswerSource,
				disposeFileSink,
				disposeGateListener: () => {},
				disposeGateTerminalController: () => {},
				disposeAckRecoveryParticipant: () => {},
				disposeGateEmitterListener: () => {},
				workflowGate: undefined,
				gatePresentations,
				cancelPostmortemCleanup: () => {},
				redact,
				verbosity,
				stream: streamingEnabled(),
				sessionTag: tag,
				busy: false,
				pendingInbound: new Set<number>(),
			};
			runtimes.set(id, runtime);
			const activeRuntime = runtime;
			// A native terminal close (SIGHUP), SIGTERM, Ctrl+C exit, or fatal error
			// skips AgentSession.dispose(), so the `session_shutdown` extension event
			// never fires and the daemon-side topic would be orphaned. postmortem
			// awaits registered cleanups on those paths, so send the graceful
			// `session_closed` frame from there too. stopSession() cancels this
			// registration on every other teardown path, so it never double-fires.
			runtime.cancelPostmortemCleanup = postmortem.register(`notifications-session-closed:${id}`, async () => {
				await stopSession(id);
			});
			logger.info(`notifications: serving session ${id} at ${endpoint.url}`);

			if (settingsAvailable && settings && isTelegramConfigured(cfg)) {
				try {
					await ensureTelegramDaemonRunning({ settings, cwd: ctx.cwd, sessionId: id });
				} catch (e) {
					logger.warn(`notifications: failed to ensure Telegram daemon: ${String(e)}`);
				}
			}

			// One-time identity header (repo/branch/machine/session) pinned at the top
			// of the session thread by the daemon.
			try {
				server.pushFrame(
					JSON.stringify({
						type: "identity_header",
						sessionId: id,
						...buildIdentity(ctx.cwd, ctx.sessionManager.getSessionName()),
					}),
				);
			} catch (e) {
				logger.warn(`notifications: identity_header failed: ${String(e)}`);
			}

			// Workflow-gate installation occurs after session_start in RPC/bridge modes.
			// Attach dynamically so those sessions receive the same Telegram gate surface.
			const attachWorkflowGate = (gate: WorkflowGateEmitter | undefined): void => {
				if (activeRuntime.workflowGate === gate) return;
				activeRuntime.disposeGateListener();
				activeRuntime.disposeGateTerminalController();
				activeRuntime.disposeAckRecoveryParticipant();
				activeRuntime.disposeGateListener = () => {};
				activeRuntime.disposeGateTerminalController = () => {};
				activeRuntime.disposeAckRecoveryParticipant = () => {};
				activeRuntime.workflowGate = undefined;
				gateOptions.clear();
				gatePresentations.dispose();
				if (typeof gate?.onGateEmitted !== "function" || typeof gate.resolveGate !== "function") {
					return;
				}
				activeRuntime.workflowGate = gate;
				if (gate.registerGateTerminalController) {
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
						sessionId: id,
						question,
						options,
						controls: [],
						multi: stageState.multi === true,
						allowEmpty: stageState.allow_empty === true,
						navigationLabel: stageState.navigation_label === "Next" ? "Next" : "Done",
						selectedOptions: [],
					});
					gatePresentations.reissue(g.gate_id);
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
			};
			activeRuntime.disposeGateEmitterListener = registerWorkflowGateEmitterListener(id, attachWorkflowGate);
			if (ctx.workflowGate) attachWorkflowGate(ctx.workflowGate);
			return "started";
		} catch (e) {
			logger.warn(`notifications: failed to start server: ${String(e)}`);
			return "failed";
		}
	}

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
				disabledSessions.add(id);
				const stopped = await stopSession(id);
				ctx.ui.notify(
					stopped
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
				disabledSessions.delete(id);
				const result = await startSession(ctx);
				ctx.ui.notify(
					result === "started"
						? "Notifications enabled for this session."
						: result === "already"
							? "Notifications already enabled for this session."
							: result === "failed"
								? "Notifications failed to start for this session."
								: "Notifications are not configured. Run `gjc notify setup` or set GJC_NOTIFICATIONS=1.",
					result === "failed" ? "error" : result === "disabled" ? "warning" : "info",
				);
				return;
			}

			if (command !== "status") {
				ctx.ui.notify("Usage: /notify status | /notify on | /notify off", "warning");
				return;
			}

			const running = runtimes.has(id);
			const locallyDisabled = disabledSessions.has(id);
			const enabled = isEnabledForSession(id, resolved.cfg);
			const runtime = runtimes.get(id);
			ctx.ui.notify(
				`Notifications ${running ? "running" : enabled ? "enabled" : "disabled"} for this session; redaction ${(runtime?.redact ?? resolved.cfg.redact) ? "on" : "off"}; verbosity ${runtime?.verbosity ?? resolved.cfg.verbosity}${locallyDisabled ? "; locally off" : ""}.`,
				"info",
			);
		},
	});

	api.on("session_start", async (_event, ctx) => {
		await startSession(ctx);
	});

	// A session id change within the same process needs reason-aware handling.
	// `/new` and fork CONTINUE the same terminal thread (e.g. plan "approve and
	// execute" clears into a fresh session), so re-key the existing runtime
	// old→new WITHOUT recreating the NotificationServer: the server, its endpoint
	// discovery file, and the daemon's forum topic are all keyed by the original
	// session id and the daemon routes by socket, so the existing topic is reused
	// and the next identity frame renames it in place instead of spawning a new
	// thread. `resume`, by contrast, loads a DIFFERENT, already-persisted session
	// that owns its own topic — tear the previous runtime down and start fresh
	// under the resumed id so the daemon attaches to (or recreates) that
	// session's own discovery + topic rather than hijacking this terminal's.
	api.on("session_switch", async (event, ctx) => {
		const newId = sessionId(ctx);
		const prevId = sessionIdFromFile(event.previousSessionFile);
		if (!prevId || prevId === newId) return;

		if (event.reason === "resume") {
			stopSession(prevId);
			await startSession(ctx);
			return;
		}

		// `/new` / fork: re-key in place and rename the existing topic.
		if (disabledSessions.delete(prevId)) disabledSessions.add(newId);
		const rt = runtimes.get(prevId);
		if (!rt || runtimes.has(newId)) return;
		runtimes.delete(prevId);
		runtimes.set(newId, rt);
		// Re-bind the interactive ask answer source: the ask tool resolves the
		// source by the current session id, which just changed.
		try {
			rt.cancelPostmortemCleanup();
			rt.disposeAnswerSource();
			rt.disposeFileSink();
		} catch {}
		// Follow the id change so a later process teardown closes the re-keyed
		// session (the old closure captured the retired id).
		rt.cancelPostmortemCleanup = postmortem.register(`notifications-session-closed:${newId}`, async () => {
			await stopSession(newId);
		});
		rt.disposeAnswerSource = registerInteractiveAnswerSource(
			newId,
			rt.server,
			rt.pendingInteractive,
			() => rt.redact,
			rt.sessionTag,
		);
		rt.disposeFileSink = registerTelegramFileSink(newId, async file => {
			if (rt.redact) {
				return { ok: false, error: TELEGRAM_FILE_REDACTION_ERROR };
			}

			try {
				const data = await fs.promises.readFile(file.path);
				rt.server.pushFrame(
					JSON.stringify({
						type: "file_attachment",
						sessionId: newId,
						name: path.basename(file.path),
						data: data.toString("base64"),
						caption: file.caption,
					}),
				);
				return { ok: true };
			} catch (e) {
				return { ok: false, error: e instanceof Error ? e.message : String(e) };
			}
		});
		// Rename the existing topic now when the new session already has a name; a
		// fresh unnamed session is renamed on its next agent_end re-assert, which
		// avoids a transient rename to bare "repo/branch".
		if (ctx.sessionManager.getSessionName()) {
			try {
				rt.server.pushFrame(
					JSON.stringify({
						type: "identity_header",
						sessionId: newId,
						...buildIdentity(ctx.cwd, ctx.sessionManager.getSessionName()),
					}),
				);
			} catch (e) {
				logger.warn(`notifications: identity_header (switch) failed: ${String(e)}`);
			}
		}
	});

	// Drive the live typing indicator: mark busy when the agent loop starts so
	// the daemon shows "typing…" in the thread while the agent is thinking,
	// before any turn output exists. Cleared on `agent_end` below.
	api.on("agent_start", (_event, ctx) => {
		const id = sessionId(ctx);
		const rt = runtimes.get(id);
		if (!rt) return;
		rt.busy = true;
		try {
			rt.server.pushFrame(JSON.stringify({ type: "activity", sessionId: id, state: "busy" }));
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
		// A new turn is live: re-open the live-stream window (see turnClosed).
		rt.turnClosed = false;
		if (rt.pendingInbound.size === 0) return;
		for (const updateId of rt.pendingInbound) {
			try {
				rt.server.pushFrame(JSON.stringify({ type: "inbound_ack", sessionId: id, updateId, state: "consumed" }));
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
		const seq = rt.idleSeq++;
		// Clear the typing indicator: the agent loop has settled.
		rt.busy = false;
		try {
			rt.server.pushFrame(JSON.stringify({ type: "activity", sessionId: id, state: "idle" }));
		} catch (e) {
			logger.warn(`notifications: activity (idle) failed: ${String(e)}`);
		}
		// Re-assert the identity header so the daemon renames the topic once the
		// session title has been auto-generated ("{repo}/{branch} - {title}"). The
		// daemon only renames when the title actually changed.
		try {
			rt.server.pushFrame(
				JSON.stringify({
					type: "identity_header",
					sessionId: id,
					...buildIdentity(ctx.cwd, ctx.sessionManager.getSessionName()),
				}),
			);
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
					rt.server.pushFrame(
						JSON.stringify({
							type: "context_update",
							sessionId: id,
							tokenUsage,
							model: modelId,
							diff,
							cwd,
						}),
					);
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
		if (!text || text === rt.preAskFlushedText) return;
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
			rt.server.pushFrame(
				JSON.stringify({
					type: "turn_stream",
					sessionId: id,
					phase: "finalized",
					finalAnswer,
					text,
					...(rt.liveRef ? { messageRef: rt.liveRef } : {}),
				}),
			);
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
		if (!rt || rt.redact) return;
		flushTurnText(rt, id, rt.currentTurnText, false);
	});

	api.on("turn_end", (event, ctx) => {
		const id = sessionId(ctx);
		const rt = runtimes.get(id);
		if (!rt) return;
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
		if (!rt?.stream || rt.redact || rt.turnClosed) return;
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
			rt.server.pushFrame(
				JSON.stringify({ type: "turn_stream", sessionId: id, phase: "live", text, messageRef: rt.liveRef }),
			);
		} catch (e) {
			logger.warn(`notifications: pushFrame (live) failed: ${String(e)}`);
		}
	});

	// Stream agent-produced images (computer/browser/tool screenshots) as
	// image_attachment frames; suppressed when redaction is on.
	api.on("message_end", (event, ctx) => {
		const id = sessionId(ctx);
		const rt = runtimes.get(id);
		if (!rt || rt.redact) return;
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
				rt.server.pushFrame(
					JSON.stringify({
						type: "image_attachment",
						sessionId: id,
						source: img.source,
						mime: img.mime,
						data: img.data,
					}),
				);
			} catch (e) {
				logger.warn(`notifications: image_attachment failed: ${String(e)}`);
			}
		}
	});

	api.on("session_shutdown", async (_event, ctx) => {
		await stopSession(sessionId(ctx));
	});
}

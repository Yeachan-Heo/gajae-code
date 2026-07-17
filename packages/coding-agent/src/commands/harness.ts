/**
 * `gjc harness <verb>` — AI-native stateless JSON CLI for the coding-harness
 * operations control plane (v1, gajae-code adapter).
 *
 * Every verb emits the universal contract `{ ok, state, evidence, nextAllowedActions }`.
 * Foundation milestone (M1/M2) implements: start, observe, classify, events, retire,
 * and the spec-required `owner-not-live` blocking for submit. Owner-runtime verbs
 * (recover/validate/finalize/operate) return an honest `pending-<milestone>` contract
 * until the RuntimeOwner (M3+) lands.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Args, Command, Flags } from "@gajae-code/utils/cli";
import {
	GJC_TMUX_OWNER_GENERATION_ENV,
	GJC_TMUX_OWNER_SERVER_KEY_ENV,
	GJC_TMUX_OWNER_STATE_DIR_ENV,
} from "../gjc-runtime/session-state-sidecar";
import { resolveGjcTmuxBinary, resolveGjcTmuxCommand, sanitizeTmuxToken } from "../gjc-runtime/tmux-common";
import {
	captureOwnerGenerationBaselineSync,
	classifyCgroup,
	isExactScopedBootstrapSuccessReceipt,
	isOwnerGenerationBaselineCurrentSync,
	type OwnerGenerationBaseline,
	type OwnerIsolationProbe,
	observeOwnerTerminal,
	ownerProcessStartTime,
	planTmuxOwnerIsolation,
	replaceOwnerGenerationSync,
	type TmuxServerProof,
} from "../gjc-runtime/tmux-owner-isolation";
import { classifyRecovery } from "../harness-control-plane/classifier";
import { callEndpoint, EndpointUnreachableError } from "../harness-control-plane/control-endpoint";
import { type ResolvedOwner, RuntimeOwner, resolveOwner, resolveOwnerLive } from "../harness-control-plane/owner";
import { preserveDirtyWorktree } from "../harness-control-plane/preserve";
import { RECEIPT_SPOOL_DIR_ENV } from "../harness-control-plane/receipt-spool";
import { buildReceipt, requiresVanishBeforeAction, type VanishEvidence } from "../harness-control-plane/receipts";
import { createSdkSessionTransport, spawnNormalHarnessSession } from "../harness-control-plane/sdk-transport";
import { classifyLeaseStatus, readLease } from "../harness-control-plane/session-lease";
import { buildResponse, buildStateView, submitUnavailableReason } from "../harness-control-plane/state-machine";
import {
	canonicalWorkspacePath,
	generateSessionId,
	readEvents,
	readSessionState,
	rememberHarnessSessionRoot,
	resolveHarnessRoot,
	resolveHarnessSessionRoot,
	writeReceiptImmutable,
	writeSessionState,
} from "../harness-control-plane/storage";
import {
	DEFAULT_RETRY_BUDGET,
	type EventEnvelope,
	type GitDelta,
	type Harness as HarnessKind,
	type Observation,
	type RecoveryClassification,
	type RetryBudget,
	SESSION_SCHEMA_VERSION,
	type SessionHandle,
	type SessionState,
} from "../harness-control-plane/types";
import { SPAWN_PROVENANCE_ENV } from "../sdk/bus/config";

const PRIVATE_OWNER_CONTROL_FIELDS = new Set([
	"socket_key",
	"socketKey",
	"tmux_socket_key",
	"tmuxSocketKey",
	"tmux_owner_socket_key",
	"tmuxOwnerSocketKey",
	"owner_generation",
	"ownerGeneration",
	"state_dir",
	"stateDir",
	"owner_state_dir",
	"ownerStateDir",
	"owner_server_key",
	"ownerServerKey",
	"owner_server_pid",
	"ownerServerPid",
	"owner_server_start_time",
	"ownerServerStartTime",
	"tmux_owner_generation",
	"tmuxOwnerGeneration",
	"tmux_owner_state_dir",
	"tmuxOwnerStateDir",
	"tmux_owner_server_key",
	"tmuxOwnerServerKey",
	"tmux_owner_server_pid",
	"tmuxOwnerServerPid",
	"tmux_owner_server_start_time",
	"tmuxOwnerServerStartTime",
	"socket_path",
	"socketPath",
	"endpoint",
	"owner_terminal",
	"ownerTerminal",
	"generation",
	"server_key",
	"intent_id",
	"dedupe_key",
]);

function publicHarnessResponse(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(publicHarnessResponse);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([key]) => !PRIVATE_OWNER_CONTROL_FIELDS.has(key))
			.map(([key, item]) => [key, publicHarnessResponse(item)]),
	);
}

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(publicHarnessResponse(value), null, 2)}\n`);
}

function nowIso(): string {
	return new Date().toISOString();
}

function parseInput(raw: string | undefined): Record<string, unknown> {
	if (!raw?.trim()) return {};
	const parsed = JSON.parse(raw) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("input_must_be_json_object");
	}
	return parsed as Record<string, unknown>;
}

function gitDeltaFor(workspace: string): { gitDelta: GitDelta; branch: string | null; deleted: boolean } {
	if (!existsSync(workspace)) return { gitDelta: "unknown", branch: null, deleted: true };
	let branch: string | null = null;
	try {
		branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd: workspace,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		branch = null;
	}
	try {
		const porcelain = execFileSync("git", ["status", "--porcelain"], {
			cwd: workspace,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return { gitDelta: porcelain.trim().length > 0 ? "dirty" : "clean", branch, deleted: false };
	} catch {
		return { gitDelta: "unknown", branch, deleted: false };
	}
}
interface HarnessPreflight {
	ok: boolean;
	blockers: string[];
	workspace: string;
	actualBranch: string | null;
	declaredBranch: string | null;
	normalizedIssueOrPr: string | null;
}

function normalizeIssueOrPr(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value === "number") {
		if (Number.isSafeInteger(value) && value > 0) return String(value);
		throw new Error(`invalid_issue_or_pr:${value}`);
	}
	if (typeof value !== "string") throw new Error("invalid_issue_or_pr:not-string-or-number");
	const trimmed = value.trim();
	if (!trimmed) return null;
	const patterns = [
		/^#?(\d+)$/i,
		/^(?:pr|pull|issue)[-_#]?(\d+)$/i,
		/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#(\d+)$/,
		/^(?:https?:\/\/github\.com\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:pull|issues)\/(\d+)\/?$/i,
	];
	for (const pattern of patterns) {
		const match = trimmed.match(pattern);
		if (match?.[1]) return match[1];
	}
	throw new Error(`invalid_issue_or_pr:${trimmed}`);
}

function gitOutput(workspace: string, args: string[]): string | null {
	try {
		return execFileSync("git", args, {
			cwd: workspace,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

function resolveInputWorkspace(input: Record<string, unknown>): string {
	return canonicalWorkspacePath(typeof input.workspace === "string" ? input.workspace : process.cwd());
}

function buildPreflight(input: Record<string, unknown>): HarnessPreflight {
	const workspace = resolveInputWorkspace(input);
	const declaredBranch = typeof input.branch === "string" && input.branch.trim() ? input.branch.trim() : null;
	const blockers: string[] = [];
	const gitRoot = gitOutput(workspace, ["rev-parse", "--show-toplevel"]);
	const actualBranch = gitRoot ? gitOutput(workspace, ["rev-parse", "--abbrev-ref", "HEAD"]) : null;
	let normalizedIssueOrPr: string | null = null;

	if (!gitRoot) blockers.push("workspace-not-git-repo");
	if (gitRoot && actualBranch === "HEAD") blockers.push("detached-head");
	if (declaredBranch && actualBranch && actualBranch !== "HEAD" && declaredBranch !== actualBranch) {
		blockers.push("branch-mismatch");
	}
	try {
		normalizedIssueOrPr = normalizeIssueOrPr(input.issueOrPr ?? input.pr ?? input.issue);
	} catch (error) {
		blockers.push(error instanceof Error ? error.message : String(error));
	}

	return {
		ok: blockers.length === 0,
		blockers,
		workspace,
		actualBranch: actualBranch === "HEAD" ? null : actualBranch,
		declaredBranch,
		normalizedIssueOrPr,
	};
}

function startFatalPreflightBlockers(input: Record<string, unknown>, preflight: HarnessPreflight): string[] {
	const strict = input.strictPreflight === true || typeof input.branch === "string";
	return preflight.blockers.filter(blocker => {
		if (blocker === "branch-mismatch") return true;
		if (blocker.startsWith("invalid_issue_or_pr:")) return true;
		if (strict && (blocker === "workspace-not-git-repo" || blocker === "detached-head")) return true;
		return false;
	});
}

/** Fallback liveness after owner routing failed: no reachable owner handled this CLI call. */
function ownerLiveFor(_state: SessionState): boolean {
	return false;
}

function pushUnique(out: string[], value: unknown): void {
	if (typeof value === "string" && !out.includes(value)) out.push(value);
}

interface CompletedTerminalEvent {
	cursor: number;
	createdAt: string;
	kind: string;
}

function completedTerminalEvent(events: EventEnvelope[]): CompletedTerminalEvent | null {
	for (const event of [...events].reverse()) {
		const signal = (event.evidence as { signal?: unknown } | undefined)?.signal;
		if (event.kind === "rpc_agent_completed" || signal === "completed") {
			return { cursor: event.cursor, createdAt: event.createdAt, kind: event.kind };
		}
	}
	return null;
}

async function buildObservation(
	root: string,
	state: SessionState,
	ownerLive: boolean,
): Promise<{
	observation: Observation;
	completedTerminalEvent: CompletedTerminalEvent | null;
}> {
	const workspace = state.handle.workspace;
	const { gitDelta, branch, deleted } = gitDeltaFor(workspace);
	const events = await readEvents(root, state.sessionId, 0);
	const observedSignals = ["SessionStart"];
	for (const event of events.slice(-200)) {
		pushUnique(observedSignals, (event.evidence as { signal?: unknown } | undefined)?.signal);
		if (event.kind === "prompt_accepted") pushUnique(observedSignals, "prompt-accepted");
	}
	const terminalEvent = completedTerminalEvent(events);
	const lastEventAt = events.at(-1)?.createdAt;
	return {
		observation: {
			lifecycle: state.lifecycle,
			ownerLive,
			cwd: workspace,
			branch: branch ?? state.handle.branch,
			gitDelta,
			lastActivityAt: lastEventAt ?? state.updatedAt,
			observedSignals,
			risk: deleted ? "deleted-worktree" : !ownerLive && gitDelta === "dirty" ? "vanished-dirty" : "normal",
		},
		completedTerminalEvent: terminalEvent,
	};
}
interface OwnerExitEvidence {
	reason: string;
	leaseStatus: string;
	pid: number | null;
	endpointPresent: boolean;
	heartbeatAt: string | null;
	expiresAt: string | null;
	lastEventKind: string | null;
	lastEventAt: string | null;
	lastSignal: string | null;
	promptAcceptedSeen: boolean;
	completedSeen: boolean;
	/** True only when the owner is genuinely gone (lease missing or process dead). */
	terminal: boolean;
	/** True when the owner process is provably alive (live lease + fresh heartbeat) but the endpoint did not route. */
	transient: boolean;
	/** ISO timestamp of the most recent non-terminal RPC-derived owner event, if any (observability only). */
	lastRpcActivityAt: string | null;
	/**
	 * True when the owner started (reported live) but died before accepting the first prompt.
	 * This is a startup blocker, not a healthy live gate: callers must recover before submit.
	 */
	startupBlocker: boolean;
	/** Explicit, human-actionable recovery guidance for the surfaced exit reason. */
	recoveryGuidance: string;
}

function ownerExitGuidance(reason: string, startupBlocker: boolean): string {
	if (startupBlocker) {
		return "owner started and reported live but exited before accepting the first prompt; run `gjc harness recover --session <id>` to respawn the owner, then resubmit the prompt";
	}
	switch (reason) {
		case "owner-exited-after-prompt-acceptance":
			return "owner exited after accepting a prompt; run `gjc harness recover --session <id>` to preserve in-flight work and classify the vanish before resubmitting";
		case "owner-lease-expired":
		case "owner-endpoint-unreachable":
			return "owner lease is stale or its endpoint did not route; run `gjc harness recover --session <id>` to respawn or take over the owner";
		case "owner-liveness-unknown-permission-denied":
			return "owner liveness cannot be probed (permission denied); verify the owner process out-of-band before recover";
		default:
			return "no live owner holds this session; run `gjc harness recover --session <id>` to (re)spawn an owner, then resubmit";
	}
}

async function buildOwnerExitEvidence(root: string, state: SessionState): Promise<OwnerExitEvidence> {
	const lease = await readLease(root, state.sessionId);
	const leaseStatus = classifyLeaseStatus(lease);
	const events = await readEvents(root, state.sessionId, 0);
	const lastEvent = events.at(-1) ?? null;
	let lastSignal: string | null = null;
	let promptAcceptedSeen = false;
	let completedSeen = false;
	let lastRpcActivityAt: string | null = null;
	for (const event of events) {
		const signal = (event.evidence as { signal?: unknown } | undefined)?.signal;
		if (typeof signal === "string") lastSignal = signal;
		if (event.kind === "prompt_accepted" || signal === "prompt-accepted") promptAcceptedSeen = true;
		if (event.kind === "rpc_agent_completed" || signal === "completed") completedSeen = true;
		// Terminal completion/failure frames are NOT owner liveness — exclude them from activity.
		if (event.kind.startsWith("rpc_") && event.kind !== "rpc_agent_completed" && event.kind !== "rpc_agent_failed") {
			lastRpcActivityAt = event.createdAt;
		}
	}
	// Owner liveness is the lease heartbeat, never RPC frames: a "live" lease means the owner process
	// is alive and heartbeating within TTL, so a failed endpoint call is a transient observation gap.
	// Real owner loss (missing/dead lease) stays terminal and keeps its original reason string so
	// existing consumers that match on the reason continue to escalate.
	const terminal = !lease || leaseStatus === "dead";
	const transient = leaseStatus === "live";
	let reason = "owner-not-live";
	if (!lease) {
		reason = promptAcceptedSeen && !completedSeen ? "owner-exited-after-prompt-acceptance" : "owner-lease-missing";
	} else if (leaseStatus === "dead") {
		reason = promptAcceptedSeen && !completedSeen ? "owner-exited-after-prompt-acceptance" : "owner-process-dead";
	} else if (leaseStatus === "expiredAlive") {
		reason = "owner-lease-expired";
	} else if (leaseStatus === "epermAlive") {
		reason = "owner-liveness-unknown-permission-denied";
	} else {
		reason = "owner-endpoint-unreachable";
	}
	// A just-started owner that emitted `owner_started` (so it reported live) but is now terminal
	// without ever accepting a prompt died during startup. Surface this as an explicit, actionable
	// startup blocker rather than letting `submit` fall through to a misleading `owner-not-live` gate.
	const ownerStarted = events.some(event => event.kind === "owner_started");
	const startupBlocker = terminal && ownerStarted && !promptAcceptedSeen && !completedSeen;
	if (startupBlocker) reason = "owner-died-before-first-prompt";
	return {
		reason,
		leaseStatus,
		pid: lease?.pid ?? null,
		endpointPresent: Boolean(lease?.endpoint?.path),
		heartbeatAt: lease?.heartbeatAt ?? null,
		expiresAt: lease?.expiresAt ?? null,
		lastEventKind: lastEvent?.kind ?? null,
		lastEventAt: lastEvent?.createdAt ?? null,
		lastSignal,
		promptAcceptedSeen,
		completedSeen,
		terminal,
		transient,
		lastRpcActivityAt,
		startupBlocker,
		recoveryGuidance: ownerExitGuidance(reason, startupBlocker),
	};
}

async function writeVanishReceiptForDecision(
	root: string,
	state: SessionState,
	observation: Observation,
	classification: RecoveryClassification,
): Promise<string | null> {
	if (!requiresVanishBeforeAction(classification)) return null;
	const dirty = observation.gitDelta === "dirty" || observation.gitDelta === "unknown";
	const preservation = dirty ? preserveDirtyWorktree(observation.cwd) : null;
	const evidence: VanishEvidence = {
		classification,
		gitDelta: observation.gitDelta,
		gitStatusPorcelain: preservation
			? `tracked:${preservation.trackedDiffSha256};untracked:${preservation.untrackedManifest.length}`
			: observation.observedSignals.join(","),
		untrackedManifest: preservation?.untrackedManifest ?? [],
		preservation: preservation?.stashRef ? "stash" : "snapshot",
		stashRef: preservation?.stashRef ?? null,
		snapshotComplete: preservation?.snapshotComplete ?? true,
		forbiddenActions: dirty ? ["restart-clean", "delete", "reset"] : [],
	};
	const receipt = buildReceipt<VanishEvidence>({
		receiptId: `vanish-${Date.now()}-${randomBytes(4).toString("hex")}`,
		sessionId: state.sessionId,
		family: "vanish",
		source: "cli-recover",
		subject: {
			workspace: observation.cwd,
			branch: observation.branch,
			head: null,
			commit: null,
		},
		evidence,
	});
	await writeReceiptImmutable(root, state.sessionId, "vanish", receipt.receiptId, receipt);
	return receipt.receiptId;
}

function updateStateWithRestoredOwner(state: SessionState, leasePath: string, resolved: ResolvedOwner): void {
	state.lifecycle = "observing";
	state.blockers = state.blockers.filter(blocker => !isOwnerLivenessBlocker(blocker));
	state.handle.processHandle = {
		kind: "runtime-owner",
		ownerId: resolved.lease?.ownerId ?? null,
		pid: resolved.lease?.pid ?? null,
	};
	state.handle.ownerHandle = {
		leasePath,
		endpoint: resolved.socketPath,
		heartbeatAt: resolved.lease?.heartbeatAt ?? null,
	};
	state.updatedAt = nowIso();
}

function isOwnerLivenessBlocker(blocker: string): boolean {
	return blocker === "detached-owner-not-live" || blocker.startsWith("owner-vanished:");
}

async function reconcileCompletedOwnerExited(
	root: string,
	state: SessionState,
	observation: Observation,
	completedTerminal: CompletedTerminalEvent | null,
): Promise<SessionState> {
	if (!completedTerminal || observation.ownerLive || observation.gitDelta !== "clean") return state;
	if (state.lifecycle === "completed" || state.lifecycle === "retired") return state;
	state.lifecycle = "completed";
	state.blockers = state.blockers.filter(blocker => !isOwnerLivenessBlocker(blocker));
	state.updatedAt = nowIso();
	await writeSessionState(root, state);
	return state;
}

function needsVanishedOwnerBlock(
	state: SessionState,
	observation: Observation,
	completedTerminal: CompletedTerminalEvent | null,
): boolean {
	if (observation.ownerLive || state.lifecycle !== "observing") return false;
	if (completedTerminal || observation.observedSignals.includes("completed")) return false;
	return observation.observedSignals.some(
		signal => signal === "prompt-accepted" || signal === "tool-call" || signal === "streaming",
	);
}

async function markVanishedOwnerBlocked(
	root: string,
	state: SessionState,
	observation: Observation,
	completedTerminal: CompletedTerminalEvent | null,
): Promise<SessionState> {
	if (!needsVanishedOwnerBlock(state, observation, completedTerminal)) return state;
	const blocker = `owner-vanished:${observation.gitDelta}`;
	state.lifecycle = "blocked";
	state.blockers = state.blockers.includes(blocker) ? state.blockers : [...state.blockers, blocker];
	state.updatedAt = nowIso();
	await writeSessionState(root, state);
	return state;
}

const OWNER_STARTUP_BLOCKER = "owner-died-before-first-prompt";

/**
 * Persist an explicit startup blocker when an owner started, reported live, but died before
 * accepting the first prompt. This makes the failure an actionable lifecycle state instead of a
 * silent `owner-not-live` gate, so observe/recover surface it and recover can respawn the owner.
 */
async function markStartupOwnerBlocked(
	root: string,
	state: SessionState,
	ownerExit: OwnerExitEvidence,
): Promise<SessionState> {
	if (!ownerExit.startupBlocker) return state;
	if (state.lifecycle === "completed" || state.lifecycle === "retired") return state;
	state.lifecycle = "blocked";
	state.blockers = state.blockers.includes(OWNER_STARTUP_BLOCKER)
		? state.blockers
		: [...state.blockers, OWNER_STARTUP_BLOCKER];
	state.updatedAt = nowIso();
	await writeSessionState(root, state);
	return state;
}

function resolveRetryBudget(input: Record<string, unknown>): RetryBudget {
	const supplied = input.retryBudget;
	if (supplied && typeof supplied === "object" && !Array.isArray(supplied)) {
		return { ...DEFAULT_RETRY_BUDGET, ...(supplied as Partial<RetryBudget>) };
	}
	return { ...DEFAULT_RETRY_BUDGET };
}

interface OwnerSpawnResult {
	live: boolean;
	runtime: "tmux" | "detached" | "manual";
	tmuxSessionName: string | null;
	socketKey: string | null;
	fallbackReason: string | null;
	blockerReason: string | null;
	/** Exact-PID reap proof for a direct detached-owner child declared not-live (no orphan). */
	detachedOwnerReaped?: { pid: number; verified: boolean } | null;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function isBoundedNoServerDiagnostic(stderr: Uint8Array): boolean {
	const diagnostic = new TextDecoder().decode(stderr);
	return (
		diagnostic.length > 0 &&
		diagnostic.length <= 512 &&
		/^(?:no server running on |failed to connect to server|error connecting to )/i.test(diagnostic.trim())
	);
}

function sameServerIdentity(left: TmuxServerProof, right: TmuxServerProof): boolean {
	return (
		left.pid === right.pid &&
		left.startTime === right.startTime &&
		left.cgroup?.classification === right.cgroup?.classification &&
		left.cgroup?.scope === right.cgroup?.scope &&
		left.cgroup?.diagnostic === right.cgroup?.diagnostic
	);
}

function isSafeServerProof(proof: TmuxServerProof): boolean {
	return (
		proof.state === "safe" &&
		typeof proof.pid === "number" &&
		Number.isSafeInteger(proof.pid) &&
		proof.pid > 0 &&
		typeof proof.startTime === "string" &&
		proof.startTime.length > 0 &&
		(proof.cgroup?.classification === "safe" ||
			(process.platform !== "linux" && proof.cgroup?.classification === "not_applicable"))
	);
}

function exactNativeTmuxSessionId(stdout: Uint8Array): string | null {
	const value = new TextDecoder().decode(stdout);
	const line = value.endsWith("\n") ? value.slice(0, -1) : value;
	return /^\$\d+$/.test(line) ? line : null;
}

interface ScopedBootstrapReceipt {
	nativeSessionId: string;
	serverPid: number;
	serverStartTime: string;
	sessionName: string;
}

function scopedBootstrapReceipt(stdout: Uint8Array): ScopedBootstrapReceipt | null {
	const value = new TextDecoder().decode(stdout);
	if (!isExactScopedBootstrapSuccessReceipt(value)) return null;
	try {
		const receipt = JSON.parse(value) as {
			native_session_id: unknown;
			server_pid: unknown;
			server_start_time: unknown;
			session_name: unknown;
		};
		if (
			typeof receipt.native_session_id !== "string" ||
			!/^\$\d+$/.test(receipt.native_session_id) ||
			typeof receipt.server_pid !== "number" ||
			!Number.isSafeInteger(receipt.server_pid) ||
			receipt.server_pid <= 0 ||
			typeof receipt.server_start_time !== "string" ||
			!receipt.server_start_time ||
			typeof receipt.session_name !== "string" ||
			!receipt.session_name
		)
			return null;
		return {
			nativeSessionId: receipt.native_session_id,
			serverPid: receipt.server_pid,
			serverStartTime: receipt.server_start_time,
			sessionName: receipt.session_name,
		};
	} catch {
		return null;
	}
}

function ownerIsolationPlatform(): NodeJS.Platform {
	return process.platform === "linux" || process.env.GJC_HARNESS_TEST_ASSUME_LINUX_OWNER_ISOLATION !== "1"
		? process.platform
		: "linux";
}

function portableProcessStartTime(pid: number): string | null {
	if (process.platform === "linux") return null;
	const configured = process.env.GJC_HARNESS_PROCESS_START_COMMAND;
	let command: string[] = ["ps", "-o", "lstart=", "-p"];
	if (configured) {
		try {
			const parsed = JSON.parse(configured) as unknown;
			if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(value => typeof value !== "string" || !value))
				return null;
			command = parsed;
		} catch {
			return null;
		}
	}
	const result = Bun.spawnSync([...command, String(pid)], {
		stdout: "pipe",
		stderr: "ignore",
		env: { ...process.env, LC_ALL: "C", LANG: "C" },
	});
	if (result.exitCode !== 0) return null;
	const value = result.stdout.toString();
	const line = value.endsWith("\n") ? value.slice(0, -1) : value;
	if (
		!line ||
		line.includes("\n") ||
		line.includes("\r") ||
		Buffer.byteLength(line) > 128 ||
		!/^[\x20-\x7e]+$/.test(line)
	)
		return null;
	return `portable:${line}`;
}

function deterministicHarnessTmuxSessionName(sessionId: string): string {
	return `gajae_code_harness_${sanitizeTmuxToken(sessionId)}`;
}

async function loadState(root: string, sessionId: string): Promise<SessionState> {
	const state = await readSessionState(root, sessionId);
	if (!state) throw new Error(`session_not_found:${sessionId}`);
	return state;
}

function requireSessionId(input: Record<string, unknown>, flagSession: string | undefined): string {
	const id = flagSession ?? (typeof input.sessionId === "string" ? input.sessionId : undefined);
	if (!id) throw new Error("missing_session_id");
	return id;
}

export default class Harness extends Command {
	static description = "Operate coding harnesses (v1: gajae-code) as a session/evidence/recovery/PR control plane";
	static strict = false;

	static args = {
		verb: Args.string({
			description: "start|preflight|submit|observe|classify|recover|validate|finalize|retire|events|monitor|operate",
			required: true,
		}),
	};

	static flags = {
		input: Flags.string({ description: "JSON object input for the verb", default: "" }),
		"prompt-file": Flags.string({ description: "Read submit prompt text from a file (submit verb only)" }),
		session: Flags.string({ char: "s", description: "Session id (re-grab a session)" }),
		cursor: Flags.string({ description: "Event cursor for events --follow (exclusive)", default: "0" }),
		follow: Flags.boolean({ description: "Tail the owner-written event log", default: false }),
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON", default: true }),
		"receipt-spool-dir": Flags.string({
			description: "Append persisted ReceiptEnvelope records to spool.jsonl under this directory",
		}),
	};

	static examples = [
		`gjc harness start --input '{"harness":"gajae-code","workspace":".","branch":"feat/x"}'`,
		"gjc harness observe --session <id>",
		`gjc harness classify --input '{"observation":{"ownerLive":false,"gitDelta":"dirty","risk":"vanished-dirty"}}'`,
		"gjc harness events --session <id> --follow",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Harness);
		const verb = String(args.verb);
		let root = resolveHarnessRoot();
		try {
			const receiptSpoolDir = flags["receipt-spool-dir"];
			if (receiptSpoolDir !== undefined) {
				if (!receiptSpoolDir.trim()) throw new Error("receipt_spool_dir_empty");
				process.env[RECEIPT_SPOOL_DIR_ENV] = path.resolve(receiptSpoolDir.trim());
			}
			const input = parseInput(flags.input);
			const promptFile = flags["prompt-file"];
			if (promptFile !== undefined) {
				if (verb !== "submit") throw new Error("prompt_file_only_supported_for_submit");
				if (typeof input.prompt === "string" && input.prompt.length > 0) {
					throw new Error("prompt_file_conflicts_with_input_prompt");
				}
				input.prompt = readFileSync(promptFile, "utf8");
			}
			const sessionId = flags.session ?? (typeof input.sessionId === "string" ? input.sessionId : undefined);
			const expectedWorkspace = typeof input.workspace === "string" ? resolveInputWorkspace(input) : undefined;
			if (verb !== "start" && sessionId) {
				root = await resolveHarnessSessionRoot(root, sessionId, process.env, { expectedWorkspace });
			}
			switch (verb) {
				case "start":
					return await this.#start(root, input);
				case "preflight":
					return this.#preflight(input);
				case "observe":
					return await this.#observe(root, input, flags.session);
				case "classify":
					return await this.#classify(root, input, flags.session);
				case "submit":
					return await this.#submit(root, input, flags.session);
				case "events":
				case "monitor":
					return await this.#events(root, input, flags.session, Number(flags.cursor) || 0);
				case "retire":
					return await this.#retire(root, input, flags.session);
				case "finalize":
					return await this.#finalizeVerb(root, input, flags.session);
				case "__owner":
					return await this.#runOwner(root, input, flags.session);
				case "recover":
				case "validate":
				case "operate":
					return await this.#ownerVerbOrPending(root, verb, input, flags.session);
				default:
					throw new Error(`unknown_harness_verb:${verb}`);
			}
		} catch (error) {
			writeJson({ ok: false, error: error instanceof Error ? error.message : String(error), verb });
			process.exitCode = 1;
		}
	}

	#preflight(input: Record<string, unknown>): void {
		const preflight = buildPreflight(input);
		writeJson({
			ok: preflight.ok,
			evidence: {
				preflight,
				guidance: preflight.ok
					? "workspace metadata is normalized"
					: "fix blockers before gjc harness start; branch must match the actual checkout and issueOrPr must be numeric or a recognized PR/issue form",
			},
		});
		if (!preflight.ok) process.exitCode = 1;
	}

	async #finalizeVerb(root: string, input: Record<string, unknown>, flagSession: string | undefined): Promise<void> {
		const sessionId = requireSessionId(input, flagSession);
		if (await this.#tryOwnerRoute(root, sessionId, "finalize", { ...input, sessionId })) return;
		// finalize is owner-routed; without a live owner, report owner-not-live (start the owner first).
		const state = await loadState(root, sessionId);
		writeJson(buildResponse(state, false, { completed: false, reason: "owner-not-live" }, false));
		process.exitCode = 1;
	}

	/** Route an owner-backed verb to the live owner; fall back to a pending response when none. */
	async #ownerVerbOrPending(
		root: string,
		verb: string,
		input: Record<string, unknown>,
		flagSession: string | undefined,
	): Promise<void> {
		const sessionId = flagSession ?? (typeof input.sessionId === "string" ? input.sessionId : undefined);
		if (sessionId && (await this.#tryOwnerRoute(root, sessionId, verb, { ...input, sessionId }))) return;
		if (verb === "recover" && sessionId) return this.#recoverWithoutOwner(root, sessionId, input);
		return this.#pending(root, verb, input, flagSession);
	}

	/** Detached owner daemon (spawned by `start --detach`). Runs until retired or signalled. */
	async #runOwner(root: string, input: Record<string, unknown>, flagSession: string | undefined): Promise<void> {
		const sessionId = requireSessionId(input, flagSession);
		const state = await loadState(root, sessionId);
		const previousSpawnProvenance = process.env[SPAWN_PROVENANCE_ENV];
		process.env[SPAWN_PROVENANCE_ENV] = sessionId;
		let transport: Awaited<ReturnType<typeof createSdkSessionTransport>>;
		try {
			transport = await createSdkSessionTransport({
				repo: state.handle.workspace,
				sessionId,
				spawn: () => spawnNormalHarnessSession(state.handle.workspace, sessionId),
			});
		} finally {
			if (previousSpawnProvenance === undefined) delete process.env[SPAWN_PROVENANCE_ENV];
			else process.env[SPAWN_PROVENANCE_ENV] = previousSpawnProvenance;
		}
		const owner = new RuntimeOwner({ root, sessionId, transport });
		const info = await owner.start();
		writeJson({ ok: true, owner: info });
		await new Promise<void>(resolve => {
			const stop = (): void => {
				clearInterval(timer);
				process.removeListener("SIGTERM", stop);
				process.removeListener("SIGINT", stop);
				resolve();
			};
			const timer = setInterval(() => {
				void resolveOwner(root, sessionId).then(resolved => {
					if (!resolved.live) stop();
				});
			}, 500);
			timer.unref?.();
			process.on("SIGTERM", stop);
			process.on("SIGINT", stop);
		});
		await owner.stop();
	}

	#buildOwnerCommand(sessionId: string): string[] {
		const argv1 = process.argv[1];
		return argv1
			? [process.execPath, argv1, "harness", "__owner", "--session", sessionId]
			: [process.execPath, "harness", "__owner", "--session", sessionId];
	}

	async #waitForOwner(root: string, sessionId: string): Promise<boolean> {
		for (let i = 0; i < 160; i++) {
			const owner = await resolveOwner(root, sessionId);
			if (owner.live && owner.socketPath) {
				try {
					await callEndpoint(owner.socketPath, { verb: "observe", input: { sessionId } }, 250);
					return true;
				} catch (error) {
					if (!(error instanceof EndpointUnreachableError)) throw error;
				}
			}
			await new Promise(r => setTimeout(r, 50));
		}
		return false;
	}
	/**
	 * Reap an exact detached-owner child the parent spawned but declared not-live. The parent
	 * owns this PID's lifecycle (it spawned it), so shutdown is exact-owner scoped: SIGTERM, a
	 * bounded grace wait, then SIGKILL, then verify the SAME PID exited via its exit promise.
	 * Never name-based — the spawned Subprocess pins the exact owner identity, so a not-live
	 * declaration must not orphan a daemon the parent brought into being.
	 */
	async #reapDetachedOwner(
		child: Bun.Subprocess<"ignore", "ignore", "ignore">,
	): Promise<{ pid: number; verified: boolean }> {
		// A resolved exit promise proves the PID is gone; a rejection is NOT proof of exit (it may
		// surface an error observing the subprocess), so map it to false and let the SIGKILL
		// escalation + cleanup-uncertain surfacing handle the uncertainty.
		const exited = child.exited.then(
			() => true,
			() => false,
		);
		const send = (signal: NodeJS.Signals): void => {
			try {
				child.kill(signal);
			} catch {
				// Kill may fail if the child already exited; the exited race below is authoritative.
			}
		};
		send("SIGTERM");
		let verified = await Promise.race([exited, Bun.sleep(2000).then(() => false)]);
		if (!verified) {
			send("SIGKILL");
			verified = await Promise.race([exited, Bun.sleep(1000).then(() => false)]);
		}
		return { pid: child.pid, verified };
	}

	async #harnessOwnerIsolationProbe(tmuxCommand: string): Promise<OwnerIsolationProbe> {
		return {
			readCallerCgroup: async () =>
				process.env.GJC_HARNESS_TEST_CALLER_CGROUP ??
				(await fs.readFile("/proc/self/cgroup", "utf8").catch(() => null)),
			probeServer: async (socketKey, tmuxControlArgv): Promise<TmuxServerProof> => {
				const platform = ownerIsolationPlatform();
				if (!socketKey || socketKey.length > 128) return { state: "unverifiable" };
				const controlArgv = tmuxControlArgv ?? [tmuxCommand, "-L", socketKey];
				if (controlArgv.length < 3 || controlArgv[0] !== tmuxCommand || !controlArgv.includes("-L")) {
					return { state: "unverifiable" };
				}
				const result = Bun.spawnSync([...controlArgv, "display-message", "-p", "#{pid}"], {
					stdout: "pipe",
					stderr: "pipe",
				});
				if (result.exitCode !== 0) {
					return isBoundedNoServerDiagnostic(result.stderr) ? { state: "absent" } : { state: "unverifiable" };
				}
				const pid = Number(result.stdout.toString().trim());
				if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "unverifiable" };
				const cgroupText =
					process.env.GJC_HARNESS_TEST_SERVER_CGROUP ??
					(platform === "linux" ? await fs.readFile(`/proc/${pid}/cgroup`, "utf8").catch(() => null) : null);
				const testStartTime = process.env.GJC_HARNESS_TEST_SERVER_START_TIME;
				const stat =
					testStartTime || platform !== "linux"
						? null
						: await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
				const cgroup = classifyCgroup({ platform, cgroupText });
				const startTime =
					testStartTime ??
					(platform === "linux" ? ownerProcessStartTime(platform, stat) : portableProcessStartTime(pid));
				if (!startTime) return { state: "unverifiable", pid, cgroup };
				return {
					state:
						cgroup.classification === "safe" || cgroup.classification === "not_applicable"
							? "safe"
							: cgroup.classification === "unsafe_service"
								? "unsafe"
								: "unverifiable",
					pid,
					startTime,
					cgroup,
				};
			},
		};
	}

	async #nativeSessionBoundToName(
		tmuxCommand: string,
		socketKey: string,
		nativeSessionId: string,
		sessionName: string,
	): Promise<boolean> {
		const result = Bun.spawnSync(
			[
				tmuxCommand,
				"-L",
				socketKey,
				"display-message",
				"-p",
				"-t",
				nativeSessionId,
				"#{session_id}\t#{session_name}",
			],
			{ stdout: "pipe", stderr: "ignore" },
		);
		if (result.exitCode !== 0) return false;
		const value = result.stdout.toString();
		const line = value.endsWith("\n") ? value.slice(0, -1) : value;
		return line === `${nativeSessionId}\t${sessionName}`;
	}

	async #cleanupTmuxAttempt(
		tmuxCommand: string,
		socketKey: string,
		nativeSessionId: string | null,
		sessionName: string,
		proof: TmuxServerProof | null,
		probeServer: OwnerIsolationProbe["probeServer"],
	): Promise<void> {
		if (!nativeSessionId || !proof || !isSafeServerProof(proof)) throw new Error("tmux-owner-cleanup_uncertain");
		if (!(await this.#nativeSessionBoundToName(tmuxCommand, socketKey, nativeSessionId, sessionName)))
			throw new Error("tmux-owner-cleanup_uncertain");
		const current = await probeServer(socketKey, [tmuxCommand, "-L", socketKey]);
		if (!sameServerIdentity(proof, current)) throw new Error("tmux-owner-cleanup_uncertain");
		const predicate = `#{&&:#{==:#{pid},${proof.pid}},#{&&:#{==:#{session_id},${nativeSessionId}},#{==:#{session_name},${sessionName}}}}`;
		const killed = Bun.spawnSync(
			[
				tmuxCommand,
				"-L",
				socketKey,
				"if-shell",
				"-t",
				nativeSessionId,
				"-F",
				predicate,
				`kill-session -t '${nativeSessionId}' ; display-message -p __gjc_harness_cleanup_ok__`,
				"display-message -p __gjc_harness_cleanup_refused__",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		if (killed.exitCode !== 0 || killed.stdout.toString().trim() !== "__gjc_harness_cleanup_ok__")
			throw new Error("tmux-owner-cleanup_uncertain");
	}

	async #startTmuxResidentOwner(
		root: string,
		sessionId: string,
		cwd: string,
	): Promise<{
		started: boolean;
		sessionName: string;
		socketKey: string | null;
		reason: string | null;
		cleanup?: () => Promise<void>;
	}> {
		const tmuxCommand = resolveGjcTmuxCommand();
		const sessionName = deterministicHarnessTmuxSessionName(sessionId);
		if (Bun.which(tmuxCommand) === null)
			return { started: false, sessionName, socketKey: null, reason: "tmux-unavailable" };
		if (resolveGjcTmuxBinary({ env: process.env }).isPsmux)
			return {
				started: false,
				sessionName,
				socketKey: null,
				reason: "tmux-owner-native_session_identity_unavailable",
			};
		const socketKey = `gjc-owner-${randomBytes(24).toString("hex")}`;
		const ownerStateDir = root;
		let baseline: OwnerGenerationBaseline;
		try {
			baseline = captureOwnerGenerationBaselineSync(ownerStateDir, sessionId);
		} catch {
			return { started: false, sessionName, socketKey, reason: "tmux-owner-generation_unverifiable" };
		}
		const platform = ownerIsolationPlatform();
		if (platform !== "linux" && !portableProcessStartTime(process.pid))
			return { started: false, sessionName, socketKey, reason: "tmux-owner-generation_unverifiable" };
		await fs.mkdir(path.join(ownerStateDir, sessionId, "owner-lifecycle"), { recursive: true, mode: 0o700 });
		const ownerGeneration = randomUUID();
		const envAssignments = [
			`GJC_HARNESS_STATE_ROOT=${shellQuote(root)}`,
			`${GJC_TMUX_OWNER_GENERATION_ENV}=${shellQuote(ownerGeneration)}`,
			`${GJC_TMUX_OWNER_STATE_DIR_ENV}=${shellQuote(ownerStateDir)}`,
			`${GJC_TMUX_OWNER_SERVER_KEY_ENV}=${shellQuote(socketKey)}`,
		];
		if (process.env[RECEIPT_SPOOL_DIR_ENV])
			envAssignments.push(`${RECEIPT_SPOOL_DIR_ENV}=${shellQuote(process.env[RECEIPT_SPOOL_DIR_ENV])}`);
		if (process.env.GJC_HARNESS_TEST_NODE_MODULES)
			envAssignments.push(`GJC_HARNESS_TEST_NODE_MODULES=${shellQuote(process.env.GJC_HARNESS_TEST_NODE_MODULES)}`);
		if (process.env.GJC_SDK_DISABLE)
			envAssignments.push(`GJC_SDK_DISABLE=${shellQuote(process.env.GJC_SDK_DISABLE)}`);
		const shellCommand = `exec env ${envAssignments.join(" ")} ${this.#buildOwnerCommand(sessionId).map(shellQuote).join(" ")}`;
		const probe = await this.#harnessOwnerIsolationProbe(tmuxCommand);
		const probeServer = probe.probeServer;
		probe.probeServer = async (requestedSocketKey, controlArgv) =>
			requestedSocketKey === socketKey ? probeServer(requestedSocketKey, controlArgv) : { state: "unverifiable" };
		const tmuxArgv = [
			tmuxCommand,
			"-L",
			socketKey,
			"new-session",
			"-d",
			"-s",
			sessionName,
			"-P",
			"-F",
			"#{session_id}",
			"-c",
			cwd,
			shellCommand,
		];
		const plan = await planTmuxOwnerIsolation(
			{
				schema_version: 1,
				op: "plan",
				platform,
				session_id: sessionId,
				owner_generation: ownerGeneration,
				baseline,
				cwd,
				state_dir: ownerStateDir,
				socket_key: socketKey,
				tmux_argv: tmuxArgv,
			},
			probe,
		);
		if (!plan.ok) return { started: false, sessionName, socketKey, reason: `tmux-owner-${plan.code}` };
		if (!isOwnerGenerationBaselineCurrentSync(ownerStateDir, sessionId, baseline))
			return { started: false, sessionName, socketKey, reason: "tmux-owner-generation_stale" };
		let nativeSessionId: string | null = null;
		let cleanupProof: TmuxServerProof | null = null;
		const fail = async (
			reason: string,
		): Promise<{ started: false; sessionName: string; socketKey: string; reason: string }> => {
			try {
				await this.#cleanupTmuxAttempt(
					tmuxCommand,
					socketKey,
					nativeSessionId,
					sessionName,
					cleanupProof,
					probeServer,
				);
				return { started: false, sessionName, socketKey, reason };
			} catch {
				return { started: false, sessionName, socketKey, reason: `${reason}:tmux-owner-cleanup_uncertain` };
			}
		};
		const created = Bun.spawnSync(plan.execution.argv, {
			stdout: "pipe",
			stderr: "pipe",
			env: process.env,
			...(plan.execution.mode === "scoped"
				? { stdin: new TextEncoder().encode(`${plan.execution.stdin_line}\n`) }
				: {}),
		});
		const scopedReceipt = plan.execution.mode === "scoped" ? scopedBootstrapReceipt(created.stdout) : null;
		nativeSessionId =
			scopedReceipt?.nativeSessionId ??
			(plan.execution.mode === "direct" ? exactNativeTmuxSessionId(created.stdout) : null);
		if (created.exitCode !== 0)
			return fail(
				plan.execution.mode === "scoped"
					? "tmux-owner-scope_bootstrap_failed"
					: "tmux-owner-direct_creation_failed",
			);
		if (!nativeSessionId)
			return fail(
				plan.execution.mode === "scoped"
					? "tmux-owner-scope_bootstrap_failed"
					: "tmux-owner-native_session_identity_unavailable",
			);
		const postSpawnServer = await probeServer(socketKey, [tmuxCommand, "-L", socketKey]);
		cleanupProof = postSpawnServer;
		if (postSpawnServer.state === "unsafe") return fail("tmux-owner-server_unsafe");
		if (!isSafeServerProof(postSpawnServer)) return fail("tmux-owner-server_unverifiable");
		if (
			scopedReceipt &&
			(scopedReceipt.sessionName !== sessionName ||
				scopedReceipt.serverPid !== postSpawnServer.pid ||
				scopedReceipt.serverStartTime !== postSpawnServer.startTime)
		)
			return fail("tmux-owner-receipt_server_mismatch");
		if (!(await this.#nativeSessionBoundToName(tmuxCommand, socketKey, nativeSessionId, sessionName)))
			return fail("tmux-owner-native_session_identity_unproven");
		const boundServer = await probeServer(socketKey, [tmuxCommand, "-L", socketKey]);
		if (!sameServerIdentity(postSpawnServer, boundServer)) return fail("tmux-owner-server_race");
		cleanupProof = boundServer;
		if (
			plan.execution.mode === "direct" &&
			!plan.execution.server_absent_before &&
			(boundServer.pid !== plan.execution.server_pid || boundServer.startTime !== plan.execution.server_start_time)
		) {
			cleanupProof = null;
			return fail("tmux-owner-server_race");
		}
		if (!isOwnerGenerationBaselineCurrentSync(ownerStateDir, sessionId, baseline))
			return fail("tmux-owner-generation_stale");
		try {
			replaceOwnerGenerationSync(ownerStateDir, sessionId, ownerGeneration, baseline);
		} catch {
			return fail("tmux-owner-generation_stale");
		}
		return {
			started: true,
			sessionName,
			socketKey,
			reason: null,
			cleanup: async () => {
				await this.#cleanupTmuxAttempt(
					tmuxCommand,
					socketKey,
					nativeSessionId,
					sessionName,
					cleanupProof,
					probeServer,
				);
				await observeOwnerTerminal({
					schema_version: 1,
					op: "observe_terminal",
					session_id: sessionId,
					owner_generation: ownerGeneration,
					state_dir: ownerStateDir,
					socket_key: socketKey,
					observer: "sidecar",
					observed_at: new Date().toISOString(),
					signal: "UNKNOWN",
					exit_code: null,
					exit_kind: "owner_lost",
					reason: "endpoint_unroutable",
				});
			},
		};
	}

	/** Spawn the owner daemon. Tmux isolation failures and unroutable starts block; unavailable tmux may fall back. */
	async #spawnDetachedOwner(root: string, sessionId: string, cwd: string): Promise<OwnerSpawnResult> {
		const tmux = await this.#startTmuxResidentOwner(root, sessionId, cwd);
		if (!tmux.started && tmux.reason?.startsWith("tmux-owner-")) {
			return {
				live: false,
				runtime: "manual",
				tmuxSessionName: null,
				socketKey: tmux.socketKey,
				fallbackReason: tmux.reason,
				blockerReason: "tmux-owner-isolation-failed",
			};
		}
		if (tmux.started && (await this.#waitForOwner(root, sessionId))) {
			return {
				live: true,
				runtime: "tmux",
				tmuxSessionName: tmux.sessionName,
				socketKey: tmux.socketKey,
				fallbackReason: null,
				blockerReason: null,
			};
		}
		if (tmux.started) {
			try {
				if (!tmux.cleanup) throw new Error("tmux-owner-cleanup_uncertain");
				await tmux.cleanup();
			} catch {
				return {
					live: false,
					runtime: "manual",
					tmuxSessionName: tmux.sessionName,
					socketKey: tmux.socketKey,
					fallbackReason:
						"tmux new-session owner endpoint not routable; exact cleanup or reconciliation uncertain",
					blockerReason: "tmux-owner-endpoint-cleanup-uncertain",
				};
			}
			return {
				live: false,
				runtime: "manual",
				tmuxSessionName: null,
				socketKey: tmux.socketKey,
				fallbackReason: "tmux new-session exited 0 but owner endpoint did not become routable; owner cleaned",
				blockerReason: "tmux-owner-endpoint-not-routable",
			};
		}
		const fallbackReason = tmux.reason;
		const cmd = this.#buildOwnerCommand(sessionId);
		const child = Bun.spawn(cmd, {
			cwd,
			env: {
				...process.env,
				GJC_HARNESS_STATE_ROOT: root,
				...(process.env[RECEIPT_SPOOL_DIR_ENV]
					? { [RECEIPT_SPOOL_DIR_ENV]: process.env[RECEIPT_SPOOL_DIR_ENV] }
					: {}),
				...(process.env.GJC_HARNESS_TEST_NODE_MODULES
					? { GJC_HARNESS_TEST_NODE_MODULES: process.env.GJC_HARNESS_TEST_NODE_MODULES }
					: {}),
				...(process.env.GJC_SDK_DISABLE ? { GJC_SDK_DISABLE: process.env.GJC_SDK_DISABLE } : {}),
			},
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
		child.unref();
		const live = await this.#waitForOwner(root, sessionId);
		const detachedOwnerReaped = live ? null : await this.#reapDetachedOwner(child);
		return {
			live,
			runtime: "detached",
			tmuxSessionName: null,
			socketKey: null,
			fallbackReason,
			blockerReason: live ? null : "detached-owner-not-live",
			...(detachedOwnerReaped ? { detachedOwnerReaped } : {}),
		};
	}

	async #start(root: string, input: Record<string, unknown>): Promise<void> {
		const harness = (typeof input.harness === "string" ? input.harness : "gajae-code") as HarnessKind;
		if (harness !== "gajae-code") {
			writeJson({
				ok: false,
				error: `harness_unsupported_in_v1:${harness}`,
				evidence: { seam: true, supported: ["gajae-code"] },
			});
			process.exitCode = 1;
			return;
		}
		const preflight = buildPreflight(input);
		const fatalBlockers = startFatalPreflightBlockers(input, preflight);
		if (fatalBlockers.length > 0) {
			writeJson({
				ok: false,
				error: "harness_preflight_failed",
				evidence: {
					preflight: { ...preflight, blockers: fatalBlockers, ok: false },
					guidance:
						"fix blockers before start; run gjc harness preflight with the same input for branch and issue/PR diagnostics",
				},
			});
			process.exitCode = 1;
			return;
		}
		const workspace = resolveInputWorkspace(input);
		const sessionId = typeof input.sessionId === "string" ? input.sessionId : generateSessionId();
		const eventsPath = `${root}/sessions/${sessionId}/events.jsonl`;
		const leasePath = `${root}/sessions/${sessionId}/lease.json`;
		const startedAt = nowIso();
		const handle: SessionHandle = {
			sessionId,
			harness,
			mode: input.mode === "review" || input.reviewOnly === true ? "review" : "implement",
			repo: typeof input.repo === "string" ? input.repo : null,
			workspace,
			branch: preflight.declaredBranch ?? preflight.actualBranch,
			base: typeof input.base === "string" ? input.base : null,
			issueOrPr: preflight.normalizedIssueOrPr,
			processHandle: { kind: "runtime-owner", ownerId: null, pid: null },
			sdkHandle: { kind: "sdk-session-endpoint", sessionId },
			ownerHandle: { leasePath, endpoint: null, heartbeatAt: null },
			routerHandle: { kind: "default-in-owner", policy: "default-fallback", eventsPath },
			viewportHandle: { kind: "event-monitor", tmuxSessionName: null, viewOnly: true },
			startedAt,
			updatedAt: startedAt,
		};
		const state: SessionState = {
			schemaVersion: SESSION_SCHEMA_VERSION,
			sessionId,
			lifecycle: "started",
			harness,
			handle,
			retries: {},
			blockers: [],
			createdAt: startedAt,
			updatedAt: startedAt,
		};
		await writeSessionState(root, state);
		await rememberHarnessSessionRoot(root, sessionId);
		let ownerLive = false;
		let ownerRuntime: OwnerSpawnResult["runtime"] = "manual";
		let ownerFallbackReason: string | null = null;
		let ownerBlockerReason: string | null = null;
		let ownerSocketKey: string | null = null;
		let ownerDetachedReaped: { pid: number; verified: boolean } | null = null;
		if (input.detach === true) {
			const ownerSpawn = await this.#spawnDetachedOwner(root, sessionId, workspace);
			ownerLive = ownerSpawn.live;
			ownerRuntime = ownerSpawn.runtime;
			ownerFallbackReason = ownerSpawn.fallbackReason;
			ownerBlockerReason = ownerSpawn.blockerReason;
			ownerSocketKey = ownerSpawn.socketKey;
			ownerDetachedReaped = ownerSpawn.detachedOwnerReaped ?? null;
			handle.viewportHandle = {
				kind: "event-monitor",
				tmuxSessionName: ownerSpawn.tmuxSessionName,
				viewOnly: true,
			};
			if (ownerLive) {
				const resolved = await resolveOwner(root, sessionId);
				handle.processHandle = {
					kind: "runtime-owner",
					ownerId: resolved.lease?.ownerId ?? null,
					pid: resolved.lease?.pid ?? null,
				};
				handle.ownerHandle = {
					leasePath,
					endpoint: resolved.socketPath,
					heartbeatAt: resolved.lease?.heartbeatAt ?? null,
				};
				state.handle = handle;
				await writeSessionState(root, state);
			}
		}
		// A live endpoint never proves a failed tmux launch safe: preserve the isolation/provenance blocker.
		if (ownerBlockerReason) {
			state.lifecycle = "blocked";
			// `detached-owner-not-live` is the lifecycle status; an unverified reap (the exact
			// spawned child never confirmed exit after SIGKILL) is a stronger, distinct signal that
			// must not be masked by the not-live blocker alone.
			const ownerBlockers = [ownerBlockerReason];
			if (ownerDetachedReaped && !ownerDetachedReaped.verified)
				ownerBlockers.push("detached-owner-cleanup-uncertain");
			state.blockers = [...state.blockers, ...ownerBlockers];
			state.handle = handle;
			state.updatedAt = nowIso();
			await writeSessionState(root, state);
		}
		writeJson(
			buildResponse(
				state,
				ownerLive,
				{
					handle,
					ownerRuntime,
					preflight,
					...(ownerSocketKey ? { tmuxOwnerSocketKey: ownerSocketKey } : {}),
					...(ownerFallbackReason ? { ownerFallbackReason } : {}),
					...(ownerBlockerReason ? { reason: ownerBlockerReason } : {}),
					...(ownerDetachedReaped ? { detachedOwnerReaped: ownerDetachedReaped } : {}),
				},
				!ownerBlockerReason,
			),
		);
		if (ownerBlockerReason) process.exitCode = 1;
	}

	/** Returns true if a live owner handled the verb (response already printed). */
	async #tryOwnerRoute(
		root: string,
		sessionId: string,
		verb: string,
		input: Record<string, unknown>,
	): Promise<boolean> {
		const owner = await resolveOwner(root, sessionId);
		if (!owner.live || !owner.socketPath) return false;
		const priorSpoolDir = input[RECEIPT_SPOOL_DIR_ENV];
		try {
			if (process.env[RECEIPT_SPOOL_DIR_ENV]) input[RECEIPT_SPOOL_DIR_ENV] = process.env[RECEIPT_SPOOL_DIR_ENV];
			const res = (await callEndpoint(owner.socketPath, { verb, input })) as { ok?: boolean };
			writeJson(res);
			if (res?.ok === false) process.exitCode = 1;
			return true;
		} catch (error) {
			if (error instanceof EndpointUnreachableError) return false;
			throw error;
		} finally {
			if (priorSpoolDir === undefined) delete input[RECEIPT_SPOOL_DIR_ENV];
			else input[RECEIPT_SPOOL_DIR_ENV] = priorSpoolDir;
		}
	}

	async #observe(root: string, input: Record<string, unknown>, flagSession: string | undefined): Promise<void> {
		const sessionId = requireSessionId(input, flagSession);
		if (await this.#tryOwnerRoute(root, sessionId, "observe", { ...input, sessionId })) return;
		let state = await loadState(root, sessionId);
		const ownerLive = ownerLiveFor(state);
		const { observation, completedTerminalEvent } = await buildObservation(root, state, ownerLive);
		state = await reconcileCompletedOwnerExited(root, state, observation, completedTerminalEvent);
		const vanishedOwnerBlock = needsVanishedOwnerBlock(state, observation, completedTerminalEvent);
		state = await markVanishedOwnerBlocked(root, state, observation, completedTerminalEvent);
		// Build owner-exit evidence whenever the owner is gone so a startup death (owner started,
		// reported live, then died before the first prompt) is detectable, not just vanish/completion.
		const ownerExit = !ownerLive ? await buildOwnerExitEvidence(root, state) : null;
		const startupBlocked = ownerExit?.startupBlocker ?? false;
		if (ownerExit && startupBlocked) state = await markStartupOwnerBlocked(root, state, ownerExit);
		const includeOwnerExit = Boolean(ownerExit && (vanishedOwnerBlock || completedTerminalEvent || startupBlocked));
		writeJson(
			buildResponse(state, ownerLive, {
				observation: { ...observation, lifecycle: state.lifecycle },
				readOnly: !ownerLive,
				...(vanishedOwnerBlock
					? { ownerVanished: true, blockerReason: `owner-vanished:${observation.gitDelta}` }
					: {}),
				...(completedTerminalEvent && !ownerLive
					? { completedOwnerExited: true, terminalResult: completedTerminalEvent }
					: {}),
				...(startupBlocked
					? { startupBlocked: true, blockerReason: OWNER_STARTUP_BLOCKER, guidance: ownerExit?.recoveryGuidance }
					: {}),
				...(includeOwnerExit && ownerExit ? { ownerExit } : {}),
			}),
		);
	}

	async #classify(root: string, input: Record<string, unknown>, flagSession: string | undefined): Promise<void> {
		const budget = resolveRetryBudget(input);
		let observation = input.observation as Partial<Observation> | undefined;
		let stateView: SessionState | null = null;
		const sessionId = flagSession ?? (typeof input.sessionId === "string" ? input.sessionId : undefined);
		// Session-backed classify derives owner liveness from the same lease/socket probe observe
		// uses for routing, so a live (e.g. manual) owner is never misread as vanished/restart-clean.
		let ownerLive = false;
		if (sessionId) {
			stateView = await loadState(root, sessionId);
			ownerLive = await resolveOwnerLive(root, sessionId);
			if (!observation) {
				const built = await buildObservation(root, stateView, ownerLive);
				observation = built.observation;
				stateView = await markVanishedOwnerBlocked(
					root,
					stateView,
					built.observation,
					built.completedTerminalEvent,
				);
			}
		}
		if (!observation) throw new Error("classify_requires_observation_or_session");
		const full: Observation = {
			lifecycle: observation.lifecycle ?? "observing",
			ownerLive: observation.ownerLive ?? false,
			cwd: observation.cwd ?? ".",
			branch: observation.branch ?? null,
			gitDelta: observation.gitDelta ?? "unknown",
			lastActivityAt: observation.lastActivityAt ?? null,
			observedSignals: observation.observedSignals ?? [],
			risk: observation.risk ?? "normal",
		};
		const decision = classifyRecovery({ observation: full, retryBudget: budget });
		if (stateView) {
			writeJson(
				buildResponse(stateView, ownerLive, {
					decision,
					observation: { ...full, lifecycle: stateView.lifecycle },
				}),
			);
			return;
		}
		// Pure classify without a session: synthesize a minimal state view.
		writeJson({
			ok: true,
			state: {
				sessionId: "(none)",
				lifecycle: full.lifecycle,
				harness: "gajae-code",
				ownerLive: full.ownerLive,
				blockers: [],
			},
			evidence: { decision, observation: full },
			nextAllowedActions: [],
		});
	}

	async #submit(root: string, input: Record<string, unknown>, flagSession: string | undefined): Promise<void> {
		const sessionId = requireSessionId(input, flagSession);
		let state = await loadState(root, sessionId);
		const noOwnerGate = submitUnavailableReason(state.lifecycle, false);
		if (!noOwnerGate || noOwnerGate === "owner-not-live") {
			if (await this.#tryOwnerRoute(root, sessionId, "submit", { ...input, sessionId })) return;
			state = await loadState(root, sessionId);
		}
		const blockedByOwnerLiveness = state.blockers.some(
			blocker => isOwnerLivenessBlocker(blocker) || blocker === OWNER_STARTUP_BLOCKER,
		);
		const lifecycleGate = submitUnavailableReason(state.lifecycle, false);
		if (lifecycleGate && lifecycleGate !== "owner-not-live" && !blockedByOwnerLiveness) {
			writeJson(buildResponse(state, false, { accepted: false, submitted: false, reason: lifecycleGate }, false));
			process.exitCode = 1;
			return;
		}
		// No live owner: submission is blocked (never echoed-as-accepted). Surface owner exit
		// evidence + explicit recovery guidance so the caller is not left with a bare gate.
		const ownerExit = await buildOwnerExitEvidence(root, state);
		// An owner that started, reported live, then died before accepting the first prompt is a
		// startup blocker, not a healthy `owner-not-live` gate — persist it and report it as such.
		if (ownerExit.startupBlocker) state = await markStartupOwnerBlocked(root, state, ownerExit);
		const reason = ownerExit.startupBlocker ? ownerExit.reason : "owner-not-live";
		writeJson(
			buildResponse(
				state,
				false,
				{ accepted: false, submitted: false, reason, ownerExit, guidance: ownerExit.recoveryGuidance },
				false,
			),
		);
		process.exitCode = 1;
	}

	async #events(
		root: string,
		input: Record<string, unknown>,
		flagSession: string | undefined,
		cursor: number,
	): Promise<void> {
		const sessionId = requireSessionId(input, flagSession);
		const state = await loadState(root, sessionId);
		const events = await readEvents(root, sessionId, cursor);
		const nextCursor = events.length > 0 ? events[events.length - 1].cursor : cursor;
		writeJson(
			buildResponse(state, ownerLiveFor(state), {
				events,
				cursor: nextCursor,
				note: "tail-only; events are preserved after owner exit",
				ownerLive: ownerLiveFor(state),
				ownerExit: ownerLiveFor(state) ? null : await buildOwnerExitEvidence(root, state),
			}),
		);
	}

	async #retire(root: string, input: Record<string, unknown>, flagSession: string | undefined): Promise<void> {
		const sessionId = requireSessionId(input, flagSession);
		if (await this.#tryOwnerRoute(root, sessionId, "retire", { ...input, sessionId })) return;
		const state = await loadState(root, sessionId);
		const { observation } = await buildObservation(root, state, ownerLiveFor(state));
		if (observation.gitDelta === "dirty" || observation.gitDelta === "unknown") {
			writeJson(
				buildResponse(
					state,
					false,
					{
						retired: false,
						reason: `retire-blocked:${observation.gitDelta}-delta`,
						gitDelta: observation.gitDelta,
					},
					false,
				),
			);
			process.exitCode = 1;
			return;
		}
		state.lifecycle = "retired";
		state.updatedAt = nowIso();
		await writeSessionState(root, state);
		writeJson(buildResponse(state, false, { retired: true }));
	}

	async #recoverWithoutOwner(root: string, sessionId: string, input: Record<string, unknown>): Promise<void> {
		const budget = resolveRetryBudget(input);
		let state = await loadState(root, sessionId);
		const beforeExit = await buildOwnerExitEvidence(root, state);
		const { observation, completedTerminalEvent } = await buildObservation(root, state, false);
		state = await markVanishedOwnerBlocked(root, state, observation, completedTerminalEvent);
		const decision = classifyRecovery({
			observation: { ...observation, lifecycle: state.lifecycle },
			retryBudget: budget,
		});
		// A session persisted as `started` whose owner was never spawned (no lease,
		// no endpoint, no owner-run evidence) is not a vanish — it simply never had
		// an owner. Bootstrap a fresh owner instead of deadlocking on the missing
		// prior endpoint (which `start` without `--detach` never records).
		const ownerNeverStarted =
			state.lifecycle === "started" &&
			!beforeExit.endpointPresent &&
			!beforeExit.promptAcceptedSeen &&
			!beforeExit.completedSeen &&
			beforeExit.lastEventKind === null &&
			observation.risk !== "deleted-worktree";
		// Bootstrapping a never-started owner is not a vanish, so it needs no vanish receipt.
		const vanishReceiptId = ownerNeverStarted
			? null
			: await writeVanishReceiptForDecision(root, state, observation, decision.classification);
		// A never-started owner has no in-flight work to preserve, so bootstrapping it does not
		// depend on the vanish classifier's `ownerRequired` verdict — that gate exists to protect a
		// vanished owner's worktree. Without this, a session started in a non-git workspace (git
		// delta `unknown` → classifier `human-check` with `ownerRequired: false`) would stay stuck.
		const restoredOwner =
			ownerNeverStarted || (decision.ownerRequired && beforeExit.endpointPresent)
				? await this.#spawnDetachedOwner(root, sessionId, state.handle.workspace)
				: null;
		if (restoredOwner?.live) {
			const resolved = await resolveOwner(root, sessionId);
			if (resolved.live && resolved.socketPath) {
				updateStateWithRestoredOwner(state, state.handle.ownerHandle.leasePath, resolved);
				if (restoredOwner.tmuxSessionName)
					state.handle.viewportHandle.tmuxSessionName = restoredOwner.tmuxSessionName;
				await writeSessionState(root, state);
				writeJson(
					buildResponse(state, true, {
						pending: false,
						...(ownerNeverStarted ? { bootstrappedOwner: true } : { restoredOwner: true }),
						decision,
						observation: { ...observation, lifecycle: state.lifecycle, ownerLive: true },
						ownerExit: beforeExit,
						ownerRuntime: restoredOwner.runtime,
						...(restoredOwner.fallbackReason ? { ownerFallbackReason: restoredOwner.fallbackReason } : {}),
						...(vanishReceiptId ? { vanishReceiptId } : {}),
					}),
				);
				return;
			}
		}
		const afterExit = await buildOwnerExitEvidence(root, state);
		writeJson(
			buildResponse(
				state,
				false,
				{
					pending: false,
					reason: afterExit.reason,
					decision,
					observation: { ...observation, lifecycle: state.lifecycle },
					ownerExit: afterExit,
					guidance: afterExit.recoveryGuidance,
					...(restoredOwner
						? {
								restoreAttempt: {
									runtime: restoredOwner.runtime,
									live: restoredOwner.live,
									fallbackReason: restoredOwner.fallbackReason,
									blockerReason: restoredOwner.blockerReason,
								},
							}
						: {}),
					...(vanishReceiptId ? { vanishReceiptId } : {}),
				},
				false,
			),
		);
		process.exitCode = 1;
	}

	async #pending(
		root: string,
		verb: string,
		input: Record<string, unknown>,
		flagSession: string | undefined,
	): Promise<void> {
		const sessionId = flagSession ?? (typeof input.sessionId === "string" ? input.sessionId : undefined);
		const milestone = verb === "recover" ? "M7" : verb === "validate" || verb === "finalize" ? "M8" : "M9";
		if (sessionId) {
			const state = await loadState(root, sessionId);
			writeJson(buildResponse(state, ownerLiveFor(state), { pending: true, milestone, verb }, false));
			process.exitCode = 1;
			return;
		}
		writeJson({
			ok: false,
			state: buildStateView(
				{
					schemaVersion: SESSION_SCHEMA_VERSION,
					sessionId: "(none)",
					lifecycle: "new",
					harness: "gajae-code",
					handle: {} as SessionHandle,
					retries: {},
					blockers: [],
					createdAt: nowIso(),
					updatedAt: nowIso(),
				},
				false,
			),
			evidence: { pending: true, milestone, verb },
			nextAllowedActions: [],
		});
		process.exitCode = 1;
	}
}

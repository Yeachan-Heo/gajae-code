import { execSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
	type ChatMessagePayload,
	isSilentOutput,
	type OriginRef,
	originKey,
	type PromptStatusBody,
	ProtocolError,
	parseOriginKey,
	validateOriginRef,
	type WorkDirective,
	type WorkDirectiveResult,
	type WorkStartResult,
	type WorkStatusResult,
	type WorkSteerResult,
} from "@gajae-gateway/protocol";
import {
	type AwaitingChecks,
	acknowledgeHold,
	appendAttempt,
	applyReconciliation,
	type ChecksSettlement,
	clearAwaitingChecks,
	closeAttempt,
	createLaneJobRecord,
	envelopeErrorCode,
	GjcCliError,
	hasNewCommit,
	type LaneJobRecord,
	newOpRef,
	OpRefRejectedError,
	parseLaneJobRecord,
	recordChecksRetry,
	settleAwaitingChecks,
	transitionToAwaitingChecks,
} from "@gajae-gateway/subsession";
import type { GjcModelSelection } from "../config";
import { buildDeliveryPayload } from "../delivery/delivery";
import { BrokerAuthorityError, type Store } from "../store";
import {
	type LaneReportRow,
	resolveLaneReportOrigin,
	terminalEvidence,
	unresolvedTerminalReceipt,
	WORK_OUTCOME_TOKENS,
	type WorkAttemptAdmission,
	type WorkAttemptPatch,
	type WorkAttemptRuntime,
	type WorkAttemptSettlement,
	type WorkAttemptSettleResult,
	type WorkAttemptTerminalEvidence,
	type WorkParent,
	type WorkReportRoot,
	workAssert,
	workAttemptDeliveryId,
	workAttemptEndState,
	workAttemptReportId,
} from "../store/groups/work";
import type { WriteTx } from "../store/tx";
import { type BrokerWaitOptions, isBrokerUnavailable, waitForBroker } from "./broker";
import { readFailedTransportCause } from "./failed-turn-evidence";
import { GIT_COMMAND_TIMEOUT_MS, runGit } from "./git-command";
import {
	type LaneForceRetireReason,
	type LaneGovernor,
	laneJobIdentity,
	managedLaneBranchName,
	managedLaneRepositoryPath,
	managedLaneWorktreePath,
	workSessionKey,
} from "./lane-governor";
import { sanitizeDiagnostic } from "./rebind";
import { isSessionUnavailable, type SessionLiveness, type SessionPort } from "./session-port";
import { isRelayTransportFailure, type TailHandle } from "./tail-runner";

const owners = new WeakSet<Store>();
/** Consecutive failed reconciliations between authority re-checks through recovery. */
const FAILURES_PER_READOPTION = 8;
/** Ceiling for the failure backoff between reconciliation polls. */
const MAX_FAILURE_BACKOFF_MS = 30_000;
/** Per-command git deadlines; a timed-out command is killed with its whole process group (#615). */
interface GitTimeouts {
	/** Local repository commands, including clone/fetch from a local path and worktree add/remove. */
	readonly local: number;
	/** Clone of a network remote. */
	readonly clone: number;
	/** `git ls-remote` push-state probe. */
	readonly probe: number;
}
const GIT_TIMEOUTS: GitTimeouts = { local: GIT_COMMAND_TIMEOUT_MS, clone: 30_000, probe: 5_000 };
const reasons = new Set([
	"end_turn",
	"prompt_deadline_exceeded",
	"provider_transport",
	"cancelled",
	"max_tokens",
	"max_turn_requests",
	"refusal",
	"stopped_incomplete",
	"sdk_failed",
	"send_rejected",
	"terminal_missing_receipt",
	"terminal_uncertain",
	"session_dead",
	"session_disowned",
	"host_lost",
	"recovery_indeterminate",
	"output_unavailable",
]);
/** Minimum spacing between streamed-frame activity writes for one attempt. */
const ACTIVITY_TOUCH_MS = 1_000;
const HOST_LOST_GRACE_MS = 30_000;
/** Conversation platforms a lane report can be admitted into as an internal turn. */
const PERSONA_PARENT_PLATFORMS: readonly string[] = ["discord", "slack", "telegram", "loopback"];
/** Re-steers on red PR checks before the lane settles failed (#481). */
const AWAITING_CHECKS_RETRY_LIMIT = 2;
/** How long a lane may wait in awaiting_checks before it settles with a timeout. */
const AWAITING_CHECKS_TIMEOUT_MS = 3_600_000;
/** Bound concurrent GitHub/remote probes so one slow lane does not serialize recovery. */
const AWAITING_CHECKS_POLL_CONCURRENCY = 16;

const refusalCodes = new Set([
	"busy",
	"steer_refused",
	"invalid_params",
	"not_running",
	"no_active_turn",
	"client_ref_conflict",
	"session_not_found",
]);
const pendingOutput = () => ({
	disposition: "pending" as const,
	reads: 0,
	nextReadAt: null,
	excerpt: null,
	proof: null,
	knownSilence: null,
});
function hasAcceptanceEvidence(runtime: WorkAttemptRuntime): boolean {
	return runtime.sendPhase === "accepted" || runtime.output.proof !== null || runtime.output.knownSilence !== null;
}
interface Observer {
	readonly runtime: WorkAttemptRuntime;
	readonly generation: number;
	readonly abort: AbortController;
	readonly binding: { readonly sessionId: string | null; readonly epoch: number } | undefined;
	tail?: TailHandle;
	attaching?: Promise<void>;
	disposal?: Promise<void>;
	task?: Promise<void>;
	timer?: ReturnType<typeof setTimeout>;
	wakeRequested?: boolean;
	touchedAt?: number;
	turnEndObservedAt?: string;
	/** First of an unbroken run of host-gone verdicts; any other observation resets it. */
	goneSince?: number;
	/** First positive live=false inspect while terminal/missing status remains readable. */
	receiptDeadSince?: number;
	/** Monotonic even when multiple execution frames share the same clock tick. */
	activityVersion?: number;
}
interface Waiter {
	readonly owner: object;
	readonly finish: (error?: Error) => void;
}
interface RunCall {
	readonly owner: object;
	active: boolean;
	opRef?: string;
	text?: string;
}
export interface CheckStatusSnapshot {
	readonly prNumber: number;
	/** The PR head for which this rollup was computed. */
	readonly headSha: string;
	readonly status: "pending" | "green" | "red";
	readonly failingChecks: readonly string[];
	/** Lifecycle of the PR returned by discovery; merged PRs are terminal success. */
	readonly prState?: "open" | "closed";
	readonly merged?: boolean;
	/** Bounded, sanitized tail from failed GitHub Actions checks when available. */
	readonly failureLogTail?: string;
}

export interface CheckStatusClient {
	/**
	 * Snapshot the PR for `headSha`, preferring `prNumber` when supplied and
	 * `branchName` when several exact-head PRs are available. Returns null only
	 * when an unqualified lookup proves no match exists; returns undefined when
	 * lookup failed, timed out, or results are incomplete.
	 * Must not throw.
	 */
	getCheckStatus(
		headSha: string,
		cwd: string,
		prNumber?: number,
		branchName?: string,
	): Promise<CheckStatusSnapshot | null | undefined>;
}

export interface WorkLaneManagerOptions {
	readonly database: Store;
	readonly port: SessionPort;
	readonly lanes: LaneGovernor;
	readonly gajaewayHome: string;
	/** Service directory (checkout root) where the gateway runs from. Lanes must not run inside this directory. */
	readonly serviceDirectory: string;
	/** Lane root directory where worktrees are created for repo bindings. If not provided, defaults to gajaewayHome. */
	readonly laneRoot?: string;
	readonly ownerTarget?: () => OriginRef | undefined;
	readonly allowNested?: () => boolean;
	readonly personaHold?: (originKey: string) => string | undefined;
	readonly notifyPersona?: (originKey: string) => void;
	readonly deliverFallback?: (payload: ChatMessagePayload) => void;
	readonly brokerGeneration?: () => number;
	readonly pollMs?: number;
	readonly waitTimeoutMs?: number;
	/** How long consecutive host-gone verdicts must persist before a live observer settles `host_lost`. */
	readonly hostLostGraceMs?: number;
	readonly now?: () => number;
	readonly checkStatusClient?: CheckStatusClient;
	/** Bounded wait for a restarting broker before a lane bind fails; defaults to {@link WORK_BIND_BROKER_WAIT}. */
	readonly brokerWait?: BrokerWaitOptions;
	/** Test seam: one deadline for every lane git command instead of {@link GIT_TIMEOUTS}. */
	readonly gitCommandTimeoutMs?: number;
}
/**
 * A lane bind issued while the supervisor restarts the broker waits for it to
 * answer again instead of failing `work lane bind failed`. Two minutes covers a
 * supervised restart with backoff; a broker still down after that is an outage.
 */
export const WORK_BIND_BROKER_WAIT = { initialMs: 500, maxMs: 5_000, deadlineMs: 2 * 60_000 } as const;
interface WorkInput {
	name: string;
	text: string;
	cwd?: string;
	repo?: string;
	base?: string;
	resume: boolean;
	model?: GjcModelSelection;
	callerSessionId?: string;
}
interface StartContext {
	readonly parent: WorkParent | null;
	readonly runCall?: RunCall;
	readonly opRef?: string;
	readonly wakeReportId?: string;
	/** Only the check-polling path may add an attempt while the lane is parked. */
	readonly checksRetry?: boolean;
}

/**
 * Get the service directory where the gateway is running from.
 * This is the git root of the directory containing the running binary.
 */
export function getServiceDirectory(): string {
	// A source checkout runs this module from disk; a compiled binary embeds it under a
	// virtual root, so fall back to the binary's own directory there. `process.execPath`
	// alone is the bun runtime in a source checkout, never the service checkout.
	// `existsSync` reports the virtual root as present, but it has no real path (issue #579).
	const moduleDir = import.meta.dir;
	const anchor = isEmbeddedModuleDir(moduleDir) ? dirname(process.execPath) : moduleDir;
	try {
		return execSync("git rev-parse --show-toplevel", { cwd: anchor, encoding: "utf-8" }).trim();
	} catch {
		return anchor;
	}
}

/** True for the virtual directory a `bun build --compile` binary embeds its modules under. */
export function isEmbeddedModuleDir(dir: string): boolean {
	return dir === "/$bunfs/root" || dir.startsWith("/$bunfs/") || /^[A-Z]:[\\/]~BUN[\\/]/i.test(dir);
}

/** Nearest existing ancestor's realpath with the missing tail re-appended. */
function realpathOfPossiblyMissing(path: string): string {
	const absolute = resolve(path);
	let existing = absolute;
	while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
	return join(realpathSync(existing), absolute.slice(existing.length));
}

/** Refuses a lane path equal to or nested in the service checkout (issue #480). */
export function assertOutsideServiceDirectory(serviceDirectory: string, path: string, name: string): void {
	const serviceDir = realpathOfPossiblyMissing(serviceDirectory);
	const candidate = realpathOfPossiblyMissing(path);
	if (candidate === serviceDir || candidate.startsWith(`${serviceDir}/`))
		throw new ProtocolError("invalid_params", "lane cwd cannot be inside service directory", {
			reasonCode: "cwd_inside_service_dir",
			name,
		});
}

/** Attempt ownership is independent of sockets, response deadlines and broker generations. */
export class WorkLaneManager {
	readonly #options: WorkLaneManagerOptions;
	readonly #db: Store;
	readonly #port: SessionPort;
	readonly #observers = new Map<string, Observer>();
	/** Includes dropped observers no longer reachable through #observers. */
	readonly #observerDisposals = new Set<Promise<void>>();
	/** Consecutive reconciliation failures per open attempt; cleared by a successful tick or settlement. */
	readonly #failures = new Map<string, { failures: number; reason: string }>();
	readonly #waiters = new Map<string, Set<Waiter>>();
	/** Exact output belongs to an interested invocation, not its observer or later waiter. */
	readonly #runCalls = new Map<string, RunCall>();
	/**
	 * Fresh-lane starts between request acceptance and their durable lane record,
	 * plus the last failed one per name, so `work.status` never reports an
	 * accepted start as an unknown lane (#707).
	 */
	readonly #admissions = new Map<string, { startedAt: string; failedAt?: string; reason?: string }>();
	readonly #detachedOwners = new WeakSet<object>();
	#generationRecovery?: Promise<void>;
	#recovery?: Promise<void>;
	#stopped = false;
	#stopPromise?: Promise<void>;
	constructor(options: WorkLaneManagerOptions) {
		if (owners.has(options.database)) throw new Error("work manager already registered");
		owners.add(options.database);
		this.#options = options;
		this.#db = options.database;
		this.#port = options.port;
		options.lanes.setRecoveryGate(() => this.recover());
		options.lanes.setForceRetireSettlement((name, opRef, reason, endedAt) =>
			this.settleForceRetiredAttempt(name, opRef, reason, endedAt),
		);
	}
	#now(): number {
		return this.#options.now?.() ?? Date.now();
	}
	#at(): string {
		return new Date(this.#now()).toISOString();
	}
	#gitTimeouts(): GitTimeouts {
		const override = this.#options.gitCommandTimeoutMs;
		return override === undefined ? GIT_TIMEOUTS : { local: override, clone: override, probe: override };
	}
	#live(): void {
		if (this.#stopped) throw new ProtocolError("gateway_shutting_down", "gateway is stopping");
	}
	#binding(runtime: WorkAttemptRuntime): boolean {
		const binding = this.#db.bindings.getSessionRecord(runtime.sessionKey);
		return binding?.sessionId === runtime.sessionId && binding?.epoch === runtime.epoch;
	}
	#current(observer: Observer): boolean {
		return (
			!this.#stopped &&
			!this.#db.bindings.isQuarantined("work", observer.runtime.jobId) &&
			!observer.abort.signal.aborted &&
			this.#observers.get(observer.runtime.opRef) === observer &&
			observer.generation === (this.#options.brokerGeneration?.() ?? 0)
		);
	}
	#writeCurrent(observer: Observer): boolean {
		if (!this.#current(observer)) return false;
		const binding = this.#db.bindings.getSessionRecord(observer.runtime.sessionKey);
		return (
			this.#current(observer) &&
			binding?.sessionId === observer.binding?.sessionId &&
			binding?.epoch === observer.binding?.epoch
		);
	}
	#refreshWorkSession(tx: WriteTx, runtime: WorkAttemptRuntime, at: string): void {
		this.#db.bindings.touchWorkSession(
			tx,
			runtime.sessionKey,
			runtime.sessionId,
			runtime.epoch,
			at,
			JSON.stringify({
				platform: "work",
				kind: "task",
				conversationId: runtime.sessionKey.slice("work/task/".length),
			}),
		);
	}

	#prepareAttempt(runtime: WorkAttemptRuntime, record: LaneJobRecord): void {
		this.#db.transaction((tx) => {
			const binding = this.#db.bindings.getSessionRecord(runtime.sessionKey);
			const bindingMatches = binding?.sessionId === runtime.sessionId && binding.epoch === runtime.epoch;
			this.#db.work.workAttemptPrepare(tx, runtime, record, runtime.mode === "historical" || bindingMatches);
			this.#refreshWorkSession(tx, runtime, runtime.startedAt);
		});
	}
	#updateAttempt(opRef: string, expectedVersion: number, patch: WorkAttemptPatch): WorkAttemptRuntime | undefined {
		return this.#db.transaction((tx) => {
			const current = this.#db.work.workAttemptGet(opRef);
			const updated = this.#db.work.workAttemptUpdate(tx, opRef, expectedVersion, patch);
			if (
				current &&
				updated &&
				!hasAcceptanceEvidence(current) &&
				hasAcceptanceEvidence(updated) &&
				updated.noticeHash !== null
			) {
				this.#db.core.metaSet(
					`lane-notice:${updated.sessionKey}`,
					JSON.stringify({ epoch: updated.epoch, hash: updated.noticeHash }),
				);
			}
			return updated;
		});
	}

	#settleAttempt(
		opRef: string,
		expectedVersion: number,
		record: LaneJobRecord,
		patch: WorkAttemptSettlement,
		admission?: WorkAttemptAdmission,
	): WorkAttemptSettleResult | undefined {
		return this.#db.transaction((tx) => {
			const current = this.#db.work.workAttemptGet(opRef);
			if (!current || current.version !== expectedVersion || current.settledAt !== null) return undefined;
			const checks = {
				...(admission?.kind === "persona"
					? {
							personaSessionExists: this.#db.bindings.getSessionRecord(admission.row.originKey) !== undefined,
							personaMessageExists: this.#db.inbox.messageExists(admission.row.messageId),
						}
					: {}),
				...(admission?.kind === "lane"
					? { laneParentAvailable: this.#db.work.laneParentAvailable(admission.report.parentName) }
					: {}),
			};
			const settled = this.#db.work.workAttemptSettle(tx, opRef, expectedVersion, record, patch, admission, checks);
			if (!settled) return undefined;
			this.#refreshWorkSession(tx, settled.runtime, settled.runtime.settledAt!);
			if (settled.runtime.decision === "reported" && admission?.kind === "persona") {
				workAssert(
					this.#db.inbox.enqueue(tx, {
						messageId: admission.row.messageId,
						originKey: admission.row.originKey,
						originRefJson: resolveLaneReportOrigin(settled.runtime.parent, admission.row.originRefJson),
						body: admission.row.body,
						receivedAt: settled.runtime.settledAt!,
						source: "lane_report",
					}),
				);
			}
			for (const payload of [settled.fallbackPayload, settled.childFallback]) {
				if (!payload) continue;
				workAssert(typeof payload.deliveryId === "string");
				this.#db.outbox.enqueue(tx, {
					deliveryId: payload.deliveryId,
					turnId: payload.turnId,
					originKey: originKey(payload.origin),
					payloadJson: JSON.stringify(payload),
				});
			}
			return settled;
		});
	}

	#touchAttemptActivity(opRef: string, at: string): boolean {
		return this.#db.transaction((tx) => {
			const runtime = this.#db.work.workAttemptGet(opRef);
			if (!runtime || runtime.settledAt !== null) return false;
			this.#assertNotQuarantined(runtime.jobId);
			return this.#db.bindings.touchBoundSession(tx, runtime.sessionKey, runtime.sessionId, runtime.epoch, at);
		});
	}

	#reportMutation<T>(operation: (tx: WriteTx) => T): T {
		return this.#db.transaction(operation);
	}

	#job(name: string, required = false): LaneJobRecord | undefined {
		const { jobId } = laneJobIdentity(name);
		this.#assertNotQuarantined(jobId, name);
		try {
			const { jobId, laneKey } = laneJobIdentity(name);
			const byId = this.#db.work.laneJobJson(jobId);
			const byLane = this.#db.work.laneJobJsonByLaneKey(laneKey);
			if (byId !== byLane) throw new Error("identity mismatch");
			if (byId === undefined) {
				if (required)
					throw new ProtocolError("invalid_params", "unknown work lane", { reasonCode: "unknown_work_lane", name });
				return undefined;
			}
			const job = parseLaneJobRecord(byId);
			if (job.jobId !== jobId) throw new Error("identity mismatch");
			const last = job.attempts.at(-1);
			const saved = last && this.#db.work.workAttemptGet(last.opRef);
			if (
				last &&
				saved &&
				(saved.jobId !== jobId ||
					saved.laneKey !== laneKey ||
					saved.cwd !== job.lane.worktreePath ||
					saved.sessionId !== last.sessionId ||
					saved.startedAt !== last.startedAt ||
					saved.settledAt !== (last.endedAt ?? null))
			)
				throw new Error("runtime/history mismatch");
			const open = this.#db.work.workAttemptOpenByLane(laneKey);
			if (open && (job.attempts.at(-1)?.opRef !== open.opRef || job.attempts.at(-1)?.endedAt !== undefined))
				throw new Error("runtime mismatch");
			return job;
		} catch (error) {
			if (error instanceof ProtocolError) throw error;
			throw new ProtocolError("verb_failed", "work lane state unavailable", { reasonCode: "lane_state_corrupt", name });
		}
	}
	/**
	 * Closes a dead lane's current attempt through the normal atomic settlement
	 * path, or concludes checks without rewriting an already-settled runtime.
	 * LaneGovernor calls this while it owns the lane mutation lock.
	 */
	settleForceRetiredAttempt(name: string, opRef: string, reason: LaneForceRetireReason, endedAt: string): boolean {
		const record = this.#job(name, true);
		if (!record) return false;
		const attempt = record.attempts.at(-1);
		if (!attempt || attempt.opRef !== opRef) return false;
		const runtime = this.#db.work.workAttemptGet(opRef);
		if (!runtime) return false;
		if (runtime.settledAt !== null) {
			if (attempt.endedAt !== runtime.settledAt) return false;
			if (record.state === "awaiting_checks") {
				const effects = this.#settleChecks(
					name,
					record,
					{
						kind: "ended",
						reason: `lane ${reason === "operator_retired" ? "retired" : "force-retired"} before checks settled`,
					},
					undefined,
					endedAt,
				);
				// Admission is already durable. Never await another lane's lock from
				// this synchronous callback under the retiring lane's mutation lock.
				void this.#dispatchChecksEffects(effects).catch((error: unknown) => {
					console.error(`checks_report_dispatch_failed jobId=${record.jobId} reason=${failureReason(error)}`);
				});
			}
			return true;
		}
		if (attempt.endedAt !== undefined) return false;

		const recordedTerminal = runtime.terminal;
		const terminal: WorkAttemptTerminalEvidence = recordedTerminal ?? {
			kind: "local",
			observedAt: endedAt,
			reasonCode: reason,
		};
		const endState = recordedTerminal ? workAttemptEndState(terminal.reasonCode) : "attempt_ended";
		const errorCode = recordedTerminal
			? terminal.reasonCode === "end_turn"
				? undefined
				: terminal.reasonCode
			: "host_lost";
		const output =
			runtime.output.disposition === "pending"
				? { ...runtime.output, disposition: "unavailable" as const, nextReadAt: null }
				: runtime.output;
		const awaitingChecks = record.awaitingChecks;
		const closed = closeAttempt({
			record,
			opRef,
			endState,
			errorCode,
			endedAt,
		});
		const settledRecord = clearAwaitingChecks(closed);
		const reportFacts = awaitingChecks
			? {
					headSha: awaitingChecks.headSha,
					dirtyFiles: 0,
					pushed: null,
					...(awaitingChecks.prNumber !== null
						? {
								checkStatus: {
									prNumber: awaitingChecks.prNumber,
									headSha: awaitingChecks.headSha,
									status: "pending" as const,
									failingChecks: [],
								},
							}
						: {}),
				}
			: undefined;
		const text = reportText(name, endState, terminal.reasonCode, opRef, output, reportFacts, terminal.status);
		// Note: settleForceRetiredAttempt is synchronous, so we don't have repo facts here
		let decision: "report" | "suppressed" | "no_target" | "wake_unaccepted";
		let admission: WorkAttemptAdmission | undefined;
		if (runtime.wakeReportId !== null && !hasAcceptanceEvidence(runtime)) {
			decision = "wake_unaccepted";
		} else if (runtime.output.knownSilence !== null) {
			decision = "suppressed";
		} else if (runtime.parent === null) {
			decision = "no_target";
		} else {
			decision = "report";
			if (runtime.parent.kind === "persona") {
				const fallbackPayload = buildDeliveryPayload(runtime.opRef, runtime.parent.origin, text, runtime.deliveryId);
				if (!fallbackPayload) return false;
				const holdReason = this.#options.personaHold?.(runtime.parent.originKey);
				admission = {
					kind: "persona",
					row: {
						messageId: runtime.reportId,
						originKey: runtime.parent.originKey,
						originRefJson: JSON.stringify(runtime.parent.origin),
						body: text,
						receivedAt: endedAt,
					},
					fallbackPayload,
					...(holdReason ? { holdReason } : {}),
				};
			} else {
				const root = runtime.parent.root;
				admission = {
					kind: "lane",
					report: {
						reportId: runtime.reportId,
						parentName: runtime.parent.name,
						childName: name,
						childOpRef: runtime.opRef,
						body: text,
						root,
					},
					fallbackPayload: root
						? (buildDeliveryPayload(runtime.opRef, root.origin, text, runtime.deliveryId) ?? null)
						: null,
				};
			}
		}
		const settled = this.#settleAttempt(
			opRef,
			runtime.version,
			settledRecord,
			{ decision, settledAt: endedAt, terminal, ...(output !== runtime.output ? { output } : {}) },
			admission,
		);

		if (!settled) return false;
		this.#finishWaiters(opRef);
		for (const payload of [settled.fallbackPayload, settled.childFallback]) {
			if (!payload) continue;
			try {
				this.#options.deliverFallback?.(payload);
			} catch {
				console.error(`work_fallback_delivery_failed deliveryId=${payload.deliveryId}`);
			}
		}
		if (settled.runtime.decision === "reported" && settled.runtime.parent?.kind === "persona") {
			try {
				this.#options.notifyPersona?.(settled.runtime.parent.originKey);
			} catch {
				console.error(`work_persona_nudge_failed origin=${settled.runtime.parent.originKey}`);
			}
		}
		const parents = new Set([name]);
		if (settled.runtime.parent?.kind === "lane") parents.add(settled.runtime.parent.name);
		for (const parentName of parents) {
			void this.#drainLaneReports(parentName).catch(() => {
				console.error(`lane_report_drain_failed parent=${parentName}`);
			});
		}
		return true;
	}
	#assertNotQuarantined(jobId: string, name?: string): void {
		if (this.#db.bindings.isQuarantined("work", jobId))
			throw new ProtocolError("verb_failed", "work lane belongs to a quarantined broker authority", {
				reasonCode: "broker_authority_quarantined",
				jobId,
				...(name === undefined ? {} : { name }),
			});
	}
	#latestRuntime(name: string): WorkAttemptRuntime | undefined {
		const opRef = this.#job(name)?.attempts.at(-1)?.opRef;
		return opRef ? this.#db.work.workAttemptGet(opRef) : undefined;
	}
	#rootForLane(name: string): WorkReportRoot | null {
		const parent = this.#latestRuntime(name)?.parent;
		if (parent?.kind === "persona") return { originKey: parent.originKey, origin: parent.origin };
		if (parent?.kind === "lane") return parent.root;
		return null;
	}
	#assertNoNestedCycle(childName: string, parentName: string): void {
		const visited = new Set<string>();
		let name = parentName;
		for (let hop = 0; hop < 16; hop++) {
			if (name === childName || visited.has(name))
				throw new ProtocolError("invalid_params", "nested work lane would create a parent cycle", {
					reasonCode: "nested_lane_cycle",
					name: childName,
					parent: name,
				});
			visited.add(name);
			const parent = this.#latestRuntime(name)?.parent;
			if (parent?.kind !== "lane") return;
			name = parent.name;
		}
		throw new ProtocolError("invalid_params", "nested work lane parent chain exceeds 16 hops", {
			reasonCode: "nested_lane_cycle",
			name: childName,
			parent: name,
		});
	}
	#resolveCaller(input: WorkInput, mode: "start" | "run"): WorkParent | null {
		let callerOrigin: string | undefined;
		if (input.callerSessionId) callerOrigin = this.#db.bindings.originForSessionId(input.callerSessionId);
		const lanePrefix = "work/task/";
		const callerLane = callerOrigin?.startsWith(lanePrefix) ? callerOrigin.slice(lanePrefix.length) : undefined;
		let callerPersona: OriginRef | undefined;
		let callerMonitor: OriginRef | undefined;
		let triggerMessageId: string | undefined;
		if (callerOrigin && callerLane === undefined) {
			try {
				const activeTurn = this.#db.inbox.nonterminalTurns(callerOrigin)[0];
				let origin = parseOriginKey(callerOrigin);
				if (origin.platform === "discord" && origin.kind === "thread") {
					// Keys omit visibility. Preserve Discord's admitted metadata without
					// changing Slack's intentional channel-to-thread delivery projection.
					const activeRow = activeTurn ? this.#db.inbox.turnRow(activeTurn.opRef) : undefined;
					const storedOrigin = activeRow
						? JSON.parse(activeRow.origin_ref_json)
						: this.#db.bindings.getOriginByKey(callerOrigin);
					if (storedOrigin) {
						const admitted = validateOriginRef(storedOrigin as unknown as OriginRef);
						if (originKey(admitted) !== callerOrigin) throw new Error("bound origin does not match caller session");
						origin = admitted;
					}
				}
				if (PERSONA_PARENT_PLATFORMS.includes(origin.platform)) {
					callerPersona = origin;
					triggerMessageId = activeTurn?.triggerMessageId;
				} else if (origin.platform === "monitor") callerMonitor = origin;
			} catch {
				/* Unknown and non-persona origins fall back to ownerTarget for starts. */
			}
		}
		if (callerLane !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(callerLane)) {
			if (this.#options.allowNested?.() !== true) {
				console.error(`work_nested_refused verb=${mode} name=${input.name} parent=${callerLane}`);
				throw new ProtocolError(
					"unauthorized",
					`work.${mode} from a work lane is disabled (work.allowNested=false); finish your task and report back to your parent instead`,
					{ reasonCode: "nested_lane_forbidden", verb: mode, parent: callerLane },
				);
			}
			if (mode === "start") this.#assertNoNestedCycle(input.name, callerLane);
			const parent: WorkParent = { kind: "lane", name: callerLane, root: this.#rootForLane(callerLane) };
			const resolved = mode === "start" ? parent : null;
			console.error(
				`work_parent_resolved verb=${mode} name=${input.name} source=session kind=${mode === "start" ? "lane" : "none"}`,
			);
			return resolved;
		}
		if (mode === "run") {
			console.error(`work_parent_resolved verb=run name=${input.name} source=none kind=none`);
			return null;
		}
		if (callerPersona) {
			const parent: WorkParent = {
				kind: "persona",
				originKey: originKey(callerPersona),
				origin: callerPersona,
				...(triggerMessageId ? { triggerMessageId } : {}),
			};
			console.error(`work_parent_resolved verb=start name=${input.name} source=session kind=persona`);
			return parent;
		}
		// A monitor turn reports to the conversation its monitor delivers to; an
		// unusable target falls back to the owner with the reason on the log line.
		let fallback = "";
		if (callerMonitor) {
			const resolved = this.#monitorTargetParent(callerMonitor);
			const monitorLabel = callerMonitor.parentId ? ` monitor=${callerMonitor.parentId}` : "";
			if ("parent" in resolved) {
				console.error(`work_parent_resolved verb=start name=${input.name} source=monitor kind=persona${monitorLabel}`);
				return resolved.parent;
			}
			fallback = ` fallback=monitor_${resolved.reason}${monitorLabel}`;
		}
		const owner = this.#options.ownerTarget?.();
		if (owner) {
			try {
				validateOriginRef(owner);
				if (PERSONA_PARENT_PLATFORMS.includes(owner.platform)) {
					// Capture trigger message ID from the ownerTarget's origin for threading
					let ownerTriggerMessageId: string | undefined;
					const ownerOriginKey = originKey(owner);
					const ownerNonterminalTurns = this.#db.inbox.nonterminalTurns(ownerOriginKey);
					if (ownerNonterminalTurns.length > 0) {
						ownerTriggerMessageId = ownerNonterminalTurns[0]?.triggerMessageId;
					}
					const parent: WorkParent = {
						kind: "persona",
						originKey: ownerOriginKey,
						origin: structuredClone(owner),
						...(ownerTriggerMessageId ? { triggerMessageId: ownerTriggerMessageId } : {}),
					};
					console.error(`work_parent_resolved verb=start name=${input.name} source=owner kind=persona${fallback}`);
					return parent;
				}
			} catch {
				/* Invalid owner origins cannot become report targets. */
			}
		}
		console.error(`work_parent_resolved verb=start name=${input.name} source=none kind=none${fallback}`);
		return null;
	}
	#monitorTargetParent(monitorOrigin: OriginRef): { readonly parent: WorkParent } | { readonly reason: string } {
		// Event-type sessions from before #177 are not scoped to one monitor.
		if (!monitorOrigin.parentId) return { reason: "id_missing" };
		const targetJson = this.#db.monitors.channelTargetJson(monitorOrigin.parentId);
		if (targetJson === undefined) return { reason: "not_found" };
		if (targetJson === null) return { reason: "no_channel_target" };
		let target: OriginRef;
		try {
			target = validateOriginRef((JSON.parse(targetJson) as { origin: OriginRef }).origin);
		} catch {
			return { reason: "channel_target_invalid" };
		}
		if (!PERSONA_PARENT_PLATFORMS.includes(target.platform)) return { reason: "channel_target_not_chat" };
		return { parent: { kind: "persona", originKey: originKey(target), origin: target } };
	}
	#laneNotice(
		name: string,
		parent: WorkParent | null,
		epoch: number,
	): { readonly text: string; readonly hash: string } | undefined {
		const allowNested = this.#options.allowNested?.() === true;
		const text = laneSystemNotice({ name, parent, allowNested });
		const hash = createHash("sha256").update(text).digest("hex");
		const stored = this.#db.core.metaGet(`lane-notice:${workSessionKey(name)}`);
		if (stored) {
			try {
				const previous = JSON.parse(stored) as { epoch?: unknown; hash?: unknown };
				if (previous.epoch === epoch && previous.hash === hash) return undefined;
			} catch {
				/* Corrupt notice metadata fails closed by re-sending the notice. */
			}
		}
		return { text, hash };
	}
	async start(params: unknown): Promise<WorkStartResult> {
		return this.#start(parseInput(params), "start");
	}
	async run(params: unknown, owner: object, signal?: AbortSignal) {
		const call: RunCall = { owner, active: true };
		const abort = () => this.#releaseRunCall(call);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		try {
			const started = await this.#start(parseInput(params), "run", call);
			if (!started.started) {
				const { started: _, ...held } = started;
				return held;
			}
			await this.#wait(started.opRef, owner, signal);
			const runtime = this.#db.work.workAttemptGet(started.opRef)!;
			const reason = runtime.terminal?.reasonCode ?? "terminal_uncertain";
			if (reason !== "end_turn") throw workError("work attempt did not complete", reason, runtime);
			const text = call.text;
			if (text === undefined) throw workError("work output unavailable", "output_unavailable", runtime);
			return { held: false as const, text, jobId: runtime.jobId, opRef: runtime.opRef, sessionKey: runtime.sessionKey };
		} finally {
			signal?.removeEventListener("abort", abort);
			this.#releaseRunCall(call);
		}
	}
	#releaseRunCall(call: RunCall): void {
		call.active = false;
		call.text = undefined;
		if (call.opRef !== undefined && this.#runCalls.get(call.opRef) === call) this.#runCalls.delete(call.opRef);
	}
	async #start(input: WorkInput, mode: "start" | "run", runCall?: RunCall): Promise<WorkStartResult> {
		this.#live();
		const parent = this.#resolveCaller(input, mode);
		if (this.#job(input.name)) return await this.#startAdmitted(input, mode, { parent, runCall });
		const admitting = this.#admissions.get(input.name);
		// A same-name retry (for example after a caller timeout) must not queue a
		// second clone, bind or send behind the admission still in progress.
		if (admitting && admitting.failedAt === undefined)
			return {
				started: false,
				held: true,
				jobId: laneJobIdentity(input.name).jobId,
				state: "admitting",
				reason: "the lane start is still being admitted; check work.status",
			};
		const admission = { startedAt: this.#at() };
		this.#admissions.set(input.name, admission);
		try {
			const result = await this.#startAdmitted(input, mode, { parent, runCall });
			if (this.#admissions.get(input.name) === admission) this.#admissions.delete(input.name);
			return result;
		} catch (error) {
			if (this.#admissions.get(input.name) === admission) {
				if (this.#job(input.name)) this.#admissions.delete(input.name);
				else this.#admissions.set(input.name, { ...admission, failedAt: this.#at(), reason: failureReason(error) });
			}
			throw error;
		}
	}
	async #startAdmitted(input: WorkInput, mode: "start" | "run", context: StartContext): Promise<WorkStartResult> {
		await this.recover();
		this.#live();
		return this.#port.runExclusive(workSessionKey(input.name), () => this.#startLocked(input, mode, context));
	}
	async #startLocked(input: WorkInput, mode: "start" | "run", context: StartContext): Promise<WorkStartResult> {
		this.#live();
		if (input.cwd !== undefined) assertOutsideServiceDirectory(this.#options.serviceDirectory, input.cwd, input.name);
		const sessionKey = workSessionKey(input.name);
		let job = this.#job(input.name);
		const { jobId } = laneJobIdentity(input.name);
		// A supplied repository identifies a repo-backed lane; otherwise an explicit
		// cwd must match the durable worktree path. Omitting both resumes by lane name.
		if (job && input.repo !== undefined && job.lane.repository !== input.repo)
			throw new ProtocolError("invalid_params", "work lane repository mismatch", {
				reasonCode: "lane_repository_mismatch",
				name: input.name,
			});
		if (job && input.repo === undefined && input.cwd !== undefined && job.lane.worktreePath !== input.cwd)
			throw new ProtocolError("invalid_params", "work lane cwd mismatch", {
				reasonCode: "lane_cwd_mismatch",
				name: input.name,
			});
		if (job && input.base !== undefined)
			throw new ProtocolError("invalid_params", "base can only be selected when creating a work lane", {
				reasonCode: "lane_base_already_bound",
				name: input.name,
			});
		if (!job && input.cwd === undefined && input.repo === undefined)
			throw new ProtocolError("invalid_params", "work lane requires cwd or repo", {
				reasonCode: "repo_or_cwd_required",
				name: input.name,
			});

		const laneRoot = this.#options.laneRoot ?? this.#options.gajaewayHome;
		const candidateWorktreePath =
			job?.lane.worktreePath ?? (input.repo !== undefined ? managedLaneWorktreePath(laneRoot, input.name) : input.cwd);
		if (candidateWorktreePath === undefined) throw new Error("work lane path was not resolved");
		assertOutsideServiceDirectory(this.#options.serviceDirectory, candidateWorktreePath, input.name);
		const candidateRepositoryPath =
			job?.lane.repositoryPath ??
			(!job && input.repo !== undefined ? managedLaneRepositoryPath(laneRoot, input.name) : undefined);
		if (candidateRepositoryPath !== undefined)
			assertOutsideServiceDirectory(this.#options.serviceDirectory, candidateRepositoryPath, input.name);
		const open = job?.attempts.find((attempt) => attempt.endedAt === undefined);
		if (open)
			throw new ProtocolError("invalid_params", "attempt already open; use work.steer or wait", {
				reasonCode: "attempt_open",
				jobId,
				opRef: open.opRef,
				sessionId: open.sessionId,
			});
		if (job?.state === "awaiting_checks" && !context.checksRetry)
			return {
				started: false,
				held: true,
				jobId,
				state: job.state,
				reason: "the lane is awaiting PR checks; wait for check polling to settle it",
			};
		if (job?.state === "done")
			return {
				started: false,
				held: true,
				jobId,
				state: job.state,
				reason: "the lane is complete; retire it before creating another lane with this name",
			};
		if (job && (job.state === "awaiting_operator" || job.state === "stalled")) {
			if (!input.resume)
				return {
					started: false,
					held: true,
					jobId,
					state: job.state,
					reason: `the job is ${job.state}; reconcile, then resume explicitly`,
				};
			job = acknowledgeHold({ record: job, note: "operator resumed the work lane", at: this.#at() });
		}
		let createdWorktree: CreatedRepoWorktree | undefined;
		if (!job) {
			let worktreePath = input.cwd;
			let repositoryPath: string | undefined;
			if (input.repo !== undefined) {
				createdWorktree = await createWorktreeFromRepo(
					laneRoot,
					this.#options.serviceDirectory,
					input.name,
					input.repo,
					input.base,
					this.#gitTimeouts(),
				);
				worktreePath = createdWorktree.worktreePath;
				repositoryPath = createdWorktree.repositoryPath;
			}
			if (worktreePath === undefined) throw new Error("work lane path was not resolved");
			const facts = await collectRepoFacts(worktreePath, this.#gitTimeouts(), undefined, false);
			job = createLaneJobRecord({
				jobId,
				branch: facts?.branch ?? managedLaneBranchName(input.name),
				worktreePath,
				baselineSha: createdWorktree?.baseSha ?? facts?.headSha,
				...(input.repo !== undefined ? { repository: input.repo } : {}),
				...(repositoryPath !== undefined ? { repositoryPath } : {}),
			});
		}
		const initialJob = job;
		if (!initialJob) throw new Error("work lane record was not initialized");
		const worktreePath = initialJob.lane.worktreePath;
		input = { ...input, cwd: worktreePath };
		let bindAttemptStarted = false;
		let worktreePersisted = false;
		let binding: Awaited<ReturnType<SessionPort["bind"]>>;
		try {
			// Each try re-takes the admission lock and re-checks capacity, so a
			// lane waiting out a broker restart does not hold other lanes' admission.
			// Only an unavailable broker is retried; every other bind failure is final.
			const bindFailed = (error: unknown): ProtocolError => {
				const cause = workBindFailureCause(error);
				console.error(
					`work_bind_failed name=${input.name} origin=${sessionKey} cwd=${worktreePath} cause=${cause} error=${workBindFailureMessage(error)}`,
				);
				return new ProtocolError("verb_failed", `work lane bind failed (cause: ${cause})`, {
					reasonCode: "bind_failed",
					cause,
					name: input.name,
				});
			};
			binding = await waitForBroker(
				`work.bind:${input.name}`,
				() =>
					this.#port.runExclusive("work/admission", async () => {
						this.#live();
						this.#options.lanes.assertAdmission(input.name);
						if (createdWorktree && !worktreePersisted) {
							this.#putJob(input.name, initialJob);
							worktreePersisted = true;
						}
						bindAttemptStarted = true;
						try {
							return await this.#port.bind({
								originKey: sessionKey,
								epoch: this.#db.bindings.getSessionRecord(sessionKey)?.epoch ?? 0,
								repo: worktreePath,
								codingRegister: true,
								...(input.model ? { model: input.model } : {}),
							});
						} catch (error) {
							throw isBrokerUnavailable(error) ? error : bindFailed(error);
						}
					}),
				{ ...WORK_BIND_BROKER_WAIT, ...this.#options.brokerWait },
			).catch((error: unknown) => {
				throw isBrokerUnavailable(error) ? bindFailed(error) : error;
			});
		} catch (error) {
			if (createdWorktree && bindAttemptStarted) {
				console.error(`worktree_creation_retained name=${input.name} reason=session_bind_may_reference_worktree`);
			} else if (createdWorktree) {
				try {
					await discardCreatedWorktree(input.name, createdWorktree, this.#gitTimeouts());
				} catch (cleanupError) {
					console.error(
						`worktree_creation_cleanup_failed name=${input.name} reason=${sanitizeDiagnostic(cleanupError instanceof Error ? cleanupError.message : String(cleanupError))}`,
					);
				}
			}
			throw error;
		}
		this.#live();
		const opRef = context.opRef ?? newOpRef(`work-${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
		const notice = mode === "start" ? this.#laneNotice(input.name, context.parent, binding.epoch) : undefined;
		const runtime = makeRuntime(
			this.#db,
			input.name,
			binding.sessionId,
			binding.epoch,
			worktreePath,
			this.#at(),
			opRef,
			mode,
			mode === "start" ? context.parent : null,
			context.wakeReportId ?? null,
			notice?.hash ?? null,
		);
		job = appendAttempt(initialJob, { opRef, sessionId: binding.sessionId, startedAt: runtime.startedAt });
		this.#prepareAttempt(runtime, job);

		if (context.runCall?.active && !this.#detachedOwners.has(context.runCall.owner)) {
			context.runCall.opRef = opRef;
			this.#runCalls.set(opRef, context.runCall);
		}
		const observer = this.#register(runtime);
		this.#attach(observer);
		await observer.attaching;
		if (!this.#writeCurrent(observer)) {
			// This invocation has not called send. That local fact survives broker
			// revocation, but must not overwrite a concurrent acceptance or terminal.
			const current = this.#db.work.workAttemptGet(opRef);
			const notSubmitted =
				current && !current.settledAt && !current.terminal && !hasAcceptanceEvidence(current)
					? this.#updateAttempt(opRef, current.version, {
							terminal: { kind: "local", observedAt: this.#at(), reasonCode: "send_rejected" },
						})
					: undefined;
			this.#live();
			if (notSubmitted) throw workError("work send rejected", "send_rejected", notSubmitted);
			throw workError("work send acceptance uncertain", "send_acceptance_uncertain", runtime);
		}
		let accepted = false;
		let rejected = false;
		let source: "receipt" | "status" = "receipt";
		try {
			const receipt = await this.#port.send({
				sessionId: runtime.sessionId,
				repo: runtime.cwd,
				opRef,
				text: this.#withDirectives(input.text, context.parent),
				...(observer.tail ? { relay: observer.tail } : {}),
				...(notice ? { systemPreamble: notice.text } : {}),
				codingRegister: true,
				// Only this bind receipt can prove the requested model was applied at startup.
				...(input.model && binding.startupModelApplied !== true ? { model: input.model } : {}),
			});
			observer.tail?.correlate(opRef, receipt);
			accepted = receipt.operationRef === opRef && receipt.sessionId === runtime.sessionId;
		} catch (error) {
			rejected = definitiveRefusal(error);
			const code =
				typeof error === "object" && error !== null && "details" in error
					? (error.details as { code?: unknown } | undefined)?.code
					: undefined;
			console.error(
				`work_send_error opRef=${opRef} code=${typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "transport_unavailable"}`,
			);
		}
		if (!this.#writeCurrent(observer)) {
			console.error(
				`work_send_fenced opRef=${opRef} generation=${observer.generation} currentGeneration=${this.#options.brokerGeneration?.() ?? 0} binding=${this.#binding(runtime)}`,
			);
			this.#live();
			throw workError("work send acceptance uncertain", "send_acceptance_uncertain", runtime);
		}
		let latest = this.#db.work.workAttemptGet(opRef)!;
		if (!accepted && !rejected) {
			try {
				accepted = provesAcceptance(await this.#query(latest, observer.tail));
				source = "status";
			} catch {
				/* Observation owns recovery; never replay. */
			}
		}
		if (!this.#writeCurrent(observer)) {
			console.error(
				`work_send_reconcile_fenced opRef=${opRef} generation=${observer.generation} currentGeneration=${this.#options.brokerGeneration?.() ?? 0} binding=${this.#binding(runtime)}`,
			);
			this.#live();
			throw workError("work send acceptance uncertain", "send_acceptance_uncertain", runtime);
		}
		latest =
			this.#updateAttempt(
				opRef,
				latest.version,
				accepted
					? { sendPhase: "accepted", sendEvidence: { source, observedAt: this.#at() } }
					: {
							sendPhase: "uncertain",
							...(rejected
								? { terminal: { kind: "local", observedAt: this.#at(), reasonCode: "send_rejected" } as const }
								: {}),
						},
			) ?? latest;
		this.#schedule(observer, 0);
		if (rejected) throw workError("work send rejected", "send_rejected", latest);
		if (!accepted) throw workError("work send acceptance uncertain", "send_acceptance_uncertain", latest);
		return { started: true, jobId, opRef, sessionKey, sessionId: runtime.sessionId };
	}
	async status(params: unknown): Promise<WorkStatusResult> {
		const name = parseName(params);
		const admission = this.#job(name) ? undefined : this.#admissions.get(name);
		if (admission)
			return {
				jobId: laneJobIdentity(name).jobId,
				state: admission.failedAt === undefined ? "admitting" : "admission_failed",
				sessionId: "",
				lastActivityAt: null,
				attempt: null,
				op: null,
				admission: { ...admission },
			};
		const job = this.#job(name, true)!;
		const key = workSessionKey(name);
		const binding = this.#db.bindings.getSessionRecord(key);
		const attempt = job.attempts.at(-1);
		let op: PromptStatusBody | null = null;
		if (attempt && binding?.sessionId === attempt.sessionId) {
			try {
				const observer = this.#observers.get(attempt.opRef);
				const tail = observer && this.#writeCurrent(observer) ? observer.tail : undefined;
				op = await this.#query(
					{
						jobId: job.jobId,
						opRef: attempt.opRef,
						sessionId: attempt.sessionId,
						cwd: job.lane.worktreePath,
					},
					tail,
				);
			} catch (error) {
				// A settled attempt whose host is gone has no live op to report.
				if (attempt.endedAt === undefined || !isSessionUnavailable(error))
					throw workError("work status unavailable", "status_unavailable", { ...attempt, jobId: job.jobId });
			}
			const current = this.#db.bindings.getSessionRecord(key);
			if (current?.sessionId !== binding.sessionId || current.epoch !== binding.epoch) op = null;
		}
		return {
			jobId: job.jobId,
			state: job.state,
			sessionId: this.#db.bindings.getSessionRecord(key)?.sessionId ?? "",
			lastActivityAt: this.#db.bindings.workLaneRows().find((row) => row.origin_key === key)?.last_activity_at ?? null,
			attempt: attempt
				? {
						opRef: attempt.opRef,
						startedAt: attempt.startedAt,
						...(attempt.endedAt ? { endedAt: attempt.endedAt } : {}),
						...(attempt.endState ? { endState: attempt.endState } : {}),
					}
				: null,
			op,
			// Add repository binding info if present (issue #480)
			...(job.lane.repository
				? {
						repository: {
							url: job.lane.repository,
							branch: job.lane.branch,
							base: job.baselineSha ?? undefined,
						},
					}
				: {}),
		};
	}
	/**
	 * Standing operator directives (#604). They are stored durably, prepended to
	 * every later attempt of a matching lane, and steered into matching lanes that
	 * are running when one is added, so a mid-conversation prohibition reaches
	 * work already under way instead of living only in the conversation's memory.
	 */
	async directive(params: unknown): Promise<WorkDirectiveResult> {
		if (!params || typeof params !== "object" || Array.isArray(params)) invalid("params");
		const { action, text, id, callerSessionId } = params as Record<string, unknown>;
		if (callerSessionId !== undefined && typeof callerSessionId !== "string") invalid("callerSessionId");
		this.#live();
		const scope = this.#directiveScope(callerSessionId);
		const visible = () =>
			this.#directives().filter(
				(directive) =>
					scope === OWNER_DIRECTIVE_SCOPE || directive.scope === scope || directive.scope === OWNER_DIRECTIVE_SCOPE,
			);
		if (action === "list") return { directives: visible() };
		if (action === "remove") {
			if (typeof id !== "string" || !DIRECTIVE_ID.test(id)) invalid("id");
			const target = this.#directives().find((directive) => directive.id === id);
			if (!target || (scope !== OWNER_DIRECTIVE_SCOPE && target.scope !== scope))
				throw new ProtocolError("invalid_params", "unknown work directive", { reasonCode: "unknown_directive", id });
			this.#db.core.metaDelete(`${DIRECTIVE_KEY_PREFIX}${id}`);
			return { directives: visible() };
		}
		if (action !== "add") invalid("action");
		if (typeof text !== "string" || !text.trim() || text.length > MAX_DIRECTIVE_CHARS) invalid("text");
		if (this.#directives().filter((directive) => directive.scope === scope).length >= MAX_DIRECTIVES_PER_SCOPE)
			throw new ProtocolError(
				"invalid_params",
				`at most ${MAX_DIRECTIVES_PER_SCOPE} directives per scope; remove one first`,
				{
					reasonCode: "directive_limit",
				},
			);
		const directive: WorkDirective = {
			id: `wd-${randomUUID().slice(0, 8)}`,
			scope,
			text: text.trim(),
			createdAt: this.#at(),
		};
		this.#db.core.metaSet(`${DIRECTIVE_KEY_PREFIX}${directive.id}`, JSON.stringify(directive));
		const names = new Set<string>();
		for (const runtime of this.#db.work.workAttemptOpen(1000)) {
			if (!runtime.sessionKey.startsWith(WORK_SESSION_PREFIX)) continue;
			if (directiveApplies(directive, laneDirectiveScope(runtime.parent)))
				names.add(runtime.sessionKey.slice(WORK_SESSION_PREFIX.length));
		}
		const propagated: { name: string; steered: boolean; reason?: string }[] = [];
		for (const name of names) {
			try {
				const result = await this.steer({ name, text: directiveText([directive], "new") });
				propagated.push(result.steered ? { name, steered: true } : { name, steered: false, reason: result.reason });
			} catch (error) {
				const reason =
					error instanceof ProtocolError
						? String((error.detail as { reasonCode?: unknown } | undefined)?.reasonCode ?? error.code)
						: "steer_failed";
				propagated.push({ name, steered: false, reason });
			}
		}
		console.error(
			`work_directive_added id=${directive.id} scope=${scope} lanes=${propagated.length} steered=${propagated.filter((lane) => lane.steered).length}`,
		);
		return { directives: visible(), propagated };
	}
	#directiveScope(callerSessionId: string | undefined): string {
		const callerOrigin = callerSessionId ? this.#db.bindings.originForSessionId(callerSessionId) : undefined;
		if (callerOrigin === undefined) return OWNER_DIRECTIVE_SCOPE;
		if (callerOrigin.startsWith(WORK_SESSION_PREFIX))
			throw new ProtocolError("unauthorized", "a work lane cannot set operator directives", {
				reasonCode: "directive_from_lane",
			});
		return callerOrigin;
	}
	#directives(): WorkDirective[] {
		const directives: WorkDirective[] = [];
		for (const key of this.#db.core.metaKeysInRange(DIRECTIVE_KEY_PREFIX, `${DIRECTIVE_KEY_PREFIX}\uffff`)) {
			try {
				const value = JSON.parse(this.#db.core.metaGet(key) ?? "") as WorkDirective;
				if (typeof value.text === "string" && typeof value.scope === "string" && typeof value.id === "string")
					directives.push(value);
			} catch {
				console.error(`work_directive_unreadable key=${key}`);
			}
		}
		return directives.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
	}
	#withDirectives(text: string, parent: WorkParent | null): string {
		const scope = laneDirectiveScope(parent);
		const active = this.#directives().filter((directive) => directiveApplies(directive, scope));
		return active.length === 0 ? text : `${directiveText(active, "standing")}\n\n${text}`;
	}
	async steer(params: unknown): Promise<WorkSteerResult> {
		const name = parseName(params);
		const text = (params as { text?: unknown }).text;
		if (typeof text !== "string" || !text) invalid("text");
		this.#live();
		const job = this.#job(name, true)!;
		const captured = job.attempts.find((attempt) => attempt.endedAt === undefined);
		if (!captured)
			throw new ProtocolError("invalid_params", "no open attempt to steer", {
				reasonCode: "no_open_attempt",
				jobId: job.jobId,
			});
		await this.recover();
		this.#live();
		return this.#port.runExclusive(workSessionKey(name), async (): Promise<WorkSteerResult> => {
			this.#live();
			const current = this.#job(name, true)!;
			const open = current.attempts.at(-1);
			if (open?.opRef !== captured.opRef || open.endedAt !== undefined)
				throw new ProtocolError("invalid_params", "no open attempt to steer", {
					reasonCode: "no_open_attempt",
					jobId: job.jobId,
				});
			const runtime = this.#db.work.workAttemptGet(open.opRef);
			const clientRef = newOpRef("work-steer");
			if (!runtime || !this.#binding(runtime) || runtime.terminal)
				throw workError(
					"work steer acceptance uncertain",
					"steer_acceptance_uncertain",
					{ ...open, jobId: job.jobId },
					clientRef,
				);
			try {
				await this.#port.steer({ sessionId: open.sessionId, repo: current.lane.worktreePath, text, clientRef });
			} catch (error) {
				if (definitiveSteerRefusal(error)) return { steered: false, reason: `steer_refused:${safeRefusal(error)}` };
				throw workError("work steer acceptance uncertain", "steer_acceptance_uncertain", runtime, clientRef);
			}
			return { steered: true, clientRef };
		});
	}
	async #query(
		runtime: { jobId: string; sessionId: string; cwd: string; opRef: string },
		tail?: TailHandle,
	): Promise<PromptStatusBody> {
		this.#assertNotQuarantined(runtime.jobId);
		const base = {
			sessionId: runtime.sessionId,
			repo: runtime.cwd,
			opRef: runtime.opRef,
			priority: "background" as const,
		};
		let report: Awaited<ReturnType<SessionPort["status"]>>;
		if (tail) {
			try {
				report = await this.#port.status({ ...base, relay: tail });
			} catch (error) {
				if (!isRelayTransportFailure(error)) throw error;
				// Relay failed; fall back to CLI
				report = await this.#port.status(base);
			}
		} else {
			report = await this.#port.status(base);
		}
		if (
			report.operationRef !== runtime.opRef ||
			!report.status ||
			!["accepted", "in_flight", "terminal_ok", "failed", "unknown"].includes(report.status.status) ||
			(report.status.clientRef !== undefined && report.status.clientRef !== runtime.opRef)
		)
			throw new Error("invalid status identity");
		return safeStatus(report.status);
	}
	#register(runtime: WorkAttemptRuntime): Observer {
		const existing = this.#observers.get(runtime.opRef);
		if (existing && this.#current(existing)) return existing;
		const binding = this.#db.bindings.getSessionRecord(runtime.sessionKey);
		const observer: Observer = {
			runtime,
			generation: this.#options.brokerGeneration?.() ?? 0,
			abort: new AbortController(),
			binding: binding ? { sessionId: binding.sessionId, epoch: binding.epoch } : undefined,
			...(runtime.turnEndObservedAt ? { turnEndObservedAt: runtime.turnEndObservedAt } : {}),
		};
		this.#observers.set(runtime.opRef, observer);
		return observer;
	}
	#schedule(observer: Observer, delay: number): void {
		if (!this.#current(observer)) return;
		if (observer.task) {
			if (delay === 0) observer.wakeRequested = true;
			return;
		}
		if (observer.timer) {
			if (delay !== 0) return;
			clearTimeout(observer.timer);
			observer.timer = undefined;
		}
		const opRef = observer.runtime.opRef;
		observer.timer = setTimeout(() => {
			observer.timer = undefined;
			if (!this.#current(observer)) return;
			observer.task = this.#tick(observer)
				.then(
					() => {
						this.#failures.delete(opRef);
					},
					(error: unknown) => this.#failed(observer, error),
				)
				.finally(() => {
					observer.task = undefined;
					if (!this.#current(observer)) return;
					if (this.#db.work.workAttemptGet(opRef)?.settledAt !== null) {
						this.#observers.delete(opRef);
						this.#failures.delete(opRef);
						return;
					}
					// The lane was rebound under this observer: it can never write again,
					// so polling is pure waste. Recovery re-proves authority and settles.
					if (!this.#writeCurrent(observer)) return this.#readopt(observer, "binding_changed");
					const failures = this.#failures.get(opRef)?.failures ?? 0;
					if (failures > 0 && failures % FAILURES_PER_READOPTION === 0)
						return this.#readopt(observer, "reconciliation_unavailable");
					if (observer.wakeRequested) {
						observer.wakeRequested = false;
						return this.#schedule(observer, 0);
					}
					const pollMs = this.#options.pollMs ?? 250;
					// When a tail is attached, frames wake the observer; use a slow fallback
					// cadence instead of polling every 250ms.
					const basePollMs = observer.tail && !this.#options.pollMs ? 5_000 : pollMs;
					this.#schedule(
						observer,
						failures ? Math.min(basePollMs * 2 ** (failures - 1), MAX_FAILURE_BACKOFF_MS) : basePollMs,
					);
				})
				// This chain runs off a timer with nothing awaiting it: a throw here (an
				// unreadable runtime row, #401) would be an unhandled rejection that kills
				// the gateway. Stop observing only this attempt; recovery reports it.
				.catch((error: unknown) => this.#dropObserver(observer, error));
		}, delay);
	}
	#dropObserver(observer: Observer, error: unknown): void {
		const opRef = observer.runtime.opRef;
		console.error(`work_observer_failed opRef=${JSON.stringify(opRef)} error=${failureReason(error)}`);
		void this.#disposeObserver(observer);
		if (this.#observers.get(opRef) === observer) this.#observers.delete(opRef);
		this.#failures.delete(opRef);
	}
	/** Revoke callbacks immediately; dispose relays without waiting on our own tick. */
	#disposeObserver(observer: Observer): Promise<void> {
		if (observer.disposal) return observer.disposal;
		observer.abort.abort();
		if (observer.timer) clearTimeout(observer.timer);
		observer.timer = undefined;
		const report = (error: unknown) => {
			console.error(`work_observer_cleanup_failed opRef=${observer.runtime.opRef} reason=${failureReason(error)}`);
		};
		const closeTail = async () => {
			const tail = observer.tail;
			observer.tail = undefined;
			try {
				await tail?.close();
			} catch (error) {
				report(error);
			}
		};
		const disposal = Promise.resolve()
			.then(async () => {
				// Closing an acquired handle first also releases a pending ready wait.
				await closeTail();
				try {
					await observer.attaching;
				} catch (error) {
					report(error);
				}
				// A late attachment is fenced and closes itself; retain cleanup ownership
				// until that completion, including any handle acquired before revocation.
				await closeTail();
			})
			.finally(() => this.#observerDisposals.delete(disposal));
		observer.disposal = disposal;
		this.#observerDisposals.add(disposal);
		return disposal;
	}
	/** Counts the failure and reports it once per distinct reason instead of on every poll. */
	#failed(observer: Observer, error: unknown): void {
		const opRef = observer.runtime.opRef;
		const prior = this.#failures.get(opRef);
		const reason = failureReason(error);
		const failures = (prior?.failures ?? 0) + 1;
		this.#failures.set(opRef, { failures, reason });
		if (this.#current(observer) && prior?.reason !== reason)
			console.error(`work_reconciliation_unavailable opRef=${opRef} failures=${failures} reason=${reason}`);
	}
	/**
	 * Retires this observer and hands the open attempt back to recovery, which
	 * re-reads status and broker liveness and either resumes observation on a
	 * live, still-bound session or records a local terminal reason.
	 */
	#readopt(observer: Observer, cause: "binding_changed" | "reconciliation_unavailable"): void {
		const opRef = observer.runtime.opRef;
		console.error(
			`work_observer_readopted opRef=${opRef} cause=${cause} failures=${this.#failures.get(opRef)?.failures ?? 0}`,
		);
		observer.abort.abort();
		void (async () => {
			await this.recover();
			// A recovery pass already past this attempt when it was retired cannot
			// have readopted it; a pass started after retirement always does.
			const current = this.#observers.get(opRef);
			if (
				!this.#stopped &&
				(!current || current.abort.signal.aborted) &&
				this.#db.work.workAttemptGet(opRef)?.settledAt === null
			)
				await this.recover();
		})().catch(() => {
			/* Recovery reports its own failures; the attempt stays open and observable. */
		});
	}
	#attach(observer: Observer): void {
		if (observer.tail || observer.attaching || !this.#writeCurrent(observer) || !this.#binding(observer.runtime))
			return;
		observer.attaching = (async () => {
			const runtime = observer.runtime;
			const invalidateActivity = () => {
				observer.activityVersion = (observer.activityVersion ?? 0) + 1;
				observer.receiptDeadSince = undefined;
				observer.goneSince = undefined;
			};
			const tail = await this.#port.attachTail({
				sessionId: runtime.sessionId,
				brokerGeneration: observer.generation,
				repo: runtime.cwd,
				signal: observer.abort.signal,
				originKey: runtime.sessionKey,
				onTurnActivity: invalidateActivity,
				onObserverLifecycle: (kind) => {
					// A native run can start without SDK correlation or content. It
					// invalidates end proof, but cannot supply an attempt's receipt.
					if (kind === "agent_start") invalidateActivity();
				},
				onRelayLost: invalidateActivity,
				onRelayDead: () => {
					invalidateActivity();
					if (this.#writeCurrent(observer)) this.#readopt(observer, "reconciliation_unavailable");
				},
				// Observed session content after reconnect is execution evidence too:
				// it must invalidate a pending idle/host-dead proof, not only touch last=.
				onSessionActivity: () => {
					invalidateActivity();
					if (this.#writeCurrent(observer)) this.#touch(observer);
				},
				onFrame: (frame) => {
					if (!this.#writeCurrent(observer)) return;
					if (
						(frame.kind === "agent_end" || frame.kind === "agent_failed") &&
						(frame.commandId !== undefined || frame.turnId !== undefined)
					) {
						observer.turnEndObservedAt ??= this.#at();
						const current = this.#db.work.workAttemptGet(runtime.opRef);
						if (current && current.settledAt === null && current.turnEndObservedAt === undefined)
							this.#updateAttempt(current.opRef, current.version, {
								turnEndObservedAt: observer.turnEndObservedAt,
							});
						observer.tail?.setTurnRunning(false);
					} else if (frame.kind === "agent_start") {
						observer.tail?.setTurnRunning(true);
					}
					this.#schedule(observer, 0);
					if (frame.commandId !== undefined || frame.turnId !== undefined) this.#touch(observer);
				},
			});
			if (!this.#writeCurrent(observer)) {
				await tail.close();
				return;
			}
			observer.tail = tail;
			await tail.ready;
			if (this.#writeCurrent(observer) && this.#db.work.workAttemptGet(runtime.opRef)?.settledAt === null) {
				tail.beginTurn(runtime.opRef);
				tail.setTurnRunning(observer.turnEndObservedAt === undefined);
			}
		})()
			.catch(async () => {
				const tail = observer.tail;
				observer.tail = undefined;
				await tail?.close();
			})
			.finally(() => {
				observer.attaching = undefined;
			});
	}
	/**
	 * Advances the persisted `work jobs` `last=` activity checkpoint on real
	 * content, not polls/hello/heartbeats. Preparation and settlement also write
	 * their timestamps, so the checkpoint alone proves neither observed content
	 * nor attempt ownership/completion. These content-driven writes are throttled
	 * and fenced to the binding and open attempt.
	 */
	#touch(observer: Observer): void {
		const now = this.#now();
		if (observer.touchedAt !== undefined && now - observer.touchedAt < ACTIVITY_TOUCH_MS) return;
		observer.touchedAt = now;
		try {
			this.#touchAttemptActivity(observer.runtime.opRef, new Date(now).toISOString());
		} catch {
			console.error(`work activity update unavailable opRef=${observer.runtime.opRef}`);
		}
	}
	/**
	 * Positive evidence that the attempt's host is gone: the SDK router already
	 * answered `session_unavailable` for the operation, and an independent
	 * inspect confirms the id is disowned or not live. Broker unavailability
	 * yields neither and never settles an attempt.
	 */
	async #hostGone(runtime: { sessionId: string; cwd: string }, statusError: unknown): Promise<boolean> {
		if (!isSessionUnavailable(statusError) || !this.#port.liveness) return false;
		try {
			const live = await this.#port.liveness({ sessionId: runtime.sessionId, repo: runtime.cwd });
			return live.disowned || live.live === false;
		} catch {
			return false;
		}
	}
	/**
	 * Lifecycle delivery is not guaranteed across disconnects/restarts. A live
	 * host can independently prove execution ended, but a request deadline, an
	 * idle broker activity label, or an unavailable probe cannot (#564).
	 */
	async #observeIdleTurnEnd(
		observer: Observer,
		runtime: WorkAttemptRuntime,
		status: PromptStatusBody,
	): Promise<boolean | undefined> {
		if (
			status.clientRef !== runtime.opRef ||
			(!status.commandId && !status.turnId) ||
			!(status.startedAt !== undefined && status.startedAt >= Date.parse(runtime.startedAt)) ||
			!(status.terminalAt !== undefined && status.terminalAt >= status.startedAt)
		)
			return false;
		if (!this.#port.turnRunning) return undefined;
		const activityVersion = observer.activityVersion;
		const tail = observer.attaching ? undefined : observer.tail;
		const connectionEpoch = tail?.connectionEpoch;
		if (tail && connectionEpoch !== undefined)
			tail.correlate(runtime.opRef, { commandId: status.commandId, turnId: status.turnId });
		const running = await this.#port.turnRunning({
			sessionId: runtime.sessionId,
			repo: runtime.cwd,
			...(tail && connectionEpoch !== undefined ? { relay: tail } : {}),
		});
		if (!this.#writeCurrent(observer) || observer.activityVersion !== activityVersion || running === true) return false;
		if (running === undefined) return undefined;
		// A CLI idle snapshot cannot prove end across an unobserved attachment gap.
		if (!tail || connectionEpoch === undefined || observer.tail !== tail || observer.attaching) return false;
		// Revalidate the same operation after the live snapshot. A late receipt,
		// changed identity, or unknown status is handled by a fresh normal tick.
		const current = await this.#query(runtime, tail);
		if (
			!this.#writeCurrent(observer) ||
			observer.activityVersion !== activityVersion ||
			observer.tail !== tail ||
			observer.attaching !== undefined ||
			tail.connectionEpoch !== connectionEpoch ||
			JSON.stringify(current) !== JSON.stringify(status)
		)
			return false;
		return true;
	}
	/** A cached failed request can outlive its host without ever emitting lifecycle end. */
	async #missingReceiptHostDead(
		observer: Observer,
		runtime: WorkAttemptRuntime,
		status: PromptStatusBody,
	): Promise<boolean> {
		const activityVersion = observer.activityVersion;
		let live: SessionLiveness | undefined;
		try {
			live = await this.#port.liveness?.({ sessionId: runtime.sessionId, repo: runtime.cwd });
		} catch (error) {
			if (error instanceof BrokerAuthorityError) throw error;
		}
		if (!this.#writeCurrent(observer)) return false;
		if (observer.activityVersion !== activityVersion || live?.live !== false || live.disowned) {
			observer.receiptDeadSince = undefined;
			return false;
		}
		observer.receiptDeadSince ??= this.#now();
		if (this.#now() - observer.receiptDeadSince < (this.#options.hostLostGraceMs ?? HOST_LOST_GRACE_MS)) return false;
		let current: PromptStatusBody;
		try {
			current = await this.#query(runtime, observer.tail);
		} catch (error) {
			observer.receiptDeadSince = undefined;
			throw error;
		}
		if (
			!this.#writeCurrent(observer) ||
			observer.activityVersion !== activityVersion ||
			JSON.stringify(current) !== JSON.stringify(status)
		) {
			observer.receiptDeadSince = undefined;
			return false;
		}
		return true;
	}
	async #tick(observer: Observer): Promise<void> {
		if (!this.#writeCurrent(observer)) return;
		let runtime = this.#db.work.workAttemptGet(observer.runtime.opRef)!;
		if (runtime.settledAt) return;
		const unresolvedReceipt = unresolvedTerminalReceipt(runtime.terminal) && runtime.turnEndObservedAt === undefined;
		if (!runtime.terminal || unresolvedReceipt) this.#attach(observer);
		// A saved SDK terminal is still incomplete without execution-end proof.
		// Recovery must refresh it through the same fenced path as a fresh status.
		if (!runtime.terminal || unresolvedReceipt) {
			const activityVersion = observer.activityVersion;
			let status: PromptStatusBody | undefined;
			try {
				status = await this.#query(runtime, observer.tail);
				observer.goneSince = undefined;
			} catch (error) {
				observer.receiptDeadSince = undefined;
				const hostGone = await this.#hostGone(runtime, error);
				// Both status and inspect must belong to one uninterrupted activity
				// epoch. A start during either await cannot seed post-start grace.
				if (!this.#writeCurrent(observer) || observer.activityVersion !== activityVersion) {
					observer.goneSince = undefined;
					return;
				}
				if (!hostGone) {
					observer.goneSince = undefined;
					throw error;
				}
				// A router that is still re-indexing hosts (e.g. just restarted) may
				// briefly disown a live one: require the verdict to persist.
				observer.goneSince ??= this.#now();
				if (this.#now() - observer.goneSince < (this.#options.hostLostGraceMs ?? HOST_LOST_GRACE_MS)) return;
			}
			if (!this.#writeCurrent(observer)) return;
			if (status?.status === "unknown") {
				observer.receiptDeadSince = undefined;
				return;
			}
			if (!status) console.error(`work_host_lost opRef=${runtime.opRef} session=${runtime.sessionId} source=observer`);
			let terminal = status
				? terminalEvidence(status, this.#at())
				: { kind: "local" as const, observedAt: this.#at(), reasonCode: "host_lost" };
			let hostDeathProved = false;
			if (unresolvedReceipt && !terminal) {
				observer.receiptDeadSince = undefined;
				return;
			}
			if (
				unresolvedReceipt &&
				status &&
				(status.clientRef !== runtime.opRef ||
					(["commandId", "turnId"] as const).some(
						(key) => runtime.terminal?.status?.[key] !== undefined && runtime.terminal.status[key] !== status[key],
					) ||
					(!unresolvedTerminalReceipt(terminal) && status.receiptState !== "present"))
			) {
				observer.receiptDeadSince = undefined;
				return;
			}
			if (
				unresolvedTerminalReceipt(terminal) &&
				runtime.turnEndObservedAt === undefined &&
				observer.turnEndObservedAt === undefined
			) {
				const activityVersion = observer.activityVersion;
				const proofTail = observer.tail;
				const proofConnectionEpoch = proofTail?.connectionEpoch;
				const idle = await this.#observeIdleTurnEnd(observer, runtime, status!).catch((error: unknown) => {
					if (error instanceof BrokerAuthorityError) throw error;
					return undefined;
				});
				if (idle !== undefined) observer.receiptDeadSince = undefined;
				if (idle === false) return;
				if (idle === undefined) {
					if (!(await this.#missingReceiptHostDead(observer, runtime, status!))) return;
					hostDeathProved = true;
					// Host death proves execution ended; it cannot replace an SDK failure cause.
					if (status?.status !== "failed")
						terminal = { kind: "local", observedAt: this.#at(), reasonCode: "session_dead" };
				}
				if (observer.activityVersion !== activityVersion) {
					observer.receiptDeadSince = undefined;
					return;
				}
				if (hostDeathProved && terminal?.kind === "broker") observer.turnEndObservedAt ??= this.#at();
				if (idle === true) {
					if (
						!proofTail ||
						observer.tail !== proofTail ||
						observer.attaching ||
						proofConnectionEpoch === undefined ||
						proofTail.connectionEpoch !== proofConnectionEpoch
					)
						return;
					observer.turnEndObservedAt ??= this.#at();
					observer.tail?.setTurnRunning(false);
				}
			} else observer.receiptDeadSince = undefined;
			if (!this.#writeCurrent(observer)) return;
			// Keep saved terminal evidence immutable until output proves a late
			// receipt. A refreshed terminal receipt or confirmed host death can
			// release retrieval, but cannot rewrite the original outcome by itself.
			if (unresolvedReceipt && !unresolvedTerminalReceipt(terminal)) observer.turnEndObservedAt ??= this.#at();
			const turnEndObservedAt = runtime.turnEndObservedAt ?? observer.turnEndObservedAt;
			const patchParts: Array<Partial<WorkAttemptPatch>> = [];
			if (hostDeathProved && terminal?.kind === "broker" && !runtime.terminal)
				patchParts.push({ output: { ...runtime.output, disposition: "unavailable", nextReadAt: null } });
			if (runtime.sendPhase !== "accepted" && status && provesAcceptance(status)) {
				patchParts.push({
					sendPhase: "accepted" as const,
					sendEvidence: runtime.sendEvidence ?? { source: "status" as const, observedAt: this.#at() },
				});
			}
			if (turnEndObservedAt && runtime.turnEndObservedAt === undefined) {
				patchParts.push({ turnEndObservedAt });
			}
			if (terminal && !runtime.terminal) {
				patchParts.push({ terminal });
			}
			const patch = Object.assign({}, ...patchParts);
			runtime =
				(Object.keys(patch).length > 0 ? this.#updateAttempt(runtime.opRef, runtime.version, patch) : undefined) ??
				runtime;
			if (!runtime.terminal) return;
		}
		if (unresolvedTerminalReceipt(runtime.terminal) && runtime.turnEndObservedAt === undefined) {
			const turnEndObservedAt = observer.turnEndObservedAt;
			if (!turnEndObservedAt) return;
			runtime =
				this.#updateAttempt(runtime.opRef, runtime.version, { turnEndObservedAt }) ??
				this.#db.work.workAttemptGet(runtime.opRef) ??
				runtime;
			if (runtime.turnEndObservedAt === undefined) return;
		}
		if (runtime.output.disposition === "pending" && runtime.output.knownSilence) {
			const silent = this.#updateAttempt(runtime.opRef, runtime.version, {
				output: { ...runtime.output, disposition: "silent", nextReadAt: null },
			});
			if (!silent) return;
			runtime = silent;
		}
		if (runtime.output.disposition === "pending") {
			if (runtime.output.nextReadAt && this.#now() < Date.parse(runtime.output.nextReadAt)) return;
			if (runtime.output.reads >= 3 || runtime.terminal?.kind === "local") {
				runtime =
					this.#updateAttempt(runtime.opRef, runtime.version, {
						output: { ...runtime.output, disposition: "unavailable", nextReadAt: null },
					}) ?? runtime;
			} else {
				const reads = runtime.output.reads + 1;
				const claimed = this.#updateAttempt(runtime.opRef, runtime.version, {
					output: {
						...runtime.output,
						reads,
						nextReadAt: reads === 3 ? null : new Date(this.#now() + (reads === 1 ? 1000 : 5000)).toISOString(),
					},
				});
				if (!claimed) return;
				runtime = claimed;
				const result = await this.#port
					.fetchWorkerOutput({
						sessionId: runtime.sessionId,
						repo: runtime.cwd,
						opRef: runtime.opRef,
						notBeforeMs: Math.max(Date.parse(runtime.startedAt), runtime.terminal?.status?.startedAt ?? 0),
						terminalIdentity: runtime.terminal?.status,
						signal: observer.abort.signal,
						isCurrent: () => this.#writeCurrent(observer),
						...(observer.tail ? { relay: observer.tail } : {}),
					})
					.catch(() => ({ status: "absent" as const, code: "transport_error" as const }));
				if (!this.#writeCurrent(observer)) return;
				if (result.status === "proven") {
					const proof = {
						...result.provenance,
						epoch: runtime.epoch,
						observedAtMs: result.observedAtMs,
						attribution: "operation_ref" as const,
					};
					const silent = isSilentOutput(result.text);
					const terminal = runtime.terminal!;
					// A proven original same-op body resolves receipt uncertainty, not
					// execution by inference. Re-derive its actual terminal outcome.
					const reconciled =
						terminal.kind === "broker" && terminal.status !== undefined && unresolvedTerminalReceipt(terminal)
							? terminalEvidence(
									safeStatus({
										...terminal.status,
										...result.terminal,
										// Preserve an existing outcome only for the same terminal
										// status; a deadline failure is superseded, not completion proof.
										outcome:
											result.terminal.outcome ??
											(terminal.status.status === result.terminal.status ? terminal.status.outcome : undefined),
										error: result.terminal.error,
									}),
									terminal.observedAt,
								)
							: undefined;
					const updated = this.#updateAttempt(runtime.opRef, runtime.version, {
						...(reconciled ? { terminal: reconciled } : {}),
						output: {
							...runtime.output,
							disposition: silent ? "silent" : "available",
							nextReadAt: null,
							excerpt: utf8Prefix(result.text),
							proof,
							knownSilence: silent ? proof : null,
						},
					});
					if (!updated) return;
					runtime = updated;
					const call = this.#runCalls.get(runtime.opRef);
					if (call) call.text = result.text;
				} else if (result.status === "unavailable" || reads >= 3) {
					runtime =
						this.#updateAttempt(runtime.opRef, runtime.version, {
							output: { ...runtime.output, disposition: "unavailable", nextReadAt: null },
						}) ?? runtime;
				} else return;
			}
		}
		if (runtime.output.disposition !== "pending") await this.#settle(observer, runtime);
	}
	async #settle(observer: Observer, runtime: WorkAttemptRuntime): Promise<void> {
		const facts = await collectRepoFacts(runtime.cwd, this.#gitTimeouts(), this.#options.checkStatusClient);
		const result = await this.#port.runExclusive(runtime.sessionKey, async () => {
			if (!this.#writeCurrent(observer)) return;
			const current = this.#db.work.workAttemptGet(runtime.opRef);
			if (!current || current.version !== runtime.version || current.settledAt) return;
			const name = runtime.sessionKey.slice("work/task/".length);
			const at = this.#at();
			const reason = runtime.terminal?.reasonCode ?? "unknown";
			// Preserve bounded transport diagnostics independently of the classified cause.
			let output = runtime.output;
			if (
				(["sdk_failed", "provider_transport", "prompt_deadline_exceeded"].includes(reason) ||
					unresolvedTerminalReceipt(runtime.terminal)) &&
				output.disposition === "unavailable" &&
				!output.transportCause
			) {
				try {
					const terminalAt = runtime.terminal?.status?.terminalAt ?? Date.parse(runtime.terminal?.observedAt ?? "");
					if (Number.isFinite(terminalAt)) {
						const input = {
							sessionId: runtime.sessionId,
							repo: runtime.cwd,
							startedAtMs: Date.parse(runtime.startedAt),
							terminalAtMs: terminalAt,
						};
						// Try port method first (for testing), then file-based reader
						let cause = await this.#port.failedTransportCause?.(input);
						if (!cause) {
							cause = await readFailedTransportCause(undefined, input);
						}
						if (cause) {
							output = { ...output, transportCause: cause };
							const parts = [`kind=${cause.kind}`];
							if (cause.nativeErrorCode) parts.push(`nativeErrorCode=${cause.nativeErrorCode}`);
							if (cause.http2RstCode !== undefined) parts.push(`http2RstCode=${cause.http2RstCode}`);
							if (cause.status !== undefined) parts.push(`status=${cause.status}`);
							console.error(`work_transport_failure opRef=${runtime.opRef} ${parts.join(" ")}`);
						}
					}
				} catch (error) {
					console.error(`work_transport_cause_read_error opRef=${runtime.opRef} reason=${failureReason(error)}`);
				}
			}
			// Diagnostics may suspend while shutdown, generation recovery or a
			// binding change revokes this observer without changing runtime.version.
			if (!this.#writeCurrent(observer)) return;
			const endState = workAttemptEndState(reason);
			let job = closeAttempt({
				record: this.#job(name, true)!,
				opRef: runtime.opRef,
				endState,
				errorCode: reason === "end_turn" ? undefined : reason,
				endedAt: at,
			});
			if (facts) {
				const progressed = hasNewCommit({
					...facts,
					observedAt: at,
					knownCheckpoints: job.checkpoints,
					baselineSha: job.baselineSha,
				});
				job = applyReconciliation({
					record: job,
					repository: { ...facts, observedAt: at },
					classification: progressed ? "progressed" : endState === "completed" ? "held" : "stalled",
				});
			}
			if (endState === "completed") {
				const checks = facts?.checkStatus;
				const previousCycle = job.awaitingChecks;
				if (previousCycle !== undefined) {
					job = transitionToAwaitingChecks({
						record: job,
						at,
						prNumber: previousCycle.prNumber ?? (facts?.pushed !== false ? (checks?.prNumber ?? null) : null),
						headSha: facts?.pushed === true && facts.headSha !== undefined ? facts.headSha : previousCycle.headSha,
					});
				} else if (facts?.headSha && checks) {
					job = transitionToAwaitingChecks({
						record: job,
						at,
						prNumber: checks.prNumber,
						headSha: facts.headSha,
					});
				} else if (
					facts?.headSha &&
					facts.branch &&
					facts.branch !== "HEAD" &&
					facts.pushed !== false &&
					checks === undefined &&
					this.#options.checkStatusClient
				) {
					job = transitionToAwaitingChecks({ record: job, at, prNumber: null, headSha: facts.headSha });
				}
				if (
					job.state === "awaiting_checks" &&
					checks?.status === "green" &&
					(job.awaitingChecks?.prNumber === null || job.awaitingChecks?.prNumber === checks.prNumber) &&
					(checks.prState === "open" || checks.merged === true) &&
					checks.headSha === facts?.headSha
				)
					job = settleAwaitingChecks(job, at, { kind: "passed" });
			}
			if (job.state !== "awaiting_checks") job = clearAwaitingChecks(job);

			const text = reportText(name, endState, reason, runtime.opRef, output, facts, runtime.terminal?.status);
			let decision: "report" | "suppressed" | "no_target" | "wake_unaccepted";
			let admission: WorkAttemptAdmission | undefined;
			if (runtime.wakeReportId !== null && !hasAcceptanceEvidence(runtime)) {
				decision = "wake_unaccepted";
			} else if (runtime.output.knownSilence !== null) {
				decision = "suppressed";
			} else if (runtime.parent === null) {
				decision = "no_target";
			} else {
				decision = "report";
				if (runtime.parent.kind === "persona") {
					const fallbackPayload = buildDeliveryPayload(runtime.opRef, runtime.parent.origin, text, runtime.deliveryId)!;
					const holdReason = this.#options.personaHold?.(runtime.parent.originKey);
					admission = {
						kind: "persona",
						row: {
							messageId: runtime.reportId,
							originKey: runtime.parent.originKey,
							originRefJson: JSON.stringify(runtime.parent.origin),
							body: text,
							receivedAt: at,
						},
						fallbackPayload,
						...(holdReason ? { holdReason } : {}),
					};
				} else {
					const root = runtime.parent.root;
					admission = {
						kind: "lane",
						report: {
							reportId: runtime.reportId,
							parentName: runtime.parent.name,
							childName: name,
							childOpRef: runtime.opRef,
							body: text,
							root,
						},
						fallbackPayload: root
							? (buildDeliveryPayload(runtime.opRef, root.origin, text, runtime.deliveryId) ?? null)
							: null,
					};
				}
			}
			const settled = this.#settleAttempt(
				runtime.opRef,
				runtime.version,
				job,
				{ decision, settledAt: at, ...(output !== runtime.output ? { output } : {}) },
				admission,
			);

			if (!settled) return undefined;
			this.#finishWaiters(runtime.opRef);
			return settled;
		});

		if (result) {
			const settled = result.runtime;
			const parentLabel =
				settled.parent?.kind === "persona"
					? settled.parent.originKey
					: settled.parent?.kind === "lane"
						? `lane:${settled.parent.name}`
						: "none";
			console.error(`work_report decision=${settled.decision} parent=${parentLabel} reportId=${settled.reportId}`);
			if (settled.parent?.kind === "lane" && settled.decision === "reported")
				console.error(
					`lane_report_transition id=${settled.reportId} parent=${settled.parent.name} from=none to=pending reason=admitted`,
				);
			if (settled.parent?.kind === "lane" && settled.decision === "fallback")
				console.error(`lane_report_fallback id=${settled.reportId} parent=${settled.parent.name}`);
			if (settled.parent?.kind === "lane" && settled.decision === "no_target")
				console.error(`lane_report_undeliverable id=${settled.reportId} parent=${settled.parent.name}`);
			if (settled.decision === "wake_unaccepted") {
				const child = this.#db.work.laneReportGet(settled.wakeReportId!)!;
				const outcome = ["fallback", "undeliverable", "pending"].includes(child.state) ? "refused" : "ambiguous";
				console.error(
					`work_report decision=wake_unaccepted reportId=${settled.wakeReportId} childReportId=${child.report_id} outcome=${outcome}`,
				);
			}
			for (const payload of [result.fallbackPayload, result.childFallback]) {
				if (!payload) continue;
				try {
					this.#options.deliverFallback?.(payload);
				} catch {
					console.error(`work_fallback_delivery_failed deliveryId=${payload.deliveryId}`);
				}
			}
			if (settled.decision === "reported" && settled.parent?.kind === "persona") {
				try {
					this.#options.notifyPersona?.(settled.parent.originKey);
				} catch {
					console.error(`work_persona_nudge_failed origin=${settled.parent.originKey}`);
				}
			}
			const drain = async (parentName: string) => {
				try {
					await this.#drainLaneReports(parentName);
				} catch {
					console.error(`lane_report_drain_failed parent=${parentName}`);
				}
			};
			if (settled.parent?.kind === "lane") await drain(settled.parent.name);
			await drain(settled.sessionKey.slice("work/task/".length));
			if (result.requeuedParent) await drain(result.requeuedParent);
		}
		if (this.#current(observer) && this.#db.work.workAttemptGet(runtime.opRef)?.settledAt) {
			observer.tail?.setTurnRunning(false);
			await this.#disposeObserver(observer);
			if (this.#observers.get(runtime.opRef) === observer) this.#observers.delete(runtime.opRef);
			this.#failures.delete(runtime.opRef);
		}
	}
	#finishWaiters(opRef: string): void {
		for (const waiter of [...(this.#waiters.get(opRef) ?? [])]) waiter.finish();
	}
	/**
	 * Drives every awaiting_checks lane one step (#481): red re-steers the lane
	 * (bounded), green settles it done, a third red settles it failed, and a
	 * timeout, closed PR or moved HEAD settles it with that reason. Checks that
	 * are temporarily unavailable keep it waiting.
	 */
	async #pollAwaitingChecks(): Promise<void> {
		const client = this.#options.checkStatusClient;
		if (this.#stopped || !client) return;
		const rows = this.#db.work
			.laneJobRows()
			.filter((row) => row.state === "awaiting_checks" && row.lane_key.startsWith("work-"));
		for (let offset = 0; offset < rows.length && !this.#stopped; offset += AWAITING_CHECKS_POLL_CONCURRENCY) {
			const batch = rows.slice(offset, offset + AWAITING_CHECKS_POLL_CONCURRENCY);
			await Promise.all(
				batch.map(async (row) => {
					try {
						await this.#pollLaneChecks(row.lane_key.slice("work-".length), client);
					} catch (error) {
						console.error(`awaiting_checks_poll_error jobId=${row.job_id} reason=${failureReason(error)}`);
					}
				}),
			);
		}
	}
	async #pollLaneChecks(name: string, client: CheckStatusClient): Promise<void> {
		const observed = this.#job(name);
		const cycle = observed?.awaitingChecks;
		if (observed?.state !== "awaiting_checks" || !cycle) return;
		const facts = await collectRepoFacts(
			observed.lane.worktreePath,
			this.#gitTimeouts(),
			client,
			true,
			cycle.headSha,
			cycle.prNumber ?? undefined,
		);
		const effects = await this.#port.runExclusive(workSessionKey(name), async () => {
			if (this.#stopped) return undefined;
			let job = this.#job(name);
			// Another writer moved the lane on while the checks were read.
			const currentCycle = job?.awaitingChecks;
			if (
				!job ||
				job.state !== "awaiting_checks" ||
				!currentCycle ||
				currentCycle.since !== cycle.since ||
				currentCycle.prNumber !== cycle.prNumber ||
				currentCycle.headSha !== cycle.headSha ||
				currentCycle.retries !== cycle.retries
			)
				return undefined;
			if (currentCycle.prNumber === null && facts?.checkStatus) {
				job = transitionToAwaitingChecks({
					record: job,
					at: this.#at(),
					prNumber: facts.checkStatus.prNumber,
					headSha: currentCycle.headSha,
				});
				this.#putJob(name, job);
			}
			const activeCycle = job.awaitingChecks!;
			const outcome = checksOutcome(activeCycle, facts, this.#now());
			if (outcome.kind === "wait") return undefined;
			if (outcome.kind === "red") {
				if (activeCycle.prNumber === null) return undefined;
				if (activeCycle.retries < AWAITING_CHECKS_RETRY_LIMIT) {
					await this.#resteerRedChecks(name, job, outcome.failingChecks, outcome.failureLogTail);
					return undefined;
				}
				return this.#settleChecks(
					name,
					job,
					{
						kind: "failed",
						reason: `checks=red(${outcome.failingChecks.join(",")}) after ${activeCycle.retries} re-steers`,
					},
					facts,
				);
			}
			return this.#settleChecks(name, job, outcome, facts);
		});
		if (!effects) return;
		await this.#dispatchChecksEffects(effects);
	}
	async #dispatchChecksEffects(effects: ChecksReportEffects): Promise<void> {
		if (effects.fallback) {
			try {
				this.#options.deliverFallback?.(effects.fallback);
			} catch {
				console.error(`work_fallback_delivery_failed deliveryId=${effects.fallback.deliveryId}`);
			}
		}
		if (effects.persona) {
			try {
				this.#options.notifyPersona?.(effects.persona);
			} catch {
				console.error(`work_persona_nudge_failed origin=${effects.persona}`);
			}
		}
		if (effects.laneParent) await this.#drainLaneReports(effects.laneParent);
	}
	/** Spends one retry, then continues the lane's session with the failing check names. */
	async #resteerRedChecks(
		name: string,
		job: LaneJobRecord,
		failingChecks: readonly string[],
		failureLogTail?: string,
	): Promise<void> {
		const cycle = job.awaitingChecks!;
		if (cycle.prNumber === null) throw new Error("cannot re-steer before discovering the open PR");
		const counted = recordChecksRetry(job, this.#at());
		this.#putJob(name, counted);
		const retries = counted.awaitingChecks!.retries;
		const names = failingChecks.length > 0 ? failingChecks.join(", ") : "unnamed checks";
		const log = failureLogTail ? `\nFailed log tail:\n${utf8Prefix(sanitizeDiagnostic(failureLogTail), 3_200)}` : "";
		const text = `PR #${cycle.prNumber} checks failed on ${cycle.headSha.slice(0, 12)}: ${names}. Fix the failures, commit and push again (re-steer ${retries}/${AWAITING_CHECKS_RETRY_LIMIT}).${log}`;
		const last = job.attempts.at(-1);
		const parent = last ? (this.#attemptByOpRef(last.opRef)?.parent ?? null) : null;
		try {
			await this.#startLocked({ name, text, cwd: job.lane.worktreePath, resume: false }, "start", {
				parent,
				checksRetry: true,
			});
			console.error(`awaiting_checks_resteered jobId=${job.jobId} pr=${cycle.prNumber} retry=${retries}`);
		} catch (error) {
			// The retry stays spent, so a lane that cannot be re-steered still reaches its bound.
			console.error(`awaiting_checks_resteer_failed jobId=${job.jobId} reason=${failureReason(error)}`);
		}
	}
	/** Settles the checks cycle and admits the outcome report to the lane's parent in one transaction. */
	#settleChecks(
		name: string,
		job: LaneJobRecord,
		outcome: ChecksSettlement,
		facts: Awaited<ReturnType<typeof collectRepoFacts>>,
		at = this.#at(),
	): ChecksReportEffects {
		const cycle = job.awaitingChecks!;
		const settled = settleAwaitingChecks(job, at, outcome);
		const last = job.attempts.at(-1);
		const runtime = last ? this.#attemptByOpRef(last.opRef) : undefined;
		const parent = runtime?.output.knownSilence === null ? runtime.parent : null;
		const text = checksReportText(name, cycle, outcome, facts);
		const reportRef = newOpRef(`checks-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
		const reportId = workAttemptReportId(this.#db.instanceId, job.jobId, reportRef);
		const deliveryId = workAttemptDeliveryId(this.#db.instanceId, job.jobId, reportRef);
		const effects = this.#db.transaction((tx): ChecksReportEffects => {
			this.#putJob(name, settled, tx);
			if (parent?.kind === "persona") {
				const refused =
					Boolean(this.#options.personaHold?.(parent.originKey)) ||
					this.#db.bindings.getSessionRecord(parent.originKey) === undefined;
				if (!refused) {
					workAssert(
						this.#db.inbox.enqueue(tx, {
							messageId: reportId,
							originKey: parent.originKey,
							originRefJson: resolveLaneReportOrigin(parent, JSON.stringify(parent.origin)),
							body: text,
							receivedAt: at,
							source: "lane_report",
						}),
					);
					return { persona: parent.originKey };
				}
				return { fallback: this.#enqueueFallback(tx, reportRef, parent.origin, text, deliveryId) };
			}
			if (parent?.kind === "lane") {
				if (this.#db.work.laneParentAvailable(parent.name)) {
					this.#db.work.laneReportInsert(
						tx,
						{
							reportId,
							parentName: parent.name,
							childName: name,
							childOpRef: reportRef,
							body: text,
							root: parent.root,
						},
						at,
					);
					return { laneParent: parent.name };
				}
				if (parent.root)
					return { fallback: this.#enqueueFallback(tx, reportRef, parent.root.origin, text, deliveryId) };
			}
			return {};
		});
		console.error(
			`awaiting_checks_settled jobId=${job.jobId} pr=${cycle.prNumber} outcome=${outcome.kind}${outcome.kind === "passed" ? "" : ` reason=${outcome.reason}`}`,
		);
		return effects;
	}
	#enqueueFallback(
		tx: WriteTx,
		turnId: string,
		origin: OriginRef,
		text: string,
		deliveryId: string,
	): ChatMessagePayload {
		const payload = buildDeliveryPayload(turnId, origin, text, deliveryId)!;
		this.#db.outbox.enqueue(tx, {
			deliveryId,
			turnId,
			originKey: originKey(origin),
			payloadJson: JSON.stringify(payload),
		});
		return payload;
	}
	#putJob(name: string, job: LaneJobRecord, tx?: WriteTx): void {
		const write = (inner: WriteTx) =>
			this.#db.work.putLaneJob(inner, { ...job, laneKey: laneJobIdentity(name).laneKey, json: JSON.stringify(job) });
		if (tx) write(tx);
		else this.#db.transaction(write);
	}
	async #drainLaneReports(parentName: string): Promise<void> {
		if (this.#stopped) return;
		await this.#port.runExclusive(workSessionKey(parentName), async () => {
			if (this.#stopped) return;
			let job: LaneJobRecord | undefined;
			let unavailable = this.#db.bindings.isQuarantined("work", laneJobIdentity(parentName).jobId);
			if (!unavailable) {
				try {
					job = this.#job(parentName, true);
				} catch {
					unavailable = true;
				}
			}
			for (let row of this.#db.work.laneReportsByParent(parentName)) {
				if (this.#stopped) return;
				if (["consumed", "fallback", "undeliverable"].includes(row.state)) continue;
				if (unavailable || !job) {
					await this.#resolveUnavailableLaneReport(row);
					continue;
				}
				if (row.state === "held") {
					if (row.claim_kind === "wake") {
						const runtime = this.#attemptByOpRef(row.claim_ref);
						if (
							runtime &&
							hasAcceptanceEvidence(runtime) &&
							this.#reportMutation((tx) => this.#db.work.laneReportConsume(tx, row.report_id, row.claim_ref!))
						)
							this.#logLaneReportTransition(row, "held", "consumed", "wake_acceptance_proven");
					} else if (row.claim_kind === "steer") {
						await this.#replayLaneSteer(row, job);
					}
					continue;
				}
				if (row.state === "claimed" && row.claim_kind === "wake") {
					if (this.#attemptByOpRef(row.claim_ref)) continue;
					const open = job.attempts.find((attempt) => attempt.endedAt === undefined);
					if (open) {
						if (!this.#reportMutation((tx) => this.#db.work.laneReportRequeue(tx, row.report_id, row.claim_ref!)))
							continue;
						this.#logLaneReportTransition(row, "claimed", "pending", "wake_unprepared_parent_open");
						row = this.#db.work.laneReportGet(row.report_id)!;
					} else if (job.state === "awaiting_checks" || job.state === "done") {
						if (!this.#reportMutation((tx) => this.#db.work.laneReportRequeue(tx, row.report_id, row.claim_ref!)))
							continue;
						this.#logLaneReportTransition(row, "claimed", "pending", "wake_parent_parked");
						this.#fallbackLaneReport(
							this.#db.work.laneReportGet(row.report_id)!,
							job.state === "done" ? "parent_done" : "parent_awaiting_checks",
						);
						continue;
					} else {
						await this.#wakeLaneReport(row, job);
						try {
							job = this.#job(parentName, true);
						} catch {
							unavailable = true;
							job = undefined;
						}
						continue;
					}
				}
				if (row.state === "claimed" && row.claim_kind === "steer") {
					await this.#replayLaneSteer(row, job);
					continue;
				}
				if (row.state !== "pending") continue;
				if (job.state === "aborted") {
					this.#fallbackLaneReport(row, "parent_aborted");
					continue;
				}
				const open = job.attempts.find((attempt) => attempt.endedAt === undefined);
				if (open) {
					const runtime = this.#attemptByOpRef(open.opRef);
					if (runtime && !runtime.terminal && this.#binding(runtime))
						await this.#claimAndSteerLaneReport(row, job, runtime);
					continue;
				}
				if (job.state === "awaiting_operator" || job.state === "stalled") {
					this.#fallbackLaneReport(row, "parent_held");
					continue;
				}
				if (job.state === "awaiting_checks" || job.state === "done") {
					this.#fallbackLaneReport(row, job.state === "done" ? "parent_done" : "parent_awaiting_checks");
					continue;
				}
				await this.#wakeLaneReport(row, job);
				try {
					job = this.#job(parentName, true);
				} catch {
					unavailable = true;
					job = undefined;
				}
			}
		});
	}

	#attemptByOpRef(opRef: string | null): WorkAttemptRuntime | undefined {
		if (opRef === null) return undefined;
		try {
			return this.#db.work.workAttemptGet(opRef);
		} catch {
			return undefined;
		}
	}

	#reportRoot(row: LaneReportRow): WorkReportRoot | null {
		return row.root_json === null ? null : (JSON.parse(row.root_json) as WorkReportRoot);
	}

	#laneReportText(row: LaneReportRow): string {
		return `[Report from child work lane ${row.child_name}; not from a human. Integrate it into your task; your own final answer still goes to your parent.]\n\n${row.body}`;
	}

	#laneFallbackPayload(row: LaneReportRow): ChatMessagePayload | undefined {
		const root = this.#reportRoot(row);
		if (root === null) return undefined;
		const { jobId } = laneJobIdentity(row.child_name);
		return buildDeliveryPayload(
			row.child_op_ref,
			root.origin,
			row.body,
			workAttemptDeliveryId(this.#db.instanceId, jobId, row.child_op_ref),
		);
	}

	#logLaneReportTransition(row: LaneReportRow, from: string, to: string, reason: string): void {
		console.error(
			`lane_report_transition id=${row.report_id} parent=${row.parent_name} from=${from} to=${to} reason=${reason}`,
		);
	}

	#fallbackLaneReport(row: LaneReportRow, reason: string): void {
		const payload = this.#laneFallbackPayload(row);
		if (payload === undefined) {
			if (this.#reportMutation((tx) => this.#db.work.laneReportUndeliverable(tx, row.report_id)))
				this.#logLaneReportTransition(row, row.state, "undeliverable", reason);
			return;
		}
		const committed = this.#db.transaction((tx) => {
			if (!this.#db.work.laneReportFallback(tx, row.report_id, payload)) return false;
			workAssert(typeof payload.deliveryId === "string");
			this.#db.outbox.enqueue(tx, {
				deliveryId: payload.deliveryId,
				turnId: payload.turnId,
				originKey: originKey(payload.origin),
				payloadJson: JSON.stringify(payload),
			});
			return true;
		});
		if (!committed) return;
		this.#logLaneReportTransition(row, row.state, "fallback", reason);
		try {
			this.#options.deliverFallback?.(payload);
		} catch {
			console.error(`work_fallback_delivery_failed deliveryId=${payload.deliveryId}`);
		}
	}

	#resolveUnavailableLaneReport(row: LaneReportRow): void {
		if (row.state === "pending") {
			this.#fallbackLaneReport(row, "parent_quarantined");
			return;
		}
		if (row.state === "held") {
			if (row.claim_kind === "wake") {
				const runtime = this.#attemptByOpRef(row.claim_ref);
				if (
					runtime &&
					hasAcceptanceEvidence(runtime) &&
					this.#reportMutation((tx) => this.#db.work.laneReportConsume(tx, row.report_id, row.claim_ref!))
				)
					this.#logLaneReportTransition(row, "held", "consumed", "wake_acceptance_proven");
			}
			return;
		}
		if (row.state !== "claimed") return;
		if (row.claim_kind === "wake" && !this.#attemptByOpRef(row.claim_ref)) {
			if (!this.#reportMutation((tx) => this.#db.work.laneReportRequeue(tx, row.report_id, row.claim_ref!))) return;
			this.#logLaneReportTransition(row, "claimed", "pending", "wake_unprepared_parent_quarantined");
			this.#fallbackLaneReport(this.#db.work.laneReportGet(row.report_id)!, "parent_quarantined");
			return;
		}
		if (this.#reportMutation((tx) => this.#db.work.laneReportHold(tx, row.report_id, "parent_quarantined_ambiguous")))
			this.#logLaneReportTransition(row, "claimed", "held", "parent_quarantined_ambiguous");
	}

	async #claimAndSteerLaneReport(row: LaneReportRow, job: LaneJobRecord, runtime: WorkAttemptRuntime): Promise<void> {
		const claimSeq = row.claim_seq + 1;
		const clientRef = laneSteerClientRef(row.report_id, claimSeq);
		const claimed = this.#reportMutation((tx) =>
			this.#db.work.laneReportClaim(tx, row.report_id, "steer", clientRef, runtime.opRef),
		);
		if (!claimed) return;
		this.#logLaneReportTransition(row, "pending", "claimed", "steer_claimed");
		await this.#sendLaneSteer(claimed, job, runtime);
	}

	async #replayLaneSteer(row: LaneReportRow, job: LaneJobRecord): Promise<void> {
		const runtime = this.#attemptByOpRef(row.claim_target_op_ref);
		if (!runtime) {
			if (this.#reportMutation((tx) => this.#db.work.laneReportHold(tx, row.report_id, "steer_acceptance_uncertain")))
				this.#logLaneReportTransition(row, row.state, "held", "steer_acceptance_uncertain");
			return;
		}
		await this.#sendLaneSteer(row, job, runtime);
	}

	async #sendLaneSteer(row: LaneReportRow, job: LaneJobRecord, runtime: WorkAttemptRuntime): Promise<void> {
		const clientRef = row.claim_ref!;
		try {
			await this.#port.steer({
				sessionId: runtime.sessionId,
				repo: job.lane.worktreePath,
				text: this.#laneReportText(row),
				clientRef,
			});
			if (this.#reportMutation((tx) => this.#db.work.laneReportConsume(tx, row.report_id, clientRef)))
				this.#logLaneReportTransition(row, row.state, "consumed", "steer_accepted");
		} catch (error) {
			if (definitiveSteerRefusal(error)) {
				if (safeRefusal(error) === "session_not_found") {
					if (
						this.#reportMutation((tx) => this.#db.work.laneReportHold(tx, row.report_id, "steer_acceptance_uncertain"))
					)
						this.#logLaneReportTransition(row, row.state, "held", "steer_acceptance_uncertain");
					return;
				}
				if (this.#reportMutation((tx) => this.#db.work.laneReportRequeue(tx, row.report_id, clientRef)))
					this.#logLaneReportTransition(row, row.state, "pending", "steer_refused");
				return;
			}
			console.error(`lane_report_steer_hold id=${row.report_id} parent=${row.parent_name} clientRef=${clientRef}`);
		}
	}

	async #wakeLaneReport(row: LaneReportRow, job: LaneJobRecord): Promise<void> {
		let claimed = row;
		let opRef = row.claim_ref;
		if (row.state === "pending") {
			opRef = laneWakeOpRef(row.parent_name, row.report_id, row.claim_seq + 1);
			const result = this.#reportMutation((tx) =>
				this.#db.work.laneReportClaim(tx, row.report_id, "wake", opRef!, null),
			);
			if (!result) return;
			claimed = result;
			this.#logLaneReportTransition(row, "pending", "claimed", "wake_claimed");
		}
		if (!opRef || claimed.claim_kind !== "wake" || claimed.claim_ref !== opRef) return;
		const last = job.attempts.at(-1);
		const inheritedParent = last ? (this.#attemptByOpRef(last.opRef)?.parent ?? null) : null;
		try {
			const outcome = await this.#startLocked(
				{
					name: row.parent_name,
					text: this.#laneReportText(row),
					cwd: job.lane.worktreePath,
					resume: false,
				},
				"start",
				{ parent: inheritedParent, opRef, wakeReportId: row.report_id },
			);
			if (outcome.started) return;
		} catch {
			if (this.#attemptByOpRef(opRef)) return;
		}
		if (this.#attemptByOpRef(opRef)) return;
		const fresh = this.#db.work.laneReportGet(row.report_id);
		if (!fresh || fresh.state !== "claimed") return;
		if (!this.#reportMutation((tx) => this.#db.work.laneReportRequeue(tx, row.report_id, opRef))) return;
		this.#logLaneReportTransition(fresh, "claimed", "pending", "wake_unprepared");
		const parentJob = this.#job(row.parent_name);
		if (parentJob?.state === "awaiting_operator" || parentJob?.state === "stalled") {
			this.#fallbackLaneReport(this.#db.work.laneReportGet(row.report_id)!, "parent_held");
		} else if (parentJob?.state === "awaiting_checks" || parentJob?.state === "done") {
			this.#fallbackLaneReport(
				this.#db.work.laneReportGet(row.report_id)!,
				parentJob.state === "done" ? "parent_done" : "parent_awaiting_checks",
			);
		}
	}

	/** Registers recovery work, never waits for a worker's terminal transition. */
	recover(): Promise<void> {
		if (this.#stopped) return Promise.resolve();
		if (this.#generationRecovery) return this.#generationRecovery;
		if (this.#recovery) return this.#recovery;
		const recovery = this.#recover().finally(() => {
			if (this.#recovery === recovery) this.#recovery = undefined;
		});
		this.#recovery = recovery;
		return recovery;
	}
	async #recover(): Promise<void> {
		for (const row of this.#db.work.laneJobRows()) {
			if (this.#stopped) return;
			if (!row.lane_key.startsWith("work-")) continue;
			const name = row.lane_key.slice(5);
			await this.#port.runExclusive(workSessionKey(name), async () => {
				if (this.#stopped) return;
				let job: LaneJobRecord | undefined;
				try {
					job = this.#job(name);
				} catch {
					return;
				}
				const open = job?.attempts.find((attempt) => attempt.endedAt === undefined);
				if (!job || !open || this.#db.work.workAttemptGet(open.opRef)) return;
				this.#prepareAttempt(
					makeRuntime(
						this.#db,
						name,
						open.sessionId,
						this.#db.bindings.getSessionRecord(workSessionKey(name))?.epoch ?? 0,
						job.lane.worktreePath,
						open.startedAt,
						open.opRef,
						"historical",
						null,
						null,
					),
					job,
				);
			});
		}
		const reportedInvalidAttempts = new Set<string>();
		let after = "";
		while (!this.#stopped) {
			let invalidAfter = after;
			const rows = this.#db.work.workAttemptOpen(100, after, (error, jobId) => {
				if (error.opRef && error.opRef > invalidAfter) invalidAfter = error.opRef;
				// Log and quarantine the invalid attempt once, excluding it from future recovery sweeps (issue #407)
				if (error.opRef && !reportedInvalidAttempts.has(error.opRef)) {
					console.error(
						`work_recovery_invalid_attempt opRef=${JSON.stringify(error.opRef)} assertion=${error.assertion}`,
					);
					reportedInvalidAttempts.add(error.opRef);
					// Quarantine the job to exclude it from future recovery iterations
					this.#db.transaction((tx) => this.#db.bindings.quarantineInvalidWork(tx, jobId));
				}
			});
			const lastValid = rows.at(-1)?.opRef ?? after;
			const nextAfter = invalidAfter > lastValid ? invalidAfter : lastValid;
			if (!rows.length && nextAfter === after) break;
			for (const runtime of rows) {
				const prior = this.#observers.get(runtime.opRef);
				if (prior && this.#writeCurrent(prior)) continue;
				if (prior) {
					const disposal = this.#disposeObserver(prior);
					await prior.task;
					await disposal;
				}
				if (this.#stopped) return;
				const observer = this.#register(runtime);
				if (runtime.terminal) {
					this.#schedule(observer, 0);
					continue;
				}
				let status: PromptStatusBody | undefined;
				let statusError: unknown;
				try {
					status = await this.#query(runtime, observer.tail);
				} catch (error) {
					/* Liveness decides whether authority can be recovered. */
					statusError = error;
				}
				if (!this.#current(observer)) continue;
				if (status?.status === "unknown" && this.#port.promptRefusal) {
					// Serialize with live send/retry owners. Unknown alone is never a
					// rejection: only the port's durable non-admission proof may end it.
					const rejected = await this.#port.runExclusive(runtime.sessionKey, async () => {
						const latest = this.#db.work.workAttemptGet(runtime.opRef);
						if (!this.#writeCurrent(observer) || !latest || latest.terminal || hasAcceptanceEvidence(latest))
							return false;
						try {
							if (
								this.#port.promptRefusal?.({ sessionId: latest.sessionId, repo: latest.cwd, opRef: latest.opRef }) !==
								"busy"
							)
								return false;
						} catch {
							return false; // Unavailable refusal evidence remains unknown.
						}
						return (
							this.#updateAttempt(latest.opRef, latest.version, {
								terminal: { kind: "local", observedAt: this.#at(), reasonCode: "send_rejected" },
							}) !== undefined
						);
					});
					if (rejected) {
						this.#schedule(observer, 0);
						continue;
					}
					if (!this.#current(observer)) continue;
				}
				const terminal = status && terminalEvidence(status, this.#at());
				const terminalStillRunning = unresolvedTerminalReceipt(terminal) && runtime.turnEndObservedAt === undefined;
				if (terminal && !terminalStillRunning && this.#writeCurrent(observer)) {
					this.#updateAttempt(runtime.opRef, runtime.version, {
						...(provesAcceptance(status!)
							? {
									sendPhase: "accepted" as const,
									sendEvidence: runtime.sendEvidence ?? { source: "status" as const, observedAt: this.#at() },
								}
							: {}),
						terminal,
					});
					this.#schedule(observer, 0);
					continue;
				}
				// Restart/generation recovery must use the same execution proof and
				// continuous-death grace as a live observer, never one inspect verdict.
				if (terminalStillRunning && this.#binding(runtime) && this.#writeCurrent(observer)) {
					this.#attach(observer);
					this.#schedule(observer, 0);
					continue;
				}
				let live: { live: boolean | undefined; disowned: boolean } = { live: undefined, disowned: false };
				try {
					live = (await this.#port.liveness?.({ sessionId: runtime.sessionId, repo: runtime.cwd })) ?? live;
				} catch {
					/* Indeterminate authority is not a replay permit. */
				}
				if (!this.#current(observer)) continue;
				if (live.live === true && !live.disowned && this.#binding(runtime)) {
					this.#attach(observer);
					this.#schedule(observer, 0);
					continue;
				}
				if (this.#writeCurrent(observer)) {
					// The router itself answered session_unavailable for the operation
					// and inspect agrees: the host died with the attempt open.
					const hostLost = isSessionUnavailable(statusError) && (live.disowned || live.live === false);
					if (hostLost)
						console.error(`work_host_lost opRef=${runtime.opRef} session=${runtime.sessionId} source=recovery`);
					this.#updateAttempt(runtime.opRef, runtime.version, {
						terminal: {
							kind: "local",
							observedAt: this.#at(),
							reasonCode: hostLost
								? "host_lost"
								: live.disowned || !this.#binding(runtime)
									? "session_disowned"
									: live.live === false
										? "session_dead"
										: "recovery_indeterminate",
						},
					});
					this.#schedule(observer, 0);
				}
			}
			after = nextAfter;
		}
		if (this.#stopped) return;
		const parents = new Set([
			...this.#db.work.laneReportParentNames(),
			...this.#db.work
				.laneJobRows(true)
				.filter((row) => row.lane_key.startsWith("work-"))
				.map((row) => row.lane_key.slice("work-".length)),
		]);
		for (const parentName of parents) {
			if (this.#stopped) return;
			await this.#drainLaneReports(parentName);
		}
		if (!this.#stopped) await this.#pollAwaitingChecks();
	}
	onBrokerGeneration(): Promise<void> {
		if (this.#generationRecovery) return this.#generationRecovery;
		const prior = this.#recovery;
		const recovery = (async () => {
			await prior;
			let generation: number;
			do {
				generation = this.#options.brokerGeneration?.() ?? 0;
				await this.#detachObservers();
				if (!this.#stopped) await this.#recover();
			} while (!this.#stopped && generation !== (this.#options.brokerGeneration?.() ?? 0));
		})();
		this.#generationRecovery = recovery.finally(() => {
			this.#generationRecovery = undefined;
		});
		this.#recovery = this.#generationRecovery.finally(() => {
			this.#recovery = undefined;
		});
		return this.#recovery;
	}
	#wait(opRef: string, owner: object, signal?: AbortSignal): Promise<void> {
		this.#live();
		if (this.#detachedOwners.has(owner)) throw new ProtocolError("gateway_shutting_down", "gateway is stopping");
		if (signal?.aborted)
			throw new ProtocolError("verb_failed", "work wait detached; attempt remains observable", {
				reasonCode: "work_wait_detached",
			});
		if (this.#db.work.workAttemptGet(opRef)?.settledAt) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const set = this.#waiters.get(opRef) ?? new Set<Waiter>();
			this.#waiters.set(opRef, set);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const abort = () =>
				waiter.finish(
					new ProtocolError("verb_failed", "work wait detached; attempt remains observable", {
						reasonCode: "work_wait_detached",
					}),
				);
			const waiter: Waiter = {
				owner,
				finish: (error) => {
					if (!set.delete(waiter)) return;
					if (!set.size) this.#waiters.delete(opRef);
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", abort);
					error ? reject(error) : resolve();
				},
			};
			set.add(waiter);
			timer = setTimeout(
				() =>
					waiter.finish(
						workError(
							"work wait timed out; attempt remains observable",
							"work_wait_timeout",
							this.#db.work.workAttemptGet(opRef)!,
						),
					),
				this.#options.waitTimeoutMs ?? 30 * 60_000,
			);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
		});
	}
	detachWaiters(owner: object): void {
		this.#detachedOwners.add(owner);
		for (const call of this.#runCalls.values()) if (call.owner === owner) this.#releaseRunCall(call);
		for (const set of this.#waiters.values())
			for (const waiter of [...set])
				if (waiter.owner === owner) waiter.finish(new ProtocolError("gateway_shutting_down", "gateway is stopping"));
	}
	async #detachObservers(): Promise<void> {
		const observers = [...this.#observers.values()];
		await Promise.all(
			observers.map(async (observer) => {
				const disposal = this.#disposeObserver(observer);
				await observer.task;
				await disposal;
			}),
		);
		while (this.#observerDisposals.size) await Promise.all([...this.#observerDisposals]);
		this.#observers.clear();
	}

	stop(): Promise<void> {
		if (this.#stopPromise) return this.#stopPromise;
		this.#stopped = true;
		for (const call of this.#runCalls.values()) this.#releaseRunCall(call);
		for (const set of this.#waiters.values())
			for (const waiter of [...set]) waiter.finish(new ProtocolError("gateway_shutting_down", "gateway is stopping"));
		const lanesStopped = this.#options.lanes.stop();
		this.#stopPromise = (async () => {
			await this.#detachObservers();
			await this.#recovery;
			await lanesStopped;
			owners.delete(this.#db);
		})();
		return this.#stopPromise;
	}
}

export function laneSystemNotice(input: {
	readonly name: string;
	readonly parent: WorkParent | null;
	readonly allowNested: boolean;
}): string {
	const parent =
		input.parent?.kind === "persona"
			? `persona conversation ${input.parent.originKey}`
			: input.parent?.kind === "lane"
				? `work lane ${input.parent.name}`
				: "none (status-only)";
	const nested = input.allowNested ? "allowed" : "refused";
	return [
		`You are work lane ${input.name}.`,
		`Parent: ${parent}.`,
		"Your final answer goes to your parent as an internal report, never to a human.",
		"Never post to chat or use gajaeway chat.",
		`Nested work.start and work.run are ${nested} (work.allowNested=${input.allowNested}).`,
	].join("\n");
}
function makeRuntime(
	db: Store,
	name: string,
	sessionId: string,
	epoch: number,
	cwd: string,
	startedAt: string,
	opRef: string,
	mode: WorkAttemptRuntime["mode"],
	parent: WorkParent | null,
	wakeReportId: string | null,
	noticeHash: string | null = null,
): WorkAttemptRuntime {
	const { jobId, laneKey } = laneJobIdentity(name);
	return {
		jobId,
		laneKey,
		sessionKey: workSessionKey(name),
		sessionId,
		epoch,
		cwd,
		startedAt,
		opRef,
		mode,
		parent: parent ? structuredClone(parent) : null,
		reportId: workAttemptReportId(db.instanceId, jobId, opRef),
		wakeReportId,
		noticeHash,
		sendPhase: mode === "historical" ? "uncertain" : "prepared",
		sendEvidence: null,
		terminal: null,
		output: pendingOutput(),
		deliveryId: workAttemptDeliveryId(db.instanceId, jobId, opRef),
		decision: "undecided",
		settledAt: null,
		version: 0,
	};
}
const WORK_SESSION_PREFIX = "work/task/";
const OWNER_DIRECTIVE_SCOPE = "owner";
const DIRECTIVE_KEY_PREFIX = "work_directive:";
const DIRECTIVE_ID = /^wd-[0-9a-f]{8}$/;
const MAX_DIRECTIVE_CHARS = 2_000;
const MAX_DIRECTIVES_PER_SCOPE = 50;

/** The persona conversation a lane answers to, or `owner` for lanes started outside one. */
function laneDirectiveScope(parent: WorkParent | null): string {
	if (parent?.kind === "persona") return parent.originKey;
	if (parent?.kind === "lane" && parent.root) return parent.root.originKey;
	return OWNER_DIRECTIVE_SCOPE;
}

function directiveApplies(directive: WorkDirective, laneScope: string): boolean {
	return directive.scope === OWNER_DIRECTIVE_SCOPE || directive.scope === laneScope;
}

function directiveText(directives: readonly WorkDirective[], kind: "standing" | "new"): string {
	const lead =
		kind === "new"
			? "[New standing directive from your operator. It overrides your task from now on: follow it before your next tool call, and stop any step that violates it.]"
			: "[Standing directives from your operator. They override anything in the task below; follow them for the whole lane.]";
	return [lead, ...directives.map((directive) => `- (${directive.id}) ${directive.text}`)].join("\n");
}

function invalid(field: string): never {
	throw new ProtocolError("invalid_params", "invalid work parameters", { reasonCode: "invalid_work_params", field });
}
function parseName(params: unknown): string {
	const name = (params as { name?: unknown } | null)?.name;
	if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) invalid("name");
	return name;
}

function laneReportClaimHash(reportId: string, claimSeq: number): string {
	return createHash("sha256").update(`${reportId}|${claimSeq}`).digest("hex");
}

function laneSteerClientRef(reportId: string, claimSeq: number): string {
	return `gw-lr-${laneReportClaimHash(reportId, claimSeq).slice(0, 32)}`;
}

function laneWakeOpRef(parentName: string, reportId: string, claimSeq: number): string {
	const slug = parentName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
	return `gw-work-${slug}-lr-${laneReportClaimHash(reportId, claimSeq).slice(0, 24)}`;
}
function parseInput(params: unknown): WorkInput {
	const inputFields = ["name", "text", "cwd", "repo", "base", "resume", "model", "callerSessionId"];
	const input = params as Record<string, unknown>;
	if (input && typeof input === "object" && !Array.isArray(input))
		for (const field of Object.keys(input)) if (!inputFields.includes(field)) invalid(field);
	const name = parseName(params);
	if (typeof input.text !== "string" || !input.text) invalid("text");
	if (input.cwd !== undefined) {
		if (typeof input.cwd !== "string" || !input.cwd.startsWith("/") || input.cwd.length > 4096) invalid("cwd");
		for (let index = 0; index < input.cwd.length; index++) {
			if (input.cwd.charCodeAt(index) < 32) invalid("cwd");
		}
	}
	let repo: string | undefined;
	if (input.repo !== undefined) {
		if (typeof input.repo !== "string" || !input.repo) invalid("repo");
		if (!isAbsolute(input.repo) && !isGitRemoteUrl(input.repo)) invalid("repo");
		if (isGitRemoteUrl(input.repo)) {
			let url: URL | undefined;
			try {
				url = new URL(input.repo);
			} catch {
				// SCP-style SSH remotes do not use URL userinfo parsing.
			}
			if (url && (url.password || (["https:", "git:"].includes(url.protocol) && url.username))) invalid("repo");
		}
		repo = input.repo;
	}
	let base: string | undefined;
	if (input.base !== undefined) {
		if (typeof input.base !== "string" || !input.base) invalid("base");
		if (repo === undefined)
			throw new ProtocolError("invalid_params", "base requires a repository binding", {
				reasonCode: "base_requires_repo",
			});
		// base can be a branch name, tag, or commit SHA
		base = input.base;
	}
	if (input.resume !== undefined && typeof input.resume !== "boolean") invalid("resume");
	let model: GjcModelSelection | undefined;
	if (input.model !== undefined) {
		if (typeof input.model === "string" && input.model) model = input.model;
		else if (
			input.model &&
			typeof input.model === "object" &&
			!Array.isArray(input.model) &&
			Object.keys(input.model).length === 1 &&
			typeof (input.model as { preset?: unknown }).preset === "string" &&
			(input.model as { preset: string }).preset
		)
			model = { preset: (input.model as { preset: string }).preset };
		else invalid("model");
	}
	let callerSessionId: string | undefined;
	if (input.callerSessionId !== undefined) {
		if (typeof input.callerSessionId !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(input.callerSessionId))
			invalid("callerSessionId");
		callerSessionId = input.callerSessionId;
	}
	return {
		name,
		text: input.text,
		...(input.cwd === undefined ? {} : { cwd: input.cwd as string }),
		...(repo === undefined ? {} : { repo }),
		...(base === undefined ? {} : { base }),
		resume: input.resume === true,
		model,
		...(callerSessionId === undefined ? {} : { callerSessionId }),
	};
}
function workError(
	message: string,
	reasonCode: string,
	runtime: { jobId: string; opRef: string; sessionId: string },
	clientRef?: string,
): ProtocolError {
	return new ProtocolError("verb_failed", message, {
		reasonCode,
		jobId: runtime.jobId,
		opRef: runtime.opRef,
		sessionId: runtime.sessionId,
		...(clientRef ? { clientRef } : {}),
	});
}

type WorkBindFailureCause = "broker_unavailable" | "timeout" | "cwd_rejected" | "epoch_conflict" | "unknown";

function workBindFailureCause(error: unknown): WorkBindFailureCause {
	const message = error instanceof Error ? error.message : String(error);
	if (
		/\b(?:timed out|timeout)\b/i.test(message) ||
		/\bdid not complete within \d+ms\b/i.test(message) ||
		/\bwas created but never became live\b/.test(message)
	)
		return "timeout";
	if (isBrokerUnavailable(error)) return "broker_unavailable";
	if (error instanceof BrokerAuthorityError) {
		if (error.code === "unowned_session") return "cwd_rejected";
		if (error.code === "authority_mismatch" || error.code === "cutover_required") return "epoch_conflict";
	}
	const detail = error instanceof ProtocolError ? workBindErrorRecord(error.detail) : undefined;
	const sdkCode = error instanceof GjcCliError ? envelopeErrorCode(error.details) : undefined;
	const record = workBindErrorRecord(error);
	for (const code of [
		detail?.cause,
		detail?.reasonCode,
		detail?.code,
		error instanceof ProtocolError ? error.code : undefined,
		sdkCode,
		record?.code,
	]) {
		const cause = workBindFailureCauseFromCode(code);
		if (cause) return cause;
	}
	if (/^session bind for .+ epoch \d+ lost to (?:epoch \d+|a concurrent durable epoch change)$/.test(message))
		return "epoch_conflict";
	return "unknown";
}

function workBindFailureCauseFromCode(value: unknown): WorkBindFailureCause | undefined {
	if (typeof value !== "string") return undefined;
	switch (value) {
		case "broker_unavailable":
		case "unavailable":
		case "session_unavailable":
		case "endpoint_stale":
		case "not_found":
			return "broker_unavailable";
		case "timeout":
			return "timeout";
		case "unowned_session":
		case "managed_append_identity_mismatch":
			return "cwd_rejected";
		case "authority_mismatch":
		case "cutover_required":
			return "epoch_conflict";
		default:
			return undefined;
	}
}

function workBindErrorRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function workBindFailureMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return sanitizeDiagnostic(message).replace(/\s+/gu, " ").slice(0, 200) || "unknown";
}

/** Bounded, secret-free error class and message for a log line. */
function failureReason(error: unknown): string {
	const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return sanitizeDiagnostic(text).slice(0, 200) || "unknown";
}
function safeRefusal(error: unknown): string {
	const code =
		error instanceof OpRefRejectedError
			? error.code
			: error instanceof GjcCliError
				? envelopeErrorCode(error.details)
				: undefined;
	return code && refusalCodes.has(code) ? code : "sdk_refused";
}
function definitiveRefusal(error: unknown): boolean {
	return (
		error instanceof OpRefRejectedError ||
		(error instanceof GjcCliError && refusalCodes.has(envelopeErrorCode(error.details) ?? ""))
	);
}
function definitiveSteerRefusal(error: unknown): boolean {
	if (
		error instanceof GjcCliError &&
		error.details &&
		typeof error.details === "object" &&
		(error.details as { refused?: unknown }).refused === true
	)
		return true;
	return definitiveRefusal(error);
}
function safeStatus(status: PromptStatusBody): PromptStatusBody {
	const result: { -readonly [K in keyof PromptStatusBody]: PromptStatusBody[K] } = { status: status.status };
	for (const key of ["commandId", "turnId", "clientRef"] as const) {
		const value = status[key];
		if (value !== undefined) {
			if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value))
				throw new Error("invalid status identity");
			result[key] = value;
		}
	}
	for (const key of ["acceptedAt", "startedAt", "terminalAt"] as const) {
		const value = status[key];
		if (value !== undefined) {
			if (!Number.isFinite(value)) throw new Error("invalid status time");
			result[key] = value;
		}
	}
	if (status.receiptState !== undefined) {
		if (!["absent", "present", "missing", "unknown"].includes(status.receiptState))
			throw new Error("invalid receipt state");
		result.receiptState = status.receiptState;
	}
	if (status.outcome)
		result.outcome = {
			...(status.outcome.reason
				? { reason: reasons.has(status.outcome.reason) ? status.outcome.reason : "stopped_incomplete" }
				: {}),
			...Object.fromEntries(
				(Object.keys(WORK_OUTCOME_TOKENS) as Array<keyof typeof WORK_OUTCOME_TOKENS>)
					.filter((key) => (WORK_OUTCOME_TOKENS[key] as readonly string[]).includes(status.outcome![key] ?? ""))
					.map((key) => [key, status.outcome![key]]),
			),
		};
	if (status.error)
		result.error = {
			code:
				status.error.code === "agent_error" || reasons.has(status.error.code ?? "") ? status.error.code : "sdk_failed",
		};
	return result;
}
/** Called only after #query has validated the operation and client reference. */
function provesAcceptance(status: PromptStatusBody): boolean {
	return (
		status.status === "accepted" ||
		status.status === "in_flight" ||
		((status.status === "terminal_ok" || status.status === "failed") && status.receiptState === "present")
	);
}

/** Bound the leading excerpt without splitting a Unicode scalar. */
export function utf8Prefix(text: string, maxBytes = 2048): string {
	let bytes = 0;
	let end = 0;
	for (const scalar of text) {
		const length = Buffer.byteLength(scalar, "utf8");
		if (bytes + length > maxBytes) break;
		bytes += length;
		end += scalar.length;
	}
	return text.slice(0, end);
}
export type LaneCommit = { readonly sha: string; readonly subject: string; readonly committed_at: string };

/**
 * The lane's HEAD commit (issue #67): the only progress signal that survives an
 * op dying. Null when the worktree yields no commit; never invented. Async so a
 * `work.jobs` over hundreds of lanes never blocks the event loop (#407).
 */
export async function laneLastCommit(worktreePath: string): Promise<LaneCommit | null> {
	try {
		const child = Bun.spawn(["git", "-C", worktreePath, "log", "-1", "--format=%H%x00%cI%x00%s"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		if (exitCode !== 0) return null;
		const [sha, at, subject] = stdout.replace(/\n$/, "").split("\0");
		const committed = Date.parse(at ?? "");
		if (!sha || !/^[0-9a-f]{40}$/.test(sha) || subject === undefined || Number.isNaN(committed)) return null;
		return { sha, subject: utf8Prefix(subject, 256), committed_at: new Date(committed).toISOString() };
	} catch {
		return null;
	}
}

/** HEAD commits for many worktrees: one git call per distinct path, at most `concurrency` at a time. */
export async function laneLastCommits(
	worktreePaths: readonly string[],
	concurrency = 16,
): Promise<Map<string, LaneCommit | null>> {
	const unique = [...new Set(worktreePaths)];
	const result = new Map<string, LaneCommit | null>();
	let next = 0;
	const worker = async () => {
		while (next < unique.length) {
			const path = unique[next++]!;
			result.set(path, await laneLastCommit(path));
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker));
	return result;
}

/** Shapes the complete lane report under the 2048-byte UTF-8 storage budget. */
export function reportText(
	name: string,
	endState: string,
	reason: string,
	opRef: string,
	output: WorkAttemptRuntime["output"],
	facts?: Awaited<ReturnType<typeof collectRepoFacts>>,
	status?: PromptStatusBody,
): string {
	const checks = facts?.checkStatus;
	const checksVerified =
		!facts ||
		checks === null ||
		(checks?.status === "green" &&
			facts.pushed === true &&
			facts.remoteHeadSha === facts.headSha &&
			checks.headSha === facts.remoteHeadSha);
	const label =
		endState === "completed" && checksVerified ? "completed" : endState === "failed" ? "failed" : "attempt_ended";
	const lead = reason === "end_turn" ? "" : `${reason}: `;
	const head = `[lane ${name}] ${label}: ${lead}`;
	let body =
		output.disposition === "unavailable"
			? reason === "terminal_missing_receipt" || status?.receiptState === "missing"
				? `final_response_missing opRef=${opRef}`
				: "output_unavailable"
			: (output.excerpt ?? "");
	// Include transport cause details if present
	if ((reason === "terminal_missing_receipt" || status?.receiptState === "missing") && output.transportCause) {
		const transport = output.transportCause;
		const parts: string[] = [body, `cause=transport`];
		if (transport.nativeErrorCode) parts.push(transport.nativeErrorCode);
		if (transport.http2RstCode !== undefined) parts.push(`http2RstCode=${transport.http2RstCode}`);
		if (transport.status !== undefined) parts.push(`status=${transport.status}`);
		if (transport.requestBytes !== undefined) parts.push(`requestBytes=${transport.requestBytes}`);
		if (transport.retryMaxAttempts !== undefined) parts.push(`retryMaxAttempts=${transport.retryMaxAttempts}`);
		if (transport.endpointClass !== undefined) parts.push(`endpointClass=${transport.endpointClass}`);
		body = parts.join(" ");
	}

	// Reserve the suffix for repository facts so large output excerpts cannot hide check evidence.
	const factsLines: string[] = [];
	if (status?.status === "failed") {
		if (status.receiptState) factsLines.push(`receiptState=${status.receiptState}`);
		if (status.error?.code === "agent_error" || reasons.has(status.error?.code ?? ""))
			factsLines.push(`errorCode=${status.error!.code}`);
		for (const key of Object.keys(WORK_OUTCOME_TOKENS) as Array<keyof typeof WORK_OUTCOME_TOKENS>) {
			const token = status.outcome?.[key];
			if (token && (WORK_OUTCOME_TOKENS[key] as readonly string[]).includes(token)) factsLines.push(`${key}=${token}`);
		}
	}
	if (facts?.headSha) {
		factsLines.push(`head=${facts.headSha.slice(0, 12)}`);
	}
	if (facts?.pushed !== undefined) {
		factsLines.push(`pushed=${facts.pushed === null ? "unknown" : facts.pushed}`);
	}
	if (facts?.remoteHeadSha) {
		factsLines.push(`remoteHead=${facts.remoteHeadSha.slice(0, 12)}`);
	}
	if (facts?.checkStatus) {
		const checkStatus = facts.checkStatus;
		factsLines.push(`pr=${checkStatus.prNumber}`);
		const checkStr =
			checkStatus.status === "green"
				? "checks=green"
				: checkStatus.status === "red"
					? `checks=red(${checkStatus.failingChecks
							.slice(0, 3)
							.map((name) => utf8Prefix(name, 96))
							.join(",")})`
					: "checks=pending";
		factsLines.push(checkStr);
		factsLines.push(`prHead=${checkStatus.headSha.slice(0, 12)}`);
	}
	const factsText = factsLines.join(" ");
	const factsSuffix = factsText ? ` ${factsText}` : "";
	const bodyBudget = Math.max(0, 2048 - Buffer.byteLength(head, "utf8") - Buffer.byteLength(factsSuffix, "utf8"));
	const content = utf8Prefix(body, bodyBudget);
	const text = head + content + factsSuffix;
	if (Buffer.byteLength(text, "utf8") > 2048) throw new Error("lane report exceeded its UTF-8 byte budget");
	return text;
}
type ChecksOutcome =
	| { readonly kind: "wait" }
	| { readonly kind: "red"; readonly failingChecks: readonly string[]; readonly failureLogTail?: string }
	| { readonly kind: "passed" }
	| { readonly kind: "ended"; readonly reason: string };

/** What one checks observation means for an awaiting_checks cycle; evidence beats the deadline. */
function checksOutcome(
	cycle: AwaitingChecks,
	facts: Awaited<ReturnType<typeof collectRepoFacts>>,
	now: number,
): ChecksOutcome {
	const checks = facts?.checkStatus;
	if (
		checks?.prState === "closed" &&
		checks.merged &&
		checks.headSha === cycle.headSha &&
		(cycle.prNumber === null || checks.prNumber === cycle.prNumber)
	)
		return { kind: "passed" };
	if (facts?.headSha && facts.headSha !== cycle.headSha)
		return { kind: "ended", reason: `head_moved from=${cycle.headSha.slice(0, 12)} to=${facts.headSha.slice(0, 12)}` };
	if (facts?.remoteHeadSha && facts.remoteHeadSha !== cycle.headSha)
		return {
			kind: "ended",
			reason: `head_moved from=${cycle.headSha.slice(0, 12)} to=${facts.remoteHeadSha.slice(0, 12)}`,
		};
	const headIsPublished =
		(facts?.pushed === true && facts.remoteHeadSha === cycle.headSha) ||
		(checks?.headSha === cycle.headSha && (cycle.prNumber === null || checks.prNumber === cycle.prNumber));
	if (cycle.prNumber === null) {
		if (checks === null) return checksTimeoutOrWait(cycle, now);
		if (checks?.prState === "closed") {
			if (checks.merged)
				return {
					kind: "ended",
					reason: `head_moved from=${cycle.headSha.slice(0, 12)} to=${checks.headSha.slice(0, 12)}`,
				};
			return { kind: "ended", reason: `pr_closed pr=${checks.prNumber}` };
		}
		if (!headIsPublished) return checksTimeoutOrWait(cycle, now);
		if (checks?.status === "green") return { kind: "passed" };
		if (checks?.status === "red")
			return {
				kind: "red",
				failingChecks: checks.failingChecks,
				...(checks.failureLogTail ? { failureLogTail: checks.failureLogTail } : {}),
			};
		return checksTimeoutOrWait(cycle, now);
	}
	// A missing PR result is not proof the checks cycle ended; retain the deadline.
	if (checks === null || checks === undefined) return checksTimeoutOrWait(cycle, now);
	// A different number means the recorded PR is no longer the active exact-head match.
	if (checks.prNumber !== cycle.prNumber) return { kind: "ended", reason: `pr_closed pr=${cycle.prNumber}` };
	if (checks?.prState === "closed") {
		if (checks.merged)
			return {
				kind: "ended",
				reason: `head_moved from=${cycle.headSha.slice(0, 12)} to=${checks.headSha.slice(0, 12)}`,
			};
		return { kind: "ended", reason: `pr_closed pr=${cycle.prNumber}` };
	}
	if (checks && checks.headSha !== cycle.headSha) return checksHeadNotCurrent(cycle, facts, now);
	if (!headIsPublished) return checksTimeoutOrWait(cycle, now);
	if (checks?.status === "green") return { kind: "passed" };
	if (checks?.status === "red")
		return {
			kind: "red",
			failingChecks: checks.failingChecks,
			...(checks.failureLogTail ? { failureLogTail: checks.failureLogTail } : {}),
		};
	// Pending, or unavailable (lookup failed): keep waiting until the deadline.
	return checksTimeoutOrWait(cycle, now);
}

function checksTimeoutOrWait(cycle: AwaitingChecks, now: number): ChecksOutcome {
	if (now - Date.parse(cycle.since) >= AWAITING_CHECKS_TIMEOUT_MS)
		return { kind: "ended", reason: `timeout after ${AWAITING_CHECKS_TIMEOUT_MS / 60_000}m` };
	return { kind: "wait" };
}

function checksHeadNotCurrent(
	cycle: AwaitingChecks,
	facts: Awaited<ReturnType<typeof collectRepoFacts>>,
	now: number,
): ChecksOutcome {
	if (facts?.remoteHeadSha && facts.remoteHeadSha !== cycle.headSha)
		return {
			kind: "ended",
			reason: `head_moved from=${cycle.headSha.slice(0, 12)} to=${facts.remoteHeadSha.slice(0, 12)}`,
		};
	if (now - Date.parse(cycle.since) >= AWAITING_CHECKS_TIMEOUT_MS)
		return { kind: "ended", reason: `timeout after ${AWAITING_CHECKS_TIMEOUT_MS / 60_000}m` };
	return { kind: "wait" };
}

interface ChecksReportEffects {
	readonly fallback?: ChatMessagePayload;
	readonly persona?: string;
	readonly laneParent?: string;
}

/** The parent's report for a concluded checks cycle. */
function checksReportText(
	name: string,
	cycle: AwaitingChecks,
	outcome: ChecksSettlement,
	facts: Awaited<ReturnType<typeof collectRepoFacts>>,
): string {
	const lead =
		outcome.kind === "passed"
			? `[lane ${name}] checks passed:`
			: `[lane ${name}] ${outcome.kind === "failed" ? "failed" : "attempt_ended"}: awaiting_checks ${outcome.reason}`;
	const checks = outcome.kind === "passed" ? " checks=green" : "";
	const observedFacts = [
		`head=${cycle.headSha.slice(0, 12)}`,
		`pr=${cycle.prNumber ?? "unknown"}${checks}`,
		`prHead=${facts?.checkStatus?.headSha.slice(0, 12) ?? "unknown"}`,
		...(facts?.remoteHeadSha ? [`remoteHead=${facts.remoteHeadSha.slice(0, 12)}`] : []),
	].join(" ");
	const suffix = ` ${observedFacts}`;
	return utf8Prefix(lead, 2048 - Buffer.byteLength(suffix, "utf8")) + suffix;
}

async function collectRepoFacts(
	worktreePath: string,
	timeouts: GitTimeouts,
	checkClient?: CheckStatusClient,
	includePushStatus = true,
	checkHeadSha?: string,
	checkPrNumber?: number,
): Promise<
	| {
			headSha?: string;
			dirtyFiles: number;
			branch?: string;
			/** true/false when known; null when remote probes were unavailable. */
			pushed?: boolean | null;
			/** Known branch head shared by every configured push URL. */
			remoteHeadSha?: string;
			/** null: no PR has this exact head; absent: not pushed, no client, or the lookup failed. */
			checkStatus?: CheckStatusSnapshot | null;
	  }
	| undefined
> {
	try {
		const head = await runGit(["-C", worktreePath, "rev-parse", "HEAD"], { timeoutMs: timeouts.local });
		const branch = await runGit(["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"], {
			timeoutMs: timeouts.local,
		});
		const status = await runGit(["-C", worktreePath, "status", "--porcelain"], { timeoutMs: timeouts.local });
		const headSha = head.stdout.trim();
		if (head.exitCode !== 0 || status.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(headSha)) return undefined;

		const branchName = branch.stdout.trim() || undefined;
		const result: Awaited<ReturnType<typeof collectRepoFacts>> = {
			headSha,
			dirtyFiles: status.stdout.split("\n").filter((line) => line.trim()).length,
			branch: branchName,
		};
		// Bare clones do not create remote-tracking refs, so verify every configured push URL directly.
		if (includePushStatus && branchName && branchName !== "HEAD") {
			const pushUrlsResult = await runGit(["-C", worktreePath, "remote", "get-url", "--push", "--all", "origin"], {
				timeoutMs: timeouts.local,
			});
			const pushUrls = pushUrlsResult.stdout
				.split(/\r?\n/)
				.map((url) => url.trim())
				.filter(Boolean);
			if (pushUrlsResult.exitCode !== 0) {
				result.pushed = null;
			} else if (pushUrls.length === 0) {
				result.pushed = false;
			} else {
				const upstreamHeads = await Promise.all(
					pushUrls.map((url) => remoteBranchSha(url, branchName, timeouts.probe)),
				);
				if (upstreamHeads.some((probe) => probe.kind === "missing")) result.pushed = false;
				else if (upstreamHeads.some((probe) => probe.kind === "unknown")) result.pushed = null;
				else {
					const shas = upstreamHeads.map((probe) => (probe.kind === "found" ? probe.sha : undefined));
					if (shas.every((sha) => sha !== undefined && sha === shas[0])) result.remoteHeadSha = shas[0];
					result.pushed = shas.every((sha) => sha === headSha);
				}
			}

			// Query even when the source ref is absent: GitHub retains merged PRs after branch deletion.
			if (checkClient) {
				const checkStatus = await checkClient.getCheckStatus(
					checkHeadSha ?? result.remoteHeadSha ?? headSha,
					worktreePath,
					checkPrNumber,
					branchName,
				);
				if (checkStatus !== undefined) result.checkStatus = checkStatus;
			}
		}

		return result;
	} catch {
		return undefined;
	}
}

type RemoteBranchProbe =
	| { readonly kind: "found"; readonly sha: string }
	| { readonly kind: "missing" }
	| { readonly kind: "unknown" };

async function remoteBranchSha(remoteUrl: string, branchName: string, timeoutMs: number): Promise<RemoteBranchProbe> {
	try {
		const probe = await runGit(["ls-remote", "--exit-code", "--heads", remoteUrl, `refs/heads/${branchName}`], {
			timeoutMs,
		});
		const output = probe.stdout.trim();
		const [sha, ref] = output.split(/\s+/, 2);
		if (probe.exitCode === 2 && output === "") return { kind: "missing" };
		if (probe.exitCode === 0 && ref === `refs/heads/${branchName}` && /^[0-9a-f]{40}$/.test(sha ?? ""))
			return { kind: "found", sha: sha! };
		return { kind: "unknown" };
	} catch {
		return { kind: "unknown" };
	}
}

type CreatedRepoWorktree = {
	readonly worktreePath: string;
	readonly repositoryPath: string;
	readonly baseSha: string;
};

function isGitRemoteUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return ["file:", "git:", "https:", "ssh:"].includes(url.protocol) && (url.protocol === "file:" || !!url.hostname);
	} catch {
		return /^[^/@\s]+@[^:/\s]+:.+/.test(value);
	}
}

function resolveLocalRemoteUrl(sourceRepository: string, remoteUrl: string): string {
	const windowsDrivePath = /^[A-Za-z]:/.test(remoteUrl);
	const windowsAbsolutePath = /^[A-Za-z]:[\\/]/.test(remoteUrl) || remoteUrl.startsWith("\\\\");
	const transportUrl = !windowsDrivePath && /^[A-Za-z][A-Za-z\d+.-]*:/.test(remoteUrl);
	const scpLikeUrl = !windowsDrivePath && /^(?:[^/@:\s]+@)?[^/:\\\s]+:.+/.test(remoteUrl);
	if (isAbsolute(remoteUrl) || windowsAbsolutePath || transportUrl || scpLikeUrl) return remoteUrl;
	return resolve(sourceRepository, remoteUrl);
}

function canonicalPathIncludingMissing(target: string): string {
	let current = resolve(target);
	const missing: string[] = [];
	while (true) {
		try {
			return resolve(realpathSync(current), ...missing.reverse());
		} catch (error) {
			let pathIsMissing = false;
			try {
				lstatSync(current);
			} catch (lstatError) {
				const code =
					typeof lstatError === "object" && lstatError !== null && "code" in lstatError ? lstatError.code : undefined;
				if (code !== "ENOENT" && code !== "ENOTDIR") throw lstatError;
				pathIsMissing = true;
			}
			if (!pathIsMissing) throw error;
			const parent = dirname(current);
			if (parent === current) throw error;
			missing.push(basename(current));
			current = parent;
		}
	}
}

async function pathExists(path: string): Promise<boolean> {
	const { lstat } = await import("node:fs/promises");
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

/** Creates an isolated bare repository and worktree whose origin is the bound repository. */
async function createWorktreeFromRepo(
	laneRoot: string,
	serviceDirectory: string,
	laneName: string,
	repo: string,
	base: string | undefined,
	timeouts: GitTimeouts,
): Promise<CreatedRepoWorktree> {
	const absoluteLaneRoot = resolve(laneRoot);
	const lanesDir = join(absoluteLaneRoot, "lanes");
	const worktreePath = managedLaneWorktreePath(absoluteLaneRoot, laneName);
	const isRemote = isGitRemoteUrl(repo);
	let sourceRepository = repo;
	let sourceHasOrigin = false;
	const repositoryPath = managedLaneRepositoryPath(absoluteLaneRoot, laneName);
	assertOutsideServiceDirectory(serviceDirectory, worktreePath, laneName);
	assertOutsideServiceDirectory(serviceDirectory, repositoryPath, laneName);
	const { mkdir, rm } = await import("node:fs/promises");
	let ownsRepositoryPath = false;
	let ownsWorktreePath = false;
	let worktreeAddAttempted = false;
	let defaultRef: string | undefined;

	try {
		await mkdir(lanesDir, { recursive: true });
		try {
			await mkdir(worktreePath);
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
			if (code !== "EEXIST") throw error;
			throw new ProtocolError("invalid_params", "lane worktree path already exists", {
				reasonCode: "lane_worktree_path_exists",
				name: laneName,
			});
		}
		ownsWorktreePath = true;

		if (!isRemote) {
			const gitCheckResult = await runGit(["-C", repo, "rev-parse", "--git-dir"], { timeoutMs: timeouts.local });
			if (gitCheckResult.exitCode !== 0) {
				const stderr = gitCheckResult.stderr.trim() || "not a git repository";
				throw new ProtocolError("invalid_params", `repo must be a local git repository: ${stderr}`, {
					reasonCode: "repo_not_git",
					repo,
					stderr,
				});
			}
			const sourceRoot = await runGit(["-C", repo, "rev-parse", "--show-toplevel"], { timeoutMs: timeouts.local });
			sourceRepository = sourceRoot.exitCode === 0 ? resolve(sourceRoot.stdout.trim()) : resolve(repo);
			const remoteHead = await runGit(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], {
				cwd: sourceRepository,
				timeoutMs: timeouts.local,
			});
			if (remoteHead.exitCode === 0) {
				const match = remoteHead.stdout.trim().match(/^refs\/remotes\/origin\/(.+)$/);
				if (match?.[1]) defaultRef = match[1];
			}
			if (!defaultRef) {
				const head = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], {
					cwd: sourceRepository,
					timeoutMs: timeouts.local,
				});
				if (head.exitCode === 0) defaultRef = head.stdout.trim() || undefined;
			}
		}
		await mkdir(dirname(repositoryPath), { recursive: true });
		try {
			await mkdir(repositoryPath);
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
			if (code !== "EEXIST") throw error;
			throw new ProtocolError("invalid_params", "lane repository path already exists", {
				reasonCode: "lane_repository_path_exists",
				name: laneName,
			});
		}
		ownsRepositoryPath = true;
		let cloneExitCode: number;
		let cloneStderr: string;
		try {
			const clone = await runGit(["clone", "--bare", "--", sourceRepository, repositoryPath], {
				timeoutMs: isRemote ? timeouts.clone : timeouts.local,
			});
			cloneExitCode = clone.exitCode;
			cloneStderr = clone.stderr.trim();
		} catch (error) {
			// A deadline is the gateway giving up, not a bad repo argument: keep its typed error.
			if (error instanceof ProtocolError) throw error;
			const stderr = error instanceof Error ? error.message : String(error);
			throw new ProtocolError("invalid_params", `failed to clone lane repository: ${stderr || "unknown error"}`, {
				reasonCode: "repo_clone_failed",
				repo,
			});
		}
		if (cloneExitCode !== 0) {
			const stderr = cloneStderr || "unknown error";
			throw new ProtocolError("invalid_params", `failed to clone lane repository: ${stderr}`, {
				reasonCode: "repo_clone_failed",
				repo,
			});
		}
		if (!isRemote) {
			// Cloning a local checkout makes that path origin; retain its configured upstream URLs instead.
			const sourceFetchUrls = await runGit(["-C", sourceRepository, "remote", "get-url", "--all", "origin"], {
				timeoutMs: timeouts.local,
			});
			if (sourceFetchUrls.exitCode === 0) {
				const fetchUrls = sourceFetchUrls.stdout
					.split(/\r?\n/)
					.map((url) => url.trim())
					.filter(Boolean)
					.map((url) => resolveLocalRemoteUrl(sourceRepository, url));
				sourceHasOrigin = fetchUrls.length > 0;
				for (const [index, fetchUrl] of fetchUrls.entries()) {
					const setFetchUrl = await runGit(
						index === 0
							? ["remote", "set-url", "origin", fetchUrl]
							: ["remote", "set-url", "--add", "origin", fetchUrl],
						{ cwd: repositoryPath, timeoutMs: timeouts.local },
					);
					if (setFetchUrl.exitCode !== 0) {
						throw new ProtocolError("invalid_params", "failed to preserve repository fetch remote", {
							reasonCode: "repo_fetch_remote_failed",
							repo,
						});
					}
				}
			}
			const sourcePushUrls = await runGit(["-C", sourceRepository, "remote", "get-url", "--push", "--all", "origin"], {
				timeoutMs: timeouts.local,
			});
			if (sourcePushUrls.exitCode === 0) {
				for (const pushUrl of sourcePushUrls.stdout
					.split(/\r?\n/)
					.map((url) => url.trim())
					.filter(Boolean)
					.map((url) => resolveLocalRemoteUrl(sourceRepository, url))) {
					const setPushUrl = await runGit(["remote", "set-url", "--add", "--push", "origin", pushUrl], {
						cwd: repositoryPath,
						timeoutMs: timeouts.local,
					});
					if (setPushUrl.exitCode !== 0) {
						throw new ProtocolError("invalid_params", "failed to preserve repository push remote", {
							reasonCode: "repo_push_remote_failed",
							repo,
						});
					}
				}
			}
		}
		const fetchRefspec = "+refs/heads/*:refs/remotes/origin/*";
		const configureFetch = await runGit(["config", "--replace-all", "remote.origin.fetch", fetchRefspec], {
			cwd: repositoryPath,
			timeoutMs: timeouts.local,
		});
		if (configureFetch.exitCode !== 0) {
			throw new ProtocolError("invalid_params", "failed to configure lane repository fetch refspec", {
				reasonCode: "repo_fetch_refspec_failed",
				repo,
			});
		}

		const copySourceTrackingRefs = !isRemote && sourceHasOrigin;
		const refSource = copySourceTrackingRefs ? sourceRepository : repositoryPath;
		const sourceRefPrefix = copySourceTrackingRefs ? "refs/remotes/origin" : "refs/heads";
		const availableRefs = await runGit(["-C", refSource, "for-each-ref", "--format=%(refname)", sourceRefPrefix], {
			timeoutMs: timeouts.local,
		});
		if (availableRefs.exitCode !== 0) {
			throw new ProtocolError("invalid_params", "failed to inspect lane repository refs", {
				reasonCode: "repo_fetch_refs_failed",
				repo,
			});
		}
		const refspecs = availableRefs.stdout
			.split(/\r?\n/)
			.map((ref) => ref.trim())
			.filter(
				(ref) =>
					ref.startsWith(`${sourceRefPrefix}/`) && !(copySourceTrackingRefs && ref === "refs/remotes/origin/HEAD"),
			)
			.map((ref) => {
				const branch = ref.slice(sourceRefPrefix.length + 1);
				return `+${ref}:refs/remotes/origin/${branch}`;
			});
		if (refspecs.length > 0) {
			const fetchSource = copySourceTrackingRefs ? sourceRepository : ".";
			const populateTrackingRefs = await runGit(["fetch", "--no-tags", "--", fetchSource, ...refspecs], {
				cwd: repositoryPath,
				timeoutMs: timeouts.local,
			});
			if (populateTrackingRefs.exitCode !== 0) {
				throw new ProtocolError("invalid_params", "failed to populate lane repository remote-tracking refs", {
					reasonCode: "repo_fetch_refs_failed",
					repo,
				});
			}
		}
		if (!isRemote && base === undefined && defaultRef) {
			const localDefaultBranch = `refs/heads/${defaultRef}`;
			const localDefaultBranchCheck = await runGit(
				["rev-parse", "--verify", "--quiet", `${localDefaultBranch}^{commit}`],
				{ cwd: repositoryPath, timeoutMs: timeouts.local },
			);
			if (localDefaultBranchCheck.exitCode !== 0) {
				const sourceDefaultRef = `refs/remotes/origin/${defaultRef}`;
				const sourceDefaultRefCheck = await runGit(
					["-C", sourceRepository, "rev-parse", "--verify", "--quiet", `${sourceDefaultRef}^{commit}`],
					{ timeoutMs: timeouts.local },
				);
				if (sourceDefaultRefCheck.exitCode === 0) {
					const materializeDefault = await runGit(
						["fetch", "--no-tags", "--", sourceRepository, `+${sourceDefaultRef}:${localDefaultBranch}`],
						{ cwd: repositoryPath, timeoutMs: timeouts.local },
					);
					if (materializeDefault.exitCode !== 0) {
						throw new ProtocolError(
							"invalid_params",
							"default remote-tracking ref could not be copied to the lane repository",
							{ reasonCode: "repo_base_not_found", repo },
						);
					}
				}
			}
		}
		if (defaultRef) {
			const symbolicHead = await runGit(["symbolic-ref", "HEAD", `refs/heads/${defaultRef}`], {
				cwd: repositoryPath,
				timeoutMs: timeouts.local,
			});
			if (symbolicHead.exitCode !== 0) defaultRef = undefined;
		}

		let baseRef = base ?? defaultRef;
		if (!baseRef) {
			const headResult = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], {
				cwd: repositoryPath,
				timeoutMs: timeouts.local,
			});
			if (headResult.exitCode === 0) baseRef = headResult.stdout.trim() || undefined;
		}
		if (!baseRef) {
			throw new ProtocolError("invalid_params", "could not determine the repository default branch", {
				reasonCode: "repo_default_branch_unresolved",
				repo,
			});
		}
		if (baseRef.startsWith("origin/")) {
			const localBranch = `refs/heads/${baseRef.slice("origin/".length)}`;
			let fetchedRemoteTrackingBase = false;
			if (!isRemote) {
				const sourceRef = `refs/remotes/${baseRef}`;
				const sourceRefCheck = await runGit(
					["-C", sourceRepository, "rev-parse", "--verify", "--quiet", `${sourceRef}^{commit}`],
					{ timeoutMs: timeouts.local },
				);
				if (sourceRefCheck.exitCode === 0) {
					const fetch = await runGit(["fetch", "--no-tags", "--", sourceRepository, `+${sourceRef}:${localBranch}`], {
						cwd: repositoryPath,
						timeoutMs: timeouts.local,
					});
					if (fetch.exitCode !== 0) {
						throw new ProtocolError(
							"invalid_params",
							"base remote-tracking ref could not be copied to the lane repository",
							{
								reasonCode: "repo_base_not_found",
								repo,
							},
						);
					}
					baseRef = localBranch;
					fetchedRemoteTrackingBase = true;
				}
			}
			if (!fetchedRemoteTrackingBase) {
				const branchCheck = await runGit(["rev-parse", "--verify", "--quiet", `${localBranch}^{commit}`], {
					cwd: repositoryPath,
					timeoutMs: timeouts.local,
				});
				if (branchCheck.exitCode === 0) baseRef = localBranch;
			}
		}
		if (baseRef.startsWith("-")) {
			throw new ProtocolError("invalid_params", "base must be a branch, tag, or commit ref", {
				reasonCode: "repo_base_invalid",
				repo,
			});
		}

		const baseResult = await runGit(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], {
			cwd: repositoryPath,
			timeoutMs: timeouts.local,
		});
		const baseSha = baseResult.stdout.trim() || "";
		if (baseResult.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(baseSha)) {
			throw new ProtocolError("invalid_params", "base does not resolve to a commit in the repository", {
				reasonCode: "repo_base_not_found",
				repo,
			});
		}

		worktreeAddAttempted = true;
		const addResult = await runGit(["worktree", "add", "-b", managedLaneBranchName(laneName), worktreePath, baseSha], {
			cwd: repositoryPath,
			timeoutMs: timeouts.local,
		});
		if (addResult.exitCode !== 0) {
			const stderr = addResult.stderr.trim() || "unknown error";
			throw new ProtocolError("invalid_params", `failed to create lane worktree from repo: ${stderr}`, {
				reasonCode: "repo_worktree_failed",
				repo,
			});
		}
		return {
			worktreePath,
			repositoryPath,
			baseSha,
		};
	} catch (error) {
		let partialWorktreeCleanupFailed = false;
		if (ownsWorktreePath) {
			if (worktreeAddAttempted && ownsRepositoryPath) {
				// Best effort: the prune/list below decide whether the worktree is really gone.
				await runGit(["worktree", "remove", "--force", worktreePath], {
					cwd: repositoryPath,
					timeoutMs: timeouts.local,
				}).catch(() => undefined);
				try {
					if (await pathExists(worktreePath)) await rm(worktreePath, { recursive: true, force: true });
				} catch {
					partialWorktreeCleanupFailed = true;
				}
				if (!partialWorktreeCleanupFailed) {
					const failed = { exitCode: -1, stdout: "", stderr: "" };
					const prune = await runGit(["worktree", "prune"], { cwd: repositoryPath, timeoutMs: timeouts.local }).catch(
						() => failed,
					);
					const list = await runGit(["worktree", "list", "--porcelain"], {
						cwd: repositoryPath,
						timeoutMs: timeouts.local,
					}).catch(() => failed);
					if (prune.exitCode !== 0 || list.exitCode !== 0) {
						partialWorktreeCleanupFailed = true;
					} else {
						const expectedWorktreePath = canonicalPathIncludingMissing(worktreePath);
						partialWorktreeCleanupFailed = list.stdout.split(/\r?\n/).some((line) => {
							if (!line.startsWith("worktree ")) return false;
							try {
								return canonicalPathIncludingMissing(line.slice("worktree ".length)) === expectedWorktreePath;
							} catch {
								return true;
							}
						});
					}
				}
			} else {
				try {
					await rm(worktreePath, { recursive: true, force: true });
				} catch {
					partialWorktreeCleanupFailed = true;
				}
			}
		}
		if (ownsRepositoryPath && !partialWorktreeCleanupFailed)
			try {
				await rm(repositoryPath, { recursive: true, force: true });
			} catch {
				partialWorktreeCleanupFailed = true;
			}
		if (partialWorktreeCleanupFailed) {
			throw new ProtocolError(
				"invalid_params",
				"failed to clean up partial lane worktree; managed repository was retained",
				{
					reasonCode: "repo_worktree_cleanup_failed",
					repo,
				},
			);
		}
		if (error instanceof ProtocolError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new ProtocolError("invalid_params", `failed to create lane worktree: ${message}`, {
			reasonCode: "repo_worktree_failed",
			repo,
		});
	}
}

async function discardCreatedWorktree(
	name: string,
	created: CreatedRepoWorktree,
	timeouts: GitTimeouts,
): Promise<void> {
	const removeResult = await runGit(["worktree", "remove", "--force", created.worktreePath], {
		cwd: created.repositoryPath,
		timeoutMs: timeouts.local,
	});
	if (removeResult.exitCode !== 0) throw new Error(removeResult.stderr.trim() || "git worktree remove failed");
	await runGit(["branch", "-D", managedLaneBranchName(name)], {
		cwd: created.repositoryPath,
		timeoutMs: timeouts.local,
	}).catch(() => undefined);
	const { rm } = await import("node:fs/promises");
	await rm(created.repositoryPath, { recursive: true, force: true });
}

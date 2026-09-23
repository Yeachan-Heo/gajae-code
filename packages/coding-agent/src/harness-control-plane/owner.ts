/**
 * RuntimeOwner — the detached per-session process that makes live control honest.
 *
 * Responsibilities:
 *  - hold the {@link SessionLease} (single writer),
 *  - own an injected SDK session transport,
 *  - serve owner-routed primitives over the {@link ControlServer} endpoint,
 *  - be the SOLE writer of the severity event stream,
 *  - heartbeat the lease.
 *
 * Stateless `gjc harness` CLI calls reach the owner via {@link resolveOwner} + the endpoint.
 */

import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { AgentWireOwnerObservation } from "../modes/shared/agent-wire/event-contract";
import { observeAgentWireFrame } from "../modes/shared/agent-wire/event-observation";
import { classifyRecovery } from "./classifier";
import { ControlServer, type EndpointHandler, type EndpointHandlerRequest } from "./control-endpoint";
import {
	defaultFinalizeChecks,
	type FinalizeChecks,
	runFinalize,
	type ValidationCommandSpec,
	ValidationObservationUncertainError,
	type ValidationRun,
} from "./finalize";
import { type OperateResult, operate } from "./operate";
import { preserveDirtyWorktree } from "./preserve";
import { RECEIPT_SPOOL_DIR_ENV, withReceiptSpoolDir } from "./receipt-spool";
import {
	buildReceipt,
	type ReceiptEnvelope,
	type ReceiptSubject,
	requiresVanishBeforeAction,
	type ValidationEvidence,
	type VanishEvidence,
	validateReceipt,
} from "./receipts";
import {
	acquireLease,
	canWriteEvents,
	classifyLeaseStatus,
	heartbeat,
	LeaseError,
	readLease,
	releaseLease,
	type SessionLease,
} from "./session-lease";
import {
	type HarnessSessionTransport,
	type HarnessSessionTransportCloseContext,
	type SessionStateSnapshot,
	singleFlightAccept,
} from "./session-transport";
import { buildStateView, nextAllowedActions, submitUnavailableReason } from "./state-machine";
import {
	appendEvent,
	controlSocketPath,
	type ReceiptIndexEntry,
	readEvents,
	readSessionState,
	sessionPaths,
	writeReceiptImmutable,
	writeSessionState,
} from "./storage";
import type { EventEnvelope, GitDelta, Observation, PrimitiveResponse, SessionState, Severity } from "./types";
import { DEFAULT_RETRY_BUDGET, OBSERVED_SIGNALS } from "./types";

function isStartupLivenessBlocker(blocker: string): boolean {
	return blocker === "detached-owner-not-live";
}

function isOwnerVanishedBlocker(blocker: string): boolean {
	return blocker.startsWith("owner-vanished:");
}

function reconcileLiveOwnerState(state: SessionState): { state: SessionState; reconciled: boolean } {
	const blockers = state.blockers.filter(blocker => !isStartupLivenessBlocker(blocker));
	const hadLivenessBlocker = blockers.length !== state.blockers.length;
	const lifecycle =
		hadLivenessBlocker && state.lifecycle === "blocked" && blockers.length === 0 ? "observing" : state.lifecycle;
	if (!hadLivenessBlocker && lifecycle === state.lifecycle) return { state, reconciled: false };
	return {
		state: {
			...state,
			lifecycle,
			blockers,
			updatedAt: new Date().toISOString(),
		},
		reconciled: true,
	};
}

function flattenAggregateCauses(errors: readonly unknown[]): unknown[] {
	const causes: unknown[] = [];
	for (const error of errors) {
		if (error instanceof AggregateError) causes.push(...flattenAggregateCauses(error.errors));
		else causes.push(error);
	}
	return causes;
}

/**
 * Nominal sentinel: raised only after #stopOnce has verified teardown so the
 * retry loop can rethrow it immediately. A private class prevents a lookalike
 * cleanup AggregateError (message collision) from bypassing verification retries.
 */
class FramePumpAfterVerifiedCleanupError extends AggregateError {}

export interface OwnerOptions {
	root: string;
	sessionId: string;
	transport: HarnessSessionTransport;
	ownerId?: string;
	ttlMs?: number;
	heartbeatMs?: number;
	acceptanceTimeoutMs?: number;
	clock?: () => number;
	finalizeChecks?: FinalizeChecks;
	validationCommands?: ValidationCommandSpec[];
	/** Test seam for deterministic control-endpoint teardown failures. */
	controlServerFactory?: (socketPath: string, handler: EndpointHandler) => ControlServer;
	/** Test seam for deterministic lease-release teardown failures. */
	leaseRelease?: typeof releaseLease;
	/** Test seam for deterministic lease-heartbeat behavior (e.g. renewal barriers). */
	leaseHeartbeat?: typeof heartbeat;
	/** Test seams for frame persistence failures. */
	framePersistence?: {
		appendEvent?: typeof appendEvent;
		writeSessionState?: typeof writeSessionState;
	};
	/** Test seams; production retries verified shutdown without a finite limit. */
	cleanupRetryMs?: number;
	cleanupRetryLimit?: number;
}

export interface OwnerStartInfo {
	ownerId: string;
	socketPath: string;
	leaseEpoch: number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_ACCEPT_TIMEOUT_MS = 60_000;
const DEFAULT_CLEANUP_RETRY_MS = 500;
const MAX_RETAINED_CLEANUP_FAILURES = 32;

export class RuntimeOwner {
	readonly ownerId: string;
	#opts: Required<
		Omit<
			OwnerOptions,
			"clock" | "finalizeChecks" | "validationCommands" | "controlServerFactory" | "framePersistence"
		>
	> & { clock?: () => number };
	#server: ControlServer;
	#cursor = 0;
	#leaseEpoch = 0;
	#leaseHeld = false;
	#heartbeatTimer: NodeJS.Timeout | null = null;
	#heartbeatFenced = false;
	// Every renewal the heartbeat interval starts is tracked here until it settles.
	// Teardown drains the whole set so no already-started renewal can still be
	// polling the lease mutation lock when releaseLease runs.
	#heartbeatInFlight = new Set<Promise<unknown>>();
	#socketPath: string;
	#finalizeChecks?: FinalizeChecks;
	#validationCommands?: ValidationCommandSpec[];
	#unsubscribeFrames: (() => void) | null = null;
	#framePump: Promise<void> = Promise.resolve();
	#framePumpFailure: unknown = null;
	#coalesced = new Map<string, true>();
	#stopPromise: Promise<void> | null = null;
	#retiring = false;
	#retirePromise: Promise<PrimitiveResponse> | null = null;
	#lifecycleMutation: Promise<void> = Promise.resolve();
	#activeRetirementSensitiveWork = new Set<Promise<void>>();
	#activeValidationWork = new Set<{
		controller: AbortController;
		done: Promise<void>;
	}>();
	#validationStopFailure: unknown = null;
	#lastStopFailures: unknown[] = [];
	#reportedStopFailures = new Set<string>();
	#transportClosed = false;
	#serverClosed = false;
	#framePersistence: Required<NonNullable<OwnerOptions["framePersistence"]>>;

	constructor(opts: OwnerOptions) {
		this.ownerId = opts.ownerId ?? `owner-${randomUUID()}`;
		this.#socketPath = controlSocketPath(opts.root, opts.sessionId);
		this.#opts = {
			root: opts.root,
			sessionId: opts.sessionId,
			transport: opts.transport,
			ownerId: this.ownerId,
			ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
			heartbeatMs: opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
			acceptanceTimeoutMs: opts.acceptanceTimeoutMs ?? DEFAULT_ACCEPT_TIMEOUT_MS,
			clock: opts.clock,
			cleanupRetryMs: opts.cleanupRetryMs ?? DEFAULT_CLEANUP_RETRY_MS,
			cleanupRetryLimit: opts.cleanupRetryLimit ?? Number.POSITIVE_INFINITY,
			leaseRelease: opts.leaseRelease ?? releaseLease,
			leaseHeartbeat: opts.leaseHeartbeat ?? heartbeat,
		};
		this.#finalizeChecks = opts.finalizeChecks;
		this.#validationCommands = opts.validationCommands;
		this.#framePersistence = {
			appendEvent: opts.framePersistence?.appendEvent ?? appendEvent,
			writeSessionState: opts.framePersistence?.writeSessionState ?? writeSessionState,
		};
		this.#server = (opts.controlServerFactory ?? ((socketPath, handler) => new ControlServer(socketPath, handler)))(
			this.#socketPath,
			req => this.#handle(req),
		);
	}

	async start(): Promise<OwnerStartInfo> {
		try {
			return await this.#startOnce();
		} catch (startError) {
			try {
				await this.stop();
			} catch (cleanupError) {
				const cleanupCauses = flattenAggregateCauses([cleanupError]);
				throw new AggregateError(
					[startError, ...cleanupCauses],
					"Runtime owner startup and exact-child rollback failed.",
				);
			}
			if (this.#lastStopFailures.length > 0)
				throw new AggregateError(
					[startError, ...flattenAggregateCauses(this.#lastStopFailures)],
					"Runtime owner startup failed after retrying exact-child rollback.",
				);
			throw startError;
		}
	}

	async #startOnce(): Promise<OwnerStartInfo> {
		const { root, sessionId } = this.#opts;
		const eventsPath = sessionPaths(root, sessionId).events;
		const existing = await readEvents(root, sessionId, 0);
		this.#cursor = existing.reduce((max, e) => Math.max(max, e.cursor), 0);
		const { lease } = await acquireLease(root, sessionId, {
			ownerId: this.ownerId,
			pid: process.pid,
			endpoint: { kind: "unix-socket", path: this.#socketPath },
			eventsPath,
			ttlMs: this.#opts.ttlMs,
			clock: this.#opts.clock,
		});
		this.#leaseHeld = true;
		this.#leaseEpoch = lease.leaseEpoch;
		this.#heartbeatTimer = setInterval(() => {
			// Once teardown fences the heartbeat we must never start a renewal again:
			// a renewal here would contend the lease mutation lock with the release
			// path and can starve it (lease_lock_timeout).
			if (this.#heartbeatFenced) return;
			const renewal = this.#opts
				.leaseHeartbeat(root, sessionId, this.ownerId, this.#opts.ttlMs, this.#opts.clock)
				.catch(err => {
					// Self-stop if a legitimate dead-owner takeover revoked our lease.
					if (err instanceof Error && err.message.includes("not_lease_holder")) void this.stop().catch(() => {});
				});
			// Track every in-flight renewal so teardown can drain them ALL before
			// releasing the lease. setInterval can start a new renewal before the
			// previous one settles, and lock acquisition is non-FIFO, so awaiting only
			// the latest would leave an older renewal able to contend releaseLease.
			this.#heartbeatInFlight.add(renewal);
			void renewal.finally(() => {
				this.#heartbeatInFlight.delete(renewal);
			});
		}, this.#opts.heartbeatMs);
		this.#heartbeatTimer.unref?.();
		await this.#server.listen();
		await this.#emit("info", "owner_started", { ownerId: this.ownerId, leaseEpoch: this.#leaseEpoch });
		if (this.#opts.transport.onEventFrame) {
			this.#unsubscribeFrames = this.#opts.transport.onEventFrame(frame => this.#handleFrame(frame));
		}
		return { ownerId: this.ownerId, socketPath: this.#socketPath, leaseEpoch: this.#leaseEpoch };
	}

	async #loadState(): Promise<SessionState> {
		const state = await readSessionState(this.#opts.root, this.#opts.sessionId);
		if (!state) throw new Error(`session_not_found:${this.#opts.sessionId}`);
		const reconciled = reconcileLiveOwnerState(state);
		if (reconciled.reconciled)
			return this.#withLifecycleMutation(async () => {
				const latest = await readSessionState(this.#opts.root, this.#opts.sessionId);
				if (!latest) throw new Error(`session_not_found:${this.#opts.sessionId}`);
				const current = reconcileLiveOwnerState(latest);
				if (current.reconciled) await this.#framePersistence.writeSessionState(this.#opts.root, current.state);
				return current.state;
			});
		return state;
	}

	/** Map an RPC frame and route it: semantic/signal-bearing -> serial emit; high-frequency progress -> coalesce. */
	#handleFrame(frame: Record<string, unknown>): void {
		const mapped = observeAgentWireFrame(frame);
		if (!mapped) return;
		if (mapped.semantic || (mapped.signal && !mapped.coalesceKey)) {
			this.#framePump = this.#framePump
				.then(async () => {
					if (this.#framePumpFailure !== null) return;
					await this.#flushCoalesced();
					await this.#emitMapped(mapped);
				})
				.catch(error => {
					if (this.#framePumpFailure === null) this.#framePumpFailure = error;
				});
		} else if (mapped.coalesceKey) {
			// Coalesce progress-noise by key; never enqueues a per-frame emit, so a message_update
			// storm cannot starve semantic frames. Bound memory.
			this.#coalesced.set(mapped.coalesceKey, true);
			if (this.#coalesced.size > 256) {
				const oldest = this.#coalesced.keys().next().value;
				if (oldest !== undefined) this.#coalesced.delete(oldest);
			}
		}
	}

	async #flushCoalesced(): Promise<void> {
		if (this.#coalesced.size === 0) return;
		const coalescedFrames = this.#coalesced.size;
		this.#coalesced.clear();
		await this.#emit("info", "rpc_activity", { coalescedFrames }, true);
	}

	async #emitMapped(mapped: AgentWireOwnerObservation): Promise<void> {
		if (mapped.kind === "rpc_agent_completed") {
			const state = await readSessionState(this.#opts.root, this.#opts.sessionId);
			if (
				state &&
				state.lifecycle !== "completed" &&
				state.lifecycle !== "retired" &&
				state.lifecycle !== "finalizing"
			) {
				state.lifecycle = "finalizing";
				state.updatedAt = new Date(this.#opts.clock ? this.#opts.clock() : Date.now()).toISOString();
				await this.#framePersistence.writeSessionState(this.#opts.root, state);
			}
		}
		await this.#emit(
			mapped.severity,
			mapped.kind,
			mapped.signal ? { ...mapped.evidence, signal: mapped.signal } : mapped.evidence,
			true,
		);
	}

	#aggregateSignals(events: EventEnvelope[]): string[] {
		const out: string[] = [];
		const vocab = OBSERVED_SIGNALS as readonly string[];
		const add = (s: unknown): void => {
			if (typeof s === "string" && vocab.includes(s) && !out.includes(s)) out.push(s);
		};
		for (const e of events) {
			add((e.evidence as { signal?: unknown } | undefined)?.signal);
			if (e.kind === "prompt_accepted") add("prompt-accepted");
		}
		return out;
	}

	#eventSubmitGateReason(kind: string, evidence: Record<string, unknown>): string | null {
		const reason = typeof evidence.reason === "string" ? evidence.reason : null;
		const signal = typeof evidence.signal === "string" ? evidence.signal : null;
		const rpcActive =
			kind === "prompt_accepted" ||
			reason === "pre-state-not-idle" ||
			kind.startsWith("rpc_") ||
			signal === "prompt-accepted" ||
			signal === "streaming" ||
			signal === "tool-call" ||
			signal === "test-running";
		return rpcActive ? "rpc-not-idle" : null;
	}

	async #emit(
		severity: Severity,
		kind: string,
		evidence: Record<string, unknown>,
		framePersistence = false,
	): Promise<void> {
		const lease = await readLease(this.#opts.root, this.#opts.sessionId);
		// Single-writer guard: only emit while we still hold a live lease.
		if (!lease || !canWriteEvents(lease, this.ownerId, this.#opts.clock)) return;
		const state = await readSessionState(this.#opts.root, this.#opts.sessionId);
		const view = state
			? buildStateView(state, true)
			: {
					sessionId: this.#opts.sessionId,
					lifecycle: "started" as const,
					harness: "gajae-code" as const,
					ownerLive: true,
					blockers: [],
				};
		const submitGateReason = this.#eventSubmitGateReason(kind, evidence);
		const envelope: EventEnvelope = {
			eventId: randomUUID(),
			cursor: ++this.#cursor,
			createdAt: new Date(this.#opts.clock ? this.#opts.clock() : Date.now()).toISOString(),
			severity,
			kind,
			state: view,
			evidence,
			nextAllowedActions: nextAllowedActions(view.lifecycle, true, { submitUnavailableReason: submitGateReason }),
			writer: { ownerId: this.ownerId, leaseEpoch: this.#leaseEpoch },
		};
		await (framePersistence ? this.#framePersistence.appendEvent : appendEvent)(
			this.#opts.root,
			this.#opts.sessionId,
			envelope,
		);
	}

	#response(
		state: SessionState,
		evidence: Record<string, unknown>,
		ok = true,
		submitGateReason: string | null = null,
	): PrimitiveResponse {
		return {
			ok,
			state: buildStateView(state, true),
			evidence,
			nextAllowedActions: nextAllowedActions(state.lifecycle, true, { submitUnavailableReason: submitGateReason }),
		};
	}

	#submitGateReason(state: SessionState, rpcState: SessionStateSnapshot | null): string | null {
		const rpcReason = rpcState
			? rpcState.isStreaming || rpcState.steeringQueueDepth > 0 || rpcState.followupQueueDepth > 0
				? "rpc-not-idle"
				: null
			: "rpc-not-live";
		return submitUnavailableReason(state.lifecycle, true, rpcReason);
	}

	async #withReceiptSpoolFromInput<T>(input: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
		const requested = input[RECEIPT_SPOOL_DIR_ENV];
		if (typeof requested === "string" && requested.trim()) return withReceiptSpoolDir(requested, fn);
		return fn();
	}

	async #withLifecycleMutation<T>(fn: () => Promise<T>): Promise<T> {
		const previous = this.#lifecycleMutation;
		let unlock!: () => void;
		this.#lifecycleMutation = new Promise<void>(resolve => {
			unlock = resolve;
		});
		await previous;
		try {
			return await fn();
		} finally {
			unlock();
		}
	}

	#withRetirementSensitiveWork<T>(work: () => Promise<T>): Promise<T> {
		const operation = work();
		let done!: Promise<void>;
		done = operation
			.then(
				() => undefined,
				() => undefined,
			)
			.then(() => {
				this.#activeRetirementSensitiveWork.delete(done);
			});
		this.#activeRetirementSensitiveWork.add(done);
		return operation;
	}

	async #joinRetirementSensitiveWork(): Promise<void> {
		await Promise.all([...this.#activeRetirementSensitiveWork]);
	}

	#withOwnedValidationWork<T>(requestSignal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const controller = new AbortController();
		const done = Promise.withResolvers<void>();
		const active = { controller, done: done.promise };
		const abortFromRequest = (): void => controller.abort(requestSignal.reason);
		if (requestSignal.aborted) abortFromRequest();
		else requestSignal.addEventListener("abort", abortFromRequest, { once: true });
		if (this.#stopPromise) controller.abort(new Error("owner_stopping"));
		this.#activeValidationWork.add(active);
		return (async () => {
			try {
				return await work(controller.signal);
			} catch (error) {
				if (controller.signal.aborted && !(error instanceof ValidationObservationUncertainError)) {
					this.#validationStopFailure = error;
				}
				throw error;
			} finally {
				requestSignal.removeEventListener("abort", abortFromRequest);
				this.#activeValidationWork.delete(active);
				done.resolve();
			}
		})();
	}

	async #stopActiveValidationWork(): Promise<void> {
		const active = [...this.#activeValidationWork];
		for (const work of active) work.controller.abort(new Error("owner_stopping"));
		await Promise.all(active.map(work => work.done));
		if (this.#validationStopFailure !== null) {
			throw new AggregateError([this.#validationStopFailure], "Runtime owner validation cleanup failed.");
		}
	}

	async #persistValidationLifecycle(
		signal: AbortSignal,
		lifecycle: SessionState["lifecycle"],
		blockers?: string[],
	): Promise<{ state: SessionState; persisted: boolean }> {
		return this.#withLifecycleMutation(async () => {
			const state = await readSessionState(this.#opts.root, this.#opts.sessionId);
			if (!state) throw new Error(`session_not_found:${this.#opts.sessionId}`);
			if (signal.aborted || state.lifecycle === "retired") {
				return { state, persisted: false };
			}
			if (state.lifecycle === "completed") return { state, persisted: lifecycle === "completed" };
			state.lifecycle = lifecycle;
			if (blockers) state.blockers = blockers;
			state.updatedAt = new Date(this.#opts.clock ? this.#opts.clock() : Date.now()).toISOString();
			await writeSessionState(this.#opts.root, state);
			return { state, persisted: true };
		});
	}

	async #persistOwnedReceipt(
		signal: AbortSignal,
		family: "validation" | "completion" | "review-failure" | "review-verdict",
		receipt: ReceiptEnvelope<unknown>,
	): Promise<ReceiptIndexEntry | null> {
		return this.#withLifecycleMutation(async () => {
			const state = await readSessionState(this.#opts.root, this.#opts.sessionId);
			if (!state) throw new Error(`session_not_found:${this.#opts.sessionId}`);
			if (
				signal.aborted ||
				this.#retiring ||
				this.#stopPromise ||
				state.lifecycle === "retired" ||
				state.lifecycle === "completed"
			) {
				return null;
			}
			return writeReceiptImmutable(this.#opts.root, this.#opts.sessionId, family, receipt.receiptId, receipt);
		});
	}

	#finalizeChecksForOwner(checks: FinalizeChecks, signal: AbortSignal): FinalizeChecks {
		return {
			runValidation: (spec, validationSignal) => checks.runValidation(spec, validationSignal ?? signal),
			resolveCommit: () => checks.resolveCommit(),
			commitOnBranch: (commit, branch) => checks.commitOnBranch(commit, branch),
			prOrIssue: () => checks.prOrIssue(),
			writeReceipt: (family, receipt) => this.#persistOwnedReceipt(signal, family, receipt),
		};
	}

	async #handle(req: EndpointHandlerRequest): Promise<unknown> {
		if (this.#stopPromise && !this.#retiring && req.verb === "retire") {
			return { ok: false, error: "owner_stopping" };
		}
		if (
			(this.#stopPromise || this.#retiring) &&
			(req.verb === "submit" ||
				req.verb === "recover" ||
				req.verb === "observe" ||
				req.verb === "validate" ||
				req.verb === "finalize" ||
				req.verb === "operate")
		) {
			return { ok: false, error: this.#retiring ? "owner_retiring" : "owner_stopping" };
		}
		switch (req.verb) {
			case "ping":
				return { ok: true, ownerId: this.ownerId, leaseEpoch: this.#leaseEpoch };
			case "submit":
				return this.#withRetirementSensitiveWork(() => this.#submit(req.input));
			case "observe":
				return this.#withRetirementSensitiveWork(() => this.#observe());
			case "retire":
				return this.#retire();
			case "finalize":
				return this.#withReceiptSpoolFromInput(req.input, () => this.#finalize(req.input, req.signal));
			case "recover":
				return this.#withRetirementSensitiveWork(() =>
					this.#withReceiptSpoolFromInput(req.input, () => this.#recover()),
				);
			case "validate":
				return this.#withReceiptSpoolFromInput(req.input, () => this.#validate(req.signal));
			case "operate":
				return this.#withReceiptSpoolFromInput(req.input, () => this.#operate(req.input, req.signal));
			default:
				return { ok: false, error: `owner_unsupported_verb:${req.verb}` };
		}
	}

	async #observeGit(): Promise<Observation> {
		const state = await this.#loadState();
		const workspace = state.handle.workspace;
		let streaming = false;
		let rpcState: SessionStateSnapshot | null = null;
		try {
			rpcState = await this.#opts.transport.getState();
			streaming = rpcState.isStreaming;
		} catch {
			streaming = false;
		}
		let gitDelta: GitDelta = "unknown";
		let branch = state.handle.branch;
		let deleted = false;
		if (!existsSync(workspace)) {
			deleted = true;
		} else {
			try {
				branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
					cwd: workspace,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				}).trim();
			} catch {
				// keep prior branch
			}
			try {
				const porcelain = execFileSync("git", ["status", "--porcelain"], {
					cwd: workspace,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				});
				gitDelta = porcelain.trim().length > 0 ? "dirty" : "clean";
			} catch {
				gitDelta = "unknown";
			}
		}
		const rpcLive = this.#opts.transport.isLive ? this.#opts.transport.isLive() : rpcState !== null;
		const rpcLastFrameAt = this.#opts.transport.lastFrameAt ? this.#opts.transport.lastFrameAt() : null;
		// Sticky semantic signals come from the persisted owner event log -> survive polling gaps.
		const recent = (await readEvents(this.#opts.root, this.#opts.sessionId, 0)).slice(-200);
		const observedSignals = this.#aggregateSignals(recent).slice(0, 7);
		observedSignals.push(streaming ? "streaming" : "idle");
		const stamps = [state.updatedAt, rpcLastFrameAt, recent.at(-1)?.createdAt].filter(
			(t): t is string => typeof t === "string",
		);
		const lastActivityAt = stamps.length > 0 ? (stamps.sort().at(-1) ?? state.updatedAt) : state.updatedAt;
		const submitGateReason = this.#submitGateReason(state, rpcState);
		return {
			lifecycle: state.lifecycle,
			ownerLive: true,
			cwd: workspace,
			branch,
			gitDelta,
			lastActivityAt,
			observedSignals,
			risk: deleted ? "deleted-worktree" : "normal",
			rpcLive,
			rpcLastFrameAt,
			readyForSubmit: submitGateReason === null,
			submitUnavailableReason: submitGateReason,
		};
	}

	async #validate(requestSignal: AbortSignal): Promise<PrimitiveResponse> {
		return this.#withOwnedValidationWork(requestSignal, async signal => {
			const state = await this.#loadState();
			const canceledResponse = async (evidence: Record<string, unknown>): Promise<PrimitiveResponse> => {
				const latest = await readSessionState(this.#opts.root, this.#opts.sessionId);
				if (!latest) throw new Error(`session_not_found:${this.#opts.sessionId}`);
				return this.#response(latest, evidence, false);
			};
			if (signal.aborted) return canceledResponse({ canceled: true, validation: [] });
			if (state.handle.mode === "review") {
				// Review-only sessions do not run implementation validation and never attach PR metadata.
				const updated = await this.#persistValidationLifecycle(signal, "validating");
				if (updated.persisted) await this.#emit("info", "validated", { count: 0, reviewOnly: true });
				return this.#response(updated.state, { validation: [], reviewOnly: true }, updated.persisted);
			}
			const checks = this.#finalizeChecks ?? defaultFinalizeChecks(state.handle.workspace);
			const commit = await checks.resolveCommit();
			if (signal.aborted) return canceledResponse({ canceled: true, validation: [] });
			const subject: ReceiptSubject = {
				workspace: state.handle.workspace,
				branch: state.handle.branch,
				head: commit,
				commit,
			};
			const validation: { name: string; valid: boolean; exitStatus: number }[] = [];
			for (const spec of this.#validationCommands ?? []) {
				if (signal.aborted) return canceledResponse({ canceled: true, validation });
				let run: ValidationRun;
				try {
					run = await checks.runValidation(spec, signal);
				} catch (caught) {
					if (caught instanceof ValidationObservationUncertainError) {
						if (signal.aborted) return canceledResponse({ canceled: true, validation });
						const updated = await this.#persistValidationLifecycle(signal, "blocked", [
							`validation-unknown:${spec.name}`,
						]);
						if (updated.persisted) {
							await this.#emit("critical", "validation_uncertain", {
								name: spec.name,
								exactCommand: caught.exactCommand,
								cwd: caught.cwd,
							});
						}
						return this.#response(updated.state, { uncertain: true, name: spec.name, validation }, false);
					}
					throw caught;
				}
				if (signal.aborted) return canceledResponse({ canceled: true, validation });
				const evidence: ValidationEvidence = {
					command: spec.name,
					exactCommand: run.exactCommand,
					cwd: run.cwd,
					exitStatus: run.exitStatus,
					pass: run.pass,
					commitUnderTest: commit,
				};
				const receipt = buildReceipt<ValidationEvidence>({
					receiptId: `val-${Date.now()}-${randomBytes(4).toString("hex")}`,
					sessionId: this.#opts.sessionId,
					family: "validation",
					source: "owner",
					subject,
					evidence,
					valid: run.pass,
				});
				const entry = await this.#persistOwnedReceipt(signal, "validation", receipt);
				if (!entry) return canceledResponse({ canceled: true, validation });
				validation.push({ name: spec.name, valid: validateReceipt(receipt).valid, exitStatus: run.exitStatus });
			}
			const updated = await this.#persistValidationLifecycle(signal, "validating");
			if (updated.persisted) await this.#emit("info", "validated", { count: validation.length });
			return this.#response(updated.state, { validation }, updated.persisted);
		});
	}

	async #recover(): Promise<PrimitiveResponse> {
		const obs = await this.#observeGit();
		const state = await this.#loadState();
		const recoveringPriorVanish = state.blockers.some(isOwnerVanishedBlocker);
		const recoveryObservation: Observation = recoveringPriorVanish
			? { ...obs, ownerLive: false, risk: obs.gitDelta === "dirty" ? "vanished-dirty" : obs.risk }
			: obs;
		const decision = classifyRecovery({ observation: recoveryObservation, retryBudget: { ...DEFAULT_RETRY_BUDGET } });
		let vanishReceiptId: string | null = null;
		if (requiresVanishBeforeAction(decision.classification)) {
			const dirty = recoveryObservation.gitDelta === "dirty" || recoveryObservation.gitDelta === "unknown";
			const p = dirty ? preserveDirtyWorktree(recoveryObservation.cwd) : null;
			const evidence: VanishEvidence = {
				classification: decision.classification,
				gitDelta: recoveryObservation.gitDelta,
				gitStatusPorcelain: p
					? `tracked:${p.trackedDiffSha256};untracked:${p.untrackedManifest.length}`
					: recoveryObservation.observedSignals.join(","),
				untrackedManifest: p?.untrackedManifest ?? [],
				preservation: p?.stashRef ? "stash" : "snapshot",
				stashRef: p?.stashRef ?? null,
				snapshotComplete: p?.snapshotComplete ?? true,
				forbiddenActions: dirty ? ["restart-clean", "delete", "reset"] : [],
			};
			const receipt = buildReceipt<VanishEvidence>({
				receiptId: `vanish-${Date.now()}-${randomBytes(4).toString("hex")}`,
				sessionId: this.#opts.sessionId,
				family: "vanish",
				source: "owner",
				subject: {
					workspace: recoveryObservation.cwd,
					branch: recoveryObservation.branch,
					head: null,
					commit: null,
				},
				evidence,
			});
			await writeReceiptImmutable(this.#opts.root, this.#opts.sessionId, "vanish", receipt.receiptId, receipt);
			vanishReceiptId = receipt.receiptId;
		}
		if (vanishReceiptId) {
			state.blockers = state.blockers.filter(blocker => !isOwnerVanishedBlocker(blocker));
			state.lifecycle = state.blockers.length === 0 ? "observing" : state.lifecycle;
			state.updatedAt = new Date(this.#opts.clock ? this.#opts.clock() : Date.now()).toISOString();
			await writeSessionState(this.#opts.root, state);
		}
		await this.#emit(decision.severity, "recover_classified", { classification: decision.classification });
		return this.#response(state, { decision, observation: recoveryObservation, vanishReceiptId });
	}

	async #operate(input: Record<string, unknown>, requestSignal: AbortSignal): Promise<PrimitiveResponse> {
		return this.#withOwnedValidationWork(requestSignal, signal => this.#operateOwned(input, signal));
	}

	async #operateOwned(input: Record<string, unknown>, signal: AbortSignal): Promise<PrimitiveResponse> {
		const goal = typeof input.goal === "string" ? input.goal : "";
		const state = await this.#loadState();
		if (!goal) return this.#response(state, { error: "empty-goal" }, false);
		const baseChecks = this.#finalizeChecks ?? defaultFinalizeChecks(state.handle.workspace);
		const finalizeChecks = this.#finalizeChecksForOwner(baseChecks, signal);
		const emitOperateEvent = async (
			severity: Severity,
			kind: string,
			evidence: Record<string, unknown>,
		): Promise<void> => {
			if (signal.aborted) return;
			if (kind === "operate_blocked" || kind === "operate_finalized") {
				const lifecycle = kind === "operate_finalized" && evidence.completed === true ? "completed" : "blocked";
				const blockers = Array.isArray(evidence.blockers)
					? evidence.blockers.filter((blocker): blocker is string => typeof blocker === "string")
					: lifecycle === "completed"
						? []
						: undefined;
				const persisted = await this.#persistValidationLifecycle(signal, lifecycle, blockers);
				if (!persisted.persisted) return;
			}
			await this.#emit(severity, kind, evidence);
		};
		const result: OperateResult = await operate(goal, {
			root: this.#opts.root,
			sessionId: this.#opts.sessionId,
			workspace: state.handle.workspace,
			branch: state.handle.branch ?? "",
			transport: this.#opts.transport,
			observe: () => this.#observeGit(),
			finalizeChecks,
			validationCommands: this.#validationCommands,
			maxIterations: typeof input.maxIterations === "number" ? input.maxIterations : 5,
			emit: emitOperateEvent,
		});
		if (signal.aborted) {
			const latest = await readSessionState(this.#opts.root, this.#opts.sessionId);
			if (!latest) throw new Error(`session_not_found:${this.#opts.sessionId}`);
			return this.#response(latest, { canceled: true, operate: result }, false);
		}
		// Persist the loop's lifecycle/blockers from a fresh state under the same lock
		// as retire so an older operation snapshot cannot resurrect terminal state.
		const persisted = await this.#persistValidationLifecycle(signal, result.lifecycle, result.blockers);
		return this.#response(persisted.state, { operate: result }, result.completed && persisted.persisted);
	}

	async #finalize(input: Record<string, unknown>, requestSignal: AbortSignal): Promise<PrimitiveResponse> {
		return this.#withOwnedValidationWork(requestSignal, signal => this.#finalizeOwned(input, signal));
	}

	async #finalizeOwned(input: Record<string, unknown>, signal: AbortSignal): Promise<PrimitiveResponse> {
		const state = await this.#loadState();
		const workspace = state.handle.workspace;
		const checks = this.#finalizeChecksForOwner(this.#finalizeChecks ?? defaultFinalizeChecks(workspace), signal);
		const reviewOnly = state.handle.mode === "review";
		const inputVerdict = reviewOnly ? (typeof input.verdict === "string" ? input.verdict : null) : undefined;
		// Review-only finalize with no explicit verdict pulls the final assistant text from the live
		// RPC owner so the verdict can be extracted deterministically instead of demanded from the operator.
		let assistantText: string | null = null;
		if (reviewOnly && inputVerdict == null && this.#opts.transport.getLastAssistantText) {
			assistantText = await this.#opts.transport.getLastAssistantText().catch(() => null);
		}
		if (signal.aborted) {
			const latest = await readSessionState(this.#opts.root, this.#opts.sessionId);
			if (!latest) throw new Error(`session_not_found:${this.#opts.sessionId}`);
			return this.#response(latest, { canceled: true }, false);
		}
		const fin = await runFinalize({
			root: this.#opts.root,
			sessionId: this.#opts.sessionId,
			workspace,
			branch: state.handle.branch ?? "",
			reviewOnly,
			verdict: inputVerdict,
			assistantText: reviewOnly ? assistantText : undefined,
			prTarget: reviewOnly ? state.handle.issueOrPr : undefined,
			requireTests: input.requireTests !== false,
			requireCommit: input.requireCommit !== false,
			requirePr: input.requirePr !== false,
			validationCommands: this.#validationCommands,
			checks,
			signal,
			clock: this.#opts.clock,
		});
		if (signal.aborted) {
			const latest = await readSessionState(this.#opts.root, this.#opts.sessionId);
			if (!latest) throw new Error(`session_not_found:${this.#opts.sessionId}`);
			return this.#response(latest, { canceled: true, finalize: fin }, false);
		}
		const persisted = await this.#persistValidationLifecycle(
			signal,
			fin.completed ? "completed" : "blocked",
			fin.completed ? undefined : fin.blockers,
		);
		if (!persisted.persisted) {
			return this.#response(persisted.state, { canceled: signal.aborted, finalize: fin }, false);
		}
		await this.#emit(fin.completed ? "info" : "critical", "finalized", {
			completed: fin.completed,
			blockers: fin.blockers,
			...(reviewOnly ? { verdict: fin.verdict ?? null, reviewOnly: true } : {}),
		});
		return this.#response(persisted.state, { finalize: fin }, fin.completed);
	}

	async #submit(input: Record<string, unknown>): Promise<PrimitiveResponse> {
		const prompt = typeof input.prompt === "string" ? input.prompt : "";
		const state = await this.#loadState();
		if (!prompt) {
			return this.#response(
				state,
				{ accepted: false, submitted: false, reason: "empty-prompt" },
				false,
				"empty-prompt",
			);
		}
		const lifecycleGate = submitUnavailableReason(state.lifecycle, true);
		if (lifecycleGate) {
			return this.#response(
				state,
				{ accepted: false, submitted: false, reason: lifecycleGate },
				false,
				lifecycleGate,
			);
		}
		const result = await singleFlightAccept(this.#opts.transport, prompt, this.#opts.acceptanceTimeoutMs);
		if (result.accepted) {
			state.lifecycle = "observing";
			state.updatedAt = new Date(this.#opts.clock ? this.#opts.clock() : Date.now()).toISOString();
			await writeSessionState(this.#opts.root, state);
			await this.#emit("info", "prompt_accepted", {
				reason: result.reason,
				agentStartCursor: result.agentStartCursor,
			});
		} else {
			await this.#emit("warn", "prompt_not_accepted", { reason: result.reason });
		}
		const submitGateReason = result.accepted ? null : result.reason === "pre-state-not-idle" ? "rpc-not-idle" : null;
		return this.#response(
			state,
			{
				accepted: result.accepted,
				submitted: result.commandId !== null,
				reason: result.reason,
				commandId: result.commandId,
				preSubmitCursor: result.preSubmitCursor,
				agentStartCursor: result.agentStartCursor,
				acceptanceEvidence: result.preSubmitState,
			},
			result.accepted,
			submitGateReason,
		);
	}

	async #observe(): Promise<PrimitiveResponse> {
		// Observation is a read barrier over every frame accepted before this request.
		// Without it, a fast poll can read state/event storage while the serial frame
		// pump is still persisting a terminal event, losing sticky completion evidence.
		await this.#framePump;
		const state = await this.#loadState();
		if (this.#framePumpFailure !== null) {
			const failedState: SessionState = {
				...state,
				lifecycle: "blocked",
				blockers: [...new Set([...state.blockers, "frame-persistence-failed"])],
			};
			return this.#response(
				failedState,
				{
					observation: {
						lifecycle: "blocked",
						observedSignals: ["frame-persistence-failed"],
						rpcLive: this.#opts.transport.isLive?.() ?? true,
					},
					framePumpFailure: { severity: "critical", error: String(this.#framePumpFailure) },
					ownerRouted: true,
				},
				false,
			);
		}
		const observation = await this.#observeGit();
		const submitGateReason =
			typeof observation.submitUnavailableReason === "string" ? observation.submitUnavailableReason : null;
		return this.#response(state, { observation, ownerRouted: true }, true, submitGateReason);
	}

	#retire(): Promise<PrimitiveResponse> {
		if (this.#retirePromise) return this.#retirePromise;
		this.#retiring = true;
		this.#retirePromise = this.#retireOnce();
		void this.#retirePromise.then(
			() => queueMicrotask(() => void this.stop().catch(() => {})),
			() => {},
		);
		return this.#retirePromise;
	}

	async #retireOnce(): Promise<PrimitiveResponse> {
		// Fence new mutating work first, then abort validation and join every request
		// that could still commit state or a receipt before recording retirement.
		await this.#stopActiveValidationWork();
		await this.#joinRetirementSensitiveWork();
		const state = await this.#withLifecycleMutation(async () => {
			const current = await readSessionState(this.#opts.root, this.#opts.sessionId);
			if (!current) throw new Error(`session_not_found:${this.#opts.sessionId}`);
			current.lifecycle = "retired";
			current.updatedAt = new Date(this.#opts.clock ? this.#opts.clock() : Date.now()).toISOString();
			await writeSessionState(this.#opts.root, current);
			return current;
		});
		await this.#emit("info", "owner_retired", {});
		return this.#response(state, { retired: true });
	}

	stop(): Promise<void> {
		// Every public caller receives the one truthful shared teardown result. Only
		// the object capability passed to the exact transport.close() invocation can
		// break a direct cleanup cycle; ambient synchronous callers have no bypass.
		if (this.#stopPromise) return this.#stopPromise;
		const pending = Promise.withResolvers<void>();
		this.#stopPromise = pending.promise;
		void this.#stopUntilVerified().then(pending.resolve, pending.reject);
		return pending.promise;
	}

	#closeTransport(): Promise<void> {
		let available = true;
		// `available` is the authority boundary; freezing the wrapper is only
		// defense-in-depth against mutation by the receiving transport.
		const context: HarnessSessionTransportCloseContext = Object.freeze({
			acknowledgeDirectOwnerStopReentry(): Promise<void> {
				if (!available) throw new Error("Runtime owner direct stop reentry capability is no longer available.");
				available = false;
				return Promise.resolve();
			},
		});
		try {
			return this.#opts.transport.close(context);
		} finally {
			// An async close implementation runs synchronously until it returns its
			// promise. Expire the capability at that boundary so descendants cannot
			// acquire completion authority after the direct invocation.
			available = false;
		}
	}

	async #stopUntilVerified(): Promise<void> {
		this.#lastStopFailures = [];
		this.#reportedStopFailures.clear();
		for (let attempt = 1; ; attempt++) {
			try {
				await this.#stopOnce();
				if (this.#framePumpFailure !== null) {
					throw new FramePumpAfterVerifiedCleanupError(
						[this.#framePumpFailure, ...flattenAggregateCauses(this.#lastStopFailures)],
						`Runtime owner frame pump failed after verified cleanup: ${String(this.#framePumpFailure)}`,
					);
				}
				return;
			} catch (error) {
				if (error instanceof FramePumpAfterVerifiedCleanupError) throw error;
				if (this.#lastStopFailures.length === MAX_RETAINED_CLEANUP_FAILURES) this.#lastStopFailures.shift();
				this.#lastStopFailures.push(error);
				if (attempt >= this.#opts.cleanupRetryLimit)
					throw new AggregateError(
						[
							...(this.#framePumpFailure === null ? [] : [this.#framePumpFailure]),
							...flattenAggregateCauses(this.#lastStopFailures),
						],
						"Runtime owner cleanup could not be verified.",
					);
				await Bun.sleep(this.#opts.cleanupRetryMs);
			}
		}
	}

	async #reportStopFailure(kind: string, error: unknown): Promise<unknown | null> {
		if (this.#reportedStopFailures.has(kind)) return null;
		this.#reportedStopFailures.add(kind);
		try {
			await this.#emit("critical", kind, { error: String(error) });
			return null;
		} catch (reportError) {
			return reportError;
		}
	}

	async #stopOnce(): Promise<void> {
		const failures: unknown[] = [];
		const recordFailure = async (kind: string, error: unknown): Promise<void> => {
			failures.push(error);
			const reportFailure = await this.#reportStopFailure(kind, error);
			if (reportFailure !== null) failures.push(reportFailure);
		};
		// A retirement already in progress must finish its state commit before stop
		// tears down the endpoint or relinquishes the lease.
		if (this.#retirePromise) await this.#retirePromise;
		// Validation owns independent subprocess groups. Cancel and join those exact
		// requests before transport/endpoint teardown can surrender the owner lease.
		await this.#stopActiveValidationWork();
		await this.#joinRetirementSensitiveWork();
		const unsubscribe = this.#unsubscribeFrames;
		if (unsubscribe) {
			try {
				unsubscribe();
				this.#unsubscribeFrames = null;
			} catch (error) {
				await recordFailure("owner_unsubscribe_failed", error);
			}
		}
		await this.#framePump;

		// The transport owns the exact spawned child. Do not surrender the lease while
		// it is unverified; once each stage succeeds, retain that proof across retries.
		if (!this.#transportClosed) {
			try {
				await this.#closeTransport();
				this.#transportClosed = true;
			} catch (error) {
				await recordFailure("owner_transport_stop_failed", error);
			}
		}
		if (!this.#transportClosed) throw new AggregateError(failures, "Runtime owner transport cleanup failed.");

		if (!this.#serverClosed) {
			try {
				await this.#server.close();
				this.#serverClosed = true;
			} catch (error) {
				await recordFailure("owner_server_stop_failed", error);
			}
		}
		if (!this.#serverClosed) throw new AggregateError(failures, "Runtime owner endpoint cleanup failed.");

		// Transport and endpoint are verified closed, so we are committed to
		// surrendering the lease. Stop, fence, and join the heartbeat first: an
		// in-flight or scheduled renewal would otherwise contend the lease mutation
		// lock with releaseLease and can starve it (lease_lock_timeout). Fencing
		// before release preserves exact-owner fencing — a fenced owner never renews,
		// so it can neither revive its own lease nor touch a successor's.
		await this.#fenceHeartbeat();

		if (this.#leaseHeld) {
			try {
				await this.#opts.leaseRelease(this.#opts.root, this.#opts.sessionId, this.ownerId);
				this.#leaseHeld = false;
			} catch (error) {
				if (error instanceof LeaseError && error.code === "not_lease_holder") {
					// A successor already owns the lease. Our transport and endpoint are
					// verified closed, so there is no old authority left to release.
					this.#leaseHeld = false;
				} else {
					await recordFailure("owner_lease_release_failed", error);
				}
			}
		}
		if (this.#leaseHeld) throw new AggregateError(failures, "Runtime owner lease cleanup failed.");

		// Heartbeat was already fenced before the lease release above; this is a
		// defensive no-op that also covers any path that skipped the release stage.
		if (this.#heartbeatTimer) {
			clearInterval(this.#heartbeatTimer);
			this.#heartbeatTimer = null;
		}
		if (failures.length > 0) throw new AggregateError(failures, "Runtime owner cleanup failed.");
	}

	/**
	 * Permanently stop the lease heartbeat and drain every in-flight renewal.
	 *
	 * Fencing is terminal: `#heartbeatFenced` stays set so no scheduled interval
	 * callback can start a new renewal after teardown begins. The interval is
	 * cleared, then EVERY renewal already started (there may be more than one, since
	 * `setInterval` does not wait for the async `heartbeat()` of a prior tick) is
	 * awaited so each releases the lease mutation lock before the release path
	 * acquires it. This eliminates heartbeat/release self-contention on the
	 * non-FIFO lock (lease_lock_timeout) without weakening exact-owner fencing.
	 */
	async #fenceHeartbeat(): Promise<void> {
		this.#heartbeatFenced = true;
		if (this.#heartbeatTimer) {
			clearInterval(this.#heartbeatTimer);
			this.#heartbeatTimer = null;
		}
		// Snapshot then drain: no new renewal can be added once fenced, so this
		// settles every renewal that could still hold or be waiting on the lock.
		const inFlight = [...this.#heartbeatInFlight];
		this.#heartbeatInFlight.clear();
		if (inFlight.length > 0) await Promise.allSettled(inFlight);
	}
}

export interface ResolvedOwner {
	live: boolean;
	socketPath: string | null;
	lease: SessionLease | null;
}

/** Determine whether a live owner currently holds the session (for CLI routing). */
export async function resolveOwner(root: string, sessionId: string): Promise<ResolvedOwner> {
	const lease = await readLease(root, sessionId);
	if (!lease) return { live: false, socketPath: null, lease: null };
	const status = classifyLeaseStatus(lease);
	// Owner process alive (live / lease-expired-but-alive / EPERM-alive) => endpoint reachable => routable.
	const live = status === "live" || status === "expiredAlive" || status === "epermAlive";
	return { live, socketPath: lease.endpoint?.path ?? null, lease };
}

/**
 * Owner liveness for verbs that do not route to the owner (e.g. `classify`): a routable owner
 * has a live lease and a socket endpoint. This is the same lease/socket probe `observe` uses to
 * decide routing, so non-routing verbs derive `ownerLive` consistently instead of assuming the
 * owner is gone (which would misclassify a live owner as vanished/restart-clean).
 */
export async function resolveOwnerLive(root: string, sessionId: string): Promise<boolean> {
	const owner = await resolveOwner(root, sessionId);
	return owner.live && owner.socketPath !== null;
}

/**
 * RuntimeOwner — the detached per-session process that makes live control honest.
 *
 * Responsibilities:
 *  - hold the {@link SessionLease} (single writer),
 *  - own the {@link HarnessRpc} subprocess (injected; real `GajaeCodeRpc` in prod, fake in tests),
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
import { observeRpcOutboundFrame } from "../modes/shared/agent-wire/event-observation";
import { classifyRecovery } from "./classifier";
import { ControlServer, type EndpointRequest } from "./control-endpoint";
import { defaultFinalizeChecks, type FinalizeChecks, runFinalize, type ValidationCommandSpec } from "./finalize";
import { type OperateResult, operate } from "./operate";
import { preserveDirtyWorktree } from "./preserve";
import { RECEIPT_SPOOL_DIR_ENV, withReceiptSpoolDir } from "./receipt-spool";
import {
	buildReceipt,
	type ReceiptSubject,
	requiresVanishBeforeAction,
	type ValidationEvidence,
	type VanishEvidence,
	validateReceipt,
} from "./receipts";
import { type HarnessRpc, type RpcStateSnapshot, singleFlightAccept } from "./rpc-adapter";
import {
	acquireLease,
	canWriteEvents,
	classifyLeaseStatus,
	heartbeat,
	readLease,
	releaseLease,
	type SessionLease,
} from "./session-lease";
import { buildStateView, nextAllowedActions, submitUnavailableReason } from "./state-machine";
import {
	appendEvent,
	controlSocketPath,
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

export interface OwnerOptions {
	root: string;
	sessionId: string;
	rpc: HarnessRpc;
	ownerId?: string;
	ttlMs?: number;
	heartbeatMs?: number;
	acceptanceTimeoutMs?: number;
	clock?: () => number;
	finalizeChecks?: FinalizeChecks;
	validationCommands?: ValidationCommandSpec[];
}

export interface OwnerStartInfo {
	ownerId: string;
	socketPath: string;
	leaseEpoch: number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_ACCEPT_TIMEOUT_MS = 60_000;

export class RuntimeOwner {
	readonly ownerId: string;
	#opts: Required<Omit<OwnerOptions, "clock" | "finalizeChecks" | "validationCommands">> & { clock?: () => number };
	#server: ControlServer;
	#cursor = 0;
	#leaseEpoch = 0;
	#heartbeatTimer: NodeJS.Timeout | null = null;
	#socketPath: string;
	#finalizeChecks?: FinalizeChecks;
	#validationCommands?: ValidationCommandSpec[];
	#unsubscribeFrames: (() => void) | null = null;
	#framePump: Promise<void> = Promise.resolve();
	#coalesced = new Map<string, true>();

	constructor(opts: OwnerOptions) {
		this.ownerId = opts.ownerId ?? `owner-${randomUUID()}`;
		this.#socketPath = controlSocketPath(opts.root, opts.sessionId);
		this.#opts = {
			root: opts.root,
			sessionId: opts.sessionId,
			rpc: opts.rpc,
			ownerId: this.ownerId,
			ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
			heartbeatMs: opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
			acceptanceTimeoutMs: opts.acceptanceTimeoutMs ?? DEFAULT_ACCEPT_TIMEOUT_MS,
			clock: opts.clock,
		};
		this.#finalizeChecks = opts.finalizeChecks;
		this.#validationCommands = opts.validationCommands;
		this.#server = new ControlServer(this.#socketPath, req => this.#handle(req));
	}

	async start(): Promise<OwnerStartInfo> {
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
		this.#leaseEpoch = lease.leaseEpoch;
		await this.#server.listen();
		await this.#emit("info", "owner_started", { ownerId: this.ownerId, leaseEpoch: this.#leaseEpoch });
		if (this.#opts.rpc.onEventFrame) {
			this.#unsubscribeFrames = this.#opts.rpc.onEventFrame(frame => this.#handleFrame(frame));
		}
		this.#heartbeatTimer = setInterval(() => {
			void heartbeat(root, sessionId, this.ownerId, this.#opts.ttlMs, this.#opts.clock).catch(err => {
				// Self-stop if a legitimate dead-owner takeover revoked our lease.
				if (err instanceof Error && err.message.includes("not_lease_holder")) void this.stop();
			});
		}, this.#opts.heartbeatMs);
		this.#heartbeatTimer.unref?.();
		return { ownerId: this.ownerId, socketPath: this.#socketPath, leaseEpoch: this.#leaseEpoch };
	}

	async #loadState(): Promise<SessionState> {
		const state = await readSessionState(this.#opts.root, this.#opts.sessionId);
		if (!state) throw new Error(`session_not_found:${this.#opts.sessionId}`);
		const reconciled = reconcileLiveOwnerState(state);
		if (reconciled.reconciled) {
			await writeSessionState(this.#opts.root, reconciled.state);
			return reconciled.state;
		}
		return state;
	}

	/** Map an RPC frame and route it: semantic/signal-bearing -> serial emit; high-frequency progress -> coalesce. */
	#handleFrame(frame: Record<string, unknown>): void {
		const mapped = observeRpcOutboundFrame(frame);
		if (!mapped) return;
		if (mapped.semantic || (mapped.signal && !mapped.coalesceKey)) {
			this.#framePump = this.#framePump
				.then(() => this.#flushCoalesced())
				.then(() => this.#emitMapped(mapped))
				.catch(() => {});
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
		await this.#emit("info", "rpc_activity", { coalescedFrames });
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
				await writeSessionState(this.#opts.root, state);
			}
		}
		await this.#emit(
			mapped.severity,
			mapped.kind,
			mapped.signal ? { ...mapped.evidence, signal: mapped.signal } : mapped.evidence,
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

	async #emit(severity: Severity, kind: string, evidence: Record<string, unknown>): Promise<void> {
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
		await appendEvent(this.#opts.root, this.#opts.sessionId, envelope);
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

	#submitGateReason(state: SessionState, rpcState: RpcStateSnapshot | null): string | null {
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

	async #handle(req: EndpointRequest): Promise<unknown> {
		switch (req.verb) {
			case "ping":
				return { ok: true, ownerId: this.ownerId, leaseEpoch: this.#leaseEpoch };
			case "submit":
				return this.#submit(req.input);
			case "observe":
				return this.#observe();
			case "retire":
				return this.#retire();
			case "finalize":
				return this.#withReceiptSpoolFromInput(req.input, () => this.#finalize(req.input));
			case "recover":
				return this.#withReceiptSpoolFromInput(req.input, () => this.#recover());
			case "validate":
				return this.#withReceiptSpoolFromInput(req.input, () => this.#validate());
			case "operate":
				return this.#withReceiptSpoolFromInput(req.input, () => this.#operate(req.input));
			default:
				return { ok: false, error: `owner_unsupported_verb:${req.verb}` };
		}
	}

	async #observeGit(): Promise<Observation> {
		const state = await this.#loadState();
		const workspace = state.handle.workspace;
		let streaming = false;
		let rpcState: RpcStateSnapshot | null = null;
		try {
			rpcState = await this.#opts.rpc.getState();
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
		const rpcLive = this.#opts.rpc.isLive ? this.#opts.rpc.isLive() : rpcState !== null;
		const rpcLastFrameAt = this.#opts.rpc.lastFrameAt ? this.#opts.rpc.lastFrameAt() : null;
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

	async #validate(): Promise<PrimitiveResponse> {
		const state = await this.#loadState();
		if (state.handle.mode === "review") {
			// Review-only sessions do not run implementation validation and never attach PR metadata.
			state.lifecycle = "validating";
			state.updatedAt = new Date(this.#opts.clock ? this.#opts.clock() : Date.now()).toISOString();
			await writeSessionState(this.#opts.root, state);
			await this.#emit("info", "validated", { count: 0, reviewOnly: true });
			return this.#response(state, { validation: [], reviewOnly: true });
		}
		const checks = this.#finalizeChecks ?? defaultFinalizeChecks(state.handle.workspace);
		const commit = await checks.resolveCommit();
		const subject: ReceiptSubject = {
			workspace: state.handle.workspace,
			branch: state.handle.branch,
			head: commit,
			commit,
		};
		const validation: { name: string; valid: boolean; exitStatus: number }[] = [];
		for (const spec of this.#validationCommands ?? []) {
			const run = await checks.runValidation(spec);
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
			await writeReceiptImmutable(this.#opts.root, this.#opts.sessionId, "validation", receipt.receiptId, receipt);
			validation.push({ name: spec.name, valid: validateReceipt(receipt).valid, exitStatus: run.exitStatus });
		}
		state.lifecycle = "validating";
		state.updatedAt = new Date(this.#opts.clock ? this.#opts.clock() : Date.now()).toISOString();
		await writeSessionState(this.#opts.root, state);
		await this.#emit("info", "validated", { count: validation.length });
		return this.#response(state, { validation });
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

	async #operate(input: Record<string, unknown>): Promise<PrimitiveResponse> {
		const goal = typeof input.goal === "string" ? input.goal : "";
		let state = await this.#loadState();
		if (!goal) return this.#response(state, { error: "empty-goal" }, false);
		const emitOperateEvent = async (
			severity: Severity,
			kind: string,
			evidence: Record<string, unknown>,
		): Promise<void> => {
			if (kind === "operate_blocked" || kind === "operate_finalized") {
				const terminalState = await this.#loadState();
				terminalState.lifecycle =
					kind === "operate_finalized" && evidence.completed === true ? "completed" : "blocked";
				terminalState.blockers = Array.isArray(evidence.blockers)
					? evidence.blockers.filter((blocker): blocker is string => typeof blocker === "string")
					: terminalState.lifecycle === "completed"
						? []
						: terminalState.blockers;
				terminalState.updatedAt = new Date(this.#opts.clock ? this.#opts.clock() : Date.now()).toISOString();
				await writeSessionState(this.#opts.root, terminalState);
			}
			await this.#emit(severity, kind, evidence);
		};
		const result: OperateResult = await operate(goal, {
			root: this.#opts.root,
			sessionId: this.#opts.sessionId,
			workspace: state.handle.workspace,
			branch: state.handle.branch ?? "",
			rpc: this.#opts.rpc,
			observe: () => this.#observeGit(),
			finalizeChecks: this.#finalizeChecks ?? defaultFinalizeChecks(state.handle.workspace),
			validationCommands: this.#validationCommands,
			maxIterations: typeof input.maxIterations === "number" ? input.maxIterations : 5,
			emit: emitOperateEvent,
		});
		// Persist the loop's terminal lifecycle/blockers so the response state is not stale.
		state = await this.#loadState();
		state.lifecycle = result.lifecycle;
		state.blockers = result.blockers;
		state.updatedAt = new Date(this.#opts.clock ? this.#opts.clock() : Date.now()).toISOString();
		await writeSessionState(this.#opts.root, state);
		return this.#response(state, { operate: result }, result.completed);
	}

	async #finalize(input: Record<string, unknown>): Promise<PrimitiveResponse> {
		const state = await this.#loadState();
		const workspace = state.handle.workspace;
		const checks = this.#finalizeChecks ?? defaultFinalizeChecks(workspace);
		const reviewOnly = state.handle.mode === "review";
		const inputVerdict = reviewOnly ? (typeof input.verdict === "string" ? input.verdict : null) : undefined;
		// Review-only finalize with no explicit verdict pulls the final assistant text from the live
		// RPC owner so the verdict can be extracted deterministically instead of demanded from the operator.
		let assistantText: string | null = null;
		if (reviewOnly && inputVerdict == null && this.#opts.rpc.getLastAssistantText) {
			assistantText = await this.#opts.rpc.getLastAssistantText().catch(() => null);
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
			clock: this.#opts.clock,
		});
		state.lifecycle = fin.completed ? "completed" : "blocked";
		state.updatedAt = new Date(this.#opts.clock ? this.#opts.clock() : Date.now()).toISOString();
		if (!fin.completed) state.blockers = fin.blockers;
		await writeSessionState(this.#opts.root, state);
		await this.#emit(fin.completed ? "info" : "critical", "finalized", {
			completed: fin.completed,
			blockers: fin.blockers,
			...(reviewOnly ? { verdict: fin.verdict ?? null, reviewOnly: true } : {}),
		});
		return this.#response(state, { finalize: fin }, fin.completed);
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
		const result = await singleFlightAccept(this.#opts.rpc, prompt, this.#opts.acceptanceTimeoutMs);
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
		const state = await this.#loadState();
		const observation = await this.#observeGit();
		const submitGateReason =
			typeof observation.submitUnavailableReason === "string" ? observation.submitUnavailableReason : null;
		return this.#response(state, { observation, ownerRouted: true }, true, submitGateReason);
	}

	async #retire(): Promise<PrimitiveResponse> {
		const state = await this.#loadState();
		state.lifecycle = "retired";
		state.updatedAt = new Date(this.#opts.clock ? this.#opts.clock() : Date.now()).toISOString();
		await writeSessionState(this.#opts.root, state);
		await this.#emit("info", "owner_retired", {});
		queueMicrotask(() => void this.stop());
		return this.#response(state, { retired: true });
	}

	async stop(): Promise<void> {
		this.#unsubscribeFrames?.();
		this.#unsubscribeFrames = null;
		await this.#framePump.catch(() => {});
		if (this.#heartbeatTimer) {
			clearInterval(this.#heartbeatTimer);
			this.#heartbeatTimer = null;
		}
		await this.#server.close().catch(() => {});
		await this.#opts.rpc.close().catch(() => {});
		await releaseLease(this.#opts.root, this.#opts.sessionId, this.ownerId).catch(() => {});
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

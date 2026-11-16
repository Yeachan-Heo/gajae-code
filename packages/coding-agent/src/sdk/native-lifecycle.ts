import { AsyncLocalStorage } from "node:async_hooks";
import * as crypto from "node:crypto";
import type { ExternalStopAdmissionLease } from "../session/agent-session";
import type {
	PendingResumeOp,
	ReconcileResult,
	ResumeClosureEvidence,
	ResumeCompletionRefusal,
	ResumeRetirementEvidence,
	ResumeRouting,
	ResumeTerminationAuthorization,
} from "../session/resume-operation";
import type { SessionManager } from "../session/session-manager";
import {
	acquireEmbeddedStopAdmission,
	cancelEmbeddedOwnedWork,
	type EmbeddedOwnedWork,
	type EmbeddedWorkConsent,
	type EmbeddedWorkSource,
	type EmbeddedWorkTarget,
	getEmbeddedOwnedWork,
} from "./embedded-work";

export type NativeReconcileMode = "verify" | "verifyReadOnly" | "repairDurability" | "complete";

/** Internal IO adapter. Only the native factory supplies these callbacks. */
export interface NativeLifecycleDriver {
	readonly manager: SessionManager;
	readonly workSource?: EmbeddedWorkSource;
	reconcile(op: PendingResumeOp, mode: NativeReconcileMode, routing: ResumeRouting): Promise<ReconcileResult>;
	captureAfterClose(
		op: PendingResumeOp,
		routing: ResumeRouting,
		closure?: ResumeClosureEvidence,
	): Promise<ReconcileResult>;
	getClosureEvidence(
		op: PendingResumeOp,
		authorization: ResumeTerminationAuthorization,
	): Promise<ResumeClosureEvidence | undefined>;
	retire(
		op: PendingResumeOp,
		result: ReconcileResult,
		authorization: ResumeTerminationAuthorization,
	): Promise<ResumeRetirementEvidence | undefined>;
}

const handleBrand: unique symbol = Symbol("native lifecycle handle");
const consentBrand: unique symbol = Symbol("native termination consent");
export interface NativeLifecycleHandle {
	readonly [handleBrand]: true;
}
export interface NativeTerminationConsent {
	readonly [consentBrand]: true;
}

export interface NativeDisconnectPreparation {
	readonly epoch: number;
	readonly intentId: string;
	readonly heldIds: readonly string[];
	readonly inventory?: EmbeddedOwnedWork;
}

export interface NativeDisconnectConsent {
	readonly stopAndJoin?: true;
	readonly discardUnpublished?: { readonly ids: readonly string[] };
	readonly work?: EmbeddedWorkConsent;
}

export interface NativeOpenCoordinator {
	readonly handle: NativeLifecycleHandle;
	resumeOpen(op: PendingResumeOp): Promise<ReconcileResult>;
	/** Register immediately after construction, before running startup that can fail. */
	recordRuntimeStarted(source: EmbeddedWorkSource): void;
	/** The factory's explicit successful handoff; invalidates OPEN authority atomically. */
	publishRuntime(): NativeLifecycleHandle;
	startupFailed(op: PendingResumeOp): Promise<ReconcileResult>;
	superseded(op: PendingResumeOp): Promise<ReconcileResult>;
	abortOpen(op: PendingResumeOp): Promise<ReconcileResult>;
}

type Readiness = "ready" | "fenced";
type Invocation = ResumeRouting["invocation"];
type Action = ResumeRouting["action"];
type CloseState = ResumeRouting["closeOutcome"];

interface ConsentRecord {
	readonly member: Member;
	readonly preparation: NativeDisconnectPreparation;
	readonly context: "owned_pre" | "runtime";
	readonly consent: NativeDisconnectConsent;
	started: boolean;
}

interface Member {
	readonly driver: NativeLifecycleDriver | Pick<NativeLifecycleDriver, "captureAfterClose">;
	readonly manager?: SessionManager;
	readonly handle: NativeLifecycleHandle;
	context: "owned_pre" | "runtime";
	token?: string;
	workSource?: EmbeddedWorkSource;
	readiness: Readiness;
	last?: ReconcileResult;
	lastOp?: PendingResumeOp;
	openReady: boolean;
	epoch: number;
	preparation?: NativeDisconnectPreparation;
	intent?: ResumeTerminationAuthorization;
	intentConsent?: NativeTerminationConsent;
	recordedConsent?: NativeTerminationConsent;
	runtimeCleanupComplete: boolean;
	closure?: ResumeClosureEvidence;
	retirement?: ResumeRetirementEvidence;
	lease?: ExternalStopAdmissionLease;
	pendingCalls: number;
	tail: Promise<void>;
}

const members = new WeakMap<NativeLifecycleHandle, Member>();
const managers = new WeakMap<SessionManager, Member>();
const preparations = new WeakMap<NativeDisconnectPreparation, Member>();
const consents = new WeakMap<NativeTerminationConsent, ConsentRecord>();

interface DisposalScope {
	readonly member: Member;
	readonly authorization: ResumeTerminationAuthorization;
	readonly context: Member["context"];
	readonly epoch: number;
	active: boolean;
	admitted: boolean;
}

const disposalScope = new AsyncLocalStorage<DisposalScope>();

/** Internal AgentSession admission guard; retry options never grant native authority. */
export function assertNativeDisposalAuthorized(manager: SessionManager): void {
	const member = managers.get(manager);
	if (!member) return;
	const scope = disposalScope.getStore();
	if (
		!scope ||
		!scope.active ||
		scope.member !== member ||
		members.get(member.handle) !== member ||
		member.manager !== manager ||
		member.intent !== scope.authorization ||
		member.context !== scope.context ||
		member.epoch !== scope.epoch
	)
		throw new Error("Native disposal requires registry termination authorization");
	const authorization = scope.authorization;
	const record = currentConsent(member, member.intentConsent);
	const valid =
		authorization.kind === "coordinator_abort"
			? member.context === "owned_pre" &&
				member.token !== undefined &&
				authorization.coordinatorOpenToken === member.token &&
				authorization.ownership === "owned_pre" &&
				authorization.runtimeHandoff === false
			: record?.started === true &&
				authorization.registryIntentId === record.preparation.intentId &&
				authorization.stopAdmitting === true &&
				authorization.runtime === (member.context === "runtime" ? "stopped_joined" : "not_published");
	const state = closeState(member);
	if (
		!valid ||
		!authorization.registryIntentId ||
		(state !== "none_started" && !(state === "in_flight" && scope.admitted))
	)
		throw new Error("Native disposal requires current live termination authorization");
	scope.admitted = true;
}

function disposeAuthorized(
	member: Member,
	authorization: ResumeTerminationAuthorization,
	source: EmbeddedWorkSource,
): Promise<void> {
	const scope: DisposalScope = {
		member,
		authorization,
		context: member.context,
		epoch: member.epoch,
		active: true,
		admitted: false,
	};
	return disposalScope.run(scope, () => {
		try {
			return source.result.session.dispose({ strictCloseAttempts: 1 });
		} finally {
			// Async descendants inherit this object, never a renewable admission.
			scope.active = false;
		}
	});
}

function memberFor(handle: NativeLifecycleHandle): Member {
	const member = members.get(handle);
	if (!member) throw new Error("Unknown native lifecycle handle");
	return member;
}

function serialized<T>(member: Member, run: () => Promise<T>): Promise<T> {
	member.pendingCalls++;
	const result = member.tail.then(async () => {
		try {
			return await run();
		} finally {
			member.pendingCalls--;
		}
	});
	member.tail = result.then(
		() => {},
		() => {},
	);
	return result;
}

function closeState(member: Member): CloseState {
	return member.manager?.getStrictCloseState().kind ?? "no_manager";
}

function routing(
	member: Member,
	invocation: Invocation,
	action: Action,
	options: {
		authorization?: ResumeTerminationAuthorization;
		refusal?: "termination_not_authorized" | "context_mismatch" | "manager_closed";
		completionResult?: ResumeRouting["completionResult"];
	} = {},
): ResumeRouting {
	const state = closeState(member);
	const terminal = state !== "none_started";
	return {
		contextFamily: terminal ? "terminal" : "live",
		context: terminal ? "terminal" : member.context,
		closeOutcome: state,
		invocation,
		authorization: {
			tokenValid: member.context === "owned_pre" && member.token !== undefined,
			terminationIntent: options.authorization?.kind ?? "none",
			intentValid: options.authorization !== undefined,
			refusal: options.refusal,
		},
		action,
		completionResult: options.completionResult ?? "n/a",
		readiness: { prior: member.readiness, current: terminal ? "n/a" : member.readiness },
	};
}

function annotate(result: ReconcileResult, route: ResumeRouting, refusal?: ResumeCompletionRefusal): ReconcileResult {
	const receipt = { ...result.receipt, routing: route, completionRefusal: refusal ?? result.refusal };
	return {
		outcome: {
			...result.outcome,
			context: route.contextFamily === "terminal" ? "POST" : route.context === "runtime" ? "WARM" : "PRE",
			receipt,
		},
		receipt,
		refusal: refusal ?? result.refusal,
	};
}

function remember(member: Member, op: PendingResumeOp, result: ReconcileResult): ReconcileResult {
	member.last = result;
	member.lastOp = op;
	if (result.receipt.routing.readiness.current !== "n/a") member.readiness = result.receipt.routing.readiness.current;
	member.openReady = false;
	return result;
}

function liveDriver(member: Member): NativeLifecycleDriver {
	if (!("reconcile" in member.driver)) throw new Error("Native handle has no live manager");
	return member.driver;
}

async function refuse(
	member: Member,
	op: PendingResumeOp,
	invocation: Invocation,
	reason: "termination_not_authorized" | "context_mismatch",
): Promise<ReconcileResult> {
	const route = routing(member, invocation, "RETAIN_LIVE", { refusal: reason });
	const prior =
		member.lastOp === op && member.last
			? member.last
			: await liveDriver(member).reconcile(op, "verifyReadOnly", route);
	// Refusals report the previous readiness, never a newly computed latch value.
	return annotate(prior, route, reason);
}

function validRetirement(
	member: Member,
	op: PendingResumeOp,
	result: ReconcileResult,
	receipt: ResumeRetirementEvidence,
): boolean {
	return (
		member.intent !== undefined &&
		member.closure !== undefined &&
		receipt.kind === "member_retired" &&
		receipt.registryIntentId === member.intent.registryIntentId &&
		receipt.memberToken === op.memberToken &&
		receipt.authorityKey === op.authorityKey &&
		receipt.epoch === op.epoch &&
		receipt.op === op.op &&
		receipt.finalCaptureDigest === member.closure.finalCaptureDigest &&
		result.receipt.terminalDisposition.reason === "retirement_permitted_not_applied"
	);
}

async function postReadonly(
	member: Member,
	op: PendingResumeOp,
	invocation: Invocation,
	retryAuthorized = false,
): Promise<ReconcileResult> {
	let state = closeState(member);
	if (state === "in_flight") {
		// Observing another owner's close must not call closeStrict again.
		await member.manager?.getStrictCloseCompletion();
		state = closeState(member);
	} else if (state === "close_failed_retryable" && invocation === "TERM" && retryAuthorized && member.intent) {
		await member.manager?.closeStrict();
		state = closeState(member);
	}
	const driver = member.driver;
	if (state === "closed" && member.intent && member.runtimeCleanupComplete && "getClosureEvidence" in driver) {
		try {
			member.closure = await driver.getClosureEvidence(op, member.intent);
		} catch {
			member.closure = undefined;
		}
	}
	const refusal = invocation !== "TERM" || !member.intent ? "manager_closed" : undefined;
	const route = routing(member, invocation, "POST_READONLY", {
		authorization: invocation === "TERM" ? member.intent : undefined,
		refusal,
	});
	let result = await driver.captureAfterClose(op, route, member.closure);
	// P_retire permission is not a mutation receipt. Only call the real adapter
	// after the classifier has proved R1-R5 for this fresh closed capture.
	if (
		invocation === "TERM" &&
		retryAuthorized &&
		state === "closed" &&
		member.intent &&
		member.runtimeCleanupComplete &&
		member.closure &&
		!member.retirement &&
		result.receipt.terminalDisposition.reason === "retirement_permitted_not_applied" &&
		"retire" in driver
	) {
		try {
			const retired = await driver.retire(op, result, member.intent);
			if (retired && validRetirement(member, op, result, retired)) member.retirement = retired;
		} catch {
			/* Failed/uncertain retirement never becomes a released receipt. */
		}
	}
	if (
		member.retirement &&
		member.closure &&
		member.retirement.finalCaptureDigest === member.closure.finalCaptureDigest &&
		result.receipt.terminalDisposition.reason === "retirement_permitted_not_applied"
	) {
		const receipt = {
			...result.receipt,
			terminalDisposition: {
				kind: "retired" as const,
				reason: "registry_retirement_recorded",
				receiptKind: result.outcome.kind,
			},
		};
		result = { ...result, receipt, outcome: { ...result.outcome, receipt } };
	}
	return remember(member, op, annotate(result, route, refusal));
}

async function reconcileLive(
	member: Member,
	op: PendingResumeOp,
	mode: NativeReconcileMode,
	invocation: "RECON" | "OPEN",
): Promise<ReconcileResult> {
	const route = routing(member, invocation, "RETAIN_LIVE");
	const result = await liveDriver(member).reconcile(op, mode, route);
	// The classifier, not remainingConflict or this registry, decides P_latch.
	return remember(member, op, result);
}

/** Always RECON: even a proven no-effect result never dispatches termination. */
export function reconcileNativeHandle(
	handle: NativeLifecycleHandle,
	op: PendingResumeOp,
	mode: NativeReconcileMode = "verify",
): Promise<ReconcileResult> {
	const member = memberFor(handle);
	return serialized(member, async () => {
		if (closeState(member) !== "none_started") return postReadonly(member, op, "RECON");
		const result = await reconcileLive(member, op, mode, "RECON");
		return closeState(member) !== "none_started" ? postReadonly(member, op, "RECON") : result;
	});
}

function snapshotSource(source: EmbeddedWorkSource, manager: SessionManager): EmbeddedWorkSource {
	if (source.result.session.sessionManager !== manager) throw new Error("Native runtime manager mismatch");
	return Object.freeze({
		result: source.result,
		interaction: source.interaction ? Object.freeze({ ...source.interaction }) : undefined,
	});
}

/** No consent, stop-admission lease, TI or cancellation is created by preparation. */
export function prepareNativeDisconnect(
	handle: NativeLifecycleHandle,
	op: PendingResumeOp,
): Promise<NativeDisconnectPreparation> {
	const member = memberFor(handle);
	return serialized(member, async () => {
		const result =
			closeState(member) !== "none_started"
				? await postReadonly(member, op, "RECON")
				: await reconcileLive(member, op, "verifyReadOnly", "RECON");
		const preparation: NativeDisconnectPreparation = Object.freeze({
			epoch: ++member.epoch,
			intentId: crypto.randomUUID(),
			heldIds: Object.freeze([...result.receipt.commitment.heldIds]),
			inventory:
				closeState(member) === "none_started" && member.workSource
					? getEmbeddedOwnedWork(member.workSource)
					: undefined,
		});
		member.preparation = preparation;
		preparations.set(preparation, member);
		return preparation;
	});
}

/** Capture consent locally; only this opaque, identity-bound receipt can request TERM. */
export function recordNativeDisconnectConsent(
	handle: NativeLifecycleHandle,
	preparation: NativeDisconnectPreparation,
	consent: NativeDisconnectConsent,
): NativeTerminationConsent | undefined {
	const member = memberFor(handle);
	if (
		member.pendingCalls !== 0 ||
		closeState(member) !== "none_started" ||
		preparations.get(preparation) !== member ||
		member.preparation !== preparation ||
		member.epoch !== preparation.epoch
	)
		return undefined;
	const receipt: NativeTerminationConsent = Object.freeze({ [consentBrand]: true as const });
	const captured: NativeDisconnectConsent = Object.freeze({
		stopAndJoin: consent.stopAndJoin,
		discardUnpublished: consent.discardUnpublished
			? Object.freeze({ ids: Object.freeze([...consent.discardUnpublished.ids]) })
			: undefined,
		work: consent.work
			? Object.freeze({
					inventory: consent.work.inventory,
					targets: Object.freeze(consent.work.targets.map(target => Object.freeze({ ...target }))),
					timeoutMs: consent.work.timeoutMs,
				})
			: undefined,
	});
	member.recordedConsent = receipt;
	consents.set(receipt, { member, preparation, context: member.context, consent: captured, started: false });
	return receipt;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
	return (
		a.length === b.length &&
		new Set(a).size === a.length &&
		new Set(b).size === b.length &&
		a.every(id => b.includes(id))
	);
}

function targetKey(target: EmbeddedWorkTarget): string {
	switch (target.kind) {
		case "job":
		case "task":
			return JSON.stringify([target.kind, target.id, target.generation]);
		case "schedule":
			return JSON.stringify([target.kind, target.id, target.createdAt]);
		case "workflow":
			return JSON.stringify([target.kind, target.id, target.workflowKind]);
		default:
			return JSON.stringify([target.kind, target.id]);
	}
}

function coversWork(inventory: EmbeddedOwnedWork, targets: readonly EmbeddedWorkTarget[]): boolean {
	const keys = targets.map(targetKey);
	const current = inventory.blockers.map(blocker => blocker.target && targetKey(blocker.target));
	return (
		current.every((key): key is string => key !== undefined) &&
		new Set(keys).size === keys.length &&
		sameIds(keys, current) &&
		!targets.some(target => target.kind === "workflow")
	);
}

function currentConsent(member: Member, receipt?: NativeTerminationConsent): ConsentRecord | undefined {
	const record = receipt && consents.get(receipt);
	return record &&
		member.recordedConsent === receipt &&
		record.member === member &&
		member.preparation === record.preparation &&
		record.preparation.epoch === member.epoch &&
		record.context === member.context
		? record
		: undefined;
}

async function terminateLive(
	member: Member,
	op: PendingResumeOp,
	record?: ConsentRecord,
	coordinatorAbort = false,
): Promise<ReconcileResult> {
	const driver = liveDriver(member);
	if (!coordinatorAbort && (!record || record.started))
		return refuse(member, op, "TERM", "termination_not_authorized");
	if (coordinatorAbort && (member.context !== "owned_pre" || !member.token))
		return refuse(member, op, "OPEN", "context_mismatch");
	// Validate every current suffix/work target before any destructive operation.
	const observed = await driver.reconcile(op, "verifyReadOnly", routing(member, "TERM", "RETAIN_LIVE"));
	if (closeState(member) !== "none_started") return postReadonly(member, op, "TERM");
	if (!coordinatorAbort && record) {
		const consent = record.consent;
		if (
			(member.context === "runtime" && consent.stopAndJoin !== true) ||
			(member.context === "owned_pre" &&
				(!consent.discardUnpublished ||
					!sameIds(consent.discardUnpublished.ids, observed.receipt.commitment.heldIds)))
		)
			return refuse(member, op, "TERM", "termination_not_authorized");
	}
	const source = member.workSource;
	if (source) {
		const inventory = getEmbeddedOwnedWork(source);
		const work = coordinatorAbort
			? { inventory, targets: inventory.blockers.flatMap(blocker => (blocker.target ? [blocker.target] : [])) }
			: record?.consent.work;
		if (
			!work ||
			(!coordinatorAbort && work.inventory !== record?.preparation.inventory) ||
			!coversWork(inventory, work.targets)
		)
			return refuse(
				member,
				op,
				coordinatorAbort ? "OPEN" : "TERM",
				coordinatorAbort ? "context_mismatch" : "termination_not_authorized",
			);
		// This API validates the *whole* captured inventory, addresses and exact
		// active run before cancelling the first draft. Rejected consent has no effects.
		const cancelled = await cancelEmbeddedOwnedWork(source, work);
		if (cancelled.status === "rejected")
			return refuse(
				member,
				op,
				coordinatorAbort ? "OPEN" : "TERM",
				coordinatorAbort ? "context_mismatch" : "termination_not_authorized",
			);
		if (record) record.started = true;
		if (
			cancelled.remaining.blockers.length > 0 ||
			cancelled.results.some(result => !["removed", "cancelled", "settled"].includes(result.status))
		)
			return remember(member, op, observed);
		member.lease ??= acquireEmbeddedStopAdmission(source);
		if (getEmbeddedOwnedWork(source).blockers.length > 0) {
			member.lease.release();
			member.lease = undefined;
			return remember(member, op, observed);
		}
	} else if (member.context === "runtime") {
		return refuse(member, op, "TERM", "termination_not_authorized");
	} else if (record?.consent.work && record.consent.work.targets.length > 0) {
		return refuse(member, op, "TERM", "termination_not_authorized");
	}
	if (record) record.started = true;
	const authorization = Object.freeze<ResumeTerminationAuthorization>(
		coordinatorAbort
			? {
					kind: "coordinator_abort",
					registryIntentId: crypto.randomUUID(),
					coordinatorOpenToken: member.token!,
					ownership: "owned_pre",
					runtimeHandoff: false,
				}
			: {
					kind: "consented_teardown",
					registryIntentId: record!.preparation.intentId,
					stopAdmitting: true,
					runtime: member.context === "runtime" ? "stopped_joined" : "not_published",
				},
	);
	member.intent = authorization;
	try {
		if (observed.receipt.durability.state !== "proven") {
			try {
				await driver.reconcile(op, "repairDurability", routing(member, "TERM", "TERMINATE", { authorization }));
			} catch {
				/* Failed repair is reported by fresh F; it cannot manufacture D. */
			}
		}
		if (closeState(member) !== "none_started") return postReadonly(member, op, "TERM", true);
		if (source) {
			member.runtimeCleanupComplete = false;
			// Disposal owns one strict-close attempt under this TERM. Join its
			// retained teardown even when the bounded public promise expires.
			try {
				await disposeAuthorized(member, authorization, source);
			} catch {
				/* The retained completion below determines the actual outcome. */
			}
			try {
				await source.result.session.awaitDisposeCompletion();
			} catch {
				/* Writer-close failure is separate from actual resource cleanup. */
			}
			member.runtimeCleanupComplete = source.result.session.getDisposeResourceState() === "settled";
			if (!member.runtimeCleanupComplete) {
				member.closure = undefined;
				if (closeState(member) !== "none_started") {
					const result = await driver.captureAfterClose(
						op,
						routing(member, "TERM", "POST_READONLY", { authorization }),
					);
					return remember(member, op, result);
				}
				return remember(member, op, observed);
			}
		}
		if (closeState(member) === "none_started") await member.manager!.closeStrict();
		// A just-failed first close is reported, not retried within this call.
		if (closeState(member) === "close_failed_retryable") {
			return remember(
				member,
				op,
				await driver.captureAfterClose(op, routing(member, "TERM", "POST_READONLY", { authorization })),
			);
		}
		return postReadonly(member, op, "TERM", true);
	} catch {
		if (closeState(member) !== "none_started") {
			const result = await driver.captureAfterClose(op, routing(member, "TERM", "POST_READONLY", { authorization }));
			return remember(member, op, result);
		}
		return remember(member, op, observed);
	} finally {
		member.lease?.release();
		member.lease = undefined;
	}
}

/** External TERM cannot mint coordinator_abort, even for an owned_pre handle. */
export function terminateNativeHandle(
	handle: NativeLifecycleHandle,
	op: PendingResumeOp,
	consent?: NativeTerminationConsent,
): Promise<ReconcileResult> {
	const member = memberFor(handle);
	return serialized(member, async () => {
		const record = currentConsent(member, consent);
		if (closeState(member) !== "none_started") {
			const validRetry = member.intent !== undefined && member.intentConsent === consent && record?.started === true;
			return postReadonly(member, op, "TERM", validRetry);
		}
		if (!record) return refuse(member, op, "TERM", "termination_not_authorized");
		member.intentConsent = consent;
		return terminateLive(member, op, record);
	});
}

function provenPrefix(result: ReconcileResult): boolean {
	return (
		result.receipt.durability.state === "proven" &&
		["enrolled_only", "partial_chain", "dependents_absent", "dependents_partial"].includes(result.outcome.kind)
	);
}

async function open(member: Member, op: PendingResumeOp, token: string): Promise<ReconcileResult> {
	if (closeState(member) !== "none_started") return postReadonly(member, op, "OPEN");
	if (member.context !== "owned_pre" || member.token !== token) return refuse(member, op, "OPEN", "context_mismatch");
	let result = await reconcileLive(member, op, "verify", "OPEN");
	if (closeState(member) !== "none_started") return postReadonly(member, op, "OPEN");
	if (result.outcome.kind === "unknown") return result;
	const suffix = result.receipt.commitment.suffixState;
	const held = suffix === "held" || suffix === "unproven";
	let completion: ResumeRouting["completionResult"] = "n/a";
	if (held || (provenPrefix(result) && (suffix === "none" || suffix === "published"))) {
		try {
			result = await reconcileLive(member, op, "complete", "OPEN");
			completion = result.refusal ? "refused" : result.receipt.commitment.operationComplete ? "success" : "partial";
		} catch {
			completion = "failed";
		}
		if (closeState(member) !== "none_started") return postReadonly(member, op, "OPEN");
		result = annotate(result, { ...result.receipt.routing, completionResult: completion });
		if (held && (completion !== "success" || result.receipt.durability.state !== "proven"))
			return remember(member, op, result);
	}
	if (result.outcome.kind === "unknown") return remember(member, op, result);
	if (result.receipt.commitment.operationComplete && result.receipt.durability.state === "proven") {
		if (result.receipt.remainingConflict.length > 0) return terminateLive(member, op, undefined, true);
		if (result.receipt.commitment.continueEligible) {
			result = annotate(result, { ...result.receipt.routing, action: "PROCEED", completionResult: completion });
			remember(member, op, result);
			member.openReady = true;
			return result;
		}
	}
	if ((!held && provenPrefix(result)) || result.outcome.kind === "not_committed")
		return terminateLive(member, op, undefined, true);
	return remember(member, op, result);
}

/** Claim an admitted, hydrated actual manager exactly once; never constructs a runtime. */
export function createNativeOpenCoordinator(driver: NativeLifecycleDriver): NativeOpenCoordinator {
	if (managers.has(driver.manager)) throw new Error("Native manager already registered");
	if (driver.manager.getStrictCloseState().kind !== "none_started")
		throw new Error("Cannot register terminal native manager");
	const handle: NativeLifecycleHandle = Object.freeze({ [handleBrand]: true as const });
	const token = crypto.randomUUID();
	const member: Member = {
		driver,
		manager: driver.manager,
		handle,
		context: "owned_pre",
		token,
		workSource: driver.workSource ? snapshotSource(driver.workSource, driver.manager) : undefined,
		readiness: "fenced",
		openReady: false,
		runtimeCleanupComplete: true,
		epoch: 0,
		pendingCalls: 0,
		tail: Promise.resolve(),
	};
	members.set(handle, member);
	managers.set(driver.manager, member);
	const abort = (op: PendingResumeOp): Promise<ReconcileResult> =>
		serialized(member, async () => {
			if (closeState(member) !== "none_started")
				return postReadonly(member, op, "TERM", member.intent?.kind === "coordinator_abort");
			if (member.context !== "owned_pre" || member.token !== token)
				return refuse(member, op, "OPEN", "context_mismatch");
			return terminateLive(member, op, undefined, true);
		});
	return Object.freeze({
		handle,
		resumeOpen: (op: PendingResumeOp) => serialized(member, () => open(member, op, token)),
		recordRuntimeStarted(source: EmbeddedWorkSource): void {
			if (
				member.pendingCalls !== 0 ||
				closeState(member) !== "none_started" ||
				member.context !== "owned_pre" ||
				member.token !== token ||
				!member.openReady ||
				member.workSource
			)
				throw new Error("Native runtime startup context mismatch");
			member.workSource = snapshotSource(source, driver.manager);
		},
		publishRuntime(): NativeLifecycleHandle {
			if (
				member.pendingCalls !== 0 ||
				closeState(member) !== "none_started" ||
				member.context !== "owned_pre" ||
				member.token !== token ||
				!member.openReady ||
				!member.workSource
			)
				throw new Error("Native runtime handoff context mismatch");
			member.context = "runtime";
			member.token = undefined;
			member.openReady = false;
			member.preparation = undefined;
			member.recordedConsent = undefined;
			member.epoch++;
			return handle;
		},
		startupFailed: abort,
		superseded: abort,
		abortOpen: abort,
	});
}

/** Restart recovery has no manager and therefore no OPEN or TERM authority. */
export function createNativeReadonlyHandle(
	driver: Pick<NativeLifecycleDriver, "captureAfterClose">,
): NativeLifecycleHandle {
	const handle: NativeLifecycleHandle = Object.freeze({ [handleBrand]: true as const });
	members.set(handle, {
		driver,
		handle,
		context: "owned_pre",
		readiness: "fenced",
		openReady: false,
		runtimeCleanupComplete: true,
		epoch: 0,
		pendingCalls: 0,
		tail: Promise.resolve(),
	});
	return handle;
}

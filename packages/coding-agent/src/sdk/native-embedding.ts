import * as crypto from "node:crypto";
import * as util from "node:util";
import { captureNativeResumeTranscript } from "../session/native-resume";
import {
	admitOwnerMembershipWithAsyncEvidence,
	captureLegacyTakeoverAttestationWithAsyncEvidence,
	captureOwnerTargetSync,
	getOwnerMembershipEvidence,
	type LegacyTakeoverAttestation,
	OwnerAuthorityError,
	type OwnerMembership,
	probeSessionOwnershipWithAsyncEvidence,
	retireOwnerMembershipSync,
	type SessionOwnerPolicy,
} from "../session/owner-group";
import { resolveResumeCheckpoint, type SdkResumeCheckpoint } from "../session/resume-cursor";
import type {
	PendingResumeOp,
	ReconcileResult,
	ResumeClosureEvidence,
	ResumeRetirementEvidence,
	ResumeTerminationAuthorization,
} from "../session/resume-operation";
import { SessionManager } from "../session/session-manager";
import { FileSessionStorage, type SessionStorage } from "../session/session-storage";
import type { EmbeddedWorkSource } from "./embedded-work";
import {
	createEmbeddedAgentSession,
	type EmbeddedAgentSessionOptions,
	type EmbeddedAgentSessionResult,
} from "./embedding";
import { ExtensionInteractionService } from "./extension-interaction";
import {
	createNativeOpenCoordinator,
	type NativeDisconnectConsent,
	type NativeDisconnectPreparation,
	type NativeLifecycleHandle,
	type NativeOpenCoordinator,
	type NativeReconcileMode,
	type NativeTerminationConsent,
	prepareNativeDisconnect,
	reconcileNativeHandle,
	recordNativeDisconnectConsent,
	terminateNativeHandle,
} from "./native-lifecycle";
import { createNativeOwnerInspectors } from "./native-ownership";
import type { CreateAgentSessionResult } from "./session";
import type { ResumeSessionIdentity } from "./session-readonly/storage";

export interface NativeEmbeddedOptions {
	readonly expected: { readonly snapshotDigest: string; readonly resolved: SdkResumeCheckpoint };
	readonly ownerPolicy: Extract<SessionOwnerPolicy, { kind: "exclusive_native" }>;
	readonly selection?: { readonly snapshotDigest: string; readonly targetLeafId: string | null; readonly op: string };
}
export interface NativeFreshEmbeddedOptions {
	readonly create: true;
	readonly ownerPolicy: { readonly kind: "exclusive_native" };
}
export interface NativeEmbeddedAgentSessionOptions extends Omit<EmbeddedAgentSessionOptions, "storage"> {
	readonly native: NativeEmbeddedOptions | NativeFreshEmbeddedOptions;
	readonly storage: Exclude<EmbeddedAgentSessionOptions["storage"], { persist: false }>;
}
export type EmbeddedResumeResolution =
	| { readonly kind: "resolved"; readonly checkpoint: SdkResumeCheckpoint; readonly identity: ResumeSessionIdentity }
	| { readonly kind: "error"; readonly reason: string };
export type NativeEmbeddedOpenResult =
	| {
			readonly kind: "opened";
			readonly result: EmbeddedAgentSessionResult;
			readonly handle: NativeLifecycleHandle;
			readonly op: PendingResumeOp;
			readonly selection: ReconcileResult;
			readonly interaction: NonNullable<EmbeddedWorkSource["interaction"]>;
	  }
	| { readonly kind: "selector"; readonly checkpoint: SdkResumeCheckpoint }
	| {
			readonly kind: "uncertain_cursor" | "selection_incomplete" | "startup_failed";
			readonly handle: NativeLifecycleHandle;
			readonly op: PendingResumeOp;
			readonly selection: ReconcileResult;
			readonly error?: string;
	  }
	| { readonly kind: "refused"; readonly reason: string; readonly checkpoint?: SdkResumeCheckpoint };

/** Descriptor-bound read-only interpretation. No writer, registry, factory, or catalog effects. */
export function resolveEmbeddedResumeCheckpoint(
	file: string,
	storage: SessionStorage = new FileSessionStorage(),
): EmbeddedResumeResolution {
	const observed = captureNativeResumeTranscript(file, storage);
	if (observed.capture.kind !== "captured" || !observed.identity)
		return {
			kind: "error",
			reason:
				observed.failure?.reason === "oversized"
					? "transcript_too_large_for_native_open"
					: (observed.failure?.reason ?? "stale_snapshot"),
		};
	return { kind: "resolved", checkpoint: observed.capture.reducerView, identity: observed.identity };
}

export async function probeEmbeddedSessionOwnership(input: {
	readonly file: string;
	readonly cwd: string;
	readonly agentDir: string;
}) {
	const resolved = resolveEmbeddedResumeCheckpoint(input.file);
	if (resolved.kind !== "resolved") return resolved;
	try {
		const target = captureOwnerTargetSync({
			transcriptPath: resolved.identity.canonicalPath,
			headerId: resolved.checkpoint.headerId!,
			snapshotDigest: resolved.checkpoint.snapshotDigest,
		});
		return await probeSessionOwnershipWithAsyncEvidence(target, createNativeOwnerInspectors(input));
	} catch (error) {
		return {
			kind: "refused" as const,
			reason: error instanceof OwnerAuthorityError ? error.code : "unknown_ownership",
		};
	}
}

/** Explicit row-four acknowledgement only; the opaque result cannot override a veto or marker row. */
export async function attestEmbeddedLegacyTakeover(input: {
	readonly file: string;
	readonly cwd: string;
	readonly agentDir: string;
	readonly snapshotDigest: string;
	readonly acknowledged: true;
}): Promise<LegacyTakeoverAttestation> {
	if (input.acknowledged !== true) throw new Error("legacy_attestation_required");
	const resolved = resolveEmbeddedResumeCheckpoint(input.file);
	if (resolved.kind !== "resolved" || resolved.checkpoint.snapshotDigest !== input.snapshotDigest)
		throw new Error("stale_snapshot");
	const target = captureOwnerTargetSync({
		transcriptPath: resolved.identity.canonicalPath,
		headerId: resolved.checkpoint.headerId!,
		snapshotDigest: input.snapshotDigest,
	});
	return captureLegacyTakeoverAttestationWithAsyncEvidence(target, createNativeOwnerInspectors(input));
}

interface NativeOwner {
	readonly manager: SessionManager;
	readonly membership: OwnerMembership;
	readonly coordinator: NativeOpenCoordinator;
	pending: PendingResumeOp;
	readonly operations: Set<PendingResumeOp>;
	readonly options: EmbeddedAgentSessionOptions;
	cleanup?: () => Promise<void>;
	interaction?: NonNullable<EmbeddedWorkSource["interaction"]>;
	last?: ReconcileResult;
}
const nativeOwners = new WeakMap<SessionManager, NativeOwner>();
const handles = new WeakMap<NativeLifecycleHandle, NativeOwner>();

/** Internal baseline-factory hook: only a coordinator already owning this exact manager participates. */
export function nativeEmbeddedRuntimeConstructed(manager: SessionManager, result: CreateAgentSessionResult): void {
	const owner = nativeOwners.get(manager);
	if (!owner) return;
	const service = new ExtensionInteractionService(manager.getSessionId());
	const { connectionId } = service.connect();
	const interaction = Object.freeze({ service, connectionId, ownership: "owned" as const });
	const setToolUIContext = result.setToolUIContext;
	result.setToolUIContext = (ui, hasUI) => {
		if (ui !== service.ui || !hasUI) throw new Error("Native UI must use its registered interaction service");
		setToolUIContext(ui, hasUI);
	};
	result.setToolUIContext(service.ui, true);
	owner.interaction = interaction;
	owner.coordinator.recordRuntimeStarted({ result, interaction });
}
/** Internal baseline-factory hook; ordinary callers retain their existing cleanup path. */
export async function nativeEmbeddedStartupFailed(
	manager: SessionManager,
	cleanup: () => Promise<void>,
): Promise<boolean> {
	const owner = nativeOwners.get(manager);
	if (!owner) return false;
	owner.cleanup = cleanup;
	owner.last = await owner.coordinator.startupFailed(owner.pending);
	await releaseClosedDependencies(owner);
	return true;
}
async function releaseClosedDependencies(owner: NativeOwner): Promise<void> {
	if (owner.manager.getStrictCloseState().kind !== "closed") return;
	const cleanup = owner.cleanup;
	if (cleanup) {
		await cleanup();
		if (owner.cleanup === cleanup) owner.cleanup = undefined;
	}
	owner.interaction?.service.dispose();
}
function ownerFor(handle: NativeLifecycleHandle): NativeOwner {
	const owner = handles.get(handle);
	if (!owner) throw new Error("context_mismatch");
	return owner;
}
async function retire(
	owner: { manager: SessionManager; membership: OwnerMembership },
	op: PendingResumeOp,
	result: ReconcileResult,
	authorization: ResumeTerminationAuthorization,
	expected?: ResumeClosureEvidence,
): Promise<ResumeRetirementEvidence | undefined> {
	if (
		owner.manager.getStrictCloseState().kind !== "closed" ||
		result.receipt.terminalDisposition.reason !== "retirement_permitted_not_applied"
	)
		return Promise.resolve(undefined);
	const membership = getOwnerMembershipEvidence(owner.membership);
	if (
		membership.memberId !== op.memberToken ||
		membership.epoch !== op.epoch ||
		membership.authorityKey !== op.authorityKey
	)
		return Promise.resolve(undefined);
	if (!expected || expected.authorization !== authorization) return undefined;
	const closure = await owner.manager.getResumeClosureEvidence(op, authorization);
	if (!closure || !util.isDeepStrictEqual(closure, expected)) return undefined;
	const classified = await owner.manager.captureResumeOperationAfterClose(op, result.receipt.routing, closure);
	if (classified.receipt.terminalDisposition.reason !== "retirement_permitted_not_applied") return undefined;
	const rechecked = await owner.manager.getResumeClosureEvidence(op, authorization);
	if (!rechecked || !util.isDeepStrictEqual(rechecked, closure)) return undefined;
	retireOwnerMembershipSync(owner.membership);
	return {
		kind: "member_retired",
		registryIntentId: authorization.registryIntentId,
		memberToken: op.memberToken,
		authorityKey: op.authorityKey,
		epoch: op.epoch,
		op: op.op,
		finalCaptureDigest: closure.finalCaptureDigest,
	};
}

/** Separate admission path: interpretation and all independent vetoes precede hydration/factory effects. */
export async function createNativeEmbeddedAgentSession(
	options: NativeEmbeddedAgentSessionOptions,
): Promise<NativeEmbeddedOpenResult> {
	const { native, storage, ...factory } = options;
	if ("create" in native) return createFreshNative(options);
	if (!(native.ownerPolicy.kind === "exclusive_native") || !storage.file)
		return { kind: "refused", reason: "policy_mismatch" };
	const resolved = resolveEmbeddedResumeCheckpoint(storage.file);
	if (resolved.kind !== "resolved") return { kind: "refused", reason: resolved.reason };
	const checkpoint = resolved.checkpoint;
	if (
		checkpoint.snapshotDigest !== native.expected.snapshotDigest ||
		!util.isDeepStrictEqual(checkpoint, native.expected.resolved) ||
		!util.isDeepStrictEqual(native.ownerPolicy.expected, native.expected)
	)
		return { kind: "refused", reason: "stale_snapshot", checkpoint };
	if (checkpoint.kind === "invalid") return { kind: "selector", checkpoint };
	if (!native.selection && (checkpoint.kind === "ambiguous" || checkpoint.kind === "legacy_tail"))
		return { kind: "selector", checkpoint };
	if (native.selection && native.selection.snapshotDigest !== checkpoint.snapshotDigest)
		return { kind: "refused", reason: "stale_snapshot", checkpoint };
	let manager: SessionManager;
	let membership: OwnerMembership;
	try {
		const target = captureOwnerTargetSync({
			transcriptPath: resolved.identity.canonicalPath,
			headerId: checkpoint.headerId!,
			snapshotDigest: checkpoint.snapshotDigest,
		});
		const inspectors = createNativeOwnerInspectors(options);
		// Probe remains independent of the table/admission; no factory or hydration before it.
		const probe = await probeSessionOwnershipWithAsyncEvidence(target, inspectors);
		if (
			probe.kind !== "available" &&
			!(probe.reason === "legacy_attestation_required" && native.ownerPolicy.legacyAttestation)
		)
			return { kind: "refused", reason: probe.reason ?? probe.kind, checkpoint };
		if (storage.manager) {
			manager = storage.manager;
			const existing = manager.getSessionOwnerEvidence();
			membership = manager.getOwnerMembership()!;
			if (
				!membership ||
				existing?.policy.kind !== "exclusive_native" ||
				existing.snapshotDigest !== checkpoint.snapshotDigest ||
				existing.authorityKey !== target.authorityKey ||
				manager.getStrictCloseState().kind !== "none_started"
			)
				return { kind: "refused", reason: "policy_mismatch" };
		} else {
			membership = await admitOwnerMembershipWithAsyncEvidence(target, native.ownerPolicy, {
				...inspectors,
				runtime: "embedded_native",
				capabilities: ["native_resume"],
			});
			const destination =
				"managed" in storage
					? SessionManager.managedDestination(options.cwd, options.agentDir)
					: SessionManager.explicitDestination(storage.directory, options.agentDir);
			const hydrated = await SessionManager.openExistingForRecoveryHydrationStrict(resolved.identity, destination);
			if (hydrated.kind !== "hydrated") return { kind: "refused", reason: "stale_snapshot", checkpoint };
			manager = hydrated.manager;
			manager.installOwnerMembership(membership);
			await manager.promoteNativeRecoveryHydration(hydrated.context, membership);
		}
	} catch (error) {
		return {
			kind: "refused",
			reason: error instanceof OwnerAuthorityError ? error.code : "unknown_ownership",
			checkpoint,
		};
	}
	const pending = await manager.appendResumeCursorDurably(
		native.selection ? native.selection.targetLeafId : checkpoint.leafEntryId,
		{ op: native.selection?.op ?? crypto.randomUUID(), reason: native.selection ? "explicit" : "pin" },
	);
	return beginNativeFactory(manager, membership, pending, { ...factory, storage: { ...storage, manager } });
}

async function createFreshNative(options: NativeEmbeddedAgentSessionOptions): Promise<NativeEmbeddedOpenResult> {
	const { storage, native: _native, ...factory } = options;
	if (storage.file || storage.manager) return { kind: "refused", reason: "policy_mismatch" };
	const destination =
		"managed" in storage
			? SessionManager.managedDestination(options.cwd, options.agentDir)
			: SessionManager.explicitDestination(storage.directory, options.agentDir);
	const manager = SessionManager.createForOwnerAdmission(options.cwd, destination);
	const header = manager.getHeader();
	const file = manager.getSessionFile();
	if (!header || !file) throw new Error("native_new_session_identity_unavailable");
	const target = captureOwnerTargetSync({ transcriptPath: file, headerId: header.id });
	if (target.transcriptExists) throw new Error("stale_snapshot");
	const resolved = resolveResumeCheckpoint([header], target.snapshotDigest);
	const expected = { snapshotDigest: target.snapshotDigest, resolved };
	const membership = await admitOwnerMembershipWithAsyncEvidence(
		target,
		{ kind: "exclusive_native", expected },
		{ ...createNativeOwnerInspectors(options), runtime: "embedded_native", capabilities: ["native_resume"] },
	);
	manager.installOwnerMembership(membership);
	const pending = await manager.appendResumeCursorDurably(null, { op: crypto.randomUUID(), reason: "pin" });
	return beginNativeFactory(manager, membership, pending, { ...factory, storage: { ...storage, manager } });
}

function beginNativeFactory(
	manager: SessionManager,
	membership: OwnerMembership,
	pending: PendingResumeOp,
	admittedOptions: EmbeddedAgentSessionOptions,
): Promise<NativeEmbeddedOpenResult> {
	const closures = new WeakMap<ResumeTerminationAuthorization, ResumeClosureEvidence>();
	const coordinator = createNativeOpenCoordinator({
		manager,
		reconcile: (op, mode, routing) => manager.reconcileResumeOperation(op, mode, routing),
		captureAfterClose: (op, routing, closure) => manager.captureResumeOperationAfterClose(op, routing, closure),
		getClosureEvidence: async (op, authorization) => {
			const closure = await manager.getResumeClosureEvidence(op, authorization);
			if (closure) closures.set(authorization, closure);
			else closures.delete(authorization);
			return closure;
		},
		retire: (op, result, authorization) =>
			retire({ manager, membership }, op, result, authorization, closures.get(authorization)),
	});
	const owner: NativeOwner = {
		manager,
		membership,
		pending,
		coordinator,
		operations: new Set([pending]),
		options: admittedOptions,
	};
	nativeOwners.set(manager, owner);
	handles.set(coordinator.handle, owner);
	return continueOpen(owner, admittedOptions);
}

async function continueOpen(
	owner: NativeOwner,
	options: EmbeddedAgentSessionOptions,
): Promise<NativeEmbeddedOpenResult> {
	const selection = await owner.coordinator.resumeOpen(owner.pending);
	owner.last = selection;
	if (selection.receipt.routing.action !== "PROCEED")
		return {
			kind: selection.receipt.routing.action === "RETAIN_LIVE" ? "uncertain_cursor" : "selection_incomplete",
			handle: owner.coordinator.handle,
			op: owner.pending,
			selection,
		};
	try {
		const result = await createEmbeddedAgentSession(options);
		if (!owner.interaction) throw new Error("native_interaction_not_registered");
		owner.cleanup = () => result.releaseResources();
		const handle = owner.coordinator.publishRuntime();
		return { kind: "opened", result, handle, op: owner.pending, selection, interaction: owner.interaction };
	} catch (error) {
		const final = owner.last ?? (await owner.coordinator.startupFailed(owner.pending));
		owner.last = final;
		return {
			kind: "startup_failed",
			handle: owner.coordinator.handle,
			op: owner.pending,
			selection: final,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Resume only the retained coordinator-owned open, with the original factory inputs. */
export function resumeEmbeddedAgentSession(handle: NativeLifecycleHandle): Promise<NativeEmbeddedOpenResult> {
	const owner = ownerFor(handle);
	return continueOpen(owner, owner.options);
}

export async function reconcileEmbeddedResumeCheckpoint(
	handle: NativeLifecycleHandle,
	input: { readonly op: PendingResumeOp; readonly mode: NativeReconcileMode },
): Promise<ReconcileResult> {
	const owner = ownerFor(handle);
	if (!owner.operations.has(input.op)) throw new Error("context_mismatch");
	const result = await reconcileNativeHandle(handle, input.op, input.mode);
	owner.last = result;
	return result;
}
export async function selectEmbeddedExecutionBranch(
	handle: NativeLifecycleHandle,
	targetLeafId: string | null,
	input: { readonly op: string },
): Promise<PendingResumeOp> {
	const owner = ownerFor(handle);
	if (owner.manager.getStrictCloseState().kind !== "none_started") throw new Error("manager_closed");
	const pending = await owner.manager.appendResumeCursorDurably(targetLeafId, { op: input.op, reason: "explicit" });
	owner.operations.add(pending);
	owner.pending = pending;
	return pending;
}
export function recordEmbeddedResumeCheckpoint(
	handle: NativeLifecycleHandle,
	input: { readonly op: string },
): Promise<PendingResumeOp> {
	const owner = ownerFor(handle);
	return selectEmbeddedExecutionBranch(handle, owner.manager.getLeafId(), input);
}
export function prepareEmbeddedDisconnect(
	handle: NativeLifecycleHandle,
	op: PendingResumeOp,
): Promise<NativeDisconnectPreparation> {
	const owner = ownerFor(handle);
	if (!owner.operations.has(op)) throw new Error("context_mismatch");
	return prepareNativeDisconnect(handle, op);
}
export function consentEmbeddedDisconnect(
	handle: NativeLifecycleHandle,
	preparation: NativeDisconnectPreparation,
	consent: NativeDisconnectConsent,
): NativeTerminationConsent | undefined {
	ownerFor(handle);
	return recordNativeDisconnectConsent(handle, preparation, consent);
}
export async function terminateEmbeddedAgentSession(
	handle: NativeLifecycleHandle,
	input: { readonly op: PendingResumeOp; readonly consent?: NativeTerminationConsent },
): Promise<ReconcileResult> {
	const owner = ownerFor(handle);
	if (!owner.operations.has(input.op)) throw new Error("context_mismatch");
	const result = await terminateNativeHandle(handle, input.op, input.consent);
	owner.last = result;
	await releaseClosedDependencies(owner);
	return result;
}

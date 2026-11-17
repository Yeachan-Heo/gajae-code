import * as crypto from "node:crypto";
import * as util from "node:util";
import type { AgentSession } from "../session/agent-session";
import { captureNativeResumeTranscript } from "../session/native-resume";
import {
	admitOwnerMembershipWithAsyncEvidence,
	captureLegacyTakeoverAttestationWithAsyncEvidence,
	captureOwnerTargetSync,
	getOwnerMembershipEvidence,
	type LegacyTakeoverAttestation,
	OwnerAuthorityError,
	type OwnerFreshCreation,
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
import { type PreparedNewSession, SessionManager } from "../session/session-manager";
import { FileSessionStorage, type SessionStorage } from "../session/session-storage";
import type {
	ActivityControlOperation,
	ActivityControlResult,
	ActivityMcpResult,
	ActivityMcpServer,
	ActivityMcpSnapshot,
} from "./activity-controls";
import type { AuthorizationControls } from "./authorization-controls";
import type { SdkComposerObservation } from "./composer-observation";
import type { SdkDiffObservation } from "./diff-observation";
import type { EmbeddedWorkSource } from "./embedded-work";
import {
	createEmbeddedAgentSession,
	type EmbeddedAgentSessionOptions,
	type EmbeddedAgentSessionResult,
	type EmbeddedRevisionInput,
	type EmbeddedRevisionOptions,
	type SdkRevisionResult,
} from "./embedding";
import { ExtensionInteractionService } from "./extension-interaction";
import {
	adoptNativeRuntimeSelection,
	bindNativeRuntimeInvocation,
	createNativeOpenCoordinator,
	invokeNativeRuntime,
	type NativeDisconnectConsent,
	type NativeDisconnectPreparation,
	type NativeInvocationResult,
	type NativeLifecycleHandle,
	type NativeOpenCoordinator,
	type NativeReconcileMode,
	type NativeTerminationConsent,
	prepareNativeDisconnect,
	reconcileNativeHandle,
	recordNativeDisconnectConsent,
	serializeNativeRuntimeSelection,
	terminateNativeHandle,
} from "./native-lifecycle";
import { createNativeOwnerInspectors } from "./native-ownership";
import type { SdkOperatorControls } from "./operator-controls";
import type { SdkPreferenceControls } from "./preference-controls";
import type { CreateAgentSessionResult } from "./session";
import { getSessionClientControls } from "./session-client-controls";
import { CURRENT_SESSION_VERSION } from "./session-readonly/format";
import type { ResumeSessionIdentity } from "./session-readonly/storage";
import type { SideConversationControls } from "./side-conversation";

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
type NativeMethods<T> = {
	readonly [K in keyof T]: T[K] extends (...args: infer A) => infer R
		? (...args: A) => Promise<NativeInvocationResult<Awaited<R>>>
		: never;
};

/** Closed consumer API. No callback, mutable service, manager or raw-session authority. */
export interface NativeEmbeddedRuntime {
	readonly prompt: NativeMethods<
		Pick<
			AgentSession,
			"prompt" | "promptCustomMessage" | "sendUserMessage" | "submitUserMessage" | "continuePersistedHistory"
		>
	>;
	readonly queue: NativeMethods<
		Pick<
			AgentSession,
			| "steer"
			| "followUp"
			| "cancelAndSubmit"
			| "cancelQueuedMessage"
			| "cancelQueuedInputSubmission"
			| "removeQueuedMessageForEditing"
			| "moveQueuedMessageForEditing"
			| "popLastQueuedMessage"
			| "setSteeringMode"
			| "setFollowUpMode"
			| "setToolInterruptPolicy"
			| "abort"
		>
	>;
	readonly model: NativeMethods<
		Pick<
			AgentSession,
			| "setModelTemporaryForControl"
			| "setDefaultModelSelection"
			| "activateModelProfileForControl"
			| "cycleModel"
			| "setSessionAgentModelSelection"
			| "setThinkingLevel"
			| "cycleThinkingLevel"
		>
	>;
	readonly workflow: NativeMethods<Pick<AgentSession, "invokeSkill" | "setSdkPlanMode" | "operateGoal">>;
	readonly operator: NativeMethods<Pick<SdkOperatorControls, "execute" | "read" | "cancel">>;
	readonly activity: {
		control(
			operation: ActivityControlOperation,
			input: Record<string, unknown>,
		): Promise<NativeInvocationResult<ActivityControlResult>>;
	};
	readonly mcp: {
		snapshot(): Promise<NativeInvocationResult<ActivityMcpSnapshot>>;
		operate(
			ref: ActivityMcpServer["ref"],
			action: ActivityMcpServer["controls"][number],
		): Promise<NativeInvocationResult<ActivityMcpResult>>;
	};
	readonly preferences: NativeMethods<Pick<SdkPreferenceControls, "handle">>;
	readonly authorization: NativeMethods<Pick<AuthorizationControls, "execute">>;
	readonly composer: NativeMethods<Pick<SdkComposerObservation, "dispatch">>;
	readonly diff: NativeMethods<Pick<SdkDiffObservation, "dispatch">>;
	readonly side: NativeMethods<Pick<SideConversationControls, "control">>;
	/**
	 * Transcript and view work the session itself owns. Every entry point here mutates
	 * the transcript or the execution view, so none may run outside admission.
	 */
	readonly session: {
		readonly revise: (
			input: EmbeddedRevisionInput,
			options?: EmbeddedRevisionOptions,
		) => Promise<NativeInvocationResult<SdkRevisionResult>>;
		readonly branch: (
			entryId: string,
		) => Promise<NativeInvocationResult<{ selectedText: string; cancelled: boolean }>>;
		readonly refreshCommands: () => Promise<NativeInvocationResult<void>>;
		readonly refreshModels: (strategy: "online" | "offline") => Promise<NativeInvocationResult<void>>;
	} & NativeMethods<
		Pick<
			AgentSession,
			| "setSessionName"
			| "setActiveToolsByName"
			| "setThinkingLevelForControl"
			| "reloadSkills"
			| "compact"
			| "clearContext"
			| "retry"
			| "generateAutoSessionTitle"
			| "exportToHtml"
		>
	>;
}

export type NativeEmbeddedOpenResult =
	| {
			readonly kind: "opened";
			readonly result: EmbeddedAgentSessionResult;
			readonly runtime: NativeEmbeddedRuntime;
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
	membership: OwnerMembership;
	readonly coordinator: NativeOpenCoordinator;
	pending: PendingResumeOp;
	readonly operations: Set<PendingResumeOp>;
	readonly options: EmbeddedAgentSessionOptions;
	cleanup?: () => Promise<void>;
	interaction?: NonNullable<EmbeddedWorkSource["interaction"]>;
	session?: AgentSession;
	last?: ReconcileResult;
	openFlight?: Promise<NativeEmbeddedOpenResult>;
}
const nativeOwners = new WeakMap<SessionManager, NativeOwner>();
const handles = new WeakMap<NativeLifecycleHandle, NativeOwner>();

/** Internal producer lookup, never inferred from transcript order or a manager leaf. */
export function nativeEmbeddedOwnerOperation(manager: SessionManager): PendingResumeOp | undefined {
	return nativeOwners.get(manager)?.pending;
}

/** The manager has registered and durably published this exact moved operation. */
export function nativeEmbeddedOperationMoved(
	manager: SessionManager,
	previous: PendingResumeOp,
	pending: PendingResumeOp,
): void {
	const owner = nativeOwners.get(manager);
	if (
		!owner ||
		!owner.session ||
		owner.pending !== previous ||
		manager.getOwnerMembership() !== owner.membership ||
		!manager.isRegisteredNativeResumeOperation(pending)
	)
		throw new Error("context_mismatch");
	adoptNativeRuntimeSelection(owner.session, pending);
}

/** Producer-only preparation: fresh capability and all async vetoes precede publication. */
export async function admitNativePreparedSuccessor(
	manager: SessionManager,
	prepared: PreparedNewSession,
	freshCreation: OwnerFreshCreation,
): Promise<OwnerMembership> {
	const owner = nativeOwners.get(manager);
	if (
		!owner ||
		manager.getOwnerMembership() !== owner.membership ||
		!prepared.sessionFile ||
		freshCreation.headerId !== prepared.sessionId
	)
		throw new Error("context_mismatch");
	const target = captureOwnerTargetSync({ transcriptPath: prepared.sessionFile, headerId: prepared.sessionId });
	if (target.transcriptExists) throw new Error("stale_snapshot");
	const header = {
		type: "session" as const,
		version: CURRENT_SESSION_VERSION,
		id: prepared.sessionId,
		timestamp: new Date().toISOString(),
		cwd: manager.getCwd(),
	};
	const resolved = resolveResumeCheckpoint([header], target.snapshotDigest);
	return admitOwnerMembershipWithAsyncEvidence(
		target,
		{ kind: "exclusive_native", expected: { snapshotDigest: target.snapshotDigest, resolved }, freshCreation },
		{ ...createNativeOwnerInspectors(owner.options), runtime: "embedded_native", capabilities: ["native_resume"] },
	);
}

/** Internal baseline-factory hook: only a coordinator already owning this exact manager participates. */
export function nativeEmbeddedRuntimeConstructed(manager: SessionManager, result: CreateAgentSessionResult): void {
	const owner = nativeOwners.get(manager);
	if (!owner) return;
	owner.session = result.session;
	const service = new ExtensionInteractionService(manager.getSessionId());
	const { connectionId } = service.connect();
	const interaction = Object.freeze({ service, connectionId, ownership: "owned" as const });
	// Register ownership before UI binding, which is host code and may throw. Startup
	// failure must still dispose this exact runtime under coordinator authorization.
	owner.interaction = interaction;
	owner.coordinator.recordRuntimeStarted({ result, interaction, asyncJobs: owner.options.asyncJobs });
	const setToolUIContext = result.setToolUIContext;
	let boundUI: typeof service.ui | undefined;
	result.setToolUIContext = (ui, hasUI) => {
		if (ui !== owner.interaction?.service.ui || !hasUI)
			throw new Error("Native UI must use its registered interaction service");
		if (boundUI === ui) return;
		setToolUIContext(ui, hasUI);
		boundUI = ui;
	};
	result.setToolUIContext(service.ui, true);
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
		{ kind: "exclusive_native", expected, freshCreation: manager.getFreshOwnerCreation() },
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
	let owner: NativeOwner;
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
			retire(owner, op, result, authorization, closures.get(authorization)),
	});
	owner = {
		manager,
		membership,
		pending,
		coordinator,
		operations: new Set([pending]),
		options: admittedOptions,
	};
	nativeOwners.set(manager, owner);
	handles.set(coordinator.handle, owner);
	return continueOpen(owner);
}

/** Selection, construction and runtime publication share one owner-bound admission. */
function continueOpen(owner: NativeOwner): Promise<NativeEmbeddedOpenResult> {
	if (owner.openFlight) return owner.openFlight;
	const flight = constructNativeRuntime(owner, owner.options);
	owner.openFlight = flight;
	const settled = () => {
		if (owner.openFlight === flight) owner.openFlight = undefined;
	};
	void flight.then(settled, settled);
	return flight;
}

async function constructNativeRuntime(
	owner: NativeOwner,
	options: EmbeddedAgentSessionOptions,
): Promise<NativeEmbeddedOpenResult> {
	const pending = owner.pending;
	const selection = await owner.coordinator.resumeOpen(pending);
	owner.last = selection;
	if (selection.receipt.routing.action !== "PROCEED")
		return {
			kind: selection.receipt.routing.action === "RETAIN_LIVE" ? "uncertain_cursor" : "selection_incomplete",
			handle: owner.coordinator.handle,
			op: pending,
			selection,
		};
	try {
		const result = await createEmbeddedAgentSession(options);
		if (!owner.interaction) throw new Error("native_interaction_not_registered");
		owner.cleanup = () => result.releaseResources();
		const handoff = await owner.coordinator.resumeOpen(pending);
		owner.last = handoff;
		if (handoff.receipt.routing.action !== "PROCEED") throw new Error("native_runtime_handoff_not_ready");
		const handle = owner.coordinator.publishRuntime();
		bindNativeRuntimeInvocation(
			handle,
			() => owner.pending,
			(adopted, membership) => {
				owner.operations.add(adopted);
				owner.pending = adopted;
				if (!membership) return undefined;
				owner.membership = membership;
				const service = new ExtensionInteractionService(owner.manager.getSessionId());
				const { connectionId } = service.connect();
				owner.interaction = Object.freeze({ service, connectionId, ownership: "owned" as const });
				return owner.interaction;
			},
		);
		const runtime = createNativeEmbeddedRuntime(handle, result);
		return {
			kind: "opened",
			result,
			runtime,
			handle,
			op: pending,
			selection: handoff,
			interaction: owner.interaction,
		};
	} catch (error) {
		const final = await owner.coordinator.startupFailed(pending);
		owner.last = final;
		return {
			kind: "startup_failed",
			handle: owner.coordinator.handle,
			op: pending,
			selection: final,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function createNativeEmbeddedRuntime(
	handle: NativeLifecycleHandle,
	result: EmbeddedAgentSessionResult,
): NativeEmbeddedRuntime {
	const session = result.session;
	const runtime: NativeEmbeddedRuntime = {
		prompt: Object.freeze({
			prompt: (...args) => invokeNativeRuntime(handle, "prompt", () => session.prompt(...args)),
			promptCustomMessage: (...args) =>
				invokeNativeRuntime(handle, "prompt", () => session.promptCustomMessage(...args)),
			sendUserMessage: (...args) => invokeNativeRuntime(handle, "prompt", () => session.sendUserMessage(...args)),
			submitUserMessage: (...args) =>
				invokeNativeRuntime(handle, "prompt", () => session.submitUserMessage(...args)),
			continuePersistedHistory: (...args) =>
				invokeNativeRuntime(handle, "prompt", () => session.continuePersistedHistory(...args)),
		}),
		queue: Object.freeze({
			steer: (...args) => invokeNativeRuntime(handle, "queue", () => session.steer(...args)),
			followUp: (...args) => invokeNativeRuntime(handle, "queue", () => session.followUp(...args)),
			cancelAndSubmit: (...args) => invokeNativeRuntime(handle, "queue", () => session.cancelAndSubmit(...args)),
			cancelQueuedMessage: (...args) =>
				invokeNativeRuntime(handle, "queue", () => session.cancelQueuedMessage(...args)),
			cancelQueuedInputSubmission: (...args) =>
				invokeNativeRuntime(handle, "queue", () => session.cancelQueuedInputSubmission(...args)),
			removeQueuedMessageForEditing: (...args) =>
				invokeNativeRuntime(handle, "queue", () => session.removeQueuedMessageForEditing(...args)),
			moveQueuedMessageForEditing: (...args) =>
				invokeNativeRuntime(handle, "queue", () => session.moveQueuedMessageForEditing(...args)),
			popLastQueuedMessage: (...args) =>
				invokeNativeRuntime(handle, "queue", () => session.popLastQueuedMessage(...args)),
			setSteeringMode: (...args) => invokeNativeRuntime(handle, "queue", () => session.setSteeringMode(...args)),
			setFollowUpMode: (...args) => invokeNativeRuntime(handle, "queue", () => session.setFollowUpMode(...args)),
			setToolInterruptPolicy: (...args) =>
				invokeNativeRuntime(handle, "queue", () => session.setToolInterruptPolicy(...args)),
			abort: (...args) => invokeNativeRuntime(handle, "queue", () => session.abort(...args)),
		}),
		model: Object.freeze({
			setModelTemporaryForControl: (...args) =>
				invokeNativeRuntime(handle, "model", () => session.setModelTemporaryForControl(...args)),
			setDefaultModelSelection: (...args) =>
				invokeNativeRuntime(handle, "model", () => session.setDefaultModelSelection(...args)),
			activateModelProfileForControl: (...args) =>
				invokeNativeRuntime(handle, "model", () => session.activateModelProfileForControl(...args)),
			cycleModel: (...args) => invokeNativeRuntime(handle, "model", () => session.cycleModel(...args)),
			setSessionAgentModelSelection: (...args) =>
				invokeNativeRuntime(handle, "model", () => session.setSessionAgentModelSelection(...args)),
			setThinkingLevel: (...args) => invokeNativeRuntime(handle, "model", () => session.setThinkingLevel(...args)),
			cycleThinkingLevel: (...args) =>
				invokeNativeRuntime(handle, "model", () => session.cycleThinkingLevel(...args)),
		}),
		workflow: Object.freeze({
			invokeSkill: (...args) => invokeNativeRuntime(handle, "workflow", () => session.invokeSkill(...args)),
			setSdkPlanMode: (...args) => invokeNativeRuntime(handle, "workflow", () => session.setSdkPlanMode(...args)),
			operateGoal: (...args) => invokeNativeRuntime(handle, "workflow", () => session.operateGoal(...args)),
		}),
		operator: Object.freeze({
			execute: (...args) =>
				invokeNativeRuntime(handle, "operator", () => getSessionClientControls(session).operator.execute(...args)),
			read: (...args) =>
				invokeNativeRuntime(handle, "operator", () => getSessionClientControls(session).operator.read(...args)),
			cancel: (...args) =>
				invokeNativeRuntime(handle, "operator", () => getSessionClientControls(session).operator.cancel(...args)),
		}),
		activity: Object.freeze({
			control: (operation, input) =>
				invokeNativeRuntime(handle, "activity", () => {
					const activity = getSessionClientControls(session).activity;
					if (!activity) throw new Error("Native activity controls unavailable");
					return activity.control(operation, input);
				}),
		}),
		mcp: Object.freeze({
			snapshot: () =>
				invokeNativeRuntime(handle, "mcp", () => {
					const activity = getSessionClientControls(session).activity;
					if (!activity) throw new Error("Native activity controls unavailable");
					return activity.getMcpSnapshot();
				}),
			operate: (ref, action) =>
				invokeNativeRuntime(handle, "mcp", () => {
					const activity = getSessionClientControls(session).activity;
					if (!activity) throw new Error("Native activity controls unavailable");
					return activity.operateMcp({ ref }, action);
				}),
		}),
		preferences: Object.freeze({
			handle: (...args) =>
				invokeNativeRuntime(handle, "preferences", () =>
					getSessionClientControls(session).preferences.handle(...args),
				),
		}),
		authorization: Object.freeze({
			execute: (...args) =>
				invokeNativeRuntime(handle, "authorization", () =>
					getSessionClientControls(session).authorization.execute(...args),
				),
		}),
		composer: Object.freeze({
			dispatch: (...args) =>
				invokeNativeRuntime(handle, "composer", () => getSessionClientControls(session).composer.dispatch(...args)),
		}),
		diff: Object.freeze({
			dispatch: (...args) =>
				invokeNativeRuntime(handle, "diff", () => getSessionClientControls(session).diff.dispatch(...args)),
		}),
		side: Object.freeze({
			control: (...args) =>
				invokeNativeRuntime(handle, "side", () => getSessionClientControls(session).side.control(...args)),
		}),
		session: Object.freeze({
			revise: (input, options) => invokeNativeRuntime(handle, "session", () => result.revise(input, options)),
			branch: entryId => invokeNativeRuntime(handle, "session", () => result.branch(entryId)),
			refreshCommands: () => invokeNativeRuntime(handle, "session", () => result.refreshCommands()),
			refreshModels: strategy => invokeNativeRuntime(handle, "session", () => result.refreshModels(strategy)),
			setSessionName: (...args) => invokeNativeRuntime(handle, "session", () => session.setSessionName(...args)),
			setActiveToolsByName: (...args) =>
				invokeNativeRuntime(handle, "session", () => session.setActiveToolsByName(...args)),
			setThinkingLevelForControl: (...args) =>
				invokeNativeRuntime(handle, "session", () => session.setThinkingLevelForControl(...args)),
			reloadSkills: (...args) => invokeNativeRuntime(handle, "session", () => session.reloadSkills(...args)),
			compact: (...args) => invokeNativeRuntime(handle, "session", () => session.compact(...args)),
			clearContext: (...args) =>
				invokeNativeRuntime(handle, "session", async () => {
					const cleared = await session.clearContext(...args);
					// The parentless clear root must be selected durably before another dispatch.
					if (cleared) await session.selectExecutionBranchDurably(session.sessionManager.getLeafId());
					return cleared;
				}),
			retry: () => invokeNativeRuntime(handle, "session", () => session.retry()),
			generateAutoSessionTitle: (...args) =>
				invokeNativeRuntime(handle, "session", () => session.generateAutoSessionTitle(...args)),
			exportToHtml: (...args) => invokeNativeRuntime(handle, "session", () => session.exportToHtml(...args)),
		}),
	};
	return Object.freeze(runtime);
}

/** Resume only the retained coordinator-owned open, with the original factory inputs. */
export function resumeEmbeddedAgentSession(handle: NativeLifecycleHandle): Promise<NativeEmbeddedOpenResult> {
	const owner = ownerFor(handle);
	return continueOpen(owner);
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
	return serializeNativeRuntimeSelection(handle, async () => {
		if (owner.manager.getStrictCloseState().kind !== "none_started") throw new Error("manager_closed");
		const pending = await owner.manager.appendResumeCursorDurably(targetLeafId, { op: input.op, reason: "explicit" });
		owner.operations.add(pending);
		owner.pending = pending;
		return pending;
	});
}
/**
 * The operation this runtime currently reconciles. Durable selections committed by
 * admitted work replace it, so a host that holds the original `op` from `opened`
 * must re-read it before reconciling or disconnecting.
 */
export function currentEmbeddedResumeOperation(handle: NativeLifecycleHandle): PendingResumeOp {
	return ownerFor(handle).pending;
}
/**
 * The registered interaction bridge this runtime presents questions through. A native
 * runtime refuses every other UI context, so a host that renders dialogs itself answers
 * these requests with `service.respond` and cancels them with `service.cancel`.
 */
export function currentEmbeddedInteraction(handle: NativeLifecycleHandle): NonNullable<EmbeddedWorkSource["interaction"]> {
	const interaction = ownerFor(handle).interaction;
	if (!interaction) throw new Error("context_mismatch");
	return interaction;
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

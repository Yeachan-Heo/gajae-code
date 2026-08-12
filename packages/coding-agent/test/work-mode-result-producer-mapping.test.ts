import { afterEach, describe, expect, test } from "bun:test";
import { AuthStorage } from "@gajae-code/ai";
import { ModelRegistry } from "../src/config/model-registry";
import type { ScopedConfigurationMutationService } from "../src/config/scoped-configuration-mutation";
import { Settings } from "../src/config/settings";
import { getWorkModeExecutionCase } from "../src/config/work-mode-execution-cases";
import type { WorkModeOperationEvent, WorkModePreviewResult } from "../src/config/work-mode-result";
import {
	type WorkModeSessionRuntime,
	type WorkModeStagedTurn,
	WorkModeTransaction,
} from "../src/config/work-mode-transaction";

type ExecutionEvent = Exclude<WorkModeOperationEvent, { phase: "preview" }>;
type FinalizeEvent = Extract<ExecutionEvent, { phase: "turn_finalize" }>;

type TransactionFixture = Readonly<{
	authStorage: AuthStorage;
	transaction: WorkModeTransaction;
	events: WorkModeOperationEvent[];
	setActivationFailure: (failed: boolean) => void;
	setRestoreResult: (restored: boolean) => void;
}>;

type FixtureOptions = Readonly<{
	degraded?: boolean;
	withScopedMutation?: boolean;
}>;

const fixtures: TransactionFixture[] = [];

function isExecutionEvent(event: WorkModeOperationEvent): event is ExecutionEvent {
	return event.phase !== "preview";
}

function finalizationEvents(events: readonly WorkModeOperationEvent[]): FinalizeEvent[] {
	return events.filter((event): event is FinalizeEvent => event.phase === "turn_finalize");
}

function expectProduced(result: ExecutionEvent, events: readonly WorkModeOperationEvent[], beforeCount: number): void {
	const emitted = events.slice(beforeCount);
	expect(emitted).toHaveLength(1);
	const event = emitted[0];
	if (!event || !isExecutionEvent(event)) throw new Error("Expected one emitted Work Mode execution event");

	expect(event.phase).toBe(result.phase);
	expect(event.caseId).toBe(result.caseId);
	expect(event.receipt.receiptId).toBe(result.receipt.receiptId);

	const definition = getWorkModeExecutionCase(result.caseId);
	expect(definition.caseId).toBe(result.caseId);
	expect(definition.phase).toBe(result.phase);
	expect(definition.receiptCount).toBe(1);
	expect(emitted.map(candidate => (isExecutionEvent(candidate) ? candidate.receipt.receiptId : ""))).toHaveLength(1);
}

function expectReceiptCardinality(events: readonly WorkModeOperationEvent[]): void {
	const executionEvents = events.filter(isExecutionEvent);
	const receiptIds = executionEvents.map(event => event.receipt.receiptId);

	expect(receiptIds).toHaveLength(executionEvents.length);
	expect(receiptIds.every(receiptId => receiptId.length > 0)).toBe(true);
	expect(new Set(receiptIds).size).toBe(executionEvents.length);
}

function requireReadyPreview(preview: WorkModePreviewResult): Extract<WorkModePreviewResult, { state: "ready" }> {
	expect(preview.state).toBe("ready");
	if (preview.state !== "ready") throw new Error("Expected a ready Work Mode preview");
	return preview;
}

function requireDegradedPreview(preview: WorkModePreviewResult): Extract<WorkModePreviewResult, { state: "degraded" }> {
	expect(preview.state).toBe("degraded");
	if (preview.state !== "degraded") throw new Error("Expected a degraded Work Mode preview");
	return preview;
}

async function createFixture(options: FixtureOptions = {}): Promise<TransactionFixture> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("openai-codex", "producer-mapping-test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const originalModels = [...modelRegistry.getAll()];
	if (options.degraded) {
		modelRegistry.getAll = () => originalModels.filter(model => model.id !== "gpt-5.6-luna");
	}
	const initialModel = originalModels.find(model => model.provider === "openai-codex" && model.id === "gpt-5.6-terra");
	if (!initialModel) throw new Error("Expected the bundled openai-codex gpt-5.6-terra model");

	const settings = Settings.isolated({ modelRoles: {}, "task.agentModelOverrides": {} });
	const configuredChains = new Map<string, readonly string[]>();
	let activeProfile: string | undefined;
	let activationFailure = false;
	let restoreResult = true;
	const session: WorkModeSessionRuntime = {
		sessionId: "work-mode-result-producer-mapping",
		model: initialModel,
		thinkingLevel: undefined,
		setModelTemporary: async () => {
			if (activationFailure) throw new Error("synthetic activation failure");
		},
		beginTemporaryProviderSessionScope: reason => ({ reason }),
		restoreTemporaryProviderSessionScope: () => restoreResult,
		setActiveModelProfile: profileName => {
			activeProfile = profileName;
		},
		getActiveModelProfile: () => activeProfile,
		getConfiguredModelChain: role => configuredChains.get(role),
		setConfiguredModelChain: (role, entries) => {
			configuredChains.set(role, [...entries]);
		},
	};

	const scopedMutationService: Pick<ScopedConfigurationMutationService, "mutate"> | undefined =
		options.withScopedMutation
			? {
					mutate: async request => ({
						status: "committed",
						reason: null,
						scope: request.scope,
						safePath: null,
						beforeRevision: null,
						afterRevision: "1",
						beforeDigest: null,
						afterDigest: "producer-mapping-digest",
						timing: "current_runtime",
						confirmation: "confirmed",
						durability: "committed",
						patches: [{ op: "set", path: "modelProfile.default" }],
					}),
				}
			: undefined;

	const events: WorkModeOperationEvent[] = [];
	let receiptIndex = 0;
	let leaseIndex = 0;
	const transaction = new WorkModeTransaction({
		session,
		modelRegistry,
		settings,
		scopedMutationService,
		now: () => 1_000,
		receiptId: () => `producer-mapping-receipt-${++receiptIndex}`,
		turnLeaseId: () => `producer-mapping-lease-${++leaseIndex}`,
		emit: event => events.push(event),
	});
	const fixture = {
		authStorage,
		transaction,
		events,
		setActivationFailure: (failed: boolean) => {
			activationFailure = failed;
		},
		setRestoreResult: (restored: boolean) => {
			restoreResult = restored;
		},
	} satisfies TransactionFixture;
	fixtures.push(fixture);
	return fixture;
}

async function stageAcceptedTurn(
	fixture: TransactionFixture,
	preview: WorkModePreviewResult,
	operationId: string,
	confirmationAccepted?: boolean,
): Promise<WorkModeStagedTurn> {
	const beforeCount = fixture.events.length;
	const result = await fixture.transaction.stageTurn({
		modeId: "quick-edit",
		acceptedPreview: preview,
		scope: "turn",
		operationId,
		targetEligibleUserAdmissionGeneration: 0,
		confirmationAccepted,
	});
	expectProduced(result, fixture.events, beforeCount);
	if (result.caseId !== "turn_stage.ready" && result.caseId !== "turn_stage.degraded") {
		throw new Error(`Expected a staged Work Mode turn, got ${result.caseId}`);
	}
	const staged = fixture.transaction.getStagedTurn(operationId);
	if (!staged) throw new Error("Expected a staged Work Mode turn");
	return staged;
}

async function admitStagedTurn(
	fixture: TransactionFixture,
	staged: WorkModeStagedTurn,
	admissionTokenId: string,
): Promise<ExecutionEvent> {
	const beforeCount = fixture.events.length;
	const result = await fixture.transaction.admitTurn(staged, {
		admissionTokenId,
		rootLogicalRunId: `${admissionTokenId}-root`,
		targetGeneration: staged.targetEligibleUserAdmissionGeneration,
	});
	expectProduced(result, fixture.events, beforeCount);
	return result;
}

async function finalizeAdmittedTurn(
	fixture: TransactionFixture,
	operationId: string,
	reason: "completed" | "error" | "aborted" | "cancelled" | "handoff" | "disposed",
): Promise<FinalizeEvent> {
	const beforeCount = fixture.events.length;
	const result = await fixture.transaction.finalizeTurn(operationId, reason);
	if (!result) throw new Error("Expected a Work Mode finalization event");
	expectProduced(result, fixture.events, beforeCount);
	return result;
}

afterEach(() => {
	while (fixtures.length > 0) fixtures.pop()?.authStorage.close();
});

describe("Work Mode result producers", () => {
	test("apply emits a ready session result with its normative case and one receipt", async () => {
		const fixture = await createFixture();
		const preview = requireReadyPreview(await fixture.transaction.preview("quick-edit"));
		const beforeCount = fixture.events.length;

		const result = await fixture.transaction.apply({
			modeId: "quick-edit",
			acceptedPreview: preview,
			scope: "session",
			operationId: "apply-ready-session",
		});

		expectProduced(result, fixture.events, beforeCount);
		expect(result.phase).toBe("session_apply");
		expect(result.caseId).toBe("session_apply.ready");
		expect(getWorkModeExecutionCase(result.caseId).finalizeCount).toBe(0);
		expectReceiptCardinality(fixture.events);
	});

	test("ready stage, admission, and finalization use runtime producers and one finalization", async () => {
		const fixture = await createFixture();
		const preview = requireReadyPreview(await fixture.transaction.preview("quick-edit"));
		const staged = await stageAcceptedTurn(fixture, preview, "ready-turn");
		const admission = await admitStagedTurn(fixture, staged, "ready-admission-token");

		expect(admission.phase).toBe("turn_admission");
		expect(admission.caseId).toBe("turn_admission.ready");
		expect(getWorkModeExecutionCase(admission.caseId).finalizeCount).toBe(1);

		const finalization = await finalizeAdmittedTurn(fixture, staged.operationId, "completed");
		expect(finalization.phase).toBe("turn_finalize");
		expect(finalization.caseId).toBe("turn_finalize.ready");
		expect(finalization.finalReason).toBe("completed");
		expect(finalizationEvents(fixture.events)).toHaveLength(1);
		expect(await fixture.transaction.finalizeTurn(staged.operationId, "completed")).toBeUndefined();
		expectReceiptCardinality(fixture.events);
	});

	test("degraded apply, stage, admission, and finalization preserve their normative cases", async () => {
		const fixture = await createFixture({ degraded: true, withScopedMutation: true });
		const preview = requireDegradedPreview(await fixture.transaction.preview("quick-edit"));

		const applyBefore = fixture.events.length;
		const applied = await fixture.transaction.apply({
			modeId: "quick-edit",
			acceptedPreview: preview,
			scope: "project",
			confirmationAccepted: true,
			operationId: "degraded-project-apply",
		});
		expectProduced(applied, fixture.events, applyBefore);
		expect(applied.phase).toBe("persistent_apply");
		expect(applied.caseId).toBe("persistent_apply.degraded.committed");

		const staged = await stageAcceptedTurn(fixture, preview, "degraded-turn", true);
		const admission = await admitStagedTurn(fixture, staged, "degraded-admission-token");
		expect(admission.phase).toBe("turn_admission");
		expect(admission.caseId).toBe("turn_admission.degraded");

		const finalization = await finalizeAdmittedTurn(fixture, staged.operationId, "completed");
		expect(finalization.phase).toBe("turn_finalize");
		expect(finalization.caseId).toBe("turn_finalize.degraded");
		expect(finalization.finalReason).toBe("completed");
		expect(finalizationEvents(fixture.events)).toHaveLength(1);
		expectReceiptCardinality(fixture.events);
	});

	test("unavailable apply, stage, and admission results are emitted by their runtime producers", async () => {
		const applyFixture = await createFixture();
		const readyPreview = requireReadyPreview(await applyFixture.transaction.preview("quick-edit"));
		const applyBefore = applyFixture.events.length;
		const unavailableApply = await applyFixture.transaction.apply({
			modeId: "quick-edit",
			acceptedPreview: readyPreview,
			scope: "project",
			operationId: "unavailable-project-apply",
		});
		expectProduced(unavailableApply, applyFixture.events, applyBefore);
		expect(unavailableApply.phase).toBe("persistent_apply");
		expect(unavailableApply.caseId).toBe("persistent_apply.unavailable.mutation");
		expectReceiptCardinality(applyFixture.events);

		const stageFixture = await createFixture({ degraded: true });
		const degradedPreview = requireDegradedPreview(await stageFixture.transaction.preview("quick-edit"));
		const stageBefore = stageFixture.events.length;
		const unavailableStage = await stageFixture.transaction.stageTurn({
			modeId: "quick-edit",
			acceptedPreview: degradedPreview,
			scope: "turn",
			operationId: "unavailable-turn-stage",
			targetEligibleUserAdmissionGeneration: 0,
		});
		expectProduced(unavailableStage, stageFixture.events, stageBefore);
		expect(unavailableStage.phase).toBe("turn_stage");
		expect(unavailableStage.caseId).toBe("turn_stage.unavailable");
		expect(stageFixture.transaction.getStagedTurn("unavailable-turn-stage")).toBeUndefined();
		expectReceiptCardinality(stageFixture.events);

		const admissionFixture = await createFixture();
		const admissionPreview = requireReadyPreview(await admissionFixture.transaction.preview("quick-edit"));
		const staged = await stageAcceptedTurn(admissionFixture, admissionPreview, "activation-failed-turn");
		admissionFixture.setActivationFailure(true);
		const unavailableAdmission = await admitStagedTurn(admissionFixture, staged, "activation-failed-admission-token");
		expect(unavailableAdmission.phase).toBe("turn_admission");
		expect(unavailableAdmission.caseId).toBe("turn_admission.unavailable.runtime.activation_failed");
		expect(getWorkModeExecutionCase(unavailableAdmission.caseId).finalizeCount).toBe(0);
		expectReceiptCardinality(admissionFixture.events);
	});

	test("admission rollback failure is distinct from activation failure", async () => {
		const fixture = await createFixture();
		const preview = requireReadyPreview(await fixture.transaction.preview("quick-edit"));
		const staged = await stageAcceptedTurn(fixture, preview, "rollback-failed-admission-turn");
		fixture.setActivationFailure(true);
		fixture.setRestoreResult(false);

		const result = await admitStagedTurn(fixture, staged, "rollback-failed-admission-token");
		expect(result.phase).toBe("turn_admission");
		expect(result.caseId).toBe("turn_admission.unavailable.runtime.rollback_failed");
		expect(result.runtime).toEqual({ kind: "restore_failed", code: "turn_rollback_failed" });
		expectReceiptCardinality(fixture.events);
	});

	test("apply, stage, and admission report preview drift from fresh runtime preflight", async () => {
		const applyFixture = await createFixture();
		const applyPreview = requireReadyPreview(await applyFixture.transaction.preview("quick-edit"));
		applyFixture.authStorage.removeRuntimeApiKey("openai-codex");
		const applyBefore = applyFixture.events.length;
		const driftedApply = await applyFixture.transaction.apply({
			modeId: "quick-edit",
			acceptedPreview: applyPreview,
			scope: "session",
			operationId: "drifted-session-apply",
		});
		expectProduced(driftedApply, applyFixture.events, applyBefore);
		expect(driftedApply.phase).toBe("session_apply");
		expect(driftedApply.caseId).toBe("session_apply.drifted");
		expectReceiptCardinality(applyFixture.events);

		const stageFixture = await createFixture();
		const stagePreview = requireReadyPreview(await stageFixture.transaction.preview("quick-edit"));
		stageFixture.authStorage.removeRuntimeApiKey("openai-codex");
		const stageBefore = stageFixture.events.length;
		const driftedStage = await stageFixture.transaction.stageTurn({
			modeId: "quick-edit",
			acceptedPreview: stagePreview,
			scope: "turn",
			operationId: "drifted-turn-stage",
			targetEligibleUserAdmissionGeneration: 0,
		});
		expectProduced(driftedStage, stageFixture.events, stageBefore);
		expect(driftedStage.phase).toBe("turn_stage");
		expect(driftedStage.caseId).toBe("turn_stage.drifted");
		expectReceiptCardinality(stageFixture.events);

		const admissionFixture = await createFixture();
		const admissionPreview = requireReadyPreview(await admissionFixture.transaction.preview("quick-edit"));
		const staged = await stageAcceptedTurn(admissionFixture, admissionPreview, "drifted-admission-turn");
		admissionFixture.authStorage.removeRuntimeApiKey("openai-codex");
		const admissionBefore = admissionFixture.events.length;
		const driftedAdmission = await admissionFixture.transaction.admitTurn(staged, {
			admissionTokenId: "drifted-admission-token",
			rootLogicalRunId: "drifted-admission-root",
			targetGeneration: staged.targetEligibleUserAdmissionGeneration,
		});
		expectProduced(driftedAdmission, admissionFixture.events, admissionBefore);
		expect(driftedAdmission.phase).toBe("turn_admission");
		expect(driftedAdmission.caseId).toBe("turn_admission.drifted");
		expectReceiptCardinality(admissionFixture.events);
	});

	test("finalize emits one restore-failed result when admitted cleanup rolls back unsuccessfully", async () => {
		const fixture = await createFixture();
		const preview = requireReadyPreview(await fixture.transaction.preview("quick-edit"));
		const staged = await stageAcceptedTurn(fixture, preview, "restore-failed-finalization-turn");
		await admitStagedTurn(fixture, staged, "restore-failed-finalization-token");
		fixture.setRestoreResult(false);

		const finalization = await finalizeAdmittedTurn(fixture, staged.operationId, "error");
		expect(finalization.phase).toBe("turn_finalize");
		expect(finalization.caseId).toBe("turn_finalize.unavailable.restore_failed");
		expect(finalization.runtime).toEqual({ kind: "restore_failed", code: "turn_rollback_failed" });
		expect(finalization.finalReason).toBe("error");
		expect(getWorkModeExecutionCase(finalization.caseId).finalizeCount).toBe(1);
		expect(finalizationEvents(fixture.events)).toHaveLength(1);
		expect(await fixture.transaction.finalizeTurn(staged.operationId, "error")).toBeUndefined();
		expectReceiptCardinality(fixture.events);
	});
});

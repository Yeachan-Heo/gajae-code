import { afterEach, describe, expect, test, vi } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { prepareModelProfileActivation } from "../src/config/model-profile-activation";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { WorkModeExecutionCaseMap, WorkModeTurnFinalizeCaseMap } from "../src/config/work-mode-execution-cases";
import type { WorkModeOperationEvent } from "../src/config/work-mode-result";
import { PartialTurnWorkModeActivation, WorkModeTransaction } from "../src/config/work-mode-transaction";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

type Fixture = Readonly<{
	authStorage: AuthStorage;
	session: AgentSession;
	modelRegistry: ModelRegistry;
}>;

type TransactionFixture = Readonly<{
	fixture: Fixture;
	transaction: WorkModeTransaction;
	events: WorkModeOperationEvent[];
}>;

type TurnAdmissionEvent = Extract<WorkModeOperationEvent, { phase: "turn_admission" }>;
type TurnFinalizeEvent = Extract<WorkModeOperationEvent, { phase: "turn_finalize" }>;
type AdmittedTurnAdmissionEvent =
	| WorkModeExecutionCaseMap["turn_admission.ready"]
	| WorkModeExecutionCaseMap["turn_admission.degraded"];
type ReadyTurnFinalizeEvent = WorkModeTurnFinalizeCaseMap["turn_finalize.ready"];
type DegradedTurnFinalizeEvent = WorkModeTurnFinalizeCaseMap["turn_finalize.degraded"];
type RestoreFailedTurnFinalizeEvent = WorkModeTurnFinalizeCaseMap["turn_finalize.unavailable.restore_failed"];
type ReceiptBearingEvent = Exclude<WorkModeOperationEvent, { phase: "preview" }>;

function isReceiptBearingEvent(event: WorkModeOperationEvent): event is ReceiptBearingEvent {
	return event.phase !== "preview";
}

function isAdmittedTurnAdmissionEvent(event: WorkModeOperationEvent): event is AdmittedTurnAdmissionEvent {
	return (
		isReceiptBearingEvent(event) &&
		event.phase === "turn_admission" &&
		(event.caseId === "turn_admission.ready" || event.caseId === "turn_admission.degraded") &&
		(event.state === "ready" || event.state === "degraded")
	);
}

function isReadyTurnFinalizeEvent(event: WorkModeOperationEvent): event is ReadyTurnFinalizeEvent {
	return (
		isReceiptBearingEvent(event) &&
		event.phase === "turn_finalize" &&
		event.caseId === "turn_finalize.ready" &&
		event.state === "ready"
	);
}

function isDegradedTurnFinalizeEvent(event: WorkModeOperationEvent): event is DegradedTurnFinalizeEvent {
	return (
		isReceiptBearingEvent(event) &&
		event.phase === "turn_finalize" &&
		event.caseId === "turn_finalize.degraded" &&
		event.state === "degraded"
	);
}

function isRestoreFailedTurnFinalizeEvent(event: WorkModeOperationEvent): event is RestoreFailedTurnFinalizeEvent {
	return (
		isReceiptBearingEvent(event) &&
		event.phase === "turn_finalize" &&
		event.caseId === "turn_finalize.unavailable.restore_failed" &&
		event.state === "unavailable"
	);
}

function receiptIds(events: readonly WorkModeOperationEvent[]): string[] {
	return events.filter(isReceiptBearingEvent).map(event => event.receipt.receiptId);
}

const fixtures: Fixture[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	while (fixtures.length > 0) {
		const fixture = fixtures.pop();
		if (!fixture) continue;
		await fixture.session.dispose();
		fixture.authStorage.close();
	}
});

async function createFixture(responseCount = 2, degraded = false): Promise<TransactionFixture> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("openai-codex", "test-key");
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const initialModel = modelRegistry.getAll().find(model => model.provider === "anthropic");
	if (!initialModel) throw new Error("Expected an Anthropic model in the test registry");
	if (degraded) {
		const availableModels = modelRegistry.getAll().filter(model => model.id !== "gpt-5.6-luna");
		vi.spyOn(modelRegistry, "getAll").mockReturnValue(availableModels);
	}
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: initialModel, systemPrompt: ["test"], tools: [], messages: [] },
		streamFn: createMockModel({ responses: Array.from({ length: responseCount }, () => ({ content: ["Done"] })) })
			.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "todo.reminders": false }),
		modelRegistry,
	});
	const fixture = { authStorage, session, modelRegistry } satisfies Fixture;
	fixtures.push(fixture);
	const events: WorkModeOperationEvent[] = [];
	let receiptIndex = 0;
	let leaseIndex = 0;
	const transaction = new WorkModeTransaction({
		session,
		modelRegistry,
		settings: session.settings,
		operationId: () => "finalize-operation",
		receiptId: () => `finalize-receipt-${++receiptIndex}`,
		turnLeaseId: () => `finalize-lease-${++leaseIndex}`,
		emit: event => events.push(event),
	});
	return { fixture, transaction, events };
}

async function admit(transaction: WorkModeTransaction): Promise<AdmittedTurnAdmissionEvent> {
	const preview = await transaction.preview("quick-edit");
	if (preview.state === "unavailable") throw new Error(`Work Mode preview unavailable: ${preview.reason}`);
	const stage = await transaction.stageTurn({
		modeId: "quick-edit",
		acceptedPreview: preview,
		scope: "turn",
		operationId: "finalize-operation",
		targetEligibleUserAdmissionGeneration: 0,
		confirmationAccepted: preview.state === "degraded",
	});
	if (stage.caseId !== "turn_stage.ready" && stage.caseId !== "turn_stage.degraded") {
		throw new Error(`Work Mode stage unavailable: ${stage.caseId}`);
	}
	const staged = transaction.getStagedTurn("finalize-operation");
	if (!staged) throw new Error("Expected staged Work Mode turn");
	const admission = await transaction.admitTurn(staged, {
		admissionTokenId: "finalize-admission-token",
		rootLogicalRunId: "finalize-root",
		targetGeneration: 0,
	});
	if (!isAdmittedTurnAdmissionEvent(admission)) {
		throw new Error(`Work Mode admission unavailable: ${admission.caseId}`);
	}
	return admission;
}

function admissionEvents(events: readonly WorkModeOperationEvent[]): TurnAdmissionEvent[] {
	return events.filter(
		(event): event is TurnAdmissionEvent => isReceiptBearingEvent(event) && event.phase === "turn_admission",
	);
}

function finalizationEvents(events: readonly WorkModeOperationEvent[]): TurnFinalizeEvent[] {
	return events.filter(
		(event): event is TurnFinalizeEvent => isReceiptBearingEvent(event) && event.phase === "turn_finalize",
	);
}

describe("Work Mode turn finalization", () => {
	test("finalizes a ready lease once and makes the later finalizer idempotent", async () => {
		const { transaction, events } = await createFixture();
		const admission = await admit(transaction);
		const first = await transaction.finalizeTurn("finalize-operation", "completed");
		const second = await transaction.finalizeTurn("finalize-operation", "completed");

		if (!first) throw new Error("Expected ready finalization event");
		if (!isReadyTurnFinalizeEvent(first)) throw new Error(`Unexpected finalization case: ${first.caseId}`);
		expect(first.caseId).toBe("turn_finalize.ready");
		expect(first.admissionReceiptId).toBe(admission.admissionReceiptId);
		expect(first.turnLeaseId).toBe(admission.turnLeaseId);
		expect(first.finalReason).toBe("completed");
		expect(first.receipt.runtime).toEqual({ kind: "restored" });
		expect(second).toBeUndefined();
		expect(admissionEvents(events)).toHaveLength(1);
		expect(finalizationEvents(events)).toHaveLength(1);
		expect(new Set(receiptIds(events)).size).toBe(events.length);
	});

	test("finalizes a degraded lease once and preserves its accepted confirmation", async () => {
		const { transaction, events } = await createFixture(1, true);
		const admission = await admit(transaction);
		expect(admission.caseId).toBe("turn_admission.degraded");
		expect(admission.confirmation).toEqual({ required: true, accepted: true });

		const first = await transaction.finalizeTurn("finalize-operation", "completed");
		const second = await transaction.finalizeTurn("finalize-operation", "completed");
		if (!first) throw new Error("Expected degraded finalization event");
		if (!isDegradedTurnFinalizeEvent(first)) throw new Error(`Unexpected finalization case: ${first.caseId}`);
		expect(first.caseId).toBe("turn_finalize.degraded");
		expect(first.state).toBe("degraded");
		expect(first.confirmation).toEqual({ required: true, accepted: true });
		expect(first.receipt.runtime).toEqual({ kind: "restored" });
		expect(second).toBeUndefined();
		expect(admissionEvents(events)).toHaveLength(1);
		expect(finalizationEvents(events)).toHaveLength(1);
		expect(new Set(receiptIds(events)).size).toBe(events.length);
	});

	test("promotes only after complete setup", async () => {
		const { fixture, transaction } = await createFixture();
		const preview = await transaction.preview("quick-edit");
		if (preview.state === "unavailable") throw new Error(`Work Mode preview unavailable: ${preview.reason}`);
		const prepared = await prepareModelProfileActivation({
			session: fixture.session,
			modelRegistry: fixture.modelRegistry,
			settings: fixture.session.settings,
			profileName: "codex-eco",
		});
		const partial = new PartialTurnWorkModeActivation({
			partialActivationId: "promotion-partial",
			operationId: "promotion-operation",
			acceptedFingerprint: preview.fingerprint,
			observedFingerprint: preview.fingerprint,
			session: fixture.session,
			settings: fixture.session.settings,
		});

		expect(() => partial.markTransferred()).toThrow("partial activation is not promotable");
		await partial.setup(prepared);
		expect(partial.state).toBe("setup_complete");
		partial.markTransferred();
		expect(partial.transferred).toBe(true);
		expect(partial.state).toBe("transferred");
		expect(await partial.restoreIntoSession()).toBe(true);
		expect(partial.state).toBe("cleaned");
	});

	test("concurrent cancellation and disposal share one finalization receipt", async () => {
		const { transaction, events } = await createFixture();
		await admit(transaction);
		const lease = transaction.getTurnLease("finalize-operation");
		if (!lease) throw new Error("Expected admitted Work Mode lease");
		let now = 10;
		const options = {
			receiptId: "concurrent-finalization",
			now: () => ++now,
			emit: (event: WorkModeOperationEvent) => events.push(event),
		};
		const [cancelled, disposed] = await Promise.all([
			lease.finalize("cancelled", options),
			lease.finalize("disposed", options),
		]);

		expect(cancelled).toBe(disposed);
		if (!isReadyTurnFinalizeEvent(cancelled)) throw new Error(`Unexpected finalization case: ${cancelled.caseId}`);
		expect(cancelled.phase).toBe("turn_finalize");
		expect(cancelled.finalReason).toBe("cancelled");
		expect(finalizationEvents(events)).toHaveLength(1);
	});

	test("restore failure emits admitted finalize unavailable and fences the next dispatch", async () => {
		const { fixture } = await createFixture();
		const preview = await fixture.session.previewWorkMode("quick-edit");
		if (preview.state === "unavailable") throw new Error(`Work Mode preview unavailable: ${preview.reason}`);
		const staged = await fixture.session.stageWorkMode({
			modeId: "quick-edit",
			acceptedPreview: preview,
			scope: "turn",
			operationId: "fenced-finalize-operation",
			confirmationAccepted: preview.state === "degraded",
		});
		if (staged.state !== "ready" && staged.state !== "degraded") throw new Error("Expected staged Work Mode turn");
		vi.spyOn(fixture.session, "restoreTemporaryProviderSessionScope").mockImplementationOnce(() => false);
		const accepted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const prompt = fixture.session.prompt("admitted request", {
			onPreflightAcceptCommit: async () => {
				accepted.resolve();
				await release.promise;
			},
		});
		await accepted.promise;
		const finalized = await fixture.session.finalizeWorkModeTurn("cancelled");
		if (!finalized) throw new Error("Expected finalize event");
		if (!isRestoreFailedTurnFinalizeEvent(finalized)) {
			throw new Error(`Unexpected finalization case: ${finalized.caseId}`);
		}
		expect(finalized.caseId).toBe("turn_finalize.unavailable.restore_failed");
		expect(finalized.state).toBe("unavailable");
		expect(finalized.receipt.runtime).toEqual({ kind: "restore_failed", code: "turn_rollback_failed" });
		expect(fixture.session.getWorkModeEvents().filter(event => event.phase === "turn_finalize")).toHaveLength(1);
		expect(fixture.session.getWorkModeEvents().filter(event => event.phase === "turn_admission")).toHaveLength(1);
		expect(new Set(receiptIds(fixture.session.getWorkModeEvents())).size).toBe(
			fixture.session.getWorkModeEvents().length,
		);
		expect(fixture.session.getWorkModeStagedTurn()).toBeUndefined();
		release.resolve();
		await expect(prompt).rejects.toThrow("Work Mode dispatch is fenced pending recovery.");
		await expect(fixture.session.prompt("dispatch after failed restore")).rejects.toThrow(
			"Work Mode dispatch is fenced pending recovery.",
		);
	});
});

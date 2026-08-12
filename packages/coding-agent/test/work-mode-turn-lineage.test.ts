import { afterEach, describe, expect, test } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { WorkModeExecutionCaseMap, WorkModeTurnFinalizeCaseMap } from "../src/config/work-mode-execution-cases";
import type { WorkModeOperationEvent } from "../src/config/work-mode-result";
import { WorkModeTransaction, type WorkModeTurnLeaseLineage } from "../src/config/work-mode-transaction";
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
type ReceiptBearingEvent = Exclude<WorkModeOperationEvent, { phase: "preview" }>;

function isAdmittedTurnAdmissionEvent(event: WorkModeOperationEvent): event is AdmittedTurnAdmissionEvent {
	return (
		event.phase === "turn_admission" &&
		(event.caseId === "turn_admission.ready" || event.caseId === "turn_admission.degraded") &&
		(event.state === "ready" || event.state === "degraded")
	);
}

function isReadyTurnFinalizeEvent(event: WorkModeOperationEvent): event is ReadyTurnFinalizeEvent {
	return event.phase === "turn_finalize" && event.caseId === "turn_finalize.ready" && event.state === "ready";
}

function receiptIds(events: readonly WorkModeOperationEvent[]): string[] {
	return events
		.filter((event): event is ReceiptBearingEvent => event.phase !== "preview")
		.map(event => event.receipt.receiptId);
}

const fixtures: Fixture[] = [];

afterEach(async () => {
	while (fixtures.length > 0) {
		const fixture = fixtures.pop();
		if (!fixture) continue;
		await fixture.session.dispose();
		fixture.authStorage.close();
	}
});

async function createTransactionFixture(): Promise<TransactionFixture> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("openai-codex", "test-key");
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const initialModel = modelRegistry.getAll().find(model => model.provider === "anthropic");
	if (!initialModel) throw new Error("Expected an Anthropic model in the test registry");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model: initialModel, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
		}),
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
		operationId: () => "lineage-operation",
		receiptId: () => `lineage-receipt-${++receiptIndex}`,
		turnLeaseId: () => `lineage-lease-${++leaseIndex}`,
		emit: event => events.push(event),
	});
	return { fixture, transaction, events };
}

async function admit(transaction: WorkModeTransaction): Promise<WorkModeTurnLeaseLineage> {
	const preview = await transaction.preview("quick-edit");
	if (preview.state === "unavailable") throw new Error(`Work Mode preview unavailable: ${preview.reason}`);
	const stage = await transaction.stageTurn({
		modeId: "quick-edit",
		acceptedPreview: preview,
		scope: "turn",
		operationId: "lineage-operation",
		targetEligibleUserAdmissionGeneration: 0,
		confirmationAccepted: preview.state === "degraded",
	});
	if (stage.caseId !== "turn_stage.ready" && stage.caseId !== "turn_stage.degraded") {
		throw new Error(`Work Mode stage unavailable: ${stage.caseId}`);
	}
	const staged = transaction.getStagedTurn("lineage-operation");
	if (!staged) throw new Error("Expected staged Work Mode turn");
	const admission = await transaction.admitTurn(staged, {
		admissionTokenId: "lineage-admission-token",
		rootLogicalRunId: "root-run",
		targetGeneration: 0,
	});
	if (!isAdmittedTurnAdmissionEvent(admission)) {
		throw new Error(`Work Mode admission unavailable: ${admission.caseId}`);
	}
	const lease = transaction.getTurnLease("lineage-operation");
	if (!lease) throw new Error("Expected admitted Work Mode lease");
	return lease.lineage;
}

function admissionEvents(events: readonly WorkModeOperationEvent[]): TurnAdmissionEvent[] {
	return events.filter((event): event is TurnAdmissionEvent => event.phase === "turn_admission");
}

function finalizationEvents(events: readonly WorkModeOperationEvent[]): TurnFinalizeEvent[] {
	return events.filter((event): event is TurnFinalizeEvent => event.phase === "turn_finalize");
}

describe("Work Mode turn lease lineage", () => {
	test("accepts only the next retry or profile-internal continuation epoch", async () => {
		const { transaction, events } = await createTransactionFixture();
		const lineage = await admit(transaction);
		const continuation = { ...lineage, continuationEpoch: lineage.continuationEpoch + 1 };

		expect(transaction.isValidTurnLineage("lineage-operation", continuation, "retry")).toBe(true);
		expect(transaction.isValidTurnLineage("lineage-operation", continuation, "profile_internal_fallback")).toBe(true);
		expect(
			transaction.isValidTurnLineage(
				"lineage-operation",
				{ ...continuation, continuationEpoch: continuation.continuationEpoch + 1 },
				"retry",
			),
		).toBe(false);
		expect(
			transaction.isValidTurnLineage(
				"lineage-operation",
				{ ...continuation, rootLogicalRunId: "foreign-root" },
				"retry",
			),
		).toBe(false);
		expect(transaction.isValidTurnLineage("foreign-operation", continuation, "profile_internal_fallback")).toBe(
			false,
		);
		expect(admissionEvents(events)).toHaveLength(1);
		expect(new Set(receiptIds(events)).size).toBe(events.length);

		expect(finalizationEvents(events)).toHaveLength(0);
	});

	test("restores the admitted session before rejecting a foreign successor", async () => {
		const { fixture, transaction, events } = await createTransactionFixture();
		const originalModel = fixture.session.model;
		const lineage = await admit(transaction);
		expect(fixture.session.model).not.toBe(originalModel);
		expect(
			transaction.isValidTurnLineage(
				"lineage-operation",
				{ ...lineage, continuationEpoch: lineage.continuationEpoch + 1, rootLogicalRunId: "foreign-root" },
				"retry",
			),
		).toBe(false);

		const finalized = await transaction.finalizeTurn("lineage-operation", "handoff");
		if (!finalized) throw new Error("Expected finalization event");
		if (!isReadyTurnFinalizeEvent(finalized)) throw new Error(`Unexpected finalization case: ${finalized.caseId}`);
		expect(finalized.caseId).toBe("turn_finalize.ready");
		expect(fixture.session.model).toBe(originalModel);
		expect(transaction.getTurnLease("lineage-operation")).toBeUndefined();
		expect(
			transaction.isValidTurnLineage(
				"lineage-operation",
				{ ...lineage, continuationEpoch: lineage.continuationEpoch + 1 },
				"retry",
			),
		).toBe(false);
		expect(events.map(event => event.phase)).toEqual(["turn_stage", "turn_admission", "turn_finalize"]);
		expect(finalizationEvents(events)).toHaveLength(1);
		expect(new Set(receiptIds(events)).size).toBe(events.length);
	});
});

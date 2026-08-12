import { afterEach, describe, expect, test } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { WorkModeExecutionCaseMap } from "../src/config/work-mode-execution-cases";
import type { WorkModeOperationEvent } from "../src/config/work-mode-result";
import {
	type TopLevelUserAdmissionToken,
	type WorkModeStagedTurn,
	WorkModeTransaction,
} from "../src/config/work-mode-transaction";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

type TurnAdmissionEvent = Extract<WorkModeOperationEvent, { phase: "turn_admission" }>;
type TurnFinalizeEvent = Extract<WorkModeOperationEvent, { phase: "turn_finalize" }>;
type PreGateCancelledEvent = WorkModeExecutionCaseMap["turn_admission.unavailable.pre_gate_cancelled"];
type PreGateRejectedEvent = WorkModeExecutionCaseMap["turn_admission.unavailable.pre_gate_rejected"];
type PreGateSettlementEvent = PreGateCancelledEvent | PreGateRejectedEvent;

function isTurnAdmissionEvent(event: WorkModeOperationEvent): event is TurnAdmissionEvent {
	return event.phase === "turn_admission";
}

function isTurnFinalizeEvent(event: WorkModeOperationEvent): event is TurnFinalizeEvent {
	return event.phase === "turn_finalize";
}

function isPreGateCancelledEvent(event: WorkModeOperationEvent): event is PreGateCancelledEvent {
	return (
		event.phase === "turn_admission" &&
		event.caseId === "turn_admission.unavailable.pre_gate_cancelled" &&
		event.state === "unavailable"
	);
}

function isPreGateRejectedEvent(event: WorkModeOperationEvent): event is PreGateRejectedEvent {
	return (
		event.phase === "turn_admission" &&
		event.caseId === "turn_admission.unavailable.pre_gate_rejected" &&
		event.state === "unavailable"
	);
}

function isPreGateSettlementEvent(event: WorkModeOperationEvent): event is PreGateSettlementEvent {
	return isPreGateCancelledEvent(event) || isPreGateRejectedEvent(event);
}

const fixtures: Array<{ session: AgentSession; authStorage: AuthStorage }> = [];

afterEach(async () => {
	while (fixtures.length > 0) {
		const fixture = fixtures.pop();
		if (!fixture) continue;
		await fixture.session.dispose();
		fixture.authStorage.close();
	}
});

async function createFixture(): Promise<{
	authStorage: AuthStorage;
	session: AgentSession;
	transaction: WorkModeTransaction;
	events: WorkModeOperationEvent[];
}> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("openai-codex", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const initialModel = modelRegistry.getAll().find(model => model.provider === "openai-codex");
	if (!initialModel) throw new Error("Expected an OpenAI Codex model in the test registry");
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
	fixtures.push({ session, authStorage });
	const events: WorkModeOperationEvent[] = [];
	let receiptIndex = 0;
	const transaction = new WorkModeTransaction({
		session,
		modelRegistry,
		settings: session.settings,
		receiptId: () => `pre-gate-receipt-${++receiptIndex}`,
		emit: event => events.push(event),
	});
	return { authStorage, session, transaction, events };
}

async function stage(transaction: WorkModeTransaction, operationId: string): Promise<WorkModeStagedTurn> {
	const preview = await transaction.preview("quick-edit");
	if (preview.state !== "ready") throw new Error(`Expected ready Work Mode preview, got ${preview.state}`);
	const event = await transaction.stageTurn({
		modeId: "quick-edit",
		acceptedPreview: preview,
		scope: "turn",
		operationId,
		targetEligibleUserAdmissionGeneration: 0,
	});
	if (event.caseId !== "turn_stage.ready") throw new Error(`Expected ready Work Mode stage, got ${event.caseId}`);
	const staged = transaction.getStagedTurn(operationId);
	if (!staged) throw new Error("Expected staged Work Mode turn");
	return staged;
}

function admissionEvents(events: readonly WorkModeOperationEvent[]): TurnAdmissionEvent[] {
	return events.filter(isTurnAdmissionEvent);
}

function finalizationEvents(events: readonly WorkModeOperationEvent[]): TurnFinalizeEvent[] {
	return events.filter(isTurnFinalizeEvent);
}

function expectPreGateSettled(
	transaction: WorkModeTransaction,
	events: readonly WorkModeOperationEvent[],
	staged: WorkModeStagedTurn,
	reason:
		| "turn_admission_cancelled"
		| "turn_admission_handoff_cancelled"
		| "turn_admission_setup_failed"
		| "turn_admission_disposed",
	token: TopLevelUserAdmissionToken,
): void {
	const event = admissionEvents(events).at(-1);
	if (!event) throw new Error("Expected one pre-gate settlement event");
	if (!isPreGateSettlementEvent(event)) {
		throw new Error("Expected a pre-gate settlement admission event");
	}
	expect(event.caseId).toBe(
		reason === "turn_admission_setup_failed"
			? "turn_admission.unavailable.pre_gate_rejected"
			: "turn_admission.unavailable.pre_gate_cancelled",
	);
	expect(event.phase).toBe("turn_admission");
	expect(event.state).toBe("unavailable");
	expect(event.reason).toBe(reason);
	expect(event.runtime).toEqual(
		reason === "turn_admission_setup_failed"
			? { kind: "rejected", code: "turn_admission_setup_failed" }
			: { kind: "cancelled", code: reason },
	);
	expect(event.receipt.relation.kind).toBe("not_observed");
	expect(event.receipt.durable).toEqual({ kind: "not_requested" });
	expect(event.receipt.facts).toEqual({ mustRestage: true, admissionTokenId: token.tokenId });
	expect(event.admissionTokenId).toBe(token.tokenId);
	expect(event.mustRestage).toBe(true);
	expect(transaction.getStagedTurn(staged.operationId)).toBeUndefined();
}

describe("Work Mode direct pre-gate settlement", () => {
	test("cancellation settles the token once, clears its stage, and emits no finalizer", async () => {
		const { transaction, events } = await createFixture();
		const staged = await stage(transaction, "pre-gate-cancel");
		const token: TopLevelUserAdmissionToken = {
			tokenId: "token-cancel",
			operationId: staged.operationId,
			targetEligibleUserAdmissionGeneration: staged.targetEligibleUserAdmissionGeneration,
		};

		transaction.settlePreGate(staged, "turn_admission_cancelled", token.tokenId);
		expectPreGateSettled(transaction, events, staged, "turn_admission_cancelled", token);
		expect(await transaction.finalizeTurn(staged.operationId, "cancelled")).toBeUndefined();
		expect(finalizationEvents(events)).toHaveLength(0);
	});

	test("handoff cancellation settles the token once without retargeting or finalization", async () => {
		const { transaction, events } = await createFixture();
		const staged = await stage(transaction, "pre-gate-handoff");
		const token: TopLevelUserAdmissionToken = {
			tokenId: "token-handoff",
			operationId: staged.operationId,
			targetEligibleUserAdmissionGeneration: staged.targetEligibleUserAdmissionGeneration,
		};

		transaction.settlePreGate(staged, "turn_admission_handoff_cancelled", token.tokenId);
		expectPreGateSettled(transaction, events, staged, "turn_admission_handoff_cancelled", token);
		expect(transaction.getStagedTurn(staged.operationId)).toBeUndefined();
		expect(await transaction.finalizeTurn(staged.operationId, "handoff")).toBeUndefined();
		expect(finalizationEvents(events)).toHaveLength(0);
	});

	test("setup failure settles as rejected, clears the staged request, and requires restage", async () => {
		const { transaction, events } = await createFixture();
		const staged = await stage(transaction, "pre-gate-setup-failure");
		const token: TopLevelUserAdmissionToken = {
			tokenId: "token-setup-failure",
			operationId: staged.operationId,
			targetEligibleUserAdmissionGeneration: staged.targetEligibleUserAdmissionGeneration,
		};

		transaction.settlePreGate(staged, "turn_admission_setup_failed", token.tokenId);
		expectPreGateSettled(transaction, events, staged, "turn_admission_setup_failed", token);
		expect(await transaction.finalizeTurn(staged.operationId, "error")).toBeUndefined();
		const restaged = await stage(transaction, "pre-gate-setup-failure-restaged");
		expect(restaged.operationId).toBe("pre-gate-setup-failure-restaged");
	});

	test("disposal settles as cancellation, clears the token and stage, and emits no finalizer", async () => {
		const { transaction, events } = await createFixture();
		const staged = await stage(transaction, "pre-gate-disposed");
		const token: TopLevelUserAdmissionToken = {
			tokenId: "token-disposed",
			operationId: staged.operationId,
			targetEligibleUserAdmissionGeneration: staged.targetEligibleUserAdmissionGeneration,
		};

		transaction.settlePreGate(staged, "turn_admission_disposed", token.tokenId);
		expectPreGateSettled(transaction, events, staged, "turn_admission_disposed", token);
		expect(await transaction.finalizeTurn(staged.operationId, "disposed")).toBeUndefined();
		expect(finalizationEvents(events)).toHaveLength(0);
	});

	test("a settled token cannot be retargeted or admitted; only a new stage can proceed", async () => {
		const { transaction, events } = await createFixture();
		const staged = await stage(transaction, "pre-gate-no-retarget");
		const token: TopLevelUserAdmissionToken = {
			tokenId: "token-no-retarget",
			operationId: staged.operationId,
			targetEligibleUserAdmissionGeneration: staged.targetEligibleUserAdmissionGeneration,
		};
		const settled = transaction.settlePreGate(staged, "turn_admission_cancelled", token.tokenId);

		expectPreGateSettled(transaction, events, staged, "turn_admission_cancelled", token);

		const staleAdmission = await transaction.admitTurn(staged, {
			admissionTokenId: token.tokenId,
			rootLogicalRunId: "root-no-retarget",
			targetGeneration: token.targetEligibleUserAdmissionGeneration,
		});
		expect(staleAdmission).toBe(settled);
		if (!isPreGateCancelledEvent(staleAdmission)) {
			throw new Error("Expected a pre-gate cancellation admission event");
		}
		expect(staleAdmission.caseId).toBe("turn_admission.unavailable.pre_gate_cancelled");
		expect(staleAdmission.reason).toBe("turn_admission_cancelled");
		expect(staleAdmission.mustRestage).toBe(true);
		expect(await transaction.finalizeTurn(staged.operationId, "completed")).toBeUndefined();
		expect(finalizationEvents(events)).toHaveLength(0);
		const restaged = await stage(transaction, "pre-gate-no-retarget-restaged");
		expect(restaged.operationId).toBe("pre-gate-no-retarget-restaged");
	});
});

import { afterEach, describe, expect, test, vi } from "bun:test";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import type { Model, ProviderSessionState } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "../src/config/model-registry";
import type { ModelSelectorValue } from "../src/config/model-selector-value";
import { Settings } from "../src/config/settings";
import type { WorkModeExecutionCaseMap } from "../src/config/work-mode-execution-cases";
import type { WorkModeOperationEvent } from "../src/config/work-mode-result";
import { type WorkModeSessionRuntime, WorkModeTransaction } from "../src/config/work-mode-transaction";
import { AgentSession, type AgentSessionFallbackRuntimeSnapshot } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

type Fixture = Readonly<{
	authStorage: AuthStorage;
	session: AgentSession;
}>;
type TurnAdmissionEvent = Extract<WorkModeOperationEvent, { phase: "turn_admission" }>;
type TurnFinalizeEvent = Extract<WorkModeOperationEvent, { phase: "turn_finalize" }>;
type PartialActivationFailureEvent = WorkModeExecutionCaseMap["turn_admission.unavailable.runtime.activation_failed"];
type RollbackFailureEvent = WorkModeExecutionCaseMap["turn_admission.unavailable.runtime.rollback_failed"];
type ReceiptBearingEvent = Exclude<WorkModeOperationEvent, { phase: "preview" }>;

function isReceiptBearingEvent(event: WorkModeOperationEvent): event is ReceiptBearingEvent {
	return event.phase !== "preview";
}

function isTurnAdmissionEvent(event: WorkModeOperationEvent): event is TurnAdmissionEvent {
	return isReceiptBearingEvent(event) && event.phase === "turn_admission";
}

function isTurnFinalizeEvent(event: WorkModeOperationEvent): event is TurnFinalizeEvent {
	return isReceiptBearingEvent(event) && event.phase === "turn_finalize";
}

function isPartialActivationFailureEvent(event: WorkModeOperationEvent): event is PartialActivationFailureEvent {
	return (
		isReceiptBearingEvent(event) &&
		event.phase === "turn_admission" &&
		event.caseId === "turn_admission.unavailable.runtime.activation_failed" &&
		event.state === "unavailable"
	);
}

function isRollbackFailureEvent(event: WorkModeOperationEvent): event is RollbackFailureEvent {
	return (
		isReceiptBearingEvent(event) &&
		event.phase === "turn_admission" &&
		event.caseId === "turn_admission.unavailable.runtime.rollback_failed" &&
		event.state === "unavailable"
	);
}

type RuntimeSnapshot = Readonly<{
	model: Model | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	activeProfile: string | undefined;
	modelRoles: Readonly<Record<string, ModelSelectorValue>>;
	agentModelOverrides: Readonly<Record<string, ModelSelectorValue>>;
	defaultChain: readonly string[] | undefined;
	fallbackRuntime: AgentSessionFallbackRuntimeSnapshot;
	providerSessionState: Map<string, ProviderSessionState>;
}>;

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

async function createFixture(): Promise<Fixture> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("openai-codex", "test-key");
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const initialModel = modelRegistry.getAll().find(model => model.provider === "anthropic");
	if (!initialModel) throw new Error("Expected an Anthropic model in the test registry");
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: initialModel, systemPrompt: ["test"], tools: [], messages: [] },
		streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "todo.reminders": false }),
		modelRegistry,
	});
	const fixture = { authStorage, session } satisfies Fixture;
	fixtures.push(fixture);
	return fixture;
}

async function stageReadyTurn(session: AgentSession): Promise<void> {
	const preview = await session.previewWorkMode("quick-edit");
	if (preview.state !== "ready") throw new Error(`Expected ready Work Mode preview, got ${preview.state}`);
	const staged = await session.stageWorkMode({
		modeId: "quick-edit",
		acceptedPreview: preview,
		scope: "turn",
		operationId: "partial-cleanup-operation",
	});
	if (!isReceiptBearingEvent(staged)) {
		const detail = staged.state === "unavailable" ? staged.reason : staged.state;
		throw new Error(`Expected ready Work Mode stage, got ${detail}`);
	}
	if (staged.caseId !== "turn_stage.ready") throw new Error(`Expected ready Work Mode stage, got ${staged.caseId}`);
}

function admissionEvents(session: AgentSession): TurnAdmissionEvent[] {
	return session.getWorkModeEvents().filter(isTurnAdmissionEvent);
}

function finalizationEvents(session: AgentSession): TurnFinalizeEvent[] {
	return session.getWorkModeEvents().filter(isTurnFinalizeEvent);
}

function receiptIds(events: readonly WorkModeOperationEvent[]): string[] {
	return events.filter(isReceiptBearingEvent).map(event => event.receipt.receiptId);
}

function snapshotRuntime(session: AgentSession): RuntimeSnapshot {
	return {
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		activeProfile: session.getActiveModelProfile(),
		modelRoles: structuredClone(session.settings.get("modelRoles")),
		agentModelOverrides: structuredClone(session.settings.get("task.agentModelOverrides")),
		defaultChain: session.getConfiguredModelChain("default"),
		fallbackRuntime: session.getDefaultFallbackRuntimeSnapshot(),
		providerSessionState: session.providerSessionState,
	};
}

function seedRuntime(session: AgentSession): void {
	const model = session.model;
	if (!model) throw new Error("Expected an initial model");
	const selector = `${model.provider}/${model.id}`;
	session.settings.override("modelRoles", { default: selector });
	session.settings.override("task.agentModelOverrides", { executor: selector });
	session.setConfiguredModelChain("default", [selector, selector], "partial-cleanup-test");
	session.setActiveModelProfile("baseline-profile");
	session.setThinkingLevel(ThinkingLevel.High);
	const originalState = { close(): void {} } satisfies ProviderSessionState;
	session.providerSessionState.set("baseline", originalState);
}

type ReceiptFailureFixture = Readonly<{
	authStorage: AuthStorage;
	transaction: WorkModeTransaction;
	events: WorkModeOperationEvent[];
	restoreCount: () => number;
}>;

async function createReceiptFailureFixture(): Promise<ReceiptFailureFixture> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("openai-codex", "partial-cleanup-receipt-key");
	authStorage.setRuntimeApiKey("anthropic", "partial-cleanup-receipt-key");
	const registry = new ModelRegistry(authStorage);
	const initialModel = registry.getAll().find(model => model.provider === "openai-codex");
	if (!initialModel) throw new Error("Expected an OpenAI Codex model for receipt failure cleanup");
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"todo.reminders": false,
		modelRoles: {},
		"task.agentModelOverrides": {},
	});
	const configuredChains = new Map<string, readonly string[]>();
	let activeProfile: string | undefined;
	let restoreCalls = 0;
	const session: WorkModeSessionRuntime = {
		sessionId: "partial-cleanup-receipt-session",
		model: initialModel,
		thinkingLevel: undefined,
		setModelTemporary: async () => {},
		beginTemporaryProviderSessionScope: () => ({ reason: "work-mode-turn" }),
		restoreTemporaryProviderSessionScope: () => {
			restoreCalls += 1;
			return true;
		},
		setActiveModelProfile: profileName => {
			activeProfile = profileName;
		},
		getActiveModelProfile: () => activeProfile,
		getConfiguredModelChain: role => configuredChains.get(role),
		setConfiguredModelChain: (role, entries) => {
			configuredChains.set(role, [...entries]);
		},
	};
	const events: WorkModeOperationEvent[] = [];
	let receiptCalls = 0;
	const transaction = new WorkModeTransaction({
		session,
		modelRegistry: registry,
		settings,
		now: () => 1234,
		operationId: () => "partial-cleanup-receipt-operation",
		receiptId: () => {
			receiptCalls += 1;
			if (receiptCalls === 3) throw new Error("injected receipt-id failure");
			return `partial-cleanup-receipt-${receiptCalls}`;
		},
		turnLeaseId: () => "partial-cleanup-receipt-lease",
		emit: event => events.push(event),
	});
	return { authStorage, transaction, events, restoreCount: () => restoreCalls };
}

async function triggerFailure(session: AgentSession, restoreScope: boolean): Promise<TurnAdmissionEvent> {
	await stageReadyTurn(session);
	vi.spyOn(session.settings, "override").mockImplementationOnce(() => {
		throw new Error("role overlay failed");
	});
	if (!restoreScope) vi.spyOn(session, "restoreTemporaryProviderSessionScope").mockImplementationOnce(() => false);

	await expect(session.prompt("trigger cleanup")).rejects.toThrow("Work Mode turn admission was not accepted.");
	const admissions = admissionEvents(session);
	expect(admissions).toHaveLength(1);
	const admission = admissions[0];
	if (!admission) throw new Error("Expected one admission failure");
	if (!isPartialActivationFailureEvent(admission) && !isRollbackFailureEvent(admission)) {
		throw new Error("Expected a partial cleanup admission failure");
	}
	return admission;
}

describe("Work Mode partial activation cleanup", () => {
	test("success cleanup restores every prior presence and preserves one activation_failed admission", async () => {
		const { session } = await createFixture();
		seedRuntime(session);
		const before = snapshotRuntime(session);
		const admission = await triggerFailure(session, true);

		expect(admission.caseId).toBe("turn_admission.unavailable.runtime.activation_failed");
		if (!isPartialActivationFailureEvent(admission)) {
			throw new Error("Expected an activation failure admission event");
		}
		expect(admission.receipt.reason).toBe("turn_activation_failed");
		expect(admission.setupCheckpoint).toBe("fallback_overlay_installed");
		expect(admission.receipt.runtime).toEqual({ kind: "rejected", code: "turn_activation_failed" });
		expect(session.model).toBe(before.model);
		expect(session.thinkingLevel).toBe(before.thinkingLevel);
		expect(session.getActiveModelProfile()).toBe(before.activeProfile);
		expect(session.settings.get("modelRoles")).toEqual(before.modelRoles);
		expect(session.settings.get("task.agentModelOverrides")).toEqual(before.agentModelOverrides);
		expect(session.getConfiguredModelChain("default")).toEqual(before.defaultChain);
		expect(session.getDefaultFallbackRuntimeSnapshot()).toEqual(before.fallbackRuntime);
		expect(session.providerSessionState).toBe(before.providerSessionState);
		expect(session.providerSessionState.has("baseline")).toBe(true);
		expect(session.getWorkModeStagedTurn()).toBeUndefined();
		expect(admissionEvents(session)).toHaveLength(1);
		expect(new Set(receiptIds(session.getWorkModeEvents())).size).toBe(session.getWorkModeEvents().length);

		expect(finalizationEvents(session)).toHaveLength(0);
		expect(await session.finalizeWorkModeTurn("error")).toBeUndefined();
	});

	test("cleanup failure reports one rollback_failed admission, fences dispatch, and owns no finalizer", async () => {
		const { session } = await createFixture();
		const admission = await triggerFailure(session, false);

		expect(admission.caseId).toBe("turn_admission.unavailable.runtime.rollback_failed");
		if (!isRollbackFailureEvent(admission)) {
			throw new Error("Expected a rollback failure admission event");
		}
		expect(admission.receipt.reason).toBe("turn_rollback_failed");
		expect(admission.receipt.runtime).toEqual({ kind: "restore_failed", code: "turn_rollback_failed" });
		expect(session.getWorkModeStagedTurn()).toBeUndefined();
		expect(admissionEvents(session)).toHaveLength(1);
		expect(finalizationEvents(session)).toHaveLength(0);
		expect(new Set(receiptIds(session.getWorkModeEvents())).size).toBe(session.getWorkModeEvents().length);
		expect(await session.finalizeWorkModeTurn("error")).toBeUndefined();
		await expect(session.prompt("dispatch after rollback failure")).rejects.toThrow(
			"Work Mode dispatch is fenced pending recovery.",
		);
	});
	test("receipt-id allocation failure before transfer cleans the partial and publishes no finalizer", async () => {
		const fixture = await createReceiptFailureFixture();
		try {
			const preview = await fixture.transaction.preview("quick-edit");
			expect(preview.state).toBe("ready");
			if (preview.state !== "ready") throw new Error("Expected a ready Work Mode preview");
			const staged = await fixture.transaction.stageTurn({
				modeId: "quick-edit",
				acceptedPreview: preview,
				scope: "turn",
				operationId: "partial-cleanup-receipt-operation",
			});
			expect(staged.phase).toBe("turn_stage");
			if (!isReceiptBearingEvent(staged) || staged.phase !== "turn_stage") {
				throw new Error("Expected a receipt-bearing staged Work Mode event");
			}
			const stagedTurn = fixture.transaction.getStagedTurn(staged.operationId);
			if (!stagedTurn) throw new Error("Expected a staged Work Mode turn");

			const admission = await fixture.transaction.admitTurn(stagedTurn, {
				admissionTokenId: "partial-cleanup-receipt-token",
				rootLogicalRunId: "partial-cleanup-receipt-root",
				targetGeneration: stagedTurn.targetEligibleUserAdmissionGeneration,
			});

			expect(admission.caseId).toBe("turn_admission.unavailable.runtime.activation_failed");
			if (!isPartialActivationFailureEvent(admission))
				throw new Error("Expected an activation failure admission event");
			expect(admission.activationOwner).toBe("partial_cleanup");
			expect(admission.receipt.runtime).toEqual({ kind: "rejected", code: "turn_activation_failed" });
			expect(fixture.restoreCount()).toBe(1);
			expect(fixture.transaction.getTurnLease(stagedTurn.operationId)).toBeUndefined();
			expect(fixture.transaction.getStagedTurn(stagedTurn.operationId)).toBeUndefined();
			expect(await fixture.transaction.finalizeTurn(stagedTurn.operationId, "error")).toBeUndefined();
			expect(fixture.events.filter(event => event.phase === "turn_finalize")).toHaveLength(0);
		} finally {
			fixture.authStorage.close();
		}
	});
});

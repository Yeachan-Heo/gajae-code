import { afterEach, describe, expect, test, vi } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { WorkModeExecutionCaseMap } from "../src/config/work-mode-execution-cases";
import type { WorkModeOperationEvent } from "../src/config/work-mode-result";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

type Fixture = Readonly<{
	authStorage: AuthStorage;
	session: AgentSession;
}>;
type TurnAdmissionEvent = Extract<WorkModeOperationEvent, { phase: "turn_admission" }>;
type TurnFinalizeEvent = Extract<WorkModeOperationEvent, { phase: "turn_finalize" }>;
type PartialActivationFailureEvent = WorkModeExecutionCaseMap["turn_admission.unavailable.runtime.activation_failed"];
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
		operationId: "partial-activation-operation",
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

async function expectCheckpointFailure(
	session: AgentSession,
	installFailure: () => void,
	expectedCheckpoint: "none" | "provider_scope_opened" | "target_model_mutated" | "fallback_overlay_installed",
): Promise<void> {
	await stageReadyTurn(session);
	installFailure();
	await expect(session.prompt("trigger partial activation failure")).rejects.toThrow(
		"Work Mode turn admission was not accepted.",
	);

	const admissions = admissionEvents(session);
	expect(admissions).toHaveLength(1);
	const admission = admissions[0];
	if (!admission) throw new Error("Expected one turn admission event");
	if (!isPartialActivationFailureEvent(admission)) {
		throw new Error("Expected a partial activation failure admission event");
	}
	expect(admission.caseId).toBe("turn_admission.unavailable.runtime.activation_failed");
	expect(admission.state).toBe("unavailable");
	expect(admission.activationOwner).toBe("partial_cleanup");
	expect(admission.receipt.reason).toBe("turn_activation_failed");
	expect(admission.receipt.runtime).toEqual({ kind: "rejected", code: "turn_activation_failed" });
	expect(admission.setupCheckpoint).toBe(expectedCheckpoint);
	expect(admission.receipt.relation.kind).toBe("equal");
	expect(session.getWorkModeStagedTurn()).toBeUndefined();
	expect(admissionEvents(session)).toHaveLength(1);
	expect(finalizationEvents(session)).toHaveLength(0);
	expect(new Set(receiptIds(session.getWorkModeEvents())).size).toBe(session.getWorkModeEvents().length);
	expect(await session.finalizeWorkModeTurn("error")).toBeUndefined();
}

describe("Work Mode partial activation checkpoints", () => {
	test("reports the failure before a provider scope exists", async () => {
		const { session } = await createFixture();
		await expectCheckpointFailure(
			session,
			() =>
				vi.spyOn(session, "beginTemporaryProviderSessionScope").mockImplementationOnce(() => {
					throw new Error("scope open failed");
				}),
			"none",
		);
	});

	test("reports the failure after opening the provider scope", async () => {
		const { session } = await createFixture();
		await expectCheckpointFailure(
			session,
			() =>
				vi.spyOn(session, "setModelTemporary").mockImplementationOnce(async () => {
					throw new Error("model mutation failed");
				}),
			"provider_scope_opened",
		);
	});

	test("reports the failure after mutating the target model", async () => {
		const { session } = await createFixture();
		await expectCheckpointFailure(
			session,
			() =>
				vi.spyOn(session, "setDefaultFallbackRuntimeChain").mockImplementationOnce(() => {
					throw new Error("fallback overlay failed");
				}),
			"target_model_mutated",
		);
	});

	test("reports the failure after installing the fallback overlay", async () => {
		const { session } = await createFixture();
		await expectCheckpointFailure(
			session,
			() =>
				vi.spyOn(session.settings, "override").mockImplementationOnce(() => {
					throw new Error("role overlay failed");
				}),
			"fallback_overlay_installed",
		);
	});
});

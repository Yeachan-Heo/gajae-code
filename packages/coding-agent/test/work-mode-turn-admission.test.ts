import { afterEach, describe, expect, test } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { WorkModeExecutionCaseMap, WorkModeTurnFinalizeCaseMap } from "../src/config/work-mode-execution-cases";
import type { WorkModeOperationEvent, WorkModePreviewResult } from "../src/config/work-mode-result";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

type Fixture = Readonly<{
	authStorage: AuthStorage;
	session: AgentSession;
}>;
type TurnAdmissionEvent = Extract<WorkModeOperationEvent, { phase: "turn_admission" }>;
type TurnFinalizeEvent = Extract<WorkModeOperationEvent, { phase: "turn_finalize" }>;
type ReadyTurnAdmissionEvent = WorkModeExecutionCaseMap["turn_admission.ready"];
type ReceiptBearingEvent = Exclude<WorkModeOperationEvent, { phase: "preview" }>;

function isReceiptBearingEvent(event: WorkModeOperationEvent): event is ReceiptBearingEvent {
	return event.phase !== "preview";
}

type ReadyTurnFinalizeEvent = WorkModeTurnFinalizeCaseMap["turn_finalize.ready"];

function isTurnAdmissionEvent(event: WorkModeOperationEvent): event is TurnAdmissionEvent {
	return isReceiptBearingEvent(event) && event.phase === "turn_admission";
}

function isTurnFinalizeEvent(event: WorkModeOperationEvent): event is TurnFinalizeEvent {
	return isReceiptBearingEvent(event) && event.phase === "turn_finalize";
}

function isReadyTurnAdmissionEvent(event: WorkModeOperationEvent): event is ReadyTurnAdmissionEvent {
	return (
		isReceiptBearingEvent(event) &&
		event.phase === "turn_admission" &&
		event.caseId === "turn_admission.ready" &&
		event.state === "ready"
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

const fixtures: Fixture[] = [];

afterEach(async () => {
	while (fixtures.length > 0) {
		const fixture = fixtures.pop();
		if (!fixture) continue;
		await fixture.session.dispose();
		fixture.authStorage.close();
	}
});

async function createFixture(responseCount = 1): Promise<Fixture> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("openai-codex", "test-key");
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const initialModel = modelRegistry.getAll().find(model => model.provider === "openai-codex");
	if (!initialModel) throw new Error("Expected an OpenAI Codex model in the test registry");
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
	const fixture = { authStorage, session } satisfies Fixture;
	fixtures.push(fixture);
	return fixture;
}

async function stageTurn(session: AgentSession, acceptedPreview?: WorkModePreviewResult): Promise<void> {
	const preview = acceptedPreview ?? (await session.previewWorkMode("quick-edit"));
	if (preview.state === "unavailable") throw new Error(`Work Mode preview unavailable: ${preview.reason}`);
	const staged = await session.stageWorkMode({
		modeId: "quick-edit",
		acceptedPreview: preview,
		scope: "turn",
		confirmationAccepted: preview.state === "degraded",
		operationId: "admission-test-operation",
	});
	if (!isReceiptBearingEvent(staged)) {
		const detail = staged.state === "unavailable" ? staged.reason : staged.state;
		throw new Error(`Work Mode stage unavailable: ${detail}`);
	}
	if (staged.phase !== "turn_stage" || (staged.state !== "ready" && staged.state !== "degraded")) {
		throw new Error(`Work Mode stage unavailable: ${staged.caseId}`);
	}
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

async function expectExcluded(session: AgentSession, prompt: () => Promise<void>): Promise<void> {
	const staged = session.getWorkModeStagedTurn();
	if (!staged) throw new Error("Expected a staged Work Mode turn");
	await prompt();
	expect(admissionEvents(session)).toHaveLength(0);
	expect(finalizationEvents(session)).toHaveLength(0);
	expect(session.getWorkModeStagedTurn()?.operationId).toBe(staged.operationId);
	expect(session.getWorkModeEvents()).toHaveLength(1);
	expect(new Set(receiptIds(session.getWorkModeEvents())).size).toBe(1);
}

describe("Work Mode direct-user turn admission", () => {
	test("admits one direct user turn and emits one later finalizer", async () => {
		const { session } = await createFixture();
		await stageTurn(session);

		await session.prompt("direct user request");

		const admissions = admissionEvents(session);
		const finalizers = finalizationEvents(session);
		expect(admissions).toHaveLength(1);
		expect(finalizers).toHaveLength(1);
		const admission = admissions[0];
		const finalizer = finalizers[0];
		if (!admission || !finalizer) throw new Error("Expected admission and finalization events");
		if (!isReadyTurnAdmissionEvent(admission)) {
			throw new Error("Expected a ready admission event");
		}
		if (!isReadyTurnFinalizeEvent(finalizer)) {
			throw new Error("Expected a ready finalization event");
		}
		expect(admission.caseId).toBe("turn_admission.ready");
		expect(admission.state).toBe("ready");
		expect(admission.activationOwner).toBe("admitted_lease");
		expect(admission.receipt.runtime).toEqual({ kind: "admitted", turnLeaseId: admission.turnLeaseId });
		expect(admission.receipt.confirmation).toEqual({ required: false, accepted: true });
		expect(admission.receipt.relation.kind).toBe("equal");
		expect(admission.finalizationObligation).toBe("required");
		expect(finalizer.caseId).toBe("turn_finalize.ready");
		expect(finalizer.admissionReceiptId).toBe(admission.admissionReceiptId);
		expect(finalizer.turnLeaseId).toBe(admission.turnLeaseId);
		expect(finalizer.finalizationReceiptId).not.toBe(admission.receipt.receiptId);
		expect(finalizer.finalReason).toBe("completed");
		expect(session.getWorkModeStagedTurn()).toBeUndefined();
		expect(new Set(receiptIds(session.getWorkModeEvents())).size).toBe(session.getWorkModeEvents().length);
		expect(await session.finalizeWorkModeTurn("completed")).toBeUndefined();
	});

	test("does not admit a synthetic prompt", async () => {
		const { session } = await createFixture();
		await stageTurn(session);

		await expectExcluded(session, () => session.prompt("synthetic maintenance", { synthetic: true }));
	});

	test("does not admit an agent-attributed user-role prompt", async () => {
		const { session } = await createFixture();
		await stageTurn(session);

		await expectExcluded(session, () => session.prompt("internal continuation", { attribution: "agent" }));
	});

	test("does not admit a user-attributed custom message", async () => {
		const { session } = await createFixture();
		await stageTurn(session);

		await expectExcluded(session, () =>
			session.promptCustomMessage({
				customType: "work-mode-test",
				content: "custom user content",
				display: false,
				details: {},
				attribution: "user",
			}),
		);
	});

	test("rejects a direct user prompt whose staged generation is stale", async () => {
		const { session } = await createFixture();
		await stageTurn(session);
		await session.abort();

		await expectExcluded(session, () => session.prompt("new direct request"));
	});
});

import { afterEach, describe, expect, test, vi } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { WorkModeOperationEvent } from "../src/config/work-mode-result";
import { WorkModeTransaction } from "../src/config/work-mode-transaction";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const fixtures: Array<{ session: AgentSession; authStorage: AuthStorage }> = [];

afterEach(async () => {
	vi.restoreAllMocks();
	while (fixtures.length > 0) {
		const fixture = fixtures.pop();
		if (!fixture) continue;
		await fixture.session.dispose();
		fixture.authStorage.close();
	}
});

async function createFixture(): Promise<{
	session: AgentSession;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
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
	return { session, authStorage, modelRegistry };
}

async function readyPreview(session: AgentSession) {
	const preview = await session.previewWorkMode("quick-edit");
	if (preview.state !== "ready") throw new Error(`Expected ready Work Mode preview, got ${preview.state}`);
	return preview;
}
type WorkModeExecutionEvent = Exclude<WorkModeOperationEvent, { phase: "preview" }>;
type WorkModeTurnStageEvent = Extract<WorkModeOperationEvent, { phase: "turn_stage" }>;

function requireExecutionEvent(event: WorkModeOperationEvent, context: string): WorkModeExecutionEvent {
	if (event.phase === "preview") throw new Error(`Expected an execution Work Mode event for ${context}`);
	return event;
}

function stageEvents(session: AgentSession): WorkModeTurnStageEvent[] {
	return session.getWorkModeEvents().filter((event): event is WorkModeTurnStageEvent => event.phase === "turn_stage");
}

describe("Work Mode turn staging", () => {
	test("stages one immutable request containing only the accepted identity and confirmation fields", async () => {
		const { session } = await createFixture();
		const preview = await readyPreview(session);
		const event = requireExecutionEvent(
			await session.stageWorkMode({
				modeId: "quick-edit",
				acceptedPreview: preview,
				scope: "turn",
				operationId: "stage-immutable-fields",
			}),
			"immutable turn stage",
		);
		const staged = session.getWorkModeStagedTurn();
		if (!staged) throw new Error("Expected staged Work Mode request");

		expect(event.caseId).toBe("turn_stage.ready");
		if (event.caseId !== "turn_stage.ready") throw new Error(`Expected turn_stage.ready event, got ${event.caseId}`);
		expect(event.runtime).toEqual({ kind: "staged" });
		expect(event.durable).toEqual({ kind: "not_requested" });
		expect(Object.isFrozen(staged)).toBe(true);
		expect(staged.operationId).toBe("stage-immutable-fields");
		expect(staged.modeId).toBe("quick-edit");
		expect(staged.profileId).toBe("codex-eco");
		expect(staged.acceptedFingerprint.digest).toBe(preview.fingerprint.digest);
		expect(staged.degradedConfirmation).toBe(false);
	});

	test("retains the exact allowed staged field set and excludes prepared activation state", async () => {
		const { session } = await createFixture();
		const preview = await readyPreview(session);
		await session.stageWorkMode({
			modeId: "quick-edit",
			acceptedPreview: preview,
			scope: "turn",
			operationId: "stage-field-set",
		});
		const staged = session.getWorkModeStagedTurn();
		if (!staged) throw new Error("Expected staged Work Mode request");

		expect(Object.keys(staged).sort()).toEqual([
			"acceptedFingerprint",
			"acceptedRoleReadiness",
			"degradedConfirmation",
			"modeId",
			"operationId",
			"profileId",
			"stageReceiptId",
			"targetEligibleUserAdmissionGeneration",
		]);
		expect(staged).not.toHaveProperty("prepared");
		expect(staged).not.toHaveProperty("defaultModel");
		expect(staged).not.toHaveProperty("providerSessionState");
		expect(staged).not.toHaveProperty("runtime");
		expect(staged).not.toHaveProperty("settings");
	});

	test("binds the stage receipt to the accepted fingerprint without admitting or finalizing a lease", async () => {
		const { session } = await createFixture();
		const preview = await readyPreview(session);
		const event = requireExecutionEvent(
			await session.stageWorkMode({
				modeId: "quick-edit",
				acceptedPreview: preview,
				scope: "turn",
				operationId: "stage-receipt-binding",
			}),
			"stage receipt binding",
		);
		const staged = session.getWorkModeStagedTurn();
		if (!staged) throw new Error("Expected staged Work Mode request");
		const receipts = stageEvents(session);

		expect(receipts).toHaveLength(1);
		expect(event.caseId).toBe("turn_stage.ready");
		if (event.caseId !== "turn_stage.ready") throw new Error(`Expected turn_stage.ready event, got ${event.caseId}`);
		expect(event.receipt.receiptId).toBe(staged.stageReceiptId);
		expect(event.receipt.operationId).toBe(staged.operationId);
		expect(event.receipt.relation.kind).toBe("equal");
		expect(event.receipt.runtime).toEqual({ kind: "staged" });
		expect(session.getWorkModeEvents().filter(candidate => candidate.phase === "turn_admission")).toHaveLength(0);
		expect(session.getWorkModeEvents().filter(candidate => candidate.phase === "turn_finalize")).toHaveLength(0);
	});

	test("records degraded confirmation explicitly and never silently upgrades a degraded stage", async () => {
		const { session, modelRegistry } = await createFixture();
		vi.spyOn(modelRegistry, "getAll").mockReturnValue(
			modelRegistry.getAll().filter(model => model.id !== "gpt-5.6-luna"),
		);
		const preview = await session.previewWorkMode("quick-edit");
		expect(preview.state).toBe("degraded");
		if (preview.state !== "degraded") throw new Error("Expected degraded Work Mode preview");

		const rejected = requireExecutionEvent(
			await session.stageWorkMode({
				modeId: "quick-edit",
				acceptedPreview: preview,
				scope: "turn",
				operationId: "stage-degraded-rejected",
			}),
			"degraded turn stage rejection",
		);
		expect(rejected.caseId).toBe("turn_stage.unavailable");
		if (rejected.caseId !== "turn_stage.unavailable")
			throw new Error(`Expected turn_stage.unavailable event, got ${rejected.caseId}`);
		expect(session.getWorkModeStagedTurn()).toBeUndefined();

		const accepted = requireExecutionEvent(
			await session.stageWorkMode({
				modeId: "quick-edit",
				acceptedPreview: preview,
				scope: "turn",
				confirmationAccepted: true,
				operationId: "stage-degraded-accepted",
			}),
			"degraded turn stage confirmation",
		);
		const staged = session.getWorkModeStagedTurn();
		if (!staged) throw new Error("Expected confirmed degraded Work Mode request");
		expect(accepted.caseId).toBe("turn_stage.degraded");
		if (accepted.caseId !== "turn_stage.degraded")
			throw new Error(`Expected turn_stage.degraded event, got ${accepted.caseId}`);
		expect(accepted.confirmation).toEqual({ required: true, accepted: true });
		expect(staged.acceptedRoleReadiness.kind).toBe("degraded");
		expect(staged.degradedConfirmation).toBe(true);
	});

	test("preserves the target admission generation while staging without a prepared/runtime/provider snapshot", async () => {
		const { session, modelRegistry } = await createFixture();
		const transaction = new WorkModeTransaction({
			session,
			modelRegistry,
			settings: session.settings,
			receiptId: () => "stage-target-receipt",
		});
		const preview = await transaction.preview("quick-edit");
		if (preview.state !== "ready") throw new Error(`Expected ready Work Mode preview, got ${preview.state}`);
		const event = await transaction.stageTurn({
			modeId: "quick-edit",
			acceptedPreview: preview,
			scope: "turn",
			operationId: "stage-target-generation",
			targetEligibleUserAdmissionGeneration: 42,
		});
		if (event.caseId !== "turn_stage.ready") throw new Error(`Expected turn_stage.ready event, got ${event.caseId}`);
		const staged = transaction.getStagedTurn("stage-target-generation");
		if (!staged) throw new Error("Expected staged Work Mode request");

		expect(event.caseId).toBe("turn_stage.ready");
		expect(staged.targetEligibleUserAdmissionGeneration).toBe(42);
		expect(staged.acceptedFingerprint).toBe(preview.fingerprint);
		expect(staged.acceptedRoleReadiness).toEqual(preview.roleReadiness);
		expect(staged.acceptedRoleReadiness).not.toBe(preview.roleReadiness);
		expect(staged).not.toHaveProperty("prepared");
		expect(staged).not.toHaveProperty("runtimeActivation");
		expect(staged).not.toHaveProperty("providerScope");
	});
});

import { afterEach, describe, expect, test } from "bun:test";
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
	while (fixtures.length > 0) {
		const fixture = fixtures.pop();
		if (!fixture) continue;
		await fixture.session.dispose();
		fixture.authStorage.close();
	}
});

async function createFixture(): Promise<{
	authStorage: AuthStorage;
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
	const transaction = new WorkModeTransaction({
		session,
		modelRegistry,
		settings: session.settings,
		emit: event => events.push(event),
	});
	return { authStorage, transaction, events };
}

async function stage(transaction: WorkModeTransaction, operationId: string) {
	const preview = await transaction.preview("quick-edit");
	if (preview.state !== "ready") throw new Error(`Expected ready preview, got ${preview.state}`);
	const stagedEvent = await transaction.stageTurn({
		modeId: "quick-edit",
		acceptedPreview: preview,
		scope: "turn",
		operationId,
		targetEligibleUserAdmissionGeneration: 0,
	});
	if (stagedEvent.caseId !== "turn_stage.ready") throw new Error(`Expected ready stage, got ${stagedEvent.caseId}`);
	const staged = transaction.getStagedTurn(operationId);
	if (!staged) throw new Error("Expected staged Work Mode turn");
	return staged;
}

describe("Work Mode token admission lifecycle", () => {
	test("stores one terminal settlement and stale admits return that same event", async () => {
		const { transaction, events } = await createFixture();
		const staged = await stage(transaction, "token-settlement");
		const settlement = transaction.settlePreGate(staged, "turn_admission_cancelled", "token-settlement");
		const staleAdmission = await transaction.admitTurn(staged, {
			admissionTokenId: "token-settlement",
			rootLogicalRunId: "token-settlement-root",
			targetGeneration: staged.targetEligibleUserAdmissionGeneration,
		});

		expect(staleAdmission).toBe(settlement);
		expect(events.filter(event => event.phase === "turn_admission")).toHaveLength(1);
		expect(
			new Set(events.filter(event => event.phase !== "preview").map(event => event.receipt.receiptId)).size,
		).toBe(events.filter(event => event.phase !== "preview").length);
		expect(transaction.getTurnLease(staged.operationId)).toBeUndefined();
	});

	test("concurrent admits share one claim and one admitted lease", async () => {
		const { transaction, events } = await createFixture();
		const staged = await stage(transaction, "token-duplicate");
		const options = {
			admissionTokenId: "token-duplicate",
			rootLogicalRunId: "token-duplicate-root",
			targetGeneration: staged.targetEligibleUserAdmissionGeneration,
		};
		const first = transaction.admitTurn(staged, options);
		const second = transaction.admitTurn(staged, options);
		const [firstResult, secondResult] = await Promise.all([first, second]);

		expect(firstResult).toBe(secondResult);
		expect(firstResult.state === "ready" || firstResult.state === "degraded").toBe(true);
		expect(transaction.getTurnLease(staged.operationId)).toBeDefined();
		expect(events.filter(event => event.phase === "turn_admission")).toHaveLength(1);
		const finalizer = await transaction.finalizeTurn(staged.operationId, "completed");
		expect(finalizer?.phase).toBe("turn_finalize");
		expect(transaction.getTurnLease(staged.operationId)).toBeUndefined();
	});
});

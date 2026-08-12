import { afterEach, describe, expect, test } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { WorkModeOperationEvent } from "../src/config/work-mode-result";
import { WorkModeTransaction, type WorkModeTurnLeaseLineage } from "../src/config/work-mode-transaction";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

type Fixture = Readonly<{
	authStorage: AuthStorage;
	session: AgentSession;
	transaction: WorkModeTransaction;
	events: WorkModeOperationEvent[];
}>;

const fixtures: Fixture[] = [];

afterEach(async () => {
	while (fixtures.length > 0) {
		const fixture = fixtures.pop();
		if (!fixture) continue;
		await fixture.session.dispose();
		fixture.authStorage.close();
	}
});

async function createFixture(): Promise<Fixture> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("openai-codex", "lineage-test-key");
	authStorage.setRuntimeApiKey("anthropic", "lineage-test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const initialModel = modelRegistry.getAll().find(model => model.provider === "anthropic");
	if (!initialModel) throw new Error("Expected an Anthropic model in the Work Mode lineage fixture");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "lineage-test-key",
			initialState: { model: initialModel, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "todo.reminders": false }),
		modelRegistry,
	});
	const events: WorkModeOperationEvent[] = [];
	let receiptIndex = 0;
	let leaseIndex = 0;
	const transaction = new WorkModeTransaction({
		session,
		modelRegistry,
		settings: session.settings,
		operationId: () => "agent-session-lineage-operation",
		receiptId: () => `agent-session-lineage-receipt-${++receiptIndex}`,
		turnLeaseId: () => `agent-session-lineage-lease-${++leaseIndex}`,
		emit: event => events.push(event),
	});
	const fixture = { authStorage, session, transaction, events } satisfies Fixture;
	fixtures.push(fixture);
	return fixture;
}

async function admit(transaction: WorkModeTransaction): Promise<WorkModeTurnLeaseLineage> {
	const preview = await transaction.preview("quick-edit");
	if (preview.state === "unavailable") throw new Error(`Work Mode preview unavailable: ${preview.reason}`);
	const stage = await transaction.stageTurn({
		modeId: "quick-edit",
		acceptedPreview: preview,
		scope: "turn",
		operationId: "agent-session-lineage-operation",
		targetEligibleUserAdmissionGeneration: 0,
		confirmationAccepted: preview.state === "degraded",
	});
	if (stage.caseId !== "turn_stage.ready" && stage.caseId !== "turn_stage.degraded") {
		throw new Error(`Work Mode stage unavailable: ${stage.caseId}`);
	}
	const staged = transaction.getStagedTurn("agent-session-lineage-operation");
	if (!staged) throw new Error("Expected a staged Work Mode turn");
	const admission = await transaction.admitTurn(staged, {
		admissionTokenId: "agent-session-lineage-token",
		rootLogicalRunId: "agent-session-lineage-root",
		targetGeneration: 0,
	});
	if (admission.caseId !== "turn_admission.ready" && admission.caseId !== "turn_admission.degraded") {
		throw new Error(`Work Mode admission unavailable: ${admission.caseId}`);
	}
	const lease = transaction.getTurnLease("agent-session-lineage-operation");
	if (!lease) throw new Error("Expected an admitted Work Mode lease");
	return lease.lineage;
}

describe("Work Mode agent-session lineage", () => {
	test("retains only validated retry and profile-internal fallback children", async () => {
		const { transaction, events } = await createFixture();
		const root = await admit(transaction);
		const retry = { ...root, continuationEpoch: root.continuationEpoch + 1 };

		expect(transaction.isValidTurnLineage(root.operationId, retry, "retry")).toBe(true);
		expect(transaction.retainTurnLineage(root.operationId, retry, "retry")).toBe(true);

		const profileFallback = { ...retry, continuationEpoch: retry.continuationEpoch + 1 };
		expect(transaction.isValidTurnLineage(root.operationId, profileFallback, "profile_internal_fallback")).toBe(true);
		expect(transaction.retainTurnLineage(root.operationId, profileFallback, "profile_internal_fallback")).toBe(true);
		expect(
			transaction.isValidTurnLineage(
				root.operationId,
				{ ...profileFallback, rootAdmissionGeneration: root.rootAdmissionGeneration + 1 },
				"retry",
			),
		).toBe(false);
		expect(
			transaction.isValidTurnLineage(
				root.operationId,
				{ ...profileFallback, rootLogicalRunId: "foreign-root" },
				"retry",
			),
		).toBe(false);
		expect(transaction.isValidTurnLineage(root.operationId, retry, "retry")).toBe(false);
		expect(events.filter(event => event.phase === "turn_finalize")).toHaveLength(0);

		await transaction.finalizeTurn(root.operationId, "completed");
		expect(events.filter(event => event.phase === "turn_finalize")).toHaveLength(1);
	});

	test("finalizes a foreign successor once after the admitted lease", async () => {
		const { transaction, events } = await createFixture();
		await admit(transaction);

		const first = await transaction.finalizeTurn("agent-session-lineage-operation", "handoff");
		const second = await transaction.finalizeTurn("agent-session-lineage-operation", "handoff");
		expect(first?.phase).toBe("turn_finalize");
		expect(second).toBeUndefined();
		expect(events.filter(event => event.phase === "turn_finalize")).toHaveLength(1);
	});
});

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
	const transaction = new WorkModeTransaction({
		session,
		modelRegistry,
		settings: session.settings,
		emit: event => events.push(event),
	});
	return { authStorage, session, transaction, events };
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

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (condition()) return;
		await Promise.resolve();
	}
	throw new Error("Timed out waiting for delayed Work Mode setup");
}

async function runSettlementRace(
	reason: "turn_admission_cancelled" | "turn_admission_handoff_cancelled" | "turn_admission_disposed",
	cleanupFails = false,
): Promise<void> {
	const { session, transaction, events } = await createFixture();
	const staged = await stage(transaction, `race-${reason}`);
	const before = {
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		defaultChain: session.getConfiguredModelChain("default"),
		fallbackRuntime: session.getDefaultFallbackRuntimeSnapshot(),
		activeProfile: session.getActiveModelProfile(),
		modelRoles: session.settings.getOverride("modelRoles"),
		agentModelOverrides: session.settings.getOverride("task.agentModelOverrides"),
		providerSessionState: session.providerSessionState,
	};
	const originalSetModelTemporary = session.setModelTemporary.bind(session);
	let setupEntered = false;
	let releaseSetup!: () => void;
	const setupGate = new Promise<void>(resolve => {
		releaseSetup = resolve;
	});
	type SetModelTemporary = AgentSession["setModelTemporary"];
	session.setModelTemporary = async (...args: Parameters<SetModelTemporary>) => {
		setupEntered = true;
		await setupGate;
		return await originalSetModelTemporary(...args);
	};

	const admissionPromise = transaction.admitTurn(staged, {
		admissionTokenId: `token-${reason}`,
		rootLogicalRunId: `root-${reason}`,
		targetGeneration: staged.targetEligibleUserAdmissionGeneration,
	});
	await waitFor(() => setupEntered);
	if (cleanupFails) session.restoreTemporaryProviderSessionScope = () => false;
	const settlement = transaction.settlePreGate(staged, reason, `token-${reason}`);
	releaseSetup();
	const loser = await admissionPromise;

	if (cleanupFails) {
		expect(loser.caseId).toBe("turn_admission.unavailable.runtime.rollback_failed");
		expect(loser).not.toBe(settlement);
	} else {
		expect(loser).toBe(settlement);
		expect(session.model).toBe(before.model);
		expect(session.thinkingLevel).toBe(before.thinkingLevel);
		expect(session.getConfiguredModelChain("default")).toEqual(before.defaultChain);
		expect(session.getDefaultFallbackRuntimeSnapshot()).toEqual(before.fallbackRuntime);
		expect(session.getActiveModelProfile()).toBe(before.activeProfile);
		expect(session.settings.getOverride("modelRoles")).toEqual(before.modelRoles);
		expect(session.settings.getOverride("task.agentModelOverrides")).toEqual(before.agentModelOverrides);
		expect(session.providerSessionState).toBe(before.providerSessionState);
	}
	expect(events.filter(event => event.phase === "turn_admission")).toHaveLength(1);
	expect(transaction.getTurnLease(staged.operationId)).toBeUndefined();
	expect(transaction.getStagedTurn(staged.operationId)).toBeUndefined();
	expect(await transaction.finalizeTurn(staged.operationId, "cancelled")).toBeUndefined();
}

type AdmissionSettlement = ReturnType<WorkModeTransaction["settlePreGate"]>;

async function runPostMutationSettlementRace(
	reason: "turn_admission_cancelled" | "turn_admission_handoff_cancelled" | "turn_admission_disposed",
	install: (session: AgentSession, settle: () => AdmissionSettlement) => void,
): Promise<void> {
	const { session, transaction, events } = await createFixture();
	const staged = await stage(transaction, `post-mutation-${reason}`);
	const before = {
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		defaultChain: session.getConfiguredModelChain("default"),
		fallbackRuntime: session.getDefaultFallbackRuntimeSnapshot(),
		activeProfile: session.getActiveModelProfile(),
		modelRoles: session.settings.getOverride("modelRoles"),
		agentModelOverrides: session.settings.getOverride("task.agentModelOverrides"),
		providerSessionState: session.providerSessionState,
	};
	let settlement: AdmissionSettlement | undefined;
	const settle = (): AdmissionSettlement => {
		if (settlement) return settlement;
		settlement = transaction.settlePreGate(staged, reason, `post-mutation-token-${reason}`);
		return settlement;
	};
	install(session, settle);
	const admissionPromise = transaction.admitTurn(staged, {
		admissionTokenId: `post-mutation-token-${reason}`,
		rootLogicalRunId: `post-mutation-root-${reason}`,
		targetGeneration: staged.targetEligibleUserAdmissionGeneration,
	});
	const loser = await admissionPromise;
	if (!settlement) throw new Error("Expected post-mutation settlement");
	expect(loser).toBe(settlement);
	expect(session.model).toBe(before.model);
	expect(session.thinkingLevel).toBe(before.thinkingLevel);
	expect(session.getConfiguredModelChain("default")).toEqual(before.defaultChain);
	expect(session.getDefaultFallbackRuntimeSnapshot()).toEqual(before.fallbackRuntime);
	expect(session.getActiveModelProfile()).toBe(before.activeProfile);
	expect(session.settings.getOverride("modelRoles")).toEqual(before.modelRoles);
	expect(session.settings.getOverride("task.agentModelOverrides")).toEqual(before.agentModelOverrides);
	expect(session.providerSessionState).toBe(before.providerSessionState);
	expect(events.filter(event => event.phase === "turn_admission")).toHaveLength(1);
	expect(transaction.getTurnLease(staged.operationId)).toBeUndefined();
	expect(transaction.getStagedTurn(staged.operationId)).toBeUndefined();
	expect(await transaction.finalizeTurn(staged.operationId, "cancelled")).toBeUndefined();
}

describe("Work Mode admission settlement races", () => {
	test("abort cancellation wins while partial setup is awaiting", async () => {
		await runSettlementRace("turn_admission_cancelled");
	});

	test("handoff cancellation wins while partial setup is awaiting", async () => {
		await runSettlementRace("turn_admission_handoff_cancelled");
	});

	test("disposal cancellation wins while partial setup is awaiting", async () => {
		await runSettlementRace("turn_admission_disposed");
	});

	test("cancellation after target model mutation still restores the complete runtime", async () => {
		await runPostMutationSettlementRace("turn_admission_cancelled", (session, settle) => {
			const originalSetModelTemporary = session.setModelTemporary.bind(session);
			type SetModelTemporary = AgentSession["setModelTemporary"];
			session.setModelTemporary = async (...args: Parameters<SetModelTemporary>) => {
				const result = await originalSetModelTemporary(...args);
				settle();
				return result;
			};
		});
	});

	test("cancellation after profile mutation still restores the complete runtime", async () => {
		await runPostMutationSettlementRace("turn_admission_cancelled", (session, settle) => {
			const originalSetActiveModelProfile = session.setActiveModelProfile.bind(session);
			session.setActiveModelProfile = profileName => {
				originalSetActiveModelProfile(profileName);
				settle();
			};
		});
	});

	test("cleanup failure fences through one rollback terminal without creating a lease", async () => {
		await runSettlementRace("turn_admission_cancelled", true);
	});
});

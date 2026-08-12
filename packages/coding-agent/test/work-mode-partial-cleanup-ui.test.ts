import { afterEach, describe, expect, test, vi } from "bun:test";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import type { ProviderSessionState } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "../src/config/model-registry";
import type { ModelSelectorValue } from "../src/config/model-selector-value";
import { Settings } from "../src/config/settings";
import type { WorkModeExecutionCaseMap } from "../src/config/work-mode-execution-cases";
import type { WorkModeOperationEvent } from "../src/config/work-mode-result";
import { createWorkModeStatusView, renderWorkModeStatusLines } from "../src/config/work-mode-view";
import { AgentSession, type AgentSessionFallbackRuntimeSnapshot } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

type Fixture = Readonly<{
	authStorage: AuthStorage;
	session: AgentSession;
}>;

type TurnAdmissionEvent = Extract<WorkModeOperationEvent, { phase: "turn_admission" }>;
type PartialActivationEvent = WorkModeExecutionCaseMap["turn_admission.unavailable.runtime.activation_failed"];
type RollbackFailureEvent = WorkModeExecutionCaseMap["turn_admission.unavailable.runtime.rollback_failed"];
type CleanupFailureEvent = PartialActivationEvent | RollbackFailureEvent;

const fixtures: Fixture[] = [];

function isTurnAdmissionEvent(event: WorkModeOperationEvent): event is TurnAdmissionEvent {
	return event.phase === "turn_admission";
}

function isPartialActivationEvent(event: TurnAdmissionEvent): event is PartialActivationEvent {
	return event.caseId === "turn_admission.unavailable.runtime.activation_failed" && event.state === "unavailable";
}

function isRollbackFailureEvent(event: TurnAdmissionEvent): event is RollbackFailureEvent {
	return event.caseId === "turn_admission.unavailable.runtime.rollback_failed" && event.state === "unavailable";
}

async function createFixture(): Promise<Fixture> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("openai-codex", "work-mode-test-key");
	authStorage.setRuntimeApiKey("anthropic", "work-mode-test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const initialModel = modelRegistry.getAll().find(model => model.provider === "anthropic");
	if (!initialModel) throw new Error("Expected an Anthropic model for the partial-cleanup UI fixture");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "work-mode-test-key",
			initialState: { model: initialModel, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
		}),
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
		operationId: "partial-cleanup-ui",
	});
	if (staged.phase !== "turn_stage" || (staged.state !== "ready" && staged.state !== "degraded")) {
		throw new Error(`Expected a staged Work Mode turn, got ${staged.phase}:${staged.state}`);
	}
}

function seedRuntime(session: AgentSession): void {
	const model = session.model;
	if (!model) throw new Error("Expected an initial model");
	const selector = `${model.provider}/${model.id}`;
	session.settings.override("modelRoles", { default: selector });
	session.settings.override("task.agentModelOverrides", { executor: selector });
	session.setConfiguredModelChain("default", [selector, selector], "partial-cleanup-ui");
	session.setActiveModelProfile("baseline-profile");
	session.setThinkingLevel(ThinkingLevel.High);
	const originalState = { close(): void {} } satisfies ProviderSessionState;
	session.providerSessionState.set("baseline", originalState);
}

function snapshotRuntime(session: AgentSession): Readonly<{
	model: typeof session.model;
	thinkingLevel: ThinkingLevel | undefined;
	activeProfile: string | undefined;
	modelRoles: Readonly<Record<string, ModelSelectorValue>>;
	agentModelOverrides: Readonly<Record<string, ModelSelectorValue>>;
	defaultChain: readonly string[] | undefined;
	fallbackRuntime: AgentSessionFallbackRuntimeSnapshot;
}> {
	return {
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		activeProfile: session.getActiveModelProfile(),
		modelRoles: structuredClone(session.settings.get("modelRoles")),
		agentModelOverrides: structuredClone(session.settings.get("task.agentModelOverrides")),
		defaultChain: session.getConfiguredModelChain("default"),
		fallbackRuntime: session.getDefaultFallbackRuntimeSnapshot(),
	};
}

async function triggerFailure(session: AgentSession, restoreScope: boolean): Promise<CleanupFailureEvent> {
	await stageReadyTurn(session);
	vi.spyOn(session.settings, "override").mockImplementationOnce(() => {
		throw new Error("role overlay failed");
	});
	if (!restoreScope) vi.spyOn(session, "restoreTemporaryProviderSessionScope").mockImplementationOnce(() => false);
	await expect(session.prompt("trigger partial cleanup")).rejects.toThrow(
		"Work Mode turn admission was not accepted.",
	);
	const admission = session.getWorkModeEvents().find(isTurnAdmissionEvent);
	if (!admission) throw new Error("Expected one Work Mode turn admission event");
	if (!isPartialActivationEvent(admission) && !isRollbackFailureEvent(admission)) {
		throw new Error("Expected a partial-cleanup admission event");
	}
	return admission;
}

describe("Work Mode partial-cleanup UI", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		while (fixtures.length > 0) {
			const fixture = fixtures.pop();
			if (!fixture) continue;
			await fixture.session.dispose();
			fixture.authStorage.close();
		}
	});

	test("renders safe partial activation and rollback recovery without exposing cleanup internals", async () => {
		const activationFixture = await createFixture();
		seedRuntime(activationFixture.session);
		const before = snapshotRuntime(activationFixture.session);
		const activation = await triggerFailure(activationFixture.session, true);
		if (!isPartialActivationEvent(activation)) throw new Error("Expected an activation-failed admission event");
		expect(activation.caseId).toBe("turn_admission.unavailable.runtime.activation_failed");
		expect(activation.runtime).toEqual({ kind: "rejected", code: "turn_activation_failed" });
		expect(activation.activationOwner).toBe("partial_cleanup");
		expect(activation.setupCheckpoint).toBe("fallback_overlay_installed");
		expect(activationFixture.session.model).toBe(before.model);
		expect(activationFixture.session.thinkingLevel).toBe(before.thinkingLevel);
		expect(activationFixture.session.getActiveModelProfile()).toBe(before.activeProfile);
		expect(activationFixture.session.settings.get("modelRoles")).toEqual(before.modelRoles);
		expect(activationFixture.session.settings.get("task.agentModelOverrides")).toEqual(before.agentModelOverrides);
		expect(activationFixture.session.getConfiguredModelChain("default")).toEqual(before.defaultChain);
		expect(activationFixture.session.getDefaultFallbackRuntimeSnapshot()).toEqual(before.fallbackRuntime);
		expect(activationFixture.session.getWorkModeStagedTurn()).toBeUndefined();

		const activationView = createWorkModeStatusView(activation, {
			currentProfileId: activationFixture.session.getActiveModelProfile(),
			currentFingerprint: activation.observedFingerprint,
			currentPhase: activation.phase,
		});
		expect(activationView.status).toBe("partial-activation");
		expect(activationView.recovery.action).toBe("retry-apply");
		expect(activationView.detail).toContain("cleanup");
		const activationLines = renderWorkModeStatusLines(activationView, 72);
		expect(activationLines.join("\n")).toContain("Retry Work Mode");
		expect(activationLines.join("\n")).not.toContain("role overlay failed");
		expect(activationLines.join("\n")).not.toContain("turn_activation_failed");

		const rollbackFixture = await createFixture();
		const rollback = await triggerFailure(rollbackFixture.session, false);
		if (!isRollbackFailureEvent(rollback)) throw new Error("Expected a rollback-failed admission event");
		expect(rollback.caseId).toBe("turn_admission.unavailable.runtime.rollback_failed");
		expect(rollback.runtime).toEqual({ kind: "restore_failed", code: "turn_rollback_failed" });
		expect(rollback.activationOwner).toBe("partial_cleanup");
		expect(rollbackFixture.session.getWorkModeStagedTurn()).toBeUndefined();

		const rollbackView = createWorkModeStatusView(rollback, {
			currentProfileId: rollbackFixture.session.getActiveModelProfile(),
			currentFingerprint: rollback.observedFingerprint,
			currentPhase: rollback.phase,
		});
		expect(rollbackView.status).toBe("partial-rollback");
		expect(rollbackView.recovery.action).toBe("restore-runtime");
		expect(renderWorkModeStatusLines(rollbackView, 72).join("\n")).toContain("Restore Work Mode runtime");
		await expect(rollbackFixture.session.prompt("dispatch after cleanup rollback failure")).rejects.toThrow(
			"Work Mode dispatch is fenced pending recovery.",
		);
	});
});

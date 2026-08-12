import { afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { WorkModeOperationEvent } from "../src/config/work-mode-result";
import { WorkModeTransaction } from "../src/config/work-mode-transaction";
import type { WorkModeStatusView } from "../src/config/work-mode-view";
import { createWorkModeStatusView, renderWorkModeStatusLines } from "../src/config/work-mode-view";
import { StatusLineComponent } from "../src/modes/components/tool-status-header";
import { initTheme } from "../src/modes/theme/theme";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

type Fixture = Readonly<{
	authStorage: AuthStorage;
	session: AgentSession;
}>;

type HeldPrompt = Readonly<{
	prompt: Promise<void>;
	release: { resolve: () => void };
	admission: Extract<WorkModeOperationEvent, { phase: "turn_admission" }>;
}>;

const fixtures: Fixture[] = [];

beforeAll(async () => {
	await initTheme();
});

afterEach(async () => {
	vi.restoreAllMocks();
	while (fixtures.length > 0) {
		const fixture = fixtures.pop();
		if (!fixture) continue;
		await fixture.session.dispose();
		fixture.authStorage.close();
	}
});

async function createFixture(responseCount = 2): Promise<Fixture> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("openai-codex", "work-mode-test-key");
	authStorage.setRuntimeApiKey("anthropic", "work-mode-test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const initialModel = modelRegistry.getAll().find(model => model.provider === "anthropic");
	if (!initialModel) throw new Error("Expected an Anthropic model for the finalization UI fixture");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "work-mode-test-key",
			initialState: { model: initialModel, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: createMockModel({
				responses: Array.from({ length: responseCount }, () => ({ content: ["Done"] })),
			}).stream,
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "todo.reminders": false }),
		modelRegistry,
	});
	const fixture = { authStorage, session } satisfies Fixture;
	fixtures.push(fixture);
	return fixture;
}

async function stage(session: AgentSession): Promise<void> {
	const preview = await session.previewWorkMode("quick-edit");
	if (preview.state === "unavailable") throw new Error(`Expected a Work Mode preview, got ${preview.reason}`);
	const staged = await session.stageWorkMode({
		modeId: "quick-edit",
		acceptedPreview: preview,
		scope: "turn",
		confirmationAccepted: preview.state === "degraded",
		operationId: "finalize-ui-operation",
	});
	if (staged.phase !== "turn_stage" || (staged.state !== "ready" && staged.state !== "degraded")) {
		throw new Error(`Expected a staged Work Mode turn, got ${staged.phase}:${staged.state}`);
	}
}

async function admitAndHold(session: AgentSession): Promise<HeldPrompt> {
	await stage(session);
	const accepted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const prompt = session.prompt("admitted Work Mode request", {
		onPreflightAcceptCommit: async () => {
			accepted.resolve();
			await release.promise;
		},
	});
	await accepted.promise;
	const admission = session.getWorkModeEvents().find(event => event.phase === "turn_admission");
	if (!admission) throw new Error("Expected a Work Mode admission event");
	return { prompt, release, admission };
}

function workModeView(event: Extract<WorkModeOperationEvent, { phase: "turn_finalize" }>): WorkModeStatusView {
	return createWorkModeStatusView(event, {
		currentProfileId: "codex-eco",
		currentFingerprint: event.observedFingerprint,
		currentPhase: event.phase,
	});
}

describe("Work Mode turn-finalization UI", () => {
	test("clears a successful finalization rail and renders fenced restore failure recovery", async () => {
		const preGateFixture = await createFixture();
		const preGateEvents: WorkModeOperationEvent[] = [];
		const preGateTransaction = new WorkModeTransaction({
			session: preGateFixture.session,
			modelRegistry: preGateFixture.session.modelRegistry,
			settings: preGateFixture.session.settings,
			emit: event => {
				preGateEvents.push(event);
			},
		});
		const preGatePreview = await preGateTransaction.preview("quick-edit");
		if (preGatePreview.state === "unavailable")
			throw new Error(`Expected a pre-gate preview, got ${preGatePreview.reason}`);
		const staged = await preGateTransaction.stageTurn({
			modeId: "quick-edit",
			acceptedPreview: preGatePreview,
			scope: "turn",
			confirmationAccepted: preGatePreview.state === "degraded",
			operationId: "pre-gate-cancelled",
			targetEligibleUserAdmissionGeneration: 0,
		});
		if (staged.phase !== "turn_stage") throw new Error(`Expected a turn-stage event, got ${staged.phase}`);
		const stagedTurn = preGateTransaction.getStagedTurn("pre-gate-cancelled");
		if (!stagedTurn) throw new Error("Expected a staged pre-gate Work Mode turn");
		const settled = preGateTransaction.settlePreGate(stagedTurn, "turn_admission_cancelled", "pre-gate-token");
		if (
			settled.caseId !== "turn_admission.unavailable.pre_gate_cancelled" &&
			settled.caseId !== "turn_admission.unavailable.pre_gate_rejected"
		) {
			throw new Error(`Expected a pre-gate settlement, got ${settled.caseId}`);
		}
		expect(settled.caseId).toBe("turn_admission.unavailable.pre_gate_cancelled");
		expect(settled.mustRestage).toBe(true);
		expect(preGateTransaction.getStagedTurn("pre-gate-cancelled")).toBeUndefined();
		expect(preGateEvents.filter(event => event.phase === "turn_finalize")).toHaveLength(0);
		const settledView = createWorkModeStatusView(settled, {
			currentProfileId: preGateFixture.session.getActiveModelProfile(),
			currentPhase: settled.phase,
		});
		expect(settledView.status).toBe("pre-gate-settlement");
		expect(settledView.recovery.action).toBe("retry-apply");
		expect(renderWorkModeStatusLines(settledView, 72).join("\n")).toContain("Retry Work Mode");
		const restaged = await preGateTransaction.stageTurn({
			modeId: "quick-edit",
			acceptedPreview: preGatePreview,
			scope: "turn",
			confirmationAccepted: preGatePreview.state === "degraded",
			operationId: "pre-gate-restaged",
			targetEligibleUserAdmissionGeneration: 1,
		});
		expect(restaged.caseId).toBe("turn_stage.ready");
		expect(preGateTransaction.getStagedTurn("pre-gate-restaged")).toBeDefined();

		const successFixture = await createFixture();
		const held = await admitAndHold(successFixture.session);
		const finalized = await successFixture.session.finalizeWorkModeTurn("completed");
		if (!finalized) throw new Error("Expected a successful Work Mode finalization event");
		held.release.resolve();
		await held.prompt;
		expect(finalized.caseId).toBe("turn_finalize.ready");
		expect(finalized.runtime).toEqual({ kind: "restored" });
		expect(successFixture.session.getWorkModeStagedTurn()).toBeUndefined();

		const successView = workModeView(finalized);
		expect(successView.status).toBe("finalization-success");
		expect(successView.recovery.action).toBe("retry-preview");
		expect(renderWorkModeStatusLines(successView, 72).join("\n")).toContain("Work Mode runtime was finalized.");

		const statusLine = new StatusLineComponent(successFixture.session);
		statusLine.updateSettings({
			preset: "custom",
			leftSegments: ["model"],
			rightSegments: [],
			showSkillHud: false,
		});
		statusLine.setWorkModeStatus(successView);
		expect(Bun.stripANSI(statusLine.render(120).join("\n"))).toContain("finalization-success");
		statusLine.setWorkModeStatus(undefined);
		expect(Bun.stripANSI(statusLine.render(120).join("\n"))).not.toContain("Work Mode");
		statusLine.dispose();

		const failedFixture = await createFixture();
		const failedHeld = await admitAndHold(failedFixture.session);
		vi.spyOn(failedFixture.session, "restoreTemporaryProviderSessionScope").mockImplementationOnce(() => false);
		const restoreFailed = await failedFixture.session.finalizeWorkModeTurn("cancelled");
		if (!restoreFailed) throw new Error("Expected a restore-failed Work Mode finalization event");
		failedHeld.release.resolve();
		await expect(failedHeld.prompt).rejects.toThrow("Work Mode dispatch is fenced pending recovery.");
		expect(restoreFailed.caseId).toBe("turn_finalize.unavailable.restore_failed");
		expect(restoreFailed.runtime).toEqual({ kind: "restore_failed", code: "turn_rollback_failed" });
		const failedView = workModeView(restoreFailed);
		expect(failedView.status).toBe("finalization-failure");
		expect(failedView.recovery.action).toBe("restore-runtime");
		expect(renderWorkModeStatusLines(failedView, 72).join("\n")).toContain("Restore Work Mode runtime");
		await expect(failedFixture.session.prompt("fenced after restore failure")).rejects.toThrow(
			"Work Mode dispatch is fenced pending recovery.",
		);
	});
});

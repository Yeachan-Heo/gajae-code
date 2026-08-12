import { afterEach, describe, expect, test, vi } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { visibleWidth } from "@gajae-code/tui";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { WorkModeOperationEvent } from "../src/config/work-mode-result";
import {
	createWorkModePreviewView,
	createWorkModeStatusView,
	renderWorkModePreviewLines,
	renderWorkModeStatusLines,
} from "../src/config/work-mode-view";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

type Fixture = Readonly<{
	authStorage: AuthStorage;
	session: AgentSession;
	modelRegistry: ModelRegistry;
}>;

type SessionDriftEvent = Extract<WorkModeOperationEvent, { phase: "session_apply"; state: "drifted" }>;

const fixtures: Fixture[] = [];

function isSessionDriftEvent(event: WorkModeOperationEvent): event is SessionDriftEvent {
	return event.phase === "session_apply" && event.state === "drifted";
}

async function createFixture(): Promise<Fixture> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("openai-codex", "work-mode-test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const initialModel = modelRegistry.getAll().find(model => model.provider === "openai-codex");
	if (!initialModel) throw new Error("Expected an OpenAI Codex model for the re-preview UI fixture");
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
	const fixture = { authStorage, session, modelRegistry } satisfies Fixture;
	fixtures.push(fixture);
	return fixture;
}

afterEach(async () => {
	vi.restoreAllMocks();
	while (fixtures.length > 0) {
		const fixture = fixtures.pop();
		if (!fixture) continue;
		await fixture.session.dispose();
		fixture.authStorage.close();
	}
});

describe("Work Mode re-preview UI", () => {
	test("shows changed facts and re-preview recovery while refusing stale runtime effects", async () => {
		const fixture = await createFixture();
		const acceptedPreview = await fixture.session.previewWorkMode("quick-edit");
		if (acceptedPreview.state !== "ready") throw new Error(`Expected ready preview, got ${acceptedPreview.state}`);
		const initialModel = fixture.session.model;
		const initialProfile = fixture.session.getActiveModelProfile();
		const initialDefault = fixture.session.settings.get("modelProfile.default");
		const remainingModels = fixture.modelRegistry.getAll().filter(model => model.id !== "gpt-5.6-luna");
		vi.spyOn(fixture.modelRegistry, "getAll").mockReturnValue(remainingModels);

		const staleApply = await fixture.session.applyWorkMode({
			modeId: "quick-edit",
			acceptedPreview,
			scope: "session",
			operationId: "re-preview-stale-apply",
		});
		if (staleApply.phase === "preview") {
			throw new Error(
				staleApply.state === "unavailable"
					? `Expected a session drift event, got preview:${staleApply.state}:${staleApply.reason}`
					: `Expected a session drift event, got preview:${staleApply.state}`,
			);
		}
		if (!isSessionDriftEvent(staleApply)) throw new Error(`Expected a session drift event, got ${staleApply.caseId}`);
		expect(staleApply.caseId).toBe("session_apply.drifted");
		expect(staleApply.reason).toBe("preview_drift");
		expect(staleApply.relation.kind).toBe("changed");
		expect(staleApply.changedFacts).toContain("role_resolution");
		expect(staleApply.runtime).toEqual({ kind: "rejected", code: "preview_drift" });
		expect(staleApply.durable).toEqual({ kind: "not_requested" });
		expect(staleApply.rePreview.phase).toBe("preview");
		expect(staleApply.rePreview.state).toBe("degraded");
		expect(staleApply.rePreview.fingerprint.digest).not.toBe(acceptedPreview.fingerprint.digest);
		expect(fixture.session.model).toBe(initialModel);
		expect(fixture.session.getActiveModelProfile()).toBe(initialProfile);
		expect(fixture.session.settings.get("modelProfile.default")).toBe(initialDefault);
		expect(fixture.session.getWorkModeStagedTurn()).toBeUndefined();

		const status = createWorkModeStatusView(staleApply, {
			currentProfileId: fixture.session.getActiveModelProfile(),
			currentFingerprint: staleApply.observedFingerprint,
			currentPhase: staleApply.phase,
		});
		expect(status.status).toBe("drifted");
		expect(status.reason).toBe("preview_drift");
		expect(status.qualification.relation).toBe("changed");
		expect(status.qualification.qualified).toBe(false);
		expect(status.recovery).toEqual({ action: "re-preview", label: "Re-preview Work Mode" });
		expect(status.classification.kind).toBe("custom");
		const statusLines = renderWorkModeStatusLines(status, 36);
		for (const line of statusLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(36);
			expect(line).not.toMatch(/[\u0000-\u001f\u007f]/u);
		}
		expect(statusLines.join("\n")).toContain("Re-preview Work Mode");

		const refreshedPreviewView = createWorkModePreviewView("quick-edit", staleApply.rePreview);
		expect(refreshedPreviewView.state).toBe("degraded");
		expect(refreshedPreviewView.confirmationRequired).toBe(true);
		expect(refreshedPreviewView.recovery.action).toBe("confirm-degraded");
		const previewLines = renderWorkModePreviewLines(refreshedPreviewView, 36);
		for (const line of previewLines) expect(visibleWidth(line)).toBeLessThanOrEqual(36);
		expect(previewLines.join("\n")).toContain("confirmation required");
	});
});

import { afterEach, describe, expect, test, vi } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { WorkModeOperationEvent } from "../src/config/work-mode-result";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

type Fixture = Readonly<{ authStorage: AuthStorage; session: AgentSession }>;
type TurnAdmissionEvent = Extract<WorkModeOperationEvent, { phase: "turn_admission" }>;

type RuntimeSnapshot = Readonly<{
	model: AgentSession["model"];
	thinkingLevel: AgentSession["thinkingLevel"];
	activeProfile: string | undefined;
	modelRoles: unknown;
	agentModelOverrides: unknown;
	defaultChain: readonly string[] | undefined;
	fallbackRuntime: ReturnType<AgentSession["getDefaultFallbackRuntimeSnapshot"]>;
	providerSessionState: AgentSession["providerSessionState"];
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
	const initialModel = modelRegistry.getAll().find(model => model.provider === "openai-codex");
	if (!initialModel) throw new Error("Expected an OpenAI Codex model in the test registry");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model: initialModel, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["Done"] }, { content: ["Done"] }] }).stream,
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "todo.reminders": false }),
		modelRegistry,
	});
	const fixture = { authStorage, session } satisfies Fixture;
	fixtures.push(fixture);
	return fixture;
}

async function stageTurn(session: AgentSession, operationId: string): Promise<void> {
	const preview = await session.previewWorkMode("quick-edit");
	if (preview.state === "unavailable") throw new Error(`Expected a Work Mode preview, got ${preview.reason}`);
	const staged = await session.stageWorkMode({
		modeId: "quick-edit",
		acceptedPreview: preview,
		scope: "turn",
		confirmationAccepted: preview.state === "degraded",
		operationId,
	});
	if (staged.phase === "preview") {
		throw new Error(`Expected a staged Work Mode turn, got ${staged.state}`);
	}
	if (staged.phase !== "turn_stage" || (staged.state !== "ready" && staged.state !== "degraded")) {
		throw new Error(`Expected a staged Work Mode turn, got ${staged.caseId}`);
	}
}
function admissionEvents(session: AgentSession): TurnAdmissionEvent[] {
	return session.getWorkModeEvents().filter((event): event is TurnAdmissionEvent => event.phase === "turn_admission");
}

function finalizationEvents(session: AgentSession): WorkModeOperationEvent[] {
	return session.getWorkModeEvents().filter(event => event.phase === "turn_finalize");
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

describe("Work Mode refresh failure settlement", () => {
	test("sendUserMessage settles a claimed token before propagating refresh failure", async () => {
		const { session } = await createFixture();
		await stageTurn(session, "refresh-failure-send");
		const before = snapshotRuntime(session);
		const refreshFailure = new Error("subskill refresh failed");
		let refreshCalls = 0;
		vi.spyOn(session, "refreshGjcSubskillTools").mockImplementation(async () => {
			refreshCalls += 1;
			if (refreshCalls === 1) throw refreshFailure;
		});

		await expect(session.sendUserMessage("direct request")).rejects.toBe(refreshFailure);

		expect(refreshCalls).toBe(1);
		const admissions = admissionEvents(session);
		expect(admissions).toHaveLength(1);
		const admission = admissions[0];
		if (!admission) throw new Error("Expected one Work Mode admission settlement");
		if (admission.caseId !== "turn_admission.unavailable.pre_gate_rejected") {
			throw new Error(`Expected a pre-gate rejection admission, got ${admission.caseId}`);
		}
		expect(admission.caseId).toBe("turn_admission.unavailable.pre_gate_rejected");
		expect(admission.reason).toBe("turn_admission_setup_failed");
		expect(admission.receipt.runtime).toEqual({ kind: "rejected", code: "turn_admission_setup_failed" });
		expect(admission.admissionTokenId).toBeTruthy();
		expect(session.getWorkModeStagedTurn()).toBeUndefined();
		expect(await session.finalizeWorkModeTurn("error")).toBeUndefined();
		expect(finalizationEvents(session)).toHaveLength(0);
		expect(snapshotRuntime(session)).toEqual(before);

		await stageTurn(session, "refresh-failure-send-restaged");
		await session.sendUserMessage("next direct request");
		expect(admissionEvents(session)).toHaveLength(2);
		expect(finalizationEvents(session)).toHaveLength(1);
	});
});

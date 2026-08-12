import { afterEach, describe, expect, test, vi } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { WorkModeOperationEvent } from "../src/config/work-mode-result";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

type Fixture = Readonly<{
	authStorage: AuthStorage;
	session: AgentSession;
}>;

type ReceiptBearingEvent = Exclude<WorkModeOperationEvent, { phase: "preview" }>;

function isReceiptBearingEvent(event: WorkModeOperationEvent): event is ReceiptBearingEvent {
	return event.phase !== "preview";
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

async function createFixture(overrides?: {
	readonly modelRoles?: Record<string, string>;
	readonly agentModelOverrides?: Record<string, string>;
}): Promise<Fixture> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("openai-codex", "test-key");
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const initialModel = modelRegistry.getAll().find(model => model.provider === "anthropic");
	if (!initialModel) throw new Error("Expected an Anthropic model in the test registry");
	const selector = `${initialModel.provider}/${initialModel.id}`;
	const settings = Settings.isolated(
		{
			"compaction.enabled": false,
			"todo.reminders": false,
			modelRoles: { default: selector },
			"task.agentModelOverrides": { executor: selector },
		},
		overrides
			? {
					overrides: {
						modelRoles: overrides.modelRoles,
						"task.agentModelOverrides": overrides.agentModelOverrides,
					},
				}
			: undefined,
	);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: initialModel, systemPrompt: ["test"], tools: [], messages: [] },
		streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
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
		operationId: "overlay-isolation-operation",
	});
	if (!isReceiptBearingEvent(staged) || staged.caseId !== "turn_stage.ready") {
		throw new Error(`Expected ready Work Mode stage, got ${staged.state}`);
	}
}

async function triggerActiveProfileFailure(session: AgentSession): Promise<void> {
	await stageReadyTurn(session);
	vi.spyOn(session, "setActiveModelProfile").mockImplementationOnce(() => {
		throw new Error("active profile failure");
	});
	await expect(session.prompt("trigger profile failure")).rejects.toThrow(
		"Work Mode turn admission was not accepted.",
	);
}

async function triggerAgentOverlayFailure(session: AgentSession): Promise<void> {
	await stageReadyTurn(session);
	const originalOverride = session.settings.override.bind(session.settings);
	let failed = false;
	vi.spyOn(session.settings, "override").mockImplementation((path, value) => {
		if (path === "task.agentModelOverrides" && !failed) {
			failed = true;
			throw new Error("agent overlay failure");
		}
		originalOverride(path, value);
	});
	await expect(session.prompt("trigger overlay failure")).rejects.toThrow(
		"Work Mode turn admission was not accepted.",
	);
}

describe("Work Mode runtime overlay isolation", () => {
	test("clears originally absent role overlays after a late active-profile failure", async () => {
		const { session } = await createFixture();
		expect(session.settings.getOverride("modelRoles")).toBeUndefined();
		expect(session.settings.getOverride("task.agentModelOverrides")).toBeUndefined();

		await triggerActiveProfileFailure(session);

		expect(session.settings.getOverride("modelRoles")).toBeUndefined();
		expect(session.settings.getOverride("task.agentModelOverrides")).toBeUndefined();
		const globalModelRoles = session.settings.getGlobal("modelRoles");
		if (globalModelRoles === undefined) throw new Error("Expected global model roles");
		const globalAgentModelOverrides = session.settings.getGlobal("task.agentModelOverrides");
		if (globalAgentModelOverrides === undefined) throw new Error("Expected global agent model overrides");
		expect(session.settings.get("modelRoles")).toEqual(globalModelRoles);
		expect(session.settings.get("task.agentModelOverrides")).toEqual(globalAgentModelOverrides);
	});

	test("restores present role overlays without importing effective durable values", async () => {
		const runtimeModelRoles = { planner: "anthropic/runtime-planner" };
		const runtimeAgentOverrides = { executor: "anthropic/runtime-executor" };
		const { session } = await createFixture({
			modelRoles: runtimeModelRoles,
			agentModelOverrides: runtimeAgentOverrides,
		});
		expect(session.settings.getOverride("modelRoles")).toEqual(runtimeModelRoles);
		expect(session.settings.getOverride("task.agentModelOverrides")).toEqual(runtimeAgentOverrides);

		await triggerAgentOverlayFailure(session);

		expect(session.settings.getOverride("modelRoles")).toEqual(runtimeModelRoles);
		expect(session.settings.getOverride("task.agentModelOverrides")).toEqual(runtimeAgentOverrides);
	});
});

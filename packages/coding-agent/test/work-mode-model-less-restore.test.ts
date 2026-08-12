import { afterEach, describe, expect, test, vi } from "bun:test";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

type Fixture = Readonly<{
	authStorage: AuthStorage;
	session: AgentSession;
	targetModel: Model;
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
	const targetModel = modelRegistry.getAll().find(model => model.provider === "openai-codex");
	if (!targetModel) throw new Error("Expected an OpenAI Codex model in the test registry");
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: undefined, systemPrompt: ["test"], tools: [], messages: [] },
		streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "provider.appendOnlyContext": "on" }),
		modelRegistry,
		thinkingLevel: ThinkingLevel.High,
	});
	const fixture = { authStorage, session, targetModel } satisfies Fixture;
	fixtures.push(fixture);
	return fixture;
}

describe("Work Mode temporary provider restoration", () => {
	test("restores an undefined model baseline and its reasoning/context state", async () => {
		const { session, targetModel } = await createFixture();
		const baselineMap = session.providerSessionState;
		const baselineThinkingLevel = session.thinkingLevel;
		const setModel = vi.spyOn(session.agent, "setModel");

		const scope = session.beginTemporaryProviderSessionScope("work-mode-turn");
		await session.setModelTemporary(targetModel, ThinkingLevel.Low, {
			cause: "temporary-operation",
			reason: "work-mode-turn",
			providerSessionScope: scope,
		});
		expect(session.model).toBe(targetModel);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Low);

		expect(session.restoreTemporaryProviderSessionScope(scope)).toBe(true);
		expect(session.model).toBeUndefined();
		expect(session.thinkingLevel).toBe(baselineThinkingLevel);
		expect(session.providerSessionState).toBe(baselineMap);
		expect(setModel).toHaveBeenLastCalledWith(undefined);
		expect(session.agent.appendOnlyContext).toBeDefined();
	});
});

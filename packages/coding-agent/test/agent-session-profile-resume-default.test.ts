import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

// Regression coverage for the combo-preset resume bug: activating a model
// profile (e.g. opus-codex) whose main model differs from the startup base
// model used to record the main model with role="temporary". On resume the
// session restored `models.default` (the stale pre-profile base model, e.g.
// openai-codex/gpt-5.5), flipping the main provider away from the profile's
// intended main model. Profile activation now records its main model as the
// session default via `persistAsSessionDefault`, while transient switches
// (retry/fallback/context-promotion/plan mode) stay role="temporary".
describe("AgentSession setModelTemporary persistAsSessionDefault", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-profile-resume-default-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage.close();
		tempDir.removeSync();
	});

	function makeSession(startModel: Model): AgentSession {
		const agent = new Agent({
			initialState: {
				model: startModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
	}

	function resolveModels(): { base: Model; profileMain: Model } {
		const base = modelRegistry.find("openai-codex", "gpt-5.5");
		const profileMain = modelRegistry.find("anthropic", "claude-opus-4-8");
		if (!base || !profileMain) {
			throw new Error("Expected codex and anthropic opus models to exist");
		}
		return { base, profileMain };
	}

	it("records the profile main model as the resume default without touching global settings", async () => {
		const { base, profileMain } = resolveModels();
		session = makeSession(base);

		// Session start records the base default model.
		await session.setModel(base);
		expect(session.sessionManager.buildSessionContext().models.default).toBe("openai-codex/gpt-5.5");
		const globalDefaultBefore = session.settings.getModelRole("default");

		// Combo-profile activation applies the main model for this session only.
		await session.setModelTemporary(profileMain, undefined, { persistAsSessionDefault: true });

		// The default that resume restores is now the profile's main model.
		expect(session.sessionManager.buildSessionContext().models.default).toBe("anthropic/claude-opus-4-8");
		// Global default setting is untouched (apply-for-this-session semantics).
		expect(session.settings.getModelRole("default")).toBe(globalDefaultBefore);
	});

	it("keeps a transient switch as role=temporary so resume does not adopt it", async () => {
		const { base, profileMain } = resolveModels();
		session = makeSession(base);

		await session.setModel(base);
		// No persistAsSessionDefault: simulates a retry/fallback/plan-mode switch.
		await session.setModelTemporary(profileMain);

		expect(session.model?.provider).toBe("anthropic");
		expect(session.model?.id).toBe("claude-opus-4-8");
		// Resume still restores the explicit base default, not the transient model.
		expect(session.sessionManager.buildSessionContext().models.default).toBe("openai-codex/gpt-5.5");
	});
});

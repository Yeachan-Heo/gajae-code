import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

// Coverage for `session.resumeModelBehavior`: by default (`keepSessionModel`),
// resuming a session restores the model the session last used, even if the
// global default model has since changed. With `useCurrentDefault`, resume
// instead picks up whatever `modelRoles.default` currently resolves to.
describe("AgentSession switchSession resumeModelBehavior", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-resume-model-behavior-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
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

	it("keeps the session's saved model by default when the global default changes", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } });
		const settings = Settings.isolated({ "compaction.enabled": false });
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

		await session.setModel(sonnet);
		const sessionFile = session.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		await session.sessionManager.flush();

		// Global default changes after the session was recorded.
		settings.setModelRole("default", "anthropic/claude-opus-4-8");

		expect(await session.switchSession(sessionFile)).toBe(true);
		expect(session.model?.id).toBe("claude-sonnet-4-5");
	});

	it("adopts the currently configured default model when resumeModelBehavior is useCurrentDefault", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const opus = getBundledModel("anthropic", "claude-opus-4-8")!;
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({ initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] } });
		const settings = Settings.isolated({ "compaction.enabled": false });
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

		await session.setModel(sonnet);
		const sessionFile = session.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		await session.sessionManager.flush();

		settings.setModelRole("default", "anthropic/claude-opus-4-8");
		settings.set("session.resumeModelBehavior", "useCurrentDefault");

		expect(await session.switchSession(sessionFile)).toBe(true);
		expect(session.model?.id).toBe(opus.id);
	});
});

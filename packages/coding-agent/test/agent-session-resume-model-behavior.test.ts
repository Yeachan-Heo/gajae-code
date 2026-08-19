import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { Effort, getBundledModel } from "@gajae-code/ai";
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
		vi.restoreAllMocks();
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

	it("retains a session-only active profile when useCurrentDefault reloads its runtime defaults", async () => {
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

		settings.override("modelRoles", { default: "anthropic/claude-opus-4-8" });
		settings.set("session.resumeModelBehavior", "useCurrentDefault");
		session.setActiveModelProfile("codex-medium");

		expect(await session.switchSession(sessionFile)).toBe(true);
		expect(session.model?.id).toBe(opus.id);
		expect(session.getActiveModelProfile()).toBe("codex-medium");
	});
	it("restore shares one thinking-level rule: no stray thinking_level_change, recompute from defaultThinkingLevel", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const settings = Settings.isolated({ "compaction.enabled": false, defaultThinkingLevel: Effort.Medium });

		// Session A persists a default chain whose selector carries an explicit
		// `:low` suffix. Its branch has no thinking_level_change entry of its own.
		const sessionA = new AgentSession({
			agent: new Agent({
				initialState: {
					model: sonnet,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
					thinkingLevel: Effort.High,
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		sessionA.setConfiguredModelChain("default", [`${sonnet.provider}/${sonnet.id}:low`], "test");
		const sessionFileA = sessionA.sessionManager.getSessionFile();
		if (!sessionFileA) throw new Error("Expected session file");
		await sessionA.sessionManager.ensureOnDisk();
		await sessionA.sessionManager.flush();
		await sessionA.dispose();

		// A different session restores A's file.
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: sonnet,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
					thinkingLevel: Effort.Minimal,
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
		});
		const setThinkingLevel = vi.spyOn(AgentSession.prototype, "setThinkingLevel");
		const appendThinkingLevelChange = vi.spyOn(SessionManager.prototype, "appendThinkingLevelChange");

		expect(await session.switchSession(sessionFileA)).toBe(true);

		// Restore applies one rule at all chain-resolution sites: the unconditional
		// recompute from defaultThinkingLevel. The resolved `:low` suffix must not
		// be written through setThinkingLevel — that appended a stray
		// thinking_level_change entry, flipped the recompute's hasThinkingEntry,
		// and restored the wrong level (observed: `minimal` instead of `medium`).
		expect(setThinkingLevel).not.toHaveBeenCalled();
		expect(appendThinkingLevelChange).not.toHaveBeenCalled();
		expect(session.thinkingLevel).toBe(Effort.Medium);
	});
});

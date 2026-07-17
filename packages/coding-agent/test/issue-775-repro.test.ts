import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import { Effort, getBundledModel, type Model } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { getDefault } from "@gajae-code/coding-agent/config/settings-schema";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

describe("issue #775: per-model defaultLevel", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-issue-775-");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		tempDir.removeSync();
	});

	function getOpus() {
		const model = getBundledModel("anthropic", "claude-opus-4-5");
		if (!model) throw new Error("expected claude-opus-4-5");
		return model;
	}

	function getSonnet() {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5");
		return model;
	}

	async function createSession(initialModel: Model, settings: Settings) {
		const agent = new Agent({
			initialState: {
				model: initialModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.Low,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			thinkingLevel: Effort.Low,
			modelRegistry,
		});
	}

	it("setModel adopts model.thinking.defaultLevel when present", async () => {
		const sonnet = getSonnet();
		const opus = getOpus();
		const opusWithDefault: Model = {
			...opus,
			thinking: {
				mode: "anthropic-adaptive",
				minLevel: Effort.Low,
				maxLevel: Effort.XHigh,
				defaultLevel: Effort.XHigh,
			},
		};

		const settings = Settings.isolated({ defaultThinkingLevel: Effort.Medium });
		await createSession(sonnet, settings);
		expect(session.thinkingLevel).toBe(Effort.Low);

		await session.setModel(opusWithDefault);

		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("setModel preserves current level when model has no defaultLevel", async () => {
		const sonnet = getSonnet();
		const opus = getOpus();

		const settings = Settings.isolated({ defaultThinkingLevel: Effort.Medium });
		await createSession(sonnet, settings);
		expect(session.thinkingLevel).toBe(Effort.Low);

		await session.setModel(opus);

		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("persists a default thinking level even when the effective level is unchanged", async () => {
		const sonnet = getSonnet();
		const settings = Settings.isolated();
		settings.set("defaultThinkingLevel", Effort.Medium);
		await createSession(sonnet, settings);

		session.setThinkingLevel(Effort.Low, true);

		expect(settings.get("defaultThinkingLevel")).toBe(Effort.Low);
	});

	it("persists off as the default thinking level", async () => {
		const sonnet = getSonnet();
		const settings = Settings.isolated();
		settings.set("defaultThinkingLevel", Effort.Medium);
		await createSession(sonnet, settings);

		session.setThinkingLevel(ThinkingLevel.Off, true);

		expect(settings.get("defaultThinkingLevel")).toBe(ThinkingLevel.Off);
	});
	it("resets a persisted default when inherit is requested globally", async () => {
		const sonnet = getSonnet();
		const settings = Settings.isolated();
		settings.set("defaultThinkingLevel", Effort.High);
		await createSession(sonnet, settings);

		session.setThinkingLevel(ThinkingLevel.Inherit, true);

		expect(settings.get("defaultThinkingLevel")).toBe(getDefault("defaultThinkingLevel"));
	});
	it("rejects temporary model controls bound to a retired logical session", async () => {
		const sonnet = getSonnet();
		const opus = getOpus();
		await createSession(sonnet, Settings.isolated());

		expect(await session.setModelTemporaryForControl(opus, "retired-session")).toBe(false);
		expect(session.model?.id).toBe(sonnet.id);
	});
	it("persists Telegram model controls as the session default", async () => {
		const sonnet = getSonnet();
		const opus = getOpus();
		await createSession(sonnet, Settings.isolated());

		expect(await session.setModelTemporaryForControl(opus, session.sessionId)).toBe(true);
		expect(session.model?.id).toBe(opus.id);
		expect(session.sessionManager.buildSessionContext().models.default).toBe(`${opus.provider}/${opus.id}`);
	});

	it("records unchanged session overrides and durable inherit intent", async () => {
		const sonnet = getSonnet();
		const settings = Settings.isolated({ defaultThinkingLevel: Effort.Low });
		await createSession(sonnet, settings);
		expect(session.getThinkingScopeForControl()).toBe("global config");

		await session.setThinkingLevelForControl(Effort.Low, false);
		expect(session.getThinkingScopeForControl()).toBe("session");
		expect(session.sessionManager.buildSessionContext().thinkingLevel).toBe(Effort.Low);

		await session.setThinkingLevelForControl(ThinkingLevel.Inherit, false);
		expect(session.getThinkingScopeForControl()).toBe("global config");
		expect(session.sessionManager.buildSessionContext().thinkingLevel).toBe(ThinkingLevel.Inherit);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("keeps global effort changes inherited by the current session", async () => {
		const sonnet = getSonnet();
		const settings = Settings.isolated({ defaultThinkingLevel: Effort.Low });
		await createSession(sonnet, settings);

		await session.setThinkingLevelForControl(Effort.High, true);
		expect(settings.getGlobal("defaultThinkingLevel")).toBe(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);
		expect(session.getThinkingScopeForControl()).toBe("global config");
		expect(session.sessionManager.buildSessionContext().thinkingLevel).toBe(ThinkingLevel.Inherit);

		await session.setThinkingLevelForControl(ThinkingLevel.Inherit, true);
		expect(settings.getGlobal("defaultThinkingLevel")).toBe(getDefault("defaultThinkingLevel"));
		expect(session.thinkingLevel).toBe(settings.get("defaultThinkingLevel"));
		expect(session.getThinkingScopeForControl()).toBe("global config");
		expect(session.sessionManager.buildSessionContext().thinkingLevel).toBe(ThinkingLevel.Inherit);
	});
});

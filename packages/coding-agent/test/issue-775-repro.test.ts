import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
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
	it("keeps a newer session thinking level when a global control commit finishes", async () => {
		const settings = Settings.isolated({ defaultThinkingLevel: Effort.Low });
		await createSession(getSonnet(), settings);
		const commitStarted = Promise.withResolvers<void>();
		const releaseCommit = Promise.withResolvers<void>();
		const commitAtomicBatch = settings.commitAtomicBatch.bind(settings);
		const commit = spyOn(settings, "commitAtomicBatch").mockImplementation(async changes => {
			commitStarted.resolve();
			await releaseCommit.promise;
			return commitAtomicBatch(changes);
		});
		const events: string[] = [];
		const unsubscribe = session.subscribe(event => events.push(event.type));

		try {
			const persistentControl = session.setThinkingLevelForControl(Effort.Medium, true);
			await commitStarted.promise;
			await session.setThinkingLevelForControl(Effort.Low, false);
			const historyAfterNewerControl = structuredClone(session.sessionManager.getBranch());

			releaseCommit.resolve();
			await persistentControl;

			expect(settings.getGlobal("defaultThinkingLevel")).toBe(Effort.Medium);
			expect(session.thinkingLevel).toBe(Effort.Low);
			expect(session.sessionManager.getBranch()).toEqual(historyAfterNewerControl);
			expect(events).toEqual([]);
		} finally {
			unsubscribe();
			commit.mockRestore();
		}
	});

	it("keeps a newer session thinking visibility when a global control commit finishes", async () => {
		const settings = Settings.isolated({ hideThinkingBlock: false });
		await createSession(getSonnet(), settings);
		session.setThinkingVisibility("hidden");
		const history = structuredClone(session.sessionManager.getBranch());
		const commitStarted = Promise.withResolvers<void>();
		const releaseCommit = Promise.withResolvers<void>();
		const commitAtomicBatch = settings.commitAtomicBatch.bind(settings);
		const commit = spyOn(settings, "commitAtomicBatch").mockImplementation(async changes => {
			commitStarted.resolve();
			await releaseCommit.promise;
			return commitAtomicBatch(changes);
		});

		try {
			const persistentControl = session.setThinkingVisibilityForControl("visible", true);
			await commitStarted.promise;
			session.setThinkingVisibility("hidden");

			releaseCommit.resolve();
			await persistentControl;

			expect(settings.getGlobal("hideThinkingBlock")).toBe(false);
			expect(session.getThinkingVisibility()).toBe("hidden");
			expect(session.sessionManager.getBranch()).toEqual(history);
		} finally {
			commit.mockRestore();
		}
	});

	it("lets the newest overlapping persistent thinking level own live promotion", async () => {
		const settings = Settings.isolated({ defaultThinkingLevel: Effort.Low });
		await createSession(getSonnet(), settings);
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		const releaseSecond = Promise.withResolvers<void>();
		const commitAtomicBatch = settings.commitAtomicBatch.bind(settings);
		let callCount = 0;
		const commit = spyOn(settings, "commitAtomicBatch").mockImplementation(async changes => {
			callCount++;
			if (callCount === 1) {
				firstStarted.resolve();
				await releaseFirst.promise;
			} else {
				secondStarted.resolve();
				await releaseSecond.promise;
			}
			return commitAtomicBatch(changes);
		});
		const events: string[] = [];
		const unsubscribe = session.subscribe(event => events.push(event.type));

		try {
			const older = session.setThinkingLevelForControl(Effort.Medium, true);
			await firstStarted.promise;
			const newer = session.setThinkingLevelForControl(Effort.High, true);
			await secondStarted.promise;

			releaseFirst.resolve();
			await older;
			expect(session.thinkingLevel).toBe(Effort.Low);

			releaseSecond.resolve();
			await newer;

			expect(settings.getGlobal("defaultThinkingLevel")).toBe(Effort.High);
			expect(session.thinkingLevel).toBe(Effort.High);
			expect(events).toEqual(["thinking_level_changed"]);
			expect(session.getThinkingScopeForControl()).toBe("global config");
		} finally {
			unsubscribe();
			commit.mockRestore();
		}
	});

	it("lets the newest overlapping persistent visibility own live promotion", async () => {
		const settings = Settings.isolated({ hideThinkingBlock: false });
		await createSession(getSonnet(), settings);
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		const releaseSecond = Promise.withResolvers<void>();
		const commitAtomicBatch = settings.commitAtomicBatch.bind(settings);
		let callCount = 0;
		const commit = spyOn(settings, "commitAtomicBatch").mockImplementation(async changes => {
			callCount++;
			if (callCount === 1) {
				firstStarted.resolve();
				await releaseFirst.promise;
			} else {
				secondStarted.resolve();
				await releaseSecond.promise;
			}
			return commitAtomicBatch(changes);
		});

		try {
			const older = session.setThinkingVisibilityForControl("hidden", true);
			await firstStarted.promise;
			const newer = session.setThinkingVisibilityForControl("visible", true);
			await secondStarted.promise;

			releaseFirst.resolve();
			await older;
			expect(session.getThinkingVisibility()).toBe("visible");

			releaseSecond.resolve();
			await newer;

			expect(settings.getGlobal("hideThinkingBlock")).toBe(false);
			expect(session.getThinkingVisibility()).toBe("visible");
		} finally {
			commit.mockRestore();
		}
	});
	it("reconciles an older successful thinking level after the newer durable commit fails", async () => {
		const settings = Settings.isolated({ defaultThinkingLevel: Effort.Low });
		await createSession(getSonnet(), settings);
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		const commitAtomicBatch = settings.commitAtomicBatch.bind(settings);
		let callCount = 0;
		const commit = spyOn(settings, "commitAtomicBatch").mockImplementation(async changes => {
			if (++callCount === 1) {
				firstStarted.resolve();
				await releaseFirst.promise;
				return commitAtomicBatch(changes);
			}
			secondStarted.resolve();
			throw new Error("newer commit failed");
		});

		try {
			const older = session.setThinkingLevelForControl(Effort.Medium, true);
			await firstStarted.promise;
			const newer = session.setThinkingLevelForControl(Effort.High, true);
			await secondStarted.promise;
			releaseFirst.resolve();
			await older;
			await expect(newer).rejects.toThrow("Unable to persist reasoning settings.");

			expect(settings.getGlobal("defaultThinkingLevel")).toBe(Effort.Medium);
			expect(session.thinkingLevel).toBe(Effort.Medium);
			expect(session.getThinkingScopeForControl()).toBe("global config");
		} finally {
			commit.mockRestore();
		}
	});
	it("reconciles an older successful thinking visibility after the newer durable commit fails", async () => {
		const settings = Settings.isolated({ hideThinkingBlock: false });
		await createSession(getSonnet(), settings);
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		const commitAtomicBatch = settings.commitAtomicBatch.bind(settings);
		let callCount = 0;
		const commit = spyOn(settings, "commitAtomicBatch").mockImplementation(async changes => {
			if (++callCount === 1) {
				firstStarted.resolve();
				await releaseFirst.promise;
				return commitAtomicBatch(changes);
			}
			secondStarted.resolve();
			throw new Error("newer commit failed");
		});

		try {
			const older = session.setThinkingVisibilityForControl("hidden", true);
			await firstStarted.promise;
			const newer = session.setThinkingVisibilityForControl("visible", true);
			await secondStarted.promise;
			releaseFirst.resolve();
			await older;
			await expect(newer).rejects.toThrow("Unable to persist reasoning settings.");

			expect(settings.getGlobal("hideThinkingBlock")).toBe(true);
			expect(session.getThinkingVisibility()).toBe("hidden");
		} finally {
			commit.mockRestore();
		}
	});
	it("does not reconcile over an intervening live thinking level mutation", async () => {
		const settings = Settings.isolated({ defaultThinkingLevel: Effort.Low });
		await createSession(getSonnet(), settings);
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		const commitAtomicBatch = settings.commitAtomicBatch.bind(settings);
		let callCount = 0;
		const commit = spyOn(settings, "commitAtomicBatch").mockImplementation(async changes => {
			if (++callCount === 1) {
				firstStarted.resolve();
				await releaseFirst.promise;
				return commitAtomicBatch(changes);
			}
			secondStarted.resolve();
			throw new Error("newer commit failed");
		});

		try {
			const older = session.setThinkingLevelForControl(Effort.Medium, true);
			await firstStarted.promise;
			const newer = session.setThinkingLevelForControl(Effort.High, true);
			await secondStarted.promise;
			releaseFirst.resolve();
			await older;
			await session.setThinkingLevelForControl(Effort.Low, false);
			await expect(newer).rejects.toThrow("Unable to persist reasoning settings.");

			expect(settings.getGlobal("defaultThinkingLevel")).toBe(Effort.Medium);
			expect(session.thinkingLevel).toBe(Effort.Low);
			expect(session.getThinkingScopeForControl()).toBe("session");
		} finally {
			commit.mockRestore();
		}
	});
	it("rejects durable thinking controls before mutating session state", async () => {
		const sonnet = getSonnet();
		const settings = Settings.isolated({
			defaultThinkingLevel: Effort.Low,
			hideThinkingBlock: false,
		});
		await createSession(sonnet, settings);
		const canWrite = spyOn(settings, "canWriteDurableConfig").mockReturnValue(false);
		const set = spyOn(settings, "set");
		const history = structuredClone(session.sessionManager.getBranch());
		const events: string[] = [];
		const unsubscribe = session.subscribe(event => events.push(event.type));

		try {
			expect(() => session.setThinkingLevel(Effort.High, true)).toThrow("Repair config.yml");
			await expect(session.setThinkingLevelForControl(Effort.High, true)).rejects.toThrow("Repair config.yml");
			expect(() => session.setThinkingVisibility("hidden", true)).toThrow("Repair config.yml");
			await expect(session.setThinkingVisibilityForControl("hidden", true)).rejects.toThrow("Repair config.yml");

			expect(session.thinkingLevel).toBe(Effort.Low);
			expect(session.getThinkingVisibility()).toBe("visible");
			expect(session.sessionManager.getBranch()).toEqual(history);
			expect(events).toEqual([]);
			expect(settings.getGlobal("defaultThinkingLevel")).toBe(Effort.Low);
			expect(settings.getGlobal("hideThinkingBlock")).toBe(false);
			expect(set).not.toHaveBeenCalled();
		} finally {
			unsubscribe();
			canWrite.mockRestore();
			set.mockRestore();
		}
	});
	it("leaves reasoning level state untouched when config corruption breaks the durable commit", async () => {
		const agentDir = path.join(tempDir.path(), "agent");
		const settings = await Settings.loadForScope({ cwd: tempDir.path(), agentDir });
		await createSession(getSonnet(), settings);
		const history = structuredClone(session.sessionManager.getBranch());
		const settingsBefore = settings.getGlobal("defaultThinkingLevel");
		const events: string[] = [];
		const unsubscribe = session.subscribe(event => events.push(event.type));

		try {
			await Bun.write(path.join(agentDir, "config.yml"), "defaultThinkingLevel: [\n");

			await expect(session.setThinkingLevelForControl(Effort.High, true)).rejects.toThrow(
				"Unable to persist reasoning settings.",
			);

			expect(session.thinkingLevel).toBe(Effort.Low);
			expect(session.sessionManager.getBranch()).toEqual(history);
			expect(events).toEqual([]);
			expect(settings.getGlobal("defaultThinkingLevel")).toBe(settingsBefore);
		} finally {
			unsubscribe();
			settings.getStorage()?.close();
		}
	});

	it("leaves reasoning visibility state untouched when config corruption breaks the durable commit", async () => {
		const agentDir = path.join(tempDir.path(), "agent");
		const settings = await Settings.loadForScope({ cwd: tempDir.path(), agentDir });
		await createSession(getSonnet(), settings);
		const history = structuredClone(session.sessionManager.getBranch());
		const settingsBefore = settings.getGlobal("hideThinkingBlock");
		const events: string[] = [];
		const unsubscribe = session.subscribe(event => events.push(event.type));

		try {
			await Bun.write(path.join(agentDir, "config.yml"), "hideThinkingBlock: [\n");

			await expect(session.setThinkingVisibilityForControl("hidden", true)).rejects.toThrow(
				"Unable to persist reasoning settings.",
			);

			expect(session.getThinkingVisibility()).toBe("visible");
			expect(session.sessionManager.getBranch()).toEqual(history);
			expect(events).toEqual([]);
			expect(settings.getGlobal("hideThinkingBlock")).toBe(settingsBefore);
		} finally {
			unsubscribe();
			settings.getStorage()?.close();
		}
	});
});

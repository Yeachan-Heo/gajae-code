/**
 * Regression coverage for #7823 and #7824: once a trusted root interactive TUI session
 * publishes through canonical shared append, user controls (model presets, /fast and the
 * settings effort control) must continue through admitted shared publication instead of
 * failing on the sticky legacy-mutation guard.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import { activateModelProfile } from "../src/config/model-profile-activation";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const roots: string[] = [];
const sessions: AgentSession[] = [];
const managers: SessionManager[] = [];
const registries: ModelRegistry[] = [];
const settingsStores: Settings[] = [];
const authStores: AuthStorage[] = [];
const provider = "shared-root-control-fixture";
const profileName = "shared-root-preset";
const initialSelector = `${provider}/initial`;
const selectedSelector = `${provider}/selected`;
const fallbackSelector = `${provider}/fallback`;
const defaultChain = [`${selectedSelector}:high`, `${fallbackSelector}:low`];
const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });

interface Fixture {
	session: AgentSession;
	manager: SessionManager;
	registry: ModelRegistry;
	settings: Settings;
	file: string;
	cwd: string;
	agentDir: string;
}

afterEach(async () => {
	vi.restoreAllMocks();
	const failures: unknown[] = [];
	const cleanup: Array<() => unknown> = [
		...sessions.splice(0).map(session => () => session.dispose()),
		...registries.splice(0).map(registry => () => registry.dispose()),
		...managers.splice(0).map(manager => () => manager.closeStrict()),
		...settingsStores.splice(0).map(settings => () => settings.close()),
		...authStores.splice(0).map(auth => () => auth.close()),
		...roots.splice(0).map(root => () => fs.rm(root, { recursive: true, force: true })),
	];
	for (const dispose of cleanup) {
		try {
			await dispose();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length > 0) throw new AggregateError(failures, "Shared root control fixture cleanup failed");
});

async function fixture(): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-root-control-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	await Bun.write(
		path.join(agentDir, "config.yml"),
		JSON.stringify({
			compaction: { enabled: false },
			todo: { reminders: false },
			startup: { networkPrewarm: false },
			defaultThinkingLevel: ThinkingLevel.Low,
			modelRoles: { default: initialSelector },
			task: { agentModelOverrides: { executor: initialSelector } },
		}),
	);
	await Bun.write(
		path.join(agentDir, "models.yml"),
		JSON.stringify({
			providers: {
				[provider]: {
					baseUrl: "https://shared-root-control.invalid/v1",
					api: "openai-completions",
					apiKeyEnv: "GJC_TEST_SHARED_ROOT_CONTROL_API_KEY",
					models: ["initial", "selected", "fallback"].map(id => ({
						id,
						reasoning: true,
						thinking: { mode: "effort", minLevel: "low", maxLevel: "high" },
						compat: { supportsReasoningEffort: true },
						input: ["text"],
						contextWindow: 32_000,
						maxTokens: 4_000,
					})),
				},
			},
			profiles: {
				[profileName]: {
					required_providers: [provider],
					model_mapping: { default: defaultChain, executor: fallbackSelector },
				},
			},
		}),
	);
	const settings = await Settings.loadForScope({ cwd, agentDir });
	settingsStores.push(settings);
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	authStores.push(auth);
	auth.setRuntimeApiKey(provider, "shared-root-control-test-key");
	const registry = new ModelRegistry(auth, path.join(agentDir, "models.yml"), settings, {
		agentDir,
		automaticRefresh: false,
	});
	registries.push(registry);
	const model = registry.find(provider, "initial");
	if (!model) throw new Error(`Missing fixture model: ${initialSelector}`);
	const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	managers.push(manager);
	manager.appendMessage(user("initial user"));
	manager.appendModelChange(initialSelector, "default");
	manager.appendModelChange(initialSelector, "temporary");
	manager.appendThinkingLevelChange(ThinkingLevel.Low);
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Missing fixture transcript");
	const agent = new Agent({
		initialState: {
			model,
			thinkingLevel: ThinkingLevel.Low,
			systemPrompt: ["Shared root control fixture"],
			tools: [],
			messages: manager.buildSessionContext().messages,
		},
		streamFn: () => {
			throw new Error("Shared root controls must not request a provider");
		},
	});
	const session = new AgentSession({
		agent,
		agentDir,
		sessionManager: manager,
		settings,
		modelRegistry: registry,
		thinkingLevel: ThinkingLevel.Low,
		// Mirrors sdk/session.ts for a trusted root interactive CLI TUI session (#7711).
		rootInteractiveSharedAppend: true,
	});
	sessions.push(session);
	await manager.flush();
	return { session, manager, registry, settings, file, cwd, agentDir };
}

/** Ordinary root TUI conversation: the canonical message publishes through shared append. */
async function canonicalMessage(f: Fixture, text = "canonical shared user"): Promise<void> {
	f.session.agent.emitExternalEvent({ type: "message_end", message: user(text) });
	await f.session.awaitSessionSettlement();
	expect(f.manager.getLeafEntry()).toMatchObject({ type: "message", message: { role: "user", content: text } });
	expect(await Bun.file(f.file).text()).toContain(JSON.stringify(text));
}

async function title(f: Fixture): Promise<void> {
	const leaf = f.manager.getLeafId();
	expect(await f.session.setSessionName("Shared root control title", "user")).toBe(true);
	expect(f.manager.getSessionName()).toBe("Shared root control title");
	expect(f.manager.getLeafId()).toBe(leaf);
}

/** The TUI preset seam: SelectorController.#applyModelProfile -> withSdkControlMutation(activateModelProfile). */
async function activatePreset(f: Fixture, persistDefault = false): Promise<void> {
	await f.session.withSdkControlMutation(() =>
		activateModelProfile(
			{ session: f.session, settings: f.settings, modelRegistry: f.registry, profileName },
			{ persistDefault },
		),
	);
}

async function reopen(f: Fixture): Promise<SessionManager> {
	const manager = await SessionManager.open(f.file, SessionManager.managedDestination(f.cwd, f.agentDir));
	managers.push(manager);
	return manager;
}

async function expectPresetApplied(f: Fixture): Promise<void> {
	expect(f.session.model).toMatchObject({ provider, id: "selected" });
	expect(f.session.thinkingLevel).toBe(ThinkingLevel.High);
	expect(f.session.agent.state.thinkingLevel).toBe(ThinkingLevel.High);
	expect(f.session.getActiveModelProfile()).toBe(profileName);
	expect(f.session.getSessionDefaultModelSelector()).toBe(selectedSelector);
	expect(f.settings.get("task.agentModelOverrides").executor).toBe(fallbackSelector);
	for (const manager of [f.manager, await reopen(f)]) {
		const context = manager.buildSessionContext();
		expect(context.models).toMatchObject({ default: selectedSelector, temporary: selectedSelector });
		expect(context.thinkingLevel).toBe(ThinkingLevel.High);
		expect(context.configuredModelChains.default).toMatchObject({
			role: "default",
			entries: defaultChain,
			origin: "profile-activation",
			identity: profileName,
			explicitHead: true,
		});
	}
}

function selectorController(session: AgentSession): SelectorController {
	return new SelectorController({
		session,
		isStopped: () => false,
		statusLine: { invalidate() {} },
		updateEditorBorderColor() {},
		ui: { requestRender() {} },
		showError(message: string) {
			throw new Error(`unexpected UI error: ${message}`);
		},
	} as unknown as ConstructorParameters<typeof SelectorController>[0]);
}

describe("#7823 model preset activation in a shared root TUI session", () => {
	it("activates a preset after a canonical shared message", async () => {
		const f = await fixture();
		await canonicalMessage(f);
		await activatePreset(f);
		await expectPresetApplied(f);
	});

	it("activates a preset after a shared title", async () => {
		const f = await fixture();
		await title(f);
		await activatePreset(f);
		await expectPresetApplied(f);
	});

	it("activates a preset after message then title", async () => {
		const f = await fixture();
		await canonicalMessage(f);
		await title(f);
		await activatePreset(f);
		await expectPresetApplied(f);
	});

	it("activates a preset after title then message", async () => {
		const f = await fixture();
		await title(f);
		await canonicalMessage(f);
		await activatePreset(f);
		await expectPresetApplied(f);
	});

	it("persists a default preset after a canonical shared message and keeps the conversation", async () => {
		const f = await fixture();
		await canonicalMessage(f);
		await activatePreset(f, true);
		await expectPresetApplied(f);
		expect(f.settings.get("modelProfile.default")).toBe(profileName);
		const reopened = await reopen(f);
		expect(
			reopened.buildSessionContext().messages.map(message => message.role === "user" && message.content),
		).toEqual(["initial user", "canonical shared user"]);
	});
});

describe("#7824 /fast in a shared root TUI session", () => {
	it("enables fast mode after an ordinary message and publishes the tier", async () => {
		const f = await fixture();
		await canonicalMessage(f);
		const leaf = f.manager.getLeafId();
		await f.session.setFastMode(true);
		expect(f.session.isFastModeEnabled()).toBe(true);
		expect(f.manager.getLeafEntry()).toMatchObject({ type: "service_tier_change", parentId: leaf });
		expect((await reopen(f)).buildSessionContext().serviceTier).toBe("priority");
	});

	it("disables and toggles fast mode after an ordinary message", async () => {
		const f = await fixture();
		await canonicalMessage(f);
		await f.session.setFastMode(true);
		expect(await f.session.toggleFastMode()).toBe(false);
		expect(f.session.isFastModeEnabled()).toBe(false);
		expect((await reopen(f)).buildSessionContext().serviceTier).toBeUndefined();
	});
});

describe("#7824 settings effort in a shared root TUI session", () => {
	it("applies the settings-screen default thinking level after an ordinary message", async () => {
		const f = await fixture();
		await canonicalMessage(f);
		const leaf = f.manager.getLeafId();
		await selectorController(f.session).handleSettingChange("defaultThinkingLevel", ThinkingLevel.High);
		expect(f.session.thinkingLevel).toBe(ThinkingLevel.High);
		expect(f.settings.get("defaultThinkingLevel")).toBe(ThinkingLevel.High);
		// The session follows the persisted default: the transcript records an inherit marker.
		expect(f.manager.getLeafEntry()).toMatchObject({ type: "thinking_level_change", parentId: leaf });
		const reopened = await reopen(f);
		expect(reopened.buildSessionContext().thinkingLevel).toBe(ThinkingLevel.Inherit);
		expect(reopened.buildSessionContext().messages.at(-1)).toMatchObject({ content: "canonical shared user" });
	});
});

describe("#7824 model, effort, tool and credential controls in a shared root TUI session", () => {
	it("selects a default model additively after an ordinary message", async () => {
		const f = await fixture();
		await canonicalMessage(f);
		const before = await Bun.file(f.file).text();
		const leaf = f.manager.getLeafId();
		const selected = f.registry.find(provider, "selected")!;
		await f.session.setDefaultModelSelection(selected, ThinkingLevel.High);
		expect(f.session.model).toMatchObject({ provider, id: "selected" });
		expect(f.session.thinkingLevel).toBe(ThinkingLevel.High);
		expect((await Bun.file(f.file).text()).startsWith(before)).toBe(true);
		const reopened = (await reopen(f)).buildSessionContext();
		expect(reopened.models.default).toBe(selectedSelector);
		expect(reopened.thinkingLevel).toBe(ThinkingLevel.High);
		expect(f.manager.getBranch().find(entry => entry.parentId === leaf)).toBeDefined();
	});

	it("applies the ACP/SDK concrete model.set instead of reporting it unavailable", async () => {
		const f = await fixture();
		await canonicalMessage(f);
		const selected = f.registry.find(provider, "selected")!;
		expect(await f.session.setModelTemporaryForControl(selected, f.session.sessionId, ThinkingLevel.High)).toBe(true);
		expect(f.session.model).toMatchObject({ provider, id: "selected" });
		expect(f.session.thinkingLevel).toBe(ThinkingLevel.High);
		const reopened = (await reopen(f)).buildSessionContext();
		expect(reopened.models.default).toBe(selectedSelector);
		expect(reopened.configuredModelChains.default).toMatchObject({ entries: [`${selectedSelector}:high`] });
	});

	it("applies /effort <level> after an ordinary message", async () => {
		const f = await fixture();
		await canonicalMessage(f);
		await f.session.setThinkingLevelForControl(ThinkingLevel.High, false);
		expect(f.session.thinkingLevel).toBe(ThinkingLevel.High);
		expect((await reopen(f)).buildSessionContext().thinkingLevel).toBe(ThinkingLevel.High);
	});

	it("applies an explicit tool selection after an ordinary message", async () => {
		const f = await fixture();
		await canonicalMessage(f);
		const bytes = await Bun.file(f.file).text();
		await f.session.setActiveToolsByName([]);
		expect(f.session.getActiveToolNames()).toEqual([]);
		expect((await Bun.file(f.file).text()).startsWith(bytes)).toBe(true);
	});

	it("publishes credential AUTO before changing the live selection", async () => {
		const f = await fixture();
		await canonicalMessage(f);
		const leaf = f.manager.getLeafId();
		const auth = f.registry.authStorage;
		const live = vi.spyOn(auth, "setSessionCredentialAuto");
		const publish = vi.spyOn(f.manager, "appendControlEntriesSharingSession");
		await f.session.setCredentialAuto(provider);
		expect(publish).toHaveBeenCalledTimes(1);
		expect(publish.mock.invocationCallOrder[0]).toBeLessThan(live.mock.invocationCallOrder[0]!);
		expect(f.manager.getLeafEntry()).toMatchObject({
			type: "custom",
			customType: "auth-credential-pin",
			parentId: leaf,
			data: { provider, pin: { auto: true } },
		});
	});

	it("leaves the live credential selection unchanged when the shared write is refused", async () => {
		const f = await fixture();
		await canonicalMessage(f);
		const bytes = await Bun.file(f.file).text();
		const live = vi.spyOn(f.registry.authStorage, "setSessionCredentialAuto");
		vi.spyOn(f.manager, "appendControlEntriesSharingSession").mockResolvedValue({
			kind: "stale",
			reason: "transcript_moved",
		});
		await expect(f.session.setCredentialAuto(provider)).rejects.toMatchObject({
			name: "SharedControlPublicationError",
			code: "stale",
		});
		expect(live).not.toHaveBeenCalled();
		expect(await Bun.file(f.file).text()).toBe(bytes);
	});

	it("refuses /drop before switching instead of reporting a drop that never happened", async () => {
		const f = await fixture();
		await canonicalMessage(f);
		const sessionId = f.session.sessionId;
		const bytes = await Bun.file(f.file).text();
		await expect(f.session.newSession({ drop: true })).rejects.toThrow(
			"Shared session mutation requires transaction admission: drop session",
		);
		expect(f.session.sessionId).toBe(sessionId);
		expect(await Bun.file(f.file).text()).toBe(bytes);
	});

	it("refuses /clear before resetting the conversation", async () => {
		const f = await fixture();
		await canonicalMessage(f);
		const messages = structuredClone(f.session.agent.state.messages);
		const bytes = await Bun.file(f.file).text();
		await expect(f.session.clearContext()).rejects.toThrow(
			"Shared session mutation requires transaction admission: clear context",
		);
		expect(f.session.agent.state.messages).toEqual(messages);
		expect(await Bun.file(f.file).text()).toBe(bytes);
	});
});

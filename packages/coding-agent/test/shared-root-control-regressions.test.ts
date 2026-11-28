/**
 * Regression coverage for #7823 and #7824: after a root interactive TUI session's first
 * messages, user controls (model presets, /fast, the settings effort control, model, tool and
 * /rename, profile reloads, /fork) keep working. Since single-owner step 10a a root TUI writes on
 * the legacy route, and these cases run there.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import type { ConfigHotReloadCandidate } from "../src/config/config-hot-reload";
import { activateModelProfile, materializeActiveModelProfileAssignments } from "../src/config/model-profile-activation";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { CommandController } from "../src/modes/controllers/command-controller";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { setThemeInstance } from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { executeBuiltinSlashCommand } from "../src/slash-commands/builtin-registry";
import { loadTestTheme } from "./helpers/test-theme";

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

/** The fixture catalog; `profileDefault` is the preset's DEFAULT chain. */
function modelsConfig(profileDefault: readonly string[]): string {
	return JSON.stringify({
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
				model_mapping: { default: profileDefault, executor: fallbackSelector },
			},
		},
	});
}

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
	await Bun.write(path.join(agentDir, "models.yml"), modelsConfig(defaultChain));
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
	});
	sessions.push(session);
	await manager.flush();
	return { session, manager, registry, settings, file, cwd, agentDir };
}

/** Ordinary root TUI conversation: the canonical message is persisted. */
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
		await selectorController(f.session).handleSettingChange("defaultThinkingLevel", ThinkingLevel.High);
		expect(f.session.thinkingLevel).toBe(ThinkingLevel.High);
		expect(f.settings.get("defaultThinkingLevel")).toBe(ThinkingLevel.High);
		// The session follows the persisted default: the transcript records an inherit marker.
		expect(f.manager.getLeafEntry()).toMatchObject({
			type: "thinking_level_change",
			thinkingLevel: ThinkingLevel.Inherit,
		});
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

	it("/rename publishes the title through admitted shared publication", async () => {
		const f = await fixture();
		await canonicalMessage(f);
		const showError = vi.fn();
		const showStatus = vi.fn();
		const ctx = {
			session: f.session,
			sessionManager: f.session.sessionManager,
			settings: f.settings,
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showError,
			showStatus,
		} as unknown as InteractiveModeContext;
		await new CommandController(ctx).handleRenameCommand("Shared title");
		expect(showError).not.toHaveBeenCalled();
		expect(f.session.sessionManager.getSessionName()).toBe("Shared title");
		const reopened = await SessionManager.open(f.file, SessionManager.managedDestination(f.cwd, f.agentDir));
		managers.push(reopened);
		expect(reopened.getSessionName()).toBe("Shared title");
	});
});

describe("#7824 profile assignment materialization in a shared root TUI session", () => {
	const assignments = () => new Map([["executor" as const, selectedSelector]]);

	it("materializes a role assignment over the active profile through shared publication", async () => {
		const f = await fixture();
		await activatePreset(f);
		await canonicalMessage(f);
		const before = await Bun.file(f.file).text();
		const leaf = f.manager.getLeafId();
		expect(
			await materializeActiveModelProfileAssignments({
				session: f.session,
				settings: f.settings,
				assignments: assignments(),
			}),
		).toBe(true);
		expect(f.session.getActiveModelProfile()).toBeUndefined();
		expect(f.settings.get("task.agentModelOverrides").executor).toBe(selectedSelector);
		expect(f.manager.getLeafEntry()).toMatchObject({
			type: "configured_model_chain",
			parentId: leaf,
			role: "default",
			origin: "modelRoles",
		});
		expect((await Bun.file(f.file).text()).startsWith(before)).toBe(true);
		const reopened = (await reopen(f)).buildSessionContext();
		expect(reopened.configuredModelChains.default).toMatchObject({ origin: "modelRoles" });
		expect(reopened.messages.at(-1)).toMatchObject({ content: "canonical shared user" });
	});
});

describe("#7824 configuration reload that changes the active profile in a shared root TUI session", () => {
	const reloadedChain = [`${fallbackSelector}:high`];

	async function reloadCandidate(f: Fixture, revision: number): Promise<ConfigHotReloadCandidate> {
		const configPath = path.join(f.agentDir, "config.yml");
		const modelsPath = path.join(f.agentDir, "models.yml");
		const modelsText = modelsConfig(reloadedChain);
		await Bun.write(modelsPath, modelsText);
		return {
			revision,
			config: { path: configPath, text: await Bun.file(configPath).text(), identity: `config-${revision}` },
			models: { path: modelsPath, text: modelsText, identity: `models-${revision}` },
		};
	}

	it("publishes the reloaded profile chain and model additively before applying them", async () => {
		const f = await fixture();
		await activatePreset(f);
		await canonicalMessage(f);
		const before = await Bun.file(f.file).text();
		const leaf = f.manager.getLeafId();
		const candidate = await reloadCandidate(f, 1);
		await expect(f.session.reloadConfiguration(candidate, new AbortController().signal)).resolves.toMatchObject({
			applied: true,
			modelsChanged: true,
		});
		expect(f.session.model).toMatchObject({ provider, id: "fallback" });
		expect(f.session.thinkingLevel).toBe(ThinkingLevel.High);
		expect(f.session.getActiveModelProfile()).toBe(profileName);
		expect(f.session.getConfiguredModelChainState("default")).toMatchObject({
			entries: reloadedChain,
			origin: "profile-activation",
			identity: profileName,
		});
		expect(f.manager.getBranch().find(entry => entry.parentId === leaf)).toMatchObject({
			type: "configured_model_chain",
		});
		expect((await Bun.file(f.file).text()).startsWith(before)).toBe(true);
		const reopened = (await reopen(f)).buildSessionContext();
		expect(reopened.models).toMatchObject({ default: fallbackSelector, temporary: fallbackSelector });
		expect(reopened.thinkingLevel).toBe(ThinkingLevel.High);
		expect(reopened.configuredModelChains.default).toMatchObject({ entries: reloadedChain });
		expect(reopened.messages.at(-1)).toMatchObject({ content: "canonical shared user" });
	});
});

describe("#7823/#7824 interactive TUI command path after a canonical shared message", () => {
	/** The InteractiveMode surface the builtin TUI dispatcher and CommandController use. */
	function tuiContext(f: Fixture) {
		const errors: string[] = [];
		const statuses: string[] = [];
		const ctx: Record<string, unknown> = {
			session: f.session,
			sessionManager: f.session.sessionManager,
			settings: f.settings,
			isStopped: () => false,
			showError: (message: string) => errors.push(message),
			showStatus: (message: string) => statuses.push(message),
			showWarning: (message: string) => errors.push(message),
			editor: { setText() {}, addToHistory() {} },
			statusLine: { invalidate() {}, setSessionStartTime() {} },
			updateEditorBorderColor() {},
			updateEditorTopBorder() {},
			ui: { requestRender() {}, resetViewportAnchorIntent() {}, prepareViewportAnchorForTranscriptRebuild() {} },
			chatContainer: { clear() {}, addChild() {} },
			pendingMessagesContainer: { clear() {} },
			pendingTools: new Map(),
			compactionQueuedMessages: [],
			resetAssistantTextPresentation() {},
			reloadTodos: async () => {},
			refreshSlashCommandState: async () => {},
			notifyConfigChanged: async () => {},
		};
		const commands = new CommandController(ctx as unknown as InteractiveModeContext);
		ctx.handleContextClearCommand = () => commands.handleContextClearCommand();
		const run = async (text: string) => {
			expect(await executeBuiltinSlashCommand(text, { ctx: ctx as never, handleBackgroundCommand: () => {} })).toBe(
				true,
			);
			expect(errors).toEqual([]);
		};
		return { run, statuses };
	}

	it("drives preset, /fast, /effort and /clear through the TUI dispatcher additively", async () => {
		setThemeInstance(await loadTestTheme());
		const f = await fixture();
		await canonicalMessage(f);
		const { run, statuses } = tuiContext(f);
		const sessionId = f.session.sessionId;

		let bytes = await Bun.file(f.file).text();
		await run(`/model ${profileName}`);
		await expectPresetApplied(f);
		expect((await Bun.file(f.file).text()).startsWith(bytes)).toBe(true);

		bytes = await Bun.file(f.file).text();
		await run("/fast on");
		expect(f.session.isFastModeEnabled()).toBe(true);
		expect((await Bun.file(f.file).text()).startsWith(bytes)).toBe(true);

		bytes = await Bun.file(f.file).text();
		await run("/effort medium");
		expect(f.session.thinkingLevel).toBe(ThinkingLevel.Medium);
		expect((await Bun.file(f.file).text()).startsWith(bytes)).toBe(true);

		bytes = await Bun.file(f.file).text();
		await run("/clear");
		expect(f.session.sessionId).toBe(sessionId);
		expect(f.session.agent.state.messages).toEqual([]);
		expect((await Bun.file(f.file).text()).startsWith(bytes)).toBe(true);
		expect(statuses).toEqual(
			expect.arrayContaining([expect.stringContaining("Fast mode enabled"), expect.stringContaining("medium")]),
		);

		const reopened = (await reopen(f)).buildSessionContext();
		expect(reopened.messages).toEqual([]);
		expect(reopened.models.default).toBe(selectedSelector);
		expect(reopened.thinkingLevel).toBe(ThinkingLevel.Medium);
		expect(reopened.serviceTier).toBe("priority");
		// The live session keeps every control across the clear.
		expect(f.session.model).toMatchObject({ provider, id: "selected" });
		expect(f.session.isFastModeEnabled()).toBe(true);
		expect(f.session.getActiveModelProfile()).toBe(profileName);
	});
});

describe("/fork after canonical shared messages in a root TUI", () => {
	it("branches from the selected prompt into a new session and leaves the source untouched", async () => {
		const f = await fixture();
		await canonicalMessage(f, "first shared prompt");
		await canonicalMessage(f, "second shared prompt");
		const sourceId = f.manager.getSessionId();
		const sourceFile = f.manager.getSessionFile();
		const bytes = await Bun.file(f.file).bytes();
		const selected = f.session.getUserMessagesForBranching().find(message => message.text === "second shared prompt");
		if (!selected) throw new Error("missing selectable prompt");
		const result = await f.session.branch(selected.entryId);
		expect(result).toEqual({ selectedText: "second shared prompt", cancelled: false });
		expect(f.manager.getSessionId()).not.toBe(sourceId);
		// The legacy route names the parent by its transcript path.
		expect(f.manager.getHeader()?.parentSession).toBe(sourceFile);
		expect(await Bun.file(f.file).bytes()).toEqual(bytes);
		expect(f.manager.getEntries().some(entry => JSON.stringify(entry).includes('"second shared prompt"'))).toBe(
			false,
		);
		const source = f.file;
		f.file = f.manager.getSessionFile()!;
		expect(f.file).not.toBe(source);
		await canonicalMessage(f, "next prompt in the fork");
		expect(await Bun.file(source).bytes()).toEqual(bytes);
	});

	it("forks the whole session with its artifacts through AgentSession.fork", async () => {
		const f = await fixture();
		await canonicalMessage(f, "first shared prompt");
		await canonicalMessage(f, "second shared prompt");
		const sourceId = f.manager.getSessionId();
		const artifacts = f.file.slice(0, -6);
		// Owner-only, as the managed artifact store creates them; Linux managed storage
		// refuses to snapshot a group- or world-readable tree.
		await fs.mkdir(artifacts, { recursive: true, mode: 0o700 });
		await fs.writeFile(path.join(artifacts, "sentinel.log"), "artifact", { mode: 0o600 });
		const bytes = await Bun.file(f.file).bytes();
		expect(await f.session.fork()).toBe(true);
		const forkFile = f.manager.getSessionFile()!;
		expect(f.manager.getSessionId()).not.toBe(sourceId);
		expect(f.manager.getHeader()?.parentSession).toBe(sourceId);
		expect(await Bun.file(path.join(forkFile.slice(0, -6), "sentinel.log")).text()).toBe("artifact");
		expect(await fs.readdir(artifacts)).toEqual(["sentinel.log"]);
		expect(await Bun.file(f.file).bytes()).toEqual(bytes);
		const source = f.file;
		f.file = forkFile;
		await canonicalMessage(f, "next prompt in the whole-session fork");
		expect(await Bun.file(source).bytes()).toEqual(bytes);
	});
});

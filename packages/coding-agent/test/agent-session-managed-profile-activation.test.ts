import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import type { Effort } from "@gajae-code/ai/model-thinking";
import { activateModelProfile } from "../src/config/model-profile-activation";
import { readDurableModelProfileOwnership } from "../src/config/model-profile-ownership";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const roots: string[] = [];
const sessions: AgentSession[] = [];
const managers: SessionManager[] = [];
const registries: ModelRegistry[] = [];
const settingsStores: Settings[] = [];
const authStores: AuthStorage[] = [];
const provider = "shared-profile-fixture";
const profileName = "shared-publication";
const initialSelector = `${provider}/initial`;
const selectedSelector = `${provider}/selected`;
const fallbackSelector = `${provider}/fallback`;
const defaultChain = [`${selectedSelector}:high`, `${fallbackSelector}:low`];
const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });

interface ProfileFixture {
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
	if (failures.length > 0) throw new AggregateError(failures, "Shared profile fixture cleanup failed");
});

async function fixture(): Promise<ProfileFixture> {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-profile-"));
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
					baseUrl: "https://shared-profile.invalid/v1",
					api: "openai-completions",
					apiKeyEnv: "GJC_TEST_SHARED_PROFILE_API_KEY",
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
	auth.setRuntimeApiKey(provider, "shared-profile-test-key");
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
			systemPrompt: ["Shared profile fixture"],
			tools: [],
			messages: manager.buildSessionContext().messages,
		},
		streamFn: () => {
			throw new Error("Shared profile activation must not request a provider");
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

async function canonicalMessage(f: ProfileFixture): Promise<void> {
	f.session.agent.emitExternalEvent({ type: "message_end", message: user("canonical shared user") });
	await f.session.awaitSessionSettlement();
	expect(f.manager.getLeafEntry()).toMatchObject({
		type: "message",
		message: { role: "user", content: "canonical shared user" },
	});
	expect(await Bun.file(f.file).text()).toContain('"canonical shared user"');
}

async function title(f: ProfileFixture): Promise<void> {
	const leaf = f.manager.getLeafId();
	expect(await f.session.setSessionName("Shared profile title", "user")).toBe(true);
	expect(f.manager.getSessionName()).toBe("Shared profile title");
	expect(f.manager.getLeafId()).toBe(leaf);
}

async function activate(f: ProfileFixture, persistDefault = false): Promise<void> {
	await f.session.withSdkControlMutation(() =>
		activateModelProfile(
			{ session: f.session, settings: f.settings, modelRegistry: f.registry, profileName },
			{ persistDefault },
		),
	);
}

function expectProfileState(f: ProfileFixture, manager = f.manager, thinkingLevel: Effort = ThinkingLevel.High): void {
	expect(f.session.model).toMatchObject({ provider, id: "selected" });
	expect(f.session.thinkingLevel).toBe(thinkingLevel);
	expect(f.session.agent.state.thinkingLevel).toBe(thinkingLevel);
	expect(f.session.getActiveModelProfile()).toBe(profileName);
	expect(f.session.getActivatedModelProfile()).toBe(profileName);
	expect(f.session.getSessionDefaultModelSelector()).toBe(selectedSelector);
	expect(f.settings.get("task.agentModelOverrides").executor).toBe(fallbackSelector);
	const context = manager.buildSessionContext();
	expect(context.models).toMatchObject({ default: selectedSelector, temporary: selectedSelector });
	expect(context.thinkingLevel).toBe(thinkingLevel);
	expect(context.configuredModelChains.default).toMatchObject({
		role: "default",
		entries: defaultChain,
		origin: "profile-activation",
		identity: profileName,
		explicitHead: true,
	});
	expect(manager.getBranch().filter(entry => entry.type === "configured_model_chain")).toEqual([
		expect.objectContaining({
			role: "default",
			entries: defaultChain,
			origin: "profile-activation",
			identity: profileName,
			explicitHead: true,
		}),
	]);
}

async function reopen(f: ProfileFixture): Promise<SessionManager> {
	const manager = await SessionManager.open(f.file, SessionManager.managedDestination(f.cwd, f.agentDir));
	managers.push(manager);
	return manager;
}

describe("model profile activation in a managed session", () => {
	it("keeps an untouched non-root SDK session on its existing publication mode", async () => {
		const f = await fixture();
		await activate(f);
		expectProfileState(f);
		const id = f.manager.appendMessage(user("SDK message after profile"));
		await f.manager.flush();
		expect(f.manager.getLeafId()).toBe(id);
		expect(await Bun.file(f.file).text()).toContain("SDK message after profile");
	});

	it("publishes through the SDK profile control after canonical admission", async () => {
		const f = await fixture();
		await canonicalMessage(f);
		expect(await f.session.setDefaultModelProfileForControl(profileName)).toEqual({ changed: true, id: profileName });
		expectProfileState(f);
		const reopened = await reopen(f);
		expectProfileState(f, reopened);
	});

	for (const admission of [["message"], ["title"], ["message", "title"], ["title", "message"]] as const) {
		it(`publishes a profile after ${admission.join(" → ")}`, async () => {
			const f = await fixture();
			for (const operation of admission) {
				if (operation === "message") await canonicalMessage(f);
				else await title(f);
			}
			const before = await Bun.file(f.file).text();
			const parent = f.manager.getLeafId();
			await activate(f);
			await f.manager.flush();
			expectProfileState(f);
			expect((await Bun.file(f.file).text()).startsWith(before)).toBe(true);
			const publication = f.manager.getBranch().filter(entry => !before.includes(`"id":"${entry.id}"`));
			expect(publication[0]?.parentId).toBe(parent);
			expect(publication.filter(entry => entry.type === "model_change")).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ role: "temporary", model: selectedSelector }),
					expect.objectContaining({ role: "default", model: selectedSelector }),
				]),
			);
			const reopened = await reopen(f);
			expectProfileState(f, reopened);
			expect(reopened.getLeafId()).toBe(f.manager.getLeafId());
			expect(reopened.getSessionName()).toBe(
				admission.some(operation => operation === "title") ? "Shared profile title" : undefined,
			);
			expect(readDurableModelProfileOwnership(f.settings).marker).toEqual({ kind: "inherit" });
			expect(f.settings.getGlobal("modelRoles")?.default).toBe(initialSelector);
			expect(f.settings.getGlobal("defaultThinkingLevel")).toBe(ThinkingLevel.Low);
		});
	}

	it("persists profile ownership and effective thinking alongside a reopenable shared model chain", async () => {
		const f = await fixture();
		await canonicalMessage(f);
		await title(f);
		const before = await Bun.file(f.file).text();
		await activate(f, true);
		await f.manager.flush();
		expectProfileState(f);
		expect((await Bun.file(f.file).text()).startsWith(before)).toBe(true);
		const persisted = await Settings.loadForScope({ cwd: f.cwd, agentDir: f.agentDir });
		settingsStores.push(persisted);
		expect(readDurableModelProfileOwnership(persisted)).toEqual({
			schemaVersion: 1,
			version: 1,
			marker: { kind: "profile", profile: profileName },
		});
		expect(persisted.getGlobal("modelProfile.default")).toBe(profileName);
		expect(persisted.getGlobal("defaultThinkingLevel")).toBe(ThinkingLevel.High);
		expect(persisted.getGlobal("modelRoles")).toEqual({});
		expect(persisted.getGlobal("task.agentModelOverrides")).toEqual({});
		const reopened = await reopen(f);
		expectProfileState(f, reopened);
		expect(reopened.getLeafId()).toBe(f.manager.getLeafId());
		expect(reopened.getSessionName()).toBe("Shared profile title");
	});
});

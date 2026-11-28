import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import { activateModelProfile } from "../src/config/model-profile-activation";
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
const provider = "managed-profile-fixture";
const profileName = "managed-profile";
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
	if (failures.length > 0) throw new AggregateError(failures, "Managed profile fixture cleanup failed");
});

async function fixture(): Promise<ProfileFixture> {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-managed-profile-"));
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
					baseUrl: "https://managed-profile.invalid/v1",
					api: "openai-completions",
					apiKeyEnv: "GJC_TEST_MANAGED_PROFILE_API_KEY",
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
	auth.setRuntimeApiKey(provider, "managed-profile-test-key");
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
			systemPrompt: ["Managed profile fixture"],
			tools: [],
			messages: manager.buildSessionContext().messages,
		},
		streamFn: () => {
			throw new Error("Profile activation must not request a provider");
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
	return { session, manager, registry, settings, file };
}

describe("model profile activation in a managed session", () => {
	it("activates through the SDK control mutation and leaves the session on the legacy route", async () => {
		const f = await fixture();
		expect(f.manager.requiresSharedMutationAdmission()).toBe(false);
		await f.session.withSdkControlMutation(() =>
			activateModelProfile({ session: f.session, settings: f.settings, modelRegistry: f.registry, profileName }),
		);
		expect(f.session.model).toMatchObject({ provider, id: "selected" });
		expect(f.session.thinkingLevel).toBe(ThinkingLevel.High);
		expect(f.session.agent.state.thinkingLevel).toBe(ThinkingLevel.High);
		expect(f.session.getActiveModelProfile()).toBe(profileName);
		expect(f.session.getActivatedModelProfile()).toBe(profileName);
		expect(f.session.getSessionDefaultModelSelector()).toBe(selectedSelector);
		expect(f.settings.get("task.agentModelOverrides").executor).toBe(fallbackSelector);
		const context = f.manager.buildSessionContext();
		expect(context.models).toMatchObject({ default: selectedSelector, temporary: selectedSelector });
		expect(context.thinkingLevel).toBe(ThinkingLevel.High);
		expect(f.manager.getBranch().filter(entry => entry.type === "configured_model_chain")).toEqual([
			expect.objectContaining({
				role: "default",
				entries: defaultChain,
				origin: "profile-activation",
				identity: profileName,
				explicitHead: true,
			}),
		]);
		expect(f.manager.requiresSharedMutationAdmission()).toBe(false);
		const id = f.manager.appendMessage(user("SDK message after profile"));
		await f.manager.flush();
		expect(f.manager.getLeafId()).toBe(id);
		expect(await Bun.file(f.file).text()).toContain("SDK message after profile");
	});
});

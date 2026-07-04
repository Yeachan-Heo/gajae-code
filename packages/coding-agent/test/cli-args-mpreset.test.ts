import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { TempDir } from "@gajae-code/utils";
import { parseArgs } from "../src/cli/args";
import type { ModelProfileDefinition } from "../src/config/model-profiles";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { applyStartupModelProfiles, createAcpSessionFactory, runRootCommand } from "../src/main";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../src/sdk";
import type { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";

const model = (provider: string, id: string): Model =>
	({ provider, id, name: id, api: "openai-responses", contextWindow: 1000, maxTokens: 1000 }) as Model;

const antigravityProfile = (): ModelProfileDefinition => ({
	name: "antigravity-flash",
	requiredProviders: ["google-antigravity"],
	modelMapping: { default: "google-antigravity/gemini-3.5-flash-low" },
	source: "user",
});

function fakeRegistry(
	profiles: ModelProfileDefinition[],
	options?: { afterRefreshModels?: Model[]; initialModels?: Model[] },
) {
	const profileMap = new Map(profiles.map(profile => [profile.name, profile]));
	let models = options?.initialModels ?? [model("profile-provider", "default"), model("cli-provider", "explicit")];
	return {
		getModelProfile: (name: string) => profileMap.get(name),
		getModelProfiles: () => new Map(profileMap),
		getAvailableModelProfileNames: () => [...profileMap.keys()].sort(),
		getApiKeyForProvider: async () => "key",
		getAll: () => models,
		refresh: async () => {
			models = options?.afterRefreshModels ?? models;
		},
	};
}

function fakeSession(initial = model("initial-provider", "initial")) {
	const session = {
		model: initial as Model | undefined,
		thinkingLevel: undefined as ThinkingLevel | undefined,
		sessionId: "session-1",
		setModelTemporaryCalls: [] as Array<{ model: Model; thinkingLevel?: ThinkingLevel }>,
		async setModelTemporary(next: Model, thinkingLevel?: ThinkingLevel) {
			session.setModelTemporaryCalls.push({ model: next, thinkingLevel });
			session.model = next;
			session.thinkingLevel = thinkingLevel;
		},
	};
	return session as AgentSession & { setModelTemporaryCalls: Array<{ model: Model; thinkingLevel?: ThinkingLevel }> };
}

async function runAcpProfileHarness(options: {
	readonly settings: Settings;
	readonly session: ReturnType<typeof fakeSession>;
	readonly profile: ModelProfileDefinition;
	readonly models: (refreshed: boolean) => Model[];
	readonly cloneForCwdSettings?: Settings;
}): Promise<{ readonly backgroundRefreshCount: number; readonly refreshStrategies: readonly string[] }> {
	const refreshStrategies: string[] = [];
	let backgroundRefreshCount = 0;
	let refreshed = false;
	const originalRefresh = ModelRegistry.prototype.refresh;
	const originalRefreshInBackground = ModelRegistry.prototype.refreshInBackground;
	const originalGetModelProfile = ModelRegistry.prototype.getModelProfile;
	const originalGetModelProfiles = ModelRegistry.prototype.getModelProfiles;
	const originalGetAvailableModelProfileNames = ModelRegistry.prototype.getAvailableModelProfileNames;
	const originalGetAll = ModelRegistry.prototype.getAll;
	const originalGetApiKeyForProvider = ModelRegistry.prototype.getApiKeyForProvider;
	using tempDir = TempDir.createSync("@gjc-mpreset-refresh-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));

	if (options.cloneForCwdSettings) {
		options.settings.cloneForCwd = async () => options.cloneForCwdSettings ?? options.settings;
	}
	ModelRegistry.prototype.refresh = async (strategy = "online-if-uncached") => {
		refreshStrategies.push(strategy);
		refreshed = true;
	};
	ModelRegistry.prototype.refreshInBackground = () => {
		backgroundRefreshCount += 1;
	};
	ModelRegistry.prototype.getModelProfile = (name: string) =>
		name === options.profile.name ? options.profile : undefined;
	ModelRegistry.prototype.getModelProfiles = () => new Map([[options.profile.name, options.profile]]);
	ModelRegistry.prototype.getAvailableModelProfileNames = () => [options.profile.name];
	ModelRegistry.prototype.getAll = () => options.models(refreshed);
	ModelRegistry.prototype.getApiKeyForProvider = async () => "key";

	try {
		await runRootCommand(parseArgs(["--mode", "acp", "--no-tools", "--no-lsp", "--no-skills", "--no-rules"]), [], {
			discoverAuthStorage: async () => authStorage,
			createAgentSession: async (): Promise<CreateAgentSessionResult> =>
				({
					session: options.session,
					setToolUIContext: () => {},
					extensionsResult: {},
					eventBus: {},
				}) as unknown as CreateAgentSessionResult,
			settings: options.settings,
			runAcpMode: async createAcpSession => {
				const nextSession = await createAcpSession(process.cwd());
				expect(nextSession).toBe(options.session);
			},
			suppressProcessExit: true,
		});
	} finally {
		authStorage.close();
		ModelRegistry.prototype.refresh = originalRefresh;
		ModelRegistry.prototype.refreshInBackground = originalRefreshInBackground;
		ModelRegistry.prototype.getModelProfile = originalGetModelProfile;
		ModelRegistry.prototype.getModelProfiles = originalGetModelProfiles;
		ModelRegistry.prototype.getAvailableModelProfileNames = originalGetAvailableModelProfileNames;
		ModelRegistry.prototype.getAll = originalGetAll;
		ModelRegistry.prototype.getApiKeyForProvider = originalGetApiKeyForProvider;
	}

	return { backgroundRefreshCount, refreshStrategies };
}
describe("CLI model profile args", () => {
	test("parses --mpreset forms and --default", () => {
		const parsed = parseArgs(["--mpreset", "codex-medium"]);
		expect(parsed.mpreset).toBe("codex-medium");
		expect(parsed.default).toBeUndefined();
		expect(parseArgs(["--mpreset=codex-pro"]).mpreset).toBe("codex-pro");
		const parsedDefault = parseArgs(["--mpreset", "opencodego", "--default"]);
		expect(parsedDefault.mpreset).toBe("opencodego");
		expect(parsedDefault.default).toBe(true);
	});

	test("rejects --default without --mpreset", () => {
		expect(() => parseArgs(["--default"])).toThrow("--default requires --mpreset <name>");
	});
});

test("explicit CLI --model/--thinking are reapplied after --mpreset activation", async () => {
	const session = fakeSession(model("cli-provider", "explicit"));
	const settings = Settings.isolated();

	await applyStartupModelProfiles({
		session,
		settings,
		modelRegistry: fakeRegistry([
			{
				name: "profile-a",
				requiredProviders: ["profile-provider"],
				modelMapping: { default: "profile-provider/default:high" },
				source: "user",
			},
		]) as never,
		parsedArgs: { mpreset: "profile-a", model: "cli-provider/explicit", thinking: ThinkingLevel.Low },
		startupModel: model("cli-provider", "explicit"),
		startupThinkingLevel: ThinkingLevel.Low,
	});

	expect(
		session.setModelTemporaryCalls.map(call => `${call.model.provider}/${call.model.id}:${call.thinkingLevel}`),
	).toEqual(["profile-provider/default:high", "cli-provider/explicit:low"]);
	expect(session.model?.provider).toBe("cli-provider");
	expect(session.model?.id).toBe("explicit");
	expect(session.thinkingLevel).toBe(ThinkingLevel.Low);
});
test("deferred explicit CLI --model is reapplied after --mpreset activation", async () => {
	const explicitModel = model("cli-provider", "explicit");
	const session = fakeSession(explicitModel);
	const settings = Settings.isolated();

	await applyStartupModelProfiles({
		session,
		settings,
		modelRegistry: fakeRegistry([
			{
				name: "codex-medium",
				requiredProviders: ["profile-provider"],
				modelMapping: { default: "profile-provider/default:high" },
				source: "user",
			},
		]) as never,
		parsedArgs: { mpreset: "codex-medium", model: "cli-provider/explicit" },
		startupModel: undefined,
		startupThinkingLevel: undefined,
	});

	expect(
		session.setModelTemporaryCalls.map(call => `${call.model.provider}/${call.model.id}:${call.thinkingLevel}`),
	).toEqual(["profile-provider/default:high", "cli-provider/explicit:undefined"]);
	expect(session.setModelTemporaryCalls.at(-1)?.model).toBe(explicitModel);
	expect(session.model).toBe(explicitModel);
});

test("runRootCommand foreground-refreshes startup profiles without background refresh", async () => {
	const session = fakeSession();
	const settings = Settings.isolated({ "modelProfile.default": "antigravity-flash" });
	const liveModel = model("google-antigravity", "gemini-3.5-flash-low");
	const profile = antigravityProfile();
	const result = await runAcpProfileHarness({ settings, session, profile, models: () => [liveModel] });

	expect(result.refreshStrategies).toEqual(["online-if-uncached"]);
	expect(result.backgroundRefreshCount).toBe(0);
	expect(session.setModelTemporaryCalls).toHaveLength(1);
	expect(session.model).toBe(liveModel);
});

test("ACP session/new refreshes project-scoped default profiles before activation", async () => {
	const session = fakeSession();
	const settings = Settings.isolated();
	const projectSettings = Settings.isolated({ "modelProfile.default": "antigravity-flash" });
	const liveModel = model("google-antigravity", "gemini-3.5-flash-low");
	const profile = antigravityProfile();
	const result = await runAcpProfileHarness({
		settings,
		session,
		profile,
		cloneForCwdSettings: projectSettings,
		models: refreshed => (refreshed ? [liveModel] : []),
	});

	expect(result.refreshStrategies).toEqual(["online-if-uncached"]);
	expect(result.backgroundRefreshCount).toBe(0);
	expect(session.setModelTemporaryCalls).toHaveLength(1);
	expect(session.model).toBe(liveModel);
});

test("ACP session factory applies default profile and --mpreset before returning session", async () => {
	const settings = Settings.isolated({ "modelProfile.default": "default-profile" });
	const session = fakeSession();
	const registry = fakeRegistry([
		{
			name: "default-profile",
			requiredProviders: ["profile-provider"],
			modelMapping: { default: "profile-provider/default:medium" },
			source: "user",
		},
		{
			name: "session-profile",
			requiredProviders: ["cli-provider"],
			modelMapping: { default: "cli-provider/explicit:high" },
			source: "user",
		},
	]) as never;
	const createSession = async (): Promise<CreateAgentSessionResult> =>
		({
			session,
			setToolUIContext: () => {},
			extensionsResult: {},
			eventBus: {},
		}) as unknown as CreateAgentSessionResult;
	const factory = createAcpSessionFactory({
		baseOptions: {} as CreateAgentSessionOptions,
		settings,
		authStorage: { setRuntimeApiKey: () => {} } as never,
		modelRegistry: registry,
		parsedArgs: { mpreset: "session-profile" },
		rawArgs: [],
		createSession,
	});

	const result = await factory(process.cwd());

	expect(result).toBe(session);
	expect(
		session.setModelTemporaryCalls.map(call => `${call.model.provider}/${call.model.id}:${call.thinkingLevel}`),
	).toEqual(["profile-provider/default:medium", "cli-provider/explicit:high"]);
});

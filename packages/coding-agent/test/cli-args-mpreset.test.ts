import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { parseArgs } from "../src/cli/args";
import type { ModelProfileDefinition } from "../src/config/model-profiles";
import { Settings } from "../src/config/settings";
import { applyStartupModelProfiles, createAcpSessionFactory } from "../src/main";
import { parseCliCredentialSelector } from "../src/runtime-credential-selector";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../src/sdk";
import type { AgentSession } from "../src/session/agent-session";

const model = (provider: string, id: string): Model =>
	({ provider, id, name: id, api: "openai-responses", contextWindow: 1000, maxTokens: 1000 }) as Model;

function fakeRegistry(
	profiles: ModelProfileDefinition[],
	options: { profilesAfterRefresh?: ModelProfileDefinition[]; modelsAfterRefresh?: Model[] } = {},
) {
	let activeProfiles = profiles;
	let activeModels = [model("profile-provider", "default"), model("cli-provider", "explicit")];
	const registry = {
		refreshCalls: [] as string[],
		refreshInBackgroundCalls: [] as string[],
		getModelProfile: (name: string) => new Map(activeProfiles.map(profile => [profile.name, profile])).get(name),
		getModelProfiles: () => new Map(activeProfiles.map(profile => [profile.name, profile])),
		getAvailableModelProfileNames: () => activeProfiles.map(profile => profile.name).sort(),
		getApiKeyForProvider: async () => "key",
		getAll: () => activeModels,
		async refresh(strategy = "online-if-uncached") {
			registry.refreshCalls.push(strategy);
			activeProfiles = options.profilesAfterRefresh ?? activeProfiles;
			activeModels = options.modelsAfterRefresh ?? activeModels;
		},
		refreshInBackground(strategy = "online-if-uncached") {
			registry.refreshInBackgroundCalls.push(strategy);
		},
	};
	return registry;
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
describe("CLI model profile args", () => {
	test("parses --mpreset with separate value", () => {
		const parsed = parseArgs(["--mpreset", "codex-medium"]);
		expect(parsed.mpreset).toBe("codex-medium");
		expect(parsed.default).toBeUndefined();
	});

	test("parses --mpreset=value", () => {
		const parsed = parseArgs(["--mpreset=codex-pro"]);
		expect(parsed.mpreset).toBe("codex-pro");
	});

	test("parses --default with --mpreset", () => {
		const parsed = parseArgs(["--mpreset", "opencodego", "--default"]);
		expect(parsed.mpreset).toBe("opencodego");
		expect(parsed.default).toBe(true);
	});

	test("rejects --default without --mpreset", () => {
		expect(() => parseArgs(["--default"])).toThrow("--default requires --mpreset <name>");
	});
});

describe("CLI credential selector args", () => {
	test("parses --credential with provider-qualified email selector", () => {
		const parsed = parseArgs(["--credential", "openai-codex/email:me@example.com"]);
		expect(parsed.credential).toBe("openai-codex/email:me@example.com");

		const selector = parseCliCredentialSelector(parsed.credential ?? "");
		expect(selector.provider).toBe("openai-codex");
		expect(selector.selector).toEqual({ kind: "email", value: "me@example.com" });
	});

	test("parses bare email credential selector as email shorthand", () => {
		const selector = parseCliCredentialSelector("me@example.com");
		expect(selector.selector).toEqual({ kind: "email", value: "me@example.com" });
	});

	test("rejects malformed credential selector", () => {
		expect(() => parseCliCredentialSelector("openai-codex/nope")).toThrow("Invalid --credential selector");
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
test("persisted default thinking overrides startup default profile effort", async () => {
	const settings = Settings.isolated({
		"modelProfile.default": "default-profile",
		defaultThinkingLevel: ThinkingLevel.XHigh,
	});
	const session = fakeSession();
	const registry = fakeRegistry([
		{
			name: "default-profile",
			requiredProviders: ["profile-provider"],
			modelMapping: { default: "profile-provider/default:medium" },
			source: "user",
		},
	]) as never;

	await applyStartupModelProfiles({
		session,
		settings,
		modelRegistry: registry,
		parsedArgs: {},
		startupModel: undefined,
		startupThinkingLevel: undefined,
	});

	expect(
		session.setModelTemporaryCalls.map(call => `${call.model.provider}/${call.model.id}:${call.thinkingLevel}`),
	).toEqual(["profile-provider/default:xhigh"]);
});

test("ACP session factory refreshes registry before applying project default profile", async () => {
	const settings = Settings.isolated();
	const projectSettings = Settings.isolated({ "modelProfile.default": "project-profile" });
	const settingsWithProjectClone = settings as Settings & { cloneForCwd: (cwd: string) => Promise<Settings> };
	settingsWithProjectClone.cloneForCwd = async () => projectSettings;
	const session = fakeSession();
	const registry = fakeRegistry([], {
		profilesAfterRefresh: [
			{
				name: "project-profile",
				requiredProviders: ["project-provider"],
				modelMapping: { default: "project-provider/discovered:medium" },
				source: "user",
			},
		],
		modelsAfterRefresh: [model("project-provider", "discovered")],
	});
	const createSessionContexts: Array<{ skipPostCreateModelRefresh?: boolean } | undefined> = [];
	const createSession = async (
		_options: CreateAgentSessionOptions,
		context?: { skipPostCreateModelRefresh?: boolean },
	): Promise<CreateAgentSessionResult> => {
		createSessionContexts.push(context);
		if (!context?.skipPostCreateModelRefresh) {
			registry.refreshInBackground();
		}
		return {
			session,
			setToolUIContext: () => {},
			extensionsResult: {},
			eventBus: {},
		} as unknown as CreateAgentSessionResult;
	};
	const factory = createAcpSessionFactory({
		baseOptions: {} as CreateAgentSessionOptions,
		settings,
		authStorage: { setRuntimeApiKey: () => {} } as never,
		modelRegistry: registry as never,
		parsedArgs: {},
		rawArgs: [],
		createSession,
	});

	const result = await factory(process.cwd());

	expect(result).toBe(session);
	expect(createSessionContexts).toEqual([{ skipPostCreateModelRefresh: true }]);
	expect(registry.refreshCalls).toEqual(["online-if-uncached"]);
	expect(registry.refreshInBackgroundCalls).toEqual([]);
	expect(
		session.setModelTemporaryCalls.map(call => `${call.model.provider}/${call.model.id}:${call.thinkingLevel}`),
	).toEqual(["project-provider/discovered:medium"]);
});

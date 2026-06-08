import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { parseArgs } from "../src/cli/args";
import type { ModelProfileDefinition } from "../src/config/model-profiles";
import { Settings } from "../src/config/settings";
import { applyStartupModelProfiles, createAcpSessionFactory } from "../src/main";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../src/sdk";
import type { AgentSession } from "../src/session/agent-session";

const model = (provider: string, id: string): Model =>
	({ provider, id, name: id, api: "openai-responses", contextWindow: 1000, maxTokens: 1000 }) as Model;

function fakeRegistry(profiles: ModelProfileDefinition[]) {
	const profileMap = new Map(profiles.map(profile => [profile.name, profile]));
	return {
		getModelProfile: (name: string) => profileMap.get(name),
		getModelProfiles: () => new Map(profileMap),
		getAvailableModelProfileNames: () => [...profileMap.keys()].sort(),
		getApiKeyForProvider: async () => "key",
		getAll: () => [model("profile-provider", "default"), model("cli-provider", "explicit")],
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
describe("CLI model profile args", () => {
	test("parses --mpreset with separate value", () => {
		const parsed = parseArgs(["--mpreset", "codex-standard"]);
		expect(parsed.mpreset).toBe("codex-standard");
		expect(parsed.default).toBeUndefined();
	});

	test("parses --mpreset=value", () => {
		const parsed = parseArgs(["--mpreset=codex-pro"]);
		expect(parsed.mpreset).toBe("codex-pro");
	});

	test("parses --default with --mpreset", () => {
		const parsed = parseArgs(["--mpreset", "opencode-go-standard", "--default"]);
		expect(parsed.mpreset).toBe("opencode-go-standard");
		expect(parsed.default).toBe(true);
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
				name: "codex-standard",
				requiredProviders: ["profile-provider"],
				modelMapping: { default: "profile-provider/default:high" },
				source: "user",
			},
		]) as never,
		parsedArgs: { mpreset: "codex-standard", model: "cli-provider/explicit" },
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

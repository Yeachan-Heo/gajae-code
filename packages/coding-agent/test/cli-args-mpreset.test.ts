import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { CliParseError } from "@gajae-code/utils/cli";
import { parseArgs } from "../src/cli/args";
import type { ModelProfileDefinition } from "../src/config/model-profiles";
import { Settings } from "../src/config/settings";
import { applyStartupModelProfiles } from "../src/main";
import { parseCliCredentialSelector } from "../src/runtime-credential-selector";
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
		setModelTemporaryCalls: [] as Array<{
			model: Model;
			thinkingLevel?: ThinkingLevel;
			options?: { persistAsSessionDefault?: boolean; cause?: string };
		}>,
		configuredModelChains: [] as Array<{ role: string; entries: readonly string[] }>,
		seedDefaultFallbackResolutionCalls: [] as Array<{
			activeIndex: number;
			skips: Array<{ selector: string; reason: string }>;
		}>,
		async setModelTemporary(
			next: Model,
			thinkingLevel?: ThinkingLevel,
			options?: { persistAsSessionDefault?: boolean; cause?: string },
		) {
			session.setModelTemporaryCalls.push({ model: next, thinkingLevel, options });
			session.model = next;
			session.thinkingLevel = thinkingLevel;
		},
		getConfiguredModelChain: () => undefined,
		setConfiguredModelChain(role: string, entries: readonly string[]) {
			session.configuredModelChains.push({ role, entries });
		},
		seedDefaultFallbackResolution(activeIndex: number, skips: Array<{ selector: string; reason: string }>) {
			session.seedDefaultFallbackResolutionCalls.push({ activeIndex, skips });
		},
	};
	return session as unknown as AgentSession & {
		setModelTemporaryCalls: typeof session.setModelTemporaryCalls;
		configuredModelChains: typeof session.configuredModelChains;
		seedDefaultFallbackResolutionCalls: typeof session.seedDefaultFallbackResolutionCalls;
	};
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

	test("rejects --credential without selector", () => {
		expect(() => parseArgs(["--credential"])).toThrow(CliParseError);
		expect(() => parseArgs(["--credential"])).toThrow("--credential requires <selector>");
		expect(() => parseArgs(["--credential", "--model", "opus"])).toThrow(CliParseError);
		expect(() => parseArgs(["--credential", "--model", "opus"])).toThrow("--credential requires <selector>");
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

test("explicit CLI --model rebases the resumed session default chain", async () => {
	const explicitModel = model("cli-provider", "explicit");
	const session = fakeSession(model("profile-provider", "persisted"));

	await applyStartupModelProfiles({
		session,
		settings: Settings.isolated(),
		modelRegistry: fakeRegistry([]) as never,
		parsedArgs: { model: "cli-provider/explicit" },
		startupModel: explicitModel,
		startupThinkingLevel: undefined,
	});

	expect(session.model).toBe(explicitModel);
	expect(session.setModelTemporaryCalls).toEqual([
		expect.objectContaining({
			model: explicitModel,
			options: { persistAsSessionDefault: true, cause: "startup-override" },
		}),
	]);
	expect(session.configuredModelChains).toEqual([{ role: "default", entries: ["cli-provider/explicit"] }]);
	expect(session.seedDefaultFallbackResolutionCalls).toEqual([{ activeIndex: 0, skips: [] }]);
});

test("startup model profiles apply the default profile before --mpreset", async () => {
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

	await applyStartupModelProfiles({
		session,
		settings,
		modelRegistry: registry,
		parsedArgs: { mpreset: "session-profile" },
		startupModel: undefined,
		startupThinkingLevel: undefined,
	});

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

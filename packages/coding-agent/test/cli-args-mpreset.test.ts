import { describe, expect, spyOn, test, vi } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { CliParseError } from "@gajae-code/utils/cli";
import { parseArgs } from "../src/cli/args";
import type { ModelProfileDefinition } from "../src/config/model-profiles";
import { Settings } from "../src/config/settings";
import {
	applyStartupModelProfiles,
	applyStartupModelProfilesForRoot,
	applyStartupModelProfilesOrExit,
	isStartupModelProfileCredentialRecoveryEligible,
} from "../src/main";
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
		async dispose() {},
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

describe("MCP config CLI args", () => {
	test("parses absolute config paths in both supported syntaxes", () => {
		expect(parseArgs(["--mcp-config", "/tmp/gjc-mcp.json"]).mcpConfig).toBe("/tmp/gjc-mcp.json");
		expect(parseArgs(["--mcp-config=/tmp/gjc-mcp.json"]).mcpConfig).toBe("/tmp/gjc-mcp.json");
	});

	test("rejects missing or non-absolute config paths", () => {
		for (const args of [
			["--mcp-config"],
			["--mcp-config", "relative/mcp.json"],
			["--mcp-config="],
			["--mcp-config=relative/mcp.json"],
		]) {
			expect(() => parseArgs(args)).toThrow(CliParseError);
			expect(() => parseArgs(args)).toThrow("--mcp-config requires <absolute-path>");
		}
	});
	test("rejects repeated config paths in every supported syntax", () => {
		for (const argv of [
			["--mcp-config", "/tmp/gjc-mcp.json", "--mcp-config", "/tmp/gjc-mcp.json"],
			["--mcp-config", "/tmp/gjc-mcp.json", "--mcp-config", "/tmp/other-mcp.json"],
			["--mcp-config", "/tmp/gjc-mcp.json", "--mcp-config=/tmp/other-mcp.json"],
			["--mcp-config=/tmp/gjc-mcp.json", "--mcp-config", "/tmp/other-mcp.json"],
		]) {
			let thrown: unknown;
			try {
				parseArgs(argv);
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBeInstanceOf(CliParseError);
			expect(thrown).toHaveProperty("message", "--mcp-config can only be specified once");
		}
	});

	test("rejects non-standalone config routes during parsing", () => {
		const rejectedArgs = [
			["--mcp-config", "/tmp/gjc-mcp.json", "--mode", "acp"],
			["--mcp-config", "/tmp/gjc-mcp.json", "--export", "/tmp/session.jsonl"],
			["--mcp-config", "/tmp/gjc-mcp.json", "--list-models"],
		];
		for (const args of rejectedArgs) {
			expect(() => parseArgs(args)).toThrow(CliParseError);
		}
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

test("startup profile activation failure disposes the session before exit", async () => {
	const session = fakeSession();
	let disposed = false;
	session.dispose = async () => {
		await Promise.resolve();
		disposed = true;
	};
	const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined): never => {
		if (!disposed) throw new Error("process exited before session cleanup");
		throw new Error(`exit ${code}`);
	});
	const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	try {
		await expect(
			applyStartupModelProfilesOrExit({
				session,
				settings: Settings.isolated(),
				modelRegistry: fakeRegistry([]) as never,
				parsedArgs: { mpreset: "missing-profile" },
			}),
		).rejects.toThrow("exit 1");
		expect(exitSpy).toHaveBeenCalledWith(1);
	} finally {
		stderrSpy.mockRestore();
		exitSpy.mockRestore();
	}
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

test("noninteractive startup keeps the exit-on-missing-credential contract", async () => {
	const session = fakeSession();
	const settings = Settings.isolated({ "modelProfile.default": "codex-medium" });
	const registry = {
		...fakeRegistry([
			{
				name: "codex-medium",
				requiredProviders: ["openai-codex"],
				modelMapping: { default: "openai-codex/default:high" },
				source: "user",
			},
		]),
		getApiKeyForProvider: async () => undefined,
	} as never;

	const exit = new Error("exit 1");
	const exitSpy = spyOn(process, "exit").mockImplementation((() => {
		throw exit;
	}) as never);
	const stderr: string[] = [];
	const stderrSpy = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
		stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as never);
	try {
		await expect(
			applyStartupModelProfilesOrExit({
				session,
				settings,
				modelRegistry: registry,
				parsedArgs: {},
				startupModel: undefined,
				startupThinkingLevel: undefined,
			}),
		).rejects.toBe(exit);
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(stderr.join("")).toContain('Model profile "codex-medium" requires credentials for: openai-codex');
	} finally {
		stderrSpy.mockRestore();
		exitSpy.mockRestore();
	}
});

test("credential recovery does not mask unrelated model-profile activation errors", async () => {
	const session = fakeSession();
	const settings = Settings.isolated({ "modelProfile.default": "missing-profile" });
	const exit = new Error("exit 1");
	const exitSpy = spyOn(process, "exit").mockImplementation((() => {
		throw exit;
	}) as never);
	const stderrSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
	try {
		await expect(
			applyStartupModelProfilesOrExit({
				session,
				settings,
				modelRegistry: fakeRegistry([]) as never,
				parsedArgs: {},
				startupModel: undefined,
				startupThinkingLevel: undefined,
			}),
		).rejects.toBe(exit);
		expect(exitSpy).toHaveBeenCalledWith(1);
	} finally {
		stderrSpy.mockRestore();
		exitSpy.mockRestore();
	}
});

describe("startup model-profile credential recovery eligibility", () => {
	test.each([
		["ordinary input-free interactive startup", true, true, undefined, [], undefined, true],
		["redirected stdin or stdout", true, false, undefined, [], undefined, false],
		["print or text startup", false, true, undefined, [], undefined, false],
		["explicit startup prompt", true, true, "hello", [], undefined, false],
		["slash or positional startup message", true, true, undefined, ["/login"], undefined, false],
		["image-only startup", true, true, "", [], undefined, false],
		["automatic resume continuation", true, true, undefined, [], "continue-tail", false],
		["idle resume picker selection", true, true, undefined, [], "open-idle", true],
	] as const)("%s", (_name, isInteractive, hasInteractiveTerminal, initialMessage, initialMessages, resumeAction, expected) => {
		expect(
			isStartupModelProfileCredentialRecoveryEligible({
				isInteractive,
				hasInteractiveTerminal,
				initialMessage,
				initialMessages,
				resumeAction,
			}),
		).toBe(expected);
	});
});

test("root startup recovers a missing credential only for an input-free interactive route", async () => {
	const session = fakeSession();
	const settings = Settings.isolated({ "modelProfile.default": "codex-medium" });
	const registry = {
		...fakeRegistry([
			{
				name: "codex-medium",
				requiredProviders: ["openai-codex"],
				modelMapping: { default: "openai-codex/default:high" },
				source: "user",
			},
		]),
		getApiKeyForProvider: async () => undefined,
	} as never;

	const result = await applyStartupModelProfilesForRoot({
		session,
		settings,
		modelRegistry: registry,
		parsedArgs: {},
		startupModel: undefined,
		startupThinkingLevel: undefined,
		isInteractive: true,
		hasInteractiveTerminal: true,
		initialMessage: undefined,
		initialMessages: [],
		resumeAction: undefined,
	});

	expect(result.recoverableErrors).toEqual([
		expect.stringContaining('Model profile "codex-medium" requires credentials for: openai-codex'),
	]);
});

test.each([
	["redirected terminal", true, false, undefined, [], undefined],
	["print or text", false, true, undefined, [], undefined],
	["explicit prompt", true, true, "hello", [], undefined],
	["positional or slash input", true, true, undefined, ["do work"], undefined],
	["image-only input", true, true, "", [], undefined],
	["automatic resume continuation", true, true, undefined, [], "continue-tail"],
] as const)("root startup keeps %s credential failures fatal", async (_name, isInteractive, hasInteractiveTerminal, initialMessage, initialMessages, resumeAction) => {
	const session = fakeSession();
	const settings = Settings.isolated({ "modelProfile.default": "codex-medium" });
	const registry = {
		...fakeRegistry([
			{
				name: "codex-medium",
				requiredProviders: ["openai-codex"],
				modelMapping: { default: "openai-codex/default:high" },
				source: "user",
			},
		]),
		getApiKeyForProvider: async () => undefined,
	} as never;
	const exit = new Error("exit 1");
	const exitSpy = spyOn(process, "exit").mockImplementation((() => {
		throw exit;
	}) as never);
	const stderrSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
	try {
		await expect(
			applyStartupModelProfilesForRoot({
				session,
				settings,
				modelRegistry: registry,
				parsedArgs: {},
				startupModel: undefined,
				startupThinkingLevel: undefined,
				isInteractive,
				hasInteractiveTerminal,
				initialMessage,
				initialMessages,
				resumeAction,
			}),
		).rejects.toBe(exit);
	} finally {
		stderrSpy.mockRestore();
		exitSpy.mockRestore();
	}
});

test("recoverable blocked default still applies healthy --mpreset and explicit CLI override", async () => {
	const explicitModel = model("cli-provider", "explicit");
	const session = fakeSession(explicitModel);
	const settings = Settings.isolated({ "modelProfile.default": "blocked-default" });
	const registry = {
		...fakeRegistry([
			{
				name: "blocked-default",
				requiredProviders: ["blocked-provider"],
				modelMapping: { default: "blocked-provider/default:medium" },
				source: "user",
			},
			{
				name: "healthy-session",
				requiredProviders: ["profile-provider"],
				modelMapping: { default: "profile-provider/default:high" },
				source: "user",
			},
		]),
		getApiKeyForProvider: async (provider: string) => (provider === "blocked-provider" ? undefined : "key"),
	} as never;

	const result = await applyStartupModelProfilesForRoot({
		session,
		settings,
		modelRegistry: registry,
		parsedArgs: { mpreset: "healthy-session", model: "cli-provider/explicit", thinking: ThinkingLevel.Low },
		startupModel: explicitModel,
		startupThinkingLevel: ThinkingLevel.Low,
		isInteractive: true,
		hasInteractiveTerminal: true,
		initialMessage: undefined,
		initialMessages: [],
		resumeAction: undefined,
	});

	expect(result.recoverableErrors).toHaveLength(1);
	expect(
		session.setModelTemporaryCalls.map(call => `${call.model.provider}/${call.model.id}:${call.thinkingLevel}`),
	).toEqual(["profile-provider/default:high", "cli-provider/explicit:low"]);
});

test("recoverable blocked --mpreset still reapplies explicit CLI override after a healthy default", async () => {
	const explicitModel = model("cli-provider", "explicit");
	const session = fakeSession(explicitModel);
	const settings = Settings.isolated({ "modelProfile.default": "healthy-default" });
	const registry = {
		...fakeRegistry([
			{
				name: "healthy-default",
				requiredProviders: ["profile-provider"],
				modelMapping: { default: "profile-provider/default:medium" },
				source: "user",
			},
			{
				name: "blocked-session",
				requiredProviders: ["blocked-provider"],
				modelMapping: { default: "blocked-provider/default:high" },
				source: "user",
			},
		]),
		getApiKeyForProvider: async (provider: string) => (provider === "blocked-provider" ? undefined : "key"),
	} as never;

	const result = await applyStartupModelProfilesForRoot({
		session,
		settings,
		modelRegistry: registry,
		parsedArgs: { mpreset: "blocked-session", model: "cli-provider/explicit", thinking: ThinkingLevel.XHigh },
		startupModel: explicitModel,
		startupThinkingLevel: ThinkingLevel.XHigh,
		isInteractive: true,
		hasInteractiveTerminal: true,
		initialMessage: undefined,
		initialMessages: [],
		resumeAction: undefined,
	});

	expect(result.recoverableErrors).toHaveLength(1);
	expect(
		session.setModelTemporaryCalls.map(call => `${call.model.provider}/${call.model.id}:${call.thinkingLevel}`),
	).toEqual(["profile-provider/default:medium", "cli-provider/explicit:xhigh"]);
});

test("thinking-only startup uses authoritative override semantics", async () => {
	const settings = Settings.isolated();
	const session = fakeSession();

	await applyStartupModelProfiles({
		session,
		settings,
		modelRegistry: fakeRegistry([]) as never,
		parsedArgs: { thinking: ThinkingLevel.High },
		startupModel: undefined,
		startupThinkingLevel: undefined,
	});

	expect(session.setModelTemporaryCalls).toEqual([
		expect.objectContaining({
			model: session.model,
			thinkingLevel: ThinkingLevel.High,
			options: { cause: "startup-override" },
		}),
	]);
});

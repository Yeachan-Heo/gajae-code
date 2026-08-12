import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import * as modelProfileActivation from "../../src/config/model-profile-activation";
import { Settings } from "../../src/config/settings";
import type { AgentSession } from "../../src/session/agent-session";
import type { SessionManager } from "../../src/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "../../src/slash-commands/acp-builtins";
import { resolvePresetSelector } from "../../src/slash-commands/builtin-registry";

interface StubRegistry {
	getModelProfile: (name: string) => unknown;
	getError?: () => unknown;
}

function registryWithProfiles(...names: string[]): StubRegistry {
	return {
		getModelProfile: (name: string) => (names.includes(name) ? { name } : undefined),
	};
}

describe("resolvePresetSelector", () => {
	test("matches a bare preset name", () => {
		expect(resolvePresetSelector("codex-medium", registryWithProfiles("codex-medium"))).toBe("codex-medium");
	});

	test("matches a gajae-code/-namespaced preset name", () => {
		expect(resolvePresetSelector("gajae-code/codex-medium", registryWithProfiles("codex-medium"))).toBe(
			"codex-medium",
		);
	});

	test("matches a gajae-code/-namespaced preset name case-insensitively on the prefix", () => {
		expect(resolvePresetSelector("GAJAE-CODE/codex-medium", registryWithProfiles("codex-medium"))).toBe(
			"codex-medium",
		);
	});

	test("returns undefined for an unknown preset name so the caller falls through", () => {
		expect(resolvePresetSelector("not-a-preset", registryWithProfiles("codex-medium"))).toBeUndefined();
	});

	test("returns undefined for a provider/model reference even if the suffix matches a preset", () => {
		// `anthropic/codex-medium` is a model selector, not a preset shortcut.
		expect(resolvePresetSelector("anthropic/codex-medium", registryWithProfiles("codex-medium"))).toBeUndefined();
	});

	test("returns undefined for other slash-prefixed namespaces", () => {
		expect(resolvePresetSelector("other/codex-medium", registryWithProfiles("codex-medium"))).toBeUndefined();
	});

	test("returns undefined for gajae-code/ with a nested slash", () => {
		expect(resolvePresetSelector("gajae-code/foo/bar", registryWithProfiles("foo"))).toBeUndefined();
	});

	test("returns undefined for an empty selector", () => {
		expect(resolvePresetSelector("", registryWithProfiles("codex-medium"))).toBeUndefined();
		expect(resolvePresetSelector("   ", registryWithProfiles("codex-medium"))).toBeUndefined();
	});

	test("returns undefined when the registry reports a load error", () => {
		const reg: StubRegistry = {
			getModelProfile: () => ({ name: "codex-medium" }),
			getError: () => new Error("registry corrupt"),
		};
		expect(resolvePresetSelector("codex-medium", reg)).toBeUndefined();
	});

	test("trims surrounding whitespace before matching", () => {
		expect(resolvePresetSelector("  codex-medium  ", registryWithProfiles("codex-medium"))).toBe("codex-medium");
	});
});

function createRuntime() {
	const output: string[] = [];
	const settings = Settings.isolated();
	let activeModelProfile: string | undefined;
	const availableModel = { provider: "anthropic", id: "claude-3-5-sonnet", contextWindow: 200_000 };
	const knownProfiles = new Set<string>(["codex-medium"]);
	const session = {
		sessionId: "session-1",
		model: undefined as { provider: string; id: string; contextWindow?: number } | undefined,
		thinkingLevel: undefined as string | undefined,
		modelRegistry: {
			async getApiKey(_model: { provider: string; id: string }, _sessionId?: string) {
				return "test-api-key";
			},
			resolveCanonicalModel: (
				_selector: string,
				_options?: { candidates?: Array<{ provider: string; id: string }> },
			) => undefined,
			getAvailable: () => [availableModel],
			getModelProfile: (name: string) => (knownProfiles.has(name) ? { name } : undefined),
			getError: () => undefined,
		},
		getAvailableModels: () => [availableModel],
		setConfiguredModelChain: () => {},
		async setModel(model: { provider: string; id: string }, _role: "default", _options?: unknown) {
			this.model = model;
		},
		setThinkingLevel(thinkingLevel: string) {
			this.thinkingLevel = thinkingLevel;
		},
		getActiveModelProfile() {
			return activeModelProfile;
		},
		setActiveModelProfile(name: string | undefined) {
			activeModelProfile = name;
		},
	};
	const sessionManager = {
		getSessionId: () => "session-1",
		getSessionFile: () => undefined,
		getCwd: () => "/tmp/project",
		getEntries: () => [],
		getBranch: () => [],
		appendCustomEntry: () => "entry-1",
		flush: async () => {},
		buildSessionContext: () => ({ messages: [], thinkingLevel: "off", models: {}, injectedTtsrRules: [] }),
		getUsageStatistics: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, premiumRequests: 0, cost: 0 }),
	};
	return {
		output,
		settings,
		session,
		knownProfiles,
		runtime: {
			session: session as unknown as AgentSession,
			sessionManager: sessionManager as unknown as SessionManager,
			settings,
			cwd: "/tmp/project",
			output: (text: string) => {
				output.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
			notifyTitleChanged: undefined as (() => Promise<void> | void) | undefined,
			notifyConfigChanged: undefined as (() => Promise<void> | void) | undefined,
		},
	};
}

describe("/model <preset> activation", () => {
	const activateSpy = spyOn(modelProfileActivation, "activateModelProfile").mockResolvedValue(undefined);

	afterEach(() => {
		activateSpy.mockClear();
	});
	afterAll(() => {
		activateSpy.mockRestore();
	});

	test("/model <preset> activates the named profile for the session", async () => {
		const { output, runtime } = createRuntime();
		let titleNotified = 0;
		let configNotified = 0;
		runtime.notifyTitleChanged = () => {
			titleNotified++;
		};
		runtime.notifyConfigChanged = () => {
			configNotified++;
		};

		const result = await executeAcpBuiltinSlashCommand("/model codex-medium", runtime);

		expect(result).toEqual({ consumed: true });
		expect(activateSpy).toHaveBeenCalledTimes(1);
		const [options, applyOptions] = activateSpy.mock.calls[0]!;
		expect(options.profileName).toBe("codex-medium");
		expect(applyOptions).toEqual({ persistDefault: false });
		expect(output[0]).toContain("Model profile: codex-medium");
		expect(titleNotified).toBe(1);
		expect(configNotified).toBe(1);
	});

	test("/model gajae-code/<preset> activates the named profile after stripping the namespace", async () => {
		const { runtime } = createRuntime();

		await executeAcpBuiltinSlashCommand("/model gajae-code/codex-medium", runtime);

		const [options, applyOptions] = activateSpy.mock.calls[0]!;
		expect(options.profileName).toBe("codex-medium");
		expect(applyOptions).toEqual({ persistDefault: false });
	});

	test("/model <preset> surfaces an activation failure as a usage message", async () => {
		const { output, runtime } = createRuntime();
		activateSpy.mockRejectedValueOnce(
			new Error('Model profile "codex-medium" requires credentials for: openai-codex.'),
		);

		const result = await executeAcpBuiltinSlashCommand("/model codex-medium", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Failed to activate model profile");
		expect(output[0]).toContain("requires credentials");
	});

	test("/model <role> <preset-name> does NOT activate a preset — it assigns to the role", async () => {
		const { runtime, session } = createRuntime();
		session.getAvailableModels = () => [{ provider: "anthropic", id: "codex-medium", contextWindow: 200_000 }];

		await executeAcpBuiltinSlashCommand("/model executor codex-medium", runtime);

		// Preset activation must not fire for an explicit role target.
		expect(activateSpy).not.toHaveBeenCalled();
		expect(runtime.settings.get("task.agentModelOverrides")).toEqual({
			executor: "anthropic/codex-medium",
		});
	});

	test("/model default <preset-name> does NOT activate a preset — it assigns the default model", async () => {
		const { output, runtime, session } = createRuntime();
		session.getAvailableModels = () => [{ provider: "anthropic", id: "codex-medium", contextWindow: 200_000 }];

		const result = await executeAcpBuiltinSlashCommand("/model default codex-medium", runtime);

		expect(result).toEqual({ consumed: true });
		expect(activateSpy).not.toHaveBeenCalled();
		expect(session.model).toMatchObject({ provider: "anthropic", id: "codex-medium" });
		expect(runtime.settings.getModelRole("default")).toBe("anthropic/codex-medium");
		expect(output[0]).toContain("Default model set to anthropic/codex-medium");
	});

	test("/model <unknown-name> falls through to model resolution", async () => {
		const { output, runtime } = createRuntime();

		const result = await executeAcpBuiltinSlashCommand("/model not-a-preset", runtime);

		expect(result).toEqual({ consumed: true });
		expect(activateSpy).not.toHaveBeenCalled();
		expect(output[0]).toContain("Unknown model: not-a-preset");
	});

	test("/model <provider>/<model> still resolves as a model even with profiles present", async () => {
		const { output, runtime } = createRuntime();

		const result = await executeAcpBuiltinSlashCommand("/model anthropic/claude-3-5-sonnet", runtime);

		expect(result).toEqual({ consumed: true });
		expect(activateSpy).not.toHaveBeenCalled();
		expect(output[0]).toContain("Default model set to anthropic/claude-3-5-sonnet");
	});
});

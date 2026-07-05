import { describe, expect, spyOn, test } from "bun:test";
import { Settings } from "../../src/config/settings";
import type { AgentSession } from "../../src/session/agent-session";
import type { SessionManager } from "../../src/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "../../src/slash-commands/acp-builtins";

function createRuntime() {
	const output: string[] = [];
	const settings = Settings.isolated();
	let activeModelProfile: string | undefined;
	const availableModel = { provider: "anthropic", id: "claude-3-5-sonnet", contextWindow: 200_000 };
	const session = {
		sessionId: "session-1",
		model: undefined as { provider: string; id: string; contextWindow?: number } | undefined,
		thinkingLevel: undefined as string | undefined,
		modelRegistry: {
			async getApiKey(_model: { provider: string; id: string }, _sessionId?: string) {
				return "test-api-key";
			},
			resolveCanonicalModel: (
				selector: string,
				options?: { candidates?: Array<{ provider: string; id: string }> },
			) => (selector === "claude-sonnet" ? options?.candidates?.[0] : undefined),
		},
		getAvailableModels: () => [availableModel],
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
		setActiveModelProfile(name: string | undefined) {
			activeModelProfile = name;
		},
	};
}

describe("/model batch assignments", () => {
	test("roles and assignments print the five-row summary without mutating settings", async () => {
		const { output, runtime, settings } = createRuntime();
		settings.setModelRole("default", "anthropic/default-model:medium");
		settings.set("task.agentModelOverrides", { executor: "anthropic/executor-model:low" });

		await expect(executeAcpBuiltinSlashCommand("/model roles", runtime)).resolves.toEqual({ consumed: true });
		await expect(executeAcpBuiltinSlashCommand("/model assignments", runtime)).resolves.toEqual({ consumed: true });

		const expected = [
			"Model assignments:",
			"  DEFAULT (Default): anthropic/default-model:medium",
			"  EXECUTOR (Executor): anthropic/executor-model:low",
			"  ARCHITECT (Architect): (unset)",
			"  PLANNER (Planner): (unset)",
			"  CRITIC (Critic): (unset)",
		].join("\n");
		expect(output).toEqual([expected, expected]);
		expect(settings.get("task.agentModelOverrides")).toEqual({ executor: "anthropic/executor-model:low" });
	});

	test("assign all-role-agents writes only role-agent overrides with no active profile", async () => {
		const { output, runtime, settings } = createRuntime();
		settings.setModelRole("default", "anthropic/default-model:medium");

		await expect(
			executeAcpBuiltinSlashCommand("/model assign all-role-agents claude-3-5-sonnet:low", runtime),
		).resolves.toEqual({ consumed: true });

		expect(settings.getModelRole("default")).toBe("anthropic/default-model:medium");
		expect(settings.get("task.agentModelOverrides")).toEqual({
			executor: "anthropic/claude-3-5-sonnet:low",
			architect: "anthropic/claude-3-5-sonnet:low",
			planner: "anthropic/claude-3-5-sonnet:low",
			critic: "anthropic/claude-3-5-sonnet:low",
		});
		expect(output).toEqual([
			"Role-agent models set to anthropic/claude-3-5-sonnet:low for EXECUTOR, ARCHITECT, PLANNER, CRITIC.",
		]);
	});

	test("assign all-targets materializes an active profile exactly once", async () => {
		const { output, runtime, session, settings, setActiveModelProfile } = createRuntime();
		session.model = { provider: "anthropic", id: "current-model" };
		settings.set("modelProfile.default", "profile-a");
		setActiveModelProfile("profile-a");
		const setActiveSpy = spyOn(session, "setActiveModelProfile");

		await expect(
			executeAcpBuiltinSlashCommand("/model assign all-targets claude-sonnet:low", runtime),
		).resolves.toEqual({ consumed: true });

		expect(setActiveSpy).toHaveBeenCalledTimes(1);
		expect(setActiveSpy).toHaveBeenCalledWith(undefined);
		expect(settings.getModelRole("default")).toBe("claude-sonnet:low");
		expect(settings.get("task.agentModelOverrides")).toEqual({
			executor: "claude-sonnet:low",
			architect: "claude-sonnet:low",
			planner: "claude-sonnet:low",
			critic: "claude-sonnet:low",
		});
		expect(settings.get("modelProfile.default")).toBeUndefined();
		expect(output).toEqual([
			"All model targets set to claude-sonnet:low for DEFAULT, EXECUTOR, ARCHITECT, PLANNER, CRITIC.",
		]);
	});

	test("/model preserves existing DEFAULT effort when selector has no explicit effort", async () => {
		const { output, runtime, settings, session } = createRuntime();
		settings.setModelRole("default", "anthropic/original-model:high");

		await expect(executeAcpBuiltinSlashCommand("/model claude-3-5-sonnet", runtime)).resolves.toEqual({
			consumed: true,
		});

		expect(settings.getModelRole("default")).toBe("anthropic/claude-3-5-sonnet:high");
		expect(session.thinkingLevel).toBe("high");
		expect(output).toEqual(["DEFAULT model set to anthropic/claude-3-5-sonnet:high."]);
	});
});

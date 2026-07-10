import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import type { AgentSession } from "../../src/session/agent-session";
import type { SessionManager } from "../../src/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "../../src/slash-commands/acp-builtins";
import { lookupBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";

function createRuntime(settings = Settings.isolated()) {
	const output: string[] = [];
	let activeModelProfile: string | undefined;
	let resumeDefaultModelSelector: string | undefined;
	let pendingSettingsModel: { provider: string; id: string } | undefined;
	let pendingSettingsThinkingLevel: string | undefined;
	const availableModel = {
		provider: "anthropic",
		id: "claude-3-5-sonnet",
		contextWindow: 200_000,
		reasoning: true,
		thinking: { mode: "effort", minLevel: "low", maxLevel: "high" },
	};
	const session = {
		sessionId: "session-1",
		model: undefined as { provider: string; id: string; contextWindow?: number } | undefined,
		thinkingLevel: undefined as string | undefined,
		modelRegistry: {
			async getApiKey(_model: { provider: string; id: string }, _sessionId?: string): Promise<string | undefined> {
				return "test-api-key";
			},
			resolveCanonicalModel: (
				selector: string,
				options?: { candidates?: Array<{ provider: string; id: string }> },
			) => (selector === "claude-sonnet" ? options?.candidates?.[0] : undefined),
			getAll: () => [availableModel],
			getModelProfile: () => undefined,
		},
		getAvailableModels: () => [availableModel],
		async setModel(model: { provider: string; id: string }, _role: "default", options?: { thinkingLevel?: string }) {
			this.model = model;
			if (options?.thinkingLevel) this.thinkingLevel = options.thinkingLevel;
			resumeDefaultModelSelector = `${model.provider}/${model.id}`;
		},
		async setModelForSettingsCommit(model: { provider: string; id: string }, thinkingLevel?: string) {
			pendingSettingsModel = model;
			pendingSettingsThinkingLevel = thinkingLevel;
		},
		async commitSettingsModelChange(model: { provider: string; id: string }) {
			if (pendingSettingsModel === model) {
				this.model = model;
				this.thinkingLevel = pendingSettingsThinkingLevel;
				resumeDefaultModelSelector = `${model.provider}/${model.id}`;
				pendingSettingsModel = undefined;
				pendingSettingsThinkingLevel = undefined;
			}
		},
		cancelSettingsModelChange() {
			pendingSettingsModel = undefined;
			pendingSettingsThinkingLevel = undefined;
		},
		async setModelTemporary(model: { provider: string; id: string }, thinkingLevel?: string) {
			this.model = model;
			this.thinkingLevel = thinkingLevel;
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
		getSessionDefaultModelSelector() {
			return resumeDefaultModelSelector;
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
		setSessionDefaultModelSelector(selector: string | undefined) {
			resumeDefaultModelSelector = selector;
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

	test("batch success reports preserved per-role efforts instead of claiming one value", async () => {
		const { output, runtime, settings } = createRuntime();
		settings.setModelRole("default", "anthropic/original-default:high");
		settings.set("task.agentModelOverrides", {
			executor: "anthropic/original-executor:low",
			architect: "anthropic/original-architect:medium",
			planner: "anthropic/original-planner:high",
			critic: "anthropic/original-critic:low",
		});

		await expect(
			executeAcpBuiltinSlashCommand("/model assign all-targets claude-3-5-sonnet", runtime),
		).resolves.toEqual({ consumed: true });

		expect(settings.getModelRole("default")).toBe("anthropic/claude-3-5-sonnet:high");
		expect(settings.get("task.agentModelOverrides")).toEqual({
			executor: "anthropic/claude-3-5-sonnet:low",
			architect: "anthropic/claude-3-5-sonnet:medium",
			planner: "anthropic/claude-3-5-sonnet:high",
			critic: "anthropic/claude-3-5-sonnet:low",
		});
		expect(output).toEqual([
			[
				"All model targets updated:",
				"  DEFAULT: anthropic/claude-3-5-sonnet:high",
				"  EXECUTOR: anthropic/claude-3-5-sonnet:low",
				"  ARCHITECT: anthropic/claude-3-5-sonnet:medium",
				"  PLANNER: anthropic/claude-3-5-sonnet:high",
				"  CRITIC: anthropic/claude-3-5-sonnet:low",
			].join("\n"),
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
		expect(output).toEqual(["Default model set to anthropic/claude-3-5-sonnet:high."]);
	});
	test("explicit DEFAULT inherit applies the configured effort live without persisting a suffix", async () => {
		const { runtime, session, settings } = createRuntime();
		settings.set("defaultThinkingLevel", ThinkingLevel.High);

		await expect(executeAcpBuiltinSlashCommand("/model claude-3-5-sonnet:inherit", runtime)).resolves.toEqual({
			consumed: true,
		});

		expect(session.thinkingLevel).toBe("high");
		expect(settings.getModelRole("default")).toBe("anthropic/claude-3-5-sonnet");
	});

	test("all-targets inherit applies the configured DEFAULT effort live without persisting it", async () => {
		const { output, runtime, session, settings } = createRuntime();
		settings.set("defaultThinkingLevel", ThinkingLevel.High);

		await expect(
			executeAcpBuiltinSlashCommand("/model assign all-targets claude-3-5-sonnet:inherit", runtime),
		).resolves.toEqual({ consumed: true });

		expect(session.thinkingLevel).toBe("high");
		expect(settings.getModelRole("default")).toBe("anthropic/claude-3-5-sonnet");
		expect(settings.get("task.agentModelOverrides")).toEqual({
			executor: "anthropic/claude-3-5-sonnet",
			architect: "anthropic/claude-3-5-sonnet",
			planner: "anthropic/claude-3-5-sonnet",
			critic: "anthropic/claude-3-5-sonnet",
		});

		await expect(executeAcpBuiltinSlashCommand("/model roles", runtime)).resolves.toEqual({ consumed: true });
		expect(output.at(-1)).toContain(
			"DEFAULT (Default): anthropic/claude-3-5-sonnet (effective: anthropic/claude-3-5-sonnet:high)",
		);
	});

	test("reports project role settings that resume on restart", async () => {
		const { output, runtime, settings } = createRuntime();
		settings.getProject = ((path: string) =>
			path === "task.agentModelOverrides"
				? { executor: "project/executor" }
				: undefined) as typeof settings.getProject;

		await expect(executeAcpBuiltinSlashCommand("/model executor claude-3-5-sonnet:high", runtime)).resolves.toEqual({
			consumed: true,
		});

		expect(output).toEqual([
			[
				"executor agent model set to anthropic/claude-3-5-sonnet:high.",
				"Project settings for EXECUTOR resume on restart.",
			].join("\n"),
		]);
	});
	test("active-profile all-targets preserves the live DEFAULT effort when effort is omitted", async () => {
		const { output, runtime, settings, session, setActiveModelProfile } = createRuntime();
		session.model = { provider: "anthropic", id: "profile-model" };
		session.thinkingLevel = "high";
		settings.setModelRole("default", "anthropic/baseline:low");
		settings.set("modelProfile.default", "profile-a");
		setActiveModelProfile("profile-a");
		settings.override("task.agentModelOverrides", {
			executor: "anthropic/profile-executor:high",
			architect: "anthropic/profile-architect:high",
			planner: "anthropic/profile-planner:high",
			critic: "anthropic/profile-critic:high",
		});

		await expect(
			executeAcpBuiltinSlashCommand("/model assign all-targets claude-3-5-sonnet", runtime),
		).resolves.toEqual({ consumed: true });

		expect(settings.getModelRole("default")).toBe("anthropic/claude-3-5-sonnet:high");
		expect(settings.get("task.agentModelOverrides")).toEqual({
			executor: "anthropic/claude-3-5-sonnet:high",
			architect: "anthropic/claude-3-5-sonnet:high",
			planner: "anthropic/claude-3-5-sonnet:high",
			critic: "anthropic/claude-3-5-sonnet:high",
		});
		expect(session.thinkingLevel).toBe("high");
		expect(settings.get("modelProfile.default")).toBeUndefined();
		expect(output).toEqual([
			"All model targets set to anthropic/claude-3-5-sonnet:high for DEFAULT, EXECUTOR, ARCHITECT, PLANNER, CRITIC.",
		]);
	});

	test("summary reports the active profile's live DEFAULT model and effort", async () => {
		const { output, runtime, settings, session, setActiveModelProfile } = createRuntime();
		settings.setModelRole("default", "anthropic/baseline:low");
		session.model = { provider: "anthropic", id: "profile-model" };
		session.thinkingLevel = "high";
		setActiveModelProfile("profile-a");

		await expect(executeAcpBuiltinSlashCommand("/model roles", runtime)).resolves.toEqual({ consumed: true });

		expect(output[0]).toContain("DEFAULT (Default): anthropic/profile-model:high");
		expect(output[0]).not.toContain("DEFAULT (Default): anthropic/baseline:low");
	});

	test("notification failures do not report a committed assignment as failed", async () => {
		const { output, runtime, settings } = createRuntime();
		runtime.notifyTitleChanged = async () => {
			throw new Error("title transport unavailable");
		};
		runtime.notifyConfigChanged = async () => {
			throw new Error("config transport unavailable");
		};

		await expect(executeAcpBuiltinSlashCommand("/model claude-3-5-sonnet:low", runtime)).resolves.toEqual({
			consumed: true,
		});
		await Bun.sleep(0);

		expect(settings.getModelRole("default")).toBe("anthropic/claude-3-5-sonnet:low");
		expect(output).toEqual([
			"Default model set to anthropic/claude-3-5-sonnet:low.",
			"Model settings were updated, but notification failed (title: title transport unavailable).",
			"Model settings were updated, but notification failed (config: config transport unavailable).",
		]);
	});

	test("missing credentials do not start a runtime or session model transition", async () => {
		const { output, runtime, session } = createRuntime();
		session.modelRegistry.getApiKey = async () => undefined;
		const stageSpy = spyOn(session, "setModelForSettingsCommit");

		await expect(executeAcpBuiltinSlashCommand("/model claude-3-5-sonnet:low", runtime)).resolves.toEqual({
			consumed: true,
		});

		expect(stageSpy).not.toHaveBeenCalled();
		expect(session.model).toBeUndefined();
		expect(session.getSessionDefaultModelSelector()).toBeUndefined();
		expect(output.some(line => line.includes("No API key for anthropic/claude-3-5-sonnet"))).toBe(true);
	});

	test("does not report a persisted assignment when the config write fails", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-slash-durable-model-"));
		resetSettingsForTest();
		try {
			const settings = await Settings.init({ agentDir: tempDir, cwd: tempDir });
			settings.setAgentModelOverride("executor", "anthropic/original");
			await settings.flushOrThrow();
			const usageOrderBefore = settings.getStorage()?.getModelUsageOrder() ?? [];
			const { output, runtime, session, setActiveModelProfile, setSessionDefaultModelSelector } =
				createRuntime(settings);
			setActiveModelProfile("profile-a");
			session.model = { provider: "anthropic", id: "original-model" };
			setSessionDefaultModelSelector("anthropic/resume-original");
			const configPath = path.join(fs.realpathSync.native(tempDir), "config.yml");
			const originalWrite = Bun.write;
			const writeSpy = spyOn(Bun, "write").mockImplementation((async (...args: unknown[]) => {
				if (
					typeof args[0] === "string" &&
					args[0].startsWith(`${configPath}.`) &&
					args[0].endsWith(".tmp") &&
					!args[0].startsWith(`${configPath}.revisions.json.`)
				) {
					throw new Error("forced config write failure");
				}
				return (originalWrite as (...writeArgs: unknown[]) => Promise<number>)(...args);
			}) as typeof Bun.write);
			try {
				await expect(
					executeAcpBuiltinSlashCommand("/model assign all-targets claude-3-5-sonnet:low", runtime),
				).resolves.toEqual({ consumed: true });
			} finally {
				writeSpy.mockRestore();
			}

			expect(output.some(line => line.includes("Failed to set model: forced config write failure"))).toBe(true);
			expect(output.some(line => line.startsWith("All model targets set to"))).toBe(false);
			expect(settings.get("task.agentModelOverrides").executor).toBe("anthropic/original");
			await settings.flushOrThrow();
			expect(session.getActiveModelProfile()).toBe("profile-a");
			expect(session.model?.id).toBe("original-model");
			expect(session.getSessionDefaultModelSelector()).toBe("anthropic/resume-original");
			expect(settings.getStorage()?.getModelUsageOrder() ?? []).toEqual(usageOrderBefore);

			resetSettingsForTest();
			const reopened = await Settings.init({ agentDir: tempDir, cwd: tempDir });
			expect(reopened.get("task.agentModelOverrides").executor).toBe("anthropic/original");
		} finally {
			resetSettingsForTest();
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
	test("reports a session follow-up failure without rolling back committed settings", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-slash-postcommit-model-"));
		resetSettingsForTest();
		try {
			const settings = await Settings.init({ agentDir: tempDir, cwd: tempDir });
			const { output, runtime, session } = createRuntime(settings);
			session.commitSettingsModelChange = async () => {
				throw new Error("forced session history failure");
			};

			await expect(executeAcpBuiltinSlashCommand("/model claude-3-5-sonnet:low", runtime)).resolves.toEqual({
				consumed: true,
			});

			expect(
				output.some(line => line.includes("Model settings were committed, but a session follow-up failed")),
			).toBe(true);
			expect(output.some(line => line.startsWith("Failed to set model:"))).toBe(false);
			expect(settings.getModelRole("default")).toBe("anthropic/claude-3-5-sonnet:low");

			resetSettingsForTest();
			const reopened = await Settings.init({ agentDir: tempDir, cwd: tempDir });
			expect(reopened.getModelRole("default")).toBe("anthropic/claude-3-5-sonnet:low");
		} finally {
			resetSettingsForTest();
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
	test("reports MRU failure as post-commit without rolling back role settings", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-slash-postcommit-mru-"));
		resetSettingsForTest();
		try {
			const settings = await Settings.init({ agentDir: tempDir, cwd: tempDir });
			const storage = settings.getStorage();
			if (!storage) throw new Error("Expected durable settings storage");
			const originalRecordModelUsage = storage.recordModelUsage.bind(storage);
			const recordSpy = spyOn(storage, "recordModelUsage").mockImplementation(selector => {
				originalRecordModelUsage(selector);
				throw new Error("forced MRU failure");
			});
			const { output, runtime } = createRuntime(settings);
			try {
				await expect(
					executeAcpBuiltinSlashCommand("/model assign executor claude-3-5-sonnet:low", runtime),
				).resolves.toEqual({ consumed: true });
			} finally {
				recordSpy.mockRestore();
			}

			expect(
				output.some(line => line.includes("Model settings were committed, but a session follow-up failed")),
			).toBe(true);
			expect(settings.get("task.agentModelOverrides").executor).toBe("anthropic/claude-3-5-sonnet:low");
			expect(storage.getModelUsageOrder()[0]).toBe("anthropic/claude-3-5-sonnet");

			resetSettingsForTest();
			const reopened = await Settings.init({ agentDir: tempDir, cwd: tempDir });
			expect(reopened.get("task.agentModelOverrides").executor).toBe("anthropic/claude-3-5-sonnet:low");
		} finally {
			resetSettingsForTest();
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
	test("uses independent TUI error reporting when committed status output fails", async () => {
		const { runtime, session, settings } = createRuntime();
		const errors: string[] = [];
		const command = lookupBuiltinSlashCommand("model");
		if (!command?.handleTui) throw new Error("Expected TUI model command");
		const ctx = {
			session,
			sessionManager: runtime.sessionManager,
			settings,
			showStatus: () => {
				throw new Error("forced status output failure");
			},
			showError: (message: string) => errors.push(message),
			statusLine: { invalidate: () => {} },
			updateEditorBorderColor: () => {},
			ui: { requestRender: () => {} },
			editor: { setText: () => {} },
			refreshSlashCommandState: async () => {},
			notifyConfigChanged: () => {},
		};

		await expect(
			command.handleTui({ name: "model", args: "claude-3-5-sonnet:low", text: "/model claude-3-5-sonnet:low" }, {
				ctx,
			} as never),
		).resolves.toEqual({ consumed: true });

		expect(settings.getModelRole("default")).toBe("anthropic/claude-3-5-sonnet:low");
		expect(errors.some(message => message.includes("Model settings were committed"))).toBe(true);
		expect(errors.some(message => message.includes("Reporting that committed state also failed"))).toBe(true);
	});
	test("leaves an initially unselected runtime untouched after a config failure", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-slash-empty-model-"));
		resetSettingsForTest();
		try {
			const settings = await Settings.init({ agentDir: tempDir, cwd: tempDir });
			settings.setModelRole("default", "anthropic/original-default");
			await settings.flushOrThrow();
			const { output, runtime, session } = createRuntime(settings);
			expect(session.model).toBeUndefined();

			const configPath = path.join(fs.realpathSync.native(tempDir), "config.yml");
			const originalWrite = Bun.write;
			const writeSpy = spyOn(Bun, "write").mockImplementation((async (...args: unknown[]) => {
				if (
					typeof args[0] === "string" &&
					args[0].startsWith(`${configPath}.`) &&
					args[0].endsWith(".tmp") &&
					!args[0].startsWith(`${configPath}.revisions.json.`)
				) {
					throw new Error("forced empty-model config failure");
				}
				return (originalWrite as (...writeArgs: unknown[]) => Promise<number>)(...args);
			}) as typeof Bun.write);
			try {
				await expect(executeAcpBuiltinSlashCommand("/model claude-3-5-sonnet:low", runtime)).resolves.toEqual({
					consumed: true,
				});
			} finally {
				writeSpy.mockRestore();
			}

			expect(output.some(line => line.includes("Failed to set model: forced empty-model config failure"))).toBe(
				true,
			);
			expect(session.model).toBeUndefined();
			expect(session.thinkingLevel).toBeUndefined();
			expect(session.getSessionDefaultModelSelector()).toBeUndefined();
			expect(settings.getModelRole("default")).toBe("anthropic/original-default");
			await settings.flushOrThrow();

			resetSettingsForTest();
			const reopened = await Settings.init({ agentDir: tempDir, cwd: tempDir });
			expect(reopened.getModelRole("default")).toBe("anthropic/original-default");
		} finally {
			resetSettingsForTest();
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
	test("nonsettling notifications do not block a committed assignment", async () => {
		const { runtime, settings } = createRuntime();
		const never = Promise.withResolvers<void>();
		runtime.notifyTitleChanged = () => never.promise;
		runtime.notifyConfigChanged = () => never.promise;

		const completed = await Promise.race([
			executeAcpBuiltinSlashCommand("/model claude-3-5-sonnet:low", runtime),
			Bun.sleep(100).then(() => "timeout" as const),
		]);

		expect(completed).toEqual({ consumed: true });
		expect(settings.getModelRole("default")).toBe("anthropic/claude-3-5-sonnet:low");
	});
});

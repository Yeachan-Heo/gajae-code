import { describe, expect, it, spyOn } from "bun:test";
import type { AgentMessage } from "@gajae-code/agent-core";
import { Settings } from "../src/config/settings";
import { getThemeByName, setThemeInstance, theme } from "../src/modes/theme/theme";
import type { AgentSession } from "../src/session/agent-session";
import type { SessionManager } from "../src/session/session-manager";
import { ACP_BUILTIN_SLASH_COMMANDS, executeAcpBuiltinSlashCommand } from "../src/slash-commands/acp-builtins";
import * as sshConfig from "../src/ssh/config-writer";

interface FakeAcpBuiltinSession {
	fastMode: boolean;
	forcedToolChoice: string | undefined;
	isStreaming: boolean;
	sessionFile: string | undefined;
	sessionId: string;
	sessionName: string;
	_todoPhases: Array<{ name: string; tasks: Array<{ content: string; status: string }> }>;
	toggleFastMode(): boolean;
	setFastMode(enabled: boolean): void;
	isFastModeEnabled(): boolean;
	isFastForProvider(provider?: string): boolean;
	isFastForSubagentProvider(provider?: string): boolean;
	resolveRoleModelWithThinking(role: string): { model?: { provider: string; id: string } };
	setForcedToolChoice(toolName: string): void;
	fetchUsageReports?: () => Promise<unknown>;
	getAsyncJobSnapshot: (opts?: { recentLimit?: number }) => { running: unknown[]; recent: unknown[] } | null;
	formatSessionAsText: () => string;
	getLastAssistantText: () => string | undefined;
	messages: unknown[];
	modelRegistry: {
		getApiKey(model: { provider: string; id: string }, sessionId?: string): Promise<string | undefined>;
		resolveCanonicalModel?: (
			canonicalId: string,
			options?: { candidates?: Array<{ provider: string; id: string; contextWindow?: number }> },
		) => { provider: string; id: string; contextWindow?: number } | undefined;
	};
	model: { provider: string; id: string; contextWindow?: number } | undefined;
	agent: {
		state: {
			tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
		};
	};
	settings: Settings;
	systemPrompt: string[];
	skills: Array<{ name: string; description: string }>;
	newSession(opts?: { drop?: boolean; parentSession?: string }): Promise<boolean>;
	fork(): Promise<boolean>;
	handoff(instr?: string): Promise<{ document: string; savedPath?: string } | undefined>;
	exportToHtml(outputPath?: string): Promise<string>;
	getTodoPhases(): Array<{ name: string; tasks: Array<{ content: string; status: string }> }>;
	setTodoPhases(phases: Array<{ name: string; tasks: Array<{ content: string; status: string }> }>): void;
	refreshBaseSystemPrompt(): Promise<void>;
	refreshSshTool(options?: { activateIfAvailable?: boolean }): Promise<void>;
	getToolByName(name: string): unknown;
	compact(args?: string): Promise<void>;
	getContextUsage(): { tokens?: number; contextWindow: number } | undefined;
	getAvailableModels(): Array<{ provider: string; id: string; contextWindow?: number }>;
	setModel(model: unknown): Promise<void>;
	setThinkingLevel(thinkingLevel: unknown): void;
}

function createRuntime() {
	const output: string[] = [];
	const settings = Settings.isolated();
	const session: FakeAcpBuiltinSession = {
		fastMode: false,
		forcedToolChoice: undefined as string | undefined,
		isStreaming: false,
		sessionFile: undefined,
		sessionId: "fake-session-id",
		sessionName: "Fake Session",
		_todoPhases: [],
		toggleFastMode() {
			this.fastMode = !this.fastMode;
			return this.fastMode;
		},
		setFastMode(enabled: boolean) {
			this.fastMode = enabled;
		},
		isFastModeEnabled() {
			return this.fastMode;
		},
		isFastForProvider(_provider?: string) {
			return false;
		},
		isFastForSubagentProvider(_provider?: string) {
			return false;
		},
		resolveRoleModelWithThinking(_role: string): { model?: { provider: string; id: string } } {
			return { model: undefined };
		},
		setForcedToolChoice(toolName: string) {
			this.forcedToolChoice = toolName;
		},
		async newSession(_opts?: { drop?: boolean; parentSession?: string }) {
			return true;
		},
		async fork() {
			return true;
		},
		async handoff(_instr?: string) {
			return undefined;
		},
		async exportToHtml(outputPath?: string) {
			return outputPath ?? "/tmp/exported-session.html";
		},
		getTodoPhases() {
			return this._todoPhases;
		},
		setTodoPhases(phases) {
			this._todoPhases = phases;
		},
		async refreshBaseSystemPrompt() {},
		getAsyncJobSnapshot: () => null,
		formatSessionAsText: () => "",
		getLastAssistantText: () => undefined,
		messages: [],
		modelRegistry: {
			async getApiKey(_model: { provider: string; id: string }, _sessionId?: string) {
				return "test-api-key";
			},
		},
		model: undefined,
		agent: { state: { tools: [] } },
		settings,
		systemPrompt: [],
		skills: [],
		getToolByName: (_name: string) => undefined,
		async compact(_args?: string) {},
		getContextUsage: () => undefined,
		getAvailableModels: () => [] as Array<{ provider: string; id: string; contextWindow?: number }>,
		async setModel(_model: unknown) {},
		setThinkingLevel(_thinkingLevel: unknown) {},
		async refreshSshTool(_options?: { activateIfAvailable?: boolean }) {},
	};
	const typedSession = session as unknown as AgentSession & FakeAcpBuiltinSession;
	const fakeSessionManager = {
		_sessionFile: undefined as string | undefined,
		_cwd: "/tmp/project",
		_entries: [] as { type: string }[],
		_customEntries: [] as Array<{ customType: string; data: unknown }>,
		_movedTo: undefined as string | undefined,
		_flushed: false,
		_sessionName: undefined as string | undefined,
		getSessionId(): string {
			return "fake-session-id";
		},
		getSessionFile(): string | undefined {
			return this._sessionFile;
		},
		getEntries(): { type: string }[] {
			return this._entries;
		},
		getBranch(): { type: string }[] {
			return this._entries;
		},
		appendCustomEntry(customType: string, data?: unknown): string {
			this._customEntries.push({ customType, data });
			return "fake-entry-id";
		},
		async flush() {
			this._flushed = true;
		},
		async moveTo(newCwd: string) {
			this._cwd = newCwd;
			this._movedTo = newCwd;
		},
		getCwd(): string {
			return this._cwd;
		},
		buildSessionContext() {
			return {
				messages: [] as AgentMessage[],
				thinkingLevel: "off",
				models: {},
				injectedTtsrRules: [],
				selectedMCPToolNames: [],
				hasPersistedMCPToolSelection: false,
				mode: "none",
			};
		},
		getUsageStatistics() {
			return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, premiumRequests: 0, cost: 0 };
		},
		async setSessionName(name: string, _source: string): Promise<boolean> {
			this._sessionName = name;
			return true;
		},
	};
	return {
		output,
		session,
		fakeSessionManager,
		runtime: {
			session: typedSession,
			sessionManager: fakeSessionManager as unknown as SessionManager,
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

describe("ACP builtin slash commands", () => {
	it("consumes fast status without returning prompt text", async () => {
		const installed = await getThemeByName("red-claw");
		if (!installed) throw new Error("Failed to load theme for fast status test");
		setThemeInstance(installed);
		const { output, runtime } = createRuntime();

		const result = await executeAcpBuiltinSlashCommand("/fast status", runtime);

		expect(result).toEqual({ consumed: true });
		// No model selected and no roles assigned -> multiline report, active row off.
		expect(output).toHaveLength(1);
		expect(output[0]).toContain("Fast 모드 상태");
		expect(output[0]).toContain("현재 모델: off");
		expect(output[0]).not.toContain("Fast mode is");
	});

	it("renders a provider-aware multiline fast status report and never calls isFastModeEnabled", async () => {
		const installed = await getThemeByName("red-claw");
		if (!installed) throw new Error("Failed to load theme for fast status test");
		setThemeInstance(installed);
		const { output, runtime } = createRuntime();
		const session = runtime.session as unknown as {
			model: { provider: string; id: string } | undefined;
			isFastForProvider: (provider?: string) => boolean;
			isFastForSubagentProvider: (provider?: string) => boolean;
			resolveRoleModelWithThinking: (role: string) => { model?: { provider: string; id: string } };
			isFastModeEnabled: () => boolean;
		};
		session.model = { provider: "anthropic", id: "claude-sonnet-4-5" };
		session.isFastForProvider = provider => provider === "anthropic";
		// Subagent roles run under task.serviceTier; here it grants no fast mode, so
		// the EXECUTOR row must be off even though its anthropic model would be fast
		// under the main session tier.
		session.isFastForSubagentProvider = () => false;
		session.resolveRoleModelWithThinking = role =>
			role === "executor" ? { model: { provider: "anthropic", id: "claude-opus-4-1" } } : { model: undefined };
		// The status branch must use the provider-aware predicate, never this.
		session.isFastModeEnabled = () => {
			throw new Error("/fast status must not call isFastModeEnabled");
		};

		const result = await executeAcpBuiltinSlashCommand("/fast status", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain(`현재 모델: anthropic/claude-sonnet-4-5 ${theme.icon.fast}`);
		// Subagent role uses the subagent tier -> off despite the anthropic model.
		expect(output[0]).toContain("EXECUTOR: anthropic/claude-opus-4-1 off");
		expect(output[0]).not.toContain(`EXECUTOR: anthropic/claude-opus-4-1 ${theme.icon.fast}`);
		expect(output[0]).not.toContain("Fast mode is");
	});
	it("keeps /fast on/off/toggle output and state changes unchanged", async () => {
		const { output, runtime } = createRuntime();

		await expect(executeAcpBuiltinSlashCommand("/fast on", runtime)).resolves.toEqual({ consumed: true });
		expect(runtime.session.fastMode).toBe(true);
		expect(output).toEqual(["Fast mode enabled."]);

		output.length = 0;
		await expect(executeAcpBuiltinSlashCommand("/fast off", runtime)).resolves.toEqual({ consumed: true });
		expect(runtime.session.fastMode).toBe(false);
		expect(output).toEqual(["Fast mode disabled."]);

		output.length = 0;
		await expect(executeAcpBuiltinSlashCommand("/fast toggle", runtime)).resolves.toEqual({ consumed: true });
		expect(runtime.session.fastMode).toBe(true);
		expect(output).toEqual(["Fast mode enabled."]);
	});

	it("renders provider usage reports when the session can fetch them", async () => {
		const { output, runtime } = createRuntime();
		runtime.session.fetchUsageReports = async () => [
			{
				provider: "openai-codex",
				fetchedAt: Date.now(),
				limits: [
					{
						id: "codex-5h",
						label: "5 hours",
						scope: { provider: "openai-codex", tier: "prolite", accountId: "account-1" },
						window: { id: "5h", label: "5 hours", resetsAt: Date.now() + 60 * 60 * 1000 },
						amount: { used: 0.24, usedFraction: 0.24, unit: "unknown" },
					},
				],
				metadata: { email: "user@example.com" },
			},
		];

		const result = await executeAcpBuiltinSlashCommand("/usage", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Openai Codex");
		expect(output[0]).toContain("5 hours (prolite)");
		expect(output[0]).toContain("user@example.com: 0.24 unknown used (76.0% left)");
		expect(output[0]).toContain("resets in");
	});

	it("returns false for unknown commands", async () => {
		const { runtime } = createRuntime();

		const result = await executeAcpBuiltinSlashCommand("/not-a-real-command-xyz", runtime);

		expect(result).toBe(false);
	});

	// /jobs
	it("jobs: shows informative message when snapshot is null", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/jobs", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("background jobs");
	});

	it("jobs: lists running and recent jobs from snapshot", async () => {
		const { output, runtime } = createRuntime();
		runtime.session.getAsyncJobSnapshot = () => ({
			running: [{ id: "j1", type: "bash", status: "running", label: "npm install", startTime: Date.now() - 5000 }],
			recent: [{ id: "j2", type: "task", status: "completed", label: "build done", startTime: Date.now() - 60_000 }],
			delivery: { queued: 0, delivering: false, pendingJobIds: [], deadLettered: 0 },
		});

		const result = await executeAcpBuiltinSlashCommand("/jobs", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("npm install");
		expect(output[0]).toContain("build done");
		expect(output[0]).toContain("Running Jobs");
		expect(output[0]).toContain("Recent Jobs");
	});

	// /dump
	it("dump: outputs transcript when present", async () => {
		const { output, runtime } = createRuntime();
		runtime.session.formatSessionAsText = () => "Session content here";

		const result = await executeAcpBuiltinSlashCommand("/dump", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toBe("Session content here");
	});

	it("dump: outputs empty-state message when no messages", async () => {
		const { output, runtime } = createRuntime();

		const result = await executeAcpBuiltinSlashCommand("/dump", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("No messages");
	});

	// /model
	it("model: returns current model when set", async () => {
		const { output, runtime } = createRuntime();
		runtime.session.model = { provider: "anthropic", id: "claude-opus-4-5" } as never;

		const result = await executeAcpBuiltinSlashCommand("/model", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("anthropic/claude-opus-4-5");
	});

	it("model: returns no-selection message when undefined", async () => {
		const { output, runtime } = createRuntime();

		const result = await executeAcpBuiltinSlashCommand("/model", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("No model");
	});

	it("model: reports only default plus GJC role-agent assignment targets", async () => {
		const { output, runtime } = createRuntime();
		runtime.settings = Settings.isolated({
			cycleOrder: ["smol", "task", "default"],
			modelRoles: {
				default: "anthropic/default-model:medium",
				smol: "anthropic/legacy-smol",
				task: "anthropic/legacy-task",
			},
			"task.agentModelOverrides": {
				executor: "anthropic/executor-model:low",
			},
			modelTags: {
				smol: { name: "Quick", color: "error" },
			},
		});

		const result = await executeAcpBuiltinSlashCommand("/model", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("DEFAULT (Default): anthropic/default-model:medium");
		expect(output[0]).toContain("EXECUTOR (Executor): anthropic/executor-model:low");
		expect(output[0]).toContain("ARCHITECT (Architect): (unset)");
		expect(output[0]).toContain("PLANNER (Planner): (unset)");
		expect(output[0]).toContain("CRITIC (Critic): (unset)");
		expect(output[0]).not.toContain("SMOL");
		expect(output[0]).not.toContain("TASK");
		expect(output[0]).not.toContain("anthropic/legacy-smol");
		expect(output[0]).not.toContain("anthropic/legacy-task");
		expect(output[0]).not.toContain("Quick");
	});

	it("model: returns ACP usage message when args provided", async () => {
		const { output, runtime } = createRuntime();

		const result = await executeAcpBuiltinSlashCommand("/model claude-3-5-sonnet", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]?.toLowerCase()).toContain("acp");
	});

	it("model: applies known id and emits both title + config change notifications", async () => {
		const { output, runtime, session } = createRuntime();
		const available = [{ provider: "anthropic", id: "claude-3-5-sonnet", contextWindow: 200_000 }];
		session.getAvailableModels = () => available;
		let titleNotified = 0;
		let configNotified = 0;
		runtime.notifyTitleChanged = () => {
			titleNotified++;
		};
		runtime.notifyConfigChanged = () => {
			configNotified++;
		};
		const setModelSpy = spyOn(session, "setModel").mockResolvedValue(undefined);

		const result = await executeAcpBuiltinSlashCommand("/model claude-3-5-sonnet", runtime);

		expect(result).toEqual({ consumed: true });
		expect(setModelSpy).toHaveBeenCalledWith(available[0], "default", {
			selector: "anthropic/claude-3-5-sonnet",
			thinkingLevel: undefined,
		});
		expect(output[0]).toContain("Default model set to anthropic/claude-3-5-sonnet");
		expect(titleNotified).toBe(1);
		expect(configNotified).toBe(1);
	});

	it("model: applies explicit thinking level to the live default session", async () => {
		const { runtime, session } = createRuntime();
		const available = [{ provider: "anthropic", id: "claude-3-5-sonnet", contextWindow: 200_000 }];
		session.getAvailableModels = () => available;
		const setModelSpy = spyOn(session, "setModel").mockResolvedValue(undefined);
		const setThinkingLevelSpy = spyOn(session, "setThinkingLevel");

		const result = await executeAcpBuiltinSlashCommand("/model anthropic/claude-3-5-sonnet:low", runtime);

		expect(result).toEqual({ consumed: true });
		expect(setModelSpy).toHaveBeenCalledWith(available[0], "default", {
			selector: "anthropic/claude-3-5-sonnet",
			thinkingLevel: "low",
		});
		expect(setThinkingLevelSpy).toHaveBeenCalledWith("low");
	});

	it("model: applies explicit thinking level from a bare model id", async () => {
		const { output, runtime, session } = createRuntime();
		const available = [{ provider: "anthropic", id: "claude-3-5-sonnet", contextWindow: 200_000 }];
		session.getAvailableModels = () => available;
		const setModelSpy = spyOn(session, "setModel").mockResolvedValue(undefined);
		const setThinkingLevelSpy = spyOn(session, "setThinkingLevel");

		const result = await executeAcpBuiltinSlashCommand("/model claude-3-5-sonnet:low", runtime);

		expect(result).toEqual({ consumed: true });
		expect(setModelSpy).toHaveBeenCalledWith(available[0], "default", {
			selector: "anthropic/claude-3-5-sonnet",
			thinkingLevel: "low",
		});
		expect(setThinkingLevelSpy).toHaveBeenCalledWith("low");
		expect(output[0]).toContain("Default model set to anthropic/claude-3-5-sonnet:low");
	});

	it("model: assigns a known model to a GJC role-agent target without switching active model", async () => {
		const { output, runtime, session } = createRuntime();
		session.getAvailableModels = () => [{ provider: "anthropic", id: "claude-3-5-sonnet", contextWindow: 200_000 }];
		const setModelSpy = spyOn(session, "setModel").mockResolvedValue(undefined);
		let titleNotified = 0;
		let configNotified = 0;
		runtime.notifyTitleChanged = () => {
			titleNotified++;
		};
		runtime.notifyConfigChanged = () => {
			configNotified++;
		};

		const result = await executeAcpBuiltinSlashCommand("/model executor anthropic/claude-3-5-sonnet:low", runtime);

		expect(result).toEqual({ consumed: true });
		expect(setModelSpy).not.toHaveBeenCalled();
		expect(runtime.settings.get("task.agentModelOverrides")).toEqual({
			executor: "anthropic/claude-3-5-sonnet:low",
		});
		expect(output[0]).toContain("executor agent model set to anthropic/claude-3-5-sonnet:low");
		expect(titleNotified).toBe(0);
		expect(configNotified).toBe(1);
	});

	it("model: preserves existing role-agent thinking when text assignment omits one", async () => {
		const { output, runtime, session } = createRuntime();
		session.getAvailableModels = () => [{ provider: "anthropic", id: "claude-3-5-sonnet", contextWindow: 200_000 }];
		runtime.settings.set("task.agentModelOverrides", {
			executor: "anthropic/old-model:high",
		});

		const result = await executeAcpBuiltinSlashCommand("/model executor claude-3-5-sonnet", runtime);

		expect(result).toEqual({ consumed: true });
		expect(runtime.settings.get("task.agentModelOverrides")).toEqual({
			executor: "anthropic/claude-3-5-sonnet:high",
		});
		expect(output[0]).toContain("executor agent model set to anthropic/claude-3-5-sonnet:high");
	});

	it("model: lets explicit role-agent thinking override preserved thinking", async () => {
		const { runtime, session } = createRuntime();
		session.getAvailableModels = () => [{ provider: "anthropic", id: "claude-3-5-sonnet", contextWindow: 200_000 }];
		runtime.settings.set("task.agentModelOverrides", {
			executor: "anthropic/old-model:high",
		});

		const result = await executeAcpBuiltinSlashCommand("/model executor claude-3-5-sonnet:low", runtime);

		expect(result).toEqual({ consumed: true });
		expect(runtime.settings.get("task.agentModelOverrides")).toEqual({
			executor: "anthropic/claude-3-5-sonnet:low",
		});
	});

	it("model: preserves canonical selectors for text role-agent assignments", async () => {
		const { output, runtime, session } = createRuntime();
		const available = [{ provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200_000 }];
		session.getAvailableModels = () => available;
		session.modelRegistry.resolveCanonicalModel = (canonicalId, options) =>
			canonicalId === "claude-sonnet" ? options?.candidates?.[0] : undefined;

		const result = await executeAcpBuiltinSlashCommand("/model executor claude-sonnet:low", runtime);

		expect(result).toEqual({ consumed: true });
		expect(runtime.settings.get("task.agentModelOverrides")).toEqual({
			executor: "claude-sonnet:low",
		});
		expect(output[0]).toContain("executor agent model set to claude-sonnet:low");
	});

	it("model: does not emit config change when id is unknown", async () => {
		const { runtime } = createRuntime();
		let configNotified = 0;
		runtime.notifyConfigChanged = () => {
			configNotified++;
		};

		await executeAcpBuiltinSlashCommand("/model nonexistent", runtime);

		expect(configNotified).toBe(0);
	});
	it("does not advertise /copy to ACP clients", () => {
		expect(ACP_BUILTIN_SLASH_COMMANDS.some(command => command.name === "copy")).toBe(false);
	});
	// TUI-only and dropped commands fall through as false
	it("TUI-only and dropped commands return false (fall through to model)", async () => {
		const fallthroughCommands = [
			"/login",
			"/logout",
			"/resume",
			"/tree",
			"/branch",
			"/browser",
			"/changelog",
			"/plan",
			"/share",
			"/hotkeys",
			"/extensions",
			"/agents",
			"/copy",
			"/todo",
			"/force read file.ts",
			"/quit",
			"/btw hi",
			"/new",
			"/drop",
			"/handoff",
			"/fork",
		];
		for (const cmd of fallthroughCommands) {
			const { runtime } = createRuntime();
			const result = await executeAcpBuiltinSlashCommand(cmd, runtime);
			expect(result).toBe(false);
		}
	});
});

describe("session lifecycle commands", () => {
	it("/session delete: returns in-memory usage when no sessionFile", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/session delete", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("in-memory");
	});

	it("/session delete: refuses while streaming", async () => {
		const { output, session, fakeSessionManager, runtime } = createRuntime();
		session.isStreaming = true;
		fakeSessionManager._sessionFile = "/tmp/session.jsonl";
		const result = await executeAcpBuiltinSlashCommand("/session delete", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("streaming");
	});

	it("/rename: renames and calls notifyTitleChanged on success", async () => {
		const { output, fakeSessionManager, runtime } = createRuntime();
		let notified = false;
		runtime.notifyTitleChanged = async () => {
			notified = true;
		};
		const result = await executeAcpBuiltinSlashCommand("/rename Project Apex", runtime);
		expect(result).toEqual({ consumed: true });
		expect(fakeSessionManager._sessionName).toBe("Project Apex");
		expect(output[0]).toBe("Session renamed to Project Apex.");
		expect(notified).toBe(true);
	});

	it("/rename: outputs precedence message when setSessionName returns false", async () => {
		const { output, fakeSessionManager, runtime } = createRuntime();
		let notified = false;
		runtime.notifyTitleChanged = async () => {
			notified = true;
		};
		fakeSessionManager.setSessionName = async () => false;
		const result = await executeAcpBuiltinSlashCommand("/rename Bar", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("takes precedence");
		expect(notified).toBe(false);
	});

	it("/move: reports moved path via sessionManager.getCwd() and calls notifyTitleChanged", async () => {
		const { output, fakeSessionManager, runtime } = createRuntime();
		let notified = false;
		runtime.notifyTitleChanged = async () => {
			notified = true;
		};
		const result = await executeAcpBuiltinSlashCommand("/move /tmp", runtime);
		expect(result).toEqual({ consumed: true });
		expect(fakeSessionManager._flushed).toBe(true);
		expect(fakeSessionManager._movedTo).toBe("/tmp");
		expect(output[0]).toContain("/tmp");
		expect(notified).toBe(true);
	});

	it("/move: refuses while streaming", async () => {
		const { output, session, runtime } = createRuntime();
		session.isStreaming = true;
		const result = await executeAcpBuiltinSlashCommand("/move /tmp", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("streaming");
	});
});

describe("wave 3 commands", () => {
	// /export
	it("/export: calls exportToHtml with the given arg and outputs the path", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/export /tmp/out.html", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toBe("Session exported to: /tmp/out.html");
	});

	it("/export: uses default path when no arg given", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/export", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Session exported to:");
	});

	it("/export: returns usage on exportToHtml failure", async () => {
		const { output, session, runtime } = createRuntime();
		session.exportToHtml = async () => {
			throw new Error("disk full");
		};
		const result = await executeAcpBuiltinSlashCommand("/export", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Failed to export session: disk full");
	});

	// /move
	it("/move: returns usage when no arg", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/move", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Usage: /move");
	});

	it("/move: returns usage when path does not exist", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/move /no/such/path/xyz", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("does not exist");
	});

	// /memory
	it("/memory unknown: returns usage message", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/memory unknownverb", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Usage: /memory");
	});

	it("/memory view: outputs memory payload (or empty message)", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/memory view", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output.length).toBeGreaterThan(0);
	});

	it("/memory view: local empty payload is explicit and not success-coded", async () => {
		const { output, runtime } = createRuntime();
		runtime.settings.set("memory.backend", "local");

		const result = await executeAcpBuiltinSlashCommand("/memory view", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("no confirmed memory payload");
		expect(output[0]).toContain("Do not claim");
		expect(output[0]).toContain("unless a backend operation or a non-empty memory payload confirms it");
		expect(output[0]).toContain("not confirmed");
	});

	it("/memory (no args): defaults to view", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/memory", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output.length).toBeGreaterThan(0);
	});

	// /compact
	it("/compact: reports Compaction complete. after session.compact resolves", async () => {
		const { output, session, runtime } = createRuntime();
		let compactCalled = false;
		session.compact = async (_args?: string) => {
			compactCalled = true;
		};
		const result = await executeAcpBuiltinSlashCommand("/compact", runtime);
		expect(result).toEqual({ consumed: true });
		expect(compactCalled).toBe(true);
		expect(output[0]).toContain("Compaction complete.");
	});
});

describe("wave 4 commands", () => {
	// /mcp is intentionally not an ACP builtin in gajae-code. MCP-compatible
	// helpers may remain private, but the default user-facing ACP command surface
	// must fall through instead of advertising or handling /mcp.
	it("/mcp commands fall through to the model for MCP quarantine", async () => {
		const commands = ["/mcp", "/mcp help", "/mcp add", "/mcp reload", "/mcp resources", "/mcp frobnicate"];
		for (const command of commands) {
			const { output, runtime } = createRuntime();
			let refreshCalled = false;
			runtime.refreshCommands = () => {
				refreshCalled = true;
			};
			const result = await executeAcpBuiltinSlashCommand(command, runtime);
			expect(result).toBe(false);
			expect(output).toEqual([]);
			expect(refreshCalled).toBe(false);
		}
	});

	it("/ssh commands remain preserved in ACP", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/ssh", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("list");
		expect(output[0]).toContain("remove");
	});

	it("removed plugin and marketplace commands fall through", async () => {
		const { output, runtime } = createRuntime();

		for (const command of ["/marketplace help", "/marketplace install", "/plugins list", "/reload-plugins"]) {
			const result = await executeAcpBuiltinSlashCommand(command, runtime);
			expect(result).toBe(false);
		}
		expect(output).toEqual([]);
	});
});

describe("wave 5 — adapters and polish", () => {
	// /mcp add stays quarantined from ACP and must not write config through the
	// private MCP helper when submitted as text-mode slash input.
	it("/mcp add falls through without writing MCP config", async () => {
		const mcpModule = await import("../src/runtime-mcp/config-writer");
		const spy = spyOn(mcpModule, "addMCPServer").mockResolvedValue(undefined);
		try {
			const { output, runtime } = createRuntime();
			const result = await executeAcpBuiltinSlashCommand(
				"/mcp add foo --url https://example.com --token X --scope project",
				runtime,
			);
			expect(result).toBe(false);
			expect(output).toEqual([]);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it("/mcp test falls through without producing MCP-specific output", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/mcp test bogus", runtime);
		expect(result).toBe(false);
		expect(output).toEqual([]);
	});

	it("/ssh add remains preserved and calls addSSHHost", async () => {
		const spy = spyOn(sshConfig, "addSSHHost").mockResolvedValue(undefined);
		try {
			const { output, runtime } = createRuntime();
			const result = await executeAcpBuiltinSlashCommand("/ssh add foo --host x --user y --scope user", runtime);
			expect(result).toEqual({ consumed: true });
			expect(output[0]).toContain('Added SSH host "foo" (user).');
			expect(spy).toHaveBeenCalledTimes(1);
			const [configPath, name, hostConfig] = spy.mock.calls[0]!;
			expect(typeof configPath).toBe("string");
			expect(name).toBe("foo");
			expect(hostConfig).toMatchObject({ host: "x", username: "y" });
		} finally {
			spy.mockRestore();
		}
	});

	it("/ssh remove parses quoted host names", async () => {
		const spy = spyOn(sshConfig, "removeSSHHost").mockResolvedValue(undefined);
		try {
			const { output, runtime } = createRuntime();
			const result = await executeAcpBuiltinSlashCommand('/ssh remove "work vm" --scope user', runtime);
			expect(result).toEqual({ consumed: true });
			expect(output[0]).toContain('Removed SSH host "work vm" from user config.');
			expect(spy).toHaveBeenCalledTimes(1);
			const [configPath, name] = spy.mock.calls[0]!;
			expect(typeof configPath).toBe("string");
			expect(name).toBe("work vm");
		} finally {
			spy.mockRestore();
		}
	});

	// /model with unknown id
	it("/model gpt-fake-9000: returns unknown-model message", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/model gpt-fake-9000", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Unknown model");
	});

	// /model with known id (fake registry)
	it("/model known-id: reports model set and triggers notifyTitleChanged", async () => {
		const { output, session, runtime } = createRuntime();
		session.getAvailableModels = () => [{ provider: "anthropic", id: "claude-sonnet-test" }];
		let titleChanged = false;
		runtime.notifyTitleChanged = () => {
			titleChanged = true;
		};
		const result = await executeAcpBuiltinSlashCommand("/model claude-sonnet-test", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Default model set to anthropic/claude-sonnet-test.");
		expect(titleChanged).toBe(true);
	});

	// /usage bar character
	it("/usage: includes bar character when usedFraction is 0.5", async () => {
		const { output, runtime } = createRuntime();
		runtime.session.fetchUsageReports = async () => [
			{
				provider: "test-provider",
				fetchedAt: Date.now(),
				limits: [
					{
						id: "test-limit",
						label: "Monthly",
						scope: { provider: "test-provider", tier: "pro", accountId: "acct-1" },
						window: { id: "monthly", label: "monthly", resetsAt: Date.now() + 30 * 86400_000 },
						amount: { used: 50, usedFraction: 0.5, unit: "requests" },
					},
				],
				metadata: {},
			},
		];
		const result = await executeAcpBuiltinSlashCommand("/usage", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("█");
	});

	// /context breakdown
	it("/context: renders active context, history, and last provider usage", async () => {
		const { output, runtime, session, fakeSessionManager } = createRuntime();
		session.model = { provider: "openai", id: "gpt-test", contextWindow: 100_000 };
		session.systemPrompt = [
			[
				"<system>base instructions</system>",
				'<skills><skill name="sample">Skill description</skill></skills>',
				'<rules><rule name="repo">Repo rule</rule></rules>',
			].join("\n"),
			"<project>project context</project>",
		];
		session.skills = [{ name: "sample", description: "Skill description" }];
		session.agent.state.tools = [{ name: "read", description: "Read files", parameters: { type: "object" } }];
		const messages: AgentMessage[] = [
			{ role: "user", content: "older prompt", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "older answer" }],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-test",
				usage: {
					input: 1000,
					output: 200,
					cacheRead: 300,
					cacheWrite: 0,
					totalTokens: 1500,
					cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0, total: 0.0031 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
			{ role: "user", content: "what is the current context?", timestamp: 3 },
		];
		fakeSessionManager.buildSessionContext = () => ({
			messages,
			thinkingLevel: "off",
			models: {},
			injectedTtsrRules: [],
			selectedMCPToolNames: [],
			hasPersistedMCPToolSelection: false,
			mode: "none",
		});
		fakeSessionManager.getBranch = () => [
			{ type: "message", id: "1", parentId: null, timestamp: "t", message: messages[0] },
			{
				type: "compaction",
				id: "2",
				parentId: "1",
				timestamp: "t",
				summary: "summary",
				firstKeptEntryId: "1",
				tokensBefore: 42_000,
			},
			{ type: "message", id: "3", parentId: "2", timestamp: "t", message: messages[1] },
			{ type: "message", id: "4", parentId: "3", timestamp: "t", message: messages[2] },
		];

		const result = await executeAcpBuiltinSlashCommand("/context", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Context usage");
		expect(output[0]).toContain("Active context breakdown");
		expect(output[0]).toContain("Last user turn");
		expect(output[0]).toContain("Compacted history: summary active");
		expect(output[0]).toContain("Cost: $0.003100");
	});

	// /jobs empty state
	it("/jobs: empty-state output mentions background jobs definition", async () => {
		const { output, runtime } = createRuntime();
		// Return empty snapshot (running=[], recent=[])
		runtime.session.getAsyncJobSnapshot = () => ({
			running: [],
			recent: [],
			delivery: { queued: 0, delivering: false, pendingJobIds: [], deadLettered: 0 },
		});
		const result = await executeAcpBuiltinSlashCommand("/jobs", runtime);
		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("background jobs");
	});

	it("/marketplace discover falls through after marketplace slash deletion", async () => {
		const { output, runtime } = createRuntime();
		const result = await executeAcpBuiltinSlashCommand("/marketplace discover", runtime);
		expect(result).toBe(false);
		expect(output).toEqual([]);
	});
});

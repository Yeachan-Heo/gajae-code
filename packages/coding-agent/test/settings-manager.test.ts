import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@gajae-code/ai";
import {
	resetSettingsForTest,
	Settings,
	type SettingsMutationCheckpoint,
} from "@gajae-code/coding-agent/config/settings";
import { getCustomThemesDir, getProjectAgentDir, Snowflake } from "@gajae-code/utils";
import { YAML } from "bun";

describe("Settings", () => {
	let testDir: string;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		// Reset global singleton so each test gets a fresh instance
		resetSettingsForTest();

		// Use snowflake to isolate parallel test runs (SQLite files can't be shared)
		testDir = path.join(os.tmpdir(), "test-settings-tmp", Snowflake.next());
		agentDir = path.join(testDir, "agent");
		projectDir = path.join(testDir, "project");

		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true });
		}
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	const getConfigPath = () => path.join(fs.realpathSync.native(agentDir), "config.yml");
	const isConfigWritePath = (value: unknown): boolean =>
		typeof value === "string" &&
		value.startsWith(`${getConfigPath()}.`) &&
		value.endsWith(".tmp") &&
		!value.startsWith(`${getConfigPath()}.revisions.json.`);
	const isRevisionWritePath = (value: unknown): boolean =>
		typeof value === "string" && value.startsWith(`${getConfigPath()}.revisions.json.`) && value.endsWith(".tmp");

	const writeSettings = async (settings: Record<string, unknown>) => {
		await Bun.write(getConfigPath(), YAML.stringify(settings, null, 2));
	};

	const writeProjectSettings = async (settings: Record<string, unknown>) => {
		await Bun.write(path.join(getProjectAgentDir(projectDir), "config.yml"), YAML.stringify(settings, null, 2));
	};

	const readSettings = async (): Promise<Record<string, unknown>> => {
		const file = Bun.file(getConfigPath());
		if (!(await file.exists())) return {};
		const content = await file.text();
		const parsed = YAML.parse(content);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as Record<string, unknown>;
	};

	afterEach(() => {
		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true });
		}
	});

	const writeCustomTheme = async (name: string, userMessageBg: string) => {
		const themesDir = getCustomThemesDir(agentDir);
		fs.mkdirSync(themesDir, { recursive: true });
		await Bun.write(
			path.join(themesDir, `${name}.json`),
			JSON.stringify({ vars: { surface: userMessageBg }, colors: { userMessageBg: "surface" } }),
		);
	};

	// Tests that SettingsManager merges with DB state on save rather than blindly overwriting.
	// This ensures external edits (via AgentStorage directly) aren't lost when the app saves.
	describe("preserves externally added settings", () => {
		it("should preserve enabledModels when changing thinking level", async () => {
			// Seed initial settings in config.yml
			await writeSettings({
				theme: "dark",
				modelRoles: { default: "claude-sonnet" },
			});

			// Settings loads the initial state
			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// Simulate external edit (e.g., user modifying DB directly or another process)
			await writeSettings({
				theme: { dark: "custom-dark" },
				modelRoles: { default: "claude-sonnet" },
				enabledModels: ["claude-opus-4-5", "gpt-5.2-codex"],
			});

			// Settings saves a change - should merge, not overwrite
			settings.set("defaultThinkingLevel", Effort.High);
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.enabledModels).toEqual(["claude-opus-4-5", "gpt-5.2-codex"]);
			expect(savedSettings.defaultThinkingLevel).toBe(Effort.High);
			expect(savedSettings.theme).toEqual({ dark: "custom-dark" });
			expect((savedSettings.modelRoles as { default?: string } | undefined)?.default).toBe("claude-sonnet");
		});

		it("filters model allow-list and disabled providers by current path prefix", async () => {
			const workDir = path.join(projectDir, "work", "service");
			const privateDir = path.join(projectDir, "private", "app");
			fs.mkdirSync(workDir, { recursive: true });
			fs.mkdirSync(privateDir, { recursive: true });

			await writeSettings({
				enabledModels: [
					"claude-sonnet-4-5",
					{ path: path.join(projectDir, "work"), values: ["anthropic/claude-opus-4-5"] },
					{ path: path.join(projectDir, "private"), values: ["openai/gpt-5.2-codex"] },
				],
				disabledProviders: [
					"ollama",
					{ path: path.join(projectDir, "work"), values: ["openai"] },
					{ path: path.join(projectDir, "private"), values: ["anthropic"] },
				],
			});

			const workSettings = await Settings.init({ cwd: workDir, agentDir });
			expect(workSettings.get("enabledModels")).toEqual(["claude-sonnet-4-5", "anthropic/claude-opus-4-5"]);
			expect(workSettings.get("disabledProviders")).toEqual(["ollama", "openai"]);

			resetSettingsForTest();
			const privateSettings = await Settings.init({ cwd: privateDir, agentDir });
			expect(privateSettings.get("enabledModels")).toEqual(["claude-sonnet-4-5", "openai/gpt-5.2-codex"]);
			expect(privateSettings.get("disabledProviders")).toEqual(["ollama", "anthropic"]);
		});

		it("should preserve custom settings when changing theme", async () => {
			await writeSettings({
				modelRoles: { default: "claude-sonnet" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			await writeSettings({
				modelRoles: { default: "claude-sonnet" },
				shellPath: "/bin/zsh",
				extensions: ["/path/to/extension.ts"],
			});

			settings.set("theme.dark", "custom-dark");
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.shellPath).toBe("/bin/zsh");
			expect(savedSettings.extensions).toEqual(["/path/to/extension.ts"]);
			expect(savedSettings.theme).toEqual({ dark: "custom-dark" });
		});

		it("should let in-memory changes override file changes for same key", async () => {
			await writeSettings({
				theme: { dark: "custom-dark" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			await writeSettings({
				theme: { dark: "custom-dark" },
				defaultThinkingLevel: Effort.Low,
			});

			settings.set("defaultThinkingLevel", Effort.High);
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.defaultThinkingLevel).toBe(Effort.High);
		});
	});

	describe("model role overrides", () => {
		it("does not persist temporary default model overrides when another role is saved", async () => {
			await writeSettings({
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			settings.overrideModelRoles({ default: "openai/gpt-5.2-codex" });
			expect(settings.getModelRole("default")).toBe("openai/gpt-5.2-codex");

			settings.setModelRole("smol", "anthropic/claude-haiku-4-5");
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.modelRoles).toEqual({
				default: "anthropic/claude-sonnet-4-5",
				smol: "anthropic/claude-haiku-4-5",
			});
			expect(settings.getModelRole("default")).toBe("openai/gpt-5.2-codex");
			expect(settings.getModelRole("smol")).toBe("anthropic/claude-haiku-4-5");
		});

		it("restores persisted model roles after clearing runtime overrides", async () => {
			await writeSettings({
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			settings.overrideModelRoles({ default: "openai/gpt-5.2-codex" });
			expect(settings.getModelRole("default")).toBe("openai/gpt-5.2-codex");

			settings.clearOverride("modelRoles");

			expect(settings.getModelRole("default")).toBe("anthropic/claude-sonnet-4-5");
		});

		it("keeps the live role value aligned when saving over a runtime override", () => {
			const settings = Settings.isolated({
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			});

			settings.overrideModelRoles({ default: "openai/gpt-5.2-codex" });
			settings.setModelRole("default", "anthropic/claude-opus-4-5");

			expect(settings.getModelRole("default")).toBe("anthropic/claude-opus-4-5");

			settings.clearOverride("modelRoles");

			expect(settings.getModelRole("default")).toBe("anthropic/claude-opus-4-5");
		});

		it("keeps live agent model overrides aligned without persisting profile entries", () => {
			const settings = Settings.isolated();

			settings.set("task.agentModelOverrides", { executor: "persisted/executor" });
			settings.override("task.agentModelOverrides", {
				executor: "profile/executor",
				planner: "profile/planner",
			});

			settings.setAgentModelOverride("planner", "user/planner:high");

			expect(settings.get("task.agentModelOverrides")).toEqual({
				executor: "profile/executor",
				planner: "user/planner:high",
			});

			settings.clearOverride("task.agentModelOverrides");

			expect(settings.get("task.agentModelOverrides")).toEqual({
				executor: "persisted/executor",
				planner: "user/planner:high",
			});
		});

		it("lets explicit model assignments win over project settings for the live session", async () => {
			await writeSettings({
				modelRoles: { default: "global/default" },
				task: { agentModelOverrides: { executor: "global/executor" } },
			});
			await writeProjectSettings({
				modelRoles: { default: "project/default" },
				task: {
					agentModelOverrides: {
						executor: "project/executor",
						planner: "project/planner",
					},
				},
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.getProject("modelRoles")).toEqual({ default: "project/default" });
			expect(settings.getProject("task.agentModelOverrides")).toEqual({
				executor: "project/executor",
				planner: "project/planner",
			});

			expect(settings.getWithoutProject("modelRoles")).toEqual({ default: "global/default" });
			expect(settings.getWithoutProject("task.agentModelOverrides")).toEqual({
				executor: "global/executor",
			});

			settings.setModelRole("default", "user/default");
			settings.setAgentModelOverride("executor", "user/executor");

			expect(settings.getWithoutProject("modelRoles")).toEqual({ default: "user/default" });
			expect(settings.getWithoutProject("task.agentModelOverrides")).toEqual({
				executor: "user/executor",
			});

			expect(settings.getModelRole("default")).toBe("user/default");
			expect(settings.get("task.agentModelOverrides")).toEqual({
				executor: "user/executor",
				planner: "project/planner",
			});

			await settings.flush();
			const savedSettings = await readSettings();
			expect(savedSettings.modelRoles).toEqual({ default: "user/default" });
			expect(savedSettings.task).toEqual({
				agentModelOverrides: { executor: "user/executor" },
			});

			settings.clearOverride("modelRoles");
			settings.clearOverride("task.agentModelOverrides");
			expect(settings.getModelRole("default")).toBe("project/default");
			expect(settings.get("task.agentModelOverrides")).toEqual({
				executor: "project/executor",
				planner: "project/planner",
			});

			settings.clearAgentModelOverride("executor");
			expect(settings.get("task.agentModelOverrides")).toEqual({
				executor: "project/executor",
				planner: "project/planner",
			});
			expect(settings.getGlobal("task.agentModelOverrides")).toEqual({});
			await settings.flushOrThrow();
			expect((await readSettings()).task).toEqual({ agentModelOverrides: {} });
		});

		it("preserves externally written sibling roles when saving or clearing one assignment", async () => {
			await writeSettings({
				modelRoles: { default: "global/default" },
				task: {
					agentModelOverrides: {
						executor: "global/executor",
						planner: "global/planner",
					},
				},
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });

			await writeSettings({
				modelRoles: {
					default: "global/default",
					smol: "external/smol",
				},
				task: {
					agentModelOverrides: {
						executor: "global/executor",
						architect: "external/architect",
						planner: "global/planner",
					},
				},
			});

			settings.setModelRole("default", "user/default");
			settings.setAgentModelOverride("executor", "user/executor");
			settings.clearAgentModelOverride("planner");
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.modelRoles).toEqual({
				default: "user/default",
				smol: "external/smol",
			});
			expect(savedSettings.task).toEqual({
				agentModelOverrides: {
					executor: "user/executor",
					architect: "external/architect",
				},
			});
		});

		it("applies inherited leaves only when their durable snapshot is unchanged", async () => {
			await writeSettings({
				modelProfile: { default: "profile-a" },
				modelRoles: { default: "baseline/default" },
				task: { agentModelOverrides: { architect: "baseline/architect" } },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });

			await writeSettings({
				modelProfile: { default: "profile-b" },
				modelRoles: { default: "external/default" },
				task: { agentModelOverrides: { architect: "external/architect" } },
			});

			settings.setModelRoleIfUnchanged("default", "baseline/default", "profile/default");
			settings.setAgentModelOverrideIfUnchanged("architect", "baseline/architect", "profile/architect");
			settings.setAgentModelOverrideIfUnchanged("critic", undefined, "profile/critic");
			settings.setModelProfileDefaultIfUnchanged("profile-a", undefined);
			await settings.flushOrThrow();

			const savedSettings = await readSettings();
			expect(savedSettings.modelProfile).toEqual({ default: "profile-b" });
			expect(savedSettings.modelRoles).toEqual({ default: "external/default" });
			expect(savedSettings.task).toEqual({
				agentModelOverrides: {
					architect: "external/architect",
					critic: "profile/critic",
				},
			});
		});

		it("canonicalizes whole-record and leaf model assignment writes with last-write ownership", async () => {
			await writeSettings({
				task: {
					agentModelOverrides: {
						architect: "baseline/architect",
						planner: "baseline/planner",
					},
				},
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			await writeSettings({
				task: {
					agentModelOverrides: {
						architect: "baseline/architect",
						planner: "external/planner",
					},
				},
			});

			settings.set("task.agentModelOverrides", {
				architect: "whole/architect-1",
				planner: "baseline/planner",
			});
			settings.setAgentModelOverrideIfUnchanged("planner", "baseline/planner", "profile/planner");
			settings.setAgentModelOverride("architect", "leaf/architect-2");
			settings.set("task.agentModelOverrides", {
				architect: "whole/architect-3",
				planner: "baseline/planner",
			});
			await settings.flushOrThrow();

			expect((await readSettings()).task).toEqual({
				agentModelOverrides: {
					architect: "whole/architect-3",
					planner: "baseline/planner",
				},
			});
		});

		it("does not roll back over a later equal-value write from another Settings instance", async () => {
			await writeSettings({
				task: { agentModelOverrides: { architect: "original/architect" } },
			});
			const settingsA = await Settings.init({ cwd: projectDir, agentDir });
			const settingsB = await settingsA.cloneForCwd(projectDir);

			settingsB.setAgentModelOverride("architect", "equal/architect");
			await settingsB.flushOrThrow();
			settingsA.setAgentModelOverrideIfUnchanged("architect", "original/architect", "equal/architect");
			await settingsA.flushOrThrow();
			settingsA.setAgentModelOverrideIfUnchanged("architect", "equal/architect", "original/architect");
			await settingsA.flushOrThrow();

			resetSettingsForTest();
			const reopened = await Settings.init({ cwd: projectDir, agentDir });
			expect(reopened.getGlobal("task.agentModelOverrides")).toEqual({
				architect: "equal/architect",
			});
		});

		it("rotates ownership for explicit equal-value writes and absent clears", async () => {
			await writeSettings({
				task: { agentModelOverrides: { architect: "equal/architect" } },
			});
			const settingsA = await Settings.init({ cwd: projectDir, agentDir });
			const settingsB = await settingsA.cloneForCwd(projectDir);

			settingsB.setAgentModelOverride("architect", "equal/architect");
			settingsB.clearAgentModelOverride("planner");
			await settingsB.flushOrThrow();
			settingsA.setAgentModelOverrideIfUnchanged("architect", "equal/architect", "profile/architect");
			settingsA.setAgentModelOverrideIfUnchanged("planner", undefined, "profile/planner");
			await settingsA.flushOrThrow();

			expect((await readSettings()).task).toEqual({
				agentModelOverrides: { architect: "equal/architect" },
			});
		});

		it("does not invert over a later equal explicit write from the same Settings instance", async () => {
			await writeSettings({
				task: { agentModelOverrides: { architect: "original/architect" } },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });

			settings.setAgentModelOverrideIfUnchanged("architect", "original/architect", "equal/architect");
			await settings.flushOrThrow();
			settings.setAgentModelOverride("architect", "equal/architect");
			await settings.flushOrThrow();
			settings.setAgentModelOverrideIfUnchanged("architect", "equal/architect", "original/architect");
			await settings.flushOrThrow();

			expect((await readSettings()).task).toEqual({
				agentModelOverrides: { architect: "equal/architect" },
			});
		});

		it("does not replace a pending equal explicit profile with an inverse conditional", async () => {
			await writeSettings({ modelProfile: { default: "original-profile" } });
			const settings = await Settings.init({ cwd: projectDir, agentDir });

			settings.setModelProfileDefaultIfUnchanged("original-profile", "equal-profile");
			await settings.flushOrThrow();
			settings.set("modelProfile.default", "equal-profile");
			settings.setModelProfileDefaultIfUnchanged("equal-profile", "original-profile");
			await settings.flushOrThrow();

			expect((await readSettings()).modelProfile).toEqual({ default: "equal-profile" });
		});

		it("retains conditional ownership checks across a failed save retry", async () => {
			await writeSettings({
				task: { agentModelOverrides: { architect: "baseline/architect" } },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const originalWrite = Bun.write;
			const writeSpy = spyOn(Bun, "write").mockImplementation((async (...args: unknown[]) => {
				if (isConfigWritePath(args[0])) {
					throw new Error("simulated write failure");
				}
				return (originalWrite as (...writeArgs: unknown[]) => Promise<number>)(...args);
			}) as typeof Bun.write);

			try {
				settings.setAgentModelOverrideIfUnchanged("architect", "baseline/architect", "profile/architect");
				await expect(settings.flushOrThrow()).rejects.toThrow("simulated write failure");
			} finally {
				writeSpy.mockRestore();
			}

			await writeSettings({
				task: { agentModelOverrides: { architect: "external/architect" } },
			});
			await settings.flushOrThrow();

			expect((await readSettings()).task).toEqual({
				agentModelOverrides: { architect: "external/architect" },
			});
		});

		it("retries the same owned conditional mutation after a config write failure", async () => {
			await writeSettings({
				task: { agentModelOverrides: { architect: "baseline/architect" } },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const originalWrite = Bun.write;
			const writeSpy = spyOn(Bun, "write").mockImplementation((async (...args: unknown[]) => {
				if (isConfigWritePath(args[0])) throw new Error("simulated config failure");
				return (originalWrite as (...writeArgs: unknown[]) => Promise<number>)(...args);
			}) as typeof Bun.write);

			try {
				settings.setAgentModelOverrideIfUnchanged("architect", "baseline/architect", "profile/architect");
				await expect(settings.flushOrThrow()).rejects.toThrow("simulated config failure");
			} finally {
				writeSpy.mockRestore();
			}
			await settings.flushOrThrow();

			expect((await readSettings()).task).toEqual({
				agentModelOverrides: { architect: "profile/architect" },
			});
		});

		it("does not let an unconditional retry reclaim a later writer", async () => {
			await writeSettings({
				task: { agentModelOverrides: { architect: "original/architect" } },
			});
			const settingsA = await Settings.init({ cwd: projectDir, agentDir });
			const settingsB = await settingsA.cloneForCwd(projectDir);
			const originalWrite = Bun.write;
			const writeSpy = spyOn(Bun, "write").mockImplementation((async (...args: unknown[]) => {
				if (isConfigWritePath(args[0])) throw new Error("simulated config failure");
				return (originalWrite as (...writeArgs: unknown[]) => Promise<number>)(...args);
			}) as typeof Bun.write);

			try {
				settingsA.setAgentModelOverride("architect", "first/architect");
				await expect(settingsA.flushOrThrow()).rejects.toThrow("simulated config failure");
			} finally {
				writeSpy.mockRestore();
			}
			settingsB.setAgentModelOverride("architect", "later/architect");
			await settingsB.flushOrThrow();
			await settingsA.flushOrThrow();

			expect((await readSettings()).task).toEqual({
				agentModelOverrides: { architect: "later/architect" },
			});
		});
		it("does not overwrite an external edit when retrying an unconditional mutation", async () => {
			await writeSettings({
				task: { agentModelOverrides: { architect: "original/architect" } },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const originalWrite = Bun.write;
			const writeSpy = spyOn(Bun, "write").mockImplementation((async (...args: unknown[]) => {
				if (isConfigWritePath(args[0])) throw new Error("simulated config failure");
				return (originalWrite as (...writeArgs: unknown[]) => Promise<number>)(...args);
			}) as typeof Bun.write);

			try {
				settings.setAgentModelOverride("architect", "first/architect");
				await expect(settings.flushOrThrow()).rejects.toThrow("simulated config failure");
			} finally {
				writeSpy.mockRestore();
			}
			await writeSettings({
				task: { agentModelOverrides: { architect: "external/architect" } },
			});
			await settings.flushOrThrow();

			expect((await readSettings()).task).toEqual({
				agentModelOverrides: { architect: "external/architect" },
			});
		});
		it("restores a failed mutation checkpoint without a later silent commit", async () => {
			await writeSettings({
				task: { agentModelOverrides: { executor: "original/executor" } },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const checkpoint = await settings.createMutationCheckpoint();
			const originalWrite = Bun.write;
			const writeSpy = spyOn(Bun, "write").mockImplementation((async (...args: unknown[]) => {
				if (isConfigWritePath(args[0])) throw new Error("simulated config failure");
				return (originalWrite as (...writeArgs: unknown[]) => Promise<number>)(...args);
			}) as typeof Bun.write);
			try {
				await settings.runMutationCheckpoint(checkpoint, async () => {
					settings.setAgentModelOverride("executor", "failed/executor");
					await expect(settings.flushMutationCheckpoint(checkpoint)).rejects.toThrow("simulated config failure");
				});
			} finally {
				writeSpy.mockRestore();
			}

			settings.restoreMutationCheckpoint(checkpoint);
			expect(settings.get("task.agentModelOverrides").executor).toBe("original/executor");
			await settings.flushOrThrow();

			resetSettingsForTest();
			const reopened = await Settings.init({ cwd: projectDir, agentDir });
			expect(reopened.get("task.agentModelOverrides").executor).toBe("original/executor");
		});

		it("does not start a background save while a mutation checkpoint is active", async () => {
			await writeSettings({
				task: { agentModelOverrides: { executor: "original/executor" } },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const checkpoint = await settings.createMutationCheckpoint();

			await settings.runMutationCheckpoint(checkpoint, async () => {
				settings.setAgentModelOverride("executor", "uncommitted/executor");
				await Bun.sleep(150);
				expect((await readSettings()).task).toEqual({
					agentModelOverrides: { executor: "original/executor" },
				});
			});

			settings.restoreMutationCheckpoint(checkpoint);
			await Bun.sleep(150);
			expect((await readSettings()).task).toEqual({
				agentModelOverrides: { executor: "original/executor" },
			});
		});

		it("blocks unrelated mutations while a checkpoint baseline is being acquired", async () => {
			await writeSettings({
				task: { agentModelOverrides: { executor: "original/executor" } },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.setAgentModelOverride("executor", "baseline/executor");
			const configWriteStarted = Promise.withResolvers<void>();
			const releaseConfigWrite = Promise.withResolvers<void>();
			const originalWrite = Bun.write;
			let gated = false;
			const writeSpy = spyOn(Bun, "write").mockImplementation((async (...args: unknown[]) => {
				if (isConfigWritePath(args[0]) && !gated) {
					gated = true;
					configWriteStarted.resolve();
					await releaseConfigWrite.promise;
				}
				return (originalWrite as (...writeArgs: unknown[]) => Promise<number>)(...args);
			}) as typeof Bun.write);

			const checkpointPromise = settings.createMutationCheckpoint();
			await configWriteStarted.promise;
			expect(() => settings.setAgentModelOverride("planner", "during-acquisition/planner")).toThrow(
				"Settings mutation blocked while a transaction is being acquired",
			);
			await Bun.sleep(150);
			releaseConfigWrite.resolve();
			let checkpoint: SettingsMutationCheckpoint;
			try {
				checkpoint = await checkpointPromise;
			} finally {
				writeSpy.mockRestore();
			}

			expect((await readSettings()).task).toEqual({
				agentModelOverrides: { executor: "baseline/executor" },
			});
			await settings.runMutationCheckpoint(checkpoint, async () => {
				settings.setAgentModelOverride("critic", "transaction/critic");
			});
			await settings.flushMutationCheckpoint(checkpoint);
			settings.releaseMutationCheckpoint(checkpoint);
			expect((await readSettings()).task).toEqual({
				agentModelOverrides: {
					executor: "baseline/executor",
					critic: "transaction/critic",
				},
			});
		});

		it("rejects unrelated synchronous mutations during an active checkpoint", async () => {
			await writeSettings({
				task: { agentModelOverrides: { executor: "original/executor" } },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const checkpoint = await settings.createMutationCheckpoint();

			expect(() => settings.setAgentModelOverride("planner", "unrelated/planner")).toThrow(
				"Settings mutation blocked by an active transaction",
			);
			settings.restoreMutationCheckpoint(checkpoint);
			expect(settings.get("task.agentModelOverrides")).toEqual({
				executor: "original/executor",
			});
		});
		it("rejects a contextless flush continuation while a checkpoint is active", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const checkpoint = await settings.createMutationCheckpoint();
			const enteredTransaction = Promise.withResolvers<void>();
			const releaseTransaction = Promise.withResolvers<void>();
			const transaction = settings.runMutationCheckpoint(checkpoint, async () => {
				settings.setAgentModelOverride("executor", "transaction/executor");
				enteredTransaction.resolve();
				await releaseTransaction.promise;
			});

			await enteredTransaction.promise;
			await expect(settings.flushOrThrow()).rejects.toThrow("Settings flush blocked by an active transaction");
			releaseTransaction.resolve();
			await transaction;
			await settings.flushMutationCheckpoint(checkpoint);
			settings.releaseMutationCheckpoint(checkpoint);

			expect((await readSettings()).task).toEqual({
				agentModelOverrides: { executor: "transaction/executor" },
			});
		});
		it("rejects nested checkpoint acquisition and general flush from transaction context", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const checkpoint = await settings.createMutationCheckpoint();

			await settings.runMutationCheckpoint(checkpoint, async () => {
				await expect(settings.createMutationCheckpoint()).rejects.toThrow(
					"Cannot create a nested transaction from inside an active Settings transaction",
				);
				await expect(settings.flush()).rejects.toThrow(
					"Cannot flush settings from inside an active Settings transaction",
				);
				await expect(settings.flushOrThrow()).rejects.toThrow(
					"Cannot flush settings from inside an active Settings transaction",
				);
			});

			settings.restoreMutationCheckpoint(checkpoint);
		});

		it("revokes detached transaction work after rollback", async () => {
			await writeSettings({
				task: { agentModelOverrides: { planner: "original/planner" } },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const checkpoint = await settings.createMutationCheckpoint();
			const detachedResult = Promise.withResolvers<unknown>();

			await settings.runMutationCheckpoint(checkpoint, async () => {
				setTimeout(() => {
					try {
						settings.setAgentModelOverride("planner", "detached/planner");
						detachedResult.resolve(undefined);
					} catch (error) {
						detachedResult.resolve(error);
					}
				}, 10);
			});
			settings.restoreMutationCheckpoint(checkpoint);

			await expect(detachedResult.promise).resolves.toEqual(
				expect.objectContaining({ message: "Settings mutation belongs to a completed transaction" }),
			);
			await settings.flushOrThrow();
			expect((await readSettings()).task).toEqual({
				agentModelOverrides: { planner: "original/planner" },
			});
		});
		it("seals mutations and rejects rollback while checkpoint flush is in progress", async () => {
			await writeSettings({
				task: { agentModelOverrides: { executor: "original/executor" } },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const checkpoint = await settings.createMutationCheckpoint();
			const triggerDetached = Promise.withResolvers<void>();
			const detachedResult = Promise.withResolvers<unknown>();
			await settings.runMutationCheckpoint(checkpoint, async () => {
				settings.setAgentModelOverride("executor", "transaction/executor");
				void triggerDetached.promise.then(() => {
					try {
						settings.setAgentModelOverride("planner", "late/planner");
						detachedResult.resolve(undefined);
					} catch (error) {
						detachedResult.resolve(error);
					}
				});
			});

			const configWriteStarted = Promise.withResolvers<void>();
			const releaseConfigWrite = Promise.withResolvers<void>();
			const originalWrite = Bun.write;
			let gated = false;
			const writeSpy = spyOn(Bun, "write").mockImplementation((async (...args: unknown[]) => {
				if (isConfigWritePath(args[0]) && !gated) {
					gated = true;
					configWriteStarted.resolve();
					await releaseConfigWrite.promise;
				}
				return (originalWrite as (...writeArgs: unknown[]) => Promise<number>)(...args);
			}) as typeof Bun.write);
			try {
				const flush = settings.flushMutationCheckpoint(checkpoint);
				await configWriteStarted.promise;
				triggerDetached.resolve();
				await expect(detachedResult.promise).resolves.toEqual(
					expect.objectContaining({ message: "Settings mutation belongs to a completed transaction" }),
				);
				expect(() => settings.restoreMutationCheckpoint(checkpoint)).toThrow(
					"Settings mutation checkpoint flush is still in progress",
				);
				await expect(settings.flushMutationCheckpoint(checkpoint)).rejects.toThrow(
					"Settings mutation checkpoint cannot be flushed more than once",
				);
				releaseConfigWrite.resolve();
				await flush;
			} finally {
				writeSpy.mockRestore();
			}
			settings.releaseMutationCheckpoint(checkpoint);

			expect((await readSettings()).task).toEqual({
				agentModelOverrides: { executor: "transaction/executor" },
			});
		});

		it("treats parent directory fsync failure after rename as a committed write", async () => {
			await writeSettings({
				task: { agentModelOverrides: { executor: "original/executor" } },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const originalFsync = fs.fsyncSync;
			const fsyncSpy = spyOn(fs, "fsyncSync").mockImplementation(fd => {
				if (fs.fstatSync(fd).isDirectory()) {
					throw new Error("simulated parent fsync failure");
				}
				return originalFsync(fd);
			});
			try {
				settings.setAgentModelOverride("executor", "committed/executor");
				await expect(settings.flushOrThrow()).resolves.toBeUndefined();
			} finally {
				fsyncSpy.mockRestore();
			}

			expect((await readSettings()).task).toEqual({
				agentModelOverrides: { executor: "committed/executor" },
			});
		});

		it("retries current mutations after an overlapping throw-on-error save fails", async () => {
			await writeSettings({
				task: { agentModelOverrides: { executor: "original/executor" } },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const firstConfigWriteStarted = Promise.withResolvers<void>();
			const releaseFirstConfigWrite = Promise.withResolvers<void>();
			const originalWrite = Bun.write;
			let configWriteCount = 0;
			const writeSpy = spyOn(Bun, "write").mockImplementation((async (...args: unknown[]) => {
				if (isConfigWritePath(args[0]) && configWriteCount++ === 0) {
					firstConfigWriteStarted.resolve();
					await releaseFirstConfigWrite.promise;
					throw new Error("simulated first config failure");
				}
				return (originalWrite as (...writeArgs: unknown[]) => Promise<number>)(...args);
			}) as typeof Bun.write);
			try {
				settings.setAgentModelOverride("executor", "failed/executor");
				const firstFlush = settings.flushOrThrow();
				await firstConfigWriteStarted.promise;

				settings.setAgentModelOverride("planner", "current/planner");
				const overlappingFlush = settings.flushOrThrow();
				releaseFirstConfigWrite.resolve();

				await expect(firstFlush).rejects.toThrow("simulated first config failure");
				await expect(overlappingFlush).resolves.toBeUndefined();
			} finally {
				writeSpy.mockRestore();
			}

			expect((await readSettings()).task).toEqual({
				agentModelOverrides: {
					executor: "failed/executor",
					planner: "current/planner",
				},
			});
		});

		it("serializes mutation checkpoints so a later rollback cannot revive a failed command", async () => {
			await writeSettings({
				task: { agentModelOverrides: { executor: "original/executor" } },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const firstCheckpoint = await settings.createMutationCheckpoint();
			const firstConfigWriteStarted = Promise.withResolvers<void>();
			const releaseFirstConfigWrite = Promise.withResolvers<void>();
			const originalWrite = Bun.write;
			const writeSpy = spyOn(Bun, "write").mockImplementation((async (...args: unknown[]) => {
				if (isConfigWritePath(args[0])) {
					firstConfigWriteStarted.resolve();
					await releaseFirstConfigWrite.promise;
					throw new Error("simulated config failure");
				}
				return (originalWrite as (...writeArgs: unknown[]) => Promise<number>)(...args);
			}) as typeof Bun.write);

			const firstFlush = settings.runMutationCheckpoint(firstCheckpoint, async () => {
				settings.setAgentModelOverride("executor", "failed/executor");
				await settings.flushMutationCheckpoint(firstCheckpoint);
			});
			await firstConfigWriteStarted.promise;

			let secondCheckpointAcquired = false;
			const secondCheckpointPromise = settings.createMutationCheckpoint().then(checkpoint => {
				secondCheckpointAcquired = true;
				return checkpoint;
			});
			await Bun.sleep(10);
			expect(secondCheckpointAcquired).toBe(false);

			releaseFirstConfigWrite.resolve();
			try {
				await expect(firstFlush).rejects.toThrow("simulated config failure");
			} finally {
				writeSpy.mockRestore();
			}
			settings.restoreMutationCheckpoint(firstCheckpoint);

			const secondCheckpoint = await secondCheckpointPromise;
			await settings.runMutationCheckpoint(secondCheckpoint, async () => {
				settings.setAgentModelOverride("planner", "current/planner");
				await settings.flushMutationCheckpoint(secondCheckpoint);
			});
			settings.releaseMutationCheckpoint(secondCheckpoint);

			expect((await readSettings()).task).toEqual({
				agentModelOverrides: {
					executor: "original/executor",
					planner: "current/planner",
				},
			});
		});

		it("reloads durable global settings when cloning for another cwd", async () => {
			await writeSettings({ modelProfile: { default: "profile-a" } });
			const staleSettings = await Settings.init({ cwd: projectDir, agentDir });

			resetSettingsForTest();
			const currentSettings = await Settings.init({ cwd: projectDir, agentDir });
			currentSettings.clearGlobal("modelProfile.default");
			await currentSettings.flushOrThrow();

			const cloned = await staleSettings.cloneForCwd(projectDir);
			expect(cloned.getGlobal("modelProfile.default")).toBeUndefined();
		});
		it("does not retry past a later writer after sidecar persistence fails", async () => {
			await writeSettings({
				task: { agentModelOverrides: { architect: "original/architect" } },
			});
			const settingsA = await Settings.init({ cwd: projectDir, agentDir });
			const settingsB = await settingsA.cloneForCwd(projectDir);
			const originalWrite = Bun.write;
			const writeSpy = spyOn(Bun, "write").mockImplementation((async (...args: unknown[]) => {
				if (isRevisionWritePath(args[0])) throw new Error("simulated revision failure");
				return (originalWrite as (...writeArgs: unknown[]) => Promise<number>)(...args);
			}) as typeof Bun.write);

			try {
				settingsA.setAgentModelOverride("architect", "first/architect");
				await expect(settingsA.flushOrThrow()).rejects.toThrow("simulated revision failure");
			} finally {
				writeSpy.mockRestore();
			}
			settingsB.setAgentModelOverride("architect", "later/architect");
			await settingsB.flushOrThrow();
			await settingsA.flushOrThrow();

			expect((await readSettings()).task).toEqual({
				agentModelOverrides: { architect: "later/architect" },
			});
		});
		it("retries after a sidecar failure when the predecessor is unchanged", async () => {
			await writeSettings({
				task: { agentModelOverrides: { architect: "original/architect" } },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const originalWrite = Bun.write;
			const writeSpy = spyOn(Bun, "write").mockImplementation((async (...args: unknown[]) => {
				if (isRevisionWritePath(args[0])) throw new Error("simulated revision failure");
				return (originalWrite as (...writeArgs: unknown[]) => Promise<number>)(...args);
			}) as typeof Bun.write);

			try {
				settings.setAgentModelOverride("architect", "first/architect");
				await expect(settings.flushOrThrow()).rejects.toThrow("simulated revision failure");
			} finally {
				writeSpy.mockRestore();
			}
			await settings.flushOrThrow();

			expect((await readSettings()).task).toEqual({
				agentModelOverrides: { architect: "first/architect" },
			});
		});
		it("does not overwrite siblings when the config root becomes invalid", async () => {
			await writeSettings({
				modelRoles: { default: "original/default" },
				task: { agentModelOverrides: { architect: "original/architect" } },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const invalidConfig = "- broken-root\n";
			await Bun.write(getConfigPath(), invalidConfig);

			settings.setAgentModelOverride("planner", "user/planner");
			await expect(settings.flushOrThrow()).rejects.toThrow("Settings root must be an object");
			expect(await Bun.file(getConfigPath()).text()).toBe(invalidConfig);
		});
		it("rejects existing hardlinked config aliases before either instance can mutate", async () => {
			await writeSettings({ modelRoles: { default: "original/default" } });
			const aliasAgentDir = path.join(testDir, "agent-alias");
			fs.mkdirSync(aliasAgentDir);
			fs.linkSync(getConfigPath(), path.join(aliasAgentDir, "config.yml"));

			await expect(Settings.init({ cwd: projectDir, agentDir })).rejects.toThrow(
				"Settings config file has multiple hardlinks",
			);
			await expect(Settings.init({ cwd: projectDir, agentDir: aliasAgentDir })).rejects.toThrow(
				"Settings config file has multiple hardlinks",
			);
		});
		it("rejects a hardlink introduced while the config temp write is gated", async () => {
			await writeSettings({ modelRoles: { default: "original/default" } });
			const settingsP = await Settings.init({ cwd: projectDir, agentDir });
			resetSettingsForTest();

			const aliasAgentDir = path.join(testDir, "agent-alias");
			fs.mkdirSync(aliasAgentDir);
			const settingsQ = await Settings.init({ cwd: projectDir, agentDir: aliasAgentDir });
			const configWriteStarted = Promise.withResolvers<void>();
			const releaseConfigWrite = Promise.withResolvers<void>();
			const originalWrite = Bun.write;
			let gated = false;
			const writeSpy = spyOn(Bun, "write").mockImplementation((async (...args: unknown[]) => {
				if (isConfigWritePath(args[0]) && !gated) {
					gated = true;
					configWriteStarted.resolve();
					await releaseConfigWrite.promise;
				}
				return (originalWrite as (...writeArgs: unknown[]) => Promise<number>)(...args);
			}) as typeof Bun.write);

			try {
				settingsP.setModelRole("default", "p/first");
				settingsQ.setModelRole("default", "q/first");
				const flushP = settingsP.flushOrThrow();
				await configWriteStarted.promise;
				fs.linkSync(getConfigPath(), path.join(aliasAgentDir, "config.yml"));
				releaseConfigWrite.resolve();

				await expect(flushP).rejects.toThrow("Settings config file has multiple hardlinks");
				await expect(settingsP.flushOrThrow()).rejects.toThrow("Settings config file has multiple hardlinks");
				await expect(settingsQ.flushOrThrow()).rejects.toThrow("Settings config file has multiple hardlinks");
			} finally {
				writeSpy.mockRestore();
			}
		});
		it("rejects invalid model assignment keys without poisoning durable ownership", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(() => settings.setModelRole("", "invalid/default")).toThrow("Model assignment key cannot be empty");
			expect(() => settings.setAgentModelOverride("", "invalid/agent")).toThrow(
				"Model assignment key cannot be empty",
			);
			expect(() => settings.set("modelRoles", { "": "invalid/default" })).toThrow(
				"Model assignment key cannot be empty",
			);
			expect(() => settings.set("task.agentModelOverrides", { "": "invalid/agent" })).toThrow(
				"Model assignment key cannot be empty",
			);

			for (const key of ["__proto__", "prototype", "constructor", "toString", "hasOwnProperty"]) {
				const roleRecord = Object.fromEntries([[key, "invalid/default"]]);
				const agentRecord = Object.fromEntries([[key, "invalid/agent"]]);
				expect(() => settings.setModelRole(key, "invalid/default")).toThrow(
					`Model assignment key is not allowed: ${key}`,
				);
				expect(() => settings.setAgentModelOverride(key, "invalid/agent")).toThrow(
					`Model assignment key is not allowed: ${key}`,
				);
				expect(() => settings.set("modelRoles", roleRecord)).toThrow(`Model assignment key is not allowed: ${key}`);
				expect(() => settings.set("task.agentModelOverrides", agentRecord)).toThrow(
					`Model assignment key is not allowed: ${key}`,
				);
			}

			settings.setModelRole("default", "valid/default");
			await settings.flushOrThrow();

			resetSettingsForTest();
			const reopened = await Settings.init({ cwd: projectDir, agentDir });
			expect(reopened.getModelRole("default")).toBe("valid/default");
		});

		it("fails closed when the durable ownership sidecar is malformed", async () => {
			await writeSettings({
				task: { agentModelOverrides: { architect: "original/architect" } },
			});
			await Bun.write(`${getConfigPath()}.revisions.json`, "{not-json");

			await expect(Settings.init({ cwd: projectDir, agentDir })).rejects.toThrow();
			expect((await readSettings()).task).toEqual({
				agentModelOverrides: { architect: "original/architect" },
			});
		});

		it("rejects semantically invalid ownership sidecars", async () => {
			await writeSettings({
				task: { agentModelOverrides: { architect: "original/architect" } },
			});
			await Bun.write(
				`${getConfigPath()}.revisions.json`,
				JSON.stringify({
					version: 1,
					generation: "uninitialized",
					nextRevision: 1,
					entries: {},
				}),
			);

			await expect(Settings.init({ cwd: projectDir, agentDir })).rejects.toThrow(
				"Invalid settings revision state header",
			);
		});

		it("rejects non-canonical ownership paths", async () => {
			await writeSettings({
				modelRoles: { default: "original/default" },
			});
			await Settings.init({ cwd: projectDir, agentDir });
			const sidecarPath = `${getConfigPath()}.revisions.json`;
			const state = JSON.parse(await Bun.file(sidecarPath).text()) as Record<string, unknown>;
			const invalidPaths = [
				"modelRoles",
				"task.agentModelOverrides",
				'\0record-entry:[ "modelRoles", "default" ]',
				`\0record-entry:${JSON.stringify(["modelRoles", "__proto__"])}`,
				`\0record-entry:${JSON.stringify(["task", "agentModelOverrides", "constructor"])}`,
				`\0record-entry:${JSON.stringify(["modelRoles", "toString"])}`,
			];

			for (const modifiedPath of invalidPaths) {
				resetSettingsForTest();
				await Bun.write(
					sidecarPath,
					JSON.stringify({
						...state,
						nextRevision: 2,
						entries: {
							[modifiedPath]: {
								revision: 1,
								ownerId: "external-writer",
								mutationId: 1,
							},
						},
					}),
				);
				await expect(Settings.init({ cwd: projectDir, agentDir })).rejects.toThrow(
					`Invalid settings revision path: ${modifiedPath}`,
				);
			}
		});

		it("rejects stale baselines after ownership sidecar regeneration", async () => {
			await writeSettings({
				task: { agentModelOverrides: { architect: "equal/architect" } },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.setAgentModelOverride("architect", "equal/architect");
			await settings.flushOrThrow();
			const staleSettings = await settings.cloneForCwd(projectDir);
			fs.rmSync(`${getConfigPath()}.revisions.json`);

			resetSettingsForTest();
			const regenerated = await Settings.init({ cwd: projectDir, agentDir });
			regenerated.setAgentModelOverride("architect", "equal/architect");
			await regenerated.flushOrThrow();
			staleSettings.setAgentModelOverrideIfUnchanged("architect", "equal/architect", "profile/architect");
			await staleSettings.flushOrThrow();

			expect((await readSettings()).task).toEqual({
				agentModelOverrides: { architect: "equal/architect" },
			});
		});
		it("regenerates a deleted sidecar without wedging later live conditional writes", async () => {
			await writeSettings({
				task: { agentModelOverrides: { architect: "original/architect" } },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const sidecarPath = `${getConfigPath()}.revisions.json`;
			fs.rmSync(sidecarPath);

			settings.setAgentModelOverrideIfUnchanged("architect", "original/architect", "first/architect");
			await settings.flushOrThrow();
			expect(await Bun.file(sidecarPath).exists()).toBe(true);
			expect((await readSettings()).task).toEqual({
				agentModelOverrides: { architect: "original/architect" },
			});

			settings.setAgentModelOverrideIfUnchanged("architect", "original/architect", "second/architect");
			await settings.flushOrThrow();

			resetSettingsForTest();
			const reopened = await Settings.init({ cwd: projectDir, agentDir });
			expect(reopened.getGlobal("task.agentModelOverrides")).toEqual({
				architect: "second/architect",
			});
		});
		it("refuses profile deletion when a concurrent writer restored the same default", async () => {
			const settingsA = await Settings.init({ cwd: projectDir, agentDir });
			const settingsB = await settingsA.cloneForCwd(projectDir);
			settingsB.set("modelProfile.default", "profile-a");
			await settingsB.flushOrThrow();
			let deleted = false;

			await expect(
				settingsA.deleteModelProfileIfUnreferenced("profile-a", async () => {
					deleted = true;
				}),
			).rejects.toThrow("Model profile became the default while deletion was in progress: profile-a");

			expect(deleted).toBe(false);
			resetSettingsForTest();
			const reopened = await Settings.init({ cwd: projectDir, agentDir });
			expect(reopened.getGlobal("modelProfile.default")).toBe("profile-a");
		});

		it("preserves external siblings for dotted role and agent names", async () => {
			await writeSettings({
				modelRoles: {
					"review.security": "global/reviewer",
					default: "global/default",
				},
				task: {
					agentModelOverrides: {
						"review.security": "global/reviewer",
						planner: "global/planner",
					},
				},
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });

			await writeSettings({
				modelRoles: {
					"review.security": "global/reviewer",
					default: "external/default",
				},
				task: {
					agentModelOverrides: {
						"review.security": "global/reviewer",
						planner: "external/planner",
					},
				},
			});
			settings.setModelRole("review.security", "user/reviewer");
			settings.setAgentModelOverride("review.security", "user/reviewer");
			await settings.flushOrThrow();

			expect((await readSettings()).modelRoles).toEqual({
				"review.security": "user/reviewer",
				default: "external/default",
			});
			expect((await readSettings()).task).toEqual({
				agentModelOverrides: {
					"review.security": "user/reviewer",
					planner: "external/planner",
				},
			});

			await writeSettings({
				modelRoles: {
					"review.security": "user/reviewer",
					default: "external/default-v2",
				},
				task: {
					agentModelOverrides: {
						"review.security": "user/reviewer",
						planner: "external/planner-v2",
					},
				},
			});
			settings.clearModelRole("review.security");
			settings.clearAgentModelOverride("review.security");
			await settings.flushOrThrow();

			expect((await readSettings()).modelRoles).toEqual({ default: "external/default-v2" });
			expect((await readSettings()).task).toEqual({
				agentModelOverrides: { planner: "external/planner-v2" },
			});
		});

		it("serializes a flush behind an in-flight debounced save", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const { promise: writeWait, resolve: releaseWrite } = Promise.withResolvers<void>();
			const { promise: writeStarted, resolve: resolveWriteStarted } = Promise.withResolvers<void>();
			const originalWrite = Bun.write;
			let blockedFirstWrite = false;
			const writeSpy = spyOn(Bun, "write").mockImplementation((async (...args: unknown[]) => {
				if (!blockedFirstWrite) {
					blockedFirstWrite = true;
					resolveWriteStarted();
					await writeWait;
				}
				return (originalWrite as (...writeArgs: unknown[]) => Promise<number>)(...args);
			}) as typeof Bun.write);

			try {
				settings.setModelRole("default", "user/default");
				await writeStarted;
				settings.setAgentModelOverride("executor", "user/executor");
				expect(settings.getGlobal("task.agentModelOverrides")).toEqual({ executor: "user/executor" });
				const flushPromise = settings.flush();
				releaseWrite();
				await flushPromise;
				expect(settings.getGlobal("task.agentModelOverrides")).toEqual({ executor: "user/executor" });
			} finally {
				releaseWrite();
				writeSpy.mockRestore();
			}

			const savedSettings = await readSettings();
			expect(savedSettings.modelRoles).toEqual({ default: "user/default" });
			expect(savedSettings.task).toEqual({
				agentModelOverrides: { executor: "user/executor" },
			});
		});

		it("keeps newer explicit leaves across an in-flight conditional save", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const { promise: writeWait, resolve: releaseWrite } = Promise.withResolvers<void>();
			const { promise: writeStarted, resolve: resolveWriteStarted } = Promise.withResolvers<void>();
			const originalWrite = Bun.write;
			let blockedConfigWrite = false;
			const writeSpy = spyOn(Bun, "write").mockImplementation((async (...args: unknown[]) => {
				if (!blockedConfigWrite && isConfigWritePath(args[0])) {
					blockedConfigWrite = true;
					resolveWriteStarted();
					await writeWait;
				}
				return (originalWrite as (...writeArgs: unknown[]) => Promise<number>)(...args);
			}) as typeof Bun.write);

			try {
				settings.setAgentModelOverrideIfUnchanged("architect", undefined, "profile/architect");
				const firstFlush = settings.flushOrThrow();
				await writeStarted;

				settings.setAgentModelOverride("architect", "user/architect");
				settings.setAgentModelOverride("planner", "user/planner");
				settings.setAgentModelOverrideIfUnchanged("planner", "user/planner", "profile/planner");
				expect(settings.getGlobal("task.agentModelOverrides")).toEqual({
					architect: "user/architect",
					planner: "user/planner",
				});

				releaseWrite();
				await firstFlush;
				await settings.flushOrThrow();
			} finally {
				releaseWrite();
				writeSpy.mockRestore();
			}

			expect((await readSettings()).task).toEqual({
				agentModelOverrides: {
					architect: "user/architect",
					planner: "user/planner",
				},
			});
		});
	});

	describe("migrations", () => {
		it("maps removed atom edit mode settings to hashline", async () => {
			await writeSettings({
				edit: {
					mode: "atom",
					modelVariants: {
						"claude-opus": "atom",
						"gpt-5": "apply_patch",
					},
				},
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("edit.mode")).toBe("hashline");
			expect(settings.getEditVariantForModel("claude-opus-4-5")).toBe("hashline");
			expect(settings.getEditVariantForModel("gpt-5.2")).toBe("apply_patch");
		});

		it("maps legacy hindsight.dynamicBankId=true onto hindsight.scoping=per-project", async () => {
			await writeSettings({
				hindsight: { dynamicBankId: true },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("hindsight.scoping")).toBe("per-project");
		});

		it("does not override an explicit hindsight.scoping when migrating", async () => {
			await writeSettings({
				hindsight: { dynamicBankId: true, scoping: "global" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("hindsight.scoping")).toBe("global");
		});

		it("promotes legacy hindsight.agentName onto hindsight.bankId when bankId is unset", async () => {
			await writeSettings({
				hindsight: { agentName: "ada-cli" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("hindsight.bankId")).toBe("ada-cli");
		});

		it("maps legacy flat built-in theme names to retained defaults", async () => {
			await writeSettings({ theme: "dark" });

			let settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("theme.dark")).toBe("red-claw");
			expect(settings.get("theme.light")).toBe("blue-crab");

			resetSettingsForTest();
			await writeSettings({ theme: "light" });

			settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("theme.dark")).toBe("red-claw");
			expect(settings.get("theme.light")).toBe("blue-crab");
		});

		it("maps legacy nested built-in theme names to retained defaults", async () => {
			await writeSettings({ theme: { dark: "dark", light: "light" } });

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("theme.dark")).toBe("red-claw");
			expect(settings.get("theme.light")).toBe("blue-crab");
		});

		it("preserves custom dark and light theme names in nested settings", async () => {
			await writeCustomTheme("dark", "#ffffff");
			await writeCustomTheme("light", "#ffffff");
			await writeSettings({ theme: { dark: "dark", light: "light" } });

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("theme.dark")).toBe("dark");
			expect(settings.get("theme.light")).toBe("light");
		});

		it("classifies flat custom theme names using the configured agentDir", async () => {
			await writeCustomTheme("dark", "#ffffff");
			await writeSettings({ theme: "dark" });

			let settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("theme.light")).toBe("dark");

			resetSettingsForTest();
			await writeCustomTheme("custom-light", "#ffffff");
			await writeSettings({ theme: "custom-light" });

			settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("theme.light")).toBe("custom-light");

			resetSettingsForTest();
			await writeCustomTheme("light", "#ffffff");
			await writeSettings({ theme: "light" });

			settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("theme.light")).toBe("light");
		});
	});

	describe("below-threshold maintenance pruning defaults (Finding 13)", () => {
		it("keeps maintenance pruning off by default (evidence-gated) with a high min-savings floor", () => {
			const settings = Settings.isolated();
			const compaction = settings.getGroup("compaction");
			expect(compaction.maintenancePruningEnabled).toBe(false);
			expect(compaction.maintenancePruningMinSavingsTokens).toBe(8000);
		});

		it("exposes the opt-in override through getGroup", () => {
			const settings = Settings.isolated({
				"compaction.maintenancePruningEnabled": true,
				"compaction.maintenancePruningMinSavingsTokens": 12000,
			});
			const compaction = settings.getGroup("compaction");
			expect(compaction.maintenancePruningEnabled).toBe(true);
			expect(compaction.maintenancePruningMinSavingsTokens).toBe(12000);
		});
	});
});

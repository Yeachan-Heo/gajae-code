import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@gajae-code/ai";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
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

	const getConfigPath = () => path.join(agentDir, "config.yml");

	const writeSettings = async (settings: Record<string, unknown>) => {
		await Bun.write(getConfigPath(), YAML.stringify(settings, null, 2));
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

		it("keeps model assignments live when project settings shadow global persistence", async () => {
			await writeSettings({
				modelRoles: { default: "global/default" },
				task: {
					agentModelOverrides: {
						executor: "global/executor",
					},
				},
			});
			await Bun.write(
				path.join(getProjectAgentDir(projectDir), "config.yml"),
				YAML.stringify(
					{
						modelRoles: { default: "project/default" },
						task: {
							agentModelOverrides: {
								executor: "project/executor",
								architect: "project/architect",
								planner: "project/planner",
								critic: "project/critic",
							},
						},
					},
					null,
					2,
				),
			);

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.getModelRole("default")).toBe("project/default");
			expect(settings.get("task.agentModelOverrides")).toEqual({
				executor: "project/executor",
				architect: "project/architect",
				planner: "project/planner",
				critic: "project/critic",
			});

			settings.setModelRole("default", "openai-codex/gpt-5.6-sol:xhigh");
			for (const role of ["executor", "architect", "planner", "critic"]) {
				settings.setAgentModelOverride(role, "openai-codex/gpt-5.6-sol:xhigh");
			}

			expect(settings.getModelRole("default")).toBe("openai-codex/gpt-5.6-sol:xhigh");
			expect(settings.get("task.agentModelOverrides")).toEqual({
				executor: "openai-codex/gpt-5.6-sol:xhigh",
				architect: "openai-codex/gpt-5.6-sol:xhigh",
				planner: "openai-codex/gpt-5.6-sol:xhigh",
				critic: "openai-codex/gpt-5.6-sol:xhigh",
			});

			await settings.flushOrThrow();
			const savedSettings = await readSettings();
			expect(savedSettings.modelRoles).toEqual({ default: "openai-codex/gpt-5.6-sol:xhigh" });
			expect(savedSettings.task).toEqual({
				agentModelOverrides: {
					executor: "openai-codex/gpt-5.6-sol:xhigh",
					architect: "openai-codex/gpt-5.6-sol:xhigh",
					planner: "openai-codex/gpt-5.6-sol:xhigh",
					critic: "openai-codex/gpt-5.6-sol:xhigh",
				},
			});

			settings.clearOverride("modelRoles");
			settings.clearOverride("task.agentModelOverrides");
			expect(settings.getModelRole("default")).toBe("project/default");
			expect(settings.get("task.agentModelOverrides")).toEqual({
				executor: "project/executor",
				architect: "project/architect",
				planner: "project/planner",
				critic: "project/critic",
			});
		});

		it("treats runtime null model records as resets before applying assignments", () => {
			const settings = Settings.isolated();
			settings.override("modelRoles", null as never);
			settings.override("task.agentModelOverrides", null as never);

			expect(settings.get("modelRoles")).toEqual({});
			expect(settings.get("task.agentModelOverrides")).toEqual({});

			settings.setModelRole("default", "provider/selected:high");
			settings.setAgentModelOverride("executor", "provider/selected:high");

			expect(settings.getModelRole("default")).toBe("provider/selected:high");
			expect(settings.get("task.agentModelOverrides")).toEqual({
				executor: "provider/selected:high",
			});
			expect(settings.getGlobal("modelRoles")).toEqual({ default: "provider/selected:high" });
			expect(settings.getGlobal("task.agentModelOverrides")).toEqual({
				executor: "provider/selected:high",
			});
		});
		it("keeps whole-record runtime resets opaque across later lower layers and cwd clones", async () => {
			await writeSettings({
				modelRoles: { default: "global/default" },
				task: { agentModelOverrides: { executor: "global/executor" } },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.override("modelRoles", null as never);
			settings.override("task.agentModelOverrides", [] as never);
			settings.set("modelRoles", {
				default: "global/default",
				smol: "global/smol-added-after-reset",
			});
			settings.set("task.agentModelOverrides", {
				executor: "global/executor",
				planner: "global/planner-added-after-reset",
			});

			const cloneDir = path.join(testDir, "clone-project");
			fs.mkdirSync(getProjectAgentDir(cloneDir), { recursive: true });
			await Bun.write(
				path.join(getProjectAgentDir(cloneDir), "config.yml"),
				YAML.stringify(
					{
						modelRoles: { slow: "project/slow-added-after-reset" },
						task: { agentModelOverrides: { critic: "project/critic-added-after-reset" } },
					},
					null,
					2,
				),
			);

			const cloned = await settings.cloneForCwd(cloneDir);
			cloned.override("modelRoles", cloned.get("modelRoles"));
			cloned.override("task.agentModelOverrides", cloned.get("task.agentModelOverrides"));
			expect(cloned.get("modelRoles")).toEqual({});
			expect(cloned.get("task.agentModelOverrides")).toEqual({});

			cloned.clearOverride("modelRoles");
			cloned.clearOverride("task.agentModelOverrides");
			expect(cloned.get("modelRoles")).toEqual({
				default: "global/default",
				smol: "global/smol-added-after-reset",
				slow: "project/slow-added-after-reset",
			});
			expect(cloned.get("task.agentModelOverrides")).toEqual({
				executor: "global/executor",
				planner: "global/planner-added-after-reset",
				critic: "project/critic-added-after-reset",
			});
		});
		it("releases only explicitly assigned leaves from a whole-record reset", () => {
			const settings = Settings.isolated();
			settings.set("task.agentModelOverrides", {
				executor: "durable/executor",
				planner: "durable/planner",
			});
			settings.override("task.agentModelOverrides", null as never);

			settings.setAgentModelOverride("executor", "selected/executor");
			expect(settings.get("task.agentModelOverrides")).toEqual({
				executor: "selected/executor",
			});
			settings.clearAgentModelOverride("executor");
			settings.set("task.agentModelOverrides", {
				executor: "durable/executor",
				planner: "durable/planner",
				critic: "durable/critic-added-later",
			});

			expect(settings.get("task.agentModelOverrides")).toEqual({
				executor: "durable/executor",
			});
		});
		it("preserves a newer durable replacement when clearing a released runtime leaf", () => {
			const settings = Settings.isolated();
			settings.override("task.agentModelOverrides", null as never);
			settings.setAgentModelOverride("executor", "selected/executor");
			settings.set("task.agentModelOverrides", {
				executor: "durable/new-executor",
				planner: "durable/planner",
			});

			settings.clearAgentModelOverride("executor");

			expect(settings.getGlobal("task.agentModelOverrides")).toEqual({
				executor: "durable/new-executor",
				planner: "durable/planner",
			});
			expect(settings.get("task.agentModelOverrides")).toEqual({
				executor: "durable/new-executor",
			});
		});

		it("keeps malformed runtime leaves hidden when lower-layer siblings change", () => {
			const settings = Settings.isolated();
			settings.set("task.agentModelOverrides", {
				executor: "durable/executor",
				planner: "durable/planner",
			});
			settings.override("task.agentModelOverrides", { executor: false } as never);
			settings.set("task.agentModelOverrides", {
				executor: "durable/executor-updated",
				planner: "durable/planner",
				critic: "durable/critic-added-after-reset",
			});
			settings.override("task.agentModelOverrides", settings.get("task.agentModelOverrides"));

			expect(settings.get("task.agentModelOverrides")).toEqual({
				planner: "durable/planner",
				critic: "durable/critic-added-after-reset",
			});
			settings.clearOverride("task.agentModelOverrides");
			expect(settings.get("task.agentModelOverrides")).toEqual({
				executor: "durable/executor-updated",
				planner: "durable/planner",
				critic: "durable/critic-added-after-reset",
			});
		});
		it("does not mutate project-only nested resets while rebuilding the merged view", async () => {
			await Bun.write(
				path.join(getProjectAgentDir(projectDir), "config.yml"),
				YAML.stringify(
					{
						modelRoles: null,
						task: { agentModelOverrides: null },
					},
					null,
					2,
				),
			);

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("task.agentModelOverrides")).toEqual({});

			settings.set("modelRoles", {
				default: "durable/default-added-after-project-reset",
			});
			settings.set("task.agentModelOverrides", {
				executor: "durable/added-after-project-reset",
			});
			settings.set("modelRoles", {
				default: "durable/default-updated-again",
				smol: "durable/smol-added-later",
			});
			settings.set("task.agentModelOverrides", {
				executor: "durable/updated-again",
				planner: "durable/planner-added-later",
			});

			expect(settings.get("modelRoles")).toEqual({});
			expect(settings.get("task.agentModelOverrides")).toEqual({});
			const cloned = await settings.cloneForCwd(projectDir);
			expect(cloned.get("modelRoles")).toEqual({});
			expect(cloned.get("task.agentModelOverrides")).toEqual({});
		});
		it("persists project-default suppression and explicit replacement across fresh settings", async () => {
			await Bun.write(
				path.join(getProjectAgentDir(projectDir), "config.yml"),
				YAML.stringify(
					{
						modelProfile: { default: "project-profile" },
					},
					null,
					2,
				),
			);
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const previousPersistedState = settings.getPersistedModelProfileDefaultState();
			const previousRuntimeState = settings.getRuntimeModelProfileDefaultState();
			expect(settings.get("modelProfile.default")).toBe("project-profile");

			settings.persistModelProfileDefaultSuppression();
			settings.suppressModelProfileDefault();
			await settings.flushOrThrow();
			expect(settings.get("modelProfile.default")).toBeUndefined();
			const cloned = await settings.cloneForCwd(projectDir);
			expect(cloned.get("modelProfile.default")).toBeUndefined();

			resetSettingsForTest();
			const fresh = await Settings.init({ cwd: projectDir, agentDir });
			expect(fresh.get("modelProfile.default")).toBeUndefined();

			fresh.restorePersistedModelProfileDefault(previousPersistedState);
			fresh.restoreRuntimeModelProfileDefault(previousRuntimeState);
			expect(fresh.get("modelProfile.default")).toBe("project-profile");
			fresh.set("modelProfile.default", "user-new-default");
			await fresh.flushOrThrow();

			resetSettingsForTest();
			const replaced = await Settings.init({ cwd: projectDir, agentDir });
			expect(replaced.get("modelProfile.default")).toBe("user-new-default");
		});

		it("treats project null model records as resets without partial assignment failures", async () => {
			await writeSettings({
				modelRoles: { default: "global/default" },
				task: { agentModelOverrides: { executor: "global/executor" } },
			});
			await Bun.write(
				path.join(getProjectAgentDir(projectDir), "config.yml"),
				YAML.stringify(
					{
						modelRoles: null,
						task: { agentModelOverrides: null },
					},
					null,
					2,
				),
			);

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("modelRoles")).toEqual({});
			expect(settings.get("task.agentModelOverrides")).toEqual({});

			settings.setModelRole("default", "provider/selected:high");
			for (const role of ["executor", "architect", "planner", "critic"]) {
				settings.setAgentModelOverride(role, "provider/selected:high");
			}

			expect(settings.getModelRole("default")).toBe("provider/selected:high");
			expect(settings.get("task.agentModelOverrides")).toEqual({
				executor: "provider/selected:high",
				architect: "provider/selected:high",
				planner: "provider/selected:high",
				critic: "provider/selected:high",
			});

			await settings.flushOrThrow();
			const savedSettings = await readSettings();
			expect(savedSettings.modelRoles).toEqual({ default: "provider/selected:high" });
			expect(savedSettings.task).toEqual({
				agentModelOverrides: {
					executor: "provider/selected:high",
					architect: "provider/selected:high",
					planner: "provider/selected:high",
					critic: "provider/selected:high",
				},
			});

			settings.clearOverride("modelRoles");
			settings.clearOverride("task.agentModelOverrides");
			expect(settings.get("modelRoles")).toEqual({});
			expect(settings.get("task.agentModelOverrides")).toEqual({});
		});

		it("preserves malformed reset leaves across unrelated runtime record writes", () => {
			const settings = Settings.isolated();
			settings.set("modelRoles", {
				default: "durable/default",
				smol: "durable/smol",
				slow: "durable/slow",
			});
			settings.set("task.agentModelOverrides", {
				executor: "durable/executor",
				planner: "durable/planner",
			});
			settings.override("modelRoles", { smol: false, slow: [] } as never);
			settings.override("task.agentModelOverrides", { executor: false } as never);

			settings.setAgentModelOverride("planner", "selected/planner");
			settings.overrideModelRoles({ plan: "selected/plan" });
			settings.override("modelRoles", settings.get("modelRoles"));
			settings.override("task.agentModelOverrides", settings.get("task.agentModelOverrides"));

			expect(settings.get("modelRoles")).toEqual({
				default: "durable/default",
				plan: "selected/plan",
			});
			expect(settings.get("task.agentModelOverrides")).toEqual({
				planner: "selected/planner",
			});

			settings.clearOverride("modelRoles");
			settings.clearOverride("task.agentModelOverrides");
			expect(settings.get("modelRoles")).toEqual({
				default: "durable/default",
				smol: "durable/smol",
				slow: "durable/slow",
			});
			expect(settings.get("task.agentModelOverrides")).toEqual({
				executor: "durable/executor",
				planner: "selected/planner",
			});
		});

		it("sanitizes malformed model leaves from global public reads", () => {
			const settings = Settings.isolated();
			settings.set("modelRoles", {
				default: "valid/default",
				smol: false,
			} as never);
			settings.set("task.agentModelOverrides", {
				executor: false,
				planner: "valid/planner",
			} as never);

			expect(settings.getGlobal("modelRoles")).toEqual({
				default: "valid/default",
			});
			expect(settings.getGlobal("task.agentModelOverrides")).toEqual({
				planner: "valid/planner",
			});
		});
		it("preserves prototype-like custom agent names through runtime rewrites and cwd clones", async () => {
			const settings = Settings.isolated();

			settings.setAgentModelOverride("__proto__", "provider/model");

			const effective = settings.get("task.agentModelOverrides");
			const global = settings.getGlobal("task.agentModelOverrides");
			expect(Object.hasOwn(effective, "__proto__")).toBe(true);
			expect(Object.getOwnPropertyDescriptor(effective, "__proto__")?.value).toBe("provider/model");
			const runtimeRecord = Object.fromEntries([["__proto__", "runtime/model"]]);
			settings.override("task.agentModelOverrides", runtimeRecord);
			expect(Object.getOwnPropertyDescriptor(settings.get("task.agentModelOverrides"), "__proto__")?.value).toBe(
				"runtime/model",
			);

			const cloned = await settings.cloneForCwd(projectDir);
			expect(Object.getOwnPropertyDescriptor(cloned.get("task.agentModelOverrides"), "__proto__")?.value).toBe(
				"runtime/model",
			);

			settings.clearAgentModelOverride("__proto__");
			expect(Object.getOwnPropertyDescriptor(settings.get("task.agentModelOverrides"), "__proto__")?.value).toBe(
				"provider/model",
			);
			expect(Object.hasOwn(global ?? {}, "__proto__")).toBe(true);
			expect(Object.getOwnPropertyDescriptor(global, "__proto__")?.value).toBe("provider/model");
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

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@gajae-code/ai";
import { onAppendOnlyModeChanged, resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { getCustomThemesDir, getProjectAgentDir, Snowflake } from "@gajae-code/utils";
import { YAML } from "bun";
import { withFileLock } from "../src/config/file-lock";
import { createLightweightDaemonSettings } from "../src/sdk/bus/telegram-daemon-cli";

describe("Settings", () => {
	let testDir: string;
	let agentDir: string;
	let projectDir: string;

	const removeTestDir = () => {
		try {
			fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		} catch (error) {
			if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EBUSY") return;
			throw error;
		}
	};

	beforeEach(() => {
		// Reset global singleton so each test gets a fresh instance
		resetSettingsForTest();

		// Use snowflake to isolate parallel test runs (SQLite files can't be shared)
		testDir = path.join(os.tmpdir(), "test-settings-tmp", Snowflake.next());
		agentDir = path.join(testDir, "agent");
		projectDir = path.join(testDir, "project");

		if (fs.existsSync(testDir)) {
			removeTestDir();
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
			removeTestDir();
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
	describe("IRC sidebar default", () => {
		it("materializes irc.sidebar.enabled=true when the setting is omitted", () => {
			const settings = Settings.isolated();
			expect(settings.get("irc.sidebar.enabled")).toBe(true);
		});

		it("preserves an explicit false value across restart", async () => {
			await writeSettings({ irc: { sidebar: { enabled: false } } });
			let settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("irc.sidebar.enabled")).toBe(false);

			resetSettingsForTest();
			settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("irc.sidebar.enabled")).toBe(false);
		});

		it("lets project settings override the user default", async () => {
			await writeSettings({ irc: { sidebar: { enabled: true } } });
			await Bun.write(
				path.join(getProjectAgentDir(projectDir), "settings.json"),
				JSON.stringify({ irc: { sidebar: { enabled: false } } }),
			);

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("irc.sidebar.enabled")).toBe(false);
		});

		it("falls back without overwriting a corrupt project value", async () => {
			await writeSettings({ irc: { sidebar: { enabled: false } } });
			const projectSettingsPath = path.join(getProjectAgentDir(projectDir), "settings.json");
			await Bun.write(projectSettingsPath, '{"irc":{"sidebar":{"enabled":');

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("irc.sidebar.enabled")).toBe(false);
			expect(await Bun.file(projectSettingsPath).text()).toBe('{"irc":{"sidebar":{"enabled":');
		});

		it("keeps the generated JSON schema default in sync with the settings source", async () => {
			const schema = JSON.parse(
				await Bun.file(new URL("../../../schemas/config.schema.json", import.meta.url)).text(),
			);
			const sidebarDefault = schema?.properties?.irc?.properties?.sidebar?.properties?.enabled?.default;
			expect(sidebarDefault).toBe(true);
		});
	});
	describe("causally ordered atomic persistence", () => {
		it("persists a later durable batch after an earlier ordinary set", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.set("notifications.redact", true);
			await settings.commitAtomicBatch([{ path: "notifications.redact", op: "set", value: false }]);

			expect(settings.get("notifications.redact")).toBe(false);
			expect((await readSettings()).notifications).toEqual({ redact: false });
		});

		it("keeps a later ordinary set live and persists it after an earlier durable batch", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const batch = settings.commitAtomicBatch([{ path: "notifications.redact", op: "set", value: false }]);
			settings.set("notifications.redact", true);

			expect(settings.get("notifications.redact")).toBe(true);
			await batch;
			await settings.flushOrThrow();
			expect((await readSettings()).notifications).toEqual({ redact: true });
		});

		it("exposes an ordinary set and hook before disk completion without reentrant flush deadlock", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const hookValues: string[] = [];
			const unsubscribe = onAppendOnlyModeChanged(value => {
				hookValues.push(value);
				void settings.flush();
			});
			try {
				settings.set("provider.appendOnlyContext", "on");
				expect(settings.get("provider.appendOnlyContext")).toBe("on");
				expect(hookValues).toEqual(["on"]);
				await settings.flushOrThrow();
			} finally {
				unsubscribe();
			}

			expect((await readSettings()).provider).toEqual({ appendOnlyContext: "on" });
		});

		it("unsets a path immediately and persists an explicit YAML deletion", async () => {
			await writeSettings({ modelProfile: { default: "saved-profile" } });
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.unset("modelProfile.default");

			expect(settings.getGlobal("modelProfile.default")).toBeUndefined();
			await settings.flushOrThrow();
			expect((await readSettings()).modelProfile).toEqual({});
		});

		it("does not let an older persistence completion clobber a newer live revision", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			let releaseLock!: () => void;
			let enteredLock!: () => void;
			const lockEntered = new Promise<void>(resolve => {
				enteredLock = resolve;
			});
			const lockRelease = new Promise<void>(resolve => {
				releaseLock = resolve;
			});
			const heldLock = withFileLock(getConfigPath(), async () => {
				enteredLock();
				await lockRelease;
			});
			await lockEntered;

			settings.set("notifications.redact", true);
			const firstFlush = settings.flush();
			await Promise.resolve();
			settings.set("notifications.redact", false);
			releaseLock();
			await heldLock;
			await firstFlush;
			await settings.flushOrThrow();

			expect(settings.get("notifications.redact")).toBe(false);
			expect((await readSettings()).notifications).toEqual({ redact: false });
		});

		it("serializes a lightweight daemon write with a full Settings write", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const daemon = createLightweightDaemonSettings({ agentDir, rawConfig: {} }) as unknown as {
				set(path: string, value: unknown): Promise<void>;
			};
			settings.set("defaultThinkingLevel", Effort.High);

			await Promise.all([settings.flushOrThrow(), daemon.set("notifications.telegram.rich.enabled", false)]);
			expect(await readSettings()).toMatchObject({
				defaultThinkingLevel: Effort.High,
				notifications: { telegram: { rich: { enabled: false } } },
			});
		});
	});

	it("loads the managed session migration policy from scoped settings", async () => {
		await writeSettings({ session: { directoryMigration: "disabled" } });
		const scoped = await Settings.loadForScope({ cwd: projectDir, agentDir });
		expect(scoped.get("session.directoryMigration")).toBe("disabled");
		expect(Settings.isolated().get("session.directoryMigration")).toBe("copy-retain");
	});

	it("rejects invalid managed session migration overrides", () => {
		const invalid = Settings.isolated({ "session.directoryMigration": "merge" });
		expect(invalid.get("session.directoryMigration")).toBe("copy-retain");
	});

	it("keeps the generated schema migration enum and default in sync", async () => {
		const schema = JSON.parse(await Bun.file(new URL("../../../schemas/config.schema.json", import.meta.url)).text());
		const migration = schema?.properties?.session?.properties?.directoryMigration;
		expect(migration?.default).toBe("copy-retain");
		expect(migration?.enum).toEqual(["copy-retain", "disabled"]);
	});
});

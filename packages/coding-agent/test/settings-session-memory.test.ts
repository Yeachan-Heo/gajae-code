import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getDefaultTabWidth, onDefaultTabWidthChange, setDefaultTabWidth } from "@gajae-code/utils";
import { YAML } from "bun";
import type { Settings as SettingsCapabilityItem } from "../src/capability/settings";
import { Settings } from "../src/config/settings";
import {
	getDefault,
	getEnumValues,
	reconcileSettingsSchema,
	SETTINGS_SCHEMA,
	type SettingValue,
} from "../src/config/settings-schema";
import { loadCapability } from "../src/discovery";

const temporaryRoots: string[] = [];

async function createTemporaryRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-settings-snapshot-"));
	temporaryRoots.push(root);
	return root;
}

function projectSettingsPath(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "settings.json");
}

async function writeProjectSettings(cwd: string, data: Record<string, unknown>): Promise<void> {
	const settingsPath = projectSettingsPath(cwd);
	await Bun.write(settingsPath, JSON.stringify(data));
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("sessionMemory settings", () => {
	it("defines automatic size routing alongside explicit modes and defaults to auto", () => {
		const definition = SETTINGS_SCHEMA["sessionMemory.mode"];
		expect(definition.type).toBe("enum");
		expect(getEnumValues("sessionMemory.mode")).toEqual(["off", "shadow", "enabled", "auto"]);
		expect(getDefault("sessionMemory.mode")).toBe("auto");
	});

	it("defaults context overflow recovery to on (preserves the current safe posture)", () => {
		const definition = SETTINGS_SCHEMA["sessionMemory.contextOverflowRecovery"];
		expect(definition.type).toBe("boolean");
		expect(getDefault("sessionMemory.contextOverflowRecovery")).toBe(true);
	});

	it("exposes typed defaults through the schema helpers", () => {
		const mode: SettingValue<"sessionMemory.mode"> = "auto";
		const recovery: SettingValue<"sessionMemory.contextOverflowRecovery"> = true;
		expect(getDefault("sessionMemory.mode")).toBe(mode);
		expect(getDefault("sessionMemory.contextOverflowRecovery")).toBe(recovery);
	});

	it.each(["off", "shadow", "enabled", "auto"] as const)("accepts mode %s and an explicit recovery off", mode => {
		const reconciled = reconcileSettingsSchema({
			sessionMemory: { mode, contextOverflowRecovery: false },
		});

		expect(reconciled.report.valid).toBe(true);
		expect(reconciled.settings.sessionMemory).toEqual({ mode, contextOverflowRecovery: false });
	});

	it("rejects out-of-enum modes (canary/default-on are release-channel states, not values)", () => {
		const reconciled = reconcileSettingsSchema({ sessionMemory: { mode: "canary" } });

		expect(reconciled.report.valid).toBe(false);
		expect(reconciled.report.issues).toContainEqual({
			path: "sessionMemory.mode",
			kind: "invalid",
			detail: "Expected enum.",
		});
	});

	it("rejects non-boolean context overflow recovery values", () => {
		const reconciled = reconcileSettingsSchema({ sessionMemory: { contextOverflowRecovery: "yes" } });

		expect(reconciled.report.valid).toBe(false);
		expect(reconciled.report.issues).toContainEqual({
			path: "sessionMemory.contextOverflowRecovery",
			kind: "invalid",
			detail: "Expected boolean.",
		});
	});

	it("leaves defaults stable under an empty config (no schema-side materialization)", () => {
		const reconciled = reconcileSettingsSchema({});

		expect(reconciled.report.valid).toBe(true);
		expect(reconciled.settings).toEqual({});
	});
});

describe("Settings.snapshotForCwd", () => {
	it("normalizes global and target project settings without mutating the parent or firing global hooks", async () => {
		const originalTabWidth = getDefaultTabWidth();
		const parentTabWidth = originalTabWidth === 4 ? 5 : 4;
		const targetTabWidth = parentTabWidth === 4 ? 5 : 4;
		const observedTabWidths: number[] = [];
		const removeTabWidthListener = onDefaultTabWidthChange(width => observedTabWidths.push(width));
		try {
			const root = await createTemporaryRoot();
			const parentCwd = path.join(root, "parent");
			const targetCwd = path.join(root, "target");
			const agentDir = path.join(root, "agent");
			const globalConfigPath = path.join(agentDir, "config.yml");
			await fs.mkdir(agentDir, { recursive: true });
			await fs.mkdir(parentCwd, { recursive: true });
			await writeProjectSettings(parentCwd, { ask: { timeout: 15_000 } });
			await writeProjectSettings(targetCwd, {
				ask: { timeout: 60_000 },
				display: { tabWidth: targetTabWidth },
			});
			const globalConfig = {
				ask: { timeout: 30_000 },
				display: { tabWidth: parentTabWidth },
				theme: { dark: "red-claw", light: "blue-crab" },
			};
			await Bun.write(globalConfigPath, YAML.stringify(globalConfig, null, 2));
			const globalConfigBefore = await Bun.file(globalConfigPath).text();
			const parentSettingsPath = projectSettingsPath(parentCwd);
			const parentSettingsBefore = await Bun.file(parentSettingsPath).text();
			const targetSettingsPath = projectSettingsPath(targetCwd);
			const targetSettingsBefore = await Bun.file(targetSettingsPath).text();

			const parent = await Settings.loadReadonly({ cwd: parentCwd, agentDir });
			expect(parent.getGlobal("ask.timeout")).toBe(30);
			expect(parent.get("ask.timeout")).toBe(15);
			expect(getDefaultTabWidth()).toBe(parentTabWidth);
			observedTabWidths.length = 0;
			const changedPaths: string[] = [];
			const unsubscribe = parent.onChanged(settingPath => changedPaths.push(settingPath));
			try {
				const target = await parent.snapshotForCwd(targetCwd);
				expect(target.getCwd()).toBe(targetCwd);
				expect(target.getGlobal("ask.timeout")).toBe(30);
				expect(target.get("ask.timeout")).toBe(60);
				expect(target.get("display.tabWidth")).toBe(targetTabWidth);
				expect(parent.getCwd()).toBe(parentCwd);
				expect(parent.get("ask.timeout")).toBe(15);
				expect(observedTabWidths).toEqual([]);
				expect(getDefaultTabWidth()).toBe(parentTabWidth);
				expect(changedPaths).toEqual([]);

				parent.override("ask.timeout", 45);
				const changeCount = changedPaths.length;
				const overridden = await parent.snapshotForCwd(targetCwd);
				expect(overridden.getGlobal("ask.timeout")).toBe(30);
				expect(overridden.get("ask.timeout")).toBe(45);
				overridden.clearOverride("ask.timeout");
				expect(overridden.get("ask.timeout")).toBe(60);
				expect(parent.get("ask.timeout")).toBe(45);
				expect(parent.getCwd()).toBe(parentCwd);
				expect(changedPaths).toHaveLength(changeCount);
				expect(observedTabWidths).toEqual([]);
				expect(getDefaultTabWidth()).toBe(parentTabWidth);
			} finally {
				unsubscribe();
			}

			expect(await Bun.file(globalConfigPath).text()).toBe(globalConfigBefore);
			expect(await Bun.file(parentSettingsPath).text()).toBe(parentSettingsBefore);
			expect(await Bun.file(targetSettingsPath).text()).toBe(targetSettingsBefore);
		} finally {
			removeTabWidthListener();
			setDefaultTabWidth(originalTabWidth);
		}
	});

	it("loads different target directories and refreshes an edited cached target file", async () => {
		const root = await createTemporaryRoot();
		const targetA = path.join(root, "target-a");
		const targetB = path.join(root, "target-b");
		const parent = Settings.isolated({ "ask.timeout": 5 });
		await writeProjectSettings(targetA, { ask: { timeout: 30_000 } });
		await writeProjectSettings(targetB, { ask: { timeout: 120_000 } });

		const firstA = await loadCapability<SettingsCapabilityItem>("settings", {
			cwd: targetA,
			includeDisabledProviders: true,
		});
		const firstB = await loadCapability<SettingsCapabilityItem>("settings", {
			cwd: targetB,
			includeDisabledProviders: true,
		});
		const settingsAPath = projectSettingsPath(targetA);
		const itemA = firstA.items.find(item => item.level === "project" && item.path === settingsAPath);
		expect(itemA?.data.ask).toEqual({ timeout: 30_000 });
		const itemB = firstB.items.find(item => item.level === "project" && item.path === projectSettingsPath(targetB));
		expect(itemB?.data.ask).toEqual({ timeout: 120_000 });

		await writeProjectSettings(targetA, { ask: { timeout: 60_000 } });
		const ordinaryReload = await loadCapability<SettingsCapabilityItem>("settings", {
			cwd: targetA,
			includeDisabledProviders: true,
		});
		const cachedItemA = ordinaryReload.items.find(item => item.level === "project" && item.path === settingsAPath);
		expect(cachedItemA?.data.ask).toEqual({ timeout: 30_000 });

		const snapshotA = await parent.snapshotForCwd(targetA);
		const snapshotB = await parent.snapshotForCwd(targetB);
		const refreshedA = await parent.snapshotForCwd(targetA);
		expect(snapshotA.get("ask.timeout")).toBe(60);
		expect(snapshotB.get("ask.timeout")).toBe(120);
		expect(refreshedA.get("ask.timeout")).toBe(60);
		expect(parent.get("ask.timeout")).toBe(5);
	});

	it("tolerates absent and malformed target settings files", async () => {
		const root = await createTemporaryRoot();
		const absentCwd = path.join(root, "absent");
		const malformedCwd = path.join(root, "malformed");
		const parent = Settings.isolated({ "ask.timeout": 9 });
		const absent = await parent.snapshotForCwd(absentCwd);

		const malformedPath = projectSettingsPath(malformedCwd);
		await Bun.write(malformedPath, '{"ask":');
		const malformed = await parent.snapshotForCwd(malformedCwd);

		expect(absent.getCwd()).toBe(absentCwd);
		expect(absent.get("ask.timeout")).toBe(9);
		expect(malformed.getCwd()).toBe(malformedCwd);
		expect(malformed.get("ask.timeout")).toBe(9);
	});
});

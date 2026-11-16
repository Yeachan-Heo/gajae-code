import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { KeybindingsManager } from "@gajae-code/coding-agent/config/keybindings";
import { resetSettingsForTest, Settings, settings } from "@gajae-code/coding-agent/config/settings";
import {
	type SettingsCallbacks,
	SettingsSelectorComponent,
} from "@gajae-code/coding-agent/modes/components/settings-selector";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { setKeybindings } from "@gajae-code/tui";

let testDir: string;
let configPath: string;
let owner: Settings;
const components: SettingsSelectorComponent[] = [];

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

beforeEach(async () => {
	resetSettingsForTest();
	testDir = await fs.mkdtemp(path.join(os.tmpdir(), "settings-thinking-commit-"));
	await Settings.init({ inMemory: true, cwd: testDir, agentDir: path.join(testDir, "global") });
	settings.set("defaultThinkingLevel", ThinkingLevel.Minimal);
	const agentDir = path.join(testDir, "owner");
	configPath = path.join(agentDir, "config.yml");
	await Bun.write(configPath, "defaultThinkingLevel: low\n");
	owner = await Settings.loadForScope({ cwd: testDir, agentDir });
	await owner.flushOrThrow();
	setKeybindings(KeybindingsManager.inMemory());
});

afterEach(async () => {
	for (const component of components.splice(0)) component.dispose();
	vi.restoreAllMocks();
	await owner.close();
	resetSettingsForTest();
	await fs.rm(testDir, { recursive: true, force: true });
});

function createSelector(onChange: SettingsCallbacks["onChange"]): {
	component: SettingsSelectorComponent;
	errors: string[];
	renderRequests: string[];
	rendered: Promise<void>;
} {
	const errors: string[] = [];
	const renderRequests: string[] = [];
	const rendered = Promise.withResolvers<void>();
	const component = new SettingsSelectorComponent(
		{
			settings: owner,
			availableThinkingLevels: [ThinkingLevel.Low, ThinkingLevel.High],
			thinkingLevel: ThinkingLevel.Low,
			availableThemes: ["red-claw", "blue-crab"],
			availableModelProfiles: [],
			cwd: testDir,
		},
		{
			onChange,
			onError: message => {
				errors.push(message);
			},
			onRenderRequested: () => {
				renderRequests.push("render");
				rendered.resolve();
			},
			onCancel: () => {},
		},
	);
	components.push(component);
	return { component, errors, renderRequests, rendered: rendered.promise };
}

function render(component: SettingsSelectorComponent): string {
	return Bun.stripANSI(component.render(120).join("\n"));
}

function selectHighThinking(component: SettingsSelectorComponent): void {
	component.handleInput("\x1b[C"); // Model tab.
	for (const character of "thinking level") component.handleInput(character);
	component.handleInput("\n"); // Open Thinking Level, preselected on low.
	component.handleInput("\x1b[B"); // Select high.
	component.handleInput("\n"); // Submit through the real submenu.
}

async function configBytes(): Promise<Uint8Array> {
	return new Uint8Array(await Bun.file(configPath).arrayBuffer());
}

describe("SettingsSelectorComponent thinking commit", () => {
	it("keeps the draft and saved settings unchanged until the session-owned commit succeeds", async () => {
		const admitted = Promise.withResolvers<void>();
		const changes: Array<{ path: string; value: unknown; previous: unknown }> = [];
		const { component, errors, renderRequests, rendered } = createSelector(async (settingPath, value) => {
			changes.push({ path: settingPath, value, previous: owner.get("defaultThinkingLevel") });
			await admitted.promise;
			owner.set("defaultThinkingLevel", value as ThinkingLevel);
			await owner.flushOrThrow();
		});
		const before = await configBytes();

		selectHighThinking(component);
		component.handleInput("\n"); // A pending commit cannot be submitted twice.
		await Bun.sleep(1);

		expect(changes).toEqual([
			{ path: "defaultThinkingLevel", value: ThinkingLevel.High, previous: ThinkingLevel.Low },
		]);
		expect(owner.get("defaultThinkingLevel")).toBe(ThinkingLevel.Low);
		expect(settings.get("defaultThinkingLevel")).toBe(ThinkingLevel.Minimal);
		expect(await configBytes()).toEqual(before);
		expect(render(component)).toContain("Enter to select");
		expect(renderRequests).toEqual([]);

		admitted.resolve();
		await rendered;

		expect(owner.get("defaultThinkingLevel")).toBe(ThinkingLevel.High);
		expect(settings.get("defaultThinkingLevel")).toBe(ThinkingLevel.Minimal);
		expect(await Bun.file(configPath).text()).toContain("defaultThinkingLevel: high");
		expect(render(component)).not.toContain("Enter to select");
		expect(render(component)).toMatch(/Thinking Level\s+high/);
		expect(renderRequests).toEqual(["render"]);
		expect(errors).toEqual([]);
	});

	it("accepts a synchronous session-owned callback without persisting a second time", async () => {
		const previousValues: unknown[] = [];
		const set = vi.spyOn(owner, "set");
		const { component, errors, renderRequests, rendered } = createSelector((_settingPath, value) => {
			previousValues.push(owner.get("defaultThinkingLevel"));
			owner.set("defaultThinkingLevel", value as ThinkingLevel);
		});

		selectHighThinking(component);
		await rendered;
		await owner.flushOrThrow();

		expect(previousValues).toEqual([ThinkingLevel.Low]);
		expect(set).toHaveBeenCalledTimes(1);
		expect(set).toHaveBeenCalledWith("defaultThinkingLevel", ThinkingLevel.High);
		expect(owner.get("defaultThinkingLevel")).toBe(ThinkingLevel.High);
		expect(settings.get("defaultThinkingLevel")).toBe(ThinkingLevel.Minimal);
		expect(render(component)).not.toContain("Enter to select");
		expect(render(component)).toMatch(/Thinking Level\s+high/);
		expect(renderRequests).toEqual(["render"]);
		expect(errors).toEqual([]);
	});

	it("reports a rejected admission without changing config bytes or accepting the submenu", async () => {
		const admission = Promise.withResolvers<void>();
		const { component, errors, renderRequests } = createSelector(() => admission.promise);
		const before = await configBytes();

		selectHighThinking(component);
		admission.reject(new Error("shared session is busy"));
		await Bun.sleep(1);

		expect(owner.get("defaultThinkingLevel")).toBe(ThinkingLevel.Low);
		expect(settings.get("defaultThinkingLevel")).toBe(ThinkingLevel.Minimal);
		expect(await configBytes()).toEqual(before);
		expect(errors).toEqual(["shared session is busy"]);
		expect(renderRequests).toEqual([]);
		expect(render(component)).toContain("Enter to select");
		component.handleInput("\x1b"); // Cancelling still returns to the unchanged saved row.
		expect(render(component)).toMatch(/Thinking Level\s+low/);
	});

	it("handles a synchronous control throw without changing config bytes or accepting the submenu", async () => {
		const { component, errors, renderRequests } = createSelector(() => {
			throw new Error("config is not writable");
		});
		const before = await configBytes();

		selectHighThinking(component);
		await Bun.sleep(1);

		expect(owner.get("defaultThinkingLevel")).toBe(ThinkingLevel.Low);
		expect(settings.get("defaultThinkingLevel")).toBe(ThinkingLevel.Minimal);
		expect(await configBytes()).toEqual(before);
		expect(errors).toEqual(["config is not writable"]);
		expect(renderRequests).toEqual([]);
		expect(render(component)).toContain("Enter to select");
		component.handleInput("\x1b");
		expect(render(component)).toMatch(/Thinking Level\s+low/);
	});
});

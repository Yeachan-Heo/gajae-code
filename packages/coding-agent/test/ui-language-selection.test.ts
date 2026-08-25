import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
	reconcileSettingsSchema,
	resetSettingsForTest,
	Settings,
	settings,
	validateSettingPatch,
} from "@gajae-code/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@gajae-code/coding-agent/modes/components/settings-selector";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { parseUiLanguage, resolveUiLanguage, uiString } from "@gajae-code/coding-agent/modes/ui-language";
import { executeBuiltinSlashCommand } from "@gajae-code/coding-agent/slash-commands/builtin-registry";

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

function createSelector(): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["red-claw", "blue-crab"],
			availableModelProfiles: [],
			cwd: process.cwd(),
		},
		{
			onChange: () => {},
			onCancel: () => {},
			getStatusLinePreview: () => "status-preview",
		},
	);
}

describe("interactive UI language selection", () => {
	it("defaults invalid and unavailable selections to English", () => {
		expect(resolveUiLanguage(undefined)).toBe("en");
		expect(resolveUiLanguage("fr")).toBe("en");
		expect(uiString("fr", "settings.title")).toBe("Settings");

		const reconciled = reconcileSettingsSchema({ ui: { language: "fr" } });
		expect(reconciled.report.valid).toBe(false);
		expect(reconciled.settings.ui).toEqual({ language: "fr" });
		expect(validateSettingPatch({ "ui.language": "ko" })).toEqual([]);
		expect(validateSettingPatch({ "ui.language": "fr" })).toEqual([
			{ path: "ui.language", detail: "Expected enum." },
		]);
	});

	it("renders persisted Korean settings chrome without changing canonical values", () => {
		settings.set("ui.language", "ko");
		const selector = createSelector();
		const rendered = selector.render(160).map(Bun.stripANSI).join("\n");

		expect(rendered).toContain("설정:");
		expect(rendered).toContain("화면");
		expect(rendered).toContain("언어");
		expect(settings.get("ui.language")).toBe("ko");

		selector.handleInput("\x1b[B"); // Light Theme
		selector.handleInput("\x1b[B"); // Language
		selector.handleInput("\n");
		const submenu = selector.render(160).map(Bun.stripANSI).join("\n");
		expect(submenu).toContain("언어");
		expect(submenu).toContain("사람이 읽는 대화형 UI 텍스트의 언어");
		expect(submenu).toContain("한국어");
	});

	it("keeps the operator language authoritative over runtime overrides", () => {
		expect(
			Settings.isolated({ "ui.language": "ko" }, { overrides: { "ui.language": "en" } }).get("ui.language"),
		).toBe("ko");
		expect(Settings.isolated({}, { overrides: { "ui.language": "ko" } }).get("ui.language")).toBe("en");
	});

	it("persists a user selection and refreshes the open settings surface", () => {
		const selector = createSelector();
		selector.handleInput("\x1b[B"); // Light Theme
		selector.handleInput("\x1b[B"); // Language
		selector.handleInput("\n");
		selector.handleInput("\x1b[B"); // Korean
		selector.handleInput("\n");

		const rendered = selector.render(160).map(Bun.stripANSI).join("\n");
		expect(settings.get("ui.language")).toBe("ko");
		expect(rendered).toContain("설정:");
		expect(rendered).toContain("언어");
		expect(rendered).toContain("미리보기:");
	});
});

describe("/language slash command", () => {
	function harness(options: { canWriteDurableConfig?: boolean } = {}) {
		const status: string[] = [];
		const errors: string[] = [];
		const ctx = {
			settings: {
				get: (path: "ui.language") => settings.get(path),
				has: (path: "ui.language") => settings.has(path),
				set: (path: "ui.language", value: "en" | "ko") => settings.set(path, value),
				canWriteDurableConfig: () => options.canWriteDurableConfig ?? settings.canWriteDurableConfig(),
			},
			editor: { setText: () => {} },
			statusLine: { invalidate: () => {} },
			ui: { invalidate: () => {} },
			showStatus: (text: string) => status.push(text),
			showError: (text: string) => errors.push(text),
		};
		return { status, errors, runtime: { ctx, handleBackgroundCommand: () => {} } };
	}

	it("reports the current language without arguments", async () => {
		const { status, runtime } = harness();

		expect(await executeBuiltinSlashCommand("/language", runtime as never)).toBe(true);

		expect(status[0]).toContain("Current UI language: English");
		expect(settings.has("ui.language")).toBe(false);
	});

	it("persists a canonical code and confirms in the selected language", async () => {
		const { status, runtime } = harness();

		expect(await executeBuiltinSlashCommand("/language ko", runtime as never)).toBe(true);

		expect(settings.get("ui.language")).toBe("ko");
		expect(status[0]).toContain("한국어");
	});

	it("accepts endonym, English-name, ISO, and locale-tag spellings", async () => {
		expect(parseUiLanguage("한국어")).toBe("ko");
		expect(parseUiLanguage("Korean")).toBe("ko");
		expect(parseUiLanguage("kr")).toBe("ko");
		expect(parseUiLanguage("kor")).toBe("ko");
		expect(parseUiLanguage("ko-KR")).toBe("ko");
		expect(parseUiLanguage("eng")).toBe("en");
		expect(parseUiLanguage("en-US")).toBe("en");
		expect(parseUiLanguage("fr")).toBeUndefined();
		expect(parseUiLanguage("fr-FR")).toBeUndefined();

		const korean = harness();
		await executeBuiltinSlashCommand("/language 한국어", korean.runtime as never);
		expect(settings.get("ui.language")).toBe("ko");

		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		const locale = harness();
		await executeBuiltinSlashCommand("/language ko-KR", locale.runtime as never);
		expect(settings.get("ui.language")).toBe("ko");

		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		const english = harness();
		await executeBuiltinSlashCommand("/language English", english.runtime as never);
		expect(settings.get("ui.language")).toBe("en");
	});

	it("rejects an unsupported language and changes nothing", async () => {
		settings.set("ui.language", "ko");
		const { errors, runtime } = harness();

		expect(await executeBuiltinSlashCommand("/language fr", runtime as never)).toBe(true);

		expect(errors[0]).toContain("알 수 없는 언어");
		expect(errors[0]).toContain("ko (한국어)");
		expect(settings.get("ui.language")).toBe("ko");
	});

	it("refuses to persist when durable config cannot be written", async () => {
		const { errors, runtime } = harness({ canWriteDurableConfig: false });

		expect(await executeBuiltinSlashCommand("/language ko", runtime as never)).toBe(true);

		expect(errors[0]).toContain("Cannot change settings while config.yml has invalid YAML syntax");
		expect(settings.has("ui.language")).toBe(false);
	});
});

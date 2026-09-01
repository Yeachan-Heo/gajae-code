import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import {
	reconcileSettingsSchema,
	resetSettingsForTest,
	Settings,
	settings,
	validateSettingPatch,
} from "@gajae-code/coding-agent/config/settings";
import { InterfaceLanguageSelectorComponent } from "@gajae-code/coding-agent/modes/components/frictionless-onboarding-selector";
import { SettingsSelectorComponent } from "@gajae-code/coding-agent/modes/components/settings-selector";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import {
	parseUiLanguage,
	resolveExplicitUiLanguage,
	resolveUiLanguage,
	uiString,
} from "@gajae-code/coding-agent/modes/ui-language";
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
	it("offers the four supported languages before onboarding guidance", () => {
		let selected: string | undefined;
		const selector = new InterfaceLanguageSelectorComponent(
			language => {
				selected = language;
			},
			() => {},
		);
		const rendered = selector.render(160).map(Bun.stripANSI).join("\n");

		expect(rendered).toContain("Choose your interface language");
		expect(rendered).toContain("English");
		expect(rendered).toContain("한국어");
		expect(rendered).toContain("简体中文");
		expect(rendered).toContain("日本語");

		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		expect(selected).toBe("zh");
	});

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

	it("uses deterministic English fallback for invalid explicit startup language", () => {
		expect(resolveExplicitUiLanguage(undefined, undefined)).toEqual({ language: "en", hasPreference: false });
		expect(resolveExplicitUiLanguage(undefined, "zh-CN")).toEqual({ language: "zh", hasPreference: true });
		expect(resolveExplicitUiLanguage(undefined, "fr-FR")).toEqual({ language: "en", hasPreference: true });
		expect(resolveExplicitUiLanguage("ko", "en-US")).toEqual({ language: "ko", hasPreference: true });
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

	it("renders persisted Japanese settings chrome and offers it as a select option", () => {
		settings.set("ui.language", "ja");
		const selector = createSelector();
		const rendered = selector.render(160).map(Bun.stripANSI).join("\n");

		expect(rendered).toContain("設定:");
		expect(rendered).toContain("外観");
		expect(rendered).toContain("言語");
		expect(settings.get("ui.language")).toBe("ja");

		selector.handleInput("\x1b[B"); // Light Theme
		selector.handleInput("\x1b[B"); // Language
		selector.handleInput("\n");
		const submenu = selector.render(160).map(Bun.stripANSI).join("\n");
		expect(submenu).toContain("言語");
		expect(submenu).toContain("対話型 UI テキストに使う言語");
		expect(submenu).toContain("日本語");
	});

	it("renders persisted Simplified Chinese settings chrome", () => {
		settings.set("ui.language", "zh");
		const selector = createSelector();
		const rendered = selector.render(160).map(Bun.stripANSI).join("\n");

		expect(rendered).toContain("设置:");
		expect(rendered).toContain("外观");
		expect(rendered).toContain("语言");
		expect(settings.get("ui.language")).toBe("zh");
	});

	it("validates Japanese in the settings enum patch surface", () => {
		expect(validateSettingPatch({ "ui.language": "ja" })).toEqual([]);
		expect(validateSettingPatch({ "ui.language": "zh" })).toEqual([]);
	});

	it("keeps the operator language authoritative over runtime overrides", () => {
		expect(
			Settings.isolated({ "ui.language": "ko" }, { overrides: { "ui.language": "en" } }).get("ui.language"),
		).toBe("ko");
		expect(Settings.isolated({}, { overrides: { "ui.language": "ko" } }).get("ui.language")).toBe("en");
	});

	it("reloads a selected language from durable config", async () => {
		const agentDir = await fs.mkdtemp(`${process.env.TMPDIR ?? "/tmp"}/gjc-language-`);
		resetSettingsForTest();
		const durable = await Settings.init({ agentDir, cwd: agentDir });
		durable.set("ui.language", "zh");
		await durable.flushOrThrow();
		await durable.close();

		resetSettingsForTest();
		const reloaded = await Settings.init({ agentDir, cwd: agentDir });
		try {
			expect(reloaded.has("ui.language")).toBe(true);
			expect(reloaded.get("ui.language")).toBe("zh");
		} finally {
			await reloaded.close();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
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
				set: (path: "ui.language", value: "en" | "ko" | "zh" | "ja") => settings.set(path, value),
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

	it("persists the Japanese canonical code and confirms in Japanese", async () => {
		const { status, runtime } = harness();

		expect(await executeBuiltinSlashCommand("/language ja", runtime as never)).toBe(true);

		expect(settings.get("ui.language")).toBe("ja");
		expect(status[0]).toContain("UI 言語を次に変更しました:");
		expect(status[0]).toContain("日本語");
	});

	it("accepts Japanese endonym, English-name, ISO, and locale-tag spellings", async () => {
		expect(parseUiLanguage("日本語")).toBe("ja");
		expect(parseUiLanguage("Japanese")).toBe("ja");
		expect(parseUiLanguage("jp")).toBe("ja");
		expect(parseUiLanguage("jpn")).toBe("ja");
		expect(parseUiLanguage("ja-JP")).toBe("ja");
		expect(parseUiLanguage("한국어")).toBe("ko");
		expect(parseUiLanguage("Korean")).toBe("ko");
		expect(parseUiLanguage("kr")).toBe("ko");
		expect(parseUiLanguage("kor")).toBe("ko");
		expect(parseUiLanguage("ko-KR")).toBe("ko");
		expect(parseUiLanguage("eng")).toBe("en");
		expect(parseUiLanguage("en-US")).toBe("en");
		expect(parseUiLanguage("fr")).toBeUndefined();
		expect(parseUiLanguage("fr-FR")).toBeUndefined();
		expect(parseUiLanguage("中文")).toBe("zh");
		expect(parseUiLanguage("zh-CN")).toBe("zh");
	});

	it("never returns inherited object properties for hostile inputs", () => {
		expect(parseUiLanguage("__proto__")).toBeUndefined();
		expect(parseUiLanguage("constructor")).toBeUndefined();
		expect(parseUiLanguage("constructor-anything")).toBeUndefined();
		expect(parseUiLanguage("toString")).toBeUndefined();
		expect(parseUiLanguage("valueOf")).toBeUndefined();
		expect(parseUiLanguage("hasOwnProperty")).toBeUndefined();
		expect(parseUiLanguage("__proto__-ko")).toBeUndefined();
	});

	it("persists endonym, English-name, and locale-tag spellings through the command", async () => {
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

	it("persists Japanese endonym and locale-tag spellings through the command", async () => {
		const endonym = harness();
		await executeBuiltinSlashCommand("/language 日本語", endonym.runtime as never);
		expect(settings.get("ui.language")).toBe("ja");

		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		const locale = harness();
		await executeBuiltinSlashCommand("/language ja-JP", locale.runtime as never);
		expect(settings.get("ui.language")).toBe("ja");
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

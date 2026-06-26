import { afterEach, describe, expect, it, vi } from "bun:test";
import { SETTINGS_SCHEMA } from "../src/config/settings-schema";
import { TEMPLATE } from "../src/export/html/template.generated";
import { STATUS_LINE_PRESETS } from "../src/modes/components/status-line/presets";
import { defaultThemes } from "../src/modes/theme/defaults";
import blueCrabTheme from "../src/modes/theme/defaults/blue-crab.json" with { type: "json" };
import redClawTheme from "../src/modes/theme/defaults/red-claw.json" with { type: "json" };
import * as themeModule from "../src/modes/theme/theme";
import { ACP_BUILTIN_SLASH_COMMANDS } from "../src/slash-commands/acp-builtins";
import { lookupBuiltinSlashCommand } from "../src/slash-commands/builtin-registry";

describe("GJC red-claw redesign defaults", () => {
	afterEach(() => {
		themeModule.stopThemeWatcher();
		vi.restoreAllMocks();
	});

	it("uses red-claw as the default dark theme and blue-crab as the default light theme", async () => {
		themeModule.onTerminalAppearanceChange("dark");
		await themeModule.initTheme(false);

		expect(SETTINGS_SCHEMA["theme.dark"].default).toBe("red-claw");
		expect(SETTINGS_SCHEMA["theme.light"].default).toBe("blue-crab");
		expect(themeModule.getCurrentThemeName()).toBe("red-claw");

		themeModule.onTerminalAppearanceChange("light");
		await themeModule.initTheme(false);
		expect(themeModule.getCurrentThemeName()).toBe("blue-crab");
	});

	it("keeps red-claw brand tokens separate from semantic warning/error/diff tokens", async () => {
		const colors = await themeModule.getResolvedThemeColors("red-claw");
		const vars = redClawTheme.vars;

		expect(vars.brandRed).toBeDefined();
		expect(vars.claw).toBeDefined();
		expect(vars.coral).toBeDefined();
		expect(vars.shell).toBeDefined();
		expect(vars.dangerRed).toBeDefined();
		expect(vars.warningAmber).toBeDefined();
		expect(vars.diffRemovalRed).toBeDefined();

		expect(colors.accent).toBe(vars.claw);
		expect(colors.borderAccent).toBe(vars.brandRed);
		expect(colors.error).toBe(vars.dangerRed);
		expect(colors.warning).toBe(vars.warningAmber);
		expect(colors.toolDiffRemoved).toBe(vars.diffRemovalRed);
		expect(new Set([colors.accent, colors.error, colors.warning, colors.toolDiffRemoved]).size).toBe(4);
	});

	it("exposes bundled selectable themes while preserving red-claw and blue-crab defaults", async () => {
		const themes = await themeModule.getAvailableThemes();

		expect(themes).toEqual(["blue-crab", "claude-code", "codex", "gruvbox-dark", "opencode", "red-claw"]);
		expect(Object.keys(defaultThemes).sort()).toEqual([
			"blue-crab",
			"claude-code",
			"codex",
			"gruvbox-dark",
			"opencode",
			"red-claw",
		]);
		expect(SETTINGS_SCHEMA["theme.dark"].default).toBe("red-claw");
		expect(SETTINGS_SCHEMA["theme.light"].default).toBe("blue-crab");
	});

	it("validates every bundled built-in theme against the schema-required token set", async () => {
		for (const [key, themeJson] of Object.entries(defaultThemes)) {
			// Registered map key must equal the theme's declared name.
			expect((themeJson as { name: string }).name, key).toBe(key);

			const colorKeys = Object.keys((themeJson as { colors: Record<string, unknown> }).colors);
			for (const token of themeModule.THEME_COLOR_KEYS) {
				expect(colorKeys, `${key} missing required token ${token}`).toContain(token);
			}

			// Var references resolve without missing/circular errors.
			const resolved = await themeModule.getResolvedThemeColors(key);
			expect(Object.keys(resolved).length, key).toBeGreaterThan(0);
		}
	});

	it("keeps migration themes dark-classified with distinct semantic tokens and no dead link token", async () => {
		for (const name of ["claude-code", "codex", "opencode"] as const) {
			const themeJson = defaultThemes[name] as {
				colors: Record<string, unknown>;
				symbols?: { overrides?: Record<string, unknown> };
			};
			// Do not carry the legacy non-schema `link` token into migration themes.
			expect(Object.keys(themeJson.colors), `${name} has dead link token`).not.toContain("link");

			// Migration themes keep GJC's symbol identity: preset only, no crab/source-tool overrides.
			expect(themeJson.symbols?.overrides, `${name} must not override GJC symbols`).toBeUndefined();

			expect(themeModule.isLightTheme(name), `${name} should classify as dark`).toBe(false);

			const colors = await themeModule.getResolvedThemeColors(name);
			expect(
				new Set([colors.accent, colors.error, colors.warning, colors.toolDiffRemoved]).size,
				`${name} semantic tokens must be distinct`,
			).toBe(4);
		}
	});

	it("uses concrete hex for codex semantic, background, status, and diff tokens", async () => {
		const colors = await themeModule.getResolvedThemeColors("codex");
		const hex = /^#[0-9a-fA-F]{6}$/;
		for (const token of [
			"accent",
			"error",
			"warning",
			"toolDiffRemoved",
			"toolDiffAdded",
			"userMessageBg",
			"selectedBg",
			"customMessageBg",
			"toolPendingBg",
			"toolSuccessBg",
			"toolErrorBg",
			"statusLineBg",
		]) {
			expect(colors[token], `codex ${token} must be concrete hex`).toMatch(hex);
		}
	});

	it("keeps blue-crab coastal tokens separate from semantic warning/error/diff tokens", async () => {
		const colors = await themeModule.getResolvedThemeColors("blue-crab");
		const vars = blueCrabTheme.vars;

		expect(vars.brandBlue).toBeDefined();
		expect(vars.claw).toBeDefined();
		expect(vars.seafoam).toBeDefined();
		expect(vars.sand).toBeDefined();
		expect(vars.dangerRed).toBeDefined();
		expect(vars.warningAmber).toBeDefined();
		expect(vars.diffRemovalRed).toBeDefined();

		expect(colors.accent).toBe(vars.claw);
		expect(colors.borderAccent).toBe(vars.brandBlue);
		expect(colors.error).toBe(vars.dangerRed);
		expect(colors.warning).toBe(vars.warningAmber);
		expect(colors.toolDiffRemoved).toBe(vars.diffRemovalRed);
		expect(new Set([colors.accent, colors.error, colors.warning, colors.toolDiffRemoved]).size).toBe(4);
	});

	it("exposes /theme only for TUI selection, not ACP text clients", () => {
		const command = lookupBuiltinSlashCommand("theme");

		expect(command?.handleTui).toBeDefined();
		expect(command?.handle).toBeUndefined();
		expect(ACP_BUILTIN_SLASH_COMMANDS.map(item => item.name)).not.toContain("theme");
	});

	it("keeps public status presets on the GJC identity", () => {
		expect(SETTINGS_SCHEMA["statusLine.separator"].default).toBe("slash");
		expect(STATUS_LINE_PRESETS.default.leftSegments).not.toContain("pi");
		expect(STATUS_LINE_PRESETS.default.separator).toBe("slash");
		expect(STATUS_LINE_PRESETS.full.leftSegments).toContain("gajae");
		expect(STATUS_LINE_PRESETS.nerd.leftSegments).toContain("gajae");
		for (const [name, preset] of Object.entries(STATUS_LINE_PRESETS)) {
			expect(preset.leftSegments, name).not.toContain("pi");
		}
	});

	it("brands HTML session exports as GJC without changing transcript role support", () => {
		expect(TEMPLATE).toContain("<title>GJC Session Export</title>");
		expect(TEMPLATE).toContain('content="gajae-code"');
		expect(TEMPLATE).toContain("GJC Session Export:");
		expect(TEMPLATE).toContain("GJC / gajae-code");
		expect(TEMPLATE).toContain('meta[name="gjc-url-params"]');
		expect(TEMPLATE).toContain('meta[name="gjc-share-base-url"]');
		expect(TEMPLATE).toContain("gjc-share:v1:sidebar-width");
		expect(TEMPLATE).toContain('meta[name="pi-url-params"]');
		expect(TEMPLATE).toContain('meta[name="pi-share-base-url"]');
		expect(TEMPLATE).toContain("pi-share:v1:sidebar-width");
		expect(TEMPLATE).toContain("developer-message");
		expect(TEMPLATE).toContain("tool-output");
	});
});

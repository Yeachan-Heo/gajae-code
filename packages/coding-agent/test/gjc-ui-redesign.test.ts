import { afterEach, describe, expect, it, vi } from "bun:test";
import { SETTINGS_SCHEMA } from "../src/config/settings-schema";
import { TEMPLATE } from "../src/export/html/template.generated";
import { STATUS_LINE_PRESETS } from "../src/modes/components/status-line/presets";
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

	it("uses red-claw as the default dark theme without overriding explicit light settings", async () => {
		themeModule.onTerminalAppearanceChange("dark");
		await themeModule.initTheme(false);

		expect(SETTINGS_SCHEMA["theme.dark"].default).toBe("red-claw");
		expect(themeModule.getCurrentThemeName()).toBe("red-claw");

		themeModule.onTerminalAppearanceChange("light");
		await themeModule.initTheme(false);
		expect(themeModule.getCurrentThemeName()).toBe("light");
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

	it("registers blue-crab as a bundled selectable theme without changing red-claw defaults", async () => {
		const themes = await themeModule.getAvailableThemes();

		expect(themes).toContain("blue-crab");
		expect(SETTINGS_SCHEMA["theme.dark"].default).toBe("red-claw");
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

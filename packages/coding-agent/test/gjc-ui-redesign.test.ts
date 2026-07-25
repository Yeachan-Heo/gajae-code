import { afterEach, describe, expect, it, vi } from "bun:test";
import { SETTINGS_SCHEMA } from "../src/config/settings-schema";
import { TEMPLATE } from "../src/export/html/template.generated";
import { STATUS_LINE_PRESETS } from "../src/modes/components/status-line/presets";
import { defaultThemes } from "../src/modes/theme/defaults";
import blueCrabTheme from "../src/modes/theme/defaults/blue-crab.json" with { type: "json" };
import blueCrabLightTheme from "../src/modes/theme/defaults/blue-crab-light.json" with { type: "json" };
import redClawTheme from "../src/modes/theme/defaults/red-claw.json" with { type: "json" };
import redClawLightTheme from "../src/modes/theme/defaults/red-claw-light.json" with { type: "json" };
import * as themeModule from "../src/modes/theme/theme";
import { ACP_BUILTIN_SLASH_COMMANDS } from "../src/slash-commands/acp-builtins";
import { lookupBuiltinSlashCommand } from "../src/slash-commands/builtin-registry";

const BUILTIN_THEME_NAMES = [
	"blue-crab",
	"blue-crab-light",
	"claude-code",
	"codex",
	"gruvbox-dark",
	"opencode",
	"red-claw",
	"red-claw-light",
];

function relativeLuminance(hex: string): number {
	const channels = [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
	const [red, green, blue] = channels.map(channel =>
		channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
	);
	return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function contrastRatio(foreground: string, background: string): number {
	const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
	return (lighter! + 0.05) / (darker! + 0.05);
}

function quantizeAnsi256(hex: string): string {
	const [red, green, blue] = [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16));
	let index: number;
	if (red === green && green === blue) {
		index = red! < 8 ? 16 : red! > 248 ? 231 : Math.round(((red! - 8) / 247) * 24) + 232;
	} else {
		index =
			16 + 36 * Math.round((red! / 255) * 5) + 6 * Math.round((green! / 255) * 5) + Math.round((blue! / 255) * 5);
	}
	if (index >= 232) {
		const channel = (index - 232) * 10 + 8;
		return `#${channel.toString(16).padStart(2, "0").repeat(3)}`;
	}
	const value = index - 16;
	const channels = [Math.floor(value / 36), Math.floor((value % 36) / 6), value % 6].map(component =>
		component === 0 ? 0 : component * 40 + 55,
	);
	return `#${channels.map(channel => channel.toString(16).padStart(2, "0")).join("")}`;
}

type LightThemeJson = {
	name: string;
	vars: Record<string, string>;
	colors: Record<string, string>;
	export: { pageBg: string };
};

type LightThemePairing = readonly [
	id: string,
	foreground: string,
	background: string,
	minimumContrast: 3 | 4.5,
	evidenceScene: string,
];

const LIGHT_THEME_PAIRINGS = [
	["settings-border", "border", "pageBg", 3, "normal-default"],
	["settings-tab-label", "accent", "pageBg", 4.5, "normal-default"],
	["settings-tab-active", "text", "selectedBg", 4.5, "selected-focus-active"],
	["settings-tab-selected-fill", "selectedBg", "pageBg", 3, "selected-focus-active"],
	["settings-tab-inactive", "muted", "pageBg", 4.5, "normal-default"],
	["settings-tab-hint", "dim", "pageBg", 4.5, "normal-default"],
	["settings-list-selected-label", "accent", "pageBg", 4.5, "selected-focus-active"],
	["settings-list-selected-value", "accent", "pageBg", 4.5, "selected-focus-active"],
	["settings-list-value", "muted", "pageBg", 4.5, "normal-default"],
	["settings-list-description", "dim", "pageBg", 4.5, "normal-default"],
	["settings-list-cursor", "accent", "pageBg", 4.5, "selected-focus-active"],
	["settings-list-hint", "dim", "pageBg", 4.5, "normal-default"],
	["select-list-selected", "accent", "pageBg", 4.5, "selected-focus-active"],
	["select-list-secondary", "muted", "pageBg", 4.5, "empty"],
	["submenu-title", "accent", "pageBg", 4.5, "expanded"],
	["submenu-secondary", "muted", "pageBg", 4.5, "expanded"],
	["submenu-unavailable", "dim", "pageBg", 4.5, "disabled"],
	["provider-title", "text", "pageBg", 4.5, "consumer-atlas"],
	["provider-selected", "accent", "pageBg", 4.5, "consumer-atlas"],
	["provider-secondary", "muted", "pageBg", 4.5, "consumer-atlas"],
	["assistant-header", "statusLineModel", "pageBg", 4.5, "consumer-atlas"],
	["assistant-thinking", "thinkingText", "pageBg", 4.5, "consumer-atlas"],
	["assistant-error", "error", "pageBg", 4.5, "consumer-atlas"],
	["assistant-usage", "dim", "pageBg", 4.5, "consumer-atlas"],
	["tool-pending-title", "toolTitle", "toolPendingBg", 4.5, "consumer-atlas"],
	["tool-pending-output", "toolOutput", "toolPendingBg", 4.5, "consumer-atlas"],
	["tool-success-title", "toolTitle", "toolSuccessBg", 4.5, "consumer-atlas"],
	["tool-success-output", "toolOutput", "toolSuccessBg", 4.5, "consumer-atlas"],
	["tool-error-title", "toolTitle", "toolErrorBg", 4.5, "consumer-atlas"],
	["tool-error-output", "toolOutput", "toolErrorBg", 4.5, "consumer-atlas"],
	["diff-added", "toolDiffAdded", "toolSuccessBg", 4.5, "diff"],
	["diff-removed", "toolDiffRemoved", "toolErrorBg", 4.5, "diff"],
	["diff-context", "toolDiffContext", "pageBg", 4.5, "diff"],
	["markdown-heading", "mdHeading", "pageBg", 4.5, "markdown"],
	["markdown-link", "mdLink", "pageBg", 4.5, "markdown"],
	["markdown-link-url", "mdLinkUrl", "pageBg", 4.5, "markdown"],
	["markdown-code", "mdCode", "pageBg", 4.5, "markdown"],
	["markdown-code-block", "mdCodeBlock", "pageBg", 4.5, "markdown"],
	["markdown-code-border", "mdCodeBlockBorder", "pageBg", 3, "markdown"],
	["markdown-quote", "mdQuote", "pageBg", 4.5, "markdown"],
	["markdown-quote-border", "mdQuoteBorder", "pageBg", 3, "markdown"],
	["markdown-rule", "mdHr", "pageBg", 3, "markdown"],
	["markdown-bullet", "mdListBullet", "pageBg", 4.5, "markdown"],
	["syntax-comment", "syntaxComment", "pageBg", 4.5, "syntax"],
	["syntax-keyword", "syntaxKeyword", "pageBg", 4.5, "syntax"],
	["syntax-function", "syntaxFunction", "pageBg", 4.5, "syntax"],
	["syntax-variable", "syntaxVariable", "pageBg", 4.5, "syntax"],
	["syntax-string", "syntaxString", "pageBg", 4.5, "syntax"],
	["syntax-number", "syntaxNumber", "pageBg", 4.5, "syntax"],
	["syntax-type", "syntaxType", "pageBg", 4.5, "syntax"],
	["syntax-operator", "syntaxOperator", "pageBg", 4.5, "syntax"],
	["syntax-punctuation", "syntaxPunctuation", "pageBg", 4.5, "syntax"],
	["status-group", "text", "userMessageBg", 4.5, "status"],
	["status-separator", "statusLineSep", "userMessageBg", 3, "status"],
	["status-model", "statusLineModel", "userMessageBg", 4.5, "status"],
	["status-path", "statusLinePath", "userMessageBg", 4.5, "status"],
	["status-clean", "statusLineGitClean", "userMessageBg", 4.5, "status"],
	["status-dirty", "statusLineGitDirty", "userMessageBg", 4.5, "warning"],
	["status-context", "statusLineContext", "userMessageBg", 4.5, "status"],
	["status-output", "statusLineOutput", "userMessageBg", 4.5, "status"],
	["status-cost", "statusLineCost", "userMessageBg", 4.5, "status"],
	["status-subagents", "statusLineSubagents", "userMessageBg", 4.5, "status"],
	["status-success", "success", "pageBg", 4.5, "success"],
	["status-warning", "warning", "pageBg", 4.5, "warning"],
	["status-error", "error", "pageBg", 4.5, "error"],
	["status-pending", "muted", "pageBg", 4.5, "pending-loading"],
	["status-running", "accent", "pageBg", 4.5, "pending-loading"],
	["chrome-border-accent", "borderAccent", "pageBg", 4.5, "consumer-atlas"],
	["chrome-border-muted", "borderMuted", "pageBg", 3, "consumer-atlas"],
	["user-message-text", "userMessageText", "userMessageBg", 4.5, "consumer-atlas"],
	["custom-message-label", "customMessageLabel", "customMessageBg", 4.5, "consumer-atlas"],
	["custom-message-text", "customMessageText", "customMessageBg", 4.5, "consumer-atlas"],
	["thinking-off", "thinkingOff", "pageBg", 4.5, "consumer-atlas"],
	["thinking-minimal", "thinkingMinimal", "pageBg", 4.5, "consumer-atlas"],
	["thinking-low", "thinkingLow", "pageBg", 4.5, "consumer-atlas"],
	["thinking-medium", "thinkingMedium", "pageBg", 4.5, "consumer-atlas"],
	["thinking-high", "thinkingHigh", "pageBg", 4.5, "consumer-atlas"],
	["thinking-xhigh", "thinkingXhigh", "pageBg", 4.5, "consumer-atlas"],
	["bash-mode", "bashMode", "pageBg", 4.5, "consumer-atlas"],
	["python-mode", "pythonMode", "pageBg", 4.5, "consumer-atlas"],
	["status-spend", "statusLineSpend", "userMessageBg", 4.5, "status"],
	["status-staged", "statusLineStaged", "userMessageBg", 4.5, "status"],
	["status-unstaged", "statusLineDirty", "userMessageBg", 4.5, "warning"],
	["status-untracked", "statusLineUntracked", "userMessageBg", 4.5, "warning"],
] as const satisfies readonly LightThemePairing[];

function resolveDeclaredColor(themeJson: LightThemeJson, role: string): string {
	if (role === "pageBg") return themeJson.export.pageBg;
	const declared = themeJson.colors[role];
	if (!declared) throw new Error(`Unknown theme role: ${role}`);
	return themeJson.vars[declared] ?? declared;
}

describe("GJC red-claw redesign defaults", () => {
	afterEach(() => {
		themeModule.stopThemeWatcher();
		vi.restoreAllMocks();
	});

	it("uses red-claw as the default dark theme and blue-crab-light as the default light theme", async () => {
		themeModule.onTerminalAppearanceChange("dark");
		await themeModule.initTheme(false);

		expect(SETTINGS_SCHEMA["theme.dark"].default).toBe("red-claw");
		expect(SETTINGS_SCHEMA["theme.light"].default).toBe("blue-crab-light");
		expect(themeModule.getCurrentThemeName()).toBe("red-claw");

		themeModule.onTerminalAppearanceChange("light");
		await themeModule.initTheme(false);
		expect(themeModule.getCurrentThemeName()).toBe("blue-crab-light");
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

	it("exposes all bundled themes while preserving the red-claw and blue-crab-light defaults", async () => {
		const themes = await themeModule.getAvailableThemes();

		expect(themes).toEqual([...themes].sort());
		for (const name of BUILTIN_THEME_NAMES) {
			expect(themes).toContain(name);
		}
		expect(Object.keys(defaultThemes).sort()).toEqual(BUILTIN_THEME_NAMES);
		expect(SETTINGS_SCHEMA["theme.dark"].default).toBe("red-claw");
		expect(SETTINGS_SCHEMA["theme.light"].default).toBe("blue-crab-light");
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

	it("enforces the exhaustive documented light-theme consumer pairings and identity", async () => {
		expect(themeModule.isLightTheme("red-claw")).toBe(false);
		expect(themeModule.isLightTheme("blue-crab")).toBe(false);

		const design = await Bun.file(new URL("../src/modes/DESIGN.md", import.meta.url)).text();
		const inventory = design
			.split("### Actual consumer and contrast inventory")[1]
			?.split("### States, non-color cues, and responsive behavior")[0];
		expect(inventory).toBeDefined();
		const documentedIds = Array.from(inventory?.matchAll(/^\| `([^`]+)` \|/gm) ?? [], match => match[1]!);
		const expectedIds = LIGHT_THEME_PAIRINGS.map(([id]) => id);
		expect(LIGHT_THEME_PAIRINGS).toHaveLength(84);
		expect(new Set(expectedIds).size).toBe(expectedIds.length);
		expect(documentedIds).toEqual(expectedIds);

		const sentinelHashes = new Set<string>();
		for (const [name, importedThemeJson] of [
			["red-claw-light", redClawLightTheme],
			["blue-crab-light", blueCrabLightTheme],
		] as const) {
			const themeJson: LightThemeJson = importedThemeJson;
			expect(themeJson.name).toBe(name);
			expect(themeModule.isLightTheme(name), `${name} should classify as light`).toBe(true);
			expect(Object.keys(themeJson.colors), `${name} has non-schema color tokens`).not.toContain("link");

			const colors = await themeModule.getResolvedThemeColors(name);
			expect(Object.keys(colors).sort()).toEqual([...themeModule.THEME_COLOR_KEYS].sort());
			expect(colors.accent).toBe(themeJson.vars.claw);
			expect(colors.error).toBe(themeJson.vars.dangerRed);
			expect(colors.warning).toBe(themeJson.vars.warningAmber);
			expect(colors.toolDiffRemoved).toBe(themeJson.vars.diffRemovalRed);
			expect(
				new Set([colors.accent, colors.success, colors.error, colors.warning, colors.toolDiffRemoved]).size,
			).toBe(5);
			expect(
				new Set(
					[colors.accent, colors.success, colors.error, colors.warning, colors.toolDiffRemoved].map(
						quantizeAnsi256,
					),
				).size,
				`${name} 256-color semantic cues must remain distinct`,
			).toBe(5);

			const sentinelEntries = [...themeModule.THEME_COLOR_KEYS].sort().map(role => [role, colors[role]!] as const);
			const sentinel = JSON.stringify({
				background: themeJson.export.pageBg,
				roles: Object.fromEntries(sentinelEntries),
			});
			sentinelHashes.add(new Bun.CryptoHasher("sha256").update(sentinel).digest("hex"));

			for (const [id, foregroundRole, backgroundRole, minimumContrast, evidenceScene] of LIGHT_THEME_PAIRINGS) {
				const foreground = colors[foregroundRole];
				const background = backgroundRole === "pageBg" ? themeJson.export.pageBg : colors[backgroundRole];
				expect(foreground, `${name}/${id} unresolved foreground ${foregroundRole}`).toBeDefined();
				expect(background, `${name}/${id} unresolved background ${backgroundRole}`).toBeDefined();
				expect(foreground).toBe(resolveDeclaredColor(themeJson, foregroundRole));
				expect(background).toBe(resolveDeclaredColor(themeJson, backgroundRole));
				expect(evidenceScene.length, `${id} requires an evidence scene`).toBeGreaterThan(0);
				expect(
					contrastRatio(foreground!, background!),
					`${name}/${id}: ${foregroundRole} ${foreground} on ${backgroundRole} ${background}`,
				).toBeGreaterThanOrEqual(minimumContrast);
				const ansi256Foreground = quantizeAnsi256(foreground!);
				const ansi256Background = quantizeAnsi256(background!);
				expect(
					contrastRatio(ansi256Foreground, ansi256Background),
					`${name}/${id} ANSI-256: ${foregroundRole} ${ansi256Foreground} on ${backgroundRole} ${ansi256Background}`,
				).toBeGreaterThanOrEqual(minimumContrast);
			}
		}
		expect(sentinelHashes.size).toBe(2);
		await expect(themeModule.getResolvedThemeColors("not-a-real-theme")).rejects.toThrow();
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

import { visibleWidth } from "@gajae-code/tui";
import chalk from "chalk";
import { KeybindingsManager, type KeyDisplayContext } from "../../../src/config/keybindings";
import { Settings } from "../../../src/config/settings";
import { ActionRegistry } from "../../../src/modes/action-registry";
import { CustomEditor } from "../../../src/modes/components/custom-editor";
import { StatusLineComponent } from "../../../src/modes/components/tool-status-header";
import { WelcomeComponent } from "../../../src/modes/components/welcome";
import { getDefaultComposerPlaceholder } from "../../../src/modes/interactive-mode";
import { getEditorTheme, initTheme, theme } from "../../../src/modes/theme/theme";

export const PLATFORM_SHORTCUT_LABELS_SHOWCASE_EXPECTED_ENTRY_COUNT = 34;

export const PLATFORM_SHORTCUT_LABELS_SHOWCASE_VIEWPORTS = [
	{ id: "80x24", columns: 80, rows: 24 },
	{ id: "120x36", columns: 120, rows: 36 },
	{ id: "160x48", columns: 160, rows: 48 },
] as const;

const NARROW_VIEWPORT = { id: "48x36", columns: 48, rows: 36 } as const;
type Viewport = (typeof PLATFORM_SHORTCUT_LABELS_SHOWCASE_VIEWPORTS)[number] | typeof NARROW_VIEWPORT;
type Platform = "darwin" | "win32" | "linux";
type Surface =
	| "composer-idle"
	| "composer-busy-effective-queue-remap"
	| "status-effective-remap-unbound"
	| "welcome-flow";
export type PlatformShortcutLabelsShowcaseRenderMode = "unicode-color" | "ascii-no-color";

export interface PlatformShortcutLabelsShowcaseEntry {
	key: string;
	platform: Platform;
	surface: Surface;
	viewport: Viewport;
	renderMode: PlatformShortcutLabelsShowcaseRenderMode;
}

export interface PlatformShortcutLabelsShowcaseRender {
	terminalText: string;
	terminalAnsiText: string;
	captureMode: "fixture-injected-platform";
	platformProvenance: "fixture-injected-platform";
	keyDisplayContext: KeyDisplayContext;
	components: readonly string[];
	fixedClockTimestamp: string;
}

const principalSurfaces: readonly Surface[] = [
	"composer-idle",
	"composer-busy-effective-queue-remap",
	"status-effective-remap-unbound",
	"welcome-flow",
];
const entries: PlatformShortcutLabelsShowcaseEntry[] = [];
for (const platform of ["darwin", "win32", "linux"] as const) {
	const viewports =
		platform === "darwin"
			? PLATFORM_SHORTCUT_LABELS_SHOWCASE_VIEWPORTS
			: PLATFORM_SHORTCUT_LABELS_SHOWCASE_VIEWPORTS.slice(0, 2);
	for (const surface of principalSurfaces) {
		for (const viewport of viewports)
			entries.push({
				key: `${platform}/${surface}/${viewport.id}/unicode-color`,
				platform,
				surface,
				viewport,
				renderMode: "unicode-color",
			});
	}
}
for (const surface of principalSurfaces) {
	entries.push({
		key: `darwin/${surface}/80x24/ascii-no-color`,
		platform: "darwin",
		surface,
		viewport: PLATFORM_SHORTCUT_LABELS_SHOWCASE_VIEWPORTS[0],
		renderMode: "ascii-no-color",
	});
}
entries.push(
	{
		key: "darwin/status-effective-remap-unbound/48x36/unicode-color",
		platform: "darwin",
		surface: "status-effective-remap-unbound",
		viewport: NARROW_VIEWPORT,
		renderMode: "unicode-color",
	},
	{
		key: "darwin/welcome-flow/48x36/unicode-color",
		platform: "darwin",
		surface: "welcome-flow",
		viewport: NARROW_VIEWPORT,
		renderMode: "unicode-color",
	},
);
export const PLATFORM_SHORTCUT_LABELS_SHOWCASE_ENTRIES: readonly PlatformShortcutLabelsShowcaseEntry[] = entries;

const CLOCK = { now: () => 1_700_000_034_000 };

function configureComposer(editor: CustomEditor, placeholder: string): void {
	editor.setBorderVisible(true);
	editor.setBorderStyle("round");
	editor.setClosedBorderBox(true);
	editor.setInputPrefix(`${theme.fg("accent", "> ")}`);
	editor.setPlaceholder(placeholder);
	editor.setPaddingX(1);
	editor.setRightGutterWidth(1);
}

function statusSession(): ConstructorParameters<typeof StatusLineComponent>[0] {
	return {
		state: { messages: [] },
		isStreaming: false,
		getAsyncJobSnapshot: () => ({ running: [] }),
		getCurrentModel: () => undefined,
		isFastModeEnabled: () => false,
		isFastModeActive: () => false,
		sessionManager: {
			getSessionName: () => "ショートカット",
			getUsageStatistics: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, premiumRequests: 0, cost: 0 }),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

function actionRegistry(busy: boolean): ActionRegistry<void> {
	const registry = new ActionRegistry<void>({ context: undefined, showError: () => {} });
	for (const [id, title, available] of [
		["app.message.sendNow", "Send message now", busy],
		["app.message.queue", "Queue message", busy],
		["app.commandPalette.open", "Open command palette", !busy],
		["app.model.select", "Select model", !busy],
	] as const)
		registry.register({
			id,
			title,
			category: "Showcase",
			bindingId: id,
			domains: ["composer"],
			availability: () => available,
			execute: () => {},
		});
	return registry;
}

function fit(lines: string[], viewport: Viewport): string {
	for (const line of lines)
		if (visibleWidth(line) > viewport.columns)
			throw new Error(`Rendered line exceeds ${viewport.id}: ${Bun.stripANSI(line)}`);
	if (lines.length > viewport.rows) throw new Error(`Rendered surface exceeds ${viewport.id}: ${lines.length} rows`);
	while (lines.length < viewport.rows) lines.push("");
	return `${lines.join("\n")}\n`;
}

function renderComposer(entry: PlatformShortcutLabelsShowcaseEntry, context: KeyDisplayContext): string[] {
	const editor = new CustomEditor(getEditorTheme());
	const keybindings = KeybindingsManager.inMemory({
		"app.message.followUp": "alt+q",
		"app.message.queue": "alt+q",
		"tui.input.submit": "enter",
	});
	const preferredQueueAction = context.platform === "darwin" ? "app.message.followUp" : "app.message.queue";
	const fallbackQueueAction = context.platform === "darwin" ? "app.message.queue" : "app.message.followUp";
	const queue =
		keybindings.getDisplayString(preferredQueueAction, context) ||
		keybindings.getDisplayString(fallbackQueueAction, context);
	const submit = keybindings.getDisplayString("tui.input.submit", context);
	const placeholder =
		entry.surface === "composer-idle"
			? getDefaultComposerPlaceholder(context)
			: `${getDefaultComposerPlaceholder(context)}${submit ? ` · ${submit}: Queue` : ""}${queue ? ` · ${queue}: Queue` : ""}`;
	configureComposer(editor, placeholder);
	return [
		theme.fg(
			"dim",
			entry.surface === "composer-idle"
				? "Composer / canonical onboarding defaults"
				: `Composer / busy effective queue remap: ${queue || "unbound"}`,
		),
		...editor.render(entry.viewport.columns),
	];
}

function renderStatus(entry: PlatformShortcutLabelsShowcaseEntry, context: KeyDisplayContext): string[] {
	const keybindings = KeybindingsManager.inMemory({
		"app.message.sendNow": "ctrl+enter",
		"app.message.queue": "alt+q",
		"app.commandPalette.open": "super+alt+p",
		"app.model.select": [],
	});
	const status = new StatusLineComponent(statusSession(), {
		actionRegistry: actionRegistry(false),
		getKeybindings: () => keybindings,
		focusDomain: "composer",
		keyDisplayContext: context,
	});
	status.updateSettings({
		preset: "custom",
		leftSegments: ["session_name"],
		rightSegments: [],
		separator: "pipe",
		showSkillHud: false,
		showActionHints: true,
	});
	return [
		theme.fg("dim", "Status / effective remap + unbound model action"),
		...status.render(entry.viewport.columns),
	];
}

function renderWelcome(entry: PlatformShortcutLabelsShowcaseEntry, context: KeyDisplayContext): string[] {
	const welcome = new WelcomeComponent("0.0.0-showcase", "deterministic-model", "fixture", [], [], "unicode", {
		keyDisplayContext: context,
		getViewportRows: () => entry.viewport.rows - 2,
		getReservedBottomRows: () => 2,
		changelogMarkdown: "### Width evidence\n한국어 日本語 中文 shortcut labels remain visible.",
		buildLabel: "fixture clock",
	});
	return [...welcome.render(entry.viewport.columns), theme.fg("dim", `Clock ${new Date(CLOCK.now()).toISOString()}`)];
}

export async function renderPlatformShortcutLabelsShowcase(
	entry: PlatformShortcutLabelsShowcaseEntry,
): Promise<PlatformShortcutLabelsShowcaseRender> {
	const context: KeyDisplayContext = { platform: entry.platform };
	const oldLevel = chalk.level;
	chalk.level = 3;
	await Settings.init({ inMemory: true });
	await initTheme(false, entry.renderMode === "ascii-no-color" ? "ascii" : "unicode", false, "red-claw", "red-claw");
	try {
		const lines = entry.surface.startsWith("composer")
			? renderComposer(entry, context)
			: entry.surface.startsWith("status")
				? renderStatus(entry, context)
				: renderWelcome(entry, context);
		const terminalAnsiText =
			entry.renderMode === "ascii-no-color" ? Bun.stripANSI(fit(lines, entry.viewport)) : fit(lines, entry.viewport);
		return {
			terminalText: Bun.stripANSI(terminalAnsiText),
			terminalAnsiText,
			captureMode: "fixture-injected-platform",
			platformProvenance: "fixture-injected-platform",
			keyDisplayContext: context,
			components: entry.surface.startsWith("composer")
				? ["CustomEditor"]
				: entry.surface.startsWith("status")
					? ["StatusLineComponent"]
					: ["WelcomeComponent"],
			fixedClockTimestamp: new Date(CLOCK.now()).toISOString(),
		};
	} finally {
		chalk.level = oldLevel;
	}
}

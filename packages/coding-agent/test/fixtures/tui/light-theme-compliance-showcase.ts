import { Markdown } from "@gajae-code/tui";
import chalk from "chalk";
import { computeThemeSentinelSha256 } from "../../../scripts/lib/terminal-visual-evidence";
import { Settings } from "../../../src/config/settings";
import { renderDiff } from "../../../src/modes/components/diff";
import { StatusLineComponent } from "../../../src/modes/components/tool-status-header";
import { EMPTY_JOBS_SNAPSHOT } from "../../../src/modes/jobs-observer";
import {
	getCurrentThemeName,
	getMarkdownTheme,
	getResolvedThemeColors,
	getThemeExportColors,
	highlightCode,
	initTheme,
	THEME_COLOR_KEYS,
	theme,
} from "../../../src/modes/theme/theme";
import type { AgentSession } from "../../../src/session/agent-session";
import { renderStatusLine } from "../../../src/tui";
import {
	LIGHT_THEME_CONSUMER_ATLAS_PRODUCTION_IMPORTS,
	LIGHT_THEME_CONSUMER_ATLAS_PRODUCTION_SYMBOLS,
	LIGHT_THEME_CONSUMER_ATLAS_VIEWPORTS,
	type LightThemeConsumerAtlasViewport,
	renderLightThemeConsumerAtlas,
} from "./light-theme-consumer-atlas";
import {
	NOTIFICATIONS_SETTINGS_SHOWCASE_ENTRIES,
	type NotificationsSettingsShowcaseEntry,
	type NotificationsSettingsShowcaseStateId,
	renderNotificationsSettingsShowcase,
} from "./notifications-settings-showcase";

/**
 * Deterministic light-theme compliance showcase.
 *
 * Source of truth for the 180-key matrix. Renders actual production components
 * and theme resolution with fail-closed identity checks. Performs no network or
 * fixture filesystem I/O.
 */

export const LIGHT_THEME_COMPLIANCE_THEMES = ["red-claw-light", "blue-crab-light"] as const;
export type LightThemeComplianceTheme = (typeof LIGHT_THEME_COMPLIANCE_THEMES)[number];

export const LIGHT_THEME_COMPLIANCE_SCENE_IDS = [
	"normal-default",
	"selected-focus-active",
	"disabled",
	"pending-loading",
	"empty",
	"success",
	"warning",
	"error",
	"confirmation",
	"expanded",
	"collapsed",
	"permission-failure",
	"connection-failure",
	"diff",
	"markdown",
	"syntax",
	"status",
	"overflow-top",
	"overflow-middle",
	"overflow-bottom",
	"wrap-korean",
	"wrap-japanese",
	"wrap-chinese",
	"wrap-mixed-cjk-latin",
	"consumer-atlas",
] as const;
export type LightThemeComplianceSceneId = (typeof LIGHT_THEME_COMPLIANCE_SCENE_IDS)[number];

export const LIGHT_THEME_COMPLIANCE_VIEWPORTS = [
	{ id: "80x24", columns: 80, rows: 24 },
	{ id: "120x36", columns: 120, rows: 36 },
	{ id: "160x48", columns: 160, rows: 48 },
] as const;

export const LIGHT_THEME_COMPLIANCE_CJK_VIEWPORT = { id: "48x36", columns: 48, rows: 36 } as const;

export type LightThemeComplianceViewport =
	| (typeof LIGHT_THEME_COMPLIANCE_VIEWPORTS)[number]
	| typeof LIGHT_THEME_COMPLIANCE_CJK_VIEWPORT
	| LightThemeConsumerAtlasViewport;

export type LightThemeComplianceRenderMode = "unicode-color" | "unicode-256-color" | "ascii-no-color";

export const LIGHT_THEME_COMPLIANCE_ASCII_NO_COLOR_SCENES = [
	"selected-focus-active",
	"pending-loading",
	"warning",
	"error",
	"confirmation",
	"status",
] as const satisfies readonly LightThemeComplianceSceneId[];

export const LIGHT_THEME_COMPLIANCE_CJK_SCENES = [
	"wrap-korean",
	"wrap-japanese",
	"wrap-chinese",
	"wrap-mixed-cjk-latin",
] as const satisfies readonly LightThemeComplianceSceneId[];

export const LIGHT_THEME_COMPLIANCE_ANSI_256_SCENES = [
	"selected-focus-active",
	"wrap-mixed-cjk-latin",
	"consumer-atlas",
] as const satisfies readonly LightThemeComplianceSceneId[];

export interface LightThemeComplianceEntry {
	key: string;
	theme: LightThemeComplianceTheme;
	sceneId: LightThemeComplianceSceneId;
	viewport: LightThemeComplianceViewport;
	renderMode: LightThemeComplianceRenderMode;
}

export interface LightThemeComplianceThemeIdentity {
	requestedTheme: LightThemeComplianceTheme;
	resolvedTheme: string;
	keyTheme: LightThemeComplianceTheme;
	themeSentinelRoles: Readonly<Record<string, string>>;
	themeSentinelSha256: string;
	pageBackground: string;
}

export interface LightThemeComplianceWindowMetadata {
	itemCount: number;
	selectedIndex: number;
	windowStart: number;
	windowEnd: number;
	visibleItemIds: readonly string[];
	scrollPosition: number;
	stickyTopRowIds: readonly string[];
	stickyBottomRowIds: readonly string[];
	maxVisible: number;
	mechanism: "maxVisible-windowed";
}

export interface LightThemeComplianceProvenance {
	fixtureSource: "packages/coding-agent/test/fixtures/tui/light-theme-compliance-showcase.ts";
	productionImports: readonly string[];
	productionSymbols: readonly string[];
	captureMode: "live-production-renderers";
	fixedClockTimestamp: string;
	sceneFamily:
		| "notifications-settings"
		| "diff"
		| "markdown"
		| "syntax"
		| "status"
		| "status-line-cues"
		| "consumer-atlas";
	notificationsStateId?: NotificationsSettingsShowcaseStateId;
	cjkLanguage?: "korean" | "japanese" | "chinese" | "mixed-cjk-latin";
	noColorCues?: readonly string[];
}

export interface LightThemeComplianceRender {
	terminalText: string;
	terminalAnsiText: string;
	themeIdentity: LightThemeComplianceThemeIdentity;
	window: LightThemeComplianceWindowMetadata | null;
	provenance: LightThemeComplianceProvenance;
	viewport: LightThemeComplianceViewport;
	sceneId: LightThemeComplianceSceneId;
	renderMode: LightThemeComplianceRenderMode;
	key: string;
}

export const LIGHT_THEME_COMPLIANCE_EXPECTED_ENTRY_COUNT = 180;
export const LIGHT_THEME_COMPLIANCE_EXPECTED_LEAF_COUNT = LIGHT_THEME_COMPLIANCE_EXPECTED_ENTRY_COUNT * 5;

const SHOWCASE_CLOCK = {
	now: () => 1_700_000_042_000,
} as const;

const FIXED_CLOCK_TIMESTAMP = new Date(SHOWCASE_CLOCK.now()).toISOString();

const OVERFLOW_ITEM_COUNT = 11;
const OVERFLOW_MAX_VISIBLE = 5;

const CJK_COPY = {
	korean: {
		title: "알림 설정 확인",
		body: "구성이 저장된 뒤 외부 데몬이 활성화를 차단했습니다. 복원 또는 유지 중 하나를 명시적으로 선택해야 합니다. secret=•••••••• cfg.path=/showcase/config.yml",
		action: "복원 선택",
		status: "경고 — 세션 알림이 비활성입니다",
	},
	japanese: {
		title: "通知設定の確認",
		body: [
			"設定の保存後に外部デーモンが有効化を",
			"ブロックしました。",
			"復元または保持を",
			"明示的に選択する必要があります。",
			"secret=•••••••• cfg.path=/showcase/config.yml",
		].join("\n"),
		action: "復元を選択",
		status: "警告 — セッション通知は無効です",
	},
	chinese: {
		title: "通知设置确认",
		body: "配置提交后，外部守护进程阻止了激活；必须明确选择恢复或保留。secret=•••••••• cfg.path=/showcase/config.yml",
		action: "选择恢复",
		status: "警告 — 会话通知已关闭",
	},
	mixed: {
		title: "Notifications / 알림 / 通知 / 通知",
		body: "Restore retained config. 구성 복원. 設定を復元. 恢复配置. secret=•••••••• cfg.path=/showcase/config.yml action=restore",
		action: "Restore · 복원 · 復元 · 恢复",
		status: "WARNING — blocked · 차단 · ブロック · 阻止",
	},
} as const;

const SCENE_TO_NOTIFICATIONS_STATE: Partial<Record<LightThemeComplianceSceneId, NotificationsSettingsShowcaseStateId>> =
	{
		"normal-default": "home-configured-inactive",
		"selected-focus-active": "home-runtime-active",
		disabled: "home-env-off",
		"pending-loading": "health-probing",
		empty: "home-unconfigured",
		success: "success",
		warning: "health-warning",
		error: "error",
		confirmation: "confirmation-remove",
		expanded: "preferences",
		collapsed: "home-local-off",
		"permission-failure": "foreign-blocked",
		"connection-failure": "reconnecting",
		"overflow-top": "home-runtime-active",
		"overflow-middle": "home-runtime-active",
		"overflow-bottom": "home-runtime-active",
		"wrap-korean": "narrow-cjk",
		"wrap-japanese": "narrow-cjk",
		"wrap-chinese": "narrow-cjk",
		"wrap-mixed-cjk-latin": "narrow-cjk",
	};

const ASCII_NO_COLOR_CUES: Record<(typeof LIGHT_THEME_COMPLIANCE_ASCII_NO_COLOR_SCENES)[number], readonly string[]> = {
	"selected-focus-active": ["cursor-or-prefix", "position", "active-tab-text"],
	"pending-loading": ["operation-name", "pending-prose"],
	warning: ["warning-symbol", "warning-prose"],
	error: ["error-symbol", "error-prose"],
	confirmation: ["explicit-action-labels", "confirm-or-cancel"],
	status: ["segment-labels", "separator", "plain-text-status"],
};

const ALLOWED_NON_CANONICAL_ASCII_STATE_IDS = new Set<NotificationsSettingsShowcaseStateId>([
	"home-runtime-active",
	"health-probing",
	"error",
]);

function isLightThemeComplianceTheme(value: string): value is LightThemeComplianceTheme {
	return (LIGHT_THEME_COMPLIANCE_THEMES as readonly string[]).includes(value);
}

function buildMatrixKey(
	themeName: LightThemeComplianceTheme,
	sceneId: LightThemeComplianceSceneId,
	viewportId: string,
	renderMode: LightThemeComplianceRenderMode,
): string {
	return `${themeName}/${sceneId}/${viewportId}/${renderMode}`;
}

export const LIGHT_THEME_COMPLIANCE_ENTRIES: readonly LightThemeComplianceEntry[] = (() => {
	const entries: LightThemeComplianceEntry[] = [];
	for (const themeName of LIGHT_THEME_COMPLIANCE_THEMES) {
		for (const sceneId of LIGHT_THEME_COMPLIANCE_SCENE_IDS) {
			if (sceneId === "consumer-atlas") continue;
			for (const viewport of LIGHT_THEME_COMPLIANCE_VIEWPORTS) {
				entries.push({
					key: buildMatrixKey(themeName, sceneId, viewport.id, "unicode-color"),
					theme: themeName,
					sceneId,
					viewport,
					renderMode: "unicode-color",
				});
			}
		}
		for (const sceneId of LIGHT_THEME_COMPLIANCE_ASCII_NO_COLOR_SCENES) {
			const viewport = LIGHT_THEME_COMPLIANCE_VIEWPORTS[0];
			entries.push({
				key: buildMatrixKey(themeName, sceneId, viewport.id, "ascii-no-color"),
				theme: themeName,
				sceneId,
				viewport,
				renderMode: "ascii-no-color",
			});
		}
		for (const sceneId of LIGHT_THEME_COMPLIANCE_CJK_SCENES) {
			entries.push({
				key: buildMatrixKey(themeName, sceneId, LIGHT_THEME_COMPLIANCE_CJK_VIEWPORT.id, "unicode-color"),
				theme: themeName,
				sceneId,
				viewport: LIGHT_THEME_COMPLIANCE_CJK_VIEWPORT,
				renderMode: "unicode-color",
			});
		}
		for (const viewport of LIGHT_THEME_CONSUMER_ATLAS_VIEWPORTS) {
			entries.push({
				key: buildMatrixKey(themeName, "consumer-atlas", viewport.id, "unicode-color"),
				theme: themeName,
				sceneId: "consumer-atlas",
				viewport,
				renderMode: "unicode-color",
			});
		}
		for (const viewport of LIGHT_THEME_COMPLIANCE_VIEWPORTS) {
			entries.push({
				key: buildMatrixKey(themeName, "selected-focus-active", viewport.id, "unicode-256-color"),
				theme: themeName,
				sceneId: "selected-focus-active",
				viewport,
				renderMode: "unicode-256-color",
			});
		}
		entries.push({
			key: buildMatrixKey(
				themeName,
				"wrap-mixed-cjk-latin",
				LIGHT_THEME_COMPLIANCE_CJK_VIEWPORT.id,
				"unicode-256-color",
			),
			theme: themeName,
			sceneId: "wrap-mixed-cjk-latin",
			viewport: LIGHT_THEME_COMPLIANCE_CJK_VIEWPORT,
			renderMode: "unicode-256-color",
		});
		const atlasViewport = LIGHT_THEME_CONSUMER_ATLAS_VIEWPORTS.find(viewport => viewport.columns === 120);
		if (!atlasViewport) throw new Error("Light-theme compliance requires the 120-column consumer atlas");
		entries.push({
			key: buildMatrixKey(themeName, "consumer-atlas", atlasViewport.id, "unicode-256-color"),
			theme: themeName,
			sceneId: "consumer-atlas",
			viewport: atlasViewport,
			renderMode: "unicode-256-color",
		});
	}
	return entries;
})();

if (LIGHT_THEME_COMPLIANCE_ENTRIES.length !== LIGHT_THEME_COMPLIANCE_EXPECTED_ENTRY_COUNT) {
	throw new Error(
		`Light-theme compliance matrix size mismatch: expected ${LIGHT_THEME_COMPLIANCE_EXPECTED_ENTRY_COUNT}, got ${LIGHT_THEME_COMPLIANCE_ENTRIES.length}`,
	);
}

function assertClosedTheme(themeName: string): LightThemeComplianceTheme {
	if (!isLightThemeComplianceTheme(themeName)) {
		throw new Error(`Light-theme compliance rejects non-closed theme request: ${themeName}`);
	}
	return themeName;
}

async function resolveThemeIdentity(
	requestedTheme: LightThemeComplianceTheme,
	keyTheme: LightThemeComplianceTheme,
): Promise<LightThemeComplianceThemeIdentity> {
	const resolvedTheme = getCurrentThemeName();
	if (!resolvedTheme) {
		throw new Error("Light-theme compliance fail-closed: resolved theme is undefined");
	}
	if (resolvedTheme !== requestedTheme) {
		throw new Error(
			`Light-theme compliance fail-closed: requested_theme (${requestedTheme}) !== resolved_theme (${resolvedTheme})`,
		);
	}
	if (resolvedTheme !== keyTheme) {
		throw new Error(
			`Light-theme compliance fail-closed: resolved_theme (${resolvedTheme}) !== key theme (${keyTheme})`,
		);
	}
	if (requestedTheme !== keyTheme) {
		throw new Error(
			`Light-theme compliance fail-closed: requested_theme (${requestedTheme}) !== key theme (${keyTheme})`,
		);
	}

	const colors = await getResolvedThemeColors(requestedTheme);
	const exportColors = await getThemeExportColors(requestedTheme);
	const pageBackground = exportColors.pageBg;
	if (!pageBackground) {
		throw new Error(`Light-theme compliance fail-closed: missing export.pageBg for ${requestedTheme}`);
	}

	const sortedKeys = [...THEME_COLOR_KEYS].sort();
	const themeSentinelRoles: Record<string, string> = {};
	for (const role of sortedKeys) {
		const value = colors[role];
		if (!value) {
			throw new Error(`Light-theme compliance fail-closed: unresolved role ${role} for ${requestedTheme}`);
		}
		themeSentinelRoles[role] = value;
	}
	themeSentinelRoles.background = pageBackground;

	const themeSentinelSha256 = computeThemeSentinelSha256(themeSentinelRoles, pageBackground);

	return {
		requestedTheme,
		resolvedTheme,
		keyTheme,
		themeSentinelRoles,
		themeSentinelSha256,
		pageBackground,
	};
}

async function configureDeterministicLightTheme(
	themeName: LightThemeComplianceTheme,
	renderMode: LightThemeComplianceRenderMode,
): Promise<() => void> {
	const originalColorTerm = Bun.env.COLORTERM;
	const originalChalkLevel = chalk.level;
	Bun.env.COLORTERM = renderMode === "unicode-color" ? "truecolor" : "256color";
	chalk.level = renderMode === "unicode-color" ? 3 : renderMode === "unicode-256-color" ? 2 : 3;
	try {
		// Pin both auto slots to the requested light theme so detection cannot fall back.
		await initTheme(false, renderMode === "ascii-no-color" ? "ascii" : "unicode", false, themeName, themeName);
		const resolved = getCurrentThemeName();
		if (resolved !== themeName) {
			throw new Error(
				`Light-theme compliance fail-closed: initTheme resolved ${resolved ?? "(undefined)"} instead of ${themeName}`,
			);
		}
	} catch (error) {
		chalk.level = originalChalkLevel;
		throw error;
	} finally {
		if (originalColorTerm === undefined) delete Bun.env.COLORTERM;
		else Bun.env.COLORTERM = originalColorTerm;
	}
	return () => {
		chalk.level = originalChalkLevel;
	};
}

function boundSurface(
	lines: string[],
	viewport: LightThemeComplianceViewport,
	sceneId: LightThemeComplianceSceneId,
): string {
	const bounded = [...lines];
	if (bounded.length > viewport.rows) {
		throw new Error(
			`Light-theme compliance ${sceneId} exceeds ${viewport.id}: rendered ${bounded.length} rows for ${viewport.rows}`,
		);
	}
	while (bounded.length < viewport.rows) bounded.push("");
	return `${bounded.map(line => line ?? "").join("\n")}\n`;
}

function overflowActionCatalog(): readonly { id: string; labels: readonly string[] }[] {
	return [
		{ id: "configure", labels: ["Reconfigure Telegram", "Configure Telegram"] },
		{ id: "enable", labels: ["Enable globally"] },
		{ id: "disable", labels: ["Disable globally"] },
		{ id: "session", labels: ["Turn session notifications off", "Turn session notifications on"] },
		{ id: "refresh", labels: ["Refresh health"] },
		{ id: "probe", labels: ["Probe health"] },
		{ id: "test", labels: ["Send test notification"] },
		{ id: "recover", labels: ["Recover notification delivery"] },
		{ id: "reconnect", labels: ["Reconnect Telegram runtime"] },
		{ id: "remove", labels: ["Remove Telegram"] },
		{ id: "preferences", labels: ["Notification preferences"] },
	] as const;
}

function overflowActionIdForLabel(label: string): string {
	const trimmed = label.trim();
	for (const action of overflowActionCatalog()) {
		if (action.labels.includes(trimmed)) return action.id;
	}
	throw new Error(`Overflow render exposed unknown action label: ${label}`);
}

function stickyRowSignature(role: string, line: string): string {
	const normalized = line.replace(/\s+/g, " ").trim();
	const digest = new Bun.CryptoHasher("sha256").update(normalized).digest("hex").slice(0, 16);
	return `${role}:${digest}`;
}

function parseOverflowWindowFromRender(
	terminalText: string,
	selectedIndex: number,
): LightThemeComplianceWindowMetadata {
	const lines = terminalText.replace(/\n$/, "").split("\n");
	if (lines.length < 8) {
		throw new Error(`Overflow render too short to derive window metadata (${lines.length} lines)`);
	}

	const positionMatch = lines
		.map(line => line.match(/^\s*\((\d+)\/(\d+)\)\s*$/))
		.find((match): match is RegExpMatchArray => match !== null);
	if (!positionMatch) {
		throw new Error("Overflow render missing production (selected/total) position marker");
	}
	const markerSelected = Number(positionMatch[1]) - 1;
	const itemCount = Number(positionMatch[2]);
	if (markerSelected !== selectedIndex) {
		throw new Error(
			`Overflow metadata/render disagreement: selectedIndex ${selectedIndex} vs marker ${markerSelected + 1}/${itemCount}`,
		);
	}
	if (itemCount !== OVERFLOW_ITEM_COUNT) {
		throw new Error(`Overflow itemCount ${itemCount} !== expected ${OVERFLOW_ITEM_COUNT}`);
	}

	const positionLineIndex = lines.findIndex(line => /^\s*\(\d+\/\d+\)\s*$/.test(line));
	if (positionLineIndex < 1) {
		throw new Error("Overflow render position marker index is invalid");
	}

	const actionLines: string[] = [];
	for (let index = positionLineIndex - 1; index >= 0; index -= 1) {
		const line = lines[index] ?? "";
		const stripped = line.replace(/^\s*[❯>]\s*/, "").trim();
		if (!stripped) break;
		if (stripped.startsWith("Global:") || stripped.startsWith("Session:") || stripped === "Notifications") break;
		actionLines.unshift(stripped);
	}
	if (actionLines.length === 0) {
		throw new Error("Overflow render exposed no visible action labels");
	}
	if (actionLines.length > OVERFLOW_MAX_VISIBLE) {
		throw new Error(`Overflow render exposed ${actionLines.length} actions; VISIBLE_ACTIONS=${OVERFLOW_MAX_VISIBLE}`);
	}
	if (itemCount > OVERFLOW_MAX_VISIBLE && actionLines.length !== OVERFLOW_MAX_VISIBLE) {
		throw new Error(
			`Overflow window must keep VISIBLE_ACTIONS=${OVERFLOW_MAX_VISIBLE}; saw ${actionLines.length} of ${itemCount}`,
		);
	}

	const visibleItemIds = actionLines.map(overflowActionIdForLabel);
	const firstVisibleCatalogIndex = overflowActionCatalog().findIndex(action => action.id === visibleItemIds[0]);
	if (firstVisibleCatalogIndex < 0) {
		throw new Error(`Unable to locate first visible action ${visibleItemIds[0]} in catalog`);
	}
	const windowStart = firstVisibleCatalogIndex;
	const windowEnd = windowStart + visibleItemIds.length;
	const expectedIds = overflowActionCatalog()
		.slice(windowStart, windowEnd)
		.map(action => action.id);
	if (expectedIds.join("\0") !== visibleItemIds.join("\0")) {
		throw new Error(
			`Overflow visibleItemIds disagree with catalog window: render=[${visibleItemIds.join(",")}] catalog=[${expectedIds.join(",")}]`,
		);
	}
	if (selectedIndex < windowStart || selectedIndex >= windowEnd) {
		throw new Error(`Overflow selectedIndex ${selectedIndex} outside derived window [${windowStart}, ${windowEnd})`);
	}

	const topBorder = lines[0];
	if (!topBorder) throw new Error("Overflow render missing top border row");
	let tabEnd = 1;
	while (tabEnd < lines.length && (lines[tabEnd] ?? "") !== "") tabEnd += 1;
	if (tabEnd <= 1) throw new Error("Overflow render missing settings tab bar rows");
	const tabBarText = lines.slice(1, tabEnd).join("\n");
	const summaryIndex = lines.findIndex((line, index) => index > tabEnd && line.trim() === "Notifications");
	if (summaryIndex < 0) throw new Error("Overflow render missing notifications summary title");
	const summaryLine = lines[summaryIndex] ?? "";

	const hintIndex = lines.findIndex(line => /Enter\/Space action/.test(line));
	if (hintIndex < 0) throw new Error("Overflow render missing action hint row");
	const hintLine = lines[hintIndex] ?? "";
	let bottomBorderIndex = lines.length - 1;
	while (bottomBorderIndex > hintIndex && (lines[bottomBorderIndex] ?? "") === "") bottomBorderIndex -= 1;
	const bottomBorder = lines[bottomBorderIndex];
	if (!bottomBorder) throw new Error("Overflow render missing bottom border row");

	return {
		itemCount,
		selectedIndex,
		windowStart,
		windowEnd,
		visibleItemIds,
		scrollPosition: windowStart,
		stickyTopRowIds: [
			stickyRowSignature("settings-frame-top", topBorder),
			stickyRowSignature("settings-tab-bar", tabBarText),
			stickyRowSignature("notifications-summary", summaryLine),
		],
		stickyBottomRowIds: [
			stickyRowSignature("action-hint", hintLine),
			stickyRowSignature("settings-frame-bottom", bottomBorder),
		],
		maxVisible: OVERFLOW_MAX_VISIBLE,
		mechanism: "maxVisible-windowed",
	};
}

function overflowSelectedIndex(sceneId: LightThemeComplianceSceneId): number {
	switch (sceneId) {
		case "overflow-top":
			return 0;
		case "overflow-middle":
			return 5;
		case "overflow-bottom":
			return OVERFLOW_ITEM_COUNT - 1;
		default:
			return 0;
	}
}

function notificationsEntryFor(
	sceneId: LightThemeComplianceSceneId,
	viewport: LightThemeComplianceViewport,
	renderMode: LightThemeComplianceRenderMode,
): NotificationsSettingsShowcaseEntry {
	const stateId = SCENE_TO_NOTIFICATIONS_STATE[sceneId];
	if (!stateId) {
		throw new Error(`No notifications state mapping for scene ${sceneId}`);
	}
	const notificationsViewport = NOTIFICATIONS_SETTINGS_SHOWCASE_ENTRIES.find(
		entry =>
			entry.viewport.id === viewport.id &&
			entry.viewport.columns === viewport.columns &&
			entry.viewport.rows === viewport.rows,
	)?.viewport;
	if (!notificationsViewport) {
		throw new Error(`No notifications viewport mapping for ${viewport.id}`);
	}
	const key = `${stateId}/${viewport.id}/${renderMode}`;
	const exact = NOTIFICATIONS_SETTINGS_SHOWCASE_ENTRIES.find(entry => entry.key === key);
	if (exact) return exact;
	const allowedAsciiVariant =
		renderMode === "ascii-no-color" && viewport.id === "80x24" && ALLOWED_NON_CANONICAL_ASCII_STATE_IDS.has(stateId);
	const allowedAnsi256Variant =
		renderMode === "unicode-256-color" &&
		stateId === "home-runtime-active" &&
		LIGHT_THEME_COMPLIANCE_VIEWPORTS.some(candidate => candidate.id === viewport.id);
	if (!allowedAsciiVariant && !allowedAnsi256Variant) {
		throw new Error(`Light-theme showcase entry is not canonical or explicitly allowed: ${key}`);
	}
	return {
		key,
		stateId,
		viewport: notificationsViewport,
		renderMode,
	};
}

function makeStatusSession(): AgentSession {
	return {
		messages: [{ role: "user", content: "hello" }],
		state: {
			messages: [{ role: "user", content: "hello" }],
			model: { id: "gjc-showcase", name: "GJC Showcase", contextWindow: 200_000, thinking: true },
			thinkingLevel: "medium",
		},
		model: { id: "gjc-showcase", name: "GJC Showcase", contextWindow: 200_000, thinking: true },
		systemPrompt: ["You are a deterministic showcase assistant."],
		agent: { state: { tools: [] } },
		modelRegistry: {
			isUsingOAuth: () => false,
		},
		skills: [],
		sessionManager: {
			getUsageStatistics: () => ({
				input: 1_024,
				output: 256,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0.42,
			}),
			getSessionName: () => "light-theme-showcase",
		},
		isStreaming: false,
		isFastModeActive: () => false,
		getAsyncJobSnapshot: () => ({ running: [] }),
		getDisplayContextSnapshot: () => ({
			contextTokens: 48_000,
			contextWindow: 200_000,
			contextPercent: 24,
		}),
	} as unknown as AgentSession;
}

function renderDiffScene(viewport: LightThemeComplianceViewport): string {
	const diffText = [
		" 10|export function greet(name: string): string {",
		"-11|  return `hi $" + "{name}`;",
		"+11|  return `hello $" + "{name}`;",
		" 12|}",
		"-13|// TODO: remove",
		"+13|// ready",
	].join("\n");
	const rendered = renderDiff(diffText, { filePath: "src/showcase.ts" });
	const lines = rendered.split("\n");
	return boundSurface(lines, viewport, "diff");
}

function renderMarkdownScene(viewport: LightThemeComplianceViewport, sceneId: LightThemeComplianceSceneId): string {
	const copy =
		sceneId === "wrap-korean"
			? CJK_COPY.korean
			: sceneId === "wrap-japanese"
				? CJK_COPY.japanese
				: sceneId === "wrap-chinese"
					? CJK_COPY.chinese
					: sceneId === "wrap-mixed-cjk-latin"
						? CJK_COPY.mixed
						: {
								title: "Light theme markdown",
								body: "Selectable [docs](https://example.invalid/docs) with `cfg.path` and fenced code.",
								action: "Continue",
								status: "OK",
							};
	const source = [
		`# ${copy.title}`,
		"",
		copy.body,
		"",
		`- ${copy.action}`,
		`- status: ${copy.status}`,
		"",
		"> Keep semantic units intact across wrap boundaries.",
		"",
		"```ts",
		'const token = "••••••••";',
		'export const cfg = { path: "/showcase/config.yml" };',
		"```",
		"",
		"---",
		"",
		`Link: [restore](https://example.invalid/restore) · \`${copy.action}\``,
	].join("\n");
	const markdown = new Markdown(source, 0, 0, getMarkdownTheme());
	const lines = markdown.render(viewport.columns);
	return boundSurface(lines, viewport, sceneId);
}

function renderSyntaxScene(viewport: LightThemeComplianceViewport): string {
	const code = [
		"// showcase syntax roles",
		"export function restore(config: Config): Result {",
		'  const path = "/showcase/config.yml";',
		"  if (config.blocked) {",
		"    return { ok: false, code: 403 };",
		"  }",
		"  return { ok: true, path };",
		"}",
	].join("\n");
	const lines = highlightCode(code, "ts");
	return boundSurface(lines, viewport, "syntax");
}

function renderStatusScene(viewport: LightThemeComplianceViewport): string {
	const session = makeStatusSession();
	const component = new StatusLineComponent(session, { version: "showcase" });
	component.updateSettings({
		preset: "custom",
		leftSegments: ["model", "path", "git"],
		rightSegments: ["cost", "jobs", "context_pct"],
		separator: "slash",
		showSkillHud: false,
		showHookStatus: false,
		sessionAccent: false,
		segmentOptions: {
			git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: false },
			model: { showThinkingLevel: true },
		},
	});
	component.setSessionStartTime(SHOWCASE_CLOCK.now());
	component.setSubagentCount(2);
	component.setJobs({
		...EMPTY_JOBS_SNAPSHOT,
		activeMonitorCount: 1,
		activeCronCount: 1,
		worstState: "running",
	});

	const rows = component.render(viewport.columns);
	const cue = renderStatusLine({ icon: "success", title: "Notifications", description: "delivery healthy" }, theme);
	return boundSurface([...rows, cue], viewport, "status");
}

function cjkLanguageFor(sceneId: LightThemeComplianceSceneId): LightThemeComplianceProvenance["cjkLanguage"] {
	switch (sceneId) {
		case "wrap-korean":
			return "korean";
		case "wrap-japanese":
			return "japanese";
		case "wrap-chinese":
			return "chinese";
		case "wrap-mixed-cjk-latin":
			return "mixed-cjk-latin";
		default:
			return undefined;
	}
}

function downsampleTruecolorAnsiTo256(ansi: string): string {
	return ansi.replace(
		/\x1b\[(38|48);2;(\d+);(\d+);(\d+)m/g,
		(_match: string, layer: string, redRaw: string, greenRaw: string, blueRaw: string): string => {
			const red = Number(redRaw);
			const green = Number(greenRaw);
			const blue = Number(blueRaw);
			let index: number;
			if (red === green && green === blue) {
				index = red < 8 ? 16 : red > 248 ? 231 : Math.round(((red - 8) / 247) * 24) + 232;
			} else {
				index =
					16 + 36 * Math.round((red / 255) * 5) + 6 * Math.round((green / 255) * 5) + Math.round((blue / 255) * 5);
			}
			return `\x1b[${layer};5;${index}m`;
		},
	);
}

function finalizeRender(
	ansi: string,
	renderMode: LightThemeComplianceRenderMode,
	themeIdentity: LightThemeComplianceThemeIdentity,
	entry: LightThemeComplianceEntry,
	window: LightThemeComplianceWindowMetadata | null,
	provenance: LightThemeComplianceProvenance,
): LightThemeComplianceRender {
	const colorAdjustedAnsi = renderMode === "unicode-256-color" ? downsampleTruecolorAnsiTo256(ansi) : ansi;
	const terminalAnsiText = renderMode === "ascii-no-color" ? Bun.stripANSI(colorAdjustedAnsi) : colorAdjustedAnsi;
	return {
		terminalText: Bun.stripANSI(terminalAnsiText),
		terminalAnsiText,
		themeIdentity,
		window,
		provenance,
		viewport: entry.viewport,
		sceneId: entry.sceneId,
		renderMode: entry.renderMode,
		key: entry.key,
	};
}

export async function renderLightThemeComplianceShowcase(
	entry: LightThemeComplianceEntry,
): Promise<LightThemeComplianceRender> {
	const requestedTheme = assertClosedTheme(entry.theme);
	if (entry.key !== buildMatrixKey(entry.theme, entry.sceneId, entry.viewport.id, entry.renderMode)) {
		throw new Error(`Light-theme compliance key mismatch for ${entry.key}`);
	}

	await Settings.init({ inMemory: true });
	const restoreChalk = await configureDeterministicLightTheme(requestedTheme, entry.renderMode);
	try {
		const themeIdentity = await resolveThemeIdentity(requestedTheme, entry.theme);

		switch (entry.sceneId) {
			case "consumer-atlas": {
				const atlasViewport = entry.viewport as LightThemeConsumerAtlasViewport;
				const ansi = renderLightThemeConsumerAtlas(atlasViewport);
				return finalizeRender(ansi, entry.renderMode, themeIdentity, entry, null, {
					fixtureSource: "packages/coding-agent/test/fixtures/tui/light-theme-compliance-showcase.ts",
					productionImports: [
						"packages/coding-agent/test/fixtures/tui/light-theme-consumer-atlas.ts",
						...LIGHT_THEME_CONSUMER_ATLAS_PRODUCTION_IMPORTS,
					],
					productionSymbols: [...LIGHT_THEME_CONSUMER_ATLAS_PRODUCTION_SYMBOLS],
					captureMode: "live-production-renderers",
					fixedClockTimestamp: FIXED_CLOCK_TIMESTAMP,
					sceneFamily: "consumer-atlas",
				});
			}
			case "diff": {
				const ansi = renderDiffScene(entry.viewport);
				return finalizeRender(ansi, entry.renderMode, themeIdentity, entry, null, {
					fixtureSource: "packages/coding-agent/test/fixtures/tui/light-theme-compliance-showcase.ts",
					productionImports: [
						"packages/coding-agent/src/modes/components/diff.ts",
						"packages/coding-agent/src/modes/theme/theme.ts",
					],
					productionSymbols: ["renderDiff", "THEME_COLOR_KEYS", "getResolvedThemeColors"],
					captureMode: "live-production-renderers",
					fixedClockTimestamp: FIXED_CLOCK_TIMESTAMP,
					sceneFamily: "diff",
				});
			}
			case "markdown":
			case "wrap-korean":
			case "wrap-japanese":
			case "wrap-chinese":
			case "wrap-mixed-cjk-latin": {
				const ansi = renderMarkdownScene(entry.viewport, entry.sceneId);
				return finalizeRender(ansi, entry.renderMode, themeIdentity, entry, null, {
					fixtureSource: "packages/coding-agent/test/fixtures/tui/light-theme-compliance-showcase.ts",
					productionImports: ["packages/coding-agent/src/modes/theme/theme.ts", "@gajae-code/tui Markdown"],
					productionSymbols: ["Markdown", "getMarkdownTheme"],
					captureMode: "live-production-renderers",
					fixedClockTimestamp: FIXED_CLOCK_TIMESTAMP,
					sceneFamily: "markdown",
					cjkLanguage: cjkLanguageFor(entry.sceneId),
				});
			}
			case "syntax": {
				const ansi = renderSyntaxScene(entry.viewport);
				return finalizeRender(ansi, entry.renderMode, themeIdentity, entry, null, {
					fixtureSource: "packages/coding-agent/test/fixtures/tui/light-theme-compliance-showcase.ts",
					productionImports: ["packages/coding-agent/src/modes/theme/theme.ts"],
					productionSymbols: ["highlightCode"],
					captureMode: "live-production-renderers",
					fixedClockTimestamp: FIXED_CLOCK_TIMESTAMP,
					sceneFamily: "syntax",
				});
			}
			case "status": {
				const ansi = renderStatusScene(entry.viewport);
				const noColorCues = entry.renderMode === "ascii-no-color" ? ASCII_NO_COLOR_CUES.status : undefined;
				return finalizeRender(ansi, entry.renderMode, themeIdentity, entry, null, {
					fixtureSource: "packages/coding-agent/test/fixtures/tui/light-theme-compliance-showcase.ts",
					productionImports: [
						"packages/coding-agent/src/modes/components/status-line.ts",
						"packages/coding-agent/src/modes/components/tool-status-header.ts",
						"packages/coding-agent/src/tui/status-line.ts",
					],
					productionSymbols: ["StatusLineComponent", "renderStatusLine", "renderSegment"],
					captureMode: "live-production-renderers",
					fixedClockTimestamp: FIXED_CLOCK_TIMESTAMP,
					sceneFamily: "status",
					noColorCues,
				});
			}
			default: {
				const notificationsEntry = notificationsEntryFor(entry.sceneId, entry.viewport, entry.renderMode);
				const selectedActionIndex =
					entry.sceneId === "overflow-top" ||
					entry.sceneId === "overflow-middle" ||
					entry.sceneId === "overflow-bottom"
						? overflowSelectedIndex(entry.sceneId)
						: undefined;
				const rendered = await renderNotificationsSettingsShowcase(notificationsEntry, requestedTheme, {
					selectedActionIndex,
				});
				let window: LightThemeComplianceWindowMetadata | null = null;
				if (
					entry.sceneId === "overflow-top" ||
					entry.sceneId === "overflow-middle" ||
					entry.sceneId === "overflow-bottom"
				) {
					window = parseOverflowWindowFromRender(rendered.terminalText, overflowSelectedIndex(entry.sceneId));
				}
				const noColorCues =
					entry.renderMode === "ascii-no-color" &&
					(LIGHT_THEME_COMPLIANCE_ASCII_NO_COLOR_SCENES as readonly string[]).includes(entry.sceneId)
						? ASCII_NO_COLOR_CUES[entry.sceneId as (typeof LIGHT_THEME_COMPLIANCE_ASCII_NO_COLOR_SCENES)[number]]
						: undefined;
				return finalizeRender(rendered.terminalAnsiText, entry.renderMode, themeIdentity, entry, window, {
					fixtureSource: "packages/coding-agent/test/fixtures/tui/light-theme-compliance-showcase.ts",
					productionImports: [
						"packages/coding-agent/src/modes/components/settings-selector.ts",
						"packages/coding-agent/src/modes/components/notifications-settings-editor.ts",
						"packages/coding-agent/test/fixtures/tui/notifications-settings-showcase.ts",
					],
					productionSymbols: [
						"SettingsSelectorComponent",
						"NotificationsSettingsEditorComponent",
						"renderNotificationsSettingsShowcase",
						"maxVisible-windowed",
					],
					captureMode: "live-production-renderers",
					fixedClockTimestamp: FIXED_CLOCK_TIMESTAMP,
					sceneFamily: "notifications-settings",
					notificationsStateId: notificationsEntry.stateId,
					cjkLanguage: cjkLanguageFor(entry.sceneId),
					noColorCues,
				});
			}
		}
	} finally {
		restoreChalk();
	}
}

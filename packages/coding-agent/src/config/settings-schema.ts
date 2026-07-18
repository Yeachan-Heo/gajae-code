import type { Effort } from "@gajae-code/ai/model-thinking";
import { PET_MODE_IDS, PET_SKIN_IDS, PET_SKINS } from "@gajae-code/tui/components/gajae-pet";
import { TASK_SIMPLE_MODES } from "../task/simple-mode";
import { getThinkingLevelMetadata } from "../thinking-metadata";
import { EDIT_MODES } from "../utils/edit-mode";
import { CONFIGURABLE_SEARCH_PROVIDER_IDS } from "../web/search/types";
import type { ModelSelectorValue } from "./model-selector-value";

const THINKING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as readonly Effort[];
const DEFAULT_THINKING_LEVELS = ["off", ...THINKING_EFFORTS] as const;

import {
	DEFAULT_DISABLED_EXTENSIONS,
	DEFAULT_SKILL_DISCOVERY_SETTINGS,
	type SkillDiscoverySettings,
} from "./skill-settings-defaults";

/** Unified settings schema - single source of truth for all settings.
 *
 * Each setting is defined once here with:
 * - Type and default value
 * - Optional UI metadata (label, description, tab)
 *
 * The Settings singleton provides type-safe path-based access:
 *   settings.get("compaction.enabled")  // => boolean
 *   settings.set("theme.dark", "red-claw")  // sync, saves in background
 */

// ═══════════════════════════════════════════════════════════════════════════
// Schema Definition Types
// ═══════════════════════════════════════════════════════════════════════════

export type SettingTab =
	| "appearance"
	| "model"
	| "interaction"
	| "context"
	| "memory"
	| "editing"
	| "tools"
	| "tasks"
	| "providers"
	| "notifications";

/** Tab display metadata - icon is resolved via theme.symbol() */
export type TabMetadata = { label: string; icon: `tab.${string}` };

/** Ordered list of tabs for UI rendering */
export const SETTING_TABS: SettingTab[] = [
	"appearance",
	"model",
	"interaction",
	"context",
	"memory",
	"editing",
	"tools",
	"tasks",
	"providers",
	"notifications",
];

/** Tab display metadata - icon is a symbol key from theme.ts (tab.*) */
export const TAB_METADATA: Record<SettingTab, { label: string; icon: `tab.${string}` }> = {
	appearance: { label: "Appearance", icon: "tab.appearance" },
	model: { label: "Model", icon: "tab.model" },
	interaction: { label: "Interaction", icon: "tab.interaction" },
	context: { label: "Context", icon: "tab.context" },
	memory: { label: "Memory", icon: "tab.memory" },
	editing: { label: "Editing", icon: "tab.editing" },
	tools: { label: "Tools", icon: "tab.tools" },
	tasks: { label: "Tasks", icon: "tab.tasks" },
	providers: { label: "Providers", icon: "tab.providers" },
	notifications: { label: "Notifications", icon: "tab.providers" },
};

/** Status line segment identifiers */
export type StatusLineSegmentId =
	| "gajae"
	| "pi" // legacy custom alias; public presets use gajae
	| "model"
	| "mode"
	| "path"
	| "git"
	| "pr"
	| "subagents"
	| "jobs"
	| "token_in"
	| "token_out"
	| "token_total"
	| "token_rate"
	| "cost"
	| "context_pct"
	| "context_total"
	| "time_spent"
	| "time"
	| "session"
	| "hostname"
	| "cache_read"
	| "cache_write"
	| "session_name"
	| "usage";

/** Submenu choice metadata. */
export type SubmenuOption<V extends string = string> = {
	value: V;
	label: string;
	description?: string;
};

interface UiBase {
	tab: SettingTab;
	label: string;
	description: string;
	/** Condition function name - setting only shown when true */
	condition?: string;
	/**
	 * Persistence owner for settings which must not use the generic immediate
	 * settings-list write path.
	 */
	editing?: "notification-atomic";
}

interface UiBoolean extends UiBase {}

interface UiEnum<T extends readonly string[]> extends UiBase {
	/** Submenu options. When omitted, the enum renders as an inline toggle derived from `values`. */
	options?: ReadonlyArray<SubmenuOption<T[number]>>;
}

interface UiNumber extends UiBase {
	/** Submenu options. Without options, a numeric setting has no UI representation (intentional hide). */
	options?: ReadonlyArray<SubmenuOption>;
}

interface UiString extends UiBase {
	/**
	 * Submenu options.
	 *  - Array  → submenu with these choices.
	 *  - "runtime" → submenu populated by the runtime layer (theme registry, etc.).
	 *  - Omitted → renders as a free text input.
	 */
	options?: ReadonlyArray<SubmenuOption> | "runtime";
}

/** Wide ui shape exposed to consumers that walk the schema generically. */
export type AnyUiMetadata = UiBase & {
	options?: ReadonlyArray<SubmenuOption> | "runtime";
};

interface BooleanDef {
	type: "boolean";
	default: boolean;
	ui?: UiBoolean;
}

interface StringDef {
	type: "string";
	default: string | undefined;
	ui?: UiString;
}

interface NumberDef {
	type: "number";
	default: number;
	validate?: (value: number) => boolean;
	ui?: UiNumber;
}

interface EnumDef<T extends readonly string[]> {
	type: "enum";
	values: T;
	default: T[number];
	ui?: UiEnum<T>;
}

interface ArrayDef<T> {
	type: "array";
	default: T[];
	items?: { enum: readonly string[] };
	ui?: UiBase;
}

interface RecordValueDef {
	type: "model-selector-value";
}

interface RecordDef<T> {
	type: "record";
	default: Record<string, T>;
	valueSchema?: RecordValueDef;
	ui?: UiBase;
}

type SettingDef =
	| BooleanDef
	| StringDef
	| NumberDef
	| EnumDef<readonly string[]>
	| ArrayDef<unknown>
	| RecordDef<unknown>;

// ═══════════════════════════════════════════════════════════════════════════
// Schema Definition
// ═══════════════════════════════════════════════════════════════════════════

export interface ModelTagDef {
	name: string;
	color?: string;
}

export interface ModelTagsSettings {
	[key: string]: ModelTagDef;
}

// Typed defaults for array/record settings — named constants avoid `as` casts
// under `as const` while still letting SettingValue infer the correct element type.
const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_MODEL_SELECTOR_RECORD: Record<string, ModelSelectorValue> = {};
const MODEL_SELECTOR_VALUE_SCHEMA = { type: "model-selector-value" } as const;
const DEFAULT_CYCLE_ORDER: string[] = ["default"];
const EMPTY_MODEL_TAGS_RECORD: ModelTagsSettings = {};
const HINDSIGHT_RECALL_TYPES_DEFAULT: string[] = ["world", "experience"];
export const DEFAULT_BASH_INTERCEPTOR_RULES: BashInterceptorRule[] = [
	{
		pattern: "^\\s*(cat|head|tail|less|more)\\s+",
		tool: "read",
		message: "Use the `read` tool instead of cat/head/tail. It provides better context and handles binary files.",
	},
	{
		pattern: "^\\s*(grep|rg|ripgrep|ag|ack)\\s+",
		tool: "search",
		message: "Use the `search` tool instead of grep/rg. It respects .gitignore and provides structured output.",
	},
	{
		pattern: "^\\s*(find|fd|locate)\\s+.*(-name|-iname|-type|--type|-glob)",
		tool: "find",
		message: "Use the `find` tool instead of find/fd. It respects .gitignore and is faster for glob patterns.",
	},
	{
		pattern: "^\\s*sed\\s+(-i|--in-place)",
		tool: "edit",
		message: "Use the `edit` tool instead of sed -i. It provides diff preview and fuzzy matching.",
	},
	{
		pattern: "^\\s*perl\\s+.*-[pn]?i",
		tool: "edit",
		message: "Use the `edit` tool instead of perl -i. It provides diff preview and fuzzy matching.",
	},
	{
		pattern: "^\\s*awk\\s+.*-i\\s+inplace",
		tool: "edit",
		message: "Use the `edit` tool instead of awk -i inplace. It provides diff preview and fuzzy matching.",
	},
	{
		pattern: "^\\s*(echo|printf|cat\\s*<<)\\s+.*[^|]>\\s*\\S",
		tool: "write",
		message: "Use the `write` tool instead of echo/cat redirection. It handles encoding and provides confirmation.",
	},
];

export const SETTINGS_SCHEMA = {
	// ────────────────────────────────────────────────────────────────────────
	// General settings (no UI)
	// ────────────────────────────────────────────────────────────────────────
	lastChangelogVersion: { type: "string", default: undefined },

	// Auth broker — credentials proxied through a remote `gjc auth-broker serve`
	// host. Hidden from the UI; populate via env vars or hand-edited config.yml.
	// Env (`GJC_AUTH_BROKER_URL` / `GJC_AUTH_BROKER_TOKEN`) takes precedence so
	// per-machine overrides remain trivial.
	"auth.broker.url": { type: "string", default: undefined },
	"auth.broker.token": { type: "string", default: undefined },
	"session.directoryMigration": {
		type: "enum",
		values: ["copy-retain", "disabled"] as const,
		default: "copy-retain",
	},

	// Notifications (shared daemon with Telegram/Discord/Slack presentation adapters)
	"notifications.enabled": { type: "boolean", default: false },
	"notifications.telegram.botToken": {
		type: "string",
		default: undefined,
		validate: (value: unknown) => typeof value === "string",
	},
	"notifications.telegram.chatId": { type: "string", default: undefined },
	"notifications.telegram.activation": { type: "record", default: {} as Record<string, unknown> },
	"notifications.telegram.btw.enabled": { type: "boolean", default: true },
	"notifications.telegram.rich.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "notifications",
			label: "Telegram Rich Messages",
			description: "Format Telegram notifications with rich message content.",
			editing: "notification-atomic",
		},
	},
	"notifications.telegram.richDraft.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "notifications",
			label: "Telegram Rich Drafts",
			description: "Include rich draft updates in Telegram notifications.",
			editing: "notification-atomic",
		},
	},
	"notifications.telegram.topics.nameTemplate": { type: "string", default: undefined },
	"notifications.discord.botToken": { type: "string", default: undefined },
	"notifications.discord.applicationId": { type: "string", default: undefined },
	"notifications.discord.guildId": { type: "string", default: undefined },
	"notifications.discord.parentChannelId": { type: "string", default: undefined },
	"notifications.slack.botToken": { type: "string", default: undefined },
	"notifications.slack.appToken": { type: "string", default: undefined },
	"notifications.slack.workspaceId": { type: "string", default: undefined },
	"notifications.slack.channelId": { type: "string", default: undefined },
	"notifications.slack.authorizedUserId": { type: "string", default: undefined },
	"notifications.redact": {
		type: "boolean",
		default: false,
		ui: {
			tab: "notifications",
			label: "Redact Notification Content",
			description: "Redact sensitive content before notifications are delivered.",
			editing: "notification-atomic",
		},
	},
	"notifications.verbosity": {
		type: "string",
		default: "lean",
		validate: (value: string) => value === "lean" || value === "verbose",
		ui: {
			tab: "notifications",
			label: "Notification Verbosity",
			description: "Choose concise or detailed notification messages.",
			options: [
				{ value: "lean", label: "Lean", description: "Send concise notification messages" },
				{ value: "verbose", label: "Verbose", description: "Send detailed notification messages" },
			],
			editing: "notification-atomic",
		},
	},
	"notifications.sessionScope": {
		type: "string",
		default: "all",
		validate: (value: string) => value === "all" || value === "primary",
		ui: {
			tab: "notifications",
			label: "Notification Session Scope",
			description: "Send notifications from all sessions or only the primary session.",
			options: [
				{ value: "all", label: "All Sessions", description: "Allow eligible sessions" },
				{
					value: "primary",
					label: "Primary Session",
					description: "Limit automatic notifications to the primary session",
				},
			],
			editing: "notification-atomic",
		},
	},
	"notifications.daemon.idleTimeoutMs": {
		type: "number",
		default: 60000,
		validate: (value: number) => Number.isFinite(value) && value > 0,
	},

	"notifications.terminalBell": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			label: "Terminal Bell",
			description:
				"Emit a BEL character for local terminal notifications. Windows Terminal may keep BEL silent depending on profile/system sound settings; use completion.notifyCommand for a PowerShell Console.Beep workaround.",
		},
	},
	"notifications.bellOnComplete": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			label: "Bell on Completion",
			description: "Ring the terminal bell when an agent turn completes",
		},
	},
	"notifications.bellOnApproval": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			label: "Bell on Approval",
			description: "Ring the terminal bell when a plan or approval prompt needs attention",
		},
	},
	"notifications.bellOnAsk": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			label: "Bell on Ask",
			description: "Ring the terminal bell when an ask/user-input prompt needs attention",
		},
	},

	autoResume: {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			label: "Auto Resume",
			description: "Automatically resume the most recent session in the current directory",
		},
	},

	// macOS power assertions (caffeinate flags). No-op on other platforms.
	"power.preventIdleSleep": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			label: "Prevent Idle Sleep (macOS)",
			description: "caffeinate -i: keep the system awake while a session is open",
		},
	},
	"power.preventSystemSleep": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			label: "Prevent System Sleep on AC (macOS)",
			description: "caffeinate -s: block all system sleep while on AC power",
		},
	},
	"power.declareUserActive": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			label: "Declare User Active (macOS)",
			description: "caffeinate -u: keep the display lit and treat the user as active",
		},
	},
	"power.preventDisplaySleep": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			label: "Prevent Display Sleep (macOS)",
			description: "caffeinate -d: keep the display from idle-sleeping while a session is open",
		},
	},
	shellPath: { type: "string", default: undefined },

	extensions: { type: "array", default: EMPTY_STRING_ARRAY },

	"marketplace.autoUpdate": {
		type: "enum",
		values: ["off", "notify", "auto"] as const,
		default: "off",
	},

	enabledModels: { type: "array", default: EMPTY_STRING_ARRAY },

	disabledProviders: { type: "array", default: EMPTY_STRING_ARRAY },

	disabledExtensions: { type: "array", default: DEFAULT_DISABLED_EXTENSIONS },

	modelRoles: { type: "record", default: EMPTY_MODEL_SELECTOR_RECORD, valueSchema: MODEL_SELECTOR_VALUE_SCHEMA },
	"modelProfile.default": {
		type: "string",
		default: undefined,
		ui: {
			tab: "model",
			label: "Default Model Profile",
			description: "Model profile applied automatically at startup",
			options: "runtime",
		},
	},

	modelTags: { type: "record", default: EMPTY_MODEL_TAGS_RECORD },

	modelProviderOrder: { type: "array", default: EMPTY_STRING_ARRAY },

	cycleOrder: { type: "array", default: DEFAULT_CYCLE_ORDER },

	"gjc.deepInterview.ambiguityThreshold": {
		type: "number",
		default: 0.05,
		validate: (value: number) => Number.isFinite(value) && value > 0 && value <= 1,
	},

	// ────────────────────────────────────────────────────────────────────────
	// Appearance
	// ────────────────────────────────────────────────────────────────────────

	// Theme
	"theme.dark": {
		type: "string",
		default: "red-claw",
		ui: {
			tab: "appearance",
			label: "Dark Theme",
			description: "Theme used when terminal has dark background",
			options: "runtime",
		},
	},

	"theme.light": {
		type: "string",
		default: "blue-crab",
		ui: {
			tab: "appearance",
			label: "Light Theme",
			description: "Theme used when terminal has light background",
			options: "runtime",
		},
	},

	symbolPreset: {
		type: "enum",
		values: ["unicode", "nerd", "ascii"] as const,
		default: "unicode",
		ui: {
			tab: "appearance",
			label: "Symbol Preset",
			description: "Icon/symbol style",
			options: [
				{ value: "unicode", label: "Unicode", description: "Standard symbols (default)" },
				{ value: "nerd", label: "Nerd Font", description: "Requires Nerd Font" },
				{ value: "ascii", label: "ASCII", description: "Maximum compatibility" },
			],
		},
	},

	colorBlindMode: {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			label: "Color-Blind Mode",
			description: "Use blue instead of green for diff additions",
		},
	},

	// Status line
	"statusLine.preset": {
		type: "enum",
		values: ["default", "default-usage", "minimal", "compact", "full", "nerd", "ascii", "custom"] as const,
		default: "default",
		ui: {
			tab: "appearance",
			label: "Status Line Preset",
			description: "Pre-built status line configurations",
			options: [
				{ value: "default", label: "Default", description: "Model, path, git, context, tokens, cost" },
				{
					value: "default-usage",
					label: "Default + Usage",
					description: "Default layout with provider usage quota",
				},
				{ value: "minimal", label: "Minimal", description: "Path and git only" },
				{ value: "compact", label: "Compact", description: "Model, git, cost, context" },
				{ value: "full", label: "Full", description: "All segments including time" },
				{ value: "nerd", label: "Nerd", description: "Maximum info with Nerd Font icons" },
				{ value: "ascii", label: "ASCII", description: "No special characters" },
				{ value: "custom", label: "Custom", description: "User-defined segments" },
			],
		},
	},

	"statusLine.separator": {
		type: "enum",
		values: ["powerline", "powerline-thin", "slash", "pipe", "block", "none", "ascii"] as const,
		default: "slash",
		ui: {
			tab: "appearance",
			label: "Status Line Separator",
			description: "Style of separators between segments",
			options: [
				{ value: "powerline", label: "Powerline", description: "Solid arrows (Nerd Font)" },
				{ value: "powerline-thin", label: "Thin chevron", description: "Thin arrows (Nerd Font)" },
				{ value: "slash", label: "Slash", description: "Forward slashes" },
				{ value: "pipe", label: "Pipe", description: "Vertical pipes" },
				{ value: "block", label: "Block", description: "Solid blocks" },
				{ value: "none", label: "None", description: "Space only" },
				{ value: "ascii", label: "ASCII", description: "Greater-than signs" },
			],
		},
	},

	"statusLine.sessionAccent": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			label: "Session Accent",
			description: "Use the session name color for the editor border and status line gap",
		},
	},

	"pet.mode": {
		type: "enum",
		values: PET_MODE_IDS,
		default: "off",
		ui: {
			tab: "appearance",
			label: "Gajae Pet",
			description: "16x16 real-pixel gajae living beside the composer (sixel/kitty terminals)",
			options: [
				{ value: "off", label: "Off", description: "No pet" },
				...PET_SKIN_IDS.map(id => ({
					value: id,
					label: PET_SKINS[id].label,
					description: PET_SKINS[id].description,
				})),
			],
		},
	},
	"statusLine.maxRows": {
		type: "number",
		default: 1,
		ui: {
			tab: "appearance",
			label: "Status Line Rows",
			description:
				"Maximum rows for the status line. When greater than 1, overflowing segments wrap onto additional rows instead of being dropped.",
			options: [
				{ value: "1", label: "1 row", description: "Single line; overflow is truncated (default)" },
				{ value: "2", label: "2 rows", description: "Wrap overflow onto a second row" },
				{ value: "3", label: "3 rows", description: "Wrap overflow across up to three rows" },
			],
		},
	},
	"tools.artifactSpillThreshold": {
		type: "number",
		default: 50,
		ui: {
			tab: "tools",
			label: "Artifact spill threshold (KB)",
			description: "Tool output above this size is saved as an artifact; tail is kept inline",
			options: [
				{ value: "1", label: "1 KB", description: "~250 tokens" },
				{ value: "2.5", label: "2.5 KB", description: "~625 tokens" },
				{ value: "5", label: "5 KB", description: "~1.25K tokens" },
				{ value: "10", label: "10 KB", description: "~2.5K tokens" },
				{ value: "20", label: "20 KB", description: "~5K tokens" },
				{ value: "30", label: "30 KB", description: "~7.5K tokens" },
				{ value: "50", label: "50 KB", description: "Default; ~12.5K tokens" },
				{ value: "75", label: "75 KB", description: "~19K tokens" },
				{ value: "100", label: "100 KB", description: "~25K tokens" },
				{ value: "200", label: "200 KB", description: "~50K tokens" },
				{ value: "500", label: "500 KB", description: "~125K tokens" },
				{ value: "1000", label: "1 MB", description: "~250K tokens" },
			],
		},
	},
	"tools.preAdmissionArtifactSpill": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			label: "Pre-admission artifact spill",
			description:
				"Experimental opt-in: save oversized tool results before provider context construction, retaining a UTF-8-safe head, tail, digest, and artifact receipt inline",
		},
	},

	"tools.readArtifactSpillThreshold": {
		type: "number",
		default: 0,
		ui: {
			tab: "tools",
			label: "Experimental read-tool artifact spill threshold (KB)",
			description:
				"Advanced opt-in only: combined-size cap for `read` output across all requested ranges. Above this the full output is saved as an artifact and a bounded head+tail snippet is kept inline. Live layofflabs/gpt-5.5 medium evidence on 2026-07-07 found no token savings and a lower cache-hit rate at 50 KB, so normal coding sessions should leave this Off unless intentionally measuring large-read behavior.",
			options: [
				{ value: "0", label: "Off", description: "Default; no read-specific spill (backstop only)" },
				{ value: "50", label: "50 KB", description: "~12.5K tokens" },
				{ value: "100", label: "100 KB", description: "~25K tokens" },
				{ value: "256", label: "256 KB", description: "~64K tokens" },
				{ value: "512", label: "512 KB", description: "~128K tokens" },
				{ value: "1000", label: "1 MB", description: "~250K tokens" },
			],
		},
	},

	"tools.fileMentionInlineBytes": {
		type: "number",
		default: 20,
		ui: {
			tab: "tools",
			label: "File-mention inline cap (KB)",
			description:
				"Inline byte cap for auto-read `@path` file mentions, deliberately below the read-tool cap so an incidental mention injects a smaller snippet than an explicit read. The full file is still available via the read tool.",
			options: [
				{ value: "5", label: "5 KB", description: "~1.25K tokens" },
				{ value: "10", label: "10 KB", description: "~2.5K tokens" },
				{ value: "20", label: "20 KB", description: "Default; ~5K tokens" },
				{ value: "50", label: "50 KB", description: "~12.5K tokens (matches read cap)" },
			],
		},
	},
	"tools.artifactTailBytes": {
		type: "number",
		default: 20,
		ui: {
			tab: "tools",
			label: "Artifact tail size (KB)",
			description: "Amount of tail content kept inline when output spills to artifact",
			options: [
				{ value: "1", label: "1 KB", description: "~250 tokens" },
				{ value: "2.5", label: "2.5 KB", description: "~625 tokens" },
				{ value: "5", label: "5 KB", description: "~1.25K tokens" },
				{ value: "10", label: "10 KB", description: "~2.5K tokens" },
				{ value: "20", label: "20 KB", description: "Default; ~5K tokens" },
				{ value: "50", label: "50 KB", description: "~12.5K tokens" },
				{ value: "100", label: "100 KB", description: "~25K tokens" },
				{ value: "200", label: "200 KB", description: "~50K tokens" },
			],
		},
	},
	"tools.artifactHeadBytes": {
		type: "number",
		default: 20,
		ui: {
			tab: "tools",
			label: "Artifact head size (KB)",
			description:
				"Amount of head content kept inline alongside the tail when output spills to artifact (middle elision). 0 disables — keep tail only.",
			options: [
				{ value: "0", label: "0 KB", description: "Disabled; tail-only truncation" },
				{ value: "1", label: "1 KB", description: "~250 tokens" },
				{ value: "2.5", label: "2.5 KB", description: "~625 tokens" },
				{ value: "5", label: "5 KB", description: "~1.25K tokens" },
				{ value: "10", label: "10 KB", description: "~2.5K tokens" },
				{ value: "20", label: "20 KB", description: "Default; ~5K tokens" },
				{ value: "50", label: "50 KB", description: "~12.5K tokens" },
				{ value: "100", label: "100 KB", description: "~25K tokens" },
				{ value: "200", label: "200 KB", description: "~50K tokens" },
			],
		},
	},
	"tools.outputMaxColumns": {
		type: "number",
		default: 768,
		ui: {
			tab: "tools",
			label: "Output column cap",
			description:
				"Per-line byte cap for streaming tool outputs (bash, ssh, python, js eval) and `read`. Lines wider than this are ellipsis-truncated; remaining bytes up to the next newline are dropped. 0 disables.",
			options: [
				{ value: "0", label: "Off", description: "No per-line cap" },
				{ value: "256", label: "256", description: "Tight" },
				{ value: "512", label: "512" },
				{ value: "768", label: "768", description: "Default" },
				{ value: "1024", label: "1024" },
				{ value: "2048", label: "2048" },
				{ value: "4096", label: "4096", description: "Loose" },
			],
		},
	},
	"tools.artifactTailLines": {
		type: "number",
		default: 500,
		ui: {
			tab: "tools",
			label: "Artifact tail lines",
			description: "Maximum lines of tail content kept inline when output spills to artifact",
			options: [
				{ value: "50", label: "50 lines", description: "~250 tokens" },
				{ value: "100", label: "100 lines", description: "~500 tokens" },
				{ value: "250", label: "250 lines", description: "~1.25K tokens" },
				{ value: "500", label: "500 lines", description: "Default; ~2.5K tokens" },
				{ value: "1000", label: "1000 lines", description: "~5K tokens" },
				{ value: "2000", label: "2000 lines", description: "~10K tokens" },
				{ value: "5000", label: "5000 lines", description: "~25K tokens" },
			],
		},
	},

	"tools.maxInlineResultBytes": {
		type: "number",
		default: 0,
		ui: {
			tab: "tools",
			label: "Max inline tool-result size (KB)",
			description:
				"Absolute backstop cap on inline tool-result text, enforced after artifact spill for every tool (including read and tools that set their own partial artifact meta). Output above this size is force-saved as an artifact and truncated to head+tail. 0 disables (default; opt-in pending measurement).",
			options: [
				{ value: "0", label: "Off", description: "Disabled; no absolute inline cap" },
				{ value: "20", label: "20 KB", description: "~5K tokens" },
				{ value: "30", label: "30 KB", description: "~7.5K tokens" },
				{ value: "50", label: "50 KB", description: "~12.5K tokens" },
				{ value: "75", label: "75 KB", description: "~19K tokens" },
				{ value: "100", label: "100 KB", description: "~25K tokens" },
			],
		},
	},

	"statusLine.showHookStatus": {
		type: "boolean",
		default: false,
	},

	"statusLine.showSkillHud": {
		type: "boolean",
		default: true,
	},

	"statusLine.leftSegments": { type: "array", default: [] as StatusLineSegmentId[] },

	"statusLine.rightSegments": { type: "array", default: [] as StatusLineSegmentId[] },

	"statusLine.segmentOptions": { type: "record", default: {} as Record<string, unknown> },

	// Images and terminal
	"terminal.showImages": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			label: "Show Inline Images",
			description: "Render images inline in terminal",
			condition: "hasImageProtocol",
		},
	},

	"images.autoResize": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			label: "Auto-Resize Images",
			description: "Resize large images to 2000x2000 max for better model compatibility",
		},
	},

	"images.blockImages": {
		type: "boolean",
		default: false,
		ui: { tab: "appearance", label: "Block Images", description: "Prevent images from being sent to LLM providers" },
	},

	"tui.maxInlineImageColumns": {
		type: "number",
		default: 100,
		description:
			"Maximum width in terminal columns for inline images (default 100). Set to 0 for unlimited (bounded only by terminal width).",
	},

	"tui.maxInlineImageRows": {
		type: "number",
		default: 20,
		description:
			"Maximum height in terminal rows for inline images (default 20). Set to 0 to use only the viewport-based limit (60% of terminal height).",
	},

	"tui.hyperlinks": {
		type: "enum",
		values: ["off", "auto", "always"] as const,
		default: "auto",
		ui: {
			tab: "appearance",
			label: "Terminal Hyperlinks",
			description:
				"Wrap file paths in OSC 8 hyperlinks for terminal-native click-to-open (auto: detect support; off: never; always: unconditional)",
		},
	},
	// Display rendering
	"display.tabWidth": {
		type: "number",
		default: 3,
	},

	"display.shimmer": {
		type: "enum",
		values: ["classic", "kitt", "disabled"] as const,
		default: "classic",
		ui: {
			tab: "appearance",
			label: "Shimmer",
			description: "Animation style for working/loading messages",
			options: [
				{ value: "classic", label: "Classic", description: "Soft cosine wave sweeping across the text" },
				{ value: "kitt", label: "KITT Scanner", description: "Knight Rider 1982 red light bouncing left-right" },
				{ value: "disabled", label: "Disabled", description: "No animation; static muted text" },
			],
		},
	},

	"display.showTokenUsage": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			label: "Show Token Usage",
			description: "Show per-turn token usage on assistant messages",
		},
	},

	showHardwareCursor: {
		type: "boolean",
		default: true, // will be computed based on platform if undefined
		ui: { tab: "appearance", label: "Show Hardware Cursor", description: "Show terminal cursor for IME support" },
	},

	clearOnShrink: {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			label: "Clear on Shrink",
			description: "Clear empty rows when content shrinks (may cause flicker)",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Model
	// ────────────────────────────────────────────────────────────────────────

	// Reasoning and prompts
	defaultThinkingLevel: {
		type: "enum",
		values: DEFAULT_THINKING_LEVELS,
		default: THINKING_EFFORTS[3],
		ui: {
			tab: "model",
			label: "Thinking Level",
			description: "Reasoning depth for thinking-capable models",
			options: [...DEFAULT_THINKING_LEVELS.map(getThinkingLevelMetadata)],
		},
	},

	hideThinkingBlock: {
		type: "boolean",
		default: false,
		ui: { tab: "model", label: "Hide Thinking Blocks", description: "Hide thinking blocks in assistant responses" },
	},

	repeatToolDescriptions: {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			label: "Repeat Tool Descriptions",
			description: "Render full tool descriptions in the system prompt instead of a tool name list",
		},
	},

	// Sampling
	temperature: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			label: "Temperature",
			description: "Sampling temperature (0 = deterministic, 1 = creative, -1 = provider default)",
			options: [
				{ value: "-1", label: "Default", description: "Use provider default" },
				{ value: "0", label: "0", description: "Deterministic" },
				{ value: "0.2", label: "0.2", description: "Focused" },
				{ value: "0.5", label: "0.5", description: "Balanced" },
				{ value: "0.7", label: "0.7", description: "Creative" },
				{ value: "1", label: "1", description: "Maximum variety" },
			],
		},
	},

	topP: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			label: "Top P",
			description: "Nucleus sampling cutoff (0-1, -1 = provider default)",
			options: [
				{ value: "-1", label: "Default", description: "Use provider default" },
				{ value: "0.1", label: "0.1", description: "Very focused" },
				{ value: "0.3", label: "0.3", description: "Focused" },
				{ value: "0.5", label: "0.5", description: "Balanced" },
				{ value: "0.9", label: "0.9", description: "Broad" },
				{ value: "1", label: "1", description: "No nucleus filtering" },
			],
		},
	},

	topK: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			label: "Top K",
			description: "Sample from top-K tokens (-1 = provider default)",
			options: [
				{ value: "-1", label: "Default", description: "Use provider default" },
				{ value: "1", label: "1", description: "Greedy top token" },
				{ value: "20", label: "20", description: "Focused" },
				{ value: "40", label: "40", description: "Balanced" },
				{ value: "100", label: "100", description: "Broad" },
			],
		},
	},

	minP: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			label: "Min P",
			description: "Minimum probability threshold (0-1, -1 = provider default)",
			options: [
				{ value: "-1", label: "Default", description: "Use provider default" },
				{ value: "0.01", label: "0.01", description: "Very permissive" },
				{ value: "0.05", label: "0.05", description: "Balanced" },
				{ value: "0.1", label: "0.1", description: "Strict" },
			],
		},
	},

	presencePenalty: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			label: "Presence Penalty",
			description: "Penalty for introducing already-present tokens (-1 = provider default)",
			options: [
				{ value: "-1", label: "Default", description: "Use provider default" },
				{ value: "0", label: "0", description: "No penalty" },
				{ value: "0.5", label: "0.5", description: "Mild novelty" },
				{ value: "1", label: "1", description: "Encourage novelty" },
				{ value: "2", label: "2", description: "Strong novelty" },
			],
		},
	},

	repetitionPenalty: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			label: "Repetition Penalty",
			description: "Penalty for repeated tokens (-1 = provider default)",
			options: [
				{ value: "-1", label: "Default", description: "Use provider default" },
				{ value: "0.8", label: "0.8", description: "Allow repetition" },
				{ value: "1", label: "1", description: "No penalty" },
				{ value: "1.1", label: "1.1", description: "Mild penalty" },
				{ value: "1.2", label: "1.2", description: "Balanced" },
				{ value: "1.5", label: "1.5", description: "Strong penalty" },
			],
		},
	},

	serviceTier: {
		type: "enum",
		values: ["none", "auto", "default", "flex", "scale", "priority", "openai-only", "claude-only"] as const,
		default: "none",
		ui: {
			tab: "model",
			label: "Service Tier",
			description:
				'Processing priority hint (none = omit). OpenAI accepts the tier values directly; Anthropic realizes `priority` as `speed: "fast"` on supported Opus models. Scoped values target one family.',
			options: [
				{ value: "none", label: "None", description: "Omit service_tier parameter" },
				{ value: "auto", label: "Auto", description: "Use provider default tier selection (OpenAI)" },
				{ value: "default", label: "Default", description: "Standard priority processing (OpenAI)" },
				{ value: "flex", label: "Flex", description: "Flexible capacity tier when available (OpenAI)" },
				{ value: "scale", label: "Scale", description: "Scale Tier credits when available (OpenAI)" },
				{
					value: "priority",
					label: "Priority",
					description: "Priority on every supported provider (OpenAI `service_tier`, Anthropic fast mode)",
				},
				{
					value: "openai-only",
					label: "Priority (OpenAI only)",
					description: "Priority on OpenAI/OpenAI-Codex requests; ignored elsewhere",
				},
				{
					value: "claude-only",
					label: "Priority (Claude only)",
					description: "Anthropic fast mode on direct Claude requests; ignored elsewhere (incl. Bedrock/Vertex)",
				},
			],
		},
	},

	"task.serviceTier": {
		type: "enum",
		values: [
			"inherit",
			"none",
			"auto",
			"default",
			"flex",
			"scale",
			"priority",
			"openai-only",
			"claude-only",
		] as const,
		default: "inherit",
		ui: {
			tab: "tasks",
			label: "Subagent Service Tier",
			description:
				'Service tier applied to task-tool subagents only. "inherit" copies the main session tier; any explicit value overrides it for subagents without touching the main session.',
			options: [
				{
					value: "inherit",
					label: "Inherit",
					description: "Use the main session's service tier (default)",
				},
				{ value: "none", label: "None", description: "Omit service_tier for subagents" },
				{ value: "auto", label: "Auto", description: "Use provider default tier selection (OpenAI)" },
				{ value: "default", label: "Default", description: "Standard priority processing (OpenAI)" },
				{ value: "flex", label: "Flex", description: "Flexible capacity tier when available (OpenAI)" },
				{ value: "scale", label: "Scale", description: "Scale Tier credits when available (OpenAI)" },
				{
					value: "priority",
					label: "Priority",
					description: "Priority on every supported provider (OpenAI `service_tier`, Anthropic fast mode)",
				},
				{
					value: "openai-only",
					label: "Priority (OpenAI only)",
					description: "Priority on OpenAI/OpenAI-Codex requests; ignored elsewhere",
				},
				{
					value: "claude-only",
					label: "Priority (Claude only)",
					description: "Anthropic fast mode on direct Claude requests; ignored elsewhere (incl. Bedrock/Vertex)",
				},
			],
		},
	},

	"fallback.maxAttempts": {
		type: "number",
		default: 3,
		validate: (value: number) => Number.isInteger(value) && value > 0,
	},

	// Retries
	"retry.enabled": { type: "boolean", default: true },

	"retry.maxRetries": {
		type: "number",
		default: 3,
		ui: {
			tab: "model",
			label: "Retry Attempts",
			description: "Maximum retry attempts on API errors",
			options: [
				{ value: "1", label: "1 retry" },
				{ value: "2", label: "2 retries" },
				{ value: "3", label: "3 retries" },
				{ value: "5", label: "5 retries" },
				{ value: "10", label: "10 retries" },
			],
		},
	},

	"retry.baseDelayMs": { type: "number", default: 2000 },
	"retry.maxDelayMs": {
		type: "number",
		default: 5 * 60 * 1000,
		ui: {
			tab: "model",
			label: "Max Retry Delay",
			description:
				"Maximum wait between retries, in ms. Legacy retries clamp provider Retry-After hints to this value; managed fallback honors typed Retry-After hints even when they exceed it.",
		},
	},
	"retry.requestMaxRetries": {
		type: "number",
		default: 5,
		ui: {
			tab: "model",
			label: "Provider Request Retries",
			description:
				"Maximum provider request retries before a stream is established. Counts retries, not the first attempt. Set to 0 to disable provider request retries.",
		},
	},
	"retry.streamMaxRetries": {
		type: "number",
		default: 5,
		ui: {
			tab: "model",
			label: "Provider Stream Retries",
			description:
				"Maximum provider stream replay retries for replay-safe transient stream failures. Counts retries, not the first attempt. Set to 0 to disable provider stream retries.",
		},
	},
	"retry.fallbackChains": { type: "record", default: {} as Record<string, string[]> },
	"retry.fallbackRevertPolicy": {
		type: "enum",
		values: ["cooldown-expiry", "never"] as const,
		default: "cooldown-expiry",
		ui: {
			tab: "model",
			label: "Fallback Revert Policy",
			description: "When to return to the primary model after a fallback",
			options: [
				{
					value: "cooldown-expiry",
					label: "Cooldown expiry",
					description: "Return to the primary model after its suppression window ends",
				},
				{ value: "never", label: "Never", description: "Stay on the fallback model until manually changed" },
			],
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Interaction
	// ────────────────────────────────────────────────────────────────────────

	"mouse.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			label: "Mouse Support",
			description: "Enable SGR mouse wheel scrolling and overlay row selection. Disabled in tmux and screen.",
		},
	},
	// Conversation flow
	steeringMode: {
		type: "enum",
		values: ["all", "one-at-a-time"] as const,
		default: "one-at-a-time",
		ui: {
			tab: "interaction",
			label: "Steering Mode",
			description: "How to process queued messages while agent is working",
		},
	},

	followUpMode: {
		type: "enum",
		values: ["all", "one-at-a-time"] as const,
		default: "one-at-a-time",
		ui: {
			tab: "interaction",
			label: "Follow-Up Mode",
			description: "How to drain follow-up messages after a turn completes",
		},
	},

	interruptMode: {
		type: "enum",
		values: ["immediate", "wait"] as const,
		default: "immediate",
		ui: {
			tab: "interaction",
			label: "Interrupt Mode",
			description: "When steering messages interrupt tool execution",
		},
	},

	busyPromptMode: {
		type: "enum",
		values: ["steer", "queue"] as const,
		default: "steer",
		ui: {
			tab: "interaction",
			label: "Busy Prompt Mode",
			description:
				"What a submitted prompt does while the agent is busy: queue normal chat for the next turn, or steer to interrupt the active turn",
		},
	},

	// Input and startup
	doubleEscapeAction: {
		type: "enum",
		values: ["branch", "tree", "none"] as const,
		default: "tree",
		ui: {
			tab: "interaction",
			label: "Double-Escape Action",
			description: "Action when pressing Escape twice with empty editor",
		},
	},

	treeFilterMode: {
		type: "enum",
		values: ["default", "no-tools", "user-only", "labeled-only", "all"] as const,
		default: "default",
		ui: {
			tab: "interaction",
			label: "Session Tree Filter",
			description: "Default filter mode when opening the session tree",
		},
	},

	autocompleteMaxVisible: {
		type: "number",
		default: 5,
		ui: {
			tab: "interaction",
			label: "Autocomplete Items",
			description: "Max visible items in autocomplete dropdown (3-20)",
			options: [
				{ value: "3", label: "3 items" },
				{ value: "5", label: "5 items" },
				{ value: "7", label: "7 items" },
				{ value: "10", label: "10 items" },
				{ value: "15", label: "15 items" },
				{ value: "20", label: "20 items" },
			],
		},
	},

	emojiAutocomplete: {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			label: "Emoji Autocomplete",
			description: "Suggest emojis from `:name:` shortcodes and expand text emoticons like `:D` or `:-)`",
		},
	},

	"startup.quiet": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			label: "Quiet Startup",
			description: "Skip welcome screen and startup status messages",
		},
	},

	"startup.welcomeBannerMode": {
		type: "enum",
		values: ["auto", "unicode", "square", "ascii"] as const,
		default: "auto",
		ui: {
			tab: "interaction",
			label: "Welcome Banner Mode",
			description: "Logo style for the startup welcome screen",
			options: [
				{ value: "auto", label: "Auto", description: "Use the rounded Unicode logo" },
				{ value: "unicode", label: "Unicode", description: "Force the rounded Unicode logo" },
				{ value: "square", label: "Square Unicode", description: "Force the square-corner Unicode fallback" },
				{ value: "ascii", label: "ASCII", description: "Force the ASCII-safe logo" },
			],
		},
	},

	"startup.checkUpdate": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			label: "Check for Updates",
			description:
				"At interactive startup, notify of newer versions; never install. Use `gjc update` only for recognized Bun global, Windows npm, or bundled-installer binaries; source, linked, and unrecognized installs use their original method.",
		},
	},

	"starReminder.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			label: "GitHub Star Reminder",
			description: "Show the interactive GitHub star reminder when gh is authenticated",
		},
	},

	collapseChangelog: {
		type: "boolean",
		default: false,
		ui: { tab: "interaction", label: "Collapse Changelog", description: "Show condensed changelog after updates" },
	},

	// Notifications
	"completion.notify": {
		type: "enum",
		values: ["on", "off"] as const,
		default: "on",
		ui: { tab: "interaction", label: "Completion Notification", description: "Notify when the agent completes" },
	},
	"completion.notifyCommand": {
		type: "string",
		default: "",
		ui: {
			tab: "interaction",
			label: "Completion Notification Command",
			description:
				"Optional user-level shell command to run when an agent turn completes; receives GJC_NOTIFICATION_* environment variables. On Windows, this can call PowerShell [Console]::Beep when terminal BEL is silent.",
		},
	},

	"ask.timeout": {
		type: "number",
		default: 0,
		ui: {
			tab: "interaction",
			label: "Ask Timeout",
			description: "Auto-select recommended option after timeout (0 to disable)",
			options: [
				{ value: "0", label: "Disabled" },
				{ value: "15", label: "15 seconds" },
				{ value: "30", label: "30 seconds" },
				{ value: "60", label: "60 seconds" },
				{ value: "120", label: "120 seconds" },
			],
		},
	},

	"ask.notify": {
		type: "enum",
		values: ["on", "off"] as const,
		default: "on",
		ui: { tab: "interaction", label: "Ask Notification", description: "Notify when ask tool is waiting for input" },
	},

	// Speech-to-text
	"stt.enabled": {
		type: "boolean",
		default: false,
		ui: { tab: "interaction", label: "Speech-to-Text", description: "Enable speech-to-text input via microphone" },
	},

	"stt.language": {
		type: "string",
		default: "en",
	},

	"stt.modelName": {
		type: "enum",
		values: ["tiny", "tiny.en", "base", "base.en", "small", "small.en", "medium", "medium.en", "large"] as const,
		default: "base.en",
		ui: {
			tab: "interaction",
			label: "Speech Model",
			description: "Whisper model size (larger = more accurate but slower)",
			options: [
				{ value: "tiny", label: "tiny", description: "Multilingual; fastest, lowest accuracy" },
				{ value: "tiny.en", label: "tiny.en", description: "English-only; fastest" },
				{ value: "base", label: "base", description: "Multilingual; small and fast" },
				{ value: "base.en", label: "base.en", description: "English-only; default" },
				{ value: "small", label: "small", description: "Multilingual; balanced" },
				{ value: "small.en", label: "small.en", description: "English-only; balanced" },
				{ value: "medium", label: "medium", description: "Multilingual; accurate but slower" },
				{ value: "medium.en", label: "medium.en", description: "English-only; accurate but slower" },
				{ value: "large", label: "large", description: "Multilingual; most accurate" },
			],
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Context
	// ────────────────────────────────────────────────────────────────────────

	// Context promotion
	"contextPromotion.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			label: "Auto-Promote Context",
			description:
				"Promote to a larger-context model on context overflow instead of compacting (off by default; opt in to enable)",
		},
	},

	// Compaction
	"compaction.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			label: "Auto-Compact",
			description: "Automatically compact context when it gets too large",
		},
	},

	"compaction.strategy": {
		type: "enum",
		values: ["context-full", "handoff", "off"] as const,
		default: "context-full",
		ui: {
			tab: "context",
			label: "Compaction Strategy",
			description: "Choose in-place context-full maintenance, auto-handoff, or disable auto maintenance (off)",
			options: [
				{
					value: "context-full",
					label: "Context-full",
					description: "Summarize in-place and keep the current session",
				},
				{ value: "handoff", label: "Handoff", description: "Generate handoff and continue in a new session" },
				{
					value: "off",
					label: "Off",
					description: "Disable automatic context maintenance (same behavior as Auto-compact off)",
				},
			],
		},
	},

	"compaction.thresholdPercent": {
		type: "number",
		default: -1,
		ui: {
			tab: "context",
			label: "Compaction Threshold",
			description: "Percent threshold for context maintenance; set to Default to use legacy reserve-based behavior",
			options: [
				{ value: "default", label: "Default", description: "Legacy reserve-based threshold" },
				{ value: "10", label: "10%", description: "Extremely early maintenance" },
				{ value: "20", label: "20%", description: "Very early maintenance" },
				{ value: "30", label: "30%", description: "Early maintenance" },
				{ value: "40", label: "40%", description: "Moderately early maintenance" },
				{ value: "50", label: "50%", description: "Halfway point" },
				{ value: "60", label: "60%", description: "Moderate context usage" },
				{ value: "70", label: "70%", description: "Balanced" },
				{ value: "75", label: "75%", description: "Slightly aggressive" },
				{ value: "80", label: "80%", description: "Typical threshold" },
				{ value: "85", label: "85%", description: "Aggressive context usage" },
				{ value: "90", label: "90%", description: "Very aggressive" },
				{ value: "95", label: "95%", description: "Near context limit" },
			],
		},
	},
	"compaction.thresholdTokens": {
		type: "number",
		default: -1,
		ui: {
			tab: "context",
			label: "Compaction Token Limit",
			description: "Fixed token limit for context maintenance; overrides percentage if set",
			options: [
				{ value: "default", label: "Default", description: "Use percentage-based threshold" },
				{ value: "25000", label: "25K tokens", description: "Quarter of a 200K window" },
				{ value: "50000", label: "50K tokens", description: "Half of a 200K window" },
				{ value: "100000", label: "100K tokens", description: "Half of a 200K window" },
				{ value: "150000", label: "150K tokens", description: "Three-quarters of a 200K window" },
				{ value: "200000", label: "200K tokens", description: "Full standard context window" },
				{ value: "300000", label: "300K tokens", description: "Large context window" },
				{ value: "500000", label: "500K tokens", description: "Very large context window" },
			],
		},
	},

	"compaction.handoffSaveToDisk": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			label: "Save Handoff Docs",
			description: "Save generated handoff documents to markdown files for the auto-handoff flow",
		},
	},

	"compaction.remoteEnabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			label: "Remote Compaction",
			description: "Use remote compaction endpoints when available instead of local summarization",
		},
	},

	"compaction.reserveTokens": { type: "number", default: 16384 },

	"compaction.keepRecentTokens": { type: "number", default: 20000 },

	"compaction.autoContinue": { type: "boolean", default: true },

	"compaction.remoteEndpoint": { type: "string", default: undefined },

	// Below-threshold maintenance pruning (Finding 13). Internal/measurement-only:
	// keep the runtime setting for targeted experiments, but do not expose it in
	// settings UI. Live layofflabs/gpt-5.5 medium evidence on 2026-07-07 showed no
	// savings and a cache-hit regression; pruning rewrites already-sent history and
	// can force a provider cache-epoch reset.
	"compaction.maintenancePruningEnabled": { type: "boolean", default: false },

	"compaction.maintenancePruningMinSavingsTokens": { type: "number", default: 8000 },

	// Idle compaction
	"compaction.idleEnabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			label: "Idle Compaction",
			description: "Compact context while idle when token count exceeds threshold",
		},
	},

	"compaction.idleThresholdTokens": {
		type: "number",
		default: 200000,
		ui: {
			tab: "context",
			label: "Idle Compaction Threshold",
			description: "Token count above which idle compaction triggers",
			options: [
				{ value: "100000", label: "100K tokens" },
				{ value: "200000", label: "200K tokens" },
				{ value: "300000", label: "300K tokens" },
				{ value: "400000", label: "400K tokens" },
				{ value: "500000", label: "500K tokens" },
				{ value: "600000", label: "600K tokens" },
				{ value: "700000", label: "700K tokens" },
				{ value: "800000", label: "800K tokens" },
				{ value: "900000", label: "900K tokens" },
			],
		},
	},

	"compaction.idleTimeoutSeconds": {
		type: "number",
		default: 300,
		ui: {
			tab: "context",
			label: "Idle Compaction Delay",
			description: "Seconds to wait while idle before compacting",
			options: [
				{ value: "60", label: "1 minute" },
				{ value: "120", label: "2 minutes" },
				{ value: "300", label: "5 minutes" },
				{ value: "600", label: "10 minutes" },
				{ value: "1800", label: "30 minutes" },
				{ value: "3600", label: "1 hour" },
			],
		},
	},
	// Branch summaries
	"branchSummary.enabled": {
		type: "boolean",
		default: false,
		ui: { tab: "context", label: "Branch Summaries", description: "Prompt to summarize when leaving a branch" },
	},

	"branchSummary.reserveTokens": { type: "number", default: 16384 },

	// Memories
	// Legacy local-memory enable flag kept only for back-compat migration.
	// Hidden from UI — users should use `memory.backend` instead.
	"memories.enabled": {
		type: "boolean",
		default: false,
	},

	"memories.maxRolloutsPerStartup": { type: "number", default: 64 },

	"memories.maxRolloutAgeDays": { type: "number", default: 30 },

	"memories.minRolloutIdleHours": { type: "number", default: 12 },

	"memories.threadScanLimit": { type: "number", default: 300 },

	"memories.maxRawMemoriesForGlobal": { type: "number", default: 200 },

	"memories.stage1Concurrency": { type: "number", default: 8 },

	"memories.stage1LeaseSeconds": { type: "number", default: 120 },

	"memories.stage1RetryDelaySeconds": { type: "number", default: 120 },

	"memories.phase2LeaseSeconds": { type: "number", default: 180 },

	"memories.phase2RetryDelaySeconds": { type: "number", default: 180 },

	"memories.phase2HeartbeatSeconds": { type: "number", default: 30 },

	"memories.rolloutPayloadPercent": { type: "number", default: 0.7 },

	"memories.phase1InputTokenLimit": { type: "number", default: 4000 },

	"memories.fallbackTokenLimit": { type: "number", default: 16000 },

	"memories.summaryInjectionTokenLimit": { type: "number", default: 5000 },

	// Memory backend selector — picks between local memories pipeline,
	// Hindsight remote memory, or off. Legacy `memories.enabled` keeps gating
	// the local backend; see config/settings.ts migration for details.
	"memory.backend": {
		type: "enum",
		values: ["off", "local", "hindsight"] as const,
		default: "off",
		ui: {
			tab: "memory",
			label: "Memory Backend",
			description: "Off, local memory pipeline, or Hindsight remote memory",
			options: [
				{ value: "off", label: "Off", description: "No memory subsystem runs" },
				{ value: "local", label: "Local", description: "Local rollout summarisation pipeline (memory_summary.md)" },
				{ value: "hindsight", label: "Hindsight", description: "Vectorize Hindsight remote memory service" },
			],
		},
	},

	// Hindsight (https://hindsight.vectorize.io)
	"hindsight.apiUrl": {
		type: "string",
		default: "http://localhost:8888",
		ui: {
			tab: "memory",
			label: "Hindsight API URL",
			description: "Hindsight server URL (Cloud or self-hosted)",
			condition: "hindsightActive",
		},
	},

	"hindsight.apiToken": { type: "string", default: undefined },

	"hindsight.bankId": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			label: "Hindsight Bank ID",
			description: "Memory bank identifier (default: project name)",
			condition: "hindsightActive",
		},
	},

	"hindsight.bankIdPrefix": { type: "string", default: undefined },
	"hindsight.scoping": {
		type: "enum",
		values: ["global", "per-project", "per-project-tagged"] as const,
		default: "per-project-tagged",
		ui: {
			tab: "memory",
			label: "Hindsight Scoping",
			description:
				"global = one shared bank; per-project = isolated bank per cwd; per-project-tagged = shared bank with project tags so global + project memories merge on recall",
			options: [
				{
					value: "global",
					label: "Global",
					description: "One shared bank — every project sees the same memories",
				},
				{
					value: "per-project",
					label: "Per project",
					description: "Isolated bank per cwd basename — projects cannot see each other's memories",
				},
				{
					value: "per-project-tagged",
					label: "Per project (tagged)",
					description:
						"Shared bank, retains tagged with project:<cwd>. Recall surfaces project + untagged global memories together",
				},
			],
			condition: "hindsightActive",
		},
	},
	"hindsight.bankMission": { type: "string", default: undefined },
	"hindsight.retainMission": { type: "string", default: undefined },

	"hindsight.autoRecall": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			label: "Hindsight Auto Recall",
			description: "Recall memories on the first turn of each session",
			condition: "hindsightActive",
		},
	},
	"hindsight.autoRetain": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			label: "Hindsight Auto Retain",
			description: "Retain transcript every N turns and at session boundaries",
			condition: "hindsightActive",
		},
	},

	"hindsight.retainMode": {
		type: "enum",
		values: ["full-session", "last-turn"] as const,
		default: "full-session",
		ui: {
			tab: "memory",
			label: "Hindsight Retain Mode",
			description: "full-session = upsert one document per session, last-turn = chunked",
			options: [
				{
					value: "full-session",
					label: "Full session",
					description: "Upsert one document per session (recommended)",
				},
				{ value: "last-turn", label: "Last turn", description: "Chunked retention sliced by turn boundaries" },
			],
			condition: "hindsightActive",
		},
	},
	"hindsight.retainEveryNTurns": { type: "number", default: 3 },
	"hindsight.retainOverlapTurns": { type: "number", default: 2 },
	"hindsight.retainContext": { type: "string", default: "gjc" },

	"hindsight.recallBudget": {
		type: "enum",
		values: ["low", "mid", "high"] as const,
		default: "mid",
	},
	"hindsight.recallMaxTokens": { type: "number", default: 1024 },
	"hindsight.recallContextTurns": { type: "number", default: 1 },
	"hindsight.recallMaxQueryChars": { type: "number", default: 800 },
	"hindsight.recallTypes": { type: "array", default: HINDSIGHT_RECALL_TYPES_DEFAULT },

	"hindsight.debug": { type: "boolean", default: false },

	"hindsight.mentalModelsEnabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			label: "Hindsight Mental Models",
			description:
				"Read curated reflect summaries (mental models) into developer instructions at boot. Loads existing models on the bank — does not write. Pair with hindsight.mentalModelAutoSeed to also auto-create the built-in seed set.",
			condition: "hindsightActive",
		},
	},
	"hindsight.mentalModelAutoSeed": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			label: "Hindsight Mental Model Auto-Seed",
			description:
				"At session start, create any built-in mental models (project-conventions, project-decisions, user-preferences) that do not yet exist on the bank.",
			condition: "hindsightActive",
		},
	},
	"hindsight.mentalModelRefreshIntervalMs": { type: "number", default: 5 * 60 * 1000 },
	"hindsight.mentalModelMaxRenderChars": { type: "number", default: 16_000 },

	// TTSR
	"ttsr.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			label: "TTSR",
			description: "Time Traveling Stream Rules: interrupt agent when output matches patterns",
		},
	},

	"ttsr.contextMode": {
		type: "enum",
		values: ["discard", "keep"] as const,
		default: "discard",
		ui: {
			tab: "context",
			label: "TTSR Context Mode",
			description:
				"What to do with partial output when TTSR triggers. 'discard' (recommended) drops the aborted partial turn so it never accumulates in context. 'keep' retains every aborted partial turn, which grows the token footprint each time a rule fires — prefer 'discard' unless you specifically need the partial output.",
		},
	},

	"ttsr.interruptMode": {
		type: "enum",
		values: ["never", "prose-only", "tool-only", "always"] as const,
		default: "always",
		ui: {
			tab: "context",
			label: "TTSR Interrupt Mode",
			description: "When to interrupt mid-stream vs inject warning after completion",
			options: [
				{ value: "always", label: "always", description: "Interrupt on prose and tool streams" },
				{ value: "prose-only", label: "prose-only", description: "Interrupt only on reply/thinking matches" },
				{ value: "tool-only", label: "tool-only", description: "Interrupt only on tool-call argument matches" },
				{ value: "never", label: "never", description: "Never interrupt; inject warning after completion" },
			],
		},
	},

	"ttsr.repeatMode": {
		type: "enum",
		values: ["once", "after-gap"] as const,
		default: "once",
		ui: {
			tab: "context",
			label: "TTSR Repeat Mode",
			description: "How rules can repeat: once per session or after a message gap",
		},
	},

	"ttsr.repeatGap": {
		type: "number",
		default: 10,
		ui: {
			tab: "context",
			label: "TTSR Repeat Gap",
			description: "Messages before a rule can trigger again",
			options: [
				{ value: "5", label: "5 messages" },
				{ value: "10", label: "10 messages" },
				{ value: "15", label: "15 messages" },
				{ value: "20", label: "20 messages" },
				{ value: "30", label: "30 messages" },
			],
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Editing
	// ────────────────────────────────────────────────────────────────────────

	// Edit tool
	"edit.mode": {
		type: "enum",
		values: EDIT_MODES,
		default: "hashline",
		ui: {
			tab: "editing",
			label: "Edit Mode",
			description: "Select the edit tool variant (replace, patch, hashline, vim, or apply_patch)",
		},
	},

	"edit.fuzzyMatch": {
		type: "boolean",
		default: true,
		ui: {
			tab: "editing",
			label: "Fuzzy Match",
			description: "Accept high-confidence fuzzy matches for whitespace differences",
		},
	},

	"edit.fuzzyThreshold": {
		type: "number",
		default: 0.95,
		ui: {
			tab: "editing",
			label: "Fuzzy Match Threshold",
			description: "Similarity threshold for fuzzy matches",
			options: [
				{ value: "0.85", label: "0.85", description: "Lenient" },
				{ value: "0.90", label: "0.90", description: "Moderate" },
				{ value: "0.95", label: "0.95", description: "Default" },
				{ value: "0.98", label: "0.98", description: "Strict" },
			],
		},
	},

	"edit.streamingAbort": {
		type: "boolean",
		default: false,
		ui: {
			tab: "editing",
			label: "Abort on Failed Preview",
			description: "Abort streaming edit tool calls when patch preview fails",
		},
	},

	"edit.hashlineAutoDropPureInsertDuplicates": {
		type: "boolean",
		default: false,
		ui: {
			tab: "editing",
			label: "Hashline Duplicate Insert Drop",
			description: "Drop 2+ pure-insert payload lines that duplicate adjacent file context",
		},
	},
	"edit.blockAutoGenerated": {
		type: "boolean",
		default: true,
		ui: {
			tab: "editing",
			label: "Block Auto-Generated Files",
			description: "Prevent editing of files that appear to be auto-generated (protoc, sqlc, swagger, etc.)",
		},
	},

	readLineNumbers: {
		type: "boolean",
		default: false,
		ui: {
			tab: "editing",
			label: "Line Numbers",
			description: "Prepend line numbers to read tool output by default",
		},
	},

	readHashLines: {
		type: "boolean",
		default: true,
		ui: {
			tab: "editing",
			label: "Hash Lines",
			description: "Include line hashes in read output for hashline edit mode (LINE+ID|content)",
		},
	},

	"read.defaultLimit": {
		type: "number",
		default: 300,
		ui: {
			tab: "editing",
			label: "Default Read Limit",
			description: "Default number of lines returned when agent calls read without a limit",
			options: [
				{ value: "200", label: "200 lines" },
				{ value: "300", label: "300 lines" },
				{ value: "500", label: "500 lines" },
				{ value: "1000", label: "1000 lines" },
				{ value: "5000", label: "5000 lines" },
			],
		},
	},

	"read.summarize.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "editing",
			label: "Read Summaries",
			description: "Return structural code summaries when read is called without an explicit selector",
		},
	},

	"read.summarize.prose": {
		type: "boolean",
		default: false,
		ui: {
			tab: "editing",
			label: "Prose Summaries",
			description: "Return structural summaries for Markdown and plain text reads",
		},
	},

	"read.summarize.minBodyLines": {
		type: "number",
		default: 4,
		ui: {
			tab: "editing",
			label: "Read Summary Body Lines",
			description: "Minimum multiline body or literal length before read summaries collapse it",
		},
	},

	"read.summarize.minCommentLines": {
		type: "number",
		default: 6,
		ui: {
			tab: "editing",
			label: "Read Summary Comment Lines",
			description: "Minimum multiline block comment length before read summaries collapse it",
		},
	},

	"read.toolResultPreview": {
		type: "boolean",
		default: false,
		ui: {
			tab: "editing",
			label: "Inline Read Previews",
			description: "Render read tool results inline in the transcript instead of summary rows",
		},
	},

	// LSP
	"lsp.enabled": {
		type: "boolean",
		default: true,
		ui: { tab: "editing", label: "LSP", description: "Enable the lsp tool for language server protocol" },
	},

	"lsp.formatOnWrite": {
		type: "boolean",
		default: false,
		ui: {
			tab: "editing",
			label: "Format on Write",
			description: "Automatically format code files using LSP after writing",
		},
	},

	"lsp.diagnosticsOnWrite": {
		type: "boolean",
		default: true,
		ui: {
			tab: "editing",
			label: "Diagnostics on Write",
			description: "Return LSP diagnostics after writing code files",
		},
	},

	"lsp.diagnosticsOnEdit": {
		type: "boolean",
		default: false,
		ui: {
			tab: "editing",
			label: "Diagnostics on Edit",
			description: "Return LSP diagnostics after editing code files",
		},
	},

	// Bash interceptor
	"bashInterceptor.enabled": {
		type: "boolean",
		default: false,
		ui: { tab: "editing", label: "Bash Interceptor", description: "Block shell commands that have dedicated tools" },
	},
	"bashInterceptor.patterns": { type: "array", default: DEFAULT_BASH_INTERCEPTOR_RULES },

	"bash.stripTrailingHeadTail": {
		type: "boolean",
		default: true,
		ui: {
			tab: "editing",
			label: "Strip Trailing head/tail",
			description:
				"Silently drop trailing `| head`/`| tail` pipes from single-line bash commands. Output is already truncated automatically.",
		},
	},

	// Shell output minimizer
	"shellMinimizer.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "editing",
			label: "Shell Minimizer",
			description: "Compress verbose shell output (git, npm, cargo, etc.) before returning it to the agent",
		},
	},
	"shellMinimizer.settingsPath": {
		type: "string",
		default: undefined,
	},
	"shellMinimizer.only": { type: "array", default: EMPTY_STRING_ARRAY },
	"shellMinimizer.except": { type: "array", default: EMPTY_STRING_ARRAY },
	"shellMinimizer.maxCaptureBytes": {
		type: "number",
		default: 4 * 1024 * 1024,
	},

	// Eval (per-backend toggles; add more as new backends ship, e.g. eval.ts)
	"eval.py": {
		type: "boolean",
		default: true,
		ui: {
			tab: "editing",
			label: "Eval: Python backend",
			description: "Allow the eval tool to dispatch to the IPython kernel",
		},
	},

	"eval.js": {
		type: "boolean",
		default: true,
		ui: {
			tab: "editing",
			label: "Eval: JavaScript backend",
			description: "Allow the eval tool to dispatch to the in-process JavaScript runtime",
		},
	},

	// Python kernel knobs (consumed by the eval py backend and the /python slash command)
	"python.kernelMode": {
		type: "enum",
		values: ["session", "per-call"] as const,
		default: "session",
		ui: {
			tab: "editing",
			label: "Python Kernel Mode",
			description: "Whether to keep IPython kernel alive across calls",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Tools
	// ────────────────────────────────────────────────────────────────────────

	// Todo tool
	"todo.enabled": {
		type: "boolean",
		default: true,
		ui: { tab: "tools", label: "Todos", description: "Enable the todo_write tool for task tracking" },
	},

	"todo.reminders": {
		type: "boolean",
		default: true,
		ui: { tab: "tools", label: "Todo Reminders", description: "Remind agent to complete todos before stopping" },
	},

	"todo.reminders.max": {
		type: "number",
		default: 3,
		ui: {
			tab: "tools",
			label: "Todo Reminder Limit",
			description: "Maximum reminders to complete todos before giving up",
			options: [
				{ value: "1", label: "1 reminder" },
				{ value: "2", label: "2 reminders" },
				{ value: "3", label: "3 reminders" },
				{ value: "5", label: "5 reminders" },
			],
		},
	},

	"todo.eager": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			label: "Create Todos Automatically",
			description: "Automatically create a comprehensive todo list after the first message",
		},
	},

	// Search and AST tools
	"find.enabled": {
		type: "boolean",
		default: true,
		ui: { tab: "tools", label: "Find", description: "Enable the find tool for file searching" },
	},

	"search.enabled": {
		type: "boolean",
		default: true,
		ui: { tab: "tools", label: "Search", description: "Enable the search tool for content searching" },
	},

	"search.contextBefore": {
		type: "number",
		default: 1,
		ui: {
			tab: "tools",
			label: "Search Context Before",
			description: "Lines of context before each search match",
			options: [
				{ value: "0", label: "0 lines" },
				{ value: "1", label: "1 line" },
				{ value: "2", label: "2 lines" },
				{ value: "3", label: "3 lines" },
				{ value: "5", label: "5 lines" },
			],
		},
	},

	"search.contextAfter": {
		type: "number",
		default: 3,
		ui: {
			tab: "tools",
			label: "Search Context After",
			description: "Lines of context after each search match",
			options: [
				{ value: "0", label: "0 lines" },
				{ value: "1", label: "1 line" },
				{ value: "2", label: "2 lines" },
				{ value: "3", label: "3 lines" },
				{ value: "5", label: "5 lines" },
				{ value: "10", label: "10 lines" },
			],
		},
	},

	"astGrep.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			label: "AST Grep",
			description: "Enable the ast_grep tool for structural AST search",
		},
	},

	"astEdit.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			label: "AST Edit",
			description: "Enable the ast_edit tool for structural AST rewrites",
		},
	},

	"irc.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			label: "IRC",
			description: "Enable agent-to-agent IRC messaging via the irc tool",
		},
	},

	"irc.sidebar.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			label: "IRC Sidebar",
			description: "Enable the IRC message sidebar (opens with the toggle key; starts closed)",
		},
	},

	// Optional tools

	"renderMermaid.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			label: "Render Mermaid",
			description: "Enable the render_mermaid tool for Mermaid-to-ASCII rendering",
		},
	},

	"debug.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			label: "Debug",
			description: "Enable the debug tool for DAP-based debugging",
		},
	},

	"calc.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			label: "Calculator",
			description: "Enable the calculator tool for basic calculations",
		},
	},

	"recipe.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			label: "Recipe",
			description:
				"Enable the recipe tool when a justfile / package.json / Cargo.toml / Makefile / Taskfile is present",
		},
	},

	"checkpoint.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			label: "Checkpoint/Rewind",
			description: "Enable the checkpoint and rewind tools for context checkpointing",
		},
	},

	"skill.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			label: "Skill",
			description: "Enable the skill tool so the agent can chain into another available skill on its next turn",
		},
	},

	// Fetching and browser
	"fetch.enabled": {
		type: "boolean",
		default: true,
		ui: { tab: "tools", label: "Read URLs", description: "Allow the read tool to fetch and process URLs" },
	},

	"web.insaneFallback": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			label: "Insane Search Fallback",
			description:
				"Opt in to the vendored insane-search escalation for blocked public URL reads (403/WAF/JS-gated). Off by default. Requires preinstalled python3 + curl_cffi (and node + playwright/stealth for the browser phase); changes network posture by enabling TLS/browser impersonation for public pages.",
		},
	},

	"github.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			label: "GitHub CLI",
			description:
				"Enable the github tool (op-based dispatch for repository, issue, pull request, diff, search, checkout, push, and Actions watch workflows)",
		},
	},

	"github.cache.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			label: "GitHub view cache",
			description: "Cache rendered issue/PR view output in ~/.gjc/cache/github-cache.db so repeated reads are free",
		},
	},

	"github.cache.softTtlSec": {
		type: "number",
		default: 300,
		ui: {
			tab: "tools",
			label: "GitHub cache soft TTL (seconds)",
			description: "Within this window, cached issue/PR view rows are returned directly. Default 5 minutes.",
		},
	},

	"github.cache.hardTtlSec": {
		type: "number",
		default: 604800,
		ui: {
			tab: "tools",
			label: "GitHub cache hard TTL (seconds)",
			description:
				"Past soft TTL but within hard TTL, the tool returns the cached row and refreshes it in the background. Past hard TTL, the row is dropped. Default 7 days.",
		},
	},

	"web_search.enabled": {
		type: "boolean",
		default: true,
		ui: { tab: "tools", label: "Web Search", description: "Enable the web_search tool for web searching" },
	},

	"web_search.provider": {
		type: "enum",
		values: ["auto", ...CONFIGURABLE_SEARCH_PROVIDER_IDS] as const,
		default: "auto",
	},
	"web_search.fallback": {
		type: "array",
		default: EMPTY_STRING_ARRAY,
		items: { enum: CONFIGURABLE_SEARCH_PROVIDER_IDS },
		ui: {
			tab: "tools",
			label: "Web Search Fallback",
			description: "Ordered fallback web search providers after the active model native provider",
		},
	},

	"web_search.timeout": {
		type: "number",
		default: 300,
		validate: (value: number) => Number.isFinite(value) && value > 0,
		ui: {
			tab: "tools",
			label: "Web Search Timeout",
			description: "Hard timeout in seconds for a single web search request (default 300)",
		},
	},

	"browser.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			label: "Browser",
			description: "Enable the browser tool (Ulixee Hero)",
		},
	},

	"browser.headless": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			label: "Headless Browser",
			description: "Launch browser in headless mode (disable to show browser UI)",
		},
	},
	"browser.screenshotDir": {
		type: "string",
		default: undefined,
		ui: {
			tab: "tools",
			label: "Screenshot directory",
			description:
				"Directory to save screenshots. If unset, screenshots go to a temp file. Supports ~. Examples: ~/Downloads, ~/Desktop, /sdcard/Download (Android)",
		},
	},

	"browser.profileReuse": {
		type: "string",
		default: "auto",
		validate: (value: string) => value === "auto" || value === "opt-in",
		ui: {
			tab: "tools",
			label: "Profile reuse posture",
			description:
				"'auto' (default): when a usable real Chrome profile is available, the browser tool uses an isolated copy of it (cookies/session/cache) for stronger stealth, warns, and falls back to synthetic. 'opt-in': stay synthetic unless a real profile is explicitly requested.",
		},
	},

	"browser.geo.timezone": {
		type: "string",
		default: undefined,
		ui: {
			tab: "tools",
			label: "Geo timezone override",
			description:
				"Optional IANA timezone (e.g. 'America/New_York') for headless sessions. Default unset preserves the real timezone. Only set this to a value coherent with your egress (e.g. a proxy region); an incoherent timezone increases bot detection.",
		},
	},
	"browser.geo.locale": {
		type: "string",
		default: undefined,
		ui: {
			tab: "tools",
			label: "Geo locale override",
			description:
				"Optional UI locale (e.g. 'en-US') for headless sessions. Default unset preserves the real locale. Only set this coherently with your egress region.",
		},
	},

	"browser.gc.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			label: "Browser Tab GC",
			description: "Automatically reclaim idle, unheld GJC-managed headless/spawned browser tabs.",
		},
	},
	"browser.gc.idleMs": {
		type: "number",
		default: 300_000,
		validate: (value: number) => Number.isFinite(value) && value >= 0,
		ui: {
			tab: "tools",
			label: "Browser Tab GC Idle (ms)",
			description: "Evict headless/spawned tabs idle longer than this many milliseconds.",
		},
	},
	"browser.gc.rssLimitMb": {
		type: "number",
		default: 1536,
		validate: (value: number) => Number.isFinite(value) && value > 0,
		ui: {
			tab: "tools",
			label: "Browser Tab GC RSS Limit (MB)",
			description: "Parent-process RSS (MB) above which idle tabs are opportunistically evicted LRU.",
		},
	},
	"resourceGc.sweepIntervalMs": {
		type: "number",
		default: 30_000,
		validate: (value: number) => Number.isFinite(value) && value > 0,
		ui: {
			tab: "tools",
			label: "Resource GC Sweep Interval (ms)",
			description: "How often the resource GC sweeps browser tabs and stale screenshot directories.",
		},
	},

	"computer.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			label: "Computer",
			description: "Enable the macOS computer tool for this session. Off by default.",
		},
	},

	"computer.alwaysOn": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			label: "Computer Always On",
			description: "Keep the macOS computer tool callable without per-session enablement.",
		},
	},

	"computer.autoScreenshot": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			label: "Computer Auto Screenshot",
			description: "Automatically request bounded screenshots after computer actions when supported.",
		},
	},

	"computer.screenshotMaxBytes": {
		type: "number",
		default: 5_000_000,
		ui: {
			tab: "tools",
			label: "Computer Screenshot Max Bytes",
			description: "Maximum screenshot payload size for computer action results.",
		},
	},

	"computer.killSwitchHotkey": {
		type: "string",
		default: "Control+Option+Command+Escape",
		ui: {
			tab: "tools",
			label: "Computer Kill Switch Hotkey",
			description: "Native stop/suspend hotkey shown to users for computer-use sessions.",
		},
	},

	"computer.auditLog.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			label: "Computer Audit Log",
			description: "Persist audit records for enabled computer-use actions.",
		},
	},
	"computer.screenshotGc.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			label: "Computer Screenshot GC",
			description: "Delete stale computer-use screenshot fallback directories on disk.",
		},
	},
	"computer.screenshotGc.staleMs": {
		type: "number",
		default: 43_200_000,
		validate: (value: number) => Number.isFinite(value) && value >= 0,
		ui: {
			tab: "tools",
			label: "Computer Screenshot GC Stale Age (ms)",
			description: "Remove screenshot fallback directories whose mtime is older than this many milliseconds.",
		},
	},
	"computer.screenshotGc.scanIntervalMs": {
		type: "number",
		default: 1_800_000,
		validate: (value: number) => Number.isFinite(value) && value > 0,
		ui: {
			tab: "tools",
			label: "Computer Screenshot GC Scan Interval (ms)",
			description: "Minimum interval between os.tmpdir scans for stale screenshot directories.",
		},
	},

	// Tool execution
	"tools.intentTracing": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			label: "Intent Tracing",
			description: "Ask the agent to describe the intent of each tool call before executing it",
		},
	},

	"tools.maxTimeout": {
		type: "number",
		default: 0,
		ui: {
			tab: "tools",
			label: "Max Tool Timeout",
			description: "Maximum timeout in seconds the agent can set for any tool (0 = no limit)",
			options: [
				{ value: "0", label: "No limit" },
				{ value: "30", label: "30 seconds" },
				{ value: "60", label: "60 seconds" },
				{ value: "120", label: "120 seconds" },
				{ value: "300", label: "5 minutes" },
				{ value: "600", label: "10 minutes" },
			],
		},
	},

	// Async jobs
	"async.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			label: "Async Execution",
			description: "Enable async bash commands and background task execution",
		},
	},

	"async.maxJobs": {
		type: "number",
		default: 100,
	},

	"async.pollWaitDuration": {
		type: "enum",
		values: ["5s", "10s", "30s", "1m", "5m"] as const,
		default: "30s",
		ui: {
			tab: "tools",
			label: "Poll Wait Duration",
			description: "How long the poll tool waits for background job updates before returning the current state",
			options: [
				{ value: "5s", label: "5 seconds" },
				{ value: "10s", label: "10 seconds" },
				{ value: "30s", label: "30 seconds", description: "Default" },
				{ value: "1m", label: "1 minute" },
				{ value: "5m", label: "5 minutes" },
			],
		},
	},

	"bash.autoBackground.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			label: "Bash Auto-Background",
			description: "Automatically background long-running bash commands and deliver the result later",
		},
	},

	"bash.autoBackground.thresholdMs": {
		type: "number",
		default: 60_000,
	},

	// Tool Discovery
	"tools.discoveryMode": {
		type: "enum",
		values: ["off", "all"] as const,
		default: "all",
		ui: {
			tab: "tools",
			label: "Tool Discovery",
			description: "Hide non-essential built-in tools behind a search tool to save tokens.",
		},
	},

	"tools.essentialOverride": {
		type: "array",
		default: [] as string[],
		ui: {
			tab: "tools",
			label: "Essential Tools Override",
			description:
				"Override the always-loaded built-in tools (default: read, bash, edit, write, search, find). Leave empty to use defaults.",
		},
	},

	// MCP
	"mcp.enableProjectConfig": {
		type: "boolean",
		default: false,
	},

	"mcp.discoveryMode": {
		type: "boolean",
		default: false,
	},

	"mcp.discoveryDefaultServers": {
		type: "array",
		default: [] as string[],
	},

	"mcp.notifications": {
		type: "boolean",
		default: false,
	},

	"mcp.notificationDebounceMs": {
		type: "number",
		default: 500,
	},

	// ────────────────────────────────────────────────────────────────────────
	// Tasks
	// ────────────────────────────────────────────────────────────────────────

	"tasksPane.defaultVisible": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			label: "Tasks Pane Visible By Default",
			description: "Open the unified tasks pane when the interactive UI starts",
		},
	},
	// Plan mode
	"plan.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			label: "Plan Mode",
			description: "Enable plan mode for read-only exploration and planning before execution",
		},
	},

	"goal.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			label: "Goal Mode",
			description: "Enable per-session goal mode and the hidden goal tool",
		},
	},

	"goal.statusInFooter": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			label: "Goal Status In Footer",
			description: "Show goal usage alongside the goal indicator in the status line",
		},
	},

	"goal.continuationModes": {
		type: "array",
		default: ["interactive"],
		ui: {
			tab: "tasks",
			label: "Goal Continuation Modes",
			description: "Run modes where active goals may auto-continue between turns",
		},
	},

	// Delegation
	"task.isolation.mode": {
		type: "enum",
		values: [
			"none",
			"auto",
			"apfs",
			"btrfs",
			"zfs",
			"reflink",
			"overlayfs",
			"projfs",
			"block-clone",
			"rcopy",
		] as const,
		default: "none",
		ui: {
			tab: "tasks",
			label: "Isolation Mode",
			description:
				'Isolation backend for subagents. "auto" lets the native PAL pick the best available backend (CoW-aware filesystems, then overlayfs/ProjFS, then a git worktree / recursive-copy fallback).',
			options: [
				{ value: "none", label: "None", description: "No isolation" },
				{ value: "auto", label: "Auto", description: "Let the PAL pick the best available backend" },
				{ value: "apfs", label: "APFS", description: "macOS clonefile reflink (APFS)" },
				{ value: "btrfs", label: "btrfs", description: "btrfs subvolume snapshot" },
				{ value: "zfs", label: "ZFS", description: "ZFS snapshot + clone" },
				{ value: "reflink", label: "Reflink", description: "Linux FICLONE per-file reflink" },
				{
					value: "overlayfs",
					label: "Overlayfs",
					description: "Linux kernel overlay (or fuse-overlayfs fallback)",
				},
				{ value: "projfs", label: "ProjFS", description: "Windows Projected File System" },
				{
					value: "block-clone",
					label: "Block clone",
					description: "Windows FSCTL_DUPLICATE_EXTENTS_TO_FILE (NTFS/ReFS)",
				},
				{
					value: "rcopy",
					label: "Recursive copy",
					description: "git worktree if available, otherwise recursive copy",
				},
			],
		},
	},

	"task.isolation.merge": {
		type: "enum",
		values: ["patch", "branch"] as const,
		default: "patch",
		ui: {
			tab: "tasks",
			label: "Isolation Merge Strategy",
			description: "How isolated task changes are integrated (patch apply or branch merge)",
			options: [
				{ value: "patch", label: "Patch", description: "Combine diffs and git apply" },
				{ value: "branch", label: "Branch", description: "Commit per task, merge with --no-ff" },
			],
		},
	},

	"task.isolation.commits": {
		type: "enum",
		values: ["generic", "ai"] as const,
		default: "generic",
		ui: {
			tab: "tasks",
			label: "Isolation Commit Style",
			description: "Commit message style for nested repo changes (generic or AI-generated)",
			options: [
				{ value: "generic", label: "Generic", description: "Static commit message" },
				{ value: "ai", label: "AI", description: "AI-generated commit message from diff" },
			],
		},
	},

	"task.eager": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			label: "Prefer Task Delegation",
			description: "Encourage the agent to delegate work to subagents unless changes are trivial",
		},
	},

	"task.simple": {
		type: "enum",
		values: TASK_SIMPLE_MODES,
		default: "default",
		ui: {
			tab: "tasks",
			label: "Task Input Mode",
			description: "How much shared structure the task tool accepts (default, schema-free, or independent)",
			options: [
				{
					value: "default",
					label: "Default",
					description: "Shared context and custom task schema are available",
				},
				{
					value: "schema-free",
					label: "Schema-free",
					description: "Shared context stays available, but custom task schema is disabled",
				},
				{
					value: "independent",
					label: "Independent",
					description: "No shared context or custom task schema; each task must stand alone",
				},
			],
		},
	},

	"task.maxConcurrency": {
		type: "number",
		default: 8,
		ui: {
			tab: "tasks",
			label: "Max Concurrent Tasks",
			description:
				"Safer concurrent limit for subagents; higher fan-out still requires an explicit plan above 4 tasks.",
			options: [
				{ value: "0", label: "Unlimited" },
				{ value: "1", label: "1 task" },
				{ value: "2", label: "2 tasks" },
				{ value: "4", label: "4 tasks" },
				{ value: "8", label: "8 tasks" },
				{ value: "16", label: "16 tasks" },
				{ value: "32", label: "32 tasks" },
				{ value: "64", label: "64 tasks" },
			],
		},
	},

	"task.enableLsp": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			label: "LSP in Subagents",
			description:
				"Allow subagents spawned via the task tool to use the lsp tool. Off by default to keep subagents cheap; enable when LSP-aware delegation is worth the extra tokens.",
		},
	},

	"task.forkContext.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			label: "Fork Context for Subagents",
			description:
				"Allow explicitly opted-in subagents to start from a sanitized snapshot of parent context when both the agent and task item also opt in.",
		},
	},

	"task.forkContext.maxMessages": {
		type: "number",
		default: 50,
		ui: {
			tab: "tasks",
			label: "Fork Context Max Messages",
			description: "Maximum parent messages copied into an explicitly opted-in subagent fork-context seed.",
		},
	},

	"task.forkContext.maxTokens": {
		type: "number",
		default: 0,
		ui: {
			tab: "tasks",
			label: "Fork Context Max Tokens",
			description:
				"Approximate token cap for explicit full fork-context seeds. 0 uses 15% of the target model context window, with a 15k fallback when the window is unknown.",
		},
	},

	"task.maxRecursionDepth": {
		type: "number",
		default: 2,
		ui: {
			tab: "tasks",
			label: "Max Task Recursion",
			description: "How many levels deep subagents can spawn their own subagents",
			options: [
				{ value: "-1", label: "Unlimited" },
				{ value: "0", label: "None" },
				{ value: "1", label: "Single" },
				{ value: "2", label: "Double" },
				{ value: "3", label: "Triple" },
			],
		},
	},

	"task.maxRuntimeMs": {
		type: "number",
		default: 0,
		ui: {
			tab: "tasks",
			label: "Max Subagent Runtime",
			description:
				"Hard wall-clock limit per subagent (ms). 0 disables it. Defense-in-depth against provider-side stream hangs that escape the inference-layer watchdog; triggers a normal subagent abort with a 'timed out' reason.",
			options: [
				{ value: "0", label: "Unlimited", description: "Default" },
				{ value: "300000", label: "5 minutes" },
				{ value: "900000", label: "15 minutes" },
				{ value: "1800000", label: "30 minutes" },
				{ value: "3600000", label: "1 hour" },
			],
		},
	},

	"task.disabledAgents": {
		type: "array",
		default: [] as string[],
	},

	"task.agentModelOverrides": {
		type: "record",
		default: {} as Record<string, ModelSelectorValue>,
		valueSchema: MODEL_SELECTOR_VALUE_SCHEMA,
	},

	"tasks.todoClearDelay": {
		type: "number",
		default: 60,
		ui: {
			tab: "tasks",
			label: "Todo auto-clear delay",
			description: "How long to wait before removing completed/abandoned tasks from the list",
			options: [
				{ value: "0", label: "Instant" },
				{ value: "60", label: "1 minute", description: "Default" },
				{ value: "300", label: "5 minutes" },
				{ value: "900", label: "15 minutes" },
				{ value: "1800", label: "30 minutes" },
				{ value: "3600", label: "1 hour" },
				{ value: "-1", label: "Never" },
			],
		},
	},

	// Skills
	"skills.enabled": { type: "boolean", default: DEFAULT_SKILL_DISCOVERY_SETTINGS.enabled },

	"skills.enableSkillCommands": {
		type: "boolean",
		default: DEFAULT_SKILL_DISCOVERY_SETTINGS.enableSkillCommands,
	},

	"skills.enableCodexUser": { type: "boolean", default: DEFAULT_SKILL_DISCOVERY_SETTINGS.enableCodexUser },

	"skills.enableClaudeUser": { type: "boolean", default: DEFAULT_SKILL_DISCOVERY_SETTINGS.enableClaudeUser },

	"skills.enableClaudeProject": { type: "boolean", default: DEFAULT_SKILL_DISCOVERY_SETTINGS.enableClaudeProject },

	"skills.enablePiUser": { type: "boolean", default: DEFAULT_SKILL_DISCOVERY_SETTINGS.enablePiUser },

	"skills.enablePiProject": { type: "boolean", default: DEFAULT_SKILL_DISCOVERY_SETTINGS.enablePiProject },

	"skills.customDirectories": { type: "array", default: DEFAULT_SKILL_DISCOVERY_SETTINGS.customDirectories },

	"skills.ignoredSkills": { type: "array", default: DEFAULT_SKILL_DISCOVERY_SETTINGS.ignoredSkills },

	"skills.includeSkills": { type: "array", default: DEFAULT_SKILL_DISCOVERY_SETTINGS.includeSkills },

	// Commands
	"commands.enableClaudeUser": {
		type: "boolean",
		default: false,
	},

	"commands.enableClaudeProject": {
		type: "boolean",
		default: false,
	},

	"commands.enableOpencodeUser": {
		type: "boolean",
		default: false,
	},

	"commands.enableOpencodeProject": {
		type: "boolean",
		default: false,
	},

	// ────────────────────────────────────────────────────────────────────────
	// Providers
	// ────────────────────────────────────────────────────────────────────────

	// Secret handling
	"secrets.enabled": {
		type: "boolean",
		default: false,
		ui: { tab: "providers", label: "Hide Secrets", description: "Obfuscate secrets before sending to AI providers" },
	},

	// Provider selection
	"providers.webSearch": {
		type: "enum",
		values: [
			"auto",
			"duckduckgo",
			"insane",
			"exa",
			"brave",
			"jina",
			"kimi",
			"zai",
			"perplexity",
			"anthropic",
			"gemini",
			"codex",
			"xai",
			"tavily",
			"kagi",
			"synthetic",
			"parallel",
			"searxng",
		] as const,
		default: "auto",
		ui: {
			tab: "providers",
			label: "Web Search Provider",
			description: "Provider for web search tool",
			options: [
				{
					value: "auto",
					label: "Auto",
					description: "Active model's native search if its creds exist, else keyless DuckDuckGo",
				},
				{
					value: "duckduckgo",
					label: "DuckDuckGo",
					description: "Keyless default — no API key or OAuth required",
				},
				{
					value: "insane",
					label: "Insane",
					description: "Keyless safe public-route fallback inspired by upstream insane-search",
				},
				{ value: "exa", label: "Exa", description: "Uses Exa API when EXA_API_KEY is set" },
				{ value: "brave", label: "Brave", description: "Requires BRAVE_API_KEY" },
				{ value: "jina", label: "Jina", description: "Requires JINA_API_KEY" },
				{ value: "kimi", label: "Kimi", description: "Requires MOONSHOT_SEARCH_API_KEY or MOONSHOT_API_KEY" },
				{
					value: "perplexity",
					label: "Perplexity",
					description: "Requires PERPLEXITY_COOKIES or PERPLEXITY_API_KEY",
				},
				{
					value: "anthropic",
					label: "Anthropic",
					description: "Claude's native web_search tool (uses Anthropic OAuth or ANTHROPIC_API_KEY)",
				},
				{
					value: "codex",
					label: "OpenAI",
					description: "OpenAI's native web_search (uses ChatGPT OAuth via /login openai-codex)",
				},
				{
					value: "xai",
					label: "xAI",
					description: "xAI Responses web_search/x_search (uses xAI OAuth via /login xai or XAI_API_KEY)",
				},
				{
					value: "gemini",
					label: "Gemini",
					description: "Google Search grounding via Gemini (uses google-gemini-cli or google-antigravity OAuth)",
				},
				{ value: "zai", label: "Z.AI", description: "Calls Z.AI webSearchPrime MCP" },
				{ value: "tavily", label: "Tavily", description: "Requires TAVILY_API_KEY" },
				{ value: "kagi", label: "Kagi", description: "Requires KAGI_API_KEY and Kagi Search API beta access" },
				{ value: "synthetic", label: "Synthetic", description: "Requires SYNTHETIC_API_KEY" },
				{ value: "parallel", label: "Parallel", description: "Requires PARALLEL_API_KEY" },
				{ value: "searxng", label: "SearXNG", description: "Requires SEARXNG_ENDPOINT or searxng.endpoint" },
			],
		},
	},
	"providers.image": {
		type: "enum",
		values: ["auto", "openai", "gemini", "openrouter", "antigravity"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			label: "Image Provider",
			description: "Provider for image generation tool",
			options: [
				{
					value: "auto",
					label: "Auto",
					description: "Priority: GPT model image tool > Antigravity > OpenRouter > Gemini",
				},
				{ value: "openai", label: "OpenAI", description: "Uses the active GPT Responses/Codex model" },
				{ value: "gemini", label: "Gemini", description: "Requires GEMINI_API_KEY" },
				{ value: "openrouter", label: "OpenRouter", description: "Requires OPENROUTER_API_KEY" },
				{ value: "antigravity", label: "Antigravity", description: "Requires login with google-antigravity" },
			],
		},
	},

	"providers.kimiApiFormat": {
		type: "enum",
		values: ["openai", "anthropic"] as const,
		default: "anthropic",
		ui: {
			tab: "providers",
			label: "Kimi API Format",
			description: "API format for Kimi Code provider",
			options: [
				{ value: "openai", label: "OpenAI", description: "api.kimi.com" },
				{ value: "anthropic", label: "Anthropic", description: "api.moonshot.ai" },
			],
		},
	},

	"providers.openaiWebsockets": {
		type: "enum",
		values: ["auto", "off", "on"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			label: "OpenAI WebSockets",
			description: "Websocket policy for OpenAI Codex models (auto uses model defaults, on forces, off disables)",
			options: [
				{ value: "auto", label: "Auto", description: "Use model/provider default websocket behavior" },
				{ value: "off", label: "Off", description: "Disable websockets for OpenAI Codex models" },
				{ value: "on", label: "On", description: "Force websockets for OpenAI Codex models" },
			],
		},
	},

	"providers.parallelFetch": {
		type: "boolean",
		default: true,
		ui: {
			tab: "providers",
			label: "Parallel Fetch",
			description: "Use Parallel extract API for URL fetching when credentials are available",
		},
	},
	"provider.appendOnlyContext": {
		type: "enum",
		values: ["auto", "on", "off"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			label: "Append-Only Context",
			description:
				"Cache system prompt + tool specs and keep an append-only message log so provider prefix caches (DeepSeek, Anthropic) hit at maximum rate. Auto enables for DeepSeek.",
			options: [
				{ value: "auto", label: "Auto", description: "Enable for DeepSeek (recommended)" },
				{ value: "on", label: "On", description: "Always enable append-only context" },
				{ value: "off", label: "Off", description: "Disable append-only context" },
			],
		},
	},

	// Exa
	"exa.enabled": {
		type: "boolean",
		default: true,
		ui: { tab: "providers", label: "Exa", description: "Master toggle for all Exa search tools" },
	},

	"exa.enableSearch": {
		type: "boolean",
		default: true,
		ui: { tab: "providers", label: "Exa Search", description: "Basic search, deep search, code search, crawl" },
	},

	"exa.enableResearcher": {
		type: "boolean",
		default: false,
		ui: { tab: "providers", label: "Exa Researcher", description: "AI-powered deep research tasks" },
	},

	"exa.enableWebsets": {
		type: "boolean",
		default: false,
		ui: { tab: "providers", label: "Exa Websets", description: "Webset management and enrichment tools" },
	},

	// SearXNG
	"searxng.endpoint": {
		type: "string",
		default: undefined,
		ui: {
			tab: "providers",
			label: "SearXNG Endpoint",
			description: "Self-hosted search base URL",
		},
	},

	"searxng.token": {
		type: "string",
		default: undefined,
	},

	"searxng.basicUsername": {
		type: "string",
		default: undefined,
	},

	"searxng.basicPassword": {
		type: "string",
		default: undefined,
	},

	"searxng.categories": {
		type: "string",
		default: undefined,
	},

	"searxng.language": {
		type: "string",
		default: undefined,
	},

	"commit.mapReduceEnabled": { type: "boolean", default: true },

	"commit.mapReduceMinFiles": { type: "number", default: 4 },

	"commit.mapReduceMaxFileTokens": { type: "number", default: 50000 },

	"commit.mapReduceTimeoutMs": { type: "number", default: 120000 },

	"commit.mapReduceMaxConcurrency": { type: "number", default: 5 },

	"commit.changelogMaxDiffChars": { type: "number", default: 120000 },

	"thinkingBudgets.minimal": { type: "number", default: 1024 },

	"thinkingBudgets.low": { type: "number", default: 2048 },

	"thinkingBudgets.medium": { type: "number", default: 8192 },

	"thinkingBudgets.high": { type: "number", default: 16384 },

	"thinkingBudgets.xhigh": { type: "number", default: 32768 },

	"thinkingBudgets.max": { type: "number", default: 65536 },
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Type Inference
// ═══════════════════════════════════════════════════════════════════════════

type Schema = typeof SETTINGS_SCHEMA;

/** All valid setting paths */
export type SettingPath = keyof Schema;

/** Infer the value type for a setting path */
export type SettingValue<P extends SettingPath> = Schema[P] extends { type: "boolean" }
	? boolean
	: Schema[P] extends { type: "string" }
		? string | undefined
		: Schema[P] extends { type: "number" }
			? number
			: Schema[P] extends { type: "enum"; values: infer V }
				? V extends readonly string[]
					? V[number]
					: never
				: Schema[P] extends { type: "array"; default: infer D }
					? D
					: Schema[P] extends { type: "record"; default: infer D }
						? D
						: never;

/** Get the default value for a setting path */
export function getDefault<P extends SettingPath>(path: P): SettingValue<P> {
	return SETTINGS_SCHEMA[path].default as SettingValue<P>;
}

/** Check if a path has UI metadata (should appear in settings panel) */
export function hasUi(path: SettingPath): boolean {
	return "ui" in SETTINGS_SCHEMA[path];
}

/** Get UI metadata for a path (undefined if no UI) */
export function getUi(path: SettingPath): AnyUiMetadata | undefined {
	const def = SETTINGS_SCHEMA[path];
	return "ui" in def ? (def.ui as AnyUiMetadata) : undefined;
}

/** Get all paths for a specific tab */
export function getPathsForTab(tab: SettingTab): SettingPath[] {
	return (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).filter(path => {
		const ui = getUi(path);
		return ui?.tab === tab;
	});
}

/** Get the type of a setting */
export function getType(path: SettingPath): SettingDef["type"] {
	return SETTINGS_SCHEMA[path].type;
}

/** Get enum values for an enum setting */
export function getEnumValues(path: SettingPath): readonly string[] | undefined {
	const def = SETTINGS_SCHEMA[path];
	return "values" in def ? (def.values as readonly string[]) : undefined;
}

export const CONFIG_SCHEMA_VERSION = 1;

export type SettingsSchemaIssue = {
	path: string;
	kind: "unknown" | "invalid" | "coerced" | "pending-migration";
	detail: string;
};

export type SettingsSchemaReport = { issues: SettingsSchemaIssue[]; valid: boolean };

function schemaValueAtPath(value: Record<string, unknown>, path: string): unknown {
	let current: unknown = value;
	for (const segment of path.split(".")) {
		if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function schemaSetAtPath(value: Record<string, unknown>, path: string, next: unknown): void {
	const segments = path.split(".");
	let current = value;
	for (const segment of segments.slice(0, -1)) {
		const child = current[segment];
		if (!child || typeof child !== "object" || Array.isArray(child)) current[segment] = {};
		current = current[segment] as Record<string, unknown>;
	}
	current[segments.at(-1)!] = next;
}

function schemaPaths(value: Record<string, unknown>, prefix = ""): string[] {
	const paths: string[] = [];
	for (const [key, child] of Object.entries(value)) {
		const path = prefix ? `${prefix}.${key}` : key;
		const definition = SETTINGS_SCHEMA[path as SettingPath];
		// Records intentionally accept user-defined keys; validate their entries below.
		if (definition?.type === "record") {
			paths.push(path);
		} else if (child && typeof child === "object" && !Array.isArray(child)) {
			paths.push(...schemaPaths(child as Record<string, unknown>, path));
		} else {
			paths.push(path);
		}
	}
	return paths;
}

function validSettingValue(definition: (typeof SETTINGS_SCHEMA)[SettingPath], value: unknown): boolean {
	return (
		(definition.type === "boolean" && typeof value === "boolean") ||
		(definition.type === "string" && typeof value === "string") ||
		(definition.type === "number" &&
			typeof value === "number" &&
			Number.isFinite(value) &&
			(!("validate" in definition) || !definition.validate || definition.validate(value))) ||
		(definition.type === "enum" &&
			typeof value === "string" &&
			(definition.values as readonly string[]).includes(value)) ||
		(definition.type === "array" && Array.isArray(value)) ||
		(definition.type === "record" && !!value && typeof value === "object" && !Array.isArray(value))
	);
}

/** Coerce supported scalar legacy values and report unknown or invalid settings without dropping them. */
export function reconcileSettingsSchema(raw: Record<string, unknown>): {
	settings: Record<string, unknown>;
	report: SettingsSchemaReport;
} {
	const settings = structuredClone(raw);
	const issues: SettingsSchemaIssue[] = [];
	const knownPaths = new Set(Object.keys(SETTINGS_SCHEMA));
	for (const path of schemaPaths(settings)) {
		if (path === "configSchemaVersion" || knownPaths.has(path)) continue;
		if (![...knownPaths].some(known => known.startsWith(`${path}.`))) {
			issues.push({ path, kind: "unknown", detail: "Setting is not recognized by this version." });
		}
	}
	for (const path of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		const value = schemaValueAtPath(settings, path);
		if (value === undefined) continue;
		const definition = SETTINGS_SCHEMA[path];
		let next = value;
		if (definition.type === "boolean" && (value === "true" || value === "false")) next = value === "true";
		if (
			definition.type === "number" &&
			typeof value === "string" &&
			value.trim() !== "" &&
			Number.isFinite(Number(value))
		) {
			next = Number(value);
		}
		if (next !== value) {
			schemaSetAtPath(settings, path, next);
			issues.push({ path, kind: "coerced", detail: `Coerced ${typeof value} to ${definition.type}.` });
		}
		if (!validSettingValue(definition, next))
			issues.push({ path, kind: "invalid", detail: `Expected ${definition.type}.` });
		if (
			definition.type === "record" &&
			"valueSchema" in definition &&
			definition.valueSchema &&
			validSettingValue(definition, next)
		) {
			for (const [key, entry] of Object.entries(next as Record<string, unknown>)) {
				if (
					definition.valueSchema.type === "model-selector-value" &&
					!(typeof entry === "string" || (Array.isArray(entry) && entry.every(item => typeof item === "string")))
				) {
					issues.push({ path: `${path}.${key}`, kind: "invalid", detail: "Expected model-selector-value." });
				}
			}
		}
	}
	return { settings, report: { issues, valid: !issues.some(issue => issue.kind === "invalid") } };
}

// ═══════════════════════════════════════════════════════════════════════════
// Derived Types from Schema
// ═══════════════════════════════════════════════════════════════════════════

/** Status line preset - derived from schema */
export type StatusLinePreset = SettingValue<"statusLine.preset">;

/** Status line separator style - derived from schema */
export type StatusLineSeparatorStyle = SettingValue<"statusLine.separator">;

/** Tree selector filter mode - derived from schema */
export type TreeFilterMode = SettingValue<"treeFilterMode">;

// ═══════════════════════════════════════════════════════════════════════════
// Typed Group Definitions
// ═══════════════════════════════════════════════════════════════════════════

export interface CompactionSettings {
	enabled: boolean;
	strategy: "context-full" | "handoff" | "off";
	thresholdPercent: number;
	thresholdTokens: number;
	reserveTokens: number;
	keepRecentTokens: number;
	handoffSaveToDisk: boolean;
	autoContinue: boolean;
	remoteEnabled: boolean;
	remoteEndpoint: string | undefined;
	maintenancePruningEnabled: boolean;
	maintenancePruningMinSavingsTokens: number;
	idleEnabled: boolean;
	idleThresholdTokens: number;
	idleTimeoutSeconds: number;
}

export interface ContextPromotionSettings {
	enabled: boolean;
}
export interface RetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
	requestMaxRetries: number;
	streamMaxRetries: number;
}

export interface MemoriesSettings {
	enabled: boolean;
	maxRolloutsPerStartup: number;
	maxRolloutAgeDays: number;
	minRolloutIdleHours: number;
	threadScanLimit: number;
	maxRawMemoriesForGlobal: number;
	stage1Concurrency: number;
	stage1LeaseSeconds: number;
	stage1RetryDelaySeconds: number;
	phase2LeaseSeconds: number;
	phase2RetryDelaySeconds: number;
	phase2HeartbeatSeconds: number;
	rolloutPayloadPercent: number;
	fallbackTokenLimit: number;
	summaryInjectionTokenLimit: number;
}

export interface TodoCompletionSettings {
	enabled: boolean;
	maxReminders: number;
}

export interface BranchSummarySettings {
	enabled: boolean;
	reserveTokens: number;
}

export interface SkillsSettings extends SkillDiscoverySettings {
	disabledExtensions?: string[];
}

export interface CommitSettings {
	mapReduceEnabled: boolean;
	mapReduceMinFiles: number;
	mapReduceMaxFileTokens: number;
	mapReduceTimeoutMs: number;
	mapReduceMaxConcurrency: number;
	changelogMaxDiffChars: number;
}

export interface TtsrSettings {
	enabled: boolean;
	contextMode: "discard" | "keep";
	interruptMode: "never" | "prose-only" | "tool-only" | "always";
	repeatMode: "once" | "after-gap";
	repeatGap: number;
}

export interface ExaSettings {
	enabled: boolean;
	enableSearch: boolean;
	enableResearcher: boolean;
	enableWebsets: boolean;
}

export interface StatusLineSettings {
	preset: StatusLinePreset;
	separator: StatusLineSeparatorStyle;
	maxRows: number;
	showHookStatus: boolean;
	showSkillHud: boolean;
	leftSegments: StatusLineSegmentId[];
	rightSegments: StatusLineSegmentId[];
	segmentOptions: Record<string, unknown>;
}

export interface ThinkingBudgetsSettings {
	minimal: number;
	low: number;
	medium: number;
	high: number;
	xhigh: number;
	max: number;
}

export interface SttSettings {
	enabled: boolean;
	language: string | undefined;
	modelName: string;
	whisperPath: string | undefined;
	modelPath: string | undefined;
}

export interface BashInterceptorRule {
	pattern: string;
	flags?: string;
	tool: string;
	message: string;
	allowSubcommands?: string[];
}

export interface ShellMinimizerSettings {
	enabled: boolean;
	settingsPath: string | undefined;
	only: string[];
	except: string[];
	maxCaptureBytes: number;
}

export interface NotificationsSettings {
	enabled: boolean;
	telegram: {
		botToken: string | undefined;
		chatId: string | undefined;
		btw: {
			enabled: boolean;
		};
		rich: {
			enabled: boolean;
		};
		richDraft: {
			enabled: boolean;
		};
		topics: {
			nameTemplate: string | undefined;
		};
	};
	discord: {
		botToken: string | undefined;
		applicationId: string | undefined;
		guildId: string | undefined;
		parentChannelId: string | undefined;
	};
	slack: {
		botToken: string | undefined;
		appToken: string | undefined;
		workspaceId: string | undefined;
		channelId: string | undefined;
	};
	redact: boolean;
	verbosity: "lean" | "verbose";
	sessionScope: "all" | "primary";
	daemon: {
		idleTimeoutMs: number;
	};
}

/** Map group prefix -> typed settings interface */
export interface GroupTypeMap {
	compaction: CompactionSettings;
	contextPromotion: ContextPromotionSettings;
	retry: RetrySettings;
	memories: MemoriesSettings;
	branchSummary: BranchSummarySettings;
	skills: SkillsSettings;
	commit: CommitSettings;
	ttsr: TtsrSettings;
	exa: ExaSettings;
	statusLine: StatusLineSettings;
	thinkingBudgets: ThinkingBudgetsSettings;
	stt: SttSettings;
	modelRoles: Record<string, ModelSelectorValue>;
	modelTags: ModelTagsSettings;
	cycleOrder: string[];
	shellMinimizer: ShellMinimizerSettings;
	notifications: NotificationsSettings;
}

export type GroupPrefix = keyof GroupTypeMap;

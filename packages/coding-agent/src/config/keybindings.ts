import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
	type Keybinding,
	type KeybindingDefinitions,
	type KeybindingsConfig,
	type KeyId,
	setKeybindings,
	TUI_KEYBINDINGS,
	KeybindingsManager as TuiKeybindingsManager,
} from "@gajae-code/tui";
import { getAgentDir, isEnoent, logger } from "@gajae-code/utils";

/**
 * Application-level keybindings (coding agent specific).
 * Values are always `true` — used for declaration merging.
 */
interface AppKeybindings {
	"app.interrupt": true;
	"app.clear": true;
	"app.exit": true;
	"app.suspend": true;
	"app.thinking.cycle": true;
	"app.thinking.toggle": true;
	"app.commandPalette.open": true;
	"app.model.cycleForward": true;
	"app.model.cycleBackward": true;
	"app.model.select": true;
	"app.model.selectTemporary": true;
	"app.tools.expand": true;
	"app.tool.backgroundFold": true;
	"app.editor.external": true;
	"app.message.followUp": true;
	"app.message.queue": true;
	"app.message.dequeue": true;
	"app.clipboard.pasteImage": true;
	"app.clipboard.copyLine": true;
	"app.clipboard.copyPrompt": true;
	"app.session.new": true;
	"app.session.tree": true;
	"app.session.fork": true;
	"app.session.resume": true;
	"app.session.observe": true;
	"app.session.dashboard": true;
	"app.jobs.open": true;
	"app.session.togglePath": true;
	"app.session.toggleSort": true;
	"app.session.rename": true;
	"app.session.delete": true;
	"app.session.deleteNoninvasive": true;
	"app.tree.foldOrUp": true;
	"app.tree.unfoldOrDown": true;
	"app.plan.toggle": true;
	"app.history.search": true;
	"app.stt.toggle": true;
	"app.irc.sidebar.toggle": true;
	"app.transcript.browse": true;
	"app.transcript.prevTurn": true;
	"app.transcript.nextTurn": true;
	"app.mode.cycle": true;
	"app.tasks.toggle": true;
	"app.queue.togglePane": true;
	"app.message.sendNow": true;
}

export type AppKeybinding = keyof AppKeybindings;

declare module "@gajae-code/tui" {
	interface Keybindings extends AppKeybindings {}
}

export function defaultMessageQueueKeysForPlatform(platform: NodeJS.Platform = process.platform): KeyId {
	return platform === "win32" || platform === "darwin" ? "alt+q" : "alt+enter";
}

export function defaultClipboardPasteImageKeysForPlatform(platform: NodeJS.Platform = process.platform): KeyId {
	return platform === "win32" ? "alt+v" : "ctrl+v";
}

/**
 * All keybindings definitions: TUI + app-specific.
 */
export const KEYBINDINGS = {
	...TUI_KEYBINDINGS,
	"app.interrupt": {
		defaultKeys: "escape",
		description: "Interrupt current operation",
	},
	"app.clear": {
		defaultKeys: "ctrl+c",
		description: "Clear screen or cancel",
	},
	"app.exit": {
		defaultKeys: "ctrl+d",
		description: "Exit application",
	},
	"app.suspend": {
		defaultKeys: "ctrl+z",
		description: "Suspend application",
	},
	"app.thinking.cycle": {
		defaultKeys: "shift+tab",
		description: "Cycle thinking level",
	},
	"app.thinking.toggle": {
		defaultKeys: "ctrl+t",
		description: "Toggle thinking mode",
	},
	"app.commandPalette.open": {
		defaultKeys: "ctrl+p",
		description: "Open command palette",
	},
	"app.model.cycleForward": {
		defaultKeys: "alt+n",
		description: "Cycle to next model",
	},
	"app.model.cycleBackward": {
		defaultKeys: "alt+shift+n",
		description: "Cycle to previous model",
	},
	"app.model.select": {
		defaultKeys: "ctrl+l",
		description: "Select model",
	},
	"app.model.selectTemporary": {
		defaultKeys: "alt+p",
		description: "Select temporary model for current session",
	},
	"app.tools.expand": {
		defaultKeys: "ctrl+o",
		description: "Expand tools",
	},
	"app.tool.backgroundFold": {
		defaultKeys: "ctrl+b",
		description: "Fold/background supported foreground tool",
	},
	"app.editor.external": {
		defaultKeys: "ctrl+g",
		description: "Open external editor",
	},
	"app.message.followUp": {
		defaultKeys: [],
		description: "Send follow-up message (no default; Ctrl+Enter submits)",
	},
	"app.message.queue": {
		defaultKeys: defaultMessageQueueKeysForPlatform(),
		description: "Queue message for next turn",
	},
	"app.message.dequeue": {
		defaultKeys: ["alt+up", "alt+down"],
		description: "Select queued message to edit",
	},
	"app.clipboard.pasteImage": {
		defaultKeys: defaultClipboardPasteImageKeysForPlatform(),
		description: "Paste image from clipboard",
	},
	"app.clipboard.copyLine": {
		defaultKeys: "alt+shift+l",
		description: "Copy current line",
	},
	"app.clipboard.copyPrompt": {
		defaultKeys: "alt+shift+c",
		description: "Copy prompt",
	},
	"app.session.new": {
		defaultKeys: "ctrl+n",
		description: "Start a new session",
	},
	"app.session.tree": {
		defaultKeys: [],
		description: "Show session tree",
	},
	"app.session.fork": {
		defaultKeys: [],
		description: "Fork session",
	},
	"app.session.resume": {
		defaultKeys: [],
		description: "Resume session",
	},
	"app.session.observe": {
		defaultKeys: "ctrl+s",
		description: "Observe subagent sessions",
	},
	"app.session.dashboard": {
		defaultKeys: [],
		description: "Show all persisted sessions dashboard",
	},

	"app.jobs.open": {
		defaultKeys: "alt+j",
		description: "Open monitor/cron jobs overlay",
	},
	"app.session.togglePath": {
		defaultKeys: "ctrl+p",
		description: "Toggle session path display",
	},
	"app.session.toggleSort": {
		defaultKeys: "ctrl+s",
		description: "Toggle session sort order",
	},
	"app.session.rename": {
		defaultKeys: "ctrl+r",
		description: "Rename session",
	},
	"app.session.delete": {
		defaultKeys: "ctrl+d",
		description: "Delete current session transcript/artifacts",
	},
	"app.session.deleteNoninvasive": {
		defaultKeys: "ctrl+backspace",
		description: "Delete selected session transcript/artifacts (non-invasive)",
	},
	"app.tree.foldOrUp": {
		defaultKeys: ["ctrl+left", "alt+left"],
		description: "Fold or move up",
	},
	"app.tree.unfoldOrDown": {
		defaultKeys: ["ctrl+right", "alt+right"],
		description: "Unfold or move down",
	},
	"app.plan.toggle": {
		defaultKeys: "alt+shift+p",
		description: "Toggle plan mode",
	},
	"app.history.search": {
		defaultKeys: "ctrl+r",
		description: "Search history",
	},
	"app.stt.toggle": {
		defaultKeys: "alt+h",
		description: "Toggle speech-to-text",
	},
	"app.irc.sidebar.toggle": {
		defaultKeys: "alt+i",
		description: "Toggle IRC sidebar",
	},
	"app.transcript.browse": {
		defaultKeys: [],
		description: "Browse the transcript",
	},
	"app.transcript.prevTurn": {
		defaultKeys: [],
		description: "Jump to previous user turn",
	},
	"app.transcript.nextTurn": {
		defaultKeys: [],
		description: "Jump to next user turn",
	},
	"app.mode.cycle": {
		defaultKeys: [],
		description: "Cycle interaction mode",
	},
	"app.tasks.toggle": {
		defaultKeys: "alt+t",
		description: "Toggle tasks pane",
	},
	"app.queue.togglePane": {
		defaultKeys: [],
		description: "Toggle message queue pane",
	},
	"app.message.sendNow": {
		defaultKeys: [],
		description: "Send message immediately",
	},
} as const satisfies KeybindingDefinitions;

/**
 * Migration map from old keybinding names to new namespaced IDs.
 */
const KEYBINDING_NAME_MIGRATIONS = {
	// App-specific (old names)
	interrupt: "app.interrupt",
	clear: "app.clear",
	exit: "app.exit",
	suspend: "app.suspend",
	cycleThinkingLevel: "app.thinking.cycle",
	cycleModelForward: "app.model.cycleForward",
	cycleModelBackward: "app.model.cycleBackward",
	selectModel: "app.model.select",
	selectModelTemporary: "app.model.selectTemporary",
	togglePlanMode: "app.plan.toggle",
	historySearch: "app.history.search",
	expandTools: "app.tools.expand",
	toggleThinking: "app.thinking.toggle",
	externalEditor: "app.editor.external",
	followUp: "app.message.followUp",
	queue: "app.message.queue",
	dequeue: "app.message.dequeue",
	pasteImage: "app.clipboard.pasteImage",
	copyLine: "app.clipboard.copyLine",
	copyPrompt: "app.clipboard.copyPrompt",
	newSession: "app.session.new",
	tree: "app.session.tree",
	fork: "app.session.fork",
	resume: "app.session.resume",
	observeSessions: "app.session.observe",
	toggleSTT: "app.stt.toggle",
	// TUI editor (old names for backward compatibility)
	cursorUp: "tui.editor.cursorUp",
	cursorDown: "tui.editor.cursorDown",
	cursorLeft: "tui.editor.cursorLeft",
	cursorRight: "tui.editor.cursorRight",
	cursorWordLeft: "tui.editor.cursorWordLeft",
	cursorWordRight: "tui.editor.cursorWordRight",
	cursorLineStart: "tui.editor.cursorLineStart",
	cursorLineEnd: "tui.editor.cursorLineEnd",
	jumpForward: "tui.editor.jumpForward",
	jumpBackward: "tui.editor.jumpBackward",
	pageUp: "tui.editor.pageUp",
	pageDown: "tui.editor.pageDown",
	deleteCharBackward: "tui.editor.deleteCharBackward",
	deleteCharForward: "tui.editor.deleteCharForward",
	deleteWordBackward: "tui.editor.deleteWordBackward",
	deleteWordForward: "tui.editor.deleteWordForward",
	deleteToLineStart: "tui.editor.deleteToLineStart",
	deleteToLineEnd: "tui.editor.deleteToLineEnd",
	yank: "tui.editor.yank",
	yankPop: "tui.editor.yankPop",
	undo: "tui.editor.undo",
	// TUI input (old names for backward compatibility)
	newLine: "tui.input.newLine",
	submit: "tui.input.submit",
	tab: "tui.input.tab",
	copy: "tui.input.copy",
	// TUI select (old names for backward compatibility)
	selectUp: "tui.select.up",
	selectDown: "tui.select.down",
	selectPageUp: "tui.select.pageUp",
	selectPageDown: "tui.select.pageDown",
	selectConfirm: "tui.select.confirm",
	selectCancel: "tui.select.cancel",
	// Upstream additional migrations
	toggleSessionNamedFilter: "app.session.togglePath",
} as const satisfies Record<string, Keybinding>;

/**
 * Check if a key is a legacy keybinding name.
 */
function isLegacyKeybindingName(key: string): key is keyof typeof KEYBINDING_NAME_MIGRATIONS {
	return key in KEYBINDING_NAME_MIGRATIONS;
}

function toKeybindingsConfig(value: unknown): KeybindingsConfig {
	if (typeof value !== "object" || value === null) {
		return {};
	}

	const config: KeybindingsConfig = {};
	for (const [key, val] of Object.entries(value)) {
		if (!(key in KEYBINDINGS) && !isLegacyKeybindingName(key)) {
			logger.info("Ignoring unknown keybinding entry", { key });
			continue;
		}
		if (val === undefined) config[key] = undefined;
		else if (typeof val === "string") config[key] = val as KeyId;
		else if (Array.isArray(val) && val.every(v => typeof v === "string")) config[key] = val as KeyId[];
		else logger.info("Ignoring malformed keybinding entry", { key });
	}
	return config;
}

/**
 * Migrate old keybinding names to new namespaced IDs.
 * Returns both the migrated config and a flag indicating if migration occurred.
 */
function migrateKeybindingNames(rawConfig: unknown): {
	config: KeybindingsConfig;
	migrated: boolean;
} {
	const config = toKeybindingsConfig(rawConfig);
	const migrated: KeybindingsConfig = {};
	let didMigrate = false;

	for (const [key, value] of Object.entries(config)) {
		if (isLegacyKeybindingName(key)) {
			const newKey = KEYBINDING_NAME_MIGRATIONS[key];
			migrated[newKey] = value;
			didMigrate = true;
		} else {
			// Already a new-style key
			migrated[key] = value;
		}
	}

	return { config: migrated, migrated: didMigrate };
}

/**
 * Order keybindings config to match KEYBINDINGS key order.
 */
function orderKeybindingsConfig(config: KeybindingsConfig): KeybindingsConfig {
	const ordered: KeybindingsConfig = {};
	for (const key of Object.keys(KEYBINDINGS)) {
		const value = config[key];
		if (value !== undefined) {
			ordered[key] = value;
		}
	}
	// Add any remaining keys that aren't in KEYBINDINGS
	for (const key of Object.keys(config)) {
		if (!(key in ordered)) {
			ordered[key] = config[key];
		}
	}
	return ordered;
}

/**
 * Load raw config from a file synchronously.
 * Returns parsed JSON or null if file doesn't exist or is invalid.
 */
function loadRawConfig(filePath: string): unknown {
	try {
		if (!existsSync(filePath)) {
			return null;
		}
		const content = readFileSync(filePath, "utf-8");
		return JSON.parse(content);
	} catch (error) {
		if (isEnoent(error)) {
			return null;
		}
		logger.warn("Failed to parse keybindings config", { path: filePath, error: String(error) });
		return null;
	}
}

/** Migrate legacy keybindings once, preserving the original file as .bak. */
function loadKeybindingsConfig(filePath: string, writeBack: boolean): KeybindingsConfig {
	const rawConfig = loadRawConfig(filePath);
	if (rawConfig === null) return {};
	const markerPath = `${filePath}.migration-v1`;
	const { config: migratedConfig, migrated } = existsSync(markerPath)
		? { config: toKeybindingsConfig(rawConfig), migrated: false }
		: migrateKeybindingNames(rawConfig);
	if (writeBack && migrated) {
		const ordered = orderKeybindingsConfig(migratedConfig);
		const tempPath = `${filePath}.${process.pid}.tmp`;
		try {
			copyFileSync(filePath, `${filePath}.bak`);
			writeFileSync(tempPath, `${JSON.stringify(ordered, null, 2)}\n`, "utf-8");
			renameSync(tempPath, filePath);
			writeFileSync(markerPath, "v1\n", "utf-8");
			logger.debug("Migrated keybindings config", { path: filePath });
		} catch (error) {
			logger.warn("Failed to write migrated keybindings config", { path: filePath, error: String(error) });
		}
	}
	return migratedConfig;
}

function migrateKeybindingsConfigFile(agentDir: string): void {
	const configPath = path.join(agentDir, "keybindings.json");
	loadKeybindingsConfig(configPath, true);
}

/**
 * Manages all keybindings (app + TUI).
 * Extends the TUI KeybindingsManager with app-specific functionality.
 */
export class KeybindingsManager extends TuiKeybindingsManager {
	#configPath: string | undefined;

	constructor(userBindings: KeybindingsConfig = {}, configPath?: string) {
		super(KEYBINDINGS, userBindings);
		this.#configPath = configPath;
	}

	/**
	 * Create from config file at agentDir/keybindings.json.
	 */
	static create(agentDir: string = getAgentDir()): KeybindingsManager {
		const configPath = path.join(agentDir, "keybindings.json");
		const userBindings = KeybindingsManager.#loadFromFile(configPath);
		const manager = new KeybindingsManager(userBindings, configPath);
		// Set globally so getKeybindings() returns this manager
		setKeybindings(manager);
		return manager;
	}

	/**
	 * Create an in-memory keybindings manager without file persistence.
	 */
	static inMemory(userBindings: KeybindingsConfig = {}): KeybindingsManager {
		return new KeybindingsManager(userBindings);
	}

	/**
	 * Reload keybindings from the config file.
	 */
	reload(): void {
		if (!this.#configPath) return;
		this.setUserBindings(KeybindingsManager.#loadFromFile(this.#configPath));
	}

	/**
	 * Get the effective resolved bindings (defaults + user overrides).
	 */
	getEffectiveConfig(): KeybindingsConfig {
		return this.getResolvedBindings();
	}

	/**
	 * Get display string for a keybinding (e.g., "ctrl+c/escape").
	 */
	getDisplayString(keybinding: Keybinding): string {
		const keys = this.getKeys(keybinding);
		return formatKeyHints(keys.length === 0 ? [] : keys);
	}

	/**
	 * Load user bindings from a file, migrating old names if needed.
	 */
	static #loadFromFile(filePath: string): KeybindingsConfig {
		return loadKeybindingsConfig(filePath, true);
	}
}

/**
 * Key hint formatting utilities for UI labels.
 */
const MODIFIER_LABELS: Record<string, string> = {
	ctrl: "Ctrl",
	shift: "Shift",
	alt: "Alt",
};

const KEY_LABELS: Record<string, string> = {
	esc: "Esc",
	escape: "Esc",
	enter: "Enter",
	return: "Enter",
	space: "Space",
	tab: "Tab",
	backspace: "Backspace",
	delete: "Delete",
	home: "Home",
	end: "End",
	pageup: "PgUp",
	pagedown: "PgDn",
	up: "Up",
	down: "Down",
	left: "Left",
	right: "Right",
};

function formatKeyPart(part: string): string {
	const lower = part.toLowerCase();
	const modifier = MODIFIER_LABELS[lower];
	if (modifier) return modifier;
	const label = KEY_LABELS[lower];
	if (label) return label;
	if (part.length === 1) return part.toUpperCase();
	return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
}

export function formatKeyHint(key: KeyId): string {
	return key.split("+").map(formatKeyPart).join("+");
}

export function formatKeyHints(keys: KeyId | KeyId[]): string {
	const list = Array.isArray(keys) ? keys : [keys];
	return list.map(formatKeyHint).join("/");
}

export type { Keybinding, KeybindingsConfig, KeyId };
export { migrateKeybindingsConfigFile };

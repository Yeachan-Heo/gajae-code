import * as crypto from "node:crypto";
import type { Settings } from "../config/settings";

/**
 * Env marker set by GJC's own programmatic separate-process child spawn sites
 * (team workers, harness RPC owners) and carrying the spawning session id.
 *
 * Presence — not the value — marks a session as GJC-spawned. It is consumed
 * (read once, then deleted from the child's own env) at startup so it is
 * per-spawn rather than dynastic: a grandchild is marked only if its own spawn
 * site marks it, never by inheriting a marked ancestor's environment.
 */
export const SPAWN_PROVENANCE_ENV = "GJC_SPAWNED_BY_SESSION";

export interface NotificationConfig {
	enabled: boolean;
	botToken?: string;
	chatId?: string;
	discord: {
		botToken?: string;
		channelId?: string;
	};
	slack: {
		botToken?: string;
		channelId?: string;
	};
	redact: boolean;
	verbosity: "lean" | "verbose";
	/**
	 * Which sessions may register a notification endpoint. `all` (default)
	 * preserves historical behavior; `primary` suppresses GJC-spawned children
	 * (those carrying {@link SPAWN_PROVENANCE_ENV}) unless they explicitly opt in.
	 */
	sessionScope: "all" | "primary";
	idleTimeoutMs: number;
	rich: {
		enabled: boolean;
	};
	richDraft: {
		enabled: boolean;
	};
}

/** Read typed config from Settings. */
export function getNotificationConfig(settings: Settings): NotificationConfig {
	return {
		enabled: settings.get("notifications.enabled"),
		botToken: settings.get("notifications.telegram.botToken"),
		chatId: settings.get("notifications.telegram.chatId"),
		discord: {
			botToken: settings.get("notifications.discord.botToken"),
			channelId: settings.get("notifications.discord.channelId"),
		},
		slack: {
			botToken: settings.get("notifications.slack.botToken"),
			channelId: settings.get("notifications.slack.channelId"),
		},
		redact: settings.get("notifications.redact"),
		verbosity: settings.get("notifications.verbosity") === "verbose" ? "verbose" : "lean",
		sessionScope: settings.get("notifications.sessionScope") === "primary" ? "primary" : "all",
		idleTimeoutMs: settings.get("notifications.daemon.idleTimeoutMs"),
		rich: {
			enabled: settings.get("notifications.telegram.rich.enabled"),
		},
		richDraft: {
			enabled: settings.get("notifications.telegram.richDraft.enabled"),
		},
	};
}

export function hasNonBlankValue(value: string | undefined): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

/** Is Telegram configured with usable non-blank boundary credentials? */
export function isTelegramConfigured(
	cfg: NotificationConfig,
): cfg is NotificationConfig & { botToken: string; chatId: string } {
	return cfg.enabled && hasNonBlankValue(cfg.botToken) && hasNonBlankValue(cfg.chatId);
}

/** Is global config sufficient for auto-on (enabled + at least one configured adapter)? */
export function isGloballyConfigured(cfg: NotificationConfig): boolean {
	return (
		cfg.enabled &&
		(isTelegramConfigured(cfg) ||
			(hasNonBlankValue(cfg.discord.botToken) && hasNonBlankValue(cfg.discord.channelId)) ||
			(hasNonBlankValue(cfg.slack.botToken) && hasNonBlankValue(cfg.slack.channelId)))
	);
}

/**
 * Per-run opt-out for completion notifications, honored before settings lookups.
 *
 * `GJC_NOTIFY=off` (also `0` / `false`, case-insensitive) suppresses the
 * completion notification surface for this process only. `config.yml` is
 * untouched and child processes inherit the env var, which lets non-interactive
 * fleet runs (`gjc -p --no-session`) stay silent even when a user-level/global
 * completion notification configuration is enabled.
 */
export function completionNotifyDisabledByEnv(env: NodeJS.ProcessEnv): boolean {
	const v = env.GJC_NOTIFY?.trim().toLowerCase();
	return v === "off" || v === "0" || v === "false";
}

/** Resolve whether the notifications extension should be registered at SDK startup. */
export function shouldRegisterNotificationsExtension(input: {
	env: NodeJS.ProcessEnv;
	cfg?: NotificationConfig;
	/** Task recursion depth; helper/subagent sessions must not spawn remote surfaces. */
	taskDepth?: number;
	/** Parent subagent id/prefix; present for helper/subagent sessions even when depth is omitted. */
	parentTaskPrefix?: string;
	/** Role-agent type/name; present for task sessions even if depth metadata is lost. */
	currentAgentType?: string;
	/**
	 * True when this session was launched by one of GJC's own programmatic
	 * separate-process child spawn sites (marked via {@link SPAWN_PROVENANCE_ENV}).
	 * Under `notifications.sessionScope = "primary"` such children are suppressed
	 * unless they explicitly opt in, so an interactive parent that fans out work
	 * does not flood the paired chat with topics for children the user never
	 * asked for. User-opened sessions (CLI/tmux/headless) never carry the marker.
	 */
	spawnedByGjc?: boolean;
}): boolean {
	if ((input.taskDepth ?? 0) > 0 || input.parentTaskPrefix || input.currentAgentType) return false;
	if (completionNotifyDisabledByEnv(input.env)) return false;
	if (input.env.GJC_NOTIFICATIONS === "0") return false;
	if (input.env.GJC_NOTIFICATIONS === "1" || input.env.GJC_NOTIFICATIONS_TOKEN) return true;
	// Spawned-child suppression sits below explicit opt-in (so Telegram
	// `/session_create` and cold `/session_resume`, which launch with
	// GJC_NOTIFICATIONS=1, keep their fully bidirectional topic) and above global
	// auto-on (so their children stay silent under `primary`).
	if (input.spawnedByGjc && input.cfg?.sessionScope === "primary") return false;
	return input.cfg ? isGloballyConfigured(input.cfg) : false;
}

/**
 * Resolve whether THIS session should run notifications.
 * Precedence (highest first):
 *  1) env.GJC_NOTIFICATIONS === "0"  -> false (hard opt-out)
 *  2) sessionDisabled === true       -> false (local /notify off)
 *  3) env.GJC_NOTIFICATIONS === "1" || env.GJC_NOTIFICATIONS_TOKEN present -> true (legacy explicit)
 *  4) isGloballyConfigured(cfg)      -> true (global auto-on)
 *  5) otherwise false
 */
export function isSessionNotificationsEnabled(input: {
	cfg: NotificationConfig;
	env: NodeJS.ProcessEnv;
	sessionDisabled: boolean;
}): boolean {
	if (input.env.GJC_NOTIFICATIONS === "0") return false;
	if (input.sessionDisabled) return false;
	if (input.env.GJC_NOTIFICATIONS === "1" || input.env.GJC_NOTIFICATIONS_TOKEN) return true;
	return isGloballyConfigured(input.cfg);
}

/** Mask a bot token for display: first 4 chars + "…" + "(len N)"; "(unset)" when undefined/empty. Never reveal full token. */
export function maskToken(token: string | undefined): string {
	if (!token) return "(unset)";
	if (token.length <= 4) return `…(len ${token.length})`;
	return `${token.slice(0, 4)}…(len ${token.length})`;
}

/** Stable non-reversible fingerprint of a token: sha256 hex, first 12 chars. */
export function tokenFingerprint(token: string): string {
	return crypto.createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/** Short session tag for display, e.g. last 6 chars of sessionId. */
export function sessionTag(sessionId: string): string {
	return sessionId.slice(-6);
}

export interface RedactableAction {
	id: string;
	kind: string;
	sessionId: string;
	question?: string;
	options?: string[];
	summary?: string;
}

/**
 * When redact is true, strip sensitive content for remote delivery:
 *  - ask: NOT redacted. An ask is an interactive prompt the human must read and
 *    answer on the remote surface; redacting its question/options would make it
 *    unanswerable, defeating remote answering. Asks are returned unchanged.
 *  - idle: summary removed, (no question/options).
 * When redact is false, return the action unchanged.
 *
 * Redaction still applies to streamed content frames (turn_stream, context_update,
 * image_attachment) which are suppressed at their emit sites, not here. Explicit
 * `telegram_send` file attachments are rejected before the file is read or forwarded.
 */
export function buildRedactedAction(
	action: RedactableAction,
	opts: { redact: boolean; sessionTag: string },
): RedactableAction {
	if (!opts.redact) return action;

	// Asks stay fully readable/answerable even under redaction.
	if (action.kind === "ask") return action;

	const { summary: _summary, question: _question, options: _options, ...base } = action;
	return base;
}

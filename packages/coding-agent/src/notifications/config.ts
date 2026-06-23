import * as crypto from "node:crypto";
import type { Settings } from "../config/settings";

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
	idleTimeoutMs: number;
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
		idleTimeoutMs: settings.get("notifications.daemon.idleTimeoutMs"),
	};
}

/** Is global config sufficient for auto-on (enabled + at least one configured adapter)? */
export function isGloballyConfigured(cfg: NotificationConfig): boolean {
	return (
		cfg.enabled &&
		((Boolean(cfg.botToken) && Boolean(cfg.chatId)) ||
			(Boolean(cfg.discord.botToken) && Boolean(cfg.discord.channelId)) ||
			(Boolean(cfg.slack.botToken) && Boolean(cfg.slack.channelId)))
	);
}

/** Resolve whether the notifications extension should be registered at SDK startup. */
export function shouldRegisterNotificationsExtension(input: {
	env: NodeJS.ProcessEnv;
	cfg?: NotificationConfig;
}): boolean {
	if (input.env.GJC_NOTIFICATIONS === "0") return false;
	if (input.env.GJC_NOTIFICATIONS === "1" || input.env.GJC_NOTIFICATIONS_TOKEN) return true;
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
 * image_attachment) which are suppressed at their emit sites, not here.
 */
export function buildRedactedAction(
	action: RedactableAction,
	opts: { redact: boolean; sessionTag: string },
): RedactableAction {
	if (!opts.redact) return action;

	// Asks stay fully readable/answerable even under redaction.
	if (action.kind === "ask") return action;

	const { summary: _summary, question: _question, ...base } = action;
	return base;
}

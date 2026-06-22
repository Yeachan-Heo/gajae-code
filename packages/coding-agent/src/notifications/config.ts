import * as crypto from "node:crypto";
import type { Settings } from "../config/settings";

export interface NotificationConfig {
	enabled: boolean;
	botToken?: string;
	chatId?: string;
	redact: boolean;
	idleTimeoutMs: number;
}

/** Read typed config from Settings. */
export function getNotificationConfig(settings: Settings): NotificationConfig {
	return {
		enabled: settings.get("notifications.enabled"),
		botToken: settings.get("notifications.telegram.botToken"),
		chatId: settings.get("notifications.telegram.chatId"),
		redact: settings.get("notifications.redact"),
		idleTimeoutMs: settings.get("notifications.daemon.idleTimeoutMs"),
	};
}

/** Is global config sufficient for auto-on (enabled + botToken + chatId all present)? */
export function isGloballyConfigured(cfg: NotificationConfig): boolean {
	return cfg.enabled && Boolean(cfg.botToken) && Boolean(cfg.chatId);
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
 *  - ask: question -> `Session <tag> needs input: [Ask]`, options -> generic ["1","2",...] preserving COUNT/index, summary removed.
 *  - idle: summary removed, (no question/options).
 * When redact is false, return the action unchanged.
 * Index-based answers must still resolve: keep options.length identical.
 */
export function buildRedactedAction(
	action: RedactableAction,
	opts: { redact: boolean; sessionTag: string },
): RedactableAction {
	if (!opts.redact) return action;

	const { summary: _summary, question: _question, options: _options, ...base } = action;
	if (action.kind === "ask") {
		return {
			...base,
			question: `Session ${opts.sessionTag} needs input: [Ask]`,
			options: action.options?.map((_, index) => String(index + 1)),
		};
	}

	return base;
}

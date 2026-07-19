import * as crypto from "node:crypto";
import * as path from "node:path";
import * as z from "zod/v4";
import { ConfigFile, type LoadResult } from "../../config/config-file";

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

export type TelegramActivationState = "inactive" | "blocked";
export type TelegramActivationReason = "saved_inactive" | "identity_mismatch";

/** Non-secret, identity-specific durable Telegram activation state. */
export interface TelegramActivationMarker {
	identity: string;
	state: TelegramActivationState;
	updatedAt: string;
	reason?: TelegramActivationReason;
}

export type TelegramActivationMarkers = Record<string, TelegramActivationMarker>;

function isTelegramActivationMarker(value: unknown): value is TelegramActivationMarker {
	if (!value || typeof value !== "object") return false;
	const marker = value as Partial<TelegramActivationMarker>;
	return (
		(marker.state === "inactive" || marker.state === "blocked") &&
		typeof marker.identity === "string" &&
		marker.identity.length > 0 &&
		typeof marker.updatedAt === "string" &&
		(marker.reason === undefined || marker.reason === "saved_inactive" || marker.reason === "identity_mismatch")
	);
}

/** Validate and clone activation markers crossing the settings boundary. */
export function readTelegramActivationMarkers(value?: unknown): TelegramActivationMarkers {
	const markers: TelegramActivationMarkers = {};
	if (!value || typeof value !== "object" || Array.isArray(value)) return markers;
	for (const [identity, marker] of Object.entries(value)) {
		if (isTelegramActivationMarker(marker) && identity === marker.identity) markers[identity] = { ...marker };
	}
	return markers;
}

export interface NotificationSettingsSnapshot {
	enabled: boolean;
	telegram: {
		botToken?: string;
		chatId?: string;
		activation?: Record<string, unknown>;
		btw: {
			enabled: boolean;
		};
		rich: {
			enabled: boolean;
		};
		richDraft: {
			enabled: boolean;
		};
		toolActivity: {
			enabled: boolean;
		};
		topics: {
			nameTemplate?: string;
		};
	};
	discord: {
		botToken?: string;
		applicationId?: string;
		guildId?: string;
		parentChannelId?: string;
	};
	slack: {
		botToken?: string;
		appToken?: string;
		workspaceId?: string;
		channelId?: string;
		authorizedUserId?: string;
	};
	redact: boolean;
	verbosity: "lean" | "verbose";
	sessionScope: "all" | "primary";
	idleTimeoutMs: number;
}

/**
 * Narrow settings boundary for remote notification identity and behavior.
 * Implementations must return only user-global values, with schema defaults
 * applied; project settings and runtime overrides are intentionally excluded.
 */
export interface NotificationSettingsReader {
	getNotificationSettingsSnapshot(): NotificationSettingsSnapshot;
	getAgentDir(): string;
}
function notificationConfigurationError(): Error {
	return new Error("gjc_notify_daemon_invalid_configuration");
}

function notificationSettingsObject(value: unknown): Record<string, unknown> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) throw notificationConfigurationError();
	return value as Record<string, unknown>;
}

function notificationSettingsString(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") return value;
	throw notificationConfigurationError();
}

function notificationSettingsBoolean(value: unknown, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	if (typeof value === "boolean") return value;
	throw notificationConfigurationError();
}

function notificationSettingsChoice<T extends string>(value: unknown, fallback: T, choices: readonly T[]): T {
	if (value === undefined) return fallback;
	if (typeof value === "string" && choices.includes(value as T)) return value as T;
	throw notificationConfigurationError();
}

function notificationIdleTimeoutMs(value: unknown): number {
	if (value === undefined) return 60_000;
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	throw notificationConfigurationError();
}

/**
 * Validate and snapshot the raw global notification configuration used by both
 * the interactive host and the lightweight daemon process.
 */
export function parseNotificationSettingsSnapshot(rawConfig?: unknown): NotificationSettingsSnapshot {
	const root = notificationSettingsObject(rawConfig);
	const notifications = notificationSettingsObject(root.notifications);
	const telegram = notificationSettingsObject(notifications.telegram);
	const btw = notificationSettingsObject(telegram.btw);
	const rich = notificationSettingsObject(telegram.rich);
	const richDraft = notificationSettingsObject(telegram.richDraft);
	const toolActivity = notificationSettingsObject(telegram.toolActivity);
	const topics = notificationSettingsObject(telegram.topics);
	const activation = readTelegramActivationMarkers(notificationSettingsObject(telegram.activation));
	const discord = notificationSettingsObject(notifications.discord);
	const slack = notificationSettingsObject(notifications.slack);
	const daemon = notificationSettingsObject(notifications.daemon);
	return {
		enabled: notificationSettingsBoolean(notifications.enabled, false),
		telegram: {
			botToken: notificationSettingsString(telegram.botToken),
			chatId: notificationSettingsString(telegram.chatId),
			...(Object.keys(activation).length === 0 ? {} : { activation }),
			btw: {
				enabled: notificationSettingsBoolean(btw.enabled, true),
			},
			rich: {
				enabled: notificationSettingsBoolean(rich.enabled, true),
			},
			richDraft: {
				enabled: notificationSettingsBoolean(richDraft.enabled, false),
			},
			toolActivity: {
				enabled: notificationSettingsBoolean(toolActivity.enabled, true),
			},
			topics: {
				nameTemplate: notificationSettingsString(topics.nameTemplate),
			},
		},
		discord: {
			botToken: notificationSettingsString(discord.botToken),
			applicationId: notificationSettingsString(discord.applicationId),
			guildId: notificationSettingsString(discord.guildId),
			parentChannelId: notificationSettingsString(discord.parentChannelId),
		},
		slack: {
			botToken: notificationSettingsString(slack.botToken),
			appToken: notificationSettingsString(slack.appToken),
			workspaceId: notificationSettingsString(slack.workspaceId),
			channelId: notificationSettingsString(slack.channelId),
			authorizedUserId: notificationSettingsString(slack.authorizedUserId),
		},
		redact: notificationSettingsBoolean(notifications.redact, false),
		verbosity: notificationSettingsChoice<"lean" | "verbose">(notifications.verbosity, "lean", ["lean", "verbose"]),
		sessionScope: notificationSettingsChoice<"all" | "primary">(notifications.sessionScope, "all", [
			"all",
			"primary",
		]),
		idleTimeoutMs: notificationIdleTimeoutMs(daemon.idleTimeoutMs),
	};
}

export interface NotificationConfig {
	enabled: boolean;
	botToken?: string;
	activation?: TelegramActivationMarkers;
	chatId?: string;
	discord: {
		botToken?: string;
		applicationId?: string;
		guildId?: string;
		parentChannelId?: string;
	};
	slack: {
		botToken?: string;
		appToken?: string;
		workspaceId?: string;
		channelId?: string;
		authorizedUserId?: string;
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
	btw: {
		enabled: boolean;
	};
	rich: {
		enabled: boolean;
	};
	richDraft: {
		enabled: boolean;
	};
	toolActivity: {
		enabled: boolean;
	};
	topics: {
		/**
		 * Optional Telegram forum-topic name template with `{repo}`, `{branch}`,
		 * and `{title}` placeholders. Unset preserves the built-in
		 * `{repo}/{branch} - {title}` composition (with its title/repo/branch
		 * fallbacks).
		 */
		nameTemplate?: string;
	};
}

/** Read typed global-only notification config from a narrow settings reader. */
export function getNotificationConfig(settings: NotificationSettingsReader): NotificationConfig {
	const snapshot = settings.getNotificationSettingsSnapshot();
	const activation = readTelegramActivationMarkers(snapshot.telegram.activation);
	return {
		enabled: snapshot.enabled,
		botToken: snapshot.telegram.botToken,
		...(Object.keys(activation).length === 0 ? {} : { activation }),
		chatId: snapshot.telegram.chatId,
		discord: snapshot.discord,
		slack: snapshot.slack,
		redact: snapshot.redact,
		verbosity: snapshot.verbosity,
		sessionScope: snapshot.sessionScope,
		idleTimeoutMs: snapshot.idleTimeoutMs,
		rich: snapshot.telegram.rich,
		btw: snapshot.telegram.btw,
		richDraft: snapshot.telegram.richDraft,
		toolActivity: snapshot.telegram.toolActivity,
		topics: snapshot.telegram.topics,
	};
}

const notificationConfigSchema = z
	.object({
		notifications: z
			.object({
				enabled: z.boolean().optional(),
				discord: z
					.object({
						botToken: z.string().optional(),
						applicationId: z.string().optional(),
						guildId: z.string().optional(),
						parentChannelId: z.string().optional(),
					})
					.passthrough()
					.optional(),
				slack: z
					.object({
						botToken: z.string().optional(),
						appToken: z.string().optional(),
						workspaceId: z.string().optional(),
						channelId: z.string().optional(),
						authorizedUserId: z.string().optional(),
					})
					.passthrough()
					.optional(),
				redact: z.boolean().optional(),
				verbosity: z.enum(["lean", "verbose"]).optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();

type NotificationConfigFile = z.infer<typeof notificationConfigSchema>;

/** Read daemon settings through the canonical validated config-file boundary. */
export function loadNotificationConfigFile(agentDir: string): LoadResult<NotificationConfigFile> {
	return new ConfigFile("config", notificationConfigSchema, path.join(agentDir, "config.yml")).tryLoad();
}

export function notificationConfigFromFile(
	value: NotificationConfigFile,
): Pick<NotificationConfig, "enabled" | "discord" | "slack" | "redact" | "verbosity"> {
	const notifications = value.notifications;
	return {
		enabled: notifications?.enabled ?? false,
		discord: notifications?.discord ?? {},
		slack: notifications?.slack ?? {},
		redact: notifications?.redact ?? false,
		verbosity: notifications?.verbosity ?? "lean",
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

/** Is Discord configured with all credentials and routing identifiers required by its daemon. */
export function isDiscordConfigured(cfg: NotificationConfig): cfg is NotificationConfig & {
	discord: { botToken: string; applicationId: string; guildId: string; parentChannelId: string };
} {
	return (
		cfg.enabled &&
		hasNonBlankValue(cfg.discord.botToken) &&
		hasNonBlankValue(cfg.discord.applicationId) &&
		hasNonBlankValue(cfg.discord.guildId) &&
		hasNonBlankValue(cfg.discord.parentChannelId)
	);
}

/** Is Slack configured with both SDK tokens and its workspace/channel routing identifiers. */
export function isSlackConfigured(cfg: NotificationConfig): cfg is NotificationConfig & {
	slack: { botToken: string; appToken: string; workspaceId: string; channelId: string };
} {
	return (
		cfg.enabled &&
		hasNonBlankValue(cfg.slack.botToken) &&
		hasNonBlankValue(cfg.slack.appToken) &&
		hasNonBlankValue(cfg.slack.workspaceId) &&
		hasNonBlankValue(cfg.slack.channelId)
	);
}

/** Is global config sufficient for auto-on (enabled + at least one configured adapter)? */
export function isGloballyConfigured(cfg: NotificationConfig): boolean {
	return cfg.enabled && (isTelegramConfigured(cfg) || isDiscordConfigured(cfg) || isSlackConfigured(cfg));
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

/** Canonical host eligibility for the dormant notification session surface. */
export interface NotificationHostEligibilityInput {
	env: NodeJS.ProcessEnv;
	/** False for host modes that cannot own a notification session endpoint. */
	hostModeSupported?: boolean;
	/** Task recursion depth; helper/subagent sessions must not own remote surfaces. */
	taskDepth?: number;
	/** Parent subagent id/prefix; present for helper/subagent sessions even when depth is omitted. */
	parentTaskPrefix?: string;
	/** Role-agent type/name; present for task sessions even if depth metadata is lost. */
	currentAgentType?: string;
	/** Canonical global session scope; absent preserves the default `all` behavior. */
	sessionScope?: NotificationConfig["sessionScope"];
	/** Whether this process was spawned by one of GJC's marked child spawn sites. */
	spawnedByGjc?: boolean;
}

/**
 * Resolve whether this host may receive the dormant notification controller.
 * This intentionally says nothing about whether an adapter is configured: an
 * eligible unconfigured host still gets a zero-side-effect control surface.
 */
export function isNotificationHostEligible(input: NotificationHostEligibilityInput): boolean {
	if (completionNotifyDisabledByEnv(input.env)) return false;
	if (input.hostModeSupported === false) return false;
	if ((input.taskDepth ?? 0) > 0 || input.parentTaskPrefix || input.currentAgentType) return false;
	if (input.env.GJC_NOTIFICATIONS === "0") return false;
	if (input.env.GJC_NOTIFICATIONS === "1" || input.env.GJC_NOTIFICATIONS_TOKEN) return true;
	if (input.spawnedByGjc && input.sessionScope === "primary") return false;
	return true;
}

/**
 * Legacy compatibility helper for callers that require both host eligibility
 * and a currently configured or explicit notification runtime.
 */
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
	if (
		!isNotificationHostEligible({
			env: input.env,
			taskDepth: input.taskDepth,
			parentTaskPrefix: input.parentTaskPrefix,
			currentAgentType: input.currentAgentType,
			sessionScope: input.cfg?.sessionScope,
			spawnedByGjc: input.spawnedByGjc,
		})
	) {
		return false;
	}
	return (
		input.env.GJC_NOTIFICATIONS === "1" ||
		Boolean(input.env.GJC_NOTIFICATIONS_TOKEN) ||
		Boolean(input.cfg && isGloballyConfigured(input.cfg))
	);
}

/**
 * Resolve whether THIS session should run notifications.
 * Precedence (highest first):
 *  1) env.GJC_NOTIFICATIONS === "0"  -> false (hard opt-out)
 *  2) sessionDisabled === true       -> false (local /notify off)
 *  3) env.GJC_NOTIFICATIONS === "1" || env.GJC_NOTIFICATIONS_TOKEN present -> true (legacy explicit)
 *  4) spawned GJC child with `sessionScope=primary` -> false
 *  5) isGloballyConfigured(cfg)      -> true (global auto-on)
 *  6) otherwise false
 */
export function isSessionNotificationsEnabled(input: {
	cfg: NotificationConfig;
	env: NodeJS.ProcessEnv;
	sessionDisabled: boolean;
	/** This process was programmatically spawned by GJC (consumed at SDK startup). */
	spawnedByGjc?: boolean;
}): boolean {
	if (input.env.GJC_NOTIFICATIONS === "0") return false;
	if (input.sessionDisabled) return false;
	if (input.env.GJC_NOTIFICATIONS === "1" || input.env.GJC_NOTIFICATIONS_TOKEN) return true;
	if (input.spawnedByGjc && input.cfg.sessionScope === "primary") return false;
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

/** Deterministic non-secret key for one Telegram token/chat identity. */
export function telegramActivationIdentity(botToken: string, chatId: string): string {
	return `${tokenFingerprint(botToken)}:${tokenFingerprint(chatId)}`;
}

/** Return the durable marker for the currently configured Telegram identity, if any. */
export function getCurrentTelegramActivationMarker(cfg: NotificationConfig): TelegramActivationMarker | undefined {
	const botToken = cfg.botToken;
	const chatId = cfg.chatId;
	if (typeof botToken !== "string" || botToken.trim().length === 0) return undefined;
	if (typeof chatId !== "string" || chatId.trim().length === 0) return undefined;
	return cfg.activation?.[telegramActivationIdentity(botToken, chatId)];
}

/** Short session tag for display, e.g. last 6 chars of sessionId. */
export function sessionTag(sessionId: string): string {
	return sessionId.slice(-6);
}

export interface RedactableAction {
	id: string;
	kind: string;
	sessionId: string;
	/** Durable workflow-gate correlation metadata; never generic reply authority. */
	workflowGateId?: string;
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

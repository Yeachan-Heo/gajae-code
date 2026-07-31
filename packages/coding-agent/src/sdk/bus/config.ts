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

export type NotificationProvider = "telegram" | "discord" | "slack";
export type NotificationRuntime = "inactive" | "starting" | "ready" | "attached" | "blocked" | "failed";
export type ProviderSecretDisposition = "keep" | "replace" | "remove";
export type ProviderResolutionIssueCode = "missing" | "blank" | "wrong_type" | "invalid_container" | "contradictory";

export interface ProviderResolutionIssue {
	path: string;
	code: ProviderResolutionIssueCode;
}

export type NotificationProviderIssueCode = ProviderResolutionIssueCode;
export type NotificationProviderIssue = ProviderResolutionIssue;

export interface ProviderResolution {
	provider: NotificationProvider;
	configured: boolean;
	quarantined: boolean;
	desiredEnabled: boolean;
	desiredSource: "explicit" | "legacy";
	effectiveEnabled: boolean;
	issues: readonly ProviderResolutionIssue[];
}
const NOTIFICATION_PROVIDERS = ["telegram", "discord", "slack"] as const;

export interface NotificationSettingsSnapshot {
	enabled: boolean;
	telegram: {
		enabled?: boolean;
		botToken?: string;
		chatId?: string;
		activation?: Record<string, unknown>;
		sound: "all" | "important" | "none";
		btw: { enabled: boolean };
		rich: { enabled: boolean };
		richDraft: { enabled: boolean };
		toolActivity: { enabled: boolean };
		streaming: { enabled: boolean };
		topics: { nameTemplate?: string };
	};
	discord: {
		enabled?: boolean;
		botToken?: string;
		applicationId?: string;
		guildId?: string;
		parentChannelId?: string;
	};
	slack: {
		enabled?: boolean;
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
	/** Safe provider-local validation issues. Raw values never cross this boundary. */
	providerIssues?: Partial<Record<NotificationProvider, readonly ProviderResolutionIssue[]>>;
}

/**
 * Narrow settings boundary for remote notification identity and behavior.
 * Implementations return only user-global values; project settings and runtime
 * overrides are intentionally excluded.
 */
export interface NotificationSettingsReader {
	getNotificationSettingsSnapshot(): NotificationSettingsSnapshot;
	getAgentDir(): string;
}

function notificationConfigurationError(): Error {
	return new Error("gjc_notify_daemon_invalid_configuration");
}

type NotificationObject = Record<string, unknown>;

function notificationObject(value: unknown): NotificationObject {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) throw notificationConfigurationError();
	return value as NotificationObject;
}

function providerObject(value: unknown, pathName: string, issues: ProviderResolutionIssue[]): NotificationObject {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		issues.push({ path: pathName, code: "invalid_container" });
		return {};
	}
	return value as NotificationObject;
}

function addProviderIssue(
	issues: ProviderResolutionIssue[],
	pathName: string,
	code: ProviderResolutionIssueCode,
): void {
	if (!issues.some(issue => issue.path === pathName && issue.code === code)) issues.push({ path: pathName, code });
}

function providerString(
	container: NotificationObject,
	key: string,
	pathName: string,
	issues: ProviderResolutionIssue[],
): string | undefined {
	const value = container[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		addProviderIssue(issues, pathName, "wrong_type");
		return undefined;
	}
	if (value.trim().length === 0) {
		addProviderIssue(issues, pathName, "blank");
		return undefined;
	}
	return value;
}

function providerBoolean(
	container: NotificationObject,
	key: string,
	pathName: string,
	fallback: boolean,
	issues: ProviderResolutionIssue[],
): boolean {
	const value = container[key];
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") {
		addProviderIssue(issues, pathName, "wrong_type");
		return fallback;
	}
	return value;
}

function providerChoice<T extends string>(
	container: NotificationObject,
	key: string,
	pathName: string,
	fallback: T,
	choices: readonly T[],
	issues: ProviderResolutionIssue[],
): T {
	const value = container[key];
	if (value === undefined) return fallback;
	if (typeof value === "string" && choices.includes(value as T)) return value as T;
	addProviderIssue(issues, pathName, "wrong_type");
	return fallback;
}

function providerActivation(
	container: NotificationObject,
	pathName: string,
	issues: ProviderResolutionIssue[],
): Record<string, unknown> | undefined {
	const value = container.activation;
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		addProviderIssue(issues, pathName, "invalid_container");
		return undefined;
	}
	const safe = readTelegramActivationMarkers(value);
	if (Object.keys(safe).length !== Object.keys(value as NotificationObject).length) {
		addProviderIssue(issues, pathName, "contradictory");
	}
	return Object.keys(safe).length === 0 ? undefined : safe;
}

function providerTopics(
	container: NotificationObject,
	pathName: string,
	issues: ProviderResolutionIssue[],
): { nameTemplate?: string } {
	const topics = providerObject(container.topics, pathName, issues);
	return { nameTemplate: providerString(topics, "nameTemplate", `${pathName}.nameTemplate`, issues) };
}

function providerEnabled(
	container: NotificationObject,
	pathName: string,
	issues: ProviderResolutionIssue[],
): boolean | undefined {
	const value = container.enabled;
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") {
		addProviderIssue(issues, pathName, "wrong_type");
		return undefined;
	}
	return value;
}

function addMissingRequiredProviderIssues(
	container: NotificationObject,
	required: readonly string[],
	basePath: string,
	issues: ProviderResolutionIssue[],
	explicitlyEnabled: boolean,
): void {
	const anyRequiredPresent = required.some(key => container[key] !== undefined);
	if (!anyRequiredPresent && !explicitlyEnabled) return;
	for (const key of required) {
		if (container[key] === undefined) addProviderIssue(issues, `${basePath}.${key}`, "missing");
	}
}

function providerIssuesSnapshot(
	provider: NotificationProvider,
	issues: readonly ProviderResolutionIssue[],
): Partial<Record<NotificationProvider, readonly ProviderResolutionIssue[]>> | undefined {
	return issues.length === 0 ? undefined : { [provider]: issues.map(issue => ({ ...issue })) };
}

/** Validate and snapshot raw global notification configuration without leaking invalid provider values. */
export function parseNotificationSettingsSnapshot(rawConfig?: unknown): NotificationSettingsSnapshot {
	const root = notificationObject(rawConfig);
	const notifications = notificationObject(root.notifications);
	const telegramIssues: ProviderResolutionIssue[] = [];
	const discordIssues: ProviderResolutionIssue[] = [];
	const slackIssues: ProviderResolutionIssue[] = [];
	const telegram = providerObject(notifications.telegram, "notifications.telegram", telegramIssues);
	const discord = providerObject(notifications.discord, "notifications.discord", discordIssues);
	const slack = providerObject(notifications.slack, "notifications.slack", slackIssues);
	const btw = providerObject(telegram.btw, "notifications.telegram.btw", telegramIssues);
	const rich = providerObject(telegram.rich, "notifications.telegram.rich", telegramIssues);
	const richDraft = providerObject(telegram.richDraft, "notifications.telegram.richDraft", telegramIssues);
	const toolActivity = providerObject(telegram.toolActivity, "notifications.telegram.toolActivity", telegramIssues);
	const streaming = providerObject(telegram.streaming, "notifications.telegram.streaming", telegramIssues);
	const activation = providerActivation(telegram, "notifications.telegram.activation", telegramIssues);
	const daemon = notificationObject(notifications.daemon);
	const telegramEnabled = providerEnabled(telegram, "notifications.telegram.enabled", telegramIssues);
	const discordEnabled = providerEnabled(discord, "notifications.discord.enabled", discordIssues);
	const slackEnabled = providerEnabled(slack, "notifications.slack.enabled", slackIssues);
	addMissingRequiredProviderIssues(
		telegram,
		["botToken", "chatId"],
		"notifications.telegram",
		telegramIssues,
		telegramEnabled === true,
	);
	addMissingRequiredProviderIssues(
		discord,
		["botToken", "applicationId", "guildId", "parentChannelId"],
		"notifications.discord",
		discordIssues,
		discordEnabled === true,
	);
	addMissingRequiredProviderIssues(
		slack,
		["botToken", "appToken", "workspaceId", "channelId"],
		"notifications.slack",
		slackIssues,
		slackEnabled === true,
	);
	const telegramSnapshot: NotificationSettingsSnapshot["telegram"] = {
		...(telegramEnabled === undefined ? {} : { enabled: telegramEnabled }),
		botToken: providerString(telegram, "botToken", "notifications.telegram.botToken", telegramIssues),
		chatId: providerString(telegram, "chatId", "notifications.telegram.chatId", telegramIssues),
		...(activation === undefined ? {} : { activation }),
		sound: providerChoice(
			telegram,
			"sound",
			"notifications.telegram.sound",
			"all",
			["all", "important", "none"],
			telegramIssues,
		),
		btw: { enabled: providerBoolean(btw, "enabled", "notifications.telegram.btw.enabled", true, telegramIssues) },
		rich: { enabled: providerBoolean(rich, "enabled", "notifications.telegram.rich.enabled", true, telegramIssues) },
		richDraft: {
			enabled: providerBoolean(
				richDraft,
				"enabled",
				"notifications.telegram.richDraft.enabled",
				false,
				telegramIssues,
			),
		},
		toolActivity: {
			enabled: providerBoolean(
				toolActivity,
				"enabled",
				"notifications.telegram.toolActivity.enabled",
				false,
				telegramIssues,
			),
		},
		streaming: {
			enabled: providerBoolean(
				streaming,
				"enabled",
				"notifications.telegram.streaming.enabled",
				true,
				telegramIssues,
			),
		},
		topics: providerTopics(telegram, "notifications.telegram.topics", telegramIssues),
	};
	const discordSnapshot: NotificationSettingsSnapshot["discord"] = {
		...(discordEnabled === undefined ? {} : { enabled: discordEnabled }),
		botToken: providerString(discord, "botToken", "notifications.discord.botToken", discordIssues),
		applicationId: providerString(discord, "applicationId", "notifications.discord.applicationId", discordIssues),
		guildId: providerString(discord, "guildId", "notifications.discord.guildId", discordIssues),
		parentChannelId: providerString(
			discord,
			"parentChannelId",
			"notifications.discord.parentChannelId",
			discordIssues,
		),
	};
	const slackSnapshot: NotificationSettingsSnapshot["slack"] = {
		...(slackEnabled === undefined ? {} : { enabled: slackEnabled }),
		botToken: providerString(slack, "botToken", "notifications.slack.botToken", slackIssues),
		appToken: providerString(slack, "appToken", "notifications.slack.appToken", slackIssues),
		workspaceId: providerString(slack, "workspaceId", "notifications.slack.workspaceId", slackIssues),
		channelId: providerString(slack, "channelId", "notifications.slack.channelId", slackIssues),
		authorizedUserId: providerString(slack, "authorizedUserId", "notifications.slack.authorizedUserId", slackIssues),
	};
	const providerIssues: Partial<Record<NotificationProvider, readonly ProviderResolutionIssue[]>> = {
		...(providerIssuesSnapshot("telegram", telegramIssues) ?? {}),
		...(providerIssuesSnapshot("discord", discordIssues) ?? {}),
		...(providerIssuesSnapshot("slack", slackIssues) ?? {}),
	};
	const snapshot: NotificationSettingsSnapshot = {
		enabled: notificationGlobalBoolean(notifications.enabled, false),
		telegram: telegramSnapshot,
		discord: discordSnapshot,
		slack: slackSnapshot,
		redact: notificationGlobalBoolean(notifications.redact, false),
		verbosity: notificationGlobalChoice(notifications.verbosity, "lean", ["lean", "verbose"]),
		sessionScope: notificationGlobalChoice(notifications.sessionScope, "all", ["all", "primary"]),
		idleTimeoutMs: notificationIdleTimeoutMs(daemon.idleTimeoutMs),
	};
	if (Object.keys(providerIssues).length > 0) snapshot.providerIssues = providerIssues;
	return snapshot;
}

function notificationGlobalBoolean(value: unknown, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw notificationConfigurationError();
	return value;
}

function notificationGlobalChoice<T extends string>(value: unknown, fallback: T, choices: readonly T[]): T {
	if (value === undefined) return fallback;
	if (typeof value === "string" && choices.includes(value as T)) return value as T;
	throw notificationConfigurationError();
}

function notificationIdleTimeoutMs(value: unknown): number {
	if (value === undefined) return 60_000;
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	throw notificationConfigurationError();
}

export interface NotificationConfig {
	enabled: boolean;
	botToken?: string;
	activation?: TelegramActivationMarkers;
	chatId?: string;
	/** Optional nested Telegram intent metadata; absent means legacy configuration. */
	telegram?: { enabled?: boolean };
	discord: {
		enabled?: boolean;
		botToken?: string;
		applicationId?: string;
		guildId?: string;
		parentChannelId?: string;
	};
	slack: {
		enabled?: boolean;
		botToken?: string;
		appToken?: string;
		workspaceId?: string;
		channelId?: string;
		authorizedUserId?: string;
	};
	redact: boolean;
	verbosity: "lean" | "verbose";
	sessionScope: "all" | "primary";
	sound: "all" | "important" | "none";
	idleTimeoutMs: number;
	btw: { enabled: boolean };
	rich: { enabled: boolean };
	richDraft: { enabled: boolean };
	toolActivity: { enabled: boolean };
	streaming: { enabled: boolean };
	topics: { nameTemplate?: string };
	providerIssues?: Partial<Record<NotificationProvider, readonly ProviderResolutionIssue[]>>;
}

function notificationConfigFromSnapshot(snapshot: NotificationSettingsSnapshot): NotificationConfig {
	const activation = readTelegramActivationMarkers(snapshot.telegram.activation);
	const config: NotificationConfig = {
		enabled: snapshot.enabled,
		botToken: snapshot.telegram.botToken,
		...(Object.keys(activation).length === 0 ? {} : { activation }),
		chatId: snapshot.telegram.chatId,
		...(snapshot.telegram.enabled === undefined ? {} : { telegram: { enabled: snapshot.telegram.enabled } }),
		discord: {
			...(snapshot.discord.enabled === undefined ? {} : { enabled: snapshot.discord.enabled }),
			botToken: snapshot.discord.botToken,
			applicationId: snapshot.discord.applicationId,
			guildId: snapshot.discord.guildId,
			parentChannelId: snapshot.discord.parentChannelId,
		},
		slack: {
			...(snapshot.slack.enabled === undefined ? {} : { enabled: snapshot.slack.enabled }),
			botToken: snapshot.slack.botToken,
			appToken: snapshot.slack.appToken,
			workspaceId: snapshot.slack.workspaceId,
			channelId: snapshot.slack.channelId,
			authorizedUserId: snapshot.slack.authorizedUserId,
		},
		redact: snapshot.redact,
		verbosity: snapshot.verbosity,
		sessionScope: snapshot.sessionScope,
		idleTimeoutMs: snapshot.idleTimeoutMs,
		sound: snapshot.telegram.sound,
		rich: snapshot.telegram.rich,
		btw: snapshot.telegram.btw,
		richDraft: snapshot.telegram.richDraft,
		toolActivity: snapshot.telegram.toolActivity,
		streaming: snapshot.telegram.streaming,
		topics: snapshot.telegram.topics,
	};
	if (snapshot.providerIssues) config.providerIssues = snapshot.providerIssues;
	return config;
}

/** Read typed global-only notification config from a narrow settings reader. */
export function getNotificationConfig(settings: NotificationSettingsReader): NotificationConfig {
	return notificationConfigFromSnapshot(settings.getNotificationSettingsSnapshot());
}

const notificationConfigSchema = z.object({}).passthrough();
type NotificationConfigFile = z.infer<typeof notificationConfigSchema>;

/** Read daemon settings through the canonical validated config-file boundary. */
export function loadNotificationConfigFile(agentDir: string): LoadResult<NotificationConfigFile> {
	return new ConfigFile("config", notificationConfigSchema, path.join(agentDir, "config.yml")).tryLoad();
}

export function notificationConfigFromFile(value: NotificationConfigFile): NotificationConfig {
	return notificationConfigFromSnapshot(parseNotificationSettingsSnapshot(value));
}

export function hasNonBlankValue(value: string | undefined): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function providerRequiredFields(
	cfg: NotificationConfig,
	provider: NotificationProvider,
): Readonly<Record<string, unknown>> {
	if (provider === "telegram") return { botToken: cfg.botToken, chatId: cfg.chatId };
	if (provider === "discord") {
		return {
			botToken: cfg.discord.botToken,
			applicationId: cfg.discord.applicationId,
			guildId: cfg.discord.guildId,
			parentChannelId: cfg.discord.parentChannelId,
		};
	}
	return {
		botToken: cfg.slack.botToken,
		appToken: cfg.slack.appToken,
		workspaceId: cfg.slack.workspaceId,
		channelId: cfg.slack.channelId,
	};
}

function providerOptionalFields(
	cfg: NotificationConfig,
	provider: NotificationProvider,
): Readonly<Record<string, unknown>> {
	return provider === "slack" ? { authorizedUserId: cfg.slack.authorizedUserId } : {};
}

function providerConfigEnabled(cfg: NotificationConfig, provider: NotificationProvider): unknown {
	if (provider === "telegram") return cfg.telegram?.enabled;
	if (provider === "discord") return cfg.discord.enabled;
	return cfg.slack.enabled;
}

function providerStoredIssues(
	cfg: NotificationConfig,
	provider: NotificationProvider,
): readonly ProviderResolutionIssue[] {
	return cfg.providerIssues?.[provider] ?? [];
}

function uniqueProviderIssues(issues: readonly ProviderResolutionIssue[]): ProviderResolutionIssue[] {
	const result: ProviderResolutionIssue[] = [];
	for (const issue of issues) {
		if (!result.some(existing => existing.path === issue.path && existing.code === issue.code))
			result.push({ ...issue });
	}
	return result;
}

function providerFacts(
	cfg: NotificationConfig,
	provider: NotificationProvider,
): {
	configured: boolean;
	quarantined: boolean;
	issues: ProviderResolutionIssue[];
} {
	const required = providerRequiredFields(cfg, provider);
	const optional = providerOptionalFields(cfg, provider);
	const issues = [...providerStoredIssues(cfg, provider)];
	const anyRequiredPresent = Object.values(required).some(value => value !== undefined);
	const explicitlyEnabled = providerConfigEnabled(cfg, provider) === true;
	for (const [key, value] of Object.entries(required)) {
		const pathName = `notifications.${provider}.${key}`;
		if (value === undefined) {
			if (anyRequiredPresent || explicitlyEnabled) issues.push({ path: pathName, code: "missing" });
		} else if (typeof value !== "string") issues.push({ path: pathName, code: "wrong_type" });
		else if (value.trim().length === 0) issues.push({ path: pathName, code: "blank" });
	}
	for (const [key, value] of Object.entries(optional)) {
		if (value === undefined) continue;
		const pathName = `notifications.${provider}.${key}`;
		if (typeof value !== "string") issues.push({ path: pathName, code: "wrong_type" });
		else if (value.trim().length === 0) issues.push({ path: pathName, code: "blank" });
	}
	const uniqueIssues = uniqueProviderIssues(issues);
	const configured = Object.values(required).every(value => typeof value === "string" && value.trim().length > 0);
	const quarantined = uniqueIssues.some(issue => issue.code !== "missing");
	return { configured, quarantined, issues: uniqueIssues };
}

export function isProviderComplete(cfg: NotificationConfig, provider: NotificationProvider): boolean {
	return providerFacts(cfg, provider).configured;
}

export function isTelegramComplete(
	cfg: NotificationConfig,
): cfg is NotificationConfig & { botToken: string; chatId: string } {
	return isProviderComplete(cfg, "telegram");
}

export function isDiscordComplete(cfg: NotificationConfig): cfg is NotificationConfig & {
	discord: { botToken: string; applicationId: string; guildId: string; parentChannelId: string };
} {
	return isProviderComplete(cfg, "discord");
}

export function isSlackComplete(cfg: NotificationConfig): cfg is NotificationConfig & {
	slack: { botToken: string; appToken: string; workspaceId: string; channelId: string };
} {
	return isProviderComplete(cfg, "slack");
}

export function resolveNotificationProvider(
	cfg: NotificationConfig,
	provider: NotificationProvider,
): ProviderResolution {
	const facts = providerFacts(cfg, provider);
	const configuredEnabled = providerConfigEnabled(cfg, provider);
	const explicitIssue = facts.issues.some(issue => issue.path === `notifications.${provider}.enabled`);
	const explicit = typeof configuredEnabled === "boolean" ? configuredEnabled : undefined;
	const desiredSource: ProviderResolution["desiredSource"] =
		explicit !== undefined || explicitIssue ? "explicit" : "legacy";
	const desiredEnabled = explicitIssue ? false : (explicit ?? (facts.configured && !facts.quarantined));
	return {
		provider,
		configured: facts.configured,
		quarantined: facts.quarantined,
		desiredEnabled,
		desiredSource,
		effectiveEnabled: cfg.enabled && desiredEnabled && facts.configured && !facts.quarantined,
		issues: facts.issues,
	};
}

export function isProviderEffectivelyEnabled(cfg: NotificationConfig, provider: NotificationProvider): boolean {
	return resolveNotificationProvider(cfg, provider).effectiveEnabled;
}

export function hasAnyCompleteProvider(cfg: NotificationConfig): boolean {
	return NOTIFICATION_PROVIDERS.some(provider => isProviderComplete(cfg, provider));
}

export function hasAnyEffectivelyEnabledProvider(cfg: NotificationConfig): boolean {
	return NOTIFICATION_PROVIDERS.some(provider => isProviderEffectivelyEnabled(cfg, provider));
}

/**
 * Resolve generic live-stream policy. This policy only governs automatic
 * current-session frames; it never changes durable provider eligibility.
 */
export type GenericNotificationSessionSource =
	| "hard_opt_out"
	| "session_local_off"
	| "explicit_env"
	| "token_env"
	| "configured_provider"
	| "session_scope"
	| "none";

export interface GenericNotificationSessionEligibility {
	enabled: boolean;
	source: GenericNotificationSessionSource;
}

export type GenericNotificationStreamSource =
	| "session_not_admitted"
	| "env_on"
	| "env_off"
	| "durable_telegram"
	| "none";

export interface GenericNotificationStreamPolicy {
	enabled: boolean;
	source: GenericNotificationStreamSource;
}

export interface GenericNotificationSessionEligibilityInput {
	cfg: NotificationConfig;
	env: NodeJS.ProcessEnv;
	sessionDisabled: boolean;
	spawnedByGjc?: boolean;
}

export function resolveGenericNotificationSessionEligibility(
	input: GenericNotificationSessionEligibilityInput,
): GenericNotificationSessionEligibility {
	if (input.env.GJC_NOTIFICATIONS === "0") return { enabled: false, source: "hard_opt_out" };
	if (input.sessionDisabled) return { enabled: false, source: "session_local_off" };
	if (input.env.GJC_NOTIFICATIONS === "1") return { enabled: true, source: "explicit_env" };
	if (input.env.GJC_NOTIFICATIONS_TOKEN) return { enabled: true, source: "token_env" };
	if (input.spawnedByGjc && input.cfg.sessionScope === "primary") {
		return { enabled: false, source: "session_scope" };
	}
	if (hasAnyEffectivelyEnabledProvider(input.cfg)) return { enabled: true, source: "configured_provider" };
	return { enabled: false, source: "none" };
}

export function resolveGenericNotificationStreamPolicy(input: {
	cfg: NotificationConfig;
	env: NodeJS.ProcessEnv;
	genericSessionEnabled: boolean;
}): GenericNotificationStreamPolicy {
	if (!input.genericSessionEnabled) return { enabled: false, source: "session_not_admitted" };
	const override = input.env.GJC_NOTIFICATIONS_STREAM?.trim().toLowerCase();
	if (override === "1") return { enabled: true, source: "env_on" };
	if (override === "0" || override === "off" || override === "false") return { enabled: false, source: "env_off" };
	const durableEnabled =
		input.cfg.streaming.enabled &&
		isProviderEffectivelyEnabled(input.cfg, "telegram") &&
		!getCurrentTelegramActivationMarker(input.cfg);
	return { enabled: durableEnabled, source: durableEnabled ? "durable_telegram" : "none" };
}

export function completionNotifyDisabledByEnv(env: NodeJS.ProcessEnv): boolean {
	const value = env.GJC_NOTIFY?.trim().toLowerCase();
	return value === "off" || value === "0" || value === "false";
}

export interface NotificationHostEligibilityInput {
	env: NodeJS.ProcessEnv;
	hostModeSupported?: boolean;
	taskDepth?: number;
	parentTaskPrefix?: string;
	currentAgentType?: string;
	sessionScope?: NotificationConfig["sessionScope"];
	spawnedByGjc?: boolean;
}

/** Generic host eligibility for the dormant automatic notification surface. */
export function isGenericNotificationHostEligible(input: NotificationHostEligibilityInput): boolean {
	if (completionNotifyDisabledByEnv(input.env)) return false;
	if (input.hostModeSupported === false) return false;
	if ((input.taskDepth ?? 0) > 0 || input.parentTaskPrefix || input.currentAgentType) return false;
	if (input.env.GJC_NOTIFICATIONS === "0") return false;
	if (input.env.GJC_NOTIFICATIONS === "1" || input.env.GJC_NOTIFICATIONS_TOKEN) return true;
	if (input.spawnedByGjc && input.sessionScope === "primary") return false;
	return true;
}

export interface GenericNotificationRegistrationInput {
	env: NodeJS.ProcessEnv;
	cfg?: NotificationConfig;
	taskDepth?: number;
	parentTaskPrefix?: string;
	currentAgentType?: string;
	spawnedByGjc?: boolean;
}

/** Generic registration admission; direct provider actions do not call this helper. */
export function shouldRegisterGenericNotificationsExtension(input: GenericNotificationRegistrationInput): boolean {
	if (
		!isGenericNotificationHostEligible({
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
	if (input.env.GJC_NOTIFICATIONS === "1" || input.env.GJC_NOTIFICATIONS_TOKEN) return true;
	return input.cfg !== undefined && hasAnyEffectivelyEnabledProvider(input.cfg);
}

export function isGenericNotificationSessionEnabled(input: GenericNotificationSessionEligibilityInput): boolean {
	return resolveGenericNotificationSessionEligibility(input).enabled;
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
	/** Selected zero-based option positions for transport-specific multi-select rendering. */
	selectedOptionIndices?: number[];
	summary?: string;
	/** Optional zero-based recommendation into the authoritative raw options. */
	recommendedIndex?: number;
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

	const {
		summary: _summary,
		question: _question,
		options: _options,
		recommendedIndex: _recommendedIndex,
		...base
	} = action;
	return base;
}

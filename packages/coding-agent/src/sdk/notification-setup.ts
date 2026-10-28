import * as path from "node:path";
import type { Settings, SettingsAtomicReceipt } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import type { SessionManager } from "../session/session-manager";
import { ChatDaemonController } from "./bus/chat-daemon-control";
import {
	getCurrentTelegramActivationMarker,
	getNotificationConfig,
	isProviderEffectivelyEnabled,
	isTelegramComplete,
	maskToken,
	type NotificationProvider,
} from "./bus/config";
import {
	type BlockedTelegramRestoreResult,
	clearTelegramActivationMarker,
	createTelegramActivationMarker,
	mutateNotificationProvider,
	type NotificationProviderConfigurationMutation,
	type NotificationProviderRuntimeAuthority,
	observedTelegramActivationMarker,
	persistTelegramActivationMarker,
	proposedTelegramIdentity,
	reconcileCommittedTelegramConfiguration,
	removeNotificationProvider,
	removeTelegramConfiguration,
	saveTelegramInactive,
	setGlobalNotificationsEnabled,
} from "./bus/notification-orchestration";
import {
	buildNotificationStatusReport,
	checkNotificationHealth,
	type DaemonHealth,
	type NotificationRecoveryReport,
	recoverNotifications,
	sanitizeProviderDiagnostic,
	sendNotificationTest,
} from "./bus/notification-service";
import type { NotificationSessionStatus } from "./bus/session-control";
import { ensureTelegramDaemonRunningDetailed, resolveTelegramSetupPreflight } from "./bus/telegram-daemon";
import { TelegramDaemonController } from "./bus/telegram-daemon-control";
import { runTelegramSetup, type TelegramSetupPreflight } from "./bus/telegram-setup";
import type {
	NotificationsEditorOperations,
	PreparedNotificationProviderConfiguration,
	PreparedTelegramConfiguration,
} from "./notification-setup-contract";

export interface NotificationsEditorAdapterContext {
	settings: Settings;
	session: Pick<AgentSession, "notificationSessionController">;
	sessionManager: Pick<SessionManager, "getCwd" | "getSessionId">;
	notifyConfigChanged?: () => Promise<void> | void;
}

type TelegramDaemonStopResult = {
	ok: boolean;
	message: string;
	before?: { health?: string };
};

export interface NotificationsEditorOperationDependencies {
	getNotificationConfig: typeof getNotificationConfig;
	getCurrentTelegramActivationMarker: typeof getCurrentTelegramActivationMarker;
	maskToken: typeof maskToken;
	buildNotificationStatusReport: typeof buildNotificationStatusReport;
	checkNotificationHealth: typeof checkNotificationHealth;
	sendNotificationTest: typeof sendNotificationTest;
	recoverNotifications: typeof recoverNotifications;
	ensureTelegramDaemonRunningDetailed: typeof ensureTelegramDaemonRunningDetailed;
	runTelegramSetup: typeof runTelegramSetup;
	resolveTelegramSetupPreflight: typeof resolveTelegramSetupPreflight;
	proposedTelegramIdentity: typeof proposedTelegramIdentity;
	reconcileCommittedTelegramConfiguration: typeof reconcileCommittedTelegramConfiguration;
	saveTelegramInactive: typeof saveTelegramInactive;
	removeTelegramConfiguration: typeof removeTelegramConfiguration;

	reloadTelegramDaemon(settings: Settings): Promise<{ ok: boolean; message: string }>;
	restartTelegramDaemon(settings: Settings): Promise<{ ok: boolean; message: string }>;
	stopTelegramDaemon(settings: Settings): Promise<TelegramDaemonStopResult>;
	providerRuntime?: NotificationProviderRuntimeAuthority;
}

const notificationEditorOperationDependencies: NotificationsEditorOperationDependencies = {
	getNotificationConfig,
	getCurrentTelegramActivationMarker,
	maskToken,
	buildNotificationStatusReport,
	checkNotificationHealth,
	sendNotificationTest,
	recoverNotifications,
	ensureTelegramDaemonRunningDetailed,
	runTelegramSetup,
	resolveTelegramSetupPreflight,
	proposedTelegramIdentity,
	reconcileCommittedTelegramConfiguration,
	saveTelegramInactive,
	removeTelegramConfiguration,

	reloadTelegramDaemon: async settings =>
		await new TelegramDaemonController(settings).reload({ spawnIfStopped: false }),
	restartTelegramDaemon: async settings =>
		await new TelegramDaemonController(settings).reload({ spawnIfStopped: true }),
	stopTelegramDaemon: async settings => await new TelegramDaemonController(settings).stop(),
};

function unavailableNotificationSessionStatus(): NotificationSessionStatus {
	return {
		eligible: false,
		locallyEnabled: true,
		genericSessionEnabled: false,
		genericEligibilitySource: "none",
		running: false,
	};
}

function unavailableNotificationSessionResult() {
	return { outcome: "disabled" as const, status: unavailableNotificationSessionStatus() };
}

/**
 * Shared local notification setup service for SDK callers and the Notifications settings tab.
 * Secrets remain in closure-owned WeakMaps; frozen drafts bind authority to prepared values.
 */
export function createNotificationsEditorOperations(
	ctx: NotificationsEditorAdapterContext,
	overrides: Partial<NotificationsEditorOperationDependencies> = {},
): NotificationsEditorOperations {
	const services = { ...notificationEditorOperationDependencies, ...overrides };
	const readConfig = () => {
		try {
			return services.getNotificationConfig(ctx.settings);
		} catch {
			throw new Error("Notification configuration is unavailable.");
		}
	};
	const sanitize = (text: string, token?: string): string => {
		try {
			return sanitizeProviderDiagnostic(text, readConfig(), token);
		} catch {
			return "Notification diagnostic unavailable.";
		}
	};
	const operationError = (error: unknown, token?: string): Error =>
		new Error(sanitize(error instanceof Error ? error.message : "Notification operation failed.", token));
	// Persisted daemon records are accepted verbatim by the service: an owner tag or
	// diagnostic string written by an older or foreign build can contain a configured
	// token or its fingerprint. The SDK surface is a secret-safe contract, so every
	// free-form daemon field is redacted here instead of being spread through.
	const redactDaemonHealth = (daemon: DaemonHealth): DaemonHealth => ({
		...daemon,
		ownerId: daemon.ownerId === undefined ? undefined : sanitize(daemon.ownerId),
	});
	const redactRecoveryDaemon = (
		daemon: NotificationRecoveryReport["daemon"],
	): NotificationRecoveryReport["daemon"] => ({
		...daemon,
		detail: sanitize(daemon.detail),
		ownerId: daemon.ownerId === undefined ? undefined : sanitize(daemon.ownerId),
		...(daemon.blockingReason === undefined ? {} : { blockingReason: sanitize(daemon.blockingReason) }),
		...(daemon.forceCommand === undefined ? {} : { forceCommand: sanitize(daemon.forceCommand) }),
	});
	const drafts = new WeakMap<
		PreparedTelegramConfiguration,
		{ token: string; activationAllowed: boolean; busy: boolean }
	>();
	const providerDrafts = new WeakMap<
		PreparedNotificationProviderConfiguration,
		{ botToken?: string; appToken?: string }
	>();
	const sessionContext = () => ({ sessionManager: ctx.sessionManager });
	const requireDurableConfig = () => {
		if (!ctx.settings.canPersistDurableConfig()) {
			throw new Error("Notification operations require writable durable settings.");
		}
	};
	const notifyAfterDurableCommit = async (): Promise<void> => {
		await ctx.notifyConfigChanged?.();
	};
	const reconnect = async () => await services.ensureTelegramDaemonRunningDetailed({ settings: ctx.settings });
	const telegramSetupPreflight = async (): Promise<TelegramSetupPreflight> =>
		await services.resolveTelegramSetupPreflight(ctx.settings);
	const providerRuntime: NotificationProviderRuntimeAuthority = services.providerRuntime ?? {
		activate: async provider => {
			if (provider === "telegram") {
				const result = await reconnect();
				if (result === "blocked_identity" || result === "disabled") {
					throw new Error("Telegram activation failed after the durable save.");
				}
				const reconciliation = await ctx.session.notificationSessionController?.reconcileCurrentSession(
					sessionContext(),
				);
				if (reconciliation?.outcome === "failed") throw new Error("Current-session reconciliation failed.");
				return;
			}
			const result = await new ChatDaemonController(ctx.settings, provider).ensure();
			if (result === "disabled") throw new Error(`${provider} activation failed after the durable save.`);
		},
		deactivate: async provider => {
			if (provider === "telegram") {
				const result = await services.stopTelegramDaemon(ctx.settings);
				if (!result.ok) throw new Error(result.message);
				const reconciliation = await ctx.session.notificationSessionController?.reconcileCurrentSession(
					sessionContext(),
				);
				if (reconciliation?.outcome === "failed") throw new Error("Current-session reconciliation failed.");
				return;
			}
			const result = await new ChatDaemonController(ctx.settings, provider).stop();
			if (!result.ok) throw new Error(result.message);
		},
	};

	return {
		loadState: async () => {
			const config = readConfig();
			const status = services.buildNotificationStatusReport(ctx.settings);
			const runtime = async (provider: NotificationProvider) => {
				const daemon =
					provider === "telegram"
						? await new TelegramDaemonController(ctx.settings).status()
						: await new ChatDaemonController(ctx.settings, provider).status();
				return daemon.health === "running" ? "ready" : daemon.health === "not_configured" ? "inactive" : "failed";
			};
			const [telegramRuntime, discordRuntime, slackRuntime] = await Promise.all([
				runtime("telegram"),
				runtime("discord"),
				runtime("slack"),
			]);
			status.telegram.runtime = telegramRuntime;
			status.discord.runtime = discordRuntime;
			status.slack.runtime = slackRuntime;
			return {
				status,
				session:
					ctx.session.notificationSessionController?.query(sessionContext()) ??
					unavailableNotificationSessionStatus(),
				preferences: {
					redact: config.redact,
					verbosity: config.verbosity,
					sessionScope: config.sessionScope,
					richEnabled: config.rich.enabled,
					richDraftEnabled: config.richDraft.enabled,
					toolActivityEnabled: config.toolActivity.enabled,
					streamingEnabled: config.streaming.enabled,
					sound: config.sound,
				},
			};
		},

		refreshHealth: async ({ probe, provider, signal }) => {
			if (signal?.aborted) throw new Error("Notification health refresh cancelled.");
			try {
				const input: Parameters<typeof checkNotificationHealth>[0] & { signal?: AbortSignal } = {
					settings: ctx.settings,
					stateRoot: path.join(ctx.sessionManager.getCwd(), ".gjc", "state"),
					probe,
					provider,
					signal,
				};
				const report = await services.checkNotificationHealth(input);
				if (signal?.aborted) throw new Error("Notification health refresh cancelled.");
				return {
					...report,
					checks: report.checks.map(check => ({
						...check,
						detail: sanitize(check.detail),
					})),
					daemon: redactDaemonHealth(report.daemon),
					reachability: {
						...report.reachability,
						detail: sanitize(report.reachability.detail),
					},
				};
			} catch (error) {
				throw operationError(error);
			}
		},

		sendTest: async provider => {
			requireDurableConfig();
			try {
				const result = await services.sendNotificationTest({
					settings: ctx.settings,
					provider,
					deps: {
						providerRuntimeStatus: async selected => {
							const status =
								selected === "telegram"
									? await new TelegramDaemonController(ctx.settings).status()
									: await new ChatDaemonController(ctx.settings, selected).status();
							return status.health === "running" ? "ready" : "inactive";
						},
					},
				});
				return {
					...result,
					detail: sanitize(result.detail),
				};
			} catch (error) {
				throw operationError(error);
			}
		},

		recover: async () => {
			requireDurableConfig();
			try {
				const result = await services.recoverNotifications({
					settings: ctx.settings,
					stateRoot: path.join(ctx.sessionManager.getCwd(), ".gjc", "state"),
				});
				return {
					...result,
					daemon: redactRecoveryDaemon(result.daemon),
				};
			} catch (error) {
				throw operationError(error);
			}
		},

		reconnect: async () => {
			requireDurableConfig();
			try {
				const result = await reconnect();
				const controller = ctx.session.notificationSessionController;
				if (result === "blocked_identity") {
					if (controller && !(await controller.enterBlockedRuntime(sessionContext()))) {
						throw new Error("Telegram identity was blocked, but the current runtime could not be fenced.");
					}
				} else if (result === "spawned" || result === "reloaded" || result === "attached") {
					await controller?.clearBlockedRuntime(sessionContext());
					const reconciliation = await controller?.reconcileCurrentSession(sessionContext());
					if (reconciliation?.outcome === "failed") {
						let fenced = false;
						try {
							fenced = (await controller?.enterBlockedRuntime(sessionContext())) === true;
						} catch {
							// Report the failure without claiming the runtime was fenced.
						}
						throw new Error(
							`Current-session reconciliation failed; runtime ${fenced ? "was fenced" : "could not be fenced"}.`,
						);
					}
				}
				return result;
			} catch (error) {
				throw operationError(error);
			}
		},

		preflightProposedIdentity: async (input, signal) => {
			requireDurableConfig();
			const token = input.token.consume();
			const unknownIdentity = { status: "unknown" as const };
			if (!token.trim()) {
				return {
					status: "error",
					identity: unknownIdentity,
					message: "Telegram bot token is required.",
				};
			}
			try {
				const setup = await services.runTelegramSetup({
					token,
					chatId: input.chatId,
					preflight: await telegramSetupPreflight(),
					revalidatePreflight: async () => await telegramSetupPreflight(),
					interactive: false,
					signal,
					deps: { fetchImpl: globalThis.fetch },
				});
				if (!setup.ok) {
					return {
						status: setup.status === "aborted" ? "aborted" : setup.status === "cancelled" ? "cancelled" : "error",
						identity: unknownIdentity,
						message: sanitize(setup.detail, token),
					};
				}
				if (signal.aborted) {
					return {
						status: "aborted",
						identity: unknownIdentity,
						message: "Telegram setup cancelled.",
					};
				}
				const identity = await services.proposedTelegramIdentity({
					settings: ctx.settings,
					botToken: token,
					chatId: setup.chatId,
					chatDisplay: setup.chatId,
				});
				if (signal.aborted) {
					return {
						status: "aborted",
						identity,
						message: "Telegram setup cancelled.",
					};
				}
				const draft: PreparedTelegramConfiguration = {
					chatId: setup.chatId,
					tokenMask: services.maskToken(token),
					tokenFingerprint: setup.tokenFingerprint,
					richEnabled: input.richEnabled,
					richDraftEnabled: input.richDraftEnabled,
					streamingEnabled: input.streamingEnabled,
				};
				Object.freeze(draft);
				drafts.set(draft, {
					token,
					activationAllowed: identity.status === "absent" || identity.status === "same",
					busy: false,
				});
				const pairingMessage =
					setup.pairingSource === "discovered"
						? "Telegram private chat discovered and validated."
						: setup.pairingSource === "reused"
							? "Stored Telegram private chat validated without polling."
							: "Supplied Telegram private chat validated.";
				return {
					status: "ready",
					identity,
					draft,
					pairingSource: setup.pairingSource,
					message:
						identity.status === "foreign" || identity.status === "unknown"
							? `${pairingMessage} Activation is blocked by the current daemon identity.`
							: pairingMessage,
				};
			} catch (error) {
				return {
					status: signal.aborted ? "aborted" : "error",
					identity: unknownIdentity,
					message: signal.aborted
						? "Telegram setup cancelled."
						: sanitize(error instanceof Error ? error.message : "Telegram setup failed.", token),
				};
			}
		},

		commitConfigure: async draft => {
			requireDurableConfig();
			const prepared = drafts.get(draft);
			if (!prepared || prepared.busy)
				throw new Error("The Telegram setup draft expired. Re-enter the masked bot token.");
			if (!prepared.activationAllowed)
				throw new Error("Telegram activation is blocked by the current daemon identity. Save inactive or cancel.");
			prepared.busy = true;
			const { token } = prepared;
			try {
				const identity = await services.proposedTelegramIdentity({
					settings: ctx.settings,
					botToken: token,
					chatId: draft.chatId,
				});
				if (drafts.get(draft) !== prepared)
					throw new Error("The Telegram setup draft expired. Re-enter the masked bot token.");
				if (identity.status !== "absent" && identity.status !== "same") {
					throw new Error(
						"Telegram activation is blocked by the current daemon identity. Save inactive or cancel.",
					);
				}
			} catch (error) {
				prepared.busy = false;
				throw operationError(error, token);
			}
			drafts.delete(draft);
			let receipt: SettingsAtomicReceipt | undefined;
			try {
				const inactiveMarkerToClear = observedTelegramActivationMarker(ctx.settings, token, draft.chatId);
				receipt = await ctx.settings.commitAtomicBatch([
					{ path: "notifications.enabled", op: "set", value: true },
					{ path: "notifications.telegram.botToken", op: "set", value: token },
					{ path: "notifications.telegram.chatId", op: "set", value: draft.chatId },
					{ path: "notifications.telegram.enabled", op: "set", value: true },
					{ path: "notifications.telegram.rich.enabled", op: "set", value: draft.richEnabled },
					{ path: "notifications.telegram.richDraft.enabled", op: "set", value: draft.richDraftEnabled },
					{ path: "notifications.telegram.streaming.enabled", op: "set", value: draft.streamingEnabled },
				]);
				const activationMarker = createTelegramActivationMarker({
					botToken: token,
					chatId: draft.chatId,
					state: "blocked",
					reason: "identity_mismatch",
				});
				const controller = ctx.session.notificationSessionController;
				const activation = await services.reconcileCommittedTelegramConfiguration({
					receipt,
					inactiveMarkerToClear,
					activation: {
						controller: controller
							? {
									enterBlockedRuntime: async () => await controller.enterBlockedRuntime(sessionContext()),
									clearBlockedRuntime: async () => await controller.clearBlockedRuntime(sessionContext()),
									reconcileCurrentSession: async () =>
										await controller.reconcileCurrentSession(sessionContext()),
								}
							: {
									enterBlockedRuntime: async () => undefined,
									clearBlockedRuntime: async () => undefined,
									reconcileCurrentSession: async () => unavailableNotificationSessionResult(),
								},
						reconnect,
						persistInactive: async marker => await persistTelegramActivationMarker(ctx.settings, marker),
						clearInactive: async marker => await clearTelegramActivationMarker(ctx.settings, marker),
						marker: activationMarker,
					},
				});
				let observerFailed = false;
				try {
					await notifyAfterDurableCommit();
				} catch {
					observerFailed = true;
				}
				if (activation.status === "blocked_identity") {
					return {
						status: "blocked_identity" as const,
						receipt,
						message: sanitize(
							`${activation.message}${observerFailed ? " The settings observer also failed after the durable commit." : ""}`,
							token,
						),
						restore: async () => {
							let restored: BlockedTelegramRestoreResult;
							try {
								restored = await activation.restore();
							} catch (error) {
								throw operationError(error, token);
							}
							if (
								restored.status === "restored" ||
								restored.status === "still_blocked" ||
								restored.status === "marker_blocked"
							) {
								try {
									await notifyAfterDurableCommit();
								} catch {
									return { ...restored, observerFailed: true as const };
								}
							}
							return restored;
						},
						retainCommitted: () => activation.retainCommitted(),
					};
				}
				if (activation.status === "activation_failed") {
					return {
						status: "activation_failed" as const,
						receipt,
						message: sanitize(
							`${activation.message}${observerFailed ? " The settings observer also failed after the durable commit." : ""}`,
							token,
						),
					};
				}
				if (observerFailed) {
					return {
						status: "observer_failed" as const,
						receipt,
						message: "Telegram configuration was saved and activated, but the settings observer failed.",
					};
				}
				return {
					status: "saved" as const,
					receipt,
					message: sanitize("Telegram configuration saved and reconciled.", token),
				};
			} catch (error) {
				if (receipt) {
					return {
						status: "activation_failed" as const,
						receipt,
						message: "Telegram configuration was saved, but post-commit activation failed.",
					};
				}
				throw operationError(error, token);
			}
		},

		saveInactive: async draft => {
			requireDurableConfig();
			const prepared = drafts.get(draft);
			if (!prepared || prepared.busy)
				throw new Error("The Telegram setup draft expired. Re-enter the masked bot token.");
			const { token } = prepared;
			drafts.delete(draft);
			try {
				const result = await services.saveTelegramInactive({
					settings: ctx.settings,
					botToken: token,
					chatId: draft.chatId,
				});
				const failures: string[] = [];
				let reconciliationFailed = false;
				const controller = ctx.session.notificationSessionController;
				if (controller) {
					try {
						const reconciliation = await controller.reconcileCurrentSession(sessionContext());
						if (reconciliation.outcome === "failed") throw new Error("Reconciliation failed.");
					} catch {
						reconciliationFailed = true;
						failures.push("current-session reconciliation failed");
						try {
							if (!(await controller.enterBlockedRuntime(sessionContext()))) throw new Error("Fencing failed.");
						} catch {
							failures.push("runtime fencing failed");
						}
					}
				}
				try {
					await notifyAfterDurableCommit();
				} catch {
					failures.push("settings observer failed");
				}
				if (failures.length) {
					return {
						status: reconciliationFailed ? ("reconciliation_failed" as const) : ("observer_failed" as const),
						receipt: result.receipt,
						message: `Telegram configuration was saved inactive, but ${failures.join(" and ")}.`,
					};
				}
				return {
					status: "saved_inactive" as const,
					receipt: result.receipt,
					message: "Telegram configuration saved inactive; no runtime activation was requested.",
				};
			} catch (error) {
				throw operationError(error, token);
			}
		},

		discardConfigureDraft: draft => {
			drafts.delete(draft);
		},

		prepareProviderConfiguration: async input => {
			requireDurableConfig();
			const cfg = readConfig();
			const consumeSecret = (action: typeof input.botToken): string | undefined => {
				if (!action.value) return undefined;
				const value = action.value.consume();
				return action.action === "replace" ? value : undefined;
			};
			const botToken = consumeSecret(input.botToken);
			const appToken = input.appToken ? consumeSecret(input.appToken) : undefined;
			if (input.botToken.action === "replace" && !botToken?.trim()) {
				throw new Error("A non-blank bot token replacement is required.");
			}
			if (input.provider === "slack" && input.appToken?.action === "replace" && !appToken?.trim()) {
				throw new Error("A non-blank Slack app token replacement is required.");
			}
			if (input.provider === "discord") {
				const applicationId = input.applicationId?.trim() || undefined;
				const guildId = input.guildId?.trim() || undefined;
				const parentChannelId = input.parentChannelId?.trim() || undefined;
				const resolvedApplicationId = applicationId ?? cfg.discord.applicationId;
				const resolvedGuildId = guildId ?? cfg.discord.guildId;
				const resolvedParentChannelId = parentChannelId ?? cfg.discord.parentChannelId;
				const removesSecret = input.botToken.action === "remove";
				if (!removesSecret && (!resolvedApplicationId || !resolvedGuildId || !resolvedParentChannelId)) {
					throw new Error("Discord application, guild, and parent channel IDs are required.");
				}
				if (!removesSecret && input.botToken.action === "keep" && !cfg.discord.botToken) {
					throw new Error("Discord has no stored bot token to keep.");
				}
				const draft: PreparedNotificationProviderConfiguration = {
					provider: "discord",
					botTokenDisposition: input.botToken.action,
					botTokenMask: maskToken(botToken ?? cfg.discord.botToken),
					...(applicationId === undefined ? {} : { applicationId }),
					...(guildId === undefined ? {} : { guildId }),
					...(parentChannelId === undefined ? {} : { parentChannelId }),
					applicationIdDisplay: resolvedApplicationId,
					guildIdDisplay: resolvedGuildId,
					parentChannelIdDisplay: resolvedParentChannelId,
				};
				Object.freeze(draft);
				providerDrafts.set(draft, { ...(botToken === undefined ? {} : { botToken }) });
				return draft;
			}
			const workspaceId = input.workspaceId?.trim() || undefined;
			const channelId = input.channelId?.trim() || undefined;
			const authorizedUserId = input.authorizedUserId?.trim() || undefined;
			const resolvedWorkspaceId = workspaceId ?? cfg.slack.workspaceId;
			const resolvedChannelId = channelId ?? cfg.slack.channelId;
			const resolvedAuthorizedUserId = authorizedUserId ?? cfg.slack.authorizedUserId;
			const appDisposition = input.appToken?.action ?? "keep";
			const removesSecret = input.botToken.action === "remove" || appDisposition === "remove";
			if (!removesSecret && (!resolvedWorkspaceId || !resolvedChannelId)) {
				throw new Error("Slack workspace and channel IDs are required.");
			}
			if (!removesSecret && input.botToken.action === "keep" && !cfg.slack.botToken) {
				throw new Error("Slack has no stored bot token to keep.");
			}
			if (!removesSecret && appDisposition === "keep" && !cfg.slack.appToken) {
				throw new Error("Slack has no stored app token to keep.");
			}
			const draft: PreparedNotificationProviderConfiguration = {
				provider: "slack",
				botTokenDisposition: input.botToken.action,
				botTokenMask: maskToken(botToken ?? cfg.slack.botToken),
				appTokenDisposition: appDisposition,
				appTokenMask: maskToken(appToken ?? cfg.slack.appToken),
				...(workspaceId === undefined ? {} : { workspaceId }),
				...(channelId === undefined ? {} : { channelId }),
				...(authorizedUserId === undefined ? {} : { authorizedUserId }),
				workspaceIdDisplay: resolvedWorkspaceId,
				channelIdDisplay: resolvedChannelId,
				authorizedUserIdDisplay: resolvedAuthorizedUserId,
			};
			Object.freeze(draft);
			providerDrafts.set(draft, {
				...(botToken === undefined ? {} : { botToken }),
				...(appToken === undefined ? {} : { appToken }),
			});
			return draft;
		},

		commitProviderConfiguration: async draft => {
			requireDurableConfig();
			const secrets = providerDrafts.get(draft);
			if (!secrets) {
				return {
					outcome: "failed",
					code: "invalid_draft",
					message: "The provider setup draft expired or was not prepared by this service.",
				};
			}
			// Claim the one-shot authority before yielding to persistence or runtime work.
			providerDrafts.delete(draft);
			try {
				let mutation: NotificationProviderConfigurationMutation;
				if (draft.provider === "discord") {
					mutation = {
						provider: "discord",
						botToken:
							draft.botTokenDisposition === "replace"
								? { action: "replace", value: secrets.botToken ?? "" }
								: { action: draft.botTokenDisposition },
						applicationId: draft.applicationId,
						guildId: draft.guildId,
						parentChannelId: draft.parentChannelId,
					};
				} else {
					const appDisposition = draft.appTokenDisposition ?? "keep";
					mutation = {
						provider: "slack",
						botToken:
							draft.botTokenDisposition === "replace"
								? { action: "replace", value: secrets.botToken ?? "" }
								: { action: draft.botTokenDisposition },
						appToken:
							appDisposition === "replace"
								? { action: "replace", value: secrets.appToken ?? "" }
								: { action: appDisposition },
						workspaceId: draft.workspaceId,
						channelId: draft.channelId,
						authorizedUserId: draft.authorizedUserId,
					};
				}
				const removesSecret = draft.botTokenDisposition === "remove" || draft.appTokenDisposition === "remove";
				const result = await mutateNotificationProvider({
					settings: ctx.settings,
					mutation,
					configureAndActivate: !removesSecret,
					...(removesSecret ? { desiredEnabled: false } : {}),
					notifyConfigChanged: notifyAfterDurableCommit,
					runtime: providerRuntime,
				});
				const outcome =
					result.status === "commit_failed"
						? "failed"
						: result.status === "activation_failed" ||
								result.status === "deactivation_failed" ||
								result.observerFailed
							? "degraded"
							: "success";
				const observerSuffix =
					result.status !== "commit_failed" && result.observerFailed
						? " The settings observer also failed after the durable commit."
						: "";
				return {
					...(result.status === "commit_failed" ? {} : { receipt: result.receipt }),
					outcome,
					message:
						(result.status === "activated"
							? `${draft.provider} configuration saved and activated.`
							: result.status === "activation_failed"
								? `${draft.provider} configuration and desired intent were saved, but runtime activation failed.`
								: result.status === "deactivation_failed"
									? `${draft.provider} desired-off configuration was saved, but runtime deactivation failed.`
									: result.status === "commit_failed"
										? `${draft.provider} configuration was not saved because the CAS commit failed.`
										: `${draft.provider} configuration saved.`) + observerSuffix,
				};
			} finally {
				providerDrafts.delete(draft);
			}
		},

		discardProviderConfiguration: draft => {
			providerDrafts.delete(draft);
		},

		setProviderDesired: async (provider, enabled) => {
			requireDurableConfig();
			if (provider === "telegram" && enabled) {
				const config = readConfig();
				if (services.getCurrentTelegramActivationMarker(config)) {
					return {
						outcome: "failed",
						message:
							"Telegram remains inactive because its exact activation marker must be restored or cleared after safe owner readiness.",
					};
				}
			}
			const mutation: NotificationProviderConfigurationMutation =
				provider === "telegram"
					? { provider, botToken: { action: "keep" } }
					: provider === "discord"
						? { provider, botToken: { action: "keep" } }
						: { provider, botToken: { action: "keep" }, appToken: { action: "keep" } };
			const result = await mutateNotificationProvider({
				settings: ctx.settings,
				mutation,
				desiredEnabled: enabled,
				notifyConfigChanged: notifyAfterDurableCommit,
				runtime: providerRuntime,
			});
			const outcome =
				result.status === "commit_failed"
					? "failed"
					: result.status === "activation_failed" ||
							result.status === "deactivation_failed" ||
							result.observerFailed
						? "degraded"
						: "success";
			return {
				...(result.status === "commit_failed" ? {} : { receipt: result.receipt }),
				outcome,
				message:
					(result.status === "activation_failed"
						? `${provider} desired intent was saved, but activation failed.`
						: result.status === "deactivation_failed"
							? `${provider} desired-off intent was saved, but deactivation failed.`
							: result.status === "commit_failed"
								? `${provider} desired intent was not saved because the CAS commit failed.`
								: `${provider} desired intent ${enabled ? "enabled" : "disabled"}.`) +
					(result.status !== "commit_failed" && result.observerFailed
						? " The settings observer also failed after the durable commit."
						: ""),
			};
		},

		removeProvider: async provider => {
			requireDurableConfig();
			if (provider === "telegram") {
				return { message: "Use the Telegram removal action to preserve root-registration fencing." };
			}
			const result = await removeNotificationProvider({
				settings: ctx.settings,
				provider,
				runtime: providerRuntime,
				notifyConfigChanged: notifyAfterDurableCommit,
			});
			const degraded =
				result.status === "deactivation_failed" || ("observerFailed" in result && result.observerFailed);
			return {
				...("receipt" in result && result.receipt ? { receipt: result.receipt } : {}),
				outcome:
					result.status === "commit_failed" || result.status === "commit_failed_after_teardown"
						? "failed"
						: degraded
							? "degraded"
							: "success",
				message:
					(result.status === "removed"
						? `${provider} configuration removed.`
						: result.status === "deactivation_failed"
							? `${provider} configuration was removed, but runtime deactivation failed.`
							: `${provider} configuration removal failed.`) +
					("observerFailed" in result && result.observerFailed
						? " The settings observer also failed after the durable commit."
						: ""),
			};
		},

		enableGlobally: async () => {
			requireDurableConfig();
			const result = await setGlobalNotificationsEnabled({
				settings: ctx.settings,
				enabled: true,
				notifyConfigChanged: notifyAfterDurableCommit,
				runtime: providerRuntime,
			});
			const degraded =
				result.status === "global_activation_partial" || ("observerFailed" in result && result.observerFailed);
			return {
				...(result.status === "commit_failed" ? {} : { receipt: result.receipt }),
				outcome: result.status === "commit_failed" ? "failed" : degraded ? "degraded" : "success",
				message:
					(result.status === "global_activation_partial"
						? `Global notifications were enabled, but activation failed for ${result.failed.join(", ")}.`
						: result.status === "commit_failed"
							? "Global notifications were not enabled because the CAS commit failed."
							: "Global notifications enabled using stored provider intent.") +
					(result.status !== "commit_failed" && result.observerFailed
						? " The settings observer also failed after the durable commit."
						: ""),
			};
		},

		disableGlobally: async () => {
			requireDurableConfig();
			const result = await setGlobalNotificationsEnabled({
				settings: ctx.settings,
				enabled: false,
				notifyConfigChanged: notifyAfterDurableCommit,
				runtime: providerRuntime,
			});
			const degraded =
				result.status === "global_deactivation_partial" || ("observerFailed" in result && result.observerFailed);
			return {
				...(result.status === "commit_failed" ? {} : { receipt: result.receipt }),
				outcome: result.status === "commit_failed" ? "failed" : degraded ? "degraded" : "success",
				message:
					(result.status === "global_deactivation_partial"
						? `Global notifications were disabled, but teardown failed for ${result.failed.join(", ")}.`
						: result.status === "commit_failed"
							? "Global notifications were not disabled because the CAS commit failed."
							: "Global notifications disabled; provider configuration and desired intent were preserved.") +
					(result.status !== "commit_failed" && result.observerFailed
						? " The settings observer also failed after the durable commit."
						: ""),
			};
		},

		removeTelegram: async () => {
			requireDurableConfig();
			const controller = ctx.session.notificationSessionController;
			let runtimePrepared = false;
			try {
				const result = await services.removeTelegramConfiguration({
					settings: ctx.settings,
					removal: {
						stopAndUnregister: async () => {
							if (controller && !(await controller.enterBlockedRuntime(sessionContext()))) {
								throw new Error("Telegram removal failed because the current runtime could not be fenced.");
							}
							runtimePrepared = true;
							const stopped = await services.stopTelegramDaemon(ctx.settings);
							if (!stopped.ok) throw new Error(stopped.message);
						},
					},
				});
				const postCommitFailures: string[] = [];
				if (runtimePrepared && controller) {
					try {
						await controller.clearBlockedRuntime(sessionContext());
						const reconciliation = await controller.reconcileCurrentSession(sessionContext());
						if (reconciliation.outcome === "failed")
							postCommitFailures.push("current-session reconciliation failed");
					} catch {
						postCommitFailures.push("current-session reconciliation failed");
					}
					if (postCommitFailures.length > 0) {
						try {
							const fenced = await controller.enterBlockedRuntime(sessionContext());
							postCommitFailures.push(fenced ? "current runtime fenced" : "current runtime could not be fenced");
						} catch {
							postCommitFailures.push("current runtime could not be fenced");
						}
					}
				}
				try {
					await notifyAfterDurableCommit();
				} catch {
					postCommitFailures.push("settings observer failed");
				}
				return {
					receipt: result.receipt,
					outcome: postCommitFailures.length === 0 ? "success" : "degraded",
					globallyDisabled: result.globallyDisabled,
					message: `Telegram configuration removed without changing the global master.${
						postCommitFailures.length === 0 ? "" : ` Post-commit ${postCommitFailures.join(" and ")}.`
					}`,
				};
			} catch (error) {
				if (runtimePrepared) {
					const restored = await reconnect();
					if (restored !== "blocked_identity" && controller) {
						await controller.clearBlockedRuntime(sessionContext());
						const reconciliation = await controller.reconcileCurrentSession(sessionContext());
						if (reconciliation.outcome === "failed") {
							let fenced = false;
							try {
								fenced = await controller.enterBlockedRuntime(sessionContext());
							} catch {
								// Preserve the original removal failure and report unsuccessful fencing.
							}
							throw operationError(
								new Error(
									`Telegram removal failed and current-session reconciliation failed; runtime ${fenced ? "was fenced" : "could not be fenced"}.`,
								),
							);
						}
					}
				}
				throw operationError(error);
			}
		},

		setSessionLocal: async enabled => {
			const controller = ctx.session.notificationSessionController;
			if (!controller) return unavailableNotificationSessionResult();
			requireDurableConfig();
			try {
				return await controller.setLocalEnabled(sessionContext(), enabled);
			} catch (error) {
				throw operationError(error);
			}
		},

		commitPreferences: async preferences => {
			requireDurableConfig();
			let daemonWasRunningForDisable = false;
			try {
				const before = readConfig();
				const disablingToolActivity =
					isProviderEffectivelyEnabled(before, "telegram") &&
					isTelegramComplete(before) &&
					before.toolActivity.enabled &&
					!preferences.toolActivityEnabled;
				if (disablingToolActivity) {
					const stopped = await services.stopTelegramDaemon(ctx.settings);
					if (!stopped.ok)
						throw new Error(
							`Notification preferences were not saved because daemon stop failed: ${stopped.message}`,
						);
					daemonWasRunningForDisable = stopped.before?.health === "running";
				}

				let receipt: SettingsAtomicReceipt;
				try {
					receipt = await ctx.settings.commitAtomicBatch([
						{ path: "notifications.redact", op: "set", value: preferences.redact },
						{ path: "notifications.verbosity", op: "set", value: preferences.verbosity },
						{ path: "notifications.sessionScope", op: "set", value: preferences.sessionScope },
						{ path: "notifications.telegram.sound", op: "set", value: preferences.sound },
						{ path: "notifications.telegram.rich.enabled", op: "set", value: preferences.richEnabled },
						{ path: "notifications.telegram.richDraft.enabled", op: "set", value: preferences.richDraftEnabled },
						{ path: "notifications.telegram.streaming.enabled", op: "set", value: preferences.streamingEnabled },
						{
							path: "notifications.telegram.toolActivity.enabled",
							op: "set",
							value: preferences.toolActivityEnabled,
						},
					]);
				} catch (error) {
					if (daemonWasRunningForDisable) {
						try {
							const restarted = await services.restartTelegramDaemon(ctx.settings);
							if (!restarted.ok) throw new Error(restarted.message);
						} catch (restartError) {
							const commitMessage = error instanceof Error ? error.message : String(error);
							const restartMessage = restartError instanceof Error ? restartError.message : String(restartError);
							throw new Error(
								`Notification preference commit failed (${commitMessage}) and daemon restart failed (${restartMessage}).`,
								{ cause: new AggregateError([error, restartError]) },
							);
						}
					}
					throw error;
				}

				const postCommitFailures: string[] = [];
				const config = readConfig();
				if (isProviderEffectivelyEnabled(config, "telegram") && isTelegramComplete(config)) {
					try {
						const reload = daemonWasRunningForDisable
							? await services.restartTelegramDaemon(ctx.settings)
							: await services.reloadTelegramDaemon(ctx.settings);
						if (!reload.ok) {
							postCommitFailures.push(
								`daemon reload failed: ${sanitizeProviderDiagnostic(reload.message, config)}`,
							);
						}
					} catch {
						postCommitFailures.push("daemon reload failed");
					}
				}
				try {
					await notifyAfterDurableCommit();
				} catch {
					postCommitFailures.push("settings observer failed");
				}
				return {
					receipt,
					outcome: postCommitFailures.length === 0 ? "success" : "degraded",
					message:
						postCommitFailures.length === 0
							? "Notification preferences saved atomically."
							: `Notification preferences were saved, but post-commit ${postCommitFailures.join(" and ")}.`,
				};
			} catch (error) {
				throw operationError(error);
			}
		},

		reconcileCurrentSession: async () => {
			const controller = ctx.session.notificationSessionController;
			if (!controller) return unavailableNotificationSessionResult();
			requireDurableConfig();
			try {
				return await controller.reconcileCurrentSession(sessionContext());
			} catch (error) {
				throw operationError(error);
			}
		},
	};
}

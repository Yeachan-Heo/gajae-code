import * as path from "node:path";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { getOAuthProviders } from "@gajae-code/ai/utils/oauth";
import type { OAuthProvider } from "@gajae-code/ai/utils/oauth/types";
import type { Component, OverlayHandle, SlashCommand } from "@gajae-code/tui";
import { Input, isPetMode, Loader, Spacer, Text } from "@gajae-code/tui";
import { getAgentDbPath, getProjectDir, logger, VERSION } from "@gajae-code/utils";
import type { AppKeybinding } from "../../config/keybindings";
import {
	activateModelProfile,
	type MaterializeModelProfileForDeletionResult,
	materializeActiveModelProfileAssignment,
	materializeActiveModelProfileAssignments,
	materializeModelProfileForDeletion,
	restoreMaterializedModelProfileForDeletion,
} from "../../config/model-profile-activation";
import { formatModelProfileDisplayLabel, recommendModelProfileForProvider } from "../../config/model-profiles";
import { GJC_MODEL_ASSIGNMENT_TARGETS, type GjcModelAssignmentTargetId } from "../../config/model-registry";
import { formatModelSelectorValue } from "../../config/model-resolver";
import { selectorHead } from "../../config/model-selector-value";
import type { ModelProfileConfig } from "../../config/models-config-schema";
import { type Settings, type SettingsAtomicReceipt, settings } from "../../config/settings";
import { DebugSelectorComponent } from "../../debug";
import { disableProvider, enableProvider } from "../../discovery";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../../extensibility/plugins/marketplace";
import { INTERACTIVE_SELECTOR_RESUME_ORIGIN } from "../../extensibility/shared-events";
import {
	getAvailableThemes,
	getCurrentThemeName,
	getDetectedThemeSettingsPath,
	getSymbolTheme,
	previewTheme,
	restoreThemePreview,
	setColorBlindMode,
	setSymbolPreset,
	setTheme,
	theme,
} from "../../modes/theme/theme";
import {
	clearInteractiveActivityLoaders,
	type InteractiveModeContext,
	type OAuthSelectorOptions,
	stopInteractiveActivityIndicator,
	suspendInteractiveActivityIndicator,
} from "../../modes/types";
import { ChatDaemonController } from "../../sdk/bus/chat-daemon-control";
import {
	getCurrentTelegramActivationMarker,
	getNotificationConfig,
	isProviderEffectivelyEnabled,
	isTelegramComplete,
	maskToken,
	type NotificationProvider,
} from "../../sdk/bus/config";
import {
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
} from "../../sdk/bus/notification-orchestration";
import {
	buildNotificationStatusReport,
	checkNotificationHealth,
	recoverNotifications,
	sanitizeDiagnostic,
	sendNotificationTest,
} from "../../sdk/bus/notification-service";
import type { NotificationSessionStatus } from "../../sdk/bus/session-control";
import {
	ensureTelegramDaemonRunningDetailed,
	readNotificationRootRegistration,
	resolveTelegramSetupPreflight,
	unregisterNotificationRoot,
	withNotificationRootRegistryFence,
} from "../../sdk/bus/telegram-daemon";
import { TelegramDaemonController } from "../../sdk/bus/telegram-daemon-control";
import { runTelegramSetup, type TelegramSetupPreflight } from "../../sdk/bus/telegram-setup";
import { type SessionInfo, SessionManager } from "../../session/session-manager";
import { getTreeForInternalRead } from "../../session/session-manager-internal";

import { FileSessionStorage } from "../../session/session-storage";
import {
	CREDENTIAL_AUTO_IMPORT_DISCOVERY_WARNING,
	CREDENTIAL_AUTO_IMPORT_PERSISTENCE_WARNING,
	CREDENTIAL_AUTO_IMPORT_REFRESH_WARNING,
	CREDENTIAL_AUTO_IMPORT_RETRY_WARNING,
	CREDENTIAL_AUTO_IMPORT_ROTATION_WARNING,
	CREDENTIAL_AUTO_IMPORT_STATE_UNREADABLE_WARNING,
	type CredentialAutoImportStateReadResult,
	type CredentialAutoImportStateStore,
	createCredentialAutoImportStateStore,
	formatCredentialAutoImportCandidateLabel,
	formatCredentialAutoImportPrompt,
	isCredentialAutoImportStateResolvedForVersion,
	logCredentialAutoImportFailures,
	runExternalCredentialAutoImport,
} from "../../setup/credential-auto-import";
import {
	filterAutoImportOAuthCredentials,
	formatDiscoverySummary,
	type ImportableCredential,
} from "../../setup/credential-import";
import {
	MODEL_ONBOARDING_API_PROVIDER_COMMAND,
	MODEL_ONBOARDING_PROVIDER_PRESET_COMMAND,
	MODEL_ONBOARDING_SETUP_COMMAND,
} from "../../setup/model-onboarding-guidance";
import { addApiCompatibleProvider, formatProviderSetupResult } from "../../setup/provider-onboarding";
import {
	IMAGE_PROVIDER_DEFAULTS,
	isConfigurableSearchProviderId,
	isSearchProviderPreference,
	setConfiguredImageModel,
	setPreferredImageProvider,
	setPreferredSearchProvider,
	setSearchFallbackProviders,
	setSearchHardTimeoutMs,
} from "../../tools";
import { copyToClipboard } from "../../utils/clipboard";
import { setSessionTerminalTitle } from "../../utils/title-generator";
import { AgentDashboard } from "../components/agent-dashboard";
import { AssistantMessageComponent } from "../components/assistant-message";
import {
	type CommandPaletteAction,
	CommandPaletteComponent,
	type CommandPaletteEntry,
} from "../components/command-palette";
import {
	CustomModelPresetWizardComponent,
	type CustomModelPresetWizardSubmit,
} from "../components/custom-model-preset-wizard";
import { CustomProviderWizardComponent, type CustomProviderWizardSubmit } from "../components/custom-provider-wizard";
import { ExtensionDashboard } from "../components/extensions";
import type { PetMode } from "../components/gajae-pet-widget";
import { HistorySearchComponent } from "../components/history-search";
import { HookSelectorComponent } from "../components/hook-selector";
import { JobsOverlayComponent } from "../components/jobs-overlay";
import { ModelSelectorComponent } from "../components/model-selector";
import type {
	NotificationsEditorOperations,
	PreparedNotificationProviderConfiguration,
	PreparedTelegramConfiguration,
} from "../components/notifications-settings-editor";
import { OAuthSelectorComponent } from "../components/oauth-selector";
import { isPetAvailable } from "../components/pet-capability";
import { PetSelectorComponent } from "../components/pet-selector";
import {
	type PlanPreviewOptions,
	PlanPreviewOverlay,
	type PlanPreviewResult,
} from "../components/plan-preview-overlay";

import { PluginSelectorComponent } from "../components/plugin-selector";
import {
	type ProviderOnboardingAction,
	ProviderOnboardingSelectorComponent,
} from "../components/provider-onboarding-selector";
import { SessionObserverOverlayComponent } from "../components/session-observer-overlay";
import { SessionSelectorComponent } from "../components/session-selector";
import { dashboardSessions, SessionsDashboardComponent } from "../components/sessions-dashboard";
import { SettingsSelectorComponent } from "../components/settings-selector";
import { TasksPaneComponent } from "../components/tasks-pane";
import { ThemeSelectorComponent } from "../components/theme-selector";
import { ThinkingSelectorComponent } from "../components/thinking-selector";
import { ToolExecutionComponent } from "../components/tool-execution";
import type { StatusLineSettings } from "../components/tool-status-header";
import { TranscriptViewerOverlay, transcriptViewerEntries } from "../components/transcript-viewer-overlay";
import { TreeSelectorComponent } from "../components/tree-selector";
import { UserMessageSelectorComponent } from "../components/user-message-selector";
import type { JobsObserver } from "../jobs-observer";
import type { SessionObserverRegistry } from "../session-observer-registry";
import type { TasksAggregator } from "../tasks-aggregator";
import type { TranscriptItemRegistry } from "../transcript-item-registry";
import { acquireResumeProgressLease, type ResumeProgressLease } from "../utils/ui-helpers";

const CALLBACK_SERVER_PROVIDERS = new Set<string>([
	"anthropic",
	"openai-codex",
	"gitlab-duo",
	"google-gemini-cli",
	"google-antigravity",
	"xai",
	"grok-build",
]);

const MANUAL_LOGIN_TIP = "Tip: You can complete pairing with /login <redirect URL>.";

/** Providers whose authorization server can display a code for `/login <provider> --manual`. */
const MANUAL_CODE_PROVIDERS = new Set<string>(["anthropic"]);

const MANUAL_CODE_LOGIN_TIP = "Tip: You can complete pairing with /login <code>.";

function isThemePreviewSuperseded(result: { success: boolean; error?: string }): boolean {
	return !result.success && result.error?.includes("superseded by a newer request") === true;
}

/**
 * Snapshot the persisted status-line settings that the status-line component
 * cares about. Preview, cancel-restore, and commit paths all share this so the
 * previewed row count (and every other field) can never drift out of sync.
 */
export function buildStatusLineSettings(settingsInstance: Settings): StatusLineSettings {
	return {
		preset: settingsInstance.get("statusLine.preset"),
		leftSegments: settingsInstance.get("statusLine.leftSegments"),
		rightSegments: settingsInstance.get("statusLine.rightSegments"),
		separator: settingsInstance.get("statusLine.separator"),
		showHookStatus: settingsInstance.get("statusLine.showHookStatus"),
		sessionAccent: settingsInstance.get("statusLine.sessionAccent"),
		maxRows: settingsInstance.get("statusLine.maxRows"),
		segmentOptions: settingsInstance.get("statusLine.segmentOptions"),
	};
}

function formatProviderOnboardingCommandGuide(): string {
	return [
		"Provider preset setup:",
		MODEL_ONBOARDING_PROVIDER_PRESET_COMMAND,
		"Custom API-compatible provider setup:",
		MODEL_ONBOARDING_API_PROVIDER_COMMAND,
		MODEL_ONBOARDING_SETUP_COMMAND,
	].join("\n");
}

export interface NotificationsEditorAdapterContext {
	settings: Settings;
	session: Pick<InteractiveModeContext["session"], "notificationSessionController">;
	sessionManager: Pick<InteractiveModeContext["sessionManager"], "getCwd" | "getSessionId">;
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
	sanitizeDiagnostic: typeof sanitizeDiagnostic;
	ensureTelegramDaemonRunningDetailed: typeof ensureTelegramDaemonRunningDetailed;
	runTelegramSetup: typeof runTelegramSetup;
	resolveTelegramSetupPreflight: typeof resolveTelegramSetupPreflight;
	proposedTelegramIdentity: typeof proposedTelegramIdentity;
	reconcileCommittedTelegramConfiguration: typeof reconcileCommittedTelegramConfiguration;
	saveTelegramInactive: typeof saveTelegramInactive;
	removeTelegramConfiguration: typeof removeTelegramConfiguration;
	readNotificationRootRegistration: typeof readNotificationRootRegistration;
	unregisterNotificationRoot: typeof unregisterNotificationRoot;
	stopTelegramDaemonIfRootRegistryFenceMatches(input: {
		settings: Settings;
		registryFingerprint: string;
		stop: () => Promise<TelegramDaemonStopResult>;
	}): Promise<boolean>;

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
	sanitizeDiagnostic,
	ensureTelegramDaemonRunningDetailed,
	runTelegramSetup,
	resolveTelegramSetupPreflight,
	proposedTelegramIdentity,
	reconcileCommittedTelegramConfiguration,
	saveTelegramInactive,
	removeTelegramConfiguration,
	readNotificationRootRegistration,
	unregisterNotificationRoot,
	stopTelegramDaemonIfRootRegistryFenceMatches: async input =>
		await withNotificationRootRegistryFence({
			settings: input.settings,
			registryFingerprint: input.registryFingerprint,
			action: async () => {
				const stopped = await input.stop();
				if (!stopped.ok) throw new Error(stopped.message);
			},
		}),

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

function notificationOperationError(
	services: NotificationsEditorOperationDependencies,
	error: unknown,
	token?: string,
): Error {
	return new Error(
		services.sanitizeDiagnostic(error instanceof Error ? error.message : "Notification operation failed.", token),
	);
}

/**
 * Concrete service adapter for the direct Notifications settings tab. Secrets remain in this closure's
 * WeakMap and are never exposed through the editor's safe draft contract.
 */
export function createNotificationsEditorOperations(
	ctx: NotificationsEditorAdapterContext,
	overrides: Partial<NotificationsEditorOperationDependencies> = {},
): NotificationsEditorOperations {
	const services = { ...notificationEditorOperationDependencies, ...overrides };
	const drafts = new WeakMap<PreparedTelegramConfiguration, string>();
	const providerDrafts = new WeakMap<
		PreparedNotificationProviderConfiguration,
		{ botToken?: string; appToken?: string }
	>();
	const sessionContext = () => ({ sessionManager: ctx.sessionManager });
	const notifyAfterDurableCommit = async (): Promise<void> => {
		await ctx.notifyConfigChanged?.();
	};
	const reconnect = async () =>
		await services.ensureTelegramDaemonRunningDetailed({
			settings: ctx.settings,
			cwd: ctx.sessionManager.getCwd(),
			sessionId: ctx.sessionManager.getSessionId(),
		});
	const telegramSetupPreflight = async (): Promise<TelegramSetupPreflight> =>
		await services.resolveTelegramSetupPreflight(ctx.settings);
	const providerRuntime: NotificationProviderRuntimeAuthority = services.providerRuntime ?? {
		activate: async provider => {
			if (provider === "telegram") {
				const result = await reconnect();
				if (result === "blocked_identity" || result === "disabled") {
					throw new Error("Telegram activation failed after the durable save.");
				}
				await ctx.session.notificationSessionController?.reconcileCurrentSession(sessionContext());
				return;
			}
			const result = await new ChatDaemonController(ctx.settings, provider).ensure();
			if (result === "disabled") throw new Error(`${provider} activation failed after the durable save.`);
		},
		deactivate: async provider => {
			if (provider === "telegram") {
				const result = await services.stopTelegramDaemon(ctx.settings);
				if (!result.ok) throw new Error(result.message);
				await ctx.session.notificationSessionController?.reconcileCurrentSession(sessionContext());
				return;
			}
			const result = await new ChatDaemonController(ctx.settings, provider).stop();
			if (!result.ok) throw new Error(result.message);
		},
	};

	return {
		loadState: async () => {
			const config = services.getNotificationConfig(ctx.settings);
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
				const token = services.getNotificationConfig(ctx.settings).botToken;
				return {
					...report,
					checks: report.checks.map(check => ({
						...check,
						detail: services.sanitizeDiagnostic(check.detail, token),
					})),
					reachability: {
						...report.reachability,
						detail: services.sanitizeDiagnostic(report.reachability.detail, token),
					},
				};
			} catch (error) {
				throw notificationOperationError(services, error, services.getNotificationConfig(ctx.settings).botToken);
			}
		},

		sendTest: async provider => {
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
					detail: services.sanitizeDiagnostic(
						result.detail,
						services.getNotificationConfig(ctx.settings).botToken,
					),
				};
			} catch (error) {
				throw notificationOperationError(services, error, services.getNotificationConfig(ctx.settings).botToken);
			}
		},

		recover: async () => {
			try {
				const result = await services.recoverNotifications({
					settings: ctx.settings,
					stateRoot: path.join(ctx.sessionManager.getCwd(), ".gjc", "state"),
				});
				return {
					...result,
					daemon: {
						...result.daemon,
						detail: services.sanitizeDiagnostic(
							result.daemon.detail,
							services.getNotificationConfig(ctx.settings).botToken,
						),
					},
				};
			} catch (error) {
				throw notificationOperationError(services, error, services.getNotificationConfig(ctx.settings).botToken);
			}
		},

		reconnect: async () => {
			try {
				const result = await reconnect();
				const controller = ctx.session.notificationSessionController;
				if (result === "blocked_identity") {
					await controller?.enterBlockedRuntime(sessionContext());
				} else if (result === "spawned" || result === "reloaded" || result === "attached") {
					await controller?.clearBlockedRuntime(sessionContext());
					await controller?.reconcileCurrentSession(sessionContext());
				}
				return result;
			} catch (error) {
				throw notificationOperationError(services, error, services.getNotificationConfig(ctx.settings).botToken);
			}
		},

		preflightProposedIdentity: async (input, signal) => {
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
						message: services.sanitizeDiagnostic(setup.detail, token),
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
				drafts.set(draft, token);
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
						: services.sanitizeDiagnostic(
								error instanceof Error ? error.message : "Telegram setup failed.",
								token,
							),
				};
			}
		},

		commitConfigure: async draft => {
			const token = drafts.get(draft);
			if (!token) throw new Error("The Telegram setup draft expired. Re-enter the masked bot token.");
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
				drafts.delete(draft);
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
									reconcileCurrentSession: async () => undefined,
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
						message: services.sanitizeDiagnostic(
							`${activation.message}${observerFailed ? " The settings observer also failed after the durable commit." : ""}`,
							token,
						),
						restore: async () => {
							const restored = await activation.restore();
							if (restored.status === "restored" || restored.status === "still_blocked") {
								await notifyAfterDurableCommit();
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
						message: services.sanitizeDiagnostic(
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
					message: services.sanitizeDiagnostic("Telegram configuration saved and reconciled.", token),
				};
			} catch (error) {
				if (receipt) {
					return {
						status: "activation_failed" as const,
						receipt,
						message: "Telegram configuration was saved, but post-commit activation failed.",
					};
				}
				throw notificationOperationError(services, error, token);
			}
		},

		saveInactive: async draft => {
			const token = drafts.get(draft);
			if (!token) throw new Error("The Telegram setup draft expired. Re-enter the masked bot token.");
			try {
				const result = await services.saveTelegramInactive({
					settings: ctx.settings,
					botToken: token,
					chatId: draft.chatId,
				});
				drafts.delete(draft);
				try {
					await notifyAfterDurableCommit();
				} catch {
					return {
						status: "observer_failed" as const,
						receipt: result.receipt,
						message: "Telegram configuration was saved inactive, but the settings observer failed.",
					};
				}
				return {
					status: "saved_inactive" as const,
					receipt: result.receipt,
					message: "Telegram configuration saved inactive; no runtime activation was requested.",
				};
			} catch (error) {
				throw notificationOperationError(services, error, token);
			}
		},

		discardConfigureDraft: draft => {
			drafts.delete(draft);
		},

		prepareProviderConfiguration: async input => {
			const cfg = services.getNotificationConfig(ctx.settings);
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
			providerDrafts.set(draft, {
				...(botToken === undefined ? {} : { botToken }),
				...(appToken === undefined ? {} : { appToken }),
			});
			return draft;
		},

		commitProviderConfiguration: async draft => {
			const secrets = providerDrafts.get(draft) ?? {};
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
			if (provider === "telegram" && enabled) {
				const config = services.getNotificationConfig(ctx.settings);
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
			const controller = ctx.session.notificationSessionController;
			let runtimePrepared = false;
			try {
				const result = await services.removeTelegramConfiguration({
					settings: ctx.settings,
					removal: {
						stopAndUnregister: async () => {
							if (controller) await controller.enterBlockedRuntime(sessionContext());
							runtimePrepared = true;
							const registration = await services.readNotificationRootRegistration({
								settings: ctx.settings,
								sessionId: ctx.sessionManager.getSessionId(),
							});
							const unregistered = await services.unregisterNotificationRoot({
								settings: ctx.settings,
								cwd: ctx.sessionManager.getCwd(),
								sessionId: ctx.sessionManager.getSessionId(),
								registrationToken: registration.token,
							});
							if (unregistered.registryFingerprint !== undefined) {
								await services.stopTelegramDaemonIfRootRegistryFenceMatches({
									settings: ctx.settings,
									registryFingerprint: unregistered.registryFingerprint,
									stop: () => services.stopTelegramDaemon(ctx.settings),
								});
							}
						},
					},
				});
				const postCommitFailures: string[] = [];
				if (runtimePrepared && controller) {
					try {
						await controller.clearBlockedRuntime(sessionContext());
						await controller.reconcileCurrentSession(sessionContext());
					} catch {
						postCommitFailures.push("current-session reconciliation failed");
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
						await controller.reconcileCurrentSession(sessionContext());
					}
				}
				throw notificationOperationError(services, error, services.getNotificationConfig(ctx.settings).botToken);
			}
		},

		setSessionLocal: async enabled => {
			const controller = ctx.session.notificationSessionController;
			if (!controller) return unavailableNotificationSessionResult();
			try {
				return await controller.setLocalEnabled(sessionContext(), enabled);
			} catch (error) {
				throw notificationOperationError(services, error, services.getNotificationConfig(ctx.settings).botToken);
			}
		},

		commitPreferences: async preferences => {
			let daemonWasRunningForDisable = false;
			try {
				const before = services.getNotificationConfig(ctx.settings);
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
				const config = services.getNotificationConfig(ctx.settings);
				if (isProviderEffectivelyEnabled(config, "telegram") && isTelegramComplete(config)) {
					try {
						const reload = daemonWasRunningForDisable
							? await services.restartTelegramDaemon(ctx.settings)
							: await services.reloadTelegramDaemon(ctx.settings);
						if (!reload.ok) postCommitFailures.push(`daemon reload failed: ${reload.message}`);
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
				throw notificationOperationError(services, error, services.getNotificationConfig(ctx.settings).botToken);
			}
		},

		reconcileCurrentSession: async () => {
			const controller = ctx.session.notificationSessionController;
			if (!controller) return unavailableNotificationSessionResult();
			try {
				return await controller.reconcileCurrentSession(sessionContext());
			} catch (error) {
				throw notificationOperationError(services, error, services.getNotificationConfig(ctx.settings).botToken);
			}
		},
	};
}

export class SelectorController {
	#transcriptViewerOpen = false;
	#transcriptViewer?: TranscriptViewerOverlay;
	#sessionsDashboardOpen = false;
	#sessionsDashboard?: SessionsDashboardComponent;
	#tasksPane?: TasksPaneComponent;
	#closeTasksPane?: () => void;

	#credentialAutoImportStateStore?: CredentialAutoImportStateStore;

	constructor(
		private ctx: InteractiveModeContext,
		credentialAutoImportStateStore?: CredentialAutoImportStateStore,
		private readonly clipboard: (text: string) => void = copyToClipboard,
	) {
		this.#credentialAutoImportStateStore = credentialAutoImportStateStore;
	}

	isTranscriptViewerOpen(): boolean {
		return this.#transcriptViewerOpen;
	}
	refreshTranscriptViewer(identityMap?: ReadonlyMap<string, string>): void {
		this.#transcriptViewer?.refresh(identityMap);
		this.ctx.ui.requestRender();
	}

	async #refreshOAuthProviderAuthState(): Promise<void> {
		const oauthProviders = getOAuthProviders();
		await Promise.all(
			oauthProviders.map(provider =>
				this.ctx.session.modelRegistry
					.getApiKeyForProvider(provider.id, this.ctx.session.sessionId)
					.catch(() => undefined),
			),
		);
	}
	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		if (this.ctx.isStopped?.()) return;
		const done = () => {
			if (this.ctx.isStopped?.()) return;
			// Prefer the pet-aware composer restore (InteractiveMode.restoreComposer); fall back
			// to a plain editor swap for contexts that predate it (e.g. lightweight test doubles).
			if (typeof this.ctx.restoreComposer === "function") {
				this.ctx.restoreComposer();
			} else {
				this.ctx.editorContainer.clear();
				this.ctx.editorContainer.addChild(this.ctx.editor);
				this.ctx.ui.setFocus(this.ctx.editor);
			}
		};
		const { component, focus } = create(done);
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(component);
		this.ctx.ui.setFocus(focus);
		this.ctx.ui.requestRender();
	}

	showCommandPalette(
		commands: SlashCommand[],
		actions: CommandPaletteAction[],
		executeSlashCommand: (name: string) => Promise<void>,
	): void {
		const seenCommands = new Set<string>();
		const entries: CommandPaletteEntry[] = [
			...actions.map(action => ({
				id: `action:${action.id}`,
				label: action.label,
				description: action.id,
				keybinding: this.ctx.keybindings.getDisplayString(action.id as AppKeybinding) || undefined,
				searchText: action.id,
				handler: action.handler,
			})),
			...commands
				.filter(command => {
					if (seenCommands.has(command.name)) return false;
					seenCommands.add(command.name);
					return true;
				})
				.map(command => ({
					id: `command:${command.name}`,
					label: `/${command.name}`,
					description: command.description ?? "Slash command",
					searchText: command.name,
					handler: () => executeSlashCommand(command.name),
				})),
		];

		this.showSelector(done => {
			const selector = new CommandPaletteComponent(
				entries,
				entry => {
					done();
					void Promise.resolve()
						.then(() => entry.handler?.())
						.catch(error => {
							this.ctx.showError(error instanceof Error ? error.message : String(error));
						});
				},
				done,
			);
			return { component: selector, focus: selector };
		});
	}
	showProviderOnboarding(): void {
		this.showSelector(done => {
			const selector = new ProviderOnboardingSelectorComponent(
				(action: ProviderOnboardingAction) => {
					done();
					if (action === "custom-provider-wizard") {
						this.showCustomProviderWizard();
					} else if (action === "oauth-login") {
						void this.showOAuthSelector("login");
					} else if (action === "import-credentials") {
						void this.#handleCredentialImport();
					} else {
						this.ctx.showStatus(formatProviderOnboardingCommandGuide());
					}
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	async #handleCredentialImport(): Promise<void> {
		this.ctx.showStatus("Scanning for existing Claude Code / Codex CLI credentials…");
		const preview = await runExternalCredentialAutoImport({
			authStorage: {
				importCredentialIfAbsent: async () => ({
					inserted: false,
					reason: "skipped-existing",
					provider: "",
					entries: [],
				}),
			},
			trigger: "bare-login",
		});
		const result = preview.discovery ?? { importable: [], skipped: [], environment: [] };
		const candidates = filterAutoImportOAuthCredentials(result.importable);
		const summaryLines = formatDiscoverySummary({ ...result, importable: candidates });

		if (candidates.length === 0) {
			this.ctx.chatContainer.addChild(new Spacer(1));
			for (const line of summaryLines) {
				this.ctx.chatContainer.addChild(new Text(theme.fg("dim", line), 1, 0));
			}
			this.ctx.chatContainer.addChild(
				new Text(
					theme.fg(
						"warning",
						"No importable Claude/Codex OAuth credentials found. Use /login or add a custom provider.",
					),
					1,
					0,
				),
			);
			this.ctx.ui.requestRender();
			return;
		}

		const confirmed = await this.ctx.showHookConfirm(
			`Import ${candidates.length} credential(s)?`,
			summaryLines.join("\n"),
		);
		if (!confirmed) {
			this.ctx.showStatus("Credential import cancelled.");
			return;
		}

		const summary = await runExternalCredentialAutoImport({
			authStorage: this.ctx.session.modelRegistry.authStorage,
			trigger: "bare-login",
		});
		await this.ctx.session.modelRegistry.refresh();

		this.ctx.chatContainer.addChild(new Spacer(1));
		for (const credential of summary.imported) {
			this.ctx.chatContainer.addChild(
				new Text(
					theme.fg("success", `${theme.status.success} Imported ${credential.provider} (${credential.source})`),
					1,
					0,
				),
			);
		}
		for (const skip of summary.skipped) {
			this.ctx.chatContainer.addChild(
				new Text(theme.fg("dim", `${theme.status.info} Skipped ${skip.credential.provider}: ${skip.reason}`), 1, 0),
			);
		}
		for (const failure of summary.failures) {
			const provider = failure.credential?.provider ?? failure.origin ?? "credential discovery";
			this.ctx.chatContainer.addChild(
				new Text(theme.fg("error", `${theme.status.error} Failed ${provider}: ${failure.failureClass}`), 1, 0),
			);
		}
		if (summary.imported.length > 0) {
			this.ctx.chatContainer.addChild(new Text(theme.fg("dim", `Credentials saved to ${getAgentDbPath()}`), 1, 0));
		}
		this.ctx.ui.requestRender();
	}

	showCustomModelPresetWizard(snapshot: ModelProfileConfig): void {
		this.showSelector(done => {
			let wizard: CustomModelPresetWizardComponent;
			const submit = async (input: CustomModelPresetWizardSubmit): Promise<void> => {
				try {
					const profile = await this.ctx.session.modelRegistry.saveCustomModelProfile(input.name, input.profile);
					await this.ctx.session.modelRegistry.refresh("offline");
					await this.ctx.notifyConfigChanged?.();
					this.ctx.showStatus(`Custom model preset created: ${formatModelProfileDisplayLabel(profile)}`);
					done();
					this.ctx.ui.requestRender();
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					wizard.setSubmitError(`Preset creation failed: ${message}`);
				}
			};
			wizard = new CustomModelPresetWizardComponent(
				snapshot,
				input => {
					void submit(input);
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
				() => this.ctx.ui.requestRender(),
			);
			return { component: wizard, focus: wizard };
		});
	}

	async #renameCustomModelPreset(profileName: string, modelSelector: ModelSelectorComponent): Promise<void> {
		const profile = this.ctx.session.modelRegistry.getModelProfile(profileName);
		const currentName = profile ? formatModelProfileDisplayLabel(profile) : profileName;
		const input = await this.ctx.showHookInput(`Rename custom model preset: ${currentName}`, undefined, undefined, {
			initialValue: currentName,
		});
		if (input === undefined) {
			this.ctx.showStatus("Preset rename cancelled.");
			this.ctx.ui.requestRender();
			return;
		}
		try {
			const renamed = await this.ctx.session.modelRegistry.renameCustomModelProfile(profileName, input);
			await this.ctx.session.modelRegistry.refresh("offline");
			await this.ctx.notifyConfigChanged?.();
			modelSelector.refreshPresetProfiles(renamed.name);
			this.ctx.showStatus(`Custom model preset renamed: ${formatModelProfileDisplayLabel(renamed)}`);
			this.ctx.ui.requestRender();
		} catch (err) {
			this.ctx.showError(`Preset rename failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async #deleteCustomModelPreset(profileName: string, modelSelector: ModelSelectorComponent): Promise<void> {
		const profile = this.ctx.session.modelRegistry.getModelProfile(profileName);
		const profileLabel = profile ? formatModelProfileDisplayLabel(profile) : profileName;
		const confirmed = await this.ctx.showHookConfirm(
			`Delete custom model preset: ${profileLabel}`,
			"This removes the preset entry after preserving current role model settings when this preset is active/default.",
		);
		if (!confirmed) {
			this.ctx.showStatus("Preset delete cancelled.");
			this.ctx.ui.requestRender();
			return;
		}

		const activeProfile = this.ctx.session.getActiveModelProfile?.();
		const defaultProfile = this.ctx.settings.get("modelProfile.default");
		let snapshot: MaterializeModelProfileForDeletionResult | undefined;
		let deletedProfile: ModelProfileConfig | undefined;
		const refreshSelectorState = (refreshedProfileName?: string): void => {
			modelSelector.refreshRoleAssignments({
				currentModel: this.ctx.session.model,
				currentThinkingLevel: this.ctx.session.thinkingLevel,
				activeModelProfile:
					this.ctx.session.getActiveModelProfile?.() ?? this.ctx.settings.get("modelProfile.default"),
			});
			modelSelector.refreshPresetProfiles(refreshedProfileName);
		};
		try {
			if (activeProfile === profileName || defaultProfile === profileName) {
				snapshot = await materializeModelProfileForDeletion({
					session: this.ctx.session,
					modelRegistry: this.ctx.session.modelRegistry,
					settings: this.ctx.settings,
					profileName,
				});
			}
			deletedProfile = await this.ctx.session.modelRegistry.deleteCustomModelProfile(profileName);
			await this.ctx.session.modelRegistry.refresh("offline");
			await this.ctx.notifyConfigChanged?.();
			refreshSelectorState();
			this.ctx.showStatus(`Custom model preset deleted: ${profileLabel}`);
			this.ctx.ui.requestRender();
		} catch (err) {
			let presetRestoreError: unknown;
			if (deletedProfile) {
				try {
					await this.ctx.session.modelRegistry.saveCustomModelProfile(profileName, deletedProfile);
					await this.ctx.session.modelRegistry.refresh("offline");
				} catch (restoreErr) {
					presetRestoreError = restoreErr;
				}
			}
			if (snapshot) {
				try {
					await restoreMaterializedModelProfileForDeletion({
						settings: this.ctx.settings,
						session: this.ctx.session,
						snapshot,
					});
				} catch (restoreErr) {
					refreshSelectorState(deletedProfile ? profileName : undefined);
					this.ctx.showError(
						`Preset delete failed and settings rollback failed: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`,
					);
					return;
				}
			}
			if (deletedProfile) refreshSelectorState(profileName);
			if (presetRestoreError) {
				this.ctx.showError(
					`Preset delete failed and preset restore failed: ${presetRestoreError instanceof Error ? presetRestoreError.message : String(presetRestoreError)}`,
				);
				return;
			}
			this.ctx.showError(`Preset delete failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async #handleImageGenerationConfig(): Promise<void> {
		const provider = await this.ctx.showHookInput(
			"Image Generation provider (auto, openai, gemini, openrouter, antigravity, alibaba, custom)",
			"auto",
		);
		if (provider === undefined) return;
		const normalized = provider.trim().toLowerCase();
		const validProviders = ["auto", "openai", "gemini", "openrouter", "antigravity", "alibaba", "custom"];
		if (!validProviders.includes(normalized)) {
			this.ctx.showStatus(`Invalid image provider: ${normalized}. Valid: ${validProviders.join(", ")}`);
			return;
		}
		let model: string | undefined;
		if (normalized !== "auto" && normalized !== "custom") {
			const defaultModel = IMAGE_PROVIDER_DEFAULTS[normalized];
			model = await this.ctx.showHookInput(`Image model for ${normalized} (default: ${defaultModel})`, defaultModel);
			if (model === undefined) return;
			model = model.trim() || defaultModel;
		}
		let customUrl: string | undefined;
		let customKey: string | undefined;
		if (normalized === "custom") {
			customUrl = await this.ctx.showHookInput("Custom image endpoint base URL");
			if (!customUrl?.trim()) {
				this.ctx.showStatus("Custom image endpoint requires a base URL");
				return;
			}
			model = await this.ctx.showHookInput("Custom image model", IMAGE_PROVIDER_DEFAULTS.openai);
			if (model === undefined) return;
			model = model.trim() || IMAGE_PROVIDER_DEFAULTS.openai;
			customKey = await this.ctx.showHookInput("Custom image endpoint API key");
		}
		const scope = await this.ctx.showHookInput(
			"Scope: 'session' (this session only) or 'default' (persist)",
			"session",
		);
		if (scope === undefined) return;
		const persistDefault = scope.trim().toLowerCase() === "default";
		if (persistDefault && !this.ctx.settings.canWriteDurableConfig()) {
			this.ctx.showError(
				"Cannot change settings while config.yml has invalid YAML syntax. Repair config.yml and reload settings.",
			);
			return;
		}

		const imageProvider = normalized as
			| "auto"
			| "openai"
			| "gemini"
			| "openrouter"
			| "antigravity"
			| "alibaba"
			| "custom";
		setPreferredImageProvider(imageProvider === "custom" ? "auto" : imageProvider);
		setConfiguredImageModel({
			provider: imageProvider,
			model: model ?? null,
			customUrl: customUrl?.trim(),
			customKey: customKey?.trim(),
		});

		if (persistDefault) {
			this.ctx.settings.set("providers.image", imageProvider);
			if (model) this.ctx.settings.set("providers.imageModel", model);
			if (customUrl?.trim()) this.ctx.settings.set("providers.imageCustomUrl", customUrl.trim());
			if (customKey?.trim()) this.ctx.settings.set("providers.imageCustomKey", customKey.trim());
		}

		const displayModel =
			model ?? (normalized !== "auto" && normalized !== "custom" ? IMAGE_PROVIDER_DEFAULTS[normalized] : undefined);
		const label = normalized === "auto" ? "Auto" : `${normalized}${displayModel ? ` (${displayModel})` : ""}`;
		this.ctx.showStatus(`Image Generation: ${label}${persistDefault ? " (default)" : " (session)"}`);
		this.ctx.ui.requestRender();
	}

	showCustomProviderWizard(): void {
		this.showSelector(done => {
			let wizard: CustomProviderWizardComponent;
			const submit = async (input: CustomProviderWizardSubmit): Promise<void> => {
				try {
					const result = await addApiCompatibleProvider(input);
					await this.ctx.session.modelRegistry.refresh("offline");
					await this.ctx.notifyConfigChanged?.();
					this.ctx.showStatus(formatProviderSetupResult(result));
					wizard.complete();
					done();
					this.ctx.ui.requestRender();
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					wizard.setSubmitError(`Provider setup failed: ${message}`);
				}
			};
			wizard = new CustomProviderWizardComponent(
				input => {
					return submit(input);
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
				() => this.ctx.ui.requestRender(),
			);
			return { component: wizard, focus: wizard };
		});
	}

	showEffortSelector(): void {
		const availableLevels = [
			ThinkingLevel.Inherit,
			ThinkingLevel.Off,
			...this.ctx.session.getAvailableThinkingLevels(),
		];

		this.showSelector(done => {
			const selector = new ThinkingSelectorComponent(
				this.ctx.session.thinkingLevel,
				availableLevels,
				async selection => {
					const { level, persistDefault } = selection;
					const configuredDefault = this.ctx.settings.get("defaultThinkingLevel");
					const levelToApply = level === ThinkingLevel.Inherit ? configuredDefault : level;
					try {
						await this.ctx.session.setThinkingLevelForControl(level, persistDefault);
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
						return;
					}
					done();

					const effectiveLevel = this.ctx.session.thinkingLevel ?? ThinkingLevel.Off;
					const requestedLabel =
						level === ThinkingLevel.Inherit ? `${level} (configured default: ${configuredDefault})` : level;
					const clampedSuffix =
						effectiveLevel === levelToApply ? "" : ` Requested ${levelToApply}; effective ${effectiveLevel}.`;

					this.ctx.statusLine.invalidate();
					this.ctx.updateEditorBorderColor();
					this.ctx.updateEditorTopBorder();
					if (persistDefault) void this.ctx.notifyConfigChanged?.();
					this.ctx.ui.requestRender();
					const scopeLabel = persistDefault ? "Default reasoning effort" : "Reasoning effort";
					this.ctx.showStatus(
						`${scopeLabel} set to ${requestedLabel}. Effective effort: ${effectiveLevel}.${clampedSuffix}`,
					);
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}
	showSettingsSelector(): void {
		getAvailableThemes().then(availableThemes => {
			this.showSelector(done => {
				const notificationsOperations = createNotificationsEditorOperations(this.ctx);

				const selector = new SettingsSelectorComponent(
					{
						availableThinkingLevels: [...this.ctx.session.getAvailableThinkingLevels()],
						thinkingLevel: this.ctx.session.thinkingLevel,
						availableThemes,
						availableModelProfiles: [...this.ctx.session.modelRegistry.getModelProfiles().keys()],
						cwd: getProjectDir(),
						gjcRuntimeSnapshot: this.ctx.session.gjcRuntimeSnapshot,
						gjcActivationGeneration: this.ctx.session.gjcActivationGeneration,
					},
					{
						onChange: (id, value) => this.handleSettingChange(id, value),
						onError: message => this.ctx.showError(message),
						onThemePreview: themeName => {
							return previewTheme(themeName).then(result => {
								if (!result.success && result.error && !isThemePreviewSuperseded(result)) {
									this.ctx.showError(`Failed to preview theme: ${result.error}`);
								}
								this.#refreshThemeUi();
							});
						},
						onThemePreviewCancel: themeName => {
							return restoreThemePreview(themeName).then(result => {
								if (!result.success && result.error && !isThemePreviewSuperseded(result)) {
									this.ctx.showError(`Failed to restore theme preview: ${result.error}`);
								}
								this.#refreshThemeUi();
							});
						},
						onPetPreview: mode => {
							this.ctx.previewPetMode(mode as PetMode);
						},
						onPetCommit: mode => this.ctx.commitPetPreviewMode(mode as PetMode),
						onStatusLinePreview: previewSettings => {
							// Update status line with preview settings
							this.ctx.statusLine.updateSettings({
								...buildStatusLineSettings(settings),
								...previewSettings,
							});
							this.ctx.updateEditorTopBorder();
							this.ctx.ui.requestRender();
						},
						getStatusLinePreview: (width?: number) => {
							// Return the rendered status line for inline preview
							const availableWidth =
								width ?? this.ctx.editor.getTopBorderAvailableWidth(this.ctx.ui.terminal.columns);
							return this.ctx.statusLine.getPreviewContent(availableWidth);
						},
						onPluginsChanged: () => {
							this.ctx.ui.requestRender();
						},
						onRenderRequested: () => this.ctx.ui.requestRender(),
						onCancel: () => {
							done();
							// Restore status line to saved settings
							this.ctx.statusLine.updateSettings(buildStatusLineSettings(settings));
							this.ctx.updateEditorTopBorder();
							this.ctx.ui.requestRender();
						},
					},
					notificationsOperations,
				);
				return { component: selector, focus: selector };
			});
		});
	}

	#refreshThemeUi(): void {
		this.ctx.statusLine.invalidate();
		this.ctx.updateEditorTopBorder();
		this.ctx.ui.requestRender();
	}

	showThemeSelector(): void {
		getAvailableThemes().then(availableThemes => {
			const initialTheme = getCurrentThemeName() ?? "red-claw";
			this.showSelector(done => {
				const restoreAndClose = () => {
					void restoreThemePreview(initialTheme).then(result => {
						if (!result.success && result.error) {
							this.ctx.showError(`Failed to restore theme preview: ${result.error}`);
						}
						this.#refreshThemeUi();
					});
					done();
				};
				const selector = new ThemeSelectorComponent(
					initialTheme,
					availableThemes,
					themeName => {
						if (!settings.canWriteDurableConfig()) {
							this.ctx.showError(
								"Cannot change settings while config.yml has invalid YAML syntax. Repair config.yml and reload settings.",
							);
							restoreAndClose();
							return;
						}
						try {
							settings.set(getDetectedThemeSettingsPath(), themeName);
						} catch (error) {
							if (!settings.canWriteDurableConfig()) {
								this.ctx.showError(error instanceof Error ? error.message : String(error));
								restoreAndClose();
								return;
							}
							throw error;
						}
						this.#refreshThemeUi();
						done();
					},
					restoreAndClose,
					themeName => {
						void previewTheme(themeName).then(result => {
							if (!result.success && result.error) {
								this.ctx.showError(`Failed to preview theme: ${result.error}`);
							}
							this.#refreshThemeUi();
						});
					},
				);
				return { component: selector, focus: selector.getSelectList() };
			});
		});
	}

	showPetSelector(): void {
		const stored = settings.get("pet.mode");
		const initial: PetMode = isPetMode(stored) ? stored : "off";
		this.showSelector(done => {
			// Live-preview via previewMode (no editor re-mount, so the overlay stays);
			// Enter commits + persists, Esc restores the initial skin.
			const selector = new PetSelectorComponent(
				initial,
				mode => {
					if (this.ctx.setPetMode(mode)) {
						done();
					}
				},
				() => {
					this.ctx.previewPetMode(initial);
					done();
				},
				mode => {
					this.ctx.previewPetMode(mode);
				},
				isPetAvailable(),
			);
			return { component: selector, focus: selector.getSelectList() };
		});
	}
	showHistorySearch(): void {
		const historyStorage = this.ctx.historyStorage;
		if (!historyStorage) return;

		this.showSelector(done => {
			const component = new HistorySearchComponent(
				historyStorage,
				prompt => {
					done();
					this.ctx.editor.setText(prompt);
					this.ctx.ui.requestRender();
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component, focus: component };
		});
	}

	/**
	 * Show the Extension Control Center dashboard.
	 * Replaces /status with a unified view of all providers and extensions.
	 */
	async showExtensionsDashboard(): Promise<void> {
		const dashboard = await ExtensionDashboard.create(getProjectDir(), this.ctx.settings, this.ctx.ui.terminal.rows);
		this.showSelector(done => {
			dashboard.onClose = () => {
				done();
				this.ctx.ui.requestRender();
			};
			dashboard.onRequestRender = () => {
				this.ctx.ui.requestRender();
			};
			return { component: dashboard, focus: dashboard };
		});
	}

	/**
	 * Show the Agent Control Center dashboard.
	 */
	async showAgentsDashboard(): Promise<void> {
		const activeModel = this.ctx.session.model;
		const activeModelPattern = activeModel ? `${activeModel.provider}/${activeModel.id}` : undefined;
		const defaultModelPattern = this.ctx.settings.getModelRole("default");
		const dashboard = await AgentDashboard.create(getProjectDir(), this.ctx.settings, this.ctx.ui.terminal.rows, {
			modelRegistry: this.ctx.session.modelRegistry,
			activeModelPattern,
			defaultModelPattern: selectorHead(defaultModelPattern),
		});
		this.showSelector(done => {
			dashboard.onClose = () => {
				done();
				this.ctx.ui.requestRender();
			};
			dashboard.onRequestRender = () => {
				this.ctx.ui.requestRender();
			};
			return { component: dashboard, focus: dashboard };
		});
	}

	/**
	 * Handle setting changes from the settings selector.
	 * Most settings are saved directly via SettingsManager in the definitions.
	 * This handles side effects and session-specific settings.
	 */
	handleSettingChange(id: string, value: unknown): void {
		// Discovery provider toggles
		if (id.startsWith("discovery.")) {
			const providerId = id.replace("discovery.", "");
			if (value) {
				enableProvider(providerId);
			} else {
				disableProvider(providerId);
			}
			return;
		}

		switch (id) {
			// Session-managed settings (not in SettingsManager)
			case "autoCompact":
				this.ctx.session.setAutoCompactionEnabled(value as boolean);
				this.ctx.statusLine.setAutoCompactEnabled(value as boolean);
				break;
			case "steeringMode":
				this.ctx.session.setSteeringMode(value as "all" | "one-at-a-time");
				break;
			case "followUpMode":
				this.ctx.session.setFollowUpMode(value as "all" | "one-at-a-time");
				break;
			case "interruptMode":
				this.ctx.session.setInterruptMode(value as "immediate" | "wait");
				break;
			case "thinkingLevel":
			case "defaultThinkingLevel":
				this.ctx.session.setThinkingLevel(value as ThinkingLevel, true);
				this.ctx.statusLine.invalidate();
				this.ctx.updateEditorBorderColor();
				break;

			case "modelProfile.default": {
				// Applying the default profile live mirrors the /model preset flow so the
				// running session switches immediately, not only on next startup.
				const profileName = typeof value === "string" ? value : "";
				if (!profileName) break;
				this.#applyModelProfile(profileName, true)
					.then(() => this.ctx.ui.requestRender())
					.catch(error => {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					});
				break;
			}
			case "clearOnShrink":
				this.ctx.ui.setClearOnShrink(value as boolean);
				break;

			case "autocompleteMaxVisible":
				this.ctx.editor.setAutocompleteMaxVisible(typeof value === "number" ? value : Number(value));
				break;

			// Settings with UI side effects
			case "showImages":
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof ToolExecutionComponent) {
						child.setShowImages(value as boolean);
					}
				}
				break;
			case "hideThinking":
				this.ctx.hideThinkingBlock = value as boolean;
				this.ctx.session.agent.hideThinkingSummary = value as boolean;
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof AssistantMessageComponent) {
						child.setHideThinkingBlock(value as boolean);
					}
				}
				this.ctx.rebuildChatFromMessages("reconcile-same-transcript");
				break;
			case "theme": {
				setTheme(value as string, true, { shouldApply: () => !this.ctx.isStopped?.() }).then(result => {
					if (this.ctx.isStopped?.()) return;
					this.ctx.statusLine.invalidate();
					this.ctx.updateEditorTopBorder();
					this.ctx.ui.invalidate();
					if (!result.success) {
						this.ctx.showError(`Failed to load theme "${value}": ${result.error}\nFell back to dark theme.`);
					}
				});
				break;
			}
			case "pet.mode":
				// The settings submenu already persisted the value; apply it to the live
				// widget via previewMode (the settings overlay is still open, so a full
				// re-mount would tear it down — restoreComposer re-mounts on close).
				this.ctx.previewPetMode(value as PetMode);
				break;
			case "symbolPreset": {
				setSymbolPreset(value as "unicode" | "nerd" | "ascii").then(() => {
					this.ctx.statusLine.invalidate();
					this.ctx.updateEditorTopBorder();
					this.ctx.ui.invalidate();
				});
				break;
			}
			case "colorBlindMode": {
				setColorBlindMode(value === "true" || value === true).then(() => {
					this.ctx.ui.invalidate();
				});
				break;
			}
			case "temperature": {
				const temp = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.temperature = temp >= 0 ? temp : undefined;
				break;
			}
			case "topP": {
				const topP = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.topP = topP >= 0 ? topP : undefined;
				break;
			}
			case "topK": {
				const topK = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.topK = topK >= 0 ? topK : undefined;
				break;
			}
			case "minP": {
				const minP = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.minP = minP >= 0 ? minP : undefined;
				break;
			}
			case "presencePenalty": {
				const presencePenalty = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.presencePenalty = presencePenalty >= 0 ? presencePenalty : undefined;
				break;
			}
			case "repetitionPenalty": {
				const repetitionPenalty = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.repetitionPenalty = repetitionPenalty >= 0 ? repetitionPenalty : undefined;
				break;
			}
			case "statusLine.showActionHints": {
				this.ctx.updateEditorChrome();
				break;
			}
			case "statusLinePreset":
			case "statusLine.preset":
			case "statusLineSeparator":
			case "statusLine.separator":
			case "statusLineShowHooks":
			case "statusLine.showHookStatus":
			case "statusLine.sessionAccent":
			case "statusLine.maxRows":
			case "statusLine.leftSegments":
			case "statusLine.rightSegments":
			case "statusLine.segmentOptions":
			case "statusLineSegments":
			case "statusLineModelThinking":
			case "statusLinePathAbbreviate":
			case "statusLinePathMaxLength":
			case "statusLinePathStripWorkPrefix":
			case "statusLineGitShowBranch":
			case "statusLineGitShowStaged":
			case "statusLineGitShowUnstaged":
			case "statusLineGitShowUntracked":
			case "statusLineTimeFormat":
			case "statusLineTimeShowSeconds": {
				this.ctx.statusLine.updateSettings(buildStatusLineSettings(settings));
				this.ctx.updateEditorTopBorder();
				this.ctx.ui.requestRender();
				break;
			}
			case "irc.enabled":
			case "irc.sidebar.enabled":
				this.ctx.applyIrcSidebarAvailability(
					this.ctx.settings.get("irc.enabled") === true && this.ctx.settings.get("irc.sidebar.enabled") === true,
				);
				break;

			// Provider settings - update runtime preferences
			case "providers.webSearch":
				if (typeof value === "string" && isSearchProviderPreference(value)) {
					setPreferredSearchProvider(value);
				}
				break;
			case "web_search.fallback":
				if (Array.isArray(value)) {
					setSearchFallbackProviders(
						value.filter(item => typeof item === "string" && isConfigurableSearchProviderId(item)),
					);
				}
				break;
			case "web_search.timeout":
				if (typeof value === "number" && Number.isFinite(value) && value > 0) {
					setSearchHardTimeoutMs(value * 1000);
				}
				break;
			case "providers.image":
			case "providers.imageModel":
			case "providers.imageCustomUrl":
			case "providers.imageCustomKey":
			case "providers.imageCustomKeyEnv": {
				const imgProvider = this.ctx.settings.get("providers.image");
				const imgModel = this.ctx.settings.get("providers.imageModel");
				const imgCustomUrl = this.ctx.settings.get("providers.imageCustomUrl");
				const imgCustomKey = this.ctx.settings.get("providers.imageCustomKey");
				const imgCustomKeyEnv = this.ctx.settings.get("providers.imageCustomKeyEnv");
				if (
					imgProvider === "auto" ||
					imgProvider === "openai" ||
					imgProvider === "gemini" ||
					imgProvider === "openrouter" ||
					imgProvider === "antigravity" ||
					imgProvider === "alibaba" ||
					imgProvider === "custom"
				) {
					setPreferredImageProvider(imgProvider === "custom" ? "auto" : imgProvider);
					setConfiguredImageModel({
						provider: imgProvider,
						model: imgModel ?? null,
						customUrl: imgCustomUrl,
						customKey: imgCustomKey,
						customKeyEnv: imgCustomKeyEnv,
					});
				}
				break;
			}

			// MCP update injection - live subscribe/unsubscribe
			case "mcp.notifications":
				this.ctx.mcpManager?.setNotificationsEnabled(value as boolean);
				break;

			// All other settings are handled by the definitions (get/set on SettingsManager)
			// No additional side effects needed
		}
	}

	/**
	 * Activate a model profile through the shared /model + /settings path: swap the
	 * live session model (and, when persistDefault, persist it as the startup
	 * default) then refresh the status surfaces. Rethrows so callers surface errors.
	 */
	async #applyModelProfile(profileName: string, persistDefault: boolean): Promise<void> {
		const profileLabel = formatModelProfileDisplayLabel(
			this.ctx.session.modelRegistry.getModelProfile(profileName) ?? { name: profileName },
		);
		await activateModelProfile(
			{
				session: this.ctx.session,
				modelRegistry: this.ctx.session.modelRegistry,
				settings: this.ctx.settings,
				profileName,
			},
			{ persistDefault },
		);
		this.ctx.statusLine.invalidate();
		this.ctx.updateEditorBorderColor();
		this.ctx.showStatus(persistDefault ? `Default model profile: ${profileLabel}` : `Model profile: ${profileLabel}`);
	}

	showModelSelector(options?: { temporaryOnly?: boolean }): void {
		this.showSelector(done => {
			let modelSelector: ModelSelectorComponent;
			const refreshRoleAssignments = () => {
				modelSelector.refreshRoleAssignments({
					currentModel: this.ctx.session.model,
					currentThinkingLevel: this.ctx.session.thinkingLevel,
					activeModelProfile:
						this.ctx.session.getActiveModelProfile?.() ?? this.ctx.settings.get("modelProfile.default"),
				});
			};
			modelSelector = new ModelSelectorComponent(
				this.ctx.ui,
				this.ctx.session.model,
				this.ctx.settings,
				this.ctx.session.modelRegistry,
				this.ctx.session.scopedModels,
				async selection => {
					const isTrackedSingleAssignment =
						selection.kind === "assignment" && selection.role !== null && selection.roles === undefined;
					try {
						if (selection.kind === "createProfile") {
							done();
							this.showCustomModelPresetWizard(selection.profile);
							return;
						}
						if (selection.kind === "renameProfile") {
							await this.#renameCustomModelPreset(selection.profileName, modelSelector);
							return;
						}
						if (selection.kind === "deleteProfile") {
							await this.#deleteCustomModelPreset(selection.profileName, modelSelector);
							return;
						}
						if (selection.kind === "imageGeneration") {
							done();
							await this.#handleImageGenerationConfig();
							return;
						}
						if (selection.kind === "profile") {
							await this.#applyModelProfile(selection.profileName, selection.setDefault);
							done();
							this.ctx.ui.requestRender();
							return;
						}
						const { model, role, thinkingLevel, selector: selectedSelector } = selection;
						if (role === null) {
							// Temporary: update agent state but don't persist to settings
							await this.ctx.session.setModelTemporary(model, thinkingLevel, {
								cause: "temporary-operation",
								reason: "other",
							});
							this.ctx.session.setDefaultFallbackRuntimeModel(
								selectedSelector ?? formatModelSelectorValue(`${model.provider}/${model.id}`, thinkingLevel),
							);
							this.ctx.statusLine.invalidate();
							this.ctx.updateEditorBorderColor();
							this.ctx.showStatus(`Temporary model: ${selectedSelector ?? model.id}`);
							done();
							this.ctx.ui.requestRender();
						} else if (selection.roles !== undefined) {
							const targetRoles: readonly GjcModelAssignmentTargetId[] = selection.roles;
							const includesDefault = targetRoles.includes("default");
							const includesRoleAgent = targetRoles.some(targetRole => targetRole !== "default");
							if (includesRoleAgent) {
								const apiKey = await this.ctx.session.modelRegistry.getApiKey(
									model,
									this.ctx.session.sessionId,
								);
								if (!apiKey) {
									throw new Error(`No API key for ${model.provider}/${model.id}`);
								}
							}
							const value =
								selectedSelector ?? formatModelSelectorValue(`${model.provider}/${model.id}`, thinkingLevel);
							const assignments = new Map<GjcModelAssignmentTargetId, string>();
							for (const targetRole of targetRoles) assignments.set(targetRole, value);
							const defaultSelector =
								selectedSelector && thinkingLevel && selectedSelector.endsWith(`:${thinkingLevel}`)
									? selectedSelector.slice(0, -thinkingLevel.length - 1)
									: selectedSelector;

							if (includesDefault) {
								await this.ctx.session.setModel(model, "default", {
									selector: defaultSelector,
									thinkingLevel,
									cause: "user-selection",
								});
								if (thinkingLevel && thinkingLevel !== ThinkingLevel.Inherit) {
									this.ctx.session.setThinkingLevel(thinkingLevel);
								}
							}
							const materializedProfile = materializeActiveModelProfileAssignments({
								session: this.ctx.session,
								settings: this.ctx.settings,
								assignments,
							});
							if (!materializedProfile) {
								for (const targetRole of targetRoles) {
									const target = GJC_MODEL_ASSIGNMENT_TARGETS[targetRole];
									if (target.settingsPath === "modelRoles") {
										this.ctx.settings.setModelRole(targetRole, value);
									} else {
										this.ctx.settings.setAgentModelOverride(targetRole, value);
									}
								}
							}
							modelSelector.refreshRoleAssignments({
								currentModel: this.ctx.session.model,
								currentThinkingLevel: this.ctx.session.thinkingLevel,
								activeModelProfile:
									this.ctx.session.getActiveModelProfile?.() ?? this.ctx.settings.get("modelProfile.default"),
							});
							this.ctx.settings.getStorage()?.recordModelUsage(`${model.provider}/${model.id}`);
							this.ctx.statusLine.invalidate();
							this.ctx.updateEditorBorderColor();
							await this.ctx.notifyConfigChanged?.();
							const labels = targetRoles.map(
								targetRole => GJC_MODEL_ASSIGNMENT_TARGETS[targetRole].tag ?? targetRole.toUpperCase(),
							);
							this.ctx.showStatus(
								includesDefault
									? `All model targets set to ${value} for ${labels.join(", ")}.`
									: `Role-agent models set to ${value} for ${labels.join(", ")}.`,
							);
							done();
							this.ctx.ui.requestRender();
						} else if (role === "default") {
							// Default: update agent state and persist as the active default model.
							await this.ctx.session.setModel(model, role, {
								selector: selectedSelector,
								thinkingLevel,
								cause: "user-selection",
							});
							const value = formatModelSelectorValue(
								selectedSelector ?? `${model.provider}/${model.id}`,
								thinkingLevel,
							);
							if (
								!materializeActiveModelProfileAssignment({
									session: this.ctx.session,
									settings: this.ctx.settings,
									role,
									selector: value,
								})
							) {
								this.ctx.settings.setModelRole(role, value);
							}
							if (thinkingLevel && thinkingLevel !== ThinkingLevel.Inherit) {
								this.ctx.session.setThinkingLevel(thinkingLevel);
							}
							refreshRoleAssignments();
							this.ctx.statusLine.invalidate();
							this.ctx.updateEditorBorderColor();
							this.ctx.showStatus(`Default model: ${selectedSelector ?? model.id}`);
							this.ctx.ui.requestRender();
						} else {
							const apiKey = await this.ctx.session.modelRegistry.getApiKey(model, this.ctx.session.sessionId);
							if (!apiKey) {
								throw new Error(`No API key for ${model.provider}/${model.id}`);
							}
							const value =
								selectedSelector ?? formatModelSelectorValue(`${model.provider}/${model.id}`, thinkingLevel);
							const assignments = new Map<GjcModelAssignmentTargetId, string>([[role, value]]);
							const materializedProfile = materializeActiveModelProfileAssignments({
								session: this.ctx.session,
								settings: this.ctx.settings,
								assignments,
							});
							if (!materializedProfile) {
								const target = GJC_MODEL_ASSIGNMENT_TARGETS[role];
								if (target.settingsPath === "modelRoles") {
									this.ctx.settings.setModelRole(role, value);
								} else {
									this.ctx.settings.setAgentModelOverride(role, value);
								}
							}
							refreshRoleAssignments();
							this.ctx.settings.getStorage()?.recordModelUsage(`${model.provider}/${model.id}`);
							this.ctx.statusLine.invalidate();
							this.ctx.updateEditorBorderColor();
							await this.ctx.notifyConfigChanged?.();
							this.ctx.showStatus(`${role} agent model: ${value}`);
							this.ctx.ui.requestRender();
						}
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
						if (isTrackedSingleAssignment) {
							refreshRoleAssignments();
							this.ctx.ui.requestRender();
							throw error;
						}
					}
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
				{
					...options,
					sessionId: this.ctx.session.sessionId,
					currentThinkingLevel: this.ctx.session.thinkingLevel,
					activeModelProfile:
						this.ctx.session.getActiveModelProfile?.() ?? this.ctx.settings.get("modelProfile.default"),
					isFastForProvider: provider => this.ctx.session.isFastForProvider(provider),
					isFastForSubagentProvider: provider => this.ctx.session.isFastForSubagentProvider(provider),
					isCurrentModelFastModeActive: () => this.ctx.session.isFastModeActive(),
				},
			);
			return { component: modelSelector, focus: modelSelector };
		});
	}

	async showPluginSelector(mode: "install" | "uninstall" = "install"): Promise<void> {
		const mgr = new MarketplaceManager({
			marketplacesRegistryPath: getMarketplacesRegistryPath(),
			installedRegistryPath: getInstalledPluginsRegistryPath(),
			projectInstalledRegistryPath: (await resolveActiveProjectRegistryPath(getProjectDir())) ?? undefined,
			marketplacesCacheDir: getMarketplacesCacheDir(),
			pluginsCacheDir: getPluginsCacheDir(),
			clearPluginRootsCache: clearPluginRootsAndCaches,
		});

		const [marketplaces, installed] = await Promise.all([mgr.listMarketplaces(), mgr.listInstalledPlugins()]);
		const installedIds = new Set(installed.map(p => p.id));

		if (mode === "uninstall") {
			// Show only installed plugins for uninstall
			const items = installed.map(p => {
				const entry = p.entries[0];
				const atIdx = p.id.lastIndexOf("@");
				const pluginName = atIdx > 0 ? p.id.slice(0, atIdx) : p.id;
				const mkt = atIdx > 0 ? p.id.slice(atIdx + 1) : "unknown";
				return {
					plugin: { name: pluginName, version: entry?.version, description: undefined as string | undefined },
					marketplace: mkt,
					scope: p.scope,
				};
			});
			this.showSelector(done => {
				const selector = new PluginSelectorComponent(marketplaces.length, items, new Set(), {
					onSelect: async (name, marketplace, scope) => {
						done();
						const pluginId = `${name}@${marketplace}`;
						this.ctx.showStatus(`Uninstalling ${pluginId}...`);
						this.ctx.ui.requestRender();
						try {
							await mgr.uninstallPlugin(pluginId, scope);
							this.ctx.showStatus(`Uninstalled ${pluginId}`);
						} catch (err) {
							this.ctx.showStatus(`Uninstall failed: ${err}`);
						}
						this.ctx.ui.requestRender();
					},
					onCancel: () => {
						done();
						this.ctx.ui.requestRender();
					},
				});
				return { component: selector, focus: selector.getSelectList() };
			});
			return;
		}

		// Install mode: show all available plugins from all marketplaces
		const allPlugins: Array<{
			plugin: { name: string; version?: string; description?: string };
			marketplace: string;
		}> = [];
		for (const mkt of marketplaces) {
			const plugins = await mgr.listAvailablePlugins(mkt.name);
			for (const plugin of plugins) {
				allPlugins.push({ plugin, marketplace: mkt.name });
			}
		}

		this.showSelector(done => {
			const selector = new PluginSelectorComponent(marketplaces.length, allPlugins, installedIds, {
				onSelect: async (name, marketplace) => {
					done();
					this.ctx.showStatus(`Installing ${name} from ${marketplace}...`);
					this.ctx.ui.requestRender();
					try {
						const force = installedIds.has(`${name}@${marketplace}`);
						await mgr.installPlugin(name, marketplace, { force });
						this.ctx.showStatus(`Installed ${name} from ${marketplace}`);
					} catch (err) {
						this.ctx.showStatus(`Install failed: ${err}`);
					}
					this.ctx.ui.requestRender();
				},
				onCancel: () => {
					done();
					this.ctx.ui.requestRender();
				},
			});
			return { component: selector, focus: selector.getSelectList() };
		});
	}

	showUserMessageSelector(): void {
		const userMessages = this.ctx.session.getUserMessagesForBranching();

		if (userMessages.length === 0) {
			this.ctx.showStatus("No messages to branch from");
			return;
		}

		this.showSelector(done => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map(m => ({ id: m.entryId, text: m.text })),
				async entryId => {
					const result = await this.ctx.session.branch(entryId);
					if (result.cancelled) {
						// Hook cancelled the branch
						done();
						this.ctx.ui.requestRender();
						return;
					}
					this.ctx.resetIrcSidebarSession();

					this.ctx.rebuildInitialMessages("replace-identity");
					this.ctx.editor.setText(result.selectedText);
					done();
					this.ctx.showStatus("Branched to new session");
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	showTreeSelector(): void {
		const tree = getTreeForInternalRead(this.ctx.sessionManager);
		const realLeafId = this.ctx.sessionManager.getLeafId();

		if (tree.length === 0) {
			this.ctx.showStatus("No entries in session");
			return;
		}

		this.showSelector(done => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ctx.ui.terminal.rows,
				async entryId => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === realLeafId) {
						done();
						this.ctx.showStatus("Already at this point");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					const branchSummariesEnabled = settings.get("branchSummary.enabled");

					while (branchSummariesEnabled) {
						const summaryChoice = await this.ctx.showHookSelector("Summarize branch?", [
							"No summary",
							"Summarize",
							"Summarize with custom prompt",
						]);

						if (summaryChoice === undefined) {
							// User pressed escape - re-show tree selector
							this.showTreeSelector();
							return;
						}

						wantsSummary = summaryChoice !== "No summary";

						if (summaryChoice === "Summarize with custom prompt") {
							customInstructions = await this.ctx.showHookEditor("Custom summarization instructions");
							if (customInstructions === undefined) {
								// User cancelled - loop back to summary selector
								continue;
							}
						}

						// User made a complete choice
						break;
					}

					// Set up escape handler and loader if summarizing
					let summaryLoader: Loader | undefined;
					let releaseActivityIndicator: (() => void) | undefined;
					const originalOnEscape = this.ctx.editor.onEscape;

					if (wantsSummary) {
						this.ctx.editor.onEscape = () => {
							this.ctx.session.abortBranchSummary();
						};
						releaseActivityIndicator = suspendInteractiveActivityIndicator(this.ctx);
						this.ctx.chatContainer.addChild(new Spacer(1));
						summaryLoader = new Loader(
							this.ctx.ui,
							spinner => theme.fg("accent", spinner),
							text => theme.fg("muted", text),
							"Summarizing branch... (esc to cancel)",
							getSymbolTheme().spinnerFrames,
						);
						this.ctx.statusContainer.addChild(summaryLoader);
						this.ctx.ui.requestRender();
					}

					try {
						const result = await this.ctx.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
						});
						if (this.ctx.isStopped?.()) return;

						if (result.aborted) {
							// Summarization aborted - re-show tree selector
							this.ctx.showStatus("Branch summarization cancelled");
							this.showTreeSelector();
							return;
						}
						if (result.cancelled) {
							this.ctx.showStatus("Navigation cancelled");
							return;
						}

						// Update UI — pass the context built by navigateTree to skip a second O(N) walk.
						this.ctx.rebuildInitialMessages("reconcile-same-transcript", result.sessionContext);
						await this.ctx.reloadTodos();
						if (this.ctx.isStopped?.()) return;
						if (result.editorText && !this.ctx.editor.getText().trim()) {
							this.ctx.editor.setText(result.editorText);
						}
						this.ctx.showStatus("Navigated to selected point");
					} catch (error) {
						if (this.ctx.isStopped?.()) return;
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							if (!this.ctx.isStopped?.()) this.ctx.statusContainer.clear();
						}
						if (!this.ctx.isStopped?.()) this.ctx.editor.onEscape = originalOnEscape;
						releaseActivityIndicator?.();
					}
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
				(entryId, label) => {
					this.ctx.sessionManager.appendLabelChange(entryId, label);
					this.ctx.ui.requestRender();
				},
				settings.get("treeFilterMode"),
			);
			return { component: selector, focus: selector };
		});
	}

	async showSessionSelector(): Promise<void> {
		const sessions = await this.ctx.sessionManager.listForResumePickerReadOnly();
		if (this.ctx.isStopped?.()) return;
		this.showSelector(done => {
			const selector = new SessionSelectorComponent(
				sessions,
				sessionPath => {
					// `onSelect` is a void dispatch boundary: close the picker first, then
					// observe resume failures so a managed-candidate race (or any other
					// preparation/switch rejection) surfaces as UI error instead of an
					// unhandled rejection that can kill the process. Do not auto-retry.
					done();
					void this.handleResumeSession(sessionPath).catch(error => {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					});
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
				() => {
					void this.ctx.shutdown();
				},
				async (session: SessionInfo) => {
					if (!(await this.#detachActiveSessionBeforeDeletion(session.path))) {
						return false;
					}
					try {
						await this.#deleteSession(session.path);

						return true;
					} catch (err) {
						throw new Error(`Failed to delete session: ${err instanceof Error ? err.message : String(err)}`, {
							cause: err,
						});
					}
				},
			);
			selector.setOnRequestRender(() => this.ctx.ui.requestRender());
			return { component: selector, focus: selector };
		});
	}

	#clearTransientSessionUi(options?: { restoreBackground?: boolean; clearSpecializedLoaders?: boolean }): void {
		if (options?.clearSpecializedLoaders) clearInteractiveActivityLoaders(this.ctx);
		stopInteractiveActivityIndicator(this.ctx, { restoreBackground: options?.restoreBackground });
		this.ctx.pendingMessagesContainer.clear();
		this.ctx.compactionQueuedMessages = [];
		this.ctx.streamingComponent = undefined;
		this.ctx.streamingMessage = undefined;
		this.ctx.pendingTools.clear();
	}

	#refreshSessionTerminalTitle(): void {
		const sessionManager = this.ctx.sessionManager as {
			getSessionName?: () => string | undefined;
			getCwd: () => string;
			titleSource?: "auto" | "user" | undefined;
		};
		setSessionTerminalTitle(sessionManager.getSessionName?.(), sessionManager.getCwd());
	}

	async #deleteSession(sessionPath: string): Promise<void> {
		const sessionManager = this.ctx.sessionManager as { dropSession?: (path: string) => Promise<void> };
		if (sessionManager.dropSession) {
			await sessionManager.dropSession(sessionPath);
			return;
		}
		await new FileSessionStorage().deleteSessionWithArtifacts(sessionPath);
	}

	async #detachActiveSessionBeforeDeletion(sessionPath: string): Promise<boolean> {
		const currentSessionFile = this.ctx.sessionManager.getSessionFile();
		if (currentSessionFile !== sessionPath) {
			return true;
		}

		const detached = await this.ctx.session.newSession();
		if (this.ctx.isStopped?.()) return false;
		if (!detached) {
			return false;
		}
		this.ctx.resetIrcSidebarSession();

		this.#refreshSessionTerminalTitle();

		this.#clearTransientSessionUi({ clearSpecializedLoaders: true });
		this.ctx.statusLine.invalidate();
		this.ctx.statusLine.setSessionStartTime(Date.now());
		this.ctx.updateEditorTopBorder();
		this.ctx.updateEditorBorderColor();
		this.ctx.rebuildInitialMessages("replace-identity");
		await this.ctx.reloadTodos();
		if (this.ctx.isStopped?.()) return false;
		this.ctx.ui.requestRender();
		return true;
	}

	/**
	 * Guards `handleResumeSession` against overlapping resumes.
	 *
	 * `acquireResumeProgressLease` only owns the spinner, so it cannot serialize
	 * two resumes, and the session picker dispatches resume through a
	 * void-returning `onSelect` callback — a second selection would otherwise
	 * start a concurrent transition whose rejection nobody awaits.
	 */
	#resumeInFlight = false;

	async handleResumeSession(sessionPath: string): Promise<void> {
		if (this.#resumeInFlight) {
			this.ctx.showStatus("Resume already in progress");
			return;
		}
		this.#resumeInFlight = true;
		const releaseActivityIndicator = suspendInteractiveActivityIndicator(this.ctx);
		// Everything below runs inside the try so a synchronous failure (a throwing
		// session-manager accessor, an unavailable status rail) can never strand the
		// guard and silently disable every later resume.
		let progressLease: ResumeProgressLease | undefined;
		try {
			const previousSessionId = this.ctx.sessionManager.getSessionId();
			progressLease = acquireResumeProgressLease(this.ctx);
			await progressLease.committed;
			if (this.ctx.isStopped?.()) return;
			const migrationPolicy =
				this.ctx.settings?.get("session.directoryMigration") === "disabled" ? "disabled" : "copy-retain";
			let writableSessionPath = sessionPath;
			if (this.ctx.sessionManager.isManagedDestination()) {
				const inspection = await SessionManager.inspectSessionTailReadOnly(sessionPath);
				if (this.ctx.isStopped?.()) return;
				if (inspection.kind === "error")
					throw new Error(`Could not inspect selected session: ${inspection.reason}`);
				writableSessionPath = await this.ctx.sessionManager.prepareManagedCandidateForStrictAdoption(
					sessionPath,
					migrationPolicy,
					inspection.identity,
				);
				if (this.ctx.isStopped?.()) return;
			}
			// Switch session via AgentSession (emits hook and tool session events)
			let switched: boolean;
			let transitionMutationStarted = false;
			try {
				switched = await this.ctx.session.switchSession(writableSessionPath, {
					transition: { origin: INTERACTIVE_SELECTOR_RESUME_ORIGIN },
					onTransitionMutationStarted: () => {
						transitionMutationStarted = true;
					},
				});
				if (this.ctx.isStopped?.()) return;
			} catch (error) {
				if (this.ctx.isStopped?.()) return;
				// `switchSession` opens with `#beginSessionTransition`, which throws
				// `{ code: "busy" }` while another transition (compaction, handoff, fork,
				// another switch, …) owns the session. Resume is a UI action dispatched
				// through a void callback, so report that as status instead of rejecting a
				// promise nobody awaits. Admission-busy never acquired the lease, so the
				// owner's transient state — including the `compactionQueuedMessages` that
				// hold input typed during compaction — must survive untouched.
				const typed = error as { code?: unknown } | undefined;
				if (typed?.code === "busy") {
					this.ctx.showStatus("Another session operation is already in progress");
					return;
				}
				// A rejection can occur either before the transition mutates the live session
				// (for example, a rejecting `session_before_switch` hook) or after disconnect/
				// abort has begun. Preserve the current session's transient UI in the former
				// case; reconcile only state invalidated by a transition that actually mutated.
				// Reconciliation stays best-effort so cleanup failure never replaces the
				// original switch failure.
				if (transitionMutationStarted) {
					try {
						progressLease.clear();
						this.#clearTransientSessionUi({ restoreBackground: false, clearSpecializedLoaders: true });
					} catch {
						logger.warn("Resume transient-UI reconciliation failed after a session switch error", {
							classification: "resume-cleanup-failed",
						});
					}
				}
				throw error;
			}
			// `#clearTransientSessionUi` drops `compactionQueuedMessages`, so it must stay
			// untouched on the paths that never acquired the session-transition lease:
			// admission-busy above and managed-candidate preparation before it.
			//
			// A pre-mutation hook cancellation preserves the current session and all of
			// its foreground/retry UI. A rollback after disconnect/abort must clear it.
			if (!switched) {
				if (transitionMutationStarted) {
					progressLease.clear();
					this.#clearTransientSessionUi({ restoreBackground: false, clearSpecializedLoaders: true });
				}
				return;
			}
			progressLease.clear();
			this.#clearTransientSessionUi({ restoreBackground: false, clearSpecializedLoaders: true });
			const switchingToDifferentSession = previousSessionId !== this.ctx.sessionManager.getSessionId();
			if (switchingToDifferentSession) this.ctx.resetIrcSidebarSession();
			this.#refreshSessionTerminalTitle();
			this.ctx.updateEditorBorderColor();

			this.ctx.rebuildInitialMessages(
				switchingToDifferentSession ? "replace-identity" : "reconcile-same-transcript",
			);
			await this.ctx.reloadTodos();
			if (this.ctx.isStopped?.()) return;
			this.ctx.showStatus("Resumed session");
			this.#maybePromptResumeModelChoice();
		} finally {
			progressLease?.clear();
			this.#resumeInFlight = false;
			releaseActivityIndicator();
		}
	}

	/**
	 * When `session.resumeModelBehavior` is "ask", offer a one-shot choice after
	 * resuming: keep the model the session was last using, or switch to whatever
	 * `modelRoles.default` currently resolves to. No-op if the setting is unset,
	 * the two models already match, or either model can't be resolved.
	 */
	#maybePromptResumeModelChoice(): void {
		if (this.ctx.settings?.get("session.resumeModelBehavior") !== "ask") return;
		const sessionModel = this.ctx.session.model;
		const currentDefault = this.ctx.session.resolveConfiguredDefaultModel?.();
		if (!sessionModel || !currentDefault) return;
		if (sessionModel.provider === currentDefault.provider && sessionModel.id === currentDefault.id) return;

		this.showSelector(done => {
			const selector = new HookSelectorComponent(
				`This session last used ${sessionModel.provider}/${sessionModel.id}.\n` +
					`Current default model is ${currentDefault.provider}/${currentDefault.id}.`,
				[`Keep ${sessionModel.id}`, `Use ${currentDefault.id}`],
				async (option: string) => {
					done();
					if (option === `Use ${currentDefault.id}`) {
						try {
							await this.ctx.session.setModel(currentDefault);
							this.ctx.showStatus(`Switched to ${currentDefault.provider}/${currentDefault.id}`);
						} catch (err) {
							this.ctx.showError(err instanceof Error ? err.message : String(err));
						}
					}
					this.ctx.ui.requestRender();
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	async handleSessionDeleteCommand(): Promise<void> {
		const sessionFile = this.ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			this.ctx.showError("No session file to delete (in-memory session)");
			return;
		}

		// Check if session file exists (may not exist for brand new sessions)
		const storage = new FileSessionStorage();
		const fileExists = await storage.exists(sessionFile);
		if (!fileExists) {
			this.ctx.showError("Session has not been saved yet");
			return;
		}

		const confirmed = await this.ctx.showHookConfirm(
			"Delete current session transcript and artifacts?",
			[
				"This permanently deletes only the current session transcript file and its artifacts directory.",
				"Other sessions and topic/history metadata are not deleted.",
				"You will be moved to a fresh session and returned to the session selector.",
			].join("\n"),
		);

		if (!confirmed) {
			this.ctx.showStatus("Delete cancelled");
			return;
		}

		if (!(await this.#detachActiveSessionBeforeDeletion(sessionFile))) {
			this.ctx.showStatus("Delete cancelled");
			return;
		}

		await this.#deleteSession(sessionFile);

		// Show session selector
		this.ctx.showStatus("Current session transcript and artifacts deleted");
		await this.showSessionSelector();
	}

	async #handlePostLoginModelProfileRecommendation(providerId: string): Promise<void> {
		const recommendedProfile = recommendModelProfileForProvider(
			providerId,
			this.ctx.session.modelRegistry.getModelProfiles(),
		);
		if (!recommendedProfile) {
			return;
		}

		const activeProfile = this.ctx.session.getActiveModelProfile?.() ?? this.ctx.settings.get("modelProfile.default");
		if (activeProfile) {
			this.ctx.showStatus(`Preset ${recommendedProfile.name} is available in /model.`);
			return;
		}

		const confirmed = await this.ctx.showHookConfirm(`Apply ${recommendedProfile.name} now?`, "");
		if (!confirmed) {
			return;
		}

		await activateModelProfile({
			session: this.ctx.session,
			modelRegistry: this.ctx.session.modelRegistry,
			settings: this.ctx.settings,
			profileName: recommendedProfile.name,
		});
	}

	async #handleOAuthLogin(providerId: string, options?: OAuthSelectorOptions): Promise<void> {
		const manualCode = options?.manualCode === true;
		if (manualCode && !MANUAL_CODE_PROVIDERS.has(providerId)) {
			this.ctx.showError(
				`${providerId} has no paste-a-code login. Supported: ${[...MANUAL_CODE_PROVIDERS].join(", ")}.`,
			);
			return;
		}
		this.ctx.showStatus(`Logging in to ${providerId}…`);
		const manualInput = this.ctx.oauthManualInput;
		const useManualInput = CALLBACK_SERVER_PROVIDERS.has(providerId as OAuthProvider);
		if (providerId === "opencodex") {
			this.ctx.showStatus("Checking the local OpenCodex proxy…");
		}
		try {
			await this.ctx.session.modelRegistry.authStorage.login(
				providerId as OAuthProvider,
				{
					onAuth: (info: { url: string; instructions?: string }) => {
						this.ctx.chatContainer.addChild(new Spacer(1));
						this.ctx.chatContainer.addChild(new Text(theme.fg("dim", info.url), 1, 0));
						const hyperlink = `\x1b]8;;${info.url}\x07Click here to login\x1b]8;;\x07`;
						this.ctx.chatContainer.addChild(new Text(theme.fg("accent", hyperlink), 1, 0));
						if (info.instructions) {
							this.ctx.chatContainer.addChild(new Spacer(1));
							this.ctx.chatContainer.addChild(new Text(theme.fg("warning", info.instructions), 1, 0));
						}
						if (useManualInput) {
							this.ctx.chatContainer.addChild(new Spacer(1));
							this.ctx.chatContainer.addChild(
								new Text(theme.fg("dim", manualCode ? MANUAL_CODE_LOGIN_TIP : MANUAL_LOGIN_TIP), 1, 0),
							);
						}
						this.ctx.ui.requestRender();
						this.ctx.openInBrowser(info.url);
					},
					onPrompt: async (prompt: { message: string; placeholder?: string }) => {
						this.ctx.chatContainer.addChild(new Spacer(1));
						this.ctx.chatContainer.addChild(new Text(theme.fg("warning", prompt.message), 1, 0));
						if (prompt.placeholder) {
							this.ctx.chatContainer.addChild(new Text(theme.fg("dim", prompt.placeholder), 1, 0));
						}
						this.ctx.ui.requestRender();
						const { promise, resolve } = Promise.withResolvers<string>();
						const codeInput = new Input();
						codeInput.onSubmit = () => {
							const code = codeInput.getValue();
							this.ctx.editorContainer.clear();
							this.ctx.editorContainer.addChild(this.ctx.editor);
							this.ctx.ui.setFocus(this.ctx.editor);
							resolve(code);
						};
						this.ctx.editorContainer.clear();
						this.ctx.editorContainer.addChild(codeInput);
						this.ctx.ui.setFocus(codeInput);
						this.ctx.ui.requestRender();
						return promise;
					},
					onProgress: (message: string) => {
						this.ctx.chatContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
						this.ctx.ui.requestRender();
					},
					onManualCodeInput: useManualInput ? () => manualInput.waitForInput(providerId) : undefined,
				},
				{ manualCode },
			);
			await this.ctx.session.modelRegistry.refresh();
			this.ctx.chatContainer.addChild(new Spacer(1));
			const successMessage =
				providerId === "opencodex"
					? `${theme.status.success} OpenCodex proxy status checked`
					: `${theme.status.success} Successfully logged in to ${providerId}`;
			this.ctx.chatContainer.addChild(new Text(theme.fg("success", successMessage), 1, 0));
			if (providerId !== "opencodex") {
				this.ctx.chatContainer.addChild(
					new Text(theme.fg("dim", `Credentials saved to ${getAgentDbPath()}`), 1, 0),
				);
				await this.#handlePostLoginModelProfileRecommendation(providerId);
			}
			this.ctx.ui.requestRender();
		} catch (error: unknown) {
			this.ctx.showError(`Login failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			if (useManualInput) {
				manualInput.clear(`Manual OAuth input cleared for ${providerId}`);
			}
		}
	}

	async #handleOAuthLogout(providerId: string): Promise<void> {
		try {
			await this.ctx.session.modelRegistry.authStorage.logout(providerId);
			await this.ctx.session.modelRegistry.refresh();
			this.ctx.chatContainer.addChild(new Spacer(1));
			this.ctx.chatContainer.addChild(
				new Text(theme.fg("success", `${theme.status.success} Successfully logged out of ${providerId}`), 1, 0),
			);
			this.ctx.chatContainer.addChild(
				new Text(theme.fg("dim", `Credentials removed from ${getAgentDbPath()}`), 1, 0),
			);
			this.ctx.ui.requestRender();
		} catch (error: unknown) {
			this.ctx.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async showOAuthSelector(
		mode: "login" | "logout",
		providerId?: string,
		options?: OAuthSelectorOptions,
	): Promise<void> {
		if (providerId) {
			const oauthProvider = getOAuthProviders().find(provider => provider.id === providerId);
			if (!oauthProvider && !this.ctx.session.modelRegistry.getModelProfiles().has(providerId)) {
				this.ctx.showError(`Unknown OAuth provider: ${providerId}`);
				return;
			}
			if (mode === "login") {
				await this.#handleOAuthLogin(providerId, options);
			} else {
				await this.#handleOAuthLogout(providerId);
			}
			return;
		}

		if (mode === "logout") {
			await this.#refreshOAuthProviderAuthState();
			const oauthProviders = getOAuthProviders();
			const loggedInProviders = oauthProviders.filter(provider =>
				this.ctx.session.modelRegistry.authStorage.hasAuth(provider.id),
			);
			if (loggedInProviders.length === 0) {
				this.ctx.showStatus("No OAuth providers logged in. Use /login first.");
				return;
			}
		}

		let externalCredentialCandidates: ImportableCredential[] = [];
		if (
			mode === "login" &&
			providerId === undefined &&
			options?.allowExternalCredentialDiscovery === true &&
			options.trigger === "bare-login"
		) {
			const stateStore =
				this.#credentialAutoImportStateStore ??
				createCredentialAutoImportStateStore(this.ctx.settings.getAgentDir());
			let stateRead: CredentialAutoImportStateReadResult | undefined;
			try {
				stateRead = await stateStore.read();
			} catch {
				logger.warn("Credential auto-import state read failed", { classification: "state-read-failed" });
				stateRead = { state: {}, problems: [], unreadable: true };
			}
			if (stateRead?.unreadable === true) {
				logger.warn("Credential auto-import state unavailable", { classification: "state-unreadable" });
				this.ctx.showWarning(CREDENTIAL_AUTO_IMPORT_STATE_UNREADABLE_WARNING);
			} else if (stateRead && !isCredentialAutoImportStateResolvedForVersion(stateRead.state, VERSION)) {
				const preview = await runExternalCredentialAutoImport({
					authStorage: {
						importCredentialIfAbsent: async () => ({
							inserted: false,
							reason: "skipped-existing",
							provider: "",
							entries: [],
						}),
					},
					trigger: "bare-login",
					discover: options.externalCredentialDiscover,
				});
				if (!preview.discovered) {
					this.ctx.showWarning(CREDENTIAL_AUTO_IMPORT_DISCOVERY_WARNING);
				} else {
					const result = preview.discovery ?? { importable: [], skipped: [], environment: [] };
					const candidates = filterAutoImportOAuthCredentials(result.importable);
					const previewSourceFailures = preview.failures.filter(failure => failure.credential === undefined);
					if (candidates.length === 0 && previewSourceFailures.length > 0) {
						this.ctx.showWarning(CREDENTIAL_AUTO_IMPORT_DISCOVERY_WARNING);
					} else if (candidates.length > 0) {
						const confirmed = await this.ctx.showHookConfirm(
							`Import ${candidates.length} external credential(s)?`,
							`${formatCredentialAutoImportPrompt(candidates)}\n\n${CREDENTIAL_AUTO_IMPORT_ROTATION_WARNING}`,
						);
						if (!confirmed) {
							let persisted = false;
							try {
								persisted = await stateStore.write({ initialImportResolution: "declined" });
							} catch {
								logger.warn("Credential auto-import state persistence failed", {
									classification: "state-write-failed",
								});
							}
							if (!persisted) this.ctx.showWarning(CREDENTIAL_AUTO_IMPORT_PERSISTENCE_WARNING);
						} else {
							const summary = await runExternalCredentialAutoImport({
								authStorage: this.ctx.session.modelRegistry.authStorage,
								trigger: "bare-login",
								discover: options.externalCredentialDiscover,
							});
							if (!summary.discovered) {
								logCredentialAutoImportFailures("bare-login", summary.failures);
								this.ctx.showWarning(CREDENTIAL_AUTO_IMPORT_RETRY_WARNING);
							} else {
								const secondResult = summary.discovery ?? { importable: [], skipped: [], environment: [] };
								const secondCandidates = filterAutoImportOAuthCredentials(secondResult.importable);
								const secondSourceFailures = summary.failures.filter(
									failure => failure.credential === undefined,
								);
								const handledCandidates = summary.imported.length + summary.skipped.length > 0;
								if (handledCandidates || (secondCandidates.length === 0 && secondSourceFailures.length === 0)) {
									let persisted = false;
									try {
										persisted = await stateStore.write({
											initialImportResolution: "accepted",
											lastImportVersion: VERSION,
										});
									} catch {
										logger.warn("Credential auto-import state persistence failed", {
											classification: "state-write-failed",
										});
									}
									if (!persisted) this.ctx.showWarning(CREDENTIAL_AUTO_IMPORT_PERSISTENCE_WARNING);
									externalCredentialCandidates = summary.imported.map(credential => ({
										...credential,
										source: formatCredentialAutoImportCandidateLabel(credential),
									}));
									if (!handledCandidates) {
										this.ctx.showStatus("External credentials were no longer available to import.");
									}
									if (summary.imported.length > 0) {
										try {
											await this.ctx.session.modelRegistry.refresh("offline");
										} catch {
											logger.warn("Credential auto-import refresh failed", {
												classification: "refresh-failed",
											});
											this.ctx.showWarning(CREDENTIAL_AUTO_IMPORT_REFRESH_WARNING);
										}
									}
									if (handledCandidates && summary.failures.length > 0) {
										logCredentialAutoImportFailures("bare-login", summary.failures);
										this.ctx.showWarning(CREDENTIAL_AUTO_IMPORT_RETRY_WARNING);
									}
								} else if (secondCandidates.length > 0 && summary.failures.length > 0) {
									logCredentialAutoImportFailures("bare-login", summary.failures);
									this.ctx.showWarning(CREDENTIAL_AUTO_IMPORT_RETRY_WARNING);
								} else {
									this.ctx.showWarning(CREDENTIAL_AUTO_IMPORT_DISCOVERY_WARNING);
								}
							}
						}
					}
				}
			}
		}
		this.showSelector(done => {
			let selector: OAuthSelectorComponent;
			selector = new OAuthSelectorComponent(
				mode,
				this.ctx.session.modelRegistry.authStorage,
				async (selectedProviderId: string) => {
					selector.stopValidation();
					done();
					if (mode === "login") {
						await this.#handleOAuthLogin(selectedProviderId);
					} else {
						await this.#handleOAuthLogout(selectedProviderId);
					}
				},
				() => {
					selector.stopValidation();
					done();
					this.ctx.ui.requestRender();
				},
				{
					validateAuth: async (selectedProviderId: string) => {
						const apiKey = await this.ctx.session.modelRegistry.getApiKeyForProvider(
							selectedProviderId,
							this.ctx.session.sessionId,
						);
						return !!apiKey;
					},
					requestRender: () => {
						this.ctx.ui.requestRender();
					},
					externalCredentialCandidates,
				},
			);
			return { component: selector, focus: selector };
		});
	}

	showDebugSelector(): void {
		this.showSelector(done => {
			const selector = new DebugSelectorComponent(this.ctx, done);
			return { component: selector, focus: selector };
		});
	}

	showSessionObserver(registry: SessionObserverRegistry): void {
		const observeKeys = this.ctx.keybindings.getKeys("app.session.observe");
		let cleanup: (() => void) | undefined;
		let overlayHandle: OverlayHandle | undefined;

		const done = () => {
			cleanup?.();
			overlayHandle?.hide();
			this.ctx.ui.requestRender();
		};

		const selector = new SessionObserverOverlayComponent(registry, done, observeKeys);

		cleanup = registry.onChange(() => {
			selector.refreshFromRegistry();
			this.ctx.ui.requestRender();
		});

		overlayHandle = this.ctx.ui.showOverlay(selector, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
		this.ctx.ui.setFocus(selector);
		this.ctx.ui.requestRender();
	}

	async showSessionsDashboard(): Promise<void> {
		if (this.#sessionsDashboardOpen) {
			if (this.#sessionsDashboard) this.ctx.ui.setFocus(this.#sessionsDashboard);
			return;
		}
		this.#sessionsDashboardOpen = true;
		try {
			const sessions = dashboardSessions(await SessionManager.listAll());
			let overlayHandle: OverlayHandle | undefined;
			const dashboard = new SessionsDashboardComponent(
				sessions,
				() => {
					this.#sessionsDashboardOpen = false;
					this.#sessionsDashboard = undefined;
					overlayHandle?.hide();
					this.ctx.ui.setFocus(this.ctx.editor);
					this.ctx.ui.requestRender();
				},
				() => this.ctx.ui.requestRender(),
			);
			this.#sessionsDashboard = dashboard;
			overlayHandle = this.ctx.ui.showOverlay(dashboard, {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
			});
			this.ctx.ui.setFocus(dashboard);
			this.ctx.ui.requestRender();
		} catch (error) {
			this.#sessionsDashboardOpen = false;
			throw error;
		}
	}

	showTranscriptViewer(registry: TranscriptItemRegistry): void {
		if (this.#transcriptViewerOpen) return;
		this.#transcriptViewerOpen = true;
		let overlayHandle: OverlayHandle | undefined;
		const viewer = new TranscriptViewerOverlay({
			title: "Transcript",
			getEntries: () => transcriptViewerEntries(registry),
			onClose: () => {
				this.#transcriptViewerOpen = false;
				this.#transcriptViewer = undefined;
				overlayHandle?.hide();
				this.ctx.ui.setFocus(this.ctx.editor);
				this.ctx.ui.requestRender(true);
			},
			requestRender: () => this.ctx.ui.requestRender(),
			copyToClipboard: this.clipboard,
		});
		this.#transcriptViewer = viewer;
		overlayHandle = this.ctx.ui.showOverlay(viewer, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
		this.ctx.ui.setFocus(viewer);
		this.ctx.ui.requestRender();
	}

	showPlanPreview(content: string | null, options?: PlanPreviewOptions): Promise<PlanPreviewResult> {
		return new Promise(resolve => {
			let overlayHandle: OverlayHandle | undefined;
			const overlay = new PlanPreviewOverlay(
				content,
				result => {
					overlayHandle?.hide();
					this.ctx.ui.setFocus(this.ctx.editor);
					this.ctx.ui.requestRender(true);
					resolve(result);
				},
				() => this.ctx.ui.requestRender(),
				options,
			);
			overlayHandle = this.ctx.ui.showOverlay(overlay, {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
			});
			this.ctx.ui.setFocus(overlay);
			this.ctx.ui.requestRender();
		});
	}

	/**
	 * Jobs overlay: navigate ongoing monitor + cron jobs (Monitors then Crons,
	 * newest-first), drill into per-type detail, and cancel/delete with a y/N
	 * confirm. Built from nested SelectLists (list -> detail -> confirm) so focus
	 * stays on the active SelectList.
	 */
	showJobsOverlay(observer: JobsObserver): void {
		let overlay: JobsOverlayComponent | undefined;
		const close = () => {
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(this.ctx.editor);
			this.ctx.ui.requestRender();
		};
		overlay = new JobsOverlayComponent(observer, {
			close,
			requestRender: () => {
				if (overlay) this.ctx.ui.setFocus(overlay.getFocus());
				this.ctx.ui.requestRender();
			},
		});
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(overlay);
		this.ctx.ui.setFocus(overlay.getFocus());
		this.ctx.ui.requestRender();
	}

	showTasksPane(aggregator: TasksAggregator): void {
		if (this.#closeTasksPane) {
			this.#closeTasksPane();
			return;
		}
		let unsubscribe: (() => void) | undefined;
		const close = () => {
			unsubscribe?.();
			this.#tasksPane = undefined;
			this.#closeTasksPane = undefined;
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(this.ctx.editor);
			this.ctx.ui.requestRender();
		};
		this.#closeTasksPane = close;
		this.#tasksPane = new TasksPaneComponent(aggregator, {
			close,
			requestRender: () => {
				if (this.#tasksPane) this.ctx.ui.setFocus(this.#tasksPane.getFocus());
				this.ctx.ui.requestRender();
			},
		});
		unsubscribe = aggregator.onChange(() => this.#tasksPane?.refresh());
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(this.#tasksPane);
		this.ctx.ui.setFocus(this.#tasksPane.getFocus());
		this.ctx.ui.requestRender();
	}
}

import * as path from "node:path";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { getOAuthProviders } from "@gajae-code/ai/utils/oauth";
import type { OAuthProvider } from "@gajae-code/ai/utils/oauth/types";
import type { Component, OverlayHandle, SlashCommand } from "@gajae-code/tui";
import { Input, isPetMode, Loader, Spacer, Text } from "@gajae-code/tui";
import { getAgentDbPath, getProjectDir, logger, VERSION } from "@gajae-code/utils";
import { type AppKeybinding, formatKeyHints } from "../../config/keybindings";
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
import { type Settings, settings } from "../../config/settings";
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
import type { InteractiveModeContext, OAuthSelectorOptions } from "../../modes/types";
import { getNotificationConfig, isTelegramConfigured, maskToken } from "../../sdk/bus/config";
import {
	clearTelegramActivationMarker,
	createTelegramActivationMarker,
	observedTelegramActivationMarker,
	persistTelegramActivationMarker,
	proposedTelegramIdentity,
	reconcileCommittedTelegramConfiguration,
	removeTelegramConfiguration,
	saveTelegramInactive,
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
	readDaemonState,
	unregisterNotificationRoot,
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
	isConfigurableSearchProviderId,
	isSearchProviderPreference,
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
import { JobsOverlayComponent } from "../components/jobs-overlay";
import { ModelSelectorComponent } from "../components/model-selector";
import type {
	NotificationsEditorOperations,
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

export interface NotificationsEditorOperationDependencies {
	getNotificationConfig: typeof getNotificationConfig;
	maskToken: typeof maskToken;
	buildNotificationStatusReport: typeof buildNotificationStatusReport;
	checkNotificationHealth: typeof checkNotificationHealth;
	sendNotificationTest: typeof sendNotificationTest;
	recoverNotifications: typeof recoverNotifications;
	sanitizeDiagnostic: typeof sanitizeDiagnostic;
	ensureTelegramDaemonRunningDetailed: typeof ensureTelegramDaemonRunningDetailed;
	runTelegramSetup: typeof runTelegramSetup;
	proposedTelegramIdentity: typeof proposedTelegramIdentity;
	reconcileCommittedTelegramConfiguration: typeof reconcileCommittedTelegramConfiguration;
	saveTelegramInactive: typeof saveTelegramInactive;
	removeTelegramConfiguration: typeof removeTelegramConfiguration;
	unregisterNotificationRoot: typeof unregisterNotificationRoot;
	reloadTelegramDaemon(settings: Settings): Promise<{ ok: boolean; message: string }>;
	restartTelegramDaemon(settings: Settings): Promise<{ ok: boolean; message: string }>;
	stopTelegramDaemon(settings: Settings): Promise<{
		ok: boolean;
		message: string;
		before?: { health?: string };
	}>;
}

const notificationEditorOperationDependencies: NotificationsEditorOperationDependencies = {
	getNotificationConfig,
	maskToken,
	buildNotificationStatusReport,
	checkNotificationHealth,
	sendNotificationTest,
	recoverNotifications,
	sanitizeDiagnostic,
	ensureTelegramDaemonRunningDetailed,
	runTelegramSetup,
	proposedTelegramIdentity,
	reconcileCommittedTelegramConfiguration,
	saveTelegramInactive,
	removeTelegramConfiguration,
	unregisterNotificationRoot,
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
		effectiveEnabled: false,
		running: false,
		environment: "off",
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
	const telegramSetupPreflight = async (): Promise<TelegramSetupPreflight> => {
		const storedChatId = services.getNotificationConfig(ctx.settings).chatId;
		try {
			const state = await readDaemonState(ctx.settings);
			const validPid = Number.isSafeInteger(state?.pid) && (state?.pid ?? 0) > 0;
			if (!state || !validPid) return { storedChatId };
			let live = false;
			try {
				process.kill(state.pid, 0);
				live = true;
			} catch (error) {
				live = (error as NodeJS.ErrnoException).code === "EPERM";
			}
			return live
				? {
						storedChatId,
						daemon: {
							live,
							tokenFingerprint: typeof state.tokenFingerprint === "string" ? state.tokenFingerprint : undefined,
							chatId: typeof state.chatId === "string" && state.chatId.trim() ? state.chatId.trim() : undefined,
						},
					}
				: { storedChatId };
		} catch {
			return { storedChatId };
		}
	};

	return {
		loadState: async () => {
			const config = services.getNotificationConfig(ctx.settings);
			return {
				status: services.buildNotificationStatusReport(ctx.settings),
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
				},
			};
		},

		refreshHealth: async ({ probe, signal }) => {
			if (signal?.aborted) throw new Error("Notification health refresh cancelled.");
			try {
				const input: Parameters<typeof checkNotificationHealth>[0] & { signal?: AbortSignal } = {
					settings: ctx.settings,
					stateRoot: path.join(ctx.sessionManager.getCwd(), ".gjc", "state"),
					probe,
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

		sendTest: async () => {
			try {
				const result = await services.sendNotificationTest({ settings: ctx.settings });
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
			try {
				const inactiveMarkerToClear = observedTelegramActivationMarker(ctx.settings, token, draft.chatId);
				const receipt = await ctx.settings.commitAtomicBatch([
					{ path: "notifications.enabled", op: "set", value: true },
					{ path: "notifications.telegram.botToken", op: "set", value: token },
					{ path: "notifications.telegram.chatId", op: "set", value: draft.chatId },
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
				await notifyAfterDurableCommit();
				if (activation.status === "blocked_identity") {
					return {
						status: "blocked_identity" as const,
						receipt,
						message: services.sanitizeDiagnostic(activation.message, token),
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
				return {
					status: "saved" as const,
					receipt,
					message: services.sanitizeDiagnostic("Telegram configuration saved and reconciled.", token),
				};
			} catch (error) {
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
				await notifyAfterDurableCommit();
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

		enableGlobally: async () => {
			try {
				const receipt = await ctx.settings.commitAtomicBatch([
					{ path: "notifications.enabled", op: "set", value: true },
				]);
				await notifyAfterDurableCommit();
				return { receipt, message: "Global notifications enabled using stored configuration." };
			} catch (error) {
				throw notificationOperationError(services, error, services.getNotificationConfig(ctx.settings).botToken);
			}
		},

		disableGlobally: async () => {
			try {
				const receipt = await ctx.settings.commitAtomicBatch([
					{ path: "notifications.enabled", op: "set", value: false },
				]);
				await notifyAfterDurableCommit();
				return { receipt, message: "Global notifications disabled." };
			} catch (error) {
				throw notificationOperationError(services, error, services.getNotificationConfig(ctx.settings).botToken);
			}
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
							const unregistered = await services.unregisterNotificationRoot({
								settings: ctx.settings,
								cwd: ctx.sessionManager.getCwd(),
								sessionId: ctx.sessionManager.getSessionId(),
							});
							if (unregistered.remainingRoots === 0) {
								const stopped = await new TelegramDaemonController(ctx.settings).stop();
								if (!stopped.ok) throw new Error(stopped.message);
							}
						},
					},
				});
				if (runtimePrepared && controller) {
					await controller.clearBlockedRuntime(sessionContext());
					await controller.reconcileCurrentSession(sessionContext());
				}
				await notifyAfterDurableCommit();
				return {
					receipt: result.receipt,
					globallyDisabled: result.globallyDisabled,
					message: result.globallyDisabled
						? "Telegram configuration removed and global notifications disabled."
						: "Telegram configuration removed; Discord or Slack configuration was preserved.",
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
					isTelegramConfigured(before) && before.toolActivity.enabled && !preferences.toolActivityEnabled;
				if (disablingToolActivity) {
					const stopped = await services.stopTelegramDaemon(ctx.settings);
					if (!stopped.ok)
						throw new Error(
							`Notification preferences were not saved because daemon stop failed: ${stopped.message}`,
						);
					daemonWasRunningForDisable = stopped.before?.health === "running";
				}

				let receipt: Awaited<ReturnType<typeof ctx.settings.commitAtomicBatch>>;
				try {
					receipt = await ctx.settings.commitAtomicBatch([
						{ path: "notifications.redact", op: "set", value: preferences.redact },
						{ path: "notifications.verbosity", op: "set", value: preferences.verbosity },
						{ path: "notifications.sessionScope", op: "set", value: preferences.sessionScope },
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

				const config = services.getNotificationConfig(ctx.settings);
				if (isTelegramConfigured(config)) {
					const reload = daemonWasRunningForDisable
						? await services.restartTelegramDaemon(ctx.settings)
						: await services.reloadTelegramDaemon(ctx.settings);
					if (!reload.ok)
						throw new Error(`Notification preferences were saved, but daemon reload failed: ${reload.message}`);
				}
				await notifyAfterDurableCommit();
				return { receipt, message: "Notification preferences saved atomically." };
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
		const done = () => {
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
				keybinding: formatKeyHints(this.ctx.keybindings.getKeys(action.id as AppKeybinding)) || undefined,
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
				selection => {
					done();

					const { level, persistDefault } = selection;
					const configuredDefault = this.ctx.settings.get("defaultThinkingLevel");
					const levelToApply = level === ThinkingLevel.Inherit ? configuredDefault : level;
					this.ctx.session.setThinkingLevel(levelToApply, persistDefault);
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
					},
					{
						onChange: (id, value) => this.handleSettingChange(id, value),
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
				const selector = new ThemeSelectorComponent(
					initialTheme,
					availableThemes,
					themeName => {
						const settingPath = getDetectedThemeSettingsPath();
						settings.set(settingPath, themeName);
						this.#refreshThemeUi();
						done();
					},
					() => {
						void restoreThemePreview(initialTheme).then(result => {
							if (!result.success && result.error) {
								this.ctx.showError(`Failed to restore theme preview: ${result.error}`);
							}
							this.#refreshThemeUi();
						});
						done();
					},
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
					this.ctx.setPetMode(mode);
					done();
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
				setTheme(value as string, true).then(result => {
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
				if (
					value === "auto" ||
					value === "openai" ||
					value === "gemini" ||
					value === "openrouter" ||
					value === "antigravity"
				) {
					setPreferredImageProvider(value);
				}
				break;

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
			modelSelector = new ModelSelectorComponent(
				this.ctx.ui,
				this.ctx.session.model,
				this.ctx.settings,
				this.ctx.session.modelRegistry,
				this.ctx.session.scopedModels,
				async selection => {
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
						} else if (selection.roles) {
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
							materializeActiveModelProfileAssignment({
								session: this.ctx.session,
								settings: this.ctx.settings,
								role,
								selector: value,
							});
							if (thinkingLevel && thinkingLevel !== ThinkingLevel.Inherit) {
								this.ctx.session.setThinkingLevel(thinkingLevel);
							}
							modelSelector.refreshRoleAssignments({
								currentModel: this.ctx.session.model,
								currentThinkingLevel: this.ctx.session.thinkingLevel,
								activeModelProfile:
									this.ctx.session.getActiveModelProfile?.() ?? this.ctx.settings.get("modelProfile.default"),
							});
							this.ctx.statusLine.invalidate();
							this.ctx.updateEditorBorderColor();
							this.ctx.showStatus(`Default model: ${selectedSelector ?? model.id}`);
							done();
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
							this.ctx.showStatus(`${role} agent model: ${value}`);
							done();
							this.ctx.ui.requestRender();
						}
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
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
					const originalOnEscape = this.ctx.editor.onEscape;

					if (wantsSummary) {
						this.ctx.editor.onEscape = () => {
							this.ctx.session.abortBranchSummary();
						};
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
						if (result.editorText && !this.ctx.editor.getText().trim()) {
							this.ctx.editor.setText(result.editorText);
						}
						this.ctx.showStatus("Navigated to selected point");
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							this.ctx.statusContainer.clear();
						}
						this.ctx.editor.onEscape = originalOnEscape;
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
		this.showSelector(done => {
			const selector = new SessionSelectorComponent(
				sessions,
				async sessionPath => {
					done();
					await this.handleResumeSession(sessionPath);
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

	#clearTransientSessionUi(): void {
		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
		}
		this.ctx.statusContainer.clear();
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
		if (!detached) {
			return false;
		}
		this.ctx.resetIrcSidebarSession();

		this.#refreshSessionTerminalTitle();

		this.#clearTransientSessionUi();
		this.ctx.statusLine.invalidate();
		this.ctx.statusLine.setSessionStartTime(Date.now());
		this.ctx.updateEditorTopBorder();
		this.ctx.updateEditorBorderColor();
		this.ctx.rebuildInitialMessages("replace-identity");
		await this.ctx.reloadTodos();
		this.ctx.ui.requestRender();
		return true;
	}

	async handleResumeSession(sessionPath: string): Promise<void> {
		const previousSessionId = this.ctx.sessionManager.getSessionId();
		this.#clearTransientSessionUi();
		const migrationPolicy =
			this.ctx.settings?.get("session.directoryMigration") === "disabled" ? "disabled" : "copy-retain";
		let writableSessionPath = sessionPath;
		if (this.ctx.sessionManager.isManagedDestination()) {
			const inspection = await SessionManager.inspectSessionTailReadOnly(sessionPath);
			if (inspection.kind === "error") throw new Error(`Could not inspect selected session: ${inspection.reason}`);
			writableSessionPath = await this.ctx.sessionManager.prepareManagedCandidateForStrictAdoption(
				sessionPath,
				migrationPolicy,
				inspection.identity,
			);
		}
		// Switch session via AgentSession (emits hook and tool session events)
		if (!(await this.ctx.session.switchSession(writableSessionPath))) return;
		const switchingToDifferentSession = previousSessionId !== this.ctx.sessionManager.getSessionId();
		if (switchingToDifferentSession) this.ctx.resetIrcSidebarSession();
		this.#refreshSessionTerminalTitle();
		this.ctx.updateEditorBorderColor();

		this.ctx.rebuildInitialMessages(switchingToDifferentSession ? "replace-identity" : "reconcile-same-transcript");
		await this.ctx.reloadTodos();
		this.ctx.showStatus("Resumed session");
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

	async #handleOAuthLogin(providerId: string): Promise<void> {
		this.ctx.showStatus(`Logging in to ${providerId}…`);
		const manualInput = this.ctx.oauthManualInput;
		const useManualInput = CALLBACK_SERVER_PROVIDERS.has(providerId as OAuthProvider);
		try {
			await this.ctx.session.modelRegistry.authStorage.login(providerId as OAuthProvider, {
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
						this.ctx.chatContainer.addChild(new Text(theme.fg("dim", MANUAL_LOGIN_TIP), 1, 0));
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
			});
			await this.ctx.session.modelRegistry.refresh();
			this.ctx.chatContainer.addChild(new Spacer(1));
			this.ctx.chatContainer.addChild(
				new Text(theme.fg("success", `${theme.status.success} Successfully logged in to ${providerId}`), 1, 0),
			);
			this.ctx.chatContainer.addChild(new Text(theme.fg("dim", `Credentials saved to ${getAgentDbPath()}`), 1, 0));
			await this.#handlePostLoginModelProfileRecommendation(providerId);
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
				await this.#handleOAuthLogin(providerId);
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

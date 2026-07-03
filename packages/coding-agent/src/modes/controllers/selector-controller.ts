import { ThinkingLevel } from "@gajae-code/agent-core";
import { getOAuthProviders } from "@gajae-code/ai/utils/oauth";
import type { OAuthProvider } from "@gajae-code/ai/utils/oauth/types";
import type { Component, OverlayHandle } from "@gajae-code/tui";
import { Input, Loader, Spacer, Text } from "@gajae-code/tui";
import { getAgentDbPath, getProjectDir } from "@gajae-code/utils";
import {
	activateModelProfile,
	type MaterializeModelProfileForDeletionResult,
	materializeActiveModelProfileAssignment,
	materializeModelProfileForDeletion,
	restoreMaterializedModelProfileForDeletion,
} from "../../config/model-profile-activation";
import { formatModelProfileDisplayLabel, recommendModelProfileForProvider } from "../../config/model-profiles";
import { GJC_MODEL_ASSIGNMENT_TARGETS } from "../../config/model-registry";
import { formatModelSelectorValue } from "../../config/model-resolver";
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
import { type SessionInfo, SessionManager } from "../../session/session-manager";
import { FileSessionStorage } from "../../session/session-storage";
import {
	CREDENTIAL_AUTO_IMPORT_ROTATION_WARNING,
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
import { setSessionTerminalTitle } from "../../utils/title-generator";
import { AgentDashboard } from "../components/agent-dashboard";
import { AssistantMessageComponent } from "../components/assistant-message";
import {
	CustomModelPresetWizardComponent,
	type CustomModelPresetWizardSubmit,
} from "../components/custom-model-preset-wizard";
import { CustomProviderWizardComponent, type CustomProviderWizardSubmit } from "../components/custom-provider-wizard";
import { ExtensionDashboard } from "../components/extensions";
import { HistorySearchComponent } from "../components/history-search";
import { JobsOverlayComponent } from "../components/jobs-overlay";
import { ModelSelectorComponent } from "../components/model-selector";
import { OAuthSelectorComponent } from "../components/oauth-selector";
import { PluginSelectorComponent } from "../components/plugin-selector";
import {
	type ProviderOnboardingAction,
	ProviderOnboardingSelectorComponent,
} from "../components/provider-onboarding-selector";
import { SessionObserverOverlayComponent } from "../components/session-observer-overlay";
import { SessionSelectorComponent } from "../components/session-selector";
import { SettingsSelectorComponent } from "../components/settings-selector";
import type { StatusLineSettings } from "../components/status-line";
import { ThemeSelectorComponent } from "../components/theme-selector";
import { ToolExecutionComponent } from "../components/tool-execution";
import { TreeSelectorComponent } from "../components/tree-selector";
import { UserMessageSelectorComponent } from "../components/user-message-selector";
import type { JobsObserver } from "../jobs-observer";
import type { SessionObserverRegistry } from "../session-observer-registry";

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

export class SelectorController {
	constructor(private ctx: InteractiveModeContext) {}

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
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(this.ctx.editor);
		};
		const { component, focus } = create(done);
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(component);
		this.ctx.ui.setFocus(focus);
		this.ctx.ui.requestRender();
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
					done();
					this.ctx.ui.requestRender();
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					wizard.setSubmitError(`Provider setup failed: ${message}`);
				}
			};
			wizard = new CustomProviderWizardComponent(
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

	showSettingsSelector(): void {
		getAvailableThemes().then(availableThemes => {
			this.showSelector(done => {
				const selector = new SettingsSelectorComponent(
					{
						availableThinkingLevels: [...this.ctx.session.getAvailableThinkingLevels()],
						thinkingLevel: this.ctx.session.thinkingLevel,
						availableThemes,
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
			defaultModelPattern,
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
				this.ctx.chatContainer.clear();
				this.ctx.rebuildChatFromMessages();
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
							const profileLabel = formatModelProfileDisplayLabel(
								this.ctx.session.modelRegistry.getModelProfile(selection.profileName) ?? {
									name: selection.profileName,
								},
							);
							await activateModelProfile(
								{
									session: this.ctx.session,
									modelRegistry: this.ctx.session.modelRegistry,
									settings: this.ctx.settings,
									profileName: selection.profileName,
								},
								{ persistDefault: selection.setDefault },
							);
							this.ctx.statusLine.invalidate();
							this.ctx.updateEditorBorderColor();
							this.ctx.showStatus(
								selection.setDefault
									? `Default model profile: ${profileLabel}`
									: `Model profile: ${profileLabel}`,
							);
							done();
							this.ctx.ui.requestRender();
							return;
						}
						const { model, role, thinkingLevel, selector: selectedSelector } = selection;
						if (role === null) {
							// Temporary: update agent state but don't persist to settings
							await this.ctx.session.setModelTemporary(model, thinkingLevel);
							this.ctx.statusLine.invalidate();
							this.ctx.updateEditorBorderColor();
							this.ctx.showStatus(`Temporary model: ${selectedSelector ?? model.id}`);
							done();
							this.ctx.ui.requestRender();
						} else if (role === "default") {
							// Default: update agent state and persist as the active default model.
							await this.ctx.session.setModel(model, role, {
								selector: selectedSelector,
								thinkingLevel,
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
							const materializedProfile = materializeActiveModelProfileAssignment({
								session: this.ctx.session,
								settings: this.ctx.settings,
								role,
								selector: value,
							});
							if (!materializedProfile) {
								const target = GJC_MODEL_ASSIGNMENT_TARGETS[role];
								if (target.settingsPath === "modelRoles") {
									this.ctx.settings.setModelRole(role, value);
								} else {
									const overrides = this.ctx.settings.get("task.agentModelOverrides");
									this.ctx.settings.set("task.agentModelOverrides", { ...overrides, [role]: value });
								}
							}
							modelSelector.refreshRoleAssignments({
								currentModel: this.ctx.session.model,
								currentThinkingLevel: this.ctx.session.thinkingLevel,
								activeModelProfile:
									this.ctx.session.getActiveModelProfile?.() ?? this.ctx.settings.get("modelProfile.default"),
							});
							this.ctx.settings.getStorage()?.recordModelUsage(`${model.provider}/${model.id}`);
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

					this.ctx.chatContainer.clear();
					this.ctx.renderInitialMessages();
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
		const tree = this.ctx.sessionManager.getTree();
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
						this.ctx.chatContainer.clear();
						this.ctx.renderInitialMessages(result.sessionContext);
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
		const sessions = await SessionManager.list(
			this.ctx.sessionManager.getCwd(),
			this.ctx.sessionManager.getSessionDir(),
		);
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
					const storage = new FileSessionStorage();
					try {
						await storage.deleteSessionWithArtifacts(session.path);
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

	async #detachActiveSessionBeforeDeletion(sessionPath: string): Promise<boolean> {
		const currentSessionFile = this.ctx.sessionManager.getSessionFile();
		if (currentSessionFile !== sessionPath) {
			return true;
		}

		const detached = await this.ctx.session.newSession();
		if (!detached) {
			return false;
		}
		this.#refreshSessionTerminalTitle();

		this.#clearTransientSessionUi();
		this.ctx.statusLine.invalidate();
		this.ctx.statusLine.setSessionStartTime(Date.now());
		this.ctx.updateEditorTopBorder();
		this.ctx.updateEditorBorderColor();
		this.ctx.renderInitialMessages();
		await this.ctx.reloadTodos();
		this.ctx.ui.requestRender();
		return true;
	}

	async handleResumeSession(sessionPath: string): Promise<void> {
		this.#clearTransientSessionUi();

		// Switch session via AgentSession (emits hook and tool session events)
		await this.ctx.session.switchSession(sessionPath);
		this.#refreshSessionTerminalTitle();
		this.ctx.updateEditorBorderColor();

		// Clear and re-render the chat
		this.ctx.chatContainer.clear();
		this.ctx.renderInitialMessages();
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
			"Delete Session",
			"This will permanently delete the current session.\nYou will be returned to the session selector.",
		);

		if (!confirmed) {
			this.ctx.showStatus("Delete cancelled");
			return;
		}

		if (!(await this.#detachActiveSessionBeforeDeletion(sessionFile))) {
			this.ctx.showStatus("Delete cancelled");
			return;
		}

		// Delete the session file and artifacts directory
		await storage.deleteSessionWithArtifacts(sessionFile);

		// Show session selector
		this.ctx.showStatus("Session deleted");
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
			const result = preview.discovery ?? { importable: [], skipped: [], environment: [] };
			const candidates = filterAutoImportOAuthCredentials(result.importable);
			if (candidates.length > 0) {
				const confirmed = await this.ctx.showHookConfirm(
					`Import ${candidates.length} external credential(s)?`,
					`${formatDiscoverySummary({ ...result, importable: candidates }).join("\n")}\n\n${CREDENTIAL_AUTO_IMPORT_ROTATION_WARNING}`,
				);
				if (confirmed) {
					const summary = await runExternalCredentialAutoImport({
						authStorage: this.ctx.session.modelRegistry.authStorage,
						trigger: "bare-login",
						discover: options.externalCredentialDiscover,
					});
					externalCredentialCandidates = summary.imported;
					if (externalCredentialCandidates.length > 0) {
						await this.ctx.session.modelRegistry.refresh("offline");
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
}

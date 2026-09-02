import { ThinkingLevel } from "@gajae-code/agent-core";
import { getSupportedEfforts, type Model, modelSupportsServiceTier, modelsAreEqual } from "@gajae-code/ai/core";
import {
	Container,
	fuzzyFilter,
	getKeybindings,
	Input,
	matchesKey,
	Spacer,
	type Tab,
	TabBar,
	Text,
	type TUI,
	truncateToWidth,
} from "@gajae-code/tui";
import { sanitizeText } from "@gajae-code/utils";
import {
	type AutoroutingProviderOrderHint,
	type AutoroutingSetup,
	autoroutingProviderOrderHint,
	evaluateAutoroutingProvenanceState,
	normalizeTierMap,
	validateAutoroutingSetup,
} from "../../config/autorouting-contract";
import {
	getProxyRoutableProviders,
	inspectProxyProviderId,
	requiresQualifiedModelProfileRoleResolution,
	resolveProxyMode,
	rewriteSelectorForProxy,
	tryResolveProxyProviderId,
} from "../../config/model-profile-activation";

import { isModelProfileProviderAvailable } from "../../config/model-profile-contract";
import {
	deriveModelProfileMappedProviders,
	getModelProfilePresentation,
	groupModelProfilesForPresetLanding,
	type ModelProfileDefinition,
	resolveProfileBindings,
} from "../../config/model-profiles";
import type { GjcModelAssignmentTargetId, ModelRegistry } from "../../config/model-registry";
import {
	GJC_MODEL_ASSIGNMENT_TARGET_IDS,
	GJC_MODEL_ASSIGNMENT_TARGETS,
	isAuthenticated,
	kNoAuth,
	requiresExplicitThinkingChoice,
} from "../../config/model-registry";
import {
	formatModelSelectorValue,
	resolveConfiguredModelPatterns,
	resolveModelChainWithAuth,
	resolveModelRoleValue,
	type ScopedModelSelection,
} from "../../config/model-resolver";
import { type ModelSelectorValue, normalizeModelSelectorValue, selectorHead } from "../../config/model-selector-value";
import type { ModelProfileConfig } from "../../config/models-config-schema";
import { getProviderAuthHealth } from "../../config/provider-auth-health";
import { compareRankedProviders, type ProviderAuthState } from "../../config/provider-ranking";
import type { Settings } from "../../config/settings";
import { type ThemeColor, theme } from "../../modes/theme/theme";
import { formatModelOnboardingInlineHint } from "../../setup/model-onboarding-guidance";
import { formatClampedModelSelector, getThinkingLevelMetadata, parseThinkingLevel } from "../../thinking";
import { getTabBarTheme } from "../shared";
import { DynamicBorder } from "./dynamic-border";
import type { SmartRoutingIntent, SmartRoutingPreview } from "./smart-routing-panel";
import { SmartRoutingPanelComponent } from "./smart-routing-panel";

function makeInvertedBadge(label: string, color: ThemeColor): string {
	const fgAnsi = theme.getFgAnsi(color);
	const bgAnsi = fgAnsi.replace(/\x1b\[38;/g, "\x1b[48;");
	return `${bgAnsi}\x1b[30m ${label} \x1b[39m\x1b[49m`;
}

function normalizeSearchText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function compactSearchText(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function getAlphaSearchTokens(query: string): string[] {
	return [...normalizeSearchText(query).matchAll(/[a-z]+/g)].map(match => match[0]).filter(token => token.length > 0);
}

function computeModelRank(model: Model, roles: Record<string, RoleAssignment | undefined>): number {
	return roles.default && modelsAreEqual(roles.default.model, model) ? 0 : 1;
}

interface ModelItem {
	kind: "provider";
	provider: string;
	id: string;
	model: Model;
	selector: string;
	thinkingLevel?: ThinkingLevel;
	explicitThinkingLevel?: boolean;
}

interface CanonicalModelItem {
	kind: "canonical";
	id: string;
	model: Model;
	selector: string;
	variantCount: number;
	searchText: string;
	normalizedSearchText: string;
	compactSearchText: string;
	thinkingLevel?: ThinkingLevel;
	explicitThinkingLevel?: boolean;
}

type ScopedModelItem = ScopedModelSelection;

interface RoleAssignment {
	model: Model;
	thinkingLevel: ThinkingLevel;
}

type RoleAssignments = Record<string, RoleAssignment | undefined>;

interface MaterializedCatalog {
	models: ModelItem[];
	canonicalModels: CanonicalModelItem[];
	roles: RoleAssignments;
}

interface ModelSelectorViewSnapshot {
	roles: RoleAssignments;
	allModels: ModelItem[];
	filteredModels: ModelItem[];
	canonicalModels: CanonicalModelItem[];
	filteredCanonicalModels: CanonicalModelItem[];
	selectedIndex: number;
	providers: ProviderTabState[];
	activeTabIndex: number;
	tabBar: TabBar | null;
}

export type ModelSelectorSelection =
	| {
			kind: "assignment";
			model: Model;
			role: GjcModelAssignmentTargetId | null;
			roles?: readonly GjcModelAssignmentTargetId[];
			thinkingLevel?: ThinkingLevel;
			selector?: string;
	  }
	| {
			kind: "profile";
			profileName: string;
			setDefault: boolean;
	  }
	| {
			kind: "createProfile";
			profile: ModelProfileConfig;
	  }
	| {
			kind: "renameProfile";
			profileName: string;
	  }
	| {
			kind: "deleteProfile";
			profileName: string;
	  }
	| {
			kind: "smartRouting";
			intent: SmartRoutingIntent;
	  };

interface PendingThinkingChoice {
	item: ModelItem | CanonicalModelItem;
	role: GjcModelAssignmentTargetId | null;
	roles?: readonly GjcModelAssignmentTargetId[];
	levels: ThinkingLevel[];
}

type RoleSelectCallback = (selection: ModelSelectorSelection) => void | Promise<void>;
type CancelCallback = () => void;

interface ProviderTabState {
	id: string;
	label: string;
	providerId?: string;
}
const ALL_TAB = "ALL";
const CANONICAL_TAB = "CANONICAL";

const STATIC_PROVIDER_TABS: ProviderTabState[] = [
	{ id: ALL_TAB, label: ALL_TAB },
	{ id: CANONICAL_TAB, label: CANONICAL_TAB },
];

function formatProviderTabLabel(providerId: string): string {
	return providerId.replace(/[-_]+/g, " ").toUpperCase();
}

function createProviderTab(providerId: string): ProviderTabState {
	return { id: providerId, label: formatProviderTabLabel(providerId), providerId };
}

type ModelSelectorViewMode = "presets" | "models" | "smart-routing";

interface PresetGroupRow {
	kind: "group";
	groupId: string;
	profiles: ModelProfileDefinition[];
}

interface PresetProfileRow {
	kind: "profile";
	groupId: string;
	profile: ModelProfileDefinition;
}

interface PresetCreateRow {
	kind: "create";
}

interface PresetCreateUnavailableRow {
	kind: "createUnavailable";
	label: string;
}

interface PresetAlreadySavedRow {
	kind: "alreadySaved";
	profile: ModelProfileDefinition;
}

interface PresetBrowseRow {
	kind: "browse";
}

interface PresetImageRoleRow {
	kind: "imageRole";
}

interface PresetSmartRoutingRow {
	kind: "smartRouting";
}

type PresetLandingRow =
	| PresetGroupRow
	| PresetProfileRow
	| PresetCreateRow
	| PresetCreateUnavailableRow
	| PresetAlreadySavedRow
	| PresetBrowseRow
	| PresetImageRoleRow
	| PresetSmartRoutingRow;

// Stable logical identity for a preset landing row, independent of its current
// list position. Used to relocate the cursor after the expanded group changes so
// navigation does not silently overshoot the destination group header/profiles.
function presetRowIdentity(row: PresetLandingRow): string {
	switch (row.kind) {
		case "group":
			return `group:${row.groupId}`;
		case "profile":
			return `profile:${row.groupId}:${row.profile.name}`;
		case "browse":
			return "browse";
		case "create":
			return "create";
		case "createUnavailable":
			return "createUnavailable";
		case "alreadySaved":
			return `alreadySaved:${row.profile.name}`;
		case "imageRole":
			return "imageRole";
		case "smartRouting":
			return "smartRouting";
	}
}

const PROFILE_ROLE_PREVIEW_ORDER: GjcModelAssignmentTargetId[] = [
	"default",
	"executor",
	"planner",
	"critic",
	"architect",
];
const PRESET_SCOPE_LABELS = ["Apply for this session", "Set as default"];
const CUSTOM_PRESET_SCOPE_LABELS = ["Apply for this session", "Set as default", "Rename", "Delete"];

function isPrintableCharacter(keyData: string): boolean {
	return keyData.length === 1 && keyData >= " " && keyData !== "\x7f";
}

function profileRequiredProviders(profile: ModelProfileDefinition): string[] {
	return [...new Set(profile.requiredProviders)].sort((a, b) => a.localeCompare(b));
}

function isInheritedRoleSelector(value: string): boolean {
	return value === "default" || value === "pi/default";
}

/** Width bound for an unresolvable selector echoed back into the assignment menu. */
const ROLE_BINDING_MAX_WIDTH = 48;

function getDefaultAliasThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
	const normalized = value?.trim();
	if (!normalized?.startsWith("pi/default:")) return undefined;
	return parseThinkingLevel(normalized.slice("pi/default:".length));
}

function getSelectorProvider(selector: string): string | undefined {
	const slashIndex = selector.indexOf("/");
	return slashIndex > 0 ? selector.slice(0, slashIndex) : undefined;
}

function deriveRequiredProviders(modelMapping: ModelProfileConfig["model_mapping"]): string[] {
	const providers = new Set<string>();
	for (const selectorValue of Object.values(modelMapping)) {
		for (const selector of normalizeModelSelectorValue(selectorValue)) {
			const provider = getSelectorProvider(selector);
			if (provider) providers.add(provider);
		}
	}
	return [...providers].sort((a, b) => a.localeCompare(b));
}

function sameModelSelectorRecord(
	left: Readonly<Record<string, ModelSelectorValue | undefined>>,
	right: Readonly<Record<string, ModelSelectorValue | undefined>>,
): boolean {
	const leftEntries = Object.entries(left)
		.filter((entry): entry is [string, ModelSelectorValue] => entry[1] !== undefined)
		.sort(([a], [b]) => a.localeCompare(b));
	const rightEntries = Object.entries(right)
		.filter((entry): entry is [string, ModelSelectorValue] => entry[1] !== undefined)
		.sort(([a], [b]) => a.localeCompare(b));
	if (leftEntries.length !== rightEntries.length) return false;
	for (let i = 0; i < leftEntries.length; i++) {
		const leftEntry = leftEntries[i];
		const rightEntry = rightEntries[i];
		if (
			!leftEntry ||
			!rightEntry ||
			leftEntry[0] !== rightEntry[0] ||
			!sameStringArray(normalizeModelSelectorValue(leftEntry[1]), normalizeModelSelectorValue(rightEntry[1]))
		) {
			return false;
		}
	}
	return true;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	for (let i = 0; i < left.length; i++) {
		if (left[i] !== right[i]) return false;
	}
	return true;
}

function hasPersistableProfileSnapshot(snapshot: ModelProfileConfig): boolean {
	return Object.keys(snapshot.model_mapping).length > 0 && snapshot.required_providers.length > 0;
}

function isCustomUserProfile(profile: ModelProfileDefinition): boolean {
	return profile.source === "user";
}
/**
 * Component that renders a canonical model selector with provider tabs.
 * - Preset landing Left/Right: Collapse/expand selected provider
 * - Model browser Tab/Arrow Left/Right: Switch between provider tabs
 * - Arrow Up/Down: Navigate rows
 * - Enter: Open assignment actions for default plus GJC role-agent models
 * - Escape: Close selector
 */
export class ModelSelectorComponent extends Container {
	#searchInput: Input;
	#headerContainer: Container;
	#tabBar: TabBar | null = null;
	#listContainer: Container;
	#allModels: ModelItem[] = [];
	#filteredModels: ModelItem[] = [];
	#canonicalModels: CanonicalModelItem[] = [];
	#filteredCanonicalModels: CanonicalModelItem[] = [];
	#selectedIndex: number = 0;
	#roles: RoleAssignments = {};
	#settings = null as unknown as Settings;
	#modelRegistry = null as unknown as ModelRegistry;
	#onSelectCallback = (() => {}) as RoleSelectCallback;
	#onCancelCallback = (() => {}) as CancelCallback;
	#errorMessage?: unknown;
	#tui: TUI;
	#scopedModels: ReadonlyArray<ScopedModelItem>;
	#temporaryOnly: boolean;
	#currentModel?: Model;
	#currentThinkingLevel?: ThinkingLevel;
	#activeModelProfile?: string;
	#configuredDefaultChain?: readonly string[];
	#isFastForProvider: (provider?: string, supportsServiceTier?: boolean) => boolean = () => false;
	#isFastForSubagentProvider: (provider?: string, supportsServiceTier?: boolean) => boolean = () => false;
	#isCurrentModelFastModeActive: () => boolean = () => false;
	#pendingActionItem?: ModelItem | CanonicalModelItem;
	#selectedActionIndex: number = 0;
	#pendingThinkingChoice?: PendingThinkingChoice;
	#selectedThinkingIndex: number = 0;
	#assignmentState: "idle" | "assigning" = "idle";
	#closeAfterAssignment = false;
	#unsubscribeCatalogChanged: () => void = () => {};
	#unsubscribeProviderOrderChanged: () => void = () => {};
	#unsubscribeAuthGeneration: () => void = () => {};
	#disposed = false;
	/** Standalone smart-routing entry: cancel closes the selector instead of falling back to the preset landing. */
	#smartRoutingOnly = false;

	// Preset landing state
	#viewMode: ModelSelectorViewMode = "presets";
	#presetCursor: number = 0;
	#expandedPresetProviderId?: string;
	#previewProfileName?: string;
	#presetScopeMenuOpen: boolean = false;
	#presetScopeIndex: number = 0;
	#providerAuthById = new Map<string, boolean>();
	#bareProfileAuthByName = new Map<string, boolean>();
	#providerAuthPending: boolean = false;
	#providerAuthRefreshGeneration = 0;
	#presetLoginHint?: string;
	#authSessionId?: string;
	#imageRoleFilter: boolean = false;
	#smartRoutingPanel?: SmartRoutingPanelComponent;
	#smartRoutingPreviewBuilder?: (draft: AutoroutingSetup) => SmartRoutingPreview;

	// Tab state
	#providers: ProviderTabState[] = STATIC_PROVIDER_TABS;
	#activeTabIndex: number = 0;

	constructor(
		tui: TUI,
		_currentModel: Model | undefined,
		settings: Settings,
		modelRegistry: ModelRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: RoleSelectCallback,
		onCancel: () => void,
		options?: {
			temporaryOnly?: boolean;
			initialSearchInput?: string;
			sessionId?: string;
			isFastForProvider?: (provider?: string, supportsServiceTier?: boolean) => boolean;
			isFastForSubagentProvider?: (provider?: string, supportsServiceTier?: boolean) => boolean;
			isCurrentModelFastModeActive?: () => boolean;
			currentThinkingLevel?: ThinkingLevel;
			activeModelProfile?: string;
			configuredDefaultChain?: readonly string[];
			smartRoutingPreview?: (draft: AutoroutingSetup) => SmartRoutingPreview;
			/** Open the smart-routing panel directly instead of the preset landing. */
			smartRoutingOnly?: boolean;
		},
	) {
		super();

		this.#tui = tui;
		this.#settings = settings;
		this.#modelRegistry = modelRegistry;
		this.#scopedModels = scopedModels;
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		this.#temporaryOnly = options?.temporaryOnly ?? false;
		this.#authSessionId = options?.sessionId;
		this.#smartRoutingPreviewBuilder = options?.smartRoutingPreview;
		this.#currentModel = _currentModel;
		this.#currentThinkingLevel = options?.currentThinkingLevel;
		this.#activeModelProfile = options?.activeModelProfile;
		this.#configuredDefaultChain = options?.configuredDefaultChain;
		this.#isFastForProvider = options?.isFastForProvider ?? (() => false);
		this.#isFastForSubagentProvider = options?.isFastForSubagentProvider ?? (() => false);
		// Current-model EFFECTIVE fast state. Defaults to intent for the current
		// model so existing callers/tests keep prior behavior; production wires the
		// session's effective predicate so an auto-disabled provider shows no glyph.
		this.#isCurrentModelFastModeActive =
			options?.isCurrentModelFastModeActive ??
			(() =>
				this.#currentModel
					? this.#isFastForProvider(this.#currentModel.provider, modelSupportsServiceTier(this.#currentModel))
					: false);
		const initialSearchInput = options?.initialSearchInput;
		this.#smartRoutingOnly = options?.smartRoutingOnly === true;
		this.#viewMode = this.#smartRoutingOnly
			? "smart-routing"
			: this.#temporaryOnly || initialSearchInput || scopedModels.length > 0
				? "models"
				: "presets";

		// Load current role assignments from settings
		this.#rebuildRoleModels();

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add hint about model filtering
		const hintText =
			scopedModels.length > 0 ? "Showing models from --models scope" : formatModelOnboardingInlineHint();
		this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
		this.addChild(new Spacer(1));

		// Create header container for tab bar
		this.#headerContainer = new Container();
		this.addChild(this.#headerContainer);

		this.addChild(new Spacer(1));

		// Create search input
		this.#searchInput = new Input();
		if (initialSearchInput) {
			this.#setSearchInputValue(initialSearchInput);
		}
		this.#searchInput.onSubmit = () => {
			const selectedItem = this.#getSelectedItem();
			if (selectedItem) this.#beginActionMenuOrSelect(selectedItem);
		};
		this.addChild(this.#searchInput);

		this.addChild(new Spacer(1));

		// Create list container
		this.#listContainer = new Container();
		this.addChild(this.#listContainer);

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());

		if (typeof this.#modelRegistry.onCatalogChanged === "function") {
			this.#unsubscribeCatalogChanged = this.#modelRegistry.onCatalogChanged(() => {
				if (this.#disposed) return;
				if (this.#viewMode === "presets") {
					this.#refreshCatalogView();
					this.#clampPresetCursor();
					void this.#refreshProviderAuth();
					this.#renderPresetLanding();
					this.#tui.requestRender();
					return;
				}
				if (this.#refreshCatalogView()) this.#tui.requestRender();
			});
		}

		// Advisory drift only, and only while the smart-routing panel is mounted. This
		// must not call refreshState: that would discard the user's unsaved draft.
		this.#unsubscribeProviderOrderChanged = this.#settings.onChanged?.(path => {
			if (this.#disposed || path !== "modelProviderOrder") return;
			if (this.#viewMode !== "smart-routing") return;
			const panel = this.#smartRoutingPanel;
			if (!panel) return;
			panel.updateProviderOrderHint(this.#providerOrderHintFor(panel.getProviderOrder()));
			this.#tui.requestRender();
		});
		this.#unsubscribeAuthGeneration =
			this.#modelRegistry.authStorage?.onGenerationChanged?.(() => {
				if (this.#disposed || this.#viewMode !== "presets") return;
				void this.#refreshProviderAuth();
			}) ?? (() => {});

		// Load models and do initial render
		this.#loadModels().then(() => {
			this.#buildProviderTabs();
			if (this.#smartRoutingOnly) {
				this.#enterSmartRoutingMode();
				this.#tui.requestRender();
				return;
			}
			if (this.#viewMode === "presets" && (this.#modelRegistry.getModelProfiles?.().size ?? 0) === 0) {
				this.#viewMode = "models";
			}
			if (this.#viewMode === "presets") {
				void this.#refreshProviderAuth();
				this.#renderPresetLanding();
			} else {
				this.#updateTabBar();
				// Always apply the current search query — the user may have typed
				// while models were loading asynchronously.
				const currentQuery = this.#searchInput.getValue();
				if (currentQuery) {
					this.#filterModels(currentQuery);
				} else {
					this.#updateList();
				}
			}
			// Request re-render after models are loaded
			this.#tui.requestRender();
		});
	}

	override dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#providerAuthRefreshGeneration++;
		this.#unsubscribeCatalogChanged();
		this.#unsubscribeProviderOrderChanged();
		this.#unsubscribeAuthGeneration();
		super.dispose();
	}

	#isActiveDefaultFallback(): boolean {
		if (!this.#currentModel) return false;
		const configuredChain =
			this.#configuredDefaultChain ?? normalizeModelSelectorValue(this.#settings.getModelRole("default"));
		if (configuredChain.length < 2) return false;

		const allModels = this.#modelRegistry.getAll();
		const matchPreferences = { usageOrder: this.#settings.getStorage()?.getModelUsageOrder() };
		return configuredChain.slice(1).some(selector => {
			const resolved = resolveModelRoleValue(selector, allModels, {
				settings: this.#settings,
				matchPreferences,
				modelRegistry: this.#modelRegistry,
				aliasIntent: this.#activeModelProfile ? "preset-equivalent" : undefined,
				credentialSessionId: this.#authSessionId,
			});
			return resolved.model !== undefined && modelsAreEqual(resolved.model, this.#currentModel);
		});
	}

	#loadRoleModels(): RoleAssignments {
		const roles: RoleAssignments = {};
		const allModels = this.#modelRegistry.getAll();
		const matchPreferences = { usageOrder: this.#settings.getStorage()?.getModelUsageOrder() };
		const agentModelOverrides = this.#settings.get("task.agentModelOverrides");
		const activeProfile = this.#activeModelProfile
			? this.#modelRegistry.getModelProfile(this.#activeModelProfile)
			: undefined;
		const activeProfileBindings = activeProfile ? resolveProfileBindings(activeProfile) : undefined;
		for (const role of GJC_MODEL_ASSIGNMENT_TARGET_IDS) {
			const target = GJC_MODEL_ASSIGNMENT_TARGETS[role];
			const roleValue =
				target.settingsPath === "modelRoles" ? this.#settings.getModelRole(role) : agentModelOverrides[role];
			if (!roleValue) continue;
			const profileOwnsRole =
				role === "default"
					? activeProfileBindings?.defaultSelector !== undefined
					: target.settingsPath === "modelRoles"
						? Object.hasOwn(activeProfileBindings?.modelRoles ?? {}, role)
						: Object.hasOwn(activeProfileBindings?.agentModelOverrides ?? {}, role);

			const resolved = resolveModelRoleValue(roleValue, allModels, {
				settings: this.#settings,
				matchPreferences,
				modelRegistry: this.#modelRegistry,
				aliasIntent: profileOwnsRole ? "preset-equivalent" : undefined,
				credentialSessionId: this.#authSessionId,
			});
			if (resolved.model) {
				roles[role] = {
					model: resolved.model,
					thinkingLevel:
						resolved.explicitThinkingLevel && resolved.thinkingLevel !== undefined
							? resolved.thinkingLevel
							: ThinkingLevel.Inherit,
				};
			}
		}
		if (
			((this.#configuredDefaultChain?.length ?? 0) > 0 ||
				this.#activeModelProfile ||
				this.#isActiveDefaultFallback()) &&
			this.#currentModel
		) {
			roles.default = {
				model: this.#currentModel,
				thinkingLevel: this.#currentThinkingLevel ?? ThinkingLevel.Inherit,
			};
		}
		return roles;
	}

	/**
	 * Re-resolve every role binding against the CURRENT model catalog. Role bindings
	 * are resolved snapshots, so any catalog change (initial async load, provider
	 * refresh) must rebuild them or badges, ranking, and the assignment menu keep
	 * reporting models that the catalog has since gained or lost.
	 */
	#rebuildRoleModels(): void {
		this.#roles = this.#loadRoleModels();
	}

	refreshRoleAssignments(
		options: { currentModel?: Model; currentThinkingLevel?: ThinkingLevel; activeModelProfile?: string } = {},
	): void {
		if ("currentModel" in options) this.#currentModel = options.currentModel;
		if ("currentThinkingLevel" in options) this.#currentThinkingLevel = options.currentThinkingLevel;
		if ("activeModelProfile" in options) this.#activeModelProfile = options.activeModelProfile;
		this.#refreshCatalogView();
	}

	#resolveProviderAuthState(providerId: string): ProviderAuthState {
		const health = getProviderAuthHealth(this.#modelRegistry.authStorage, providerId);
		if (health) return health;
		return this.#modelRegistry.hasConfiguredProviderAuth(providerId) ? "configured" : "none";
	}

	#sortModels(models: ModelItem[], roles: RoleAssignments = this.#roles): void {
		// Sort: default-tagged model first, then MRU, then provider ranking
		const mruOrder = this.#settings.getStorage()?.getModelUsageOrder() ?? [];
		const mruIndex = new Map(mruOrder.map((key, i) => [key, i]));
		const providerAuthStateById = new Map<string, ProviderAuthState>();
		for (const item of models) {
			if (!providerAuthStateById.has(item.provider)) {
				providerAuthStateById.set(item.provider, this.#resolveProviderAuthState(item.provider));
			}
		}

		const modelRank = (item: ModelItem) => computeModelRank(item.model, roles);

		const dateRe = /-(\d{8})$/;
		const latestRe = /-latest$/;

		models.sort((a, b) => {
			const aKey = a.selector;
			const bKey = b.selector;

			const aRank = modelRank(a);
			const bRank = modelRank(b);
			if (aRank !== bRank) return aRank - bRank;

			// Then MRU order (models in mruIndex come before those not in it)
			const aMru = mruIndex.get(aKey) ?? Number.MAX_SAFE_INTEGER;
			const bMru = mruIndex.get(bKey) ?? Number.MAX_SAFE_INTEGER;
			if (aMru !== bMru) return aMru - bMru;

			// By provider, then recency within provider
			const providerCmp = compareRankedProviders(
				{
					id: a.provider,
					label: a.provider,
					authState: providerAuthStateById.get(a.provider) ?? "none",
				},
				{
					id: b.provider,
					label: b.provider,
					authState: providerAuthStateById.get(b.provider) ?? "none",
				},
			);
			if (providerCmp !== 0) return providerCmp;

			// Priority field (lower = better, e.g. OpenAI code backend priority values)
			const aPri = a.model.priority ?? Number.MAX_SAFE_INTEGER;
			const bPri = b.model.priority ?? Number.MAX_SAFE_INTEGER;
			if (aPri !== bPri) return aPri - bPri;

			// Version number descending (higher version = better model)
			const aVer = extractVersionNumber(a.id);
			const bVer = extractVersionNumber(b.id);
			if (aVer !== bVer) return bVer - aVer;

			const aIsLatest = latestRe.test(a.id);
			const bIsLatest = latestRe.test(b.id);
			const aDate = a.id.match(dateRe)?.[1] ?? "";
			const bDate = b.id.match(dateRe)?.[1] ?? "";

			// Both have dates or latest tags — sort by recency
			const aHasRecency = aIsLatest || aDate !== "";
			const bHasRecency = bIsLatest || bDate !== "";

			// Models with recency info come before those without
			if (aHasRecency !== bHasRecency) return aHasRecency ? -1 : 1;

			// If neither has recency info, fall back to alphabetical
			if (!aHasRecency) return a.id.localeCompare(b.id);

			// -latest always sorts first within recency group
			if (aIsLatest !== bIsLatest) return aIsLatest ? -1 : 1;

			// Both have dates — descending (newest first)
			if (aDate && bDate) return bDate.localeCompare(aDate);

			// One has date, other is latest — latest first
			return aIsLatest ? -1 : bIsLatest ? 1 : a.id.localeCompare(b.id);
		});
	}

	#sortCanonicalModels(models: CanonicalModelItem[], roles: RoleAssignments = this.#roles): void {
		const mruOrder = this.#settings.getStorage()?.getModelUsageOrder() ?? [];
		const mruIndex = new Map(mruOrder.map((key, i) => [key, i]));
		const providerAuthStateById = new Map<string, ProviderAuthState>();
		for (const item of models) {
			if (!providerAuthStateById.has(item.model.provider)) {
				providerAuthStateById.set(item.model.provider, this.#resolveProviderAuthState(item.model.provider));
			}
		}

		const modelRank = (item: CanonicalModelItem) => computeModelRank(item.model, roles);

		models.sort((a, b) => {
			const aRank = modelRank(a);
			const bRank = modelRank(b);
			if (aRank !== bRank) return aRank - bRank;

			const aMru = mruIndex.get(`${a.model.provider}/${a.model.id}`) ?? Number.MAX_SAFE_INTEGER;
			const bMru = mruIndex.get(`${b.model.provider}/${b.model.id}`) ?? Number.MAX_SAFE_INTEGER;
			if (aMru !== bMru) return aMru - bMru;

			const providerCmp = compareRankedProviders(
				{
					id: a.model.provider,
					label: a.model.provider,
					authState: providerAuthStateById.get(a.model.provider) ?? "none",
				},
				{
					id: b.model.provider,
					label: b.model.provider,
					authState: providerAuthStateById.get(b.model.provider) ?? "none",
				},
			);
			if (providerCmp !== 0) return providerCmp;

			return a.id.localeCompare(b.id);
		});
	}

	#buildScopedModelItems(): ModelItem[] {
		return this.#scopedModels.map(scoped => ({
			kind: "provider",
			provider: scoped.model.provider,
			id: scoped.model.id,
			model: scoped.model,
			selector: `${scoped.model.provider}/${scoped.model.id}`,
			thinkingLevel: scoped.thinkingLevel,
			explicitThinkingLevel: scoped.explicitThinkingLevel,
		}));
	}

	#buildAvailableModelItems(): ModelItem[] {
		return this.#modelRegistry.getAvailable().map((model: Model) => ({
			kind: "provider",
			provider: model.provider,
			id: model.id,
			model,
			selector: `${model.provider}/${model.id}`,
		}));
	}
	async #loadModels(
		options: { refreshRegistry?: boolean; throwOnCatalogError?: boolean; commit?: boolean } = {},
	): Promise<MaterializedCatalog | undefined> {
		let models: ModelItem[];

		// Use scoped models if provided via --models flag
		if (this.#scopedModels.length > 0) {
			models = this.#buildScopedModelItems();
		} else {
			// Reload config and cached discovery state without blocking on live provider refresh
			if (options.refreshRegistry !== false) {
				await this.#modelRegistry.refresh("offline");
			}

			// Check for models.json errors
			const loadError = this.#modelRegistry.getError();
			if (loadError) {
				this.#errorMessage = loadError;
			} else {
				this.#errorMessage = undefined;
			}

			// Load available models (built-in models still work even if models.json failed)
			try {
				models = this.#buildAvailableModelItems();
			} catch (error) {
				if (options.throwOnCatalogError) throw error;
				this.#allModels = [];
				this.#filteredModels = [];
				this.#canonicalModels = [];
				this.#filteredCanonicalModels = [];
				this.#errorMessage = error instanceof Error ? error.message : String(error);
				this.#rebuildRoleModels();
				return;
			}
		}

		const catalog = this.#materializeModels(models);
		if (options.commit !== false) this.#commitMaterializedCatalog(catalog);
		return catalog;
	}

	#materializeModels(models: ModelItem[]): MaterializedCatalog {
		const candidateModels = models.map(item => item.model);
		const canonicalSelections = this.#modelRegistry.getCanonicalModelSelections({
			availableOnly: this.#scopedModels.length === 0,
			candidates: candidateModels,
		});
		const scopedThinkingBySelector = new Map(models.map(item => [item.selector, item.thinkingLevel]));
		const canonicalModels = canonicalSelections
			.map((selection): CanonicalModelItem | undefined => {
				const record = selection.record;
				const selectedModel = selection.model;
				if (!selectedModel) return undefined;
				const selectedSelector = `${selectedModel.provider}/${selectedModel.id}`;
				const searchText = [
					record.id,
					record.name,
					selectedModel.provider,
					selectedModel.id,
					selectedModel.name,
					...record.variants.flatMap(variant => [variant.selector, variant.model.name]),
				].join(" ");
				const item: CanonicalModelItem = {
					kind: "canonical",
					id: record.id,
					model: selectedModel,
					selector: record.id,
					variantCount: record.variants.length,
					searchText,
					normalizedSearchText: normalizeSearchText(searchText),
					compactSearchText: compactSearchText(searchText),
				};
				const scopedThinkingLevel = scopedThinkingBySelector.get(selectedSelector);
				if (scopedThinkingLevel !== undefined) {
					item.thinkingLevel = scopedThinkingLevel;
				}
				const scopedModel = models.find(model => `${model.model.provider}/${model.model.id}` === selectedSelector);
				if (scopedModel?.explicitThinkingLevel !== undefined) {
					item.explicitThinkingLevel = scopedModel.explicitThinkingLevel;
				}
				return item;
			})
			.filter((item): item is CanonicalModelItem => item !== undefined);
		const roles = this.#loadRoleModels();

		this.#sortModels(models, roles);
		this.#sortCanonicalModels(canonicalModels, roles);
		return { models, canonicalModels, roles };
	}

	#commitMaterializedCatalog(catalog: MaterializedCatalog): void {
		this.#roles = catalog.roles;
		this.#allModels = catalog.models;
		this.#filteredModels = catalog.models;
		this.#canonicalModels = catalog.canonicalModels;
		this.#filteredCanonicalModels = catalog.canonicalModels;
		this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, catalog.models.length - 1));
	}

	#captureViewSnapshot(): ModelSelectorViewSnapshot {
		return {
			roles: this.#roles,
			allModels: this.#allModels,
			filteredModels: this.#filteredModels,
			canonicalModels: this.#canonicalModels,
			filteredCanonicalModels: this.#filteredCanonicalModels,
			selectedIndex: this.#selectedIndex,
			providers: this.#providers,
			activeTabIndex: this.#activeTabIndex,
			tabBar: this.#tabBar,
		};
	}

	#restoreViewSnapshot(snapshot: ModelSelectorViewSnapshot): void {
		this.#roles = snapshot.roles;
		this.#allModels = snapshot.allModels;
		this.#filteredModels = snapshot.filteredModels;
		this.#canonicalModels = snapshot.canonicalModels;
		this.#filteredCanonicalModels = snapshot.filteredCanonicalModels;
		this.#selectedIndex = snapshot.selectedIndex;
		this.#providers = snapshot.providers;
		this.#activeTabIndex = snapshot.activeTabIndex;
		this.#tabBar = snapshot.tabBar;
	}

	#refreshCatalogView(): boolean {
		const previousView = this.#captureViewSnapshot();
		try {
			const models =
				this.#scopedModels.length > 0 ? this.#buildScopedModelItems() : this.#buildAvailableModelItems();
			const catalog = this.#materializeModels(models);
			this.#buildProviderTabs(catalog.models);
			this.#commitMaterializedCatalog(catalog);
			this.#updateTabBar();
			this.#applyTabFilter();
			return true;
		} catch (error) {
			this.#errorMessage = error instanceof Error ? error.message : String(error);
			this.#restoreViewSnapshot(previousView);
			try {
				this.#updateTabBar();
				this.#applyTabFilter();
			} catch {
				// Keep the last-good component state even if the terminal view cannot be rebuilt.
			}
			return false;
		}
	}

	#buildProviderTabs(models: readonly ModelItem[] = this.#allModels): void {
		const activeTabId = this.#getActiveTab().id;
		const providerSet = new Set<string>();
		for (const item of models) {
			providerSet.add(item.provider);
		}
		for (const provider of this.#modelRegistry.getDiscoverableProviders()) {
			providerSet.add(provider);
		}
		const providerAuthStateById = new Map<string, ProviderAuthState>();
		for (const provider of providerSet) {
			providerAuthStateById.set(provider, this.#resolveProviderAuthState(provider));
		}
		const sortedProviderIds = Array.from(providerSet).sort((left, right) =>
			compareRankedProviders(
				{
					id: left,
					label: formatProviderTabLabel(left),
					authState: providerAuthStateById.get(left) ?? "none",
				},
				{
					id: right,
					label: formatProviderTabLabel(right),
					authState: providerAuthStateById.get(right) ?? "none",
				},
			),
		);
		this.#providers = [...STATIC_PROVIDER_TABS, ...sortedProviderIds.map(createProviderTab)];
		const activeIndex = this.#providers.findIndex(tab => tab.id === activeTabId);
		this.#activeTabIndex =
			activeIndex >= 0 ? activeIndex : Math.min(this.#activeTabIndex, this.#providers.length - 1);
	}

	async #refreshSelectedProvider(): Promise<void> {
		const providerId = this.#getActiveProviderId();
		if (this.#scopedModels.length > 0 || !providerId) {
			return;
		}

		let refreshError: unknown;
		try {
			// Cache-aware: a fresh discovery cache answers instantly instead of
			// forcing a provider round-trip (hundreds of ms on remote gateways)
			// on every provider-tab visit. Stale/missing cache still fetches.
			await this.#modelRegistry.refreshProvider(providerId, "online-if-uncached");
		} catch (error) {
			refreshError = error;
		}

		let catalog: MaterializedCatalog | undefined;
		try {
			catalog = await this.#loadModels({
				refreshRegistry: refreshError === undefined,
				throwOnCatalogError: true,
				commit: false,
			});
		} catch (catalogError) {
			if (refreshError !== undefined) {
				const refreshMessage = refreshError instanceof Error ? refreshError.message : String(refreshError);
				const recoveryMessage = catalogError instanceof Error ? catalogError.message : String(catalogError);
				throw new Error(`${refreshMessage}; catalog recovery failed: ${recoveryMessage}`, {
					cause: refreshError,
				});
			}
			throw catalogError;
		}
		if (!catalog) throw new Error("Model catalog could not be materialized.");

		const previousView = this.#captureViewSnapshot();
		try {
			this.#buildProviderTabs(catalog.models);
			this.#commitMaterializedCatalog(catalog);
			this.#updateTabBar();
			this.#applyTabFilter();
			this.#tui.requestRender();
		} catch (presentationError) {
			const finalError =
				refreshError !== undefined
					? new Error(
							`${refreshError instanceof Error ? refreshError.message : String(refreshError)}; catalog presentation failed: ${presentationError instanceof Error ? presentationError.message : String(presentationError)}`,
							{ cause: refreshError },
						)
					: presentationError;
			this.#restoreViewSnapshot(previousView);
			try {
				this.#updateTabBar();
				this.#applyTabFilter();
			} catch {
				// Preserve the original presentation failure and the last-good component state.
			}
			throw finalError;
		}
		if (refreshError !== undefined) throw refreshError;
	}

	#updateTabBar(): void {
		this.#headerContainer.clear();

		const tabs: Tab[] = this.#providers.map(provider => ({ id: provider.id, label: provider.label }));
		const tabBar = new TabBar("Models", tabs, getTabBarTheme(), this.#activeTabIndex);
		tabBar.onTabChange = (_tab, index) => {
			this.#activeTabIndex = index;
			this.#selectedIndex = 0;
			this.#applyTabFilter();
			void this.#refreshSelectedProvider().catch(error => {
				this.#errorMessage = error instanceof Error ? error.message : String(error);
				this.#updateList();
				this.#tui.requestRender();
			});
		};
		this.#tabBar = tabBar;
		this.#headerContainer.addChild(tabBar);
	}

	#getActiveTab(): ProviderTabState {
		return this.#providers[this.#activeTabIndex] ?? STATIC_PROVIDER_TABS[0]!;
	}

	#getActiveTabId(): string {
		return this.#getActiveTab().id;
	}

	#getActiveProviderId(): string | undefined {
		return this.#getActiveTab().providerId;
	}

	#isCanonicalTab(): boolean {
		return this.#getActiveTabId() === CANONICAL_TAB;
	}

	#filterModels(query: string): void {
		const activeTabId = this.#getActiveTabId();
		const activeProviderId = this.#getActiveProviderId();
		const isCanonicalTab = activeTabId === CANONICAL_TAB;

		// Start with all models or filter by provider/canonical view
		let baseModels = this.#allModels;
		const baseCanonicalModels = this.#canonicalModels;
		if (this.#imageRoleFilter) {
			baseModels = baseModels.filter(m => m.model.output?.includes("image") ?? false);
		}
		if (activeProviderId) {
			baseModels = baseModels.filter(m => m.provider === activeProviderId);
		}

		// Apply fuzzy filter if query is present
		if (query.trim()) {
			// If user is searching from a provider tab, auto-switch to ALL to show global provider results.
			if (activeProviderId && !isCanonicalTab) {
				this.#activeTabIndex = 0;
				if (this.#tabBar && this.#tabBar.getActiveIndex() !== 0) {
					this.#tabBar.setActiveIndex(0);
					return;
				}
				this.#updateTabBar();
				baseModels = this.#allModels;
			}

			if (isCanonicalTab) {
				const alphaTokens = getAlphaSearchTokens(query);
				const alphaFiltered =
					alphaTokens.length === 0
						? baseCanonicalModels
						: baseCanonicalModels.filter(item =>
								alphaTokens.every(token => item.normalizedSearchText.includes(token)),
							);
				const compactQuery = compactSearchText(query);
				const substringFiltered =
					compactQuery.length === 0
						? alphaFiltered
						: alphaFiltered.filter(item => item.compactSearchText.includes(compactQuery));
				const fuzzySource =
					substringFiltered.length > 0
						? substringFiltered
						: alphaFiltered.length > 0
							? alphaFiltered
							: baseCanonicalModels;
				const fuzzyMatches = fuzzyFilter(fuzzySource, query, ({ searchText }) => searchText);
				this.#sortCanonicalModels(fuzzyMatches);
				this.#filteredCanonicalModels = fuzzyMatches;
			} else {
				const fuzzyMatches = fuzzyFilter(baseModels, query, ({ id, provider }) => `${id} ${provider}`);
				this.#sortModels(fuzzyMatches);
				this.#filteredModels = fuzzyMatches;
			}
		} else {
			this.#filteredModels = baseModels;
			this.#filteredCanonicalModels = baseCanonicalModels;
		}

		const visibleCount = isCanonicalTab ? this.#filteredCanonicalModels.length : this.#filteredModels.length;
		this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, visibleCount - 1));
		this.#updateList();
	}

	#applyTabFilter(): void {
		const query = this.#searchInput.getValue();
		this.#filterModels(query);
	}

	#formatDiscoveryAge(fetchedAt: number | undefined): string | undefined {
		if (!fetchedAt) {
			return undefined;
		}
		const ageMs = Math.max(0, Date.now() - fetchedAt);
		if (ageMs < 60_000) {
			return "less than a minute ago";
		}
		const ageMinutes = Math.round(ageMs / 60_000);
		return `${ageMinutes}m ago`;
	}

	#getPresetGroups(): Map<string, ModelProfileDefinition[]> {
		return groupModelProfilesForPresetLanding(this.#modelRegistry.getModelProfiles?.() ?? new Map());
	}

	#formatCurrentModelSelector(
		thinkingLevel: ThinkingLevel | undefined = this.#currentThinkingLevel,
	): string | undefined {
		if (!this.#currentModel) return undefined;
		return formatModelSelectorValue(`${this.#currentModel.provider}/${this.#currentModel.id}`, thinkingLevel);
	}

	#resolveProfileModelSelector(value: ModelSelectorValue | undefined): string | string[] | undefined {
		const resolvedSelectors: string[] = [];
		for (const configuredSelector of normalizeModelSelectorValue(value)) {
			if (isInheritedRoleSelector(configuredSelector)) continue;
			const selectors = resolveConfiguredModelPatterns(configuredSelector, this.#settings);
			for (const selector of selectors.length > 0 ? selectors : [configuredSelector]) {
				const resolved = resolveModelRoleValue(selector, this.#modelRegistry.getAll(), {
					settings: this.#settings,
					matchPreferences: { usageOrder: this.#settings.getStorage()?.getModelUsageOrder() },
					modelRegistry: this.#modelRegistry,
					aliasIntent: this.#activeModelProfile ? "preset-equivalent" : undefined,
					credentialSessionId: this.#authSessionId,
				});
				if (resolved.model) {
					resolvedSelectors.push(
						formatModelSelectorValue(`${resolved.model.provider}/${resolved.model.id}`, resolved.thinkingLevel),
					);
					continue;
				}

				const inheritedDefaultThinkingLevel = getDefaultAliasThinkingLevel(selector);
				if (inheritedDefaultThinkingLevel) {
					const currentSelector = this.#formatCurrentModelSelector(inheritedDefaultThinkingLevel);
					if (currentSelector) resolvedSelectors.push(currentSelector);
					continue;
				}

				// Preserve unresolved chain members verbatim instead of silently
				// truncating configured fallback tails.
				resolvedSelectors.push(selector);
			}
		}
		if (resolvedSelectors.length === 0) return undefined;
		return resolvedSelectors.length === 1 ? resolvedSelectors[0] : resolvedSelectors;
	}

	#buildCustomModelProfileSnapshot(): ModelProfileConfig {
		const modelMapping: ModelProfileConfig["model_mapping"] = {};
		// Prefer the session's configured default chain so fallback tails are
		// never dropped from the snapshot; the live model only replaces the head.
		if (this.#configuredDefaultChain && this.#configuredDefaultChain.length > 0) {
			const head = this.#formatCurrentModelSelector() ?? this.#configuredDefaultChain[0]!;
			const tail = this.#configuredDefaultChain.slice(1);
			modelMapping.default = tail.length > 0 ? [head, ...tail] : head;
		} else {
			const currentModelSelector = this.#formatCurrentModelSelector();
			if (currentModelSelector) {
				modelMapping.default = currentModelSelector;
			} else {
				const defaultRole = this.#settings.getModelRole("default");
				const defaultSelector = this.#resolveProfileModelSelector(defaultRole);
				if (defaultSelector) modelMapping.default = defaultSelector;
			}
		}

		const agentOverrides = this.#settings.get("task.agentModelOverrides");
		for (const role of GJC_MODEL_ASSIGNMENT_TARGET_IDS) {
			if (role === "default") continue;
			const selector = this.#resolveProfileModelSelector(agentOverrides[role]);
			if (selector) modelMapping[role] = selector;
		}

		return {
			required_providers: deriveRequiredProviders(modelMapping),
			model_mapping: modelMapping,
		};
	}

	#findDuplicateGeneratedProfile(snapshot: ModelProfileConfig): ModelProfileDefinition | undefined {
		for (const profile of this.#modelRegistry.getModelProfiles?.().values() ?? []) {
			if (
				sameModelSelectorRecord(profile.modelMapping, snapshot.model_mapping) &&
				sameStringArray(profile.requiredProviders, snapshot.required_providers)
			) {
				return profile;
			}
		}
		return undefined;
	}

	#getPresetRows(): PresetLandingRow[] {
		const rows: PresetLandingRow[] = [];
		for (const [groupId, profiles] of this.#getPresetGroups()) {
			rows.push({ kind: "group", groupId, profiles });
			if (this.#expandedPresetProviderId === groupId) {
				for (const profile of profiles) rows.push({ kind: "profile", groupId, profile });
			}
		}
		const snapshot = this.#buildCustomModelProfileSnapshot();
		if (hasPersistableProfileSnapshot(snapshot)) {
			const duplicateProfile = this.#findDuplicateGeneratedProfile(snapshot);
			rows.push(duplicateProfile ? { kind: "alreadySaved", profile: duplicateProfile } : { kind: "create" });
		} else {
			rows.push({ kind: "createUnavailable", label: "Select a model before creating a custom preset" });
		}
		rows.push({ kind: "imageRole" });
		rows.push({ kind: "smartRouting" });
		rows.push({ kind: "browse" });
		return rows;
	}

	#getSelectedPresetRow(): PresetLandingRow | undefined {
		return this.#getPresetRows()[this.#presetCursor];
	}

	#getProfileByName(name: string | undefined): ModelProfileDefinition | undefined {
		if (!name) return undefined;
		return this.#modelRegistry.getModelProfile?.(name) ?? this.#modelRegistry.getModelProfiles?.().get(name);
	}

	#isProviderAuthenticated(providerId: string): boolean | undefined {
		return this.#providerAuthById.get(providerId);
	}

	#getProfileAvailableModels(): Model[] {
		const getAvailableForProfileActivation = this.#modelRegistry.getAvailableForProfileActivation;
		return typeof getAvailableForProfileActivation === "function"
			? getAvailableForProfileActivation.call(this.#modelRegistry)
			: this.#modelRegistry.getAvailable();
	}

	#createProfileResolutionRegistry(availableModels: readonly Model[]) {
		return {
			getAvailable: () => availableModels as Model[],
			getApiKey: this.#modelRegistry.getApiKey?.bind(this.#modelRegistry) ?? (async () => undefined),
			resolveCanonicalModel: this.#modelRegistry.resolveCanonicalModel?.bind(this.#modelRegistry),
			getCanonicalVariants: this.#modelRegistry.getCanonicalVariants?.bind(this.#modelRegistry),
			getCanonicalId: this.#modelRegistry.getCanonicalId?.bind(this.#modelRegistry),
			resolveModelByLookupAlias: this.#modelRegistry.resolveModelByLookupAlias?.bind(this.#modelRegistry),
			lookupAliasExists: this.#modelRegistry.lookupAliasExists?.bind(this.#modelRegistry),
			clearCanonicalVariant: this.#modelRegistry.clearCanonicalVariant?.bind(this.#modelRegistry),
		};
	}

	#getProfileAuthenticatedProviders(profile: ModelProfileDefinition): Set<string> {
		if (profile.source !== "user" && inspectProxyProviderId(this.#settings).status === "invalid") return new Set();
		const authenticated = new Set(
			[...this.#providerAuthById]
				.filter(([, providerAuthenticated]) => providerAuthenticated)
				.map(([provider]) => provider),
		);
		const proxyProvider = profile.source === "user" ? undefined : tryResolveProxyProviderId(this.#settings);
		if (proxyProvider !== undefined && this.#isProviderAuthenticated(proxyProvider) === true) {
			for (const provider of getProxyRoutableProviders(profile)) authenticated.add(provider);
		}
		return authenticated;
	}

	#rewriteProfileSelectorForProxy(profile: ModelProfileDefinition, selector: string): string {
		if (profile.source === "user") return selector;
		const proxyProvider = tryResolveProxyProviderId(this.#settings);
		if (proxyProvider === undefined || this.#isProviderAuthenticated(proxyProvider) !== true) return selector;
		return rewriteSelectorForProxy(
			selector,
			proxyProvider,
			resolveProxyMode(this.#settings),
			this.#getProfileAvailableModels(),
			new Set(
				[...this.#providerAuthById].filter(([, authenticated]) => authenticated).map(([provider]) => provider),
			),
			getProxyRoutableProviders(profile),
		);
	}

	#getMissingProviders(profileOrProfiles: ModelProfileDefinition | ModelProfileDefinition[]): string[] {
		const profiles = Array.isArray(profileOrProfiles) ? profileOrProfiles : [profileOrProfiles];
		const missing = new Set<string>();
		for (const profile of profiles) {
			const authenticated = this.#getProfileAuthenticatedProviders(profile);
			if (isModelProfileProviderAvailable(profile, authenticated)) continue;
			const alternativeGroups = profile.alternativeProviderGroups ?? [];
			const alternativeProviders = new Set(alternativeGroups.flat());
			for (const provider of profileRequiredProviders(profile)) {
				if (!alternativeProviders.has(provider) && !authenticated.has(provider)) missing.add(provider);
			}
			for (const group of alternativeGroups) {
				if (!group.some(provider => authenticated.has(provider)))
					for (const provider of group) missing.add(provider);
			}
		}
		return [...missing].sort((a, b) => a.localeCompare(b));
	}

	#isPresetAuthenticated(profileOrProfiles: ModelProfileDefinition | ModelProfileDefinition[]): boolean {
		const profiles = Array.isArray(profileOrProfiles) ? profileOrProfiles : [profileOrProfiles];
		return profiles.every(profile => {
			if (profile.source !== "user") {
				if (inspectProxyProviderId(this.#settings).status === "invalid") return false;
				const proxyProvider = tryResolveProxyProviderId(this.#settings);
				if (
					proxyProvider !== undefined &&
					!(this.#modelRegistry.getConfiguredProviderIds?.() ?? []).includes(proxyProvider)
				)
					return false;
				try {
					if (resolveProxyMode(this.#settings) === "always") {
						const configuredProviders = this.#modelRegistry.getConfiguredProviderIds?.() ?? [];
						if (
							proxyProvider === undefined ||
							this.#isProviderAuthenticated(proxyProvider) !== true ||
							!configuredProviders.includes(proxyProvider)
						)
							return false;
					}
				} catch {
					return false;
				}
			}
			if (this.#getMissingProviders(profile).length > 0) return false;
			const bindings = resolveProfileBindings(profile);
			const assignments = [
				...(bindings.defaultSelector !== undefined ? [{ value: bindings.defaultSelector, isDefault: true }] : []),
				...Object.values(bindings.modelRoles).map(value => ({ value, isDefault: false })),
				...Object.values(bindings.agentModelOverrides).map(value => ({ value, isDefault: false })),
			];
			const bareAssignmentsAvailable = this.#bareProfileAuthByName.get(profile.name) ?? true;
			const availableModels = this.#getProfileAvailableModels();
			return assignments.every(assignment => {
				let selectors: string[];
				try {
					selectors = normalizeModelSelectorValue(assignment.value).map(selector =>
						this.#rewriteProfileSelectorForProxy(profile, selector),
					);
				} catch {
					return false;
				}
				const hasBareSelector = selectors.some(selector => !selector.includes("/"));
				if (!assignment.isDefault && !requiresQualifiedModelProfileRoleResolution(profile) && !hasBareSelector)
					return true;
				return selectors.some(selector => {
					if (!selector.includes("/")) return bareAssignmentsAvailable;
					const resolved = resolveModelRoleValue(selector, availableModels, {
						settings: this.#settings,
						modelRegistry: this.#modelRegistry,
						aliasIntent: "preset-equivalent",
						credentialSessionId: this.#authSessionId,
					}).model;
					if (!resolved) return false;
					if (this.#providerAuthById.get(resolved.provider) === true) return true;
					const alternativeGroup = profile.alternativeProviderGroups?.find(group =>
						group.includes(resolved.provider),
					);
					return (
						alternativeGroup?.some(provider => {
							if (this.#providerAuthById.get(provider) !== true) return false;
							const providerPrefix = `${resolved.provider}/`;
							const replacementSelector = selector.startsWith(providerPrefix)
								? `${provider}/${selector.slice(providerPrefix.length)}`
								: selector;
							return (
								resolveModelRoleValue(
									replacementSelector,
									availableModels.filter(model => model.provider === provider),
									{
										settings: this.#settings,
										modelRegistry: this.#modelRegistry,
										aliasIntent: "preset-equivalent",
										credentialSessionId: this.#authSessionId,
									},
								).model !== undefined
							);
						}) ?? false
					);
				});
			});
		});
	}

	/**
	 * A preset group is a list of alternative presets, not an all-or-nothing
	 * bundle. Treat the group as usable when at least one member preset has all
	 * of its required providers authenticated.
	 */
	#isPresetGroupUsable(profiles: ModelProfileDefinition[]): boolean {
		return profiles.some(profile => this.#isPresetAuthenticated(profile));
	}

	async #refreshProviderAuth(): Promise<void> {
		const refreshGeneration = ++this.#providerAuthRefreshGeneration;
		this.#providerAuthById = new Map();
		this.#bareProfileAuthByName = new Map();
		const availableModels = this.#getProfileAvailableModels();
		const resolutionRegistry = this.#createProfileResolutionRegistry(availableModels);
		const providers = new Set<string>();
		// Preset groups share selectors heavily (role assignments repeat across
		// profiles), and each `resolveModelRoleValue` call scans the candidate set
		// while validating lookup contexts and resolving aliases. Resolve identical
		// selectors once per refresh; the inputs are shared and only the provider is
		// needed here. This map is deliberately local to the synchronous, pre-await
		// snapshot below: catalog/config changes and credential-generation changes
		// start a new refresh with a new map.
		const resolvedProviderBySelector = new Map<string, string | undefined>();
		const resolveSelectorProvider = (selector: string): string | undefined => {
			if (resolvedProviderBySelector.has(selector)) return resolvedProviderBySelector.get(selector);
			const provider = resolveModelRoleValue(selector, availableModels, {
				settings: this.#settings,
				modelRegistry: this.#modelRegistry,
				aliasIntent: "preset-equivalent",
				credentialSessionId: this.#authSessionId,
			}).model?.provider;
			resolvedProviderBySelector.set(selector, provider);
			return provider;
		};
		for (const profiles of this.#getPresetGroups().values()) {
			for (const profile of profiles) {
				for (const provider of profileRequiredProviders(profile)) providers.add(provider);
				for (const group of profile.alternativeProviderGroups ?? []) {
					for (const provider of group) providers.add(provider);
				}
				for (const provider of deriveModelProfileMappedProviders(profile)) providers.add(provider);
				if (profile.source !== "user") {
					const proxyProvider = tryResolveProxyProviderId(this.#settings);
					if (proxyProvider !== undefined) providers.add(proxyProvider);
				}
				const bindings = resolveProfileBindings(profile);
				const values = [
					...(bindings.defaultSelector ? [bindings.defaultSelector] : []),
					...Object.values(bindings.modelRoles),
					...Object.values(bindings.agentModelOverrides),
				];
				for (const value of values) {
					for (const selector of normalizeModelSelectorValue(value)) {
						const resolvedProvider = resolveSelectorProvider(selector);
						if (resolvedProvider !== undefined) providers.add(resolvedProvider);
					}
				}
			}
		}
		this.#providerAuthPending = providers.size > 0;
		this.#renderPresetLanding();
		try {
			const entries = await Promise.all(
				[...providers].map(async provider => {
					try {
						const apiKey = await this.#modelRegistry.getApiKeyForProvider(provider, this.#authSessionId);
						return [provider, apiKey === kNoAuth || isAuthenticated(apiKey)] as const;
					} catch {
						return [provider, false] as const;
					}
				}),
			);
			if (
				this.#disposed ||
				this.#viewMode !== "presets" ||
				refreshGeneration !== this.#providerAuthRefreshGeneration
			)
				return;
			this.#providerAuthById = new Map(entries);
			const profileAuthEntries = await Promise.all(
				[...this.#getPresetGroups().values()].flat().map(async profile => {
					const bindings = resolveProfileBindings(profile);
					const values = [
						...(bindings.defaultSelector ? [bindings.defaultSelector] : []),
						...Object.values(bindings.modelRoles),
						...Object.values(bindings.agentModelOverrides),
					];
					const bareValues = values.filter(value =>
						normalizeModelSelectorValue(value).some(selector => !selector.includes("/")),
					);
					const available = await Promise.all(
						bareValues.map(async value => {
							try {
								const resolution = await resolveModelChainWithAuth(
									normalizeModelSelectorValue(value),
									resolutionRegistry,
									this.#settings,
									this.#authSessionId,
									{
										managedFallback: true,
										aliasIntent: "preset-equivalent",
										canonicalSessionId: null,
										credentialSessionId: this.#authSessionId,
									},
								);
								return resolution.model !== undefined;
							} catch {
								return false;
							}
						}),
					);
					return [profile.name, available.every(Boolean)] as const;
				}),
			);
			if (
				this.#disposed ||
				this.#viewMode !== "presets" ||
				refreshGeneration !== this.#providerAuthRefreshGeneration
			)
				return;
			this.#bareProfileAuthByName = new Map(profileAuthEntries);
		} finally {
			if (
				!this.#disposed &&
				this.#viewMode === "presets" &&
				refreshGeneration === this.#providerAuthRefreshGeneration
			) {
				this.#providerAuthPending = false;
				this.#renderPresetLanding();
				this.#tui.requestRender();
			}
		}
	}

	#clampPresetCursor(): void {
		const rows = this.#getPresetRows();
		this.#presetCursor = Math.min(this.#presetCursor, Math.max(0, rows.length - 1));
	}

	#relocatePresetCursor(targetIdentity: string): boolean {
		const relocated = this.#getPresetRows().findIndex(row => presetRowIdentity(row) === targetIdentity);
		if (relocated < 0) return false;
		this.#presetCursor = relocated;
		return true;
	}
	#relocatePresetCursorForProfile(profileName: string): boolean {
		for (const [groupId, profiles] of this.#getPresetGroups()) {
			if (!profiles.some(profile => profile.name === profileName)) continue;
			this.#expandedPresetProviderId = groupId;
			return this.#relocatePresetCursor(`profile:${groupId}:${profileName}`);
		}
		return false;
	}
	#expandSelectedPresetProvider(): void {
		const selected = this.#getSelectedPresetRow();
		if (
			!selected ||
			selected.kind === "browse" ||
			selected.kind === "create" ||
			selected.kind === "createUnavailable" ||
			selected.kind === "alreadySaved" ||
			selected.kind === "imageRole" ||
			selected.kind === "smartRouting"
		)
			return;
		if (this.#expandedPresetProviderId === selected.groupId) return;
		const targetIdentity = presetRowIdentity(selected);
		this.#expandedPresetProviderId = selected.groupId;
		if (!this.#relocatePresetCursor(targetIdentity)) this.#clampPresetCursor();
	}

	#collapseSelectedPresetProvider(): void {
		const selected = this.#getSelectedPresetRow();
		if (
			!selected ||
			selected.kind === "browse" ||
			selected.kind === "create" ||
			selected.kind === "createUnavailable" ||
			selected.kind === "alreadySaved" ||
			selected.kind === "imageRole" ||
			selected.kind === "smartRouting"
		)
			return;
		if (this.#expandedPresetProviderId !== selected.groupId) return;
		const targetIdentity = selected.kind === "profile" ? `group:${selected.groupId}` : presetRowIdentity(selected);
		this.#expandedPresetProviderId = undefined;
		if (!this.#relocatePresetCursor(targetIdentity)) this.#clampPresetCursor();
	}

	#setSearchInputValue(value: string): void {
		this.#searchInput.setValue(value);
	}

	#switchToModelMode(seed?: string, options?: { imageRoleFilter?: boolean }): void {
		this.#viewMode = "models";
		this.#expandedPresetProviderId = undefined;
		this.#previewProfileName = undefined;
		this.#presetScopeMenuOpen = false;
		this.#presetScopeIndex = 0;
		this.#presetLoginHint = undefined;
		this.#activeTabIndex = 0;
		this.#selectedIndex = 0;
		this.#imageRoleFilter = options?.imageRoleFilter ?? false;
		this.#setSearchInputValue(seed ?? this.#searchInput.getValue());
		this.#updateTabBar();
		this.#filterModels(this.#searchInput.getValue());
	}

	/**
	 * "What is this session running right now" summary for the preset landing
	 * header: active preset (when one is applied), the effective current model
	 * and thinking level, and one line per assigned role (default, executor,
	 * planner, critic, architect).
	 */
	#formatCurrentSessionLines(): string[] {
		const lines: string[] = [];
		const parts: string[] = [];
		if (this.#activeModelProfile) {
			const profile = this.#getProfileByName(this.#activeModelProfile);
			const displayName = profile ? getModelProfilePresentation(profile).displayName : this.#activeModelProfile;
			parts.push(`preset ${theme.fg("accent", displayName)}`);
		}
		if (this.#currentModel) {
			parts.push(this.#formatAssignedModelLabel(this.#currentModel, this.#currentThinkingLevel));
		}
		if (parts.length > 0) lines.push(theme.fg("muted", `Current: ${parts.join(" · ")}`));
		for (const role of PROFILE_ROLE_PREVIEW_ORDER) {
			const assigned = this.#roles[role];
			if (!assigned) continue;
			const label = GJC_MODEL_ASSIGNMENT_TARGETS[role].tag ?? role.toUpperCase();
			lines.push(
				theme.fg("dim", `  ${label}: ${this.#formatAssignedModelLabel(assigned.model, assigned.thinkingLevel)}`),
			);
		}
		return lines;
	}

	#formatAssignedModelLabel(model: Model, thinkingLevel: ThinkingLevel | undefined): string {
		const modelLabel = sanitizeText(`${model.provider}/${model.id}`).replace(/\s+/g, " ").trim();
		let label = modelLabel;
		if (thinkingLevel && thinkingLevel !== ThinkingLevel.Inherit) {
			label += ` (${getThinkingLevelMetadata(thinkingLevel).label})`;
		}
		return truncateToWidth(label, ROLE_BINDING_MAX_WIDTH);
	}

	/**
	 * A recorded declaration always wins; otherwise seed from the deterministic
	 * provider priority so the draft reflects the user's configured order instead of
	 * raw catalog iteration. No hardcoded provider fallback: an empty catalog means
	 * there is nothing to generate tiers from, and the caller refuses entry.
	 */
	#smartRoutingSetup(): AutoroutingSetup {
		const stored = this.#settings.get("task.autorouting.setup");
		if (validateAutoroutingSetup(stored).length === 0 && stored !== undefined) return structuredClone(stored);
		return { schema: 1, providers: [...this.#modelRegistry.autoroutingProviderOrder()] };
	}

	/**
	 * Advisory hint input is the panel's *current draft*, not the persisted setup, so
	 * a user mid-reorder sees drift for what they are actually editing.
	 */
	#providerOrderHintFor(declared: readonly string[]): AutoroutingProviderOrderHint {
		return autoroutingProviderOrderHint(declared, this.#modelRegistry.autoroutingProviderOrder());
	}

	#smartRoutingPreview(setup: AutoroutingSetup): SmartRoutingPreview {
		if (!this.#smartRoutingPreviewBuilder) {
			throw new Error("Smart-routing preview is unavailable in this selector context.");
		}
		return this.#smartRoutingPreviewBuilder(setup);
	}

	#smartRoutingIsStale(): boolean {
		const provenance = this.#settings.get("task.autorouting.provenance");
		if (!provenance || validateAutoroutingSetup(this.#smartRoutingSetup()).length > 0) return false;
		try {
			const preview = this.#smartRoutingPreview(this.#smartRoutingSetup());
			const state = evaluateAutoroutingProvenanceState(provenance, {
				catalogFingerprint: preview.sourceIdentity.catalogFingerprint,
				mapFingerprint: preview.sourceIdentity.mapFingerprint,
				tiers: this.#settings.get("task.autorouting.tiers") ?? {},
			});
			return state.staleMap || state.staleCatalog || state.handEdited;
		} catch {
			return true;
		}
	}

	#smartRoutingReadOnly(): boolean {
		return this.#temporaryOnly || this.#scopedModels.length > 0 || !this.#settings.canWriteDurableConfig();
	}

	#enterSmartRoutingMode(): void {
		if (!this.#smartRoutingPreviewBuilder) {
			if (this.#smartRoutingOnly) {
				this.#onCancelCallback();
				return;
			}
			this.#presetLoginHint = "Smart-routing setup is unavailable in this selector context.";
			this.#renderPresetLanding();
			return;
		}

		const setup = this.#smartRoutingSetup();
		if (setup.providers.length === 0) {
			// Nothing to generate tiers from; refuse entry instead of seeding a guess.
			if (this.#smartRoutingOnly) {
				this.#onCancelCallback();
				return;
			}
			this.#presetLoginHint = "No providers are available to generate routing tiers.";
			this.#renderPresetLanding();
			return;
		}
		const preview = this.#smartRoutingPreview(setup);
		const tiers = normalizeTierMap(this.#settings.get("task.autorouting.tiers"));
		const provenance = this.#settings.get("task.autorouting.provenance");
		this.#viewMode = "smart-routing";
		this.#smartRoutingPanel = new SmartRoutingPanelComponent({
			setup,
			tiers,
			provenance,
			enabled: this.#settings.get("task.autorouting.enabled") === true,
			providerOrderHint: this.#providerOrderHintFor(setup.providers),
			readOnly: this.#smartRoutingReadOnly(),
			stale: this.#smartRoutingIsStale(),
			preview,
			generatePreview: draft => this.#smartRoutingPreview(draft),
			onSelect: async intent => {
				await this.#onSelectCallback({ kind: "smartRouting", intent });
				return intent.kind === "apply" ? this.#smartRoutingPreview(intent.draft) : undefined;
			},
			onCancel: () => (this.#smartRoutingOnly ? this.#onCancelCallback() : this.#switchToPresetMode()),
		});
		this.#headerContainer.clear();
		this.#headerContainer.addChild(new Text(theme.fg("accent", "Smart routing"), 0, 0));
		this.#tabBar = null;
		this.#listContainer.clear();
		this.#listContainer.addChild(this.#smartRoutingPanel);
		this.#tui.requestRender();
	}

	#switchToPresetMode(): void {
		this.#smartRoutingPanel = undefined;
		this.#viewMode = "presets";
		this.#presetCursor = Math.min(this.#presetCursor, Math.max(0, this.#getPresetRows().length - 1));
		void this.#refreshProviderAuth();
		this.#renderPresetLanding();
		this.#tui.requestRender();
	}

	refreshSmartRoutingState(): void {
		const panel = this.#smartRoutingPanel;
		if (!panel || this.#viewMode !== "smart-routing") return;
		const setup = this.#smartRoutingSetup();
		const preview = this.#smartRoutingPreview(setup);
		panel.refreshState({
			setup,
			tiers: normalizeTierMap(this.#settings.get("task.autorouting.tiers")),
			provenance: this.#settings.get("task.autorouting.provenance"),
			enabled: this.#settings.get("task.autorouting.enabled") === true,
			providerOrderHint: this.#providerOrderHintFor(setup.providers),
			stale: this.#smartRoutingIsStale(),
			preview,
		});
		this.#tui.requestRender();
	}

	#renderPresetLanding(): void {
		this.#headerContainer.clear();
		this.#tabBar = null;
		this.#listContainer.clear();
		this.#headerContainer.addChild(new Text(theme.fg("accent", "Model presets"), 0, 0));
		for (const line of this.#formatCurrentSessionLines()) {
			this.#headerContainer.addChild(new Text(line, 0, 0));
		}
		const rows = this.#getPresetRows();
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			const selected = i === this.#presetCursor;
			const prefix = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			if (row.kind === "smartRouting") {
				const stale = this.#smartRoutingIsStale();
				const label = stale ? "Smart routing (stale)" : "Smart routing setup";
				this.#listContainer.addChild(new Text(`${prefix}${selected ? theme.fg("accent", label) : label}`, 0, 0));
				continue;
			}
			if (row.kind === "create") {
				const label = "Create custom preset";
				this.#listContainer.addChild(new Text(`${prefix}${selected ? theme.fg("accent", label) : label}`, 0, 0));
				continue;
			}
			if (row.kind === "createUnavailable") {
				const renderedLabel = selected ? theme.fg("accent", row.label) : theme.fg("dim", row.label);
				this.#listContainer.addChild(new Text(`${prefix}${renderedLabel}`, 0, 0));
				continue;
			}
			if (row.kind === "alreadySaved") {
				const presentation = getModelProfilePresentation(row.profile);
				const label = `Already saved as ${presentation.displayName}`;
				const renderedLabel = selected ? theme.fg("accent", label) : theme.fg("dim", label);
				this.#listContainer.addChild(new Text(`${prefix}${renderedLabel}`, 0, 0));
				continue;
			}
			if (row.kind === "browse") {
				const label = "Browse all models";
				this.#listContainer.addChild(new Text(`${prefix}${selected ? theme.fg("accent", label) : label}`, 0, 0));
				continue;
			}
			if (row.kind === "imageRole") {
				const imageRoleValue = this.#settings.getModelRole("image");
				const current = imageRoleValue
					? Array.isArray(imageRoleValue)
						? imageRoleValue[0]
						: imageRoleValue
					: "No image model set";
				const label = `Image Role: ${current}`;
				this.#listContainer.addChild(new Text(`${prefix}${selected ? theme.fg("accent", label) : label}`, 0, 0));
				continue;
			}
			if (row.kind === "group") {
				const authenticated = this.#isPresetGroupUsable(row.profiles);
				const mark = this.#providerAuthPending ? "…" : authenticated ? "✓" : "✗";
				const containsActive =
					this.#activeModelProfile !== undefined &&
					row.profiles.some(profile => profile.name === this.#activeModelProfile);
				const label = `${mark} ${row.groupId}`;
				const renderedLabel = selected ? theme.fg("accent", label) : authenticated ? label : theme.fg("dim", label);
				const activeSuffix = containsActive ? theme.fg("muted", " (current)") : "";
				this.#listContainer.addChild(new Text(`${prefix}${renderedLabel}${activeSuffix}`, 0, 0));
				continue;
			}
			const presentation = getModelProfilePresentation(row.profile);
			const authenticated = this.#isPresetAuthenticated(row.profile);
			const mark = this.#providerAuthPending ? "…" : authenticated ? "✓" : "✗";
			const isActive = row.profile.name === this.#activeModelProfile;
			const label = `  ${mark} ${presentation.displayName}`;
			const renderedLabel = selected ? theme.fg("accent", label) : authenticated ? label : theme.fg("dim", label);
			const activeSuffix = isActive ? theme.fg("muted", " (current)") : "";
			this.#listContainer.addChild(new Text(`${prefix}${renderedLabel}${activeSuffix}`, 0, 0));
		}
		if (this.#presetLoginHint) {
			this.#listContainer.addChild(new Spacer(1));
			this.#listContainer.addChild(new Text(theme.fg("warning", `  ${this.#presetLoginHint}`), 0, 0));
		}
		const previewProfile = this.#getProfileByName(this.#previewProfileName);
		if (previewProfile) this.#renderPresetPreview(previewProfile);
	}

	#renderPresetPreview(profile: ModelProfileDefinition): void {
		this.#listContainer.addChild(new Spacer(1));
		this.#listContainer.addChild(
			new Text(theme.fg("muted", `  Preset preview: ${getModelProfilePresentation(profile).displayName}`), 0, 0),
		);
		for (const role of PROFILE_ROLE_PREVIEW_ORDER) {
			const selector = profile.modelMapping[role];
			if (!selector) continue;
			const resolved = resolveModelRoleValue(selector, this.#modelRegistry.getAll(), {
				settings: this.#settings,
				matchPreferences: { usageOrder: this.#settings.getStorage()?.getModelUsageOrder() },
				modelRegistry: this.#modelRegistry,
				aliasIntent: "preset-equivalent",
				credentialSessionId: this.#authSessionId,
			});
			const label = GJC_MODEL_ASSIGNMENT_TARGETS[role].tag ?? role.toUpperCase();
			this.#listContainer.addChild(
				new Text(`  ${label}: ${formatClampedModelSelector(selectorHead(selector) ?? "", resolved.model)}`, 0, 0),
			);
		}
		this.#listContainer.addChild(new Spacer(1));
		if (this.#presetScopeMenuOpen) {
			const actionLabels = this.#getPresetScopeLabels(profile);
			for (let i = 0; i < actionLabels.length; i++) {
				const label = actionLabels[i] ?? "";
				const prefix = i === this.#presetScopeIndex ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
				this.#listContainer.addChild(
					new Text(`${prefix}${i === this.#presetScopeIndex ? theme.fg("accent", label) : label}`, 0, 0),
				);
			}
			this.#listContainer.addChild(new Spacer(1));
			this.#listContainer.addChild(
				new Text(theme.fg("muted", "  Enter: apply | d: set as default | Esc: back"), 0, 0),
			);
		} else {
			this.#listContainer.addChild(
				new Text(theme.fg("muted", "  Press Enter to apply or d to set as default"), 0, 0),
			);
		}
	}

	#formatDiscoveryErrorHint(error: string | undefined): string | undefined {
		if (!error) {
			return undefined;
		}
		const httpMatch = error.match(/^HTTP (\d+) from (.+)$/);
		if (!httpMatch) {
			return undefined;
		}
		const [, statusCode, url] = httpMatch;
		if (statusCode === "404") {
			return `  Discovery endpoint ${url} returned 404. Point baseUrl at the host that serves /models (usually .../v1).`;
		}
		return `  Discovery failed: ${error}`;
	}

	#getProviderEmptyStateMessage(): string | undefined {
		const activeProviderId = this.#getActiveProviderId();
		if (!activeProviderId || this.#searchInput.getValue().trim()) {
			return undefined;
		}
		const state = this.#modelRegistry.getProviderDiscoveryState(activeProviderId);
		if (!state) {
			return undefined;
		}
		const age = this.#formatDiscoveryAge(state.fetchedAt);
		switch (state.status) {
			case "cached":
				return age
					? `  Using cached model list from ${age}. Live refresh is still pending.`
					: "  Using cached model list. Live refresh is still pending.";
			case "unavailable":
				return (
					this.#formatDiscoveryErrorHint(state.error) ??
					(age ? `  Provider unavailable. Using cached model list from ${age}.` : "  Provider unavailable.")
				);
			case "unauthenticated":
				return "  Provider requires authentication before discovery. Use /provider login or /login for OAuth/subscription providers, or /provider add for API-compatible providers.";
			case "idle":
				return "  Provider has not been refreshed yet.";
			case "empty":
				return "  Discovery succeeded but returned 0 models. Check that /models returns { data: [{ id }] }.";
			case "ok":
				return undefined;
		}
	}

	#updateList(): void {
		this.#listContainer.clear();
		const isCanonicalTab = this.#isCanonicalTab();
		const modelSelectedIndex = this.#selectedIndex;
		const visibleItems = isCanonicalTab ? this.#filteredCanonicalModels : this.#filteredModels;

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(modelSelectedIndex - Math.floor(maxVisible / 2), visibleItems.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, visibleItems.length);

		const showProvider = this.#getActiveTabId() === ALL_TAB;

		// Show visible slice of filtered models
		for (let i = startIndex; i < endIndex; i++) {
			const item = visibleItems[i];
			if (!item) continue;
			const canonicalItem = isCanonicalTab ? (item as CanonicalModelItem) : undefined;
			const providerItem = isCanonicalTab ? undefined : (item as ModelItem);

			const isSelected = i === this.#selectedIndex;

			// Build role badges (inverted: color as background, black text)
			const roleBadgeTokens: string[] = [];
			// Whether a non-subagent (modelRoles) badge on the CURRENT model row already
			// rendered the current-model EFFECTIVE glyph. Only that case should suppress
			// the standalone current glyph below — a subagent-only match must NOT, since
			// subagent badges reflect the subagent tier, not the current model.
			let currentModelEffectiveGlyphRendered = false;
			for (const role of GJC_MODEL_ASSIGNMENT_TARGET_IDS) {
				const roleInfo = GJC_MODEL_ASSIGNMENT_TARGETS[role];
				const assigned = this.#roles[role];
				if (roleInfo.tag && assigned && modelsAreEqual(assigned.model, item.model)) {
					const badge = makeInvertedBadge(roleInfo.tag, roleInfo.color ?? "muted");
					const thinkingLabel = getThinkingLevelMetadata(assigned.thinkingLevel).label;

					// Subagent roles (task.agentModelOverrides) run under task.serviceTier,
					// so their ⚡ uses the effective subagent tier. A non-subagent
					// (modelRoles) badge on the CURRENT model row uses the current-model
					// effective predicate so a provider auto-disable hides the glyph;
					// other modelRoles rows show pure intent.
					const isSubagentRole = roleInfo.settingsPath === "task.agentModelOverrides";
					const isCurrentRow = this.#currentModel !== undefined && modelsAreEqual(this.#currentModel, item.model);
					const supportsServiceTier = modelSupportsServiceTier(assigned.model);
					const roleFast = isSubagentRole
						? this.#isFastForSubagentProvider(assigned.model.provider, supportsServiceTier)
						: isCurrentRow
							? this.#isCurrentModelFastModeActive()
							: this.#isFastForProvider(assigned.model.provider, supportsServiceTier);
					if (roleFast && isCurrentRow && !isSubagentRole) {
						currentModelEffectiveGlyphRendered = true;
					}
					const fastSuffix = roleFast ? ` ${theme.icon.fast}` : "";
					roleBadgeTokens.push(`${badge} ${theme.fg("dim", `(${thinkingLabel})`)}${fastSuffix}`);
				}
			}
			// Active/current non-role row: show the fast glyph on the session's current
			// model row. Suppress only when a non-subagent current-row badge already
			// rendered the current-model effective glyph (duplicate-glyph guard) — a
			// subagent-only match must not hide the current model's own indicator.
			if (
				!currentModelEffectiveGlyphRendered &&
				this.#currentModel !== undefined &&
				modelsAreEqual(this.#currentModel, item.model) &&
				this.#isCurrentModelFastModeActive()
			) {
				roleBadgeTokens.push(theme.icon.fast);
			}
			const badgeText = roleBadgeTokens.length > 0 ? ` ${roleBadgeTokens.join(" ")}` : "";

			let line = "";
			if (isSelected) {
				const prefix = theme.fg("accent", `${theme.nav.cursor} `);
				if (isCanonicalTab) {
					const variants = theme.fg("dim", ` [${canonicalItem?.variantCount ?? 0}]`);
					const backing = theme.fg("dim", ` -> ${item.model.provider}/${item.model.id}`);
					line = `${prefix}${theme.fg("accent", item.id)}${variants}${backing}${badgeText}`;
				} else if (showProvider) {
					const providerPrefix = theme.fg("dim", `${providerItem?.provider ?? ""}/`);
					line = `${prefix}${providerPrefix}${theme.fg("accent", providerItem?.id ?? item.id)}${badgeText}`;
				} else {
					line = `${prefix}${theme.fg("accent", item.id)}${badgeText}`;
				}
			} else {
				const prefix = "  ";
				if (isCanonicalTab) {
					const variants = theme.fg("dim", ` [${canonicalItem?.variantCount ?? 0}]`);
					const backing = theme.fg("dim", ` -> ${item.model.provider}/${item.model.id}`);
					line = `${prefix}${item.id}${variants}${backing}${badgeText}`;
				} else if (showProvider) {
					const providerPrefix = theme.fg("dim", `${providerItem?.provider ?? ""}/`);
					line = `${prefix}${providerPrefix}${providerItem?.id ?? item.id}${badgeText}`;
				} else {
					line = `${prefix}${item.id}${badgeText}`;
				}
			}

			this.#listContainer.addChild(new Text(line, 0, 0));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < visibleItems.length) {
			const scrollInfo = theme.fg("muted", `  (${this.#selectedIndex + 1}/${visibleItems.length})`);
			this.#listContainer.addChild(new Text(scrollInfo, 0, 0));
		}

		// Show error message or "no results" if empty
		if (this.#errorMessage) {
			const errorLines = String(this.#errorMessage).split("\n");
			for (const line of errorLines) {
				this.#listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (visibleItems.length === 0) {
			const statusMessage = this.#getProviderEmptyStateMessage();
			this.#listContainer.addChild(
				new Text(
					theme.fg("muted", statusMessage ?? `  No matching models. ${formatModelOnboardingInlineHint()}`),
					0,
					0,
				),
			);
		} else {
			const selected = visibleItems[modelSelectedIndex];
			if (!selected) {
				return;
			}
			this.#listContainer.addChild(new Spacer(1));
			const suffix = isCanonicalTab
				? ` (${selected.model.provider}/${selected.model.id}, ${(selected as CanonicalModelItem).variantCount} variants)`
				: "";
			this.#listContainer.addChild(
				new Text(theme.fg("muted", `  Model Name: ${selected.model.name}${suffix}`), 0, 0),
			);
			if (this.#pendingThinkingChoice) {
				this.#renderThinkingMenu(this.#pendingThinkingChoice);
			} else if (this.#pendingActionItem) {
				this.#renderActionMenu(this.#pendingActionItem);
			}
		}
	}

	#renderActionMenu(item: ModelItem | CanonicalModelItem): void {
		this.#listContainer.addChild(new Spacer(1));
		this.#listContainer.addChild(new Text(theme.fg("muted", `  Action for: ${item.model.id}`), 0, 0));
		this.#listContainer.addChild(new Spacer(1));
		const actionCount = this.#getActionCount(item.model);
		for (let i = 0; i < actionCount; i++) {
			const prefix = i === this.#selectedActionIndex ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const role = GJC_MODEL_ASSIGNMENT_TARGET_IDS[i];
			const label = role
				? `Set as ${GJC_MODEL_ASSIGNMENT_TARGETS[role].tag ?? role.toUpperCase()} (${GJC_MODEL_ASSIGNMENT_TARGETS[role].name}) — now: ${this.#formatRoleBinding(role)}`
				: i === GJC_MODEL_ASSIGNMENT_TARGET_IDS.length
					? "Set for all role agents"
					: "Set for all targets";
			this.#listContainer.addChild(
				new Text(`${prefix}${i === this.#selectedActionIndex ? theme.fg("accent", label) : label}`, 0, 0),
			);
		}
	}

	/**
	 * Describe what a role currently points at so the assignment menu can show the
	 * existing binding inline. Without it the role rows carry no binding and the
	 * only way to learn a role's model is to scan the whole (800+ entry) model list
	 * for role badges.
	 */
	#formatRoleBinding(role: GjcModelAssignmentTargetId): string {
		const target = GJC_MODEL_ASSIGNMENT_TARGETS[role];
		const configured =
			target.settingsPath === "modelRoles"
				? this.#settings.getModelRole(role)
				: this.#settings.get("task.agentModelOverrides")[role];
		const selectors = normalizeModelSelectorValue(configured);
		const head = selectors[0];
		const assigned = this.#roles[role];
		if (!head) {
			if (assigned) return this.#formatAssignedModelLabel(assigned.model, assigned.thinkingLevel);
			return role === "default" ? "unset" : "inherits default";
		}
		const inheritedThinkingLevel = getDefaultAliasThinkingLevel(head);
		const isInheritedAlias = head === "pi/default" || inheritedThinkingLevel !== undefined;
		// A role agent pinned to the `pi/default` alias inherits whatever the default
		// resolves to. Classify that before the resolved lookup: the alias itself resolves
		// to the default's model, which would otherwise render as a concrete id and hide the
		// inheritance. A fallback chain merely headed by the alias is NOT inherited —
		// resolution can advance to a tail entry — so it falls through to the resolved
		// binding below.
		if (role !== "default" && selectors.length === 1 && isInheritedAlias) {
			return inheritedThinkingLevel ? `inherits default (${inheritedThinkingLevel})` : "inherits default";
		}
		if (assigned) return this.#formatAssignedModelLabel(assigned.model, assigned.thinkingLevel);
		// Configured selectors are permissively validated, so bound and sanitize the raw
		// value before it reaches the terminal.
		const displayed = truncateToWidth(sanitizeText(head).replace(/\s+/g, " ").trim(), ROLE_BINDING_MAX_WIDTH);
		return `${displayed} (unavailable)`;
	}

	#renderThinkingMenu(choice: PendingThinkingChoice): void {
		const targetLabel = choice.roles
			? choice.roles.includes("default")
				? "all targets"
				: "all role agents"
			: choice.role === null
				? "temporary model"
				: GJC_MODEL_ASSIGNMENT_TARGETS[choice.role].name;
		// Show the highlighted reasoning level — never the model id (that mislabel
		// made "Reasoning for Default: gpt-5.6-luna" look like a level).
		const selectedLevel = choice.levels[this.#selectedThinkingIndex];
		const selectedLevelLabel = selectedLevel ? getThinkingLevelMetadata(selectedLevel).label : "—";
		this.#listContainer.addChild(new Spacer(1));
		this.#listContainer.addChild(
			new Text(theme.fg("muted", `  Reasoning for ${targetLabel}: ${selectedLevelLabel}`), 0, 0),
		);
		this.#listContainer.addChild(new Spacer(1));
		for (let i = 0; i < choice.levels.length; i++) {
			const level = choice.levels[i];
			const metadata = getThinkingLevelMetadata(level);
			const prefix = i === this.#selectedThinkingIndex ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const label = `${metadata.label} — ${metadata.description}`;
			this.#listContainer.addChild(
				new Text(`${prefix}${i === this.#selectedThinkingIndex ? theme.fg("accent", label) : label}`, 0, 0),
			);
		}
	}

	#getCurrentRoleThinkingLevel(role: string): ThinkingLevel {
		return this.#roles[role]?.thinkingLevel ?? ThinkingLevel.Inherit;
	}
	#getActionCount(_model: Model): number {
		return GJC_MODEL_ASSIGNMENT_TARGET_IDS.length + 2;
	}

	#getSelectedItem(): ModelItem | CanonicalModelItem | undefined {
		return this.#isCanonicalTab()
			? this.#filteredCanonicalModels[this.#selectedIndex]
			: this.#filteredModels[this.#selectedIndex];
	}

	handleInput(keyData: string): void {
		if (this.#viewMode === "smart-routing") {
			this.#smartRoutingPanel?.handleInput(keyData);
			return;
		}
		if (this.#assignmentState === "assigning") {
			if (getKeybindings().matches(keyData, "tui.select.cancel")) {
				this.#closeAfterAssignment = true;
			}
			return;
		}
		if (this.#pendingThinkingChoice) {
			this.#handleThinkingMenuInput(keyData);
			return;
		}
		if (this.#pendingActionItem) {
			this.#handleActionMenuInput(keyData);
			return;
		}

		if (this.#viewMode === "presets") {
			this.#handlePresetLandingInput(keyData);
			return;
		}

		// Tab bar navigation
		if (this.#tabBar?.handleInput(keyData)) {
			return;
		}

		// Up arrow - navigate list (wrap to bottom when at top)
		if (matchesKey(keyData, "up")) {
			const itemCount = this.#isCanonicalTab() ? this.#filteredCanonicalModels.length : this.#filteredModels.length;
			if (itemCount === 0) return;
			this.#selectedIndex = this.#selectedIndex === 0 ? itemCount - 1 : this.#selectedIndex - 1;
			this.#updateList();
			return;
		}

		// Down arrow - navigate list (wrap to top when at bottom)
		if (matchesKey(keyData, "down")) {
			const itemCount = this.#isCanonicalTab() ? this.#filteredCanonicalModels.length : this.#filteredModels.length;
			if (itemCount === 0) return;
			this.#selectedIndex = this.#selectedIndex === itemCount - 1 ? 0 : this.#selectedIndex + 1;
			this.#updateList();
			return;
		}

		// Enter opens the persistent assignment menu. Temporary-only mode keeps the
		// existing non-persistent quick-switch behavior.
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selectedItem = this.#getSelectedItem();
			if (selectedItem) this.#beginActionMenuOrSelect(selectedItem);
			return;
		}

		// Escape or Ctrl+C - close selector
		if (getKeybindings().matches(keyData, "tui.select.cancel")) {
			this.#onCancelCallback();
			return;
		}

		// Pass everything else to search input
		this.#searchInput.handleInput(keyData);
		this.#filterModels(this.#searchInput.getValue());
	}

	#handlePresetLandingInput(keyData: string): void {
		if (keyData === "d" || keyData === "D") {
			if (this.#previewProfileName) {
				this.#presetScopeMenuOpen = true;
				this.#presetScopeIndex = 1;
				this.#handlePresetEnter();
				return;
			}
		}
		if (isPrintableCharacter(keyData)) {
			this.#switchToModelMode(keyData);
			return;
		}
		if (matchesKey(keyData, "up")) {
			const rows = this.#getPresetRows();
			if (rows.length === 0) return;
			if (this.#presetScopeMenuOpen) {
				const actionCount = this.#getPreviewPresetScopeLabels().length;
				this.#presetScopeIndex = this.#presetScopeIndex === 0 ? actionCount - 1 : this.#presetScopeIndex - 1;
			} else {
				this.#presetCursor = this.#presetCursor === 0 ? rows.length - 1 : this.#presetCursor - 1;
				this.#previewProfileName = undefined;
				this.#presetLoginHint = undefined;
				this.#clampPresetCursor();
			}
			this.#renderPresetLanding();
			return;
		}
		if (matchesKey(keyData, "down")) {
			const rows = this.#getPresetRows();
			if (rows.length === 0) return;
			if (this.#presetScopeMenuOpen) {
				this.#presetScopeIndex = (this.#presetScopeIndex + 1) % this.#getPreviewPresetScopeLabels().length;
			} else {
				this.#presetCursor = (this.#presetCursor + 1) % rows.length;
				this.#previewProfileName = undefined;
				this.#presetLoginHint = undefined;
				this.#clampPresetCursor();
			}
			this.#renderPresetLanding();
			return;
		}
		if (matchesKey(keyData, "right")) {
			if (!this.#presetScopeMenuOpen) {
				this.#expandSelectedPresetProvider();
				this.#previewProfileName = undefined;
				this.#presetLoginHint = undefined;
				this.#renderPresetLanding();
			}
			return;
		}
		if (matchesKey(keyData, "left")) {
			if (!this.#presetScopeMenuOpen) {
				this.#collapseSelectedPresetProvider();
				this.#previewProfileName = undefined;
				this.#presetLoginHint = undefined;
				this.#renderPresetLanding();
			}
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#handlePresetEnter();
			return;
		}
		if (getKeybindings().matches(keyData, "tui.select.cancel")) {
			if (this.#presetScopeMenuOpen) {
				this.#presetScopeMenuOpen = false;
				this.#renderPresetLanding();
				return;
			}
			if (this.#previewProfileName) {
				this.#previewProfileName = undefined;
				this.#renderPresetLanding();
				return;
			}
			if (this.#expandedPresetProviderId) {
				this.#expandedPresetProviderId = undefined;
				this.#clampPresetCursor();
				this.#renderPresetLanding();
				return;
			}
			this.#onCancelCallback();
		}
	}

	#handlePresetEnter(): void {
		if (this.#presetScopeMenuOpen && this.#previewProfileName) {
			const profile = this.#getProfileByName(this.#previewProfileName);
			if (!profile) return;
			if (this.#presetScopeIndex === 2 && isCustomUserProfile(profile)) {
				this.#onSelectCallback({ kind: "renameProfile", profileName: this.#previewProfileName });
				return;
			}
			if (this.#presetScopeIndex === 3 && isCustomUserProfile(profile)) {
				this.#onSelectCallback({ kind: "deleteProfile", profileName: this.#previewProfileName });
				return;
			}
			const missing = this.#getMissingProviders(profile);
			if (missing.length > 0) {
				this.#presetLoginHint = `Run ${missing.map(provider => `/login ${provider}`).join(", ")}`;
				this.#renderPresetLanding();
				return;
			}
			if (!this.#isPresetAuthenticated(profile)) {
				this.#presetLoginHint = "No available model matches this preset";
				this.#renderPresetLanding();
				return;
			}
			this.#onSelectCallback({
				kind: "profile",
				profileName: this.#previewProfileName,
				setDefault: this.#presetScopeIndex === 1,
			});
			return;
		}
		if (this.#previewProfileName) {
			this.#presetScopeMenuOpen = true;
			this.#presetScopeIndex = 0;
			this.#renderPresetLanding();
			return;
		}
		const row = this.#getSelectedPresetRow();
		if (!row) return;
		if (row.kind === "smartRouting") {
			this.#enterSmartRoutingMode();
			return;
		}
		if (row.kind === "create") {
			this.#onSelectCallback({ kind: "createProfile", profile: this.#buildCustomModelProfileSnapshot() });
			return;
		}
		if (row.kind === "alreadySaved" || row.kind === "createUnavailable") {
			return;
		}
		if (row.kind === "browse") {
			this.#switchToModelMode();
			return;
		}
		if (row.kind === "imageRole") {
			this.#switchToModelMode(undefined, { imageRoleFilter: true });
			return;
		}
		if (row.kind === "group") {
			// A group is a list of alternative presets; only surface a login hint
			// when none of its members are usable. A partially-usable group stays
			// navigable so the user can drill in and pick a usable member.
			if (!this.#isPresetGroupUsable(row.profiles)) {
				const missing = this.#getMissingProviders(row.profiles);
				this.#presetLoginHint =
					missing.length > 0
						? `Run ${missing.map(provider => `/login ${provider}`).join(", ")}`
						: "No available model matches this preset";
				this.#renderPresetLanding();
				return;
			}
			// Enter toggles a usable group's expansion so drilling into presets
			// works without reaching for the arrow keys (right/left still work).
			if (this.#expandedPresetProviderId === row.groupId) {
				this.#collapseSelectedPresetProvider();
			} else {
				this.#expandSelectedPresetProvider();
			}
			this.#presetLoginHint = undefined;
			this.#renderPresetLanding();
			return;
		}
		const missing = this.#getMissingProviders(row.profile);
		if (missing.length > 0 && !isCustomUserProfile(row.profile)) {
			this.#presetLoginHint = `Run ${missing.map(provider => `/login ${provider}`).join(", ")}`;
			this.#renderPresetLanding();
			return;
		}
		if (!isCustomUserProfile(row.profile) && !this.#isPresetAuthenticated(row.profile)) {
			this.#presetLoginHint = "No available model matches this preset";
			this.#renderPresetLanding();
			return;
		}
		this.#previewProfileName = row.profile.name;
		this.#presetLoginHint = undefined;
		this.#renderPresetLanding();
	}

	#getPresetScopeLabels(profile: ModelProfileDefinition): string[] {
		return isCustomUserProfile(profile) ? CUSTOM_PRESET_SCOPE_LABELS : PRESET_SCOPE_LABELS;
	}

	#getPreviewPresetScopeLabels(): string[] {
		const profile = this.#getProfileByName(this.#previewProfileName);
		return profile ? this.#getPresetScopeLabels(profile) : PRESET_SCOPE_LABELS;
	}

	refreshPresetProfiles(profileName?: string): void {
		if (profileName) {
			this.#previewProfileName = profileName;
			this.#presetLoginHint = undefined;
			if (!this.#relocatePresetCursorForProfile(profileName)) this.#clampPresetCursor();
		} else {
			this.#previewProfileName = undefined;
			this.#presetScopeMenuOpen = false;
			this.#presetScopeIndex = 0;
			this.#presetLoginHint = undefined;
			this.#clampPresetCursor();
		}
		this.#renderPresetLanding();
		this.#tui.requestRender();
	}

	#beginActionMenuOrSelect(item: ModelItem | CanonicalModelItem): void {
		if (this.#temporaryOnly) {
			this.#handleSelect(item, null);
			return;
		}
		this.#pendingActionItem = item;
		this.#selectedActionIndex = 0;
		this.#updateList();
	}

	#handleActionMenuInput(keyData: string): void {
		const item = this.#pendingActionItem;
		if (!item) return;
		const actionCount = this.#getActionCount(item.model);
		if (matchesKey(keyData, "up")) {
			this.#selectedActionIndex = this.#selectedActionIndex === 0 ? actionCount - 1 : this.#selectedActionIndex - 1;
			this.#updateList();
			return;
		}
		if (matchesKey(keyData, "down")) {
			this.#selectedActionIndex = (this.#selectedActionIndex + 1) % actionCount;
			this.#updateList();
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#pendingActionItem = undefined;
			const role = GJC_MODEL_ASSIGNMENT_TARGET_IDS[this.#selectedActionIndex];
			if (role) {
				this.#handleSelect(item, role);
				return;
			}
			const roles =
				this.#selectedActionIndex === GJC_MODEL_ASSIGNMENT_TARGET_IDS.length
					? (["executor", "architect", "planner", "critic"] as const)
					: GJC_MODEL_ASSIGNMENT_TARGET_IDS;
			this.#handleSelect(item, "default", undefined, roles);
			return;
		}
		if (getKeybindings().matches(keyData, "tui.select.cancel")) {
			this.#pendingActionItem = undefined;
			this.#updateList();
		}
	}

	#handleThinkingMenuInput(keyData: string): void {
		const choice = this.#pendingThinkingChoice;
		if (!choice) return;
		if (matchesKey(keyData, "up")) {
			this.#selectedThinkingIndex =
				this.#selectedThinkingIndex === 0 ? choice.levels.length - 1 : this.#selectedThinkingIndex - 1;
			this.#updateList();
			return;
		}
		if (matchesKey(keyData, "down")) {
			this.#selectedThinkingIndex = (this.#selectedThinkingIndex + 1) % choice.levels.length;
			this.#updateList();
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const level = choice.levels[this.#selectedThinkingIndex];
			if (!level) return;
			this.#pendingThinkingChoice = undefined;
			this.#handleSelect(choice.item, choice.role, level, choice.roles);
			return;
		}
		if (getKeybindings().matches(keyData, "tui.select.cancel")) {
			this.#pendingThinkingChoice = undefined;
			if (choice.role !== null) {
				this.#pendingActionItem = choice.item;
				this.#selectedActionIndex = choice.roles
					? GJC_MODEL_ASSIGNMENT_TARGET_IDS.length + (choice.roles.includes("default") ? 1 : 0)
					: Math.max(0, GJC_MODEL_ASSIGNMENT_TARGET_IDS.indexOf(choice.role));
			}
			this.#updateList();
		}
	}
	#getInitialThinkingChoiceIndex(
		item: ModelItem | CanonicalModelItem,
		levels: ThinkingLevel[],
		role: GjcModelAssignmentTargetId | null = null,
		roles?: readonly GjcModelAssignmentTargetId[],
	): number {
		const preferred = this.#getPreferredThinkingLevel(item, role, roles);
		if (preferred && preferred !== ThinkingLevel.Inherit) {
			const index = levels.indexOf(preferred);
			if (index !== -1) return index;
		}
		return 0;
	}

	/**
	 * Prefer the role binding the user is editing when it already points at this
	 * model so the reasoning menu opens on the level role badges already show
	 * (e.g. EXECUTOR (xhigh) must not leave the cursor on "off").
	 */
	#getPreferredThinkingLevel(
		item: ModelItem | CanonicalModelItem,
		role: GjcModelAssignmentTargetId | null = null,
		roles?: readonly GjcModelAssignmentTargetId[],
	): ThinkingLevel | undefined {
		const roleThinking = this.#getAssignedThinkingLevelForModel(item.model, role, roles);
		if (roleThinking && roleThinking !== ThinkingLevel.Inherit) {
			return roleThinking;
		}
		if (item.thinkingLevel && item.thinkingLevel !== ThinkingLevel.Inherit) {
			return item.thinkingLevel;
		}
		return undefined;
	}

	#getAssignedThinkingLevelForModel(
		model: Model,
		role: GjcModelAssignmentTargetId | null,
		roles?: readonly GjcModelAssignmentTargetId[],
	): ThinkingLevel | undefined {
		if (roles && roles.length > 0) {
			const assignedLevels = roles
				.map(targetRole => this.#roles[targetRole])
				.filter(
					(assigned): assigned is RoleAssignment =>
						assigned !== undefined &&
						modelsAreEqual(assigned.model, model) &&
						assigned.thinkingLevel !== ThinkingLevel.Inherit,
				)
				.map(assigned => assigned.thinkingLevel);
			if (assignedLevels.length === 0) return undefined;
			const first = assignedLevels[0];
			return assignedLevels.every(level => level === first) ? first : undefined;
		}
		if (role === null) return undefined;
		const assigned = this.#roles[role];
		if (!assigned || !modelsAreEqual(assigned.model, model)) return undefined;
		return assigned.thinkingLevel;
	}

	#handleSelect(
		item: ModelItem | CanonicalModelItem,
		role: GjcModelAssignmentTargetId | null,
		thinkingLevel?: ThinkingLevel,
		roles?: readonly GjcModelAssignmentTargetId[],
	): void {
		const itemThinkingLevel = thinkingLevel ?? item.thinkingLevel;
		const hasExplicitThinkingChoice = thinkingLevel !== undefined || item.explicitThinkingLevel === true;
		const needsExplicitThinkingChoice = roles
			? roles.some(targetRole => requiresExplicitThinkingChoice(item.model, targetRole))
			: requiresExplicitThinkingChoice(item.model, role);
		if (!hasExplicitThinkingChoice && needsExplicitThinkingChoice) {
			const levels = getSelectableThinkingLevels(item.model);
			this.#pendingThinkingChoice = { item, role, roles, levels };
			this.#selectedThinkingIndex = this.#getInitialThinkingChoiceIndex(item, levels, role, roles);
			this.#updateList();
			return;
		}

		// For temporary role, don't save to settings - just notify caller
		if (role === null) {
			this.#onSelectCallback({
				kind: "assignment",
				model: item.model,
				role: null,
				thinkingLevel: itemThinkingLevel,
				selector: item.selector,
			});
			return;
		}

		const currentThinkingLevel = this.#getCurrentRoleThinkingLevel(role);
		const selectedThinkingLevel =
			itemThinkingLevel ??
			(currentThinkingLevel === ThinkingLevel.Inherit ||
			getSelectableThinkingLevels(item.model).includes(currentThinkingLevel)
				? currentThinkingLevel
				: ThinkingLevel.Inherit);
		const selectorValue = roles
			? formatModelSelectorValue(item.selector, selectedThinkingLevel)
			: role === "default"
				? item.selector
				: formatModelSelectorValue(item.selector, selectedThinkingLevel);

		const selection: Extract<ModelSelectorSelection, { kind: "assignment" }> = {
			kind: "assignment",
			model: item.model,
			role,
			roles,
			thinkingLevel: selectedThinkingLevel,
			selector: selectorValue,
		};
		if (this.#isTrackedSingleAssignment(selection)) {
			void this.#handleTrackedAssignment(selection);
			return;
		}

		// Update local state for UI
		for (const targetRole of roles ?? [role]) {
			this.#roles[targetRole] = { model: item.model, thinkingLevel: selectedThinkingLevel };
		}

		// Notify caller (for updating agent state if needed)
		this.#onSelectCallback(selection);

		// Update list to show new badges
		this.#updateList();
	}
	#isTrackedSingleAssignment(selection: Extract<ModelSelectorSelection, { kind: "assignment" }>): boolean {
		return selection.role !== null && selection.roles === undefined;
	}

	async #handleTrackedAssignment(selection: Extract<ModelSelectorSelection, { kind: "assignment" }>): Promise<void> {
		if (this.#assignmentState !== "idle") return;
		this.#assignmentState = "assigning";
		this.#tui.requestRender();
		try {
			await Promise.resolve(this.#onSelectCallback(selection));
		} catch {
			// The controller reports tracked assignment failures before rethrowing.
		} finally {
			this.#assignmentState = "idle";
			const shouldClose = this.#closeAfterAssignment;
			this.#closeAfterAssignment = false;
			if (shouldClose) this.#onCancelCallback();
			else this.#tui.requestRender();
		}
	}

	getSearchInput(): Input {
		return this.#searchInput;
	}
	async __testSelectProfile(profileName: string, setDefault: boolean): Promise<void> {
		await this.#onSelectCallback({ kind: "profile", profileName, setDefault });
	}
	async __testSelectAssignment(
		selection: Omit<Extract<ModelSelectorSelection, { kind: "assignment" }>, "kind">,
	): Promise<void> {
		await this.#onSelectCallback({ kind: "assignment", ...selection });
	}
	async __testSelectPresetAction(profileName: string, action: "rename" | "delete"): Promise<void> {
		await this.#onSelectCallback({
			kind: action === "rename" ? "renameProfile" : "deleteProfile",
			profileName,
		});
	}
	__testSelectedPresetRowIdentity(): string | undefined {
		const row = this.#getSelectedPresetRow();
		return row ? presetRowIdentity(row) : undefined;
	}
	__testGetSmartRoutingPanel(): SmartRoutingPanelComponent | undefined {
		return this.#smartRoutingPanel;
	}

	__testViewMode(): ModelSelectorViewMode {
		return this.#viewMode;
	}
	__testOpenSmartRoutingPanel(): void {
		this.#enterSmartRoutingMode();
	}
}

function getSelectableThinkingLevels(model: Model): ThinkingLevel[] {
	const levels: ThinkingLevel[] = [ThinkingLevel.Off];
	let efforts: readonly string[];
	try {
		efforts = getSupportedEfforts(model);
	} catch {
		return levels;
	}
	for (const effort of efforts) {
		const level = parseThinkingLevel(effort);
		if (level && !levels.includes(level)) {
			levels.push(level);
		}
	}
	return levels;
}

/** Extract the first version number from a model ID (e.g. "gemini-2.5-pro" → 2.5, "Anthropic model-sonnet-4-6" → 4.6). */
function extractVersionNumber(id: string): number {
	// Dot-separated version: "gemini-2.5-pro" → 2.5
	const dotMatch = id.match(/(?:^|[-_])(\d+\.\d+)/);
	if (dotMatch) return Number.parseFloat(dotMatch[1]);
	// Dash-separated short segments: "Anthropic model-sonnet-4-6" → 4.6, "llama-3-1-8b" → 3.1
	const dashMatch = id.match(/(?:^|[-_])(\d{1,2})-(\d{1,2})(?=-|$)/);
	if (dashMatch) return Number.parseFloat(`${dashMatch[1]}.${dashMatch[2]}`);
	// Single number after separator: "gpt-4o" → 4
	const singleMatch = id.match(/(?:^|[-_])(\d+)/);
	if (singleMatch) return Number.parseFloat(singleMatch[1]);
	return 0;
}

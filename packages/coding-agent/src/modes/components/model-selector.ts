import { ThinkingLevel } from "@gajae-code/agent-core";
import { getSupportedEfforts, type Model, modelsAreEqual } from "@gajae-code/ai";
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
} from "@gajae-code/tui";
import {
	getModelProfilePresentation,
	groupModelProfilesForPresetLanding,
	type ModelProfileDefinition,
} from "../../config/model-profiles";
import type { GjcModelAssignmentTargetId, ModelRegistry } from "../../config/model-registry";
import {
	GJC_MODEL_ASSIGNMENT_TARGET_IDS,
	GJC_MODEL_ASSIGNMENT_TARGETS,
	isAuthenticated,
} from "../../config/model-registry";
import {
	formatModelSelectorValue,
	resolveModelRoleValue,
	type ScopedModelSelection,
} from "../../config/model-resolver";
import type { ModelProfileConfig } from "../../config/models-config-schema";
import type { Settings } from "../../config/settings";
import { type ThemeColor, theme } from "../../modes/theme/theme";
import { formatModelOnboardingInlineHint } from "../../setup/model-onboarding-guidance";
import { formatClampedModelSelector, getThinkingLevelMetadata, parseThinkingLevel } from "../../thinking";
import { getTabBarTheme } from "../shared";
import { DynamicBorder } from "./dynamic-border";

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

export type ModelSelectorSelection =
	| {
			kind: "assignment";
			model: Model;
			role: GjcModelAssignmentTargetId | null;
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
	  };

interface PendingThinkingChoice {
	item: ModelItem | CanonicalModelItem;
	role: GjcModelAssignmentTargetId | null;
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

type ModelSelectorViewMode = "presets" | "models";

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

type PresetLandingRow =
	| PresetGroupRow
	| PresetProfileRow
	| PresetCreateRow
	| PresetCreateUnavailableRow
	| PresetAlreadySavedRow
	| PresetBrowseRow;

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

function isInheritedRoleSelector(value: string | undefined): boolean {
	const normalized = value?.trim();
	return !normalized || normalized === "default" || normalized === "pi/default";
}

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
	for (const selector of Object.values(modelMapping)) {
		const provider = getSelectorProvider(selector);
		if (provider) providers.add(provider);
	}
	return [...providers].sort((a, b) => a.localeCompare(b));
}

function sameStringRecord(
	left: Readonly<Record<string, string | undefined>>,
	right: Readonly<Record<string, string | undefined>>,
): boolean {
	const leftEntries = Object.entries(left)
		.filter((entry): entry is [string, string] => entry[1] !== undefined)
		.sort(([a], [b]) => a.localeCompare(b));
	const rightEntries = Object.entries(right)
		.filter((entry): entry is [string, string] => entry[1] !== undefined)
		.sort(([a], [b]) => a.localeCompare(b));
	if (leftEntries.length !== rightEntries.length) return false;
	for (let i = 0; i < leftEntries.length; i++) {
		const leftEntry = leftEntries[i];
		const rightEntry = rightEntries[i];
		if (!leftEntry || !rightEntry || leftEntry[0] !== rightEntry[0] || leftEntry[1] !== rightEntry[1]) {
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
	#roles = {} as Record<string, RoleAssignment | undefined>;
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
	#isFastForProvider: (provider?: string) => boolean = () => false;
	#isFastForSubagentProvider: (provider?: string) => boolean = () => false;
	#isCurrentModelFastModeActive: () => boolean = () => false;
	#pendingActionItem?: ModelItem | CanonicalModelItem;
	#selectedActionIndex: number = 0;
	#pendingThinkingChoice?: PendingThinkingChoice;
	#selectedThinkingIndex: number = 0;

	// Preset landing state
	#viewMode: ModelSelectorViewMode = "presets";
	#presetCursor: number = 0;
	#expandedPresetProviderId?: string;
	#previewProfileName?: string;
	#presetScopeMenuOpen: boolean = false;
	#presetScopeIndex: number = 0;
	#providerAuthById = new Map<string, boolean>();
	#providerAuthPending: boolean = false;
	#presetLoginHint?: string;
	#authSessionId?: string;

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
			isFastForProvider?: (provider?: string) => boolean;
			isFastForSubagentProvider?: (provider?: string) => boolean;
			isCurrentModelFastModeActive?: () => boolean;
			currentThinkingLevel?: ThinkingLevel;
			activeModelProfile?: string;
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
		this.#currentModel = _currentModel;
		this.#currentThinkingLevel = options?.currentThinkingLevel;
		this.#activeModelProfile = options?.activeModelProfile;
		this.#isFastForProvider = options?.isFastForProvider ?? (() => false);
		this.#isFastForSubagentProvider = options?.isFastForSubagentProvider ?? (() => false);
		// Current-model EFFECTIVE fast state. Defaults to intent for the current
		// model so existing callers/tests keep prior behavior; production wires the
		// session's effective predicate so an auto-disabled provider shows no glyph.
		this.#isCurrentModelFastModeActive =
			options?.isCurrentModelFastModeActive ??
			(() => (this.#currentModel ? this.#isFastForProvider(this.#currentModel.provider) : false));
		const initialSearchInput = options?.initialSearchInput;
		this.#viewMode = this.#temporaryOnly || initialSearchInput || scopedModels.length > 0 ? "models" : "presets";

		// Load current role assignments from settings
		this.#loadRoleModels();

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

		// Load models and do initial render
		this.#loadModels().then(() => {
			this.#buildProviderTabs();
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

	#loadRoleModels(): void {
		const allModels = this.#modelRegistry.getAll();
		const matchPreferences = { usageOrder: this.#settings.getStorage()?.getModelUsageOrder() };
		const agentModelOverrides = this.#settings.get("task.agentModelOverrides");
		for (const role of GJC_MODEL_ASSIGNMENT_TARGET_IDS) {
			const target = GJC_MODEL_ASSIGNMENT_TARGETS[role];
			const roleValue =
				target.settingsPath === "modelRoles" ? this.#settings.getModelRole(role) : agentModelOverrides[role];
			if (!roleValue) continue;

			const resolved = resolveModelRoleValue(roleValue, allModels, {
				settings: this.#settings,
				matchPreferences,
				modelRegistry: this.#modelRegistry,
			});
			if (resolved.model) {
				this.#roles[role] = {
					model: resolved.model,
					thinkingLevel:
						resolved.explicitThinkingLevel && resolved.thinkingLevel !== undefined
							? resolved.thinkingLevel
							: ThinkingLevel.Inherit,
				};
			}
		}
		if (this.#activeModelProfile && this.#currentModel) {
			this.#roles.default = {
				model: this.#currentModel,
				thinkingLevel: this.#currentThinkingLevel ?? ThinkingLevel.Inherit,
			};
		}
	}

	refreshRoleAssignments(
		options: { currentModel?: Model; currentThinkingLevel?: ThinkingLevel; activeModelProfile?: string } = {},
	): void {
		if ("currentModel" in options) this.#currentModel = options.currentModel;
		if ("currentThinkingLevel" in options) this.#currentThinkingLevel = options.currentThinkingLevel;
		if ("activeModelProfile" in options) this.#activeModelProfile = options.activeModelProfile;
		this.#roles = {};
		this.#loadRoleModels();
		this.#applyTabFilter();
	}

	#sortModels(models: ModelItem[]): void {
		// Sort: default-tagged model first, then MRU, then alphabetical
		const mruOrder = this.#settings.getStorage()?.getModelUsageOrder() ?? [];
		const mruIndex = new Map(mruOrder.map((key, i) => [key, i]));

		const modelRank = (item: ModelItem) => computeModelRank(item.model, this.#roles);

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
			const providerCmp = a.provider.localeCompare(b.provider);
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

	#sortCanonicalModels(models: CanonicalModelItem[]): void {
		const mruOrder = this.#settings.getStorage()?.getModelUsageOrder() ?? [];
		const mruIndex = new Map(mruOrder.map((key, i) => [key, i]));

		const modelRank = (item: CanonicalModelItem) => computeModelRank(item.model, this.#roles);

		models.sort((a, b) => {
			const aRank = modelRank(a);
			const bRank = modelRank(b);
			if (aRank !== bRank) return aRank - bRank;

			const aMru = mruIndex.get(`${a.model.provider}/${a.model.id}`) ?? Number.MAX_SAFE_INTEGER;
			const bMru = mruIndex.get(`${b.model.provider}/${b.model.id}`) ?? Number.MAX_SAFE_INTEGER;
			if (aMru !== bMru) return aMru - bMru;

			const providerCmp = a.model.provider.localeCompare(b.model.provider);
			if (providerCmp !== 0) return providerCmp;

			return a.id.localeCompare(b.id);
		});
	}

	async #loadModels(): Promise<void> {
		let models: ModelItem[];

		// Use scoped models if provided via --models flag
		if (this.#scopedModels.length > 0) {
			models = this.#scopedModels.map(scoped => ({
				kind: "provider",
				provider: scoped.model.provider,
				id: scoped.model.id,
				model: scoped.model,
				selector: `${scoped.model.provider}/${scoped.model.id}`,
				thinkingLevel: scoped.thinkingLevel,
				explicitThinkingLevel: scoped.explicitThinkingLevel,
			}));
		} else {
			// Reload config and cached discovery state without blocking on live provider refresh
			await this.#modelRegistry.refresh("offline");

			// Check for models.json errors
			const loadError = this.#modelRegistry.getError();
			if (loadError) {
				this.#errorMessage = loadError;
			} else {
				this.#errorMessage = undefined;
			}

			// Load available models (built-in models still work even if models.json failed)
			try {
				const availableModels = this.#modelRegistry.getAvailable();
				models = availableModels.map((model: Model) => ({
					kind: "provider",
					provider: model.provider,
					id: model.id,
					model,
					selector: `${model.provider}/${model.id}`,
				}));
			} catch (error) {
				this.#allModels = [];
				this.#filteredModels = [];
				this.#canonicalModels = [];
				this.#filteredCanonicalModels = [];
				this.#errorMessage = error instanceof Error ? error.message : String(error);
				return;
			}
		}

		const candidateModels = models.map(item => item.model);
		const canonicalRecords = this.#modelRegistry.getCanonicalModels({
			availableOnly: this.#scopedModels.length === 0,
			candidates: candidateModels,
		});
		const scopedThinkingBySelector = new Map(models.map(item => [item.selector, item.thinkingLevel]));
		const canonicalModels = canonicalRecords
			.map((record): CanonicalModelItem | undefined => {
				const selectedModel = this.#modelRegistry.resolveCanonicalModel(record.id, {
					availableOnly: this.#scopedModels.length === 0,
					candidates: candidateModels,
				});
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

		this.#sortModels(models);
		this.#sortCanonicalModels(canonicalModels);
		this.#allModels = models;
		this.#filteredModels = models;
		this.#canonicalModels = canonicalModels;
		this.#filteredCanonicalModels = canonicalModels;
		this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, models.length - 1));
	}

	#buildProviderTabs(): void {
		const activeTabId = this.#getActiveTab().id;
		const providerSet = new Set<string>();
		for (const item of this.#allModels) {
			providerSet.add(item.provider);
		}
		for (const provider of this.#modelRegistry.getDiscoverableProviders()) {
			providerSet.add(provider);
		}
		const sortedProviderIds = Array.from(providerSet).sort((left, right) =>
			formatProviderTabLabel(left).localeCompare(formatProviderTabLabel(right)),
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
		await this.#modelRegistry.refreshProvider(providerId);
		await this.#loadModels();
		this.#buildProviderTabs();
		this.#updateTabBar();
		this.#applyTabFilter();
		this.#tui.requestRender();
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
		if (activeProviderId) {
			baseModels = this.#allModels.filter(m => m.provider === activeProviderId);
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

	#resolveProfileModelSelector(value: string | undefined): string | undefined {
		const normalized = value?.trim();
		if (isInheritedRoleSelector(normalized)) return undefined;

		const resolved = resolveModelRoleValue(normalized, this.#modelRegistry.getAll(), {
			settings: this.#settings,
			matchPreferences: { usageOrder: this.#settings.getStorage()?.getModelUsageOrder() },
			modelRegistry: this.#modelRegistry,
		});
		if (resolved.model) {
			return formatModelSelectorValue(`${resolved.model.provider}/${resolved.model.id}`, resolved.thinkingLevel);
		}

		const inheritedDefaultThinkingLevel = getDefaultAliasThinkingLevel(normalized);
		if (inheritedDefaultThinkingLevel) return this.#formatCurrentModelSelector(inheritedDefaultThinkingLevel);
		return undefined;
	}

	#buildCustomModelProfileSnapshot(): ModelProfileConfig {
		const modelMapping: ModelProfileConfig["model_mapping"] = {};
		const currentModelSelector = this.#formatCurrentModelSelector();
		if (currentModelSelector) {
			modelMapping.default = currentModelSelector;
		} else {
			const defaultRole = this.#settings.getModelRole("default");
			const defaultSelector = this.#resolveProfileModelSelector(defaultRole);
			if (defaultSelector) modelMapping.default = defaultSelector;
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
				sameStringRecord(profile.modelMapping, snapshot.model_mapping) &&
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

	#getMissingProviders(profileOrProfiles: ModelProfileDefinition | ModelProfileDefinition[]): string[] {
		const profiles = Array.isArray(profileOrProfiles) ? profileOrProfiles : [profileOrProfiles];
		const providers = new Set<string>();
		for (const profile of profiles) for (const provider of profileRequiredProviders(profile)) providers.add(provider);
		return [...providers]
			.filter(provider => this.#isProviderAuthenticated(provider) !== true)
			.sort((a, b) => a.localeCompare(b));
	}

	#isPresetAuthenticated(profileOrProfiles: ModelProfileDefinition | ModelProfileDefinition[]): boolean {
		return this.#getMissingProviders(profileOrProfiles).length === 0;
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
		const providers = new Set<string>();
		for (const profiles of this.#getPresetGroups().values()) {
			for (const profile of profiles)
				for (const provider of profileRequiredProviders(profile)) providers.add(provider);
		}
		this.#providerAuthPending = providers.size > 0;
		this.#renderPresetLanding();
		const entries = await Promise.all(
			[...providers].map(async provider => {
				const apiKey = await this.#modelRegistry.getApiKeyForProvider(provider, this.#authSessionId);
				return [provider, isAuthenticated(apiKey)] as const;
			}),
		);
		this.#providerAuthById = new Map(entries);
		this.#providerAuthPending = false;
		this.#renderPresetLanding();
		this.#tui.requestRender();
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
			selected.kind === "alreadySaved"
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
			selected.kind === "alreadySaved"
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

	#switchToModelMode(seed?: string): void {
		this.#viewMode = "models";
		this.#expandedPresetProviderId = undefined;
		this.#previewProfileName = undefined;
		this.#presetScopeMenuOpen = false;
		this.#presetScopeIndex = 0;
		this.#presetLoginHint = undefined;
		this.#activeTabIndex = 0;
		this.#selectedIndex = 0;
		this.#setSearchInputValue(seed ?? this.#searchInput.getValue());
		this.#updateTabBar();
		this.#filterModels(this.#searchInput.getValue());
	}

	#renderPresetLanding(): void {
		this.#headerContainer.clear();
		this.#tabBar = null;
		this.#listContainer.clear();
		this.#headerContainer.addChild(new Text(theme.fg("accent", "Model presets"), 0, 0));
		const rows = this.#getPresetRows();
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			const selected = i === this.#presetCursor;
			const prefix = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
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
			if (row.kind === "group") {
				const authenticated = this.#isPresetGroupUsable(row.profiles);
				const mark = this.#providerAuthPending ? "…" : authenticated ? "✓" : "✗";
				const label = `${mark} ${row.groupId}`;
				const renderedLabel = selected ? theme.fg("accent", label) : authenticated ? label : theme.fg("dim", label);
				this.#listContainer.addChild(new Text(`${prefix}${renderedLabel}`, 0, 0));
				continue;
			}
			const presentation = getModelProfilePresentation(row.profile);
			const authenticated = this.#isPresetAuthenticated(row.profile);
			const mark = this.#providerAuthPending ? "…" : authenticated ? "✓" : "✗";
			const label = `  ${mark} ${presentation.displayName}`;
			const renderedLabel = selected ? theme.fg("accent", label) : authenticated ? label : theme.fg("dim", label);
			this.#listContainer.addChild(new Text(`${prefix}${renderedLabel}`, 0, 0));
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
			});
			const label = GJC_MODEL_ASSIGNMENT_TARGETS[role].tag ?? role.toUpperCase();
			this.#listContainer.addChild(
				new Text(`  ${label}: ${formatClampedModelSelector(selector, resolved.model)}`, 0, 0),
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
		} else {
			this.#listContainer.addChild(new Text(theme.fg("muted", "  Press Enter to apply this preset"), 0, 0));
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
					const roleFast = isSubagentRole
						? this.#isFastForSubagentProvider(assigned.model.provider)
						: isCurrentRow
							? this.#isCurrentModelFastModeActive()
							: this.#isFastForProvider(assigned.model.provider);
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
			const label = `Set as ${GJC_MODEL_ASSIGNMENT_TARGETS[role].tag ?? role.toUpperCase()} (${GJC_MODEL_ASSIGNMENT_TARGETS[role].name})`;
			this.#listContainer.addChild(
				new Text(`${prefix}${i === this.#selectedActionIndex ? theme.fg("accent", label) : label}`, 0, 0),
			);
		}
	}

	#renderThinkingMenu(choice: PendingThinkingChoice): void {
		const targetLabel = choice.role === null ? "temporary model" : GJC_MODEL_ASSIGNMENT_TARGETS[choice.role].name;
		this.#listContainer.addChild(new Spacer(1));
		this.#listContainer.addChild(
			new Text(theme.fg("muted", `  Reasoning for ${targetLabel}: ${choice.item.model.id}`), 0, 0),
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
		return GJC_MODEL_ASSIGNMENT_TARGET_IDS.length;
	}

	#getSelectedItem(): ModelItem | CanonicalModelItem | undefined {
		return this.#isCanonicalTab()
			? this.#filteredCanonicalModels[this.#selectedIndex]
			: this.#filteredModels[this.#selectedIndex];
	}

	handleInput(keyData: string): void {
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
		if (row.kind === "group") {
			// A group is a list of alternative presets; only surface a login hint
			// when none of its members are usable. A partially-usable group stays
			// navigable so the user can drill in and pick a usable member.
			if (!this.#isPresetGroupUsable(row.profiles)) {
				const missing = this.#getMissingProviders(row.profiles);
				this.#presetLoginHint = `Run ${missing.map(provider => `/login ${provider}`).join(", ")}`;
				this.#renderPresetLanding();
			}
			return;
		}
		const missing = this.#getMissingProviders(row.profile);
		if (missing.length > 0 && !isCustomUserProfile(row.profile)) {
			this.#presetLoginHint = `Run ${missing.map(provider => `/login ${provider}`).join(", ")}`;
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
			if (role) this.#handleSelect(item, role);
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
			this.#handleSelect(choice.item, choice.role, level);
			return;
		}
		if (getKeybindings().matches(keyData, "tui.select.cancel")) {
			this.#pendingThinkingChoice = undefined;
			if (choice.role !== null) {
				this.#pendingActionItem = choice.item;
				this.#selectedActionIndex = Math.max(0, GJC_MODEL_ASSIGNMENT_TARGET_IDS.indexOf(choice.role));
			}
			this.#updateList();
		}
	}

	#handleSelect(
		item: ModelItem | CanonicalModelItem,
		role: GjcModelAssignmentTargetId | null,
		thinkingLevel?: ThinkingLevel,
	): void {
		const itemThinkingLevel = thinkingLevel ?? item.thinkingLevel;
		const hasExplicitThinkingChoice = thinkingLevel !== undefined || item.explicitThinkingLevel === true;
		if (!hasExplicitThinkingChoice && requiresExplicitThinkingChoice(item.model)) {
			this.#pendingThinkingChoice = { item, role, levels: getSelectableThinkingLevels(item.model) };
			this.#selectedThinkingIndex = 0;
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

		const selectedThinkingLevel = itemThinkingLevel ?? this.#getCurrentRoleThinkingLevel(role);
		const selectorValue =
			role === "default" ? item.selector : formatModelSelectorValue(item.selector, selectedThinkingLevel);

		// Update local state for UI
		this.#roles[role] = { model: item.model, thinkingLevel: selectedThinkingLevel };

		// Notify caller (for updating agent state if needed)
		this.#onSelectCallback({
			kind: "assignment",
			model: item.model,
			role,
			thinkingLevel: selectedThinkingLevel,
			selector: selectorValue,
		});

		// Update list to show new badges
		this.#updateList();
	}

	getSearchInput(): Input {
		return this.#searchInput;
	}
	async __testSelectProfile(profileName: string, setDefault: boolean): Promise<void> {
		await this.#onSelectCallback({ kind: "profile", profileName, setDefault });
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
}

function requiresExplicitThinkingChoice(model: Model): boolean {
	return model.reasoning === true && (model.provider === "openai" || model.provider === "openai-codex");
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

import { ThinkingLevel } from "@gajae-code/agent-core";
import { clampThinkingLevelForModel, getSupportedEfforts, type Model, modelsAreEqual } from "@gajae-code/ai";
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
import type { ModelProfileDefinition } from "../../config/model-profiles";
import type { GjcModelAssignmentTargetId, ModelRegistry } from "../../config/model-registry";
import { GJC_MODEL_ASSIGNMENT_TARGET_IDS, GJC_MODEL_ASSIGNMENT_TARGETS } from "../../config/model-registry";
import {
	formatModelSelectorValue,
	resolveModelRoleValue,
	type ScopedModelSelection,
} from "../../config/model-resolver";
import type { Settings } from "../../config/settings";
import { type ThemeColor, theme } from "../../modes/theme/theme";
import { formatModelOnboardingInlineHint } from "../../setup/model-onboarding-guidance";
import { getThinkingLevelMetadata, parseThinkingLevel } from "../../thinking";
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

interface ProfileItem {
	kind: "profile";
	name: string;
	profile: ModelProfileDefinition;
}

type ScopedModelItem = ScopedModelSelection;

interface RoleAssignment {
	model: Model;
	thinkingLevel: ThinkingLevel;
}

export interface ModelAssignmentPreset {
	id: "openai-codex";
	label: string;
	description: string;
	assignments: Partial<Record<GjcModelAssignmentTargetId, ThinkingLevel>>;
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
			kind: "preset";
			model: Model;
			selector: string;
			preset: ModelAssignmentPreset;
			assignments: Record<GjcModelAssignmentTargetId, ThinkingLevel>;
	  }
	| {
			kind: "profile";
			profileName: string;
			setDefault: boolean;
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
const OPENAI_CODE_PROFILE_PRESET: ModelAssignmentPreset = {
	id: "openai-codex",
	label: "Apply OpenAI Codex role preset",
	description: "Default medium, Executor low, Architect xhigh, Planner medium, Critic high",
	assignments: {
		default: ThinkingLevel.Medium,
		executor: ThinkingLevel.Low,
		architect: ThinkingLevel.XHigh,
		planner: ThinkingLevel.Medium,
		critic: ThinkingLevel.High,
	},
};

function formatProviderTabLabel(providerId: string): string {
	return providerId.replace(/[-_]+/g, " ").toUpperCase();
}

function createProviderTab(providerId: string): ProviderTabState {
	return { id: providerId, label: formatProviderTabLabel(providerId), providerId };
}
/**
 * Component that renders a canonical model selector with provider tabs.
 * - Tab/Arrow Left/Right: Switch between provider tabs
 * - Arrow Up/Down: Navigate model list
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
	#profileItems: ProfileItem[] = [];
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
	#pendingActionItem?: ModelItem | CanonicalModelItem;
	#selectedActionIndex: number = 0;
	#pendingThinkingChoice?: PendingThinkingChoice;
	#selectedThinkingIndex: number = 0;

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
		options?: { temporaryOnly?: boolean; initialSearchInput?: string },
	) {
		super();

		this.#tui = tui;
		this.#settings = settings;
		this.#modelRegistry = modelRegistry;
		this.#scopedModels = scopedModels;
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		this.#temporaryOnly = options?.temporaryOnly ?? false;
		const initialSearchInput = options?.initialSearchInput;

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
			this.#searchInput.setValue(initialSearchInput);
		}
		this.#searchInput.onSubmit = () => {
			const selectedItem = this.#getSelectedItem();
			if (selectedItem) {
				if (selectedItem.kind === "profile") {
					this.#beginProfileActionMenu(selectedItem);
				} else {
					this.#beginActionMenuOrSelect(selectedItem);
				}
			}
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
			this.#updateTabBar();
			// Always apply the current search query — the user may have typed
			// while models were loading asynchronously.
			const currentQuery = this.#searchInput.getValue();
			if (currentQuery) {
				this.#filterModels(currentQuery);
			} else {
				this.#updateList();
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
		const profiles = this.#modelRegistry.getModelProfiles?.() ?? new Map();
		const profileItems = this.#temporaryOnly
			? []
			: [...profiles.values()]
					.sort((a, b) => a.name.localeCompare(b.name))
					.map(profile => ({ kind: "profile" as const, name: profile.name, profile }));

		this.#allModels = models;
		this.#filteredModels = models;
		this.#canonicalModels = canonicalModels;
		this.#filteredCanonicalModels = canonicalModels;
		this.#profileItems = profileItems;
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

	#getVisibleProfiles(): ProfileItem[] {
		return !this.#temporaryOnly && !this.#isCanonicalTab() && this.#getActiveTabId() === ALL_TAB
			? this.#profileItems
			: [];
	}

	#updateList(): void {
		this.#listContainer.clear();
		const isCanonicalTab = this.#isCanonicalTab();
		const visibleProfiles = this.#getVisibleProfiles();
		const modelSelectedIndex = Math.max(0, this.#selectedIndex - visibleProfiles.length);
		const visibleItems = isCanonicalTab ? this.#filteredCanonicalModels : this.#filteredModels;

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(modelSelectedIndex - Math.floor(maxVisible / 2), visibleItems.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, visibleItems.length);

		const showProvider = this.#getActiveTabId() === ALL_TAB;

		if (visibleProfiles.length > 0) {
			this.#listContainer.addChild(new Text(theme.fg("muted", "Profiles"), 0, 0));
			for (let i = 0; i < visibleProfiles.length; i++) {
				const profile = visibleProfiles[i];
				if (!profile) continue;
				const isSelected = i === this.#selectedIndex;
				const prefix = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
				const label = isSelected ? theme.fg("accent", profile.name) : profile.name;
				this.#listContainer.addChild(new Text(`${prefix}${label}`, 0, 0));
			}
			this.#listContainer.addChild(new Spacer(1));
		}
		// Show visible slice of filtered models
		for (let i = startIndex; i < endIndex; i++) {
			const item = visibleItems[i];
			if (!item) continue;
			const canonicalItem = isCanonicalTab ? (item as CanonicalModelItem) : undefined;
			const providerItem = isCanonicalTab ? undefined : (item as ModelItem);

			const isSelected = i + visibleProfiles.length === this.#selectedIndex;

			// Build role badges (inverted: color as background, black text)
			const roleBadgeTokens: string[] = [];
			for (const role of GJC_MODEL_ASSIGNMENT_TARGET_IDS) {
				const roleInfo = GJC_MODEL_ASSIGNMENT_TARGETS[role];
				const assigned = this.#roles[role];
				if (roleInfo.tag && assigned && modelsAreEqual(assigned.model, item.model)) {
					const badge = makeInvertedBadge(roleInfo.tag, roleInfo.color ?? "muted");
					const thinkingLabel = getThinkingLevelMetadata(assigned.thinkingLevel).label;
					roleBadgeTokens.push(`${badge} ${theme.fg("dim", `(${thinkingLabel})`)}`);
				}
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
		} else if (visibleItems.length === 0 && visibleProfiles.length === 0) {
			const statusMessage = this.#getProviderEmptyStateMessage();
			this.#listContainer.addChild(
				new Text(
					theme.fg("muted", statusMessage ?? `  No matching models. ${formatModelOnboardingInlineHint()}`),
					0,
					0,
				),
			);
		} else if (this.#selectedIndex < visibleProfiles.length) {
			const selectedProfile = visibleProfiles[this.#selectedIndex];
			if (selectedProfile && this.#pendingActionItem) {
				this.#renderProfileActionMenu(selectedProfile);
			}
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
				? `Set as ${GJC_MODEL_ASSIGNMENT_TARGETS[role].tag ?? role.toUpperCase()} (${GJC_MODEL_ASSIGNMENT_TARGETS[role].name})`
				: `${OPENAI_CODE_PROFILE_PRESET.label} (${OPENAI_CODE_PROFILE_PRESET.description})`;
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

	#renderProfileActionMenu(profile: ProfileItem): void {
		this.#listContainer.addChild(new Spacer(1));
		this.#listContainer.addChild(new Text(theme.fg("muted", `  Action for profile: ${profile.name}`), 0, 0));
		this.#listContainer.addChild(new Spacer(1));
		const labels = ["Apply for this session", "Set as default"];
		for (let i = 0; i < labels.length; i++) {
			const label = labels[i] ?? "";
			const prefix = i === this.#selectedActionIndex ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			this.#listContainer.addChild(
				new Text(`${prefix}${i === this.#selectedActionIndex ? theme.fg("accent", label) : label}`, 0, 0),
			);
		}
	}

	#getCurrentRoleThinkingLevel(role: string): ThinkingLevel {
		return this.#roles[role]?.thinkingLevel ?? ThinkingLevel.Inherit;
	}
	#getActionCount(model: Model): number {
		return GJC_MODEL_ASSIGNMENT_TARGET_IDS.length + (supportsOpenAICodexPreset(model) ? 1 : 0);
	}

	#getSelectedItem(): ModelItem | CanonicalModelItem | ProfileItem | undefined {
		const visibleProfiles = this.#getVisibleProfiles();
		if (this.#selectedIndex < visibleProfiles.length) return visibleProfiles[this.#selectedIndex];
		const modelIndex = this.#selectedIndex - visibleProfiles.length;
		return this.#isCanonicalTab() ? this.#filteredCanonicalModels[modelIndex] : this.#filteredModels[modelIndex];
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

		// Tab bar navigation
		if (this.#tabBar?.handleInput(keyData)) {
			return;
		}

		// Up arrow - navigate list (wrap to bottom when at top)
		if (matchesKey(keyData, "up")) {
			const itemCount =
				this.#getVisibleProfiles().length +
				(this.#isCanonicalTab() ? this.#filteredCanonicalModels.length : this.#filteredModels.length);
			if (itemCount === 0) return;
			this.#selectedIndex = this.#selectedIndex === 0 ? itemCount - 1 : this.#selectedIndex - 1;
			this.#updateList();
			return;
		}

		// Down arrow - navigate list (wrap to top when at bottom)
		if (matchesKey(keyData, "down")) {
			const itemCount =
				this.#getVisibleProfiles().length +
				(this.#isCanonicalTab() ? this.#filteredCanonicalModels.length : this.#filteredModels.length);
			if (itemCount === 0) return;
			this.#selectedIndex = this.#selectedIndex === itemCount - 1 ? 0 : this.#selectedIndex + 1;
			this.#updateList();
			return;
		}

		// Enter opens the persistent assignment menu. Temporary-only mode keeps the
		// existing non-persistent quick-switch behavior.
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selectedItem = this.#getSelectedItem();
			if (selectedItem) {
				if (selectedItem.kind === "profile") {
					this.#beginProfileActionMenu(selectedItem);
				} else {
					this.#beginActionMenuOrSelect(selectedItem);
				}
			}
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
	#beginProfileActionMenu(profile: ProfileItem): void {
		this.#pendingActionItem = profile as unknown as ModelItem;
		this.#selectedActionIndex = 0;
		this.#updateList();
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
		const actionCount = (item as unknown as ProfileItem).kind === "profile" ? 2 : this.#getActionCount(item.model);
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
			if ((item as unknown as ProfileItem).kind === "profile") {
				const profile = item as unknown as ProfileItem;
				this.#onSelectCallback({
					kind: "profile",
					profileName: profile.name,
					setDefault: this.#selectedActionIndex === 1,
				});
			} else {
				const role = GJC_MODEL_ASSIGNMENT_TARGET_IDS[this.#selectedActionIndex];
				if (role) {
					this.#handleSelect(item, role);
				} else {
					this.#handlePresetSelect(item, OPENAI_CODE_PROFILE_PRESET);
				}
			}
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
	#handlePresetSelect(item: ModelItem | CanonicalModelItem, preset: ModelAssignmentPreset): void {
		const selectorValue = item.selector;
		const assignments = resolvePresetAssignments(item.model, preset);
		for (const [role, thinkingLevel] of Object.entries(assignments) as [
			GjcModelAssignmentTargetId,
			ThinkingLevel,
		][]) {
			this.#roles[role] = { model: item.model, thinkingLevel };
		}
		this.#onSelectCallback({ kind: "preset", model: item.model, selector: selectorValue, preset, assignments });
		this.#updateList();
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
}

function requiresExplicitThinkingChoice(model: Model): boolean {
	return model.reasoning === true && (model.provider === "openai" || model.provider === "openai-codex");
}

function supportsOpenAICodexPreset(model: Model): boolean {
	return model.provider === "openai-codex" && model.reasoning === true;
}

function resolvePresetAssignments(
	model: Model,
	preset: ModelAssignmentPreset,
): Record<GjcModelAssignmentTargetId, ThinkingLevel> {
	const resolved = {} as Record<GjcModelAssignmentTargetId, ThinkingLevel>;
	for (const [role, requestedLevel] of Object.entries(preset.assignments) as [
		GjcModelAssignmentTargetId,
		ThinkingLevel,
	][]) {
		const clampedLevel =
			requestedLevel === ThinkingLevel.Off || requestedLevel === ThinkingLevel.Inherit
				? requestedLevel
				: clampThinkingLevelForModel(model, requestedLevel);
		if (!clampedLevel) {
			throw new Error(`Model ${model.provider}/${model.id} does not support ${requestedLevel} reasoning`);
		}
		resolved[role] = clampedLevel;
	}
	return resolved;
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

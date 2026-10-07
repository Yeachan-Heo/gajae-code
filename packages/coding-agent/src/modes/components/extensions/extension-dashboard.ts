/**
 * ExtensionDashboard - Tabbed layout for the Extension Control Center.
 *
 * Layout:
 * - Top: Horizontal tab bar for provider selection
 * - Body: 2-column grid (inventory list | preview panel)
 *
 * Navigation:
 * - TAB/Shift+TAB: Cycle through provider tabs
 * - Up/Down/j/k: Navigate list
 * - Space: Toggle selected item (or master switch)
 * - Esc: Close dashboard (clears search first if active)
 */
import { Container, matchesKey, Spacer, Text } from "@gajae-code/tui";
import { Settings } from "../../../config/settings";
import { DynamicBorder } from "../../../modes/components/dynamic-border";
import { theme } from "../../../modes/theme/theme";
import { matchesAppInterrupt } from "../../../modes/utils/keybinding-matchers";
import { TwoColumnBody } from "../two-column-body";
import { ExtensionList } from "./extension-list";
import { InspectorPanel } from "./inspector-panel";
import {
	applyDisabledExtensionsToState,
	applyFilter,
	createInitialState,
	filterByProvider,
	refreshState,
	toggleProvider,
} from "./state-manager";
import type { DashboardState } from "./types";

export class ExtensionDashboard extends Container {
	#state!: DashboardState;
	#mainList!: ExtensionList;
	#inspector!: InspectorPanel;
	#refreshToken = 0;

	onClose?: () => void;
	onRequestRender?: () => void;

	private constructor(
		private readonly cwd: string,
		private readonly settings: Settings | null,
		private readonly terminalHeight: number,
	) {
		super();
	}

	static async create(
		cwd: string,
		settings: Settings | null = null,
		terminalHeight?: number,
	): Promise<ExtensionDashboard> {
		const dashboard = new ExtensionDashboard(cwd, settings, terminalHeight ?? process.stdout.rows ?? 24);
		await dashboard.#init();
		return dashboard;
	}

	async #init(): Promise<void> {
		const sm = this.settings ?? (await Settings.init());
		const disabledIds = sm ? ((sm.get("disabledExtensions") as string[]) ?? []) : [];
		this.#state = await createInitialState(this.cwd, disabledIds);

		// Calculate max visible items based on terminal height
		// Reserve ~10 lines for header, tabs, help text, borders
		const maxVisible = Math.max(5, Math.floor((this.terminalHeight - 10) / 2));

		// Create main list - always focused
		this.#mainList = new ExtensionList(
			this.#state.searchFiltered,
			{
				onSelectionChange: ext => {
					this.#state.selected = ext;
					this.#inspector.setExtension(ext);
				},
				onToggle: (extensionId, enabled) => {
					this.#handleExtensionToggle(extensionId, enabled);
				},
				onMasterToggle: providerId => {
					this.#handleProviderToggle(providerId);
				},
				masterSwitchProvider: this.#getActiveProviderId(),
			},
			maxVisible,
		);
		this.#mainList.setFocused(true);

		// Create inspector
		this.#inspector = new InspectorPanel();
		if (this.#state.selected) {
			this.#inspector.setExtension(this.#state.selected);
		}

		this.#buildLayout();
	}

	#getActiveProviderId(): string | null {
		const tab = this.#state.tabs[this.#state.activeTabIndex];
		return tab && tab.id !== "all" ? tab.id : null;
	}

	#buildLayout(): void {
		this.clear();

		// Top border
		this.addChild(new DynamicBorder());

		// Title
		this.addChild(new Text(theme.bold(theme.fg("accent", " Extension Control Center")), 0, 0));

		// Tab bar
		this.addChild(new Text(this.#renderTabBar(), 0, 0));
		this.addChild(new Spacer(1));

		// 2-column body with height limit
		// Reserve ~8 lines for header, tabs, help text, borders
		const bodyMaxHeight = Math.max(5, this.terminalHeight - 8);
		this.addChild(new TwoColumnBody(this.#mainList, this.#inspector, bodyMaxHeight));

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", " ↑/↓: navigate  Space: toggle  Tab: next provider  Esc: close"), 0, 0));

		// Bottom border
		this.addChild(new DynamicBorder());
	}

	#renderTabBar(): string {
		const parts: string[] = [" "];

		for (let i = 0; i < this.#state.tabs.length; i++) {
			const tab = this.#state.tabs[i];
			const isActive = i === this.#state.activeTabIndex;
			const isEmpty = tab.count === 0 && tab.id !== "all";
			const isDisabled = !tab.enabled && tab.id !== "all";

			// Build label with count
			let label = tab.label;
			if (tab.count > 0) {
				label += ` (${tab.count})`;
			}

			const displayLabel = isDisabled ? `${theme.status.disabled} ${label}` : label;

			if (isActive) {
				// Active tab: background highlight
				parts.push(theme.bg("selectedBg", ` ${displayLabel} `));
			} else if (isDisabled) {
				// Disabled provider: dim
				parts.push(theme.fg("dim", ` ${displayLabel} `));
			} else if (isEmpty) {
				// Empty enabled provider: very dim, unselectable
				parts.push(theme.fg("dim", ` ${label} `));
			} else {
				// Normal enabled provider
				parts.push(theme.fg("muted", ` ${label} `));
			}
		}

		return parts.join("");
	}

	#handleProviderToggle(providerId: string): void {
		toggleProvider(providerId);
		void this.#refreshFromState();
	}

	#handleExtensionToggle(extensionId: string, enabled: boolean): void {
		const sm = this.settings ?? Settings.instance;
		if (!sm) return;

		const disabled = ((sm.get("disabledExtensions") as string[]) ?? []).slice();
		if (enabled) {
			const index = disabled.indexOf(extensionId);
			if (index !== -1) {
				disabled.splice(index, 1);
				sm.set("disabledExtensions", disabled);
			}
		} else {
			if (!disabled.includes(extensionId)) {
				disabled.push(extensionId);
				sm.set("disabledExtensions", disabled);
			}
		}

		this.#applyDisabledExtensions(disabled);
		void this.#refreshFromState();
	}

	async #refreshFromState(): Promise<void> {
		const refreshToken = ++this.#refreshToken;
		// Remember current tab ID before refresh
		const currentTabId = this.#state.tabs[this.#state.activeTabIndex]?.id;

		const sm = this.settings ?? Settings.instance;
		const disabledIds = sm ? ((sm.get("disabledExtensions") as string[]) ?? []) : [];
		const nextState = await refreshState(this.#state, this.cwd, disabledIds);
		if (refreshToken !== this.#refreshToken) return;
		this.#state = nextState;

		// Find the same tab in the new (re-sorted) list
		if (currentTabId) {
			const newIndex = this.#state.tabs.findIndex(t => t.id === currentTabId);
			if (newIndex >= 0) {
				this.#state.activeTabIndex = newIndex;
			}
		}

		this.#mainList.setExtensions(this.#state.searchFiltered);
		this.#mainList.setMasterSwitchProvider(this.#getActiveProviderId());

		if (this.#state.selected) {
			this.#inspector.setExtension(this.#state.selected);
		}

		this.#buildLayout();
		this.onRequestRender?.();
	}

	#applyDisabledExtensions(disabledIds: string[]): void {
		this.#state = applyDisabledExtensionsToState(this.#state, disabledIds);
		this.#mainList.setExtensions(this.#state.searchFiltered);
		if (this.#state.selected) {
			this.#inspector.setExtension(this.#state.selected);
		}
		this.#buildLayout();
		this.onRequestRender?.();
	}

	#switchTab(direction: 1 | -1): void {
		const numTabs = this.#state.tabs.length;
		if (numTabs === 0) return;

		// Find next selectable tab (skip empty+enabled providers)
		let nextIndex = this.#state.activeTabIndex;
		for (let i = 0; i < numTabs; i++) {
			nextIndex = (nextIndex + direction + numTabs) % numTabs;
			const tab = this.#state.tabs[nextIndex];
			const isEmptyEnabled = tab.count === 0 && tab.enabled && tab.id !== "all";
			if (!isEmptyEnabled) break;
		}
		this.#state.activeTabIndex = nextIndex;

		// Re-filter for new tab
		const tab = this.#state.tabs[this.#state.activeTabIndex];
		this.#state.tabFiltered = filterByProvider(this.#state.extensions, tab.id);
		this.#state.searchFiltered = applyFilter(this.#state.tabFiltered, this.#state.searchQuery);
		this.#state.listIndex = 0;
		this.#state.scrollOffset = 0;
		this.#state.selected = this.#state.searchFiltered[0] ?? null;

		// Update list
		this.#mainList.setExtensions(this.#state.searchFiltered);
		this.#mainList.setMasterSwitchProvider(this.#getActiveProviderId());
		this.#mainList.resetSelection();

		if (this.#state.selected) {
			this.#inspector.setExtension(this.#state.selected);
		}

		this.#buildLayout();
	}

	handleInput(data: string): void {
		// Ctrl+C - close immediately
		if (matchesKey(data, "ctrl+c")) {
			this.onClose?.();
			return;
		}

		// Escape - clear search first, then close
		if (matchesAppInterrupt(data)) {
			if (this.#state.searchQuery.length > 0) {
				this.#state.searchQuery = "";
				this.#state.searchFiltered = this.#state.tabFiltered;
				this.#mainList.setExtensions(this.#state.searchFiltered);
				this.#mainList.clearSearch();
				this.#buildLayout();
				return;
			}
			this.onClose?.();
			return;
		}

		// Tab/Shift+Tab: Cycle through tabs
		if (matchesKey(data, "tab")) {
			this.#switchTab(1);
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			this.#switchTab(-1);
			return;
		}

		// All other input goes to the list
		this.#mainList.handleInput(data);

		// Sync search query back to state
		const query = this.#mainList.getSearchQuery();
		if (query !== this.#state.searchQuery) {
			this.#state.searchQuery = query;
			this.#state.searchFiltered = applyFilter(this.#state.tabFiltered, query);
		}
	}
}

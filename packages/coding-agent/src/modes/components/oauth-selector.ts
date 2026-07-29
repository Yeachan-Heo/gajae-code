import { getOAuthProviders } from "@gajae-code/ai/utils/oauth";
import type { OAuthProviderInfo } from "@gajae-code/ai/utils/oauth/types";
import { Container, fuzzyFilter, Input, matchesKey, Spacer, TruncatedText } from "@gajae-code/tui";
import { recordProviderAuthHealth } from "../../config/provider-auth-health";
import { compareRankedProviders, type ProviderAuthState } from "../../config/provider-ranking";
import { theme } from "../../modes/theme/theme";
import { matchesSelectCancel } from "../../modes/utils/keybinding-matchers";
import type { AuthStorage } from "../../session/auth-storage";
import type { ImportableCredential } from "../../setup/credential-import";
import { DynamicBorder } from "./dynamic-border";

const OAUTH_SELECTOR_MAX_VISIBLE = 10;
/**
 * Component that renders an OAuth provider selector.
 */
export class OAuthSelectorComponent extends Container {
	#listContainer: Container;
	#allProviders: OAuthProviderInfo[] = [];
	#sortedProviders: OAuthProviderInfo[] = [];
	#filteredProviders: OAuthProviderInfo[] = [];
	#searchInput: Input;
	#selectedIndex: number = 0;
	#mode: "login" | "logout";
	#authStorage: AuthStorage;
	#onSelectCallback: (providerId: string) => void;
	#onCancelCallback: () => void;
	#statusMessage: string | undefined;
	#validateAuthCallback?: (providerId: string) => Promise<boolean>;
	#requestRenderCallback?: () => void;
	#authState: Map<string, "checking" | "valid" | "invalid"> = new Map();
	#externalCredentialCandidates: ImportableCredential[] = [];
	#spinnerFrame: number = 0;
	#spinnerInterval?: NodeJS.Timeout;
	#validationGeneration: number = 0;
	constructor(
		mode: "login" | "logout",
		authStorage: AuthStorage,
		onSelect: (providerId: string) => void,
		onCancel: () => void,
		options?: {
			validateAuth?: (providerId: string) => Promise<boolean>;
			requestRender?: () => void;
			externalCredentialCandidates?: ImportableCredential[];
		},
	) {
		super();
		this.#mode = mode;
		this.#authStorage = authStorage;
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		this.#validateAuthCallback = options?.validateAuth;
		this.#requestRenderCallback = options?.requestRender;
		this.#externalCredentialCandidates = options?.externalCredentialCandidates ?? [];
		// Load all OAuth providers
		this.#loadProviders();
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		// Add title
		const title = mode === "login" ? "Select provider to login:" : "Select provider to logout:";
		this.addChild(new TruncatedText(theme.bold(title)));
		this.addChild(new Spacer(1));
		// Filter box: the provider list is long enough that arrow-key-only
		// navigation buries entries below the visible window.
		this.#searchInput = new Input();
		this.#searchInput.onSubmit = () => {
			this.#selectCurrentProvider();
		};
		this.addChild(this.#searchInput);
		this.addChild(new Spacer(1));
		// Create list container
		this.#listContainer = new Container();
		this.addChild(this.#listContainer);
		this.addChild(new Spacer(1));
		// Add bottom border
		this.addChild(new DynamicBorder());
		// Initial render
		this.#updateList();
		this.#startValidation();
	}

	stopValidation(): void {
		this.#validationGeneration += 1;
		this.#stopSpinner();
	}

	dispose(): void {
		this.stopValidation();
		super.dispose();
	}
	#loadProviders(): void {
		this.#allProviders = getOAuthProviders();
	}

	#startValidation(): void {
		if (!this.#validateAuthCallback) return;
		const generation = this.#validationGeneration + 1;
		this.#validationGeneration = generation;

		let pending = 0;
		for (const provider of this.#allProviders) {
			if (!this.#authStorage.hasAuth(provider.id)) {
				this.#authState.delete(provider.id);
				continue;
			}
			this.#authState.set(provider.id, "checking");
			pending += 1;
			void this.#validateProvider(provider.id, generation, this.#authStorage.getGeneration());
		}

		if (pending > 0) {
			this.#startSpinner();
			this.#updateList();
			this.#requestRenderCallback?.();
		}
	}

	async #validateProvider(providerId: string, generation: number, authGeneration: number): Promise<void> {
		if (!this.#validateAuthCallback) return;
		let isValid = false;
		try {
			isValid = await this.#validateAuthCallback(providerId);
		} catch {
			isValid = false;
		}

		if (generation !== this.#validationGeneration) return;
		this.#authState.set(providerId, isValid ? "valid" : "invalid");
		// Only record the ordering hint when the credentials validated are still the
		// current ones; a result from a superseded generation must not describe them.
		if (authGeneration === this.#authStorage.getGeneration()) {
			recordProviderAuthHealth(this.#authStorage, providerId, isValid ? "valid" : "invalid");
		}
		if (![...this.#authState.values()].includes("checking")) {
			this.#stopSpinner();
		}
		this.#updateList();
		this.#requestRenderCallback?.();
	}

	#startSpinner(): void {
		if (this.#spinnerInterval) return;
		this.#spinnerInterval = setInterval(() => {
			const frameCount = theme.spinnerFrames.length;
			if (frameCount > 0) {
				this.#spinnerFrame = (this.#spinnerFrame + 1) % frameCount;
			}
			this.#updateList();
			this.#requestRenderCallback?.();
		}, 80);
	}

	#stopSpinner(): void {
		if (this.#spinnerInterval) {
			clearInterval(this.#spinnerInterval);
			this.#spinnerInterval = undefined;
		}
	}

	#getProviderAuthState(providerId: string): ProviderAuthState {
		return this.#authState.get(providerId) ?? "none";
	}

	#getStatusIndicator(providerId: string): string {
		const state = this.#authState.get(providerId);
		if (state === "checking") {
			const frameCount = theme.spinnerFrames.length;
			const spinner = frameCount > 0 ? theme.spinnerFrames[this.#spinnerFrame % frameCount] : theme.status.pending;
			return theme.fg("warning", ` ${spinner} checking`);
		}
		if (state === "invalid") {
			return theme.fg("error", ` ${theme.status.error} invalid`);
		}
		if (state === "valid") {
			return theme.fg("success", ` ${theme.status.success} logged in`);
		}
		return this.#authStorage.hasAuth(providerId) ? theme.fg("success", ` ${theme.status.success} logged in`) : "";
	}
	#updateList(): void {
		const selectedProviderId = this.#filteredProviders[this.#selectedIndex]?.id;
		const rankedProviders = this.#allProviders.map(provider => ({
			provider,
			id: provider.id,
			label: provider.name,
			authState: this.#getProviderAuthState(provider.id),
		}));
		rankedProviders.sort(compareRankedProviders);
		this.#sortedProviders = rankedProviders.map(({ provider }) => provider);
		// Filter after ranking so an empty query preserves the curated order and a
		// query still surfaces matches in that same order of preference.
		this.#filteredProviders = fuzzyFilter(
			this.#sortedProviders,
			this.#searchInput.getValue(),
			provider => `${provider.name} ${provider.id}`,
		);
		if (selectedProviderId !== undefined) {
			const selectedIndex = this.#filteredProviders.findIndex(provider => provider.id === selectedProviderId);
			if (selectedIndex >= 0) this.#selectedIndex = selectedIndex;
		}
		if (this.#selectedIndex >= this.#filteredProviders.length) {
			this.#selectedIndex = Math.max(0, this.#filteredProviders.length - 1);
		}
		this.#listContainer.clear();

		const total = this.#filteredProviders.length;
		const maxVisible = OAUTH_SELECTOR_MAX_VISIBLE;
		const startIndex =
			total <= maxVisible
				? 0
				: Math.max(0, Math.min(this.#selectedIndex - Math.floor(maxVisible / 2), total - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, total);

		for (let i = startIndex; i < endIndex; i++) {
			const provider = this.#filteredProviders[i];
			if (!provider) continue;
			const isSelected = i === this.#selectedIndex;
			const isAvailable = provider.available;
			const statusIndicator = this.#getStatusIndicator(provider.id);

			let line = "";
			if (isSelected) {
				const prefix = theme.fg("accent", `${theme.nav.cursor} `);
				const text = isAvailable ? theme.fg("accent", provider.name) : theme.fg("dim", provider.name);
				line = prefix + text + statusIndicator;
			} else {
				const text = isAvailable ? `  ${provider.name}` : theme.fg("dim", `  ${provider.name}`);
				line = text + statusIndicator;
			}
			this.#listContainer.addChild(new TruncatedText(line, 0, 0));
		}

		// Scroll indicator when list is windowed
		if (startIndex > 0 || endIndex < total) {
			const scrollInfo = theme.fg("muted", `  (${this.#selectedIndex + 1}/${total})`);
			this.#listContainer.addChild(new TruncatedText(scrollInfo, 0, 0));
		}

		// Show "no providers" if empty
		if (total === 0) {
			const message = this.#searchInput.getValue().trim()
				? "No providers match the filter"
				: this.#mode === "login"
					? "No OAuth providers available"
					: "No OAuth providers logged in. Use /login first.";
			this.#listContainer.addChild(new TruncatedText(theme.fg("muted", `  ${message}`), 0, 0));
		}
		if (this.#statusMessage) {
			this.#listContainer.addChild(new Spacer(1));
			this.#listContainer.addChild(new TruncatedText(theme.fg("warning", `  ${this.#statusMessage}`), 0, 0));
		}
		if (this.#mode === "login" && this.#externalCredentialCandidates.length > 0) {
			this.#listContainer.addChild(new Spacer(1));
			for (const credential of this.#externalCredentialCandidates) {
				this.#listContainer.addChild(
					new TruncatedText(
						theme.fg(
							"success",
							`  ${theme.status.success} Imported ${credential.provider} from ${credential.source}`,
						),
						0,
						0,
					),
				);
			}
		}
	}
	#selectCurrentProvider(): void {
		const selectedProvider = this.#filteredProviders[this.#selectedIndex];
		if (selectedProvider?.available) {
			this.#statusMessage = undefined;
			this.stopValidation();
			this.#onSelectCallback(selectedProvider.id);
		} else if (selectedProvider) {
			this.#statusMessage = "Provider unavailable in this environment.";
			this.#updateList();
		}
	}
	handleInput(keyData: string): void {
		// Up arrow
		if (matchesKey(keyData, "up")) {
			if (this.#filteredProviders.length > 0) {
				this.#selectedIndex =
					this.#selectedIndex === 0 ? this.#filteredProviders.length - 1 : this.#selectedIndex - 1;
			}
			this.#statusMessage = undefined;
			this.#updateList();
			return;
		}
		// Down arrow
		if (matchesKey(keyData, "down")) {
			if (this.#filteredProviders.length > 0) {
				this.#selectedIndex =
					this.#selectedIndex === this.#filteredProviders.length - 1 ? 0 : this.#selectedIndex + 1;
			}
			this.#statusMessage = undefined;
			this.#updateList();
			return;
		}
		// Page up - jump up by one visible page
		if (matchesKey(keyData, "pageUp")) {
			if (this.#filteredProviders.length > 0) {
				this.#selectedIndex = Math.max(0, this.#selectedIndex - OAUTH_SELECTOR_MAX_VISIBLE);
			}
			this.#statusMessage = undefined;
			this.#updateList();
			return;
		}
		// Page down - jump down by one visible page
		if (matchesKey(keyData, "pageDown")) {
			if (this.#filteredProviders.length > 0) {
				this.#selectedIndex = Math.min(
					this.#filteredProviders.length - 1,
					this.#selectedIndex + OAUTH_SELECTOR_MAX_VISIBLE,
				);
			}
			this.#statusMessage = undefined;
			this.#updateList();
			return;
		}
		// Enter
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#selectCurrentProvider();
			return;
		}
		// Escape or Ctrl+C
		if (matchesSelectCancel(keyData)) {
			this.stopValidation();
			this.#onCancelCallback();
			return;
		}
		// Everything else edits the filter. A changed query invalidates the current
		// position, so selection restarts at the best match.
		const previousQuery = this.#searchInput.getValue();
		this.#searchInput.handleInput(keyData);
		if (this.#searchInput.getValue() !== previousQuery) {
			this.#selectedIndex = 0;
			this.#statusMessage = undefined;
			this.#updateList();
		}
	}
}

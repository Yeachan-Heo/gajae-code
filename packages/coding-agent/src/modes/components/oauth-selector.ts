import type { AuthCredentialSelector, CredentialInventoryRecord, CredentialRemovalTarget } from "@gajae-code/ai/core";
import { getEnvApiKey } from "@gajae-code/ai/core";
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
const SAFE_LABEL_MAX_LENGTH = 160;

export interface OAuthSelectorAccountOptions {
	accountProviderId?: string;
	onAccountSelect?: (selector: AuthCredentialSelector) => void | Promise<void>;
	onAutoSelect?: () => void | Promise<void>;
	onAddAccount?: () => void | Promise<void>;
	onAccountRemove?: (targets: readonly CredentialRemovalTarget[]) => void | Promise<void>;
}

type AccountEntry =
	| { kind: "account"; row: CredentialInventoryRecord; target?: CredentialRemovalTarget; selectable: boolean }
	| { kind: "auto"; selectable: true }
	| { kind: "add"; selectable: boolean }
	| { kind: "all"; selectable: boolean };

function safeLabel(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const normalized = value
		.replace(/bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
		.replace(/(api[_-]?key|token|secret|authorization)[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, SAFE_LABEL_MAX_LENGTH);
	return normalized || fallback;
}

/** Component that renders an OAuth provider selector or a provider-scoped account selector. */
export class OAuthSelectorComponent extends Container {
	#listContainer: Container;
	#allProviders: OAuthProviderInfo[] = [];
	#sortedProviders: OAuthProviderInfo[] = [];
	#filteredProviders: OAuthProviderInfo[] = [];
	#accountEntries: AccountEntry[] = [];
	#filteredAccountEntries: AccountEntry[] = [];
	#searchInput: Input;
	#selectedIndex = 0;
	#mode: "login" | "logout";
	#authStorage: AuthStorage;
	#onSelectCallback: (providerId: string) => void;
	#onCancelCallback: () => void;
	#statusMessage: string | undefined;
	#validateAuthCallback?: (providerId: string) => Promise<boolean>;
	#onValidationError?: (error: unknown) => boolean;
	#requestRenderCallback?: () => void;
	#authState: Map<string, "checking" | "valid" | "invalid"> = new Map();
	#externalCredentialCandidates: ImportableCredential[] = [];
	#spinnerFrame = 0;
	#spinnerInterval?: NodeJS.Timeout;
	#validationGeneration = 0;
	#accountProviderId?: string;
	#onAccountSelect?: (selector: AuthCredentialSelector) => void | Promise<void>;
	#onAutoSelect?: () => void | Promise<void>;
	#onAddAccount?: () => void | Promise<void>;
	#onAccountRemove?: (targets: readonly CredentialRemovalTarget[]) => void | Promise<void>;
	#pendingAccountRemovalTargets?: readonly CredentialRemovalTarget[];

	constructor(
		mode: "login" | "logout",
		authStorage: AuthStorage,
		onSelect: (providerId: string) => void,
		onCancel: () => void,
		options?: {
			validateAuth?: (providerId: string) => Promise<boolean>;
			onValidationError?: (error: unknown) => boolean;
			requestRender?: () => void;
			externalCredentialCandidates?: ImportableCredential[];
		} & Partial<OAuthSelectorAccountOptions>,
	) {
		super();
		this.#mode = mode;
		this.#authStorage = authStorage;
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		this.#validateAuthCallback = options?.validateAuth;
		this.#onValidationError = options?.onValidationError;
		this.#requestRenderCallback = options?.requestRender;
		this.#externalCredentialCandidates = options?.externalCredentialCandidates ?? [];
		this.#accountProviderId = options?.accountProviderId;
		this.#onAccountSelect = options?.onAccountSelect;
		this.#onAutoSelect = options?.onAutoSelect;
		this.#onAddAccount = options?.onAddAccount;
		this.#onAccountRemove = options?.onAccountRemove;

		if (this.#accountProviderId) this.#loadAccountEntries();
		else this.#loadProviders();

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		const title = this.#accountProviderId
			? `${mode === "login" ? "Select account to login for" : "Select account to logout from"} ${safeLabel(this.#accountProviderId, "provider")}:`
			: mode === "login"
				? "Select provider to login:"
				: "Select provider to logout:";
		this.addChild(new TruncatedText(theme.bold(title)));
		this.addChild(new Spacer(1));
		this.#searchInput = new Input();
		this.#searchInput.onSubmit = () => this.#selectCurrent();
		this.addChild(this.#searchInput);
		this.addChild(new Spacer(1));
		this.#listContainer = new Container();
		this.addChild(this.#listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
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

	#loadAccountEntries(): void {
		const provider = this.#accountProviderId;
		if (!provider) return;
		const inventory = this.#authStorage
			.listCredentialInventory(provider)
			.filter(row => row.provider === provider)
			.sort((left, right) => left.id - right.id);
		const targets = new Map(
			this.#authStorage.listCredentialRemovalTargets(provider).map(target => [target.id, target]),
		);
		const apiKeyOverrideActive =
			this.#authStorage.hasRuntimeApiKey(provider) ||
			this.#authStorage.hasConfigApiKey(provider) ||
			Boolean(getEnvApiKey(provider));
		const rows = this.#mode === "logout" ? inventory : inventory.filter(row => row.credentialKind === "oauth");
		this.#accountEntries = rows.map(row => ({
			kind: "account" as const,
			row,
			target: targets.get(row.id),
			selectable:
				this.#mode === "login"
					? row.credentialKind === "oauth" && !apiKeyOverrideActive && !row.disabled
					: targets.has(row.id),
		}));
		if (this.#mode === "login") {
			this.#accountEntries.push(
				{ kind: "auto", selectable: true },
				{ kind: "add", selectable: this.#onAddAccount !== undefined },
			);
			const firstAccount = this.#accountEntries.find(entry => entry.kind === "account");
			if (firstAccount && !firstAccount.selectable) {
				const addAccountIndex =
					firstAccount.row.disabled && this.#onAddAccount !== undefined
						? this.#accountEntries.findIndex(entry => entry.kind === "add" && entry.selectable)
						: -1;
				this.#selectedIndex =
					addAccountIndex >= 0 ? addAccountIndex : this.#accountEntries.findIndex(entry => entry.selectable);
			}
		} else if (this.#accountEntries.some(entry => entry.kind === "account" && entry.selectable)) {
			this.#accountEntries.push({ kind: "all", selectable: this.#onAccountRemove !== undefined });
		}
	}

	#startValidation(): void {
		if (this.#accountProviderId || !this.#validateAuthCallback) return;
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
		} catch (error) {
			if (generation !== this.#validationGeneration) return;
			if (this.#onValidationError?.(error)) return;
			isValid = false;
		}
		if (generation !== this.#validationGeneration) return;
		this.#authState.set(providerId, isValid ? "valid" : "invalid");
		if (authGeneration === this.#authStorage.getGeneration()) {
			recordProviderAuthHealth(this.#authStorage, providerId, isValid ? "valid" : "invalid");
		}
		if (![...this.#authState.values()].includes("checking")) this.#stopSpinner();
		this.#updateList();
		this.#requestRenderCallback?.();
	}

	#startSpinner(): void {
		if (this.#spinnerInterval) return;
		this.#spinnerInterval = setInterval(() => {
			const frameCount = theme.spinnerFrames.length;
			if (frameCount > 0) this.#spinnerFrame = (this.#spinnerFrame + 1) % frameCount;
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
		if (state === "invalid") return theme.fg("error", ` ${theme.status.error} invalid`);
		if (state === "valid") return theme.fg("success", ` ${theme.status.success} logged in`);
		return this.#authStorage.hasAuth(providerId) ? theme.fg("success", ` ${theme.status.success} logged in`) : "";
	}

	#accountLabel(entry: AccountEntry): string {
		switch (entry.kind) {
			case "auto":
				return "AUTO (ranked)";
			case "add":
				return "Add new account";
			case "all":
				return "Remove all accounts";
			case "account": {
				const identity =
					entry.row.credentialKind === "oauth"
						? safeLabel(entry.row.identityLabel, `OAuth account · row ${entry.row.id}`)
						: `API key · row ${entry.row.id}`;
				const status = entry.row.disabled
					? `disabled${entry.row.disabledCause ? `: ${safeLabel(entry.row.disabledCause, "disabled")}` : ""}`
					: "active";
				return `${identity} (${status})`;
			}
		}
	}

	#clearPendingAccountRemoval(): boolean {
		if (this.#pendingAccountRemovalTargets === undefined) return false;
		this.#pendingAccountRemovalTargets = undefined;
		this.#statusMessage = undefined;
		return true;
	}

	#getAccountRemovalTargets(): CredentialRemovalTarget[] {
		return this.#accountEntries
			.filter(
				(entry): entry is Extract<AccountEntry, { kind: "account" }> =>
					entry.kind === "account" && entry.selectable && entry.target !== undefined,
			)
			.map(entry => entry.target as CredentialRemovalTarget);
	}

	#confirmOrArmAccountRemoval(targets: readonly CredentialRemovalTarget[], prompt: string): void {
		if (this.#pendingAccountRemovalTargets !== undefined) {
			const pending = this.#pendingAccountRemovalTargets;
			this.#pendingAccountRemovalTargets = undefined;
			this.#statusMessage = undefined;
			void this.#onAccountRemove?.(pending);
			return;
		}
		if (targets.length === 0) {
			this.#statusMessage = "No accounts available to remove.";
		} else {
			this.#pendingAccountRemovalTargets = targets;
			this.#statusMessage = `${prompt} Enter to confirm, Esc to cancel`;
		}
		this.#updateList();
	}
	#updateList(): void {
		if (this.#accountProviderId) {
			this.#updateAccountList();
			return;
		}

		const selectedProviderId = this.#filteredProviders[this.#selectedIndex]?.id;
		const rankedProviders = this.#allProviders.map(provider => ({
			provider,
			id: provider.id,
			label: provider.name,
			authState: this.#getProviderAuthState(provider.id),
		}));
		rankedProviders.sort(compareRankedProviders);
		this.#sortedProviders = rankedProviders.map(({ provider }) => provider);
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
			const prefix = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const text = isAvailable
				? isSelected
					? theme.fg("accent", provider.name)
					: provider.name
				: theme.fg("dim", provider.name);
			this.#listContainer.addChild(new TruncatedText(prefix + text + statusIndicator, 0, 0));
		}
		if (startIndex > 0 || endIndex < total) {
			this.#listContainer.addChild(
				new TruncatedText(theme.fg("muted", `  (${this.#selectedIndex + 1}/${total})`), 0, 0),
			);
		}
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
			this.#listContainer.addChild(
				new TruncatedText(
					theme.fg("warning", `  ${safeLabel(this.#statusMessage, "Unable to select provider")}`),
					0,
					0,
				),
			);
		}
		if (this.#mode === "login" && this.#externalCredentialCandidates.length > 0) {
			this.#listContainer.addChild(new Spacer(1));
			for (const credential of this.#externalCredentialCandidates) {
				this.#listContainer.addChild(
					new TruncatedText(
						theme.fg(
							"success",
							`  ${theme.status.success} Imported ${safeLabel(credential.provider, "provider")} from ${safeLabel(credential.source, "external source")}`,
						),
						0,
						0,
					),
				);
			}
		}
	}

	#updateAccountList(): void {
		const query = this.#searchInput.getValue().trim().toLowerCase();
		this.#filteredAccountEntries = this.#accountEntries.filter(entry =>
			this.#accountLabel(entry).toLowerCase().includes(query),
		);
		if (this.#selectedIndex >= this.#filteredAccountEntries.length) {
			this.#selectedIndex = Math.max(0, this.#filteredAccountEntries.length - 1);
		}
		this.#listContainer.clear();
		const total = this.#filteredAccountEntries.length;
		const maxVisible = OAUTH_SELECTOR_MAX_VISIBLE;
		const startIndex =
			total <= maxVisible
				? 0
				: Math.max(0, Math.min(this.#selectedIndex - Math.floor(maxVisible / 2), total - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, total);
		for (let i = startIndex; i < endIndex; i++) {
			const entry = this.#filteredAccountEntries[i];
			if (!entry) continue;
			const selected = i === this.#selectedIndex;
			const prefix = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const label = this.#accountLabel(entry);
			const disabled = !entry.selectable;
			const text = disabled ? theme.fg("dim", label) : selected ? theme.fg("accent", label) : label;
			this.#listContainer.addChild(new TruncatedText(prefix + text, 0, 0));
		}
		if (startIndex > 0 || endIndex < total) {
			this.#listContainer.addChild(
				new TruncatedText(theme.fg("muted", `  (${this.#selectedIndex + 1}/${total})`), 0, 0),
			);
		}
		if (total === 0) {
			this.#listContainer.addChild(new TruncatedText(theme.fg("muted", "  No accounts available"), 0, 0));
		}
		if (this.#statusMessage) {
			this.#listContainer.addChild(new Spacer(1));
			this.#listContainer.addChild(
				new TruncatedText(
					theme.fg("warning", `  ${safeLabel(this.#statusMessage, "Unable to select account")}`),
					0,
					0,
				),
			);
		}
	}

	#selectCurrent(): void {
		if (this.#accountProviderId) {
			const selected = this.#filteredAccountEntries[this.#selectedIndex];
			if (!selected) return;
			if (!selected.selectable) {
				this.#statusMessage = "This account is not selectable.";
				this.#updateList();
				return;
			}
			this.#statusMessage = undefined;
			this.stopValidation();
			if (selected.kind === "account") {
				if (this.#mode === "login") {
					if (selected.row.credentialKind !== "oauth") return;
					void this.#onAccountSelect?.({ kind: "id", value: String(selected.row.id) });
				} else if (selected.target) {
					this.#confirmOrArmAccountRemoval([selected.target], "Remove this account?");
				}
			} else if (selected.kind === "auto") {
				void this.#onAutoSelect?.();
			} else if (selected.kind === "add") {
				void this.#onAddAccount?.();
			} else if (selected.kind === "all") {
				if (this.#pendingAccountRemovalTargets !== undefined) {
					const targets = this.#pendingAccountRemovalTargets;
					this.#pendingAccountRemovalTargets = undefined;
					void this.#onAccountRemove?.(targets);
				} else {
					const targets = this.#getAccountRemovalTargets();
					this.#confirmOrArmAccountRemoval(targets, `Remove all ${targets.length} accounts?`);
				}
			}
			return;
		}

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
		const isConfirm = matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n";
		const isCancel = matchesSelectCancel(keyData);
		const pendingConfirmationCleared = !isConfirm && !isCancel ? this.#clearPendingAccountRemoval() : false;
		const itemCount = this.#accountProviderId ? this.#filteredAccountEntries.length : this.#filteredProviders.length;
		if (matchesKey(keyData, "up")) {
			this.#clearPendingAccountRemoval();
			if (itemCount > 0) this.#selectedIndex = this.#selectedIndex === 0 ? itemCount - 1 : this.#selectedIndex - 1;
			this.#statusMessage = undefined;
			this.#updateList();
			return;
		}
		if (matchesKey(keyData, "down")) {
			this.#clearPendingAccountRemoval();
			if (itemCount > 0) this.#selectedIndex = this.#selectedIndex === itemCount - 1 ? 0 : this.#selectedIndex + 1;
			this.#statusMessage = undefined;
			this.#updateList();
			return;
		}
		if (matchesKey(keyData, "pageUp")) {
			this.#clearPendingAccountRemoval();
			if (itemCount > 0) this.#selectedIndex = Math.max(0, this.#selectedIndex - OAUTH_SELECTOR_MAX_VISIBLE);
			this.#statusMessage = undefined;
			this.#updateList();
			return;
		}
		if (matchesKey(keyData, "pageDown")) {
			this.#clearPendingAccountRemoval();
			if (itemCount > 0)
				this.#selectedIndex = Math.min(itemCount - 1, this.#selectedIndex + OAUTH_SELECTOR_MAX_VISIBLE);
			this.#statusMessage = undefined;
			this.#updateList();
			return;
		}
		if (isConfirm) {
			this.#selectCurrent();
			return;
		}
		if (isCancel) {
			const pending = this.#clearPendingAccountRemoval();
			this.stopValidation();
			if (pending) this.#updateList();
			this.#onCancelCallback();
			return;
		}
		const previousQuery = this.#searchInput.getValue();
		this.#searchInput.handleInput(keyData);
		if (pendingConfirmationCleared || this.#searchInput.getValue() !== previousQuery) {
			this.#selectedIndex = 0;
			this.#statusMessage = undefined;
			this.#updateList();
		}
	}
}

/**
 * Live context for the Provider Priority Order editor (`modelProviderOrder`).
 *
 * Owns the subscriptions that keep the editor current: `modelProviderOrder`
 * settings changes and credential-generation changes on the session auth
 * storage. Snapshots are built on demand from the model registry catalog, so
 * the editor needs no catalog event subscription.
 */

import type { ModelRegistry } from "../../config/model-registry";
import { getProviderAuthHealth } from "../../config/provider-auth-health";
import type { Settings } from "../../config/settings";
import type { AuthStorage } from "../../session/auth-storage";

/** Normalize a persisted provider id the same way provider selection does: trimmed, lowercased. */
export function normalizeProviderId(raw: string): string {
	return raw.trim().toLowerCase();
}

/** Normalize a persisted provider order the same way provider selection does: trimmed, lowercased, deduplicated, blanks and non-strings dropped. */
export function normalizeProviderOrder(order: readonly unknown[]): string[] {
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const raw of order) {
		if (typeof raw !== "string") continue;
		const id = normalizeProviderId(raw);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		normalized.push(id);
	}
	return normalized;
}

/** Display label for a provider id, mirroring the model selector tab presentation. */
export function formatProviderOrderLabel(providerId: string): string {
	return providerId.replace(/[-_]+/g, " ").toUpperCase();
}

export interface ProviderOrderEntry {
	/** Normalized provider id (trimmed, lowercased). */
	id: string;
	/** Display label for the provider. */
	label: string;
	/** Whether the provider is present in the model registry catalog right now. */
	available: boolean;
	/** Whether the provider has usable auth for this session. */
	authenticated: boolean;
	/** Whether the provider is currently persisted in `modelProviderOrder`. */
	inOrder: boolean;
}

export interface ProviderOrderSnapshot {
	/** Persisted order (normalized, deduplicated). Unavailable entries are retained. */
	order: string[];
	/** Union of registry catalog provider ids and persisted ids. */
	entries: ProviderOrderEntry[];
}

export class ProviderOrderContext {
	#registry: ModelRegistry;
	#settings: Settings;
	#authStorage: AuthStorage;
	#onChange: (() => void) | undefined;
	#credentialSessionId: string | undefined;
	#disposed = false;
	#unsubscribeSettings: () => void;
	#unsubscribeAuthGeneration: () => void;

	constructor(registry: ModelRegistry, settings: Settings, onChange?: () => void, credentialSessionId?: string) {
		this.#registry = registry;
		this.#settings = settings;
		this.#authStorage = registry.authStorage;
		this.#onChange = onChange;
		this.#credentialSessionId = credentialSessionId;
		this.#unsubscribeSettings = settings.onChanged(path => {
			// Only `modelProviderOrder` mutations matter to this editor; the
			// listener takes the single path argument and filters inside.
			if (path !== "modelProviderOrder") return;
			this.#emit();
		});
		this.#unsubscribeAuthGeneration = this.#authStorage.onGenerationChanged(() => this.#emit());
	}

	/** Build the current provider order snapshot from live registry + settings state. */
	snapshot(): ProviderOrderSnapshot {
		const order = this.#readPersistedOrder();
		const catalog = this.#catalogProviders();

		const seen = new Set<string>();
		const union: string[] = [];
		for (const id of order) {
			seen.add(id);
			union.push(id);
		}
		for (const id of catalog.keys()) {
			if (seen.has(id)) continue;
			seen.add(id);
			union.push(id);
		}

		const entries: ProviderOrderEntry[] = union.map(id => ({
			id,
			label: formatProviderOrderLabel(id),
			available: catalog.has(id),
			authenticated: this.#isAuthenticated(catalog.get(id) ?? id),
			inOrder: order.includes(id),
		}));

		return { order, entries };
	}

	/** Persist a new ordered provider list and surface durable write failures. */
	async persistOrder(order: readonly string[]): Promise<void> {
		await this.#persistGlobalOrder(normalizeProviderOrder(order));
	}

	/** Clear the persisted provider order so default resolution applies. */
	async resetOrder(): Promise<void> {
		await this.#persistGlobalOrder(undefined);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribeSettings();
		this.#unsubscribeAuthGeneration();
		this.#onChange = undefined;
	}

	#readPersistedOrder(): string[] {
		const configured = this.#settings.getGlobal("modelProviderOrder");
		return normalizeProviderOrder(Array.isArray(configured) ? configured : []);
	}

	async #persistGlobalOrder(order: readonly string[] | undefined): Promise<void> {
		const previous = this.#settings.getGlobal("modelProviderOrder");
		try {
			if (order === undefined) {
				this.#settings.unset("modelProviderOrder");
			} else {
				this.#settings.set("modelProviderOrder", [...order]);
			}
			await this.#settings.flushOrThrow();
		} catch (error) {
			const rollbackErrors: unknown[] = [];
			try {
				if (previous === undefined) {
					this.#settings.unset("modelProviderOrder");
				} else {
					this.#settings.set("modelProviderOrder", previous);
				}
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
			try {
				await this.#settings.flushOrThrow();
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
			if (rollbackErrors.length > 0) {
				throw new AggregateError(
					[error, ...rollbackErrors],
					"Provider order save failed and rollback was incomplete",
				);
			}
			throw error;
		}
	}

	#catalogProviders(): Map<string, string> {
		const providers = new Map<string, string>();
		for (const model of this.#registry.getAll()) {
			const id = normalizeProviderId(model.provider);
			if (id && !providers.has(id)) providers.set(id, model.provider);
		}
		return providers;
	}

	#isAuthenticated(providerId: string): boolean {
		const effectiveCredentialType = (this.#authStorage as Partial<Pick<AuthStorage, "getEffectiveCredentialType">>)
			.getEffectiveCredentialType;
		const health = getProviderAuthHealth(this.#authStorage, providerId);
		if (!effectiveCredentialType)
			return health ? health === "valid" : this.#registry.hasConfiguredProviderAuth(providerId);
		const credentialType = effectiveCredentialType.call(this.#authStorage, providerId, this.#credentialSessionId);
		return (
			(credentialType !== undefined &&
				health !== "invalid" &&
				(this.#authStorage.hasUsableAuth?.(providerId) ?? true)) ||
			this.#registry.isCredentiallessProvider?.(providerId) === true
		);
	}

	#emit(): void {
		this.#onChange?.();
	}
}

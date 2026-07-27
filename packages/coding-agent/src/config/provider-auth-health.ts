import type { AuthStorage } from "@gajae-code/ai/auth-storage";

/**
 * Most recent OAuth validation outcome per provider, used only as an ordering
 * hint so `/model` can rank a provider whose stored credentials failed
 * validation below one that is healthy, without re-running validation itself.
 *
 * Entries are scoped to the `AuthStorage` that produced them and to its
 * credential generation, so any login, logout, import, or deletion discards the
 * stale result instead of overriding current auth state.
 */
export type ProviderAuthHealth = "valid" | "invalid";

interface HealthEntry {
	generation: number;
	health: ProviderAuthHealth;
}

const healthByStorage = new WeakMap<AuthStorage, Map<string, HealthEntry>>();

export function recordProviderAuthHealth(
	authStorage: AuthStorage,
	providerId: string,
	health: ProviderAuthHealth,
): void {
	let entries = healthByStorage.get(authStorage);
	if (!entries) {
		entries = new Map();
		healthByStorage.set(authStorage, entries);
	}
	entries.set(providerId, { generation: authStorage.getGeneration(), health });
}

export function getProviderAuthHealth(authStorage: AuthStorage, providerId: string): ProviderAuthHealth | undefined {
	const entry = healthByStorage.get(authStorage)?.get(providerId);
	if (!entry || entry.generation !== authStorage.getGeneration()) return undefined;
	return entry.health;
}

export function clearProviderAuthHealth(authStorage: AuthStorage): void {
	healthByStorage.delete(authStorage);
}

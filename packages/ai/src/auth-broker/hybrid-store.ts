/**
 * Broker-backed credential store that keeps logins the broker will not serve on
 * this machine.
 *
 * A broker can accept a login yet never hand it back, e.g. one whose version
 * pauses the provider; the login would vanish on the next snapshot. When an
 * upload comes back unserved, {@link HybridAuthCredentialStore} saves the login
 * in the local SQLite store (`agent.db`) instead and records the provider there,
 * so it keeps resolving locally across restarts. Every other provider goes to
 * the broker.
 *
 * ```ts
 * const store = new HybridAuthCredentialStore({
 * 	broker: remoteStore,
 * 	local: await SqliteAuthCredentialStore.open(getAgentDbPath()),
 * });
 * ```
 */
import { logger } from "@gajae-code/utils";
import type {
	AuthCredential,
	AuthCredentialIfAbsentResult,
	AuthCredentialStore,
	SqliteAuthCredentialStore,
	StoredAuthCredential,
} from "../auth-storage";
import type { RemoteAuthCredentialStore } from "./remote-store";
import { AuthBrokerUnservedProviderError } from "./remote-store";

/** The two stores {@link HybridAuthCredentialStore} splits providers between. */
export interface HybridAuthCredentialStoreOptions {
	broker: RemoteAuthCredentialStore;
	local: SqliteAuthCredentialStore;
}

/**
 * {@link AuthCredentialStore} over a broker store plus the local SQLite store,
 * split by provider. Local providers (those `local` lists in
 * {@link SqliteAuthCredentialStore.listBrokerLocalProviders}) are read, written,
 * refreshed, and blocked in SQLite; the broker's rows for them are hidden. Every
 * other provider goes to the broker exactly as with
 * {@link RemoteAuthCredentialStore}, until an upload for it comes back unserved
 * ({@link AuthBrokerUnservedProviderError}): then the login is saved locally and
 * the provider becomes local. Logging out of a local provider's last login
 * returns it to the broker for the next login.
 *
 * Row ids share one number space: a local row carries its SQLite id negated, so
 * id-only calls (blocks, disables, refresh) route without a provider.
 *
 * Limits for local providers: usage reports come only from the broker, so local
 * providers report no usage.
 */
export class HybridAuthCredentialStore implements AuthCredentialStore {
	readonly #broker: RemoteAuthCredentialStore;
	readonly #local: SqliteAuthCredentialStore;
	#localProviders: Set<string>;

	constructor(opts: HybridAuthCredentialStoreOptions) {
		this.#broker = opts.broker;
		this.#local = opts.local;
		this.#localProviders = new Set(opts.local.listBrokerLocalProviders());
	}

	close(): void {
		this.#broker.close();
		this.#local.close();
	}

	refreshSnapshot(signal?: AbortSignal): Promise<unknown> {
		return this.#broker.refreshSnapshot(signal);
	}

	onSnapshotChanged(listener: () => void): () => void {
		const unsubscribe = this.#broker.onSnapshotChanged?.(listener);
		return unsubscribe ?? (() => {});
	}

	listAuthCredentials(provider?: string): StoredAuthCredential[] {
		if (provider !== undefined) {
			return this.#localProviders.has(provider)
				? this.#local.listAuthCredentials(provider).map(toHybridRow)
				: this.#broker.listAuthCredentials(provider);
		}
		const rows = this.#broker.listAuthCredentials().filter(row => !this.#localProviders.has(row.provider));
		for (const local of this.#localProviders) {
			for (const row of this.#local.listAuthCredentials(local)) rows.push(toHybridRow(row));
		}
		return rows;
	}

	updateAuthCredential(id: number, credential: AuthCredential): void {
		if (isLocalId(id)) this.#local.updateAuthCredential(-id, credential);
		else this.#broker.updateAuthCredential(id, credential);
	}

	deleteAuthCredential(id: number, disabledCause: string): void {
		if (!isLocalId(id)) {
			this.#broker.deleteAuthCredential(id, disabledCause);
		} else {
			const provider = this.#local.listAuthCredentials().find(row => row.id === -id)?.provider;
			this.#local.deleteAuthCredential(-id, disabledCause);
			if (provider !== undefined) this.#returnToBrokerIfEmpty(provider);
		}
	}

	tryDisableAuthCredentialIfMatches(id: number, expectedData: string, disabledCause: string): boolean {
		return isLocalId(id)
			? this.#local.tryDisableAuthCredentialIfMatches(-id, expectedData, disabledCause)
			: this.#broker.tryDisableAuthCredentialIfMatches(id, expectedData, disabledCause);
	}

	replaceAuthCredentialsForProvider(provider: string, credentials: AuthCredential[]): StoredAuthCredential[] {
		if (!this.#localProviders.has(provider))
			return this.#broker.replaceAuthCredentialsForProvider(provider, credentials);
		this.#local.replaceAuthCredentialsForProvider(provider, credentials);
		return this.listAuthCredentials(provider);
	}

	upsertAuthCredentialForProvider(provider: string, credential: AuthCredential): StoredAuthCredential[] {
		if (!this.#localProviders.has(provider)) {
			try {
				return this.#broker.upsertAuthCredentialForProvider(provider, credential);
			} catch (error) {
				if (error instanceof AuthBrokerUnservedProviderError) {
					this.#keepLocal(provider);
					this.#local.upsertAuthCredentialForProvider(provider, credential);
					return this.listAuthCredentials(provider);
				}
				throw error;
			}
		}
		this.#local.upsertAuthCredentialForProvider(provider, credential);
		return this.listAuthCredentials(provider);
	}

	async replaceAuthCredentialsRemote(
		provider: string,
		credentials: AuthCredential[],
	): Promise<StoredAuthCredential[]> {
		if (!this.#localProviders.has(provider)) {
			try {
				return await this.#broker.replaceAuthCredentialsRemote(provider, credentials);
			} catch (error) {
				if (error instanceof AuthBrokerUnservedProviderError) {
					await this.#disableUnservedEntries(error.unservedEntries);
					this.#keepLocal(provider);
					this.#local.replaceAuthCredentialsForProvider(provider, credentials);
					return this.listAuthCredentials(provider);
				}
				throw error;
			}
		}
		this.#local.replaceAuthCredentialsForProvider(provider, credentials);
		return this.listAuthCredentials(provider);
	}

	async upsertAuthCredentialRemote(provider: string, credential: AuthCredential): Promise<StoredAuthCredential[]> {
		if (!this.#localProviders.has(provider)) {
			try {
				return await this.#broker.upsertAuthCredentialRemote(provider, credential);
			} catch (error) {
				if (error instanceof AuthBrokerUnservedProviderError) {
					await this.#disableUnservedEntries(error.unservedEntries);
					this.#keepLocal(provider);
					this.#local.upsertAuthCredentialForProvider(provider, credential);
					return this.listAuthCredentials(provider);
				}
				throw error;
			}
		}
		this.#local.upsertAuthCredentialForProvider(provider, credential);
		return this.listAuthCredentials(provider);
	}

	async deleteAuthCredentialsRemote(provider: string, disabledCause: string): Promise<void> {
		if (!this.#localProviders.has(provider)) {
			await this.#broker.deleteAuthCredentialsRemote(provider, disabledCause);
		} else {
			// For local providers, also try to disable any hidden broker-side credentials
			// that were accepted but never served back (unserved credentials).
			// This prevents them from resurfacing if the broker later serves the provider.
			await this.#disableBrokerCredentialsForProvider(provider, disabledCause);
			this.#local.deleteAuthCredentialsForProvider(provider, disabledCause);
			this.#returnToBrokerIfEmpty(provider);
		}
	}

	upsertAuthCredentialForProviderIfAbsent(provider: string, credential: AuthCredential): AuthCredentialIfAbsentResult {
		if (!this.#localProviders.has(provider)) {
			try {
				return this.#broker.upsertAuthCredentialForProviderIfAbsent(provider, credential);
			} catch (error) {
				if (error instanceof AuthBrokerUnservedProviderError) {
					this.#keepLocal(provider);
					return this.#local.upsertAuthCredentialForProviderIfAbsent(provider, credential);
				}
				throw error;
			}
		}
		return this.#local.upsertAuthCredentialForProviderIfAbsent(provider, credential);
	}

	async upsertAuthCredentialRemoteIfAbsent?(
		provider: string,
		credential: AuthCredential,
	): Promise<AuthCredentialIfAbsentResult> {
		if (!this.#localProviders.has(provider)) {
			try {
				return await this.#broker.upsertAuthCredentialRemoteIfAbsent(provider, credential);
			} catch (error) {
				if (error instanceof AuthBrokerUnservedProviderError) {
					await this.#disableUnservedEntries(error.unservedEntries);
					this.#keepLocal(provider);
					return this.#local.upsertAuthCredentialForProviderIfAbsent(provider, credential);
				}
				throw error;
			}
		}
		return this.#local.upsertAuthCredentialForProviderIfAbsent(provider, credential);
	}

	deleteAuthCredentialsForProvider(provider: string, disabledCause: string): void {
		if (!this.#localProviders.has(provider)) {
			this.#broker.deleteAuthCredentialsForProvider(provider, disabledCause);
		} else {
			this.#local.deleteAuthCredentialsForProvider(provider, disabledCause);
			this.#returnToBrokerIfEmpty(provider);
		}
	}

	getCache(key: string, _options?: { includeExpired?: boolean }): string | null {
		return this.#broker.getCache(key);
	}

	setCache(key: string, value: string, expiresAtSec: number): void {
		this.#broker.setCache(key, value, expiresAtSec);
	}

	deleteCachePrefix(prefix?: string): void {
		if (prefix !== undefined) {
			this.#broker.deleteCachePrefix?.(prefix);
		}
	}

	cleanExpiredCache(): void {
		this.#broker.cleanExpiredCache();
	}

	allocateMonotonicSequence(key: string, expiresAtSec: number): number {
		return this.#broker.allocateMonotonicSequence(key, expiresAtSec);
	}

	// Note: refreshOAuthCredential is intentionally not exposed from HybridAuthCredentialStore.
	// Local credentials can't be refreshed through the broker. Broker credentials that are
	// visible in the snapshot will be refreshed through the local mechanism, which is correct
	// because they're read-only on the client anyway. Credentials that disappear from the
	// snapshot due to unserved transitions are properly handled by the fallback to local storage.

	fetchUsageReports(signal?: AbortSignal): Promise<import("../usage").UsageReport[] | null> {
		return this.#broker.fetchUsageReports?.(signal) ?? Promise.resolve(null);
	}

	prepareForRequest(credentialId: number, opts?: { signal?: AbortSignal }): Promise<boolean | undefined> {
		if (isLocalId(credentialId)) return Promise.resolve(false);
		return this.#broker.prepareForRequest?.(credentialId, opts) ?? Promise.resolve(undefined);
	}

	/** Route `provider` to `agent.db` from now on, in this process and (via the record) every later one. */
	#keepLocal(provider: string): void {
		logger.warn("Auth broker does not serve this provider's logins; keeping them in the local agent.db", {
			provider,
		});
		this.#local.markBrokerLocalProvider(provider);
		this.#localProviders.add(provider);
	}

	/** After a logout, send `provider`'s next login to the broker once no local login is left. */
	#returnToBrokerIfEmpty(provider: string): void {
		if (this.#local.listAuthCredentials(provider).length > 0) return;
		this.#local.unmarkBrokerLocalProvider(provider);
		this.#localProviders.delete(provider);
	}

	/** Disable credentials that were accepted by the broker but not served back (unserved). */
	async #disableUnservedEntries(
		entries: readonly import("../auth-storage").AuthCredentialSnapshotEntry[] | undefined,
	): Promise<void> {
		if (!entries || entries.length === 0) return;
		// Group entries by provider for efficient batch disable
		const entriesByProvider = new Map<string, number[]>();
		for (const entry of entries) {
			const ids = entriesByProvider.get(entry.provider) ?? [];
			ids.push(entry.id);
			entriesByProvider.set(entry.provider, ids);
		}
		// Disable via deleteAuthCredentialsRemote for each provider, which handles the batch disable
		for (const [provider] of entriesByProvider) {
			try {
				await this.#broker.deleteAuthCredentialsRemote(provider, "auth-broker-no-serve");
			} catch (error) {
				// Log but don't throw - the credentials are already not being served
				logger.warn("Failed to disable unserved credentials for provider", {
					provider,
					error: String(error),
				});
			}
		}
	}

	/** Disable any broker-side credentials for a local provider before logging out. */
	async #disableBrokerCredentialsForProvider(provider: string, disabledCause: string): Promise<void> {
		// Try to find and disable any credentials for this provider that may still exist on the broker
		// but are not visible to us (they might be unserved from before).
		if (!this.#broker.deleteAuthCredentialsRemote) return;
		try {
			await this.#broker.deleteAuthCredentialsRemote(provider, disabledCause);
		} catch (error) {
			// Log but don't throw - this is best-effort cleanup
			logger.debug("Failed to disable broker credentials for local provider on logout", {
				provider,
				error: String(error),
			});
		}
	}

	onSnapshotChangedListener?: () => void;
}

/** Local SQLite ids are positive; their hybrid ids are negated. */
function isLocalId(id: number): boolean {
	return id < 0;
}

function toHybridRow<T extends { id: number }>(row: T): T {
	return { ...row, id: -row.id };
}

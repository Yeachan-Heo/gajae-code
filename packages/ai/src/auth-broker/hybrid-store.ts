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
			// For local providers, first try to disable any hidden broker-side credentials
			// that were accepted but never served back (unserved credentials).
			// Keep the provider marked local until this broker cleanup is confirmed,
			// so if revocation fails, we can retry later.
			try {
				await this.#disableBrokerCredentialsForProvider(provider, disabledCause);
			} catch (error) {
				// Log the failure but continue with local deletion.
				// The provider stays marked local so we can retry broker cleanup.
				logger.warn(
					"Failed to disable broker-side credentials for local provider; provider remains marked local for retry",
					{
						provider,
						error: String(error),
					},
				);
				// Don't throw; complete the local deletion and let the provider stay local
			}
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
					const result = this.#local.upsertAuthCredentialForProviderIfAbsent(provider, credential);
					return {
						...result,
						entries: result.entries.map(toHybridRow),
					};
				}
				throw error;
			}
		}
		const result = this.#local.upsertAuthCredentialForProviderIfAbsent(provider, credential);
		return {
			...result,
			entries: result.entries.map(toHybridRow),
		};
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
					const result = this.#local.upsertAuthCredentialForProviderIfAbsent(provider, credential);
					return {
						...result,
						entries: result.entries.map(toHybridRow),
					};
				}
				throw error;
			}
		}
		const result = this.#local.upsertAuthCredentialForProviderIfAbsent(provider, credential);
		return {
			...result,
			entries: result.entries.map(toHybridRow),
		};
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

	listCredentialInventory(provider?: string): import("../auth-storage").CredentialInventoryRecord[] {
		if (provider !== undefined) {
			return this.#localProviders.has(provider)
				? this.#local.listCredentialInventory(provider).map(record => ({
						...record,
						id: -record.id,
					}))
				: this.#broker.listCredentialInventory(provider);
		}
		const records = this.#broker
			.listCredentialInventory()
			.filter(record => !this.#localProviders.has(record.provider));
		for (const local of this.#localProviders) {
			for (const record of this.#local.listCredentialInventory(local)) {
				records.push({ ...record, id: -record.id });
			}
		}
		return records;
	}

	listCredentialRemovalTargets(provider?: string): import("../auth-storage").CredentialRemovalTarget[] {
		// Hard removal only applies to local providers
		if (provider !== undefined) {
			return this.#localProviders.has(provider)
				? this.#local.listCredentialRemovalTargets(provider).map(target => ({
						...target,
						id: -target.id,
					}))
				: [];
		}
		const targets: import("../auth-storage").CredentialRemovalTarget[] = [];
		for (const local of this.#localProviders) {
			for (const target of this.#local.listCredentialRemovalTargets(local)) {
				targets.push({ ...target, id: -target.id });
			}
		}
		return targets;
	}

	removeAuthCredentialsHard(
		provider: string,
		targets: readonly import("../auth-storage").CredentialRemovalTarget[],
	): import("../auth-storage").AuthCredentialHardRemovalResult {
		// Hard removal only applies to local providers; broker rows can only be soft-disabled
		if (!this.#localProviders.has(provider)) {
			// Return conflict for broker providers: they cannot be hard-removed
			return { kind: "conflict", currentIds: targets.map(t => t.id) };
		}
		const localTargets: import("../auth-storage").CredentialRemovalTarget[] = targets.map(target => ({
			...target,
			id: -target.id,
		}));
		const result = this.#local.removeAuthCredentialsHard(provider, localTargets);
		// Translate the result IDs back to the hybrid namespace (negate them)
		if (result.kind === "removed") {
			this.#returnToBrokerIfEmpty(provider);
			return { kind: "removed", ids: result.ids.map(id => -id) };
		} else {
			return { kind: "conflict", currentIds: result.currentIds.map(id => -id) };
		}
	}

	ownsOAuthRefresh(credentialId: number): boolean {
		// Broker rows (positive IDs) are owned by the broker store.
		// Local rows (negative IDs) are owned by the local store.
		return credentialId > 0;
	}

	async refreshOAuthCredential(
		provider: import("../types").Provider,
		credentialId: number,
		credential: import("../auth-storage").OAuthCredential,
		signal?: AbortSignal,
		expectedRevision?: number,
	): Promise<import("../utils/oauth/types").OAuthCredentials> {
		// Route refresh by row ownership: broker rows through the remote hook,
		// local credentials should NOT reach here because ownsOAuthRefresh returns false.
		// This method is only called for broker rows that this store owns.
		if (isLocalId(credentialId)) {
			// Should not reach here if ownsOAuthRefresh works correctly,
			// but as a safety fallback, return the credential unchanged.
			return credential;
		}
		// Broker credentials route through the broker's refresh hook
		return this.#broker.refreshOAuthCredential(provider, credentialId, credential, signal, expectedRevision);
	}

	async refreshMCPOAuthCredential?(
		credentialId: number,
		credential: import("../auth-storage").OAuthCredential,
		client: import("../auth-storage").MCPOAuthRefreshClient,
		signal?: AbortSignal,
	): Promise<import("../auth-storage").OAuthCredential> {
		// Route MCP refresh by row ownership: broker rows through the remote hook,
		// local credentials should NOT reach here because ownsOAuthRefresh returns false.
		// This method is only called for broker rows that this store owns.
		if (isLocalId(credentialId)) {
			// Should not reach here if ownsOAuthRefresh works correctly,
			// but as a safety fallback, return the credential unchanged.
			return credential;
		}
		return this.#broker.refreshMCPOAuthCredential?.(credentialId, credential, client, signal) ?? credential;
	}

	claimOAuthRefreshLease?(
		credentialId: number,
		expectedRefresh: string,
		force: boolean,
		owner: string,
		nowMs: number,
		leaseMs: number,
		expectedRevision?: number,
	): import("../auth-storage").OAuthRefreshLeaseClaim {
		// Lease operations only apply to local credentials; broker handles locking server-side
		if (isLocalId(credentialId)) {
			// Translate hybrid ID (negative) to SQLite ID (positive)
			const claim = this.#local.claimOAuthRefreshLease?.(
				-credentialId,
				expectedRefresh,
				force,
				owner,
				nowMs,
				leaseMs,
				expectedRevision,
			);
			if (claim?.kind === "claimed") {
				// Translate returned lease credentialId back to hybrid form (negate)
				return {
					...claim,
					lease: { ...claim.lease, credentialId: -claim.lease.credentialId },
				};
			}
			return claim ?? { kind: "missing" };
		}
		// Broker credentials do not use local leases; return missing for consistency
		return { kind: "missing" };
	}

	completeOAuthRefreshLease?(
		lease: import("../auth-storage").OAuthRefreshLease,
		credential: import("../auth-storage").OAuthCredential,
	): boolean {
		// Lease operations only apply to local credentials
		if (isLocalId(lease.credentialId)) {
			// Translate hybrid lease credentialId back to SQLite form (positive)
			const sqliteLease = { ...lease, credentialId: -lease.credentialId };
			return this.#local.completeOAuthRefreshLease?.(sqliteLease, credential) ?? false;
		}
		// Broker credentials do not use local leases
		return false;
	}

	releaseOAuthRefreshLease?(lease: import("../auth-storage").OAuthRefreshLease): void {
		// Lease operations only apply to local credentials
		if (isLocalId(lease.credentialId)) {
			// Translate hybrid lease credentialId back to SQLite form (positive)
			const sqliteLease = { ...lease, credentialId: -lease.credentialId };
			this.#local.releaseOAuthRefreshLease?.(sqliteLease);
		}
		// Broker credentials do not use local leases, nothing to release
	}

	async disableAuthCredentialRemote?(
		credentialId: number,
		disabledCause: string,
		signal?: AbortSignal,
		expectedRevision?: number,
	): Promise<boolean> {
		// Route disable by row ownership: broker rows through the remote hook,
		// local credentials are disabled locally.
		if (isLocalId(credentialId)) {
			// Local credentials are disabled in the local store, not through the broker.
			this.#local.deleteAuthCredential(-credentialId, disabledCause);
			return true;
		}
		return this.#broker.disableAuthCredentialRemote?.(credentialId, disabledCause, signal, expectedRevision) ?? false;
	}

	async markCredentialSuspect?(credentialId: number, opts?: { signal?: AbortSignal }): Promise<void> {
		// Route suspect marking by row ownership: broker rows through the remote hook,
		// local credentials remain unchanged (suspect marking is a broker concept).
		if (isLocalId(credentialId)) {
			// Local credentials are not marked suspect through the broker.
			return;
		}
		return this.#broker.markCredentialSuspect?.(credentialId, opts);
	}

	async getUsageReport?(
		provider: import("../types").Provider,
		credential: import("../auth-storage").OAuthCredential,
		signal?: AbortSignal,
	): Promise<import("../usage").UsageReport | null> {
		// Local providers do not have usage reports from the broker.
		// Only broker-served providers have usage data.
		if (this.#localProviders.has(provider)) {
			return null;
		}
		return this.#broker.getUsageReport?.(provider, credential, signal) ?? null;
	}

	fetchUsageReports(signal?: AbortSignal): Promise<import("../usage").UsageReport[] | null> {
		return this.#broker.fetchUsageReports?.(signal) ?? Promise.resolve(null);
	}

	fetchUsageReportsForProvider?(
		provider: import("../types").Provider,
		signal?: AbortSignal,
	): Promise<import("../usage").UsageReport[] | null> {
		// Local providers do not have usage reports from the broker.
		if (this.#localProviders.has(provider)) {
			return Promise.resolve(null);
		}
		return this.#broker.fetchUsageReportsForProvider?.(provider, signal) ?? Promise.resolve(null);
	}

	prepareForRequest(credentialId: number, opts?: { signal?: AbortSignal }): Promise<boolean | undefined> {
		if (isLocalId(credentialId)) return Promise.resolve(false);
		return this.#broker.prepareForRequest?.(credentialId, opts) ?? Promise.resolve(undefined);
	}

	async waitForReady?(): Promise<void> {
		// Ensure broker is ready before reading inventory
		return this.#broker.waitForReady?.();
	}

	tryDisableAuthCredentialIfRevision?(id: number, expectedRevision: number, disabledCause: string): boolean {
		// Revision-based disable only applies to local credentials; broker uses snapshot authority
		if (isLocalId(id)) {
			return this.#local.tryDisableAuthCredentialIfRevision?.(-id, expectedRevision, disabledCause) ?? false;
		}
		// Broker credentials cannot be revision-disabled locally
		return false;
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
		// Extract the specific unserved credential IDs and disable them directly.
		// These IDs were accepted by the broker but are absent from its snapshot,
		// so they would not be caught by snapshot-based deletion.
		const unservedIds = entries.map(entry => entry.id);
		try {
			await this.#broker.disableCredentialsById(unservedIds, "auth-broker-no-serve");
		} catch (error) {
			// Log but do not throw: cleanup is incomplete but the credential is
			// already stored locally, so backing out would leave it in an inconsistent state.
			// The unserved IDs remain active upstream and may resurface if the broker
			// later serves this provider, but local storage protects the credential.
			logger.warn(
				"Failed to disable accepted-but-unserved broker credentials; they may resurface if broker serves this provider",
				{
					count: unservedIds.length,
					error: String(error),
				},
			);
		}
	}

	/** Disable any broker-side credentials for a local provider before logging out. */
	async #disableBrokerCredentialsForProvider(provider: string, disabledCause: string): Promise<void> {
		// Try to find and disable any credentials for this provider that may still exist on the broker
		// but are not visible to us (they might be unserved from before).
		// If this fails, the error propagates and prevents us from deleting local credentials,
		// ensuring the provider stays marked local until revocation succeeds.
		if (!this.#broker.deleteAuthCredentialsRemote) return;
		await this.#broker.deleteAuthCredentialsRemote(provider, disabledCause);
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

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
import { createHash } from "node:crypto";
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
	/** Broker authority hash for tracking pending revocations. */
	brokerAuthority?: string;
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
	readonly #brokerAuthority: string | undefined;
	#localProviders: Set<string>;

	constructor(opts: HybridAuthCredentialStoreOptions) {
		this.#broker = opts.broker;
		this.#local = opts.local;
		// Compute broker authority from the broker client's URL if not provided
		this.#brokerAuthority =
			opts.brokerAuthority ??
			(opts.broker.client ? createHash("sha256").update(opts.broker.client.baseUrl).digest("hex") : undefined);
		// Read authoritative routing from database; this will propagate errors if the database is inaccessible
		this.#localProviders = new Set(opts.local.listBrokerLocalProviders(this.#brokerAuthority));
	}

	/** Re-read authoritative routing from the database rather than using the constructor-time cache. */
	#refreshLocalProviders(): void {
		this.#localProviders = new Set(this.#local.listBrokerLocalProviders(this.#brokerAuthority));
	}

	close(): void {
		this.#broker.close();
		this.#local.close();
	}

	/** Retry all pending revocations for this broker. Must be called after construction. */
	async retryPendingRevocations(): Promise<void> {
		if (!this.#brokerAuthority) return;
		const pending = this.#local.listPendingRevocations(this.#brokerAuthority);
		for (const { provider, brokerCredentialId } of pending) {
			try {
				await this.#broker.disableCredentialsById([brokerCredentialId], "auth-broker-no-serve");
				this.#local.deletePendingRevocation(this.#brokerAuthority, provider, brokerCredentialId);
			} catch (error) {
				// P2-2: Treat broker 404 (confirmed absent) as completed (idempotent),
				// while retrying transport/5xx failures.
				if (error instanceof Error && error.message?.includes("404")) {
					// Credential already disabled on broker side; delete pending record
					this.#local.deletePendingRevocation(this.#brokerAuthority, provider, brokerCredentialId);
				} else {
					logger.warn("Failed to retry pending revocation for broker credential; will retry later", {
						provider,
						brokerCredentialId,
						error: String(error),
					});
				}
			}
		}
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
					// P2-1: Persist local credentials BEFORE attempting broker disable to ensure
					// crash safety. If we disable first and crash before persisting, the credential is lost.
					// By persisting first, we ensure a usable copy survives process crashes.
					this.#keepLocal(provider);
					this.#local.replaceAuthCredentialsForProvider(provider, credentials);
					await this.#disableUnservedEntries(error.unservedEntries, provider);
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
					// P2-1: Persist local credentials BEFORE attempting broker disable to ensure
					// crash safety. If we disable first and crash before persisting, the credential is lost.
					// By persisting first, we ensure a usable copy survives process crashes.
					this.#keepLocal(provider);
					this.#local.upsertAuthCredentialForProvider(provider, credential);
					await this.#disableUnservedEntries(error.unservedEntries, provider);
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
			// If this fails, the error propagates and prevents us from deleting local credentials,
			// ensuring the provider stays marked local until revocation succeeds.
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
					// P2-3: Commit local fallback credential AND ownership marker before disabling broker copy
					this.#keepLocal(provider);
					const result = this.#local.upsertAuthCredentialForProviderIfAbsent(provider, credential);
					await this.#disableUnservedEntries(error.unservedEntries, provider);
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
		// P2-4: Route refresh by row ownership, not method presence.
		// Broker rows (positive IDs) are refreshed via broker hook.
		// Local rows (negative IDs): ownsOAuthRefresh returns false, so this should not be reached.
		// Return unchanged as a defensive fallback.
		if (isLocalId(credentialId)) {
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
		// P2-4: Route MCP refresh by row ownership, not method presence.
		// Broker rows (positive IDs) are refreshed via broker hook.
		// Local rows (negative IDs): ownsOAuthRefresh returns false, so this should not be reached.
		// Return unchanged as a defensive fallback.
		if (isLocalId(credentialId)) {
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
		// P5: Scope fallback routing by broker authority so credentials that fell back under broker A
		// do not get returned in broker B's session sharing the same agent.db.
		if (this.#brokerAuthority) {
			this.#local.markBrokerLocalProvider(this.#brokerAuthority, provider);
			this.#refreshLocalProviders();
		}
	}

	/** After a logout, send `provider`'s next login to the broker once no local login is left. */
	#returnToBrokerIfEmpty(provider: string): void {
		if (!this.#brokerAuthority) return;
		// P3: Check if rows remain and unmark provider atomically in one transaction.
		// This prevents a race where another instance writes a credential after we check
		// but before we delete the marker, leaving fresh instances routing to broker instead of local.
		const stillHasRows = this.#local.unmarkBrokerLocalProviderIfEmpty?.(this.#brokerAuthority, provider);
		if (stillHasRows === false) {
			// Marker was deleted successfully; refresh the cache
			this.#refreshLocalProviders();
		}
	}

	/** Disable credentials that were accepted by the broker but not served back (unserved). */
	async #disableUnservedEntries(
		entries: readonly import("../auth-storage").AuthCredentialSnapshotEntry[] | undefined,
		provider: string,
	): Promise<void> {
		if (!entries || entries.length === 0) return;
		// Extract the specific unserved credential IDs and disable them directly.
		// These IDs were accepted by the broker but are absent from its snapshot,
		// so they would not be caught by snapshot-based deletion.
		const unservedIds = entries.map(entry => entry.id);

		// Write pending revocation records BEFORE attempting disable.
		// This ensures we can retry if the disable fails.
		if (this.#brokerAuthority) {
			for (const id of unservedIds) {
				this.#local.writePendingRevocation(this.#brokerAuthority, provider, id);
			}
		}

		try {
			await this.#broker.disableCredentialsById(unservedIds, "auth-broker-no-serve");
			// Delete pending records on successful disable
			if (this.#brokerAuthority) {
				for (const id of unservedIds) {
					this.#local.deletePendingRevocation(this.#brokerAuthority, provider, id);
				}
			}
		} catch (error) {
			// Failed to disable: pending records remain so they can be retried later.
			// The credential is already stored locally, so backing out would leave it
			// in an inconsistent state.
			logger.warn(
				"Failed to disable accepted-but-unserved broker credentials; pending revocation records will retry at next startup",
				{
					count: unservedIds.length,
					error: String(error),
				},
			);
		}
	}

	/** Disable any broker-side credentials for a local provider before logging out. */
	async #disableBrokerCredentialsForProvider(provider: string, disabledCause: string): Promise<void> {
		// P1-blocking: Check for pending revocations and fail if any exist.
		// This ensures logout doesn't proceed while revocations are still pending.
		if (this.#brokerAuthority) {
			const pending = this.#local.listPendingRevocations(this.#brokerAuthority);
			const pendingForProvider = pending.filter(p => p.provider === provider);
			if (pendingForProvider.length > 0) {
				throw new Error(
					`Cannot logout of ${provider}: ${pendingForProvider.length} pending credential revocation(s) must complete first`,
				);
			}
		}
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

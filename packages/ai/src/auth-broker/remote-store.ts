/**
 * Client-side {@link AuthCredentialStore} that mirrors a remote broker's
 * snapshot. Refresh tokens never leave the broker; mutating methods (`replace*`,
 * `upsert*`, `delete*ForProvider`) throw because login flows are server-side.
 *
 * Cache (`getCache`/`setCache`/`cleanExpiredCache`) is in-memory and ephemeral —
 * usage reports cache TTL is 5 minutes per credential, so durability across
 * runs isn't required.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";

import { getConfigRootDir, isEnoent, logger } from "@gajae-code/utils";
import {
	type AuthCredential,
	type AuthCredentialIfAbsentResult,
	type AuthCredentialStore,
	assertCanonicalMCPOAuthBinding,
	type CachedCredentialHealth,
	type CachedUsagePresentation,
	type CredentialInventoryRecord,
	type MCPOAuthRefreshClient,
	type OAuthCredential,
	REMOTE_REFRESH_SENTINEL,
	type SafeUsageReport,
	type StoredAuthCredential,
} from "../auth-storage";
import type { Provider } from "../types";
import type { UsageReport } from "../usage";
import type { OAuthCredentials } from "../utils/oauth/types";
import {
	type AuthBrokerClient,
	AuthBrokerCredentialMetadataUnsupportedError,
	AuthBrokerStreamUnsupportedError,
} from "./client";
import type {
	CredentialMetadataRecord,
	RefresherSchedule,
	SnapshotEntry,
	SnapshotResponse,
	SnapshotStreamEvent,
} from "./types";

export type CredentialInventoryMetadataCapability = "pending" | "supported" | "unsupported" | "mismatch" | "failed";

export interface CachedInventoryNotice {
	status: Exclude<CredentialInventoryMetadataCapability, "supported">;
	reason: string;
	generation?: number;
}

export interface CredentialInventoryMetadataState {
	capability: CredentialInventoryMetadataCapability;
	generation: number;
	records: readonly CredentialInventoryRecord[];
	notice?: CachedInventoryNotice;
}

/**
 * Client-side TTL for the aggregate `/v1/usage` response. Set below the
 * broker server's own 30s usage cache so we typically pick up the broker's
 * cached value instead of re-walking the network — but high enough to absorb
 * the parallel fan-out from `#rankOAuthSelections` into a single round-trip.
 */
const USAGE_CACHE_TTL_MS = 15_000;
const WAIT_THRESHOLD_MS = 1_000;
const MAX_WAIT_MS = 5_000;
const BACKGROUND_WAIT_MS = 30_000;
const BACKGROUND_BACKOFF_INITIAL_MS = 500;
const BACKGROUND_BACKOFF_MAX_MS = 30_000;

function epochRank(epoch: string): number | undefined {
	const match = /^(\d+)-/.exec(epoch);
	return match ? Number(match[1]) : undefined;
}
const PRESENTATION_FRESH_MS = 5 * 60_000;
const PRESENTATION_RETENTION_MS = 24 * 60 * 60_000;
const PRESENTATION_SIDECAR_VERSION = 1;
/**
 * Default location of the redacted presentation sidecar.
 *
 * Derived when a store is constructed, never at import time: the trusted
 * config root is call-time state (#4761, #4772), so an import-time constant
 * keeps pointing at the home that was in effect when this module first loaded
 * and a process can read and write one logical profile through two different
 * roots (#4786).
 */
function defaultPresentationSidecarPath(): string {
	return path.join(getConfigRootDir(), "auth-broker-presentations.json");
}

function emptySnapshot(): SnapshotResponse {
	return {
		generation: 0,
		generatedAt: 0,
		serverNowMs: 0,
		refresher: {
			enabled: false,
			intervalMs: 0,
			skewMs: 0,
			nextSweepInMs: Number.MAX_SAFE_INTEGER,
		},
		credentials: [],
	};
}

interface CacheEntry {
	value: string;
	expiresAtSec: number;
}

interface UsageCacheEntry {
	reports: UsageReport[];
	fetchedAt: number;
}

interface PersistedPresentation {
	credentialId: number;
	provider: string;
	identityDigest: string;
	health?: {
		v: 1;
		status: "ok" | "failed" | "unverifiable";
		reason: string | null;
		checkedAt?: number;
		retainUntil: number;
	};
	usage?: CachedUsagePresentation;
}

interface PresentationSidecarFile {
	version: 1;
	authorities: Record<string, Record<string, PersistedPresentation>>;
	sourceHealth?: Record<string, Record<string, CacheEntry>>;
}

function presentationRecordKey(provider: string, identityDigest: string): string {
	return `${provider}\u0000${identityDigest}`;
}

function safePresentationReason(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	let reason = value instanceof Error ? value.message : String(value);
	reason = reason.replace(/bearer\s+[^\s,;]+/gi, "Bearer [redacted]");
	reason = reason.replace(/(api[_-]?key|token|secret|authorization)[=:]\s*[^\s,;]+/gi, "$1=[redacted]");
	reason = reason.replace(/[\r\n\t ]+/g, " ").trim();
	return reason.length > 256 ? `${reason.slice(0, 253)}...` : reason || null;
}

export interface RemoteAuthCredentialStoreOptions {
	client: AuthBrokerClient;
	/**
	 * Initial snapshot. When omitted, callers must call
	 * {@link RemoteAuthCredentialStore.refreshSnapshot} before the first read.
	 */
	initialSnapshot?: SnapshotResponse;
	/**
	 * Subscribe to the broker's SSE snapshot stream when available. Falls back
	 * to long-poll permanently when the broker returns 404. Default `true`.
	 */
	streamSnapshots?: boolean;
	/** Override the local redacted presentation sidecar path (primarily for tests). */
	presentationPath?: string;
}

export class RemoteAuthCredentialStore implements AuthCredentialStore {
	readonly #client: AuthBrokerClient;
	readonly #streamSnapshots: boolean;
	#snapshot: SnapshotResponse = emptySnapshot();
	#snapshotReceivedAt = Date.now();
	#generation = 0;
	#epoch?: string;
	#retiredEpochs = new Set<string>();
	#snapshotAuthorityTail: Promise<void> = Promise.resolve();
	#snapshotListeners = new Set<() => void>();
	#backgroundAbort = new AbortController();
	#cache: Map<string, CacheEntry> = new Map();
	#usageCache?: UsageCacheEntry;
	#usageInflight?: Promise<UsageReport[] | null>;
	#scopedUsageCache = new Map<Provider, UsageCacheEntry>();
	#scopedUsageInflight = new Map<Provider, Promise<UsageReport[] | null>>();
	#usageCacheEpoch = 0;
	#inventoryMetadata = new Map<number, CredentialMetadataRecord>();
	#inventoryMetadataGeneration = -1;
	#inventoryState: CredentialInventoryMetadataState = {
		capability: "pending",
		generation: 0,
		records: [],
		notice: { status: "pending", reason: "credential metadata sync pending", generation: 0 },
	};
	#inventorySyncInflight?: Promise<Readonly<CredentialInventoryMetadataState>>;
	#inventoryMetadataUnsupported = false;
	#usagePresentations = new Map<number, CachedUsagePresentation>();
	readonly #presentationPath: string;
	readonly #presentationAuthority: string;
	#persistedPresentations = new Map<string, PersistedPresentation>();
	#sidecarAuthorities: Record<string, Record<string, PersistedPresentation>> = {};
	#persistedSourceHealth: Record<string, Record<string, CacheEntry>> = {};
	#presentationReady: Promise<void>;
	#presentationWriteChain: Promise<void> = Promise.resolve();
	#closed = false;
	/**
	 * `true` once the SSE consumer received its first frame and hasn't dropped
	 * since. Writes consult this to suppress the otherwise-mandatory
	 * `refreshSnapshot()` follow-up — the stream will deliver the new
	 * generation without an extra GET.
	 */
	#streamingActive = false;
	/** Latched once the broker has answered 404 — never try the stream again. */
	#streamingUnsupported = false;

	constructor(opts: RemoteAuthCredentialStoreOptions) {
		this.#client = opts.client;
		this.#streamSnapshots = opts.streamSnapshots ?? true;
		this.#presentationPath = opts.presentationPath ?? defaultPresentationSidecarPath();
		this.#presentationAuthority = createHash("sha256").update(this.#client.baseUrl).digest("hex");
		this.#applySnapshot(opts.initialSnapshot ?? emptySnapshot(), opts.initialSnapshot?.generation ?? 0, false);
		this.#setInventoryState("pending", this.#generation, {
			status: "pending",
			reason: "credential metadata sync pending",
			generation: this.#generation,
		});
		this.#presentationReady = this.#loadPresentationSidecar();
		this.#scheduleInventoryMetadataSync();
		void this.#runBackground();
	}

	get client(): AuthBrokerClient {
		return this.#client;
	}

	/** Wait for redacted presentation hydration and initial inventory metadata. */
	async waitForReady(): Promise<void> {
		await this.#presentationReady;
		await this.syncInventoryMetadata();
	}

	/** Await pending atomic sidecar writes (useful to bounded shutdown callers). */
	async flushPresentationPersistence(): Promise<void> {
		await this.#presentationReady;
		await this.#presentationWriteChain;
	}

	async #loadPresentationSidecar(): Promise<void> {
		let raw: string;
		try {
			const stat = await fs.lstat(this.#presentationPath);
			if (stat.isSymbolicLink() || !stat.isFile()) return;
			raw = await fs.readFile(this.#presentationPath, "utf8");
		} catch (error) {
			if (isEnoent(error)) return;
			logger.debug("auth-broker presentation sidecar unavailable", { error: String(error) });
			return;
		}
		try {
			const parsed = JSON.parse(raw) as Partial<PresentationSidecarFile>;
			if (parsed.version !== PRESENTATION_SIDECAR_VERSION || !parsed.authorities) return;
			this.#sidecarAuthorities = parsed.authorities;
			this.#persistedSourceHealth = parsed.sourceHealth ?? {};
			for (const [key, entry] of Object.entries(this.#persistedSourceHealth[this.#presentationAuthority] ?? {})) {
				if (entry.expiresAtSec * 1000 > Date.now()) this.#cache.set(key, entry);
			}
			const records = this.#sidecarAuthorities[this.#presentationAuthority];
			if (!records || typeof records !== "object") return;
			const now = Date.now();
			for (const [key, candidate] of Object.entries(records)) {
				if (!candidate || typeof candidate !== "object") continue;
				const record = candidate as PersistedPresentation;
				if (!Number.isInteger(record.credentialId) || typeof record.provider !== "string") continue;
				if (record.health && (!Number.isFinite(record.health.retainUntil) || record.health.retainUntil <= now)) {
					delete record.health;
				}
				if (record.usage && (!Number.isFinite(record.usage.retainUntil) || record.usage.retainUntil <= now)) {
					delete record.usage;
				}
				if (!record.health && !record.usage) continue;
				this.#persistedPresentations.set(key, record);
			}
			this.#reconcilePersistedPresentations();
			this.#hydratePresentations();
			this.#queuePresentationWrite();
		} catch (error) {
			logger.debug("auth-broker presentation sidecar invalid", { error: String(error) });
		}
	}

	#hydratePresentations(): void {
		for (const entry of this.#snapshot.credentials) {
			const key = presentationRecordKey(entry.provider, this.#identityDigestForEntry(entry));
			const persisted = this.#persistedPresentations.get(key);
			if (!persisted) continue;
			if (persisted.usage) {
				this.#usagePresentations.set(entry.id, {
					...persisted.usage,
					credentialId: entry.id,
					provider: entry.provider,
					inventoryGeneration: this.#generation,
					identityDigest: this.#identityDigestForEntry(entry),
				});
			}
			if (persisted.health && persisted.health.retainUntil <= Date.now()) delete persisted.health;
		}
	}

	#reconcilePersistedPresentations(): void {
		if (this.#persistedPresentations.size === 0) return;
		let changed = false;
		const current = new Map(
			this.#snapshot.credentials.map(entry => [
				entry.id,
				{ provider: entry.provider, identityDigest: this.#identityDigestForEntry(entry) },
			]),
		);
		for (const [key, record] of this.#persistedPresentations) {
			const identity = current.get(record.credentialId);
			if (
				!identity ||
				identity.provider !== record.provider ||
				key !== presentationRecordKey(identity.provider, identity.identityDigest)
			) {
				this.#persistedPresentations.delete(key);
				changed = true;
			}
		}
		if (changed) this.#queuePresentationWrite();
	}

	#queuePresentationWrite(): void {
		const next = this.#presentationWriteChain
			.catch(() => {})
			.then(async () => {
				const parsed: PresentationSidecarFile = {
					version: 1,
					authorities: {
						...this.#sidecarAuthorities,
						[this.#presentationAuthority]: Object.fromEntries(this.#persistedPresentations),
					},
					sourceHealth: this.#persistedSourceHealth,
				};
				this.#sidecarAuthorities = parsed.authorities;
				const directory = path.dirname(this.#presentationPath);
				await fs.mkdir(directory, { recursive: true, mode: 0o700 });
				const existing = await fs.lstat(this.#presentationPath).catch(error => {
					if (isEnoent(error)) return undefined;
					throw error;
				});
				if (existing?.isSymbolicLink() || (existing && !existing.isFile()))
					throw new Error("Auth-broker presentation sidecar path is unsafe");
				const temporary = `${this.#presentationPath}.${process.pid}.${randomUUID()}.tmp`;
				try {
					try {
						await fs.writeFile(temporary, JSON.stringify(parsed), { flag: "wx", mode: 0o600 });
					} catch (error) {
						if (isEnoent(error)) return;
						throw error;
					}
					await fs.chmod(temporary, 0o600).catch(() => {});
					await fs.rename(temporary, this.#presentationPath).catch(error => {
						if (!isEnoent(error)) throw error;
					});
				} finally {
					await fs.unlink(temporary).catch(() => {});
				}
			});
		this.#presentationWriteChain = next;
	}

	get snapshot(): SnapshotResponse {
		return this.#snapshot;
	}

	getInventoryMetadataState(): Readonly<CredentialInventoryMetadataState> {
		const records = this.#buildInventoryRecords().map(record => ({ ...record }));
		const notice = this.#inventoryState.notice ? { ...this.#inventoryState.notice } : undefined;
		return {
			capability: this.#inventoryState.capability,
			generation: this.#inventoryState.generation,
			records,
			...(notice ? { notice } : {}),
		};
	}

	#applySnapshot(snapshot: SnapshotResponse, generation: number, scheduleMetadata = true): boolean {
		// Broker generations are process-local and reset when the broker restarts.
		// A lower generation from a newer server timestamp is therefore a new
		// broker epoch, while an older timestamp is an out-of-order response from
		// the current epoch and must be discarded.
		if (this.#epoch) {
			if (!snapshot.epoch) return false;
			if (snapshot.epoch === this.#epoch) {
				if (generation < this.#generation) return false;
				if (generation === this.#generation && snapshot.serverNowMs < this.#snapshot.serverNowMs) return false;
			} else {
				if (this.#retiredEpochs.has(snapshot.epoch)) return false;
				const currentRank = epochRank(this.#epoch);
				const incomingRank = epochRank(snapshot.epoch);
				if (currentRank !== undefined && incomingRank === undefined) return false;
				if (currentRank !== undefined && incomingRank !== undefined && incomingRank <= currentRank) return false;
				this.#retiredEpochs.add(this.#epoch);
			}
		} else if (snapshot.epoch) {
			// First epoch-bearing response establishes the authority namespace.
		} else if (
			(generation < this.#generation && snapshot.serverNowMs <= this.#snapshot.serverNowMs) ||
			(generation === this.#generation && snapshot.serverNowMs < this.#snapshot.serverNowMs)
		) {
			// Epoch-less legacy brokers use serverNowMs as the restart discriminator:
			// accept a reset generation only when the broker proves it is newer than
			// the last accepted legacy snapshot, while delayed old responses fail closed.
			if (
				(generation < this.#generation && snapshot.serverNowMs <= this.#snapshot.serverNowMs) ||
				(generation === this.#generation && snapshot.serverNowMs < this.#snapshot.serverNowMs)
			)
				return false;
		}
		const generationChanged =
			generation !== this.#generation ||
			snapshot.epoch !== this.#epoch ||
			this.#inventoryMetadataGeneration !== generation;
		this.#snapshot = snapshot;
		this.#generation = generation;
		this.#epoch = snapshot.epoch ?? this.#epoch;
		this.#snapshotReceivedAt = Date.now();
		if (generationChanged) {
			this.#inventoryMetadata.clear();
			this.#inventoryMetadataGeneration = -1;
			this.#invalidateUsageCache();
			this.#reconcileUsagePresentations();
			if (this.#inventoryMetadataUnsupported) {
				this.#setInventoryState("unsupported", generation, {
					status: "unsupported",
					reason: "credential metadata endpoint unsupported; disabled rows unavailable",
					generation,
				});
			} else {
				this.#setInventoryState("pending", generation, {
					status: "pending",
					reason: "credential metadata sync pending",
					generation,
				});
				if (scheduleMetadata) this.#scheduleInventoryMetadataSync();
			}
		}
		this.#reconcilePersistedPresentations();
		this.#hydratePresentations();
		for (const listener of this.#snapshotListeners) listener();
		return true;
	}

	onSnapshotChanged(listener: () => void): () => void {
		this.#snapshotListeners.add(listener);
		return () => this.#snapshotListeners.delete(listener);
	}

	#withSnapshotAuthority<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.#snapshotAuthorityTail.then(operation);
		this.#snapshotAuthorityTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	#setInventoryState(
		capability: CredentialInventoryMetadataCapability,
		generation: number,
		notice?: CachedInventoryNotice,
	): void {
		const records = this.#buildInventoryRecords();
		this.#inventoryState = {
			capability,
			generation,
			records,
			...(notice ? { notice } : {}),
		};
	}

	#buildInventoryRecords(): CredentialInventoryRecord[] {
		const metadataReady = this.#inventoryMetadataGeneration === this.#generation;
		const records: CredentialInventoryRecord[] = [];
		const seen = new Set<number>();
		for (const entry of this.#snapshot.credentials) {
			const metadata = metadataReady ? this.#inventoryMetadata.get(entry.id) : undefined;
			seen.add(entry.id);
			records.push({
				id: entry.id,
				provider: entry.provider,
				credentialKind: metadata?.type ?? entry.credential.type,
				identityLabel: metadata?.identity ?? snapshotIdentityLabel(entry),
				disabled: false,
				disabledCause: null,
			});
		}
		if (metadataReady) {
			for (const metadata of this.#inventoryMetadata.values()) {
				if (seen.has(metadata.id) || metadata.disabledCause === null) continue;
				records.push({
					id: metadata.id,
					provider: metadata.provider,
					credentialKind: metadata.type,
					identityLabel: metadata.identity,
					disabled: true,
					disabledCause: metadata.disabledCause,
				});
			}
		}
		return records;
	}

	#scheduleInventoryMetadataSync(): void {
		if (this.#closed || this.#inventoryMetadataUnsupported) return;
		if (this.#inventorySyncInflight) return;
		void this.syncInventoryMetadata().catch(() => {});
	}

	async syncInventoryMetadata(): Promise<Readonly<CredentialInventoryMetadataState>> {
		if (this.#inventoryMetadataUnsupported) return this.getInventoryMetadataState();
		if (this.#inventoryState.capability === "supported" && this.#inventoryMetadataGeneration === this.#generation) {
			return this.getInventoryMetadataState();
		}
		if (this.#inventorySyncInflight) return this.#inventorySyncInflight;
		const inflight = this.#syncInventoryMetadata().finally(() => {
			this.#inventorySyncInflight = undefined;
		});
		this.#inventorySyncInflight = inflight;
		return inflight;
	}

	async #syncInventoryMetadata(): Promise<Readonly<CredentialInventoryMetadataState>> {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				const metadata = await this.#client.fetchCredentialMetadata();
				if (metadata.epoch !== this.#epoch) {
					if (attempt === 0) {
						await this.refreshSnapshot().catch(() => {});
						continue;
					}
					this.#inventoryMetadata.clear();
					this.#inventoryMetadataGeneration = -1;
					this.#setInventoryState("mismatch", this.#generation, {
						status: "mismatch",
						reason: "credential metadata epoch mismatch",
						generation: this.#generation,
					});
					return this.getInventoryMetadataState();
				}
				if (metadata.generation !== this.#generation) {
					if (attempt === 0) {
						await this.refreshSnapshot().catch(() => {});
						continue;
					}
					this.#inventoryMetadata.clear();
					this.#inventoryMetadataGeneration = -1;
					this.#setInventoryState("mismatch", this.#generation, {
						status: "mismatch",
						reason: "credential metadata generation mismatch",
						generation: this.#generation,
					});
					return this.getInventoryMetadataState();
				}
				this.#inventoryMetadata = new Map(metadata.credentials.map(record => [record.id, { ...record }]));
				this.#inventoryMetadataGeneration = metadata.generation;
				this.#setInventoryState("supported", metadata.generation);
				this.#reconcileUsagePresentations();
				return this.getInventoryMetadataState();
			} catch (error) {
				if (error instanceof AuthBrokerCredentialMetadataUnsupportedError || isErrorStatus(error, 404)) {
					this.#inventoryMetadataUnsupported = true;
					this.#inventoryMetadata.clear();
					this.#inventoryMetadataGeneration = -1;
					this.#setInventoryState("unsupported", this.#generation, {
						status: "unsupported",
						reason: "credential metadata endpoint unsupported; disabled rows unavailable",
						generation: this.#generation,
					});
					return this.getInventoryMetadataState();
				}
				this.#setInventoryState("failed", this.#generation, {
					status: "failed",
					reason: "credential metadata sync failed; retry explicitly",
					generation: this.#generation,
				});
				return this.getInventoryMetadataState();
			}
		}
		this.#setInventoryState("mismatch", this.#generation, {
			status: "mismatch",
			reason: "credential metadata generation mismatch",
			generation: this.#generation,
		});
		return this.getInventoryMetadataState();
	}

	async #runBackground(): Promise<void> {
		let backoffMs = BACKGROUND_BACKOFF_INITIAL_MS;
		while (!this.#closed && !this.#backgroundAbort.signal.aborted) {
			if (this.#streamSnapshots && !this.#streamingUnsupported) {
				try {
					await this.#consumeSnapshotStream();
					backoffMs = BACKGROUND_BACKOFF_INITIAL_MS;
					continue;
				} catch (error) {
					if (this.#closed || this.#backgroundAbort.signal.aborted) break;
					if (error instanceof AuthBrokerStreamUnsupportedError) {
						this.#streamingUnsupported = true;
						logger.debug("auth-broker snapshot stream unsupported; falling back to long-poll");
						continue;
					}
					logger.debug("auth-broker snapshot stream failed; backing off", { error: String(error) });
					await scheduler.wait(backoffMs, { signal: this.#backgroundAbort.signal }).catch(() => {});
					backoffMs = Math.min(BACKGROUND_BACKOFF_MAX_MS, backoffMs * 2);
					continue;
				}
			}
			try {
				const result = await this.#client.fetchSnapshot({
					ifGenerationGt: this.#generation,
					ifEpoch: this.#epoch,
					waitMs: BACKGROUND_WAIT_MS,
					signal: this.#backgroundAbort.signal,
				});
				if (result.status === 200) {
					await this.#withSnapshotAuthority(async () => {
						if (!this.#applySnapshot(result.snapshot, result.generation)) {
							throw new Error("Auth broker background snapshot authority was rejected");
						}
					});
				}
				backoffMs = BACKGROUND_BACKOFF_INITIAL_MS;
			} catch (error) {
				if (this.#closed || this.#backgroundAbort.signal.aborted) break;
				logger.debug("auth-broker background snapshot sync failed", { error: String(error) });
				await scheduler.wait(backoffMs, { signal: this.#backgroundAbort.signal }).catch(() => {});
				backoffMs = Math.min(BACKGROUND_BACKOFF_MAX_MS, backoffMs * 2);
			}
		}
	}

	async #consumeSnapshotStream(): Promise<void> {
		const iterator = this.#client.openSnapshotStream({ signal: this.#backgroundAbort.signal });
		try {
			for await (const event of iterator) {
				if (this.#closed || this.#backgroundAbort.signal.aborted) break;
				this.#streamingActive = true;
				await this.#applyStreamEvent(event);
			}
		} finally {
			this.#streamingActive = false;
		}
	}

	async #applyStreamEvent(event: SnapshotStreamEvent): Promise<void> {
		await this.#withSnapshotAuthority(async () => {
			switch (event.kind) {
				case "snapshot": {
					// Strip the discriminator so we store the wire-shape SnapshotResponse.
					const { kind: _kind, ...snapshot } = event;
					if (!this.#applySnapshot(snapshot, snapshot.generation)) {
						throw new Error("Auth broker stream snapshot authority was rejected");
					}
					return;
				}
				case "entry": {
					const applied = this.#applyStreamEntry(
						event.entry,
						event.refresher,
						event.generation,
						event.serverNowMs,
						event.epoch,
					);
					if (!applied) {
						throw new Error("Auth broker stream entry authority was rejected");
					}
					return;
				}
				case "removed": {
					const applied = this.#removeStreamCredential(
						event.id,
						event.refresher,
						event.generation,
						event.serverNowMs,
						event.epoch,
					);
					if (!applied) {
						throw new Error("Auth broker stream removal authority was rejected");
					}
					return;
				}
			}
		});
	}

	#applyStreamEntry(
		entry: SnapshotEntry,
		refresher: RefresherSchedule,
		generation: number,
		serverNowMs: number,
		epoch?: string,
	): boolean {
		if (!epoch && this.#epoch && epochRank(this.#epoch) !== undefined) return false;
		const index = this.#snapshot.credentials.findIndex(candidate => candidate.id === entry.id);
		const credentials =
			index === -1
				? [...this.#snapshot.credentials, entry]
				: this.#snapshot.credentials.map((candidate, i) => (i === index ? entry : candidate));
		return this.#applySnapshot(
			{ ...this.#snapshot, epoch, generation, serverNowMs, refresher, credentials },
			generation,
		);
	}

	#removeStreamCredential(
		id: number,
		refresher: RefresherSchedule,
		generation: number,
		serverNowMs: number,
		epoch?: string,
	): boolean {
		if (!epoch && this.#epoch && epochRank(this.#epoch) !== undefined) return false;
		const credentials = this.#snapshot.credentials.filter(entry => entry.id !== id);
		return this.#applySnapshot(
			{ ...this.#snapshot, epoch, generation, serverNowMs, refresher, credentials },
			generation,
		);
	}

	/**
	 * Payload-free inventory view. This method never performs network I/O; metadata
	 * rows appear only after an explicit or background metadata synchronization for
	 * the current snapshot generation.
	 */
	listCredentialInventory(provider?: string): CredentialInventoryRecord[] {
		return this.#buildInventoryRecords()
			.filter(record => provider === undefined || record.provider === provider)
			.map(record => ({ ...record }));
	}

	/** Re-hydrate the in-memory snapshot from the broker. */
	async refreshSnapshot(): Promise<SnapshotResponse> {
		const result = await this.#client.fetchSnapshot();
		if (result.status === 200) {
			await this.#withSnapshotAuthority(async () => {
				if (!this.#applySnapshot(result.snapshot, result.generation)) {
					throw new Error("Auth broker snapshot authority was rejected");
				}
			});
		}
		return this.#snapshot;
	}

	listAuthCredentials(provider?: string): StoredAuthCredential[] {
		const out: StoredAuthCredential[] = [];
		for (const entry of this.#snapshot.credentials) {
			if (provider !== undefined && entry.provider !== provider) continue;
			out.push({
				id: entry.id,
				provider: entry.provider,
				credential: entry.credential as AuthCredential,
				disabledCause: null,
			});
		}
		return out;
	}

	/**
	 * In-memory update from a successful refresh through the broker. AuthStorage
	 * calls this after `#replaceCredentialAt`; the broker already persisted the
	 * authoritative row, so we just mirror it.
	 */
	updateAuthCredential(id: number, credential: AuthCredential): void {
		void id;
		void credential;
		throw new Error("Remote auth-broker credentials must be updated through broker authority");
	}

	deleteAuthCredential(_id: number, _disabledCause: string): void {
		throw new Error("Remote auth-broker credentials can only be disabled on the broker host");
	}

	allocateMonotonicSequence(_key: string, _expiresAtSec: number): number {
		throw new Error("Remote auth-broker credentials cannot allocate broker incarnation sequences");
	}

	tryDisableAuthCredentialIfMatches(_id: number, _expectedData: string, _disabledCause: string): boolean {
		return false;
	}

	async waitForFreshSnapshot(maxWaitMs: number, opts: { signal?: AbortSignal } = {}): Promise<boolean> {
		const previousGeneration = this.#generation;
		const previousEpoch = this.#epoch;
		const result = await this.#client.fetchSnapshot({
			ifGenerationGt: this.#generation,
			ifEpoch: this.#epoch,
			waitMs: maxWaitMs,
			signal: opts.signal,
		});
		if (result.status === 200) {
			await this.#withSnapshotAuthority(async () => {
				if (!this.#applySnapshot(result.snapshot, result.generation)) {
					throw new Error("Auth broker freshness snapshot authority was rejected");
				}
			});
		}
		return this.#generation !== previousGeneration || this.#epoch !== previousEpoch;
	}

	async prepareForRequest(credentialId: number, opts: { signal?: AbortSignal } = {}): Promise<boolean> {
		const entry = this.#snapshot.credentials.find(candidate => candidate.id === credentialId);
		if (entry?.credential.type !== "oauth" || entry.rotatesInMs === null) return false;
		const remainingMs = this.#snapshotReceivedAt + entry.rotatesInMs - Date.now();
		if (remainingMs > WAIT_THRESHOLD_MS) return false;
		return this.waitForFreshSnapshot(MAX_WAIT_MS, opts);
	}

	async markCredentialSuspect(credentialId: number, opts: { signal?: AbortSignal } = {}): Promise<void> {
		await this.#client.refreshCredential(credentialId, opts.signal);
		await this.refreshSnapshot();
	}

	replaceAuthCredentialsForProvider(_provider: string, _credentials: AuthCredential[]): StoredAuthCredential[] {
		throw new Error(
			"RemoteAuthCredentialStore is read-only on the client. Use `gjc auth-broker login <provider>` to mutate credentials.",
		);
	}

	upsertAuthCredentialForProvider(_provider: string, _credential: AuthCredential): StoredAuthCredential[] {
		throw new Error(
			"RemoteAuthCredentialStore is read-only on the client. Use `gjc auth-broker login <provider>` to mutate credentials.",
		);
	}

	upsertAuthCredentialForProviderIfAbsent(
		_provider: string,
		_credential: AuthCredential,
	): AuthCredentialIfAbsentResult {
		throw new Error(
			"RemoteAuthCredentialStore is read-only on the client. Use `gjc auth-broker login <provider>` to mutate credentials.",
		);
	}

	deleteAuthCredentialsForProvider(_provider: string, _disabledCause: string): void {
		throw new Error(
			"RemoteAuthCredentialStore is read-only on the client. Use `gjc auth-broker logout <provider>` to mutate credentials.",
		);
	}

	/** Logout authority remains on the broker; the client only mirrors its result. */
	async deleteAuthCredentialsRemote(provider: string, disabledCause: string): Promise<void> {
		const existing = this.listAuthCredentials(provider);
		for (const entry of existing) await this.#client.disableCredential(entry.id, disabledCause);
		await this.refreshSnapshot();
	}

	/**
	 * Upsert a single credential through the broker. The broker server is the
	 * canonical writer — see `POST /v1/credential`. The redacted snapshot
	 * entries returned by the server replace the provider's rows in our local
	 * snapshot, and the global snapshot is then refreshed in the background so
	 * any concurrent peer (refresh, generation bump) stays in sync.
	 */
	async upsertAuthCredentialRemote(provider: string, credential: AuthCredential): Promise<StoredAuthCredential[]> {
		await this.#client.uploadCredential(provider, credential);
		await this.refreshSnapshot();
		return this.listAuthCredentials(provider);
	}

	async upsertAuthCredentialRemoteIfAbsent(
		provider: string,
		credential: AuthCredential,
	): Promise<AuthCredentialIfAbsentResult> {
		const { inserted, reason } = await this.#client.uploadCredentialIfAbsent(provider, credential);
		await this.refreshSnapshot();
		return { inserted, reason, provider, entries: this.listAuthCredentials(provider) };
	}

	/**
	 * Replace-all semantics: disable every active credential for the provider,
	 * then upload each of the new credentials. Used by API-key login so a new
	 * key clobbers any previously stored key for the same provider.
	 */
	async replaceAuthCredentialsRemote(
		provider: string,
		credentials: AuthCredential[],
	): Promise<StoredAuthCredential[]> {
		const existing = this.listAuthCredentials(provider);
		for (const entry of existing) {
			await this.#client.disableCredential(entry.id, "replaced by newer credential");
		}
		await this.refreshSnapshot();
		for (const credential of credentials) {
			await this.#client.uploadCredential(provider, credential);
			await this.refreshSnapshot();
		}
		this.#maybeRefreshSnapshot("replace");
		return this.listAuthCredentials(provider);
	}

	/**
	 * Fire-and-forget `refreshSnapshot()` after a write. When the SSE stream is
	 * active the broker will deliver the new generation push, so the extra GET
	 * is wasted bandwidth and we skip it.
	 */
	#maybeRefreshSnapshot(reason: string): void {
		if (this.#streamingActive) return;
		void this.refreshSnapshot().catch(error => {
			logger.debug("auth-broker snapshot refresh after write failed", { reason, error: String(error) });
		});
	}

	getCache(key: string): string | null {
		const entry = this.#cache.get(key);
		if (!entry) return null;
		if (entry.expiresAtSec * 1000 <= Date.now()) {
			this.#cache.delete(key);
			return null;
		}
		return entry.value;
	}

	setCache(key: string, value: string, expiresAtSec: number): void {
		let persistedValue = value;
		if (key.startsWith("account_health:v1:source:")) {
			try {
				const parsed = JSON.parse(value) as { reason?: unknown } & Record<string, unknown>;
				persistedValue = JSON.stringify({ ...parsed, reason: safePresentationReason(parsed.reason) });
			} catch {
				persistedValue = JSON.stringify({ status: "unknown", reason: null });
			}
		}
		const entry = { value: persistedValue, expiresAtSec };
		this.#cache.set(key, entry);
		if (key.startsWith("account_health:v1:source:")) {
			this.#persistedSourceHealth[this.#presentationAuthority] = {
				...(this.#persistedSourceHealth[this.#presentationAuthority] ?? {}),
				[key]: entry,
			};
			this.#queuePresentationWrite();
		}
	}

	cleanExpiredCache(): void {
		const nowSec = Math.floor(Date.now() / 1000);
		for (const [key, entry] of this.#cache) {
			if (entry.expiresAtSec <= nowSec) this.#cache.delete(key);
		}
	}

	deleteCachePrefix(prefix: string): void {
		for (const key of this.#cache.keys()) {
			if (key.startsWith(prefix)) this.#cache.delete(key);
		}
		if (prefix.startsWith("usage_cache:")) this.#invalidateUsageCache();
	}

	#invalidateUsageCache(): void {
		this.#usageCache = undefined;
		this.#usageInflight = undefined;
		this.#scopedUsageCache.clear();
		this.#scopedUsageInflight.clear();
		this.#usageCacheEpoch += 1;
	}

	/**
	 * Store-level hook consumed by `AuthStorage` — routes refresh through the
	 * broker so the actual refresh token never leaves the broker host. Returns
	 * the broker-redacted credential with {@link REMOTE_REFRESH_SENTINEL} in
	 * the `refresh` slot.
	 */
	async refreshOAuthCredential(
		_provider: Provider,
		credentialId: number,
		_credential: OAuthCredential,
		signal?: AbortSignal,
	): Promise<OAuthCredentials> {
		try {
			await this.#client.refreshCredential(credentialId, signal);
		} catch (error) {
			if (isErrorStatus(error, 404) && !this.#streamingActive) {
				await this.refreshSnapshot().catch(refreshError => {
					logger.debug("auth-broker snapshot refresh after missing credential refresh failed", {
						error: String(refreshError),
					});
				});
			}
			throw error;
		}
		await this.refreshSnapshot();
		const accepted = this.#snapshot.credentials.find(candidate => candidate.id === credentialId);
		if (accepted?.credential.type !== "oauth") {
			throw new Error(`Broker snapshot no longer contains OAuth credential id=${credentialId}`);
		}
		const refreshed = accepted.credential;
		return {
			access: refreshed.access,
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: refreshed.expires,
			accountId: refreshed.accountId,
			email: refreshed.email,
			projectId: refreshed.projectId,
			enterpriseUrl: refreshed.enterpriseUrl,
		};
	}

	async refreshMCPOAuthCredential(
		credentialId: number,
		credential: OAuthCredential,
		client: MCPOAuthRefreshClient,
		signal?: AbortSignal,
	): Promise<OAuthCredential> {
		await this.#client.refreshMCPCredential(credentialId, client, signal);
		await this.refreshSnapshot();
		const accepted = this.#snapshot.credentials.find(candidate => candidate.id === credentialId);
		if (accepted?.credential.type !== "oauth") {
			throw new Error(`Broker snapshot no longer contains OAuth credential id=${credentialId}`);
		}
		assertCanonicalMCPOAuthBinding(credential.mcpBinding);
		assertCanonicalMCPOAuthBinding(accepted.credential.mcpBinding);
		if (
			accepted.credential.mcpBinding.resourceOrigin !== credential.mcpBinding.resourceOrigin ||
			accepted.credential.mcpBinding.tokenEndpoint !== credential.mcpBinding.tokenEndpoint
		) {
			throw new Error("Broker returned mismatched MCP OAuth credential binding");
		}
		return accepted.credential;
	}

	/**
	 * Store-level hook consumed by `AuthStorage.fetchUsageReports()` — proxies
	 * to the broker's `/v1/usage` endpoint. The broker's egress IP isn't
	 * rate-limited by Anthropic's per-IP `/usage` cap the way a heavy
	 * residential laptop is, so all credentials surface every cycle.
	 */
	async fetchUsageReports(signal?: AbortSignal): Promise<UsageReport[] | null> {
		return this.#raceWithSignal(this.#loadUsageReports(), signal);
	}

	async fetchUsageReportsForProvider(provider: Provider, signal?: AbortSignal): Promise<UsageReport[] | null> {
		return this.#raceWithSignal(this.#loadUsageReports(provider), signal);
	}

	/** Synchronous, zero-network usage presentation read. */
	peekCachedUsagePresentation(provider: Provider, credentialId: number): CachedUsagePresentation | undefined {
		const entry = this.#snapshot.credentials.find(candidate => candidate.id === credentialId);
		if (!entry || entry.provider !== provider) return undefined;
		const cached = this.#usagePresentations.get(credentialId);
		if (!cached) return undefined;
		const now = Date.now();
		if (cached.retainUntil <= now) {
			this.#usagePresentations.delete(credentialId);
			return undefined;
		}
		const identityDigest = this.#identityDigestForEntry(entry);
		if (
			cached.provider !== provider ||
			cached.inventoryGeneration !== this.#generation ||
			cached.identityDigest !== identityDigest
		) {
			this.#usagePresentations.delete(credentialId);
			return undefined;
		}
		return cloneUsagePresentation(cached);
	}

	/** Synchronous, zero-network health presentation read backed by the redacted sidecar. */
	peekCachedCredentialHealth(provider: Provider, credentialId: number): CachedCredentialHealth | undefined {
		const entry = this.#snapshot.credentials.find(candidate => candidate.id === credentialId);
		if (!entry || entry.provider !== provider) return undefined;
		const key = presentationRecordKey(provider, this.#identityDigestForEntry(entry));
		const health = this.#persistedPresentations.get(key)?.health;
		if (!health || health.retainUntil <= Date.now()) {
			if (health) {
				const record = this.#persistedPresentations.get(key);
				if (record) {
					delete record.health;
					if (!record.usage) this.#persistedPresentations.delete(key);
					this.#queuePresentationWrite();
				}
			}
			return undefined;
		}
		return {
			status: health.status,
			reason: health.reason,
			...(health.checkedAt === undefined ? {} : { checkedAt: health.checkedAt }),
			retainUntil: health.retainUntil,
		};
	}

	/** Persist a safe health result without credential or bearer-token material. */
	recordCredentialHealth(provider: Provider, credentialId: number, health: CachedCredentialHealth): void {
		if (health.status === "unknown" || !health.retainUntil || health.retainUntil <= Date.now()) return;
		const entry = this.#snapshot.credentials.find(candidate => candidate.id === credentialId);
		if (!entry || entry.provider !== provider) return;
		const identityDigest = this.#identityDigestForEntry(entry);
		const key = presentationRecordKey(provider, identityDigest);
		const record = this.#persistedPresentations.get(key) ?? { credentialId, provider, identityDigest };
		record.health = {
			v: 1,
			status: health.status,
			reason: safePresentationReason(health.reason),
			...(health.checkedAt === undefined ? {} : { checkedAt: health.checkedAt }),
			retainUntil: health.retainUntil,
		};
		this.#persistedPresentations.set(key, record);
		this.#queuePresentationWrite();
	}

	/** Record a safe usage observation after an explicit broker usage/check call. */
	recordUsagePresentation(observation: CachedUsagePresentation): void {
		if (!Number.isInteger(observation.credentialId)) return;
		if (!Number.isFinite(observation.inventoryGeneration) || observation.inventoryGeneration !== this.#generation)
			return;
		if (!Number.isFinite(observation.fetchedAt) || !Number.isFinite(observation.freshUntil)) return;
		if (!Number.isFinite(observation.retainUntil) || observation.retainUntil <= observation.fetchedAt) return;
		const entry = this.#snapshot.credentials.find(candidate => candidate.id === observation.credentialId);
		if (!entry || entry.provider !== observation.provider) return;
		if (this.#identityDigestForEntry(entry) !== observation.identityDigest) return;
		const usage = safePresentationUsageReport(observation.usage);
		const stored = cloneUsagePresentation({
			credentialId: observation.credentialId,
			provider: observation.provider,
			inventoryGeneration: observation.inventoryGeneration,
			identityDigest: observation.identityDigest,
			usage,
			fetchedAt: observation.fetchedAt,
			freshUntil: Math.min(observation.freshUntil, observation.fetchedAt + PRESENTATION_FRESH_MS),
			retainUntil: Math.min(observation.retainUntil, observation.fetchedAt + PRESENTATION_RETENTION_MS),
		});
		this.#usagePresentations.set(observation.credentialId, stored);
		const key = presentationRecordKey(observation.provider, observation.identityDigest);
		const persisted = this.#persistedPresentations.get(key) ?? {
			credentialId: observation.credentialId,
			provider: observation.provider,
			identityDigest: observation.identityDigest,
		};
		persisted.usage = stored;
		this.#persistedPresentations.set(key, persisted);
		this.#queuePresentationWrite();
	}

	/** Persist an explicit usage/check report for the current credential identity. */
	recordCredentialUsage(provider: Provider, credentialId: number, report: SafeUsageReport): void {
		const entry = this.#snapshot.credentials.find(candidate => candidate.id === credentialId);
		if (!entry || entry.provider !== provider) return;
		const fetchedAt = Number.isFinite(report.fetchedAt) ? report.fetchedAt : Date.now();
		this.recordUsagePresentation({
			credentialId,
			provider,
			inventoryGeneration: this.#generation,
			identityDigest: this.#identityDigestForEntry(entry),
			usage: safePresentationUsageReport(report),
			fetchedAt,
			freshUntil: fetchedAt + PRESENTATION_FRESH_MS,
			retainUntil: fetchedAt + PRESENTATION_RETENTION_MS,
		});
	}

	/**
	 * Per-credential usage hook consumed by `AuthStorage.#getUsageReport`. Pulls
	 * the aggregate broker `/v1/usage` once and serves all callers from the
	 * same response (coalesced + cached), then matches the credential to a
	 * report by provider + identity (accountId / email / projectId).
	 *
	 * The broker already aggregates with its own 30s TTL on the server side; our
	 * 15s client TTL is below that so we usually re-use the broker's cache too.
	 */
	async getUsageReport(
		provider: Provider,
		credential: OAuthCredential,
		signal?: AbortSignal,
	): Promise<UsageReport | null> {
		const reports = await this.#raceWithSignal(this.#loadUsageReports(provider), signal).catch(() => null);
		if (!reports) return null;
		return matchUsageReport(reports, provider, credential);
	}

	/**
	 * Reject the awaited promise when the caller's signal aborts, without
	 * affecting the shared upstream fetch. Used to give each caller their
	 * own cancel without one caller's abort cascading into a peer's in-flight
	 * request through the single-flight `#usageInflight`.
	 */
	#raceWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
		if (!signal) return promise;
		if (signal.aborted) return Promise.reject(new Error("auth-broker request aborted"));
		return new Promise<T>((resolve, reject) => {
			const onAbort = (): void => {
				signal.removeEventListener("abort", onAbort);
				reject(new Error("auth-broker request aborted"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			promise.then(
				value => {
					signal.removeEventListener("abort", onAbort);
					resolve(value);
				},
				err => {
					signal.removeEventListener("abort", onAbort);
					reject(err);
				},
			);
		});
	}

	#identityDigestForEntry(entry: SnapshotEntry): string {
		const credential = entry.credential;
		const identity =
			credential.type === "oauth"
				? {
						accountId: credential.accountId ?? null,
						email: credential.email?.trim().toLowerCase() ?? null,
						projectId: credential.projectId ?? null,
						enterpriseUrl: credential.enterpriseUrl ?? null,
						mcpBinding: credential.mcpBinding ?? null,
					}
				: { type: credential.type };
		return createHash("sha256")
			.update(JSON.stringify({ id: entry.id, provider: entry.provider, type: credential.type, identity }))
			.digest("hex");
	}

	#reconcileUsagePresentations(): void {
		for (const [credentialId, cached] of this.#usagePresentations) {
			const entry = this.#snapshot.credentials.find(candidate => candidate.id === credentialId);
			if (
				!entry ||
				entry.provider !== cached.provider ||
				this.#identityDigestForEntry(entry) !== cached.identityDigest
			) {
				this.#usagePresentations.delete(credentialId);
				continue;
			}
			this.#usagePresentations.set(credentialId, { ...cached, inventoryGeneration: this.#generation });
		}
	}

	#recordUsageReports(reports: UsageReport[], epoch: number): void {
		if (this.#usageCacheEpoch !== epoch) return;
		for (const entry of this.#snapshot.credentials) {
			if (entry.credential.type !== "oauth") continue;
			const report = matchUsageReport(reports, entry.provider, entry.credential);
			if (!report) continue;
			const fetchedAt = Number.isFinite(report.fetchedAt) ? report.fetchedAt : Date.now();
			this.recordUsagePresentation({
				credentialId: entry.id,
				provider: entry.provider,
				inventoryGeneration: this.#generation,
				identityDigest: this.#identityDigestForEntry(entry),
				usage: safePresentationUsageReport(report),
				fetchedAt,
				freshUntil: fetchedAt + PRESENTATION_FRESH_MS,
				retainUntil: fetchedAt + PRESENTATION_RETENTION_MS,
			});
		}
	}

	#loadUsageReports(provider?: Provider): Promise<UsageReport[] | null> {
		if (provider) {
			const cached = this.#scopedUsageCache.get(provider);
			if (cached && Date.now() - cached.fetchedAt < USAGE_CACHE_TTL_MS) return Promise.resolve(cached.reports);
			const existing = this.#scopedUsageInflight.get(provider);
			if (existing) return existing;
			const epoch = this.#usageCacheEpoch;
			const inflight = this.#client
				.fetchUsage(undefined, provider)
				.then(body => {
					if (this.#usageCacheEpoch === epoch) {
						this.#scopedUsageCache.set(provider, { reports: body.reports, fetchedAt: Date.now() });
						this.#recordUsageReports(body.reports, epoch);
					}
					return body.reports;
				})
				.catch(error => {
					logger.warn("auth-broker scoped usage fetch failed", { provider, error: String(error) });
					throw error;
				})
				.finally(() => this.#scopedUsageInflight.delete(provider));
			this.#scopedUsageInflight.set(provider, inflight);
			return inflight;
		}
		const cached = this.#usageCache;
		if (cached && Date.now() - cached.fetchedAt < USAGE_CACHE_TTL_MS) {
			return Promise.resolve(cached.reports);
		}
		if (this.#usageInflight) return this.#usageInflight;
		const epoch = this.#usageCacheEpoch;
		const inflight = this.#client
			.fetchUsage()
			.then(body => {
				if (this.#usageCacheEpoch === epoch) {
					this.#usageCache = { reports: body.reports, fetchedAt: Date.now() };
					this.#recordUsageReports(body.reports, epoch);
				}
				return body.reports;
			})
			.catch(error => {
				logger.warn("auth-broker usage fetch failed", { error: String(error) });
				return null;
			})
			.finally(() => {
				if (this.#usageCacheEpoch === epoch) this.#usageInflight = undefined;
			});
		this.#usageInflight = inflight;
		return inflight;
	}

	close(): void {
		if (this.#closed) return;
		this.#backgroundAbort.abort();
		void this.#presentationWriteChain.finally(() => {
			this.#persistedPresentations.clear();
		});
		this.#closed = true;
		this.#snapshotListeners.clear();
		this.#cache.clear();
		this.#usagePresentations.clear();
		this.#inventoryMetadata.clear();
		this.#inventorySyncInflight = undefined;
	}
}

function isErrorStatus(error: unknown, status: number): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"status" in error &&
		(error as { status?: unknown }).status === status
	);
}

function snapshotIdentityLabel(entry: SnapshotEntry): string | null {
	if (entry.credential.type !== "oauth") return null;
	return entry.credential.email ?? entry.credential.accountId ?? entry.credential.projectId ?? null;
}

function safePresentationUsageReport(report: UsageReport): SafeUsageReport {
	const sanitize = (value: string): string =>
		value
			.replace(/bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
			.replace(/(api[_-]?key|token|secret|authorization)[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 160);
	const { raw: _raw, metadata: _metadata, ...safe } = report;
	return {
		...safe,
		limits: safe.limits.map(limit => {
			const { accountId: _accountId, projectId: _projectId, orgId: _orgId, ...scope } = limit.scope;
			return {
				...limit,
				id: sanitize(limit.id),
				label: sanitize(limit.label),
				...(limit.window
					? { window: { ...limit.window, id: sanitize(limit.window.id), label: sanitize(limit.window.label) } }
					: {}),
				...(limit.notes ? { notes: limit.notes.map(sanitize) } : {}),
				scope,
			};
		}),
	};
}

function cloneUsagePresentation(observation: CachedUsagePresentation): CachedUsagePresentation {
	return {
		...observation,
		usage: {
			...observation.usage,
			limits: observation.usage.limits.map(limit => ({
				...limit,
				scope: { ...limit.scope },
				window: limit.window ? { ...limit.window } : undefined,
				amount: { ...limit.amount },
				notes: limit.notes ? [...limit.notes] : undefined,
			})),
			metadata: observation.usage.metadata ? { ...observation.usage.metadata } : undefined,
		},
	};
}

/**
 * Match a broker-supplied usage report to a specific OAuth credential. The
 * broker returns aggregate reports across all credentials it manages, so we
 * pick the one whose identity (accountId / email / projectId) lines up with
 * the credential the caller is asking about.
 *
 * Falls back to the lone candidate when only one matches the provider; falls
 * through to `null` when nothing matches, which `AuthStorage` treats as "no
 * usage data" (ranking proceeds without a usage signal for this credential).
 */
function matchUsageReport(reports: UsageReport[], provider: Provider, credential: OAuthCredential): UsageReport | null {
	const candidates = reports.filter(report => report.provider === provider);
	if (candidates.length === 0) return null;
	if (candidates.length === 1) return candidates[0];
	const accountId = credential.accountId?.trim().toLowerCase();
	const email = credential.email?.trim().toLowerCase();
	const projectId = credential.projectId?.trim().toLowerCase();
	for (const report of candidates) {
		if (reportMatchesIdentity(report, accountId, email, projectId)) return report;
	}
	return null;
}

function reportMatchesIdentity(
	report: UsageReport,
	accountId: string | undefined,
	email: string | undefined,
	projectId: string | undefined,
): boolean {
	const metadata = (report.metadata ?? {}) as Record<string, unknown>;
	if (accountId) {
		const metaAccount = readMetadataString(metadata, "accountId") ?? readMetadataString(metadata, "account_id");
		if (metaAccount && metaAccount.toLowerCase() === accountId) return true;
		for (const limit of report.limits) {
			if (limit.scope.accountId?.toLowerCase() === accountId) return true;
		}
	}
	if (email) {
		const metaEmail = readMetadataString(metadata, "email");
		if (metaEmail && metaEmail.toLowerCase() === email) return true;
	}
	if (projectId) {
		const metaProject = readMetadataString(metadata, "projectId") ?? readMetadataString(metadata, "project_id");
		if (metaProject && metaProject.toLowerCase() === projectId) return true;
		for (const limit of report.limits) {
			if (limit.scope.projectId?.toLowerCase() === projectId) return true;
		}
	}
	return false;
}

function readMetadataString(metadata: Record<string, unknown>, key: string): string | undefined {
	const value = metadata[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

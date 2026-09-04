/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, refreshing credentials, and usage tracking.
 *
 * This module defines:
 * - `AuthCredentialStore` interface: persistence abstraction (SQLite, remote vault, …)
 * - `AuthStorage` class: credential management with round-robin, usage limits, OAuth refresh
 * - `SqliteAuthCredentialStore`: concrete SQLite-backed implementation
 */
import { Database, type Statement } from "bun:sqlite";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDbPath, logger } from "@gajae-code/utils";
import { checkOpenCodexStatus } from "./providers/openai-opencodex-responses";
import { getEnvApiKey } from "./stream";
import type { Provider } from "./types";
import type {
	CredentialRankingStrategy,
	UsageCredential,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageLogger,
	UsageProvider,
	UsageReport,
} from "./usage";

import {
	formatOpenAICodexChatGPTEntitlementError,
	requiresOpenAICodexProModel,
	requiresStrictOpenAICodexProModel,
} from "./utils/codex-entitlement";
import { getOAuthApiKey, getOAuthProvider, refreshOAuthToken, resolveOAuthStorageProvider } from "./utils/oauth";
import { loginDeepInfra } from "./utils/oauth/deepinfra";
import { loginDeepSeek } from "./utils/oauth/deepseek";
import { loginOpenAICodexDevice } from "./utils/oauth/openai-codex";
import type {
	OAuthController,
	OAuthCredentials,
	OAuthLoginOptions,
	OAuthProvider,
	OAuthProviderId,
} from "./utils/oauth/types";
import { isSqliteError } from "./utils/sqlite-errors";

// ─────────────────────────────────────────────────────────────────────────────
// Credential Types
// ─────────────────────────────────────────────────────────────────────────────

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

/**
 * Extracts the bearer token from the structured API-key form used by OAuth
 * providers that need to carry token metadata alongside the access token.
 */
export function extractStructuredApiKeyToken(apiKey: string): string | undefined {
	if (!apiKey.startsWith("{")) return undefined;
	try {
		const parsed = JSON.parse(apiKey) as { token?: unknown };
		return typeof parsed.token === "string" ? parsed.token : undefined;
	} catch {
		return undefined;
	}
}

export interface MCPOAuthBinding {
	/** Exact HTTP(S) origin of the MCP resource endpoint. */
	resourceOrigin: string;
	/** Exact canonical HTTP(S) token endpoint used to create and refresh the credential. */
	tokenEndpoint: string;
}

function resolveCanonicalHttpUrl(value: string): URL | undefined {
	try {
		const parsed = new URL(value);
		if (
			(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
			parsed.username !== "" ||
			parsed.password !== "" ||
			parsed.hash !== ""
		) {
			return undefined;
		}
		return parsed;
	} catch {
		return undefined;
	}
}

export function resolveMCPOAuthResourceOrigin(value: string): string | undefined {
	return resolveCanonicalHttpUrl(value)?.origin;
}

export function resolveMCPOAuthTokenEndpoint(value: string): string | undefined {
	return resolveCanonicalHttpUrl(value)?.href;
}

export function isCanonicalMCPOAuthBinding(binding: MCPOAuthBinding): boolean {
	return (
		resolveMCPOAuthResourceOrigin(binding.resourceOrigin) === binding.resourceOrigin &&
		resolveMCPOAuthTokenEndpoint(binding.tokenEndpoint) === binding.tokenEndpoint
	);
}

export function assertCanonicalMCPOAuthBinding(
	binding: MCPOAuthBinding | undefined,
): asserts binding is MCPOAuthBinding {
	if (!binding || !isCanonicalMCPOAuthBinding(binding)) {
		throw new Error("Invalid MCP OAuth credential binding");
	}
}

export type OAuthCredential = {
	type: "oauth";
	/** Present only for credentials created by runtime MCP OAuth. */
	mcpBinding?: MCPOAuthBinding;
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export interface MCPOAuthRefreshClient {
	clientId?: string;
	clientSecret?: string;
}

async function refreshBoundMCPOAuthCredential(
	credential: OAuthCredential,
	client: MCPOAuthRefreshClient = {},
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const binding = credential.mcpBinding;
	assertCanonicalMCPOAuthBinding(binding);
	const params = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: credential.refresh,
	});
	if (client.clientId) params.set("client_id", client.clientId);
	if (client.clientSecret) params.set("client_secret", client.clientSecret);

	const response = await fetch(binding.tokenEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
		redirect: "manual",
		signal,
	});
	if (response.status >= 300 && response.status < 400) {
		throw new Error(`MCP OAuth refresh rejected redirect response (${response.status})`);
	}
	if (!response.ok) throw new Error(`MCP OAuth refresh failed (${response.status})`);
	const payload: unknown = await response.json();
	if (!payload || typeof payload !== "object") throw new Error("MCP OAuth refresh returned an invalid payload");
	const data = payload as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
	if (typeof data.access_token !== "string" || data.access_token.length === 0) {
		throw new Error("MCP OAuth refresh returned an invalid access token");
	}
	if (data.refresh_token !== undefined && typeof data.refresh_token !== "string") {
		throw new Error("MCP OAuth refresh returned an invalid refresh token");
	}
	if (
		data.expires_in !== undefined &&
		(typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in < 0)
	) {
		throw new Error("MCP OAuth refresh returned an invalid expiry");
	}
	return {
		access: data.access_token,
		refresh: data.refresh_token || credential.refresh,
		expires: Date.now() + (data.expires_in ?? 3600) * 1000,
	};
}

export type AuthCredentialEntry = AuthCredential | AuthCredential[];

export type AuthStorageData = Record<string, AuthCredentialEntry>;

/**
 * Serialized representation of AuthStorage for passing to subagent workers.
 * Contains only the essential credential data, not runtime state.
 */
export interface SerializedAuthStorage {
	credentials: Record<
		string,
		Array<{
			id: number;
			type: "api_key" | "oauth";
			data: Record<string, unknown>;
		}>
	>;
	runtimeOverrides?: Record<string, string>;
	dbPath?: string;
}

/**
 * Auth credential with database row ID for updates/deletes.
 * Wraps AuthCredential with storage metadata.
 */
export interface StoredAuthCredential {
	id: number;
	provider: string;
	credential: AuthCredential;
	disabledCause: string | null;
	/** Monotonic local row revision used by optimistic hard-removal actions. */
	revision?: number;
}

/**
 * Payload-free inventory projection used by account-management and presentation
 * surfaces. This deliberately has no credential/token fields; `listAuthCredentials`
 * remains the active full-fidelity selection contract.
 */
export interface CredentialInventoryRecord {
	id: number;
	provider: string;
	credentialKind: "oauth" | "api_key";
	identityLabel: string | null;
	accountId?: string;
	email?: string;
	projectId?: string;
	disabled: boolean;
	disabledCause: string | null;
}

/** Safe usage observation supplied by a remote store's presentation cache. */
export interface CachedUsagePresentation {
	credentialId: number;
	provider: string;
	inventoryGeneration: number;
	identityDigest: string;
	usage: SafeUsageReport;
	fetchedAt: number;
	freshUntil: number;
	retainUntil: number;
}

/** Opaque local action target for an all-or-nothing OAuth hard removal. */
export interface CredentialRemovalTarget {
	id: number;
	provider: string;
	expectedRevision: number;
}

export type AuthCredentialHardRemovalResult =
	| { kind: "removed"; ids: readonly number[] }
	| { kind: "conflict"; currentIds: readonly number[] };

/** Usage report projection safe to cross a presentation boundary. */
export type SafeUsageReport = Omit<UsageReport, "raw">;

export type CachedUsageFreshness = "fresh" | "stale-last-good";

export interface CachedUsageReport {
	report: SafeUsageReport;
	fetchedAt: number;
	freshUntil: number;
	retainUntil: number;
	freshness: CachedUsageFreshness;
}

export type CachedCredentialHealthStatus = "ok" | "failed" | "unverifiable" | "unknown";

export interface CachedCredentialHealth {
	status: CachedCredentialHealthStatus;
	reason: string | null;
	checkedAt?: number;
	retainUntil?: number;
}

/** Safe result from an explicit API-key probe whose key bytes are invocation-only. */
export interface ApiKeyCredentialCheckResult {
	provider: string;
	type: "api_key";
	ok: boolean | null;
	reason?: string;
	report?: SafeUsageReport;
}

/** Typed failure raised when an OAuth-only selector cannot be applied. */
export type OAuthCredentialSelectorFailureReason =
	| "api-key-row"
	| "api-key-provider"
	| "override-active"
	| "not-found"
	| "disabled"
	| "ambiguous"
	| "gateway-managed";

export class OAuthCredentialSelectorError extends Error {
	readonly reason: OAuthCredentialSelectorFailureReason;
	readonly provider: string;
	readonly selector: AuthCredentialSelector;
	readonly candidateIds: readonly number[];

	constructor(
		reason: OAuthCredentialSelectorFailureReason,
		provider: string,
		selector: AuthCredentialSelector,
		message: string,
		candidateIds: readonly number[] = [],
	) {
		super(message);
		this.name = "OAuthCredentialSelectorError";
		this.reason = reason;
		this.provider = provider;
		this.selector = selector;
		this.candidateIds = candidateIds;
	}
}

export interface OAuthPinTarget {
	credentialId: number;
	canonicalSelector: AuthCredentialSelector;
}

/**
 * Per-credential health record returned by {@link AuthStorage.checkCredentials}.
 *
 * Use this to identify which credential in a multi-account pool is causing
 * auth errors. `ok` is tri-state:
 *
 * - `true` — credential authenticated against the provider's auth-verifying
 *   probe (today: the usage endpoint). For OAuth this also exercises refresh
 *   when the access token was expired.
 * - `false` — the probe rejected the credential (401/403/refresh failure/etc).
 *   `reason` carries the upstream error string.
 * - `null` — no probe is configured for this provider (or the configured
 *   probe doesn't support this credential type). The credential's auth
 *   status is unverifiable from here.
 */
export interface CredentialHealthResult {
	/** Database row id (matches {@link StoredAuthCredential.id}). */
	id: number;
	provider: string;
	type: AuthCredential["type"];
	/** OAuth email if known on the stored credential or surfaced by the probe. */
	email?: string;
	/** OAuth account id / org id if known. */
	accountId?: string;
	/** `true` when the refresh token lives on a remote broker (sentinel was present). */
	remoteRefresh?: true;
	ok: boolean | null;
	/** Failure / unverifiable reason; absent when `ok === true`. */
	reason?: string;
	report?: SafeUsageReport;
}

export interface CheckCredentialsOptions {
	signal?: AbortSignal;
	provider?: string;
	/** Per-credential probe timeout (ms). Defaults to the configured usage request timeout. */
	timeoutMs?: number;
	/** Provider → base URL override, same shape as {@link AuthStorage.fetchUsageReports}. */
	baseUrlResolver?: (provider: Provider) => string | undefined;
}

/** Options for the explicit, invocation-only API-key probe. */
export interface ApiKeyCredentialCheckOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	baseUrl?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth Broker Snapshot Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sentinel value placed in OAuth `refresh` fields when a credential is shared
 * via {@link AuthStorage.exportSnapshot}. Refresh tokens never leave the broker;
 * clients must call back to refresh.
 */
export const REMOTE_REFRESH_SENTINEL = "__remote__" as const;
export type RemoteRefreshSentinel = typeof REMOTE_REFRESH_SENTINEL;

/** OAuth credential with refresh token replaced by the broker sentinel. */
export type RemoteOAuthCredential = Omit<OAuthCredential, "refresh"> & {
	refresh: RemoteRefreshSentinel;
};

/** Discriminated credential payload as published by the broker. */
export type SnapshotCredential = ApiKeyCredential | RemoteOAuthCredential;

export interface AuthCredentialSnapshotEntry {
	id: number;
	provider: string;
	credential: SnapshotCredential;
	identityKey: string | null;
	revision?: number;
}

export type AuthCredentialIfAbsentReason =
	| "inserted"
	| "updated-existing"
	| "skipped-existing"
	| "skipped-existing-runtime"
	| "skipped-existing-config"
	| "skipped-existing-env"
	| "skipped-existing-fallback"
	| "skipped-invalid";

export interface AuthCredentialIfAbsentResult {
	inserted: boolean;
	reason: AuthCredentialIfAbsentReason;
	provider: string;
	entries: StoredAuthCredential[];
}

export interface AuthCredentialIfAbsentSnapshotResult {
	inserted: boolean;
	reason: AuthCredentialIfAbsentReason;
	provider: string;
	entries: AuthCredentialSnapshotEntry[];
}

/**
 * Wire-shaped snapshot exported by {@link AuthStorage.exportSnapshot} and
 * served by the auth-broker server on `GET /v1/snapshot`.
 */
export interface AuthCredentialSnapshot {
	generation: number;
	generatedAt: number;
	credentials: AuthCredentialSnapshotEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// AuthCredentialStore interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persistence abstraction consumed by {@link AuthStorage}.
 *
 * Concrete implementations:
 * - {@link SqliteAuthCredentialStore} — local SQLite-backed store (default).
 * - `RemoteAuthCredentialStore` from `./auth-broker` — client-side snapshot of
 *   a remote broker; mutating methods (`replace*`, `upsert*`, `delete*ForProvider`)
 *   throw because login flows route through the broker, not the client.
 */
export type OAuthRefreshLease = {
	credentialId: number;
	owner: string;
	tokenFingerprint: string;
};

export type OAuthRefreshLeaseClaim =
	| { kind: "claimed"; credential: OAuthCredential; lease: OAuthRefreshLease }
	| { kind: "adopted"; credential: OAuthCredential }
	| { kind: "busy"; expiresAt: number }
	| { kind: "missing" };

/**
 * Store-owned ticket that orders a provider admission against remote
 * credential snapshot application. The ticket is intentionally released at
 * provider admission, not response completion.
 */
export interface CredentialDispatchTicket {
	release(): void;
}

export interface AuthCredentialStore {
	close(): void;
	refreshSnapshot?(signal?: AbortSignal): Promise<unknown>;
	onSnapshotChanged?(listener: () => void): () => void;
	/** Order provider admission with remote snapshot authority application. */
	acquireCredentialDispatchTicket?(provider: Provider, signal?: AbortSignal): Promise<CredentialDispatchTicket>;
	listAuthCredentials(provider?: string): StoredAuthCredential[];
	/** Payload-free account inventory; active and soft-disabled rows are included. */
	listCredentialInventory?(provider?: string): CredentialInventoryRecord[];
	/** Local opaque removal targets; remote stores may omit this capability. */
	listCredentialRemovalTargets?(provider?: string): CredentialRemovalTarget[];
	/** Transactional local hard removal; remote stores must reject this capability. */
	removeAuthCredentialsHard?(
		provider: string,
		targets: readonly CredentialRemovalTarget[],
	): AuthCredentialHardRemovalResult;
	updateAuthCredential(id: number, credential: AuthCredential): void;
	deleteAuthCredential(id: number, disabledCause: string): void;
	tryDisableAuthCredentialIfMatches(id: number, expectedData: string, disabledCause: string): boolean;
	tryDisableAuthCredentialIfRevision?(id: number, expectedRevision: number, disabledCause: string): boolean;
	replaceAuthCredentialsForProvider(provider: string, credentials: AuthCredential[]): StoredAuthCredential[];
	upsertAuthCredentialForProvider(provider: string, credential: AuthCredential): StoredAuthCredential[];
	upsertAuthCredentialForProviderIfAbsent(provider: string, credential: AuthCredential): AuthCredentialIfAbsentResult;
	deleteAuthCredentialsForProvider(provider: string, disabledCause: string): void;
	getCache(key: string, options?: { includeExpired?: boolean }): string | null;
	setCache(key: string, value: string, expiresAtSec: number): void;
	/** Atomically allocate a durable sequence for broker restart epochs. */
	allocateMonotonicSequence(key: string, expiresAtSec: number): number;
	deleteCachePrefix?(prefix: string): void;
	cleanExpiredCache(): void;
	/**
	 * Optional store-supplied OAuth refresh. When present, `AuthStorage` uses
	 * it before the per-provider local refresh path. `RemoteAuthCredentialStore`
	 * implements this against the broker; SQLite stores leave it undefined.
	 *
	 * Precedence: `AuthStorageOptions.refreshOAuthCredential` > this hook > local.
	 *
	 * `signal` propagates the agent's cancel (ESC, request abort, …) all the
	 * way to the broker fetch so a hung connection can't strand the caller
	 * for `timeoutMs * (maxRetries + 1)`.
	 */
	refreshOAuthCredential?(
		provider: Provider,
		credentialId: number,
		credential: OAuthCredential,
		signal?: AbortSignal,
	): Promise<OAuthCredentials>;
	/** Broker-backed MCP refresh using the broker's stored token endpoint and refresh secret. */
	refreshMCPOAuthCredential?(
		credentialId: number,
		credential: OAuthCredential,
		client: MCPOAuthRefreshClient,
		signal?: AbortSignal,
	): Promise<OAuthCredential>;
	/**
	 * Atomically adopts a fresh row or claims the current refresh token for one
	 * local provider dial. SQLite-backed stores use this to prevent another
	 * process from replaying a rotating refresh token between a pre-read and
	 * the provider request.
	 */
	claimOAuthRefreshLease?(
		credentialId: number,
		expectedRefresh: string,
		force: boolean,
		owner: string,
		nowMs: number,
		leaseMs: number,
	): OAuthRefreshLeaseClaim;
	/** Atomically persists a successful claimed refresh and releases its lease. */
	completeOAuthRefreshLease?(lease: OAuthRefreshLease, credential: OAuthCredential): boolean;
	/** Releases an uncompleted refresh lease owned by this process. */
	releaseOAuthRefreshLease?(lease: OAuthRefreshLease): void;

	/**
	 * Optional async pre-read hook invoked after AuthStorage selects a stored
	 * credential but before it returns that credential for an outbound request.
	 * Remote broker stores use this to wait out imminent rotations and refresh
	 * their local snapshot before the caller sees a stale access token.
	 */
	prepareForRequest?(credentialId: number, opts?: { signal?: AbortSignal }): Promise<boolean | undefined>;
	/**
	 * Optional store-supplied aggregate usage fetch. When present, `AuthStorage`
	 * routes `fetchUsageReports()` here instead of fanning out per-credential.
	 * `RemoteAuthCredentialStore` proxies to the broker (whose datacenter IP
	 * isn't rate-limited like a heavy residential client).
	 *
	 * Precedence: `AuthStorageOptions.fetchUsageReports` > this hook > local fan-out.
	 *
	 * `signal` propagates the agent's cancel down to the broker fetch.
	 */
	fetchUsageReports?(signal?: AbortSignal): Promise<UsageReport[] | null>;
	fetchUsageReportsForProvider?(provider: Provider, signal?: AbortSignal): Promise<UsageReport[] | null>;
	/** Synchronous, zero-network usage presentation peek. */
	peekCachedUsagePresentation?(provider: Provider, credentialId: number): CachedUsagePresentation | undefined;
	/** Record a safe usage observation after an explicit fetch/check. */
	recordUsagePresentation?(observation: CachedUsagePresentation): void;
	/** Read a safe, durable health observation for one credential row. */
	peekCachedCredentialHealth?(provider: Provider, credentialId: number): CachedCredentialHealth | undefined;
	/** Persist a safe health observation for one credential row. */
	recordCredentialHealth?(provider: Provider, credentialId: number, health: CachedCredentialHealth): void;
	/** Persist a safe usage observation without exposing credential payloads. */
	recordCredentialUsage?(provider: Provider, credentialId: number, report: SafeUsageReport): void;
	/**
	 * Optional readiness hook for stores that must hydrate payload-free metadata
	 * before one-shot inventory consumers read their first snapshot.
	 */
	waitForReady?(): Promise<void>;
	/**
	 * Optional store-supplied per-credential usage report lookup. When present,
	 * `AuthStorage` consults this before its own per-credential upstream fetch
	 * (`#getUsageReport`). `RemoteAuthCredentialStore` implements this against
	 * the broker's aggregate `/v1/usage` (one coalesced round-trip shared across
	 * all callers) so multi-credential ranking on the client never hits the
	 * upstream provider's rate-limited usage endpoint from the laptop IP.
	 *
	 * Returning `null` is authoritative — `AuthStorage` does NOT fall back to
	 * the local fetch path. The store hook owns the decision, since falling
	 * back would re-introduce the per-IP rate-limit problem the broker exists
	 * to avoid.
	 *
	 * `signal` propagates the agent's cancel down to the broker fetch.
	 */
	getUsageReport?(provider: Provider, credential: OAuthCredential, signal?: AbortSignal): Promise<UsageReport | null>;
	/**
	 * Optional store hook to invalidate a specific credential after the upstream
	 * provider returned 401 on a supposedly-fresh key. Remote stores force the
	 * broker to re-issue the row; local stores can leave it undefined and let
	 * {@link AuthStorage.invalidateCredentialMatching} fall back to `reload()`.
	 */
	markCredentialSuspect?(credentialId: number, opts?: { signal?: AbortSignal }): Promise<void>;
	/**
	 * Optional async write hook to disable one credential through an authoritative
	 * remote store. Remote clients MUST use this hook instead of the synchronous
	 * local delete methods when an OAuth refresh fails definitively.
	 *
	 * Returns `false` when the row is already absent (for example, a peer
	 * disabled it first). Implementations MUST NOT treat a failed remote write as
	 * a successful local deletion.
	 */
	disableAuthCredentialRemote?(
		credentialId: number,
		disabledCause: string,
		signal?: AbortSignal,
		expectedRevision?: number,
	): Promise<boolean>;
	/**
	 * Optional async write hook for upserting a single credential. When present,
	 * `AuthStorage.#upsertOAuthCredential` routes through this instead of the
	 * sync `upsertAuthCredentialForProvider`. `RemoteAuthCredentialStore` uses
	 * it to send the upsert to the broker via `POST /v1/credential`.
	 *
	 * Implementations MUST update the in-memory snapshot before returning so the
	 * post-write read path is consistent.
	 */
	upsertAuthCredentialRemote?(provider: string, credential: AuthCredential): Promise<StoredAuthCredential[]>;
	upsertAuthCredentialRemoteIfAbsent?(
		provider: string,
		credential: AuthCredential,
	): Promise<AuthCredentialIfAbsentResult>;
	/**
	 * Optional async write hook for replace-all semantics (e.g. API-key login
	 * overwriting any previous keys for the same provider). When present,
	 * `AuthStorage.set` routes through this instead of the sync
	 * `replaceAuthCredentialsForProvider`.
	 */
	replaceAuthCredentialsRemote?(provider: string, credentials: AuthCredential[]): Promise<StoredAuthCredential[]>;
	/**
	 * Optional async write hook for clearing every credential for a provider
	 * (logout or a provider-wide invalidation). Remote stores must perform this
	 * through their authoritative broker rather than mutating the client cache.
	 */
	deleteAuthCredentialsRemote?(provider: string, disabledCause: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// AuthStorage Options
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Event payload describing a credential that was just soft-disabled.
 *
 * Today the only call site is OAuth refresh failures with a definitive cause
 * (`invalid_grant`, `401/403` not from a network blip, etc.) — the
 * disabled_cause string is the verbatim error captured for forensics.
 *
 * Subscribers can use this to surface a notification, banner, or auto-launch
 * a re-login flow instead of letting the credential silently disappear.
 */
export interface CredentialDisabledEvent {
	provider: string;
	disabledCause: string;
}

/**
 * How {@link AuthStorage} orders multiple healthy OAuth credentials of the same
 * provider:type pool when selecting one for a (new) session.
 *
 * - `balanced` (default): prefer the least-used / lowest-drain-rate account.
 *   Spreads load across accounts and keeps burst headroom on every account.
 * - `earliest-reset`: prefer the non-blocked account whose usage window resets
 *   soonest (earliest-expiry-first). Tumbling-window quota is perishable —
 *   unused quota is lost at reset — so draining the soonest-to-reset account
 *   first minimizes wasted quota. Drain/used metrics remain tiebreakers.
 *
 * Only affects ranking, which the `shouldRank` guard already limits to session
 * start (or when the session's preferred credential is blocked), so this never
 * thrashes accounts mid-session / cold-starts the server-side prompt cache.
 */
export type CredentialRankingMode = "balanced" | "earliest-reset";

export type AuthStorageOptions = {
	usageProviderResolver?: (provider: Provider) => UsageProvider | undefined;
	rankingStrategyResolver?: (provider: Provider) => CredentialRankingStrategy | undefined;
	credentialRankingMode?: CredentialRankingMode;
	usageFetch?: typeof fetch;
	usageRequestTimeoutMs?: number;
	usageLogger?: UsageLogger;
	/**
	 * Resolve a config value (API key, header value, etc.) to an actual value.
	 * - coding-agent injects its resolveConfigValue (supports "!command" syntax via pi-natives)
	 * - Default: checks environment variable first, then treats as literal
	 * `cacheScope` changes whenever the provider credential configuration changes.
	 */
	configValueResolver?: (config: string, cacheScope?: string) => Promise<string | undefined>;
	/**
	 * Optional callback fired when AuthStorage automatically disables a
	 * credential because something detected it as no longer usable — today
	 * that's the OAuth refresh-failure path in `getApiKey`. NOT fired for
	 * user-initiated `remove()` (the user already knows) or dedup of
	 * duplicate credentials (uninteresting hygiene).
	 */
	onCredentialDisabled?: (event: CredentialDisabledEvent) => void | Promise<void>;
	/**
	 * Override OAuth refresh. When set, `AuthStorage` calls this instead of the
	 * per-provider local refresh function. Receives the credential id so the
	 * implementation can address remote credentials.
	 *
	 * Must return updated {@link OAuthCredentials} with at least `access` and
	 * `expires`. `refresh` may be an opaque sentinel (e.g. `"__remote__"`) when
	 * the actual refresh token never leaves the broker.
	 */
	refreshOAuthCredential?: (
		provider: Provider,
		credentialId: number,
		credential: OAuthCredential,
		signal?: AbortSignal,
	) => Promise<OAuthCredentials>;
	/**
	 * Human-readable description of the credential store backing this
	 * AuthStorage instance. Surfaced through {@link AuthStorage.describeCredentialSource}
	 * so the TUI can show where a token came from (broker URL or local SQLite path).
	 *
	 * Examples:
	 * - `"local ~/.gjc/agent/agent.db"`
	 * - `"broker http://can.internal:8765"`
	 */
	sourceLabel?: string;
	/**
	 * Override `fetchUsageReports`. When set, `AuthStorage.fetchUsageReports`
	 * calls this instead of fanning out per-credential. The primary use case is
	 * routing through a broker that egresses from a less-throttled IP — e.g. a
	 * residential laptop trips Anthropic's per-IP rate limit on the usage
	 * endpoint and drops 2-of-5 credentials, while the VPS broker gets all 5.
	 *
	 * Implementations may return null when no usage data is available; the
	 * AuthStorage caller surfaces that to its own consumer unchanged.
	 */
	fetchUsageReports?: (signal?: AbortSignal) => Promise<UsageReport[] | null>;
	fetchUsageReportsForProvider?: (provider: Provider, signal?: AbortSignal) => Promise<UsageReport[] | null>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Default Config Value Resolver
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default config value resolver that checks env vars and treats as literal.
 * Does NOT support "!command" syntax (that requires pi-natives).
 */
async function defaultConfigValueResolver(config: string): Promise<string | undefined> {
	const envValue = process.env[config];
	return envValue || config;
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage Providers (defaults)
// ─────────────────────────────────────────────────────────────────────────────

/** A lazy built-in usage-provider descriptor. */
interface UsageProviderDescriptor {
	id: Provider;
	supports?: UsageProvider["supports"];
	load: () => Promise<UsageProvider>;
}

function memoizeUsageProvider(loader: () => UsageProvider): () => Promise<UsageProvider> {
	let promise: Promise<UsageProvider> | undefined;
	return () => {
		promise ??= Promise.resolve().then(loader);
		return promise;
	};
}

function supportsOAuthUsage(params: UsageFetchParams): boolean {
	return params.credential.type === "oauth";
}

function supportsGoogleGeminiCliUsage(params: UsageFetchParams): boolean {
	return params.credential.type === "oauth" && Boolean(params.credential.accessToken);
}

function supportsGithubCopilotUsage(params: UsageFetchParams): boolean {
	if (params.provider !== "github-copilot") return false;
	if (params.credential.type === "oauth") {
		return Boolean(params.credential.refreshToken || params.credential.accessToken);
	}
	return Boolean(params.credential.apiKey);
}

function supportsProvider(provider: Provider): (params: UsageFetchParams) => boolean {
	return params => params.provider === provider;
}

/**
 * Built-in usage providers stay as descriptors so importing AuthStorage does not
 * parse provider-specific usage implementations. A descriptor's `supports`
 * predicate is deliberately small and synchronous; the implementation is loaded
 * only after a request has passed that predicate.
 */
const DEFAULT_USAGE_PROVIDER_DESCRIPTORS: readonly UsageProviderDescriptor[] = [
	{
		id: "openai-codex",
		supports: (params: UsageFetchParams) => params.provider === "openai-codex" && supportsOAuthUsage(params),
		load: memoizeUsageProvider(() => {
			const module = require("./usage/openai-codex") as { openaiCodexUsageProvider: UsageProvider };
			return module.openaiCodexUsageProvider;
		}),
	},
	{
		id: "kimi-code",
		supports: (params: UsageFetchParams) => params.provider === "kimi-code" && supportsOAuthUsage(params),
		load: memoizeUsageProvider(() => {
			const module = require("./usage/kimi") as { kimiUsageProvider: UsageProvider };
			return module.kimiUsageProvider;
		}),
	},
	{
		id: "google-antigravity",
		supports: supportsProvider("google-antigravity"),
		load: memoizeUsageProvider(() => {
			const module = require("./usage/google-antigravity") as { antigravityUsageProvider: UsageProvider };
			return module.antigravityUsageProvider;
		}),
	},
	{
		id: "google-gemini-cli",
		supports: (params: UsageFetchParams) =>
			params.provider === "google-gemini-cli" && supportsGoogleGeminiCliUsage(params),
		load: memoizeUsageProvider(() => {
			const module = require("./usage/gemini") as { googleGeminiCliUsageProvider: UsageProvider };
			return module.googleGeminiCliUsageProvider;
		}),
	},
	{
		id: "anthropic",
		supports: (params: UsageFetchParams) => params.provider === "anthropic" && supportsOAuthUsage(params),
		load: memoizeUsageProvider(() => {
			const module = require("./usage/claude") as { claudeUsageProvider: UsageProvider };
			return module.claudeUsageProvider;
		}),
	},
	{
		id: "zai",
		supports: (params: UsageFetchParams) => params.provider === "zai" && params.credential.type === "api_key",
		load: memoizeUsageProvider(() => {
			const module = require("./usage/zai") as { zaiUsageProvider: UsageProvider };
			return module.zaiUsageProvider;
		}),
	},
	{
		id: "github-copilot",
		supports: supportsGithubCopilotUsage,
		load: memoizeUsageProvider(() => {
			const module = require("./usage/github-copilot") as { githubCopilotUsageProvider: UsageProvider };
			return module.githubCopilotUsageProvider;
		}),
	},
	{
		id: "grok-build",
		supports: supportsProvider("grok-build"),
		load: memoizeUsageProvider(() => {
			const module = require("./usage/grok-cli") as { grokCliUsageProvider: UsageProvider };
			return module.grokCliUsageProvider;
		}),
	},
];

const DEFAULT_USAGE_PROVIDER_DESCRIPTOR_BY_ID = new Map<Provider, UsageProviderDescriptor>(
	DEFAULT_USAGE_PROVIDER_DESCRIPTORS.map(descriptor => [descriptor.id, descriptor]),
);
const DEFAULT_USAGE_PROVIDER_CACHE = new Map<Provider, UsageProvider>();

function resolveDefaultUsageProvider(provider: Provider): UsageProvider | undefined {
	const descriptor = DEFAULT_USAGE_PROVIDER_DESCRIPTOR_BY_ID.get(provider);
	if (!descriptor) return undefined;
	const cached = DEFAULT_USAGE_PROVIDER_CACHE.get(provider);
	if (cached) return cached;
	const lazyProvider: UsageProvider = {
		id: descriptor.id,
		supports: descriptor.supports,
		fetchUsage: (params, ctx) => descriptor.load().then(loaded => loaded.fetchUsage(params, ctx)),
	};
	DEFAULT_USAGE_PROVIDER_CACHE.set(provider, lazyProvider);
	return lazyProvider;
}

const DEFAULT_RANKING_STRATEGIES = new Map<Provider, CredentialRankingStrategy>([
	[
		"openai-codex",
		{
			findWindowLimits(report) {
				const findLimit = (key: "primary" | "secondary"): UsageLimit | undefined => {
					const direct = report.limits.find(limit => limit.id === `openai-codex:${key}`);
					if (direct) return direct;
					const byId = report.limits.find(limit => limit.id.toLowerCase().includes(key));
					if (byId) return byId;
					const windowId = key === "secondary" ? "7d" : "1h";
					return report.limits.find(limit => limit.scope.windowId?.toLowerCase() === windowId);
				};
				return { primary: findLimit("primary"), secondary: findLimit("secondary") };
			},
			windowDefaults: { primaryMs: 60 * 60 * 1000, secondaryMs: 7 * 24 * 60 * 60 * 1000 },
			hasPriorityBoost(primary) {
				if (!primary) return false;
				const windowId = primary.scope.windowId?.toLowerCase();
				const durationMs = primary.window?.durationMs;
				const isFiveHourWindow =
					windowId === "5h" ||
					(typeof durationMs === "number" &&
						Number.isFinite(durationMs) &&
						Math.abs(durationMs - 5 * 60 * 60 * 1000) <= 60_000);
				if (!isFiveHourWindow) return false;
				const usedFraction = primary.amount.usedFraction;
				return typeof usedFraction === "number" && Number.isFinite(usedFraction) && usedFraction === 0;
			},
		} satisfies CredentialRankingStrategy,
	],
	[
		"anthropic",
		{
			findWindowLimits(report) {
				return {
					primary: report.limits.find(limit => limit.id === "anthropic:5h"),
					secondary: report.limits.find(limit => limit.id === "anthropic:7d"),
				};
			},
			windowDefaults: { primaryMs: 5 * 60 * 60 * 1000, secondaryMs: 7 * 24 * 60 * 60 * 1000 },
		} satisfies CredentialRankingStrategy,
	],
	[
		"grok-build",
		{
			findWindowLimits(report) {
				const weekly = report.limits.find(limit => limit.id === "grok-build:weekly");
				return {
					secondary: weekly ?? report.limits.find(limit => limit.id === "grok-build:7d"),
				};
			},
			windowDefaults: { primaryMs: 5 * 60 * 60 * 1000, secondaryMs: 30 * 24 * 60 * 60 * 1000 },
		} satisfies CredentialRankingStrategy,
	],
]);

const USAGE_CACHE_PREFIX = "usage_cache:";
// 5 min stale tolerance. Anthropic / OpenAI rate-limit /usage hard at the IP
// level so we can't fetch all N credentials every cycle; with a long cache
// each credential's last-known value sticks visible while peers retry. UI
// data (5h / 7d / monthly limits) is fine being a few minutes stale.
const USAGE_REPORT_TTL_MS = 5 * 60_000;
const USAGE_LAST_GOOD_RETENTION_MS = 24 * 60 * 60_000;
/**
 * Per-credential cool-down after a usage fetch fails. While this window is
 * active we serve the last successful value to avoid dropping the credential
 * from the report; without a previous value we just return null and retry
 * on the next poll.
 */
const USAGE_FAILURE_BACKOFF_MS = 10_000;
// Bumped from 3s — Anthropic model usage retries up to 3 times with exponential backoff
// (~3.5s total worst case); a tight per-request budget aborts retries mid-cycle.
const DEFAULT_USAGE_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 10_000;
/** Maximum provider ownership window; expiry recovers a crashed process without indefinite blocking. */
const OAUTH_REFRESH_LEASE_MS = DEFAULT_OAUTH_REFRESH_TIMEOUT_MS + 5_000;

/**
 * Refresh OAuth access tokens this many ms before their stated expiry. The
 * skew exists so callers downstream of {@link AuthStorage} (stream providers,
 * usage probes, web_search) never observe a credential that is expired or
 * about to expire mid-request — there's a single rotation point and everyone
 * downstream trusts the token they receive.
 *
 * Set to 60s: comfortably absorbs request RTT + a clock-skew window without
 * triggering a refresh on every request. Provider token endpoints typically
 * mint access tokens with 30-60min lifetimes, so refreshing 60s early changes
 * the rotation cadence by <4%.
 */
const OAUTH_REFRESH_SKEW_MS = 60_000;
/**
 * Cap on the buffered credential_disabled backlog held while no handler is attached.
 * In practice the backlog is 0–N where N ≈ active providers (≤ ~20). The cap exists so
 * pathological detach-without-reattach loops can't grow memory unboundedly.
 */
const MAX_PENDING_DISABLED_EVENTS = 32;
/**
 * Cap on how many times an OAuth resolution may reload the credential store and
 * re-resolve after a failed refresh. Each retry exists to recover from a peer
 * process rotating (or replacing) the row under us, which is a bounded event:
 * the peer either published a usable credential we pick up on the next pass, or
 * it did not. Without a cap, a credential whose disable can never be applied
 * (row replaced by an account switcher, CAS predicate that can never match)
 * makes the recovery path re-issue the same failing token refresh forever.
 */
const MAX_OAUTH_RESOLUTION_RELOADS = 3;

/**
 * How long a locally failed refresh attempt pins its exact (credential id,
 * refresh token) pair as non-replayable. Within this window the memoized
 * failure is rethrown instead of dialing the token endpoint again: after an
 * ambiguous failure (timeout, lost response) the provider may have already
 * consumed the rotating refresh token, and replaying it trips refresh-token
 * reuse detection, which can revoke the whole grant family. A successful
 * rotation changes the token and therefore the key, so recovery after a
 * peer's successful refresh is never blocked by this memo.
 */
const OAUTH_REFRESH_FAILURE_REPLAY_GUARD_MS = 30_000;

/**
 * A refresh result that carries the full authority of the credential that was
 * actually refreshed: rotated tokens plus the identity metadata and MCP
 * binding of the effective (possibly guard-adopted) credential. Callers
 * persist from this shape so an adopted binding or identity is never
 * reconstructed from a stale snapshot.
 */
type RefreshedOAuthCredentials = OAuthCredentials & { mcpBinding?: MCPOAuthBinding; persistedByLease?: boolean };

/**
 * Side-table mapping a refresh failure to the refresh token that was actually
 * sent upstream, so failure recovery can distinguish "a peer rotated the row"
 * from "the guard adopted the persisted token and that token failed". Without
 * it, recovery compares the row against the caller's stale snapshot and
 * misreads its own adoption as a peer rotation. A WeakMap is used instead of
 * mutating the thrown object: providers may throw frozen/sealed errors, and
 * writing a property to those would replace the real failure with a TypeError.
 */
const attemptedRefreshTokens = new WeakMap<object, string>();

function tagRefreshAttempt(error: unknown, refreshToken: string): unknown {
	if (error !== null && typeof error === "object") {
		attemptedRefreshTokens.set(error, refreshToken);
	}
	return error;
}

function getAttemptedRefreshToken(error: unknown): string | undefined {
	if (error !== null && typeof error === "object") {
		return attemptedRefreshTokens.get(error);
	}
	return undefined;
}

type UsageCacheEntry<T> = {
	value: T;
	expiresAt: number;
};

interface UsageCache {
	get<T>(key: string): UsageCacheEntry<T> | undefined;
	getStale<T>(key: string): UsageCacheEntry<T> | undefined;
	set<T>(key: string, entry: UsageCacheEntry<T>): void;
	deletePrefix?(prefix: string): void;
	cleanup?(): void;
}

type UsageRequestDescriptor = {
	provider: Provider;
	credential: UsageCredential;
	baseUrl?: string;
};

export type AuthApiKeyOptions = {
	baseUrl?: string;
	modelId?: string;
	/** Select config registrations owned by one caller (for example a ModelRegistry). */
	owner?: object;
	/**
	 * Caller's cancel signal. Threaded into any broker-bound OAuth refresh so
	 * `ESC` / request abort actually kills a hung broker fetch instead of
	 * stranding the caller for `timeoutMs * (maxRetries + 1)`.
	 */
	signal?: AbortSignal;
	/** Pin selection to one stored credential instead of using round-robin/ranking. */
	credentialSelector?: AuthCredentialSelector;
	/** Prefer one stored OAuth credential while preserving quota-triggered fallback. */
	preferredCredentialSelector?: AuthCredentialSelector;
};
export type AuthCredentialSelectorKind = "id" | "email" | "account" | "project";

export interface AuthCredentialSelector {
	kind: AuthCredentialSelectorKind;
	value: string;
}

type OAuthResolutionResult = { apiKey: string; credential: OAuthCredential };

/**
 * Refreshed OAuth access plus identity metadata returned by
 * {@link AuthStorage.getOAuthAccess}. Callers that authenticate via a bearer
 * AND need the credential's identity (OpenAI code backend `chatgpt-account-id`, Google
 * `projectId`, GitHub `enterpriseUrl`) consume this shape directly; the
 * refresh slot is deliberately omitted because rotating refresh tokens never
 * leave {@link AuthStorage}.
 */
export interface OAuthAccess {
	accessToken: string;
	accountId?: string;
	email?: string;
	projectId?: string;
	enterpriseUrl?: string;
}
export interface InvalidateCredentialMatchingOptions {
	signal?: AbortSignal;
	sessionId?: string;
	owner?: object;
}

function isAbortSignalOption(
	value: InvalidateCredentialMatchingOptions | AbortSignal | undefined,
): value is AbortSignal {
	return typeof value === "object" && value !== null && "aborted" in value && "addEventListener" in value;
}

const HEALTH_CACHE_PREFIX = "account_health:v1:local:row:";
const SOURCE_HEALTH_CACHE_PREFIX = "account_health:v1:source:";
const PRESENTATION_RETENTION_MS = 24 * 60 * 60_000;

function safeUsageReport(report: UsageReport): SafeUsageReport {
	const { raw: _raw, ...safe } = report;
	return safe;
}

function scrubHealthReason(reason: unknown, secrets: readonly string[] = []): string {
	let value = (reason instanceof Error ? reason.message : String(reason)).replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
	for (const secret of secrets) {
		if (secret.length > 0) {
			value = value.split(secret).join("[redacted]");
			const escaped = [...secret].map(char => char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"));
			value = value.replace(new RegExp(escaped.join("\\s*"), "gu"), "[redacted]");
		}
	}
	value = value.replace(/bearer\s+[^\s,;]+/gi, "Bearer [redacted]");
	value = value.replace(/(api[_-]?key|token|secret|authorization)[=:]\s*[^\s,;]+/gi, "$1=[redacted]");
	value = value
		.replace(/[\x00-\x1f\x7f-\x9f]+/gu, " ")
		.replace(/[\r\n\t ]+/g, " ")
		.trim();
	if (value.length > 256) value = `${value.slice(0, 253)}...`;
	return value || "credential check failed";
}

/** Read optional broker error detail without allowing hostile objects to escape classification. */
/** @internal Tested directly because hostile accessors must preserve the original error identity. */
export function readBrokerErrorBody(error: unknown): string | undefined {
	if (error === null || (typeof error !== "object" && typeof error !== "function")) return undefined;
	try {
		if (!("body" in error)) return undefined;
		const body = (error as { body?: unknown }).body;
		return typeof body === "string" ? body : undefined;
	} catch {
		// Preserve the original provider error and its terminal behavior. A proxy or
		// throwing accessor is untrusted provider data, not a reason to replace the
		// refresh failure with an inspection error.
		throw error;
	}
}

function getUsagePlanType(report: UsageReport | null): string | undefined {
	const metadata = report?.metadata;
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
	const planType = (metadata as { planType?: unknown }).planType;
	return typeof planType === "string" ? planType.toLowerCase() : undefined;
}

function getOpenAICodexPlanPriority(report: UsageReport | null): number {
	const planType = getUsagePlanType(report);
	if (!planType) return 1;
	return planType.includes("pro") ? 0 : 2;
}

function hasOpenAICodexProPlan(report: UsageReport | null): boolean {
	return getUsagePlanType(report)?.includes("pro") === true;
}

function resolveDefaultRankingStrategy(provider: Provider): CredentialRankingStrategy | undefined {
	return DEFAULT_RANKING_STRATEGIES.get(provider);
}

function parseUsageCacheEntry<T>(raw: string): UsageCacheEntry<T> | undefined {
	try {
		const parsed = JSON.parse(raw) as { value?: T; expiresAt?: unknown };
		const expiresAt = typeof parsed.expiresAt === "number" ? parsed.expiresAt : undefined;
		if (!expiresAt || !Number.isFinite(expiresAt)) return undefined;
		return { value: parsed.value as T, expiresAt };
	} catch {
		return undefined;
	}
}

/**
 * Race `promise` against `signal`, rejecting only this caller when the signal
 * fires. The underlying promise keeps running so other awaiters on the same
 * single-flight fetch aren't punished by a peer's cancel.
 */
function raceUsageWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new Error("usage fetch aborted"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => {
			signal.removeEventListener("abort", onAbort);
			reject(new Error("usage fetch aborted"));
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

function raceCredentialRefreshWithSignal<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	message = "credential refresh aborted",
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new Error(message));
	const abort = Promise.withResolvers<never>();
	const onAbort = (): void => abort.reject(new Error(message));
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([promise, abort.promise]).finally(() => {
		signal.removeEventListener("abort", onAbort);
	});
}

function authCredentialEquals(left: AuthCredential, right: AuthCredential): boolean {
	if (left.type !== right.type) return false;
	if (left.type === "api_key") {
		return right.type === "api_key" && left.key === right.key;
	}
	if (right.type !== "oauth") return false;
	return (
		left.access === right.access &&
		left.refresh === right.refresh &&
		left.expires === right.expires &&
		left.accountId === right.accountId &&
		left.email === right.email &&
		left.projectId === right.projectId &&
		left.enterpriseUrl === right.enterpriseUrl &&
		left.mcpBinding?.resourceOrigin === right.mcpBinding?.resourceOrigin &&
		left.mcpBinding?.tokenEndpoint === right.mcpBinding?.tokenEndpoint
	);
}

function storedCredentialArraysEqual(left: StoredCredential[], right: StoredCredential[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		const leftEntry = left[index];
		const rightEntry = right[index];
		if (!leftEntry || !rightEntry) return false;
		if (leftEntry.id !== rightEntry.id) return false;
		if (!authCredentialEquals(leftEntry.credential, rightEntry.credential)) return false;
	}
	return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage Cache (backed by AuthCredentialStore)
// ─────────────────────────────────────────────────────────────────────────────

class AuthStorageUsageCache implements UsageCache {
	constructor(private store: AuthCredentialStore) {}

	get<T>(key: string): UsageCacheEntry<T> | undefined {
		const raw = this.store.getCache(`${USAGE_CACHE_PREFIX}${key}`);
		if (!raw) return undefined;
		return parseUsageCacheEntry<T>(raw);
	}

	getStale<T>(key: string): UsageCacheEntry<T> | undefined {
		const raw = this.store.getCache(`${USAGE_CACHE_PREFIX}${key}`, { includeExpired: true });
		if (!raw) return undefined;
		return parseUsageCacheEntry<T>(raw);
	}

	set<T>(key: string, entry: UsageCacheEntry<T>): void {
		const payload = JSON.stringify({ value: entry.value, expiresAt: entry.expiresAt });
		const durableExpiresAt =
			entry.value === null ? entry.expiresAt : Math.max(entry.expiresAt, Date.now() + USAGE_LAST_GOOD_RETENTION_MS);
		this.store.setCache(`${USAGE_CACHE_PREFIX}${key}`, payload, Math.floor(durableExpiresAt / 1000));
	}

	deletePrefix(prefix: string): void {
		this.store.deleteCachePrefix?.(`${USAGE_CACHE_PREFIX}${prefix}`);
	}

	cleanup(): void {
		this.store.cleanExpiredCache();
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory representation
// ─────────────────────────────────────────────────────────────────────────────

type StoredCredential = { id: number; credential: AuthCredential; revision?: number };
type IndexedStoredCredential<T extends AuthCredential = AuthCredential> = {
	id: number;
	credential: T;
	index: number;
	revision?: number;
};
type OAuthCredentialSelection = IndexedStoredCredential<OAuthCredential>;
type ConfigApiKeyRegistration = { apiKey: string; envSourced: boolean; order: number };

// ─────────────────────────────────────────────────────────────────────────────
// AuthStorage Class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Credential storage backed by an AuthCredentialStore.
 * Reads from storage on reload(), manages round-robin credential selection,
 * usage limit tracking, and OAuth token refresh.
 */
export class AuthStorage {
	static readonly #defaultBackoffMs = 60_000; // Default backoff when no reset time available

	/** Provider -> credentials cache, populated from store on reload(). */
	#data: Map<string, StoredCredential[]> = new Map();
	#runtimeOverrides: Map<string, string> = new Map();
	#configOverrides: Map<string, string> = new Map();
	/** Effective config override registrations, including owner-scoped model registries. */
	#configOverrideRegistrations: Map<string, Map<object, ConfigApiKeyRegistration>> = new Map();
	#unownedConfigOverrides: Map<string, ConfigApiKeyRegistration> = new Map();
	#configOverrideOrder = 0;
	/**
	 * Providers whose config override was resolved from a models.yml `apiKeyEnv`
	 * indirection rather than a literal `apiKey` pin. An env pointer is not a
	 * pinned secret: the pointed-to value (shell env, trusted env files) can go
	 * stale silently, and the 401 rotation machinery cannot repair it. A stored
	 * api_key credential from `auth login` therefore outranks it.
	 */
	#configOverrideEnvSourced: Set<string> = new Set();
	#runtimeCredentialSelectors: Map<string, AuthCredentialSelector> = new Map();
	/** Soft runtime credential preference per provider; quota failures may rotate away from it. */
	#runtimePreferredCredentialSelectors: Map<string, AuthCredentialSelector> = new Map();
	/** Credential selectors explicitly attached to a credential session scope. */
	#sessionCredentialSelectors: Map<string, Map<string, AuthCredentialSelector>> = new Map();
	/** Explicit AUTO masks suppress both scoped and process-global selectors for a scope/provider. */
	#sessionCredentialAutoMasks: Map<string, Set<string>> = new Map();
	/** Reference counts for sessions sharing one credential scope (top-level + subagents). */
	#credentialScopeLeases: Map<string, number> = new Map();
	/** Tracks next credential index per provider:type key for round-robin distribution (non-session use). */
	#providerRoundRobinIndex: Map<string, number> = new Map();
	/** Tracks the last used credential per provider for a session (used for rate-limit switching). */
	#sessionLastCredential: Map<string, Map<string, { type: AuthCredential["type"]; index: number }>> = new Map();
	/** Maps provider:type -> credentialIndex -> blockedUntilMs for temporary backoff. */
	#credentialBackoff: Map<string, Map<number, number>> = new Map();
	#usageProviderResolver?: (provider: Provider) => UsageProvider | undefined;
	#rankingStrategyResolver?: (provider: Provider) => CredentialRankingStrategy | undefined;
	#usageCache: UsageCache;
	#usageRequestInFlight: Map<string, Promise<UsageReport | null>> = new Map();
	#usageReportsInFlight: Map<string, Promise<UsageReport[] | null>> = new Map();
	#usageFetch: typeof fetch;
	#usageRequestTimeoutMs: number;
	#credentialRankingMode: CredentialRankingMode = "balanced";
	#usageLogger?: UsageLogger;
	#fallbackResolver?: (provider: string) => string | undefined;
	#ownedFallbackResolvers: Map<object, (provider: string) => string | undefined> = new Map();
	#store: AuthCredentialStore;
	#configValueResolver: (config: string, cacheScope?: string) => Promise<string | undefined>;
	#resolvedStoredApiKeyValues: Map<string, Map<string, { fingerprint: string; usable: boolean }>> = new Map();
	#storedApiKeyResolutionInFlight: Map<string, Map<string, Promise<string | undefined>>> = new Map();
	#refreshOAuthCredentialOverride?: AuthStorageOptions["refreshOAuthCredential"];
	#fetchUsageReportsOverride?: AuthStorageOptions["fetchUsageReports"];
	#fetchUsageReportsForProviderOverride?: AuthStorageOptions["fetchUsageReportsForProvider"];
	#sourceLabel?: string;
	#credentialDisabledListeners: Set<(event: CredentialDisabledEvent) => void | Promise<void>> = new Set();
	/**
	 * Buffer for credential_disabled events fired while no listener is subscribed.
	 * Drained (in insertion order) to the first listener that triggers the empty→non-empty
	 * transition via {@link AuthStorage.onCredentialDisabled}. Bounded at
	 * {@link MAX_PENDING_DISABLED_EVENTS}; oldest entries are dropped to keep memory predictable
	 * if a long-lived AuthStorage somehow accumulates a backlog (provider count is naturally small,
	 * but a process that runs without subscribers for a long time shouldn't grow this unboundedly).
	 */
	#pendingDisabledEvents: CredentialDisabledEvent[] = [];
	#generation = 1;
	#providerGenerations = new Map<string, number>();
	#providerConfigurationGenerations = new Map<string, number>();
	#providerOAuthRefreshGenerations = new Map<string, number>();
	#generationListeners: Set<(generation: number) => void> = new Set();
	#oauthRefreshInFlight: Map<number, Promise<AuthCredentialSnapshotEntry>> = new Map();
	#oauthCredentialRefreshInFlight: Map<number, Promise<RefreshedOAuthCredentials>> = new Map();
	/**
	 * Locally failed refresh attempts keyed by `${credentialId}:${refreshToken}`.
	 * See {@link OAUTH_REFRESH_FAILURE_REPLAY_GUARD_MS}.
	 */
	#recentOAuthRefreshFailures = new Map<string, { expiresAt: number; error: unknown }>();
	#oauthRefreshLeaseOwner = crypto.randomUUID();

	#closed = false;

	constructor(store: AuthCredentialStore, options: AuthStorageOptions = {}) {
		this.#store = store;
		store.onSnapshotChanged?.(() => {
			this.#reloadCredentialRowsFromStore();
			void this.reload();
		});
		this.#configValueResolver = options.configValueResolver ?? defaultConfigValueResolver;
		this.#usageProviderResolver = options.usageProviderResolver ?? resolveDefaultUsageProvider;
		this.#rankingStrategyResolver = options.rankingStrategyResolver ?? resolveDefaultRankingStrategy;
		this.#usageCache = new AuthStorageUsageCache(this.#store);
		this.#usageFetch = options.usageFetch ?? fetch;
		this.#usageRequestTimeoutMs = options.usageRequestTimeoutMs ?? DEFAULT_USAGE_REQUEST_TIMEOUT_MS;
		this.#credentialRankingMode = options.credentialRankingMode ?? "balanced";
		this.#refreshOAuthCredentialOverride = options.refreshOAuthCredential;
		this.#fetchUsageReportsOverride = options.fetchUsageReports;
		this.#fetchUsageReportsForProviderOverride = options.fetchUsageReportsForProvider;
		this.#sourceLabel = options.sourceLabel;
		if (options.onCredentialDisabled) {
			// Constructor-registered subscribers are permanent for this AuthStorage's lifetime;
			// the unsubscribe handle is intentionally discarded.
			this.onCredentialDisabled(options.onCredentialDisabled);
		}
		this.#usageLogger =
			options.usageLogger ??
			({
				debug: (message, meta) => logger.debug(message, meta),
				warn: (message, meta) => logger.warn(message, meta),
			} satisfies UsageLogger);
	}

	/**
	 * Create an AuthStorage instance backed by a AuthCredentialStore.
	 * Convenience factory for standalone use (e.g., pi-ai CLI).
	 * @param dbPath - Path to SQLite database
	 */
	static async create(dbPath: string, options: AuthStorageOptions = {}): Promise<AuthStorage> {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		const storage = new AuthStorage(store, options);
		await storage.reload();
		return storage;
	}

	/**
	 * Close the underlying credential store.
	 *
	 * After calling this, the instance must not be reused.
	 */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#credentialScopeLeases.clear();
		this.#sessionCredentialSelectors.clear();
		this.#sessionCredentialAutoMasks.clear();
		this.#sessionLastCredential.clear();
		this.#store.close();
	}

	getGeneration(): number {
		return this.#generation;
	}
	getCache(key: string, options?: { includeExpired?: boolean }): string | null {
		return this.#store.getCache(key, options);
	}
	setCache(key: string, value: string, expiresAtSec: number): void {
		this.#store.setCache(key, value, expiresAtSec);
	}
	allocateMonotonicSequence(key: string, expiresAtSec: number): number {
		return this.#store.allocateMonotonicSequence(key, expiresAtSec);
	}
	getProviderConfigurationGeneration(provider: string): number {
		return this.#getProviderConfigurationGeneration(provider);
	}
	getProviderOAuthRefreshGeneration(provider: string): number {
		return this.#providerOAuthRefreshGenerations.get(resolveOAuthStorageProvider(provider)) ?? 0;
	}
	#getProviderGeneration(provider: string): number {
		return this.#providerGenerations.get(resolveOAuthStorageProvider(provider)) ?? 1;
	}
	#getProviderConfigurationGeneration(provider: string): number {
		return this.#providerConfigurationGenerations.get(resolveOAuthStorageProvider(provider)) ?? 1;
	}
	#configOverrideRegistration(provider: string, owner?: object): ConfigApiKeyRegistration | undefined {
		const storageProvider = resolveOAuthStorageProvider(provider);
		if (owner) {
			return (
				this.#configOverrideRegistrations.get(storageProvider)?.get(owner) ??
				this.#unownedConfigOverrides.get(storageProvider)
			);
		}
		const apiKey = this.#configOverrides.get(storageProvider);
		return apiKey === undefined
			? undefined
			: { apiKey, envSourced: this.#configOverrideEnvSourced.has(storageProvider), order: 0 };
	}
	#hasConfigOverride(provider: string, owner?: object): boolean {
		return this.#configOverrideRegistration(provider, owner) !== undefined;
	}
	getProviderEvidenceGeneration(provider: string, resolvedApiKey?: string, owner?: object): string {
		const storageProvider = resolveOAuthStorageProvider(provider);
		provider = storageProvider;
		const evidenceApiKey = resolvedApiKey;
		const configOverride = this.#configOverrideRegistration(storageProvider, owner);
		const storedLiteral =
			evidenceApiKey === undefined || this.#runtimeOverrides.has(storageProvider) || configOverride !== undefined
				? undefined
				: this.#getCredentialsForProvider(storageProvider).find(
						(credential): credential is Extract<AuthCredential, { type: "api_key" }> =>
							credential.type === "api_key" &&
							credential.key === evidenceApiKey &&
							!credential.key.startsWith("!") &&
							process.env[credential.key] === undefined,
					);
		if (storedLiteral) {
			return crypto
				.createHash("sha256")
				.update(`stored-literal\u0000${storageProvider}\u0000${storedLiteral.key}`)
				.digest("hex");
		}
		let selectedCredential: ({ index: number } & StoredCredential) | undefined;
		try {
			selectedCredential = this.#resolveSelectedStoredCredential(provider, owner ? { owner } : undefined, undefined);
		} catch {
			return crypto
				.createHash("sha256")
				.update(`${this.#getProviderGeneration(storageProvider)}\u0000unavailable-selector`)
				.digest("hex");
		}
		const credentials = selectedCredential
			? [selectedCredential.credential]
			: this.#getCredentialsForProvider(provider);
		const hasApiKey = credentials.some(credential => credential.type === "api_key");
		const hasUsableOAuth = credentials.some(
			credential =>
				credential.type === "oauth" && Number.isFinite(credential.expires) && credential.expires > Date.now(),
		);
		const effectiveEnvKey =
			this.#runtimeOverrides.get(provider) || configOverride?.apiKey || hasApiKey || hasUsableOAuth
				? undefined
				: getEnvApiKey(provider);
		const storedApiKeyFingerprint = credentials
			.filter(
				(credential): credential is Extract<AuthCredential, { type: "api_key" }> => credential.type === "api_key",
			)
			.map(credential => {
				const resolved = this.#resolvedStoredApiKeyValues.get(storageProvider)?.get(credential.key);
				return `${credential.key}\u0000${
					credential.key.startsWith("!")
						? (resolved?.fingerprint ?? "")
						: (process.env[credential.key] ?? credential.key)
				}`;
			})
			.join("\u0001");
		const storedOAuthFingerprint = credentials
			.filter((credential): credential is Extract<AuthCredential, { type: "oauth" }> => credential.type === "oauth")
			.map(credential => `${credential.expires}\u0000${credential.expires > Date.now() ? "usable" : "expired"}`)
			.join("\u0001");
		return crypto
			.createHash("sha256")
			.update(
				`${this.#getProviderGeneration(storageProvider)}\u0000${effectiveEnvKey ?? ""}\u0000${storedApiKeyFingerprint}\u0000${storedOAuthFingerprint}\u0000${evidenceApiKey ?? ""}`,
			)
			.digest("hex");
	}
	onGenerationChanged(listener: (generation: number) => void): () => void {
		this.#generationListeners.add(listener);
		return () => {
			this.#generationListeners.delete(listener);
		};
	}

	offGenerationChanged(listener: (generation: number) => void): void {
		this.#generationListeners.delete(listener);
	}

	#bumpGeneration(reason: string, provider?: string): void {
		this.#generation += 1;
		if (provider) {
			const storageProvider = resolveOAuthStorageProvider(provider);
			this.#providerGenerations.set(storageProvider, this.#getProviderGeneration(storageProvider) + 1);
			if (reason !== "stored-api-key-usability") {
				this.#providerConfigurationGenerations.set(
					storageProvider,
					this.#getProviderConfigurationGeneration(storageProvider) + 1,
				);
			}
		}
		for (const listener of [...this.#generationListeners]) {
			try {
				listener(this.#generation);
			} catch (error) {
				logger.debug("AuthStorage generation listener failed", { reason, error: String(error) });
			}
		}
	}

	/**
	 * Subscribe to {@link CredentialDisabledEvent}s. Multiple subscribers are supported and
	 * each fires for every disable event; subscribers are invoked in registration order with
	 * exceptions and async rejections isolated per-listener so a misbehaving subscriber
	 * cannot break the disable path or starve the rest of the chain.
	 *
	 * If `credential_disabled` events were emitted while no listener was subscribed, they are
	 * replayed (in insertion order) to the listener that triggers the empty→non-empty
	 * transition. The drain is one-shot — listeners that subscribe after that no longer see
	 * past events.
	 *
	 * Returns an unsubscribe function. The function is idempotent: calling it more than once
	 * is a no-op. After every subscriber has unsubscribed, subsequent disable events buffer
	 * again until the next subscribe.
	 *
	 * @param listener Callback invoked with each disable event. May be sync or async.
	 * @returns A function that removes this listener from the subscriber set.
	 */
	onCredentialDisabled(listener: (event: CredentialDisabledEvent) => void | Promise<void>): () => void {
		const wasEmpty = this.#credentialDisabledListeners.size === 0;
		this.#credentialDisabledListeners.add(listener);
		if (wasEmpty && this.#pendingDisabledEvents.length > 0) {
			const drained = this.#pendingDisabledEvents;
			this.#pendingDisabledEvents = [];
			for (const event of drained) {
				this.#invokeListener(listener, event);
			}
		}
		return () => {
			this.#credentialDisabledListeners.delete(listener);
		};
	}

	/**
	 * Set a runtime API key override (not persisted to disk).
	 * Used for CLI --api-key flag.
	 */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		const storageProvider = resolveOAuthStorageProvider(provider);
		if (this.#runtimeOverrides.get(storageProvider) === apiKey) return;
		this.#runtimeOverrides.set(storageProvider, apiKey);
		this.#bumpGeneration("set-runtime-api-key", storageProvider);
	}

	/**
	 * Pin credential selection for a provider (not persisted to disk).
	 * Used for CLI --credential.
	 */
	setRuntimeCredentialSelector(provider: string, selector: AuthCredentialSelector): void {
		const storageProvider = resolveOAuthStorageProvider(provider);
		if (this.#runtimePreferredCredentialSelectors.has(storageProvider)) {
			throw new Error(`Credential selector cannot be combined with a preferred credential selector for ${provider}`);
		}
		this.#assertCredentialSelectorUsable(storageProvider, selector);
		this.#runtimeCredentialSelectors.set(storageProvider, selector);
		this.#bumpGeneration("set-runtime-credential-selector", provider);
	}

	/** Acquire a reference-counted credential scope for a session or shared subagent scope. */
	acquireCredentialScope(scopeId: string): void {
		const scope = scopeId.trim();
		if (!scope) throw new Error("Credential scope id must not be empty");
		this.#credentialScopeLeases.set(scope, (this.#credentialScopeLeases.get(scope) ?? 0) + 1);
	}

	/** Whether a credential scope already has at least one live owner. */
	hasCredentialScopeLease(scopeId: string): boolean {
		const scope = scopeId.trim();
		return scope.length > 0 && (this.#credentialScopeLeases.get(scope) ?? 0) > 0;
	}

	/** Release one credential-scope lease; final release clears only that scope's derived state. */
	releaseCredentialScope(scopeId: string): void {
		const scope = scopeId.trim();
		if (!scope) return;
		const leases = this.#credentialScopeLeases.get(scope);
		if (leases === undefined) return;
		if (leases > 1) {
			this.#credentialScopeLeases.set(scope, leases - 1);
			return;
		}
		this.#credentialScopeLeases.delete(scope);
		this.#sessionCredentialSelectors.delete(scope);
		this.#sessionCredentialAutoMasks.delete(scope);
		for (const [provider, sessions] of this.#sessionLastCredential) {
			if (!sessions.delete(scope)) continue;
			if (sessions.size === 0) this.#sessionLastCredential.delete(provider);
		}
	}

	/**
	 * Set the selector derived from a durable session pin or a session seed.
	 * `owner` scopes config-override validation to one ModelRegistry; omitted
	 * owners retain process-wide caller semantics.
	 */
	setSessionCredentialSelector(
		scopeId: string,
		provider: string,
		selector: AuthCredentialSelector,
		owner?: object,
	): void {
		const scope = scopeId.trim();
		if (!scope) throw new Error("Credential scope id must not be empty");
		const storageProvider = resolveOAuthStorageProvider(provider);
		this.#assertCredentialSelectorUsable(storageProvider, selector, owner);
		const selectors = this.#sessionCredentialSelectors.get(scope) ?? new Map<string, AuthCredentialSelector>();
		selectors.set(storageProvider, selector);
		this.#sessionCredentialSelectors.set(scope, selectors);
		this.#sessionCredentialAutoMasks.get(scope)?.delete(storageProvider);
		this.#bumpGeneration("set-session-credential-selector", storageProvider);
	}

	/** Explicitly mask persistent/process-global selection and return the provider to AUTO for one scope. */
	setSessionCredentialAuto(provider: string, scopeId: string): void {
		const scope = scopeId.trim();
		if (!scope) throw new Error("Credential scope id must not be empty");
		const storageProvider = resolveOAuthStorageProvider(provider);
		this.#sessionCredentialSelectors.get(scope)?.delete(storageProvider);
		const masks = this.#sessionCredentialAutoMasks.get(scope) ?? new Set<string>();
		masks.add(storageProvider);
		this.#sessionCredentialAutoMasks.set(scope, masks);
		this.#bumpGeneration("set-session-credential-auto", storageProvider);
	}

	/** Clear a scope's explicit selector and AUTO mask, restoring normal precedence. */
	clearSessionCredentialSelector(provider: string, scopeId: string): void {
		const scope = scopeId.trim();
		if (!scope) return;
		const storageProvider = resolveOAuthStorageProvider(provider);
		const selectors = this.#sessionCredentialSelectors.get(scope);
		const masks = this.#sessionCredentialAutoMasks.get(scope);
		const changed = Boolean(selectors?.delete(storageProvider) || masks?.delete(storageProvider));
		if (selectors?.size === 0) this.#sessionCredentialSelectors.delete(scope);
		if (masks?.size === 0) this.#sessionCredentialAutoMasks.delete(scope);
		if (changed) this.#bumpGeneration("clear-session-credential-selector", storageProvider);
	}

	/** Whether the effective selection for a scope is explicitly pinned (AUTO masks are not pins). */
	hasSessionCredentialSelector(provider: string, scopeId?: string): boolean {
		if (!scopeId) return false;
		return this.#getCredentialSelector(provider, undefined, scopeId) !== undefined;
	}

	/** Whether this scope explicitly masks provider pins and uses AUTO ranking. */
	hasSessionCredentialAuto(provider: string, scopeId?: string): boolean {
		if (!scopeId) return false;
		return this.#sessionCredentialAutoMasks.get(scopeId)?.has(resolveOAuthStorageProvider(provider)) === true;
	}

	/** Resolve the effective selector precedence for a provider/scope. */
	resolveEffectiveCredentialSelector(
		provider: string,
		scopeId?: string,
		explicitSelector?: AuthCredentialSelector,
	): AuthCredentialSelector | undefined {
		return this.#getCredentialSelector(
			provider,
			explicitSelector ? { credentialSelector: explicitSelector } : undefined,
			scopeId,
		);
	}

	/** @internal Return cache provenance for an exact stored literal API-key row without resolving its value. */
	getStoredLiteralApiKeyEvidenceGeneration(
		provider: string,
		selector: AuthCredentialSelector,
		owner?: object,
	): string | undefined {
		if (selector.kind !== "id") return undefined;
		const storageProvider = resolveOAuthStorageProvider(provider);
		if (this.#runtimeOverrides.has(storageProvider) || this.#hasConfigOverride(storageProvider, owner))
			return undefined;
		const selected = this.#findCredentialBySelector(storageProvider, selector);
		if (selected?.credential.type !== "api_key") return undefined;
		const key = selected.credential.key;
		if (!key || key.startsWith("!") || process.env[key] !== undefined) return undefined;
		return this.getProviderEvidenceGeneration(storageProvider, key, owner);
	}

	/**
	 * Validate and canonicalize an OAuth-only selector for account pinning.
	 * `owner` scopes config-override checks to one ModelRegistry; omitted owners
	 * retain process-wide caller semantics.
	 */
	resolveOAuthPinTarget(provider: string, selector: AuthCredentialSelector, owner?: object): OAuthPinTarget {
		const storageProvider = resolveOAuthStorageProvider(provider);
		if (
			this.#runtimeOverrides.has(storageProvider) ||
			this.#hasConfigOverride(storageProvider, owner) ||
			getEnvApiKey(storageProvider)
		) {
			throw new OAuthCredentialSelectorError(
				"override-active",
				storageProvider,
				selector,
				`Credential selector ${this.#formatCredentialSelector(selector)} cannot be used for ${storageProvider} while an API-key override is active; remove the override or choose AUTO`,
			);
		}
		const allRows = this.#store.listCredentialInventory?.(storageProvider) ?? [];
		const matchingCredentials = this.#getStoredCredentials(storageProvider).filter(entry =>
			this.#credentialMatchesSelector(entry, selector),
		);
		const matchingIds = new Set(matchingCredentials.map(entry => entry.id));
		const matchingRows = allRows.filter(
			row => matchingIds.has(row.id) && !row.disabled && row.credentialKind === "oauth",
		);
		if (matchingRows.length === 0) {
			const providerRows = allRows.filter(row => row.provider === storageProvider);
			if (
				selector.kind === "id" &&
				providerRows.some(row => String(row.id) === selector.value && row.credentialKind === "api_key")
			) {
				throw new OAuthCredentialSelectorError(
					"api-key-row",
					storageProvider,
					selector,
					`Credential ${selector.value} is an API-key row and cannot be pinned; choose an OAuth account`,
				);
			}
			if (providerRows.length > 0 && providerRows.every(row => row.credentialKind === "api_key")) {
				throw new OAuthCredentialSelectorError(
					"api-key-provider",
					storageProvider,
					selector,
					`Provider ${storageProvider} has no OAuth credentials to pin`,
				);
			}
			const disabled = providerRows.find(
				row => row.disabled && this.#credentialMatchesInventorySelector(row, selector),
			);
			if (disabled) {
				throw new OAuthCredentialSelectorError(
					"disabled",
					storageProvider,
					selector,
					`Credential ${this.#formatCredentialSelector(selector)} is disabled${disabled.disabledCause ? `: ${disabled.disabledCause}` : ""}; run /login ${storageProvider} or choose an active account`,
				);
			}
			throw new OAuthCredentialSelectorError(
				"not-found",
				storageProvider,
				selector,
				`No active OAuth credential found for ${storageProvider} matching ${this.#formatCredentialSelector(selector)}; run /login ${storageProvider} or choose AUTO`,
			);
		}
		if (matchingRows.length > 1) {
			throw new OAuthCredentialSelectorError(
				"ambiguous",
				storageProvider,
				selector,
				`Selector ${this.#formatCredentialSelector(selector)} matches multiple OAuth credentials; choose id:<row-id>`,
				matchingRows.map(row => row.id),
			);
		}
		const target = matchingRows[0];
		if (!target || target.disabled || target.credentialKind !== "oauth") {
			throw new OAuthCredentialSelectorError(
				"disabled",
				storageProvider,
				selector,
				`Credential ${this.#formatCredentialSelector(selector)} is not an active OAuth credential; choose an active account`,
			);
		}
		return { credentialId: target.id, canonicalSelector: { kind: "id", value: String(target.id) } };
	}

	/** Return all local inventory rows, including soft-disabled metadata, without payloads. */
	listCredentialInventory(provider?: string): CredentialInventoryRecord[] {
		return this.#store.listCredentialInventory?.(provider) ?? [];
	}

	/** Return local credential hard-removal action targets, including disabled rows. */
	listCredentialRemovalTargets(provider?: string): CredentialRemovalTarget[] {
		return this.#store.listCredentialRemovalTargets?.(provider) ?? [];
	}

	/** Remove selected local credential rows atomically; conflict leaves all rows intact. */
	removeAuthCredentialsHard(
		provider: string,
		targets: readonly CredentialRemovalTarget[],
	): AuthCredentialHardRemovalResult {
		const storageProvider = resolveOAuthStorageProvider(provider);
		const result = this.#store.removeAuthCredentialsHard?.(storageProvider, targets) ?? {
			kind: "conflict",
			currentIds: [],
		};
		if (result.kind !== "removed") return result;
		const removed = new Set(result.ids);
		const previousEntries = this.#getStoredCredentials(storageProvider);
		const entries = previousEntries.filter(entry => !removed.has(entry.id));
		this.#setStoredCredentials(storageProvider, entries);
		this.#usageRequestInFlight.clear();
		this.#usageReportsInFlight.clear();
		this.#usageCache.deletePrefix?.(`report:${storageProvider}:`);
		for (const [scopeId, selectors] of this.#sessionCredentialSelectors) {
			const selector = selectors.get(storageProvider);
			const selected = selector
				? previousEntries.find(entry => this.#credentialMatchesSelector(entry, selector))
				: undefined;
			if (selected && removed.has(selected.id)) this.clearSessionCredentialSelector(storageProvider, scopeId);
		}
		for (const [sessionId, sticky] of this.#sessionLastCredential.get(storageProvider) ?? []) {
			if (removed.has(previousEntries[sticky.index]?.id ?? -1))
				this.#clearSessionCredential(storageProvider, sessionId);
		}
		this.#resetProviderAssignments(storageProvider);
		return result;
	}
	/**
	 * Remove a runtime credential selector.
	 */
	removeRuntimeCredentialSelector(provider: string): void {
		const storageProvider = resolveOAuthStorageProvider(provider);
		if (this.#runtimeCredentialSelectors.delete(storageProvider)) {
			this.#bumpGeneration("remove-runtime-credential-selector", provider);
		}
	}

	/** Whether a provider currently has a soft runtime credential preference. */
	hasRuntimePreferredCredentialSelector(provider: string): boolean {
		return this.#runtimePreferredCredentialSelectors.has(resolveOAuthStorageProvider(provider));
	}

	/** Resolve an unqualified preferred selector to the single active OAuth provider it matches. */
	resolveRuntimePreferredCredentialSelectorProvider(selector: AuthCredentialSelector): string {
		const providers = [...this.#data.entries()]
			.filter(([, entries]) =>
				entries.some(
					entry => entry.credential.type === "oauth" && this.#credentialMatchesSelector(entry, selector),
				),
			)
			.map(([provider]) => provider);
		if (providers.length === 0) {
			throw new Error(`No active credential found matching ${this.#formatCredentialSelector(selector)}`);
		}
		if (providers.length > 1) {
			throw new Error(
				`Preferred credential selector ${this.#formatCredentialSelector(selector)} matches multiple providers; use provider/${this.#formatCredentialSelector(selector)}`,
			);
		}
		return providers[0]!;
	}

	/**
	 * Prefer one stored OAuth credential for a provider while retaining quota
	 * fallback to the rest of the pool (not persisted to disk). Used for CLI
	 * `--prefer-credential`. Unlike {@link setRuntimeCredentialSelector}, a
	 * quota/rate-limit failure on the preferred row still rotates to another
	 * active credential instead of failing the session.
	 */
	setRuntimePreferredCredentialSelector(provider: string, selector: AuthCredentialSelector): void {
		const storageProvider = resolveOAuthStorageProvider(provider);
		if (this.#runtimeCredentialSelectors.has(storageProvider)) {
			throw new Error(`Preferred credential selector cannot be combined with a credential selector for ${provider}`);
		}
		this.#assertPreferredCredentialSelectorUsable(storageProvider, selector);
		const existing = this.#runtimePreferredCredentialSelectors.get(storageProvider);
		if (existing?.kind === selector.kind && existing.value === selector.value) return;
		this.#runtimePreferredCredentialSelectors.set(storageProvider, selector);
		this.#bumpGeneration("set-runtime-preferred-credential-selector", provider);
	}

	/**
	 * Remove a runtime preferred credential selector.
	 */
	removeRuntimePreferredCredentialSelector(provider: string): void {
		const storageProvider = resolveOAuthStorageProvider(provider);
		if (this.#runtimePreferredCredentialSelectors.delete(storageProvider)) {
			this.#bumpGeneration("remove-runtime-preferred-credential-selector", provider);
		}
	}

	/**
	 * Remove a runtime API key override.
	 */
	removeRuntimeApiKey(provider: string): void {
		const storageProvider = resolveOAuthStorageProvider(provider);
		if (this.#runtimeOverrides.delete(storageProvider))
			this.#bumpGeneration("remove-runtime-api-key", storageProvider);
	}

	/** Whether a provider is currently authenticated by a runtime API-key override. */
	hasRuntimeApiKey(provider: string): boolean {
		return Boolean(this.#runtimeOverrides.get(resolveOAuthStorageProvider(provider)));
	}

	/** Whether a provider is currently authenticated by a config API-key override. */
	hasConfigApiKey(provider: string, owner?: object): boolean {
		return Boolean(this.#configOverrideRegistration(provider, owner)?.apiKey);
	}

	/**
	 * Whether credential selection for a provider is pinned to one stored row by
	 * a runtime selector (`--credential`).
	 *
	 * Distinct from {@link AuthStorage.hasRuntimeApiKey}: that reports the
	 * `--api-key` override, which lives in a different map and is mutually
	 * exclusive with a selector. Callers that must not rotate away from a pinned
	 * credential have to consult BOTH.
	 */
	hasRuntimeCredentialSelector(provider: string): boolean {
		return this.#runtimeCredentialSelectors.has(resolveOAuthStorageProvider(provider));
	}

	/** Whether the effective selector for a session scope is pinned. */
	hasEffectiveCredentialSelector(provider: string, sessionId?: string): boolean {
		return this.#getCredentialSelector(provider, undefined, sessionId) !== undefined;
	}

	/**
	 * Opaque stored row id of the credential this session is currently using.
	 *
	 * Deliberately non-identifying: the persisted primary key, never an email,
	 * account id, project id, or key material. Callers that need to correlate a
	 * credential across a session boundary use this instead of projecting
	 * personal metadata.
	 *
	 * Returns `undefined` when the session has not been routed to a stored
	 * credential yet, or when it authenticated through an env key or fallback
	 * resolver rather than a stored row.
	 */
	getSessionCredentialRowId(provider: string, sessionId?: string): number | undefined {
		const storageProvider = resolveOAuthStorageProvider(provider);
		const session = this.#getSessionCredential(storageProvider, sessionId);
		if (!session) return undefined;
		return this.#getStoredCredentials(storageProvider)[session.index]?.id;
	}

	/**
	 * Force a running session's OAuth credential for a provider to a specific
	 * stored row, independent of quota/rate-limit state. Used for a mid-session
	 * `/credential <selector>` switch that has nothing to do with exhaustion —
	 * the user just wants a different account for the rest of the session.
	 *
	 * This mutates ONLY the session-scoped sticky pointer
	 * ({@link AuthStorage.#recordSessionCredential}), never a provider-wide
	 * runtime override, so it cannot bleed into other sessions in the same
	 * process whose credential identity differs. The sticky pointer is keyed by
	 * `sessionId`, and subagents/team workers inherit their parent's
	 * `credentialSessionId` by design so they keep using the same account as
	 * the parent — a switch therefore applies to the whole session family
	 * sharing that identity, not to unrelated sessions.
	 *
	 * Fails closed rather than silently no-op when a stronger override already
	 * decides this provider's credential every call: a hard pin
	 * ({@link AuthStorage.setRuntimeCredentialSelector}, `--credential`), a
	 * runtime API-key override (`--api-key`), or a config-sourced API key
	 * (`models.yml` `apiKey`) would each re-decide the credential on the very
	 * next {@link AuthStorage.getApiKey} call and make this switch appear to
	 * silently do nothing. `owner` scopes the config-override check to one
	 * ModelRegistry; omitted owners retain process-wide caller semantics.
	 *
	 * Deliberately does not touch credential-blocked state: if the target row
	 * is still backoff-blocked from a prior quota failure, the existing
	 * `#resolveOAuthSelection` ranking safely ignores this sticky pointer and
	 * falls back to a usable account instead of re-issuing a request that would
	 * just draw another 429/quota error.
	 */
	switchSessionCredential(
		provider: string,
		sessionId: string,
		selector: AuthCredentialSelector,
		owner?: object,
	): void {
		const storageProvider = resolveOAuthStorageProvider(provider);
		if (this.#runtimeOverrides.has(storageProvider)) {
			throw new Error(
				`Cannot switch credential for ${provider}: a runtime API key override (--api-key) is active and always wins`,
			);
		}
		if (this.#hasConfigOverride(storageProvider, owner)) {
			throw new Error(
				`Cannot switch credential for ${provider}: a config API key override (models.yml) is active and always wins`,
			);
		}
		if (this.#runtimeCredentialSelectors.has(storageProvider)) {
			throw new Error(
				`Cannot switch credential for ${provider}: --credential already pins this session to one stored row`,
			);
		}
		const matched = this.#findCredentialBySelector(storageProvider, selector);
		if (matched?.credential.type !== "oauth") {
			throw new Error(
				`No active OAuth credential found for ${provider} matching ${this.#formatCredentialSelector(selector)}`,
			);
		}
		this.#recordSessionCredential(storageProvider, sessionId, "oauth", matched.index);
		this.#bumpGeneration("switch-session-credential");
	}

	/**
	 * Register a per-provider API key sourced from user configuration
	 * (e.g. `models.yml` `providers.<name>.apiKey`). Higher priority than
	 * stored credentials and OAuth tokens — when the user pins a key in
	 * config, that key is what authenticates outbound requests, regardless
	 * of whatever the broker happens to have loaded for that provider.
	 *
	 * Lower priority than {@link setRuntimeApiKey} so a CLI `--api-key`
	 * still wins for the duration of a single invocation.
	 *
	 * `options.owner` scopes the override to one registry or other caller. The
	 * unscoped form is process-wide and is retained for standalone callers.
	 *
	 * `options.envSourced` marks the value as resolved from a models.yml
	 * `apiKeyEnv` indirection. Unlike a literal pin, an env pointer only says
	 * where to look for a key; when the user has since run `auth login`, the
	 * stored api_key credential is the fresher, actively-managed secret and
	 * wins over the indirection (stored OAuth credentials still yield, so a
	 * custom-endpoint bearer is never replaced by an upstream OAuth token).
	 */
	setConfigApiKey(provider: string, apiKey: string, options: { envSourced?: boolean; owner?: object } = {}): void {
		const storageProvider = resolveOAuthStorageProvider(provider);
		const registration = {
			apiKey,
			envSourced: options.envSourced === true,
			order: ++this.#configOverrideOrder,
		};
		if (options.owner) {
			const registrations = this.#configOverrideRegistrations.get(storageProvider) ?? new Map();
			registrations.set(options.owner, registration);
			this.#configOverrideRegistrations.set(storageProvider, registrations);
		} else {
			this.#unownedConfigOverrides.set(storageProvider, registration);
		}
		this.#reconcileConfigApiKey(storageProvider, "set-config-api-key", true);
	}

	/**
	 * Remove a single config-sourced API key override.
	 */
	removeConfigApiKey(provider: string, owner?: object): void {
		const storageProvider = resolveOAuthStorageProvider(provider);
		if (owner) {
			const registrations = this.#configOverrideRegistrations.get(storageProvider);
			if (!registrations?.delete(owner)) return;
			if (registrations.size === 0) this.#configOverrideRegistrations.delete(storageProvider);
		} else {
			if (!this.#unownedConfigOverrides.delete(storageProvider)) return;
		}
		this.#reconcileConfigApiKey(storageProvider, "remove-config-api-key", true);
	}

	/**
	 * Drop config-sourced API keys. An owner removes only its own registrations;
	 * the unscoped form remains an explicit global reset for callers that own the
	 * entire AuthStorage instance.
	 */
	clearConfigApiKeys(owner?: object): void {
		if (owner) {
			const providers = [...this.#configOverrideRegistrations.entries()]
				.filter(([, registrations]) => registrations.has(owner))
				.map(([provider]) => provider);
			for (const provider of providers) this.removeConfigApiKey(provider, owner);
			return;
		}
		const providers = new Set([
			...this.#configOverrides.keys(),
			...this.#unownedConfigOverrides.keys(),
			...this.#configOverrideRegistrations.keys(),
		]);
		this.#unownedConfigOverrides.clear();
		this.#configOverrideRegistrations.clear();
		for (const provider of providers) this.#reconcileConfigApiKey(provider, "clear-config-api-keys", true);
	}

	#reconcileConfigApiKey(provider: string, reason: string, forceGeneration = false): void {
		const previous = this.#configOverrides.get(provider);
		const previousEnvSourced = this.#configOverrideEnvSourced.has(provider);
		let winner: { apiKey: string; envSourced: boolean; order: number } | undefined =
			this.#unownedConfigOverrides.get(provider);
		for (const registration of this.#configOverrideRegistrations.get(provider)?.values() ?? []) {
			if (!winner || registration.order > winner.order) winner = registration;
		}
		if (!winner) {
			this.#configOverrides.delete(provider);
			this.#configOverrideEnvSourced.delete(provider);
		} else {
			this.#configOverrides.set(provider, winner.apiKey);
			if (winner.envSourced) this.#configOverrideEnvSourced.add(provider);
			else this.#configOverrideEnvSourced.delete(provider);
		}
		const current = this.#configOverrides.get(provider);
		const currentEnvSourced = this.#configOverrideEnvSourced.has(provider);
		if (forceGeneration || previous !== current || previousEnvSourced !== currentEnvSourced) {
			this.#bumpGeneration(reason, provider);
		}
	}

	/**
	 * Set a fallback resolver for API keys not found in storage or env vars.
	 * Used for custom provider keys from models.json.
	 */
	setFallbackResolver(resolver: (provider: string) => string | undefined, owner?: object): () => void {
		if (owner) {
			this.#ownedFallbackResolvers.set(owner, resolver);
			return () => {
				if (this.#ownedFallbackResolvers.get(owner) !== resolver) return;
				this.#ownedFallbackResolvers.delete(owner);
			};
		}
		this.#fallbackResolver = resolver;
		return () => {
			if (this.#fallbackResolver === resolver) this.#fallbackResolver = undefined;
		};
	}

	#resolveFallback(provider: string, owner?: object): string | undefined {
		if (owner) {
			return this.#ownedFallbackResolvers.get(owner)?.(provider) ?? this.#fallbackResolver?.(provider);
		}
		for (const resolver of [...this.#ownedFallbackResolvers.values()].reverse()) {
			const value = resolver(provider);
			if (value !== undefined) return value;
		}
		return this.#fallbackResolver?.(provider);
	}

	/**
	 * Reload credentials from storage.
	 */
	async reload(): Promise<void> {
		await this.#store.waitForReady?.();
		this.#reloadCredentialRowsFromStore();
	}

	/**
	 * Acquire a store-owned provider-admission ticket when the backing store
	 * provides one (for example, a remote broker snapshot store). Local stores
	 * need no additional ordering and return `undefined`.
	 */
	async acquireCredentialDispatchTicket(
		provider: Provider,
		signal?: AbortSignal,
	): Promise<CredentialDispatchTicket | undefined> {
		return this.#store.acquireCredentialDispatchTicket?.(resolveOAuthStorageProvider(provider), signal);
	}

	#reloadCredentialRowsFromStore(): void {
		const records = this.#store.listAuthCredentials();
		const grouped = new Map<string, StoredCredential[]>();
		for (const record of records) {
			const list = grouped.get(record.provider) ?? [];
			list.push({ id: record.id, credential: record.credential, revision: record.revision });
			grouped.set(record.provider, list);
		}

		const dedupedGrouped = new Map<string, StoredCredential[]>();
		for (const [provider, entries] of grouped.entries()) {
			const deduped = this.#pruneDuplicateStoredCredentials(provider, entries);
			if (deduped.length > 0) {
				dedupedGrouped.set(provider, deduped);
			}
		}

		const removedProviders = new Set(this.#data.keys());
		for (const [provider, entries] of dedupedGrouped) {
			this.#setStoredCredentials(provider, entries);
			removedProviders.delete(provider);
		}
		for (const provider of removedProviders) {
			this.#setStoredCredentials(provider, []);
		}
	}

	/**
	 * Gets cached credentials for a provider.
	 * @param provider - Provider name (e.g., "anthropic", "openai")
	 * @returns Array of stored credentials, empty if none exist
	 */
	#getStoredCredentials(provider: string): StoredCredential[] {
		const storageProvider = resolveOAuthStorageProvider(provider);
		return this.#data.get(storageProvider) ?? [];
	}

	/**
	 * Updates in-memory credential cache for a provider.
	 * Removes the provider entry entirely if credentials array is empty.
	 * @param provider - Provider name (e.g., "anthropic", "openai")
	 * @param credentials - Array of stored credentials to cache
	 */
	#setStoredCredentials(provider: string, credentials: StoredCredential[]): void {
		const current = this.#data.get(provider) ?? [];
		if (storedCredentialArraysEqual(current, credentials)) return;
		const identityOrderChanged =
			current.length !== credentials.length ||
			current.some(
				(entry, index) =>
					entry.id !== credentials[index]?.id || entry.credential.type !== credentials[index]?.credential.type,
			);
		this.#resolvedStoredApiKeyValues.delete(provider);
		this.#storedApiKeyResolutionInFlight.delete(provider);
		if (credentials.length === 0) {
			this.#data.delete(provider);
		} else {
			this.#data.set(provider, credentials);
		}
		if (identityOrderChanged) this.#resetProviderAssignments(resolveOAuthStorageProvider(provider));
		this.#bumpGeneration("credentials", provider);
	}

	#resolveOAuthDedupeIdentityKey(provider: string, credential: OAuthCredential): string | null {
		return resolveCredentialIdentityKey(provider, credential);
	}

	#dedupeOAuthCredentials(provider: string, credentials: AuthCredential[]): AuthCredential[] {
		const seen = new Set<string>();
		const deduped: AuthCredential[] = [];
		for (let index = credentials.length - 1; index >= 0; index -= 1) {
			const credential = credentials[index];
			if (credential.type !== "oauth") {
				deduped.push(credential);
				continue;
			}
			const identityKey = this.#resolveOAuthDedupeIdentityKey(provider, credential);
			if (!identityKey) {
				deduped.push(credential);
				continue;
			}
			if (seen.has(identityKey)) {
				continue;
			}
			seen.add(identityKey);
			deduped.push(credential);
		}
		return deduped.reverse();
	}

	#pruneDuplicateStoredCredentials(provider: string, entries: StoredCredential[]): StoredCredential[] {
		const seen = new Set<string>();
		const kept: StoredCredential[] = [];
		const removed: StoredCredential[] = [];
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];
			const credential = entry.credential;
			if (credential.type !== "oauth") {
				kept.push(entry);
				continue;
			}
			const identityKey = this.#resolveOAuthDedupeIdentityKey(provider, credential);
			if (!identityKey) {
				kept.push(entry);
				continue;
			}
			if (seen.has(identityKey)) {
				removed.push(entry);
				continue;
			}
			seen.add(identityKey);
			kept.push(entry);
		}
		if (removed.length > 0) {
			for (const entry of removed) {
				this.#store.deleteAuthCredential(entry.id, "deduplicated duplicate credential");
			}
			this.#clearSelectorsForRemovedCredential(provider, new Set(removed.map(entry => entry.id)), entries);
			this.#resetProviderAssignments(provider);
		}
		return kept.reverse();
	}

	/** Returns all credentials for a provider as an array */
	#getCredentialsForProvider(provider: string): AuthCredential[] {
		return this.#getStoredCredentials(provider).map(entry => entry.credential);
	}

	/** Composite key for round-robin tracking: "anthropic:oauth" or "openai:api_key" */
	#getProviderTypeKey(provider: string, type: AuthCredential["type"]): string {
		return `${provider}:${type}`;
	}

	/**
	 * Returns next index in round-robin sequence for load distribution.
	 * Increments stored counter and wraps at total.
	 */
	#getNextRoundRobinIndex(providerKey: string, total: number): number {
		if (total <= 1) return 0;
		const current = this.#providerRoundRobinIndex.get(providerKey) ?? -1;
		const next = (current + 1) % total;
		this.#providerRoundRobinIndex.set(providerKey, next);
		return next;
	}

	/**
	 * FNV-1a hash for deterministic session-to-credential mapping.
	 * Ensures the same session always starts with the same credential.
	 */
	#getHashedIndex(sessionId: string, total: number): number {
		if (total <= 1) return 0;
		return Bun.hash.xxHash32(sessionId) % total;
	}

	/**
	 * Returns credential indices in priority order for selection.
	 * With sessionId: starts from hashed index (consistent per session).
	 * Without sessionId: starts from round-robin index (load balancing).
	 * Order wraps around so all credentials are tried if earlier ones are blocked.
	 */
	#getCredentialOrder(providerKey: string, sessionId: string | undefined, total: number): number[] {
		if (total <= 1) return [0];
		const start = sessionId
			? this.#getHashedIndex(sessionId, total)
			: this.#getNextRoundRobinIndex(providerKey, total);
		const order: number[] = [];
		for (let i = 0; i < total; i++) {
			order.push((start + i) % total);
		}
		return order;
	}

	/** Returns block expiry timestamp for a credential, cleaning up expired entries. */
	#getCredentialBlockedUntil(providerKey: string, credentialIndex: number): number | undefined {
		const backoffMap = this.#credentialBackoff.get(providerKey);
		if (!backoffMap) return undefined;
		const blockedUntil = backoffMap.get(credentialIndex);
		if (!blockedUntil) return undefined;
		if (blockedUntil <= Date.now()) {
			backoffMap.delete(credentialIndex);
			if (backoffMap.size === 0) {
				this.#credentialBackoff.delete(providerKey);
			}
			return undefined;
		}
		return blockedUntil;
	}

	/** Checks if a credential is temporarily blocked due to usage limits. */
	#isCredentialBlocked(providerKey: string, credentialIndex: number): boolean {
		return this.#getCredentialBlockedUntil(providerKey, credentialIndex) !== undefined;
	}

	/** Marks a credential as blocked until the specified time. */
	#markCredentialBlocked(providerKey: string, credentialIndex: number, blockedUntilMs: number): void {
		const backoffMap = this.#credentialBackoff.get(providerKey) ?? new Map<number, number>();
		const existing = backoffMap.get(credentialIndex) ?? 0;
		backoffMap.set(credentialIndex, Math.max(existing, blockedUntilMs));
		this.#credentialBackoff.set(providerKey, backoffMap);
	}

	/** Records which credential was used for a session (for rate-limit switching). */
	#recordSessionCredential(
		provider: string,
		sessionId: string | undefined,
		type: AuthCredential["type"],
		index: number,
	): void {
		if (!sessionId) return;
		const sessionMap = this.#sessionLastCredential.get(provider) ?? new Map();
		sessionMap.set(sessionId, { type, index });
		this.#sessionLastCredential.set(provider, sessionMap);
	}

	/** Retrieves the last credential used by a session. */
	#getSessionCredential(
		provider: string,
		sessionId: string | undefined,
	): { type: AuthCredential["type"]; index: number } | undefined {
		if (!sessionId) return undefined;
		return this.#sessionLastCredential.get(provider)?.get(sessionId);
	}

	/** Returns the credential type selected for a provider/session, if one has been recorded. */
	getSessionCredentialType(provider: string, sessionId?: string): AuthCredential["type"] | undefined {
		return this.#getSessionCredential(resolveOAuthStorageProvider(provider), sessionId)?.type;
	}

	/** Clears the last credential used by a session for a provider. */
	#clearSessionCredential(provider: string, sessionId: string | undefined): void {
		if (!sessionId) return;
		const sessionMap = this.#sessionLastCredential.get(provider);
		if (!sessionMap) return;
		sessionMap.delete(sessionId);
		if (sessionMap.size === 0) {
			this.#sessionLastCredential.delete(provider);
		}
	}

	#formatCredentialSelector(selector: AuthCredentialSelector): string {
		return `${selector.kind}:${selector.value}`;
	}

	#credentialMatchesSelector(entry: StoredCredential, selector: AuthCredentialSelector): boolean {
		switch (selector.kind) {
			case "id":
				return String(entry.id) === selector.value;
			case "email":
				return (
					entry.credential.type === "oauth" &&
					typeof entry.credential.email === "string" &&
					entry.credential.email.toLowerCase() === selector.value.toLowerCase()
				);
			case "account":
				return entry.credential.type === "oauth" && entry.credential.accountId === selector.value;
			case "project":
				return entry.credential.type === "oauth" && entry.credential.projectId === selector.value;
		}
	}

	#findCredentialBySelector(provider: string, selector: AuthCredentialSelector): IndexedStoredCredential | undefined {
		const stored = this.#getStoredCredentials(provider);
		for (let index = 0; index < stored.length; index++) {
			const entry = stored[index];
			if (entry && this.#credentialMatchesSelector(entry, selector)) return { ...entry, index };
		}
		return undefined;
	}

	#credentialMatchesInventorySelector(row: CredentialInventoryRecord, selector: AuthCredentialSelector): boolean {
		if (row.disabled || row.credentialKind !== "oauth") return false;
		switch (selector.kind) {
			case "id":
				return String(row.id) === selector.value;
			case "email":
				return row.identityLabel?.toLowerCase() === selector.value.toLowerCase();
			case "account":
			case "project":
				return row.identityLabel === selector.value;
		}
	}
	#getCredentialSelector(
		provider: string,
		options?: AuthApiKeyOptions,
		sessionId?: string,
	): AuthCredentialSelector | undefined {
		if (options?.credentialSelector) return options.credentialSelector;
		const storageProvider = resolveOAuthStorageProvider(provider);
		if (sessionId) {
			if (this.#sessionCredentialAutoMasks.get(sessionId)?.has(storageProvider)) return undefined;
			const scoped = this.#sessionCredentialSelectors.get(sessionId)?.get(storageProvider);
			if (scoped) return scoped;
		}
		return this.#runtimeCredentialSelectors.get(storageProvider);
	}

	#getPreferredCredentialSelector(provider: string, options?: AuthApiKeyOptions): AuthCredentialSelector | undefined {
		return (
			options?.preferredCredentialSelector ??
			this.#runtimePreferredCredentialSelectors.get(resolveOAuthStorageProvider(provider))
		);
	}

	#assertCredentialSelectorUsable(provider: string, selector: AuthCredentialSelector, owner?: object): void {
		if (this.#runtimeOverrides.has(provider)) {
			throw new Error(
				`Credential selector ${this.#formatCredentialSelector(selector)} cannot be used for ${provider} while a runtime API key override is active`,
			);
		}
		if (this.#hasConfigOverride(provider, owner)) {
			throw new Error(
				`Credential selector ${this.#formatCredentialSelector(selector)} cannot be used for ${provider} while a config API key override is active`,
			);
		}
		if (!this.#findCredentialBySelector(provider, selector)) {
			throw new Error(`No credential found for ${provider} matching ${this.#formatCredentialSelector(selector)}`);
		}
	}

	/**
	 * Validates a preferred-credential selector (`--prefer-credential`). Unlike
	 * {@link AuthStorage.#assertCredentialSelectorUsable}, the match must resolve
	 * to an OAuth row specifically — the soft-preference/quota-fallback path is
	 * meaningless for a single static API key.
	 */
	#assertPreferredCredentialSelectorUsable(provider: string, selector: AuthCredentialSelector, owner?: object): void {
		if (this.#runtimeOverrides.has(provider) || this.#hasConfigOverride(provider, owner)) {
			throw new Error(
				`Preferred credential selector ${this.#formatCredentialSelector(selector)} cannot be used for ${provider} while an API key override is active`,
			);
		}
		const selected = this.#findCredentialBySelector(provider, selector);
		if (selected?.credential.type !== "oauth") {
			throw new Error(
				`No active credential found for ${provider} matching ${this.#formatCredentialSelector(selector)}`,
			);
		}
	}

	#resolveSelectedStoredCredential(
		provider: string,
		options?: AuthApiKeyOptions,
		sessionId?: string,
	): IndexedStoredCredential | undefined {
		const selector = this.#getCredentialSelector(provider, options, sessionId);
		if (!selector) return undefined;
		this.#assertCredentialSelectorUsable(resolveOAuthStorageProvider(provider), selector, options?.owner);
		const selected = this.#findCredentialBySelector(provider, selector);
		if (!selected) {
			throw new Error(`No credential found for ${provider} matching ${this.#formatCredentialSelector(selector)}`);
		}
		return selected;
	}
	/**
	 * Selects a credential of the specified type for a provider.
	 * Returns both the credential and its index in the original array (for updates/removal).
	 * Uses deterministic hashing for session stickiness and skips blocked credentials when possible.
	 */
	#selectCredentialByType<T extends AuthCredential["type"]>(
		provider: string,
		type: T,
		sessionId?: string,
		isUsable?: (credential: Extract<AuthCredential, { type: T }>, index: number) => boolean | undefined,
	): IndexedStoredCredential<Extract<AuthCredential, { type: T }>> | undefined {
		const credentials = this.#getStoredCredentials(provider)
			.map((entry, index) => ({ entry, index }))
			.filter(
				(
					item,
				): item is {
					entry: StoredCredential & { credential: Extract<AuthCredential, { type: T }> };
					index: number;
				} => item.entry.credential.type === type,
			)
			.map(({ entry, index }) => ({
				id: entry.id,
				credential: entry.credential,
				index,
				revision: entry.revision,
			}));

		if (credentials.length === 0) return undefined;

		const providerKey = this.#getProviderTypeKey(provider, type);
		const order = this.#getCredentialOrder(providerKey, sessionId, credentials.length);
		for (const idx of order) {
			const candidate = credentials[idx];
			if (
				!this.#isCredentialBlocked(providerKey, candidate.index) &&
				(isUsable === undefined || isUsable(candidate.credential, candidate.index) !== false)
			) {
				return candidate;
			}
		}

		return order
			.map(idx => credentials[idx])
			.find(candidate => isUsable === undefined || isUsable(candidate.credential, candidate.index) !== false);
	}

	#selectApiKeyCredential(
		provider: string,
		sessionId?: string,
		excludedIndices: ReadonlySet<number> = new Set(),
		includeKnownUnusable = false,
	): IndexedStoredCredential<ApiKeyCredential> | undefined {
		const credentials = this.#getStoredCredentials(provider)
			.map((entry, index) => ({ entry, index }))
			.filter(
				(item): item is { entry: StoredCredential & { credential: ApiKeyCredential }; index: number } =>
					item.entry.credential.type === "api_key",
			)
			.map(({ entry, index }) => ({ id: entry.id, credential: entry.credential, index, revision: entry.revision }));
		if (credentials.length === 0) return undefined;

		const providerKey = this.#getProviderTypeKey(provider, "api_key");
		const order = this.#getCredentialOrder(providerKey, sessionId, credentials.length);
		const ordered = order
			.map(index => credentials[index])
			.filter(entry => !excludedIndices.has(entry.index))
			.filter(
				entry => includeKnownUnusable || this.#storedApiKeyUsability(provider, entry.credential.key) !== false,
			);
		const unblocked = ordered.filter(entry => !this.#isCredentialBlocked(providerKey, entry.index));
		const candidates = unblocked.length > 0 ? unblocked : ordered;
		return candidates.sort((left, right) => {
			const usabilityRank = (credential: ApiKeyCredential): number =>
				this.#storedApiKeyUsability(provider, credential.key) === true ? 0 : 1;
			return usabilityRank(left.credential) - usabilityRank(right.credential);
		})[0];
	}

	/**
	 * Clears round-robin and session assignment state for a provider.
	 * Called when credentials are added/removed to prevent stale index references.
	 */
	#resetProviderAssignments(provider: string): void {
		for (const key of this.#providerRoundRobinIndex.keys()) {
			if (key.startsWith(`${provider}:`)) {
				this.#providerRoundRobinIndex.delete(key);
			}
		}
		this.#sessionLastCredential.delete(provider);
		for (const key of this.#credentialBackoff.keys()) {
			if (key.startsWith(`${provider}:`)) {
				this.#credentialBackoff.delete(key);
			}
		}
	}

	/** Updates a credential at index after OAuth token refresh. */
	#replaceCredentialAt(
		provider: string,
		index: number,
		credential: AuthCredential,
		persist = true,
		expectedId?: number,
	): void {
		const entries = this.#getStoredCredentials(provider);
		if (index < 0 || index >= entries.length) return;
		const target = entries[index];
		if (expectedId !== undefined && target.id !== expectedId) {
			throw new Error("Credential authority changed during refresh");
		}
		if (persist && !this.#store.refreshSnapshot) this.#store.updateAuthCredential(target.id, credential);
		const updated = [...entries];
		updated[index] = { id: target.id, credential };
		this.#setStoredCredentials(provider, updated);
		if (
			credential.type === "oauth" &&
			target.credential.type === "oauth" &&
			(credential.access !== target.credential.access ||
				credential.refresh !== target.credential.refresh ||
				credential.expires !== target.credential.expires)
		) {
			const storageProvider = resolveOAuthStorageProvider(provider);
			this.#providerOAuthRefreshGenerations.set(
				storageProvider,
				this.getProviderOAuthRefreshGeneration(storageProvider) + 1,
			);
		}
	}

	/**
	 * CAS-style disable used when OAuth refresh definitively fails: only disables
	 * persisted `data` still matches the credential we attempted to refresh.
	 * Returns `false` when a peer rotated the row between our pre-check and the
	 * disable, so the caller can reload and retry instead of clobbering the
	 * freshly-rotated credential.
	 */
	#tryDisableCredentialAtIfMatches(
		provider: string,
		index: number,
		expectedCredential: AuthCredential,
		disabledCause: string,
		expectedId?: number,
	): boolean {
		const entries = this.#getStoredCredentials(provider);
		const targetIndex = expectedId === undefined ? index : entries.findIndex(entry => entry.id === expectedId);
		if (targetIndex < 0 || targetIndex >= entries.length) return false;
		const target = entries[targetIndex];
		if (expectedId !== undefined && target.id !== expectedId) return false;
		const serialized = serializeCredential(provider, expectedCredential);
		if (!serialized) return false;
		const disabled = this.#store.tryDisableAuthCredentialIfMatches(target.id, serialized.data, disabledCause);
		if (!disabled) return false;
		const updated = entries.filter((_value, idx) => idx !== targetIndex);
		this.#setStoredCredentials(provider, updated);
		this.#clearSelectorsForRemovedCredential(provider, new Set([target.id]), entries);
		this.#resetProviderAssignments(provider);
		this.#emitCredentialDisabled({ provider, disabledCause });
		return true;
	}

	/**
	 * Whether the persisted row `credentialId` is still an OAuth credential holding
	 * `refreshToken`. Used by the refresh-failure path to tell "a peer rotated this
	 * row" (retry is worthwhile) apart from "the row is unchanged but the CAS
	 * predicate cannot match it" (retry replays the same failing refresh).
	 */
	#credentialRowHoldsRefreshToken(provider: string, credentialId: number, refreshToken: string): boolean {
		const row = this.#store.listAuthCredentials(provider).find(entry => entry.id === credentialId);
		const credential = row?.credential;
		return credential?.type === "oauth" && credential.refresh === refreshToken;
	}

	/**
	 * Soft-deletes a row by id, bypassing the data-equality CAS. Only safe when the
	 * caller has confirmed the row still holds the credential it attempted to
	 * refresh, so no peer rotation can be clobbered.
	 */
	#disableCredentialById(provider: string, credentialId: number, disabledCause: string): void {
		this.#store.deleteAuthCredential(credentialId, disabledCause);
		const entries = this.#getStoredCredentials(provider);
		this.#setStoredCredentials(
			provider,
			entries.filter(entry => entry.id !== credentialId),
		);
		this.#clearSelectorsForRemovedCredential(provider, new Set([credentialId]), entries);
		this.#resetProviderAssignments(provider);
		this.#emitCredentialDisabled({ provider, disabledCause });
	}

	/**
	 * Disable one credential through an authoritative remote store and reconcile
	 * this AuthStorage instance only after that write succeeds. Remote stores
	 * must never be mutated through the synchronous local delete path because
	 * their snapshots do not own persistence authority.
	 */
	async #disableCredentialRemotely(
		provider: string,
		credentialId: number,
		disabledCause: string,
		signal?: AbortSignal,
		expectedRevision?: number,
	): Promise<boolean> {
		const disable = this.#store.disableAuthCredentialRemote?.bind(this.#store);
		if (!disable) return false;
		const disabled = await disable(credentialId, disabledCause, signal, expectedRevision);
		if (!disabled) return false;
		const entries = this.#getStoredCredentials(provider);
		if (!entries.some(entry => entry.id === credentialId)) return true;
		this.#setStoredCredentials(
			provider,
			entries.filter(entry => entry.id !== credentialId),
		);
		this.#clearSelectorsForRemovedCredential(provider, new Set([credentialId]), entries);
		this.#resetProviderAssignments(provider);
		this.#emitCredentialDisabled({ provider, disabledCause });
		return true;
	}

	/** Clear every selector whose durable/in-memory target was just removed. */
	#clearSelectorsForRemovedCredential(
		provider: string,
		removedIds: ReadonlySet<number>,
		previousEntries: readonly StoredCredential[] = this.#getStoredCredentials(provider),
	): void {
		const storageProvider = resolveOAuthStorageProvider(provider);
		for (const [scopeId, selectors] of this.#sessionCredentialSelectors) {
			const selector = selectors.get(storageProvider);
			if (!selector) continue;
			const selected = previousEntries.find(entry => this.#credentialMatchesSelector(entry, selector));
			if (selected && removedIds.has(selected.id)) this.clearSessionCredentialSelector(storageProvider, scopeId);
		}
		for (const [sessionId, sticky] of this.#sessionLastCredential.get(storageProvider) ?? []) {
			if (removedIds.has(previousEntries[sticky.index]?.id ?? -1))
				this.#clearSessionCredential(storageProvider, sessionId);
		}
	}

	#emitCredentialDisabled(event: CredentialDisabledEvent): void {
		if (this.#credentialDisabledListeners.size === 0) {
			// No subscribers — buffer for later replay. Cap the backlog so a process that runs
			// without subscribers for a long time can't grow memory unboundedly; drop oldest
			// under pressure.
			if (this.#pendingDisabledEvents.length >= MAX_PENDING_DISABLED_EVENTS) {
				this.#pendingDisabledEvents.shift();
			}
			this.#pendingDisabledEvents.push(event);
			return;
		}
		// Snapshot before iteration so a listener that subscribes/unsubscribes during fan-out
		// can't observe a partially-mutated set or receive an event it just registered for.
		const listeners = [...this.#credentialDisabledListeners];
		for (const listener of listeners) {
			this.#invokeListener(listener, event);
		}
	}

	#invokeListener(
		listener: (event: CredentialDisabledEvent) => void | Promise<void>,
		event: CredentialDisabledEvent,
	): void {
		const logListenerError = (error: unknown): void => {
			logger.warn("onCredentialDisabled listener threw", { provider: event.provider, error: String(error) });
		};
		try {
			const result = listener(event);
			if (result && typeof (result as PromiseLike<void>).then === "function") {
				(result as Promise<void>).catch(logListenerError);
			}
		} catch (error) {
			logListenerError(error);
		}
	}

	/**
	 * Get credential for a provider (first entry if multiple).
	 */
	get(provider: string): AuthCredential | undefined {
		return this.#getCredentialsForProvider(provider)[0];
	}

	/**
	 * Set credential for a provider.
	 */
	async set(provider: string, credential: AuthCredentialEntry): Promise<void> {
		const storageProvider = resolveOAuthStorageProvider(provider);
		const normalized = Array.isArray(credential) ? credential : [credential];
		const deduped = this.#dedupeOAuthCredentials(storageProvider, normalized);
		const stored = this.#store.replaceAuthCredentialsRemote
			? await this.#store.replaceAuthCredentialsRemote(storageProvider, deduped)
			: this.#store.replaceAuthCredentialsForProvider(storageProvider, deduped);
		this.#setStoredCredentials(
			storageProvider,
			stored.map(record => ({ id: record.id, credential: record.credential, revision: record.revision })),
		);
		this.#resetProviderAssignments(storageProvider);
	}

	#toSnapshotEntries(provider: string, stored: StoredAuthCredential[]): AuthCredentialSnapshotEntry[] {
		return stored.map(entry => {
			const persisted = entry.credential;
			const redacted: SnapshotCredential =
				persisted.type === "api_key" ? persisted : { ...persisted, refresh: REMOTE_REFRESH_SENTINEL };
			return {
				id: entry.id,
				provider: entry.provider,
				credential: redacted,
				identityKey: resolveCredentialIdentityKey(provider, persisted),
				...(entry.revision === undefined ? {} : { revision: entry.revision }),
			};
		});
	}

	#snapshotSkipResult(provider: string, reason: AuthCredentialIfAbsentReason): AuthCredentialIfAbsentSnapshotResult {
		return {
			inserted: false,
			reason,
			provider,
			entries: this.exportSnapshot().credentials.filter(entry => entry.provider === provider),
		};
	}

	async importCredentialIfAbsent(
		provider: string,
		credential: AuthCredential,
		owner?: object,
	): Promise<AuthCredentialIfAbsentSnapshotResult> {
		const storageProvider = resolveOAuthStorageProvider(provider);
		if (this.#runtimeOverrides.has(storageProvider))
			return this.#snapshotSkipResult(storageProvider, "skipped-existing-runtime");
		if (this.#hasConfigOverride(storageProvider, owner))
			return this.#snapshotSkipResult(storageProvider, "skipped-existing-config");
		if (getEnvApiKey(storageProvider)) return this.#snapshotSkipResult(storageProvider, "skipped-existing-env");
		if (this.#resolveFallback(storageProvider, owner))
			return this.#snapshotSkipResult(storageProvider, "skipped-existing-fallback");

		const result = this.#store.upsertAuthCredentialRemoteIfAbsent
			? await this.#store.upsertAuthCredentialRemoteIfAbsent(storageProvider, credential)
			: this.#store.upsertAuthCredentialForProviderIfAbsent(storageProvider, credential);
		this.#setStoredCredentials(
			storageProvider,
			result.entries.map(entry => ({ id: entry.id, credential: entry.credential, revision: entry.revision })),
		);
		this.#resetProviderAssignments(storageProvider);
		if (result.inserted) this.#invalidateUsageCacheForProvider(storageProvider);
		return {
			inserted: result.inserted,
			reason: result.reason,
			provider: result.provider,
			entries: this.#toSnapshotEntries(storageProvider, result.entries),
		};
	}

	async #upsertOAuthCredential(provider: string, credential: OAuthCredential): Promise<void> {
		const stored = this.#store.upsertAuthCredentialRemote
			? await this.#store.upsertAuthCredentialRemote(provider, credential)
			: this.#store.upsertAuthCredentialForProvider(provider, credential);
		this.#setStoredCredentials(
			provider,
			stored.map(record => ({ id: record.id, credential: record.credential, revision: record.revision })),
		);
		this.#resetProviderAssignments(provider);
		this.#invalidateUsageCacheForProvider(provider);
	}

	#invalidateUsageCacheForProvider(provider: string): void {
		this.#usageRequestInFlight.clear();
		this.#usageReportsInFlight.clear();
		this.#usageCache.deletePrefix?.(`report:${provider}:`);
	}

	/**
	 * Remove credential for a provider.
	 */
	async remove(provider: string): Promise<void> {
		const storageProvider = resolveOAuthStorageProvider(provider);
		if (this.#store.deleteAuthCredentialsRemote) {
			await this.#store.deleteAuthCredentialsRemote(storageProvider, "deleted by user");
		} else {
			this.#store.deleteAuthCredentialsForProvider(storageProvider, "deleted by user");
		}
		const previousEntries = this.#getStoredCredentials(storageProvider);
		this.#setStoredCredentials(storageProvider, []);
		this.#clearSelectorsForRemovedCredential(
			storageProvider,
			new Set(previousEntries.map(entry => entry.id)),
			previousEntries,
		);
		this.#resetProviderAssignments(storageProvider);
	}

	/**
	 * List all providers with credentials.
	 */
	list(): string[] {
		return [...this.#data.keys()];
	}

	/**
	 * Check if credentials exist for a provider in storage.
	 */
	has(provider: string): boolean {
		return this.#getCredentialsForProvider(provider).length > 0;
	}

	/**
	 * Check if any form of auth is configured for a provider.
	 * Unlike getApiKey(), this doesn't refresh OAuth tokens.
	 */
	#hasConfiguredAuth(storageProvider: string, owner?: object): boolean {
		if (this.hasRuntimeApiKey(storageProvider)) return true;
		if (this.#hasConfigOverride(storageProvider, owner)) return true;
		if (this.#getCredentialsForProvider(storageProvider).length > 0) return true;
		if (getEnvApiKey(storageProvider)) return true;
		if (this.#resolveFallback(storageProvider, owner)) return true;
		return false;
	}

	disableCredentialByIdIfRevision(id: number, expectedRevision: number, disabledCause: string): boolean {
		const cause = normalizeDisabledCause(disabledCause);
		if (this.#store.tryDisableAuthCredentialIfRevision?.(id, expectedRevision, cause) !== true) return false;
		for (const [provider, entries] of this.#data) {
			if (!entries.some(entry => entry.id === id)) continue;
			this.#setStoredCredentials(
				provider,
				entries.filter(entry => entry.id !== id),
			);
			this.#clearSelectorsForRemovedCredential(provider, new Set([id]), entries);
			this.#resetProviderAssignments(provider);
			this.#emitCredentialDisabled({ provider, disabledCause: cause });
			return true;
		}
		return false;
	}

	hasAuth(provider: string, sessionId?: string, options?: Pick<AuthApiKeyOptions, "owner">): boolean {
		const storageProvider = resolveOAuthStorageProvider(provider);
		try {
			this.#resolveSelectedStoredCredential(
				storageProvider,
				options?.owner ? { owner: options.owner } : undefined,
				sessionId,
			);
		} catch {
			return false;
		}
		return this.#hasConfiguredAuth(storageProvider, options?.owner);
	}

	/**
	 * Credential type that a provider/session will dispatch first without performing I/O.
	 * Mirrors getApiKey selector validation, overrides, session OAuth stickiness,
	 * cached command-key usability, OAuth retry, and environment fallback order.
	 */
	getEffectiveCredentialType(
		provider: string,
		sessionId?: string,
		options?: Pick<AuthApiKeyOptions, "owner">,
	): AuthCredential["type"] | undefined {
		const storageProvider = resolveOAuthStorageProvider(provider);
		let selected: ({ index: number } & StoredCredential) | undefined;
		try {
			selected = this.#resolveSelectedStoredCredential(
				storageProvider,
				options?.owner ? { owner: options.owner } : undefined,
				sessionId,
			);
		} catch {
			return undefined;
		}
		if (this.hasRuntimeApiKey(storageProvider) || this.#hasConfigOverride(storageProvider, options?.owner))
			return "api_key";
		if (selected) return selected.credential.type;

		const credentials = this.#getCredentialsForProvider(storageProvider);
		const sessionCredential = this.#getSessionCredential(storageProvider, sessionId);
		if (sessionCredential?.type === "oauth" && credentials[sessionCredential.index]?.type === "oauth") return "oauth";

		const apiKeys = credentials.filter((credential): credential is ApiKeyCredential => credential.type === "api_key");
		if (apiKeys.some(credential => this.#storedApiKeyUsability(storageProvider, credential.key) !== false)) {
			return "api_key";
		}
		if (credentials.some(credential => credential.type === "oauth")) return "oauth";
		if (apiKeys.length > 0) return "api_key";
		if (getEnvApiKey(storageProvider) || this.#resolveFallback(storageProvider, options?.owner)) return "api_key";
		return undefined;
	}

	/**
	 * Check whether configured auth is currently usable without resolving credentials.
	 */
	hasUsableAuth(provider: string, options?: Pick<AuthApiKeyOptions, "owner">): boolean {
		const storageProvider = resolveOAuthStorageProvider(provider);
		try {
			const selectedCredential = this.#resolveSelectedStoredCredential(
				storageProvider,
				options?.owner ? { owner: options.owner } : undefined,
				undefined,
			);
			if (this.hasRuntimeApiKey(storageProvider)) return true;
			if (this.#hasConfigOverride(storageProvider, options?.owner)) return true;
			if (selectedCredential) {
				if (selectedCredential.credential.type === "api_key") {
					return (
						!this.#isCredentialBlocked(
							this.#getProviderTypeKey(storageProvider, selectedCredential.credential.type),
							selectedCredential.index,
						) && this.#hasUsableResolvedStoredApiKey(storageProvider, selectedCredential.credential.key)
					);
				}
				return !this.#isCredentialBlocked(
					this.#getProviderTypeKey(storageProvider, selectedCredential.credential.type),
					selectedCredential.index,
				);
			}

			const credentials = this.#getCredentialsForProvider(storageProvider);
			let hasStoredApiKey = false;
			let hasUnblockedApiKey = false;
			let hasUsableApiKey = false;
			for (const [index, credential] of credentials.entries()) {
				if (credential.type !== "api_key") continue;
				hasStoredApiKey = true;
				if (this.#isCredentialBlocked(this.#getProviderTypeKey(storageProvider, credential.type), index)) continue;
				hasUnblockedApiKey = true;
				hasUsableApiKey ||= this.#hasUsableResolvedStoredApiKey(storageProvider, credential.key);
			}
			if (hasUsableApiKey) return true;
			if (hasStoredApiKey && !hasUnblockedApiKey) return false;
			if (
				this.#getCredentialsForProvider(storageProvider).some(
					(credential, index) =>
						credential.type === "oauth" &&
						!this.#isCredentialBlocked(this.#getProviderTypeKey(storageProvider, credential.type), index),
				)
			) {
				return true;
			}
		} catch {
			return false;
		}
		return Boolean(getEnvApiKey(storageProvider) || this.#resolveFallback(storageProvider, options?.owner));
	}

	/**
	 * Check if OAuth credentials are configured for a provider.
	 */
	hasOAuth(provider: string): boolean {
		return this.#getCredentialsForProvider(provider).some(credential => credential.type === "oauth");
	}

	/**
	 * Get OAuth credentials for a provider.
	 */
	getOAuthCredential(
		provider: string,
		sessionId?: string,
		options?: Pick<AuthApiKeyOptions, "owner">,
	): OAuthCredential | undefined {
		const selected = this.#resolveSelectedStoredCredential(
			resolveOAuthStorageProvider(provider),
			options?.owner ? { owner: options.owner } : undefined,
			sessionId,
		);
		if (selected?.credential.type === "oauth") return selected.credential;
		if (selected) return undefined;
		return this.#getCredentialsForProvider(provider).find(
			(credential): credential is OAuthCredential => credential.type === "oauth",
		);
	}

	/**
	 * Get the OAuth `accountId` for a provider, preferring the credential that is
	 * session-sticky for `sessionId` when multiple OAuth credentials are configured.
	 * Falls back to the first OAuth credential when no session preference exists (e.g.
	 * first call before any `getApiKey` has been issued, or single-credential setups).
	 * Returns `undefined` when no OAuth credential carries an `accountId`.
	 */
	getOAuthAccountId(
		provider: string,
		sessionId?: string,
		options?: Pick<AuthApiKeyOptions, "owner">,
	): string | undefined {
		provider = resolveOAuthStorageProvider(provider);
		const allCredentials = this.#getCredentialsForProvider(provider);
		const oauthCredentials = allCredentials.filter((c): c is OAuthCredential => c.type === "oauth");
		if (oauthCredentials.length === 0) return undefined;

		// Runtime / config overrides bypass OAuth account_uuid attribution — the
		// caller is authenticating with an explicit key, not the broker's OAuth.
		if (this.#runtimeOverrides.has(provider) || this.#hasConfigOverride(provider, options?.owner)) return undefined;

		// Prefer the session-sticky credential when available.

		const scopedSelection = this.#resolveSelectedStoredCredential(
			provider,
			options?.owner ? { owner: options.owner } : undefined,
			sessionId,
		);
		if (scopedSelection?.credential.type === "api_key") return undefined;
		if (scopedSelection?.credential.type === "oauth") {
			const accountId = scopedSelection.credential.accountId;
			return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
		}
		const sessionPref = this.#getSessionCredential(provider, sessionId);
		// If the session has been routed to a stored API key, do not inject OAuth account_uuid.
		if (sessionPref !== undefined && sessionPref.type !== "oauth") return undefined;

		// When no session-sticky credential is recorded yet (first call before any getApiKey,
		// or all stored credentials are unavailable), the request falls through to the env-key
		// or fallback-resolver path in getApiKey() — neither is OAuth-authenticated, so
		// account_uuid injection would misattribute traffic. Only apply this guard when
		// sessionPref is absent; a recorded OAuth sticky (sessionPref.type === "oauth") must
		// NOT be blocked even if an env key also happens to exist.
		if (!sessionPref && (getEnvApiKey(provider) || this.#resolveFallback(provider, options?.owner))) return undefined;
		// Resolve the sticky index against the full credential list — the index is
		// recorded against the unfiltered provider array (by #recordSessionCredential /
		// #tryOAuthCredential), not the OAuth-only subset, so dereferencing it into the
		// filtered array would be off-by-N when any non-OAuth credential precedes the
		// OAuth ones (e.g. [api_key, oauth_A, oauth_B] stored order).
		const stickyCredential = sessionPref?.type === "oauth" ? allCredentials[sessionPref.index] : undefined;
		const preferred = stickyCredential?.type === "oauth" ? stickyCredential : oauthCredentials[0];
		const accountId = preferred?.accountId;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	}

	/**
	 * Get all credentials.
	 */
	getAll(): AuthStorageData {
		const result: AuthStorageData = {};
		for (const [provider, entries] of this.#data.entries()) {
			const credentials = entries.map(entry => entry.credential);
			if (credentials.length === 1) {
				result[provider] = credentials[0];
			} else if (credentials.length > 1) {
				result[provider] = credentials;
			}
		}
		return result;
	}

	/**
	 * Login to an OAuth provider.
	 */
	async login(
		provider: OAuthProviderId,
		ctrl: OAuthController & {
			/** onAuth is required by auth-storage but optional in OAuthController */
			onAuth: (info: { url: string; instructions?: string }) => void;
			/** onPrompt is required for some providers (github-copilot, OpenAI code provider) */
			onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
		},
		options: OAuthLoginOptions = {},
	): Promise<void> {
		let credentials: OAuthCredentials;
		const saveApiKeyCredential = async (apiKey: string): Promise<void> => {
			const newCredential: ApiKeyCredential = { type: "api_key", key: apiKey };
			await this.set(provider, newCredential);
		};
		const manualCodeInput = () => ctrl.onPrompt({ message: "Paste the authorization code (or full redirect URL):" });

		switch (provider) {
			case "opencodex": {
				await checkOpenCodexStatus(ctrl.onProgress);
				return;
			}
			case "anthropic": {
				const { loginAnthropic } = await import("./utils/oauth/anthropic");
				credentials = await loginAnthropic(
					{
						...ctrl,
						onManualCodeInput: ctrl.onManualCodeInput ?? manualCodeInput,
					},
					{ manualCode: options.manualCode },
				);
				break;
			}
			case "alibaba-token-plan": {
				const { loginAlibabaTokenPlan } = await import("./utils/oauth/alibaba-token-plan");
				const apiKey = await loginAlibabaTokenPlan(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "github-copilot": {
				const { loginGitHubCopilot } = await import("./utils/oauth/github-copilot");
				credentials = await loginGitHubCopilot({
					onAuth: (url, instructions) => ctrl.onAuth({ url, instructions }),
					onPrompt: ctrl.onPrompt,
					onProgress: ctrl.onProgress,
					signal: ctrl.signal,
				});
				break;
			}
			case "google-gemini-cli": {
				const { loginGeminiCli } = await import("./utils/oauth/google-gemini-cli");
				credentials = await loginGeminiCli({
					...ctrl,
					onManualCodeInput: ctrl.onManualCodeInput ?? manualCodeInput,
				});
				break;
			}
			case "google-antigravity": {
				const { loginAntigravity } = await import("./utils/oauth/google-antigravity");
				credentials = await loginAntigravity({
					...ctrl,
					onManualCodeInput: ctrl.onManualCodeInput ?? manualCodeInput,
				});
				break;
			}
			case "openai-codex": {
				const { loginOpenAICodex } = await import("./utils/oauth/openai-codex");
				credentials = await loginOpenAICodex({
					...ctrl,
					onManualCodeInput: ctrl.onManualCodeInput ?? manualCodeInput,
				});
				break;
			}
			case "openai-codex-device": {
				// Device/headless flow — stores credentials under "OpenAI code provider" so the
				// provider can pick them up without a separate provider configuration.
				const deviceCredentials = await loginOpenAICodexDevice(ctrl);
				const newCredential: OAuthCredential = { type: "oauth", ...deviceCredentials };
				await this.#upsertOAuthCredential("openai-codex", newCredential);
				return;
			}
			case "gitlab-duo": {
				const { loginGitLabDuo } = await import("./utils/oauth/gitlab-duo");
				credentials = await loginGitLabDuo({
					...ctrl,
					onManualCodeInput: ctrl.onManualCodeInput ?? manualCodeInput,
				});
				break;
			}
			case "kimi-code": {
				const { loginKimi } = await import("./utils/oauth/kimi");
				credentials = await loginKimi(ctrl);
				break;
			}
			case "kiro": {
				const { loginKiro } = await import("./utils/oauth/kiro");
				credentials = await loginKiro({
					onAuth: (url, instructions) => ctrl.onAuth({ url, instructions }),
					onPrompt: ctrl.onPrompt,
					onProgress: ctrl.onProgress,
					signal: ctrl.signal,
				});
				break;
			}
			case "kilo": {
				const { loginKilo } = await import("./utils/oauth/kilo");
				credentials = await loginKilo(ctrl);
				break;
			}
			case "cursor": {
				const { loginCursor } = await import("./utils/oauth/cursor");
				credentials = await loginCursor(
					url => ctrl.onAuth({ url }),
					ctrl.onProgress ? () => ctrl.onProgress?.("Waiting for browser authentication...") : undefined,
				);
				break;
			}
			case "perplexity": {
				const { loginPerplexity } = await import("./utils/oauth/perplexity");
				credentials = await loginPerplexity(ctrl);
				break;
			}
			case "huggingface": {
				const { loginHuggingface } = await import("./utils/oauth/huggingface");
				const apiKey = await loginHuggingface(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "opencode-zen":
			case "opencode-go": {
				const { loginOpenCode } = await import("./utils/oauth/opencode");
				const apiKey = await loginOpenCode(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "commandcode-goat": {
				const { loginCommandCode } = await import("./utils/oauth/commandcode");
				const apiKey = await loginCommandCode(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "lm-studio": {
				const { loginLmStudio } = await import("./utils/oauth/lm-studio");
				const apiKey = await loginLmStudio(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "ollama": {
				const { loginOllama } = await import("./utils/oauth/ollama");
				const apiKey = await loginOllama(ctrl);
				if (!apiKey) {
					return;
				}
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "ollama-cloud": {
				const { loginOllamaCloud } = await import("./utils/oauth/ollama-cloud");
				const apiKey = await loginOllamaCloud(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "cerebras": {
				const { loginCerebras } = await import("./utils/oauth/cerebras");
				const apiKey = await loginCerebras(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "deepseek": {
				const apiKey = await loginDeepSeek(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "deepinfra": {
				const apiKey = await loginDeepInfra(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "xai": {
				const { loginXai } = await import("./utils/oauth/xai");
				credentials = await loginXai({
					...ctrl,
					onManualCodeInput: ctrl.onManualCodeInput ?? manualCodeInput,
				});
				break;
			}
			case "glm-zcode": {
				const { loginGlmZcode } = await import("./utils/oauth/glm-zcode");
				credentials = await loginGlmZcode({
					...ctrl,
					onManualCodeInput: ctrl.onManualCodeInput ?? manualCodeInput,
				});
				break;
			}
			case "fireworks": {
				const { loginFireworks } = await import("./utils/oauth/fireworks");
				const apiKey = await loginFireworks(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "firepass": {
				const { loginFirepass } = await import("./utils/oauth/firepass");
				const apiKey = await loginFirepass(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "fugu": {
				const { loginFugu } = await import("./utils/oauth/fugu");
				const apiKey = await loginFugu(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "zai": {
				const { loginZai } = await import("./utils/oauth/zai");
				const apiKey = await loginZai(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "qianfan": {
				const { loginQianfan } = await import("./utils/oauth/qianfan");
				const apiKey = await loginQianfan(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "minimax-code": {
				const { loginMiniMaxCode } = await import("./utils/oauth/minimax-code");
				const apiKey = await loginMiniMaxCode(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "minimax-code-cn": {
				const { loginMiniMaxCodeCn } = await import("./utils/oauth/minimax-code");
				const apiKey = await loginMiniMaxCodeCn(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "synthetic": {
				const { loginSynthetic } = await import("./utils/oauth/synthetic");
				const apiKey = await loginSynthetic(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "tavily": {
				const { loginTavily } = await import("./utils/oauth/tavily");
				const apiKey = await loginTavily(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "venice": {
				const { loginVenice } = await import("./utils/oauth/venice");
				const apiKey = await loginVenice(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "openrouter": {
				const { loginOpenRouter } = await import("./utils/oauth/openrouter");
				const apiKey = await loginOpenRouter(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "litellm": {
				const { loginLiteLLM } = await import("./utils/oauth/litellm");
				const apiKey = await loginLiteLLM(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "moonshot": {
				const { loginMoonshot } = await import("./utils/oauth/moonshot");
				const apiKey = await loginMoonshot(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "kagi": {
				const { loginKagi } = await import("./utils/oauth/kagi");
				const apiKey = await loginKagi(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "nanogpt": {
				const { loginNanoGPT } = await import("./utils/oauth/nanogpt");
				const apiKey = await loginNanoGPT(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "together": {
				const { loginTogether } = await import("./utils/oauth/together");
				const apiKey = await loginTogether(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "cloudflare-ai-gateway": {
				const { loginCloudflareAiGateway } = await import("./utils/oauth/cloudflare-ai-gateway");
				const apiKey = await loginCloudflareAiGateway(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "vercel-ai-gateway": {
				const { loginVercelAiGateway } = await import("./utils/oauth/vercel-ai-gateway");
				const apiKey = await loginVercelAiGateway(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "vllm": {
				const { loginVllm } = await import("./utils/oauth/vllm");
				const apiKey = await loginVllm(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "sglang": {
				const { loginSglang } = await import("./utils/oauth/sglang");
				const apiKey = await loginSglang(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "parallel": {
				const { loginParallel } = await import("./utils/oauth/parallel");
				const apiKey = await loginParallel(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "qwen-portal": {
				const { loginQwenPortal } = await import("./utils/oauth/qwen-portal");
				const apiKey = await loginQwenPortal(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "nvidia": {
				const { loginNvidia } = await import("./utils/oauth/nvidia");
				const apiKey = await loginNvidia(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "xiaomi": {
				const { loginXiaomi } = await import("./utils/oauth/xiaomi");
				const apiKey = await loginXiaomi(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "xiaomi-token-plan-sgp": {
				const { loginXiaomiTokenPlan } = await import("./utils/oauth/xiaomi");
				const apiKey = await loginXiaomiTokenPlan(ctrl, "sgp");
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "xiaomi-token-plan-ams": {
				const { loginXiaomiTokenPlan } = await import("./utils/oauth/xiaomi");
				const apiKey = await loginXiaomiTokenPlan(ctrl, "ams");
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "xiaomi-token-plan-cn": {
				const { loginXiaomiTokenPlan } = await import("./utils/oauth/xiaomi");
				const apiKey = await loginXiaomiTokenPlan(ctrl, "cn");
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "zenmux": {
				const { loginZenMux } = await import("./utils/oauth/zenmux");
				const apiKey = await loginZenMux(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "bizrouter": {
				const { loginBizRouter } = await import("./utils/oauth/bizrouter");
				const apiKey = await loginBizRouter(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "mara": {
				const { loginMara } = await import("./utils/oauth/mara");
				const apiKey = await loginMara(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			case "opengateway": {
				const { loginOpenGateway } = await import("./utils/oauth/opengateway");
				const apiKey = await loginOpenGateway(ctrl);
				await saveApiKeyCredential(apiKey);
				return;
			}
			default: {
				const customProvider = getOAuthProvider(provider);
				if (!customProvider) {
					throw new Error(`Unknown OAuth provider: ${provider}`);
				}
				const customLoginResult = await customProvider.login({
					onAuth: info => ctrl.onAuth(info),
					onProgress: ctrl.onProgress,
					onPrompt: ctrl.onPrompt,
					onManualCodeInput: ctrl.onManualCodeInput ?? manualCodeInput,
					signal: ctrl.signal,
				});
				if (typeof customLoginResult === "string") {
					await saveApiKeyCredential(customLoginResult);
					return;
				}
				credentials = customLoginResult;
				break;
			}
		}
		const newCredential: OAuthCredential = { type: "oauth", ...credentials };
		if (provider === "xai") {
			const existingOAuthCredentials = this.#getCredentialsForProvider(provider).filter(
				(credential): credential is OAuthCredential => credential.type === "oauth",
			);
			await this.set(provider, [...existingOAuthCredentials, newCredential]);
			return;
		}
		await this.#upsertOAuthCredential(provider, newCredential);
	}

	/**
	 * Logout from a provider.
	 */
	async logout(provider: string): Promise<void> {
		await this.remove(provider);
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Usage API Integration
	// Queries provider usage endpoints to detect rate limits before they occur.
	// ─────────────────────────────────────────────────────────────────────────────

	#buildUsageCredential(credential: OAuthCredential): UsageCredential {
		return {
			type: "oauth",
			accessToken: credential.access,
			refreshToken: credential.refresh,
			expiresAt: credential.expires,
			accountId: credential.accountId,
			projectId: credential.projectId,
			email: credential.email,
			enterpriseUrl: credential.enterpriseUrl,
			mcpBinding: credential.mcpBinding,
		};
	}

	#buildUsageCacheIdentity(credential: UsageCredential): string {
		const parts: string[] = [credential.type];
		const accountId = credential.accountId?.trim();
		if (accountId) parts.push(`account:${accountId}`);
		const email = credential.email?.trim().toLowerCase();
		if (email) parts.push(`email:${email}`);
		const projectId = credential.projectId?.trim();
		if (projectId) parts.push(`project:${projectId}`);
		const enterpriseUrl = credential.enterpriseUrl?.trim().toLowerCase();
		if (enterpriseUrl) parts.push(`enterprise:${enterpriseUrl}`);
		// Only fall back to a secret-derived key when a stable account identifier is unavailable.
		// Including the token hash when accountId/email are present causes cache misses on
		// every OAuth refresh — usage data is per-account, not per-token.
		const hasStableIdentifier = Boolean(accountId || email);
		if (!hasStableIdentifier) {
			const secret = credential.apiKey?.trim() || credential.refreshToken?.trim() || credential.accessToken?.trim();
			if (secret) {
				parts.push(`secret:${Bun.hash(secret).toString(16)}`);
			} else {
				parts.push("anonymous");
			}
		}
		return parts.join("|");
	}

	#normalizeUsageBaseUrl(baseUrl?: string): string {
		return baseUrl?.trim().replace(/\/+$/, "") ?? "";
	}

	#buildUsageReportCacheKey(request: UsageRequestDescriptor): string {
		const baseUrl = this.#normalizeUsageBaseUrl(request.baseUrl) || "default";
		const identity = this.#buildUsageCacheIdentity(request.credential);
		return `report:${request.provider}:${baseUrl}:${identity}`;
	}

	#buildUsageReportsCacheKey(requests: ReadonlyArray<UsageRequestDescriptor>): string {
		const snapshot = requests
			.map(
				request =>
					`${request.provider}:${this.#normalizeUsageBaseUrl(request.baseUrl) || "default"}:${this.#buildUsageCacheIdentity(request.credential)}`,
			)
			.sort()
			.join("\n");
		return `reports:${Bun.hash(snapshot).toString(16)}`;
	}

	#buildUsageRequest(provider: Provider, credential: UsageCredential, baseUrl?: string): UsageRequestDescriptor {
		return { provider, credential, baseUrl };
	}

	#buildUsageRequestForOauth(
		provider: Provider,
		credential: OAuthCredential,
		baseUrl?: string,
	): UsageRequestDescriptor {
		return this.#buildUsageRequest(provider, this.#buildUsageCredential(credential), baseUrl);
	}

	#buildRefreshableOauthCredential(credential: UsageCredential): OAuthCredential | null {
		if (!credential.accessToken || !credential.refreshToken || credential.expiresAt === undefined) {
			return null;
		}
		return {
			type: "oauth",
			access: credential.accessToken,
			refresh: credential.refreshToken,
			expires: credential.expiresAt,
			accountId: credential.accountId,
			projectId: credential.projectId,
			email: credential.email,
			enterpriseUrl: credential.enterpriseUrl,
			mcpBinding: credential.mcpBinding,
		};
	}

	#mergeRefreshedUsageCredential(credential: UsageCredential, refreshed: OAuthCredentials): UsageCredential {
		return {
			...credential,
			accessToken: refreshed.access,
			refreshToken: refreshed.refresh,
			expiresAt: refreshed.expires,
			accountId: refreshed.accountId ?? credential.accountId,
			projectId: refreshed.projectId ?? credential.projectId,
			email: refreshed.email ?? credential.email,
			enterpriseUrl: refreshed.enterpriseUrl ?? credential.enterpriseUrl,
			mcpBinding: credential.mcpBinding,
		};
	}

	/**
	 * Find the stored credential id matching a {@link UsageCredential} so the
	 * refresh override can address the row. Mirrors the matching logic in
	 * {@link AuthStorage.#persistRefreshedUsageCredential}.
	 */
	#findStoredCredentialIdForUsageCredential(provider: Provider, previous: UsageCredential): number | undefined {
		const entries = this.#getStoredCredentials(provider);
		const match = entries.find(entry => {
			if (entry.credential.type !== "oauth") return false;
			if (previous.refreshToken && entry.credential.refresh === previous.refreshToken) return true;
			if (previous.accessToken && entry.credential.access === previous.accessToken) return true;
			return (
				entry.credential.accountId === previous.accountId &&
				entry.credential.email === previous.email &&
				entry.credential.projectId === previous.projectId
			);
		});
		return match?.id;
	}

	#persistRefreshedUsageCredential(provider: Provider, previous: UsageCredential, next: UsageCredential): void {
		const entries = this.#getStoredCredentials(provider);
		const index = entries.findIndex(entry => {
			if (entry.credential.type !== "oauth") return false;
			if (previous.refreshToken && entry.credential.refresh === previous.refreshToken) return true;
			if (previous.accessToken && entry.credential.access === previous.accessToken) return true;
			return (
				entry.credential.accountId === previous.accountId &&
				entry.credential.email === previous.email &&
				entry.credential.projectId === previous.projectId
			);
		});
		if (index === -1) return;
		const existing = entries[index]!.credential;
		if (existing.type !== "oauth") return;
		this.#replaceCredentialAt(provider, index, {
			type: "oauth",
			access: next.accessToken ?? existing.access,
			refresh: next.refreshToken ?? existing.refresh,
			expires: next.expiresAt ?? existing.expires,
			accountId: next.accountId,
			projectId: next.projectId,
			email: next.email,
			enterpriseUrl: next.enterpriseUrl,
			mcpBinding: next.mcpBinding ?? existing.mcpBinding,
		});
	}

	async #fetchUsageUncached(
		request: UsageRequestDescriptor,
		timeoutMs?: number,
		logDetails: boolean = true,
	): Promise<UsageReport | null> {
		const resolver = this.#usageProviderResolver;
		if (!resolver) return null;

		const providerImpl = resolver(request.provider);
		if (!providerImpl) return null;

		const timeoutSignal =
			typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
				? AbortSignal.timeout(timeoutMs)
				: undefined;
		let params: UsageRequestDescriptor & { signal?: AbortSignal } = { ...request, signal: timeoutSignal };

		if (
			request.credential.type === "oauth" &&
			request.credential.expiresAt !== undefined &&
			Date.now() + OAUTH_REFRESH_SKEW_MS >= request.credential.expiresAt
		) {
			const refreshableCredential = this.#buildRefreshableOauthCredential(request.credential);
			if (refreshableCredential) {
				try {
					const refreshableCredentialId = this.#findStoredCredentialIdForUsageCredential(
						request.provider,
						request.credential,
					);
					const refreshed = await this.#refreshOAuthCredential(
						request.provider,
						refreshableCredential,
						refreshableCredentialId,
						timeoutSignal,
					);
					const refreshedCredential = this.#mergeRefreshedUsageCredential(request.credential, refreshed);
					this.#persistRefreshedUsageCredential(request.provider, request.credential, refreshedCredential);
					params = {
						...params,
						credential: refreshedCredential,
					};
				} catch (error) {
					if (logDetails) {
						this.#usageLogger?.debug("Usage credential refresh failed, using original credential", {
							provider: request.provider,
							error: String(error),
						});
					}
				}
			}
		}

		if (providerImpl.supports && !providerImpl.supports(params)) return null;

		try {
			return await providerImpl.fetchUsage(params, {
				fetch: this.#usageFetch,
				logger: logDetails ? this.#usageLogger : undefined,
			});
		} catch (error) {
			if (logDetails) {
				logger.debug("AuthStorage usage fetch failed", {
					provider: request.provider,
					error: String(error),
				});
			}
			return null;
		}
	}

	async #fetchUsageCached(
		request: UsageRequestDescriptor,
		timeoutMs?: number,
		logDetails: boolean = true,
	): Promise<UsageReport | null> {
		const cacheKey = this.#buildUsageReportCacheKey(request);
		const now = Date.now();
		const cached = this.#usageCache.get<UsageReport | null>(cacheKey);
		// Fresh cache hit: return whatever's there (success or null fallback).
		if (cached && cached.expiresAt > now) {
			return cached.value;
		}

		const inFlight = this.#usageRequestInFlight.get(cacheKey);
		if (inFlight) return inFlight;

		const promise = (async () => {
			const report = await this.#fetchUsageUncached(request, timeoutMs, logDetails);
			const ttlJitter = USAGE_REPORT_TTL_MS * (Math.random() * 0.5 - 0.25);
			if (report !== null) {
				// Success: stagger per-credential cache expiry so all accounts don't
				// refresh in the same window — Anthropic / OpenAI rate-limit `/usage`
				// per source IP regardless of account, and synchronized 5-credential
				// fan-out trips 429s every cycle. With ±25% jitter on TTL the refresh
				// times decorrelate within a few cycles.
				this.#usageCache.set(cacheKey, { value: report, expiresAt: Date.now() + USAGE_REPORT_TTL_MS + ttlJitter });
				return report;
			}
			// Failure: cache the LAST GOOD value (if any) with a short jittered TTL
			// so the credential cools down briefly without dropping out of the
			// report. If we never had a good value, return null this cycle and
			// don't write — let the next poll retry.
			const lastGood = this.#usageCache.getStale<UsageReport | null>(cacheKey)?.value ?? null;
			if (lastGood !== null) {
				const backoffJitter = USAGE_FAILURE_BACKOFF_MS * (Math.random() * 0.5 - 0.25);
				const coolDown = Date.now() + USAGE_FAILURE_BACKOFF_MS + backoffJitter;
				this.#usageCache.set(cacheKey, { value: lastGood, expiresAt: coolDown });
			}
			return lastGood;
		})().finally(() => {
			if (this.#usageRequestInFlight.get(cacheKey) === promise) {
				this.#usageRequestInFlight.delete(cacheKey);
			}
		});

		this.#usageRequestInFlight.set(cacheKey, promise);
		return promise;
	}

	#collectUsageRequests(options?: {
		provider?: Provider;
		baseUrlResolver?: (provider: Provider) => string | undefined;
	}): UsageRequestDescriptor[] {
		const resolver = this.#usageProviderResolver;
		if (!resolver) return [];

		const requests: UsageRequestDescriptor[] = [];
		const providers = new Set<string>([
			...this.#data.keys(),
			...DEFAULT_USAGE_PROVIDER_DESCRIPTORS.map(descriptor => descriptor.id),
		]);

		for (const providerId of providers) {
			const provider = providerId as Provider;
			if (options?.provider && options.provider !== provider) continue;
			const providerImpl = resolver(provider);
			if (!providerImpl) continue;
			const baseUrl = options?.baseUrlResolver?.(provider);
			let entries = this.#getStoredCredentials(providerId);
			if (entries.length > 0) {
				const dedupedEntries = this.#pruneDuplicateStoredCredentials(providerId, entries);
				if (dedupedEntries.length !== entries.length) {
					this.#setStoredCredentials(providerId, dedupedEntries);
				}
				entries = dedupedEntries;
			}

			if (entries.length === 0) {
				const runtimeKey = this.#runtimeOverrides.get(providerId);
				const envKey = getEnvApiKey(providerId);
				const apiKey = runtimeKey ?? envKey;
				if (!apiKey) continue;
				const request = this.#buildUsageRequest(provider, { type: "api_key", apiKey }, baseUrl);
				if (providerImpl.supports && !providerImpl.supports(request)) continue;
				requests.push(request);
				continue;
			}

			for (const entry of entries) {
				const credential = entry.credential;
				const request =
					credential.type === "api_key"
						? this.#buildUsageRequest(provider, { type: "api_key", apiKey: credential.key }, baseUrl)
						: this.#buildUsageRequestForOauth(provider, credential, baseUrl);
				if (providerImpl.supports && !providerImpl.supports(request)) continue;
				requests.push(request);
			}
		}

		return requests;
	}

	#getUsageReportMetadataValue(report: UsageReport, key: string): string | undefined {
		const metadata = report.metadata;
		if (!metadata || typeof metadata !== "object") return undefined;
		const value = metadata[key];
		return typeof value === "string" ? value.trim() : undefined;
	}

	#getUsageReportScopeAccountId(report: UsageReport): string | undefined {
		const ids = new Set<string>();
		for (const limit of report.limits) {
			const accountId = limit.scope.accountId?.trim();
			if (accountId) ids.add(accountId);
		}
		if (ids.size === 1) return [...ids][0];
		return undefined;
	}

	#getUsageReportIdentifiers(report: UsageReport): string[] {
		const identifiers: string[] = [];
		const email = this.#getUsageReportMetadataValue(report, "email");
		if (email) identifiers.push(`email:${email.toLowerCase()}`);
		if (report.provider === "openai-codex" || report.provider === "anthropic") {
			return identifiers.map(identifier => `${report.provider}:${identifier.toLowerCase()}`);
		}
		const accountId = this.#getUsageReportMetadataValue(report, "accountId");
		if (accountId) identifiers.push(`account:${accountId}`);
		const account = this.#getUsageReportMetadataValue(report, "account");
		if (account) identifiers.push(`account:${account}`);
		const user = this.#getUsageReportMetadataValue(report, "user");
		if (user) identifiers.push(`account:${user}`);
		const username = this.#getUsageReportMetadataValue(report, "username");
		if (username) identifiers.push(`account:${username}`);
		const scopeAccountId = this.#getUsageReportScopeAccountId(report);
		if (scopeAccountId) identifiers.push(`account:${scopeAccountId}`);
		return identifiers.map(identifier => `${report.provider}:${identifier.toLowerCase()}`);
	}

	#mergeUsageReportGroup(reports: UsageReport[]): UsageReport {
		if (reports.length === 1) return reports[0];
		const sorted = [...reports].sort((a, b) => {
			const limitDiff = b.limits.length - a.limits.length;
			if (limitDiff !== 0) return limitDiff;
			return (b.fetchedAt ?? 0) - (a.fetchedAt ?? 0);
		});
		const base = sorted[0];
		const mergedLimits = [...base.limits];
		const limitIds = new Set(mergedLimits.map(limit => limit.id));
		const mergedMetadata: Record<string, unknown> = { ...(base.metadata ?? {}) };
		let fetchedAt = base.fetchedAt;

		for (const report of sorted.slice(1)) {
			fetchedAt = Math.max(fetchedAt, report.fetchedAt);
			for (const limit of report.limits) {
				if (!limitIds.has(limit.id)) {
					limitIds.add(limit.id);
					mergedLimits.push(limit);
				}
			}
			if (report.metadata) {
				for (const [key, value] of Object.entries(report.metadata)) {
					if (mergedMetadata[key] === undefined) {
						mergedMetadata[key] = value;
					}
				}
			}
		}

		return {
			...base,
			fetchedAt,
			limits: mergedLimits,
			metadata: Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
		};
	}

	#dedupeUsageReports(reports: UsageReport[]): UsageReport[] {
		const groups: UsageReport[][] = [];
		const idToGroup = new Map<string, number>();

		for (const report of reports) {
			const identifiers = this.#getUsageReportIdentifiers(report);
			let groupIndex: number | undefined;
			for (const identifier of identifiers) {
				const existing = idToGroup.get(identifier);
				if (existing !== undefined) {
					groupIndex = existing;
					break;
				}
			}
			if (groupIndex === undefined) {
				groupIndex = groups.length;
				groups.push([]);
			}
			groups[groupIndex].push(report);
			for (const identifier of identifiers) {
				idToGroup.set(identifier, groupIndex);
			}
		}

		const deduped = groups.map(group => this.#mergeUsageReportGroup(group));
		if (deduped.length !== reports.length) {
			this.#usageLogger?.debug("Usage reports deduped", {
				before: reports.length,
				after: deduped.length,
			});
		}
		return deduped;
	}

	#isUsageLimitExhausted(limit: UsageLimit): boolean {
		if (limit.status === "exhausted") return true;
		const amount = limit.amount;
		if (amount.usedFraction !== undefined && amount.usedFraction >= 1) return true;
		if (amount.remainingFraction !== undefined && amount.remainingFraction <= 0) return true;
		if (amount.used !== undefined && amount.limit !== undefined && amount.used >= amount.limit) return true;
		if (amount.remaining !== undefined && amount.remaining <= 0) return true;
		if (amount.unit === "percent" && amount.used !== undefined && amount.used >= 100) return true;
		return false;
	}

	/** Returns true if usage indicates rate limit has been reached. */
	#isUsageLimitReached(report: UsageReport): boolean {
		return report.limits.some(limit => this.#isUsageLimitExhausted(limit));
	}

	/** Extracts the earliest reset timestamp from exhausted windows (in ms). */
	#getUsageResetAtMs(report: UsageReport, nowMs: number): number | undefined {
		const candidates: number[] = [];
		for (const limit of report.limits) {
			if (!this.#isUsageLimitExhausted(limit)) continue;
			const window = limit.window;
			if (window?.resetsAt && window.resetsAt > nowMs) {
				candidates.push(window.resetsAt);
			}
		}
		if (candidates.length === 0) return undefined;
		return Math.min(...candidates);
	}

	async #getUsageReport(
		provider: Provider,
		credential: OAuthCredential,
		options?: { baseUrl?: string; timeoutMs?: number; signal?: AbortSignal },
	): Promise<UsageReport | null> {
		// Store-level hook (e.g. `RemoteAuthCredentialStore`) is authoritative
		// when present: the broker already aggregates usage from a less-throttled
		// IP, and falling back to the local per-credential fetch would defeat the
		// whole point of routing through it.
		const storeHook = this.#store.getUsageReport?.bind(this.#store);
		if (storeHook) {
			return storeHook(provider, credential, options?.signal);
		}
		return raceUsageWithSignal(
			this.#fetchUsageCached(
				this.#buildUsageRequestForOauth(provider, credential, options?.baseUrl),
				options?.timeoutMs ?? this.#usageRequestTimeoutMs,
			),
			options?.signal,
		);
	}

	async fetchUsageReports(options?: {
		provider?: Provider;
		baseUrlResolver?: (provider: Provider) => string | undefined;
		/** Caller's cancel signal; only rejects this caller, never the shared upstream fetch. */
		signal?: AbortSignal;
		/** Disable provider/account/error logging for secret-safe control surfaces. */
		logDetails?: boolean;
	}): Promise<UsageReport[] | null> {
		// Caller override > store-level hook > local per-credential fan-out.
		// `RemoteAuthCredentialStore` implements the store hook so a gateway
		// backed by a broker automatically routes usage to the broker without
		// needing the caller to wire it explicitly.
		const scopedStoreFetch = options?.provider
			? (this.#fetchUsageReportsForProviderOverride ?? this.#store.fetchUsageReportsForProvider?.bind(this.#store))
			: undefined;
		if (scopedStoreFetch && options?.provider) {
			return raceUsageWithSignal(scopedStoreFetch(options.provider), options.signal);
		}
		if (options?.provider && (this.#fetchUsageReportsOverride || this.#store.fetchUsageReports)) {
			throw new Error("Provider-scoped usage fetch is unavailable");
		}
		const override = this.#fetchUsageReportsOverride ?? this.#store.fetchUsageReports?.bind(this.#store);
		if (override) {
			// Reuse the in-flight map so concurrent callers (widget poll + format
			// dispatch + credential selection) coalesce into one upstream call.
			// Each caller's `signal` only cancels THAT caller's await; the
			// shared upstream fetch runs to completion so peers aren't punished.
			const OVERRIDE_KEY = "__override__";
			let shared = this.#usageReportsInFlight.get(OVERRIDE_KEY);
			if (!shared) {
				// Don't forward the caller signal into the shared fetch — first caller's
				// abort would otherwise cancel the upstream for every peer.
				shared = override().finally(() => {
					if (this.#usageReportsInFlight.get(OVERRIDE_KEY) === shared) {
						this.#usageReportsInFlight.delete(OVERRIDE_KEY);
					}
				});
				this.#usageReportsInFlight.set(OVERRIDE_KEY, shared);
			}
			return raceUsageWithSignal(shared, options?.signal);
		}
		if (!this.#usageProviderResolver) return null;

		const requests = this.#collectUsageRequests(options);
		if (requests.length === 0) return [];

		if (options?.logDetails !== false) {
			this.#usageLogger?.debug("Usage fetch requested", {
				providers: [...new Set(requests.map(request => request.provider))].sort(),
			});
		}

		// Per-credential caching with jitter lives in #fetchUsageCached, so we
		// don't store the aggregated result here — doing so locks the widget to
		// a single decorrelation snapshot for 30s, defeating the jitter (some
		// accounts can be missing from one fetch and present in the next; the
		// aggregate cache freezes whichever set landed first).
		const cacheKey = this.#buildUsageReportsCacheKey(requests);

		const inFlight = this.#usageReportsInFlight.get(cacheKey);
		if (inFlight) return raceUsageWithSignal(inFlight, options?.signal);

		const promise = (async () => {
			if (options?.logDetails !== false) {
				for (const request of requests) {
					this.#usageLogger?.debug("Usage fetch queued", {
						provider: request.provider,
						credentialType: request.credential.type,
						baseUrl: request.baseUrl,
						accountId: request.credential.accountId,
						email: request.credential.email,
					});
				}
			}

			const results = await Promise.all(
				requests.map(request =>
					this.#fetchUsageCached(request, this.#usageRequestTimeoutMs, options?.logDetails !== false),
				),
			);
			const reports = results.filter((report): report is UsageReport => report !== null);
			const deduped = this.#dedupeUsageReports(reports);
			// no outer cache write — see comment above.
			const resolved = deduped;
			if (options?.logDetails !== false) {
				this.#usageLogger?.debug("Usage fetch resolved", {
					reports: resolved.map(report => {
						const accountLabel =
							this.#getUsageReportMetadataValue(report, "email") ??
							this.#getUsageReportMetadataValue(report, "accountId") ??
							this.#getUsageReportMetadataValue(report, "account") ??
							this.#getUsageReportMetadataValue(report, "user") ??
							this.#getUsageReportMetadataValue(report, "username") ??
							this.#getUsageReportScopeAccountId(report);
						return {
							provider: report.provider,
							limits: report.limits.length,
							account: accountLabel,
						};
					}),
				});
			}
			return resolved;
		})().finally(() => {
			if (this.#usageReportsInFlight.get(cacheKey) === promise) {
				this.#usageReportsInFlight.delete(cacheKey);
			}
		});

		this.#usageReportsInFlight.set(cacheKey, promise);
		return raceUsageWithSignal(promise, options?.signal);
	}

	/**
	 * Probe each stored credential against its provider's auth-verifying usage
	 * endpoint and report per-credential auth health.
	 *
	 * Surfaces the identity of failing credentials so callers running a
	 * multi-account pool (e.g. a broker-backed auth-gateway) can tell which
	 * row is producing 401s. The probe mirrors the per-credential fan-out
	 * inside {@link AuthStorage.fetchUsageReports} (OAuth refresh-on-expiry,
	 * then `UsageProvider.fetchUsage`) but does NOT swallow errors — every
	 * credential gets either `ok: true`, `ok: false` with `reason`, or
	 * `ok: null` when no probe is configured for the provider.
	 *
	 * Iterates sequentially to avoid synchronized N-account fan-out that
	 * upstream `/usage` rate limiters (per source IP) treat as a burst.
	 *
	 * Only inspects active rows from {@link AuthCredentialStore.listAuthCredentials};
	 * soft-disabled rows are already known-bad and don't need a network probe.
	 * Environment-variable API keys are not enumerated — the caller's intent
	 * here is "which of my stored credentials is broken".
	 */
	/** Return a safe cache-only usage observation. */
	getCachedUsageReport(provider: Provider, credentialId: number, baseUrl?: string): CachedUsageReport | undefined {
		const storageProvider = resolveOAuthStorageProvider(provider);
		const presentation = this.#store.peekCachedUsagePresentation?.(storageProvider, credentialId);
		if (presentation) {
			const now = Date.now();
			if (presentation.retainUntil > now) {
				return {
					report: presentation.usage,
					fetchedAt: presentation.fetchedAt,
					freshUntil: presentation.freshUntil,
					retainUntil: presentation.retainUntil,
					freshness: presentation.freshUntil > now ? "fresh" : "stale-last-good",
				};
			}
		}
		const entry = this.#getStoredCredentials(storageProvider).find(candidate => candidate.id === credentialId);
		if (!entry) return undefined;
		// checkCredentials caches reports for api_key rows under the same
		// provider-level key as OAuth rows; surface both for display instead
		// of silently dropping every API-key provider (for example z.ai).
		const request =
			entry.credential.type === "oauth"
				? this.#buildUsageRequestForOauth(storageProvider, entry.credential, baseUrl)
				: entry.credential.type === "api_key"
					? this.#buildUsageRequest(storageProvider, { type: "api_key", apiKey: entry.credential.key }, baseUrl)
					: undefined;
		if (!request) return undefined;
		const cached = this.#usageCache.getStale<UsageReport | null>(this.#buildUsageReportCacheKey(request));
		if (!cached || cached.value === null || cached.expiresAt + PRESENTATION_RETENTION_MS < Date.now())
			return undefined;
		return {
			report: safeUsageReport(cached.value),
			fetchedAt: cached.value.fetchedAt,
			freshUntil: cached.expiresAt,
			retainUntil: cached.expiresAt + PRESENTATION_RETENTION_MS,
			freshness: cached.expiresAt > Date.now() ? "fresh" : "stale-last-good",
		};
	}

	/** Cache-only health observation; unknown means no retained explicit check. */
	getCachedCredentialHealth(credentialId: number): CachedCredentialHealth {
		const inventory = this.#store.listCredentialInventory?.() ?? [];
		const row = inventory.find(candidate => candidate.id === credentialId);
		if (row?.disabled) return { status: "failed", reason: scrubHealthReason(row.disabledCause ?? "disabled") };
		const remote = row ? this.#store.peekCachedCredentialHealth?.(row.provider as Provider, credentialId) : undefined;
		if (remote) return remote;
		const raw = this.#store.getCache(`${HEALTH_CACHE_PREFIX}${credentialId}`);
		if (!raw) return { status: "unknown", reason: null };
		try {
			const value = JSON.parse(raw) as {
				status?: unknown;
				reason?: unknown;
				checkedAt?: unknown;
				retainUntil?: unknown;
			};
			if (typeof value.retainUntil !== "number" || value.retainUntil <= Date.now())
				return { status: "unknown", reason: null };
			const status =
				value.status === "ok" || value.status === "failed" || value.status === "unverifiable"
					? value.status
					: "unknown";
			return {
				status,
				reason: typeof value.reason === "string" ? value.reason : null,
				checkedAt: typeof value.checkedAt === "number" ? value.checkedAt : undefined,
				retainUntil: value.retainUntil,
			};
		} catch {
			return { status: "unknown", reason: null };
		}
	}

	peekCachedCredentialHealthForSource(provider: string, source: "env" | "config" | "runtime"): CachedCredentialHealth {
		const raw = this.#store.getCache(`${SOURCE_HEALTH_CACHE_PREFIX}${provider}:${source}`);
		if (!raw) return { status: "unknown", reason: null };
		try {
			const value = JSON.parse(raw) as CachedCredentialHealth;
			if (!value.retainUntil || value.retainUntil <= Date.now()) return { status: "unknown", reason: null };
			return {
				status:
					value.status === "ok" || value.status === "failed" || value.status === "unverifiable"
						? value.status
						: "unknown",
				reason: value.reason ? scrubHealthReason(value.reason) : null,
				checkedAt: value.checkedAt,
				retainUntil: value.retainUntil,
			};
		} catch {
			return { status: "unknown", reason: null };
		}
	}

	recordCredentialHealthForSource(
		provider: string,
		source: "env" | "config" | "runtime",
		health: CachedCredentialHealth,
	): void {
		if (health.status === "unknown" || !health.retainUntil) return;
		const retainUntil = health.retainUntil;
		const payload: CachedCredentialHealth = {
			status: health.status,
			reason: health.reason ? scrubHealthReason(health.reason) : null,
			checkedAt: health.checkedAt ?? Date.now(),
			retainUntil,
		};
		this.#store.setCache(
			`${SOURCE_HEALTH_CACHE_PREFIX}${resolveOAuthStorageProvider(provider)}:${source}`,
			JSON.stringify(payload),
			Math.floor(retainUntil / 1000),
		);
	}

	#recordCredentialHealth(provider: Provider, credentialId: number, health: CachedCredentialHealth): void {
		if (health.status !== "unknown") this.#store.recordCredentialHealth?.(provider, credentialId, health);
		if (health.status === "unknown" || !health.retainUntil) return;
		const healthPayload = {
			v: 1,
			status: health.status,
			reason: health.reason ? scrubHealthReason(health.reason) : null,
			checkedAt: health.checkedAt ?? Date.now(),
			retainUntil: health.retainUntil,
		};
		this.#store.setCache(
			`${HEALTH_CACHE_PREFIX}${credentialId}`,
			JSON.stringify(healthPayload),
			Math.floor(healthPayload.retainUntil / 1000),
		);
	}
	/** Explicit API-key probe; key bytes are not retained in the returned result. */
	async checkApiKeyCredential(
		provider: Provider,
		apiKey: string,
		options: ApiKeyCredentialCheckOptions = {},
	): Promise<ApiKeyCredentialCheckResult> {
		const providerImpl = this.#usageProviderResolver?.(provider);
		const base: ApiKeyCredentialCheckResult = { provider, type: "api_key", ok: null };
		if (!providerImpl) {
			base.reason = `unsupported API-key probe for ${provider}`;
			return base;
		}
		const request = this.#buildUsageRequest(provider, { type: "api_key", apiKey }, options.baseUrl);
		if (providerImpl.supports && !providerImpl.supports(request)) {
			base.reason = `unsupported API-key probe for ${provider}`;
			return base;
		}
		options.signal?.throwIfAborted();
		const timeoutMs = options.timeoutMs ?? this.#usageRequestTimeoutMs;
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
		try {
			const report = await providerImpl.fetchUsage(
				{ ...request, signal },
				{
					fetch: this.#usageFetch,
					logger: this.#usageLogger,
				},
			);
			if (!report) {
				base.reason = "API-key probe returned no verifiable data";
				return base;
			}
			base.ok = true;
			base.report = safeUsageReport(report);
			return base;
		} catch (error) {
			base.ok = false;
			base.reason = scrubHealthReason(error, [apiKey]);
			return base;
		}
	}

	async checkCredentials(options?: CheckCredentialsOptions): Promise<CredentialHealthResult[]> {
		options?.signal?.throwIfAborted();
		const stored = this.#store.listAuthCredentials(options?.provider);
		const resolver = this.#usageProviderResolver;
		const timeoutMs = options?.timeoutMs ?? this.#usageRequestTimeoutMs;
		const ctx: UsageFetchContext = { fetch: this.#usageFetch, logger: this.#usageLogger };

		const results: CredentialHealthResult[] = [];
		for (const row of stored) {
			options?.signal?.throwIfAborted();
			const base: CredentialHealthResult = {
				id: row.id,
				provider: row.provider,
				type: row.credential.type,
				ok: null,
			};
			if (row.credential.type === "oauth") {
				if (row.credential.email) base.email = row.credential.email;
				if (row.credential.accountId) base.accountId = row.credential.accountId;
				if (row.credential.refresh === REMOTE_REFRESH_SENTINEL) base.remoteRefresh = true;
			}

			const providerImpl = resolver?.(row.provider as Provider);
			if (!providerImpl) {
				base.reason = `no usage probe configured for provider ${row.provider}`;
				results.push(base);
				continue;
			}

			const baseUrl = options?.baseUrlResolver?.(row.provider as Provider);
			const cred = row.credential;
			const initialRequest: UsageRequestDescriptor =
				cred.type === "api_key"
					? this.#buildUsageRequest(row.provider as Provider, { type: "api_key", apiKey: cred.key }, baseUrl)
					: this.#buildUsageRequestForOauth(row.provider as Provider, cred, baseUrl);

			if (providerImpl.supports && !providerImpl.supports(initialRequest)) {
				base.reason = `usage probe does not support ${cred.type} credentials for ${row.provider}`;
				results.push(base);
				continue;
			}

			const timeoutSignal = AbortSignal.timeout(timeoutMs);
			const probeSignal = options?.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
			let params: UsageFetchParams & { signal: AbortSignal } = { ...initialRequest, signal: probeSignal };

			// Refresh expired OAuth before probing — without this an expired access
			// token reports as `false` when the credential is actually healthy
			// (broker would happily refresh it on the next real request).
			if (
				cred.type === "oauth" &&
				initialRequest.credential.type === "oauth" &&
				initialRequest.credential.expiresAt !== undefined &&
				Date.now() >= initialRequest.credential.expiresAt
			) {
				const refreshable = this.#buildRefreshableOauthCredential(initialRequest.credential);
				if (refreshable) {
					try {
						const refreshed = await this.#refreshOAuthCredential(
							row.provider as Provider,
							refreshable,
							row.id,
							probeSignal,
						);
						const refreshedCredential = this.#mergeRefreshedUsageCredential(initialRequest.credential, refreshed);
						this.#persistRefreshedUsageCredential(
							row.provider as Provider,
							initialRequest.credential,
							refreshedCredential,
						);
						params = { ...params, credential: refreshedCredential };
					} catch (error) {
						base.ok = false;
						base.reason = `oauth refresh failed: ${scrubHealthReason(error)}`;
					}
				}
			}
			if (base.ok === false && base.reason?.startsWith("oauth refresh failed:")) {
				results.push(base);
				const healthPayload: CachedCredentialHealth = {
					status: "failed",
					reason: scrubHealthReason(base.reason),
					checkedAt: Date.now(),
					retainUntil: Date.now() + PRESENTATION_RETENTION_MS,
				};
				this.#recordCredentialHealth(row.provider as Provider, row.id, healthPayload);
				continue;
			}

			try {
				const report = await providerImpl.fetchUsage(params, ctx);
				if (report === null) {
					base.reason = "usage probe returned no data for this credential";
				} else {
					base.ok = true;
					const accountId = this.#getUsageReportMetadataValue(report, "accountId");
					const email = this.#getUsageReportMetadataValue(report, "email");
					if (accountId) base.accountId = accountId;
					if (email) base.email = email;
					const { raw: _raw, ...trimmed } = report;
					base.report = trimmed;
					this.#usageCache.set(this.#buildUsageReportCacheKey(params), {
						value: report,
						expiresAt: Date.now() + USAGE_REPORT_TTL_MS,
					});
					this.#store.recordCredentialUsage?.(row.provider as Provider, row.id, trimmed);
				}
			} catch (error) {
				base.ok = false;
				base.reason = scrubHealthReason(error, cred.type === "api_key" ? [cred.key] : []);
			}

			results.push(base);
			const healthPayload: CachedCredentialHealth = {
				status: base.ok === true ? "ok" : base.ok === false ? "failed" : "unverifiable",
				reason: base.reason
					? scrubHealthReason(base.reason, row.credential.type === "api_key" ? [row.credential.key] : [])
					: null,
				checkedAt: Date.now(),
				retainUntil: Date.now() + PRESENTATION_RETENTION_MS,
			};
			this.#recordCredentialHealth(row.provider as Provider, row.id, healthPayload);
		}

		return results;
	}

	/**
	 * Marks the current session's credential as temporarily blocked due to usage limits.
	 * Uses usage reports to determine accurate reset time when available.
	 * Returns true if a credential was blocked, enabling automatic fallback to the next credential.
	 */
	async markUsageLimitReached(
		provider: string,
		sessionId: string | undefined,
		options?: { retryAfterMs?: number; baseUrl?: string; signal?: AbortSignal; owner?: object },
	): Promise<boolean> {
		provider = resolveOAuthStorageProvider(provider);
		const ownerOverride = this.#configOverrideRegistration(provider, options?.owner);
		if (ownerOverride && !ownerOverride.envSourced) return false;
		const sessionCredential = this.#getSessionCredential(provider, sessionId);
		if (!sessionCredential) return false;

		const providerKey = this.#getProviderTypeKey(provider, sessionCredential.type);
		const now = Date.now();
		let blockedUntil = now + (options?.retryAfterMs ?? AuthStorage.#defaultBackoffMs);

		if (sessionCredential.type === "oauth" && this.#rankingStrategyResolver?.(provider)) {
			const credential = this.#getCredentialsForProvider(provider)[sessionCredential.index];
			if (credential?.type === "oauth") {
				const report = await this.#getUsageReport(provider, credential, options);
				if (report && this.#isUsageLimitReached(report)) {
					const resetAtMs = this.#getUsageResetAtMs(report, Date.now());
					if (resetAtMs && resetAtMs > blockedUntil) {
						blockedUntil = resetAtMs;
					}
				}
			}
		}

		this.#markCredentialBlocked(providerKey, sessionCredential.index, blockedUntil);

		const remainingCredentials = this.#getCredentialsForProvider(provider)
			.map((credential, index) => ({ credential, index }))
			.filter(
				(entry): entry is { credential: AuthCredential; index: number } =>
					entry.credential.type === sessionCredential.type && entry.index !== sessionCredential.index,
			);

		return remainingCredentials.some(candidate => !this.#isCredentialBlocked(providerKey, candidate.index));
	}

	/**
	 * Earliest instant at which any currently blocked stored credential for this
	 * provider becomes usable again. Undefined when nothing is blocked.
	 * When `sessionId` is provided, only the session's active credential type is
	 * considered — API-key and OAuth backoff pools are independent.
	 * Informational only: callers must not treat this as authorization to wait.
	 */
	getEarliestUnblockAt(provider: string, sessionId?: string): number | undefined {
		provider = resolveOAuthStorageProvider(provider);
		const sessionType = this.#getSessionCredential(provider, sessionId)?.type;
		let earliest: number | undefined;
		for (const [index, credential] of this.#getCredentialsForProvider(provider).entries()) {
			if (sessionType !== undefined && credential.type !== sessionType) continue;
			const blockedUntil = this.#getCredentialBlockedUntil(
				this.#getProviderTypeKey(provider, credential.type),
				index,
			);
			if (blockedUntil === undefined || !Number.isFinite(blockedUntil)) continue;
			if (earliest === undefined || blockedUntil < earliest) earliest = blockedUntil;
		}
		return earliest;
	}

	#resolveWindowResetAt(window: UsageLimit["window"]): number | undefined {
		if (!window) return undefined;
		if (typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)) {
			return window.resetsAt;
		}
		return undefined;
	}

	#normalizeUsageFraction(limit: UsageLimit | undefined): number {
		const usedFraction = limit?.amount.usedFraction;
		if (typeof usedFraction !== "number" || !Number.isFinite(usedFraction)) {
			return 0.5;
		}
		return Math.min(Math.max(usedFraction, 0), 1);
	}

	/** Computes `usedFraction / elapsedHours` — consumption rate per hour within the current window. Lower drain rate = less pressure = preferred. */
	#computeWindowDrainRate(limit: UsageLimit | undefined, nowMs: number, fallbackDurationMs: number): number {
		const usedFraction = this.#normalizeUsageFraction(limit);
		const durationMs = limit?.window?.durationMs ?? fallbackDurationMs;
		if (!Number.isFinite(durationMs) || durationMs <= 0) {
			return usedFraction;
		}
		const resetAt = this.#resolveWindowResetAt(limit?.window);
		if (!Number.isFinite(resetAt)) {
			return usedFraction;
		}
		const remainingWindowMs = (resetAt as number) - nowMs;
		const clampedRemainingWindowMs = Math.min(Math.max(remainingWindowMs, 0), durationMs);
		const elapsedMs = durationMs - clampedRemainingWindowMs;
		if (elapsedMs <= 0) {
			return usedFraction;
		}
		const elapsedHours = elapsedMs / (60 * 60 * 1000);
		if (!Number.isFinite(elapsedHours) || elapsedHours <= 0) {
			return usedFraction;
		}
		return usedFraction / elapsedHours;
	}

	async #rankOAuthSelections(args: {
		providerKey: string;
		provider: string;
		order: number[];
		credentials: OAuthCredentialSelection[];
		options?: AuthApiKeyOptions;
		strategy: CredentialRankingStrategy;
	}): Promise<
		Array<{
			selection: OAuthCredentialSelection;
			usage: UsageReport | null;
			usageChecked: boolean;
		}>
	> {
		const nowMs = Date.now();
		const { strategy } = args;
		const ranked: Array<{
			selection: OAuthCredentialSelection;
			usage: UsageReport | null;
			usageChecked: boolean;
			blocked: boolean;
			blockedUntil?: number;
			hasPriorityBoost: boolean;
			secondaryUsed: number;
			secondaryDrainRate: number;
			primaryUsed: number;
			primaryDrainRate: number;
			resetAtMs: number;
			orderPos: number;
		}> = [];
		// Pre-fetch usage reports in parallel for non-blocked credentials.
		// Wrap with a timeout so slow/429'd fetches don't indefinitely block
		// credential selection — better to pick a credential without usage data
		// than to hang the agent waiting for rate-limited usage endpoints.
		const usageTimeout = Math.max(5000, this.#usageRequestTimeoutMs * 1.5);
		const usagePromise = Promise.all(
			args.order.map(async idx => {
				const selection = args.credentials[idx];
				if (!selection) return null;
				const blockedUntil = this.#getCredentialBlockedUntil(args.providerKey, selection.index);
				if (blockedUntil !== undefined) return { selection, usage: null, usageChecked: false, blockedUntil };
				const usage = await this.#getUsageReport(args.provider, selection.credential, {
					baseUrl: args.options?.baseUrl,
					timeoutMs: this.#usageRequestTimeoutMs,
				});
				return { selection, usage, usageChecked: true, blockedUntil: undefined as number | undefined };
			}),
		);
		const timeoutSignal = Promise.withResolvers<null>();
		// `Bun.sleep` keeps the event loop alive even after Promise.race resolves,
		// which leaks a 7.5–15s timer per credential-selection call. Use an unref'd
		// timer so the timeout doesn't pin the process and clear it on the happy
		// path so memory drops immediately.
		const timer = setTimeout(() => timeoutSignal.resolve(null), usageTimeout);
		timer.unref?.();
		let resolvedUsageResults: Awaited<typeof usagePromise> | null;
		try {
			resolvedUsageResults = await raceUsageWithSignal(
				Promise.race([usagePromise, timeoutSignal.promise]),
				args.options?.signal,
			);
		} finally {
			clearTimeout(timer);
		}
		const usageResults =
			resolvedUsageResults ??
			args.order.map(idx => {
				const selection = args.credentials[idx];
				return selection ? { selection, usage: null, usageChecked: true, blockedUntil: undefined } : null;
			});

		for (let orderPos = 0; orderPos < usageResults.length; orderPos += 1) {
			const result = usageResults[orderPos];
			if (!result) continue;
			const { selection, usage, usageChecked } = result;
			let { blockedUntil } = result;
			let blocked = blockedUntil !== undefined;
			if (!blocked && usage && this.#isUsageLimitReached(usage)) {
				const resetAtMs = this.#getUsageResetAtMs(usage, nowMs);
				blockedUntil = resetAtMs ?? Date.now() + AuthStorage.#defaultBackoffMs;
				this.#markCredentialBlocked(args.providerKey, selection.index, blockedUntil);
				blocked = true;
			}
			const windows = usage ? strategy.findWindowLimits(usage) : undefined;
			const primary = windows?.primary;
			const secondary = windows?.secondary;
			const secondaryTarget = secondary ?? primary;
			ranked.push({
				selection,
				usage,
				usageChecked,
				blocked,
				blockedUntil,
				hasPriorityBoost: strategy.hasPriorityBoost?.(primary) ?? false,
				secondaryUsed: this.#normalizeUsageFraction(secondaryTarget),
				secondaryDrainRate: this.#computeWindowDrainRate(
					secondaryTarget,
					nowMs,
					strategy.windowDefaults.secondaryMs,
				),
				primaryUsed: this.#normalizeUsageFraction(primary),
				primaryDrainRate: this.#computeWindowDrainRate(primary, nowMs, strategy.windowDefaults.primaryMs),
				resetAtMs:
					this.#resolveWindowResetAt(primary?.window) ??
					this.#resolveWindowResetAt(secondary?.window) ??
					Number.POSITIVE_INFINITY,
				orderPos,
			});
		}
		ranked.sort((left, right) => {
			if (left.blocked !== right.blocked) return left.blocked ? 1 : -1;
			if (left.blocked && right.blocked) {
				const leftBlockedUntil = left.blockedUntil ?? Number.POSITIVE_INFINITY;
				const rightBlockedUntil = right.blockedUntil ?? Number.POSITIVE_INFINITY;
				if (leftBlockedUntil !== rightBlockedUntil) return leftBlockedUntil - rightBlockedUntil;
				return left.orderPos - right.orderPos;
			}
			if (requiresOpenAICodexProModel(args.provider, args.options?.modelId)) {
				const leftPlanPriority = getOpenAICodexPlanPriority(left.usage);
				const rightPlanPriority = getOpenAICodexPlanPriority(right.usage);
				if (leftPlanPriority !== rightPlanPriority) return leftPlanPriority - rightPlanPriority;
			}
			if (left.hasPriorityBoost !== right.hasPriorityBoost) return left.hasPriorityBoost ? -1 : 1;
			if (this.#credentialRankingMode === "earliest-reset" && left.resetAtMs !== right.resetAtMs) {
				// Earliest-expiry-first: drain the soonest-to-reset account before
				// its perishable tumbling-window quota is lost at reset.
				return left.resetAtMs - right.resetAtMs;
			}
			if (left.secondaryDrainRate !== right.secondaryDrainRate)
				return left.secondaryDrainRate - right.secondaryDrainRate;
			if (left.secondaryUsed !== right.secondaryUsed) return left.secondaryUsed - right.secondaryUsed;
			if (left.primaryDrainRate !== right.primaryDrainRate) return left.primaryDrainRate - right.primaryDrainRate;
			if (left.primaryUsed !== right.primaryUsed) return left.primaryUsed - right.primaryUsed;
			return left.orderPos - right.orderPos;
		});
		return ranked.map(candidate => ({
			selection: candidate.selection,
			usage: candidate.usage,
			usageChecked: candidate.usageChecked,
		}));
	}

	/**
	 * Resolves an OAuth credential, trying credentials in priority order.
	 * Skips blocked credentials and checks usage limits for providers with usage data.
	 * Falls back to earliest-unblocking credential if all are blocked.
	 *
	 * Returns both the API key bytes for outbound requests AND the refreshed
	 * {@link OAuthCredential} so callers needing identity metadata (account id,
	 * project id, etc.) do not have to dereference the snapshot themselves.
	 */
	async #resolveOAuthSelection(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
		reloadsUsed = 0,
	): Promise<OAuthResolutionResult | undefined> {
		if (reloadsUsed > MAX_OAUTH_RESOLUTION_RELOADS) {
			logger.warn("OAuth credential resolution exhausted its reload budget", {
				provider,
				reloadsUsed,
			});
			return undefined;
		}
		const selectedCredential = this.#resolveSelectedStoredCredential(provider, options, sessionId);
		const selectedOAuthCredential: OAuthCredentialSelection | undefined =
			selectedCredential?.credential.type === "oauth"
				? {
						id: selectedCredential.id,
						credential: selectedCredential.credential,
						index: selectedCredential.index,
						revision: selectedCredential.revision,
					}
				: undefined;
		if (selectedCredential && !selectedOAuthCredential) return undefined;
		const credentials = selectedOAuthCredential
			? [selectedOAuthCredential]
			: this.#getStoredCredentials(provider)
					.filter(
						(entry): entry is StoredCredential & { credential: OAuthCredential } =>
							entry.credential.type === "oauth",
					)
					.map((entry, index) => ({
						id: entry.id,
						credential: entry.credential,
						index,
						revision: entry.revision,
					}));

		if (credentials.length === 0) return undefined;

		const providerKey = this.#getProviderTypeKey(provider, "oauth");
		const order = selectedCredential ? [0] : this.#getCredentialOrder(providerKey, sessionId, credentials.length);
		const strategy = this.#rankingStrategyResolver?.(provider);
		const requiresProModel = requiresOpenAICodexProModel(provider, options?.modelId);
		const checkUsage =
			strategy !== undefined && (selectedCredential !== undefined || credentials.length > 1 || requiresProModel);
		const sessionCredential = this.#getSessionCredential(provider, sessionId);
		const sessionPreferredIndex = sessionCredential?.type === "oauth" ? sessionCredential.index : undefined;
		// Skip ranking only when the session already has a working preferred credential — re-ranking
		// mid-session causes account switches that cold-start the server-side prompt cache. New sessions
		// (no preference) and sessions whose preferred is blocked still rank, so we pick the account
		// with the most headroom proactively and fall back intelligently when rate-limited.
		const sessionPreferredIsAvailable =
			sessionPreferredIndex !== undefined && !this.#isCredentialBlocked(providerKey, sessionPreferredIndex);
		const shouldRank = !selectedCredential && checkUsage && (!sessionPreferredIsAvailable || requiresProModel);
		const candidates = shouldRank
			? await this.#rankOAuthSelections({ providerKey, provider, order, credentials, options, strategy: strategy! })
			: order
					.map(idx => credentials[idx])
					.filter((selection): selection is OAuthCredentialSelection => Boolean(selection))
					.map(selection => ({ selection, usage: null, usageChecked: false }));

		// Soft `--prefer-credential` preference: reorder the preferred row to the
		// front when it is usable, ahead of the session-stickiness reorder below so
		// a blocked preferred row falls through to whatever the session already
		// stuck to (its own quota-triggered fallback) instead of overriding it.
		if (!selectedCredential) {
			const preferredSelector = this.#getPreferredCredentialSelector(provider, options);
			if (preferredSelector) {
				this.#assertPreferredCredentialSelectorUsable(
					resolveOAuthStorageProvider(provider),
					preferredSelector,
					options?.owner,
				);
			}
			const preferredSelection = preferredSelector
				? this.#findCredentialBySelector(provider, preferredSelector)
				: undefined;
			if (
				preferredSelection?.credential.type === "oauth" &&
				!this.#isCredentialBlocked(providerKey, preferredSelection.index)
			) {
				const preferredCandidate = candidates.findIndex(
					candidate => candidate.selection.index === preferredSelection.index,
				);
				if (preferredCandidate > 0) {
					const [preferred] = candidates.splice(preferredCandidate, 1);
					candidates.unshift(preferred);
				}
			}
		}

		if (!selectedCredential && sessionPreferredIndex !== undefined && !requiresProModel) {
			const sessionPreferredCandidate = candidates.findIndex(
				candidate =>
					!this.#isCredentialBlocked(providerKey, candidate.selection.index) &&
					candidate.selection.index === sessionPreferredIndex,
			);
			if (sessionPreferredCandidate > 0) {
				const [preferred] = candidates.splice(sessionPreferredCandidate, 1);
				candidates.unshift(preferred);
			}
		}
		await Promise.all(
			candidates.map(async candidate => {
				if (!this.#reconcileOAuthCredentialSelection(provider, candidate.selection)) return;
				if (Date.now() + OAUTH_REFRESH_SKEW_MS < candidate.selection.credential.expires) return;
				const latestCredential = candidate.selection.credential;
				if (latestCredential?.type === "oauth" && Date.now() + OAUTH_REFRESH_SKEW_MS < latestCredential.expires) {
					candidate.selection.credential = latestCredential;
					return;
				}
				try {
					const credentialId = candidate.selection.id;
					const refreshedCredentials = await this.#refreshOAuthCredential(
						provider,
						candidate.selection.credential,
						credentialId,
						options?.signal,
					);
					const updated: OAuthCredential = {
						...candidate.selection.credential,
						...refreshedCredentials,
						type: "oauth",
					};
					if (!this.#reconcileOAuthCredentialSelection(provider, candidate.selection)) return;
					candidate.selection.credential = updated;
					this.#replaceCredentialAt(
						provider,
						candidate.selection.index,
						updated,
						!refreshedCredentials.persistedByLease,
						credentialId,
					);
				} catch (error) {
					if (isSqliteError(error)) throw error;
				}
			}),
		);

		// Skip the Pro-plan filter when no candidate is confirmed Pro, so users with only
		// non-Pro accounts can still attempt Spark requests (e.g. trial/grandfathered access).
		const enforceProRequirement =
			requiresProModel && candidates.some(candidate => hasOpenAICodexProPlan(candidate.usage));
		// Spark retains its historical Plus fallback for grandfathered accounts.
		// Sol is different: a confirmed non-Pro plan cannot call it, so reject the
		// model before returning an OAuth bearer and letting the turn fail remotely.
		const strictProRequirement = requiresStrictOpenAICodexProModel(provider, options?.modelId);
		if (
			strictProRequirement &&
			candidates.length > 0 &&
			candidates.every(
				candidate => getUsagePlanType(candidate.usage) !== undefined && !hasOpenAICodexProPlan(candidate.usage),
			)
		) {
			throw new Error(formatOpenAICodexChatGPTEntitlementError(options?.modelId));
		}

		const fallback = candidates[0];

		for (const candidate of candidates) {
			const resolved = await this.#tryOAuthCredential(
				provider,
				candidate.selection,
				providerKey,
				sessionId,
				options,
				{
					checkUsage,
					allowBlocked: false,
					prefetchedUsage: candidate.usage,
					usagePrechecked: candidate.usageChecked,
					enforceProRequirement,
				},
				reloadsUsed,
			);
			if (resolved) return resolved;
		}

		if (fallback && this.#isCredentialBlocked(providerKey, fallback.selection.index)) {
			return this.#tryOAuthCredential(
				provider,
				fallback.selection,
				providerKey,
				sessionId,
				options,
				{
					checkUsage,
					allowBlocked: true,
					prefetchedUsage: fallback.usage,
					usagePrechecked: fallback.usageChecked,
					enforceProRequirement,
				},
				reloadsUsed,
			);
		}

		return undefined;
	}

	async #refreshOAuthCredential(
		provider: Provider,
		credential: OAuthCredential,
		credentialId: number | undefined,
		signal?: AbortSignal,
		force = false,
		mcpClient: MCPOAuthRefreshClient = {},
	): Promise<RefreshedOAuthCredentials> {
		if (credentialId !== undefined) {
			const existing = this.#oauthCredentialRefreshInFlight.get(credentialId);
			if (existing) return raceCredentialRefreshWithSignal(existing, signal);
		}
		if (!force && Date.now() + OAUTH_REFRESH_SKEW_MS < credential.expires) return credential;
		if (credentialId === undefined) {
			return this.#refreshOAuthCredentialUnshared(provider, credential, undefined, signal, force, mcpClient);
		}
		const promise = this.#refreshOAuthCredentialUnshared(
			provider,
			credential,
			credentialId,
			undefined,
			force,
			mcpClient,
		).finally(() => {
			this.#oauthCredentialRefreshInFlight.delete(credentialId);
		});
		this.#oauthCredentialRefreshInFlight.set(credentialId, promise);
		return raceCredentialRefreshWithSignal(promise, signal);
	}

	async #refreshOAuthCredentialUnshared(
		provider: Provider,
		credential: OAuthCredential,
		credentialId: number | undefined,
		signal?: AbortSignal,
		force = false,
		mcpClient: MCPOAuthRefreshClient = {},
	): Promise<RefreshedOAuthCredentials> {
		let refreshPromise: Promise<OAuthCredentials>;
		let localDial = false;
		let refreshLease: OAuthRefreshLease | undefined;

		// Caller override > store-level hook > local per-provider refresh.
		// `RemoteAuthCredentialStore` exposes the hook so a broker-backed gateway
		// routes refresh through the broker without explicit wiring.
		const storeRefresh = this.#store.refreshOAuthCredential?.bind(this.#store);
		const overrideRefresh = this.#refreshOAuthCredentialOverride ?? storeRefresh;
		if (overrideRefresh && credentialId !== undefined) {
			refreshPromise = overrideRefresh(provider, credentialId, credential, signal);
		} else {
			// Stale-snapshot guard: before replaying our in-memory refresh token
			// upstream, re-read the persisted row. With several gjc processes
			// sharing one store, a peer may have already rotated the token; the
			// post-failure recovery (catch in #tryOAuthCredential) reloads AFTER
			// the replay, but by then the damage is upstream — providers with
			// refresh-token rotation + reuse detection (Anthropic) treat a
			// replayed rotated token as theft and can revoke the whole grant
			// family, killing the peer's freshly rotated, still-valid tokens
			// mid-request (observed as live-session 401 "OAuth access token has
			// been revoked" plus all-day `invalid_grant` refresh floods). Adopt
			// the persisted credential instead: skip the upstream call entirely
			// when it is still fresh (unless the caller demanded a force
			// refresh), otherwise refresh with the newest refresh token. Broker
			// snapshots never take this branch (their store exposes the refresh
			// hook above), so the redacted refresh sentinel cannot confuse the
			// comparison.
			if (credentialId !== undefined) {
				const claimLease = this.#store.claimOAuthRefreshLease?.bind(this.#store);
				if (claimLease) {
					const owner = this.#oauthRefreshLeaseOwner;

					const deadline = Date.now() + OAUTH_REFRESH_LEASE_MS;
					for (;;) {
						if (signal?.aborted) throw new Error("OAuth token refresh aborted by caller");
						const claim = claimLease(
							credentialId,
							credential.refresh,
							force,
							owner,
							Date.now(),
							OAUTH_REFRESH_LEASE_MS,
						);
						if (claim.kind === "missing") throw new Error("OAuth refresh credential disappeared");

						if (claim.kind === "claimed") {
							credential = claim.credential;
							refreshLease = claim.lease;
							break;
						}
						if (claim.kind === "adopted") {
							return {
								access: claim.credential.access,
								refresh: claim.credential.refresh,
								expires: claim.credential.expires,
								accountId: claim.credential.accountId,
								email: claim.credential.email,
								projectId: claim.credential.projectId,
								enterpriseUrl: claim.credential.enterpriseUrl,
								mcpBinding: claim.credential.mcpBinding,
								persistedByLease: true,
							};
						}
						if (Date.now() >= deadline) {
							throw new Error("OAuth token refresh ownership remained ambiguous");
						}
						await Bun.sleep(Math.min(50, Math.max(1, claim.expiresAt - Date.now())));
					}
				} else {
					const persisted = this.#store
						.listAuthCredentials(resolveOAuthStorageProvider(provider))
						.find(row => row.id === credentialId)?.credential;
					if (persisted?.type === "oauth" && persisted.refresh !== credential.refresh) {
						if (!force && Date.now() + OAUTH_REFRESH_SKEW_MS < persisted.expires) {
							return { ...persisted, persistedByLease: true };
						}
						credential = persisted;
					}
				}
			}
			// Replay guard: an attempt with this exact (id, token) pair failed
			// moments ago. The provider may have consumed the rotating token even
			// though we saw a failure (timeout, lost response), so replaying it
			// risks reuse-detection revocation. Surface the memoized failure
			// instead of dialing again; a peer's successful rotation changes the
			// token and therefore never hits this memo. Explicit force refreshes
			// bypass the check (a deliberate operator/broker retry must reach the
			// endpoint) but their failures are still recorded below.
			if (!force && credentialId !== undefined) {
				const memoKey = `${credentialId}:${credential.refresh}`;
				const memo = this.#recentOAuthRefreshFailures.get(memoKey);
				if (memo && memo.expiresAt > Date.now()) {
					throw memo.error;
				}
			}
			localDial = true;
			// Re-check the binding AFTER adoption: a persisted row may have
			// acquired (or always had) an MCP binding the stale snapshot lacked,
			// and its refresh token must only ever be sent to the bound token
			// endpoint.
			if (credential.mcpBinding) {
				refreshPromise = refreshBoundMCPOAuthCredential(credential, mcpClient, signal);
			} else {
				const customProvider = getOAuthProvider(provider);
				if (customProvider) {
					if (!customProvider.refreshToken) {
						throw new Error(`OAuth provider "${provider}" does not support token refresh`);
					}
					refreshPromise = customProvider.refreshToken(credential);
				} else {
					refreshPromise = refreshOAuthToken(provider as OAuthProvider, credential);
				}
			}
		}
		// Bound the refresh so a slow/hanging token endpoint cannot stall credential selection.
		// Caller-driven abort jumps the gun on the timeout — the agent's ESC must
		// take priority over the floor timeout.
		let timeout: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;
		const cancellation = Promise.withResolvers<never>();
		timeout = setTimeout(
			() => cancellation.reject(new Error(`OAuth token refresh timed out for provider: ${provider}`)),
			DEFAULT_OAUTH_REFRESH_TIMEOUT_MS,
		);
		if (signal) {
			if (signal.aborted) {
				cancellation.reject(new Error("OAuth token refresh aborted by caller"));
			} else {
				onAbort = () => cancellation.reject(new Error("OAuth token refresh aborted by caller"));
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}
		try {
			const refreshed = await Promise.race([refreshPromise, cancellation.promise]);
			let effectiveRefreshed = refreshed;
			if (this.#refreshOAuthCredentialOverride && this.#store.refreshSnapshot) {
				await this.#store.refreshSnapshot();
				const accepted = this.#store.listAuthCredentials(provider).find(row => row.id === credentialId)?.credential;
				if (accepted?.type !== "oauth") {
					throw new Error("Credential authority changed during refresh");
				}
				effectiveRefreshed = accepted;
			}
			// Return the FULL authority of the effective credential: rotated
			// tokens from upstream plus the identity metadata and MCP binding of
			// the (possibly guard-adopted) credential that was actually
			// refreshed. Callers persist from this shape; rebuilding it from
			// their stale snapshots would strip an adopted binding — sending the
			// next refresh token to the wrong endpoint — or relabel rotated
			// tokens with stale identity.
			const authority: RefreshedOAuthCredentials = {
				...effectiveRefreshed,
				accountId: effectiveRefreshed.accountId ?? credential.accountId,
				email: effectiveRefreshed.email ?? credential.email,
				projectId: effectiveRefreshed.projectId ?? credential.projectId,
				enterpriseUrl: effectiveRefreshed.enterpriseUrl ?? credential.enterpriseUrl,
				mcpBinding: (effectiveRefreshed as RefreshedOAuthCredentials).mcpBinding ?? credential.mcpBinding,
			};
			if (refreshLease) {
				const completeLease = this.#store.completeOAuthRefreshLease?.bind(this.#store);
				const { persistedByLease: _persistedByLease, ...persistedCredentials } = authority;
				const persisted: OAuthCredential = { type: "oauth", ...persistedCredentials };
				if (!completeLease?.(refreshLease, persisted)) {
					throw new Error("OAuth token refresh ownership was lost before persistence");
				}
				authority.persistedByLease = true;
			}
			return authority;
		} catch (error) {
			if (localDial && credentialId !== undefined) {
				for (const [key, entry] of this.#recentOAuthRefreshFailures) {
					if (entry.expiresAt <= Date.now()) this.#recentOAuthRefreshFailures.delete(key);
				}
				this.#recentOAuthRefreshFailures.set(`${credentialId}:${credential.refresh}`, {
					expiresAt: Date.now() + OAUTH_REFRESH_FAILURE_REPLAY_GUARD_MS,
					error,
				});
			}
			throw tagRefreshAttempt(error, credential.refresh);
		} finally {
			if (timeout) clearTimeout(timeout);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		}
	}

	#reconcileOAuthCredentialSelection(provider: string, selection: OAuthCredentialSelection): boolean {
		const entries = this.#getStoredCredentials(provider);
		const index = entries.findIndex(entry => entry.id === selection.id);
		if (index === -1) return false;
		const current = entries[index];
		if (current?.credential.type !== "oauth") return false;
		selection.index = index;
		selection.credential = current.credential;
		selection.revision = current.revision;
		return true;
	}

	async #prepareOAuthCredentialForRequest(
		provider: string,
		selection: OAuthCredentialSelection,
		options: AuthApiKeyOptions | undefined,
	): Promise<boolean> {
		if (!this.#reconcileOAuthCredentialSelection(provider, selection)) return false;
		const prepare = this.#store.prepareForRequest?.bind(this.#store);
		if (!prepare) return true;
		const stored = this.#getStoredCredentials(provider);
		const selected = stored.find(entry => entry.id === selection.id);
		if (selected?.credential.type !== "oauth") return false;

		const prepared = await prepare(selected.id, { signal: options?.signal });
		if (!prepared) return true;
		const latestRows = this.#store.listAuthCredentials(provider);
		this.#setStoredCredentials(
			provider,
			latestRows.map(row => ({ id: row.id, credential: row.credential, revision: row.revision })),
		);
		const latestIndex = latestRows.findIndex(row => row.id === selection.id);
		if (latestIndex === -1) return false;
		const latest = latestRows[latestIndex];
		if (latest?.credential.type !== "oauth") return false;
		selection.index = latestIndex;
		selection.credential = latest.credential;
		selection.revision = latest.revision;
		return true;
	}

	/** Attempts to use a single OAuth credential, checking usage and refreshing token. */
	async #tryOAuthCredential(
		provider: Provider,
		selection: OAuthCredentialSelection,
		providerKey: string,
		sessionId: string | undefined,
		options: AuthApiKeyOptions | undefined,
		usageOptions: {
			checkUsage: boolean;
			allowBlocked: boolean;
			prefetchedUsage?: UsageReport | null;
			usagePrechecked?: boolean;
			enforceProRequirement?: boolean;
		},
		reloadsUsed = 0,
	): Promise<OAuthResolutionResult | undefined> {
		const {
			checkUsage,
			allowBlocked,
			prefetchedUsage = null,
			usagePrechecked = false,
			enforceProRequirement,
		} = usageOptions;
		if (!this.#reconcileOAuthCredentialSelection(provider, selection)) return undefined;
		if (!allowBlocked && this.#isCredentialBlocked(providerKey, selection.index)) {
			return undefined;
		}

		if (!(await this.#prepareOAuthCredentialForRequest(provider, selection, options))) {
			return undefined;
		}

		const requiresProModel = requiresOpenAICodexProModel(provider, options?.modelId);
		const applyProFilter = enforceProRequirement ?? requiresProModel;
		let usage: UsageReport | null = null;
		let usageChecked = false;

		if ((checkUsage && !allowBlocked) || requiresProModel) {
			if (usagePrechecked) {
				usage = prefetchedUsage;
				usageChecked = true;
			} else {
				usage = await this.#getUsageReport(provider, selection.credential, {
					...options,
					timeoutMs: this.#usageRequestTimeoutMs,
				});
				usageChecked = true;
			}
			if (applyProFilter && !hasOpenAICodexProPlan(usage)) {
				return undefined;
			}
			if (checkUsage && !allowBlocked && usage && this.#isUsageLimitReached(usage)) {
				const resetAtMs = this.#getUsageResetAtMs(usage, Date.now());
				this.#markCredentialBlocked(
					providerKey,
					selection.index,
					resetAtMs ?? Date.now() + AuthStorage.#defaultBackoffMs,
				);
				return undefined;
			}
		}

		try {
			if (!this.#reconcileOAuthCredentialSelection(provider, selection)) return undefined;
			const selectionCredentialId = selection.id;
			let result: { newCredentials: OAuthCredentials; apiKey: string } | null;
			// The refresh result carries the effective (possibly guard-adopted)
			// credential's binding; `updated` must persist it or the next refresh
			// of an MCP-bound row would dial the plain provider endpoint.
			let refreshedAuthority: RefreshedOAuthCredentials;
			const customProvider = getOAuthProvider(provider);
			if (customProvider) {
				const refreshedCredentials = await this.#refreshOAuthCredential(
					provider,
					selection.credential,
					selectionCredentialId,
					options?.signal,
				);
				refreshedAuthority = refreshedCredentials;
				const apiKey = customProvider.getApiKey
					? customProvider.getApiKey(refreshedCredentials)
					: refreshedCredentials.access;
				result = { newCredentials: refreshedCredentials, apiKey };
			} else {
				// Refresh first through the broker-aware single-flighted machinery
				// so transient failures surface as network errors (5-min temp block)
				// instead of `getOAuthApiKey`'s "expired" precondition error, which
				// the definitive-failure regex below would otherwise classify as
				// auth failure and soft-disable a still-valid credential.
				const refreshedCredentials = await this.#refreshOAuthCredential(
					provider,
					selection.credential,
					selectionCredentialId,
					options?.signal,
				);
				refreshedAuthority = refreshedCredentials;
				const oauthCreds: Record<string, OAuthCredentials> = {
					[provider]: refreshedCredentials,
				};
				result = await getOAuthApiKey(provider as OAuthProvider, oauthCreds);
			}
			if (!result) return undefined;
			const updated: OAuthCredential = {
				type: "oauth",
				access: result.newCredentials.access,
				refresh: result.newCredentials.refresh,
				expires: result.newCredentials.expires,
				accountId: result.newCredentials.accountId ?? selection.credential.accountId,
				email: result.newCredentials.email ?? selection.credential.email,
				projectId: result.newCredentials.projectId ?? selection.credential.projectId,
				enterpriseUrl: result.newCredentials.enterpriseUrl ?? selection.credential.enterpriseUrl,
				mcpBinding: refreshedAuthority.mcpBinding,
			};
			this.#replaceCredentialAt(
				provider,
				selection.index,
				updated,
				!refreshedAuthority.persistedByLease,
				selectionCredentialId,
			);

			if ((checkUsage && !allowBlocked) || requiresProModel) {
				const sameAccount = selection.credential.accountId === updated.accountId;
				if (!usageChecked || !sameAccount) {
					usage = await this.#getUsageReport(provider, updated, {
						...options,
						timeoutMs: this.#usageRequestTimeoutMs,
					});
					usageChecked = true;
				}
				if (applyProFilter && !hasOpenAICodexProPlan(usage)) {
					return undefined;
				}
				if (checkUsage && !allowBlocked && usage && this.#isUsageLimitReached(usage)) {
					const resetAtMs = this.#getUsageResetAtMs(usage, Date.now());
					this.#markCredentialBlocked(
						providerKey,
						selection.index,
						resetAtMs ?? Date.now() + AuthStorage.#defaultBackoffMs,
					);
					return undefined;
				}
			}
			if (!this.#reconcileOAuthCredentialSelection(provider, selection)) return undefined;
			if (!authCredentialEquals(selection.credential, updated)) return undefined;
			this.#recordSessionCredential(provider, sessionId, "oauth", selection.index);
			return { apiKey: result.apiKey, credential: updated };
		} catch (error) {
			if (isSqliteError(error)) throw error;
			// Auth-broker errors retain the sanitized upstream body separately from
			// their transport message. Include that body for failure classification
			// (the broker's 500 envelope otherwise hides `invalid_grant`) while
			// preserving the original error object for callers and diagnostics.
			const brokerBody = readBrokerErrorBody(error);
			const errorMsg = [String(error), brokerBody].filter((part): part is string => Boolean(part)).join(" ");
			// Peer-rotation recovery runs before ANY failure classification: a
			// concurrent process may have rotated the refresh token, which
			// invalidates the snapshot token we just attempted. Re-read the row —
			// if the persisted refresh token changed, the peer's rotation succeeded
			// and we pick up the fresh credential instead of disabling (definitive
			// path) or temp-blocking (transient path) a row that is actually
			// healthy. This matters for providers whose invalid-grant response does
			// not match the definitive regex below (e.g. Kimi's 400 "The provided
			// authorization grant is invalid"): with short-lived access tokens and
			// multiple gjc processes sharing the store, the stale-snapshot failure
			// would otherwise be misclassified as transient and the credential
			// temp-blocked on every rotation race.
			// Compare against the refresh token that was ACTUALLY sent upstream.
			// The refresh helper may have adopted the persisted row's newer token
			// (stale-snapshot guard); comparing the row against our even-staler
			// selection snapshot would misread that adoption as a fresh peer
			// rotation and loop reload-retry instead of classifying the failure.
			const attemptedRefreshToken = getAttemptedRefreshToken(error) ?? selection.credential.refresh;
			const attemptedCredentialId = selection.id;
			if (attemptedCredentialId !== undefined) {
				const latestRow = this.#store.listAuthCredentials(provider).find(row => row.id === attemptedCredentialId);
				const latestCredential = latestRow?.credential;
				if (!latestRow) {
					// The row we just tried is no longer active: a peer disabled it after a
					// definitive refresh failure, the user removed it, or a re-login replaced
					// it with a new row. Our in-memory snapshot is stale, and the refresh
					// helper can only answer "credential disappeared" for it — an error that
					// classifies as transient and would temp-block a row that will never come
					// back. Long-lived processes (resumed sessions) would then keep replaying
					// the vanished credential until restart while a valid re-login row sits
					// unused in the store. Reload and re-resolve against the persisted truth.
					logger.debug("OAuth credential vanished from the store; reloading snapshot", {
						provider,
						index: selection.index,
						credentialId: attemptedCredentialId,
					});
					await this.reload();
					return this.#resolveOAuthSelection(provider, sessionId, options, reloadsUsed + 1);
				}
				if (latestCredential?.type === "oauth" && latestCredential.refresh !== attemptedRefreshToken) {
					logger.debug("OAuth refresh race detected; another process rotated token first", {
						provider,
						index: selection.index,
						credentialId: attemptedCredentialId,
					});
					await this.reload();
					return this.#resolveOAuthSelection(provider, sessionId, options, reloadsUsed + 1);
				}
			}
			// Only remove credentials for definitive auth failures
			// Keep credentials for transient errors (network, 5xx) and block temporarily
			const isDefinitiveFailure =
				/invalid_grant|grant is invalid|invalid_token|revoked|unauthorized|expired.*refresh|refresh.*expired/i.test(
					errorMsg,
				) ||
				(/\b(401|403)\b/.test(errorMsg) && !/timeout|network|fetch failed|ECONNREFUSED/i.test(errorMsg));

			logger.warn("OAuth token refresh failed", {
				provider,
				index: selection.index,
				error: scrubHealthReason(error, [selection.credential.access, selection.credential.refresh]),
				isDefinitiveFailure,
			});

			if (isDefinitiveFailure) {
				// Permanently disable invalid credentials with an explicit cause for inspection/debugging.
				// Use a CAS-style disable conditioned on the row still containing the stale credential
				// we tried to refresh, so a peer rotation that lands between the pre-check above and
				// this disable doesn't soft-delete the freshly-rotated row.
				const disabled = this.#tryDisableCredentialAtIfMatches(
					provider,
					selection.index,
					selection.credential,
					`oauth refresh failed: ${errorMsg}`,
					attemptedCredentialId,
				);
				if (!disabled) {
					// The CAS predicate compares the row's serialized `data`, so it also
					// misses when nothing was rotated: the row may have been replaced by
					// a peer (account switcher rewriting the provider's credentials, so
					// our snapshot's id no longer exists) or updated with unrelated
					// identity metadata. Reload-and-retry only makes progress in the
					// rotation case; otherwise the same revoked token is re-refreshed on
					// every request forever. When the row is still present with the very
					// refresh token we just tried, disabling by id is safe — there is no
					// peer rotation to clobber — so apply it directly instead of looping.
					const stillHoldsAttemptedToken =
						attemptedCredentialId !== undefined &&
						this.#credentialRowHoldsRefreshToken(provider, attemptedCredentialId, attemptedRefreshToken);
					if (stillHoldsAttemptedToken && attemptedCredentialId !== undefined) {
						logger.warn("OAuth refresh disable CAS mismatched an unrotated row; disabling by id", {
							provider,
							index: selection.index,
							credentialId: attemptedCredentialId,
						});
						const disabledCause = `oauth refresh failed: ${errorMsg}`;
						if (this.#store.disableAuthCredentialRemote) {
							try {
								const disabled = await this.#disableCredentialRemotely(
									provider,
									attemptedCredentialId,
									disabledCause,
									options?.signal,
									selection.revision,
								);
								if (!disabled) {
									await this.reload();
									return this.#resolveOAuthSelection(provider, sessionId, options, reloadsUsed + 1);
								}
							} catch (disableError) {
								// A failed broker mutation must not replace the provider's
								// original authentication failure. We also deliberately do
								// not remove the row locally: remote authority may still be
								// active and can only be changed by its broker.
								logger.warn("OAuth refresh remote disable failed", {
									provider,
									credentialId: attemptedCredentialId,
									error: String(disableError),
								});
								throw error;
							}
						} else {
							this.#disableCredentialById(provider, attemptedCredentialId, disabledCause);
						}
					} else {
						logger.debug("OAuth refresh disable lost CAS; reloading after peer rotation", {
							provider,
							index: selection.index,
						});
						await this.reload();
						return this.#resolveOAuthSelection(provider, sessionId, options, reloadsUsed + 1);
					}
				}
				if (
					!this.#getCredentialSelector(provider, options, sessionId) &&
					this.#getCredentialsForProvider(provider).some(credential => credential.type === "oauth")
				) {
					return this.#resolveOAuthSelection(provider, sessionId, options, reloadsUsed);
				}
			} else {
				// Block temporarily for transient failures (5 minutes)
				this.#markCredentialBlocked(providerKey, selection.index, Date.now() + 5 * 60 * 1000);
			}
		}
		if (this.#getCredentialSelector(provider, options, sessionId)) {
			const selector = this.#getCredentialSelector(provider, options, sessionId);
			throw new Error(
				`Selected credential for ${provider} (${selector ? this.#formatCredentialSelector(selector) : "unknown"}) is unavailable`,
			);
		}

		return undefined;
	}

	async #resolveStoredApiKey(provider: string, key: string): Promise<string | undefined> {
		const storageProvider = resolveOAuthStorageProvider(provider);
		const configurationGeneration = this.#getProviderConfigurationGeneration(storageProvider);
		const resolutions =
			this.#storedApiKeyResolutionInFlight.get(storageProvider) ?? new Map<string, Promise<string | undefined>>();
		this.#storedApiKeyResolutionInFlight.set(storageProvider, resolutions);
		const existing = resolutions.get(key);
		if (existing) return existing;

		const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
		resolutions.set(key, promise);
		const publish = (value: string | undefined) => {
			if (
				configurationGeneration !== this.#getProviderConfigurationGeneration(storageProvider) ||
				this.#storedApiKeyResolutionInFlight.get(storageProvider) !== resolutions ||
				resolutions.get(key) !== promise
			) {
				return;
			}
			const values =
				this.#resolvedStoredApiKeyValues.get(storageProvider) ??
				new Map<string, { fingerprint: string; usable: boolean }>();
			const wasUsable = !values.has(key) || values.get(key)?.usable === true;
			const isUsable = (value?.length ?? 0) > 0;
			values.set(key, {
				fingerprint: value ? crypto.createHash("sha256").update(value).digest("hex") : "",
				usable: isUsable,
			});
			this.#resolvedStoredApiKeyValues.set(storageProvider, values);
			if (key.startsWith("!") && wasUsable !== isUsable) {
				this.#bumpGeneration("stored-api-key-usability", storageProvider);
			}
		};
		void (async () => {
			try {
				const value = await this.#configValueResolver(key, String(configurationGeneration));
				publish(value);
				resolve(value);
			} catch (error) {
				publish(undefined);
				reject(error);
			} finally {
				if (
					this.#storedApiKeyResolutionInFlight.get(storageProvider) === resolutions &&
					resolutions.get(key) === promise
				) {
					resolutions.delete(key);
					if (resolutions.size === 0) this.#storedApiKeyResolutionInFlight.delete(storageProvider);
				}
			}
		})();
		return promise;
	}
	#storedApiKeyUsability(provider: string, key: string): boolean | undefined {
		if (!key.startsWith("!")) return true;
		return this.#resolvedStoredApiKeyValues.get(resolveOAuthStorageProvider(provider))?.get(key)?.usable;
	}

	#hasUsableResolvedStoredApiKey(provider: string, key: string): boolean {
		return this.#storedApiKeyUsability(provider, key) === true;
	}

	/**
	 * Peek at API key for a provider without refreshing OAuth tokens.
	 * Used for model discovery where we only need to know if credentials exist
	 * and get a best-effort token. For GitHub Copilot we preserve enterprise
	 * routing metadata so discovery can hit the correct host.
	 */
	async peekApiKey(provider: string, options?: Pick<AuthApiKeyOptions, "owner">): Promise<string | undefined> {
		provider = resolveOAuthStorageProvider(provider);
		const runtimeKey = this.#runtimeOverrides.get(provider);
		if (runtimeKey) return runtimeKey;

		const configOverride = this.#configOverrideRegistration(provider, options?.owner);
		const configKey = configOverride?.apiKey;
		if (configKey && !configOverride?.envSourced) return configKey;

		const selectedCredential = this.#resolveSelectedStoredCredential(
			provider,
			options?.owner ? { owner: options.owner } : undefined,
			undefined,
		);
		if (configKey) {
			// Env-sourced (`apiKeyEnv`) override: same precedence as getApiKey —
			// a stored api_key credential from `auth login` wins, stored OAuth
			// still yields to the indirection.
			const storedApiKey = await this.#resolveStoredApiKeyOverEnvConfig(provider, selectedCredential, undefined);
			return storedApiKey ?? configKey;
		}
		if (selectedCredential?.credential.type === "api_key") {
			return this.#resolveStoredApiKey(provider, selectedCredential.credential.key);
		}

		// Return current OAuth access token only if it is not already expired.
		if (selectedCredential?.credential.type === "oauth") {
			const expiresAt = selectedCredential.credential.expires;
			if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
				if (provider === "github-copilot") {
					return JSON.stringify({
						token: selectedCredential.credential.access,
						enterpriseUrl: selectedCredential.credential.enterpriseUrl,
					});
				}
				return selectedCredential.credential.access;
			}
			return undefined;
		}

		const attemptedApiKeyIndices = new Set<number>();
		for (;;) {
			const apiKeySelection = this.#selectApiKeyCredential(provider, undefined, attemptedApiKeyIndices);
			if (!apiKeySelection) break;
			attemptedApiKeyIndices.add(apiKeySelection.index);
			const resolved = await this.#resolveStoredApiKey(provider, apiKeySelection.credential.key);
			if (resolved) return resolved;
		}

		const oauthSelection = this.#selectCredentialByType(provider, "oauth");
		if (oauthSelection) {
			const expiresAt = oauthSelection.credential.expires;
			if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
				if (provider === "github-copilot") {
					return JSON.stringify({
						token: oauthSelection.credential.access,
						enterpriseUrl: oauthSelection.credential.enterpriseUrl,
					});
				}
				return oauthSelection.credential.access;
			}
		}

		return getEnvApiKey(provider) || this.#resolveFallback(provider, options?.owner);
	}

	/**
	 * Get API key for a provider.
	 * Priority:
	 * 1. Runtime override (CLI --api-key)
	 * 2. Config override (models.yml `providers.<name>.apiKey` literal pin)
	 * 3. Stored api_key credential from `auth login`, when the config override
	 *    is only an `apiKeyEnv` indirection
	 * 4. Config override sourced from models.yml `providers.<name>.apiKeyEnv`
	 * 5. Session-selected OAuth credential, when present
	 * 6. Usable or unresolved API key from storage
	 * 7. OAuth token from storage (auto-refreshed)
	 * 8. Previously unusable command-backed API key retry
	 * 9. Environment variable
	 * 10. Fallback resolver (models.yml custom providers, last-resort)
	 */
	async getApiKey(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<string | undefined> {
		provider = resolveOAuthStorageProvider(provider);
		const selectedCredential = this.#resolveSelectedStoredCredential(provider, options, sessionId);

		// Runtime override takes highest priority after selector validation.
		const runtimeKey = this.#runtimeOverrides.get(provider);
		if (runtimeKey) return runtimeKey;

		// Config override: explicit apiKey pinned in models.yml beats the broker's
		// OAuth credentials. The user redirected a provider at a custom baseUrl
		// (e.g. an auth-gateway) and supplied the bearer for that endpoint —
		// honor it instead of forwarding an upstream OAuth token that the proxy
		// won't accept.
		const configOverride = this.#configOverrideRegistration(provider, options?.owner);
		const configKey = configOverride?.apiKey;
		if (configKey) {
			if (!configOverride?.envSourced) return configKey;
			// The override is an `apiKeyEnv` indirection, not a pinned value. A
			// stored api_key credential from `auth login` is actively managed
			// (validated at login, rotated on 401), while the pointed-to env
			// value can go stale with no recovery path — prefer the stored
			// credential. Stored OAuth credentials still yield to the override.
			const storedApiKey = await this.#resolveStoredApiKeyOverEnvConfig(provider, selectedCredential, sessionId);
			if (storedApiKey) return storedApiKey;
			return configKey;
		}

		if (selectedCredential?.credential.type === "api_key") {
			this.#recordSessionCredential(provider, sessionId, "api_key", selectedCredential.index);
			return this.#resolveStoredApiKey(provider, selectedCredential.credential.key);
		}

		let oauthAttempted = false;
		if (!selectedCredential && this.#getSessionCredential(provider, sessionId)?.type === "oauth") {
			const oauthResolved = await this.#resolveOAuthSelection(provider, sessionId, options);
			oauthAttempted = true;
			if (oauthResolved) return oauthResolved.apiKey;
		}

		const attemptedApiKeyIndices = new Set<number>();
		if (!selectedCredential) {
			for (;;) {
				const apiKeySelection = this.#selectApiKeyCredential(provider, sessionId, attemptedApiKeyIndices);
				if (!apiKeySelection) break;
				attemptedApiKeyIndices.add(apiKeySelection.index);
				const resolved = await this.#resolveStoredApiKey(provider, apiKeySelection.credential.key);
				if (resolved) {
					this.#recordSessionCredential(provider, sessionId, "api_key", apiKeySelection.index);
					return resolved;
				}
			}
		}

		if (!oauthAttempted) {
			const oauthResolved = await this.#resolveOAuthSelection(provider, sessionId, options);
			if (oauthResolved) return oauthResolved.apiKey;
		}

		if (!selectedCredential) {
			for (;;) {
				const apiKeySelection = this.#selectApiKeyCredential(provider, sessionId, attemptedApiKeyIndices, true);
				if (!apiKeySelection) break;
				attemptedApiKeyIndices.add(apiKeySelection.index);
				const resolved = await this.#resolveStoredApiKey(provider, apiKeySelection.credential.key);
				if (resolved) {
					this.#recordSessionCredential(provider, sessionId, "api_key", apiKeySelection.index);
					return resolved;
				}
			}
		}

		// Fall back to environment variable or custom resolver. If we reach here after
		// an OAuth miss, the session sticky (if any) is stale — the request will
		// authenticate via env/fallback, not OAuth, so clear the sticky now so that
		// getOAuthAccountId() correctly suppresses account_uuid for this session.
		if (sessionId) this.#sessionLastCredential.get(provider)?.delete(sessionId);
		const envKey = getEnvApiKey(provider);
		if (envKey) return envKey;
		return this.#resolveFallback(provider, options?.owner) ?? undefined;
	}

	/**
	 * Resolve a stored api_key credential that outranks an env-sourced config
	 * override (`apiKeyEnv`). Mirrors the api_key branches of {@link getApiKey}:
	 * the selector-pinned credential first, then the round-robin/session pool.
	 * Returns undefined when no stored api_key credential resolves, leaving the
	 * env-sourced override in effect.
	 */
	async #resolveStoredApiKeyOverEnvConfig(
		provider: string,
		selectedCredential: ({ index: number } & StoredCredential) | undefined,
		sessionId?: string,
	): Promise<string | undefined> {
		if (selectedCredential?.credential.type === "api_key") {
			const resolved = await this.#resolveStoredApiKey(provider, selectedCredential.credential.key);
			if (resolved) {
				this.#recordSessionCredential(provider, sessionId, "api_key", selectedCredential.index);
				return resolved;
			}
		}
		const attemptedApiKeyIndices = new Set<number>();
		for (;;) {
			const apiKeySelection = this.#selectApiKeyCredential(provider, sessionId, attemptedApiKeyIndices);
			if (!apiKeySelection) return undefined;
			attemptedApiKeyIndices.add(apiKeySelection.index);
			const resolved = await this.#resolveStoredApiKey(provider, apiKeySelection.credential.key);
			if (resolved) {
				this.#recordSessionCredential(provider, sessionId, "api_key", apiKeySelection.index);
				return resolved;
			}
		}
	}

	/**
	 * Resolve the OAuth credential for `provider`, refreshing through the same
	 * pipeline as {@link AuthStorage.getApiKey} but returning the refreshed
	 * {@link OAuthAccess} (raw access token + identity metadata) instead of
	 * the API-key bytes.
	 *
	 * Use this when the caller needs to inject identity headers alongside the
	 * bearer (OpenAI code backend `chatgpt-account-id`, Google `project`, GitHub
	 * `enterpriseUrl`). For pure "give me the bytes for `Authorization`"
	 * scenarios, prefer {@link AuthStorage.getApiKey}.
	 *
	 * Returns `undefined` when no OAuth credential is available, the
	 * credential fails to refresh, or runtime/config overrides have replaced
	 * OAuth with an explicit API key.
	 */
	async getOAuthAccess(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
	): Promise<OAuthAccess | undefined> {
		provider = resolveOAuthStorageProvider(provider);
		// Runtime / config overrides intentionally short-circuit OAuth: when the
		// user has pinned an API key, they expect the OAuth identity to be
		// suppressed (same contract as `getOAuthAccountId`).
		if (this.#runtimeOverrides.has(provider) || this.#hasConfigOverride(provider, options?.owner)) {
			return undefined;
		}
		const resolved = await this.#resolveOAuthSelection(provider, sessionId, options);
		if (!resolved) return undefined;
		const { credential } = resolved;
		return {
			accessToken: credential.access,
			accountId: credential.accountId,
			email: credential.email,
			projectId: credential.projectId,
			enterpriseUrl: credential.enterpriseUrl,
		};
	}

	#extractStructuredApiKeyToken(apiKey: string): string | undefined {
		return extractStructuredApiKeyToken(apiKey);
	}

	async #credentialMatchesApiKey(provider: string, credential: AuthCredential, apiKey: string): Promise<boolean> {
		if (credential.type === "api_key") {
			return (
				(await this.#configValueResolver(
					credential.key,
					String(this.#getProviderConfigurationGeneration(provider)),
				)) === apiKey
			);
		}
		if (credential.access === apiKey) return true;
		return this.#extractStructuredApiKeyToken(apiKey) === credential.access;
	}

	async invalidateCredentialMatching(
		provider: string,
		apiKey: string,
		options?: InvalidateCredentialMatchingOptions,
	): Promise<boolean>;
	async invalidateCredentialMatching(provider: string, apiKey: string, signal?: AbortSignal): Promise<boolean>;
	async invalidateCredentialMatching(
		provider: string,
		apiKey: string,
		optionsOrSignal?: InvalidateCredentialMatchingOptions | AbortSignal,
	): Promise<boolean> {
		const signal = isAbortSignalOption(optionsOrSignal) ? optionsOrSignal : optionsOrSignal?.signal;
		const sessionId = isAbortSignalOption(optionsOrSignal) ? undefined : optionsOrSignal?.sessionId;
		const storageProvider = resolveOAuthStorageProvider(provider);
		const owner = isAbortSignalOption(optionsOrSignal) ? undefined : optionsOrSignal?.owner;
		const ownerOverride = this.#configOverrideRegistration(storageProvider, owner);
		if (ownerOverride && !ownerOverride.envSourced && ownerOverride.apiKey === apiKey) return false;
		const stored = this.#getStoredCredentials(storageProvider);
		let matched: { id: number; type: AuthCredential["type"]; index: number } | undefined;
		for (let index = 0; index < stored.length; index++) {
			const entry = stored[index];
			if (entry && (await this.#credentialMatchesApiKey(storageProvider, entry.credential, apiKey))) {
				matched = { id: entry.id, type: entry.credential.type, index };
				break;
			}
		}

		if (!matched) {
			await this.reload();
			return false;
		}

		this.#clearSessionCredential(storageProvider, sessionId);
		this.#markCredentialBlocked(
			this.#getProviderTypeKey(storageProvider, matched.type),
			matched.index,
			Date.now() + AuthStorage.#defaultBackoffMs,
		);

		const markSuspect = this.#store.markCredentialSuspect?.bind(this.#store);
		if (markSuspect) {
			await markSuspect(matched.id, { signal });
		} else {
			await this.reload();
		}

		const latestRows = this.#store.listAuthCredentials(storageProvider);
		this.#setStoredCredentials(
			storageProvider,
			latestRows.map(row => ({ id: row.id, credential: row.credential, revision: row.revision })),
		);
		return true;
	}

	// ─── Auth Broker integration ────────────────────────────────────────────

	/**
	 * Build a redacted snapshot of all loaded credentials for the auth-broker
	 * wire. OAuth refresh tokens are replaced with {@link REMOTE_REFRESH_SENTINEL}
	 * so clients never see the actual refresh token.
	 *
	 * Callers must {@link AuthStorage.reload} first when serving a stale snapshot
	 * (the broker server's HTTP handler does this).
	 */
	exportSnapshot(): AuthCredentialSnapshot {
		const entries: AuthCredentialSnapshotEntry[] = [];
		for (const [provider, stored] of this.#data) {
			for (const entry of stored) {
				const credential = entry.credential;
				const redacted: SnapshotCredential =
					credential.type === "api_key" ? credential : { ...credential, refresh: REMOTE_REFRESH_SENTINEL };
				entries.push({
					id: entry.id,
					provider,
					credential: redacted,
					identityKey: resolveCredentialIdentityKey(provider, credential),
					...(entry.revision === undefined ? {} : { revision: entry.revision }),
				});
			}
		}
		return { generation: this.#generation, generatedAt: Date.now(), credentials: entries };
	}

	/**
	 * Refresh the OAuth credential with the given id through a per-credential
	 * single-flight. Concurrent callers for the same row await the same upstream
	 * refresh attempt, which is required for providers that rotate refresh tokens
	 * on every successful refresh.
	 */
	async refreshCredentialById(
		id: number,
		signal?: AbortSignal,
		mcpClient: MCPOAuthRefreshClient = {},
	): Promise<AuthCredentialSnapshotEntry> {
		const existing = this.#oauthRefreshInFlight.get(id);
		if (existing) return raceCredentialRefreshWithSignal(existing, signal);

		const promise = (async () => {
			this.#bumpGeneration("credential-refresh-start");
			try {
				return await this.#forceRefreshCredentialByIdUnshared(id, signal, mcpClient);
			} catch (error) {
				this.#bumpGeneration("credential-refresh-failure");
				throw error;
			} finally {
				this.#oauthRefreshInFlight.delete(id);
			}
		})();
		this.#oauthRefreshInFlight.set(id, promise);
		return raceCredentialRefreshWithSignal(promise, signal);
	}

	/**
	 * Force-refresh the OAuth credential with the given id, bypassing the
	 * not-yet-expired guard. Used by the auth-broker server to honour
	 * `POST /v1/credential/:id/refresh`.
	 *
	 * Returns the redacted snapshot entry for the refreshed row.
	 * Throws when no OAuth credential with that id is loaded.
	 */
	async forceRefreshCredentialById(id: number, signal?: AbortSignal): Promise<AuthCredentialSnapshotEntry> {
		return this.refreshCredentialById(id, signal);
	}

	/** Force-refresh the first OAuth credential stored for a provider. */
	async forceRefreshOAuthCredential(
		provider: string,
		expected: OAuthCredential,
		client: MCPOAuthRefreshClient = {},
		signal?: AbortSignal,
	): Promise<OAuthCredential> {
		const storageProvider = resolveOAuthStorageProvider(provider);
		const target = this.#getStoredCredentials(storageProvider).find(
			entry => entry.credential === expected || authCredentialEquals(entry.credential, expected),
		);
		if (target?.credential.type !== "oauth") {
			throw new Error(`No OAuth credential found for provider=${storageProvider}`);
		}
		const entry = await this.refreshCredentialById(target.id, signal, client);
		if (entry.credential.type !== "oauth") {
			throw new Error(`Credential ${target.id} is not OAuth`);
		}
		return entry.credential;
	}

	async #forceRefreshCredentialByIdUnshared(
		id: number,
		signal?: AbortSignal,
		mcpClient: MCPOAuthRefreshClient = {},
	): Promise<AuthCredentialSnapshotEntry> {
		for (const [provider, entries] of this.#data) {
			const index = entries.findIndex(entry => entry.id === id);
			if (index === -1) continue;
			const target = entries[index];
			if (target.credential.type !== "oauth") {
				throw new Error(`Credential ${id} is not OAuth (provider=${provider}, type=${target.credential.type})`);
			}
			// Pass a clone with expires=0 plus explicit force intent so neither
			// the cached not-yet-expired short-circuit in #refreshOAuthCredential
			// nor the stale-snapshot guard's fresh-row adoption suppresses the
			// requested refresh. The guard still substitutes the newest persisted
			// refresh token when a peer rotated the row.
			const stale: OAuthCredential = { ...target.credential, expires: 0 };
			let refreshed: RefreshedOAuthCredentials;
			const remoteRefresh = this.#store.refreshMCPOAuthCredential?.bind(this.#store);
			if (target.credential.mcpBinding && remoteRefresh) {
				// Remote (broker) stores refresh MCP-bound rows server-side; the
				// server runs the guarded local path against its own row.
				assertCanonicalMCPOAuthBinding(target.credential.mcpBinding);
				const refreshedCredential = await remoteRefresh(id, stale, mcpClient, signal);
				if (
					refreshedCredential.mcpBinding?.resourceOrigin !== target.credential.mcpBinding.resourceOrigin ||
					refreshedCredential.mcpBinding.tokenEndpoint !== target.credential.mcpBinding.tokenEndpoint
				) {
					throw new Error("Refreshed MCP OAuth credential binding mismatch");
				}
				refreshed = refreshedCredential;
			} else if (target.credential.mcpBinding) {
				// Local forced refresh of a bound row dials the unshared path
				// DIRECTLY so the caller's cancellation signal reaches the bound
				// token fetch (documented contract) — while still running the
				// stale-snapshot guard, memo recording, and failure provenance.
				// The outer #oauthRefreshInFlight map already single-flights
				// concurrent public force callers per row.
				assertCanonicalMCPOAuthBinding(target.credential.mcpBinding);
				refreshed = await this.#refreshOAuthCredentialUnshared(
					provider as Provider,
					stale,
					id,
					signal,
					true,
					mcpClient,
				);
			} else {
				// Plain local force refresh routes through the guarded, memoized,
				// single-flighted path: the stale-snapshot guard adopts a
				// peer-rotated row (tokens AND binding) before dispatch, so a
				// forced refresh never replays a rotated token or dials a stale
				// endpoint. The returned authority carries the effective binding.
				refreshed = await this.#refreshOAuthCredential(provider as Provider, stale, id, signal, true, mcpClient);
			}
			const updated: OAuthCredential = {
				type: "oauth",
				access: refreshed.access,
				refresh: refreshed.refresh,
				expires: refreshed.expires,
				accountId: refreshed.accountId ?? target.credential.accountId,
				email: refreshed.email ?? target.credential.email,
				projectId: refreshed.projectId ?? target.credential.projectId,
				enterpriseUrl: refreshed.enterpriseUrl ?? target.credential.enterpriseUrl,
				mcpBinding: refreshed.mcpBinding,
			};
			this.#replaceCredentialAt(provider, index, updated, !refreshed.persistedByLease, id);
			const persisted = this.#store.listAuthCredentials(provider).find(entry => entry.id === id);
			return {
				id,
				provider,
				credential: { ...updated, refresh: REMOTE_REFRESH_SENTINEL },
				identityKey: resolveCredentialIdentityKey(provider, updated),
				...(persisted?.revision === undefined ? {} : { revision: persisted.revision }),
			};
		}
		throw new Error(`No credential with id=${id}`);
	}

	/**
	 * Disable the credential with the given id and emit a
	 * {@link CredentialDisabledEvent}. Used by the auth-broker server to honour
	 * `POST /v1/credential/:id/disable`. Returns `false` when no such row exists.
	 */
	disableCredentialById(id: number, disabledCause: string): boolean {
		const cause = normalizeDisabledCause(disabledCause);
		for (const [provider, entries] of this.#data) {
			const index = entries.findIndex(entry => entry.id === id);
			if (index === -1) continue;
			this.#store.deleteAuthCredential(id, cause);
			const next = entries.filter((_value, idx) => idx !== index);
			this.#setStoredCredentials(provider, next);
			this.#clearSelectorsForRemovedCredential(provider, new Set([id]), entries);
			this.#resetProviderAssignments(provider);
			this.#emitCredentialDisabled({ provider, disabledCause: cause });
			return true;
		}
		return false;
	}

	/**
	 * Upsert a credential into the underlying store, refresh the in-memory
	 * snapshot, and return the redacted snapshot entries for the provider.
	 *
	 * Used by the auth-broker server to honour `POST /v1/credential`. The
	 * persistence layer (`SqliteAuthCredentialStore.upsertAuthCredentialForProvider`)
	 * does identity-key matching, so re-uploading the same email/account replaces
	 * the existing row instead of inserting a duplicate.
	 */
	upsertCredential(provider: string, credential: AuthCredential): AuthCredentialSnapshotEntry[] {
		const stored = this.#store.upsertAuthCredentialForProvider(provider, credential);
		this.#setStoredCredentials(
			provider,
			stored.map(entry => ({ id: entry.id, credential: entry.credential, revision: entry.revision })),
		);
		this.#resetProviderAssignments(provider);
		return this.#toSnapshotEntries(provider, stored);
	}

	/**
	 * Describe where the active credential for a provider came from.
	 *
	 * Surfaces four layers, highest precedence first:
	 *   1. Runtime override (`--api-key`).
	 *   2. Config override (`models.yml` `providers.<name>.apiKey` literal pin,
	 *      or an `apiKeyEnv` indirection when no stored api_key credential
	 *      outranks it).
	 *   3. Stored credential (the one this session is currently sticky to, or the
	 *      one round-robin would pick next when no session id is supplied).
	 *   4. Env var / fallback resolver — when no stored credential exists.
	 *
	 * The string is purely informational; consumers must not parse it.
	 */
	describeCredentialSource(
		provider: string,
		sessionId?: string,
		options?: Pick<AuthApiKeyOptions, "owner">,
	): string | undefined {
		provider = resolveOAuthStorageProvider(provider);
		if (this.#runtimeOverrides.has(provider)) {
			return "runtime override (--api-key)";
		}
		const configOverride = this.#configOverrideRegistration(provider, options?.owner);
		if (configOverride) {
			// An `apiKeyEnv` indirection loses to a stored api_key credential
			// (see getApiKey); describe the credential that actually wins.
			const shadowed = this.#getStoredCredentials(provider).some(entry => entry.credential.type === "api_key");
			if (!configOverride.envSourced || !shadowed) {
				return "config override (models.yml)";
			}
		}

		const baseLabel = this.#sourceLabel ?? "local store";
		const stored = this.#getStoredCredentials(provider);
		if (stored.length === 0) {
			if (getEnvApiKey(provider)) return `env ${baseLabel ? `(fallback over ${baseLabel})` : ""}`.trim();
			if (this.#resolveFallback(provider, options?.owner) !== undefined) return `fallback resolver`;
			return undefined;
		}

		const session = sessionId ? this.#sessionLastCredential.get(provider)?.get(sessionId) : undefined;
		// Same selection logic as #selectCredentialByType for "no session" lookups: prefer
		// the type with stored credentials, lean OAuth before api_key. We don't run the
		// full round-robin here because describing the source shouldn't advance the index.
		const preferredType: AuthCredential["type"] =
			session?.type ?? (stored.some(entry => entry.credential.type === "oauth") ? "oauth" : "api_key");
		const typed = stored
			.map((entry, index) => ({ entry, index }))
			.filter(({ entry }) => entry.credential.type === preferredType);
		if (typed.length === 0) return baseLabel;
		const index = session?.index ?? typed[0].index;
		const chosen = stored[index] ?? typed[0].entry;
		const credential = chosen.credential;
		const identity =
			credential.type === "oauth"
				? (credential.email ?? credential.accountId ?? credential.projectId ?? `cred ${chosen.id}`)
				: `cred ${chosen.id}`;
		return `${baseLabel} · ${preferredType} #${chosen.id} (${identity})`;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// SqliteAuthCredentialStore
// ─────────────────────────────────────────────────────────────────────────────

/** Row shape for auth_credentials table queries */
type AuthRow = {
	id: number;
	provider: string;
	credential_type: string;
	data: string;
	disabled_cause: string | null;
	identity_key: string | null;
	revision: number;
};

type SerializedCredentialRecord = {
	credentialType: AuthCredential["type"];
	data: string;
	identityKey: string | null;
};

const AUTH_SCHEMA_VERSION = 5;
const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";

function normalizeStoredAccountId(accountId: string | null | undefined): string | null {
	const normalized = accountId?.trim();
	return normalized && normalized.length > 0 ? normalized : null;
}

function normalizeStoredEmail(email: string | null | undefined): string | null {
	const normalized = email?.trim().toLowerCase();
	return normalized && normalized.length > 0 ? normalized : null;
}

function normalizeStoredIdentityKey(identityKey: string | null | undefined): string | null {
	const normalized = identityKey?.trim();
	return normalized && normalized.length > 0 ? normalized : null;
}

function serializeCredential(provider: string, credential: AuthCredential): SerializedCredentialRecord | null {
	if (credential.type === "api_key") {
		return {
			credentialType: "api_key",
			data: JSON.stringify({ key: credential.key }),
			identityKey: null,
		};
	}
	if (credential.type === "oauth") {
		const { type: _type, ...rest } = credential;
		return {
			credentialType: "oauth",
			data: JSON.stringify(rest),
			identityKey: resolveCredentialIdentityKey(provider, credential),
		};
	}
	return null;
}

function deserializeCredential(row: AuthRow): AuthCredential | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(row.data);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	if (row.credential_type === "api_key") {
		const data = parsed as Record<string, unknown>;
		if (typeof data.key === "string") {
			return { type: "api_key", key: data.key };
		}
	}
	if (row.credential_type === "oauth") {
		return { type: "oauth", ...(parsed as Record<string, unknown>) } as AuthCredential;
	}
	return null;
}

function normalizeDisabledCause(disabledCause: string): string {
	const normalized = disabledCause
		.replace(/bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
		.replace(/(api[_-]?key|token|secret|authorization)[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
		.replace(/https?:\/\/[^\s?#]+\?[^\s]+/gi, value => value.split("?")[0] ?? "[redacted URL]")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 240);
	return normalized.length > 0 ? normalized : "disabled";
}

function toStoredAuthCredential(row: AuthRow, credential: AuthCredential): StoredAuthCredential {
	return { id: row.id, provider: row.provider, credential, disabledCause: row.disabled_cause, revision: row.revision };
}

function resolveProviderCredentialIdentityKey(provider: string, identifiers: string[]): string | null {
	const emailIdentifier = identifiers.find(identifier => identifier.startsWith("email:"));
	if ((provider === "openai-codex" || provider === "anthropic") && emailIdentifier) return emailIdentifier;
	const accountIdentifier = identifiers.find(identifier => identifier.startsWith("account:"));
	if (accountIdentifier) return accountIdentifier;
	if (emailIdentifier) return emailIdentifier;
	return null;
}

function resolveCredentialIdentityKey(provider: string, credential: AuthCredential): string | null {
	if (credential.type === "api_key") return null;
	return resolveProviderCredentialIdentityKey(provider, extractOAuthCredentialIdentifiers(credential));
}

function resolveRowCredentialIdentityKey(provider: string, row: AuthRow): string | null {
	const identityKey = normalizeStoredIdentityKey(row.identity_key);
	if (identityKey) return identityKey;
	const credential = deserializeCredential(row);
	return credential?.type === "oauth" ? resolveCredentialIdentityKey(provider, credential) : null;
}

function matchesReplacementCredential(
	provider: string,
	existing: AuthCredential | null,
	existingIdentityKey: string | null,
	incoming: AuthCredential,
): boolean {
	if (!existing || existing.type !== incoming.type) return false;
	if (incoming.type === "api_key") {
		return existing.type === "api_key" && existing.key === incoming.key;
	}
	const incomingIdentityKey = resolveCredentialIdentityKey(provider, incoming);
	return incomingIdentityKey !== null && incomingIdentityKey === existingIdentityKey;
}

function extractOAuthCredentialIdentifiers(credential: OAuthCredential): string[] {
	const identifiers = new Set<string>();
	const accountId = normalizeStoredAccountId(credential.accountId);
	if (accountId) identifiers.add(`account:${accountId}`);
	const email = normalizeStoredEmail(credential.email);
	if (email) identifiers.add(`email:${email}`);
	const accessIdentifiers = extractOAuthTokenIdentifiers(credential.access) ?? [];
	for (const identifier of accessIdentifiers) {
		identifiers.add(identifier);
	}
	const refreshIdentifiers = extractOAuthTokenIdentifiers(credential.refresh) ?? [];
	for (const identifier of refreshIdentifiers) {
		identifiers.add(identifier);
	}
	return [...identifiers];
}

function extractOAuthTokenIdentifiers(token: string | undefined): string[] | undefined {
	if (!token) return undefined;
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const payload = JSON.parse(
			new TextDecoder("utf-8").decode(Uint8Array.fromBase64(parts[1], { alphabet: "base64url" })),
		) as Record<string, unknown>;
		const identifiers = new Set<string>();
		const directEmail = normalizeStoredEmail(typeof payload.email === "string" ? payload.email : undefined);
		if (directEmail) identifiers.add(`email:${directEmail}`);
		const openAiProfile = payload["https://api.openai.com/profile"];
		if (typeof openAiProfile === "object" && openAiProfile !== null && !Array.isArray(openAiProfile)) {
			const claimEmail = normalizeStoredEmail(
				(openAiProfile as Record<string, unknown>).email as string | undefined,
			);
			if (claimEmail) identifiers.add(`email:${claimEmail}`);
		}
		const openAiAuth = payload["https://api.openai.com/auth"];
		const authClaims =
			typeof openAiAuth === "object" && openAiAuth !== null && !Array.isArray(openAiAuth)
				? (openAiAuth as Record<string, unknown>)
				: undefined;
		const accountId = normalizeStoredAccountId(
			typeof payload.account_id === "string"
				? payload.account_id
				: typeof payload.accountId === "string"
					? payload.accountId
					: typeof payload.user_id === "string"
						? payload.user_id
						: typeof payload.sub === "string"
							? payload.sub
							: typeof authClaims?.chatgpt_account_id === "string"
								? authClaims.chatgpt_account_id
								: undefined,
		);
		if (accountId) identifiers.add(`account:${accountId}`);
		return identifiers.size > 0 ? [...identifiers] : undefined;
	} catch {
		return undefined;
	}
}
/**
 * Default SQLite-backed implementation of {@link AuthCredentialStore}.
 *
 * Used by the pi-ai CLI and as the default store for `AuthStorage.create()`.
 * Also exposes convenience methods (`saveOAuth`, `getOAuth`, `saveApiKey`,
 * `getApiKey`, `listProviders`, `deleteProvider`) that callers can use directly
 * without going through `AuthStorage`.
 */
export class SqliteAuthCredentialStore implements AuthCredentialStore {
	#db: Database;
	#listActiveStmt: Statement;
	#listActiveByProviderStmt: Statement;
	#listAllStmt: Statement;
	#listAllByProviderStmt: Statement;
	#listDisabledByProviderStmt: Statement;
	#insertStmt: Statement;
	#updateStmt: Statement;
	#deleteStmt: Statement;
	#deleteIfMatchesStmt: Statement;
	#deleteIfRevisionStmt: Statement;
	#deleteByProviderStmt: Statement;
	#hardDeleteStmt: Statement;
	#getCacheStmt: Statement;
	#getCacheIncludingExpiredStmt: Statement;
	#upsertCacheStmt: Statement;
	#deleteCachePrefixStmt: Statement;
	#deleteExpiredCacheStmt: Statement;
	#closed = false;

	constructor(db: Database) {
		this.#db = db;
		this.#initializeSchema();

		this.#listActiveStmt = this.#db.prepare(
			"SELECT id, provider, credential_type, data, disabled_cause, identity_key, revision FROM auth_credentials WHERE disabled_cause IS NULL ORDER BY id ASC",
		);
		this.#listActiveByProviderStmt = this.#db.prepare(
			"SELECT id, provider, credential_type, data, disabled_cause, identity_key, revision FROM auth_credentials WHERE provider = ? AND disabled_cause IS NULL ORDER BY id ASC",
		);
		this.#listAllStmt = this.#db.prepare(
			"SELECT id, provider, credential_type, data, disabled_cause, identity_key, revision FROM auth_credentials ORDER BY id ASC",
		);
		this.#listAllByProviderStmt = this.#db.prepare(
			"SELECT id, provider, credential_type, data, disabled_cause, identity_key, revision FROM auth_credentials WHERE provider = ? ORDER BY id ASC",
		);
		this.#listDisabledByProviderStmt = this.#db.prepare(
			"SELECT id, provider, credential_type, data, disabled_cause, identity_key, revision FROM auth_credentials WHERE provider = ? AND disabled_cause IS NOT NULL ORDER BY id ASC",
		);
		this.#insertStmt = this.#db.prepare(
			`INSERT INTO auth_credentials (provider, credential_type, data, identity_key, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ${SQLITE_NOW_EPOCH}, ${SQLITE_NOW_EPOCH}) RETURNING id`,
		);
		this.#updateStmt = this.#db.prepare(
			`UPDATE auth_credentials SET credential_type = ?, data = ?, identity_key = ?, revision = revision + 1, updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ?`,
		);
		this.#deleteStmt = this.#db.prepare(
			`UPDATE auth_credentials SET disabled_cause = ?, revision = revision + 1, updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ?`,
		);
		this.#deleteIfMatchesStmt = this.#db.prepare(
			`UPDATE auth_credentials SET disabled_cause = ?, revision = revision + 1, updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ? AND data = ? AND disabled_cause IS NULL`,
		);
		this.#deleteIfRevisionStmt = this.#db.prepare(
			`UPDATE auth_credentials SET disabled_cause = ?, revision = revision + 1, updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ? AND revision = ? AND disabled_cause IS NULL`,
		);
		this.#deleteByProviderStmt = this.#db.prepare(
			`UPDATE auth_credentials SET disabled_cause = ?, revision = revision + 1, updated_at = ${SQLITE_NOW_EPOCH} WHERE provider = ? AND disabled_cause IS NULL`,
		);
		this.#hardDeleteStmt = this.#db.prepare("DELETE FROM auth_credentials WHERE id = ?");
		this.#getCacheStmt = this.#db.prepare(
			`SELECT value FROM cache WHERE key = ? AND expires_at > ${SQLITE_NOW_EPOCH}`,
		);
		this.#getCacheIncludingExpiredStmt = this.#db.prepare("SELECT value FROM cache WHERE key = ?");
		this.#upsertCacheStmt = this.#db.prepare(
			"INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
		);
		this.#deleteCachePrefixStmt = this.#db.prepare("DELETE FROM cache WHERE substr(key, 1, ?) = ?");
		this.#deleteExpiredCacheStmt = this.#db.prepare(`DELETE FROM cache WHERE expires_at <= ${SQLITE_NOW_EPOCH}`);
	}

	static async open(dbPath: string = getAgentDbPath()): Promise<SqliteAuthCredentialStore> {
		const dir = path.dirname(dbPath);
		const dirExists = await fs
			.stat(dir)
			.then(s => s.isDirectory())
			.catch(() => false);
		if (!dirExists) {
			await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		}

		const db = new Database(dbPath);
		try {
			await fs.chmod(dbPath, 0o600);
		} catch {
			// Ignore chmod failures (e.g., Windows)
		}

		return new SqliteAuthCredentialStore(db);
	}

	#initializeSchema(): void {
		// Apply busy_timeout FIRST: `PRAGMA journal_mode=WAL` needs a brief
		// exclusive lock, and without an active busy_timeout a concurrent writer
		// makes it fail immediately with SQLITE_BUSY (deterministic on Windows,
		// where file locks are mandatory).
		this.#db.run("PRAGMA busy_timeout=5000");
		this.#db.run(`
			PRAGMA journal_mode=WAL;
			PRAGMA synchronous=NORMAL;
			CREATE TABLE IF NOT EXISTS auth_schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS cache (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				expires_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at);
			CREATE TABLE IF NOT EXISTS oauth_refresh_leases (
				credential_id INTEGER PRIMARY KEY,
				owner TEXT NOT NULL,
				token_fingerprint TEXT NOT NULL,
				expires_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_oauth_refresh_leases_expires ON oauth_refresh_leases(expires_at);
		`);

		if (!this.#authCredentialsTableExists()) {
			this.#createAuthCredentialsTable();
			this.#writeAuthSchemaVersion(AUTH_SCHEMA_VERSION);
			return;
		}

		const schemaVersion = this.#readAuthSchemaVersion() ?? this.#inferAuthSchemaVersion();
		const shouldWriteSchemaVersion = schemaVersion <= AUTH_SCHEMA_VERSION;
		if (schemaVersion > AUTH_SCHEMA_VERSION) {
			logger.warn("SqliteAuthCredentialStore schema version mismatch", {
				current: schemaVersion,
				expected: AUTH_SCHEMA_VERSION,
			});
		} else if (schemaVersion < AUTH_SCHEMA_VERSION) {
			this.#migrateAuthSchema(schemaVersion);
		}

		this.#createAuthCredentialIndexes();
		this.#backfillCredentialIdentityKeys();
		if (shouldWriteSchemaVersion) {
			this.#writeAuthSchemaVersion(AUTH_SCHEMA_VERSION);
		}
	}

	#authCredentialsTableExists(): boolean {
		const row = this.#db
			.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'auth_credentials'")
			.get() as { present?: number } | undefined;
		return row?.present === 1;
	}

	#readAuthSchemaVersion(): number | null {
		const row = this.#db.prepare("SELECT version FROM auth_schema_version WHERE id = 1").get() as
			| { version?: number }
			| undefined;
		return typeof row?.version === "number" ? row.version : null;
	}

	#writeAuthSchemaVersion(version: number): void {
		this.#db.prepare("INSERT OR REPLACE INTO auth_schema_version(id, version) VALUES (1, ?)").run(version);
	}

	#inferAuthSchemaVersion(): number {
		const cols = this.#db.prepare("PRAGMA table_info(auth_credentials)").all() as Array<{ name?: string }>;
		const hasDisabledCause = cols.some(column => column.name === "disabled_cause");
		const hasIdentityKey = cols.some(column => column.name === "identity_key");
		const hasAccountId = cols.some(column => column.name === "account_id");
		const hasEmail = cols.some(column => column.name === "email");
		if (hasIdentityKey) return 3;
		if (hasAccountId || hasEmail) return 2;
		if (hasDisabledCause) return 1;
		return 0;
	}

	#createAuthCredentialsTable(): void {
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT DEFAULT NULL,
				identity_key TEXT DEFAULT NULL,
				revision INTEGER NOT NULL DEFAULT 1,
				created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
				updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
			);
		`);
		this.#createAuthCredentialIndexes();
	}

	#createAuthCredentialIndexes(): void {
		this.#db.run(`
			CREATE INDEX IF NOT EXISTS idx_auth_provider ON auth_credentials(provider);
			CREATE INDEX IF NOT EXISTS idx_auth_provider_identity ON auth_credentials(provider, identity_key) WHERE identity_key IS NOT NULL;
		`);
	}

	#migrateAuthSchema(fromVersion: number): void {
		if (fromVersion < 1) {
			this.#migrateAuthSchemaV0ToV1();
		}
		if (fromVersion < 3) {
			this.#migrateAuthSchemaV1OrV2ToV3();
		}
		if (fromVersion < 4) {
			this.#migrateAuthSchemaV3ToV4();
		}
		if (fromVersion < 5) {
			this.#migrateAuthSchemaV4ToV5();
		}
	}

	#migrateAuthSchemaV0ToV1(): void {
		const migrate = this.#db.transaction(() => {
			const v0Cols = this.#db.prepare("PRAGMA table_info(auth_credentials)").all() as Array<{ name?: string }>;
			const hasDisabled = v0Cols.some(col => col.name === "disabled");

			this.#db.run("ALTER TABLE auth_credentials RENAME TO auth_credentials_v0");
			this.#db.run(`
				CREATE TABLE auth_credentials (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					provider TEXT NOT NULL,
					credential_type TEXT NOT NULL,
					data TEXT NOT NULL,
					disabled_cause TEXT DEFAULT NULL,
					created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
					updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
				);
			`);
			this.#db.run(`
				INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause, created_at, updated_at)
				SELECT
					id,
					provider,
					credential_type,
					data,
					${hasDisabled ? "CASE WHEN disabled = 1 THEN 'disabled' ELSE NULL END" : "NULL"},
					created_at,
					updated_at
				FROM auth_credentials_v0
			`);
			this.#db.run("DROP TABLE auth_credentials_v0");
		});
		migrate();
	}

	#migrateAuthSchemaV1OrV2ToV3(): void {
		const migrate = this.#db.transaction(() => {
			this.#db.run("ALTER TABLE auth_credentials RENAME TO auth_credentials_legacy");
			this.#createAuthCredentialsTable();
			this.#db.run(`
				INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at)
				SELECT
					id,
					provider,
					credential_type,
					data,
					disabled_cause,
					NULL,
					created_at,
					updated_at
				FROM auth_credentials_legacy
			`);
			this.#db.run("DROP TABLE auth_credentials_legacy");
		});
		migrate();
	}

	#migrateAuthSchemaV3ToV4(): void {
		const migrate = this.#db.transaction(() => {
			this.#db.run("ALTER TABLE auth_credentials RENAME TO auth_credentials_v3");
			this.#createAuthCredentialsTable();
			this.#db.run(`
				INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at)
				SELECT
					id,
					provider,
					credential_type,
					data,
					disabled_cause,
					identity_key,
					created_at,
					updated_at
				FROM auth_credentials_v3
			`);
			this.#db.run("DROP TABLE auth_credentials_v3");
		});
		migrate();
	}
	#migrateAuthSchemaV4ToV5(): void {
		const columns = this.#db.prepare("PRAGMA table_info(auth_credentials)").all() as Array<{ name?: string }>;
		if (columns.some(column => column.name === "revision")) return;
		this.#db.run("ALTER TABLE auth_credentials ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
	}

	#backfillCredentialIdentityKeys(): void {
		const rows = this.#db
			.prepare(
				"SELECT id, provider, credential_type, data, disabled_cause, identity_key, revision FROM auth_credentials WHERE identity_key IS NULL ORDER BY id ASC",
			)
			.all() as AuthRow[];
		if (rows.length === 0) return;

		const updateIdentity = this.#db.prepare("UPDATE auth_credentials SET identity_key = ? WHERE id = ?");
		for (const row of rows) {
			const identityKey = resolveRowCredentialIdentityKey(row.provider, row);
			updateIdentity.run(identityKey, row.id);
		}
	}

	// ─── AuthCredentialStore interface ──────────────────────────────────────

	listAuthCredentials(provider?: string): StoredAuthCredential[] {
		const rows =
			(provider
				? (this.#listActiveByProviderStmt.all(provider) as AuthRow[])
				: (this.#listActiveStmt.all() as AuthRow[])) ?? [];

		const results: StoredAuthCredential[] = [];
		for (const row of rows) {
			const credential = deserializeCredential(row);
			if (!credential) continue;
			results.push(toStoredAuthCredential(row, credential));
		}
		return results;
	}

	listCredentialInventory(provider?: string): CredentialInventoryRecord[] {
		const rows =
			provider === undefined
				? (this.#listAllStmt.all() as AuthRow[])
				: (this.#listAllByProviderStmt.all(provider) as AuthRow[]);
		const results: CredentialInventoryRecord[] = [];
		for (const row of rows) {
			const credential = deserializeCredential(row);
			if (!credential) continue;
			const identityLabel =
				credential.type === "oauth"
					? (credential.email ?? credential.accountId ?? credential.projectId ?? null)
					: null;
			results.push({
				id: row.id,
				provider: row.provider,
				credentialKind: credential.type,
				identityLabel,
				...(credential.type === "oauth" && credential.accountId ? { accountId: credential.accountId } : {}),
				...(credential.type === "oauth" && credential.email ? { email: credential.email } : {}),
				...(credential.type === "oauth" && credential.projectId ? { projectId: credential.projectId } : {}),
				disabled: row.disabled_cause !== null,
				disabledCause: row.disabled_cause,
			});
		}
		return results;
	}

	listCredentialRemovalTargets(provider?: string): CredentialRemovalTarget[] {
		const rows =
			provider === undefined
				? (this.#listAllStmt.all() as AuthRow[])
				: (this.#listAllByProviderStmt.all(provider) as AuthRow[]);
		return rows.map(row => ({ id: row.id, provider: row.provider, expectedRevision: row.revision }));
	}
	removeAuthCredentialsHard(
		provider: string,
		targets: readonly CredentialRemovalTarget[],
	): AuthCredentialHardRemovalResult {
		const unique = [...new Map(targets.map(target => [target.id, target])).values()];
		const remove = this.#db.transaction((): AuthCredentialHardRemovalResult => {
			const currentIds: number[] = [];
			for (const target of unique) {
				const row = this.#db
					.prepare("SELECT id, provider, credential_type, revision FROM auth_credentials WHERE id = ?")
					.get(target.id) as
					| { id?: number; provider?: string; credential_type?: string; revision?: number }
					| undefined;
				if (!row || row.provider !== provider || row.revision !== target.expectedRevision) {
					currentIds.push(row?.id ?? target.id);
				}
			}
			if (currentIds.length > 0) return { kind: "conflict", currentIds };
			for (const target of unique) {
				this.#hardDeleteStmt.run(target.id);
				this.#db.prepare("DELETE FROM oauth_refresh_leases WHERE credential_id = ?").run(target.id);
				this.#db.prepare("DELETE FROM cache WHERE key = ?").run(`${HEALTH_CACHE_PREFIX}${target.id}`);
			}
			this.#db
				.prepare("DELETE FROM cache WHERE substr(key, 1, ?) = ?")
				.run(`usage_cache:report:${provider}:`.length, `usage_cache:report:${provider}:`);
			return { kind: "removed", ids: unique.map(target => target.id) };
		});
		return remove();
	}
	claimOAuthRefreshLease(
		credentialId: number,
		expectedRefresh: string,
		force: boolean,
		owner: string,
		nowMs: number,
		leaseMs: number,
	): OAuthRefreshLeaseClaim {
		const claim = this.#db.transaction((): OAuthRefreshLeaseClaim => {
			const row = this.#db
				.prepare(
					"SELECT id, provider, credential_type, data, disabled_cause, identity_key, revision FROM auth_credentials WHERE id = ? AND disabled_cause IS NULL",
				)
				.get(credentialId) as AuthRow | undefined;
			const credential = row ? deserializeCredential(row) : null;
			if (credential?.type !== "oauth") return { kind: "missing" };
			if (!force && credential.refresh !== expectedRefresh && nowMs + OAUTH_REFRESH_SKEW_MS < credential.expires) {
				return { kind: "adopted", credential };
			}
			const active = this.#db
				.prepare("SELECT owner, expires_at FROM oauth_refresh_leases WHERE credential_id = ?")
				.get(credentialId) as { owner?: string; expires_at?: number } | undefined;
			if (typeof active?.expires_at === "number" && active.expires_at > nowMs) {
				if (active.owner === owner) {
					this.#db
						.prepare("UPDATE oauth_refresh_leases SET expires_at = ? WHERE credential_id = ? AND owner = ?")
						.run(nowMs + leaseMs, credentialId, owner);
					return {
						kind: "claimed",
						credential,
						lease: {
							credentialId,
							owner,
							tokenFingerprint: crypto.createHash("sha256").update(credential.refresh).digest("hex"),
						},
					};
				}
				return { kind: "busy", expiresAt: active.expires_at };
			}

			this.#db.prepare("DELETE FROM oauth_refresh_leases WHERE credential_id = ?").run(credentialId);
			const tokenFingerprint = crypto.createHash("sha256").update(credential.refresh).digest("hex");
			this.#db
				.prepare(
					"INSERT INTO oauth_refresh_leases (credential_id, owner, token_fingerprint, expires_at) VALUES (?, ?, ?, ?)",
				)
				.run(credentialId, owner, tokenFingerprint, nowMs + leaseMs);
			return { kind: "claimed", credential, lease: { credentialId, owner, tokenFingerprint } };
		});
		return claim();
	}

	completeOAuthRefreshLease(lease: OAuthRefreshLease, credential: OAuthCredential): boolean {
		const serialized = serializeCredential(
			(
				this.#db.prepare("SELECT provider FROM auth_credentials WHERE id = ?").get(lease.credentialId) as
					| { provider?: string }
					| undefined
			)?.provider ?? "",
			credential,
		);
		if (!serialized) return false;
		const complete = this.#db.transaction(() => {
			const leaseRow = this.#db
				.prepare("SELECT owner, token_fingerprint FROM oauth_refresh_leases WHERE credential_id = ?")
				.get(lease.credentialId) as { owner?: string; token_fingerprint?: string } | undefined;
			if (leaseRow?.owner !== lease.owner || leaseRow.token_fingerprint !== lease.tokenFingerprint) return false;
			const row = this.#db
				.prepare("SELECT data FROM auth_credentials WHERE id = ? AND disabled_cause IS NULL")
				.get(lease.credentialId) as { data?: string } | undefined;
			if (
				!row ||
				crypto
					.createHash("sha256")
					.update((JSON.parse(row.data ?? "{}") as { refresh?: string }).refresh ?? "")
					.digest("hex") !== lease.tokenFingerprint
			)
				return false;
			this.#updateStmt.run(serialized.credentialType, serialized.data, serialized.identityKey, lease.credentialId);
			this.#db
				.prepare("DELETE FROM oauth_refresh_leases WHERE credential_id = ? AND owner = ?")
				.run(lease.credentialId, lease.owner);
			return true;
		});
		return complete();
	}

	releaseOAuthRefreshLease(lease: OAuthRefreshLease): void {
		this.#db
			.prepare("DELETE FROM oauth_refresh_leases WHERE credential_id = ? AND owner = ?")
			.run(lease.credentialId, lease.owner);
	}

	replaceAuthCredentialsForProvider(provider: string, credentials: AuthCredential[]): StoredAuthCredential[] {
		const replace = this.#db.transaction((providerName: string, items: AuthCredential[]) => {
			const existingRows = this.#listActiveByProviderStmt.all(providerName) as AuthRow[];
			const existing = existingRows.map(row => ({
				id: row.id,
				credential: deserializeCredential(row),
				identityKey: resolveRowCredentialIdentityKey(providerName, row),
				revision: row.revision,
			}));

			const result: StoredAuthCredential[] = [];
			const matchedExistingIds = new Set<number>();

			for (const credential of items) {
				const serialized = serializeCredential(providerName, credential);
				if (!serialized) continue;
				const match = existing.find(
					entry =>
						!matchedExistingIds.has(entry.id) &&
						matchesReplacementCredential(providerName, entry.credential, entry.identityKey, credential),
				);
				if (match) {
					matchedExistingIds.add(match.id);
					this.#updateStmt.run(serialized.credentialType, serialized.data, serialized.identityKey, match.id);
					result.push({
						id: match.id,
						provider: providerName,
						credential,
						disabledCause: null,
						revision: match.revision + 1,
					});
				} else {
					const row = this.#insertStmt.get(
						providerName,
						serialized.credentialType,
						serialized.data,
						serialized.identityKey,
					) as { id?: number } | undefined;
					if (row?.id) {
						result.push({ id: row.id, provider: providerName, credential, disabledCause: null, revision: 1 });
					}
				}
			}

			for (const row of existing) {
				if (!matchedExistingIds.has(row.id)) {
					this.#deleteStmt.run("replaced by newer credential", row.id);
				}
			}

			return result;
		});

		const result = replace(provider, credentials);
		this.#purgeSupersededDisabledRows(provider, result);
		return result;
	}

	upsertAuthCredentialForProvider(provider: string, credential: AuthCredential): StoredAuthCredential[] {
		const upsert = this.#db.transaction((providerName: string, item: AuthCredential) => {
			const serialized = serializeCredential(providerName, item);
			if (!serialized) return this.listAuthCredentials(providerName);
			const existingRows = this.#listActiveByProviderStmt.all(providerName) as AuthRow[];
			const existing = existingRows.map(row => ({
				id: row.id,
				credential: deserializeCredential(row),
				identityKey: resolveRowCredentialIdentityKey(providerName, row),
			}));

			let targetId: number | null = null;
			for (const row of existing) {
				if (!matchesReplacementCredential(providerName, row.credential, row.identityKey, item)) continue;
				if (targetId === null) {
					targetId = row.id;
					this.#updateStmt.run(serialized.credentialType, serialized.data, serialized.identityKey, row.id);
					continue;
				}
				this.#deleteStmt.run("replaced by newer credential", row.id);
			}

			if (targetId === null) {
				const row = this.#insertStmt.get(
					providerName,
					serialized.credentialType,
					serialized.data,
					serialized.identityKey,
				) as { id?: number } | undefined;
				targetId = row?.id ?? null;
			}

			const activeRows = this.#listActiveByProviderStmt.all(providerName) as AuthRow[];
			const result: StoredAuthCredential[] = [];
			for (const row of activeRows) {
				const activeCredential = deserializeCredential(row);
				if (!activeCredential) continue;
				result.push(toStoredAuthCredential(row, activeCredential));
			}
			return result;
		});

		const result = upsert(provider, credential);
		this.#purgeSupersededDisabledRows(provider, result);
		return result;
	}

	upsertAuthCredentialForProviderIfAbsent(provider: string, credential: AuthCredential): AuthCredentialIfAbsentResult {
		let serialized: SerializedCredentialRecord | null;
		try {
			serialized = serializeCredential(provider, credential);
		} catch {
			serialized = null;
		}
		if (!serialized) {
			return {
				inserted: false,
				reason: "skipped-invalid",
				provider,
				entries: this.listAuthCredentials(provider),
			};
		}

		const writeIfAbsent = this.#db.transaction(
			(
				providerName: string,
				item: AuthCredential,
				record: SerializedCredentialRecord,
			): AuthCredentialIfAbsentResult => {
				const existingRows = this.#listActiveByProviderStmt.all(providerName) as AuthRow[];
				const existing: Array<{
					id: number;
					credential: AuthCredential;
					identityKey: string | null;
					revision: number;
				}> = [];
				for (const row of existingRows) {
					const activeCredential = deserializeCredential(row);
					if (!activeCredential) continue;
					existing.push({
						id: row.id,
						credential: activeCredential,
						identityKey: resolveRowCredentialIdentityKey(providerName, row),
						revision: row.revision,
					});
				}
				if (existing.length > 0) {
					let targetId: number | null = null;
					for (const row of existing) {
						if (!matchesReplacementCredential(providerName, row.credential, row.identityKey, item)) continue;
						if (targetId === null) {
							targetId = row.id;
							this.#updateStmt.run(record.credentialType, record.data, record.identityKey, row.id);
						} else {
							this.#deleteStmt.run("replaced by newer credential", row.id);
						}
					}

					if (targetId !== null) {
						return {
							inserted: true,
							reason: "updated-existing",
							provider: providerName,
							entries: this.listAuthCredentials(providerName),
						};
					}

					return {
						inserted: false,
						reason: "skipped-existing",
						provider: providerName,
						entries: existing.map(row => ({
							id: row.id,
							provider: providerName,
							credential: row.credential,
							disabledCause: null,
							revision: row.revision,
						})),
					};
				}

				this.#insertStmt.get(providerName, record.credentialType, record.data, record.identityKey);
				return {
					inserted: true,
					reason: "inserted",
					provider: providerName,
					entries: this.listAuthCredentials(providerName),
				};
			},
		);

		const result = writeIfAbsent.immediate(provider, credential, serialized);
		if (result.inserted) this.#purgeSupersededDisabledRows(provider, result.entries);
		return result;
	}

	/**
	 * Hard-deletes disabled rows for a provider when an active row with the same identity exists.
	 * This prevents unbounded accumulation of soft-deleted credentials while preserving
	 * disabled rows that have no active replacement (safety net for recovery).
	 */
	#purgeSupersededDisabledRows(provider: string, activeRows: StoredAuthCredential[]): void {
		try {
			const activeIdentityKeys = new Set<string>();
			for (const row of activeRows) {
				const identityKey = resolveCredentialIdentityKey(provider, row.credential);
				if (identityKey) activeIdentityKeys.add(identityKey);
			}
			if (activeIdentityKeys.size === 0) return;

			const disabledRows = this.#listDisabledByProviderStmt.all(provider) as AuthRow[];
			for (const row of disabledRows) {
				const identityKey = resolveRowCredentialIdentityKey(provider, row);
				if (identityKey && activeIdentityKeys.has(identityKey)) {
					this.#hardDeleteStmt.run(row.id);
				}
			}
		} catch {
			// Best-effort cleanup; don't let it break the main operation
		}
	}

	updateAuthCredential(id: number, credential: AuthCredential): void {
		const providerRow = this.#db.prepare("SELECT provider FROM auth_credentials WHERE id = ?").get(id) as
			| { provider?: string }
			| undefined;
		const provider = providerRow?.provider ?? "";
		const serialized = serializeCredential(provider, credential);
		if (!serialized) return;
		this.#updateStmt.run(serialized.credentialType, serialized.data, serialized.identityKey, id);
		if (provider) {
			this.#purgeSupersededDisabledRows(provider, this.listAuthCredentials(provider));
		}
	}

	deleteAuthCredential(id: number, disabledCause: string): void {
		try {
			this.#deleteStmt.run(normalizeDisabledCause(disabledCause), id);
		} catch {
			// Ignore delete failures
		}
	}

	/**
	 * CAS-style disable: only soft-deletes the row when its `data` column still
	 * matches `expectedData` and the row has not already been disabled. Used by
	 * the OAuth refresh-failure path to avoid clobbering a peer that rotated the
	 * row between our pre-check and the disable.
	 */
	tryDisableAuthCredentialIfMatches(id: number, expectedData: string, disabledCause: string): boolean {
		try {
			const result = this.#deleteIfMatchesStmt.run(normalizeDisabledCause(disabledCause), id, expectedData) as {
				changes: number;
			};
			return result.changes === 1;
		} catch {
			return false;
		}
	}

	tryDisableAuthCredentialIfRevision(id: number, expectedRevision: number, disabledCause: string): boolean {
		try {
			const result = this.#deleteIfRevisionStmt.run(normalizeDisabledCause(disabledCause), id, expectedRevision) as {
				changes: number;
			};
			return result.changes === 1;
		} catch {
			return false;
		}
	}

	deleteAuthCredentialsForProvider(provider: string, disabledCause: string): void {
		try {
			this.#deleteByProviderStmt.run(normalizeDisabledCause(disabledCause), provider);
		} catch {
			// Ignore delete failures
		}
	}

	getCache(key: string, options?: { includeExpired?: boolean }): string | null {
		try {
			const stmt = options?.includeExpired === true ? this.#getCacheIncludingExpiredStmt : this.#getCacheStmt;
			const row = stmt.get(key) as { value?: string } | undefined;
			return row?.value ?? null;
		} catch {
			return null;
		}
	}

	setCache(key: string, value: string, expiresAtSec: number): void {
		try {
			this.#upsertCacheStmt.run(key, value, expiresAtSec);
		} catch {
			// Ignore cache set failures
		}
	}

	allocateMonotonicSequence(key: string, expiresAtSec: number): number {
		const allocate = this.#db.transaction(() => {
			const row = this.#getCacheIncludingExpiredStmt.get(key) as { value?: string } | undefined;
			const current = Number(row?.value);
			const next = Number.isSafeInteger(current) && current >= 0 ? current + 1 : 1;
			this.#upsertCacheStmt.run(key, String(next), expiresAtSec);
			return next;
		});
		return allocate();
	}

	deleteCachePrefix(prefix: string): void {
		if (prefix.length === 0) return;
		try {
			this.#deleteCachePrefixStmt.run(prefix.length, prefix);
		} catch {}
	}

	cleanExpiredCache(): void {
		try {
			this.#deleteExpiredCacheStmt.run();
		} catch {
			// Ignore cleanup errors
		}
	}

	// ─── Convenience methods for CLI ────────────────────────────────────────

	/**
	 * Save OAuth credentials for a provider.
	 * Preserves unrelated identities and replaces only the matching credential.
	 */
	saveOAuth(provider: string, credentials: OAuthCredentials): void {
		const credential: AuthCredential = { type: "oauth", ...credentials };
		this.upsertAuthCredentialForProvider(provider, credential);
	}

	/**
	 * Get OAuth credentials for a provider.
	 */
	getOAuth(provider: string): OAuthCredentials | null {
		const rows = this.#listActiveByProviderStmt.all(provider) as AuthRow[];
		for (const row of rows) {
			const credential = deserializeCredential(row);
			if (credential && credential.type === "oauth") {
				const { type: _type, ...oauth } = credential;
				return oauth as OAuthCredentials;
			}
		}
		return null;
	}

	/**
	 * Save API key for a provider (replaces existing).
	 */
	saveApiKey(provider: string, apiKey: string): void {
		const credential: AuthCredential = { type: "api_key", key: apiKey };
		this.replaceAuthCredentialsForProvider(provider, [credential]);
	}

	/**
	 * Get API key for a provider.
	 */
	getApiKey(provider: string): string | null {
		const rows = this.#listActiveByProviderStmt.all(provider) as AuthRow[];
		for (const row of rows) {
			const credential = deserializeCredential(row);
			if (credential && credential.type === "api_key") {
				return credential.key;
			}
		}
		return null;
	}

	/**
	 * List all providers with credentials.
	 */
	listProviders(): string[] {
		const rows = this.#listActiveStmt.all() as AuthRow[];
		const providers = new Set<string>();
		for (const row of rows) {
			providers.add(row.provider);
		}
		return Array.from(providers);
	}

	/**
	 * Delete all credentials for a provider.
	 */
	deleteProvider(provider: string): void {
		this.deleteAuthCredentialsForProvider(provider, "deleted by user");
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#listActiveStmt.finalize();
		this.#listActiveByProviderStmt.finalize();
		this.#listAllStmt.finalize();
		this.#listAllByProviderStmt.finalize();
		this.#listDisabledByProviderStmt.finalize();
		this.#insertStmt.finalize();
		this.#updateStmt.finalize();
		this.#deleteStmt.finalize();
		this.#deleteIfMatchesStmt.finalize();
		this.#deleteIfRevisionStmt.finalize();
		this.#deleteByProviderStmt.finalize();
		this.#hardDeleteStmt.finalize();
		this.#getCacheStmt.finalize();
		this.#getCacheIncludingExpiredStmt.finalize();
		this.#upsertCacheStmt.finalize();
		this.#deleteCachePrefixStmt.finalize();
		this.#deleteExpiredCacheStmt.finalize();
		this.#db.close();
	}
}

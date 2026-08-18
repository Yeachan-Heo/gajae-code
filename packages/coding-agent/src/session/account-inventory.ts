import {
	type AuthStorage,
	type CachedCredentialHealth,
	type CachedUsageReport,
	type CredentialHealthResult,
	type CredentialInventoryRecord,
	getEnvApiKey,
	listProvidersWithEnvKey,
	type Provider,
	type UsageLimit,
	type UsageStatus,
	type UsageUnit,
	type UsageWindow,
} from "@gajae-code/ai/core";
import type { RawSettings, Settings, SettingsAtomicPatch } from "../config/settings";
import { parsePersistedCredentialSelector } from "./startup-auth-config";

/** A redacted usage observation attached to an account row. */
export interface AccountUsageCache extends CachedUsageReport {}

/** Safe account health state used by presentation surfaces. */
export interface AccountHealthCache extends CachedCredentialHealth {}

export type AccountInventorySource = "stored" | "env" | "config" | "runtime";

/** Fixed presentation classification for a persisted disabled credential. */
export type AccountInventoryDisabledCause = "auth_failure" | "user_removed" | "duplicate" | "replaced" | "unknown";

export interface AccountInventoryCapabilities {
	canCheck: boolean;
	canPin: boolean;
	canRemove: boolean;
	hasCachedUsage: boolean;
}

export interface AccountInventoryRouting {
	/** True when this row is the session's last recorded stored credential. */
	active: boolean;
	/** True when this source is the effective source for the provider/session. */
	selected: boolean;
	marker: "active" | "selected" | "available";
}

/**
 * Payload-free account row for renderers. This type deliberately has no
 * AuthCredential, API-key bytes, access token, refresh token, or raw usage.
 */
export interface AccountInventoryRow {
	/** Stable, non-secret presentation id. */
	id: string;
	/** Numeric storage id when this is a persisted row. */
	credentialId?: number;
	provider: string;
	credentialKind: "oauth" | "api_key";
	source: AccountInventorySource;
	sourceLabel: string;
	identityLabel: string | null;
	/** OAuth identity is intentionally limited to safe labels from inventory. */
	oauthIdentity?: { label: string };
	disabled: boolean;
	disabledCause: AccountInventoryDisabledCause | null;
	health: AccountHealthCache;
	usage?: AccountUsageCache;
	capabilities: AccountInventoryCapabilities;
	routing: AccountInventoryRouting;
}

export interface AccountInventorySnapshot {
	generatedAt: number;
	generation: number;
	rows: AccountInventoryRow[];
}

export interface AccountInventoryInput {
	authStorage: AuthStorage;
	modelRegistry?: {
		getAvailable?: () => Array<{ provider: string }>;
		getProviderBaseUrl?: (provider: string) => string | undefined;
	};
	sessionId?: string;
	provider?: string;
	nowMs?: number;
}

type SyntheticAccountSource = Exclude<AccountInventorySource, "stored">;

/** Source-scoped cache hooks supplied by AuthStorage. */
interface SourceHealthStorage {
	peekCachedCredentialHealthForSource: (provider: string, source: SyntheticAccountSource) => CachedCredentialHealth;
	recordCredentialHealthForSource: (
		provider: string,
		source: SyntheticAccountSource,
		health: CachedCredentialHealth,
	) => void;
}

export interface AccountInventoryCheckResult {
	rowId: string;
	provider: string;
	credentialId?: number;
	ok: boolean | null;
	reason?: string;
}

function asSafeLabel(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, " ")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, " ")
		.replace(/bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
		.replace(/(api[_-]?key|token|secret|authorization)[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
		.replace(/https?:\/\/[^\s?#]+(?:\?[^\s#]*)?/gi, value => value.split("?")[0] ?? "[redacted URL]")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/[\u061c\u200e\u200f\u200b-\u200d\u2060\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return normalized.length > 0 ? normalized.slice(0, 160) : null;
}

function safeProvider(value: unknown): string {
	return asSafeLabel(value) ?? "unknown-provider";
}

function optionalSafeLabel(value: unknown): string | undefined {
	return asSafeLabel(value) ?? undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function classifyDisabledCause(value: unknown, disabled: boolean): AccountInventoryDisabledCause | null {
	if (!disabled) return null;
	if (typeof value !== "string") return "unknown";
	const cause = value.trim();
	if (/^(?:deleted|logged out) by user(?:$|\b)/i.test(cause) || /^disabled via auth-broker$/i.test(cause)) {
		return "user_removed";
	}
	if (/^deduplicated duplicate credential$/i.test(cause)) return "duplicate";
	if (/^replaced by newer credential$/i.test(cause)) return "replaced";
	if (
		/^(?:oauth|auth-broker) refresh failed:/i.test(cause) ||
		/invalid_grant|grant is invalid|invalid_token|revoked|unauthorized|expired.*refresh|refresh.*expired/i.test(
			cause,
		) ||
		(/\b(401|403)\b/.test(cause) && !/timeout|network|fetch failed|ECONNREFUSED/i.test(cause))
	) {
		return "auth_failure";
	}
	return "unknown";
}
function sourceId(provider: string, source: AccountInventorySource, credentialId?: number): string {
	const safe = safeProvider(provider);
	return credentialId === undefined ? `${safe}:${source}` : `${safe}:stored:${credentialId}`;
}

function sourceLabel(source: AccountInventorySource): string {
	switch (source) {
		case "stored":
			return "stored credential";
		case "env":
			return "environment API key";
		case "config":
			return "config API key";
		case "runtime":
			return "runtime API key";
	}
}

function providerSet(input: AccountInventoryInput, inventory: CredentialInventoryRecord[]): Set<string> {
	const providers = new Set(inventory.flatMap(row => (typeof row.provider === "string" ? [row.provider] : [])));
	for (const provider of input.modelRegistry?.getAvailable?.() ?? []) {
		if (typeof provider?.provider === "string") providers.add(provider.provider);
	}
	// This only asks whether a known env-backed provider is present. The key value
	// never enters the snapshot or any renderer.
	for (const provider of listProvidersWithEnvKey()) {
		if (getEnvApiKey(provider)) providers.add(provider);
	}
	return providers;
}

function storedHealth(authStorage: AuthStorage, row: CredentialInventoryRecord): AccountHealthCache {
	const cached = asRecord(authStorage.getCachedCredentialHealth(row.id));
	if (row.disabled) return { status: "failed", reason: null };
	const status: AccountHealthCache["status"] =
		cached?.status === "ok" ||
		cached?.status === "failed" ||
		cached?.status === "unverifiable" ||
		cached?.status === "unknown"
			? cached.status
			: "unknown";
	return {
		status,
		reason: asSafeLabel(cached?.reason),
		...(finiteNumber(cached?.checkedAt) !== undefined ? { checkedAt: finiteNumber(cached?.checkedAt) } : {}),
		...(finiteNumber(cached?.retainUntil) !== undefined ? { retainUntil: finiteNumber(cached?.retainUntil) } : {}),
	};
}

function storedUsage(
	authStorage: AuthStorage,
	row: CredentialInventoryRecord,
	baseUrl?: string,
): AccountUsageCache | undefined {
	return authStorage.getCachedUsageReport(row.provider as Provider, row.id, baseUrl);
}

function safeUsageUnit(value: unknown): UsageUnit {
	return value === "percent" ||
		value === "tokens" ||
		value === "requests" ||
		value === "usd" ||
		value === "minutes" ||
		value === "bytes" ||
		value === "unknown"
		? value
		: "unknown";
}

function safeUsageStatus(value: unknown): UsageStatus | undefined {
	return value === "ok" || value === "warning" || value === "exhausted" || value === "unknown" ? value : undefined;
}

function redactUsageWindow(value: unknown): UsageWindow | undefined {
	const window = asRecord(value);
	if (!window) return undefined;
	return {
		id: asSafeLabel(window.id) ?? "usage-window",
		label: asSafeLabel(window.label) ?? "usage window",
		...(finiteNumber(window.durationMs) !== undefined ? { durationMs: finiteNumber(window.durationMs) } : {}),
		...(finiteNumber(window.resetsAt) !== undefined ? { resetsAt: finiteNumber(window.resetsAt) } : {}),
	};
}

function redactUsageLimit(value: unknown, reportProvider: string): UsageLimit {
	const limit = asRecord(value);
	const scope = asRecord(limit?.scope);
	const amount = asRecord(limit?.amount);
	const used = finiteNumber(amount?.used);
	const amountLimit = finiteNumber(amount?.limit);
	const remaining = finiteNumber(amount?.remaining);
	const usedFraction = finiteNumber(amount?.usedFraction);
	const remainingFraction = finiteNumber(amount?.remainingFraction);
	const notes = Array.isArray(limit?.notes)
		? limit.notes.map(note => asSafeLabel(note)).filter((note): note is string => note !== null)
		: undefined;
	const status = safeUsageStatus(limit?.status);
	const window = redactUsageWindow(limit?.window);
	return {
		id: asSafeLabel(limit?.id) ?? "usage-limit",
		label: asSafeLabel(limit?.label) ?? "usage limit",
		scope: {
			provider: safeProvider(scope?.provider ?? reportProvider),
			...(optionalSafeLabel(scope?.accountId) ? { accountId: optionalSafeLabel(scope?.accountId) } : {}),
			...(optionalSafeLabel(scope?.projectId) ? { projectId: optionalSafeLabel(scope?.projectId) } : {}),
			...(optionalSafeLabel(scope?.orgId) ? { orgId: optionalSafeLabel(scope?.orgId) } : {}),
			...(optionalSafeLabel(scope?.modelId) ? { modelId: optionalSafeLabel(scope?.modelId) } : {}),
			...(optionalSafeLabel(scope?.tier) ? { tier: optionalSafeLabel(scope?.tier) } : {}),
			...(optionalSafeLabel(scope?.windowId) ? { windowId: optionalSafeLabel(scope?.windowId) } : {}),
			...(typeof scope?.shared === "boolean" ? { shared: scope.shared } : {}),
		},
		...(window ? { window } : {}),
		amount: {
			...(used !== undefined ? { used } : {}),
			...(amountLimit !== undefined ? { limit: amountLimit } : {}),
			...(remaining !== undefined ? { remaining } : {}),
			...(usedFraction !== undefined ? { usedFraction } : {}),
			...(remainingFraction !== undefined ? { remainingFraction } : {}),
			unit: safeUsageUnit(amount?.unit),
		},
		...(status !== undefined ? { status } : {}),
		...(notes !== undefined ? { notes } : {}),
	};
}

function redactUsageReport(report: CachedUsageReport["report"]): CachedUsageReport["report"] {
	const value = asRecord(report);
	const provider = safeProvider(value?.provider);
	const metadata = asRecord(value?.metadata);
	const safeMetadata = metadata
		? Object.fromEntries(
				["email", "accountId", "account", "user", "projectId", "orgId"].flatMap(key => {
					const safe = asSafeLabel(metadata[key]);
					return safe ? [[key, safe]] : [];
				}),
			)
		: undefined;
	const limits = Array.isArray(value?.limits) ? value.limits.map(limit => redactUsageLimit(limit, provider)) : [];
	return {
		provider,
		fetchedAt: finiteNumber(value?.fetchedAt) ?? 0,
		limits,
		...(safeMetadata && Object.keys(safeMetadata).length > 0 ? { metadata: safeMetadata } : {}),
	};
}

function redactUsageCache(usage: CachedUsageReport | undefined): AccountUsageCache | undefined {
	if (!usage || !asRecord(usage.report)) return undefined;
	return {
		report: redactUsageReport(usage.report),
		fetchedAt: finiteNumber(usage.fetchedAt) ?? 0,
		freshUntil: finiteNumber(usage.freshUntil) ?? 0,
		retainUntil: finiteNumber(usage.retainUntil) ?? 0,
		freshness: usage.freshness === "fresh" ? "fresh" : "stale-last-good",
	};
}

function freshUsageCache(report: CachedUsageReport["report"]): AccountUsageCache {
	const now = Date.now();
	return {
		report: redactUsageReport(report),
		fetchedAt: finiteNumber(report.fetchedAt) ?? now,
		freshUntil: now + 15 * 60_000,
		retainUntil: now + 24 * 60 * 60_000,
		freshness: "fresh",
	};
}

function canPinStoredOAuth(authStorage: AuthStorage, provider: string): boolean {
	if (authStorage.hasRuntimeApiKey(provider) || authStorage.hasConfigApiKey(provider)) return false;
	return !getEnvApiKey(provider);
}

function sourceHealth(authStorage: AuthStorage, provider: string, source: SyntheticAccountSource): AccountHealthCache {
	const getter = (authStorage as AuthStorage & SourceHealthStorage).peekCachedCredentialHealthForSource;
	const cached = getter.call(authStorage, provider, source);
	return {
		status:
			cached.status === "ok" ||
			cached.status === "failed" ||
			cached.status === "unverifiable" ||
			cached.status === "unknown"
				? cached.status
				: "unknown",
		reason: asSafeLabel(cached.reason),
		...(finiteNumber(cached.checkedAt) !== undefined ? { checkedAt: finiteNumber(cached.checkedAt) } : {}),
		...(finiteNumber(cached.retainUntil) !== undefined ? { retainUntil: finiteNumber(cached.retainUntil) } : {}),
	};
}

function recordSourceHealth(
	authStorage: AuthStorage,
	provider: string,
	source: SyntheticAccountSource,
	ok: boolean | null,
	reason: unknown,
): void {
	const recorder = (authStorage as AuthStorage & SourceHealthStorage).recordCredentialHealthForSource;
	const now = Date.now();
	recorder.call(authStorage, provider, source, {
		status: ok === true ? "ok" : ok === false ? "failed" : "unverifiable",
		reason: asSafeLabel(reason),
		checkedAt: now,
		retainUntil: now + 24 * 60 * 60_000,
	});
}

function addStoredRows(
	rows: AccountInventoryRow[],
	authStorage: AuthStorage,
	inventory: CredentialInventoryRecord[],
	sessionId: string | undefined,
	baseUrlResolver?: (provider: string) => string | undefined,
): void {
	const removalTargetIds = new Set(
		(typeof authStorage.listCredentialRemovalTargets === "function"
			? authStorage.listCredentialRemovalTargets()
			: []
		).map(target => target.id),
	);
	for (const record of inventory) {
		const identityLabel = asSafeLabel(record.identityLabel);
		const safeUsage = redactUsageCache(storedUsage(authStorage, record, baseUrlResolver?.(record.provider)));
		const active =
			typeof record.provider === "string" &&
			authStorage.getSessionCredentialRowId(record.provider, sessionId) === record.id;
		const canPin =
			record.credentialKind === "oauth" && !record.disabled && canPinStoredOAuth(authStorage, record.provider);
		const canRemove = record.credentialKind === "oauth" && removalTargetIds.has(record.id);
		rows.push({
			id: sourceId(record.provider, "stored", record.id),
			credentialId: record.id,
			provider: safeProvider(record.provider),
			credentialKind: record.credentialKind,
			source: "stored",
			sourceLabel: sourceLabel("stored"),
			identityLabel,
			...(record.credentialKind === "oauth" && identityLabel ? { oauthIdentity: { label: identityLabel } } : {}),
			disabled: record.disabled,
			disabledCause: classifyDisabledCause(record.disabledCause, record.disabled),
			health: storedHealth(authStorage, record),
			...(safeUsage ? { usage: safeUsage } : {}),
			capabilities: {
				canCheck: true,
				canPin,
				canRemove,
				hasCachedUsage: safeUsage !== undefined,
			},
			routing: {
				active,
				selected: active,
				marker: active ? "active" : "available",
			},
		});
	}
}

function addSyntheticRows(
	rows: AccountInventoryRow[],
	authStorage: AuthStorage,
	providers: Set<string>,
	sessionId: string | undefined,
): void {
	for (const provider of [...providers].sort((a, b) => a.localeCompare(b))) {
		const runtime = authStorage.hasRuntimeApiKey(provider);
		const config = authStorage.hasConfigApiKey(provider);
		const env = Boolean(getEnvApiKey(provider));
		const effectiveType = authStorage.getEffectiveCredentialType(provider, sessionId);

		const add = (source: AccountInventorySource): void => {
			const selected =
				source === "runtime"
					? runtime && effectiveType === "api_key"
					: source === "config"
						? config && effectiveType === "api_key" && !runtime
						: env && effectiveType === "api_key" && !runtime && !config;
			const id = sourceId(provider, source);
			rows.push({
				id,
				provider: safeProvider(provider),
				credentialKind: "api_key",
				source,
				sourceLabel: sourceLabel(source),
				identityLabel: null,
				disabled: false,
				disabledCause: null,
				health: sourceHealth(authStorage, provider, source as SyntheticAccountSource),
				capabilities: {
					canCheck: true,
					canPin: false,
					canRemove: false,
					hasCachedUsage: false,
				},
				routing: {
					active: false,
					selected,
					marker: selected ? "selected" : "available",
				},
			});
		};

		// Keep synthetic rows even when a stored row exists: they represent
		// explicit sources that can shadow stored credentials.
		if (runtime) add("runtime");
		if (config) add("config");
		if (env) add("env");
	}
}

/** Build a redacted, cache-only account snapshot. This function never probes. */
export function buildAccountInventorySnapshot(input: AccountInventoryInput): AccountInventorySnapshot {
	const nowMs = input.nowMs ?? Date.now();
	const inventory = input.authStorage.listCredentialInventory();
	const rows: AccountInventoryRow[] = [];
	addStoredRows(rows, input.authStorage, inventory, input.sessionId, provider =>
		input.modelRegistry?.getProviderBaseUrl?.(provider),
	);
	addSyntheticRows(rows, input.authStorage, providerSet(input, inventory), input.sessionId);
	rows.sort((left, right) => left.id.localeCompare(right.id));
	return { generatedAt: nowMs, generation: input.authStorage.getGeneration(), rows };
}

/** Short alias used by command/report callers. */
export const buildAccountInventory = buildAccountInventorySnapshot;

function applyStoredCheck(
	rows: AccountInventoryRow[],
	results: CredentialHealthResult[],
): AccountInventoryCheckResult[] {
	const byId = new Map(rows.filter(row => row.credentialId !== undefined).map(row => [row.credentialId!, row]));
	const checked: AccountInventoryCheckResult[] = [];
	for (const result of results) {
		const row = byId.get(result.id);
		if (!row) continue;
		row.health = {
			status: result.ok === true ? "ok" : result.ok === false ? "failed" : "unverifiable",
			reason: asSafeLabel(result.reason),
		};
		if (result.report) {
			row.usage = freshUsageCache(result.report);
			row.capabilities.hasCachedUsage = true;
		}
		checked.push({
			rowId: row.id,
			provider: row.provider,
			credentialId: row.credentialId,
			ok: result.ok,
			reason: asSafeLabel(result.reason) ?? undefined,
		});
	}
	return checked;
}

/**
 * Run the explicit sequential checker and return a fresh redacted snapshot.
 * AuthStorage.checkCredentials performs stored-row probes sequentially; the
 * synthetic API-key probes below are also intentionally sequential.
 */
export async function checkAccountInventory(input: AccountInventoryInput): Promise<AccountInventorySnapshot> {
	const fullSnapshot = buildAccountInventorySnapshot(input);
	const rows = input.provider ? fullSnapshot.rows.filter(row => row.provider === input.provider) : fullSnapshot.rows;
	const snapshot: AccountInventorySnapshot = { ...fullSnapshot, rows };
	const authStorage = input.authStorage;
	applyStoredCheck(
		rows,
		await authStorage.checkCredentials({
			provider: input.provider,
			baseUrlResolver: provider => input.modelRegistry?.getProviderBaseUrl?.(provider),
		}),
	);
	const syntheticRows = rows.filter(row => row.source !== "stored");
	for (const row of syntheticRows) {
		let key: string | undefined;
		if (row.source === "env") key = getEnvApiKey(row.provider);
		else if (row.source === "runtime" && authStorage.hasRuntimeApiKey(row.provider))
			key = await authStorage.peekApiKey(row.provider);
		else if (
			row.source === "config" &&
			authStorage.hasConfigApiKey(row.provider) &&
			!authStorage.hasRuntimeApiKey(row.provider)
		) {
			key = await authStorage.peekApiKey(row.provider);
		}
		const result = key
			? await authStorage.checkApiKeyCredential(row.provider as Provider, key, {
					baseUrl: input.modelRegistry?.getProviderBaseUrl?.(row.provider),
				})
			: { provider: row.provider, type: "api_key" as const, ok: null, reason: "API-key source is unavailable" };
		row.health = {
			status: result.ok === true ? "ok" : result.ok === false ? "failed" : "unverifiable",
			reason: asSafeLabel(result.reason),
		};
		recordSourceHealth(authStorage, row.provider, row.source as SyntheticAccountSource, result.ok, result.reason);
		if (result.report) {
			row.usage = freshUsageCache(result.report);
			row.capabilities.hasCachedUsage = true;
		}
	}
	return snapshot;
}

export const checkAccountInventorySnapshot = checkAccountInventory;

function selectorMatchesRemovedRow(
	selector: string,
	provider: string,
	inventory: readonly CredentialInventoryRecord[],
	removedIds: ReadonlySet<number>,
): boolean {
	const parsed = parsePersistedCredentialSelector(selector);
	if (!parsed) return false;
	if (parsed.kind === "id") return removedIds.has(Number(parsed.value));
	return inventory.some(
		row =>
			row.provider === provider &&
			removedIds.has(row.id) &&
			(parsed.kind === "email"
				? row.email?.trim().toLowerCase() === parsed.value.trim().toLowerCase()
				: parsed.kind === "account"
					? row.accountId === parsed.value
					: row.projectId === parsed.value),
	);
}

/** Clear a global persistent pin only after its selected credential was removed. */
export async function clearPersistentPinForRemovedRows(
	settings: Pick<Settings, "commitAtomicBatchWithCurrent">,
	provider: string,
	inventory: readonly CredentialInventoryRecord[],
	removedIds: readonly number[],
): Promise<boolean> {
	const removed = new Set(removedIds);
	if (removed.size === 0) return false;
	let cleared = false;
	await settings.commitAtomicBatchWithCurrent(current => {
		const auth = asRecord((current as RawSettings).auth);
		const pins = asRecord(auth?.credentialPins);
		const selector = pins?.[provider];
		if (typeof selector !== "string" || !selectorMatchesRemovedRow(selector, provider, inventory, removed)) return [];
		const nextPins = { ...pins };
		delete nextPins[provider];
		cleared = true;
		const patches: SettingsAtomicPatch[] = [{ path: "auth.credentialPins", op: "set", value: nextPins }];
		if (!Object.values(nextPins).some(value => typeof value === "string" && value.startsWith("id:"))) {
			patches.push({ path: "auth.credentialPinStoreIdentity", op: "unset" });
		}
		return patches;
	});
	return cleared;
}

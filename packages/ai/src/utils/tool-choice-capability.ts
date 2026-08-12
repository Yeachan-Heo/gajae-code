import { Database } from "bun:sqlite";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getToolChoiceCapabilityCachePath } from "@gajae-code/utils/dirs";
import { extractHttpStatusFromError } from "@gajae-code/utils/fetch-retry";
import * as logger from "@gajae-code/utils/logger";
import type { Api, Model, ToolChoice, ToolChoiceCompat, ToolChoiceSupport, ToolChoiceSupportSource } from "../types";

const supportRank: Record<ToolChoiceSupport, number> = {
	none: 0,
	auto: 1,
	required: 2,
	named: 3,
};

const registry = new Map<string, ToolChoiceSupport>();
const loggedRegistryKeys = new Set<string>();
const registryExpiresAt = new Map<string, number>();
const CACHE_SCHEMA_VERSION = 1;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EMPTY_CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 256;
const REGISTRY_MAX_ENTRIES = 256;

let cachePathOverride: string | undefined;
let nowForTests: (() => number) | undefined;
let beforeExpiredDeleteForTests: (() => void) | undefined;
let beforeMalformedDeleteForTests: (() => void) | undefined;
let onCacheOpenForTests: (() => void) | undefined;
let simulateCacheOperationErrorForTests: (() => Error | undefined) | undefined;
let beforeCorruptRetireForTests: (() => void) | undefined;

/**
 * Claude Mythos accepts tools but rejects forced tool use (Anthropic 400:
 * "tool_choice forces tool use is not compatible with this model"). Catalog
 * generation and dynamic discovery use this to default `toolChoiceSupport`.
 */
export function isClaudeForcedToolChoiceIncapableModelId(modelId: string): boolean {
	return /(?:^|[/.])claude-mythos(?:-|$)/i.test(modelId);
}

/** Derives the effective static tool-choice support from compatibility flags. */
export function deriveToolChoiceSupport(compat: ToolChoiceCompat | undefined): {
	support: ToolChoiceSupport;
	source: "static" | "derived";
} {
	if (compat?.toolChoiceSupport) {
		return { support: compat.toolChoiceSupport, source: "static" };
	}
	if (compat?.supportsToolChoice === false) {
		return { support: "none", source: "derived" };
	}
	if (compat?.supportsForcedToolChoice === false) {
		return { support: "auto", source: "derived" };
	}
	return { support: "named", source: "derived" };
}

/** Returns the registry key used for runtime tool-choice capability overrides. */
export function toolChoiceRegistryKey(model: Model<Api>): string {
	return [model.api, model.provider, model.baseUrl, model.wireModelId ?? model.id].join("|");
}

/** Returns the current runtime tool-choice capability override for a model. */
export function getToolChoiceCapabilityOverride(model: Model<Api>): ToolChoiceSupport | undefined {
	const key = toolChoiceRegistryKey(model);
	hydrateToolChoiceCapability(key);
	return registry.get(key);
}

/** Clears runtime tool-choice capability overrides for tests. */
export function clearToolChoiceIncapabilityRegistryForTests(): void {
	registry.clear();
	loggedRegistryKeys.clear();
	registryExpiresAt.clear();
}

/** Overrides durable-cache dependencies for isolated tests. */
export function configureToolChoiceCapabilityCacheForTests(options?: {
	path?: string;
	now?: () => number;
	beforeExpiredDelete?: () => void;
	beforeMalformedDelete?: () => void;
	onCacheOpen?: () => void;
	simulateOperationError?: () => Error | undefined;
	beforeCorruptRetire?: () => void;
}): void {
	cachePathOverride = options?.path;
	nowForTests = options?.now;
	beforeExpiredDeleteForTests = options?.beforeExpiredDelete;
	beforeMalformedDeleteForTests = options?.beforeMalformedDelete;
	onCacheOpenForTests = options?.onCacheOpen;
	simulateCacheOperationErrorForTests = options?.simulateOperationError;
	beforeCorruptRetireForTests = options?.beforeCorruptRetire;
	clearToolChoiceIncapabilityRegistryForTests();
}

/** Records a discovered maximum supported tool-choice level for a model. */
export function markToolChoiceIncapability(model: Model<Api>, maxSupport: ToolChoiceSupport, reason?: string): void {
	const key = toolChoiceRegistryKey(model);
	hydrateToolChoiceCapability(key);
	const existing = registry.get(key);
	const next = existing && supportRank[existing] < supportRank[maxSupport] ? existing : maxSupport;
	registry.set(key, next);
	const persisted = persistToolChoiceCapability(key, next);
	if (persisted) registry.set(key, persisted.support);
	registryExpiresAt.set(key, (persisted?.observedAt ?? currentTime()) + CACHE_TTL_MS);

	if (!loggedRegistryKeys.has(key)) {
		loggedRegistryKeys.add(key);
		logger.debug("Discovered tool_choice incapability", {
			api: model.api,
			provider: model.provider,
			baseUrlHost: safeHostname(model.baseUrl),
			model: model.wireModelId ?? model.id,
			maxSupport,
			reason,
		});
	}
}

/**
 * Resolves a requested tool_choice against static and runtime capability limits.
 * `compat` overrides `model.compat` for transports that layer URL/provider
 * detection on top of explicit model overrides (e.g. resolveOpenAICompat).
 */
export function resolveToolChoice(
	model: Model<Api>,
	requested: ToolChoice | undefined,
	compat?: ToolChoiceCompat,
): ResolveToolChoiceResult {
	const derived = deriveToolChoiceSupport(compat ?? model.compat);
	const registryKey = toolChoiceRegistryKey(model);
	hydrateToolChoiceCapability(registryKey);
	const runtime = registry.get(registryKey);
	const support = runtime && supportRank[runtime] < supportRank[derived.support] ? runtime : derived.support;
	const supportSource: ToolChoiceSupportSource = support === derived.support ? derived.source : "runtime";
	const requestedInfo = requestedToolChoiceLevel(requested);
	const clampLevel = requestedInfo.requestedLevel === "none" ? "auto" : requestedInfo.requestedLevel;

	if (requested === undefined) {
		return {
			requestedChoice: requested,
			requestedLevel: requestedInfo.requestedLevel,
			resolvedChoice: undefined,
			resolvedLevel: "auto",
			support,
			supportSource,
			degraded: false,
			registryKey,
		};
	}

	if (support === "none") {
		return {
			requestedChoice: requested,
			requestedLevel: requestedInfo.requestedLevel,
			resolvedChoice: undefined,
			resolvedLevel: "none",
			support,
			supportSource,
			degraded: requestedInfo.requestedLevel !== "none",
			reason: "tool_choice is not supported by this model",
			registryKey,
			targetToolName: requestedInfo.targetToolName,
		};
	}

	if (supportRank[support] >= supportRank[clampLevel]) {
		return {
			requestedChoice: requested,
			requestedLevel: requestedInfo.requestedLevel,
			resolvedChoice: requested,
			resolvedLevel: requestedInfo.requestedLevel,
			support,
			supportSource,
			degraded: false,
			registryKey,
			targetToolName: requestedInfo.targetToolName,
		};
	}

	if (requestedInfo.requestedLevel === "named" && support === "required") {
		return {
			requestedChoice: requested,
			requestedLevel: "named",
			resolvedChoice: "required",
			resolvedLevel: "required",
			support,
			supportSource,
			degraded: true,
			reason: "named tool_choice degraded to required",
			registryKey,
			targetToolName: requestedInfo.targetToolName,
		};
	}

	return {
		requestedChoice: requested,
		requestedLevel: requestedInfo.requestedLevel,
		resolvedChoice: undefined,
		resolvedLevel: support === "auto" ? "auto" : "none",
		support,
		supportSource,
		degraded: true,
		reason: "forced tool_choice is not supported by this model",
		registryKey,
		targetToolName: requestedInfo.targetToolName,
	};
}

/** Detects provider errors indicating forced tool_choice is unsupported. */
export function isForcedToolChoiceUnsupportedError(error: unknown, sentForcedToolChoice: boolean): boolean {
	const status = extractHttpStatusFromError(error);
	if (!sentForcedToolChoice || status !== 400) {
		return false;
	}
	const message = errorMessage(error);
	return (
		// `by <something>` continuations ("not supported by billing") describe a
		// different subject than the model's tool_choice capability — reject them
		// unless the continuation names the model itself.
		/tool[_\s-]?choices?\b.*?(not\s+compatible|incompatible|not\s+supported)(?!\s+by\s+(?!(?:this|the)\s+model\b|model\b))/is.test(
			message,
		) ||
		/forces?\s+tool\s+use.*?(not\s+compatible|incompatible|not\s+supported)/is.test(message) ||
		/does\s+not\s+support\s+forced\s+tool[_\s-]?choices?/is.test(message) ||
		/tool[_\s-]?choices?\s+['"`][^'"`\r\n]+['"`]\s+not\s+found\s+in\s+['"`]tools['"`]\s+parameter\b/is.test(message)
	);
}
/**
 * Detects Codex's statusless SSE rejection for a named function tool choice.
 * This is intentionally separate from the shared HTTP-400 classifier.
 */
export function isCodexStatuslessNamedToolChoiceNotFoundError(
	error: unknown,
	forcedToolName: string | undefined,
	sentToolNames: readonly string[],
): boolean {
	if (
		extractHttpStatusFromError(error) !== undefined ||
		extractProviderErrorCode(error) !== "invalid_request_error" ||
		!forcedToolName
	) {
		return false;
	}
	const match =
		/^Tool choice '([^']+)' not found in 'tools' parameter\.$/.exec(errorMessage(error)) ??
		/^Codex error event: Tool choice '([^']+)' not found in 'tools' parameter\. \(code=invalid_request_error\)$/.exec(
			errorMessage(error),
		);
	return match?.[1] === forcedToolName && sentToolNames.includes(forcedToolName);
}

function extractProviderErrorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

export type { ToolChoiceCompat, ToolChoiceSupport, ToolChoiceSupportSource } from "../types";

export interface ResolveToolChoiceResult {
	requestedChoice: ToolChoice | undefined;
	requestedLevel: ToolChoiceSupport;
	resolvedChoice: ToolChoice | undefined;
	resolvedLevel: ToolChoiceSupport;
	support: ToolChoiceSupport;
	supportSource: ToolChoiceSupportSource;
	degraded: boolean;
	reason?: string;
	registryKey: string;
	targetToolName?: string;
}

function requestedToolChoiceLevel(requested: ToolChoice | undefined): {
	requestedLevel: ToolChoiceSupport;
	targetToolName?: string;
} {
	if (requested === undefined || requested === "auto") return { requestedLevel: "auto" };
	if (requested === "none") return { requestedLevel: "none" };
	if (requested === "any" || requested === "required") return { requestedLevel: "required" };
	if ("name" in requested) return { requestedLevel: "named", targetToolName: requested.name };
	return { requestedLevel: "named", targetToolName: requested.function.name };
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return String(error);
}

function safeHostname(baseUrl: string): string | undefined {
	try {
		return new URL(baseUrl).hostname;
	} catch {
		return undefined;
	}
}

function hydrateToolChoiceCapability(registryKey: string): void {
	const now = currentTime();
	const expiresAt = registryExpiresAt.get(registryKey);
	if (expiresAt !== undefined && now < expiresAt) return;
	registry.delete(registryKey);
	registryExpiresAt.delete(registryKey);
	const hydrated = withCapabilityCache(database => {
		const digest = capabilityKeyDigest(registryKey);
		const row = database
			.query("SELECT max_support, support_rank, observed_at FROM tool_choice_capabilities WHERE key_digest = ?")
			.get(digest) as { max_support?: unknown; support_rank?: unknown; observed_at?: unknown } | null;
		if (!row) return false;
		if (
			!isToolChoiceSupport(row.max_support) ||
			row.support_rank !== supportRank[row.max_support] ||
			!isValidObservedAt(row.observed_at, now)
		) {
			beforeMalformedDeleteForTests?.();
			database.run(
				"DELETE FROM tool_choice_capabilities WHERE key_digest = ? AND max_support = ? AND support_rank = ? AND observed_at = ?",
				[
					digest,
					typeof row.max_support === "string" ? row.max_support : String(row.max_support),
					typeof row.support_rank === "number" ? row.support_rank : -1,
					typeof row.observed_at === "number" ? row.observed_at : -1,
				],
			);
			return false;
		}
		if (now - row.observed_at >= CACHE_TTL_MS) {
			beforeExpiredDeleteForTests?.();
			database.run("DELETE FROM tool_choice_capabilities WHERE key_digest = ? AND observed_at = ?", [
				digest,
				row.observed_at,
			]);
			return false;
		}
		registry.set(registryKey, row.max_support);
		registryExpiresAt.set(registryKey, row.observed_at + CACHE_TTL_MS);
		return true;
	});
	if (hydrated === false && !registryExpiresAt.has(registryKey)) {
		registryExpiresAt.set(registryKey, now + EMPTY_CACHE_TTL_MS);
	}
	pruneRegistry(now);
}

function persistToolChoiceCapability(
	registryKey: string,
	maxSupport: ToolChoiceSupport,
): { support: ToolChoiceSupport; observedAt: number } | undefined {
	return withCapabilityCache(database => {
		const write = database.transaction(() => {
			const digest = capabilityKeyDigest(registryKey);
			const observedAt = currentTime();
			database.run(
				"INSERT INTO tool_choice_capabilities (key_digest, max_support, support_rank, observed_at) VALUES (?, ?, ?, ?) ON CONFLICT(key_digest) DO UPDATE SET max_support = excluded.max_support, support_rank = excluded.support_rank, observed_at = excluded.observed_at WHERE excluded.support_rank <= tool_choice_capabilities.support_rank",
				[digest, maxSupport, supportRank[maxSupport], observedAt],
			);
			database.run(
				"DELETE FROM tool_choice_capabilities WHERE key_digest NOT IN (SELECT key_digest FROM tool_choice_capabilities ORDER BY observed_at DESC, key_digest DESC LIMIT ?)",
				[CACHE_MAX_ENTRIES],
			);
			const row = database
				.query("SELECT max_support, observed_at FROM tool_choice_capabilities WHERE key_digest = ?")
				.get(digest) as { max_support?: unknown; observed_at?: unknown } | null;
			return row && isToolChoiceSupport(row.max_support) && typeof row.observed_at === "number"
				? { support: row.max_support, observedAt: row.observed_at }
				: undefined;
		});
		return write();
	});
}

function withCapabilityCache<T>(operation: (database: Database) => T): T | undefined {
	if (process.env.NODE_ENV === "test" && cachePathOverride === undefined) return;
	const cachePath = cachePathOverride ?? getToolChoiceCapabilityCachePath();
	let openedFileSize: number | undefined;
	try {
		fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
		try {
			openedFileSize = fs.statSync(cachePath).size;
		} catch {
			// File does not exist yet (first run); nothing to identity-check on retirement.
		}
		const database = openCapabilityCache(cachePath);
		try {
			try {
				fs.chmodSync(cachePath, 0o600);
			} catch {
				// Cache access remains fail-open on filesystems without POSIX modes.
			}
			const simulatedError = simulateCacheOperationErrorForTests?.();
			if (simulatedError) throw simulatedError;
			return operation(database);
		} finally {
			database.close();
		}
	} catch (error) {
		logger.debug("Tool-choice capability cache unavailable", {
			cachePath: path.basename(cachePath),
			error: error instanceof Error ? error.message : String(error),
		});
		if (isCorruptCapabilityCacheError(error)) {
			beforeCorruptRetireForTests?.();
			retireCorruptCapabilityCache(cachePath, openedFileSize);
		}
	}
}

function openCapabilityCache(cachePath: string): Database {
	onCacheOpenForTests?.();
	const database = new Database(cachePath, { create: true, strict: true });
	try {
		database.run("PRAGMA busy_timeout = 3000");
		database.run("PRAGMA journal_mode = WAL");
		database.run("PRAGMA synchronous = FULL");
		const initialize = database.transaction(() => {
			const version = database.query("PRAGMA user_version").get() as { user_version?: number } | null;
			const schemaVersion = version?.user_version ?? 0;
			if (schemaVersion === 0) {
				database.run(`
				CREATE TABLE IF NOT EXISTS tool_choice_capabilities (
					key_digest TEXT PRIMARY KEY NOT NULL,
					max_support TEXT NOT NULL,
					support_rank INTEGER NOT NULL,
					observed_at INTEGER NOT NULL
				) STRICT
			`);
				assertCapabilityCacheSchema(database);
				database.run(`PRAGMA user_version = ${CACHE_SCHEMA_VERSION}`);
				return;
			}
			if (schemaVersion !== CACHE_SCHEMA_VERSION) {
				throw new CapabilityCacheCorruptionError("unsupported cache schema version");
			}
			assertCapabilityCacheSchema(database);
		});
		initialize();
		return database;
	} catch (error) {
		database.close();
		throw error;
	}
}

function assertCapabilityCacheSchema(database: Database): void {
	const columns = database.query("PRAGMA table_info(tool_choice_capabilities)").all() as Array<{
		name?: unknown;
		type?: unknown;
		notnull?: unknown;
		pk?: unknown;
	}>;
	const actual = columns.map(column => [column.name, column.type, column.notnull, column.pk]);
	const expected = [
		["key_digest", "TEXT", 1, 1],
		["max_support", "TEXT", 1, 0],
		["support_rank", "INTEGER", 1, 0],
		["observed_at", "INTEGER", 1, 0],
	];
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new CapabilityCacheCorruptionError("invalid cache schema");
	}
}

class CapabilityCacheCorruptionError extends Error {}

function isCorruptCapabilityCacheError(error: unknown): boolean {
	if (error instanceof CapabilityCacheCorruptionError) return true;
	if (!error || typeof error !== "object") return false;
	const code = (error as { code?: unknown }).code;
	return code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB";
}

/**
 * Removes a confirmed-corrupt cache file and its WAL/SHM siblings. The file
 * size captured before the corrupt open (`openedFileSize`) is checked before
 * unlinking so a concurrently recreated valid replacement database with a
 * different file size is never deleted.
 */
function retireCorruptCapabilityCache(cachePath: string, openedFileSize?: number): void {
	for (const suffix of ["", "-wal", "-shm"]) {
		const target = `${cachePath}${suffix}`;
		try {
			if (openedFileSize !== undefined && suffix === "") {
				const stat = fs.statSync(target);
				if (stat.size !== openedFileSize) continue;
			}
			fs.rmSync(target, { force: true });
		} catch {
			// A best-effort cache reset must never break provider fallback behavior.
		}
	}
}

function capabilityKeyDigest(registryKey: string): string {
	return crypto.createHash("sha256").update(registryKey).digest("hex");
}

function isToolChoiceSupport(value: unknown): value is ToolChoiceSupport {
	return value === "none" || value === "auto" || value === "required" || value === "named";
}

function isValidObservedAt(value: unknown, now: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= now;
}

function currentTime(): number {
	return nowForTests?.() ?? Date.now();
}

function pruneRegistry(now: number): void {
	for (const [key, expiresAt] of registryExpiresAt) {
		if (expiresAt <= now) {
			registryExpiresAt.delete(key);
			registry.delete(key);
		}
	}
	while (registryExpiresAt.size > REGISTRY_MAX_ENTRIES) {
		const oldestKey = registryExpiresAt.keys().next().value;
		if (typeof oldestKey !== "string") break;
		registryExpiresAt.delete(oldestKey);
		registry.delete(oldestKey);
	}
}

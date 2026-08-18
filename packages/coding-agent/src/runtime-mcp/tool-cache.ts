/**
 * MCP tool cache.
 *
 * Stores tool definitions per server in agent.db for fast startup.
 */
import { isRecord, logger } from "@gajae-code/utils";
import type { AgentStorage } from "../session/agent-storage";
import type { MCPServerConfig, MCPToolDefinition } from "./types";

const CACHE_VERSION = 1;
const CACHE_PREFIX = "mcp_tools:";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type MCPToolCachePayload = {
	version: number;
	configHash: string;
	tools: MCPToolDefinition[];
	/**
	 * Generation of the invalidation fence this write was issued under. A write
	 * whose generation is older than the row's current fence generation is a
	 * stale write racing a completed invalidation and must not land.
	 */
	generation: number;
};

function stableClone(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(item => stableClone(item));
	}
	if (isRecord(value)) {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			sorted[key] = stableClone(value[key]);
		}
		return sorted;
	}
	return value;
}

function stableStringify(value: unknown): string {
	return JSON.stringify(stableClone(value));
}

function toHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let output = "";
	for (const byte of bytes) {
		output += byte.toString(16).padStart(2, "0");
	}
	return output;
}

/**
 * Cache identity.
 *
 * A cached entry is replayed as a `DeferredMCPTool` *before* the server it came
 * from has connected, so identity must cover every input that decides which
 * server the name refers to. Server name plus raw config is not enough: the
 * effective project scope selects the config in the first place, and the same
 * name/config in another project can describe a different server. `scope` binds
 * the entry to that project so a cross-project hit can never surface another
 * workspace's tool descriptions.
 */
async function hashConfig(config: MCPServerConfig, scope: string, credential: string): Promise<string> {
	const stable = stableStringify({ scope, credential, config });
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable));
	return toHex(digest);
}

/**
 * Non-secret fingerprint of the credentials a connection actually authenticated
 * with.
 *
 * The stored config is a template: an env-backed or shell-backed value looks
 * identical across a rotation, so hashing the template alone would let a catalog
 * fetched under one credential identity be replayed for another. Only the digest
 * is retained; the resolved secret never reaches the database.
 */
export async function credentialFingerprint(resolved: MCPServerConfig): Promise<string> {
	const material =
		resolved.type === "http" || resolved.type === "sse"
			? { headers: resolved.headers ?? {}, url: resolved.url ?? "" }
			: {
					env: resolved.env ?? {},
					command: resolved.command ?? "",
					args: resolved.args ?? [],
					// A stdio child inherits the parent environment unless the config opts
					// out, so a host-provided token can rotate without any declared field
					// changing. Folding the effective inherited environment in means such a
					// rotation misses instead of replaying the previous identity's catalog.
					// It also misses on unrelated environment churn, which is the safe
					// direction: a redundant reconnect costs a startup, a wrong hit does not
					// announce itself.
					inherited: resolved.noInheritEnv === true ? null : { ...Bun.env },
				};
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableStringify(material)));
	return toHex(digest);
}

function cacheKey(serverName: string): string {
	return `${CACHE_PREFIX}${serverName}`;
}

/**
 * Per-row mutation ordering, shared across every `MCPToolCache` over the same
 * storage object.
 *
 * Ordinary sessions each construct their own `MCPManager`, and each manager
 * serializes only its own writes. An older manager's detached public `set()`
 * could therefore land after a second manager's `delete()` for a private
 * result or terminal failure, resurrecting exactly the replayable row the
 * delete retired. The queue is keyed by the storage instance itself (one
 * `AgentStorage.open()` per profile database per process), so all managers
 * over one database share one order.
 */
const storageScope = new WeakMap<AgentStorage, Map<string, Promise<void>>>();
/**
 * Invalidation fence generation per storage+row. Every completed `delete()`
 * bumps the row's generation; a `set()` captures the generation at issue time
 * and is dropped if the row moved past it by the time the write would land.
 * This is the conditional-write half of the ordering above: even a set that
 * somehow bypassed the queue (a future caller, a different process on the
 * same database) cannot resurrect a row an invalidation retired.
 */

/**
 * Read the row's fence generation from durable storage.
 *
 * The generation lives in the row itself rather than in process memory: two
 * standalone or SDK processes over one profile database would otherwise both
 * start at zero, and a public write from the first could be admitted after the
 * second had already invalidated the row for a private result. An invalidation
 * leaves a tombstone carrying the bumped generation, so it is still readable
 * after the row has expired.
 *
 * A residual interleaving remains: this is a read-modify-write, not a compare
 * and swap, so two processes racing between the read and the write can still
 * settle on the same generation. Closing that needs a conditional write the
 * cache interface does not expose; the durable fence removes the systematic
 * always-zero case rather than every race.
 */
function currentGeneration(storage: AgentStorage, serverName: string): number {
	const raw = storage.getCache(cacheKey(serverName), { includeExpired: true });
	if (!raw) return 0;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed) || typeof parsed.generation !== "number" || !Number.isFinite(parsed.generation)) return 0;
		return parsed.generation;
	} catch {
		return 0;
	}
}

/**
 * Serializes `mutation` against every other mutation for the same
 * storage+server row, across cache instances and managers.
 */
function enqueueCacheMutation(storage: AgentStorage, serverName: string, mutation: () => Promise<void>): Promise<void> {
	const rows = storageScope.get(storage) ?? new Map<string, Promise<void>>();
	storageScope.set(storage, rows);
	const previous = rows.get(serverName) ?? Promise.resolve();
	const next = previous
		.catch(() => {})
		.then(mutation)
		.finally(() => {
			if (rows.get(serverName) === next) rows.delete(serverName);
		});
	rows.set(serverName, next);
	return next;
}

export class MCPToolCache {
	/**
	 * `storage` must already be scoped to the caller's effective agent profile;
	 * `scope` additionally binds entries to the effective project. Scope is
	 * required rather than defaulted: an empty scope is a cross-project replay,
	 * so a caller that cannot name its project must not get a cache at all.
	 */
	constructor(
		private storage: AgentStorage,
		private scope: string,
	) {
		if (scope.trim().length === 0) throw new Error("MCPToolCache requires a non-empty project scope");
	}

	/**
	 * `credential` is the fingerprint of the identity that will use the entry.
	 * Callers that cannot determine it yet must not read: an unbound hit would
	 * replay another identity's catalog.
	 */
	async get(serverName: string, config: MCPServerConfig, credential: string): Promise<MCPToolDefinition[] | null> {
		const key = cacheKey(serverName);
		const raw = this.storage.getCache(key);
		if (!raw) return null;

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			logger.warn("MCP tool cache parse failed", { serverName, error: String(error) });
			return null;
		}

		if (!isRecord(parsed)) return null;
		if (parsed.version !== CACHE_VERSION) return null;
		if (typeof parsed.configHash !== "string") return null;
		// An invalidation tombstone carries no hash, so it can never satisfy the
		// comparison below; rejecting it here states that rather than relying on it.
		if (parsed.configHash.length === 0) return null;
		if (!Array.isArray(parsed.tools)) return null;

		let currentHash: string;
		try {
			currentHash = await hashConfig(config, this.scope, credential);
		} catch (error) {
			logger.warn("MCP tool cache hash failed", { serverName, error: String(error) });
			return null;
		}

		if (parsed.configHash !== currentHash) return null;

		return parsed.tools as MCPToolDefinition[];
	}

	/** Drop a server's entry so a dead surface cannot replay until its TTL. */
	async delete(serverName: string): Promise<void> {
		// Serialized at the storage boundary so a concurrent public write from any
		// manager sharing this row cannot land after this retraction.
		await enqueueCacheMutation(this.storage, serverName, async () => {
			// A tombstone rather than an empty value: it carries the bumped generation
			// so the fence survives this process, and its empty `configHash` can never
			// match a real one, so a reader treats it as a miss. It is written already
			// expired so ordinary reads skip it entirely.
			const tombstone: MCPToolCachePayload = {
				version: CACHE_VERSION,
				configHash: "",
				tools: [],
				generation: currentGeneration(this.storage, serverName) + 1,
			};
			this.storage.setCache(cacheKey(serverName), JSON.stringify(tombstone), Math.floor(Date.now() / 1000) - 1);
		});
	}

	/**
	 * `freshUntilMs` is the server's own freshness hint from `tools/list`. When it
	 * is shorter than the default retention it wins: a server that declared its
	 * catalog stale after a minute must not be replayed as deferred tools for a
	 * month.
	 */
	async set(
		serverName: string,
		config: MCPServerConfig,
		tools: MCPToolDefinition[],
		credential: string,
		freshUntilMs?: number,
	): Promise<void> {
		// Captured at issue time: if an invalidation completes while this write is
		// still queued/in flight, the row's generation moves past this value and
		// the write is dropped instead of resurrecting the retired entry.
		const issuedGeneration = currentGeneration(this.storage, serverName);
		let configHash: string;
		try {
			configHash = await hashConfig(config, this.scope, credential);
		} catch (error) {
			logger.warn("MCP tool cache hash failed", { serverName, error: String(error) });
			return;
		}

		const payload: MCPToolCachePayload = {
			version: CACHE_VERSION,
			configHash,
			tools,
			generation: issuedGeneration,
		};

		let serialized: string;
		try {
			serialized = JSON.stringify(payload);
		} catch (error) {
			logger.warn("MCP tool cache serialize failed", { serverName, error: String(error) });
			return;
		}

		const defaultExpiryMs = Date.now() + CACHE_TTL_MS;
		const expiresAtSec = Math.floor(Math.min(defaultExpiryMs, freshUntilMs ?? defaultExpiryMs) / 1000);
		await enqueueCacheMutation(this.storage, serverName, async () => {
			if (currentGeneration(this.storage, serverName) !== issuedGeneration) {
				logger.debug("Dropped stale MCP tool cache write behind an invalidation", { serverName });
				return;
			}
			this.storage.setCache(cacheKey(serverName), serialized, expiresAtSec);
		});
	}
}

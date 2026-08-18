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
			: { env: resolved.env ?? {}, command: resolved.command ?? "", args: resolved.args ?? [] };
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableStringify(material)));
	return toHex(digest);
}

function cacheKey(serverName: string): string {
	return `${CACHE_PREFIX}${serverName}`;
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
		// Expiring in the past is the only removal the cache interface exposes.
		this.storage.setCache(cacheKey(serverName), "", Math.floor(Date.now() / 1000) - 1);
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
		this.storage.setCache(cacheKey(serverName), serialized, expiresAtSec);
	}
}

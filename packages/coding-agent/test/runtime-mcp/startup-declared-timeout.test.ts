import { describe, expect, test, vi } from "bun:test";
import * as configValue from "../../src/config/resolve-config-value";
import * as mcpClient from "../../src/runtime-mcp/client";
import { MCPManager, withinDeclaredConnectionWindow } from "../../src/runtime-mcp/manager";
import type { MCPToolCache } from "../../src/runtime-mcp/tool-cache";
import { credentialFingerprint, MCPToolCache as MCPToolCacheClass } from "../../src/runtime-mcp/tool-cache";
import type { MCPServerConnection } from "../../src/runtime-mcp/types";

// `gjc mcp add --timeout` writes a per-server `timeout`, and `connectToServer`
// honors it. Startup used to discard it anyway: one batch-wide timer decided
// every server's fate, so a server that declared 90s and a server that declared
// nothing were both killed at the same millisecond once the short ceiling
// elapsed. The wait staying short is correct — killing the connection was not.

const STARTUP_CEILING_MS = 1_750;

/** stdio MCP server that stalls `initialize` and then serves one tool. */
function delayedStdioServer(toolName: string, initializeDelayMs: number): string {
	return `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'delayed', version: '1' } } }) + '\\n');
    }, ${initializeDelayMs});
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: '${toolName}', inputSchema: { type: 'object' } }] } }) + '\\n');
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("waitFor timed out");
}

describe("MCP startup and the declared connection window", () => {
	test("reads the declared window per server rather than as one batch budget", () => {
		expect(withinDeclaredConnectionWindow({ command: "declared", timeout: 90_000 }, STARTUP_CEILING_MS)).toBe(true);
		expect(withinDeclaredConnectionWindow({ command: "declared", timeout: 90_000 }, 90_000)).toBe(false);
		// No declared window, or a meaningless one, is not an open window.
		expect(withinDeclaredConnectionWindow({ command: "undeclared" }, 0)).toBe(false);
		expect(withinDeclaredConnectionWindow({ command: "zero", timeout: 0 }, 0)).toBe(false);
		expect(withinDeclaredConnectionWindow({ command: "nan", timeout: Number.NaN }, 0)).toBe(false);
	});

	test("keeps a server inside its declared window connecting and fails only the one without a window", async () => {
		const manager = new MCPManager(process.cwd());
		try {
			const startedAt = Date.now();
			const result = await manager.connectServers(
				{
					declared: {
						command: process.execPath,
						args: ["-e", delayedStdioServer("ping", 2_400)],
						timeout: 10_000,
					},
					undeclared: {
						command: process.execPath,
						args: ["-e", delayedStdioServer("ping", 2_400)],
					},
				},
				{},
			);
			const elapsedMs = Date.now() - startedAt;

			// Session start is still bounded by the short ceiling: a declared
			// timeout buys the server time, never the user's startup latency.
			expect(elapsedMs).toBeLessThan(2_400);
			expect(result.connectedServers).toEqual([]);
			expect(result.tools).toEqual([]);

			// One batch-wide verdict is gone: the two servers are judged against
			// their own windows, so they no longer fail together.
			expect(result.errors.get("undeclared")).toContain("timed out");
			expect(result.errors.has("declared")).toBe(false);
			expect(manager.getConnectionStatus("undeclared")).toBe("disconnected");
			expect(manager.getConnectionStatus("declared")).toBe("connecting");

			// The surviving connection completes on its own and publishes tools.
			await waitFor(() => manager.getConnectedServers().includes("declared"));
			await waitFor(() => manager.getTools().some(tool => tool.name === "mcp__declared_ping"));
			expect(manager.getConnectedServers()).toEqual(["declared"]);
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	// A real stdio fixture cannot reach this branch: `connectToServer` enforces the
	// declared timeout itself, so the task rejects before the startup race sees it
	// still pending. Holding the connect open past its declared window is the only
	// way to assert the manager's own elapsed-window teardown and its abort mapping.
	test("tears down a task still pending after its declared window elapsed", async () => {
		let capturedSignal: AbortSignal | undefined;
		const connect = vi
			.spyOn(mcpClient, "connectToServer")
			.mockImplementation((_name, _config, options?: { signal?: AbortSignal }) => {
				capturedSignal = options?.signal;
				return new Promise<MCPServerConnection>(() => {});
			});
		// The startup wait outlives the declared window: budget is declared + grace,
		// so by the deadline the 300ms window is spent while the task is still pending.
		const manager = new MCPManager(process.cwd(), null, { maxStartupTimeoutMs: 800 });
		try {
			const result = await manager.connectServers({ spent: { type: "stdio", command: "spent", timeout: 300 } }, {});

			expect(result.connectedServers).toEqual([]);
			expect(result.errors.get("spent")).toBe("MCP server connection timed out during startup: spent");
			expect(manager.getConnectionStatus("spent")).toBe("disconnected");
			expect(capturedSignal?.aborted).toBe(true);
		} finally {
			connect.mockRestore();
			await manager.disconnectAll();
		}
	});

	// The declared window is `connectToServer`'s budget, so it opens when the
	// connect attempt does. Charging it from the batch clock would bill a task for
	// time its transport never saw and tear it down before it had begun.
	test("does not charge the declared window while a task is still resolving auth", async () => {
		const resolveValue = vi.spyOn(configValue, "resolveConfigValue").mockImplementation(async () => {
			await Bun.sleep(1_200);
			return "resolved-token";
		});
		const connect = vi
			.spyOn(mcpClient, "connectToServer")
			.mockImplementation(() => new Promise<MCPServerConnection>(() => {}));
		// Budget 800ms; the 300ms window would look long spent on the batch clock,
		// but auth resolution has not finished so no connect has started.
		const manager = new MCPManager(process.cwd(), null, { maxStartupTimeoutMs: 800 });
		try {
			const result = await manager.connectServers(
				{ slowauth: { type: "stdio", command: "slowauth", timeout: 300, env: { TOKEN: "!token" } } },
				{},
			);

			expect(result.errors.has("slowauth")).toBe(false);
			expect(manager.getConnectionStatus("slowauth")).toBe("connecting");
		} finally {
			connect.mockRestore();
			resolveValue.mockRestore();
			await manager.disconnectAll();
		}
	});

	// A deferred tool is a promise that the connection is still coming. Once the
	// background attempt fails terminally that promise is false, and leaving the
	// tool advertised means every call resolves to a wait that can only fail.
	test("withdraws deferred tools and drops the cache entry when the background connection fails", async () => {
		const cached = [{ name: "ping", inputSchema: { type: "object" } }] as never;
		const deleted: string[] = [];
		const toolCache = {
			get: async () => cached,
			set: async () => {},
			delete: async (serverName: string) => {
				deleted.push(serverName);
			},
		} as unknown as MCPToolCache;
		const failure = new Error("transport gave up after the startup wait");
		const release = Promise.withResolvers<MCPServerConnection>();
		const connect = vi.spyOn(mcpClient, "connectToServer").mockImplementation(() => release.promise);
		const manager = new MCPManager(process.cwd(), toolCache);
		try {
			const result = await manager.connectServers({ warm: { type: "stdio", command: "warm" } }, {});
			// Cached surface is published while the connection is still pending.
			expect(result.tools.map(tool => tool.name)).toEqual(["mcp__warm_ping"]);
			expect(manager.getTools().map(tool => tool.name)).toEqual(["mcp__warm_ping"]);

			release.reject(failure);
			await waitFor(() => manager.getTools().length === 0);
			expect(deleted).toEqual(["warm"]);
		} finally {
			connect.mockRestore();
			await manager.disconnectAll();
		}
	});

	test("drops an existing cache row when a server turns its catalog private", async () => {
		const deleted: string[] = [];
		const written: string[] = [];
		const toolCache = {
			get: async () => null,
			set: async (serverName: string) => {
				written.push(serverName);
			},
			delete: async (serverName: string) => {
				deleted.push(serverName);
			},
		} as unknown as MCPToolCache;
		const connect = vi.spyOn(mcpClient, "connectToServer").mockImplementation(
			async (name, config) =>
				({
					name,
					config,
					transport: {
						close: async () => {},
						request: async () => ({}),
						notify: async () => {},
					},
					serverInfo: { name: "private-server", version: "1" },
					capabilities: { tools: {} },
					protocol: { era: "modern" },
					toolsCacheScope: "private",
				}) as never,
		);
		const listTools = vi
			.spyOn(mcpClient, "listTools")
			.mockResolvedValue([{ name: "ping", inputSchema: { type: "object" } }] as never);
		const manager = new MCPManager(process.cwd(), toolCache);
		try {
			await manager.connectServers({ secretive: { type: "stdio", command: "secretive" } }, {});
			await waitFor(() => deleted.length > 0);

			// Suppressing the write is not enough: a previously public row would stay
			// replayable until its TTL, so turning private must retract it.
			expect(deleted).toEqual(["secretive"]);
			expect(written).toEqual([]);
		} finally {
			listTools.mockRestore();
			connect.mockRestore();
			await manager.disconnectAll();
		}
	});

	// The decoder keeps only `tools`/`nextCursor`, so reading hints off the decoded
	// page saw none and silently disabled every privacy and freshness decision.
	test("carries cache hints from the raw tools/list envelope, and lets one private page win", async () => {
		const pages = [
			{
				tools: [{ name: "first", inputSchema: { type: "object" } }],
				nextCursor: "p2",
				cacheScope: "public",
				ttlMs: 60_000,
			},
			{ tools: [{ name: "second", inputSchema: { type: "object" } }], cacheScope: "private", ttlMs: 5_000 },
		];
		let page = 0;
		const connection = {
			name: "paged",
			config: { type: "stdio", command: "paged" },
			capabilities: { tools: {} },
			protocol: { era: "modern" },
			transport: { request: async () => pages[page++] },
		} as never as MCPServerConnection;

		const tools = await mcpClient.listTools(connection);

		expect(tools.map(tool => tool.name)).toEqual(["first", "second"]);
		// A later public page must not relabel a mixed catalog as shareable...
		expect(connection.toolsCacheScope).toBe("private");
		// ...and the shortest freshness deadline across pages wins.
		expect(connection.toolsFreshUntil).toBeLessThanOrEqual(Date.now() + 5_000);
	});

	test("binds cache identity to the resolved credential, not the config template", async () => {
		const template = { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "!token" } };
		const resolve = vi.spyOn(configValue, "resolveConfigValue");

		resolve.mockResolvedValue("secret-one");
		const first = await credentialFingerprint(
			(await new MCPManager(process.cwd()).prepareConfig(template as never)) as never,
		);
		resolve.mockResolvedValue("secret-two");
		const second = await credentialFingerprint(
			(await new MCPManager(process.cwd()).prepareConfig(template as never)) as never,
		);
		resolve.mockRestore();

		// The template is byte-identical across the rotation; only the resolved
		// value differs, and that is exactly what must not collide.
		expect(first).not.toBe(second);
		// Non-secret: the digest never contains the material it fingerprints.
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(first).not.toContain("secret");
	});

	test("gives the same server a different identity in a different project", async () => {
		const config = { type: "stdio", command: "same", args: [] } as never;
		const tools = [{ name: "ping", inputSchema: { type: "object" } }] as never;
		const rows = new Map<string, string>();
		const storage = {
			getCache: (key: string) => rows.get(key) ?? null,
			setCache: (key: string, value: string) => {
				rows.set(key, value);
			},
		} as never;

		const projectA = new MCPToolCacheClass(storage, "/work/project-a");
		const projectB = new MCPToolCacheClass(storage, "/work/project-b");
		await projectA.set("same", config, tools, "cred-1");

		// Same profile database, same server name, same config: only the project
		// differs, and that alone must not hit.
		expect(await projectA.get("same", config, "cred-1")).not.toBeNull();
		expect(await projectB.get("same", config, "cred-1")).toBeNull();
		// A rotated credential in the owning project also misses.
		expect(await projectA.get("same", config, "cred-2")).toBeNull();
	});

	test("honors a server freshness deadline shorter than the default retention", async () => {
		const config = { type: "stdio", command: "fresh", args: [] } as never;
		const tools = [{ name: "ping", inputSchema: { type: "object" } }] as never;
		const expiries: number[] = [];
		const storage = {
			getCache: () => null,
			setCache: (_key: string, _value: string, expiresAtSec: number) => {
				expiries.push(expiresAtSec);
			},
		} as never;
		const cache = new MCPToolCacheClass(storage, "/work/project");

		await cache.set("fresh", config, tools, "cred", Date.now() + 60_000);
		await cache.set("stale-default", config, tools, "cred");

		const nowSec = Math.floor(Date.now() / 1000);
		expect(expiries[0]!).toBeLessThanOrEqual(nowSec + 61);
		// Without a hint the flat retention still applies, so the hint is what
		// shortened the first one rather than a coincidence of the default.
		expect(expiries[1]!).toBeGreaterThan(nowSec + 60);
	});

	test("refuses an unscoped cache rather than sharing entries across projects", async () => {
		const storage = {} as never;
		expect(() => new MCPToolCacheClass(storage, "")).toThrow("non-empty project scope");
		expect(() => new MCPToolCacheClass(storage, "   ")).toThrow("non-empty project scope");
	});

	test("skips a cached surface while the credential identity is still unresolved", async () => {
		const reads: string[] = [];
		const toolCache = {
			get: async (serverName: string) => {
				reads.push(serverName);
				return [{ name: "ping", inputSchema: { type: "object" } }] as never;
			},
			set: async () => {},
			delete: async () => {},
		} as unknown as MCPToolCache;
		const resolveValue = vi.spyOn(configValue, "resolveConfigValue").mockImplementation(async () => {
			await Bun.sleep(1_200);
			return "resolved-token";
		});
		const connect = vi
			.spyOn(mcpClient, "connectToServer")
			.mockImplementation(() => new Promise<MCPServerConnection>(() => {}));
		const manager = new MCPManager(process.cwd(), toolCache, { maxStartupTimeoutMs: 400 });
		try {
			const result = await manager.connectServers(
				{ unresolved: { type: "stdio", command: "unresolved", timeout: 5_000, env: { TOKEN: "!token" } } },
				{},
			);

			// Auth is still resolving, so the identity that would own a hit is unknown.
			// Failing closed means no deferred surface rather than a possibly foreign one.
			expect(reads).toEqual([]);
			expect(result.tools).toEqual([]);
		} finally {
			connect.mockRestore();
			resolveValue.mockRestore();
			await manager.disconnectAll();
		}
	});

	// The declared window is one budget for the handshake *and* initial
	// discovery: a server that initializes promptly and then stalls `tools/list`
	// must be abandoned at that same deadline, not stay pending forever on the
	// per-request timeout alone.
	test("abandons a server that finishes its handshake and then stalls tools/list", async () => {
		const stallServer = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'stalled-discovery', version: '1' } } }) + '\\n');
  } else if (msg.method === 'tools/list') {
    // Initialize answered immediately; discovery never answers at all.
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`;
		const manager = new MCPManager(process.cwd());
		try {
			const startedAt = Date.now();
			const result = await manager.connectServers(
				{
					stalled: {
						command: process.execPath,
						args: ["-e", stallServer],
						// Generous handshake budget that discovery alone must consume.
						timeout: 2_000,
					},
				},
				{},
			);

			// Startup stays bounded by the short ceiling, the server is left
			// connecting, and the unspent window bounds the stalled discovery: the
			// connection is torn down shortly after the declared window closes
			// rather than hanging on the request timeout.
			expect(Date.now() - startedAt).toBeLessThan(2_400);
			expect(result.connectedServers).toEqual([]);
			expect(result.tools).toEqual([]);
			const deadline = Date.now() + 6_000;
			while (Date.now() < deadline && manager.getConnectionStatus("stalled") !== "disconnected") {
				await Bun.sleep(20);
			}
			expect(manager.getConnectionStatus("stalled")).toBe("disconnected");
			expect(manager.getTools()).toEqual([]);
		} finally {
			await manager.disconnectAll();
		}
	}, 20_000);

	test("reports a server whose own declared timeout rejects it before the startup wait ends", async () => {
		const manager = new MCPManager(process.cwd());
		try {
			const result = await manager.connectServers(
				{
					brief: {
						command: process.execPath,
						args: ["-e", delayedStdioServer("ping", 5_000)],
						// `connectToServer` enforces this window itself and rejects at 900ms,
						// well inside the 1400ms startup wait.
						timeout: 900,
					},
				},
				{},
			);

			expect(result.connectedServers).toEqual([]);
			expect(result.errors.get("brief")).toContain("timed out");
			expect(manager.getConnectionStatus("brief")).toBe("disconnected");
		} finally {
			await manager.disconnectAll();
		}
	});

	test("serializes cache mutations across managers sharing one storage row", async () => {
		const config = { type: "stdio", command: "shared", args: [] } as never;
		const tools = [{ name: "ping", inputSchema: { type: "object" } }] as never;
		const order: string[] = [];
		const rows = new Map<string, string>();
		// A deferred store: each caller controls when a mutation actually lands.
		const gates: Array<() => void> = [];
		const storage = {
			getCache: (key: string) => rows.get(key) ?? null,
			setCache: (key: string, value: string, _expiresAtSec: number) => {
				const index = order.length;
				order.push(`write:${index}`);
				gates.push(() => rows.set(key, value));
			},
		} as never;
		// Two cache instances over one storage object, as two sessions produce.
		const first = new MCPToolCacheClass(storage, "/work/project");
		const second = new MCPToolCacheClass(storage, "/work/project");

		// Manager A issues a slow public write; manager B invalidates while that
		// write is still in flight. Per-manager queues would let A's write land
		// after B's delete and resurrect the retired row.
		const write = first.set("shared", config, tools, "cred");
		await Bun.sleep(10);
		const remove = second.delete("shared");
		await Bun.sleep(10);

		void write;
		void remove;
		// Drain the queue: every enqueued mutation runs in issue order.
		await Bun.sleep(50);
		for (const release of gates) release();

		// The set was issued first, the delete second: the tombstone must be the
		// last mutation for the row, so a read cannot see the resurrected catalog.
		const raw = (storage as { getCache(key: string): string | null }).getCache("mcp_tools:shared");
		// The tombstone is an empty string; a resurrected catalog would be JSON.
		expect(raw === null || raw === "").toBe(true);
	});
});

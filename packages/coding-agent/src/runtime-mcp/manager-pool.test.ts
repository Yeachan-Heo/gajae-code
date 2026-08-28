import { expect, test, vi } from "bun:test";
import { rm } from "node:fs/promises";
import { legacyMcpMethodNotFound } from "../../test/mcp-test-utils";
import * as configValue from "../config/resolve-config-value";
import { MCPManager } from "./manager";
import { MCPConnectionPool } from "./pool";
import { computeMCPPoolKey } from "./pool-key";
import type { MCPProtocolObservation } from "./protocol";
import { legacyEraObservation } from "./protocol";
import type { MCPRequestOptions, MCPServerConfig, MCPServerConnection, MCPTransport } from "./types";

/** Fake connections model pre-v2 stdio servers: legacy era, forced by transport. */
function fakeLegacyProtocol(capabilities: {
	tools?: unknown;
	resources?: unknown;
	prompts?: unknown;
}): MCPProtocolObservation {
	return legacyEraObservation({
		preference: "auto",
		effectiveVersion: "2025-03-26",
		negotiation: "legacy-forced",
		downgradeReason: "stdio-transport",
		serverInfo: { name: "fake", version: "1" },
		capabilities: {
			tools: capabilities.tools !== undefined,
			resources: capabilities.resources !== undefined,
			prompts: capabilities.prompts !== undefined,
		},
	});
}
class ManagerFakeTransport implements MCPTransport {
	connected = true;
	closeCount = 0;
	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;

	async request<T = unknown>(
		method: string,
		_params?: Record<string, unknown>,
		_options?: MCPRequestOptions,
	): Promise<T> {
		if (method === "tools/list") return { tools: [] } as T;
		return {} as T;
	}
	async notify(): Promise<void> {}
	async close(): Promise<void> {
		this.closeCount += 1;
		this.connected = false;
	}
}

class SharedToolTransport extends ManagerFakeTransport {
	constructor(
		readonly generation = 1,
		private failFirstCall = false,
	) {
		super();
	}
	callCount = 0;

	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		if (method === "tools/list")
			return { tools: [{ name: `shared-${this.generation}`, inputSchema: { type: "object" } }] } as T;
		if (method === "tools/call") {
			this.callCount += 1;
			if (this.failFirstCall) {
				this.failFirstCall = false;
				throw new Error("ECONNRESET");
			}
			return { content: [{ type: "text", text: `ok-${this.generation}` }] } as T;
		}
		return super.request<T>(method, params, options);
	}
}

class SharedPromptTransport extends ManagerFakeTransport {
	readonly requests: string[] = [];
	readonly releaseStarted = Promise.withResolvers<void>();
	readonly releaseBlock = Promise.withResolvers<void>();

	override async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		this.requests.push(method);
		if (method === "tools/list") return { tools: [] } as T;
		if (method === "resources/list") return { resources: [{ uri: "file:///prompt-resource", name: "prompt" }] } as T;
		if (method === "resources/templates/list") return { resourceTemplates: [] } as T;
		if (method === "resources/subscribe") return {} as T;
		if (method === "resources/unsubscribe") {
			this.releaseStarted.resolve();
			await this.releaseBlock.promise;
			return {} as T;
		}
		if (method === "prompts/list") return { prompts: [{ name: "greet", arguments: [] }] } as T;
		if (method === "prompts/get")
			return {
				description: "greeting",
				messages: [{ role: "user", content: { type: "text", text: "hello" } }],
			} as T;
		return super.request<T>(method, params, options);
	}
}

class MultiServerToolTransport extends ManagerFakeTransport {
	constructor(
		readonly serverName: string,
		readonly generation: number,
	) {
		super();
	}

	override async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		if (method === "tools/list")
			return { tools: [{ name: `${this.serverName}-${this.generation}`, inputSchema: { type: "object" } }] } as T;
		if (method === "tools/call")
			return { content: [{ type: "text", text: `${this.serverName}-ok-${this.generation}` }] } as T;
		return super.request<T>(method, params, options);
	}
}

class ManagerRetiredTransport extends ManagerFakeTransport {
	readonly closeBeforeReconnect = false;
}

class ManagerResourceTransport extends ManagerFakeTransport {
	readonly requests: string[] = [];

	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		this.requests.push(method);
		if (method === "resources/list") return { resources: [{ uri: "file:///resource" }] } as T;
		if (method === "resources/templates/list") return { resourceTemplates: [] } as T;
		return super.request<T>(method, params, options);
	}
}

test("withPreparedLease admission closes before disconnectAll snapshots scoped operations", async () => {
	const pool = new MCPConnectionPool({
		connect: async (name, config) =>
			({
				name,
				config,
				transport: new ManagerFakeTransport(),
				serverInfo: { name: "fake", version: "1" },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			}) satisfies MCPServerConnection,
	});
	const manager = new MCPManager(".", null, { pool, sessionId: "admission-disconnect" });
	const shutdown = manager.disconnectAll();
	const late = manager.withPreparedLease("late", { type: "stdio", command: "fake-mcp" }, async () => undefined);
	await expect(late).rejects.toMatchObject({ name: "MCPManagerLifecycleError", phase: "disconnect" });
	await shutdown;
	await manager.withPreparedLease("after", { type: "stdio", command: "fake-mcp" }, async lease => {
		expect(lease.serverName).toBe("after");
	});
});

test("withPreparedLease admission closes during reconnect before fresh entry exists", async () => {
	const pool = new MCPConnectionPool({
		connect: async (name, config) =>
			({
				name,
				config,
				transport: new ManagerFakeTransport(),
				serverInfo: { name: "fake", version: "1" },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			}) satisfies MCPServerConnection,
	});
	const manager = new MCPManager(".", null, { pool, sessionId: "admission-reconnect" });
	const config: MCPServerConfig = { type: "stdio", command: "fake-mcp" };
	await manager.connectServers({ fake: config }, {});
	const reconnect = manager.reconnectServer("fake");
	const late = manager.withPreparedLease("fake", config, async () => undefined);
	await expect(late).rejects.toMatchObject({ name: "MCPManagerLifecycleError", phase: "reconnect" });
	await expect(reconnect).resolves.toBeDefined();
	await manager.disconnectAll();
});

test("manager connection lifecycle is owned by pool leases", async () => {
	let opens = 0;
	let transport: ManagerFakeTransport | undefined;
	const pool = new MCPConnectionPool({
		connect: async (name, config) => {
			opens += 1;
			transport = new ManagerFakeTransport();
			return {
				name,
				config,
				transport,
				serverInfo: { name: "fake", version: "1" },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const manager = new MCPManager(".", null, { pool, sessionId: "manager-session" });
	const config: MCPServerConfig = { type: "stdio", command: "fake-mcp" };
	const result = await manager.connectServers({ fake: config }, {});
	expect(result.connectedServers).toEqual(["fake"]);
	expect(opens).toBe(1);
	expect(pool.size).toBe(1);
	await manager.disconnectAll();
	expect(transport?.closeCount).toBe(1);
	expect(pool.size).toBe(0);
});

test("manager resolves one canonical stdio cwd for transport and pool identity", async () => {
	let observedConfig: MCPServerConfig | undefined;
	const pool = new MCPConnectionPool({
		connect: async (name, config) => {
			observedConfig = config;
			return {
				name,
				config,
				transport: new ManagerFakeTransport(),
				serverInfo: { name: "fake", version: "1" },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const manager = new MCPManager(".", null, { pool, sessionId: "cwd-session" });
	const original: MCPServerConfig = { type: "stdio", command: "fake-mcp" };
	const prepared = await manager.prepareConfig(original);
	if (prepared.type !== "stdio") throw new Error("expected stdio config");
	expect(prepared.cwd).toBe(process.cwd());
	await manager.connectServers({ fake: original }, {});
	expect(observedConfig).toMatchObject({ cwd: prepared.cwd });
	expect(pool.getHealth()[0]?.key).toBe(
		computeMCPPoolKey("fake", prepared, {
			keyConfig: original,
			sharingMode: "per-session",
			sessionId: "cwd-session",
			effectiveCwd: prepared.cwd,
			capabilityProfile: "roots",
		}),
	);
	await manager.disconnectAll();
});

test("manager resource subscriptions flow through the lease aggregate", async () => {
	let transport: ManagerResourceTransport | undefined;
	const pool = new MCPConnectionPool({
		connect: async (name, config) => {
			transport = new ManagerResourceTransport();
			return {
				name,
				config,
				transport,
				serverInfo: { name: "fake", version: "1" },
				capabilities: { tools: {}, resources: { subscribe: true } },
				protocol: fakeLegacyProtocol({ tools: {}, resources: { subscribe: true } }),
			} satisfies MCPServerConnection;
		},
	});
	const manager = new MCPManager(".", null, { pool, sessionId: "resource-session" });
	manager.setNotificationsEnabled(true);
	await manager.connectServers({ fake: { type: "stdio", command: "fake-mcp" } }, {});
	await Bun.sleep(20);
	expect(transport?.requests).toContain("resources/subscribe");
	await manager.disconnectAll();
	expect(transport?.requests).toContain("resources/unsubscribe");
});

test("disconnectAll aborts a hanging prepared lease open", async () => {
	let openSignal: AbortSignal | undefined;
	const pool = new MCPConnectionPool({
		connect: async (_name, _config, options) => {
			openSignal = options.signal;
			return new Promise<MCPServerConnection>(() => {
				// The manager/pool abort signal is the only completion path.
			});
		},
	});
	const manager = new MCPManager(".", null, { pool, sessionId: "hanging-session" });
	const operation = manager.withPreparedLease(
		"hanging",
		{ type: "stdio", command: "fake-mcp" },
		async () => undefined,
	);
	await Bun.sleep(0);
	const shutdown = manager.disconnectAll();
	await expect(operation).rejects.toThrow("MCP manager disconnected");
	await shutdown;
	expect(openSignal?.aborted).toBe(true);
});

test("disconnectAll cancels hanging config resolution before opening a lease", async () => {
	const resolver = vi.spyOn(configValue, "resolveConfigValue").mockImplementation(async () => new Promise(() => {}));
	const pool = new MCPConnectionPool({
		connect: async (name, config) =>
			({
				name,
				config,
				transport: new ManagerFakeTransport(),
				serverInfo: { name: "fake", version: "1" },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			}) satisfies MCPServerConnection,
	});
	const manager = new MCPManager(".", null, { pool, sessionId: "config-hang" });
	const operation = manager.withPreparedLease(
		"config-hang",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder the config resolver must expand
		{ type: "stdio", command: "fake-mcp", env: { TOKEN: "${TOKEN}" } },
		async () => undefined,
	);
	operation.catch(() => {});
	await Bun.sleep(0);
	const shutdown = manager.disconnectAll();
	await expect(operation).rejects.toThrow("MCP manager disconnected");
	await shutdown;
	resolver.mockRestore();
});

test("caller abort after acquisition releases a hanging prepared lease", async () => {
	let transport: ManagerFakeTransport | undefined;
	const pool = new MCPConnectionPool({
		connect: async (name, config) => {
			transport = new ManagerFakeTransport();
			return {
				name,
				config,
				transport,
				serverInfo: { name: "fake", version: "1" },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const manager = new MCPManager(".", null, { pool, sessionId: "caller-abort" });
	const controller = new AbortController();
	const entered = Promise.withResolvers<void>();
	const operation = manager.withPreparedLease(
		"caller-abort",
		{ type: "stdio", command: "fake-mcp" },
		async () => {
			entered.resolve();
			await new Promise<void>(() => {});
		},
		{ signal: controller.signal },
	);
	await entered.promise;
	controller.abort(new Error("caller aborted after acquisition"));
	await expect(operation).rejects.toThrow("caller aborted after acquisition");
	expect(transport?.closeCount).toBe(1);
	await manager.disconnectAll();
});

test("disconnectAll releases an active prepared lease and settles its callback", async () => {
	let transport: ManagerFakeTransport | undefined;
	const pool = new MCPConnectionPool({
		connect: async (name, config) => {
			transport = new ManagerFakeTransport();
			return {
				name,
				config,
				transport,
				serverInfo: { name: "fake", version: "1" },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const manager = new MCPManager(".", null, { pool, sessionId: "active-session" });
	const entered = Promise.withResolvers<void>();
	const held = manager.withPreparedLease("active", { type: "stdio", command: "fake-mcp" }, async () => {
		entered.resolve();
		await new Promise<void>(() => {});
	});
	await entered.promise;
	const shutdown = manager.disconnectAll();
	await expect(held).rejects.toThrow("MCP manager disconnected");
	await shutdown;
	expect(transport?.closeCount).toBe(1);
});

test("disconnectAll aggregates active transient release failures", async () => {
	const pool = new MCPConnectionPool({
		connect: async (name, config) => {
			const transport = new ManagerFakeTransport();
			transport.close = async () => {
				throw new Error("transient close failed");
			};
			return {
				name,
				config,
				transport,
				serverInfo: { name: "fake", version: "1" },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const manager = new MCPManager(".", null, { pool, sessionId: "active-failure-session" });
	const entered = Promise.withResolvers<void>();
	const held = manager.withPreparedLease("active-failure", { type: "stdio", command: "fake-mcp" }, async () => {
		entered.resolve();
		await new Promise<void>(() => {});
	});
	await entered.promise;
	held.catch(() => {});
	const shutdown = manager.disconnectAll();
	const shutdownResult = expect(shutdown).rejects.toMatchObject({ name: "AggregateError" });
	await expect(held).rejects.toThrow("MCP manager disconnected");
	await shutdownResult;
});

test("transient lease does not replace the manager-owned lease mapping", async () => {
	let transport: ManagerFakeTransport | undefined;
	const pool = new MCPConnectionPool({
		connect: async (name, config) => {
			transport = new ManagerFakeTransport();
			return {
				name,
				config,
				transport,
				serverInfo: { name: "fake", version: "1" },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const manager = new MCPManager(".", null, { pool, sessionId: "mapping-session" });
	const config: MCPServerConfig = { type: "stdio", command: "fake-mcp" };
	await manager.connectServers({ fake: config }, {});
	await manager.withPreparedLease("fake", config, async lease => {
		const current = manager.getConnection("fake");
		expect(current).toBeDefined();
		expect(lease.connection).toBe(current!);
	});
	await manager.disconnectAll();
	expect(transport?.closeCount).toBe(1);
});

test("prepared transient operations acquire and release through the pool", async () => {
	let opens = 0;
	let closes = 0;
	const pool = new MCPConnectionPool({
		connect: async (name, config) => {
			opens++;
			const transport = new ManagerFakeTransport();
			const originalClose = transport.close.bind(transport);
			transport.close = async () => {
				closes++;
				await originalClose();
			};
			return {
				name,
				config,
				transport,
				serverInfo: { name: "fake", version: "1" },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const manager = new MCPManager(".", null, { pool, sessionId: "transient-session" });
	await manager.withPreparedLease("temporary", { type: "stdio", command: "fake-mcp" }, async lease => {
		expect(lease.connection.name).toBe("temporary");
	});
	expect(opens).toBe(1);
	expect(closes).toBe(1);
	expect(pool.size).toBe(0);
});

test("reconnect retires held transient leases before opening a fresh physical connection", async () => {
	const transports: ManagerFakeTransport[] = [];
	const pool = new MCPConnectionPool({
		connect: async (name, config) => {
			const transport = new ManagerFakeTransport();
			transports.push(transport);
			return {
				name,
				config,
				transport,
				serverInfo: { name: "fake", version: "1" },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const manager = new MCPManager(".", null, { pool, sessionId: "rotation-session" });
	const config: MCPServerConfig = { type: "stdio", command: "fake-mcp" };
	await manager.connectServers({ fake: config }, {});
	const entered = Promise.withResolvers<void>();
	const releaseHeld = Promise.withResolvers<void>();
	const held = manager.withPreparedLease("fake", config, async () => {
		entered.resolve();
		await releaseHeld.promise;
	});
	await entered.promise;
	const original = manager.getConnection("fake");
	const reconnected = await manager.reconnectServer("fake");
	expect(reconnected).toBeDefined();
	expect(reconnected).not.toBe(original);
	expect(transports).toHaveLength(2);
	releaseHeld.resolve();
	await expect(held).rejects.toThrow("MCP server reconnecting: fake");
	await manager.disconnectAll();
});

test("shutdown closes retired and replacement physical entries after HTTP-style rotation", async () => {
	const transports: ManagerRetiredTransport[] = [];
	const oldCloseStarted = Promise.withResolvers<void>();
	const allowOldClose = Promise.withResolvers<void>();
	let opens = 0;
	const pool = new MCPConnectionPool({
		connect: async (name, config) => {
			const transport = new ManagerRetiredTransport();
			if (opens === 0) {
				const close = transport.close.bind(transport);
				transport.close = async () => {
					oldCloseStarted.resolve();
					await allowOldClose.promise;
					await close();
				};
			}
			opens += 1;
			transports.push(transport);
			return {
				name,
				config,
				transport,
				serverInfo: { name: "fake", version: "1" },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const manager = new MCPManager(".", null, { pool, sessionId: "retired-shutdown" });
	const config: MCPServerConfig = { type: "stdio", command: "fake-mcp" };
	await manager.connectServers({ fake: config }, {});
	await expect(manager.reconnectServer("fake")).resolves.toBeDefined();
	await oldCloseStarted.promise;
	expect(transports).toHaveLength(2);
	const shutdown = manager.disconnectAll();
	let shutdownSettled = false;
	void shutdown.finally(() => {
		shutdownSettled = true;
	});
	await Bun.sleep(0);
	expect(shutdownSettled).toBe(false);
	allowOldClose.resolve();
	await shutdown;
	expect(transports[0]?.closeCount).toBe(1);
	expect(transports[1]?.closeCount).toBe(1);
});

test("successful HTTP-style rotations remove settled retired-release records while manager stays live", async () => {
	const transports: ManagerRetiredTransport[] = [];
	const pool = new MCPConnectionPool({
		connect: async (name, config) => {
			const transport = new ManagerRetiredTransport();
			transports.push(transport);
			return {
				name,
				config,
				transport,
				serverInfo: { name: "fake", version: "1" },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const manager = new MCPManager(".", null, { pool, sessionId: "retired-records" });
	const config: MCPServerConfig = { type: "stdio", command: "fake-mcp" };
	await manager.connectServers({ fake: config }, {});
	for (let index = 0; index < 8; index += 1) {
		await expect(manager.reconnectServer("fake")).resolves.toBeDefined();
		await Bun.sleep(0);
		expect(manager.retiredLeaseReleaseCountForTests).toBe(0);
	}
	expect(transports).toHaveLength(9);
	await manager.disconnectAll();
	expect(transports.every(transport => transport.closeCount === 1)).toBe(true);
});

test("manager disconnectAll aggregates a rejecting retired HTTP-style close", async () => {
	const transports: ManagerRetiredTransport[] = [];
	const oldCloseStarted = Promise.withResolvers<void>();
	const allowOldClose = Promise.withResolvers<void>();
	let opens = 0;
	const pool = new MCPConnectionPool({
		connect: async (name, config) => {
			const transport = new ManagerRetiredTransport();
			if (opens === 0) {
				const close = transport.close.bind(transport);
				transport.close = async () => {
					oldCloseStarted.resolve();
					await allowOldClose.promise;
					await close();
					throw new Error("retired close failed");
				};
			}
			opens += 1;
			transports.push(transport);
			return {
				name,
				config,
				transport,
				serverInfo: { name: "fake", version: "1" },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const manager = new MCPManager(".", null, { pool, sessionId: "retired-shutdown-failure" });
	const config: MCPServerConfig = { type: "stdio", command: "fake-mcp" };
	await manager.connectServers({ fake: config }, {});
	await expect(manager.reconnectServer("fake")).resolves.toBeDefined();
	await oldCloseStarted.promise;
	const shutdown = manager.disconnectAll();
	allowOldClose.resolve();
	let rejection: unknown;
	try {
		await shutdown;
	} catch (error) {
		rejection = error;
	}
	expect(rejection).toBeInstanceOf(AggregateError);
	expect((rejection as AggregateError).errors).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				name: "MCPPoolLeaseReleaseError",
				message: expect.stringContaining("retired close failed"),
			}),
		]),
	);
	expect(transports[0]?.closeCount).toBe(2);
	expect(transports[1]?.closeCount).toBe(1);
});

test("reconnect uses the exact backoff schedule and coalesces concurrent requests", async () => {
	let opens = 0;
	const backoff: number[] = [];
	const pool = new MCPConnectionPool({
		connect: async (name, config) => {
			opens++;
			if (opens > 1) throw new Error("temporarily unavailable");
			return {
				name,
				config,
				transport: new ManagerFakeTransport(),
				serverInfo: { name: "fake", version: "1" },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const manager = new MCPManager(".", null, {
		pool,
		sessionId: "backoff-session",
		sleep: async milliseconds => {
			backoff.push(milliseconds);
		},
	});
	try {
		await manager.connectServers({ fake: { type: "stdio", command: "fake-mcp" } }, {});
		const first = manager.reconnectServer("fake");
		const second = manager.reconnectServer("fake");
		await expect(first).resolves.toBeNull();
		await expect(second).resolves.toBeNull();
		expect(backoff).toEqual([500, 1_000, 2_000, 4_000]);
		expect(opens).toBe(6);
	} finally {
		await manager.disconnectAll();
	}
});

test("disconnectAll reports typed lease-release failures after clearing all state", async () => {
	const closeFailure = new Error("close failed");
	const pool = new MCPConnectionPool({
		connect: async (name, config) => {
			const transport = new ManagerFakeTransport();
			transport.close = async () => {
				throw closeFailure;
			};
			return {
				name,
				config,
				transport,
				serverInfo: { name: "fake", version: "1" },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const manager = new MCPManager(".", null, { pool, sessionId: "dispose-session" });
	await manager.connectServers({ fake: { type: "stdio", command: "fake-mcp" } }, {});
	await expect(manager.disconnectAll()).rejects.toMatchObject({ name: "AggregateError" });
	expect(manager.getConnectedServers()).toEqual([]);
	expect(manager.getTools()).toEqual([]);
});

test("manager lease advertises its canonical roots through the pool", async () => {
	const pool = new MCPConnectionPool({
		connect: async (name, config) =>
			({
				name,
				config,
				transport: new ManagerFakeTransport(),
				serverInfo: { name: "fake", version: "1" },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			}) satisfies MCPServerConnection,
	});
	const manager = new MCPManager(".", null, { pool, sessionId: "roots-session" });
	try {
		await manager.connectServers({ fake: { type: "stdio", command: "fake-mcp" } }, {});
		const connection = manager.getConnection("fake");
		const roots = await connection?.transport.onRequest?.("roots/list", {});
		expect(roots).toMatchObject({ roots: [{ uri: expect.stringContaining("file://"), name: expect.any(String) }] });
	} finally {
		await manager.disconnectAll();
	}
});

test("per-session manager facades remain isolated while shared tools-only facades pool one child", async () => {
	let opens = 0;
	const transports: ManagerFakeTransport[] = [];
	const pool = new MCPConnectionPool({
		sharedPoolIdleMs: 10,
		connect: async (name, config) => {
			opens += 1;
			const transport = new ManagerFakeTransport();
			transports.push(transport);
			return {
				name,
				config,
				transport,
				serverInfo: { name: "fake", version: "1" },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const first = new MCPManager(".", null, { pool, sessionId: "session-one" });
	const second = new MCPManager(".", null, { pool, sessionId: "session-two" });
	const sharedFirst = new MCPManager(".", null, { pool, toolsOnly: true, sessionId: "tools-one" });
	const sharedSecond = new MCPManager(".", null, { pool, toolsOnly: true, sessionId: "tools-two" });
	const configPath = `${process.cwd()}/.mcp-w6-shared-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
	try {
		MCPManager.setInstance(first);
		expect(MCPManager.instance()).toBe(first);
		const sharedConfig: MCPServerConfig = { type: "stdio", command: "fake-mcp", sharing: "shared" };
		await Bun.write(configPath, JSON.stringify({ mcpServers: { fake: sharedConfig } }));
		await first.connectServers({ fake: sharedConfig }, {});
		await second.connectServers({ fake: sharedConfig }, {});
		expect(opens).toBe(2);
		await first.disconnectAll();
		await second.disconnectAll();
		await sharedFirst.discoverAndConnect({ configPath });
		await sharedSecond.discoverAndConnect({ configPath });
		expect(opens).toBe(3);
		expect(pool.getHealth().filter(entry => entry.refCount === 2)).toHaveLength(1);
		expect(pool.getHealth().find(entry => entry.refCount === 2)?.refCount).toBe(2);
		await sharedFirst.disconnectAll();
		expect(transports[2]?.closeCount).toBe(0);
		expect(pool.getHealth().find(entry => entry.refCount === 1)?.refCount).toBe(1);
		await sharedSecond.disconnectAll();
		await Bun.sleep(20);
		expect(transports[2]?.closeCount).toBe(1);
	} finally {
		await first.disconnectAll().catch(() => {});
		await second.disconnectAll().catch(() => {});
		await sharedFirst.disconnectAll().catch(() => {});
		await sharedSecond.disconnectAll().catch(() => {});
		await rm(configPath, { force: true });
		MCPManager.resetForTests();
	}
});
test("shared prompt execution stays lease-bound while one manager releases", async () => {
	let transport: SharedPromptTransport | undefined;
	const pool = new MCPConnectionPool({
		connect: async (name, config) => {
			transport = new SharedPromptTransport();
			return {
				name,
				config,
				transport,
				serverInfo: { name: "prompt", version: "1" },
				capabilities: { tools: {}, resources: { subscribe: true }, prompts: {} },
				protocol: fakeLegacyProtocol({ tools: {}, resources: { subscribe: true }, prompts: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const first = new MCPManager(".", null, { pool, sessionId: "prompt-one" });
	const second = new MCPManager(".", null, { pool, sessionId: "prompt-two" });
	const config: MCPServerConfig = { type: "http", url: "https://example.test/mcp", sharing: "shared" };
	try {
		await first.connectServers({ remote: config }, {});
		await second.connectServers({ remote: config }, {});
		for (let attempt = 0; attempt < 100 && !transport?.requests.includes("resources/list"); attempt += 1)
			await Bun.sleep(0);
		first.setNotificationsEnabled(true);
		for (let attempt = 0; attempt < 100 && !transport?.requests.includes("resources/subscribe"); attempt += 1)
			await Bun.sleep(0);
		const release = first.disconnectServer("remote");
		await transport!.releaseStarted.promise;
		await expect(first.executePrompt("remote", "greet")).rejects.toThrow("MCP lease releasing");
		const result = await second.executePrompt("remote", "greet");
		expect(result?.messages).toHaveLength(1);
		transport!.releaseBlock.resolve();
		await release;
	} finally {
		transport?.releaseBlock.resolve();
		await first.disconnectAll().catch(() => {});
		await second.disconnectAll().catch(() => {});
	}
});

test("shared replacement is deferred across an unrelated reconnecting server", async () => {
	let opensA = 0;
	let opensB = 0;
	const transports: MultiServerToolTransport[] = [];
	const aReconnectStarted = Promise.withResolvers<void>();
	const allowAReconnect = Promise.withResolvers<void>();
	const pool = new MCPConnectionPool({
		sharedPoolIdleMs: 0,
		connect: async (name, config) => {
			const generation = name === "a" ? ++opensA : ++opensB;
			if (name === "a" && generation === 2) {
				aReconnectStarted.resolve();
				await allowAReconnect.promise;
			}
			const transport = new MultiServerToolTransport(name, generation);
			transports.push(transport);
			return {
				name,
				config,
				transport,
				serverInfo: { name: "multi", version: String(generation) },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const manager = new MCPManager(".", null, { pool, sessionId: "deferred-rebind-manager" });
	const owner = new MCPManager(".", null, { pool, sessionId: "deferred-rebind-owner" });
	const configA: MCPServerConfig = { type: "stdio", command: "server-a" };
	const configB: MCPServerConfig = { type: "http", url: "https://example.test/shared", sharing: "shared" };
	try {
		await manager.connectServers({ a: configA, b: configB }, {});
		await owner.connectServers({ b: configB }, {});
		expect(
			manager
				.getTools()
				.map(tool => tool.mcpToolName)
				.sort(),
		).toEqual(["a-1", "b-1"]);
		const reconnectA = manager.reconnectServer("a");
		await aReconnectStarted.promise;
		await owner.reconnectServer("b");
		expect(manager.getTools().find(tool => tool.mcpServerName === "b")?.mcpToolName).toBe("b-1");
		allowAReconnect.resolve();
		await reconnectA;
		for (
			let attempt = 0;
			attempt < 100 && manager.getTools().find(tool => tool.mcpServerName === "b")?.mcpToolName !== "b-2";
			attempt += 1
		)
			await Bun.sleep(10);
		expect(
			manager
				.getTools()
				.map(tool => tool.mcpToolName)
				.sort(),
		).toEqual(["a-2", "b-2"]);
		expect(owner.getTools().map(tool => tool.mcpToolName)).toEqual(["b-2"]);
		await manager.disconnectAll();
		await owner.disconnectAll();
		expect(pool.size).toBe(0);
		expect(pool.getHealth()).toHaveLength(0);
		expect(transports).toHaveLength(4);
		expect(transports.every(transport => transport.closeCount === 1)).toBe(true);
	} finally {
		allowAReconnect.resolve();
		await manager.disconnectAll().catch(() => {});
		await owner.disconnectAll().catch(() => {});
	}
});

test("shared replacement rebind reconciles a lease acquired before a second rotation", async () => {
	let opens = 0;
	const transports: MultiServerToolTransport[] = [];
	const peerAcquired = Promise.withResolvers<void>();
	const allowPeerRegistration = Promise.withResolvers<void>();
	let blockedGeneration = 0;
	let blockPeerRegistration = false;
	const pool = new MCPConnectionPool({
		sharedPoolIdleMs: 0,
		connect: async (name, config) => {
			const generation = ++opens;
			const transport = new MultiServerToolTransport(name, generation);
			transports.push(transport);
			return {
				name,
				config,
				transport,
				serverInfo: { name: "generation", version: String(generation) },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const owner = new MCPManager(".", null, { pool, sessionId: "generation-owner" });
	const peer = new MCPManager(".", null, {
		pool,
		sessionId: "generation-peer",
		afterLeaseAcquiredForTests: async (_name, lease) => {
			if (!blockPeerRegistration) return;
			blockPeerRegistration = false;
			blockedGeneration = lease.generation;
			peerAcquired.resolve();
			await allowPeerRegistration.promise;
		},
	});
	const config: MCPServerConfig = {
		type: "http",
		url: "https://example.test/generation",
		sharing: "shared",
		headers: { "X-Test": "generation" },
	};
	try {
		await owner.connectServers({ remote: config }, {});
		await peer.connectServers({ remote: config }, {});
		blockPeerRegistration = true;
		await owner.reconnectServer("remote");
		await peerAcquired.promise;
		expect(blockedGeneration).toBe(2);
		await owner.reconnectServer("remote");
		allowPeerRegistration.resolve();
		for (
			let attempt = 0;
			attempt < 100 && peer.getTools().find(tool => tool.mcpServerName === "remote")?.mcpToolName !== "remote-3";
			attempt += 1
		)
			await Bun.sleep(10);
		expect(owner.getTools().map(tool => tool.mcpToolName)).toEqual(["remote-3"]);
		expect(peer.getTools().map(tool => tool.mcpToolName)).toEqual(["remote-3"]);
		expect(pool.size).toBe(1);
		expect(pool.getHealth()).toHaveLength(1);
		expect(pool.getHealth()[0]?.refCount).toBe(2);
		expect(transports.slice(0, 2).every(transport => transport.closeCount === 1)).toBe(true);
		await peer.disconnectAll();
		await owner.disconnectAll();
		expect(pool.size).toBe(0);
		expect(pool.getHealth()).toHaveLength(0);
		expect(transports).toHaveLength(3);
		expect(transports.every(transport => transport.closeCount === 1)).toBe(true);
	} finally {
		allowPeerRegistration.resolve();
		await peer.disconnectAll().catch(() => {});
		await owner.disconnectAll().catch(() => {});
	}
});

test("shared initial join reconciles a lease acquired before owner rotation", async () => {
	let opens = 0;
	const transports: MultiServerToolTransport[] = [];
	const peerAcquired = Promise.withResolvers<void>();
	const allowPeerRegistration = Promise.withResolvers<void>();
	let blockPeerJoin = false;
	const pool = new MCPConnectionPool({
		sharedPoolIdleMs: 0,
		connect: async (name, config) => {
			const generation = ++opens;
			const transport = new MultiServerToolTransport(name, generation);
			transports.push(transport);
			return {
				name,
				config,
				transport,
				serverInfo: { name: "initial-join", version: String(generation) },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const owner = new MCPManager(".", null, { pool, sessionId: "initial-join-owner" });
	const peer = new MCPManager(".", null, {
		pool,
		sessionId: "initial-join-peer",
		afterLeaseAcquiredForTests: async (_name, lease) => {
			if (!blockPeerJoin) return;
			blockPeerJoin = false;
			expect(lease.generation).toBe(1);
			peerAcquired.resolve();
			await allowPeerRegistration.promise;
		},
	});
	const config: MCPServerConfig = {
		type: "http",
		url: "https://example.test/initial-join",
		sharing: "shared",
		headers: { "X-Test": "initial-join" },
	};
	try {
		await owner.connectServers({ remote: config }, {});
		blockPeerJoin = true;
		const peerJoin = peer.connectServers({ remote: config }, {});
		await peerAcquired.promise;
		expect(peer.getConnection("remote")).toBeUndefined();
		await owner.reconnectServer("remote");
		allowPeerRegistration.resolve();
		await peerJoin;
		expect(owner.getTools().map(tool => tool.mcpToolName)).toEqual(["remote-2"]);
		expect(peer.getTools().map(tool => tool.mcpToolName)).toEqual(["remote-2"]);
		expect(pool.size).toBe(1);
		expect(pool.getHealth()).toHaveLength(1);
		expect(pool.getHealth()[0]?.refCount).toBe(2);
		expect(transports).toHaveLength(2);
		expect(transports[0]?.closeCount).toBe(1);
		await peer.disconnectAll();
		await owner.disconnectAll();
		expect(pool.size).toBe(0);
		expect(pool.getHealth()).toHaveLength(0);
		expect(transports.every(transport => transport.closeCount === 1)).toBe(true);
	} finally {
		allowPeerRegistration.resolve();
		await peer.disconnectAll().catch(() => {});
		await owner.disconnectAll().catch(() => {});
	}
});

test("initial join hook rejection releases the acquired lease", async () => {
	let opens = 0;
	const transports: MultiServerToolTransport[] = [];
	const pool = new MCPConnectionPool({
		sharedPoolIdleMs: 0,
		connect: async (name, config) => {
			const transport = new MultiServerToolTransport(name, ++opens);
			transports.push(transport);
			return {
				name,
				config,
				transport,
				serverInfo: { name: "hook-rejection", version: String(opens) },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const manager = new MCPManager(".", null, {
		pool,
		sessionId: "initial-hook-rejection",
		afterLeaseAcquiredForTests: async () => {
			throw new Error("initial hook rejected");
		},
	});
	const config: MCPServerConfig = { type: "http", url: "https://example.test/hook-rejection", sharing: "shared" };
	try {
		const result = await manager.connectServers({ remote: config }, {});
		expect(result.errors.get("remote")).toContain("initial hook rejected");
		expect(manager.getConnection("remote")).toBeUndefined();
		expect(manager.getConnectedServers()).toEqual([]);
		expect(pool.size).toBe(0);
		expect(pool.getHealth()).toHaveLength(0);
		expect(transports).toHaveLength(1);
		expect(transports[0]?.closeCount).toBe(1);
		await manager.disconnectAll();
		expect(transports[0]?.closeCount).toBe(1);
	} finally {
		await manager.disconnectAll().catch(() => {});
	}
});

test("initial join retry failure clears pending state for a subsequent connect", async () => {
	let opens = 0;
	let failNextOpen = false;
	const transports: MultiServerToolTransport[] = [];
	const peerAcquired = Promise.withResolvers<void>();
	const allowPeerRegistration = Promise.withResolvers<void>();
	let hookCalls = 0;
	const pool = new MCPConnectionPool({
		sharedPoolIdleMs: 0,
		connect: async (name, config) => {
			const generation = ++opens;
			if (failNextOpen) {
				failNextOpen = false;
				throw new Error("retry acquisition failed");
			}
			const transport = new MultiServerToolTransport(name, generation);
			transports.push(transport);
			return {
				name,
				config,
				transport,
				serverInfo: { name: "retry-failure", version: String(generation) },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const owner = new MCPManager(".", null, { pool, sessionId: "retry-owner" });
	const peer = new MCPManager(".", null, {
		pool,
		sessionId: "retry-peer",
		afterLeaseAcquiredForTests: async () => {
			hookCalls += 1;
			if (hookCalls === 1) {
				peerAcquired.resolve();
				await allowPeerRegistration.promise;
			}
		},
	});
	const config: MCPServerConfig = { type: "http", url: "https://example.test/retry-failure", sharing: "shared" };
	try {
		await owner.connectServers({ remote: config }, {});
		const peerJoin = peer.connectServers({ remote: config }, {});
		await peerAcquired.promise;
		await owner.reconnectServer("remote");
		failNextOpen = true;
		await owner.disconnectAll();
		allowPeerRegistration.resolve();
		const failed = await peerJoin;
		expect(failed.errors.get("remote")).toContain("retry acquisition failed");
		expect(peer.getConnection("remote")).toBeUndefined();
		expect(peer.getConnectedServers()).toEqual([]);
		expect(pool.size).toBe(0);
		expect(pool.getHealth()).toHaveLength(0);
		const retry = await peer.connectServers({ remote: config }, {});
		expect(retry.connectedServers).toEqual(["remote"]);
		expect(peer.getTools().map(tool => tool.mcpToolName)).toEqual(["remote-4"]);
		expect(hookCalls).toBe(2);
		await peer.disconnectAll();
		expect(pool.size).toBe(0);
		expect(pool.getHealth()).toHaveLength(0);
		expect(transports).toHaveLength(3);
		expect(transports.every(transport => transport.closeCount === 1)).toBe(true);
	} finally {
		allowPeerRegistration.resolve();
		await peer.disconnectAll().catch(() => {});
		await owner.disconnectAll().catch(() => {});
	}
});

test("shared replacement is requeued when reconnect starts during acquisition", async () => {
	let opensA = 0;
	let opensB = 0;
	const transports: MultiServerToolTransport[] = [];
	const bAcquireStarted = Promise.withResolvers<void>();
	const allowBAcquire = Promise.withResolvers<void>();
	const bAcquireDone = Promise.withResolvers<void>();
	const aReconnectStarted = Promise.withResolvers<void>();
	const allowAReconnect = Promise.withResolvers<void>();
	const pool = new MCPConnectionPool({
		sharedPoolIdleMs: 0,
		connect: async (name, config) => {
			const generation = name === "a" ? ++opensA : ++opensB;
			if (name === "a" && generation === 2) {
				aReconnectStarted.resolve();
				await allowAReconnect.promise;
			}
			if (name === "b" && generation === 3) {
				bAcquireStarted.resolve();
				await allowBAcquire.promise;
			}
			const transport = new MultiServerToolTransport(name, generation);
			transports.push(transport);
			if (name === "b" && generation === 3) bAcquireDone.resolve();
			return {
				name,
				config,
				transport,
				serverInfo: { name: "inverse", version: String(generation) },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const manager = new MCPManager(".", null, { pool, sessionId: "inverse-rebind-manager" });
	const owner = new MCPManager(".", null, { pool, sessionId: "inverse-rebind-owner" });
	const configA: MCPServerConfig = { type: "stdio", command: "server-a" };
	const configBManager: MCPServerConfig = {
		type: "http",
		url: "https://example.test/inverse",
		sharing: "shared",
		headers: { "X-Test": "inverse-token" },
	};
	const configBOwner: MCPServerConfig = {
		...configBManager,
		headers: { "X-Test": "inverse-token" },
	};
	try {
		await manager.connectServers({ a: configA, b: configBManager }, {});
		await owner.connectServers({ b: configBOwner }, {});
		configBManager.headers = { "X-Test": "inverse-rotated-token" };
		await owner.reconnectServer("b");
		await bAcquireStarted.promise;
		const reconnectA = manager.reconnectServer("a");
		await aReconnectStarted.promise;
		allowBAcquire.resolve();
		await bAcquireDone.promise;
		await Bun.sleep(0);
		allowAReconnect.resolve();
		await reconnectA;
		for (
			let attempt = 0;
			attempt < 100 && manager.getTools().find(tool => tool.mcpServerName === "b")?.mcpToolName !== "b-4";
			attempt += 1
		)
			await Bun.sleep(10);
		expect(
			manager
				.getTools()
				.map(tool => tool.mcpToolName)
				.sort(),
		).toEqual(["a-2", "b-4"]);
		expect(owner.getTools().map(tool => tool.mcpToolName)).toEqual(["b-2"]);
		await manager.disconnectAll();
		await owner.disconnectAll();
		expect(pool.size).toBe(0);
		expect(pool.getHealth()).toHaveLength(0);
		expect(opensA).toBe(2);
		expect(opensB).toBe(4);
		expect(transports).toHaveLength(6);
		expect(transports.every(transport => transport.closeCount === 1)).toBe(true);
	} finally {
		allowBAcquire.resolve();
		allowAReconnect.resolve();
		await manager.disconnectAll().catch(() => {});
		await owner.disconnectAll().catch(() => {});
	}
});

test("queued shared replacement is dropped when teardown begins", async () => {
	let opensA = 0;
	let opensB = 0;
	const transports: MultiServerToolTransport[] = [];
	const aReconnectStarted = Promise.withResolvers<void>();
	const allowAReconnect = Promise.withResolvers<void>();
	const pool = new MCPConnectionPool({
		sharedPoolIdleMs: 0,
		connect: async (name, config) => {
			const generation = name === "a" ? ++opensA : ++opensB;
			if (name === "a" && generation === 2) {
				aReconnectStarted.resolve();
				await allowAReconnect.promise;
			}
			const transport = new MultiServerToolTransport(name, generation);
			transports.push(transport);
			return {
				name,
				config,
				transport,
				serverInfo: { name: "drop", version: String(generation) },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const manager = new MCPManager(".", null, { pool, sessionId: "drop-manager" });
	const owner = new MCPManager(".", null, { pool, sessionId: "drop-owner" });
	const configA: MCPServerConfig = { type: "stdio", command: "server-a" };
	const configB: MCPServerConfig = { type: "http", url: "https://example.test/drop", sharing: "shared" };
	try {
		await manager.connectServers({ a: configA, b: configB }, {});
		await owner.connectServers({ b: configB }, {});
		const reconnectA = manager.reconnectServer("a");
		await aReconnectStarted.promise;
		await owner.reconnectServer("b");
		await manager.disconnectAll();
		allowAReconnect.resolve();
		await reconnectA;
		await owner.disconnectAll();
		expect(manager.getConnection("a")).toBeUndefined();
		expect(manager.getConnection("b")).toBeUndefined();
		expect(pool.size).toBe(0);
		expect(pool.getHealth()).toHaveLength(0);
		expect(opensA).toBe(2);
		expect(opensB).toBe(2);
		expect(transports).toHaveLength(4);
		expect(transports.every(transport => transport.closeCount === 1)).toBe(true);
	} finally {
		allowAReconnect.resolve();
		await manager.disconnectAll().catch(() => {});
		await owner.disconnectAll().catch(() => {});
	}
});

test("shared replacement rebind is fenced when peer disconnects during old-lease teardown", async () => {
	let opens = 0;
	const transports: SharedPromptTransport[] = [];
	const pool = new MCPConnectionPool({
		sharedPoolIdleMs: 0,
		connect: async (name, config) => {
			opens += 1;
			const transport = new SharedPromptTransport();
			transports.push(transport);
			return {
				name,
				config,
				transport,
				serverInfo: { name: "race", version: String(opens) },
				capabilities: { tools: {}, resources: { subscribe: true }, prompts: {} },
				protocol: fakeLegacyProtocol({ tools: {}, resources: { subscribe: true }, prompts: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const owner = new MCPManager(".", null, { pool, sessionId: "race-owner" });
	const peer = new MCPManager(".", null, { pool, sessionId: "race-peer" });
	const config: MCPServerConfig = { type: "http", url: "https://example.test/mcp", sharing: "shared" };
	try {
		await owner.connectServers({ remote: config }, {});
		await peer.connectServers({ remote: config }, {});
		const oldTransport = transports[0]!;
		for (let attempt = 0; attempt < 100 && !oldTransport.requests.includes("resources/list"); attempt += 1)
			await Bun.sleep(0);
		peer.setNotificationsEnabled(true);
		for (let attempt = 0; attempt < 100 && !oldTransport.requests.includes("resources/subscribe"); attempt += 1)
			await Bun.sleep(0);

		const replacement = owner.reconnectServer("remote");
		await oldTransport.releaseStarted.promise;
		const teardown = peer.disconnectAll();
		await teardown;
		oldTransport.releaseBlock.resolve();
		await replacement;
		await owner.disconnectAll();
		await Bun.sleep(0);

		expect(peer.getConnection("remote")).toBeUndefined();
		expect(owner.getConnection("remote")).toBeUndefined();
		expect(pool.size).toBe(0);
		expect(pool.getHealth()).toHaveLength(0);
		expect(opens).toBe(2);
		expect(transports).toHaveLength(2);
		expect(transports.every(transport => transport.closeCount === 1)).toBe(true);
	} finally {
		for (const transport of transports) transport.releaseBlock.resolve();
		await owner.disconnectAll().catch(() => {});
		await peer.disconnectAll().catch(() => {});
	}
});

test("shared noReplay request failure coordinates one replacement without resending the call", async () => {
	let opens = 0;
	const transports: SharedToolTransport[] = [];
	const pool = new MCPConnectionPool({
		connect: async (name, config) => {
			opens += 1;
			const transport = new SharedToolTransport(opens, opens === 1);
			transports.push(transport);
			return {
				name,
				config,
				transport,
				serverInfo: { name: "recovery", version: "1" },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const first = new MCPManager(".", null, { pool, sessionId: "recovery-one" });
	const second = new MCPManager(".", null, { pool, sessionId: "recovery-two" });
	const config: MCPServerConfig = { type: "http", url: "https://example.test/mcp", sharing: "shared" };
	try {
		await first.connectServers({ remote: config }, {});
		await second.connectServers({ remote: config }, {});
		const failed = await first.getTools()[0]!.execute("failed-call", {}, undefined, {} as never);
		expect(failed.details?.isError).toBe(true);
		expect(transports[0]?.callCount).toBe(1);
		for (let attempt = 0; attempt < 100 && second.getTools()[0]?.mcpToolName !== "shared-2"; attempt += 1)
			await Bun.sleep(10);
		expect(opens).toBe(2);
		expect(first.getTools()[0]?.mcpToolName).toBe("shared-2");
		expect(second.getTools()[0]?.mcpToolName).toBe("shared-2");
		const firstResult = await first.getTools()[0]!.execute("first-later", {}, undefined, {} as never);
		const secondResult = await second.getTools()[0]!.execute("second-later", {}, undefined, {} as never);
		expect(firstResult.content).toEqual([{ type: "text", text: "ok-2" }]);
		expect(secondResult.content).toEqual([{ type: "text", text: "ok-2" }]);
	} finally {
		await first.disconnectAll().catch(() => {});
		await second.disconnectAll().catch(() => {});
	}
});

test("released shared facade tools fail live-state checks while surviving lease still works", async () => {
	let opens = 0;
	const transports: SharedToolTransport[] = [];
	const pool = new MCPConnectionPool({
		sharedPoolIdleMs: 0,
		connect: async (name, config) => {
			opens += 1;
			const transport = new SharedToolTransport();
			transports.push(transport);
			return {
				name,
				config,
				transport,
				serverInfo: { name: "fake", version: "1" },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const first = new MCPManager(".", null, { pool, toolsOnly: true, sessionId: "facade-one" });
	const second = new MCPManager(".", null, { pool, toolsOnly: true, sessionId: "facade-two" });
	const configPath = `${process.cwd()}/.mcp-w6-facade-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
	try {
		const config: MCPServerConfig = { type: "stdio", command: "fake-mcp", sharing: "shared" };
		await Bun.write(configPath, JSON.stringify({ mcpServers: { fake: config } }));
		await first.discoverAndConnect({ configPath });
		await second.discoverAndConnect({ configPath });
		expect(opens).toBe(1);
		const firstTool = first.getTools()[0];
		const secondTool = second.getTools()[0];
		expect(firstTool).toBeDefined();
		expect(secondTool).toBeDefined();
		await first.disconnectAll();
		const staleResult = await firstTool!.execute("stale", {}, undefined, {} as never);
		expect(staleResult.details?.isError).toBe(true);
		const liveResult = await secondTool!.execute("live", {}, undefined, {} as never);
		expect(liveResult.details?.isError).not.toBe(true);
		await second.disconnectAll();
	} finally {
		await first.disconnectAll().catch(() => {});
		await second.disconnectAll().catch(() => {});
		await rm(configPath, { force: true });
	}
});

test("shared restart rebinds every surviving manager lease before subsequent calls", async () => {
	let opens = 0;
	let firstTransport: SharedToolTransport | undefined;
	const pool = new MCPConnectionPool({
		connect: async (name, config) => {
			opens += 1;
			const transport = new SharedToolTransport(opens);
			if (opens === 1) firstTransport = transport;
			return {
				name,
				config,
				transport,
				serverInfo: { name: "fake", version: "1" },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const first = new MCPManager(".", null, { pool, toolsOnly: true, sessionId: "rebind-one" });
	const second = new MCPManager(".", null, { pool, toolsOnly: true, sessionId: "rebind-two" });
	const configPath = `${process.cwd()}/.mcp-w6-rebind-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
	try {
		const config: MCPServerConfig = { type: "stdio", command: "fake-mcp", sharing: "shared" };
		await Bun.write(configPath, JSON.stringify({ mcpServers: { fake: config } }));
		await first.discoverAndConnect({ configPath });
		await second.discoverAndConnect({ configPath });
		expect(first.getTools()[0]?.mcpToolName).toBe("shared-1");
		firstTransport?.onClose?.();
		for (let attempt = 0; attempt < 100 && second.getTools()[0]?.mcpToolName !== "shared-2"; attempt += 1)
			await Bun.sleep(10);
		expect(opens).toBe(2);
		expect(first.getTools()[0]?.mcpToolName).toBe("shared-2");
		expect(second.getTools()[0]?.mcpToolName).toBe("shared-2");
		const firstResult = await first.getTools()[0]!.execute("first", {}, undefined, {} as never);
		const secondResult = await second.getTools()[0]!.execute("second", {}, undefined, {} as never);
		expect(firstResult.content).toEqual([{ type: "text", text: "ok-2" }]);
		expect(secondResult.content).toEqual([{ type: "text", text: "ok-2" }]);
	} finally {
		await first.disconnectAll().catch(() => {});
		await second.disconnectAll().catch(() => {});
		await rm(configPath, { force: true });
	}
});

test("shared transport crash has one restart owner across manager facades", async () => {
	let opens = 0;
	let firstTransport: ManagerFakeTransport | undefined;
	const pool = new MCPConnectionPool({
		connect: async (name, config) => {
			opens += 1;
			const transport = new ManagerFakeTransport();
			if (opens === 1) firstTransport = transport;
			return {
				name,
				config,
				transport,
				serverInfo: { name: "fake", version: "1" },
				capabilities: { tools: {} },
				protocol: fakeLegacyProtocol({ tools: {} }),
			} satisfies MCPServerConnection;
		},
	});
	const first = new MCPManager(".", null, { pool, toolsOnly: true, sessionId: "restart-one" });
	const second = new MCPManager(".", null, { pool, toolsOnly: true, sessionId: "restart-two" });
	const configPath = `${process.cwd()}/.mcp-w6-restart-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
	try {
		const config: MCPServerConfig = { type: "stdio", command: "fake-mcp", sharing: "shared" };
		await Bun.write(configPath, JSON.stringify({ mcpServers: { fake: config } }));
		await first.discoverAndConnect({ configPath });
		await second.discoverAndConnect({ configPath });
		expect(opens).toBe(1);
		firstTransport?.onClose?.();
		for (let attempt = 0; attempt < 100 && opens < 2; attempt += 1) await Bun.sleep(10);
		expect(opens).toBe(2);
	} finally {
		await first.disconnectAll().catch(() => {});
		await second.disconnectAll().catch(() => {});
		await rm(configPath, { force: true });
	}
});

test("shared HTTP leases use one MCP session and one callback stream while releasing independently", async () => {
	let initializeCount = 0;
	let toolsListCount = 0;
	let streamCount = 0;
	let deleteCount = 0;
	const streamControllers: ReadableStreamDefaultController<Uint8Array>[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			if (request.method === "GET") {
				streamCount += 1;
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						streamControllers.push(controller);
						controller.enqueue(new TextEncoder().encode(": connected\n\n"));
					},
				});
				return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
			}
			if (request.method === "DELETE") {
				deleteCount += 1;
				return new Response(null, { status: 202 });
			}
			const message = (await request.json()) as { id: string | number; method: string };
			if (message.method === "initialize") {
				initializeCount += 1;
				return Response.json(
					{
						jsonrpc: "2.0",
						id: message.id,
						result: {
							protocolVersion: "2025-03-26",
							capabilities: { tools: {} },
							serverInfo: { name: "shared-http", version: "1" },
						},
					},
					{ headers: { "Mcp-Session-Id": "shared-session" } },
				);
			}
			if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
			if (message.method === "tools/list") {
				toolsListCount += 1;
				return Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
			}
			if (message.method === "server/discover") return legacyMcpMethodNotFound(message.id);
			return Response.json({ jsonrpc: "2.0", id: message.id, result: {} });
		},
	});
	const pool = new MCPConnectionPool({ sharedPoolIdleMs: 0 });
	const first = new MCPManager(".", null, { pool, sessionId: "http-one" });
	const second = new MCPManager(".", null, { pool, sessionId: "http-two" });
	const config: MCPServerConfig = {
		type: "http",
		url: `${server.url.href}mcp?tenant=one`,
		sharing: "shared",
		timeout: 1_000,
	};
	try {
		await expect(first.connectServers({ remote: config }, {})).resolves.toMatchObject({
			connectedServers: ["remote"],
		});
		await expect(second.connectServers({ remote: config }, {})).resolves.toMatchObject({
			connectedServers: ["remote"],
		});
		expect(initializeCount).toBe(1);
		expect(streamCount).toBe(1);
		expect(toolsListCount).toBe(1);
		await first.disconnectAll();
		expect(deleteCount).toBe(0);
		await second.disconnectAll();
		expect(deleteCount).toBe(1);
	} finally {
		for (const controller of streamControllers) {
			try {
				controller.close();
			} catch {
				// The transport may already have cancelled the stream during teardown.
			}
		}
		await first.disconnectAll().catch(() => {});
		await second.disconnectAll().catch(() => {});
		server.stop(true);
	}
});
test("S7-style HTTP stub keeps distinct paths and queries on one host in separate entries", async () => {
	const initializePaths: string[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			if (request.method === "GET") return new Response(null, { status: 405 });
			if (request.method === "DELETE") return new Response(null, { status: 202 });
			const url = new URL(request.url);
			const message = (await request.json()) as { id: string | number; method: string };
			if (message.method === "initialize") {
				initializePaths.push(`${url.pathname}${url.search}`);
				return Response.json(
					{
						jsonrpc: "2.0",
						id: message.id,
						result: {
							protocolVersion: "2025-03-26",
							capabilities: { tools: {} },
							serverInfo: { name: "s7", version: "1" },
						},
					},
					{ headers: { "Mcp-Session-Id": `s7-${initializePaths.length}` } },
				);
			}
			if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
			if (message.method === "tools/list")
				return Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
			if (message.method === "server/discover") return legacyMcpMethodNotFound(message.id);
			return Response.json({ jsonrpc: "2.0", id: message.id, result: {} });
		},
	});
	const pool = new MCPConnectionPool({ sharedPoolIdleMs: 0 });
	const base = server.url.href;
	const left = await pool.acquire(
		"remote",
		{ type: "http", url: `${base}alpha?tenant=one&tenant=two`, sharing: "shared" },
		{ sharingMode: "shared" },
	);
	const right = await pool.acquire(
		"remote",
		{ type: "http", url: `${base}beta?tenant=one&tenant=two`, sharing: "shared" },
		{ sharingMode: "shared" },
	);
	try {
		expect(pool.getHealth()).toHaveLength(2);
		expect(new Set(initializePaths)).toEqual(
			new Set(["/alpha?tenant=one&tenant=two", "/beta?tenant=one&tenant=two"]),
		);
	} finally {
		await left.release();
		await right.release();
		server.stop(true);
	}
});

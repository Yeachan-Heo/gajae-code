import { describe, expect, test } from "bun:test";
import { MCPConnectionCleanupFailure } from "./client";
import { MCPManager } from "./manager";
import { MCPConnectionPool, MCPPoolAcquireAbortError, MCPPoolLeaseInvalidatedError } from "./pool";
import { MCPPoolConfigError } from "./pool-key";
import { legacyEraObservation } from "./protocol";
import type { MCPRequestOptions, MCPServerConfig, MCPServerConnection, MCPTransport } from "./types";
import { MCPExpectedFailure, MCPNotificationMethods } from "./types";

class FakeTransport implements MCPTransport {
	connected = true;
	closeCount = 0;
	requests: string[] = [];
	notifications: string[] = [];
	onClose?: () => void;
	failSubscribe = false;
	failUnsubscribe = false;
	failSubscribeUri?: string;
	failUnsubscribeUri?: string;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;

	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		_options?: MCPRequestOptions,
	): Promise<T> {
		this.requests.push(method);
		const uri = typeof params?.uri === "string" ? params.uri : undefined;
		if (method === "resources/subscribe") {
			if (this.failSubscribe || uri === this.failSubscribeUri) throw new Error("subscribe failed");
			return {} as T;
		}
		if (method === "resources/unsubscribe") {
			if (this.failUnsubscribe || uri === this.failUnsubscribeUri) throw new Error("unsubscribe failed");
			return {} as T;
		}
		return {} as T;
	}

	async notify(method: string): Promise<void> {
		if (!this.connected) throw new MCPExpectedFailure();
		this.notifications.push(method);
	}

	async close(): Promise<void> {
		this.closeCount += 1;
		this.connected = false;
	}
}

class ToolListTransport extends FakeTransport {
	override async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		if (method === "tools/list") return { tools: [] } as T;
		return super.request<T>(method, params, options);
	}
}

class DelayedSubscriptionTransport extends FakeTransport {
	readonly subscribeStarted = Promise.withResolvers<void>();
	readonly allowSubscribe = Promise.withResolvers<void>();

	override async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		if (method === "resources/subscribe") {
			this.subscribeStarted.resolve();
			await this.allowSubscribe.promise;
		}
		return super.request<T>(method, params, options);
	}
}

class CrashCallTransport extends FakeTransport {
	callCount = 0;
	readonly callStarted = Promise.withResolvers<void>();
	#rejectCall?: (error: Error) => void;

	override request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		if (method !== "tools/call") return super.request<T>(method, params, options);
		this.callCount += 1;
		this.callStarted.resolve();
		return new Promise<T>((_resolve, reject) => {
			this.#rejectCall = reject;
		});
	}

	crash(): void {
		this.connected = false;
		const failure = new MCPExpectedFailure(new Error("shared transport crashed"));
		this.#rejectCall?.(failure);
		this.#rejectCall = undefined;
		this.onError?.(failure);
		this.onClose?.();
	}
}

function config(sharing?: "per-session" | "shared"): MCPServerConfig {
	return { type: "stdio", command: "fake-mcp", args: ["--test"], sharing };
}

function connection(name: string, configValue: MCPServerConfig, transport: FakeTransport): MCPServerConnection {
	return {
		name,
		config: configValue,
		transport,
		serverInfo: { name: "fake", version: "1" },
		capabilities: { tools: {}, resources: { subscribe: true } },
		protocol: legacyEraObservation({
			preference: "auto",
			effectiveVersion: "2025-03-26",
			negotiation: "legacy-forced",
			downgradeReason: "stdio-transport",
			serverInfo: { name: "fake", version: "1" },
			capabilities: { tools: true, resources: true },
		}),
	};
}

test("shared leases broadcast catalog notifications, union roots, and reject unknown notifications", async () => {
	const transport = new FakeTransport();
	const pool = new MCPConnectionPool({ connect: async (name, cfg) => connection(name, cfg, transport) });
	const first = await pool.acquire("server", config("shared"), { sharingMode: "shared" });
	const second = await pool.acquire("server", config("shared"), { sharingMode: "shared" });
	const firstEvents: string[] = [];
	const secondEvents: string[] = [];
	first.onEvent(event => event.type === "notification" && firstEvents.push(event.method));
	second.onEvent(event => event.type === "notification" && secondEvents.push(event.method));
	first.updateRoots([{ uri: "file:///one", name: "one" }]);
	second.updateRoots([{ uri: "file:///two", name: "two" }]);
	expect(await transport.onRequest?.("roots/list", {})).toEqual({
		roots: [
			{ uri: "file:///one", name: "one" },
			{ uri: "file:///two", name: "two" },
		],
	});
	await Bun.sleep(0);
	expect(transport.notifications).toEqual(["notifications/roots/list_changed"]);
	transport.onNotification?.(MCPNotificationMethods.TOOLS_LIST_CHANGED, {});
	transport.onNotification?.("notifications/unknown", {});
	expect(firstEvents).toEqual([MCPNotificationMethods.TOOLS_LIST_CHANGED]);
	expect(secondEvents).toEqual([MCPNotificationMethods.TOOLS_LIST_CHANGED]);
	expect(pool.getHealth()[0]?.events.some(event => event.message?.includes("Unsupported MCP notification"))).toBe(
		true,
	);
	await first.release();
	expect(await transport.onRequest?.("roots/list", {})).toEqual({ roots: [{ uri: "file:///two", name: "two" }] });
	await second.release();
	await Bun.sleep(0);
	expect(transport.notifications).toEqual([
		"notifications/roots/list_changed",
		"notifications/roots/list_changed",
		"notifications/roots/list_changed",
	]);
});

test("a shared crash rejects only the in-flight calling lease with a typed error", async () => {
	const transport = new CrashCallTransport();
	const pool = new MCPConnectionPool({ connect: async (name, cfg) => connection(name, cfg, transport) });
	const first = await pool.acquire("server", config("shared"), { sharingMode: "shared" });
	const second = await pool.acquire("server", config("shared"), { sharingMode: "shared" });
	const call = first.request("tools/call", { name: "work" });
	await transport.callStarted.promise;
	transport.crash();
	await expect(call).rejects.toBeInstanceOf(MCPExpectedFailure);
	expect(transport.callCount).toBe(1);
	await first.release();
	await second.release();
});

test("shared tools-only entries reject sampling and elicitation requests and gate restart ownership", async () => {
	const transport = new FakeTransport();
	const pool = new MCPConnectionPool({ connect: async (name, cfg) => connection(name, cfg, transport) });
	const lease = await pool.acquire("server", config("shared"), {
		sharingMode: "shared",
		capabilityProfile: "tools-only",
	});
	await expect(transport.onRequest?.("sampling/createMessage", {})).rejects.toMatchObject({ code: -32601 });
	await expect(transport.onRequest?.("elicitation/create", {})).rejects.toMatchObject({ code: -32601 });
	expect(pool.claimRestart(lease.key)).toBe(true);
	expect(pool.claimRestart(lease.key)).toBe(false);
	pool.releaseRestart(lease.key);
	expect(pool.claimRestart(lease.key)).toBe(true);
	pool.releaseRestart(lease.key);
	await lease.release();
});
test("shared SSE leases retain one physical callback transport until the last release", async () => {
	let opens = 0;
	const transport = new FakeTransport();
	const pool = new MCPConnectionPool({
		sharedPoolIdleMs: 0,
		connect: async (name, cfg) => {
			opens += 1;
			return connection(name, cfg, transport);
		},
	});
	const configValue: MCPServerConfig = { type: "sse", url: "https://example.test/events", sharing: "shared" };
	const first = await pool.acquire("remote", configValue, { sharingMode: "shared" });
	const second = await pool.acquire("remote", configValue, { sharingMode: "shared" });
	expect(opens).toBe(1);
	await first.release();
	expect(transport.closeCount).toBe(0);
	await second.release();
	expect(transport.closeCount).toBe(1);
});
test("releasing subscribed leases after shared transport close detaches locally without dead RPC", async () => {
	const transport = new FakeTransport();
	const pool = new MCPConnectionPool({ connect: async (name, cfg) => connection(name, cfg, transport) });
	const first = await pool.acquire("remote", config("shared"), { sharingMode: "shared" });
	const second = await pool.acquire("remote", config("shared"), { sharingMode: "shared" });
	await first.setResourceSubscriptions(["file:///resource"]);
	await second.setResourceSubscriptions(["file:///resource"]);
	transport.connected = false;
	transport.onClose?.();
	await first.release();
	await second.release();
	expect(transport.requests.filter(method => method === "resources/unsubscribe")).toHaveLength(0);
	expect(pool.size).toBe(0);
});

test("repeated shared crash cleanup does not retain retired entries", async () => {
	let opens = 0;
	const transports: FakeTransport[] = [];
	const pool = new MCPConnectionPool({
		connect: async (name, cfg) => {
			opens += 1;
			const transport = new FakeTransport();
			transports.push(transport);
			return connection(name, cfg, transport);
		},
	});
	for (let index = 0; index < 5; index += 1) {
		const lease = await pool.acquire("remote", config("shared"), { sharingMode: "shared" });
		transports[index]?.onClose?.();
		await lease.release();
		expect(pool.size).toBe(0);
	}
	expect(opens).toBe(5);
});

test("retired lease already closed is removed during release cleanup", async () => {
	const transport = new FakeTransport();
	const pool = new MCPConnectionPool({ connect: async (name, cfg) => connection(name, cfg, transport) });
	const lease = await pool.acquire("remote", config("shared"), { sharingMode: "shared" });
	pool.retireLease(lease);
	transport.connected = false;
	transport.onClose?.();
	await lease.release();
	expect(pool.size).toBe(0);
	await pool.shutdown();
	expect(transport.closeCount).toBe(0);
});

describe("MCPConnectionPool", () => {
	test("ref-counts shared leases and closes on final release", async () => {
		let opens = 0;
		const transports: FakeTransport[] = [];
		const pool = new MCPConnectionPool({
			sharedPoolIdleMs: 0,
			connect: async (name, cfg) => {
				opens += 1;
				const transport = new FakeTransport();
				transports.push(transport);
				return connection(name, cfg, transport);
			},
		});
		const first = await pool.acquire("server", config("shared"), { sharingMode: "shared" });
		const second = await pool.acquire("server", config("shared"), { sharingMode: "shared", sessionId: "ignored" });
		expect(first.key).toBe(second.key);
		expect(opens).toBe(1);
		expect(pool.getHealth()[0]?.refCount).toBe(2);
		await first.release();
		expect(pool.getHealth()[0]?.refCount).toBe(1);
		await second.release();
		await Bun.sleep(0);
		expect(transports[0]?.closeCount).toBe(1);
		expect(pool.size).toBe(0);
	});

	test("keeps distinct physical entries for per-session leases", async () => {
		let opens = 0;
		const pool = new MCPConnectionPool({
			connect: async (name, cfg) => {
				opens += 1;
				return connection(name, cfg, new FakeTransport());
			},
		});
		const first = await pool.acquire("server", config(), { sessionId: "one" });
		const second = await pool.acquire("server", config(), { sessionId: "two" });
		expect(first.key).not.toBe(second.key);
		expect(opens).toBe(2);
		expect(pool.size).toBe(2);
		await pool.shutdown();
		expect(pool.size).toBe(0);
	});

	test("rejects per-session acquire without a non-empty session id", async () => {
		const pool = new MCPConnectionPool({ connect: async (name, cfg) => connection(name, cfg, new FakeTransport()) });
		await expect(pool.acquire("server", config())).rejects.toBeInstanceOf(MCPPoolConfigError);
		await expect(pool.acquire("server", config(), { sessionId: "" })).rejects.toMatchObject({
			name: "MCPPoolConfigError",
			code: "MCP_SESSION_ID_REQUIRED",
		});
	});

	test("aggregates resource subscriptions across shared leases", async () => {
		const transport = new FakeTransport();
		const pool = new MCPConnectionPool({
			sharedPoolIdleMs: 0,
			connect: async (name, cfg) => connection(name, cfg, transport),
		});
		const first = await pool.acquire("server", config("shared"), { sharingMode: "shared" });
		const second = await pool.acquire("server", config("shared"), { sharingMode: "shared" });
		await first.setResourceSubscriptions(["file:///same"]);
		await second.setResourceSubscriptions(["file:///same"]);
		expect(transport.requests.filter(method => method === "resources/subscribe")).toHaveLength(1);
		await first.release();
		expect(transport.requests.filter(method => method === "resources/unsubscribe")).toHaveLength(0);
		await second.release();
		expect(transport.requests.filter(method => method === "resources/unsubscribe")).toHaveLength(1);
	});

	test("release waits for an in-flight shared subscription update before removing its counts", async () => {
		const transport = new DelayedSubscriptionTransport();
		const pool = new MCPConnectionPool({
			sharedPoolIdleMs: 0,
			connect: async (name, cfg) => connection(name, cfg, transport),
		});
		const lease = await pool.acquire("server", config("shared"), { sharingMode: "shared" });
		const setPromise = lease.setResourceSubscriptions(["file:///race"]);
		await transport.subscribeStarted.promise;
		const releasePromise = lease.release();
		await expect(lease.setResourceSubscriptions(["file:///late"])).resolves.toBeUndefined();
		let releaseSettled = false;
		void releasePromise.finally(() => {
			releaseSettled = true;
		});
		await Bun.sleep(0);
		expect(releaseSettled).toBe(false);
		transport.allowSubscribe.resolve();
		await setPromise;
		await releasePromise;
		expect(transport.requests.filter(method => method === "resources/subscribe")).toHaveLength(1);
		expect(transport.requests.filter(method => method === "resources/unsubscribe")).toHaveLength(1);

		const replacementLease = await pool.acquire("server", config("shared"), { sharingMode: "shared" });
		await replacementLease.setResourceSubscriptions(["file:///race"]);
		expect(transport.requests.filter(method => method === "resources/subscribe")).toHaveLength(2);
		await replacementLease.release();
		expect(transport.requests.filter(method => method === "resources/unsubscribe")).toHaveLength(2);
		await pool.shutdown();
	});

	test("aborted acquire aborts the opener and closes a late transport", async () => {
		let resolveOpen: ((value: MCPServerConnection) => void) | undefined;
		let openSignal: AbortSignal | undefined;
		const transport = new FakeTransport();
		const pool = new MCPConnectionPool({
			connect: async (_name, _cfg, options) => {
				openSignal = options.signal;
				return new Promise<MCPServerConnection>(resolve => {
					resolveOpen = resolve;
				});
			},
		});
		const controller = new AbortController();
		const acquire = pool.acquire("server", config(), { sessionId: "aborted", signal: controller.signal });
		await Bun.sleep(0);
		controller.abort(new Error("caller aborted"));
		await expect(acquire).rejects.toThrow("caller aborted");
		expect(openSignal?.aborted).toBe(true);
		resolveOpen?.(connection("server", config(), transport));
		await Bun.sleep(0);
		expect(transport.closeCount).toBe(1);
		await pool.shutdown();
	});

	test("retains cancelled cleanup before late failure and fences each cleanup generation", async () => {
		const flights = [Promise.withResolvers<MCPServerConnection>(), Promise.withResolvers<MCPServerConnection>()];
		const starts = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const recoveryTransports: FakeTransport[] = [];
		let opens = 0;
		const pool = new MCPConnectionPool({
			connect: async (name, cfg) => {
				opens += 1;
				if (opens === 1) {
					starts[0]?.resolve();
					return flights[0]!.promise;
				}
				if (opens === 3) {
					starts[1]?.resolve();
					return flights[1]!.promise;
				}
				const transport = new FakeTransport();
				recoveryTransports.push(transport);
				return connection(name, cfg, transport);
			},
		});
		const acquireCancelledFlight = async (index: number): Promise<MCPPoolAcquireAbortError> => {
			const controller = new AbortController();
			const acquire = pool.acquire("server", config(), {
				sessionId: "retained-cleanup",
				signal: controller.signal,
			});
			await starts[index]!.promise;
			controller.abort(new Error(`caller abort ${index}`));
			const error = await acquire.catch(error => error);
			expect(error).toBeInstanceOf(MCPPoolAcquireAbortError);
			if (!(error instanceof MCPPoolAcquireAbortError)) throw new Error("Expected aborted pool acquisition");
			return error;
		};

		const firstAbort = await acquireCancelledFlight(0);
		expect(pool.pendingAcquireCleanupCountForTests).toBe(1);
		expect(opens).toBe(1);
		const firstCleanupTransport = new FakeTransport();
		let fencedSettled = false;
		const fenced = pool.acquire("server", config(), { sessionId: "retained-cleanup" });
		void fenced.then(
			() => {
				fencedSettled = true;
			},
			() => {
				fencedSettled = true;
			},
		);
		await Promise.resolve();
		expect(fencedSettled).toBe(false);
		expect(opens).toBe(1);
		flights[0]!.reject(new MCPConnectionCleanupFailure(new Error("late cleanup failure 1"), firstCleanupTransport));
		await expect(fenced).resolves.toBeDefined();
		expect(firstCleanupTransport.closeCount).toBe(1);
		expect(opens).toBe(2);

		const secondLease = await fenced;
		await secondLease.release();
		const secondAbort = await acquireCancelledFlight(1);
		expect(secondAbort.cleanupGeneration).toBeGreaterThan(firstAbort.cleanupGeneration ?? 0);
		const secondCleanupTransport = new FakeTransport();
		flights[1]!.reject(new MCPConnectionCleanupFailure(new Error("late cleanup failure 2"), secondCleanupTransport));
		await expect(secondAbort.cleanup).rejects.toBeInstanceOf(MCPConnectionCleanupFailure);
		await pool.closePendingAcquireCleanup(firstAbort.poolKey, firstAbort.cleanupGeneration!);
		expect(secondCleanupTransport.closeCount).toBe(0);
		expect(pool.pendingAcquireCleanupCountForTests).toBe(1);
		await pool.closePendingAcquireCleanup(secondAbort.poolKey, secondAbort.cleanupGeneration!);
		expect(secondCleanupTransport.closeCount).toBe(1);
		expect(pool.pendingAcquireCleanupCountForTests).toBe(0);
		const recovered = await pool.acquire("server", config(), { sessionId: "retained-cleanup" });
		expect(opens).toBe(4);
		await recovered.release();
		expect(recoveryTransports).toHaveLength(2);
	});

	test("manager disconnect joins and retries pool-owned late cleanup without spawning", async () => {
		const firstFlight = Promise.withResolvers<MCPServerConnection>();
		const firstStarted = Promise.withResolvers<void>();
		const cleanupTransport = new FakeTransport();
		const retryFailure = new Error("deferred cleanup retry failed");
		let cleanupAttempts = 0;
		cleanupTransport.close = async () => {
			cleanupAttempts += 1;
			if (cleanupAttempts === 1) throw retryFailure;
			cleanupTransport.connected = false;
		};
		let opens = 0;
		const pool = new MCPConnectionPool({
			connect: async (name, cfg) => {
				opens += 1;
				if (opens === 1) {
					firstStarted.resolve();
					return firstFlight.promise;
				}
				return connection(name, cfg, new FakeTransport());
			},
		});
		const manager = new MCPManager(".", null, { pool, sessionId: "disconnect-cleanup" });
		const serverConfig = config();
		const controller = new AbortController();
		const operation = manager.withPreparedLease("server", serverConfig, async () => undefined, {
			signal: controller.signal,
		});
		await firstStarted.promise;
		controller.abort(new Error("abort before deferred cleanup failure"));
		await expect(operation).rejects.toBeInstanceOf(MCPPoolAcquireAbortError);
		expect(manager.pendingConnectionCleanupCountForTests).toBe(1);

		const disconnect = manager.disconnectServer("server");
		const fenced = await manager.connectServers({ server: serverConfig }, {});
		expect(fenced.errors.has("server")).toBe(true);
		expect(opens).toBe(1);
		const primaryFailure = new Error("late connection cleanup failed");
		firstFlight.reject(new MCPConnectionCleanupFailure(primaryFailure, cleanupTransport));
		const disconnectError = await disconnect.catch(error => error);
		expect(disconnectError).toBeInstanceOf(MCPConnectionCleanupFailure);
		if (!(disconnectError instanceof MCPConnectionCleanupFailure)) {
			throw new Error("Expected retained disconnect cleanup failure");
		}
		expect(disconnectError.cause).toBeInstanceOf(AggregateError);
		if (!(disconnectError.cause instanceof AggregateError)) throw new Error("Expected combined cleanup causes");
		expect(disconnectError.cause.errors).toEqual([primaryFailure, retryFailure]);
		expect(cleanupAttempts).toBe(1);
		expect(manager.pendingConnectionCleanupCountForTests).toBe(1);
		expect(pool.pendingAcquireCleanupCountForTests).toBe(1);

		await manager.disconnectServer("server");
		expect(cleanupAttempts).toBe(2);
		expect(manager.pendingConnectionCleanupCountForTests).toBe(0);
		expect(pool.pendingAcquireCleanupCountForTests).toBe(0);
		await manager.withPreparedLease("server", serverConfig, async lease => {
			expect(lease.serverName).toBe("server");
		});
		expect(opens).toBe(2);
		await manager.disconnectAll();
	});

	test("manager reconnect retries pool-owned cleanup before replacing the live connection", async () => {
		const transientFlight = Promise.withResolvers<MCPServerConnection>();
		const transientStarted = Promise.withResolvers<void>();
		const cleanupTransport = new FakeTransport();
		const cleanupRetryFailure = new Error("reconnect cleanup retry failed");
		let cleanupAttempts = 0;
		cleanupTransport.close = async () => {
			cleanupAttempts += 1;
			if (cleanupAttempts === 1) throw cleanupRetryFailure;
			cleanupTransport.connected = false;
		};
		let opens = 0;
		const transports: ToolListTransport[] = [];
		const pool = new MCPConnectionPool({
			connect: async (name, cfg) => {
				opens += 1;
				if (opens === 2) {
					transientStarted.resolve();
					return transientFlight.promise;
				}
				const transport = new ToolListTransport();
				transports.push(transport);
				return connection(name, cfg, transport);
			},
		});
		const manager = new MCPManager(".", null, { pool, sessionId: "reconnect-cleanup", sleep: async () => {} });
		const serverConfig = config();
		await manager.connectServers({ server: serverConfig }, {});
		const original = manager.getConnection("server");
		const controller = new AbortController();
		const transient = manager.withPreparedLease(
			"server",
			{ type: "stdio", command: "fake-mcp", args: ["--transient"] },
			async () => undefined,
			{ signal: controller.signal },
		);
		await transientStarted.promise;
		controller.abort(new Error("abort transient before reconnect"));
		await expect(transient).rejects.toBeInstanceOf(MCPPoolAcquireAbortError);

		const firstReconnect = manager.reconnectServer("server");
		transientFlight.reject(
			new MCPConnectionCleanupFailure(new Error("late reconnect cleanup failed"), cleanupTransport),
		);
		await expect(firstReconnect).rejects.toBeInstanceOf(MCPConnectionCleanupFailure);
		expect(cleanupAttempts).toBe(1);
		expect(opens).toBe(2);
		expect(manager.getConnection("server")).toBe(original);
		const replacement = await manager.reconnectServer("server");
		expect(cleanupAttempts).toBe(2);
		expect(opens).toBe(3);
		expect(replacement).toBeDefined();
		expect(replacement).not.toBe(original);
		expect(manager.pendingConnectionCleanupCountForTests).toBe(0);
		await manager.disconnectAll();
		expect(transports.every(transport => transport.closeCount === 1)).toBe(true);
	});

	test("shutdown aborts hanging opens, settles waiters, and closes late transports", async () => {
		let resolveOpen: ((value: MCPServerConnection) => void) | undefined;
		let openSignal: AbortSignal | undefined;
		const transport = new FakeTransport();
		const pool = new MCPConnectionPool({
			connect: async (_name, _cfg, options) => {
				openSignal = options.signal;
				return new Promise<MCPServerConnection>(resolve => {
					resolveOpen = resolve;
				});
			},
		});
		const acquire = pool.acquire("server", config(), { sessionId: "shutdown" });
		await Bun.sleep(0);
		const shutdown = pool.shutdown();
		await expect(acquire).rejects.toThrow("MCP connection pool shut down");
		expect(openSignal?.aborted).toBe(true);
		await shutdown;
		resolveOpen?.(connection("server", config(), transport));
		await Bun.sleep(0);
		expect(transport.closeCount).toBe(1);
	});

	test("transport close is recorded once and release does not close it again", async () => {
		const transport = new FakeTransport();
		const pool = new MCPConnectionPool({ connect: async (name, cfg) => connection(name, cfg, transport) });
		const lease = await pool.acquire("server", config(), { sessionId: "closed" });
		transport.onClose?.();
		await lease.release();
		expect(transport.closeCount).toBe(1);
		expect(pool.size).toBe(0);
	});

	test("forwards requests, notifications, roots and resource subscriptions through a lease", async () => {
		let transport: FakeTransport | undefined;
		const pool = new MCPConnectionPool({
			connect: async (name, cfg) => {
				transport = new FakeTransport();
				return connection(name, cfg, transport);
			},
		});
		const lease = await pool.acquire("server", config(), { sessionId: "one" });
		const events: string[] = [];
		lease.onEvent(event => {
			if (event.type === "notification") events.push(event.method);
		});
		lease.updateRoots([{ uri: "file:///workspace", name: "workspace" }]);
		await lease.setResourceSubscriptions(["file:///resource"]);
		await lease.request("ping");
		transport?.onNotification?.("notifications/tools/list_changed", {});
		expect(events).toEqual(["notifications/tools/list_changed"]);
		expect(await transport?.onRequest?.("roots/list", {})).toEqual({
			roots: [{ uri: "file:///workspace", name: "workspace" }],
		});
		await lease.release();
	});

	test("aborting one pending waiter leaves the other waiter interested", async () => {
		let resolveOpen: ((value: MCPServerConnection) => void) | undefined;
		const transport = new FakeTransport();
		const pool = new MCPConnectionPool({
			connect: async (_name, _cfg) =>
				new Promise<MCPServerConnection>(resolve => {
					resolveOpen = resolve;
				}),
		});
		const firstController = new AbortController();
		const secondController = new AbortController();
		const options = { sessionId: "waiters" };
		const first = pool.acquire("server", config(), { ...options, signal: firstController.signal });
		const second = pool.acquire("server", config(), { ...options, signal: secondController.signal });
		await Bun.sleep(0);
		firstController.abort(new Error("first waiter aborted"));
		await expect(first).rejects.toBeInstanceOf(MCPPoolAcquireAbortError);
		resolveOpen?.(connection("server", config(), transport));
		const lease = await second;
		expect(lease.connection.transport).toBe(transport);
		await lease.release();
		expect(transport.closeCount).toBe(1);
		await pool.shutdown();
	});

	test("aborting the later pending waiter leaves the first waiter interested", async () => {
		let resolveOpen: ((value: MCPServerConnection) => void) | undefined;
		const transport = new FakeTransport();
		const pool = new MCPConnectionPool({
			connect: async (_name, _cfg) =>
				new Promise<MCPServerConnection>(resolve => {
					resolveOpen = resolve;
				}),
		});
		const firstController = new AbortController();
		const secondController = new AbortController();
		const options = { sessionId: "waiters-later" };
		const first = pool.acquire("server", config(), { ...options, signal: firstController.signal });
		const second = pool.acquire("server", config(), { ...options, signal: secondController.signal });
		await Bun.sleep(0);
		secondController.abort(new Error("second waiter aborted"));
		await expect(second).rejects.toBeInstanceOf(MCPPoolAcquireAbortError);
		resolveOpen?.(connection("server", config(), transport));
		const lease = await first;
		expect(lease.connection.transport).toBe(transport);
		await lease.release();
		expect(transport.closeCount).toBe(1);
		await pool.shutdown();
	});

	test("shutdown invalidates all leases before closing their transport", async () => {
		const transport = new FakeTransport();
		const pool = new MCPConnectionPool({ connect: async (name, cfg) => connection(name, cfg, transport) });
		const lease = await pool.acquire("server", config(), { sessionId: "invalidated" });
		await pool.shutdown();
		expect(() => lease.request("ping")).toThrow(MCPPoolLeaseInvalidatedError);
		expect(() => lease.notify("notifications/test")).toThrow(MCPPoolLeaseInvalidatedError);
		expect(() => lease.updateRoots([])).toThrow(MCPPoolLeaseInvalidatedError);
		await expect(lease.setResourceSubscriptions(["file:///resource"])).rejects.toBeInstanceOf(
			MCPPoolLeaseInvalidatedError,
		);
		expect(transport.requests).toEqual([]);
	});

	test("failed subscription accounting can retry and failed unsubscription remains retryable", async () => {
		const transport = new FakeTransport();
		const pool = new MCPConnectionPool({ connect: async (name, cfg) => connection(name, cfg, transport) });
		const lease = await pool.acquire("server", config(), { sessionId: "subscription-failures" });
		transport.failSubscribe = true;
		await expect(lease.setResourceSubscriptions(["file:///resource"])).rejects.toBeInstanceOf(AggregateError);
		transport.failSubscribe = false;
		await lease.setResourceSubscriptions(["file:///resource"]);
		expect(transport.requests.filter(method => method === "resources/subscribe")).toHaveLength(2);
		transport.failUnsubscribe = true;
		await expect(lease.setResourceSubscriptions([])).rejects.toBeInstanceOf(AggregateError);
		transport.failUnsubscribe = false;
		await lease.setResourceSubscriptions([]);
		expect(transport.requests.filter(method => method === "resources/unsubscribe")).toHaveLength(2);
		await lease.release();
		await pool.shutdown();
	});

	test("resolve-then-abort-all closes a zero-claim handoff entry", async () => {
		let resolveOpen: ((value: MCPServerConnection) => void) | undefined;
		const transport = new FakeTransport();
		const pool = new MCPConnectionPool({
			connect: async () =>
				new Promise<MCPServerConnection>(resolve => {
					resolveOpen = resolve;
				}),
		});
		const firstController = new AbortController();
		const secondController = new AbortController();
		const first = pool.acquire("server", config(), { sessionId: "handoff", signal: firstController.signal });
		const second = pool.acquire("server", config(), { sessionId: "handoff", signal: secondController.signal });
		first.catch(() => {});
		second.catch(() => {});
		await Bun.sleep(0);
		resolveOpen?.(connection("server", config(), transport));
		firstController.abort(new Error("first aborted at handoff"));
		secondController.abort(new Error("second aborted at handoff"));
		await expect(first).rejects.toBeInstanceOf(MCPPoolAcquireAbortError);
		await expect(second).rejects.toBeInstanceOf(MCPPoolAcquireAbortError);
		await Bun.sleep(0);
		await Bun.sleep(0);
		expect(transport.closeCount).toBe(1);
		expect(pool.size).toBe(0);
		await pool.shutdown();
	});

	test("onEvent rejects after pool shutdown invalidates the lease", async () => {
		const transport = new FakeTransport();
		const pool = new MCPConnectionPool({ connect: async (name, cfg) => connection(name, cfg, transport) });
		const lease = await pool.acquire("server", config(), { sessionId: "event-invalidated" });
		await pool.shutdown();
		expect(() => lease.onEvent(() => {})).toThrow(MCPPoolLeaseInvalidatedError);
	});

	test("shutdown invalidates leases whose transport already removed the pool entry", async () => {
		const transport = new FakeTransport();
		const pool = new MCPConnectionPool({ connect: async (name, cfg) => connection(name, cfg, transport) });
		const lease = await pool.acquire("server", config(), { sessionId: "removed-entry" });
		transport.onClose?.();
		await pool.shutdown();
		expect(() => lease.onEvent(() => {})).toThrow(MCPPoolLeaseInvalidatedError);
	});

	test("mixed subscription batch compensates partial success before retry", async () => {
		const transport = new FakeTransport();
		const pool = new MCPConnectionPool({ connect: async (name, cfg) => connection(name, cfg, transport) });
		const lease = await pool.acquire("server", config(), { sessionId: "mixed-subscriptions" });
		await lease.setResourceSubscriptions(["file:///old"]);
		transport.failSubscribeUri = "file:///new";
		await expect(lease.setResourceSubscriptions(["file:///new"])).rejects.toBeInstanceOf(AggregateError);
		transport.failSubscribeUri = undefined;
		await lease.setResourceSubscriptions(["file:///new"]);
		expect(transport.requests.filter(method => method === "resources/subscribe")).toHaveLength(4);
		expect(transport.requests.filter(method => method === "resources/unsubscribe")).toHaveLength(2);
		await lease.release();
	});

	test("failed final release keeps subscriptions retryable", async () => {
		const transport = new FakeTransport();
		const pool = new MCPConnectionPool({ connect: async (name, cfg) => connection(name, cfg, transport) });
		const lease = await pool.acquire("server", config(), { sessionId: "release-retry" });
		await lease.setResourceSubscriptions(["file:///old"]);
		transport.failUnsubscribe = true;
		await expect(lease.release()).rejects.toBeInstanceOf(AggregateError);
		transport.failUnsubscribe = false;
		await lease.release();
		expect(transport.requests.filter(method => method === "resources/unsubscribe")).toHaveLength(2);
		expect(pool.size).toBe(0);
		await pool.shutdown();
	});

	test("health output is bounded and redacted", async () => {
		let transport: FakeTransport | undefined;
		const pool = new MCPConnectionPool({
			connect: async (name, cfg) => {
				transport = new FakeTransport();
				return connection(name, cfg, transport);
			},
		});
		const lease = await pool
			.acquire("secret-server", { type: "http", url: "https://user:secret@example.test/mcp" }, { sessionId: "s" })
			.catch(() => undefined);
		if (lease) await lease.release();
		// Userinfo rejection happens before opening; use a valid endpoint for event health.
		const validLease = await pool.acquire(
			"secret-server",
			{ type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer top-secret" } },
			{ sessionId: "s" },
		);
		for (let index = 0; index < 30; index += 1)
			transport?.onError?.(new Error(`https://example.test/mcp?token=top-secret ${"x".repeat(600)}`));
		const health = pool.getHealth()[0];
		expect(health?.events.length).toBeLessThanOrEqual(20);
		expect(JSON.stringify(health)).not.toContain("top-secret");
		expect(health?.events.every(event => !event.message || event.message.length <= 512)).toBe(true);
		await validLease.release();
	});
});

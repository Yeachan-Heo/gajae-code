/**
 * Runtime building blocks for session-scoped MCP controls:
 * - `loadAllMCPConfigs({ includeDisabled })` reports native declarations that the
 *   startup gates refuse, so a session can show them as disabled.
 * - `MCPManager.connectSessionServer()` connects (or restarts) exactly one server and
 *   rolls back on failure instead of falling back to cached tools.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceMeta } from "../../src/capability/types";
import { loadAllMCPConfigs } from "../../src/runtime-mcp/config";
import { MCPManager, type MCPManagerOptions } from "../../src/runtime-mcp/manager";
import { MCPConnectionPool, type MCPPoolLease } from "../../src/runtime-mcp/pool";
import type { MCPToolCache } from "../../src/runtime-mcp/tool-cache";
import type { MCPServerConfig } from "../../src/runtime-mcp/types";

const fakeServer = join(import.meta.dir, "fixtures", "session-mcp-fake-server.ts");
const source: SourceMeta = { provider: "test", providerName: "Test", path: "/test/mcp.json", level: "user" };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function makeDir(): { base: string; log: string; flag: string } {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "gjc-session-mcp-")));
	const log = join(base, "spawn.log");
	writeFileSync(log, "");
	cleanups.push(() => rmSync(base, { recursive: true, force: true }));
	return { base, log, flag: join(base, "fail.flag") };
}

function fakeConfig(log: string, name: string, args: string[] = [], timeout?: number): MCPServerConfig {
	return {
		command: process.execPath,
		args: [fakeServer, "--name", name, "--log", log, ...args],
		...(timeout === undefined ? {} : { timeout }),
	};
}

function spawnCount(log: string, name: string): number {
	return readFileSync(log, "utf8")
		.split("\n")
		.filter(line => line.startsWith(`spawn ${name} `)).length;
}

function newManager(base: string, cache: MCPToolCache | null = null, options: MCPManagerOptions = {}): MCPManager {
	const manager = new MCPManager(base, cache, options);
	cleanups.push(() => manager.disconnectAll());
	return manager;
}

function toolsOf(manager: MCPManager, name: string): string[] {
	return manager
		.getTools()
		.filter(tool => tool.mcpServerName === name)
		.map(tool => tool.name);
}

describe("loadAllMCPConfigs includeDisabled", () => {
	test("reports declarations refused by enabled:false and disabledServers", async () => {
		const { base } = makeDir();
		const agentDir = join(base, "agent");
		const cwd = join(base, "proj");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".gjc"), { recursive: true });
		const server = { command: process.execPath, args: [fakeServer] };
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					on: server,
					off: { ...server, autoload: false },
					dis: { ...server, enabled: false, autoload: false },
					deny: server,
				},
				disabledServers: ["deny"],
			}),
		);
		const options = { agentDir, autoloadOnly: false, nativeOnly: true };

		const withDisabled = await loadAllMCPConfigs(cwd, { ...options, includeDisabled: true });
		expect(Object.keys(withDisabled.configs).sort()).toEqual(["off", "on"]);
		expect(withDisabled.disabled?.dis).toMatchObject({ reason: "enabled-false", autoload: false });
		expect(withDisabled.disabled?.deny).toMatchObject({ reason: "disabled-servers", autoload: true });
		expect(withDisabled.disabled?.deny?.source.level).toBe("user");

		// Without the opt-in the result shape is unchanged.
		const plain = await loadAllMCPConfigs(cwd, options);
		expect(Object.keys(plain.configs).sort()).toEqual(["off", "on"]);
		expect(plain.disabled).toBeUndefined();

		// Exact-config loading never reports native declarations.
		const exact = join(base, "exact.json");
		writeFileSync(exact, JSON.stringify({ mcpServers: { dis: { ...server, enabled: false } } }));
		const exactResult = await loadAllMCPConfigs(cwd, { configPath: exact, includeDisabled: true });
		expect(exactResult.disabled).toBeUndefined();
	});
});

describe("MCPManager.connectSessionServer", () => {
	test("connects one server and returns the live connection when already connected", async () => {
		const { base, log } = makeDir();
		const manager = newManager(base);
		await manager.connectSessionServer("one", fakeConfig(log, "one"), source);
		expect(manager.getConnectionStatus("one")).toBe("connected");
		expect(toolsOf(manager, "one")).toHaveLength(1);
		expect(manager.getSource("one")).toEqual(source);

		await manager.connectSessionServer("one", fakeConfig(log, "one"), source);
		expect(spawnCount(log, "one")).toBe(1);
	}, 20_000);

	test("restart replaces the process and keeps the server's tools", async () => {
		const { base, log } = makeDir();
		const manager = newManager(base);
		await manager.connectSessionServer("one", fakeConfig(log, "one"), source);
		const before = toolsOf(manager, "one");

		await manager.connectSessionServer("one", fakeConfig(log, "one"), source, { restart: true });
		expect(spawnCount(log, "one")).toBe(2);
		expect(manager.getConnectionStatus("one")).toBe("connected");
		expect(toolsOf(manager, "one")).toEqual(before);
	}, 20_000);

	test("restart retires a held scoped operation before reporting the replacement", async () => {
		const { base, log } = makeDir();
		const manager = newManager(base);
		const config = fakeConfig(log, "scoped");
		const previous = await manager.connectSessionServer("scoped", config, source);
		const entered = Promise.withResolvers<MCPPoolLease>();
		const release = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<void>();
		const scoped = manager.withPreparedLease("scoped", config, async lease => {
			entered.resolve(lease);
			try {
				await release.promise;
				return "late scoped completion";
			} finally {
				finished.resolve();
			}
		});
		const outcome = scoped.then(
			value => ({ status: "fulfilled", value }),
			(error: unknown) => ({ status: "rejected", error }),
		);
		try {
			const lease = await entered.promise;
			expect(lease.connection).toBe(previous);
			const replacement = await manager.connectSessionServer("scoped", config, source, { restart: true });
			expect(lease.connectionForLease().transport.connected).toBe(false);
			expect(replacement).not.toBe(previous);
			expect(spawnCount(log, "scoped")).toBe(2);
			expect(await outcome).toMatchObject({
				status: "rejected",
				error: { message: "MCP server reconnecting: scoped" },
			});
		} finally {
			release.resolve();
			await finished.promise;
			await outcome;
		}
	}, 20_000);

	test("restart rejects uncertain scoped cleanup and retains the previous connection", async () => {
		const { base, log } = makeDir();
		const manager = newManager(base);
		const config = fakeConfig(log, "cleanup");
		const previous = await manager.connectSessionServer("cleanup", config, source);
		const entered = Promise.withResolvers<MCPPoolLease>();
		const release = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<void>();
		const scoped = manager.withPreparedLease("cleanup", config, async lease => {
			entered.resolve(lease);
			try {
				await release.promise;
			} finally {
				finished.resolve();
			}
		});
		const outcome = Promise.allSettled([scoped]);
		const lease = await entered.promise;
		const releaseLease = lease.release.bind(lease);
		const failure = vi.spyOn(lease, "release").mockRejectedValue(new Error("SCOPED_RELEASE_FAILURE"));
		try {
			await expect(manager.connectSessionServer("cleanup", config, source, { restart: true })).rejects.toMatchObject(
				{
					code: "unknown_effect",
				},
			);
			expect(manager.getConnection("cleanup")).toBe(previous);
			expect(spawnCount(log, "cleanup")).toBe(1);
			expect(manager.getServerControlSnapshot()[0]).toMatchObject({ state: "unknown", controls: [] });
			expect((await outcome)[0]).toMatchObject({ status: "rejected" });
		} finally {
			release.resolve();
			await finished.promise;
			await outcome;
			failure.mockRestore();
			await releaseLease();
		}
	}, 20_000);

	test("restart retires the pooled generation even when another lease retains the old transport", async () => {
		const { base, log } = makeDir();
		const pool = new MCPConnectionPool();
		const sessionId = "session-connect-held-lease";
		const manager = newManager(base, null, { pool, sessionId });
		const config = fakeConfig(log, "retained");
		const previous = await manager.connectSessionServer("retained", config, source);
		const retained = await pool.acquire("retained", config, {
			keyConfig: config,
			sharingMode: "per-session",
			sessionId,
			advertiseRoots: true,
			effectiveCwd: base,
			capabilityProfile: "roots",
		});
		try {
			expect(retained.connection).toBe(previous);
			const replacement = await manager.connectSessionServer("retained", config, source, { restart: true });
			expect(replacement).not.toBe(previous);
			expect(spawnCount(log, "retained")).toBe(2);
			expect(manager.getConnection("retained")).toBe(replacement);
		} finally {
			await retained.release();
		}
	}, 20_000);

	test("publishes a control target while a first connection is held before registration", async () => {
		const { base, log } = makeDir();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const manager = newManager(base, null, {
			afterLeaseAcquiredForTests: async () => {
				entered.resolve();
				await release.promise;
			},
		});
		const pending = manager.connectSessionServer("pending", fakeConfig(log, "pending"), source);
		void pending.catch(() => {});
		let initialGeneration: number | undefined;
		try {
			await entered.promise;
			const rows = manager.getServerControlSnapshot();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ target: { name: "pending" }, state: "connecting", controls: [] });
			initialGeneration = rows[0]!.target.generation;
			await expect(manager.controlServer(rows[0]!.target, "reconnect")).rejects.toMatchObject({ code: "busy" });
			await expect(
				manager.connectSessionServer("pending", fakeConfig(log, "pending"), source),
			).rejects.toMatchObject({ code: "busy" });
		} finally {
			release.resolve();
			await pending;
		}
		expect(manager.getServerControlSnapshot()[0]!.target.generation).toBeGreaterThan(initialGeneration!);
	}, 20_000);

	test("a failed first connect leaves no server state behind", async () => {
		const { base, log } = makeDir();
		const manager = newManager(base);
		await expect(manager.connectSessionServer("bad", fakeConfig(log, "bad", ["--fail"]), source)).rejects.toThrow();
		expect(manager.getConnectionStatus("bad")).toBe("disconnected");
		expect(manager.getAllServerNames()).not.toContain("bad");
		expect(toolsOf(manager, "bad")).toEqual([]);
	}, 20_000);

	test("a failed restart keeps the previous tools listed", async () => {
		const { base, log, flag } = makeDir();
		const manager = newManager(base);
		const config = fakeConfig(log, "flaky", ["--fail-if-exists", flag]);
		await manager.connectSessionServer("flaky", config, source);
		const before = toolsOf(manager, "flaky");

		writeFileSync(flag, "");
		await expect(manager.connectSessionServer("flaky", config, source, { restart: true })).rejects.toThrow();
		expect(manager.getConnectionStatus("flaky")).toBe("disconnected");
		expect(toolsOf(manager, "flaky")).toEqual(before);
	}, 20_000);

	test("does not fall back to cached tools when the server fails", async () => {
		const { base, log } = makeDir();
		const cache = {
			get: vi.fn(async () => [{ name: "echo", inputSchema: { type: "object" } }]),
			set: vi.fn(async () => {}),
		} as unknown as MCPToolCache;
		const manager = newManager(base, cache);
		await expect(manager.connectSessionServer("bad", fakeConfig(log, "bad", ["--fail"]), source)).rejects.toThrow();
		expect(cache.get).not.toHaveBeenCalled();
		expect(toolsOf(manager, "bad")).toEqual([]);
	}, 20_000);

	test("a server slower than its declared timeout is rejected and cleaned up", async () => {
		const { base, log } = makeDir();
		const manager = newManager(base);
		const startedAt = Date.now();
		await expect(
			manager.connectSessionServer("slow", fakeConfig(log, "slow", ["--delay-init", "10000"], 300), source),
		).rejects.toThrow();
		expect(Date.now() - startedAt).toBeLessThan(8_000);
		expect(manager.getConnectionStatus("slow")).toBe("disconnected");
		expect(toolsOf(manager, "slow")).toEqual([]);
	}, 20_000);

	test("rejects invalid configs and frozen connection sets without spawning", async () => {
		const { base, log } = makeDir();
		const manager = newManager(base);
		await expect(manager.connectSessionServer("empty", {} as MCPServerConfig, source)).rejects.toThrow();

		manager.freezeConnectionSet();
		await expect(manager.connectSessionServer("one", fakeConfig(log, "one"), source)).rejects.toThrow();
		expect(spawnCount(log, "one")).toBe(0);
	}, 20_000);
});

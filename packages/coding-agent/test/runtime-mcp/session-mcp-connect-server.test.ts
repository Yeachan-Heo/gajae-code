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
import { logger } from "@gajae-code/utils";
import type { SourceMeta } from "../../src/capability/types";
import { loadAllMCPConfigs } from "../../src/runtime-mcp/config";
import { MCPManager } from "../../src/runtime-mcp/manager";
import type { MCPToolCache } from "../../src/runtime-mcp/tool-cache";
import type { MCPServerConfig } from "../../src/runtime-mcp/types";

const fakeServer = join(import.meta.dir, "fixtures", "session-mcp-fake-server.ts");
const source: SourceMeta = { provider: "test", providerName: "Test", path: "/test/mcp.json", level: "user" };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) {
		try {
			await cleanup();
		} catch {
			/* best effort */
		}
	}
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

function newManager(base: string, cache: MCPToolCache | null = null): MCPManager {
	const manager = new MCPManager(base, cache);
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

	test("a server never replaces another server's tool under the same normalized name", async () => {
		const { base, log, flag } = makeDir();
		const warn = vi.spyOn(logger, "warn");
		cleanups.push(() => warn.mockRestore());
		const manager = newManager(base);
		await manager.connectSessionServer("foo-bar", fakeConfig(log, "foo-bar", ["--tools", "grown"]), source);
		const [owned] = toolsOf(manager, "foo-bar");
		const ownerOf = (toolName: string | undefined) =>
			manager
				.getTools()
				.filter(tool => tool.name === toolName)
				.map(tool => tool.mcpServerName);

		// Joining with a colliding tool: the new server's copy is skipped.
		await manager.connectSessionServer("Foo-Bar", fakeConfig(log, "Foo-Bar", ["--tools", "grown"]), source);
		expect(toolsOf(manager, "Foo-Bar")).toEqual([]);
		expect(ownerOf(owned)).toEqual(["foo-bar"]);

		// A later tools/list_changed refresh cannot take the name over either.
		const growing = fakeConfig(log, "foo.bar", ["--tools", "other", "--grow-on", flag]);
		await manager.connectSessionServer("foo.bar", growing, source);
		const before = toolsOf(manager, "foo.bar");
		expect(before).toHaveLength(1);
		writeFileSync(flag, "");
		const deadline = Date.now() + 5000;
		const skipped = () =>
			warn.mock.calls.some(
				([message, context]) =>
					String(message).includes("already published by another server") &&
					(context as { path?: string } | undefined)?.path === "mcp:foo.bar",
			);
		while (Date.now() < deadline && !skipped()) await Bun.sleep(50);
		expect(skipped()).toBe(true);
		expect(toolsOf(manager, "foo.bar")).toEqual(before);
		expect(ownerOf(owned)).toEqual(["foo-bar"]);

		const tool = manager.getTools().find(item => item.name === owned);
		const result = await tool?.execute("collision-call", {}, undefined, {} as never);
		expect(JSON.stringify(result?.content)).toContain("foo-bar ok");
	}, 20_000);

	test("a held tool is published once the owning server disconnects", async () => {
		const { base, log } = makeDir();
		const manager = newManager(base);
		await manager.connectSessionServer("foo-bar", fakeConfig(log, "foo-bar", ["--tools", "grown"]), source);
		const [name] = toolsOf(manager, "foo-bar");
		await manager.connectSessionServer("foo.bar", fakeConfig(log, "foo.bar", ["--tools", "grown"]), source);
		expect(toolsOf(manager, "foo.bar")).toEqual([]);

		await manager.disconnectServer("foo-bar");
		expect(toolsOf(manager, "foo.bar")).toEqual([name]);
		const result = await manager
			.getTools()
			.find(tool => tool.name === name)
			?.execute("promoted-call", {}, undefined, {} as never);
		expect(JSON.stringify(result?.content)).toContain("foo.bar ok");

		// A disconnected server's held tools are dropped and never promoted later.
		await manager.connectSessionServer("foo-bar", fakeConfig(log, "foo-bar", ["--tools", "grown"]), source);
		expect(toolsOf(manager, "foo-bar")).toEqual([]);
		await manager.disconnectServer("foo-bar");
		await manager.disconnectServer("foo.bar");
		expect(manager.getTools()).toEqual([]);
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

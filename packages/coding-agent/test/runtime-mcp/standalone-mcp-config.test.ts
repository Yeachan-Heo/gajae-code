import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { logger } from "@gajae-code/utils";
import * as discovery from "../../src/discovery";
import type { CapabilityResult } from "../../src/capability/types";
import { loadAllMCPConfigs } from "../../src/runtime-mcp/config";
import * as configWriter from "../../src/runtime-mcp/config-writer";
import { MCPManager } from "../../src/runtime-mcp/manager";
import type { JsonRpcMessage, MCPServerConfig } from "../../src/runtime-mcp/types";
import type { MCPServer } from "../../src/discovery";

const source = {
	provider: "native",
	providerName: "Native",
	path: "mcp:test",
	level: "user" as const,
};

function capabilityResult(items: Array<MCPServer & { _source: typeof source }>): CapabilityResult<MCPServer> {
	return { items, all: items, warnings: [], providers: ["native"] };
}

beforeEach(() => {
	spyOn(configWriter, "readDisabledServers").mockResolvedValue([]);
});

afterEach(() => {
	mock.restore();
});

describe("standalone MCP runtime config options", () => {
	it("threads provider allow-lists into capability loading", async () => {
		const loadSpy = spyOn(discovery, "loadCapability").mockResolvedValue(capabilityResult([]));

		await loadAllMCPConfigs(process.cwd(), { providers: ["native", "mcp-json"] });

		expect(loadSpy).toHaveBeenCalledTimes(1);
		expect(loadSpy.mock.calls[0]?.[1]).toEqual({ cwd: process.cwd(), providers: ["native", "mcp-json"] });
	});

	it("caps eligible servers deterministically and logs only sanitized skipped names", async () => {
		const items: Array<MCPServer & { _source: typeof source }> = ["zeta", "alpha", "middle"].map(name => ({
			name,
			command: "node",
			env: { SECRET_TOKEN: `secret-${name}` },
			_source: source,
		}));
		spyOn(discovery, "loadCapability").mockResolvedValue(capabilityResult(items));
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => undefined);

		const result = await loadAllMCPConfigs(process.cwd(), { maxServers: 2 });

		expect(Object.keys(result.configs)).toEqual(["alpha", "middle"]);
		expect(Object.keys(result.sources)).toEqual(["alpha", "middle"]);
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0]?.[0]).toBe("Standalone MCP server cap exceeded");
		expect(warnSpy.mock.calls[0]?.[1]).toEqual({ kept: 2, dropped: 1, skipped: ["mcp:zeta"] });
		expect(JSON.stringify(warnSpy.mock.calls[0])).not.toContain("secret-");
	});

	it("forces noInheritEnv only for stdio configs and preserves explicit env", async () => {
		spyOn(discovery, "loadCapability").mockResolvedValue(
			capabilityResult([
				{ name: "stdio", command: "node", env: { KEEP: "yes" }, _source: source },
				{ name: "http", transport: "http", url: "http://example.test/mcp", _source: source },
				{ name: "sse", transport: "sse", url: "http://example.test/sse", _source: source },
			]),
		);

		const result = await loadAllMCPConfigs(process.cwd(), { forceNoInheritEnvForStdio: true });

		expect(result.configs.stdio).toMatchObject({ type: "stdio", noInheritEnv: true, env: { KEEP: "yes" } });
		expect(result.configs.http).not.toHaveProperty("noInheritEnv");
		expect(result.configs.sse).not.toHaveProperty("noInheritEnv");
	});
});

describe("standalone MCP connection concurrency", () => {
	it("never exceeds maxConcurrentConnects while connecting servers", async () => {
		let activeInitializations = 0;
		let peakInitializations = 0;
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method !== "POST") {
					return new Response(null, { status: 405 });
				}
				let body: JsonRpcMessage;
				try {
					body = (await req.json()) as JsonRpcMessage;
				} catch {
					return new Response(null, { status: 400 });
				}
				const id = "id" in body ? body.id : 0;
				if ("method" in body && body.method === "initialize") {
					activeInitializations += 1;
					peakInitializations = Math.max(peakInitializations, activeInitializations);
					await Bun.sleep(50);
					activeInitializations -= 1;
					return Response.json({
						jsonrpc: "2.0",
						id,
						result: {
							protocolVersion: "2025-03-26",
							capabilities: { tools: {} },
							serverInfo: { name: "test", version: "1" },
						},
					});
				}
				if ("method" in body && body.method === "tools/list") {
					return Response.json({ jsonrpc: "2.0", id, result: { tools: [] } });
				}
				return Response.json({ jsonrpc: "2.0", id, result: {} });
			},
		});
		try {
			const manager = new MCPManager(process.cwd());
			const configs: Record<string, MCPServerConfig> = Object.fromEntries(
				Array.from({ length: 5 }, (_, index) => [`server-${index}`, { type: "http" as const, url: server.url.href, timeout: 1_000 }]),
			);

			const result = await manager.connectServers(configs, {}, undefined, 2);

			expect(result.errors.size).toBe(0);
			expect(result.connectedServers.sort()).toEqual(["server-0", "server-1", "server-2", "server-3", "server-4"]);
			expect(peakInitializations).toBeLessThanOrEqual(2);
			await manager.disconnectAll();
		} finally {
			await server.stop(true);
		}
	});
});

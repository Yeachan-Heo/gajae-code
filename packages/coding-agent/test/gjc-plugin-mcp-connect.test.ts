import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildPluginMcpConfigs, installGjcPluginBundle } from "../src/extensibility/gjc-plugins";
import { MCPManager } from "../src/runtime-mcp";

const fixturesRoot = path.join(import.meta.dir, "fixtures", "gjc-plugins");
const mcpBundle = path.join(fixturesRoot, "valid-mcp-bundle");
const tempDirs: string[] = [];
const managers: MCPManager[] = [];

afterEach(async () => {
	for (const m of managers.splice(0)) await m.disconnectAll().catch(() => {});
	for (const d of tempDirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe("plugin MCP live connection", () => {
	test("installs and connects a bundled stdio MCP server, exposing its tools", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-connect-"));
		tempDirs.push(cwd);
		await installGjcPluginBundle(mcpBundle, { scope: "project", cwd });

		const { configs } = await buildPluginMcpConfigs({ cwd });
		expect(Object.keys(configs)).toEqual(["domain_docs"]);

		const manager = new MCPManager(cwd);
		managers.push(manager);
		const sources = {
			domain_docs: { provider: "gjc-plugins", providerName: "GJC plugin bundle", level: "project" as const },
		};
		const result = await manager.connectServers(configs, sources as never);

		expect(result.errors.size).toBe(0);
		// The bundled server advertises a "lookup" tool; MCP tools are namespaced.
		expect(result.tools.some(t => t.name.includes("lookup"))).toBe(true);
	}, 30_000);

	test("plugin stdio configs request no-env isolation and the child cannot read host secrets", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-noenv-"));
		tempDirs.push(cwd);
		await installGjcPluginBundle(mcpBundle, { scope: "project", cwd });

		const { configs } = await buildPluginMcpConfigs({ cwd });
		// Adapter boundary: stdio plugin MCP must opt out of host env inheritance
		// and must not forward an env map.
		expect(configs.domain_docs.noInheritEnv).toBe(true);
		expect(configs.domain_docs.env).toBeUndefined();

		const secretKey = "GJC_PLUGIN_TEST_SECRET";
		process.env[secretKey] = "top-secret-value";
		try {
			const manager = new MCPManager(cwd);
			managers.push(manager);
			const sources = {
				domain_docs: { provider: "gjc-plugins", providerName: "GJC plugin bundle", level: "project" as const },
			};
			const result = await manager.connectServers(configs, sources as never);
			expect(result.errors.size).toBe(0);
			const tool = result.tools.find(t => t.name.includes("lookup"));
			expect(tool).toBeDefined();

			// The server echoes whether it observed the host secret. With no-env
			// isolation it must report the secret as absent.
			const res = await tool?.execute("tc-noenv", {}, undefined, {} as never, undefined);
			const text = (res?.content ?? []).map(c => (c.type === "text" ? c.text : "")).join("");
			expect(text).toContain("secret=<absent>");
			expect(text).not.toContain("top-secret-value");
		} finally {
			delete process.env[secretKey];
		}
	}, 30_000);
});

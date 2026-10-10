/**
 * Project MCP files are untrusted repo content. They must not copy secret-named
 * host environment into server env/headers, and they must not run `!` shell
 * substitutions. User mcp.json and an explicit --mcp-config file keep both.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getMCPConfigPath, getProjectDir, setAgentDir, setProjectDir } from "@gajae-code/utils";
import { clearConfigValueCache } from "../../src/config/resolve-config-value";
import { MCPCommandController } from "../../src/modes/controllers/runtime-mcp-command-controller";
import { loadAllMCPConfigs } from "../../src/runtime-mcp/config";
import { MCPManager } from "../../src/runtime-mcp/manager";
import type { MCPServerConfig } from "../../src/runtime-mcp/types";

const SECRET_NAME = "GJC_CANARY_SECRET";
const PUBLIC_NAME = "GJC_CANARY_PUBLIC";
const OTHER_NAME = "GJC_OTHER_SECRET";
const SECRET = "canary-secret-value";
const PUBLIC = "canary-public-value";
const OTHER = "canary-other-secret";
const SECRET_REF = `\${${SECRET_NAME}}`;
const PUBLIC_REF = `\${${PUBLIC_NAME}}`;
const DEFAULT_REF = `\${${SECRET_NAME}:-fallback-2102}`;

const originalAgentDir = getAgentDir();

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return true;
		await Bun.sleep(20);
	}
	return check();
}

function httpHeaders(config: MCPServerConfig | undefined): Record<string, string> {
	if (!config || (config.type !== "http" && config.type !== "sse")) {
		throw new Error(`expected an http MCP config, got ${config?.type ?? "missing"}`);
	}
	return config.headers ?? {};
}

function stdioEnv(config: MCPServerConfig | undefined): Record<string, string> {
	if (!config || config.type === "http" || config.type === "sse") {
		throw new Error(`expected a stdio MCP config, got ${config?.type ?? "missing"}`);
	}
	return config.env ?? {};
}

describe("project MCP host values", () => {
	let projectDir: string;
	let tempHome: string;
	let agentDir: string;
	let restoreEnv: Array<() => void>;

	beforeEach(async () => {
		MCPManager.resetForTests();
		clearConfigValueCache();
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-host-project-"));
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-host-home-"));
		agentDir = path.join(tempHome, ".gjc", "agent");
		await fs.mkdir(agentDir, { recursive: true });
		setAgentDir(agentDir);
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		restoreEnv = [SECRET_NAME, PUBLIC_NAME, OTHER_NAME].map(name => {
			const previous = process.env[name];
			return () => {
				if (previous === undefined) delete process.env[name];
				else process.env[name] = previous;
			};
		});
		process.env[SECRET_NAME] = SECRET;
		process.env[PUBLIC_NAME] = PUBLIC;
		process.env[OTHER_NAME] = OTHER;
	});

	afterEach(async () => {
		for (const restore of restoreEnv ?? []) restore();
		vi.restoreAllMocks();
		clearConfigValueCache();
		setAgentDir(originalAgentDir);
		await fs.rm(projectDir, { recursive: true, force: true });
		await fs.rm(tempHome, { recursive: true, force: true });
	});

	async function writeJson(relOrAbs: string, content: unknown, root = projectDir): Promise<string> {
		const filePath = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(root, relOrAbs);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, JSON.stringify(content));
		return filePath;
	}

	it("does not copy secret env names from project .gjc/mcp.json and still expands ordinary names", async () => {
		await writeJson(".gjc/mcp.json", {
			mcpServers: {
				project: {
					type: "http",
					url: "http://127.0.0.1:9/project",
					headers: {
						"X-Api-Secret": SECRET_REF,
						"X-Public": PUBLIC_REF,
						"X-Default": DEFAULT_REF,
						"X-Bare": SECRET_NAME,
					},
					env: { EXPLICIT_LEAK: SECRET_REF },
					timeout: 1000,
				},
			},
		});
		await writeJson(path.join(agentDir, "mcp.json"), {
			mcpServers: {
				user: {
					type: "http",
					url: "http://127.0.0.1:9/user",
					headers: { "X-Api-Secret": SECRET_REF },
					timeout: 1000,
				},
			},
		});

		const loaded = await loadAllMCPConfigs(projectDir, {
			agentDir,
			filterExa: false,
			nativeOnly: true,
			autoloadOnly: true,
		});

		const projectHeaders = httpHeaders(loaded.configs.project);
		expect(loaded.sources.project?.provider).toBe("native");
		expect(loaded.sources.project?.level).toBe("project");
		expect(projectHeaders["X-Api-Secret"]).toBe(SECRET_REF);
		expect(projectHeaders["X-Api-Secret"]).not.toBe(SECRET);
		expect(projectHeaders["X-Public"]).toBe(PUBLIC);
		expect(projectHeaders["X-Default"]).toBe("fallback-2102");
		expect(projectHeaders["X-Bare"]).toBe(SECRET_NAME);
		expect(httpHeaders(loaded.configs.user)["X-Api-Secret"]).toBe(SECRET);
	});

	it("does not copy secret env names from a repo-root mcp.json", async () => {
		await writeJson("mcp.json", {
			mcpServers: {
				root: {
					type: "http",
					url: "http://127.0.0.1:9/root",
					headers: { "X-Api-Secret": SECRET_REF, "X-Public": PUBLIC_REF },
					timeout: 1000,
				},
			},
		});

		const loaded = await loadAllMCPConfigs(projectDir, {
			agentDir,
			filterExa: false,
			autoloadOnly: true,
		});

		expect(loaded.sources.root?.provider).toBe("mcp-json");
		expect(loaded.sources.root?.level).toBe("project");
		expect(httpHeaders(loaded.configs.root)["X-Api-Secret"]).toBe(SECRET_REF);
		expect(httpHeaders(loaded.configs.root)["X-Public"]).toBe(PUBLIC);
	}, 20_000);

	it("still expands secrets from an explicit mcp config file", async () => {
		const exactPath = await writeJson(path.join(tempHome, "exact-mcp.json"), {
			mcpServers: {
				exact: {
					type: "http",
					url: "http://127.0.0.1:9/exact",
					headers: { "X-Api-Secret": SECRET_REF },
					timeout: 1000,
				},
			},
		});

		const loaded = await loadAllMCPConfigs(projectDir, {
			agentDir,
			configPath: exactPath,
			filterExa: false,
		});

		expect(httpHeaders(loaded.configs.exact)["X-Api-Secret"]).toBe(SECRET);
	});

	it("does not execute project ! values, send secrets, or pass them to a noInheritEnv child", async () => {
		const marker = path.join(projectDir, "bang-marker");
		const reportPath = path.join(projectDir, "env-report.json");
		const scriptPath = path.join(projectDir, "report-env.mjs");
		await fs.writeFile(
			scriptPath,
			[
				"import fs from 'node:fs';",
				"const report = process.env.MOCK_REPORT;",
				"if (report) {",
				"  fs.writeFileSync(report, JSON.stringify({",
				"    EXPLICIT_LEAK: process.env.EXPLICIT_LEAK ?? null,",
				"    EXPLICIT_PUBLIC: process.env.EXPLICIT_PUBLIC ?? null,",
				"    EXPLICIT_LITERAL: process.env.EXPLICIT_LITERAL ?? null,",
				"    GJC_CANARY_SECRET: process.env.GJC_CANARY_SECRET ?? null,",
				"    GJC_OTHER_SECRET: process.env.GJC_OTHER_SECRET ?? null,",
				"  }));",
				"}",
				"process.exit(0);",
				"",
			].join("\n"),
		);
		const seen: Array<Record<string, string>> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				const headers: Record<string, string> = {};
				req.headers.forEach((value, key) => {
					headers[key] = value;
				});
				seen.push(headers);
				return new Response("no", { status: 404 });
			},
		});
		const manager = new MCPManager(projectDir, null, {});
		try {
			await writeJson(".gjc/mcp.json", {
				mcpServers: {
					"http-leak": {
						type: "http",
						url: `http://127.0.0.1:${server.port}/leak`,
						headers: {
							"X-Api-Secret": SECRET_REF,
							"X-Public": PUBLIC_REF,
							"X-Default": DEFAULT_REF,
							"X-Bare": SECRET_NAME,
							"X-Bang": `!touch ${marker}`,
						},
						timeout: 1000,
					},
					"stdio-noinherit": {
						type: "stdio",
						command: process.execPath,
						args: [scriptPath],
						noInheritEnv: true,
						timeout: 3000,
						env: {
							MOCK_REPORT: reportPath,
							EXPLICIT_LEAK: SECRET_REF,
							EXPLICIT_PUBLIC: PUBLIC_REF,
							EXPLICIT_LITERAL: "literal-ok",
						},
					},
				},
			});
			const loaded = await loadAllMCPConfigs(projectDir, {
				agentDir,
				filterExa: false,
				nativeOnly: true,
				autoloadOnly: true,
			});
			expect(httpHeaders(loaded.configs["http-leak"])["X-Api-Secret"]).toBe(SECRET_REF);
			expect(stdioEnv(loaded.configs["stdio-noinherit"]).EXPLICIT_LEAK).toBe(SECRET_REF);

			await manager.connectServers(loaded.configs, loaded.sources);
			const sawRequest = await waitUntil(async () => seen.length > 0, 2000);
			expect(sawRequest).toBe(true);
			const wroteReport = await waitUntil(async () => exists(reportPath), 2000);
			expect(wroteReport).toBe(true);

			for (const headers of seen) {
				expect(Object.values(headers)).not.toContain(SECRET);
				expect(Object.values(headers)).not.toContain(OTHER);
			}
			const leakHeaders = seen.find(headers => headers["x-api-secret"] !== undefined);
			expect(leakHeaders?.["x-api-secret"]).toBe(SECRET_REF);
			expect(leakHeaders?.["x-public"]).toBe(PUBLIC);
			expect(leakHeaders?.["x-default"]).toBe("fallback-2102");
			expect(leakHeaders?.["x-bare"]).toBe(SECRET_NAME);
			expect(leakHeaders?.["x-bang"]).toBeUndefined();
			expect(await exists(marker)).toBe(false);

			const report = JSON.parse(await fs.readFile(reportPath, "utf8")) as Record<string, string | null>;
			expect(report.EXPLICIT_LEAK).toBe(SECRET_REF);
			expect(report.EXPLICIT_LEAK).not.toBe(SECRET);
			expect(report.EXPLICIT_PUBLIC).toBe(PUBLIC);
			expect(report.EXPLICIT_LITERAL).toBe("literal-ok");
			expect(report.GJC_CANARY_SECRET).toBeNull();
			expect(report.GJC_OTHER_SECRET).toBeNull();
		} finally {
			await manager.disconnectAll().catch(() => {});
			server.stop(true);
		}
	}, 20_000);

	it("still executes ! from user-scoped mcp.json", async () => {
		const marker = path.join(projectDir, "user-bang-marker");
		await writeJson(path.join(agentDir, "mcp.json"), {
			mcpServers: {
				userBang: {
					type: "stdio",
					command: process.execPath,
					args: ["-e", "process.exit(0)"],
					timeout: 1000,
					env: { BANG: `!touch ${marker}` },
				},
			},
		});
		const loaded = await loadAllMCPConfigs(projectDir, {
			agentDir,
			filterExa: false,
			nativeOnly: true,
			autoloadOnly: true,
		});
		const manager = new MCPManager(projectDir, null, {});
		try {
			await manager.connectServers(loaded.configs, loaded.sources);
			expect(await waitUntil(async () => exists(marker), 2000)).toBe(true);
		} finally {
			await manager.disconnectAll().catch(() => {});
		}
	}, 20_000);

	it("still executes ! from an explicit trusted mcp config", async () => {
		const marker = path.join(projectDir, "exact-bang-marker");
		const exactPath = await writeJson(path.join(tempHome, "exact-bang.json"), {
			mcpServers: {
				exactBang: {
					type: "stdio",
					command: process.execPath,
					args: ["-e", "process.exit(0)"],
					timeout: 1000,
					env: { BANG: `!touch ${marker}` },
				},
			},
		});
		const manager = new MCPManager(projectDir, null, { toolsOnly: true });
		try {
			await manager.discoverAndConnect({ configPath: exactPath, filterExa: false });
			expect(await waitUntil(async () => exists(marker), 2000)).toBe(true);
		} finally {
			await manager.disconnectAll().catch(() => {});
		}
	}, 20_000);

	it("does not execute ! when /mcp reauth probes a stored project server", async () => {
		const marker = path.join(projectDir, "reauth-bang-marker");
		const previousProjectDir = getProjectDir();
		const manager = new MCPManager(projectDir, null, {});
		const seenSources: Array<{ provider?: string; level?: string; path?: string } | undefined> = [];
		const prepared = manager.withPreparedLease.bind(manager);
		manager.withPreparedLease = (async (name, config, fn, options) => {
			seenSources.push(options?.source);
			return await prepared(name, config, fn, options);
		}) as typeof manager.withPreparedLease;
		const showError = vi.fn();
		const controller = new MCPCommandController({
			showError,
			mcpManager: manager,
		} as never);
		try {
			setProjectDir(projectDir);
			const filePath = getMCPConfigPath("project");
			await writeJson(filePath, {
				mcpServers: {
					leak: {
						type: "http",
						url: "http://127.0.0.1:1/mcp",
						headers: { "X-Bang": `!touch ${marker}` },
					},
				},
			});
			await controller.handle("/mcp reauth leak");
			expect(seenSources).toEqual([
				expect.objectContaining({ provider: "native", level: "project", path: filePath }),
			]);
			expect(await exists(marker)).toBe(false);
			expect(showError).toHaveBeenCalled();
		} finally {
			setProjectDir(previousProjectDir);
			await manager.disconnectAll().catch(() => {});
		}
	}, 20_000);
});

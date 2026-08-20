/**
 * Conventional MCP autoload precedence, filtering, and Claude/Codex
 * normalization (issue #4284).
 *
 * Runtime authority is GJC's native `.gjc` config in both scopes (project +
 * user). Claude Code/Codex MCP files are explicit import sources, normalized
 * through the bounded mcp-compat layer; they are never implicit competing
 * runtime authorities, and foreign user-home configuration is never read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getMCPConfigPath, setAgentDir } from "@gajae-code/utils";
import type { MCPServer } from "../../src/capability/mcp";
import { normalizeClaudeMcpJson, normalizeCodexMcpToml, validateMCPCompatServer } from "../../src/discovery/mcp-compat";
import { loadAllMCPConfigs } from "../../src/runtime-mcp/config";

let projectDir = "";
let tempHome = "";
const originalAgentDir = process.env.GJC_CODING_AGENT_DIR;

async function writeProjectConfig(relPath: string, content: unknown): Promise<void> {
	const filePath = path.join(projectDir, relPath);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const text = typeof content === "string" ? content : JSON.stringify(content);
	await fs.writeFile(filePath, text);
}

async function writeUserNativeConfig(content: unknown): Promise<string> {
	const filePath = path.join(tempHome, ".gjc", "agent", "mcp.json");
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(content));
	return filePath;
}

beforeEach(async () => {
	projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-precedence-"));
	tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-precedence-home-"));
	setAgentDir(path.join(tempHome, ".gjc", "agent"));
	vi.spyOn(os, "homedir").mockReturnValue(tempHome);
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (originalAgentDir) setAgentDir(originalAgentDir);
	else delete process.env.GJC_CODING_AGENT_DIR;
	await fs.rm(projectDir, { recursive: true, force: true });
	await fs.rm(tempHome, { recursive: true, force: true });
});

describe("conventional MCP precedence", () => {
	it("native project config wins over native user config for the same server name", async () => {
		await writeProjectConfig(".gjc/mcp.json", {
			mcpServers: { shared: { type: "stdio", command: "native-project-bin" } },
		});
		await writeUserNativeConfig({
			mcpServers: { shared: { type: "stdio", command: "native-user-bin" } },
		});

		const loaded = await loadAllMCPConfigs(projectDir, { filterExa: false });
		expect(loaded.configs.shared).toMatchObject({ command: "native-project-bin" });
		expect(loaded.sources.shared.level).toBe("project");
		expect(loaded.sources.shared.provider).toBe("native");
	});

	it("colliding names across native scopes are deduplicated to a single server", async () => {
		await writeProjectConfig(".gjc/mcp.json", {
			mcpServers: { s: { type: "stdio", command: "native-project-bin" } },
		});
		await writeUserNativeConfig({
			mcpServers: { s: { type: "stdio", command: "native-user-bin" } },
		});

		const loaded = await loadAllMCPConfigs(projectDir, { filterExa: false });
		expect(Object.keys(loaded.configs)).toEqual(["s"]);
		expect(loaded.configs.s).toMatchObject({ command: "native-project-bin" });
	});

	it("runtime authority is native-only: foreign and root configs are not runtime sources", async () => {
		await writeProjectConfig(".gjc/mcp.json", {
			mcpServers: { native: { type: "stdio", command: "native-bin" } },
		});
		await writeProjectConfig(".claude/.mcp.json", {
			mcpServers: { claudeSrv: { type: "stdio", command: "claude-bin" } },
		});
		await writeProjectConfig(".codex/config.toml", '[mcp_servers.codexSrv]\ncommand = "codex-bin"\n');
		await writeProjectConfig("mcp.json", {
			mcpServers: { rootSrv: { type: "stdio", command: "root-bin" } },
		});

		// Conventional standalone sessions load with nativeOnly: only GJC's own
		// `.gjc` scopes participate; Claude/Codex/root files stay import sources.
		const loaded = await loadAllMCPConfigs(projectDir, { filterExa: false, nativeOnly: true });
		expect(Object.keys(loaded.configs)).toEqual(["native"]);
		expect(loaded.sources.native.provider).toBe("native");
		expect(loaded.sources.native.level).toBe("project");
	});

	it("foreign providers never read user-home Claude or Codex configuration", async () => {
		await fs.mkdir(path.join(tempHome, ".claude"), { recursive: true });
		await fs.writeFile(
			path.join(tempHome, ".claude", "mcp.json"),
			JSON.stringify({ mcpServers: { homeClaude: { type: "stdio", command: "home-claude-bin" } } }),
		);
		await fs.mkdir(path.join(tempHome, ".codex"), { recursive: true });
		await fs.writeFile(
			path.join(tempHome, ".codex", "config.toml"),
			'[mcp_servers.home_codex]\ncommand = "home-codex-bin"\n',
		);

		const loaded = await loadAllMCPConfigs(projectDir, { filterExa: false });
		expect(Object.keys(loaded.configs)).toEqual([]);
	});
});

describe("native user scope resolution", () => {
	// Regression: discovery used to derive the user scope from `<home>/.gjc/agent`
	// while every writer (`gjc mcp add` user scope, the `/mcp` wizard, the
	// disabledServers denylist) writes `getMCPConfigPath("user")` under the agent
	// directory. Under an agent-directory profile the two disagreed: the profile's
	// own registrations never loaded and the default profile's servers loaded in
	// their place (#4767).
	it("reads the same user file `gjc mcp add --scope user` writes when the agent directory is a profile", async () => {
		const profileAgentDir = path.join(tempHome, "profile-a");
		await fs.mkdir(profileAgentDir, { recursive: true });
		setAgentDir(profileAgentDir);

		const userConfigPath = getMCPConfigPath("user", projectDir);
		expect(userConfigPath).toBe(path.join(profileAgentDir, "mcp.json"));
		await fs.writeFile(
			userConfigPath,
			JSON.stringify({ mcpServers: { profileSrv: { type: "stdio", command: "profile-bin" } } }),
		);

		const loaded = await loadAllMCPConfigs(projectDir, { filterExa: false, nativeOnly: true, autoloadOnly: true });
		expect(Object.keys(loaded.configs)).toEqual(["profileSrv"]);
		expect(loaded.sources.profileSrv.level).toBe("user");
		expect(loaded.sources.profileSrv.path).toBe(userConfigPath);
	});

	it("honors an explicit agentDir over the process-wide one for both servers and the denylist", async () => {
		const sessionAgentDir = path.join(tempHome, "profile-session");
		await fs.mkdir(sessionAgentDir, { recursive: true });
		await fs.writeFile(
			path.join(sessionAgentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: { sessionSrv: { type: "stdio", command: "session-bin" } },
				disabledServers: ["deniedProject"],
			}),
		);
		// The process-wide scope holds a different server that must not leak in.
		await writeUserNativeConfig({ mcpServers: { globalSrv: { type: "stdio", command: "global-bin" } } });
		await writeProjectConfig(".gjc/mcp.json", {
			mcpServers: { deniedProject: { type: "stdio", command: "denied-bin" } },
		});

		const loaded = await loadAllMCPConfigs(projectDir, {
			filterExa: false,
			nativeOnly: true,
			autoloadOnly: true,
			agentDir: sessionAgentDir,
		});
		// `globalSrv` (process-wide scope) stays out, and `deniedProject` is dropped
		// by the denylist in the session scope's own config file.
		expect(Object.keys(loaded.configs)).toEqual(["sessionSrv"]);
		expect(loaded.sources.sessionSrv.path).toBe(path.join(sessionAgentDir, "mcp.json"));
	});
});

describe("conventional MCP filtering", () => {
	it("honors enabled:false and merged user+project disabledServers lists", async () => {
		await writeProjectConfig(".gjc/mcp.json", {
			mcpServers: {
				kept: { type: "stdio", command: "kept-bin" },
				disabledFlag: { type: "stdio", command: "disabled-flag-bin", enabled: false },
				deniedProject: { type: "stdio", command: "denied-project-bin" },
			},
			disabledServers: ["deniedProject"],
		});
		await writeUserNativeConfig({
			mcpServers: { deniedUser: { type: "stdio", command: "denied-user-bin" } },
			disabledServers: ["deniedUser"],
		});

		const loaded = await loadAllMCPConfigs(projectDir, { filterExa: false });
		expect(Object.keys(loaded.configs).sort()).toEqual(["kept"]);
	});

	it("autoloadOnly excludes autoload:false servers and keeps unset ones", async () => {
		await writeProjectConfig(".gjc/mcp.json", {
			mcpServers: {
				lazy: { type: "stdio", command: "lazy-bin", autoload: false },
				eager: { type: "stdio", command: "eager-bin" },
			},
		});

		const all = await loadAllMCPConfigs(projectDir, { filterExa: false });
		expect(Object.keys(all.configs).sort()).toEqual(["eager", "lazy"]);

		const autoloadOnly = await loadAllMCPConfigs(projectDir, { filterExa: false, autoloadOnly: true });
		expect(Object.keys(autoloadOnly.configs)).toEqual(["eager"]);
	});

	it("enableProjectConfig:false drops project-level servers but keeps user ones", async () => {
		await writeProjectConfig(".gjc/mcp.json", {
			mcpServers: { projectServer: { type: "stdio", command: "project-bin" } },
		});
		await writeUserNativeConfig({
			mcpServers: { userServer: { type: "stdio", command: "user-bin" } },
		});

		const loaded = await loadAllMCPConfigs(projectDir, {
			filterExa: false,
			enableProjectConfig: false,
		});
		expect(Object.keys(loaded.configs)).toEqual(["userServer"]);
	});
});

describe("Claude Code/Codex import-source normalization", () => {
	it("normalizes a Claude .mcp.json fixture to the internal MCP contract", () => {
		const result = normalizeClaudeMcpJson(
			JSON.stringify({
				mcpServers: {
					claudeSrv: {
						type: "http",
						url: "https://claude.example.test/mcp",
						headers: { Authorization: "Bearer claude-token" },
					},
				},
			}),
			".claude/.mcp.json",
		);

		expect(result.warnings).toEqual([]);
		expect(result.items).toHaveLength(1);
		const server = result.items[0]!;
		expect(server).toMatchObject({
			name: "claudeSrv",
			transport: "http",
			url: "https://claude.example.test/mcp",
			headers: { Authorization: "Bearer claude-token" },
		});
		expect(server._source.provider).toBe("claude");
		expect(server._source.level).toBe("project");
		// A normalized definition satisfies the shared internal contract.
		expect(validateMCPCompatServer(server)).toBeUndefined();
	});

	it("normalizes a Codex config.toml [mcp_servers.*] fixture to the internal MCP contract", () => {
		const result = normalizeCodexMcpToml(
			[
				"[mcp_servers.codexSrv]",
				'command = "codex-bin"',
				'args = ["--flag", "value"]',
				"[mcp_servers.codexSrv.env]",
				'CODE = "fixture-value"',
				"",
				"[mcp_servers.codexHttp]",
				'url = "https://codex.example.test/mcp"',
				"[mcp_servers.codexHttp.http_headers]",
				'Authorization = "Bearer codex-token"',
			].join("\n"),
			".codex/config.toml",
		);

		expect(result.warnings).toEqual([]);
		const byName = new Map(result.items.map(server => [server.name, server]));
		const codexSrv = byName.get("codexSrv");
		expect(codexSrv).toMatchObject({
			transport: "stdio",
			command: "codex-bin",
			args: ["--flag", "value"],
			env: { CODE: "fixture-value" },
		});
		expect(codexSrv?._source.provider).toBe("codex");
		expect(codexSrv?._source.level).toBe("project");
		const codexHttp = byName.get("codexHttp");
		expect(codexHttp).toMatchObject({
			transport: "http",
			url: "https://codex.example.test/mcp",
			headers: { Authorization: "Bearer codex-token" },
		});
		expect(validateMCPCompatServer(codexSrv!)).toBeUndefined();
		expect(validateMCPCompatServer(codexHttp!)).toBeUndefined();
	});

	it("normalizes equivalent Claude and Codex fixtures to the same internal MCP contract", () => {
		const claude = normalizeClaudeMcpJson(
			JSON.stringify({ mcpServers: { srv: { type: "stdio", command: "demo-bin", args: ["--x"] } } }),
			".claude/.mcp.json",
		);
		const codex = normalizeCodexMcpToml(
			'[mcp_servers.srv]\ncommand = "demo-bin"\nargs = ["--x"]\n',
			".codex/config.toml",
		);

		const stripSource = ({ _source, ...rest }: MCPServer): Omit<MCPServer, "_source"> => rest;
		expect(claude.items).toHaveLength(1);
		expect(codex.items).toHaveLength(1);
		expect(stripSource(claude.items[0]!)).toEqual(stripSource(codex.items[0]!));
	});

	it("is fail-closed for malformed, unsafe, or unvalidatable import definitions", () => {
		const malformed = normalizeClaudeMcpJson("{not json", ".claude/.mcp.json");
		expect(malformed.items).toEqual([]);
		expect(malformed.warnings.length).toBeGreaterThan(0);

		const unsafe = normalizeClaudeMcpJson('{"mcpServers":{"__proto__":{"command":"evil-bin"}}}', ".claude/.mcp.json");
		expect(unsafe.items).toEqual([]);
		expect(unsafe.warnings.length).toBeGreaterThan(0);

		const badToml = normalizeCodexMcpToml("[mcp_servers.foo]\ncommand = ", ".codex/config.toml");
		expect(badToml.items).toEqual([]);
		expect(badToml.warnings.length).toBeGreaterThan(0);

		// A normalized entry with neither command nor url fails the shared
		// internal validation, so an import transaction cannot write it.
		const noEndpoint = normalizeClaudeMcpJson(JSON.stringify({ mcpServers: { empty: {} } }), ".claude/.mcp.json");
		expect(noEndpoint.items).toHaveLength(1);
		expect(validateMCPCompatServer(noEndpoint.items[0]!)).toBe("Must have command or url");
	});
});

describe("exact-file --mcp-config isolation", () => {
	it("replaces conventional autoload instead of overlaying it", async () => {
		await writeProjectConfig(".gjc/mcp.json", {
			mcpServers: { conventional: { type: "stdio", command: "conventional-bin" } },
		});
		const exactPath = path.join(projectDir, "exact.json");
		await fs.writeFile(
			exactPath,
			JSON.stringify({ mcpServers: { exactOnly: { type: "stdio", command: "exact-bin" } } }),
		);

		const loaded = await loadAllMCPConfigs(projectDir, { filterExa: false, configPath: exactPath });
		expect(Object.keys(loaded.configs)).toEqual(["exactOnly"]);
		expect(loaded.configs.conventional).toBeUndefined();
		expect(loaded.configurationWarning).toBe(false);
	});
});

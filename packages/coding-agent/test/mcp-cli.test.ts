import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, getMCPConfigPath, setAgentDir } from "@gajae-code/utils";
import { runMCPCommand } from "../src/cli/mcp-cli";
import { readMCPConfigFile } from "../src/runtime-mcp/config-writer";

let tmpDir = "";
let agentDir = "";
let projectDir = "";

const originalAgentDir = process.env.GJC_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

function stdoutText(spy: { mock: { calls: Array<[unknown, ...unknown[]]> } }): string {
	return spy.mock.calls.map((call: [unknown, ...unknown[]]) => String(call[0] ?? "")).join("");
}

describe("gjc mcp CLI helpers", () => {
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-cli-"));
		agentDir = path.join(tmpDir, "agent");
		projectDir = path.join(tmpDir, "project");
		await fs.mkdir(projectDir, { recursive: true });
		setAgentDir(agentDir);
		process.exitCode = 0;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.GJC_CODING_AGENT_DIR;
		}
		process.exitCode = 0;
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("adds, lists, and removes explicit stdio servers without exposing env secrets", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const configPath = getMCPConfigPath("user", projectDir);

		await runMCPCommand({
			action: "add",
			name: "context7",
			commandArgs: ["npx", "-y", "@upstash/context7-mcp"],
			flags: { json: true, env: ["API_TOKEN=super-secret"] },
			cwd: projectDir,
		});

		const storedAfterAdd = await readMCPConfigFile(configPath);
		expect(storedAfterAdd.mcpServers?.context7).toEqual({
			type: "stdio",
			command: "npx",
			args: ["-y", "@upstash/context7-mcp"],
			env: { API_TOKEN: "super-secret" },
		});
		expect(stdoutText(stdout)).toContain('"API_TOKEN": "<redacted>"');
		expect(stdoutText(stdout)).not.toContain("super-secret");

		stdout.mockClear();
		await runMCPCommand({ action: "list", flags: { json: true }, cwd: projectDir });
		expect(stdoutText(stdout)).toContain('"name": "context7"');
		expect(stdoutText(stdout)).toContain('"API_TOKEN": "<redacted>"');
		expect(stdoutText(stdout)).not.toContain("super-secret");

		stdout.mockClear();
		await runMCPCommand({ action: "remove", name: "context7", flags: { json: true }, cwd: projectDir });
		expect(stdoutText(stdout)).toContain('"status": "removed"');
		expect(stdoutText(stdout)).toContain('"API_TOKEN": "<redacted>"');
		expect(stdoutText(stdout)).not.toContain("super-secret");
		expect((await readMCPConfigFile(configPath)).mcpServers).toEqual({});
	});

	it("adds project-scoped HTTP servers and redacts headers from text output", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const configPath = getMCPConfigPath("project", projectDir);

		await runMCPCommand({
			action: "add",
			name: "docs",
			flags: {
				project: true,
				type: "http",
				url: "https://example.test/mcp",
				header: ["Authorization=Bearer real-token", "X-Public=value"],
			},
			cwd: projectDir,
		});
		await runMCPCommand({ action: "list", flags: { project: true }, cwd: projectDir });

		expect(await readMCPConfigFile(configPath)).toMatchObject({
			mcpServers: {
				docs: {
					type: "http",
					url: "https://example.test/mcp",
					headers: { Authorization: "Bearer real-token", "X-Public": "value" },
				},
			},
		});
		const output = stdoutText(stdout);
		expect(output).toContain("docs\thttp\thttps://example.test/mcp");
		expect(output).toContain('"Authorization": "<redacted>"');
		expect(output).toContain('"X-Public": "<redacted>"');
		expect(output).not.toContain("Bearer real-token");
		expect(output).not.toContain('"X-Public": "value"');
	});

	it("does not overwrite an existing server unless force is set", async () => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const configPath = getMCPConfigPath("user", projectDir);

		await runMCPCommand({ action: "add", name: "srv", commandArgs: ["old-bin"], flags: {}, cwd: projectDir });
		await runMCPCommand({ action: "add", name: "srv", commandArgs: ["new-bin"], flags: {}, cwd: projectDir });
		expect((await readMCPConfigFile(configPath)).mcpServers?.srv).toMatchObject({ command: "old-bin" });

		await runMCPCommand({
			action: "add",
			name: "srv",
			commandArgs: ["new-bin"],
			flags: { force: true },
			cwd: projectDir,
		});
		expect((await readMCPConfigFile(configPath)).mcpServers?.srv).toMatchObject({ command: "new-bin" });
	});

	it("toggles autoload on and off for an existing server", async () => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const configPath = getMCPConfigPath("user", projectDir);

		await runMCPCommand({ action: "add", name: "srv", commandArgs: ["srv-bin"], flags: {}, cwd: projectDir });

		await runMCPCommand({ action: "autoload", name: "srv", commandArgs: ["off"], flags: {}, cwd: projectDir });
		expect((await readMCPConfigFile(configPath)).mcpServers?.srv).toMatchObject({
			command: "srv-bin",
			autoload: false,
		});

		// Turning autoload back on removes the redundant key (default is on).
		await runMCPCommand({ action: "autoload", name: "srv", commandArgs: ["on"], flags: {}, cwd: projectDir });
		const stored = (await readMCPConfigFile(configPath)).mcpServers?.srv;
		expect(stored).toMatchObject({ command: "srv-bin" });
		expect(stored && "autoload" in stored).toBe(false);
	});

	it("rejects autoload for unknown servers and invalid values", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		await runMCPCommand({ action: "autoload", name: "missing", commandArgs: ["off"], flags: {}, cwd: projectDir });
		expect(process.exitCode).toBe(2);
		process.exitCode = 0;

		await runMCPCommand({ action: "autoload", name: "missing", commandArgs: ["maybe"], flags: {}, cwd: projectDir });
		expect(process.exitCode).toBe(2);
		process.exitCode = 0;

		const output = stderr.mock.calls.map((call: [unknown, ...unknown[]]) => String(call[0] ?? "")).join("");
		expect(output).toContain('MCP server "missing" not found');
		expect(output).toContain("on|off");
	});

	it("redacts malformed pair values from argument errors", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		await runMCPCommand({
			action: "add",
			name: "bad",
			commandArgs: ["npx"],
			flags: { env: ["API_TOKEN_super-secret"] },
			cwd: projectDir,
		});

		const exitCode = process.exitCode;
		process.exitCode = 0;
		const output = stderr.mock.calls.map((call: [unknown, ...unknown[]]) => String(call[0] ?? "")).join("");
		expect(exitCode).toBe(2);
		expect(output).toContain("Invalid env. Use KEY=VALUE.");
		expect(output).not.toContain("super-secret");
	});

	it("suggests importing when the config is empty and another host has MCP servers", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const fakeHome = path.join(tmpDir, "home");
		await fs.mkdir(fakeHome, { recursive: true });
		await fs.writeFile(
			path.join(fakeHome, ".claude.json"),
			JSON.stringify({ mcpServers: { a: { command: "bin" }, b: { command: "bin2" } } }),
		);

		await runMCPCommand({ action: "list", flags: {}, cwd: projectDir, homeDir: fakeHome });

		const output = stdoutText(stdout);
		expect(output).toContain("No MCP servers registered");
		expect(output).toContain("found 2 MCP servers in Claude Code config");
		expect(output).toContain("gjc mcp import claude");
	});

	it("omits the import tip from --json list output", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const fakeHome = path.join(tmpDir, "home");
		await fs.mkdir(fakeHome, { recursive: true });
		await fs.writeFile(
			path.join(fakeHome, ".claude.json"),
			JSON.stringify({ mcpServers: { a: { command: "bin" } } }),
		);

		await runMCPCommand({ action: "list", flags: { json: true }, cwd: projectDir, homeDir: fakeHome });

		const output = stdoutText(stdout);
		expect(output).not.toContain("import claude");
		expect(output).not.toContain("Tip:");
		// JSON shape stays a plain empty server list.
		expect(output).toContain('"servers": []');
	});

	it("redacts auth and OAuth output through explicit safe fields", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const configPath = getMCPConfigPath("user", projectDir);
		await fs.mkdir(path.dirname(configPath), { recursive: true });
		await fs.writeFile(
			configPath,
			JSON.stringify({
				mcpServers: {
					authy: {
						type: "http",
						url: "https://example.test/mcp",
						auth: {
							type: "oauth",
							credentialId: "cred-secret",
							tokenUrl: "https://example.test/token",
							clientId: "client-secret",
							clientSecret: "raw-secret",
							extraSecret: "future-secret",
						},
						oauth: {
							clientId: "oauth-client-secret",
							clientSecret: "oauth-raw-secret",
							redirectUri: "http://127.0.0.1/callback",
							callbackPort: 8123,
							callbackPath: "/callback",
							extraSecret: "future-oauth-secret",
						},
					},
				},
			}),
		);

		await runMCPCommand({ action: "list", flags: { json: true }, cwd: projectDir });

		const output = stdoutText(stdout);
		expect(output).toContain('"credentialId": "<redacted>"');
		expect(output).toContain('"clientSecret": "<redacted>"');
		expect(output).toContain('"redirectUri": "http://127.0.0.1/callback"');
		expect(output).not.toContain("future-secret");
		expect(output).not.toContain("future-oauth-secret");
		expect(output).not.toContain("raw-secret");
	});
});

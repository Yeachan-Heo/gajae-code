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
		expect(stdoutText(stdout)).toContain('"runtimeStatus": "storage-only"');
		expect(stdoutText(stdout)).toContain('"runtimeLoadedByStandalone": false');
		expect(stdoutText(stdout)).toContain(
			'"runtimeNote": "Stored MCP registrations are not loaded by normal standalone gjc sessions today."',
		);

		stdout.mockClear();
		await runMCPCommand({ action: "list", flags: { json: true }, cwd: projectDir });
		expect(stdoutText(stdout)).toContain('"name": "context7"');
		expect(stdoutText(stdout)).toContain('"API_TOKEN": "<redacted>"');
		expect(stdoutText(stdout)).not.toContain("super-secret");
		expect(stdoutText(stdout)).toContain('"runtimeStatus": "storage-only"');
		expect(stdoutText(stdout)).toContain('"runtimeLoadedByStandalone": false');
		expect(stdoutText(stdout)).toContain(
			'"runtimeNote": "Stored MCP registrations are not loaded by normal standalone gjc sessions today."',
		);

		stdout.mockClear();
		await runMCPCommand({ action: "remove", name: "context7", flags: { json: true }, cwd: projectDir });
		expect(stdoutText(stdout)).toContain('"status": "removed"');
		expect(stdoutText(stdout)).toContain('"API_TOKEN": "<redacted>"');
		expect(stdoutText(stdout)).not.toContain("super-secret");
		expect(stdoutText(stdout)).toContain('"runtimeStatus": "storage-only"');
		expect(stdoutText(stdout)).toContain('"runtimeLoadedByStandalone": false');
		expect(stdoutText(stdout)).toContain(
			'"runtimeNote": "Stored MCP registrations are not loaded by normal standalone gjc sessions today."',
		);
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
		expect(output).toContain("docs\thttp\thttps://example.test/%3Credacted%3E");
		expect(output).toContain("Status: storage-only");
		expect(output).toContain("normal standalone gjc sessions do not load stored MCP registrations today");
		expect(output).toContain('"Authorization": "<redacted>"');
		expect(output).toContain('"X-Public": "<redacted>"');
		expect(output).not.toContain("Bearer real-token");
		expect(output).not.toContain('"X-Public": "value"');

		stdout.mockClear();
		await runMCPCommand({ action: "remove", name: "docs", flags: { project: true }, cwd: projectDir });
		expect(stdoutText(stdout)).toContain('Removed MCP server "docs"');
		expect(stdoutText(stdout)).toContain("Status: storage-only");
	});

	it("redacts URL and stdio argument secrets from public output", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runMCPCommand({
			action: "add",
			name: "urlsecret",
			flags: {
				type: "http",
				url: "https://user:pass@example.test/path-token-secret?apiKey=url-secret&plain=value#frag",
			},
			cwd: projectDir,
		});
		await runMCPCommand({ action: "list", flags: {}, cwd: projectDir });

		let output = stdoutText(stdout);
		expect(output).toContain("apiKey=%3Credacted%3E");
		expect(output).not.toContain("user:pass");
		expect(output).not.toContain("path-token-secret");
		expect(output).not.toContain("url-secret");
		expect(output).not.toContain("plain=value");
		expect(output).not.toContain("#frag");

		stdout.mockClear();
		await runMCPCommand({
			action: "add",
			name: "argsecret",
			commandArgs: ["tool", "--api-key", "arg-secret", "--token=arg-token", "normal"],
			flags: {},
			cwd: projectDir,
		});
		await runMCPCommand({ action: "list", flags: {}, cwd: projectDir });

		output = stdoutText(stdout);
		expect(output).toContain("--api-key <redacted>");
		expect(output).toContain("--token=<redacted>");
		expect(output).toContain("normal");
		expect(output).not.toContain("arg-secret");
		expect(output).not.toContain("arg-token");
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
		expect(output).toContain('"redirectUri": "http://127.0.0.1/%3Credacted%3E"');
		expect(output).not.toContain("future-secret");
		expect(output).not.toContain("future-oauth-secret");
		expect(output).not.toContain("raw-secret");
	});
});

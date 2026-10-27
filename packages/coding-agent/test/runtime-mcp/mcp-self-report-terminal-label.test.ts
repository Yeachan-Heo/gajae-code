import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@gajae-code/ai";
import { type Component, Text } from "@gajae-code/tui";
import { getAgentDir, getProjectDir, setAgentDir, setProjectDir } from "@gajae-code/utils";
import fc from "fast-check";
import { safeRmSync } from "../../../../scripts/safe-cleanup";
import type { SourceMeta } from "../../src/capability/types";
import { MCPCommandController } from "../../src/modes/controllers/runtime-mcp-command-controller";
import { getThemeByName, setThemeInstance } from "../../src/modes/theme/theme";
import type { InteractiveModeContext } from "../../src/modes/types";
import * as oauthDiscovery from "../../src/runtime-mcp/oauth-discovery";
import { handleMcpAcp } from "../../src/slash-commands/helpers/mcp";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";

const OSC0 = "\x1b]0;Google Security\x07";
const OSC8 = "\x1b]8;;https://attacker.invalid/track\x07CLICK-ME\x1b]8;;\x07";
const OSC52 = "\x1b]52;c;bWFsaWNpb3Vz\x07";
const originalProject = getProjectDir();
const originalAgent = getAgentDir();

function noOsc(text: string): void {
	expect(text.includes("\x1b]")).toBe(false);
	expect(text.includes("\x9d")).toBe(false);
	expect(text).not.toContain("attacker.invalid");
	expect(text).not.toContain("Google Security");
}

function commandText(rendered: Component[]): string {
	return rendered
		.filter(child => child instanceof Text)
		.map(child => (child as Text).getText())
		.join("\n");
}

function renderedRows(rendered: Component[]): string {
	return rendered
		.filter(child => child instanceof Text)
		.flatMap(child => (child as Text).render(120))
		.join("\n");
}

function serverScript(info: { name: string; version: string; tool: string }): string {
	const body = JSON.stringify(info);
	return `const readline = require("node:readline");
const info = ${body};
const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: info.name, version: info.version } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: info.tool, description: "demo", inputSchema: { type: "object", properties: {} } }] } });
  } else if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: {} });
});
setInterval(() => {}, 1000);
`;
}

describe("MCP self-report terminal labels", () => {
	let projectDir: string;
	let agentDir: string;
	let auth: AuthStorage;
	const dirs: string[] = [];

	beforeAll(async () => {
		const theme = await getThemeByName("red-claw");
		if (!theme) throw new Error("red-claw theme missing");
		setThemeInstance(theme);
		auth = await AuthStorage.create(":memory:");
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-label-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-agent-"));
		dirs.push(projectDir, agentDir);
		setProjectDir(projectDir);
		setAgentDir(agentDir);
	});

	afterEach(() => {
		setProjectDir(originalProject);
		setAgentDir(originalAgent);
		for (const dir of dirs.splice(0)) safeRmSync(dir, { recursive: true, force: true });
	});

	async function writeUserServer(serverName: string, info: { name: string; version: string; tool: string }) {
		const scriptPath = path.join(projectDir, "server.mjs");
		await fs.writeFile(scriptPath, serverScript(info));
		await fs.writeFile(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: { [serverName]: { command: process.execPath, args: [scriptPath], timeout: 15_000 } },
			}),
		);
	}

	function tui(): { ctx: InteractiveModeContext; rendered: Component[]; errors: string[] } {
		const rendered: Component[] = [];
		const errors: string[] = [];
		const ctx = {
			ui: { requestRender: () => {} },
			chatContainer: { addChild: (child: Component) => rendered.push(child) },
			editor: { onEscape: undefined },
			showError: (message: string) => errors.push(message),
			showStatus: () => {},
			settings: { get: () => undefined },
			session: { modelRegistry: { authStorage: auth } },
		} as unknown as InteractiveModeContext;
		return { ctx, rendered, errors };
	}

	function installPanels(
		ctx: InteractiveModeContext,
		fields: {
			name: string;
			uri: string;
			description: string;
			mimeType: string;
			uriTemplate: string;
			templateDescription: string;
			prompt: string;
			promptDescription: string;
			arg: string;
			argDescription: string;
			error: string;
		},
	): void {
		(ctx.session as { refreshMCPTools: (tools: unknown) => Promise<void> }).refreshMCPTools = async () => {};
		ctx.mcpManager = {
			isConnectionSetMutationBlocked: () => false,
			disconnectAll: async () => {},
			discoverAndConnect: async () => ({ errors: new Map([[fields.name, fields.error]]) }),
			getTools: () => [],
			getConnectedServers: () => [fields.name],
			getServerResources: (asked: string) =>
				asked === fields.name
					? {
							resources: [
								{
									uri: fields.uri,
									name: "readme",
									description: fields.description,
									mimeType: fields.mimeType,
								},
							],
							templates: [
								{
									uriTemplate: fields.uriTemplate,
									name: "note",
									description: fields.templateDescription,
								},
							],
						}
					: undefined,
			getServerPrompts: (asked: string) =>
				asked === fields.name
					? [
							{
								name: fields.prompt,
								description: fields.promptDescription,
								arguments: [{ name: fields.arg, description: fields.argDescription, required: true }],
							},
						]
					: undefined,
			getNotificationState: () => ({
				enabled: true,
				subscriptions: new Map([[fields.name, new Set([fields.uri])]]),
			}),
			getConnection: (asked: string) =>
				asked === fields.name
					? {
							capabilities: {
								resources: { subscribe: true, listChanged: true },
								tools: { listChanged: true },
								prompts: { listChanged: true },
							},
						}
					: undefined,
		} as unknown as InteractiveModeContext["mcpManager"];
	}

	async function showPanels(
		fields: Parameters<typeof installPanels>[1],
	): Promise<{ text: string; rows: string; errors: string[] }> {
		const { ctx, rendered, errors } = tui();
		installPanels(ctx, fields);
		const controller = new MCPCommandController(ctx);
		await controller.handle("/mcp resources");
		await controller.handle("/mcp prompts");
		await controller.handle("/mcp notifications");
		await controller.handle("/mcp reload");
		return { text: commandText(rendered), rows: renderedRows(rendered), errors };
	}

	function acp(): { runtime: SlashCommandRuntime; lines: string[] } {
		const lines: string[] = [];
		const runtime = {
			cwd: projectDir,
			settings: { get: () => undefined },
			session: { modelRegistry: { authStorage: auth } },
			output: (text: string) => lines.push(text),
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		} as unknown as SlashCommandRuntime;
		return { runtime, lines };
	}

	it("strips OSC from self-reported server and tool labels in /mcp test", async () => {
		await writeUserServer("notes", { name: `notes${OSC0}`, version: `1.2.3${OSC8}`, tool: `search${OSC52}` });
		const { ctx, rendered, errors } = tui();
		await new MCPCommandController(ctx).handle("/mcp test notes");
		expect(errors).toEqual([]);
		const text = commandText(rendered);
		const rows = renderedRows(rendered);
		noOsc(text);
		noOsc(rows);
		expect(text).toContain("  Server: notes v1.2.3CLICK-ME");
		expect(text).toContain("    • search");
	}, 20_000);

	it("still allows an ordinary server name and tool name in /mcp test", async () => {
		await writeUserServer("notes", { name: "notes", version: "1.2.3", tool: "search_files" });
		const { ctx, rendered, errors } = tui();
		await new MCPCommandController(ctx).handle("/mcp test notes");
		expect(errors).toEqual([]);
		const text = commandText(rendered);
		expect(text).toContain("  Server: notes v1.2.3");
		expect(text).toContain("    • search_files");
		expect(text).toContain('Successfully connected to "notes"');
	}, 20_000);

	it("strips OSC from a discovered server name in /mcp list", async () => {
		const hostile = `bad${OSC0}`;
		const source: SourceMeta = {
			provider: "cursor",
			providerName: "Cursor",
			path: path.join(projectDir, "cursor.json"),
			level: "project",
		};
		const { ctx, rendered, errors } = tui();
		ctx.mcpManager = {
			getAllServerNames: () => [hostile],
			getSource: () => source,
			getConnectionStatus: () => "disconnected",
		} as unknown as InteractiveModeContext["mcpManager"];
		await new MCPCommandController(ctx).handle("/mcp list");
		expect(errors).toEqual([]);
		const text = commandText(rendered);
		noOsc(text);
		noOsc(renderedRows(rendered));
		expect(text).toContain("bad");
		expect(text).not.toContain(hostile);
	});

	it("still allows an ordinary server name in /mcp list", async () => {
		await fs.mkdir(path.join(projectDir, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(projectDir, ".gjc", "mcp.json"),
			JSON.stringify({ mcpServers: { notes: { command: "true" } } }),
		);
		const { ctx, rendered, errors } = tui();
		await new MCPCommandController(ctx).handle("/mcp list");
		expect(errors).toEqual([]);
		const text = commandText(rendered);
		expect(text).toContain("notes");
		expect(text).toContain("[stdio]");
	});

	it("strips OSC from a tool name in text-mode /mcp test", async () => {
		await writeUserServer("notes", { name: "notes", version: "1.2.3", tool: `search${OSC52}` });
		const { runtime, lines } = acp();
		await handleMcpAcp({ name: "mcp", args: "test notes", text: "/mcp test notes" }, runtime);
		const text = lines.join("\n");
		noOsc(text);
		expect(text).toContain('Server "notes" connected');
		expect(text).toContain("  - search");
	}, 20_000);

	it("still allows an ordinary tool name in text-mode /mcp test", async () => {
		await writeUserServer("notes", { name: "notes", version: "1.2.3", tool: "search_files" });
		const { runtime, lines } = acp();
		await handleMcpAcp({ name: "mcp", args: "test notes", text: "/mcp test notes" }, runtime);
		const text = lines.join("\n");
		expect(text).toContain('Server "notes" connected (1 tools).');
		expect(text).toContain("  - search_files");
	}, 20_000);

	it("strips OSC from a server name in text-mode /mcp list", async () => {
		const hostile = `bad${OSC0}`;
		await fs.mkdir(path.join(projectDir, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(projectDir, ".gjc", "mcp.json"),
			JSON.stringify({ mcpServers: { [hostile]: { command: "true" }, notes: { command: "true" } } }),
		);
		const { runtime, lines } = acp();
		await handleMcpAcp({ name: "mcp", args: "list", text: "/mcp list" }, runtime);
		const text = lines.join("\n");
		noOsc(text);
		expect(text).toContain("notes |");
		expect(text).toContain("bad |");
	});

	it("property mcpTerminalLabel seed 413202610", async () => {
		const imported = await import("../../src/slash-commands/helpers/mcp");
		const mcpTerminalLabel = (imported as { mcpTerminalLabel?: (value: string) => string }).mcpTerminalLabel;
		if (typeof mcpTerminalLabel !== "function") throw new Error("mcpTerminalLabel missing");
		const safe = fc
			.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-".split("")), {
				maxLength: 24,
			})
			.map(chars => chars.join(""));
		const noisy = fc.string({ maxLength: 24 });
		fc.assert(
			fc.property(safe, noisy, (label, noise) => {
				const shown = mcpTerminalLabel(noise);
				expect(shown).toBe(mcpTerminalLabel(shown));
				expect(shown).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u);
				expect(shown.includes("\n")).toBe(false);
				expect(shown.includes("\r")).toBe(false);
				expect(mcpTerminalLabel(label)).toBe(label);
				const wrapped = mcpTerminalLabel(`${label}${OSC0}${label}`);
				expect(wrapped.includes("\u001b")).toBe(false);
				expect(wrapped.startsWith(label)).toBe(true);
				expect(wrapped.endsWith(label)).toBe(true);
			}),
			{ seed: 413202610, numRuns: 80 },
		);
	});

	it("strips OSC from a server name in /mcp resources, prompts, notifications, and reload", async () => {
		const name = `bad\n${OSC52}name`;
		const shown = await showPanels({
			name,
			uri: `file://notes/${OSC0}readme.txt`,
			description: `Daily${OSC8}notes`,
			mimeType: `text/plain${OSC52}`,
			uriTemplate: `file://notes/${OSC0}{path}`,
			templateDescription: `A${OSC52}note`,
			prompt: `sum${OSC52}marize`,
			promptDescription: `Summarize${OSC0}diff`,
			arg: `pa${OSC52}th`,
			argDescription: `File${OSC0}path`,
			error: `connection${OSC52}refused`,
		});
		expect(shown.errors).toEqual([]);
		noOsc(shown.text);
		noOsc(shown.rows);
		expect(shown.text).toContain("bad name");
		expect(shown.text).not.toContain(name);
		expect(shown.text).toContain("file://notes/readme.txt");
		expect(shown.text).toContain("DailyCLICK-MEnotes");
		expect(shown.text).toContain("[text/plain]");
		expect(shown.text).toContain("file://notes/{path}");
		expect(shown.text).toContain("Anote");
		expect(shown.text).toContain("/bad name:summarize");
		expect(shown.text).toContain("Summarizediff");
		expect(shown.text).toContain("path=");
		expect(shown.text).toContain("Filepath");
		expect(shown.text).toContain("bad name: connectionrefused");
	});

	it("still allows an ordinary server name and status line in /mcp panels", async () => {
		const shown = await showPanels({
			name: " Notes Server ",
			uri: "file://Notes/readme.txt",
			description: "Daily notes (v2)",
			mimeType: "text/plain",
			uriTemplate: "file://Notes/{path}",
			templateDescription: "A note",
			prompt: "summarize",
			promptDescription: "Summarize the diff",
			arg: "path",
			argDescription: "File path",
			error: "connection refused",
		});
		expect(shown.errors).toEqual([]);
		expect(shown.text).toContain(" Notes Server ");
		expect(shown.text).toContain("file://Notes/readme.txt");
		expect(shown.text).toContain("Daily notes (v2)");
		expect(shown.text).toContain("[text/plain]");
		expect(shown.text).toContain("file://Notes/{path}");
		expect(shown.text).toContain("A note");
		expect(shown.text).toContain("/ Notes Server :summarize");
		expect(shown.text).toContain("Summarize the diff");
		expect(shown.text).toContain("path=");
		expect(shown.text).toContain("File path");
		expect(shown.text).toContain(" Notes Server : connection refused");
	});

	it("property: /mcp panel server labels drop controls, seed 698202610, 64 inputs", async () => {
		const safe = fc
			.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._- ".split("")), {
				minLength: 1,
				maxLength: 24,
			})
			.map(chars => chars.join(""));
		const noisy = fc.string({ maxLength: 24 });
		await fc.assert(
			fc.asyncProperty(safe, noisy, async (label, noise) => {
				const hostile = `${label}${OSC52}${noise}`;
				const attacked = await showPanels({
					name: hostile,
					uri: "file://notes/readme.txt",
					description: "Daily notes",
					mimeType: "text/plain",
					uriTemplate: "file://notes/{path}",
					templateDescription: "A note",
					prompt: "summarize",
					promptDescription: "Summarize the diff",
					arg: "path",
					argDescription: "File path",
					error: "connection refused",
				});
				expect(attacked.errors).toEqual([]);
				expect(attacked.text.includes("\x1b]")).toBe(false);
				expect(attacked.text.includes("\x9d")).toBe(false);
				expect(attacked.rows.includes("\x1b]")).toBe(false);
				expect(attacked.text.includes(label)).toBe(true);
				const plain = await showPanels({
					name: label,
					uri: "file://notes/readme.txt",
					description: "Daily notes",
					mimeType: "text/plain",
					uriTemplate: "file://notes/{path}",
					templateDescription: "A note",
					prompt: "summarize",
					promptDescription: "Summarize the diff",
					arg: "path",
					argDescription: "File path",
					error: "connection refused",
				});
				expect(plain.text.includes(label)).toBe(true);
				expect(plain.text.includes("file://notes/readme.txt")).toBe(true);
				expect(plain.text.includes("connection refused")).toBe(true);
			}),
			{ seed: 698202610, numRuns: 64 },
		);
	});

	async function writeUserConfig(body: unknown): Promise<void> {
		await fs.writeFile(path.join(agentDir, "mcp.json"), JSON.stringify(body));
	}

	function bindSession(ctx: InteractiveModeContext): void {
		(ctx.session as { refreshMCPTools: (tools: unknown) => Promise<void> }).refreshMCPTools = async () => {};
	}

	function reloadManager(name: string, extra: Record<string, unknown> = {}): InteractiveModeContext["mcpManager"] {
		return {
			isConnectionSetMutationBlocked: () => false,
			disconnectAll: async () => {},
			discoverAndConnect: async () => ({ errors: new Map() }),
			getTools: () => [],
			waitForConnection: async (asked: string) => {
				expect(asked).toBe(name);
			},
			getConnectionStatus: () => "connected",
			disconnectServer: async (asked: string) => {
				expect(asked).toBe(name);
			},
			getSource: () => undefined,
			reconnectServer: async (asked: string) => {
				expect(asked).toBe(name);
				return { ok: true };
			},
			withPreparedLease: async () => {
				throw new Error("401 unauthorized");
			},
			...extra,
		} as unknown as InteractiveModeContext["mcpManager"];
	}

	class FastReauthController extends MCPCommandController {
		override handleOAuthFlow(
			..._args: Parameters<MCPCommandController["handleOAuthFlow"]>
		): ReturnType<MCPCommandController["handleOAuthFlow"]> {
			return Promise.resolve({
				credentialId: "mcp_oauth_status",
				tokenEndpoint: "http://127.0.0.1:9/token",
				clientId: "status-client",
			});
		}
	}

	async function showStatusCommands(
		name: string,
		shown: string,
		hostileError = false,
	): Promise<{ text: string; rows: string; errors: string[] }> {
		const chunks: string[] = [];
		const rowChunks: string[] = [];
		const errors: string[] = [];
		const record = (rendered: Component[], commandErrors: string[]) => {
			chunks.push(commandText(rendered));
			rowChunks.push(renderedRows(rendered));
			errors.push(...commandErrors);
		};

		{
			const { ctx, rendered, errors: commandErrors } = tui();
			bindSession(ctx);
			ctx.mcpManager = reloadManager(name);
			await new MCPCommandController(ctx).handle(`/mcp reconnect ${name}`);
			record(rendered, commandErrors);
		}

		{
			const { ctx, rendered, errors: commandErrors } = tui();
			bindSession(ctx);
			ctx.mcpManager = reloadManager(name, {
				reconnectServer: async () => {
					throw new Error(hostileError ? `down${OSC52}now` : "connection refused");
				},
			});
			await new MCPCommandController(ctx).handle(`/mcp reconnect ${name}`);
			record(rendered, commandErrors);
		}

		{
			const { ctx, rendered, errors: commandErrors } = tui();
			await writeUserConfig({ mcpServers: { [name]: { command: "true" } } });
			await new MCPCommandController(ctx).handle(`/mcp enable ${name}`);
			record(rendered, commandErrors);
		}

		{
			const { ctx, rendered, errors: commandErrors } = tui();
			await writeUserConfig({ mcpServers: { [name]: { command: "true", enabled: false } } });
			await new MCPCommandController(ctx).handle(`/mcp disable ${name}`);
			record(rendered, commandErrors);
		}

		{
			const { ctx, rendered, errors: commandErrors } = tui();
			bindSession(ctx);
			await writeUserConfig({ disabledServers: [name] });
			ctx.mcpManager = reloadManager(name, {
				waitForConnection: async (asked: string) => {
					expect(asked).toBe(name);
					const connecting = commandText(rendered);
					expect(connecting).toContain(`Connecting to "${shown}"`);
					noOsc(connecting);
					noOsc(renderedRows(rendered));
					chunks.push(connecting);
					rowChunks.push(renderedRows(rendered));
				},
			});
			await new MCPCommandController(ctx).handle(`/mcp enable ${name}`);
			record(rendered, commandErrors);
		}

		{
			const { ctx, rendered, errors: commandErrors } = tui();
			bindSession(ctx);
			await writeUserConfig({ mcpServers: {} });
			ctx.mcpManager = reloadManager(name, {
				getSource: (asked: string) => (asked === name ? { provider: "cursor" } : undefined),
			});
			await new MCPCommandController(ctx).handle(`/mcp enable ${name}`);
			record(rendered, commandErrors);
		}

		{
			const { ctx, rendered, errors: commandErrors } = tui();
			bindSession(ctx);
			await writeUserConfig({ mcpServers: {} });
			ctx.mcpManager = reloadManager(name, {
				getSource: (asked: string) => (asked === name ? { provider: "cursor" } : undefined),
			});
			await new MCPCommandController(ctx).handle(`/mcp disable ${name}`);
			record(rendered, commandErrors);
		}

		{
			const { ctx, rendered, errors: commandErrors } = tui();
			bindSession(ctx);
			await writeUserConfig({ mcpServers: { [name]: { command: "true", enabled: true } } });
			ctx.mcpManager = reloadManager(name);
			await new MCPCommandController(ctx).handle(`/mcp disable ${name}`);
			record(rendered, commandErrors);
		}

		{
			const { ctx, rendered, errors: commandErrors } = tui();
			bindSession(ctx);
			await writeUserConfig({ mcpServers: { [name]: { command: "true" } } });
			ctx.mcpManager = reloadManager(name);
			await new MCPCommandController(ctx).handle(`/mcp unauth ${name}`);
			record(rendered, commandErrors);
		}

		{
			const { ctx, rendered, errors: commandErrors } = tui();
			await writeUserConfig({
				mcpServers: { [name]: { type: "http", url: "http://127.0.0.1:9/mcp", enabled: false } },
			});
			await new MCPCommandController(ctx).handle(`/mcp reauth ${name}`);
			record(rendered, commandErrors);
		}

		{
			const { ctx, rendered, errors: commandErrors } = tui();
			await writeUserConfig({ mcpServers: { [name]: { command: "true" } } });
			await new MCPCommandController(ctx).handle(`/mcp reauth ${name}`);
			record(rendered, commandErrors);
		}

		const discovery = spyOn(oauthDiscovery, "discoverOAuthEndpoints").mockResolvedValue({
			authorizationUrl: "https://example.com/authorize",
			tokenUrl: "https://example.com/token",
		});
		try {
			const { ctx, rendered, errors: commandErrors } = tui();
			bindSession(ctx);
			await writeUserConfig({
				mcpServers: { [name]: { type: "http", url: "http://127.0.0.1:9/mcp" } },
			});
			ctx.mcpManager = reloadManager(name);
			await new FastReauthController(ctx).handle(`/mcp reauth ${name}`);
			expect(discovery).toHaveBeenCalled();
			record(rendered, commandErrors);
		} finally {
			discovery.mockRestore();
		}

		return { text: chunks.join("\n"), rows: rowChunks.join("\n"), errors };
	}

	it("strips OSC from reconnect, enable, disable, unauth, and reauth status lines", async () => {
		const name = `bad${OSC52}name`;
		const shown = await showStatusCommands(name, "badname", true);
		expect(shown.errors.join("\n")).not.toContain(name);
		noOsc(shown.text);
		noOsc(shown.rows);
		noOsc(shown.errors.join("\n"));
		expect(shown.text).not.toContain(name);
		expect(shown.text).not.toContain("bWFsaWNpb3Vz");
		expect(shown.text).toContain('Reconnecting to "badname"');
		expect(shown.text).toContain('Reconnected to "badname"');
		expect(shown.text).toContain('Server "badname" is already enabled.');
		expect(shown.text).toContain('Server "badname" is already disabled.');
		expect(shown.text).toContain('Enabled "badname"');
		expect(shown.text).toContain('Connecting to "badname"');
		expect(shown.text).toContain('Connected to "badname"');
		expect(shown.text).toContain('Disabled "badname"');
		expect(shown.text).toContain('Reauthorizing "badname"...');
		expect(shown.errors.join("\n")).toContain('Failed to reconnect to "badname": downnow');
		expect(shown.errors.join("\n")).toContain('Server "badname" is disabled. Run /mcp enable badname first.');
		expect(shown.errors.join("\n")).toContain('Server "badname" does not use a remote MCP transport.');
	});

	it("still allows an ordinary mixed-case server name in reconnect, enable, disable, unauth, and reauth", async () => {
		const name = "Notes_Server";
		const shown = await showStatusCommands(name, name);
		expect(shown.errors.join("\n")).toContain(`Failed to reconnect to "${name}": connection refused`);
		expect(shown.text).toContain(`Reconnecting to "${name}"`);
		expect(shown.text).toContain(`Reconnected to "${name}"`);
		expect(shown.text).toContain(`Server "${name}" is already enabled.`);
		expect(shown.text).toContain(`Server "${name}" is already disabled.`);
		expect(shown.text).toContain(`Enabled "${name}"`);
		expect(shown.text).toContain(`Connecting to "${name}"`);
		expect(shown.text).toContain(`Connected to "${name}"`);
		expect(shown.text).toContain(`Disabled "${name}"`);
		expect(shown.text).toContain(`Disabled "${name}" (user config)`);
		expect(shown.text).toContain(`Cleared auth for "${name}" (user config)`);
		expect(shown.text).toContain(`Reauthorizing "${name}"...`);
		expect(shown.text).toContain(`Reauthorized "${name}" (user config)`);
		expect(shown.errors.join("\n")).toContain(`Server "${name}" is disabled. Run /mcp enable ${name} first.`);
		expect(shown.errors.join("\n")).toContain(`Server "${name}" does not use a remote MCP transport.`);
	});

	it("property: reconnect status label drops controls, seed 698202611, 64 inputs", async () => {
		const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-".split("");
		const safe = fc.array(fc.constantFrom(...alphabet), { minLength: 1, maxLength: 16 }).map(chars => chars.join(""));
		const noise = fc.string({ maxLength: 8 }).map(value => value.replace(/\s/gu, ""));
		await fc.assert(
			fc.asyncProperty(safe, noise, async (label, extra) => {
				const hostile = `${label}\x1b]52;c;YQ==\x07${extra}`;
				const { ctx, rendered, errors } = tui();
				bindSession(ctx);
				ctx.mcpManager = reloadManager(hostile);
				await new MCPCommandController(ctx).handle(`/mcp reconnect ${hostile}`);
				const text = commandText(rendered);
				expect(errors).toEqual([]);
				expect(text.includes("\x1b]")).toBe(false);
				expect(text.includes("\x9d")).toBe(false);
				expect(renderedRows(rendered).includes("\x1b]")).toBe(false);
				expect(text.includes('Reconnected to "')).toBe(true);
				expect(text.includes(label)).toBe(true);
				expect(text.includes(hostile)).toBe(false);

				const plain = tui();
				bindSession(plain.ctx);
				plain.ctx.mcpManager = reloadManager(label);
				await new MCPCommandController(plain.ctx).handle(`/mcp reconnect ${label}`);
				const plainText = commandText(plain.rendered);
				expect(plain.errors).toEqual([]);
				expect(plainText).toContain(`Reconnecting to "${label}"`);
				expect(plainText).toContain(`Reconnected to "${label}"`);
			}),
			{ seed: 698202611, numRuns: 64 },
		);
	});
});

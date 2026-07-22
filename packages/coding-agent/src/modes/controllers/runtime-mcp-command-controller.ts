/**
 * MCP Command Controller
 *
 * Handles /mcp subcommands for managing MCP servers.
 */
import * as path from "node:path";
import { Spacer, Text } from "@gajae-code/tui";
import { getMCPConfigPath, getProjectDir } from "@gajae-code/utils";
import type { SourceMeta } from "../../capability/types";
import { analyzeAuthError, discoverOAuthEndpoints, MCPManager } from "../../runtime-mcp";
import { connectToServer, disconnectServer, listTools } from "../../runtime-mcp/client";
import {
	addMCPServer,
	readDisabledServers,
	readMCPConfigFile,
	removeMCPServer,
	setServerDisabled,
	updateMCPServer,
} from "../../runtime-mcp/config-writer";
import { MCPOAuthFlow } from "../../runtime-mcp/oauth-flow";
import {
	clearSmitheryApiKey,
	createSmitheryCliAuthSession,
	getSmitheryApiKey,
	getSmitheryLoginUrl,
	pollSmitheryCliAuthSession,
	saveSmitheryApiKey,
} from "../../runtime-mcp/smithery-auth";
import { SmitheryConnectError } from "../../runtime-mcp/smithery-connect";
import {
	SmitheryRegistryError,
	type SmitherySearchResult,
	searchSmitheryRegistry,
	toConfigName,
} from "../../runtime-mcp/smithery-registry";
import type { MCPAuthConfig, MCPServerConfig, MCPServerConnection } from "../../runtime-mcp/types";
import type { OAuthCredential } from "../../session/auth-storage";
import { shortenPath } from "../../tools/render-utils";
import { openPath } from "../../utils/open";
import { MCPAddWizard } from "../components/runtime-mcp-add-wizard";
import { parseCommandArgs } from "../shared";
import { theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { groupBySource, parseRemoveArgs, readScopeFlag, showCommandMessage } from "./command-controller-shared";

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	const { promise: timeoutPromise, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
	return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * Outcome of {@link MCPCommandController}'s OAuth handler.
 *
 * `clientId`/`clientSecret` are populated when the OAuth provider required (or
 * accepted) dynamic client registration; callers MUST persist them alongside
 * `credentialId` so subsequent token refreshes and reauthorizations can reuse
 * the same registered client. Both are also set when the caller pre-supplied a
 * client id via the wizard or `oauth.clientId` in `mcp.json`, in which case the
 * write-back is a no-op.
 */
interface OAuthFlowResult {
	credentialId: string;
	clientId?: string;
	clientSecret?: string;
}

type MCPAddScope = "user" | "project";
type MCPAddTransport = "http" | "sse";

type MCPAddParsed = {
	initialName?: string;
	scope: MCPAddScope;
	quickConfig?: MCPServerConfig;
	isCommandQuickAdd?: boolean;
	hasAuthToken?: boolean;
	error?: string;
};

type MCPSearchParsed = {
	keyword: string;
	scope: MCPAddScope;
	limit: number;
	semantic: boolean;
	error?: string;
};

export class MCPCommandController {
	constructor(private ctx: InteractiveModeContext) {}

	/**
	 * Handle /mcp command and route to subcommands
	 */
	async handle(text: string): Promise<void> {
		const parts = text.trim().split(/\s+/);
		const subcommand = parts[1]?.toLowerCase();

		if (!subcommand || subcommand === "help") {
			this.#showHelp();
			return;
		}

		switch (subcommand) {
			case "add":
				await this.#handleAdd(text);
				break;
			case "list":
				await this.#handleList();
				break;
			case "remove":
			case "rm":
				await this.#handleRemove(text);
				break;
			case "test":
				await this.#handleTest(parts[2]);
				break;
			case "reauth":
				await this.#handleReauth(parts[2]);
				break;
			case "unauth":
				await this.#handleUnauth(parts[2]);
				break;
			case "enable":
				await this.#handleSetEnabled(parts[2], true);
				break;
			case "disable":
				await this.#handleSetEnabled(parts[2], false);
				break;
			case "resources":
				await this.#handleResources();
				break;
			case "prompts":
				await this.#handlePrompts();
				break;
			case "notifications":
				await this.#handleNotifications();
				break;
			case "smithery-search":
				await this.#handleSearch(text);
				break;
			case "smithery-login":
				await this.#handleSmitheryLogin();
				break;
			case "smithery-logout":
				await this.#handleSmitheryLogout();
				break;
			case "reconnect":
				await this.#handleReconnect(parts[2]);
				break;
			case "reload":
				await this.#handleReload();
				break;
			default:
				this.ctx.showError(`Unknown subcommand: ${subcommand}. Type /mcp help for usage.`);
		}
	}

	/**
	 * Show help text
	 */
	#showHelp(): void {
		const helpText = [
			"",
			theme.bold("MCP Server Management"),
			"",
			"Manage Model Context Protocol (MCP) servers for external tool integrations.",
			"",
			theme.fg("accent", "Commands:"),
			"  /mcp add              Add a new MCP server (interactive wizard)",
			"  /mcp add <name> [--scope project|user] [--url <url> --transport http|sse] [--token <token>] [-- <command...>]",
			"  /mcp list             List all configured MCP servers",
			"  /mcp remove <name> [--scope project|user]    Remove an MCP server (default: project)",
			"  /mcp test <name>      Test connection to an MCP server",
			"  /mcp reauth <name>    Reauthorize OAuth for an MCP server",
			"  /mcp unauth <name>    Remove OAuth auth from an MCP server",
			"  /mcp enable <name>    Enable an MCP server",
			"  /mcp disable <name>   Disable an MCP server",
			"  /mcp smithery-search <keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			"                        Search Smithery registry and deploy from picker",
			"  /mcp smithery-login   Login to Smithery and cache API key",
			"  /mcp smithery-logout  Remove cached Smithery API key",
			"  /mcp reconnect <name> Reconnect to a specific MCP server",
			"  /mcp reload           Force reload and rediscover MCP runtime tools",
			"  /mcp resources        List available resources from connected servers",
			"  /mcp prompts          List available prompts from connected servers",
			"  /mcp notifications    Show notification capabilities and subscription state",
			"  /mcp help             Show this help message",
			"",
		].join("\n");

		this.#showMessage(helpText);
	}

	#parseAddCommand(text: string): MCPAddParsed {
		const prefixMatch = text.match(/^\/mcp\s+add\b\s*(.*)$/i);
		const rest = prefixMatch?.[1]?.trim() ?? "";
		if (!rest) {
			return { scope: "project" };
		}

		const tokens = parseCommandArgs(rest);
		if (tokens.length === 0) {
			return { scope: "project" };
		}

		let name: string | undefined;
		let scope: MCPAddScope = "project";
		let url: string | undefined;
		let transport: MCPAddTransport = "http";
		let authToken: string | undefined;
		let commandTokens: string[] | undefined;

		let i = 0;
		if (!tokens[0].startsWith("-")) {
			name = tokens[0];
			i = 1;
		}

		while (i < tokens.length) {
			const argToken = tokens[i];
			if (argToken === "--") {
				commandTokens = tokens.slice(i + 1);
				break;
			}
			if (argToken === "--scope") {
				const r = readScopeFlag(tokens[i + 1]);
				if (!r.ok) {
					return { scope, error: r.error };
				}
				scope = r.scope;
				i += 2;
				continue;
			}
			if (argToken === "--url") {
				const value = tokens[i + 1];
				if (!value) {
					return { scope, error: "Missing value for --url." };
				}
				url = value;
				i += 2;
				continue;
			}
			if (argToken === "--transport") {
				const value = tokens[i + 1];
				if (!value || (value !== "http" && value !== "sse")) {
					return { scope, error: "Invalid --transport value. Use http or sse." };
				}
				transport = value;
				i += 2;
				continue;
			}
			if (argToken === "--token") {
				const value = tokens[i + 1];
				if (!value) {
					return { scope, error: "Missing value for --token." };
				}
				authToken = value;
				i += 2;
				continue;
			}
			return { scope, error: `Unknown option: ${argToken}` };
		}

		const hasQuick = Boolean(url) || Boolean(commandTokens && commandTokens.length > 0);
		if (!hasQuick) {
			return { scope, initialName: name };
		}
		if (!name) {
			return { scope, error: "Server name required for quick add. Usage: /mcp add <name> ..." };
		}
		if (url && commandTokens && commandTokens.length > 0) {
			return { scope, error: "Use either --url or -- <command...>, not both." };
		}
		if (authToken && !url) {
			return { scope, error: "--token requires --url (HTTP/SSE transport)." };
		}

		if (commandTokens && commandTokens.length > 0) {
			const [command, ...args] = commandTokens;
			const config: MCPServerConfig = {
				type: "stdio",
				command,
				args: args.length > 0 ? args : undefined,
			};
			return { scope, initialName: name, quickConfig: config, isCommandQuickAdd: true };
		}

		const useHttpTransport = transport === "http";
		let normalizedUrl = url!;
		if (!/^https?:\/\//i.test(normalizedUrl)) {
			normalizedUrl = `https://${normalizedUrl}`;
		}
		const config: MCPServerConfig = {
			type: useHttpTransport ? "http" : "sse",
			url: normalizedUrl,
			headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
		};
		return {
			scope,
			initialName: name,
			quickConfig: config,
			isCommandQuickAdd: false,
			hasAuthToken: Boolean(authToken),
		};
	}

	#parseSearchCommand(text: string): MCPSearchParsed {
		const prefixMatch = text.match(/^\/mcp\s+smithery-search\b\s*(.*)$/i);
		const rest = prefixMatch?.[1]?.trim() ?? "";
		const tokens = parseCommandArgs(rest);
		if (tokens.length === 0) {
			return {
				keyword: "",
				scope: "project",
				limit: 20,
				semantic: false,
				error: "Keyword required. Usage: /mcp smithery-search <keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			};
		}

		const keywordParts: string[] = [];
		let scope: MCPAddScope = "project";
		let limit = 20;
		let semantic = false;

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (token === "--scope") {
				const value = tokens[i + 1];
				if (!value || (value !== "project" && value !== "user")) {
					return { keyword: "", scope, limit, semantic, error: "Invalid --scope value. Use project or user." };
				}
				scope = value;
				i++;
				continue;
			}
			if (token === "--limit") {
				const value = tokens[i + 1];
				if (!value) {
					return { keyword: "", scope, limit, semantic, error: "Missing value for --limit." };
				}
				const parsed = Number(value);
				if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
					return {
						keyword: "",
						scope,
						limit,
						semantic,
						error: "Invalid --limit value. Use an integer between 1 and 100.",
					};
				}
				limit = parsed;
				i++;
				continue;
			}
			if (token === "--semantic") {
				semantic = true;
				continue;
			}
			if (token.startsWith("--")) {
				return { keyword: "", scope, limit, semantic, error: `Unknown option: ${token}` };
			}
			keywordParts.push(token);
		}

		const keyword = keywordParts.join(" ").trim();
		if (!keyword) {
			return {
				keyword: "",
				scope,
				limit,
				semantic,
				error: "Keyword required. Usage: /mcp smithery-search <keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			};
		}

		return { keyword, scope, limit, semantic };
	}

	/**
	 * Handle /mcp add - Launch interactive wizard or quick-add from args
	 */
	async #handleAdd(text: string): Promise<void> {
		const parsed = this.#parseAddCommand(text);
		if (parsed.error) {
			this.ctx.showError(parsed.error);
			return;
		}
		if (parsed.quickConfig && parsed.initialName) {
			let finalConfig = parsed.quickConfig;

			// Quick-add with URL should still perform auth detection and OAuth flow,
			// matching wizard behavior. Command quick-add intentionally skips this.
			if (!parsed.isCommandQuickAdd && (finalConfig.type === "http" || finalConfig.type === "sse")) {
				try {
					await this.#handleTestConnection(finalConfig);
				} catch (error) {
					if (parsed.hasAuthToken) {
						this.ctx.showError(
							`Authentication failed for "${parsed.initialName}": ${error instanceof Error ? error.message : String(error)}`,
						);
						return;
					}
					const authResult = analyzeAuthError(error as Error);
					if (authResult.requiresAuth) {
						let oauth = authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;
						if (!oauth && finalConfig.url) {
							try {
								oauth = await discoverOAuthEndpoints(finalConfig.url, authResult.authServerUrl);
							} catch {
								// Ignore discovery error and handle below.
							}
						}

						if (!oauth) {
							this.ctx.showError(
								`Authentication required for "${parsed.initialName}", but OAuth endpoints could not be discovered. ` +
									`Use /mcp add ${parsed.initialName} (wizard) or configure auth manually.`,
							);
							return;
						}

						try {
							const oauthClientSecret = finalConfig.oauth?.clientSecret ?? "";
							const oauthResult = await this.#handleOAuthFlow(
								oauth.authorizationUrl,
								oauth.tokenUrl,
								oauth.clientId ?? finalConfig.oauth?.clientId ?? "",
								oauthClientSecret,
								oauth.scopes ?? "",
								finalConfig.oauth?.callbackPort,
								finalConfig.oauth?.callbackPath,
								finalConfig.oauth?.redirectUri,
							);
							const persistedClientId = oauthResult.clientId ?? oauth.clientId ?? finalConfig.oauth?.clientId;
							const persistedClientSecret = oauthResult.clientSecret ?? finalConfig.oauth?.clientSecret;
							finalConfig = {
								...finalConfig,
								auth: {
									type: "oauth",
									credentialId: oauthResult.credentialId,
									tokenUrl: oauth.tokenUrl,
									clientId: persistedClientId,
									clientSecret: persistedClientSecret,
								},
								oauth: {
									...finalConfig.oauth,
									clientId: persistedClientId ?? finalConfig.oauth?.clientId,
									clientSecret: persistedClientSecret ?? finalConfig.oauth?.clientSecret,
								},
							};
						} catch (oauthError) {
							this.ctx.showError(
								`OAuth flow failed for "${parsed.initialName}": ${oauthError instanceof Error ? oauthError.message : String(oauthError)}`,
							);
							return;
						}
					}
				}
			}

			await this.#handleWizardComplete(parsed.initialName, finalConfig, parsed.scope);
			return;
		}

		// Save current editor state
		const done = () => {
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(this.ctx.editor);
		};

		// Create wizard with OAuth handler and connection test
		const wizard = new MCPAddWizard(
			async (name: string, config: MCPServerConfig, scope: "user" | "project") => {
				done();
				await this.#handleWizardComplete(name, config, scope);
			},
			() => {
				done();
				this.#handleWizardCancel();
			},
			async (authUrl: string, tokenUrl: string, clientId: string, clientSecret: string, scopes: string) => {
				return await this.#handleOAuthFlow(authUrl, tokenUrl, clientId, clientSecret, scopes);
			},
			async (config: MCPServerConfig) => {
				return await this.#handleTestConnection(config);
			},
			() => {
				this.ctx.ui.requestRender();
			},
			parsed.initialName,
		);

		// Replace editor with wizard
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(wizard);
		this.ctx.ui.setFocus(wizard);
		this.ctx.ui.requestRender();
	}

	/**
	 * Handle OAuth authentication flow for MCP server
	 */
	async #handleOAuthFlow(
		authUrl: string,
		tokenUrl: string,
		clientId: string,
		clientSecret: string,
		scopes: string,
		callbackPort?: number,
		callbackPath?: string,
		redirectUri?: string,
	): Promise<OAuthFlowResult> {
		const authStorage = this.ctx.session.modelRegistry.authStorage;
		let parsedAuthUrl: URL;

		// Validate OAuth URLs
		try {
			parsedAuthUrl = new URL(authUrl);
			new URL(tokenUrl);
		} catch (_error) {
			throw new Error(
				`Invalid OAuth URLs. Please check:\n  Authorization URL: ${authUrl}\n  Token URL: ${tokenUrl}`,
			);
		}

		const resolvedClientId = clientId.trim() || parsedAuthUrl.searchParams.get("client_id") || undefined;
		const resolvedClientSecret = clientSecret.trim() || undefined;

		try {
			// Create OAuth flow
			const flow = new MCPOAuthFlow(
				{
					authorizationUrl: authUrl,
					tokenUrl: tokenUrl,
					clientId: resolvedClientId,
					clientSecret: resolvedClientSecret,
					scopes: scopes || undefined,
					redirectUri,
					callbackPort,
					callbackPath,
				},
				{
					onAuth: (info: { url: string; instructions?: string }) => {
						// Show auth URL prominently in chat
						this.ctx.chatContainer.addChild(new Spacer(1));
						this.ctx.chatContainer.addChild(
							new Text(theme.fg("accent", "━━━ OAuth Authorization Required ━━━"), 1, 0),
						);
						this.ctx.chatContainer.addChild(new Spacer(1));
						this.ctx.chatContainer.addChild(
							new Text(theme.fg("muted", "Preparing browser authorization..."), 1, 0),
						);
						this.ctx.chatContainer.addChild(new Spacer(1));
						this.ctx.chatContainer.addChild(
							new Text(
								theme.fg("muted", "Waiting for authorization... (Press Ctrl+C to cancel, 5 minute timeout)"),
								1,
								0,
							),
						);
						this.ctx.chatContainer.addChild(new Spacer(1));
						this.ctx.chatContainer.addChild(
							new Text(theme.fg("accent", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"), 1, 0),
						);
						this.ctx.ui.requestRender();
						// Try to open browser automatically
						try {
							openPath(info.url);

							// Show confirmation that browser should open
							this.ctx.chatContainer.addChild(new Spacer(1));
							this.ctx.chatContainer.addChild(
								new Text(theme.fg("success", "→ Opening browser automatically..."), 1, 0),
							);
							this.ctx.chatContainer.addChild(new Spacer(1));
							this.ctx.chatContainer.addChild(
								new Text(theme.fg("muted", "Alternative if browser did not open:"), 1, 0),
							);
							this.ctx.chatContainer.addChild(
								new Text(theme.fg("success", "Copy this exact URL in your browser:"), 1, 0),
							);
							this.ctx.chatContainer.addChild(new Text(theme.fg("accent", info.url), 1, 0));
							this.ctx.ui.requestRender();
						} catch (_error) {
							// Show error if browser doesn't open
							this.ctx.chatContainer.addChild(new Spacer(1));
							this.ctx.chatContainer.addChild(
								new Text(theme.fg("warning", "→ Could not open browser automatically"), 1, 0),
							);
							this.ctx.chatContainer.addChild(
								new Text(theme.fg("success", "Copy this exact URL in your browser:"), 1, 0),
							);
							this.ctx.chatContainer.addChild(new Text(theme.fg("accent", info.url), 1, 0));
							this.ctx.ui.requestRender();
						}
					},
					onProgress: (message: string) => {
						this.ctx.chatContainer.addChild(new Spacer(1));
						this.ctx.chatContainer.addChild(new Text(theme.fg("muted", message), 1, 0));
						this.ctx.ui.requestRender();
					},
				},
			);

			// Execute OAuth flow with 5 minute timeout
			const credentials = await withTimeout(flow.login(), 5 * 60 * 1000, "OAuth flow timed out after 5 minutes");

			this.ctx.chatContainer.addChild(new Spacer(1));
			this.ctx.chatContainer.addChild(new Text(theme.fg("success", "✓ Authorization completed in browser."), 1, 0));
			this.ctx.ui.requestRender();

			// Generate a unique credential ID
			const credentialId = `mcp_oauth_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

			// Store credentials in auth storage
			const oauthCredential: OAuthCredential = {
				type: "oauth",
				...credentials,
			};

			// Store under a synthetic provider name
			await authStorage.set(credentialId, oauthCredential);

			return {
				credentialId,
				clientId: flow.resolvedClientId,
				clientSecret: flow.registeredClientSecret,
			};
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);

			// Provide helpful error messages based on failure type
			if (errorMsg.includes("timeout") || errorMsg.includes("timed out")) {
				throw new Error("OAuth flow timed out. Please try again.");
			} else if (errorMsg.includes("403") || errorMsg.includes("unauthorized")) {
				throw new Error("OAuth authorization failed. Please check your client credentials.");
			} else if (errorMsg.includes("invalid_grant")) {
				throw new Error("OAuth authorization code is invalid or expired. Please try again.");
			} else if (errorMsg.includes("ECONNREFUSED") || errorMsg.includes("fetch failed")) {
				throw new Error("Could not connect to OAuth server. Please check the URLs and your network connection.");
			} else {
				throw new Error(`OAuth authentication failed: ${errorMsg}`);
			}
		}
	}

	/**
	 * Test connection to an MCP server.
	 * Throws an error if connection fails (used for auto-detection).
	 */
	async #handleTestConnection(config: MCPServerConfig): Promise<void> {
		// Create temporary connection using a test name
		const testName = `test_${Date.now()}`;
		let resolvedConfig: MCPServerConfig;
		if (this.ctx.mcpManager) {
			resolvedConfig = await this.ctx.mcpManager.prepareConfig(config);
		} else {
			const tempManager = new MCPManager(getProjectDir());
			tempManager.setAuthStorage(this.ctx.session.modelRegistry.authStorage);
			resolvedConfig = await tempManager.prepareConfig(config);
		}

		const connection = await connectToServer(testName, resolvedConfig);
		await disconnectServer(connection);
	}

	async #findConfiguredServer(
		name: string,
	): Promise<{ filePath: string; scope: "user" | "project"; config: MCPServerConfig } | null> {
		const cwd = getProjectDir();
		const userPath = getMCPConfigPath("user", cwd);
		const projectPath = getMCPConfigPath("project", cwd);

		const [userConfig, projectConfig] = await Promise.all([
			readMCPConfigFile(userPath),
			readMCPConfigFile(projectPath),
		]);

		if (userConfig.mcpServers?.[name]) {
			return { filePath: userPath, scope: "user", config: userConfig.mcpServers[name] };
		}
		if (projectConfig.mcpServers?.[name]) {
			return { filePath: projectPath, scope: "project", config: projectConfig.mcpServers[name] };
		}

		// Check standalone fallback files (mcp.json, .mcp.json) in the project root —
		// these match the discovery paths used by the mcp-json provider. Reads run in
		// parallel (mirroring user/project above) but precedence is preserved by the
		// for-loop's iteration order: mcp.json wins over .mcp.json on a same-name hit.
		const standalonePaths = [path.join(cwd, "mcp.json"), path.join(cwd, ".mcp.json")];
		const fallbackConfigs = await Promise.all(
			standalonePaths.map(async fallbackPath => {
				try {
					return await readMCPConfigFile(fallbackPath);
				} catch {
					// Malformed JSON in a standalone file — skip and continue lookup.
					return null;
				}
			}),
		);
		for (const [index, fallbackConfig] of fallbackConfigs.entries()) {
			const config = fallbackConfig?.mcpServers?.[name];
			if (config) {
				return { filePath: standalonePaths[index]!, scope: "project", config };
			}
		}
		return null;
	}

	async #removeManagedOAuthCredential(credentialId: string | undefined): Promise<void> {
		if (!credentialId?.startsWith("mcp_oauth_")) return;
		await this.ctx.session.modelRegistry.authStorage.remove(credentialId);
	}

	#stripOAuthAuth(config: MCPServerConfig): MCPServerConfig {
		const next = { ...config } as MCPServerConfig & { auth?: MCPAuthConfig };
		delete next.auth;
		return next;
	}

	async #resolveOAuthEndpointsFromServer(config: MCPServerConfig): Promise<{
		authorizationUrl: string;
		tokenUrl: string;
		clientId?: string;
		scopes?: string;
	}> {
		// First test if server actually needs auth by connecting without OAuth
		let connectionSucceeded = false;
		let connectionError: Error | undefined;
		try {
			await this.#handleTestConnection(this.#stripOAuthAuth(config));
			connectionSucceeded = true;
		} catch (error) {
			connectionError = error as Error;
		}

		// Server connected fine without auth — reauth is not needed
		if (connectionSucceeded) {
			throw new Error("Server connection succeeded without OAuth; reauthorization is not required.");
		}

		// Analyze the connection error to extract OAuth endpoints
		const authResult = analyzeAuthError(connectionError!);
		let oauth = authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;

		if (!oauth && (config.type === "http" || config.type === "sse") && config.url) {
			oauth = await discoverOAuthEndpoints(config.url, authResult.authServerUrl);
		}

		if (!oauth) {
			throw new Error("Could not discover OAuth endpoints from server response.");
		}

		return oauth;
	}

	async #waitForServerConnectionWithAnimation(
		name: string,
		options?: { suppressDisconnectedWarning?: boolean },
	): Promise<"connected" | "connecting" | "disconnected"> {
		if (!this.ctx.mcpManager) return "disconnected";

		this.ctx.chatContainer.addChild(new Spacer(1));
		const frames = theme.spinnerFrames;
		const initialFrame = frames[0] ?? "|";
		const statusText = new Text(theme.fg("muted", `${initialFrame} Connecting to "${name}"...`), 1, 0);
		this.ctx.chatContainer.addChild(statusText);
		this.ctx.ui.requestRender();

		let frame = 0;
		const interval = setInterval(() => {
			statusText.setText(theme.fg("muted", `${frames[frame % frames.length]} Connecting to "${name}"...`));
			frame++;
			this.ctx.ui.requestRender();
		}, 80);

		try {
			try {
				await withTimeout(this.ctx.mcpManager.waitForConnection(name), 10_000, "Connection still pending");
			} catch {
				// Ignore timeout/errors here and use status check below.
			}
			const state = this.ctx.mcpManager.getConnectionStatus(name);
			if (state === "connected") {
				// Connection may complete after initial reload; rebind runtime MCP tools now.
				await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
			}
			if (state === "connected") {
				statusText.setText(theme.fg("success", `✓ Connected to "${name}"`));
			} else if (state === "connecting") {
				statusText.setText(theme.fg("muted", `◌ "${name}" is still connecting...`));
			} else {
				statusText.setText(
					options?.suppressDisconnectedWarning
						? theme.fg("muted", `◌ Connection check complete for "${name}"`)
						: theme.fg("warning", `⚠ Could not connect to "${name}" yet`),
				);
			}
			this.ctx.ui.requestRender();
			return state;
		} finally {
			clearInterval(interval);
		}
	}

	async #syncManagerConnection(name: string, config: MCPServerConfig): Promise<void> {
		if (!this.ctx.mcpManager) return;
		if (this.ctx.mcpManager.getConnectionStatus(name) !== "disconnected") return;
		await this.ctx.mcpManager.connectServers({ [name]: config }, {});
		if (this.ctx.mcpManager.getConnectionStatus(name) === "connected") {
			await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
		}
	}

	async #handleWizardComplete(name: string, config: MCPServerConfig, scope: "user" | "project"): Promise<void> {
		try {
			// Determine file path
			const cwd = getProjectDir();
			const filePath = getMCPConfigPath(scope, cwd);

			// Add server to config
			await addMCPServer(filePath, name, config);

			// Reload MCP manager
			await this.#reloadMCP();
			const state =
				config.enabled === false
					? "disconnected"
					: await this.#waitForServerConnectionWithAnimation(name, { suppressDisconnectedWarning: true });
			let isConnected = state === "connected";
			const isConnecting = state === "connecting";

			// Fallback: if manager state is still disconnected but direct test works,
			// report as connected to avoid false-negative messaging.
			if (!isConnected && !isConnecting && config.enabled !== false) {
				try {
					await this.#handleTestConnection(config);
					isConnected = true;
					await this.#syncManagerConnection(name, config);
				} catch {
					// Keep disconnected status
				}
			}

			// refreshMCPTools preserves the prior MCP tool selection, so tools from
			// brand-new servers are registered in the registry but never activated.
			// Explicitly activate the newly added server's tools now.
			if (isConnected && this.ctx.mcpManager) {
				const serverTools = this.ctx.mcpManager.getTools().filter(t => t.mcpServerName === name);
				if (serverTools.length > 0) {
					const currentActive = this.ctx.session.getActiveToolNames();
					const toActivate = serverTools.map(t => t.name).filter(n => this.ctx.session.getToolByName(n));
					if (toActivate.length > 0) {
						await this.ctx.session.setActiveToolsByName([...new Set([...currentActive, ...toActivate])]);
					}
				}
			}

			// Show success message
			const scopeLabel = scope === "user" ? "user" : "project";
			const lines = ["", theme.fg("success", `✓ Added server "${name}" to ${scopeLabel} config`), ""];

			if (isConnected) {
				lines.push(theme.fg("success", `✓ Successfully connected to server`));
				lines.push("");
			} else if (isConnecting) {
				lines.push(theme.fg("muted", `◌ Server is connecting in background...`));
				lines.push(theme.fg("muted", `  Run ${theme.fg("accent", `/mcp test ${name}`)} in a few seconds.`));
				lines.push("");
			} else {
				lines.push(theme.fg("warning", `⚠ Server added but not yet connected`));
				lines.push(theme.fg("muted", `  Run ${theme.fg("accent", `/mcp test ${name}`)} to test the connection.`));
				lines.push("");
			}

			lines.push(theme.fg("muted", `Run ${theme.fg("accent", "/mcp list")} to see all configured servers.`));
			lines.push("");

			this.#showMessage(lines.join("\n"));
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);

			// Provide helpful error messages
			let helpText = "";
			if (errorMsg.includes("EACCES") || errorMsg.includes("permission denied")) {
				helpText = "\n\nTip: Check file permissions for the config directory.";
			} else if (errorMsg.includes("ENOSPC")) {
				helpText = "\n\nTip: Insufficient disk space.";
			} else if (errorMsg.includes("already exists")) {
				helpText = `\n\nTip: Use ${theme.fg("accent", "/mcp list")} to see existing servers.`;
			}

			this.ctx.showError(`Failed to add server: ${errorMsg}${helpText}`);
		}
	}

	#handleWizardCancel(): void {
		this.#showMessage(
			[
				"",
				theme.fg("muted", "Server creation cancelled."),
				"",
				theme.fg("dim", "Tip: Press Ctrl+C or Esc anytime to cancel"),
				"",
			].join("\n"),
		);
	}

	/**
	 * Handle /mcp list - Show all configured servers
	 */
	async #handleList(): Promise<void> {
		try {
			const cwd = getProjectDir();

			// Load from both user and project configs
			const userPath = getMCPConfigPath("user", cwd);
			const projectPath = getMCPConfigPath("project", cwd);

			const userPathLabel = shortenPath(userPath);
			const projectPathLabel = shortenPath(projectPath);
			const [userConfig, projectConfig] = await Promise.all([
				readMCPConfigFile(userPath),
				readMCPConfigFile(projectPath),
			]);

			const userServers = Object.keys(userConfig.mcpServers ?? {});
			const projectServers = Object.keys(projectConfig.mcpServers ?? {});

			// Collect runtime-discovered servers not in config files
			const configServerNames = new Set([...userServers, ...projectServers]);
			const disabledServerNames = new Set(await readDisabledServers(userPath));
			const discoveredServers: { name: string; source: SourceMeta }[] = [];
			if (this.ctx.mcpManager) {
				for (const name of this.ctx.mcpManager.getAllServerNames()) {
					if (configServerNames.has(name)) continue;
					if (disabledServerNames.has(name)) continue;
					const source = this.ctx.mcpManager.getSource(name);
					if (source) {
						discoveredServers.push({ name, source });
					}
				}
			}

			if (
				userServers.length === 0 &&
				projectServers.length === 0 &&
				discoveredServers.length === 0 &&
				disabledServerNames.size === 0
			) {
				this.#showMessage(
					[
						"",
						theme.fg("muted", "No MCP servers configured."),
						"",
						`Use ${theme.fg("accent", "/mcp add")} to add a server.`,
						"",
					].join("\n"),
				);
				return;
			}

			const lines: string[] = ["", theme.bold("Configured MCP Servers"), ""];

			// Show user-level servers
			if (userServers.length > 0) {
				lines.push(theme.fg("accent", "User level") + theme.fg("muted", ` (${userPathLabel}):`));
				for (const name of userServers) {
					const config = userConfig.mcpServers![name];
					const type = config.type ?? "stdio";
					const state =
						config.enabled === false
							? "inactive"
							: (this.ctx.mcpManager?.getConnectionStatus(name) ?? "disconnected");
					const status =
						state === "inactive"
							? theme.fg("warning", " ◌ inactive")
							: state === "connected"
								? theme.fg("success", " ● connected")
								: state === "connecting"
									? theme.fg("muted", " ◌ connecting")
									: theme.fg("muted", " ○ not connected");
					lines.push(`  ${theme.fg("accent", name)}${status} ${theme.fg("dim", `[${type}]`)}`);
				}
				lines.push("");
			}

			// Show project-level servers
			if (projectServers.length > 0) {
				lines.push(theme.fg("accent", "Project level") + theme.fg("muted", ` (${projectPathLabel}):`));
				for (const name of projectServers) {
					const config = projectConfig.mcpServers![name];
					const type = config.type ?? "stdio";
					const state =
						config.enabled === false
							? "inactive"
							: (this.ctx.mcpManager?.getConnectionStatus(name) ?? "disconnected");
					const status =
						state === "inactive"
							? theme.fg("warning", " ◌ inactive")
							: state === "connected"
								? theme.fg("success", " ● connected")
								: state === "connecting"
									? theme.fg("muted", " ◌ connecting")
									: theme.fg("muted", " ○ not connected");
					lines.push(`  ${theme.fg("accent", name)}${status} ${theme.fg("dim", `[${type}]`)}`);
				}
				lines.push("");
			}

			// Show discovered servers (from .Anthropic model.json, .cursor/mcp.json, .vscode/mcp.json, etc.)
			if (discoveredServers.length > 0) {
				for (const { providerName, shortPath, items: entries } of groupBySource(discoveredServers, e => e.source)) {
					lines.push(theme.fg("accent", providerName) + theme.fg("muted", ` (${shortPath}):`));
					for (const { name } of entries) {
						const state = this.ctx.mcpManager!.getConnectionStatus(name);
						const status =
							state === "connected"
								? theme.fg("success", " ● connected")
								: state === "connecting"
									? theme.fg("muted", " ◌ connecting")
									: theme.fg("muted", " ○ not connected");
						lines.push(`  ${theme.fg("accent", name)}${status}`);
					}
					lines.push("");
				}
			}

			// Show servers disabled via /mcp disable (from third-party configs)
			const relevantDisabled = [...disabledServerNames].filter(n => !configServerNames.has(n));
			if (relevantDisabled.length > 0) {
				lines.push(theme.fg("accent", "Disabled") + theme.fg("muted", " (discovered servers):"));
				for (const name of relevantDisabled) {
					lines.push(`  ${theme.fg("accent", name)}${theme.fg("warning", " ◌ disabled")}`);
				}
				lines.push("");
			}
			this.#showMessage(lines.join("\n"));
		} catch (error) {
			this.ctx.showError(`Failed to list servers: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Handle /mcp remove <name> - Remove a server
	 */
	async #handleRemove(text: string): Promise<void> {
		const match = text.match(/^\/mcp\s+(?:remove|rm)\b\s*(.*)$/i);
		const rest = match?.[1]?.trim() ?? "";
		const parsed = parseRemoveArgs(rest);
		if (!parsed.ok) {
			this.ctx.showError(parsed.error);
			return;
		}
		const { name, scope } = parsed.value;

		if (!name) {
			this.ctx.showError("Server name required. Usage: /mcp remove <name> [--scope project|user]");
			return;
		}

		try {
			const cwd = getProjectDir();
			const userPath = getMCPConfigPath("user", cwd);
			const projectPath = getMCPConfigPath("project", cwd);
			const filePath = scope === "user" ? userPath : projectPath;
			const config = await readMCPConfigFile(filePath);
			if (!config.mcpServers?.[name]) {
				this.ctx.showError(`Server "${name}" not found in ${scope} config.`);
				return;
			}

			// Disconnect if connected
			if (this.ctx.mcpManager?.getConnection(name)) {
				await this.ctx.mcpManager.disconnectServer(name);
			}

			// Remove from config
			await removeMCPServer(filePath, name);

			// Reload MCP manager
			await this.#reloadMCP();

			this.#showMessage(["", theme.fg("success", `✓ Removed server "${name}" from ${scope} config`), ""].join("\n"));
		} catch (error) {
			this.ctx.showError(`Failed to remove server: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Handle /mcp test <name> - Test connection to a server
	 */
	async #handleTest(name: string | undefined): Promise<void> {
		if (!name) {
			this.ctx.showError("Server name required. Usage: /mcp test <name>");
			return;
		}

		const originalOnEscape = this.ctx.editor.onEscape;
		const abortController = new AbortController();
		this.ctx.editor.onEscape = () => {
			abortController.abort();
		};

		let connection: MCPServerConnection | undefined;
		try {
			const found = await this.#findConfiguredServer(name);

			if (!found) {
				this.ctx.showError(
					`Server "${name}" not found.\n\nTip: Run ${theme.fg("accent", "/mcp list")} to see available servers.`,
				);
				return;
			}

			const { config } = found;
			if (config.enabled === false) {
				this.ctx.showError(`Server "${name}" is disabled. Run /mcp enable ${name} first.`);
				return;
			}

			this.#showMessage(
				["", theme.fg("muted", `Testing connection to "${name}"... (esc to cancel)`), ""].join("\n"),
			);

			// Resolve auth config if needed
			let resolvedConfig: MCPServerConfig;
			if (this.ctx.mcpManager) {
				resolvedConfig = await this.ctx.mcpManager.prepareConfig(config);
			} else {
				const tempManager = new MCPManager(getProjectDir());
				tempManager.setAuthStorage(this.ctx.session.modelRegistry.authStorage);
				resolvedConfig = await tempManager.prepareConfig(config);
			}

			// Create temporary connection
			connection = await connectToServer(name, resolvedConfig, { signal: abortController.signal });

			// List tools to verify connection
			const tools = await listTools(connection, { signal: abortController.signal });

			const lines = [
				"",
				theme.fg("success", `✓ Successfully connected to "${name}"`),
				"",
				`  Server: ${connection.serverInfo.name} v${connection.serverInfo.version}`,
				`  Tools: ${tools.length}`,
			];

			// Show tool names if there are any
			if (tools.length > 0 && tools.length <= 10) {
				lines.push("");
				lines.push("  Available tools:");
				for (const tool of tools) {
					lines.push(`    • ${tool.name}`);
				}
			}

			lines.push("");
			await this.#syncManagerConnection(name, config);
			this.#showMessage(lines.join("\n"));
		} catch (error) {
			if (abortController.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
				this.ctx.showStatus(`Cancelled MCP test for "${name}"`);
				return;
			}

			const errorMsg = error instanceof Error ? error.message : String(error);

			// Provide helpful error messages
			let helpText = "";
			if (errorMsg.includes("ENOENT") || errorMsg.includes("not found")) {
				helpText = "\n\nTip: Check that the command or URL is correct.";
			} else if (errorMsg.includes("EACCES")) {
				helpText = "\n\nTip: Check file/command permissions.";
			} else if (errorMsg.includes("ECONNREFUSED")) {
				helpText = "\n\nTip: Check that the server is running and the URL/port is correct.";
			} else if (errorMsg.includes("timeout")) {
				helpText = "\n\nTip: The server may be slow or unresponsive. Try increasing the timeout.";
			} else if (errorMsg.includes("401") || errorMsg.includes("403")) {
				helpText = "\n\nTip: Check your authentication credentials.";
			}

			this.ctx.showError(`Failed to connect to "${name}": ${errorMsg}${helpText}`);
		} finally {
			this.ctx.editor.onEscape = originalOnEscape;
			if (connection) {
				// Best-effort: don't block UI on cleanup.
				void disconnectServer(connection);
			}
		}
	}

	async #handleSetEnabled(name: string | undefined, enabled: boolean): Promise<void> {
		if (!name) {
			this.ctx.showError(`Server name required. Usage: /mcp ${enabled ? "enable" : "disable"} <name>`);
			return;
		}

		try {
			const found = await this.#findConfiguredServer(name);
			if (!found) {
				// Check if this is a discovered server from a third-party config
				const userConfigPath = getMCPConfigPath("user", getProjectDir());
				const disabledServers = new Set(await readDisabledServers(userConfigPath));
				const isDiscovered = this.ctx.mcpManager?.getSource(name);
				const isCurrentlyDisabled = disabledServers.has(name);
				if (!isDiscovered && !isCurrentlyDisabled) {
					this.ctx.showError(`Server "${name}" not found.`);
					return;
				}
				if (isCurrentlyDisabled === !enabled) {
					this.#showMessage(
						["", theme.fg("muted", `Server "${name}" is already ${enabled ? "enabled" : "disabled"}.`), ""].join(
							"\n",
						),
					);
					return;
				}
				await setServerDisabled(userConfigPath, name, !enabled);
				if (enabled) {
					await this.#reloadMCP();
					const state = await this.#waitForServerConnectionWithAnimation(name);
					const status =
						state === "connected"
							? theme.fg("success", "Connected")
							: state === "connecting"
								? theme.fg("muted", "Connecting")
								: theme.fg("warning", "Not connected yet");
					this.#showMessage(
						["", theme.fg("success", `✓ Enabled "${name}"`), "", `  Status: ${status}`, ""].join("\n"),
					);
				} else {
					await this.ctx.mcpManager?.disconnectServer(name);
					await this.ctx.session.refreshMCPTools(this.ctx.mcpManager?.getTools() ?? []);
					this.#showMessage(["", theme.fg("success", `✓ Disabled "${name}"`), ""].join("\n"));
				}
				return;
			}

			if ((found.config.enabled ?? true) === enabled) {
				this.#showMessage(
					["", theme.fg("muted", `Server "${name}" is already ${enabled ? "enabled" : "disabled"}.`), ""].join(
						"\n",
					),
				);
				return;
			}

			const updated: MCPServerConfig = { ...found.config, enabled };
			await updateMCPServer(found.filePath, name, updated);
			await this.#reloadMCP();

			let status = "";
			if (enabled) {
				const state = await this.#waitForServerConnectionWithAnimation(name);
				status =
					state === "connected"
						? theme.fg("success", "Connected")
						: state === "connecting"
							? theme.fg("muted", "Connecting")
							: theme.fg("warning", "Not connected yet");
			}

			const lines = [
				"",
				theme.fg("success", `✓ ${enabled ? "Enabled" : "Disabled"} "${name}" (${found.scope} config)`),
			];
			if (status) {
				lines.push("");
				lines.push(`  Status: ${status}`);
			}
			lines.push("");
			this.#showMessage(lines.join("\n"));
		} catch (error) {
			this.ctx.showError(
				`Failed to ${enabled ? "enable" : "disable"} server: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async #handleUnauth(name: string | undefined): Promise<void> {
		if (!name) {
			this.ctx.showError("Server name required. Usage: /mcp unauth <name>");
			return;
		}

		try {
			const found = await this.#findConfiguredServer(name);
			if (!found) {
				this.ctx.showError(`Server "${name}" not found.`);
				return;
			}

			const currentAuth = (found.config as MCPServerConfig & { auth?: MCPAuthConfig }).auth;
			if (currentAuth?.type === "oauth") {
				await this.#removeManagedOAuthCredential(currentAuth.credentialId);
			}

			const updated = this.#stripOAuthAuth(found.config);
			await updateMCPServer(found.filePath, name, updated);
			await this.#reloadMCP();

			this.#showMessage(
				["", theme.fg("success", `✓ Cleared auth for "${name}" (${found.scope} config)`), ""].join("\n"),
			);
		} catch (error) {
			this.ctx.showError(`Failed to clear auth: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #handleReauth(name: string | undefined): Promise<void> {
		if (!name) {
			this.ctx.showError("Server name required. Usage: /mcp reauth <name>");
			return;
		}

		try {
			const found = await this.#findConfiguredServer(name);
			if (!found) {
				this.ctx.showError(`Server "${name}" not found.`);
				return;
			}

			if (found.config.enabled === false) {
				this.ctx.showError(`Server "${name}" is disabled. Run /mcp enable ${name} first.`);
				return;
			}

			const currentAuth = (found.config as MCPServerConfig & { auth?: MCPAuthConfig }).auth;
			if (currentAuth?.type === "oauth") {
				await this.#removeManagedOAuthCredential(currentAuth.credentialId);
			}

			const baseConfig = this.#stripOAuthAuth(found.config);
			const oauth = await this.#resolveOAuthEndpointsFromServer(baseConfig);
			const oauthClientSecret = found.config.oauth?.clientSecret ?? currentAuth?.clientSecret ?? "";

			this.#showMessage(["", theme.fg("muted", `Reauthorizing "${name}"...`), ""].join("\n"));

			const oauthResult = await this.#handleOAuthFlow(
				oauth.authorizationUrl,
				oauth.tokenUrl,
				oauth.clientId ?? found.config.oauth?.clientId ?? "",
				oauthClientSecret,
				oauth.scopes ?? "",
				found.config.oauth?.callbackPort,
				found.config.oauth?.callbackPath,
				found.config.oauth?.redirectUri,
			);

			const persistedClientId = oauthResult.clientId ?? oauth.clientId ?? found.config.oauth?.clientId;
			const persistedClientSecret = oauthResult.clientSecret ?? (oauthClientSecret || undefined);

			const updated: MCPServerConfig = {
				...baseConfig,
				auth: {
					type: "oauth",
					credentialId: oauthResult.credentialId,
					tokenUrl: oauth.tokenUrl,
					clientId: persistedClientId,
					clientSecret: persistedClientSecret,
				},
				oauth: {
					...found.config.oauth,
					clientId: persistedClientId ?? found.config.oauth?.clientId,
					clientSecret: persistedClientSecret ?? found.config.oauth?.clientSecret,
				},
			};
			await updateMCPServer(found.filePath, name, updated);
			await this.#reloadMCP();
			const state = await this.#waitForServerConnectionWithAnimation(name);

			const lines = [
				"",
				theme.fg("success", `✓ Reauthorized "${name}" (${found.scope} config)`),
				"",
				`  Status: ${
					state === "connected"
						? theme.fg("success", "connected")
						: state === "connecting"
							? theme.fg("muted", "connecting")
							: theme.fg("warning", "not connected")
				}`,
				"",
			];
			this.#showMessage(lines.join("\n"));
		} catch (error) {
			this.ctx.showError(`Failed to reauthorize server: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #handleReload(): Promise<void> {
		try {
			this.#showMessage(["", theme.fg("muted", "Reloading MCP servers and runtime tools..."), ""].join("\n"));
			await this.#reloadMCP();
			const connectedCount = this.ctx.mcpManager?.getConnectedServers().length ?? 0;
			this.#showMessage(
				["", theme.fg("success", "✓ MCP reload complete"), `  Connected servers: ${connectedCount}`, ""].join("\n"),
			);
		} catch (error) {
			this.ctx.showError(`Failed to reload MCP: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Handle /mcp reconnect <name> - Reconnect to a specific server.
	 */
	async #handleReconnect(name: string | undefined): Promise<void> {
		if (!name) {
			this.ctx.showError("Server name required. Usage: /mcp reconnect <name>");
			return;
		}
		if (!this.ctx.mcpManager) {
			this.ctx.showError("MCP manager not available.");
			return;
		}

		this.#showMessage(["", theme.fg("muted", `Reconnecting to "${name}"...`), ""].join("\n"));

		try {
			const connection = await this.ctx.mcpManager.reconnectServer(name);
			if (connection) {
				// refreshMCPTools re-registers tools and preserves the user's prior
				// MCP tool selection. No need to call activateDiscoveredMCPTools —
				// that would broaden the selection to all server tools.
				await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
				const serverTools = this.ctx.mcpManager.getTools().filter(t => t.mcpServerName === name);
				this.#showMessage(
					["\n", theme.fg("success", `✓ Reconnected to "${name}"`), `  Tools: ${serverTools.length}`, "\n"].join(
						"\n",
					),
				);
			} else {
				this.ctx.showError(`Failed to reconnect to "${name}". Check server status and logs.`);
			}
		} catch (error) {
			this.ctx.showError(
				`Failed to reconnect to "${name}": ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Reload MCP manager with new configs
	 */
	async #reloadMCP(): Promise<void> {
		if (!this.ctx.mcpManager) {
			return;
		}
		if (this.ctx.mcpManager.isConnectionSetSealed()) {
			throw new Error("This session's plugin-bundle MCP connections are fixed for its lifetime.");
		}

		// Disconnect all existing servers
		await this.ctx.mcpManager.disconnectAll();

		// Rediscover and connect
		const result = await this.ctx.mcpManager.discoverAndConnect();
		await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());

		// Show any connection errors
		if (result.errors.size > 0) {
			const errorLines = ["", theme.fg("warning", "Some servers failed to connect:"), ""];
			for (const [serverName, error] of result.errors.entries()) {
				errorLines.push(`  ${serverName}: ${error}`);
			}
			errorLines.push("");
			this.#showMessage(errorLines.join("\n"));
		}
	}

	/**
	 * Handle /mcp resources - Show available resources from connected servers
	 */
	async #handleResources(): Promise<void> {
		if (!this.ctx.mcpManager) {
			this.ctx.showError("No MCP manager available.");
			return;
		}

		const servers = this.ctx.mcpManager.getConnectedServers();
		const lines: string[] = ["", theme.bold("MCP Resources"), ""];
		let hasAny = false;

		for (const name of servers) {
			const data = this.ctx.mcpManager.getServerResources(name);
			if (!data) continue;
			const { resources, templates } = data;
			if (resources.length === 0 && templates.length === 0) continue;
			hasAny = true;

			lines.push(`${theme.fg("accent", name)}:`);
			for (const r of resources) {
				const desc = r.description ? ` ${theme.fg("dim", r.description)}` : "";
				const mime = r.mimeType ? ` ${theme.fg("dim", `[${r.mimeType}]`)}` : "";
				lines.push(`  ${theme.fg("success", r.uri)}${mime}${desc}`);
			}
			if (templates.length > 0) {
				lines.push(`  ${theme.fg("muted", "Templates:")}`);
				for (const t of templates) {
					const desc = t.description ? ` ${theme.fg("dim", t.description)}` : "";
					lines.push(`    ${theme.fg("accent", t.uriTemplate)}${desc}`);
				}
			}
			lines.push("");
		}

		if (!hasAny) {
			lines.push(theme.fg("muted", "No resources available on connected servers."));
			lines.push("");
		}
		this.#showMessage(lines.join("\n"));
	}

	/**
	 * Handle /mcp prompts - Show available prompts from connected servers
	 */
	async #handlePrompts(): Promise<void> {
		if (!this.ctx.mcpManager) {
			this.ctx.showError("No MCP manager available.");
			return;
		}

		const servers = this.ctx.mcpManager.getConnectedServers();
		const lines: string[] = ["", theme.bold("MCP Prompts"), ""];
		let hasAny = false;

		for (const name of servers) {
			const prompts = this.ctx.mcpManager.getServerPrompts(name);
			if (!prompts?.length) continue;
			hasAny = true;

			lines.push(`${theme.fg("accent", name)}:`);
			for (const p of prompts) {
				const commandName = `${name}:${p.name}`;
				const desc = p.description ? ` ${theme.fg("dim", p.description)}` : "";
				lines.push(`  ${theme.fg("success", `/${commandName}`)}${desc}`);
				if (p.arguments?.length) {
					for (const arg of p.arguments) {
						const required = arg.required ? theme.fg("warning", " *") : "";
						const argDesc = arg.description ? ` - ${arg.description}` : "";
						lines.push(`    ${arg.name}=${required}${theme.fg("dim", argDesc)}`);
					}
				}
			}
			lines.push("");
		}

		if (!hasAny) {
			lines.push(theme.fg("muted", "No prompts available on connected servers."));
			lines.push("");
		}
		this.#showMessage(lines.join("\n"));
	}

	/**
	 * Handle /mcp notifications - Show notification and subscription state
	 */
	async #handleNotifications(): Promise<void> {
		if (!this.ctx.mcpManager) {
			this.ctx.showError("No MCP manager available.");
			return;
		}

		const { enabled, subscriptions } = this.ctx.mcpManager.getNotificationState();
		const servers = this.ctx.mcpManager.getConnectedServers();
		const statusIcon = enabled ? theme.fg("success", "enabled") : theme.fg("warning", "disabled");
		const lines: string[] = ["", theme.bold("MCP Notifications"), ""];
		lines.push(`  Status: ${statusIcon}  ${theme.fg("dim", "(mcp.notifications setting)")}`);
		lines.push("");

		let hasAny = false;
		for (const name of servers) {
			const connection = this.ctx.mcpManager.getConnection(name);
			if (!connection) continue;
			const caps = connection.capabilities;
			const supportsResources = caps.resources !== undefined;
			const supportsSubscribe = caps.resources?.subscribe === true;
			const supportsToolsChanged = caps.tools?.listChanged === true;
			const supportsPromptsChanged = caps.prompts?.listChanged === true;
			const supportsResourcesChanged = caps.resources?.listChanged === true;

			const hasNotifications =
				supportsToolsChanged || supportsPromptsChanged || supportsResourcesChanged || supportsSubscribe;
			if (!hasNotifications) continue;
			hasAny = true;

			lines.push(`${theme.fg("accent", name)}:`);
			const check = theme.fg("success", "✓");
			const cross = theme.fg("dim", "✗");
			if (supportsToolsChanged) lines.push(`  ${check} tools/list_changed`);
			if (supportsResourcesChanged) lines.push(`  ${check} resources/list_changed`);
			if (supportsPromptsChanged) lines.push(`  ${check} prompts/list_changed`);

			if (supportsSubscribe) {
				const subscribedUris = subscriptions.get(name);
				const subCount = subscribedUris?.size ?? 0;
				const subStatus =
					enabled && subCount > 0
						? theme.fg("success", `subscribed (${subCount} URI${subCount !== 1 ? "s" : ""})`)
						: enabled
							? theme.fg("muted", "no active subscriptions")
							: theme.fg("dim", "inactive (notifications disabled)");
				lines.push(`  ${check} resources/subscribe  ${subStatus}`);
				if (enabled && subscribedUris && subscribedUris.size > 0) {
					for (const uri of subscribedUris) {
						lines.push(`    ${theme.fg("success", "✓")} ${theme.fg("dim", uri)}`);
					}
				}
			} else if (supportsResources) {
				lines.push(`  ${cross} resources/subscribe  ${theme.fg("dim", "not supported")}`);
			}
			lines.push("");
		}

		if (!hasAny) {
			lines.push(theme.fg("muted", "No servers support notifications."));
			lines.push("");
		}
		this.#showMessage(lines.join("\n"));
	}

	async #validateSmitheryApiKey(apiKey: string): Promise<void> {
		await searchSmitheryRegistry("mcp", { limit: 1, apiKey });
	}

	async #promptSmitheryApiKey(promptLabel: string): Promise<string | null> {
		for (;;) {
			const input = await this.ctx.showHookInput(promptLabel);
			if (input === undefined) return null;
			const apiKey = input.trim();
			if (!apiKey) {
				this.ctx.showError("Smithery API key cannot be empty.");
				continue;
			}
			try {
				await this.#validateSmitheryApiKey(apiKey);
				return apiKey;
			} catch (error) {
				this.ctx.showError(
					`Smithery API key validation failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	async #handleSmitheryLoginWithApiKey(): Promise<boolean> {
		const apiKey = await this.#promptSmitheryApiKey("Smithery API key (Esc to cancel)");
		if (!apiKey) return false;
		await saveSmitheryApiKey(apiKey);
		this.ctx.showStatus("Smithery API key saved.");
		return true;
	}

	async #waitForSmitheryCliApiKey(sessionId: string, signal: AbortSignal): Promise<string> {
		const pollIntervalMs = 2_000;
		const timeoutMs = 300_000;
		const startedAt = Date.now();

		while (!signal.aborted) {
			if (Date.now() - startedAt >= timeoutMs) {
				throw new Error("Smithery authorization timed out after 5 minutes.");
			}
			const response = await pollSmitheryCliAuthSession(sessionId, signal);
			if (response.status === "success" && response.apiKey) {
				return response.apiKey;
			}
			if (response.status === "error") {
				throw new Error(response.message ?? "Smithery authorization failed.");
			}
			await Bun.sleep(pollIntervalMs);
		}

		throw new Error("Smithery authorization cancelled.");
	}

	async #handleSmitheryBrowserLogin(): Promise<boolean> {
		const session = await createSmitheryCliAuthSession();
		const fallbackLoginUrl = getSmitheryLoginUrl();
		this.#showMessage(
			[
				"",
				theme.bold("Smithery Login"),
				theme.fg("muted", "Browser authorization started. Complete auth in your browser."),
				theme.fg("dim", "Authorize URL:"),
				theme.fg("accent", session.authUrl),
				theme.fg("dim", `Fallback: ${fallbackLoginUrl}`),
				"",
			].join("\n"),
		);
		try {
			openPath(session.authUrl);
		} catch {
			// URL is already shown above.
		}

		const apiKey = await this.#waitForSmitheryCliApiKey(session.sessionId, new AbortController().signal);
		await this.#validateSmitheryApiKey(apiKey);
		await saveSmitheryApiKey(apiKey);
		this.ctx.showStatus("Smithery API key saved.");
		return true;
	}

	async #promptSmitheryLogin(reason: string): Promise<boolean> {
		this.#showMessage(
			[
				"",
				theme.fg("muted", `Smithery authentication required (${reason}).`),
				theme.fg("muted", "If browser auth fails, you can paste an API key."),
				"",
			].join("\n"),
		);
		try {
			return await this.#handleSmitheryBrowserLogin();
		} catch (error) {
			this.ctx.showWarning(
				`Browser authorization failed: ${error instanceof Error ? error.message : String(error)}. Falling back to API key.`,
			);
			return await this.#handleSmitheryLoginWithApiKey();
		}
	}

	#getSmitheryErrorStatus(error: unknown): number | undefined {
		if (error instanceof SmitheryRegistryError || error instanceof SmitheryConnectError) {
			return error.status;
		}
		return undefined;
	}

	#toSmitheryAuthReason(status: number): string {
		return status === 429 ? "rate limited by Smithery" : "forbidden/unauthorized with Smithery";
	}

	async #requireSmitheryApiKey(reason: string): Promise<string> {
		let apiKey = await getSmitheryApiKey();
		if (apiKey) return apiKey;

		const loggedIn = await this.#promptSmitheryLogin(reason);
		if (!loggedIn) {
			throw new Error("Smithery login cancelled. Run /mcp smithery-login, then retry /mcp smithery-search.");
		}

		apiKey = await getSmitheryApiKey();
		if (!apiKey) {
			throw new Error("Smithery API key not found after login.");
		}
		return apiKey;
	}

	async #runSmitheryOperationWithAuthRetry<T>(operation: (apiKey: string) => Promise<T>, reason: string): Promise<T> {
		const apiKey = await this.#requireSmitheryApiKey(reason);
		try {
			return await operation(apiKey);
		} catch (error) {
			const status = this.#getSmitheryErrorStatus(error);
			if (status === undefined || ![401, 403, 429].includes(status)) {
				throw error;
			}
			const loggedIn = await this.#promptSmitheryLogin(this.#toSmitheryAuthReason(status));
			if (!loggedIn) {
				throw error;
			}
			const retryApiKey = await this.#requireSmitheryApiKey(reason);
			return await operation(retryApiKey);
		}
	}

	async #handleSmitheryLogin(): Promise<void> {
		const ok = await this.#promptSmitheryLogin("login");
		if (!ok) {
			this.ctx.showStatus("Smithery login cancelled.");
		}
	}

	async #handleSmitheryLogout(): Promise<void> {
		const removed = await clearSmitheryApiKey();
		this.ctx.showStatus(removed ? "Smithery API key removed." : "No cached Smithery API key found.");
	}

	async #nextAvailableServerName(scope: MCPAddScope, baseName: string): Promise<string> {
		const filePath = getMCPConfigPath(scope, getProjectDir());
		const config = await readMCPConfigFile(filePath);
		const existingNames = new Set(Object.keys(config.mcpServers ?? {}));
		if (!existingNames.has(baseName)) return baseName;
		for (let i = 2; i <= 999; i++) {
			const candidate = `${baseName}-${i}`;
			if (!existingNames.has(candidate)) return candidate;
		}
		return `${baseName}-${Date.now()}`;
	}

	async #promptDeploymentServerName(scope: MCPAddScope, defaultName: string): Promise<string | null> {
		for (;;) {
			const input = await this.ctx.showHookInput(`Server name for deploy (default: ${defaultName})`, defaultName);
			if (input === undefined) return null;
			const proposed = input.trim() || defaultName;
			if (!proposed) {
				this.ctx.showError("Server name cannot be empty.");
				continue;
			}
			const filePath = getMCPConfigPath(scope, getProjectDir());
			const config = await readMCPConfigFile(filePath);
			if (config.mcpServers?.[proposed]) {
				this.ctx.showError(`Server "${proposed}" already exists in ${scope} config.`);
				continue;
			}
			return proposed;
		}
	}

	async #promptRequiredRegistryInputs(result: SmitherySearchResult): Promise<Record<string, string> | null> {
		const values: Record<string, string> = {};
		for (const input of result.requiredInputs) {
			const label = input.required ? `${input.key} (required)` : `${input.key} (optional)`;
			const prompt = `${label}${input.description ? ` - ${input.description}` : ""}`;
			const userInput = await this.ctx.showHookInput(prompt, input.defaultValue);
			if (userInput === undefined) {
				if (input.required) return null;
				continue;
			}
			const value = userInput.trim();
			if (!value) {
				if (input.required) {
					this.ctx.showError(`Missing required value for "${input.key}".`);
					return null;
				}
				continue;
			}
			values[input.key] = value;
		}
		return values;
	}

	#applyRegistryInputOverrides(config: MCPServerConfig, values: Record<string, string>): MCPServerConfig {
		if (Object.keys(values).length === 0) return config;
		if (config.type !== "stdio") {
			return config;
		}
		const args = [...(config.args ?? [])];
		const configJson = JSON.stringify(values);
		const index = args.indexOf("--config");
		if (index >= 0) {
			if (index + 1 < args.length) {
				args[index + 1] = configJson;
			} else {
				args.push(configJson);
			}
		} else {
			args.push("--config", configJson);
		}
		return { ...config, args };
	}

	async #pickRegistryResult(results: SmitherySearchResult[], keyword: string): Promise<SmitherySearchResult | null> {
		const options = results.map((result, index) => {
			const label = `${index + 1}. ${result.display.displayName} (${result.display.transport}, uses ${result.display.useCount})`;
			return label.length > 120 ? `${label.slice(0, 117)}...` : label;
		});
		const selected = await this.ctx.showHookSelector(`Registry results for "${keyword}"`, options);
		if (!selected) return null;
		const prefix = selected.split(".", 1)[0];
		const index = Number(prefix) - 1;
		if (!Number.isInteger(index) || index < 0 || index >= results.length) return null;
		return results[index] ?? null;
	}

	async #deployRegistryResult(result: SmitherySearchResult, scope: MCPAddScope): Promise<void> {
		const baseName = toConfigName(result.name);
		const defaultName = await this.#nextAvailableServerName(scope, baseName);
		const serverName = await this.#promptDeploymentServerName(scope, defaultName);
		if (!serverName) {
			this.ctx.showStatus("MCP deploy cancelled.");
			return;
		}
		const inputValues = await this.#promptRequiredRegistryInputs(result);
		if (inputValues === null) {
			this.ctx.showStatus("MCP deploy cancelled.");
			return;
		}
		const config = this.#applyRegistryInputOverrides(result.config, inputValues);
		await this.#handleWizardComplete(serverName, config, scope);
	}

	async #handleSearch(text: string): Promise<void> {
		const parsed = this.#parseSearchCommand(text);
		if (parsed.error) {
			this.ctx.showError(parsed.error);
			return;
		}

		try {
			this.#showMessage(
				["", theme.fg("muted", `Searching Smithery registry for "${parsed.keyword}"...`), ""].join("\n"),
			);
			const results = await this.#runSmitheryOperationWithAuthRetry(
				apiKey =>
					searchSmitheryRegistry(parsed.keyword, {
						limit: parsed.limit,
						apiKey,
						includeSemantic: parsed.semantic,
					}),
				"required for smithery-search",
			);
			if (results.length === 0) {
				this.#showMessage(
					["", theme.fg("warning", `No Smithery results found for "${parsed.keyword}".`), ""].join("\n"),
				);
				return;
			}

			const selected = await this.#pickRegistryResult(results, parsed.keyword);
			if (!selected) {
				this.ctx.showStatus("MCP Smithery selection cancelled.");
				return;
			}

			await this.#deployRegistryResult(selected, parsed.scope);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/authentication was cancelled|login cancelled/i.test(message)) {
				this.ctx.showError(`${message} Run /mcp smithery-login to authenticate first.`);
				return;
			}
			this.ctx.showError(`Smithery search failed: ${message}`);
		}
	}

	/**
	 * Show a message in the chat
	 */
	#showMessage(text: string): void {
		showCommandMessage(this.ctx, text);
	}
}

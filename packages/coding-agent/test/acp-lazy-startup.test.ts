import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	type Client,
	ClientSideConnection,
	type CreateTerminalRequest,
	type CreateTerminalResponse,
	ndJsonStream,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { Model } from "@gajae-code/ai";
import { TempDir } from "@gajae-code/utils";
import { Settings } from "../src/config/settings";
import type { ExtensionAPI } from "../src/extensibility/extensions";
import { createAcpConnection } from "../src/modes/acp/acp-mode";
import type { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const TEST_MODEL: Model = {
	id: "claude-sonnet-4-20250514",
	name: "Claude Sonnet",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

class TestClient implements Client {
	readonly updates: SessionNotification[] = [];

	async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		return { outcome: { outcome: "selected", optionId: "allow_once" } };
	}

	async sessionUpdate(params: SessionNotification): Promise<void> {
		this.updates.push(params);
	}

	async createTerminal(_params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
		return { terminalId: "test-terminal" };
	}
}

class LazyFakeSession {
	sessionManager: SessionManager;
	sessionId: string;
	agent: { sessionId: string; waitForIdle: () => Promise<void> };
	model: Model | undefined = TEST_MODEL;
	thinkingLevel: string | undefined;
	customCommands: [] = [];
	extensionRunner = undefined;
	isStreaming = false;
	queuedMessageCount = 0;
	systemPrompt = "system";
	disposed = false;
	settings = { get: (_path: string) => false };

	constructor(cwd: string) {
		this.sessionManager = SessionManager.inMemory(cwd);
		this.sessionId = this.sessionManager.getSessionId();
		this.agent = { sessionId: this.sessionId, waitForIdle: async () => {} };
	}

	get sessionName(): string {
		return this.sessionManager.getHeader()?.title ?? `Session ${this.sessionId}`;
	}

	get modelRegistry(): { getApiKey: (model: Model) => Promise<string> } {
		return { getApiKey: async (_model: Model) => "test-key" };
	}

	getAvailableModels(): Model[] {
		return [TEST_MODEL];
	}

	getAvailableThinkingLevels(): ReadonlyArray<string> {
		return ["low", "medium", "high"];
	}

	setThinkingLevel(): void {}
	setSlashCommands(): void {}
	async refreshSshTool(): Promise<void> {}
	async setModel(): Promise<void> {}
	subscribe(): () => void {
		return () => {};
	}
	async prompt(): Promise<void> {}
	async waitForIdle(): Promise<void> {}
	async abort(): Promise<void> {}
	async promptCustomMessage(): Promise<void> {}
	async refreshMCPTools(): Promise<void> {}
	getContextUsage(): undefined {
		return undefined;
	}
	async switchSession(): Promise<boolean> {
		return false;
	}
	async dispose(): Promise<void> {
		this.disposed = true;
		await this.sessionManager.close();
	}
	async reload(): Promise<void> {}
	async newSession(): Promise<boolean> {
		return false;
	}
	async branch(): Promise<{ cancelled: boolean }> {
		return { cancelled: false };
	}
	async navigateTree(): Promise<{ cancelled: boolean }> {
		return { cancelled: false };
	}
	getActiveToolNames(): string[] {
		return [];
	}
	getAllToolNames(): string[] {
		return [];
	}
	setActiveToolsByName(): void {}
	setClientBridge(): void {}
	getPlanModeState(): undefined {
		return undefined;
	}
	setPlanModeState(): void {}
	async sendCustomMessage(): Promise<void> {}
	async sendUserMessage(): Promise<void> {}
	async compact(): Promise<void> {}
	async fork(): Promise<boolean> {
		return false;
	}
}

describe("ACP lazy startup", () => {
	it("answers initialize before creating the first AgentSession", async () => {
		const clientToAgent = new TransformStream();
		const agentToClient = new TransformStream();
		const client = new TestClient();
		let createCalls = 0;
		const blockedCreation = Promise.withResolvers<AgentSession>();

		const agentConnection = new ClientSideConnection(
			() => client,
			ndJsonStream(clientToAgent.writable, agentToClient.readable),
		);
		const serverConnection = createAcpConnection(
			ndJsonStream(agentToClient.writable, clientToAgent.readable),
			async cwd => {
				createCalls++;
				if (createCalls === 1) {
					return await blockedCreation.promise;
				}
				return new LazyFakeSession(cwd) as unknown as AgentSession;
			},
		);

		try {
			const initializeResponse = await Promise.race([
				agentConnection.initialize({ protocolVersion: 1, clientCapabilities: {} }),
				Bun.sleep(50).then(() => "timeout" as const),
			]);

			expect(initializeResponse).not.toBe("timeout");
			expect(initializeResponse).toEqual(
				expect.objectContaining({
					protocolVersion: 1,
					agentInfo: expect.objectContaining({ name: "gajae-code" }),
				}),
			);
			expect(createCalls).toBe(0);

			const newSessionPromise = agentConnection.newSession({ cwd: "/tmp/acp-lazy-startup", mcpServers: [] });
			await Bun.sleep(20);
			expect(createCalls).toBe(1);

			blockedCreation.resolve(new LazyFakeSession("/tmp/acp-lazy-startup") as unknown as AgentSession);
			const sessionResponse = await newSessionPromise;
			expect(sessionResponse.sessionId).toEqual(expect.any(String));
		} finally {
			const closeConnection = (connection: unknown): void => {
				(connection as { connection: { close(error?: Error): void } }).connection.close();
			};
			closeConnection(agentConnection);
			closeConnection(serverConnection);
			await Promise.allSettled([agentConnection.closed, serverConnection.closed]);
		}
	});

	it("applies CLI runtime API keys after ACP lazy session creation resolves extension models", async () => {
		using tempDir = TempDir.createSync("@gjc-acp-lazy-api-key-");
		const cwd = tempDir.path();

		const registerRuntimeProvider = (api: ExtensionAPI): void => {
			api.registerProvider("runtime-provider", {
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "extension-key",
				api: "openai-completions",
				models: [
					{
						id: "runtime-model",
						name: "Runtime Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
					},
				],
			});
		};

		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		try {
			const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
			const { runRootCommand } = await import("../src/main");
			const { createAgentSession } = await import("../src/sdk");
			let session: AgentSession | undefined;

			const stopped = runRootCommand(
				{
					mode: "acp",
					apiKey: "cli-runtime-key",
					messages: [],
					fileArgs: [],
					unknownFlags: new Map(),
					noSkills: true,
					noRules: true,
					noTools: true,
					noLsp: true,
					sessionDir: cwd,

					model: "runtime-provider/runtime-model",
				},
				[],
				{
					discoverAuthStorage: async () => authStorage,
					createAgentSession: options =>
						createAgentSession({
							...(options ?? {}),
							extensions: [...(options?.extensions ?? []), registerRuntimeProvider],
						}),
					settings,
					runAcpMode: async createAcpSession => {
						session = await createAcpSession(cwd);
						throw new Error("stop test ACP mode");
					},
				},
			);
			await expect(stopped).rejects.toThrow("stop test ACP mode");

			if (!session?.model) {
				throw new Error("Expected extension model to resolve");
			}
			expect(session.model.provider).toBe("runtime-provider");
			expect(await session.modelRegistry.getApiKey(session.model)).toBe("cli-runtime-key");
			await session.dispose();
		} finally {
			authStorage.close();
		}
	}, 15_000);
});

/**
 * ACP `initialize` conformance — gates `terminal` auth methods on
 * `clientCapabilities.auth.terminal`, advertises stable agentInfo, and keeps
 * the agentCapabilities contract that downstream clients rely on.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSideConnection, InitializeRequest } from "@agentclientprotocol/sdk";
import type { Model } from "@gajae-code/ai";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { AcpAgent } from "../src/modes/acp/acp-agent";
import { ACP_TERMINAL_AUTH_FLAG, prepareAcpTerminalAuthArgs } from "../src/modes/acp/terminal-auth";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";

const TEST_MODELS: Model[] = [
	{
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
	},
];

class FakeAgentSession {
	sessionManager: SessionManager;
	sessionId: string;
	agent: { sessionId: string; waitForIdle: () => Promise<void> };
	model: Model | undefined = TEST_MODELS[0];
	thinkingLevel: string | undefined;
	customCommands: [] = [];
	extensionRunner = undefined;
	isStreaming = false;
	queuedMessageCount = 0;
	systemPrompt = "system";
	disposed = false;
	settings = { get: (_path: string) => false };

	constructor(cwd: string) {
		this.sessionManager = SessionManager.create(cwd);
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
		return TEST_MODELS;
	}

	getAvailableThinkingLevels(): ReadonlyArray<string> {
		return ["low", "medium", "high"];
	}

	setThinkingLevel(): void {}
	async setModel(): Promise<void> {}
	subscribe(): () => void {
		return () => {};
	}
	async prompt(): Promise<void> {}
	async abort(): Promise<void> {}
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

const cleanupRoots: string[] = [];
// Snapshot the actual `GJC_CODING_AGENT_DIR` env var and the SDK/utils resolver
// state independently. `setAgentDir(...)` (called per-test in `createAgent`)
// re-seeds the module-global resolver AND sets `process.env.GJC_CODING_AGENT_DIR`,
// so the afterEach restores the resolver from the captured `getAgentDir()` in
// every branch, then resets the env var on its own so presence and value
// (including the empty string) match the snapshot exactly — avoiding leakage of
// the isolated temp dir into other tests.
const originalAgentEnv = process.env.GJC_CODING_AGENT_DIR;
const originalAgentDir = getAgentDir();

afterEach(async () => {
	// Restore the SDK/utils resolver from the independently captured original
	// agent dir in every branch, regardless of whether the env var was set.
	setAgentDir(originalAgentDir);
	// Restore the env var independently so presence and value match the
	// captured snapshot exactly (setAgentDir above set it to originalAgentDir,
	// which may differ from originalAgentEnv, including the empty string).
	if (originalAgentEnv !== undefined) {
		process.env.GJC_CODING_AGENT_DIR = originalAgentEnv;
	} else {
		delete process.env.GJC_CODING_AGENT_DIR;
	}
	for (const root of cleanupRoots.splice(0)) {
		await fs.promises.rm(root, { recursive: true, force: true });
	}
});

async function createAgent(): Promise<AcpAgent> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-acp-init-"));
	cleanupRoots.push(root);
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "cwd");
	await fs.promises.mkdir(agentDir, { recursive: true });
	await fs.promises.mkdir(cwd, { recursive: true });
	setAgentDir(agentDir);

	const abortController = new AbortController();
	const connection = {
		sessionUpdate: async () => {},
		signal: abortController.signal,
		closed: Promise.withResolvers<void>().promise,
	} as unknown as AgentSideConnection;

	const initialSession = new FakeAgentSession(cwd);
	const factory = async (next: string): Promise<AgentSession> => new FakeAgentSession(next) as unknown as AgentSession;
	return new AcpAgent(connection, factory, initialSession as unknown as AgentSession);
}

function buildInitializeRequest(overrides: Partial<InitializeRequest> = {}): InitializeRequest {
	return {
		protocolVersion: 1,
		clientCapabilities: {},
		...overrides,
	} as InitializeRequest;
}

function expectInitializeResponseShape(value: unknown): void {
	expect(typeof value).toBe("object");
	expect(value).not.toBeNull();
	const response = value as { agentInfo?: { name?: unknown; version?: unknown } };
	expect(typeof response.agentInfo?.name).toBe("string");
	expect(typeof response.agentInfo?.version).toBe("string");
}

describe("ACP initialize conformance", () => {
	it("only advertises the agent-managed auth method when the client lacks terminal capability", async () => {
		const agent = await createAgent();
		const response = await agent.initialize(buildInitializeRequest());
		expectInitializeResponseShape(response);
		expect(response.authMethods).toHaveLength(1);
		const [agentMethod] = response.authMethods!;
		// AuthMethodAgent omits the `type` discriminator per ACP spec — the absence is the signal.
		expect((agentMethod as { type?: string }).type).toBeUndefined();
		expect(agentMethod).toEqual(
			expect.objectContaining({
				id: "agent",
				name: expect.any(String),
				description: expect.any(String),
			}),
		);
	});

	it("appends the terminal setup method when the client opts in via clientCapabilities.auth.terminal", async () => {
		const agent = await createAgent();
		const response = await agent.initialize(
			buildInitializeRequest({ clientCapabilities: { auth: { terminal: true } } }),
		);
		expectInitializeResponseShape(response);
		expect(response.authMethods).toHaveLength(2);
		const [first, second] = response.authMethods!;
		expect((first as { type?: string }).type).toBeUndefined();
		expect(first).toEqual(expect.objectContaining({ id: "agent" }));
		expect(response.authMethods![1]).toEqual(
			expect.objectContaining({
				type: "terminal",
				id: "terminal",
				args: [ACP_TERMINAL_AUTH_FLAG],
			}),
		);
		void second;
	});

	it("uses a terminal auth arg that removes ACP mode before launching the interactive setup flow", () => {
		const result = prepareAcpTerminalAuthArgs(["--mode", "acp", "--no-extensions", ACP_TERMINAL_AUTH_FLAG]);

		expect(result).toEqual({
			args: ["--no-extensions"],
			terminalAuth: true,
		});
		expect(prepareAcpTerminalAuthArgs(["--mode=acp", ACP_TERMINAL_AUTH_FLAG])).toEqual({
			args: [],
			terminalAuth: true,
		});
	});

	it("declares agentInfo.version that matches the published package version", async () => {
		const agent = await createAgent();
		const response = await agent.initialize(buildInitializeRequest());
		const pkgPath = path.join(import.meta.dir, "..", "package.json");
		const pkg = (await Bun.file(pkgPath).json()) as { version: string };
		expect(response.agentInfo).toEqual(
			expect.objectContaining({
				name: "gajae-code",
				title: "Gajae Code",
				version: pkg.version,
			}),
		);
		expect(response.agentInfo!.version).toBe(pkg.version);
	});

	it("preserves the agentCapabilities contract clients depend on", async () => {
		const agent = await createAgent();
		const response = await agent.initialize(buildInitializeRequest());
		expectInitializeResponseShape(response);
		expect(response.agentCapabilities).toEqual(
			expect.objectContaining({
				loadSession: true,
				mcpCapabilities: expect.objectContaining({ http: true, sse: true }),
				promptCapabilities: expect.objectContaining({ embeddedContext: true, image: true }),
				sessionCapabilities: expect.objectContaining({
					list: expect.any(Object),
					fork: expect.any(Object),
					resume: expect.any(Object),
					close: expect.any(Object),
					delete: expect.any(Object),
				}),
			}),
		);
	});
});

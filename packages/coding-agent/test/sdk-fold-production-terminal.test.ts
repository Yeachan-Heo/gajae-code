import { afterEach, describe, expect, test } from "bun:test";
import type { AgentSideConnection, ClientCapabilities } from "@agentclientprotocol/sdk";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { TempDir } from "@gajae-code/utils";
import { AsyncJobManager } from "../src/async";
import { Settings } from "../src/config/settings";
import { createAcpClientBridge } from "../src/modes/acp/acp-client-bridge";
import { createAgentSession } from "../src/sdk";
import { AuthStorage } from "../src/session/auth-storage";
import type { ClientBridgeTerminalHandle } from "../src/session/client-bridge";
import { SessionManager } from "../src/session/session-manager";

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("Timed out waiting for production ACP fold state");
}

describe("SDK production ACP fold path", () => {
	let created: Awaited<ReturnType<typeof createAgentSession>> | undefined;
	let authStorage: AuthStorage | undefined;
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		await created?.session.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		created = undefined;
		authStorage = undefined;
		tempDir = undefined;
		AsyncJobManager.resetForTests();
	});

	test("creates, folds, wakes, and releases through the SDK ToolSession and ACP adapter", async () => {
		tempDir = TempDir.createSync("@gjc-sdk-fold-acp-");
		authStorage = await AuthStorage.create(`${tempDir.path()}/auth.db`);
		const mock = createMockModel({ responses: [{ content: ["wake complete"] }] });
		authStorage.setRuntimeApiKey(mock.model.provider, "test-key");
		created = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			settings: Settings.isolated({
				"async.enabled": true,
				"bash.autoBackground.enabled": false,
				"compaction.enabled": false,
			}),
			model: mock.model,
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			sdkHostModeSupported: false,
			notificationHostModeSupported: false,
		});

		const exit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		let releaseCalls = 0;
		const terminal: ClientBridgeTerminalHandle = {
			terminalId: "sdk-acp-fold-terminal",
			currentOutput: async () => ({ output: "folded output\n", truncated: false }),
			waitForExit: () => exit.promise,
			kill: async () => {},
			release: async () => {
				releaseCalls += 1;
			},
		};
		const connection = {
			createTerminal: async () => ({
				id: terminal.terminalId,
				currentOutput: terminal.currentOutput,
				waitForExit: terminal.waitForExit,
				kill: terminal.kill,
				release: terminal.release,
			}),
		} as unknown as AgentSideConnection;
		created.session.setClientBridge(
			createAcpClientBridge(connection, created.session.sessionId, { terminal: true } as ClientCapabilities),
		);

		const bash = created.session.getToolForExecution("bash");
		if (!bash) throw new Error("expected SDK bash tool");
		const run = bash.execute("sdk-fold-call", { command: "sleep 30" }, undefined, () => {});
		await waitFor(() => created!.session.hasForegroundBashBackgroundRequestHandler());

		expect(created.session.requestForegroundBashBackground()).toBe(true);
		const foreground = await run;
		expect(foreground.details?.async?.state).toBe("running");
		const jobId = foreground.details?.async?.jobId;
		if (!jobId) throw new Error("expected folded SDK job id");

		exit.resolve({ exitCode: 0, signal: null });
		await waitFor(() => releaseCalls === 1);
		await waitFor(() => !created!.session.yieldQueue.has("async-result"));
		const asyncResults = created.session.agent.state.messages.filter(
			message => message.role === "custom" && message.customType === "async-result",
		);
		expect(asyncResults).toHaveLength(1);
		expect(JSON.stringify(asyncResults[0])).toContain("folded output");
		expect(JSON.stringify(asyncResults[0])).toContain("folded client-terminal wait");
	});
});

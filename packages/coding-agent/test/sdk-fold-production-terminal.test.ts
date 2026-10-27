import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentSideConnection, ClientCapabilities } from "@agentclientprotocol/sdk";
import { createMockModel, registerMockApi } from "@gajae-code/ai/providers/mock";
import { TempDir } from "@gajae-code/utils";
import { AsyncJobManager } from "../src/async";
import { Settings } from "../src/config/settings";
import { createAcpClientBridge } from "../src/modes/acp/acp-client-bridge";
import { type CreateAgentSessionResult, createAgentSession } from "../src/sdk";
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
	let created: CreateAgentSessionResult | undefined;
	let authStorage: AuthStorage | undefined;
	let tempDir: TempDir | undefined;
	let sessionManager: SessionManager | undefined;

	afterEach(async () => {
		await created?.session.dispose();
		vi.restoreAllMocks();
		authStorage?.close();
		tempDir?.removeSync();
		created = undefined;
		authStorage = undefined;
		tempDir = undefined;
		sessionManager = undefined;
		AsyncJobManager.resetForTests();
	});

	async function createSession() {
		tempDir = TempDir.createSync("@gjc-sdk-fold-acp-");
		registerMockApi();
		authStorage = await AuthStorage.create(`${tempDir.path()}/auth.db`);
		const mock = createMockModel({ responses: [{ content: ["wake complete"] }] });
		authStorage.setRuntimeApiKey(mock.model.provider, "test-key");
		sessionManager = SessionManager.inMemory(tempDir.path());
		created = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			authStorage,
			settings: Settings.isolated({
				"async.enabled": true,
				"bash.autoBackground.enabled": false,
				"compaction.enabled": false,
				"tools.artifactTailBytes": 32 * 1024,
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
		return mock;
	}

	for (const storage of ["secured", "unavailable", "refused"] as const) {
		test(`ordinary unowned large completion queues and wakes with ${storage} storage`, async () => {
			const mock = await createSession();
			if (!created || !sessionManager) throw new Error("expected SDK fixture");
			const save = vi.spyOn(sessionManager, "saveArtifact");
			if (storage === "unavailable") save.mockResolvedValue(undefined);
			if (storage === "refused") save.mockRejectedValue(new Error("private refusal"));
			const manager = AsyncJobManager.instance();
			if (!manager) throw new Error("expected SDK async manager");
			const output = "ordinary large completion\n".repeat(1_000);
			const callsBeforeWake = mock.calls.length;
			manager.register("bash", "ordinary completion", async () => output);
			await waitFor(() => created!.session.yieldQueue.has("async-result"));
			await created.session.yieldQueue.flush("idle");
			expect(mock.calls.length).toBe(callsBeforeWake + 1);
			expect(save).toHaveBeenCalledWith(output, "async");
			const wakeMessages = JSON.stringify(mock.calls[mock.calls.length - 1]?.context.messages);
			expect(wakeMessages).toContain("ordinary large completion");
			if (storage === "secured") {
				const artifactId = wakeMessages.match(/artifact:\/\/([^\s"\\]+)/)?.[1];
				if (!artifactId) throw new Error("expected secured completion receipt");
				const artifactPath = await sessionManager.getArtifactPath(artifactId);
				if (!artifactPath) throw new Error("expected secured completion path");
				expect(await Bun.file(artifactPath).text()).toBe(output);
			} else {
				expect(wakeMessages).toContain("storage unavailable");
				expect(wakeMessages).not.toContain("artifact://");
				expect(wakeMessages).not.toContain("private refusal");
			}
		});
	}

	test.each(["inline", "refused"] as const)(
		"creates, folds, wakes, and releases through SDK and ACP with %s storage",
		async storage => {
			const mock = await createSession();
			if (!created || !sessionManager) throw new Error("expected SDK fixture");
			const output = storage === "inline" ? "folded output\n" : "folded output\n".repeat(1_000);
			const save = vi.spyOn(sessionManager, "saveArtifact");
			if (storage === "refused") save.mockRejectedValue(new Error("private folded refusal"));

			const exit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
			let releaseCalls = 0;
			const terminal: ClientBridgeTerminalHandle = {
				terminalId: "sdk-acp-fold-terminal",
				currentOutput: async () => ({ output, truncated: false }),
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
			const bridge = createAcpClientBridge(connection, created.session.sessionId, {
				terminal: true,
			} as ClientCapabilities);
			created.session.setClientBridge(bridge);

			const bash = created.session.getToolForExecution("bash");
			if (!bash) throw new Error("expected SDK bash tool");
			const run = bash.execute("sdk-fold-call", { command: "sleep 30" }, undefined, () => {});
			await waitFor(() => created!.session.hasForegroundBashBackgroundRequestHandler());

			expect(await created.session.requestForegroundBashBackground()).toBe(true);
			const foreground = await run;
			expect(foreground.details?.async?.state).toBe("running");
			const jobId = foreground.details?.async?.jobId;
			if (!jobId) throw new Error("expected folded SDK job id");
			const callsBeforeWake = mock.calls.length;

			exit.resolve({ exitCode: 0, signal: null });
			await waitFor(() => releaseCalls === 1);
			await waitFor(() => created!.session.yieldQueue.has("async-result"));
			await created.session.yieldQueue.flush("idle");
			// Flushing the receipt through the public queue drives the normal model wake.
			expect(mock.calls.length).toBeGreaterThan(callsBeforeWake);
			expect(mock.calls.length).toBe(callsBeforeWake + 1);
			expect(releaseCalls).toBe(1);
			const wakeMessages = JSON.stringify(mock.calls[mock.calls.length - 1]?.context.messages);
			expect(wakeMessages).toContain("folded output");
			expect(wakeMessages).toContain("folded client-terminal wait");
			if (storage === "refused") {
				expect(save).toHaveBeenCalledWith(expect.stringContaining("folded output"), "async");
				expect(wakeMessages).toContain("storage unavailable");
				expect(wakeMessages).not.toContain("artifact://");
				expect(wakeMessages).not.toContain("private folded refusal");
			} else {
				expect(save).not.toHaveBeenCalled();
			}
			await created.session.yieldQueue.flush("idle");
			expect(mock.calls.length).toBe(callsBeforeWake + 1);
			expect(releaseCalls).toBe(1);
		},
	);
});

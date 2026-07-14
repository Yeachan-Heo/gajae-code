import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentSideConnection, PromptRequest, SessionNotification } from "@agentclientprotocol/sdk";
import { Agent, type AgentOptions } from "@gajae-code/agent-core";
import { getBundledModel, type Model } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AcpAgent } from "@gajae-code/coding-agent/modes/acp/acp-agent";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

function selector(model: Model): string {
	return `${model.provider}/${model.id}`;
}

describe("ACP managed fallback cancellation completion", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let connectionAbort: AbortController;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@acp-fallback-cancel-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
		await Settings.init({ agentDir: tempDir.path(), inMemory: true });
		connectionAbort = new AbortController();
	});

	afterEach(async () => {
		connectionAbort.abort();
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	it("finishes a cancelled fallback prompt once without failed assistant chunks", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models");
		const pending = new AssistantMessageEventStream();
		const streamFn: AgentOptions["streamFn"] = () => pending;
		const agent = new Agent({
			getApiKey: provider => `${provider}-key`,
			initialState: { model: primary, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"fallback.maxAttempts": 3,
			"retry.baseDelayMs": 50,
		});
		settings.setModelRole("default", selector(primary));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		session.setConfiguredModelChain("default", [selector(primary), selector(fallback)], "test");

		const updates: SessionNotification[] = [];
		const connection = {
			sessionUpdate: async (notification: SessionNotification) => {
				updates.push(notification);
			},
			signal: connectionAbort.signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection;
		const acp = new AcpAgent(connection, async () => session!);
		const created = await acp.newSession({ cwd: tempDir.path(), mcpServers: [] });
		const prompt = acp.prompt({
			sessionId: created.sessionId,
			messageId: "00000000-0000-4000-8000-0000000000fc",
			prompt: [{ type: "text", text: "cancel managed fallback" }],
		} as PromptRequest);
		let promptResolutions = 0;
		void prompt.then(() => {
			promptResolutions++;
		});
		for (let i = 0; i < 20 && !session.isStreaming; i += 1) await Bun.sleep(1);
		await acp.cancel({ sessionId: created.sessionId });

		const response = await prompt;
		await Bun.sleep(0);
		expect(response.stopReason).toBe("cancelled");
		expect(promptResolutions).toBe(1);
		expect(
			updates.filter(update => {
				const payload = update.update as {
					sessionUpdate?: string;
					content?: Array<{ content?: { text?: string } }>;
				};
				return (
					payload.sessionUpdate === "agent_message_chunk" &&
					payload.content?.some(item => /failed/i.test(item.content?.text ?? ""))
				);
			}),
		).toHaveLength(0);
	});
});

import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

function assistantMessage(text: string): AssistantMessage {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled Anthropic model");
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AgentSession transcript persistence", () => {
	let session: AgentSession | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
	});

	it("persists an assistant message when post-prompt lease admission is unavailable", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		const streamStarted = Promise.withResolvers<void>();
		let stream: AssistantMessageEventStream | undefined;
		const message = assistantMessage("durable output");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream?.push({ type: "start", partial: message });
					streamStarted.resolve();
				});
				return stream;
			},
		});
		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: { getApiKey: async () => "test-key", getAuthStorageOwner: () => ({}) } as never,
		});

		const prompt = session.prompt("persist this turn");
		await streamStarted.promise;
		const originalReserveProducer = agent.resourceLedger.reserveProducer.bind(agent.resourceLedger);
		vi.spyOn(agent.resourceLedger, "reserveProducer").mockImplementation((resourceRunId, domain, kind, label) => {
			if (label === "agent-session-event") return { ok: false, reason: "quarantined" };
			return originalReserveProducer(resourceRunId, domain, kind, label);
		});
		stream?.push({ type: "done", reason: "stop", message });

		await prompt;
		await session.awaitSessionSettlement();

		expect(
			sessionManager
				.getEntries()
				.filter((entry): entry is Extract<typeof entry, { type: "message" }> => entry.type === "message")
				.map(entry => entry.message),
		).toContainEqual(
			expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "durable output" }] }),
		);
	});
});

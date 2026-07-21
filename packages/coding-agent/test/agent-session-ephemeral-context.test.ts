import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@gajae-code/agent-core";
import type { AssistantMessage, Context, Usage } from "@gajae-code/ai";
import { createMockModel, type MockModel, registerMockApi } from "@gajae-code/ai/providers/mock";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { RawSseDebugBuffer } from "@gajae-code/coding-agent/debug/raw-sse-buffer";
import { AgentRegistry } from "@gajae-code/coding-agent/registry/agent-registry";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

registerMockApi();

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const sessions: AgentSession[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
});

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function assistant(text: string, thinking?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [...(thinking ? [{ type: "thinking" as const, thinking }] : []), { type: "text", text }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage,
		stopReason: "stop",
		timestamp: 1,
	};
}

function text(message: AgentMessage): string {
	if (message.role !== "user" && message.role !== "assistant") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("");
}

function createHarness(
	options: {
		onConvert?: (messages: AgentMessage[]) => Promise<void>;
		onPayload?: () => void;
		onResponse?: () => void;
		onSseEvent?: () => void;
	} = {},
): {
	session: AgentSession;
	model: MockModel;
	snapshots: AgentMessage[][];
	registry: AgentRegistry;
	rawSseDebugBuffer: RawSseDebugBuffer;
	providerContexts: Context[];
} {
	const providerContexts: Context[] = [];
	const model = createMockModel({
		handler: context => {
			providerContexts.push(structuredClone(context));
			return { content: ["ephemeral reply"] };
		},
	});
	const snapshots: AgentMessage[][] = [];
	const registry = new AgentRegistry();
	const rawSseDebugBuffer = new RawSseDebugBuffer();
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: ["system prompt"],
			messages: [user("main user"), assistant("main assistant")],
			tools: [],
		},
		streamFn: model.stream,
		convertToLlm: async messages => convertToLlm(messages),
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: { getApiKey: async () => "test-key", getAvailable: () => [model] } as never,
		agentId: "0-Main",
		agentRegistry: registry,
		convertToLlm: async messages => {
			snapshots.push([...messages]);
			await options.onConvert?.(messages);
			return convertToLlm(messages);
		},
		onPayload: options.onPayload as never,
		onResponse: options.onResponse as never,
		onSseEvent: options.onSseEvent as never,
		rawSseDebugBuffer,
	});
	sessions.push(session);
	return { session, model, snapshots, registry, rawSseDebugBuffer, providerContexts };
}

describe("AgentSession ephemeral context", () => {
	it("replays only text-visible retained exchanges without mutating session history", async () => {
		const { session, model, snapshots, providerContexts } = createHarness();
		const contextExchanges = [
			{ question: "first question", answer: "first answer" },
			{ question: "second question", answer: "second answer" },
		];
		const contextBefore = structuredClone(contextExchanges);
		const sessionBefore = structuredClone(session.messages);

		await session.runEphemeralTurn({
			purpose: "btw",
			turn: { question: "current prompt", scope: session.createBtwConversationScope("btw test instruction") },
			contextExchanges,
		});

		expect(snapshots).toEqual([]);
		expect(providerContexts[0]?.messages.map(message => `${message.role}:${text(message as AgentMessage)}`)).toEqual([
			"user:first question",
			"assistant:first answer",
			"user:second question",
			"assistant:second answer",
			"user:current prompt",
		]);
		expect(JSON.stringify(providerContexts[0]?.messages)).not.toContain("thinking");
		expect(
			providerContexts[0]?.messages.every(message => {
				const keys = Object.keys(message).sort();
				return keys.length === 2 && keys[0] === "content" && keys[1] === "role";
			}),
		).toBe(true);
		expect(contextExchanges).toEqual(contextBefore);
		expect(session.messages).toEqual(sessionBefore);
		expect(model.calls[0]?.context.tools).toEqual([]);
		expect(model.calls[0]?.options?.toolChoice).toBe("none");
	});

	it("does not route /btw bytes through payload, response, SSE, or raw debug hooks", async () => {
		const onPayload = vi.fn();
		const onResponse = vi.fn();
		const onSseEvent = vi.fn();
		const { session, model, rawSseDebugBuffer } = createHarness({ onPayload, onResponse, onSseEvent });

		await session.runEphemeralTurn({
			purpose: "btw",
			turn: {
				question: "private current prompt",
				scope: session.createBtwConversationScope("btw test instruction"),
			},
			contextExchanges: [{ question: "private prior question", answer: "private prior answer" }],
		});

		expect(onPayload).not.toHaveBeenCalled();
		expect(onResponse).not.toHaveBeenCalled();
		expect(onSseEvent).not.toHaveBeenCalled();
		expect(rawSseDebugBuffer.snapshot().records).toEqual([]);
		expect(model.calls[0]?.options?.onPayload).toBeUndefined();
		expect(model.calls[0]?.options?.onResponse).toBeUndefined();
		expect(model.calls[0]?.options?.onSseEvent).toBeUndefined();
	});
});

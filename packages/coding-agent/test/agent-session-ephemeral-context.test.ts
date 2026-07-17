import { afterEach, describe, expect, it } from "bun:test";
import { Agent, type AgentMessage } from "@gajae-code/agent-core";
import { type AssistantMessage, type Usage } from "@gajae-code/ai";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentRegistry } from "@gajae-code/coding-agent/registry/agent-registry";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { createMockModel, registerMockApi, type MockModel } from "@gajae-code/ai/providers/mock";

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
		content: [
			...(thinking ? [{ type: "thinking" as const, thinking }] : []),
			{ type: "text", text },
		],
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

function createHarness(options: { onConvert?: (messages: AgentMessage[]) => Promise<void> } = {}): {
	session: AgentSession;
	model: MockModel;
	snapshots: AgentMessage[][];
	registry: AgentRegistry;
} {
	const model = createMockModel({ handler: () => ({ content: ["ephemeral reply"] }) });
	const snapshots: AgentMessage[][] = [];
	const registry = new AgentRegistry();
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
	});
	sessions.push(session);
	return { session, model, snapshots, registry };
}

function addPeer(registry: AgentRegistry): void {
	registry.register({
		id: "1-Worker",
		displayName: "Worker",
		rosterLabel: "Worker",
		kind: "sub",
		session: null,
		status: "running",
	});
}

describe("AgentSession ephemeral context", () => {
	it("replays main messages, caller context, and the virtual prompt in order without mutation or tools", async () => {
		const { session, model, snapshots } = createHarness();
		const context = [user("first question"), assistant("first answer"), user("second question"), assistant("second answer", "private reasoning")];
		const contextBefore = structuredClone(context);
		const sessionBefore = structuredClone(session.messages);

		await session.runEphemeralTurn({ promptText: "current prompt", contextMessages: context });

		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]?.map(message => `${message.role}:${text(message)}`)).toEqual([
			"user:main user",
			"assistant:main assistant",
			"user:first question",
			"assistant:first answer",
			"user:second question",
			"assistant:second answer",
			"user:current prompt",
		]);
		expect(snapshots[0]?.[5]).toBe(context[3]);
		expect((snapshots[0]?.[5] as AssistantMessage).content).toContainEqual({ type: "thinking", thinking: "private reasoning" });
		expect(context).toEqual(contextBefore);
		expect(session.messages).toEqual(sessionBefore);
		expect(model.calls[0]?.context.tools).toEqual([]);
		expect(model.calls[0]?.options?.toolChoice).toBe("none");
	});

	it("preserves caller context when an IRC roster claim is invalidated during conversion", async () => {
		let session!: AgentSession;
		let conversions = 0;
		const harness = createHarness({
			onConvert: async () => {
				conversions += 1;
				if (conversions === 1) await session.newSession();
			},
		});
		session = harness.session;
		addPeer(harness.registry);
		const context = [user("retained question"), assistant("retained answer", "reasoning")];

		await session.runEphemeralTurn({ promptText: "current prompt", contextMessages: context });

		expect(harness.snapshots).toHaveLength(2);
		expect(JSON.stringify(harness.snapshots[0])).toContain("irc-peer-roster");
		expect(JSON.stringify(harness.snapshots[1])).not.toContain("irc-peer-roster");
		expect(harness.snapshots[1]?.map(message => `${message.role}:${text(message)}`)).toEqual([
			"user:retained question",
			"assistant:retained answer",
			"user:current prompt",
		]);
		expect(harness.snapshots[1]?.[1]).toBe(context[1]);
	});
});

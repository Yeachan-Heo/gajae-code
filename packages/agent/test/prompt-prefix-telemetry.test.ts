import { describe, expect, it } from "bun:test";
import { agentLoopContinue } from "@gajae-code/agent-core/agent-loop";
import { PromptPrefixTracker } from "@gajae-code/agent-core/prompt-prefix-telemetry";
import type { AgentContext, AgentLoopConfig, AgentMessage, StreamFn } from "@gajae-code/agent-core/types";
import type { AssistantMessage, Context, Message, Tool } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { createAssistantMessage, createUserMessage } from "./helpers";

const model = { provider: "anthropic", id: "claude" };
const tool: Tool = { name: "read", description: "read a file", parameters: { type: "object", properties: {} } };

function request(messages: Message[], overrides: Partial<Context> = {}): Context {
	return { systemPrompt: ["You are helpful."], tools: [tool], messages, ...overrides };
}

describe("PromptPrefixTracker", () => {
	const first = createUserMessage("first") as Message;
	const reply = createAssistantMessage([{ type: "text", text: "ok" }]) as Message;
	const second = createUserMessage("second") as Message;

	it("classifies a pure append as prefix-preserving and keeps a stable hash for identical requests", () => {
		const tracker = new PromptPrefixTracker();
		const initial = tracker.observe(model, request([first]));
		const appended = tracker.observe(model, request([first, reply, second]));

		expect(initial).toMatchObject({ change: "initial", messages: 1, reusedMessages: 0, previousMessages: 0 });
		expect(appended).toMatchObject({ change: "append", messages: 3, reusedMessages: 1, previousMessages: 1 });
		expect(appended.divergedRole).toBeUndefined();
		expect(appended.hash).toMatch(/^[0-9a-f]{16}$/);

		const replay = new PromptPrefixTracker();
		replay.observe(model, request([first]));
		expect(replay.observe(model, request([first, reply, second])).hash).toBe(appended.hash);
	});

	it("attributes the first mutated layer in provider cache order", () => {
		const tracker = new PromptPrefixTracker();
		tracker.observe(model, request([first]));

		const system = tracker.observe(model, request([first, second], { systemPrompt: ["Changed."] }));
		expect(system.change).toBe("system");
		// Tools precede the system prompt in the cached prefix, so a combined change is attributed to tools.
		const tools = tracker.observe(model, request([first, second], { systemPrompt: ["Other."], tools: [] }));
		expect(tools.change).toBe("tools");
		const switched = tracker.observe({ provider: "openai", id: "gpt" }, request([first, second], { tools: [] }));
		expect(switched).toMatchObject({ change: "model", reusedMessages: 0 });
	});

	it("records how far the message prefix survived and which role was rewritten", () => {
		const tracker = new PromptPrefixTracker();
		tracker.observe(model, request([first, reply, second]));
		const rewrittenReply = createAssistantMessage([{ type: "text", text: "edited" }]) as Message;

		const rewritten = tracker.observe(model, request([first, rewrittenReply, second]));
		expect(rewritten).toMatchObject({
			change: "messages",
			reusedMessages: 1,
			previousMessages: 3,
			divergedRole: "assistant",
		});

		// Dropping the tail (e.g. a removed ephemeral message) is a client-side rewrite too.
		const truncated = tracker.observe(model, request([first]));
		expect(truncated).toMatchObject({ change: "messages", reusedMessages: 1, divergedRole: "assistant" });
	});
});

describe("agent loop prompt-prefix telemetry", () => {
	function streamReturning(message: () => AssistantMessage): StreamFn {
		return () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const final = message();
				stream.push({ type: "done", reason: "stop", message: final });
				stream.end(final);
			});
			return stream;
		};
	}

	async function run(context: AgentContext, config: AgentLoopConfig): Promise<AssistantMessage> {
		const stream = agentLoopContinue(
			context,
			config,
			undefined,
			streamReturning(() => createAssistantMessage([{ type: "text", text: "ok" }])),
		);
		for await (const _event of stream) {
			// drain
		}
		await stream.result();
		const last = context.messages[context.messages.length - 1] as AssistantMessage;
		expect(last.role).toBe("assistant");
		return last;
	}

	it("stamps each assistant turn with the prefix change of the request that produced it", async () => {
		const mock = createMockModel();
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [createUserMessage("first")],
			tools: [],
		};
		const config: AgentLoopConfig = {
			model: mock.model,
			promptPrefixTracker: new PromptPrefixTracker(),
			convertToLlm: (messages: AgentMessage[]) =>
				messages.filter((m): m is Message => m.role === "user" || m.role === "assistant"),
		};

		const firstTurn = await run(context, config);
		expect(firstTurn.promptPrefix).toMatchObject({ change: "initial", messages: 1 });

		context.messages.push(createUserMessage("second"));
		const appendTurn = await run(context, config);
		expect(appendTurn.promptPrefix).toMatchObject({ change: "append", messages: 3, reusedMessages: 1 });

		context.systemPrompt = ["You are helpful.", "Injected mid-session."];
		context.messages.push(createUserMessage("third"));
		const mutatedTurn = await run(context, config);
		expect(mutatedTurn.promptPrefix).toMatchObject({ change: "system", messages: 5, reusedMessages: 3 });
	});

	it("leaves assistant messages untouched when no tracker is configured", async () => {
		const mock = createMockModel();
		const context: AgentContext = { systemPrompt: ["s"], messages: [createUserMessage("hi")], tools: [] };
		const turn = await run(context, {
			model: mock.model,
			convertToLlm: (messages: AgentMessage[]) => messages.filter((m): m is Message => m.role === "user"),
		});
		expect(turn.promptPrefix).toBeUndefined();
	});
});

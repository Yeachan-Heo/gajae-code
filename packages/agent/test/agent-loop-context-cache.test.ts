import { describe, expect, it } from "bun:test";
import { agentLoopContinue } from "@gajae-code/agent-core/agent-loop";
import { AppendOnlyContextManager } from "@gajae-code/agent-core/append-only-context";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool, StreamFn } from "@gajae-code/agent-core/types";
import type { Context, Message } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { createAssistantMessage, createUserMessage } from "./helpers";

function makeContext(messages: AgentMessage[] = [createUserMessage("first")]): AgentContext {
	return { systemPrompt: ["You are helpful."], messages, tools: [] };
}

function makeTool(name: string, description = name): AgentTool {
	return {
		name,
		label: name,
		description,
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	} as AgentTool;
}

function createCapturingStream(captured: Context[]): StreamFn {
	return (_model, context) => {
		captured.push(context);
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			const message = createAssistantMessage([{ type: "text", text: "ok" }]);
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
		});
		return stream;
	};
}

async function runOnce(context: AgentContext, config: AgentLoopConfig, captured: Context[]): Promise<void> {
	const stream = agentLoopContinue(context, config, undefined, createCapturingStream(captured));
	for await (const _event of stream) {
		// drain
	}
	await stream.result();
	if (context.messages[context.messages.length - 1]?.role === "assistant") {
		context.messages.pop();
	}
}

describe("agent loop converted context cache", () => {
	it("reuses only a content-stable append-only converted prefix", async () => {
		const mock = createMockModel();
		const context = makeContext();
		const captured: Context[] = [];
		const convertSizes: number[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			appendOnlyContext: new AppendOnlyContextManager(),
			convertToLlm: messages => {
				convertSizes.push(messages.length);
				return messages.filter(
					(m): m is Message => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
				);
			},
		};

		await runOnce(context, config, captured);
		context.messages.push(createUserMessage("second"));
		await runOnce(context, config, captured);

		expect(convertSizes).toEqual([1, 1]);
		expect(captured[1]!.messages.map(message => message.content)).toEqual(["first", "second"]);
	});

	it("invalidates when an existing message is mutated in place", async () => {
		const mock = createMockModel();
		const first = createUserMessage("first");
		const context = makeContext([first]);
		const captured: Context[] = [];
		const convertSizes: number[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: messages => {
				convertSizes.push(messages.length);
				return messages as Message[];
			},
		};

		await runOnce(context, config, captured);
		first.content = "first [SILENT_ABORT_MARKER]";
		await runOnce(context, config, captured);

		expect(convertSizes).toEqual([1, 1]);
		expect(captured[1]!.messages[0]!.content).toBe("first [SILENT_ABORT_MARKER]");
	});

	it("does not reuse a prefix after mutating an earlier message before append-only growth", async () => {
		const mock = createMockModel();
		const first = createUserMessage("first");
		const context = makeContext([first, createUserMessage("second")]);
		const captured: Context[] = [];
		const convertSizes: number[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			appendOnlyContext: new AppendOnlyContextManager(),
			convertToLlm: messages => {
				convertSizes.push(messages.length);
				return messages as Message[];
			},
		};

		await runOnce(context, config, captured);
		first.content = "first [SILENT_ABORT_MARKER]";
		context.messages.push(createUserMessage("third"));
		await runOnce(context, config, captured);

		expect(convertSizes).toEqual([2, 3]);
		expect(captured[1]!.messages.map(message => message.content)).toEqual([
			"first [SILENT_ABORT_MARKER]",
			"second",
			"third",
		]);
	});

	it("invalidates when provider or model changes", async () => {
		const mock = createMockModel();
		const context = makeContext([createUserMessage("first"), createUserMessage("second")]);
		const captured: Context[] = [];
		const convertSizes: number[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: messages => {
				convertSizes.push(messages.length);
				return messages as Message[];
			},
		};

		await runOnce(context, config, captured);
		config.model = {
			...mock.model,
			provider: "cerebras",
			id: `${mock.model.id}-other`,
			name: `${mock.model.name}-other`,
		};
		await runOnce(context, config, captured);

		expect(convertSizes).toEqual([2, 2]);
	});

	it("invalidates when the normalized tool set changes", async () => {
		const mock = createMockModel();
		const context = makeContext([createUserMessage("first"), createUserMessage("second")]);
		context.tools = [makeTool("read")];
		const captured: Context[] = [];
		const convertSizes: number[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: messages => {
				convertSizes.push(messages.length);
				return messages as Message[];
			},
		};

		await runOnce(context, config, captured);
		context.tools = [makeTool("read"), makeTool("write")];
		await runOnce(context, config, captured);

		expect(convertSizes).toEqual([2, 2]);
		expect(captured[1]!.tools?.map(tool => tool.name)).toEqual(["read", "write"]);
	});

	it("invalidates when transformContext returns different content", async () => {
		const mock = createMockModel();
		const context = makeContext([createUserMessage("source")]);
		const captured: Context[] = [];
		const convertSizes: number[] = [];
		let transformedContent = "first transform";
		const config: AgentLoopConfig = {
			model: mock.model,
			transformContext: async () => [createUserMessage(transformedContent)],
			convertToLlm: messages => {
				convertSizes.push(messages.length);
				return messages as Message[];
			},
		};

		await runOnce(context, config, captured);
		transformedContent = "second transform";
		await runOnce(context, config, captured);

		expect(convertSizes).toEqual([1, 1]);
		expect(captured[1]!.messages[0]!.content).toBe("second transform");
	});
});

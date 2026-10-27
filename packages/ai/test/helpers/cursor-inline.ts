import { create, fromBinary } from "@bufbuild/protobuf";
import { type CursorOptions, createCursorServerMessageHandlerForTest } from "../../src/providers/cursor";
import {
	AgentClientMessageSchema,
	type AgentServerMessage,
	AgentServerMessageSchema,
	ExecServerMessageSchema,
	type InteractionUpdate,
	InteractionUpdateSchema,
	McpArgsSchema,
	McpToolCallSchema,
	PartialToolCallUpdateSchema,
	TextDeltaUpdateSchema,
	type ToolCall,
	ToolCallCompletedUpdateSchema,
	ToolCallDeltaUpdateSchema,
	ToolCallSchema,
	ToolCallStartedUpdateSchema,
	TurnEndedUpdateSchema,
} from "../../src/providers/cursor/gen/agent_pb";
import type { AssistantMessage, Model } from "../../src/types";
import { AssistantMessageEventStream } from "../../src/utils/event-stream";

export const mcpArgs = create(McpArgsSchema, {
	name: "pi-agent-eval",
	toolName: "eval",
	toolCallId: "inline-1",
	providerIdentifier: "pi-agent",
	args: { code: new TextEncoder().encode(JSON.stringify("time.sleep(2)")) },
});
export const mcpCall = create(ToolCallSchema, {
	tool: { case: "mcpToolCall", value: create(McpToolCallSchema, { args: mcpArgs }) },
});
export const mcpExec = create(AgentServerMessageSchema, {
	message: {
		case: "execServerMessage",
		value: create(ExecServerMessageSchema, { id: 1, message: { case: "mcpArgs", value: mcpArgs } }),
	},
});
function interaction(message: InteractionUpdate["message"]): AgentServerMessage {
	return create(AgentServerMessageSchema, {
		message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, { message }) },
	});
}
export function started(toolCall: ToolCall, callId = "inline-1"): AgentServerMessage {
	return interaction({ case: "toolCallStarted", value: create(ToolCallStartedUpdateSchema, { toolCall, callId }) });
}
export function completed(toolCall: ToolCall, callId = "inline-1"): AgentServerMessage {
	return interaction({
		case: "toolCallCompleted",
		value: create(ToolCallCompletedUpdateSchema, { toolCall, callId }),
	});
}
export const partialMcp = interaction({
	case: "partialToolCall",
	value: create(PartialToolCallUpdateSchema, {
		callId: "inline-1",
		toolCall: mcpCall,
		argsTextDelta: '{"code":"partial"}',
	}),
});
export const deltaMcp = interaction({
	case: "toolCallDelta",
	value: create(ToolCallDeltaUpdateSchema, { callId: "inline-1" }),
});
export function text(text: string): AgentServerMessage {
	return interaction({ case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) });
}
export const turnEnded = interaction({ case: "turnEnded", value: create(TurnEndedUpdateSchema) });

export const cursorModel: Model<"cursor-agent"> = {
	id: "composer-2.5",
	name: "Cursor Composer 2.5",
	api: "cursor-agent",
	provider: "cursor",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 1000,
};

/** Real provider message processing, fake transport writer, no credentials or sockets. */
export function cursorMessages(messages: AgentServerMessage[], options: CursorOptions = {}) {
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "cursor-agent",
		provider: "cursor",
		model: cursorModel.id,
		stopReason: "stop",
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const stream = new AssistantMessageEventStream();
	const execResults: string[] = [];
	const handle = createCursorServerMessageHandlerForTest(
		output,
		stream,
		(frame, done) => {
			const message = fromBinary(AgentClientMessageSchema, frame.subarray(5));
			if (message.message.case === "execClientMessage") {
				const result = message.message.value.message;
				if (result.case === "mcpResult") execResults.push(result.value.result.case ?? "unset");
			}
			done();
			return true;
		},
		options,
	);
	void (async () => {
		stream.push({ type: "start", partial: output });
		for (const message of messages) {
			await handle(message);
			await Bun.sleep(0);
		}
		if (options.signal?.aborted) {
			output.stopReason = "aborted";
			stream.push({ type: "error", reason: "aborted", error: output });
		} else {
			stream.push({ type: "done", reason: "stop", message: output });
		}
		stream.end(output);
	})().catch(error => {
		output.stopReason = "error";
		output.errorMessage = String(error);
		stream.push({ type: "error", reason: "error", error: output });
		stream.end(output);
	});
	return { stream, execResults };
}

import type { AssistantMessage, Model } from "@gajae-code/ai";
import { Effort } from "@gajae-code/ai/model-thinking";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";

export const providerName = "gjc-app-server-stub";
export const api = "gjc-app-server-stub-api";

let toolCallCount = 0;

function configuredToolCall(): { name: string; arguments: Record<string, unknown> } | undefined {
	const rawSequence = process.env.GJC_TEST_MODEL_TOOL_SEQUENCE;
	if (rawSequence) {
		const parsed: unknown = JSON.parse(rawSequence);
		if (!Array.isArray(parsed)) throw new Error("GJC_TEST_MODEL_TOOL_SEQUENCE must encode a JSON array");
		const candidate = parsed[toolCallCount];
		if (candidate === undefined) return undefined;
		if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
			throw new Error("GJC_TEST_MODEL_TOOL_SEQUENCE entries must be JSON objects");
		}
		const name = candidate.name;
		const args = candidate.arguments;
		if (typeof name !== "string" || typeof args !== "object" || args === null || Array.isArray(args)) {
			throw new Error("GJC_TEST_MODEL_TOOL_SEQUENCE entries require name and object arguments");
		}
		return { name, arguments: args as Record<string, unknown> };
	}
	if (toolCallCount > 0) return undefined;

	const name = process.env.GJC_TEST_MODEL_TOOL_NAME;
	const rawArguments = process.env.GJC_TEST_MODEL_TOOL_ARGS;
	if (name && rawArguments) {
		const parsed: unknown = JSON.parse(rawArguments);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("GJC_TEST_MODEL_TOOL_ARGS must encode a JSON object");
		}
		return { name, arguments: parsed as Record<string, unknown> };
	}
	const command = process.env.GJC_TEST_MODEL_TOOL_COMMAND;
	return command ? { name: "bash", arguments: { command } } : undefined;
}

export function streamSimple(model: Model) {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const configured = configuredToolCall();
		if (configured) {
			toolCallCount++;
			const toolCall = {
				type: "toolCall" as const,
				id: "stub-tool-call",
				name: configured.name,
				arguments: configured.arguments,
			};
			const message: AssistantMessage = {
				role: "assistant" as const,
				content: [toolCall],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 3,
					output: 3,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 6,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse" as const,
				timestamp: 0,
			};
			stream.push({ type: "start", partial: message });
			stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
			const encoded = JSON.stringify(toolCall.arguments);
			stream.push({ type: "toolcall_delta", contentIndex: 0, delta: encoded, partial: message });
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
			stream.push({ type: "done", reason: "toolUse", message });
			stream.end(message);
			return;
		}

		const text = "Stub response.";
		const message: AssistantMessage = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 3,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 6,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 0,
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "Stub ", partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "response.", partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
	});
	return stream;
}

export const models = [
	{
		id: "gjc-app-server-stub-model",
		name: "GJC app-server stub",
		api,
		provider: providerName,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		thinking: { minLevel: Effort.Medium, maxLevel: Effort.Medium, levels: [Effort.Medium], mode: "effort" as const },
		contextWindow: 1_000_000,
		maxTokens: 4_096,
	},
];

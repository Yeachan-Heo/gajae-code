import type { AssistantMessage, Model } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";

export const providerName = "gjc-app-server-stub";
export const api = "gjc-app-server-stub-api";

export function streamSimple(model: Model) {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
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
		reasoning: false,
		contextWindow: 1_000_000,
		maxTokens: 4_096,
	},
];

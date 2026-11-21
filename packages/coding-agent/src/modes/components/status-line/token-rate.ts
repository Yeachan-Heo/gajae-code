const MIN_DURATION_MS = 100;

type AssistantUsage = {
	output: number;
};

type AssistantLikeMessage = {
	role: "assistant";
	timestamp: number;
	duration?: number;
	ttft?: number;
	usage: AssistantUsage;
};

type MaybeAssistantMessage = {
	role?: string;
	timestamp?: number;
	duration?: number;
	ttft?: number;
	usage?: {
		output?: number;
	};
};

function isAssistantMessage(message: MaybeAssistantMessage | undefined): message is AssistantLikeMessage {
	return (
		message?.role === "assistant" &&
		typeof message.timestamp === "number" &&
		message.usage !== undefined &&
		typeof message.usage.output === "number"
	);
}

function getLastAssistantMessage(messages: ReadonlyArray<MaybeAssistantMessage>): AssistantLikeMessage | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (isAssistantMessage(message)) {
			return message;
		}
	}
	return null;
}

export function calculateTokensPerSecond(
	messages: ReadonlyArray<MaybeAssistantMessage>,
	isStreaming: boolean,
	nowMs: number = Date.now(),
): number | null {
	const assistant = getLastAssistantMessage(messages);
	if (!assistant) return null;

	const outputTokens = assistant.usage.output;
	if (!Number.isFinite(outputTokens) || outputTokens <= 0) return null;

	const resolvedDurationMs =
		typeof assistant.duration === "number" && Number.isFinite(assistant.duration) && assistant.duration > 0
			? assistant.duration
			: isStreaming
				? nowMs - assistant.timestamp
				: null;

	if (resolvedDurationMs === null) return null;

	// Measure generation speed, not end-to-end latency: exclude time to first
	// token (queueing + prefill), which dominates on large contexts.
	const ttft = assistant.ttft;
	const generationMs =
		typeof ttft === "number" && Number.isFinite(ttft) && ttft >= 0 && ttft < resolvedDurationMs
			? resolvedDurationMs - ttft
			: resolvedDurationMs;
	if (generationMs < MIN_DURATION_MS) return null;

	const tokensPerSecond = (outputTokens * 1000) / generationMs;
	if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return null;

	return tokensPerSecond;
}

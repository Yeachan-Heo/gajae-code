// Live probe for issue #3900, via the CPA proxy configured in
// ~/.gjc/agent/models.yml (fallback credentials — no direct Anthropic key on
// this machine).
//
// Step 1: run a real tool-use turn with thinking enabled and capture the
//   genuinely signed thinking block.
// Step 2: tamper the thinking text (signature now mismatches), append the
//   tool_result, and continue the turn. Anthropic rejects exactly this shape
//   with the "thinking ... cannot be modified" 400; behind CPA it can arrive
//   as a statusless SSE error event. Expected: the provider classifies the
//   rejection, runs the thinking-replay repair, and the turn recovers.
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "../packages/ai/src/model-thinking";
import { streamAnthropic } from "../packages/ai/src/providers/anthropic";
import type { Context, Model, ToolResultMessage, UserMessage } from "../packages/ai/src/types";

const modelsYml = await Bun.file(path.join(os.homedir(), ".gjc", "agent", "models.yml")).text();
const anthropicBlock = /anthropic:\n(?:\s+.+\n?)+?(?=\n\S|$)/.exec(modelsYml)?.[0] ?? "";
const baseUrl = /baseUrl:\s*(\S+)/.exec(anthropicBlock)?.[1];
const apiKey = /apiKey:\s*"?([^"\n]+)"?/.exec(anthropicBlock)?.[1];
if (!baseUrl || !apiKey) throw new Error("models.yml fallback credentials not found");

const modelId = process.argv[2] ?? "claude-opus-5";
const model: Model<"anthropic-messages"> = {
	api: "anthropic-messages",
	provider: "anthropic",
	id: modelId,
	name: modelId,
	baseUrl,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 32_000,
	contextWindow: 200_000,
	reasoning: true,
	thinking: { mode: "anthropic-adaptive", minLevel: Effort.Minimal, maxLevel: Effort.XHigh },
};

const tools: Context["tools"] = [
	{
		name: "ping",
		description: "returns pong",
		parameters: { type: "object", properties: {}, required: [] } as never,
	},
];
const user: UserMessage = {
	role: "user",
	content: "Think briefly about why you must call the ping tool, then call it exactly once.",
	timestamp: Date.now(),
};

// Step 1: obtain a genuinely signed thinking + tool_use turn.
const firstTurn = await streamAnthropic(
	model,
	{ systemPrompt: ["Use the ping tool when asked."], tools, messages: [user] },
	{ apiKey, isOAuth: false, thinkingEnabled: true, effort: "xhigh", maxTokens: 4_096 },
).result();
const thinkingBlock = firstTurn.content.find(b => b.type === "thinking");
const toolCall = firstTurn.content.find(b => b.type === "toolCall");
if (firstTurn.stopReason !== "toolUse" || !toolCall) {
	console.log(JSON.stringify({ step: 1, stopReason: firstTurn.stopReason, error: firstTurn.errorMessage }));
	throw new Error("step 1 did not produce a tool_use turn");
}
const signature = thinkingBlock?.type === "thinking" ? thinkingBlock.thinkingSignature : undefined;
console.log(
	JSON.stringify({
		step: 1,
		stopReason: firstTurn.stopReason,
		hasSignedThinking: !!signature,
		signaturePrefix: signature?.slice(0, 12),
	}),
);

// Step 2: tamper the signed thinking text and continue with the tool result.
if (thinkingBlock?.type === "thinking") {
	thinkingBlock.thinking = `${thinkingBlock.thinking} [TAMPERED issue #3900]`;
}
const toolResult: ToolResultMessage = {
	role: "toolResult",
	toolCallId: toolCall.id,
	toolName: toolCall.name,
	content: [{ type: "text", text: "pong" }],
	isError: false,
	timestamp: Date.now() + 1,
};
const payloads: string[] = [];
const secondTurn = await streamAnthropic(
	model,
	{ systemPrompt: ["Use the ping tool when asked."], tools, messages: [user, firstTurn, toolResult] },
	{
		apiKey,
		isOAuth: false,
		thinkingEnabled: true,
		effort: "xhigh",
		maxTokens: 4_096,
		onPayload: payload => {
			payloads.push(JSON.stringify(payload));
			return undefined;
		},
	},
).result();

const report = {
	step: 2,
	baseUrl,
	model: modelId,
	requests: payloads.length,
	firstRequestHadTamperedThinking: payloads[0]?.includes("TAMPERED issue #3900") ?? false,
	lastRequestHadTamperedThinking: payloads.at(-1)?.includes("TAMPERED issue #3900") ?? false,
	stopReason: secondTurn.stopReason,
	errorMessage: secondTurn.errorMessage,
	text: secondTurn.content.filter(b => b.type === "text").map(b => (b as { text: string }).text),
};
console.log(JSON.stringify(report, null, 2));
if (secondTurn.stopReason !== "stop") process.exit(1);

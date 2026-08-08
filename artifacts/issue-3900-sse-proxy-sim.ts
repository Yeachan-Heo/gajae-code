// Issue #3900 wire-level simulation: a local proxy that behaves like
// CLIProxyAPI — it answers HTTP 200 and delivers Anthropic's 400 body as an
// in-stream SSE `error` event (the exact captured rejection). The second
// request succeeds. Runs the real streamAnthropic + Anthropic SDK transport,
// so it exercises iterateAnthropicEvents' statusless error throw and the
// thinking-replay repair end-to-end without any credentials.
import { streamAnthropic } from "../packages/ai/src/providers/anthropic";
import type { AssistantMessage, Context, Model, UserMessage } from "../packages/ai/src/types";

// `masked` reproduces the live 2026-08-06 CPA capture: the proxy replaces the
// upstream body entirely, so the client only sees a generic `api_error`.
const capturedError =
	process.argv[2] === "masked"
		? '{"type":"error","error":{"type":"api_error","message":"An error occurred while processing the request."}}'
		: '{"type":"error","error":{"type":"invalid_request_error","message":"messages.5.content.1: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response."}}';

const successFrames = [
	['message_start', '{"type":"message_start","message":{"id":"msg_sim","usage":{"input_tokens":1,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}'],
	['content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}'],
	['content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"recovered"}}'],
	['content_block_stop', '{"type":"content_block_stop","index":0}'],
	['message_delta', '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}'],
	['message_stop', '{"type":"message_stop"}'],
] as const;

const requestBodies: string[] = [];
const server = Bun.serve({
	port: 0,
	async fetch(req) {
		if (!new URL(req.url).pathname.endsWith("/v1/messages")) return new Response("not found", { status: 404 });
		requestBodies.push(await req.text());
		const frames =
			requestBodies.length === 1
				? [`event: error\ndata: ${capturedError}\n\n`]
				: successFrames.map(([event, data]) => `event: ${event}\ndata: ${data}\n\n`);
		return new Response(frames.join(""), {
			status: 200,
			headers: { "content-type": "text/event-stream", "request-id": `req_sim_${requestBodies.length}` },
		});
	},
});

const model: Model<"anthropic-messages"> = {
	api: "anthropic-messages",
	provider: "anthropic",
	id: "claude-opus-5",
	name: "claude-opus-5",
	baseUrl: `http://127.0.0.1:${server.port}`,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8_192,
	contextWindow: 200_000,
	reasoning: true,
};
const user: UserMessage = { role: "user", content: "first", timestamp: Date.now() };
const assistant: AssistantMessage = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "signed replay thinking", thinkingSignature: "sig_issue_3900" },
		{ type: "text", text: "history answer" },
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-opus-5",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};
const context: Context = {
	messages: [user, assistant, { ...user, content: "next prompt", timestamp: Date.now() + 1 }],
};

const result = await streamAnthropic(model, context, {
	apiKey: "sk-ant-api-sim",
	isOAuth: false,
	thinkingEnabled: true,
}).result();
server.stop(true);

const report = {
	requests: requestBodies.length,
	firstRequestHadSignedThinking: requestBodies[0]?.includes("sig_issue_3900") ?? false,
	repairedRequestDroppedThinking: requestBodies[1] !== undefined && !requestBodies[1].includes("sig_issue_3900"),
	stopReason: result.stopReason,
	errorMessage: result.errorMessage,
	text: result.content.filter(b => b.type === "text").map(b => (b as { text: string }).text),
};
console.log(JSON.stringify(report, null, 2));
if (result.stopReason !== "stop" || requestBodies.length !== 2 || !report.repairedRequestDroppedThinking) {
	process.exit(1);
}

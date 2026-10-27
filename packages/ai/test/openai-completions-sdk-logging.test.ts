import { afterEach, describe, expect, it, vi } from "bun:test";
import { logger } from "@gajae-code/utils";
import { getBundledModel } from "../src/models";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import type { Context, FetchImpl, Model } from "../src/types";

const model = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

function okSse(): Response {
	const events = [
		{
			id: "c",
			object: "chat.completion.chunk",
			created: 1,
			model: model.id,
			choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
		},
		"[DONE]",
	];
	return new Response(
		`${events.map(e => `data: ${typeof e === "string" ? e : JSON.stringify(e)}`).join("\n\n")}\n\n`,
		{
			status: 200,
			headers: { "content-type": "text/event-stream" },
		},
	);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("OpenAI completions SDK retry visibility", () => {
	it("logs SDK connection retries before response headers instead of retrying silently", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		let calls = 0;
		const fetchImpl: FetchImpl = Object.assign(
			async (): Promise<Response> => {
				calls += 1;
				if (calls === 1) throw new TypeError("socket hang up");
				return okSse();
			},
			{ preconnect: fetch.preconnect },
		);

		const stream = streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			requestMaxRetries: 1,
			fetch: fetchImpl,
		});
		for await (const _ of stream) {
		}
		const result = await stream.result();

		expect(calls).toBe(2);
		expect(result.stopReason).toBe("stop");
		const sdkLines = warn.mock.calls.map(call => String(call[0])).filter(line => line.startsWith("openai-sdk: "));
		expect(sdkLines).toHaveLength(1);
		expect(sdkLines[0]).toContain("retrying");
	});

	it("does not log successful requests", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const fetchImpl: FetchImpl = Object.assign(async (): Promise<Response> => okSse(), {
			preconnect: fetch.preconnect,
		});

		const stream = streamOpenAICompletions(model, context, { apiKey: "test-key", fetch: fetchImpl });
		for await (const _ of stream) {
		}

		expect(warn.mock.calls.filter(call => String(call[0]).startsWith("openai-sdk: "))).toHaveLength(0);
	});
});

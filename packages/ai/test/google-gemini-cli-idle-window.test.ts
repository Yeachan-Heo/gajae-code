import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { streamGoogleGeminiCli } from "../src/providers/register-builtins";
import type { AssistantMessage, Context, Model } from "../src/types";

/**
 * Cloud Code Assist emits a `functionCall` part only once the whole call has
 * been generated, so a large tool call leaves a long silent gap after the
 * preceding text chunks. The outer lazy-stream idle watchdog must not fire
 * inside that gap under the default configuration.
 */

const context: Context = {
	messages: [{ role: "user", content: "write the file", timestamp: 0 }],
	tools: [],
};

const model: Model<"google-gemini-cli"> = {
	id: "gemini-test",
	name: "Gemini Test",
	api: "google-gemini-cli",
	provider: "google-antigravity",
	baseUrl: "https://gemini-cli.example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 128,
};

function sse(response: unknown): string {
	return `data: ${JSON.stringify({ response })}\n\n`;
}

const TEXT_CHUNK = sse({
	candidates: [{ content: { role: "model", parts: [{ text: "Writing the file now." }] } }],
});

const FUNCTION_CALL_CHUNK = sse({
	candidates: [
		{
			content: {
				role: "model",
				parts: [{ functionCall: { name: "write", args: { path: "out.md", content: "large body" } } }],
			},
			finishReason: "STOP",
		},
	],
	usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
});

/** Text arrives immediately; the function-call chunk arrives `gapMs` later (or never). */
function textThenFunctionCall(gapMs: number | undefined): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(TEXT_CHUNK));
			if (gapMs === undefined) return;
			setTimeout(() => {
				controller.enqueue(encoder.encode(FUNCTION_CALL_CHUNK));
				controller.close();
			}, gapMs);
		},
		cancel() {},
	});
}

function start(gapMs: number | undefined) {
	return streamGoogleGeminiCli(model, context, {
		apiKey: JSON.stringify({ token: "oauth-token", projectId: "project-id" }),
		fetch: async () =>
			new Response(textThenFunctionCall(gapMs), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
	});
}

async function flush(ticks = 50): Promise<void> {
	for (let i = 0; i < ticks; i++) await Promise.resolve();
}

async function advance(ms: number): Promise<void> {
	await flush();
	vi.advanceTimersByTime(ms);
	await flush();
}

function trackSettled(result: Promise<AssistantMessage>): () => boolean {
	let settled = false;
	void result.then(() => {
		settled = true;
	});
	return () => settled;
}

const ENV_KEYS = [
	"PI_STREAM_IDLE_TIMEOUT_MS",
	"PI_OPENAI_STREAM_IDLE_TIMEOUT_MS",
	"GJC_OPENAI_STREAM_IDLE_TIMEOUT_MS",
	"PI_STREAM_FIRST_EVENT_TIMEOUT_MS",
] as const;

describe("google-gemini-cli outer idle window", () => {
	const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			originalEnv[key] = Bun.env[key];
			delete Bun.env[key];
		}
	});

	afterEach(() => {
		vi.useRealTimers();
		for (const key of ENV_KEYS) {
			const prior = originalEnv[key];
			if (prior === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = prior;
			}
		}
	});

	it("survives a 200s silent gap before a large function call", async () => {
		vi.useFakeTimers();
		const stream = start(200_000);
		const settled = trackSettled(stream.result());

		// Past the shared 120s idle default: the stream must still be alive.
		await advance(150_000);
		expect(settled()).toBe(false);

		await advance(50_000);
		const result = await stream.result();
		expect(result.errorMessage).toBeUndefined();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toContainEqual(expect.objectContaining({ type: "toolCall", name: "write" }));
	});

	it("still reports a stall once the 300s idle window elapses", async () => {
		vi.useFakeTimers();
		const stream = start(undefined);
		const settled = trackSettled(stream.result());

		await advance(299_000);
		expect(settled()).toBe(false);

		await advance(1_000);
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider stream stalled while waiting for the next event");
	});

	it("keeps an explicit streamIdleTimeoutMs ahead of the provider floor", async () => {
		const stream = streamGoogleGeminiCli(model, context, {
			apiKey: JSON.stringify({ token: "oauth-token", projectId: "project-id" }),
			streamIdleTimeoutMs: 20,
			fetch: async () =>
				new Response(textThenFunctionCall(undefined), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		});
		const result = await Promise.race([stream.result(), Bun.sleep(2_000).then(() => "timeout" as const)]);
		expect(result).not.toBe("timeout");
		if (result === "timeout") throw new Error("explicit idle override did not bound the stream");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider stream stalled while waiting for the next event");
	});
});

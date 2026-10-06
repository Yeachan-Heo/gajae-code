import { describe, expect, it } from "bun:test";
import { streamGoogleGeminiCli } from "../src/providers/register-builtins";
import type { Context, Model } from "../src/types";

const context: Context = {
	messages: [{ role: "user", content: "redacted prompt", timestamp: 0 }],
	tools: [],
};

const model: Model<"google-gemini-cli"> = {
	id: "gemini-test",
	name: "Gemini Test",
	api: "google-gemini-cli",
	provider: "google-gemini-cli",
	baseUrl: "https://gemini-cli.example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 128,
};

function neverEndingBody(firstChunk?: string): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			if (firstChunk !== undefined) controller.enqueue(encoder.encode(firstChunk));
		},
		cancel() {},
	});
}

async function run(firstChunk?: string) {
	const stream = streamGoogleGeminiCli(model, context, {
		apiKey: JSON.stringify({ token: "oauth-token", projectId: "project-id" }),
		streamFirstEventTimeoutMs: 20,
		streamIdleTimeoutMs: 1000,
		fetch: async () =>
			new Response(neverEndingBody(firstChunk), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
	});
	return stream.result();
}

describe("google-gemini-cli first-event diagnostics", () => {
	it("distinguishes headers with no raw SSE data", async () => {
		const result = await run();
		const diagnostics = result.googleGeminiCliDiagnostics;

		expect(result.stopReason).toBe("error");
		expect(diagnostics?.responseAtMs).toBeGreaterThanOrEqual(0);
		expect(diagnostics?.firstRawSseAtMs).toBeUndefined();
		expect(diagnostics?.chunkCounts).toEqual({ content: 0, thinking: 0, functionCall: 0, usageOnly: 0, other: 0 });
		expect(diagnostics?.firstEventTimeoutMs).toBe(20);
		expect(diagnostics?.firstEventTimeoutSource).toBe("stream-option");
	});

	it("distinguishes usage-only raw SSE data", async () => {
		const result = await run(
			`data: ${JSON.stringify({ response: { usageMetadata: { promptTokenCount: 1, totalTokenCount: 1 } } })}\n\n`,
		);
		const diagnostics = result.googleGeminiCliDiagnostics;

		expect(diagnostics?.responseAtMs).toBeGreaterThanOrEqual(0);
		expect(diagnostics?.firstRawSseAtMs).toBeGreaterThanOrEqual(0);
		expect(diagnostics?.chunkCounts.usageOnly).toBeGreaterThan(0);
		expect(diagnostics?.chunkCounts.content).toBe(0);
		expect(diagnostics?.firstEventTimeoutMs).toBe(20);
		expect(diagnostics?.firstEventTimeoutSource).toBe("stream-option");
	});

	it("keeps serialized errors redacted", async () => {
		const result = await run();
		const serialized = JSON.stringify(result);

		expect(serialized).not.toContain("oauth-token");
		expect(serialized).not.toContain("project-id");
		expect(serialized).not.toContain("redacted prompt");
	});
});

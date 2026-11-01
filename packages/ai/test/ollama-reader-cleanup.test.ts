import { expect, it } from "bun:test";
import { streamOllama } from "../src/providers/ollama";
import type { Model } from "../src/types";

const model: Model<"ollama-chat"> = {
	id: "qwen3:latest",
	name: "Qwen 3",
	api: "ollama-chat",
	provider: "ollama",
	baseUrl: "http://127.0.0.1:11434",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32768,
	maxTokens: 8192,
};

it("cancels and releases the response reader after Ollama's terminal chunk", async () => {
	let cancels = 0;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('{"message":{"content":"hello"},"done":true,"eval_count":1}\n'));
		},
		cancel() {
			cancels++;
		},
	});
	const result = await streamOllama(
		model,
		{ messages: [] },
		{ apiKey: "test", fetch: async () => new Response(body), requestMaxRetries: 0 },
	).result();
	expect(result.stopReason).toBe("stop");
	expect(cancels).toBe(1);
	expect(body.locked).toBe(false);
});

it("releases the reader after malformed NDJSON and keeps the parse error", async () => {
	let cancels = 0;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("invalid json\n"));
		},
		cancel() {
			cancels++;
		},
	});
	const result = await streamOllama(
		model,
		{ messages: [] },
		{ apiKey: "test", fetch: async () => new Response(body), requestMaxRetries: 0 },
	).result();
	expect(result.stopReason).toBe("error");
	expect(cancels).toBe(1);
	expect(body.locked).toBe(false);
});

it("does not wait for a stalled cancellation promise", async () => {
	let cancels = 0;
	const pending = Promise.withResolvers<void>();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('{"done":true}\n'));
		},
		cancel() {
			cancels++;
			return pending.promise;
		},
	});
	const events = streamOllama(
		model,
		{ messages: [] },
		{ apiKey: "test", fetch: async () => new Response(body), requestMaxRetries: 0 },
	);
	const result = await Promise.race([events.result(), Bun.sleep(100).then(() => null)]);
	pending.resolve();
	await events.result();
	expect(result?.stopReason).toBe("stop");
	expect(cancels).toBe(1);
	expect(body.locked).toBe(false);
});

it("releases an exhausted body without adding a terminal event", async () => {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.close();
		},
	});
	const result = await streamOllama(
		model,
		{ messages: [] },
		{ apiKey: "test", fetch: async () => new Response(body), requestMaxRetries: 0 },
	).result();
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toContain("before terminal done chunk");
	expect(body.locked).toBe(false);
});

it("keeps the terminal result when transport cancellation rejects", async () => {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('{"done":true}\n'));
		},
		cancel() {
			return Promise.reject(new Error("cleanup failed"));
		},
	});
	const result = await streamOllama(
		model,
		{ messages: [] },
		{ apiKey: "test", fetch: async () => new Response(body), requestMaxRetries: 0 },
	).result();
	expect(result.stopReason).toBe("stop");
	expect(body.locked).toBe(false);
	await Bun.sleep(1);
});

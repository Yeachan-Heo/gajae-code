import { expect, it } from "bun:test";
import { clearGitLabDuoDirectAccessCache, getGitLabDuoModels } from "../src/providers/gitlab-duo";
import { streamSimple } from "../src/stream";
import type { FetchImpl } from "../src/types";

it("cancels a stalled GitLab direct-access request through streamSimple", async () => {
	clearGitLabDuoDirectAccessCache();
	const model = getGitLabDuoModels()[0]!;
	const controller = new AbortController();
	const entered = Promise.withResolvers<void>();
	const pending = Promise.withResolvers<Response>();
	let requestSignal: AbortSignal | null | undefined;
	const fakeFetch: FetchImpl = async (_url, init) => {
		requestSignal = init?.signal;
		requestSignal?.addEventListener("abort", () => pending.reject(requestSignal?.reason), { once: true });
		entered.resolve();
		return pending.promise;
	};
	const events = streamSimple(
		model,
		{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
		{ apiKey: "test-gitlab-cancel", fetch: fakeFetch, signal: controller.signal },
	);
	await entered.promise;
	controller.abort(new Error("caller cancelled"));
	const settled = await Promise.race([events.result(), Bun.sleep(100).then(() => null)]);
	pending.resolve(new Response("cleanup", { status: 403 }));
	await events.result();
	expect(requestSignal).toBe(controller.signal);
	expect(settled?.stopReason).toBe("aborted");
});

for (const api of ["anthropic-messages", "openai-completions", "openai-responses"] as const) {
	for (const phase of ["first", "idle"] as const) {
		it(`forwards ${phase}-event watchdog through GitLab ${api}`, async () => {
			clearGitLabDuoDirectAccessCache();
			const model = getGitLabDuoModels().find(model => model.api === api)!;
			const caller = new AbortController();
			let finishBody: (() => void) | undefined;
			const fakeFetch: FetchImpl = async (input, init) => {
				if (String(input).includes("direct_access"))
					return Response.json({ token: "synthetic-token", headers: {} });
				const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						const fail = () => controller.error(signal?.reason ?? new Error("aborted"));
						signal?.addEventListener("abort", fail, { once: true });
						finishBody = () => {
							signal?.removeEventListener("abort", fail);
							try {
								controller.error(new Error("test cleanup"));
							} catch {}
						};
						if (phase === "idle") {
							const frame =
								api === "anthropic-messages"
									? 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-test","type":"message","role":"assistant","content":[],"model":"claude","stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n'
									: api === "openai-completions"
										? 'data: {"id":"chat-test","object":"chat.completion.chunk","created":0,"model":"test","choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n'
										: 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"item-test","output_index":0,"content_index":0,"delta":"hello"}\n\n';
							controller.enqueue(new TextEncoder().encode(frame));
						}
					},
					cancel() {
						finishBody?.();
					},
				});
				return new Response(body, { headers: { "content-type": "text/event-stream" } });
			};
			const events = streamSimple(
				model,
				{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
				{
					apiKey: `watchdog-${api}-${phase}`,
					fetch: fakeFetch,
					signal: caller.signal,
					streamFirstEventTimeoutMs: phase === "first" ? 10 : 1000,
					streamIdleTimeoutMs: phase === "idle" ? 10 : 1000,
					requestMaxRetries: 0,
					streamMaxRetries: 0,
					disableProviderRetries: true,
				},
			);
			const result = await Promise.race([events.result(), Bun.sleep(250).then(() => null)]);
			caller.abort();
			finishBody?.();
			await events.result();
			expect(result?.stopReason).toBe("error");
			expect(JSON.stringify(result)).toContain(phase === "first" ? "first event" : "next event");
		});
	}
}

it("pre-aborted GitLab requests do not start token acquisition", async () => {
	clearGitLabDuoDirectAccessCache();
	const caller = new AbortController();
	caller.abort(new Error("already cancelled"));
	let calls = 0;
	const result = await streamSimple(
		getGitLabDuoModels()[0]!,
		{ messages: [] },
		{
			apiKey: "preaborted",
			signal: caller.signal,
			fetch: async () => {
				calls++;
				return new Response("unexpected", { status: 403 });
			},
		},
	).result();
	expect(calls).toBe(0);
	expect(result.stopReason).toBe("aborted");
});

it("keeps ordinary GitLab token errors as errors", async () => {
	clearGitLabDuoDirectAccessCache();
	const result = await streamSimple(
		getGitLabDuoModels()[0]!,
		{ messages: [] },
		{ apiKey: "denied", fetch: async () => new Response("synthetic denial", { status: 403 }) },
	).result();
	expect(result.stopReason).toBe("error");
	expect(JSON.stringify(result)).toContain("access denied");
});

it("reuses a cached GitLab token and completes inference", async () => {
	clearGitLabDuoDirectAccessCache();
	const model = getGitLabDuoModels().find(model => model.api === "openai-completions")!;
	let tokenRequests = 0;
	let inferenceRequests = 0;
	const fakeFetch: FetchImpl = async input => {
		if (String(input).includes("direct_access")) {
			tokenRequests++;
			return Response.json({ token: "cached-token", headers: {} });
		}
		inferenceRequests++;
		return new Response(
			'data: {"id":"chat-test","object":"chat.completion.chunk","created":0,"model":"test","choices":[{"index":0,"delta":{"content":"hello"}}]}\n\ndata: {"id":"chat-test","object":"chat.completion.chunk","created":0,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
			{ headers: { "content-type": "text/event-stream" } },
		);
	};
	for (let i = 0; i < 2; i++) {
		const result = await streamSimple(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{ apiKey: "cached-test", fetch: fakeFetch, streamFirstEventTimeoutMs: 1000, streamIdleTimeoutMs: 1000 },
		).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toContainEqual({ type: "text", text: "hello" });
	}
	expect(tokenRequests).toBe(1);
	expect(inferenceRequests).toBe(2);
});

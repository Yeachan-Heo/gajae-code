import { afterEach, describe, expect, test, vi } from "bun:test";
import {
	cancelMCPStream,
	MCP_MAX_CONTENT_BYTES,
	MCP_MAX_SSE_BATCH_MESSAGES,
	MCP_MAX_SSE_REQUEST_MESSAGES,
	readMCPResponseText,
} from "../../src/runtime-mcp/content-limits";
import { callMCP } from "../../src/runtime-mcp/json-rpc";
import { HttpTransport } from "../../src/runtime-mcp/transports/http";

const transports: HttpTransport[] = [];

function fetchImplementation(implementation: (...args: Parameters<typeof fetch>) => Promise<Response>): typeof fetch {
	return Object.assign(implementation, { preconnect() {} });
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(transports.splice(0).map(transport => transport.close()));
});

function responseStream(chunks: Uint8Array[], onCancel?: () => void, keepOpen = false): ReadableStream<Uint8Array> {
	let index = 0;
	return new ReadableStream({
		pull(controller) {
			const chunk = chunks[index++];
			if (chunk) controller.enqueue(chunk);
			else if (!keepOpen) controller.close();
		},
		cancel: onCancel,
	});
}

const throwCleanup = () => {
	throw new Error("cleanup");
};

async function createTransport(timeout = 30_000): Promise<HttpTransport> {
	const transport = new HttpTransport({ type: "http", url: "https://example.invalid", timeout });
	transports.push(transport);
	await transport.connect();
	return transport;
}

describe("MCP remote content limits", () => {
	test("bounded reader handles exact limits, tiny chunks, and hostile cancellation", async () => {
		const body = new TextEncoder().encode('{"ok":true}');
		const tiny = Array.from(body, byte => Uint8Array.of(byte));
		await expect(readMCPResponseText(new Response(responseStream(tiny)), body.length)).resolves.toBe('{"ok":true}');
		let cancelled = 0;
		const oversized = new ReadableStream<Uint8Array>({ cancel: () => void cancelled++ });
		await expect(
			readMCPResponseText(
				new Response(oversized, { headers: { "Content-Length": String(body.length + 1) } }),
				body.length,
			),
		).rejects.toThrow("MCP response exceeds size limit");
		expect(cancelled).toBe(1);
		cancelMCPStream(new ReadableStream({ cancel: () => Promise.reject(new Error("async")) }));
		cancelMCPStream(new ReadableStream({ cancel: () => Promise.withResolvers<void>().promise }));
		const controller = new AbortController();
		const pending = readMCPResponseText(
			new Response(new ReadableStream({ cancel: throwCleanup })),
			1,
			false,
			controller.signal,
		);
		controller.abort();
		await expect(pending).rejects.toHaveProperty("name", "AbortError");
	});

	test("HTTP transport rejects Content-Length and chunked JSON overflow before parsing and cancels", async () => {
		let cancelled = 0;
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response("{}", { headers: { "Content-Length": String(MCP_MAX_CONTENT_BYTES + 1) } }),
			)
			.mockResolvedValueOnce(
				new Response(
					responseStream([new Uint8Array(MCP_MAX_CONTENT_BYTES), Uint8Array.of(1)], () => cancelled++, true),
				),
			);
		const transport = await createTransport();
		await expect(transport.request("resources/read")).rejects.toThrow("MCP response exceeds size limit");
		await expect(transport.request("resources/read")).rejects.toThrow("MCP response exceeds size limit");
		expect(cancelled).toBe(1);
	});

	test("per-request SSE rejects oversized batches and message floods", async () => {
		const batch = Array.from({ length: MCP_MAX_SSE_BATCH_MESSAGES + 1 }, () => ({ jsonrpc: "2.0", method: "ping" }));
		const events = Array.from(
			{ length: MCP_MAX_SSE_REQUEST_MESSAGES + 1 },
			() => 'data: {"jsonrpc":"2.0","method":"ping"}\n\n',
		).join("");
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(`data: ${JSON.stringify(batch)}\n\n`, { headers: { "Content-Type": "text/event-stream" } }),
			)
			.mockResolvedValueOnce(new Response(events, { headers: { "Content-Type": "text/event-stream" } }));
		const transport = await createTransport(1_000);
		await expect(transport.request("tools/list")).rejects.toThrow("MCP SSE batch exceeds message limit");
		await expect(transport.request("tools/list")).rejects.toThrow("MCP SSE response exceeds message limit");
	});

	test("background SSE reports a payload-free size error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(new Uint8Array(MCP_MAX_CONTENT_BYTES + 1), { headers: { "Content-Type": "text/event-stream" } }),
		);
		const transport = await createTransport();
		const error = Promise.withResolvers<Error>();
		transport.onError = error.resolve;
		await transport.startSSEListener();
		expect((await error.promise).message).toBe("SSE event exceeds size limit");
	});

	test("persistent SSE times out headers without expiring an established body", async () => {
		let attempt = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			fetchImplementation(async (_url, init) => {
				if (attempt++ === 0) {
					const { promise, reject } = Promise.withResolvers<Response>();
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
					return promise;
				}
				return new Response(
					new ReadableStream({
						async start(controller) {
							await Bun.sleep(50);
							if (init?.signal?.aborted) return controller.error(init.signal.reason);
							controller.enqueue(new TextEncoder().encode('data: {"jsonrpc":"2.0","method":"late"}\n\n'));
							controller.close();
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			}),
		);
		const transport = await createTransport(25);
		const error = Promise.withResolvers<Error>();
		transport.onError = error.resolve;
		await transport.startSSEListener();
		expect((await error.promise).message).toBe("SSE connection timeout after 25ms");
		const notification = Promise.withResolvers<string>();
		transport.onNotification = method => notification.resolve(method);
		await transport.startSSEListener();
		await expect(notification.promise).resolves.toBe("late");
	});

	test("bounded HTTP errors still trigger 401 refresh and truncate other error bodies", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("denied", { status: 401 }))
			.mockImplementationOnce(
				fetchImplementation(async (_url, init) => {
					const request = JSON.parse(String(init?.body)) as { id: string | number };
					return Response.json({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
				}),
			)
			.mockResolvedValueOnce(new Response("x".repeat(20_000), { status: 500 }));
		const transport = await createTransport();
		transport.onAuthError = async () => ({ Authorization: "Bearer refreshed" });
		await expect(transport.request("tools/list")).resolves.toEqual({ ok: true });
		await expect(transport.request("tools/list")).rejects.toThrow(/^HTTP 500: x+\u2026$/);
	});

	test("notify keeps its deadline while reading a stalled error body", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			fetchImplementation(
				async (_url, init) =>
					new Response(
						new ReadableStream({
							start: controller =>
								init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason)),
						}),
						{ status: 500 },
					),
			),
		);
		const transport = await createTransport(25);
		await expect(transport.notify("notifications/initialized")).rejects.toThrow("Notify timeout after 25ms");
	});

	test("legacy callMCP accepts JSON and SSE but rejects oversized bodies and cancels", async () => {
		let cancelled = 0;
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", id: 1, result: { ok: true } }))
			.mockResolvedValueOnce(new Response('data: {"jsonrpc":"2.0","id":1,"result":{"sse":true}}\n\n'))
			.mockResolvedValueOnce(
				new Response(
					responseStream([new Uint8Array(MCP_MAX_CONTENT_BYTES), Uint8Array.of(1)], () => cancelled++, true),
				),
			);
		await expect(callMCP("https://example.invalid", "tools/list")).resolves.toMatchObject({ result: { ok: true } });
		await expect(callMCP("https://example.invalid", "tools/list")).resolves.toMatchObject({ result: { sse: true } });
		await expect(callMCP("https://example.invalid", "resources/read")).rejects.toThrow(
			"MCP response exceeds size limit",
		);
		expect(cancelled).toBe(1);
	});

	test("legacy callMCP keeps one deadline across headers and body reads", async () => {
		const headerTimeout = new AbortController();
		const bodyTimeout = new AbortController();
		const bodyStarted = Promise.withResolvers<void>();
		vi.spyOn(AbortSignal, "timeout")
			.mockReturnValueOnce(headerTimeout.signal)
			.mockReturnValueOnce(bodyTimeout.signal);
		vi.spyOn(globalThis, "fetch")
			.mockImplementationOnce(
				fetchImplementation(async (_url, init) => {
					const { promise, reject } = Promise.withResolvers<Response>();
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
					return promise;
				}),
			)
			.mockImplementationOnce(
				fetchImplementation(
					async (_url, _init) =>
						new Response(
							new ReadableStream({
								start() {
									bodyStarted.resolve();
								},
							}),
						),
				),
			);

		const pendingHeaders = callMCP("https://example.invalid", "tools/list");
		headerTimeout.abort(new DOMException("The operation timed out", "TimeoutError"));
		await expect(pendingHeaders).rejects.toThrow("MCP request timed out");

		const pendingBody = callMCP("https://example.invalid", "tools/list");
		await bodyStarted.promise;
		bodyTimeout.abort(new DOMException("The operation timed out", "TimeoutError"));
		await expect(pendingBody).rejects.toThrow("MCP request timed out");
	});

	test("legacy callMCP preserves errors unrelated to an expired deadline", async () => {
		const timeout = new AbortController();
		timeout.abort(new DOMException("The operation timed out", "TimeoutError"));
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network failed before timeout"));

		await expect(callMCP("https://example.invalid", "tools/list")).rejects.toThrow("network failed before timeout");
	});
});

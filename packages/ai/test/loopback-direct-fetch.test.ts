import { afterEach, describe, expect, test } from "bun:test";
import type { FetchImpl } from "../src/types";
import { createLoopbackDirectFetch, fetchLoopbackDirect } from "../src/utils/loopback-transport";

describe("fetchLoopbackDirect", () => {
	const servers: ReturnType<typeof Bun.serve>[] = [];

	afterEach(() => {
		for (const server of servers.splice(0)) server.stop(true);
	});

	function serve(handler: (request: Request) => Response | Promise<Response>) {
		const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
		servers.push(server);
		return server;
	}

	test("fetches a loopback endpoint by address and by localhost", async () => {
		const server = serve(request => new Response(`path=${new URL(request.url).pathname}`));
		const byAddress = await fetchLoopbackDirect(new URL(`http://127.0.0.1:${server.port}/v1/models`));
		expect(byAddress.status).toBe(200);
		expect(await byAddress.text()).toBe("path=/v1/models");

		const byName = await fetchLoopbackDirect(new URL(`http://localhost:${server.port}/v1/models`));
		expect(byName.status).toBe(200);
		expect(await byName.text()).toBe("path=/v1/models");
	});

	test("refuses a non-loopback endpoint", async () => {
		await expect(fetchLoopbackDirect(new URL("https://api.example.com/v1/models"))).rejects.toThrow(
			"requires a loopback host",
		);
	});

	test("returns a redirect instead of following it", async () => {
		const server = serve(
			() => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1:9/v1/models" } }),
		);
		const response = await fetchLoopbackDirect(new URL(`http://127.0.0.1:${server.port}/v1/models`));
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("http://127.0.0.1:9/v1/models");
	});

	test("aborts a stalled server through the caller's deadline", async () => {
		const server = serve(() => new Promise<Response>(() => {}));
		const startedAt = performance.now();
		await expect(
			fetchLoopbackDirect(new URL(`http://127.0.0.1:${server.port}/v1/models`), {
				signal: AbortSignal.timeout(250),
			}),
		).rejects.toThrow();
		expect(performance.now() - startedAt).toBeLessThan(2_000);
	});

	test("aborts while the response body is still streaming", async () => {
		const server = serve(
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{"data":['));
						},
					}),
					{ headers: { "content-type": "application/json" } },
				),
		);
		const startedAt = performance.now();
		// Headers arrive before the body finishes, so the abort surfaces on the
		// streamed body rather than on the initial request promise.
		const response = await fetchLoopbackDirect(new URL(`http://127.0.0.1:${server.port}/v1/models`), {
			signal: AbortSignal.timeout(250),
		});
		await expect(response.text()).rejects.toThrow();
		expect(performance.now() - startedAt).toBeLessThan(2_000);
	});

	test("streams an SSE completion body sent with a POST", async () => {
		const requests: { method: string; authorization: string | null; body: string }[] = [];
		const server = serve(async request => {
			requests.push({
				method: request.method,
				authorization: request.headers.get("authorization"),
				body: await request.text(),
			});
			const encoder = new TextEncoder();
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode("data: one\n\n"));
					controller.enqueue(encoder.encode("data: two\n\ndata: [DONE]\n\n"));
					controller.close();
				},
			});
			return new Response(stream, { headers: { "content-type": "text/event-stream" } });
		});

		const response = await fetchLoopbackDirect(new URL(`http://127.0.0.1:${server.port}/v1/chat/completions`), {
			method: "POST",
			headers: { authorization: "Bearer local-secret", "content-type": "application/json" },
			body: new TextEncoder().encode(JSON.stringify({ prompt: "hello" })),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		const chunks: string[] = [];
		for await (const chunk of response.body!) chunks.push(new TextDecoder().decode(chunk));
		expect(chunks.join("")).toBe("data: one\n\ndata: two\n\ndata: [DONE]\n\n");
		expect(requests).toEqual([
			{
				method: "POST",
				authorization: "Bearer local-secret",
				body: JSON.stringify({ prompt: "hello" }),
			},
		]);
	});

	test("routes loopback through the direct transport and delegates the rest", async () => {
		const server = serve(request => new Response(`direct path=${new URL(request.url).pathname}`));
		const delegated: string[] = [];
		const directFetch = createLoopbackDirectFetch((async (input: string | URL | Request) => {
			delegated.push(String(input instanceof Request ? input.url : input));
			return new Response("delegated");
		}) as FetchImpl);

		const loopback = await directFetch(`http://127.0.0.1:${server.port}/v1/models`);
		expect(await loopback.text()).toBe("direct path=/v1/models");
		expect(delegated).toEqual([]);

		// A fully qualified name still resolves to loopback; routing it through the
		// ambient fetch would hand its credential to the environment proxy.
		const fqdn = await directFetch(`http://localhost.:${server.port}/v1/models`);
		expect(await fqdn.text()).toBe("direct path=/v1/models");
		expect(delegated).toEqual([]);

		const remote = await directFetch("https://api.example.com/v1/chat/completions", { method: "POST" });
		expect(await remote.text()).toBe("delegated");
		expect(delegated).toEqual(["https://api.example.com/v1/chat/completions"]);
	});
});

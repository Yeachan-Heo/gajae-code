import { afterEach, describe, expect, test } from "bun:test";
import { fetchLoopbackDirect } from "../src/utils/discovery/openai-compatible";

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
		await expect(
			fetchLoopbackDirect(new URL(`http://127.0.0.1:${server.port}/v1/models`), {
				signal: AbortSignal.timeout(250),
			}),
		).rejects.toThrow();
		expect(performance.now() - startedAt).toBeLessThan(2_000);
	});
});

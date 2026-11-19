import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { stream } from "../src/stream";
import type { FetchImpl, Model } from "../src/types";

/**
 * The direct loopback transport belongs to the Rapid-MLX provider, not to every
 * endpoint that happens to be loopback. These regressions pin the boundary:
 *
 * - A non-Rapid-MLX loopback provider keeps the documented proxy behaviour
 *   (`docs/models.md`, implicit SGLang/vLLM discovery: proxy environment
 *   variables remain explicit transport configuration; use `NO_PROXY` to
 *   connect directly).
 * - Rapid-MLX never reaches the proxy, keyed or keyless (covered end to end by
 *   `packages/coding-agent/test/rapid-mlx-inference-proxy.test.ts`).
 * - A caller-supplied `fetch` wins for both, because it owns its transport.
 *
 * The proxy decision is made once per process, so the proxy cases run the client
 * in a child process with `HTTP_PROXY` planted at startup.
 */
describe("loopback direct transport scoping", () => {
	const servers: ReturnType<typeof Bun.serve>[] = [];

	afterEach(() => {
		for (const server of servers.splice(0)) server.stop(true);
	});

	const PROMPT_CANARY = "PROMPT-CANARY-5c1e";
	const KEY_CANARY = "loopback-secret-CANARY-8b2f";

	interface ObservedRequest {
		method: string;
		url: string;
		authorization: string | null;
		body: string;
	}

	function sseResponse(text: string): Response {
		const chunk = (delta: object, finishReason: string | null) =>
			`data: ${JSON.stringify({
				id: "chunk-1",
				object: "chat.completion.chunk",
				created: 1,
				model: "test/local-model",
				choices: [{ index: 0, delta, finish_reason: finishReason }],
			})}\n\n`;
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(chunk({ role: "assistant", content: "" }, null)));
				controller.enqueue(encoder.encode(chunk({ content: text }, null)));
				controller.enqueue(
					encoder.encode(
						chunk({}, "stop") +
							`data: ${JSON.stringify({
								id: "chunk-1",
								object: "chat.completion.chunk",
								created: 1,
								model: "test/local-model",
								choices: [],
								usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
							})}\n\n` +
							"data: [DONE]\n\n",
					),
				);
				controller.close();
			},
		});
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	}

	function boundPort(server: ReturnType<typeof Bun.serve>): number {
		if (server.port === undefined) throw new Error("server did not bind a TCP port");
		return server.port;
	}

	async function observe(request: Request): Promise<ObservedRequest> {
		return {
			method: request.method,
			url: request.url,
			authorization: request.headers.get("authorization"),
			body: request.method === "GET" ? "" : await request.text(),
		};
	}

	function serveModelEndpoint(requests: ObservedRequest[], text: string) {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request) {
				requests.push(await observe(request));
				if (new URL(request.url).pathname.endsWith("/chat/completions")) return sseResponse(text);
				return new Response("not found", { status: 404 });
			},
		});
		servers.push(server);
		return server;
	}

	async function runProbe(
		provider: string,
		baseUrl: string,
		proxyPort: number,
	): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		const child = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "fixtures", "loopback-transport-scope-probe.ts"), "completion"],
			{
				cwd: path.resolve(import.meta.dir, ".."),
				env: {
					...process.env,
					PROBE_PROVIDER: provider,
					PROBE_BASE_URL: baseUrl,
					PROBE_API_KEY: KEY_CANARY,
					PROBE_PROMPT: PROMPT_CANARY,
					HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
					http_proxy: `http://127.0.0.1:${proxyPort}`,
					HTTPS_PROXY: "",
					https_proxy: "",
					ALL_PROXY: "",
					all_proxy: "",
					NO_PROXY: "",
					no_proxy: "",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { exitCode, stdout, stderr };
	}

	test("a non-Rapid-MLX loopback provider keeps traversing the configured proxy", async () => {
		const serverRequests: ObservedRequest[] = [];
		const modelServer = serveModelEndpoint(serverRequests, "from-local-server");
		const proxyRequests: ObservedRequest[] = [];
		const proxy = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request) {
				proxyRequests.push(await observe(request));
				if (new URL(request.url).pathname.endsWith("/chat/completions"))
					return sseResponse("from-configured-proxy");
				return new Response("control", { status: 200 });
			},
		});
		servers.push(proxy);

		const result = await runProbe("sglang", `http://127.0.0.1:${boundPort(modelServer)}/v1`, boundPort(proxy));

		expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
		// The documented SGLang contract: proxy variables are transport
		// configuration, so the completion goes through the proxy.
		expect(JSON.parse(result.stdout)).toMatchObject({ text: "from-configured-proxy", stopReason: "stop" });
		expect(serverRequests).toEqual([]);
		expect(proxyRequests).toEqual([
			{
				method: "GET",
				url: `http://127.0.0.1:${boundPort(modelServer)}/v1/control`,
				authorization: null,
				body: "",
			},
			{
				method: "POST",
				url: `http://127.0.0.1:${boundPort(modelServer)}/v1/chat/completions`,
				authorization: `Bearer ${KEY_CANARY}`,
				body: expect.stringContaining(PROMPT_CANARY) as unknown as string,
			},
		]);
	}, 20_000);

	test("Rapid-MLX still bypasses the configured proxy", async () => {
		const serverRequests: ObservedRequest[] = [];
		const modelServer = serveModelEndpoint(serverRequests, "from-local-server");
		const proxyRequests: ObservedRequest[] = [];
		const proxy = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request) {
				proxyRequests.push(await observe(request));
				return new Response("proxy must not answer the completion", { status: 502 });
			},
		});
		servers.push(proxy);

		const result = await runProbe("rapid-mlx", `http://127.0.0.1:${boundPort(modelServer)}/v1`, boundPort(proxy));

		expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
		expect(JSON.parse(result.stdout)).toMatchObject({ text: "from-local-server", stopReason: "stop" });
		expect(serverRequests).toHaveLength(1);
		expect(serverRequests[0]).toMatchObject({
			method: "POST",
			url: `http://127.0.0.1:${boundPort(modelServer)}/v1/chat/completions`,
			authorization: `Bearer ${KEY_CANARY}`,
		});
		expect(serverRequests[0]?.body).toContain(PROMPT_CANARY);
		// Only the control GET proves the proxy was live for the child.
		expect(proxyRequests).toEqual([
			{
				method: "GET",
				url: `http://127.0.0.1:${boundPort(modelServer)}/v1/control`,
				authorization: null,
				body: "",
			},
		]);
	}, 20_000);

	describe("caller fetchOverride", () => {
		const model = (provider: string, baseUrl: string): Model<"openai-completions"> => ({
			id: "test/local-model",
			name: "test/local-model",
			api: "openai-completions",
			provider,
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_768,
			maxTokens: 1024,
		});

		const context = { messages: [{ role: "user" as const, content: PROMPT_CANARY, timestamp: Date.now() }] };

		for (const provider of ["rapid-mlx", "sglang"]) {
			test(`wins for ${provider}`, async () => {
				const serverRequests: ObservedRequest[] = [];
				const modelServer = serveModelEndpoint(serverRequests, "from-local-server");
				const overrideRequests: string[] = [];
				const overrideFetch = (async (input: string | URL | Request) => {
					overrideRequests.push(String(input instanceof Request ? input.url : input));
					return sseResponse("from-override");
				}) as FetchImpl;

				const s = stream(model(provider, `http://127.0.0.1:${boundPort(modelServer)}/v1`), context, {
					apiKey: KEY_CANARY,
					fetch: overrideFetch,
				});
				const events: string[] = [];
				for await (const event of s) {
					if (event.type === "text_delta") events.push(event.delta);
				}
				const message = await s.result();

				expect(events.join("")).toBe("from-override");
				expect(message.stopReason).toBe("stop");
				expect(serverRequests).toEqual([]);
				expect(overrideRequests).toEqual([`http://127.0.0.1:${boundPort(modelServer)}/v1/chat/completions`]);
			});
		}
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@gajae-code/utils";

/**
 * Rapid-MLX is a loopback inference server. Bun applies `HTTP_PROXY` to loopback
 * requests and caches that decision per process, so every Rapid-MLX call has to
 * leave through the shared direct transport: discovery `/models` probes, the
 * bearer, and the prompt/tool payload of a real completion.
 *
 * These regressions run the client in a child process because the proxy decision
 * is made once per process. The parent runs the loopback server and a capture
 * proxy, spawns the client with `HTTP_PROXY` planted, and then inspects what the
 * proxy actually received.
 */
describe("Rapid-MLX proxy isolation", () => {
	const servers: ReturnType<typeof Bun.serve>[] = [];

	afterEach(() => {
		for (const server of servers.splice(0)) server.stop(true);
	});

	const PROMPT_CANARY = "PROMPT-CANARY-91c3";
	const KEY_CANARY = "rapid-secret-CANARY-4d7a";

	interface ObservedRequest {
		method: string;
		url: string;
		authorization: string | null;
		body: string;
	}

	function sseResponse(interDeltaDelayMs = 0): Response {
		const chunk = (delta: object, finishReason: string | null) =>
			`data: ${JSON.stringify({
				id: "chunk-1",
				object: "chat.completion.chunk",
				created: 1,
				model: "mlx-community/Qwen3.5-4B-MLX-4bit",
				choices: [{ index: 0, delta, finish_reason: finishReason }],
			})}\n\n`;
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				void (async () => {
					try {
						controller.enqueue(encoder.encode(chunk({ role: "assistant", content: "hello-" }, null)));
						if (interDeltaDelayMs > 0) await Bun.sleep(interDeltaDelayMs);
						controller.enqueue(encoder.encode(chunk({ content: "from-local" }, null)));
						controller.enqueue(
							encoder.encode(
								chunk({}, "stop") +
									`data: ${JSON.stringify({
										id: "chunk-1",
										object: "chat.completion.chunk",
										created: 1,
										model: "mlx-community/Qwen3.5-4B-MLX-4bit",
										choices: [],
										usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
									})}\n\n` +
									"data: [DONE]\n\n",
							),
						);
						controller.close();
					} catch (error) {
						controller.error(error);
					}
				})();
			},
		});
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	}

	function responsesSseResponse(): Response {
		const event = (payload: object) => `data: ${JSON.stringify(payload)}\n\n`;
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						event({ type: "response.created", response: { id: "resp_1" } }) +
							event({
								type: "response.output_item.added",
								item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
							}) +
							event({ type: "response.content_part.added", part: { type: "output_text", text: "" } }) +
							event({ type: "response.output_text.delta", delta: "hello-from-local" }) +
							event({
								type: "response.output_item.done",
								item: {
									type: "message",
									id: "msg_1",
									role: "assistant",
									status: "completed",
									content: [{ type: "output_text", text: "hello-from-local" }],
								},
							}) +
							event({
								type: "response.completed",
								response: {
									id: "resp_1",
									status: "completed",
									usage: {
										input_tokens: 5,
										output_tokens: 2,
										total_tokens: 7,
										input_tokens_details: { cached_tokens: 0 },
									},
								},
							}),
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

	test("keeps a real completion off the proxy and delivers it to the local server", async () => {
		const serverRequests: ObservedRequest[] = [];
		const modelServer = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request) {
				serverRequests.push(await observe(request));
				if (new URL(request.url).pathname.endsWith("/chat/completions")) return sseResponse(300);
				return new Response("not found", { status: 404 });
			},
		});
		servers.push(modelServer);
		const proxyRequests: ObservedRequest[] = [];
		const proxy = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request) {
				proxyRequests.push(await observe(request));
				return new Response("proxy refused", { status: 502 });
			},
		});
		servers.push(proxy);

		const result = await runProbe("completion", `http://127.0.0.1:${boundPort(modelServer)}/v1`, boundPort(proxy));

		expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
		const payload = JSON.parse(result.stdout);
		expect(payload).toMatchObject({ text: "hello-from-local", stopReason: "stop" });
		// The first delta must arrive while the response is still open: a buffered
		// transport would deliver both deltas together after the server closes.
		expect(payload.streamingGapMs).toBeGreaterThanOrEqual(200);
		expect(serverRequests).toHaveLength(1);
		expect(serverRequests[0]).toMatchObject({
			method: "POST",
			url: `http://127.0.0.1:${boundPort(modelServer)}/v1/chat/completions`,
			authorization: `Bearer ${KEY_CANARY}`,
		});
		expect(serverRequests[0]?.body).toContain(PROMPT_CANARY);
		// The control GET proves the proxy was live for the child; the completion never
		// reached it, so the bearer and the prompt stayed on the loopback socket.
		expect(proxyRequests).toEqual([
			{
				method: "GET",
				url: `http://127.0.0.1:${boundPort(modelServer)}/v1/control`,
				authorization: null,
				body: "",
			},
		]);
	}, 20_000);

	test("keeps keyless discovery off the proxy", async () => {
		const serverRequests: ObservedRequest[] = [];
		const modelServer = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request) {
				serverRequests.push(await observe(request));
				if (new URL(request.url).pathname.endsWith("/models")) {
					return Response.json({ data: [{ id: "keyless-rapid-mlx-model", context_window: 131072 }] });
				}
				return new Response("not found", { status: 404 });
			},
		});
		servers.push(modelServer);
		const proxyRequests: ObservedRequest[] = [];
		const proxy = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request) {
				proxyRequests.push(await observe(request));
				// A proxy that answers `/models` would be able to inject a catalog.
				return Response.json({ data: [{ id: "proxy-injected-model", context_window: 131072 }] });
			},
		});
		servers.push(proxy);

		const result = await runProbe("discovery", `http://127.0.0.1:${boundPort(modelServer)}/v1`, boundPort(proxy), "");

		expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
		expect(JSON.parse(result.stdout)).toEqual({ ids: ["keyless-rapid-mlx-model"] });
		expect(serverRequests).toEqual([
			{
				method: "GET",
				url: `http://127.0.0.1:${boundPort(modelServer)}/v1/models`,
				authorization: null,
				body: "",
			},
		]);
		expect(proxyRequests).toEqual([
			{ method: "GET", url: `http://127.0.0.1:${boundPort(modelServer)}/v1/control`, authorization: null, body: "" },
		]);
	}, 20_000);

	test("still sends a non-loopback endpoint through the configured proxy", async () => {
		const serverRequests: ObservedRequest[] = [];
		const modelServer = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request) {
				serverRequests.push(await observe(request));
				return new Response("must not be reached", { status: 502 });
			},
		});
		servers.push(modelServer);
		const proxyRequests: ObservedRequest[] = [];
		const proxy = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request) {
				proxyRequests.push(await observe(request));
				return sseResponse();
			},
		});
		servers.push(proxy);

		// A name only the proxy can answer: the client cannot resolve it locally.
		const remoteBaseUrl = "http://rapid-mlx-remote.test:8080/v1";
		const result = await runProbe("completion", remoteBaseUrl, boundPort(proxy));

		expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
		expect(JSON.parse(result.stdout)).toMatchObject({ text: "hello-from-local", stopReason: "stop" });
		expect(serverRequests).toEqual([]);
		// The control GET and the completion both went through the proxy: a
		// non-loopback destination keeps the ambient proxy-aware transport.
		expect(proxyRequests.map(request => `${request.method} ${request.url}`)).toEqual([
			"GET http://rapid-mlx-remote.test:8080/v1/control",
			"POST http://rapid-mlx-remote.test:8080/v1/chat/completions",
		]);
		expect(proxyRequests[1]).toMatchObject({ authorization: `Bearer ${KEY_CANARY}` });
		expect(proxyRequests[1]?.body).toContain(PROMPT_CANARY);
	}, 20_000);

	test("keeps the supported Rapid-MLX responses path off the proxy", async () => {
		const serverRequests: ObservedRequest[] = [];
		const modelServer = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request) {
				serverRequests.push(await observe(request));
				if (new URL(request.url).pathname.endsWith("/responses")) return responsesSseResponse();
				return new Response("not found", { status: 404 });
			},
		});
		servers.push(modelServer);
		const proxyRequests: ObservedRequest[] = [];
		const proxy = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request) {
				proxyRequests.push(await observe(request));
				return new Response("proxy refused", { status: 502 });
			},
		});
		servers.push(proxy);

		const baseUrl = `http://127.0.0.1:${boundPort(modelServer)}/v1`;
		const result = await runProbe("responses", baseUrl, boundPort(proxy));

		expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
		expect(JSON.parse(result.stdout)).toMatchObject({ text: "hello-from-local", stopReason: "stop" });
		expect(serverRequests).toHaveLength(1);
		expect(serverRequests[0]).toMatchObject({
			method: "POST",
			url: `${baseUrl}/responses`,
			authorization: `Bearer ${KEY_CANARY}`,
		});
		expect(serverRequests[0]?.body).toContain(PROMPT_CANARY);
		expect(proxyRequests).toEqual([{ method: "GET", url: `${baseUrl}/control`, authorization: null, body: "" }]);
	}, 20_000);

	async function runProbe(
		mode: string,
		baseUrl: string,
		proxyPort: number,
		prompt = PROMPT_CANARY,
	): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		const scratch = path.join(os.tmpdir(), `pi-test-rapid-mlx-inference-${Snowflake.next()}`);
		const child = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "fixtures", "rapid-mlx-inference-probe.ts"), mode],
			{
				cwd: path.join(import.meta.dir, "..", "..", ".."),
				env: {
					...process.env,
					PROBE_BASE_URL: baseUrl,
					PROBE_API_KEY: KEY_CANARY,
					PROBE_PROMPT: prompt,
					HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
					http_proxy: `http://127.0.0.1:${proxyPort}`,
					HTTPS_PROXY: "",
					https_proxy: "",
					ALL_PROXY: "",
					all_proxy: "",
					NO_PROXY: "",
					no_proxy: "",
					GJC_CODING_AGENT_DIR: scratch,
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
});

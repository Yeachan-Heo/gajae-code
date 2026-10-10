import { afterEach, describe, expect, test, vi } from "bun:test";
import { bindPluginMcpToPublicNetwork, fetchPluginMcpRequest } from "../../src/runtime-mcp/plugin-network-boundary";
import { HttpTransport } from "../../src/runtime-mcp/transports/http";

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("waitFor timed out");
}

afterEach(() => vi.restoreAllMocks());

describe("plugin MCP public-network boundary", () => {
	test("pins and revalidates every public redirect hop", async () => {
		const resolved: string[] = [];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async input => {
			if (String(input) === "https://93.184.216.34/start") {
				return new Response(null, {
					status: 307,
					headers: { location: "/next" },
				});
			}
			return new Response("ok");
		}) as typeof fetch);

		const response = await fetchPluginMcpRequest(
			"https://first.example/start",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer secret",
					Cookie: "session=secret",
					"Content-Type": "application/json",
					"Mcp-Session-Id": "origin-session",
				},
				body: "{}",
			},
			{
				resolver: async hostname => {
					resolved.push(hostname);
					return [resolved.length === 1 ? "93.184.216.34" : "1.1.1.1"];
				},
			},
		);

		expect(await response.text()).toBe("ok");
		expect(resolved).toEqual(["first.example", "first.example"]);
		expect(fetchSpy.mock.calls.map(call => String(call[0]))).toEqual([
			"https://93.184.216.34/start",
			"https://1.1.1.1/next",
		]);
		const firstInit = fetchSpy.mock.calls[0]?.[1] as BunFetchRequestInit;
		const secondInit = fetchSpy.mock.calls[1]?.[1] as BunFetchRequestInit;
		expect(firstInit.redirect).toBe("manual");
		expect(firstInit.tls).toMatchObject({ rejectUnauthorized: true, serverName: "first.example" });
		expect(new Headers(firstInit.headers).get("host")).toBe("first.example");
		expect(secondInit.method).toBe("POST");
		expect(secondInit.body).toBe("{}");
		expect(secondInit.tls).toMatchObject({ rejectUnauthorized: true, serverName: "first.example" });
		const redirectedHeaders = new Headers(secondInit.headers);
		expect(redirectedHeaders.get("host")).toBe("first.example");
		expect(redirectedHeaders.get("authorization")).toBe("Bearer secret");
		expect(redirectedHeaders.get("cookie")).toBe("session=secret");
		expect(redirectedHeaders.get("mcp-session-id")).toBe("origin-session");
	});

	test("rejects cross-origin redirects before exposing MCP session state", async () => {
		const resolved: string[] = [];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, {
				status: 307,
				headers: { location: "https://second.example/next" },
			}),
		);

		await expect(
			fetchPluginMcpRequest(
				"https://first.example/start",
				{
					method: "POST",
					headers: { Authorization: "Bearer secret", "Mcp-Session-Id": "origin-session" },
					body: "{}",
				},
				{
					resolver: async hostname => {
						resolved.push(hostname);
						return ["93.184.216.34"];
					},
				},
			),
		).rejects.toThrow("cross-origin redirects are not allowed");

		expect(resolved).toEqual(["first.example"]);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	test("does not replay plugin writes across validated addresses", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection reset"));
		const resolver = async () => ["93.184.216.34", "1.1.1.1"];

		await expect(
			fetchPluginMcpRequest("https://multi.example/mcp", { method: "POST", body: "{}" }, { resolver }),
		).rejects.toThrow("connection reset");
		expect(fetchSpy.mock.calls.map(call => String(call[0]))).toEqual(["https://93.184.216.34/mcp"]);

		fetchSpy.mockReset().mockRejectedValueOnce(new Error("connect failed")).mockResolvedValueOnce(new Response("ok"));
		expect(
			await (await fetchPluginMcpRequest("https://multi.example/mcp", { method: "GET" }, { resolver })).text(),
		).toBe("ok");
		expect(fetchSpy.mock.calls.map(call => String(call[0]))).toEqual([
			"https://93.184.216.34/mcp",
			"https://1.1.1.1/mcp",
		]);
	});

	test("blocks DNS rebinding before the redirected connection", async () => {
		let resolutions = 0;
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(null, { status: 302, headers: { location: "/private" } }));

		await expect(
			fetchPluginMcpRequest(
				"https://rebind.example/start",
				{ method: "POST", body: "{}" },
				{ resolver: async () => [resolutions++ === 0 ? "93.184.216.34" : "127.0.0.1"] },
			),
		).rejects.toThrow("Plugin MCP network request blocked");

		expect(resolutions).toBe(2);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	test("preserves standard redirect methods and bounds redirect chains", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async input => {
			if (String(input).endsWith("/start")) {
				return new Response(null, { status: 302, headers: { location: "/next" } });
			}
			return new Response("ok");
		}) as typeof fetch);

		const response = await fetchPluginMcpRequest("https://8.8.8.8/start", {
			method: "POST",
			headers: { Authorization: "Bearer same-origin", "Content-Type": "application/json" },
			body: "{}",
		});

		expect(await response.text()).toBe("ok");
		const redirectedInit = fetchSpy.mock.calls[1]?.[1] as BunFetchRequestInit;
		expect(redirectedInit.method).toBe("GET");
		expect(redirectedInit.body).toBeUndefined();
		const redirectedHeaders = new Headers(redirectedInit.headers);
		expect(redirectedHeaders.get("authorization")).toBe("Bearer same-origin");
		expect(redirectedHeaders.get("content-type")).toBeNull();

		fetchSpy.mockClear();
		fetchSpy.mockResolvedValue(new Response(null, { status: 307, headers: { location: "/loop" } }));
		await expect(
			fetchPluginMcpRequest("https://8.8.8.8/loop", { method: "GET" }, { maxRedirects: 0 }),
		).rejects.toThrow("redirect limit exceeded");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	test("wires plugin configs through the boundary and blocks redirect downgrades", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, {
				status: 307,
				headers: { location: "http://127.0.0.1/private" },
			}),
		);
		const transport = new HttpTransport(
			bindPluginMcpToPublicNetwork({
				type: "http",
				url: "https://93.184.216.34/mcp",
				timeout: 500,
			}),
		);
		await transport.connect();

		await expect(transport.request("tools/list")).rejects.toThrow("Plugin MCP network request blocked");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0]?.[1]?.redirect).toBe("manual");
		await transport.close();
	});

	test("keeps redirected session state bound across every HTTP transport path", async () => {
		interface FetchCall {
			path: string;
			method: string;
			sessionId: string | null;
		}

		const calls: FetchCall[] = [];
		let serverResponseSent = false;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
			const url = new URL(String(input));
			const method = (init?.method ?? "GET").toUpperCase();
			const headers = new Headers(init?.headers);
			calls.push({ path: url.pathname, method, sessionId: headers.get("mcp-session-id") });

			if (url.pathname === "/start") {
				return new Response(null, { status: 307, headers: { location: "/session" } });
			}
			if (method === "GET") {
				return new Response(
					`data: ${JSON.stringify({
						jsonrpc: "2.0",
						id: "server-request",
						method: "sampling/createMessage",
						params: {},
					})}\n\n`,
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			}
			if (method === "DELETE") return new Response(null, { status: 204 });

			const message = JSON.parse(String(init?.body)) as {
				id?: string | number;
				method?: string;
				result?: unknown;
			};
			if (message.method === "initialize") {
				return Response.json(
					{ jsonrpc: "2.0", id: message.id, result: { ok: true } },
					{ headers: { "Mcp-Session-Id": "session-123" } },
				);
			}
			if (message.method === "notifications/initialized") {
				return new Response(null, { status: 202 });
			}
			if (message.id === "server-request" && "result" in message) {
				serverResponseSent = true;
				return new Response(null, { status: 202 });
			}
			throw new Error("unexpected MCP lifecycle request");
		}) as typeof fetch);
		const transport = new HttpTransport(
			bindPluginMcpToPublicNetwork({
				type: "http",
				url: "https://8.8.8.8/start",
				timeout: 500,
			}),
		);
		transport.onRequest = async () => ({ approved: true });
		await transport.connect();

		await expect(transport.request("initialize")).resolves.toEqual({ ok: true });
		await transport.notify("notifications/initialized");
		await transport.startSSEListener();
		await waitFor(() => serverResponseSent);
		await transport.close();

		expect(fetchSpy).toHaveBeenCalledTimes(10);
		expect(calls.map(call => call.path)).toEqual([
			"/start",
			"/session",
			"/start",
			"/session",
			"/start",
			"/session",
			"/start",
			"/session",
			"/start",
			"/session",
		]);
		expect(calls.filter(call => call.path === "/start").map(call => call.method)).toEqual([
			"POST",
			"POST",
			"GET",
			"POST",
			"DELETE",
		]);
		expect(calls.slice(0, 2).map(call => call.sessionId)).toEqual([null, null]);
		expect(calls.slice(2).every(call => call.sessionId === "session-123")).toBe(true);
	});

	test("keeps ordinary user HTTP transports on the configured URL", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (_input, init) => {
			const request = JSON.parse(String(init?.body)) as { id: string | number };
			return Response.json({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
		}) as typeof fetch);
		const transport = new HttpTransport({ type: "http", url: "http://127.0.0.1/mcp", timeout: 500 });
		await transport.connect();

		await expect(transport.request("tools/list")).resolves.toEqual({ ok: true });
		expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("http://127.0.0.1/mcp");
		expect(fetchSpy.mock.calls[0]?.[1]?.redirect).toBe("manual");
		await transport.close();
	});
});

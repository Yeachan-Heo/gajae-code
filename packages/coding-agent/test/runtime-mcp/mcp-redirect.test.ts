import { afterEach, describe, expect, test, vi } from "bun:test";
import { fetchMcpRespectingOrigin } from "../../src/runtime-mcp/mcp-redirect";
import { HttpTransport } from "../../src/runtime-mcp/transports/http";
import type { MCPHttpServerConfig, MCPSseServerConfig } from "../../src/runtime-mcp/types";

afterEach(() => vi.restoreAllMocks());

describe("MCP HTTP redirects", () => {
	test("refuses a cross-origin redirect before the custom credential header is sent", async () => {
		const seen: string[] = [];
		const attacker = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				seen.push(request.headers.get("x-api-key") ?? "");
				return new Response("stolen");
			},
		});
		const trusted = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				return new Response(null, {
					status: 307,
					headers: { location: `http://127.0.0.1:${attacker.port}/mcp` },
				});
			},
		});
		try {
			await expect(
				fetchMcpRespectingOrigin(new URL("/mcp", trusted.url).toString(), {
					method: "POST",
					headers: { "X-Api-Key": "secret-key", "Mcp-Session-Id": "session-1" },
					body: '{"jsonrpc":"2.0"}',
				}),
			).rejects.toThrow("cross-origin redirects are not allowed");
			expect(seen).toEqual([]);
		} finally {
			trusted.stop(true);
			attacker.stop(true);
		}
	});

	test("follows a same-origin redirect and keeps the custom header", async () => {
		const seen: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				seen.push(url.pathname);
				if (url.pathname === "/a") {
					return new Response(null, { status: 307, headers: { location: "/b" } });
				}
				if (url.pathname === "/b") {
					return new Response(request.headers.get("x-api-key") ?? "", { status: 200 });
				}
				return new Response("unexpected", { status: 404 });
			},
		});
		try {
			const response = await fetchMcpRespectingOrigin(new URL("/a", server.url).toString(), {
				method: "POST",
				headers: { "X-Api-Key": "secret-key" },
				body: "{}",
			});
			expect(response.status).toBe(200);
			expect(await response.text()).toBe("secret-key");
			expect(seen).toEqual(["/a", "/b"]);
		} finally {
			server.stop(true);
		}
	});

	test("rewrites a same-origin 302 POST to GET and drops the body", async () => {
		const seen: Array<{ method: string; path: string; body: string; key: string | null }> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				seen.push({
					method: request.method,
					path: url.pathname,
					body: await request.text(),
					key: request.headers.get("x-api-key"),
				});
				if (url.pathname === "/a") {
					return new Response(null, { status: 302, headers: { location: "/b" } });
				}
				return new Response("ok", { status: 200 });
			},
		});
		try {
			const response = await fetchMcpRespectingOrigin(new URL("/a", server.url).toString(), {
				method: "POST",
				headers: { "X-Api-Key": "secret-key", "Content-Type": "application/json" },
				body: '{"jsonrpc":"2.0","method":"tools/list"}',
			});
			expect(response.status).toBe(200);
			expect(seen.map(hit => [hit.path, hit.method, hit.body, hit.key])).toEqual([
				["/a", "POST", '{"jsonrpc":"2.0","method":"tools/list"}', "secret-key"],
				["/b", "GET", "", "secret-key"],
			]);
		} finally {
			server.stop(true);
		}
	});

	test("stops after 20 followed redirects", async () => {
		let hits = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				hits++;
				return new Response(null, { status: 307, headers: { location: "/loop" } });
			},
		});
		try {
			await expect(
				fetchMcpRespectingOrigin(new URL("/loop", server.url).toString(), { method: "GET" }),
			).rejects.toThrow("MCP redirect limit exceeded");
			expect(hits).toBe(21);
		} finally {
			server.stop(true);
		}
	});

	test.each([
		["http", 307],
		["http", 302],
		["sse", 308],
	] as const)("HttpTransport %s request refuses a %i cross-origin redirect", async (type, status) => {
		const stolen: string[] = [];
		const attacker = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				stolen.push(`${request.method} ${request.headers.get("x-api-key")} ${await request.text()}`);
				return Response.json({ jsonrpc: "2.0", id: "sink", result: { from: "sink" } });
			},
		});
		const trustedHits: string[] = [];
		const trusted = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				trustedHits.push(`${request.headers.get("x-api-key") ?? ""} ${await request.text()}`);
				return new Response(null, {
					status,
					headers: { location: `http://127.0.0.1:${attacker.port}/steal` },
				});
			},
		});
		const config: MCPHttpServerConfig | MCPSseServerConfig = {
			type,
			url: new URL("/mcp", trusted.url).toString(),
			timeout: 2_000,
			headers: {
				"X-Api-Key": "CUSTOM-APIKEY",
				"X-Goog-Api-Key": "GOOG-KEY",
				"Mcp-Session-Id": "SESSION-1",
			},
		};
		const transport = new HttpTransport(config);
		try {
			await transport.connect();
			await expect(transport.request("tools/list")).rejects.toThrow("cross-origin redirects are not allowed");
			expect(stolen).toEqual([]);
			expect(trustedHits.length).toBe(1);
			expect(trustedHits[0]).toContain("CUSTOM-APIKEY");
			expect(trustedHits[0]).toContain("tools/list");
		} finally {
			await transport.close();
			trusted.stop(true);
			attacker.stop(true);
		}
	});

	test("SSE listener refuses a cross-origin redirect before sending the session id", async () => {
		const stolen: string[] = [];
		const attacker = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				stolen.push(request.headers.get("mcp-session-id") ?? "");
				return new Response("event: message\ndata: {}\n\n", {
					headers: { "Content-Type": "text/event-stream" },
				});
			},
		});
		const trusted = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				return new Response(null, {
					status: 302,
					headers: { location: `http://127.0.0.1:${attacker.port}/events` },
				});
			},
		});
		const transport = new HttpTransport({
			type: "sse",
			url: new URL("/sse", trusted.url).toString(),
			timeout: 2_000,
			headers: { "X-Api-Key": "CUSTOM-APIKEY", "Mcp-Session-Id": "SESSION-1" },
		});
		const errors: string[] = [];
		transport.onError = error => errors.push(error.message);
		try {
			await transport.connect();
			await transport.startSSEListener();
			expect(errors).toEqual(["cross-origin redirects are not allowed"]);
			expect(stolen).toEqual([]);
		} finally {
			await transport.close();
			trusted.stop(true);
			attacker.stop(true);
		}
	});

	test("HttpTransport.request follows a same-origin redirect and returns the tool list", async () => {
		const seen: Array<{ path: string; key: string | null; session: string | null }> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				seen.push({
					path: url.pathname,
					key: request.headers.get("x-api-key"),
					session: request.headers.get("mcp-session-id"),
				});
				if (url.pathname === "/mcp") {
					return new Response(null, { status: 307, headers: { location: "/mcp2" } });
				}
				const message = (await request.json()) as { id: string | number };
				return Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
			},
		});
		const transport = new HttpTransport({
			type: "http",
			url: new URL("/mcp", server.url).toString(),
			timeout: 2_000,
			headers: { "X-Api-Key": "CUSTOM-APIKEY", "Mcp-Session-Id": "SESSION-1" },
		});
		try {
			await transport.connect();
			await expect(transport.request("tools/list")).resolves.toEqual({ tools: [] });
			expect(seen).toEqual([
				{ path: "/mcp", key: "CUSTOM-APIKEY", session: "SESSION-1" },
				{ path: "/mcp2", key: "CUSTOM-APIKEY", session: "SESSION-1" },
			]);
		} finally {
			await transport.close();
			server.stop(true);
		}
	});

	test("treats implicit ports as the same origin and refuses a scheme change", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async input => {
			const url = String(input);
			if (url === "http://example.test/mcp") {
				return new Response(null, { status: 307, headers: { location: "http://example.test:80/next" } });
			}
			if (url === "http://example.test/next") return new Response("ok", { status: 200 });
			if (url === "https://example.test/mcp") {
				return new Response(null, { status: 307, headers: { location: "https://example.test:443/next" } });
			}
			if (url === "https://example.test/next") return new Response("ok", { status: 200 });
			throw new Error(`unexpected ${url}`);
		}) as typeof fetch);

		const httpResponse = await fetchMcpRespectingOrigin("http://example.test/mcp", {
			method: "POST",
			headers: { "X-Api-Key": "secret-key" },
			body: "{}",
		});
		expect(httpResponse.status).toBe(200);
		const httpsResponse = await fetchMcpRespectingOrigin("https://example.test/mcp", {
			method: "GET",
			headers: { "X-Api-Key": "secret-key" },
		});
		expect(httpsResponse.status).toBe(200);
		expect(fetchSpy).toHaveBeenCalledTimes(4);

		fetchSpy.mockReset();
		fetchSpy.mockResolvedValue(
			new Response(null, { status: 307, headers: { location: "https://example.test/mcp" } }),
		);
		await expect(
			fetchMcpRespectingOrigin("http://example.test/mcp", {
				method: "POST",
				headers: { "X-Api-Key": "secret-key" },
				body: "{}",
			}),
		).rejects.toThrow("cross-origin redirects are not allowed");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	test("refuses scheme-relative and backslash locations that change host", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		for (const location of ["//evil.test/steal", "/\\evil.test"]) {
			fetchSpy.mockReset();
			fetchSpy.mockResolvedValue(new Response(null, { status: 307, headers: { location } }));
			await expect(
				fetchMcpRespectingOrigin("http://127.0.0.1:9/mcp", {
					method: "POST",
					headers: { "X-Api-Key": "secret-key", "Mcp-Session-Id": "session-1" },
					body: '{"jsonrpc":"2.0"}',
				}),
			).rejects.toThrow("cross-origin redirects are not allowed");
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		}
	});
});

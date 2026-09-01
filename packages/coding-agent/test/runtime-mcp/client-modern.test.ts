import { afterEach, describe, expect, it } from "bun:test";
import { callTool, connectToServer, disconnectServer, listTools } from "../../src/runtime-mcp/client";
import type { MCPInputRequestHandler, MCPServerConfig, MCPServerConnection } from "../../src/runtime-mcp/types";
import { legacyMcpMethodNotFound } from "../mcp-test-utils";

/**
 * Conformance fixtures for the MCP 2026-07-28 stateless protocol ("MCP v2")
 * against the canonical specification:
 * https://modelcontextprotocol.io/specification/2026-07-28 (+ basic/transports/streamable-http,
 * basic/versioning, basic/patterns/mrtr, server/discover, server/utilities/caching).
 */

interface CapturedRequest {
	httpMethod: string;
	headers: Headers;
	// biomejs style: parsed JSON-RPC body
	body: { id?: string | number; method?: string; params?: Record<string, unknown> };
}

const servers: Bun.Server<unknown>[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

interface ModernFixtureOptions {
	/** How server/discover is answered. */
	discover?: "ok" | "method-not-found" | "unsupported-then-ok";
	/** tools/list result extras (cache hints, tools). */
	tools?: unknown[];
	toolsTtlMs?: number;
	/** tools/call behavior. */
	onCall?: (
		body: CapturedRequest["body"],
		callIndex: number,
	) => { result?: Record<string, unknown>; error?: { code: number; message: string } };
}

function startModernFixture(options: ModernFixtureOptions = {}) {
	const requests: CapturedRequest[] = [];
	let discoverCalls = 0;
	let callIndex = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			if (req.method === "GET") return new Response(null, { status: 405 });
			if (req.method === "DELETE") return new Response(null, { status: 405 });
			const body = (await req.json()) as CapturedRequest["body"];
			requests.push({ httpMethod: req.method, headers: req.headers, body });
			const id = body.id ?? 0;
			switch (body.method) {
				case "server/discover": {
					discoverCalls++;
					const mode = options.discover ?? "ok";
					if (mode === "method-not-found") {
						return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
					}
					if (mode === "unsupported-then-ok" && discoverCalls === 1) {
						return Response.json(
							{
								jsonrpc: "2.0",
								id,
								error: { code: -32022, message: "unsupported", data: { supported: ["2026-07-28"] } },
							},
							{ status: 400 },
						);
					}
					return Response.json({
						jsonrpc: "2.0",
						id,
						result: {
							supportedVersions: ["2026-07-28"],
							capabilities: { tools: {} },
							_meta: { "io.modelcontextprotocol/serverInfo": { name: "modern-fixture", version: "2.0" } },
						},
					});
				}
				case "tools/list": {
					return Response.json({
						jsonrpc: "2.0",
						id,
						result: {
							resultType: "complete",
							tools: options.tools ?? [{ name: "echo", inputSchema: { type: "object" } }],
							...(options.toolsTtlMs !== undefined ? { ttlMs: options.toolsTtlMs, cacheScope: "private" } : {}),
						},
					});
				}
				case "tools/call": {
					callIndex++;
					const behavior = options.onCall?.(body, callIndex) ?? {
						result: { resultType: "complete", content: [{ type: "text", text: "ok" }] },
					};
					if (behavior.error) return Response.json({ jsonrpc: "2.0", id, error: behavior.error });
					return Response.json({ jsonrpc: "2.0", id, result: behavior.result });
				}
				default:
					return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
			}
		},
	});
	servers.push(server);
	return {
		url: `http://127.0.0.1:${server.port}/mcp`,
		requests,
		get discoverCalls() {
			return discoverCalls;
		},
	};
}

function startLegacyFixture() {
	const requests: CapturedRequest[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			if (req.method === "GET") return new Response(null, { status: 405 });
			if (req.method === "DELETE") return new Response(null, { status: 202 });
			const body = (await req.json()) as CapturedRequest["body"];
			requests.push({ httpMethod: req.method, headers: req.headers, body });
			const id = body.id ?? 0;
			switch (body.method) {
				case "server/discover":
					return legacyMcpMethodNotFound(id);
				case "initialize":
					return Response.json(
						{
							jsonrpc: "2.0",
							id,
							result: {
								protocolVersion: "2025-03-26",
								capabilities: { tools: {} },
								serverInfo: { name: "legacy-fixture", version: "1.0" },
							},
						},
						{ headers: { "Mcp-Session-Id": "legacy-session-1" } },
					);
				case "notifications/initialized":
					return new Response(null, { status: 202 });
				case "tools/list":
					return Response.json({
						jsonrpc: "2.0",
						id,
						result: { tools: [{ name: "old", inputSchema: { type: "object" } }] },
					});
				case "tools/call":
					return Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "legacy-ok" }] } });
				default:
					return legacyMcpMethodNotFound(id);
			}
		},
	});
	servers.push(server);
	return { url: `http://127.0.0.1:${server.port}/mcp`, requests };
}

function httpConfig(url: string, protocol?: "auto" | "2026-07-28" | "legacy"): MCPServerConfig {
	return { type: "http", url, ...(protocol ? { protocol } : {}) };
}

async function connectModern(
	url: string,
	protocol: "auto" | "2026-07-28" = "2026-07-28",
): Promise<MCPServerConnection> {
	return connectToServer("modern", httpConfig(url, protocol));
}

describe("MCP 2026-07-28 strict stateless transport", () => {
	it("binds the default roots handler to the connection cwd", async () => {
		const fixture = startModernFixture();
		const cwd = "/tmp/scoped mcp project";
		const connection = await connectToServer("modern", httpConfig(fixture.url, "2026-07-28"), { cwd });
		try {
			await expect(connection.transport.onRequest?.("roots/list", {})).resolves.toEqual({
				roots: [{ uri: "file:///tmp/scoped%20mcp%20project", name: "scoped mcp project" }],
			});
		} finally {
			await disconnectServer(connection);
		}
	});

	it("completes discover, tools/list, and tools/call without initialize, session id, or streams", async () => {
		const fixture = startModernFixture();
		const connection = await connectModern(fixture.url);
		try {
			const tools = await listTools(connection);
			expect(tools.map(tool => tool.name)).toEqual(["echo"]);
			const result = await callTool(connection, "echo", { text: "hi" });
			expect(result.content).toEqual([{ type: "text", text: "ok" }]);

			const methods = fixture.requests.map(request => request.body.method);
			expect(methods).toEqual(["server/discover", "tools/list", "tools/call"]);
			expect(methods).not.toContain("initialize");
			// No standalone GET stream, no DELETE termination, no session header anywhere.
			expect(fixture.requests.every(request => request.httpMethod === "POST")).toBe(true);
			expect(fixture.requests.every(request => request.headers.get("Mcp-Session-Id") === null)).toBe(true);

			// Required mirrored headers and per-request _meta on every request.
			for (const request of fixture.requests) {
				expect(request.headers.get("MCP-Protocol-Version")).toBe("2026-07-28");
				expect(request.headers.get("Mcp-Method")).toBe(request.body.method ?? null);
				const meta = request.body.params?._meta as Record<string, unknown>;
				expect(meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
				expect(meta["io.modelcontextprotocol/clientInfo"]).toMatchObject({ name: "gjc-coding-agent" });
				expect(meta["io.modelcontextprotocol/clientCapabilities"]).toBeTypeOf("object");
			}
			// tools/call mirrors the tool name into Mcp-Name.
			const call = fixture.requests.find(request => request.body.method === "tools/call");
			expect(call?.headers.get("Mcp-Name")).toBe("echo");

			// The resultType marker is modern-only and stripped for consumers.
			expect((result as unknown as Record<string, unknown>).resultType).toBeUndefined();

			expect(connection.protocol).toMatchObject({
				preference: "2026-07-28",
				era: "modern",
				effectiveVersion: "2026-07-28",
				negotiation: "modern",
				downgradeReason: null,
				serverInfo: { name: "modern-fixture", version: "2.0" },
				capabilities: { discover: "yes", tools: true },
			});
		} finally {
			await disconnectServer(connection);
		}
		// Modern era close must not DELETE a session that never existed.
		expect(fixture.requests.every(request => request.httpMethod === "POST")).toBe(true);
	});

	it("proceeds with direct v2 calls when the optional server/discover is absent", async () => {
		const fixture = startModernFixture({ discover: "method-not-found" });
		const connection = await connectModern(fixture.url);
		try {
			const result = await callTool(connection, "echo", {});
			expect(result.content).toEqual([{ type: "text", text: "ok" }]);
			expect(connection.protocol.capabilities.discover).toBe("no");
			expect(connection.protocol.era).toBe("modern");
		} finally {
			await disconnectServer(connection);
		}
	});

	it("retries once with a mutually supported version on UnsupportedProtocolVersionError", async () => {
		const fixture = startModernFixture({ discover: "unsupported-then-ok" });
		const connection = await connectModern(fixture.url);
		try {
			expect(fixture.discoverCalls).toBe(2);
			expect(connection.protocol.negotiation).toBe("modern-version-retry");
			expect(connection.protocol.era).toBe("modern");
		} finally {
			await disconnectServer(connection);
		}
	});

	it("mirrors validated x-mcp-header bindings into Mcp-Param-* headers", async () => {
		const fixture = startModernFixture({
			tools: [
				{
					name: "search",
					inputSchema: {
						type: "object",
						properties: {
							tenant: { type: "string", "x-mcp-header": "Tenant-Id" },
							limit: { type: "integer", "x-mcp-header": "X-Limit" },
						},
					},
				},
				{
					name: "broken",
					inputSchema: {
						type: "object",
						properties: { bad: { type: "number", "x-mcp-header": "X-Bad" } },
					},
				},
			],
		});
		const connection = await connectModern(fixture.url);
		try {
			const tools = await listTools(connection);
			// The tool with a non-primitive x-mcp-header annotation is excluded, not fatal.
			expect(tools.map(tool => tool.name)).toEqual(["search"]);
			await callTool(connection, "search", { tenant: "acme", limit: 5 });
			const call = fixture.requests.find(request => request.body.method === "tools/call");
			expect(call?.headers.get("Mcp-Param-Tenant-Id")).toBe("acme");
			expect(call?.headers.get("Mcp-Param-X-Limit")).toBe("5");
		} finally {
			await disconnectServer(connection);
		}
	});

	it("caches the tool catalog within ttlMs and refetches after expiry", async () => {
		const fixture = startModernFixture({ toolsTtlMs: 60_000 });
		const connection = await connectModern(fixture.url);
		try {
			await listTools(connection);
			await listTools(connection);
			expect(fixture.requests.filter(request => request.body.method === "tools/list")).toHaveLength(1);
			// Expire the cache and refetch.
			connection.toolsFreshUntil = Date.now() - 1;
			await listTools(connection);
			expect(fixture.requests.filter(request => request.body.method === "tools/list")).toHaveLength(2);
		} finally {
			await disconnectServer(connection);
		}
	});
});

describe("era negotiation and downgrade safety", () => {
	it("falls back to the legacy handshake under auto with an observable reason", async () => {
		const fixture = startLegacyFixture();
		const connection = await connectToServer("legacy", httpConfig(fixture.url, "auto"));
		try {
			const result = await callTool(connection, "old", {});
			expect(result.content).toEqual([{ type: "text", text: "legacy-ok" }]);
			const methods = fixture.requests.map(request => request.body.method);
			expect(methods.slice(0, 2)).toEqual(["server/discover", "initialize"]);
			// Legacy era: session id from initialize is sent on later requests.
			const call = fixture.requests.find(request => request.body.method === "tools/call");
			expect(call?.headers.get("Mcp-Session-Id")).toBe("legacy-session-1");
			expect(connection.protocol).toMatchObject({
				era: "legacy",
				negotiation: "legacy-fallback",
				downgradeReason: "legacy-server-signal",
				effectiveVersion: "2025-03-26",
			});
			expect(connection.protocol.features.map(feature => feature.feature)).toContain("mcp-session-id");
		} finally {
			await disconnectServer(connection);
		}
	});

	it("goes straight to initialize under an explicit legacy preference (no probe)", async () => {
		const fixture = startLegacyFixture();
		const connection = await connectToServer("legacy", httpConfig(fixture.url, "legacy"));
		try {
			expect(fixture.requests.map(request => request.body.method)[0]).toBe("initialize");
			expect(connection.protocol.negotiation).toBe("legacy-forced");
			expect(connection.protocol.downgradeReason).toBe("preference-legacy");
		} finally {
			await disconnectServer(connection);
		}
	});

	it("never falls back in strict mode when the probe gets a non-modern rejection", async () => {
		const requests: CapturedRequest[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				const body = (await req.json()) as CapturedRequest["body"];
				requests.push({ httpMethod: req.method, headers: req.headers, body });
				return new Response("not json", { status: 400 });
			},
		});
		servers.push(server);
		await expect(connectModern(`http://127.0.0.1:${server.port}/mcp`)).rejects.toThrow(/strict 2026-07-28/);
		expect(requests.map(request => request.body.method)).toEqual(["server/discover"]);
	});

	it("never downgrades on auth failure under auto", async () => {
		const requests: CapturedRequest[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				const body = (await req.json()) as CapturedRequest["body"];
				requests.push({ httpMethod: req.method, headers: req.headers, body });
				return new Response("denied", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
			},
		});
		servers.push(server);
		await expect(
			connectToServer("authed", httpConfig(`http://127.0.0.1:${server.port}/mcp`, "auto")),
		).rejects.toThrow(/401/);
		expect(requests.map(request => request.body.method)).toEqual(["server/discover"]);
	});
});

describe("MRTR input_required", () => {
	const inputRequiredResult = {
		resultType: "input_required",
		requestState: "opaque-state-1",
		inputRequests: {
			elicit1: {
				method: "elicitation/create",
				params: { message: "Pick a value", requestedSchema: { type: "object" } },
			},
		},
	};

	it("gathers input and retries exactly once with verbatim requestState under a fresh id", async () => {
		const fixture = startModernFixture({
			onCall: (_body, index) => {
				if (index === 1) return { result: inputRequiredResult };
				return { result: { resultType: "complete", content: [{ type: "text", text: "answered" }] } };
			},
		});
		const connection = await connectModern(fixture.url);
		const handled: Array<{ key: string; serverName: string; originMethod: string; correlationId: string }> = [];
		const inputHandler: MCPInputRequestHandler = async (key, _request, context) => {
			handled.push({
				key,
				serverName: context.serverName,
				originMethod: context.originMethod,
				correlationId: context.correlationId,
			});
			return { kind: "result", result: { action: "accept", content: { value: 42 } } };
		};
		try {
			const result = await callTool(connection, "echo", { text: "hi" }, { inputHandler });
			expect(result.content).toEqual([{ type: "text", text: "answered" }]);
			expect(handled).toEqual([
				{
					key: "elicit1",
					serverName: "modern",
					originMethod: "tools/call",
					correlationId: handled[0]!.correlationId,
				},
			]);

			const calls = fixture.requests.filter(request => request.body.method === "tools/call");
			expect(calls).toHaveLength(2);
			// Fresh JSON-RPC id on the retry.
			expect(calls[1]!.body.id).not.toBe(calls[0]!.body.id);
			// Original params plus gathered input and a verbatim requestState echo.
			expect(calls[1]!.body.params?.inputResponses).toEqual({
				elicit1: { action: "accept", content: { value: 42 } },
			});
			expect(calls[1]!.body.params?.requestState).toBe("opaque-state-1");
			expect(calls[1]!.body.params?.name).toBe("echo");
		} finally {
			await disconnectServer(connection);
		}
	});

	it("fails explicitly when no interactive input handler is available", async () => {
		const fixture = startModernFixture({
			onCall: () => ({ result: inputRequiredResult }),
		});
		const connection = await connectModern(fixture.url);
		try {
			await expect(callTool(connection, "echo", {})).rejects.toThrow(/no interactive input handler/);
			expect(fixture.requests.filter(request => request.body.method === "tools/call")).toHaveLength(1);
		} finally {
			await disconnectServer(connection);
		}
	});

	it("aborts the exchange without retrying when the handler cancels", async () => {
		const fixture = startModernFixture({
			onCall: () => ({ result: inputRequiredResult }),
		});
		const connection = await connectModern(fixture.url);
		const inputHandler: MCPInputRequestHandler = async () => ({ kind: "failed", reason: "cancelled" });
		try {
			await expect(callTool(connection, "echo", {}, { inputHandler })).rejects.toThrow(/cancelled/);
			expect(fixture.requests.filter(request => request.body.method === "tools/call")).toHaveLength(1);
		} finally {
			await disconnectServer(connection);
		}
	});

	it("bounds repeated input_required rounds", async () => {
		const fixture = startModernFixture({
			onCall: () => ({ result: inputRequiredResult }),
		});
		const connection = await connectModern(fixture.url);
		const inputHandler: MCPInputRequestHandler = async () => ({ kind: "result", result: { action: "accept" } });
		try {
			await expect(callTool(connection, "echo", {}, { inputHandler })).rejects.toThrow(/repeatedly requested/);
			// 1 initial + MAX_MRTR_RETRIES retries.
			expect(fixture.requests.filter(request => request.body.method === "tools/call")).toHaveLength(4);
		} finally {
			await disconnectServer(connection);
		}
	});
});

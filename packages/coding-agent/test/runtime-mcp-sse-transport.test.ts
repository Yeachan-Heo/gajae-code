import { describe, expect, it } from "bun:test";
import { callTool, connectToServer, disconnectServer } from "../src/runtime-mcp/client";

type JsonRpcRequest = {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
};

describe("SSE-typed MCP server configuration", () => {
	it("uses Streamable HTTP POST requests at the configured URL", async () => {
		const requests: JsonRpcRequest[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (request.method === "GET") return new Response(null, { status: 405 });

				const body = (await request.json()) as JsonRpcRequest;
				requests.push(body);
				switch (body.method) {
					case "initialize":
						return Response.json({
							jsonrpc: "2.0",
							id: body.id,
							result: {
								protocolVersion: "2025-03-26",
								capabilities: {},
								serverInfo: { name: "test", version: "1.0.0" },
							},
						});
					case "notifications/initialized":
						return new Response(null, { status: 202 });
					case "tools/call":
						return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [] } });
					default:
						return new Response("Unexpected request", { status: 400 });
				}
			},
		});

		const url = `http://127.0.0.1:${server.port}/mcp`;
		try {
			const connection = await connectToServer("sse-config", { type: "sse", url });
			await callTool(connection, "example", { value: "test" });
			await disconnectServer(connection);

			// auto preference probes server/discover first; the 400 default answers as a legacy server.
			expect(requests.map(request => request.method)).toEqual([
				"server/discover",
				"initialize",
				"notifications/initialized",
				"tools/call",
			]);
			expect(requests[3]).toMatchObject({
				jsonrpc: "2.0",
				method: "tools/call",
				params: { name: "example", arguments: { value: "test" } },
			});
		} finally {
			server.stop(true);
		}
	});
});

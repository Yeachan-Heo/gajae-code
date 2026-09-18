import { afterEach, describe, expect, test } from "bun:test";
import { disposeAllResourceOwners } from "../src/runtime/process-lifecycle";
import { HttpTransport, liveHttpTransportCount } from "../src/runtime-mcp/transports/http";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
	await disposeAllResourceOwners().catch(() => undefined);
	for (const server of servers.splice(0)) server.stop(true);
});

describe("MCP HTTP postmortem release", () => {
	test("terminates a live legacy server session during resource-owner disposal", async () => {
		const methods: string[] = [];
		const sessionIds: Array<string | null> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				methods.push(request.method);
				sessionIds.push(request.headers.get("Mcp-Session-Id"));
				if (request.method === "DELETE") return new Response(null, { status: 204 });
				const body = (await request.json()) as { id: string; method: string };
				return Response.json(
					{
						jsonrpc: "2.0",
						id: body.id,
						result: {
							protocolVersion: "2025-03-26",
							capabilities: {},
							serverInfo: { name: "postmortem-test", version: "1" },
						},
					},
					{ headers: { "Mcp-Session-Id": "session-to-release" } },
				);
			},
		});
		servers.push(server);

		const transport = new HttpTransport({ type: "http", url: `${server.url}mcp`, timeout: 1_000 });
		await transport.connect();
		await transport.request("initialize", {});
		expect(liveHttpTransportCount()).toBe(1);

		await disposeAllResourceOwners();

		expect(methods).toEqual(["POST", "DELETE"]);
		expect(sessionIds).toEqual([null, "session-to-release"]);
		expect(liveHttpTransportCount()).toBe(0);
	});

	test("graceful close unregisters the transport before postmortem", async () => {
		let deletes = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (request.method === "DELETE") deletes += 1;
				return new Response(null, { status: 204 });
			},
		});
		servers.push(server);

		const transport = new HttpTransport({ type: "http", url: `${server.url}mcp`, timeout: 1_000 });
		await transport.connect();
		expect(liveHttpTransportCount()).toBe(1);
		await transport.close();
		expect(liveHttpTransportCount()).toBe(0);

		await disposeAllResourceOwners();
		expect(deletes).toBe(0);
	});
});

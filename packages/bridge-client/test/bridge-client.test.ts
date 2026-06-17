import { describe, expect, it } from "bun:test";
import type { BridgeFrame } from "../src";
import { BridgeClient } from "../src";

describe("BridgeClient", () => {
	it("sends authenticated handshake requests", async () => {
		const seen: Array<{ url: string; headers: Record<string, string>; body: string | null }> = [];
		const client = new BridgeClient({
			baseUrl: "https://bridge.test",
			token: "secret",
			fetch: async (input, init) => {
				const headers = new Headers(init?.headers);
				seen.push({
					url: String(input),
					headers: Object.fromEntries(headers.entries()),
					body: init?.body?.toString() ?? null,
				});
				return new Response(JSON.stringify({ status: "accepted", session_id: "sess-1" }), { status: 200 });
			},
		});

		const response = await client.handshake({
			protocol_version_range: { min: 1, max: 2 },
			capabilities: ["events", "prompt"],
			requested_scopes: ["prompt"],
		});

		expect(response.status).toBe("accepted");
		expect(seen[0]?.url).toBe("https://bridge.test/v1/handshake");
		expect(seen[0]?.headers.authorization).toBe("Bearer secret");
		expect(seen[0]?.headers["content-type"]).toBe("application/json");
		expect(seen[0]?.body).toContain("protocol_version_range");
	});

	it("refuses bearer tokens over non-HTTPS except explicit localhost opt-in", () => {
		expect(() => new BridgeClient({ baseUrl: "http://bridge.test", token: "secret" })).toThrow(
			/non-HTTPS bridge URLs/,
		);
		expect(() => new BridgeClient({ baseUrl: "http://localhost:4077", token: "secret" })).toThrow(
			/allowInsecureLocalhost/,
		);
		expect(
			() => new BridgeClient({ baseUrl: "http://127.0.0.1:4077", token: "secret", allowInsecureLocalhost: true }),
		).not.toThrow();
	});

	it("sends command idempotency keys and event cursors", async () => {
		const seen: string[] = [];
		const headersSeen: string[] = [];
		const client = new BridgeClient({
			baseUrl: "https://bridge.test/base/",
			token: "secret",
			fetch: async (input, init) => {
				seen.push(String(input));
				const headers = new Headers(init?.headers);
				headersSeen.push(headers.get("Idempotency-Key") ?? "");
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			},
		});

		await client.command({ type: "prompt", message: "hello" }, "sess/1", "idem-1");
		await client.connectEvents("sess/1", 42);
		await client.prompt("sess/1", "via helper", { idempotencyKey: "idem-2" });

		await client.getPendingWorkflowGates("sess/1", { idempotencyKey: "idem-3" });
		expect(seen[0]).toBe("https://bridge.test/v1/sessions/sess%2F1/commands");
		expect(headersSeen[0]).toBe("idem-1");
		expect(seen[1]).toBe("https://bridge.test/v1/sessions/sess%2F1/events?last_seq=42");
		expect(seen[2]).toBe("https://bridge.test/v1/sessions/sess%2F1/commands");
		expect(headersSeen[2]).toBe("idem-2");
		expect(seen[3]).toBe("https://bridge.test/v1/sessions/sess%2F1/commands");
		expect(headersSeen[3]).toBe("idem-3");
	});
	it("sends controller claim and UI response requests", async () => {
		const seen: Array<{ url: string; headers: Record<string, string>; body: string | null }> = [];
		const client = new BridgeClient({
			baseUrl: "https://bridge.test",
			token: "secret",
			fetch: async (input, init) => {
				const headers = new Headers(init?.headers);
				seen.push({
					url: String(input),
					headers: Object.fromEntries(headers.entries()),
					body: init?.body?.toString() ?? null,
				});
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			},
		});

		await client.claimControl("sess/1", "owner-1");
		await client.respondToUiRequest("sess/1", "corr/1", "owner-1", { status: "value", value: "A" }, "ui-idem-1");
		await client.disconnectControl("sess/1", "owner-1");
		await client.respondToHostTool("sess/1", "tool/1", { type: "host_tool_result" });
		await client.respondToHostUri("sess/1", "uri/1", { type: "host_uri_result" });

		expect(seen[0]?.url).toBe("https://bridge.test/v1/sessions/sess%2F1/control:claim");
		expect(seen[0]?.headers.authorization).toBe("Bearer secret");
		expect(seen[0]?.headers["x-gjc-bridge-owner-token"]).toBe("owner-1");
		expect(seen[1]?.url).toBe("https://bridge.test/v1/sessions/sess%2F1/ui-responses/corr%2F1");
		expect(seen[1]?.headers["content-type"]).toBe("application/json");
		expect(seen[1]?.headers["idempotency-key"]).toBe("ui-idem-1");
		expect(seen[1]?.headers["x-gjc-bridge-owner-token"]).toBe("owner-1");
		expect(seen[1]?.body).toContain("value");
		expect(seen[2]?.url).toBe("https://bridge.test/v1/sessions/sess%2F1/control:disconnect");
		expect(seen[2]?.headers["x-gjc-bridge-owner-token"]).toBe("owner-1");
		expect(seen[3]?.url).toBe("https://bridge.test/v1/sessions/sess%2F1/host-tool-results/tool%2F1");
		expect(seen[3]?.headers["content-type"]).toBe("application/json");
		expect(seen[4]?.url).toBe("https://bridge.test/v1/sessions/sess%2F1/host-uri-results/uri%2F1");
	});

	it("generates idempotency keys and parses fetch event streams", async () => {
		const client = new BridgeClient({
			baseUrl: "https://bridge.test",
			token: "secret",
			fetch: async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(
									'data: {"protocol_version":2,"session_id":"sess-1","seq":1,"frame_id":"frame-1","type":"event","payload":{"event_type":"agent_start"}}\r\n\r\n',
								),
							);
							controller.close();
						},
					}),
				),
		});
		const idempotencyKey = client.createIdempotencyKey("test");
		expect(idempotencyKey.startsWith("test-")).toBe(true);
		const frames: BridgeFrame[] = [];
		for await (const frame of client.events("sess-1")) frames.push(frame);
		expect(frames).toHaveLength(1);
		expect(frames[0]?.seq).toBe(1);
	});
});

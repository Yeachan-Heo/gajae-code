import { expect, test } from "bun:test";
import { AcpSdkAdapter } from "../src/sdk/acp";

const waitFor = async <T>(read: () => T | undefined, label: string): Promise<T> => {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined) return value;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${label}`);
};

test("ACP provider reconnects after a server-side heartbeat disconnect, awaits hello, and reclaims its lease", async () => {
	let server!: ReturnType<typeof Bun.serve>;

	let port = 0;
	let connection = 0;
	let closeOnHeartbeat = false;
	const registrations: Record<string, unknown>[] = [];
	const start = () => {
		server = Bun.serve({
			hostname: "127.0.0.1",
			port,
			fetch(request) {
				if (!server.upgrade(request, { data: undefined })) return new Response("Upgrade failed", { status: 400 });
			},
			websocket: {
				open(socket) {
					socket.send(JSON.stringify({ type: "hello", connectionId: `connection-${++connection}` }));
				},
				message(socket, raw) {
					const frame = JSON.parse(String(raw)) as Record<string, unknown>;
					if (frame.type === "register_provider") {
						registrations.push(frame);
						socket.send(
							JSON.stringify({ type: "register_provider_result", id: frame.id, leaseId: "stable-lease" }),
						);
					}
					if (frame.type === "provider_heartbeat" && closeOnHeartbeat) {
						closeOnHeartbeat = false;
						server.stop(true);
						start();
					}
				},
			},
		});
		port = server.port ?? port;
	};
	start();
	const adapter = new AcpSdkAdapter({
		url: `ws://127.0.0.1:${port}`,
		token: "token",
		providers: [{ capability: "ui", definitions: [{ name: "select" }] }],
		heartbeatMs: 10,
	});
	try {
		await adapter.start();
		const firstConnectionId = adapter.connectionId;
		expect(adapter.leaseIds.get("ui")).toBe("stable-lease");
		closeOnHeartbeat = true;
		await waitFor(
			() =>
				adapter.connectionId !== firstConnectionId && registrations.length === 2 ? adapter.connectionId : undefined,
			"hello-gated reconnect and lease reclaim",
		);
		expect(registrations[1]).toMatchObject({ expectedLeaseId: "stable-lease", connectionId: adapter.connectionId });
	} finally {
		await adapter.close();
		server.stop(true);
	}
});

test("ACP reconnect exhaustion is observable as a typed rejection", async () => {
	const adapter = new AcpSdkAdapter({
		url: "ws://127.0.0.1:1",
		token: "token",
		providers: [{ capability: "ui", definitions: [] }],
	});
	await expect(adapter.start()).rejects.toMatchObject({ code: "reconnect_exhausted" });
});

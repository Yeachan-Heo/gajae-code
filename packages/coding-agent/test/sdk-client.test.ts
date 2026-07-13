import { afterEach, expect, test } from "bun:test";
import { SdkClient, SdkClientError } from "../src/sdk/client";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

function start(
	handler: (frame: Record<string, unknown>, socket: any) => void,
	options: { sendHello?: boolean } = {},
): {
	url: string;
	token: string;
	stop: () => Promise<void>;
} {
	const token = "sdk-client-test-token";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).searchParams.get("token") !== token)
				return new Response("Unauthorized", { status: 401 });
			if (!server.upgrade(request, { data: undefined })) return new Response("Upgrade failed", { status: 400 });
		},
		websocket: {
			open(socket) {
				if (options.sendHello !== false)
					socket.send(JSON.stringify({ type: "hello", connectionId: "client-test" }));
			},
			message(socket, raw) {
				handler(JSON.parse(String(raw)), socket);
			},
		},
	});
	servers.push(server);
	return { url: `ws://127.0.0.1:${server.port}`, token, stop: () => server.stop(true) };
}

test("SdkClient correlates direct v3 control/query frames and typed errors", async () => {
	const host = start((frame, socket) => {
		if (frame.operation === "bad")
			socket.send(
				JSON.stringify({
					type: "control_response",
					id: frame.id,
					ok: false,
					error: { code: "unknown_operation", message: "bad operation" },
				}),
			);
		else
			socket.send(
				JSON.stringify({
					type: frame.type === "query_request" ? "query_response" : "control_response",
					id: frame.id,
					ok: true,
					echoed: frame,
				}),
			);
	});
	const client = await SdkClient.connect(host.url, host.token);
	await expect(client.control("turn.prompt", { text: "hello" })).resolves.toMatchObject({
		ok: true,
		echoed: { operation: "turn.prompt" },
	});
	await expect(client.query("session.metadata", {}, "next")).resolves.toMatchObject({
		ok: true,
		echoed: { query: "session.metadata", cursor: "next" },
	});
	try {
		await client.control("bad");
		expect.unreachable();
	} catch (error) {
		expect(error).toBeInstanceOf(SdkClientError);
		expect((error as SdkClientError).code).toBe("unknown_operation");
	}
	await client.close();
});

test("SdkClient surfaces malformed transport frames as typed protocol errors", async () => {
	const host = start((frame, socket) => {
		if (frame.operation === "malformed") socket.send("not-json");
		else socket.send(JSON.stringify({ type: "control_command_result", id: frame.id, message: "not-json" }));
	});
	const client = await SdkClient.connect(host.url, host.token);
	await expect(client.control("malformed")).rejects.toMatchObject({ code: "protocol_error" });
	await expect(client.control("malformed_seam")).rejects.toMatchObject({ code: "protocol_error" });
	await client.close();
});

test("SdkClient reports connection_closed when a sent request loses its response", async () => {
	let accepted: Record<string, unknown> | undefined;
	const host = start((frame, socket) => {
		accepted = frame;
		socket.close(1000, "done");
	});
	const client = await SdkClient.connect(host.url, host.token, { timeoutMs: 1_000 });
	await expect(client.control("close")).rejects.toMatchObject({ code: "connection_closed" });
	expect(accepted).toMatchObject({ type: "control_request", operation: "close" });
	await client.close();
});

test("SdkClient times out and reconnects after a server restart", async () => {
	let port = 0;
	const token = "sdk-client-reconnect-token";
	const startAtPort = () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port,
			fetch(request) {
				if (new URL(request.url).searchParams.get("token") !== token)
					return new Response("Unauthorized", { status: 401 });
				if (!server.upgrade(request, { data: undefined })) return new Response("Upgrade failed", { status: 400 });
			},
			websocket: {
				open(socket) {
					socket.send(JSON.stringify({ type: "hello", connectionId: `client-${Date.now()}` }));
				},
				message(socket, raw) {
					const frame = JSON.parse(String(raw)) as Record<string, unknown>;
					if (frame.operation !== "wait")
						socket.send(JSON.stringify({ type: "control_response", id: frame.id, ok: true }));
				},
			},
		});
		port = server.port ?? port;
		servers.push(server);
		return server;
	};
	const first = startAtPort();
	const client = await SdkClient.connect(`ws://127.0.0.1:${port}`, token, { timeoutMs: 30, reconnectBackoffMs: 5 });
	await expect(client.control("wait")).rejects.toMatchObject({ code: "timeout" });
	await first.stop(true);
	servers.splice(servers.indexOf(first), 1);
	await Bun.sleep(50);
	startAtPort();
	await expect(client.control("after_restart")).resolves.toMatchObject({ ok: true });
	await client.close();
});

test("SdkClient ignores a stale failed socket while a retried request is in flight", async () => {
	const token = "sdk-client-stale-socket-token";
	let connections = 0;
	let firstSocket: any;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).searchParams.get("token") !== token)
				return new Response("Unauthorized", { status: 401 });
			if (!server.upgrade(request, { data: undefined })) return new Response("Upgrade failed", { status: 400 });
		},
		websocket: {
			open(socket) {
				connections++;
				if (connections === 1) firstSocket = socket;
				else socket.send(JSON.stringify({ type: "hello", connectionId: "retry-connection" }));
			},
			message(socket, raw) {
				const frame = JSON.parse(String(raw)) as Record<string, unknown>;
				setTimeout(() => socket.send(JSON.stringify({ type: "control_response", id: frame.id, ok: true })), 10);
			},
		},
	});
	servers.push(server);
	const client = await SdkClient.connect(`ws://127.0.0.1:${server.port}`, token, {
		timeoutMs: 15,
		reconnectAttempts: 1,
		reconnectBackoffMs: 1,
	});
	const response = client.control("turn.prompt", { text: "still connected" });
	setTimeout(() => firstSocket?.close(1000, "late first connection close"), 2);
	await expect(response).resolves.toMatchObject({ ok: true });
	expect(connections).toBe(2);
	await client.close();
});

test("SdkClient reports a missing hello as a protocol error before a later deadline", async () => {
	const host = start(() => {}, { sendHello: false });
	await expect(
		SdkClient.connect(host.url, host.token, {
			timeoutMs: 75,
			deadline: Date.now() + 1_000,
			reconnectAttempts: 0,
		}),
	).rejects.toMatchObject({
		code: "reconnect_exhausted",
		details: expect.objectContaining({
			code: "protocol_error",
			message: "SDK server did not send a hello frame.",
		}),
	});
});

test("SdkClient reports a missing hello as a deadline error after its deadline", async () => {
	const host = start(() => {}, { sendHello: false });
	await expect(
		SdkClient.connect(host.url, host.token, {
			timeoutMs: 250,
			deadline: Date.now() + 100,
			reconnectAttempts: 0,
		}),
	).rejects.toMatchObject({ code: "timeout", message: "SDK client deadline elapsed." });
});
test("SdkClient bounds a peer that accepts TCP but never completes the WebSocket upgrade", async () => {
	const hangingUpgrade = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			return Promise.withResolvers<Response>().promise;
		},
	});
	try {
		const started = Date.now();
		await expect(
			SdkClient.connect(`ws://127.0.0.1:${hangingUpgrade.port}`, "unused", {
				timeoutMs: 75,
				reconnectAttempts: 0,
			}),
		).rejects.toMatchObject({
			code: "reconnect_exhausted",
			details: expect.objectContaining({ code: "timeout" }),
		});
		expect(Date.now() - started).toBeLessThan(500);
	} finally {
		hangingUpgrade.stop(true);
	}
});

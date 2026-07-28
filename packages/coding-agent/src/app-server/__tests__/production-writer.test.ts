import { expect, test } from "bun:test";
import { closeRejectedWebSocket, createAppServerWebSocketWriter } from "../../commands/app-server";
import { createAppServerRuntime } from "../create-app-server";

const enc = (value: string) => new TextEncoder().encode(value);

test("production WebSocket writer waits for Bun drain after backpressure", async () => {
	let sendStatus = -1;
	const sent: string[] = [];
	const writer = createAppServerWebSocketWriter({
		send: frame => {
			sent.push(new TextDecoder().decode(frame));
			return sendStatus;
		},
	});
	let settled = false;
	const pending = writer.writer(enc("frame")).then(() => {
		settled = true;
	});
	await Bun.sleep(0);
	expect(sent).toEqual(["frame"]);
	expect(settled).toBe(false);
	sendStatus = 5;
	writer.drain();
	await pending;
	expect(settled).toBe(true);
});

test("production WebSocket writer rejects dropped and closed sends", async () => {
	const dropped = createAppServerWebSocketWriter({ send: () => 0 });
	await expect(dropped.writer(enc("frame"))).rejects.toThrow("dropped");

	const closed = createAppServerWebSocketWriter({ send: () => -1 });
	const pending = closed.writer(enc("frame"));
	closed.fail(new Error("WebSocket closed"));
	await expect(pending).rejects.toThrow("WebSocket closed");
});

test("production WebSocket transport closes an oversized peer with 1009", async () => {
	const closed: Array<[number | undefined, string | undefined]> = [];
	const socket = {
		send: () => 1,
		close: (code?: number, reason?: string) => closed.push([code, reason]),
	};
	const runtime = createAppServerRuntime({}, { maxFrameBytes: 1 });
	const connection = runtime.createConnection(
		async () => {},
		"websocket",
		reason => closeRejectedWebSocket(socket, reason),
	);
	await connection.process(enc("{}"));
	expect(closed).toEqual([[1009, "Message too big"]]);
});

test("production WebSocket transport closes a malformed peer with 1002", async () => {
	const closed: Array<[number | undefined, string | undefined]> = [];
	const socket = {
		send: () => 1,
		close: (code?: number, reason?: string) => closed.push([code, reason]),
	};
	const runtime = createAppServerRuntime();
	const connection = runtime.createConnection(
		async () => {},
		"websocket",
		reason => closeRejectedWebSocket(socket, reason),
	);
	await connection.process(enc("{not json"));
	expect(closed).toEqual([[1002, "Protocol error"]]);
});

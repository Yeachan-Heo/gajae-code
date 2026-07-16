import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NotificationServer } from "../../natives/native/index.js";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, label: string, timeout = 5_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(10);
	}
	throw new Error(`timed out waiting for ${label}`);
}

async function open(endpoint: string, token: string): Promise<WebSocket> {
	const ws = new WebSocket(`${endpoint}/?token=${token}`);
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener("error", () => reject(new Error("websocket connection failed")), { once: true });
	});
	return ws;
}

test("napi NotificationServer permits synchronous reentrant host calls during inbound and reply callbacks", async () => {
	const sessionId = `reentrant-${process.pid}-${Date.now()}`;
	const token = "reentrant-token";
	const server = new NotificationServer(sessionId, token, `/tmp/${sessionId}`, true);
	let inbound = 0;
	let replies = 0;
	server.onInbound((_error, message) => {
		if (message?.kind !== "user_message") return;
		inbound += 1;
		server.pushFrame(
			JSON.stringify({
				type: "turn_stream",
				sessionId,
				phase: "live",
				text: "inbound",
				messageRef: `inbound-${message.updateId}`,
			}),
		);
	});
	server.onReply((_error, reply) => {
		if (!reply) return;
		replies += 1;
		// This runs synchronously in the threadsafe callback. The native handle
		// mutex must be released before this receipt-bound reentrant resolution.
		server.resolveClaim(reply.replyReceiptId, reply.answerJson, reply.idempotencyKey);
	});

	const endpoint = await server.start();
	const ws = await open(endpoint.url, token);
	const markers = new Set<string>();
	let actionResolved = false;
	ws.addEventListener("message", event => {
		const message = JSON.parse(String(event.data)) as {
			type?: string;
			messageRef?: string;
			id?: string;
			kind?: string;
		};
		if (message.type === "turn_stream" && message.messageRef) markers.add(message.messageRef);
		if (message.type === "action_needed" && message.id === "reply-ask" && message.kind === "ask") {
			ws.send(JSON.stringify({ type: "reply", id: "reply-ask", answer: 0, token }));
		}
		if (message.type === "action_resolved" && message.id === "reply-ask") actionResolved = true;
	});

	try {
		await waitFor(() => server.clientCount() === 1, "client connection");
		const count = 100;
		for (let i = 0; i < count; i++) {
			ws.send(JSON.stringify({ type: "user_message", sessionId, text: `message-${i}`, token, updateId: i }));
			server.pushFrame(
				JSON.stringify({ type: "turn_stream", sessionId, phase: "live", text: "flood", messageRef: `flood-${i}` }),
			);
		}
		server.registerAsk(
			JSON.stringify({ id: "reply-ask", kind: "ask", sessionId, question: "Reentrant?", options: ["yes"] }),
			true,
		);
		await waitFor(() => inbound === count, "all inbound callbacks");
		await waitFor(() => markers.size === count * 2, "all interleaved frames");
		await waitFor(() => replies === 1 && actionResolved, "reentrant reply resolution");
	} finally {
		ws.close();
		server.stop();
		server.stop();
	}
}, 30_000);

test("napi NotificationServer stops cleanly when an inbound callback is in flight", async () => {
	const sessionId = `reentrant-stop-${process.pid}-${Date.now()}`;
	const token = "stop-token";
	const server = new NotificationServer(sessionId, token, `/tmp/${sessionId}`, true);
	let callbackEntered = false;
	server.onInbound((_error, message) => {
		if (!message) return;
		callbackEntered = true;
		server.pushFrame(
			JSON.stringify({
				type: "turn_stream",
				sessionId,
				phase: "finalized",
				text: "before stop",
				messageRef: "before-stop",
			}),
		);
		server.stop();
		server.stop();
	});
	const endpoint = await server.start();
	const ws = await open(endpoint.url, token);
	try {
		ws.send(JSON.stringify({ type: "user_message", sessionId, text: "stop", token, updateId: 1 }));
		await waitFor(() => callbackEntered, "in-flight stop callback");
		expect(callbackEntered).toBe(true);
	} finally {
		ws.close();
		await server.stopAndWait();
	}
}, 30_000);

test("napi NotificationServer awaited stop releases connected-client state roots", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-stop-wait-"));
	const sessionId = `stop-wait-${process.pid}-${Date.now()}`;
	const token = "stop-wait-token";
	const server = new NotificationServer(sessionId, token, root, true);
	let ws: WebSocket | undefined;
	try {
		const endpoint = await server.start();
		ws = await open(endpoint.url, token);
		await waitFor(() => server.clientCount() === 1, "connected client");

		await Promise.all([server.stopAndWait(), server.stopAndWait()]);

		expect(server.clientCount()).toBe(0);
		await expect(fs.rm(root, { recursive: true, force: true })).resolves.toBeUndefined();
		await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		ws?.close();
		await server.stopAndWait();
		await fs.rm(root, { recursive: true, force: true });
	}
});

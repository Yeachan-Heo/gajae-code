// G002 native-binding smoke test: exercises the real NotificationControlServer
// N-API class end-to-end (construct -> start -> connect -> forward -> respond ->
// stop) against a live loopback socket. Not part of the unit suite; produces
// durable evidence for the ultragoal completion gate.
import assert from "node:assert";
import WebSocket from "ws";

import { NotificationControlServer } from "../native/index.js";

async function main(): Promise<void> {
	const received: Array<{ kind: string; requestId: string; payloadJson: string }> = [];
	const server = new NotificationControlServer("control-token", "daemon-smoke");
	server.onLifecycleRequest((err, req) => {
		assert.equal(err, null, "callback error must be null");
		// The raw control token must NEVER cross into the JS callback payload.
		assert.ok(!req.payloadJson.includes("control-token"), "control token leaked into forwarded lifecycle payload");
		received.push({ kind: req.kind, requestId: req.requestId, payloadJson: req.payloadJson });
		// Echo a terminal close response back, routed by requestId.
		server.respond(
			JSON.stringify({
				type: "session_close_response",
				requestId: req.requestId,
				status: "ok",
				sessionId: "sess-smoke",
				processGone: true,
				historyPreserved: true,
				endpointStale: true,
			}),
		);
	});

	const ep = await server.start();
	assert.ok(ep.url.startsWith("ws://127.0.0.1:"), `loopback url, got ${ep.url}`);
	assert.ok(ep.port > 0, "ephemeral port assigned");
	assert.equal(ep.ownerId, "daemon-smoke");
	console.log(`[g002] control endpoint up: ${ep.url} owner=${ep.ownerId}`);

	// Wrong handshake token must be rejected (HTTP 401 -> connect error).
	await new Promise<void>(resolve => {
		const bad = new WebSocket(`${ep.url}/?token=wrong`);
		bad.on("open", () => {
			bad.close();
			throw new Error("handshake with wrong token must NOT open");
		});
		bad.on("error", () => {
			console.log("[g002] wrong-token handshake rejected (expected)");
			resolve();
		});
	});

	// Valid client: send a close frame, expect the routed response back.
	const resp = await new Promise<Record<string, unknown>>((resolve, reject) => {
		const ws = new WebSocket(`${ep.url}/?token=control-token`);
		const timer = setTimeout(() => reject(new Error("timed out waiting for response")), 4000);
		ws.on("open", () => {
			ws.send(
				JSON.stringify({
					type: "session_close",
					requestId: "lc-smoke-1",
					updateId: 1,
					chatId: "42",
					token: "control-token",
					target: { sessionId: "sess-smoke" },
					force: true,
				}),
			);
		});
		ws.on("message", data => {
			clearTimeout(timer);
			ws.close();
			resolve(JSON.parse(String(data)) as Record<string, unknown>);
		});
		ws.on("error", reject);
	});

	assert.equal(resp.type, "session_close_response");
	assert.equal(resp.requestId, "lc-smoke-1");
	assert.equal(resp.processGone, true);
	assert.equal(received.length, 1, "exactly one request forwarded to host");
	assert.equal(received[0]?.kind, "session_close");
	assert.equal(received[0]?.requestId, "lc-smoke-1");
	console.log("[g002] forward + per-requestId response routing OK");

	server.stop();
	console.log("[g002] PASS: NotificationControlServer native binding works end-to-end");
}

main()
	.then(() => process.exit(0))
	.catch(err => {
		console.error("[g002] FAIL", err);
		process.exit(1);
	});

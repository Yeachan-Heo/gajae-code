import assert from "node:assert/strict";
import { once } from "node:events";
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { waitForCursorWritesForTest, writeCursorFrameForTest } from "../../src/providers/cursor";

// Executed only in a child with an empty HOME/agent directory. No provider calls.
const server = http2.createServer({ settings: { initialWindowSize: 1024 } });
const sessions = new Set<http2.ServerHttp2Session>();
server.on("session", session => {
	sessions.add(session);
	session.on("error", () => {});
	session.on("close", () => sessions.delete(session));
});
const peerReady = Promise.withResolvers<http2.ServerHttp2Stream>();
server.on("stream", (stream: http2.ServerHttp2Stream) => {
	stream.on("error", () => {});
	stream.pause();
	stream.respond({ ":status": 200 });
	peerReady.resolve(stream);
});
let client: http2.ClientHttp2Session | undefined;
let request: http2.ClientHttp2Stream | undefined;
try {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
	client.on("error", () => {});
	await once(client, "remoteSettings");
	request = client.request({ ":method": "POST", ":path": "/paused" }, { endStream: false });
	const providerError = () => {};
	request.on("error", providerError);
	const peer = await peerReady.promise;
	assert.equal(peer.isPaused(), true);
	const baselineError = request.listenerCount("error");
	const baselineClose = request.listenerCount("close");
	let backpressure = false;
	const frame = Buffer.alloc(64 * 1024, 0x78);
	for (let i = 0; i < 32; i++) {
		if (!writeCursorFrameForTest(request, frame)) backpressure = true;
	}
	assert.equal(backpressure, true);
	assert.equal(request.listenerCount("error"), baselineError + 1);
	assert.equal(request.listenerCount("close"), baselineClose + 1);
	await assert.rejects(waitForCursorWritesForTest(request, 100), /write drain timed out after 100ms/);
	assert.equal(request.closed || request.destroyed, true);
	// Let actual transport close/error callbacks run before checking shared cleanup.
	if (!request.destroyed) await once(request, "close");
	const tick = Promise.withResolvers<void>();
	setImmediate(tick.resolve);
	await tick.promise;
	assert.equal(request.listeners("error").includes(providerError), true);
	assert.ok(request.listenerCount("error") <= baselineError);
	assert.ok(request.listenerCount("close") <= baselineClose);
	assert.equal(writeCursorFrameForTest(request, frame), false);
} finally {
	request?.destroy();
	client?.destroy();
	for (const session of sessions) session.destroy();
	const closed = Promise.withResolvers<void>();
	server.close(error => (error ? closed.reject(error) : closed.resolve()));
	await closed.promise;
}
console.log("paused-peer: bounded listeners, backpressure, timeout and cleanup verified");

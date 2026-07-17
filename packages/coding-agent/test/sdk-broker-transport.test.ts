import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Broker } from "../src/sdk/broker/broker";

async function nextFrame(ws: WebSocket): Promise<Record<string, unknown>> {
	return await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Timed out waiting for broker frame")), 2_000);
		ws.addEventListener(
			"message",
			event => {
				clearTimeout(timeout);
				resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
			},
			{ once: true },
		);
		ws.addEventListener(
			"error",
			() => {
				clearTimeout(timeout);
				reject(new Error("Broker WebSocket error"));
			},
			{ once: true },
		);
		ws.addEventListener(
			"close",
			event => {
				clearTimeout(timeout);
				reject(new Error(`Broker WebSocket closed (${event.code})`));
			},
			{ once: true },
		);
	});
}
async function connect(url: string): Promise<WebSocket> {
	const ws = new WebSocket(url);
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener("error", () => reject(new Error("Broker WebSocket error")), { once: true });
	});
	return ws;
}
describe("SDK broker WebSocket transport", () => {
	it("uses Rust-compatible request and response frames", async () => {
		const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-transport-"));
		const broker = new Broker({ agentDir, packageGeneration: "test" });
		const discovery = await broker.start();
		try {
			expect(JSON.parse(await fs.readFile(path.join(agentDir, "sdk", "broker.json"), "utf8"))).toMatchObject({
				port: discovery.port,
				url: discovery.url,
			});
			const wrong = new WebSocket(`${discovery.url}/?token=wrong`);
			await new Promise<void>(resolve => wrong.addEventListener("close", () => resolve(), { once: true }));
			const ws = await connect(`${discovery.url}/?token=${discovery.token}`);
			expect(await nextFrame(ws)).toEqual({ type: "broker_hello", protocolVersion: 3 });
			ws.send("{");
			expect(await nextFrame(ws)).toEqual({
				type: "broker_response",
				ok: false,
				error: { code: "invalid_input", message: "malformed JSON" },
			});
			const request = { type: "broker_request", id: "list", operation: "session.list", input: {} };
			expect(JSON.stringify(request)).toBe(
				'{"type":"broker_request","id":"list","operation":"session.list","input":{}}',
			);
			ws.send(JSON.stringify(request));
			expect(await nextFrame(ws)).toEqual({
				type: "broker_response",
				id: "list",
				ok: true,
				result: { indexSeq: 0, sessions: [], warnings: [] },
				indexSeq: 0,
			});
			ws.send(
				JSON.stringify({
					type: "broker_request",
					id: "create",
					operation: "session.create",
					input: {},
					idempotencyKey: "key",
				}),
			);
			expect(await nextFrame(ws)).toEqual({
				type: "broker_response",
				id: "create",
				ok: false,
				error: { code: "invalid_input", message: "A target path is required." },
			});
			ws.close();
		} finally {
			await broker.stop();
		}
	});
	it("rejects oversized frames without disrupting other authenticated clients", async () => {
		const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-transport-"));
		const broker = new Broker({ agentDir, packageGeneration: "test" });
		const discovery = await broker.start();
		try {
			const oversizedClient = await connect(`${discovery.url}/?token=${discovery.token}`);
			expect(await nextFrame(oversizedClient)).toEqual({ type: "broker_hello", protocolVersion: 3 });
			const healthyClient = await connect(`${discovery.url}/?token=${discovery.token}`);
			expect(await nextFrame(healthyClient)).toEqual({ type: "broker_hello", protocolVersion: 3 });
			const oversizedFrame = JSON.stringify({
				type: "broker_request",
				id: "too-large",
				operation: "session.list",
				input: { padding: "x".repeat(4 * 1024 * 1024) },
			});
			expect(Buffer.byteLength(oversizedFrame)).toBeGreaterThan(4 * 1024 * 1024);
			const oversizedResponse = nextFrame(oversizedClient);
			oversizedClient.send(oversizedFrame);
			expect(await oversizedResponse).toEqual({
				type: "broker_response",
				ok: false,
				error: { code: "payload_too_large", message: "broker JSON frame exceeds 4 MiB limit" },
			});
			healthyClient.send(
				JSON.stringify({ type: "broker_request", id: "healthy-list", operation: "session.list", input: {} }),
			);
			expect(await nextFrame(healthyClient)).toEqual({
				type: "broker_response",
				id: "healthy-list",
				ok: true,
				result: { indexSeq: 0, sessions: [], warnings: [] },
				indexSeq: 0,
			});
			oversizedClient.close();
			healthyClient.close();
		} finally {
			await broker.stop();
		}
	});
});

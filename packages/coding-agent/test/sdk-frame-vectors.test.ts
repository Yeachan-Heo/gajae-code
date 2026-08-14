import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ServerWebSocket } from "bun";
import { startRelayPair } from "../src/sdk/transport/relay.js";

const vectorsDir = path.join(import.meta.dir, "fixtures", "sdk-frame-vectors");
type Vector = Record<string, unknown>;

function requireObject(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) result[key] = entry;
	return result;
}

function requireArray(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new Error("Expected a JSON array.");
	return value;
}

function requireString(value: unknown): string {
	if (typeof value !== "string") throw new Error("Expected a string.");
	return value;
}

function requireNonNegativeInteger(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
		throw new Error("Expected a non-negative integer.");
	return value;
}

async function vectors(): Promise<Vector[]> {
	return await Promise.all(
		(await fs.readdir(vectorsDir))
			.filter(name => name.endsWith(".json"))
			.sort()
			.map(async name => requireObject(JSON.parse(await fs.readFile(path.join(vectorsDir, name), "utf8")))),
	);
}

function generated(vector: Vector): string {
	const generate = requireObject(vector.generate);
	const prefix = requireString(vector.prefix);
	const suffix = requireString(vector.suffix);
	const character = requireString(generate.character);
	const count = requireNonNegativeInteger(generate.count);
	expect(character).toHaveLength(1);
	return `${prefix}${character.repeat(count)}${suffix}`;
}

function upstream() {
	const connections: { ws: ServerWebSocket<unknown>; messages: string[] }[] = [];
	const server = Bun.serve<unknown>({
		port: 0,
		fetch(req, instance) {
			if (instance.upgrade(req, { data: {} })) return;
			return new Response("upgrade required", { status: 426 });
		},
		websocket: {
			open(ws) {
				connections.push({ ws, messages: [] });
			},
			message(ws, message) {
				connections.find(connection => connection.ws === ws)?.messages.push(String(message));
			},
		},
	});
	return { url: `ws://127.0.0.1:${server.port}`, connections, stop: () => server.stop(true) };
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined) return value;
		await Bun.sleep(5);
	}
	throw new Error("Timed out waiting for relay output.");
}

const pairs: Array<{ close(): Promise<void>; stop(): void }> = [];
afterEach(async () => {
	await Promise.all(
		pairs.splice(0).map(async pair => {
			await pair.close();
			pair.stop();
		}),
	);
});

describe("SDK frame conformance vectors", () => {
	test("every vector has the v1 schema and executable shape", async () => {
		const all = await vectors();
		expect(all.length).toBeGreaterThan(0);
		for (const vector of all) {
			expect(vector.$schema).toBe("sdk-frame-vectors/v1");
			expect(typeof vector.name).toBe("string");
			expect(vector.expectations).toBeObject();
			expect(["frame", "record", "generator"]).toContain(requireString(vector.kind));
			if (vector.kind === "frame") {
				const text =
					typeof vector.rawFrame === "string" ? vector.rawFrame : JSON.stringify(requireObject(vector.frame));
				if (typeof text !== "string") throw new Error("Frame vector did not serialize to JSON.");
				const frame = requireObject(JSON.parse(text));
				const expectations = requireObject(vector.expectations);
				expect(frame.type).toEqual(expectations.type ?? frame.type);
				expect(
					typeof vector.rawFrame === "string" || (vector.frame !== null && typeof vector.frame === "object"),
				).toBe(true);
			}
			if (vector.kind === "record") {
				if (vector.frames !== undefined)
					for (const frame of requireArray(vector.frames)) expect(typeof requireObject(frame).type).toBe("string");
				if (vector.lines !== undefined) {
					const lines = requireObject(vector.lines);
					expect(lines.authSuccess).toBe("gjc-sdk-transport/1 token=discovery-token-required\n");
					expect(requireObject(JSON.parse(requireString(lines.authFailure).trim()))).toMatchObject({
						type: "transport_error",
						code: "auth_failed",
					});
				}
				if (vector.staleDiscovery !== undefined)
					expect(requireObject(vector.staleDiscovery)).toMatchObject({ stale: true, token: "" });
				if (vector.frames === undefined && vector.lines === undefined && vector.staleDiscovery === undefined)
					throw new Error("Record vector has no records.");
			}
			if (vector.kind === "generator") {
				const text = generated(vector);
				const expectations = requireObject(vector.expectations);
				expect(Buffer.byteLength(text)).toBeGreaterThanOrEqual(
					requireNonNegativeInteger(expectations.minimumBytes),
				);
				expect(["turn_stream", "control_request"]).toContain(requireString(requireObject(JSON.parse(text)).type));
			}
		}
	});

	test("preserves every raw-frame vector through the relay", async () => {
		for (const vector of await vectors()) {
			if (typeof vector.rawFrame !== "string") continue;
			const fake = upstream();
			const input = new PassThrough();
			const output = new PassThrough();
			const received: Buffer[] = [];
			output.on("data", chunk => received.push(Buffer.from(chunk)));
			const pair = await startRelayPair({
				url: fake.url,
				token: "test-token",
				pendingCeilingBytes: 256 * 1024,
				downstream: input,
				downstreamSink: output,
				onTransportError: error => {
					throw error;
				},
			});
			pairs.push({ close: () => pair.close(), stop: fake.stop });
			const connection = await waitFor(() => fake.connections[0]);
			input.write(`${vector.rawFrame}\n`);
			expect(await waitFor(() => connection.messages[0])).toBe(vector.rawFrame);
			connection.ws.send(vector.rawFrame);
			expect((await waitFor(() => received[0])).toString()).toBe(`${vector.rawFrame}\n`);
		}
	});

	test("enforces correlations, lifecycle, and reply tokens", async () => {
		for (const vector of await vectors()) {
			const expectations = requireObject(vector.expectations);
			if (vector.frames === undefined) continue;
			const frames = requireArray(vector.frames).map(requireObject);
			if (expectations.correlatesBy === "id") expect(frames[0]?.id).toBe(frames[1]?.id);
			if (expectations.lifecycle)
				expect(frames.map(frame => frame.type)).toEqual(requireArray(expectations.lifecycle));
			if (expectations.replyTokenRequired) {
				const token = frames.find(frame => frame.type === "reply")?.token;
				expect(typeof token).toBe("string");
				expect(requireString(token)).not.toHaveLength(0);
			}
		}
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { CliParseError, renderCommandHelp } from "@gajae-code/utils/cli";
import type { ServerWebSocket } from "bun";
import Sdk, { parseSdkInternalArgv } from "../src/commands/sdk.js";
import { listSdkSessionEndpoints } from "../src/sdk/client/discovery.js";
import { classifyEndpoint, selectLiveEndpoint } from "../src/sdk/client/liveness.js";
import { type RelayWebSocket, startRelayPair, type TransportError } from "../src/sdk/transport/relay.js";
import { resolveServePendingCeiling, runSdkServe } from "../src/sdk/transport/serve-cli.js";
import { startSocketServe } from "../src/sdk/transport/socket.js";

const token = "test-token";
const waitFor = async <T>(read: () => T | undefined, label: string): Promise<T> => {
	const end = Date.now() + 3_000;
	while (Date.now() < end) {
		const value = read();
		if (value !== undefined) return value;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${label}`);
};
const socketConnect = async (socketPath: string): Promise<net.Socket> =>
	await new Promise((resolve, reject) => {
		const socket = net.createConnection({ path: socketPath, allowHalfOpen: true }, () => resolve(socket));
		socket.once("error", reject);
	});
const readLine = async (socket: net.Socket): Promise<string> => {
	let bytes = Buffer.alloc(0);
	return await new Promise((resolve, reject) => {
		const data = (chunk: Buffer) => {
			bytes = Buffer.concat([bytes, chunk]);
			const newline = bytes.indexOf("\n");
			if (newline >= 0) done(() => resolve(bytes.subarray(0, newline + 1).toString()));
		};
		const done = (fn: () => void) => {
			socket.off("data", data);
			socket.off("error", fail);
			socket.off("end", ended);
			fn();
		};
		const fail = (error: Error) => done(() => reject(error));
		const ended = () => done(() => reject(new Error("Socket ended before a complete line.")));
		socket.on("data", data);
		socket.once("error", fail);
		socket.once("end", ended);
	});
};
const closeSocket = (socket: net.Socket): Promise<void> =>
	new Promise(resolve => {
		socket.once("close", resolve);
		socket.destroy();
	});

function upstream() {
	const connections: { ws: ServerWebSocket<unknown>; messages: string[] }[] = [];
	const server = Bun.serve<unknown>({
		port: 0,
		fetch(req, server) {
			if (server.upgrade(req, { data: {} })) return;
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

const temporary: string[] = [];
afterEach(async () => {
	await Promise.all(temporary.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
const tempDir = async (): Promise<string> => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-serve-"));
	temporary.push(dir);
	return dir;
};

class StalledWebSocket implements RelayWebSocket {
	static readonly CLOSED = 3;
	static latest: StalledWebSocket | undefined;
	readonly url: string;
	readyState = 0;
	#bufferedAmount = 0;
	#listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();
	closeCalls = 0;
	readonly messages: string[] = [];

	constructor(url: string) {
		this.url = url;
		StalledWebSocket.latest = this;
	}

	get bufferedAmount(): number {
		return this.#bufferedAmount;
	}

	open(): void {
		this.readyState = 1;
		this.#emit("open");
	}

	send(data: string): void {
		this.messages.push(data);
		this.#bufferedAmount += Buffer.byteLength(data);
	}

	drain(): void {
		this.#bufferedAmount = 0;
	}

	close(): void {
		this.closeCalls++;
		this.readyState = 3;
		this.#emit("close");
	}

	addEventListener(type: string, listener: (event: { data?: unknown }) => void, options?: { once?: boolean }): void {
		const listeners = this.#listeners.get(type) ?? new Set();
		const registered = options?.once
			? (event: { data?: unknown }) => {
					this.removeEventListener(type, registered);
					listener(event);
				}
			: listener;
		listeners.add(registered);
		this.#listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
		this.#listeners.get(type)?.delete(listener);
	}

	#emit(type: string, event: { data?: unknown } = {}): void {
		for (const listener of this.#listeners.get(type) ?? []) listener(event);
	}
}

async function withStalledWebSocket<T>(run: () => Promise<T>): Promise<T> {
	StalledWebSocket.latest = undefined;
	try {
		return await run();
	} finally {
		StalledWebSocket.latest = undefined;
	}
}

async function relayFixture(pendingCeilingBytes = 256 * 1024) {
	const fake = upstream();
	const input = new PassThrough();
	const output = new PassThrough();
	const received: Buffer[] = [];
	output.on("data", chunk => received.push(Buffer.from(chunk)));
	const errors: TransportError[] = [];
	const pair = await startRelayPair({
		url: fake.url,
		token,
		pendingCeilingBytes,
		downstream: input,
		downstreamSink: output,
		onTransportError: error => errors.push(error),
	});
	await waitFor(() => fake.connections[0], "upstream connection");
	return { fake, input, output, received, errors, pair };
}

describe("SDK serve raw relay", () => {
	test("preserves non-canonical JSON bytes in both directions", async () => {
		const fixture = await relayFixture();
		try {
			const request = '{ "z" : "\\u0061", "a": [ 3,2,1 ] }';
			fixture.input.write(`${request}\n`);
			const connection = await waitFor(() => fixture.fake.connections[0]?.messages[0], "downstream websocket frame");
			expect(connection).toBe(request);
			const response = '{"b" : "\\u263a", "a":true }';
			fixture.fake.connections[0]!.ws.send(response);
			expect((await waitFor(() => fixture.received[0], "websocket downstream frame")).toString()).toBe(
				`${response}\n`,
			);
		} finally {
			await fixture.pair.close();
			fixture.fake.stop();
		}
	});

	test("enforces only the downstream 256 KiB boundary", async () => {
		const accepted = await relayFixture();
		try {
			accepted.input.write(`${"x".repeat(256 * 1024)}\n`);
			expect((await waitFor(() => accepted.fake.connections[0]?.messages[0], "boundary frame")).length).toBe(
				256 * 1024,
			);
			accepted.fake.connections[0]!.ws.send("y".repeat(1024 * 1024 + 1));
			expect((await waitFor(() => accepted.received[0], "large reverse frame")).length).toBe(1024 * 1024 + 2);
		} finally {
			await accepted.pair.close();
			accepted.fake.stop();
		}
		const rejected = await relayFixture();
		try {
			rejected.input.write(`${"x".repeat(256 * 1024 + 1)}\n`);
			expect(await waitFor(() => rejected.errors[0], "oversize error")).toMatchObject({ code: "frame_oversize" });
		} finally {
			await rejected.pair.close();
			rejected.fake.stop();
		}
	});

	test("allows a single active reverse frame above the pending ceiling and reports queued overflow", async () => {
		const fixture = await relayFixture(256 * 1024);
		const blocked = new Writable({ highWaterMark: 1, write() {} });
		try {
			// Replace the consumer with a deliberately backpressured relay to exercise active-frame exemption.
			const input = new PassThrough();
			const errors: TransportError[] = [];
			const pair = await startRelayPair({
				url: fixture.fake.url,
				token,
				pendingCeilingBytes: 256 * 1024,
				downstream: input,
				downstreamSink: blocked,
				onTransportError: error => errors.push(error),
			});
			const connection = await waitFor(() => fixture.fake.connections[1], "second upstream connection");
			connection.ws.send("a".repeat(8 * 1024 * 1024 + 1));
			await Bun.sleep(20);
			expect(errors).toEqual([]);
			connection.ws.send("b".repeat(256 * 1024));
			connection.ws.send("c".repeat(256 * 1024));
			expect(await waitFor(() => errors[0], "pending overflow")).toMatchObject({
				code: "pending_overflow",
				direction: "ws->downstream",
			});
			await pair.close();
		} finally {
			await fixture.pair.close();
			fixture.fake.stop();
		}
	});

	test("keeps a downstream frame active until the WebSocket buffer drains", async () => {
		await withStalledWebSocket(async () => {
			const input = new PassThrough();
			const output = new PassThrough();
			const errors: TransportError[] = [];
			const started = startRelayPair({
				url: "ws://fake",
				token,
				pendingCeilingBytes: 256 * 1024,
				downstream: input,
				downstreamSink: output,
				onTransportError: error => errors.push(error),
				webSocketFactory: () => new StalledWebSocket(""),
			});
			const ws = await waitFor(() => StalledWebSocket.latest, "fake websocket");
			ws.open();
			const pair = await started;
			try {
				input.write('{"active":true}\n');
				await waitFor(() => ws.messages[0], "active websocket frame");
				input.write(`${"q".repeat(256 * 1024)}\n{"overflow":true}\n`);
				expect(await waitFor(() => errors[0], "downstream pending overflow")).toMatchObject({
					code: "pending_overflow",
					direction: "downstream->ws",
				});
			} finally {
				ws.drain();
				await pair.close();
			}
		});
	});

	test("forwards a large downstream frame after its active WebSocket buffer drains", async () => {
		await withStalledWebSocket(async () => {
			const input = new PassThrough();
			const output = new PassThrough();
			const started = startRelayPair({
				url: "ws://fake",
				token,
				pendingCeilingBytes: 256 * 1024,
				downstream: input,
				downstreamSink: output,
				onTransportError: () => {},
				webSocketFactory: () => new StalledWebSocket(""),
			});
			const ws = await waitFor(() => StalledWebSocket.latest, "fake websocket");
			ws.open();
			const pair = await started;
			try {
				const frame = "x".repeat(256 * 1024);
				input.write(`${frame}\n{"after":"drain"}\n`);
				expect(await waitFor(() => ws.messages[0], "large active frame")).toBe(frame);
				ws.drain();
				expect(await waitFor(() => ws.messages[1], "frame after drain")).toBe('{"after":"drain"}');
			} finally {
				await pair.close();
			}
		});
	});
});

describe("SDK socket serve", () => {
	test("auth failures emit a single error and never dial upstream", async () => {
		const fake = upstream();
		const dir = await tempDir();
		const socketPath = path.join(dir, "serve.sock");
		const handle = await startSocketServe({ url: fake.url, token, pendingCeilingBytes: 256 * 1024, socketPath });
		try {
			for (const preface of [
				"gjc-sdk-transport/1 token=wrong\n",
				"garbage\n",
				"gjc-sdk-transport/2 token=test-token\n",
				`${"x".repeat(4097)}\n`,
			] as const) {
				const client = await socketConnect(socketPath);
				client.write(preface);
				expect(JSON.parse(await readLine(client))).toEqual({ type: "transport_error", code: "auth_failed" });
				await closeSocket(client);
			}
			const slow = await socketConnect(socketPath);
			expect(JSON.parse(await readLine(slow))).toEqual({ type: "transport_error", code: "auth_failed" });
			await closeSocket(slow);
			expect(fake.connections).toHaveLength(0);
		} finally {
			await handle.close();
			fake.stop();
		}
	}, 8_000);

	test("pauses after authentication so a frame received during upstream dial is relayed", async () => {
		await withStalledWebSocket(async () => {
			const dir = await tempDir();
			const socketPath = path.join(dir, "serve.sock");
			const handle = await startSocketServe({
				url: "ws://fake",
				token,
				pendingCeilingBytes: 256 * 1024,
				socketPath,
				webSocketFactory: () => new StalledWebSocket(""),
			});
			const client = await socketConnect(socketPath);
			try {
				client.write(`gjc-sdk-transport/1 token=${token}\n`);
				const ws = await waitFor(() => StalledWebSocket.latest, "upstream dial");
				client.write('{"received":"during-dial"}\n');
				ws.open();
				expect(await waitFor(() => ws.messages[0], "handed-off frame")).toBe('{"received":"during-dial"}');
			} finally {
				await closeSocket(client);
				await handle.close();
			}
		});
	});

	test("aborts an authenticated upstream dial during shutdown", async () => {
		await withStalledWebSocket(async () => {
			const dir = await tempDir();
			const socketPath = path.join(dir, "serve.sock");
			const handle = await startSocketServe({
				url: "ws://fake",
				token,
				pendingCeilingBytes: 256 * 1024,
				socketPath,
				webSocketFactory: () => new StalledWebSocket(""),
			});
			const client = await socketConnect(socketPath);
			client.write(`gjc-sdk-transport/1 token=${token}\n`);
			const ws = await waitFor(() => StalledWebSocket.latest, "stalled upstream dial");
			await handle.close();
			await handle.done;
			expect(ws.closeCalls).toBe(1);
			expect(ws.readyState).toBe(StalledWebSocket.CLOSED);
			client.destroy();
		});
	}, 1_000);

	test("isolates pairs, enforces socket safety, and cleans up only its own socket", async () => {
		const fake = upstream();
		const dir = await tempDir();
		const socketPath = path.join(dir, "serve.sock");
		const handle = await startSocketServe({ url: fake.url, token, pendingCeilingBytes: 256 * 1024, socketPath });
		try {
			expect((await fs.stat(socketPath)).mode & 0o777).toBe(0o600);
			const a = await socketConnect(socketPath);
			const b = await socketConnect(socketPath);
			a.write(`gjc-sdk-transport/1 token=${token}\n{ "client": "a" }\n`);
			b.write(`gjc-sdk-transport/1 token=${token}\n{ "client": "b" }\n`);
			await waitFor(() => (fake.connections.length === 2 ? fake.connections : undefined), "isolated upstream pairs");
			expect(fake.connections.map(connection => connection.messages[0]).sort()).toEqual([
				'{ "client": "a" }',
				'{ "client": "b" }',
			]);
			await closeSocket(a);
			await Bun.sleep(20);
			b.write('{"still":"running"}\n');
			expect(await waitFor(() => fake.connections[1]?.messages[1], "remaining pair")).toBe('{"still":"running"}');
			const c = await socketConnect(socketPath);
			c.write(`gjc-sdk-transport/1 token=${token}\n`);
			await waitFor(() => (fake.connections.length === 3 ? fake.connections : undefined), "listener remains active");
			await closeSocket(c);
			await closeSocket(b);
			await fs.unlink(socketPath);
			await fs.writeFile(socketPath, "replacement");
		} finally {
			await handle.close();
			fake.stop();
		}
		expect(await fs.readFile(socketPath, "utf8")).toBe("replacement");
	});

	test("refuses existing paths and insecure parent directories", async () => {
		const fake = upstream();
		const dir = await tempDir();
		const occupied = path.join(dir, "occupied.sock");
		await fs.writeFile(occupied, "x");
		await expect(
			startSocketServe({ url: fake.url, token, pendingCeilingBytes: 256 * 1024, socketPath: occupied }),
		).rejects.toThrow("socket_path_in_use");
		await fs.chmod(dir, 0o777);
		await expect(
			startSocketServe({
				url: fake.url,
				token,
				pendingCeilingBytes: 256 * 1024,
				socketPath: path.join(dir, "unsafe.sock"),
			}),
		).rejects.toThrow("socket_dir_insecure");
		fake.stop();
	});
});

describe("SDK serve CLI and discovery", () => {
	test("keeps private argv exact and public help private", () => {
		expect(parseSdkInternalArgv(["broker-internal", "--agent-dir", "/tmp/a"])).toEqual({
			action: "broker-internal",
			agentDir: "/tmp/a",
		});
		expect(parseSdkInternalArgv(["session-host-internal"])).toEqual({ action: "session-host-internal" });
		expect(() => parseSdkInternalArgv(["broker-internal"])).toThrow(CliParseError);
		const output: string[] = [];
		const stdout = process.stdout.write;
		(process.stdout as unknown as { write(value: string): boolean }).write = value => {
			output.push(value);
			return true;
		};
		try {
			renderCommandHelp("gjc", "sdk", Sdk);
		} finally {
			(process.stdout as unknown as { write: typeof stdout }).write = stdout;
		}
		const help = output.join("\n");
		expect(help).toContain("serve");
		expect(help).toContain("--socket");
		expect(help).not.toContain("broker-internal");
		expect(help).not.toContain("session-host-internal");
		expect(help).not.toContain("--agent-dir");
	});

	test("rejects invalid serve mode and ceiling before discovery", async () => {
		await expect(runSdkServe([])).rejects.toThrow(CliParseError);
		await expect(runSdkServe(["--stdio", "--socket", "/tmp/x"])).rejects.toThrow(CliParseError);
		await expect(runSdkServe(["--stdio", "--pending-ceiling", "262143"])).rejects.toThrow(CliParseError);
		await expect(runSdkServe(["--stdio", "--pending-ceiling", "nope"])).rejects.toThrow(CliParseError);
	});

	test("parses stale tombstones and fails endpoint selection closed", async () => {
		const repo = await tempDir();
		const state = path.join(repo, ".gjc", "state", "sdk");
		await fs.mkdir(state, { recursive: true });
		await fs.writeFile(
			path.join(state, "stale.json"),
			JSON.stringify({ url: "ws://x", stale: true, token: "", pid: -1 }),
		);
		await fs.writeFile(path.join(state, "bad.json"), JSON.stringify({ url: "ws://x", token: "" }));
		const records = await listSdkSessionEndpoints(repo);
		expect(records.endpoints[0]).toMatchObject({ sessionId: "stale", stale: true, token: "" });
		expect(records.warnings).toHaveLength(1);
		const dead = { sessionId: "dead", url: "ws://x", token, pid: 99999999, path: "x" };
		const unknown = { ...dead, sessionId: "unknown", pid: 0 };
		expect(classifyEndpoint(dead)).toBe("dead");
		expect(classifyEndpoint(unknown)).toBe("unknown");
		expect(selectLiveEndpoint(records.endpoints, "stale")).toEqual({ code: "endpoint_stale" });
		expect(selectLiveEndpoint([])).toEqual({ code: "no_live_endpoint" });
		const live = { ...dead, sessionId: "live", pid: process.pid };
		expect(selectLiveEndpoint([live, { ...live, sessionId: "live2" }])).toEqual({ code: "multiple_live_endpoints" });
	});

	test("resolves the pending ceiling with flag > env > default precedence", () => {
		expect(resolveServePendingCeiling(undefined, undefined)).toBe(8 * 1024 * 1024);
		expect(resolveServePendingCeiling(undefined, String(512 * 1024))).toBe(512 * 1024);
		expect(resolveServePendingCeiling(String(1024 * 1024), String(512 * 1024))).toBe(1024 * 1024);
		expect(() => resolveServePendingCeiling(undefined, "262143")).toThrow(CliParseError);
		expect(() => resolveServePendingCeiling("nope", undefined)).toThrow(CliParseError);
	});

	test("keeps the downstream sink pure: frames only, diagnostics to the error channel", async () => {
		const fixture = await relayFixture();
		try {
			const frame = '{"type":"hello","x":1}';
			fixture.fake.connections[0]!.ws.send(frame);
			expect((await waitFor(() => fixture.received[0], "relayed frame")).toString()).toBe(`${frame}\n`);
			// Force a transport error and assert it reaches only the error channel, never the frame sink.
			fixture.input.write("\n");
			await waitFor(() => fixture.errors[0], "transport error");
			const sinkBytes = Buffer.concat(fixture.received).toString();
			expect(sinkBytes).toBe(`${frame}\n`);
			expect(sinkBytes).not.toContain("transport_error");
		} finally {
			await fixture.pair.close();
			fixture.fake.stop();
		}
	});
});

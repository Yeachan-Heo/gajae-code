import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { CliParseError } from "@gajae-code/utils/cli";
import type { ServerWebSocket } from "bun";
import {
	PUBLIC_COMMAND_DIAGNOSTICS,
	PublicCommandFailure,
	renderPublicCommandFailure,
} from "../src/cli/public-command-errors";
import { renderPublicCommandHelp } from "../src/cli/public-command-help";
import { parseSdkInternalArgv } from "../src/commands/sdk.js";
import { SdkClientError } from "../src/sdk/client/client.js";
import { listSdkSessionEndpoints } from "../src/sdk/client/discovery.js";
import { classifyEndpoint, selectLiveEndpoint } from "../src/sdk/client/liveness.js";
import { type RelayWebSocket, startRelayPair, type TransportError } from "../src/sdk/transport/relay.js";
import {
	listBrokerSessions,
	ownSdkServeTransport,
	resolveServePendingCeiling,
	runSdkServe,
	type SdkServeDependencies,
	selectBrokerSession,
} from "../src/sdk/transport/serve-cli.js";
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

async function relayFixture(pendingCeilingBytes = 256 * 1024, validateDownstreamFrame?: (frame: string) => boolean) {
	// Under heavy parallel suite load the first localhost WebSocket open can fail
	// before the fake upstream accepts. Retry only that pre-acceptance failure.
	let retryCount = 0;
	for (;;) {
		const fake = upstream();
		const input = new PassThrough();
		const output = new PassThrough();
		const received: Buffer[] = [];
		output.on("data", chunk => received.push(Buffer.from(chunk)));
		const errors: TransportError[] = [];
		try {
			const pair = await startRelayPair({
				url: fake.url,
				token,
				pendingCeilingBytes,
				downstream: input,
				downstreamSink: output,
				onTransportError: error => errors.push(error),
				validateDownstreamFrame,
			});
			await waitFor(() => fake.connections[0], "upstream connection");
			expect(retryCount).toBeLessThanOrEqual(1);
			return { fake, input, output, received, errors, pair };
		} catch (error) {
			const retryable =
				retryCount === 0 &&
				fake.connections.length === 0 &&
				error instanceof Error &&
				error.message === "upstream_error";
			fake.stop();
			if (!retryable) throw error;
			retryCount++;
		}
	}
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

	test("rejects a downstream frame refused by the injected relay validator", async () => {
		const fixture = await relayFixture(256 * 1024, source => {
			const frame = JSON.parse(source) as { forgedAuthorityField?: unknown };
			return frame.forgedAuthorityField === undefined;
		});
		try {
			fixture.input.write(`${JSON.stringify({ type: "control_request", forgedAuthorityField: "forged" })}\n`);
			expect(await waitFor(() => fixture.errors[0], "forged claim rejection")).toMatchObject({
				code: "protocol_error",
				direction: "downstream->ws",
			});
			expect(fixture.fake.connections[0]?.messages).toEqual([]);
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
	test("closes the bound listener and removes exit cleanup when post-listen lstat fails", async () => {
		const dir = await tempDir();
		const socketPath = path.join(dir, "startup-failure.sock");
		const startupError = new Error("post-listen lstat failed");
		const exitListeners = process.listenerCount("exit");
		const close = spyOn(net.Server.prototype, "close");
		const lstat = spyOn(fs, "lstat")
			.mockRejectedValueOnce(Object.assign(new Error("absent"), { code: "ENOENT" }))
			.mockRejectedValueOnce(startupError);
		try {
			await expect(
				startSocketServe({ url: "ws://127.0.0.1:1", token, pendingCeilingBytes: 256 * 1024, socketPath }),
			).rejects.toBe(startupError);
			expect(lstat).toHaveBeenCalledTimes(2);
			expect(close).toHaveBeenCalledTimes(1);
			expect(process.listenerCount("exit")).toBe(exitListeners);
		} finally {
			lstat.mockRestore();
			close.mockRestore();
		}
		// Rebinding uses the real filesystem and listener, not a mocked transport.
		const handle = await startSocketServe({
			url: "ws://127.0.0.1:1",
			token,
			pendingCeilingBytes: 256 * 1024,
			socketPath,
		});
		await handle.close();
		await handle.done;
		expect(process.listenerCount("exit")).toBe(exitListeners);
	});

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
			await waitFor(
				() =>
					fake.connections.length === 2 &&
					fake.connections.every(connection => connection.messages[0] !== undefined)
						? fake.connections
						: undefined,
				"isolated upstream pairs",
			);
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
	test("advertises public SDK families without leaking internal actions", () => {
		expect(parseSdkInternalArgv(["broker-internal", "--agent-dir", "/tmp/a"])).toEqual({
			action: "broker-internal",
			agentDir: "/tmp/a",
		});
		expect(parseSdkInternalArgv(["session-host-internal"])).toEqual({ action: "session-host-internal" });
		expect(() => parseSdkInternalArgv(["broker-internal"])).toThrow(CliParseError);
		const output: string[] = [];
		for (const command of [["sdk"], ["sdk", "serve"]]) {
			let rendered = renderPublicCommandHelp(command);
			output.push(rendered.output);
			while (rendered.document.next) {
				const { section, page } = rendered.document.next;
				rendered = renderPublicCommandHelp(command, { section, page, revision: rendered.document.revision });
				output.push(rendered.output);
			}
		}
		const help = output.join("\n");
		expect(help).toContain("serve");
		expect(help).toContain("--socket");
		expect(help).toContain("session");
		expect(help).toContain("guides");
		expect(help).not.toContain("broker-internal");
		expect(help).not.toContain("session-host-internal");
		expect(help).not.toContain("--agent-dir");
	});

	test("preflight preserves SDK-owned classifications and sanitized cleanup evidence without transport output", async () => {
		for (const [code, kind, proof] of [
			["broker_restarting", "broker_restarting", "pre-effect"],
			["unauthorized", "authorization_denied", "pre-effect"],
			["forbidden", "authorization_denied", "pre-effect"],
			["authorization_denied", "authorization_denied", "pre-effect"],
			["timeout", "timeout", "unknown"],
			["unavailable", "unavailable", "unknown"],
			["endpoint_stale", "endpoint_stale", "pre-effect"],
			["uncertain_after_send", "uncertain_after_send", "sent"],
			["secret-unknown-code", "operation_failed", undefined],
		] as const) {
			for (const cleanupFails of [false, true]) {
				const calls: string[] = [];
				const dependencies: SdkServeDependencies = {
					readDiscovery: async () => ({ url: "ws://unused", token: "secret-token" }),
					connect: async () => ({
						global: async () => {
							calls.push("list");
							throw new SdkClientError(code, "secret-message", { token: "secret-token" });
						},
						close: async () => {
							calls.push("close");
							if (cleanupFails) throw new Error("secret-cleanup");
						},
					}),
					startStdio: async () => {
						calls.push("start");
						throw new Error("unexpected transport start");
					},
					startSocket: async () => {
						calls.push("start");
						throw new Error("unexpected transport start");
					},
				};
				let failure: unknown;
				try {
					await runSdkServe(["--stdio", "--pending-ceiling", "262144"], dependencies);
				} catch (error) {
					failure = error;
				}
				expect(failure).toBeInstanceOf(PublicCommandFailure);
				const input = (failure as PublicCommandFailure).input;
				expect(input.kind).toBe(kind);
				expect(input.proof).toBe(proof);
				expect(input.diagnostics ?? []).toEqual(cleanupFails ? ["broker_cleanup_failed"] : []);
				expect(JSON.stringify(failure)).not.toContain("secret");
				expect(calls).toEqual(["list", "close"]);
			}
		}
	});

	test("connection failures retain SDK classification but unknown error codes have no authority", async () => {
		for (const error of [
			new SdkClientError("broker_restarting", "secret"),
			Object.assign(new Error("secret"), { code: "broker_restarting" }),
		]) {
			const dependencies: SdkServeDependencies = {
				readDiscovery: async () => ({ url: "ws://unused", token: "unused" }),
				connect: async () => {
					throw error;
				},
				startStdio: async () => {
					throw new Error("unexpected transport start");
				},
				startSocket: async () => {
					throw new Error("unexpected transport start");
				},
			};
			await expect(runSdkServe(["--stdio", "--pending-ceiling", "262144"], dependencies)).rejects.toMatchObject({
				input: {
					kind: error instanceof SdkClientError ? "broker_restarting" : "broker_unavailable",
					proof: "pre-effect",
				},
			});
		}
	});

	test("startup failure retains its primary typed evidence when broker cleanup fails", async () => {
		const primary = new PublicCommandFailure({
			kind: "timeout",
			proof: "sent",
			references: [{ kind: "sessionId", value: "session-one" }],
		});
		const dependencies: SdkServeDependencies = {
			readDiscovery: async () => ({ url: "ws://unused", token: "unused" }),
			connect: async () => ({
				global: async operation =>
					operation === "session.list"
						? { ok: true, result: { sessions: [{ sessionId: "session-one", live: true }], warnings: [] } }
						: { ok: true, result: { url: "ws://unused", token: "unused" } },
				close: async () => {
					throw new Error("secret-cleanup");
				},
			}),
			startStdio: async () => {
				throw primary;
			},
			startSocket: async () => {
				throw new Error("unexpected socket start");
			},
		};
		await expect(runSdkServe(["--stdio", "--pending-ceiling", "262144"], dependencies)).rejects.toMatchObject({
			input: { ...primary.input, diagnostics: ["broker_cleanup_failed"] },
		});
	});

	test("transport ownership contains failures before any bytes and always cleans up", async () => {
		// Bun needs a numeric restoration after the intentional nonzero exit;
		// undefined means the prior effective exit was zero, not a reset value.
		const exitCode = process.exitCode ?? 0;
		const stderr = process.stderr.write;
		const diagnostics: string[] = [];
		const beforeInt = process.listenerCount("SIGINT");
		const beforeTerm = process.listenerCount("SIGTERM");
		(process.stderr as unknown as { write(value: string): boolean }).write = value => {
			diagnostics.push(value);
			return true;
		};
		const calls: string[] = [];
		try {
			await expect(
				ownSdkServeTransport(
					{
						done: Promise.reject(new Error("secret-token")),
						close: async () => {
							calls.push("transport");
							throw new Error("secret-path");
						},
					},
					async () => {
						calls.push("broker");
						throw new Error("secret-broker");
					},
				),
			).resolves.toBeUndefined();
			expect(calls).toEqual(["transport", "broker"]);
			expect(process.exitCode).toBe(1);
			expect(diagnostics).toEqual(['{"type":"transport_error","code":"serve_failed"}\n']);
			expect(process.listenerCount("SIGINT")).toBe(beforeInt);
			expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
		} finally {
			process.stderr.write = stderr;
			process.exitCode = exitCode;
		}
	});

	test("cleanup failure after successful transport completion stays transport-owned", async () => {
		const exitCode = process.exitCode ?? 0;
		const stderr = process.stderr.write;
		const diagnostics: string[] = [];
		(process.stderr as unknown as { write(value: string): boolean }).write = value => {
			diagnostics.push(value);
			return true;
		};
		try {
			await expect(
				ownSdkServeTransport({ done: Promise.resolve(), close: async () => {} }, async () => {
					throw new Error("credential-in-cleanup");
				}),
			).resolves.toBeUndefined();
			expect(process.exitCode).toBe(1);
			expect(diagnostics).toEqual(['{"type":"transport_error","code":"serve_failed"}\n']);
		} finally {
			process.stderr.write = stderr;
			process.exitCode = exitCode;
		}
	});

	test("successful transport completion closes both owners without ordinary output", async () => {
		const calls: string[] = [];
		const exitCode = process.exitCode;
		await ownSdkServeTransport(
			{
				done: Promise.resolve(),
				close: async () => {
					calls.push("transport");
				},
			},
			async () => {
				calls.push("broker");
			},
		);
		expect(calls).toEqual(["transport", "broker"]);
		expect(process.exitCode).toBe(exitCode);
	});
	test("rejects invalid serve mode and ceiling before discovery", async () => {
		await expect(runSdkServe([])).rejects.toBeInstanceOf(PublicCommandFailure);
		await expect(runSdkServe(["--stdio", "--socket", "/tmp/x"])).rejects.toMatchObject({ input: { kind: "usage" } });
		await expect(runSdkServe(["--stdio", "--pending-ceiling", "262143"])).rejects.toMatchObject({
			input: { kind: "usage" },
		});
		await expect(runSdkServe(["--stdio", "--pending-ceiling", "nope"])).rejects.toMatchObject({
			input: { kind: "usage" },
		});
	});

	test.each([
		[["--stdio", "--socket", "/tmp/x"], "usage_transport_exclusive"],
		[["--stdio", "--stdio"], "usage_duplicate_option"],
		[["--bogus"], "usage_unknown_argument"],
		[["--socket"], "usage_missing_value"],
		[["--stdio", "--pending-ceiling", "nope"], "usage_invalid_option_value"],
	] as const)("usage failure %j stays actionable without echoing argv (%s)", async (argv, diagnostic) => {
		const failure = await runSdkServe([...argv]).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(PublicCommandFailure);
		expect((failure as PublicCommandFailure).input.diagnostics).toEqual([diagnostic]);
		const rendered = await renderPublicCommandFailure(failure, { command: ["sdk", "serve"], json: true });
		expect(rendered.stderr).toBe("");
		const envelope = JSON.parse(rendered.stdout) as { error: { category: string }; diagnostics: unknown[] };
		expect(envelope.error.category).toBe("usage");
		expect(envelope.diagnostics).toEqual([{ code: diagnostic, message: PUBLIC_COMMAND_DIAGNOSTICS[diagnostic] }]);
		expect(rendered.stdout).not.toContain("--bogus");
	});

	test("an endpoint without its minted credential fails pre-effect and never starts the transport", async () => {
		const calls: string[] = [];
		const dependencies: SdkServeDependencies = {
			readDiscovery: async () => ({ url: "ws://unused", token: "unused" }),
			connect: async () => ({
				global: async operation =>
					operation === "session.list"
						? { ok: true, result: { sessions: [{ sessionId: "session-one", live: true }], warnings: [] } }
						: { ok: true, result: { url: "ws://unused", token: "" } },
				close: async () => {
					calls.push("close");
				},
			}),
			startStdio: async () => {
				calls.push("start");
				throw new Error("unexpected transport start");
			},
			startSocket: async () => {
				calls.push("start");
				throw new Error("unexpected transport start");
			},
		};
		await expect(runSdkServe(["--stdio", "--pending-ceiling", "262144"], dependencies)).rejects.toMatchObject({
			input: { kind: "unavailable", proof: "pre-effect" },
		});
		expect(calls).toEqual(["close"]);
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
		expect(() => resolveServePendingCeiling(undefined, "262143")).toThrow(PublicCommandFailure);
		expect(() => resolveServePendingCeiling("nope", undefined)).toThrow(PublicCommandFailure);
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
	test("serve targets a live session beyond the first 100-session page", async () => {
		// The broker's session.list page limit is 100; the live target is the
		// 150th row, so only an exhausted paginated snapshot can select it.
		const sessions = Array.from({ length: 150 }, (_, index) => ({
			sessionId: `sess-${index + 1}`,
			live: index === 149,
			ambiguous: false,
		}));
		const broker = {
			global: async (operation: string, input: Record<string, unknown>) => {
				if (operation !== "session.list") return { ok: false, error: { code: "unknown_operation" } };
				if (input.cursor === "page-2")
					return { ok: true, result: { indexSeq: 1, sessions: sessions.slice(100), warnings: [] } };
				return {
					ok: true,
					result: {
						indexSeq: 1,
						sessions: sessions.slice(0, 100),
						warnings: [],
						continuationCursor: "page-2",
					},
				};
			},
			close: async () => {},
		} as never;
		const exactInputs: Record<string, unknown>[] = [];
		const exactBroker = {
			global: async (_operation: string, input: Record<string, unknown>) => {
				exactInputs.push(input);
				return { ok: true, result: { sessions: [sessions[149]], warnings: [] } };
			},
		} as never;
		expect(await listBrokerSessions(exactBroker, "sess-150")).toEqual([sessions[149]]);
		expect(exactInputs).toEqual([{ resolveSessionId: "sess-150" }]);
		const rows = await listBrokerSessions(broker);
		expect(rows).toHaveLength(150);
		// Explicit targeting resolves the row only the second page carries.
		expect(selectBrokerSession(rows, "sess-150")).toBe("sess-150");
		// Auto-selection also observes beyond-page liveness.
		expect(selectBrokerSession(rows, undefined)).toBe("sess-150");
		// First-page rows are still governed by the same broker truth.
		expect(() => selectBrokerSession(rows, "sess-1")).toThrow(PublicCommandFailure);
	});

	test("rejects malformed broker session.list pages instead of treating them as empty", async () => {
		const broker = {
			global: async () => ({ ok: true, result: { sessions: "not-an-array" } }),
		} as never;

		await expect(listBrokerSessions(broker)).rejects.toBeInstanceOf(SdkClientError);
		await expect(
			listBrokerSessions({ global: async () => ({ ok: true, result: { sessions: "not-an-array" } }) } as never),
		).rejects.toMatchObject({ code: "protocol_error", message: "session.list returned a malformed page." });
	});

	test("rejects malformed broker session.list continuation cursors", async () => {
		await expect(
			listBrokerSessions({
				global: async () => ({ ok: true, result: { sessions: [], continuationCursor: "" } }),
			} as never),
		).rejects.toMatchObject({ code: "protocol_error", message: "session.list returned a malformed page." });
	});

	test("rejects repeated broker session.list cursors without returning partial rows", async () => {
		let calls = 0;
		const broker = {
			global: async () => {
				calls++;
				return { ok: true, result: { sessions: [{ sessionId: `page-${calls}` }], continuationCursor: "repeat" } };
			},
		} as never;

		await expect(listBrokerSessions(broker)).rejects.toMatchObject({
			code: "protocol_error",
			message: "session.list returned a repeated continuation cursor.",
		});
		expect(calls).toBe(2);
	});

	test("preserves an explicit continuation error from the broker", async () => {
		let calls = 0;
		const broker = {
			global: async () => {
				calls++;
				return calls === 1
					? { ok: true, result: { sessions: [{ sessionId: "page-one" }], continuationCursor: "page-two" } }
					: { ok: false, error: { code: "continuation_failed", message: "page two failed" } };
			},
		} as never;

		await expect(listBrokerSessions(broker)).rejects.toMatchObject({
			name: "SdkClientError",
			code: "continuation_failed",
			message: "page two failed",
			details: { code: "continuation_failed", message: "page two failed" },
		});
		expect(calls).toBe(2);
	});
});

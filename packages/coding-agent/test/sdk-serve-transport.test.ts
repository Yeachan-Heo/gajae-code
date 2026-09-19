import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { getAgentDir, resetAgentDirFromEnvironment, setAgentDir } from "@gajae-code/utils";
import { CliParseError } from "@gajae-code/utils/cli";
import type { ServerWebSocket } from "bun";
import { dispatchPublicCommand } from "../src/cli/public-command-entry";
import {
	PUBLIC_COMMAND_DIAGNOSTICS,
	PublicCommandFailure,
	renderPublicCommandFailure,
} from "../src/cli/public-command-errors";
import { renderPublicCommandHelp } from "../src/cli/public-command-help";
import Sdk, { parseSdkInternalArgv, watchSessionHostClientAttachment } from "../src/commands/sdk.js";
import { brokerProcessIncarnation, writeBrokerDiscovery } from "../src/sdk/broker/discovery.js";
import { reapDeadSessionRegistrations } from "../src/sdk/broker/lifecycle.js";
import { SessionIndex } from "../src/sdk/broker/session-index.js";
import { SDK_STATE_VERSION } from "../src/sdk/broker/state-version.js";
import { SdkClient, SdkClientError } from "../src/sdk/client/client.js";
import { listSdkSessionEndpoints } from "../src/sdk/client/discovery.js";
import { classifyEndpoint, selectLiveEndpoint } from "../src/sdk/client/liveness.js";
import {
	DEFAULT_UPSTREAM_HELLO_TIMEOUT_MS,
	type RelayWebSocket,
	startRelayPair,
	type TransportError,
} from "../src/sdk/transport/relay.js";
import {
	listBrokerSessions,
	ownSdkServeTransport,
	resolveServePendingCeiling,
	resolveServeSession,
	runSdkServe,
	type SdkServeDependencies,
	SdkServeError,
	selectBrokerSession,
} from "../src/sdk/transport/serve-cli.js";
import { startSocketServe } from "../src/sdk/transport/socket.js";
import { startStdioServe } from "../src/sdk/transport/stdio.js";

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
				ws.send(JSON.stringify({ type: "hello", connectionId: "fixture" }));
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

/**
 * Reports how a serve failure surfaced without rethrowing it, so a regression shows
 * up as an assertion diff on the machine-readable code rather than a raw throw.
 */
function serveFailure(run: () => unknown): { typed: boolean; code: unknown; exitCode: unknown } {
	try {
		run();
	} catch (error) {
		const typed = error as { code?: unknown; exitCode?: unknown };
		return { typed: error instanceof SdkServeError, code: typed.code, exitCode: typed.exitCode };
	}
	throw new Error("Expected the serve path to fail.");
}

/** The awaited counterpart of `serveFailure`, for serve paths that reject. */
async function serveRejectionFailure(
	run: () => Promise<unknown>,
): Promise<{ typed: boolean; code: unknown; exitCode: unknown }> {
	try {
		await run();
	} catch (error) {
		const typed = error as { code?: unknown; exitCode?: unknown };
		return { typed: error instanceof SdkServeError, code: typed.code, exitCode: typed.exitCode };
	}
	throw new Error("Expected the serve path to reject.");
}

/** A fake SDK broker: a hello on open, then one canned reply per broker request. */
function fakeBroker(reply: (operation: string) => Record<string, unknown>) {
	const server = Bun.serve<unknown>({
		port: 0,
		fetch(req, server) {
			if (server.upgrade(req, { data: {} })) return;
			return new Response("upgrade required", { status: 426 });
		},
		websocket: {
			open(ws) {
				ws.send(JSON.stringify({ type: "broker_hello", connectionId: "fake-broker" }));
			},
			message(ws, message) {
				const frame = JSON.parse(String(message)) as { id?: unknown; operation?: unknown };
				if (typeof frame.id !== "string") return;
				const operation = typeof frame.operation === "string" ? frame.operation : "";
				ws.send(JSON.stringify({ type: "broker_response", id: frame.id, ...reply(operation) }));
			},
		},
	});
	return { url: `ws://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/**
 * Points `getAgentDir()` at a private temp agent dir — never the shared one — and
 * optionally publishes a discovery record for `url` so serve reaches the broker.
 */
async function withServeAgentDir<T>(url: string | undefined, run: () => Promise<T>): Promise<T> {
	const agentDir = path.join(await tempDir(), "agent");
	if (url !== undefined) {
		const incarnation = brokerProcessIncarnation(process.pid);
		if (!incarnation) throw new Error("Broker process incarnation is unavailable for this test process.");
		await writeBrokerDiscovery(agentDir, {
			version: 1,
			protocolVersion: 3,
			packageGeneration: "serve-cli-test",
			ownerId: "serve-cli-test",
			pid: process.pid,
			incarnation,
			host: "127.0.0.1",
			port: Number(new URL(url).port),
			url,
			token,
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		});
	}
	const previous = getAgentDir();
	setAgentDir(agentDir);
	try {
		return await run();
	} finally {
		setAgentDir(previous);
	}
}

/** Captures the failure `runSdkServe` rejects with, so assertions read its typed fields. */
async function serveRejection(argv: string[]): Promise<unknown> {
	try {
		await runSdkServe(argv);
	} catch (error) {
		return error;
	}
	throw new Error("Expected serve to fail.");
}

/**
 * Drives the `gjc sdk serve` command boundary against `brokerUrl` and returns the
 * single envelope it wrote to stderr, with stdout captured alongside so a leak into
 * the frame channel is visible.
 */
async function serveEnvelope(brokerUrl: string): Promise<{ stdout: string; error: Record<string, unknown> }> {
	const stdoutChunks: string[] = [];
	const stderrChunks: string[] = [];
	const realStdout = process.stdout.write;
	const realStderr = process.stderr.write;
	const previousExitCode = process.exitCode;
	(process.stdout as unknown as { write(value: string): boolean }).write = value => {
		stdoutChunks.push(String(value));
		return true;
	};
	(process.stderr as unknown as { write(value: string): boolean }).write = value => {
		stderrChunks.push(String(value));
		return true;
	};
	try {
		await withServeAgentDir(brokerUrl, async () => {
			await new Sdk(["serve", "--stdio"], {} as never).run();
		});
	} finally {
		(process.stdout as unknown as { write: typeof realStdout }).write = realStdout;
		(process.stderr as unknown as { write: typeof realStderr }).write = realStderr;
		// Restore to a real number: assigning `undefined` is a no-op in Bun, so it
		// would leave the boundary's exit code 1 on the whole test runner process.
		process.exitCode = previousExitCode ?? 0;
	}
	const lines = stderrChunks.join("").split("\n").filter(Boolean);
	if (lines.length !== 1) throw new Error(`Expected one stderr envelope, got ${lines.length}.`);
	const parsed = JSON.parse(lines[0]!) as { error: Record<string, unknown> };
	return { stdout: stdoutChunks.join(""), error: parsed.error };
}

const closeFailureMessage = "SDK WebSocket close timed out after 250ms";

/**
 * Runs `run()` with `SdkClient.connect` handing back a client whose `close()` rejects
 * once the real teardown finishes — the broker-cleanup failure a `finally` would let
 * replace whatever the serve path already decided.
 */
async function withRejectingBrokerClose<T>(run: () => Promise<T>): Promise<T> {
	const realConnect = SdkClient.connect;
	SdkClient.connect = async (url: string, token: string) => {
		const client = await realConnect.call(SdkClient, url, token);
		const realClose = client.close.bind(client);
		client.close = async () => {
			await realClose();
			throw new SdkClientError("timeout", closeFailureMessage);
		};
		return client;
	};
	try {
		return await run();
	} finally {
		SdkClient.connect = realConnect;
	}
}

/**
 * Ends a running serve the way Ctrl-C does — through the SIGINT handler it registers —
 * without raising a real signal the test runner also listens for.
 */
async function stopServeViaSignalHandler(before: readonly unknown[]): Promise<void> {
	const stop = await waitFor(
		() => process.listeners("SIGINT").find(listener => !before.includes(listener)),
		"the serve SIGINT handler",
	);
	stop("SIGINT");
}

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

	message(data: string): void {
		this.#emit("message", { data });
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
			await waitFor(() => received[0], "upstream hello");
			received.length = 0;
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
	test("stdio transport relays a capability-gated mid-turn frame", async () => {
		const connections: { ws: ServerWebSocket<unknown>; messages: string[] }[] = [];
		const server = Bun.serve<unknown>({
			port: 0,
			fetch(_request, instance) {
				if (instance.upgrade(_request, { data: {} })) return;
				return new Response("upgrade required", { status: 426 });
			},
			websocket: {
				open(ws) {
					connections.push({ ws, messages: [] });
					ws.send(
						JSON.stringify({
							type: "hello",
							protocolVersion: 3,
							capabilities: ["tool_activity_v2", "turn_stream"],
						}),
					);
				},
				message(ws, message) {
					const connection = connections.find(candidate => candidate.ws === ws);
					if (!connection) return;
					const text = String(message);
					connection.messages.push(text);
					const frame = JSON.parse(text) as { type?: unknown; capabilities?: unknown };
					if (
						frame.type === "hello" &&
						Array.isArray(frame.capabilities) &&
						frame.capabilities.includes("tool_activity_v2")
					)
						ws.send(
							JSON.stringify({
								type: "tool_activity",
								sessionId: "session",
								toolCallId: "call-stdio",
								toolName: "read",
								phase: "started",
							}),
						);
				},
			},
		});
		const input = new PassThrough();
		const output = new PassThrough();
		const received: Buffer[] = [];
		output.on("data", chunk => received.push(Buffer.from(chunk)));
		const handle = await startStdioServe(
			{ url: `ws://127.0.0.1:${server.port}`, token, pendingCeilingBytes: 256 * 1024 },
			{ input, output },
		);
		try {
			const connection = await waitFor(() => connections[0], "stdio upstream connection");
			input.write(
				`${JSON.stringify({ type: "hello", protocolVersion: 3, capabilities: ["tool_activity_v2", "turn_stream"] })}\n`,
			);
			const hello = await waitFor(() => connection.messages[0], "stdio downstream capability hello");
			expect(JSON.parse(hello)).toEqual({
				type: "hello",
				protocolVersion: 3,
				capabilities: ["tool_activity_v2", "turn_stream"],
			});
			const activity = await waitFor(
				() =>
					received
						.map(chunk => chunk.toString("utf8").trim())
						.map(line => {
							try {
								return JSON.parse(line) as { type?: unknown };
							} catch {
								return undefined;
							}
						})
						.find(frame => frame?.type === "tool_activity"),
				"stdio tool_activity frame",
			);
			expect(activity).toMatchObject({ type: "tool_activity", toolCallId: "call-stdio", phase: "started" });
		} finally {
			await handle.close();
			server.stop(true);
		}
	});

	test("buffers downstream hello until the upstream hello and preserves its capabilities", async () => {
		const connections: { ws: ServerWebSocket<unknown>; messages: string[] }[] = [];
		const server = Bun.serve<unknown>({
			port: 0,
			fetch(_request, instance) {
				if (instance.upgrade(_request, { data: {} })) return;
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
		const input = new PassThrough();
		const output = new PassThrough();
		const received: Buffer[] = [];
		output.on("data", chunk => received.push(Buffer.from(chunk)));
		const pair = await startRelayPair({
			url: `ws://127.0.0.1:${server.port}`,
			token,
			pendingCeilingBytes: 256 * 1024,
			downstream: input,
			downstreamSink: output,
			onTransportError: () => {},
		});
		try {
			const connection = await waitFor(() => connections[0], "upstream connection");
			const emptyHello = JSON.stringify({ type: "hello", protocolVersion: 3, capabilities: [] });
			const futureHello = JSON.stringify({
				type: "hello",
				protocolVersion: 3,
				capabilities: ["unrelated_future_capability"],
			});
			input.write(`${emptyHello}\n${futureHello}\n`);
			await Bun.sleep(20);
			expect(connection.messages).toEqual([]);
			connection.ws.send(JSON.stringify({ type: "hello", connectionId: "session" }));
			expect(await waitFor(() => connection.messages[0], "buffered downstream hello")).toBe(emptyHello);
			expect(await waitFor(() => connection.messages[1], "buffered future hello")).toBe(futureHello);
			expect(received.map(chunk => chunk.toString().trim())).toContain(
				JSON.stringify({ type: "hello", connectionId: "session" }),
			);
		} finally {
			await pair.close();
			server.stop(true);
		}
	});

	test("bounds the upstream hello wait and closes a silent upstream", async () => {
		vi.useFakeTimers();
		const connections: { ws: ServerWebSocket<unknown>; messages: string[] }[] = [];
		const server = Bun.serve<unknown>({
			port: 0,
			fetch(_request, instance) {
				if (instance.upgrade(_request, { data: {} })) return;
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
		const input = new PassThrough();
		const output = new PassThrough();
		const errors: TransportError[] = [];
		const pair = await startRelayPair({
			url: `ws://127.0.0.1:${server.port}`,
			token,
			pendingCeilingBytes: 256 * 1024,
			downstream: input,
			downstreamSink: output,
			onTransportError: error => errors.push(error),
		});
		try {
			await waitFor(() => connections[0], "silent upstream connection");
			input.write('{"queued":true}\n');
			vi.advanceTimersByTime(DEFAULT_UPSTREAM_HELLO_TIMEOUT_MS);
			expect(errors[0]).toMatchObject({
				code: "protocol_error",
				direction: "ws->downstream",
			});
			await expect(pair.done).rejects.toThrow("protocol_error");
			expect(connections[0]?.messages).toEqual([]);
		} finally {
			await pair.close();
			server.stop(true);
			vi.useRealTimers();
		}
	});

	test("rejects startup when the upstream closes before opening", async () => {
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
		ws.close();
		const result = await Promise.race([
			started.then(
				() => "resolved",
				error => (error instanceof Error ? error.message : String(error)),
			),
			Bun.sleep(100).then(() => "timeout"),
		]);
		expect(result).toBe("upstream_closed");
		expect(errors).toEqual([]);
		input.destroy();
		output.destroy();
	});

	test("relays only an explicitly opted-in capability", async () => {
		const connections: { ws: ServerWebSocket<unknown>; messages: string[] }[] = [];
		const server = Bun.serve<unknown>({
			port: 0,
			fetch(_request, instance) {
				if (instance.upgrade(_request, { data: {} })) return;
				return new Response("upgrade required", { status: 426 });
			},
			websocket: {
				open(ws) {
					connections.push({ ws, messages: [] });
					ws.send(
						JSON.stringify({
							type: "hello",
							protocolVersion: 3,
							capabilities: ["tool_activity_v2", "turn_stream"],
						}),
					);
				},
				message(ws, message) {
					const connection = connections.find(candidate => candidate.ws === ws);
					if (!connection) return;
					const text = String(message);
					connection.messages.push(text);
					const frame = JSON.parse(text) as { type?: unknown; capabilities?: unknown };
					if (
						frame.type === "hello" &&
						Array.isArray(frame.capabilities) &&
						frame.capabilities.includes("tool_activity_v2")
					)
						ws.send(JSON.stringify({ type: "tool_activity", toolCallId: "call-opt-in", phase: "started" }));
				},
			},
		});
		const input = new PassThrough();
		const output = new PassThrough();
		const received: Buffer[] = [];
		output.on("data", chunk => received.push(Buffer.from(chunk)));
		const pair = await startRelayPair({
			url: `ws://127.0.0.1:${server.port}`,
			token,
			pendingCeilingBytes: 256 * 1024,
			downstream: input,
			downstreamSink: output,
			onTransportError: () => {},
		});
		try {
			const connection = await waitFor(() => connections[0], "upstream connection");
			await waitFor(() => received[0], "upstream hello");
			expect(connection.messages).toEqual([]);
			input.write(`${JSON.stringify({ type: "hello", protocolVersion: 3, capabilities: [] })}\n`);
			await Bun.sleep(20);
			expect(
				received
					.map(chunk => chunk.toString("utf8").trim())
					.some(line => {
						try {
							return (JSON.parse(line) as { type?: unknown }).type === "tool_activity";
						} catch {
							return false;
						}
					}),
			).toBe(false);
		} finally {
			await pair.close();
			server.stop(true);
		}
	});

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
			await Bun.sleep(20);
			blocked.emit("drain");
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
			ws.message(JSON.stringify({ type: "hello", connectionId: "stalled" }));
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
			ws.message(JSON.stringify({ type: "hello", connectionId: "stalled" }));
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

	test("matches stdio capability negotiation on the Unix-socket relay", async () => {
		const fake = upstream();
		const dir = await tempDir();
		const socketPath = path.join(dir, "serve.sock");
		const handle = await startSocketServe({ url: fake.url, token, pendingCeilingBytes: 256 * 1024, socketPath });
		const client = await socketConnect(socketPath);
		try {
			client.write(`gjc-sdk-transport/1 token=${token}\n`);
			const connection = await waitFor(() => fake.connections[0], "socket upstream connection");
			const downstreamHello = JSON.stringify({
				type: "hello",
				protocolVersion: 3,
				capabilities: ["tool_activity_v2", "turn_stream"],
			});
			client.write(`${downstreamHello}\n`);
			connection.ws.send(JSON.stringify({ type: "hello", connectionId: "session" }));
			await readLine(client);
			expect(await waitFor(() => connection.messages[0], "socket downstream capability hello")).toBe(
				downstreamHello,
			);
		} finally {
			await closeSocket(client);
			await handle.close();
			fake.stop();
		}
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
				ws.message(JSON.stringify({ type: "hello", connectionId: "stalled" }));
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
		expect(serveFailure(() => selectBrokerSession(rows, "sess-1"))).toEqual({
			typed: true,
			code: "endpoint_stale",
			exitCode: 1,
		});
	});

	test("reattaches one indexed-but-dead explicit session before serving", async () => {
		const sessionId = "dead-session";
		const cwd = "/workspace";
		const stateRoot = `${cwd}/.gjc/state`;
		const identity = {
			dev: "1",
			ino: "2",
			size: 3,
			mtimeMs: 4,
			mtimeNs: "5",
			sha256: "a".repeat(64),
		};
		const locator = { cwd, worktreeRoot: null, stateRoot };
		const calls: {
			operation: string;
			input: Record<string, unknown>;
			options?: { idempotencyKey?: string; timeoutMs?: number };
		}[] = [];
		let resumed = false;
		const broker = {
			global: async (operation: string, input: Record<string, unknown>, options?: { idempotencyKey?: string }) => {
				calls.push({ operation, input, options });
				if (operation === "session.list") {
					if (input.cwd === cwd)
						return {
							ok: true,
							result: {
								sessions: [
									{
										sessionId,
										live: false,
										ambiguous: false,
										terminal: true,
										hostUnregisteredReason: "detached_idle",
										locator,
									},
								],
								savedSession: { id: sessionId, path: `${cwd}/session.jsonl`, identity },
							},
						};
					return {
						ok: true,
						result: {
							sessions: [
								{
									sessionId,
									live: resumed,
									ambiguous: false,
									...(resumed ? {} : { terminal: true, hostUnregisteredReason: "detached_idle" }),
									locator,
								},
							],
							warnings: [],
						},
					};
				}
				if (operation === "session.resume") {
					resumed = true;
					return { ok: true, result: { sessionId } };
				}
				return { ok: false, error: { code: "unexpected_operation", message: operation } };
			},
		} as never;

		expect(await resolveServeSession(broker, sessionId)).toBe(sessionId);
		expect(calls.map(call => call.operation)).toEqual([
			"session.list",
			"session.list",
			"session.resume",
			"session.list",
		]);
		expect(calls[1]?.input).toEqual({ resolveSessionId: sessionId, cwd });
		expect(calls[2]?.input).toEqual({
			sessionId,
			cwd,
			stateRoot,
			sessionPath: `${cwd}/session.jsonl`,
			sessionIdentity: identity,
		});
		expect(calls[2]?.options?.idempotencyKey).toEqual(expect.any(String));
		expect(calls[2]?.options?.idempotencyKey?.length).toBeLessThanOrEqual(128);
		expect(calls[2]?.options?.timeoutMs).toBe(21_000);
		expect(calls.filter(call => call.operation === "session.resume")).toHaveLength(1);
	});

	test("recovers a session registration retired by the broker dead-process reaper", async () => {
		const agentDir = await tempDir();
		const index = await new SessionIndex(agentDir).open();
		const sessionId = "reaped-session";
		const deadPid = 4_194_304;
		const locator = { cwd: agentDir, worktreeRoot: null, stateRoot: path.join(agentDir, ".gjc", "state") };
		const identity = {
			dev: "1",
			ino: "2",
			size: 3,
			mtimeMs: 4,
			mtimeNs: "5",
			sha256: "e".repeat(64),
		};
		await index.append({ sessionId, locator, endpointGeneration: 1, pid: deadPid, type: "host_registered" });
		expect(await reapDeadSessionRegistrations({ index })).toEqual([
			{ sessionId, pid: deadPid, endpointGeneration: 1 },
		]);
		const reaped = index.listSessions().sessions.find(row => row.sessionId === sessionId);
		if (!reaped) throw new Error("reaped session row was not retained");

		let resumed = false;
		const calls: string[] = [];
		const broker = {
			global: async (operation: string) => {
				calls.push(operation);
				if (operation === "session.resume") {
					resumed = true;
					return { ok: true, result: { sessionId } };
				}
				if (operation === "session.list")
					return {
						ok: true,
						result: {
							sessions: [{ ...reaped, live: resumed }],
							savedSession: { id: sessionId, path: path.join(agentDir, "session.jsonl"), identity },
						},
					};
				return { ok: false, error: { code: "unexpected_operation", message: operation } };
			},
		} as never;

		expect(await resolveServeSession(broker, sessionId)).toBe(sessionId);
		expect(calls).toEqual(["session.list", "session.resume", "session.list"]);
	});

	test("drives detached-idle self-reap into broker recovery", async () => {
		const agentDir = await tempDir();
		const index = await new SessionIndex(agentDir).open();
		const sessionId = "detached-idle-session";
		const locator = { cwd: agentDir, worktreeRoot: null, stateRoot: path.join(agentDir, ".gjc", "state") };
		const identity = {
			dev: "1",
			ino: "2",
			size: 3,
			mtimeMs: 4,
			mtimeNs: "5",
			sha256: "a".repeat(64),
		};
		const registered = await index.append({
			sessionId,
			locator,
			endpointGeneration: 1,
			pid: process.pid,
			type: "host_registered",
		});
		let nowMs = 0;
		let reads = 0;
		const reapReason = await watchSessionHostClientAttachment({
			readAttachedClients: () => {
				reads += 1;
				return reads === 1 ? 1 : 0;
			},
			now: () => nowMs,
			sleep: async ms => {
				nowMs += ms;
			},
			idleGraceMs: 20,
			firstAttachGraceMs: 40,
			pollMs: 10,
		});
		expect(reapReason).toBe("detached_idle");
		expect(await index.unregisterIfCurrent(registered, reapReason)).toBe(true);
		const reaped = index.listSessions().sessions.find(row => row.sessionId === sessionId);
		if (!reaped) throw new Error("detached-idle row was not retained");
		expect(reaped.terminal).toBe(true);
		expect(reaped.hostUnregisteredReason).toBe("detached_idle");

		let resumed = false;
		const calls: string[] = [];
		const broker = {
			global: async (operation: string) => {
				calls.push(operation);
				if (operation === "session.resume") {
					resumed = true;
					return { ok: true, result: { sessionId } };
				}
				if (operation === "session.list")
					return {
						ok: true,
						result: {
							sessions: [{ ...reaped, live: resumed, ...(resumed ? { terminal: false } : {}) }],
							savedSession: { id: sessionId, path: path.join(agentDir, "session.jsonl"), identity },
						},
					};
				return { ok: false, error: { code: "unexpected_operation", message: operation } };
			},
		} as never;

		expect(await resolveServeSession(broker, sessionId)).toBe(sessionId);
		expect(calls).toEqual(["session.list", "session.resume", "session.list"]);
	});

	test("normalizes a symlinked state root through broker lifecycle input rules", async () => {
		const agentDir = await tempDir();
		const cwd = path.join(agentDir, "workspace");
		const symlinkedCwd = path.join(agentDir, "workspace-link");
		await fs.mkdir(path.join(cwd, ".gjc", "state"), { recursive: true });
		await fs.symlink(cwd, symlinkedCwd, "dir");
		const sessionId = "symlinked-state-root";
		const locator = {
			cwd,
			worktreeRoot: null,
			stateRoot: path.join(symlinkedCwd, ".gjc", "state"),
		};
		const identity = {
			dev: "1",
			ino: "2",
			size: 3,
			mtimeMs: 4,
			mtimeNs: "5",
			sha256: "f".repeat(64),
		};
		let resumed = false;
		let resumeInput: Record<string, unknown> | undefined;
		const broker = {
			global: async (operation: string, input: Record<string, unknown>) => {
				if (operation === "session.resume") {
					resumeInput = input;
					resumed = true;
					return { ok: true, result: { sessionId } };
				}
				if (operation === "session.list")
					return {
						ok: true,
						result: {
							sessions: [
								{
									sessionId,
									live: resumed,
									ambiguous: false,
									...(resumed ? {} : { terminal: true, hostUnregisteredReason: "detached_idle" }),
									locator,
								},
							],
							savedSession: { id: sessionId, path: path.join(cwd, "session.jsonl"), identity },
						},
					};
				return { ok: false, error: { code: "unexpected_operation", message: operation } };
			},
		} as never;

		expect(await resolveServeSession(broker, sessionId)).toBe(sessionId);
		expect(resumeInput).toMatchObject({
			sessionId,
			cwd,
			stateRoot: path.join(cwd, ".gjc", "state"),
		});
	});

	test("wires recovery through session.get_endpoint and relay startup", async () => {
		const agentDir = await tempDir();
		const socketPath = path.join(agentDir, "serve.sock");
		const sessionId = "dead-session";
		const cwd = "/workspace";
		const stateRoot = `${cwd}/.gjc/state`;
		const identity = {
			dev: "1",
			ino: "2",
			size: 3,
			mtimeMs: 4,
			mtimeNs: "5",
			sha256: "a".repeat(64),
		};
		const locator = { cwd, worktreeRoot: null, stateRoot };
		const endpoint = upstream();
		const brokerToken = "broker-token";
		const brokerRequests: Record<string, unknown>[] = [];
		let resumed = false;
		const incarnation = brokerProcessIncarnation(process.pid);
		if (!incarnation) throw new Error("test broker process incarnation unavailable");
		const brokerServer = Bun.serve<unknown>({
			port: 0,
			fetch(req, server) {
				if (new URL(req.url).searchParams.get("token") !== brokerToken)
					return new Response("unauthorized", { status: 401 });
				if (server.upgrade(req, { data: {} })) return;
				return new Response("upgrade required", { status: 426 });
			},
			websocket: {
				open(ws) {
					ws.send(JSON.stringify({ type: "broker_hello", protocolVersion: 3 }));
				},
				message(ws, message) {
					const frame = JSON.parse(String(message)) as Record<string, unknown>;
					brokerRequests.push(frame);
					const id = typeof frame.id === "string" ? frame.id : "";
					const respond = (body: Record<string, unknown>) =>
						ws.send(JSON.stringify({ type: "broker_response", id, ...body }));
					if (frame.operation === "session.list") {
						respond({
							ok: true,
							result: {
								indexSeq: 1,
								sessions: [
									{
										sessionId,
										live: resumed,
										ambiguous: false,
										...(resumed ? {} : { terminal: true, hostUnregisteredReason: "detached_idle" }),
										locator,
									},
								],
								...(resumed ? {} : { savedSession: { id: sessionId, path: `${cwd}/session.jsonl`, identity } }),
								warnings: [],
							},
						});
						return;
					}
					if (frame.operation === "session.resume") {
						if (typeof frame.idempotencyKey !== "string" || frame.idempotencyKey.length === 0) {
							respond({
								ok: false,
								error: {
									code: "invalid_input",
									message: "idempotencyKey is required for lifecycle operations",
								},
							});
							return;
						}
						resumed = true;
						respond({ ok: true, result: { sessionId } });
						return;
					}
					if (frame.operation === "session.get_endpoint") {
						respond({ ok: true, result: { url: endpoint.url, token } });
						return;
					}
					respond({ ok: false, error: { code: "unexpected_operation", message: String(frame.operation) } });
				},
			},
		});
		const now = Date.now();
		await fs.mkdir(path.join(agentDir, "sdk"), { recursive: true });
		await fs.writeFile(
			path.join(agentDir, "sdk", "broker.json"),
			JSON.stringify({
				version: 1,
				protocolVersion: 3,
				packageGeneration: "test",
				ownerId: "serve-test",
				pid: process.pid,
				incarnation,
				host: "127.0.0.1",
				port: brokerServer.port,
				url: `ws://127.0.0.1:${brokerServer.port}`,
				token: brokerToken,
				startedAt: now,
				heartbeatAt: now,
			}),
		);

		const previousAgentDir = process.env.GJC_CODING_AGENT_DIR;
		const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
		setAgentDir(agentDir);
		const originalProcessOnce = process.once;
		const invokeOriginalProcessOnce = originalProcessOnce.bind(process) as (
			event: Parameters<NodeJS.EventEmitter["once"]>[0],
			listener: Parameters<NodeJS.EventEmitter["once"]>[1],
		) => typeof process;
		let stop: (() => void) | undefined;
		const interceptedProcessOnce: typeof process.once = (
			event: Parameters<NodeJS.EventEmitter["once"]>[0],
			listener: Parameters<NodeJS.EventEmitter["once"]>[1],
		) => {
			if (event === "SIGTERM") {
				stop = listener as () => void;
				return process;
			}
			return invokeOriginalProcessOnce(event, listener);
		};
		process.once = interceptedProcessOnce;
		let serving: Promise<void> | undefined;
		let client: net.Socket | undefined;
		try {
			serving = runSdkServe(["--socket", socketPath, "--session", sessionId]);
			for (let attempt = 0; attempt < 600 && client === undefined; attempt++) {
				try {
					client = await socketConnect(socketPath);
				} catch {
					await Bun.sleep(5);
				}
			}
			if (!client) throw new Error("Timed out waiting for sdk serve socket");
			const frame = '{"type":"probe","value":1}';
			client.write(`gjc-sdk-transport/1 token=${token}\n${frame}\n`);
			expect(await waitFor(() => endpoint.connections[0]?.messages[0], "relay startup")).toBe(frame);
			await closeSocket(client);
			stop = await waitFor(() => stop, "serve shutdown callback");
			stop();
			await serving;

			expect(brokerRequests.map(request => request.operation)).toEqual([
				"session.list",
				"session.resume",
				"session.list",
				"session.get_endpoint",
			]);
			const recoveryRequest = brokerRequests.find(request => request.operation === "session.resume");
			expect(recoveryRequest?.idempotencyKey).toEqual(expect.any(String));
			expect((recoveryRequest?.idempotencyKey as string).length).toBeLessThanOrEqual(128);
		} finally {
			stop?.();
			if (client) client.destroy();
			await serving?.catch(() => undefined);
			process.once = originalProcessOnce;
			brokerServer.stop(true);
			endpoint.stop();
			if (previousAgentDir === undefined) delete process.env.GJC_CODING_AGENT_DIR;
			else process.env.GJC_CODING_AGENT_DIR = previousAgentDir;
			if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
			resetAgentDirFromEnvironment();
		}
	});

	test("does not retry a recovery when the resumed session remains dead", async () => {
		const sessionId = "still-dead";
		const locator = { cwd: "/workspace", worktreeRoot: null, stateRoot: "/workspace/.gjc/state" };
		const calls: string[] = [];
		const broker = {
			global: async (operation: string, input: Record<string, unknown>) => {
				calls.push(operation);
				if (operation === "session.list" && input.cwd !== undefined)
					return {
						ok: true,
						result: {
							sessions: [
								{
									sessionId,
									live: false,
									ambiguous: false,
									terminal: true,
									hostUnregisteredReason: "detached_idle",
									locator,
								},
							],
							savedSession: {
								id: sessionId,
								path: "/workspace/session.jsonl",
								identity: {
									dev: "1",
									ino: "2",
									size: 3,
									mtimeMs: 4,
									mtimeNs: "5",
									sha256: "b".repeat(64),
								},
							},
						},
					};
				if (operation === "session.resume") return { ok: true, result: { sessionId } };
				if (operation === "session.list")
					return {
						ok: true,
						result: {
							sessions: [
								{
									sessionId,
									live: false,
									ambiguous: false,
									terminal: true,
									hostUnregisteredReason: "detached_idle",
									locator,
								},
							],
						},
					};
				return { ok: false, error: { code: "unexpected_operation", message: operation } };
			},
		} as never;

		expect(await serveRejectionFailure(() => resolveServeSession(broker, sessionId))).toEqual({
			typed: true,
			code: "endpoint_stale",
			exitCode: 1,
		});
		expect(calls).toEqual(["session.list", "session.list", "session.resume", "session.list"]);
		expect(calls.filter(operation => operation === "session.resume")).toHaveLength(1);
	});

	test("does not recover an indexed terminal-uncertain explicit session", async () => {
		const sessionId = "uncertain-session";
		const locator = { cwd: "/workspace", worktreeRoot: null, stateRoot: "/workspace/.gjc/state" };
		const identity = {
			dev: "1",
			ino: "2",
			size: 3,
			mtimeMs: 4,
			mtimeNs: "5",
			sha256: "d".repeat(64),
		};
		const calls: string[] = [];
		const broker = {
			global: async (operation: string) => {
				calls.push(operation);
				if (operation === "session.list")
					return {
						ok: true,
						result: {
							sessions: [{ sessionId, live: false, ambiguous: false, terminal_uncertain: true, locator }],
							savedSession: { id: sessionId, path: "/workspace/session.jsonl", identity },
						},
					};
				return { ok: false, error: { code: "unexpected_operation", message: operation } };
			},
		} as never;

		expect(await serveRejectionFailure(() => resolveServeSession(broker, sessionId))).toEqual({
			typed: true,
			code: "terminal_uncertain",
			exitCode: 1,
		});
		expect(calls).toEqual(["session.list"]);
	});

	test("does not recover a nonterminal stale row without retirement proof", async () => {
		const sessionId = "heartbeat-stale-session";
		const locator = { cwd: "/workspace", worktreeRoot: null, stateRoot: "/workspace/.gjc/state" };
		const calls: string[] = [];
		const broker = {
			global: async (operation: string) => {
				calls.push(operation);
				if (operation === "session.list")
					return {
						ok: true,
						result: {
							sessions: [{ sessionId, live: false, ambiguous: false, terminal: false, locator }],
							savedSession: {
								id: sessionId,
								path: "/workspace/session.jsonl",
								identity: { dev: "1", ino: "2", size: 3, mtimeMs: 4, mtimeNs: "5", sha256: "e".repeat(64) },
							},
						},
					};
				return { ok: false, error: { code: "unexpected_operation", message: operation } };
			},
		} as never;

		expect(await serveRejectionFailure(() => resolveServeSession(broker, sessionId))).toEqual({
			typed: true,
			code: "endpoint_stale",
			exitCode: 1,
		});
		expect(calls).toEqual(["session.list"]);
	});

	test("does not resume an indexed terminal session", async () => {
		const sessionId = "terminal-session";
		const locator = { cwd: "/workspace", worktreeRoot: null, stateRoot: "/workspace/.gjc/state" };
		const calls: string[] = [];
		const broker = {
			global: async (operation: string) => {
				calls.push(operation);
				if (operation === "session.list")
					return {
						ok: true,
						result: {
							sessions: [{ sessionId, live: false, ambiguous: false, terminal: true, locator }],
							// Recovery authority is present, so the only thing keeping this row from
							// being resumed is that it has already reached a terminal state.
							savedSession: {
								id: sessionId,
								path: "/workspace/session.jsonl",
								identity: { dev: "1", ino: "2", size: 3, mtimeMs: 4, mtimeNs: "5", sha256: "d".repeat(64) },
							},
						},
					};
				return { ok: false, error: { code: "unexpected_operation", message: operation } };
			},
		} as never;

		expect(await serveRejectionFailure(() => resolveServeSession(broker, sessionId))).toEqual({
			typed: true,
			code: "endpoint_stale",
			exitCode: 1,
		});
		expect(calls.filter(operation => operation === "session.resume")).toHaveLength(0);
		expect(calls).toEqual(["session.list"]);
	});

	test("reports a post-recovery stale endpoint as endpoint_stale rather than serve_failed", async () => {
		const sessionId = "stale-after-recovery";
		const calls: string[] = [];
		const broker = {
			global: async (operation: string) => {
				calls.push(operation);
				// A row with no locator cannot carry recovery authority, so the recovery path
				// raises the stale-endpoint error itself. That error has to stay typed: an
				// untyped throw here is rewritten to `serve_failed` and the caller loses the
				// one code that says recovery ran and the endpoint is still not live.
				if (operation === "session.list")
					return { ok: true, result: { sessions: [{ sessionId, live: false, ambiguous: false }] } };
				return { ok: false, error: { code: "unexpected_operation", message: operation } };
			},
		} as never;

		expect(await serveRejectionFailure(() => resolveServeSession(broker, sessionId))).toEqual({
			typed: true,
			code: "endpoint_stale",
			exitCode: 1,
		});
		expect(calls.filter(operation => operation === "session.resume")).toHaveLength(0);
	});

	test("surfaces a recovery failure without retrying or selecting an endpoint", async () => {
		const sessionId = "resume-fails";
		const locator = { cwd: "/workspace", worktreeRoot: null, stateRoot: "/workspace/.gjc/state" };
		const calls: string[] = [];
		const broker = {
			global: async (operation: string, input: Record<string, unknown>) => {
				calls.push(operation);
				if (operation === "session.list" && input.cwd !== undefined)
					return {
						ok: true,
						result: {
							sessions: [
								{
									sessionId,
									live: false,
									ambiguous: false,
									terminal: true,
									hostUnregisteredReason: "detached_idle",
									locator,
								},
							],
							savedSession: {
								id: sessionId,
								path: "/workspace/session.jsonl",
								identity: {
									dev: "1",
									ino: "2",
									size: 3,
									mtimeMs: 4,
									mtimeNs: "5",
									sha256: "c".repeat(64),
								},
							},
						},
					};
				if (operation === "session.resume")
					return { ok: false, error: { code: "resume_failed", message: "resume failed" } };
				return {
					ok: true,
					result: {
						sessions: [
							{
								sessionId,
								live: false,
								ambiguous: false,
								terminal: true,
								hostUnregisteredReason: "detached_idle",
								locator,
							},
						],
					},
				};
			},
		} as never;

		await expect(resolveServeSession(broker, sessionId)).rejects.toMatchObject({
			name: "SdkClientError",
			code: "resume_failed",
			message: "resume failed",
		});
		expect(calls).toEqual(["session.list", "session.list", "session.resume"]);
	});

	test("does not recover a live endpoint or change closed selection failures", async () => {
		const calls: string[] = [];
		const broker = {
			global: async (operation: string) => {
				calls.push(operation);
				return {
					ok: true,
					result: {
						sessions: [
							{ sessionId: "live", live: true, ambiguous: false },
							{ sessionId: "live-2", live: true, ambiguous: false },
							{ sessionId: "ambiguous", live: false, ambiguous: true },
						],
						warnings: [],
					},
				};
			},
		} as never;

		expect(await resolveServeSession(broker, "live")).toBe("live");
		expect([
			await serveRejectionFailure(() => resolveServeSession(broker, "ambiguous")),
			await serveRejectionFailure(() => resolveServeSession(broker, "missing")),
			await serveRejectionFailure(() => resolveServeSession(broker)),
		]).toEqual([
			{ typed: true, code: "ambiguous_session", exitCode: 1 },
			{ typed: true, code: "not_found", exitCode: 1 },
			{ typed: true, code: "multiple_live_endpoints", exitCode: 1 },
		]);
		expect(calls.filter(operation => operation === "session.resume")).toHaveLength(0);
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

	test("reports a broker-indexed but reaped session as a typed endpoint_stale failure", () => {
		// The issue's scenario: a per-turn embedder returns after ~30 minutes of quiet,
		// the session host has self-reaped, and the broker still indexes the row. The
		// code must live in a field an embedder can branch on, not inside the message.
		const reaped = [{ sessionId: "sess-reaped", live: false, ambiguous: false }];
		expect(serveFailure(() => selectBrokerSession(reaped, "sess-reaped"))).toEqual({
			typed: true,
			code: "endpoint_stale",
			exitCode: 1,
		});
	});

	test("maps every session-selection failure to its own stable code", () => {
		const live = (sessionId: string) => ({ sessionId, live: true, ambiguous: false });
		const cases: [string, () => string][] = [
			["not_found", () => selectBrokerSession([], "missing")],
			["ambiguous_session", () => selectBrokerSession([{ sessionId: "dup", live: true, ambiguous: true }], "dup")],
			["endpoint_stale", () => selectBrokerSession([{ sessionId: "s", live: false, ambiguous: false }], "s")],
			[
				"no_live_endpoint",
				() => selectBrokerSession([{ sessionId: "s", live: false, ambiguous: false }], undefined),
			],
			["multiple_live_endpoints", () => selectBrokerSession([live("a"), live("b")], undefined)],
		];
		expect(cases.map(([, run]) => serveFailure(run))).toEqual(
			cases.map(([code]) => ({ typed: true, code, exitCode: 1 })),
		);
	});

	test("propagates a broker SdkClientError through serve with its code and details intact", async () => {
		const broker = fakeBroker(() => ({
			ok: false,
			error: { code: "endpoint_credential_forbidden", message: "credential refused", details: { reason: "lease" } },
		}));
		try {
			const failure = await withServeAgentDir(broker.url, async () => {
				try {
					await runSdkServe(["--stdio"]);
				} catch (error) {
					return error;
				}
				throw new Error("Expected serve to fail.");
			});
			expect(failure).toBeInstanceOf(SdkServeError);
			expect(failure).toMatchObject({
				code: "endpoint_credential_forbidden",
				message: "credential refused",
				exitCode: 1,
				// `details` is the field the old bare-Error downgrade destroyed.
				details: {
					code: "endpoint_credential_forbidden",
					message: "credential refused",
					details: { reason: "lease" },
				},
			});
		} finally {
			broker.stop();
		}
	});

	test("renders a serve failure as a structured envelope on stderr without an uncaught exception", async () => {
		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		const realStdout = process.stdout.write;
		const realStderr = process.stderr.write;
		const previousExitCode = process.exitCode;
		(process.stdout as unknown as { write(value: string): boolean }).write = value => {
			stdoutChunks.push(String(value));
			return true;
		};
		(process.stderr as unknown as { write(value: string): boolean }).write = value => {
			stderrChunks.push(String(value));
			return true;
		};
		let observedExitCode: typeof process.exitCode;
		try {
			// No discovery record in this private agent dir, so selection fails closed.
			// `run()` must resolve: a rethrow here is the uncaught exception being fixed.
			await withServeAgentDir(undefined, async () => {
				await new Sdk(["serve", "--stdio"], {} as never).run();
			});
			observedExitCode = process.exitCode;
		} finally {
			(process.stdout as unknown as { write: typeof realStdout }).write = realStdout;
			(process.stderr as unknown as { write: typeof realStderr }).write = realStderr;
			// Restore to a real number: assigning `undefined` is a no-op in Bun, so it
			// would leave the boundary's exit code 1 on the whole test runner process.
			process.exitCode = previousExitCode ?? 0;
		}
		expect(observedExitCode).toBe(1);
		// The frame channel must stay byte-pure: the envelope belongs on stderr alone.
		expect(stdoutChunks.join("")).toBe("");
		const lines = stderrChunks.join("").split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!)).toEqual({
			ok: false,
			error: { code: "broker_unavailable", message: "SDK broker is not running" },
		});
	});

	test("keeps the primary serve failure when broker cleanup also fails", async () => {
		const broker = fakeBroker(() => ({
			ok: false,
			error: { code: "endpoint_credential_forbidden", message: "credential refused", details: { reason: "lease" } },
		}));
		try {
			const failure = await withServeAgentDir(broker.url, async () =>
				withRejectingBrokerClose(async () => await serveRejection(["--stdio"])),
			);
			expect(failure).toBeInstanceOf(SdkServeError);
			// The code an embedder branches on is the broker's, never the teardown's,
			// and the broker payload survives the cleanup failure untouched.
			expect(failure).toMatchObject({
				code: "endpoint_credential_forbidden",
				message: "credential refused",
				exitCode: 1,
				details: {
					code: "endpoint_credential_forbidden",
					message: "credential refused",
					details: { reason: "lease" },
				},
				cleanupError: { code: "timeout", message: closeFailureMessage },
			});
		} finally {
			broker.stop();
		}
	});

	test("reports a cleanup-only broker failure through the transport diagnostic channel", async () => {
		const fake = upstream();
		const broker = fakeBroker(operation =>
			operation === "session.list"
				? {
						ok: true,
						result: { sessions: [{ sessionId: "sess-live", live: true, ambiguous: false }], warnings: [] },
					}
				: { ok: true, result: { url: fake.url, token } },
		);
		const socketPath = path.join(await tempDir(), "serve.sock");
		const diagnostics: string[] = [];
		const realStderr = process.stderr.write;
		const previousExitCode = process.exitCode;
		(process.stderr as unknown as { write(value: string): boolean }).write = value => {
			diagnostics.push(String(value));
			return true;
		};
		try {
			const result = await withServeAgentDir(broker.url, async () =>
				withRejectingBrokerClose(async () => {
					const before = process.listeners("SIGINT");
					const served = runSdkServe(["--socket", socketPath]);
					await stopServeViaSignalHandler(before);
					return await served;
				}),
			);
			expect(result).toBeUndefined();
			expect(process.exitCode).toBe(1);
			expect(diagnostics).toEqual(['{"type":"transport_error","code":"serve_failed"}\n']);
		} finally {
			process.stderr.write = realStderr;
			process.exitCode = previousExitCode ?? 0;
			broker.stop();
			fake.stop();
		}
	});

	test("reports an unreadable broker discovery record as a typed failure", async () => {
		const failure = await withServeAgentDir(undefined, async () => {
			// A record from a newer SDK state version: the read throws rather than
			// reporting the broker absent. A JSON syntax error cannot reach this path
			// — the reader folds that into the absent case.
			const file = path.join(getAgentDir(), "sdk", "broker.json");
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(file, JSON.stringify({ version: SDK_STATE_VERSION + 1, token: "super-secret-token" }));
			return await serveRejection(["--stdio"]);
		});
		expect(failure).toBeInstanceOf(SdkServeError);
		expect(failure).toMatchObject({
			code: "broker_discovery_unreadable",
			exitCode: 1,
			details: { code: "discovery_error", path: expect.stringContaining(path.join("sdk", "broker.json")) },
		});
		const typed = failure as SdkServeError;
		expect(`${typed.message} ${JSON.stringify(typed.details)}`).not.toContain("super-secret-token");
	});

	test("still reports a missing broker discovery record as broker_unavailable", async () => {
		// Pins the ENOENT case against the typed wrap around the same read.
		const failure = await withServeAgentDir(undefined, async () => await serveRejection(["--stdio"]));
		expect(failure).toBeInstanceOf(SdkServeError);
		expect(failure).toMatchObject({
			code: "broker_unavailable",
			message: "SDK broker is not running",
			exitCode: 1,
		});
	});

	test("carries a broker cleanup failure into the serve stderr envelope", async () => {
		const broker = fakeBroker(() => ({
			ok: false,
			error: { code: "endpoint_credential_forbidden", message: "credential refused" },
		}));
		try {
			const failed = await withRejectingBrokerClose(async () => await serveEnvelope(broker.url));
			// The frame channel stays byte-pure; the teardown diagnostics ride on stderr.
			expect(failed.stdout).toBe("");
			expect(failed.error).toMatchObject({ code: "endpoint_credential_forbidden" });
			expect(failed.error.cleanupError).toEqual({ code: "timeout", message: closeFailureMessage });
			// Negative control: a clean teardown leaves the envelope as it was before
			// the field existed, so the key must not become unconditionally present.
			const clean = await serveEnvelope(broker.url);
			expect(clean.error).toMatchObject({ code: "endpoint_credential_forbidden" });
			expect("cleanupError" in clean.error).toBe(false);
		} finally {
			broker.stop();
		}
	});

	test("keeps post-start stdio failures out of the relay frame channel", async () => {
		const upstreamServer = upstream();
		const broker = fakeBroker(operation =>
			operation === "session.list"
				? {
						ok: true,
						result: { sessions: [{ sessionId: "sess-live", live: true, ambiguous: false }], warnings: [] },
					}
				: { ok: true, result: { url: upstreamServer.url, token } },
		);
		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		const input = new PassThrough();
		const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
		const realStdout = process.stdout.write;
		const realStderr = process.stderr.write;
		const previousExitCode = process.exitCode;
		Object.defineProperty(process, "stdin", { value: input, configurable: true });
		(process.stdout as unknown as { write(value: string): boolean }).write = value => {
			stdoutChunks.push(String(value));
			return true;
		};
		(process.stderr as unknown as { write(value: string): boolean }).write = value => {
			stderrChunks.push(String(value));
			return true;
		};
		try {
			const before = process.listeners("SIGINT");
			const served = withRejectingBrokerClose(async () =>
				withServeAgentDir(broker.url, async () =>
					dispatchPublicCommand(["serve", "--stdio", "--json"], {
						bin: "gjc",
						version: "test",
						command: "sdk",
						load: async () => Sdk,
					}),
				),
			);
			await waitFor(() => upstreamServer.connections[0], "stdio relay upstream");
			// The upstream fixture announces the relay connection immediately after
			// accepting it. Consume that protocol hello before asserting the later
			// application frame and teardown diagnostic channels.
			await waitFor(
				() => (stdoutChunks.join("").includes('{"type":"hello","connectionId":"fixture"}') ? true : undefined),
				"stdio relay hello",
			);
			stdoutChunks.length = 0;
			const frame = '{"type":"relay","ok":true}';
			upstreamServer.connections[0]!.ws.send(frame);
			await waitFor(() => (stdoutChunks.length ? stdoutChunks.join("") : undefined), "stdio relay frame");
			await stopServeViaSignalHandler(before);
			await served;
			expect(stdoutChunks.join("")).toBe(`${frame}\n`);
			expect(stderrChunks.join("")).toBe('{"type":"transport_error","code":"serve_failed"}\n');
		} finally {
			(process.stdout as unknown as { write: typeof realStdout }).write = realStdout;
			(process.stderr as unknown as { write: typeof realStderr }).write = realStderr;
			if (stdinDescriptor) Object.defineProperty(process, "stdin", stdinDescriptor);
			input.destroy();
			process.exitCode = previousExitCode ?? 0;
			broker.stop();
			upstreamServer.stop();
		}
	});

	test("rejects an empty or malformed endpoint credential before starting the relay", async () => {
		const fake = upstream();
		// The socket dir is deliberately insecure and nothing listens on port 1, so if
		// the credential guard ever stopped running first, the next failure would carry
		// a different code — the regression reads as a code diff rather than a live
		// relay the test then has to wait out.
		const insecureDir = await tempDir();
		await fs.chmod(insecureDir, 0o777);
		const socketArgv = ["--socket", path.join(insecureDir, "serve.sock")];
		const cases: { argv: string[]; endpoint: Record<string, unknown> }[] = [
			{ argv: socketArgv, endpoint: { url: fake.url, token: "" } },
			{ argv: socketArgv, endpoint: { url: fake.url } },
			{ argv: socketArgv, endpoint: { url: fake.url, token: 42 } },
			{ argv: ["--stdio"], endpoint: { url: "ws://127.0.0.1:1", token: "" } },
		];
		const observed: unknown[] = [];
		try {
			for (const { argv, endpoint } of cases) {
				const broker = fakeBroker(operation =>
					operation === "session.list"
						? {
								ok: true,
								result: { sessions: [{ sessionId: "sess-live", live: true, ambiguous: false }], warnings: [] },
							}
						: { ok: true, result: endpoint },
				);
				try {
					const failure = await withServeAgentDir(broker.url, async () => await serveRejection(argv));
					// Only the code is recorded — the credential itself is never echoed.
					const typed = failure as { code?: unknown; exitCode?: unknown };
					observed.push({ typed: failure instanceof SdkServeError, code: typed.code, exitCode: typed.exitCode });
				} finally {
					broker.stop();
				}
			}
			expect(observed).toEqual(cases.map(() => ({ typed: true, code: "unavailable", exitCode: 1 })));
			// Neither relay ever reached the endpoint the broker handed back.
			expect(fake.connections).toHaveLength(0);
		} finally {
			fake.stop();
		}
	});
});

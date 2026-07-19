import { afterEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { CodexHandoffRegistrationV1, CodexWakeEventV1 } from "../src/coordinator-mcp/codex-handoff";
import {
	assertSafeCodexEndpoint,
	buildCodexWakePrompt,
	type CodexAppServerTransport,
	type CodexTransportFactory,
	createDefaultCodexTransportFactory,
	publishCodexWake,
	readCodexTokenFile,
} from "../src/coordinator-mcp/codex-wake-publisher";

const tempDirs: string[] = [];
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

async function tempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-codex-publisher-"));
	tempDirs.push(root);
	return root;
}

function handoff(tokenFile: string | null = null): CodexHandoffRegistrationV1 {
	return {
		schema_version: 1,
		work_unit: "session-1",
		thread_id: "thread-1",
		endpoint: { kind: "unix", path: "/tmp/codex.sock" },
		token_file: tokenFile,
		registered_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
	};
}

function event(): CodexWakeEventV1 {
	return {
		schema_version: 1,
		key: "session-1:7",
		work_unit: "session-1",
		event_seq: 7,
		event_kind: "turn.completed",
		turn_id: "turn-1",
		question_id: null,
		summary: "Delegate work completed.",
		status: "pending",
		attempts: 0,
		client_user_message_id: "gjc-wake-session-1:7",
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		last_error: null,
	};
}

function serverFrame(payload: string, opcode = 0x1): Buffer {
	const body = Buffer.from(payload);
	if (body.length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body]);
	const header = Buffer.alloc(4);
	header[0] = 0x81;
	header[1] = 126;
	header.writeUInt16BE(body.length, 2);
	return Buffer.concat([header, body]);
}

function parseMaskedFrames(buffer: Buffer): { messages: string[]; pongs: Buffer[]; remaining: Buffer } {
	const messages: string[] = [];
	const pongs: Buffer[] = [];
	for (;;) {
		if (buffer.length < 2) return { messages, pongs, remaining: buffer };
		const lengthCode = buffer[1]! & 0x7f;
		let headerLength = 2;
		let length: number;
		if (lengthCode < 126) length = lengthCode;
		else if (lengthCode === 126) {
			if (buffer.length < 4) return { messages, pongs, remaining: buffer };
			length = buffer.readUInt16BE(2);
			headerLength = 4;
		} else {
			if (buffer.length < 10) return { messages, pongs, remaining: buffer };
			length = Number(buffer.readBigUInt64BE(2));
			headerLength = 10;
		}
		if (buffer.length < headerLength + 4 + length) return { messages, pongs, remaining: buffer };
		const mask = buffer.subarray(headerLength, headerLength + 4);
		const payload = Buffer.from(buffer.subarray(headerLength + 4, headerLength + 4 + length));
		for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4]!;
		if ((buffer[0]! & 0x0f) === 0x1) messages.push(payload.toString());
		else if ((buffer[0]! & 0x0f) === 0xa) pongs.push(payload);
		buffer = buffer.subarray(headerLength + 4 + length);
	}
}

async function createWebSocketFixture(
	socketPath: string,
	status: "idle" | "active",
	behavior: { ping?: boolean; noiseBeforeResponse?: boolean } = {},
) {
	const messages: Array<{ method: string; params: Record<string, unknown> }> = [];
	const headers: string[] = [];
	const pongs: Buffer[] = [];
	const server = net.createServer(socket => {
		let handshaken = false;
		let initialized = false;
		let buffer = Buffer.alloc(0);
		socket.on("data", chunk => {
			buffer = Buffer.concat([buffer, chunk]);
			if (!handshaken) {
				// Real app-server transports are WebSocket only; raw JSONL clients never upgrade.
				if (!buffer.subarray(0, 4).toString("latin1").startsWith("GET")) {
					socket.destroy();
					return;
				}
				const end = buffer.indexOf("\r\n\r\n");
				if (end < 0) return;
				const request = buffer.subarray(0, end).toString("latin1");
				headers.push(request);
				const key = request.match(/^Sec-WebSocket-Key:\s*(.+)$/im)?.[1]?.trim();
				if (key === undefined) throw new Error("missing websocket key");
				const accept = crypto.createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
				socket.write(
					`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
				);
				buffer = buffer.subarray(end + 4);
				handshaken = true;
				if (behavior.ping) socket.write(serverFrame("ping-payload", 0x9));
			}
			const parsed = parseMaskedFrames(buffer);
			buffer = parsed.remaining;
			for (const pong of parsed.pongs ?? []) pongs.push(pong);
			for (const message of parsed.messages) {
				const request = JSON.parse(message) as { id?: number; method: string; params: Record<string, unknown> };
				messages.push({ method: request.method, params: request.params });
				if (request.id === undefined) {
					if (request.method === "initialized") initialized = true;
					continue;
				}
				// Per the generated protocol, every connection must initialize before other requests.
				if (request.method !== "initialize" && !initialized) {
					socket.write(
						serverFrame(
							JSON.stringify({
								jsonrpc: "2.0",
								id: request.id,
								error: { code: -32600, message: "not initialized" },
							}),
						),
					);
					continue;
				}
				// Generated TurnStartParams accepts threadId/clientUserMessageId/input; legacy prompt is invalid.
				if (
					request.method === "turn/start" &&
					("prompt" in request.params ||
						!Array.isArray(request.params.input) ||
						!(request.params.input as Array<Record<string, unknown>>).every(
							item => item.type === "text" && typeof item.text === "string" && Array.isArray(item.text_elements),
						))
				) {
					socket.write(
						serverFrame(
							JSON.stringify({
								jsonrpc: "2.0",
								id: request.id,
								error: { code: -32602, message: "invalid turn/start params" },
							}),
						),
					);
					continue;
				}
				const result =
					request.method === "initialize"
						? { userAgent: "fixture" }
						: request.method === "thread/resume"
							? {
									thread: {
										id: request.params.threadId,
										status: status === "idle" ? { type: "idle" } : { type: "active", activeFlags: [] },
									},
								}
							: request.method === "turn/start"
								? { turn: {} }
								: {};
				if (behavior.noiseBeforeResponse) {
					socket.write(serverFrame(JSON.stringify({ jsonrpc: "2.0", id: 999999, result: { wrong: true } })));
					socket.write(serverFrame(JSON.stringify({ jsonrpc: "2.0", method: "noise/notification", params: {} })));
				}
				socket.write(serverFrame(JSON.stringify({ jsonrpc: "2.0", id: request.id, result })));
			}
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(socketPath, () => listening.resolve());
	await listening.promise;
	return { messages, headers, pongs, server };
}

async function closeServer(server: net.Server): Promise<void> {
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	await closed.promise;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("Codex wake publisher", () => {
	it("starts an idle Codex turn with the deterministic message id", async () => {
		const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
		const notifications: string[] = [];
		const factory = async (): Promise<CodexAppServerTransport> => ({
			request: async (method, params) => {
				calls.push({ method, params });
				return method === "thread/resume" ? { thread: { status: { type: "idle" } } } : {};
			},
			notify: async method => {
				notifications.push(method);
			},
			close: async () => {},
		});
		const wake = event();
		const result = await publishCodexWake({ handoff: handoff(), event: wake, transportFactory: factory });

		expect(result).toEqual({ published: true, reason: null });
		expect(calls.map(call => call.method)).toEqual(["initialize", "thread/resume", "turn/start"]);
		expect(notifications).toEqual(["initialized"]);
		expect(calls[2]).toEqual({
			method: "turn/start",
			params: {
				threadId: "thread-1",
				clientUserMessageId: wake.client_user_message_id,
				input: [{ type: "text", text: buildCodexWakePrompt(wake), text_elements: [] }],
			},
		});
		const finalResponseFixture = "DO_NOT_INCLUDE_FINAL_RESPONSE";
		expect(buildCodexWakePrompt(wake)).toContain(wake.event_kind);
		expect(buildCodexWakePrompt(wake)).toContain(wake.key);
		expect(buildCodexWakePrompt(wake)).not.toContain(wake.summary);
		expect(buildCodexWakePrompt(wake)).not.toContain(finalResponseFixture);
	});

	it("leaves the wake pending when the Codex thread is active", async () => {
		const calls: string[] = [];
		const factory = async (): Promise<CodexAppServerTransport> => ({
			request: async method => {
				calls.push(method);
				return method === "thread/resume" ? { thread: { status: { type: "active", activeFlags: [] } } } : {};
			},
			close: async () => {},
		});

		expect(await publishCodexWake({ handoff: handoff(), event: event(), transportFactory: factory })).toEqual({
			published: false,
			reason: "thread_active_pending",
		});
		expect(calls).toEqual(["initialize", "thread/resume"]);
	});

	it("only permits loopback TCP endpoints and absolute unix sockets", () => {
		for (const host of ["10.0.0.5", "example.com", "0.0.0.0"])
			expect(() => assertSafeCodexEndpoint({ kind: "tcp", host, port: 1234 })).toThrow(
				"codex_endpoint_not_loopback",
			);
		expect(assertSafeCodexEndpoint({ kind: "tcp", host: "127.0.0.1", port: 1234 })).toEqual({
			kind: "tcp",
			host: "127.0.0.1",
			port: 1234,
		});
		expect(assertSafeCodexEndpoint({ kind: "tcp", host: "::1", port: 1234 })).toEqual({
			kind: "tcp",
			host: "::1",
			port: 1234,
		});
		expect(assertSafeCodexEndpoint({ kind: "tcp", host: "local" + "host", port: 1234 })).toEqual({
			kind: "tcp",
			host: "local" + "host",
			port: 1234,
		});
		expect(assertSafeCodexEndpoint({ kind: "unix", path: "/tmp/codex.sock" })).toEqual({
			kind: "unix",
			path: "/tmp/codex.sock",
		});
	});

	it("passes file token content to the transport and hides unreadable-file details", async () => {
		const root = await tempRoot();
		const tokenFile = path.join(root, "token.txt");
		await fs.writeFile(tokenFile, "token-value\n");
		let suppliedToken: string | null = null;
		const factory = async (_endpoint: unknown, token: string | null): Promise<CodexAppServerTransport> => {
			suppliedToken = token;
			return {
				request: async method =>
					method === "thread/resume" ? { thread: { status: { type: "active", activeFlags: [] } } } : {},
				close: async () => {},
			};
		};
		await publishCodexWake({ handoff: handoff(tokenFile), event: event(), transportFactory: factory });
		expect(suppliedToken as string | null).toBe("token-value");
		await fs.rm(tokenFile);
		await expect(readCodexTokenFile(tokenFile)).rejects.toThrow("codex_token_file_unreadable");
		await expect(readCodexTokenFile(tokenFile)).rejects.not.toThrow("token-value");
	});

	it("publishes over the default unix WebSocket JSON-RPC transport", async () => {
		const root = await tempRoot();
		const socketPath = path.join(root, "codex.sock");
		const fixture = await createWebSocketFixture(socketPath, "idle");
		try {
			const wake = event();
			const result = await publishCodexWake({
				handoff: { ...handoff(), endpoint: { kind: "unix", path: socketPath } },
				event: wake,
				transportFactory: createDefaultCodexTransportFactory(),
			});
			expect(result).toEqual({ published: true, reason: null });
			expect(fixture.messages.map(message => message.method)).toEqual([
				"initialize",
				"initialized",
				"thread/resume",
				"turn/start",
			]);
			expect(fixture.messages[3]?.params).toEqual({
				threadId: "thread-1",
				clientUserMessageId: wake.client_user_message_id,
				input: [{ type: "text", text: buildCodexWakePrompt(wake), text_elements: [] }],
			});
		} finally {
			await closeServer(fixture.server);
		}
	});

	it("does not start a turn over the default transport while the thread is active", async () => {
		const root = await tempRoot();
		const socketPath = path.join(root, "codex.sock");
		const fixture = await createWebSocketFixture(socketPath, "active");
		try {
			expect(
				await publishCodexWake({
					handoff: { ...handoff(), endpoint: { kind: "unix", path: socketPath } },
					event: event(),
					transportFactory: createDefaultCodexTransportFactory(),
				}),
			).toEqual({ published: false, reason: "thread_active_pending" });
			expect(fixture.messages.map(message => message.method)).toEqual([
				"initialize",
				"initialized",
				"thread/resume",
			]);
		} finally {
			await closeServer(fixture.server);
		}
	});

	it("rejects a legacy raw-JSONL prompt-based transport against the schema-backed fixture", async () => {
		// Emulates the f792165d-era transport: raw newline JSON-RPC without a WebSocket
		// upgrade, no initialize/initialized handshake, and turn/start with `prompt`.
		const root = await tempRoot();
		const socketPath = path.join(root, "codex-legacy.sock");
		const fixture = await createWebSocketFixture(socketPath, "idle");
		try {
			const legacyFactory: CodexTransportFactory = async endpoint => {
				if (endpoint.kind !== "unix") throw new Error("invalid_codex_endpoint");
				const socket = net.createConnection(endpoint.path);
				const connected = Promise.withResolvers<void>();
				socket.once("connect", () => connected.resolve());
				socket.once("error", error => connected.reject(error));
				await connected.promise;
				return {
					request: async (method, params) =>
						await new Promise((_, reject) => {
							socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
							socket.once("close", () => reject(new Error("codex_app_server_unavailable")));
							setTimeout(() => reject(new Error("codex_app_server_timeout")), 500);
						}),
					close: async () => {
						socket.destroy();
					},
				};
			};
			await expect(
				publishCodexWake({
					handoff: { ...handoff(), endpoint: { kind: "unix", path: socketPath } },
					event: event(),
					transportFactory: legacyFactory,
				}),
			).rejects.toThrow(/codex_app_server_(unavailable|timeout)/);
			expect(fixture.messages).toHaveLength(0);
		} finally {
			await closeServer(fixture.server);
		}
	});

	it("fails requests sent before initialize and turn/start bodies using legacy prompt params", async () => {
		const root = await tempRoot();
		const socketPath = path.join(root, "codex-strict.sock");
		const fixture = await createWebSocketFixture(socketPath, "idle");
		try {
			const transport = await createDefaultCodexTransportFactory()({ kind: "unix", path: socketPath }, null);
			try {
				// Request before initialize -> fixture rejects per protocol.
				await expect(transport.request("thread/resume", { threadId: "thread-1" })).rejects.toThrow(
					"codex_app_server_request_failed",
				);
				await transport.request("initialize", {
					clientInfo: { name: "strict-test", title: null, version: "0" },
					capabilities: null,
				});
				await transport.notify?.("initialized");
				// Legacy prompt-shaped turn/start -> invalid params per generated TurnStartParams.
				await expect(
					transport.request("turn/start", { threadId: "thread-1", prompt: "legacy prompt body" }),
				).rejects.toThrow("codex_app_server_request_failed");
				// Schema-shaped input succeeds.
				await transport.request("thread/resume", { threadId: "thread-1" });
				await expect(
					transport.request("turn/start", {
						threadId: "thread-1",
						clientUserMessageId: "gjc-wake-session-1:7",
						input: [{ type: "text", text: "ok", text_elements: [] }],
					}),
				).resolves.toBeDefined();
			} finally {
				await transport.close();
			}
		} finally {
			await closeServer(fixture.server);
		}
	});

	it("answers pings with pongs, ignores unrelated ids, and sends the token as a Bearer upgrade header", async () => {
		const root = await tempRoot();
		const socketPath = path.join(root, "codex-protocol.sock");
		const tokenFile = path.join(root, "token.txt");
		await fs.writeFile(tokenFile, "bearer-secret\n");
		const fixture = await createWebSocketFixture(socketPath, "idle", { ping: true, noiseBeforeResponse: true });
		try {
			const result = await publishCodexWake({
				handoff: { ...handoff(tokenFile), endpoint: { kind: "unix", path: socketPath } },
				event: event(),
				transportFactory: createDefaultCodexTransportFactory(),
			});
			expect(result).toEqual({ published: true, reason: null });
			expect(fixture.headers[0]).toContain("Authorization: Bearer bearer-secret");
			expect(fixture.pongs.map(pong => pong.toString())).toContain("ping-payload");
			for (const message of fixture.messages)
				expect(JSON.stringify(message.params ?? {})).not.toContain("bearer-secret");
		} finally {
			await closeServer(fixture.server);
		}
	});

	it("fails fast with bounded unavailability when the server closes before upgrading", async () => {
		const root = await tempRoot();
		const socketPath = path.join(root, "codex-close.sock");
		const server = net.createServer(socket => socket.destroy());
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(socketPath, () => listening.resolve());
		await listening.promise;
		try {
			await expect(
				publishCodexWake({
					handoff: { ...handoff(), endpoint: { kind: "unix", path: socketPath } },
					event: event(),
					transportFactory: createDefaultCodexTransportFactory(),
				}),
			).rejects.toThrow("codex_app_server_unavailable");
		} finally {
			await closeServer(server);
		}
	});

	it("bounds a stalled upgrade with the establishment deadline", async () => {
		const root = await tempRoot();
		const socketPath = path.join(root, "codex-stall.sock");
		const server = net.createServer(() => {});
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(socketPath, () => listening.resolve());
		await listening.promise;
		try {
			const started = Date.now();
			await expect(
				publishCodexWake({
					handoff: { ...handoff(), endpoint: { kind: "unix", path: socketPath } },
					event: event(),
					transportFactory: createDefaultCodexTransportFactory({ establishTimeoutMs: 250 }),
				}),
			).rejects.toThrow("codex_app_server_unavailable");
			expect(Date.now() - started).toBeLessThan(5_000);
		} finally {
			await closeServer(server);
		}
	});
});

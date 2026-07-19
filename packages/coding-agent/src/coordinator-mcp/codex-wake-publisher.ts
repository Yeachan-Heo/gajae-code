import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import packageJson from "../../package.json" with { type: "json" };
import type { CodexHandoffEndpoint, CodexHandoffRegistrationV1, CodexWakeEventV1 } from "./codex-handoff";

export interface CodexAppServerTransport {
	request(method: string, params: Record<string, unknown>): Promise<unknown>;
	notify?(method: string, params?: Record<string, unknown>): Promise<void>;
	close(): Promise<void>;
}

export type CodexTransportFactory = (
	endpoint: CodexHandoffEndpoint,
	token: string | null,
) => Promise<CodexAppServerTransport>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function assertSafeCodexEndpoint(endpoint: unknown): CodexHandoffEndpoint {
	if (endpoint === null || typeof endpoint !== "object") throw new Error("invalid_codex_endpoint");
	const value = endpoint as Record<string, unknown>;
	if (value.kind === "unix") {
		if (
			typeof value.path !== "string" ||
			value.path.length === 0 ||
			value.path.length > 1024 ||
			!value.path.startsWith("/")
		)
			throw new Error("invalid_codex_endpoint");
		return { kind: "unix", path: value.path };
	}
	if (value.kind === "tcp") {
		if (typeof value.host !== "string" || typeof value.port !== "number") throw new Error("invalid_codex_endpoint");
		if (!LOOPBACK_HOSTS.has(value.host.toLowerCase())) throw new Error("codex_endpoint_not_loopback");
		if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535)
			throw new Error("invalid_codex_endpoint");
		return { kind: "tcp", host: value.host, port: value.port };
	}
	throw new Error("invalid_codex_endpoint");
}

export async function readCodexTokenFile(tokenFile: string | null): Promise<string | null> {
	if (tokenFile === null) return null;
	try {
		return (await fs.readFile(tokenFile, "utf8")).trim();
	} catch {
		throw new Error("codex_token_file_unreadable");
	}
}

export function buildCodexWakePrompt(event: CodexWakeEventV1): string {
	const identifiers = [
		`event_kind: ${event.event_kind}`,
		`work_unit: ${event.work_unit}`,
		`wake_key: ${event.key}`,
		...(event.turn_id === null ? [] : [`turn_id: ${event.turn_id}`]),
		...(event.question_id === null ? [] : [`question_id: ${event.question_id}`]),
	];
	return `${identifiers.join("\n")}\nResume the delegate flow by reading coordinator state.`;
}

function idleStatus(value: unknown): boolean {
	if (value === null || typeof value !== "object") return false;
	const thread = (value as Record<string, unknown>).thread;
	if (thread === null || typeof thread !== "object") return false;
	const status = (thread as Record<string, unknown>).status;
	return status !== null && typeof status === "object" && (status as Record<string, unknown>).type === "idle";
}

export async function publishCodexWake(input: {
	handoff: CodexHandoffRegistrationV1;
	event: CodexWakeEventV1;
	transportFactory: CodexTransportFactory;
}): Promise<{ published: boolean; reason: string | null }> {
	const endpoint = assertSafeCodexEndpoint(input.handoff.endpoint);
	const token = await readCodexTokenFile(input.handoff.token_file);
	const transport = await input.transportFactory(endpoint, token);
	try {
		await transport.request("initialize", {
			clientInfo: { name: "gjc-coordinator", title: null, version: packageJson.version || "0" },
			capabilities: null,
		});
		await transport.notify?.("initialized");
		const resumed = await transport.request("thread/resume", { threadId: input.handoff.thread_id });
		if (!idleStatus(resumed)) return { published: false, reason: "thread_active_pending" };
		await transport.request("turn/start", {
			threadId: input.handoff.thread_id,
			clientUserMessageId: input.event.client_user_message_id,
			input: [{ type: "text", text: buildCodexWakePrompt(input.event), text_elements: [] }],
		});
		return { published: true, reason: null };
	} finally {
		await transport.close();
	}
}

interface JsonRpcResponse {
	id?: number;
	result?: unknown;
	error?: unknown;
}

function maskedFrame(opcode: number, payload: Buffer): Buffer {
	const mask = crypto.randomBytes(4);
	let header: Buffer;
	if (payload.length < 126) {
		header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
	} else if (payload.length <= 0xffff) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 0x80 | 126;
		header.writeUInt16BE(payload.length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 0x80 | 127;
		header.writeBigUInt64BE(BigInt(payload.length), 2);
	}
	const masked = Buffer.alloc(payload.length);
	for (let index = 0; index < payload.length; index++) masked[index] = payload[index] ^ mask[index % 4]!;
	return Buffer.concat([header, mask, masked]);
}

async function upgradeWebSocket(socket: net.Socket, host: string, token: string | null): Promise<Buffer> {
	const key = crypto.randomBytes(16).toString("base64");
	const expectedAccept = crypto.createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
	const upgraded = Promise.withResolvers<Buffer>();
	let buffer = Buffer.alloc(0);
	const onData = (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		const end = buffer.indexOf("\r\n\r\n");
		if (end < 0) return;
		const headers = buffer.subarray(0, end).toString("latin1").split("\r\n");
		const status = headers.shift();
		const values = new Map(
			headers.map(header => {
				const separator = header.indexOf(":");
				return [header.slice(0, separator).toLowerCase(), header.slice(separator + 1).trim()];
			}),
		);
		cleanup();
		if (!/^HTTP\/1\.1 101(?:\s|$)/.test(status ?? "") || values.get("sec-websocket-accept") !== expectedAccept) {
			upgraded.reject(new Error("codex_app_server_unavailable"));
			return;
		}
		upgraded.resolve(buffer.subarray(end + 4));
	};
	const onError = () => {
		cleanup();
		upgraded.reject(new Error("codex_app_server_unavailable"));
	};
	const cleanup = () => {
		socket.off("data", onData);
		socket.off("error", onError);
	};
	socket.on("data", onData);
	socket.on("error", onError);
	const authorization = token === null ? "" : `Authorization: Bearer ${token}\r\n`;
	socket.write(
		`GET / HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${authorization}Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
	);
	return upgraded.promise;
}

export interface CodexTransportFactoryOptions {
	establishTimeoutMs?: number;
	requestTimeoutMs?: number;
}

function formatWebSocketHost(
	endpoint: { kind: "unix"; path: string } | { kind: "tcp"; host: string; port: number },
): string {
	if (endpoint.kind === "unix") return "localhost";
	const host = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host;
	return `${host}:${endpoint.port}`;
}

export function createDefaultCodexTransportFactory(options: CodexTransportFactoryOptions = {}): CodexTransportFactory {
	const establishTimeoutMs = options.establishTimeoutMs ?? 10_000;
	const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
	return async (endpoint, token) => {
		const safeEndpoint = assertSafeCodexEndpoint(endpoint);
		const socket =
			safeEndpoint.kind === "unix"
				? net.createConnection(safeEndpoint.path)
				: net.createConnection({ host: safeEndpoint.host, port: safeEndpoint.port });
		const established = Promise.withResolvers<Buffer>();
		let establishmentSettled = false;
		const settleEstablishment = (error: Error | null, remaining?: Buffer) => {
			if (establishmentSettled) return;
			establishmentSettled = true;
			clearTimeout(establishDeadline);
			socket.off("end", onEstablishClosed);
			socket.off("close", onEstablishClosed);
			if (error) established.reject(error);
			else established.resolve(remaining ?? Buffer.alloc(0));
		};
		const onEstablishClosed = () => settleEstablishment(new Error("codex_app_server_unavailable"));
		const establishDeadline = setTimeout(
			() => settleEstablishment(new Error("codex_app_server_unavailable")),
			establishTimeoutMs,
		);
		socket.once("end", onEstablishClosed);
		socket.once("close", onEstablishClosed);
		const connected = Promise.withResolvers<void>();
		const onConnectError = () => connected.reject(new Error("codex_app_server_unavailable"));
		socket.once("connect", () => connected.resolve());
		socket.once("error", onConnectError);
		void connected.promise
			.then(() => {
				socket.off("error", onConnectError);
				return upgradeWebSocket(socket, formatWebSocketHost(safeEndpoint), token);
			})
			.then(remaining => settleEstablishment(null, remaining))
			.catch(() => settleEstablishment(new Error("codex_app_server_unavailable")));
		let remaining: Buffer;
		try {
			remaining = await established.promise;
		} catch {
			socket.destroy();
			throw new Error("codex_app_server_unavailable");
		}
		let nextId = 1;
		let buffer = Buffer.alloc(0);
		let pending: {
			id: number;
			resolve: (value: unknown) => void;
			reject: (reason?: unknown) => void;
			timeout: Timer;
		} | null = null;
		const rejectPending = (code: string) => {
			if (pending === null) return;
			const current = pending;
			pending = null;
			clearTimeout(current.timeout);
			current.reject(new Error(code));
		};
		const writeFrame = (opcode: number, payload: Buffer) => {
			if (socket.destroyed) throw new Error("codex_app_server_closed");
			socket.write(maskedFrame(opcode, payload));
		};
		const handleText = (payload: Buffer) => {
			let response: JsonRpcResponse;
			try {
				response = JSON.parse(payload.toString("utf8")) as JsonRpcResponse;
			} catch {
				return;
			}
			if (pending === null || response.id !== pending.id) return;
			const current = pending;
			pending = null;
			clearTimeout(current.timeout);
			if (response.error !== undefined) current.reject(new Error("codex_app_server_request_failed"));
			else current.resolve(response.result);
		};
		const consumeFrames = (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			for (;;) {
				if (buffer.length < 2) return;
				const opcode = buffer[0]! & 0x0f;
				const lengthCode = buffer[1]! & 0x7f;
				let headerLength = 2;
				let length: number;
				if (lengthCode < 126) length = lengthCode;
				else if (lengthCode === 126) {
					if (buffer.length < 4) return;
					length = buffer.readUInt16BE(2);
					headerLength = 4;
				} else {
					if (buffer.length < 10) return;
					const largeLength = buffer.readBigUInt64BE(2);
					if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) {
						socket.destroy();
						return;
					}
					length = Number(largeLength);
					headerLength = 10;
				}
				const masked = (buffer[1]! & 0x80) !== 0;
				const maskLength = masked ? 4 : 0;
				if (buffer.length < headerLength + maskLength + length) return;
				let payload = buffer.subarray(headerLength + maskLength, headerLength + maskLength + length);
				if (masked) {
					const mask = buffer.subarray(headerLength, headerLength + 4);
					payload = Buffer.from(payload);
					for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4]!;
				}
				buffer = buffer.subarray(headerLength + maskLength + length);
				if (opcode === 0x1) handleText(payload);
				else if (opcode === 0x9) writeFrame(0x0a, payload);
			}
		};
		let closing = false;
		socket.on("data", consumeFrames);
		socket.on("error", () => rejectPending("codex_app_server_unavailable"));
		socket.on("close", () => rejectPending(closing ? "codex_app_server_closed" : "codex_app_server_unavailable"));
		if (remaining.length > 0) consumeFrames(remaining);
		const send = (message: Record<string, unknown>) => writeFrame(0x1, Buffer.from(JSON.stringify(message)));
		return {
			request: async (method, params) => {
				if (pending !== null) throw new Error("codex_app_server_request_in_flight");
				const id = nextId++;
				const response = Promise.withResolvers<unknown>();
				const timeout = setTimeout(() => {
					if (pending?.id !== id) return;
					pending = null;
					response.reject(new Error("codex_app_server_timeout"));
				}, requestTimeoutMs);
				pending = { id, ...response, timeout };
				try {
					send({ jsonrpc: "2.0", id, method, params });
				} catch (error) {
					rejectPending(error instanceof Error ? error.message : "codex_app_server_unavailable");
				}
				return response.promise;
			},
			notify: async (method, params) => {
				try {
					send(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
				} catch (error) {
					throw new Error(error instanceof Error ? error.message : "codex_app_server_unavailable");
				}
			},
			close: async () => {
				closing = true;
				rejectPending("codex_app_server_closed");
				if (socket.destroyed) return;
				try {
					writeFrame(0x8, Buffer.alloc(0));
				} catch {}
				socket.destroy();
			},
		};
	};
}

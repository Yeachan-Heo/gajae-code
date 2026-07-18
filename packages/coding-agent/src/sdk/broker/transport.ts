import { createHash, timingSafeEqual } from "node:crypto";
import type { ServerWebSocket } from "bun";
import type { Broker } from "./broker";

const PROTOCOL_VERSION = 3;
/** Maximum UTF-8 byte length accepted for a single broker JSON frame. */
const MAX_BROKER_JSON_FRAME_BYTES = 4 * 1024 * 1024;

const BROKER_OPERATIONS = new Set([
	"session.list",
	"session.get_endpoint",
	"session.create",
	"session.fork",
	"session.resume",
	"session.close",
	"session.delete",
]);
type RequestInput = Record<string, unknown>;
type BrokerRequest = {
	type: "broker_request";
	id?: string;
	operation?: string;
	input?: RequestInput;
	idempotencyKey?: string;
};
function digest(value: string): Buffer {
	return createHash("sha256").update(value).digest();
}
function tokenMatches(expected: string, actual: string | null): boolean {
	return actual !== null && timingSafeEqual(digest(expected), digest(actual));
}
function isInput(value: unknown): value is RequestInput {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function send(socket: ServerWebSocket<unknown>, frame: Record<string, unknown>): void {
	socket.send(JSON.stringify(frame));
}
function sendError(socket: ServerWebSocket<unknown>, id: string | undefined, code: string, message: string): void {
	send(socket, { type: "broker_response", ...(id === undefined ? {} : { id }), ok: false, error: { code, message } });
}
/** Loopback-only WebSocket transport for the agent-global SDK broker. */
export class BrokerTransport {
	readonly #broker: Broker;
	readonly #token: string;
	readonly #requestedPort: number;
	#server: Bun.Server<undefined> | null = null;
	#port = 0;
	constructor(broker: Broker, token: string, port = 0) {
		this.#broker = broker;
		this.#token = token;
		this.#requestedPort = port;
	}
	get port(): number {
		if (!this.#server) throw new Error("Broker transport is not running");
		return this.#port;
	}
	async start(): Promise<number> {
		if (this.#server) return this.#port;
		this.#server = Bun.serve({
			hostname: "127.0.0.1",
			port: this.#requestedPort,
			fetch: request => {
				const url = new URL(request.url);
				if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
					return new Response("Upgrade Required", { status: 426 });
				if (!tokenMatches(this.#token, url.searchParams.get("token")))
					return new Response("Unauthorized", { status: 401 });
				if (!this.#server?.upgrade(request, { data: undefined }))
					return new Response("WebSocket upgrade failed", { status: 400 });
				return undefined;
			},
			websocket: {
				maxPayloadLength: MAX_BROKER_JSON_FRAME_BYTES * 2,
				open: socket => send(socket, { type: "broker_hello", protocolVersion: PROTOCOL_VERSION }),
				message: (socket, message) => void this.#handleMessage(socket, message),
			},
		});
		this.#port = this.#server.port ?? 0;
		return this.#port;
	}
	async stop(): Promise<void> {
		const server = this.#server;
		this.#server = null;
		if (server) await server.stop(true);
	}
	async #handleMessage(socket: ServerWebSocket<unknown>, raw: string | Buffer): Promise<void> {
		if (Buffer.byteLength(raw) > MAX_BROKER_JSON_FRAME_BYTES) {
			sendError(socket, undefined, "payload_too_large", "broker JSON frame exceeds 4 MiB limit");
			return;
		}
		let frame: BrokerRequest;
		try {
			frame = JSON.parse(raw.toString()) as BrokerRequest;
		} catch {
			sendError(socket, undefined, "invalid_input", "malformed JSON");
			return;
		}
		if (frame?.type !== "broker_request") {
			sendError(socket, undefined, "invalid_input", "invalid broker frame");
			return;
		}
		if (typeof frame.id !== "string" || !frame.id) {
			sendError(socket, frame.id, "invalid_input", "request id is required");
			return;
		}
		if (typeof frame.operation !== "string" || !BROKER_OPERATIONS.has(frame.operation)) {
			sendError(socket, frame.id, "unknown_operation", "unknown broker operation");
			return;
		}
		if (frame.input === undefined || !isInput(frame.input)) {
			sendError(socket, frame.id, "invalid_input", "request input must be an object");
			return;
		}
		if (frame.idempotencyKey !== undefined && typeof frame.idempotencyKey !== "string") {
			sendError(socket, frame.id, "invalid_input", "idempotencyKey must be a string");
			return;
		}
		try {
			const result = await this.#broker.handleRequest(frame.operation, frame.input, frame.idempotencyKey);
			send(socket, { type: "broker_response", id: frame.id, ...result });
		} catch {
			sendError(socket, frame.id, "unavailable", "broker request failed");
		}
	}
}

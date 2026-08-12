import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { ServerWebSocket } from "bun";
import {
	MASTER_PROTOCOL_VERSION,
	MAX_MASTER_FRAME_BYTES,
	type MasterClientFrame,
	type MasterErrorCode,
	MasterProtocolError,
	type MasterServerFrame,
	parseMasterJsonFrame,
	parseMasterServerFrame,
	serializeMasterFrame,
} from "./sdk-contract";
import {
	MASTER_SDK_DISCOVERY_VERSION,
	MASTER_SDK_HOST,
	MASTER_SDK_PROTOCOL_VERSION,
	type MasterSdkDiscovery,
	type MasterSdkDiscoveryOptions,
	newMasterSdkToken,
	removeMasterSdkDiscovery,
	writeMasterSdkDiscovery,
} from "./sdk-discovery";
import type { MasterEventFrame, MasterSnapshot, TaskSummary } from "./types";

const DEFAULT_ENDPOINT_PATH = "/master";
const DEFAULT_MAX_RETAINED_EVENTS = 1_024;

type ProviderWorkerIdentity = { provider: "telegram" | "discord"; workerId: string };

type MasterSocketData = {
	connectionId: string;
	subscribed: boolean;
	buffering: boolean;
	bufferedEvents: MasterServerFrame[];
	providerWorker: ProviderWorkerIdentity | null;
};
type MasterSocket = ServerWebSocket<MasterSocketData>;

export interface QueuePageResult {
	masterName: string;
	snapshotCutSeq: number;
	queueRevision: number;
	items: readonly TaskSummary[];
	nextCursor: string | null;
}

export type QueuePageProviderResult =
	| QueuePageResult
	| Extract<MasterServerFrame, { type: "queue_page_resync_required" }>;

export type MasterClientHandlerResult = MasterServerFrame | readonly MasterServerFrame[] | null | undefined;

export interface MasterSdkTransportOptions extends MasterSdkDiscoveryOptions {
	port?: number;
	token?: string;
	endpointPath?: string;
	maxRetainedEvents?: number;
	publishDiscovery?: boolean;
	getSnapshot?: (
		snapshotCutSeq: number,
	) =>
		| Promise<{ masters: readonly MasterSnapshot[]; snapshotCutSeq: number } | readonly MasterSnapshot[]>
		| { masters: readonly MasterSnapshot[]; snapshotCutSeq: number }
		| readonly MasterSnapshot[];
	getQueuePage?: (
		request: Extract<MasterClientFrame, { type: "get_queue_page" }>,
		snapshotCutSeq?: number,
	) => Promise<QueuePageProviderResult> | QueuePageProviderResult;
	handleClientFrame?: (
		frame: MasterClientFrame,
		connectionId: string,
	) => Promise<MasterClientHandlerResult> | MasterClientHandlerResult;
	onClientFrame?: (
		frame: MasterClientFrame,
		connectionId: string,
	) => Promise<MasterClientHandlerResult> | MasterClientHandlerResult;
	/**
	 * Invoked with the exact connection id after its socket closes, so owners of
	 * connection-scoped registrations (e.g. provider workers holding durable
	 * effect leases) can retire them instead of leasing work to a dead socket.
	 */
	onConnectionClosed?: (connectionId: string) => void;
}

export interface MasterSdkTransportState {
	readonly running: boolean;
	readonly port: number;
	readonly url: string | null;
	readonly token: string | null;
	readonly currentSeq: number;
	readonly oldestAvailableSeq: number;
	readonly connectionCount: number;
}

function digest(value: string): Buffer {
	return createHash("sha256").update(value).digest();
}

function tokenMatches(expected: string, actual: string | null): boolean {
	if (actual === null) return false;
	const left = digest(expected);
	const right = digest(actual);
	return timingSafeEqual(left, right);
}

function frameBytes(raw: string | Buffer): number {
	return typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
}

function safeErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : "master SDK request failed";
	return message.length > 2_048 ? message.slice(0, 2_048) : message;
}

function makeConnectionId(): string {
	return `master-connection-${randomUUID()}`;
}

function isServerFrameList(value: MasterClientHandlerResult): value is readonly MasterServerFrame[] {
	return Array.isArray(value);
}

function serverError(requestId: string | null, code: MasterErrorCode, message: string): MasterServerFrame {
	return { type: "error", requestId, code, message: message.length > 2_048 ? message.slice(0, 2_048) : message };
}

export class MasterSdkTransport {
	readonly #options: MasterSdkTransportOptions;
	readonly #clients = new Map<string, MasterSocket>();
	readonly #events: MasterServerFrame[] = [];
	#server: Bun.Server<MasterSocketData> | null = null;
	#port = 0;
	#token: string | null = null;
	#discovery: MasterSdkDiscovery | null = null;
	#stopping = false;

	constructor(options: MasterSdkTransportOptions = {}) {
		this.#options = options;
	}

	get state(): MasterSdkTransportState {
		return {
			running: this.#server !== null,
			port: this.#port,
			url: this.#discovery?.url ?? null,
			token: this.#token,
			currentSeq: this.currentSeq,
			oldestAvailableSeq: this.oldestAvailableSeq,
			connectionCount: this.#clients.size,
		};
	}

	get server(): Bun.Server<MasterSocketData> | null {
		return this.#server;
	}

	get port(): number {
		if (!this.#server) throw new Error("master SDK transport is not running");
		return this.#port;
	}

	get token(): string {
		if (!this.#token) throw new Error("master SDK transport is not running");
		return this.#token;
	}

	get url(): string {
		if (!this.#discovery) throw new Error("master SDK transport is not running");
		return this.#discovery.url;
	}

	get currentSeq(): number {
		return this.#events.reduce((maximum, frame) => {
			if (
				frame.type === "queue_updated" ||
				frame.type === "ownership_updated" ||
				frame.type === "decision_logged" ||
				frame.type === "memory_activity" ||
				frame.type === "master_status" ||
				frame.type === "channel_updated"
			)
				return Math.max(maximum, frame.seq);
			return maximum;
		}, 0);
	}

	get oldestAvailableSeq(): number {
		const event = this.#events.find(
			frame =>
				frame.type === "queue_updated" ||
				frame.type === "ownership_updated" ||
				frame.type === "decision_logged" ||
				frame.type === "memory_activity" ||
				frame.type === "master_status" ||
				frame.type === "channel_updated",
		);
		return event && "seq" in event ? event.seq : this.currentSeq + 1;
	}

	async start(): Promise<MasterSdkDiscovery> {
		if (this.#server && this.#discovery) return this.#discovery;
		if (this.#stopping) throw new Error("master SDK transport is stopping");
		const token = this.#options.token ?? newMasterSdkToken();
		const endpointPath = this.#options.endpointPath ?? DEFAULT_ENDPOINT_PATH;
		if (!endpointPath.startsWith("/") || endpointPath.includes("?"))
			throw new Error("master SDK endpoint path must be an absolute path");
		this.#token = token;
		const requestedPort = this.#options.port ?? 0;
		this.#server = Bun.serve<MasterSocketData>({
			hostname: MASTER_SDK_HOST,
			port: requestedPort,
			fetch: request => {
				const url = new URL(request.url);
				if (url.pathname !== endpointPath) return new Response("Not Found", { status: 404 });
				if (!tokenMatches(token, url.searchParams.get("token")))
					return new Response("Unauthorized", { status: 401 });
				if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
					return new Response("Upgrade Required", { status: 426 });
				const connectionId = makeConnectionId();
				if (
					!this.#server?.upgrade(request, {
						data: { connectionId, subscribed: false, buffering: false, bufferedEvents: [], providerWorker: null },
					})
				)
					return new Response("WebSocket upgrade failed", { status: 400 });
				return undefined;
			},
			websocket: {
				maxPayloadLength: MAX_MASTER_FRAME_BYTES,
				open: socket => {
					this.#clients.set(socket.data.connectionId, socket);
					this.#send(socket, {
						type: "hello",
						protocolVersion: MASTER_PROTOCOL_VERSION,
						connectionId: socket.data.connectionId,
						capabilities: ["master-sdk-v1"],
					});
				},
				message: (socket, message) => void this.#handleMessage(socket, message),
				close: socket => {
					this.#clients.delete(socket.data.connectionId);
					this.#options.onConnectionClosed?.(socket.data.connectionId);
				},
			},
		});
		this.#port = this.#server.port ?? 0;
		const startedAt = new Date().toISOString();
		this.#discovery = {
			version: MASTER_SDK_DISCOVERY_VERSION,
			protocolVersion: MASTER_SDK_PROTOCOL_VERSION,
			url: `ws://${MASTER_SDK_HOST}:${this.#port}${endpointPath}`,
			token,
			pid: process.pid,
			startedAt,
			heartbeatAt: startedAt,
		};
		if (this.#options.publishDiscovery !== false) await writeMasterSdkDiscovery(this.#discovery, this.#options);
		return this.#discovery;
	}

	async stop(): Promise<void> {
		if (this.#stopping) return;
		this.#stopping = true;
		const server = this.#server;
		const discovery = this.#discovery;
		this.#server = null;
		for (const socket of this.#clients.values()) socket.terminate();
		this.#clients.clear();
		if (server) void server.stop(true);
		if (discovery && this.#options.publishDiscovery !== false)
			await removeMasterSdkDiscovery(this.#options, discovery);
		this.#discovery = null;
		this.#token = null;
		this.#port = 0;
		this.#stopping = false;
	}

	async close(): Promise<void> {
		await this.stop();
	}

	publishEvent(event: MasterEventFrame): void {
		const parsed = parseMasterServerFrame(event);
		const expectedSeq = this.currentSeq + 1;
		if (event.seq !== expectedSeq)
			throw new MasterProtocolError(
				`master event sequence must be contiguous: expected ${expectedSeq}, got ${event.seq}`,
			);
		this.#events.push(parsed);
		const maxRetained = Math.max(1, this.#options.maxRetainedEvents ?? DEFAULT_MAX_RETAINED_EVENTS);
		while (this.#events.length > maxRetained) this.#events.shift();
		for (const socket of this.#clients.values()) {
			if (socket.data.subscribed) {
				if (socket.data.buffering) socket.data.bufferedEvents.push(parsed);
				else this.#send(socket, parsed);
			}
		}
	}

	appendEvent(event: MasterEventFrame): void {
		this.publishEvent(event);
	}

	retainedEvents(): readonly MasterServerFrame[] {
		return [...this.#events];
	}

	registerProviderConnection(connectionId: string, provider: "telegram" | "discord", workerId: string): void {
		const socket = this.#clients.get(connectionId);
		if (!socket) throw new Error("master SDK provider connection is not active");
		socket.data.providerWorker = { provider, workerId };
	}

	clearProviderConnection(connectionId: string): void {
		const socket = this.#clients.get(connectionId);
		if (socket) socket.data.providerWorker = null;
	}

	sendToConnection(connectionId: string, frame: MasterServerFrame): boolean {
		const socket = this.#clients.get(connectionId);
		if (!socket) return false;
		this.#send(socket, frame);
		return true;
	}

	sendProviderEffect(
		connectionId: string,
		effect: Extract<MasterServerFrame, { type: "provider_effect" }>["effect"],
	): boolean {
		const socket = this.#clients.get(connectionId);
		if (!socket || socket.data.providerWorker === null) return false;
		this.#send(socket, { type: "provider_effect", effect });
		return true;
	}

	async #handleMessage(socket: MasterSocket, raw: string | Buffer): Promise<void> {
		if (this.#stopping) {
			this.#send(socket, serverError(null, "server_unavailable", "master SDK transport is stopping"));
			return;
		}
		if (frameBytes(raw) > MAX_MASTER_FRAME_BYTES) {
			this.#send(socket, serverError(null, "invalid_frame", "master frame exceeds 262144 UTF-8 bytes"));
			return;
		}
		let frame: MasterClientFrame;
		try {
			frame = parseMasterJsonFrame(
				typeof raw === "string" ? raw : raw.toString("utf8"),
				"client",
			) as MasterClientFrame;
		} catch {
			this.#send(socket, serverError(null, "invalid_frame", "invalid master client frame"));
			return;
		}
		try {
			const replies = await this.#handleFrame(socket, frame);
			for (const reply of replies) this.#send(socket, reply);
			socket.data.buffering = false;
			socket.data.bufferedEvents = [];
		} catch (error) {
			socket.data.buffering = false;
			socket.data.bufferedEvents = [];
			this.#send(
				socket,
				serverError("requestId" in frame ? frame.requestId : null, "server_unavailable", safeErrorMessage(error)),
			);
		}
	}

	async #handleFrame(socket: MasterSocket, frame: MasterClientFrame): Promise<readonly MasterServerFrame[]> {
		if (frame.type === "ping") return [{ type: "pong", requestId: frame.requestId, nonce: frame.nonce }];
		if (frame.type === "subscribe") {
			await this.#subscribe(socket, frame);
			return [];
		}
		if (frame.type === "get_snapshot") return [await this.#snapshotFrame(frame.requestId)];
		if (frame.type === "get_queue_page") return [await this.#queuePageFrame(frame)];
		const handler = this.#options.handleClientFrame ?? this.#options.onClientFrame;
		if (!handler)
			return [
				serverError(frame.requestId, "server_unavailable", "master SDK durable mutation handler is not configured"),
			];
		const result = await handler(frame, socket.data.connectionId);
		if (result === null || result === undefined)
			return [serverError(frame.requestId, "server_unavailable", "master SDK handler did not return a response")];
		return isServerFrameList(result) ? result : [result];
	}

	async #subscribe(socket: MasterSocket, frame: Extract<MasterClientFrame, { type: "subscribe" }>): Promise<void> {
		const highWaterSeq = this.currentSeq;
		if (frame.afterSeq !== undefined) {
			if (
				frame.afterSeq > highWaterSeq ||
				(this.#events.length > 0 && frame.afterSeq < this.oldestAvailableSeq - 1)
			) {
				this.#send(socket, {
					type: "resync_required",
					requestId: frame.requestId,
					requestedAfterSeq: frame.afterSeq,
					oldestAvailableSeq: Math.min(this.oldestAvailableSeq, highWaterSeq),
					currentSeq: highWaterSeq,
					reason: frame.afterSeq > highWaterSeq ? "invalid_cursor" : "replay_gap",
				});
				return;
			}
			const replay = this.#events.filter(
				event => "seq" in event && event.seq > frame.afterSeq! && event.seq <= highWaterSeq,
			);
			socket.data.subscribed = true;
			socket.data.buffering = true;
			socket.data.bufferedEvents = [];
			this.#send(socket, { type: "subscription_ready", requestId: frame.requestId, mode: "replay", highWaterSeq });
			for (const event of replay) this.#send(socket, event);
			while (socket.data.bufferedEvents.length > 0) {
				for (const event of socket.data.bufferedEvents.splice(0)) this.#send(socket, event);
			}
			socket.data.buffering = false;
			return;
		}

		// Mark the connection subscribed before awaiting the snapshot so every event
		// after the advertised cut is retained for the live tail.
		socket.data.subscribed = true;
		socket.data.buffering = true;
		socket.data.bufferedEvents = [];
		const snapshot = await this.#snapshotFrame(frame.requestId, highWaterSeq);
		if (snapshot.type !== "master_snapshot") {
			socket.data.buffering = false;
			socket.data.bufferedEvents = [];
			this.#send(socket, snapshot);
			return;
		}
		const snapshotHighWater = snapshot.snapshotCutSeq;
		this.#send(socket, {
			type: "subscription_ready",
			requestId: frame.requestId,
			mode: "snapshot",
			highWaterSeq: snapshotHighWater,
		});
		this.#send(socket, snapshot);
		while (socket.data.bufferedEvents.length > 0) {
			const events = socket.data.bufferedEvents
				.splice(0)
				.filter(event => "seq" in event && event.seq > snapshotHighWater);
			for (const event of events) this.#send(socket, event);
		}
		socket.data.buffering = false;
	}

	async #snapshotFrame(requestId: string, cut = this.currentSeq): Promise<MasterServerFrame> {
		const provider = this.#options.getSnapshot;
		if (!provider)
			return serverError(requestId, "server_unavailable", "Durable master snapshot handler is not configured.");
		const result = await provider(cut);
		const snapshotResult = Array.isArray(result)
			? null
			: (result as { masters: readonly MasterSnapshot[]; snapshotCutSeq: number });
		const masters = snapshotResult?.masters ?? (result as readonly MasterSnapshot[]);
		const snapshotCutSeq = snapshotResult?.snapshotCutSeq ?? this.currentSeq;
		return parseMasterServerFrame({
			type: "master_snapshot",
			protocolVersion: MASTER_PROTOCOL_VERSION,
			requestId,
			snapshotCutSeq,
			generatedAt: new Date().toISOString(),
			masters,
		});
	}

	async #queuePageFrame(frame: Extract<MasterClientFrame, { type: "get_queue_page" }>): Promise<MasterServerFrame> {
		const provider = this.#options.getQueuePage;
		const cut = this.currentSeq;
		if (!provider)
			return serverError(frame.requestId, "server_unavailable", "Durable queue page handler is not configured.");
		const page = await provider(frame, cut);
		if ("reason" in page) return parseMasterServerFrame({ ...page, requestId: frame.requestId });
		return parseMasterServerFrame({
			type: "queue_page",
			requestId: frame.requestId,
			masterName: page.masterName,
			snapshotCutSeq: page.snapshotCutSeq,
			queueRevision: page.queueRevision,
			items: page.items,
			nextCursor: page.nextCursor,
		});
	}

	#send(socket: MasterSocket, frame: MasterServerFrame): void {
		try {
			socket.send(serializeMasterFrame(frame, "server"));
		} catch {
			socket.close(1002, "invalid server frame");
		}
	}
}

export const MasterSdkServer = MasterSdkTransport;
export const MasterSdkEndpoint = MasterSdkTransport;

export async function createMasterSdkTransport(options: MasterSdkTransportOptions = {}): Promise<MasterSdkTransport> {
	const transport = new MasterSdkTransport(options);
	await transport.start();
	return transport;
}

export interface MasterSdkClientOptions {
	url: string;
	token: string;
	WebSocket?: typeof WebSocket;
}

interface PendingRequest {
	resolve: (frame: MasterServerFrame) => void;
	reject: (error: Error) => void;
}

export class MasterSdkClient {
	readonly #socket: WebSocket;
	readonly #pending = new Map<string, PendingRequest>();
	readonly #listeners = new Set<(frame: MasterServerFrame) => void>();
	readonly #hello: Promise<Extract<MasterServerFrame, { type: "hello" }>>;
	#helloResolve: ((frame: Extract<MasterServerFrame, { type: "hello" }>) => void) | null = null;
	#helloReject: ((error: Error) => void) | null = null;
	#closed = false;

	constructor(options: MasterSdkClientOptions) {
		const WebSocketConstructor = options.WebSocket ?? WebSocket;
		const url = new URL(options.url);
		url.searchParams.set("token", options.token);
		this.#socket = new WebSocketConstructor(url.toString());
		const hello = Promise.withResolvers<Extract<MasterServerFrame, { type: "hello" }>>();
		this.#hello = hello.promise;
		this.#helloResolve = hello.resolve;
		this.#helloReject = hello.reject;
		this.#socket.onmessage = event =>
			this.#onMessage(typeof event.data === "string" ? event.data : String(event.data));
		this.#socket.onerror = () => this.#fail(new Error("master SDK websocket error"));
		this.#socket.onclose = () => this.#fail(new Error("master SDK websocket closed"));
	}

	static async connect(options: MasterSdkClientOptions): Promise<MasterSdkClient> {
		const client = new MasterSdkClient(options);
		await client.ready();
		return client;
	}

	async ready(): Promise<Extract<MasterServerFrame, { type: "hello" }>> {
		return this.#hello;
	}

	onFrame(listener: (frame: MasterServerFrame) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async send(frame: MasterClientFrame): Promise<void> {
		if (this.#closed) throw new Error("master SDK client is closed");
		await this.ready();
		this.#socket.send(serializeMasterFrame(frame, "client"));
	}

	async request(frame: MasterClientFrame): Promise<MasterServerFrame> {
		const requestId = "requestId" in frame ? frame.requestId : null;
		if (requestId === null) throw new Error("master SDK request requires requestId");
		const response = Promise.withResolvers<MasterServerFrame>();
		this.#pending.set(requestId, { resolve: response.resolve, reject: response.reject });
		try {
			await this.send(frame);
			return await response.promise;
		} finally {
			this.#pending.delete(requestId);
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#socket.terminate();
		this.#fail(new Error("master SDK client closed"));
	}

	async subscribe(requestId: string, afterSeq?: number): Promise<MasterServerFrame> {
		return this.request({ type: "subscribe", requestId, ...(afterSeq === undefined ? {} : { afterSeq }) });
	}

	async getSnapshot(requestId: string): Promise<MasterServerFrame> {
		return this.request({ type: "get_snapshot", requestId });
	}

	async getQueuePage(
		requestId: string,
		masterName: string,
		cursor: string | null,
		limit: number,
	): Promise<MasterServerFrame> {
		return this.request({ type: "get_queue_page", requestId, masterName, cursor, limit });
	}

	async ping(requestId: string, value: string): Promise<MasterServerFrame> {
		return this.request({ type: "ping", requestId, nonce: value });
	}

	#onMessage(raw: string): void {
		let frame: MasterServerFrame;
		try {
			frame = parseMasterJsonFrame(raw, "server") as MasterServerFrame;
		} catch {
			this.#fail(new Error("invalid master server frame"));
			return;
		}
		if (frame.type === "hello") {
			this.#helloResolve?.(frame);
			this.#helloResolve = null;
			this.#helloReject = null;
		}
		if ("requestId" in frame && frame.requestId !== null) {
			const pending = this.#pending.get(frame.requestId);
			if (pending) pending.resolve(frame);
		}
		for (const listener of this.#listeners) listener(frame);
	}

	#fail(error: Error): void {
		this.#helloReject?.(error);
		this.#helloResolve = null;
		this.#helloReject = null;
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}
}

export async function connectMasterSdkClient(options: MasterSdkClientOptions): Promise<MasterSdkClient> {
	return MasterSdkClient.connect(options);
}

export const connectMasterSdkTransport = connectMasterSdkClient;

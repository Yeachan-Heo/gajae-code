import type { Readable, Writable } from "node:stream";

export const REQUEST_FRAME_BYTES = 256 * 1024;
export const DEFAULT_PENDING_CEILING_BYTES = 8 * 1024 * 1024;
export const MIN_PENDING_CEILING_BYTES = REQUEST_FRAME_BYTES;

export type RelayDirection = "downstream->ws" | "ws->downstream";
export type TransportError = {
	type: "transport_error";
	code: "frame_oversize" | "pending_overflow" | "protocol_error";
	direction?: RelayDirection;
};

export type RelayPair = {
	close(): Promise<void>;
	readonly done: Promise<void>;
};

export class RelayOpenAbortedError extends Error {
	constructor() {
		super("relay_open_aborted");
		this.name = "RelayOpenAbortedError";
	}
}

export type RelayWebSocketEvent = { data?: unknown };

export type RelayWebSocket = {
	readonly bufferedAmount: number;
	readonly readyState: number;
	close(): void;
	send(data: string): void;
	addEventListener(type: string, listener: (event: RelayWebSocketEvent) => void, options?: { once?: boolean }): void;
	removeEventListener(type: string, listener: (event: RelayWebSocketEvent) => void): void;
};

export type RelayOptions = {
	url: string;
	token: string;
	pendingCeilingBytes: number;
	downstream: Readable;
	downstreamSink: Writable;
	initialDownstreamBytes?: Buffer;
	onTransportError: (error: TransportError) => void;
	webSocketFactory?: (url: string) => RelayWebSocket;
	signal?: AbortSignal;
	validateDownstreamFrame?: (frame: string) => boolean;
};

type QueuedFrame = { bytes: Buffer; accounted: boolean };

function upstreamUrl(url: string, token: string): string {
	const endpoint = new URL(url);
	endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/`;
	endpoint.searchParams.set("token", token);
	return endpoint.toString();
}

function waitForDrain(stream: Writable): { promise: Promise<void>; cancel: () => void } {
	const { promise, reject, resolve } = Promise.withResolvers<void>();
	let settled = false;
	const onDrain = (): void => done(resolve);
	const onError = (error: Error): void => done(() => reject(error));
	const onClose = (): void => done(() => reject(new Error("downstream_closed")));
	const done = (callback: () => void): void => {
		if (settled) return;
		settled = true;
		stream.removeListener("drain", onDrain);
		stream.removeListener("error", onError);
		stream.removeListener("close", onClose);
		callback();
	};
	stream.once("drain", onDrain);
	stream.once("error", onError);
	stream.once("close", onClose);
	if (stream.destroyed) onClose();
	return { promise, cancel: onDrain };
}

const WEBSOCKET_CONNECTING = 0;
const WEBSOCKET_OPEN = 1;

function waitForWebSocketDrain(ws: RelayWebSocket, isClosed: () => boolean): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const poll = (): void => {
		if (isClosed() || ws.readyState !== WEBSOCKET_OPEN || ws.bufferedAmount === 0) {
			resolve();
			return;
		}
		setTimeout(poll, 10);
	};
	poll();
	return promise;
}

/** Starts a dedicated raw-WebSocket relay for exactly one downstream stream. */
export async function startRelayPair(options: RelayOptions): Promise<RelayPair> {
	if (options.signal?.aborted) throw new RelayOpenAbortedError();
	const ws: RelayWebSocket =
		options.webSocketFactory?.(upstreamUrl(options.url, options.token)) ??
		new WebSocket(upstreamUrl(options.url, options.token));
	const opened = Promise.withResolvers<void>();
	const finished = Promise.withResolvers<void>();
	let closed = false;
	let completed = false;
	let downstreamChunks: Buffer[] = [];
	let downstreamBytes = 0;
	let downstreamDrain: { promise: Promise<void>; cancel: () => void } | undefined;
	const toWs: QueuedFrame[] = [];
	const toDownstream: QueuedFrame[] = [];
	let pendingToWs = 0;
	let pendingToDownstream = 0;
	let writingWs = false;
	let writingDownstream = false;

	const settle = (error?: Error): void => {
		if (completed) return;
		completed = true;
		if (error) finished.reject(error);
		else finished.resolve();
	};
	void finished.promise.catch(() => undefined);
	const detach = (): void => {
		options.downstream.removeListener("data", onData);
		options.downstream.removeListener("end", onEnd);
		options.downstream.removeListener("error", onDownstreamError);
		ws.removeEventListener("message", onMessage);
		ws.removeEventListener("close", onClose);
		ws.removeEventListener("error", onWebSocketError);
		cleanupOpening();
	};
	const close = async (error?: Error): Promise<void> => {
		if (closed) return finished.promise.catch(() => undefined);
		closed = true;
		downstreamDrain?.cancel();
		detach();
		options.downstream.pause();
		if (ws.readyState === WEBSOCKET_OPEN || ws.readyState === WEBSOCKET_CONNECTING) ws.close();
		settle(error);
		return await finished.promise.catch(() => undefined);
	};
	const fail = (transportError: TransportError): void => {
		if (closed) return;
		options.onTransportError(transportError);
		void close(new Error(transportError.code));
	};
	const enqueue = (queue: QueuedFrame[], direction: RelayDirection, bytes: Buffer): void => {
		const isWsDirection = direction === "downstream->ws";
		const active = isWsDirection ? writingWs : writingDownstream;
		const pending = isWsDirection ? pendingToWs : pendingToDownstream;
		if (active && pending + bytes.length > options.pendingCeilingBytes) {
			fail({ type: "transport_error", code: "pending_overflow", direction });
			return;
		}
		queue.push({ bytes, accounted: active });
		if (active) {
			if (isWsDirection) pendingToWs += bytes.length;
			else pendingToDownstream += bytes.length;
		}
		if (isWsDirection) void pumpWs();
		else void pumpDownstream();
	};
	const pumpWs = async (): Promise<void> => {
		if (writingWs || closed) return;
		const frame = toWs.shift();
		if (!frame) return;
		writingWs = true;
		if (frame.accounted) pendingToWs -= frame.bytes.length;
		try {
			if (ws.readyState !== WEBSOCKET_OPEN) throw new Error("upstream_closed");
			ws.send(frame.bytes.toString("utf8"));
			await waitForWebSocketDrain(ws, () => closed);
		} catch (error) {
			await close(error instanceof Error ? error : new Error(String(error)));
			return;
		} finally {
			writingWs = false;
		}
		void pumpWs();
	};
	const pumpDownstream = async (): Promise<void> => {
		if (writingDownstream || closed) return;
		const frame = toDownstream.shift();
		if (!frame) return;
		writingDownstream = true;
		if (frame.accounted) pendingToDownstream -= frame.bytes.length;
		try {
			if (!options.downstreamSink.write(frame.bytes) && !closed) {
				downstreamDrain = waitForDrain(options.downstreamSink);
				await downstreamDrain.promise;
			}
		} catch (error) {
			await close(error instanceof Error ? error : new Error(String(error)));
			return;
		} finally {
			downstreamDrain = undefined;
			writingDownstream = false;
		}
		void pumpDownstream();
	};
	const consumeLines = (chunk: Buffer): void => {
		let start = 0;
		let newline = chunk.indexOf(0x0a);
		while (newline >= 0) {
			const length = downstreamBytes + newline - start;
			if (length === 0)
				return fail({ type: "transport_error", code: "protocol_error", direction: "downstream->ws" });
			if (length > REQUEST_FRAME_BYTES)
				return fail({ type: "transport_error", code: "frame_oversize", direction: "downstream->ws" });
			downstreamChunks.push(chunk.subarray(start, newline));
			const line = Buffer.concat(downstreamChunks, length);
			downstreamChunks = [];
			downstreamBytes = 0;
			if (options.validateDownstreamFrame && !options.validateDownstreamFrame(line.toString("utf8")))
				return fail({ type: "transport_error", code: "protocol_error", direction: "downstream->ws" });
			enqueue(toWs, "downstream->ws", line);
			if (closed) return;
			start = newline + 1;
			newline = chunk.indexOf(0x0a, start);
		}
		if (start < chunk.length) {
			downstreamBytes += chunk.length - start;
			if (downstreamBytes > REQUEST_FRAME_BYTES)
				return fail({ type: "transport_error", code: "frame_oversize", direction: "downstream->ws" });
			downstreamChunks.push(chunk.subarray(start));
		}
	};
	const onData = (chunk: Buffer | string): void => consumeLines(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	const onEnd = (): void => void close();
	const onDownstreamError = (error: Error): void => void close(error);
	const onMessage = (event: RelayWebSocketEvent): void => {
		if (typeof event.data !== "string") {
			fail({ type: "transport_error", code: "protocol_error", direction: "ws->downstream" });
			return;
		}
		enqueue(toDownstream, "ws->downstream", Buffer.concat([Buffer.from(event.data, "utf8"), Buffer.from("\n")]));
	};
	const onClose = (): void => void close();
	const onWebSocketError = (): void => void close(new Error("upstream_error"));
	const onOpen = (): void => {
		cleanupOpening();
		opened.resolve();
	};
	const onOpenError = (): void => {
		cleanupOpening();
		opened.reject(new Error("upstream_error"));
	};
	const onAbort = (): void => {
		const error = new RelayOpenAbortedError();
		cleanupOpening();
		opened.reject(error);
		void close(error);
	};
	const cleanupOpening = (): void => {
		ws.removeEventListener("open", onOpen);
		ws.removeEventListener("error", onOpenError);
		options.signal?.removeEventListener("abort", onAbort);
	};
	ws.addEventListener("open", onOpen, { once: true });
	ws.addEventListener("error", onOpenError, { once: true });
	options.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		await opened.promise;
	} catch (error) {
		await close(error instanceof Error ? error : new Error(String(error)));
		throw error;
	}
	ws.addEventListener("message", onMessage);
	ws.addEventListener("close", onClose);
	ws.addEventListener("error", onWebSocketError);
	options.downstream.on("data", onData);
	options.downstream.once("end", onEnd);
	options.downstream.once("error", onDownstreamError);
	if (options.initialDownstreamBytes?.length) consumeLines(options.initialDownstreamBytes);
	if (!closed) options.downstream.resume();
	return { close: () => close(), done: finished.promise };
}

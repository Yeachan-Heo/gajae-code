// app-server production assembly: one shared runtime and per-transport connections.
import { logger } from "@gajae-code/utils";
import { serverNotifications } from "./protocol-source/catalogs.generated";
import { experimentalValidators, stableValidators } from "./protocol-source/schema-validators.generated";
import { ConnectionState } from "./router/connection-state";
import { shouldEmitNotification } from "./router/dispatch";
import { type InboundContext, type InboundResult, processInbound } from "./server";
import { ServerRequestBroker } from "./server-requests/broker";
import { ConnectionRegistry, ThreadSubscriptionIndex } from "./subscriptions";
import { HandlerRegistry, registerBuiltinHandlers } from "./suites/handlers";
import { type AdmissionConfig, ThreadRuntimeManager } from "./thread-runtime/thread-runtime-manager";
import { BoundedOutboundQueue } from "./transport/connection";
import { encodeMessage, type FrameCodecOptions } from "./transport/framing";

export type AppServerTransport = "stdio" | "websocket" | "unix";
export type AppServerWriter = (frame: Uint8Array) => Promise<void> | void;
export type AppServerRejectedFrameHandler = (reason: "malformed" | "oversize") => void;

export interface AppServerConnection {
	readonly id: string;
	readonly state: ConnectionState;
	process(line: Uint8Array): Promise<void>;
	close(): Promise<void>;
}

export interface AppServerRuntime {
	readonly manager: ThreadRuntimeManager;
	readonly registry: HandlerRegistry;
	readonly subscriptions: ThreadSubscriptionIndex;
	readonly broker: ServerRequestBroker;
	createConnection(
		writer: AppServerWriter,
		transport?: AppServerTransport,
		onRejectedFrame?: AppServerRejectedFrameHandler,
	): AppServerConnection;
}

export interface AppServer {
	readonly state: ConnectionState;
	readonly manager: ThreadRuntimeManager;
	readonly registry: HandlerRegistry;
	process: (line: Uint8Array, transport?: AppServerTransport) => Promise<InboundResult>;
}

class Runtime implements AppServerRuntime {
	readonly manager: ThreadRuntimeManager;
	readonly registry = new HandlerRegistry();
	readonly subscriptions = new ThreadSubscriptionIndex();
	readonly broker = new ServerRequestBroker();
	readonly #connections = new Map<string, Connection>();
	readonly #connectionRegistry = new ConnectionRegistry();
	readonly #frameCodec: FrameCodecOptions | undefined;
	#nextConnectionId = 1;
	readonly #serverNotificationStability = new Map<string, "stable" | "experimental">(
		serverNotifications.map(({ method, stability }) => [method, stability]),
	);
	#nextRequestId = 1;

	constructor(config: Partial<AdmissionConfig>, frameCodec?: FrameCodecOptions) {
		this.manager = new ThreadRuntimeManager(config);
		this.#frameCodec = frameCodec;
		registerBuiltinHandlers(this.registry);
	}

	createConnection(
		writer: AppServerWriter,
		transport: AppServerTransport = "websocket",
		onRejectedFrame?: AppServerRejectedFrameHandler,
	): AppServerConnection {
		const id = `connection-${this.#nextConnectionId++}`;
		const connection = new Connection(this, id, writer, transport, this.#frameCodec, onRejectedFrame);
		this.#connections.set(id, connection);
		this.#connectionRegistry.register(id);
		return connection;
	}

	removeConnection(id: string): void {
		this.#connections.delete(id);
		this.#connectionRegistry.unregister(id);
		this.subscriptions.handleDisconnect(id);
		this.broker.handleDisconnect(id);
	}

	contextFor(connection: Connection, deferred: Array<() => Promise<void>>): InboundContext {
		const active = (): boolean => this.#connections.get(connection.id) === connection && connection.active;
		const queueMessage = (connectionId: string, message: Record<string, unknown>): void => {
			if (!active()) return;
			deferred.push(async () => {
				if (!active()) return;
				await this.#connections.get(connectionId)?.enqueueMessage(message);
			});
		};
		return {
			connectionId: connection.id,
			broker: this.broker,
			subscribe: threadId => {
				if (active()) this.subscriptions.subscribe(connection.id, threadId);
			},
			respond: () => {},
			emitTo: (connectionId, method, params) => {
				const target = this.#connections.get(connectionId);
				const stability = this.#serverNotificationStability.get(method);
				const validators = target?.state.capabilities?.experimentalApi ? experimentalValidators : stableValidators;
				// Invalid outbound notifications are logged and not emitted; capability eligibility
				// alone does not prove that a payload is safe for the receiving profile.
				if (!validators.serverNotificationParams[method]?.(params)) {
					logger.warn("Dropping invalid app-server notification", { connectionId, method });
					return;
				}
				if (target?.active && stability && shouldEmitNotification(target.state, method, stability))
					queueMessage(connectionId, { method, params });
			},
			broadcastThread: (threadId, method, params) => {
				if (!active()) return;
				const stability = this.#serverNotificationStability.get(method);
				if (!stability) return;
				for (const connectionId of this.subscriptions.getSubscribers(threadId)) {
					const target = this.#connections.get(connectionId);
					const validators = target?.state.capabilities?.experimentalApi
						? experimentalValidators
						: stableValidators;
					if (!validators.serverNotificationParams[method]?.(params)) {
						logger.warn("Dropping invalid app-server notification", { connectionId, method });
						continue;
					}
					if (target?.active && shouldEmitNotification(target.state, method, stability))
						queueMessage(connectionId, { method, params });
				}
			},
			requestClient: (threadId, method, params) => {
				if (!active()) return undefined;
				const eligible = new Set(
					[...this.subscriptions.getSubscribers(threadId)].filter(id => this.#connections.get(id)?.active),
				);
				// A server request is atomic across eligible clients. Reject it before creating a
				// broker entry when its params are invalid for any recipient's negotiated profile.
				for (const connectionId of eligible) {
					const target = this.#connections.get(connectionId)!;
					const validators = target.state.capabilities?.experimentalApi
						? experimentalValidators
						: stableValidators;
					if (!validators.serverRequestParams[method]?.(params)) {
						logger.warn("Dropping invalid app-server server request", { connectionId, method });
						return undefined;
					}
				}
				const id = `server-${this.#nextRequestId++}`;
				const request = this.broker.create(id, method, params, threadId, eligible);
				if (!request) return undefined;
				for (const connectionId of request.eligibleConnections) queueMessage(connectionId, { id, method, params });
				return id;
			},
		};
	}
}

class Connection implements AppServerConnection {
	readonly state = new ConnectionState();
	readonly #queue: BoundedOutboundQueue;
	#inbound: Promise<void> = Promise.resolve();
	#closed = false;
	#closePromise: Promise<void> | undefined;

	get active(): boolean {
		return !this.#closed;
	}
	readonly #runtime: Runtime;
	readonly #transport: AppServerTransport;
	readonly #frameCodec: FrameCodecOptions | undefined;
	readonly #onRejectedFrame: AppServerRejectedFrameHandler | undefined;

	constructor(
		runtime: Runtime,
		readonly id: string,
		writer: AppServerWriter,
		transport: AppServerTransport,
		frameCodec: FrameCodecOptions | undefined,
		onRejectedFrame: AppServerRejectedFrameHandler | undefined,
	) {
		this.#runtime = runtime;
		this.#transport = transport;
		this.#frameCodec = frameCodec;
		this.#onRejectedFrame = onRejectedFrame;
		this.#queue = new BoundedOutboundQueue({
			send: async frame => {
				await writer(frame);
			},
		});
	}

	process(line: Uint8Array): Promise<void> {
		const processing = this.#inbound.then(() => this.#process(line));
		this.#inbound = processing.catch(() => {});
		return processing;
	}

	async #process(line: Uint8Array): Promise<void> {
		if (this.#closed) return;
		const deferred: Array<() => Promise<void>> = [];
		const result = await processInbound(
			this.state,
			this.#runtime.manager,
			line,
			this.#frameCodec,
			this.#transport,
			this.#runtime.registry,
			this.#runtime.contextFor(this, deferred),
		);
		// A rejected frame (malformed, or oversize on a framed transport) is a protocol
		// violation the peer cannot recover from mid-stream: the wire behaviour stays
		// "no response", but the connection is closed rather than silently continuing.
		if (result.rejected) {
			this.#onRejectedFrame?.(result.rejected);
			void this.close();
			return;
		}
		// Publish the response first. Handler-originated notifications are intentionally held
		// behind this barrier so no request can be observed after its own side effects.
		if (result.response && !this.#closed) await this.#queue.enqueue(result.response);
		for (const publish of deferred) {
			if (this.#closed) return;
			await publish();
		}
	}

	async enqueueMessage(message: Record<string, unknown>): Promise<void> {
		if (this.#closed) return;
		const frame = encodeMessage(message);
		await this.#queue.enqueue(this.#transport === "stdio" ? new Uint8Array([...frame, 10]) : frame);
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closePromise = this.#close();
		return this.#closePromise;
	}

	async #close(): Promise<void> {
		this.#closed = true;
		this.#runtime.removeConnection(this.id);
		await this.#inbound;
		await this.#queue.close();
	}
}

/** Construct one shared runtime for a process/listener. */
export function createAppServerRuntime(
	config: Partial<AdmissionConfig> = {},
	frameCodec?: FrameCodecOptions,
): AppServerRuntime {
	return new Runtime(config, frameCodec);
}

/**
 * Compatibility shim for callers that need a single in-memory connection.
 * Production transports use createAppServerRuntime().createConnection().
 */
export function createAppServer(config: Partial<AdmissionConfig> = {}, frameCodec?: FrameCodecOptions): AppServer {
	const runtime = createAppServerRuntime(config, frameCodec);
	const state = new ConnectionState();
	return {
		state,
		manager: runtime.manager,
		registry: runtime.registry,
		process: (line, transport = "websocket") =>
			processInbound(state, runtime.manager, line, frameCodec, transport, runtime.registry),
	};
}

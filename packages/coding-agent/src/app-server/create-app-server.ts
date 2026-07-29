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
import type { ChildBridgeOptions } from "./thread-runtime/child-bridge";
import { type AdmissionConfig, ThreadRuntimeManager } from "./thread-runtime/thread-runtime-manager";
import { TurnController, type TurnControllerNotification } from "./thread-runtime/turn-controller";
import { BoundedOutboundQueue } from "./transport/connection";
import { encodeMessage, type FrameCodecOptions } from "./transport/framing";

export type AppServerTransport = "stdio" | "websocket" | "unix";
export type AppServerWriter = (frame: Uint8Array) => Promise<void> | void;
export type AppServerRejectedFrameHandler = (reason: "malformed" | "oversize") => void;

export interface AppServerRuntimeOptions {
	readonly threadStartAdapter?: Omit<ChildBridgeOptions, "manager">;
}

export interface AppServerConnection {
	readonly id: string;
	readonly state: ConnectionState;
	process(line: Uint8Array): Promise<void>;
	close(): Promise<void>;
}

export interface AppServerRuntime {
	readonly manager: ThreadRuntimeManager;
	readonly turnController: TurnController;
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
	readonly turnController: TurnController;
	readonly registry = new HandlerRegistry();
	readonly subscriptions = new ThreadSubscriptionIndex();
	readonly broker = new ServerRequestBroker();
	readonly #connections = new Map<string, Connection>();
	readonly #connectionRegistry = new ConnectionRegistry();
	readonly #frameCodec: FrameCodecOptions | undefined;
	readonly #threadStartAdapter: ChildBridgeOptions | undefined;
	#nextConnectionId = 1;
	readonly #serverNotificationStability = new Map<string, "stable" | "experimental">(
		serverNotifications.map(({ method, stability }) => [method, stability]),
	);
	#nextRequestId = 1;

	constructor(
		config: Partial<AdmissionConfig>,
		frameCodec?: FrameCodecOptions,
		options: AppServerRuntimeOptions = {},
	) {
		this.manager = new ThreadRuntimeManager(config);
		// A departing thread must never leave an approval waiter hanging: cancelling here settles
		// every pending request for it, which also releases its pendingApprovals accounting.
		this.manager.onThreadGone(threadId => {
			this.broker.cancelAllForThread(threadId, "thread is no longer loaded");
		});
		this.turnController = new TurnController({
			manager: this.manager,
			emit: async (notification: TurnControllerNotification) => {
				const threadId = notification.params.threadId;
				const stability = this.#serverNotificationStability.get(notification.method);
				if (!stability) return;
				for (const connectionId of this.subscriptions.getSubscribers(threadId)) {
					const target = this.#connections.get(connectionId);
					const validators = target?.state.capabilities?.experimentalApi
						? experimentalValidators
						: stableValidators;
					if (!validators.serverNotificationParams[notification.method]?.(notification.params)) {
						logger.warn("Dropping invalid app-server notification", {
							connectionId,
							method: notification.method,
						});
						continue;
					}
					if (target?.active && shouldEmitNotification(target.state, notification.method, stability))
						await target.enqueueMessage({ method: notification.method, params: notification.params });
				}
			},
		});
		this.#frameCodec = frameCodec;
		const adapter = options.threadStartAdapter;
		this.#threadStartAdapter =
			typeof adapter?.create === "function"
				? {
						...adapter,
						manager: this.manager,
						onFrame: (child, frame) => {
							try {
								adapter.onFrame?.(child, frame);
							} finally {
								this.turnController.acceptFrame(child.sessionId, frame);
							}
						},
						// Reconnect hooks pass through unchanged: projection-cursor reconciliation after a
						// child reconnect is later work, so the controller has no reconnect ingress to compose.
					}
				: undefined;
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
			threadStartAdapter: this.#threadStartAdapter,
			turnController: this.turnController,
			isActive: active,
			subscribe: threadId => {
				if (!active()) throw new Error("Connection is inactive.");
				this.subscriptions.subscribe(connection.id, threadId);
				if (!active()) {
					this.subscriptions.unsubscribe(connection.id, threadId);
					throw new Error("Connection became inactive during subscription.");
				}
			},
			unsubscribe: threadId => {
				this.subscriptions.unsubscribe(connection.id, threadId);
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
				// A pending approval must protect its thread from idle eviction, so the counter moves up
				// only after the broker accepted the request and back down exactly once from that
				// handle's settlement. Without this the manager evicts a child mid-approval.
				this.manager.adjustPendingApprovals(threadId, 1);
				void request.settled.then(() => {
					this.manager.adjustPendingApprovals(threadId, -1);
				});
				// Only a connection that actually receives the request frame may answer it. Publication is
				// deferred, so drop each recipient from the eligible set if its enqueue never lands
				// (closed connection, backpressure, writer error); otherwise an eligible-but-unsent client
				// could settle a predictable request id it never saw. If nobody receives it, settle now
				// rather than holding the thread and its pendingApprovals until timeout.
				const recipients = [...request.eligibleConnections];
				deferred.push(async () => {
					let delivered = 0;
					for (const connectionId of recipients) {
						const target = active() ? this.#connections.get(connectionId) : undefined;
						try {
							if (!target) throw new Error("connection is gone");
							await target.enqueueMessage({ id, method, params });
							delivered += 1;
						} catch (error) {
							request.eligibleConnections.delete(connectionId);
							logger.warn("Dropping unreachable app-server server-request recipient", {
								connectionId,
								id,
								method,
								error: error instanceof Error ? error.message : String(error),
							});
						}
					}
					if (delivered === 0) this.broker.cancel(id, "no eligible connection received the request");
				});
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
		if (result.response) {
			if (this.#closed) {
				await result.rollbackUndeliveredResponse?.();
				return;
			}
			try {
				const delivered = await this.#queue.enqueue(result.response);
				if (!delivered || this.#closed) {
					await result.rollbackUndeliveredResponse?.();
					return;
				}
			} catch (error) {
				await result.rollbackUndeliveredResponse?.();
				throw error;
			}
			await result.responseDelivered?.();
		}
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
		const queueClose = this.#queue.close();
		await this.#inbound;
		await queueClose;
	}
}

/** Construct one shared runtime for a process/listener. */
export function createAppServerRuntime(
	config: Partial<AdmissionConfig> = {},
	frameCodec?: FrameCodecOptions,
	options: AppServerRuntimeOptions = {},
): AppServerRuntime {
	return new Runtime(config, frameCodec, options);
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

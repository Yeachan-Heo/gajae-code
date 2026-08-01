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
	/** Issue an approval request to subscribed clients and await its broker settlement. */
	requestApproval(threadId: string, method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
	close(): Promise<void>;
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
	readonly #unpublished = new Map<string, Set<() => void>>();
	readonly #connectionRegistry = new ConnectionRegistry();
	readonly #frameCodec: FrameCodecOptions | undefined;
	readonly #threadStartAdapter: ChildBridgeOptions | undefined;
	#closePromise: Promise<void> | undefined;
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

	close(): Promise<void> {
		this.#closePromise ??= this.#close();
		return this.#closePromise;
	}

	async #close(): Promise<void> {
		const failures: unknown[] = [];
		const captureFailure = (error: unknown): void => {
			if (error instanceof AggregateError) failures.push(...error.errors);
			else failures.push(error);
		};
		try {
			this.manager.shutdown();
		} catch (error) {
			captureFailure(error);
		}
		try {
			await this.manager.waitForClosures();
		} catch (error) {
			captureFailure(error);
		}
		try {
			await this.#threadStartAdapter?.shutdown?.();
		} catch (error) {
			captureFailure(error);
		}
		try {
			this.broker.shutdown();
		} catch (error) {
			captureFailure(error);
		}
		if (failures.length > 0)
			throw new AggregateError(
				failures,
				`Unverified app-server cleanup: ${failures.length} shutdown operation(s) failed.`,
			);
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
		// An unpublished request has an EMPTY eligible set, so handleDisconnect above cannot reach it.
		// Its finalizer settles it rather than leaving it pending until timeout.
		const finalizers = this.#unpublished.get(id);
		this.#unpublished.delete(id);
		if (finalizers) for (const finalize of finalizers) finalize();
	}

	/** Cancellation finalizers for requests whose deferred publication has not run yet. */
	#registerUnpublished(connectionId: string, finalize: () => void): () => void {
		const existing = this.#unpublished.get(connectionId) ?? new Set<() => void>();
		existing.add(finalize);
		this.#unpublished.set(connectionId, existing);
		return () => {
			existing.delete(finalize);
			if (existing.size === 0) this.#unpublished.delete(connectionId);
		};
	}

	/** Create a broker-backed request and publish it to every active thread subscriber. */
	#requestClient(
		threadId: string,
		method: string,
		params: unknown,
		active: () => boolean,
		deferred?: Array<() => Promise<void>>,
		originatingConnectionId?: string,
	): string | undefined {
		if (!active()) return undefined;
		const eligible = new Set(
			[...this.subscriptions.getSubscribers(threadId)].filter(id => this.#connections.get(id)?.active),
		);
		// A server request is atomic across eligible clients. Reject it before creating a broker
		// entry when its params are invalid for any recipient's negotiated profile.
		for (const connectionId of eligible) {
			const target = this.#connections.get(connectionId)!;
			const validators = target.state.capabilities?.experimentalApi ? experimentalValidators : stableValidators;
			if (!validators.serverRequestParams[method]?.(params)) {
				logger.warn("Dropping invalid app-server server request", { connectionId, method });
				return undefined;
			}
		}
		const id = `server-${this.#nextRequestId++}`;
		// Start with NO eligible responder. A connection becomes eligible only once its request
		// frame has actually been enqueued, so a second subscriber cannot answer the predictable
		// `server-N` id before (or instead of) receiving it.
		const recipients = [...eligible];
		const request = this.broker.create(id, method, params, threadId, new Set(recipients));
		if (!request) return undefined;
		request.eligibleConnections.clear();
		// A pending approval must protect its thread from idle eviction, so the counter moves up
		// only after the broker accepted the request and back down exactly once from that settlement.
		this.manager.adjustPendingApprovals(threadId, 1);
		void request.settled.then(() => {
			this.manager.adjustPendingApprovals(threadId, -1);
		});
		let published = false;
		const finalizeUnpublished = (): void => {
			if (published) return;
			published = true;
			this.broker.cancel(id, "request publication was abandoned");
		};
		const unregister = originatingConnectionId
			? this.#registerUnpublished(originatingConnectionId, finalizeUnpublished)
			: () => {};
		void request.settled.then(unregister, unregister);
		const publish = async (): Promise<void> => {
			unregister();
			if (published) return;
			published = true;
			// Publishing a request that already settled would send a ghost approval frame the client
			// can never answer, so skip it once the broker no longer holds the request.
			if (!this.broker.getPending(id)) return;
			for (const connectionId of recipients) {
				const target = active() ? this.#connections.get(connectionId) : undefined;
				try {
					if (!target) throw new Error("connection is gone");
					if (
						!(await target.enqueueMessage({ id, method, params }, () => this.broker.getPending(id) !== undefined))
					)
						throw new Error("request was settled before delivery");
					// Recheck after the await: a recipient can close from inside its writer while this
					// enqueue is pending, and must not become an eligible responder after departure.
					if (this.#connections.get(connectionId) !== target || !target.active)
						throw new Error("connection closed during publication");
					request.eligibleConnections.add(connectionId);
				} catch (error) {
					logger.warn("Dropping unreachable app-server server-request recipient", {
						connectionId,
						id,
						method,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			if (request.eligibleConnections.size === 0)
				this.broker.cancel(id, "no eligible connection received the request");
		};
		if (deferred) deferred.push(publish);
		else void publish();
		return id;
	}

	/** Issue a server request outside an inbound connection and await broker settlement. */
	async requestApproval(threadId: string, method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
		if (signal?.aborted) throw new Error("approval request aborted");
		const id = this.#requestClient(threadId, method, params, () => this.#closePromise === undefined);
		if (!id) throw new Error("No active app-server client is subscribed to the approval thread.");
		const pending = this.broker.getPending(id);
		if (!pending) throw new Error("Approval request was settled before it could be awaited.");
		const onAbort = (): void => {
			this.broker.cancel(id, "approval request aborted");
		};
		if (signal) signal.addEventListener("abort", onAbort, { once: true });
		try {
			const settlement = await pending.settled;
			if (settlement.kind === "resolved" || settlement.kind === "denied") return settlement.result;
			throw new Error(
				settlement.kind === "timedOut" ? "approval request timed out" : `approval request ${settlement.reason}`,
			);
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
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
			requestClient: (threadId, method, params) =>
				this.#requestClient(threadId, method, params, active, deferred, connection.id),
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

	async enqueueMessage(message: Record<string, unknown>, stillWanted?: () => boolean): Promise<boolean> {
		if (this.#closed) return false;
		const frame = encodeMessage(message);
		return await this.#queue.enqueue(
			this.#transport === "stdio" ? new Uint8Array([...frame, 10]) : frame,
			stillWanted,
		);
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closePromise = this.#close();
		return this.#closePromise;
	}

	async #close(): Promise<void> {
		this.#closed = true;
		this.#runtime.removeConnection(this.id);
		const runtimeClose = this.#transport === "stdio" ? this.#runtime.close() : undefined;
		const queueClose = this.#queue.close();
		await this.#inbound;
		await queueClose;
		await runtimeClose;
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

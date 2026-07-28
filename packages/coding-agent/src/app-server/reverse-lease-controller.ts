import { randomUUID } from "node:crypto";
import { REVERSE_HEARTBEAT_MS } from "../sdk/host/reverse-leases";
import type { SdkFrame } from "../sdk/host/types";

export type ReverseLeaseRequestHandler = (
	method: string,
	payload: unknown,
	frame: Readonly<SdkFrame>,
) => unknown | Promise<unknown>;

export interface ReverseLeaseProvider {
	readonly capability: string;
	readonly definitions: unknown;
	/** Handles reverse requests for this provider. */
	readonly handle?: ReverseLeaseRequestHandler;
	/** Alias retained for adapters that call the handler a request function. */
	readonly request?: ReverseLeaseRequestHandler;
	/** Alias for callers that use an event-style provider surface. */
	readonly onRequest?: ReverseLeaseRequestHandler;
}

/** The transport-only portion of SdkClient needed by the lease controller. */
export interface ReverseLeaseClient {
	readonly connectionId?: string;
	connect(): Promise<void>;
	onFrame(handler: (frame: SdkFrame) => void): () => void;
	onReconnect(handler: () => void): () => void;
	request(frame: SdkFrame): Promise<SdkFrame>;
	send(frame: SdkFrame): void;
	close(): Promise<void>;
	awaitHello?(): Promise<void>;
}

export type ReverseLeaseControllerErrorCode =
	| "controller_closed"
	| "connection_id_missing"
	| "invalid_reverse_frame"
	| "provider_unavailable"
	| "lease_registration_failed";

export class ReverseLeaseControllerError extends Error {
	readonly code: ReverseLeaseControllerErrorCode;

	constructor(code: ReverseLeaseControllerErrorCode, message: string = code) {
		super(message);
		this.name = "ReverseLeaseControllerError";
		this.code = code;
	}
}

export interface ReverseLeaseControllerRuntimeOptions {
	readonly heartbeatMs?: number;
	readonly idempotencyKeyFactory?: () => string;
	readonly onError?: (error: unknown) => void;
	/** Test seam for deterministic heartbeat timers. */
	readonly setInterval?: (callback: () => void, milliseconds: number) => unknown;
	/** Test seam paired with setInterval. */
	readonly clearInterval?: (handle: unknown) => void;
}

export interface ReverseLeaseControllerOptions extends ReverseLeaseControllerRuntimeOptions {
	readonly client: ReverseLeaseClient;
	readonly providers?: readonly ReverseLeaseProvider[];
}

type PendingReverseRequest = {
	state: "pending" | "cancelled";
};

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function requiredString(frame: SdkFrame, field: string): string | undefined {
	return typeof frame[field] === "string" && frame[field] ? (frame[field] as string) : undefined;
}

function errorDetails(error: unknown): { code: string; message: string } {
	const candidate = error as { code?: unknown; message?: unknown };
	return {
		code: typeof candidate?.code === "string" ? candidate.code : "reverse_provider_failed",
		message: typeof candidate?.message === "string" ? candidate.message : "Reverse provider request failed.",
	};
}

/**
 * Maintains provider leases owned by one child SdkClient.
 *
 * This controller is deliberately transport-only: app-server lifecycle code owns child
 * creation, while this class owns registration, lease renewal, reconnect reclaim, and the
 * lease fence around reverse responses.
 */
export class ReverseLeaseController {
	readonly #client: ReverseLeaseClient;
	readonly #heartbeatMs: number;
	readonly #idempotencyKeyFactory: () => string;
	readonly #onError?: (error: unknown) => void;
	readonly #setInterval: (callback: () => void, milliseconds: number) => unknown;
	readonly #clearInterval: (handle: unknown) => void;
	readonly #providers = new Map<string, ReverseLeaseProvider>();
	readonly #leases = new Map<string, string>();
	readonly #idempotencyKeys = new Map<string, string>();
	readonly #reverseRequests = new Map<string, PendingReverseRequest>();
	#connectionId?: string;
	#heartbeatTimer?: unknown;
	#unsubscribeFrame?: () => void;
	#unsubscribeReconnect?: () => void;
	#reclaiming?: Promise<void>;
	#started = false;
	#closed = false;

	constructor(options: ReverseLeaseControllerOptions);
	constructor(
		client: ReverseLeaseClient,
		providers?: readonly ReverseLeaseProvider[],
		options?: ReverseLeaseControllerRuntimeOptions,
	);
	constructor(
		optionsOrClient: ReverseLeaseControllerOptions | ReverseLeaseClient,
		providers: readonly ReverseLeaseProvider[] | undefined = undefined,
		runtimeOptions: ReverseLeaseControllerRuntimeOptions = {},
	) {
		const options =
			"client" in optionsOrClient
				? optionsOrClient
				: {
						...runtimeOptions,
						client: optionsOrClient,
						providers,
					};
		this.#client = options.client;
		this.#heartbeatMs = options.heartbeatMs ?? REVERSE_HEARTBEAT_MS;
		this.#idempotencyKeyFactory = options.idempotencyKeyFactory ?? randomUUID;
		this.#onError = options.onError;
		this.#setInterval = options.setInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds));
		this.#clearInterval = options.clearInterval ?? (handle => clearInterval(handle as NodeJS.Timeout));
		for (const provider of options.providers ?? []) this.#addProvider(provider);
	}

	get started(): boolean {
		return this.#started;
	}

	get connectionId(): string | undefined {
		return this.#connectionId ?? this.#client.connectionId;
	}

	get leaseIds(): ReadonlyMap<string, string> {
		return this.#leases;
	}

	getLeaseId(capability: string): string | undefined {
		return this.#leases.get(capability);
	}

	/** Starts the child transport and registers all configured providers. */
	async start(): Promise<void> {
		if (this.#closed)
			throw new ReverseLeaseControllerError("controller_closed", "Reverse lease controller is closed.");
		if (this.#started) return;
		this.#unsubscribeFrame ??= this.#client.onFrame(frame => this.#onFrame(frame));
		this.#unsubscribeReconnect ??= this.#client.onReconnect(() => {
			void this.#reclaimProviders().catch(error => this.#reportError(error));
		});
		try {
			await this.#client.connect();
			this.#syncConnectionId();
			this.#requireConnectionId();
			for (const provider of this.#providers.values()) await this.#registerProvider(provider);
			this.#started = true;
			this.#heartbeatTimer ??= this.#setInterval(
				() => void this.#heartbeatLeases().catch(error => this.#reportError(error)),
				this.#heartbeatMs,
			);
		} catch (error) {
			this.#unsubscribeFrame?.();
			this.#unsubscribeFrame = undefined;
			this.#unsubscribeReconnect?.();
			this.#unsubscribeReconnect = undefined;
			throw error;
		}
	}

	/** Add and, when already started, immediately register one provider. */
	async registerProvider(provider: ReverseLeaseProvider): Promise<void> {
		if (this.#closed)
			throw new ReverseLeaseControllerError("controller_closed", "Reverse lease controller is closed.");
		this.#addProvider(provider);
		if (this.#started) await this.#registerProvider(provider);
	}

	/** Best-effort release of all leases followed by child transport shutdown. */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#started = false;
		if (this.#heartbeatTimer !== undefined) {
			this.#clearInterval(this.#heartbeatTimer);
			this.#heartbeatTimer = undefined;
		}
		this.#unsubscribeFrame?.();
		this.#unsubscribeFrame = undefined;
		this.#unsubscribeReconnect?.();
		this.#unsubscribeReconnect = undefined;
		const connectionId = this.#currentConnectionId();
		if (connectionId) {
			for (const leaseId of this.#leases.values()) {
				try {
					this.#client.send({ type: "lease_release", connectionId, leaseId });
				} catch (error) {
					this.#reportError(error);
				}
			}
		}
		this.#leases.clear();
		this.#reverseRequests.clear();
		await this.#client.close();
	}

	/** Alias for lifecycle callers that name the operation shutdown. */
	async shutdown(): Promise<void> {
		await this.close();
	}

	#addProvider(provider: ReverseLeaseProvider): void {
		if (!provider.capability)
			throw new ReverseLeaseControllerError("invalid_reverse_frame", "Provider capability is required.");
		if (this.#providers.has(provider.capability))
			throw new ReverseLeaseControllerError(
				"invalid_reverse_frame",
				`Provider capability is duplicated: ${provider.capability}`,
			);
		this.#providers.set(provider.capability, provider);
	}

	#syncConnectionId(): void {
		if (typeof this.#client.connectionId === "string" && this.#client.connectionId.length > 0)
			this.#connectionId = this.#client.connectionId;
	}

	#currentConnectionId(): string | undefined {
		this.#syncConnectionId();
		return this.#connectionId;
	}

	#requireConnectionId(): string {
		const connectionId = this.#currentConnectionId();
		if (!connectionId)
			throw new ReverseLeaseControllerError("connection_id_missing", "SDK client did not provide a connection id.");
		return connectionId;
	}

	async #registerProvider(provider: ReverseLeaseProvider): Promise<void> {
		if (this.#closed)
			throw new ReverseLeaseControllerError("controller_closed", "Reverse lease controller is closed.");
		const connectionId = this.#requireConnectionId();
		let idempotencyKey = this.#idempotencyKeys.get(provider.capability);
		if (!idempotencyKey) {
			idempotencyKey = this.#idempotencyKeyFactory();
			this.#idempotencyKeys.set(provider.capability, idempotencyKey);
		}
		const expectedLeaseId = this.#leases.get(provider.capability);
		const response = await this.#client.request({
			type: "register_provider",
			connectionId,
			capability: provider.capability,
			definitions: provider.definitions,
			idempotencyKey,
			...(expectedLeaseId ? { expectedLeaseId } : {}),
		});
		const result = typeof response.leaseId === "string" ? response : record(response.result);
		const leaseId = typeof result?.leaseId === "string" ? result.leaseId : undefined;
		if (!leaseId)
			throw new ReverseLeaseControllerError("lease_registration_failed", "Provider registration omitted leaseId.");
		this.#leases.set(provider.capability, leaseId);
	}

	async #reclaimProviders(): Promise<void> {
		if (this.#closed || !this.#started || this.#providers.size === 0) return;
		if (this.#reclaiming) return await this.#reclaiming;
		const reclaim = (async () => {
			await this.#client.awaitHello?.();
			this.#syncConnectionId();
			this.#requireConnectionId();
			for (const provider of this.#providers.values()) await this.#registerProvider(provider);
		})();
		this.#reclaiming = reclaim;
		try {
			await reclaim;
		} finally {
			if (this.#reclaiming === reclaim) this.#reclaiming = undefined;
		}
	}

	async #heartbeatLeases(): Promise<void> {
		if (this.#reclaiming) {
			try {
				await this.#reclaiming;
			} catch {
				return;
			}
		}
		if (this.#closed || !this.#started || this.#leases.size === 0) return;
		try {
			await this.#client.awaitHello?.();
			const connectionId = this.#currentConnectionId();
			if (!connectionId) return;
			for (const leaseId of this.#leases.values())
				this.#client.send({ type: "provider_heartbeat", connectionId, leaseId });
		} catch (error) {
			this.#reportError(error);
		}
	}

	#onFrame(frame: SdkFrame): void {
		if (this.#closed) return;
		if ((frame.type === "hello" || frame.type === "server_hello") && typeof frame.connectionId === "string") {
			const changed = this.#connectionId !== undefined && this.#connectionId !== frame.connectionId;
			this.#connectionId = frame.connectionId;
			if (changed) void this.#reclaimProviders().catch(error => this.#reportError(error));
			return;
		}
		if (
			(frame.type === "reverse_cancel" ||
				frame.type === "reverse_request_cancel" ||
				frame.type === "reverse_request_cancelled") &&
			typeof frame.id === "string"
		) {
			const request = this.#reverseRequests.get(frame.id);
			if (request) request.state = "cancelled";
			return;
		}
		if (frame.type === "reverse_request")
			void this.#handleReverseRequest(frame).catch(error => this.#reportError(error));
	}

	async #handleReverseRequest(frame: SdkFrame): Promise<void> {
		const id = requiredString(frame, "id");
		const connectionId = requiredString(frame, "connectionId");
		const capability = requiredString(frame, "capability");
		const leaseId = requiredString(frame, "leaseId");
		if (!id || !connectionId || !capability || !leaseId) return;
		if (!this.#ownsLease(connectionId, capability, leaseId) || this.#reverseRequests.has(id)) return;
		const provider = this.#providers.get(capability);
		if (!provider) return;
		const request = { state: "pending" as const };
		this.#reverseRequests.set(id, request);
		const envelope = record(frame.payload);
		const method = typeof envelope?.method === "string" ? envelope.method : undefined;
		const handler = provider.handle ?? provider.request ?? provider.onRequest;
		try {
			if (!method)
				throw new ReverseLeaseControllerError("invalid_reverse_frame", "Reverse request method is required.");
			if (!handler)
				throw new ReverseLeaseControllerError(
					"provider_unavailable",
					`Provider ${capability} has no request handler.`,
				);
			const payload = envelope && Object.hasOwn(envelope, "payload") ? envelope.payload : undefined;
			const result = await handler(method, payload, frame);
			if (!this.#canRespond(id, request, connectionId, capability, leaseId)) return;
			this.#client.send({ type: "reverse_response", id, connectionId, leaseId, ok: true, result });
		} catch (error) {
			if (!this.#canRespond(id, request, connectionId, capability, leaseId)) return;
			const details = errorDetails(error);
			this.#client.send({
				type: "reverse_response",
				id,
				connectionId,
				leaseId,
				ok: false,
				error: details,
			});
		} finally {
			if (this.#reverseRequests.get(id) === request) this.#reverseRequests.delete(id);
		}
	}

	#ownsLease(connectionId: string, capability: string, leaseId: string): boolean {
		return this.#currentConnectionId() === connectionId && this.#leases.get(capability) === leaseId;
	}

	#canRespond(
		id: string,
		request: PendingReverseRequest,
		connectionId: string,
		capability: string,
		leaseId: string,
	): boolean {
		return (
			this.#reverseRequests.get(id) === request &&
			request.state === "pending" &&
			this.#ownsLease(connectionId, capability, leaseId)
		);
	}

	#reportError(error: unknown): void {
		try {
			this.#onError?.(error);
		} catch {
			// Error observers cannot change lease state or transport cleanup.
		}
	}
}

export function createReverseLeaseController(options: ReverseLeaseControllerOptions): ReverseLeaseController {
	return new ReverseLeaseController(options);
}

import { randomUUID } from "node:crypto";
import { SdkClient, SdkClientError, type SdkFrame } from "../client";
import { validateAdapterControl, validateAdapterSecretFields } from "../protocol/adapter-validation";

import { OPERATIONS } from "../protocol/operation-registry";

type JsonObject = Record<string, unknown>;

/** The small agent-side ACP surface used for reverse requests. */
export interface AcpReverseConnection {
	request?(method: string, params: JsonObject): Promise<unknown>;
	[key: string]: unknown;
}

export interface AcpProviderRegistration {
	capability: string;
	definitions: unknown;
}

export interface AcpSdkAdapterOptions {
	url: string;
	token: string;
	client?: SdkClient;
	connection?: AcpReverseConnection;
	providers?: AcpProviderRegistration[];
	/** Lease IDs persisted by the ACP host across a WebSocket reconnect. */
	expectedLeaseIds?: Record<string, string>;
	heartbeatMs?: number;
	reverseCancelTtlMs?: number;
}

export class AcpSdkAdapterError extends Error {
	readonly code: string;
	constructor(code: string, message = code) {
		super(message);
		this.name = "AcpSdkAdapterError";
		this.code = code;
	}
}

export type AcpReconnectFailedHandler = (error: SdkClientError) => void;
export type AcpFrameHandler = (frame: SdkFrame) => void;
type ReverseRequest = {
	state: "pending" | "cancelled";
	cancelTimer?: NodeJS.Timeout;
};

const SESSION_GLOBALS: Record<string, string> = {
	newSession: "session.create",
	loadSession: "session.resume",
	resumeSession: "session.resume",
	listSessions: "session.list",
	forkSession: "session.fork",
	closeSession: "session.close",
};

function isLifecycleOperation(operation: string): boolean {
	return (
		operation === "session.create" ||
		operation === "session.fork" ||
		operation === "session.resume" ||
		operation === "session.close" ||
		operation === "session.delete"
	);
}

/**
 * Pure ACP-to-SDK adapter. It deliberately owns neither an AgentSession nor an
 * ACP bridge: all session work is performed through authenticated v3 frames.
 */
export class AcpSdkAdapter {
	readonly #client: SdkClient;
	readonly #connection?: AcpReverseConnection;
	readonly #providers: AcpProviderRegistration[];
	readonly #heartbeatMs: number;
	#unsubscribe?: () => void;
	#unsubscribeReconnect?: () => void;
	#unsubscribeReconnectFailed?: () => void;
	#heartbeat?: NodeJS.Timeout;
	#connectionId?: string;
	#leases = new Map<string, string>();
	#reclaiming?: Promise<void>;
	#reverseRequests = new Map<string, ReverseRequest>();
	#reconnectFailedHandlers = new Set<AcpReconnectFailedHandler>();
	#frameHandlers = new Set<AcpFrameHandler>();

	#reverseCancelTtlMs: number;
	#closed = false;

	constructor(options: AcpSdkAdapterOptions) {
		this.#client = options.client ?? new SdkClient(options.url, options.token);
		this.#connection = options.connection;
		this.#providers = options.providers ?? [];
		for (const [capability, leaseId] of Object.entries(options.expectedLeaseIds ?? {}))
			this.#leases.set(capability, leaseId);
		this.#heartbeatMs = options.heartbeatMs ?? 5_000;
		this.#reverseCancelTtlMs = options.reverseCancelTtlMs ?? 30_000;
	}

	static async connect(options: AcpSdkAdapterOptions): Promise<AcpSdkAdapter> {
		const client = options.client ?? (await SdkClient.connect(options.url, options.token));
		const adapter = new AcpSdkAdapter({ ...options, client });
		await adapter.start();
		return adapter;
	}

	get leaseIds(): ReadonlyMap<string, string> {
		return this.#leases;
	}
	get connectionId(): string | undefined {
		return this.#connectionId;
	}

	onReconnectFailed(handler: AcpReconnectFailedHandler): () => void {
		this.#reconnectFailedHandlers.add(handler);
		return () => this.#reconnectFailedHandlers.delete(handler);
	}

	onFrame(handler: AcpFrameHandler): () => void {
		this.#frameHandlers.add(handler);
		return () => this.#frameHandlers.delete(handler);
	}

	async start(): Promise<void> {
		if (this.#closed) throw new AcpSdkAdapterError("connection_closed");
		this.#unsubscribe ??= this.#client.onFrame(frame => void this.#onFrame(frame));
		this.#unsubscribeReconnect ??= this.#client.onReconnect(
			() => void this.#reclaimProviders().catch(error => this.#reportReconnectFailure(error)),
		);
		this.#unsubscribeReconnectFailed ??= this.#client.onReconnectFailed(error => this.#reportReconnectFailure(error));
		await this.#client.connect();
		this.#connectionId = this.#client.connectionId;
		if (this.#providers.length > 0 && !this.#connectionId) this.#connectionId = await this.#waitForConnectionId();
		for (const provider of this.#providers) await this.registerProvider(provider);
		this.#heartbeat ??= setInterval(
			() => void this.#heartbeatLeases().catch(error => this.#reportReconnectFailure(error)),
			this.#heartbeatMs,
		);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#heartbeat) clearInterval(this.#heartbeat);
		for (const request of this.#reverseRequests.values()) if (request.cancelTimer) clearTimeout(request.cancelTimer);
		this.#reverseRequests.clear();
		this.#unsubscribe?.();
		this.#unsubscribeReconnect?.();
		this.#unsubscribeReconnectFailed?.();
		await this.#client.close();
	}

	async prompt(params: JsonObject | string): Promise<unknown> {
		const text = typeof params === "string" ? params : String(params.prompt ?? params.text ?? "");
		return await this.#client.control("turn.prompt", { ...(typeof params === "object" ? params : {}), text });
	}
	async cancel(): Promise<unknown> {
		return await this.#client.control("turn.abort", {});
	}
	async setModel(params: JsonObject | string): Promise<unknown> {
		const id = typeof params === "string" ? params : String(params.modelId ?? params.id ?? "");
		return await this.#client.control("model.set", { id });
	}

	async control(operation: string, input: JsonObject = {}): Promise<unknown> {
		this.#assertGenericDisposition("control", operation);
		const { confirm, ...payload } = input;
		const secretError = validateAdapterSecretFields(operation, payload);
		if (secretError) throw new AcpSdkAdapterError(secretError.code, secretError.message);

		const invalid = validateAdapterControl(operation, payload);
		if (invalid) throw new AcpSdkAdapterError(invalid.code, invalid.message);
		return await this.#client.control(operation, payload, { confirm: confirm === true });
	}
	async query(query: string, input: JsonObject = {}, cursor?: string): Promise<unknown> {
		return await this.#client.query(query, input, cursor);
	}
	async global(operation: string, input: JsonObject = {}, idempotencyKey?: string): Promise<unknown> {
		this.#assertGenericDisposition("global", operation);
		if (isLifecycleOperation(operation) && !idempotencyKey)
			throw new AcpSdkAdapterError("invalid_input", "idempotencyKey is required for lifecycle operations.");
		return await this.#client.global(operation, input, { idempotencyKey });
	}

	async sdkControl(params: { operation: string; input?: JsonObject }): Promise<unknown> {
		return await this.control(params.operation, params.input ?? {});
	}
	async sdkQuery(params: { query: string; input?: JsonObject; cursor?: string }): Promise<unknown> {
		return await this.query(params.query, params.input ?? {}, params.cursor);
	}
	async sdkGlobal(params: { operation: string; input?: JsonObject; idempotencyKey?: string }): Promise<unknown> {
		return await this.global(params.operation, params.input ?? {}, params.idempotencyKey);
	}

	/** Dispatches the ACP extension method names without exposing endpoint credentials. */
	async handle(method: string, params: JsonObject = {}): Promise<unknown> {
		if (method === "_gjc/sdk/control")
			return await this.sdkControl(params as { operation: string; input?: JsonObject });
		if (method === "_gjc/sdk/query")
			return await this.sdkQuery(params as { query: string; input?: JsonObject; cursor?: string });
		if (method === "_gjc/sdk/global") {
			if (typeof params.operation === "string" && isLifecycleOperation(params.operation))
				throw new AcpSdkAdapterError(
					"operation_prohibited",
					"ACP lifecycle operations are available only through typed session methods.",
				);
			return await this.sdkGlobal(params as { operation: string; input?: JsonObject; idempotencyKey?: string });
		}
		if (method === "prompt") return await this.prompt(params);
		if (method === "cancel") return await this.cancel();
		if (method === "setModel") return await this.setModel(params);
		const global = SESSION_GLOBALS[method];
		if (global) {
			if (!isLifecycleOperation(global)) return await this.global(global, params);
			const { idempotencyKey, ...input } = params;
			return await this.global(global, input, typeof idempotencyKey === "string" ? idempotencyKey : undefined);
		}
		throw new AcpSdkAdapterError("method_not_found", `Unsupported ACP SDK method: ${method}`);
	}

	async registerProvider(provider: AcpProviderRegistration): Promise<void> {
		const connectionId = this.#connectionId ?? (await this.#waitForConnectionId());
		const previousLeaseId = this.#leases.get(provider.capability);
		const result = await this.#client.request({
			type: "register_provider",
			connectionId,
			capability: provider.capability,
			definitions: provider.definitions,
			idempotencyKey: randomUUID(),
			...(previousLeaseId ? { expectedLeaseId: previousLeaseId } : {}),
		});
		if (typeof result.leaseId !== "string")
			throw new AcpSdkAdapterError("invalid_reverse_frame", "Provider registration omitted leaseId.");
		this.#leases.set(provider.capability, result.leaseId);
	}

	#assertGenericDisposition(kind: "control" | "global", sdkId: string): void {
		const operation = OPERATIONS.find(candidate => candidate.kind === kind && candidate.sdkId === sdkId);
		if (!operation) throw new AcpSdkAdapterError("unknown_operation", `Unknown SDK ${kind}: ${sdkId}`);
		const disposition = operation.adapterDispositions.acp;
		if (disposition === "prohibited")
			throw new AcpSdkAdapterError("operation_prohibited", `${sdkId} is prohibited for ACP.`);
		if (disposition === "provider_only")
			throw new AcpSdkAdapterError(
				"provider_required",
				`${sdkId} must be invoked through ACP provider registration, not _gjc/sdk/${kind}.`,
			);
		if (disposition === "machine_only")
			throw new AcpSdkAdapterError(
				operation.errorCodes[0] ?? "machine_only",
				`${sdkId} is available only to machine-local SDK clients.`,
			);
	}

	async #reclaimProviders(): Promise<void> {
		if (this.#closed || !this.#providers.length) return;
		if (this.#reclaiming) return await this.#reclaiming;
		this.#reclaiming = (async () => {
			this.#connectionId = this.#client.connectionId;
			if (!this.#connectionId) this.#connectionId = await this.#waitForConnectionId();
			for (const provider of this.#providers) await this.registerProvider(provider);
		})();
		try {
			await this.#reclaiming;
		} finally {
			this.#reclaiming = undefined;
		}
	}

	#reportReconnectFailure(error: unknown): void {
		const typed =
			error instanceof SdkClientError
				? error
				: new SdkClientError(
						"reconnect_exhausted",
						error instanceof Error ? error.message : "SDK reconnect failed.",
						error,
					);
		for (const handler of this.#reconnectFailedHandlers) handler(typed);
	}

	async #waitForConnectionId(): Promise<string> {
		if (this.#connectionId) return this.#connectionId;
		return await new Promise<string>((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new AcpSdkAdapterError("unavailable", "SDK server did not provide a connection id.")),
				10_000,
			);
			const unsubscribe = this.#client.onFrame(frame => {
				if ((frame.type === "hello" || frame.type === "server_hello") && typeof frame.connectionId === "string") {
					clearTimeout(timeout);
					unsubscribe();
					this.#connectionId = frame.connectionId;
					resolve(frame.connectionId);
				}
			});
		});
	}

	async #heartbeatLeases(): Promise<void> {
		if (this.#closed) return;
		try {
			await this.#client.awaitHello();
			this.#connectionId ??= this.#client.connectionId;
			if (!this.#connectionId) return;
			for (const leaseId of this.#leases.values())
				this.#client.send({ type: "provider_heartbeat", connectionId: this.#connectionId, leaseId });
		} catch (error) {
			this.#reportReconnectFailure(error);
		}
	}

	async #onFrame(frame: SdkFrame): Promise<void> {
		for (const handler of this.#frameHandlers) handler(frame);
		if ((frame.type === "hello" || frame.type === "server_hello") && typeof frame.connectionId === "string") {
			const changed = this.#connectionId !== undefined && this.#connectionId !== frame.connectionId;
			this.#connectionId = frame.connectionId;
			if (changed) void this.#reclaimProviders().catch(error => this.#reportReconnectFailure(error));
			return;
		}
		if (
			(frame.type === "reverse_cancel" ||
				frame.type === "reverse_request_cancel" ||
				frame.type === "reverse_request_cancelled") &&
			typeof frame.id === "string"
		) {
			this.#cancelReverse(frame.id);
			return;
		}

		if (frame.type !== "reverse_request") return;
		const id = typeof frame.id === "string" ? frame.id : "";
		const connectionId = typeof frame.connectionId === "string" ? frame.connectionId : "";
		const capability = typeof frame.capability === "string" ? frame.capability : "";
		const leaseId = typeof frame.leaseId === "string" ? frame.leaseId : "";
		if (
			!id ||
			!connectionId ||
			!capability ||
			!leaseId ||
			this.#reverseRequests.has(id) ||
			!this.#ownsReverseLease(connectionId, capability, leaseId)
		)
			return;
		const active: ReverseRequest = { state: "pending" };
		this.#reverseRequests.set(id, active);
		try {
			const request = frame.payload as JsonObject | undefined;
			const method = typeof request?.method === "string" ? request.method : "";
			const payload = request?.payload && typeof request.payload === "object" ? (request.payload as JsonObject) : {};
			const result = await this.#forwardReverse(method, payload);
			if (!this.#canRespondToReverse(id, active, connectionId, capability, leaseId)) return;

			this.#client.send({ type: "reverse_response", id, connectionId, leaseId, ok: true, result });
		} catch (error) {
			if (!this.#canRespondToReverse(id, active, connectionId, capability, leaseId)) return;

			const typed =
				error instanceof AcpSdkAdapterError || error instanceof SdkClientError
					? error
					: new AcpSdkAdapterError(
							"acp_reverse_failed",
							error instanceof Error ? error.message : "ACP reverse request failed.",
						);
			this.#client.send({
				type: "reverse_response",
				id,
				connectionId,
				leaseId,
				ok: false,
				error: { code: typed.code, message: typed.message },
			});
		} finally {
			this.#finishReverse(id, active);
		}
	}

	#ownsReverseLease(connectionId: string, capability: string, leaseId: string): boolean {
		return this.#connectionId === connectionId && this.#leases.get(capability) === leaseId;
	}

	#canRespondToReverse(
		id: string,
		request: ReverseRequest,
		connectionId: string,
		capability: string,
		leaseId: string,
	): boolean {
		return (
			this.#reverseRequests.get(id) === request &&
			request.state === "pending" &&
			this.#ownsReverseLease(connectionId, capability, leaseId)
		);
	}

	#cancelReverse(id: string): void {
		const request: ReverseRequest = this.#reverseRequests.get(id) ?? { state: "pending" };
		if (request.state === "cancelled") return;
		request.state = "cancelled";
		request.cancelTimer = setTimeout(() => this.#finishReverse(id, request), this.#reverseCancelTtlMs);
		this.#reverseRequests.set(id, request);
	}

	#finishReverse(id: string, request: ReverseRequest): void {
		if (this.#reverseRequests.get(id) !== request) return;
		if (request.cancelTimer) clearTimeout(request.cancelTimer);
		this.#reverseRequests.delete(id);
	}

	async #forwardReverse(method: string, payload: JsonObject): Promise<unknown> {
		if (!method || !this.#connection) throw new AcpSdkAdapterError("acp_reverse_unavailable");
		if (this.#connection.request) return await this.#connection.request(method, payload);
		const target = this.#connection[method];
		if (typeof target !== "function")
			throw new AcpSdkAdapterError("acp_reverse_unsupported", `ACP client does not support ${method}.`);
		return await (target as (params: JsonObject) => Promise<unknown>)(payload);
	}
}

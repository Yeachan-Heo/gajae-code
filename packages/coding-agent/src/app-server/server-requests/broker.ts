// app-server server-request broker: native JSON-RPC server->client requests.
//
// Per the plan D4: approvals (execCommandApproval / applyPatchApproval) are server
// requests sent to subscribed connections. The broker tracks an eligible-connection-set
// per request, uses first-responder resolution, replays to newly eligible subscribers,
// and cancels only on turn/thread transition, shutdown, or loss of the last responder.

export type ServerRequestStatus = "pending" | "resolved" | "cancelled";

export interface ServerRequest {
	readonly id: string;
	readonly method: string;
	readonly params: unknown;
	readonly threadId: string;
	readonly eligibleConnections: Set<string>;
	status: ServerRequestStatus;
	result: unknown;
	resolvedBy: string | undefined;
	createdAt: number;
}

export interface BrokerOptions {
	readonly requestTimeoutMs?: number;
}

const DEFAULT_TIMEOUT = 5 * 60 * 1000;

/**
 * Brokers server->client requests (approvals, elicitations) to the eligible connection set.
 * The transport layer delivers the request frame and receives the client's response;
 * this broker tracks the lifecycle: pending -> resolved|cancelled.
 */
export class ServerRequestBroker {
	readonly #pending = new Map<string, ServerRequest>();
	readonly #options: BrokerOptions;

	constructor(options: BrokerOptions = {}) {
		this.#options = { requestTimeoutMs: DEFAULT_TIMEOUT, ...options };
	}

	get pendingCount(): number {
		return this.#pending.size;
	}

	/**
	 * Create a pending server request and return it. The caller (transport) sends the
	 * request frame to each eligible connection. Returns undefined if no eligible connections.
	 */
	create(id: string, method: string, params: unknown, threadId: string, eligibleConnections: Set<string>): ServerRequest | undefined {
		if (eligibleConnections.size === 0) return undefined;
		const request: ServerRequest = {
			id,
			method,
			params,
			threadId,
			eligibleConnections: new Set(eligibleConnections),
			status: "pending",
			result: undefined,
			resolvedBy: undefined,
			createdAt: Date.now(),
		};
		this.#pending.set(id, request);
		return request;
	}

	/** Resolve a pending request with the first responder's result. */
	resolve(id: string, connectionId: string, result: unknown): boolean {
		const request = this.#pending.get(id);
		if (!request || request.status !== "pending") return false;
		if (!request.eligibleConnections.has(connectionId)) return false;
		(request as { status: ServerRequestStatus }).status = "resolved";
		(request as { result: unknown }).result = result;
		(request as { resolvedBy: string }).resolvedBy = connectionId;
		this.#pending.delete(id);
		return true;
	}

	/** Remove a connection from a request's eligible set (on disconnect). */
	removeConnection(requestId: string, connectionId: string): "updated" | "cancelled" | "notFound" {
		const request = this.#pending.get(requestId);
		if (!request) return "notFound";
		request.eligibleConnections.delete(connectionId);
		if (request.eligibleConnections.size === 0) {
			(request as { status: ServerRequestStatus }).status = "cancelled";
			this.#pending.delete(requestId);
			return "cancelled";
		}
		return "updated";
	}

	/** Cancel a request (on turn/thread transition or shutdown). */
	cancel(id: string): boolean {
		const request = this.#pending.get(id);
		if (!request) return false;
		(request as { status: ServerRequestStatus }).status = "cancelled";
		this.#pending.delete(id);
		return true;
	}

	/** Cancel all pending requests for a thread (on turn/thread transition). */
	cancelAllForThread(threadId: string): number {
		let count = 0;
		for (const [id, request] of this.#pending) {
			if (request.threadId === threadId) {
				(request as { status: ServerRequestStatus }).status = "cancelled";
				this.#pending.delete(id);
				count++;
			}
		}
		return count;
	}

	/** Get all pending requests for a thread. */
	getPendingForThread(threadId: string): ServerRequest[] {
		return [...this.#pending.values()].filter(r => r.threadId === threadId);
	}

	/** Clean up expired requests (past timeout). */
	cleanupExpired(): number {
		const now = Date.now();
		let count = 0;
		for (const [id, request] of this.#pending) {
			if (now - request.createdAt > (this.#options.requestTimeoutMs ?? DEFAULT_TIMEOUT)) {
				(request as { status: ServerRequestStatus }).status = "cancelled";
				this.#pending.delete(id);
				count++;
			}
		}
		return count;
	}
}

/**
 * Transport-neutral request/response broker for UI and permission surfaces.
 *
 * The bridge protocol has one authoritative responder per session. Requests are
 * correlated by id, resolved exactly once, cancelled on timeout/disconnect, and
 * protected by an owner token so observers cannot race approvals.
 */
import { randomUUID } from "node:crypto";

export type UiRequestCancelReason = "timeout" | "abort" | "disconnect";

export interface UiRequestCancelled {
	status: "cancelled";
	reason: UiRequestCancelReason;
}

export type UiRequestResolution<TResponse> = TResponse | UiRequestCancelled;

export type UiBrokerResponseResult =
	| { status: "accepted" }
	| { status: "rejected"; code: "not_controller" | "already_resolved" | "unknown_request" };

export interface UiRequestBrokerOptions<TRequest> {
	emitRequest: (correlationId: string, request: TRequest) => void;
}

export interface UiRequestOptions {
	correlationId?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

interface PendingRequest<TResponse> {
	resolve: (value: UiRequestResolution<TResponse>) => void;
	timer: Timer | undefined;
	onAbort: (() => void) | undefined;
	signal: AbortSignal | undefined;
}

/**
 * Broker for one active session. v1 supports one controller token at a time;
 * other clients may observe frames but cannot answer correlated requests.
 */
export class UiRequestBroker<TRequest, TResponse> {
	readonly #emitRequest: (correlationId: string, request: TRequest) => void;
	#ownerToken: string | undefined;
	#pending = new Map<string, PendingRequest<TResponse>>();
	#resolved = new Set<string>();

	constructor(options: UiRequestBrokerOptions<TRequest>) {
		this.#emitRequest = options.emitRequest;
	}

	get ownerToken(): string | undefined {
		return this.#ownerToken;
	}

	get pendingCount(): number {
		return this.#pending.size;
	}

	claimController(ownerToken: string = randomUUID()): { status: "claimed"; ownerToken: string } | { status: "busy" } {
		if (this.#ownerToken) return { status: "busy" };
		this.#ownerToken = ownerToken;
		return { status: "claimed", ownerToken: this.#ownerToken };
	}

	releaseController(ownerToken: string): boolean {
		if (ownerToken !== this.#ownerToken) return false;
		this.#ownerToken = undefined;
		return true;
	}

	request(request: TRequest, options: UiRequestOptions = {}): Promise<UiRequestResolution<TResponse>> {
		const correlationId = options.correlationId ?? randomUUID();
		if (this.#pending.has(correlationId) || this.#resolved.has(correlationId)) {
			throw new Error(`Duplicate UI request correlation id: ${correlationId}`);
		}

		const { promise, resolve } = Promise.withResolvers<UiRequestResolution<TResponse>>();
		let timer: Timer | undefined;
		let onAbort: (() => void) | undefined;
		const settle = (value: UiRequestResolution<TResponse>) => {
			const pending = this.#pending.get(correlationId);
			if (!pending) return;
			this.#pending.delete(correlationId);
			this.#resolved.add(correlationId);
			if (pending.timer) clearTimeout(pending.timer);
			if (pending.onAbort) pending.signal?.removeEventListener("abort", pending.onAbort);
			pending.resolve(value);
		};

		if (options.timeoutMs !== undefined) {
			timer = setTimeout(() => settle({ status: "cancelled", reason: "timeout" }), options.timeoutMs);
		}
		if (options.signal) {
			onAbort = () => settle({ status: "cancelled", reason: "abort" });
			if (options.signal.aborted) {
				resolve({ status: "cancelled", reason: "abort" });
				this.#resolved.add(correlationId);
				return promise;
			}
			options.signal.addEventListener("abort", onAbort, { once: true });
		}

		this.#pending.set(correlationId, { resolve, timer, onAbort, signal: options.signal });
		this.#emitRequest(correlationId, request);
		return promise;
	}

	respond(correlationId: string, ownerToken: string, response: TResponse): UiBrokerResponseResult {
		if (ownerToken !== this.#ownerToken) return { status: "rejected", code: "not_controller" };
		const pending = this.#pending.get(correlationId);
		if (!pending) {
			return {
				status: "rejected",
				code: this.#resolved.has(correlationId) ? "already_resolved" : "unknown_request",
			};
		}
		this.#pending.delete(correlationId);
		this.#resolved.add(correlationId);
		if (pending.timer) clearTimeout(pending.timer);
		if (pending.onAbort) pending.signal?.removeEventListener("abort", pending.onAbort);
		pending.resolve(response);
		return { status: "accepted" };
	}

	cancelAll(reason: UiRequestCancelReason): void {
		for (const correlationId of [...this.#pending.keys()]) {
			this.cancel(correlationId, reason);
		}
	}

	cancel(correlationId: string, reason: UiRequestCancelReason): boolean {
		const pending = this.#pending.get(correlationId);
		if (!pending) return false;
		this.#pending.delete(correlationId);
		this.#resolved.add(correlationId);
		if (pending.timer) clearTimeout(pending.timer);
		if (pending.onAbort) pending.signal?.removeEventListener("abort", pending.onAbort);
		pending.resolve({ status: "cancelled", reason });
		return true;
	}

	disconnectController(ownerToken: string): boolean {
		if (!this.releaseController(ownerToken)) return false;
		this.cancelAll("disconnect");
		return true;
	}
}

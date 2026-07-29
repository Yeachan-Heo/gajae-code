// app-server server-request broker: native JSON-RPC server->client requests.
//
// A request is fanned out by the transport to the broker-owned eligible set. The broker
// owns first-valid-response settlement and fences every response after that settlement.

import { logger as defaultLogger } from "@gajae-code/utils";
import { experimentalValidators, stableValidators } from "../protocol-source/schema-validators.generated";

export type ServerRequestStatus = "pending" | "resolved" | "cancelled";
export type ServerRequestOutcome = "result" | "error";

export interface ServerRequestError {
	readonly code: number;
	readonly message: string;
}

export type ServerRequestSettlement =
	| { readonly kind: "resolved"; readonly connectionId: string; readonly result: unknown }
	| { readonly kind: "denied"; readonly connectionId: string; readonly result: unknown }
	| { readonly kind: "cancelled"; readonly reason: string }
	| { readonly kind: "timedOut" };

export interface ServerRequest {
	readonly id: string;
	readonly method: string;
	readonly params: unknown;
	readonly threadId: string;
	readonly eligibleConnections: Set<string>;
	status: ServerRequestStatus;
	outcome: ServerRequestOutcome | undefined;
	result: unknown;
	readonly settled: Promise<ServerRequestSettlement>;
	error: ServerRequestError | undefined;
	resolvedBy: string | undefined;
	settlement: ServerRequestSettlement | undefined;
	createdAt: number;
	readonly deadlineAt: number;
}

export interface ServerRequestHandle extends ServerRequest {
	/** The request member is self-referential for compatibility with the pre-awaitable API. */
	readonly request: ServerRequest;
}

type BrokerLogger = {
	warn(message: string, context?: Record<string, unknown>): void;
};

export interface BrokerOptions {
	readonly requestTimeoutMs?: number;
	readonly now?: () => number;
	readonly setTimeout?: (callback: () => void, milliseconds: number) => unknown;
	readonly clearTimeout?: (handle: unknown) => void;
	readonly logger?: BrokerLogger;
}

const DEFAULT_TIMEOUT = 5 * 60 * 1000;
const DEFAULT_CANCEL_REASON = "cancelled";
const THREAD_EVICTION_REASON = "thread evicted";
const DISCONNECT_REASON = "last eligible connection disconnected";
const SHUTDOWN_REASON = "shutdown";
/**
 * Retains enough recent ids to recognise a late reply without growing for the process lifetime.
 *
 * Request ids MUST be unique for the broker's lifetime: the production issuer is a monotonic
 * `server-N` counter (`create-app-server.ts`), so an id is never reused. This window is only a
 * late-reply diagnostic, NOT a correctness fence — a caller that recycles ids after eviction can
 * let a stale reply settle the new request, because a response frame carries only the id.
 */
const SETTLED_ID_RETENTION = 1024;
/** Native timers clamp anything larger, so a bigger deadline could never be honoured. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

type SettlementResolver = (settlement: ServerRequestSettlement) => void;

type PendingRequest = {
	readonly request: ServerRequest;
	readonly resolveSettlement: SettlementResolver;
	readonly settled: Promise<ServerRequestSettlement>;
	timer: unknown;
};

export class ServerRequestBrokerError extends Error {
	readonly code: "duplicate_request_id" | "broker_shutdown" | "invalid_timeout";
	readonly requestId: string | undefined;

	constructor(
		code: "duplicate_request_id" | "broker_shutdown" | "invalid_timeout",
		message: string,
		requestId?: string,
	) {
		super(message);
		this.name = "ServerRequestBrokerError";
		this.code = code;
		this.requestId = requestId;
	}
}

export class DuplicateServerRequestError extends ServerRequestBrokerError {
	constructor(requestId: string) {
		super("duplicate_request_id", `Duplicate server request ID is already reserved: ${requestId}`, requestId);
		this.name = "DuplicateServerRequestError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Methods whose `decision` field uses the legacy `ReviewDecision` union. */
const LEGACY_APPROVAL_METHODS: ReadonlySet<string> = new Set(["execCommandApproval", "applyPatchApproval"]);

/**
 * Classify an already schema-valid response. Only the legacy approval methods use
 * `ReviewDecision`; the v2 `item/*\/requestApproval` methods use their own decision enums, so
 * classifying every `decision` field as legacy would leave a valid v2 answer pending until timeout.
 */
function decisionSettlement(
	method: string,
	connectionId: string,
	result: unknown,
): ServerRequestSettlement | undefined {
	if (!isRecord(result) || !Object.hasOwn(result, "decision")) return { kind: "resolved", connectionId, result };
	const decision = result.decision;
	if (!LEGACY_APPROVAL_METHODS.has(method)) {
		// v2 decision enums: accept/acceptForSession and their amendment objects proceed, decline is
		// a denial, cancel is a cancellation. Anything else is schema-valid but unclassifiable here.
		if (decision === "accept" || decision === "acceptForSession") return { kind: "resolved", connectionId, result };
		if (decision === "decline") return { kind: "denied", connectionId, result };
		if (decision === "cancel") return { kind: "cancelled", reason: "approval cancelled" };
		if (
			isRecord(decision) &&
			(Object.hasOwn(decision, "acceptWithExecpolicyAmendment") ||
				Object.hasOwn(decision, "applyNetworkPolicyAmendment"))
		)
			return { kind: "cancelled", reason: "unsupported approval amendment" };
		return undefined;
	}
	if (decision === "approved" || decision === "approved_for_session")
		return { kind: "resolved", connectionId, result };
	if (decision === "timed_out") return { kind: "timedOut" };
	if (decision === "abort") return { kind: "cancelled", reason: "approval aborted" };
	if (isRecord(decision) && Object.hasOwn(decision, "denied")) return { kind: "denied", connectionId, result };
	if (
		isRecord(decision) &&
		(Object.hasOwn(decision, "approved_execpolicy_amendment") || Object.hasOwn(decision, "network_policy_amendment"))
	)
		return { kind: "cancelled", reason: "unsupported approval amendment" };
	return undefined;
}

/**
 * Brokers server->client requests (approvals, elicitations) to the eligible connection set.
 * Every request has one settlement promise. A valid response wins; invalid responses and
 * responses from ineligible connections leave the request pending for another responder.
 */
export class ServerRequestBroker {
	readonly #pending = new Map<string, PendingRequest>();
	readonly #settledIds = new Set<string>();
	readonly #requestTimeoutMs: number;
	readonly #now: () => number;
	readonly #setTimeout: (callback: () => void, milliseconds: number) => unknown;
	readonly #clearTimeout: (handle: unknown) => void;
	readonly #logger: BrokerLogger;
	#shutdown = false;

	constructor(options: BrokerOptions = {}) {
		const requested = options.requestTimeoutMs ?? DEFAULT_TIMEOUT;
		// A native timer clamps NaN/Infinity/values past 2^31-1 to about 1ms, which would turn a long
		// deadline into an immediate timeout. Reject those rather than silently mis-scheduling.
		if (!Number.isFinite(requested) || requested < 0 || requested > MAX_TIMEOUT_MS)
			throw new ServerRequestBrokerError(
				"invalid_timeout",
				`Server request timeout must be a finite value between 0 and ${MAX_TIMEOUT_MS}ms.`,
			);
		const requestTimeoutMs = requested;
		this.#requestTimeoutMs = requestTimeoutMs;
		this.#now = options.now ?? Date.now;
		this.#setTimeout = options.setTimeout ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
		this.#clearTimeout = options.clearTimeout ?? (handle => clearTimeout(handle as NodeJS.Timeout));
		this.#logger = options.logger ?? defaultLogger;
	}

	get pendingCount(): number {
		return this.#pending.size;
	}

	/** Look up a pending request without changing its lifecycle. */
	getPending(id: string): ServerRequest | undefined {
		return this.#pending.get(id)?.request;
	}

	/**
	 * Create a pending server request and return its request plus settlement promise. The
	 * returned value also exposes the request fields directly for callers on the old API.
	 */
	create(
		id: string,
		method: string,
		params: unknown,
		threadId: string,
		eligibleConnections: Set<string>,
	): ServerRequestHandle | undefined {
		if (this.#shutdown) throw new ServerRequestBrokerError("broker_shutdown", "Server request broker is shut down.");
		if (this.#pending.has(id) || this.#settledIds.has(id)) throw new DuplicateServerRequestError(id);
		if (eligibleConnections.size === 0) return undefined;

		const createdAt = this.#now();
		const timeoutMs = this.#requestTimeoutMs;
		const deadlineAt = createdAt + timeoutMs;
		let resolveSettlement!: SettlementResolver;
		const settled = new Promise<ServerRequestSettlement>(resolve => {
			resolveSettlement = resolve;
		});
		const mutableRequest = {
			id,
			method,
			params,
			threadId,
			eligibleConnections: new Set(eligibleConnections),
			status: "pending" as const,
			outcome: undefined,
			result: undefined,
			error: undefined,
			resolvedBy: undefined,
			settlement: undefined,
			createdAt,
			deadlineAt,
			request: undefined as unknown as ServerRequest,
			settled,
		};
		mutableRequest.request = mutableRequest;
		const request = mutableRequest as ServerRequestHandle;
		const pending: PendingRequest = { request, resolveSettlement, settled, timer: undefined };
		this.#pending.set(id, pending);
		const timer = this.#setTimeout(() => this.#settleTimeout(id), Math.max(0, timeoutMs));
		if (this.#pending.get(id) === pending) pending.timer = timer;
		else if (timer !== undefined) this.#clearTimeout(timer);
		return request;
	}

	/** Resolve a pending request with the first eligible, schema-valid response. */
	resolve(id: string, connectionId: string, result: unknown): boolean {
		const pending = this.#pending.get(id);
		if (!pending) {
			this.#logLate(id, connectionId);
			return false;
		}
		if (!pending.request.eligibleConnections.has(connectionId)) {
			this.#logger.warn("Ignoring app-server client response from ineligible connection", {
				connectionId,
				id,
				method: pending.request.method,
			});
			return false;
		}
		if (!this.#validateResult(pending.request.method, result)) {
			this.#logger.warn("Ignoring invalid app-server client response", {
				connectionId,
				id,
				method: pending.request.method,
			});
			return false;
		}
		const settlement = decisionSettlement(pending.request.method, connectionId, result);
		if (!settlement) {
			this.#logger.warn("Ignoring unclassifiable app-server client response", {
				connectionId,
				id,
				method: pending.request.method,
			});
			return false;
		}
		this.#settleResult(pending, settlement, result, connectionId);
		return true;
	}

	/** Resolve a pending request with a transport error from the first eligible responder. */
	resolveError(id: string, connectionId: string, error: ServerRequestError): boolean {
		const pending = this.#pending.get(id);
		if (!pending) {
			this.#logLate(id, connectionId);
			return false;
		}
		if (!pending.request.eligibleConnections.has(connectionId)) return false;
		pending.request.status = "resolved";
		pending.request.outcome = "error";
		pending.request.error = error;
		pending.request.resolvedBy = connectionId;
		this.#settle(pending, { kind: "cancelled", reason: error.message || "client error" });
		return true;
	}

	/** Remove a connection from a request's eligible set (on disconnect). */
	removeConnection(requestId: string, connectionId: string): "updated" | "cancelled" | "notFound" {
		const pending = this.#pending.get(requestId);
		if (!pending) return "notFound";
		if (!pending.request.eligibleConnections.delete(connectionId)) return "updated";
		if (pending.request.eligibleConnections.size === 0) {
			this.#settle(pending, { kind: "cancelled", reason: DISCONNECT_REASON });
			return "cancelled";
		}
		return "updated";
	}

	/** Remove a disconnected connection from every pending request. */
	handleDisconnect(connectionId: string): number {
		let cancelled = 0;
		for (const id of [...this.#pending.keys()]) {
			if (this.removeConnection(id, connectionId) === "cancelled") cancelled++;
		}
		return cancelled;
	}

	/** Cancel a request (on turn transition, interrupt, or explicit cancellation). */
	cancel(id: string, reason: string = DEFAULT_CANCEL_REASON): boolean {
		const pending = this.#pending.get(id);
		if (!pending) return false;
		this.#settle(pending, { kind: "cancelled", reason });
		return true;
	}

	/** Cancel all pending requests for a thread (on turn transition or thread eviction). */
	cancelAllForThread(threadId: string, reason: string = THREAD_EVICTION_REASON): number {
		let count = 0;
		for (const pending of [...this.#pending.values()]) {
			if (pending.request.threadId !== threadId) continue;
			this.#settle(pending, { kind: "cancelled", reason });
			count++;
		}
		return count;
	}

	/** Get all pending requests for a thread. */
	getPendingForThread(threadId: string): ServerRequest[] {
		return [...this.#pending.values()]
			.filter(pending => pending.request.threadId === threadId)
			.map(pending => pending.request);
	}

	/** Clean up expired requests (past their timeout). The real timer also settles them. */
	cleanupExpired(): number {
		const now = this.#now();
		let count = 0;
		for (const pending of [...this.#pending.values()]) {
			if (now < pending.request.deadlineAt) continue;
			this.#settleTimeout(pending.request.id);
			count++;
		}
		return count;
	}

	/** Settle every pending request as cancelled and stop accepting new requests. */
	shutdown(): number {
		if (this.#shutdown) return 0;
		this.#shutdown = true;
		let count = 0;
		for (const pending of [...this.#pending.values()]) {
			this.#settle(pending, { kind: "cancelled", reason: SHUTDOWN_REASON });
			count++;
		}
		return count;
	}

	#validateResult(method: string, result: unknown): boolean {
		const stable = stableValidators.serverRequestResults[method];
		const experimental = experimentalValidators.serverRequestResults[method];
		try {
			return Boolean(stable?.(result) || experimental?.(result));
		} catch {
			return false;
		}
	}

	#settleResult(
		pending: PendingRequest,
		settlement: ServerRequestSettlement,
		result: unknown,
		connectionId: string,
	): void {
		if (settlement.kind === "timedOut" || settlement.kind === "cancelled") {
			this.#settle(pending, settlement);
			return;
		}
		pending.request.status = "resolved";
		pending.request.outcome = "result";
		pending.request.result = result;
		pending.request.resolvedBy = connectionId;
		this.#settle(pending, settlement);
	}

	#settleTimeout(id: string): void {
		const pending = this.#pending.get(id);
		if (!pending) return;
		this.#settle(pending, { kind: "timedOut" });
	}

	#settle(pending: PendingRequest, settlement: ServerRequestSettlement): void {
		// Delete before publishing the settlement so every terminal path is fenced synchronously.
		if (!this.#pending.delete(pending.request.id)) return;
		this.#settledIds.add(pending.request.id);
		// A Set preserves insertion order, so dropping from the front evicts the oldest ids first.
		while (this.#settledIds.size > SETTLED_ID_RETENTION) {
			const oldest = this.#settledIds.values().next();
			if (oldest.done) break;
			this.#settledIds.delete(oldest.value);
		}
		if (pending.timer !== undefined) {
			// Cleanup is best effort: an injected timer seam that throws must never prevent the
			// waiter below from being settled.
			try {
				this.#clearTimeout(pending.timer);
			} catch (error) {
				this.#logger.warn("Server request timer cleanup failed", {
					id: pending.request.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		pending.request.settlement = settlement;
		if ((settlement.kind === "cancelled" || settlement.kind === "timedOut") && pending.request.status === "pending")
			pending.request.status = "cancelled";
		pending.resolveSettlement(settlement);
	}

	#logLate(id: string, connectionId: string): void {
		if (!this.#settledIds.has(id)) return;
		this.#logger.warn("Ignoring late app-server client response", { connectionId, id });
	}
}

import { randomUUID } from "node:crypto";

export type SdkErrorCode =
	| "invalid_input"
	| "unknown_operation"
	| "not_found"
	| "unavailable"
	| "timeout"
	| "connection_closed"
	| "endpoint_credential_forbidden"
	| "uncertain_after_send"
	| (string & {});

export class SdkClientError extends Error {
	readonly code: SdkErrorCode;
	readonly details: unknown;
	constructor(code: SdkErrorCode, message: string, details?: unknown) {
		super(message);
		this.name = "SdkClientError";
		this.code = code;
		this.details = details;
	}
}

export interface SdkClientOptions {
	timeoutMs?: number;
	/** Absolute wall-clock deadline shared by connect, hello, retry, and request work. */
	deadline?: number;

	reconnectAttempts?: number;
	reconnectBackoffMs?: number;
	/**
	 * Per-attempt ceiling for the exponential reconnect backoff. A long reconnect
	 * budget must keep probing frequently instead of sleeping for tens of seconds
	 * on its last attempts. Defaults to 2s.
	 */
	reconnectMaxBackoffMs?: number;
}

export interface SdkRequestOptions {
	timeoutMs?: number;
	idempotencyKey?: string;
	confirm?: boolean;
	elevationRequestId?: string;
}

export type SdkFrame = Record<string, unknown>;

export interface SdkSentRecord {
	readonly id: string;
	readonly operation?: string;
	readonly idempotencyKey?: string;
	readonly fingerprint: string;
}
export type SdkFrameHandler = (frame: SdkFrame) => void;
export type SdkReconnectHandler = () => void;
export type SdkReconnectFailedHandler = (error: SdkClientError) => void;

/** One ordered operation submitted after durable client-side create orchestration. */
export type SdkDurableSubmission =
	| { kind: "prompt"; text: string; images?: unknown; clientRef: string }
	| { kind: "skill"; name: string; args?: unknown; clientRef: string };

/**
 * Durable client-side orchestration input. The create key and submission reference
 * are durable in their respective authorities; restart recovery reconciles them.
 * This is not a single-authority transactional atomicity guarantee across failure.
 */
export interface SdkDurableCreateConnectSubmitInput {
	create: Record<string, unknown>;
	createIdempotencyKey: string;
	submission: SdkDurableSubmission;
	timeoutMs?: number;
	replaySinceGeneration?: number;
	replaySinceSeq?: number;
}

/** Safe, canonical recovery identity without create credentials or MCP replay material. */
export interface SdkDurableLookupIdentity {
	version: 1;
	operation: "session.create";
	createIdempotencyKey: string;
	sessionId?: string;
	endpointGeneration?: number;
	endpointIncarnation?: string;
	submission: { kind: SdkDurableSubmission["kind"]; clientRef: string };
	commandId?: string;
	turnId?: string;
}

/** Options for reconciling a prior durable orchestration. The create input is
 *  supplied separately by the caller and is only used when the identity has no
 *  sessionId; it is never stored on or serialized through the identity. */
export interface SdkDurableReconcileOptions extends SdkRequestOptions {
	create?: Record<string, unknown>;
}

/** Durable client-side orchestration outcome, including reconciliation-required uncertainty. */
export type SdkDurableResult =
	| { kind: "accepted"; sessionId: string; identity: SdkDurableLookupIdentity; receipt: Record<string, unknown> }
	| { kind: "reconciled"; identity: SdkDurableLookupIdentity; status: Record<string, unknown> }
	| {
			kind: "create_uncertain" | "attachment_uncertain" | "subscription_uncertain" | "submission_uncertain";
			identity: SdkDurableLookupIdentity;
			nextLegalLookupAction: "reconcileCreateConnectSubmit";
			prohibitResubmission: true;
	  }
	| { kind: "failed"; error: { code: SdkErrorCode; message: string }; identity?: SdkDurableLookupIdentity };

type Frame = SdkFrame;
type Cycle = {
	readonly generation: number;
	phase: "opening" | "backoff" | "complete" | "aborted";
	candidate: Incarnation | null;
	promise?: Promise<Incarnation>;
	backoffTimer?: ReturnType<typeof setTimeout>;
	rejectBackoff?: (error: Error) => void;
};
type Incarnation = {
	readonly generation: number;
	readonly cycle: Cycle;
	readonly socket: WebSocket;
	phase: "opening" | "hello" | "active" | "retired";
	tornDown: boolean;
	openTimer?: ReturnType<typeof setTimeout>;
	failure?: Error;
	helloTimer?: ReturnType<typeof setTimeout>;
	/** Hello frames that arrived before the open handler advanced phase to "hello". */
	earlyHello?: Frame;
	resolveOpen?: () => void;
	rejectOpen?: (error: Error) => void;
	resolveHello?: () => void;
	rejectHello?: (error: Error) => void;
	listeners: Array<["open" | "error" | "close" | "message", EventListener]>;
};
type Pending = {
	readonly incarnation: Incarnation;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	sent: boolean;
};

/**
 * Transport facts attached to an SdkClientError with code "timeout" for a request.
 * `requestSent` proves only that WebSocket.send() returned; it never proves server acceptance.
 */
export interface SdkRequestTimeoutDetails {
	requestId: string;
	requestSent: boolean;
}

function errorFrom(frame: Frame): SdkClientError {
	const error = frame.error;
	if (error && typeof error === "object") {
		const detail = error as { code?: unknown; message?: unknown };
		return new SdkClientError(
			typeof detail.code === "string" ? detail.code : "unavailable",
			typeof detail.message === "string" ? detail.message : "SDK request failed",
			error,
		);
	}
	return new SdkClientError("unavailable", "SDK request failed", error);
}

function parseFrame(value: unknown): Frame {
	try {
		const frame = JSON.parse(String(value));
		if (frame && typeof frame === "object" && !Array.isArray(frame)) return frame as Frame;
	} catch (error) {
		throw new SdkClientError("protocol_error", "SDK server sent malformed JSON.", error);
	}
	throw new SdkClientError("protocol_error", "SDK server sent a malformed frame.");
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.filter(key => record[key] !== undefined)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

function lifecycleFingerprint(operation: string, input: unknown): string {
	return JSON.stringify({ operation, input: JSON.parse(JSON.stringify(input)) });
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
	const candidate = value[field];
	return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function responseResult(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new SdkClientError("protocol_error", "SDK response is malformed.");
	const frame = value as Record<string, unknown>;
	const result = frame.result;
	return result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : frame;
}

function validClientRef(value: unknown): value is string {
	return typeof value === "string" && value.trim() === value && value.length >= 1 && value.length <= 128;
}

function validNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

const durableCreateFields = new Set([
	"cwd",
	"path",
	"target",
	"stateRoot",
	"modelPreset",
	"mcpServers",
	"readiness",
	"readinessTimeoutMs",
	"coordinatorStateDir",
	"coordinatorSessionId",
	"coordinatorSessionBranch",
]);
const durableTargetFields = new Set(["path", "stateRoot", "worktree"]);

function canonicalCreate(create: Record<string, unknown>): Record<string, unknown> {
	const canonicalize = (value: unknown, seen: Set<object>): unknown => {
		if (value === null || typeof value === "string" || typeof value === "boolean") return value;
		if (typeof value === "number") {
			if (!Number.isFinite(value)) throw new SdkClientError("invalid_input", "Create input must be JSON-safe.");
			return value;
		}
		if (Array.isArray(value)) {
			if (seen.has(value)) throw new SdkClientError("invalid_input", "Create input must not be cyclic.");
			seen.add(value);
			const result = value.map(item => canonicalize(item, seen));
			seen.delete(value);
			return result;
		}
		if (!isRecord(value)) throw new SdkClientError("invalid_input", "Create input must be JSON-safe.");
		if (seen.has(value)) throw new SdkClientError("invalid_input", "Create input must not be cyclic.");
		seen.add(value);
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key], seen);
		seen.delete(value);
		return result;
	};
	for (const key of Object.keys(create)) {
		if (!durableCreateFields.has(key))
			throw new SdkClientError("invalid_input", `Unsupported session.create field: ${key}.`);
	}
	if (create.target !== undefined) {
		if (!isRecord(create.target)) throw new SdkClientError("invalid_input", "Create target must be an object.");
		for (const key of Object.keys(create.target)) {
			if (!durableTargetFields.has(key))
				throw new SdkClientError("invalid_input", `Unsupported session.create target field: ${key}.`);
		}
	}
	return canonicalize(create, new Set()) as Record<string, unknown>;
}

function validTimeout(value: unknown): boolean {
	return value === undefined || (typeof value === "number" && Number.isFinite(value) && value > 0);
}

function validReplayCursor(value: unknown): boolean {
	return value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function durableIdentity(input: SdkDurableCreateConnectSubmitInput): SdkDurableLookupIdentity {
	if (!isRecord(input.create)) throw new SdkClientError("invalid_input", "Create input must be an object.");
	if (!validClientRef(input.createIdempotencyKey))
		throw new SdkClientError("invalid_input", "createIdempotencyKey must be a trimmed non-empty string.");
	if (!validTimeout(input.timeoutMs))
		throw new SdkClientError("invalid_input", "timeoutMs must be a positive finite number.");
	if (!validReplayCursor(input.replaySinceGeneration) || !validReplayCursor(input.replaySinceSeq))
		throw new SdkClientError("invalid_input", "Replay cursors must be non-negative safe integers.");
	const submission = input.submission;
	if (!submission || !validClientRef(submission.clientRef))
		throw new SdkClientError("invalid_input", "clientRef must be a trimmed 1..128 character string.");
	if (submission.kind === "prompt") {
		if (!validNonEmptyString(submission.text) || "name" in submission || "args" in submission)
			throw new SdkClientError("invalid_input", "Prompt submission is invalid.");
	} else if (submission.kind === "skill") {
		if (!validNonEmptyString(submission.name) || "text" in submission || "images" in submission)
			throw new SdkClientError("invalid_input", "Skill submission is invalid.");
	} else {
		throw new SdkClientError("invalid_input", "Submission is invalid.");
	}
	// Validate create input shape without retaining it on the identity. The full
	// create payload is sent to the broker on session.create; it is not stored on
	// the public identity, which carries only non-secret lookup fields.
	canonicalCreate(input.create);
	return {
		version: 1,
		operation: "session.create",
		createIdempotencyKey: input.createIdempotencyKey,
		submission: { kind: submission.kind, clientRef: submission.clientRef },
	};
}
function validDurableIdentity(identity: unknown): identity is SdkDurableLookupIdentity {
	if (!isRecord(identity) || !isRecord(identity.submission)) return false;
	return (
		identity.version === 1 &&
		identity.operation === "session.create" &&
		validClientRef(identity.createIdempotencyKey) &&
		validClientRef(identity.submission.clientRef) &&
		(identity.submission.kind === "prompt" || identity.submission.kind === "skill")
	);
}

function isKnownLifecycleFailure(error: SdkClientError): boolean {
	return ["invalid_input", "idempotency_conflict", "endpoint_stale", "resource_gone", "not_found"].includes(
		error.code,
	);
}

function durableFailure(error: unknown, identity?: SdkDurableLookupIdentity): SdkDurableResult {
	const typed =
		error instanceof SdkClientError
			? error
			: new SdkClientError("invalid_input", "Durable orchestration input is invalid.");
	return { kind: "failed", error: { code: typed.code, message: typed.message }, ...(identity ? { identity } : {}) };
}

function uncertain(
	kind: Extract<SdkDurableResult, { prohibitResubmission: true }>["kind"],
	identity: SdkDurableLookupIdentity,
): SdkDurableResult {
	return { kind, identity, nextLegalLookupAction: "reconcileCreateConnectSubmit", prohibitResubmission: true };
}

function replayReady(
	replay: Record<string, unknown>,
	liveEvents: readonly Frame[],
	sinceGeneration: number,
	sinceSeq: number,
): boolean {
	if (replay.gap !== undefined || !Array.isArray(replay.events)) return false;
	if (
		typeof replay.generation !== "number" ||
		!Number.isSafeInteger(replay.generation) ||
		replay.generation < 0 ||
		replay.generation !== sinceGeneration ||
		typeof replay.lastSeq !== "number" ||
		!Number.isSafeInteger(replay.lastSeq) ||
		replay.lastSeq < sinceSeq
	)
		return false;
	for (const event of [...(replay.events as Frame[]), ...liveEvents]) {
		if (
			event.type !== "event" ||
			typeof event.generation !== "number" ||
			event.generation !== replay.generation ||
			typeof event.seq !== "number" ||
			!Number.isSafeInteger(event.seq) ||
			event.seq <= sinceSeq
		)
			return false;
	}
	// `lastSeq` is the host's global cursor. Capability-gated events are absent
	// from this connection's replay, so only an explicit host gap can invalidate
	// the same-incarnation replay barrier.
	return true;
}

function isConnectionFailure(error: unknown): boolean {
	return (
		error instanceof SdkClientError &&
		["connection_closed", "unavailable", "timeout", "reconnect_exhausted"].includes(error.code)
	);
}

function endpointGeneration(endpoint: Record<string, unknown>): number | undefined {
	const generation = endpoint.generation ?? endpoint.endpointGeneration;
	return typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 0
		? generation
		: undefined;
}

function endpointIncarnation(endpoint: Record<string, unknown>): string | undefined {
	return typeof endpoint.endpointIncarnation === "string" && /^[a-f0-9]{64}$/.test(endpoint.endpointIncarnation)
		? endpoint.endpointIncarnation
		: undefined;
}

function statusIsKnown(status: Record<string, unknown>): boolean {
	return ["accepted", "in_flight", "terminal_ok", "failed", "unknown"].includes(String(status.status));
}

/** A transport-only v3 SDK WebSocket client with no host or session authority. */
export class SdkClient {
	readonly #url: string;
	readonly #token: string;
	readonly #timeoutMs: number;
	readonly #reconnectAttempts: number;
	readonly #reconnectBackoffMs: number;
	readonly #reconnectMaxBackoffMs: number;
	/**
	 * Bounded grace for best-effort transport close, independent of the request
	 * deadline. Close teardown must never be gated by an already-elapsed operation
	 * deadline, or the socket leaks.
	 */
	readonly #closeGraceMs: number;
	readonly #deadline?: number;
	#currentSocketRecord: Incarnation | null = null;
	#opening: Cycle | null = null;
	#cycleGeneration = 0;
	#incarnationGeneration = 0;
	#sentRecords = new Map<string, SdkSentRecord>();
	#pending = new Map<string, Pending>();
	#frameHandlers = new Set<SdkFrameHandler>();
	#reconnectHandlers = new Set<SdkReconnectHandler>();
	#reconnectFailedHandlers = new Set<SdkReconnectFailedHandler>();
	#closePromise: Promise<void> | undefined;

	#closed = false;
	connectionId?: string;

	constructor(url: string, token: string, options: SdkClientOptions = {}) {
		this.#url = url;
		this.#token = token;
		this.#timeoutMs = options.timeoutMs ?? 10_000;
		this.#closeGraceMs = Math.max(1, Math.min(this.#timeoutMs, 1_000));
		this.#deadline =
			typeof options.deadline === "number" && Number.isFinite(options.deadline) ? options.deadline : undefined;

		this.#reconnectAttempts = options.reconnectAttempts ?? 3;
		this.#reconnectBackoffMs = options.reconnectBackoffMs ?? 25;
		this.#reconnectMaxBackoffMs = Math.max(this.#reconnectBackoffMs, options.reconnectMaxBackoffMs ?? 2_000);
	}

	static async connect(url: string, token: string, options: SdkClientOptions = {}): Promise<SdkClient> {
		const client = new SdkClient(url, token, options);
		await client.connect();
		return client;
	}

	async connect(): Promise<void> {
		await this.#connect();
	}

	/** Resolves once the current WebSocket has received its server hello frame. */
	async awaitHello(): Promise<void> {
		await this.#connect();
	}

	onFrame(handler: SdkFrameHandler): () => void {
		this.#frameHandlers.add(handler);
		return () => this.#frameHandlers.delete(handler);
	}

	onReconnect(handler: SdkReconnectHandler): () => void {
		this.#reconnectHandlers.add(handler);
		return () => this.#reconnectHandlers.delete(handler);
	}

	onReconnectFailed(handler: SdkReconnectFailedHandler): () => void {
		this.#reconnectFailedHandlers.add(handler);
		return () => this.#reconnectFailedHandlers.delete(handler);
	}

	send(frame: SdkFrame): void {
		if (this.#closed) throw new SdkClientError("connection_closed", "SDK client closed");
		this.#throwIfDeadlineElapsed();
		const current = this.#currentSocketRecord ?? this.#opening?.candidate;
		const authoritative =
			this.#isActive(current ?? null) ||
			(!!current && current.phase === "hello" && this.#isCandidate(current.cycle, current));
		if (!current || !authoritative || current.socket.readyState !== WebSocket.OPEN)
			throw new SdkClientError("connection_closed", "SDK WebSocket is not connected");
		try {
			current.socket.send(JSON.stringify(frame));
		} catch (error) {
			throw new SdkClientError("unavailable", "SDK WebSocket send failed", error);
		}
	}

	request(frame: SdkFrame, timeout?: number | { timeoutMs?: number; idempotencyKey?: string }): Promise<SdkFrame> {
		const options = typeof timeout === "number" ? { timeoutMs: timeout } : (timeout ?? {});
		return this.#request(frame, options) as Promise<SdkFrame>;
	}

	close(): Promise<void> {
		this.#closePromise ??= this.#close();
		return this.#closePromise;
	}
	async #close(): Promise<void> {
		this.#closed = true;

		const transports = new Set<Incarnation>();
		const cycle = this.#opening;
		if (cycle) {
			cycle.phase = "aborted";
			if (cycle.backoffTimer) clearTimeout(cycle.backoffTimer);
			if (cycle.candidate) {
				transports.add(cycle.candidate);
				this.#retire(cycle.candidate, new SdkClientError("connection_closed", "SDK client closed"), false);
			}
			cycle.rejectBackoff?.(new SdkClientError("connection_closed", "SDK client closed"));
			cycle.rejectBackoff = undefined;
			if (this.#opening === cycle) this.#opening = null;
		}
		const current = this.#currentSocketRecord;
		if (current) {
			transports.add(current);
			this.#retire(current, new SdkClientError("connection_closed", "SDK client closed"), false);
		}
		for (const [id, pending] of this.#pending)
			this.#settlePending(id, pending, new SdkClientError("connection_closed", "SDK client closed"));
		await Promise.all([...transports].map(incarnation => this.#closeTransport(incarnation)));
		this.#sentRecords.clear();
	}

	/** Durable client-side orchestration; failures recover by reconciliation, not transaction rollback. */
	async createConnectSubscribeSubmit(input: SdkDurableCreateConnectSubmitInput): Promise<SdkDurableResult> {
		let identity: SdkDurableLookupIdentity;
		try {
			identity = durableIdentity(input);
		} catch (error) {
			return durableFailure(error);
		}
		let created: Record<string, unknown>;
		try {
			created = responseResult(
				await this.global("session.create", canonicalCreate(input.create), {
					idempotencyKey: identity.createIdempotencyKey,
					timeoutMs: input.timeoutMs,
				}),
			);
		} catch (error) {
			return error instanceof SdkClientError && isKnownLifecycleFailure(error)
				? durableFailure(new SdkClientError(error.code, "Durable session creation failed."), identity)
				: uncertain("create_uncertain", identity);
		}
		const sessionId = stringField(created, "sessionId");
		if (!sessionId) return uncertain("create_uncertain", identity);
		identity = {
			...identity,
			sessionId,
			...(endpointGeneration(created) === undefined ? {} : { endpointGeneration: endpointGeneration(created) }),
			...(endpointIncarnation(created) === undefined ? {} : { endpointIncarnation: endpointIncarnation(created) }),
		};
		let endpoint: Record<string, unknown>;
		try {
			endpoint = responseResult(
				await this.global(
					"session.get_endpoint",
					{
						sessionId,
						...(identity.endpointGeneration === undefined
							? {}
							: { endpointGeneration: identity.endpointGeneration }),
						...(identity.endpointIncarnation === undefined
							? {}
							: { endpointIncarnation: identity.endpointIncarnation }),
					},
					{ timeoutMs: input.timeoutMs },
				),
			);
		} catch {
			return uncertain("attachment_uncertain", identity);
		}
		const url = stringField(endpoint, "url");
		const token = stringField(endpoint, "token");
		if (!url || !token) return uncertain("attachment_uncertain", identity);
		identity = {
			...identity,
			...(endpointGeneration(endpoint) === undefined ? {} : { endpointGeneration: endpointGeneration(endpoint) }),
			...(endpointIncarnation(endpoint) === undefined ? {} : { endpointIncarnation: endpointIncarnation(endpoint) }),
		};
		const endpointClient = new SdkClient(url, token, {
			timeoutMs: input.timeoutMs,
			deadline: this.#deadline,
			reconnectAttempts: 0,
		});
		const liveEvents: Frame[] = [];
		const detach = endpointClient.onFrame(frame => {
			if (frame.type === "event") liveEvents.push(frame);
		});
		let submissionStarted = false;
		try {
			const incarnation = await endpointClient.#connect();
			const replayGeneration = input.replaySinceGeneration ?? identity.endpointGeneration ?? 1;
			const replaySeq = input.replaySinceSeq ?? 0;
			const replay = await endpointClient.#requestOnIncarnation(
				{
					type: "event_replay",
					sinceGeneration: replayGeneration,
					sinceSeq: replaySeq,
				},
				incarnation,
				{ timeoutMs: input.timeoutMs },
			);
			if (!replayReady(responseResult(replay), liveEvents, replayGeneration, replaySeq))
				return uncertain("subscription_uncertain", identity);
			const operation = input.submission.kind === "prompt" ? "turn.prompt" : "skill.invoke";
			const controlInput =
				input.submission.kind === "prompt"
					? {
							text: input.submission.text,
							...(input.submission.images === undefined ? {} : { images: input.submission.images }),
							clientRef: input.submission.clientRef,
						}
					: {
							name: input.submission.name,
							...(input.submission.args === undefined ? {} : { args: input.submission.args }),
							clientRef: input.submission.clientRef,
						};
			const response = responseResult(
				await endpointClient.#requestOnIncarnation(
					{ type: "control_request", operation, input: controlInput },
					incarnation,
					{ timeoutMs: input.timeoutMs, onWrite: () => (submissionStarted = true) },
				),
			);
			const commandId = stringField(response, "commandId");
			const turnId = stringField(response, "turnId");
			identity = { ...identity, ...(commandId ? { commandId } : {}), ...(turnId ? { turnId } : {}) };
			return { kind: "accepted", sessionId, identity, receipt: response };
		} catch (error) {
			if (submissionStarted) return uncertain("submission_uncertain", identity);
			return uncertain(isConnectionFailure(error) ? "attachment_uncertain" : "subscription_uncertain", identity);
		} finally {
			detach();
			await endpointClient.close().catch(() => undefined);
		}
	}

	/** Reconcile a prior durable client-side orchestration outcome without resubmitting ordered work. */
	async reconcileCreateConnectSubmit(
		identity: SdkDurableLookupIdentity,
		options: SdkDurableReconcileOptions = {},
	): Promise<SdkDurableResult> {
		if (!validDurableIdentity(identity))
			return durableFailure(new SdkClientError("invalid_input", "Invalid durable lookup identity."));
		let recovered = identity;
		if (!recovered.sessionId) {
			// The identity intentionally carries no create replay material. The
			// caller must supply the original create separately so the broker's
			// idempotency key can resolve the prior create; without it, recovery
			// cannot safely replay and must report uncertainty.
			if (!options.create) return uncertain("create_uncertain", recovered);
			try {
				const created = responseResult(
					await this.global("session.create", canonicalCreate(options.create), {
						idempotencyKey: recovered.createIdempotencyKey,
						timeoutMs: options.timeoutMs,
					}),
				);
				const sessionId = stringField(created, "sessionId");
				if (!sessionId) return uncertain("create_uncertain", recovered);
				recovered = {
					...recovered,
					sessionId,
					...(endpointGeneration(created) === undefined
						? {}
						: { endpointGeneration: endpointGeneration(created) }),
					...(endpointIncarnation(created) === undefined
						? {}
						: { endpointIncarnation: endpointIncarnation(created) }),
				};
			} catch (error) {
				return error instanceof SdkClientError && isKnownLifecycleFailure(error)
					? durableFailure(error, recovered)
					: uncertain("create_uncertain", recovered);
			}
		}
		try {
			const endpoint = responseResult(
				await this.global(
					"session.get_endpoint",
					{
						sessionId: recovered.sessionId,
						...(recovered.endpointGeneration === undefined
							? {}
							: { endpointGeneration: recovered.endpointGeneration }),
						...(recovered.endpointIncarnation === undefined
							? {}
							: { endpointIncarnation: recovered.endpointIncarnation }),
					},
					options,
				),
			);
			const url = stringField(endpoint, "url");
			const token = stringField(endpoint, "token");
			if (!url || !token) return uncertain("attachment_uncertain", recovered);
			recovered = {
				...recovered,
				...(endpointGeneration(endpoint) === undefined ? {} : { endpointGeneration: endpointGeneration(endpoint) }),
				...(endpointIncarnation(endpoint) === undefined
					? {}
					: { endpointIncarnation: endpointIncarnation(endpoint) }),
			};
			const client = new SdkClient(url, token, {
				timeoutMs: options.timeoutMs,
				deadline: this.#deadline,
				reconnectAttempts: 0,
			});
			try {
				const incarnation = await client.#connect();
				const replayGeneration = recovered.endpointGeneration ?? 1;
				await client
					.#requestOnIncarnation(
						{ type: "event_replay", sinceGeneration: replayGeneration, sinceSeq: 0 },
						incarnation,
						options,
					)
					.catch(() => undefined);
				const query = recovered.submission.kind === "prompt" ? "turn.prompt_status" : "skill.invoke_status";
				const status = responseResult(
					await (client.#isActive(incarnation) && incarnation.socket.readyState === WebSocket.OPEN
						? client.#requestOnIncarnation(
								{ type: "query_request", query, input: { clientRef: recovered.submission.clientRef } },
								incarnation,
								options,
							)
						: client.query(query, { clientRef: recovered.submission.clientRef }, undefined, options)),
				);
				return statusIsKnown(status)
					? { kind: "reconciled", identity: recovered, status }
					: uncertain("submission_uncertain", recovered);
			} finally {
				await client.close().catch(() => undefined);
			}
		} catch (error) {
			return uncertain(isConnectionFailure(error) ? "attachment_uncertain" : "submission_uncertain", recovered);
		}
	}

	async control(
		operation: string,
		input: Record<string, unknown> = {},
		options: SdkRequestOptions = {},
	): Promise<unknown> {
		return await this.#request(
			{
				type: "control_request",
				operation,
				input,
				...(options.confirm === undefined ? {} : { confirm: options.confirm }),
				...(options.elevationRequestId === undefined ? {} : { elevationRequestId: options.elevationRequestId }),
			},
			options,
		);
	}

	async query(
		query: string,
		input: Record<string, unknown> = {},
		cursor?: string,
		options: SdkRequestOptions = {},
	): Promise<unknown> {
		return await this.#request(
			{ type: "query_request", query, input, ...(cursor === undefined ? {} : { cursor }) },
			options,
		);
	}

	async global(
		operation: string,
		input: Record<string, unknown> = {},
		options: SdkRequestOptions = {},
	): Promise<unknown> {
		return await this.#request(
			{
				type: "broker_request",
				operation,
				input,
				...(options.elevationRequestId === undefined ? {} : { elevationRequestId: options.elevationRequestId }),
			},
			options,
		);
	}

	getSentRecord(id: string): SdkSentRecord | undefined {
		return this.#sentRecords.get(id);
	}
	#rememberSentRecord(record: SdkSentRecord): void {
		this.#sentRecords.set(record.id, record);
		while (this.#sentRecords.size > 256) this.#sentRecords.delete(this.#sentRecords.keys().next().value!);
	}

	async lookupLifecycle(record: SdkSentRecord, timeoutMs?: number): Promise<unknown> {
		if (!record.operation || !record.idempotencyKey)
			throw new SdkClientError("invalid_input", "A lifecycle sent record requires operation and idempotencyKey.");
		return await this.#request(
			{
				type: "broker_request",
				operation: "broker.lookup_lifecycle",
				input: { operation: record.operation, fingerprint: record.fingerprint },
			},
			{ timeoutMs, idempotencyKey: record.idempotencyKey },
		);
	}

	async #request(frame: Frame, options: SdkRequestOptions): Promise<unknown> {
		if (this.#closed) throw new SdkClientError("connection_closed", "SDK client closed");
		this.#throwIfDeadlineElapsed();
		const incarnation = await this.#connect();
		const timeoutMs = this.#remainingTimeout(options.timeoutMs ?? this.#timeoutMs);
		if (timeoutMs <= 0) throw this.#deadlineError();
		const id = randomUUID();
		const requestFrame = {
			...frame,
			id,
			...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
		};
		const serializedRequest = JSON.stringify(requestFrame);
		const serializedFrame = JSON.parse(serializedRequest) as Frame;
		return await new Promise<unknown>((resolve, reject) => {
			const pending: Pending = {
				incarnation,
				resolve,
				reject,
				sent: false,
				timer: setTimeout(
					() =>
						this.#settlePending(
							id,
							pending,
							new SdkClientError("timeout", `SDK request timed out after ${timeoutMs}ms`, {
								requestId: id,
								requestSent: pending.sent,
							} satisfies SdkRequestTimeoutDetails),
						),
					timeoutMs,
				),
			};
			this.#pending.set(id, pending);
			if (!this.#isActive(incarnation) || incarnation.socket.readyState !== WebSocket.OPEN) {
				this.#settlePending(id, pending, new SdkClientError("unavailable", "SDK WebSocket is not connected"));
				return;
			}
			try {
				incarnation.socket.send(serializedRequest);
				pending.sent = true;
				this.#rememberSentRecord({
					id,
					operation: typeof serializedFrame.operation === "string" ? serializedFrame.operation : undefined,
					idempotencyKey: options.idempotencyKey,
					fingerprint:
						typeof serializedFrame.operation === "string"
							? lifecycleFingerprint(serializedFrame.operation, serializedFrame.input ?? {})
							: canonicalJson(serializedFrame.input ?? {}),
				});
			} catch (error) {
				this.#settlePending(
					id,
					pending,
					error instanceof SdkClientError
						? error
						: new SdkClientError("unavailable", "SDK WebSocket send failed", error),
				);
			}
		});
	}

	#requestOnIncarnation(
		frame: Frame,
		incarnation: Incarnation,
		options: SdkRequestOptions & { onWrite?: () => void },
	): Promise<SdkFrame> {
		if (this.#closed || !this.#isActive(incarnation) || incarnation.socket.readyState !== WebSocket.OPEN)
			return Promise.reject(
				new SdkClientError("connection_closed", "SDK WebSocket incarnation is no longer active"),
			);
		const timeoutMs = this.#remainingTimeout(options.timeoutMs ?? this.#timeoutMs);
		if (timeoutMs <= 0) return Promise.reject(this.#deadlineError());
		const id = randomUUID();
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const pending: Pending = {
			incarnation,
			resolve,
			reject,
			sent: false,
			timer: setTimeout(
				() =>
					this.#settlePending(
						id,
						pending,
						new SdkClientError("timeout", `SDK request timed out after ${timeoutMs}ms`),
					),
				timeoutMs,
			),
		};
		this.#pending.set(id, pending);
		if (!this.#isActive(incarnation) || incarnation.socket.readyState !== WebSocket.OPEN) {
			this.#settlePending(
				id,
				pending,
				new SdkClientError("connection_closed", "SDK WebSocket incarnation is no longer active"),
			);
			return promise as Promise<SdkFrame>;
		}
		try {
			incarnation.socket.send(
				JSON.stringify({
					...frame,
					id,
					...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
				}),
			);
			pending.sent = true;
			options.onWrite?.();
		} catch (error) {
			this.#settlePending(id, pending, new SdkClientError("unavailable", "SDK WebSocket send failed", error));
		}
		return promise as Promise<SdkFrame>;
	}

	#deadlineError(): SdkClientError {
		return new SdkClientError("timeout", "SDK client deadline elapsed.");
	}

	#remainingTimeout(limit = this.#timeoutMs): number {
		if (this.#deadline === undefined) return limit;
		return Math.min(limit, Math.max(0, this.#deadline - Date.now()));
	}

	#throwIfDeadlineElapsed(): void {
		if (this.#deadline !== undefined && Date.now() >= this.#deadline) throw this.#deadlineError();
	}

	async #connect(): Promise<Incarnation> {
		this.#throwIfDeadlineElapsed();
		const current = this.#currentSocketRecord;
		if (current && this.#isActive(current) && current.socket.readyState === WebSocket.OPEN) return current;
		if (current)
			this.#retire(current, new SdkClientError("connection_closed", "SDK WebSocket connection closed"), true);
		let cycle = this.#opening;
		if (!cycle) {
			cycle = { generation: ++this.#cycleGeneration, phase: "opening", candidate: null };
			this.#opening = cycle;
			cycle.promise = this.#openWithRetry(cycle);
		}
		return await cycle.promise!;
	}

	async #openWithRetry(cycle: Cycle): Promise<Incarnation> {
		let lastError: unknown;
		for (let attempt = 0; attempt <= this.#reconnectAttempts; attempt++) {
			if (this.#deadline !== undefined && Date.now() >= this.#deadline) {
				const error = this.#deadlineError();
				this.#completeCycle(cycle, error);
				throw error;
			}
			if (!this.#isOpening(cycle)) throw new SdkClientError("connection_closed", "SDK client closed");
			try {
				const incarnation = await this.#open(cycle);
				if (!this.#isActive(incarnation) && (!this.#isOpening(cycle) || cycle.candidate !== incarnation))
					throw new SdkClientError("connection_closed", "SDK WebSocket is not connected");
				await this.#waitForHello(incarnation);
				if (this.#isActive(incarnation)) return incarnation;
				throw new SdkClientError("connection_closed", "SDK WebSocket is not connected");
			} catch (error) {
				lastError = error;
				if (!this.#isOpening(cycle)) throw error;
				const candidate = cycle.candidate;
				if (candidate && candidate.phase !== "active")
					this.#retire(
						candidate,
						error instanceof SdkClientError
							? error
							: new SdkClientError("unavailable", "SDK WebSocket connection failed", error),
						true,
					);
				if (attempt < this.#reconnectAttempts) {
					const backoffMs = this.#remainingTimeout(
						Math.min(this.#reconnectBackoffMs * 2 ** attempt, this.#reconnectMaxBackoffMs),
					);
					if (backoffMs <= 0) break;
					cycle.phase = "backoff";
					await new Promise<void>((resolve, reject) => {
						cycle.rejectBackoff = reject;
						cycle.backoffTimer = setTimeout(resolve, backoffMs);
					});
					cycle.rejectBackoff = undefined;
					cycle.backoffTimer = undefined;
					if (!this.#isOpening(cycle)) throw new SdkClientError("connection_closed", "SDK client closed");
					cycle.phase = "opening";
				}
			}
		}
		if (!this.#isOpening(cycle)) throw new SdkClientError("connection_closed", "SDK client closed");
		if (this.#deadline !== undefined && Date.now() >= this.#deadline) {
			const error = this.#deadlineError();
			this.#completeCycle(cycle, error);
			throw error;
		}
		cycle.phase = "complete";
		if (this.#opening === cycle) this.#opening = null;
		const error = new SdkClientError("reconnect_exhausted", "SDK WebSocket reconnect attempts exhausted", lastError);
		this.#notifyReconnectFailedHandlers(error);
		throw error;
	}

	#completeCycle(cycle: Cycle, error: SdkClientError): void {
		if (cycle.backoffTimer) clearTimeout(cycle.backoffTimer);
		cycle.rejectBackoff?.(error);
		cycle.rejectBackoff = undefined;
		cycle.backoffTimer = undefined;
		const candidate = cycle.candidate;
		if (candidate) this.#retire(candidate, error, true);
		cycle.candidate = null;
		cycle.phase = "complete";
		if (this.#opening === cycle) this.#opening = null;
	}

	#open(cycle: Cycle): Promise<Incarnation> {
		const timeoutMs = this.#remainingTimeout();
		if (timeoutMs <= 0) return Promise.reject(this.#deadlineError());
		return new Promise((resolve, reject) => {
			const url = new URL(this.#url);
			url.searchParams.set("token", this.#token);
			const socket = new WebSocket(url);
			const incarnation: Incarnation = {
				generation: ++this.#incarnationGeneration,
				cycle,
				socket,
				phase: "opening",
				tornDown: false,
				listeners: [],
				resolveOpen: () => resolve(incarnation),
				rejectOpen: reject,
			};
			cycle.candidate = incarnation;
			const add = (type: "open" | "error" | "close" | "message", listener: EventListener, once = false) => {
				incarnation.listeners.push([type, listener]);
				socket.addEventListener(type, listener, once ? { once: true } : undefined);
			};
			add(
				"open",
				(() => {
					if (!this.#isCandidate(cycle, incarnation) || incarnation.phase !== "opening") return;
					if (incarnation.openTimer) clearTimeout(incarnation.openTimer);
					incarnation.phase = "hello";
					incarnation.resolveOpen?.();
					incarnation.resolveOpen = undefined;
					incarnation.rejectOpen = undefined;
					this.#beginHello(incarnation);
					const earlyHello = incarnation.earlyHello;
					if (earlyHello) {
						incarnation.earlyHello = undefined;
						this.#acceptHello(incarnation, earlyHello);
						if (this.#isActive(incarnation)) this.#notifyFrameHandlers(earlyHello);
					}
				}) as EventListener,
				true,
			);
			add("error", ((event: Event) => this.#onSocketFailure(incarnation, event)) as EventListener);
			add("close", (() => this.#onSocketFailure(incarnation)) as EventListener);
			add("message", ((event: MessageEvent) => this.#onMessage(event.data, incarnation)) as EventListener);
			incarnation.openTimer = setTimeout(() => this.#onOpenTimeout(incarnation, timeoutMs), timeoutMs);
			incarnation.openTimer.unref?.();
		});
	}

	#beginHello(incarnation: Incarnation): void {
		const timeoutMs = this.#remainingTimeout();
		if (timeoutMs <= 0) {
			this.#retire(incarnation, this.#deadlineError(), true);
			return;
		}
		incarnation.helloTimer = setTimeout(() => {
			if (!this.#isCandidate(incarnation.cycle, incarnation) || incarnation.phase !== "hello") return;
			const error =
				this.#deadline !== undefined && Date.now() >= this.#deadline
					? this.#deadlineError()
					: new SdkClientError("protocol_error", "SDK server did not send a hello frame.");
			incarnation.rejectHello?.(error);
			this.#retire(incarnation, error, true);
		}, timeoutMs);
		incarnation.helloTimer.unref?.();
	}

	#waitForHello(incarnation: Incarnation): Promise<void> {
		if (incarnation.failure) return Promise.reject(incarnation.failure);
		if (this.#isActive(incarnation)) return Promise.resolve();
		if (!this.#isCandidate(incarnation.cycle, incarnation) || incarnation.phase !== "hello")
			return Promise.reject(new SdkClientError("connection_closed", "SDK WebSocket is not connected"));
		return new Promise((resolve, reject) => {
			incarnation.resolveHello = resolve;
			incarnation.rejectHello = reject;
		});
	}

	#onOpenTimeout(incarnation: Incarnation, timeoutMs: number): void {
		if (!this.#isCandidate(incarnation.cycle, incarnation) || incarnation.phase !== "opening") return;
		const error =
			this.#deadline !== undefined && Date.now() >= this.#deadline
				? this.#deadlineError()
				: new SdkClientError("timeout", `SDK WebSocket connection timed out after ${timeoutMs}ms`);
		incarnation.rejectOpen?.(error);
		this.#retire(incarnation, error, true);
	}

	#onSocketFailure(incarnation: Incarnation, event?: Event): void {
		if (!this.#isCandidate(incarnation.cycle, incarnation) && !this.#isActive(incarnation)) return;
		const detail = event as (Event & { error?: unknown; message?: unknown }) | undefined;
		const error =
			detail?.error instanceof Error
				? detail.error
				: new SdkClientError(
						"connection_closed",
						typeof detail?.message === "string" ? detail.message : "SDK WebSocket connection closed",
					);
		if (incarnation.phase === "opening") incarnation.rejectOpen?.(error);
		if (incarnation.phase === "hello") incarnation.rejectHello?.(error);
		this.#retire(
			incarnation,
			error instanceof SdkClientError
				? error
				: new SdkClientError("unavailable", "SDK WebSocket connection failed", error),
			true,
		);
	}

	#onMessage(value: unknown, incarnation: Incarnation): void {
		if (!this.#isCandidate(incarnation.cycle, incarnation) && !this.#isActive(incarnation)) return;
		let frame: Frame;
		try {
			frame = parseFrame(value);
			if (frame.type === "control_command_result" && typeof frame.message === "string")
				frame = parseFrame(frame.message);
		} catch (error) {
			this.#rejectPendingFor(
				incarnation,
				error instanceof SdkClientError
					? error
					: new SdkClientError("protocol_error", "SDK server sent malformed frame.", error),
			);
			return;
		}
		if (frame.type === "hello" || frame.type === "server_hello" || frame.type === "broker_hello") {
			if (incarnation.phase === "opening" && this.#isCandidate(incarnation.cycle, incarnation)) {
				// Buffer until the open handler advances phase; do not drop.
				incarnation.earlyHello = frame;
				return;
			}
			if (incarnation.phase === "hello" && this.#isCandidate(incarnation.cycle, incarnation)) {
				this.#acceptHello(incarnation, frame);
				if (this.#isActive(incarnation)) this.#notifyFrameHandlers(frame);
				return;
			}
			if (!this.#isActive(incarnation)) return;
			if (
				typeof frame.connectionId !== "string" ||
				frame.connectionId.length === 0 ||
				frame.connectionId === this.connectionId
			)
				return;
			this.connectionId = frame.connectionId;
			this.#notifyReconnectHandlers();
		}
		if (!this.#isActive(incarnation)) return;
		const id =
			typeof frame.id === "string" ? frame.id : typeof frame.requestId === "string" ? frame.requestId : undefined;
		if (id) {
			const pending = this.#pending.get(id);
			if (pending?.incarnation === incarnation) {
				this.#settlePending(id, pending, frame.ok === false || frame.status === "error" ? errorFrom(frame) : frame);
			}
		}
		this.#notifyFrameHandlers(frame);
	}

	#notifyFrameHandlers(frame: Frame): void {
		for (const handler of [...this.#frameHandlers]) {
			try {
				handler(frame);
			} catch {
				// Observers cannot change transport settlement or prevent later observers.
			}
		}
	}

	#notifyReconnectHandlers(): void {
		for (const handler of [...this.#reconnectHandlers]) {
			try {
				handler();
			} catch {
				// Reconnect observers cannot change transport state or prevent later observers.
			}
		}
	}

	#notifyReconnectFailedHandlers(error: SdkClientError): void {
		for (const handler of [...this.#reconnectFailedHandlers]) {
			try {
				handler(error);
			} catch {
				// Failure observers cannot replace the typed transport error or prevent later observers.
			}
		}
	}

	#acceptHello(incarnation: Incarnation, frame: Frame): void {
		if (!this.#isCandidate(incarnation.cycle, incarnation) || incarnation.phase !== "hello") return;
		if (incarnation.helloTimer) clearTimeout(incarnation.helloTimer);
		const reconnecting =
			typeof frame.connectionId === "string" &&
			frame.connectionId.length > 0 &&
			this.connectionId !== undefined &&
			this.connectionId !== frame.connectionId;
		if (typeof frame.connectionId === "string" && frame.connectionId.length > 0)
			this.connectionId = frame.connectionId;
		incarnation.phase = "active";
		this.#currentSocketRecord = incarnation;
		incarnation.cycle.phase = "complete";
		if (this.#opening === incarnation.cycle) this.#opening = null;
		const resolveHello = incarnation.resolveHello;
		incarnation.resolveHello = undefined;
		incarnation.rejectHello = undefined;
		resolveHello?.();
		if (reconnecting) this.#notifyReconnectHandlers();
	}

	#settlePending(id: string, pending: Pending, result: unknown): void {
		if (this.#pending.get(id) !== pending) return;
		this.#pending.delete(id);
		clearTimeout(pending.timer);
		if (result instanceof Error) {
			if (
				pending.sent &&
				result instanceof SdkClientError &&
				(result.code === "timeout" || result.code === "connection_closed")
			)
				pending.reject(
					new SdkClientError(
						"uncertain_after_send",
						"SDK request outcome is uncertain after the frame was sent.",
						this.#sentRecords.get(id),
					),
				);
			else pending.reject(result);
		} else {
			this.#sentRecords.delete(id);
			pending.resolve(result);
		}
	}
	#rejectPendingFor(incarnation: Incarnation, error: SdkClientError): void {
		for (const [id, pending] of this.#pending)
			if (pending.incarnation === incarnation) this.#settlePending(id, pending, error);
	}
	#retire(incarnation: Incarnation, error: SdkClientError, closeSocket: boolean): void {
		if (incarnation.tornDown) return;
		const phase = incarnation.phase;
		incarnation.phase = "retired";
		incarnation.failure = error;
		if (phase === "opening") incarnation.rejectOpen?.(error);
		if (phase === "hello") incarnation.rejectHello?.(error);
		incarnation.resolveOpen = undefined;
		incarnation.rejectOpen = undefined;
		incarnation.resolveHello = undefined;
		incarnation.rejectHello = undefined;
		this.#rejectPendingFor(incarnation, error);
		if (this.#currentSocketRecord === incarnation) this.#currentSocketRecord = null;
		if (incarnation.cycle.candidate === incarnation) incarnation.cycle.candidate = null;
		this.#teardown(incarnation, closeSocket);
	}
	#teardown(incarnation: Incarnation, closeSocket: boolean): void {
		if (incarnation.tornDown) return;
		incarnation.tornDown = true;
		if (incarnation.openTimer) clearTimeout(incarnation.openTimer);
		if (incarnation.helloTimer) clearTimeout(incarnation.helloTimer);
		for (const [type, listener] of incarnation.listeners) incarnation.socket.removeEventListener(type, listener);
		incarnation.listeners = [];
		if (closeSocket)
			try {
				incarnation.socket.close();
			} catch {}
	}
	async #closeTransport(incarnation: Incarnation): Promise<void> {
		const socket = incarnation.socket;
		if (socket.readyState === WebSocket.CLOSED) return;
		// Close teardown must always issue socket.close() and be bounded by a
		// dedicated close grace, never by the (possibly elapsed) request deadline —
		// gating on an expired deadline would throw before close and leak the socket.
		const timeoutMs = this.#closeGraceMs;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const onClose = (): void => resolve();
		socket.addEventListener("close", onClose, { once: true });
		const timer = setTimeout(
			() => reject(new SdkClientError("timeout", `SDK WebSocket close timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
		timer.unref?.();
		try {
			socket.close();
			if (Number(socket.readyState) === WebSocket.CLOSED) resolve();
			await promise;
		} catch (error) {
			if (error instanceof SdkClientError) throw error;
			if (Number(socket.readyState) !== WebSocket.CLOSED)
				throw new SdkClientError("connection_closed", "SDK WebSocket close failed", error);
		} finally {
			clearTimeout(timer);
			socket.removeEventListener("close", onClose);
		}
	}
	#isCandidate(cycle: Cycle, incarnation: Incarnation): boolean {
		return (
			!this.#closed &&
			this.#opening === cycle &&
			cycle.candidate === incarnation &&
			cycle.generation > 0 &&
			incarnation.generation > 0 &&
			incarnation.cycle === cycle &&
			(cycle.phase === "opening" || cycle.phase === "backoff")
		);
	}
	#isOpening(cycle: Cycle): boolean {
		return !this.#closed && this.#opening === cycle && (cycle.phase === "opening" || cycle.phase === "backoff");
	}
	#isActive(incarnation: Incarnation | null): boolean {
		return (
			!!incarnation &&
			incarnation.generation > 0 &&
			!this.#closed &&
			this.#currentSocketRecord === incarnation &&
			incarnation.phase === "active"
		);
	}
}

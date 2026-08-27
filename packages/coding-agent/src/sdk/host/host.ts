import { logger } from "@gajae-code/utils";
import { AUTOROUTING_INACTIVE_WARNING } from "../../config/autorouting-contract";
import { redactBrokerRuntimeCloseCapability } from "./control/runtime-gate";
import { type EventFrame, SessionEventStream } from "./events";
import { isAutoroutingInactive } from "./internal-autorouting-state";
import { type ProviderLease, ReverseLeaseError, ReverseLeaseRuntime } from "./reverse-leases";
import type { BrokerIndexWriter, HostEndpointAdapters, SdkFrame } from "./types";

export type SdkRequestObserver = (kind: "control" | "query", connectionId: string, frame: SdkFrame) => void;

/**
 * When a session publishes its replayable readiness signal.
 *
 * `immediate` is the stock contract: `start()` publishes `session_ready` at
 * once, so a chat daemon that attaches (or replays late) surfaces the session
 * and creates its stock root. `deferred` prepares the session instead: the
 * session id, endpoint, and broker registration become discoverable authority,
 * but no readiness exists for any consumer to act on until `activate()` runs.
 * That ordering is what lets an operator adopt an existing chat root before the
 * daemon would otherwise have published one of its own.
 */
export type SessionReadinessMode = "immediate" | "deferred";

/**
 * Replayable signal that a deferred session is fully initialized and holding
 * endpoint authority while its readiness stays withheld.
 *
 * It is deliberately not `session_ready`: a broker lifecycle wait can
 * authenticate it as the child's semantic completion receipt, while every
 * readiness consumer — chat daemons above all — keeps ignoring it and publishes
 * no root until the session is explicitly activated.
 */
export const SESSION_PREPARED_EVENT = "session_prepared";

/** Every terminal answer an activation attempt can produce. */
export type SessionActivationOutcome =
	| "activated"
	| "already"
	| "not_prepared"
	| "generation_changed"
	| "not_authorized"
	| "authority_unavailable";

/** Proves that a prepared session may publish readiness at this exact generation. */
export type SessionActivationGate = (input: { sessionId: string; generation: number }) => boolean | Promise<boolean>;

export interface SessionSdkHostOptions extends HostEndpointAdapters {
	control?: (connectionId: string, frame: SdkFrame) => unknown | Promise<unknown>;
	query?: (connectionId: string, frame: SdkFrame) => unknown | Promise<unknown>;
	/** Test/lifecycle seam invoked synchronously before fire-and-forget dispatch. */
	onFrameAdmitted?: (connectionId: string, frame: SdkFrame) => void;
	/** Synchronously rejects external input while a runtime is being replaced. */
	onFrameAdmission?: (connectionId: string, frame: SdkFrame) => SdkFrame | undefined;
	/** Best-effort diagnostic observation of accepted control/query frames. */
	onRequest?: SdkRequestObserver;
	/** Runs before a control response is sent; identity transitions use sendTerminal. */
	beforeControlResponse?: (
		connectionId: string,
		request: SdkFrame,
		response: SdkFrame,
		sendTerminal: () => Promise<unknown>,
	) => void | Promise<void>;
	/** Runs only after a successful control response has been sent to the client. */
	afterControlResponse?: (connectionId: string, request: SdkFrame, response: SdkFrame) => void | Promise<void>;
	/**
	 * Classifies the awaited control-response write exactly once: `written`
	 * (sent), `rejected` (the write threw), or `dropped` (the send adapter
	 * deliberately skipped delivery). `afterControlResponse` runs only
	 * on `written`. Used to persist monotonic response-state transitions.
	 */
	onControlResponseDelivery?: (
		connectionId: string,
		request: SdkFrame,
		response: SdkFrame,
		outcome: "written" | "rejected" | "dropped",
	) => void | Promise<void>;
	installProviderDefinitions?: (capability: string, definitions: unknown) => void;
	onProviderDefinitionsRemoved?: (capability: string) => void;
	onReverseCancel?: (requestId: string, reason: "provider_disconnected" | "lease_released") => void;
	/** Best-effort capabilities mirrored from the native transport for out-of-band consumers. */
	connectionCapabilities?: (connectionId: string) => ReadonlySet<string> | undefined;
	/** Readiness publication mode; defaults to the stock immediate contract. */
	readiness?: SessionReadinessMode;

	/**
	 * Authorization for a deferred activation. It is consulted on every attempt
	 * that would publish readiness and never on an idempotent replay, and a gate
	 * that fails is never read as authorization.
	 */
	activationGate?: SessionActivationGate;
}

/** Shared by the replay filter and transport live broadcasts: a connection
 *  must see the same capability-gated event kinds on both legs, or live and
 *  replay delivery diverge for the same subscriber. */
export const TOOL_ACTIVITY_CAPABILITY = "tool_activity_v2";
export const CAP_GATED_FRAME_KINDS: ReadonlySet<string> = new Set(["tool_activity", "reasoning_summary"]);
const EMPTY_CAPABILITIES: ReadonlySet<string> = new Set();

/** Safe, identifier-free explanations for every refused activation status. */
const ACTIVATION_MESSAGES: Record<
	Exclude<SessionActivationOutcome, "activated" | "already"> | "session_mismatch",
	string
> = {
	not_prepared: "The session is not prepared for activation.",
	generation_changed: "The session endpoint generation changed before activation.",
	not_authorized: "Session activation is not authorized at this endpoint generation.",
	authority_unavailable: "Session activation authority could not be read.",
	session_mismatch: "The activation request addresses a different session.",
};

/** SDK hosting is independent of notification configuration. Only root sessions host an endpoint. */
export function shouldHostSdk(_settings: unknown, isTopLevel: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
	return isTopLevel && env.GJC_SDK_DISABLE !== "1";
}

function errorFrame(connectionId: string, frame: SdkFrame, error: unknown): SdkFrame {
	const candidate = error as { code?: unknown; message?: unknown };
	const code =
		error instanceof ReverseLeaseError
			? error.code
			: typeof candidate?.code === "string"
				? candidate.code
				: "internal";
	const message = typeof candidate?.message === "string" ? candidate.message : "SDK host operation failed.";
	if (frame.type === "control_request") {
		return {
			type: "control_response",
			id: typeof frame.id === "string" ? frame.id : "",
			ok: false,
			error: { code, message },
		};
	}
	return {
		type: "reverse_response",
		id: typeof frame.id === "string" ? frame.id : "",
		connectionId,
		leaseId: typeof frame.leaseId === "string" ? frame.leaseId : "",
		ok: false,
		error: { code, message },
	};
}

function leaseState(id: unknown, lease: ProviderLease, active = lease.active): SdkFrame {
	return {
		type: "lease_state",
		id: typeof id === "string" ? id : "",
		connectionId: lease.connectionId,
		capability: lease.capability,
		leaseId: lease.leaseId,
		leaseExpiresAt: new Date(lease.expiresAt).toISOString(),
		active,
	};
}

function registeredNames(definitions: unknown): string[] {
	const entries = Array.isArray(definitions)
		? definitions
		: definitions && typeof definitions === "object"
			? Object.values(definitions as Record<string, unknown>).flatMap(value => (Array.isArray(value) ? value : []))
			: [];
	return entries.flatMap(entry =>
		entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).name === "string"
			? [(entry as Record<string, string>).name]
			: [],
	);
}

function invalidFrame(message: string): Error {
	return Object.assign(new Error(message), { code: "invalid_reverse_frame" });
}
function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
function requiredString(frame: SdkFrame, field: string): string {
	const value = frame[field];
	if (typeof value !== "string") throw invalidFrame(`${field} must be a string.`);
	return value;
}
function optionalString(frame: SdkFrame, field: string): string | undefined {
	const value = frame[field];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw invalidFrame(`${field} must be a string.`);
	return value;
}
function requireConnection(connectionId: string, frame: SdkFrame): void {
	if (requiredString(frame, "connectionId") !== connectionId)
		throw invalidFrame("connectionId does not match the transport connection.");
}
function has(frame: SdkFrame, field: string): boolean {
	return Object.hasOwn(frame, field);
}

/** Adapter-based session host; bus wiring owns NotificationServer creation and transport framing. */
export class SessionSdkHost {
	readonly events = new SessionEventStream();
	readonly reverse: ReverseLeaseRuntime;
	readonly #options: SessionSdkHostOptions;
	#started = false;
	#stopping = false;
	#stopPromise?: Promise<"stopped">;
	#unsubscribe?: () => void;
	#registration?: { writer: BrokerIndexWriter; generation: number };
	/** The generation whose readiness signal has already been published. */
	#readyGeneration?: number;
	/** Serializes activation attempts so a concurrent pair cannot both publish. */
	#activation: Promise<SessionActivationOutcome> = Promise.resolve("not_prepared");

	constructor(options: SessionSdkHostOptions) {
		this.#options = options;
		this.reverse = new ReverseLeaseRuntime({
			sendFrame: options.sendFrame,
			installDefinitions: options.installProviderDefinitions,
			onDefinitionsRemoved: options.onProviderDefinitionsRemoved,
			onCancel: options.onReverseCancel,
		});
	}

	get started(): boolean {
		return this.#started;
	}
	get generation(): number {
		return this.events.generation;
	}
	/** True while the session holds endpoint authority but has published no readiness. */
	get prepared(): boolean {
		return this.#started && this.#readyGeneration !== this.events.generation;
	}
	/** True once readiness for the current generation has been published. */
	get ready(): boolean {
		return this.#started && this.#readyGeneration === this.events.generation;
	}
	/** Current installed definitions for a live provider capability. */
	getProviderDefinitions(capability: string): unknown | undefined {
		return this.reverse.getInstalledDefinitions(capability);
	}
	/** Release reverse leases after the transport reports a WebSocket disconnect. */
	handleDisconnect(connectionId: string): void {
		this.reverse.disconnect(connectionId);
	}
	/** Route malformed transport bytes through the host's structured protocol-error seam. */
	handleMalformedFrame(connectionId: string, message: string): void {
		void this.#sendBestEffort(connectionId, {
			type: "protocol_error",
			ok: false,
			error: { code: "invalid_frame", message },
		});
	}

	/** Adds an event to the resumable event ring. Transport delivery is owned by bus wiring. */
	emitEvent(frame: SdkFrame): EventFrame {
		return this.events.emit(frame);
	}

	emitAutoroutingInactiveNotice(): EventFrame {
		return this.emitEvent({
			kind: "notice",
			payload: {
				type: "notice",
				level: "warning",
				message: AUTOROUTING_INACTIVE_WARNING,
				source: "autorouting",
			},
		});
	}

	async start(): Promise<"started" | "already"> {
		if (this.#started) return "already";
		this.events.restart();
		if (isAutoroutingInactive(this)) this.emitAutoroutingInactiveNotice();
		if (this.#options.readiness !== "deferred") this.#publishReadiness();
		else
			this.emitEvent({
				name: SESSION_PREPARED_EVENT,
				sessionId: this.#options.sessionId,
				generation: this.events.generation,
			});
		const disposer = this.#options.onFrame((connectionId, frame) => {
			this.#options.onFrameAdmitted?.(connectionId, frame);
			void this.#onFrame(connectionId, frame);
		});
		this.#unsubscribe = typeof disposer === "function" ? disposer : undefined;
		this.#started = true;
		try {
			if (this.#registration)
				await this.#registration.writer.register({
					sessionId: this.#options.sessionId,
					stateRoot: this.#options.stateRoot,
					endpointGeneration: this.events.generation,
				});
			return "started";
		} catch (error) {
			this.#unsubscribe?.();
			this.#unsubscribe = undefined;
			this.#started = false;
			throw error;
		}
	}

	#publishReadiness(): void {
		this.emitEvent({ name: "session_ready", sessionId: this.#options.sessionId, generation: this.events.generation });
		this.#readyGeneration = this.events.generation;
	}

	/**
	 * Publish the readiness signal a prepared session withheld.
	 *
	 * The attempt is refused unless the session is still started at exactly
	 * `expectedGeneration` (when supplied) and the activation gate authorizes it
	 * at that same generation. Authority is re-proved after the gate resolves,
	 * because a stop or an endpoint roll can land while it is in flight, and an
	 * exact retry after a successful activation is answered `already` instead of
	 * publishing a second readiness signal.
	 */
	activate(expectedGeneration?: number): Promise<SessionActivationOutcome> {
		const attempt = this.#activation.then(
			() => this.#activateOnce(expectedGeneration),
			() => this.#activateOnce(expectedGeneration),
		);
		this.#activation = attempt.then(
			outcome => outcome,
			() => "authority_unavailable" as const,
		);
		return attempt;
	}

	async #activateOnce(expectedGeneration?: number): Promise<SessionActivationOutcome> {
		if (!this.#started) return "not_prepared";
		const generation = this.events.generation;
		if (expectedGeneration !== undefined && expectedGeneration !== generation) return "generation_changed";
		if (this.#readyGeneration === generation) return "already";
		const gate = this.#options.activationGate;
		if (gate) {
			let authorized: boolean;
			try {
				authorized = await gate({ sessionId: this.#options.sessionId, generation });
			} catch {
				// An unreadable authority is never an authorization.
				return "authority_unavailable";
			}
			if (!authorized) return "not_authorized";
			// The gate is asynchronous, so the session may have stopped or rolled
			// while it ran; nothing published below may rest on the earlier proof.
			// `#started` stays true across the unregister await inside stop(), so an
			// activation gate that resolves during shutdown would otherwise pass this
			// re-check and publish readiness after teardown began.
			if (!this.#started || this.#stopping) return "not_prepared";
			if (this.events.generation !== generation) return "generation_changed";
			if (this.#readyGeneration === generation) return "already";
		}
		this.#publishReadiness();
		return "activated";
	}

	async stop(): Promise<"stopped" | "already"> {
		if (this.#stopPromise) return this.#stopPromise;
		if (!this.#started) return "already";
		const stopPromise = this.#stopStartedHost();
		this.#stopPromise = stopPromise;
		try {
			return await stopPromise;
		} finally {
			if (this.#stopPromise === stopPromise) this.#stopPromise = undefined;
		}
	}

	async #stopStartedHost(): Promise<"stopped"> {
		// Fence before the first await: everything after this point is teardown,
		// and no in-flight activation may publish readiness across it.
		this.#stopping = true;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		if (this.#registration?.writer.unregister)
			await this.#registration.writer.unregister({
				sessionId: this.#options.sessionId,
				stateRoot: this.#options.stateRoot,
				endpointGeneration: this.events.generation,
			});
		this.#started = false;
		this.#stopping = false;
		return "stopped";
	}

	async registerWithBroker(writer: BrokerIndexWriter): Promise<void> {
		this.#registration = { writer, generation: this.events.generation };
		if (this.#started)
			await writer.register({
				sessionId: this.#options.sessionId,
				stateRoot: this.#options.stateRoot,
				endpointGeneration: this.events.generation,
			});
	}

	async #send(connectionId: string, frame: SdkFrame): Promise<"written" | "dropped"> {
		return await this.#options.sendFrame(connectionId, frame);
	}

	/**
	 * Best-effort delivery for structured error frames. When the original failure
	 * was already a disconnected/dead connection, a second send must not escape
	 * the fire-and-forget `#onFrame` callback as an unhandled rejection.
	 */
	async #sendBestEffort(connectionId: string, frame: SdkFrame): Promise<void> {
		try {
			await this.#send(connectionId, frame);
		} catch {
			// Per-connection delivery only; never rethrow into fire-and-forget handlers.
		}
	}

	async #onFrame(connectionId: string, frame: SdkFrame): Promise<void> {
		try {
			const admissionRejection = this.#options.onFrameAdmission?.(connectionId, frame);
			if (admissionRejection !== undefined) {
				await this.#send(connectionId, admissionRejection);
				return;
			}
			switch (frame.type) {
				case "control_request": {
					this.#observeRequest("control", connectionId, frame);
					// Deferred readiness withholds `session_ready`, but the control
					// dispatcher was still reachable, so the pre-activation interval made
					// activation optional for input admission. `session_activate` is a
					// separate frame type and is unaffected by this gate.
					if (this.prepared) {
						await this.#send(connectionId, {
							type: "control_response",
							id: requiredString(frame, "id"),
							ok: false,
							error: {
								code: "not_activated",
								message: "The session is prepared and must be activated before it accepts controls.",
							},
						});
						break;
					}
					const result = await this.#options.control?.(connectionId, frame);
					if (result !== undefined) {
						const response = { type: "control_response", ...(result as SdkFrame) };
						let terminalSent = false;
						let sendOutcome: "written" | "rejected" | "dropped" = "dropped";
						const sendTerminal = async (): Promise<"written" | "rejected" | "dropped"> => {
							// Repeat calls (early hook send + fallback) return the FIRST,
							// actual outcome — never a false dropped for an already
							// written response (early-identity-rotation pattern).
							if (terminalSent) return sendOutcome;
							terminalSent = true;
							try {
								const outcome = await this.#send(connectionId, response);
								sendOutcome = outcome === "written" ? "written" : "dropped";
							} catch {
								sendOutcome = "rejected";
							}
							return sendOutcome;
						};
						try {
							await this.#options.beforeControlResponse?.(connectionId, frame, response, sendTerminal);
							// Fallback: if the before hook did not send early (identity
							// rotation), the response is always sent here.
							if (!terminalSent) sendOutcome = await sendTerminal();
						} finally {
							// Classify exactly once, immediately after the send attempt and
							// BEFORE the optional post-write hook, so a rejected/dropped
							// write (or an afterControlResponse throw) never mislabels it.
							try {
								await this.#options.onControlResponseDelivery?.(connectionId, frame, response, sendOutcome);
							} catch (error) {
								// Contain observer persistence failures: the response was already
								// sent (or classified) and its delivery state recorded; rethrowing
								// would escape into the outer #onFrame catch and send a SECOND
								// control_response for the same request id (review thread P2).
								logger.warn("sdk control delivery observer failed", {
									error: error instanceof Error ? error.message : String(error),
								});
							}
						}
						if (sendOutcome === "written") {
							await this.#options.afterControlResponse?.(connectionId, frame, response);
						}
					}
					break;
				}
				case "session_activate": {
					const id = requiredString(frame, "id");
					const requestedSession = optionalString(frame, "sessionId");
					const requestedGeneration = frame.endpointGeneration;
					if (
						requestedGeneration !== undefined &&
						(typeof requestedGeneration !== "number" ||
							!Number.isSafeInteger(requestedGeneration) ||
							requestedGeneration <= 0)
					)
						throw invalidFrame("endpointGeneration must be a positive integer.");
					// A request addressed to another session is refused before any
					// activation authority is consulted.
					const status: SessionActivationOutcome | "session_mismatch" =
						requestedSession !== undefined && requestedSession !== this.#options.sessionId
							? "session_mismatch"
							: await this.activate(requestedGeneration as number | undefined);
					const ok = status === "activated" || status === "already";
					await this.#send(connectionId, {
						type: "session_activate_result",
						id,
						ok,
						status,
						sessionId: this.#options.sessionId,
						generation: this.events.generation,
						...(ok ? {} : { error: { code: status, message: ACTIVATION_MESSAGES[status] } }),
					});
					break;
				}
				case "event_replay": {
					const id = requiredString(frame, "id");
					const rawGeneration =
						frame.sinceGeneration === undefined ? this.events.generation : frame.sinceGeneration;
					const rawSeq = frame.sinceSeq === undefined ? 0 : frame.sinceSeq;
					if (typeof rawGeneration !== "number" || !Number.isSafeInteger(rawGeneration) || rawGeneration < 0)
						throw invalidFrame("sinceGeneration must be a non-negative integer.");
					if (typeof rawSeq !== "number" || !Number.isSafeInteger(rawSeq) || rawSeq < 0)
						throw invalidFrame("sinceSeq must be a non-negative integer.");
					const sinceGeneration = rawGeneration;
					const sinceSeq = rawSeq;
					const replay = this.events.replay(sinceSeq, sinceGeneration);
					const capabilities = this.#options.connectionCapabilities?.(connectionId) ?? EMPTY_CAPABILITIES;
					const events = replay.events.filter(
						event => !CAP_GATED_FRAME_KINDS.has(String(event.kind)) || capabilities.has(TOOL_ACTIVITY_CAPABILITY),
					);
					await this.#send(connectionId, {
						type: "event_replay_result",
						id,
						ok: true,
						...replay,
						events,
						generation: this.events.generation,
						lastSeq: this.events.sequence,
					});
					break;
				}
				case "query_request": {
					this.#observeRequest("query", connectionId, frame);
					const result = await this.#options.query?.(connectionId, frame);
					if (result !== undefined)
						await this.#send(connectionId, { type: "query_response", ...(result as SdkFrame) });
					break;
				}
				case "register_provider": {
					requiredString(frame, "id");
					requireConnection(connectionId, frame);
					const capability = requiredString(frame, "capability");
					if (!has(frame, "definitions")) throw invalidFrame("definitions is required.");
					const lease = this.reverse.registerProvider(
						connectionId,
						capability,
						frame.definitions,
						optionalString(frame, "expectedLeaseId"),
						optionalString(frame, "idempotencyKey"),
					);
					await this.#send(connectionId, {
						id: frame.id,
						type: "register_provider_result",
						leaseId: lease.leaseId,
						leaseExpiresAt: new Date(lease.expiresAt).toISOString(),
						registeredNames: registeredNames(frame.definitions),
					});
					break;
				}
				case "provider_heartbeat": {
					requireConnection(connectionId, frame);
					const lease = this.reverse.heartbeat(connectionId, requiredString(frame, "leaseId"));
					await this.#send(connectionId, leaseState(undefined, lease));
					break;
				}
				case "lease_release": {
					requireConnection(connectionId, frame);
					const handoffTo = optionalString(frame, "handoffTo");
					const lease = this.reverse.release(connectionId, requiredString(frame, "leaseId"), handoffTo);
					await this.#send(connectionId, leaseState(undefined, lease));
					break;
				}
				case "reverse_response": {
					const id = requiredString(frame, "id");
					requireConnection(connectionId, frame);
					const leaseId = requiredString(frame, "leaseId");
					if (typeof frame.ok !== "boolean") throw invalidFrame("ok must be a boolean.");
					const responseError = record(frame.error);
					if (frame.ok) {
						if (!has(frame, "result") || has(frame, "error"))
							throw invalidFrame("Successful reverse responses require result and no error.");
						this.reverse.respond(connectionId, id, leaseId, frame.result);
					} else {
						if (
							has(frame, "result") ||
							!responseError ||
							typeof responseError.code !== "string" ||
							typeof responseError.message !== "string"
						)
							throw invalidFrame("Failed reverse responses require a structured error and no result.");
						this.reverse.respond(connectionId, id, leaseId, undefined, {
							code: responseError.code,
							message: responseError.message,
						});
					}
					break;
				}
				default:
					// Unknown/future frame types are tolerated silently per the v3
					// forward-compatibility contract; only malformed frames of KNOWN
					// types produce structured errors (thrown above).
					return;
			}
		} catch (error) {
			// Structured error delivery is best-effort: if the client already
			// disconnected, do not escalate a second send failure process-wide.
			await this.#sendBestEffort(connectionId, errorFrame(connectionId, frame, error));
		}
	}
	#observeRequest(kind: "control" | "query", connectionId: string, frame: SdkFrame): void {
		try {
			this.#options.onRequest?.(kind, connectionId, redactBrokerRuntimeCloseCapability(frame));
		} catch {
			// Diagnostic observers must not change request handling.
		}
	}
}

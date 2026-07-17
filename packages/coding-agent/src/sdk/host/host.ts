import { type EventFrame, SessionEventStream } from "./events";
import { type ProviderLease, ReverseLeaseError, ReverseLeaseRuntime } from "./reverse-leases";
import type { BrokerIndexWriter, HostEndpointAdapters, SdkFrame } from "./types";

export type SdkRequestObserver = (kind: "control" | "query", connectionId: string, frame: SdkFrame) => void;

export interface SessionSdkHostOptions extends HostEndpointAdapters {
	control?: (connectionId: string, frame: SdkFrame) => unknown | Promise<unknown>;
	query?: (connectionId: string, frame: SdkFrame) => unknown | Promise<unknown>;
	/** Best-effort diagnostic observation of accepted control/query frames. */
	onRequest?: SdkRequestObserver;
	/** Runs only after a successful control response has been sent to the client. */
	afterControlResponse?: (connectionId: string, request: SdkFrame, response: SdkFrame) => void | Promise<void>;
	installProviderDefinitions?: (capability: string, definitions: unknown) => void;
	onProviderDefinitionsRemoved?: (capability: string) => void;
	onReverseCancel?: (requestId: string, reason: "provider_disconnected" | "lease_released") => void;
	/** Best-effort capabilities mirrored from the native transport for out-of-band consumers. */
	connectionCapabilities?: (connectionId: string) => ReadonlySet<string>;
}

const TOOL_ACTIVITY_V1 = "tool_activity_v1";
const CAP_GATED_FRAME_KINDS = new Set(["tool_activity", "reasoning_summary"]);
const EMPTY_CAPABILITIES: ReadonlySet<string> = new Set();

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
	#unsubscribe?: () => void;
	#registration?: { writer: BrokerIndexWriter; generation: number };

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
	/** Current installed definitions for a live provider capability. */
	getProviderDefinitions(capability: string): unknown | undefined {
		return this.reverse.getInstalledDefinitions(capability);
	}
	/** Release reverse leases after the transport reports a WebSocket disconnect. */
	handleDisconnect(connectionId: string): void {
		this.reverse.disconnect(connectionId);
	}

	/** Adds an event to the resumable event ring. Transport delivery is owned by bus wiring. */
	emitEvent(frame: SdkFrame): EventFrame {
		return this.events.emit(frame);
	}

	async start(): Promise<"started" | "already"> {
		if (this.#started) return "already";
		this.events.restart();
		this.emitEvent({ name: "session_ready", sessionId: this.#options.sessionId, generation: this.events.generation });
		const disposer = this.#options.onFrame((connectionId, frame) => {
			void this.#onFrame(connectionId, frame);
		});
		this.#unsubscribe = typeof disposer === "function" ? disposer : undefined;
		this.#started = true;
		if (this.#registration)
			await this.#registration.writer.register({
				sessionId: this.#options.sessionId,
				stateRoot: this.#options.stateRoot,
				endpointGeneration: this.events.generation,
			});
		return "started";
	}

	async stop(): Promise<"stopped" | "already"> {
		if (!this.#started) return "already";
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#started = false;
		if (this.#registration?.writer.unregister)
			await this.#registration.writer.unregister({
				sessionId: this.#options.sessionId,
				stateRoot: this.#options.stateRoot,
				endpointGeneration: this.events.generation,
			});
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

	async #send(connectionId: string, frame: SdkFrame): Promise<void> {
		await this.#options.sendFrame(connectionId, frame);
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
			switch (frame.type) {
				case "control_request": {
					this.#observeRequest("control", connectionId, frame);
					const result = await this.#options.control?.(connectionId, frame);
					if (result !== undefined) {
						const response = { type: "control_response", ...(result as SdkFrame) };
						await this.#send(connectionId, response);
						await this.#options.afterControlResponse?.(connectionId, frame, response);
					}
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
					const capabilities = Array.isArray(frame.capabilities)
						? new Set(
								frame.capabilities.filter((capability): capability is string => typeof capability === "string"),
							)
						: (this.#options.connectionCapabilities?.(connectionId) ?? EMPTY_CAPABILITIES);
					const events = replay.events.filter(
						event => !CAP_GATED_FRAME_KINDS.has(String(event.kind)) || capabilities.has(TOOL_ACTIVITY_V1),
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
			this.#options.onRequest?.(kind, connectionId, frame);
		} catch {
			// Diagnostic observers must not change request handling.
		}
	}
}

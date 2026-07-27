import { randomBytes } from "node:crypto";
import { type EventFrame, SessionEventStream } from "./events";
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
	/** Best-effort diagnostic observation of accepted control/query frames. */
	onRequest?: SdkRequestObserver;
	/** Runs before a control response is sent; identity transitions use sendTerminal. */
	beforeControlResponse?: (
		connectionId: string,
		request: SdkFrame,
		response: SdkFrame,
		sendTerminal: () => Promise<void>,
	) => void | Promise<void>;
	/** Runs only after a successful control response has been sent to the client. */
	afterControlResponse?: (connectionId: string, request: SdkFrame, response: SdkFrame) => void | Promise<void>;
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

const TOOL_ACTIVITY_CAPABILITY = "tool_activity_v2";
const CAP_GATED_FRAME_KINDS = new Set(["tool_activity", "reasoning_summary"]);
const EMPTY_CAPABILITIES: ReadonlySet<string> = new Set();
export const PROMPT_REPLAY_TOKEN_CAPACITY = 128;
const PROMPT_AUDIENCE_RECOVERY_TTL_MS = 5 * 60_000;

type PendingAudienceClaim = {
	connectionId: string;
	replayToken: string;
	expiresAt: number;
	response?: SdkFrame;
};

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
	#replayTokens = new Map<string, string>();
	#replayTokenOwners = new Map<string, string>();
	#pendingAudienceClaims = new Map<string, PendingAudienceClaim>();

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

	/** Adds an event to the resumable event ring. Transport delivery is owned by bus wiring. */
	emitEvent(frame: SdkFrame): EventFrame {
		return this.events.emit(frame);
	}

	/** Mints the opaque capability required to replay events scoped to a requester reference. */
	issueReplayToken(requesterRef: string): string {
		const existing = this.#replayTokens.get(requesterRef);
		if (existing) return existing;
		this.#evictExpiredAudienceClaims();
		if (!this.#evictReplayTokens()) throw Object.assign(new Error("Replay token capacity is temporarily exhausted."), { code: "busy" });
		const token = randomBytes(32).toString("base64url");
		this.#replayTokens.set(requesterRef, token);
		return token;
	}
	#evictReplayTokens(exceptRequesterRef?: string): boolean {
		this.#evictExpiredAudienceClaims();
		while (this.#replayTokens.size >= PROMPT_REPLAY_TOKEN_CAPACITY) {
			const candidate = [...this.#replayTokens.keys()].find(
				requesterRef => requesterRef !== exceptRequesterRef && !this.#pendingAudienceClaims.has(requesterRef),
			);
			if (candidate === undefined) return false;
			this.#replayTokens.delete(candidate);
			this.#replayTokenOwners.delete(candidate);
		}
		return true;
	}
	#evictExpiredAudienceClaims(now = Date.now()): void {
		for (const [requesterRef, claim] of this.#pendingAudienceClaims)
			if (claim.expiresAt <= now) this.#pendingAudienceClaims.delete(requesterRef);
	}
	#claimPromptAudience(connectionId: string, requesterRef: string): string | undefined {
		this.#evictExpiredAudienceClaims();
		const existing = this.#pendingAudienceClaims.get(requesterRef);
		if (existing) return existing.connectionId === connectionId ? existing.replayToken : undefined;
		if (this.#pendingAudienceClaims.size >= PROMPT_REPLAY_TOKEN_CAPACITY) return undefined;
		const replayToken = randomBytes(32).toString("base64url");
		this.#pendingAudienceClaims.set(requesterRef, {
			connectionId,
			replayToken,
			expiresAt: Date.now() + PROMPT_AUDIENCE_RECOVERY_TTL_MS,
		});
		return replayToken;
	}
	#authorizePromptAudience(connectionId: string, requesterRef: string, replayToken: string | undefined): string | undefined {
		this.#evictExpiredAudienceClaims();
		const token = this.#replayTokens.get(requesterRef);
		if (token) {
			if (replayToken !== token && this.#replayTokenOwners.get(requesterRef) !== connectionId) return undefined;
			const existingClaim = this.#pendingAudienceClaims.get(requesterRef);
			if (existingClaim && existingClaim.connectionId !== connectionId) return undefined;
			if (!existingClaim && this.#pendingAudienceClaims.size >= PROMPT_REPLAY_TOKEN_CAPACITY) return undefined;
			this.#pendingAudienceClaims.set(requesterRef, {
				connectionId,
				replayToken: token,
				expiresAt: Date.now() + PROMPT_AUDIENCE_RECOVERY_TTL_MS,
			});
			this.#replayTokenOwners.set(requesterRef, connectionId);
			return token;
		}
		return this.#claimPromptAudience(connectionId, requesterRef);
	}
	#releasePromptAudienceClaim(connectionId: string, requesterRef: string): void {
		if (this.#pendingAudienceClaims.get(requesterRef)?.connectionId === connectionId)
			this.#pendingAudienceClaims.delete(requesterRef);
	}
	#bindReplayToken(connectionId: string, requesterRef: string, replayToken: string): void {
		const existingReplayToken = this.#replayTokens.get(requesterRef);
		if (existingReplayToken === undefined) {
			if (!this.#evictReplayTokens(requesterRef))
				throw Object.assign(new Error("Replay token capacity is temporarily exhausted."), { code: "busy" });
			this.#replayTokens.set(requesterRef, replayToken);
		} else if (existingReplayToken !== replayToken) {
			throw Object.assign(new Error("Replay token binding does not match the authorized token."), { code: "audience_forbidden" });
		}
		this.#replayTokenOwners.set(requesterRef, connectionId);
		this.#releasePromptAudienceClaim(connectionId, requesterRef);
	}

	async start(): Promise<"started" | "already"> {
		if (this.#started) return "already";
		this.events.restart();
		if (this.#options.readiness !== "deferred") this.#publishReadiness();
		else
			this.emitEvent({
				name: SESSION_PREPARED_EVENT,
				sessionId: this.#options.sessionId,
				generation: this.events.generation,
			});
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
					const audiencePrompt =
						frame.operation === "turn.prompt" ||
						frame.operation === "turn.follow_up" ||
						frame.operation === "turn.abort_and_prompt";
					const clientRef =
						frame.operation === "turn.prompt" && record(frame.input)
							? optionalString(record(frame.input)!, "clientRef")?.trim()
							: undefined;
					const requesterRef = audiencePrompt ? clientRef || connectionId : undefined;
					const issuedReplayToken =
						requesterRef === undefined
							? undefined
							: this.#authorizePromptAudience(connectionId, requesterRef, optionalString(frame, "replayToken"));
					if (requesterRef !== undefined && issuedReplayToken === undefined) {
						await this.#send(connectionId, {
							type: "control_response",
							id: typeof frame.id === "string" ? frame.id : "",
							ok: false,
							error: { code: "audience_forbidden", message: "A matching replay token is required for this requesterRef." },
						});
						break;
					}
					const recovered = requesterRef ? this.#pendingAudienceClaims.get(requesterRef)?.response : undefined;
					if (recovered) {
						const response = { ...recovered, id: typeof frame.id === "string" ? frame.id : "" };
						// Replayed responses still run the tool-activity opt-in hook, so a consumer
						// that gates on beforeControlResponse observes the recovered terminal too.
						let terminalSent = false;
						const sendTerminal = async (): Promise<void> => {
							if (terminalSent) return;
							terminalSent = true;
							await this.#send(connectionId, response);
						};
						await this.#options.beforeControlResponse?.(connectionId, frame, response, sendTerminal);
						await sendTerminal();
						if (issuedReplayToken) this.#bindReplayToken(connectionId, requesterRef!, issuedReplayToken);
						await this.#options.afterControlResponse?.(connectionId, frame, response);
						break;
					}
					let result: unknown;
					try {
						result = await this.#options.control?.(connectionId, frame);
					} catch (error) {
						if (requesterRef) this.#releasePromptAudienceClaim(connectionId, requesterRef);
						throw error;
					}
					if (result !== undefined) {
						const successfulAcknowledgement = (result as { ok?: unknown }).ok === true;
						const response = {
							type: "control_response",
							...(result as SdkFrame),
							...(requesterRef && successfulAcknowledgement ? { replayToken: issuedReplayToken } : {}),
						};
						if (requesterRef && successfulAcknowledgement) {
							const claim = this.#pendingAudienceClaims.get(requesterRef);
							if (claim?.connectionId === connectionId) claim.response = response;
						}
						let terminalSent = false;
						const sendTerminal = async (): Promise<void> => {
							if (terminalSent) return;
							terminalSent = true;
							await this.#send(connectionId, response);
						};
						try {
							await this.#options.beforeControlResponse?.(connectionId, frame, response, sendTerminal);
							await sendTerminal();
						} catch (error) {
							if (requesterRef && !successfulAcknowledgement) this.#releasePromptAudienceClaim(connectionId, requesterRef);
							throw error;
						}
						if (requesterRef && successfulAcknowledgement && issuedReplayToken)
							this.#bindReplayToken(connectionId, requesterRef, issuedReplayToken);
						else if (requesterRef) this.#releasePromptAudienceClaim(connectionId, requesterRef);
						await this.#options.afterControlResponse?.(connectionId, frame, response);
					} else if (requesterRef) {
						this.#releasePromptAudienceClaim(connectionId, requesterRef);
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
					const requesterRef = optionalString(frame, "requesterRef");
					const replayToken = optionalString(frame, "replayToken");
					this.#evictExpiredAudienceClaims();
					// Rejections still carry the caller's own cursor: the native transport validator
					// (crates/gjc-sdk/src/server.rs) drops any event_replay_result without numeric
					// generation/lastSeq, and echoing the request cursor advances nothing.
					const rejectionCursor = { events: [], generation: sinceGeneration, lastSeq: sinceSeq };
					const storedReplayToken = requesterRef ? this.#replayTokens.get(requesterRef) : undefined;
					const pendingClaim = requesterRef ? this.#pendingAudienceClaims.get(requesterRef) : undefined;
					const hasPendingRecovery =
						pendingClaim !== undefined &&
						pendingClaim.expiresAt > Date.now() &&
						pendingClaim.connectionId === connectionId &&
						pendingClaim.replayToken === replayToken;
					if (requesterRef && (storedReplayToken === undefined || storedReplayToken !== replayToken) && !hasPendingRecovery) {
						await this.#send(connectionId, {
							type: "event_replay_result",
							id,
							ok: false,
							error: { code: "audience_forbidden", message: "A matching replay token is required for this requesterRef." },
							...rejectionCursor,
						});
						break;
					}
					const capabilities = this.#options.connectionCapabilities?.(connectionId) ?? EMPTY_CAPABILITIES;
					const events = replay.events.filter(event => {
						const audience = event.audience as { requesterRef?: unknown } | undefined;
						return (
							(typeof audience?.requesterRef !== "string" || audience.requesterRef === requesterRef) &&
							(!CAP_GATED_FRAME_KINDS.has(String(event.kind)) || capabilities.has(TOOL_ACTIVITY_CAPABILITY))
						);
					});
					// A rejected scoped replay echoes its own cursor so it cannot skip audience-scoped events.
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

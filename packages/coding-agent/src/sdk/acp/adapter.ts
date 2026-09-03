import { randomUUID } from "node:crypto";
import { logger } from "@gajae-code/utils";
import { lifecycleRequestTimeoutMs } from "../broker/startup-budget";
import { type SdkClient, SdkClientError } from "../client";
import type { AbortScope } from "../host/control/operations";
import { assertReverseResponseFrame, ReverseLeaseError } from "../host/reverse-leases";
import {
	SessionLifecycleService,
	type SessionReconcileUncertainTarget,
	validateSessionReconcileUncertainTarget,
} from "../lifecycle/service";
import {
	validateAdapterControl,
	validateAdapterSecretFields,
	validateRequiredPromptText,
} from "../protocol/adapter-validation";
import { OPERATIONS } from "../protocol/operation-registry";
import { type SessionAttachment, type SessionRouter, SessionRouterError } from "../router";
import { ACP_SESSION_RECONNECT, SESSION_ABORT_TIMEOUT_MS } from "../session-reconnect";
import type { SessionLifecycleMcpServer } from "./mcp";

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function providerErrorCode(error: unknown): string | undefined {
	if (error instanceof AcpSdkAdapterError || error instanceof SdkClientError || error instanceof ReverseLeaseError)
		return error.code;
	return undefined;
}

/** The small agent-side ACP surface used for reverse requests. */
export interface AcpReverseConnection {
	request?(method: string, params: JsonObject, options?: { cancellationSignal?: AbortSignal }): Promise<unknown>;
	[key: string]: unknown;
}

export interface AcpProviderRegistration {
	capability: string;
	definitions: unknown;
}

export interface AcpSdkAdapterOptions {
	/** Broker lifecycle transport only. Live session work requires `router` plus an opaque attachment. */
	client?: SdkClient;
	router?: SessionRouter;
	attachment?: SessionAttachment;
	sessionId?: string;
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

function credentialFreeLifecycleResult(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(credentialFreeLifecycleResult);
	if (value === null || typeof value !== "object") return value;
	const output: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
		if (key === "endpoint" || key === "token" || key === "url") continue;
		output[key] = credentialFreeLifecycleResult(nested);
	}
	return output;
}

/**
 * Lifecycle failures the ACP MCP launch wrapper must report verbatim. Everything else
 * is re-attributed to the configured MCP servers, which is the useful answer for a
 * launch that actually reached them — but a startup the broker ended before admission
 * never opened an MCP handshake, so blaming the servers would hide both the real
 * authority reason and the fact that the request is safely retryable.
 */
const ACP_MCP_PRESERVED_LAUNCH_CODES = new Set([
	"invalid_input",
	"authentication_failed",
	"unknown_model_profile",
	"model_profile_registry_error",
	"startup_admission_refused",
	"startup_admission_timeout",
	"ready_then_exited",
	"endpoint_unreadable",
	"worktree_preparation_timeout",
	"dependency_preparation_timeout",
	"readiness_timeout",
	"spawn_failed",
	"worktree_in_use",
]);

/**
 * The error an ACP session launch must throw once a lifecycle request that carried MCP
 * servers has failed.
 */
export function acpMcpLaunchFailure(error: unknown, mcpServers: SessionLifecycleMcpServer[]): unknown {
	const code =
		typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
			? error.code
			: undefined;
	if (mcpServers.length === 0 || (code !== undefined && ACP_MCP_PRESERVED_LAUNCH_CODES.has(code))) return error;
	const names = mcpServers
		.slice(0, 8)
		.map(server => server.name)
		.join(", ");
	const suffix = mcpServers.length > 8 ? `, and ${mcpServers.length - 8} more` : "";
	return new AcpSdkAdapterError("unavailable", `MCP server request failed to start (${names}${suffix}).`);
}

export type AcpReconnectFailedHandler = (error: SdkClientError) => void;
export type AcpFrameHandler = (frame: Record<string, unknown>) => void;

type ReverseRequest = {
	state: "pending" | "cancelled";
	controller?: AbortController;
	cancelTimer?: NodeJS.Timeout;
	connectionId?: string;
	capability?: string;
	leaseId?: string;
};

export { ACP_SESSION_RECONNECT };

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
		operation === "session.delete" ||
		operation === "session.reconcile_uncertain"
	);
}

/**
 * Pure ACP-to-SDK adapter. It deliberately owns neither an AgentSession nor an
 * ACP bridge: all session work is performed through authenticated v3 frames.
 */
/**
 * Provider leases are renewed only through the maintenance capability (#4689).
 * An attachment without it must be rejected at the admission boundary with an
 * explicit migration error: falling back to `send()` would restore the 5s
 * heartbeat-forced locked index rescan, and accepting it silently would leave
 * live leases quietly un-renewed until they expire.
 */
function assertMaintenanceCapability(attachment: SessionAttachment): void {
	if (typeof attachment.sendMaintenance === "function") return;
	throw new AcpSdkAdapterError(
		"operation_prohibited",
		"SDK session attachment does not implement sendMaintenance(leaseId); provider leases cannot be renewed. Update the attachment implementation to the current SessionAttachment capability.",
	);
}

export class AcpSdkAdapter {
	readonly #client?: SdkClient;
	readonly #router?: SessionRouter;
	#attachment?: SessionAttachment;
	readonly #sessionId?: string;
	readonly #connection?: AcpReverseConnection;
	readonly #providers: AcpProviderRegistration[];
	readonly #heartbeatMs: number;
	#unsubscribe?: () => void;
	#unsubscribeReconnect?: () => void;
	#unsubscribeReconnectFailed?: () => void;
	#heartbeat?: NodeJS.Timeout;
	#connectionId?: string;
	/** Router transport identity captured before reverse provider activation. */
	#routerConnectionReady = false;

	#leases = new Map<string, string>();
	#reclaiming?: Promise<void>;
	#providerActivation?: Promise<void>;
	#ensuring?: Promise<void>;

	#providersActivated = false;
	#reverseRequests = new Map<string, ReverseRequest>();
	#reconnectFailedHandlers = new Set<AcpReconnectFailedHandler>();
	#frameHandlers = new Set<AcpFrameHandler>();

	#reverseCancelTtlMs: number;
	#closed = false;
	#started = false;
	constructor(options: AcpSdkAdapterOptions) {
		if ((options.client === undefined) === (options.router === undefined))
			throw new AcpSdkAdapterError(
				"invalid_input",
				"ACP adapter requires exactly one Broker client or SessionRouter.",
			);
		const sessionId = options.sessionId ?? options.attachment?.sessionId;
		if (options.router && (!options.attachment || !sessionId || options.attachment.sessionId !== sessionId))
			throw new AcpSdkAdapterError("invalid_input", "ACP session adapters require an exact SessionAttachment.");
		this.#client = options.client;
		this.#router = options.router;
		this.#attachment = options.attachment;
		this.#sessionId = sessionId;
		this.#connection = options.connection;
		this.#providers = options.providers ?? [];
		for (const [capability, leaseId] of Object.entries(options.expectedLeaseIds ?? {}))
			this.#leases.set(capability, leaseId);
		this.#heartbeatMs = options.heartbeatMs ?? 5_000;
		this.#reverseCancelTtlMs = options.reverseCancelTtlMs ?? 30_000;
	}

	static async connect(options: AcpSdkAdapterOptions): Promise<AcpSdkAdapter> {
		const adapter = new AcpSdkAdapter(options);
		await adapter.start();
		return adapter;
	}

	acceptAttachment(attachment: SessionAttachment): void {
		if (!this.#router || attachment.sessionId !== this.#sessionId)
			throw new AcpSdkAdapterError("invalid_input", "ACP attachment does not match this session adapter.");
		// Reject an attachment that cannot renew provider leases at the handoff
		// boundary (#4730 review), not just at start(): acceptAttachment is the
		// single admission point for the replacement/ready paths too, so a
		// capability-less replacement can never silently take over live leases.
		assertMaintenanceCapability(attachment);
		this.#abortActiveReverseRequests();
		this.#attachment = attachment;
		this.#connectionId = undefined;
		this.#routerConnectionReady = false;
		this.#providersActivated = false;
		if (attachment.isCurrent()) void this.#activateProviders().catch(error => this.#reportReconnectFailure(error));
	}

	revokeAttachment(attachment: SessionAttachment): void {
		if (this.#attachment !== attachment) return;
		this.#abortActiveReverseRequests();
		this.#attachment = undefined;
		this.#connectionId = undefined;
		this.#routerConnectionReady = false;
		this.#providersActivated = false;
	}

	async attachmentReady(attachment: SessionAttachment): Promise<void> {
		// Guard BEFORE the branch (#4730 review): the same-object path below never
		// reaches acceptAttachment, so guarding only inside that one arm let a
		// current attachment without the maintenance capability activate providers
		// and acquire leases it can never renew.
		assertMaintenanceCapability(attachment);
		if (this.#attachment !== attachment) this.acceptAttachment(attachment);
		else {
			this.#abortActiveReverseRequests();
			this.#connectionId = undefined;
			this.#routerConnectionReady = false;
			this.#providersActivated = false;
		}
		if (!attachment.isCurrent()) throw new SessionRouterError("pre_send", "SDK session attachment is stale.");
		await this.#activateProviders();
	}
	/**
	 * Re-register reverse providers on a live attachment without aborting in-flight
	 * reverse RPCs. ACP session reuse and expired-lease recovery take this path
	 * because `#providersActivated` otherwise leaves a dead permission lease in
	 * place for the life of the session (#4909).
	 */
	async ensureProviders(): Promise<void> {
		if (this.#closed || this.#providers.length === 0) return;
		if (this.#ensuring) return await this.#ensuring;
		const run = (async () => {
			if (this.#closed) return;
			await this.#activateProviders(true);
		})();
		this.#ensuring = run;
		try {
			await run;
		} finally {
			if (this.#ensuring === run) this.#ensuring = undefined;
		}
	}

	acceptFrame(frame: Record<string, unknown>): void {
		void this.#onFrame(frame);
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
		if (!this.#started) {
			this.#started = true;
			if (this.#client) {
				this.#unsubscribe ??= this.#client.onFrame(frame => void this.#onFrame(frame));
				this.#unsubscribeReconnect ??= this.#client.onReconnect(
					() => void this.#reclaimProviders().catch(error => this.#reportReconnectFailure(error)),
				);
				this.#unsubscribeReconnectFailed ??= this.#client.onReconnectFailed(error =>
					this.#reportReconnectFailure(error),
				);
				await this.#client.connect();
				this.#connectionId = this.#client.connectionId;
			}
		}
		if (this.#router) {
			if (!this.#attachment?.isCurrent()) return;
			if (this.#attachment) assertMaintenanceCapability(this.#attachment);
			await this.#activateProviders();
		} else {
			await this.#activateProviders();
		}
		this.#heartbeat ??= setInterval(
			() => void this.#heartbeatLeases().catch(error => this.#reportReconnectFailure(error)),
			this.#heartbeatMs,
		);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#heartbeat) clearInterval(this.#heartbeat);
		for (const request of this.#reverseRequests.values()) {
			request.controller?.abort();
			if (request.cancelTimer) clearTimeout(request.cancelTimer);
		}
		this.#reverseRequests.clear();
		this.#unsubscribe?.();
		this.#unsubscribeReconnect?.();
		this.#unsubscribeReconnectFailed?.();
		if (this.#client) await this.#client.close();
	}

	async prompt(params: JsonObject | string): Promise<unknown> {
		const rawText =
			typeof params === "string"
				? params
				: params !== null && typeof params === "object"
					? (params.prompt ?? params.text)
					: undefined;
		const text = typeof rawText === "string" ? rawText : "";
		const invalid = validateRequiredPromptText("turn.prompt", {
			text,
			...(typeof params === "object" && Array.isArray(params.images) ? { images: params.images } : {}),
		});
		if (invalid) throw new AcpSdkAdapterError(invalid.code, invalid.message);
		return await this.#requestSession({
			type: "control_request",
			operation: "turn.prompt",
			input: { ...(typeof params === "object" ? params : {}), text },
		});
	}
	/**
	 * Ends the active turn with a C04 terminal abort. The default `scope:"turn"`
	 * only stops the current turn, matching the SDK `turn.abort` default and
	 * other ACP clients' cancel behavior; `scope:"owned"` additionally stops
	 * exact causal owned work (background Bash/task jobs, detached subagents) so
	 * an external client can terminate everything a turn spawned. Paseo keeps
	 * owned cancels through its provider config env
	 * (`GJC_ACP_ABORT_SCOPE=owned`) without source changes. A fresh bounded
	 * idempotency key per call keeps terminal-abort replay deterministic across
	 * retries.
	 */
	async cancel(scope: AbortScope = "turn"): Promise<unknown> {
		return await this.control("turn.abort", { mode: "terminal", scope, idempotencyKey: randomUUID() });
	}
	async setModel(params: JsonObject | string): Promise<unknown> {
		const id = typeof params === "string" ? params : String(params.modelId ?? params.id ?? "");
		return await this.#requestSession({ type: "control_request", operation: "model.set", input: { id } });
	}

	async control(operation: string, input: JsonObject = {}): Promise<unknown> {
		this.#assertGenericDisposition("control", operation);
		// `confirm` and `idempotencyKey` are envelope concerns, not control input:
		// extract them so the payload passes the control validator and the bounded
		// key reaches the control envelope — terminal abort requires it, and
		// without it every {mode:"terminal"} control is rejected (review
		// thread P1).
		const { confirm, idempotencyKey, ...payload } = input;
		const secretError = validateAdapterSecretFields(operation, payload);
		if (secretError) throw new AcpSdkAdapterError(secretError.code, secretError.message);

		const invalid = validateAdapterControl(operation, payload);
		if (invalid) throw new AcpSdkAdapterError(invalid.code, invalid.message);
		return await this.#requestSession(
			{
				type: "control_request",
				operation,
				input: payload,
				...(confirm === undefined ? {} : { confirm: confirm === true }),
				...(typeof idempotencyKey === "string" && idempotencyKey ? { idempotencyKey } : {}),
			},
			false,
			// A cancel must not inherit the Router's wide session reply budget: the
			// caller awaits this acknowledgement before any settlement path can bound
			// the turn, so a wedged host would stretch cancellation by that budget.
			operation === "turn.abort" ? { timeoutMs: SESSION_ABORT_TIMEOUT_MS } : undefined,
		);
	}
	async query(query: string, input: JsonObject = {}, cursor?: string): Promise<unknown> {
		return await this.#requestSession({
			type: "query_request",
			query,
			input,
			...(cursor === undefined ? {} : { cursor }),
		});
	}

	#unwrapSessionResponse(response: unknown): unknown {
		const envelope = object(response);
		if (envelope?.ok === false) {
			const error = object(envelope.error);
			throw new AcpSdkAdapterError(
				typeof error?.code === "string" ? error.code : "request_failed",
				typeof error?.message === "string" ? error.message : "SDK session request failed.",
			);
		}
		return envelope?.result ?? response;
	}

	async #requestSession(frame: JsonObject, raw = false, options?: { timeoutMs: number }): Promise<unknown> {
		const router = this.#router;
		if (!router)
			throw new AcpSdkAdapterError(
				"operation_prohibited",
				"Live session controls and queries require the current Router attachment.",
			);
		const attachment = this.#attachment;
		const sessionId = this.#sessionId;
		if (!attachment || !sessionId || !attachment.isCurrent())
			throw new SessionRouterError("pre_send", "SDK session attachment is stale.");
		const response = await router.request(
			sessionId,
			{ ...frame, id: randomUUID() },
			attachment.generation,
			attachment,
			options,
		);
		if (!attachment.isCurrent())
			throw new SessionRouterError("ambiguous", "SDK session attachment changed while awaiting command response.");
		return raw ? response : this.#unwrapSessionResponse(response);
	}
	async global(operation: string, input: JsonObject = {}, idempotencyKey?: string): Promise<unknown> {
		const result = await this.#lifecycleRequest(operation, input, idempotencyKey);
		return isLifecycleOperation(operation) ? credentialFreeLifecycleResult(result) : result;
	}
	/** Uses lifecycle endpoint credentials only inside the ACP session owner. */
	async lifecycle(operation: string, input: JsonObject = {}, idempotencyKey?: string): Promise<unknown> {
		if (!isLifecycleOperation(operation))
			throw new AcpSdkAdapterError("invalid_input", "ACP lifecycle requests must use a lifecycle operation.");
		return await this.#lifecycleRequest(operation, input, idempotencyKey);
	}
	async #lifecycleRequest(operation: string, input: JsonObject, idempotencyKey?: string): Promise<unknown> {
		this.#assertGenericDisposition("global", operation);
		if (isLifecycleOperation(operation) && !idempotencyKey)
			throw new AcpSdkAdapterError("invalid_input", "idempotencyKey is required for lifecycle operations.");
		if (operation === "session.reconcile_uncertain" && !validateSessionReconcileUncertainTarget(input))
			throw new AcpSdkAdapterError(
				"invalid_input",
				"session.reconcile_uncertain requires complete identity-bound retirement proof.",
			);
		if (!this.#client)
			throw new AcpSdkAdapterError("operation_prohibited", "Lifecycle operations require the Broker connection.");
		const client = this.#client;
		if (operation === "session.reconcile_uncertain") {
			const outcome = await new SessionLifecycleService({
				global: (lifecycleOperation, lifecycleInput, options) =>
					client.global(lifecycleOperation, lifecycleInput, options),
			}).executeWithIdempotencyKey(
				{
					operation,
					actor: { id: "acp", namespace: "sdk:acp" },
					capability: operation,
					requestKey: idempotencyKey!,
					target: input as unknown as SessionReconcileUncertainTarget,
				},
				idempotencyKey!,
			);
			return outcome.ok ? { ok: true, result: outcome.result } : { ok: false, error: outcome.error };
		}
		// The broker may hold a startup in its admission queue before the readiness
		// clock even starts, so the caller deadline covers the queue wait too; sizing
		// it on readiness alone times out requests the broker is still running. A
		// request that named no readiness budget is queued for the default one, so it
		// needs the same extension rather than the client's generic request deadline.
		const timeoutMs = lifecycleRequestTimeoutMs(operation, input);
		const response = await this.#client.global(operation, input, {
			idempotencyKey,
			...(timeoutMs === undefined ? {} : { timeoutMs }),
		});
		return response;
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
		if (!this.#router)
			throw new AcpSdkAdapterError(
				"operation_prohibited",
				"Provider registration requires the current Router attachment.",
			);
		const attachment = this.#attachment;
		if (!attachment?.isCurrent()) throw new SessionRouterError("pre_send", "SDK session attachment is stale.");
		this.#captureRouterConnection(attachment);
		const previousLeaseId = this.#leases.get(provider.capability);
		const response = await this.#requestSession(
			{
				type: "register_provider",
				capability: provider.capability,
				definitions: provider.definitions,
				idempotencyKey: randomUUID(),
				...(previousLeaseId ? { expectedLeaseId: previousLeaseId } : {}),
			},
			true,
		);
		const result = object(object(response)?.result) ?? object(response) ?? {};
		if (typeof result.leaseId !== "string")
			throw new AcpSdkAdapterError("invalid_reverse_frame", "Provider registration omitted leaseId.");
		this.#leases.set(provider.capability, result.leaseId);
		if (previousLeaseId && previousLeaseId !== result.leaseId) this.#abortReverseForCapability(provider.capability);
	}

	async #activateProviders(force = false): Promise<void> {
		if (this.#providers.length === 0) return;
		if (this.#providerActivation) {
			await this.#providerActivation;
			if (this.#closed) return;
			if (!force && this.#providersActivated) return;
		} else if (!force && this.#providersActivated) {
			return;
		}

		const activation = (async () => {
			for (;;) {
				const attachment = this.#attachment;
				const connectionId = attachment?.connectionId;
				try {
					for (const provider of this.#providers) {
						try {
							await this.registerProvider(provider);
						} catch (error) {
							if (providerErrorCode(error) === "provider_lease_conflict") {
								this.#leases.delete(provider.capability);
								this.#abortReverseForCapability(provider.capability);
								continue;
							}

							throw error;
						}
					}
					const missing = this.#providers
						.filter(provider => !this.#leases.has(provider.capability))
						.map(provider => provider.capability);
					if (missing.length > 0) {
						this.#providersActivated = this.#leases.size > 0;
						throw new AcpSdkAdapterError(
							"provider_lease_conflict",
							`Live foreign provider holds: ${missing.join(", ")}.`,
						);
					}

					if (this.#router && (attachment !== this.#attachment || attachment?.connectionId !== connectionId)) {
						this.#abortActiveReverseRequests();
						this.#providersActivated = false;
						continue;
					}
					this.#providersActivated = true;
					return;
				} catch (error) {
					if (this.#router && attachment !== this.#attachment && !this.#closed) {
						this.#providersActivated = false;
						continue;
					}
					throw error;
				}
			}
		})();
		this.#providerActivation = activation;
		try {
			await activation;
		} finally {
			if (this.#providerActivation === activation) this.#providerActivation = undefined;
		}
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
			this.#abortActiveReverseRequests();
			if (!this.#router)
				throw new AcpSdkAdapterError(
					"operation_prohibited",
					"Provider reactivation requires the current Router attachment.",
				);
			this.#providersActivated = false;
			await this.#activateProviders();
		})();
		try {
			await this.#reclaiming;
		} finally {
			this.#reclaiming = undefined;
		}
	}

	#captureRouterConnection(attachment: SessionAttachment): void {
		const connectionId = attachment.connectionId;
		if (typeof connectionId !== "string" || connectionId.length === 0) {
			this.#connectionId = undefined;
			this.#routerConnectionReady = false;
			this.#providersActivated = false;
			return;
		}
		const changed = this.#connectionId !== undefined && this.#connectionId !== connectionId;
		this.#connectionId = connectionId;
		this.#routerConnectionReady = true;
		if (changed) {
			this.#providersActivated = false;
			this.#abortActiveReverseRequests();
		}
	}

	#reportReconnectFailure(error: unknown): void {
		if (error instanceof SessionRouterError) return;
		if (providerErrorCode(error) === "provider_lease_conflict") return;
		const typed =
			error instanceof SdkClientError
				? error
				: error instanceof AcpSdkAdapterError
					? new SdkClientError("provider_rebind_failed", `${error.code}: ${error.message}`, error)
					: new SdkClientError(
							"reconnect_exhausted",
							error instanceof Error ? error.message : "SDK reconnect failed.",
							error,
						);
		for (const handler of this.#reconnectFailedHandlers) handler(typed);
	}

	async #sendSession(frame: Record<string, unknown>): Promise<void> {
		if (!this.#router)
			throw new AcpSdkAdapterError(
				"operation_prohibited",
				"Live session sends require the current Router attachment.",
			);
		const attachment = this.#attachment;
		if (!attachment?.isCurrent()) throw new SessionRouterError("pre_send", "SDK session attachment is stale.");
		await Promise.resolve(attachment.send(frame));
	}
	/** Lease heartbeats are idempotent maintenance: they skip the authority reconcile (#4689). */
	async #sendLeaseHeartbeat(leaseId: string): Promise<void> {
		if (!this.#router)
			throw new AcpSdkAdapterError(
				"operation_prohibited",
				"Live session sends require the current Router attachment.",
			);
		const attachment = this.#attachment;
		if (!attachment?.isCurrent()) throw new SessionRouterError("pre_send", "SDK session attachment is stale.");
		// Fail closed when the capability is absent (#4730 review). Falling back to
		// send() would put the 5s heartbeat back on the locked authority reconcile,
		// which is the exact idle cost this fix removes.
		if (typeof attachment.sendMaintenance !== "function")
			throw new SessionRouterError(
				"pre_send",
				"SDK session attachment does not support provider-lease maintenance heartbeats.",
			);
		await Promise.resolve(attachment.sendMaintenance(leaseId));
	}

	async #heartbeatLeases(): Promise<void> {
		if (this.#closed) return;
		try {
			if (!this.#router) return;
			if (!this.#attachment?.isCurrent()) return;
			for (const leaseId of this.#leases.values()) await this.#sendLeaseHeartbeat(leaseId);
		} catch (error) {
			if (error instanceof SessionRouterError && error.phase === "pre_send") return;
			logger.warn(
				`ACP provider lease heartbeat failed; rebinding reverse providers (${providerErrorCode(error) ?? "unknown"})`,
			);

			this.#rebindExpiredProviders();
		}
	}

	async #onFrame(frame: Record<string, unknown>): Promise<void> {
		for (const handler of this.#frameHandlers) handler(frame);
		if ((frame.type === "hello" || frame.type === "server_hello") && typeof frame.connectionId === "string") {
			if (this.#router) return;
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

		if (this.#expiredOwnedLeaseFrame(frame)) {
			const response = this.#leaseErrorFrame(frame);
			if (object(response?.error)?.code === "not_lease_owner") {
				const leaseId = typeof response?.leaseId === "string" ? response.leaseId : "";
				for (const [capability, id] of this.#leases) {
					if (id === leaseId) {
						this.#leases.delete(capability);
						this.#abortReverseForCapability(capability);
					}
				}
			}
			this.#rebindExpiredProviders();
			return;
		}

		if (frame.type !== "reverse_request" || !this.#router) return;
		const id = typeof frame.id === "string" ? frame.id : "";
		const connectionId = typeof frame.connectionId === "string" ? frame.connectionId : "";
		const capability = typeof frame.capability === "string" ? frame.capability : "";
		const leaseId = typeof frame.leaseId === "string" ? frame.leaseId : "";
		if (!id || !connectionId || !capability || !leaseId || this.#reverseRequests.has(id)) return;
		if (this.#connectionId === undefined) {
			this.#connectionId = connectionId;
			this.#routerConnectionReady = true;
		} else if (this.#connectionId !== connectionId) {
			this.#connectionId = connectionId;
			this.#routerConnectionReady = true;
			this.#providersActivated = false;
			this.#abortActiveReverseRequests();
			void this.#reclaimProviders().catch(error => this.#reportReconnectFailure(error));
			return;
		}
		if (!this.#ownsReverseLease(connectionId, capability, leaseId)) return;
		const controller = new AbortController();
		const active: ReverseRequest = { state: "pending", controller, connectionId, capability, leaseId };

		this.#reverseRequests.set(id, active);
		try {
			const request = frame.payload as JsonObject | undefined;
			const method = typeof request?.method === "string" ? request.method : "";
			const payload = request?.payload && typeof request.payload === "object" ? (request.payload as JsonObject) : {};
			const result = await this.#forwardReverse(method, payload, controller.signal);
			if (!this.#canRespondToReverse(id, active, connectionId, capability, leaseId)) return;

			const response = { type: "reverse_response", id, connectionId, leaseId, ok: true, result };
			assertReverseResponseFrame(response);
			await this.#sendSession(response);
		} catch (error) {
			if (!this.#canRespondToReverse(id, active, connectionId, capability, leaseId)) return;

			const typed =
				error instanceof AcpSdkAdapterError || error instanceof SdkClientError
					? error
					: error instanceof ReverseLeaseError
						? new AcpSdkAdapterError(error.code, error.message)
						: new AcpSdkAdapterError(
								"acp_reverse_failed",
								error instanceof Error ? error.message : "ACP reverse request failed.",
							);
			try {
				await this.#sendSession({
					type: "reverse_response",
					id,
					connectionId,
					leaseId,
					ok: false,
					error: { code: typed.code, message: typed.message },
				});
			} catch (sendError) {
				this.#reportReconnectFailure(sendError);
			}
		} finally {
			this.#finishReverse(id, active);
		}
	}

	#ownsReverseLease(connectionId: string, capability: string, leaseId: string): boolean {
		return (
			this.#router !== undefined &&
			this.#routerConnectionReady &&
			this.#providersActivated &&
			this.#connectionId === connectionId &&
			this.#leases.get(capability) === leaseId
		);
	}

	#ownsLeaseId(leaseId: string): boolean {
		for (const id of this.#leases.values()) if (id === leaseId) return true;
		return false;
	}

	#leaseErrorFrame(frame: Record<string, unknown>): Record<string, unknown> | undefined {
		if (frame.type === "reverse_response") return frame;
		if (frame.type === "event") {
			const payload = object(frame.payload);
			if (payload?.type === "reverse_response") return payload;
		}
		return undefined;
	}

	#expiredOwnedLeaseFrame(frame: Record<string, unknown>): boolean {
		const response = this.#leaseErrorFrame(frame);
		if (response?.ok !== false) return false;
		const leaseId = typeof response.leaseId === "string" ? response.leaseId : "";
		const connectionId = typeof response.connectionId === "string" ? response.connectionId : "";
		if (!leaseId || !this.#ownsLeaseId(leaseId)) return false;
		if (!this.#connectionId || connectionId !== this.#connectionId) return false;
		const code = object(response.error)?.code;
		return code === "lease_expired" || code === "not_lease_owner";
	}

	#rebindExpiredProviders(): void {
		void this.ensureProviders().catch(error => this.#reportReconnectFailure(error));
	}

	#canRespondToReverse(
		id: string,
		request: ReverseRequest,
		connectionId: string,
		capability: string,
		leaseId: string,
	): boolean {
		// Respond only for the currently owned lease id. A same-owner rebind that
		// rotates the id aborts captured requests in registerProvider.
		return (
			this.#reverseRequests.get(id) === request &&
			request.state === "pending" &&
			this.#router !== undefined &&
			this.#connectionId === request.connectionId &&
			request.connectionId === connectionId &&
			request.capability === capability &&
			request.leaseId === leaseId &&
			this.#leases.get(capability) === leaseId
		);
	}

	#abortReverseForCapability(capability: string): void {
		for (const [id, request] of [...this.#reverseRequests]) {
			if (request.capability !== capability) continue;
			const connectionId = request.connectionId;
			const leaseId = request.leaseId;
			this.#cancelReverse(id);
			if (typeof connectionId !== "string" || typeof leaseId !== "string") continue;
			void this.#sendSession({
				type: "reverse_response",
				id,
				connectionId,
				leaseId,
				ok: false,
				error: { code: "provider_disconnected", message: "Reverse provider lease was replaced." },
			}).catch(() => {});
		}
	}

	#cancelReverse(id: string): void {
		const request: ReverseRequest = this.#reverseRequests.get(id) ?? { state: "pending" };
		if (request.state === "cancelled") return;
		request.state = "cancelled";
		request.controller?.abort();
		request.cancelTimer = setTimeout(() => this.#finishReverse(id, request), this.#reverseCancelTtlMs);
		this.#reverseRequests.set(id, request);
	}

	#finishReverse(id: string, request: ReverseRequest): void {
		if (this.#reverseRequests.get(id) !== request) return;
		if (request.cancelTimer) clearTimeout(request.cancelTimer);
		this.#reverseRequests.delete(id);
	}

	#abortActiveReverseRequests(): void {
		for (const [id, request] of this.#reverseRequests) {
			request.state = "cancelled";
			request.controller?.abort();
			this.#finishReverse(id, request);
		}
	}

	async #forwardReverse(method: string, payload: JsonObject, signal: AbortSignal): Promise<unknown> {
		if (!method || !this.#connection) throw new AcpSdkAdapterError("acp_reverse_unavailable");
		if (this.#connection.request)
			return await this.#connection.request(method, payload, { cancellationSignal: signal });
		const target = this.#connection[method];
		if (typeof target !== "function")
			throw new AcpSdkAdapterError("acp_reverse_unsupported", `ACP client does not support ${method}.`);
		return await (target as (params: JsonObject) => Promise<unknown>)(payload);
	}
}

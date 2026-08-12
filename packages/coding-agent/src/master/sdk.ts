import type { MasterDomainStore } from "./domain-store";
import type { MasterRuntime, MasterRuntimeStore } from "./runtime";
import type {
	MasterAckFrame,
	MasterClientFrame,
	MasterErrorCode,
	MasterEventFrame,
	MasterServerFrame,
	TaskSummary,
} from "./sdk-contract";
import type { MasterSdkDiscovery } from "./sdk-discovery";
import {
	type MasterClientHandlerResult,
	MasterSdkTransport,
	type MasterSdkTransportOptions,
	type QueuePageProviderResult,
} from "./sdk-transport";
import type {
	MasterSnapshot,
	ProviderEffectLease,
	ProviderEffectResultReceipt,
	ProviderHealth,
	ProviderWorkerRegistrationReceipt,
} from "./types";

export interface MasterSdkStore {
	readonly masterName: string;
	enqueueUser?(input: {
		idempotencyKey: string;
		priority: "urgent_user" | "user";
		summary: string;
		workdir?: string | null;
	}): Promise<{ taskId: string; enqueueSeq: number; state: "queued"; idempotent?: boolean }>;
	enqueueTask?(input: {
		idempotencyKey: string;
		priority: "urgent_user" | "user";
		source: "user";
		summary: string;
		workdir?: string | null;
	}): Promise<{ taskId: string; enqueueSeq: number; state: "queued"; idempotent?: boolean }>;
	enqueue?(
		input: Record<string, unknown>,
	): Promise<{ taskId: string; enqueueSeq: number; state: "queued"; idempotent?: boolean }>;
	snapshot?(): Promise<MasterSnapshot>;
	readSnapshot?(): Promise<MasterSnapshot>;

	readQueue?(): Promise<{
		queueRevision: number;
		tasks: Array<Record<string, unknown>>;
		maxConcurrentWorkers?: number;
		activeWorkerCount?: number;
	}>;
	readGlobalEvents?(afterSeq?: number): Promise<readonly MasterEventFrame[]>;
	readEvents?(afterSeq?: number): Promise<readonly MasterEventFrame[]>;
	readProviderHealth?(): Promise<ProviderHealth>;
	providerHealth?(): Promise<ProviderHealth>;
	registerProviderWorker?(input: {
		provider: "telegram" | "discord";
		workerId: string;
		leaseId?: string;
		ttlMs?: number;
	}): Promise<ProviderWorkerRegistrationReceipt>;
	registerProvider?(input: {
		provider: "telegram" | "discord";
		workerId: string;
		leaseId?: string;
		ttlMs?: number;
	}): Promise<ProviderWorkerRegistrationReceipt>;
	readProviderWorkerLeases?(): Promise<
		readonly { provider: "telegram" | "discord"; workerId: string; leaseId: string }[]
	>;
	readEffectLeases?(): Promise<
		readonly {
			effectId: string;
			provider: "telegram" | "discord";
			workerId: string;
			workerLeaseId: string;
		}[]
	>;
	readOutbox?(): Promise<{
		rows: readonly {
			effectId: string;
			provider: "telegram" | "discord";
			workerId: string | null;
			workerLeaseId: string | null;
		}[];
	}>;
	leaseProviderEffect?(input: {
		provider: "telegram" | "discord";
		workerId?: string;
		workerLeaseId?: string;
	}): Promise<ProviderEffectLease | null>;
	leaseNextProviderEffect?(input: {
		provider: "telegram" | "discord";
		workerId?: string;
		workerLeaseId?: string;
	}): Promise<ProviderEffectLease | null>;
	acquireProviderEffect?(input: {
		provider: "telegram" | "discord";
		workerId?: string;
		workerLeaseId?: string;
	}): Promise<ProviderEffectLease | null>;
	reconcileProviderEffect?(input: {
		effectId: string;
		intentId: string;
		leaseId: string;
		provider: "telegram" | "discord";
		fence: number;
		nonce: string;
		outcome: unknown;
	}): Promise<ProviderEffectResultReceipt>;
	recordProviderEffectResult?(input: {
		effectId: string;
		intentId: string;
		leaseId: string;
		provider: "telegram" | "discord";
		fence: number;
		nonce: string;
		outcome: unknown;
	}): Promise<ProviderEffectResultReceipt>;
	applyProviderEffectResult?(input: {
		effectId: string;
		intentId: string;
		leaseId: string;
		provider: "telegram" | "discord";
		fence: number;
		nonce: string;
		outcome: unknown;
	}): Promise<ProviderEffectResultReceipt>;

	getEventSequence?(): Promise<number>;
}
type MasterSdkStoreValue = MasterSdkStore | MasterRuntimeStore | MasterDomainStore;

export interface MasterSdkClaims {
	request?(frame: Extract<MasterClientFrame, { type: "claim_request" }>): Promise<Record<string, unknown>>;
	approve?(frame: Extract<MasterClientFrame, { type: "approve_claim" }>): Promise<Record<string, unknown>>;
}

export interface MasterSdkProviderEffects {
	handleResult?(
		frame: Extract<MasterClientFrame, { type: "provider_effect_result" }>,
	): Promise<Record<string, unknown>>;
	onWorkerHello?(
		frame: Extract<MasterClientFrame, { type: "provider_worker_hello" }>,
		connectionId: string,
	): Promise<void> | void;
}

export interface MasterSdkOptions
	extends Omit<MasterSdkTransportOptions, "getSnapshot" | "getQueuePage" | "handleClientFrame" | "onClientFrame"> {
	readonly stores?:
		| readonly MasterSdkStoreValue[]
		| ReadonlyMap<string, MasterSdkStoreValue>
		| Record<string, MasterSdkStoreValue>;
	readonly domainStores?:
		| readonly MasterSdkStoreValue[]
		| ReadonlyMap<string, MasterSdkStoreValue>
		| Record<string, MasterSdkStoreValue>;

	readonly runtimes?: readonly MasterRuntime[] | ReadonlyMap<string, MasterRuntime> | Record<string, MasterRuntime>;
	readonly claims?: MasterSdkClaims;
	readonly providerEffects?: MasterSdkProviderEffects;
	readonly claimRequest?: MasterSdkClaims["request"];
	readonly approveClaim?: MasterSdkClaims["approve"];
	readonly handleProviderEffectResult?: MasterSdkProviderEffects["handleResult"];
	readonly globalEventReader?: (afterSeq?: number) => Promise<readonly MasterEventFrame[]>;
	readonly eventPumpIntervalMs?: number;
}

export interface MasterSdkStatus {
	readonly running: boolean;
	readonly currentSeq: number;
	readonly oldestAvailableSeq: number;
	readonly masterNames: readonly string[];
}

class SdkRequestError extends Error {
	readonly code: string;
	constructor(code: string, message = code) {
		super(message);
		this.name = "SdkRequestError";
		this.code = code;
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): MasterErrorCode {
	const code =
		error instanceof SdkRequestError
			? error.code
			: error instanceof Error && "code" in error
				? String((error as Error & { code?: unknown }).code)
				: "server_unavailable";
	const allowed = new Set<MasterErrorCode>([
		"unauthorized",
		"invalid_frame",
		"invalid_request",
		"unknown_master",
		"idempotency_conflict",
		"workdir_not_allowed",
		"channel_not_bound",
		"claim_authorization_invalid",
		"claim_authorization_expired",
		"claim_authorization_consumed",
		"claim_approval_forbidden",
		"claim_not_pending",
		"stale_effect_lease",
		"effect_result_conflict",
		"replay_gap",
		"server_unavailable",
	]);
	return allowed.has(code as MasterErrorCode) ? (code as MasterErrorCode) : "server_unavailable";
}

function storesFrom(value: MasterSdkOptions["stores"]): Map<string, MasterSdkStoreValue> {
	if (value === undefined) return new Map();
	if (value instanceof Map) return new Map(value);
	if (Array.isArray(value)) return new Map(value.map(store => [store.masterName, store] as const));
	return new Map(Object.entries(value));
}

function runtimesFrom(value: MasterSdkOptions["runtimes"]): Map<string, MasterRuntime> {
	if (value === undefined) return new Map();
	if (value instanceof Map) return new Map(value);
	if (Array.isArray(value)) return new Map(value.map(runtime => [runtime.masterName, runtime] as const));
	return new Map(Object.entries(value));
}

function taskSummary(task: unknown): TaskSummary {
	if (!record(task)) throw new SdkRequestError("server_unavailable", "Durable queue returned an invalid task.");
	return {
		taskId: String(task.taskId),
		enqueueSeq: Number(task.enqueueSeq),
		priority: task.priority as TaskSummary["priority"],
		source: task.source as TaskSummary["source"],
		state: task.state as TaskSummary["state"],
		attempt: Number(task.attempt ?? 1),
		summary: String(task.summary ?? ""),
		createdAt: String(task.createdAt),
		updatedAt: String(task.updatedAt),
		workerSessionId: typeof task.workerSessionId === "string" ? task.workerSessionId : null,
	};
}

function encodeCursor(value: {
	masterName: string;
	snapshotCutSeq: number;
	queueRevision: number;
	offset: number;
}): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string): {
	masterName: string;
	snapshotCutSeq: number;
	queueRevision: number;
	offset: number;
} {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
	} catch {
		throw new SdkRequestError("invalid_request", "Queue page cursor is malformed.");
	}
	if (
		!record(parsed) ||
		typeof parsed.masterName !== "string" ||
		!/^[a-z][a-z0-9-]{0,62}$/.test(parsed.masterName) ||
		typeof parsed.snapshotCutSeq !== "number" ||
		!Number.isSafeInteger(parsed.snapshotCutSeq) ||
		parsed.snapshotCutSeq < 0 ||
		typeof parsed.queueRevision !== "number" ||
		!Number.isSafeInteger(parsed.queueRevision) ||
		parsed.queueRevision < 0 ||
		typeof parsed.offset !== "number" ||
		!Number.isSafeInteger(parsed.offset) ||
		parsed.offset < 0
	)
		throw new SdkRequestError("invalid_request", "Queue page cursor is invalid.");

	return parsed as { masterName: string; snapshotCutSeq: number; queueRevision: number; offset: number };
}

function normalizeEvent(value: MasterEventFrame): MasterEventFrame {
	if (!record(value)) return value;
	const normalized = { ...value } as Record<string, unknown>;
	delete normalized.checksum;
	return normalized as MasterEventFrame;
}

export class MasterSdk {
	readonly #options: MasterSdkOptions;
	readonly #stores: Map<string, MasterSdkStoreValue>;

	readonly #runtimes: Map<string, MasterRuntime>;
	readonly #transport: MasterSdkTransport;
	readonly #providerWorkers = new Map<
		string,
		{
			provider: "telegram" | "discord";
			workerId: string;
			connectionId: string;
			registrations: Map<string, string>;
		}
	>();
	#eventPumpTimer: Timer | null = null;
	#refreshPromise: Promise<void> | null = null;
	#started = false;
	readonly #providerPumps = new Map<string, Promise<void>>();

	constructor(options: MasterSdkOptions = {}) {
		this.#options = options;
		this.#stores = storesFrom(options.stores ?? options.domainStores);
		this.#runtimes = runtimesFrom(options.runtimes);
		this.#transport = new MasterSdkTransport({
			...options,
			getSnapshot: async snapshotCutSeq => await this.#snapshot(snapshotCutSeq),
			getQueuePage: async (frame, snapshotCutSeq) => await this.#queuePage(frame, snapshotCutSeq),
			handleClientFrame: async (frame, connectionId) => await this.handleClientFrame(frame, connectionId),
			onConnectionClosed: connectionId => this.#retireProviderConnection(connectionId),
		});
	}

	get transport(): MasterSdkTransport {
		return this.#transport;
	}

	get server(): MasterSdkTransport {
		return this.#transport;
	}

	get state(): MasterSdkStatus {
		const state = this.#transport.state;
		return {
			running: state.running,
			currentSeq: state.currentSeq,
			oldestAvailableSeq: state.oldestAvailableSeq,
			masterNames: [...this.#stores.keys()].sort(),
		};
	}

	get url(): string {
		return this.#transport.url;
	}

	get token(): string {
		return this.#transport.token;
	}

	async start(): Promise<MasterSdkDiscovery> {
		const discovery = await this.#transport.start();
		this.#started = true;
		await this.refresh();
		this.#scheduleEventPump();
		return discovery;
	}

	async stop(): Promise<void> {
		this.#started = false;
		if (this.#eventPumpTimer !== null) {
			clearTimeout(this.#eventPumpTimer);
			this.#eventPumpTimer = null;
		}
		await this.#transport.stop();
	}

	async close(): Promise<void> {
		await this.stop();
	}

	async reload(): Promise<void> {
		await this.stop();
		await this.start();
	}

	publishEvent(event: MasterEventFrame): void {
		this.#transport.publishEvent(normalizeEvent(event));
		this.#scheduleEventPump();
	}

	appendEvent(event: MasterEventFrame): void {
		this.publishEvent(event);
	}

	retainedEvents(): readonly MasterServerFrame[] {
		return this.#transport.retainedEvents();
	}

	async refresh(upToSeq = Number.MAX_SAFE_INTEGER): Promise<void> {
		if (this.#refreshPromise) return await this.#refreshPromise;
		const run = (async () => {
			const afterSeq = this.#transport.currentSeq;
			const events = this.#options.globalEventReader
				? await this.#options.globalEventReader(afterSeq)
				: await this.#readGlobalEvents(afterSeq);
			for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
				if (event.seq <= this.#transport.currentSeq) continue;
				if (event.seq > upToSeq) break;
				this.#transport.publishEvent(normalizeEvent(event));
			}
			for (const worker of this.#providerWorkers.values()) {
				if (worker.connectionId !== "master-sdk-local") await this.#pumpProviderEffects(worker);
			}
		})();
		this.#refreshPromise = run;
		try {
			await run;
		} finally {
			if (this.#refreshPromise === run) this.#refreshPromise = null;
		}
	}

	/**
	 * Retires every provider registration bound to a closed socket. A dead
	 * registration must never remain eligible for a durable effect lease: the pump
	 * visits registrations in insertion order, so a stale entry would reacquire the
	 * lease each expiry, fail to send, and starve the live replacement worker.
	 */
	/** @internal Test seam exposing exactly which provider workers remain eligible for effects. */
	providerWorkerKeysForTest(): string[] {
		return [...this.#providerWorkers.keys()].sort();
	}

	/** @internal Test seam driving the transport's socket-close notification. */
	retireProviderConnectionForTest(connectionId: string): void {
		this.#retireProviderConnection(connectionId);
	}

	#retireProviderConnection(connectionId: string): void {
		if (connectionId === "master-sdk-local") return;
		for (const [key, worker] of this.#providerWorkers) {
			if (worker.connectionId === connectionId) this.#providerWorkers.delete(key);
		}
	}

	#scheduleEventPump(): void {
		if (!this.#started || this.#eventPumpTimer !== null) return;
		const delay = Math.max(10, this.#options.eventPumpIntervalMs ?? 100);
		this.#eventPumpTimer = setTimeout(() => {
			this.#eventPumpTimer = null;
			if (!this.#started) return;
			void this.refresh()
				.catch(() => undefined)
				.finally(() => this.#scheduleEventPump());
		}, delay);
		this.#eventPumpTimer.unref?.();
	}

	async handleClientFrame(
		frame: MasterClientFrame,
		connectionId = "master-sdk-local",
	): Promise<MasterClientHandlerResult> {
		try {
			await this.refresh();
			if (frame.type === "master_user_message") {
				if (frame.ingress.kind === "provider") this.#assertIngressConnection(connectionId, frame.ingress.provider);
				return await this.#handleUserMessage(frame);
			}
			if (frame.type === "claim_request") {
				this.#assertIngressConnection(connectionId, frame.ingress.provider);
				return await this.#handleClaimRequest(frame);
			}
			if (frame.type === "approve_claim") {
				this.#assertIngressConnection(connectionId, frame.ingress.provider);
				return await this.#handleClaimApproval(frame);
			}
			if (frame.type === "provider_worker_hello") return await this.#handleWorkerHello(frame, connectionId);
			if (frame.type === "provider_effect_result") return await this.#handleEffectResult(frame, connectionId);
			throw new SdkRequestError("invalid_request", `Unsupported master SDK operation: ${frame.type}`);
		} catch (error) {
			return {
				type: "error",
				requestId: "requestId" in frame ? frame.requestId : null,
				code: errorCode(error),
				message: errorMessage(error).slice(0, 2_048),
			};
		}
	}

	async #handleUserMessage(
		frame: Extract<MasterClientFrame, { type: "master_user_message" }>,
	): Promise<MasterAckFrame> {
		const store = this.#store(frame.masterName);
		let result: { taskId: string; enqueueSeq: number; state: "queued"; idempotent?: boolean };
		if (typeof store.enqueueUser === "function")
			result = await store.enqueueUser({
				idempotencyKey: frame.idempotencyKey,
				priority: frame.urgency,
				summary: frame.text,
				workdir: frame.workdir,
				ingress: frame.ingress,
			});
		else if (typeof store.enqueueTask === "function")
			result = await store.enqueueTask({
				idempotencyKey: frame.idempotencyKey,
				priority: frame.urgency,
				source: "user",
				summary: frame.text,
				workdir: frame.workdir,
				ingress: frame.ingress,
			});
		else if (typeof store.enqueue === "function")
			result = await store.enqueue({
				idempotencyKey: frame.idempotencyKey,
				priority: frame.urgency,
				source: "user",
				summary: frame.text,
				workdir: frame.workdir,
				ingress: frame.ingress,
			});
		else throw new SdkRequestError("server_unavailable", "Durable store does not implement user enqueue.");
		if (
			typeof result.taskId !== "string" ||
			result.taskId.length === 0 ||
			!Number.isSafeInteger(result.enqueueSeq) ||
			result.enqueueSeq < 1 ||
			result.state !== "queued"
		)
			throw new SdkRequestError("server_unavailable", "Durable enqueue did not return a durable queued receipt.");
		await this.#schedule(frame.masterName);
		await this.refresh();
		return {
			type: "ack",
			requestId: frame.requestId,
			operation: "master_user_message",
			idempotencyKey: frame.idempotencyKey,
			result: { kind: "task", taskId: result.taskId, enqueueSeq: result.enqueueSeq, state: "queued" },
		};
	}

	async #handleClaimRequest(frame: Extract<MasterClientFrame, { type: "claim_request" }>): Promise<MasterAckFrame> {
		const operation = this.#options.claims?.request ?? this.#options.claimRequest;
		if (!operation)
			throw new SdkRequestError("claim_authorization_invalid", "Claim authorization minting is not configured.");
		const result = await operation(frame);
		if (
			!record(result) ||
			typeof result.authorizationId !== "string" ||
			result.authorizationId.length === 0 ||
			typeof result.expiresAt !== "string" ||
			result.expiresAt.length === 0
		)
			throw new SdkRequestError("server_unavailable", "Claim authorization response is invalid.");
		return {
			type: "ack",
			requestId: frame.requestId,
			operation: "claim_request",
			idempotencyKey: frame.idempotencyKey,
			result: {
				kind: "claim_authorization",
				authorizationId: result.authorizationId,
				expiresAt: result.expiresAt,
				state: "unused",
			},
		};
	}

	async #handleClaimApproval(frame: Extract<MasterClientFrame, { type: "approve_claim" }>): Promise<MasterAckFrame> {
		const operation = this.#options.claims?.approve ?? this.#options.approveClaim;
		if (!operation) throw new SdkRequestError("claim_approval_forbidden", "Claim approval is not configured.");
		const result = await operation(frame);
		if (
			!record(result) ||
			result.claimId !== frame.claimId ||
			(result.status !== "approved" && result.status !== "already_approved") ||
			!record(result.owner) ||
			result.owner.kind !== "master" ||
			typeof result.owner.masterName !== "string" ||
			!/^[a-z][a-z0-9-]{0,62}$/.test(result.owner.masterName)
		)
			throw new SdkRequestError("server_unavailable", "Claim approval response is invalid.");
		return {
			type: "ack",
			requestId: frame.requestId,
			operation: "approve_claim",
			idempotencyKey: frame.idempotencyKey,
			result: {
				kind: "claim",
				claimId: frame.claimId,
				status: result.status,
				owner: { kind: "master", masterName: result.owner.masterName },
			},
		};
	}

	#assertIngressConnection(connectionId: string, provider: "telegram" | "discord"): void {
		const registered = [...this.#providerWorkers.values()].some(
			worker => worker.connectionId === connectionId && worker.provider === provider,
		);
		if (!registered)
			throw new SdkRequestError(
				"claim_authorization_invalid",
				"Provider ingress connection is not registered for the claimed provider.",
			);
	}

	async #handleWorkerHello(
		frame: Extract<MasterClientFrame, { type: "provider_worker_hello" }>,
		connectionId: string,
	): Promise<MasterAckFrame> {
		const registrations = new Map<string, string>();
		let durableRegistrationHandler = false;
		for (const [masterName, store] of this.#stores) {
			const operation = store.registerProviderWorker ?? store.registerProvider;
			if (!operation) continue;
			durableRegistrationHandler = true;
			const healthReader = store.readProviderHealth ?? store.providerHealth;
			if (healthReader) {
				const health = await healthReader.call(store);
				if (!health.configuredProviders.includes(frame.provider)) continue;
			}
			try {
				const receipt = await operation.call(store, { provider: frame.provider, workerId: frame.workerId });
				if (
					receipt.provider !== frame.provider ||
					receipt.workerId !== frame.workerId ||
					typeof receipt.leaseId !== "string" ||
					receipt.leaseId.length === 0
				)
					throw new SdkRequestError(
						"server_unavailable",
						"Durable provider registration returned an invalid receipt.",
					);
				registrations.set(masterName, receipt.leaseId);
			} catch (error) {
				const code =
					error instanceof Error && "code" in error ? String((error as Error & { code?: unknown }).code) : "";
				if (code === "PROVIDER_NOT_CONFIGURED") continue;
				throw error;
			}
		}
		if (registrations.size === 0 && durableRegistrationHandler)
			throw new SdkRequestError("server_unavailable", "Provider is not durably registered for any master.");
		const externalRegistration = this.#options.providerEffects?.onWorkerHello;
		if (registrations.size === 0 && !externalRegistration)
			throw new SdkRequestError("server_unavailable", "Durable provider registration is not configured.");
		const worker = {
			provider: frame.provider,
			workerId: frame.workerId,
			connectionId,
			registrations,
		};
		// A provider daemon restart reconnects under a fresh random worker id. Retire
		// every other registration for this provider first, or the dead entry keeps
		// winning the durable effect lease ahead of this live replacement.
		for (const [key, existing] of this.#providerWorkers) {
			if (existing.provider === frame.provider && existing.workerId !== frame.workerId)
				this.#providerWorkers.delete(key);
		}
		this.#providerWorkers.set(`${frame.provider}:${frame.workerId}`, worker);
		if (connectionId !== "master-sdk-local")
			this.#transport.registerProviderConnection(connectionId, frame.provider, frame.workerId);
		await externalRegistration?.(frame, connectionId);
		if (connectionId !== "master-sdk-local") await this.#pumpProviderEffects(worker);
		return {
			type: "ack",
			requestId: frame.requestId,
			operation: "provider_worker_hello",
			result: { kind: "provider_worker", provider: frame.provider, workerId: frame.workerId, state: "registered" },
		};
	}

	async #handleEffectResult(
		frame: Extract<MasterClientFrame, { type: "provider_effect_result" }>,
		connectionId: string,
	): Promise<MasterAckFrame> {
		let target: { masterName: string; store: MasterSdkStoreValue; provider: "telegram" | "discord" } | null = null;
		for (const [masterName, store] of this.#stores) {
			const effectStore = store as unknown as MasterSdkStore;
			if (typeof effectStore.readEffectLeases !== "function" && typeof effectStore.readOutbox !== "function")
				continue;
			const leases = (await effectStore.readEffectLeases?.()) ?? [];
			const outbox = (await effectStore.readOutbox?.())?.rows ?? [];
			const lease = leases.find(candidate => candidate.effectId === frame.effectId);
			const row = outbox.find(candidate => candidate.effectId === frame.effectId);
			const provider = lease?.provider ?? row?.provider;
			if (provider !== undefined) {
				target = { masterName, store, provider };
				break;
			}
		}
		let result: ProviderEffectResultReceipt | Record<string, unknown>;
		const worker = [...this.#providerWorkers.values()].find(candidate => candidate.connectionId === connectionId);
		if (!worker)
			throw new SdkRequestError("stale_effect_lease", "Provider effect result connection is not registered.");
		if (target) {
			const workerLeaseId = worker.registrations.get(target.masterName);
			if (worker.provider !== target.provider || workerLeaseId === undefined)
				throw new SdkRequestError(
					"stale_effect_lease",
					"Provider effect result connection does not own this lease.",
				);
			const operation =
				target.store.reconcileProviderEffect ??
				target.store.recordProviderEffectResult ??
				target.store.applyProviderEffectResult;
			if (!operation)
				throw new SdkRequestError(
					"stale_effect_lease",
					"Durable provider effect reconciliation is not configured.",
				);
			result = await operation.call(target.store, {
				effectId: frame.effectId,
				intentId: frame.intentId,
				leaseId: frame.leaseId,
				provider: target.provider,
				fence: frame.fence,
				nonce: frame.nonce,
				outcome: frame.outcome,
				workerId: worker.workerId,
				workerLeaseId,
			});
		} else {
			const operation = this.#options.providerEffects?.handleResult ?? this.#options.handleProviderEffectResult;
			if (!operation)
				throw new SdkRequestError(
					"stale_effect_lease",
					"Durable provider effect reconciliation is not configured.",
				);
			result = await operation(frame);
		}
		if (
			!record(result) ||
			(result.disposition !== "recorded" && result.disposition !== "already_recorded") ||
			(result.nextState !== "pending" && result.nextState !== "blocked" && result.nextState !== "reconciled")
		)
			throw new SdkRequestError("server_unavailable", "Provider effect result response is invalid.");
		if (target) {
			await this.#schedule(target.masterName);
			const worker = [...this.#providerWorkers.values()].find(candidate => candidate.connectionId === connectionId);
			if (worker && connectionId !== "master-sdk-local") await this.#pumpProviderEffects(worker);
		}
		return {
			type: "ack",
			requestId: frame.requestId,
			operation: "provider_effect_result",
			result: {
				kind: "provider_effect_result",
				effectId: frame.effectId,
				disposition: result.disposition,
				nextState: result.nextState,
			},
		};
	}

	async #pumpProviderEffects(worker: {
		provider: "telegram" | "discord";
		workerId: string;
		connectionId: string;
		registrations: Map<string, string>;
	}): Promise<void> {
		const key = `${worker.provider}:${worker.workerId}`;
		const previous = this.#providerPumps.get(key) ?? Promise.resolve();
		const run = previous.then(async () => {
			for (const [masterName, workerLeaseId] of worker.registrations) {
				const store = this.#stores.get(masterName);
				if (!store) continue;
				const operation = store.leaseProviderEffect ?? store.leaseNextProviderEffect ?? store.acquireProviderEffect;
				if (!operation) continue;
				for (;;) {
					const effect = await operation.call(store, {
						provider: worker.provider,
						workerId: worker.workerId,
						workerLeaseId,
					});
					if (effect === null) break;
					if (!this.#transport.sendProviderEffect(worker.connectionId, effect)) return;
				}
			}
		});
		this.#providerPumps.set(key, run);
		try {
			await run;
		} finally {
			if (this.#providerPumps.get(key) === run) this.#providerPumps.delete(key);
		}
	}

	async #schedule(masterName: string): Promise<void> {
		const runtime = this.#runtimes.get(masterName);
		if (!runtime) return;
		if (typeof runtime.refreshFromStore === "function") await runtime.refreshFromStore();
		else await runtime.signal(null);
	}

	#store(masterName: string): MasterSdkStoreValue {
		const store = this.#stores.get(masterName);
		if (!store) throw new SdkRequestError("unknown_master", `Unknown master: ${masterName}`);
		return store;
	}

	async #snapshot(
		_snapshotCutSeq = this.#transport.currentSeq,
	): Promise<{ masters: readonly MasterSnapshot[]; snapshotCutSeq: number }> {
		for (let attempt = 0; attempt < 5; attempt++) {
			await this.refresh();
			const cut = this.#transport.currentSeq;
			const snapshots: MasterSnapshot[] = [];
			for (const [name, store] of this.#stores) {
				const runtime = this.#runtimes.get(name);
				const snapshot = runtime
					? await runtime.snapshot()
					: await (store.snapshot ?? store.readSnapshot)?.call(store);
				if (snapshot) snapshots.push(snapshot);
			}
			await this.refresh();
			if (this.#transport.currentSeq === cut)
				return {
					masters: snapshots.sort((left, right) => left.masterName.localeCompare(right.masterName)),
					snapshotCutSeq: cut,
				};
		}
		throw new SdkRequestError("server_unavailable", "Could not capture a stable durable master snapshot cut.");
	}

	async #queuePage(
		frame: Extract<MasterClientFrame, { type: "get_queue_page" }>,
		snapshotCutSeq = this.#transport.currentSeq,
	): Promise<QueuePageProviderResult> {
		const cut = snapshotCutSeq;
		await this.refresh(cut);
		const store = this.#store(frame.masterName);
		if (typeof store.readQueue !== "function")
			throw new SdkRequestError("server_unavailable", "Durable store does not implement queue reads.");
		const queue = await store.readQueue();
		let offset = 0;
		let pageCut = cut;
		const queueRevisionValue = "queueRevision" in queue ? queue.queueRevision : undefined;
		if (typeof queueRevisionValue !== "number" || !Number.isSafeInteger(queueRevisionValue) || queueRevisionValue < 0)
			throw new SdkRequestError("server_unavailable", "Durable queue did not return a valid queue revision.");
		const queueRevision = queueRevisionValue;
		const resync = (
			reason: "page_cursor_expired" | "page_cursor_invalid" | "page_revision_changed",
		): Extract<QueuePageProviderResult, { type: "queue_page_resync_required" }> => ({
			type: "queue_page_resync_required",
			requestId: frame.requestId,
			masterName: frame.masterName,
			requestedCursor: frame.cursor ?? "cursor-missing",
			currentSnapshotCutSeq: this.#transport.currentSeq,
			currentQueueRevision: queueRevision,
			reason,
		});
		await this.refresh();
		if (this.#transport.currentSeq !== cut) {
			const latestQueue = await store.readQueue();
			const latestRevision = "queueRevision" in latestQueue ? latestQueue.queueRevision : undefined;
			if (latestRevision !== queueRevision) return resync("page_revision_changed");
			if (frame.cursor !== null) return resync("page_cursor_expired");
			pageCut = this.#transport.currentSeq;
		}

		if (frame.cursor !== null) {
			let cursor: { masterName: string; snapshotCutSeq: number; queueRevision: number; offset: number };
			try {
				cursor = decodeCursor(frame.cursor);
			} catch {
				return resync("page_cursor_invalid");
			}
			if (cursor.masterName !== frame.masterName) return resync("page_cursor_invalid");
			if (cursor.queueRevision !== queueRevision) return resync("page_revision_changed");
			if (cursor.snapshotCutSeq > cut) return resync("page_cursor_invalid");
			if (cursor.snapshotCutSeq !== cut) return resync("page_cursor_expired");
			offset = cursor.offset;
			pageCut = cursor.snapshotCutSeq;
		}
		const tasks = queue.tasks.map(taskSummary);
		if (offset > tasks.length) return resync("page_cursor_expired");
		const items = tasks.slice(offset, offset + frame.limit);
		const nextOffset = offset + items.length;
		return {
			masterName: frame.masterName,
			snapshotCutSeq: pageCut,
			queueRevision,
			items,
			nextCursor:
				nextOffset < tasks.length
					? encodeCursor({
							masterName: frame.masterName,
							snapshotCutSeq: pageCut,
							queueRevision,
							offset: nextOffset,
						})
					: null,
		};
	}

	async #readGlobalEvents(afterSeq: number): Promise<readonly MasterEventFrame[]> {
		const first = this.#stores.values().next().value;
		if (first && typeof first.readGlobalEvents === "function") return await first.readGlobalEvents(afterSeq);
		if (first && typeof first.getEventSequence === "function" && typeof first.readEvents === "function")
			return await first.readEvents(afterSeq);
		return [];
	}
}

export const MasterSdkServer = MasterSdk;
export const ManagedMasterSdk = MasterSdk;
export const MasterSdkEndpoint = MasterSdk;
export async function createMasterSdk(options: MasterSdkOptions = {}): Promise<MasterSdk> {
	const sdk = new MasterSdk(options);
	await sdk.start();
	return sdk;
}
export const createManagedMasterSdk = createMasterSdk;

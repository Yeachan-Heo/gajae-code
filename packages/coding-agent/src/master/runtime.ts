import { createHash, randomUUID } from "node:crypto";
import type { Model } from "@gajae-code/ai/core";
import type { ModelRegistry } from "../config/model-registry";
import type { CreateAgentSessionResult } from "../sdk/session";
import type { AuthStorage } from "../session/auth-storage";
import type { MasterCoordinatorGateway } from "./coordinator-gateway";
import type { MasterDomainStore } from "./domain-store";
import type { MemoryContract } from "./memory-contract";
import { createMasterSession, type MasterDoctrine } from "./session-factory";
import type {
	EventDraft,
	MasterEventFrame,
	MasterRuntimeStatus,
	MasterSnapshot,
	MasterStatusReason,
	ProviderEffectLease,
	ProviderEffectResultReceipt,
	ProviderHealth,
	ProviderWorkerRegistrationReceipt,
	WorkerObservationReceipt,
} from "./types";
import {
	MasterWorkerObserver,
	type WorkerDispatchBatch,
	type WorkerObserverOptions,
	type WorkerObserverStore,
} from "./worker-observer";

/**
 * Bound on how long durable provider ingress waits for the master turn it just
 * scheduled. Acknowledgement correctness depends on persistence, not on the
 * model finishing, so this only smooths the common fast case.
 */
const INGRESS_SETTLE_TIMEOUT_MS = 2_000;

/** Awaits `task`, but never longer than `timeoutMs`; rejections are absorbed. */
async function settleWithin(task: Promise<unknown>, timeoutMs: number): Promise<void> {
	if (timeoutMs <= 0) {
		void task.catch(() => undefined);
		return;
	}
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, timeoutMs);
	timer.unref?.();
	try {
		await Promise.race([
			task.then(
				() => undefined,
				() => undefined,
			),
			promise,
		]);
	} finally {
		clearTimeout(timer);
	}
}

export interface MasterRuntimeStore extends WorkerObserverStore {
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
	readRecord?(): Promise<{
		masterName: string;
		defaultWorkdir: string;
		maxConcurrentWorkers: number;
		activeWorkerCount: number;
	}>;
	readQueue?(): Promise<{
		activeWorkerCount: number;
		maxConcurrentWorkers: number;
		tasks: Array<{
			taskId: string;
			summary: string;
			workdir: string | null;
			state: string;
		}>;
	}>;
	readEvents?(afterSeq?: number): Promise<readonly MasterEventFrame[]>;
	readGlobalEvents?(afterSeq?: number): Promise<readonly MasterEventFrame[]>;
	getEventSequence?(): Promise<number>;
	readDoctrine?(): Promise<string>;
	snapshot?(): Promise<MasterSnapshot>;
	appendEvent?(event: EventDraft): Promise<MasterEventFrame | null>;
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
	readEffectLeases?(): Promise<readonly { effectId: string; provider: "telegram" | "discord" }[]>;
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
	readSnapshot?(): Promise<MasterSnapshot>;
}

export interface MasterRuntimeSession {
	prompt?(text: string, options?: Record<string, unknown>): Promise<void> | void;
	dispose?(): Promise<void> | void;
	readonly isStreaming?: boolean;
}

export type MasterRuntimeSessionFactory =
	| ((
			options: Record<string, unknown>,
	  ) => Promise<CreateAgentSessionResult | MasterRuntimeSession> | CreateAgentSessionResult | MasterRuntimeSession)
	| {
			create(
				options: Record<string, unknown>,
			): Promise<CreateAgentSessionResult | MasterRuntimeSession> | CreateAgentSessionResult | MasterRuntimeSession;
	  };

export type MasterRuntimeProviderHealthSource = () => ProviderHealth | Promise<ProviderHealth>;

export interface MasterRuntimeOptions {
	readonly masterName: string;
	readonly domainStore?: MasterRuntimeStore | MasterDomainStore;
	readonly store?: MasterRuntimeStore | MasterDomainStore;
	readonly coordinatorGateway?: MasterCoordinatorGateway | Record<string, unknown>;
	readonly coordinator?: MasterCoordinatorGateway | Record<string, unknown>;
	readonly workerObserver?: MasterWorkerObserver;
	readonly workerObserverOptions?: Omit<
		WorkerObserverOptions,
		| "masterName"
		| "domainStore"
		| "coordinatorGateway"
		| "coordinator"
		| "onMasterObservation"
		| "onUserObservation"
		| "onQuarantinedObservation"
	>;
	readonly sessionFactory?: MasterRuntimeSessionFactory;
	readonly factory?: MasterRuntimeSessionFactory;
	readonly createSession?: MasterRuntimeSessionFactory;
	readonly model?: Model;
	readonly authStorage?: AuthStorage;
	readonly modelRegistry?: ModelRegistry;
	readonly memory?: MemoryContract;
	readonly doctrine?: MasterDoctrine;
	readonly doctrineProvider?: () => MasterDoctrine | Promise<MasterDoctrine>;
	readonly providerHealth?: ProviderHealth | MasterRuntimeProviderHealthSource;
	readonly providers?: ProviderHealth | MasterRuntimeProviderHealthSource;
	readonly assertAuthorityUnchanged?: () => void | Promise<void>;
	readonly assertAuthority?: () => void | Promise<void>;
	readonly onEvent?: (event: MasterEventFrame) => void | Promise<void>;
	readonly onStatus?: (status: MasterRuntimeStatus, reason: MasterStatusReason | null) => void | Promise<void>;
	readonly onUserObservation?: (receipt: WorkerObservationReceipt) => void | Promise<void>;
	readonly onMasterObservation?: (receipt: WorkerObservationReceipt) => void | Promise<void>;
	readonly now?: () => Date;
	readonly recoveryOnStart?: boolean;
}

export interface MasterRuntimeStatusSnapshot {
	readonly masterName: string;
	readonly status: MasterRuntimeStatus;
	readonly reason: MasterStatusReason | null;
	readonly eventHighWater: number;
	readonly busy: boolean;
	readonly stopping: boolean;
	readonly providerHealth: ProviderHealth;
}

export interface MasterRuntimeTurnResult {
	readonly turnId: string;
	readonly triggerEventIds: readonly string[];
	readonly dispatched: WorkerDispatchBatch;
	readonly status: MasterRuntimeStatus;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function defaultProviderHealth(): ProviderHealth {
	return { configuredProviders: [], activeProviders: [], degradedProviders: [], operational: false };
}

function statusReasonForError(error: unknown): MasterStatusReason {
	const text = error instanceof Error ? error.message : String(error);
	if (text.includes("authority") || text.includes("AUTHORITY")) return "authority_changed";
	if (text.includes("coordinator") || text.includes("Coordinator")) return "coordinator_unavailable";
	return "internal_error";
}

function sessionFromFactory(value: CreateAgentSessionResult | MasterRuntimeSession): MasterRuntimeSession {
	if (
		record(value) &&
		record(value.session) &&
		(typeof value.session.prompt === "function" || typeof value.session.dispose === "function")
	)
		return value.session as MasterRuntimeSession;
	return value as MasterRuntimeSession;
}

function hasPendingWork(queue: { tasks: Array<{ state: string }> } | undefined, activeWorkerCount = 0): boolean {
	if (activeWorkerCount > 0) return true;
	return (
		queue?.tasks.some(
			task =>
				task.state === "queued" ||
				task.state === "retry_pending" ||
				task.state === "leased" ||
				task.state === "assigned",
		) ?? false
	);
}

export class MasterRuntime {
	readonly masterName: string;
	readonly domainStore: MasterRuntimeStore | MasterDomainStore;
	readonly workerObserver: MasterWorkerObserver;
	readonly #options: MasterRuntimeOptions;
	readonly #now: () => Date;
	#session: MasterRuntimeSession | null = null;
	#status: MasterRuntimeStatus = "starting";
	#reason: MasterStatusReason | null = "boot";
	#eventHighWater = 0;
	#busy = false;
	#stopping = false;
	#draining = false;
	#pendingEvents = new Map<string, MasterEventFrame | null>();
	#scheduled = false;
	#turnPromise: Promise<MasterRuntimeTurnResult | null> | null = null;
	#memoryWrittenTasks = new Set<string>();
	#statusPersistence: Promise<void> = Promise.resolve();
	#idleWaiters: Array<() => void> = [];
	#providerHealthCache: ProviderHealth = defaultProviderHealth();

	constructor(options: MasterRuntimeOptions) {
		if (!/^[a-z][a-z0-9-]{0,62}$/.test(options.masterName))
			throw new Error("masterName must match [a-z][a-z0-9-]{0,62}.");
		this.#options = options;
		this.masterName = options.masterName;
		const store = options.domainStore ?? options.store;
		if (!store) throw new Error("Master runtime requires a durable domain store.");
		this.domainStore = store;
		this.#now = options.now ?? (() => new Date());
		this.workerObserver =
			options.workerObserver ??
			new MasterWorkerObserver({
				masterName: options.masterName,
				domainStore: store,
				coordinatorGateway: options.coordinatorGateway ?? options.coordinator,
				...options.workerObserverOptions,
				onMasterObservation: async receipt => await this.#handleMasterObservation(receipt),
				onUserObservation: async receipt => await options.onUserObservation?.(receipt),
				onQuarantinedObservation: async receipt => {
					void receipt;
				},
			});
	}

	get session(): MasterRuntimeSession | null {
		return this.#session;
	}

	get statusValue(): MasterRuntimeStatus {
		return this.#status;
	}

	get eventHighWater(): number {
		return this.#eventHighWater;
	}

	get busy(): boolean {
		return this.#busy;
	}

	get stopping(): boolean {
		return this.#stopping;
	}

	get draining(): boolean {
		return this.#draining;
	}

	async start(): Promise<void> {
		if (this.#status !== "starting" && this.#status !== "stopped") return;
		this.#stopping = false;
		this.#draining = false;
		this.#setStatus("starting", "boot");
		this.#eventHighWater = await this.#readEventSequence();
		await this.#providerHealth();
		if (this.#options.recoveryOnStart !== false) {
			const [queue, recordValue] = await Promise.all([
				this.domainStore.readQueue?.(),
				this.domainStore.readRecord?.(),
			]);
			if (hasPendingWork(queue, recordValue?.activeWorkerCount ?? queue?.activeWorkerCount ?? 0)) {
				const last = this.domainStore.readEvents ? (await this.domainStore.readEvents(0)).at(-1) : undefined;
				this.#enqueueTrigger(last ?? null);
			}
		}
		this.#setStatus("idle", "recovered");
		await this.#flushStatus();
	}

	async restore(): Promise<void> {
		await this.start();
	}

	async reload(): Promise<void> {
		if (this.#stopping) return;
		await this.stop({ drain: true });
		this.#status = "starting";
		await this.start();
	}

	async stop(options: { readonly drain?: boolean; readonly timeoutMs?: number } = {}): Promise<void> {
		if (this.#stopping && this.#status === "stopped") return;
		this.#draining = options.drain === true;
		this.#stopping = true;
		const deadlineMs = options.timeoutMs ?? 10_000;
		if (this.#draining) await this.waitForIdle(deadlineMs);
		// The drain deadline is the whole graceful budget. Awaiting the turn promise
		// unbounded here would let a model prompt or tool call that never settles hang
		// stop/reload and the SIGTERM path forever, retaining the durable owner fence
		// well past the configured timeout.
		if (this.#turnPromise) await settleWithin(this.#turnPromise, deadlineMs);
		if (this.#session?.dispose) await this.#session.dispose();
		this.#session = null;
		this.#setStatus("stopped", "operator_stop");
		await this.#flushStatus();
		this.#draining = false;
		this.#resolveIdleWaiters();
	}

	async close(): Promise<void> {
		await this.stop();
	}

	status(): MasterRuntimeStatusSnapshot {
		return {
			masterName: this.masterName,
			status: this.#status,
			reason: this.#reason,
			eventHighWater: this.#eventHighWater,
			busy: this.#busy,
			stopping: this.#stopping,
			providerHealth: clone(this.#providerHealthSync()),
		};
	}

	async statusSnapshot(): Promise<MasterRuntimeStatusSnapshot> {
		return {
			...this.status(),
			providerHealth: await this.#providerHealth(),
		};
	}

	async snapshot(): Promise<MasterSnapshot | null> {
		const reader = this.domainStore.snapshot ?? this.domainStore.readSnapshot;
		if (typeof reader !== "function") return null;
		return await reader.call(this.domainStore);
	}

	async signal(event?: MasterEventFrame | null): Promise<void> {
		if (event && event.masterName !== this.masterName) return;
		if (event && event.seq > this.#eventHighWater) this.#eventHighWater = event.seq;
		this.#enqueueTrigger(event ?? null);
		await this.waitForIdle(0);
	}

	async notify(event?: MasterEventFrame | null): Promise<void> {
		await this.signal(event);
	}

	async handleEvent(event: MasterEventFrame): Promise<void> {
		await this.signal(event);
	}

	async refreshFromStore(): Promise<void> {
		if (typeof this.domainStore.readEvents !== "function") return;
		const events = await this.domainStore.readEvents(this.#eventHighWater);
		for (const event of events) {
			this.#eventHighWater = Math.max(this.#eventHighWater, event.seq);
			await this.#options.onEvent?.(event);
			this.#enqueueTrigger(event);
		}
		await this.#providerHealth();
		// Durable ingress is already persisted at this point. Waiting for the whole
		// master turn here would hold a provider's acknowledgement open for as long as
		// the model runs, so bound the settle wait instead of blocking indefinitely.
		await this.waitForIdle(INGRESS_SETTLE_TIMEOUT_MS);
	}

	async waitForIdle(timeoutMs = 10_000): Promise<void> {
		if (!this.#busy && !this.#scheduled) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#idleWaiters.push(resolve);
		if (timeoutMs > 0) {
			setTimeout(() => {
				const index = this.#idleWaiters.indexOf(resolve);
				if (index >= 0) this.#idleWaiters.splice(index, 1);
				resolve();
			}, timeoutMs).unref?.();
		}
		await promise;
	}

	async runTurn(): Promise<MasterRuntimeTurnResult | null> {
		if (this.#turnPromise) return await this.#turnPromise;
		this.#turnPromise = this.#runTurn().finally(() => {
			this.#turnPromise = null;
			if (this.#pendingEvents.size > 0 && !this.#stopping && !this.#draining) {
				this.#scheduled = true;
				void this.runTurn();
			} else if (!this.#busy && !this.#scheduled) {
				this.#resolveIdleWaiters();
			}
		});
		return await this.#turnPromise;
	}

	async #runTurn(): Promise<MasterRuntimeTurnResult | null> {
		if (this.#stopping || this.#draining || this.#pendingEvents.size === 0) return null;
		this.#scheduled = false;
		this.#busy = true;
		const triggerEventIds = [...this.#pendingEvents.entries()].map(([eventId]) => eventId);
		this.#pendingEvents.clear();
		try {
			await this.#assertAuthority();
			const providers = await this.#providerHealth();
			if (!providers.operational || providers.activeProviders.length < 1) {
				this.#setStatus("channel_blocked", "no_active_provider");
				return null;
			}
			this.#setStatus("busy", null);
			const queue = await this.domainStore.readQueue?.();
			const capacity = Math.max(0, (queue?.maxConcurrentWorkers ?? 0) - (queue?.activeWorkerCount ?? 0));
			const recovered = await this.workerObserver.recover();
			const admitted = await this.workerObserver.dispatchAvailable({
				limit: queue === undefined ? undefined : capacity,
			});
			const dispatched: WorkerDispatchBatch = {
				dispatched: [...recovered.dispatched, ...admitted.dispatched],
				errors: [...recovered.errors, ...admitted.errors],
			};
			await this.#recordCompletedLessons();
			const doctrine = await this.#loadDoctrine();
			const session = await this.#ensureSession(doctrine);
			if (typeof session.prompt === "function") {
				const eventText =
					triggerEventIds.length === 0
						? "durable master event"
						: `durable master events: ${triggerEventIds.join(", ")}`;
				const prompt = this.#buildTurnPrompt(eventText, doctrine, dispatched);
				await session.prompt(prompt, { synthetic: true, attribution: "agent", expandPromptTemplates: false });
			}
			this.#setStatus("idle", null);
			return { turnId: randomUUID(), triggerEventIds, dispatched, status: this.#status };
		} catch (error) {
			const reason = statusReasonForError(error);
			this.#setStatus(reason === "authority_changed" ? "authority_blocked" : "error", reason);
			return null;
		} finally {
			await this.#flushStatus();
			this.#busy = false;
		}
	}

	async #ensureSession(doctrine: MasterDoctrine | undefined): Promise<MasterRuntimeSession> {
		if (this.#session) return this.#session;
		const factory = this.#options.sessionFactory ?? this.#options.factory ?? this.#options.createSession;
		const factoryOptions: Record<string, unknown> = {
			masterName: this.masterName,
			cwd: (await this.domainStore.readRecord?.())?.defaultWorkdir,
			domainStore: this.domainStore,
			coordinatorGateway: this.#options.coordinatorGateway ?? this.#options.coordinator,
			// Share the dispatching observer so `master_worker_observe` can read the
			// Coordinator turn proven when this runtime delivered the worker's prompt.
			workerObserver: this.workerObserver,
			memory: this.#options.memory,
			model: this.#options.model,
			authStorage: this.#options.authStorage,
			modelRegistry: this.#options.modelRegistry,
			...(doctrine === undefined ? {} : { doctrine }),
			...(this.#options.doctrineProvider === undefined ? {} : { doctrineProvider: this.#options.doctrineProvider }),
		};
		let result: CreateAgentSessionResult | MasterRuntimeSession;
		if (factory === undefined) {
			if (
				!this.#options.model ||
				!this.#options.authStorage ||
				!this.#options.modelRegistry ||
				!this.#options.coordinatorGateway
			)
				throw new Error("Master runtime session factory dependencies are incomplete.");
			result = await createMasterSession(factoryOptions as never);
		} else if (typeof factory === "function") result = await factory(factoryOptions);
		else result = await factory.create(factoryOptions);
		this.#session = sessionFromFactory(result);
		return this.#session;
	}

	async #loadDoctrine(): Promise<MasterDoctrine | undefined> {
		if (this.#options.doctrineProvider) return await this.#options.doctrineProvider();
		if (this.#options.doctrine) return this.#options.doctrine;
		if (!this.domainStore.readDoctrine) return undefined;
		const content = await this.domainStore.readDoctrine();
		if (content.trim().length === 0) return undefined;
		const sha = sha256(content);
		return { revision: sha.slice(0, 16), content, sha256: sha };
	}

	#buildTurnPrompt(eventText: string, doctrine: MasterDoctrine | undefined, dispatched: WorkerDispatchBatch): string {
		const doctrineText = doctrine ? `\n\n## Current doctrine (${doctrine.revision})\n${doctrine.content}` : "";
		const dispatchText =
			dispatched.dispatched.length === 0
				? ""
				: `\n\nWorkers admitted: ${dispatched.dispatched.map(item => item.workerSessionId ?? item.lease.taskId).join(", ")}.`;
		return `Process ${eventText}. Use only durable master orchestration tools; do not edit code or use general-purpose tools.${doctrineText}${dispatchText}`;
	}

	async #handleMasterObservation(receipt: WorkerObservationReceipt): Promise<void> {
		await this.#options.onMasterObservation?.(receipt);
		await this.signal(null);
	}

	#enqueueTrigger(event: MasterEventFrame | null): void {
		const eventId = event?.eventId ?? `recovery:${this.masterName}:${this.#eventHighWater}`;
		if (event && event.seq > this.#eventHighWater) this.#eventHighWater = event.seq;
		this.#pendingEvents.set(eventId, event);
		if (!this.#scheduled && !this.#busy && !this.#stopping && !this.#draining) {
			this.#scheduled = true;
			void this.runTurn();
		}
	}

	async #assertAuthority(): Promise<void> {
		const check = this.#options.assertAuthorityUnchanged ?? this.#options.assertAuthority;
		if (check) await check();
	}

	#providerHealthSync(): ProviderHealth {
		const source = this.#options.providerHealth ?? this.#options.providers;
		if (!source || typeof source === "function") return clone(this.#providerHealthCache);
		return clone({ ...source, operational: source.operational && source.activeProviders.length >= 1 });
	}

	async #providerHealth(): Promise<ProviderHealth> {
		const source = this.#options.providerHealth ?? this.#options.providers;
		let value: ProviderHealth;
		if (source) value = typeof source === "function" ? await source() : source;
		else {
			const reader = this.domainStore.readProviderHealth ?? this.domainStore.providerHealth;
			value = reader ? await reader.call(this.domainStore) : defaultProviderHealth();
		}
		this.#providerHealthCache = clone({
			...value,
			operational: value.operational && value.activeProviders.length >= 1,
		});
		return clone(this.#providerHealthCache);
	}

	async #recordCompletedLessons(): Promise<void> {
		if (!this.#options.memory || typeof this.domainStore.readQueue !== "function") return;
		const queue = await this.domainStore.readQueue();
		for (const task of queue.tasks) {
			const candidate = task as { taskId?: string; summary?: string; state: string };
			if (candidate.state !== "completed" || !candidate.taskId || this.#memoryWrittenTasks.has(candidate.taskId))
				continue;
			try {
				const receipt = await this.#options.memory.write({
					scope: "global",
					content: `Completed task ${candidate.taskId}: ${candidate.summary ?? ""}`,
					tags: ["master", "lesson"],
					source: { masterName: this.masterName, taskId: candidate.taskId },
					idempotencyKey: `master:lesson:${this.masterName}:${candidate.taskId}`,
				});
				this.#memoryWrittenTasks.add(candidate.taskId);
				await this.domainStore.appendEvent?.({
					type: "memory_activity",
					payload: {
						activity: {
							activityId: receipt.activityId,
							operation: "write",
							scope: "global",
							masterName: this.masterName,
							taskId: candidate.taskId,
							entryIds: [receipt.entryId],
							summary: `lesson recorded for ${candidate.taskId}`,
							occurredAt: this.#now().toISOString(),
						},
					},
				});
			} catch {
				// Memory availability is non-blocking; durable task state remains authoritative.
			}
		}
	}

	async #readEventSequence(): Promise<number> {
		if (typeof this.domainStore.getEventSequence === "function") return await this.domainStore.getEventSequence();
		if (typeof this.domainStore.readEvents === "function")
			return (await this.domainStore.readEvents(0)).at(-1)?.seq ?? 0;
		return 0;
	}

	#setStatus(status: MasterRuntimeStatus, reason: MasterStatusReason | null): void {
		const previousStatus = this.#status;
		const changed = status !== previousStatus || reason !== this.#reason;
		this.#status = status;
		this.#reason = reason;
		if (changed && this.domainStore.appendEvent) {
			const providers = this.#providerHealthCache;
			// Recover the tail before chaining: one rejected persistence would otherwise
			// poison every later status write and escape as an unhandled rejection from
			// the detached turn path.
			this.#statusPersistence = this.#statusPersistence
				.catch(() => undefined)
				.then(async () => {
					const event = await this.domainStore.appendEvent!({
						type: "master_status",
						payload: {
							transition: "state_changed",
							previousStatus,
							status,
							reason,
							providers,
							memoryAvailability: this.#options.memory === undefined ? "unavailable" : "available",
						},
					});
					if (event && event.seq > this.#eventHighWater) this.#eventHighWater = event.seq;
					if (event) await this.#options.onEvent?.(event);
				});
			this.#statusPersistence.catch(() => undefined);
		}
		// A consumer status callback must never turn into an unhandled rejection.
		if (changed) void Promise.resolve(this.#options.onStatus?.(status, reason)).catch(() => undefined);
	}

	async #flushStatus(): Promise<void> {
		await this.#statusPersistence;
	}

	#resolveIdleWaiters(): void {
		const waiters = this.#idleWaiters.splice(0);
		for (const resolve of waiters) resolve();
	}
}

export const ManagedMasterRuntime = MasterRuntime;
export const MasterSessionRuntime = MasterRuntime;
export function createMasterRuntime(options: MasterRuntimeOptions): MasterRuntime {
	return new MasterRuntime(options);
}
export const createManagedMasterRuntime = createMasterRuntime;

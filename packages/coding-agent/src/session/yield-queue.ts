import type { AgentMessage } from "@gajae-code/agent-core";
import { logger } from "@gajae-code/utils";

export interface YieldDispatcher<P> {
	/** Drop entries already delivered through another path or an explicit identity cleanup. */
	isStale?(entry: P): boolean;
	/**
	 * Optional ownership-origin key: when provided, the flush builds ONE
	 * message per distinct key instead of one message for the whole batch, so
	 * a later scope:"owned" drop of one origin never suppresses entries of
	 * another origin (review thread P2).
	 */
	groupKey?(entry: P): string;
	onDrop?(entry: P): void;
	/** Called per-entry after the built message is accepted by the injector. */
	onDelivered?(entry: P): void;
	preserveAcrossIdentity?: boolean;
	/** Produce one batched AgentMessage from non-stale entries. Return null to skip. */
	build(survivors: P[]): AgentMessage | null;
}

/** Outcome reported by an idle injector after it reaches its admission boundary. */
export type YieldDeliveryResult = "delivered" | "retry" | "dropped";

export interface YieldQueueOptions {
	isStreaming: () => boolean;
	injectStreaming(msg: AgentMessage): void;
	injectIdle(
		messages: AgentMessage[],
		signal?: AbortSignal,
		identityIsCurrent?: () => boolean,
	): Promise<YieldDeliveryResult | undefined>;
	scheduleIdleFlush(run: (signal?: AbortSignal) => Promise<void>, onSkip: () => void): void;
	getIdleFlushSignal?(): AbortSignal | undefined;
	captureIdentity?(): unknown;
	isIdentityCurrent?(identity: unknown): boolean;
}

type YieldFlushMode = "streaming" | "idle";

interface StoredDispatcher {
	isStale?: (entry: unknown) => boolean;
	groupKey?: (entry: unknown) => string;
	onDrop?: (entry: unknown) => void;
	onDelivered?: (entry: unknown) => void;
	preserveAcrossIdentity: boolean;
	build: (survivors: unknown[]) => AgentMessage | null;
}

interface StoredEntry {
	value: unknown;
	identity: unknown;
}

interface BuiltMessage {
	message: AgentMessage;
	entries: StoredEntry[];
}

interface FlushBatch {
	kind: string;
	dispatcher: StoredDispatcher;
	built: BuiltMessage;
	generation: number;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class YieldQueue {
	readonly #options: YieldQueueOptions;
	readonly #dispatchers = new Map<string, StoredDispatcher>();
	readonly #entries = new Map<string, StoredEntry[]>();
	readonly #kindClearGenerations = new Map<string, number>();
	#clearGeneration = 0;
	#idleFlushPending = false;
	#idleFlushPendingOwner: symbol | undefined;

	constructor(options: YieldQueueOptions) {
		this.#options = options;
	}

	register<P>(kind: string, dispatcher: YieldDispatcher<P>): () => void {
		const stored: StoredDispatcher = {
			...(dispatcher.isStale ? { isStale: entry => dispatcher.isStale?.(entry as P) ?? false } : {}),
			...(dispatcher.groupKey ? { groupKey: entry => dispatcher.groupKey?.(entry as P) ?? "default" } : {}),
			...(dispatcher.onDrop ? { onDrop: entry => dispatcher.onDrop?.(entry as P) } : {}),
			...(dispatcher.onDelivered ? { onDelivered: entry => dispatcher.onDelivered?.(entry as P) } : {}),
			preserveAcrossIdentity: dispatcher.preserveAcrossIdentity === true,
			build: survivors => dispatcher.build(survivors as P[]),
		};
		this.#dispatchers.set(kind, stored);
		return () => {
			if (this.#dispatchers.get(kind) !== stored) return;
			this.#dispatchers.delete(kind);
			this.#entries.delete(kind);
		};
	}

	enqueue<P>(kind: string, entry: P): void {
		if (!this.#dispatchers.has(kind)) {
			logger.warn("Yield queue entry ignored for unregistered kind", { kind });
			return;
		}
		let entries = this.#entries.get(kind);
		if (!entries) {
			entries = [];
			this.#entries.set(kind, entries);
		}
		entries.push({ value: entry, identity: this.#options.captureIdentity?.() });
		if (!this.#options.isStreaming()) {
			this.#scheduleIdleFlush();
		}
	}

	has(kind?: string): boolean {
		if (kind !== undefined) return (this.#entries.get(kind)?.length ?? 0) > 0;
		for (const entries of this.#entries.values()) {
			if (entries.length > 0) return true;
		}
		return false;
	}

	async flush(mode: YieldFlushMode, signal?: AbortSignal): Promise<void> {
		if (mode === "idle") {
			this.#idleFlushPending = false;
			this.#idleFlushPendingOwner = undefined;
		}
		const idleMessages: AgentMessage[] = [];
		const idleBatches: FlushBatch[] = [];
		const preservedIdleMessages: AgentMessage[] = [];
		const preservedIdleBatches: FlushBatch[] = [];
		for (const [kind, dispatcher] of this.#dispatchers) {
			const drained = this.#drain(kind);
			const admitted = drained.filter(entry => {
				const current =
					dispatcher.preserveAcrossIdentity || (this.#options.isIdentityCurrent?.(entry.identity) ?? true);
				if (!current) dispatcher.onDrop?.(entry.value);
				return current;
			});
			if (admitted.length === 0) continue;
			const builtMessages = this.#build(kind, dispatcher, admitted) ?? [];
			for (const built of builtMessages) {
				if (mode === "streaming") {
					try {
						this.#options.injectStreaming(built.message);
					} catch (error) {
						this.#requeue(kind, built.entries);
						this.rearmIdle();
						logger.warn("Yield queue streaming dispatch failed", { kind, error: formatError(error) });
						continue;
					}
					this.#notifyDelivered(dispatcher, built.entries);
				} else {
					if (dispatcher.preserveAcrossIdentity) {
						preservedIdleMessages.push(built.message);
						preservedIdleBatches.push({ kind, dispatcher, built, generation: this.#generationFor(kind) });
					} else {
						idleMessages.push(built.message);
						idleBatches.push({ kind, dispatcher, built, generation: this.#generationFor(kind) });
					}
				}
			}
		}
		if (mode === "idle" && idleMessages.length > 0) {
			try {
				const result = await this.#options.injectIdle(
					idleMessages,
					signal ?? this.#options.getIdleFlushSignal?.(),
					() => this.#identitiesAreCurrent(idleBatches),
				);
				if (!this.#batchesAreCurrent(idleBatches)) {
					this.#notifyDroppedBatches(idleBatches);
				} else if (result === "retry") {
					if (this.#identitiesAreCurrent(idleBatches)) this.#requeueBatches(idleBatches);
					else this.#notifyDroppedBatches(idleBatches);
				} else if (result === "dropped") this.#notifyDroppedBatches(idleBatches);
				else this.#notifyDeliveredBatches(idleBatches);
			} catch (error) {
				if (this.#identitiesAreCurrent(idleBatches)) this.#requeueBatches(idleBatches);
				else this.#notifyDroppedBatches(idleBatches);
				logger.warn("Yield queue idle dispatch failed", { error: formatError(error) });
			}
		}
		if (mode === "idle" && preservedIdleMessages.length > 0) {
			try {
				const result = await this.#options.injectIdle(
					preservedIdleMessages,
					signal ?? this.#options.getIdleFlushSignal?.(),
				);
				if (!this.#batchesAreCurrent(preservedIdleBatches)) this.#notifyDroppedBatches(preservedIdleBatches);
				else if (result === "retry") this.#requeueBatches(preservedIdleBatches);
				else if (result === "dropped") this.#notifyDroppedBatches(preservedIdleBatches);
				else this.#notifyDeliveredBatches(preservedIdleBatches);
			} catch (error) {
				this.#requeueBatches(preservedIdleBatches);
				logger.warn("Yield queue preserved idle dispatch failed", { error: formatError(error) });
			}
		}
	}

	clear(onDrop?: (kind: string, entries: readonly unknown[]) => void): void {
		this.#clearGeneration += 1;
		for (const [kind, entries] of this.#entries) {
			if (onDrop) {
				onDrop(
					kind,
					entries.map(entry => entry.value),
				);
			} else {
				this.#notifyDropped(this.#dispatchers.get(kind), entries);
			}
		}
		this.#entries.clear();
		this.#idleFlushPending = false;
		this.#idleFlushPendingOwner = undefined;
	}

	/** Drop only the queued entries of a single kind, releasing their claims. */
	clearKind(kind: string): void {
		this.#kindClearGenerations.set(kind, this.#generationFor(kind) + 1);
		const entries = this.#entries.get(kind);
		if (entries) this.#notifyDropped(this.#dispatchers.get(kind), entries);
		this.#entries.delete(kind);
	}

	/**
	 * Re-schedule an idle flush if work remains and the session is idle. Used after
	 * a transition (e.g. handoff) releases a delivery fence so entries queued while
	 * fenced are not stranded until an unrelated enqueue or agent yield.
	 */
	rearmIdle(): void {
		if (this.#options.isStreaming()) return;
		for (const entries of this.#entries.values()) {
			if (entries.length > 0) {
				this.#scheduleIdleFlush();
				return;
			}
		}
	}

	#scheduleIdleFlush(): void {
		if (this.#idleFlushPending) return;
		this.#idleFlushPending = true;
		const owner = Symbol("idle-flush");
		this.#idleFlushPendingOwner = owner;
		const releaseOwner = () => {
			if (this.#idleFlushPendingOwner !== owner) return;
			this.#idleFlushPendingOwner = undefined;
			this.#idleFlushPending = false;
		};
		try {
			this.#options.scheduleIdleFlush(async signal => {
				releaseOwner();
				if (this.#options.isStreaming()) return;
				await this.flush("idle", signal);
			}, releaseOwner);
		} catch (error) {
			releaseOwner();
			logger.warn("Yield queue idle flush scheduling failed", { error: formatError(error) });
		}
	}

	#drain(kind: string): StoredEntry[] {
		const entries = this.#entries.get(kind);
		if (!entries || entries.length === 0) return [];
		this.#entries.delete(kind);
		return entries;
	}

	#build(kind: string, dispatcher: StoredDispatcher, entries: StoredEntry[]): BuiltMessage[] | null {
		// Corrected turn semantics (terminal abort): turn-scope abort blocks only
		// deliveries whose origin is a continuation of the aborted turn.
		// Owned-completion deliveries from work deliberately left running are
		// intentionally allowed to resume the agent through the normal
		// followUp/prompt path and receive a fresh turn attempt. A closed
		// terminal record must never make an allowed owned-completion entry
		// stale merely because it is closed; stale filtering below applies only
		// to ordinary manager state (e.g. isDeliverySuppressed) or explicit
		// blocked-continuation/owned-cleanup entries.
		const survivors: StoredEntry[] = [];
		for (const entry of entries) {
			if (dispatcher.isStale) {
				let stale: boolean;
				try {
					stale = dispatcher.isStale(entry.value);
				} catch (error) {
					logger.warn("Yield queue stale check failed", { kind, error: formatError(error) });
					this.#requeue(kind, [entry]);
					this.rearmIdle();
					continue;
				}
				if (stale) continue;
			}
			survivors.push(entry);
		}
		if (survivors.length === 0) return null;
		// Build one message per ownership-origin group (when the dispatcher
		// declares a groupKey) so a later owned-scope drop of one group never
		// suppresses another group's entries. Groups are partitioned into
		// CONTIGUOUS origin runs (preserving the queued FIFO chronology): with
		// entries A1, B1, A2, a map grouping every A together would deliver A2
		// before the earlier B1, changing the observable order of async results
		// (review thread P2).
		const groups: StoredEntry[][] = [];
		let currentGroupKey: string | undefined;
		for (const entry of survivors) {
			const key = dispatcher.groupKey ? dispatcher.groupKey(entry.value) : "default";
			const last = groups[groups.length - 1];
			if (last !== undefined && currentGroupKey === key) {
				last.push(entry);
			} else {
				groups.push([entry]);
				currentGroupKey = key;
			}
		}
		const messages: BuiltMessage[] = [];
		for (const group of groups.values()) {
			try {
				const message = dispatcher.build(group.map(entry => entry.value));
				if (message) messages.push({ message, entries: group });
				else this.#notifyDropped(dispatcher, group);
			} catch (error) {
				logger.warn("Yield queue build failed", { kind, error: formatError(error) });
				this.#requeue(kind, group);
				this.rearmIdle();
			}
		}
		return messages.length > 0 ? messages : null;
	}

	#identitiesAreCurrent(batches: FlushBatch[]): boolean {
		return batches.every(batch =>
			batch.built.entries.every(
				entry => entry.identity === undefined || (this.#options.isIdentityCurrent?.(entry.identity) ?? true),
			),
		);
	}

	#batchesAreCurrent(batches: FlushBatch[]): boolean {
		return batches.every(batch => this.#isGenerationCurrent(batch));
	}

	#requeueBatches(batches: FlushBatch[]): void {
		const retryable = batches.filter(batch => this.#isGenerationCurrent(batch));
		for (const batch of batches) {
			if (!this.#isGenerationCurrent(batch)) this.#notifyDropped(batch.dispatcher, batch.built.entries);
		}
		const entriesByKind = new Map<string, StoredEntry[]>();
		for (const { kind, built } of retryable) {
			const entries = entriesByKind.get(kind);
			if (entries) entries.push(...built.entries);
			else entriesByKind.set(kind, [...built.entries]);
		}
		for (const [kind, entries] of entriesByKind) this.#requeue(kind, entries);
		this.rearmIdle();
	}

	#generationFor(kind: string): number {
		return this.#clearGeneration + (this.#kindClearGenerations.get(kind) ?? 0);
	}

	#isGenerationCurrent(batch: FlushBatch): boolean {
		return batch.generation === this.#generationFor(batch.kind);
	}

	#requeue(kind: string, entries: StoredEntry[]): void {
		if (entries.length === 0) return;
		// Put the drained entries back in front of anything enqueued while the
		// injector was waiting so a retry cannot reorder or duplicate delivery.
		const existing = this.#entries.get(kind);
		this.#entries.set(kind, existing ? [...entries, ...existing] : [...entries]);
	}

	#notifyDelivered(dispatcher: StoredDispatcher | undefined, entries: StoredEntry[]): void {
		if (!dispatcher?.onDelivered) return;
		for (const entry of entries) dispatcher.onDelivered(entry.value);
	}

	#notifyDropped(dispatcher: StoredDispatcher | undefined, entries: StoredEntry[]): void {
		if (!dispatcher?.onDrop) return;
		for (const entry of entries) dispatcher.onDrop(entry.value);
	}

	#notifyDeliveredBatches(batches: Array<{ dispatcher: StoredDispatcher; built: BuiltMessage }>): void {
		for (const { dispatcher, built } of batches) this.#notifyDelivered(dispatcher, built.entries);
	}

	#notifyDroppedBatches(batches: Array<{ dispatcher: StoredDispatcher; built: BuiltMessage }>): void {
		for (const { dispatcher, built } of batches) this.#notifyDropped(dispatcher, built.entries);
	}
}

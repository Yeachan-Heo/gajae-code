import type { AgentMessage } from "@gajae-code/agent-core";
import { logger } from "@gajae-code/utils";

export interface YieldDispatcher<P> {
	/** Drop entries already delivered through another path. Called per-entry at flush time. */
	isStale?(entry: P): boolean;
	/**
	 * Optional ownership-origin key: when provided, the flush builds ONE
	 * message per distinct key instead of one message for the whole batch, so
	 * a later scope:"owned" drop of one origin never suppresses entries of
	 * another origin (review thread P2).
	 */
	groupKey?(entry: P): string;
	/** Produce one batched AgentMessage from non-stale entries. Return null to skip. */
	build(survivors: P[]): AgentMessage | null;
}

export interface YieldQueueOptions {
	isStreaming: () => boolean;
	injectStreaming(msg: AgentMessage): void;
	injectIdle(messages: AgentMessage[], signal?: AbortSignal): Promise<void>;
	scheduleIdleFlush(run: (signal?: AbortSignal) => Promise<void>, onSkip: () => void): void;
	getIdleFlushSignal?(): AbortSignal | undefined;
}

type YieldFlushMode = "streaming" | "idle";

interface StoredDispatcher {
	isStale?: (entry: unknown) => boolean;
	groupKey?: (entry: unknown) => string;
	build: (survivors: unknown[]) => AgentMessage | null;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class YieldQueue {
	readonly #options: YieldQueueOptions;
	readonly #dispatchers = new Map<string, StoredDispatcher>();
	readonly #entries = new Map<string, unknown[]>();
	#idleFlushPending = false;
	#idleFlushPendingOwner: symbol | undefined;

	constructor(options: YieldQueueOptions) {
		this.#options = options;
	}

	register<P>(kind: string, dispatcher: YieldDispatcher<P>): () => void {
		const stored: StoredDispatcher = {
			...(dispatcher.isStale ? { isStale: entry => dispatcher.isStale?.(entry as P) ?? false } : {}),
			...(dispatcher.groupKey ? { groupKey: entry => dispatcher.groupKey?.(entry as P) ?? "default" } : {}),
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
		entries.push(entry);
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
		const messages = this.drainMessages();
		if (mode === "streaming") {
			for (const message of messages) {
				try {
					this.#options.injectStreaming(message);
				} catch (error) {
					logger.warn("Yield queue streaming dispatch failed", { error: formatError(error) });
				}
			}
			return;
		}
		if (messages.length > 0) {
			try {
				await this.#options.injectIdle(messages, signal ?? this.#options.getIdleFlushSignal?.());
			} catch (error) {
				logger.warn("Yield queue idle dispatch failed", { error: formatError(error) });
			}
		}
	}

	clear(onDrop?: (kind: string, entries: readonly unknown[]) => void): void {
		if (onDrop) {
			for (const [kind, entries] of this.#entries) onDrop(kind, entries);
		}
	drainMessages(): AgentMessage[] {
		const messages: AgentMessage[] = [];
		for (const [kind, dispatcher] of this.#dispatchers) {
			const entries = this.#drain(kind);
			if (entries.length === 0) continue;
			messages.push(...(this.#build(kind, dispatcher, entries) ?? []));
		}
		return messages;
	}

		this.#entries.clear();
		this.#idleFlushPending = false;
		this.#idleFlushPendingOwner = undefined;
	}

	/** Drop only the queued entries of a single kind, leaving other kinds intact. */
	clearKind(kind: string): void {
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

	#drain(kind: string): unknown[] {
		const entries = this.#entries.get(kind);
		if (!entries || entries.length === 0) return [];
		this.#entries.delete(kind);
		return entries;
	}

	#build(kind: string, dispatcher: StoredDispatcher, entries: unknown[]): AgentMessage[] | null {
		// Corrected turn semantics (terminal abort): turn-scope abort blocks only
		// deliveries whose origin is a continuation of the aborted turn.
		// Owned-completion deliveries from work deliberately left running are
		// intentionally allowed to resume the agent through the normal
		// followUp/prompt path and receive a fresh turn attempt. A closed
		// terminal record must never make an allowed owned-completion entry
		// stale merely because it is closed; stale filtering below applies only
		// to ordinary manager state (e.g. isDeliverySuppressed) or explicit
		// blocked-continuation/owned-cleanup entries.
		const survivors: unknown[] = [];
		for (const entry of entries) {
			if (dispatcher.isStale) {
				let stale: boolean;
				try {
					stale = dispatcher.isStale(entry);
				} catch (error) {
					logger.warn("Yield queue stale check failed", { kind, error: formatError(error) });
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
		const groups: unknown[][] = [];
		let currentGroupKey: string | undefined;
		for (const entry of survivors) {
			const key = dispatcher.groupKey ? dispatcher.groupKey(entry) : "default";
			const last = groups[groups.length - 1];
			if (last !== undefined && currentGroupKey === key) {
				last.push(entry);
			} else {
				groups.push([entry]);
				currentGroupKey = key;
			}
		}
		const messages: AgentMessage[] = [];
		for (const group of groups.values()) {
			try {
				const message = dispatcher.build(group);
				if (message) messages.push(message);
			} catch (error) {
				logger.warn("Yield queue build failed", { kind, error: formatError(error) });
			}
		}
		return messages.length > 0 ? messages : null;
	}
}

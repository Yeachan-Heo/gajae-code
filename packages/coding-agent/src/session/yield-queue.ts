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
	isTransitionFenced?: () => boolean;
	injectStreaming(msg: AgentMessage): void;
	injectIdle(messages: AgentMessage[]): Promise<void>;
	scheduleIdleFlush(run: () => Promise<void>): void;
}

type YieldFlushMode = "streaming" | "idle";

interface StoredDispatcher {
	isStale?: (entry: unknown) => boolean;
	groupKey?: (entry: unknown) => string;
	build: (survivors: unknown[]) => AgentMessage | null;
}

interface BuiltMessage {
	message: AgentMessage;
	kind: string;
	dispatcher: StoredDispatcher;
	entries: unknown[];
}

interface DeferredIdleMessage {
	message: AgentMessage;
	/** Raw queue provenance. Legacy callers may provide only a built message. */
	kind?: string;
	dispatcher?: StoredDispatcher;
	entries?: unknown[];
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class YieldQueue {
	readonly #options: YieldQueueOptions;
	readonly #dispatchers = new Map<string, StoredDispatcher>();
	readonly #entries = new Map<string, unknown[]>();
	#idleFlushPending = false;
	#deferredIdleMessages: DeferredIdleMessage[] = [];
	readonly #messageProvenance = new WeakMap<AgentMessage, DeferredIdleMessage>();

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
			this.#deferredIdleMessages = this.#deferredIdleMessages.filter(entry => entry.kind !== kind);
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
		if (kind !== undefined) {
			if ((this.#entries.get(kind)?.length ?? 0) > 0) return true;
			return this.#deferredIdleMessages.some(entry => entry.kind === kind);
		}
		if (this.#deferredIdleMessages.length > 0) return true;
		for (const entries of this.#entries.values()) {
			if (entries.length > 0) return true;
		}
		return false;
	}

	async flush(mode: YieldFlushMode): Promise<void> {
		if (mode === "idle") {
			if (this.#options.isTransitionFenced?.()) return;
			this.#idleFlushPending = false;
		}
		if (mode === "streaming" && this.#options.isTransitionFenced?.()) return;
		// Deferred idle deliveries stay idle-only: a streaming flush must not turn a
		// transition-held completion into a prompt for the active turn.
		const messages = this.#drainMessages(false, mode === "idle");
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
				await this.#options.injectIdle(messages);
			} catch (error) {
				logger.warn("Yield queue idle dispatch failed", { error: formatError(error) });
			}
		}
	}

	deferIdle(messages: AgentMessage[]): void {
		if (messages.length === 0) return;
		for (const message of messages) {
			const provenance = this.#messageProvenance.get(message);
			this.#deferredIdleMessages.push(provenance ? { ...provenance } : { message });
		}
		this.#scheduleIdleFlush();
	}

	drainMessages(includeStale = false): AgentMessage[] {
		return this.#drainMessages(includeStale, true);
	}

	drainKindMessages(kind: string, includeStale = false): AgentMessage[] {
		const messages = this.#drainDeferredMessages(includeStale, kind);
		const dispatcher = this.#dispatchers.get(kind);
		if (!dispatcher) return messages;
		const entries = this.#drain(kind);
		if (entries.length > 0) messages.push(...this.#recordBuiltMessages(kind, dispatcher, entries, includeStale));
		return messages;
	}

	#drainMessages(includeStale: boolean, includeDeferred: boolean): AgentMessage[] {
		const messages = includeDeferred ? this.#drainDeferredMessages(includeStale) : [];
		for (const [kind, dispatcher] of this.#dispatchers) {
			const entries = this.#drain(kind);
			if (entries.length === 0) continue;
			messages.push(...this.#recordBuiltMessages(kind, dispatcher, entries, includeStale));
		}
		return messages;
	}

	#recordBuiltMessages(
		kind: string,
		dispatcher: StoredDispatcher,
		entries: unknown[],
		includeStale: boolean,
	): AgentMessage[] {
		const built = this.#build(kind, dispatcher, entries, includeStale) ?? [];
		for (const item of built) {
			this.#messageProvenance.set(item.message, {
				message: item.message,
				kind: item.kind,
				dispatcher: item.dispatcher,
				entries: item.entries,
			});
		}
		return built.map(item => item.message);
	}

	#drainDeferredMessages(includeStale: boolean, kind?: string): AgentMessage[] {
		if (this.#deferredIdleMessages.length === 0) return [];
		const selected: DeferredIdleMessage[] = [];
		const retained: DeferredIdleMessage[] = [];
		for (const deferred of this.#deferredIdleMessages) {
			if (kind === undefined || deferred.kind === kind) selected.push(deferred);
			else retained.push(deferred);
		}
		this.#deferredIdleMessages = retained;
		const messages: AgentMessage[] = [];
		for (const deferred of selected) {
			if (deferred.kind === undefined || deferred.dispatcher === undefined || deferred.entries === undefined) {
				messages.push(deferred.message);
				continue;
			}
			messages.push(
				...this.#recordBuiltMessages(deferred.kind, deferred.dispatcher, deferred.entries, includeStale),
			);
		}
		return messages;
	}

	clear(): void {
		this.#entries.clear();
		this.#deferredIdleMessages = [];
		this.#idleFlushPending = false;
	}

	/** Drop only the queued entries of a single kind, leaving other kinds intact. */
	clearKind(kind: string): void {
		this.#entries.delete(kind);
		this.#deferredIdleMessages = this.#deferredIdleMessages.filter(entry => entry.kind !== kind);
		this.#idleFlushPending = false;
		this.rearmIdle();
	}

	/**
	 * Re-schedule an idle flush if work remains and the session is idle. Used after
	 * a transition (e.g. handoff) releases a delivery fence so entries queued while
	 * fenced are not stranded until an unrelated enqueue or agent yield.
	 */
	rearmIdle(): void {
		if (this.#options.isStreaming()) return;
		if (this.#deferredIdleMessages.length > 0) {
			this.#scheduleIdleFlush();
			return;
		}
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
		try {
			this.#options.scheduleIdleFlush(async () => {
				this.#idleFlushPending = false;
				if (this.#options.isStreaming()) return;
				await this.flush("idle");
			});
		} catch (error) {
			this.#idleFlushPending = false;
			logger.warn("Yield queue idle flush scheduling failed", { error: formatError(error) });
		}
	}

	#drain(kind: string): unknown[] {
		const entries = this.#entries.get(kind);
		if (!entries || entries.length === 0) return [];
		this.#entries.delete(kind);
		return entries;
	}

	#build(kind: string, dispatcher: StoredDispatcher, entries: unknown[], includeStale = false): BuiltMessage[] | null {
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
			if (!includeStale && dispatcher.isStale) {
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
		const messages: BuiltMessage[] = [];
		for (const group of groups.values()) {
			try {
				const message = dispatcher.build(group);
				if (message) messages.push({ message, kind, dispatcher, entries: group });
			} catch (error) {
				logger.warn("Yield queue build failed", { kind, error: formatError(error) });
			}
		}
		return messages.length > 0 ? messages : null;
	}
}

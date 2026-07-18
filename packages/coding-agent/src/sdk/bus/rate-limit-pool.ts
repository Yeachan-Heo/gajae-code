/**
 * Host-wide shared Telegram rate-limit pool for the threaded session surface.
 *
 * Multiple GJC sessions on one host share a single bot token and paired chat.
 * Telegram enforces per-bot/per-chat limits (~1 message/sec, bursts up to ~20),
 * so the singleton notifications daemon owns ONE pool that all per-session
 * threads draw from. The pool provides:
 *
 * - a token bucket (burst capacity + steady refill) modelling the chat limit;
 * - priority lanes (`ask` > `finalized` > `live` > `idle`) so urgent frames
 *   win scarce tokens;
 * - per-session round-robin fairness within a lane so one session's live-edit
 *   stream cannot starve other sessions;
 * - coalescing of live edits that share a `coalesceKey` (the latest rendered
 *   text replaces the queued one) so throttled edit storms collapse.
 *
 * The core is a pull-based scheduler with an injectable clock so fairness,
 * starvation, and burst behaviour are deterministically unit-testable without
 * real time or a live Bot API.
 */

/** Delivery lanes in descending priority. */
export type RateLimitLane = "ask" | "finalized" | "live" | "idle";

/** Lanes ordered from highest to lowest priority. */
export const LANE_PRIORITY: readonly RateLimitLane[] = ["ask", "finalized", "live", "idle"];

/** A unit of work competing for a send slot. */
export interface RateLimitItem<T = unknown> {
	/** Owning session id (used for per-session fairness). */
	sessionId: string;
	/** Priority lane. */
	lane: RateLimitLane;
	/**
	 * Optional coalesce key. Submitting another unidentifiable item with the
	 * same `(sessionId, lane, coalesceKey)` replaces the queued payload with
	 * the newer one instead of enqueuing a duplicate (used for live edits).
	 */
	coalesceKey?: string;
	/** Optional stable identifier for exact queued-item removal. Identified items never coalesce. */
	itemId?: string;
	/** Absolute Unix timestamp in ms. The item expires when `now >= deadlineAt`. */
	deadlineAt?: number;
	/** Opaque payload the caller maps to an actual Telegram send. */
	payload: T;
}

export type RateLimitDisposition = "queued" | "sending" | "accepted" | "rejected" | "ambiguous" | "removed" | "expired";
export interface RateLimitHandle {
	itemId: string;
	settled: Promise<Exclude<RateLimitDisposition, "queued" | "sending">>;
}

/** Options for {@link RateLimitPool}. */
export interface RateLimitPoolOptions {
	/** Burst capacity (max tokens). Default 20 (Telegram per-chat burst). */
	capacity?: number;
	/** Steady refill rate in tokens per second. Default 1 (~1 msg/sec/chat). */
	refillPerSec?: number;
	/** Injectable clock in ms. Default `Date.now`. */
	now?: () => number;
}

interface QueuedItem<T> {
	item: RateLimitItem<T>;
	seq: number;
}

/** The deterministic result of draining queued work at a point in time. */
export interface RateLimitDrainResult<T = unknown> {
	/** Items granted a token and ready to send. */
	granted: RateLimitItem<T>[];
	/** Items removed because their absolute deadline has elapsed. */
	expired: RateLimitItem<T>[];
}

/**
 * A deterministic, pull-based shared rate-limit scheduler.
 *
 * Callers {@link submit} work and periodically {@link drain} (e.g. on a timer
 * or after each submit); `drain` returns the items granted a send slot, in the
 * order they should be sent.
 */
export class RateLimitPool<T = unknown> {
	private readonly capacity: number;
	private readonly refillPerSec: number;
	private readonly now: () => number;

	/** Per-lane FIFO queues; each lane holds items across sessions. */
	private readonly lanes = new Map<RateLimitLane, QueuedItem<T>[]>();
	/** Rotating session cursor per lane for round-robin fairness. */
	private readonly laneCursor = new Map<RateLimitLane, number>();

	private tokens: number;
	private lastRefill: number;
	private readonly settlements = new Map<
		string,
		PromiseWithResolvers<Exclude<RateLimitDisposition, "queued" | "sending">>
	>();

	private seqCounter = 0;

	constructor(options: RateLimitPoolOptions = {}) {
		this.capacity = Math.max(1, options.capacity ?? 20);
		this.refillPerSec = Math.max(0, options.refillPerSec ?? 1);
		this.now = options.now ?? Date.now;
		this.tokens = this.capacity;
		this.lastRefill = this.now();
		for (const lane of LANE_PRIORITY) this.lanes.set(lane, []);
	}

	/** Number of items currently queued across all lanes. */
	get pending(): number {
		let total = 0;
		for (const queue of this.lanes.values()) total += queue.length;
		return total;
	}

	/** Current available token count (after refill at `now`). */
	availableTokens(nowMs: number = this.now()): number {
		this.refill(nowMs);
		return this.tokens;
	}

	/**
	 * Submit an item. Unidentified items with a `coalesceKey` matching a queued
	 * item in the same `(sessionId, lane)` replace its payload (latest wins)
	 * while preserving FIFO position; identified items are always appended.
	 */
	submit(item: RateLimitItem<T>): RateLimitHandle {
		const itemId = item.itemId ?? `rate-limit:${this.seqCounter++}`;
		const identified = item.itemId === undefined ? { ...item, itemId } : item;
		const queue = this.lanes.get(identified.lane);
		if (!queue) throw new Error(`unknown rate-limit lane: ${identified.lane}`);
		if (item.itemId === undefined && identified.coalesceKey !== undefined) {
			const existing = queue.find(
				q => q.item.sessionId === identified.sessionId && q.item.coalesceKey === identified.coalesceKey,
			);
			if (existing) {
				this.settle(existing.item.itemId!, "removed");
				existing.item = identified;
				return this.handle(itemId);
			}
		}
		queue.push({ item: identified, seq: item.itemId === undefined ? this.seqCounter - 1 : this.seqCounter++ });
		return this.handle(itemId);
	}

	/** Settle a stable item after its external transport effect has a known outcome. */
	settle(itemId: string, disposition: Exclude<RateLimitDisposition, "queued" | "sending">): void {
		const deferred = this.settlements.get(itemId);
		if (!deferred) return;
		this.settlements.delete(itemId);
		deferred.resolve(disposition);
	}

	/** Mark a granted item as owned by an external transport effect. */
	markSending(itemId: string): void {
		if (!this.settlements.has(itemId)) throw new Error(`unknown rate-limit item: ${itemId}`);
	}

	private handle(itemId: string): RateLimitHandle {
		let deferred = this.settlements.get(itemId);
		if (!deferred) {
			deferred = Promise.withResolvers<Exclude<RateLimitDisposition, "queued" | "sending">>();
			this.settlements.set(itemId, deferred);
		}
		return { itemId, settled: deferred.promise };
	}

	/**
	 * Grant as many queued items as tokens allow at `nowMs`. This compatibility
	 * wrapper discards items that expired during the drain.
	 */
	drain(nowMs: number = this.now()): RateLimitItem<T>[] {
		return this.drainWithExpired(nowMs).granted;
	}

	/**
	 * Deterministically expire elapsed-deadline items, then grant as many live
	 * items as tokens allow. Expired items never consume tokens or receive a
	 * grant; both result lists preserve their deterministic queue ordering.
	 */
	drainWithExpired(nowMs: number = this.now()): RateLimitDrainResult<T> {
		this.refill(nowMs);
		const expired = this.removeWhere(item => item.deadlineAt !== undefined && item.deadlineAt <= nowMs, "expired");

		const granted: RateLimitItem<T>[] = [];
		while (this.tokens >= 1) {
			const next = this.takeNext();
			if (!next) break;
			this.tokens -= 1;
			granted.push(next);
		}
		return { granted, expired };
	}

	/** Remove queued items matching `predicate` without consuming tokens. Returns removed items in lane/FIFO order. */
	removeWhere(
		predicate: (item: RateLimitItem<T>) => boolean,
		disposition: Exclude<RateLimitDisposition, "queued" | "sending"> = "removed",
	): RateLimitItem<T>[] {
		const removed: RateLimitItem<T>[] = [];
		for (const lane of LANE_PRIORITY) {
			const queue = this.lanes.get(lane)!;
			let write = 0;
			for (let read = 0; read < queue.length; read++) {
				const queued = queue[read]!;
				if (predicate(queued.item)) {
					removed.push(queued.item);
					this.settle(queued.item.itemId!, disposition);
				} else {
					queue[write++] = queued;
				}
			}
			queue.length = write;
		}
		return removed;
	}

	/** Remove exactly one queued item by its stable id without consuming a token. */
	removeById(itemId: string): RateLimitItem<T> | undefined {
		for (const lane of LANE_PRIORITY) {
			const queue = this.lanes.get(lane)!;
			const index = queue.findIndex(queued => queued.item.itemId === itemId);
			if (index >= 0) {
				const item = queue.splice(index, 1)[0]!.item;
				this.settle(item.itemId!, "removed");
				return item;
			}
		}
		return undefined;
	}

	private refill(nowMs: number): void {
		if (nowMs <= this.lastRefill) return;
		const elapsedSec = (nowMs - this.lastRefill) / 1000;
		this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
		this.lastRefill = nowMs;
	}

	/** Pop the next item by lane priority + per-session round-robin fairness. */
	private takeNext(): RateLimitItem<T> | undefined {
		for (const lane of LANE_PRIORITY) {
			const queue = this.lanes.get(lane)!;
			if (queue.length === 0) continue;
			const picked = this.pickFairIndex(lane, queue);
			const [removed] = queue.splice(picked, 1);
			if (removed) this.markSending(removed.item.itemId!);
			return removed?.item;
		}
		return undefined;
	}

	/**
	 * Choose the index to serve from a lane queue using round-robin over the
	 * distinct session ids present, starting just after the last-served
	 * session. Falls back to FIFO (index 0) when only one session is queued.
	 */
	private pickFairIndex(lane: RateLimitLane, queue: QueuedItem<T>[]): number {
		const sessions: string[] = [];
		for (const q of queue) if (!sessions.includes(q.item.sessionId)) sessions.push(q.item.sessionId);
		if (sessions.length <= 1) return 0;
		const cursor = this.laneCursor.get(lane) ?? 0;
		// Choose the earliest-queued item whose session is the next in rotation.
		for (let offset = 0; offset < sessions.length; offset++) {
			const candidate = sessions[(cursor + offset) % sessions.length]!;
			const idx = queue.findIndex(q => q.item.sessionId === candidate);
			if (idx >= 0) {
				this.laneCursor.set(lane, (cursor + offset + 1) % sessions.length);
				return idx;
			}
		}
		return 0;
	}
}

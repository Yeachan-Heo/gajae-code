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
	 * Optional coalesce key. Submitting another item with the same
	 * `(sessionId, lane, coalesceKey)` replaces the queued payload with the
	 * newer one instead of enqueuing a duplicate (used for live edits).
	 */
	coalesceKey?: string;
	/** Opaque payload the caller maps to an actual Telegram send. */
	payload: T;
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
	 * Submit an item. If it carries a `coalesceKey` matching a queued item in
	 * the same `(sessionId, lane)`, the queued payload is replaced (latest
	 * wins) and FIFO position is preserved; otherwise it is appended.
	 */
	submit(item: RateLimitItem<T>): void {
		const queue = this.lanes.get(item.lane);
		if (!queue) throw new Error(`unknown rate-limit lane: ${item.lane}`);
		if (item.coalesceKey !== undefined) {
			const existing = queue.find(
				q => q.item.sessionId === item.sessionId && q.item.coalesceKey === item.coalesceKey,
			);
			if (existing) {
				existing.item = item;
				return;
			}
		}
		queue.push({ item, seq: this.seqCounter++ });
	}

	/**
	 * Grant as many queued items as tokens allow at `nowMs`. Items are selected
	 * by lane priority, then round-robin across sessions within a lane (so no
	 * single session monopolises a lane), consuming one token each.
	 */
	drain(nowMs: number = this.now()): RateLimitItem<T>[] {
		this.refill(nowMs);
		const granted: RateLimitItem<T>[] = [];
		while (this.tokens >= 1) {
			const next = this.takeNext();
			if (!next) break;
			this.tokens -= 1;
			granted.push(next);
		}
		return granted;
	}

	/** Remove queued items matching `predicate` without consuming tokens. Returns removed items in lane/FIFO order. */
	removeWhere(predicate: (item: RateLimitItem<T>) => boolean): RateLimitItem<T>[] {
		const removed: RateLimitItem<T>[] = [];
		for (const lane of LANE_PRIORITY) {
			const queue = this.lanes.get(lane)!;
			let write = 0;
			for (let read = 0; read < queue.length; read++) {
				const queued = queue[read]!;
				if (predicate(queued.item)) {
					removed.push(queued.item);
				} else {
					queue[write++] = queued;
				}
			}
			queue.length = write;
		}
		return removed;
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

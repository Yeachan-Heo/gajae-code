/**
 * Per-PR review state machine, shared across processes (server, `complete`
 * CLI invocations from agent turns, sweeper).
 *
 * State machine (per PR):
 *   review_status: idle | queued | in_flight | posted | failed
 *   in_flight_sha / in_flight_since / check_id  — current review run
 *   pending_sha                                 — newer head arrived mid-review (supersede)
 *   queued_sha / queued_since                   — waiting for a concurrency slot
 *   last_reviewed_sha / review_count            — set on successful completion
 *
 * Every read-modify-write goes through an exclusive on-disk lock: the bare
 * read-modify-write this replaced lost ~50% of concurrent updates (measured
 * on the predecessor pipeline).
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type GateStatus = "acquired" | "duplicate" | "superseded" | "queued";

export interface PrState {
	review_status?: "idle" | "queued" | "in_flight" | "posted" | "failed";
	in_flight_sha?: string;
	in_flight_since?: number;
	check_id?: number;
	pending_sha?: string;
	queued_sha?: string;
	queued_since?: number;
	last_reviewed_sha?: string;
	review_count?: number;
	summary_comment_id?: number;
	dup_notified_sha?: string;
	paused?: boolean;
	updated_at?: number;
}

export interface CompleteResult {
	stale: boolean;
	pendingSha: string | null;
	checkId: number | null;
	durationSeconds: number | null;
}

export interface DrainCandidate {
	repo: string;
	pr: number;
	sha: string;
}

const LOCK_STALE_MS = 30_000;
const LOCK_SPIN_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;

/** Cross-process mutex via exclusive lockdir creation with stale takeover. */
function withFileLock<T>(lockDir: string, fn: () => T): T {
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	for (;;) {
		try {
			fs.mkdirSync(lockDir);
			break;
		} catch {
			try {
				const age = Date.now() - fs.statSync(lockDir).mtimeMs;
				if (age > LOCK_STALE_MS) {
					fs.rmdirSync(lockDir);
					continue;
				}
			} catch {
				continue; // raced with the holder's release — retry immediately
			}
			if (Date.now() > deadline) throw new Error(`state lock timeout: ${lockDir}`);
			const until = Date.now() + LOCK_SPIN_MS;
			while (Date.now() < until) {
				/* short blocking spin: state ops are millisecond-scale */
			}
		}
	}
	try {
		return fn();
	} finally {
		try {
			fs.rmdirSync(lockDir);
		} catch {
			/* released by stale takeover */
		}
	}
}

export class ReviewStateStore {
	readonly statePath: string;
	private readonly lockDir: string;

	constructor(
		dataDir: string,
		private readonly inflightStaleSeconds: number,
		private readonly now: () => number = () => Math.floor(Date.now() / 1000),
	) {
		this.statePath = path.join(dataDir, "reviews.json");
		this.lockDir = `${this.statePath}.lock`;
	}

	private load(): Record<string, PrState> {
		try {
			return JSON.parse(fs.readFileSync(this.statePath, "utf8")) as Record<string, PrState>;
		} catch {
			return {};
		}
	}

	private save(state: Record<string, PrState>): void {
		fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
		const tmp = `${this.statePath}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(state));
		fs.renameSync(tmp, this.statePath);
	}

	private key(repo: string, pr: number): string {
		return `${repo}#${pr}`;
	}

	private isFreshInflight(entry: PrState, now: number): boolean {
		return entry.review_status === "in_flight" && now - (entry.in_flight_since ?? 0) < this.inflightStaleSeconds;
	}

	getPrState(repo: string, pr: number): PrState {
		return this.load()[this.key(repo, pr)] ?? {};
	}

	setPrState(repo: string, pr: number, fields: Partial<PrState>): PrState {
		return withFileLock(this.lockDir, () => {
			const state = this.load();
			const cur: PrState = { ...state[this.key(repo, pr)], ...fields, updated_at: this.now() };
			state[this.key(repo, pr)] = cur;
			this.save(state);
			return cur;
		});
	}

	/** Snapshot of all entries (sweeper/status surfaces). */
	entries(): Array<[string, PrState]> {
		return Object.entries(this.load());
	}

	countInflight(): number {
		const now = this.now();
		return Object.values(this.load()).filter(e => this.isFreshInflight(e, now)).length;
	}

	/**
	 * Atomic CAS gate for starting a review of `sha` on repo#pr.
	 *
	 *   acquired   — caller owns the review; state marked in_flight
	 *   duplicate  — same sha already in flight; do nothing
	 *   superseded — an older sha is in flight; sha recorded as pending_sha
	 *   queued     — concurrency cap reached; sha parked as queued_sha
	 */
	tryAcquireReview(
		repo: string,
		pr: number,
		sha: string,
		maxInflight?: number,
	): { status: GateStatus; state: PrState } {
		const now = this.now();
		return withFileLock(this.lockDir, () => {
			const state = this.load();
			const k = this.key(repo, pr);
			const cur: PrState = { ...state[k] };
			let status: GateStatus;
			if (this.isFreshInflight(cur, now)) {
				if (cur.in_flight_sha === sha) {
					status = "duplicate";
				} else {
					cur.pending_sha = sha;
					status = "superseded";
				}
			} else if (
				maxInflight &&
				Object.entries(state).filter(([kk, v]) => kk !== k && this.isFreshInflight(v, now)).length >= maxInflight
			) {
				cur.review_status = "queued";
				cur.queued_sha = sha;
				cur.queued_since = now;
				status = "queued";
			} else {
				cur.review_status = "in_flight";
				cur.in_flight_sha = sha;
				cur.in_flight_since = now;
				delete cur.check_id;
				delete cur.queued_sha;
				delete cur.queued_since;
				if (cur.pending_sha === sha) delete cur.pending_sha;
				status = "acquired";
			}
			cur.updated_at = now;
			state[k] = cur;
			this.save(state);
			return { status, state: { ...cur } };
		});
	}

	/**
	 * Mark the in-flight review of `sha` finished (idempotent).
	 * stale=true → a newer run owns the lock; the caller must not drain or
	 * touch shared state, only clean up artifacts it created itself.
	 */
	completeReview(repo: string, pr: number, sha: string, ok: boolean): CompleteResult {
		const now = this.now();
		return withFileLock(this.lockDir, () => {
			const state = this.load();
			const k = this.key(repo, pr);
			const cur: PrState = { ...state[k] };
			if (this.isFreshInflight(cur, now) && cur.in_flight_sha && cur.in_flight_sha !== sha) {
				return { stale: true, pendingSha: null, checkId: null, durationSeconds: null };
			}
			let pending = cur.pending_sha ?? null;
			if (pending === sha) pending = null;
			const checkId = cur.check_id ?? null;
			const durationSeconds = cur.in_flight_since ? now - cur.in_flight_since : null;
			const alreadyDone =
				!cur.in_flight_sha &&
				(cur.review_status === "posted" || cur.review_status === "failed") &&
				cur.last_reviewed_sha === sha;
			cur.review_status = ok ? "posted" : "failed";
			if (ok) {
				cur.last_reviewed_sha = sha;
				if (!alreadyDone) cur.review_count = (cur.review_count ?? 0) + 1;
			}
			delete cur.in_flight_sha;
			delete cur.in_flight_since;
			delete cur.check_id;
			delete cur.pending_sha;
			cur.updated_at = now;
			state[k] = cur;
			this.save(state);
			return { stale: false, pendingSha: pending, checkId, durationSeconds };
		});
	}

	/**
	 * PRs waiting for a review slot: pending (superseded) first, then queued
	 * (oldest first). Read-only.
	 */
	findDrainCandidates(limit = 3): DrainCandidate[] {
		const now = this.now();
		const pending: DrainCandidate[] = [];
		const queued: Array<{ since: number; c: DrainCandidate }> = [];
		for (const [k, v] of Object.entries(this.load())) {
			const hash = k.lastIndexOf("#");
			if (hash <= 0) continue;
			const repo = k.slice(0, hash);
			const pr = Number(k.slice(hash + 1));
			if (!Number.isInteger(pr)) continue;
			if (this.isFreshInflight(v, now)) continue; // still running; its completion drains pending
			if (v.pending_sha) {
				pending.push({ repo, pr, sha: v.pending_sha });
			} else if (v.review_status === "queued" && v.queued_sha) {
				queued.push({ since: v.queued_since ?? 0, c: { repo, pr, sha: v.queued_sha } });
			}
		}
		queued.sort((a, b) => a.since - b.since);
		return [...pending, ...queued.map(q => q.c)].slice(0, limit);
	}
}

/** Append one structured JSONL event. Best-effort, never throws. */
export function appendEvent(eventsPath: string, kind: string, fields: Record<string, unknown> = {}): void {
	try {
		fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
		const record = { ts: Math.floor(Date.now() / 1000), event: kind, ...fields };
		fs.appendFileSync(eventsPath, `${JSON.stringify(record)}\n`);
	} catch {
		/* diagnostics only */
	}
}

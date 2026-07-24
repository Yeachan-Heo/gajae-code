import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ReviewStateStore } from "../src/github-review/state";

const STALE_SEC = 20 * 60;
const tmps: string[] = [];

function makeStore(now: () => number): ReviewStateStore {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghr-state-"));
	tmps.push(dir);
	return new ReviewStateStore(dir, STALE_SEC, now);
}

afterEach(() => {
	for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("review gate CAS", () => {
	test("acquire → duplicate → supersede", async () => {
		let now = 1000;
		const store = makeStore(() => now);
		expect((await store.tryAcquireReview("o/r", 1, "aaa")).status).toBe("acquired");
		expect((await store.tryAcquireReview("o/r", 1, "aaa")).status).toBe("duplicate");
		const superseded = await store.tryAcquireReview("o/r", 1, "bbb");
		expect(superseded.status).toBe("superseded");
		expect(superseded.state.pending_sha).toBe("bbb");
		now += 10;
		expect(store.getPrState("o/r", 1).in_flight_sha).toBe("aaa");
	});

	test("stale in-flight is re-acquirable", async () => {
		let now = 1000;
		const store = makeStore(() => now);
		await store.tryAcquireReview("o/r", 1, "aaa");
		now += STALE_SEC + 1;
		expect((await store.tryAcquireReview("o/r", 1, "bbb")).status).toBe("acquired");
	});

	test("concurrency cap queues other PRs, not the same PR", async () => {
		const store = makeStore(() => 1000);
		expect((await store.tryAcquireReview("o/r", 1, "aaa", 1)).status).toBe("acquired");
		const queued = await store.tryAcquireReview("o/r", 2, "ccc", 1);
		expect(queued.status).toBe("queued");
		expect(queued.state.queued_sha).toBe("ccc");
		// Same PR with a newer sha supersedes rather than queues.
		expect((await store.tryAcquireReview("o/r", 1, "bbb", 1)).status).toBe("superseded");
	});

	test("acquiring a pending sha clears pending", async () => {
		let now = 1000;
		const store = makeStore(() => now);
		await store.tryAcquireReview("o/r", 1, "aaa");
		await store.tryAcquireReview("o/r", 1, "bbb");
		now += STALE_SEC + 1;
		const acquired = await store.tryAcquireReview("o/r", 1, "bbb");
		expect(acquired.status).toBe("acquired");
		expect(acquired.state.pending_sha).toBeUndefined();
	});
});

describe("completeReview", () => {
	test("success releases state and reports pending + duration", async () => {
		let now = 1000;
		const store = makeStore(() => now);
		await store.tryAcquireReview("o/r", 1, "aaa");
		await store.setPrState("o/r", 1, { check_id: 77 });
		await store.tryAcquireReview("o/r", 1, "bbb"); // supersede
		now += 300;
		const result = await store.completeReview("o/r", 1, "aaa", true);
		expect(result.stale).toBe(false);
		expect(result.pendingSha).toBe("bbb");
		expect(result.checkId).toBe(77);
		expect(result.durationSeconds).toBe(300);
		const state = store.getPrState("o/r", 1);
		expect(state.review_status).toBe("posted");
		expect(state.last_reviewed_sha).toBe("aaa");
		expect(state.review_count).toBe(1);
		expect(state.in_flight_sha).toBeUndefined();
	});

	test("stale when a newer run owns the lock", async () => {
		const store = makeStore(() => 1000);
		await store.tryAcquireReview("o/r", 1, "bbb");
		const result = await store.completeReview("o/r", 1, "aaa", true);
		expect(result.stale).toBe(true);
		expect(store.getPrState("o/r", 1).in_flight_sha).toBe("bbb");
	});

	test("idempotent: re-completing the same sha does not double-count", async () => {
		const store = makeStore(() => 1000);
		await store.tryAcquireReview("o/r", 1, "aaa");
		await store.completeReview("o/r", 1, "aaa", true);
		await store.completeReview("o/r", 1, "aaa", true);
		expect(store.getPrState("o/r", 1).review_count).toBe(1);
	});

	test("failure keeps last_reviewed_sha untouched", async () => {
		const store = makeStore(() => 1000);
		await store.setPrState("o/r", 1, { last_reviewed_sha: "old" });
		await store.tryAcquireReview("o/r", 1, "aaa");
		await store.completeReview("o/r", 1, "aaa", false);
		const state = store.getPrState("o/r", 1);
		expect(state.review_status).toBe("failed");
		expect(state.last_reviewed_sha).toBe("old");
	});
});

describe("drain candidates", () => {
	test("pending first, then queued oldest-first; fresh in-flight excluded", async () => {
		const now = 1000;
		const store = makeStore(() => now);
		// live in-flight with a pending sha → excluded (its completion drains it)
		await store.tryAcquireReview("o/r", 1, "aaa");
		await store.tryAcquireReview("o/r", 1, "bbb");
		// stale in-flight with pending → included
		await store.setPrState("o/r", 2, {
			review_status: "in_flight",
			in_flight_sha: "ccc",
			in_flight_since: now - STALE_SEC - 5,
			pending_sha: "ddd",
		});
		// queued entries, different ages
		await store.setPrState("o/r", 3, { review_status: "queued", queued_sha: "eee", queued_since: now - 50 });
		await store.setPrState("o/r", 4, { review_status: "queued", queued_sha: "fff", queued_since: now - 100 });
		const candidates = store.findDrainCandidates(5);
		expect(candidates).toEqual([
			{ repo: "o/r", pr: 2, sha: "ddd" },
			{ repo: "o/r", pr: 4, sha: "fff" },
			{ repo: "o/r", pr: 3, sha: "eee" },
		]);
	});

	test("countInflight ignores stale entries", async () => {
		let now = 1000;
		const store = makeStore(() => now);
		await store.tryAcquireReview("o/r", 1, "aaa");
		await store.tryAcquireReview("o/r", 2, "bbb");
		expect(store.countInflight()).toBe(2);
		now += STALE_SEC + 1;
		expect(store.countInflight()).toBe(0);
	});
});

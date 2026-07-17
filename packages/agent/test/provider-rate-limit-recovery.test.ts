import { describe, expect, it } from "bun:test";
import {
	type ProviderRateLimitRecoveryClock,
	ProviderRateLimitRecoveryGate,
} from "../src/provider-rate-limit-recovery";

class FakeClock implements ProviderRateLimitRecoveryClock {
	nowMs = 0;
	#nextId = 0;
	#timers = new Map<number, { at: number; callback: () => void }>();
	cancelled: number[] = [];
	scheduledDelays: number[] = [];

	now(): number {
		return this.nowMs;
	}

	setTimeout(callback: () => void, delayMs: number): unknown {
		const id = ++this.#nextId;
		this.#timers.set(id, { at: this.nowMs + delayMs, callback });
		this.scheduledDelays.push(delayMs);
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.cancelled.push(handle as number);
		this.#timers.delete(handle as number);
	}

	advance(ms: number): void {
		this.nowMs += ms;
		for (;;) {
			const due = [...this.#timers.entries()].find(([, timer]) => timer.at <= this.nowMs);
			if (!due) return;
			this.#timers.delete(due[0]);
			due[1].callback();
		}
	}
}

const model = { provider: "provider", id: "model" };
const rateLimit = { type: "error", status: 429 } as const;

function gate() {
	const clock = new FakeClock();
	return { clock, recovery: new ProviderRateLimitRecoveryGate(clock), scope: {} };
}

describe("ProviderRateLimitRecoveryGate", () => {
	it("keeps twelve healthy logical streams unrestricted", async () => {
		const { recovery, scope } = gate();
		const tickets = await Promise.all(Array.from({ length: 12 }, () => recovery.acquire(scope, model)));
		expect(tickets.every(ticket => ticket.kind === "healthy")).toBe(true);
	});

	it("waits for a deadline and admits one FIFO probe (12 speculative streams become 1)", async () => {
		const { clock, recovery, scope } = gate();
		const initial = await recovery.acquire(scope, model);
		recovery.settle(initial, rateLimit, 100);
		const queued = Array.from({ length: 12 }, () => recovery.acquire(scope, model));
		let admitted = 0;
		for (const pending of queued) pending.then(() => admitted++);
		await Promise.resolve();
		expect(admitted).toBe(0);
		clock.advance(100);
		const probe = await queued[0];
		await Promise.resolve();
		expect(probe.kind).toBe("probe");
		expect(admitted).toBe(1);
		recovery.settle(probe, { type: "success" });
		expect((await Promise.all(queued.slice(1))).every(ticket => ticket.kind === "healthy")).toBe(true);
	});

	it("uses generation-bound replacement timers and monotonic deadlines for repeated 429s", async () => {
		const { clock, recovery, scope } = gate();
		const initial = await recovery.acquire(scope, model);
		const lateHealthy = await recovery.acquire(scope, model);
		recovery.settle(initial, rateLimit, 100);
		clock.advance(10);
		recovery.settle(lateHealthy, rateLimit, 20);
		const sibling = recovery.acquire(scope, model);
		expect(clock.cancelled.length).toBeGreaterThanOrEqual(1);
		clock.advance(20);
		let admitted = false;
		sibling.then(() => (admitted = true));
		await Promise.resolve();
		expect(admitted).toBe(false);
		clock.advance(70);
		expect((await sibling).kind).toBe("probe");
	});

	it("does not let stale probe success drain after newer 429 evidence", async () => {
		const { clock, recovery, scope } = gate();
		const initial = await recovery.acquire(scope, model);
		const lateHealthy = await recovery.acquire(scope, model);
		recovery.settle(initial, rateLimit, 10);
		const first = recovery.acquire(scope, model);
		const second = recovery.acquire(scope, model);
		clock.advance(10);
		const staleProbe = await first;
		recovery.settle(lateHealthy, rateLimit, 0);
		recovery.settle(staleProbe, { type: "success" });
		const successor = await second;
		expect(successor.kind).toBe("probe");
	});

	it("promotes one successor after probe 429, abort, throw, or non-429 error", async () => {
		const { clock, recovery, scope } = gate();
		const initial = await recovery.acquire(scope, model);
		recovery.settle(initial, rateLimit, 0);
		const first = await recovery.acquire(scope, model);
		const secondPending = recovery.acquire(scope, model);
		recovery.settle(first, rateLimit, 0);
		const second = await secondPending;
		expect(second.kind).toBe("probe");
		const thirdPending = recovery.acquire(scope, model);
		recovery.settle(second, { type: "threw" });
		expect((await thirdPending).kind).toBe("probe");
		clock.advance(0);
	});

	it("rejects pre-aborted and removes queued aborted waiters", async () => {
		const { recovery, scope } = gate();
		const aborted = new AbortController();
		aborted.abort();
		await expect(recovery.acquire(scope, model, aborted.signal)).rejects.toThrow();
		const initial = await recovery.acquire(scope, model);
		recovery.settle(initial, rateLimit, 100);
		const queuedAbort = new AbortController();
		const queued = recovery.acquire(scope, model, queuedAbort.signal);
		queuedAbort.abort();
		await expect(queued).rejects.toThrow();
	});

	it("isolates opaque scope, provider, and model identities and settles idempotently", async () => {
		const { recovery, scope } = gate();
		const initial = await recovery.acquire(scope, model);
		recovery.settle(initial, rateLimit, 100);
		recovery.settle(initial, rateLimit, 100);
		expect((await recovery.acquire({}, model)).kind).toBe("healthy");
		expect((await recovery.acquire(scope, { provider: "other", id: "model" })).kind).toBe("healthy");
		expect((await recovery.acquire(scope, { provider: "provider", id: "other" })).kind).toBe("healthy");
	});
	it("keeps recovery after an empty timer and recreates it from late healthy 429 evidence", async () => {
		const { clock, recovery, scope } = gate();
		const initial = await recovery.acquire(scope, model);
		recovery.settle(initial, rateLimit, 10);
		clock.advance(10);
		const probe = await recovery.acquire(scope, model);
		recovery.settle(probe, { type: "success" });
		const lateHealthy = await recovery.acquire(scope, model);
		recovery.settle(lateHealthy, rateLimit, 10);
		const blocked = recovery.acquire(scope, model);
		clock.advance(10);
		expect((await blocked).kind).toBe("probe");
	});

	it("advances exactly one queued successor for aborted and non-429 probe outcomes", async () => {
		const { recovery, scope } = gate();
		const initial = await recovery.acquire(scope, model);
		recovery.settle(initial, rateLimit, 0);
		const first = await recovery.acquire(scope, model);
		const secondPending = recovery.acquire(scope, model);
		recovery.settle(first, { type: "aborted" });
		const second = await secondPending;
		const thirdPending = recovery.acquire(scope, model);
		recovery.settle(second, { type: "error", status: 503 });
		expect((await thirdPending).kind).toBe("probe");
	});
	it("rearms oversized retry deadlines in bounded timeout chunks", async () => {
		const { clock, recovery, scope } = gate();
		const maxTimeoutDelay = 2_147_483_647;
		const initial = await recovery.acquire(scope, model);
		recovery.settle(initial, rateLimit, maxTimeoutDelay * 2 + 1);
		const queued = recovery.acquire(scope, model);

		clock.advance(maxTimeoutDelay);
		let admitted = false;
		queued.then(() => (admitted = true));
		await Promise.resolve();
		expect(admitted).toBe(false);
		clock.advance(maxTimeoutDelay);
		await Promise.resolve();
		expect(admitted).toBe(false);
		clock.advance(1);

		expect((await queued).kind).toBe("probe");
		expect(clock.scheduledDelays).toEqual([maxTimeoutDelay, maxTimeoutDelay, 1]);
	});
});

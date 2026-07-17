import { describe, expect, test } from "bun:test";
import {
	NotificationOperatorRuntime,
	OperatorBackoffPolicy,
	OperatorEventRouter,
} from "../src/sdk/bus/operator-runtime";

describe("notification operator runtime core", () => {
	test("tracks lifecycle and aborts the active operation on cooperative stop", () => {
		const runtime = new NotificationOperatorRuntime();
		runtime.start();
		const active = runtime.createAbortController();

		expect(runtime.state).toEqual({ running: true, stopRequested: false, activeAbort: true });

		runtime.requestStop();

		expect(active.signal.aborted).toBe(true);
		expect(runtime.state).toEqual({ running: false, stopRequested: true, activeAbort: true });
		runtime.clearAbortController(active);
		expect(runtime.state.activeAbort).toBe(false);
	});

	test("runs named intervals and exclusive jobs through injected runtime hooks", async () => {
		const intervals = new Map<string, () => void>();
		let nextInterval = 0;
		let clearCount = 0;
		const runtime = new NotificationOperatorRuntime({
			setIntervalImpl: ((fn: () => void) => {
				const id = `timer-${++nextInterval}`;
				intervals.set(id, fn);
				return id as unknown as ReturnType<typeof setInterval>;
			}) as unknown as typeof setInterval,
			clearIntervalImpl: timer => {
				clearCount++;
				intervals.delete(String(timer));
			},
		});
		let ticks = 0;
		runtime.startInterval("scan", 100, () => ticks++);
		runtime.startInterval("scan", 100, () => (ticks += 10));
		intervals.get("timer-1")?.();
		expect(ticks).toBe(1);

		let entered = 0;
		let releaseExclusive: (() => void) | undefined;
		const first = runtime.runExclusive(
			"scan",
			() =>
				new Promise<void>(resolve => {
					entered++;
					releaseExclusive = resolve;
				}),
		);
		await runtime.runExclusive("scan", async () => {
			entered += 10;
		});
		expect(entered).toBe(1);
		releaseExclusive?.();
		await first;

		runtime.stopInterval("scan");
		expect(clearCount).toBe(1);
		expect(intervals.size).toBe(0);
	});

	test("shares bounded backoff semantics independently of Telegram", () => {
		const backoff = new OperatorBackoffPolicy({ initialMs: 500, maxMs: 2_000 });
		expect([backoff.next(), backoff.next(), backoff.next(), backoff.next()]).toEqual([500, 1_000, 2_000, 2_000]);
		backoff.reset();
		expect(backoff.currentMs).toBe(0);
		expect(backoff.next()).toBe(500);
	});

	test("routes operator events by first matching handler", async () => {
		const seen: string[] = [];
		const router = new OperatorEventRouter<{ prefix: string }>()
			.add({
				name: "ignore",
				matches: event => event.type === "missing",
				handle: context => {
					seen.push(`${context.prefix}:missing`);
				},
			})
			.add({
				name: "activity",
				matches: event => event.type === "activity",
				handle: (context, event) => {
					seen.push(`${context.prefix}:${String(event.state)}`);
				},
			});

		expect(await router.dispatch({ prefix: "session" }, { type: "activity", state: "busy" })).toBe(true);
		expect(await router.dispatch({ prefix: "session" }, { type: "unknown" })).toBe(false);
		expect(seen).toEqual(["session:busy"]);
	});
});

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

	test("synchronous exclusive failure releases the name for a successor", async () => {
		const runtime = new NotificationOperatorRuntime();
		await expect(
			runtime.runExclusive("scan", () => {
				throw new Error("sync failure");
			}),
		).rejects.toThrow("sync failure");
		let secondRan = false;
		await runtime.runExclusive("scan", async () => {
			secondRan = true;
		});
		expect(secondRan).toBe(true);
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
	test("joins tracked exclusive work without consulting an injectable clock", async () => {
		let release: (() => void) | undefined;
		const runtime = new NotificationOperatorRuntime({ now: () => 0 });
		const work = runtime.runExclusive(
			"heartbeat",
			() =>
				new Promise<void>(resolve => {
					release = resolve;
				}),
		);
		const joined = runtime.joinExclusive("heartbeat", 1_000);
		release?.();
		expect(await joined).toBe(true);
		await work;
	});

	test("times out joining exclusive work using a real timer even with a frozen clock", async () => {
		let release: (() => void) | undefined;
		const runtime = new NotificationOperatorRuntime({ now: () => 0 });
		const work = runtime.runExclusive(
			"heartbeat",
			() =>
				new Promise<void>(resolve => {
					release = resolve;
				}),
		);
		expect(await runtime.joinExclusive("heartbeat", 1)).toBe(false);
		release?.();
		await work;
	});

	test("stops zero-valued interval handles", () => {
		const cleared: unknown[] = [];
		const runtime = new NotificationOperatorRuntime({
			setIntervalImpl: (() => 0) as unknown as typeof setInterval,
			clearIntervalImpl: timer => {
				cleared.push(timer);
			},
		});
		runtime.startInterval("heartbeat", 1_000, () => {});
		runtime.stopInterval("heartbeat");
		expect(cleared).toEqual([0]);
	});
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cancellableSleep } from "../src/sdk/broker/startup-budget";

const ROUTER_SOURCE = readFileSync(join(import.meta.dir, "../src/sdk/router/session-router.ts"), "utf8");

/**
 * How long a pending timer keeps this process from reaching `beforeExit`.
 *
 * A one-shot `gjc sdk` command exits once nothing holds the event loop. Any
 * timer that outlives the work it was bounding therefore turns into wall-clock
 * latency the caller pays after the response is already written, which is why
 * these tests measure loop release rather than the settle time of the race.
 */
async function loopHoldMs(race: (signal: AbortSignal) => Promise<unknown>): Promise<number> {
	const controller = new AbortController();
	const started = Date.now();
	await race(controller.signal);
	const settled = Date.now();
	// A macrotask observes timers registered by the race; a microtask would run
	// before the loop had a chance to notice one is still outstanding.
	await new Promise<void>(resolve => setTimeout(resolve, 0));
	const releasedAfterSettle = Date.now() - settled;
	expect(Date.now() - started).toBeLessThan(1_000);
	return releasedAfterSettle;
}

describe("SessionRouter exit promptness", () => {
	test("a cancelled timeout releases the loop as soon as the race settles", async () => {
		const held = await loopHoldMs(async signal => {
			const cutoff = new AbortController();
			try {
				return await Promise.race([
					Promise.resolve("work"),
					cancellableSleep(5_000, cutoff.signal).then(() => "timeout"),
				]);
			} finally {
				cutoff.abort();
				signal.throwIfAborted?.();
			}
		});
		expect(held).toBeLessThan(500);
	});

	test("cancellableSleep resolves early instead of waiting out its duration", async () => {
		const controller = new AbortController();
		const started = Date.now();
		const sleeping = cancellableSleep(5_000, controller.signal);
		controller.abort();
		await sleeping;
		expect(Date.now() - started).toBeLessThan(500);
	});

	test("an already-aborted signal does not arm a timer at all", async () => {
		const controller = new AbortController();
		controller.abort();
		const started = Date.now();
		await cancellableSleep(5_000, controller.signal);
		expect(Date.now() - started).toBeLessThan(100);
	});

	test("the Router arms no uncancellable sleep", () => {
		// Bun.sleep cannot be cancelled, so a Promise.race that loses to it keeps the
		// loop alive for the whole budget. Every bounded wait in the Router must use
		// cancellableSleep instead.
		expect(ROUTER_SOURCE).not.toInclude("Bun.sleep(");
	});

	test("every bounded Router wait is cancellable", () => {
		const cancellable = ROUTER_SOURCE.match(/cancellableSleep\(/g) ?? [];
		// startup attach budget, shutdown timeout, notification work, replay backoff
		expect(cancellable.length).toBeGreaterThanOrEqual(4);
	});

	test("the reconcile interval is unref'd where it is armed", () => {
		// A Router started without a matching stop() must not keep a host alive. The
		// assertion is scoped to the reconcile interval because other timers in this
		// file are unref'd too, so a bare source-wide search would still pass with
		// this one missing.
		const armed = ROUTER_SOURCE.indexOf("this.#deps.setInterval ?? setInterval");
		expect(armed).toBeGreaterThan(-1);
		const assignedStopTimer = ROUTER_SOURCE.indexOf("this.#stopTimer =", armed);
		expect(assignedStopTimer).toBeGreaterThan(armed);
		expect(ROUTER_SOURCE.slice(armed, assignedStopTimer)).toInclude("timer.unref?.()");
	});
});

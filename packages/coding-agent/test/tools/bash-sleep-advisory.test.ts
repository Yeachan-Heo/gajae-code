import { describe, expect, it } from "bun:test";
import { longSleepAdvisory } from "../../src/tools/bash-sleep-advisory";

describe("longSleepAdvisory (#4465)", () => {
	it("returns undefined for commands without sleep", () => {
		expect(longSleepAdvisory("git log --oneline -1")).toBeUndefined();
		expect(longSleepAdvisory("bun test")).toBeUndefined();
		expect(longSleepAdvisory("server --port 3000")).toBeUndefined();
		expect(longSleepAdvisory("")).toBeUndefined();
	});

	it("returns undefined for short sleeps below the threshold", () => {
		expect(longSleepAdvisory("sleep 5")).toBeUndefined();
		expect(longSleepAdvisory("sleep 10")).toBeUndefined();
		expect(longSleepAdvisory("sleep 60")).toBeUndefined();
		expect(longSleepAdvisory("sleep 119")).toBeUndefined();
		expect(longSleepAdvisory("sleep 1m")).toBeUndefined();
	});

	it("returns an advisory notice for a standalone long sleep", () => {
		const notice = longSleepAdvisory("sleep 800");
		expect(notice).toBeDefined();
		expect(notice).toContain("#4465");
		expect(notice).toContain("13m");
		expect(notice).toContain("subagent await");
		expect(notice).toContain("job poll");
	});

	it("detects long sleep chained with && (the #4465 repro pattern)", () => {
		const notice = longSleepAdvisory("sleep 800; git log --oneline -1");
		expect(notice).toBeDefined();
		expect(notice).toContain("13m");
	});

	it("detects long sleep with && chaining", () => {
		const notice = longSleepAdvisory("sleep 500 && git log --oneline -1");
		expect(notice).toBeDefined();
		expect(notice).toContain("8m");
	});

	it("detects long sleep with unit suffixes", () => {
		expect(longSleepAdvisory("sleep 3m")).toBeDefined();
		expect(longSleepAdvisory("sleep 2h")).toBeDefined();
		expect(longSleepAdvisory("sleep 1d")).toBeDefined();
		// 1m59s is 119s — just under threshold
		expect(longSleepAdvisory("sleep 1m59s")).toBeUndefined();
	});

	it("does not match the non-existent uppercase SLEEP command", () => {
		expect(longSleepAdvisory("SLEEP 300")).toBeUndefined();
	});
	it("detects long sleep with decimal seconds", () => {
		expect(longSleepAdvisory("sleep 120.5")).toBeDefined();
		expect(longSleepAdvisory("sleep 119.9")).toBeUndefined();
	});

	it("is purely advisory and never blocks — returns a string, not a throw", () => {
		const notice = longSleepAdvisory("sleep 9999");
		expect(typeof notice).toBe("string");
		expect(notice!.length).toBeGreaterThan(0);
	});

	it("does not flag incidental sleep in compound commands", () => {
		// These are real commands where sleep is incidental to the main work,
		// not a blocking wait for subagents. The detection is intentionally
		// conservative and does not flag every occurrence.
		//
		// Note: `sleep 200 && make build` — the sleep is still a long blocking
		// wait, so it IS flagged. This is correct behavior: even if the intent
		// is rate-limiting, the session is still silent during the sleep.
		// The notice is advisory, not a block.
		expect(longSleepAdvisory("for i in $(seq 1 5); do echo $i; sleep 1; done")).toBeUndefined();
	});
});

describe("longSleepAdvisory effective-timeout wording (#4465 review follow-up)", () => {
	it("reports the bounded effective wait when the timeout is shorter than the requested sleep", () => {
		// The concrete P2: `sleep 800` under the default 300s bash timeout.
		const notice = longSleepAdvisory("sleep 800", 300);
		expect(notice).toBeDefined();
		// Requested duration is still stated...
		expect(notice).toContain("requests a sleep of ~13m");
		// ...but the notice no longer claims the session is silent for the full
		// 13m: the timeout kills the command first, and the notice says so.
		expect(notice).toContain("timeout will kill this command after ~5m");
		expect(notice).toContain("bounded by the timeout");
	});

	it("keeps the timeout sentence out when the sleep fits inside the timeout", () => {
		const notice = longSleepAdvisory("sleep 180", 300);
		expect(notice).toBeDefined();
		expect(notice).toContain("requests a sleep of ~3m");
		expect(notice).not.toContain("timeout will kill");
	});

	it("keeps the timeout sentence out when no timeout is known", () => {
		const notice = longSleepAdvisory("sleep 800");
		expect(notice).toBeDefined();
		expect(notice).toContain("requests a sleep of ~13m");
		expect(notice).not.toContain("timeout will kill");
	});

	it("applies the same bounded wording on the chained pattern under the default timeout", () => {
		const notice = longSleepAdvisory("sleep 800; git log --oneline -1", 300);
		expect(notice).toBeDefined();
		expect(notice).toContain("requests a sleep of ~13m");
		expect(notice).toContain("timeout will kill this command after ~5m");
	});

	it("reports the bounded wait for an explicit large timeout", () => {
		// Requested timeout 900s, sleep 800s → sleep fits, no timeout sentence.
		const fits = longSleepAdvisory("sleep 800", 900);
		expect(fits).toContain("requests a sleep of ~13m");
		expect(fits).not.toContain("timeout will kill");

		// Requested timeout 1200s, sleep 1h (3600s) → timeout wins.
		const bounded = longSleepAdvisory("sleep 1h", 1200);
		expect(bounded).toContain("requests a sleep of ~60m");
		expect(bounded).toContain("timeout will kill this command after ~20m");
	});

	it("formats sub-minute timeouts in seconds, not zero minutes", () => {
		// Clamp floor is 1s; a sleep of 120s under a 1s timeout reads ~1s.
		const notice = longSleepAdvisory("sleep 200", 1);
		expect(notice).toContain("timeout will kill this command after ~1s");
	});
});

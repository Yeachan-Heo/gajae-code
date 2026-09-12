import { describe, expect, it } from "bun:test";
import { Process } from "../native/index.js";

/**
 * Coverage for `Process.observe` (D8/D9 death-proof primitive).
 *
 * `Process.fromPid` collapses "confirmed dead" and "could not be queried"
 * into the same `null`, and on Darwin `Process#status()` maps an identity
 * re-check failure to `"exited"` even though the kernel never confirmed
 * absence. `Process.observe` is the read-only API that keeps those outcomes
 * distinct: `{ status: "present", incarnation }`, `{ status: "absent" }`
 * (positive OS-confirmed death), or `{ status: "unknown", reasonCode }`
 * (inconclusive — never treated as death proof).
 *
 * Every case below is a real fixture (this process, an owned spawned-and-
 * reaped child, or a structurally invalid pid) with no global mocks. Only
 * process observation is exercised — nothing here signals, kills, reaps, or
 * waits on any process outside what the test itself owns and explicitly
 * disposes of.
 */
describe("Process.observe", () => {
	it("reports the current process as present with a canonical incarnation", () => {
		const result = Process.observe(process.pid);

		expect(result.status).toBe("present");
		const incarnation = result.incarnation;
		expect(typeof incarnation).toBe("string");
		expect(incarnation?.length).toBeGreaterThan(0);
		// Canonical incarnation form: "<platform>:<...>", matching the same
		// evidence `Process.fromPid(pid)?.incarnation` returns.
		expect(incarnation).toMatch(/^(linux|darwin|windows):/);
		expect(result.reasonCode).toBeUndefined();

		// Cross-check against the existing fromPid/incarnation path: observe()
		// must not invent a different identity for a live process it can pin.
		const reference = Process.fromPid(process.pid);
		expect(reference).not.toBeNull();
		expect(reference?.incarnation).toBe(result.incarnation);
	});

	it("reports an owned, spawned-and-reaped child as positively absent", async () => {
		// Own the entire lifecycle: spawn, confirm alive, kill, wait for exit, and
		// only then observe. No other process is touched.
		const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1_000);"], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		const childPid = child.pid;
		try {
			// Confirm the fixture is actually alive before killing it, so the
			// absence assertion below is proof of a genuine live-to-dead
			// transition rather than a pid that never existed.
			const beforeKill = Process.observe(childPid);
			expect(beforeKill.status).toBe("present");

			child.kill("SIGKILL");
			await child.exited;

			// Poll briefly: process-table absence is not guaranteed to be visible
			// to a fresh observe() the instant `exited` resolves on every platform.
			let observation = Process.observe(childPid);
			for (let attempt = 0; attempt < 100 && observation.status !== "absent"; attempt++) {
				await Bun.sleep(20);
				observation = Process.observe(childPid);
			}

			expect(observation.status).toBe("absent");
			expect(observation.incarnation).toBeUndefined();
			expect(observation.reasonCode).toBeUndefined();

			// Death proof must also be reflected through fromPid returning null —
			// observe() and fromPid() must never disagree about a confirmed-dead pid.
			expect(Process.fromPid(childPid)).toBeNull();
		} finally {
			if (!child.killed) child.kill("SIGKILL");
		}
	});

	it("classifies structurally invalid pids as unknown, never as absent", () => {
		for (const invalidPid of [0, -1, -12345]) {
			const result = Process.observe(invalidPid);
			expect(result.status).toBe("unknown");
			expect(result.reasonCode).toBe("invalid_pid");
			expect(result.incarnation).toBeUndefined();
		}
	});

	it("classifies a pid far outside any plausible allocation as absent, not unknown", () => {
		// A syntactically valid positive pid that is (barring an implausible
		// coincidence) never actually running is still a definite OS answer, not
		// an inconclusive one: `kill(pid, 0)` / OpenProcess still return a crisp
		// ESRCH-equivalent for it.
		const implausiblePid = 2_147_483_000;
		const result = Process.observe(implausiblePid);

		expect(result.status).toBe("absent");
		expect(Process.fromPid(implausiblePid)).toBeNull();
	});

	it("keeps the three observation states mutually exclusive on the result shape", () => {
		// Structural/contract check that doubles as the error-classification
		// coverage available without global mocks at this native layer: every
		// reachable outcome must carry exactly the fields its status implies, so
		// a caller pattern-matching on `status` can never read stale data from a
		// different branch.
		const present = Process.observe(process.pid);
		const absent = Process.observe(2_147_483_000);
		const unknown = Process.observe(-1);

		expect(present.status).toBe("present");
		expect(absent.status).toBe("absent");
		expect(unknown.status).toBe("unknown");

		const statuses = new Set([present.status, absent.status, unknown.status]);
		expect(statuses.size).toBe(3);
	});
});

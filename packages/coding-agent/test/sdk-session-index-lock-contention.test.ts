import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as lockModule from "../src/config/file-lock";
import * as incarnationModule from "../src/sdk/broker/process-incarnation";
import { SessionIndex } from "../src/sdk/broker/session-index";

const event = (sessionId: string) => ({
	type: "host_registered" as const,
	sessionId,
	locator: { repo: "r", stateRoot: "q" },
	endpointGeneration: 1,
	pid: process.pid,
});

function deferred<T = void>() {
	return Promise.withResolvers<T>();
}

/**
 * Issue #4544: a live detached SDK broker held `<agentDir>/sdk/sessions/
 * index.jsonl.lock` across a wedged Windows sync-family await inside the locked
 * critical section, and every new `gjc` launch exhausted the full 600-attempt
 * lock budget (60s) and crashed. The stale-lock recovery discipline (#652) is
 * correct — a proven-live owner must never have its lock stolen — so the fix has
 * to bound what the lock holder can do to the machine-global critical section,
 * and make the exhaustion error say who holds the lock instead of a bare
 * attempt count.
 */
describe("SDK session index lock contention (#4544)", () => {
	it("reports the live lock owner when a launch exhausts the lock budget", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-4544-owner-"));
		const sessionsDir = path.join(dir, "sdk", "sessions");
		await fs.mkdir(sessionsDir, { recursive: true });
		const logPath = path.join(sessionsDir, "index.jsonl");
		// A live owner's lock dir exactly like the reporter's:
		// {"pid":22076,"start_time":"unknown","timestamp":...}
		const lockDir = `${logPath}.lock`;
		await fs.mkdir(lockDir);
		await fs.writeFile(
			path.join(lockDir, "info"),
			JSON.stringify({ pid: process.pid, start_time: "unknown", timestamp: Date.now() }),
		);
		// Exhaustion must happen quickly in the test: probe the budget through the
		// production withFileLock against the same live-owner lock dir shape, with a
		// shortened retry delay but the same diagnostics surface.
		let failure: unknown;
		try {
			await lockModule.withFileLock(path.join(sessionsDir, "index.jsonl"), async () => {}, {
				retries: 2,
				retryDelayMs: 5,
			});
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		const message = (failure as Error).message;
		expect(message).toContain("after 2 attempts");
		// Actionable diagnostics: the error must identify the holder so the user
		// can act (the broker pid) instead of only an attempt count.
		expect(message).toContain(`pid ${process.pid}`);
		expect(message).toContain("live");
		expect(message).toContain(lockDir);
		// Stale-lock safety preserved: the live owner's lock is never stolen.
		expect(await fs.exists(lockDir)).toBe(true);
	});

	it("reports a foreign lock owner with unknown liveness instead of probing a local pid", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-4544-foreign-owner-"));
		const sessionsDir = path.join(dir, "sdk", "sessions");
		await fs.mkdir(sessionsDir, { recursive: true });
		// A shared-volume lock record owned by another host: its pid is meaningful
		// only there. The local pid space may contain a coincident (here: live and
		// definitely local) process with the same number; the exhaustion diagnostic
		// must not label it the holder.
		const lockDir = path.join(sessionsDir, "index.jsonl.lock");
		await fs.mkdir(lockDir, { recursive: true });
		await Bun.write(
			path.join(lockDir, "info"),
			JSON.stringify({
				pid: process.pid,
				start_time: "unknown",
				timestamp: Date.now(),
				owner_host_id: "another-host",
			}),
		);
		let failure: unknown;
		try {
			await lockModule.withFileLock(path.join(sessionsDir, "index.jsonl"), async () => {}, {
				retries: 2,
				retryDelayMs: 5,
				ownerHostId: "this-host",
			});
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		const message = (failure as Error).message;
		expect(message).toContain(`pid ${process.pid} on host another-host`);
		expect(message).toContain("liveness unknown from this host");
		expect(message).not.toContain("(live)");
		expect(message).not.toContain("dead but not reaped");
		// The foreign owner's lock is never stolen from this host either.
		expect(await fs.exists(lockDir)).toBe(true);
	});

	it("keeps the append path's OS incarnation derivation outside the lock-held section", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-4544-append-probe-"));
		const index = await new SessionIndex(dir).open();
		const realProcessIncarnation = incarnationModule.processIncarnation;
		const realWithFileLock = lockModule.withFileLock;
		let depth = 0;
		let probedUnderLock = false;
		const spy = vi
			.spyOn(lockModule, "withFileLock")
			.mockImplementation(async (filePath: Parameters<typeof realWithFileLock>[0], fn, options) => {
				depth++;
				try {
					return await realWithFileLock(filePath, fn, options);
				} finally {
					depth--;
				}
			});
		const incarnation = vi.spyOn(incarnationModule, "processIncarnation").mockImplementation(pid => {
			if (depth > 0) probedUnderLock = true;
			return realProcessIncarnation(pid);
		});
		try {
			// Self-pid registration: `append` derives hostIncarnation for pid===process.pid.
			const appended = await index.append(event("probe"));
			expect(appended.hostIncarnation).toBeDefined();
			expect(incarnation).toHaveBeenCalled();
			expect(probedUnderLock).toBe(false);
			// The unlocked projection still observes liveness.
			expect(index.listSessions().sessions).toHaveLength(1);
		} finally {
			incarnation.mockRestore();
			spy.mockRestore();
		}
	});

	it("keeps the heartbeat pass's OS incarnation probes outside the lock-held section", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-4544-heartbeat-"));
		const index = await new SessionIndex(dir).open();
		await index.append(event("live-host"));
		// An unlock-time probe record: the pass must observe liveness for each
		// candidate row BEFORE taking the machine-global lock (or after releasing
		// it), because on Windows the probe can spawn powershell.exe — an
		// unbounded OS operation to hold a machine-global critical section across.
		let depth = 0;
		let probedUnderLock = false;
		const realProcessIncarnation = incarnationModule.processIncarnation;
		const realWithFileLock = lockModule.withFileLock;
		const spy = vi
			.spyOn(lockModule, "withFileLock")
			.mockImplementation(async (filePath: Parameters<typeof realWithFileLock>[0], fn, options) => {
				depth++;
				try {
					return await realWithFileLock(filePath, fn, options);
				} finally {
					depth--;
				}
			});
		const incarnation = vi.spyOn(incarnationModule, "processIncarnation").mockImplementation(pid => {
			if (depth > 0) probedUnderLock = true;
			return realProcessIncarnation(pid);
		});
		try {
			expect(await index.checkpointLiveHeartbeats()).toBe(1);
			expect(incarnation).toHaveBeenCalled();
			expect(probedUnderLock).toBe(false);
		} finally {
			incarnation.mockRestore();
			spy.mockRestore();
		}
	});
	it("fails closed when the locked replay outlives the probe freshness window", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-4544-replay-stale-"));
		const seed = await new SessionIndex(dir).open();
		await seed.append(event("slow-replay"));
		const index = await new SessionIndex(dir).open();
		// Review round 4 on #4544: the freshness check ran at lock acquisition,
		// but the observation set is consumed only AFTER `#replayUnderLock()` —
		// a whole-log re-read plus fsynced audit appends that a large index or a
		// wedged Windows sync-family await can stretch arbitrarily while the
		// machine-global lock is held. A pid can exit and be reused across that
		// awaited replay; the cached incarnation would still match the dead row
		// while `alive(pid)` sees the replacement, writing a heartbeat for the
		// wrong host. Simulate the stretch deterministically: jump the clock
		// past the replay freshness bound exactly when the locked replay reads
		// the log (the first index.jsonl read after the unlocked probe batch).
		let incarnationCalls = 0;
		const realProcessIncarnation = incarnationModule.processIncarnation;
		const incarnation = vi.spyOn(incarnationModule, "processIncarnation").mockImplementation(pid => {
			incarnationCalls++;
			return realProcessIncarnation(pid);
		});
		let jumped = false;
		const realReadFile = fs.readFile;
		const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation((async (
			...args: Parameters<typeof fs.readFile>
		) => {
			const result = await realReadFile(...args);
			if (!jumped && incarnationCalls > 0 && String(args[0]).endsWith("index.jsonl")) {
				jumped = true;
				// The freshness bounds are monotonic (performance.now), so the
				// stretch must advance the monotonic clock, not the wall clock.
				const realMono = performance.now.bind(performance);
				vi.spyOn(performance, "now").mockImplementation(() => realMono() + 2_100);
			}
			return result;
		}) as typeof fs.readFile);
		try {
			expect(await index.checkpointLiveHeartbeats()).toBe(0);
			expect(jumped).toBe(true);
			// No heartbeat was written for the still-live host: the cycle failed
			// closed instead of trusting the pre-replay observation set.
			const rows = index.listSessions().sessions;
			expect(rows).toHaveLength(1);
			expect(rows[0]?.lastHeartbeatAt).toBeUndefined();
		} finally {
			readFileSpy.mockRestore();
			incarnation.mockRestore();
			vi.restoreAllMocks();
		}
		// The next pass, on a fast replay, re-probes and writes normally.
		expect(await index.checkpointLiveHeartbeats()).toBe(1);
	});

	it("fails closed on a stale batch even when the wall clock steps backward", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-4544-clock-regress-"));
		const seed = await new SessionIndex(dir).open();
		await seed.append(event("clock-regress"));
		const index = await new SessionIndex(dir).open();
		// Boundary cohort red-team case 2: the freshness bounds must be monotonic.
		// A backward wall-clock step (manual clock fix, NTP slew, VM snapshot
		// restore) would make a Date.now()-based interval negative and pass both
		// bounds, consuming an arbitrarily stale observation batch. With a
		// monotonic bound the wall clock can move freely without reopening the
		// fail-closed guarantee.
		let incarnationCalls = 0;
		const realProcessIncarnation = incarnationModule.processIncarnation;
		const incarnation = vi.spyOn(incarnationModule, "processIncarnation").mockImplementation(pid => {
			incarnationCalls++;
			return realProcessIncarnation(pid);
		});
		let regressed = false;
		const realReadFile = fs.readFile;
		const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation((async (
			...args: Parameters<typeof fs.readFile>
		) => {
			const result = await realReadFile(...args);
			if (!regressed && incarnationCalls > 0 && String(args[0]).endsWith("index.jsonl")) {
				regressed = true;
				// Step the WALL clock back 70s AND advance the monotonic clock past
				// the replay bound: the monotonic advance must dominate.
				const realNow = Date.now;
				vi.spyOn(Date, "now").mockImplementation(() => realNow() - 70_000);
				const realMono = performance.now.bind(performance);
				vi.spyOn(performance, "now").mockImplementation(() => realMono() + 2_100);
			}
			return result;
		}) as typeof fs.readFile);
		try {
			expect(await index.checkpointLiveHeartbeats()).toBe(0);
			expect(regressed).toBe(true);
			const rows = index.listSessions().sessions;
			expect(rows[0]?.lastHeartbeatAt).toBeUndefined();
		} finally {
			readFileSpy.mockRestore();
			incarnation.mockRestore();
			vi.restoreAllMocks();
		}
		expect(await index.checkpointLiveHeartbeats()).toBe(1);
	});

	it("fails closed when lock acquisition alone outlives the probe freshness window", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-4544-acq-bound-"));
		const seed = await new SessionIndex(dir).open();
		await seed.append(event("acq-bound"));
		const index = await new SessionIndex(dir).open();
		// The FIRST bound (SESSION_INDEX_PROBE_FRESHNESS_MS = 50ms) fires at lock
		// acquisition, before the replay: a probe batch that queues behind even a
		// short legitimate holder is discarded. Advance the monotonic clock during
		// acquisition (inside the lock wrapper, before the callback body).
		let incarnationCalls = 0;
		const realProcessIncarnation = incarnationModule.processIncarnation;
		const incarnation = vi.spyOn(incarnationModule, "processIncarnation").mockImplementation(pid => {
			incarnationCalls++;
			return realProcessIncarnation(pid);
		});
		const realWithFileLock = lockModule.withFileLock;
		const spy = vi
			.spyOn(lockModule, "withFileLock")
			.mockImplementation(async (filePath: Parameters<typeof realWithFileLock>[0], fn, options) => {
				if (incarnationCalls > 0 && String(filePath).endsWith("index.jsonl")) {
					const realMono = performance.now.bind(performance);
					vi.spyOn(performance, "now").mockImplementation(() => realMono() + 100);
				}
				return await realWithFileLock(filePath, fn, options);
			});
		try {
			expect(await index.checkpointLiveHeartbeats()).toBe(0);
			const rows = index.listSessions().sessions;
			expect(rows[0]?.lastHeartbeatAt).toBeUndefined();
		} finally {
			spy.mockRestore();
			incarnation.mockRestore();
			vi.restoreAllMocks();
		}
		expect(await index.checkpointLiveHeartbeats()).toBe(1);
	});

	it("keeps the unregister pass's OS incarnation probes outside the lock-held section", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-4544-unregister-probe-"));
		const index = await new SessionIndex(dir).open();
		const appended = await index.append(event("retire-me"));
		expect(appended.hostIncarnation).toBeDefined();
		// Review round 5 on #4544: the conditional-unregister pass projects every
		// composite identity under the machine-global lock. An unlocked
		// projection probes the OS once per identity (powershell.exe on Windows),
		// so projecting under the lock recreated the starvation this change
		// removes. The probes must run before the lock is taken and be passed
		// into the locked projection.
		let depth = 0;
		let probedUnderLock = false;
		const realProcessIncarnation = incarnationModule.processIncarnation;
		const realWithFileLock = lockModule.withFileLock;
		const spy = vi
			.spyOn(lockModule, "withFileLock")
			.mockImplementation(async (filePath: Parameters<typeof realWithFileLock>[0], fn, options) => {
				depth++;
				try {
					return await realWithFileLock(filePath, fn, options);
				} finally {
					depth--;
				}
			});
		const incarnation = vi.spyOn(incarnationModule, "processIncarnation").mockImplementation(pid => {
			if (depth > 0) probedUnderLock = true;
			return realProcessIncarnation(pid);
		});
		try {
			expect(
				await index.unregisterIfCurrent({
					sessionId: "retire-me",
					locator: { repo: "r", stateRoot: "q" },
					endpointGeneration: 1,
					pid: process.pid,
					indexSeq: appended.indexSeq,
					processIncarnation: appended.processIncarnation,
					hostIncarnation: appended.hostIncarnation,
					identityProvenance: "composite",
					ambiguous: false,
					live: true,
					terminal: false,
					terminalUncertain: false,
				}),
			).toBe(true);
			expect(incarnation).toHaveBeenCalled();
			expect(probedUnderLock).toBe(false);
		} finally {
			incarnation.mockRestore();
			spy.mockRestore();
		}
	});

	it("releases the lock when the critical section throws, and aborted acquisition fails fast", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-4544-throw-"));
		const index = await new SessionIndex(dir).open();
		await index.append(event("one"));
		const boom = new Error("critical section failed");
		await expect(
			index.withLocked(async () => {
				throw boom;
			}),
		).rejects.toBe(boom);
		// A throw inside the critical section must not leave the lock held:
		// the next operation acquires immediately (no 600-attempt budget burn).
		const next = await index.append(event("two"));
		expect(next.indexSeq).toBe(2);
		expect(await fs.exists(path.join(dir, "sdk", "sessions", "index.jsonl.lock"))).toBe(false);

		// Aborted acquisition must fail fast rather than burn its full retry budget:
		// hold the lock in the background, start a competing acquisition, and abort
		// it while it is genuinely contending.
		const controller = new AbortController();
		const acquired = deferred();
		const holderDone = deferred();
		void (async () => {
			await lockModule.withFileLock(path.join(dir, "sdk", "sessions", "index.jsonl"), async () => {
				acquired.resolve();
				await holderDone.promise;
			});
		})();
		await acquired.promise;
		const started = Date.now();
		const competing = lockModule
			.withFileLock(path.join(dir, "sdk", "sessions", "index.jsonl"), async () => {}, {
				signal: controller.signal,
				retries: 600,
				retryDelayMs: 100,
			})
			.catch(error => error as Error);
		// Abort while the contender is inside its retry loop.
		setTimeout(() => controller.abort(), 150);
		const outcome = await competing;
		holderDone.resolve();
		expect(outcome).toBeInstanceOf(Error);
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it("bounds concurrent launches behind a legitimate holder and converges after release", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-4544-concurrent-"));
		const seed = await new SessionIndex(dir).open();
		await seed.append(event("seed"));
		// Simulate a long-but-bounded holder (compaction/audit on a large index):
		// hold the machine-global lock through the production wrapper for a fixed
		// delay, then let concurrent launches converge instead of racing into
		// corruption. The holder's exit is time-bounded, not test-gated, so the
		// launches can never deadlock behind an unresolved promise.
		const holder = seed.withLocked(async () => {
			await Bun.sleep(400);
		});
		const launches = await Promise.all(
			[0, 1, 2].map(async i => {
				// Serialize slightly so they contend rather than perfectly interleave.
				await Bun.sleep(i * 25);
				const launch = await new SessionIndex(dir).open();
				return (await launch.append(event(`launch-${i}`))).indexSeq;
			}),
		);
		await holder;
		expect(new Set(launches)).toEqual(new Set([2, 3, 4]));
		const replay = await new SessionIndex(dir).open();
		expect(replay.indexSeq).toBe(4);
		expect((await replay.diagnose()).status).toBe("healthy");
	}, 30_000);
});

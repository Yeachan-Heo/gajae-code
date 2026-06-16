import { describe, expect, test } from "bun:test";
import {
	disposeAllOwnedProcesses,
	disposeAllResourceOwners,
	liveOwnedProcessCount,
	registerResourceOwner,
	resourceOwnerCount,
	spawnOwnedProcess,
} from "@gajae-code/coding-agent/runtime/process-lifecycle";

const isPosix = process.platform !== "win32";

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("waitFor timed out");
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

describe("spawnOwnedProcess (F1a)", () => {
	test("awaits clean exit and deregisters from the live set", async () => {
		const before = liveOwnedProcessCount();
		const owner = spawnOwnedProcess(["sh", "-c", "exit 0"], { name: "clean-exit" });
		const result = await owner.awaitExit();
		expect(result.exited).toBe(true);
		expect(result.code).toBe(0);
		await waitFor(() => liveOwnedProcessCount() === before);
	});

	test("awaitExit honors a bounded timeout for a long runner", async () => {
		const owner = spawnOwnedProcess(["sh", "-c", "sleep 30"], { name: "timeout-probe" });
		try {
			const result = await owner.awaitExit({ timeoutMs: 100 });
			expect(result.exited).toBe(false);
		} finally {
			await owner.dispose();
		}
	});

	test("dispose terminates a long runner and is idempotent", async () => {
		const before = liveOwnedProcessCount();
		const owner = spawnOwnedProcess(["sh", "-c", "sleep 30"], { name: "dispose-probe" });
		await Bun.sleep(50);
		await Promise.all([owner.dispose(), owner.dispose()]);
		expect(owner.disposed).toBe(true);
		const result = await owner.awaitExit({ timeoutMs: 1_000 });
		expect(result.exited).toBe(true);
		await waitFor(() => liveOwnedProcessCount() === before);
	});

	test("an already-aborted signal disposes the process immediately", async () => {
		const before = liveOwnedProcessCount();
		const owner = spawnOwnedProcess(["sh", "-c", "sleep 30"], {
			name: "pre-aborted",
			signal: AbortSignal.abort(),
		});
		const result = await owner.awaitExit({ timeoutMs: 2_000 });
		expect(result.exited).toBe(true);
		await waitFor(() => liveOwnedProcessCount() === before);
	});

	test("aborting mid-run disposes and removes the abort listener", async () => {
		const before = liveOwnedProcessCount();
		const controller = new AbortController();
		const owner = spawnOwnedProcess(["sh", "-c", "sleep 30"], {
			name: "mid-abort",
			signal: controller.signal,
		});
		await Bun.sleep(50);
		controller.abort();
		const result = await owner.awaitExit({ timeoutMs: 2_000 });
		expect(result.exited).toBe(true);
		await waitFor(() => liveOwnedProcessCount() === before);
		// Listener removed on settle: a second abort must not throw or re-dispose.
		controller.abort();
		expect(owner.disposed).toBe(true);
	});

	test.skipIf(!isPosix)("dispose reaps the process group while an unrelated sibling survives", async () => {
		// Unrelated sibling: a directly-spawned detached sleep we must NOT kill.
		const sibling = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
		const siblingPid = sibling.pid;
		try {
			// Owned tree: a shell that backgrounds a grandchild plus a foreground child.
			const owner = spawnOwnedProcess(["sh", "-c", "sleep 30 & sleep 30"], { name: "group-reap" });
			const pgid = owner.pid;
			expect(pgid).toBeGreaterThan(0);
			await Bun.sleep(150); // let the grandchild spawn

			await owner.dispose();
			await owner.awaitExit({ timeoutMs: 2_000 });

			// The whole owned process group must be gone (ESRCH on group probe).
			await waitFor(() => {
				try {
					process.kill(-(pgid as number), 0);
					return false; // still alive
				} catch (err) {
					return (err as NodeJS.ErrnoException).code === "ESRCH";
				}
			});

			// The unrelated sibling must still be alive.
			expect(alive(siblingPid)).toBe(true);
		} finally {
			try {
				sibling.kill("SIGKILL");
			} catch {
				/* already gone */
			}
		}
	});
});

describe("registerResourceOwner (F1b)", () => {
	test("disposer runs once on disposeAllResourceOwners", async () => {
		await disposeAllResourceOwners(); // clean slate
		let calls = 0;
		registerResourceOwner("test:res-a", () => {
			calls += 1;
		});
		expect(resourceOwnerCount()).toBe(1);
		await disposeAllResourceOwners();
		expect(calls).toBe(1);
		expect(resourceOwnerCount()).toBe(0);
		// Cleared after dispose: a second dispose does not re-invoke.
		await disposeAllResourceOwners();
		expect(calls).toBe(1);
	});

	test("unregister prevents the disposer from running", async () => {
		await disposeAllResourceOwners();
		let calls = 0;
		const unregister = registerResourceOwner("test:res-b", () => {
			calls += 1;
		});
		unregister();
		expect(resourceOwnerCount()).toBe(0);
		await disposeAllResourceOwners();
		expect(calls).toBe(0);
		// Idempotent unregister.
		expect(() => unregister()).not.toThrow();
	});

	test("re-registering the same name replaces the disposer (last wins)", async () => {
		await disposeAllResourceOwners();
		let first = 0;
		let second = 0;
		const unregisterFirst = registerResourceOwner("test:res-c", () => {
			first += 1;
		});
		registerResourceOwner("test:res-c", () => {
			second += 1;
		});
		expect(resourceOwnerCount()).toBe(1);
		// The stale unregister must not remove the newer registration.
		unregisterFirst();
		expect(resourceOwnerCount()).toBe(1);
		await disposeAllResourceOwners();
		expect(first).toBe(0);
		expect(second).toBe(1);
	});
});

describe("ownership regression: group liveness drives teardown (F1a)", () => {
	test.skipIf(!isPosix)("reaps backgrounded descendants when the root exits first", async () => {
		const sibling = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
		try {
			// The shell exits 0 immediately but leaves a backgrounded child in the group.
			const owner = spawnOwnedProcess(["sh", "-c", "sleep 30 & exit 0"], { name: "root-exits-first" });
			const pgid = owner.pid as number;
			const rootExit = await owner.awaitExit({ timeoutMs: 2_000 });
			expect(rootExit.exited).toBe(true);
			expect(rootExit.code).toBe(0);
			await Bun.sleep(50);
			// The owned group is still alive because of the orphaned background child.
			expect(groupAliveProbe(pgid)).toBe(true);
			await owner.dispose();
			await waitFor(() => groupGone(pgid));
			// The unrelated sibling must survive.
			expect(alive(sibling.pid)).toBe(true);
		} finally {
			try {
				sibling.kill("SIGKILL");
			} catch {
				/* already gone */
			}
		}
	});

	test("owner stays tracked until dispose teardown completes", async () => {
		const before = liveOwnedProcessCount();
		const owner = spawnOwnedProcess(["sh", "-c", "sleep 30"], { name: "tracked-until-done", gracefulMs: 300 });
		await Bun.sleep(50);
		const disposing = owner.dispose();
		// FIX: the owner must remain in the live set until teardown completes, so a
		// postmortem firing mid-grace still awaits this in-flight dispose.
		expect(liveOwnedProcessCount()).toBe(before + 1);
		await disposing;
		await waitFor(() => liveOwnedProcessCount() === before);
	});

	test.skipIf(!isPosix)("disposeAllOwnedProcesses escalates SIGKILL for a SIGTERM-ignoring child", async () => {
		const before = liveOwnedProcessCount();
		const owner = spawnOwnedProcess(["sh", "-c", "trap '' TERM; sleep 30"], {
			name: "term-trap",
			gracefulMs: 200,
		});
		await Bun.sleep(100);
		// Simulates a postmortem/owner-scoped teardown reaching the in-flight owner.
		await disposeAllOwnedProcesses();
		const result = await owner.awaitExit({ timeoutMs: 2_000 });
		expect(result.exited).toBe(true);
		await waitFor(() => liveOwnedProcessCount() === before);
	});
});

describe("resource owner failure surfacing (F1b)", () => {
	test("disposeAllResourceOwners surfaces disposer failures as AggregateError", async () => {
		await disposeAllResourceOwners().catch(() => undefined);
		let ran = 0;
		registerResourceOwner("agg:throws", () => {
			throw new Error("boom");
		});
		registerResourceOwner("agg:ok", () => {
			ran += 1;
		});
		await expect(disposeAllResourceOwners()).rejects.toBeInstanceOf(AggregateError);
		expect(ran).toBe(1);
		expect(resourceOwnerCount()).toBe(0);
	});
});

function groupAliveProbe(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function groupGone(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return false;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ESRCH";
	}
}

describe("ownership regression: no stale pgid after late drain (F1a)", () => {
	test.skipIf(!isPosix)("reaps and deregisters when descendants outlive the drain window", async () => {
		const before = liveOwnedProcessCount();
		const owner = spawnOwnedProcess(["sh", "-c", "sleep 1 & exit 0"], { name: "late-drain" });
		const rootExit = await owner.awaitExit({ timeoutMs: 2_000 });
		expect(rootExit.exited).toBe(true);
		// The backgrounded `sleep 1` outlives ROOT_EXIT_DRAIN_MS; the owner must not
		// linger with a stale pgid — it is reaped and the live count returns to
		// baseline rather than being abandoned.
		await waitFor(() => liveOwnedProcessCount() === before, 8_000);
		expect(liveOwnedProcessCount()).toBe(before);
	});
});

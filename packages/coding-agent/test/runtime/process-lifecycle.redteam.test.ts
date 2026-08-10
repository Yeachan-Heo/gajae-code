import { describe, expect, test } from "bun:test";
import {
	disposeAllResourceOwners,
	liveOwnedProcessCount,
	registerResourceOwner,
	resourceOwnerCount,
	spawnOwnedProcess,
} from "@gajae-code/coding-agent/runtime/process-lifecycle";

const isPosix = process.platform !== "win32";

async function waitFor(predicate: () => boolean, timeoutMs = 5_000, label = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			if (predicate()) return;
		} catch (err) {
			lastError = err;
		}
		await Bun.sleep(20);
	}
	throw new Error(`waitFor timed out: ${label}${lastError ? ` (${String(lastError)})` : ""}`);
}

async function waitForAsync(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 5_000,
	label = "condition",
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			if (await predicate()) return;
		} catch (err) {
			lastError = err;
		}
		await Bun.sleep(20);
	}
	throw new Error(`waitFor timed out: ${label}${lastError ? ` (${String(lastError)})` : ""}`);
}

async function fileContains(path: string, needle: string): Promise<boolean> {
	try {
		return (await Bun.file(path).text()).includes(needle);
	} catch {
		return false;
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function processGroupGone(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return false;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ESRCH";
	}
}

describe("process-lifecycle adversarial owned-process invariants", () => {
	test("dispose immediately after spawn wins the startup race and returns to baseline", async () => {
		const before = liveOwnedProcessCount();
		const owner = spawnOwnedProcess(["sh", "-c", "printf ready; sleep 30"], {
			name: "redteam-immediate-dispose",
			gracefulMs: 10,
		});

		await expect(owner.dispose()).resolves.toBeUndefined();
		expect(owner.disposed).toBe(true);
		const exit = await owner.awaitExit({ timeoutMs: 2_000 });
		expect(exit.exited).toBe(true);
		await waitFor(() => liveOwnedProcessCount() === before, 2_000, "live count baseline after immediate dispose");
	});

	test("dispose of an already-exited process is a no-op and does not throw", async () => {
		const before = liveOwnedProcessCount();
		const owner = spawnOwnedProcess(["sh", "-c", "exit 7"], { name: "redteam-already-exited" });
		const exit = await owner.awaitExit({ timeoutMs: 2_000 });
		expect(exit).toEqual({ exited: true, code: 7 });

		await expect(owner.dispose()).resolves.toBeUndefined();
		await expect(owner.dispose()).resolves.toBeUndefined();
		expect(owner.disposed).toBe(true);
		await waitFor(
			() => liveOwnedProcessCount() === before,
			2_000,
			"live count baseline after already-exited dispose",
		);
	});
	test.skipIf(process.platform !== "linux")(
		"dispose terminates without burning the grace window when only zombie members remain",
		async () => {
			const before = liveOwnedProcessCount();
			const base = `/tmp/gjc-process-lifecycle-zombie-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			const pidsFile = `${base}.pids`;
			const helperFile = `${base}.helper`;
			const scriptFile = `${base}.py`;
			await Bun.write(
				scriptFile,
				`import os, sys, time
root_pgid = os.getpid()
out, hpid_out = sys.argv[1], sys.argv[2]
h = os.fork()
if h == 0:
    # Detach from the owned root's stdio pipes so the helper holding a write
    # end cannot keep the transport's stdout/stderr streams open past the
    # root's death (which would wedge awaitExit on the stderr drain).
    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, 0)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)
    # Helper leaves the owned group (new pgrp, same session) so it never counts
    # as an owned member, then forks the grandchild into the owned group and
    # never reaps it: the grandchild stays a zombie with the helper as parent.
    os.setpgid(0, 0)
    with open(hpid_out, "w") as f:
        f.write(str(os.getpid()))
    c = os.fork()
    if c == 0:
        os.setpgid(0, root_pgid)
        with open(out, "w") as f:
            f.write(str(os.getpid()))
        time.sleep(100)
        os._exit(0)
    time.sleep(100)
time.sleep(100)
`,
			);
			const owner = spawnOwnedProcess(["python3", scriptFile, pidsFile, helperFile], {
				name: "redteam-zombie-only-group",
				gracefulMs: 1_000,
			});
			const pgid = owner.pid as number;
			try {
				await waitForAsync(() => fileContains(pidsFile, ""), 3_000, "grandchild joined the owned group");
				await waitForAsync(() => fileContains(helperFile, ""), 3_000, "helper pid");
				const grandchildPid = Number((await Bun.file(pidsFile).text()).trim());
				const helperPid = Number((await Bun.file(helperFile).text()).trim());
				expect(grandchildPid).toBeGreaterThan(0);
				expect(helperPid).toBeGreaterThan(0);
				expect(processAlive(grandchildPid)).toBe(true);

				// Kill the grandchild: it becomes a zombie in the owned group whose
				// parent (the helper) never reaps it, so the zombie persists.
				process.kill(grandchildPid, "SIGKILL");
				await Bun.sleep(50);
				// Root exits on its own; the only owned member left is the zombie.
				process.kill(pgid, "SIGKILL");

				// dispose() must terminate once no *running* member remains. With the
				// zombie-blind liveness probe the whole SIGTERM+SIGKILL escalation is
				// burned waiting for an external reaper (>= gracefulMs).
				const start = Date.now();
				await owner.dispose();
				const elapsed = Date.now() - start;
				expect(elapsed).toBeLessThan(800);

				const exit = await owner.awaitExit({ timeoutMs: 2_000 });
				expect(exit.exited).toBe(true);
				await waitFor(
					() => liveOwnedProcessCount() === before,
					2_000,
					"live count baseline after zombie-only dispose",
				);
			} finally {
				await owner.dispose().catch(() => {});
				try {
					const helperPid = Number((await Bun.file(helperFile).text()).trim());
					if (helperPid > 0) {
						try {
							process.kill(helperPid, "SIGKILL");
						} catch {
							/* already gone */
						}
					}
				} catch {
					/* helper file never appeared */
				}
				await Bun.$`rm -f ${pidsFile} ${helperFile} ${scriptFile}`.quiet();
			}
		},
	);

	test("double and concurrent dispose share one settled result and issue one terminating signal", async () => {
		const before = liveOwnedProcessCount();
		const tmp = `/tmp/gjc-process-lifecycle-${process.pid}-${Date.now()}`;
		const owner = spawnOwnedProcess(
			// `sh` runs a TERM trap only after the current foreground command returns, so the
			// polling interval must stay well under `gracefulMs` or SIGKILL beats the handler.
			["sh", "-c", `trap 'echo term >> ${tmp}; exit 0' TERM; echo up > ${tmp}; while :; do sleep 0.05; done`],
			{ name: "redteam-concurrent-dispose", gracefulMs: 2_000 },
		);
		try {
			await waitForAsync(() => fileContains(tmp, "up"), 2_000, "child readiness marker");
			const first = owner.dispose();
			const second = owner.dispose();
			expect(second).toBe(first);
			await expect(Promise.all([first, second, owner.dispose()])).resolves.toEqual([
				undefined,
				undefined,
				undefined,
			]);
			const exit = await owner.awaitExit({ timeoutMs: 2_000 });
			expect(exit.exited).toBe(true);
			await waitFor(() => liveOwnedProcessCount() === before, 2_000, "live count baseline after concurrent dispose");
			// The child's TERM trap appends the marker asynchronously, so awaitExit can
			// return before that write lands under shard load. Poll for the single
			// terminating signal instead of sampling the file once.
			await waitForAsync(
				async () => (await Bun.file(tmp).text()).split("\n").filter(line => line === "term").length === 1,
				2_000,
				"single term marker after concurrent dispose",
			);
			const marker = await Bun.file(tmp).text();
			expect(marker.split("\n").filter(line => line === "term")).toHaveLength(1);
		} finally {
			try {
				await owner.dispose();
			} catch {
				/* already disposed */
			}
			await Bun.$`rm -f ${tmp}`.quiet();
		}
	});

	test("awaitExit with timeoutMs 0 reports a live long-runner without killing it, then dispose cleans it", async () => {
		const before = liveOwnedProcessCount();
		const owner = spawnOwnedProcess(["sh", "-c", "sleep 30"], {
			name: "redteam-zero-timeout",
			gracefulMs: 10,
		});
		try {
			const probe = await owner.awaitExit({ timeoutMs: 0 });
			expect(probe.exited).toBe(false);
			expect(owner.pid === undefined ? false : processAlive(owner.pid)).toBe(true);
		} finally {
			await owner.dispose();
		}
		const exit = await owner.awaitExit({ timeoutMs: 2_000 });
		expect(exit.exited).toBe(true);
		await waitFor(() => liveOwnedProcessCount() === before, 2_000, "live count baseline after zero-timeout dispose");
	});

	test("liveOwnedProcessCount returns to baseline after a batch of spawn and dispose", async () => {
		const before = liveOwnedProcessCount();
		const owners = Array.from({ length: 8 }, (_, index) =>
			spawnOwnedProcess(["sh", "-c", "sleep 30"], {
				name: `redteam-batch-${index}`,
				gracefulMs: 10,
			}),
		);
		expect(liveOwnedProcessCount()).toBeGreaterThanOrEqual(before + owners.length);
		await Promise.all(owners.map(owner => owner.dispose()));
		await waitFor(() => liveOwnedProcessCount() === before, 2_000, "live count baseline after batch dispose");
	});

	test.skipIf(!isPosix)(
		"dispose reaps a same-group double-fork grandchild while an unrelated sibling survives",
		async () => {
			const before = liveOwnedProcessCount();
			const sibling = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
			const siblingPid = sibling.pid;
			const owner = spawnOwnedProcess(["sh", "-c", "( ( sleep 30 ) & ) & while :; do sleep 1; done"], {
				name: "redteam-double-fork-group",
				gracefulMs: 50,
			});
			const pgid = owner.pid;
			expect(pgid).toBeGreaterThan(0);
			try {
				await Bun.sleep(250);
				await owner.dispose();
				const exit = await owner.awaitExit({ timeoutMs: 2_000 });
				expect(exit.exited).toBe(true);
				await waitFor(() => processGroupGone(pgid as number), 3_000, "owned process group ESRCH");
				expect(processAlive(siblingPid)).toBe(true);
				await waitFor(() => liveOwnedProcessCount() === before, 2_000, "live count baseline after group reap");
			} finally {
				try {
					sibling.kill("SIGKILL");
				} catch {
					/* already gone */
				}
				await owner.dispose();
			}
		},
	);
	test.skipIf(!isPosix)(
		"late dispose after a clean drain is a no-op and never re-signals a recycled pgid",
		async () => {
			const before = liveOwnedProcessCount();
			// Root exits cleanly with no backgrounded descendants, so the group
			// drains within ROOT_EXIT_DRAIN_MS and reconciliation deregisters it.
			const owner = spawnOwnedProcess(["sh", "-c", "exit 0"], {
				name: "redteam-late-dispose-recycled-pgid",
			});
			const pgid = owner.pid as number;
			expect(pgid).toBeGreaterThan(0);

			const exit = await owner.awaitExit({ timeoutMs: 2_000 });
			expect(exit.exited).toBe(true);
			await waitFor(
				() => liveOwnedProcessCount() === before,
				2_000,
				"live count baseline after clean-drain reconciliation",
			);

			// Simulate the OS recycling the pgid into an unrelated group: sig-0
			// probes report alive and we record any terminating signal aimed at it.
			const realKill = process.kill;
			const terminatingSignals: Array<string | number> = [];
			process.kill = ((pid: number, signal?: string | number) => {
				if (pid === -pgid) {
					if (signal === 0) return true;
					terminatingSignals.push(signal as string | number);
					return true;
				}
				return (realKill as (p: number, s?: string | number) => boolean).call(process, pid, signal);
			}) as typeof process.kill;

			try {
				await expect(owner.dispose()).resolves.toBeUndefined();
				await expect(owner.dispose()).resolves.toBeUndefined();
				expect(terminatingSignals).toEqual([]);
				expect(owner.disposed).toBe(true);
				expect(liveOwnedProcessCount()).toBe(before);
			} finally {
				process.kill = realKill;
			}
		},
	);
});

describe("process-lifecycle adversarial resource-owner invariants", () => {
	test("a throwing disposer does not abort disposeAllResourceOwners and other disposers still run", async () => {
		await disposeAllResourceOwners();
		const calls: string[] = [];
		registerResourceOwner("redteam:throws", () => {
			calls.push("throws");
			throw new Error("intentional red-team disposer failure");
		});
		registerResourceOwner("redteam:after", () => {
			calls.push("after");
		});
		registerResourceOwner("redteam:async", async () => {
			await Bun.sleep(1);
			calls.push("async");
		});

		// All disposers run even when one throws, and the failure is surfaced
		// (not swallowed) as an AggregateError so callers can detect it.
		await expect(disposeAllResourceOwners()).rejects.toBeInstanceOf(AggregateError);
		expect(calls).toEqual(["throws", "after", "async"]);
		expect(resourceOwnerCount()).toBe(0);
	});

	test("unregister after disposeAllResourceOwners is safe and cannot remove a newer registration", async () => {
		await disposeAllResourceOwners();
		let first = 0;
		let second = 0;
		const unregister = registerResourceOwner("redteam:late-unregister", () => {
			first += 1;
		});
		await disposeAllResourceOwners();
		expect(first).toBe(1);
		expect(resourceOwnerCount()).toBe(0);

		expect(() => unregister()).not.toThrow();
		registerResourceOwner("redteam:late-unregister", () => {
			second += 1;
		});
		expect(() => unregister()).not.toThrow();
		expect(resourceOwnerCount()).toBe(1);
		await disposeAllResourceOwners();
		expect(second).toBe(1);
	});
});

import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { processStartTime } from "../src/config/file-lock";
import { probeLinuxProcPidSync } from "../src/gjc-runtime/linux-proc";
import { SessionStateLockTestHooks, withSessionStateFileLock } from "../src/gjc-runtime/session-state-lock";

/**
 * Cross-process contention on one coordinator session-state file.
 *
 * The Coordinator MCP server and every runtime sidecar take `<file>.lock` directly from
 * separate OS processes, so in-process serialization proves nothing about them. These
 * tests drive real child processes through the real lock: a writer that loses its
 * acquisition drops a runtime-state update on the floor, which is the reported failure
 * (`lock_owner_live_or_unverifiable` / `transition_claim_timeout` on tool_execution
 * events under 3-4 concurrent gjc sessions).
 */

const PROBE = path.join(import.meta.dir, "fixtures", "session-state-lock-contention-probe.ts");
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const tempDirs: string[] = [];

setDefaultTimeout(120_000);

afterEach(async () => {
	SessionStateLockTestHooks.probeProcessSignal = undefined;
	SessionStateLockTestHooks.unqualifiedOwnerIsLocal = undefined;
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-state-lock-concurrency-"));
	tempDirs.push(dir);
	return dir;
}

interface ProbeFailure {
	reason: string | null;
	lockPath: string | null;
	message: string;
}

interface ContentionOutcome {
	committed: number;
	failures: ProbeFailure[];
	marks: string[];
}

/**
 * Run `writers` independent OS processes, each performing `writes` read-modify-writes of
 * the same state file while holding the lock for `holdMs`.
 */
async function contendFromSeparateProcesses(
	stateFile: string,
	writers: number,
	writes: number,
	holdMs: number,
): Promise<ContentionOutcome> {
	await Bun.write(stateFile, JSON.stringify({ marks: [] }));
	const children = Array.from({ length: writers }, (_, index) =>
		Bun.spawn([process.execPath, PROBE, stateFile, `w${index}`, String(writes), String(holdMs)], {
			cwd: REPO_ROOT,
			env: { ...process.env, NO_COLOR: "1" },
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
	const results = await Promise.all(
		children.map(async child => {
			const [stdout, stderr] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			await child.exited;
			if (child.exitCode !== 0) throw new Error(`contention probe failed (${child.exitCode}): ${stderr}`);
			return JSON.parse(stdout) as { committed: number; failures: ProbeFailure[] };
		}),
	);
	const marks = (JSON.parse(await Bun.file(stateFile).text()) as { marks: string[] }).marks;
	return {
		committed: results.reduce((total, result) => total + result.committed, 0),
		failures: results.flatMap(result => result.failures),
		marks,
	};
}

describe("coordinator session state lock under cross-process contention", () => {
	/**
	 * AC-1. Two writers, both of whose updates must land. A lost acquisition is a dropped
	 * runtime-state update, and a lost UPDATE (fewer persisted marks than committed
	 * sections) would mean the lock failed to exclude at all.
	 */
	it("persists every update from two concurrent cross-process writers", async () => {
		const stateFile = path.join(await tempRoot(), "two-writers.json");

		// A 3s critical section is longer than the lock's own no-progress deadline, which
		// is exactly the shape that used to cost a peer its update.
		const outcome = await contendFromSeparateProcesses(stateFile, 2, 3, 3_000);

		expect(outcome.failures).toEqual([]);
		expect(outcome.committed).toBe(6);
		expect(outcome.marks).toHaveLength(6);
		expect(new Set(outcome.marks).size).toBe(6);
	});

	/**
	 * AC-2. Four concurrent writers must produce zero lock-unavailable refusals. This is
	 * the reported production shape: several gjc sessions on one mac writing the same
	 * session-state projection.
	 */
	it("admits four concurrent cross-process writers without a lock-unavailable refusal", async () => {
		const stateFile = path.join(await tempRoot(), "four-writers.json");

		const outcome = await contendFromSeparateProcesses(stateFile, 4, 8, 400);

		expect(outcome.failures.map(failure => failure.reason)).toEqual([]);
		expect(outcome.committed).toBe(32);
		expect(outcome.marks).toHaveLength(32);
		expect(new Set(outcome.marks).size).toBe(32);
	});

	/**
	 * AC-3. A `.lock` left by a process that was killed while holding it. The owner pid is
	 * provably gone, so a later writer must reclaim the record rather than wait out its
	 * budget and refuse.
	 */
	it("recovers a lock left behind by a killed process", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "killed-owner.json");
		const lockFile = `${stateFile}.lock`;
		await Bun.write(stateFile, JSON.stringify({ marks: [] }));

		// A real process that takes the lock and is then killed mid-hold, so the owner
		// record on disk is exactly what a crashed holder leaves.
		const holder = Bun.spawn([process.execPath, PROBE, stateFile, "killed", "1", "60000"], {
			cwd: REPO_ROOT,
			env: { ...process.env, NO_COLOR: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const deadline = Date.now() + 20_000;
		while (!fsSync.existsSync(lockFile) && Date.now() < deadline) await Bun.sleep(25);
		expect(fsSync.existsSync(lockFile)).toBe(true);
		const owner = JSON.parse(await Bun.file(lockFile).text()) as { pid: number; released?: boolean };
		expect(owner.pid).toBe(holder.pid);
		expect(owner.released).toBeUndefined();

		holder.kill("SIGKILL");
		await holder.exited;

		// The killed holder's record is still on disk, naming a pid that no longer exists.
		expect(fsSync.existsSync(lockFile)).toBe(true);
		expect((JSON.parse(await Bun.file(lockFile).text()) as { pid: number }).pid).toBe(holder.pid);

		await expect(withSessionStateFileLock(stateFile, async () => "recovered")).resolves.toBe("recovered");
	});

	/**
	 * The same crashed holder, observed before its parent has reaped it. Linux keeps the
	 * killed pid in `/proc` as a zombie and `kill(pid, 0)` still succeeds for it, so a
	 * liveness probe that trusts the signal alone refuses the reclaim and burns the whole
	 * claim budget. A zombie cannot hold a lock, so the record must be reclaimed at once.
	 */
	it.skipIf(process.platform !== "linux")(
		"recovers a lock whose killed owner is still an unreaped zombie",
		async () => {
			const root = await tempRoot();
			const stateFile = path.join(root, "zombie-owner.json");
			const lockFile = `${stateFile}.lock`;
			await Bun.write(stateFile, JSON.stringify({ marks: [] }));

			// A LIVE holder, so `kill(pid, 0)` genuinely succeeds and the signal probe alone
			// cannot authorize the reclaim. Only the `/proc` state distinguishes the two.
			const holder = Bun.spawn([process.execPath, PROBE, stateFile, "zombie", "1", "60000"], {
				cwd: REPO_ROOT,
				env: { ...process.env, NO_COLOR: "1" },
				stdout: "pipe",
				stderr: "pipe",
			});
			try {
				const lockDeadline = Date.now() + 20_000;
				while (!fsSync.existsSync(lockFile) && Date.now() < lockDeadline) await Bun.sleep(25);
				expect((JSON.parse(await Bun.file(lockFile).text()) as { pid: number }).pid).toBe(holder.pid);
				expect(() => process.kill(holder.pid, 0)).not.toThrow();

				// When a parent has not yet reaped a killed child, this is what `/proc` reports.
				// Reaping is the parent's schedule, not the test's, so the state is injected.
				const real = probeLinuxProcPidSync(holder.pid);
				if (real.kind !== "live") throw new Error(`expected a live /proc entry for the holder, got ${real.kind}`);
				SessionStateLockTestHooks.probeLinuxProcPid = pid =>
					pid === holder.pid ? { ...real, state: "Z" } : probeLinuxProcPidSync(pid);

				await expect(withSessionStateFileLock(stateFile, async () => "recovered")).resolves.toBe("recovered");
			} finally {
				holder.kill("SIGKILL");
				await holder.exited;
			}
		},
	);

	/**
	 * The zombie verdict must not widen into every `/proc` answer: an owner that is merely
	 * sleeping is still holding the lock, and an unreadable `/proc` entry proves nothing.
	 */
	it.skipIf(process.platform !== "linux")(
		"never reclaims an owner whose /proc state is live or unreadable",
		async () => {
			for (const probe of [
				{ label: "sleeping", result: { kind: "live", state: "S", startTime: "1", ttyDevice: "0" } as const },
				{ label: "unreadable", result: { kind: "unverifiable", reason: "permission_denied" } as const },
			]) {
				const root = await tempRoot();
				const stateFile = path.join(root, `live-proc-${probe.label}.json`);
				const lockFile = `${stateFile}.lock`;
				await Bun.write(stateFile, JSON.stringify({ marks: [] }));
				const readyFile = `${stateFile}.ready`;

				const holder = Bun.spawn([process.execPath, PROBE, stateFile, probe.label, "1", "60000", readyFile], {
					cwd: REPO_ROOT,
					env: { ...process.env, NO_COLOR: "1" },
					stdout: "pipe",
					stderr: "pipe",
				});
				try {
					const lockDeadline = Date.now() + 20_000;
					while (!fsSync.existsSync(readyFile) && Date.now() < lockDeadline) await Bun.sleep(25);
					expect(fsSync.existsSync(readyFile)).toBe(true);
					expect((JSON.parse(await Bun.file(lockFile).text()) as { pid: number }).pid).toBe(holder.pid);

					SessionStateLockTestHooks.probeLinuxProcPid = pid =>
						pid === holder.pid ? probe.result : probeLinuxProcPidSync(pid);

					await expect(withSessionStateFileLock(stateFile, async () => "stolen")).rejects.toThrow();
				} finally {
					holder.kill("SIGKILL");
					await holder.exited;
				}
			}
		},
	);

	/**
	 * The stale verdict must rest on a real liveness probe, not on elapsed time: a lock
	 * held by a LIVE foreign process is never reclaimable however old it looks.
	 */
	it("never reclaims a live foreign owner, however stale the record looks", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "live-foreign-owner.json");
		const lockFile = `${stateFile}.lock`;
		await Bun.write(stateFile, JSON.stringify({ marks: [] }));

		const holder = Bun.spawn([process.execPath, PROBE, stateFile, "live", "1", "60000"], {
			cwd: REPO_ROOT,
			env: { ...process.env, NO_COLOR: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			const deadline = Date.now() + 20_000;
			while (!fsSync.existsSync(lockFile) && Date.now() < deadline) await Bun.sleep(25);
			const record = await Bun.file(lockFile).text();
			expect((JSON.parse(record) as { pid: number }).pid).toBe(holder.pid);
			// Age the record far past every staleness window without touching its bytes.
			const ancient = new Date(Date.now() - 600_000);
			await fs.utimes(lockFile, ancient, ancient);

			const contender = withSessionStateFileLock(stateFile, async () => "stolen");
			const outcome = await Promise.race([
				contender.catch(() => "refused" as const),
				Bun.sleep(2_000).then(() => "waited" as const),
			]);

			expect(outcome).toBe("waited");
			expect(await Bun.file(lockFile).text()).toBe(record);
			holder.kill("SIGKILL");
			await holder.exited;
			await expect(contender).resolves.toBe("stolen");
		} finally {
			holder.kill("SIGKILL");
			await holder.exited;
		}
	});

	/**
	 * The acquisition deadline must bound waiting WITHOUT PROGRESS, not total waiting. A
	 * lock whose holder never changes is the case the deadline exists for, and it must
	 * still refuse on its original ~5s schedule rather than ride the total-wait ceiling.
	 */
	it("still refuses promptly when the lock never changes hands", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "wedged.json");
		const lockFile = `${stateFile}.lock`;
		await Bun.write(stateFile, JSON.stringify({ marks: [] }));
		// One live owner record that nothing ever releases or replaces.
		await Bun.write(
			lockFile,
			JSON.stringify({
				pid: process.pid,
				start_time: processStartTime(process.pid) ?? "unknown",
				token: "wedged-owner",
			}),
		);

		const startedAt = performance.now();
		const failure = await withSessionStateFileLock(stateFile, async () => "entered").catch(error => error);
		const elapsedMs = performance.now() - startedAt;

		expect(failure).toMatchObject({ lockPath: lockFile, reason: "lock_owner_live_or_unverifiable" });
		// Bounded by the no-progress deadline, nowhere near the 60s total-wait ceiling.
		expect(elapsedMs).toBeLessThan(15_000);
	});

	it("proves liveness through kill(pid, 0) rather than record age", async () => {
		expect(processStartTime(process.pid)).not.toBeNull();
		// An unqualified owner record is treated as possibly foreign, and a foreign pid is
		// never probed: local pids say nothing about another host's processes.
		SessionStateLockTestHooks.unqualifiedOwnerIsLocal = true;
		const probed: number[] = [];
		SessionStateLockTestHooks.probeProcessSignal = pid => {
			probed.push(pid);
			throw Object.assign(new Error("no such process"), { code: "ESRCH" });
		};
		const root = await tempRoot();
		const stateFile = path.join(root, "probe-dead.json");
		const lockFile = `${stateFile}.lock`;
		await Bun.write(stateFile, JSON.stringify({ marks: [] }));
		// A pid that is unambiguously alive: only the probe's ESRCH declares it gone.
		await Bun.write(
			lockFile,
			JSON.stringify({ pid: process.pid, start_time: processStartTime(process.pid), token: "probe-dead-owner" }),
		);

		await expect(withSessionStateFileLock(stateFile, async () => "reclaimed")).resolves.toBe("reclaimed");
		expect(probed).toContain(process.pid);
	});
});

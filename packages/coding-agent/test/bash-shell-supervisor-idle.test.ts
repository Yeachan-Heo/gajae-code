import { afterEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startLinuxAdoptedZombieReaper } from "@gajae-code/coding-agent/exec/bash-shell-supervisor";
import { IsolatedShell } from "@gajae-code/coding-agent/exec/isolated-shell";

const isLinux = process.platform === "linux";
// Linux reports utime/stime in USER_HZ, which is 100 on every supported target.
const CLOCK_TICKS_PER_SECOND = 100;

type ProcSample = { cpuSeconds: number; contextSwitches: number; at: number };

function sampleProc(pid: number): ProcSample {
	const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
	const fields = stat
		.slice(stat.lastIndexOf(")") + 2)
		.trim()
		.split(" ");
	// Fields after `comm` start at `state` (field 3); utime/stime are fields 14/15.
	const cpuTicks = Number(fields[11]) + Number(fields[12]);
	const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
	let contextSwitches = 0;
	for (const match of status.matchAll(/ctxt_switches:\s+(\d+)/g)) contextSwitches += Number(match[1]);
	return { cpuSeconds: cpuTicks / CLOCK_TICKS_PER_SECOND, contextSwitches, at: performance.now() };
}

function procState(pid: number): string | undefined {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
	} catch {
		return undefined;
	}
}

describe("bash shell supervisor idle behavior (issue #5972)", () => {
	const shells: IsolatedShell[] = [];
	const dirs: string[] = [];

	afterEach(async () => {
		await Promise.all(shells.splice(0).map(shell => shell.close().catch(() => undefined)));
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	it.skipIf(!isLinux)(
		"stays near 0% CPU while its child shell is idle in sleep",
		async () => {
			const shell = new IsolatedShell();
			shells.push(shell);
			await shell.ready();
			const supervisorPid = shell.supervisorPid();
			expect(supervisorPid).toBeNumber();

			const running = shell.run({ command: "sleep 3", cwd: os.tmpdir() });
			// Let the run dispatch and startup work settle before sampling.
			await Bun.sleep(500);
			const before = sampleProc(supervisorPid!);
			await Bun.sleep(2_000);
			const after = sampleProc(supervisorPid!);
			const wallSeconds = (after.at - before.at) / 1000;
			const cpuPercent = ((after.cpuSeconds - before.cpuSeconds) / wallSeconds) * 100;
			const switchesPerSecond = (after.contextSwitches - before.contextSwitches) / wallSeconds;

			// The 25 ms /proc polling loop measured ~160% CPU and ~30-70k context
			// switches/s here. An event-driven supervisor idles well under 1%.
			expect(cpuPercent).toBeLessThan(10);
			expect(switchesPerSecond).toBeLessThan(2_000);
			await expect(running).resolves.toMatchObject({ exitCode: 0, cancelled: false });
		},
		15_000,
	);

	it.skipIf(!isLinux)(
		"still reaps a descendant reparented to the supervisor once it exits",
		async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-supervisor-reap-"));
			dirs.push(dir);
			const pidFile = path.join(dir, "grandchild.pid");
			const shell = new IsolatedShell();
			shells.push(shell);
			await shell.ready();
			const supervisorPid = shell.supervisorPid();

			// The intermediate `sh` exits immediately, so the backgrounded sleep is
			// orphaned and adopted by the supervisor (the Linux child subreaper).
			await shell.run({ command: `sh -c 'sleep 0.3 & echo $! > "${pidFile}"'`, cwd: dir });
			const grandchildPid = Number.parseInt(fs.readFileSync(pidFile, "utf8"), 10);
			expect(grandchildPid).toBeGreaterThan(0);

			const deadline = Date.now() + 5_000;
			while (procState(grandchildPid) !== undefined && Date.now() < deadline) await Bun.sleep(25);
			// Neither alive nor left behind as an unreaped zombie of the supervisor.
			expect(procState(grandchildPid)).toBeUndefined();
			expect(procState(supervisorPid!)).not.toBe("Z");
		},
		15_000,
	);

	it.skipIf(!isLinux)("runs one sweep per SIGCHLD burst and never overlaps sweeps", async () => {
		let sweeps = 0;
		let active = 0;
		let maxActive = 0;
		let release = Promise.withResolvers<void>();
		// A private emitter isolates the scheduler from real SIGCHLDs that this
		// test process receives when other tests' children exit.
		const signals = new EventEmitter();
		const stop = startLinuxAdoptedZombieReaper(
			undefined,
			async () => {
				sweeps++;
				active++;
				maxActive = Math.max(maxActive, active);
				await release.promise;
				active--;
			},
			signals,
		);
		try {
			// No child state change: no sweep, regardless of elapsed time.
			await Bun.sleep(100);
			expect(sweeps).toBe(0);

			signals.emit("SIGCHLD");
			expect(sweeps).toBe(1);
			// A burst during an in-flight sweep coalesces into exactly one follow-up.
			for (let i = 0; i < 10; i++) signals.emit("SIGCHLD");
			expect(sweeps).toBe(1);
			const first = release;
			release = Promise.withResolvers<void>();
			first.resolve();
			await Bun.sleep(10);
			expect(sweeps).toBe(2);
			release.resolve();
			await Bun.sleep(10);
			expect(sweeps).toBe(2);
			expect(maxActive).toBe(1);

			stop();
			expect(signals.listenerCount("SIGCHLD")).toBe(0);
			signals.emit("SIGCHLD");
			expect(sweeps).toBe(2);
		} finally {
			stop();
		}
	});
});

import { afterAll, describe, expect, test } from "bun:test";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Settings } from "../src/config/settings";
import { parseLinuxProcState } from "../src/gjc-runtime/linux-proc";
import { isZombieProcess, parseDarwinProcessStatus } from "../src/sdk/broker/process-incarnation";
import { daemonPaths } from "../src/sdk/bus/daemon-paths";
import { reclaimDeadDaemonOwner } from "../src/sdk/bus/telegram-daemon";

const BOT_TOKEN = "1234567890:ABCDEFghijkLmnOpQrsTuvWxYz012345678";
const DARWIN_KINFO_PROC_STATUS_OFFSET = 36;
const DARWIN_KINFO_PROC_PID_OFFSET = 40;
const DARWIN_KINFO_PROC_MIN_SIZE = DARWIN_KINFO_PROC_PID_OFFSET + 4;
const DARWIN_SZOMB = 5;
const DARWIN_SRUN = 2;

function settingsFor(agentDir: string): Settings {
	const isolated = Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.enabled": true,
		"notifications.telegram.botToken": BOT_TOKEN,
		"notifications.telegram.chatId": "1234567890",
	}) as Settings;
	return new Proxy(isolated, {
		get(target, property) {
			if (property === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
}

/** Build a synthetic Darwin `kinfo_proc` record carrying `status` for `pid`. */
function darwinRecord(pid: number, status: number, size = DARWIN_KINFO_PROC_MIN_SIZE): Uint8Array {
	const info = new Uint8Array(size);
	const view = new DataView(info.buffer);
	info[DARWIN_KINFO_PROC_STATUS_OFFSET] = status;
	view.setInt32(DARWIN_KINFO_PROC_PID_OFFSET, pid, true);
	return info;
}

/**
 * Spawn a process that forks a child, lets the child exit, and then sleeps
 * without reaping it, so the child stays a zombie for the duration of the run.
 * The intermediate parent detaches into its own session, otherwise the test
 * runner's process group teardown reaps the zombie before it can be observed.
 *
 * Returns `undefined` when the host cannot produce one — no `perl`, or an
 * ambient subreaper that collects the child immediately.
 */
function spawnZombie(): { pid: number; parentPid: number; cleanup: () => void } | undefined {
	if (process.platform !== "darwin" && process.platform !== "linux") return undefined;
	const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gjc-zombie-"));
	const pidFile = path.join(dir, "pids");
	const program = [
		"use POSIX;",
		"my $detach = fork(); exit 0 if $detach;",
		"POSIX::setsid();",
		"my $child = fork(); if ($child == 0) { exit 0; }",
		`open(my $fh, ">", "${pidFile}") or exit 1;`,
		'print $fh "$child $$";',
		"close($fh);",
		"sleep 300;",
	].join(" ");
	const spawned = Bun.spawnSync(["perl", "-e", program], { stdout: "ignore", stderr: "ignore" });
	if (!spawned.success) {
		fsSync.rmSync(dir, { recursive: true, force: true });
		return undefined;
	}
	const deadline = Date.now() + 5_000;
	let pids: number[] = [];
	while (Date.now() < deadline) {
		try {
			pids = fsSync.readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number);
			if (pids.length === 2 && pids.every(pid => Number.isSafeInteger(pid) && pid > 0)) break;
		} catch {
			// keep polling until the detached parent publishes both PIDs
		}
		Bun.sleepSync(25);
	}
	fsSync.rmSync(dir, { recursive: true, force: true });
	const [pid, parentPid] = pids;
	if (!pid || !parentPid) return undefined;
	const cleanup = () => {
		try {
			process.kill(parentPid, "SIGKILL");
		} catch {
			// already gone
		}
	};
	const zombieDeadline = Date.now() + 5_000;
	while (Date.now() < zombieDeadline && !isZombieProcess(pid)) Bun.sleepSync(25);
	if (!isZombieProcess(pid)) {
		cleanup();
		return undefined;
	}
	return { pid, parentPid, cleanup };
}

// One zombie is shared by the cases that need a real one. Hosts that cannot
// produce a zombie report those cases as skipped rather than passing silently.
const zombie = spawnZombie();
const withZombie = test.skipIf(zombie === undefined);

afterAll(() => zombie?.cleanup());

describe("parseDarwinProcessStatus", () => {
	test("reads kp_proc.p_stat from a record whose PID confirms the layout", () => {
		expect(parseDarwinProcessStatus(darwinRecord(4242, DARWIN_SZOMB), DARWIN_KINFO_PROC_MIN_SIZE, 4242)).toBe(
			DARWIN_SZOMB,
		);
		expect(parseDarwinProcessStatus(darwinRecord(4242, DARWIN_SRUN), DARWIN_KINFO_PROC_MIN_SIZE, 4242)).toBe(
			DARWIN_SRUN,
		);
	});

	test("rejects a record whose PID does not match the requested one", () => {
		// A kernel whose struct layout differs would surface here as a PID
		// mismatch, so the status byte must not be trusted.
		expect(parseDarwinProcessStatus(darwinRecord(1, DARWIN_SZOMB), DARWIN_KINFO_PROC_MIN_SIZE, 4242)).toBeUndefined();
	});

	test("refuses a short record rather than reading an unrelated byte", () => {
		const info = darwinRecord(4242, DARWIN_SZOMB);
		expect(parseDarwinProcessStatus(info, DARWIN_KINFO_PROC_MIN_SIZE - 1, 4242)).toBeUndefined();
		expect(parseDarwinProcessStatus(new Uint8Array(8), 8, 4242)).toBeUndefined();
	});
});

describe("linux zombie state", () => {
	test("field 3 of /proc/<pid>/stat reports Z for a zombie", () => {
		// Pins the contract the Linux branch of isZombieProcess relies on,
		// including a `comm` value containing spaces and parentheses.
		const stat = `4242 (my proc (x)) Z 4241 4242 0 0 -1 4194560 ${Array(15).fill(0).join(" ")} 998877 0 0`;
		expect(parseLinuxProcState(stat)).toBe("Z");
	});
});

describe("isZombieProcess", () => {
	test("a live process is never reported as a zombie", () => {
		expect(isZombieProcess(process.pid)).toBe(false);
	});

	test("an absent or invalid PID is not a zombie", () => {
		expect(isZombieProcess(999_999)).toBe(false);
		expect(isZombieProcess(0)).toBe(false);
		expect(isZombieProcess(-1)).toBe(false);
		expect(isZombieProcess(Number.NaN)).toBe(false);
	});

	test("a process owned by another user is not misreported as a zombie", () => {
		// PID 1 is root-owned, so the permission-limited proc_pidinfo probe cannot
		// read it. Missing evidence must stay "not a zombie" instead of becoming a
		// reclaim signal against a live process.
		expect(isZombieProcess(1)).toBe(false);
	});

	test("an unsupported platform never claims a zombie", () => {
		expect(isZombieProcess(process.pid, { platform: "win32" })).toBe(false);
	});

	withZombie("a real zombie is detected even though signal 0 still succeeds", () => {
		const pid = (zombie as { pid: number }).pid;
		let signalLanded = false;
		try {
			process.kill(pid, 0);
			signalLanded = true;
		} catch {
			signalLanded = false;
		}
		// The premise of the bug: the PID slot is still signalable, so every
		// kill(pid, 0) probe reads this exited process as alive.
		expect(signalLanded).toBe(true);
		expect(isZombieProcess(pid)).toBe(true);
	});
});

describe("reclaimDeadDaemonOwner with a zombie owner", () => {
	withZombie("clears ownership left behind by a daemon whose launcher never reaped it", async () => {
		const { pid, parentPid } = zombie as { pid: number; parentPid: number };
		const agentDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gjc-zombie-owner-"));
		try {
			const paths = daemonPaths(agentDir);
			fsSync.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
			const ownerId = "daemon-00000000-0000-4000-8000-000000000000";
			const state = {
				pid,
				incarnation: "darwin:1700000000:1",
				ownerId,
				acquisitionId: ownerId,
				ownershipPhase: "ready",
				tokenFingerprint: "aaaaaaaaaaaa",
				chatId: "1234567890",
				startedAt: Date.now() - 60_000,
				heartbeatAt: Date.now() - 60_000,
				version: 1,
				generation: 1,
				launcherPid: parentPid,
			};
			fsSync.writeFileSync(paths.state, JSON.stringify(state), { mode: 0o600 });
			fsSync.writeFileSync(
				paths.lock,
				JSON.stringify({
					pid,
					incarnation: state.incarnation,
					ownerId,
					acquisitionId: ownerId,
					startedAt: state.startedAt,
				}),
				{ mode: 0o600 },
			);

			const result = await reclaimDeadDaemonOwner({ settings: settingsFor(agentDir) });

			// Before zombie-aware liveness this returned `not-confirmed-dead` on
			// every attempt, so no later session could ever take ownership.
			expect(result).toEqual({ recovered: true, reason: "cleared" });
			expect(fsSync.existsSync(paths.lock)).toBe(false);
		} finally {
			fsSync.rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

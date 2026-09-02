import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { NativeExactUnlinkResult } from "@gajae-code/natives";
import { processStartTime, removeFileLockDirForGc } from "../src/config/file-lock";
import * as sessionStateLock from "../src/gjc-runtime/session-state-lock";
import {
	heldSessionStateLockPathsForTest,
	reclaimStaleSessionStateLock,
	releaseHeldSessionStateLocksSync,
	resetPersistFailureWarnWindows,
	SessionStateLockTestHooks,
	SessionStateLockUnavailableError,
	sessionStateLockFailureFields,
	setSessionStateLockNativeBindings,
	shouldWarnPersistFailure,
	withSessionStateFileLock,
} from "../src/gjc-runtime/session-state-lock";
import {
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
	persistCoordinatorRuntimeStateFromEvent,
} from "../src/gjc-runtime/session-state-sidecar";
import { exactIdentityNativeBindings, installExactIdentityNatives } from "./helpers/exact-identity-natives";

/**
 * The state-file lock has TWO on-disk shapes to survive, because the two base writers did
 * not agree: the base Coordinator wrote a regular `<file>.lock` owner JSON, while the base
 * runtime guarded the same path with the generic directory-style lock. Both are exercised
 * here, along with the shapes neither wrote and which must therefore fail closed.
 */

const SESSION_ID = "lock-session";
const ORIGINAL_STATE_FILE = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
const tempDirs: string[] = [];

installExactIdentityNatives();

beforeEach(() => {
	SessionStateLockTestHooks.ownerHostId = () => "local-host";
	SessionStateLockTestHooks.legacyOwnerHostId = () => "legacy-local-host";
	SessionStateLockTestHooks.unqualifiedOwnerIsLocal = true;
});

afterEach(async () => {
	SessionStateLockTestHooks.afterStaleInspection = undefined;
	SessionStateLockTestHooks.beforeStaleRemoval = undefined;
	SessionStateLockTestHooks.afterLockTypeDecision = undefined;
	SessionStateLockTestHooks.afterTransitionStaleInspection = undefined;
	SessionStateLockTestHooks.beforeTransitionStaleRemoval = undefined;
	SessionStateLockTestHooks.beforeLegacyDirectoryRemoval = undefined;
	SessionStateLockTestHooks.afterLegacyDirectoryStaleVerdict = undefined;
	SessionStateLockTestHooks.ownerAccessStrategy = undefined;
	SessionStateLockTestHooks.probeProcessSignal = undefined;
	SessionStateLockTestHooks.ownerRecordWriteFault = undefined;
	SessionStateLockTestHooks.ownerHostId = undefined;
	SessionStateLockTestHooks.loadInstallationHostId = undefined;
	SessionStateLockTestHooks.legacyOwnerHostId = undefined;
	SessionStateLockTestHooks.unqualifiedOwnerIsLocal = undefined;
	SessionStateLockTestHooks.beforeCurrentOwnerRelease = undefined;
	SessionStateLockTestHooks.afterCurrentOwnerValidation = undefined;
	SessionStateLockTestHooks.beforeOwnerRecordRewrite = undefined;
	SessionStateLockTestHooks.beforeTransitionReleaseLstat = undefined;
	SessionStateLockTestHooks.beforeTransitionSetupLstat = undefined;
	SessionStateLockTestHooks.afterAcquireContention = undefined;
	installExactIdentityNatives();
	// Tests that deliberately leave a record unreleasable (replaced under the holder)
	// keep it registered, exactly as a real force-quit would see it; drain it here.
	releaseHeldSessionStateLocksSync();
	setSystemTime();
	if (ORIGINAL_STATE_FILE === undefined) delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
	else process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = ORIGINAL_STATE_FILE;
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-state-lock-"));
	tempDirs.push(dir);
	return dir;
}

async function readJson(file: string): Promise<Record<string, unknown>> {
	return JSON.parse(await Bun.file(file).text()) as Record<string, unknown>;
}

async function seededRunningSession(name: string): Promise<{ root: string; stateFile: string }> {
	const root = await tempRoot();
	const stateFile = path.join(root, `${name}.json`);
	process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
	setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
	await persistCoordinatorRuntimeStateFromEvent(
		{ type: "turn_start" },
		{ sessionId: SESSION_ID, cwd: root, sessionFile: null },
	);
	// Production keeps released compatibility tombstones. Most tests install a
	// specific pre-existing lock shape, so start each fixture from an empty path.
	await fs.rm(`${stateFile}.lock`, { force: true });
	await fs.rm(`${stateFile}.lock.transition`, { recursive: true, force: true });
	await fs.rm(`${stateFile}.lock.transition.owner`, { force: true });
	return { root, stateFile };
}

async function expectReleasedOwner(file: string): Promise<void> {
	expect(await readJson(file)).toMatchObject({
		pid: 1,
		start_time: "unknown",
		owner_host_id: "local-host",
		released: true,
	});
}

function expectReleasedTransition(lockFile: string): void {
	expect(fsSync.existsSync(`${lockFile}.transition`)).toBe(false);
	expect(JSON.parse(fsSync.readFileSync(`${lockFile}.transition.owner`, "utf8"))).toMatchObject({
		pid: 1,
		start_time: "unknown",
		owner_host_id: "local-host",
		released: true,
	});
}

/** One activity write through the full acquire path, so the lock is actually contended. */
async function writeToolActivity(root: string, callId: string, at: string): Promise<void> {
	setSystemTime(new Date(at));
	await persistCoordinatorRuntimeStateFromEvent(
		{ type: "tool_execution_start", toolCallId: callId },
		{ sessionId: SESSION_ID, cwd: root, sessionFile: null },
		{ label: "bash", observedAt: at },
	);
}

/** A pid that no process can hold, so liveness is provably dead rather than unknown. */
const DEAD_PID = 2 ** 22 - 1;

async function writeGenericLockDir(lockFile: string, info: Record<string, unknown>): Promise<void> {
	await fs.mkdir(lockFile, { recursive: true });
	await Bun.write(path.join(lockFile, "info"), JSON.stringify(info));
}

function installCleanupPendingNative(lockFile: string, result: NativeExactUnlinkResult, detachOriginal = true): void {
	setSessionStateLockNativeBindings(() => ({
		...exactIdentityNativeBindings,
		exactRemoveDirectoryTree(target, snapshot) {
			const observed = exactIdentityNativeBindings.snapshotDirectoryTree(target);
			if (!observed.ok || JSON.stringify(observed.snapshot) !== JSON.stringify(snapshot))
				return { ok: false, code: "identity_mismatch" };
			if (detachOriginal) fsSync.renameSync(target, `${lockFile}.removing`);
			return result;
		},
	}));
}

/**
 * The claim record whose holder is currently inside a pathname transition.
 *
 * It is a regular owner record at `<file>.lock.transition`, in the same format as the
 * record it guards, so its liveness is proved from the pid it names rather than from how
 * long it has been sitting there.
 */
function liveTransitionPath(lockFile: string): string {
	const transitionDir = `${lockFile}.transition`;
	const ownerFile = `${transitionDir}.owner`;
	if (!fsSync.statSync(transitionDir).isDirectory() || !fsSync.existsSync(ownerFile))
		throw new Error("no transition claim was held during the stale-removal window");
	return ownerFile;
}

/** Inode identity, so a break-and-recreate is not mistaken for survival. */
function transitionToken(transitionPath: string): string {
	const stat = fsSync.lstatSync(transitionPath);
	return `${stat.dev}:${stat.ino}`;
}

/**
 * Inode identity AND payload of every entry beneath `dir`.
 *
 * A legacy directory is a TREE, so survival has to be proved as a tree: re-reading the
 * owner token proves nothing about a successor that recreated the path, and a matching
 * `info` payload proves nothing about a different inode. Recording dev/ino alongside the
 * bytes of every file makes a break-and-recreate impossible to mistake for survival.
 */
function directoryTreeIdentity(dir: string): string {
	const walk = (relative: string): string[] => {
		const absolute = relative === "" ? dir : path.join(dir, relative);
		const stat = fsSync.lstatSync(absolute, { bigint: true });
		const line = `${relative}|${stat.dev}:${stat.ino}:${stat.nlink}:${stat.size}:${stat.mtimeNs}`;
		if (!stat.isDirectory()) return [`${line}|${fsSync.readFileSync(absolute).toString("hex")}`];
		return [
			line,
			...fsSync
				.readdirSync(absolute)
				.sort()
				.flatMap(name => walk(relative === "" ? name : `${relative}/${name}`)),
		];
	};
	return walk("").join("\n");
}

/**
 * Make a HELD claim look abandoned, without touching one byte of it.
 *
 * Backdating the record itself is not an option any more: its `mtime` is part of the
 * identity its holder will release against, so writing to it would forge a different
 * object rather than age the same one. Moving the clock forward instead leaves the record
 * exactly as its holder wrote it and puts every elapsed-time heuristic far past any
 * abandonment window — which is precisely the claim under test: only the owner's liveness
 * decides, never the clock.
 *
 * @returns a restore for the frozen test clock.
 */
function ageWorldPastAnyStaleWindow(): () => void {
	const frozen = Date.now();
	setSystemTime(new Date(frozen + 600_000));
	return () => setSystemTime(new Date(frozen));
}

describe("coordinator session state lock", () => {
	it("serializes a concurrent writer behind the current lock holder", async () => {
		const { root, stateFile } = await seededRunningSession("lock-current");
		// System time is frozen in these tests, so order is recorded explicitly.
		const order: string[] = [];
		const held = withSessionStateFileLock(stateFile, async () => {
			await Bun.sleep(120);
			order.push("holder-released");
		});
		await Bun.sleep(20);

		await writeToolActivity(root, "call-1", "2026-03-01T00:00:05.000Z");
		order.push("waiter-wrote");
		await held;

		expect(order).toEqual(["holder-released", "waiter-wrote"]);
		expect((await readJson(stateFile)).activity).toMatchObject({ seq: 1, tool: "bash" });
	});

	it("serializes concurrent resume contenders after reclaiming a dead transition claim", async () => {
		const { stateFile } = await seededRunningSession("lock-concurrent-resume");
		const transitionDir = `${stateFile}.lock.transition`;
		await fs.mkdir(transitionDir);
		await fs.writeFile(
			`${transitionDir}.owner`,
			JSON.stringify({
				pid: DEAD_PID,
				start_time: "unknown",
				token: "dead-resume-transition",
				owner_host_id: "local-host",
			}),
		);

		const order: string[] = [];
		const firstEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const first = withSessionStateFileLock(stateFile, async () => {
			order.push("first-entered");
			firstEntered.resolve();
			await releaseFirst.promise;
			order.push("first-released");
		});
		await firstEntered.promise;

		const second = withSessionStateFileLock(stateFile, async () => {
			order.push("second-entered");
		});
		await Bun.sleep(100);
		expect(order).toEqual(["first-entered"]);

		releaseFirst.resolve();
		await Promise.all([first, second]);
		expect(order).toEqual(["first-entered", "first-released", "second-entered"]);
	});

	it("keeps session-state parents, transition claims, and owner records restrictive under umask", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "nested", "session", "state.json");
		const previousUmask = process.umask(0o777);
		try {
			SessionStateLockTestHooks.afterCurrentOwnerValidation = async file => {
				if (file !== `${stateFile}.lock`) return;
				if (process.platform !== "win32") {
					expect((await fs.stat(`${stateFile}.lock.transition`)).mode & 0o777).toBe(0o700);
					expect((await fs.stat(`${stateFile}.lock.transition.owner`)).mode & 0o777).toBe(0o600);
				}
				SessionStateLockTestHooks.afterCurrentOwnerValidation = undefined;
			};
			await withSessionStateFileLock(stateFile, async () => {
				if (process.platform !== "win32") {
					for (const directory of [path.dirname(stateFile), path.dirname(path.dirname(stateFile))]) {
						expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
					}
					expect((await fs.stat(`${stateFile}.lock`)).mode & 0o777).toBe(0o600);
				}
			});
		} finally {
			process.umask(previousUmask);
		}
	});

	it("never creates a lock directory that would strand a base regular-file writer", async () => {
		const { root, stateFile } = await seededRunningSession("lock-no-enotdir");
		const observed: Array<string | undefined> = [];
		await withSessionStateFileLock(stateFile, async () => {
			observed.push(fsSync.statSync(`${stateFile}.lock`).isFile() ? "file" : "dir");
		});

		await writeToolActivity(root, "call-1", "2026-03-01T00:00:05.000Z");

		expect(observed).toEqual(["file"]);
		expect((await readJson(stateFile)).activity).toMatchObject({ seq: 1 });
	});

	it("waits for a live regular owner instead of reclaiming it by age", async () => {
		const { stateFile } = await seededRunningSession("lock-live-regular");
		const lockFile = `${stateFile}.lock`;
		// This process is unambiguously alive, and its recorded start time is the portable
		// value a current writer stamps. Age alone must not make it reclaimable.
		await fs.writeFile(
			lockFile,
			JSON.stringify({
				pid: process.pid,
				start_time: processStartTime(process.pid) ?? "unknown",
				token: "live-owner-token",
			}),
		);
		const stale = new Date(Date.now() - 600_000);
		await fs.utimes(lockFile, stale, stale);

		await reclaimStaleSessionStateLock(lockFile);

		expect(fsSync.existsSync(lockFile)).toBe(true);
		expect((await readJson(lockFile)).token).toBe("live-owner-token");
	});

	describe("the portable process start probe", () => {
		it("returns a stable, non-null start value for the current process on every supported platform", () => {
			// The reclaim-by-incarnation tests below presuppose this: without a reader value
			// a start-time mismatch is indeterminate and the record has to survive. Windows
			// has no `ps`, so there the natives addon's kernel-derived creation time answers.
			const first = processStartTime(process.pid);
			expect(first).not.toBeNull();
			expect(processStartTime(process.pid)).toBe(first);
			if (process.platform === "win32") expect(first).toMatch(/^windows:\d+$/);
		});

		it("returns null for a pid that cannot be probed instead of throwing", () => {
			expect(processStartTime(DEAD_PID)).toBeNull();
		});
	});

	/**
	 * `process.kill(pid, 0)` answers three different questions with one call, and only one
	 * of its answers means the owner is gone.
	 *
	 * `ESRCH` is the proof of death. `EPERM` is the opposite: the process EXISTS, this
	 * process just may not signal it — which is the normal answer for an owner running as
	 * another user, under a different container UID, or behind a sandbox policy. Anything
	 * else is a question the OS declined to answer at all. Treating either of the last two
	 * as death authorizes deleting a lock whose holder is still writing behind it, and the
	 * exact-identity unlink cannot save it: the record still IS the record that was judged,
	 * so the compare-and-delete matches and the live owner loses its lock.
	 *
	 * The probe is injected because the answer is a property of the OS and the caller's
	 * privileges, not of anything the test can arrange on disk.
	 */
	describe("owner liveness the OS will not answer", () => {
		/** The pid names a real process; this process may just not signal it. */
		const EPERM_PROBE = (): never => {
			throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
		};
		/** Neither proof of death nor proof of life. */
		const UNKNOWN_PROBE = (): never => {
			throw Object.assign(new Error("input/output error"), { code: "EIO" });
		};

		for (const { name, probe } of [
			{ name: "refuses the signal (EPERM)", probe: EPERM_PROBE },
			{ name: "answers nothing usable", probe: UNKNOWN_PROBE },
		]) {
			it(`never reclaims a regular owner whose liveness probe ${name}, however old`, async () => {
				const { stateFile } = await seededRunningSession(`lock-unsignalable-${name.slice(0, 6)}`);
				const lockFile = `${stateFile}.lock`;
				const record = JSON.stringify({ pid: DEAD_PID, start_time: "unknown", token: "unsignalable-owner" });
				await fs.writeFile(lockFile, record);
				// Old enough that every elapsed-time heuristic would call it abandoned.
				const stale = new Date(Date.now() - 600_000);
				await fs.utimes(lockFile, stale, stale);
				SessionStateLockTestHooks.probeProcessSignal = probe;

				await reclaimStaleSessionStateLock(lockFile);

				expect(fsSync.existsSync(lockFile)).toBe(true);
				expect(await fs.readFile(lockFile, "utf8")).toBe(record);
			});
		}

		it("never breaks a transition claim whose holder refuses the signal, however old", async () => {
			const { stateFile } = await seededRunningSession("lock-unsignalable-transition");
			const lockFile = `${stateFile}.lock`;
			const transitionFile = `${lockFile}.transition`;
			const record = JSON.stringify({ pid: DEAD_PID, start_time: "unknown", token: "unsignalable-transition" });
			await fs.writeFile(transitionFile, record);
			const stale = new Date(Date.now() - 600_000);
			await fs.utimes(transitionFile, stale, stale);
			SessionStateLockTestHooks.probeProcessSignal = EPERM_PROBE;

			const entered: string[] = [];
			// Every chance to break it: the contender retries the claim throughout.
			const contender = withSessionStateFileLock(stateFile, async () => {
				entered.push("entered");
			});
			await Promise.race([contender, Bun.sleep(300)]);

			// The claim record is untouched, so no transition ran and no state lock was taken.
			expect(await fs.readFile(transitionFile, "utf8")).toBe(record);
			expect(entered).toEqual([]);

			// Its holder finally gives it up, and only then does the contender proceed.
			await fs.rm(transitionFile);
			await contender;
			expect(entered).toEqual(["entered"]);
		});

		it("reclaims an owner the probe proves gone, however alive its pid looks", async () => {
			const { stateFile } = await seededRunningSession("lock-probed-dead");
			const lockFile = `${stateFile}.lock`;
			// A pid that is unambiguously alive right now, recorded with the start time a
			// current writer stamps: only the probe's ESRCH says this owner is gone.
			await fs.writeFile(
				lockFile,
				JSON.stringify({
					pid: process.pid,
					start_time: processStartTime(process.pid) ?? "unknown",
					token: "probed-dead-owner",
				}),
			);
			SessionStateLockTestHooks.probeProcessSignal = () => {
				throw Object.assign(new Error("no such process"), { code: "ESRCH" });
			};

			await reclaimStaleSessionStateLock(lockFile);

			expect(fsSync.existsSync(lockFile)).toBe(false);
		});

		/**
		 * Unknown liveness never authorizes a deletion, but recorded IDENTITY still can:
		 * an unsignalable pid whose start time provably belongs to a different incarnation
		 * is a reused pid, and the owner that wrote this record is gone.
		 */
		it("still reclaims an unsignalable owner whose recorded incarnation is provably gone", async () => {
			const { stateFile } = await seededRunningSession("lock-unsignalable-reused-pid");
			const lockFile = `${stateFile}.lock`;
			// The reader has to actually produce a value; without one the mismatch would be
			// indeterminate rather than proved, and the record would have to survive.
			expect(processStartTime(process.pid)).not.toBeNull();
			await fs.writeFile(
				lockFile,
				JSON.stringify({
					pid: process.pid,
					start_time: "Thu Jan  1 00:00:00 1970",
					start_time_format: "ps-utc-v1",
					token: "reused-pid-owner",
				}),
			);
			SessionStateLockTestHooks.probeProcessSignal = EPERM_PROBE;

			await reclaimStaleSessionStateLock(lockFile);

			expect(fsSync.existsSync(lockFile)).toBe(false);
		});

		it("preserves an unversioned live owner when its start-time encoding mismatches", async () => {
			const { stateFile } = await seededRunningSession("lock-legacy-mismatched-start");
			const lockFile = `${stateFile}.lock`;
			await fs.writeFile(
				lockFile,
				JSON.stringify({
					pid: process.pid,
					start_time: "Thu Jan  1 00:00:00 1970",
					token: "legacy-token",
				}),
			);
			SessionStateLockTestHooks.probeProcessSignal = EPERM_PROBE;

			await reclaimStaleSessionStateLock(lockFile);

			expect(fsSync.existsSync(lockFile)).toBe(true);
		});
	});

	it("reclaims a base regular-file lock left by a dead owner instead of faulting", async () => {
		const { root, stateFile } = await seededRunningSession("lock-dead-owner");
		// The exact base owner JSON, written by a pid that no longer exists.
		await fs.writeFile(
			`${stateFile}.lock`,
			JSON.stringify({ pid: DEAD_PID, start_time: "unknown", token: "base-owner-token" }),
		);

		await writeToolActivity(root, "call-1", "2026-03-01T00:00:05.000Z");

		expect((await readJson(stateFile)).activity).toMatchObject({ seq: 1, tool: "bash" });
		await expectReleasedOwner(`${stateFile}.lock`);
		expectReleasedTransition(`${stateFile}.lock`);
	});

	it("reclaims a malformed owner file only once it is stale", async () => {
		const { root, stateFile } = await seededRunningSession("lock-malformed-owner");
		const lockFile = `${stateFile}.lock`;
		await fs.writeFile(lockFile, "not-json");
		// A malformed owner has no pid to prove liveness with, so it is reclaimable
		// only after its own mtime goes stale.
		const stale = new Date(Date.now() - 60_000);
		await fs.utimes(lockFile, stale, stale);

		await writeToolActivity(root, "call-1", "2026-03-01T00:00:05.000Z");

		expect((await readJson(stateFile)).activity).toMatchObject({ seq: 1, tool: "bash" });
		await expectReleasedOwner(lockFile);
		expectReleasedTransition(lockFile);
	});

	it("leaves a successor owner that claimed the path after the stale verdict", async () => {
		const { stateFile } = await seededRunningSession("lock-successor");
		const lockFile = `${stateFile}.lock`;
		await fs.writeFile(lockFile, "not-json");
		const stale = new Date(Date.now() - 60_000);
		await fs.utimes(lockFile, stale, stale);

		const successor = JSON.stringify({
			pid: process.pid,
			start_time: processStartTime(process.pid) ?? "unknown",
			token: "successor-token",
		});
		// Exactly the reclaim TOCTOU window: the stale record is replaced by a live
		// successor between the inspection and the unlink.
		SessionStateLockTestHooks.afterStaleInspection = async () => {
			await fs.writeFile(lockFile, successor);
		};

		await reclaimStaleSessionStateLock(lockFile);

		expect(await fs.readFile(lockFile, "utf8")).toBe(successor);
	});

	it("keeps a current contender out of the lock path until the stale record is removed", async () => {
		const { stateFile } = await seededRunningSession("lock-final-window");
		const lockFile = `${stateFile}.lock`;
		await fs.writeFile(lockFile, JSON.stringify({ pid: DEAD_PID, start_time: "unknown", token: "dead-owner-token" }));

		const order: string[] = [];
		const contenderEntered = Promise.withResolvers<void>();
		const releaseContender = Promise.withResolvers<void>();
		let contender: Promise<void> | undefined;
		let entries = 0;
		let enteredDuringWindow = false;

		// The FINAL window: identity has just been re-validated and the unlink has not
		// happened yet. A current contender that slips in here takes the pathname, and the
		// unlink below then reaps ITS live lock.
		SessionStateLockTestHooks.beforeStaleRemoval = async () => {
			if (contender) return;
			order.push("window-open");
			contender = withSessionStateFileLock(stateFile, async () => {
				entries++;
				order.push("contender-entered");
				contenderEntered.resolve();
				await releaseContender.promise;
			});
			// Every chance to win the race: the contender fails `wx`, reclaims, and retries
			// many times over this interval.
			await Promise.race([contenderEntered.promise, Bun.sleep(300)]);
			enteredDuringWindow = order.includes("contender-entered");
			order.push("window-closed");
		};

		await reclaimStaleSessionStateLock(lockFile);
		order.push("stale-removed");

		await contenderEntered.promise;
		// The successor holds the pathname with ITS OWN owner record — the reclaimer
		// removed the stale record it validated, never a successor's live lock.
		const heldOwner = JSON.parse(await fs.readFile(lockFile, "utf8")) as Record<string, unknown>;
		expect(heldOwner.pid).toBe(process.pid);
		expect(heldOwner.token).not.toBe("dead-owner-token");

		releaseContender.resolve();
		await contender;

		expect(enteredDuringWindow).toBe(false);
		expect(entries).toBe(1);
		expect(order).toEqual(["window-open", "window-closed", "stale-removed", "contender-entered"]);
		await expectReleasedOwner(lockFile);
		expectReleasedTransition(lockFile);
	});

	it("never breaks a transition claim whose holder is still inside it, however old it looks", async () => {
		const { stateFile } = await seededRunningSession("lock-live-transition");
		const lockFile = `${stateFile}.lock`;
		await fs.writeFile(lockFile, JSON.stringify({ pid: DEAD_PID, start_time: "unknown", token: "dead-owner-token" }));

		const order: string[] = [];
		const contenderEntered = Promise.withResolvers<void>();
		const releaseContender = Promise.withResolvers<void>();
		let contender: Promise<void> | undefined;
		let entries = 0;
		let heldTransition = "";
		let transitionSurvived = false;
		let enteredDuringWindow = false;

		// Inside the transition, holding it, with the final identity check already done: a
		// process pause or a stalled filesystem here is indistinguishable from an old claim.
		SessionStateLockTestHooks.beforeStaleRemoval = async () => {
			if (contender) return;
			order.push("window-open");
			heldTransition = liveTransitionPath(lockFile);
			const token = transitionToken(heldTransition);
			const restoreClock = ageWorldPastAnyStaleWindow();

			contender = withSessionStateFileLock(stateFile, async () => {
				entries++;
				order.push("contender-entered");
				contenderEntered.resolve();
				await releaseContender.promise;
			});
			// Every chance to break it: the contender retries the claim throughout.
			await Promise.race([contenderEntered.promise, Bun.sleep(300)]);
			transitionSurvived = fsSync.existsSync(heldTransition) && transitionToken(heldTransition) === token;
			enteredDuringWindow = order.includes("contender-entered");
			restoreClock();
			order.push("window-closed");
		};

		await reclaimStaleSessionStateLock(lockFile);
		order.push("stale-removed");

		await contenderEntered.promise;
		// The same claim record, never removed and never replaced by a breaker's own.
		expect(transitionSurvived).toBe(true);
		expect(enteredDuringWindow).toBe(false);

		releaseContender.resolve();
		await contender;

		expect(entries).toBe(1);
		expect(order).toEqual(["window-open", "window-closed", "stale-removed", "contender-entered"]);
		await expectReleasedOwner(lockFile);
		expectReleasedTransition(lockFile);
	});

	it("never removes a live legacy directory owner, however old its timestamp", async () => {
		const { stateFile } = await seededRunningSession("lock-live-directory");
		const lockFile = `${stateFile}.lock`;
		await writeGenericLockDir(lockFile, {
			pid: process.pid,
			start_time: processStartTime(process.pid) ?? undefined,
			timestamp: Date.now() - 600_000,
		});

		await reclaimStaleSessionStateLock(lockFile);

		expect(fsSync.statSync(lockFile).isDirectory()).toBe(true);
		expect(await readJson(path.join(lockFile, "info"))).toMatchObject({ pid: process.pid });
	});

	it("reclaims a legacy directory lock whose owner is dead and completes the write", async () => {
		const { root, stateFile } = await seededRunningSession("lock-dead-directory");
		const lockFile = `${stateFile}.lock`;
		await writeGenericLockDir(lockFile, { pid: DEAD_PID, start_time: "whenever", timestamp: Date.now() });

		await writeToolActivity(root, "call-1", "2026-03-01T00:00:05.000Z");

		expect((await readJson(stateFile)).activity).toMatchObject({ seq: 1, tool: "bash" });
		await expectReleasedOwner(lockFile);
		expectReleasedTransition(lockFile);
	});

	it("continues after native cleanup durably detaches a stale legacy directory", async () => {
		const { root, stateFile } = await seededRunningSession("lock-detached-directory");
		const lockFile = `${stateFile}.lock`;
		const detachedLock = `${lockFile}.removing`;
		await writeGenericLockDir(lockFile, { pid: DEAD_PID, start_time: "whenever", timestamp: Date.now() });
		installCleanupPendingNative(lockFile, {
			ok: false,
			code: "cleanup_pending",
			payloadDurable: true,
			detachedPath: detachedLock,
		});

		await writeToolActivity(root, "call-1", "2026-03-01T00:00:05.000Z");

		expect((await readJson(stateFile)).activity).toMatchObject({ seq: 1, tool: "bash" });
		await expectReleasedOwner(lockFile);
		expectReleasedTransition(lockFile);
		expect(fsSync.statSync(detachedLock).isDirectory()).toBe(true);
	});

	it("refuses a detached cleanup receipt whose payload is not durable", async () => {
		const { stateFile } = await seededRunningSession("lock-nondurable-directory");
		const lockFile = `${stateFile}.lock`;
		const detachedLock = `${lockFile}.removing`;
		await writeGenericLockDir(lockFile, { pid: DEAD_PID, start_time: "whenever", timestamp: Date.now() });
		installCleanupPendingNative(lockFile, {
			ok: false,
			code: "cleanup_pending",
			payloadDurable: false,
			detachedPath: detachedLock,
		});

		await expect(reclaimStaleSessionStateLock(lockFile)).rejects.toBeInstanceOf(SessionStateLockUnavailableError);
		expect(fsSync.existsSync(lockFile)).toBe(false);
		expect(fsSync.statSync(detachedLock).isDirectory()).toBe(true);
	});

	it("refuses a detached cleanup receipt naming a different retained path", async () => {
		const { stateFile } = await seededRunningSession("lock-wrong-detached-directory");
		const lockFile = `${stateFile}.lock`;
		const detachedLock = `${lockFile}.removing`;
		await writeGenericLockDir(lockFile, { pid: DEAD_PID, start_time: "whenever", timestamp: Date.now() });
		installCleanupPendingNative(lockFile, {
			ok: false,
			code: "cleanup_pending",
			payloadDurable: true,
			detachedPath: `${lockFile}.unexpected`,
		});

		await expect(reclaimStaleSessionStateLock(lockFile)).rejects.toBeInstanceOf(SessionStateLockUnavailableError);
		expect(fsSync.existsSync(lockFile)).toBe(false);
		expect(fsSync.statSync(detachedLock).isDirectory()).toBe(true);
	});

	it("refuses cleanup pending while the authorized lock still occupies its pathname", async () => {
		const { stateFile } = await seededRunningSession("lock-undetached-directory");
		const lockFile = `${stateFile}.lock`;
		await writeGenericLockDir(lockFile, { pid: DEAD_PID, start_time: "whenever", timestamp: Date.now() });
		installCleanupPendingNative(
			lockFile,
			{ ok: false, code: "cleanup_pending", payloadDurable: true, detachedPath: `${lockFile}.removing` },
			false,
		);

		await expect(reclaimStaleSessionStateLock(lockFile)).rejects.toBeInstanceOf(SessionStateLockUnavailableError);
		expect(fsSync.statSync(lockFile).isDirectory()).toBe(true);
	});

	it("fails closed on a legacy directory lock with no readable owner", async () => {
		const { stateFile } = await seededRunningSession("lock-malformed-directory");
		const lockFile = `${stateFile}.lock`;
		await fs.mkdir(lockFile, { recursive: true });
		await Bun.write(path.join(lockFile, "info"), "not-json");

		// Neither freshness nor staleness proves that an unreadable owner is gone.
		await reclaimStaleSessionStateLock(lockFile);
		expect(fsSync.statSync(lockFile).isDirectory()).toBe(true);

		const stale = new Date(Date.now() - 60_000);
		await fs.utimes(lockFile, stale, stale);
		await reclaimStaleSessionStateLock(lockFile);
		expect(fsSync.statSync(lockFile).isDirectory()).toBe(true);
		expect((await readJson(stateFile)).activity).toBeUndefined();
	});

	it("refuses to delete a legacy directory whose owner token changed", async () => {
		const root = await tempRoot();
		const lockDir = path.join(root, "state.json.lock");
		const observed = { pid: DEAD_PID, start_time: "whenever", timestamp: 1 };
		await writeGenericLockDir(lockDir, { ...observed, timestamp: 2 });

		// A contender that inspected an earlier owner must not reap the successor that
		// legitimately reclaimed this path in the meantime.
		expect(await removeFileLockDirForGc(lockDir, observed)).toBe("owner_changed");
		expect(fsSync.statSync(lockDir).isDirectory()).toBe(true);
	});

	for (const { name, create, posixOnly } of [
		{
			name: "a symlink",
			create: async (lockFile: string, target: string) => {
				await fs.symlink(target, lockFile);
			},
			posixOnly: false,
		},
		{
			name: "a FIFO",
			create: async (lockFile: string) => {
				const proc = Bun.spawnSync(["mkfifo", lockFile], { stdout: "ignore", stderr: "ignore" });
				if (proc.exitCode !== 0) throw new Error("mkfifo unavailable");
			},
			posixOnly: true,
		},
	]) {
		// FIFOs do not exist on Windows (no mkfifo), so that variant is POSIX-only. The
		// descriptor-proved-regular contract it exercises stays covered on Windows by the
		// symlink variant, which runs on every platform.
		(posixOnly ? it.skipIf(process.platform === "win32") : it)(
			`fails closed on ${name} at the lock path without reading or removing it`,
			async () => {
				const { root, stateFile } = await seededRunningSession(`lock-${name.replace(/\W+/g, "-")}`);
				const lockFile = `${stateFile}.lock`;
				const target = path.join(root, "protected-target");
				await Bun.write(target, "protected");
				await create(lockFile, target);

				await expect(writeToolActivity(root, "call-1", "2026-03-01T00:00:05.000Z")).rejects.toMatchObject({
					name: "SessionStateLockUnavailableError",
					lockPath: lockFile,
					reason: "unsafe_lock_path_type",
				});
				await expect(reclaimStaleSessionStateLock(lockFile)).rejects.toBeInstanceOf(
					SessionStateLockUnavailableError,
				);

				// Neither the lock path nor whatever it points at was touched.
				expect(fsSync.lstatSync(lockFile).isFile()).toBe(false);
				expect(await Bun.file(target).text()).toBe("protected");
				expect((await readJson(stateFile)).activity).toBeUndefined();
			},
		);
	}

	/**
	 * The type decision (`lstat`) and the owner read are two syscalls on ONE pathname, and
	 * between them the path can be swapped for a shape whose bytes this code must never
	 * read by name: a symlink hands over an attacker-chosen target, a FIFO with no writer
	 * never returns. So the owner read has to happen on a descriptor that was opened
	 * no-follow and non-blocking and then PROVED regular from that same descriptor — never
	 * on the pathname the decision was made about.
	 */
	it("refuses a lock path swapped to a symlink after the type decision", async () => {
		const { root, stateFile } = await seededRunningSession("lock-swap-symlink");
		const lockFile = `${stateFile}.lock`;
		const target = path.join(root, "swap-target.json");
		// Bytes a PATH read accepts without complaint: a well-formed owner whose pid is
		// provably dead. Following the swap therefore reclaims, and unlinks, this pathname.
		await Bun.write(target, JSON.stringify({ pid: DEAD_PID, start_time: "unknown", token: "target-owner-token" }));
		await fs.writeFile(lockFile, JSON.stringify({ pid: DEAD_PID, start_time: "unknown", token: "dead-owner-token" }));

		SessionStateLockTestHooks.afterLockTypeDecision = async () => {
			SessionStateLockTestHooks.afterLockTypeDecision = undefined;
			await fs.rm(lockFile);
			await fs.symlink(target, lockFile);
		};

		const failure = await reclaimStaleSessionStateLock(lockFile).catch(error => error);
		expect(failure).toBeInstanceOf(SessionStateLockUnavailableError);
		expect(failure).toMatchObject({ lockPath: lockFile, reason: "lock_inspection_failed" });
		expect((failure as Error).message).toContain(lockFile);

		// The swapped-in link is still a link — it was never opened, read, or unlinked —
		// and the target it points at was never touched.
		expect(fsSync.lstatSync(lockFile).isSymbolicLink()).toBe(true);
		expect(JSON.parse(await fs.readFile(target, "utf8")).token).toBe("target-owner-token");
	});

	// POSIX-only: the fixture needs mkfifo (and its EOF helper needs sh), neither of which
	// exists on Windows. The same after-decision swap contract is covered on Windows by the
	// symlink variant directly above.
	it.skipIf(process.platform === "win32")(
		"refuses a lock path swapped to a FIFO after the type decision instead of blocking on it",
		async () => {
			const { stateFile } = await seededRunningSession("lock-swap-fifo");
			const lockFile = `${stateFile}.lock`;
			await fs.writeFile(
				lockFile,
				JSON.stringify({ pid: DEAD_PID, start_time: "unknown", token: "dead-owner-token" }),
			);

			SessionStateLockTestHooks.afterLockTypeDecision = async () => {
				SessionStateLockTestHooks.afterLockTypeDecision = undefined;
				await fs.rm(lockFile);
				const proc = Bun.spawnSync(["mkfifo", lockFile], { stdout: "ignore", stderr: "ignore" });
				if (proc.exitCode !== 0) throw new Error("mkfifo unavailable");
			};

			const reclaim = reclaimStaleSessionStateLock(lockFile).then(
				() => "completed" as const,
				error => (error instanceof SessionStateLockUnavailableError ? ("refused" as const) : ("faulted" as const)),
			);
			// A by-name read of a writerless FIFO never returns. Bound the observation so the
			// defect is a deterministic failed expectation rather than a hung suite.
			const outcome = await Promise.race([reclaim, Bun.sleep(1_500).then(() => "blocked" as const)]);
			// Hand a blocked reader its EOF, if one was left behind, so the suite can still exit.
			if (outcome === "blocked") Bun.spawnSync(["sh", "-c", `: > ${JSON.stringify(lockFile)}`]);

			expect(outcome).toBe("refused");
			expect(fsSync.lstatSync(lockFile).isFIFO()).toBe(true);
		},
	);

	/**
	 * A pathname transition claim keeps CURRENT writers of this protocol out of the window.
	 * It cannot keep out a base or legacy writer, which never takes the claim at all and
	 * simply creates the path. Only an identity-bound delete — one that refuses unless the
	 * object still IS the record that was judged — survives that, so each of the three
	 * removals below is proved against a successor that appears in its final window.
	 */
	it("leaves a base successor that replaced the stale state record inside the removal window", async () => {
		const { stateFile } = await seededRunningSession("lock-state-exact-cas");
		const lockFile = `${stateFile}.lock`;
		await fs.writeFile(lockFile, JSON.stringify({ pid: DEAD_PID, start_time: "unknown", token: "dead-owner-token" }));

		const successor = JSON.stringify({
			pid: process.pid,
			start_time: processStartTime(process.pid) ?? "unknown",
			token: "base-successor-token",
		});
		let replaced = false;
		// The identity has just been re-proved and the delete has not happened. A base
		// writer takes the pathname here without ever seeing the transition claim.
		SessionStateLockTestHooks.beforeStaleRemoval = async () => {
			replaced = true;
			await fs.rm(lockFile);
			await fs.writeFile(lockFile, successor);
		};

		await reclaimStaleSessionStateLock(lockFile);

		expect(replaced).toBe(true);
		expect(await fs.readFile(lockFile, "utf8")).toBe(successor);

		// And the successor is respected as a LIVE lock: nothing enters behind it.
		const entered: string[] = [];
		const contender = withSessionStateFileLock(stateFile, async () => {
			entered.push("entered");
		});
		await Promise.race([contender, Bun.sleep(200)]);
		expect(entered).toEqual([]);

		await fs.rm(lockFile);
		await contender;
		expect(entered).toEqual(["entered"]);
	});

	it("leaves a successor that replaced the stale transition record inside its removal window", async () => {
		const { stateFile } = await seededRunningSession("lock-transition-exact-cas");
		const lockFile = `${stateFile}.lock`;
		// The claim is its own regular owner record, reclaimed by the same exact-identity
		// rule as the state record it guards — not by an ownerless directory protocol.
		const transitionFile = `${lockFile}.transition`;
		await fs.writeFile(
			transitionFile,
			JSON.stringify({ pid: DEAD_PID, start_time: "unknown", token: "dead-transition-token" }),
		);

		const successor = JSON.stringify({
			pid: process.pid,
			start_time: processStartTime(process.pid) ?? "unknown",
			token: "transition-successor-token",
		});
		let replaced = false;
		SessionStateLockTestHooks.beforeTransitionStaleRemoval = async () => {
			replaced = true;
			await fs.rm(transitionFile);
			await fs.writeFile(transitionFile, successor);
		};

		const entered: string[] = [];
		const contender = withSessionStateFileLock(stateFile, async () => {
			entered.push("entered");
		});
		await Promise.race([contender, Bun.sleep(300)]);

		expect(replaced).toBe(true);
		expect(await fs.readFile(transitionFile, "utf8")).toBe(successor);
		// A live claim holder means no transition ran, so no state lock was taken either.
		expect(entered).toEqual([]);

		await fs.rm(transitionFile);
		await contender;
		expect(entered).toEqual(["entered"]);
	});

	/**
	 * A write that fails after the exclusive create leaves a partial record its own writer
	 * must retract. What authorizes that retraction is the writer's OWN open file — never
	 * whatever the PATHNAME happens to name once the cleanup finally runs.
	 *
	 * Between the fault and the catch, the record can be stale-reclaimed and the freed
	 * pathname taken by a successor. Capturing "whatever is there now" and handing it to
	 * the identity-bound unlink deletes that successor's live lock, and the
	 * compare-and-delete cannot object: the capture and the authorization are the same
	 * foreign object. Holding the created descriptor open through the cleanup is what makes
	 * the proof sound — the created inode cannot be recycled underneath a successor while
	 * this process still has it open.
	 */
	for (const target of ["state", "transition"] as const) {
		it(`leaves a successor that took the ${target} owner path while a failed writer was cleaning up`, async () => {
			const { stateFile } = await seededRunningSession(`lock-write-failure-${target}`);
			const lockFile = `${stateFile}.lock`;
			const ownerFile = target === "state" ? lockFile : `${lockFile}.transition.owner`;
			const successor = JSON.stringify({
				pid: process.pid,
				start_time: processStartTime(process.pid) ?? "unknown",
				token: `${target}-write-failure-successor-token`,
			});

			let faulted = false;
			SessionStateLockTestHooks.ownerRecordWriteFault = async file => {
				if (file !== ownerFile) return;
				SessionStateLockTestHooks.ownerRecordWriteFault = undefined;
				faulted = true;
				// The record this writer created, half written.
				await fs.writeFile(file, '{"pid":');
				// A stale reclaim frees the pathname, and a successor claims it — both
				// before the failed writer's catch cleanup gets to run.
				await fs.rm(file);
				await fs.writeFile(file, successor);
				throw new Error("simulated owner record write fault");
			};

			await expect(withSessionStateFileLock(stateFile, async () => "entered")).rejects.toBeInstanceOf(
				SessionStateLockUnavailableError,
			);

			expect(faulted).toBe(true);
			// The successor's record — its own inode and its own token — is untouched.
			expect(await fs.readFile(ownerFile, "utf8")).toBe(successor);

			// And it still holds real authority: nothing enters behind it until it is gone.
			const entered: string[] = [];
			const contender = withSessionStateFileLock(stateFile, async () => {
				entered.push("entered");
			});
			await Promise.race([contender, Bun.sleep(200)]);
			expect(entered).toEqual([]);

			await fs.rm(ownerFile);
			await contender;
			expect(entered).toEqual(["entered"]);
		});
	}

	/**
	 * The other side of that refusal: when the pathname still names the writer's own
	 * record, the retraction must actually happen. A half-written record left behind would
	 * strand the pathname until the stale window elapsed, which is the cost that makes
	 * "refuse unless proven" worth paying rather than an excuse to never clean up.
	 */
	it("retracts its own half-written record when the pathname still names it", async () => {
		const { stateFile } = await seededRunningSession("lock-write-failure-retract");
		const lockFile = `${stateFile}.lock`;

		let faulted = false;
		SessionStateLockTestHooks.ownerRecordWriteFault = async file => {
			if (file !== lockFile) return;
			SessionStateLockTestHooks.ownerRecordWriteFault = undefined;
			faulted = true;
			// Written through the pathname, so the inode is still the one this writer
			// created — the record is partial, not foreign.
			await fs.writeFile(file, '{"pid":');
			throw new Error("simulated owner record write fault");
		};

		await expect(withSessionStateFileLock(stateFile, async () => "entered")).rejects.toBeInstanceOf(
			SessionStateLockUnavailableError,
		);

		expect(faulted).toBe(true);
		expect(fsSync.existsSync(lockFile)).toBe(false);
		// The pathname is immediately usable again, with no stale window to wait out.
		expect(await withSessionStateFileLock(stateFile, async () => "entered")).toBe("entered");
	});

	/**
	 * Windows cannot run the identity-bound delete while the create descriptor is still
	 * open (the descriptor grants no share-delete), so the retract path there closes the
	 * descriptor first and lets the compare-and-delete re-prove the full recorded identity
	 * at delete time. Forcing the windows-validated strategy proves that ordering on
	 * whatever filesystem this suite runs on: the record is still retracted, and a
	 * successor in the window is still refused rather than deleted.
	 */
	it("retracts its own half-written record under the windows-validated strategy", async () => {
		SessionStateLockTestHooks.ownerAccessStrategy = "windows-validated";
		const { stateFile } = await seededRunningSession("lock-write-failure-retract-windows");
		const lockFile = `${stateFile}.lock`;

		let faulted = false;
		SessionStateLockTestHooks.ownerRecordWriteFault = async file => {
			if (file !== lockFile) return;
			SessionStateLockTestHooks.ownerRecordWriteFault = undefined;
			faulted = true;
			// Written through the pathname, so the object is still the one this writer
			// created — the record is partial, not foreign.
			await fs.writeFile(file, '{"pid":');
			throw new Error("simulated owner record write fault");
		};

		await expect(withSessionStateFileLock(stateFile, async () => "entered")).rejects.toBeInstanceOf(
			SessionStateLockUnavailableError,
		);

		expect(faulted).toBe(true);
		expect(fsSync.existsSync(lockFile)).toBe(false);
		// The pathname is immediately usable again, with no stale window to wait out.
		expect(await withSessionStateFileLock(stateFile, async () => "entered")).toBe("entered");
	});

	it("leaves a successor that took the owner path while a failed writer was cleaning up under the windows-validated strategy", async () => {
		SessionStateLockTestHooks.ownerAccessStrategy = "windows-validated";
		const { stateFile } = await seededRunningSession("lock-write-failure-successor-windows");
		const lockFile = `${stateFile}.lock`;
		const successor = JSON.stringify({
			pid: process.pid,
			start_time: processStartTime(process.pid) ?? "unknown",
			token: "windows-write-failure-successor-token",
		});

		let faulted = false;
		SessionStateLockTestHooks.ownerRecordWriteFault = async file => {
			if (file !== lockFile) return;
			SessionStateLockTestHooks.ownerRecordWriteFault = undefined;
			faulted = true;
			// The record this writer created, half written; then a stale reclaim frees the
			// pathname and a successor claims it before the failed writer's cleanup runs.
			await fs.writeFile(file, '{"pid":');
			await fs.rm(file);
			await fs.writeFile(file, successor);
			throw new Error("simulated owner record write fault");
		};

		await expect(withSessionStateFileLock(stateFile, async () => "entered")).rejects.toBeInstanceOf(
			SessionStateLockUnavailableError,
		);

		expect(faulted).toBe(true);
		// The successor's record — its own object and its own token — is untouched.
		expect(await fs.readFile(lockFile, "utf8")).toBe(successor);

		// And it still holds real authority: nothing enters behind it until it is gone.
		const entered: string[] = [];
		const contender = withSessionStateFileLock(stateFile, async () => {
			entered.push("entered");
		});
		await Promise.race([contender, Bun.sleep(200)]);
		expect(entered).toEqual([]);

		await fs.rm(lockFile);
		await contender;
		expect(entered).toEqual(["entered"]);
	});

	it("preserves an owner-write failure when exact retraction also fails", async () => {
		const { stateFile } = await seededRunningSession("lock-write-primary-error");
		const primary = new Error("primary owner write failure");
		const cleanup = new Error("owner retraction failure");
		SessionStateLockTestHooks.ownerRecordWriteFault = () => {
			throw primary;
		};
		setSessionStateLockNativeBindings(() => ({
			exactUnlinkDirect: () => ({ ok: false, code: "not_found" }),
			exactUnlink() {
				throw cleanup;
			},
			snapshotDirectoryTree() {
				throw new Error("unexpected directory snapshot");
			},
			exactRemoveDirectoryTree() {
				throw new Error("unexpected directory removal");
			},
		}));

		const observed = await withSessionStateFileLock(stateFile, async () => "unreachable").catch(error => error);
		expect(observed).toBeInstanceOf(SessionStateLockUnavailableError);
		const aggregate = (observed as Error & { cause?: unknown }).cause;
		expect(aggregate).toBeInstanceOf(AggregateError);
		const [preservedPrimary, preservedCleanup] = (aggregate as AggregateError).errors;
		expect(preservedPrimary).toBe(primary);
		expect(preservedCleanup).toBeInstanceOf(SessionStateLockUnavailableError);
		expect((preservedCleanup as Error & { cause?: unknown }).cause).toBe(cleanup);
	});

	it("preserves an operation failure when owner release also fails", async () => {
		const { stateFile } = await seededRunningSession("lock-operation-primary-error");
		const lockFile = `${stateFile}.lock`;
		const primary = new Error("primary state operation failure");
		const release = new Error("owner release failure");
		SessionStateLockTestHooks.beforeCurrentOwnerRelease = target => {
			if (target === lockFile) throw release;
		};

		const observed = await withSessionStateFileLock(stateFile, () => {
			throw primary;
		}).catch(error => error);
		expect(observed).toBeInstanceOf(AggregateError);
		const [preservedPrimary, preservedRelease] = (observed as AggregateError).errors;
		expect(preservedPrimary).toBe(primary);
		expect(preservedRelease).toBeInstanceOf(SessionStateLockUnavailableError);
		expect((preservedRelease as Error & { cause?: unknown }).cause).toBe(release);
	});

	it("releases live owner records without the renameat2-based exact unlink primitive", async () => {
		const { stateFile } = await seededRunningSession("lock-live-owner-portable-release");
		const lockFile = `${stateFile}.lock`;
		let exactUnlinkCalls = 0;
		const releasedHostIds: string[] = [];
		SessionStateLockTestHooks.ownerHostId = () => "local-host";
		SessionStateLockTestHooks.beforeCurrentOwnerRelease = async target => {
			const owner = JSON.parse(await fs.readFile(target, "utf8")) as { owner_host_id?: string };
			if (owner.owner_host_id) releasedHostIds.push(owner.owner_host_id);
		};
		setSessionStateLockNativeBindings(() => ({
			exactUnlinkDirect: () => ({ ok: false, code: "not_found" }),
			exactUnlink() {
				exactUnlinkCalls++;
				return { ok: false, code: "cleanup_failed", retainedUnknownPath: `${lockFile}.quarantine` };
			},
			snapshotDirectoryTree() {
				throw new Error("unexpected directory snapshot");
			},
			exactRemoveDirectoryTree() {
				throw new Error("unexpected directory removal");
			},
		}));

		await expect(withSessionStateFileLock(stateFile, async () => "entered")).resolves.toBe("entered");
		expect(exactUnlinkCalls).toBe(0);
		expect(releasedHostIds).toEqual(["local-host", "local-host", "local-host"]);
		await expectReleasedOwner(lockFile);
		expectReleasedTransition(lockFile);
		await expect(fs.open(lockFile, "wx")).rejects.toMatchObject({ code: "EEXIST" });
		await expect(withSessionStateFileLock(stateFile, async () => "reused")).resolves.toBe("reused");
	});

	it("serializes concurrent writers that reuse the same released state tombstone", async () => {
		const { stateFile } = await seededRunningSession("lock-released-tombstone-contention");
		await withSessionStateFileLock(stateFile, async () => undefined);
		const firstEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const order: string[] = [];
		const first = withSessionStateFileLock(stateFile, async () => {
			order.push("first-entered");
			firstEntered.resolve();
			await releaseFirst.promise;
			order.push("first-released");
		});
		await firstEntered.promise;
		const second = withSessionStateFileLock(stateFile, async () => {
			order.push("second-entered");
		});
		await Bun.sleep(100);
		expect(order).toEqual(["first-entered"]);
		releaseFirst.resolve();
		await Promise.all([first, second]);
		expect(order).toEqual(["first-entered", "first-released", "second-entered"]);
	});

	it("serializes cross-process writers that reuse a released state tombstone", async () => {
		const { root, stateFile } = await seededRunningSession("lock-cross-process-tombstone-contention");
		await withSessionStateFileLock(stateFile, async () => undefined);
		const readyFile = path.join(root, "holder-ready");
		const releaseFile = path.join(root, "holder-release");
		const enteredFile = path.join(root, "contender-entered");
		const lockModule = path.resolve("packages/coding-agent/src/gjc-runtime/session-state-lock.ts");
		const holderScript = `
			import { withSessionStateFileLock } from ${JSON.stringify(lockModule)};
			const [stateFile, readyFile, releaseFile] = Bun.argv.slice(-3);
			await withSessionStateFileLock(stateFile, async () => {
				await Bun.write(readyFile, "ready");
				while (!(await Bun.file(releaseFile).exists())) await Bun.sleep(10);
			});
		`;
		const contenderScript = `
			import { withSessionStateFileLock } from ${JSON.stringify(lockModule)};
			const [stateFile, enteredFile] = Bun.argv.slice(-2);
			await withSessionStateFileLock(stateFile, async () => await Bun.write(enteredFile, "entered"));
		`;
		const holder = Bun.spawn([process.execPath, "-e", holderScript, stateFile, readyFile, releaseFile], {
			stdout: "pipe",
			stderr: "pipe",
		});
		while (!(await Bun.file(readyFile).exists())) await Bun.sleep(10);
		const contender = Bun.spawn([process.execPath, "-e", contenderScript, stateFile, enteredFile], {
			stdout: "pipe",
			stderr: "pipe",
		});
		await Bun.sleep(200);
		expect(await Bun.file(enteredFile).exists()).toBe(false);
		await Bun.write(releaseFile, "release");
		const [holderExit, contenderExit] = await Promise.all([holder.exited, contender.exited]);
		expect(holderExit).toBe(0);
		expect(contenderExit).toBe(0);
		expect(await Bun.file(enteredFile).text()).toBe("entered");
	});

	it("reclaims a dead atomic transition directory through identity-bound removal", async () => {
		const { stateFile } = await seededRunningSession("lock-dead-atomic-transition");
		const lockFile = `${stateFile}.lock`;
		const transitionDir = `${lockFile}.transition`;
		const ownerFile = `${transitionDir}.owner`;
		await fs.mkdir(transitionDir);
		await fs.writeFile(
			ownerFile,
			JSON.stringify({
				pid: DEAD_PID,
				start_time: "unknown",
				token: "dead-atomic-transition",
				owner_host_id: "local-host",
			}),
		);
		let directoryRemovals = 0;
		let ownerUnlinks = 0;
		setSessionStateLockNativeBindings(() => ({
			...exactIdentityNativeBindings,
			exactUnlink(target, identity) {
				ownerUnlinks++;
				return exactIdentityNativeBindings.exactUnlink(target, identity);
			},
			exactRemoveDirectoryTree(target, snapshot) {
				directoryRemovals++;
				return exactIdentityNativeBindings.exactRemoveDirectoryTree(target, snapshot);
			},
		}));

		const entered: string[] = [];
		await withSessionStateFileLock(stateFile, async () => {
			entered.push("entered");
		});
		expect(entered).toEqual(["entered"]);
		expect(directoryRemovals).toBe(1);
		expect(ownerUnlinks).toBeGreaterThanOrEqual(1);
		expect(fsSync.existsSync(transitionDir)).toBe(false);
		// The dead record was replaced by this process's own claim cycle; only its
		// released tombstone may remain.
		expect(await fs.readFile(ownerFile, "utf8")).not.toContain("dead-atomic-transition");
	});

	it("fails closed on an atomic transition directory whose owner is alive", async () => {
		const { stateFile } = await seededRunningSession("lock-live-atomic-transition");
		const lockFile = `${stateFile}.lock`;
		const transitionDir = `${lockFile}.transition`;
		const ownerFile = `${transitionDir}.owner`;
		await fs.mkdir(transitionDir);
		await fs.writeFile(
			ownerFile,
			JSON.stringify({
				pid: process.pid,
				start_time: processStartTime(process.pid) ?? "unknown",
				token: "live-atomic-transition",
				owner_host_id: "local-host",
			}),
		);
		setSessionStateLockNativeBindings(() => ({
			...exactIdentityNativeBindings,
			snapshotDirectoryTree() {
				throw new Error("unexpected directory snapshot");
			},
			exactRemoveDirectoryTree() {
				throw new Error("unexpected directory removal");
			},
		}));

		const entered: string[] = [];
		const contender = withSessionStateFileLock(stateFile, async () => {
			entered.push("entered");
		});
		await Bun.sleep(300);
		expect(entered).toEqual([]);
		expect(fsSync.statSync(transitionDir).isDirectory()).toBe(true);
		expect(await fs.readFile(ownerFile, "utf8")).toContain("live-atomic-transition");
		await fs.rm(ownerFile);
		await fs.rmdir(transitionDir);
		await contender;
		expect(entered).toEqual(["entered"]);
	});

	it("fails closed on a malformed atomic transition directory owner", async () => {
		const { stateFile } = await seededRunningSession("lock-malformed-atomic-transition");
		const transitionDir = `${stateFile}.lock.transition`;
		const ownerFile = `${transitionDir}.owner`;
		const record = "not-json";
		await fs.mkdir(transitionDir);
		await fs.writeFile(ownerFile, record);

		const entered: string[] = [];
		const contender = withSessionStateFileLock(stateFile, async () => {
			entered.push("entered");
		});
		await Promise.race([contender, Bun.sleep(300)]);

		expect(fsSync.statSync(transitionDir).isDirectory()).toBe(true);
		expect(await fs.readFile(ownerFile, "utf8")).toBe(record);
		expect(entered).toEqual([]);
		await fs.rm(ownerFile);
		await fs.rmdir(transitionDir);
		await contender;
		expect(entered).toEqual(["entered"]);
	});

	it("fails closed on a foreign-host atomic transition directory owner", async () => {
		const { stateFile } = await seededRunningSession("lock-foreign-atomic-transition");
		const transitionDir = `${stateFile}.lock.transition`;
		const ownerFile = `${transitionDir}.owner`;
		const record = JSON.stringify({
			pid: DEAD_PID,
			start_time: "unknown",
			token: "foreign-atomic-transition",
			owner_host_id: "remote-host",
		});
		await fs.mkdir(transitionDir);
		await fs.writeFile(ownerFile, record);

		const entered: string[] = [];
		const contender = withSessionStateFileLock(stateFile, async () => {
			entered.push("entered");
		});
		await Promise.race([contender, Bun.sleep(300)]);

		expect(await fs.readFile(ownerFile, "utf8")).toBe(record);
		expect(entered).toEqual([]);
		await fs.rm(ownerFile);
		await fs.rmdir(transitionDir);
		await contender;
		expect(entered).toEqual(["entered"]);
	});

	it("reclaims an atomic transition directory whose live pid has a reused incarnation", async () => {
		const { stateFile } = await seededRunningSession("lock-reused-pid-atomic-transition");
		const lockFile = `${stateFile}.lock`;
		const transitionDir = `${lockFile}.transition`;
		const ownerFile = `${transitionDir}.owner`;
		await fs.mkdir(transitionDir);
		await fs.writeFile(
			ownerFile,
			JSON.stringify({
				pid: process.pid,
				start_time: "Thu Jan  1 00:00:00 1970",
				start_time_format: "ps-utc-v1",
				token: "reused-pid-atomic-transition",
				owner_host_id: "local-host",
			}),
		);
		SessionStateLockTestHooks.probeProcessSignal = () => {
			throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
		};

		const entered: string[] = [];
		await withSessionStateFileLock(stateFile, async () => {
			entered.push("entered");
		});

		expect(entered).toEqual(["entered"]);
		expect(fsSync.existsSync(transitionDir)).toBe(false);
		expect(await fs.readFile(ownerFile, "utf8")).not.toContain("reused-pid-atomic-transition");
	});

	it("serializes two contenders that race through dead atomic transition reclaim", async () => {
		const { stateFile } = await seededRunningSession("lock-racing-dead-atomic-transition");
		const transitionDir = `${stateFile}.lock.transition`;
		await fs.mkdir(transitionDir);
		await fs.writeFile(
			`${transitionDir}.owner`,
			JSON.stringify({
				pid: DEAD_PID,
				start_time: "unknown",
				token: "racing-dead-atomic-transition",
				owner_host_id: "local-host",
			}),
		);

		let inspections = 0;
		const bothInspected = Promise.withResolvers<void>();
		const releaseInspection = Promise.withResolvers<void>();
		SessionStateLockTestHooks.afterTransitionStaleInspection = async target => {
			if (target !== transitionDir) return;
			inspections++;
			if (inspections === 2) bothInspected.resolve();
			if (inspections <= 2) await releaseInspection.promise;
		};

		let active = 0;
		let maximumActive = 0;
		const entered: string[] = [];
		const first = withSessionStateFileLock(stateFile, async () => {
			active++;
			maximumActive = Math.max(maximumActive, active);
			entered.push("first");
			await Bun.sleep(40);
			active--;
		});
		const second = withSessionStateFileLock(stateFile, async () => {
			active++;
			maximumActive = Math.max(maximumActive, active);
			entered.push("second");
			await Bun.sleep(40);
			active--;
		});

		await bothInspected.promise;
		expect(entered).toEqual([]);
		releaseInspection.resolve();
		await Promise.all([first, second]);

		expect(entered).toHaveLength(2);
		expect(maximumActive).toBe(1);
		expect(fsSync.existsSync(transitionDir)).toBe(false);
	});

	for (const target of ["state", "transition"] as const) {
		it(`leaves a legacy successor that replaces the ${target} owner after final validation`, async () => {
			const { stateFile } = await seededRunningSession(`lock-live-${target}-final-successor`);
			const lockFile = `${stateFile}.lock`;
			const ownerFile = target === "state" ? lockFile : `${lockFile}.transition.owner`;
			const successor = JSON.stringify({
				pid: process.pid,
				start_time: processStartTime(process.pid) ?? "unknown",
				token: `legacy-${target}-successor`,
			});
			SessionStateLockTestHooks.afterCurrentOwnerValidation = async file => {
				if (file !== ownerFile) return;
				SessionStateLockTestHooks.afterCurrentOwnerValidation = undefined;
				await fs.rm(file);
				await fs.writeFile(file, successor);
			};

			await expect(withSessionStateFileLock(stateFile, async () => "entered")).rejects.toBeInstanceOf(
				SessionStateLockUnavailableError,
			);
			expect(await fs.readFile(ownerFile, "utf8")).toBe(successor);
		});
	}

	for (const target of ["state", "transition"] as const) {
		it(`preserves a stale ${target} owner when Ceph rejects exact cleanup`, async () => {
			const { stateFile } = await seededRunningSession(`lock-ceph-stale-${target}`);
			const lockFile = `${stateFile}.lock`;
			const ownerFile = target === "state" ? lockFile : `${lockFile}.transition`;
			const record = JSON.stringify({
				pid: DEAD_PID,
				start_time: "unknown",
				token: `ceph-stale-${target}`,
				owner_host_id: "local-host",
			});
			await fs.writeFile(ownerFile, record);
			setSessionStateLockNativeBindings(() => ({
				exactUnlinkDirect: () => ({ ok: false, code: "not_found" }),
				exactUnlink() {
					return { ok: false, code: "cleanup_failed", retainedUnknownPath: `${ownerFile}.quarantine` };
				},
				snapshotDirectoryTree() {
					throw new Error("unexpected directory snapshot");
				},
				exactRemoveDirectoryTree() {
					throw new Error("unexpected directory removal");
				},
			}));

			const attempt =
				target === "state"
					? reclaimStaleSessionStateLock(lockFile)
					: withSessionStateFileLock(stateFile, async () => "entered");
			await expect(attempt).rejects.toBeInstanceOf(SessionStateLockUnavailableError);
			expect(await fs.readFile(ownerFile, "utf8")).toBe(record);
		});
	}

	it("never reclaims a foreign-host owner from a host-local ESRCH verdict", async () => {
		const { stateFile } = await seededRunningSession("lock-foreign-host-owner");
		const lockFile = `${stateFile}.lock`;
		const record = JSON.stringify({
			pid: DEAD_PID,
			start_time: "remote-start",
			token: "foreign-owner-token",
			owner_host_id: "remote-host",
		});
		await fs.writeFile(lockFile, record);
		SessionStateLockTestHooks.ownerHostId = () => "local-host";
		SessionStateLockTestHooks.probeProcessSignal = () => {
			throw Object.assign(new Error("missing"), { code: "ESRCH" });
		};

		await reclaimStaleSessionStateLock(lockFile);

		expect(await fs.readFile(lockFile, "utf8")).toBe(record);
	});

	it("reclaims a dead owner written with the previous same-host identity", async () => {
		const { stateFile } = await seededRunningSession("lock-previous-host-owner");
		const lockFile = `${stateFile}.lock`;
		await fs.writeFile(
			lockFile,
			JSON.stringify({
				pid: DEAD_PID,
				start_time: "previous-owner-start",
				token: "previous-owner-token",
				owner_host_id: "previous-local-host",
			}),
		);
		SessionStateLockTestHooks.ownerHostId = () => "local-host";
		SessionStateLockTestHooks.legacyOwnerHostId = () => "previous-local-host";
		SessionStateLockTestHooks.probeProcessSignal = () => {
			throw Object.assign(new Error("missing"), { code: "ESRCH" });
		};

		await reclaimStaleSessionStateLock(lockFile);

		expect(fsSync.existsSync(lockFile)).toBe(false);
	});

	it("fails closed for an unqualified regular owner on a shared volume", async () => {
		const { stateFile } = await seededRunningSession("lock-unqualified-owner");
		const lockFile = `${stateFile}.lock`;
		const record = JSON.stringify({ pid: DEAD_PID, start_time: "unknown", token: "unqualified-owner" });
		await fs.writeFile(lockFile, record);
		SessionStateLockTestHooks.unqualifiedOwnerIsLocal = false;
		SessionStateLockTestHooks.probeProcessSignal = () => {
			throw Object.assign(new Error("missing"), { code: "ESRCH" });
		};

		await reclaimStaleSessionStateLock(lockFile);

		expect(await fs.readFile(lockFile, "utf8")).toBe(record);
	});

	it("fails closed for a stale malformed regular owner on a shared volume", async () => {
		const { stateFile } = await seededRunningSession("lock-malformed-shared-owner");
		const lockFile = `${stateFile}.lock`;
		await fs.writeFile(lockFile, `{"pid":${DEAD_PID},"owner_host_id":"remote-host"`);
		const stale = new Date(Date.now() - 60_000);
		await fs.utimes(lockFile, stale, stale);
		SessionStateLockTestHooks.unqualifiedOwnerIsLocal = false;

		await reclaimStaleSessionStateLock(lockFile);

		expect(await fs.readFile(lockFile, "utf8")).toBe(`{"pid":${DEAD_PID},"owner_host_id":"remote-host"`);
	});

	it("preserves the exact lock path and typed reason in the resume-facing diagnostic", async () => {
		const { root, stateFile } = await seededRunningSession("lock-unprovenanced-diagnostic");
		const lockFile = `${stateFile}.lock`;
		await fs.writeFile(
			lockFile,
			JSON.stringify({
				pid: DEAD_PID,
				start_time: "unknown",
				token: "foreign-malformed-owner",
				owner_host_id: "remote-host",
				released: false,
			}),
		);
		const stale = new Date(Date.now() - 60_000);
		await fs.utimes(lockFile, stale, stale);
		SessionStateLockTestHooks.unqualifiedOwnerIsLocal = false;

		const failure = await writeToolActivity(root, "call-1", "2026-03-01T00:00:05.000Z").catch(error => error);

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain(lockFile);
		expect((failure as Error).message).toContain("lock_owner_record_unprovenanced");
		expect(await fs.readFile(lockFile, "utf8")).toContain("foreign-malformed-owner");
	});

	it("fails closed for an unqualified transition claim on a shared volume", async () => {
		const { stateFile } = await seededRunningSession("lock-unqualified-transition");
		const transitionFile = `${stateFile}.lock.transition`;
		const record = JSON.stringify({ pid: DEAD_PID, start_time: "unknown", token: "unqualified-transition" });
		await fs.writeFile(transitionFile, record);
		SessionStateLockTestHooks.unqualifiedOwnerIsLocal = false;

		const entered: string[] = [];
		const contender = withSessionStateFileLock(stateFile, async () => {
			entered.push("entered");
		});
		await Promise.race([contender, Bun.sleep(300)]);

		expect(await fs.readFile(transitionFile, "utf8")).toBe(record);
		expect(entered).toEqual([]);
		await fs.rm(transitionFile);
		await contender;
		expect(entered).toEqual(["entered"]);
	});

	it("fails closed for a stale malformed transition claim on a shared volume", async () => {
		const { stateFile } = await seededRunningSession("lock-malformed-shared-transition");
		const transitionFile = `${stateFile}.lock.transition`;
		const record = `{"pid":${DEAD_PID},"owner_host_id":"remote-host"`;
		await fs.writeFile(transitionFile, record);
		const stale = new Date(Date.now() - 60_000);
		await fs.utimes(transitionFile, stale, stale);
		SessionStateLockTestHooks.unqualifiedOwnerIsLocal = false;

		const entered: string[] = [];
		const contender = withSessionStateFileLock(stateFile, async () => {
			entered.push("entered");
		});
		await Promise.race([contender, Bun.sleep(300)]);

		expect(await fs.readFile(transitionFile, "utf8")).toBe(record);
		expect(entered).toEqual([]);
		await fs.rm(transitionFile);
		await contender;
		expect(entered).toEqual(["entered"]);
	});

	it("fails closed for an unqualified legacy directory owner on a shared volume", async () => {
		const { stateFile } = await seededRunningSession("lock-unqualified-directory");
		const lockFile = `${stateFile}.lock`;
		await writeGenericLockDir(lockFile, { pid: DEAD_PID, start_time: "unknown", timestamp: Date.now() - 60_000 });
		SessionStateLockTestHooks.unqualifiedOwnerIsLocal = false;

		await reclaimStaleSessionStateLock(lockFile);

		expect(fsSync.statSync(lockFile).isDirectory()).toBe(true);
	});

	it("creates no owner record when machine identity is unavailable", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "lock-host-identity-unavailable.json");
		const identityFailure = new Error("machine identity unavailable");
		SessionStateLockTestHooks.ownerHostId = async () => {
			throw identityFailure;
		};

		const failure = await withSessionStateFileLock(stateFile, async () => "entered").catch(error => error);
		expect(failure).toBeInstanceOf(SessionStateLockUnavailableError);
		expect(failure).toMatchObject({
			lockPath: `${stateFile}.lock`,
			reason: "lock_initialization_failed",
		});
		expect((failure as SessionStateLockUnavailableError).cause).toBe(identityFailure);
		expect(fsSync.existsSync(`${stateFile}.lock`)).toBe(false);
		expect(fsSync.existsSync(`${stateFile}.lock.transition`)).toBe(false);
	});

	it("names the exact lock path when the state parent cannot be created", async () => {
		const root = await tempRoot();
		const blockedParent = path.join(root, "not-a-directory");
		await fs.writeFile(blockedParent, "occupied");
		const stateFile = path.join(blockedParent, "runtime-state.json");

		const failure = await withSessionStateFileLock(stateFile, async () => "entered").catch(error => error);

		expect(failure).toBeInstanceOf(SessionStateLockUnavailableError);
		expect(failure).toMatchObject({
			lockPath: `${stateFile}.lock`,
			reason: "lock_initialization_failed",
		});
		expect((failure as Error).message).toContain(`${stateFile}.lock`);
		expect((failure as SessionStateLockUnavailableError).cause).toMatchObject({
			code: "ENOTDIR",
			path: blockedParent,
		});
		expect(await fs.readFile(blockedParent, "utf8")).toBe("occupied");
	});

	it("retries machine identity loading after a transient failure", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "lock-host-identity-retry.json");
		SessionStateLockTestHooks.ownerHostId = undefined;
		let attempts = 0;
		SessionStateLockTestHooks.loadInstallationHostId = async () => {
			attempts++;
			if (attempts === 1) throw new Error("transient identity read failure");
			return "local-host";
		};

		await expect(withSessionStateFileLock(stateFile, async () => "entered")).rejects.toBeInstanceOf(
			SessionStateLockUnavailableError,
		);
		expect(await withSessionStateFileLock(stateFile, async () => "entered")).toBe("entered");
		expect(attempts).toBe(2);
	});

	it("refuses to unlink a successor that replaces a live owner record before release", async () => {
		const { stateFile } = await seededRunningSession("lock-live-owner-successor");
		const lockFile = `${stateFile}.lock`;
		const successor = JSON.stringify({
			pid: process.pid,
			start_time: processStartTime(process.pid) ?? "unknown",
			token: "live-owner-successor-token",
		});
		SessionStateLockTestHooks.beforeCurrentOwnerRelease = async target => {
			if (target !== lockFile) return;
			SessionStateLockTestHooks.beforeCurrentOwnerRelease = undefined;
			await fs.rm(target);
			await fs.writeFile(target, successor);
		};

		await expect(withSessionStateFileLock(stateFile, async () => "entered")).rejects.toBeInstanceOf(
			SessionStateLockUnavailableError,
		);
		expect(await fs.readFile(lockFile, "utf8")).toBe(successor);
	});

	it("releases the owner record after a synchronous operation throw", async () => {
		const { stateFile } = await seededRunningSession("lock-operation-sync-throw");
		const lockFile = `${stateFile}.lock`;
		const primary = new Error("synchronous state operation failure");

		const observed = await withSessionStateFileLock(stateFile, () => {
			throw primary;
		}).catch(error => error);

		expect(observed).toBe(primary);
		await expectReleasedOwner(lockFile);
		expectReleasedTransition(lockFile);
		expect(await withSessionStateFileLock(stateFile, async () => "reacquired")).toBe("reacquired");
	});

	it("preserves a callback-owned lock error unchanged after a successful release", async () => {
		const { stateFile } = await seededRunningSession("lock-operation-lock-error");
		const lockFile = `${stateFile}.lock`;
		const primary = new SessionStateLockUnavailableError(new Error("callback-owned lock error"));

		const observed = await withSessionStateFileLock(stateFile, async () => {
			throw primary;
		}).catch(error => error);

		expect(observed).toBe(primary);
		await expectReleasedOwner(lockFile);
		expectReleasedTransition(lockFile);
	});

	it("repairs a partial primary-owner rewrite before releasing its transition claim", async () => {
		const { stateFile } = await seededRunningSession("lock-primary-rewrite-partial");
		const lockFile = `${stateFile}.lock`;
		await withSessionStateFileLock(stateFile, async () => undefined);
		let faulted = false;
		SessionStateLockTestHooks.beforeOwnerRecordRewrite = async file => {
			if (file !== lockFile || faulted) return;
			faulted = true;
			await fs.writeFile(file, '{"pid":');
			throw Object.assign(new Error("partial primary rewrite"), { code: "EIO" });
		};

		await expect(withSessionStateFileLock(stateFile, async () => "unreachable")).rejects.toBeInstanceOf(
			SessionStateLockUnavailableError,
		);
		expect(faulted).toBe(true);
		expect(fsSync.existsSync(`${lockFile}.transition`)).toBe(false);
		await expect(withSessionStateFileLock(stateFile, async () => "reacquired")).resolves.toBe("reacquired");
	});

	it("returns a successful transition result without replaying after transient claim cleanup", async () => {
		const { stateFile } = await seededRunningSession("lock-transition-release-retry");
		const transitionDir = `${stateFile}.lock.transition`;
		let denied = 5;
		let callbackCount = 0;
		const realRmdir = fs.rmdir;
		vi.spyOn(fs, "rmdir").mockImplementation((async target => {
			if (denied > 0 && String(target) === transitionDir) {
				denied--;
				throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
			}
			return await realRmdir(target);
		}) as typeof fs.rmdir);

		await expect(
			withSessionStateFileLock(stateFile, async () => {
				callbackCount++;
				return "saved-result";
			}),
		).resolves.toBe("saved-result");

		expect(callbackCount).toBe(1);
		expect(fsSync.existsSync(transitionDir)).toBe(false);
	});

	it("recovers a release when the final claim lstat faults after the tombstone rewrite", async () => {
		const { stateFile } = await seededRunningSession("lock-transition-release-lstat-fault");
		const transitionDir = `${stateFile}.lock.transition`;
		SessionStateLockTestHooks.beforeTransitionReleaseLstat = async target => {
			if (target === transitionDir) {
				SessionStateLockTestHooks.beforeTransitionReleaseLstat = undefined;
				throw Object.assign(new Error("claim lstat fault"), { code: "EIO" });
			}
		};

		let callbackCount = 0;
		await expect(
			withSessionStateFileLock(stateFile, async () => {
				callbackCount++;
				return "saved-result";
			}),
		).resolves.toBe("saved-result");

		expect(callbackCount).toBe(1);
		expect(fsSync.existsSync(transitionDir)).toBe(false);
	});

	it("uses the canonical physical transition path during pending recovery", async () => {
		const root = await tempRoot();
		const realParent = path.join(root, "real");
		const aliasParent = path.join(root, "alias");
		await fs.mkdir(realParent);
		await fs.symlink(realParent, aliasParent, "dir");
		const realStateFile = path.join(realParent, "state.json");
		const aliasStateFile = path.join(aliasParent, "state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = aliasStateFile;
		setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "turn_start" },
			{ sessionId: SESSION_ID, cwd: root, sessionFile: null },
		);

		let faulted = false;
		SessionStateLockTestHooks.beforeTransitionReleaseLstat = async target => {
			if (target === `${aliasStateFile}.lock.transition` && !faulted) {
				faulted = true;
				throw Object.assign(new Error("pending release"), { code: "EIO" });
			}
		};
		const nativeTargets: string[] = [];
		setSessionStateLockNativeBindings(() => ({
			...exactIdentityNativeBindings,
			snapshotDirectoryTree(target) {
				nativeTargets.push(target);
				return exactIdentityNativeBindings.snapshotDirectoryTree(target);
			},
			exactRemoveDirectoryTree(target, snapshot) {
				nativeTargets.push(target);
				return exactIdentityNativeBindings.exactRemoveDirectoryTree(target, snapshot);
			},
		}));

		await expect(withSessionStateFileLock(aliasStateFile, async () => "recovered")).resolves.toBe("recovered");
		expect(faulted).toBe(true);
		expect(nativeTargets.length).toBeGreaterThan(0);
		const comparablePath = (target: string): string => {
			const normalized = path.normalize(target);
			return process.platform === "win32" ? normalized.toLowerCase() : normalized;
		};
		const equivalentWindowsPath = (target: string): string => {
			if (process.platform !== "win32") return target;
			if (target.startsWith("\\\\?\\UNC\\")) return `\\\\${target.slice("\\\\?\\UNC\\".length)}`;
			return target.startsWith("\\\\?\\") ? target.slice("\\\\?\\".length) : target;
		};
		const comparableWindowsPath = (target: string): string => {
			const equivalent = equivalentWindowsPath(comparablePath(target));
			return process.platform === "win32" ? equivalent.toLowerCase() : equivalent;
		};
		const canonicalTarget = async (target: string): Promise<string> =>
			comparableWindowsPath(path.join(await fs.realpath(path.dirname(target)), path.basename(target)));
		const canonicalTargets = await Promise.all(nativeTargets.map(canonicalTarget));
		const expectedComparableTransition = await canonicalTarget(`${realStateFile}.lock.transition`);
		const comparablePhysicalRoot = comparableWindowsPath(await fs.realpath(realParent)) + path.sep;
		const comparableAliasRoot = comparableWindowsPath(aliasParent) + path.sep;
		expect(
			canonicalTargets.every(target => target === expectedComparableTransition),
			`expected=${expectedComparableTransition}\nactual=${canonicalTargets.join("\n")}`,
		).toBe(true);
		expect(canonicalTargets.every(target => target.startsWith(comparablePhysicalRoot))).toBe(true);
		expect(canonicalTargets.every(target => !target.startsWith(comparableAliasRoot))).toBe(true);
	});

	it("cleans a transition claim when setup generation lstat faults", async () => {
		const { stateFile } = await seededRunningSession("lock-transition-setup-lstat-fault");
		const transitionDir = `${stateFile}.lock.transition`;
		let faulted = false;
		SessionStateLockTestHooks.beforeTransitionSetupLstat = async target => {
			if (target === transitionDir && !faulted) {
				faulted = true;
				throw Object.assign(new Error("setup generation lstat fault"), { code: "EIO" });
			}
		};

		await expect(withSessionStateFileLock(stateFile, async () => "entered")).rejects.toBeInstanceOf(
			SessionStateLockUnavailableError,
		);
		expect(faulted).toBe(true);
		expect(fsSync.existsSync(transitionDir)).toBe(false);
		await expect(withSessionStateFileLock(stateFile, async () => "reacquired")).resolves.toBe("reacquired");
	});

	it("does not delete a successor after setup generation capture faults", async () => {
		const { stateFile } = await seededRunningSession("lock-transition-setup-successor");
		const transitionDir = `${stateFile}.lock.transition`;
		let faulted = false;
		SessionStateLockTestHooks.beforeTransitionSetupLstat = async target => {
			if (target !== transitionDir || faulted) return;
			faulted = true;
			await fs.rm(transitionDir, { recursive: true, force: true });
			await fs.mkdir(transitionDir);
			await fs.writeFile(
				`${transitionDir}.owner`,
				JSON.stringify({ pid: DEAD_PID, start_time: "unknown", token: "successor" }),
			);
			throw Object.assign(new Error("setup generation capture fault"), { code: "EIO" });
		};

		await expect(withSessionStateFileLock(stateFile, async () => "entered")).rejects.toBeInstanceOf(
			SessionStateLockUnavailableError,
		);
		expect(faulted).toBe(true);
		expect(fsSync.existsSync(transitionDir)).toBe(true);
		expect(await fs.readFile(`${transitionDir}.owner`, "utf8")).toContain("successor");
		await fs.rm(transitionDir, { recursive: true, force: true });
	});

	it("does not delete an empty successor after owner setup fails", async () => {
		const { stateFile } = await seededRunningSession("lock-transition-owner-successor");
		const transitionDir = `${stateFile}.lock.transition`;
		let faulted = false;
		SessionStateLockTestHooks.ownerRecordWriteFault = async ownerFile => {
			if (ownerFile !== `${transitionDir}.owner` || faulted) return;
			faulted = true;
			await fs.rm(transitionDir, { recursive: true, force: true });
			await fs.mkdir(transitionDir);
			const successorTime = new Date("2026-02-01T00:00:00.000Z");
			await fs.utimes(transitionDir, successorTime, successorTime);
			throw new Error("owner setup fault");
		};

		await expect(withSessionStateFileLock(stateFile, async () => "entered")).rejects.toBeInstanceOf(
			SessionStateLockUnavailableError,
		);
		expect(faulted).toBe(true);
		expect(fsSync.existsSync(transitionDir)).toBe(true);
		expect((await fs.stat(transitionDir)).isDirectory()).toBe(true);
		await fs.rm(transitionDir, { recursive: true, force: true });
	});

	it("retains the generation record when release-owner capture faults before rewrite", async () => {
		const { stateFile } = await seededRunningSession("lock-transition-release-capture-fault");
		const transitionDir = `${stateFile}.lock.transition`;
		let faulted = false;
		SessionStateLockTestHooks.afterCurrentOwnerValidation = async file => {
			if (!faulted && file === `${transitionDir}.owner`) {
				faulted = true;
				throw new Error("owner capture fault");
			}
		};

		let callbackCount = 0;
		await expect(
			withSessionStateFileLock(stateFile, async () => {
				callbackCount++;
				return "saved-result";
			}),
		).resolves.toBe("saved-result");

		expect(faulted).toBe(true);
		expect(callbackCount).toBe(1);
		expect(fsSync.existsSync(transitionDir)).toBe(false);
	});

	it("retries a pre-commit release rewrite without dropping its claim", async () => {
		const { stateFile } = await seededRunningSession("lock-transition-release-rewrite-fault");
		const transitionDir = `${stateFile}.lock.transition`;
		let faulted = false;
		SessionStateLockTestHooks.beforeOwnerRecordRewrite = async file => {
			if (!faulted && file === `${transitionDir}.owner`) {
				faulted = true;
				throw new Error("pre-commit rewrite fault");
			}
		};

		let callbackCount = 0;
		await expect(
			withSessionStateFileLock(stateFile, async () => {
				callbackCount++;
				return "saved-result";
			}),
		).resolves.toBe("saved-result");

		expect(faulted).toBe(true);
		expect(callbackCount).toBe(1);
		expect(fsSync.existsSync(transitionDir)).toBe(false);
	});

	it("cleans a malformed transition rewrite only when it is still the held inode", async () => {
		const { stateFile } = await seededRunningSession("lock-transition-malformed-rewrite-fault");
		const transitionDir = `${stateFile}.lock.transition`;
		const ownerFile = `${transitionDir}.owner`;
		let faulted = false;
		SessionStateLockTestHooks.beforeOwnerRecordRewrite = async file => {
			if (!faulted && file === ownerFile) {
				faulted = true;
				await fs.writeFile(file, '{"released":');
				throw new Error("partial rewrite fault");
			}
		};

		await expect(withSessionStateFileLock(stateFile, async () => "entered")).resolves.toBe("entered");
		expect(faulted).toBe(true);
		expect(fsSync.existsSync(transitionDir)).toBe(false);
	});

	it("retains setup cleanup authority when partial owner cleanup fails", async () => {
		const { stateFile } = await seededRunningSession("lock-transition-setup-cleanup-fault");
		const lockFile = `${stateFile}.lock`;
		const transitionDir = `${lockFile}.transition`;
		const ownerFile = `${transitionDir}.owner`;
		let writeFaulted = false;
		SessionStateLockTestHooks.ownerRecordWriteFault = async file => {
			if (file !== ownerFile) return;
			SessionStateLockTestHooks.ownerRecordWriteFault = undefined;
			writeFaulted = true;
			await fs.writeFile(file, '{"pid":');
			throw new Error("partial transition owner write");
		};
		let deniedUnlink = true;
		setSessionStateLockNativeBindings(() => ({
			...exactIdentityNativeBindings,
			exactUnlink(target, identity) {
				if (deniedUnlink) {
					deniedUnlink = false;
					throw Object.assign(new Error("owner cleanup fault"), { code: "EIO" });
				}
				return exactIdentityNativeBindings.exactUnlink(target, identity);
			},
		}));
		await expect(withSessionStateFileLock(stateFile, async () => "entered")).rejects.toBeInstanceOf(
			SessionStateLockUnavailableError,
		);
		expect(writeFaulted).toBe(true);
		expect(fsSync.existsSync(transitionDir)).toBe(true);
		expect(await fs.readFile(ownerFile, "utf8")).toBe('{"pid":');
	});

	it("leaves a legacy directory whose tree changed before the exact removal", async () => {
		const { stateFile } = await seededRunningSession("lock-legacy-exact-cas");
		const lockFile = `${stateFile}.lock`;
		await writeGenericLockDir(lockFile, { pid: DEAD_PID, start_time: "whenever", timestamp: Date.now() });

		let changed = false;
		SessionStateLockTestHooks.beforeLegacyDirectoryRemoval = async () => {
			changed = true;
			// A successor took the directory over and put its own payload in it while
			// leaving the owner token this reclaimer read untouched: re-reading the token
			// proves nothing, only the whole captured tree does.
			await Bun.write(path.join(lockFile, "successor-payload"), "successor");
		};

		await reclaimStaleSessionStateLock(lockFile);

		expect(changed).toBe(true);
		expect(fsSync.statSync(lockFile).isDirectory()).toBe(true);
		expect(await Bun.file(path.join(lockFile, "successor-payload")).text()).toBe("successor");
		expect(await readJson(path.join(lockFile, "info"))).toMatchObject({ pid: DEAD_PID });
	});

	/**
	 * The stale VERDICT and the tree that gets deleted have to be the same object.
	 *
	 * The verdict is produced by the generic protocol against a PATHNAME, and a legacy
	 * writer never takes the transition claim: it can remove the directory the verdict was
	 * about and create a brand-new LIVE one at the same path. A reclaimer that snapshots
	 * "whatever is there now" then hands the successor's own tree to the exact removal,
	 * which of course matches — the compare-and-delete protected the object it was given,
	 * but the authorization belonged to a different one. So the identity has to BRACKET
	 * the verdict: capture before, capture after, and remove only when they are the same.
	 */
	it("leaves a live legacy directory owner that replaced the stale one after the verdict", async () => {
		const { stateFile } = await seededRunningSession("lock-legacy-verdict-identity");
		const lockFile = `${stateFile}.lock`;
		await writeGenericLockDir(lockFile, { pid: DEAD_PID, start_time: "whenever", timestamp: Date.now() });

		let replaced = false;
		let successorIdentity = "";
		// Exactly the window the verdict authorizes: it has just been rendered against the
		// dead owner's directory, and the identity that will be deleted is not fixed yet.
		SessionStateLockTestHooks.afterLegacyDirectoryStaleVerdict = async () => {
			if (replaced) return;
			replaced = true;
			await fs.rm(lockFile, { recursive: true, force: true });
			await writeGenericLockDir(lockFile, {
				pid: process.pid,
				start_time: processStartTime(process.pid) ?? undefined,
				timestamp: Date.now(),
			});
			successorIdentity = directoryTreeIdentity(lockFile);
		};

		await reclaimStaleSessionStateLock(lockFile);

		expect(replaced).toBe(true);
		// Byte-for-byte and inode-for-inode the successor's own tree, never re-created.
		expect(fsSync.statSync(lockFile).isDirectory()).toBe(true);
		expect(directoryTreeIdentity(lockFile)).toBe(successorIdentity);
		expect(await readJson(path.join(lockFile, "info"))).toMatchObject({ pid: process.pid });

		// And it is respected as a LIVE owner: nothing acquires the lock behind it.
		const entered: string[] = [];
		const contender = withSessionStateFileLock(stateFile, async () => {
			entered.push("entered");
		});
		await Promise.race([contender, Bun.sleep(200)]);
		expect(entered).toEqual([]);
		expect(directoryTreeIdentity(lockFile)).toBe(successorIdentity);

		await fs.rm(lockFile, { recursive: true, force: true });
		await contender;
		expect(entered).toEqual(["entered"]);
	});

	it("fails closed and touches nothing when identity-bound deletion is unavailable", async () => {
		const { stateFile } = await seededRunningSession("lock-native-unavailable");
		const lockFile = `${stateFile}.lock`;
		const record = JSON.stringify({ pid: DEAD_PID, start_time: "unknown", token: "dead-owner-token" });
		await fs.writeFile(lockFile, record);

		// Exactly what an absent compiled addon does: resolution itself fails.
		setSessionStateLockNativeBindings(() => {
			throw new Error("pi_natives addon is unavailable");
		});

		// No `fs.rm` fallback: a process that cannot prove what it is deleting refuses.
		await expect(reclaimStaleSessionStateLock(lockFile)).rejects.toBeInstanceOf(SessionStateLockUnavailableError);
		await expect(withSessionStateFileLock(stateFile, async () => "entered")).rejects.toBeInstanceOf(
			SessionStateLockUnavailableError,
		);

		expect(fsSync.lstatSync(lockFile).isFile()).toBe(true);
		expect(await fs.readFile(lockFile, "utf8")).toBe(record);
		// The transition claim stays fail-closed while identity-bound deletion is unavailable.
		expect(fsSync.existsSync(`${lockFile}.transition`)).toBe(true);
	});

	it("keeps the namespace mutation lock directory-style", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "session-states", "namespace-session.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "turn_start" },
			{ sessionId: SESSION_ID, cwd: root, sessionFile: null },
		);

		// The outer namespace transaction lock guards no single JSON document of its own,
		// so it stays on the generic directory protocol rather than the owner-file one.
		// Holding the inner state-file lock parks a writer between the two, which is the
		// only window where the outer lock is observable on disk.
		const release = Promise.withResolvers<void>();
		const holder = withSessionStateFileLock(stateFile, () => release.promise);
		await Bun.sleep(20);
		const persist = persistCoordinatorRuntimeStateFromEvent(
			{ type: "tool_execution_start", toolCallId: "call-1" },
			{ sessionId: SESSION_ID, cwd: root, sessionFile: null },
			{ label: "bash", observedAt: "2026-03-01T00:00:01.000Z" },
		);
		await Bun.sleep(40);

		const mutationLock = path.join(root, "locks", "mutation.lock.lock");
		expect(fsSync.statSync(mutationLock).isDirectory()).toBe(true);
		expect(fsSync.existsSync(path.join(mutationLock, "info"))).toBe(true);
		expect(fsSync.statSync(`${stateFile}.lock`).isFile()).toBe(true);

		release.resolve();
		await holder;
		await persist;
		expect((await readJson(stateFile)).activity).toMatchObject({ seq: 1, tool: "bash" });
	});

	it("re-reads authoritative bytes instead of trusting matching file metadata", async () => {
		const { root, stateFile } = await seededRunningSession("lock-terminal-race");

		// Pad `reason` so the terminal payload below can be shrunk to the exact same
		// byte length; only then does a metadata-only cache report a false hit.
		const seeded = await readJson(stateFile);
		await Bun.write(stateFile, `${JSON.stringify({ ...seeded, reason: "p".repeat(64) })}\n`);

		await writeToolActivity(root, "call-1", "2026-03-01T00:00:01.000Z");
		const running = await readJson(stateFile);
		expect(running.state).toBe("running");

		// Another process settles the session at the SAME byte length and the SAME
		// mtime, so file metadata alone cannot distinguish the two payloads.
		const terminalBytesFor = (reason: string): string =>
			`${JSON.stringify({ ...running, state: "completed", ready_for_input: false, live: false, reason })}\n`;
		const runningBytes = `${JSON.stringify(running)}\n`;
		const delta = runningBytes.length - terminalBytesFor("").length;
		expect(delta).toBeGreaterThan(0);
		const terminalBytes = terminalBytesFor("x".repeat(delta));
		expect(terminalBytes.length).toBe(runningBytes.length);
		expect(terminalBytes).not.toBe(runningBytes);

		const priorStat = fsSync.statSync(stateFile);
		await fs.writeFile(stateFile, terminalBytes);
		await fs.utimes(stateFile, priorStat.atime, priorStat.mtime);
		// `utimes` truncates sub-millisecond precision, so compare at ms resolution.
		const rewritten = fsSync.statSync(stateFile);
		expect(Math.floor(rewritten.mtimeMs)).toBe(Math.floor(priorStat.mtimeMs));
		expect(rewritten.size).toBe(priorStat.size);

		// A late tool event must observe the terminal bytes on disk and refuse to
		// resurrect the session.
		await writeToolActivity(root, "call-late", "2026-03-01T00:00:09.000Z");

		expect(await Bun.file(stateFile).text()).toBe(terminalBytes);
		expect((await readJson(stateFile)).state).toBe("completed");
	});

	/**
	 * Windows has neither `O_NOFOLLOW` nor `O_NONBLOCK`, so the no-follow descriptor the
	 * POSIX path is built on does not exist there. Refusing every acquisition on that
	 * ground is not a safe compatibility fallback — the identity-bound deletion primitive
	 * is cross-platform, so it breaks a supported runtime outright. The fallback has to
	 * actually work AND still refuse every shape the owner protocol never writes, which is
	 * what the four cases below pin down. The strategy is selected explicitly so the
	 * Windows flow is exercised on whatever filesystem this suite runs on.
	 */
	/**
	 * Platform identity has precedence over whatever constants a runtime happens to expose.
	 * Bun/Node builds are allowed to publish numeric POSIX constants even where the kernel
	 * cannot provide their no-follow semantics; a win32 process must therefore select the
	 * Windows validation bracket explicitly rather than falling into the POSIX branch.
	 */
	it("selects the Windows owner strategy before considering POSIX flag availability", () => {
		const detect = (
			sessionStateLock as typeof sessionStateLock & {
				detectedSessionStateLockOwnerAccessStrategy?: (
					platform: NodeJS.Platform,
					posixNoFollowAvailable: boolean,
				) => string;
			}
		).detectedSessionStateLockOwnerAccessStrategy;
		expect(detect?.("win32", true)).toBe("windows-validated");
		expect(detect?.("linux", true)).toBe("posix-nofollow");
		expect(detect?.("aix", false)).toBe("unsupported");
	});

	describe("owner records without no-follow flags", () => {
		it("creates, captures, and releases a regular owner record under the windows strategy", async () => {
			const { root, stateFile } = await seededRunningSession("lock-windows-owner");
			const lockFile = `${stateFile}.lock`;
			SessionStateLockTestHooks.ownerAccessStrategy = "windows-validated";

			const observed: Array<string | undefined> = [];
			await withSessionStateFileLock(stateFile, async () => {
				observed.push(fsSync.lstatSync(lockFile).isFile() ? "file" : "other");
				observed.push(
					(JSON.parse(await fs.readFile(lockFile, "utf8")) as { pid: number }).pid === process.pid
						? "self-owned"
						: "foreign",
				);
			});

			expect(observed).toEqual(["file", "self-owned"]);
			await expectReleasedOwner(lockFile);
			expectReleasedTransition(lockFile);

			// And the lock still serializes a real state write afterwards.
			await writeToolActivity(root, "call-1", "2026-03-01T00:00:05.000Z");
			expect((await readJson(stateFile)).activity).toMatchObject({ seq: 1, tool: "bash" });
		});

		it("never reads or removes a symlink swapped in under the windows strategy", async () => {
			const { root, stateFile } = await seededRunningSession("lock-windows-symlink");
			const lockFile = `${stateFile}.lock`;
			const target = path.join(root, "windows-swap-target.json");
			// Bytes a by-name read accepts: a well-formed owner whose pid is provably dead.
			await Bun.write(target, JSON.stringify({ pid: DEAD_PID, start_time: "unknown", token: "target-owner-token" }));
			await fs.writeFile(
				lockFile,
				JSON.stringify({ pid: DEAD_PID, start_time: "unknown", token: "dead-owner-token" }),
			);
			SessionStateLockTestHooks.ownerAccessStrategy = "windows-validated";
			// After the outer type decision, so the refusal has to come from the owner
			// capture's own pre-`lstat` rather than from the earlier check.
			SessionStateLockTestHooks.afterLockTypeDecision = async () => {
				SessionStateLockTestHooks.afterLockTypeDecision = undefined;
				await fs.rm(lockFile);
				await fs.symlink(target, lockFile);
			};

			const refusal = await reclaimStaleSessionStateLock(lockFile).then(
				() => null,
				(error: unknown) => error,
			);

			expect(refusal).toBeInstanceOf(SessionStateLockUnavailableError);
			// The refusal came from the owner capture's own pre-`lstat`, not from the outer
			// type decision the swap already got past.
			expect((refusal as SessionStateLockUnavailableError).cause).toMatchObject({
				message: "Lock path is a reparse point, not an owner file.",
			});
			expect(fsSync.lstatSync(lockFile).isSymbolicLink()).toBe(true);
			expect(JSON.parse(await fs.readFile(target, "utf8")).token).toBe("target-owner-token");
		});

		it("leaves a regular-file replacement that landed after the windows capture", async () => {
			const { stateFile } = await seededRunningSession("lock-windows-replacement");
			const lockFile = `${stateFile}.lock`;
			await fs.writeFile(
				lockFile,
				JSON.stringify({ pid: DEAD_PID, start_time: "unknown", token: "dead-owner-token" }),
			);
			SessionStateLockTestHooks.ownerAccessStrategy = "windows-validated";

			const successor = JSON.stringify({
				pid: process.pid,
				start_time: processStartTime(process.pid) ?? "unknown",
				token: "windows-successor-token",
			});
			let replaced = false;
			// The identity has been captured through the validated handle and the exact
			// unlink has not run: only the CAS stands between here and a reaped live lock.
			SessionStateLockTestHooks.beforeStaleRemoval = async () => {
				replaced = true;
				await fs.rm(lockFile);
				await fs.writeFile(lockFile, successor);
			};

			await reclaimStaleSessionStateLock(lockFile);

			expect(replaced).toBe(true);
			expect(await fs.readFile(lockFile, "utf8")).toBe(successor);
		});

		it("fails closed when neither owner-access strategy is available", async () => {
			const { stateFile } = await seededRunningSession("lock-no-owner-strategy");
			const lockFile = `${stateFile}.lock`;
			SessionStateLockTestHooks.ownerAccessStrategy = "unsupported";

			await expect(withSessionStateFileLock(stateFile, async () => "entered")).rejects.toBeInstanceOf(
				SessionStateLockUnavailableError,
			);

			expect(fsSync.existsSync(lockFile)).toBe(false);
			expect(fsSync.existsSync(`${lockFile}.transition`)).toBe(false);
			expect(fsSync.existsSync(`${lockFile}.transition.owner`)).toBe(false);

			SessionStateLockTestHooks.ownerAccessStrategy =
				process.platform === "win32" ? "windows-validated" : "posix-nofollow";
			await expect(withSessionStateFileLock(stateFile, async () => "reacquired")).resolves.toBe("reacquired");
		});
	});
});

describe("session state lock forced-exit release", () => {
	it("tombstones every record this process holds and removes its empty claim, then stops tracking it", async () => {
		const { stateFile } = await seededRunningSession("lock-forced-exit");
		const lockFile = `${stateFile}.lock`;
		const { promise: entered, resolve: markEntered } = Promise.withResolvers<void>();
		const { promise: release, resolve: allowRelease } = Promise.withResolvers<void>();
		const holder = withSessionStateFileLock(stateFile, async () => {
			markEntered();
			await release;
		});
		await entered;
		expect(heldSessionStateLockPathsForTest()).toEqual([lockFile]);
		const before = JSON.parse(await fs.readFile(lockFile, "utf8")) as { pid: number; released?: boolean };
		expect(before.pid).toBe(process.pid);
		expect(before.released).toBeUndefined();

		expect(releaseHeldSessionStateLocksSync()).toBe(1);

		const after = JSON.parse(await fs.readFile(lockFile, "utf8")) as { pid: number; released?: boolean };
		expect(after.released).toBe(true);
		expect(after.pid).toBe(1);
		expect(heldSessionStateLockPathsForTest()).toEqual([]);
		// A second call has nothing left to release.
		expect(releaseHeldSessionStateLocksSync()).toBe(0);
		// A successor can take the lock immediately from the tombstone.
		await expect(withSessionStateFileLock(stateFile, async () => "successor")).resolves.toBe("successor");
		allowRelease();
		// The original holder's async release sees a record it no longer owns and fails
		// loudly instead of unlinking the successor's state.
		await expect(holder).rejects.toBeInstanceOf(SessionStateLockUnavailableError);
	});

	it("leaves a record that changed underneath untouched", async () => {
		const { stateFile } = await seededRunningSession("lock-forced-exit-changed");
		const lockFile = `${stateFile}.lock`;
		const { promise: entered, resolve: markEntered } = Promise.withResolvers<void>();
		const { promise: release, resolve: allowRelease } = Promise.withResolvers<void>();
		const holder = withSessionStateFileLock(stateFile, async () => {
			markEntered();
			await release;
		});
		await entered;
		const foreign = JSON.stringify({
			pid: DEAD_PID,
			start_time: "unknown",
			token: "foreign-successor",
			owner_host_id: "local-host",
		});
		await fs.writeFile(lockFile, foreign);

		expect(releaseHeldSessionStateLocksSync()).toBe(0);
		expect(await fs.readFile(lockFile, "utf8")).toBe(foreign);
		expect(heldSessionStateLockPathsForTest()).toEqual([]);
		allowRelease();
		await holder.catch(() => undefined);
	});

	it("tracks nothing after a normal release", async () => {
		const { stateFile } = await seededRunningSession("lock-forced-exit-clean");
		await withSessionStateFileLock(stateFile, async () => undefined);
		expect(heldSessionStateLockPathsForTest()).toEqual([]);
		expect(releaseHeldSessionStateLocksSync()).toBe(0);
	});
});

describe("session state lock failure diagnostics", () => {
	it("surfaces reason and lockPath from a lock error nested in wrappers", () => {
		const lockError = new SessionStateLockUnavailableError({
			lockPath: "/tmp/state.json.lock.transition",
			reason: "transition_claim_timeout",
		});
		const wrapped = new Error("marker unreadable", { cause: lockError });
		const aggregate = new AggregateError([new Error("operation failed"), wrapped], "both failed");
		expect(sessionStateLockFailureFields(aggregate)).toEqual({
			error: String(aggregate),
			reason: "transition_claim_timeout",
			lockPath: "/tmp/state.json.lock.transition",
		});
	});

	it("reports only the error text when no lock error is involved", () => {
		const plain = new Error("disk full");
		expect(sessionStateLockFailureFields(plain)).toEqual({ error: String(plain) });
		expect(sessionStateLockFailureFields("string failure")).toEqual({ error: "string failure" });
	});

	it("warns once per key per 30s window", () => {
		resetPersistFailureWarnWindows();
		expect(shouldWarnPersistFailure("s1", 0)).toBe(true);
		expect(shouldWarnPersistFailure("s1", 29_999)).toBe(false);
		expect(shouldWarnPersistFailure("s2", 29_999)).toBe(true);
		expect(shouldWarnPersistFailure("s1", 30_000)).toBe(true);
		expect(shouldWarnPersistFailure("s1", 30_001)).toBe(false);
		resetPersistFailureWarnWindows();
		expect(shouldWarnPersistFailure("s1", 30_001)).toBe(true);
	});
});

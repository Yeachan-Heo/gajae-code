import { afterEach, describe, expect, test, vi } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileLockTestHooks, removeFileLockDirForGc, withFileLock } from "@gajae-code/coding-agent/config/file-lock";
import { fileLocksGcAdapter } from "@gajae-code/coding-agent/config/file-lock-gc";
import type { GcContext, GcPidProbe, GcRecord } from "@gajae-code/coding-agent/gjc-runtime/gc-runtime";
import { snapshotDirectoryTree } from "@gajae-code/natives";

const DEAD_PID = 525_252;
const LIVE_PID = 636_363;

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	FileLockTestHooks.nativeQuarantineBindings = undefined;
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function makeTemp(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-lock-toctou-"));
	tempDirs.push(dir);
	return dir;
}

async function writeInfo(
	lockDir: string,
	info: { pid: number; timestamp: number; start_time?: string; owner_host_id?: string },
): Promise<void> {
	await fs.mkdir(lockDir, { recursive: true });
	await fs.writeFile(
		path.join(lockDir, "info"),
		JSON.stringify({ ...info, start_time: info.start_time ?? "test-start" }),
		"utf8",
	);
}

function ctxWith(spoolDir: string, probe: GcPidProbe): GcContext {
	return {
		probe,
		force: false,
		env: { ...process.env, GJC_RECEIPT_SPOOL_DIR: spoolDir },
		cwd: spoolDir,
	};
}

function deadLockRecord(lockDir: string): GcRecord {
	return {
		store: "file_locks",
		id: lockDir,
		path: lockDir,
		pid: DEAD_PID,
		pid_status: "dead",
		status: "dead",
		stale: true,
		removable: true,
		action: "none",
		reason: "file_lock_owner_pid_dead",
	};
}

describe("withFileLock stale owner liveness (#652)", () => {
	test("does not overlap a live holder that exceeds staleMs", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const events: string[] = [];
		let waiter: Promise<void> | undefined;

		await withFileLock(
			lockedFile,
			async () => {
				events.push("holder-enter");
				waiter = withFileLock(
					lockedFile,
					async () => {
						events.push("waiter-enter");
					},
					{ staleMs: 1, retries: 50, retryDelayMs: 5 },
				);

				await Bun.sleep(30);
				expect(events).toEqual(["holder-enter"]);
				events.push("holder-exit");
			},
			{ staleMs: 1, retries: 1, retryDelayMs: 1 },
		);
		await waiter;

		expect(events).toEqual(["holder-enter", "holder-exit", "waiter-enter"]);
	});

	test("reclaims a stale lock owned by a dead process", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const lockDir = `${lockedFile}.lock`;
		await writeInfo(lockDir, { pid: DEAD_PID, timestamp: Date.now() - 10_000 });

		let acquired = false;
		await withFileLock(
			lockedFile,
			async () => {
				acquired = true;
			},
			{ staleMs: 1, retries: 3, retryDelayMs: 1 },
		);

		expect(acquired).toBe(true);
		expect(await fs.exists(lockDir)).toBe(false);
	});
	test("retries when Windows transiently denies reading a contended lock info file", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const lockInfoPath = path.join(`${lockedFile}.lock`, "info");
		let contenderEntered = false;
		let deniedInfoRead = false;
		let contender: Promise<void> | undefined;

		await withFileLock(
			lockedFile,
			async () => {
				const realReadFile = fs.readFile;
				vi.spyOn(fs, "readFile").mockImplementation((async (target, options) => {
					if (!deniedInfoRead && String(target) === lockInfoPath) {
						deniedInfoRead = true;
						throw Object.assign(new Error("metadata temporarily locked"), { code: "EPERM" });
					}
					return await realReadFile(target, options);
				}) as typeof fs.readFile);
				contender = withFileLock(
					lockedFile,
					async () => {
						contenderEntered = true;
					},
					{ staleMs: 1, retries: 10, retryDelayMs: 1 },
				);
				for (let attempt = 0; attempt < 1_000 && !deniedInfoRead; attempt++) await Bun.sleep(1);
				expect(deniedInfoRead).toBe(true);
				expect(contenderEntered).toBe(false);
			},
			{ staleMs: 1, retries: 1, retryDelayMs: 1 },
		);
		await contender;

		expect(deniedInfoRead).toBe(true);
		expect(contenderEntered).toBe(true);
	});

	test("preserves a live old-format holder without start_time", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const lockDir = `${lockedFile}.lock`;
		await fs.mkdir(lockDir, { recursive: true });
		await fs.writeFile(
			path.join(lockDir, "info"),
			JSON.stringify({ pid: process.pid, timestamp: Date.now() - 10_000 }),
		);

		await expect(
			withFileLock(lockedFile, async () => {}, { staleMs: 1, retries: 2, retryDelayMs: 1 }),
		).rejects.toThrow("Failed to acquire lock");
		expect(await fs.exists(lockDir)).toBe(true);
	});

	test("preserves a live holder whose start time is explicitly unknown", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const lockDir = `${lockedFile}.lock`;
		await fs.mkdir(lockDir, { recursive: true });
		await fs.writeFile(
			path.join(lockDir, "info"),
			JSON.stringify({ pid: process.pid, start_time: "unknown", timestamp: Date.now() - 10_000 }),
		);

		await expect(
			withFileLock(lockedFile, async () => {}, { staleMs: 1, retries: 2, retryDelayMs: 1 }),
		).rejects.toThrow("Failed to acquire lock");
		expect(await fs.exists(lockDir)).toBe(true);
	});

	test("fails closed when present lock metadata is malformed", async () => {
		const invalidMetadata = [
			["empty", ""],
			["null", "null"],
			["bad pid", JSON.stringify({ pid: 0, start_time: "test-start", timestamp: Date.now() - 10_000 })],
			["bad timestamp", JSON.stringify({ pid: process.pid, start_time: "test-start", timestamp: "old" })],
		] as const;

		for (const [label, contents] of invalidMetadata) {
			const base = await makeTemp();
			const lockedFile = path.join(base, `${label}.json`);
			const lockDir = `${lockedFile}.lock`;
			await fs.mkdir(lockDir, { recursive: true });
			await fs.writeFile(path.join(lockDir, "info"), contents);

			await expect(
				withFileLock(lockedFile, async () => {}, { staleMs: 1, retries: 2, retryDelayMs: 1 }),
			).rejects.toThrow("Failed to acquire lock");
			expect(await fs.exists(lockDir)).toBe(true);
		}
	});

	test("fails closed when lock metadata is a dangling symlink", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const lockDir = `${lockedFile}.lock`;
		await fs.mkdir(lockDir, { recursive: true });
		await fs.symlink(path.join(base, "missing-info"), path.join(lockDir, "info"));

		await expect(
			withFileLock(lockedFile, async () => {}, { staleMs: 1, retries: 2, retryDelayMs: 1 }),
		).rejects.toThrow("Failed to acquire lock");
		expect((await fs.lstat(path.join(lockDir, "info"))).isSymbolicLink()).toBe(true);
	});

	test("rejects after successful protected work when ownership is lost during release", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const lockDir = `${lockedFile}.lock`;
		const replacement = { pid: LIVE_PID, start_time: "test-start", timestamp: Date.now() + 1_000 };

		await expect(
			withFileLock(lockedFile, async () => {
				await writeInfo(lockDir, replacement);
			}),
		).rejects.toThrow("Failed to release file lock: owner_changed.");
		const onDisk = JSON.parse(await fs.readFile(path.join(lockDir, "info"), "utf8"));
		expect(onDisk).toEqual(replacement);
	});

	test("rejects after successful protected work when the lock disappears during release", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const lockDir = `${lockedFile}.lock`;

		await expect(
			withFileLock(lockedFile, async () => {
				await fs.rm(lockDir, { recursive: true });
			}),
		).rejects.toThrow("Failed to release file lock: missing.");
	});
});
describe("host-qualified file lock publication", () => {
	test("ignores interrupted pending publication directories", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		await fs.mkdir(`${lockedFile}.lock.pending.interrupted`, { recursive: true });
		await fs.writeFile(path.join(`${lockedFile}.lock.pending.interrupted`, "info"), "{");

		let acquired = false;
		await withFileLock(
			lockedFile,
			async () => {
				acquired = true;
				expect(await fs.exists(`${lockedFile}.lock`)).toBe(true);
			},
			{ ownerHostId: "test-host", retries: 1, retryDelayMs: 1 },
		);

		expect(acquired).toBe(true);
		expect(await fs.exists(`${lockedFile}.lock.pending.interrupted`)).toBe(true);
		expect(await fs.exists(`${lockedFile}.lock`)).toBe(false);
	});
});
describe("file lock cleanup failure handling (#2478)", () => {
	test("retries transient Windows release denial before reporting success", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const lockDir = `${lockedFile}.lock`;
		const realRm = fs.rm;
		let denied = true;
		vi.spyOn(fs, "rm").mockImplementation((async (target, options) => {
			if (denied && String(target) === lockDir) {
				denied = false;
				throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
			}
			return await realRm(target, options);
		}) as typeof fs.rm);

		await withFileLock(lockedFile, async () => {});

		expect(await fs.exists(lockDir)).toBe(false);
		expect(denied).toBe(false);
	});

	test("quarantines a self-owned lock when transient release denial persists", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const lockDir = `${lockedFile}.lock`;
		const realRm = fs.rm;
		vi.spyOn(fs, "rm").mockImplementation((async (target, options) => {
			if (String(target) === lockDir) throw Object.assign(new Error("sharing violation"), { code: "EBUSY" });
			return await realRm(target, options);
		}) as typeof fs.rm);

		await withFileLock(lockedFile, async () => {});

		expect(await fs.exists(lockDir)).toBe(false);
	});

	test("accepts a verified detach even when cleanup is not yet durable", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const lockDir = `${lockedFile}.lock`;
		const realRm = fs.rm;
		vi.spyOn(fs, "rm").mockImplementation((async (target, options) => {
			if (String(target) === lockDir) throw Object.assign(new Error("sharing violation"), { code: "EBUSY" });
			return await realRm(target, options);
		}) as typeof fs.rm);
		FileLockTestHooks.nativeQuarantineBindings = () => ({
			snapshotDirectoryTree,
			exactRemoveDirectoryTree: target => {
				rmSync(target, { recursive: true, force: true });
				return {
					ok: false,
					code: "detached_failure",
					detachedPath: `${target}.removing`,
				};
			},
		});

		await withFileLock(lockedFile, async () => {});

		expect(await fs.exists(lockDir)).toBe(false);
	});

	test("reclaims a self-owned release leak on the next same-process acquisition", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const lockDir = `${lockedFile}.lock`;
		const realRm = fs.rm;
		vi.spyOn(fs, "rm").mockImplementation((async (target, options) => {
			if (String(target) === lockDir) throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
			return await realRm(target, options);
		}) as typeof fs.rm);
		FileLockTestHooks.nativeQuarantineBindings = () => ({
			snapshotDirectoryTree,
			exactRemoveDirectoryTree: () => {
				throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
			},
		});

		await expect(withFileLock(lockedFile, async () => {})).rejects.toThrow("sharing violation");
		expect(await fs.exists(lockDir)).toBe(true);

		vi.restoreAllMocks();
		let entered = false;
		await withFileLock(lockedFile, async () => {
			entered = true;
		});

		expect(entered).toBe(true);
		expect(await fs.exists(lockDir)).toBe(false);
	});

	test("preserves a successor generation acquired during release completion", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const lockDir = `${lockedFile}.lock`;
		const realRm = fs.rm;
		const successorEntered = Promise.withResolvers<void>();
		let successor: Promise<void> | undefined;
		let oldRelease = true;
		vi.spyOn(fs, "rm").mockImplementation((async (target, options) => {
			const result = await realRm(target, options);
			if (oldRelease && String(target) === lockDir) {
				oldRelease = false;
				successor = withFileLock(lockedFile, async () => {
					successorEntered.resolve();
				});
				await successorEntered.promise;
			}
			return result;
		}) as typeof fs.rm);

		await withFileLock(lockedFile, async () => {});
		await successor;

		expect(await fs.exists(lockDir)).toBe(false);
	});

	test("reclaims a pending generation through a symlinked parent alias", async () => {
		const base = await makeTemp();
		const realParent = path.join(base, "real");
		const aliasParent = path.join(base, "alias");
		await fs.mkdir(realParent);
		await fs.symlink(realParent, aliasParent, "dir");
		const realFile = path.join(realParent, "state.json");
		const aliasFile = path.join(aliasParent, "state.json");
		const realRm = fs.rm;
		vi.spyOn(fs, "rm").mockImplementation((async (target, options) => {
			if (String(target).endsWith(".lock")) throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
			return await realRm(target, options);
		}) as typeof fs.rm);
		FileLockTestHooks.nativeQuarantineBindings = () => ({
			snapshotDirectoryTree,
			exactRemoveDirectoryTree: () => {
				throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
			},
		});

		await expect(withFileLock(realFile, async () => {})).rejects.toThrow("sharing violation");
		expect(await fs.exists(`${realFile}.lock`)).toBe(true);

		vi.restoreAllMocks();
		FileLockTestHooks.nativeQuarantineBindings = undefined;
		let entered = false;
		await withFileLock(aliasFile, async () => {
			entered = true;
		});

		expect(entered).toBe(true);
		expect(await fs.exists(`${realFile}.lock`)).toBe(false);
	});

	test("does not reap a stale lock when its metadata read fails unexpectedly", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const lockDir = `${lockedFile}.lock`;
		const readError = Object.assign(new Error("metadata access denied"), { code: "EACCES" });
		await writeInfo(lockDir, { pid: DEAD_PID, timestamp: Date.now() - 10_000 });

		vi.spyOn(fs, "readFile").mockRejectedValueOnce(readError);

		await expect(withFileLock(lockedFile, async () => {}, { staleMs: 1, retries: 1, retryDelayMs: 1 })).rejects.toBe(
			readError,
		);
		expect(await fs.exists(lockDir)).toBe(true);
	});

	test("rejects when release fails after successful protected work", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const lockDir = `${lockedFile}.lock`;
		const releaseError = Object.assign(new Error("lock removal denied"), { code: "EACCES" });
		let completed = false;

		vi.spyOn(fs, "rm").mockRejectedValueOnce(releaseError);

		await expect(
			withFileLock(lockedFile, async () => {
				completed = true;
			}),
		).rejects.toBe(releaseError);
		expect(completed).toBe(true);
		expect(await fs.exists(lockDir)).toBe(true);
	});

	test("preserves operation and ownership-loss release failures", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const lockDir = `${lockedFile}.lock`;
		const operationError = new Error("protected work failed");
		const replacement = { pid: LIVE_PID, start_time: "test-start", timestamp: Date.now() + 1_000 };

		let failure: unknown;
		try {
			await withFileLock(lockedFile, async () => {
				await writeInfo(lockDir, replacement);
				throw operationError;
			});
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(AggregateError);
		const errors = (failure as AggregateError).errors;
		expect(errors).toHaveLength(2);
		expect(errors[0]).toBe(operationError);
		expect(errors[1]).toBeInstanceOf(Error);
		expect((errors[1] as Error).message).toBe("Failed to release file lock: owner_changed.");
		const onDisk = JSON.parse(await fs.readFile(path.join(lockDir, "info"), "utf8"));
		expect(onDisk).toEqual(replacement);
	});
});
describe("file lock owner-token removal guard (#606)", () => {
	test("removes the dir when the on-disk token matches the expected owner", async () => {
		const base = await makeTemp();
		const lockDir = path.join(base, "match.lock");
		const token = { pid: DEAD_PID, timestamp: 1000 };
		await writeInfo(lockDir, token);

		const outcome = await removeFileLockDirForGc(lockDir, token);

		expect(outcome).toBe("removed");
		expect(await fs.exists(lockDir)).toBe(false);
	});

	test("refuses (owner_changed) when a live owner has reclaimed the same path", async () => {
		const base = await makeTemp();
		const lockDir = path.join(base, "reclaimed.lock");
		// On disk: a fresh live owner (different pid + timestamp).
		await writeInfo(lockDir, { pid: LIVE_PID, timestamp: 2000 });

		// Expected: the dead owner the GC observed earlier.
		const outcome = await removeFileLockDirForGc(lockDir, { pid: DEAD_PID, timestamp: 1000 });

		expect(outcome).toBe("owner_changed");
		expect(await fs.exists(lockDir)).toBe(true);
		const onDisk = JSON.parse(await fs.readFile(path.join(lockDir, "info"), "utf8"));
		expect(onDisk.pid).toBe(LIVE_PID);
	});

	test("refuses (owner_changed) when only the timestamp differs (same pid reused)", async () => {
		const base = await makeTemp();
		const lockDir = path.join(base, "ts.lock");
		await writeInfo(lockDir, { pid: DEAD_PID, timestamp: 9999 });

		const outcome = await removeFileLockDirForGc(lockDir, { pid: DEAD_PID, timestamp: 1000 });

		expect(outcome).toBe("owner_changed");
		expect(await fs.exists(lockDir)).toBe(true);
	});

	test("refuses (missing) when the info file is absent (fresh acquirer mid-mkdir)", async () => {
		const base = await makeTemp();
		const lockDir = path.join(base, "noinfo.lock");
		await fs.mkdir(lockDir, { recursive: true });

		const outcome = await removeFileLockDirForGc(lockDir, { pid: DEAD_PID, timestamp: 1000 });

		expect(outcome).toBe("missing");
		expect(await fs.exists(lockDir)).toBe(true);
	});
});

describe("fileLocksGcAdapter.prune TOCTOU (#606)", () => {
	test("prunes a genuinely dead lock (happy path still works)", async () => {
		const base = await makeTemp();
		const spoolDir = path.join(base, "spool");
		const lockDir = path.join(spoolDir, "dead.lock");
		await writeInfo(lockDir, { pid: DEAD_PID, timestamp: 1000 });
		const probe: GcPidProbe = pid => (pid === DEAD_PID ? { status: "dead" } : { status: "keep", reason: "alive" });

		const outcome = await fileLocksGcAdapter.prune(deadLockRecord(lockDir), ctxWith(spoolDir, probe));

		expect(outcome.removed).toBe(true);
		expect(outcome.skipped).toBeUndefined();
		expect(await fs.exists(lockDir)).toBe(false);
	});
	test("never prunes a foreign host-qualified lock from local PID evidence", async () => {
		const base = await makeTemp();
		const spoolDir = path.join(base, "spool");
		const lockDir = path.join(spoolDir, "state.json.lock");
		await writeInfo(lockDir, {
			pid: DEAD_PID,
			timestamp: Date.now() - 10_000,
			owner_host_id: "foreign-host",
		});
		const probe = vi.fn<GcPidProbe>(() => ({ status: "dead" }));
		const outcome = await fileLocksGcAdapter.prune(deadLockRecord(lockDir), ctxWith(spoolDir, probe));

		expect(outcome).toEqual({
			removed: false,
			skipped: "host_qualified_lock_requires_owner_reclamation",
		});
		expect(await fs.exists(lockDir)).toBe(true);
		expect(probe).not.toHaveBeenCalled();
	});

	test("fails closed when a live owner reclaims the stale lock between probe and unlink", async () => {
		const base = await makeTemp();
		const spoolDir = path.join(base, "spool");
		const lockDir = path.join(spoolDir, "race.lock");
		await writeInfo(lockDir, { pid: DEAD_PID, timestamp: 1000 });

		// The probe reports DEAD (so prune proceeds toward deletion) but, as a
		// side effect, simulates a live owner reclaiming the stale dir at the same
		// path with a fresh identity — exactly the probe -> unlink TOCTOU window.
		let reclaimed = false;
		const racingProbe: GcPidProbe = pid => {
			if (pid === DEAD_PID && !reclaimed) {
				reclaimed = true;
				writeFileSync(
					path.join(lockDir, "info"),
					JSON.stringify({ pid: LIVE_PID, start_time: "test-start", timestamp: 2000 }),
				);
			}
			return pid === DEAD_PID ? { status: "dead" } : { status: "keep", reason: "alive" };
		};

		const outcome = await fileLocksGcAdapter.prune(deadLockRecord(lockDir), ctxWith(spoolDir, racingProbe));

		expect(outcome.removed).toBe(false);
		expect(outcome.skipped).toBe("file_lock_owner_changed_before_delete");
		// The freshly recreated LIVE lock must survive untouched.
		expect(await fs.exists(lockDir)).toBe(true);
		const onDisk = JSON.parse(await fs.readFile(path.join(lockDir, "info"), "utf8"));
		expect(onDisk.pid).toBe(LIVE_PID);
		expect(onDisk.timestamp).toBe(2000);
	});
});

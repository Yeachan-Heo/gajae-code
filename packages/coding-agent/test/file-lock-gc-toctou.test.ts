import { afterEach, describe, expect, test, vi } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	FileLockTestHooks,
	processStartTime,
	readFileLockObservationForGc,
	removeFileLockDirForGc,
	withFileLock,
} from "@gajae-code/coding-agent/config/file-lock";
import { fileLocksGcAdapter } from "@gajae-code/coding-agent/config/file-lock-gc";
import type { GcContext, GcPidProbe, GcRecord } from "@gajae-code/coding-agent/gjc-runtime/gc-runtime";
import { snapshotDirectoryTree } from "@gajae-code/natives";

const DEAD_PID = 525_252;
const LIVE_PID = 636_363;

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	FileLockTestHooks.afterParentMkdir = undefined;
	FileLockTestHooks.nativePublicationBindings = undefined;
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
	info: {
		pid: number;
		timestamp: number;
		start_time?: string;
		start_time_format?: string;
		owner_host_id?: string;
		owner_token?: string;
	},
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
	test("propagates transient onAcquired failures instead of retrying an empty lock", async () => {
		const root = await makeTemp();
		const file = path.join(root, "publication.json");
		const failure = Object.assign(new Error("publication denied"), { code: "EACCES" });

		await expect(
			withFileLock(file, async () => undefined, {
				retries: 2,
				retryDelayMs: 1,
				onAcquired: () => {
					throw failure;
				},
			}),
		).rejects.toBe(failure);
		// Publication is staged before onAcquired runs, so the aborted callback
		// leaves the fully populated lock behind instead of an empty directory.
		expect((await fs.readdir(`${file}.lock`)).join(",")).toBe("info");
	});

	test("publishes through the directory fallback when native no-replace is unsupported", async () => {
		const root = await makeTemp();
		const file = path.join(root, "unsupported", "publication.json");
		FileLockTestHooks.nativePublicationBindings = () => ({
			renameNoReplacePathAsync: async () => ({
				ok: false,
				code: "atomic_unavailable",
				mutationState: "not_committed",
				durabilityState: "not_attempted",
				reason: "atomic_unavailable",
				primitive: "renameat2_noreplace",
				phase: "preflight",
				diagnostic: { schemaVersion: 1, collectionState: "unavailable" },
			}),
			renameDirectoryNoReplacePathAsync: async (source, destination) => {
				await fs.rename(source, destination);
				return {
					ok: true,
					mutationState: "committed",
					durabilityState: "not_attempted",
					reason: "none",
					primitive: "mkdirat_renameat_noreplace",
					phase: "complete",
					diagnostic: { schemaVersion: 1, collectionState: "unavailable" },
				};
			},
		});
		let publishedInfo = "";
		await expect(
			withFileLock(file, async () => {
				publishedInfo = await fs.readFile(`${file}.lock/info`, "utf8");
			}),
		).resolves.toBeUndefined();
		expect(publishedInfo).toContain('"pid"');
	});

	test("keeps non-ASCII lock paths on the native fallback boundary", async () => {
		const root = await makeTemp();
		const file = path.join(root, "사내블로그", "월간트렌드_2608", "publication.json");
		let fallbackCalls = 0;
		FileLockTestHooks.nativePublicationBindings = () => ({
			renameNoReplacePathAsync: async () => ({
				ok: false,
				code: "atomic_unavailable",
				mutationState: "not_committed",
				durabilityState: "not_attempted",
				reason: "atomic_unavailable",
				primitive: "renameat2_noreplace",
				phase: "preflight",
				diagnostic: { schemaVersion: 1, collectionState: "unavailable" },
			}),
			renameDirectoryNoReplacePathAsync: async (source, destination) => {
				fallbackCalls += 1;
				await fs.rename(source, destination);
				return {
					ok: true,
					mutationState: "committed",
					durabilityState: "not_attempted",
					reason: "none",
					primitive: "mkdirat_renameat_noreplace",
					phase: "complete",
					diagnostic: { schemaVersion: 1, collectionState: "unavailable" },
				};
			},
		});

		await withFileLock(file, async () => {
			expect(await fs.readFile(`${file}.lock/info`, "utf8")).toContain('"owner_token"');
		});
		expect(fallbackCalls).toBe(1);
	});

	test("does not replace a legacy empty lock directory when publication is unsupported", async () => {
		const root = await makeTemp();
		const file = path.join(root, "legacy-empty", "publication.json");
		await fs.mkdir(`${file}.lock`, { recursive: true });
		FileLockTestHooks.nativePublicationBindings = () => ({
			renameNoReplacePathAsync: async () => ({
				ok: false,
				code: "invalid_request",
				mutationState: "not_committed",
				durabilityState: "not_attempted",
				reason: "invalid_request",
				primitive: "renameat2_noreplace",
				phase: "preflight",
				diagnostic: { schemaVersion: 1, collectionState: "unavailable" },
			}),
			renameDirectoryNoReplacePathAsync: async () => ({
				ok: false,
				code: "quarantine_collision",
				mutationState: "not_committed",
				durabilityState: "not_attempted",
				reason: "destination_exists",
				primitive: "mkdirat_renameat_noreplace",
				phase: "rename",
				diagnostic: { schemaVersion: 1, collectionState: "unavailable" },
			}),
		});
		await expect(withFileLock(file, async () => undefined, { retries: 2, retryDelayMs: 1 })).rejects.toThrow();
		expect((await fs.stat(`${file}.lock`)).isDirectory()).toBe(true);
	});

	test("does not invoke the directory fallback for a malformed native result", async () => {
		const root = await makeTemp();
		const file = path.join(root, "malformed", "publication.json");
		let fallbackCalled = false;
		FileLockTestHooks.nativePublicationBindings = () => ({
			renameNoReplacePathAsync: async () => ({ ok: false, code: "atomic_unavailable" }) as never,
			renameDirectoryNoReplacePathAsync: async () => {
				fallbackCalled = true;
				throw new Error("fallback must not run");
			},
		});

		await expect(withFileLock(file, async () => undefined, { retries: 1, retryDelayMs: 1 })).rejects.toThrow(
			"Failed to publish file lock: atomic_unavailable.",
		);
		expect(fallbackCalled).toBe(false);
	});

	test("publishes nested lock directories with private modes under restrictive umask", async () => {
		const root = await makeTemp();
		const file = path.join(root, "nested", "deeper", "state.json");
		const previousUmask = process.umask(0o277);
		try {
			const unqualifiedAssertions = Promise.withResolvers<void>();
			await withFileLock(file, async () => undefined, {
				onAcquired: () => {
					(async () => {
						try {
							for (const directory of [
								path.join(root, "nested"),
								path.join(root, "nested", "deeper"),
								`${file}.lock`,
							]) {
								expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
							}
							expect((await fs.stat(`${file}.lock/info`)).mode & 0o777).toBe(0o600);
							unqualifiedAssertions.resolve();
						} catch (error) {
							unqualifiedAssertions.reject(error);
						}
					})();
				},
			});
			await unqualifiedAssertions.promise;
			const qualifiedFile = path.join(root, "qualified", "state.json");
			const qualifiedAssertions = Promise.withResolvers<void>();
			await withFileLock(qualifiedFile, async () => undefined, {
				ownerHostId: "test-host",
				onAcquired: () => {
					(async () => {
						try {
							expect((await fs.stat(`${qualifiedFile}.lock`)).mode & 0o777).toBe(0o700);
							expect((await fs.stat(`${qualifiedFile}.lock/info`)).mode & 0o777).toBe(0o600);
							qualifiedAssertions.resolve();
						} catch (error) {
							qualifiedAssertions.reject(error);
						}
					})();
				},
			});
			await qualifiedAssertions.promise;
		} finally {
			process.umask(previousUmask);
		}
	});

	test("publishes a lock for a non-ASCII path", async () => {
		const root = await makeTemp();
		const file = path.join(root, "사내블로그", "월간트렌드_2608", "post.md");
		await fs.mkdir(path.dirname(file), { recursive: true });

		let entered = false;
		await withFileLock(file, async () => {
			entered = true;
			expect(await fs.readFile(`${file}.lock/info`, "utf8")).toContain('"owner_token"');
		});

		expect(entered).toBe(true);
		expect(await fs.exists(`${file}.lock`)).toBe(false);
	});

	test("honors an already-aborted signal before creating lock parents", async () => {
		const root = await makeTemp();
		const file = path.join(root, "not-created", "state.json");
		const reason = new Error("cancelled before acquisition");
		const controller = new AbortController();
		controller.abort(reason);

		await expect(withFileLock(file, async () => undefined, { signal: controller.signal })).rejects.toBe(reason);
		expect(await fs.exists(path.dirname(file))).toBe(false);
	});

	test("keeps process identity stable across caller locale and timezone", () => {
		if (process.platform === "win32") return;
		const original = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };
		try {
			process.env.TZ = "Pacific/Honolulu";
			process.env.LC_ALL = "C";
			process.env.LANG = "C";
			const holderIdentity = processStartTime(process.pid);
			process.env.TZ = "Asia/Tokyo";
			process.env.LC_ALL = "de_DE.UTF-8";
			process.env.LANG = "de_DE.UTF-8";
			const contenderIdentity = processStartTime(process.pid);

			expect(holderIdentity).not.toBeNull();
			expect(contenderIdentity).toBe(holderIdentity);
		} finally {
			if (original.TZ === undefined) delete process.env.TZ;
			else process.env.TZ = original.TZ;
			if (original.LC_ALL === undefined) delete process.env.LC_ALL;
			else process.env.LC_ALL = original.LC_ALL;
			if (original.LANG === undefined) delete process.env.LANG;
			else process.env.LANG = original.LANG;
		}
	});

	test("stamps canonical format on newly created lock records", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");

		await withFileLock(lockedFile, async () => {
			const info = JSON.parse(await fs.readFile(path.join(`${lockedFile}.lock`, "info"), "utf8")) as Record<
				string,
				unknown
			>;
			expect(info.start_time_format).toBe("utc-v1");
			expect(typeof info.owner_token).toBe("string");
		});
	});

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
	test("does not remove a successor during stale ownerless lock cleanup", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "ownerless.json");
		const lockDir = `${lockedFile}.lock`;
		// A NON-EMPTY stale directory: staged atomic publication cannot rename over
		// it, so reclaim must go through the identity-bound native branch, which the
		// mock below replaces with a fresh live directory between capture and remove.
		await fs.mkdir(lockDir);
		await writeInfo(lockDir, { pid: DEAD_PID, timestamp: Date.now() - 10_000 });
		let replaced = false;
		FileLockTestHooks.nativeQuarantineBindings = () => ({
			snapshotDirectoryTree,
			exactRemoveDirectoryTree: () => {
				replaced = true;
				// Simulate a successor that took over the path during the removal
				// window: a fully published live lock, not an empty directory — an
				// empty one could be atomically replaced by our own staged rename.
				rmSync(lockDir, { recursive: true, force: true });
				mkdirSync(lockDir);
				writeFileSync(
					path.join(lockDir, "info"),
					JSON.stringify({ pid: LIVE_PID, start_time: "successor", timestamp: Date.now() }),
				);
				return { ok: false, code: "identity_mismatch" };
			},
		});

		await expect(
			withFileLock(lockedFile, async () => undefined, { staleMs: 1, retries: 2, retryDelayMs: 1 }),
		).rejects.toThrow("Failed to acquire lock");
		expect(replaced).toBe(true);
		expect(await fs.stat(lockDir)).toBeDefined();
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
				const realOpen = fs.open;
				vi.spyOn(fs, "open").mockImplementation((async (target, flags, mode) => {
					if (!deniedInfoRead && String(target) === lockInfoPath) {
						deniedInfoRead = true;
						throw Object.assign(new Error("metadata temporarily locked"), { code: "EPERM" });
					}
					return await realOpen(target, flags, mode);
				}) as typeof fs.open);
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

	test("does not replace an empty legacy lock directory during publication", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const lockDir = `${lockedFile}.lock`;
		await fs.mkdir(lockDir);
		const old = new Date(Date.now() - 60_000);
		await fs.utimes(lockDir, old, old);

		await expect(withFileLock(lockedFile, async () => undefined, { retries: 1, retryDelayMs: 1 })).rejects.toThrow(
			"Failed to acquire lock",
		);

		expect((await fs.lstat(lockDir)).isDirectory()).toBe(true);
		expect(await fs.readdir(lockDir)).toEqual([]);
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

	test("preserves an aged owner when PID liveness is indeterminate", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const lockDir = `${lockedFile}.lock`;
		await writeInfo(lockDir, { pid: process.pid, timestamp: Date.now() - 60_000 });
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw Object.assign(new Error("liveness unavailable"), { code: "EIO" });
		});

		await expect(
			withFileLock(lockedFile, async () => {}, { staleMs: 1, retries: 2, retryDelayMs: 1 }),
		).rejects.toThrow("Failed to acquire lock");
		expect(await fs.exists(lockDir)).toBe(true);
	});

	test("reclaims an owner whose PID has been reused for a different incarnation", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const lockDir = `${lockedFile}.lock`;
		await writeInfo(lockDir, {
			pid: process.pid,
			start_time: "different-incarnation",
			start_time_format: "utc-v1",
			timestamp: Date.now() - 60_000,
			owner_token: "canonical-owner",
		});

		await withFileLock(lockedFile, async () => {}, { staleMs: 1, retries: 2, retryDelayMs: 1 });

		expect(await fs.exists(lockDir)).toBe(false);
	});

	test("preserves a legacy live holder when its locale-dependent start time differs", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const lockDir = `${lockedFile}.lock`;
		const probe = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(process.pid)], {
			stdout: "pipe",
			stderr: "ignore",
			env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "Pacific/Honolulu" },
		});
		const legacyStartTime = new TextDecoder().decode(probe.stdout).trim();
		await writeInfo(lockDir, {
			pid: process.pid,
			start_time: legacyStartTime,
			start_time_format: "utc-v1-old",
			timestamp: Date.now() - 60_000,
			owner_token: "legacy-token",
		});

		await expect(
			withFileLock(lockedFile, async () => {}, { staleMs: 1, retries: 2, retryDelayMs: 1 }),
		).rejects.toThrow("Failed to acquire lock");
		expect(await fs.exists(lockDir)).toBe(true);
	});

	test("preserves a host-qualified lock for an unqualified contender", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const lockDir = `${lockedFile}.lock`;
		await writeInfo(lockDir, {
			pid: DEAD_PID,
			timestamp: Date.now() - 60_000,
			owner_host_id: "foreign-host",
		});

		await expect(
			withFileLock(lockedFile, async () => {}, { staleMs: 1, retries: 2, retryDelayMs: 1 }),
		).rejects.toThrow("Failed to acquire lock");
		expect(await fs.exists(lockDir)).toBe(true);
	});

	test("rejects after successful protected work when the lock disappears during release", async () => {
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
	test("refuses generic release without pre-verdict identity instead of capturing a successor", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const lockDir = `${lockedFile}.lock`;
		const expected = { pid: DEAD_PID, timestamp: Date.now(), start_time: "test-start", owner_token: "owner" };
		await writeInfo(lockDir, expected);
		let snapshotCalls = 0;
		FileLockTestHooks.nativeQuarantineBindings = () => ({
			snapshotDirectoryTree: () => {
				snapshotCalls++;
				return snapshotDirectoryTree(lockDir);
			},
			exactRemoveDirectoryTree: () => {
				throw new Error("successor must not be removed");
			},
		});

		expect(await removeFileLockDirForGc(lockDir, expected)).toBe("owner_changed");
		expect(snapshotCalls).toBe(0);
		expect(await fs.exists(lockDir)).toBe(true);
	});

	test("treats a native snapshot sharing violation as transient release contention", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const lockDir = `${lockedFile}.lock`;
		let snapshotCalls = 0;
		FileLockTestHooks.nativeQuarantineBindings = () => ({
			snapshotDirectoryTree: () => {
				snapshotCalls++;
				return { ok: false, code: "sharing_violation" };
			},
			exactRemoveDirectoryTree: () => {
				throw new Error("snapshot sharing violation must stop before removal");
			},
		});

		await expect(withFileLock(lockedFile, async () => undefined)).rejects.toMatchObject({
			code: "sharing_violation",
		});
		expect(snapshotCalls).toBeGreaterThan(0);
		expect(await fs.exists(lockDir)).toBe(true);
	});

	test("retries transient Windows release denial before reporting success", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const lockDir = `${lockedFile}.lock`;
		let denied = true;
		FileLockTestHooks.nativeQuarantineBindings = () => ({
			snapshotDirectoryTree,
			exactRemoveDirectoryTree: target => {
				if (denied) {
					denied = false;
					throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
				}
				rmSync(target, { recursive: true, force: true });
				return { ok: true };
			},
		});

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
				mkdirSync(`${target}.removing`);
				return {
					ok: false,
					code: "detached_failure",
					detachedPath: `${target}.removing`,
				};
			},
		});

		await withFileLock(lockedFile, async () => {});

		expect(await fs.exists(lockDir)).toBe(false);
		expect(await fs.exists(`${lockDir}.removing`)).toBe(false);
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
		// The identity-bound release path consults the native bindings hook, not the
		// fs.rm spy, so the reclaim phase needs the real bindings restored too.
		FileLockTestHooks.nativeQuarantineBindings = undefined;
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
		const readError = Object.assign(new Error("metadata access denied"), { code: "EIO" });
		await writeInfo(lockDir, { pid: DEAD_PID, timestamp: Date.now() - 10_000 });

		vi.spyOn(fs, "open").mockRejectedValueOnce(readError);

		await expect(withFileLock(lockedFile, async () => {}, { staleMs: 1, retries: 1, retryDelayMs: 1 })).rejects.toBe(
			readError,
		);
		expect(await fs.exists(lockDir)).toBe(true);
	});

	test("releases through a verified detach even when quarantine cleanup fails", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const lockDir = `${lockedFile}.lock`;
		const releaseError = Object.assign(new Error("lock removal denied"), { code: "EIO" });
		let completed = false;

		// The first rm is the quarantine completion after a verified native detach:
		// the canonical lock name is already free, so a cleanup failure there is
		// recoverable debris and must not fail the release (or re-leak the lock).
		vi.spyOn(fs, "rm").mockRejectedValueOnce(releaseError);

		await withFileLock(lockedFile, async () => {
			completed = true;
		});
		expect(completed).toBe(true);
		expect(await fs.exists(lockDir)).toBe(false);
	});

	test("releases with the acquisition key when canonicalization transiently fails", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const realpath = fs.realpath;
		let failCanonicalization = false;
		vi.spyOn(fs, "realpath").mockImplementation((async target => {
			if (failCanonicalization && String(target).endsWith(".lock")) {
				throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
			}
			return await realpath(target);
		}) as typeof fs.realpath);

		await withFileLock(lockedFile, async () => {
			failCanonicalization = true;
		});

		expect(await fs.exists(`${lockedFile}.lock`)).toBe(false);
	});

	test("retries an existing contender after transient lock-path canonicalization failure", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const realpath = fs.realpath;
		let failLockPathCanonicalization = false;
		vi.spyOn(fs, "realpath").mockImplementation((async target => {
			if (failLockPathCanonicalization && String(target).endsWith(".lock")) {
				failLockPathCanonicalization = false;
				throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
			}
			return await realpath(target);
		}) as typeof fs.realpath);

		let contenderEntered = false;
		let contender: Promise<void> | undefined;
		await withFileLock(lockedFile, async () => {
			failLockPathCanonicalization = true;
			contender = withFileLock(
				lockedFile,
				async () => {
					contenderEntered = true;
				},
				{ retries: 20, retryDelayMs: 1 },
			);
			await Bun.sleep(10);
			expect(contenderEntered).toBe(false);
		});

		await contender;
		expect(contenderEntered).toBe(true);
	});

	test("recovers pending ownership when parent canonicalization initially falls back", async () => {
		const base = await makeTemp();
		const realParent = path.join(base, "real");
		const aliasParent = path.join(base, "alias");
		await fs.mkdir(realParent);
		await fs.symlink(realParent, aliasParent, "dir");
		const realFile = path.join(realParent, "state.json");
		const aliasFile = path.join(aliasParent, "state.json");
		const realpath = fs.realpath;
		let failParentCanonicalization = true;
		vi.spyOn(fs, "realpath").mockImplementation((async target => {
			if (failParentCanonicalization && String(target) === aliasParent) {
				failParentCanonicalization = false;
				throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
			}
			return await realpath(target);
		}) as typeof fs.realpath);
		const realRm = fs.rm;
		vi.spyOn(fs, "rm").mockImplementation((async (target, options) => {
			if (String(target) === `${aliasFile}.lock`)
				throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
			return await realRm(target, options);
		}) as typeof fs.rm);
		FileLockTestHooks.nativeQuarantineBindings = () => ({
			snapshotDirectoryTree,
			exactRemoveDirectoryTree: () => {
				throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
			},
		});

		await expect(withFileLock(aliasFile, async () => {}, { retries: 2, retryDelayMs: 1 })).rejects.toThrow(
			"sharing violation",
		);
		vi.restoreAllMocks();
		FileLockTestHooks.nativeQuarantineBindings = undefined;

		let entered = false;
		await withFileLock(
			realFile,
			async () => {
				entered = true;
			},
			{ retries: 2, retryDelayMs: 1 },
		);
		expect(entered).toBe(true);
		expect(await fs.exists(`${realFile}.lock`)).toBe(false);
	});

	/**
	 * Case-distinct keys carry the semantics 581960b079 documents: distinct
	 * authorities on case-SENSITIVE directories, converged aliases elsewhere.
	 * The two halves need different assertions — on a case-insensitive volume
	 * (default macOS APFS, Windows NTFS) both spellings publish one on-disk
	 * `.lock` directory, so a NESTED acquire of the alias would wait on its own
	 * live owner. The suite previously asserted only the case-sensitive half,
	 * unconditionally, and CI's ubuntu-only test shards never executed it on a
	 * case-insensitive filesystem (#5082).
	 */
	async function directoryIsCaseInsensitive(base: string): Promise<boolean> {
		const probe = path.join(base, "CaseProbe.tmp");
		await fs.writeFile(probe, "", "utf8");
		try {
			return await fs.exists(path.join(base, "caseprobe.tmp"));
		} finally {
			await fs.rm(probe, { force: true });
		}
	}

	test("keeps case-distinct lock keys independent on case-sensitive volumes", async () => {
		const base = await makeTemp();
		if (await directoryIsCaseInsensitive(base)) return;
		const upper = path.join(base, "State.json");
		const lower = path.join(base, "state.json");
		let upperEntered = false;
		let lowerEntered = false;
		await withFileLock(upper, async () => {
			upperEntered = true;
			await withFileLock(lower, async () => {
				lowerEntered = true;
			});
		});
		expect(upperEntered).toBe(true);
		expect(lowerEntered).toBe(true);
		expect(await fs.exists(`${upper}.lock`)).toBe(false);
		expect(await fs.exists(`${lower}.lock`)).toBe(false);
	});

	test("converges case-aliased lock keys on case-insensitive volumes", async () => {
		const base = await makeTemp();
		if (!(await directoryIsCaseInsensitive(base))) return;
		const upper = path.join(base, "State.json");
		const lower = path.join(base, "state.json");

		// Sequential acquires of both spellings share one converged authority.
		let upperEntered = false;
		let lowerEntered = false;
		await withFileLock(upper, async () => {
			upperEntered = true;
		});
		await withFileLock(lower, async () => {
			lowerEntered = true;
		});
		expect(upperEntered).toBe(true);
		expect(lowerEntered).toBe(true);

		// Concurrent, independent acquires serialize on the converged key
		// instead of corrupting ownership; both critical sections complete.
		let inside = 0;
		let maxInside = 0;
		const enter = async (): Promise<void> => {
			inside += 1;
			maxInside = Math.max(maxInside, inside);
			await Bun.sleep(25);
			inside -= 1;
		};
		await Promise.all([withFileLock(upper, enter), withFileLock(lower, enter)]);
		expect(maxInside).toBe(1);
		expect(await fs.exists(`${upper}.lock`)).toBe(false);
		expect(await fs.exists(`${lower}.lock`)).toBe(false);
	});

	test("registers ownership before canonicalization can fail after publication", async () => {
		const base = await makeTemp();
		const lockedFile = path.join(base, "state.json");
		const lockDir = `${lockedFile}.lock`;
		const realpath = fs.realpath;
		let failCanonicalization = false;
		vi.spyOn(fs, "realpath").mockImplementation((async target => {
			if (failCanonicalization && String(target).endsWith(".lock")) {
				throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
			}
			return await realpath(target);
		}) as typeof fs.realpath);
		FileLockTestHooks.afterParentMkdir = target => {
			if (target === lockDir) failCanonicalization = true;
		};

		await withFileLock(lockedFile, async () => {});

		expect(await fs.exists(lockDir)).toBe(false);
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
		const observed = await readFileLockObservationForGc(lockDir);
		expect(observed).not.toBeNull();

		const outcome = await removeFileLockDirForGc(lockDir, token, observed?.identity);

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

	test("does not let a cloned directory inherit a stale verdict before the removal snapshot", async () => {
		const base = await makeTemp();
		const spoolDir = path.join(base, "spool");
		const lockDir = path.join(spoolDir, "clone-before-snapshot.lock");
		await writeInfo(lockDir, { pid: DEAD_PID, timestamp: 1000 });

		let cloned = false;
		let exactRemoveCalled = false;
		FileLockTestHooks.nativeQuarantineBindings = () => ({
			snapshotDirectoryTree(target) {
				if (target === lockDir && !cloned) {
					cloned = true;
					rmSync(lockDir, { recursive: true, force: true });
					mkdirSync(lockDir);
					writeFileSync(
						path.join(lockDir, "info"),
						JSON.stringify({ pid: DEAD_PID, start_time: "test-start", timestamp: 1000 }),
					);
				}
				return snapshotDirectoryTree(target);
			},
			exactRemoveDirectoryTree() {
				exactRemoveCalled = true;
				return { ok: false, code: "identity_mismatch" };
			},
		});

		const outcome = await fileLocksGcAdapter.prune(
			deadLockRecord(lockDir),
			ctxWith(spoolDir, () => ({ status: "dead" })),
		);

		expect(cloned).toBe(true);
		expect(exactRemoveCalled).toBe(false);
		expect(outcome).toEqual({ removed: false, skipped: "file_lock_owner_changed_before_delete" });
		expect(await fs.exists(lockDir)).toBe(true);
		expect(JSON.parse(await fs.readFile(path.join(lockDir, "info"), "utf8")).timestamp).toBe(1000);
	});
});

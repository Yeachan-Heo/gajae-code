import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readFileLockInfoForGc, removeFileLockDirForGc, withFileLock } from "../src/config/file-lock";

/**
 * A lock owner's liveness is probed against the *local* process table. That is
 * only meaningful for a lock this host wrote. When the state directory lives on
 * a shared volume (NFS home directories are supported), a remote owner's pid is
 * almost never a live local pid, so without host identity a foreign host's
 * freshly-taken lock is judged dead and reclaimed instantly — with none of the
 * stale grace period a local owner of unknown liveness receives.
 */
describe("file lock cross-host owner identity", () => {
	const FOREIGN_HOST = "gjc-foreign-host-fixture";

	async function stageForeignLock(
		dir: string,
		file: string,
		overrides: Record<string, unknown> = {},
	): Promise<string> {
		const lockDir = `${path.join(dir, file)}.lock`;
		await fs.mkdir(lockDir, { recursive: true });
		await Bun.write(
			path.join(lockDir, "info"),
			JSON.stringify({
				// A pid that is not alive on this host, which is the normal case for a
				// process owned by a different machine.
				pid: 999_999,
				start_time: "Mon Jan  1 00:00:00 2029",
				host_id: FOREIGN_HOST,
				timestamp: Date.now(),
				...overrides,
			}),
		);
		return lockDir;
	}

	test("refuses to steal another host's freshly-taken lock", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-lock-xhost-"));
		try {
			await stageForeignLock(dir, "state.json");
			let ran = false;
			await expect(
				withFileLock(
					path.join(dir, "state.json"),
					async () => {
						ran = true;
					},
					{ retries: 2, retryDelayMs: 5, staleMs: 60_000 },
				),
			).rejects.toThrow(/Failed to acquire lock/);
			expect(ran).toBe(false);
			// The foreign owner's record must survive untouched.
			const info = await readFileLockInfoForGc(`${path.join(dir, "state.json")}.lock`);
			expect(info?.host_id).toBe(FOREIGN_HOST);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("still reclaims another host's lock once it exceeds the stale window", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-lock-xhost-"));
		try {
			await stageForeignLock(dir, "state.json", { timestamp: Date.now() - 120_000 });
			let ran = false;
			await withFileLock(
				path.join(dir, "state.json"),
				async () => {
					ran = true;
				},
				{ retries: 3, retryDelayMs: 5, staleMs: 10_000 },
			);
			expect(ran).toBe(true);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("a dead local owner is still reclaimed immediately", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-lock-xhost-"));
		try {
			// No host_id at all: a pre-host-id record keeps the previous local-pid
			// semantics, so a dead pid is reclaimed without waiting out staleMs.
			const lockDir = `${path.join(dir, "state.json")}.lock`;
			await fs.mkdir(lockDir, { recursive: true });
			await Bun.write(path.join(lockDir, "info"), JSON.stringify({ pid: 999_999, timestamp: Date.now() }));
			let ran = false;
			await withFileLock(
				path.join(dir, "state.json"),
				async () => {
					ran = true;
				},
				{ retries: 3, retryDelayMs: 5, staleMs: 60_000 },
			);
			expect(ran).toBe(true);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("a live local owner is never reclaimed by elapsed time", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-lock-xhost-"));
		try {
			const lockDir = `${path.join(dir, "state.json")}.lock`;
			await fs.mkdir(lockDir, { recursive: true });
			await Bun.write(
				path.join(lockDir, "info"),
				JSON.stringify({ pid: process.pid, timestamp: Date.now() - 600_000 }),
			);
			await expect(
				withFileLock(path.join(dir, "state.json"), async () => undefined, {
					retries: 2,
					retryDelayMs: 5,
					staleMs: 1,
				}),
			).rejects.toThrow(/Failed to acquire lock/);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("guarded removal refuses a token whose host differs", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-lock-xhost-"));
		try {
			const lockDir = await stageForeignLock(dir, "state.json");
			const onDisk = await readFileLockInfoForGc(lockDir);
			expect(onDisk).not.toBeNull();
			// Same pid, start_time and timestamp, different host: two machines sharing
			// a volume can coincide on all of those, so host identity must gate the
			// delete rather than being ignored.
			expect(
				await removeFileLockDirForGc(lockDir, {
					pid: onDisk!.pid,
					start_time: onDisk!.start_time,
					host_id: "some-other-host",
					timestamp: onDisk!.timestamp,
				}),
			).toBe("owner_changed");
			expect(await readFileLockInfoForGc(lockDir)).not.toBeNull();
			// The exact owner token still removes it.
			expect(await removeFileLockDirForGc(lockDir, onDisk!)).toBe("removed");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("a lock this process takes records its own host identity", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-lock-xhost-"));
		try {
			let observed: string | undefined;
			await withFileLock(path.join(dir, "state.json"), async () => {
				observed = (await readFileLockInfoForGc(`${path.join(dir, "state.json")}.lock`))?.host_id;
			});
			expect(observed).toBe(os.hostname() || "unknown");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

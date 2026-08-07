import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	acquirePathLock,
	compareMemoryLockPaths,
	MemoryLockError,
	memoryLockPath,
	sortMemoryLockPaths,
} from "../../src/storage/locks";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })));
});

async function makeRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-core-locks-"));
	temporaryRoots.push(root);
	return root;
}

async function captureError(task: () => Promise<unknown>): Promise<unknown> {
	return task().then(
		() => undefined,
		error => error,
	);
}

async function writeManualPathLock(
	root: string,
	relPath: string,
	owner: Record<string, unknown> | null,
	mtime?: Date,
): Promise<string> {
	const lockPath = memoryLockPath(root, relPath);
	await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
	await fs.mkdir(lockPath, { mode: 0o700 });
	await fs.chmod(lockPath, 0o700);
	if (owner === null) {
		await fs.writeFile(path.join(lockPath, "owner.json"), "not-json\n", { mode: 0o600 });
	} else {
		const ownerPath = path.join(lockPath, "owner.json");
		await fs.writeFile(ownerPath, JSON.stringify(owner), { mode: 0o600 });
		await fs.chmod(ownerPath, 0o600);
	}
	if (mtime !== undefined) await fs.utimes(lockPath, mtime, mtime);
	return lockPath;
}

describe("memory locks", () => {
	it("enforces exclusivity and records a stable owner until release", async () => {
		const root = await makeRoot();
		const relPath = "global/profile.md";
		const first = await acquirePathLock(root, relPath, { retries: 1, retryDelayMs: 0 });
		const lockPath = memoryLockPath(root, relPath);
		try {
			expect(first.relPath).toBe(relPath);
			expect(first.lockPath).toBe(lockPath);
			expect(first.owner).toMatchObject({
				pid: process.pid,
				host: os.hostname(),
				relPath,
			});
			expect(typeof first.owner.startedAt).toBe("number");
			expect(first.owner.token.length).toBeGreaterThan(0);
			expect((await fs.stat(lockPath)).mode & 0o777).toBe(0o700);
			const ownerPath = path.join(lockPath, "owner.json");
			expect((await fs.stat(ownerPath)).mode & 0o777).toBe(0o600);
			expect(JSON.parse(await fs.readFile(ownerPath, "utf8"))).toEqual(first.owner);

			const conflict = await captureError(() => acquirePathLock(root, relPath, { retries: 1, retryDelayMs: 0 }));
			expect(conflict).toBeInstanceOf(MemoryLockError);
			expect((conflict as MemoryLockError).code).toBe("lock-conflict");
			expect((conflict as MemoryLockError).relPath).toBe(relPath);
			expect((conflict as Error).message).toContain("exhausted");
			expect(await fs.readFile(ownerPath, "utf8")).toBe(JSON.stringify(first.owner));
		} finally {
			await first.release();
		}

		const afterRelease = await acquirePathLock(root, relPath, { retries: 1, retryDelayMs: 0 });
		await afterRelease.release();
		expect(
			await fs.stat(path.dirname(lockPath)).then(
				() => true,
				() => false,
			),
		).toBe(true);
		expect(
			await fs.stat(lockPath).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});

	it("sorts lock paths by normalized UTF-8 bytes without mutating the input", () => {
		const paths = ["é", "z", "e\u0301", "a", "Å", "ä", "a/é"];
		const sorted = sortMemoryLockPaths(paths);

		expect(sorted).toEqual(["a", "a/é", "z", "Å", "ä", "é", "e\u0301"]);
		expect(paths).toEqual(["é", "z", "e\u0301", "a", "Å", "ä", "a/é"]);
		expect(compareMemoryLockPaths("é", "e\u0301")).toBe(0);
		expect(compareMemoryLockPaths("z", "Å")).toBeLessThan(0);
	});

	it("does not reclaim live owners, preserves fresh unknown owners, and reclaims stale owners", async () => {
		const root = await makeRoot();
		const liveRelPath = "live.md";
		const live = await acquirePathLock(root, liveRelPath, { staleMs: 0, retries: 1, retryDelayMs: 0 });
		try {
			const liveConflict = await captureError(() =>
				acquirePathLock(root, liveRelPath, { staleMs: 0, retries: 1, retryDelayMs: 0 }),
			);
			expect(liveConflict).toBeInstanceOf(MemoryLockError);
			expect((liveConflict as Error).message).toContain("exhausted");
		} finally {
			await live.release();
		}

		const freshRelPath = "fresh-remote.md";
		const freshOwner = {
			pid: 999_999_999,
			startedAt: Date.now(),
			host: "remote-host-for-test",
			token: "fresh-owner-token",
			relPath: freshRelPath,
		};
		const freshLockPath = await writeManualPathLock(root, freshRelPath, freshOwner);
		const freshOwnerBytes = await fs.readFile(path.join(freshLockPath, "owner.json"));
		const freshConflict = await captureError(() =>
			acquirePathLock(root, freshRelPath, { staleMs: 60_000, retries: 1, retryDelayMs: 0 }),
		);
		expect(freshConflict).toBeInstanceOf(MemoryLockError);
		expect((freshConflict as Error).message).toContain("exhausted");
		expect((await fs.readFile(path.join(freshLockPath, "owner.json"))).equals(freshOwnerBytes)).toBe(true);

		const staleRelPath = "stale.md";
		const staleOwner = {
			pid: 999_999_999,
			startedAt: 0,
			host: os.hostname(),
			token: "stale-owner-token",
			relPath: staleRelPath,
		};
		const staleLockPath = await writeManualPathLock(root, staleRelPath, staleOwner, new Date(0));
		const reclaimed = await acquirePathLock(root, staleRelPath, { staleMs: 60_000, retries: 2, retryDelayMs: 0 });
		try {
			expect(reclaimed.owner.pid).toBe(process.pid);
			expect(reclaimed.owner.token).not.toBe(staleOwner.token);
			expect(JSON.parse(await fs.readFile(path.join(staleLockPath, "owner.json"), "utf8")).token).toBe(
				reclaimed.owner.token,
			);
		} finally {
			await reclaimed.release();
		}
	});

	it("fails closed after exhaustion and leaves an unverifiable lock untouched", async () => {
		const root = await makeRoot();
		const relPath = "indeterminate.md";
		const lockPath = await writeManualPathLock(root, relPath, null);
		const ownerPath = path.join(lockPath, "owner.json");
		const before = await fs.readFile(ownerPath);

		const error = await captureError(() =>
			acquirePathLock(root, relPath, { staleMs: 60_000, retries: 2, retryDelayMs: 0 }),
		);
		expect(error).toBeInstanceOf(MemoryLockError);
		expect((error as MemoryLockError).code).toBe("lock-conflict");
		expect((error as MemoryLockError).relPath).toBe(relPath);
		expect((error as Error).message).toContain("exhausted after 2 attempts");
		expect((await fs.readFile(ownerPath)).equals(before)).toBe(true);
		expect((await fs.lstat(lockPath)).isDirectory()).toBe(true);
	});
});

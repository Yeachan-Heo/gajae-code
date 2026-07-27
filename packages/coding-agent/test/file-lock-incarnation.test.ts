import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__setFileLockProcessObserverForTests,
	type FileLockOwnerToken,
	removeFileLockDirForGc,
	withFileLock,
} from "../src/config/file-lock";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	__setFileLockProcessObserverForTests(undefined);
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { force: true, recursive: true })),
	);
});

async function createLockTarget(owner: FileLockOwnerToken): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-file-lock-incarnation-"));
	temporaryDirectories.push(directory);
	const target = path.join(directory, "state");
	const lockDir = `${target}.lock`;
	await fs.mkdir(lockDir);
	await Bun.write(path.join(lockDir, "info"), JSON.stringify(owner));
	return target;
}

function observeOwner(state: "dead" | "unknown" | "reused" | "matching") {
	__setFileLockProcessObserverForTests(pid => {
		if (pid === process.pid) return { state: "live", incarnation: "windows:999" };
		if (state === "dead") return { state: "dead" };
		if (state === "unknown") return { state: "unknown" };
		return {
			state: "live",
			incarnation: state === "reused" ? "windows:101" : "windows:100",
		};
	});
}

describe("file lock process incarnation", () => {
	it("reclaims a lock when the owner PID was reused", async () => {
		observeOwner("reused");
		const target = await createLockTarget({
			pid: 42,
			incarnation: "windows:100",
			owner_id: "old-owner",
			timestamp: 1,
		});
		let entered = false;

		await withFileLock(
			target,
			async () => {
				entered = true;
			},
			{ retries: 0, retryDelayMs: 0 },
		);

		expect(entered).toBe(true);
	});

	it("does not evict a live matching or unknown owner by age", async () => {
		for (const state of ["matching", "unknown"] as const) {
			observeOwner(state);
			const target = await createLockTarget({
				pid: 42,
				incarnation: "windows:100",
				owner_id: `owner-${state}`,
				timestamp: 1,
			});
			await expect(
				withFileLock(target, async () => undefined, { retries: 0, retryDelayMs: 0, staleMs: 0 }),
			).rejects.toThrow(/Failed to acquire lock/);
		}
	});

	it("reclaims a definitively dead owner and preserves legacy metadata", async () => {
		observeOwner("dead");
		const deadTarget = await createLockTarget({
			pid: 42,
			incarnation: "windows:100",
			owner_id: "dead-owner",
			timestamp: 1,
		});
		await expect(withFileLock(deadTarget, async () => "entered", { retries: 0, retryDelayMs: 0 })).resolves.toBe(
			"entered",
		);

		const legacyTarget = await createLockTarget({ pid: 42, timestamp: 1 });
		await expect(
			withFileLock(legacyTarget, async () => undefined, { retries: 0, retryDelayMs: 0, staleMs: 0 }),
		).rejects.toThrow(/Failed to acquire lock/);
	});

	it("uses a process-local fallback when incarnation observation is unavailable", async () => {
		__setFileLockProcessObserverForTests(() => ({ state: "unknown" }));
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-file-lock-init-failure-"));
		temporaryDirectories.push(directory);
		const target = path.join(directory, "state");

		expect(await withFileLock(target, async () => "entered", { retries: 0, retryDelayMs: 0 })).toBe("entered");
		expect(await Bun.file(`${target}.lock`).exists()).toBe(false);
	});

	it("serializes concurrent guarded removal attempts", async () => {
		const owner: FileLockOwnerToken = {
			pid: 42,
			incarnation: "windows:100",
			owner_id: "guarded-owner",
			timestamp: 1,
		};
		const target = await createLockTarget(owner);
		const outcomes = await Promise.all([
			removeFileLockDirForGc(`${target}.lock`, owner),
			removeFileLockDirForGc(`${target}.lock`, owner),
		]);

		expect(outcomes.filter(outcome => outcome === "removed")).toHaveLength(1);
		expect(outcomes.every(outcome => ["missing", "owner_changed", "removed"].includes(outcome))).toBe(true);
	});

	it("reclaims a stale removal guard before deleting the protected lock", async () => {
		const owner: FileLockOwnerToken = {
			pid: 42,
			incarnation: "windows:100",
			owner_id: "preserved-owner",
			timestamp: 1,
		};
		const target = await createLockTarget(owner);
		await Bun.write(
			`${target}.lock.remove`,
			JSON.stringify({
				pid: 43,
				incarnation: "windows:200",
				owner_id: "stale-remover",
				timestamp: 1,
			}),
		);
		await Bun.write(
			`${target}.lock.remove.reaping`,
			JSON.stringify({
				pid: 44,
				incarnation: "windows:300",
				owner_id: "orphaned-reaper",
				timestamp: 1,
			}),
		);
		__setFileLockProcessObserverForTests(pid =>
			pid === process.pid ? { state: "live", incarnation: "windows:999" } : { state: "dead" },
		);

		expect(await removeFileLockDirForGc(`${target}.lock`, owner)).toBe("removed");
		expect(await Bun.file(`${target}.lock.remove`).exists()).toBe(false);
		expect(await Bun.file(`${target}.lock.remove.reaping`).exists()).toBe(false);
	});

	it.skipIf(process.platform !== "win32")("acquires and releases a real Windows incarnation lock", async () => {
		__setFileLockProcessObserverForTests(undefined);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-file-lock-windows-"));
		temporaryDirectories.push(directory);
		const target = path.join(directory, "state");

		expect(await withFileLock(target, async () => "entered", { retries: 0, retryDelayMs: 0 })).toBe("entered");
		expect(await Bun.file(`${target}.lock`).exists()).toBe(false);
	});
});

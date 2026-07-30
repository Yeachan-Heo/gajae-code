import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireManagedLock, ManagedLockTestHooks } from "../../src/session/internal/managed-session-storage";

const temporaryDirectories: string[] = [];

afterEach(() => {
	ManagedLockTestHooks.beforeObservedRetirement = undefined;
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

function createLockRoot(name: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `gjc-managed-lock-${name}-`));
	temporaryDirectories.push(root);
	const locks = path.join(root, "locks");
	fs.mkdirSync(locks, { recursive: true });
	return locks;
}

function readLock(pathname: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(pathname, "utf8")) as Record<string, unknown>;
}

function expireLock(pathname: string): void {
	const record = readLock(pathname);
	fs.writeFileSync(
		pathname,
		`${JSON.stringify({ ...record, heartbeatAt: Date.now() - 10_000, leaseExpiresAt: Date.now() - 5_000 })}\n`,
	);
}

describe("managed migration lock lease ownership", () => {
	it("keeps a live starved holder exclusive past expiry, then permits acquisition after release", async () => {
		const locks = createLockRoot("live-holder");
		const first = await acquireManagedLock(locks, "migration");
		try {
			expireLock(first.path);
			const waitStartedAt = Date.now();
			await expect(acquireManagedLock(locks, "migration")).rejects.toThrow("migration_busy");
			expect(Date.now() - waitStartedAt).toBeGreaterThanOrEqual(4_500);

			expect(() => first.assertOwned()).not.toThrow();
			const renewed = readLock(first.path);
			expect(renewed.attemptId).toBe(first.attemptId);
			expect(Number(renewed.leaseExpiresAt)).toBeGreaterThan(Date.now());
		} finally {
			await first.release();
		}

		const successor = await acquireManagedLock(locks, "migration");
		try {
			expect(successor.attemptId).not.toBe(first.attemptId);
			expect(() => successor.assertOwned()).not.toThrow();
		} finally {
			await successor.release();
		}
	}, 15_000);

	it("fences a pathname replacement even when the replacement copies the old attempt id", async () => {
		const locks = createLockRoot("path-aba");
		const first = await acquireManagedLock(locks, "migration");
		const parked = `${first.path}.parked`;
		const original = fs.readFileSync(first.path);
		fs.renameSync(first.path, parked);
		fs.writeFileSync(first.path, original, { mode: 0o600 });

		expect(() => first.assertOwned()).toThrow("migration_busy");
		await first.release().catch(() => undefined);
	});

	it("preserves a successor installed after a released lock was observed", async () => {
		const locks = createLockRoot("retirement-race");
		const first = await acquireManagedLock(locks, "migration");
		await first.release();
		const successorAttemptId = "successor-attempt";
		let injected = false;
		ManagedLockTestHooks.beforeObservedRetirement = ({ path: lockPath, attemptId }) => {
			if (injected) return;
			injected = true;
			fs.renameSync(lockPath, `${lockPath}.${attemptId}.retired`);
			const now = Date.now();
			fs.writeFileSync(
				lockPath,
				`${JSON.stringify({
					attemptId: successorAttemptId,
					pid: process.pid,
					processStartId: "successor-process",
					createdAt: now,
					heartbeatAt: now,
					leaseExpiresAt: now + 60_000,
				})}\n`,
				{ mode: 0o600 },
			);
		};

		const waitStartedAt = Date.now();
		await expect(acquireManagedLock(locks, "migration")).rejects.toThrow("migration_busy");
		expect(Date.now() - waitStartedAt).toBeGreaterThanOrEqual(4_500);
		expect(injected).toBe(true);
		expect(readLock(first.path).attemptId).toBe(successorAttemptId);
	}, 15_000);
});

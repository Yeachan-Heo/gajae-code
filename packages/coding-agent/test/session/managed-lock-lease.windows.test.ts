import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireManagedLock, ManagedLockTestHooks } from "../../src/session/internal/managed-session-storage";

const temporaryDirectories: string[] = [];

afterEach(() => {
	ManagedLockTestHooks.beforeObservedRetirement = undefined;
	ManagedLockTestHooks.beforeReleaseDescriptorVerification = undefined;
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
		await expect(first.release()).rejects.toThrow();
		expect(fs.readFileSync(first.path)).toEqual(original);
		await first.release();
	});

	it.skipIf(process.platform !== "linux")(
		"reacquires exact Linux release authority when the retained descriptor identity is lost",
		async () => {
			const locks = createLockRoot("release-descriptor-recovery");
			const first = await acquireManagedLock(locks, "migration");
			const decoy = path.join(locks, "decoy");
			fs.writeFileSync(decoy, "decoy", { mode: 0o600 });
			let injected = false;
			let replacementFd: number | undefined;
			ManagedLockTestHooks.beforeReleaseDescriptorVerification = ({ fd }) => {
				if (injected) return;
				injected = true;
				fs.closeSync(fd);
				replacementFd = fs.openSync(decoy, fs.constants.O_WRONLY);
				expect(replacementFd).toBe(fd);
				expireLock(first.path);
				expect(() => first.assertOwned()).toThrow("migration_busy");
				expect(fs.readFileSync(decoy, "utf8")).toBe("decoy");
			};

			try {
				await first.release();
				await first.release();
				expect(injected).toBe(true);
				expect(readLock(first.path).released).toBe(true);
				expect(fs.readFileSync(decoy, "utf8")).toBe("decoy");
				expect(replacementFd).toBeDefined();
				if (replacementFd !== undefined) expect(fs.fstatSync(replacementFd).isFile()).toBe(true);
			} finally {
				if (replacementFd !== undefined) fs.closeSync(replacementFd);
			}
		},
	);

	it.skipIf(process.platform !== "linux")(
		"reacquires exact Linux release authority when the retained descriptor is closed",
		async () => {
			const locks = createLockRoot("release-closed-descriptor-recovery");
			const first = await acquireManagedLock(locks, "migration");
			let injected = false;
			ManagedLockTestHooks.beforeReleaseDescriptorVerification = ({ fd }) => {
				if (injected) return;
				injected = true;
				fs.closeSync(fd);
				expireLock(first.path);
				expect(() => first.assertOwned()).toThrow("migration_busy");
			};

			await first.release();
			expect(injected).toBe(true);
			expect(readLock(first.path).released).toBe(true);
			await first.release();
			expect(() => first.assertOwned()).toThrow("migration_busy");
		},
	);

	it("does not let repeated release touch a successor or a reused descriptor", async () => {
		const locks = createLockRoot("repeated-release");
		const first = await acquireManagedLock(locks, "migration");
		await first.release();
		const successor = await acquireManagedLock(locks, "migration");
		const original = fs.readFileSync(successor.path);
		try {
			await first.release();
			expect(fs.readFileSync(successor.path)).toEqual(original);
			expect(() => first.assertOwned()).toThrow("migration_busy");
			expect(() => successor.assertOwned()).not.toThrow();
		} finally {
			await successor.release();
		}
	});

	it.skipIf(process.platform !== "linux")(
		"rejects Linux descriptor recovery onto a replacement with a copied attempt id",
		async () => {
			const locks = createLockRoot("release-recovery-path-aba");
			const first = await acquireManagedLock(locks, "migration");
			const original = fs.readFileSync(first.path);
			ManagedLockTestHooks.beforeReleaseDescriptorVerification = ({ fd }) => {
				fs.closeSync(fd);
				fs.renameSync(first.path, `${first.path}.parked`);
				fs.writeFileSync(first.path, original, { mode: 0o600 });
			};

			await expect(first.release()).rejects.toThrow("identity_mismatch");
			expect(fs.readFileSync(first.path)).toEqual(original);
			await first.release();
			expect(fs.readFileSync(first.path)).toEqual(original);
		},
	);

	it.skipIf(process.platform !== "linux")(
		"does not recover a closed Linux descriptor by relaxing file security",
		async () => {
			const locks = createLockRoot("release-recovery-security");
			const first = await acquireManagedLock(locks, "migration");
			const original = fs.readFileSync(first.path);
			ManagedLockTestHooks.beforeReleaseDescriptorVerification = ({ fd }) => {
				fs.closeSync(fd);
				fs.chmodSync(first.path, 0o644);
			};

			await expect(first.release()).rejects.toThrow("mode_mismatch");
			expect(fs.readFileSync(first.path)).toEqual(original);
			expect(fs.statSync(first.path).mode & 0o777).toBe(0o644);
			await first.release();
		},
	);

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

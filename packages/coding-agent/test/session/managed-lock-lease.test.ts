/**
 * Managed storage lock lease ownership (#3508).
 *
 * Long synchronous migration work can starve `setInterval` heartbeats past
 * `LOCK_LEASE_MS`. The live holder must not self-fence solely because the
 * on-disk lease timestamp elapsed while the open fd + attemptId still prove ownership.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireManagedLock } from "../../src/session/internal/managed-session-storage";

function readLock(pathname: string): {
	attemptId: string;
	leaseExpiresAt: number;
	heartbeatAt: number;
} {
	return JSON.parse(fs.readFileSync(pathname, "utf8")) as {
		attemptId: string;
		leaseExpiresAt: number;
		heartbeatAt: number;
	};
}

describe("managed storage lock lease (#3508)", () => {
	it("does not self-fence when the live holder renews after a starved lease window", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-lock-lease-"));
		const locks = path.join(root, "locks");
		fs.mkdirSync(locks, { recursive: true });
		const lock = await acquireManagedLock(locks, "migration-lease");
		try {
			const before = readLock(lock.path);
			// Simulate a JS-timer starvation window: lease fully expired, heartbeat frozen.
			const expired = {
				...before,
				heartbeatAt: before.heartbeatAt,
				leaseExpiresAt: Date.now() - 5_000,
			};
			fs.writeFileSync(lock.path, `${JSON.stringify(expired)}\n`);
			// Busy-block longer than a typical heartbeat tick would cover if we relied on setInterval alone.
			const start = Date.now();
			while (Date.now() - start < 50) {
				/* spin */
			}
			expect(() => lock.assertOwned()).not.toThrow();
			const after = readLock(lock.path);
			expect(after.attemptId).toBe(before.attemptId);
			expect(after.leaseExpiresAt).toBeGreaterThan(Date.now());
		} finally {
			await lock.release();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("still fences when the attempt id no longer matches", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-lock-fence-"));
		const locks = path.join(root, "locks");
		fs.mkdirSync(locks, { recursive: true });
		const lock = await acquireManagedLock(locks, "migration-fence");
		try {
			const current = readLock(lock.path);
			fs.writeFileSync(
				lock.path,
				`${JSON.stringify({
					...current,
					attemptId: "not-the-holder",
					leaseExpiresAt: Date.now() + 60_000,
				})}\n`,
			);
			expect(() => lock.assertOwned()).toThrow("migration_busy");
		} finally {
			try {
				await lock.release();
			} catch {
				/* holder already fenced */
			}
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

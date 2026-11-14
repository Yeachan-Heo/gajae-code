import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireManagedLock, ManagedLockTestHooks } from "../src/session/internal/managed-session-storage";

// Bounded acquisition is a contract existing production callers rely on: `acquireManagedLock`
// has to return a lease or its busy outcome inside `waitMs`. A released lease is reclaimable,
// and another process can keep releasing a fresh one under the same name, so reclaiming must
// not become a way to skip the deadline.

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	ManagedLockTestHooks.afterObservedRetirement = undefined;
});

function lockRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lock-reclaim-"));
	roots.push(root);
	return path.join(root, "locks");
}

describe("managed lock reclaim churn", () => {
	it("honors the wait deadline when released leases keep reappearing", async () => {
		const locks = lockRoot();
		const first = await acquireManagedLock(locks, "migration");
		await first.release();

		// Each retirement is immediately followed by another process releasing a fresh lease
		// under the same name, so every attempt has something reclaimable to retire.
		let retirements = 0;
		ManagedLockTestHooks.afterObservedRetirement = ({ path: retiredPath }) => {
			retirements++;
			const now = Date.now();
			fs.writeFileSync(
				retiredPath,
				`${JSON.stringify({
					attemptId: `successor-${retirements}`,
					pid: process.pid,
					processStartId: "successor-process",
					createdAt: now,
					heartbeatAt: now,
					leaseExpiresAt: now,
					released: true,
				})}\n`,
				{ mode: 0o600 },
			);
		};

		const startedAt = Date.now();
		await expect(acquireManagedLock(locks, "migration", undefined, "default", { waitMs: 200 })).rejects.toThrow(
			"migration_busy",
		);
		const elapsed = Date.now() - startedAt;
		// waitMs plus timer and I/O slack. A wider bound would only show that the call
		// returns eventually, not that the deadline bounded it, and anything near the 5s
		// default would pass even if the passed waitMs were ignored.
		expect(elapsed).toBeGreaterThanOrEqual(150);
		expect(elapsed).toBeLessThan(1_000);
		expect(retirements).toBeGreaterThanOrEqual(2);
		ManagedLockTestHooks.afterObservedRetirement = undefined;

		// Once the turnover stops, the same call still acquires normally.
		const reclaimed = await acquireManagedLock(locks, "migration");
		await reclaimed.release();
	}, 20_000);

	it("spends exactly one free reclaim before the deadline applies", async () => {
		const locks = lockRoot();
		const first = await acquireManagedLock(locks, "migration");
		await first.release();
		let retirements = 0;
		ManagedLockTestHooks.afterObservedRetirement = ({ path: retiredPath }) => {
			retirements++;
			const now = Date.now();
			fs.writeFileSync(
				retiredPath,
				`${JSON.stringify({
					attemptId: `successor-${retirements}`,
					pid: process.pid,
					processStartId: "successor-process",
					createdAt: now,
					heartbeatAt: now,
					leaseExpiresAt: now,
					released: true,
				})}\n`,
				{ mode: 0o600 },
			);
		};
		// No wait budget: the first reclaim is free, and the second has nowhere to go but
		// the deadline check. This pins the count without depending on timing.
		await expect(acquireManagedLock(locks, "migration", undefined, "default", { waitMs: 0 })).rejects.toThrow(
			"migration_busy",
		);
		expect(retirements).toBe(2);
		ManagedLockTestHooks.afterObservedRetirement = undefined;
	});

	it("still retries once so a normally released lease is not reported busy", async () => {
		const locks = lockRoot();
		const first = await acquireManagedLock(locks, "migration");
		await first.release();
		// Fail-fast acquisition has to win here: the only thing at the name is a lease the
		// previous holder already released.
		const second = await acquireManagedLock(locks, "migration", undefined, "default", { waitMs: 0 });
		await second.release();
	});
});

import { afterEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	MANAGED_SESSION_TRANSACTION_LOCK_PREFIX,
	ManagedSessionBusyError,
	ManagedSessionOwnershipLostError,
	ManagedSessionReleaseError,
	managedSessionTransactionLockName,
	withManagedSessionTransaction,
} from "../src/session/internal/managed-session-transaction";

const roots: string[] = [];
const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) child.kill();
		await child.exited;
	}
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function locksDirectory(): string {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-session-transaction-")));
	roots.push(root);
	const locks = path.join(root, "agent", "sessions", ".gjc", "locks");
	fs.mkdirSync(locks, { recursive: true, mode: 0o700 });
	return locks;
}

const SESSION_ID = "01a1b5b3-12fe-7136-9c85-ad1b859d6ca8";

describe("managed session transaction", () => {
	it("derives one stable lease name per logical session", () => {
		const first = managedSessionTransactionLockName(SESSION_ID);
		expect(managedSessionTransactionLockName(SESSION_ID)).toBe(first);
		expect(first.startsWith(MANAGED_SESSION_TRANSACTION_LOCK_PREFIX)).toBe(true);
		// Hashing keeps an arbitrary id from becoming a path component.
		expect(first).not.toContain(SESSION_ID);
		expect(managedSessionTransactionLockName(`${SESSION_ID}-other`)).not.toBe(first);
		expect(() => managedSessionTransactionLockName("")).toThrow("invalid_session_id");
	});

	it("rejects an unusable wait budget instead of silently inheriting the default", async () => {
		const directory = locksDirectory();
		for (const waitMs of [-1, Number.NaN]) {
			await expect(
				withManagedSessionTransaction(
					{ locksDirectory: directory, sessionId: SESSION_ID, waitMs },
					async () => "never",
				),
			).rejects.toThrow("invalid_lock_wait");
		}
	});

	it("serializes a second transaction on the same session and releases afterwards", async () => {
		const directory = locksDirectory();
		const held = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const first = withManagedSessionTransaction({ locksDirectory: directory, sessionId: SESSION_ID }, async () => {
			held.resolve();
			await release.promise;
			return "first";
		});
		await held.promise;
		// Same session, second writer: it must not enter while the first holds the lease.
		await expect(
			withManagedSessionTransaction(
				{ locksDirectory: directory, sessionId: SESSION_ID, waitMs: 150 },
				async () => "second",
			),
		).rejects.toBeInstanceOf(ManagedSessionBusyError);
		// A different session is not blocked by this session's lease.
		await expect(
			withManagedSessionTransaction(
				{ locksDirectory: directory, sessionId: crypto.randomUUID(), waitMs: 0 },
				async () => "other",
			),
		).resolves.toBe("other");
		release.resolve();
		await expect(first).resolves.toBe("first");
		// A released lease is reclaimed, so fail-fast callers still get in.
		await expect(
			withManagedSessionTransaction(
				{ locksDirectory: directory, sessionId: SESSION_ID, waitMs: 0 },
				async () => "reused",
			),
		).resolves.toBe("reused");
	});

	it("does not report busy for a lease that was released and reclaimed", async () => {
		const directory = locksDirectory();
		// Each successful call leaves a released lease file behind. Every later
		// fail-fast call must still acquire instead of measuring its own cleanup.
		for (const label of ["one", "two", "three"]) {
			await expect(
				withManagedSessionTransaction(
					{ locksDirectory: directory, sessionId: SESSION_ID, waitMs: 0 },
					async () => label,
				),
			).resolves.toBe(label);
		}
	});

	it("releases the lease when the body throws", async () => {
		const directory = locksDirectory();
		await expect(
			withManagedSessionTransaction({ locksDirectory: directory, sessionId: SESSION_ID }, async () => {
				throw new Error("body failed");
			}),
		).rejects.toThrow("body failed");
		await expect(
			withManagedSessionTransaction(
				{ locksDirectory: directory, sessionId: SESSION_ID, waitMs: 1000 },
				async () => "ok",
			),
		).resolves.toBe("ok");
	});

	it("fences publication and reports an unproven release once a successor owns the lease", async () => {
		const directory = locksDirectory();
		await expect(
			withManagedSessionTransaction({ locksDirectory: directory, sessionId: SESSION_ID }, async scope => {
				expect(() => scope.assertOwned()).not.toThrow();
				// Simulate a real stale reclaim: a valid successor record replaces this
				// process's lease. Ownership is resolved on file identity, so this covers the
				// replaced-file path; the attemptId guard is a second, independent check.
				fs.unlinkSync(scope.lockPath);
				const now = Date.now();
				fs.writeFileSync(
					scope.lockPath,
					`${JSON.stringify({
						attemptId: crypto.randomUUID(),
						pid: process.pid,
						bootId: "successor",
						processStartId: "successor",
						createdAt: now,
						heartbeatAt: now,
						leaseExpiresAt: now + 60_000,
					})}\n`,
					{ mode: 0o600 },
				);
				expect(() => scope.assertOwned()).toThrow(ManagedSessionOwnershipLostError);
				return "published";
			}),
		).rejects.toMatchObject({
			code: "managed_session_release_failed",
			sessionId: SESSION_ID,
			// The body completed, so the caller learns what it could not prove was released.
			outcome: "published",
			bodyError: undefined,
		});
	});

	it("carries the body error when both the body and the release fail", async () => {
		const directory = locksDirectory();
		const failure = await withManagedSessionTransaction(
			{ locksDirectory: directory, sessionId: SESSION_ID },
			async scope => {
				fs.unlinkSync(scope.lockPath);
				throw new Error("publish failed");
			},
		).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(ManagedSessionReleaseError);
		const release = failure as ManagedSessionReleaseError;
		expect(release.sessionId).toBe(SESSION_ID);
		expect((release.bodyError as Error).message).toBe("publish failed");
		expect(release.cause).toBeInstanceOf(Error);
	});

	it("excludes a real second process and frees the session when that process exits", async () => {
		const directory = locksDirectory();
		const scratch = path.dirname(directory);
		const script = path.join(import.meta.dirname, "fixtures", "managed-session-transaction-holder.ts");
		const spawnHolder = (name: string, waitMs: number) => {
			const ready = path.join(scratch, `${name}-ready`);
			const release = path.join(scratch, `${name}-release`);
			const child = Bun.spawn([process.execPath, script, directory, SESSION_ID, ready, release], {
				cwd: path.dirname(import.meta.dirname),
				env: { ...process.env, GJC_TEST_TRANSACTION_WAIT_MS: String(waitMs) },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			children.push(child);
			return {
				child,
				ready,
				release: () => fs.writeFileSync(release, "go\n"),
				waitForHold: async () => {
					const deadline = Date.now() + 15_000;
					while (!fs.existsSync(ready) && Date.now() < deadline) await Bun.sleep(20);
					expect(fs.existsSync(ready)).toBe(true);
				},
			};
		};
		const holder = spawnHolder("holder", 250);
		await holder.waitForHold();
		const holderPid = fs.readFileSync(holder.ready, "utf8").trim();

		const loser = spawnHolder("loser", 250);
		expect(await loser.child.exited).toBe(1);
		expect(await new Response(loser.child.stderr).text()).toContain("managed_session_transaction_busy");
		// The loser never entered: it would have rewritten the holder's ready marker.
		expect(fs.existsSync(loser.ready)).toBe(false);
		expect(fs.readFileSync(holder.ready, "utf8").trim()).toBe(holderPid);

		holder.release();
		expect(await holder.child.exited).toBe(0);

		const winner = spawnHolder("winner", 5000);
		await winner.waitForHold();
		winner.release();
		expect(await winner.child.exited).toBe(0);
	}, 30_000);
});

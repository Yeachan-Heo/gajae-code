import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { managedSessionTransactionLocksDirectory } from "../src/session/internal/managed-session-scope";
import {
	ManagedSessionBusyError,
	ManagedSessionOwnershipLostError,
	ManagedSessionReleaseError,
	withManagedSessionTransaction,
} from "../src/session/internal/managed-session-transaction";

// The lease lives inside the session directory, so relocating that directory moves the
// lease with it. These cases pin what that does to ownership fencing and to the
// destination's availability, because both answers are surprising and neither is obvious
// from the lock contract alone.

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function sessionDirectory(): Promise<{ root: string; directory: string; relocated: string }> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-transaction-relocation-")));
	roots.push(root);
	const directory = path.join(root, "sessions", "project");
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	return { root, directory, relocated: path.join(root, "sessions", "project-moved") };
}

const sessionId = "01a1b5b3-12fe-7136-9c85-ad1b859d6ca8";

describe("transaction lease across directory relocation", () => {
	it("fails ownership fencing once the directory the lease was named in is gone", async () => {
		const { directory, relocated } = await sessionDirectory();
		const locksDirectory = managedSessionTransactionLocksDirectory(directory);
		await fs.mkdir(locksDirectory, { recursive: true, mode: 0o700 });
		const held = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const outcome = withManagedSessionTransaction({ locksDirectory, sessionId }, async scope => {
			scope.assertOwned();
			held.resolve();
			await resume.promise;
			// The lease file moved with the directory, so the name it was verified against
			// no longer exists. Ownership is unprovable, which has to surface rather than
			// let a publication proceed under a lease this process can no longer show.
			try {
				scope.assertOwned();
				return { fenced: false as const };
			} catch (error) {
				return {
					fenced: error instanceof ManagedSessionOwnershipLostError ? ("lost" as const) : ("other" as const),
				};
			}
		});
		await held.promise;
		await fs.rename(directory, relocated);
		resume.resolve();
		// Release is unproven for the same reason, so the transaction reports it instead of
		// pretending the lease was returned. Assert through that error, because a rejection
		// from the release path supersedes anything the body would have thrown.
		const failure = await outcome.then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(ManagedSessionReleaseError);
		const release = failure as ManagedSessionReleaseError;
		expect(release.bodyError).toBeUndefined();
		expect(release.outcome).toEqual({ fenced: "lost" });
	});

	it("keeps the relocated directory busy while the moved holder is alive", async () => {
		const { directory, relocated } = await sessionDirectory();
		const locksDirectory = managedSessionTransactionLocksDirectory(directory);
		await fs.mkdir(locksDirectory, { recursive: true, mode: 0o700 });
		const held = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const outcome = withManagedSessionTransaction({ locksDirectory, sessionId }, async () => {
			held.resolve();
			await resume.promise;
			return "held";
		}).catch((error: unknown) => error);
		await held.promise;
		await fs.rename(directory, relocated);
		const relocatedLocks = managedSessionTransactionLocksDirectory(relocated);
		// The lease moved with the directory, so the destination inherits the contention for
		// as long as that holder lives. Expiry alone never frees it: reclaim needs the owner
		// to be gone, which this case does not simulate.
		await expect(
			withManagedSessionTransaction(
				{ locksDirectory: relocatedLocks, sessionId, waitMs: 150 },
				async () => "second",
			),
		).rejects.toBeInstanceOf(ManagedSessionBusyError);
		resume.resolve();
		await outcome;
	});
});

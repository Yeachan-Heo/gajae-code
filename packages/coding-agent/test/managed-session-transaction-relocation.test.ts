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
			let caught: unknown;
			try {
				scope.assertOwned();
			} catch (error) {
				caught = error;
			}
			resume.resolve();
			if (caught === undefined) return { fenced: false as const };
			expect(caught).toBeInstanceOf(ManagedSessionOwnershipLostError);
			return { fenced: true as const };
		});
		await held.promise;
		await fs.rename(directory, relocated);
		resume.resolve();
		// Release is unproven for the same reason, so the transaction reports it instead of
		// pretending the lease was returned.
		await expect(outcome).rejects.toBeInstanceOf(ManagedSessionReleaseError);
	});

	it("keeps the relocated directory busy until that lease expires", async () => {
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
		// The lease moved with the directory, so the destination inherits the contention and
		// a second opener there cannot proceed until it expires or is reclaimed.
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

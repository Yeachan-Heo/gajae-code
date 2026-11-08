import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	ManagedCommittedMutationError,
	ManagedSessionDescendantStore,
} from "../src/session/internal/managed-session-storage";
import { SessionAppendPersistenceError, SessionManager } from "../src/session/session-manager";

// Phase C requires rollback to remove only definitely uncommitted work. The other half
// of that sentence is that an append whose write may have committed must stay resident
// and armed for the rewrite that carries its effect. That half had no coverage at the
// manager level: the discarded half is already pinned by managed-rollback-contract.
//
// The injection replaces the store method the fence calls, so the real retention branch
// runs, but the sentinel is shaped like production rather than being a native failure.

const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function persistedManager(): Promise<SessionManager> {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-managed-retention-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	managers.push(manager);
	manager.appendMessage({ role: "user" as const, content: "root", timestamp: 1 });
	await manager.ensureOnDisk();
	return manager;
}

describe("retention after an uncertain managed append", () => {
	it("keeps the entry resident, reachable and armed for the next rewrite", async () => {
		const manager = await persistedManager();
		const entriesBefore = manager.getEntries().map(entry => entry.id);
		const leafBefore = manager.getLeafId();
		const original = ManagedSessionDescendantStore.prototype.appendExpectedIdentitySync;
		vi.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedIdentitySync").mockImplementation(function (
			this: ManagedSessionDescendantStore,
			...args: Parameters<typeof original>
		) {
			// Write first, then report the outcome as uncertain: the shape the
			// committed-uncertain branch exists for.
			original.apply(this, args);
			throw new ManagedCommittedMutationError("append", new Error("committed_outcome_uncertain"));
		});

		let thrown: unknown;
		try {
			manager.appendMessage({ role: "user" as const, content: "attempt", timestamp: 2 });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(SessionAppendPersistenceError);
		const failure = thrown as SessionAppendPersistenceError;

		// Retained: dropping it would lose a write that may already be on disk.
		expect(manager.getEntries().map(entry => entry.id)).toEqual([...entriesBefore, failure.entryId]);
		// Reachable: an entry that survives but is unlinked from the leaf is invisible to
		// the branch a caller actually reads next.
		expect(manager.getEntry(failure.entryId)).toBeDefined();
		expect(manager.getLeafId()).toBe(failure.entryId);
		expect(manager.getLeafId()).not.toBe(leafBefore);
		// Armed: the retained effect only reaches disk through a full rewrite.
		expect(manager.captureState().needsFullRewriteOnNextPersist).toBe(true);
		// A definite failure surfaces as a different error class entirely
		// (ManagedAppendIdentityMismatchError), while every wrapped failure reports this
		// phase, so residency cannot be read off the outcome.
		expect(failure.phase).toBe("current_append");
	});
});

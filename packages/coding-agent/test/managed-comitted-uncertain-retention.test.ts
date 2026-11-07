import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	ManagedCommittedMutationError,
	ManagedSessionDescendantStore,
} from "../src/session/internal/managed-session-storage";
import { SessionAppendPersistenceError, SessionManager } from "../src/session/session-manager";

// Phase C requires rollback to remove only definitely uncommitted work. The other half
// is that a write which may have committed must stay resident, because the next
// whole-file rewrite is what carries its effect. Both halves are forced here through
// the managed store so the difference is pinned at the manager, not assumed from the
// error type.

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

function appendFailure(manager: SessionManager, injected: Error): SessionAppendPersistenceError {
	let thrown: unknown;
	try {
		manager.appendMessage({ role: "user" as const, content: "attempt", timestamp: 2 });
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(SessionAppendPersistenceError);
	const failure = thrown as SessionAppendPersistenceError;
	expect(failure.cause).toBeInstanceOf(Error);
	expect(injected).toBeInstanceOf(ManagedCommittedMutationError);
	return failure;
}

describe("retention after an uncertain managed append", () => {
	it("discards the entry when the write provably did not commit", async () => {
		const manager = await persistedManager();
		const entriesBefore = manager.getEntries().map(entry => entry.id);
		vi.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedIdentitySync").mockImplementation(() => {
			throw new Error("managed_append_failed");
		});

		let thrown: unknown;
		try {
			manager.appendMessage({ role: "user" as const, content: "attempt", timestamp: 2 });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(SessionAppendPersistenceError);
		// The discarded half: nothing may survive for a later rewrite to republish.
		expect(manager.getEntries().map(entry => entry.id)).toEqual(entriesBefore);
		expect(JSON.stringify(manager.getEntries())).not.toContain("attempt");
	});

	it("keeps the entry resident when the write may have committed", async () => {
		const manager = await persistedManager();
		const entriesBefore = manager.getEntries().map(entry => entry.id);
		const injected = new ManagedCommittedMutationError("append", new Error("committed_outcome_uncertain"));
		vi.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedIdentitySync").mockImplementation(() => {
			throw injected;
		});

		const failure = appendFailure(manager, injected);
		// Recorded because reconciliation needs the retained/discarded distinction, and the
		// phase string alone does not carry it: both halves report current_append.
		expect(failure.phase).toBe("current_append");

		// Retained: the effect is carried by the next rewrite, so dropping it would lose
		// a write that may already be on disk.
		const entriesAfter = manager.getEntries().map(entry => entry.id);
		expect(entriesAfter).toHaveLength(entriesBefore.length + 1);
		expect(JSON.stringify(manager.getEntries())).toContain("attempt");
	});
});

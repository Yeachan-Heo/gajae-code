import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ManagedAppendIdentityMismatchError } from "../src/session/internal/managed-session-storage";
import { SessionManager } from "../src/session/session-manager";

// Current storage behavior, characterized before any shared-writer work. Several
// earlier planning conclusions came from fixtures that never persisted at all, so
// every precondition here is asserted rather than assumed.
//
// Two cases deliberately assert behavior the shared-branch work intends to replace:
// the deleted-transcript recreation case and the latched-rejection case. They are the
// red tests for the later phases and must be inverted, not deleted, when those phases
// land.

const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function makeWorkspace(): Promise<{ cwd: string; agentDir: string }> {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-contract-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	return { cwd, agentDir };
}

function createManager(cwd: string, agentDir: string): SessionManager {
	const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	managers.push(manager);
	return manager;
}

async function openManager(file: string, cwd: string, agentDir: string): Promise<SessionManager> {
	const manager = await SessionManager.open(file, SessionManager.managedDestination(cwd, agentDir));
	managers.push(manager);
	return manager;
}

function user(text: string, timestamp: number) {
	return { role: "user" as const, content: text, timestamp };
}

/** Persist a session and return its transcript path, proving the file exists. */
async function persistSession(
	cwd: string,
	agentDir: string,
): Promise<{ manager: SessionManager; file: string; rootId: string; tipId: string }> {
	const manager = createManager(cwd, agentDir);
	const rootId = manager.appendMessage(user("root", 1));
	const tipId = manager.appendMessage(user("tip", 2));
	// A user-only transcript is deliberately not written until durable admission, so
	// the fixture forces publication instead of assuming flush() creates the file.
	await manager.ensureOnDisk();
	const file = manager.getSessionFile();
	if (!file) throw new Error("expected a transcript path after durable admission");
	expect(await Bun.file(file).exists()).toBe(true);
	return { manager, file, rootId, tipId };
}

describe("shared session transcript contract", () => {
	it("does not create a transcript before durable admission", async () => {
		const { cwd, agentDir } = await makeWorkspace();
		const manager = createManager(cwd, agentDir);
		manager.appendMessage(user("root", 1));
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a candidate transcript path");
		// A path can exist without the file existing: this is the fixture hazard that
		// produced the earlier "resume changed the session id" conclusion.
		expect(await Bun.file(file).exists()).toBe(false);
		await manager.ensureOnDisk();
		expect(await Bun.file(file).exists()).toBe(true);
	});

	it("preserves the logical session id across a persisted reopen", async () => {
		const { cwd, agentDir } = await makeWorkspace();
		const { manager, file } = await persistSession(cwd, agentDir);
		expect(manager.getSessionId().length).toBeGreaterThan(0);
		const reopened = await openManager(file, cwd, agentDir);
		expect(reopened.getSessionId()).toBe(manager.getSessionId());
	});

	it("does not persist a non-tip cursor selection", async () => {
		const { cwd, agentDir } = await makeWorkspace();
		const { manager, file, rootId, tipId } = await persistSession(cwd, agentDir);
		expect(tipId).not.toBe(rootId);
		// Move the live cursor to the root and reopen: the transcript carries no
		// selection, so the cursor comes back as the last persisted record.
		manager.branch(rootId);
		expect(manager.getLeafId()).toBe(rootId);
		const reopened = await openManager(file, cwd, agentDir);
		expect(reopened.getLeafId()).not.toBe(rootId);
		expect(reopened.getLeafId()).toBe(tipId);
	});

	it("rejects a stale second writer while keeping both cursors and the committed branch", async () => {
		const { cwd, agentDir } = await makeWorkspace();
		const { manager: a, file, tipId: sharedParent } = await persistSession(cwd, agentDir);
		const b = await openManager(file, cwd, agentDir);
		expect(b.getLeafId()).toBe(sharedParent);

		const a1 = a.appendMessage(user("from A", 3));
		await a.flush();

		const before = await Bun.file(file).text();
		expect(() => b.appendMessage(user("from B", 4))).toThrow(ManagedAppendIdentityMismatchError);
		// The rejection is pre-write: the transcript keeps A's branch verbatim.
		expect(await Bun.file(file).text()).toBe(before);
		// B's cursor never moved to A's branch, and A's entry is the committed child.
		expect(b.getLeafId()).toBe(sharedParent);
		const entries = Bun.JSONL.parse(before) as Array<{ type: string; id?: string; parentId?: string | null }>;
		expect(entries.find(entry => entry.id === a1)?.parentId).toBe(sharedParent);
	});

	it("latches the rejection instead of allowing an in-process retry", async () => {
		const { cwd, agentDir } = await makeWorkspace();
		const { manager: a, file, tipId: sharedParent } = await persistSession(cwd, agentDir);
		const b = await openManager(file, cwd, agentDir);
		a.appendMessage(user("from A", 3));
		await a.flush();

		expect(() => b.appendMessage(user("from B", 4))).toThrow(ManagedAppendIdentityMismatchError);
		// Every later send from the same process fails the same way: recovery today is
		// reopen or replace the manager, not retry. Phase C must decide which of those
		// the shared path requires.
		expect(() => b.appendMessage(user("from B again", 5))).toThrow(ManagedAppendIdentityMismatchError);
		expect(b.getLeafId()).toBe(sharedParent);
		const committed = await Bun.file(file).text();
		expect(committed).not.toContain("from B");
	});

	it("rejects an append after the transcript was externally truncated and does not rewrite it", async () => {
		const { cwd, agentDir } = await makeWorkspace();
		const { file } = await persistSession(cwd, agentDir);
		const b = await openManager(file, cwd, agentDir);
		const lines = (await Bun.file(file).text()).split("\n").filter(Boolean);
		const headerOnly = `${lines[0]}\n`;
		await Bun.write(file, headerOnly);

		expect(() => b.appendMessage(user("orphan", 3))).toThrow(ManagedAppendIdentityMismatchError);
		// A rejected send must not resurrect a transcript the owner changed.
		expect(await Bun.file(file).text()).toBe(headerOnly);
	});

	it("recreates a deleted transcript from the resident graph", async () => {
		// Red test for the later phases: a stale writer treats a deleted transcript as
		// a missing predecessor and republishes the whole resident graph through the
		// rewrite path. Deletion must become lifecycle-authorized instead.
		const { cwd, agentDir } = await makeWorkspace();
		const { file } = await persistSession(cwd, agentDir);
		const b = await openManager(file, cwd, agentDir);
		const resident = await Bun.file(file).text();
		await fs.rm(file);
		expect(await Bun.file(file).exists()).toBe(false);

		b.appendMessage(user("revived", 3));
		await b.flush();

		expect(await Bun.file(file).exists()).toBe(true);
		const republished = await Bun.file(file).text();
		expect(republished).toContain("revived");
		// The resident graph, not just the new entry, is what lands on disk.
		expect(republished).toContain("root");
		expect(republished).not.toBe(resident);
	});
});

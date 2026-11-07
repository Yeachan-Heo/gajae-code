import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ManagedAppendIdentityMismatchError } from "../src/session/internal/managed-session-storage";
import { SessionManager } from "../src/session/session-manager";

// Contract pinned before any shared-writer work: these assertions describe what a
// transcript on disk actually guarantees today. Several earlier planning conclusions
// came from fixtures that never persisted at all, so the preconditions here are
// asserted rather than assumed.

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

/** Persist a session with one committed root entry and return its transcript path. */
async function persistRoot(cwd: string, agentDir: string): Promise<{ manager: SessionManager; file: string }> {
	const manager = createManager(cwd, agentDir);
	manager.appendMessage(user("root", 1));
	// A user-only transcript is deliberately not written until durable admission, so
	// the fixture must force publication instead of assuming flush() creates the file.
	await manager.ensureOnDisk();
	const file = manager.getSessionFile();
	if (!file) throw new Error("expected a transcript path after durable admission");
	expect(await Bun.file(file).exists()).toBe(true);
	return { manager, file };
}

describe("shared session transcript contract", () => {
	it("does not create a transcript before durable admission", async () => {
		const { cwd, agentDir } = await makeWorkspace();
		const manager = createManager(cwd, agentDir);
		manager.appendMessage(user("root", 1));
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a candidate transcript path");
		// Pins the fixture hazard: a path can exist without the file existing.
		expect(await Bun.file(file).exists()).toBe(false);
	});

	it("preserves logical identity and cursor across a persisted reopen", async () => {
		const { cwd, agentDir } = await makeWorkspace();
		const { manager, file } = await persistRoot(cwd, agentDir);
		const reopened = await openManager(file, cwd, agentDir);
		expect(reopened.getSessionId()).toBe(manager.getSessionId());
		expect(reopened.getLeafId()).toBe(manager.getLeafId());
		expect(reopened.getSessionId().length).toBeGreaterThan(0);
	});

	it("rejects a stale second writer while keeping both cursors and the committed branch", async () => {
		const { cwd, agentDir } = await makeWorkspace();
		const { manager: a, file } = await persistRoot(cwd, agentDir);
		const b = await openManager(file, cwd, agentDir);
		const sharedParent = b.getLeafId();
		if (!sharedParent) throw new Error("expected a committed leaf after reopen");

		const a1 = a.appendMessage(user("from A", 2));
		await a.flush();

		const before = await Bun.file(file).text();
		expect(() => b.appendMessage(user("from B", 3))).toThrow(ManagedAppendIdentityMismatchError);
		// The rejection is pre-write: the transcript keeps A's branch verbatim.
		expect(await Bun.file(file).text()).toBe(before);
		// B's cursor never moved to A's branch, and A's entry is still the committed child.
		expect(b.getLeafId()).toBe(sharedParent);
		const entries = Bun.JSONL.parse(before) as Array<{ type: string; id?: string; parentId?: string | null }>;
		const a1Entry = entries.find(entry => entry.id === a1);
		expect(a1Entry?.parentId).toBe(sharedParent);
	});

	it("refuses a send whose committed parent is gone without rewriting the transcript", async () => {
		const { cwd, agentDir } = await makeWorkspace();
		const { file } = await persistRoot(cwd, agentDir);
		const b = await openManager(file, cwd, agentDir);
		const lines = (await Bun.file(file).text()).split("\n").filter(Boolean);
		const headerOnly = `${lines[0]}\n`;
		await Bun.write(file, headerOnly);

		expect(() => b.appendMessage(user("orphan", 2))).toThrow(ManagedAppendIdentityMismatchError);
		// A rejected send must not resurrect a transcript the owner changed.
		expect(await Bun.file(file).text()).toBe(headerOnly);
	});
});

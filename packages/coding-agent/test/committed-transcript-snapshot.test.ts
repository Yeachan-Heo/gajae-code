import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager } from "../src/session/session-manager";

// A refresh has to start from the committed transcript, never from this process's
// cursor or from entries it has not published. Otherwise a later phase would adopt a
// local branch as canonical and publish it over someone else's.

const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function makeWorkspace(): Promise<{ cwd: string; agentDir: string }> {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-committed-snapshot-"));
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

function user(text: string, timestamp: number) {
	return { role: "user" as const, content: text, timestamp };
}

describe("committed transcript snapshot", () => {
	it("returns null until the transcript has been published", async () => {
		const { cwd, agentDir } = await makeWorkspace();
		const manager = createManager(cwd, agentDir);
		expect(await manager.captureCommittedSnapshot()).toBeNull();
		manager.appendMessage(user("root", 1));
		// Admission is not publication, so there is still nothing committed to read.
		expect(await manager.captureCommittedSnapshot()).toBeNull();
		await manager.ensureOnDisk();
		const snapshot = await manager.captureCommittedSnapshot();
		expect(snapshot).not.toBeNull();
		expect(snapshot?.entryIds).toHaveLength(1);
	});

	it("describes the file on disk rather than the live cursor", async () => {
		const { cwd, agentDir } = await makeWorkspace();
		const manager = createManager(cwd, agentDir);
		const rootId = manager.appendMessage(user("root", 1));
		const tipId = manager.appendMessage(user("tip", 2));
		await manager.ensureOnDisk();

		// Move the live cursor to an older entry: the committed transcript did not change,
		// so a canonical read must not follow the cursor.
		manager.branch(rootId);
		expect(manager.getLeafId()).toBe(rootId);

		const snapshot = await manager.captureCommittedSnapshot();
		if (!snapshot) throw new Error("expected a committed snapshot");
		expect(snapshot.leafId).toBe(tipId);
		expect(snapshot.entryIds).toEqual([rootId, tipId]);
		expect(snapshot.sessionId).toBe(manager.getSessionId());
		// The digest covers exactly the bytes on disk, so a later publish can prove the
		// file it validated is the file it writes against.
		const onDisk = await Bun.file(snapshot.sessionFile).bytes();
		expect(snapshot.size).toBe(onDisk.byteLength);
		expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/u);
	});

	it("shows an append immediately once the session is published", async () => {
		// A managed session that has been ensured on disk publishes every later append
		// eagerly, so "pending local entry" is not a lasting state there. Phase C must
		// not model a long-lived pending overlay for this path without re-checking that.
		const { cwd, agentDir } = await makeWorkspace();
		const manager = createManager(cwd, agentDir);
		manager.appendMessage(user("committed", 1));
		await manager.ensureOnDisk();
		const before = await manager.captureCommittedSnapshot();
		if (!before) throw new Error("expected a committed snapshot");

		const appended = manager.appendMessage(user("second", 2));
		const after = await manager.captureCommittedSnapshot();
		if (!after) throw new Error("expected a committed snapshot");
		expect(after.entryIds).toEqual([...before.entryIds, appended]);
		expect(after.digest).not.toBe(before.digest);
	});

	it("tracks another process's committed append", async () => {
		const { cwd, agentDir } = await makeWorkspace();
		const writer = createManager(cwd, agentDir);
		writer.appendMessage(user("root", 1));
		await writer.ensureOnDisk();
		const file = writer.getSessionFile();
		if (!file) throw new Error("expected a transcript path");
		const reader = await SessionManager.open(file, SessionManager.managedDestination(cwd, agentDir));
		managers.push(reader);
		const before = await reader.captureCommittedSnapshot();
		if (!before) throw new Error("expected a committed snapshot");

		const appended = writer.appendMessage(user("from writer", 2));
		await writer.flush();

		const after = await reader.captureCommittedSnapshot();
		if (!after) throw new Error("expected a committed snapshot");
		expect(after.entryIds).toEqual([...before.entryIds, appended]);
		expect(after.digest).not.toBe(before.digest);
		// Reading the transcript must not adopt the other writer's branch as this cursor.
		expect(reader.getLeafId()).toBe(before.leafId);
	});
});

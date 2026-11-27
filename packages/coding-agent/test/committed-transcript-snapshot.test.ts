import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
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
	it("reports absent until the transcript has been published", async () => {
		const { cwd, agentDir } = await makeWorkspace();
		const manager = createManager(cwd, agentDir);
		expect((await manager.captureCommittedSnapshot()).kind).toBe("absent");
		manager.appendMessage(user("root", 1));
		// Admission is not publication, so there is still nothing committed to read.
		expect((await manager.captureCommittedSnapshot()).kind).toBe("absent");
		await manager.ensureOnDisk();
		const read = await manager.captureCommittedSnapshot();
		if (read.kind !== "snapshot") throw new Error(`expected a snapshot, got ${read.kind}`);
		expect(read.snapshot.entryIds).toHaveLength(1);
	});

	it("reports unsupported instead of empty for a transcript it cannot interpret", async () => {
		const { cwd, agentDir } = await makeWorkspace();
		const manager = createManager(cwd, agentDir);
		manager.appendMessage(user("root", 1));
		await manager.ensureOnDisk();
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a transcript path");
		const lines = (await Bun.file(file).text()).split("\n").filter(Boolean);
		const header = JSON.parse(lines[0]!) as Record<string, unknown>;
		header.version = 99;
		await Bun.write(file, `${JSON.stringify(header)}\n${lines.slice(1).join("\n")}\n`);

		// A caller must not read this as an empty session and publish over it.
		expect((await manager.captureCommittedSnapshot()).kind).toBe("unsupported");
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

		const read = await manager.captureCommittedSnapshot();
		if (read.kind !== "snapshot") throw new Error(`expected a snapshot, got ${read.kind}`);
		const snapshot = read.snapshot;
		expect(snapshot.leafId).toBe(tipId);
		expect(snapshot.entryIds).toEqual([rootId, tipId]);
		expect(snapshot.sessionId).toBe(manager.getSessionId());
		// The digest must be the digest of the bytes on disk, because a later publish
		// proves it validated that exact file.
		const onDisk = await Bun.file(snapshot.sessionFile).bytes();
		expect(snapshot.size).toBe(onDisk.byteLength);
		expect(snapshot.digest).toBe(createHash("sha256").update(onDisk).digest("hex"));
	});

	it("shows an append immediately once the session is published", async () => {
		// A managed session that has been ensured on disk publishes every later append
		// eagerly, so "pending local entry" is not a lasting state there. Phase C must
		// not model a long-lived pending overlay for this path without re-checking that.
		const { cwd, agentDir } = await makeWorkspace();
		const manager = createManager(cwd, agentDir);
		manager.appendMessage(user("committed", 1));
		await manager.ensureOnDisk();
		const beforeRead = await manager.captureCommittedSnapshot();
		if (beforeRead.kind !== "snapshot") throw new Error("expected a committed snapshot");
		const before = beforeRead.snapshot;

		const appended = manager.appendMessage(user("second", 2));
		const afterRead = await manager.captureCommittedSnapshot();
		if (afterRead.kind !== "snapshot") throw new Error("expected a committed snapshot");
		const after = afterRead.snapshot;
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
		const beforeRead = await reader.captureCommittedSnapshot();
		if (beforeRead.kind !== "snapshot") throw new Error("expected a committed snapshot");
		const before = beforeRead.snapshot;

		const appended = writer.appendMessage(user("from writer", 2));
		await writer.flush();

		const afterRead = await reader.captureCommittedSnapshot();
		if (afterRead.kind !== "snapshot") throw new Error("expected a committed snapshot");
		const after = afterRead.snapshot;
		expect(after.entryIds).toEqual([...before.entryIds, appended]);
		expect(after.digest).not.toBe(before.digest);
		// Reading the transcript must not adopt the other writer's branch as this cursor.
		expect(reader.getLeafId()).toBe(before.leafId);
	});
});

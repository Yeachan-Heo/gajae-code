import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type SessionDestination, SessionManager } from "../src/session/session-manager";

// The goal this whole phase exists for: two processes open one session and one transcript.
// Each keeps its own cursor and publishes children of it, so their turns form sibling
// branches instead of overwriting one another, and neither blocks the other for its
// lifetime. Only the persistence step is serialized.

const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function sharedSession(): Promise<{
	file: string;
	destination: SessionDestination;
	anchorId: string;
	first: SessionManager;
	second: SessionManager;
}> {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-sibling-branch-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const writer = SessionManager.create(cwd, destination);
	managers.push(writer);
	writer.appendMessage({ role: "user" as const, content: "shared root", timestamp: 1 });
	await writer.ensureOnDisk();
	const file = writer.getSessionFile();
	if (!file) throw new Error("expected a transcript path");
	const anchorId = writer.getLeafId();
	if (!anchorId) throw new Error("expected a committed leaf");

	const first = await SessionManager.open(file, destination);
	const second = await SessionManager.open(file, destination);
	managers.push(first, second);
	return { file, destination, anchorId, first, second };
}

function user(text: string, timestamp: number) {
	return { role: "user" as const, content: text, timestamp };
}

describe("sibling branch publication", () => {
	it("lets each opener publish children of its own cursor into one transcript", async () => {
		const { file, destination, anchorId, first, second } = await sharedSession();

		// A advances twice; B has not seen either entry.
		const a1 = await first.appendMessageSharingSession(user("A1", 2));
		if (a1.kind !== "committed") throw new Error(`A1 failed: ${a1.kind}`);
		expect(first.getLeafId()).toBe(a1.id);

		// B still publishes, as a sibling under the shared anchor, not under A1.
		const b1 = await second.appendMessageSharingSession(user("B1", 3));
		if (b1.kind !== "committed") throw new Error(`B1 failed: ${b1.kind}`);
		expect(second.getLeafId()).toBe(b1.id);

		// A continues from its own branch without being moved by B's publish.
		const a2 = await first.appendMessageSharingSession(user("A2", 4));
		if (a2.kind !== "committed") throw new Error(`A2 failed: ${a2.kind}`);
		expect(first.getLeafId()).toBe(a2.id);

		// One transcript holds all four entries, with A's and B's chains distinct.
		const reopened = await SessionManager.open(file, destination);
		managers.push(reopened);
		const entries = new Map(reopened.getEntries().map(entry => [entry.id, entry]));
		expect(entries.get(a1.id)?.parentId).toBe(anchorId);
		expect(entries.get(b1.id)?.parentId).toBe(anchorId);
		expect(entries.get(a2.id)?.parentId).toBe(a1.id);
		// Each opener still reads its own chain after the shared writes.
		expect(first.getBranch().map(entry => entry.id)).toEqual([anchorId, a1.id, a2.id]);
		expect(second.getBranch().map(entry => entry.id)).toEqual([anchorId, b1.id]);
	});

	it("reports stale instead of publishing after persistence latched", async () => {
		const { file, first, second } = await sharedSession();
		// The first opener writes, which makes the second's identity stale; its own direct
		// append is then rejected and latches the manager.
		first.appendMessage(user("A0", 2));
		await first.flush();
		expect(() => second.appendMessage(user("direct", 3))).toThrow();
		expect(await second.appendMessageSharingSession(user("B1", 3))).toMatchObject({
			kind: "stale",
			reason: "persistence_latched",
		});
		// The first opener is unaffected and still shares the transcript.
		const a1 = await first.appendMessageSharingSession(user("A1", 4));
		expect(a1.kind).toBe("committed");
		expect(await Bun.file(file).text()).toContain("A1");
	});
});

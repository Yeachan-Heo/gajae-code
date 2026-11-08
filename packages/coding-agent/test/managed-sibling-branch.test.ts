import { afterEach, describe, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type SessionDestination, SessionManager, SessionManagerTestHooks } from "../src/session/session-manager";

// The goal this phase exists for: two openers of one session and one transcript each keep
// their own cursor and publish children of it, so their turns form sibling branches instead
// of overwriting one another.
//
// What these cases pin: sibling parent chains in one transcript with each opener still
// reading its own chain, and four refusals - rewrite debt, a latched manager, an unreadable
// or truncated transcript, a deleted transcript - plus the rewrite choke point, reached by
// deleting the transcript inside the publish step so the append would have to rebuild it.
//
// What they do not pin: overlapping execution and lease exclusion (the cases are sequential
// and would pass with the lease removed), a foreign but valid replacement refused through the
// identity fence, the `rejected` outcome, and a cursor missing from a non-empty transcript.

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

	it("refuses the rebuild that a missing transcript would force", async () => {
		const { file, first } = await sharedSession();
		// Deleting the transcript mid-publish is the missing-predecessor case: the append lane
		// would rebuild the file from this process's resident entries, which is a rewrite and
		// would drop anything another opener had committed.
		SessionManagerTestHooks.beforeSharedAppendPublish = () => {
			SessionManagerTestHooks.beforeSharedAppendPublish = undefined;
			fsSync.rmSync(file);
		};
		const outcome = await first.appendMessageSharingSession(user("A1", 2));
		expect(outcome).toMatchObject({ kind: "stale", reason: "rewrite_required" });
		expect(fsSync.existsSync(file)).toBe(false);
		// The append is not resident either: a refused publish must not leave a phantom leaf.
		expect(first.getBranch().some(entry => JSON.stringify(entry).includes("A1"))).toBe(false);
	});

	it("refuses to publish while it owes a whole-file rewrite", async () => {
		const { file, first } = await sharedSession();
		// A patch on a resident entry arms rewrite debt, which is the state where a shared
		// append would republish this process's view over another opener's branch.
		const before = await Bun.file(file).text();
		const messages = first.getBranch().filter(entry => entry.type === "message");
		first.applyEntryMessageUpdates(messages as never);
		expect(await first.appendMessageSharingSession(user("A1", 2))).toMatchObject({
			kind: "stale",
			reason: "rewrite_required",
		});
		expect(await Bun.file(file).text()).toBe(before);
	});

	it("refuses instead of republishing when its transcript was replaced", async () => {
		const { file, first } = await sharedSession();
		const a1 = await first.appendMessageSharingSession(user("A1", 2));
		if (a1.kind !== "committed") throw new Error("expected a committed append");
		// An external truncation leaves this process holding a cursor the transcript no
		// longer carries. Republishing the resident view here is exactly what a sibling
		// branch must never do.
		await Bun.write(file, "");
		const outcome = await first.appendMessageSharingSession(user("A2", 3));
		expect(outcome.kind).toBe("stale");
		expect(await Bun.file(file).text()).toBe("");
		// The same holds for a deleted transcript: recreating it from the resident view is a
		// rewrite, so a shared append declines instead of reviving its own branch alone.
		await fs.rm(file);
		expect((await first.appendMessageSharingSession(user("A3", 4))).kind).toBe("stale");
		expect(await Bun.file(file).exists()).toBe(false);
	});

	it("reports stale instead of publishing after persistence latched", async () => {
		const { file, first, second } = await sharedSession();
		// The first opener writes, which makes the second's identity stale; its own direct
		// append is then rejected and latches the manager.
		first.appendMessage(user("A0", 2));
		await first.flush();
		const beforeRefusal = await Bun.file(file).text();
		const secondLeafBefore = second.getLeafId();
		expect(() => second.appendMessage(user("direct", 3))).toThrow();
		expect(await second.appendMessageSharingSession(user("B1", 3))).toMatchObject({
			kind: "stale",
			reason: "persistence_latched",
		});
		// Refused rather than half-published: the transcript and that cursor are untouched.
		expect(await Bun.file(file).text()).toBe(beforeRefusal);
		expect(second.getLeafId()).toBe(secondLeafBefore);
		// The first opener is unaffected and still shares the transcript.
		const a1 = await first.appendMessageSharingSession(user("A1", 4));
		expect(a1.kind).toBe("committed");
		expect(await Bun.file(file).text()).toContain("A1");
	});
});

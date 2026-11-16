import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ManagedAppendIdentityMismatchError } from "../src/session/internal/managed-session-storage";
import { SessionManager } from "../src/session/session-manager";

// A compaction entry records that earlier turns were summarized away. Publishing one from an
// opener whose transcript moved would tell the shared transcript that turns it never read are
// summarized, so the fence has to refuse it like any other append - and the refusal has to
// leave both the bytes and the resident branch alone.

const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function sharedOpens(): Promise<{
	file: string;
	first: SessionManager;
	second: SessionManager;
	destination: ReturnType<typeof SessionManager.managedDestination>;
	anchorId: string;
}> {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-compaction-"));
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
	return { file, first, second, destination, anchorId };
}

describe("compaction from a second opener", () => {
	it("refuses to summarize a branch it no longer matches", async () => {
		const { file, first, second, destination, anchorId } = await sharedOpens();
		// The first opener advances; the second's view of the branch is now stale.
		first.appendMessage({ role: "user" as const, content: "from first", timestamp: 2 });
		await first.flush();
		const advanced = await Bun.file(file).text();
		// Prove the premise first: if the advance had silently no-opped, the refusal below
		// could pass for an unrelated reason.
		expect(advanced).toContain("from first");
		const branchBefore = second.getBranch().map(entry => entry.id);

		expect(() => second.appendCompaction("stale summary", undefined, anchorId, 1000)).toThrow(
			ManagedAppendIdentityMismatchError,
		);
		expect(await Bun.file(file).text()).toBe(advanced);
		expect(await Bun.file(file).text()).not.toContain("stale summary");

		// The refused compaction is not resident either: the opener's branch is the exact
		// entry list it read, so neither a lost turn nor a stuck compaction can hide here.
		expect(second.getBranch().map(entry => entry.id)).toEqual(branchBefore);
		const reopened = await SessionManager.open(file, destination);
		managers.push(reopened);
		const compactions = reopened.getEntries().filter(entry => entry.type === "compaction");
		expect(compactions).toHaveLength(0);
	});

	it("still compacts for the opener that owns the transcript", async () => {
		const { file, first, anchorId, destination } = await sharedOpens();
		first.appendMessage({ role: "user" as const, content: "from first", timestamp: 2 });
		await first.flush();
		const compactionId = first.appendCompaction("owner summary", undefined, anchorId, 1200);
		await first.flush();

		const reopened = await SessionManager.open(file, destination);
		managers.push(reopened);
		const compactions = reopened.getEntries().filter(entry => entry.type === "compaction");
		expect(compactions.map(entry => entry.id)).toEqual([compactionId]);
		// The turn the compaction actually points back to (its firstKeptEntryId) is still there,
		// not merely the later turn that happened to be appended before it.
		const anchor = reopened.getEntries().find(entry => entry.id === anchorId);
		expect(anchor).toBeDefined();
		expect(JSON.stringify(anchor)).toContain("shared root");
		expect(compactions[0]?.firstKeptEntryId).toBe(anchorId);
	});
});

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager } from "../src/session/session-manager";

// A same-owner relocation moves the transcript into the destination's session directory. On a
// shared transcript that moves the file out from under every other opener, so the relocation is
// the moment the property has to be restated: the owner keeps publishing (at the new path) and
// an opener left pointing at the old path must be refused instead of recreating it.

const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function sharedOpens(): Promise<{
	root: string;
	file: string;
	first: SessionManager;
	second: SessionManager;
	destination: ReturnType<typeof SessionManager.managedDestination>;
	nextCwd: string;
}> {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-relocation-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const nextCwd = path.join(root, "moved-workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(nextCwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const writer = SessionManager.create(cwd, destination);
	managers.push(writer);
	writer.appendMessage({ role: "user" as const, content: "shared root", timestamp: 1 });
	await writer.ensureOnDisk();
	const file = writer.getSessionFile();
	if (!file) throw new Error("expected a transcript path");
	const first = await SessionManager.open(file, destination);
	const second = await SessionManager.open(file, destination);
	managers.push(first, second);
	return { root, file, first, second, destination, nextCwd };
}

describe("relocation under a shared writer", () => {
	it("moves the owner's publications and refuses the opener left on the old path", async () => {
		const { file, first, second, nextCwd } = await sharedOpens();
		const oldPath = file;
		const before = await Bun.file(oldPath).text();

		await first.moveTo(nextCwd);
		const movedPath = first.getSessionFile();
		expect(movedPath).toBeDefined();
		expect(movedPath).not.toBe(oldPath);
		// The transcript moved: the old path is gone and the new one carries what was there.
		expect(await Bun.file(oldPath).exists()).toBe(false);
		// The header's cwd is rewritten by the move; the committed entries are not. Comparing the
		// whole slice, not one index, also pins the record count - an extra appended record
		// (duplicate entry, stray patch) would otherwise pass unnoticed.
		const moved = await Bun.file(movedPath!).text();
		expect(moved.split("\n").slice(1)).toEqual(before.split("\n").slice(1));
		expect(moved).toContain("moved-workspace");

		// The owner keeps publishing, and the entry lands in the new file.
		const ownerOutcome = await first.appendMessageSharingSession({
			role: "user" as const,
			content: "from owner after move",
			timestamp: 2,
		});
		expect(ownerOutcome.kind).toBe("committed");
		expect(await Bun.file(movedPath!).text()).toContain("from owner after move");

		// The opener left on the old path must be refused, and must not recreate that path.
		const staleOutcome = await second.appendMessageSharingSession({
			role: "user" as const,
			content: "from stale opener",
			timestamp: 3,
		});
		// Pin the reason, not the kind: `rejected` is reachable from a non-managed destination or an
		// error escaping the append, so a union would pass when the refusal came from the wrong
		// layer. The move leaves the opener's committed snapshot absent, which is transcript_moved.
		expect(staleOutcome).toMatchObject({ kind: "stale", reason: "transcript_moved" });
		expect(await Bun.file(oldPath).exists()).toBe(false);
		expect(await Bun.file(movedPath!).text()).not.toContain("from stale opener");
	});
});

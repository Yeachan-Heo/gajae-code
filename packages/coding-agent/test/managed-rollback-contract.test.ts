import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ManagedAppendIdentityMismatchError } from "../src/session/internal/managed-session-storage";
import { SessionManager } from "../src/session/session-manager";

// A rejected append has to leave the resident graph exactly as it was: nothing added,
// nothing to be republished by a later rewrite, and no duplicate once the writer
// reopens and sends the same content again. This pins the rollback half of Phase C so
// the leftover-retained half stays a deliberate state rather than an accident.

const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function makeWorkspace(): Promise<{ cwd: string; agentDir: string }> {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-managed-rollback-"));
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

async function persistRoot(cwd: string, agentDir: string) {
	const writer = createManager(cwd, agentDir);
	const rootId = writer.appendMessage(user("root", 1));
	await writer.ensureOnDisk();
	const file = writer.getSessionFile();
	if (!file) throw new Error("expected a transcript path");
	return { writer, file, rootId };
}

describe("rejected managed append rollback", () => {
	it("leaves the resident graph exactly as it was", async () => {
		const { cwd, agentDir } = await makeWorkspace();
		const { writer, file, rootId } = await persistRoot(cwd, agentDir);
		const stale = await SessionManager.open(file, SessionManager.managedDestination(cwd, agentDir));
		managers.push(stale);
		const branchBefore = stale.getBranch().map(entry => entry.id);
		// `getEntries` is the set a whole-file rewrite republishes, and it can hold an
		// entry that the leaf walk can no longer reach; assert it directly.
		const entriesBefore = stale.getEntries().map(entry => entry.id);
		const leafBefore = stale.getLeafId();

		writer.appendMessage(user("from writer", 2));
		await writer.flush();

		expect(() => stale.appendMessage(user("rejected", 3))).toThrow(ManagedAppendIdentityMismatchError);
		// Nothing was admitted, so nothing can be republished by a later rewrite.
		expect(stale.getBranch().map(entry => entry.id)).toEqual(branchBefore);
		expect(stale.getEntries().map(entry => entry.id)).toEqual(entriesBefore);
		expect(stale.getLeafId()).toBe(leafBefore);
		expect(branchBefore).toEqual([rootId]);
		expect(JSON.stringify(stale.getEntries())).not.toContain("rejected");
		// And nothing reached disk either.
		expect(await Bun.file(file).text()).not.toContain("rejected");
	});

	it("does not duplicate the content once the writer reopens and sends it again", async () => {
		const { cwd, agentDir } = await makeWorkspace();
		const { writer, file } = await persistRoot(cwd, agentDir);
		const stale = await SessionManager.open(file, SessionManager.managedDestination(cwd, agentDir));
		managers.push(stale);
		// Make the reopened reader genuinely stale before it attempts its send.
		writer.appendMessage(user("from writer", 2));
		await writer.flush();
		expect(() => stale.appendMessage(user("resent", 3))).toThrow(ManagedAppendIdentityMismatchError);

		// Reopen is the documented recovery: the rejected attempt left nothing behind, so
		// the same content lands exactly once.
		const reopened = await SessionManager.open(file, SessionManager.managedDestination(cwd, agentDir));
		managers.push(reopened);
		reopened.appendMessage(user("resent", 3));
		await reopened.flush();

		const text = await Bun.file(file).text();
		// Exactly one copy of the resent entry: a retained rejected attempt would make the
		// next rewrite publish it a second time.
		expect(text.split("resent")).toHaveLength(2);
		expect(writer.getSessionId()).toBe(reopened.getSessionId());
	});
});

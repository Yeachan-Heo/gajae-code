import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ManagedAppendIdentityMismatchError } from "../src/session/internal/managed-session-storage";
import { SessionManager } from "../src/session/session-manager";

// The durable append seam separates admission from publication. Only `not_committed`
// is safe to retry blindly, so each outcome has to be reachable and distinguishable
// before any shared-writer work builds on it.

const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function makeWorkspace(): Promise<{ cwd: string; agentDir: string }> {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-durable-append-"));
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

describe("durable append outcome", () => {
	it("reports committed and a user-only message really reaches disk", async () => {
		const { cwd, agentDir } = await makeWorkspace();
		const manager = createManager(cwd, agentDir);

		// Contrast with appendMessage + flush, which publishes nothing for a user-only
		// transcript: this seam has to be honest about durability.
		const outcome = await manager.appendMessageDurably(user("durable", 1));
		expect(outcome.kind).toBe("committed");
		if (outcome.kind !== "committed") throw new Error("expected a committed outcome");
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a transcript path");
		const text = await Bun.file(file).text();
		expect(text).toContain("durable");
		expect(text).toContain(outcome.id);
	});

	it("reports not_committed when the append is rejected before writing", async () => {
		const { cwd, agentDir } = await makeWorkspace();
		const writer = createManager(cwd, agentDir);
		await writer.appendMessageDurably(user("root", 1));
		const file = writer.getSessionFile();
		if (!file) throw new Error("expected a transcript path");
		const stale = await SessionManager.open(file, SessionManager.managedDestination(cwd, agentDir));
		managers.push(stale);
		const parentLeaf = stale.getLeafId();

		await writer.appendMessageDurably(user("from writer", 2));
		const before = await Bun.file(file).text();
		const outcome = await stale.appendMessageDurably(user("from stale", 3));

		expect(outcome.kind).toBe("not_committed");
		if (outcome.kind !== "not_committed") throw new Error("expected a rejection");
		expect(outcome.error).toBeInstanceOf(ManagedAppendIdentityMismatchError);
		// A not-committed outcome must not have written anything and must not have left
		// the rejected entry resident; only then is a later phase allowed to retry it.
		const after = await Bun.file(file).text();
		expect(after).toBe(before);
		expect(after).not.toContain("from stale");
		// Non-residency has to be observable in the resident branch itself: a rolled-back
		// entry must not appear there, and the cursor must stay where it was.
		expect(JSON.stringify(stale.getBranch())).not.toContain("from stale");
		expect(stale.getLeafId()).toBe(parentLeaf);
		// The rejection also latches this manager, so a second attempt on it is refused the
		// same way rather than silently succeeding; retry needs a reopen.
		const again = await stale.appendMessageDurably(user("from stale again", 4));
		expect(again.kind).toBe("not_committed");
	});

	it("reports accepted without durability for a session that has no writer", async () => {
		const manager = SessionManager.inMemory();
		managers.push(manager);
		const outcome = await manager.appendMessageDurably(user("memory only", 1));
		expect(outcome.kind).toBe("accepted");
		if (outcome.kind !== "accepted") throw new Error("expected an accepted outcome");
		// `accepted` makes no durability claim at all: it must not be oversold as committed.
		expect(outcome).not.toHaveProperty("durable");
	});
});

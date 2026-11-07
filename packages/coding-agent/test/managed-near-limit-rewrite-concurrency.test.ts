import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager, type SessionMessageEntry } from "../src/session/session-manager";

// A patch on a resident entry arms rewrite debt, so the next publish cannot append and has to
// replace the file from the resident view. Near-limit recovery escalates through the same
// managed replacement: the two reach it by different routes and share the identity fence this
// case pins. The managed per-file cap is a fixed 128 MiB constant, so exercising that route
// itself needs a transcript past it; this case arms the debt the cheap way and does not claim
// otherwise.

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
	messageId: string;
}> {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-near-limit-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const writer = SessionManager.create(cwd, destination);
	managers.push(writer);
	const messageId = writer.appendMessage({ role: "user" as const, content: "shared root", timestamp: 1 });
	await writer.ensureOnDisk();
	const file = writer.getSessionFile();
	if (!file) throw new Error("expected a transcript path");
	const first = await SessionManager.open(file, destination);
	const second = await SessionManager.open(file, destination);
	managers.push(first, second);
	return { file, first, second, messageId };
}

describe("a rewrite that near-limit recovery would escalate to", () => {
	it("is refused instead of replacing another opener's commit", async () => {
		const { file, first, second, messageId } = await sharedOpens();
		// Arming the debt is what near-limit recovery does when content no longer fits: the next
		// publish cannot append and has to replace the file from the resident view.
		const entry = second.getEntry(messageId) as SessionMessageEntry | undefined;
		if (entry?.type !== "message") throw new Error("expected the message entry");
		second.applyEntryMessageUpdates([
			{ ...entry, message: { ...entry.message, content: "rewritten in place" } } as SessionMessageEntry,
		]);
		// Without this precondition the "armed rewrite absent" assertion passes even if the
		// update never landed; applyEntryMessageUpdates skips a mismatched id silently.
		expect(JSON.stringify(second.getEntry(messageId))).toContain("rewritten in place");

		first.appendMessage({ role: "user" as const, content: "from first", timestamp: 2 });
		await first.flush();
		const advanced = await Bun.file(file).text();
		expect(advanced).toContain("from first");

		let refusal: unknown;
		try {
			second.appendMessage({ role: "user" as const, content: "from second", timestamp: 3 });
		} catch (error) {
			refusal = error;
		}
		// Pin the mechanism rather than "some refusal": the append fence emits a different
		// message, so an escalation that failed to arm would not satisfy this.
		expect(refusal).toBeInstanceOf(Error);
		expect((refusal as Error).message).toContain("managed_replace_identity_mismatch");
		const after = await Bun.file(file).text();
		expect(after).toBe(advanced);
		expect(after).not.toContain("from second");
		expect(after).not.toContain("rewritten in place");
	});
});

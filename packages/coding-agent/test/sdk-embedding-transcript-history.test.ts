import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readEmbeddedTranscriptHistory } from "../src/sdk/embedding";
import { SessionManager } from "../src/session/session-manager";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 });
const texts = (messages: readonly object[]) =>
	messages.map(message => {
		const content = "content" in message ? message.content : undefined;
		return Array.isArray(content) ? (content[0] as { text: string }).text : "";
	});

async function transcript() {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-embedding-history-")));
	const cwd = path.join(directory, "project");
	const agentDir = path.join(directory, "agent");
	await fs.mkdir(cwd);
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
	const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	const first = manager.appendMessage(user("first"));
	const second = manager.appendMessage(user("second"));
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile()!;
	const sessionId = manager.getSessionId();
	await manager.close();
	return { directory, file, sessionId, first, second };
}

test("reads the conversation a transcript opens at without writing it", async () => {
	const { file, sessionId, second } = await transcript();
	const before = await fs.stat(file, { bigint: true });
	const history = await readEmbeddedTranscriptHistory(file);
	expect(history).toMatchObject({ sessionId, tail: second, leafId: second });
	expect(texts(history!.messages)).toEqual(["first", "second"]);
	const after = await fs.stat(file, { bigint: true });
	expect([after.ino, after.size, after.mtimeNs, after.ctimeNs]).toEqual([
		before.ino,
		before.size,
		before.mtimeNs,
		before.ctimeNs,
	]);
});

test("shows a saved position only while the tail it was saved with is still the newest entry", async () => {
	const { file, first, second } = await transcript();
	const exact = await readEmbeddedTranscriptHistory(file, { entryId: first, whenTail: second });
	expect(exact?.leafId).toBe(first);
	expect(texts(exact!.messages)).toEqual(["first"]);
	// Another surface appended after the save: the newest entry wins, as reopening would.
	const moved = await readEmbeddedTranscriptHistory(file, { entryId: first, whenTail: "an-older-tail" });
	expect(moved?.leafId).toBe(second);
	// A view saved before tails were recorded, at what is still the newest entry, is shown exactly.
	expect((await readEmbeddedTranscriptHistory(file, { entryId: second }))?.leafId).toBe(second);
	// An unknown target falls back to the newest entry instead of failing.
	expect((await readEmbeddedTranscriptHistory(file, { entryId: "missing", whenTail: second }))?.leafId).toBe(second);
});

test("has nothing to show for a missing or unreadable transcript", async () => {
	const { directory } = await transcript();
	expect(await readEmbeddedTranscriptHistory(path.join(directory, "absent.jsonl"))).toBeUndefined();
	const garbage = path.join(directory, "garbage.jsonl");
	await Bun.write(garbage, "not a transcript\n");
	expect(await readEmbeddedTranscriptHistory(garbage)).toBeUndefined();
});

test("a view saved before tails were recorded lands on what was appended after it, but keeps another branch", async () => {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-embedding-history-legacy-")));
	const cwd = path.join(directory, "project");
	const agentDir = path.join(directory, "agent");
	await fs.mkdir(cwd);
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
	const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	const root = manager.appendMessage(user("root"));
	const older = manager.appendMessage(user("older revision"));
	// A newer revision branches from the root; the app was last shown the older one.
	manager.branch(root);
	const newer = manager.appendMessage(user("newer revision"));
	// Then something continued the newest branch.
	const continued = manager.appendMessage(user("continued"));
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile()!;
	await manager.close();
	// The saved position is an ancestor of the newest entry: the app was at what was then the
	// end, and the continuation came after it, so it is shown.
	const advanced = await readEmbeddedTranscriptHistory(file, { entryId: newer });
	expect(advanced?.leafId).toBe(continued);
	expect(texts(advanced!.messages)).toEqual(["root", "newer revision", "continued"]);
	// The empty root is an ancestor of everything: the same rule applies.
	expect((await readEmbeddedTranscriptHistory(file, { entryId: null }))?.leafId).toBe(continued);
	// A saved position on another branch was a deliberate choice: shown exactly.
	const kept = await readEmbeddedTranscriptHistory(file, { entryId: older });
	expect(kept?.leafId).toBe(older);
	expect(texts(kept!.messages)).toEqual(["root", "older revision"]);
});

import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEmbeddedAppendRefused, readEmbeddedTranscriptTail } from "../src/sdk/embedding";
import { SessionManager } from "../src/session/session-manager";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 });

async function store() {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-embedding-tail-")));
	const cwd = path.join(directory, "project");
	const agentDir = path.join(directory, "agent");
	await fs.mkdir(cwd);
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
	return { cwd, destination: SessionManager.managedDestination(cwd, agentDir) };
}

test("reports the committed tail and the tail this session holds once another process appends", async () => {
	const { cwd, destination } = await store();
	const app = SessionManager.create(cwd, destination);
	// Its last write is refused below, so closing cannot flush that stale entry.
	cleanups.push(() => app.close().catch(() => {}));
	const own = app.appendMessage(user("app turn"));
	await app.ensureOnDisk();
	await app.flush();
	expect(await readEmbeddedTranscriptTail({ sessionManager: app })).toEqual({ committed: own, held: own });

	// Another surface resumes the same transcript and continues it.
	const terminal = await SessionManager.open(app.getSessionFile()!, destination);
	const foreign = terminal.appendMessage(user("terminal turn"));
	await terminal.flush();
	expect(await terminal.closeStrict()).toMatchObject({ kind: "closed" });
	expect(await readEmbeddedTranscriptTail({ sessionManager: app })).toEqual({ committed: foreign, held: own });
	// Reading never changes this session's cursor or entries.
	expect(app.getLeafId()).toBe(own);
	expect(app.getEntry(foreign)).toBeUndefined();
	expect(isEmbeddedAppendRefused({ sessionManager: app })).toBe(false);

	expect(() => app.appendMessage(user("stale app write"))).toThrow("managed_append_identity_mismatch");
	expect(isEmbeddedAppendRefused({ sessionManager: app })).toBe(true);
});

test("has no tail to report before the transcript is published", async () => {
	const { cwd, destination } = await store();
	const app = SessionManager.create(cwd, destination);
	cleanups.push(() => app.close());
	expect(await readEmbeddedTranscriptTail({ sessionManager: app })).toBeUndefined();
});

/** Past the window in which a same-tick write could leave every stat field unchanged. */
const settle = () => Bun.sleep(40);

test("an unchanged transcript is read once; later checks only stat it", async () => {
	const { cwd, destination } = await store();
	const app = SessionManager.create(cwd, destination);
	cleanups.push(() => app.close());
	const own = app.appendMessage(user("app turn"));
	await app.ensureOnDisk();
	await app.flush();
	await settle();
	const reads = vi.spyOn(SessionManager.prototype, "captureCommittedSnapshot");
	cleanups.push(async () => reads.mockRestore());
	for (let index = 0; index < 3; index++)
		expect(await readEmbeddedTranscriptTail({ sessionManager: app })).toEqual({ committed: own, held: own });
	expect(reads).toHaveBeenCalledTimes(1);

	// The session's own write changes the file, so the next check reads it again.
	const next = app.appendMessage(user("second app turn"));
	await app.flush();
	expect(await readEmbeddedTranscriptTail({ sessionManager: app })).toEqual({ committed: next, held: next });
	expect(reads).toHaveBeenCalledTimes(2);
});

test("a cached tail still sees another process's append", async () => {
	const { cwd, destination } = await store();
	const app = SessionManager.create(cwd, destination);
	cleanups.push(() => app.close());
	const own = app.appendMessage(user("app turn"));
	await app.ensureOnDisk();
	await app.flush();
	await settle();
	expect(await readEmbeddedTranscriptTail({ sessionManager: app })).toEqual({ committed: own, held: own });
	const terminal = await SessionManager.open(app.getSessionFile()!, destination);
	const foreign = terminal.appendMessage(user("terminal turn"));
	await terminal.flush();
	expect(await terminal.closeStrict()).toMatchObject({ kind: "closed" });
	expect(await readEmbeddedTranscriptTail({ sessionManager: app })).toEqual({ committed: foreign, held: own });
});

test("a same-size rewrite is seen even when the rewriter restores the modification time", async () => {
	const { cwd, destination } = await store();
	const app = SessionManager.create(cwd, destination);
	cleanups.push(() => app.close().catch(() => {}));
	const own = app.appendMessage(user("app turn"));
	await app.ensureOnDisk();
	await app.flush();
	const file = app.getSessionFile()!;
	// A whole-second mtime can be restored exactly after the rewrite.
	const mtime = 1_700_000_000;
	await fs.utimes(file, mtime, mtime);
	await settle();
	expect(await readEmbeddedTranscriptTail({ sessionManager: app })).toEqual({ committed: own, held: own });
	// Rewrite in place: same inode, same size, a different newest entry id, original mtime.
	const before = await fs.stat(file, { bigint: true });
	const replacement = own.replace(/./, character => (character === "0" ? "1" : "0"));
	const text = await Bun.file(file).text();
	const handle = await fs.open(file, "r+");
	try {
		await handle.write(text.replaceAll(own, replacement), 0, "utf8");
	} finally {
		await handle.close();
	}
	await fs.utimes(file, mtime, mtime);
	const after = await fs.stat(file, { bigint: true });
	// Only the change time, which no writer can set, tells the two files apart.
	expect([after.ino, after.size, after.mtimeNs]).toEqual([before.ino, before.size, before.mtimeNs]);
	expect(await readEmbeddedTranscriptTail({ sessionManager: app })).toEqual({ committed: replacement, held: null });
});

test("a read that cannot be told apart from a write in the same tick is not reused", async () => {
	const { cwd, destination } = await store();
	const app = SessionManager.create(cwd, destination);
	cleanups.push(() => app.close());
	const own = app.appendMessage(user("app turn"));
	await app.ensureOnDisk();
	await app.flush();
	// The file's last change is not clearly before the read: here its modification time is ahead.
	const ahead = new Date(Date.now() + 60_000);
	await fs.utimes(app.getSessionFile()!, ahead, ahead);
	const reads = vi.spyOn(SessionManager.prototype, "captureCommittedSnapshot");
	cleanups.push(async () => reads.mockRestore());
	expect(await readEmbeddedTranscriptTail({ sessionManager: app })).toEqual({ committed: own, held: own });
	expect(await readEmbeddedTranscriptTail({ sessionManager: app })).toEqual({ committed: own, held: own });
	// A write in that tick could leave every stat field equal, so each check reads the file again.
	expect(reads).toHaveBeenCalledTimes(2);
});

test("a read during which another process appended is not reused, even when file times look old", async () => {
	const { cwd, destination } = await store();
	const app = SessionManager.create(cwd, destination);
	cleanups.push(() => app.close());
	const own = app.appendMessage(user("app turn"));
	await app.ensureOnDisk();
	await app.flush();
	await settle();
	// A filesystem whose clock lags this process (a network share, say) makes every change look settled.
	const now = Date.now();
	const lagging = vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
	cleanups.push(async () => lagging.mockRestore());
	const capture = SessionManager.prototype.captureCommittedSnapshot;
	let foreign: string | undefined;
	const reads = vi.spyOn(SessionManager.prototype, "captureCommittedSnapshot").mockImplementation(async function (
		this: SessionManager,
	) {
		const read = await capture.call(this);
		if (foreign === undefined) {
			// Another process appends after the snapshot was read, before this check finishes.
			const terminal = await SessionManager.open(app.getSessionFile()!, destination);
			foreign = terminal.appendMessage(user("terminal turn"));
			await terminal.flush();
			await terminal.closeStrict();
		}
		return read;
	});
	cleanups.push(async () => reads.mockRestore());
	expect(await readEmbeddedTranscriptTail({ sessionManager: app })).toEqual({ committed: own, held: own });
	// The file changed while it was read, so the next check reads it again and sees the append.
	expect(await readEmbeddedTranscriptTail({ sessionManager: app })).toEqual({ committed: foreign, held: own });
});

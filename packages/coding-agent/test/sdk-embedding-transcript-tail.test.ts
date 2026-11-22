import { afterEach, expect, test } from "bun:test";
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

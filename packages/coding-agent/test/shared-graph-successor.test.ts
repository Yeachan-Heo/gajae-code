import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type FileEntry, parseSessionEntries, SessionManager } from "../src/session/session-manager";

// A root TUI publishes every message through shared append, which latches the shared
// bars for the manager's lifetime. With no foreign entry in the committed transcript,
// a graph successor (fork or branch) must still be prepared, as a new session that
// leaves the source transcript untouched.

const roots: string[] = [];
const managers: SessionManager[] = [];
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
const assistant = (text: string) => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text }],
	api: "anthropic-messages" as const,
	provider: "anthropic",
	model: "test",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop" as const,
	timestamp: 2,
});

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fresh() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-shared-graph-successor-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const manager = SessionManager.create(cwd, destination);
	managers.push(manager);
	return { root, cwd, destination, manager };
}

async function committed(manager: SessionManager, message: Parameters<SessionManager["appendMessage"]>[0]) {
	const outcome = await manager.appendMessageSharingSession(message);
	if (outcome.kind !== "committed") throw new Error(`shared append ${outcome.kind}`);
	return outcome.id;
}

/** Two prompts and replies, all published the way a root TUI publishes them. */
async function twoSharedPrompts() {
	const fixture = await fresh();
	const { manager } = fixture;
	const p1 = await committed(manager, user("p1"));
	const r1 = await committed(manager, assistant("r1"));
	const p2 = await committed(manager, user("p2"));
	const r2 = await committed(manager, assistant("r2"));
	expect(manager.requiresSharedMutationAdmission()).toBe(true);
	const file = manager.getSessionFile()!;
	return { ...fixture, file, sourceId: manager.getSessionId(), p1, r1, p2, r2 };
}

const bytesAt = async (file: string) => Buffer.from(await Bun.file(file).arrayBuffer());
const readEntries = async (file: string): Promise<FileEntry[]> => parseSessionEntries(await Bun.file(file).text());

/**
 * Known failing until the /fork fix lands: the test passes under it.failing only when the
 * run stops on exactly the reported refusal, so a harness break or timeout is not
 * mistaken for the reproduction. Flip to a plain it() with the fix.
 */
function reproducesRefusal(refusal: RegExp, run: () => Promise<void>): () => Promise<void> {
	return async () => {
		try {
			await run();
		} catch (error) {
			if (refusal.test(error instanceof Error ? error.message : String(error))) throw error;
		}
	};
}

describe("graph successors after root shared append", () => {
	it.failing(
		"prepares and adopts a branch at the selected prompt's parent without touching the source",
		reproducesRefusal(/requires transaction admission: prepare branched session$/, async () => {
			const { manager, file, sourceId, p1, r1 } = await twoSharedPrompts();
			const bytes = await bytesAt(file);
			const stage = await manager.prepareBranchedSession(r1);
			expect(stage.sessionId).not.toBe(sourceId);
			expect(stage.sessionFile).not.toBe(file);
			manager.commitPreparedNewSession(stage);
			expect(manager.getSessionId()).toBe(stage.sessionId);
			expect(manager.getLeafId()).toBe(r1);
			const [header, ...entries] = await readEntries(stage.sessionFile!);
			expect(header).toMatchObject({ type: "session", id: stage.sessionId, parentSession: sourceId });
			expect(entries.map(entry => ("id" in entry ? entry.id : undefined))).toEqual([p1, r1]);
			expect(await bytesAt(file)).toEqual(bytes);
			const next = await committed(manager, user("p3 in fork"));
			expect((await readEntries(stage.sessionFile!)).some(entry => "id" in entry && entry.id === next)).toBe(true);
			expect(await bytesAt(file)).toEqual(bytes);
		}),
	);

	it.failing(
		"prepares a whole-session fork without touching the source",
		reproducesRefusal(/requires transaction admission: prepare fork$/, async () => {
			const { manager, file, sourceId, p1, r1, p2, r2 } = await twoSharedPrompts();
			const bytes = await bytesAt(file);
			const stage = await manager.prepareFork();
			if (!stage?.sessionFile) throw new Error("missing fork transcript");
			manager.commitPreparedNewSession(stage);
			const [header, ...entries] = await readEntries(stage.sessionFile);
			expect(header).toMatchObject({ type: "session", id: stage.sessionId, parentSession: sourceId });
			expect(entries.map(entry => ("id" in entry ? entry.id : undefined))).toEqual([p1, r1, p2, r2]);
			expect(manager.getSessionId()).toBe(stage.sessionId);
			expect(await bytesAt(file)).toEqual(bytes);
		}),
	);
});

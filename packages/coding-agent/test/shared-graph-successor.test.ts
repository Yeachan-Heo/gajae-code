import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type FileEntry, parseSessionEntries, SessionManager } from "../src/session/session-manager";

// A root TUI publishes every message through the legacy route. A graph successor (fork or
// branch) is prepared as a new session that leaves the source transcript untouched.

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
	const id = manager.appendMessage(message);
	await manager.ensureOnDisk();
	await manager.flush();
	return id;
}

/** Two prompts and replies, all persisted the way a root TUI persists them. */
async function twoSharedPrompts() {
	const fixture = await fresh();
	const { manager } = fixture;
	const p1 = await committed(manager, user("p1"));
	const r1 = await committed(manager, assistant("r1"));
	const p2 = await committed(manager, user("p2"));
	const r2 = await committed(manager, assistant("r2"));
	const file = manager.getSessionFile()!;
	return { ...fixture, file, sourceId: manager.getSessionId(), p1, r1, p2, r2 };
}

const bytesAt = async (file: string) => Buffer.from(await Bun.file(file).arrayBuffer());
const readEntries = async (file: string): Promise<FileEntry[]> => parseSessionEntries(await Bun.file(file).text());

describe("graph successors after root shared append", () => {
	it("prepares a whole-session fork without touching the source", async () => {
		const { manager, file, sourceId, p1, r1, p2, r2 } = await twoSharedPrompts();
		const artifacts = file.slice(0, -6);
		// Owner-only, as the managed artifact store creates them; Linux managed storage
		// refuses to snapshot a group- or world-readable tree.
		await fs.mkdir(artifacts, { recursive: true, mode: 0o700 });
		await fs.writeFile(path.join(artifacts, "1.bash.log"), "tool output", { mode: 0o600 });
		const bytes = await bytesAt(file);
		expect(manager.graphSuccessorRefusal({ wholeSession: true })).toBeUndefined();
		const stage = await manager.prepareFork();
		if (!stage?.sessionFile || !stage.artifactsDir) throw new Error("missing fork transcript");
		expect(await Bun.file(path.join(stage.artifactsDir, "1.bash.log")).text()).toBe("tool output");
		expect(await fs.readdir(artifacts)).toEqual(["1.bash.log"]);
		manager.commitPreparedNewSession(stage);
		const [header, ...entries] = await readEntries(stage.sessionFile);
		expect(header).toMatchObject({ type: "session", id: stage.sessionId, parentSession: sourceId });
		expect(entries.map(entry => ("id" in entry ? entry.id : undefined))).toEqual([p1, r1, p2, r2]);
		expect(manager.getSessionId()).toBe(stage.sessionId);
		expect(await bytesAt(file)).toEqual(bytes);
	});

	it("refuses an entry that is not on this opener's committed graph", async () => {
		const { manager } = await twoSharedPrompts();
		expect(manager.graphSuccessorRefusal({ leafId: "missing" })).toBe("unknown-entry");
		await expect(manager.prepareBranchedSession("missing")).rejects.toThrow();
	});
});

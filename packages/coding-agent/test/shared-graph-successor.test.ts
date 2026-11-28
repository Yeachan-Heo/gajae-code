import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type FileEntry,
	parseSessionEntries,
	SessionManager,
	SharedSessionMutationUnsupportedError,
} from "../src/session/session-manager";

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

describe("graph successors after root shared append", () => {
	it("prepares and adopts a branch at the selected prompt's parent without touching the source", async () => {
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
	});

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

	it("reports and refuses a successor before any write while a peer sibling exists", async () => {
		const { manager, file, destination, r1 } = await twoSharedPrompts();
		expect(manager.graphSuccessorRefusal({ leafId: r1 })).toBeUndefined();
		const peer = await SessionManager.open(file, destination);
		managers.push(peer);
		expect((await peer.appendMessageSharingSession(user("peer sibling"))).kind).toBe("committed");
		const bytes = await bytesAt(file);
		const before = (await fs.readdir(manager.getSessionDir())).sort();
		expect(manager.graphSuccessorRefusal()).toBe("foreign-entry");
		expect(manager.graphSuccessorRefusal({ leafId: r1 })).toBe("foreign-entry");
		await expect(manager.prepareBranchedSession(r1)).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
		await expect(manager.prepareFork()).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
		expect((await fs.readdir(manager.getSessionDir())).sort()).toEqual(before);
		expect(await bytesAt(file)).toEqual(bytes);
	});

	it("refuses while one of its own shared publications is in flight", async () => {
		const { manager, r1 } = await twoSharedPrompts();
		const pending = manager.appendMessageSharingSession(user("in flight"));
		expect(manager.graphSuccessorRefusal({ leafId: r1 })).toBe("publication-in-flight");
		await expect(manager.prepareBranchedSession(r1)).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
		expect((await pending).kind).toBe("committed");
		expect(manager.graphSuccessorRefusal({ leafId: r1 })).toBeUndefined();
	});

	it("leaves a never-shared session's fork as before while another manager in the process saves it", async () => {
		const { manager, destination } = await fresh();
		const first = manager.appendMessage(user("ordinary root"));
		manager.appendMessage(assistant("ordinary reply"));
		await manager.ensureOnDisk();
		const file = manager.getSessionFile()!;
		const peer = await SessionManager.open(file, destination);
		managers.push(peer);
		const pending = peer.appendMessageSharingSession(user("same-process save in flight"));
		expect(manager.requiresSharedMutationAdmission()).toBe(false);
		expect(manager.graphSuccessorRefusal({ leafId: first })).toBeUndefined();
		const stage = await manager.prepareBranchedSession(first);
		expect(stage.sessionFile).not.toBe(file);
		expect((await pending).kind).toBe("committed");
		await manager.discardPreparedNewSession(stage);
	});

	it("refuses an entry that is not on this opener's committed graph", async () => {
		const { manager } = await twoSharedPrompts();
		expect(manager.graphSuccessorRefusal({ leafId: "missing" })).toBe("unknown-entry");
		await expect(manager.prepareBranchedSession("missing")).rejects.toThrow();
	});

	it("branches a mixed history that replays as the source does at the branch point", async () => {
		const { manager, destination } = await fresh();
		const forkParent = await mixedHistory(manager);
		const source = manager.getSessionFile()!;
		const sourceBytes = await bytesAt(source);
		const stage = await manager.prepareBranchedSession(forkParent);
		manager.commitPreparedNewSession(stage);
		await manager.flush();
		expect(await bytesAt(source)).toEqual(sourceBytes);
		// The oracle is the source itself, reopened and moved to the branch point.
		const oracle = await SessionManager.open(source, destination);
		managers.push(oracle);
		oracle.branch(forkParent);
		const branched = await SessionManager.open(stage.sessionFile!, destination);
		managers.push(branched);
		// The branch re-emits a label as a fresh entry, so a label's own id is not compared; its
		// target and text are.
		const comparable = (entries: FileEntry[]) =>
			entries.map(entry => ({
				...entry,
				id: entry.type === "label" ? undefined : "id" in entry ? entry.id : undefined,
				parentId: undefined,
				timestamp: undefined,
			}));
		const onPath = new Set(oracle.getBranch().map(entry => entry.id));
		const sourcePath = (await readEntries(source)).filter(entry => "id" in entry && onPath.has(entry.id));
		expect(comparable((await readEntries(stage.sessionFile!)).slice(1))).toEqual(comparable(sourcePath));
		expect(branched.getEntries().map(entry => entry.type)).toEqual(oracle.getBranch().map(entry => entry.type));
		expect(branched.buildSessionContext()).toEqual(oracle.buildSessionContext());
		expect(branched.getBranch().map(entry => entry.type)).toEqual(
			expect.arrayContaining(["model_change", "thinking_level_change", "compaction", "label"]),
		);
		expect(await Bun.file(stage.sessionFile!).text()).toContain("openaiResponsesHistory");
	});
});

const IMAGE = Buffer.alloc(96 * 1024, 7).toString("base64");

/**
 * Thinking, a tool call and result, an image, compaction, model changes, a label and an
 * OpenAI Responses reply with replay metadata, written through the legacy appends. Returns
 * the label's id, the parent of the selected prompt.
 */
async function mixedHistory(manager: SessionManager): Promise<string> {
	manager.appendModelChange("anthropic/test", "default");
	manager.appendThinkingLevelChange("high");
	const p1 = manager.appendMessage({
		role: "user",
		content: [
			{ type: "text", text: "look at this" },
			{ type: "image", data: IMAGE, mimeType: "image/png" },
		],
		timestamp: 1,
	});
	manager.appendMessage({
		...assistant("calling a tool"),
		content: [
			{ type: "thinking", thinking: "private reasoning", thinkingSignature: "sig" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } },
		],
		stopReason: "toolUse",
	});
	const result = manager.appendMessage({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "tool output" }],
		isError: false,
		timestamp: 3,
	});
	manager.appendCompaction("compacted", undefined, result, 1234);
	manager.appendModelChange("openai/gpt", "temporary");
	manager.appendMessage({
		...assistant("r1"),
		api: "openai-responses",
		provider: "openai",
		model: "gpt",
		content: [
			{ type: "thinking", thinking: "t", thinkingSignature: "sig" },
			{ type: "text", text: "r1" },
		],
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: "openai",
			items: [{ type: "message", id: "msg_1" }],
		},
	} as Parameters<SessionManager["appendMessage"]>[0]);
	const forkParent = manager.appendLabelChange(p1, "first prompt");
	manager.appendMessage(user("selected prompt"));
	manager.appendMessage(assistant("selected reply"));
	await manager.ensureOnDisk();
	await manager.flush();
	return forkParent;
}

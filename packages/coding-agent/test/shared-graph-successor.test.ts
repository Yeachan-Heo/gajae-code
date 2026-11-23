import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type FileEntry,
	parseSessionEntries,
	type SessionEntry,
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
		await fs.mkdir(artifacts, { recursive: true });
		await Bun.write(path.join(artifacts, "1.bash.log"), "tool output");
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

	it("matches a legacy branch of the same history: thinking, tool calls, compaction, model changes, images", async () => {
		const legacy = await fresh();
		const shared = await fresh();
		const ids = { legacy: await history(legacy.manager, false), shared: await history(shared.manager, true) };
		expect(legacy.manager.requiresSharedMutationAdmission()).toBe(false);
		expect(shared.manager.requiresSharedMutationAdmission()).toBe(true);
		const sharedFile = shared.manager.getSessionFile()!;
		const sharedBytes = await bytesAt(sharedFile);
		const legacyStage = await legacy.manager.prepareBranchedSession(ids.legacy.forkParent);
		const sharedStage = await shared.manager.prepareBranchedSession(ids.shared.forkParent);
		const onDisk = async (file: string) => normalise((await readEntries(file)).slice(1) as SessionEntry[]);
		expect(await onDisk(sharedStage.sessionFile!)).toEqual(await onDisk(legacyStage.sessionFile!));
		legacy.manager.commitPreparedNewSession(legacyStage);
		shared.manager.commitPreparedNewSession(sharedStage);
		expect(normalise(shared.manager.getEntries())).toEqual(normalise(legacy.manager.getEntries()));
		// A compaction summary's timestamp is its entry's; the fixtures differ only there.
		const context = (manager: SessionManager) =>
			manager.buildSessionContext().messages.map(message => ({ ...message, timestamp: 0 }));
		expect(context(shared.manager)).toEqual(context(legacy.manager));
		expect(shared.manager.getEntries().some(entry => entry.type === "compaction")).toBe(true);
		expect(shared.manager.getEntries().some(entry => entry.type === "label")).toBe(true);
		expect(await bytesAt(sharedFile)).toEqual(sharedBytes);
	});

	it("forks a resumed session whose resident entries came from disk", async () => {
		const legacy = await fresh();
		const legacyIds = await history(legacy.manager, false);
		const created = await fresh();
		await history(created.manager, true);
		const file = created.manager.getSessionFile()!;
		await created.manager.closeStrict();
		const resumed = await SessionManager.open(file, created.destination);
		managers.push(resumed);
		const resumedIds = Object.fromEntries(
			resumed.getEntries().flatMap(entry => (entry.type === "label" ? [["label", entry.id]] : [])),
		);
		// A resumed root TUI latches the bars with its first shared message.
		await committed(resumed, user("after resume"));
		expect(resumed.requiresSharedMutationAdmission()).toBe(true);
		const bytes = await bytesAt(file);
		expect(resumed.graphSuccessorRefusal({ leafId: resumedIds.label! })).toBeUndefined();
		const stage = await resumed.prepareBranchedSession(resumedIds.label!);
		const legacyStage = await legacy.manager.prepareBranchedSession(legacyIds.forkParent);
		const onDisk = async (path: string) => normalise((await readEntries(path)).slice(1) as SessionEntry[]);
		expect(await onDisk(stage.sessionFile!)).toEqual(await onDisk(legacyStage.sessionFile!));
		resumed.commitPreparedNewSession(stage);
		expect(resumed.getSessionId()).toBe(stage.sessionId);
		expect(resumed.getHeader()?.parentSession).toBe(created.manager.getSessionId());
		await committed(resumed, user("next in fork"));
		expect(await bytesAt(file)).toEqual(bytes);
	});

	for (const resume of [false, true]) {
		it(`matches a legacy branch and fork with OpenAI Responses replay history (${resume ? "resumed" : "live"})`, async () => {
			const open = async (shared: boolean) => {
				const fixture = await fresh();
				let manager = fixture.manager;
				const ids = await responsesHistory(manager, shared);
				if (resume) {
					const file = manager.getSessionFile()!;
					await manager.closeStrict();
					manager = await SessionManager.open(file, fixture.destination);
					managers.push(manager);
					// A resumed root TUI latches the bars with its first shared message.
					if (shared) await committed(manager, user("after resume"));
					else {
						manager.appendMessage(user("after resume"));
						await manager.flush();
					}
				}
				return { manager, ids, file: manager.getSessionFile()! };
			};
			const legacy = await open(false);
			const shared = await open(true);
			expect(legacy.manager.requiresSharedMutationAdmission()).toBe(false);
			expect(shared.manager.requiresSharedMutationAdmission()).toBe(true);
			const bytes = await bytesAt(shared.file);
			const onDisk = async (file: string) => normalise((await readEntries(file)).slice(1) as SessionEntry[]);
			expect(shared.manager.graphSuccessorRefusal({ leafId: shared.ids.reply })).toBeUndefined();
			const sharedBranch = await shared.manager.prepareBranchedSession(shared.ids.reply);
			const legacyBranch = await legacy.manager.prepareBranchedSession(legacy.ids.reply);
			expect(await onDisk(sharedBranch.sessionFile!)).toEqual(await onDisk(legacyBranch.sessionFile!));
			await shared.manager.discardPreparedNewSession(sharedBranch);
			await legacy.manager.discardPreparedNewSession(legacyBranch);
			const sharedFork = await shared.manager.prepareFork();
			const legacyFork = await legacy.manager.prepareFork();
			expect(await onDisk(sharedFork!.sessionFile!)).toEqual(await onDisk(legacyFork!.sessionFile!));
			const payloadOnDisk = (await Bun.file(sharedFork!.sessionFile!).text()).includes("openaiResponsesHistory");
			// A live opener keeps the replay payload; a resumed one strips it, as a legacy fork does.
			expect(payloadOnDisk).toBe(!resume);
			expect(await bytesAt(shared.file)).toEqual(bytes);
		});
	}

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
});

const IMAGE = Buffer.alloc(96 * 1024, 7).toString("base64");

/**
 * The same conversation, published either through legacy appends or through root
 * shared append. A TUI's startup model and thinking entries are legacy appends before
 * its first shared message in both cases.
 */
async function history(manager: SessionManager, shared: boolean) {
	const add = async (message: Parameters<SessionManager["appendMessage"]>[0]) =>
		shared ? await committed(manager, message) : manager.appendMessage(message);
	manager.appendModelChange("anthropic/test", "default");
	manager.appendThinkingLevelChange("high");
	const p1 = await add({
		role: "user",
		content: [
			{ type: "text", text: "look at this" },
			{ type: "image", data: IMAGE, mimeType: "image/png" },
		],
		timestamp: 1,
	});
	await add({
		...assistant("calling a tool"),
		content: [
			{ type: "thinking", thinking: "private reasoning", thinkingSignature: "sig" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } },
		],
		stopReason: "toolUse",
	});
	const result = await add({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		// Past MAX_PERSIST_CHARS (persisted truncated) and EDIT_SNAPSHOT_INLINE_MAX_CHARS (receipt).
		content: [{ type: "text", text: "x".repeat(600_000) }],
		details: { edits: [{ oldText: "o".repeat(20 * 1024), newText: "n".repeat(20 * 1024) }] },
		isError: false,
		timestamp: 3,
	});
	const payload = { summary: "compacted", firstKeptEntryId: result, tokensBefore: 1234 };
	if (shared) {
		const outcome = await manager.appendCompactionSharingSession(payload, () => true);
		if (outcome.kind !== "committed") throw new Error(`compaction ${outcome.kind}`);
		const model = await manager.appendTemporaryModelChangeSharingSession("anthropic/other", undefined, () => true);
		if (model.kind !== "committed") throw new Error(`model change ${model.kind}`);
	} else {
		manager.appendCompaction(payload.summary, undefined, payload.firstKeptEntryId, payload.tokensBefore);
		manager.appendModelChange("anthropic/other", "temporary");
	}
	await add(assistant("after compaction"));
	// The label sits on the path, so it is the selected prompt's parent.
	let forkParent: string;
	if (shared) {
		const label = await manager.appendLabelChangeSharingSession(p1, "first prompt");
		if (label.kind !== "committed") throw new Error(`label ${label.kind}`);
		forkParent = label.id;
	} else forkParent = manager.appendLabelChange(p1, "first prompt");
	await add(user("selected prompt"));
	await add(assistant("selected reply"));
	if (!shared) await manager.ensureOnDisk();
	return { p1, forkParent };
}

/** Entries with ids and timestamps replaced by their position, so two histories compare. */
function normalise(entries: readonly SessionEntry[]) {
	const position = new Map(entries.map((entry, index) => [entry.id, index]));
	return entries.map(entry => {
		const { id: _id, parentId, timestamp: _timestamp, ...rest } = entry as SessionEntry & { targetId?: string };
		const copy = JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
		if (typeof copy.targetId === "string") copy.targetId = position.get(copy.targetId);
		if (typeof copy.firstKeptEntryId === "string") copy.firstKeptEntryId = position.get(copy.firstKeptEntryId);
		return { ...copy, parent: parentId === null ? null : position.get(parentId) };
	});
}

/** An OpenAI Responses reply carries replay metadata that resume strips in memory only. */
async function responsesHistory(manager: SessionManager, shared: boolean) {
	const add = async (message: Parameters<SessionManager["appendMessage"]>[0]) =>
		shared ? await committed(manager, message) : manager.appendMessage(message);
	await add(user("p1"));
	const reply = await add({
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
	await add(user("p2"));
	await add(assistant("r2"));
	if (!shared) await manager.ensureOnDisk();
	return { reply };
}

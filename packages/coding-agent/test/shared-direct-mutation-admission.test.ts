import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@gajae-code/ai";
import { BlobStore } from "../src/session/blob-store";
import {
	SessionManager,
	SessionManagerTestHooks,
	SharedSessionMutationUnsupportedError,
} from "../src/session/session-manager";

const roots: string[] = [];
const managers: SessionManager[] = [];
// Cold eviction handles message content blocks, not plain-string user content.
// Keep this shape through payload updates so the old root remains eligible.
const user = (text: string) => ({
	role: "user" as const,
	content: [{ type: "text" as const, text }],
	timestamp: 1,
});
const replayMessage = (): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "thinking", thinking: "old reasoning", thinkingSignature: "old signature" }],
	api: "openai-responses",
	provider: "openai",
	model: "test",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1,
	providerPayload: { type: "openaiResponsesHistory", items: [] },
});

afterEach(async () => {
	vi.restoreAllMocks();
	SessionManagerTestHooks.beforeEntryResidentPreparation = undefined;
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function seeded(withReplay = true) {
	const directory = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-direct-"));
	roots.push(directory);
	const cwd = path.join(directory, "workspace");
	const agentDir = path.join(directory, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const a = SessionManager.create(cwd, destination);
	managers.push(a);
	const root = a.appendMessage(user("old payload ".repeat(20_000)));
	const custom = a.appendCustomMessageEntry("test", "old custom content", true, { value: 1 });
	const assistant = a.appendMessage({
		...replayMessage(),
		providerPayload: withReplay ? replayMessage().providerPayload : undefined,
	});
	const kept = a.appendMessage(user("kept"));
	const compaction = a.appendCompaction("summary", "short", kept, 123);
	await a.ensureOnDisk();
	await a.flush();
	return { a, destination, file: a.getSessionFile()!, root, custom, assistant, kept, compaction };
}

async function shared() {
	const fixture = await seeded(false);
	const { a, file, destination } = fixture;
	const b = await SessionManager.open(file, destination);
	managers.push(b);
	// Keep stale replay metadata in A without giving B open-sanitation rewrite debt.
	a.appendMessage(replayMessage());
	await a.flush();
	const sibling = await b.appendMessageSharingSession(user("unseen sibling"));
	if (sibling.kind !== "committed") throw new Error(sibling.kind);
	const own = await a.appendMessageSharingSession(user("own sibling"));
	if (own.kind !== "committed") throw new Error(own.kind);
	expect(a.getEntries().some(entry => entry.id === sibling.id)).toBe(false);
	return { ...fixture, sibling: sibling.id, own: own.id };
}

function resident(manager: SessionManager) {
	return structuredClone({
		revisions: manager.revisionSnapshot(),
		header: manager.getHeader(),
		name: manager.getSessionName(),
		starred: manager.isSessionStarred(),
		leaf: manager.getLeafId(),
		entries: manager.getEntries(),
	});
}

describe("early direct shared mutation admission", () => {
	it("refuses each direct mutation before resident, cursor, header, blob, or disk effects", async () => {
		const { a, destination, file, root, custom, assistant, kept, compaction, sibling, own } = await shared();
		const message = a.getEntries().find(entry => entry.id === root);
		const customMessage = a.getEntries().find(entry => entry.id === custom);
		if (message?.type !== "message" || customMessage?.type !== "custom_message") throw new Error("missing seeds");
		const [candidate] = await a.listForResumePickerReadOnly();
		if (!candidate || candidate.path !== file) throw new Error("missing picker candidate");
		const before = resident(a);
		const bytes = await fs.readFile(file);
		const put = vi.spyOn(BlobStore.prototype, "putImmutableSync");
		const prepare = vi.fn(() => {
			throw new Error("resident preparation entered");
		});
		SessionManagerTestHooks.beforeEntryResidentPreparation = prepare;
		const applied = vi.fn(() => {});
		expect(root).not.toBe(own);
		const mutations: Array<() => unknown> = [
			() => a.setSessionName("forbidden title", "user", { onApplied: applied }),
			() => a.setSessionStarred(true),
			() => a.setSessionStarredForPicker(candidate, true),
			() => a.applyEntryMessageUpdates([{ ...message, message: user("new payload ".repeat(100_000)) }]),
			() => a.applyCustomMessageEntryUpdates([{ ...customMessage, content: "changed", details: { value: 2 } }]),
			() => a.evictCompactedContent(kept, compaction),
			() => a.branchWithSummary(root, "forbidden summary"),
		];
		for (const mutate of mutations) {
			await expect(Promise.resolve().then(mutate)).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
			expect(resident(a)).toEqual(before);
			expect(await fs.readFile(file)).toEqual(bytes);
			expect(put).not.toHaveBeenCalled();
			expect(prepare).not.toHaveBeenCalled();
			expect(applied).not.toHaveBeenCalled();
		}
		// In-memory sanitization of replay metadata should work on shared sessions without requiring admission
		// (it doesn't persist changes). The sanitization succeeds and updates memory, but file bytes remain unchanged
		const sanitized = a.sanitizeLoadedOpenAIResponsesReplayMetadata();
		expect(sanitized).toBe(true);
		const afterSanitize = a.getEntries().find(e => e.id === assistant);
		if (afterSanitize?.type !== "message" || afterSanitize.message.role !== "assistant") throw new Error("missing assistant");
		expect(afterSanitize.message.providerPayload).toBeUndefined();
		expect(await fs.readFile(file)).toEqual(bytes);
		put.mockRestore();
		SessionManagerTestHooks.beforeEntryResidentPreparation = undefined;
		// Navigation is local, not a transcript mutation.
		a.branch(root);
		expect(a.getLeafId()).toBe(root);
		a.resetLeaf();
		expect(a.getLeafId()).toBeNull();
		expect(await fs.readFile(file)).toEqual(bytes);
		const reopened = await SessionManager.open(file, destination);
		managers.push(reopened);
		expect(reopened.getEntries().some(entry => entry.id === sibling)).toBe(true);
		expect(await fs.readFile(file)).toEqual(bytes);
	});

	it("keeps ordinary metadata, payload, eviction, sanitation, and summary mutations working", async () => {
		const { a, file, destination, root, custom, assistant, kept, compaction } = await seeded();
		expect(await a.setSessionName("ordinary title", "user")).toBe(true);
		expect(a.getSessionName()).toBe("ordinary title");
		expect(await a.setSessionStarred(true)).toBe(true);
		const [candidate] = await a.listForResumePickerReadOnly();
		if (!candidate) throw new Error("missing picker candidate");
		await a.setSessionStarredForPicker(candidate, false);
		expect(a.isSessionStarred()).toBe(false);
		const message = a.getEntries().find(entry => entry.id === root);
		const customMessage = a.getEntries().find(entry => entry.id === custom);
		if (message?.type !== "message" || customMessage?.type !== "custom_message") throw new Error("missing seeds");
		a.applyEntryMessageUpdates([{ ...message, message: user("updated payload ".repeat(20_000)) }]);
		a.applyCustomMessageEntryUpdates([{ ...customMessage, content: "updated custom", details: { value: 2 } }]);
		expect(a.getEntries().find(entry => entry.id === custom)).toMatchObject({
			content: "updated custom",
			details: { value: 2 },
		});
		expect(a.getEntries().find(entry => entry.id === root)).toMatchObject({
			message: user("updated payload ".repeat(20_000)),
		});
		expect(a.sanitizeLoadedOpenAIResponsesReplayMetadata()).toBe(true);
		const sanitized = a.getEntries().find(entry => entry.id === assistant);
		if (sanitized?.type !== "message" || sanitized.message.role !== "assistant") throw new Error("missing assistant");
		expect(sanitized.message.providerPayload).toBeUndefined();
		expect(a.sanitizeLoadedOpenAIResponsesReplayMetadata()).toBe(false);
		const eviction = a.evictCompactedContent(kept, compaction);
		expect(eviction.evictedEntries).toBeGreaterThan(0);
		expect(eviction.coldBlobBytes).toBeGreaterThan(0);
		const summary = a.branchWithSummary(root, "ordinary summary");
		expect(a.getLeafId()).toBe(summary);
		expect(a.getEntries().find(entry => entry.id === summary)).toMatchObject({
			parentId: root,
			summary: "ordinary summary",
		});
		await a.rewriteEntries();
		const reopened = await SessionManager.open(file, destination);
		managers.push(reopened);
		expect(reopened.getSessionName()).toBe("ordinary title");
		expect(reopened.getEntries().some(entry => entry.id === summary)).toBe(true);
	});

	it("allows read-only open sanitation on a fresh complete manager without rewriting disk", async () => {
		const { file, destination, assistant } = await seeded();
		const bytes = await fs.readFile(file);
		expect(bytes.toString()).toContain("openaiResponsesHistory");
		const reopened = await SessionManager.open(file, destination);
		managers.push(reopened);
		const entry = reopened.getEntries().find(candidate => candidate.id === assistant);
		if (entry?.type !== "message" || entry.message.role !== "assistant") throw new Error("missing assistant");
		expect(entry.message.providerPayload).toBeUndefined();
		expect(await fs.readFile(file)).toEqual(bytes);
	});

	it("resumes a shared managed session with stale replay metadata without throwing", async () => {
		const directory = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-managed-replay-"));
		roots.push(directory);
		const cwd = path.join(directory, "workspace");
		const agentDir = path.join(directory, "agent");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });

		// Create session with managed destination
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const a = SessionManager.create(cwd, destination);
		managers.push(a);

		// Add entries including one with stale replay metadata
		const userMsg = a.appendMessage(user("test message"));
		const assistantMsgId = a.appendMessage({
			...replayMessage(),
			providerPayload: replayMessage().providerPayload,
		});
		await a.ensureOnDisk();
		await a.flush();

		const sessionFile = a.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		// Verify that the replay metadata exists before creating shared state
		const beforeAssistant = a.getEntries().find(e => e.id === assistantMsgId);
		if (beforeAssistant?.type !== "message" || beforeAssistant.message.role !== "assistant")
			throw new Error("missing assistant");
		expect(beforeAssistant.message.providerPayload).toBeDefined();
		const beforeBytes = await fs.readFile(sessionFile);

		// Open a sibling manager to create shared state
		const b = await SessionManager.open(sessionFile, destination);
		managers.push(b);

		// Make both managers append using the sharing API to create shared mutation state
		const siblingMsg = await b.appendMessageSharingSession(user("sibling from b"));
		if (siblingMsg.kind !== "committed") throw new Error("sibling append failed");
		const ownMsg = await a.appendMessageSharingSession(user("own from a"));
		if (ownMsg.kind !== "committed") throw new Error("own append failed");

		// Verify shared state is established
		expect(a.getEntries().some(entry => entry.id === siblingMsg.id)).toBe(false);

		// Close manager B
		await b.closeStrict();
		managers.pop();

		// Close manager A
		await a.closeStrict();
		managers.pop();

		// Resume the shared managed session - this should NOT throw
		let resumed: SessionManager;
		try {
			resumed = await SessionManager.open(sessionFile, destination);
			managers.push(resumed);
		} catch (error) {
			if (error instanceof Error && error.message.includes("Shared session mutation")) {
				throw new Error(`Resume threw shared mutation error: ${error.message}`);
			}
			throw error;
		}

		// Verify that the replay metadata was sanitized in memory
		const resumedAssistant = resumed.getEntries().find(e => e.id === assistantMsgId);
		if (resumedAssistant?.type !== "message" || resumedAssistant.message.role !== "assistant")
			throw new Error("missing assistant after resume");
		expect(resumedAssistant.message.providerPayload).toBeUndefined();

		// Verify that the replay metadata was in the file before resume
		expect(beforeBytes.toString()).toContain("openaiResponsesHistory");
		// After resume, verify that in-memory sanitization worked
		// but that the file bytes reflect that replay metadata sanitization patches
		// were NOT persisted (managed destination behavior)
		const afterBytes = await fs.readFile(sessionFile);
		expect(afterBytes.toString()).toContain("sibling from b");
		// The original replay metadata payload should still be in the file
		// (because managed destination doesn't persist the sanitization patches)
		expect(afterBytes.toString()).toContain("openaiResponsesHistory");
	});
});

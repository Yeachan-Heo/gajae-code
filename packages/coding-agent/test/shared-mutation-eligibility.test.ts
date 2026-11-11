import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	SessionManager,
	SessionManagerTestHooks,
	SharedSessionMutationUnsupportedError,
} from "../src/session/session-manager";

const roots: string[] = [];
const managers: SessionManager[] = [];
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });

afterEach(async () => {
	vi.restoreAllMocks();
	SessionManagerTestHooks.beforeEntryResidentPreparation = undefined;
	SessionManagerTestHooks.beforeSharedAppendPublish = undefined;
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fresh() {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-eligibility-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const a = SessionManager.create(cwd, destination);
	managers.push(a);
	return { a, destination, file: a.getSessionFile()! };
}

async function siblings() {
	const fixture = await fresh();
	const { a, file, destination } = fixture;
	const root = await a.appendMessageSharingSession(user("root"));
	if (root.kind !== "committed") throw new Error(root.kind);
	const b = await SessionManager.open(file, destination);
	managers.push(b);
	const sibling = await b.appendMessageSharingSession(user("B sibling"));
	if (sibling.kind !== "committed") throw new Error(sibling.kind);
	const own = await a.appendMessageSharingSession(user("A sibling"));
	if (own.kind !== "committed") throw new Error(own.kind);
	expect(a.getEntries().some(entry => entry.id === sibling.id)).toBe(false);
	return { ...fixture, b, root: root.id, sibling: sibling.id, own: own.id };
}

describe("persistent shared mutation eligibility", () => {
	it("rejects legacy append and full rewrite before preparation, preserving an unseen sibling", async () => {
		const { a: ordinary } = await fresh();
		const prepare = vi.fn(() => {});
		SessionManagerTestHooks.beforeEntryResidentPreparation = prepare;
		const admittedId = ordinary.appendCustomEntry("positive control", { text: "ordinary" });
		expect(ordinary.getLeafId()).toBe(admittedId);
		expect(prepare).toHaveBeenCalledTimes(1);
		SessionManagerTestHooks.beforeEntryResidentPreparation = undefined;
		prepare.mockClear();

		const { a, file, destination, sibling, root, own } = await siblings();
		const bytes = await fs.readFile(file);
		const entries = a.getEntries();
		const revisions = a.revisionSnapshot();
		// A deterministic tripwire at _persist proves rejection precedes the append
		// near-limit recovery route regardless of cap or payload size.
		const persist = vi.spyOn(a, "_persist").mockImplementation(() => {
			throw new Error("content_too_large");
		});
		prepare.mockImplementation(() => {
			throw new Error("resident preparation entered");
		});
		SessionManagerTestHooks.beforeEntryResidentPreparation = prepare;
		for (const append of [
			() => a.appendCustomEntry("custom", { text: "forbidden" }),
			() => a.appendThinkingLevelChange("high"),
			() => a.appendMessage(user("legacy message")),
			() =>
				a.appendSessionRecap({
					text: "recap",
					sourceEntryId: own,
					requestEntryId: root,
					model: { provider: "test", id: "test" },
					generatedAt: "2026-01-01T00:00:00.000Z",
				}),
		])
			expect(append).toThrow(SharedSessionMutationUnsupportedError);
		await expect(a.rewriteEntries()).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
		await expect(a.stageDefaultModelSelection("test", "high", { appendThinkingLevel: true })).rejects.toBeInstanceOf(
			SharedSessionMutationUnsupportedError,
		);
		expect(persist).not.toHaveBeenCalled();
		expect(prepare).not.toHaveBeenCalled();
		expect(a.getLeafId()).toBe(own);
		expect(a.revisionSnapshot()).toEqual(revisions);
		expect(a.getEntries()).toEqual(entries);
		expect(await fs.readFile(file)).toEqual(bytes);
		persist.mockRestore();
		SessionManagerTestHooks.beforeEntryResidentPreparation = undefined;
		a.branch(root);
		a.resetLeaf();
		a.branch(root);
		expect((await a.appendMessageSharingSession(user("another local sibling"))).kind).toBe("committed");
		const reopened = await SessionManager.open(file, destination);
		managers.push(reopened);
		expect(reopened.getEntries().some(entry => entry.id === sibling)).toBe(true);
		await a.closeStrict();
	});

	it("refuses promotion of a stage prepared before shared admission", async () => {
		const { a, file } = await fresh();
		a.appendMessage(user("root"));
		await a.ensureOnDisk();
		const stage = await a.stageDefaultModelSelection("test", "high", { appendThinkingLevel: true });
		try {
			expect((await a.appendMessageSharingSession(user("shared"))).kind).toBe("committed");
			const bytes = await fs.readFile(file);
			const revisions = a.revisionSnapshot();
			expect(() => a.promoteDefaultModelSelection(stage)).toThrow(SharedSessionMutationUnsupportedError);
			expect(a.revisionSnapshot()).toEqual(revisions);
			expect(await fs.readFile(file)).toEqual(bytes);
		} finally {
			await a.discardDefaultModelSelectionStage(stage);
		}
	});

	it("does not lend admission to callbacks while waiting or during synchronous publication", async () => {
		const { a } = await fresh();
		const pending = a.appendMessageSharingSession(user("bootstrap"));
		expect(() => a.appendCustomEntry("during wait", {})).toThrow(SharedSessionMutationUnsupportedError);
		expect((await pending).kind).toBe("committed");
		let calls = 0;
		SessionManagerTestHooks.beforeSharedAppendPublish = () => {
			calls++;
			expect(() => a.appendCustomEntry("reentrant", {})).toThrow(SharedSessionMutationUnsupportedError);
		};
		expect((await a.appendMessageSharingSession(user("next"))).kind).toBe("committed");
		expect(calls).toBe(1);
	});

	it("retains same-transcript protection across restoration and reuse without poisoning a new session", async () => {
		const { a, file } = await fresh();
		expect((await a.appendMessageSharingSession(user("shared"))).kind).toBe("committed");
		const snapshot = a.captureState();
		a.restoreState(snapshot);
		expect(() => a.assertLegacyMutationAllowed("caller effects")).toThrow(SharedSessionMutationUnsupportedError);
		await a.newSession();
		expect(() => a.assertLegacyMutationAllowed("ordinary session")).not.toThrow();
		const id = a.appendCustomEntry("ordinary", { value: 1 });
		expect(a.getLeafId()).toBe(id);
		await a.setSessionFile(file);
		expect(() => a.appendCustomEntry("old shared transcript", {})).toThrow(SharedSessionMutationUnsupportedError);
	});

	it("refuses payload rewrite debt before staging and keeps shared close resource-only", async () => {
		const { a, file, own } = await siblings();
		const bytes = await fs.readFile(file);
		const revisions = a.revisionSnapshot();
		// Payload admission must refuse before creating rewrite debt; close must
		// still release a clean shared manager rather than manufacture a failure.
		const entry = a.getEntries().find(candidate => candidate.id === own);
		if (entry?.type !== "message") throw new Error("missing local message");
		const message = user("resident payload changed before close");
		expect(() => a.applyEntryMessageUpdates([{ ...entry, message }])).toThrow(SharedSessionMutationUnsupportedError);
		const updated = a.getEntries().find(candidate => candidate.id === own);
		if (updated?.type !== "message") throw new Error("missing updated local message");
		expect(updated.message).toEqual(entry.message);
		expect(a.revisionSnapshot()).toEqual(revisions);
		expect(await fs.readFile(file)).toEqual(bytes);
		const outcome = await a.closeStrict();
		expect(outcome.kind).toBe("closed");
		expect(await fs.readFile(file)).toEqual(bytes);
	});

	it("keeps in-memory append independent of refused shared publication", async () => {
		const a = SessionManager.inMemory();
		managers.push(a);
		expect((await a.appendMessageSharingSession(user("unsupported"))).kind).toBe("rejected");
		const id = a.appendCustomEntry("ordinary", {});
		expect(a.getLeafId()).toBe(id);
		expect(() => a.assertLegacyMutationAllowed("ordinary")).not.toThrow();
	});

	it("keeps ordinary non-shared managed append behavior", async () => {
		const { a, file } = await fresh();
		const id = a.appendCustomEntry("ordinary", { value: 1 });
		a.appendMessage(user("ordinary"));
		await a.ensureOnDisk();
		expect(await fs.readFile(file, "utf8")).toContain(id);
		const next = a.appendThinkingLevelChange("high");
		await a.flush();
		expect(await fs.readFile(file, "utf8")).toContain(next);
		await a.closeStrict();
	});
});

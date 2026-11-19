import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ManagedLockTestHooks, ManagedSessionDescendantStore } from "../src/session/internal/managed-session-storage";
import { SessionManager } from "../src/session/session-manager";

const roots: string[] = [];
const managers: SessionManager[] = [];
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
const assistant = {
	role: "assistant" as const,
	content: [{ type: "text" as const, text: "answer" }],
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
};

afterEach(async () => {
	vi.restoreAllMocks();
	ManagedLockTestHooks.afterReleaseDurable = undefined;
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fresh() {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-bootstrap-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const manager = SessionManager.create(cwd, destination);
	managers.push(manager);
	return { manager, destination, file: manager.getSessionFile()! };
}

async function records(file: string) {
	return (await Bun.file(file).text())
		.trim()
		.split("\n")
		.map(line => JSON.parse(line));
}

describe("transaction-owned first publication", () => {
	it("preserves pending metadata and original message IDs, publishes once, and reloads", async () => {
		const { manager, destination, file } = await fresh();
		const metadata = manager.appendThinkingLevelChange("high");
		const initial = manager.appendMessage(user("initial"));
		await manager.flush();
		expect(await Bun.file(file).exists()).toBe(false);
		const publish = vi.spyOn(ManagedSessionDescendantStore.prototype, "publishNoReplaceSync");
		const outcome = await manager.appendMessageSharingSession(assistant);
		if (outcome.kind !== "committed") throw new Error(`unexpected ${outcome.kind}`);
		expect(publish.mock.calls.filter(args => args[0] === path.basename(file))).toHaveLength(1);
		const entries = await records(file);
		expect(entries.slice(1).map(entry => entry.id)).toEqual([metadata, initial, outcome.id]);
		expect(entries.slice(1).map(entry => entry.parentId)).toEqual([null, metadata, initial]);
		expect(entries[1]).toMatchObject({ type: "thinking_level_change", thinkingLevel: "high" });
		const reopened = await SessionManager.open(file, destination);
		managers.push(reopened);
		expect(reopened.getSessionId()).toBe(manager.getSessionId());
		expect(reopened.getLeafId()).toBe(outcome.id);
		expect(reopened.getEntries().map(entry => entry.id)).toEqual([metadata, initial, outcome.id]);
	});

	it("publishes pending entries without following the last pending record instead of the local cursor", async () => {
		const { manager, file } = await fresh();
		const root = manager.appendMessage(user("root"));
		const sibling = manager.appendMessage(user("sibling"));
		manager.branch(root);
		const outcome = await manager.appendMessageSharingSession(assistant);
		if (outcome.kind !== "committed") throw new Error(`unexpected ${outcome.kind}`);
		const entries = (await records(file)).slice(1);
		expect(entries.map(entry => entry.id)).toEqual([root, sibling, outcome.id]);
		expect(entries.map(entry => entry.parentId)).toEqual([null, root, root]);
		expect(manager.getLeafId()).toBe(outcome.id);
	});

	it("explicit shared user publication does not change ordinary synchronous user deferral", async () => {
		const { manager, file } = await fresh();
		const first = manager.appendMessage(user("deferred"));
		await manager.flush();
		expect(await Bun.file(file).exists()).toBe(false);
		const outcome = await manager.appendMessageSharingSession(user("durable"));
		if (outcome.kind !== "committed") throw new Error(`unexpected ${outcome.kind}`);
		expect((await records(file)).slice(1).map(entry => entry.id)).toEqual([first, outcome.id]);
	});

	for (const duringPublish of [false, true]) {
		it(`never overwrites an unexpected file appearing ${duringPublish ? "at publication" : "before acquisition"}`, async () => {
			const { manager, file } = await fresh();
			const initial = manager.appendMessage(user("pending"));
			const foreign = "unexpected sibling transcript\n";
			if (duringPublish) {
				const original = ManagedSessionDescendantStore.prototype.publishNoReplaceSync;
				vi.spyOn(ManagedSessionDescendantStore.prototype, "publishNoReplaceSync").mockImplementation(function (
					this: ManagedSessionDescendantStore,
					...args: Parameters<typeof original>
				) {
					if (args[0] === path.basename(file)) fsSync.writeFileSync(file, foreign, { mode: 0o600, flag: "wx" });
					return original.apply(this, args);
				});
			} else await fs.writeFile(file, foreign, { mode: 0o600, flag: "wx" });
			const outcome = await manager.appendMessageSharingSession(assistant);
			expect(outcome.kind).toBe(duringPublish ? "unknown" : "stale");
			expect(await Bun.file(file).text()).toBe(foreign);
			if (!duringPublish) expect(manager.getLeafId()).toBe(initial);
		});
	}

	for (const boundary of ["before", "after", "release"] as const) {
		it(`retains the original attempted ID on ${boundary} publication uncertainty`, async () => {
			const { manager, file } = await fresh();
			const initial = manager.appendMessage(user("pending"));
			let attemptedId: string | null = null;
			if (boundary === "release") {
				ManagedLockTestHooks.afterReleaseDurable = () => {
					attemptedId = manager.getLeafId();
					throw new Error("release uncertainty");
				};
			} else {
				const original = ManagedSessionDescendantStore.prototype.publishNoReplaceSync;
				vi.spyOn(ManagedSessionDescendantStore.prototype, "publishNoReplaceSync").mockImplementation(function (
					this: ManagedSessionDescendantStore,
					...args: Parameters<typeof original>
				) {
					if (args[0] !== path.basename(file)) return original.apply(this, args);
					attemptedId = manager.getLeafId();
					if (boundary === "after") original.apply(this, args);
					throw new Error("publication uncertainty");
				});
			}
			const outcome = await manager.appendMessageSharingSession(assistant);
			ManagedLockTestHooks.afterReleaseDurable = undefined;
			if (attemptedId === null) throw new Error("publication boundary did not observe an entry ID");
			expect(outcome).toMatchObject({ kind: "unknown", id: attemptedId });
			expect(manager.getLeafId()).toBe(attemptedId);
			expect(manager.getEntries().map(entry => entry.id)).toEqual([initial, attemptedId]);
			if (boundary === "before") expect(await Bun.file(file).exists()).toBe(false);
			else expect((await records(file)).slice(1).map(entry => entry.id)).toEqual([initial, attemptedId]);
			if (boundary !== "release")
				expect(await manager.appendMessageSharingSession(user("no retry"))).toEqual({
					kind: "stale",
					reason: "persistence_latched",
				});
		});
	}

	it("serializes two calls on one manager without duplicating pending entries", async () => {
		const { manager, file } = await fresh();
		const metadata = manager.appendThinkingLevelChange("high");
		const initial = manager.appendMessage(user("pending"));
		const outcomes = await Promise.all([
			manager.appendMessageSharingSession(user("one")),
			manager.appendMessageSharingSession(user("two")),
		]);
		for (const outcome of outcomes) expect(outcome.kind).toBe("committed");
		const entries = (await records(file)).slice(1);
		expect(entries).toHaveLength(4);
		expect(new Set(entries.map(entry => entry.id)).size).toBe(4);
		expect(entries.slice(0, 2).map(entry => entry.id)).toEqual([metadata, initial]);
		expect(entries.map(entry => entry.parentId)).toEqual([null, metadata, initial, entries[2].id]);
		expect(manager.getLeafId()).toBe(entries[3].id);
	});

	it("refuses rewrite debt on a published manager even when its transcript disappears", async () => {
		const { manager, file } = await fresh();
		const initial = manager.appendMessage(user("pending"));
		await manager.ensureOnDisk();
		const before = await Bun.file(file).text();
		manager.applyEntryMessageUpdates([]);
		expect(await manager.appendMessageSharingSession(assistant)).toEqual({
			kind: "stale",
			reason: "rewrite_required",
		});
		expect(await Bun.file(file).text()).toBe(before);
		await fs.rm(file);
		expect(await manager.appendMessageSharingSession(assistant)).toEqual({
			kind: "stale",
			reason: "rewrite_required",
		});
		expect(await Bun.file(file).exists()).toBe(false);
		expect(manager.getLeafId()).toBe(initial);
	});
});

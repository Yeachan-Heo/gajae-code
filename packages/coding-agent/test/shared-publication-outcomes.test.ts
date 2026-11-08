import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	ManagedCommittedMutationError,
	ManagedLockTestHooks,
	ManagedSessionDescendantStore,
} from "../src/session/internal/managed-session-storage";
import { ManagedSessionReleaseError } from "../src/session/internal/managed-session-transaction";
import { reconcileUncertainAppend, SessionManager } from "../src/session/session-manager";

const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	ManagedLockTestHooks.afterReleaseDurable = undefined;
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });

async function sharedSession() {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-outcome-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const writer = SessionManager.create(cwd, destination);
	managers.push(writer);
	const anchor = writer.appendMessage(user("anchor"));
	await writer.ensureOnDisk();
	const file = writer.getSessionFile()!;
	const manager = await SessionManager.open(file, destination);
	managers.push(manager);
	return { manager, file, anchor };
}

async function records(file: string) {
	return (await Bun.file(file).text())
		.trim()
		.split("\n")
		.map(line => JSON.parse(line));
}

describe("shared publication uncertain outcomes", () => {
	it("publishes a custom entry with its original data and a resolvable branch parent", async () => {
		const { manager, file, anchor } = await sharedSession();
		const data = { version: 1, route: "direct", triggers: ["bounded"] };
		const outcome = await manager.appendCustomEntrySharingSession("workflow-intent-diff", data);
		expect(outcome.kind).toBe("committed");
		if (outcome.kind !== "committed") throw new Error("custom entry was not committed");
		const entry = (await records(file)).find(candidate => candidate.id === outcome.id);
		expect(entry).toMatchObject({
			type: "custom",
			customType: "workflow-intent-diff",
			data,
			parentId: anchor,
		});
		const next = await manager.appendMessageSharingSession(user("following prompt"));
		expect(next.kind).toBe("committed");
		if (next.kind === "committed")
			expect((await records(file)).find(candidate => candidate.id === next.id)?.parentId).toBe(outcome.id);
	});

	it("retains the attempted custom entry ID when publication is uncertain without reappending", async () => {
		const { manager, file, anchor } = await sharedSession();
		const original = ManagedSessionDescendantStore.prototype.appendExpectedIdentitySync;
		let attemptedId: string | undefined;
		const append = vi
			.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedIdentitySync")
			.mockImplementation(function (this: ManagedSessionDescendantStore, ...args: Parameters<typeof original>) {
				attemptedId = manager.getLeafId()!;
				original.apply(this, args);
				throw new ManagedCommittedMutationError("append", new Error("custom uncertainty"));
			});
		const outcome = await manager.appendCustomEntrySharingSession("workflow-intent-diff", { version: 1 });
		expect(outcome).toMatchObject({ kind: "unknown", id: attemptedId });
		expect(append).toHaveBeenCalledTimes(1);
		const matching = (await records(file)).filter(entry => entry.id === attemptedId);
		expect(matching).toHaveLength(1);
		expect(matching[0]).toMatchObject({ type: "custom", customType: "workflow-intent-diff", parentId: anchor });
	});

	for (const write of [false, true]) {
		it(`preserves the original ID when a storage append fails ${write ? "after" : "before"} writing`, async () => {
			const { manager, file, anchor } = await sharedSession();
			const before = await Bun.file(file).text();
			const original = ManagedSessionDescendantStore.prototype.appendExpectedIdentitySync;
			let attemptedId: string | undefined;
			const spy = vi
				.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedIdentitySync")
				.mockImplementation(function (this: ManagedSessionDescendantStore, ...args: Parameters<typeof original>) {
					attemptedId = manager.getLeafId()!;
					if (write) original.apply(this, args);
					throw new ManagedCommittedMutationError("append", new Error("injected uncertainty"));
				});
			const outcome = await manager.appendMessageSharingSession(user("attempt"));
			spy.mockRestore();
			if (attemptedId === undefined) throw new Error("storage append was not reached");
			expect(outcome).toMatchObject({ kind: "unknown", id: attemptedId });
			if (outcome.kind !== "unknown") throw new Error("expected uncertainty");
			expect(manager.getLeafId()).toBe(attemptedId);
			const matching = (await records(file)).filter(entry => entry.id === attemptedId);
			expect(matching).toHaveLength(write ? 1 : 0);
			if (write) expect(matching[0].parentId).toBe(anchor);
			else expect(await Bun.file(file).text()).toBe(before);
			const read = await manager.captureCommittedSnapshot();
			expect(
				reconcileUncertainAppend({ outcome, read, sessionId: manager.getSessionId(), residentAttempt: "retained" }),
			).toEqual(
				write
					? { kind: "committed", id: attemptedId }
					: { kind: "indeterminate", reason: "resident_attempt_retained" },
			);
		});
	}

	it("does not call a rolled-back resident append rejected when disk already has its ID", async () => {
		const { manager, file, anchor } = await sharedSession();
		const original = ManagedSessionDescendantStore.prototype.appendExpectedIdentitySync;
		let attemptedId: string | undefined;
		vi.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedIdentitySync").mockImplementation(function (
			this: ManagedSessionDescendantStore,
			...args: Parameters<typeof original>
		) {
			attemptedId = manager.getLeafId()!;
			original.apply(this, args);
			throw new Error("post-write failure");
		});
		const outcome = await manager.appendMessageSharingSession(user("attempt"));
		expect(outcome).toMatchObject({ kind: "unknown", id: attemptedId });
		expect(manager.getLeafId()).toBe(anchor);
		const matching = (await records(file)).filter(entry => entry.id === attemptedId);
		expect(matching).toHaveLength(1);
		expect(matching[0].parentId).toBe(anchor);
	});

	it("does not claim commitment when the post-append snapshot cannot find the transcript", async () => {
		const { manager, file } = await sharedSession();
		const flush = manager.flush.bind(manager);
		let committedId: string | undefined;
		vi.spyOn(manager, "flush").mockImplementationOnce(async () => {
			await flush();
			committedId = manager.getLeafId()!;
			expect((await records(file)).filter(entry => entry.id === committedId)).toHaveLength(1);
			await fs.rm(file);
		});
		const outcome = await manager.appendMessageSharingSession(user("attempt"));
		if (committedId === undefined) throw new Error("flush did not observe a committed entry");
		expect(outcome).toMatchObject({ kind: "unknown", id: committedId });
		expect(manager.getLeafId()).toBe(committedId);
		expect(await Bun.file(file).exists()).toBe(false);
	});

	for (const boundary of ["flush", "snapshot", "release", "flush-and-release"] as const) {
		it(`keeps the committed ID when ${boundary} fails`, async () => {
			const { manager, file, anchor } = await sharedSession();
			const injected = new Error(`injected ${boundary}`);
			if (boundary === "flush" || boundary === "flush-and-release")
				vi.spyOn(manager, "flush").mockRejectedValueOnce(injected);
			if (boundary === "snapshot") {
				const original = manager.captureCommittedSnapshot.bind(manager);
				vi.spyOn(manager, "captureCommittedSnapshot")
					.mockImplementationOnce(original)
					.mockRejectedValueOnce(injected);
			}
			if (boundary === "release" || boundary === "flush-and-release")
				ManagedLockTestHooks.afterReleaseDurable = () => {
					throw injected;
				};
			const outcome = await manager.appendMessageSharingSession(user("attempt"));
			ManagedLockTestHooks.afterReleaseDurable = undefined;
			vi.restoreAllMocks();
			if (outcome.kind !== "unknown") throw new Error(`expected uncertainty, got ${outcome.kind}`);
			expect(outcome.id).toBe(manager.getLeafId()!);
			if (boundary === "release" || boundary === "flush-and-release")
				expect(outcome.error).toBeInstanceOf(ManagedSessionReleaseError);
			else expect(outcome.error).toBe(injected);
			const matching = (await records(file)).filter(entry => entry.id === outcome.id);
			expect(matching).toHaveLength(1);
			expect(matching[0].parentId).toBe(anchor);
			expect(matching[0].message.content).toBe("attempt");
			const read = await manager.captureCommittedSnapshot();
			expect(
				reconcileUncertainAppend({ outcome, read, sessionId: manager.getSessionId(), residentAttempt: "retained" }),
			).toEqual({ kind: "committed", id: outcome.id });
		});
	}
});

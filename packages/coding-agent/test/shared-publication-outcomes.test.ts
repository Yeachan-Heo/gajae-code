import { afterEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSidecarCacheRootDir } from "@gajae-code/utils";
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

async function sharedSession(cold = false) {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-outcome-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const writer = SessionManager.create(cwd, destination);
	managers.push(writer);
	if (cold) writer.setSessionMemoryMode("off");
	if (cold) writer.appendMessage(user("root"));
	const anchor = writer.appendMessage(user("anchor"));
	if (cold) writer.appendCompaction("summary", undefined, anchor, 1);
	await writer.ensureOnDisk();
	const file = writer.getSessionFile()!;
	if (cold) expect(await writer.closeStrict()).toMatchObject({ kind: "closed" });
	const manager = cold
		? await SessionManager.open(file, destination, undefined, "copy-retain", "enabled")
		: await SessionManager.open(file, destination);
	managers.push(manager);
	return { manager, file, anchor, cwd, agentDir };
}

async function records(file: string) {
	return (await Bun.file(file).text())
		.trim()
		.split("\n")
		.map(line => JSON.parse(line));
}

describe("shared publication uncertain outcomes", () => {
	it.skipIf(process.platform === "win32")(
		"keeps the opener cursor when a cold index invalidates after a foreign branch append",
		async () => {
			const { manager: openerA, file, cwd, agentDir } = await sharedSession(true);
			const openerB = await SessionManager.open(
				file,
				SessionManager.managedDestination(cwd, agentDir),
				undefined,
				"copy-retain",
				"off",
			);
			managers.push(openerB);
			expect(openerA.getSessionMemoryStats()).toMatchObject({ coldRetirementActive: true });

			const firstA = await openerA.appendMessageSharingSession(user("A branch"));
			expect(firstA.kind).toBe("committed");
			if (firstA.kind !== "committed") throw new Error("A branch was not committed");
			const savedLeafA = openerA.getLeafId();
			expect(savedLeafA).toBe(firstA.id);

			const foreignB = await openerB.appendMessageSharingSession(user("B branch"));
			expect(foreignB.kind).toBe("committed");
			if (foreignB.kind !== "committed") throw new Error("B branch was not committed");
			expect(openerA.getLeafId()).toBe(savedLeafA);
			expect(openerA.getSessionMemoryStats().coldRetirementActive).toBe(true);

			// Managed sidecars are disposable and scoped to this fixture's agent directory.
			const sessionHash = createHash("sha256").update(file).digest("hex").slice(0, 32);
			const indexPath = path.join(getSidecarCacheRootDir(agentDir), `s-${sessionHash}`, ".session-memory.spill.idx");
			expect(await Bun.file(indexPath).exists()).toBe(true);
			await fs.appendFile(indexPath, "{}\n");
			const finalA = await openerA.appendMessageSharingSession(user("A after B"));
			expect(finalA.kind).toBe("committed");
			if (finalA.kind !== "committed") throw new Error("A continuation was not committed");

			const entries = (await records(file)).slice(1);
			const ids = entries.map(entry => entry.id as string);
			expect(new Set(ids).size).toBe(ids.length);
			const seen = new Set<string>();
			for (const entry of entries) {
				if (entry.parentId !== null) expect(seen.has(entry.parentId)).toBe(true);
				seen.add(entry.id);
			}
			expect(entries.find(entry => entry.id === finalA.id)?.parentId).toBe(savedLeafA);
			expect(entries.find(entry => entry.id === finalA.id)?.parentId).not.toBe(foreignB.id);
		},
		30_000,
	);
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

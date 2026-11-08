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
import {
	reconcileUncertainAppend,
	SessionManager,
	SharedSessionMutationUnsupportedError,
} from "../src/session/session-manager";

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

async function bounded<T>(pending: Promise<T>): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error("shared thinking barrier timed out")), 1500);
	try {
		return await Promise.race([pending, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

describe("shared thinking publication", () => {
	it("commits one typed owned entry at the branch cursor and consumes its owner", async () => {
		const { manager, file, anchor } = await sharedSession();
		const outside = await manager.appendThinkingLevelChangeSharingSession("low", true, () => true);
		expect(outside).toMatchObject({ kind: "rejected" });
		const outcome = await manager.withSharedThinkingControl(async () => {
			const first = await manager.appendThinkingLevelChangeSharingSession("high", true, () => true);
			const second = await manager.appendThinkingLevelChangeSharingSession("low", true, () => true);
			expect(second).toMatchObject({ kind: "rejected" });
			return first;
		});
		expect(outcome.kind).toBe("committed");
		if (outcome.kind !== "committed") throw new Error(`unexpected thinking outcome: ${outcome.kind}`);
		expect((await records(file)).filter(entry => entry.type === "thinking_level_change")).toEqual([
			expect.objectContaining({
				id: outcome.id,
				parentId: anchor,
				thinkingLevel: "high",
				operatorIntent: true,
			}),
		]);
		const following = await manager.appendMessageSharingSession(user("after thinking"));
		expect(following.kind).toBe("committed");
		if (following.kind === "committed")
			expect((await records(file)).find(entry => entry.id === following.id)?.parentId).toBe(outcome.id);
		expect(await manager.appendThinkingLevelChangeSharingSession("low", false, () => true)).toMatchObject({
			kind: "rejected",
		});
	});

	it("releases ownership on success and failure without authorizing escaped callbacks", async () => {
		const { manager, file } = await sharedSession();
		let escaped: (() => Promise<unknown>) | undefined;
		await expect(
			manager.withSharedThinkingControl(async () => {
				escaped = () => manager.appendThinkingLevelChangeSharingSession("high", true, () => true);
				throw new Error("body failed");
			}),
		).rejects.toThrow("body failed");
		if (!escaped) throw new Error("control did not capture its callback");
		expect(await escaped()).toMatchObject({ kind: "rejected" });
		const outcome = await manager.withSharedThinkingControl(() =>
			manager.appendThinkingLevelChangeSharingSession("low", false, () => true),
		);
		expect(outcome.kind).toBe("committed");
		expect((await records(file)).filter(entry => entry.type === "thinking_level_change")).toHaveLength(1);
	});

	it("refuses own and sibling message/custom writes while an owned control is held", async () => {
		const { manager, file, cwd, agentDir } = await sharedSession();
		const sibling = await SessionManager.open(file, SessionManager.managedDestination(cwd, agentDir));
		managers.push(sibling);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const held = manager.withSharedThinkingControl(async () => {
			entered.resolve();
			await release.promise;
			return manager.appendThinkingLevelChangeSharingSession("high", true, () => true);
		});
		try {
			await bounded(entered.promise);
			const before = await Bun.file(file).text();
			expect(await sibling.appendThinkingLevelChangeSharingSession("low", true, () => true)).toMatchObject({
				kind: "rejected",
			});
			for (const opener of [manager, sibling]) {
				expect(await bounded(opener.appendMessageSharingSession(user("blocked")))).toMatchObject({
					kind: "rejected",
				});
				expect(await bounded(opener.appendCustomEntrySharingSession("blocked", { write: true }))).toMatchObject({
					kind: "rejected",
				});
			}
			expect(await Bun.file(file).text()).toBe(before);
		} finally {
			release.resolve();
			await bounded(held).catch(() => undefined);
		}
		const outcome = await bounded(held);
		expect(outcome.kind).toBe("committed");
	});

	it("excludes legacy and owned controls in both directions but admits overlapping owned controls", async () => {
		const { manager, file } = await sharedSession();
		for (const first of ["legacy", "owned"] as const) {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const body = async () => {
				entered.resolve();
				await release.promise;
			};
			const held =
				first === "legacy" ? manager.withDurableThinkingControl(body) : manager.withSharedThinkingControl(body);
			try {
				await bounded(entered.promise);
				const opposite =
					first === "legacy"
						? manager.withSharedThinkingControl(async () => undefined)
						: manager.withDurableThinkingControl(async () => undefined);
				await expect(bounded(opposite)).rejects.toBeInstanceOf(SharedSessionMutationUnsupportedError);
			} finally {
				release.resolve();
				await bounded(held).catch(() => undefined);
			}
			await bounded(held);
		}
		await manager.withSharedThinkingControl(async () => {
			const overlap = await manager.withSharedThinkingControl(() =>
				manager.appendThinkingLevelChangeSharingSession("low", false, () => true),
			);
			expect(overlap.kind).toBe("committed");
			const outer = await manager.appendThinkingLevelChangeSharingSession("high", true, () => true);
			expect(outer.kind).toBe("committed");
		});
		expect((await records(file)).filter(entry => entry.type === "thinking_level_change")).toHaveLength(2);
	});

	it("admits another owner while an owned thinking publication is in flight", async () => {
		const { manager, file } = await sharedSession();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const admitted = Promise.withResolvers<void>();
		const capture = manager.captureCommittedSnapshot.bind(manager);
		vi.spyOn(manager, "captureCommittedSnapshot").mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			return capture();
		});
		const first = manager.withSharedThinkingControl(() =>
			manager.appendThinkingLevelChangeSharingSession("low", true, () => true),
		);
		void first.catch(() => {});
		const pending = [first];
		let cleanupFailure: unknown;
		try {
			await bounded(Promise.race([entered.promise, first]));
			const second = manager.withSharedThinkingControl(async () => {
				admitted.resolve();
				return manager.appendThinkingLevelChangeSharingSession("high", true, () => true);
			});
			pending.push(second);
			await bounded(Promise.race([admitted.promise, second]));
			release.resolve();
			const outcomes = await bounded(Promise.all(pending));
			expect(outcomes.map(outcome => outcome.kind)).toEqual(["committed", "committed"]);
			const entries = (await records(file)).filter(entry => entry.type === "thinking_level_change");
			expect(entries.map(entry => entry.thinkingLevel)).toEqual(["low", "high"]);
			expect(entries[1].parentId).toBe(entries[0].id);
		} finally {
			release.resolve();
			try {
				await bounded(Promise.allSettled(pending));
			} catch (error) {
				cleanupFailure = error;
			}
		}
		if (cleanupFailure !== undefined) throw cleanupFailure;
	});

	it("does not stage a superseded owner's thinking entry", async () => {
		const { manager, file, anchor } = await sharedSession();
		const before = await Bun.file(file).text();
		const outcome = await manager.withSharedThinkingControl(() =>
			manager.appendThinkingLevelChangeSharingSession("high", true, () => false),
		);
		expect(outcome).toMatchObject({ kind: "rejected" });
		expect(manager.getLeafId()).toBe(anchor);
		expect(await Bun.file(file).text()).toBe(before);
		const next = await manager.appendMessageSharingSession(user("after superseded"));
		expect(next.kind).toBe("committed");
	});

	it("retains attempted thinking ID and real disk evidence after native post-write uncertainty", async () => {
		const { manager, file, anchor } = await sharedSession();
		const original = ManagedSessionDescendantStore.prototype.appendExpectedIdentitySync;
		let attemptedId: string | undefined;
		const append = vi
			.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedIdentitySync")
			.mockImplementation(function (this: ManagedSessionDescendantStore, ...args: Parameters<typeof original>) {
				attemptedId = manager.getLeafId()!;
				original.apply(this, args);
				throw new ManagedCommittedMutationError("append", new Error("thinking uncertainty"));
			});
		const outcome = await manager.withSharedThinkingControl(() =>
			manager.appendThinkingLevelChangeSharingSession("high", true, () => true),
		);
		if (attemptedId === undefined) throw new Error("native thinking append was not reached");
		expect(outcome).toMatchObject({ kind: "unknown", id: attemptedId });
		expect(append).toHaveBeenCalledTimes(1);
		expect((await records(file)).filter(entry => entry.id === attemptedId)).toEqual([
			expect.objectContaining({
				type: "thinking_level_change",
				parentId: anchor,
				thinkingLevel: "high",
				operatorIntent: true,
			}),
		]);
	});
});

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

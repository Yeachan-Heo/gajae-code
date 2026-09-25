import { describe, expect, it } from "bun:test";
import { TempDir } from "@gajae-code/utils";
import {
	commitDurableModelProfileOwnership,
	commitDurableModelProfileOwnershipWithResult,
	type DurableModelProfileOwnership,
	type DurableModelProfileOwnershipStore,
	InvalidModelProfileOwnershipError,
	type ModelProfileOwnershipMarker,
	modelProfileOwnershipMarkersEqual,
	readDurableModelProfileOwnership,
	readDurableModelProfileOwnershipFromRaw,
	resolveEffectiveModelProfileMarker,
	resolveOwnedModelProfileName,
	UnresolvedModelProfileOwnershipError,
	validateDurableModelProfileOwnership,
} from "../src/config/model-profile-ownership";
import { Settings, type SettingsAtomicPatch } from "../src/config/settings";
import { SessionManager } from "../src/session/session-manager";

const inherit: ModelProfileOwnershipMarker = { kind: "inherit" };
const cleared: ModelProfileOwnershipMarker = { kind: "cleared" };
const profileA: ModelProfileOwnershipMarker = { kind: "profile", profile: "profile-a" };
const profileB: ModelProfileOwnershipMarker = { kind: "profile", profile: "profile-b" };

describe("model-profile ownership contract", () => {
	it.each([
		[inherit, inherit, inherit],
		[inherit, cleared, cleared],
		[inherit, profileA, profileA],
		[cleared, inherit, cleared],
		[cleared, cleared, cleared],
		[cleared, profileA, cleared],
		[profileA, inherit, profileA],
		[profileA, cleared, profileA],
		[profileA, profileB, profileA],
	] as const)("resolves session %o over durable %o", (session, durableMarker, expected) => {
		const durable: DurableModelProfileOwnership = { schemaVersion: 1, version: 7, marker: durableMarker };
		expect(resolveEffectiveModelProfileMarker(session, durable)).toEqual(expected);
	});

	it("uses the durable marker only when the session explicitly inherits", () => {
		const durable = { schemaVersion: 1, version: 3, marker: profileA } as const;
		expect(resolveEffectiveModelProfileMarker(undefined, durable)).toEqual(profileA);
		expect(resolveEffectiveModelProfileMarker(inherit, durable)).toEqual(profileA);
	});

	it("keeps legacy modelProfile.default readable as version zero without writing during reconciliation", () => {
		expect(readDurableModelProfileOwnershipFromRaw({ modelProfile: { default: "profile-a" } })).toEqual({
			schemaVersion: 1,
			version: 0,
			marker: profileA,
		});
		expect(readDurableModelProfileOwnershipFromRaw({})).toEqual({
			schemaVersion: 1,
			version: 0,
			marker: inherit,
		});
	});

	it("rejects a malformed owned record instead of treating it as absence", () => {
		const invalid = { schemaVersion: 1, version: 4, marker: { kind: "profile" } };
		expect(validateDurableModelProfileOwnership(invalid)).toBeUndefined();
		expect(() => readDurableModelProfileOwnershipFromRaw({ modelProfile: { ownership: invalid } })).toThrow(
			InvalidModelProfileOwnershipError,
		);
	});

	it("rejects a stale ownership write and preserves the newer durable winner", async () => {
		const newerRecord = { schemaVersion: 1, version: 3, marker: profileB };
		const raw = { modelProfile: { ownership: newerRecord, default: "profile-b" } };
		const store: DurableModelProfileOwnershipStore = {
			getGlobal: (path: "modelProfile.ownership" | "modelProfile.default") =>
				path === "modelProfile.default" ? "profile-a" : undefined,
			commitAtomicBatchWithCurrent: async buildPatches => {
				await buildPatches(raw);
			},
		};

		await expect(commitDurableModelProfileOwnership(store, profileA)).rejects.toThrow(
			expect.objectContaining({
				code: "model_profile_ownership_conflict",
				expectedVersion: 0,
				actualVersion: 3,
			}),
		);
		expect(raw.modelProfile.ownership).toEqual(newerRecord);
		expect(() => resolveOwnedModelProfileName(profileA, new Map())).toThrow(UnresolvedModelProfileOwnershipError);
	});

	it("resolves the legacy codex-standard alias without overriding a custom shadow", () => {
		const codexProfiles = new Map([["codex-medium", {}]]);
		const shadowingProfiles = new Map([
			["codex-standard", {}],
			["codex-medium", {}],
		]);

		expect(resolveOwnedModelProfileName({ kind: "profile", profile: "codex-standard" }, codexProfiles)).toBe(
			"codex-medium",
		);
		expect(resolveOwnedModelProfileName({ kind: "profile", profile: "codex-standard" }, shadowingProfiles)).toBe(
			"codex-standard",
		);
	});

	it("commits the durable marker and its legacy projection atomically", async () => {
		const settings = Settings.isolated({
			"modelProfile.default": "profile-a",
			modelRoles: { default: "ordinary/default" },
		});
		const next = await commitDurableModelProfileOwnership(settings, profileB, [
			{ path: "modelRoles", op: "set", value: { default: "updated/default" } },
		]);

		expect(next).toEqual({ schemaVersion: 1, version: 1, marker: profileB });
		expect(
			readDurableModelProfileOwnershipFromRaw({
				modelProfile: { ownership: next, default: "profile-b" },
			}),
		).toEqual(next);
		expect(settings.getGlobal("modelProfile.default")).toBe("profile-b");
		expect(readDurableModelProfileOwnership(settings)).toEqual(next);
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "updated/default" });
		expect(settings.getGlobal("modelProfile.default")).not.toBeUndefined();
	});

	it("rejects extra patches that could overwrite the owner record or its projection", async () => {
		const settings = Settings.isolated();
		const patches: SettingsAtomicPatch[] = [
			{ path: "modelProfile.ownership", op: "set", value: { schemaVersion: 1, version: 1, marker: profileA } },
			{ path: "modelProfile.default", op: "set", value: "profile-b" },
		];
		for (const patch of patches) {
			await expect(commitDurableModelProfileOwnership(settings, profileA, [patch])).rejects.toThrow(
				"Durable ownership extra patches cannot target",
			);
		}
		expect(readDurableModelProfileOwnership(settings)).toMatchObject({ version: 0, marker: inherit });
	});

	it("requires the legacy default projection to match an owned durable record", () => {
		expect(() =>
			readDurableModelProfileOwnershipFromRaw({
				modelProfile: {
					ownership: { schemaVersion: 1, version: 2, marker: profileA },
					default: "profile-b",
				},
			}),
		).toThrow(InvalidModelProfileOwnershipError);
	});

	it("reconciles an already committed durable clear without a second version write", async () => {
		const settings = Settings.isolated({ "modelProfile.default": "profile-a" });
		const committed = await commitDurableModelProfileOwnership(settings, cleared);
		const retried = await commitDurableModelProfileOwnership(settings, cleared);

		expect(committed.version).toBe(1);
		expect(retried).toEqual(committed);
		expect(readDurableModelProfileOwnership(settings)).toEqual(committed);
	});

	it("does not advance ownership when an identical durable extra patch is retried", async () => {
		const settings = Settings.isolated({ "modelProfile.default": "profile-a" });
		const extraPatches = [{ path: "defaultThinkingLevel" as const, op: "set" as const, value: "high" }];
		const first = await commitDurableModelProfileOwnershipWithResult(settings, profileA, extraPatches);
		const retried = await commitDurableModelProfileOwnershipWithResult(settings, profileA, extraPatches);

		expect(first).toEqual({
			ownership: { schemaVersion: 1, version: 1, marker: profileA },
			wrote: true,
		});
		expect(retried).toEqual({ ownership: first.ownership, wrote: false });
		expect(readDurableModelProfileOwnership(settings)).toEqual(first.ownership);
	});

	it("rejects a stale in-memory retry even when the newer durable marker matches", async () => {
		const expected = { schemaVersion: 1 as const, version: 1, marker: profileA };
		const actual = { schemaVersion: 1 as const, version: 2, marker: cleared };
		let lockReads = 0;
		let patches: readonly unknown[] | undefined;
		const store: DurableModelProfileOwnershipStore = {
			getGlobal: path => (path === "modelProfile.ownership" ? expected : "profile-a"),
			commitAtomicBatchWithCurrent: async buildPatches => {
				lockReads++;
				patches = await buildPatches({ modelProfile: { ownership: actual } });
			},
		};

		await expect(commitDurableModelProfileOwnershipWithResult(store, cleared)).rejects.toMatchObject({
			code: "model_profile_ownership_conflict",
			expectedVersion: 1,
			actualVersion: 2,
			actualMarker: cleared,
		});

		expect(lockReads).toBe(1);
		expect(patches).toBeUndefined();
	});

	it("persists ownership markers through transcript reopen", async () => {
		const tempDir = TempDir.createSync("@gjc-profile-ownership-transcript-");
		let manager: SessionManager | undefined;
		let reopened: SessionManager | undefined;
		try {
			manager = SessionManager.create(tempDir.path(), tempDir.path());
			manager.appendModelProfileOwnershipMarker(profileA);
			manager.appendMessage({ role: "user", content: "old context", timestamp: 1 });
			const firstKeptEntryId = manager.appendMessage({ role: "user", content: "kept context", timestamp: 2 });
			manager.appendCompaction("summary", undefined, firstKeptEntryId, 100);
			await manager.ensureOnDisk();
			await manager.flush();
			manager.setSessionMemoryMode("enabled");
			expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(true);
			const contextSnapshot = manager.buildSessionContext();
			expect(contextSnapshot.modelProfileOwnershipMarker).toEqual(profileA);
			contextSnapshot.modelProfileOwnershipMarker = cleared;
			expect(manager.buildSessionContext().modelProfileOwnershipMarker).toEqual(profileA);
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted session file");
			await manager.close();
			manager = undefined;

			reopened = await SessionManager.open(sessionFile);
			reopened.setSessionMemoryMode("enabled");
			expect(reopened.getModelProfileOwnershipMarker()).toEqual(profileA);
			expect(reopened.buildSessionContext().modelProfileOwnershipMarker).toEqual(profileA);
		} finally {
			await manager?.close();
			await reopened?.close();
			tempDir.removeSync();
		}
	});

	it("rejects an invalid ownership marker before appending it", async () => {
		const manager = SessionManager.inMemory();
		try {
			expect(() => manager.appendModelProfileOwnershipMarker({ kind: "profile", profile: " " })).toThrow(
				InvalidModelProfileOwnershipError,
			);
			expect(manager.getModelProfileOwnershipMarker()).toBeUndefined();
			expect(manager.getEntries().some(entry => entry.type === "custom")).toBe(false);
		} finally {
			await manager.close();
		}
	});

	it("compares inherited and absent session decisions as the same owner", () => {
		expect(modelProfileOwnershipMarkersEqual(undefined, inherit)).toBe(true);
		expect(modelProfileOwnershipMarkersEqual(cleared, inherit)).toBe(false);
	});
});

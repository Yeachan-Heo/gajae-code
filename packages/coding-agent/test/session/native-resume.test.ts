import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createCooperativeOwnerInspectors } from "../../src/sdk/native-ownership";
import { captureNativeResumeTranscript, nativeResumeBinding, resumeDigest } from "../../src/session/native-resume";
import {
	admitOwnerMembershipSync,
	captureLegacyTakeoverAttestationSync,
	captureOwnerTargetSync,
} from "../../src/session/owner-group";
import { reduceResumeTranscript, resolveResumeCheckpoint } from "../../src/session/resume-cursor";
import type { ResumeRouting } from "../../src/session/resume-operation";
import { BOUNDED_RESUME_TRANSCRIPT_MAX_BYTES, type FileEntry, SessionManager } from "../../src/session/session-manager";
import {
	FileSessionStorage,
	type SessionDurabilityRepairRange,
	type SessionDurabilityRepairReceipt,
	type SessionStorageExactReplacementExpectation,
	type SessionStorageSecurityContext,
	type SessionStorageWriter,
	type SessionStorageWriterOpenOptions,
} from "../../src/session/session-storage";

const routing: ResumeRouting = {
	contextFamily: "live",
	context: "owned_pre",
	closeOutcome: "none_started",
	invocation: "RECON",
	authorization: { tokenValid: true, terminationIntent: "none", intentValid: false },
	action: "RETAIN_LIVE",
	completionResult: "n/a",
	readiness: { prior: "fenced", current: "fenced" },
};

class FaultStorage extends FileSessionStorage {
	failAppendAfter: number | undefined;
	appendLines = 0;
	repairError: Error | undefined;
	repairs = 0;
	override openWriter(file: string, options?: SessionStorageWriterOpenOptions): SessionStorageWriter {
		const writer = super.openWriter(file, options);
		if (options?.flags !== "a") return writer;
		return new Proxy(writer, {
			get: (target, key) => {
				if (key === "writeLineSync")
					return (line: string) => {
						if (this.failAppendAfter !== undefined && this.appendLines >= this.failAppendAfter)
							throw new Error("injected_append_failure");
						this.appendLines++;
						return target.writeLineSync(line);
					};
				const value: unknown = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}
	override repairDurabilitySync(
		file: string,
		expected: SessionStorageExactReplacementExpectation,
		ranges: readonly SessionDurabilityRepairRange[],
		options?: { securityContext?: SessionStorageSecurityContext },
	): SessionDurabilityRepairReceipt {
		this.repairs++;
		if (this.repairError) throw this.repairError;
		return super.repairDurabilitySync(file, expected, ranges, options);
	}
}

const managers: SessionManager[] = [];
const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) await manager.closeStrict();
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function fixture(
	leaves = 2,
	storage = new FaultStorage(),
	options: { exclusive?: boolean; messageRoot?: boolean } = {},
) {
	const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-native-resume-")));
	directories.push(directory);
	const file = path.join(directory, "session.jsonl");
	const records: FileEntry[] = [
		{ type: "session", version: 5, id: "native-resume-session", timestamp: "0", cwd: directory },
		options.messageRoot
			? {
					type: "message",
					id: "root",
					parentId: null,
					timestamp: "0",
					message: { role: "user", content: "original resident message", timestamp: 0 },
				}
			: { type: "custom", id: "root", parentId: null, timestamp: "0", customType: "test", data: {} },
	];
	for (let i = 0; i < leaves; i++)
		records.push({
			type: "custom",
			id: `leaf-${i}`,
			parentId: "root",
			timestamp: "0",
			customType: "test",
			data: { index: i },
		});
	storage.writeTextSync(file, `${records.map(entry => JSON.stringify(entry)).join("\n")}\n`);
	const agentDir = path.join(directory, "agent");
	fs.mkdirSync(agentDir, { mode: 0o700 });
	const manager = await SessionManager.open(file, SessionManager.explicitDestination(directory, agentDir), storage);
	manager.setSessionMemoryMode("off");
	managers.push(manager);
	if (options.exclusive) {
		const target = captureOwnerTargetSync({ transcriptPath: file, headerId: manager.getSessionId() });
		const inspectors = {
			...createCooperativeOwnerInspectors({ cwd: directory, agentDir }),
			runtime: "sdk-rewrite-test",
			capabilities: ["publication"],
		};
		manager.installOwnerMembership(
			admitOwnerMembershipSync(
				target,
				{
					kind: "exclusive_native",
					expected: {
						snapshotDigest: target.snapshotDigest,
						resolved: resolveResumeCheckpoint(records, target.snapshotDigest),
					},
					legacyAttestation: captureLegacyTakeoverAttestationSync(target, inspectors),
				},
				inspectors,
			),
		);
	}
	return { directory, file, manager, storage, records };
}

function readRecords(file: string, storage: FileSessionStorage): FileEntry[] {
	return storage
		.readTextSync(file)
		.trimEnd()
		.split("\n")
		.map(line => JSON.parse(line) as FileEntry);
}

describe("actual manager resume publication and nonterminal recovery", () => {
	for (const managed of [false, true]) {
		it(`publishes an actually absent ${managed ? "managed" : "explicit"} transcript with a bound no-replace receipt`, async () => {
			const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-initial-resume-")));
			directories.push(directory);
			const storage = new FaultStorage();
			const destination = managed
				? SessionManager.managedDestination(directory, path.join(directory, "agent"), storage)
				: SessionManager.explicitDestination(directory, path.join(directory, "agent"));
			const manager = SessionManager.createForOwnerAdmission(directory, destination, storage);
			managers.push(manager);
			manager.setSessionMemoryMode("off");
			const file = manager.getSessionFile()!;
			expect(storage.existsSync(file)).toBe(false);
			const pending = await manager.appendResumeCursorDurably(null, { op: `fresh-${managed}`, reason: "explicit" });
			const binding = nativeResumeBinding(pending);
			expect(pending.durabilityDebt.fileIdentity).toBeNull();
			expect(pending.durabilityDebt.snapshotDigest).toBe(resumeDigest(""));
			expect(binding.initialPublication?.canonicalPath).toBe(file);
			expect(binding.initialPublication?.successor.fileIdentity).toEqual({
				dev: String(storage.statSync(file).dev),
				ino: String(storage.statSync(file).ino),
			});
			expect(binding.initialPublication?.successor.snapshotDigest).toBe(resumeDigest(storage.readTextSync(file)));
			const result = await manager.reconcileResumeOperation(pending, "verify", routing);
			expect(result.outcome.kind).toBe("committed");
			expect(result.receipt.commitment.continueEligible).toBe(true);
			expect(
				readRecords(file, storage).filter(
					entry => entry.type === "custom" && entry.customType === "gjc.owner_enroll",
				),
			).toHaveLength(1);
		});
	}

	it("keeps a lazy ordinary enrollment unconfirmed until an actual transcript write", async () => {
		const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lazy-owner-marker-")));
		directories.push(directory);
		const storage = new FaultStorage();
		const manager = SessionManager.createForOwnerAdmission(
			directory,
			SessionManager.explicitDestination(directory, path.join(directory, "agent")),
			storage,
		);
		managers.push(manager);
		manager.setSessionMemoryMode("off");
		const id = manager.appendCustomEntry("deferred", { payload: "retained" });
		await manager.flush();
		expect(storage.existsSync(manager.getSessionFile()!)).toBe(false);
		expect(storage.repairs).toBe(0);
		await manager.ensureOnDisk();
		await manager.flush();
		const records = readRecords(manager.getSessionFile()!, storage);
		expect(records.filter(entry => entry.type === "custom" && entry.customType === "gjc.owner_enroll")).toHaveLength(
			1,
		);
		expect(records.filter(entry => entry.id === id)).toHaveLength(1);
		expect(storage.repairs).toBeGreaterThan(0);
		expect(reduceResumeTranscript(records, "").checkpoint.leafEntryId).toBe(id);
	});

	it("binds actual managed append identity successions to a freshly repaired cursor", async () => {
		const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-managed-resume-chain-")));
		directories.push(directory);
		const storage = new FaultStorage();
		const manager = SessionManager.createForOwnerAdmission(
			directory,
			SessionManager.managedDestination(directory, path.join(directory, "agent"), storage),
			storage,
		);
		managers.push(manager);
		manager.setSessionMemoryMode("off");
		const initial = await manager.appendResumeCursorDurably(null, { op: "managed-initial", reason: "explicit" });
		expect((await manager.reconcileResumeOperation(initial, "verify", routing)).outcome.kind).toBe("committed");
		const first = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
		await manager.flush();
		const pending = await manager.appendResumeCursorDurably(first, { op: "managed-selection", reason: "explicit" });
		const binding = nativeResumeBinding(pending);
		if (process.platform === "darwin") expect(binding.publicationSuccessions.length).toBeGreaterThan(0);
		const result = await manager.reconcileResumeOperation(pending, "verify", routing);
		expect(result.outcome.kind).toBe("committed");
		expect(result.receipt.commitment.continueEligible).toBe(true);
		const capture = captureNativeResumeTranscript(manager.getSessionFile()!, storage).capture;
		if (capture.kind !== "captured") throw new Error("Managed capture failed");
		expect(binding.proofs.at(-1)?.fileIdentity).toEqual(capture.fileIdentity);
		expect(binding.proofs.at(-1)?.snapshotDigest).toBe(capture.snapshotDigest);
	});

	it("retains initial fixed IDs through failed sync and certifies them only after fresh repair", async () => {
		const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-initial-sync-")));
		directories.push(directory);
		const storage = new FaultStorage();
		storage.repairError = new Error("initial_sync_refused");
		const manager = SessionManager.createForOwnerAdmission(
			directory,
			SessionManager.explicitDestination(directory, path.join(directory, "agent")),
			storage,
		);
		managers.push(manager);
		manager.setSessionMemoryMode("off");
		const pending = await manager.appendResumeCursorDurably(null, { op: "initial-fixed", reason: "explicit" });
		const before = storage.readTextSync(manager.getSessionFile()!);
		expect(
			(await manager.reconcileResumeOperation(pending, "verify", routing)).receipt.commitment.continueEligible,
		).toBe(false);
		expect(await manager.appendResumeCursorDurably(null, { op: "initial-fixed", reason: "explicit" })).toBe(pending);
		storage.repairError = undefined;
		const recovered = await manager.reconcileResumeOperation(pending, "repairDurability", routing);
		expect(recovered.outcome.kind).toBe("committed");
		expect(recovered.receipt.commitment.heldIds).toEqual([]);
		expect(storage.readTextSync(manager.getSessionFile()!)).toBe(before);
		for (const entry of pending.manifest)
			expect(readRecords(manager.getSessionFile()!, storage).filter(record => record.id === entry.id)).toHaveLength(
				1,
			);
	});

	it("does not bind an actual publication carrying a foreign receipt hash", async () => {
		const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-initial-receipt-")));
		directories.push(directory);
		const storage = new FaultStorage();
		const manager = SessionManager.createForOwnerAdmission(
			directory,
			SessionManager.explicitDestination(directory, path.join(directory, "agent")),
			storage,
		);
		managers.push(manager);
		manager.setSessionMemoryMode("off");
		const open = storage.openStagedWriter.bind(storage);
		vi.spyOn(storage, "openStagedWriter").mockImplementation((file, options) => {
			const writer = open(file, options);
			return new Proxy(writer, {
				get: (target, key) => {
					if (key === "publishNoReplace")
						return () => ({ ...target.publishNoReplace(), sha256: resumeDigest("foreign") });
					const value: unknown = Reflect.get(target, key);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		});
		const pending = await manager.appendResumeCursorDurably(null, { op: "foreign-receipt", reason: "explicit" });
		const bytes = storage.readTextSync(manager.getSessionFile()!);
		expect(nativeResumeBinding(pending).initialPublication).toBeUndefined();
		const result = await manager.reconcileResumeOperation(pending, "complete", routing);
		expect(result.refusal).toBe("stale_snapshot");
		expect(result.receipt.commitment.continueEligible).toBe(false);
		expect(storage.readTextSync(manager.getSessionFile()!)).toBe(bytes);
		expect(storage.repairs).toBe(0);
	});

	it("does not replace a destination that appears during actual initial publication", async () => {
		const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-initial-collision-")));
		directories.push(directory);
		const storage = new FaultStorage();
		const manager = SessionManager.createForOwnerAdmission(
			directory,
			SessionManager.explicitDestination(directory, path.join(directory, "agent")),
			storage,
		);
		managers.push(manager);
		manager.setSessionMemoryMode("off");
		const open = storage.openStagedWriter.bind(storage);
		const foreign = `${JSON.stringify({ type: "session", version: 5, id: "foreign", cwd: directory, timestamp: "0" })}\n`;
		vi.spyOn(storage, "openStagedWriter").mockImplementation((file, options) => {
			const writer = open(file, options);
			return new Proxy(writer, {
				get: (target, key) => {
					if (key === "publishNoReplace")
						return () => {
							storage.writeTextSync(file, foreign);
							return target.publishNoReplace();
						};
					const value: unknown = Reflect.get(target, key);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		});
		const pending = await manager.appendResumeCursorDurably(null, { op: "collision", reason: "explicit" });
		expect(nativeResumeBinding(pending).initialPublication).toBeUndefined();
		expect(storage.readTextSync(manager.getSessionFile()!)).toBe(foreign);
		const result = await manager.reconcileResumeOperation(pending, "verifyReadOnly", routing);
		expect(result.receipt.commitment.continueEligible).toBe(false);
		expect(storage.readTextSync(manager.getSessionFile()!)).toBe(foreign);
	});

	it("initializes an empty captured fork under a new destination member without inventing history", async () => {
		const { storage, file, directory, records } = await fixture(0);
		storage.writeTextSync(file, `${JSON.stringify(records[0])}\n`);
		const source = storage.readTextSync(file);
		const captured = SessionManager.captureTranscriptStrict(file, storage);
		if (captured.kind !== "captured") throw new Error("Source capture failed");
		const destination = path.join(directory, "empty-fork");
		fs.mkdirSync(destination);
		try {
			const fork = await SessionManager.forkFromCaptured(
				captured.snapshot,
				directory,
				SessionManager.explicitDestination(destination, path.join(directory, "agent")),
				"copy-retain",
				"off",
				undefined,
				{ executionTargetLeafId: null },
			);
			if (fork.kind !== "forked") throw new Error(`Fork failed: ${fork.reason}`);
			managers.push(fork.manager);
			const copied = readRecords(fork.manager.getSessionFile()!, storage);
			expect(copied).toHaveLength(2);
			expect(copied[1]).toMatchObject({
				type: "custom",
				customType: "gjc.owner_enroll",
				parentId: null,
				data: { bind: fork.manager.getSessionId(), member: fork.manager.getSessionOwnerEvidence()!.memberId },
			});
			expect(fork.manager.getLeafId()).toBeNull();
			expect(reduceResumeTranscript(copied, "").checkpoint.kind).toBe("empty");
			expect(storage.readTextSync(file)).toBe(source);
		} finally {
			captured.snapshot.close();
		}
	});

	for (const target of [null, "leaf-0"] as const) {
		for (const privateDirectory of [false, true]) {
			it(`native full-history fork preserves all 203 source records at ${target ?? "null"} with ${privateDirectory ? "private" : "existing"} directory publication`, async () => {
				const { storage, file, directory, records } = await fixture(201);
				const source = storage.readTextSync(file);
				const captured = SessionManager.captureTranscriptStrict(file, storage);
				if (captured.kind !== "captured") throw new Error("Source capture failed");
				const destination = path.join(directory, "fork");
				if (!privateDirectory) fs.mkdirSync(destination);
				try {
					const fork = await SessionManager.forkFromCaptured(
						captured.snapshot,
						directory,
						SessionManager.explicitDestination(destination, path.join(directory, "agent")),
						"copy-retain",
						"off",
						undefined,
						{ executionTargetLeafId: target },
					);
					if (fork.kind !== "forked") throw new Error(`Fork failed: ${fork.reason}`);
					managers.push(fork.manager);
					const copied = readRecords(fork.manager.getSessionFile()!, storage);
					expect(records).toHaveLength(203);
					expect(copied.slice(1, records.length).map(entry => JSON.stringify(entry))).toEqual(
						records.slice(1).map(entry => JSON.stringify(entry)),
					);
					expect(copied[0]).toMatchObject({ type: "session", parentSession: "native-resume-session" });
					expect(copied[0]!.id).not.toBe(records[0]!.id);
					const own = copied.slice(records.length);
					expect(own.map(entry => (entry.type === "custom" ? entry.customType : entry.type))).toEqual([
						"gjc.owner_enroll",
						"gjc.resume_cursor",
					]);
					expect(own[1]).toMatchObject({
						parentId: target,
						data: {
							reason: "fork_init",
							bind: fork.manager.getSessionId(),
							member: fork.manager.getSessionOwnerEvidence()!.memberId,
						},
					});
					expect(
						reduceResumeTranscript(copied, resumeDigest(storage.readTextSync(fork.manager.getSessionFile()!)))
							.checkpoint.kind,
					).toBe("recorded");
					const base = fork.manager.getLeafId();
					const appended = fork.manager.appendMessage({ role: "user", content: "after fork", timestamp: 3 });
					await fork.manager.flush();
					const forkFile = fork.manager.getSessionFile()!;
					expect(readRecords(forkFile, storage).find(entry => entry.id === appended)).toMatchObject({
						parentId: base,
					});
					expect((await fork.manager.closeStrict()).kind).toBe("closed");
					const reopened = await SessionManager.open(
						forkFile,
						SessionManager.explicitDestination(destination, path.join(directory, "agent")),
						storage,
					);
					managers.push(reopened);
					reopened.setSessionMemoryMode("off");
					expect(reopened.getLeafId()).toBe(appended);
					expect(storage.readTextSync(file)).toBe(source);
				} finally {
					captured.snapshot.close();
				}
			});
		}
	}

	it("writes enrollment before chunked cursors, preserving the 256 bound and immutable CB", async () => {
		const { manager, file, storage } = await fixture(258);
		const pending = await manager.appendResumeCursorDurably("leaf-0", { op: "chunked", reason: "explicit" });
		expect(pending.plan.cursorIds).toHaveLength(2);
		expect(Object.isFrozen(pending)).toBe(true);
		expect(Object.isFrozen(pending.manifest)).toBe(true);
		const records = readRecords(file, storage);
		const own = records.slice(260);
		expect(own.map(entry => (entry.type === "custom" ? entry.customType : entry.type))).toEqual([
			"gjc.owner_enroll",
			"gjc.resume_cursor",
			"gjc.resume_cursor",
		]);
		const cursors = own.slice(1);
		if (cursors[0]?.type !== "custom" || cursors[1]?.type !== "custom") throw new Error("Missing cursor records");
		expect(cursors[0].parentId).toBe("leaf-0");
		expect(cursors[1].parentId).toBe(cursors[0].id);
		expect(
			cursors.map(entry =>
				entry.type === "custom" ? (entry.data as { supersedes: string[] }).supersedes.length : 0,
			),
		).toEqual([256, 1]);
		const result = await manager.reconcileResumeOperation(pending, "verify", routing);
		expect(result.outcome.kind).toBe("committed");
		expect(result.receipt.selectionAppendBase).toBe(pending.CB);
		expect(result.receipt.commitment.operationComplete).toBe(true);
		expect(manager.getStrictCloseState().kind).toBe("none_started");
	});

	it("preserves an explicit root-null continuation and keeps presentation restore non-appending", async () => {
		const { manager, file, storage } = await fixture();
		manager.branch("leaf-0");
		manager.resetLeaf();
		const before = storage.readTextSync(file);
		expect(manager.getLeafId()).toBeNull();
		expect(storage.readTextSync(file)).toBe(before);
		const pending = await manager.selectExecutionBranch(null, { op: "root-null" });
		const cursor = readRecords(file, storage).find(entry => entry.id === pending.plan.cursorIds[0]);
		if (cursor?.type !== "custom") throw new Error("Missing root cursor");
		expect(cursor.parentId).toBeNull();
		const result = await manager.reconcileResumeOperation(pending, "verify", routing);
		expect(result.receipt.targetLeafId).toBeNull();
		expect(result.receipt.commitment.selectionCommitted).toBe(true);
	});

	it("retains a marker-only attempt and completes the original fixed cursor IDs without a duplicate marker", async () => {
		const { manager, storage, file } = await fixture();
		storage.failAppendAfter = 1;
		const pending = await manager.appendResumeCursorDurably("leaf-0", { op: "partial", reason: "explicit" });
		const again = await manager.appendResumeCursorDurably("leaf-0", { op: "partial", reason: "explicit" });
		expect(again).toBe(pending);
		storage.failAppendAfter = undefined;
		const repaired = await manager.reconcileResumeOperation(pending, "repairDurability", routing);
		expect(repaired.outcome.kind).toBe("enrolled_only");
		expect(repaired.receipt.frontier.CF).toBe("leaf-1");
		expect(repaired.receipt.commitment.selectionCommitted).toBe(false);
		const completed = await manager.reconcileResumeOperation(pending, "complete", routing);
		expect(completed.outcome.kind).toBe("committed");
		const records = readRecords(file, storage);
		for (const id of pending.manifest.map(entry => entry.id))
			expect(records.filter(entry => entry.id === id)).toHaveLength(1);
		expect(manager.getStrictCloseState().kind).toBe("none_started");
	});

	it("never treats readable bytes as durability and only clears the original latch after fresh repair", async () => {
		const { manager, storage, file } = await fixture();
		storage.repairError = new Error("injected_sync_failure");
		const pending = await manager.appendResumeCursorDurably("leaf-0", { op: "sync-debt", reason: "explicit" });
		const bytes = storage.readTextSync(file);
		const failed = await manager.reconcileResumeOperation(pending, "verify", routing);
		expect(failed.outcome.kind).toBe("unknown");
		expect(failed.receipt.commitment.continueEligible).toBe(false);
		expect(manager.getOwnerMembership()).toBeDefined();
		storage.repairError = undefined;
		const recovered = await manager.reconcileResumeOperation(pending, "repairDurability", routing);
		expect(recovered.outcome.kind).toBe("committed");
		expect(recovered.receipt.routing.readiness.current).toBe("ready");
		expect(storage.readTextSync(file)).toBe(bytes);
		expect(storage.repairs).toBe(2);
	});

	for (const { exclusive, changedPrefix } of [
		{ exclusive: false, changedPrefix: false },
		{ exclusive: true, changedPrefix: false },
		{ exclusive: true, changedPrefix: true },
	]) {
		it(`${exclusive ? "exclusive" : "cooperative"} recovery ${changedPrefix ? "refuses a changed authenticated historical prefix" : exclusive ? "publishes exact-CAS identical entries with positive proof" : "refuses resident rewrite debt without changing bytes"}`, async () => {
			const { manager, storage, file } = await fixture(2, new FaultStorage(), { exclusive, messageRoot: true });
			storage.repairError = new Error("rewrite_initial_sync_debt");
			const pending = await manager.appendResumeCursorDurably("leaf-0", {
				op: `rewrite-${exclusive}`,
				reason: "explicit",
			});
			const member = manager.getSessionOwnerEvidence()!;
			const root = manager.getEntry("root");
			if (root?.type !== "message") throw new Error("Missing resident message");
			manager.applyEntryMessageUpdates([
				{
					...root,
					message: changedPrefix
						? { role: "user", content: "changed historical message", timestamp: 1 }
						: root.message,
				},
			]);
			const before = storage.readTextSync(file);
			const freeze = await manager.quiesceNonterminalPublication(Symbol("inspect rewrite debt"));
			try {
				expect(freeze.debt().rewriteDebt).toBe(true);
			} finally {
				await freeze.thaw();
			}
			storage.repairError = undefined;
			const replace = vi.spyOn(storage, "replaceExactSync");
			const completed = await manager.reconcileResumeOperation(pending, "complete", routing);
			expect(manager.getSessionOwnerEvidence()!.memberId).toBe(member.memberId);
			expect(manager.getSessionOwnerEvidence()!.epoch).toBe(member.epoch);
			if (!exclusive || changedPrefix) {
				expect(completed.refusal).toBe(changedPrefix ? "foreign_progress" : "rewrite_required");
				expect(completed.receipt.commitment.continueEligible).toBe(false);
				expect(storage.readTextSync(file)).toBe(before);
				expect(replace).not.toHaveBeenCalled();
				return;
			}
			expect(replace).toHaveBeenCalledTimes(1);
			expect(replace.mock.calls[0]?.[2]).toMatchObject({ sha256: resumeDigest(before) });
			expect(completed.outcome.kind, JSON.stringify(completed.receipt)).toBe("committed");
			expect(completed.receipt.commitment.continueEligible).toBe(true);
			expect(completed.receipt.routing.readiness.current).toBe("ready");
			expect(completed.receipt.commitment.heldIds).toEqual([]);
			expect(nativeResumeBinding(pending).durabilityState).toBe("proven");
			expect(nativeResumeBinding(pending).proofs.at(-1)?.snapshotDigest).toBe(
				resumeDigest(storage.readTextSync(file)),
			);
			expect(nativeResumeBinding(pending).publicationSuccessions).toHaveLength(1);
			expect(readRecords(file, storage).find(entry => entry.id === "root")).toEqual(root);
			for (const entry of pending.manifest)
				expect(readRecords(file, storage).filter(record => record.id === entry.id)).toHaveLength(1);
			const after = await manager.quiesceNonterminalPublication(Symbol("inspect rewrite settlement"));
			try {
				expect(after.debt().rewriteDebt).toBe(false);
				expect(after.debt().persistError).toBeUndefined();
			} finally {
				await after.thaw();
			}
			const appended = manager.appendCustomEntry("after-rewrite", {});
			await manager.flush();
			expect(readRecords(file, storage).filter(entry => entry.id === appended)).toHaveLength(1);
		});
	}

	for (const interference of ["path replacement", "owner change"] as const) {
		it(`exclusive rewrite recovery never overwrites ${interference}`, async () => {
			const { manager, storage, file } = await fixture(2, new FaultStorage(), {
				exclusive: true,
				messageRoot: true,
			});
			storage.repairError = new Error("rewrite_interference_sync_debt");
			const pending = await manager.appendResumeCursorDurably("leaf-0", {
				op: `rewrite-${interference}`,
				reason: "explicit",
			});
			const root = manager.getEntry("root");
			if (root?.type !== "message") throw new Error("Missing resident message");
			manager.applyEntryMessageUpdates([
				{ ...root, message: { role: "user", content: "must not overwrite foreign bytes", timestamp: 1 } },
			]);
			storage.repairError = undefined;
			if (interference === "path replacement") {
				const foreign = `${JSON.stringify({ type: "session", version: 5, id: "foreign", timestamp: "0", cwd: manager.getCwd() })}\n`;
				storage.writeTextSync(`${file}.foreign`, foreign);
				fs.renameSync(`${file}.foreign`, file);
			} else {
				const authority = manager.getSessionOwnerEvidence()!.authorityKey;
				const record = JSON.parse(fs.readFileSync(authority, "utf8")) as { epoch: string };
				const epoch = `${record.epoch[0] === "0" ? "1" : "0"}${record.epoch.slice(1)}`;
				fs.writeFileSync(authority, `${JSON.stringify({ ...record, epoch })}\n`);
			}
			const before = storage.readTextSync(file);
			const replace = vi.spyOn(storage, "replaceExactSync");
			const result = await manager.reconcileResumeOperation(pending, "complete", routing);
			expect(result.receipt.commitment.continueEligible).toBe(false);
			expect(result.refusal).toBe(interference === "path replacement" ? "stale_snapshot" : "participation_lost");
			expect(storage.readTextSync(file)).toBe(before);
			expect(replace).not.toHaveBeenCalled();
			expect(nativeResumeBinding(pending).publicationSuccessions).toEqual([]);
			const debt = await manager.quiesceNonterminalPublication(Symbol("retained rewrite debt"));
			try {
				expect(debt.debt().rewriteDebt).toBe(true);
			} finally {
				await debt.thaw();
			}
		});
	}

	it("holds an explained job descendant through verify and repair, then completes it once without rewinding RT", async () => {
		const { manager, storage, file } = await fixture();
		storage.repairError = new Error("initial_sync_debt");
		const pending = await manager.appendResumeCursorDurably("leaf-0", { op: "held-suffix", reason: "explicit" });
		const freeze = await manager.quiesceNonterminalPublication(Symbol("job"));
		const jobId = manager.appendMessage({ role: "user", content: "job descendant", timestamp: 2 });
		await freeze.thaw();
		const before = storage.readTextSync(file);
		storage.repairError = undefined;
		const verified = await manager.reconcileResumeOperation(pending, "verify", routing);
		expect(verified.receipt.commitment.operationComplete).toBe(false);
		expect(storage.readTextSync(file)).toBe(before);
		const repaired = await manager.reconcileResumeOperation(pending, "repairDurability", routing);
		expect(repaired.outcome.kind).toBe("suffix_incomplete");
		expect(repaired.receipt.commitment.selectionCommitted).toBe(true);
		expect(repaired.receipt.commitment.heldIds).toContain(jobId);
		expect(repaired.receipt.commitment.operationComplete).toBe(false);
		expect(storage.readTextSync(file)).toBe(before);
		expect(manager.getOwnerMembership()).toBeDefined();
		const completed = await manager.reconcileResumeOperation(pending, "complete", routing);
		expect(completed.outcome.kind).toBe("committed");
		expect(completed.receipt.selectionAppendBase).toBe(pending.CB);
		expect(completed.receipt.residentTip).toBe(jobId);
		expect(manager.getLeafId()).toBe(jobId);
		expect(readRecords(file, storage).filter(entry => entry.id === jobId)).toHaveLength(1);
		expect(manager.getStrictCloseState().kind).toBe("none_started");
	});

	it("refuses foreign file progress before completion publishes any missing entry", async () => {
		const { manager, storage, file } = await fixture();
		storage.failAppendAfter = 1;
		const pending = await manager.appendResumeCursorDurably("leaf-0", { op: "foreign", reason: "explicit" });
		storage.failAppendAfter = undefined;
		storage.writeTextSync(
			file,
			`${storage.readTextSync(file)}${JSON.stringify({ type: "custom", id: "foreign", parentId: "root", timestamp: "0", customType: "foreign", data: {} })}\n`,
		);
		const before = storage.readTextSync(file);
		const result = await manager.reconcileResumeOperation(pending, "complete", routing);
		expect(result.refusal).toBe("foreign_progress");
		expect(storage.readTextSync(file)).toBe(before);
		expect(result.receipt.routing.action).toBe("RETAIN_LIVE");
		expect(manager.getStrictCloseState().kind).toBe("none_started");
	});

	it("bounded strict capture covers exact raw bytes and runs the real marker-contracted reducer", async () => {
		const { manager, storage, file } = await fixture(1);
		const pending = await manager.appendResumeCursorDurably("leaf-0", { op: "zero-cursor", reason: "explicit" });
		expect(pending.plan.cursorIds).toEqual([]);
		const observed = captureNativeResumeTranscript(file, storage);
		expect(observed.capture.kind).toBe("captured");
		if (observed.capture.kind !== "captured") throw new Error("capture failed");
		expect(observed.capture.bytes).toBeUndefined();
		expect(observed.capture.byteEvidence?.fullDigest).toBe(resumeDigest(storage.readTextSync(file)));
		expect(observed.capture.byteEvidence?.byteLength).toBe(storage.statSync(file).size);
		expect(observed.capture.reducerView.leafEntryId).toBe("leaf-0");
		expect(
			reduceResumeTranscript(readRecords(file, storage), observed.capture.snapshotDigest).markerEvidence,
		).toHaveLength(1);
		const result = await manager.reconcileResumeOperation(pending, "verifyReadOnly", routing);
		expect(result.receipt.commitment.operationComplete).toBe(true);
	});

	it("streams exact prefix receipts and projects patched large messages without whole-source reads", async () => {
		const { storage, file, directory } = await fixture(1);
		const prefix = storage.readTextSync(file);
		const physical = `${prefix}${[
			{
				type: "message",
				id: "large",
				parentId: "leaf-0",
				timestamp: "0",
				message: { role: "user", content: "payload".repeat(100_000), timestamp: 0 },
			},
			{
				type: "entry_patch",
				entryId: "large",
				patch: { message: { role: "user", content: "replacement".repeat(100_000), timestamp: 1 } },
			},
			{ type: "header_patch", patch: { cwd: directory, title: "irrelevant conversational header metadata" } },
			{
				type: "custom",
				id: "bad-marker",
				parentId: "large",
				timestamp: "0",
				customType: "gjc.owner_enroll",
				data: { v: 1, bind: "other-session" },
			},
		]
			.map(record => JSON.stringify(record))
			.join("\n\n")}\n\n`;
		storage.writeTextSync(file, physical);
		const readWhole = vi.spyOn(storage, "readTextSync").mockImplementation(() => {
			throw new Error("whole_source_read_forbidden");
		});
		const midLinePrefix = Buffer.byteLength(prefix) + 128;
		const captured = captureNativeResumeTranscript(file, storage, [Buffer.byteLength(prefix), midLinePrefix]);
		expect(captured.capture.kind).toBe("captured");
		if (captured.capture.kind !== "captured") throw new Error(captured.capture.error);
		expect(readWhole).not.toHaveBeenCalled();
		expect(captured.identity?.sha256).toBe(resumeDigest(physical));
		expect(captured.capture.byteEvidence?.prefixes).toContainEqual({
			byteLength: Buffer.byteLength(prefix),
			sha256: resumeDigest(prefix),
		});
		expect(captured.capture.byteEvidence?.prefixes).toContainEqual({
			byteLength: midLinePrefix,
			sha256: resumeDigest(Buffer.from(physical).subarray(0, midLinePrefix)),
		});
		expect(captured.capture.entries.find(entry => entry.id === "bad-marker")?.order).toBe(9);
		expect(captured.capture.reducerView.leafEntryId).toBe("large");
		expect(captured.executionTail).toBe("large");
		expect(captured.markers).toEqual([]);
		expect(captured.invalidOwnerMarkers).toBe(true);
		readWhole.mockRestore();
	});

	it("retains a typed oversized capture failure without converting it into empty or absent history", async () => {
		const { storage, file } = await fixture(1);
		fs.truncateSync(file, BOUNDED_RESUME_TRANSCRIPT_MAX_BYTES + 1);
		const captured = captureNativeResumeTranscript(file, storage);
		expect(captured.capture.kind).toBe("read_failed");
		expect(captured.failure?.reason).toBe("oversized");
		expect(captured.identity).toBeUndefined();
		expect(captured.markers).toBeUndefined();
	});

	it("keeps immutable operation data usable after actual close releases resident state", async () => {
		const { manager, storage, file } = await fixture();
		const pending = await manager.appendResumeCursorDurably("leaf-0", { op: "post", reason: "explicit" });
		await manager.reconcileResumeOperation(pending, "verify", routing);
		expect((await manager.closeStrict()).kind).toBe("closed");
		const authorization = {
			kind: "coordinator_abort" as const,
			registryIntentId: "intent",
			coordinatorOpenToken: "token",
			ownership: "owned_pre" as const,
			runtimeHandoff: false as const,
		};
		const closure = await manager.getResumeClosureEvidence(pending, authorization);
		expect(closure?.residentReleased).toBe(true);
		const result = await manager.captureResumeOperationAfterClose(
			pending,
			{
				...routing,
				context: "terminal",
				contextFamily: "terminal",
				closeOutcome: "closed",
				action: "POST_READONLY",
			},
			closure,
		);
		expect(result.receipt.commitment.selectionCommitted).toBe(true);
		expect(result.receipt.terminalDisposition.kind).toBe("retained_after_close");
		expect(nativeResumeBinding(pending).path).toBe(file);
		expect(readRecords(file, storage).filter(entry => pending.plan.cursorIds.includes(entry.id))).toHaveLength(
			pending.plan.cursorIds.length,
		);
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import * as native from "@gajae-code/natives";
import {
	ManagedSessionDescendantStore,
	managedDirectoryRoot,
	reapScrubbedProtocolRemnantsSync,
} from "../../src/session/internal/managed-session-storage";
import { makeAssistantMessage } from "./helpers";

function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

async function readText(filePath: string): Promise<string> {
	return Bun.file(filePath).text();
}

async function readBytes(filePath: string): Promise<Buffer> {
	return Buffer.from(await Bun.file(filePath).arrayBuffer());
}

describe("managed rewrite ENOENT regression (P0)", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		root = tempDir("gjc-managed-enoent-");
		agentDir = path.join(root, "agent");
		cwd = path.join(root, "work");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("recreates a deleted predecessor without overwriting a successor", async () => {
		// Linux retained RecoveryFsRoot reports a deleted predecessor as not_found.
		// The managed store must normalize only that authority result to ENOENT so
		// this recovery path recreates the complete resident transcript. Other hosts
		// exercise the equivalent direct filesystem ENOENT path.
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(makeAssistantMessage() as never);
		await manager.flush();

		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeTruthy();
		expect(fs.existsSync(sessionFile!)).toBe(true);

		fs.rmSync(sessionFile!, { force: true });
		expect(fs.existsSync(sessionFile!)).toBe(false);

		expect(() =>
			manager.appendMessage({ role: "user", content: "after-delete", timestamp: Date.now() }),
		).not.toThrow();

		expect(fs.existsSync(sessionFile!)).toBe(true);
		expect(await readText(sessionFile!)).toContain("after-delete");

		await manager.close();
	});

	it("does not overwrite a successor installed after missing-predecessor confirmation", async () => {
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(makeAssistantMessage() as never);
		await manager.flush();

		const sessionFile = manager.getSessionFile()!;
		fs.rmSync(sessionFile);
		const successor = `${JSON.stringify({ type: "session", id: "successor", timestamp: new Date().toISOString(), cwd })}\n`;
		const publishNoReplace = ManagedSessionDescendantStore.prototype.publishNoReplaceSync;
		vi.spyOn(ManagedSessionDescendantStore.prototype, "publishNoReplaceSync").mockImplementation(function (
			this: ManagedSessionDescendantStore,
			relativePath,
			bytes,
		) {
			fs.writeFileSync(sessionFile, successor);
			return publishNoReplace.call(this, relativePath, bytes);
		});

		expect(() =>
			manager.appendMessage({ role: "user", content: "must-not-overwrite-successor", timestamp: Date.now() }),
		).toThrow();
		expect(await readText(sessionFile)).toBe(successor);
		await manager.close().catch(() => {});
	});

	it("keeps a published missing-predecessor entry resident when recapture fails", async () => {
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(makeAssistantMessage() as never);
		await manager.flush();

		const sessionFile = manager.getSessionFile()!;
		fs.rmSync(sessionFile);
		const publishNoReplace = ManagedSessionDescendantStore.prototype.publishNoReplaceSync;
		const captureExpectation = ManagedSessionDescendantStore.prototype.captureBoundedAppendExpectation;
		let published = false;
		let recaptureFailed = false;
		vi.spyOn(ManagedSessionDescendantStore.prototype, "publishNoReplaceSync").mockImplementation(function (
			this: ManagedSessionDescendantStore,
			relativePath,
			bytes,
		) {
			const receipt = publishNoReplace.call(this, relativePath, bytes);
			published = true;
			return receipt;
		});
		vi.spyOn(ManagedSessionDescendantStore.prototype, "captureBoundedAppendExpectation").mockImplementation(function (
			this: ManagedSessionDescendantStore,
			relativePath,
		) {
			if (published && !recaptureFailed) {
				recaptureFailed = true;
				throw new Error("recapture_failed");
			}
			return captureExpectation.call(this, relativePath);
		});
		const replaceExpected = vi.spyOn(ManagedSessionDescendantStore.prototype, "replaceExpectedIdentitySync");

		expect(() =>
			manager.appendMessage({ role: "user", content: "durable-after-delete", timestamp: Date.now() }),
		).toThrow(/managed_replace_committed_outcome_uncertain/);
		expect(await readText(sessionFile)).toContain("durable-after-delete");
		expect(manager.getBranch().some(entry => JSON.stringify(entry).includes("durable-after-delete"))).toBe(true);

		await manager.ensureOnDisk();
		expect(replaceExpected).toHaveBeenCalledTimes(1);
		expect(await readText(sessionFile)).toContain("durable-after-delete");
		await manager.close().catch(() => {});
	});

	it("fails closed when a successor wins the native replacement boundary", async () => {
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(makeAssistantMessage() as never);
		await manager.flush();
		const assistant = manager
			.getBranch()
			.find(entry => entry.type === "message" && entry.message.role === "assistant");
		if (assistant?.type !== "message") throw new Error("Expected assistant entry");
		manager.applyEntryMessageUpdates([assistant]);

		const sessionFile = manager.getSessionFile()!;
		const predecessor = path.join(root, "retained-predecessor.jsonl");
		const successor = `${JSON.stringify({ type: "session", id: "successor", timestamp: new Date().toISOString(), cwd })}\n`;
		const replaceManaged = native.RecoveryFsRoot.prototype.replaceManaged;
		vi.spyOn(native.RecoveryFsRoot.prototype, "replaceManaged").mockImplementation(function (
			this: native.RecoveryFsRoot,
			relativePath,
			bytes,
			expectedDev,
			expectedIno,
			expectedSize,
			expectedMtimeNs,
			expectedCtimeNs,
			expectedSha256,
		) {
			fs.renameSync(sessionFile, predecessor);
			fs.writeFileSync(sessionFile, successor);
			return replaceManaged.call(
				this,
				relativePath,
				bytes,
				expectedDev,
				expectedIno,
				expectedSize,
				expectedMtimeNs,
				expectedCtimeNs,
				expectedSha256,
			);
		});

		expect(() =>
			manager.appendMessage({ role: "user", content: "must-not-overwrite-successor", timestamp: Date.now() }),
		).toThrow(/identity_mismatch/);
		expect(await readText(sessionFile)).toBe(successor);
		expect(await readText(predecessor)).not.toContain("must-not-overwrite-successor");
		await manager.close().catch(() => {});
	});

	it("fails closed before a later resident mutation after an identity-less committed append", async () => {
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(makeAssistantMessage() as never);
		manager.appendCustomMessageEntry("barrier-test", "resident custom", false);
		await manager.flush();

		const sessionFile = manager.getSessionFile()!;
		const appendManaged = native.RecoveryFsRoot.prototype.appendManaged;
		let failOnce = true;
		let appendCalls = 0;
		vi.spyOn(native.RecoveryFsRoot.prototype, "appendManaged").mockImplementation(function (
			this: native.RecoveryFsRoot,
			relativePath,
			bytes,
			expectedDev,
			expectedIno,
			expectedSize,
			expectedMtimeNs,
			expectedCtimeNs,
			expectedSha256,
		) {
			appendCalls += 1;
			const committed = appendManaged.call(
				this,
				relativePath,
				bytes,
				expectedDev,
				expectedIno,
				expectedSize,
				expectedMtimeNs,
				expectedCtimeNs,
				expectedSha256,
			);
			if (!failOnce) return committed;
			failOnce = false;
			return {
				...committed,
				ok: false,
				code: "io_error",
				identity: undefined,
				mutationState: "committed",
				durabilityState: "not_provable",
			};
		});

		expect(() =>
			manager.appendMessage({ role: "user", content: "identity-less-committed", timestamp: Date.now() }),
		).toThrow(/managed_append_committed_outcome_uncertain/);
		const residentCount = manager.getBranch().length;
		const persisted = await readText(sessionFile);
		expect(persisted).toContain("identity-less-committed");
		const residentAssistant = manager
			.getBranch()
			.find(entry => entry.type === "message" && entry.message.role === "assistant");
		if (residentAssistant?.type !== "message") throw new Error("Expected resident assistant entry");
		const residentCustom = manager.getBranch().find(entry => entry.type === "custom_message");
		if (residentCustom?.type !== "custom_message") throw new Error("Expected resident custom entry");
		expect(() =>
			manager.applyEntryMessageUpdates([
				{ ...residentAssistant, message: { ...residentAssistant.message } } as never,
			]),
		).toThrow(/managed_append_committed_outcome_uncertain/);
		expect(() =>
			manager.applyCustomMessageEntryUpdates([{ ...residentCustom, content: residentCustom.content } as never]),
		).toThrow(/managed_append_committed_outcome_uncertain/);

		expect(() =>
			manager.appendMessage({ role: "user", content: "must-not-retry-stale-predecessor", timestamp: Date.now() }),
		).toThrow(/managed_append_committed_outcome_uncertain/);
		expect(appendCalls).toBe(1);
		expect(manager.getBranch()).toHaveLength(residentCount);
		expect(await readText(sessionFile)).not.toContain("must-not-retry-stale-predecessor");
		await manager.close().catch(() => {});
	});

	it("does not rewrite over foreign bytes after an identity-less append outcome", async () => {
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(makeAssistantMessage() as never);
		await manager.flush();

		const sessionFile = manager.getSessionFile()!;
		const appendManaged = native.RecoveryFsRoot.prototype.appendManaged;
		let failOnce = true;
		vi.spyOn(native.RecoveryFsRoot.prototype, "appendManaged").mockImplementation(function (
			this: native.RecoveryFsRoot,
			relativePath,
			bytes,
			expectedDev,
			expectedIno,
			expectedSize,
			expectedMtimeNs,
			expectedCtimeNs,
			expectedSha256,
		) {
			const result = appendManaged.call(
				this,
				relativePath,
				bytes,
				expectedDev,
				expectedIno,
				expectedSize,
				expectedMtimeNs,
				expectedCtimeNs,
				expectedSha256,
			);
			if (!failOnce) return result;
			failOnce = false;
			fs.appendFileSync(sessionFile, "foreign-record\n");
			return {
				...result,
				ok: false,
				code: "identity_mismatch",
				identity: undefined,
				mutationState: "committed",
				durabilityState: "not_provable",
			};
		});

		expect(() => manager.appendMessage({ role: "user", content: "own-record", timestamp: Date.now() })).toThrow(
			/managed_append_committed_outcome_uncertain/,
		);
		const beforeFlush = await readText(sessionFile);
		await expect(manager.flush()).rejects.toThrow(/managed_append_committed_outcome_uncertain/);
		expect(await readText(sessionFile)).toBe(beforeFlush);
		expect(beforeFlush).toContain("own-record");
		expect(beforeFlush).toContain("foreign-record");
		await manager.close().catch(() => {});
	});

	it("blocks compaction eviction after an identity-less committed append", async () => {
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		manager.appendMessage({ role: "user", content: "old", timestamp: Date.now() });
		manager.appendMessage(makeAssistantMessage() as never);
		const oldCustomId = manager.appendCustomMessageEntry(
			"eviction-barrier-test",
			[{ type: "text", text: `evictable-content-${"x".repeat(5_000)}` }],
			false,
		);
		const firstKeptEntryId = manager.appendMessage({ role: "user", content: "kept", timestamp: Date.now() });
		const compactionEntryId = manager.appendCompaction("summary", "short", firstKeptEntryId, 123);
		await manager.flush();

		const sessionFile = manager.getSessionFile()!;
		const appendManaged = native.RecoveryFsRoot.prototype.appendManaged;
		let failOnce = true;
		vi.spyOn(native.RecoveryFsRoot.prototype, "appendManaged").mockImplementation(function (
			this: native.RecoveryFsRoot,
			relativePath,
			bytes,
			expectedDev,
			expectedIno,
			expectedSize,
			expectedMtimeNs,
			expectedCtimeNs,
			expectedSha256,
		) {
			const committed = appendManaged.call(
				this,
				relativePath,
				bytes,
				expectedDev,
				expectedIno,
				expectedSize,
				expectedMtimeNs,
				expectedCtimeNs,
				expectedSha256,
			);
			if (!failOnce) return committed;
			failOnce = false;
			return {
				...committed,
				ok: false,
				code: "io_error",
				identity: undefined,
				mutationState: "committed",
				durabilityState: "not_provable",
			};
		});

		expect(() =>
			manager.appendMessage({ role: "user", content: "identity-less-eviction-barrier", timestamp: Date.now() }),
		).toThrow(/managed_append_committed_outcome_uncertain/);
		const beforeEntry = JSON.stringify(manager.getEntryForFidelity(oldCustomId));
		const beforeStats = manager.getObservabilityStatsForTests();
		expect(() => manager.evictCompactedContent(firstKeptEntryId, compactionEntryId)).toThrow(
			/managed_append_committed_outcome_uncertain/,
		);
		expect(JSON.stringify(manager.getEntryForFidelity(oldCustomId))).toBe(beforeEntry);
		expect(manager.getObservabilityStatsForTests().coldSpillWriteCount).toBe(beforeStats.coldSpillWriteCount);
		expect(await readText(sessionFile)).toContain("identity-less-eviction-barrier");
		await manager.close().catch(() => {});
	});

	it("services a descriptor-bound committed append receipt during flush", async () => {
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(makeAssistantMessage() as never);
		await manager.flush();

		const sessionFile = manager.getSessionFile()!;
		const appendManaged = native.RecoveryFsRoot.prototype.appendManaged;
		let failOnce = true;
		vi.spyOn(native.RecoveryFsRoot.prototype, "appendManaged").mockImplementation(function (
			this: native.RecoveryFsRoot,
			relativePath,
			bytes,
			expectedDev,
			expectedIno,
			expectedSize,
			expectedMtimeNs,
			expectedCtimeNs,
			expectedSha256,
		) {
			const result = appendManaged.call(
				this,
				relativePath,
				bytes,
				expectedDev,
				expectedIno,
				expectedSize,
				expectedMtimeNs,
				expectedCtimeNs,
				expectedSha256,
			);
			if (!failOnce) return result;
			failOnce = false;
			return {
				...result,
				ok: false,
				code: "fsync_failed",
				mutationState: "committed",
				durabilityState: "not_provable",
			};
		});

		expect(() =>
			manager.appendMessage({ role: "user", content: "receipt-backed-recovery", timestamp: Date.now() }),
		).toThrow(/managed_append_committed_outcome_uncertain/);
		await manager.flush();
		expect(await readText(sessionFile)).toContain("receipt-backed-recovery");
		await manager.close().catch(() => {});
	});

	it("bounds synchronous remnant reaping to one directory batch", () => {
		const reapRoot = path.join(root, "reap");
		fs.mkdirSync(reapRoot, { recursive: true });
		for (let index = 0; index < 300; index++) {
			const pathname = path.join(reapRoot, `.gjc-replace-retry-${index}`);
			fs.writeFileSync(pathname, "");
			fs.utimesSync(pathname, new Date(0), new Date(0));
		}

		const result = reapScrubbedProtocolRemnantsSync(reapRoot, 0);
		expect(result.reaped).toBe(256);
		expect(fs.readdirSync(reapRoot)).toHaveLength(44);
	});

	it("keeps a pre-write append identity mismatch non-committed", async () => {
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(makeAssistantMessage() as never);
		await manager.flush();
		const sessionFile = manager.getSessionFile()!;
		const before = await readBytes(sessionFile);
		vi.spyOn(native.RecoveryFsRoot.prototype, "appendManaged").mockImplementation(() => ({
			ok: false,
			code: "identity_mismatch",
			mutationState: "not_committed",
			durabilityState: "not_attempted",
		}));

		const relativePath = path.basename(sessionFile);
		const store = new ManagedSessionDescendantStore(managedDirectoryRoot(agentDir), path.dirname(sessionFile));
		try {
			const expected = store.captureBoundedAppendExpectation(relativePath);
			if (!expected) throw new Error("Expected managed transcript identity");
			expect(() => store.appendExpectedSync(relativePath, Buffer.from("not-written\n"), expected)).toThrow(
				"identity_mismatch",
			);
			expect((await readBytes(sessionFile)).equals(before)).toBe(true);
		} finally {
			store.close();
			await manager.close().catch(() => {});
		}
	});

	it("keeps resident state when committed no-replace publication throws before returning its identity", async () => {
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(makeAssistantMessage() as never);
		await manager.flush();

		const sessionFile = manager.getSessionFile()!;
		fs.rmSync(sessionFile);
		const publishNoReplace = ManagedSessionDescendantStore.prototype.publishNoReplaceSync;
		const replaceExpected = vi.spyOn(ManagedSessionDescendantStore.prototype, "replaceExpectedIdentitySync");
		let throwAfterCommit = true;
		vi.spyOn(ManagedSessionDescendantStore.prototype, "publishNoReplaceSync").mockImplementation(function (
			this: ManagedSessionDescendantStore,
			relativePath,
			bytes,
		) {
			const receipt = publishNoReplace.call(this, relativePath, bytes);
			if (throwAfterCommit) {
				throwAfterCommit = false;
				throw new Error("publish_return_interrupted");
			}
			return receipt;
		});

		expect(() =>
			manager.appendMessage({ role: "user", content: "durable-after-publish-error", timestamp: Date.now() }),
		).toThrow(/managed_replace_committed_outcome_uncertain/);
		expect(await readText(sessionFile)).toContain("durable-after-publish-error");
		expect(manager.getBranch().some(entry => JSON.stringify(entry).includes("durable-after-publish-error"))).toBe(
			true,
		);

		await expect(manager.ensureOnDisk()).rejects.toThrow(
			/managed_replace_committed_outcome_uncertain|destination_conflict/,
		);
		expect(replaceExpected).not.toHaveBeenCalled();
		expect(await readText(sessionFile)).toContain("durable-after-publish-error");
		await manager.close().catch(() => {});
	});

	it("keeps resident state after an unknown no-replace outcome and failed exact-byte recapture", async () => {
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(makeAssistantMessage() as never);
		await manager.flush();

		const sessionFile = manager.getSessionFile()!;
		fs.rmSync(sessionFile);
		const successor = `${JSON.stringify({ type: "session", id: "successor", timestamp: new Date().toISOString(), cwd })}\n`;
		const realRenameManagedFileNoReplace = native.RecoveryFsRoot.prototype.renameManagedFileNoReplace;
		let unknownOutcome = false;
		vi.spyOn(native.RecoveryFsRoot.prototype, "renameManagedFileNoReplace").mockImplementation(function (
			this: native.RecoveryFsRoot,
			sourcePath,
			destinationPath,
			expectedDev,
			expectedIno,
			expectedSize,
			expectedMtimeNs,
			expectedCtimeNs,
			expectedSha256,
		) {
			const result = realRenameManagedFileNoReplace.call(
				this,
				sourcePath,
				destinationPath,
				expectedDev,
				expectedIno,
				expectedSize,
				expectedMtimeNs,
				expectedCtimeNs,
				expectedSha256,
			);
			if (destinationPath !== path.basename(sessionFile) || !result.ok) return result;
			fs.rmSync(sessionFile);
			fs.writeFileSync(sessionFile, successor);
			unknownOutcome = true;
			return {
				...result,
				ok: false,
				code: "publish_unknown",
				mutationState: "unknown",
				durabilityState: "not_provable",
				reason: "unknown",
				primitive: "renameat2_noreplace",
				phase: "rename",
				diagnostic: { schemaVersion: 1, collectionState: "complete" },
			};
		});

		expect(() =>
			manager.appendMessage({ role: "user", content: "must-remain-resident", timestamp: Date.now() }),
		).toThrow(/managed_replace_committed_outcome_uncertain/);
		expect(unknownOutcome).toBe(true);
		expect(await readText(sessionFile)).toBe(successor);
		expect(manager.getBranch().some(entry => JSON.stringify(entry).includes("must-remain-resident"))).toBe(true);
		await manager.close().catch(() => {});
	});

	it("does not adopt a byte-identical successor after an unknown no-replace outcome", async () => {
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(makeAssistantMessage() as never);
		await manager.flush();

		const sessionFile = manager.getSessionFile()!;
		const intendedBytes = await readBytes(sessionFile);
		fs.rmSync(sessionFile);
		const realRenameManagedFileNoReplace = native.RecoveryFsRoot.prototype.renameManagedFileNoReplace;
		const replaceExpected = vi.spyOn(ManagedSessionDescendantStore.prototype, "replaceExpectedIdentitySync");
		let unknownOutcome = false;
		let successorBytes: Uint8Array | undefined;
		vi.spyOn(native.RecoveryFsRoot.prototype, "renameManagedFileNoReplace").mockImplementation(function (
			this: native.RecoveryFsRoot,
			sourcePath,
			destinationPath,
			expectedDev,
			expectedIno,
			expectedSize,
			expectedMtimeNs,
			expectedCtimeNs,
			expectedSha256,
		) {
			if (unknownOutcome || destinationPath !== path.basename(sessionFile))
				return realRenameManagedFileNoReplace.call(
					this,
					sourcePath,
					destinationPath,
					expectedDev,
					expectedIno,
					expectedSize,
					expectedMtimeNs,
					expectedCtimeNs,
					expectedSha256,
				);
			const result = realRenameManagedFileNoReplace.call(
				this,
				sourcePath,
				destinationPath,
				expectedDev,
				expectedIno,
				expectedSize,
				expectedMtimeNs,
				expectedCtimeNs,
				expectedSha256,
			);
			if (!result.ok) {
				return result;
			}
			const successorPath = `${sessionFile}.byte-identical-successor`;
			fs.writeFileSync(successorPath, intendedBytes);
			const publishedIno = fs.statSync(sessionFile).ino;
			fs.rmSync(sessionFile);
			fs.renameSync(successorPath, sessionFile);
			const successorIno = fs.statSync(sessionFile).ino;
			expect(successorIno).not.toBe(publishedIno);
			successorBytes = intendedBytes;
			unknownOutcome = true;
			return {
				...result,
				ok: false,
				code: "publish_unknown",
				mutationState: "unknown",
				durabilityState: "not_provable",
				reason: "unknown",
				primitive: "renameat2_noreplace",
				phase: "rename",
				diagnostic: { schemaVersion: 1, collectionState: "complete" },
			};
		});

		expect(() =>
			manager.appendMessage({ role: "user", content: "must-remain-resident", timestamp: Date.now() }),
		).toThrow(/managed_replace_committed_outcome_uncertain/);
		expect(unknownOutcome).toBe(true);
		expect(successorBytes).toBeDefined();
		expect((await readBytes(sessionFile)).equals(Buffer.from(successorBytes!))).toBe(true);
		expect(manager.getBranch().some(entry => JSON.stringify(entry).includes("must-remain-resident"))).toBe(true);

		await expect(manager.ensureOnDisk()).rejects.toThrow(
			/managed_replace_committed_outcome_uncertain|destination_conflict/,
		);
		expect(replaceExpected).not.toHaveBeenCalled();
		expect((await readBytes(sessionFile)).equals(Buffer.from(successorBytes!))).toBe(true);
		await manager.close().catch(() => {});
	});

	it("accepts byte-identical metadata drift before appending", async () => {
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(makeAssistantMessage() as never);
		await manager.flush();

		const sessionFile = manager.getSessionFile()!;
		const original = await readBytes(sessionFile);
		const before = fs.statSync(sessionFile);
		fs.utimesSync(sessionFile, new Date(before.atimeMs + 1_000), new Date(before.mtimeMs + 1_000));
		const drifted = fs.statSync(sessionFile);
		expect(drifted.ino).toBe(before.ino);
		expect(drifted.size).toBe(before.size);
		expect((await readBytes(sessionFile)).equals(original)).toBe(true);

		expect(() =>
			manager.appendMessage({ role: "user", content: "after-metadata-drift", timestamp: Date.now() }),
		).not.toThrow();
		await manager.flush();
		const afterFirstAppend = fs.statSync(sessionFile);
		fs.utimesSync(
			sessionFile,
			new Date(afterFirstAppend.atimeMs + 1_000),
			new Date(afterFirstAppend.mtimeMs + 1_000),
		);
		expect(() =>
			manager.appendMessage({ role: "user", content: "after-second-metadata-drift", timestamp: Date.now() }),
		).not.toThrow();
		await manager.flush();
		expect(await readText(sessionFile)).toContain("after-metadata-drift");
		expect(await readText(sessionFile)).toContain("after-second-metadata-drift");
		await manager.close();
	});

	it("seeds a reopened managed session with a digest before accepting a timestamp touch", async () => {
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		manager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		manager.appendMessage(makeAssistantMessage() as never);
		await manager.flush();
		const sessionFile = manager.getSessionFile()!;
		await manager.close();

		const reopened = await SessionManager.open(sessionFile, destination, undefined, "copy-retain", "enabled");
		try {
			const before = fs.statSync(sessionFile);
			fs.utimesSync(sessionFile, new Date(before.atimeMs + 1_000), new Date(before.mtimeMs + 1_000));
			expect(() =>
				reopened.appendMessage({ role: "user", content: "reopened-after-touch", timestamp: Date.now() }),
			).not.toThrow();
			await reopened.flush();
			expect(await readText(sessionFile)).toContain("reopened-after-touch");
		} finally {
			await reopened.close();
		}
	});

	it("rejects metadata drift when the expected predecessor has no digest", async () => {
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		manager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		manager.appendMessage(makeAssistantMessage() as never);
		await manager.flush();

		const sessionFile = manager.getSessionFile()!;
		const relativePath = path.basename(sessionFile);
		const store = new ManagedSessionDescendantStore(managedDirectoryRoot(agentDir), path.dirname(sessionFile));
		try {
			const bounded = store.captureBoundedAppendExpectation(relativePath);
			if (!bounded) throw new Error("Expected managed transcript identity");
			const expected = {
				dev: BigInt(bounded.dev),
				ino: BigInt(bounded.ino),
				nlink: BigInt(bounded.nlink),
				size: Number(bounded.size),
				mtimeNs: BigInt(bounded.mtimeNs),
				ctimeNs: BigInt(bounded.ctimeNs),
				sha256: undefined,
			};
			const original = await readBytes(sessionFile);
			expect(() =>
				store.appendExpectedIdentitySync(relativePath, Buffer.from("must-not-append\n"), expected),
			).toThrow("managed_append_identity_mismatch");
			expect((await readBytes(sessionFile)).equals(original)).toBe(true);
		} finally {
			store.close();
			await manager.close().catch(() => {});
		}
	});

	it("fails closed when content evidence differs despite equal descriptor fields", async () => {
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(makeAssistantMessage() as never);
		await manager.flush();

		const sessionFile = manager.getSessionFile()!;
		const capture = ManagedSessionDescendantStore.prototype.captureBoundedAppendExpectation;
		let tampered = false;
		vi.spyOn(ManagedSessionDescendantStore.prototype, "captureBoundedAppendExpectation").mockImplementation(function (
			this: ManagedSessionDescendantStore,
			relativePath,
		) {
			const captured = capture.call(this, relativePath);
			if (!captured || tampered) return captured;
			tampered = true;
			return { ...captured, sha256: "0".repeat(64) };
		});

		expect(() => manager.appendMessage({ role: "user", content: "must-fail-closed", timestamp: Date.now() })).toThrow(
			/managed_append_identity_mismatch/,
		);
		expect(await readText(sessionFile)).not.toContain("must-fail-closed");
		await manager.close().catch(() => {});
	});

	it("rejects a same-length overwrite even after the timestamp is restored", async () => {
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(makeAssistantMessage() as never);
		await manager.flush();

		const sessionFile = manager.getSessionFile()!;
		const before = fs.statSync(sessionFile);
		const original = await readText(sessionFile);
		const overwritten = original.replace('"hello"', '"world"');
		expect(Buffer.byteLength(overwritten)).toBe(Buffer.byteLength(original));
		fs.writeFileSync(sessionFile, overwritten);
		fs.utimesSync(sessionFile, new Date(before.atimeMs), new Date(before.mtimeMs));

		expect(() => manager.appendMessage({ role: "user", content: "must-fail-closed", timestamp: Date.now() })).toThrow(
			/managed_append_identity_mismatch/,
		);
		expect(await readText(sessionFile)).toBe(overwritten);
		await manager.close().catch(() => {});
	});

	it("fails closed before replacement when the expected digest differs", async () => {
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(makeAssistantMessage() as never);
		await manager.flush();

		const sessionFile = manager.getSessionFile()!;
		const relativePath = path.basename(sessionFile);
		const store = new ManagedSessionDescendantStore(managedDirectoryRoot(agentDir), path.dirname(sessionFile));
		try {
			const bounded = store.captureBoundedAppendExpectation(relativePath);
			if (!bounded) throw new Error("Expected managed transcript identity");
			const expected = {
				dev: BigInt(bounded.dev),
				ino: BigInt(bounded.ino),
				nlink: BigInt(bounded.nlink),
				size: Number(bounded.size),
				mtimeNs: BigInt(bounded.mtimeNs),
				ctimeNs: BigInt(bounded.ctimeNs),
				sha256: "0".repeat(64),
			};
			const original = await readBytes(sessionFile);
			expect(() =>
				store.replaceExpectedIdentitySync(relativePath, Buffer.from("must-not-replace\n"), expected),
			).toThrow("managed_replace_identity_mismatch");
			expect((await readBytes(sessionFile)).equals(original)).toBe(true);
		} finally {
			store.close();
			await manager.close().catch(() => {});
		}
	});

	it("still fails closed on identity_mismatch (concurrent successor not overwritten)", async () => {
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(makeAssistantMessage() as never);
		await manager.flush();

		const sessionFile = manager.getSessionFile()!;
		const successor = `${JSON.stringify({ type: "session", id: "other", timestamp: new Date().toISOString(), cwd })}\n`;
		fs.writeFileSync(sessionFile, successor);

		let threw = false;
		try {
			manager.appendMessage({ role: "user", content: "should-fail-closed", timestamp: Date.now() });
		} catch (e) {
			threw = true;
			expect(String(e)).toMatch(/identity_mismatch|managed_replace_identity_mismatch/);
		}
		expect(threw).toBe(true);
		expect(() =>
			manager.appendMessage({ role: "user", content: "still-fail-closed", timestamp: Date.now() }),
		).toThrow(/identity_mismatch|managed_replace_identity_mismatch/);
		expect(await readText(sessionFile)).toBe(successor);
		await manager.close().catch(() => {});
	});
});

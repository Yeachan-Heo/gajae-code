import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import * as native from "@gajae-code/natives";
import {
	ManagedSessionDescendantStore,
	managedDirectoryRoot,
} from "../../src/session/internal/managed-session-storage";
import { makeAssistantMessage } from "./helpers";

function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
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
		expect(fs.readFileSync(sessionFile!, "utf8")).toContain("after-delete");

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
		expect(fs.readFileSync(sessionFile, "utf8")).toBe(successor);
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
		expect(fs.readFileSync(sessionFile, "utf8")).toContain("durable-after-delete");
		expect(manager.getBranch().some(entry => JSON.stringify(entry).includes("durable-after-delete"))).toBe(true);

		await expect(manager.ensureOnDisk()).rejects.toThrow("destination_conflict");
		expect(replaceExpected).toHaveBeenCalledTimes(1);
		expect(fs.readFileSync(sessionFile, "utf8")).toContain("durable-after-delete");
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
		).toThrow(/identity_mismatch|destination_conflict/);
		expect(fs.readFileSync(sessionFile, "utf8")).toBe(successor);
		expect(fs.readFileSync(predecessor, "utf8")).not.toContain("must-not-overwrite-successor");
		await manager.close().catch(() => {});
	});

	it("fails closed before a later resident mutation after an identity-less committed append", async () => {
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(makeAssistantMessage() as never);
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
		const persisted = fs.readFileSync(sessionFile, "utf8");
		expect(persisted).toContain("identity-less-committed");

		expect(() =>
			manager.appendMessage({ role: "user", content: "must-not-retry-stale-predecessor", timestamp: Date.now() }),
		).toThrow(/managed_append_committed_outcome_uncertain/);
		expect(appendCalls).toBe(1);
		expect(manager.getBranch()).toHaveLength(residentCount);
		expect(fs.readFileSync(sessionFile, "utf8")).not.toContain("must-not-retry-stale-predecessor");
		await manager.close().catch(() => {});
	});

	it("keeps a pre-write append identity mismatch non-committed", async () => {
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(makeAssistantMessage() as never);
		await manager.flush();
		const sessionFile = manager.getSessionFile()!;
		const before = fs.readFileSync(sessionFile);
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
			expect(fs.readFileSync(sessionFile).equals(before)).toBe(true);
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
		expect(fs.readFileSync(sessionFile, "utf8")).toContain("durable-after-publish-error");
		expect(manager.getBranch().some(entry => JSON.stringify(entry).includes("durable-after-publish-error"))).toBe(
			true,
		);

		await expect(manager.ensureOnDisk()).rejects.toThrow(
			/managed_replace_committed_outcome_uncertain|destination_conflict/,
		);
		expect(replaceExpected).not.toHaveBeenCalled();
		expect(fs.readFileSync(sessionFile, "utf8")).toContain("durable-after-publish-error");
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
		expect(fs.readFileSync(sessionFile, "utf8")).toBe(successor);
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
			const intendedBytes = fs.readFileSync(sessionFile);
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
		expect(fs.readFileSync(sessionFile).equals(Buffer.from(successorBytes!))).toBe(true);
		expect(manager.getBranch().some(entry => JSON.stringify(entry).includes("must-remain-resident"))).toBe(true);

		await expect(manager.ensureOnDisk()).rejects.toThrow(
			/managed_replace_committed_outcome_uncertain|destination_conflict/,
		);
		expect(replaceExpected).not.toHaveBeenCalled();
		expect(fs.readFileSync(sessionFile).equals(Buffer.from(successorBytes!))).toBe(true);
		await manager.close().catch(() => {});
	});

	it("accepts byte-identical metadata drift before appending", async () => {
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const manager = SessionManager.create(cwd, destination);
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage(makeAssistantMessage() as never);
		await manager.flush();

		const sessionFile = manager.getSessionFile()!;
		const original = fs.readFileSync(sessionFile);
		const before = fs.statSync(sessionFile);
		fs.utimesSync(sessionFile, new Date(before.atimeMs + 1_000), new Date(before.mtimeMs + 1_000));
		const drifted = fs.statSync(sessionFile);
		expect(drifted.ino).toBe(before.ino);
		expect(drifted.size).toBe(before.size);
		expect(fs.readFileSync(sessionFile).equals(original)).toBe(true);

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
		expect(fs.readFileSync(sessionFile, "utf8")).toContain("after-metadata-drift");
		expect(fs.readFileSync(sessionFile, "utf8")).toContain("after-second-metadata-drift");
		await manager.close();
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
		expect(fs.readFileSync(sessionFile, "utf8")).not.toContain("must-fail-closed");
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
			const original = fs.readFileSync(sessionFile);
			expect(() =>
				store.replaceExpectedIdentitySync(relativePath, Buffer.from("must-not-replace\n"), expected),
			).toThrow("managed_replace_identity_mismatch");
			expect(fs.readFileSync(sessionFile).equals(original)).toBe(true);
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
		expect(fs.readFileSync(sessionFile, "utf8")).toBe(successor);
		await manager.close().catch(() => {});
	});
});

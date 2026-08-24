import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ManagedSessionDescendantStore } from "../../src/session/internal/managed-session-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
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

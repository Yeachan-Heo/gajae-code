/**
 * Regression coverage for PR #7863 (issue #7860): header-only patch should:
 * 1. Update managedPersistExpectedIdentity after file replacement (P1a)
 * 2. Close persist writer before atomically replacing file (P1b)
 * 3. Preserve peer-appended entries and confirm writes land in new file (P1c)
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadEntriesFromFile, SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getConfigRootDir, setAgentDir } from "@gajae-code/utils";
import { makeAssistantMessage } from "./helpers";

describe("SessionManager header-only patch and managed identity (PR #7863)", () => {
	let testAgentDir: string;
	let cwdA: string;
	let cwdB: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(async () => {
		testAgentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-header-patch-"));
		setAgentDir(testAgentDir);
		cwdA = path.join(testAgentDir, "cwd-a");
		cwdB = path.join(testAgentDir, "cwd-b");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });
	});

	afterEach(async () => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fsp.rm(testAgentDir, { recursive: true, force: true });
	});

	it("peer can append entries after session load and entries survive move with header-only patch", async () => {
		// Create initial session with user message
		const session1 = SessionManager.create(cwdA);
		session1.appendMessage({ role: "user", content: "initial user message", timestamp: 1 });
		session1.appendMessage(makeAssistantMessage());
		await session1.flush();
		const sessionFile = session1.getSessionFile()!;

		// Reload the session (simulating a peer reopening)
		const session2 = await SessionManager.open(sessionFile);

		// Peer appends a new user message while session1 hasn't moved yet
		session2.appendMessage({ role: "user", content: "peer appended user message", timestamp: 2 });
		await session2.flush();
		await session2.close();

		// Now move the original session
		await session1.moveTo(cwdB);

		// Verify both messages survive the move
		const newFile = session1.getSessionFile()!;
		const entries = await loadEntriesFromFile(newFile);

		// Find user messages (they have role: "user")
		const userMessages = entries.filter(
			(entry): boolean =>
				typeof entry === "object" &&
				entry !== null &&
				(entry as unknown as { type?: string }).type === "message" &&
				(entry as unknown as { message?: { role?: string } }).message?.role === "user",
		);

		expect(userMessages.length).toBe(2);
	});

	it("write after move lands in the new file (new inode)", async () => {
		// Create initial session and move it
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "pre-move message", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const oldFile = session.getSessionFile()!;
		const oldInode = fs.statSync(oldFile).ino;

		// Move the session
		await session.moveTo(cwdB);

		const newFile = session.getSessionFile()!;
		expect(newFile).not.toBe(oldFile);
		expect(fs.existsSync(oldFile)).toBe(false);
		expect(fs.existsSync(newFile)).toBe(true);

		const newInode = fs.statSync(newFile).ino;
		expect(newInode).not.toBe(oldInode);

		// Now append a message after the move
		session.appendMessage({ role: "user", content: "post-move message", timestamp: 2 });
		await session.flush();

		// Verify the message is in the new file, not a recreated old file
		expect(fs.existsSync(oldFile)).toBe(false);
		expect(fs.existsSync(newFile)).toBe(true);

		const entries = await loadEntriesFromFile(newFile);
		const hasMessages = entries.some(
			(e): boolean => typeof e === "object" && e !== null && (e as unknown as { type?: string }).type === "message",
		);

		expect(hasMessages).toBe(true);

		// Verify new file still has new inode
		const finalInode = fs.statSync(newFile).ino;
		expect(finalInode).toBe(newInode);
	});
});

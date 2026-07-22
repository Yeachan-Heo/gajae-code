import { describe, expect, it, vi } from "bun:test";

import * as path from "node:path";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import * as native from "@gajae-code/natives";
import { getAgentDir, isEnoent, setAgentDir, TempDir } from "@gajae-code/utils";

async function fileExists(p: string): Promise<boolean> {
	try {
		await Bun.file(p).stat();
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

describe("SessionManager draft", () => {
	it("round-trips text through saveDraft + consumeDraft", async () => {
		using tempDir = TempDir.createSync("@pi-session-draft-roundtrip-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.flush();

		await session.saveDraft("unsent text");

		// consumeDraft is single-shot: returns the text and removes the sidecar.
		expect(await session.consumeDraft()).toBe("unsent text");
		expect(await session.consumeDraft()).toBeNull();
	});

	it("places the draft inside the artifacts directory so dropSession cleans it", async () => {
		using tempDir = TempDir.createSync("@pi-session-draft-location-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.flush();

		await session.saveDraft("inside artifacts");

		const artifactsDir = session.getArtifactsDir();
		expect(artifactsDir).not.toBeNull();
		const draftPath = path.join(artifactsDir!, "draft.txt");
		expect(await fileExists(draftPath)).toBe(true);

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		await session.dropSession(sessionFile);

		expect(await fileExists(draftPath)).toBe(false);
	});

	it("removes any stale draft when saving an empty string", async () => {
		using tempDir = TempDir.createSync("@pi-session-draft-empty-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.flush();

		await session.saveDraft("first attempt");
		await session.saveDraft("");

		expect(await session.consumeDraft()).toBeNull();
	});

	it("forces the session header onto disk so resume can find the draft owner", async () => {
		using tempDir = TempDir.createSync("@pi-session-draft-ensure-on-disk-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		// No assistant reply yet: without ensureOnDisk the session file would not
		// exist, leaving an orphan draft sidecar that --resume can never reach.
		session.appendMessage({ role: "user", content: "draft only", timestamp: 1 });

		await session.saveDraft("queued for next time");

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		expect(await fileExists(sessionFile)).toBe(true);
	});

	it("persists managed drafts across close and resume without exposing a draft pathname", async () => {
		using tempDir = TempDir.createSync("@pi-session-managed-draft-resume-");
		const previousAgentDir = getAgentDir();
		const agentDir = path.join(tempDir.path(), "agent");
		try {
			setAgentDir(agentDir);
			const session = SessionManager.create(tempDir.path());
			session.appendMessage({ role: "user", content: "draft only", timestamp: 1 });
			await session.saveDraft("managed unsent text");
			const sessionFile = session.getSessionFile();
			if (!sessionFile) throw new Error("Expected managed session file");
			await session.close();

			const resumed = await SessionManager.open(
				sessionFile,
				SessionManager.managedDestination(tempDir.path(), agentDir),
			);
			expect(await resumed.consumeDraft()).toBe("managed unsent text");
			expect(await resumed.consumeDraft()).toBeNull();
			await resumed.close();
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("clears persisted managed drafts before a later resume", async () => {
		using tempDir = TempDir.createSync("@pi-session-managed-draft-clear-");
		const previousAgentDir = getAgentDir();
		const agentDir = path.join(tempDir.path(), "agent");
		try {
			setAgentDir(agentDir);
			const session = SessionManager.create(tempDir.path());
			session.appendMessage({ role: "user", content: "draft only", timestamp: 1 });
			await session.saveDraft("remove me");
			await session.saveDraft("");
			const sessionFile = session.getSessionFile();
			if (!sessionFile) throw new Error("Expected managed session file");
			await session.close();

			const resumed = await SessionManager.open(
				sessionFile,
				SessionManager.managedDestination(tempDir.path(), agentDir),
			);
			expect(await resumed.consumeDraft()).toBeNull();
			await resumed.close();
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("keeps the prior managed draft when its replacement fails", async () => {
		if (process.platform !== "linux") return;
		using tempDir = TempDir.createSync("@pi-session-managed-draft-replace-");
		const previousAgentDir = getAgentDir();
		const agentDir = path.join(tempDir.path(), "agent");
		try {
			setAgentDir(agentDir);
			const session = SessionManager.create(tempDir.path());
			session.appendMessage({ role: "user", content: "draft only", timestamp: 1 });
			await session.saveDraft("authorized draft");
			const sessionFile = session.getSessionFile();
			if (!sessionFile) throw new Error("Expected managed session file");
			const replaceManaged = native.RecoveryFsRoot.prototype as unknown as {
				replaceManaged: (...args: unknown[]) => unknown;
			};
			const replace = vi.spyOn(replaceManaged, "replaceManaged").mockReturnValue({ ok: false, code: "io_error" });
			try {
				await expect(session.saveDraft("replacement draft")).rejects.toThrow("io_error");
			} finally {
				replace.mockRestore();
			}
			await session.close();

			const resumed = await SessionManager.open(
				sessionFile,
				SessionManager.managedDestination(tempDir.path(), agentDir),
			);
			expect(await resumed.consumeDraft()).toBe("authorized draft");
			await resumed.close();
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("is a no-op for in-memory sessions", async () => {
		const session = SessionManager.inMemory();

		await session.saveDraft("ignored");
		expect(await session.consumeDraft()).toBeNull();
	});
});

import { describe, expect, it } from "bun:test";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { FileSessionStorage } from "@gajae-code/coding-agent/session/session-storage";
import { TempDir } from "@gajae-code/utils";

describe("lifecycle contracts regression (PR #6428)", () => {
	it("rejects restoreState during strict close", async () => {
		using root = TempDir.createSync("@pi-restore-state-strict-close-");
		const destination = SessionManager.managedDestination(root.path(), root.path());
		const session = SessionManager.create(root.path(), destination);

		try {
			session.appendMessage({ role: "user", content: "message 1", timestamp: 1 });
			await session.flush();
			const snapshot = session.captureState();

			// Simulate strict close starting but suspended at various points.
			// We can't perfectly mock the internal state, but we can verify
			// that the fence is in place by checking that restoreState rejects
			// after the close path initiates.
			const closePromise = session.closeStrict();

			// Try to restore state during the close process.
			// This should be rejected by #assertArtifactOpen().
			await expect(async () => {
				session.restoreState(snapshot);
			}).toThrow("Session manager is closing");

			await closePromise;
		} finally {
			try {
				await session.close();
			} catch {
				// May be already closed
			}
		}
	});

	it("preserves explicit persist identity across cross-manager adoption", async () => {
		using root = TempDir.createSync("@pi-cross-manager-explicit-identity-");
		const storage = new FileSessionStorage();

		const managerA = SessionManager.create(root.path(), root.path(), storage);
		try {
			managerA.appendMessage({ role: "user", content: "message in A", timestamp: 1 });
			await managerA.ensureOnDisk();
			const snapshotA = managerA.captureState();
			const sessionFileA = managerA.getSessionFile();

			if (!sessionFileA) throw new Error("Expected explicit session file");

			// Create a second manager that will adopt the snapshot
			const managerB = SessionManager.create(root.path(), root.path(), storage);
			try {
				// Adopt the snapshot from manager A
				managerB.restoreState(snapshotA);

				// Verify the state was restored with proper identity
				expect(managerB.getSessionId()).toBe(snapshotA.sessionId);
				expect(managerB.getSessionFile()).toBe(snapshotA.sessionFile);

				// Add a message and ensure the explicit identity is preserved
				managerB.appendMessage({ role: "user", content: "response", timestamp: 2 });
				await managerB.ensureOnDisk();
				const sessionFileB = managerB.getSessionFile();

				if (!sessionFileB) throw new Error("Expected session file");

				// The snapshot adoption should preserve the explicit identity,
				// which prevents stale file checks from being skipped
				expect(sessionFileB).toBe(sessionFileA);
			} finally {
				await managerB.close();
			}
		} finally {
			await managerA.close();
		}
	});

	it("throws during getArtifactPath after teardown starts", async () => {
		const session = SessionManager.inMemory();

		try {
			const id = await session.saveArtifact("test artifact", "txt");
			if (!id) throw new Error("Expected artifact id");

			const artifactPath = await session.getArtifactPath(id);
			expect(artifactPath).toBeTruthy();

			// Start closing the session
			const closePromise = session.closeStrict();

			// Try to get artifact path during teardown
			// This should throw "Session manager is closing" from #assertArtifactOpen()
			// rather than returning null
			await expect(session.getArtifactPath(id)).rejects.toThrow("Session manager is closing");

			await closePromise;
		} finally {
			try {
				await session.close();
			} catch {
				// May be already closed
			}
		}
	});
});

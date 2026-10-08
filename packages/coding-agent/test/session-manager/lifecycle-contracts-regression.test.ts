import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { FileSessionStorage } from "@gajae-code/coding-agent/session/session-storage";
import { TempDir } from "@gajae-code/utils";

type SessionStateSnapshot = Parameters<SessionManager["restoreState"]>[0];

describe("lifecycle contracts regression (PR #6428)", () => {
	it("rebinds close retry origin after replacing the session", async () => {
		using root = TempDir.createSync("@pi-close-retry-session-replacement-");
		const storage = new FileSessionStorage();
		const initial = `${root.path()}/initial.jsonl`;
		const replacement = `${root.path()}/replacement.jsonl`;
		await fs.writeFile(
			initial,
			`${JSON.stringify({ type: "session", version: 5, id: "initial", timestamp: new Date().toISOString(), cwd: root.path() })}\n`,
		);
		const manager = await SessionManager.open(initial, SessionManager.explicitDestination(root.path()), storage);

		try {
			await fs.writeFile(
				replacement,
				`${JSON.stringify({ type: "session", version: 5, id: "replacement", timestamp: new Date().toISOString(), cwd: root.path() })}\n`,
			);
			await manager.setSessionFile(replacement);
			manager.appendMessage({
				role: "user",
				content: "after replacement",
				timestamp: 2,
			});
			await manager.ensureOnDisk();
			await expect(manager.close()).resolves.toBeUndefined();
		} finally {
			try {
				await manager.close();
			} catch {
				// Cleanup is best effort if the assertion already closed the manager.
			}
		}
	});

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

			// Verify that the snapshot carries explicit identity
			// (it should be stored as a non-enumerable property for cross-manager adoption)
			const explicitIdentity = snapshotA.explicitPersistIdentity;
			if (!explicitIdentity) throw new Error("Expected explicit persist identity");
			expect(explicitIdentity).toBeTruthy();
			expect(explicitIdentity.sessionId).toBe(snapshotA.sessionId);

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

	it("preserves explicit persist identity when snapshot is copied via spread operator", async () => {
		using root = TempDir.createSync("@pi-cross-manager-explicit-identity-spread-");
		const storage = new FileSessionStorage();

		const managerA = SessionManager.create(root.path(), root.path(), storage);
		try {
			managerA.appendMessage({ role: "user", content: "message in A", timestamp: 1 });
			await managerA.ensureOnDisk();
			const snapshotA = managerA.captureState();
			const sessionFileA = managerA.getSessionFile();

			if (!sessionFileA) throw new Error("Expected explicit session file");

			// Copy the snapshot via spread operator (documented caller-adjusted path)
			// The explicit identity is now stored as an enumerable property so it survives
			// the spread copy, ensuring adoption preserves the captured identity.
			const copiedSnapshot = { ...snapshotA };

			// Verify the explicit identity IS present in the copy (now enumerable)
			const copiedIdentity = copiedSnapshot.explicitPersistIdentity;
			if (!copiedIdentity) throw new Error("Expected explicit persist identity in copied snapshot");
			expect(copiedIdentity).toBeTruthy();
			expect(copiedIdentity.sessionId).toBe(snapshotA.sessionId);

			// Create a second manager that will adopt the copied snapshot
			const managerB = SessionManager.create(root.path(), root.path(), storage);
			try {
				// Adopt the copied snapshot from manager A
				managerB.restoreState(copiedSnapshot);

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

	it("adopts snapshot with preserved explicit identity through spread copy", async () => {
		using root = TempDir.createSync("@pi-cross-manager-explicit-identity-adopt-");
		const storage = new FileSessionStorage();

		const managerA = SessionManager.create(root.path(), root.path(), storage);
		try {
			managerA.appendMessage({ role: "user", content: "message in A", timestamp: 1 });
			await managerA.ensureOnDisk();
			const snapshotA = managerA.captureState();
			const sessionFileA = managerA.getSessionFile();

			if (!sessionFileA) throw new Error("Expected explicit session file");

			// Copy the snapshot via spread operator (documented caller-adjusted path)
			// The explicit identity is now stored as an enumerable property and survives the copy
			const copiedSnapshot = { ...snapshotA };

			// Verify the explicit identity IS preserved in the copy (enumerable property)
			const copiedIdentity = copiedSnapshot.explicitPersistIdentity;
			if (!copiedIdentity) throw new Error("Expected explicit persist identity in adopted copied snapshot");
			expect(copiedIdentity).toBeTruthy();
			expect(copiedIdentity.sessionId).toBe(snapshotA.sessionId);

			// Create a second manager that will adopt the copied snapshot
			const managerB = SessionManager.create(root.path(), root.path(), storage);
			try {
				// Adopt the copied snapshot - the explicit identity is preserved through the
				// spread copy, so adoption restores the captured identity
				managerB.restoreState(copiedSnapshot);

				// Verify the state was restored with proper identity
				expect(managerB.getSessionId()).toBe(snapshotA.sessionId);
				expect(managerB.getSessionFile()).toBe(snapshotA.sessionFile);

				// Add a message to ensure the restoration is complete
				managerB.appendMessage({ role: "user", content: "response", timestamp: 2 });
				await managerB.ensureOnDisk();

				// Verify both managers point to the same session file
				const sessionFileB = managerB.getSessionFile();
				if (!sessionFileB) throw new Error("Expected session file");
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

	// Comprehensive table-driven test for JSON serialization of ExplicitPersistIdentity
	it("serializes explicit persist identity through all JSON-safe operations", async () => {
		const testCases: Array<{
			name: string;
			transform: (snapshot: SessionStateSnapshot) => SessionStateSnapshot;
			adoptedArtifactManager: "preserved" | "rejected";
		}> = [
			{
				name: "direct snapshot",
				transform: (snapshot: SessionStateSnapshot) => snapshot,
				adoptedArtifactManager: "preserved",
			},
			{
				name: "spread operator copy",
				transform: (snapshot: SessionStateSnapshot) => ({ ...snapshot }),
				adoptedArtifactManager: "preserved",
			},
			{
				name: "structuredClone copy",
				transform: (snapshot: SessionStateSnapshot) => structuredClone(snapshot),
				adoptedArtifactManager: "rejected",
			},
			{
				name: "JSON.stringify/parse round-trip",
				transform: (snapshot: SessionStateSnapshot) => JSON.parse(JSON.stringify(snapshot)) as SessionStateSnapshot,
				adoptedArtifactManager: "rejected",
			},
		];

		for (const testCase of testCases) {
			// Use a separate temp directory for each test case to avoid cross-contamination
			const root = TempDir.createSync(`@pi-json-case-${testCase.name.replace(/[/\s]+/g, "-")}-`);
			const storage = new FileSessionStorage();
			try {
				// Scenario 1: same-manager restore & cross-manager restore
				const managerA = SessionManager.create(root.path(), root.path(), storage);
				try {
					managerA.appendMessage({ role: "user", content: "message in A", timestamp: 1 });
					await managerA.ensureOnDisk();
					const snapshotA = managerA.captureState();
					const sessionFileA = managerA.getSessionFile();

					if (!sessionFileA) throw new Error(`${testCase.name}: Expected explicit session file`);

					// Verify explicit identity is present and is JSON-safe
					const explicitIdentity = snapshotA.explicitPersistIdentity;
					if (!explicitIdentity) throw new Error(`${testCase.name}: Expected explicit persist identity`);
					expect(explicitIdentity).toBeTruthy();
					expect(explicitIdentity.sessionId).toBe(snapshotA.sessionId);

					// Verify all fields are JSON-safe (strings or numbers, no bigints)
					expect(typeof explicitIdentity.dev).toBe("string");
					expect(typeof explicitIdentity.ino).toBe("string");
					if (explicitIdentity.nlink !== undefined) expect(typeof explicitIdentity.nlink).toBe("string");
					expect(typeof explicitIdentity.mtimeNs).toBe("string");
					if (explicitIdentity.ctimeNs !== undefined) expect(typeof explicitIdentity.ctimeNs).toBe("string");

					// Apply the transformation (spread, clone, JSON round-trip, etc.)
					const transformedSnapshot = testCase.transform(snapshotA);

					// Verify the identity survived the transformation
					const transformedIdentity = transformedSnapshot.explicitPersistIdentity;
					if (!transformedIdentity)
						throw new Error(`${testCase.name}: Expected identity to survive transformation`);
					expect(transformedIdentity).toBeTruthy();
					expect(transformedIdentity.sessionId).toBe(snapshotA.sessionId);

					// Live adopted artifact managers survive reference-preserving copies,
					// but JSON-safe deep copies must not install their plain-object shells.
					const artifactManager = managerA.getArtifactManager();
					if (!artifactManager) throw new Error(`${testCase.name}: Expected artifact manager`);
					managerA.adoptArtifactManager(artifactManager);
					const snapshotWithArtifactManager = managerA.captureState();
					const transformedArtifactSnapshot = testCase.transform(snapshotWithArtifactManager);
					const managerWithArtifactSnapshot = SessionManager.create(root.path(), root.path(), storage);
					try {
						if (testCase.adoptedArtifactManager === "preserved") {
							managerWithArtifactSnapshot.restoreState(transformedArtifactSnapshot);
							expect(managerWithArtifactSnapshot.getArtifactManager()).toBe(artifactManager);
						} else {
							expect(transformedArtifactSnapshot.adoptedArtifactManager).not.toBe(artifactManager);
							expect(() => managerWithArtifactSnapshot.restoreState(transformedArtifactSnapshot)).toThrow(
								"Session rollback adopted artifact manager is not live.",
							);
						}
					} finally {
						await managerWithArtifactSnapshot.close();
					}

					// Scenario 1a: same-manager restore
					managerA.restoreState(transformedSnapshot);
					expect(managerA.getSessionId()).toBe(snapshotA.sessionId);

					// Scenario 1b: cross-manager restore
					const managerB = SessionManager.create(root.path(), root.path(), storage);
					try {
						managerB.restoreState(transformedSnapshot);
						expect(managerB.getSessionId()).toBe(snapshotA.sessionId);
						expect(managerB.getSessionFile()).toBe(sessionFileA);
						managerB.appendMessage({ role: "user", content: "response", timestamp: 2 });
						await managerB.ensureOnDisk();
					} finally {
						await managerB.close();
					}

					// Scenario 2: identity changed after capture is detected
					// Capture a snapshot first, then modify the file externally,
					// then try to restore the stale snapshot
					const sessionFile = managerA.getSessionFile();
					if (!sessionFile) throw new Error("Expected session file");

					const snapshotForMutation = managerA.captureState();
					const transformedForMutation = testCase.transform(snapshotForMutation);

					// Now externally modify the session file to change its identity
					await fs.appendFile(sessionFile, "\n");

					const managerC = SessionManager.create(root.path(), root.path(), storage);
					try {
						// Try to restore the snapshot that was captured before the file changed
						// This should reject because the file has changed since the snapshot was captured
						await expect(() => {
							managerC.restoreState(transformedForMutation);
						}).toThrow(/Session rollback persistence identity changed/);
					} finally {
						await managerC.close();
					}

					// Scenario 3: restore during closeStrict rejects
					const snapshotForClose = managerA.captureState();
					const transformedForClose = testCase.transform(snapshotForClose);

					const managerD = SessionManager.create(root.path(), root.path(), storage);
					try {
						const closePromise = managerD.closeStrict();

						await expect(() => {
							managerD.restoreState(transformedForClose);
						}).toThrow(/Session manager is closing/);

						await closePromise;
					} finally {
						try {
							await managerD.close();
						} catch {
							// May be already closed
						}
					}
				} finally {
					await managerA.close();
				}
			} finally {
				root.removeSync();
			}
		}
	});

	// Test for handling adoptedArtifactManager in snapshot serialization
	it("rejects restoring snapshot with serialized adoptedArtifactManager", async () => {
		using root = TempDir.createSync("@pi-adopted-artifact-manager-serialization-");
		const storage = new FileSessionStorage();

		// Create a parent manager with an ArtifactManager
		const parentManager = SessionManager.create(root.path(), root.path(), storage);
		const parentArtifactManager = parentManager.getArtifactManager();
		if (!parentArtifactManager) throw new Error("Expected artifact manager from parent");

		// Create a child manager that adopts the parent's artifact manager
		const childManager = SessionManager.create(root.path(), root.path(), storage);
		childManager.adoptArtifactManager(parentArtifactManager);
		await childManager.ensureOnDisk();

		try {
			// Capture a snapshot that includes the adopted artifact manager
			const snapshot = childManager.captureState();
			if (!snapshot.adoptedArtifactManager) throw new Error("Expected adopted artifact manager in snapshot");

			// Serialize the snapshot using JSON (which will lose the adoptedArtifactManager)
			const serialized = JSON.stringify(snapshot);
			const deserialized = JSON.parse(serialized);

			// JSON serialization turns the live manager into a plain object, which
			// cannot safely be adopted by another session manager.
			expect(deserialized.adoptedArtifactManager).not.toBe(snapshot.adoptedArtifactManager);

			// Create a new manager and restore the deserialized snapshot
			const restoringManager = SessionManager.create(root.path(), root.path(), storage);
			try {
				const originalSessionId = restoringManager.getSessionId();
				expect(() => restoringManager.restoreState(deserialized)).toThrow(
					"Session rollback adopted artifact manager is not live.",
				);
				expect(restoringManager.getSessionId()).toBe(originalSessionId);
				expect(restoringManager.getArtifactManager()?.dir).not.toBe(parentArtifactManager.dir);
			} finally {
				await restoringManager.close();
			}
		} finally {
			await childManager.close();
			await parentManager.close();
		}
	});
});

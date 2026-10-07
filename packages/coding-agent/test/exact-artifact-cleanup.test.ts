import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import { ArtifactManager } from "../src/session/artifacts";
import {
	type ManagedDirectoryRoot,
	ManagedSessionDescendantStore,
	prepareManagedDirectoryRoot,
} from "../src/session/internal/managed-session-storage";

interface ArtifactFixture {
	readonly root: string;
	readonly store: ManagedSessionDescendantStore;
	readonly manager: ArtifactManager;
}

const fixtureRoots: string[] = [];
const fixtureStores: ManagedSessionDescendantStore[] = [];

afterEach(() => {
	for (const store of fixtureStores.splice(0).reverse()) store.close();
	for (const root of fixtureRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function expectedDirectoryRoot(pathname: string): ManagedDirectoryRoot {
	const stat = fs.lstatSync(pathname, { bigint: true });
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("fixture_directory_invalid");
	return {
		canonicalPath: path.resolve(pathname),
		dev: BigInt.asUintN(64, stat.dev),
		ino: BigInt.asUintN(64, stat.ino),
	};
}

function makeArtifactFixture(): ArtifactFixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "exact-artifact-cleanup-"));
	fixtureRoots.push(root);
	const securityPolicy = process.platform === "win32" ? "windows-existing-verify-first" : "default";
	const rootAuthority = prepareManagedDirectoryRoot(root, securityPolicy);
	const store = new ManagedSessionDescendantStore(
		rootAuthority,
		root,
		undefined,
		securityPolicy,
		root,
		expectedDirectoryRoot(root),
	);
	fixtureStores.push(store);
	return { root, store, manager: new ArtifactManager(store) };
}

describe("exact managed artifact cleanup", () => {
	it("removes only the requested named artifact and preserves concurrent native-looking residue", async () => {
		const fixture = makeArtifactFixture();
		const filename = "7.bash.log";
		const artifactPath = path.join(fixture.root, filename);
		const foreignPlaceholder = path.join(fixture.root, ".gjc-exact-unlink-placeholder-foreign");
		const foreignQuarantine = path.join(fixture.root, `${filename}.foreign.removing`);
		await fixture.manager.publishNamedNoReplace(filename, Buffer.from("owned artifact", "utf8"));

		const removeExpected = fixture.store.removeExpected.bind(fixture.store);
		const removalSpy = vi.spyOn(fixture.store, "removeExpected").mockImplementation((relativePath, expected) => {
			removeExpected(relativePath, expected);
			fs.writeFileSync(foreignPlaceholder, "foreign placeholder bytes", { flag: "wx" });
			fs.mkdirSync(foreignQuarantine);
			fs.writeFileSync(path.join(foreignQuarantine, "payload"), "foreign quarantine bytes", { flag: "wx" });
		});
		try {
			expect(await fixture.manager.removeNamedBestEffort(filename)).toBe(true);
			expect(removalSpy).toHaveBeenCalledTimes(1);
			expect(fs.existsSync(artifactPath)).toBe(false);
			expect(fs.readFileSync(foreignPlaceholder, "utf8")).toBe("foreign placeholder bytes");
			expect(fs.readFileSync(path.join(foreignQuarantine, "payload"), "utf8")).toBe("foreign quarantine bytes");
		} finally {
			removalSpy.mockRestore();
		}
	});

	it("reports a raced named-file replacement as unremoved and preserves its bytes", async () => {
		const fixture = makeArtifactFixture();
		const filename = "8.bash.log";
		const artifactPath = path.join(fixture.root, filename);
		const displacedArtifact = path.join(fixture.root, "owned-artifact-displaced");
		await fixture.manager.publishNamedNoReplace(filename, Buffer.from("owned artifact", "utf8"));

		const removeExpected = fixture.store.removeExpected.bind(fixture.store);
		const removalSpy = vi.spyOn(fixture.store, "removeExpected").mockImplementation((relativePath, expected) => {
			fs.renameSync(artifactPath, displacedArtifact);
			fs.writeFileSync(artifactPath, "foreign replacement", { flag: "wx" });
			removeExpected(relativePath, expected);
		});
		try {
			expect(await fixture.manager.removeNamedBestEffort(filename)).toBe(false);
			expect(removalSpy).toHaveBeenCalledTimes(1);
			expect(fs.readFileSync(artifactPath, "utf8")).toBe("foreign replacement");
			expect(fs.readFileSync(displacedArtifact, "utf8")).toBe("owned artifact");
		} finally {
			removalSpy.mockRestore();
		}
	});

	it.skipIf(process.platform !== "linux")(
		"quiesces its owned child, then propagates native quarantine evidence without sweeping parent siblings",
		async () => {
			const fixture = makeArtifactFixture();
			const attemptId = "cleanup-attempt";
			const staging = fixture.manager.createAttemptStaging(attemptId);
			const stagingStore = staging.getManagedStore();
			if (!stagingStore) throw new Error("managed_attempt_store_missing");
			const stagingRelativePath = path.posix.join(".staging", attemptId);
			const foreignPlaceholder = path.join(fixture.root, ".staging", ".gjc-remove-foreign");
			const foreignQuarantine = path.join(fixture.root, ".staging", `${attemptId}.foreign.removing`);
			fixtureStores.push(stagingStore);
			await staging.publishNamedNoReplace("1.bash.log", Buffer.from("owned staged artifact", "utf8"));

			const nativeResults: native.RecoveryFsRetainedCleanupResult[] = [];
			const realNativeRemove = native.RecoveryFsRoot.prototype.removeManagedTree;
			const nativeRemoveSpy = vi
				.spyOn(native.RecoveryFsRoot.prototype, "removeManagedTree")
				.mockImplementation(function (this: native.RecoveryFsRoot, relativePath, expected) {
					const result = realNativeRemove.call(this, relativePath, expected);
					nativeResults.push(result);
					return result;
				});
			const removeTreeExpected = fixture.store.removeTreeExpected.bind(fixture.store);
			const removalSpy = vi
				.spyOn(fixture.store, "removeTreeExpected")
				.mockImplementation((relativePath, expected) => {
					// Native tree retirement detaches the exact captured tree to retained
					// quarantine and reports cleanup_pending; it does not physically reclaim
					// that payload. The siblings belong to a concurrent parent publisher.
					let childAuthorityClosed = false;
					try {
						stagingStore.assertBound();
					} catch {
						childAuthorityClosed = true;
					}
					expect(childAuthorityClosed).toBe(true);
					fs.writeFileSync(foreignPlaceholder, "foreign placeholder bytes", { flag: "wx" });
					fs.mkdirSync(foreignQuarantine);
					fs.writeFileSync(path.join(foreignQuarantine, "payload"), "foreign quarantine bytes", { flag: "wx" });
					removeTreeExpected(relativePath, expected);
				});
			try {
				await expect(staging.discardAttemptStaging()).rejects.toThrow("cleanup_pending");
				expect(removalSpy).toHaveBeenCalledTimes(1);
				expect(removalSpy).toHaveBeenCalledWith(stagingRelativePath, expect.anything());
				expect(nativeRemoveSpy).toHaveBeenCalledTimes(1);
				const nativeResult = nativeResults[0];
				if (!nativeResult?.recoveryPath || !nativeResult.treeSnapshot)
					throw new Error("native_quarantine_evidence_missing");
				expect(nativeResult).toMatchObject({ ok: false, code: "cleanup_pending" });
				expect(nativeResult.treeSnapshot.rootDev).toBe(stagingStore.subtreeRootAuthority.dev.toString());
				expect(nativeResult.treeSnapshot.rootIno).toBe(stagingStore.subtreeRootAuthority.ino.toString());
				expect(fs.existsSync(staging.dir)).toBe(false);
				expect(fs.readFileSync(path.join(fixture.root, nativeResult.recoveryPath, "1.bash.log"), "utf8")).toBe(
					"owned staged artifact",
				);
				expect(fs.readFileSync(foreignPlaceholder, "utf8")).toBe("foreign placeholder bytes");
				expect(fs.readFileSync(path.join(foreignQuarantine, "payload"), "utf8")).toBe("foreign quarantine bytes");
			} finally {
				removalSpy.mockRestore();
				nativeRemoveSpy.mockRestore();
			}
		},
	);

	it.skipIf(process.platform !== "linux")(
		"propagates the same native quarantine outcome with a separate writable child still retained",
		async () => {
			const fixture = makeArtifactFixture();
			const attemptId = "live-child-attempt";
			const stagingRelativePath = path.posix.join(".staging", attemptId);
			const staging = fixture.manager.createAttemptStaging(attemptId);
			const stagingStore = staging.getManagedStore();
			if (!stagingStore) throw new Error("managed_attempt_store_missing");
			fixtureStores.push(stagingStore);
			await staging.publishNamedNoReplace("3.bash.log", Buffer.from("owned staged artifact", "utf8"));

			// This separate store owns its own retained writable child authority. Keeping
			// it open confirms the operation does not depend on closing every observer;
			// native cleanup_pending is the documented quarantine disposition, not proof
			// of an FD refusal.
			const independentLiveStore = fixture.store.deriveSubtree(stagingRelativePath);
			fixtureStores.push(independentLiveStore);
			const independentClose = independentLiveStore.close.bind(independentLiveStore);
			const independentCloseSpy = vi
				.spyOn(independentLiveStore, "close")
				.mockImplementation(() => independentClose());
			const stagingClose = stagingStore.close.bind(stagingStore);
			const stagingCloseSpy = vi.spyOn(stagingStore, "close").mockImplementation(() => stagingClose());
			const nativeResults: native.RecoveryFsRetainedCleanupResult[] = [];
			const realNativeRemove = native.RecoveryFsRoot.prototype.removeManagedTree;
			const nativeRemoveSpy = vi
				.spyOn(native.RecoveryFsRoot.prototype, "removeManagedTree")
				.mockImplementation(function (this: native.RecoveryFsRoot, relativePath, expected) {
					const result = realNativeRemove.call(this, relativePath, expected);
					nativeResults.push(result);
					return result;
				});
			const removeTreeExpected = fixture.store.removeTreeExpected.bind(fixture.store);
			const removalSpy = vi
				.spyOn(fixture.store, "removeTreeExpected")
				.mockImplementation((relativePath, expected) => {
					let attemptAuthorityClosed = false;
					try {
						stagingStore.assertBound();
					} catch {
						attemptAuthorityClosed = true;
					}
					expect(attemptAuthorityClosed).toBe(true);
					const liveStoreStillBound = (() => {
						try {
							independentLiveStore.assertBound();
							return true;
						} catch {
							return false;
						}
					})();
					expect(liveStoreStillBound).toBe(true);
					removeTreeExpected(relativePath, expected);
				});
			try {
				await expect(staging.discardAttemptStaging()).rejects.toThrow("cleanup_pending");
				expect(removalSpy).toHaveBeenCalledTimes(1);
				expect(stagingCloseSpy).toHaveBeenCalled();
				expect(independentCloseSpy).not.toHaveBeenCalled();
				const nativeResult = nativeResults[0];
				if (!nativeResult?.recoveryPath || !nativeResult.treeSnapshot)
					throw new Error("native_quarantine_evidence_missing");
				expect(nativeResult).toMatchObject({ ok: false, code: "cleanup_pending" });
				expect(fs.readFileSync(path.join(fixture.root, nativeResult.recoveryPath, "3.bash.log"), "utf8")).toBe(
					"owned staged artifact",
				);
			} finally {
				removalSpy.mockRestore();
				nativeRemoveSpy.mockRestore();
				stagingCloseSpy.mockRestore();
				independentCloseSpy.mockRestore();
				independentLiveStore.close();
			}
		},
	);

	it("does not adopt a replacement at the issued attempt-root name", async () => {
		const fixture = makeArtifactFixture();
		const attemptId = "reused-attempt";
		const staging = fixture.manager.createAttemptStaging(attemptId);
		const stagingStore = staging.getManagedStore();
		if (!stagingStore) throw new Error("managed_attempt_store_missing");
		const stagingRelativePath = path.posix.join(".staging", attemptId);
		const displacedRoot = path.join(fixture.root, ".staging", `${attemptId}.owned`);
		const replacementPayload = path.join(staging.dir, "foreign-sentinel");
		fixtureStores.push(stagingStore);
		await staging.publishNamedNoReplace("2.bash.log", Buffer.from("owned staged artifact", "utf8"));
		const closeStore = stagingStore.close.bind(stagingStore);
		const closeSpy = vi.spyOn(stagingStore, "close").mockImplementation(() => closeStore());

		const captureTree = fixture.store.captureTree.bind(fixture.store);
		let replaced = false;
		const captureSpy = vi.spyOn(fixture.store, "captureTree").mockImplementation(relativePath => {
			if (relativePath === stagingRelativePath && !replaced) {
				fs.renameSync(staging.dir, displacedRoot);
				fs.mkdirSync(staging.dir, { mode: 0o700 });
				fs.writeFileSync(replacementPayload, "foreign replacement root", { flag: "wx", mode: 0o600 });
				replaced = true;
			}
			return captureTree(relativePath);
		});
		try {
			await expect(fixture.manager.commitAttemptStaging(staging, attemptId)).rejects.toThrow(
				"artifact_staging_root_changed",
			);
			expect(captureSpy.mock.calls.map(([relativePath]) => relativePath)).toContain(stagingRelativePath);
			expect(replaced).toBe(true);
			expect(closeSpy).toHaveBeenCalled();
			expect(() => stagingStore.assertBound()).toThrow();
			expect(fs.readFileSync(replacementPayload, "utf8")).toBe("foreign replacement root");
			expect(fs.readFileSync(path.join(displacedRoot, "2.bash.log"), "utf8")).toBe("owned staged artifact");
			expect(fs.existsSync(path.join(fixture.root, "2.bash.log"))).toBe(false);
			expect(await fixture.manager.save("rollback reused the available ID", "bash")).toBe("0");
		} finally {
			captureSpy.mockRestore();
			closeSpy.mockRestore();
			stagingStore.close();
		}
	});

	it("does not treat a borrowed managed root as an attempt-owned retirement target", async () => {
		const fixture = makeArtifactFixture();
		await fixture.manager.publishNamedNoReplace("parent.log", Buffer.from("parent artifact", "utf8"));

		await fixture.manager.discardAttemptStaging();

		expect(fs.readFileSync(path.join(fixture.root, "parent.log"), "utf8")).toBe("parent artifact");
	});

	it.skipIf(process.platform !== "linux")(
		"keeps published artifacts and their rollback reservation after native attempt-tree quarantine",
		async () => {
			const fixture = makeArtifactFixture();
			await fixture.manager.save("preexisting parent artifact", "tool");
			const attemptId = "commit-quarantined-attempt";
			const staging = fixture.manager.createAttemptStaging(attemptId);
			const stagedId = await staging.save("published candidate artifact", "tool");

			const nativeResults: native.RecoveryFsRetainedCleanupResult[] = [];
			const realNativeRemove = native.RecoveryFsRoot.prototype.removeManagedTree;
			const nativeRemoveSpy = vi
				.spyOn(native.RecoveryFsRoot.prototype, "removeManagedTree")
				.mockImplementation(function (this: native.RecoveryFsRoot, relativePath, expected) {
					const result = realNativeRemove.call(this, relativePath, expected);
					nativeResults.push(result);
					return result;
				});
			try {
				const mapping = await fixture.manager.commitAttemptStaging(staging, attemptId);
				expect(mapping.get(stagedId)).toBe("1");
				expect(await Bun.file(path.join(fixture.root, "1.tool.log")).text()).toBe("published candidate artifact");
				expect(nativeRemoveSpy).toHaveBeenCalledTimes(1);
				const nativeResult = nativeResults[0];
				if (!nativeResult?.recoveryPath || !nativeResult.treeSnapshot)
					throw new Error("native_quarantine_evidence_missing");
				expect(nativeResult).toMatchObject({ ok: false, code: "cleanup_pending" });
				expect(
					await Bun.file(path.join(fixture.root, nativeResult.recoveryPath, `${stagedId}.tool.log`)).text(),
				).toBe("published candidate artifact");
				expect(fs.existsSync(staging.dir)).toBe(false);

				// A real reservation must remain so explicit rollback removes exactly
				// the parent publication instead of treating this commit as unreserved.
				await fixture.manager.rollbackLastAttemptCommit(attemptId);
				expect(await fixture.manager.exists("1")).toBe(false);
				expect(await Bun.file(path.join(fixture.root, "0.tool.log")).text()).toBe("preexisting parent artifact");
			} finally {
				nativeRemoveSpy.mockRestore();
			}
		},
	);

	it("does not classify a publication error named cleanup_pending as staging cleanup success", async () => {
		const fixture = makeArtifactFixture();
		const attemptId = "publication-pending-error";
		const staging = fixture.manager.createAttemptStaging(attemptId);
		const stagingStore = staging.getManagedStore();
		if (!stagingStore) throw new Error("managed_attempt_store_missing");
		fixtureStores.push(stagingStore);
		await staging.save("must not publish", "tool");

		const publishSpy = vi.spyOn(fixture.store, "publishNoReplace").mockImplementation(async () => {
			throw new Error("cleanup_pending");
		});
		try {
			await expect(fixture.manager.commitAttemptStaging(staging, attemptId)).rejects.toThrow("cleanup_pending");
			expect(publishSpy).toHaveBeenCalledTimes(1);
			publishSpy.mockRestore();
			expect(await fixture.manager.save("publication error remained a failure", "tool")).toBe("0");
			expect(await fixture.manager.exists("0")).toBe(true);
		} finally {
			publishSpy.mockRestore();
		}
	});
});

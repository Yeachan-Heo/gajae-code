import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getSessionsDir } from "@gajae-code/utils";
import { safeRm } from "../../../scripts/safe-cleanup";
import { ManagedSessionDescendantStore } from "../src/session/internal/managed-session-storage";
import { SessionManager, SessionManagerTestHooks } from "../src/session/session-manager";
import { OWNER_DIRECTORY, OWNER_MANIFEST, ownerIdForSession } from "../src/session/task-artifact-owner-codec";

const roots: string[] = [];

afterEach(async () => {
	SessionManagerTestHooks.beforePersistPatchFence = undefined;
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map(root => safeRm(root, { recursive: true, force: true })));
});

describe("managed task artifact owner lifecycle", () => {
	it("closes the newly created owner store and preserves the header-patch persistence error", async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-owner-patch-failure-")));
		roots.push(root);
		const cwd = path.join(root, "workspace");
		await fs.mkdir(cwd, { recursive: true });

		const sessionManager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, root));
		const primaryFailure = new Error("injected task artifact owner header patch failure");
		const closedOwnerStores: Array<{ store: ManagedSessionDescendantStore; afterPatchFailure: boolean }> = [];
		let injected = false;
		const close = ManagedSessionDescendantStore.prototype.close;
		try {
			await sessionManager.ensureOnDisk();
			await sessionManager.flush();
			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persistent managed session file");
			const ownerPath = path.join(
				getSessionsDir(root),
				OWNER_DIRECTORY,
				ownerIdForSession(sessionManager.getSessionId()),
			);
			vi.spyOn(ManagedSessionDescendantStore.prototype, "close").mockImplementation(function (
				this: ManagedSessionDescendantStore,
			) {
				if (this.dir === ownerPath) closedOwnerStores.push({ store: this, afterPatchFailure: injected });
				return close.call(this);
			});
			SessionManagerTestHooks.beforePersistPatchFence = () => {
				injected = true;
				throw primaryFailure;
			};

			const observedFailure = await sessionManager.ensureArtifactManager().then(
				() => undefined,
				error => error,
			);
			if (observedFailure !== primaryFailure)
				throw new Error(
					`Expected the original persistence error, observed ${observedFailure instanceof Error ? `${observedFailure.name}: ${observedFailure.message}` : String(observedFailure)}`,
				);

			expect(injected).toBe(true);
			expect(closedOwnerStores.map(({ afterPatchFailure }) => afterPatchFailure)).toEqual([false, true]);
			expect(closedOwnerStores[0]?.store).not.toBe(closedOwnerStores[1]?.store);
			expect((await fs.stat(path.join(ownerPath, OWNER_MANIFEST))).isFile()).toBe(true);
			expect(await Bun.file(sessionFile).text()).not.toContain("taskArtifactOwner");
		} finally {
			SessionManagerTestHooks.beforePersistPatchFence = undefined;
			await sessionManager.close().catch(error => {
				if (error !== primaryFailure) throw error;
			});
		}
	});

	it("closes and restores its stable owner when a managed session is reopened", async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-task-owner-close-")));
		roots.push(root);
		const cwd = path.join(root, "workspace");
		await fs.mkdir(cwd, { recursive: true });
		const sessionManager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, root));
		const close = ManagedSessionDescendantStore.prototype.close;
		let ownerStoreClosed = false;
		let reopened: SessionManager | undefined;
		try {
			await sessionManager.ensureOnDisk();
			await sessionManager.flush();
			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persistent managed session file");
			const ownerManager = await sessionManager.ensureArtifactManager();
			if (!ownerManager) throw new Error("Expected a managed owner manager");
			const ownerStore = ownerManager.getManagedStore();
			if (!ownerStore) throw new Error("Expected a managed owner store");
			const ownerDir = ownerManager.dir;
			const targetCwd = path.join(root, "workspace-target");
			await fs.mkdir(targetCwd, { recursive: true });
			await sessionManager.moveTo(targetCwd);
			expect(await sessionManager.ensureArtifactManager()).toBe(ownerManager);
			expect(ownerManager.dir).toBe(ownerDir);
			const movedSessionFile = sessionManager.getSessionFile();
			if (!movedSessionFile) throw new Error("Expected the moved managed session file");
			vi.spyOn(ManagedSessionDescendantStore.prototype, "close").mockImplementation(function (
				this: ManagedSessionDescendantStore,
			) {
				if (this === ownerStore) ownerStoreClosed = true;
				return close.call(this);
			});

			await sessionManager.close();
			expect(ownerStoreClosed).toBe(true);
			reopened = await SessionManager.open(movedSessionFile, SessionManager.managedDestination(targetCwd, root));
			const restoredOwner = await reopened.ensureArtifactManager();
			expect(restoredOwner?.dir).toBe(ownerDir);
		} finally {
			await reopened?.close();
			await sessionManager.close();
		}
	});
});

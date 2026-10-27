import { afterEach, describe, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	ManagedSessionDescendantStore,
	prepareManagedDirectoryRoot,
} from "../src/session/internal/managed-session-storage";
import {
	ensureManagedTaskArtifactOwner,
	type ManagedTaskArtifactOwner,
	restoreManagedTaskArtifactOwner,
} from "../src/session/task-artifact-owner";
import {
	OWNER_LOCK_DIRECTORY,
	OWNER_MANIFEST,
	ownerAbsolutePath,
	ownerIdForSession,
	ownerRelativePath,
	type TaskArtifactOwnerStorageContext,
} from "../src/session/task-artifact-owner-codec";

interface Fixture {
	readonly root: string;
	readonly profileAgentDir: string;
	readonly sessionsRoot: string;
	readonly sessionId: string;
	readonly context: TaskArtifactOwnerStorageContext;
}

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeFixture(sessionId = `provisioning-${crypto.randomUUID()}`): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-owner-provisioning-"));
	roots.push(root);
	const profileAgentDir = path.resolve(root);
	const sessionsRoot = path.join(profileAgentDir, "sessions");
	fs.mkdirSync(sessionsRoot, { mode: 0o700 });
	const securityPolicy = process.platform === "win32" ? "windows-existing-verify-first" : "default";
	const context: TaskArtifactOwnerStorageContext = {
		rootAuthority: prepareManagedDirectoryRoot(profileAgentDir, securityPolicy),
		sessionsRoot,
		securityPolicy,
		profileAgentDir,
	};
	return { root, profileAgentDir, sessionsRoot, sessionId, context };
}

function closeOwner(owner: ManagedTaskArtifactOwner | undefined): void {
	owner?.manager.getManagedStore()?.close();
}

function waitForBoundary(promise: Promise<void>, label: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} boundary timed out`)), 10_000);
		void promise.then(
			() => {
				clearTimeout(timer);
				resolve();
			},
			error => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

async function writeLegacyTree(fixture: Fixture): Promise<string> {
	const legacyRelativePath = "legacy-artifacts";
	const nested = path.join(fixture.sessionsRoot, legacyRelativePath, "nested");
	fs.mkdirSync(nested, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(fixture.sessionsRoot, legacyRelativePath, "root.txt"), "legacy-root", { mode: 0o600 });
	fs.writeFileSync(path.join(nested, "nested.txt"), "legacy-nested", { mode: 0o600 });
	return legacyRelativePath;
}

describe("managed task artifact owner provisioning", () => {
	it("provisions one logical owner across independent concurrent contexts and restores it read-only", async () => {
		const fixture = makeFixture("concurrent-logical-session");
		const secondContext: TaskArtifactOwnerStorageContext = {
			...fixture.context,
			rootAuthority: prepareManagedDirectoryRoot(fixture.profileAgentDir, fixture.context.securityPolicy),
		};
		let first: ManagedTaskArtifactOwner | undefined;
		let second: ManagedTaskArtifactOwner | undefined;
		let restored: ManagedTaskArtifactOwner | undefined;
		try {
			[first, second] = await Promise.all([
				ensureManagedTaskArtifactOwner(fixture.context, fixture.sessionId, undefined),
				ensureManagedTaskArtifactOwner(secondContext, fixture.sessionId, undefined),
			]);
			expect(first.locator).toEqual(second.locator);
			expect(first.manager.dir).toBe(ownerAbsolutePath(fixture.context, ownerIdForSession(fixture.sessionId)));
			expect(second.manager.dir).toBe(first.manager.dir);
			expect(first.manager).not.toBe(second.manager);
			expect(first.manager.getManagedStore()).not.toBe(second.manager.getManagedStore());

			const manifestPath = path.join(first.manager.dir, OWNER_MANIFEST);
			const manifestBefore = await Bun.file(manifestPath).text();
			const manifestStatBefore = fs.lstatSync(manifestPath, { bigint: true });
			restored = restoreManagedTaskArtifactOwner(fixture.context, fixture.sessionId, first.locator);
			const manifestStatAfter = fs.lstatSync(manifestPath, { bigint: true });
			expect(restored.locator).toEqual(first.locator);
			expect(restored.manager.dir).toBe(first.manager.dir);
			expect(await Bun.file(manifestPath).text()).toBe(manifestBefore);
			expect(manifestStatAfter.ino).toBe(manifestStatBefore.ino);
			expect(manifestStatAfter.mode & 0o777n).toBe(manifestStatBefore.mode & 0o777n);
			expect(manifestStatAfter.ctimeNs).toBe(manifestStatBefore.ctimeNs);
			const parsed: unknown = JSON.parse(manifestBefore);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
				throw new Error("provisioned manifest is not an object");
			expect(Object.keys(parsed)).toHaveLength(5);
			expect((parsed as Record<string, unknown>).sessionId).toBe(fixture.sessionId);
		} finally {
			closeOwner(restored);
			closeOwner(second);
			closeOwner(first);
		}
	});

	it("restores a valid locator without creating a missing owner or replacing a foreign occupant", async () => {
		const fixture = makeFixture();
		const owner = await ensureManagedTaskArtifactOwner(fixture.context, fixture.sessionId, undefined);
		const originalOwnerPath = owner.manager.dir;
		const displaced = `${originalOwnerPath}.displaced-${crypto.randomUUID()}`;
		closeOwner(owner);
		fs.renameSync(originalOwnerPath, displaced);
		try {
			await expect(
				ensureManagedTaskArtifactOwner(fixture.context, fixture.sessionId, owner.locator),
			).rejects.toThrow("task_artifact_owner_missing");
			expect(fs.existsSync(originalOwnerPath)).toBe(false);
			expect(fs.existsSync(displaced)).toBe(true);
		} finally {
			fs.renameSync(displaced, originalOwnerPath);
		}

		const replaced = `${originalOwnerPath}.replaced-${crypto.randomUUID()}`;
		fs.renameSync(originalOwnerPath, replaced);
		fs.writeFileSync(originalOwnerPath, "untouched foreign owner occupant", { mode: 0o600 });
		try {
			await expect(
				ensureManagedTaskArtifactOwner(fixture.context, fixture.sessionId, owner.locator),
			).rejects.toThrow("task_artifact_owner_replaced");
			expect(await Bun.file(originalOwnerPath).text()).toBe("untouched foreign owner occupant");
		} finally {
			fs.rmSync(originalOwnerPath, { force: true });
			fs.renameSync(replaced, originalOwnerPath);
		}
	});

	it("copies and fully verifies a bounded legacy tree before publishing the manifest", async () => {
		const fixture = makeFixture();
		const legacyRelativePath = await writeLegacyTree(fixture);
		let owner: ManagedTaskArtifactOwner | undefined;
		try {
			owner = await ensureManagedTaskArtifactOwner(
				fixture.context,
				fixture.sessionId,
				undefined,
				legacyRelativePath,
			);
			expect(await Bun.file(path.join(owner.manager.dir, "root.txt")).text()).toBe("legacy-root");
			expect(await Bun.file(path.join(owner.manager.dir, "nested", "nested.txt")).text()).toBe("legacy-nested");
			expect(await Bun.file(path.join(fixture.sessionsRoot, legacyRelativePath, "root.txt")).text()).toBe(
				"legacy-root",
			);
			const names = fs.readdirSync(owner.manager.dir);
			expect(names).toContain(OWNER_MANIFEST);
			expect(fs.statSync(path.join(owner.manager.dir, "nested")).isDirectory()).toBe(true);
			const store = owner.manager.getManagedStore();
			if (!store) throw new Error("provisioned ArtifactManager lost its managed store");
			store.assertBound();
		} finally {
			closeOwner(owner);
		}
	});

	it("fails closed on an existing owner with a malformed or session-mismatched manifest", async () => {
		const fixture = makeFixture();
		const owner = await ensureManagedTaskArtifactOwner(fixture.context, fixture.sessionId, undefined);
		const ownerPath = owner.manager.dir;
		const store = owner.manager.getManagedStore();
		if (!store) throw new Error("owner store unavailable");
		await store.replace(OWNER_MANIFEST, Buffer.from("{", "utf8"));
		closeOwner(owner);
		await expect(ensureManagedTaskArtifactOwner(fixture.context, fixture.sessionId, undefined)).rejects.toThrow(
			"task_artifact_owner_manifest_invalid",
		);
		expect(await Bun.file(path.join(ownerPath, OWNER_MANIFEST)).text()).toBe("{");

		const second = makeFixture();
		const secondOwner = await ensureManagedTaskArtifactOwner(second.context, second.sessionId, undefined);
		const secondPath = secondOwner.manager.dir;
		const secondStore = secondOwner.manager.getManagedStore();
		if (!secondStore) throw new Error("owner store unavailable");
		await secondStore.replace(
			OWNER_MANIFEST,
			Buffer.from(`${JSON.stringify({ ...secondOwner.locator, sessionId: "different-session" })}\n`, "utf8"),
		);
		closeOwner(secondOwner);
		await expect(ensureManagedTaskArtifactOwner(second.context, second.sessionId, undefined)).rejects.toThrow(
			"task_artifact_owner_session_mismatch",
		);
		expect(await Bun.file(path.join(secondPath, OWNER_MANIFEST)).text()).toContain("different-session");
	});

	it("refuses legacy copy when the captured source tree changes and leaves no owner manifest", async () => {
		const fixture = makeFixture();
		const legacyRelativePath = await writeLegacyTree(fixture);
		const sourceFile = path.join(legacyRelativePath, "root.txt");
		const ownerPath = ownerAbsolutePath(fixture.context, ownerIdForSession(fixture.sessionId));
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const originalPublish = ManagedSessionDescendantStore.prototype.publishNoReplace;
		const publish = vi
			.spyOn(ManagedSessionDescendantStore.prototype, "publishNoReplace")
			.mockImplementation(async function (
				this: ManagedSessionDescendantStore,
				relativePath: string,
				bytes: Uint8Array,
			) {
				if (
					this.dir === fixture.sessionsRoot &&
					relativePath === path.posix.join(ownerRelativePath(ownerIdForSession(fixture.sessionId)), "root.txt")
				) {
					entered.resolve();
					await resume.promise;
				}
				return originalPublish.call(this, relativePath, bytes);
			});
		const attempt = ensureManagedTaskArtifactOwner(fixture.context, fixture.sessionId, undefined, legacyRelativePath);
		try {
			await waitForBoundary(entered.promise, "legacy copy");
			await Bun.write(path.join(fixture.sessionsRoot, sourceFile), "changed after capture");
			resume.resolve();
			await expect(attempt).rejects.toThrow("task_artifact_owner_copy_mismatch");
			expect(await Bun.file(path.join(ownerPath, "root.txt")).text()).toBe("legacy-root");
			expect(await Bun.file(path.join(fixture.sessionsRoot, sourceFile)).text()).toBe("changed after capture");
			expect(fs.existsSync(path.join(ownerPath, OWNER_MANIFEST))).toBe(false);
		} finally {
			resume.resolve();
			publish.mockRestore();
			await attempt.catch(() => {});
		}
	});

	it("fences manifest publication after an actual managed lock entry is replaced", async () => {
		const fixture = makeFixture();
		const legacyRelativePath = await writeLegacyTree(fixture);
		const ownerId = ownerIdForSession(fixture.sessionId);
		const ownerPath = ownerAbsolutePath(fixture.context, ownerId);
		const lockPath = path.join(fixture.sessionsRoot, OWNER_LOCK_DIRECTORY, `owner-${ownerId}.lock`);
		const displacedLock = `${lockPath}.fixture-displaced`;
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const originalPublish = ManagedSessionDescendantStore.prototype.publishNoReplace;
		const publish = vi
			.spyOn(ManagedSessionDescendantStore.prototype, "publishNoReplace")
			.mockImplementation(async function (
				this: ManagedSessionDescendantStore,
				relativePath: string,
				bytes: Uint8Array,
			) {
				if (
					this.dir === fixture.sessionsRoot &&
					relativePath === path.posix.join(ownerRelativePath(ownerIdForSession(fixture.sessionId)), "root.txt")
				) {
					entered.resolve();
					await resume.promise;
				}
				return originalPublish.call(this, relativePath, bytes);
			});
		const attempt = ensureManagedTaskArtifactOwner(fixture.context, fixture.sessionId, undefined, legacyRelativePath);
		try {
			await waitForBoundary(entered.promise, "legacy copy");
			const lockStat = fs.lstatSync(lockPath, { bigint: true });
			expect(lockStat.isFile()).toBe(true);
			const lockRecord: unknown = JSON.parse(await Bun.file(lockPath).text());
			if (typeof lockRecord !== "object" || lockRecord === null || Array.isArray(lockRecord))
				throw new Error("owner lock record is invalid");
			expect((lockRecord as Record<string, unknown>).pid).toBe(process.pid);
			expect(typeof (lockRecord as Record<string, unknown>).attemptId).toBe("string");
			fs.renameSync(lockPath, displacedLock);
			fs.writeFileSync(lockPath, "foreign lock successor", { mode: 0o600, flag: "wx" });
			resume.resolve();
			await expect(attempt).rejects.toBeInstanceOf(AggregateError);
			expect(fs.existsSync(path.join(ownerPath, OWNER_MANIFEST))).toBe(false);
			expect(await Bun.file(path.join(ownerPath, "root.txt")).text()).toBe("legacy-root");
			expect(await Bun.file(path.join(fixture.sessionsRoot, legacyRelativePath, "root.txt")).text()).toBe(
				"legacy-root",
			);
		} finally {
			resume.resolve();
			publish.mockRestore();
			await attempt.catch(() => {});
			fs.rmSync(lockPath, { force: true });
			fs.rmSync(displacedLock, { force: true });
		}
	});

	it("leaves copied payload and the competing manifest intact when final manifest publication loses", async () => {
		const fixture = makeFixture();
		const legacyRelativePath = await writeLegacyTree(fixture);
		const ownerPath = ownerAbsolutePath(fixture.context, ownerIdForSession(fixture.sessionId));
		const originalPublish = ManagedSessionDescendantStore.prototype.publishNoReplace;
		const publish = vi
			.spyOn(ManagedSessionDescendantStore.prototype, "publishNoReplace")
			.mockImplementation(async function (
				this: ManagedSessionDescendantStore,
				relativePath: string,
				bytes: Uint8Array,
			) {
				if (this.dir === ownerPath && relativePath === OWNER_MANIFEST) {
					fs.writeFileSync(path.join(ownerPath, OWNER_MANIFEST), "competing malformed manifest", {
						mode: 0o600,
						flag: "wx",
					});
				}
				return originalPublish.call(this, relativePath, bytes);
			});
		try {
			await expect(
				ensureManagedTaskArtifactOwner(fixture.context, fixture.sessionId, undefined, legacyRelativePath),
			).rejects.toThrow();
			expect(await Bun.file(path.join(ownerPath, "root.txt")).text()).toBe("legacy-root");
			expect(await Bun.file(path.join(ownerPath, OWNER_MANIFEST)).text()).toBe("competing malformed manifest");
			expect(await Bun.file(path.join(fixture.sessionsRoot, legacyRelativePath, "root.txt")).text()).toBe(
				"legacy-root",
			);
		} finally {
			publish.mockRestore();
		}
	});
});

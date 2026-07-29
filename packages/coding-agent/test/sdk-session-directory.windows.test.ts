import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import { resolveManagedSessionScope } from "../src/sdk/session-directory";
import {
	ManagedSessionDescendantStore,
	shouldFsyncManagedDirectory,
} from "../src/session/internal/managed-session-storage";
import { SessionManager } from "../src/session/session-manager";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
	vi.restoreAllMocks();
});

function durableTreeEvidence(snapshot: native.NativeDirectoryTreeSnapshot): unknown[] {
	return snapshot.entries.map(entry =>
		entry.kind === "directory"
			? { relativePath: entry.relativePath, kind: entry.kind, dev: entry.dev, ino: entry.ino }
			: entry,
	);
}

it("skips unsupported managed directory fsync on Windows", () => {
	expect(shouldFsyncManagedDirectory("win32")).toBe(false);
	expect(shouldFsyncManagedDirectory("linux")).toBe(true);
});
describe.skipIf(process.platform !== "win32")("Windows managed session directory", () => {
	it("uses one scope for a workspace and its junction alias", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-directory-windows-"));
		temporaryDirectories.push(root);
		const workspace = path.join(root, "Workspace");
		const alias = path.join(root, "workspace-alias");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(workspace);
		await fs.symlink(workspace, alias, "junction");

		const [direct, viaAlias] = await Promise.all([
			resolveManagedSessionScope({ cwd: workspace, agentDir }),
			resolveManagedSessionScope({ cwd: alias, agentDir }),
		]);

		expect(direct.kind).toBe("resolved");
		expect(viaAlias.kind).toBe("resolved");
		if (direct.kind === "resolved" && viaAlias.kind === "resolved") {
			const { legacyLexicalCwd: directLegacyCwd, ...directManagedIdentity } = direct.scope;
			const { legacyLexicalCwd: aliasLegacyCwd, ...aliasManagedIdentity } = viaAlias.scope;
			expect(aliasManagedIdentity).toEqual(directManagedIdentity);
			expect(directLegacyCwd).toBe(path.resolve(workspace));
			expect(aliasLegacyCwd).toBe(path.resolve(alias));
			expect(aliasLegacyCwd).not.toBe(directLegacyCwd);
			expect(direct.scope.canonicalCwd).toStartWith("\\\\?\\Volume{");
			expect(direct.scope.directoryName).toMatch(/^v2-[a-z2-7]{52}$/);
		}
	});

	it("rejects UNC workspaces as network identities without creating a managed root", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-directory-windows-"));
		temporaryDirectories.push(root);
		const agentDir = path.join(root, "agent");

		const result = await resolveManagedSessionScope({
			cwd: String.raw`\\server\share\workspace`,
			agentDir,
			sessionsRoot: path.join(agentDir, "sessions"),
		});
		expect(result).toMatchObject({ kind: "error", code: "network_unsupported" });
		await expect(fs.access(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects extended UNC workspaces before probing or creating the managed root", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-directory-windows-"));
		temporaryDirectories.push(root);
		const agentDir = path.join(root, "agent");

		const result = await resolveManagedSessionScope({
			cwd: String.raw`\\?\UNC\server\share\workspace`,
			agentDir,
			sessionsRoot: path.join(agentDir, "sessions"),
		});
		expect(result).toMatchObject({ kind: "error", code: "network_unsupported" });
		await expect(fs.access(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.skipIf(!process.env.GJC_TEST_SUBST_WORKSPACE)(
		"binds a configured subst alias to its canonical volume identity",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-directory-windows-"));
			temporaryDirectories.push(root);
			const agentDir = path.join(root, "agent");
			const substWorkspace = process.env.GJC_TEST_SUBST_WORKSPACE;
			if (!substWorkspace) throw new Error("Missing subst workspace");

			const resolved = await resolveManagedSessionScope({ cwd: substWorkspace, agentDir });
			expect(resolved.kind).toBe("resolved");
			if (resolved.kind === "resolved") {
				expect(resolved.scope.canonicalCwd).toStartWith("\\\\?\\Volume{");
				expect(resolved.scope.directoryName).toMatch(/^v2-[a-z2-7]{52}$/);
			}
		},
	);

	it("fails closed on an invalid required directory and succeeds after exact restore", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-directory-windows-startup-"));
		temporaryDirectories.push(root);
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd);

		const firstDirectory = SessionManager.getDefaultSessionDir(cwd, agentDir);
		const firstDestination = SessionManager.managedDestination(cwd, agentDir);
		expect(firstDestination.directory).toBe(firstDirectory);
		const first = SessionManager.create(cwd, firstDestination);
		first.appendMessage({ role: "user", content: "first startup", timestamp: 0 });
		await first.ensureOnDisk();
		await first.flush();
		const firstSessionFile = first.getSessionFile();
		if (!firstSessionFile) throw new Error("Expected persisted first-session transcript");
		await first.close();

		const internal = path.join(firstDirectory, ".gjc-managed-session-internal");
		const locks = path.join(internal, "locks");
		const retainedLocks = path.join(internal, "locks.retained-for-test");
		const receipts = path.join(internal, "receipts");
		const tombstones = path.join(internal, "tombstones");
		await fs.rename(locks, retainedLocks);
		const retainedMarker = path.join(retainedLocks, "retained-marker");
		const receiptMarker = path.join(receipts, "receipt-marker");
		const tombstoneMarker = path.join(tombstones, "tombstone-marker");
		await fs.writeFile(retainedMarker, "retained-lock-state\n", { mode: 0o600 });
		await fs.writeFile(receiptMarker, "receipt-state\n", { mode: 0o600 });
		await fs.writeFile(tombstoneMarker, "tombstone-state\n", { mode: 0o600 });
		const invalidContent = "required directory replaced by a file\n";
		await fs.writeFile(locks, invalidContent, { mode: 0o600 });
		const firstSessionContent = await fs.readFile(firstSessionFile);
		const retainedLocksBefore = native.snapshotDirectoryTree(retainedLocks);
		const faultTreeBefore = native.snapshotDirectoryTree(firstDirectory);
		if (!retainedLocksBefore.ok || !retainedLocksBefore.snapshot) {
			throw new Error("Expected retained locks snapshot");
		}
		if (!faultTreeBefore.ok || !faultTreeBefore.snapshot) throw new Error("Expected managed fault snapshot");

		let failure: unknown;
		try {
			SessionManager.getDefaultSessionDir(cwd, agentDir);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(Error);
		const startupError = failure as Error;
		expect(startupError.message).toBe(
			"Could not prepare managed session scope (binding_invalid: prepare:locks_directory).",
		);
		expect(startupError.message).not.toContain(firstDirectory);
		expect(JSON.stringify(startupError.cause)).not.toContain(firstDirectory);
		expect(await fs.readFile(locks, "utf8")).toBe(invalidContent);
		const faultTreeAfter = native.snapshotDirectoryTree(firstDirectory);
		if (!faultTreeAfter.ok || !faultTreeAfter.snapshot) throw new Error("Expected post-failure managed snapshot");
		expect(durableTreeEvidence(faultTreeAfter.snapshot)).toEqual(durableTreeEvidence(faultTreeBefore.snapshot));
		expect(await fs.readFile(firstSessionFile)).toEqual(firstSessionContent);
		expect(await fs.readFile(retainedMarker, "utf8")).toBe("retained-lock-state\n");
		expect(await fs.readFile(receiptMarker, "utf8")).toBe("receipt-state\n");
		expect(await fs.readFile(tombstoneMarker, "utf8")).toBe("tombstone-state\n");

		await fs.rm(locks);
		await fs.rename(retainedLocks, locks);
		const restoredLocks = native.snapshotDirectoryTree(locks);
		if (!restoredLocks.ok || !restoredLocks.snapshot) throw new Error("Expected restored locks snapshot");
		expect(restoredLocks.snapshot.rootDev).toBe(retainedLocksBefore.snapshot.rootDev);
		expect(restoredLocks.snapshot.rootIno).toBe(retainedLocksBefore.snapshot.rootIno);
		const secondDirectory = SessionManager.getDefaultSessionDir(cwd, agentDir);
		const secondDestination = SessionManager.managedDestination(cwd, agentDir);
		expect(secondDirectory).toBe(firstDirectory);
		expect(secondDestination.directory).toBe(firstDirectory);
		expect(await fs.readFile(firstSessionFile)).toEqual(firstSessionContent);
		expect(await fs.readFile(path.join(locks, "retained-marker"), "utf8")).toBe("retained-lock-state\n");
		expect(await fs.readFile(receiptMarker, "utf8")).toBe("receipt-state\n");
		expect(await fs.readFile(tombstoneMarker, "utf8")).toBe("tombstone-state\n");
	});

	it("preserves verify-first policy through nested managed destinations", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-directory-windows-nested-"));
		temporaryDirectories.push(root);
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd);

		const destination = SessionManager.managedDestination(cwd, agentDir);
		if (destination.kind !== "managed") throw new Error("Expected managed destination");
		const source = new ManagedSessionDescendantStore(
			destination.securityContext.rootAuthority,
			destination.directory,
			undefined,
			"windows-existing-verify-first",
		);
		const nestedStore = source.deriveSubtree("nested");
		const nestedDestination = SessionManager.nestedManagedDestination(nestedStore, nestedStore.dir);
		const verifyExpected = vi.spyOn(native, "verifyOwnerOnlyPathSecurityExpected");

		const nested = SessionManager.create(cwd, nestedDestination);
		nested.appendMessage({ role: "user", content: "nested startup", timestamp: 0 });
		await nested.ensureOnDisk();
		await nested.flush();
		await nested.close();

		expect(
			verifyExpected.mock.calls.some(
				([pathname, kind]) => kind === "directory" && path.resolve(pathname) === path.resolve(nestedStore.dir),
			),
		).toBe(true);
	});

	it("surfaces a path-free native security classification for the tombstones directory", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-directory-windows-diagnostic-"));
		temporaryDirectories.push(root);
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd);

		const first = SessionManager.managedDestination(cwd, agentDir);
		const tombstones = path.join(first.directory, ".gjc-managed-session-internal", "tombstones");
		const verifyExpected = native.verifyOwnerOnlyPathSecurityExpected;
		const verify = vi
			.spyOn(native, "verifyOwnerOnlyPathSecurityExpected")
			.mockImplementation((pathname, kind, expectedDev, expectedIno) =>
				path.resolve(pathname) === path.resolve(tombstones)
					? { ok: false, code: "acl_denied", operation: "query", attribute: "access" }
					: verifyExpected(pathname, kind, expectedDev, expectedIno),
			);

		let failure: unknown;
		try {
			SessionManager.managedDestination(cwd, agentDir);
		} catch (error) {
			failure = error;
		} finally {
			verify.mockRestore();
		}

		expect(failure).toBeInstanceOf(Error);
		const startupError = failure as Error;
		expect(startupError.message).toBe(
			"Could not prepare managed session scope (acl_denied: prepare:tombstones_directory).",
		);
		expect(startupError.message).not.toContain(tombstones);
		expect(JSON.stringify(startupError.cause)).not.toContain(first.directory);
		expect(startupError.cause).toEqual({
			classification: "acl_denied",
			diagnostic: "prepare:tombstones_directory",
		});
	});
});

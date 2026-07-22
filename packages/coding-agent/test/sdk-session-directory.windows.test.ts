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

async function managedDirectories(root: string): Promise<string[]> {
	const directories = [root];
	for (const entry of await fs.readdir(root, { withFileTypes: true })) {
		if (entry.isDirectory()) directories.push(...(await managedDirectories(path.join(root, entry.name))));
	}
	return directories;
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
		expect(viaAlias).toEqual(direct);
		if (direct.kind === "resolved") {
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

	it("uses verify-first preparation for a real second session-manager startup", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-directory-windows-startup-"));
		temporaryDirectories.push(root);
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd);

		const apply = vi.spyOn(native, "applyOwnerOnlyPathSecurity");
		const verify = vi.spyOn(native, "verifyOwnerOnlyPathSecurity");
		const verifyExpected = vi.spyOn(native, "verifyOwnerOnlyPathSecurityExpected");
		const repair = vi.spyOn(native, "repairOwnerOnlyPathSecurityExpected");
		const firstDirectory = SessionManager.getDefaultSessionDir(cwd, agentDir);
		const firstDestination = SessionManager.managedDestination(cwd, agentDir);
		expect(firstDestination.directory).toBe(firstDirectory);
		const first = SessionManager.create(cwd, firstDestination);
		first.appendMessage({ role: "user", content: "first startup", timestamp: 0 });
		await first.ensureOnDisk();
		await first.flush();
		await first.close();

		const preExistingManagedDirectories = new Set(
			(await managedDirectories(path.join(agentDir, "sessions"))).map(directory => path.resolve(directory)),
		);
		const applyCallsBeforeSecondStartup = apply.mock.calls.length;
		const verifyCallsBeforeSecondStartup = verify.mock.calls.length;
		const repairCallsBeforeSecondStartup = repair.mock.calls.length;
		const verifyExpectedCallsBeforeSecondStartup = verifyExpected.mock.calls.length;
		const secondDirectory = SessionManager.getDefaultSessionDir(cwd, agentDir);
		const secondDestination = SessionManager.managedDestination(cwd, agentDir);
		expect(secondDirectory).toBe(firstDirectory);
		expect(secondDestination.directory).toBe(firstDirectory);
		const second = SessionManager.create(cwd, secondDestination);
		second.appendMessage({ role: "user", content: "second startup", timestamp: 1 });
		await second.ensureOnDisk();
		await second.flush();
		await second.close();

		const secondApplyCalls = apply.mock.calls.slice(applyCallsBeforeSecondStartup);
		const secondVerifyCalls = verify.mock.calls.slice(verifyCallsBeforeSecondStartup);
		const secondVerifyExpectedCalls = verifyExpected.mock.calls.slice(verifyExpectedCallsBeforeSecondStartup);
		expect(
			secondApplyCalls.filter(
				([pathname, kind]) => kind === "directory" && preExistingManagedDirectories.has(path.resolve(pathname)),
			),
		).toHaveLength(0);
		expect(repair.mock.calls.slice(repairCallsBeforeSecondStartup)).toHaveLength(0);
		expect(
			[...preExistingManagedDirectories].every(directory =>
				secondVerifyExpectedCalls.some(
					([pathname, kind]) => kind === "directory" && path.resolve(pathname) === directory,
				),
			),
		).toBe(true);
		expect(secondVerifyCalls.filter(([, kind]) => kind === "directory")).toHaveLength(0);
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
});

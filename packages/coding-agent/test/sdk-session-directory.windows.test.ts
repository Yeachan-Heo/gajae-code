import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveManagedSessionScope } from "../src/sdk/session-directory";
import { shouldFsyncManagedDirectory } from "../src/session/internal/managed-session-storage";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

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
});

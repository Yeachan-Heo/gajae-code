import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import {
	assertSessionFamilyWorkspaceUnchanged,
	resolveSessionFamilyWorkspace,
	sessionFamilyWorkspacesOverlap,
} from "../src/sdk/session-family-workspace";

const roots: string[] = [];

async function fixture(): Promise<string> {
	const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-family-workspace-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

test("non-Git ancestor domains overlap but lexical siblings do not", async () => {
	const root = await fixture();
	const parent = path.join(root, "workspace");
	const child = path.join(parent, "nested");
	const sibling = path.join(root, "workspace-other");
	await fs.mkdir(child, { recursive: true });
	await fs.mkdir(sibling);
	const [a, b, c] = await Promise.all([
		resolveSessionFamilyWorkspace(parent),
		resolveSessionFamilyWorkspace(child),
		resolveSessionFamilyWorkspace(sibling),
	]);
	expect(sessionFamilyWorkspacesOverlap(a, b)).toBe(true);
	expect(sessionFamilyWorkspacesOverlap(b, a)).toBe(true);
	expect(sessionFamilyWorkspacesOverlap(a, c)).toBe(false);
});

test("directory aliases resolve to the same physical ownership domain", async () => {
	const root = await fixture();
	const real = path.join(root, "real");
	const alias = path.join(root, "alias");
	await fs.mkdir(real);
	await fs.symlink(real, alias, process.platform === "win32" ? "junction" : "dir");
	const [a, b] = await Promise.all([resolveSessionFamilyWorkspace(real), resolveSessionFamilyWorkspace(alias)]);
	expect(b).toEqual(a);
	expect(sessionFamilyWorkspacesOverlap(a, b)).toBe(true);
});

test("nested Git directories share the canonical worktree rather than cwd locks", async () => {
	const root = await fixture();
	const repository = path.join(root, "프로젝트 with spaces ");
	await fs.mkdir(repository);
	await $`git -c init.templateDir= init -q ${repository}`.quiet();
	const nested = path.join(repository, "src", "nested");
	await fs.mkdir(nested, { recursive: true });
	const [a, b] = await Promise.all([resolveSessionFamilyWorkspace(repository), resolveSessionFamilyWorkspace(nested)]);
	expect(b.root).toBe(repository);
	expect(b.gitCommonDirectory).toBe(path.join(repository, ".git"));
	expect(b.device).toBe(a.device);
	expect(b.inode).toBe(a.inode);
	expect(sessionFamilyWorkspacesOverlap(a, b)).toBe(true);
});

test("separate linked Git worktrees do not falsely alias through the common Git directory", async () => {
	const root = await fixture();
	const first = path.join(root, "first");
	const second = path.join(root, "second");
	await $`git -c init.templateDir= init -q ${first}`.quiet();
	await $`git -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgSign=false -c core.hooksPath=/dev/null commit --allow-empty -qm fixture`
		.cwd(first)
		.quiet();
	await $`git -c core.hooksPath=/dev/null worktree add --detach ${second} HEAD`.cwd(first).quiet();
	const [a, b] = await Promise.all([resolveSessionFamilyWorkspace(first), resolveSessionFamilyWorkspace(second)]);
	expect(a.gitCommonDirectory).toBe(b.gitCommonDirectory);
	expect(a.root).not.toBe(b.root);
	expect(sessionFamilyWorkspacesOverlap(a, b)).toBe(false);
});

test("a broken Git binding refuses instead of falling back to a lexical cwd", async () => {
	const root = await fixture();
	await Bun.write(path.join(root, ".git"), "gitdir: ./missing\n");
	await expect(resolveSessionFamilyWorkspace(root)).rejects.toMatchObject({ code: "uncertain" });
});

test("bare Git repositories are not admitted as ordinary non-Git workspaces", async () => {
	const root = await fixture();
	const bare = path.join(root, "bare");
	await $`git -c init.templateDir= init --bare -q ${bare}`.quiet();
	await expect(resolveSessionFamilyWorkspace(bare)).rejects.toMatchObject({ code: "uncertain" });
});

test("unavailable directories refuse and retain no lexical ownership identity", async () => {
	const root = await fixture();
	await expect(resolveSessionFamilyWorkspace(path.join(root, "absent"))).rejects.toMatchObject({ code: "uncertain" });
});

test("replacement at the same path invalidates a prior workspace admission identity", async () => {
	const root = await fixture();
	const workspace = path.join(root, "workspace");
	await fs.mkdir(workspace);
	const captured = await resolveSessionFamilyWorkspace(workspace);
	await fs.rename(workspace, path.join(root, "retired"));
	await fs.mkdir(workspace);
	await expect(assertSessionFamilyWorkspaceUnchanged(captured)).rejects.toMatchObject({ code: "identity_conflict" });
});

test("creating a Git boundary invalidates an earlier non-Git workspace capture", async () => {
	const root = await fixture();
	const workspace = path.join(root, "workspace");
	await fs.mkdir(workspace);
	const captured = await resolveSessionFamilyWorkspace(workspace);
	await $`git -c init.templateDir= init -q ${workspace}`.quiet();
	await expect(assertSessionFamilyWorkspaceUnchanged(captured)).rejects.toMatchObject({ code: "identity_conflict" });
});

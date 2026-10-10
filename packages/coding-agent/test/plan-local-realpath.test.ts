import { describe, expect, it } from "bun:test";
import {
	link,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	containedLocalPlanUnlinkPath,
	LocalPlanPathError,
	resolveContainedLocalPlanPath,
} from "../src/plan-mode/contained-local-path";

async function withLocalRoot(
	run: (paths: { root: string; localRoot: string; outside: string }) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(path.join(tmpdir(), "plan-local-"));
	const localRoot = path.join(root, "artifacts", "local");
	const outside = path.join(root, "outside");
	await mkdir(localRoot, { recursive: true });
	await mkdir(outside, { recursive: true });
	try {
		await run({ root, localRoot, outside });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("resolveContainedLocalPlanPath", () => {
	it("allows an ordinary local:// plan write inside the real root", async () => {
		await withLocalRoot(async ({ localRoot, outside }) => {
			const lexical = path.join(localRoot, "PLAN.md");
			const contained = await resolveContainedLocalPlanPath(localRoot, lexical);
			expect(contained).toBe(path.join(await realpath(localRoot), "PLAN.md"));
			await writeFile(contained, "inside", { flag: "wx" });
			expect(await readFile(path.join(localRoot, "PLAN.md"), "utf8")).toBe("inside");
			expect(await readdir(outside)).toEqual([]);
		});
	});

	it("writes, links, and unlinks an ordinary plan inside the real root", async () => {
		await withLocalRoot(async ({ localRoot, outside }) => {
			const source = path.join(localRoot, "PLAN.md");
			const destination = path.join(localRoot, "Feature.md");
			await writeFile(source, "approved");
			const sourcePath = await resolveContainedLocalPlanPath(localRoot, source);
			const destinationPath = await resolveContainedLocalPlanPath(localRoot, destination);
			const temporary = await resolveContainedLocalPlanPath(localRoot, `${destinationPath}.approval-test`);
			await writeFile(temporary, "approved", { flag: "wx" });
			await link(temporary, destinationPath);
			await unlink(temporary);
			await unlink(sourcePath);
			expect(await readFile(destination, "utf8")).toBe("approved");
			await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await readdir(outside)).toEqual([]);
		});
	});

	it("refuses a symlink write, link, or unlink that leaves the real root", async () => {
		await withLocalRoot(async ({ localRoot, outside }) => {
			const secret = path.join(outside, "secret.txt");
			await writeFile(secret, "secret");
			const leak = path.join(localRoot, "PLAN.md");
			await symlink(secret, leak);
			await symlink(outside, path.join(localRoot, "dirlink"));
			await expect(resolveContainedLocalPlanPath(localRoot, leak)).rejects.toBeInstanceOf(LocalPlanPathError);
			await expect(
				resolveContainedLocalPlanPath(localRoot, path.join(localRoot, "dirlink", "new.md")),
			).rejects.toThrow("local:// plan path escapes the session local root");
			expect(await readFile(secret, "utf8")).toBe("secret");
			expect((await lstat(leak)).isSymbolicLink()).toBe(true);
			await expect(containedLocalPlanUnlinkPath(localRoot, leak)).rejects.toBeInstanceOf(LocalPlanPathError);
			expect(await readFile(secret, "utf8")).toBe("secret");
			expect((await lstat(leak)).isSymbolicLink()).toBe(true);
			expect(await readdir(outside)).toEqual(["secret.txt"]);
		});
	});

	it("unlinks an in-root source symlink and leaves its target intact", async () => {
		await withLocalRoot(async ({ localRoot }) => {
			const drafts = path.join(localRoot, "drafts");
			await mkdir(drafts);
			const target = path.join(drafts, "spec.md");
			await writeFile(target, "keep");
			const source = path.join(localRoot, "PLAN.md");
			await symlink(path.join("drafts", "spec.md"), source);
			const entry = await containedLocalPlanUnlinkPath(localRoot, source);
			const realRoot = await realpath(localRoot);
			expect(entry).toBe(path.join(realRoot, "PLAN.md"));
			expect((await lstat(entry)).isSymbolicLink()).toBe(true);
			await unlink(entry);
			expect(await readFile(target, "utf8")).toBe("keep");
			await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
			expect((await lstat(target)).isFile()).toBe(true);
		});
	});

	it("refuses a dangling symlink whose realpath fails", async () => {
		await withLocalRoot(async ({ localRoot, outside }) => {
			const dangling = path.join(localRoot, "dangling.md");
			await symlink(path.join(localRoot, "missing.md"), dangling);
			await symlink(path.join(outside, "new.txt"), path.join(localRoot, "outside-dangling.md"));
			await expect(resolveContainedLocalPlanPath(localRoot, dangling)).rejects.toBeInstanceOf(LocalPlanPathError);
			await expect(
				resolveContainedLocalPlanPath(localRoot, path.join(localRoot, "outside-dangling.md")),
			).rejects.toBeInstanceOf(LocalPlanPathError);
			await expect(lstat(path.join(localRoot, "missing.md"))).rejects.toMatchObject({ code: "ENOENT" });
			await expect(lstat(path.join(outside, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		});
	});

	it("allows a new file when the local root is reached through a symlinked ancestor", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "plan-local-ancestor-"));
		const real = path.join(root, "real");
		const link = path.join(root, "link");
		const localRoot = path.join(link, "artifacts", "local");
		await mkdir(path.join(real, "artifacts", "local"), { recursive: true });
		await symlink(real, link);
		try {
			const contained = await resolveContainedLocalPlanPath(localRoot, path.join(localRoot, "PLAN.md"));
			expect(contained).toContain(`${path.sep}real${path.sep}`);
			await writeFile(contained, "inside", { flag: "wx" });
			expect(await readFile(path.join(real, "artifacts", "local", "PLAN.md"), "utf8")).toBe("inside");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

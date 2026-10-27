import { describe, expect, it } from "bun:test";
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Skill } from "../../src/extensibility/skills";
import { expandInternalUrls } from "../../src/tools/bash-skill-urls";

function skill(name: string, baseDir: string): Skill {
	const resolved = path.resolve(baseDir);
	return {
		name,
		description: name,
		filePath: path.join(resolved, "SKILL.md"),
		baseDir: resolved,
		source: "test",
	};
}

function unquote(command: string): string {
	const quoted = command.replace(/^cat /, "");
	return quoted.slice(1, -1).replaceAll("'\\''", "'");
}

async function canonicalExistingPath(target: string): Promise<string> {
	const missing: string[] = [];
	let cursor = target;
	for (;;) {
		try {
			await lstat(cursor);
			return path.join(await realpath(cursor), ...missing);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const parent = path.dirname(cursor);
		if (parent === cursor) return target;
		missing.unshift(path.basename(cursor));
		cursor = parent;
	}
}

async function expectInside(command: string, baseDir: string, fileName: string): Promise<void> {
	const expanded = await expandInternalUrls(command, { skills: [skill("demo", baseDir)] });
	const returned = unquote(expanded);
	const realBase = await realpath(baseDir);
	const canonical = await canonicalExistingPath(returned);
	expect(canonical === realBase || canonical.startsWith(`${realBase}${path.sep}`)).toBe(true);
	expect(canonical.endsWith(`${path.sep}${fileName}`)).toBe(true);
}

describe("expandInternalUrls skill://", () => {
	it("rejects a skill:// symlink that leaves the skill directory", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "skill-bash-"));
		const dir = path.join(root, "skill");
		const outside = path.join(root, "secret.txt");
		await mkdir(dir);
		await writeFile(outside, "secret");
		await symlink(outside, path.join(dir, "leak.txt"));
		await expect(expandInternalUrls("cat skill://demo/leak.txt", { skills: [skill("demo", dir)] })).rejects.toThrow(
			"Path traversal is not allowed in skill:// URLs",
		);
		await rm(root, { recursive: true, force: true });
	});

	it("rejects a new file under a skill directory symlink and a dangling symlink", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "skill-bash-"));
		const dir = path.join(root, "skill");
		const outside = path.join(root, "outside");
		await mkdir(dir);
		await mkdir(outside);
		await symlink(path.join(outside, "new.txt"), path.join(dir, "dangling.txt"));
		await symlink(outside, path.join(dir, "dirlink"));
		const skills = [skill("demo", dir)];
		await expect(expandInternalUrls("cat skill://demo/dangling.txt", { skills })).rejects.toThrow(
			"Path traversal is not allowed in skill:// URLs",
		);
		await expect(expandInternalUrls("cat skill://demo/dirlink/new.txt", { skills })).rejects.toThrow(
			"Path traversal is not allowed in skill:// URLs",
		);
		await expect(Bun.file(path.join(outside, "new.txt")).exists()).resolves.toBe(false);
		await rm(root, { recursive: true, force: true });
	});

	it("allows a file that stays inside the skill directory", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "skill-bash-"));
		const dir = path.join(root, "skill");
		await mkdir(dir);
		await writeFile(path.join(dir, "note.txt"), "ok");
		await symlink(path.join(dir, "note.txt"), path.join(dir, "alias.txt"));
		await expectInside("cat skill://demo/note.txt", dir, "note.txt");
		await expectInside("cat skill://demo/alias.txt", dir, "note.txt");
		await rm(root, { recursive: true, force: true });
	});

	it("keeps an in-root symlink within the skill named by the URL when roots are nested", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "skill-bash-"));
		const outerDir = path.join(root, "outer");
		const innerDir = path.join(outerDir, "inner");
		await mkdir(innerDir, { recursive: true });
		const note = path.join(outerDir, "note.txt");
		await writeFile(note, "ok");
		await symlink(note, path.join(innerDir, "alias.txt"));
		const skills = [skill("outer", outerDir), skill("inner", innerDir)];

		const expanded = await expandInternalUrls("cat skill://outer/inner/alias.txt", { skills });
		expect(unquote(expanded)).toBe(await realpath(note));
		await rm(root, { recursive: true, force: true });
	});

	it("allows a missing file inside the skill directory", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "skill-bash-"));
		const dir = path.join(root, "skill");
		await mkdir(dir);
		await expectInside("cat skill://demo/fresh.txt", dir, "fresh.txt");
		await rm(root, { recursive: true, force: true });
	});

	it("allows a skill reached through a symlinked ancestor", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "skill-bash-"));
		const realDir = path.join(root, "real");
		const link = path.join(root, "link");
		await mkdir(realDir);
		await symlink(realDir, link);
		await writeFile(path.join(realDir, "note.txt"), "ok");
		await expectInside("cat skill://demo/note.txt", link, "note.txt");
		await expectInside("cat skill://demo/fresh.txt", link, "fresh.txt");
		await rm(root, { recursive: true, force: true });
	});
});

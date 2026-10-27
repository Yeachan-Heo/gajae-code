import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { realSkillPath } from "../src/internal-urls/skill-path";

describe("realSkillPath", () => {
	it("rejects a symlink that leaves the skill directory", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "skill-url-"));
		const skillDir = path.join(root, "skill");
		const outside = path.join(root, "secret.txt");
		await mkdir(skillDir);
		await writeFile(outside, "secret");
		await symlink(outside, path.join(skillDir, "leak.txt"));
		await expect(realSkillPath(skillDir, path.join(skillDir, "leak.txt"))).rejects.toThrow(/Path traversal/);
		await expect(realSkillPath(skillDir, path.join(skillDir, "note.txt"))).rejects.toThrow("File not found");
		await symlink(path.join(root, "gone.txt"), path.join(skillDir, "dangling.txt"));
		await expect(realSkillPath(skillDir, path.join(skillDir, "dangling.txt"))).rejects.toThrow("File not found");
		await writeFile(path.join(skillDir, "note.txt"), "ok");
		const inside = await realSkillPath(skillDir, path.join(skillDir, "note.txt"));
		expect(inside.endsWith(`${path.sep}note.txt`)).toBe(true);
	});
});

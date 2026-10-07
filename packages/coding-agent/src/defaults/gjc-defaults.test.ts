import { describe, expect, test } from "bun:test";
import { BundledDefaultContentError, readBundledContentSync } from "./gjc-defaults";
import { BUNDLED_GJC_SKILL_CATALOG, type BundledGjcSkillCatalogEntry } from "./gjc-skills.generated";

describe("bundled default content", () => {
	test("unreadable source throws a typed contextual error", () => {
		const entry = {
			kind: "skill",
			name: "deep-interview",
			relativePath: "skills/does-not-exist/SKILL.md",
			loadContent: async () => "",
		} as BundledGjcSkillCatalogEntry;

		expect(() => readBundledContentSync(entry)).toThrow(BundledDefaultContentError);
		try {
			readBundledContentSync(entry);
		} catch (error) {
			expect(error).toBeInstanceOf(BundledDefaultContentError);
			expect((error as BundledDefaultContentError).sourcePath).toContain("does-not-exist/SKILL.md");
			expect((error as Error).message).toContain("Unable to read bundled GJC definition");
		}
	});

	test("every catalog entry carries an embedded source path that matches its lazy import", async () => {
		for (const entry of BUNDLED_GJC_SKILL_CATALOG) {
			expect(entry.sourcePath, entry.relativePath).toBeString();
			expect(readBundledContentSync(entry)).toBe(await entry.loadContent());
		}
	});

	test("sync reads use the embedded source path, not import.meta.dir (compiled binaries, #6421)", () => {
		const autoresearch = BUNDLED_GJC_SKILL_CATALOG.find(entry => entry.name === "autoresearch")!;
		const entry = {
			...autoresearch,
			relativePath: "skills/not-laid-out-under-import-meta-dir/SKILL.md",
		} as BundledGjcSkillCatalogEntry;

		expect(readBundledContentSync(entry)).toContain("name: autoresearch");
	});
});

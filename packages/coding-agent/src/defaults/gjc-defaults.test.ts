import { describe, expect, test } from "bun:test";
import { BundledDefaultContentError, readBundledContentSync } from "./gjc-defaults";
import type { BundledGjcSkillCatalogEntry } from "./gjc-skills.generated";

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
});

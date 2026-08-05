import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { getEmbeddedDefaultGjcSkills } from "../defaults/gjc-defaults";
import { buildSkillPromptMessage } from "../extensibility/skills";
import { scanSkillDescriptorsFromDir, SKILL_FRONTMATTER_SCAN_BYTES, SKILL_FRONTMATTER_SCAN_TOTAL_BYTES } from "./index";

function makeContext(): any {
	return { cwd: process.cwd(), home: process.env.HOME ?? process.cwd(), repoRoot: null };
}

describe("skill descriptors", () => {
	test("frontmatter scanning is bounded and does not read the body", async () => {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-skill-descriptor-"));
		try {
			const skillDir = path.join(root, "bounded");
			await fs.mkdir(skillDir, { recursive: true });
			const bodyMarker = "BODY_MARKER_MUST_NOT_BE_SCANNED";
			const body = "x".repeat(SKILL_FRONTMATTER_SCAN_BYTES) + bodyMarker;
			await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\nname: bounded\ndescription: bounded scan\n---\n${body}`);

			const originalFile = Bun.file;
			const sliceEnds: number[] = [];
			(Bun as any).file = (filePath: string) => {
				const file = originalFile(filePath);
				return new Proxy(file, {
					get(target, property, receiver) {
						if (property !== "slice") return Reflect.get(target, property, receiver);
						return (start?: number, end?: number) => {
							sliceEnds.push(end ?? -1);
							return target.slice(start, end);
						};
					},
				});
			};
			try {
				const result = await scanSkillDescriptorsFromDir(makeContext(), {
					dir: root,
					providerId: "test",
					level: "project",
				});
				expect(result.items).toHaveLength(1);
				expect(Object.hasOwn(result.items[0]?.metadata ?? {}, "content")).toBe(false);
				expect(JSON.stringify(result.items[0]?.metadata)).not.toContain(bodyMarker);
				expect(sliceEnds).toContain(SKILL_FRONTMATTER_SCAN_BYTES);
			} finally {
				(Bun as any).file = originalFile;
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("unterminated frontmatter stops at the total scan cap", async () => {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-skill-unterminated-"));
		try {
			const skillDir = path.join(root, "unterminated");
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(
				path.join(skillDir, "SKILL.md"),
				`---\nname: unterminated\ndescription: no closing delimiter\n${"x".repeat(SKILL_FRONTMATTER_SCAN_TOTAL_BYTES * 32)}`,
			);
			const result = await scanSkillDescriptorsFromDir(makeContext(), {
				dir: root,
				providerId: "test",
				level: "project",
			});
			expect(result.items).toHaveLength(0);
			expect((result.warnings ?? []).some(warning => warning.includes("scan cap"))).toBe(true);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	test("bundled skill prompt injection is byte-identical through the lazy catalog", async () => {
		const embedded = getEmbeddedDefaultGjcSkills().find(skill => skill.name === "ralplan");
		if (!embedded) throw new Error("ralplan bundled skill missing");
		const legacyContent = embedded.content;
		const legacy = await buildSkillPromptMessage(
			{ ...embedded, content: legacyContent, loadContent: undefined },
			"example task",
		);
		const lazy = await buildSkillPromptMessage({ ...embedded, content: undefined }, "example task");
		expect(lazy.message).toBe(legacy.message);
		expect(lazy.details).toEqual(legacy.details);
	});
});

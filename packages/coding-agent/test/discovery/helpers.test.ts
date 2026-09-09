import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "@gajae-code/utils";
import {
	getAncestorDirs,
	getUserSkillScanDirs,
	readContainedFile,
	resolveUserAgentDir,
	SkillDiscoveryTestHooks,
	SOURCE_PATHS,
	scanSkillsFromDir,
} from "../../src/discovery/helpers";

describe("parseFrontmatter", () => {
	const parse = (content: string) => parseFrontmatter(content, { source: "tests:frontmatter", level: "off" });

	test("parses simple key-value pairs", () => {
		const content = `---
name: test
enabled: true
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({ name: "test", enabled: true });
		expect(result.body).toBe("Body content");
	});

	test("parses YAML list syntax", () => {
		const content = `---
tags:
  - javascript
  - typescript
  - react
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({
			tags: ["javascript", "typescript", "react"],
		});
		expect(result.body).toBe("Body content");
	});

	test("parses multi-line string values", () => {
		const content = `---
description: |
  This is a multi-line
  description block
  with several lines
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({
			description: "This is a multi-line\ndescription block\nwith several lines\n",
		});
		expect(result.body).toBe("Body content");
	});

	test("parses nested objects", () => {
		const content = `---
config:
  server:
    port: 3000
    host: localhost
  database:
    name: mydb
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({
			config: {
				server: { port: 3000, host: "localhost" },
				database: { name: "mydb" },
			},
		});
		expect(result.body).toBe("Body content");
	});

	test("parses mixed complex YAML", () => {
		const content = `---
name: complex-test
version: 1.0.0
tags:
  - prod
  - critical
metadata:
  author: tester
  created: 2024-01-01
description: |
  Multi-line description
  with formatting
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({
			name: "complex-test",
			version: "1.0.0",
			tags: ["prod", "critical"],
			metadata: {
				author: "tester",
				created: "2024-01-01",
			},
			description: "Multi-line description\nwith formatting\n",
		});
		expect(result.body).toBe("Body content");
	});

	test("parses Cursor-style scalar values with trailing commas", () => {
		const content = `---
alwaysApply: true
name: "tanstack-query-and-data-fetching",
description: "Next.js + Clerk + Supabase + GPT API + Vercel 환경에서 tanstack-query 사용 규칙",
---
Body content`;

		const result = parseFrontmatter(content, { source: "tests:frontmatter", level: "fatal" });
		expect(result.frontmatter).toEqual({
			alwaysApply: true,
			name: "tanstack-query-and-data-fetching",
			description: "Next.js + Clerk + Supabase + GPT API + Vercel 환경에서 tanstack-query 사용 규칙",
		});
		expect(result.body).toBe("Body content");
	});

	test("does not coerce malformed flow collections with trailing commas", () => {
		const content = `---
items: [one, two,
---
Body content`;

		expect(() => parseFrontmatter(content, { source: "tests:frontmatter", level: "fatal" })).toThrow(
			/Failed to parse YAML frontmatter/,
		);
	});

	test("does not coerce malformed block scalars with trailing commas", () => {
		const content = `---
description: |,
  Body text
---
Body content`;

		expect(() => parseFrontmatter(content, { source: "tests:frontmatter", level: "fatal" })).toThrow(
			/Failed to parse YAML frontmatter/,
		);
	});
	test("rejects top-level YAML arrays instead of coercing numeric keys", () => {
		const content = `---
- one
- two
---
Body content`;

		expect(() => parseFrontmatter(content, { source: "tests:frontmatter", level: "fatal" })).toThrow(
			/Failed to parse YAML frontmatter.*root must be an object/s,
		);
	});

	test("rejects scalar YAML roots instead of accepting empty metadata", () => {
		const content = `---
true
---
Body content`;

		expect(() => parseFrontmatter(content, { source: "tests:frontmatter", level: "fatal" })).toThrow(
			/Failed to parse YAML frontmatter.*root must be an object/s,
		);
	});

	test("handles missing frontmatter", () => {
		const content = "Just body content";
		const result = parse(content);
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe("Just body content");
	});

	test("handles invalid YAML in frontmatter", () => {
		const content = `---
invalid: [unclosed array
---
Body content`;

		const result = parse(content);
		// Simple fallback parser extracts key:value pairs it can parse
		expect(result.frontmatter).toEqual({ invalid: "[unclosed array" });
		// Body is still extracted even with invalid YAML
		expect(result.body).toBe("Body content");
	});

	test("handles empty frontmatter", () => {
		const content = `---
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe("Body content");
	});

	test("normalizes kebab-case keys to camelCase", () => {
		const content = `---
thinking-level: medium
output-schema: json
nested-field:
  inner-key: value
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({
			thinkingLevel: "medium",
			outputSchema: "json",
			nestedField: { innerKey: "value" },
		});
		expect(result.body).toBe("Body content");
	});

	test("does not treat a dashed banner as frontmatter and preserve the body", () => {
		const content = "----\nhello\n----\nworld";
		const result = parse(content);
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe(content);
	});

	test("does not treat a '--- text' heading line as a frontmatter opener", () => {
		const content = "--- not frontmatter\nkeep me\n--- also text\nand me";
		const result = parse(content);
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe(content);
	});

	test("keeps a markdown '---' horizontal rule inside the body", () => {
		const content = "---\ntitle: post\n---\nfirst\n\n---\n\nsecond";
		const result = parse(content);
		expect(result.frontmatter).toEqual({ title: "post" });
		expect(result.body).toBe("first\n\n---\n\nsecond");
	});

	test("closes frontmatter at a delimiter with no trailing newline", () => {
		const content = "---\nname: x\n---";
		const result = parse(content);
		expect(result.frontmatter).toEqual({ name: "x" });
		expect(result.body).toBe("");
	});

	test("parses a BOM-prefixed frontmatter document", () => {
		const result = parse("\uFEFF---\nname: x\n---\nbody");
		expect(result.frontmatter).toEqual({ name: "x" });
		expect(result.body).toBe("body");
	});

	test("strips a leading BOM from a document without frontmatter", () => {
		const result = parse("\uFEFFhello\nworld");
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe("hello\nworld");
	});

	test("parses frontmatter with CRLF line endings", () => {
		const result = parse("---\r\nname: x\r\n---\r\nbody");
		expect(result.frontmatter).toEqual({ name: "x" });
		expect(result.body).toBe("body");
	});

	test("accepts an opener with trailing whitespace but rejects a leading-indented one", () => {
		expect(parse("--- \t\nname: x\n---\nbody").frontmatter).toEqual({ name: "x" });
		const indented = "  ---\nname: x\n---\nbody";
		expect(parse(indented).frontmatter).toEqual({});
		expect(parse(indented).body).toBe(indented);
	});

	test("passes through a document whose opener has no closing delimiter", () => {
		const content = "---\nname: x\nbody with no closer";
		const result = parse(content);
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe(content);
	});

	test("preserves a raw leading BOM when normalization is disabled", () => {
		const content = "\uFEFF---\nname: x\n---\nbody";
		const result = parseFrontmatter(content, { source: "tests:frontmatter", level: "off", normalize: false });
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe(content);
	});
});

describe("safe discovery boundaries", () => {
	test("excludes normalized home from an ancestor walk even when home is the repo root", () => {
		const home = path.resolve(path.join(os.tmpdir(), "gjc-home-repo"));
		const cwd = path.join(home, "workspace");
		expect(getAncestorDirs(cwd, home, home)).toEqual([{ dir: cwd, depth: 0 }]);
	});

	test("loads in-root skill symlinks but rejects directory and file symlinks outside the scan root", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-safe-skill-scan-"));
		try {
			const skillsDir = path.join(root, "skills");
			const outsideDir = path.join(root, "outside");
			const insideDir = path.join(skillsDir, "inside-target");
			await fs.mkdir(insideDir, { recursive: true });
			await fs.mkdir(outsideDir);
			const content = "---\nname: safe\ndescription: safe skill\n---\n\n# safe\n";
			await fs.writeFile(path.join(insideDir, "SKILL.md"), content);
			await fs.writeFile(path.join(outsideDir, "SKILL.md"), content.replaceAll("safe", "outside"));
			await fs.symlink(insideDir, path.join(skillsDir, "inside-alias"), "dir");
			await fs.symlink(outsideDir, path.join(skillsDir, "outside-dir"), "dir");
			const outsideFileDir = path.join(skillsDir, "outside-file");
			await fs.mkdir(outsideFileDir);
			await fs.symlink(path.join(outsideDir, "SKILL.md"), path.join(outsideFileDir, "SKILL.md"), "file");
			const hardLinkDir = path.join(skillsDir, "outside-hard-link");
			await fs.mkdir(hardLinkDir);
			await fs.link(path.join(outsideDir, "SKILL.md"), path.join(hardLinkDir, "SKILL.md"));

			const result = await scanSkillsFromDir(
				{ cwd: root, home: root, repoRoot: root },
				{ dir: skillsDir, providerId: "test", level: "user", requireDescription: true },
			);

			expect(result.items.map(skill => skill.name)).toEqual(["safe", "safe"]);
			expect(result.warnings).toEqual(
				expect.arrayContaining([expect.stringContaining("Refusing skill path outside scan root")]),
			);

			const directSkill = result.items.find(skill => skill.path === path.join(insideDir, "SKILL.md"));
			expect(directSkill).toBeDefined();
			const loadContent = directSkill?.loadContent;
			expect(loadContent).toBeDefined();
			await fs.rm(path.join(insideDir, "SKILL.md"));
			await fs.symlink(path.join(outsideDir, "SKILL.md"), path.join(insideDir, "SKILL.md"), "file");
			await expect(loadContent!()).rejects.toThrow();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("rejects a selected agent-directory authority root that is itself a symlink", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-agent-root-symlink-"));
		try {
			const outside = path.join(root, "outside");
			const agentDir = path.join(root, "agent");
			const skillDir = path.join(outside, "skills", "leak");
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: leak\ndescription: outside\n---\n");
			await fs.symlink(outside, agentDir, "dir");

			const result = await scanSkillsFromDir(
				{ cwd: root, home: root, repoRoot: root },
				{
					dir: path.join(agentDir, "skills"),
					authorityRoot: agentDir,
					providerId: "test",
					level: "user",
					requireDescription: true,
				},
			);

			expect(result.items).toEqual([]);
			expect(result.warnings).toEqual([expect.stringContaining("Refusing unsafe skill authority root")]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("rejects a selected authority root replaced after validation", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-agent-root-swap-"));
		try {
			const agentDir = path.join(root, "agent");
			const movedAgentDir = path.join(root, "moved-agent");
			const outside = path.join(root, "outside");
			await fs.mkdir(path.join(agentDir, "skills"), { recursive: true });
			await fs.mkdir(path.join(outside, "skills", "escaped"), { recursive: true });
			await fs.writeFile(
				path.join(outside, "skills", "escaped", "SKILL.md"),
				"---\nname: escaped\ndescription: outside authority\n---\n",
			);
			SkillDiscoveryTestHooks.afterAuthorityRootValidated = async validatedRoot => {
				if (validatedRoot !== agentDir) return;
				delete SkillDiscoveryTestHooks.afterAuthorityRootValidated;
				await fs.rename(agentDir, movedAgentDir);
				await fs.symlink(outside, agentDir, "dir");
			};

			const result = await scanSkillsFromDir(
				{ cwd: root, home: root, repoRoot: root },
				{
					dir: path.join(agentDir, "skills"),
					authorityRoot: agentDir,
					providerId: "test",
					level: "user",
					requireDescription: true,
				},
			);

			expect(result.items).toEqual([]);
			expect(result.warnings).toEqual([expect.stringContaining("changed skill authority root")]);
		} finally {
			delete SkillDiscoveryTestHooks.afterAuthorityRootValidated;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("does not admit an authority root created after it was observed missing", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-agent-root-missing-"));
		try {
			const agentDir = path.join(root, "selected-agent");
			const outside = path.join(root, "outside");
			await fs.mkdir(path.join(outside, "skills", "escaped"), { recursive: true });
			await fs.writeFile(
				path.join(outside, "skills", "escaped", "SKILL.md"),
				"---\nname: escaped\ndescription: outside authority\n---\n",
			);
			SkillDiscoveryTestHooks.afterAuthorityRootMissing = async missingRoot => {
				if (missingRoot !== agentDir) return;
				delete SkillDiscoveryTestHooks.afterAuthorityRootMissing;
				await fs.symlink(outside, agentDir, "dir");
			};

			const result = await scanSkillsFromDir(
				{ cwd: root, home: root, repoRoot: root },
				{
					dir: path.join(agentDir, "skills"),
					authorityRoot: agentDir,
					providerId: "test",
					level: "user",
					requireDescription: true,
				},
			);

			expect(result).toEqual({ items: [], warnings: [] });
		} finally {
			delete SkillDiscoveryTestHooks.afterAuthorityRootMissing;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("rejects a contained-file root replaced after validation", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-contained-root-swap-"));
		try {
			const agentDir = path.join(root, "agent");
			const movedAgentDir = path.join(root, "moved-agent");
			const outside = path.join(root, "outside");
			await fs.mkdir(agentDir);
			await fs.mkdir(outside);
			await fs.writeFile(path.join(agentDir, "SYSTEM.md"), "inside authority");
			await fs.writeFile(path.join(outside, "SYSTEM.md"), "outside authority");
			SkillDiscoveryTestHooks.afterContainedRootValidated = async validatedRoot => {
				if (validatedRoot !== agentDir) return;
				delete SkillDiscoveryTestHooks.afterContainedRootValidated;
				await fs.rename(agentDir, movedAgentDir);
				await fs.symlink(outside, agentDir, "dir");
			};

			expect(await readContainedFile(agentDir, path.join(agentDir, "SYSTEM.md"))).toBeNull();
		} finally {
			delete SkillDiscoveryTestHooks.afterContainedRootValidated;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("follows a symlinked root and an in-root leaf symlink", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-contained-symlinks-"));
		try {
			const realAgentDir = path.join(root, "real-agent");
			const linkedAgentDir = path.join(root, "agent");
			const target = path.join(realAgentDir, "SYSTEM.target.md");
			await fs.mkdir(realAgentDir, { recursive: true });
			await fs.writeFile(target, "linked instructions");
			await fs.symlink(realAgentDir, linkedAgentDir, "dir");
			await fs.symlink(target, path.join(linkedAgentDir, "SYSTEM.md"), "file");

			expect(await readContainedFile(linkedAgentDir, path.join(linkedAgentDir, "SYSTEM.md"))).toBe(
				"linked instructions",
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("rejects a preauthorized root replaced before the contained read", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-contained-authority-swap-"));
		try {
			const agentDir = path.join(root, "agent");
			const replacement = path.join(root, "replacement");
			await fs.mkdir(agentDir, { recursive: true });
			await fs.mkdir(replacement, { recursive: true });
			await fs.writeFile(path.join(agentDir, "SYSTEM.md"), "authorized");
			await fs.writeFile(path.join(replacement, "SYSTEM.md"), "replacement");
			const identity = await fs.stat(agentDir);
			await fs.rm(agentDir, { recursive: true });
			await fs.symlink(replacement, agentDir, "dir");

			expect(
				await readContainedFile(agentDir, path.join(agentDir, "SYSTEM.md"), {
					dev: identity.dev,
					ino: identity.ino,
				}),
			).toBeNull();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("rejects a parent swap before frontmatter bytes are read", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-frontmatter-swap-"));
		try {
			const skillsDir = path.join(root, "skills");
			const originalDir = path.join(skillsDir, "victim");
			const movedDir = path.join(root, "moved-victim");
			const outsideDir = path.join(root, "outside-victim");
			await fs.mkdir(originalDir, { recursive: true });
			await fs.mkdir(outsideDir);
			await fs.writeFile(
				path.join(originalDir, "SKILL.md"),
				"---\nname: inside\ndescription: inside authority\n---\n",
			);
			await fs.writeFile(
				path.join(outsideDir, "SKILL.md"),
				"---\nname: escaped\ndescription: outside authority\n---\n",
			);
			SkillDiscoveryTestHooks.afterCandidateValidated = async candidatePath => {
				if (candidatePath !== path.join(originalDir, "SKILL.md")) return;
				delete SkillDiscoveryTestHooks.afterCandidateValidated;
				await fs.rename(originalDir, movedDir);
				await fs.symlink(outsideDir, originalDir, "dir");
			};

			const result = await scanSkillsFromDir(
				{ cwd: root, home: root, repoRoot: root },
				{ dir: skillsDir, providerId: "test", level: "user", requireDescription: true },
			);

			expect(result.items).toEqual([]);
			expect(result.warnings).toEqual([expect.stringContaining("Failed to read skill file")]);
		} finally {
			delete SkillDiscoveryTestHooks.afterCandidateValidated;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("loads a project skills root symlink contained by the repository", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-skill-link-"));
		try {
			const target = path.join(root, ".agents", "skills", "demo");
			const scanRoot = path.join(root, ".gjc", "skills");
			await fs.mkdir(target, { recursive: true });
			await fs.mkdir(path.dirname(scanRoot), { recursive: true });
			await fs.writeFile(path.join(target, "SKILL.md"), "---\nname: demo\ndescription: linked\n---\nbody");
			await fs.symlink(path.relative(path.dirname(scanRoot), path.join(root, ".agents", "skills")), scanRoot, "dir");

			const result = await scanSkillsFromDir(
				{ cwd: root, home: root, repoRoot: root },
				{
					dir: scanRoot,
					linkContainmentRoot: root,
					providerId: "test",
					level: "project",
					scope: "project",
					requireDescription: true,
				},
			);
			expect(result.items.map(item => item.name)).toEqual(["demo"]);
			const loadContent = result.items[0].loadContent;
			if (!loadContent) throw new Error("Expected deferred project skill body loader.");
			await expect(loadContent()).resolves.toBe("body");
			await fs.rename(path.join(root, ".agents", "skills"), path.join(root, ".agents", "skills-moved"));
			await fs.mkdir(path.join(root, ".agents", "skills"), { recursive: true });
			await expect(loadContent()).rejects.toThrow();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("keeps absent project skill roots silent", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-missing-skills-"));
		try {
			const result = await scanSkillsFromDir(
				{ cwd: root, home: root, repoRoot: root },
				{
					dir: path.join(root, ".gjc", "skills"),
					linkContainmentRoot: root,
					providerId: "test",
					level: "project",
				},
			);
			expect(result.items).toEqual([]);
			expect(result.warnings).toEqual([]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("rejects project skill root links outside or missing their target", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-skill-link-invalid-"));
		try {
			const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-skill-outside-"));
			const scanRoot = path.join(root, ".gjc", "skills");
			await fs.mkdir(path.dirname(scanRoot), { recursive: true });
			await fs.symlink(outside, scanRoot, "dir");
			const outsideResult = await scanSkillsFromDir(
				{ cwd: root, home: root, repoRoot: root },
				{ dir: scanRoot, linkContainmentRoot: root, providerId: "test", level: "project", scope: "project" },
			);
			expect(outsideResult.items).toEqual([]);
			await fs.rm(scanRoot);
			await fs.symlink(path.join(root, "missing"), scanRoot, "dir");
			const danglingResult = await scanSkillsFromDir(
				{ cwd: root, home: root, repoRoot: root },
				{ dir: scanRoot, linkContainmentRoot: root, providerId: "test", level: "project", scope: "project" },
			);
			expect(danglingResult.items).toEqual([]);
			expect(danglingResult.warnings).toEqual(
				expect.arrayContaining([expect.stringContaining("Failed to read skills directory")]),
			);
			await fs.rm(outside, { recursive: true, force: true });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("loads ordinary project skills through a symlinked repository alias", async () => {
		const actual = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-repo-actual-"));
		const alias = `${actual}-alias`;
		const replacement = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-repo-replacement-"));
		try {
			const actualSkills = path.join(actual, ".gjc", "skills", "demo");
			await fs.mkdir(actualSkills, { recursive: true });
			await fs.writeFile(path.join(actualSkills, "SKILL.md"), "---\nname: demo\ndescription: alias\n---\nbody");
			await fs.mkdir(path.join(replacement, ".gjc", "skills"), { recursive: true });
			await fs.symlink(actual, alias, "dir");
			const scanRoot = path.join(alias, ".gjc", "skills");
			const result = await scanSkillsFromDir(
				{ cwd: alias, home: alias, repoRoot: alias },
				{ dir: scanRoot, linkContainmentRoot: alias, providerId: "test", level: "project", scope: "project" },
			);
			expect(result.items.map(item => item.name)).toEqual(["demo"]);
			await fs.rm(alias);
			await fs.symlink(replacement, alias, "dir");
			const loadContent = result.items[0].loadContent;
			if (!loadContent) throw new Error("Expected deferred project skill body loader.");
			await expect(loadContent()).rejects.toThrow();
		} finally {
			await fs.rm(alias, { recursive: true, force: true });
			await fs.rm(actual, { recursive: true, force: true });
			await fs.rm(replacement, { recursive: true, force: true });
		}
	});

	test("rejects a project scan root escaping through a parent symlink", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-parent-link-"));
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-parent-outside-"));
		try {
			const scanRoot = path.join(root, ".gjc", "skills");
			await fs.mkdir(outside, { recursive: true });
			await fs.mkdir(path.join(outside, "skills", "outside"), { recursive: true });
			await fs.writeFile(
				path.join(outside, "skills", "outside", "SKILL.md"),
				"---\nname: outside\ndescription: outside\n---\n",
			);
			await fs.symlink(outside, path.join(root, ".gjc"), "dir");
			const result = await scanSkillsFromDir(
				{ cwd: root, home: root, repoRoot: root },
				{ dir: scanRoot, linkContainmentRoot: root, providerId: "test", level: "project", scope: "project" },
			);
			expect(result.items).toEqual([]);
			expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining("outside repository root")]));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	test("does not enable repository link roots for user or disabled project scope", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-skill-link-scope-"));
		try {
			const target = path.join(root, "target");
			const scanRoot = path.join(root, "scan");
			await fs.mkdir(path.join(target, "blocked"), { recursive: true });
			await fs.writeFile(
				path.join(target, "blocked", "SKILL.md"),
				"---\nname: blocked\ndescription: blocked\n---\n",
			);
			await fs.symlink(target, scanRoot, "dir");
			const disabled = await scanSkillsFromDir(
				{ cwd: root, home: root, repoRoot: root },
				{ dir: scanRoot, providerId: "test", level: "project", scope: "project" },
			);
			expect(disabled.items).toEqual([]);
			for (const options of [
				{ level: "user" as const, scope: "user" as const },
				{ level: "project" as const, scope: "native" as const },
			]) {
				const result = await scanSkillsFromDir(
					{ cwd: root, home: root, repoRoot: root },
					{ ...options, dir: scanRoot, linkContainmentRoot: root, providerId: "test" },
				);
				expect(result.items).toEqual([]);
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("rejects a project scan root replaced after validation and during deferred load", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-skill-link-swap-"));
		try {
			const target = path.join(root, "target");
			const replacement = path.join(root, "replacement");
			const scanRoot = path.join(root, ".gjc", "skills");
			await fs.mkdir(path.join(target, "demo"), { recursive: true });
			await fs.mkdir(path.dirname(scanRoot), { recursive: true });
			await fs.mkdir(replacement, { recursive: true });
			await fs.writeFile(path.join(target, "demo", "SKILL.md"), "---\nname: demo\ndescription: linked\n---\nbody");
			await fs.symlink(path.relative(path.dirname(scanRoot), target), scanRoot, "dir");
			SkillDiscoveryTestHooks.afterScanRootValidated = async validatedRoot => {
				if (validatedRoot !== scanRoot) return;
				delete SkillDiscoveryTestHooks.afterScanRootValidated;
				await fs.rm(scanRoot);
				await fs.symlink(replacement, scanRoot, "dir");
			};
			const result = await scanSkillsFromDir(
				{ cwd: root, home: root, repoRoot: root },
				{ dir: scanRoot, linkContainmentRoot: root, providerId: "test", level: "project", scope: "project" },
			);
			expect(result.items).toEqual([]);
		} finally {
			delete SkillDiscoveryTestHooks.afterScanRootValidated;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("rejects a project scan root link replacement after scan", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-skill-link-postscan-"));
		try {
			const target = path.join(root, "target");
			const replacement = path.join(root, "replacement");
			const scanRoot = path.join(root, ".gjc", "skills");
			await fs.mkdir(path.join(target, "demo"), { recursive: true });
			await fs.mkdir(replacement, { recursive: true });
			await fs.mkdir(path.dirname(scanRoot), { recursive: true });
			await fs.writeFile(path.join(target, "demo", "SKILL.md"), "---\nname: demo\ndescription: linked\n---\nbody");
			await fs.symlink(path.relative(path.dirname(scanRoot), target), scanRoot, "dir");
			const result = await scanSkillsFromDir(
				{ cwd: root, home: root, repoRoot: root },
				{ dir: scanRoot, linkContainmentRoot: root, providerId: "test", level: "project", scope: "project" },
			);
			await fs.rm(scanRoot);
			await fs.symlink(replacement, scanRoot, "dir");
			const loadContent = result.items[0].loadContent;
			if (!loadContent) throw new Error("Expected deferred project skill body loader.");
			await expect(loadContent()).rejects.toThrow();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("retains isolated project scan-root link identity for deferred loads", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-isolated-link-"));
		try {
			const target = path.join(root, ".agents", "skills");
			const replacement = path.join(root, "replacement");
			const scanRoot = path.join(root, ".gjc", "skills");
			await fs.mkdir(path.join(target, "demo"), { recursive: true });
			await fs.mkdir(replacement, { recursive: true });
			await fs.mkdir(path.dirname(scanRoot), { recursive: true });
			await fs.writeFile(path.join(target, "demo", "SKILL.md"), "---\nname: demo\ndescription: linked\n---\nbody");
			await fs.symlink(path.relative(path.dirname(scanRoot), target), scanRoot, "dir");
			const result = await scanSkillsFromDir(
				{ cwd: root, home: root, repoRoot: root, isolatedHome: true },
				{ dir: scanRoot, linkContainmentRoot: root, providerId: "test", level: "project", scope: "project" },
			);
			expect(result.items).toHaveLength(1);
			await fs.rm(scanRoot);
			await fs.symlink(replacement, scanRoot, "dir");
			const loadContent = result.items[0].loadContent;
			if (!loadContent) throw new Error("Expected deferred project skill body loader.");
			await expect(loadContent()).rejects.toThrow();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("rejects hardlinked and nonregular skill files under an admitted project link", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-linked-file-kinds-"));
		try {
			const target = path.join(root, ".agents", "skills");
			const scanRoot = path.join(root, ".gjc", "skills");
			await fs.mkdir(path.join(target, "hardlinked"), { recursive: true });
			await fs.mkdir(path.join(target, "directory", "SKILL.md"), { recursive: true });
			await fs.mkdir(path.dirname(scanRoot), { recursive: true });
			const source = path.join(root, "source.md");
			await fs.writeFile(source, "---\nname: hardlinked\ndescription: untrusted alias\n---\nbody");
			await fs.link(source, path.join(target, "hardlinked", "SKILL.md"));
			await fs.symlink("../.agents/skills", scanRoot, "dir");
			const result = await scanSkillsFromDir(
				{ cwd: root, home: root, repoRoot: root },
				{ dir: scanRoot, linkContainmentRoot: root, providerId: "test", level: "project" },
			);
			expect(result.items).toEqual([]);
			expect(result.warnings?.filter(warning => warning.includes("not a regular file"))).toHaveLength(2);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe("getUserSkillScanDirs", () => {
	test("isolates custom agent profiles from default legacy roots", () => {
		const home = "/tmp/gjc-skill-profile-home";
		const defaultAgentDir = resolveUserAgentDir(home);
		const customAgentDir = path.join(home, "profiles", "review");

		expect(getUserSkillScanDirs(home, customAgentDir, "custom")).toEqual([path.join(customAgentDir, "skills")]);
		expect(getUserSkillScanDirs(home, defaultAgentDir, "default")).toEqual([
			...new Set([
				path.join(home, SOURCE_PATHS.native.userAgent, "skills"),
				path.join(home, SOURCE_PATHS.native.userBase, "skills"),
				path.join(home, ".gjc", "skills"),
			]),
		]);
	});

	test("honors an explicit custom authority even when paths currently coincide", () => {
		const home = "/tmp/gjc-skill-profile-home";
		const defaultAgentDir = resolveUserAgentDir(home);

		expect(getUserSkillScanDirs(home, defaultAgentDir, "custom")).toEqual([path.join(defaultAgentDir, "skills")]);
	});

	test("keeps an XDG-resolved default agent directory as the canonical root", () => {
		const home = "/tmp/gjc-skill-profile-home";
		const xdgAgentDir = path.join(home, ".local", "share", "gjc", "agent");

		expect(getUserSkillScanDirs(home, xdgAgentDir, "default")[0]).toBe(path.join(xdgAgentDir, "skills"));
	});
});

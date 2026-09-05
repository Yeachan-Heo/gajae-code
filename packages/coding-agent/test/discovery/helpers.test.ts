import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "@gajae-code/utils";
import {
	getAncestorDirs,
	getUserSkillScanDirs,
	resolveUserAgentDir,
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

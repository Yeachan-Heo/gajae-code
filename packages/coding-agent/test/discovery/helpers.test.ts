import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "@gajae-code/utils";

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

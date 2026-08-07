import { describe, expect, test } from "bun:test";
import { parseMemoryDocument } from "../../src/documents/document-parser";
import { parseFrontmatter } from "../../src/documents/frontmatter";
import { parseMarkdownSections } from "../../src/documents/markdown-sections";
import { formatMemoryUri, parseMemoryUri } from "../../src/documents/uri";

const VALID_FRONTMATTER = `---
schemaVersion: gajae.memory.document.v1
id: note-1
type: fact
scope: global
authority: user-confirmed
volatility: stable
sensitivity: public-safe
status: active
created: 2026-07-29T10:00:00Z
updated: 2026-07-29T10:00:00.000Z
aliases:
  - preference
  - Cafe\u0301
supersedes: []
verification:
  provider: test
  resource: fixture
  id: one
---
# Café
body
`;

describe("memory document frontmatter", () => {
	test("normalizes line endings and NFC while retaining exact body boundaries", () => {
		const result = parseFrontmatter(
			VALID_FRONTMATTER.replaceAll("\n", "\r\n").replace("Café", "Cafe\u0301"),
			"global/note.md",
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.content).toContain("# Café\nbody");
		expect(result.value.body).toBe("# Café\nbody\n");
		expect(result.value.bodyStartLine).toBe(21);
		expect(result.value.metadata.aliases).toEqual(["preference", "café"]);
	});

	test("canonicalizes aliases for case-insensitive matching without ASCII slugging", () => {
		const result = parseFrontmatter(
			VALID_FRONTMATTER.replace("  - preference\n  - Cafe\u0301", '  - " Preference "\n  - " CAFÉ/Bistro "'),
			"x.md",
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.metadata.aliases).toEqual(["preference", "café/bistro"]);

		const duplicate = parseFrontmatter(
			VALID_FRONTMATTER.replace("  - preference\n  - Cafe\u0301", "  - Café\n  - cafe\u0301"),
			"x.md",
		);
		expect(duplicate.ok).toBe(false);
		if (!duplicate.ok) expect(duplicate.error.code).toBe("malformed-document");
	});

	test("maps unknown, duplicate, type, and timestamp failures to malformed-document", () => {
		const unknown = parseFrontmatter(
			VALID_FRONTMATTER.replace("supersedes: []", "unknown: value\nsupersedes: []"),
			"x.md",
		);
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.error.code).toBe("malformed-document");

		const duplicate = parseFrontmatter(VALID_FRONTMATTER.replace("id: note-1", "id: note-1\nid: note-2"), "x.md");
		expect(duplicate.ok).toBe(false);
		if (!duplicate.ok) expect(duplicate.error.code).toBe("malformed-document");

		const wrongType = parseFrontmatter(
			VALID_FRONTMATTER.replace("aliases:\n  - preference", "aliases: preference"),
			"x.md",
		);
		expect(wrongType.ok).toBe(false);
		if (!wrongType.ok) expect(wrongType.error.code).toBe("malformed-document");

		const wrongDate = parseFrontmatter(
			VALID_FRONTMATTER.replace("updated: 2026-07-29T10:00:00.000Z", "updated: 2026-07-29"),
			"x.md",
		);
		expect(wrongDate.ok).toBe(false);
		if (!wrongDate.ok) expect(wrongDate.error.code).toBe("malformed-document");
	});
});

describe("memory markdown sections", () => {
	test("recognizes variable fences and excludes fenced headings", () => {
		const content = "# One\ntext\n```ts\n# not a heading\n````\n## Two\nbody\n~~~\n# also not\n~~~\n# Three\nend";
		const result = parseMarkdownSections(content);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.map(section => section.heading)).toEqual(["One", "Two", "Three"]);
		expect(result.value[0]?.startLine).toBe(1);
		expect(result.value[0]?.endLine).toBe(10);
		expect(result.value[1]?.startLine).toBe(6);
		expect(result.value[1]?.endLine).toBe(10);
	});

	test("uses stable NFC slugs and duplicate ordinals", () => {
		const result = parseMarkdownSections("# Cafe\u0301\n# Café\n# A/B");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.map(section => section.slug)).toEqual(["café", "café-2", "a-b"]);
	});
});

describe("memory URIs", () => {
	test("formats encoded POSIX paths and round-trips canonically", () => {
		const parsed = parseMemoryUri("project://key/caf%C3%A9%20note.md#details");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.path).toEqual(["key", "café note.md"]);
		expect(parsed.value.href).toBe("project://key/caf%C3%A9%20note.md#details");
		const formatted = formatMemoryUri(parsed.value);
		expect(formatted).toEqual({ ok: true, value: parsed.value.href });
	});

	test("rejects absolute, traversal, encoded traversal, and unsupported schemes", () => {
		for (const raw of [
			"global:///tmp/note.md",
			"global://../note.md",
			"global://%2e%2e/note.md",
			"global://%252e%252e/note.md",
			"memory://note.md",
		]) {
			const result = parseMemoryUri(raw);
			expect(result.ok).toBe(false);
		}
	});
});

describe("memory document parser", () => {
	test("combines metadata, sections, digest, URI, and active citations", () => {
		const result = parseMemoryDocument({ content: VALID_FRONTMATTER, relPath: "global/note.md" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.uri.href).toBe("global://note.md");
		expect(result.value.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(result.value.sections[0]?.startLine).toBe(21);
		expect(result.value.citations[0]?.heading).toBe("Café");
	});

	test("marks non-active documents excluded unless explicitly included", () => {
		const proposed = VALID_FRONTMATTER.replace("status: active", "status: proposed");
		const excluded = parseMemoryDocument({ content: proposed, relPath: "global/proposed.md" });
		expect(excluded.ok).toBe(true);
		if (!excluded.ok) return;
		expect(excluded.value.retrievalEligible).toBe(false);
		expect(excluded.value.citations).toEqual([]);
		const included = parseMemoryDocument({ content: proposed, relPath: "global/proposed.md", includeExcluded: true });
		expect(included.ok).toBe(true);
		if (!included.ok) return;
		expect(included.value.retrievalEligible).toBe(true);
		expect(included.value.citations).toHaveLength(1);
	});
});

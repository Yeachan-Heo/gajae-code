import { describe, expect, test } from "bun:test";

import { type ParsedMemoryDocument, parseMemoryDocument } from "../../src/documents/document-parser";
import { extractClaims } from "../../src/resolution/claim-extractor";

const FRONTMATTER = `---
schemaVersion: gajae.memory.document.v1
id: preferences
type: preference
scope: global
authority: user-confirmed
volatility: stable
sensitivity: public-safe
status: active
created: 2026-07-29T00:00:00Z
updated: 2026-07-29T00:00:00.000Z
aliases:
  - preference
  - Cafe\u0301
supersedes: []
verification:
  provider: test
  resource: fixture
  id: one
---
`;

function documentWithBody(body: string): ParsedMemoryDocument | null {
	const parsed = parseMemoryDocument({ content: `${FRONTMATTER}${body}`, relPath: "global/preferences.md" });
	if (!parsed.ok) return null;
	return parsed.value;
}

describe("claim extraction", () => {
	test("extracts section claims with stable type and heading keys", () => {
		const document = documentWithBody("# Café\nUse the café profile.\n\n# Nested\nKeep this setting.\n");
		expect(document).not.toBeNull();
		if (document === null) return;

		const result = extractClaims(document);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.map(claim => claim.claimKey)).toEqual(["preference.café", "preference.nested"]);
		expect(result.value[0]?.text).toBe("Use the café profile.");
		expect(result.value[0]?.type).toBe("preference");
		expect(result.value[0]?.authority).toBe("user-confirmed");
		expect(result.value[0]?.freshness).toBe("2026-07-29T00:00:00.000Z");
		expect(result.value[0]?.source.heading).toBe("Café");
		expect(result.value[0]?.source.uri).toBe("global://preferences.md");
	});

	test("normalizes decomposed headings and preserves duplicate-heading uniqueness", () => {
		const composed = documentWithBody("# Café\nfirst\n# Café\nsecond\n");
		const decomposed = documentWithBody("# Cafe\u0301\nfirst\n# Cafe\u0301\nsecond\n");
		expect(composed).not.toBeNull();
		expect(decomposed).not.toBeNull();
		if (composed === null || decomposed === null) return;

		const first = extractClaims(composed);
		const second = extractClaims(decomposed);
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(first.value.map(claim => claim.claimKey)).toEqual(["preference.café", "preference.café-2"]);
		expect(second.value.map(claim => claim.claimKey)).toEqual(first.value.map(claim => claim.claimKey));
	});

	test("sorts output by deterministic UTF-8 claim-key order", () => {
		const document = documentWithBody("# Zulu\nz\n# Alpha\na\n# Éclair\ne\n");
		expect(document).not.toBeNull();
		if (document === null) return;

		const result = extractClaims(document);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.map(claim => claim.claimKey)).toEqual([
			"preference.alpha",
			"preference.zulu",
			"preference.éclair",
		]);
	});

	test("returns typed invalid-input for malformed parsed input", () => {
		const result = extractClaims({} as ParsedMemoryDocument);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("invalid-input");
	});

	test("uses the document id for a sectionless claim", () => {
		const document = documentWithBody("A document-level preference.\n");
		expect(document).not.toBeNull();
		if (document === null) return;

		const result = extractClaims(document);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toHaveLength(1);
		expect(result.value[0]?.claimKey).toBe("preference.preferences");
	});
});

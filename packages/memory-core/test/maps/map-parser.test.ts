import { describe, expect, it } from "bun:test";

import { normalizeMemoryDocumentUri, parseMemoryMap } from "../../src/maps/map-parser";

describe("parseMemoryMap", () => {
	it("parses only links in approved AUTO regions and preserves source order", () => {
		const content = [
			"[body](memory://global/body.md)",
			"<!-- AUTO:PROJECTS START -->",
			"[Project Conventions](memory://project/acme/conventions.md) <!-- aliases: standards, conventions; intents: project-convention -->",
			"```md",
			"[fenced](memory://project/acme/fenced.md)",
			"```",
			"[Decision](memory://project/acme/decision.md) #decision-history",
			"<!-- AUTO:PROJECTS END -->",
			"[outside](memory://global/outside.md)",
		].join("\n");

		const parsed = parseMemoryMap(content, "memory://global/MEMORY.md");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.routes.map(route => route.uri)).toEqual([
			"memory://project/acme/conventions.md",
			"memory://project/acme/decision.md",
		]);
		expect(parsed.value.routes[0]?.aliases).toEqual(["conventions", "project conventions", "standards"]);
		expect(parsed.value.routes[0]?.intents).toEqual(["project-convention"]);
		expect(parsed.value.routes[1]?.intents).toEqual(["decision-history"]);
	});

	it("normalizes NFC, URI fragments, and rejects unsafe document links", () => {
		const decomposed = "cafe\u0301";
		const normalized = normalizeMemoryDocumentUri(`memory://global/${decomposed}.md#Section%201`);
		expect(normalized).toEqual({
			ok: true,
			value: "memory://global/café.md#Section 1",
		});
		const content = [
			"<!-- AUTO:INDEX-HEALTH START -->",
			"[safe](memory://global/safe.md)",
			"<!-- AUTO:INDEX-HEALTH END -->",
		].join("\n");
		expect(parseMemoryMap(content, "memory://global/MEMORY.md").ok).toBe(true);
		expect(normalizeMemoryDocumentUri("memory://global/%2e%2e/secret.md").ok).toBe(false);
		expect(normalizeMemoryDocumentUri("memory://global/archive/old.md").ok).toBe(false);
		expect(normalizeMemoryDocumentUri("file:///tmp/secret.md").ok).toBe(false);
	});

	it("parses balanced annotation containers and rejects malformed nesting", () => {
		const content = [
			"<!-- AUTO:PROJECTS START -->",
			"[Conventions](memory://project/acme/conventions.md) <!-- aliases: [standards, conventions]; intents: {project-convention} -->",
			"<!-- AUTO:PROJECTS END -->",
		].join("\n");
		const parsed = parseMemoryMap(content, "MEMORY.md");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.routes[0]?.aliases).toEqual(["conventions", "standards"]);
		expect(parsed.value.routes[0]?.intents).toEqual(["project-convention"]);

		for (const annotation of [
			"aliases: [standards",
			"aliases: [standards, [style]]",
			"intents: {project-convention",
			"intents: {project-convention, {decision-history}}",
		]) {
			const malformed = parseMemoryMap(
				[
					"<!-- AUTO:PROJECTS START -->",
					`[link](memory://global/link.md) <!-- ${annotation} -->`,
					"<!-- AUTO:PROJECTS END -->",
				].join("\n"),
				"MEMORY.md",
			);
			expect(malformed.ok).toBe(false);
		}
	});

	it("fails closed for malformed markers and duplicate document links", () => {
		const unmatched = parseMemoryMap("<!-- AUTO:PROJECTS START -->\n[one](memory://global/one.md)", "MEMORY.md");
		expect(unmatched.ok).toBe(false);
		const duplicate = parseMemoryMap(
			[
				"<!-- AUTO:PROJECTS START -->",
				"[one](memory://global/one.md)",
				"[same](memory://global/one.md)",
				"<!-- AUTO:PROJECTS END -->",
			].join("\n"),
			"MEMORY.md",
		);
		expect(duplicate.ok).toBe(false);
	});
});

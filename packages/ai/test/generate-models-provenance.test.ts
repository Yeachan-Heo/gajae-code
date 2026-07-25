import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { composeCatalog, FIRST_PARTY_CATALOG_SEEDS } from "../scripts/generate-models";
import type { Model } from "../src/types";

/**
 * Provenance audit for typed catalog seeds.
 *
 * A documentation URL is mutable, so it cannot prove what a bundled row was
 * derived from. Every seed therefore commits a snapshot of each cited page and
 * records its SHA-256, and every seeded field cites the table cell (or sentence)
 * in that snapshot which states the value. This suite closes the chain offline:
 *
 *   committed digest -> committed snapshot bytes -> located cell -> documented
 *   rendering -> the seed's actual field value -> the emitted catalog row.
 */

const repoRoot = path.resolve(import.meta.dir, "../../..");

const REQUIRED_EVIDENCE_FIELDS = [
	"id",
	"input",
	"contextWindow",
	"maxTokens",
	"thinking.mode",
	"cost.input",
	"cost.output",
	"cost.cacheRead",
	"cost.cacheWrite",
] as const;

function readArtifact(artifact: string): string {
	return fs.readFileSync(path.join(repoRoot, artifact), "utf8");
}

function sha256(contents: string): string {
	return new Bun.CryptoHasher("sha256").update(contents).digest("hex");
}

function splitRow(row: string): string[] {
	return row
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map(cell => cell.trim());
}

/** Locate a markdown table cell by header label (selects table + column) and row label. */
function locateCell(markdown: string, columnLabel: string, rowLabel: string): string {
	const lines = markdown.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const header = lines[index] ?? "";
		const divider = lines[index + 1] ?? "";
		if (!header.trim().startsWith("|") || !/^\|[\s|:-]+\|$/.test(divider.trim())) continue;
		const column = splitRow(header).indexOf(columnLabel);
		if (column < 0) continue;
		for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
			const row = lines[rowIndex] ?? "";
			if (!row.trim().startsWith("|")) break;
			const cells = splitRow(row);
			if ((cells[0] ?? "").includes(rowLabel)) return cells[column] ?? "";
		}
	}
	throw new Error(`No table cell found for column "${columnLabel}" and row "${rowLabel}"`);
}

function parseTokenLimit(documented: string): number {
	const match = /^([\d.]+)([Mk]) tokens$/.exec(documented);
	if (!match) throw new Error(`Unparseable token limit: ${documented}`);
	return Number(match[1]) * (match[2] === "M" ? 1_000_000 : 1_000);
}

function parsePricePerMTok(documented: string): number {
	const match = /^\$([\d.]+) \/ MTok$/.exec(documented);
	if (!match) throw new Error(`Unparseable price: ${documented}`);
	return Number(match[1]);
}

describe("first-party catalog seed provenance", () => {
	it("commits every cited source and binds it by digest", () => {
		expect(FIRST_PARTY_CATALOG_SEEDS.length).toBeGreaterThan(0);
		for (const seed of FIRST_PARTY_CATALOG_SEEDS) {
			expect(seed.sources.length).toBeGreaterThan(0);
			for (const source of seed.sources) {
				expect(source.url).toMatch(/^https:\/\//);
				expect(source.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
				expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
				const contents = readArtifact(source.artifact);
				expect(contents.length).toBeGreaterThan(0);
				// The digest is what makes the citation immutable: if the snapshot is
				// edited, this fails instead of silently re-pointing at new bytes.
				expect(sha256(contents)).toBe(source.sha256);
			}
		}
	});

	it("cites an archived location for every documented field", () => {
		for (const seed of FIRST_PARTY_CATALOG_SEEDS) {
			const cited = new Set(seed.evidence.map(entry => entry.field));
			for (const field of REQUIRED_EVIDENCE_FIELDS) {
				expect(cited).toContain(field);
			}
			const artifacts = new Set(seed.sources.map(source => source.artifact));
			for (const entry of seed.evidence) {
				expect(artifacts).toContain(entry.artifact);
			}
		}
	});

	it("resolves each field's value from the archived bytes it cites", () => {
		const catalog = composeCatalog({ liveModels: [], modelsDevModels: [], previousCatalog: {} });

		for (const seed of FIRST_PARTY_CATALOG_SEEDS) {
			const emitted = catalog[seed.model.provider]?.[seed.model.id];
			expect(emitted).toBeDefined();
			const row = emitted as Model;

			for (const entry of seed.evidence) {
				const contents = readArtifact(entry.artifact);
				let located: string;
				if (entry.prose !== undefined) {
					expect(contents).toContain(entry.prose);
					located = entry.prose;
				} else {
					located = locateCell(contents, entry.column ?? "", entry.row ?? "");
				}
				// The archived location must state the documented rendering verbatim.
				expect(located).toContain(entry.documented);

				switch (entry.field) {
					case "id":
						expect(seed.model.id).toBe(entry.documented);
						break;
					case "input":
						// "text and image input" — vision plus text, nothing else.
						expect(seed.model.input).toEqual(["text", "image"]);
						break;
					case "contextWindow":
						expect(seed.model.contextWindow).toBe(parseTokenLimit(entry.documented));
						expect(row.contextWindow).toBe(parseTokenLimit(entry.documented));
						break;
					case "maxTokens":
						expect(seed.model.maxTokens).toBe(parseTokenLimit(entry.documented));
						expect(row.maxTokens).toBe(parseTokenLimit(entry.documented));
						break;
					case "thinking.mode":
						// Documented "Yes" for adaptive thinking must land as the adaptive
						// transport mode on the emitted row (derived, never hand-set).
						expect(entry.documented).toBe("Yes");
						expect(row.thinking?.mode).toBe("anthropic-adaptive");
						break;
					case "cost.input":
						expect(seed.model.cost.input).toBe(parsePricePerMTok(entry.documented));
						expect(row.cost.input).toBe(parsePricePerMTok(entry.documented));
						break;
					case "cost.output":
						expect(seed.model.cost.output).toBe(parsePricePerMTok(entry.documented));
						expect(row.cost.output).toBe(parsePricePerMTok(entry.documented));
						break;
					case "cost.cacheRead":
						expect(seed.model.cost.cacheRead).toBe(parsePricePerMTok(entry.documented));
						expect(row.cost.cacheRead).toBe(parsePricePerMTok(entry.documented));
						break;
					case "cost.cacheWrite":
						expect(seed.model.cost.cacheWrite).toBe(parsePricePerMTok(entry.documented));
						expect(row.cost.cacheWrite).toBe(parsePricePerMTok(entry.documented));
						break;
					default:
						throw new Error(`Unhandled evidence field: ${entry.field}`);
				}
			}
		}
	});

	it("emits the digest-bound sources onto the generated row", () => {
		const catalog = composeCatalog({ liveModels: [], modelsDevModels: [], previousCatalog: {} });

		for (const seed of FIRST_PARTY_CATALOG_SEEDS) {
			const row = catalog[seed.model.provider]?.[seed.model.id];
			expect(row?.catalogProvenance?.sources).toEqual(seed.sources.map(source => ({ ...source })));
		}
	});
});

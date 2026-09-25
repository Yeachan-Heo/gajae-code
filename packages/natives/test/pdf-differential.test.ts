import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { pdfToMarkdown } from "../native";
import { pdfGoldenCorpus } from "./pdf-fixtures";

interface PdfGoldenFile {
	schemaVersion: 1;
	cases: Array<{ id: string; inputSha256: string; markdown: string }>;
}

interface AcceptedDivergenceFile {
	schemaVersion: 1;
	cases: Array<{ caseId: string; reason: string }>;
}

function normalizedText(markdown: string): string {
	return markdown
		.replace(/<!-- Page \d+ -->/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

const goldenDirectory = path.join(import.meta.dir, "fixtures/goldens/pdf");
const goldenPath = path.join(goldenDirectory, "markit-ai-0.5.3.json");
const divergencePath = path.join(goldenDirectory, "accepted-divergences.json");

describe("pdf native differential", () => {
	it("matches the captured TS Markdown corpus, allowing only reviewed page-shape changes", async () => {
		const goldens = (await Bun.file(goldenPath).json()) as PdfGoldenFile;
		const accepted = (await Bun.file(divergencePath).json()) as AcceptedDivergenceFile;
		const expectedById = new Map(goldens.cases.map(entry => [entry.id, entry]));
		const acceptedById = new Map(accepted.cases.map(entry => [entry.caseId, entry]));
		expect(goldens.schemaVersion).toBe(1);
		expect(accepted.schemaVersion).toBe(1);
		expect(goldens.cases.map(entry => entry.id)).toEqual(pdfGoldenCorpus.map(entry => entry.id));

		const divergentIds: string[] = [];
		for (const fixture of pdfGoldenCorpus) {
			const expected = expectedById.get(fixture.id);
			if (!expected) throw new Error(`Missing PDF golden ${fixture.id}`);
			expect(createHash("sha256").update(fixture.bytes).digest("hex")).toBe(expected.inputSha256);

			const actual = await pdfToMarkdown(fixture.bytes);
			expect(normalizedText(actual.markdown)).toBe(normalizedText(expected.markdown));
			if (actual.markdown !== expected.markdown) {
				divergentIds.push(fixture.id);
				const divergence = acceptedById.get(fixture.id);
				if (!divergence) throw new Error(`Unaccepted PDF Markdown divergence: ${fixture.id}`);
				expect(divergence.reason.trim().length).toBeGreaterThan(0);
				expect(
					await Bun.file(
						path.resolve(import.meta.dir, "../../coding-agent/changelog.d/pdf-inspector.md"),
					).exists(),
				).toBe(true);
			}
			expect(actual.markdown).toContain("<!-- Page 1 -->");
			if (fixture.id === "pdf-two-pages") expect(actual.markdown).toContain("<!-- Page 2 -->");
		}
		expect([...acceptedById.keys()].sort()).toEqual(divergentIds.sort());
	});
});

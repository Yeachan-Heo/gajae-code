import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { convertBufferWithMarkit, convertFileWithMarkit } from "../src/utils/markit";
import { pdfFixture, pdfGoldenCorpus } from "../../natives/test/pdf-fixtures";

describe("native PDF conversion", () => {
	it("routes PDF buffers and files through the native inspector", async () => {
		const bufferResult = await convertBufferWithMarkit(pdfGoldenCorpus[0]!.bytes, " PDF ");
		expect(bufferResult.ok).toBe(true);
		expect(bufferResult.content).toContain("<!-- Page 1 -->");
		expect(bufferResult.content).toContain("Golden paragraph one");

		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-pdf-native-"));
		try {
			const filePath = path.join(directory, "document.PDF");
			await Bun.write(filePath, pdfGoldenCorpus[0]!.bytes);
			const fileResult = await convertFileWithMarkit(filePath);
			expect(fileResult.ok).toBe(true);
			expect(fileResult.content).toContain("Golden paragraph one");

			const missing = await convertFileWithMarkit(path.join(directory, "missing.pdf"));
			expect(missing.ok).toBe(false);
			expect(missing.error).toBe("PDF file could not be read");
			expect(missing.error).not.toContain(directory);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("reports OCR-required pages and rejects malformed bytes instead of returning PDF source", async () => {
		const blankPage = await convertBufferWithMarkit(pdfFixture([""]), ".pdf");
		expect(blankPage.ok).toBe(false);
		expect(blankPage.error).toContain("OCR is required for page 1");
		expect(blankPage.content).toBe("");

		const malformed = await convertBufferWithMarkit(Buffer.from("not a PDF"), ".pdf");
		expect(malformed.ok).toBe(false);
		expect(malformed.error).toContain("PDF conversion failed");
		expect(malformed.content).not.toContain("not a PDF");
	});

	it("keeps Markit conversion for non-PDF formats", async () => {
		const result = await convertBufferWithMarkit(Buffer.from("<h1>Retained HTML conversion</h1>"), ".html");
		expect(result.ok).toBe(true);
		expect(result.content).toContain("Retained HTML conversion");
	});
});

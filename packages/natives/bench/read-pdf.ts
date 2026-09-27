// A/B adapter for the PDF conversion path used by coding-agent read.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertFileWithMarkit } from "../../coding-agent/src/utils/markit";
import { runAbSuite } from "./ab-adapter";

function buildPdf(content: string): Buffer {
	const contentStream = `BT /F1 12 Tf 72 720 Td (${content}) Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
		`<< /Length ${Buffer.byteLength(contentStream)} >>\nstream\n${contentStream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
	];

	let pdf = Buffer.from("%PDF-1.4\n");
	const offsets: number[] = [];
	for (const [index, object] of objects.entries()) {
		offsets.push(pdf.length);
		pdf = Buffer.concat([pdf, Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`)]);
	}

	const xrefOffset = pdf.length;
	let trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) trailer += `${offset.toString().padStart(10, "0")} 00000 n \n`;
	trailer += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.concat([pdf, Buffer.from(trailer)]);
}

const pdfDirectory = mkdtempSync(join(tmpdir(), "gjc-read-pdf-bench-"));
const pdfPath = join(pdfDirectory, "input.pdf");
writeFileSync(pdfPath, buildPdf("PDF A/B read conversion benchmark"));
process.once("exit", () => rmSync(pdfDirectory, { recursive: true, force: true }));

await runAbSuite(
	"read-pdf",
	[
		{
			id: "P01",
			run: async () => {
				const result = await convertFileWithMarkit(pdfPath);
				if (!result.ok || !result.content.trim()) {
					throw new Error(`PDF fixture did not convert to Markdown: ${result.error ?? "empty output"}`);
				}
			},
		},
	],
	30,
);

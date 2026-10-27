export function pdfFixture(pageContents: string[], title?: string): Buffer {
	const fontId = 3 + pageContents.length * 2;
	const infoId = title === undefined ? undefined : fontId + 1;
	const objects = ["<< /Type /Catalog /Pages 2 0 R >>"];
	const kids = pageContents.map((_, index) => `${3 + index * 2} 0 R`).join(" ");
	objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pageContents.length} >>`);
	for (const [index, content] of pageContents.entries()) {
		const contentId = 4 + index * 2;
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
		);
		objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
	}
	objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
	if (title !== undefined) objects.push(`<< /Title (${title}) >>`);

	let pdf = Buffer.from("%PDF-1.4\n");
	const offsets: number[] = [];
	for (const [index, object] of objects.entries()) {
		offsets.push(pdf.length);
		pdf = Buffer.concat([pdf, Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`)]);
	}

	const xrefOffset = pdf.length;
	let trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) trailer += `${offset.toString().padStart(10, "0")} 00000 n \n`;
	const info = infoId === undefined ? "" : ` /Info ${infoId} 0 R`;
	trailer += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${info} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.concat([pdf, Buffer.from(trailer)]);
}

export const pdfGoldenCorpus = [
	{
		id: "pdf-one-page-title",
		bytes: pdfFixture(
			["BT /F1 12 Tf 72 720 Td (Golden paragraph one) Tj 0 -18 Td (More one page text) Tj ET"],
			"Golden Title",
		),
	},
	{
		id: "pdf-two-pages",
		bytes: pdfFixture([
			"BT /F1 12 Tf 72 720 Td (First page content) Tj 0 -18 Td (Second line) Tj ET",
			"BT /F1 12 Tf 72 720 Td (Second page content) Tj 0 -18 Td (Final line) Tj ET",
		]),
	},
] as const;

import { untilAborted } from "@gajae-code/utils";

export interface PdfMarkdownResult {
	markdown: string;
	title?: string | null;
	pageCount: number;
	pagesNeedingOcr: number[];
	hasEncodingIssues: boolean;
}

type PdfToMarkdown = (input: Uint8Array) => Promise<PdfMarkdownResult>;

let nativePdfToMarkdown: PdfToMarkdown | undefined;

function loadPdfToMarkdown(): PdfToMarkdown {
	if (nativePdfToMarkdown === undefined) {
		nativePdfToMarkdown = (require("@gajae-code/natives") as { pdfToMarkdown: PdfToMarkdown }).pdfToMarkdown;
	}
	return nativePdfToMarkdown;
}

export async function pdfToMarkdown(buffer: Uint8Array, signal?: AbortSignal): Promise<PdfMarkdownResult> {
	const convert = loadPdfToMarkdown();
	return signal ? await untilAborted(signal, () => convert(buffer)) : await convert(buffer);
}

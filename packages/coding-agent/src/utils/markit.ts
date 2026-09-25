import * as fs from "node:fs/promises";
import { untilAborted } from "@gajae-code/utils";
import type { Markit, StreamInfo } from "../../vendor/markit-ai/dist/index.js";
import { ToolAbortError } from "../tools/tool-errors";
import { type PdfMarkdownResult, pdfToMarkdown } from "./pdf";

export interface MarkitConversionResult {
	content: string;
	ok: boolean;
	error?: string;
}

let instance: Markit | undefined;
let instancePromise: Promise<Markit> | undefined;

async function loadMarkit(): Promise<Markit> {
	if (instancePromise === undefined) {
		instancePromise = import("../../vendor/markit-ai/dist/index.js")
			.then(({ Markit: MarkitConstructor }) => {
				instance = new MarkitConstructor();
				return instance;
			})
			.catch(error => {
				instancePromise = undefined;
				throw error;
			});
	}
	return instancePromise;
}

function normalizeExtension(extension: string): string {
	const trimmed = extension.trim().toLowerCase();
	if (!trimmed) return ".bin";
	return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function normalizeError(error: unknown): string {
	const messages: string[] = [];
	const seen = new Set<unknown>();
	while (error !== undefined && !seen.has(error)) {
		seen.add(error);
		if (error instanceof Error) {
			messages.push(`${error.name}: ${error.message}`);
			error = error.cause;
		} else {
			messages.push(String(error));
			break;
		}
	}
	return messages.join("; caused by: ") || "Conversion failed";
}

async function runMarkitConversion<T>(task: (markit: Markit) => Promise<T>, signal?: AbortSignal): Promise<T> {
	try {
		const markit = instance ?? (await loadMarkit());
		return signal ? await untilAborted(signal, () => task(markit)) : await task(markit);
	} catch (error) {
		if (error instanceof ToolAbortError) throw error;
		if (error instanceof Error && error.name === "AbortError") throw new ToolAbortError();
		throw error;
	}
}

function finalizeConversion(markdown?: string): MarkitConversionResult {
	if (typeof markdown === "string" && markdown.length > 0) return { content: markdown, ok: true };
	return { content: "", ok: false, error: "Conversion produced no output" };
}

function finalizePdfConversion(result: PdfMarkdownResult): MarkitConversionResult {
	if (result.markdown.trim().length > 0) return { content: result.markdown, ok: true };
	if (result.pagesNeedingOcr.length > 0) {
		return {
			content: "",
			ok: false,
			error: `PDF inspection produced no text; OCR is required for page${result.pagesNeedingOcr.length === 1 ? "" : "s"} ${result.pagesNeedingOcr.join(", ")}`,
		};
	}
	return { content: "", ok: false, error: "PDF inspection produced no Markdown output" };
}

function pdfFailure(error: unknown): MarkitConversionResult {
	if (error instanceof ToolAbortError) throw error;
	if (error instanceof Error && error.name === "AbortError") throw new ToolAbortError();
	return { content: "", ok: false, error: normalizeError(error) };
}

export async function convertFileWithMarkit(filePath: string, signal?: AbortSignal): Promise<MarkitConversionResult> {
	if (filePath.toLowerCase().endsWith(".pdf")) {
		let buffer: Buffer;
		try {
			buffer = await fs.readFile(filePath, { signal });
		} catch (error) {
			if (error instanceof ToolAbortError) throw error;
			if (error instanceof Error && error.name === "AbortError") throw new ToolAbortError();
			return { content: "", ok: false, error: "PDF file could not be read" };
		}
		try {
			return finalizePdfConversion(await pdfToMarkdown(buffer, signal));
		} catch (error) {
			return pdfFailure(error);
		}
	}

	try {
		const result = await runMarkitConversion(markit => markit.convertFile(filePath), signal);
		return finalizeConversion(result.markdown);
	} catch (error) {
		if (error instanceof ToolAbortError) throw error;
		return { content: "", ok: false, error: normalizeError(error) };
	}
}

export async function convertBufferWithMarkit(
	buffer: Uint8Array,
	extension: string,
	signal?: AbortSignal,
): Promise<MarkitConversionResult> {
	const normalizedExtension = normalizeExtension(extension);
	if (normalizedExtension === ".pdf") {
		try {
			return finalizePdfConversion(await pdfToMarkdown(buffer, signal));
		} catch (error) {
			return pdfFailure(error);
		}
	}

	const streamInfo: StreamInfo = {
		extension: normalizedExtension,
		filename: `input${normalizedExtension}`,
	};
	try {
		const result = await runMarkitConversion(markit => markit.convert(Buffer.from(buffer), streamInfo), signal);
		return finalizeConversion(result.markdown);
	} catch (error) {
		if (error instanceof ToolAbortError) throw error;
		return { content: "", ok: false, error: normalizeError(error) };
	}
}

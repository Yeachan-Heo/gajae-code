import { untilAborted } from "@gajae-code/utils";
import { Markit, type StreamInfo } from "markit-ai";
import { ToolAbortError } from "../tools/tool-errors";
import { prepareMuPdf, withMuPdfDiagnostic } from "./mupdf";

export interface MarkitConversionResult {
	content: string;
	ok: boolean;
	error?: string;
}

let instance: Markit | undefined;

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
		instance ??= new Markit();
		const markit = instance;
		return signal ? await untilAborted(signal, () => task(markit)) : await task(markit);
	} catch (error) {
		if (error instanceof ToolAbortError) {
			throw error;
		}
		if (error instanceof Error && error.name === "AbortError") {
			throw new ToolAbortError();
		}
		throw error;
	}
}

function finalizeConversion(markdown?: string): MarkitConversionResult {
	if (typeof markdown === "string" && markdown.length > 0) {
		return { content: markdown, ok: true };
	}

	return { content: "", ok: false, error: "Conversion produced no output" };
}

export async function convertFileWithMarkit(filePath: string, signal?: AbortSignal): Promise<MarkitConversionResult> {
	try {
		const result = await runMarkitConversion(async markit => {
			if (filePath.toLowerCase().endsWith(".pdf")) await prepareMuPdf();
			return markit.convertFile(filePath);
		}, signal);
		return finalizeConversion(result.markdown);
	} catch (error) {
		if (error instanceof ToolAbortError) {
			throw error;
		}
		return {
			content: "",
			ok: false,
			error: normalizeError(filePath.toLowerCase().endsWith(".pdf") ? withMuPdfDiagnostic(error) : error),
		};
	}
}

export async function convertBufferWithMarkit(
	buffer: Uint8Array,
	extension: string,
	signal?: AbortSignal,
): Promise<MarkitConversionResult> {
	const normalizedExtension = normalizeExtension(extension);
	const streamInfo: StreamInfo = {
		extension: normalizedExtension,
		filename: `input${normalizedExtension}`,
	};

	try {
		const result = await runMarkitConversion(async markit => {
			if (normalizedExtension === ".pdf") await prepareMuPdf();
			return markit.convert(Buffer.from(buffer), streamInfo);
		}, signal);
		return finalizeConversion(result.markdown);
	} catch (error) {
		if (error instanceof ToolAbortError) {
			throw error;
		}
		return {
			content: "",
			ok: false,
			error: normalizeError(normalizedExtension === ".pdf" ? withMuPdfDiagnostic(error) : error),
		};
	}
}

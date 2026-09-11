import { untilAborted } from "@gajae-code/utils";
import type { Markit, StreamInfo } from "markit-ai";
import { ToolAbortError } from "../tools/tool-errors";
import { ensureMupdfWasmResolution } from "./mupdf-wasm";

export interface MarkitConversionResult {
	content: string;
	ok: boolean;
	error?: string;
}

let markit: () => Markit | Promise<Markit> = async () => {
	const promise = import("markit-ai").then(({ Markit }) => {
		const instance = new Markit();
		markit = () => instance;
		return instance;
	});
	markit = () => promise;
	return promise;
};

// #5433: mupdf's wasm asset is not reachable at the Emscripten loader's
// default bunfs path in compiled binaries. Seed the embedded-asset hook
// before any markit conversion (and therefore before any mupdf import).
ensureMupdfWasmResolution();

function normalizeExtension(extension: string): string {
	const trimmed = extension.trim().toLowerCase();
	if (!trimmed) return ".bin";
	return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function normalizeError(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message.trim();
	}
	return "Conversion failed";
}

/**
 * markit-ai's PDF converter swallows the real mupdf import failure behind a
 * generic "Install it" message (#5433). Re-run the import here so release
 * diagnostics carry the actual module/asset/initialization error.
 */
async function describeConversionError(error: unknown): Promise<string> {
	const base = normalizeError(error);
	if (!base.includes("PDF support requires 'mupdf'")) return base;
	try {
		await import("mupdf");
	} catch (cause) {
		return `${base} (mupdf import failed: ${normalizeError(cause)})`;
	}
	return base;
}

async function runMarkitConversion<T>(task: (markit: Markit) => Promise<T>, signal?: AbortSignal): Promise<T> {
	try {
		const instance = await markit();
		return signal ? await untilAborted(signal, () => task(instance)) : await task(instance);
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
		const result = await runMarkitConversion(markit => markit.convertFile(filePath), signal);
		return finalizeConversion(result.markdown);
	} catch (error) {
		if (error instanceof ToolAbortError) {
			throw error;
		}
		return { content: "", ok: false, error: await describeConversionError(error) };
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
		const result = await runMarkitConversion(markit => markit.convert(Buffer.from(buffer), streamInfo), signal);
		return finalizeConversion(result.markdown);
	} catch (error) {
		if (error instanceof ToolAbortError) {
			throw error;
		}
		return { content: "", ok: false, error: await describeConversionError(error) };
	}
}

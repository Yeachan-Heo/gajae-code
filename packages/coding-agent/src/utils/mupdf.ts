import * as path from "node:path";
import * as url from "node:url";
import * as util from "node:util";
import { logger } from "@gajae-code/utils";
import { embeddedMuPdfModule, embeddedMuPdfWasm } from "./mupdf-embedded";

export let mupdfAssetMapping = "module mupdf; WASM mupdf-wasm.wasm -> unresolved";
let wasmAsset: string | undefined;
let initializationFailure: unknown;
let preparation: Promise<void> | undefined;

function resolveWasmAsset(): string {
	if (wasmAsset) return wasmAsset;
	let moduleMapping: string;
	if (embeddedMuPdfWasm) {
		wasmAsset = embeddedMuPdfWasm;
		moduleMapping = `build-time provenance ${embeddedMuPdfModule}`;
	} else {
		if (process.env.PI_COMPILED || /\$bunfs|~BUN|%7EBUN/.test(import.meta.url)) {
			throw new Error("Compiled MuPDF WASM mapping is missing; run scripts/embed-mupdf.ts before compiling.");
		}
		const markitModule = url.fileURLToPath(new URL("../../vendor/markit-ai/dist/index.js", import.meta.url));
		moduleMapping = Bun.resolveSync("mupdf", path.dirname(markitModule));
		wasmAsset = path.join(path.dirname(moduleMapping), "mupdf-wasm.wasm");
	}
	mupdfAssetMapping = `module mupdf -> ${moduleMapping}; WASM mupdf-wasm.wasm -> ${wasmAsset}`;
	return wasmAsset;
}

// The official Emscripten hook is consumed by markit-ai's lazy MuPDF import.
// Capture initialization aborts while preserving the import error's cause chain.
const configuration: {
	wasmBinary?: Uint8Array;
	locateFile: () => string;
	onAbort: (error: unknown) => void;
} = {
	locateFile: resolveWasmAsset,
	onAbort(error: unknown) {
		initializationFailure = error;
	},
};

Object.assign(globalThis, { $libmupdf_wasm_Module: configuration });

export function prepareMuPdf(): Promise<void> {
	preparation ??= Promise.resolve().then(async () => {
		const bytes = await Bun.file(resolveWasmAsset()).bytes();
		// Reject corrupt assets before Emscripten starts: its abort path can also
		// reject a secondary promise even when the module import is caught.
		await WebAssembly.compile(bytes);
		configuration.wasmBinary = bytes;
	});
	return preparation;
}

export function withMuPdfDiagnostic(error: unknown): Error {
	const cause = initializationFailure ?? error;
	logger.debug("MuPDF conversion failed", {
		mapping: mupdfAssetMapping,
		error: util.inspect(error, { depth: null, colors: false }),
		initializationFailure: util.inspect(initializationFailure, { depth: null, colors: false }),
	});
	const asset = embeddedMuPdfWasm ? "embedded asset" : "package asset";
	return new Error(`PDF conversion failed [MuPDF; ${asset}; mupdf-wasm.wasm]`, { cause });
}

// Only the model-facing rendering is redacted; Error.cause remains intact for
// internal inspection and operational debug logging. Conservatively redact the
// rest of a path-bearing field so spaces in install paths cannot leak suffixes.
export function sanitizeMuPdfDiagnostic(message: string): string {
	return util
		.stripVTControlCharacters(message)
		.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "")
		.replace(/[^\s"'`]*(?:[/\\]|%2f|%5c)[^"'`]*(?=["'`]|$)/gi, "[path redacted]");
}

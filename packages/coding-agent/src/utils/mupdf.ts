import { fileURLToPath } from "node:url";
import { embeddedMuPdfWasm } from "./mupdf-embedded";

export let mupdfAssetMapping = "module mupdf; WASM mupdf-wasm.wasm -> unresolved";
let wasmAsset: string | undefined;
let initializationFailure: unknown;
let preparation: Promise<void> | undefined;

function resolveWasmAsset(): string {
	if (wasmAsset) return wasmAsset;
	if (embeddedMuPdfWasm) {
		wasmAsset = embeddedMuPdfWasm;
	} else {
		if (process.env.PI_COMPILED || /\$bunfs|~BUN|%7EBUN/.test(import.meta.url)) {
			throw new Error("Compiled MuPDF WASM mapping is missing; run scripts/embed-mupdf.ts before compiling.");
		}
		wasmAsset = fileURLToPath(new URL("./mupdf-wasm.wasm", import.meta.resolve("mupdf")));
	}
	mupdfAssetMapping = `module mupdf; WASM mupdf-wasm.wasm -> ${wasmAsset}`;
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
	return new Error(`PDF conversion failed [${mupdfAssetMapping}]`, { cause });
}

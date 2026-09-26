import * as path from "node:path";
import * as url from "node:url";
import * as util from "node:util";
import { logger } from "@gajae-code/utils";
import { embeddedMuPdfModule, embeddedMuPdfWasm } from "./mupdf-embedded";

export let mupdfAssetMapping = "module mupdf; WASM mupdf-wasm.wasm -> unresolved";
let wasmAsset: string | undefined;
let initializationFailure: unknown;
let preparation: Promise<void> | undefined;

interface MuPdfModuleConfiguration {
	wasmBinary?: Uint8Array;
	locateFile?: (filename?: string) => string;
	onAbort?: (error: unknown) => void;
}

type MuPdfGlobal = typeof globalThis & {
	$libmupdf_wasm_Module?: MuPdfModuleConfiguration;
};

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
const globalScope = globalThis as MuPdfGlobal;
const hostConfiguration = globalScope.$libmupdf_wasm_Module;
const configuration: MuPdfModuleConfiguration = hostConfiguration ?? {
	locateFile: resolveWasmAsset,
	onAbort(error: unknown) {
		initializationFailure = error;
	},
};

if (hostConfiguration === undefined) {
	globalScope.$libmupdf_wasm_Module = configuration;
} else {
	// Reuse an SDK host's configuration and hooks. Only fill absent fields; do
	// not replace locateFile/onAbort or discard caller-owned settings.
	if (configuration.locateFile === undefined) configuration.locateFile = resolveWasmAsset;
	if (configuration.onAbort === undefined) {
		configuration.onAbort = error => {
			initializationFailure = error;
		};
	}
}

function preparationAsset(): string {
	const configuredPath = configuration.locateFile?.("mupdf-wasm.wasm");
	return configuredPath ?? resolveWasmAsset();
}

export function prepareMuPdf(): Promise<void> {
	// A new conversion attempt must not inherit an abort from a prior attempt.
	initializationFailure = undefined;
	const previousWasmBinary = configuration.wasmBinary;
	preparation ??= Promise.resolve()
		.then(async () => {
			const bytes = await Bun.file(preparationAsset()).bytes();
			// Reject corrupt assets before Emscripten starts: its abort path can also
			// reject a secondary promise even when the module import is caught.
			await WebAssembly.compile(bytes);
			if (configuration.wasmBinary === undefined) configuration.wasmBinary = bytes;
		})
		.catch(error => {
			preparation = undefined;
			configuration.wasmBinary = previousWasmBinary;
			throw error;
		});
	return preparation;
}

export function withMuPdfDiagnostic(error: unknown): Error {
	const capturedInitializationFailure = initializationFailure;
	initializationFailure = undefined;
	const cause = capturedInitializationFailure ?? error;
	const debugDetails: Record<string, unknown> = {
		asset: embeddedMuPdfWasm ? "embedded" : "package",
		error: formatMuPdfCauseChain(error),
	};
	if (capturedInitializationFailure !== undefined) {
		debugDetails.initializationFailure = formatMuPdfCauseChain(capturedInitializationFailure);
	}
	logger.debug("MuPDF conversion failed", debugDetails);
	const asset = embeddedMuPdfWasm ? "embedded asset" : "package asset";
	return new Error(`PDF conversion failed [MuPDF; ${asset}; mupdf-wasm.wasm]`, { cause });
}

function formatMuPdfCauseChain(error: unknown): string {
	const messages: string[] = [];
	const seen = new Set<unknown>();
	while (error !== undefined && !seen.has(error)) {
		seen.add(error);
		if (error instanceof Error) {
			messages.push(sanitizeMuPdfDiagnostic(`${error.name}: ${error.message}`));
			error = error.cause;
		} else {
			messages.push(sanitizeMuPdfDiagnostic(String(error)));
			break;
		}
	}
	return messages.join("; caused by: ") || "Conversion failed";
}

// Only the model-facing rendering is redacted; Error.cause remains intact for
// internal inspection and operational debug logging. Conservatively redact the
// rest of a path-bearing field so spaces in install paths cannot leak suffixes.
export function sanitizeMuPdfDiagnostic(message: string): string {
	return (
		util
			.stripVTControlCharacters(message)
			.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "")
			// The prefix run is boundary anchored. Unbounded, `[^\s"'`]*` is re-tried at
			// every offset of a long slash-free run before failing to find a separator,
			// which is quadratic in the message length: 100 KB cost about 13s. A MuPDF
			// diagnostic is derived from the document being converted, and
			// `normalizeError` runs this once per link in the cause chain.
			.replace(/(?<![^\s"'`])[^\s"'`]*(?:[/\\]|%2f|%5c)[^"'`]*(?=["'`]|$)/gi, "[path redacted]")
	);
}

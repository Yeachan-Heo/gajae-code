import { isCompiledBinary } from "@gajae-code/utils";
import { resolveMarkitMupdfWasm } from "../../scripts/generate-mupdf-wasm";
import embeddedMupdfWasmPath from "./mupdf-wasm.generated.wasm" with { type: "file" };

const MODULE_CONFIG_KEY = "$libmupdf_wasm_Module";

/** Seed MuPDF's Emscripten config before markit's first MuPDF import (#5433). */
export function ensureMupdfWasmResolution(): void {
	const globalScope = globalThis as typeof globalThis & Record<string, unknown>;
	if (globalScope[MODULE_CONFIG_KEY] !== undefined) return;
	// Compiled builds embed the asset from the same dependency snapshot as the
	// bundled loader. Source/SDK installs resolve markit's actual loader instance:
	// their dependency version can differ from the snapshot used when packing.
	const wasmPath = isCompiledBinary() ? String(embeddedMupdfWasmPath) : resolveMarkitMupdfWasm();
	globalScope[MODULE_CONFIG_KEY] = { locateFile: () => wasmPath };
}

import { isCompiledBinary } from "@gajae-code/utils";
import { resolveMarkitMupdfWasm } from "./mupdf-wasm-path";

const MODULE_CONFIG_KEY = "$libmupdf_wasm_Module";

// The generated asset is gitignored and produced by `prepare`/`prepack`/the
// binary build, so it must not be a static dependency of the source path:
// `bun run dev` from a checkout that skipped `prepare` would fail at module
// load before `isCompiledBinary()` could ever branch away from it. A dynamic
// specifier is still statically analyzable, so `--compile` embeds the file,
// mirroring how `docs-index.generated` is loaded (#5433).
let embeddedMupdfWasmPath: Promise<string> | undefined;
function loadEmbeddedMupdfWasmPath(): Promise<string> {
	if (!embeddedMupdfWasmPath)
		embeddedMupdfWasmPath = import("./mupdf-wasm.generated.wasm", { with: { type: "file" } }).then(module =>
			String(module.default),
		);
	return embeddedMupdfWasmPath;
}

/** Seed MuPDF's Emscripten config before markit's first MuPDF import (#5433). */
export async function ensureMupdfWasmResolution(): Promise<void> {
	const globalScope = globalThis as typeof globalThis & Record<string, unknown>;
	if (globalScope[MODULE_CONFIG_KEY] !== undefined) return;
	// Compiled builds embed the asset from the same dependency snapshot as the
	// bundled loader. Source/SDK installs resolve markit's actual loader instance:
	// their dependency version can differ from the snapshot used when packing.
	const wasmPath = isCompiledBinary() ? await loadEmbeddedMupdfWasmPath() : resolveMarkitMupdfWasm();
	globalScope[MODULE_CONFIG_KEY] = { locateFile: () => wasmPath };
}

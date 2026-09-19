/**
 * MuPDF wasm asset resolution inside compiled binaries (#5433).
 *
 * `mupdf`'s Emscripten loader resolves `mupdf-wasm.wasm` relative to
 * `import.meta.url` (or `scriptDirectory`). Inside a `bun build --compile`
 * bunfs that path points at the bunfs root where the asset does not exist,
 * so every mupdf import aborted with
 * `ENOENT: ... /$bunfs/root/mupdf-wasm.wasm`.
 *
 * The wasm is embedded via `with { type: "file" }`, which lands it at a
 * hashed bunfs path. MuPDF's top-level factory call reads
 * `globalThis["$libmupdf_wasm_Module"]`, so seeding that config with a
 * `locateFile` hook that returns the embedded asset path makes the loader
 * read the wasm from the bunfs directly — no disk sidecar needed.
 *
 * This must run before the first `import("mupdf")` anywhere in the process.
 *
 * The embedded asset lives behind a separate module (#5663) so that an
 * npm-installed source tree never resolves the monorepo-only
 * `node_modules/mupdf/...` specifier at import time. That module is pulled in
 * with a synchronous `require`, NOT a top-level `await import(...)`: a
 * top-level await here makes this module async, and bun 1.4.0 fails to
 * propagate that async-ness through the `model-registry` <-> `model-resolver`
 * import cycle. The resulting bundle emits a non-async `__esm(() => { ...
 * await init_model_registry(); ... })` wrapper, so every compiled binary died
 * at parse time with `SyntaxError: Unexpected identifier
 * 'init_model_registry'` (#5674). Keep this resolution synchronous.
 */
import { isCompiledBinary } from "@gajae-code/utils/env";

const MODULE_CONFIG_KEY = "$libmupdf_wasm_Module";

function loadEmbeddedMupdfWasmPath(): string | undefined {
	if (!isCompiledBinary()) return undefined;
	// Only reached inside a compiled binary, where the embedded module — and
	// therefore the bunfs asset it points at — is always bundled in.
	const embedded = require("./mupdf-wasm-embedded") as { default?: unknown };
	const embeddedPath = embedded.default;
	return typeof embeddedPath === "string" ? embeddedPath : undefined;
}

const mupdfWasmPath = loadEmbeddedMupdfWasmPath();

export function ensureMupdfWasmResolution(): void {
	const globalScope = globalThis as typeof globalThis & Record<string, unknown>;
	if (globalScope[MODULE_CONFIG_KEY] !== undefined || mupdfWasmPath === undefined) return;
	globalScope[MODULE_CONFIG_KEY] = { locateFile: () => String(mupdfWasmPath) };
}

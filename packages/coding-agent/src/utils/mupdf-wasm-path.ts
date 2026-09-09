import * as path from "node:path";

/** Resolve the dependency instance used by markit's PDF converter, without importing it. */
export function resolveMarkitMupdfWasm(fromDirectory = path.resolve(import.meta.dirname, "../..")): string {
	const markitEntry = Bun.resolveSync("markit-ai", fromDirectory);
	const mupdfEntry = Bun.resolveSync("mupdf", path.dirname(markitEntry));
	return path.join(path.dirname(mupdfEntry), "mupdf-wasm.wasm");
}

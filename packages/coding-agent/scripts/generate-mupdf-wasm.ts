import * as path from "node:path";

/** Resolve the dependency instance used by markit's PDF converter, without importing it. */
export function resolveMarkitMupdfWasm(fromDirectory = path.resolve(import.meta.dirname, "..")): string {
	const markitEntry = Bun.resolveSync("markit-ai", fromDirectory);
	const mupdfEntry = Bun.resolveSync("mupdf", path.dirname(markitEntry));
	return path.join(path.dirname(mupdfEntry), "mupdf-wasm.wasm");
}

export async function generateMupdfWasm(): Promise<void> {
	const source = Bun.file(resolveMarkitMupdfWasm());
	// Missing dependencies or assets are build errors, never optional PDF support.
	await Bun.write(path.resolve(import.meta.dirname, "../src/utils/mupdf-wasm.generated.wasm"), source);
}

if (import.meta.main) await generateMupdfWasm();

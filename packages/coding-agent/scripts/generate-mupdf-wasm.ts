import * as path from "node:path";
import { resolveMarkitMupdfWasm } from "../src/utils/mupdf-wasm-path";

export async function generateMupdfWasm(): Promise<void> {
	const source = Bun.file(resolveMarkitMupdfWasm());
	// Missing dependencies or assets are build errors, never optional PDF support.
	await Bun.write(path.resolve(import.meta.dirname, "../src/utils/mupdf-wasm.generated.wasm"), source);
}

if (import.meta.main) await generateMupdfWasm();

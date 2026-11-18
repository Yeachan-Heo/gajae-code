import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Imported data files such as package.json are copied but not scanned. */
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);
const RESOLVE_EXTENSIONS = ["", ".ts", ".tsx", ".js", "/index.ts", "/index.js"];

async function resolveRelative(fromFile: string, specifier: string): Promise<string> {
	const base = path.resolve(path.dirname(fromFile), specifier);
	for (const extension of RESOLVE_EXTENSIONS) {
		const candidate = `${base}${extension}`;
		const stat = await fs.stat(candidate).catch(() => null);
		if (stat?.isFile()) return candidate;
	}
	throw new Error(`copy-import-closure: cannot resolve ${specifier} from ${fromFile}`);
}

/**
 * Copy `entries` (paths relative to `sourceRoot`) and every file they reach
 * through relative imports into the same relative locations under `destRoot`.
 *
 * Bare specifiers (`node:*`, packages) are not followed: fixtures that model a
 * dependency-less checkout must not gain `node_modules`. Deriving the set from
 * the imports keeps the fixture in step when an entry grows a new local import,
 * instead of failing with a module-resolution error unrelated to the contract.
 */
export async function copyImportClosure(sourceRoot: string, destRoot: string, entries: readonly string[]): Promise<string[]> {
	const transpiler = new Bun.Transpiler({ loader: "ts" });
	const pending = entries.map(entry => path.resolve(sourceRoot, entry));
	const seen = new Set<string>();
	while (pending.length > 0) {
		const file = pending.pop()!;
		if (seen.has(file)) continue;
		const relative = path.relative(sourceRoot, file);
		if (relative.startsWith("..") || path.isAbsolute(relative)) {
			throw new Error(`copy-import-closure: ${file} is outside ${sourceRoot}`);
		}
		seen.add(file);
		const source = SCANNED_EXTENSIONS.has(path.extname(file)) ? await Bun.file(file).text() : "";
		for (const { path: specifier } of source ? transpiler.scanImports(source) : []) {
			if (specifier.startsWith("./") || specifier.startsWith("../")) {
				pending.push(await resolveRelative(file, specifier));
			}
		}
		const target = path.join(destRoot, relative);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.copyFile(file, target);
	}
	return [...seen].map(file => path.relative(sourceRoot, file)).sort();
}

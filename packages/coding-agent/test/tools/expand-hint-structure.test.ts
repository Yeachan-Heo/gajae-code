import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const SOURCE_ROOT = join(import.meta.dir, "../../src");
const RENDER_UTILS = join(SOURCE_ROOT, "tools/render-utils.ts");
const WEB_SEARCH_CLI = join(SOURCE_ROOT, "cli/web-search-cli.ts");

async function sourceFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	return (
		await Promise.all(
			entries.map(entry => {
				const entryPath = join(directory, entry.name);
				return entry.isDirectory() ? sourceFiles(entryPath) : entry.name.endsWith(".ts") ? [entryPath] : [];
			}),
		)
	).flat();
}

function stripComments(source: string): string {
	return source.replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
}

describe("expand hint capability structure", () => {
	it("limits the noninteractive binding to the web-search CLI", async () => {
		const violations: string[] = [];
		for (const file of await sourceFiles(SOURCE_ROOT)) {
			const source = await readFile(file, "utf8");
			if (file !== WEB_SEARCH_CLI && file !== RENDER_UTILS && /\bwebSearchCliNoHintCapability\b/.test(source))
				violations.push(file);
			if (file !== RENDER_UTILS && /\bnoExpandHintCapability\b|\bpublicBoundaryNoHintCapability\b/.test(source)) {
				violations.push(file);
			}
		}
		expect(violations).toEqual([]);
	});

	it("forbids public-option reads and assertion escapes outside the boundary", async () => {
		const violations: string[] = [];
		for (const file of await sourceFiles(SOURCE_ROOT)) {
			if (file === RENDER_UTILS) continue;
			const source = stripComments(await readFile(file, "utf8"));
			if (
				![join(SOURCE_ROOT, "modes/components/read-tool-group.ts"), join(SOURCE_ROOT, "tui/code-cell.ts")].includes(
					file,
				) &&
				/\boptions\.expandHintCapability\b|\bexpandHintCapability!|\bas\s+ExpandHintCapability\b/.test(source)
			) {
				violations.push(file);
			}
		}
		expect(violations).toEqual([]);
	});
});

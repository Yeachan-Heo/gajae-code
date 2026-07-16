import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const SOURCE_ROOT = join(import.meta.dir, "../../src");

async function sourceFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(entry => {
			const path = join(directory, entry.name);
			return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
		}),
	);
	return files.flat();
}

describe("expand hint capability structure", () => {
	it("does not permit optional, asserted, cast, or fallback capabilities", async () => {
		const violations: string[] = [];
		for (const path of await sourceFiles(SOURCE_ROOT)) {
			if (path.endsWith("tools/render-utils.ts")) continue;
			const text = await readFile(path, "utf8");
			for (const pattern of [
				/expandHintCapability\?/,
				/expandHintCapability!/,
				/\sas\s+[^\n]*expandHintCapability/,
				/\?\?\s*noExpandHintCapability/,
			]) {
				if (pattern.test(text)) violations.push(`${path}: ${pattern}`);
			}
		}
		expect(violations).toEqual([]);
	});

	it("documents every noninteractive capability", async () => {
		const violations: string[] = [];
		for (const path of await sourceFiles(SOURCE_ROOT)) {
			if (path.endsWith("tools/render-utils.ts")) continue;
			const lines = (await readFile(path, "utf8")).split("\n");
			lines.forEach((line, index) => {
				if (!line.includes("noExpandHintCapability") || line.startsWith("import ")) return;
				if (
					!lines
						.slice(Math.max(0, index - 1), index + 2)
						.some(candidate => candidate.includes("// noninteractive:"))
				) {
					violations.push(`${path}:${index + 1}`);
				}
			});
		}
		expect(violations).toEqual([]);
	});
});

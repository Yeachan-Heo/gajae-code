import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { getBundledModels, getBundledProviders, PROVIDER_RUNTIME_DESCRIPTORS } from "@gajae-code/ai/core";
import { resolveModelFromString } from "./config/model-resolver";

const SOURCE_ROOT = import.meta.dir;
const BARE_AI_IMPORT = /\bfrom\s+["']@gajae-code\/ai["']|\bimport\(\s*["']@gajae-code\/ai["']/;

async function collectSourceFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectSourceFiles(entryPath)));
		} else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
			files.push(entryPath);
		}
	}
	return files;
}

describe("AI core import boundary", () => {
	test("coding-agent source does not import the heavy AI root barrel", async () => {
		const offenders: string[] = [];
		for (const file of await collectSourceFiles(SOURCE_ROOT)) {
			const lines = (await readFile(file, "utf8")).split("\n");
			for (const [index, line] of lines.entries()) {
				if (BARE_AI_IMPORT.test(line)) {
					offenders.push(`${path.relative(SOURCE_ROOT, file)}:${index + 1}: ${line.trim()}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test("lazy provider descriptors preserve model listing and selection", async () => {
		const snapshot = () => {
			const providers = getBundledProviders();
			const models = providers.flatMap(provider =>
				getBundledModels(provider as Parameters<typeof getBundledModels>[0]),
			);
			const selected = resolveModelFromString("openai/gpt-4o-mini", models);
			return {
				providers,
				models: models.map(model => `${model.provider}/${model.id}`),
				selected: selected ? `${selected.provider}/${selected.id}` : undefined,
			};
		};

		const before = snapshot();
		await Promise.all(PROVIDER_RUNTIME_DESCRIPTORS.map(descriptor => descriptor.load()));
		const after = snapshot();

		expect(after).toEqual(before);
		expect(after.selected).toBe("openai/gpt-4o-mini");
	});
});

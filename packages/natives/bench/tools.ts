import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fuzzyFind, listWorkspace } from "../native/index.js";
import { runAbSuite } from "./ab-adapter";

const fixtureRoot = await createFixtureTree();

async function createFixtureTree(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "gjc-tools-discovery-"));
	await writeFile(join(root, ".gitignore"), "ignored/\n*.skip.ts\n");
	await mkdir(join(root, "ignored"), { recursive: true });
	for (let group = 0; group < 12; group++) {
		const directory = join(root, "src", `area-${String(group).padStart(2, "0")}`, "nested", "deep");
		await mkdir(directory, { recursive: true });
		for (let file = 0; file < 24; file++) {
			const index = group * 24 + file;
			await writeFile(
				join(directory, `component-${String(index).padStart(3, "0")}-needle.ts`),
				`export const component${index} = makeThing("fixture-${index}", ${index});\n`,
			);
		}
		await writeFile(join(directory, `excluded-${group}.skip.ts`), `export const excluded${group} = otherThing(${group});\n`);
		await writeFile(join(root, "ignored", `excluded-${group}.ts`), `export const ignored${group} = otherThing(${group});\n`);
	}
	return root;
}

await runAbSuite(
	"tools",
	[
		{
			// F01: fuzzy-rank matching file paths across the fixture tree.
			id: "F01",
			run: async () => {
				// Disable walker caching so each sample measures a fresh file discovery pass.
				const result = await fuzzyFind({
					query: "needle",
					path: fixtureRoot,
					hidden: false,
					gitignore: true,
					cache: false,
					maxResults: 300,
				});
				if (result.totalMatches !== 288) throw new Error(`expected 288 fuzzy matches, got ${result.totalMatches}`);
			},
		},
		{
			// W01: build the bounded workspace tree while respecting .gitignore.
			id: "W01",
			run: async () => {
				const result = await listWorkspace({ path: fixtureRoot, maxDepth: 5, hidden: false, gitignore: true });
				if (!result.entries.some(entry => entry.path.endsWith("component-000-needle.ts"))) {
					throw new Error("workspace listing omitted fixture source files");
				}
			},
		},
	],
	50,
).finally(async () => {
	await rm(fixtureRoot, { recursive: true, force: true });
});

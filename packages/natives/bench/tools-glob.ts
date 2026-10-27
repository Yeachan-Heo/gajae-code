import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileType, glob } from "../native/index.js";
import { runAbSuite } from "./ab-adapter";

const fixtureRoot = await createFixtureTree();

async function createFixtureTree(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "gjc-tools-glob-"));
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
		await writeFile(
			join(directory, `excluded-${group}.skip.ts`),
			`export const excluded${group} = otherThing(${group});\n`,
		);
		await writeFile(
			join(root, "ignored", `excluded-${group}.ts`),
			`export const ignored${group} = otherThing(${group});\n`,
		);
	}
	return root;
}

await runAbSuite(
	"tools:glob",
	[
		{
			// G01: walk nested TypeScript paths against a .gitignore fixture.
			id: "G01",
			run: async () => {
				// Disable walker caching so every sample includes a fresh filesystem traversal.
				const result = await glob({
					pattern: "**/*.ts",
					path: fixtureRoot,
					fileType: FileType.File,
					gitignore: true,
					cache: false,
					maxResults: 1000,
				});
				if (result.matches.length < 288) throw new Error(`expected at least 288 fixture files, got ${result.matches.length}`);
			},
		},
	],
	100,
).finally(async () => {
	await rm(fixtureRoot, { recursive: true, force: true });
});

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { astGrep, invalidateFsScanCache, summarizeCode } from "../native/index.js";
import { runAbSuite } from "./ab-adapter";

const fixtureRoot = await createFixtureTree();

async function createFixtureTree(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "gjc-tools-ast-grep-"));
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

// A realistic TypeScript module for structural summaries (C-SUMMARY).
const summarySource = Array.from({ length: 60 }, (_, index) =>
	[
		`/** Documented helper ${index}. */`,
		`export function helper${index}(value: number): number {`,
		...Array.from({ length: 8 }, (_, line) => `\tconst step${line} = value * ${line + 1} + ${index};`),
		"\treturn step7;",
		"}",
		"",
		`export class Service${index} {`,
		"\tmethod(input: string): string {",
		...Array.from({ length: 6 }, (_, line) => `\t\tinput = input.replace("${line}", "${index}");`),
		"\t\treturn input;",
		"\t}",
		"}",
		"",
	].join("\n"),
).join("\n");

await runAbSuite(
	"tools:ast_grep",
	[
		{
			// A01: parse the fixture tree and match a small TypeScript call pattern.
			id: "A01",
			run: async () => {
				// Clear the shared scan cache so samples include fresh candidate discovery.
				invalidateFsScanCache(fixtureRoot);
				const result = await astGrep({
					patterns: ["makeThing($A, $B)"],
					path: fixtureRoot,
					glob: "**/*.ts",
					limit: 400,
					includeMeta: false,
				});
				if (result.totalMatches !== 288) throw new Error(`expected 288 matches, got ${result.totalMatches}`);
			},
		},
		{
			// A02: structural summary of one TypeScript module (summarizeCode).
			id: "A02",
			run: async () => {
				const result = await summarizeCode({ code: summarySource, lang: "typescript", minBodyLines: 3 });
				if (!result.parsed || !result.elided || result.segments.length === 0) {
					throw new Error("summarizeCode did not parse and elide the module");
				}
			},
		},
	],
	20,
).finally(async () => {
	await rm(fixtureRoot, { recursive: true, force: true });
});

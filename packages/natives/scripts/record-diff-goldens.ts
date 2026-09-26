import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import * as Diff from "diff";

import { DIFF_MUTATION_SEEDS, loadDiffFixtureCorpus, seededDiffMutation } from "../test/differential/diff-corpus";

const goldenDir = path.join(import.meta.dir, "../test/fixtures/goldens/diff");

interface GoldenCase {
	fixture: string;
	seed: number;
	results: {
		diffLines: Diff.Change[];
		diffLineRuns: Array<Pick<Diff.Change, "count" | "added" | "removed">>;
		structuredPatchHunks: ReturnType<typeof Diff.structuredPatch>["hunks"];
		diffWords: Diff.Change[];
	};
}

function capture(oldText: string, newText: string): GoldenCase["results"] {
	const arrayRuns = Diff.diffArrays(oldText.split("\n"), newText.split("\n"));
	return {
		diffLines: Diff.diffLines(oldText, newText),
		diffLineRuns: arrayRuns.map(({ count, added, removed }) => ({ count, added, removed })),
		structuredPatchHunks: Diff.structuredPatch("old.txt", "new.txt", oldText, newText, "", "", { context: 3 }).hunks,
		diffWords: Diff.diffWords(oldText, newText),
	};
}

async function main() {
	if (!process.argv.includes("--write")) {
		throw new Error("Pass --write to explicitly record diff goldens from the current jsdiff oracle");
	}
	const { archiveSha256, files } = await loadDiffFixtureCorpus();
	const records: GoldenCase[] = [];
	for (const file of files) {
		for (const seed of DIFF_MUTATION_SEEDS) {
			records.push({
				fixture: file.name,
				seed,
				results: capture(file.text, seededDiffMutation(file.text, seed)),
			});
		}
	}

	await fs.mkdir(goldenDir, { recursive: true });
	const jsonl = `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
	await fs.writeFile(path.join(goldenDir, "corpus.jsonl.gz"), gzipSync(jsonl, { level: 9 }));
	await fs.writeFile(path.join(goldenDir, "accepted-divergences.json"), "[]\n");
	await fs.writeFile(
		path.join(goldenDir, "source.json"),
		`${JSON.stringify(
			{
				oracle: "diff@9.0.0",
				archive: "packages/typescript-edit-benchmark/fixtures.tar.gz",
				archiveSha256,
				seededMutations: DIFF_MUTATION_SEEDS,
				fixtureFiles: files.length,
				cases: records.length,
			},
			null,
			2,
		)}\n`,
	);
	console.log(`Recorded ${records.length} jsdiff cases from ${files.length} fixture files into ${goldenDir}`);
}

await main();

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { DiffSide, DiffStream, diffLineRuns, diffLines, diffWords, structuredPatchHunks } from "../../native/index.js";
import { DIFF_MUTATION_SEEDS, loadDiffFixtureCorpus, seededDiffMutation } from "./diff-corpus";

interface GoldenChange {
	value: string;
	count: number;
	added: boolean;
	removed: boolean;
}

interface GoldenRun {
	count: number;
	added: boolean;
	removed: boolean;
}

interface GoldenHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: string[];
}

interface DiffGolden {
	fixture: string;
	seed: number;
	results: {
		diffLines: GoldenChange[];
		diffLineRuns: GoldenRun[];
		structuredPatchHunks: GoldenHunk[];
		diffWords: GoldenChange[];
	};
}

interface GoldenSource {
	oracle: string;
	archive: string;
	archiveSha256: string;
	seededMutations: readonly number[];
	fixtureFiles: number;
	cases: number;
}

const goldenDir = path.resolve(import.meta.dir, "../fixtures/goldens/diff");

describe("native diff differential goldens", () => {
	test("matches jsdiff 9.0.0 over every benchmark fixture and seeded mutation", async () => {
		const [sourceText, compressedGoldens, divergencesText] = await Promise.all([
			fs.readFile(path.join(goldenDir, "source.json"), "utf8"),
			fs.readFile(path.join(goldenDir, "corpus.jsonl.gz")),
			fs.readFile(path.join(goldenDir, "accepted-divergences.json"), "utf8"),
		]);

		const source = JSON.parse(sourceText) as GoldenSource;
		expect(JSON.parse(divergencesText)).toEqual([]);
		const corpus = await loadDiffFixtureCorpus();
		expect(source.oracle).toBe("diff@9.0.0");
		expect(source.archive).toBe("packages/typescript-edit-benchmark/fixtures.tar.gz");
		expect(source.archiveSha256).toBe(corpus.archiveSha256);
		expect(source.seededMutations).toEqual(DIFF_MUTATION_SEEDS);
		expect(source.fixtureFiles).toBe(corpus.files.length);

		const records = gunzipSync(compressedGoldens)
			.toString("utf8")
			.trimEnd()
			.split("\n")
			.map(line => JSON.parse(line) as DiffGolden);
		expect(records).toHaveLength(source.cases);
		const files = new Map(corpus.files.map(file => [file.name, file.text]));

		for (const record of records) {
			const oldText = files.get(record.fixture);
			if (oldText === undefined) throw new Error(`Golden refers to missing fixture ${record.fixture}`);
			if (!DIFF_MUTATION_SEEDS.includes(record.seed as (typeof DIFF_MUTATION_SEEDS)[number])) {
				throw new Error(`Golden has unexpected mutation seed ${record.seed}`);
			}
			const newText = seededDiffMutation(oldText, record.seed);
			const actual = {
				diffLines: diffLines(oldText, newText),
				diffLineRuns: diffLineRuns(oldText, newText),
				structuredPatchHunks: structuredPatchHunks(oldText, newText, 3),
				diffWords: diffWords(oldText, newText),
			};
			expect(actual, `${record.fixture} seed ${record.seed}`).toEqual(record.results);
		}
	}, 60_000);

	test("DiffStream exposes stable complete lines and the final native hunk result", async () => {
		const stream = new DiffStream();
		expect(stream.progress()).toEqual({
			oldLines: 0,
			newLines: 0,
			stableCommonLines: 0,
			oldDone: false,
			newDone: false,
			binary: false,
			tooLarge: false,
		});

		stream.push(DiffSide.Old, "same\nold");
		stream.push(DiffSide.New, "same\nnew");
		expect(stream.progress().stableCommonLines).toBe(1);
		stream.finishSide(DiffSide.Old);
		stream.finishSide(DiffSide.New);

		const result = await stream.finish(3);
		expect(stream.lines(DiffSide.Old, 0)).toEqual(["same", "old"]);
		expect(result.hunks).toEqual(structuredPatchHunks("same\nold", "same\nnew", 3));
		expect(result.oldEndsNewline).toBe(false);
		expect(result.newEndsNewline).toBe(false);
		expect(() => stream.push(DiffSide.Old, "late")).toThrow("Cannot push to a finished diff side");
	});
});

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type GrepOptions, type GrepResult, grep, invalidateFsScanCache } from "../native/index.js";
import { loadDiffFixtureCorpus } from "./differential/diff-corpus";

type GrepCase = { id: string; options: Omit<GrepOptions, "path"> };
type GrepOutput = ReturnType<typeof normalizeResult> | { error: string };

const cases: GrepCase[] = [
	{ id: "literal", options: { pattern: "TODO", maxCount: 20 } },
	{
		id: "regex",
		options: {
			pattern: String.raw`^\s*(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*`,
			glob: "**/*.ts",
			maxCount: 8,
		},
	},
	{
		id: "multiline",
		options: { pattern: String.raw`export[\s\S]{0,50}from\s+['"]`, multiline: true, maxCount: 4 },
	},
	{ id: "case-insensitive", options: { pattern: "FiXtUrE", ignoreCase: true, maxCount: 10 } },
	{ id: "glob-filter", options: { pattern: "TODO", glob: "**/input/*.ts", maxCount: 10 } },
	{
		id: "context-lines",
		options: { pattern: "export const", glob: "**/input/*.ts", contextBefore: 1, contextAfter: 1, maxCount: 3 },
	},
	{ id: "binary-skip", options: { pattern: "BINARY_NEEDLE", maxCount: 3 } },
	{ id: "pcre2-lookahead", options: { pattern: "export(?=\\s)", glob: "**/input/*.ts", maxCount: 4 } },
];

let temporaryRoot: string;
let fixtureRoot: string;
let archiveSha256: string;

function normalizeResult(result: GrepResult) {
	return {
		totalMatches: result.totalMatches,
		filesWithMatches: result.filesWithMatches,
		filesSearched: result.filesSearched,
		limitReached: result.limitReached ?? null,
		matches: result.matches.map(match => ({
			path: match.path,
			lineNumber: match.lineNumber,
			line: match.line,
			contextBefore: (match.contextBefore ?? []).map(context => ({
				lineNumber: context.lineNumber,
				line: context.line,
			})),
			contextAfter: (match.contextAfter ?? []).map(context => ({
				lineNumber: context.lineNumber,
				line: context.line,
			})),
			truncated: match.truncated ?? null,
			matchCount: match.matchCount ?? null,
		})),
	};
}

async function captureGrepCases(): Promise<{
	archiveSha256: string;
	cases: Array<{ id: string; output: GrepOutput }>;
}> {
	const outputs: Array<{ id: string; output: GrepOutput }> = [];
	for (const testCase of cases) {
		try {
			const result = await grep({
				...testCase.options,
				path: fixtureRoot,
				cache: true,
				maxColumns: 160,
			});
			outputs.push({ id: testCase.id, output: normalizeResult(result) });
		} catch (error) {
			outputs.push({ id: testCase.id, output: { error: error instanceof Error ? error.message : String(error) } });
		}
	}
	return { archiveSha256, cases: outputs };
}

describe("grep upstream re-sync", () => {
	beforeAll(async () => {
		const corpus = await loadDiffFixtureCorpus();
		archiveSha256 = corpus.archiveSha256;
		temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "natives-grep-resync-"));
		fixtureRoot = path.join(temporaryRoot, "fixtures");
		for (const fixture of corpus.files) {
			const outputPath = path.resolve(temporaryRoot, fixture.name);
			if (!outputPath.startsWith(`${temporaryRoot}${path.sep}`)) {
				throw new Error(`Fixture path escaped extraction root: ${fixture.name}`);
			}
			await fs.mkdir(path.dirname(outputPath), { recursive: true });
			await fs.writeFile(outputPath, fixture.text);
		}
		await fs.writeFile(path.join(fixtureRoot, "binary-skip.ts"), Buffer.from("BINARY_NEEDLE\0ignored\n"));
		invalidateFsScanCache(fixtureRoot);
	});

	afterAll(async () => {
		if (fixtureRoot) invalidateFsScanCache(fixtureRoot);
		if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true });
	});

	it("matches the pre-sync fixture corpus except for accepted PCRE2 syntax support", async () => {
		const output = await captureGrepCases();
		const goldenPath = path.join(import.meta.dir, "fixtures/goldens/grep/pre-sync.json");
		const expected = JSON.parse(await fs.readFile(goldenPath, "utf8")) as typeof output;
		const divergencePath = path.join(import.meta.dir, "fixtures/goldens/grep/accepted-divergences.json");
		const divergences = JSON.parse(await fs.readFile(divergencePath, "utf8")) as {
			divergences: Array<{ caseId: string; expected: GrepOutput }>;
		};
		const baselineById = new Map(expected.cases.map(testCase => [testCase.id, testCase.output]));
		const acceptedById = new Map(divergences.divergences.map(divergence => [divergence.caseId, divergence.expected]));

		expect(output.archiveSha256).toBe(expected.archiveSha256);
		expect(output.cases.map(testCase => testCase.id)).toEqual(expected.cases.map(testCase => testCase.id));
		expect([...acceptedById.keys()].sort()).toEqual(["pcre2-lookahead"]);
		for (const testCase of output.cases) {
			const baseline = baselineById.get(testCase.id);
			if (baseline === undefined) throw new Error(`Missing pre-sync grep case ${testCase.id}`);
			expect(testCase.output).toEqual(acceptedById.get(testCase.id) ?? baseline);
		}
	});
});

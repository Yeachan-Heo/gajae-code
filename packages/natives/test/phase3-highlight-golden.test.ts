import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { type HighlightColors, highlightCode, supportsLanguage } from "../native/index.js";

type HighlightGolden = {
	schemaVersion: number;
	source: string;
	cases: Array<{ id: string; language: string; code: string; output: string }>;
};
type HighlightCurrent = {
	schemaVersion: number;
	source: string;
	outputs: Record<string, string>;
};

type AcceptedDivergence = {
	caseId: string;
	reason: string;
	upstreamRationale: string;
	changelog: string;
	testsUpdated: string;
};

const fixtureRoot = `${import.meta.dir}/fixtures/goldens/highlight`;
const highlightGolden = JSON.parse(await readFile(`${fixtureRoot}/baseline.json`, "utf8")) as HighlightGolden;
const highlightCurrent = JSON.parse(await readFile(`${fixtureRoot}/current.json`, "utf8")) as HighlightCurrent;
const acceptedDivergences = JSON.parse(await readFile(`${fixtureRoot}/accepted-divergences.json`, "utf8")) as {
	schemaVersion: number;
	divergences: AcceptedDivergence[];
};

const HIGHLIGHT_COLORS: HighlightColors = {
	comment: "<c>",
	keyword: "<k>",
	function: "<f>",
	variable: "<v>",
	string: "<s>",
	number: "<n>",
	type: "<t>",
	operator: "<o>",
	punctuation: "<p>",
	inserted: "<i>",
	deleted: "<d>",
};

test("Phase 3 highlight output matches the synced multi-language golden and explicit divergence ledger", async () => {
	expect(highlightGolden.schemaVersion).toBe(1);
	expect(highlightCurrent.schemaVersion).toBe(1);
	expect(acceptedDivergences.schemaVersion).toBe(1);
	expect(highlightGolden.cases.map(testCase => testCase.id)).toEqual([
		"rust",
		"typescript",
		"tsx",
		"python",
		"nix",
		"julia",
		"mermaid",
		"astro",
		"diff",
	]);
	expect(Object.keys(highlightCurrent.outputs).sort()).toEqual(
		highlightGolden.cases.map(testCase => testCase.id).sort(),
	);

	const observedDivergences: string[] = [];
	for (const testCase of highlightGolden.cases) {
		const actual = highlightCode(testCase.code, testCase.language, HIGHLIGHT_COLORS);
		expect(actual, `synced output changed for ${testCase.id}`).toBe(highlightCurrent.outputs[testCase.id]);
		if (actual !== testCase.output) observedDivergences.push(testCase.id);
	}

	const declaredDivergences = acceptedDivergences.divergences.map(divergence => divergence.caseId);
	expect(declaredDivergences).toEqual(observedDivergences);
	for (const divergence of acceptedDivergences.divergences) {
		expect(divergence.reason.length).toBeGreaterThan(0);
		expect(divergence.upstreamRationale.length).toBeGreaterThan(0);
		expect(divergence.changelog).toBe("packages/natives/changelog.d/rust-porting-phase3-highlight.md");
		expect(divergence.testsUpdated).toBe("packages/natives/test/phase3-highlight-golden.test.ts");
	}
	const changelog = await readFile(`${import.meta.dir}/../changelog.d/rust-porting-phase3-highlight.md`, "utf8");
	expect(changelog.trim().length).toBeGreaterThan(0);
}, 20_000);

test("Phase 3 bundled syntaxes expose their language aliases", () => {
	for (const language of ["nix", "julia", "mermaid", "mmd", "typescript", "tsx", "astro"]) {
		expect(supportsLanguage(language), `${language} should resolve to a bundled syntax`).toBe(true);
	}
});

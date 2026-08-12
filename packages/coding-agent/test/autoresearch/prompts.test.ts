import { describe, expect, it } from "bun:test";
import { renderAutoresearchIteratePrompt, renderAutoresearchSetupPrompt } from "../../src/autoresearch/prompts";
import iteratePromptTemplate from "../../src/autoresearch/prompts/prompt.md" with { type: "text" };
import setupPromptTemplate from "../../src/autoresearch/prompts/prompt-setup.md" with { type: "text" };

const DEAD_TOOL_NAMES = ["init_experiment", "run_experiment", "log_experiment", "update_notes", "~/.gjc/autoresearch"];

/** Remove the sanctioned path refs (`./autoresearch.sh`, session state) before dead-reference checks. */
function stripLegitPathRefs(text: string): string {
	return text.replaceAll("./autoresearch.sh", "harness.sh").replaceAll("_session-{id}/autoresearch", "session-state");
}

describe("autoresearch two-phase prompts", () => {
	it("imports both phases as static markdown text", () => {
		expect(setupPromptTemplate).toContain("## Autoresearch Mode");
		expect(setupPromptTemplate).toContain("Phase 1");
		expect(iteratePromptTemplate).toContain("## Autoresearch Mode");
		expect(iteratePromptTemplate).toContain("autonomous experiment loop");
	});

	it("phase 1 (harness setup) renders the harness contract", () => {
		const rendered = renderAutoresearchSetupPrompt({
			baseSystemPrompt: "BASE",
			goal: "Optimize the tokenizer hot path",
			workingDir: "/repo",
			branch: "autoresearch/tokenizer-20260812",
		});
		expect(rendered).toContain("BASE");
		expect(rendered).toContain("Phase 1: Harness Setup");
		expect(rendered).toContain("./autoresearch.sh");
		expect(rendered).toContain("METRIC <name>=<value>");
		expect(rendered).toContain("bash autoresearch.sh");
		expect(rendered).toContain("Optimize the tokenizer hot path");
		expect(rendered).toContain("autoresearch/tokenizer-20260812");
		expect(rendered).toContain("gjc autoresearch");
	});

	it("phase 1 renders the goal-less branch with baseline warning", () => {
		const rendered = renderAutoresearchSetupPrompt({
			baseSystemPrompt: "BASE",
			goal: "",
			workingDir: "/repo",
			branch: null,
			baselineWarning: "Worktree is dirty (x.txt). Continuing on the current branch.",
		});
		expect(rendered).not.toContain("Primary goal (for context");
		expect(rendered).toContain("Worktree is dirty (x.txt)");
		expect(rendered).toContain("Infer what to optimise");
	});

	it("phase 2 (iterate) renders goal, branch, baseline, and recent runs", () => {
		const rendered = renderAutoresearchIteratePrompt({
			baseSystemPrompt: "BASE",
			goal: "Optimize the tokenizer hot path",
			workingDir: "/repo",
			branch: "autoresearch/tokenizer-20260812",
			baselineCommit: "abcdef0123456789",
			metricName: "latency_ms",
			metricUnit: "ms",
			notes: "vectorization hypothesis pending",
			currentSegment: 1,
			currentSegmentRunCount: 2,
			baselineMetric: 14,
			bestMetric: 12.5,
			bestRunNumber: 2,
			recentRuns: [
				{
					run_number: 1,
					status: "keep",
					metric_display: "14ms",
					description: "baseline",
					has_asi_summary: false,
					asi_summary: "",
					has_deviations: false,
					deviations: "",
					justified: true,
					flagged: false,
					flagged_reason: "",
				},
				{
					run_number: 2,
					status: "keep",
					metric_display: "12.5ms",
					description: "vectorized inner loop",
					has_asi_summary: true,
					asi_summary: "hypothesis: cache bound",
					has_deviations: true,
					deviations: "vendor/bench.c",
					justified: false,
					flagged: false,
					flagged_reason: "",
				},
			],
			unjustifiedRuns: [{ run_number: 2, paths: "vendor/bench.c" }],
			pendingRun: null,
		});
		expect(rendered).toContain("BASE");
		expect(rendered).toContain("Optimize the tokenizer hot path");
		expect(rendered).toContain("autoresearch/tokenizer-20260812");
		expect(rendered).toContain("Baseline commit: `abcdef012345`");
		expect(rendered).toContain("baseline `latency_ms`: `14ms`");
		expect(rendered).toContain("best kept `latency_ms`: `12.50ms` from run `#2`");
		expect(rendered).toContain("run `#2`: `keep` `12.5ms` — vectorized inner loop");
		expect(rendered).toContain("ASI: hypothesis: cache bound");
		expect(rendered).toContain("Modified outside scope: vendor/bench.c (no justification)");
		expect(rendered).toContain("Unjustified deviations");
		expect(rendered).toContain("vectorization hypothesis pending");
		expect(rendered).toContain("Run ledger");
	});

	it("phase 2 renders a pending run and the no-goal branch", () => {
		const rendered = renderAutoresearchIteratePrompt({
			baseSystemPrompt: "BASE",
			goal: "",
			workingDir: "/repo",
			branch: null,
			baselineCommit: null,
			metricName: "latency_ms",
			metricUnit: "ms",
			notes: "",
			currentSegment: 1,
			currentSegmentRunCount: 1,
			baselineMetric: null,
			bestMetric: null,
			bestRunNumber: null,
			recentRuns: [],
			unjustifiedRuns: [],
			pendingRun: { runNumber: 3, command: "bash autoresearch.sh", parsedPrimary: 11.9, passed: true },
		});
		expect(rendered).toContain("Infer what to optimize");
		expect(rendered).toContain("Pending run");
		expect(rendered).toContain("run: `#3`");
		expect(rendered).toContain("parsed `latency_ms`: `11.90ms`");
		expect(rendered).toContain("result: passed");
	});

	it("carries no references to the deleted extension surface or global store", () => {
		const setup = renderAutoresearchSetupPrompt({
			baseSystemPrompt: "B",
			goal: "g",
			workingDir: "/repo",
			branch: "autoresearch/x",
		});
		const iterate = renderAutoresearchIteratePrompt({
			baseSystemPrompt: "B",
			goal: "g",
			workingDir: "/repo",
			branch: "autoresearch/x",
			baselineCommit: null,
			metricName: "m",
			metricUnit: "",
			notes: "",
			currentSegment: 1,
			currentSegmentRunCount: 0,
			baselineMetric: null,
			bestMetric: null,
			bestRunNumber: null,
			recentRuns: [],
			unjustifiedRuns: [],
			pendingRun: null,
		});

		for (const text of [setupPromptTemplate, iteratePromptTemplate, setup, iterate]) {
			const normalized = stripLegitPathRefs(text);
			// The dead `/autoresearch` slash command must never return; the only
			// remaining `/autoresearch` tokens are the sanctioned harness/state paths.
			expect(normalized).not.toContain("/autoresearch");
			for (const dead of DEAD_TOOL_NAMES) {
				expect(normalized).not.toContain(dead);
			}
		}
		// Session-scoped state is the sanctioned location.
		expect(iteratePromptTemplate).toContain(".gjc/_session-{id}/autoresearch/");
		expect(iteratePromptTemplate).toContain("bash autoresearch.sh");
		expect(iteratePromptTemplate).toContain("METRIC name=value");
		expect(iteratePromptTemplate).toContain("ASI key=value");
	});
});

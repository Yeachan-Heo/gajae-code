import { describe, expect, it } from "bun:test";
import {
	type AutoresearchDashboardInput,
	renderCollapsedLine,
	renderDashboardLines,
	renderExpandedDashboard,
	renderExpandedHeader,
} from "../../src/autoresearch/dashboard";
import {
	type AutoresearchExperimentState,
	type AutoresearchRunRecord,
	buildAutoresearchExperimentState,
	createAutoresearchExperimentConfig,
} from "../../src/autoresearch/runs";

function runRecord(
	overrides: Partial<AutoresearchRunRecord> & {
		runNumber: number;
		metric: number;
		status: AutoresearchRunRecord["status"];
	},
): AutoresearchRunRecord {
	const base: AutoresearchRunRecord = {
		runId: `run-${overrides.runNumber}`,
		runNumber: 0,
		segment: 0,
		command: "bash autoresearch.sh",
		startedAt: 0,
		completedAt: 1,
		durationMs: 1000,
		exitCode: 0,
		timedOut: false,
		status: null,
		description: "",
		metric: 0,
		metrics: {},
		asi: null,
		commitHash: null,
		confidence: null,
		preRunDirtyPaths: [],
		modifiedPaths: [],
		scopeDeviations: [],
		justification: null,
		flagged: false,
		flaggedReason: null,
		loggedAt: 1,
		abandonedAt: null,
	};
	return { ...base, ...overrides };
}

function sampleState(_overrides: Partial<AutoresearchExperimentState> = {}): AutoresearchExperimentState {
	const config = createAutoresearchExperimentConfig({
		name: "tokenizer bench",
		goal: "Optimize the tokenizer hot path",
		primaryMetric: "latency_ms",
		metricUnit: "ms",
		direction: "lower",
		secondaryMetrics: ["peak_mem_mb"],
	});
	const runs: AutoresearchRunRecord[] = [
		runRecord({
			runNumber: 1,
			metric: 10,
			status: "keep",
			commitHash: "abc123",
			description: "baseline run",
			metrics: { peak_mem_mb: 100 },
		}),
		runRecord({
			runNumber: 2,
			metric: 7,
			status: "keep",
			commitHash: "def456",
			description: "vectorized inner loop",
			metrics: { peak_mem_mb: 95 },
		}),
		runRecord({
			runNumber: 3,
			metric: 99,
			status: "crash",
			commitHash: null,
			description: "segfault in hot path",
			exitCode: 1,
		}),
		runRecord({
			runNumber: 4,
			metric: 6,
			status: "keep",
			commitHash: "ghi789",
			description: "tabs\tand   spacing",
			metrics: { peak_mem_mb: 90 },
		}),
	];
	return buildAutoresearchExperimentState(config, runs);
}

describe("autoresearch TUI dashboard", () => {
	it("renders a collapsed one-line summary with run/kept counts and the baseline", () => {
		const line = renderCollapsedLine({ state: sampleState() });
		expect(line).toContain("autoresearch");
		expect(line).toContain("4 runs");
		expect(line).toContain("3 kept");
		expect(line).toContain("1 crash");
		expect(line).toContain("baseline 10ms");
		expect(line).toContain("best 6ms");
	});

	it("collapsed line reflects a pending unlogged run", () => {
		const line = renderCollapsedLine({
			state: sampleState(),
			runtime: { modeOn: true, pendingRun: { runNumber: 5, passed: true, parsedPrimary: 5.5 } },
		});
		expect(line).toContain("pending run #5");
		expect(line).toContain("pass");
		expect(line).toContain("latency_ms=5.50ms");
		expect(line).toContain("log required");
	});

	it("renders the expanded header with the session name", () => {
		const header = renderExpandedHeader({ state: sampleState() }, 80);
		expect(header).toContain("autoresearch: tokenizer bench");
		expect(header).toContain("ctrl+x collapse");
	});

	it("renders the expanded run table with per-row status and description", () => {
		const lines = renderDashboardLines({ state: sampleState() }, 120, 0);
		const table = lines.join("\n");
		expect(table).toContain("Current segment: 4 runs  3 kept  0 discarded  1 crashed  0 checks_failed");
		expect(table).toContain("Baseline: 10ms (#1)");
		expect(table).toContain("Best: 6ms (#4) -40.0%");
		expect(table).toContain(`${"1".padEnd(4)}abc123`);
		expect(table).toContain("keep");
		expect(table).toContain("segfault in hot path");
		expect(table).toContain("conf 2.0x");
	});

	it("keeps only the last maxRows rows and marks hidden earlier runs", () => {
		const lines = renderDashboardLines({ state: sampleState() }, 120, 2);
		const table = lines.join("\n");
		expect(table).toContain("... 2 earlier runs hidden ...");
		expect(table).toContain("ghi789"); // run 4 visible
		expect(table).not.toContain("abc123"); // run 1 hidden
	});

	it("sanitizes text: tabs are expanded and lines are width-truncated", () => {
		const narrow = renderDashboardLines({ state: sampleState() }, 40, 0);
		for (const line of narrow) {
			expect(line.includes("\t")).toBe(false);
			expect([...line].length).toBeLessThanOrEqual(41);
		}
		const full = renderDashboardLines({ state: sampleState() }, 120, 0);
		expect(full.join("\n")).toContain("tabs   and   spacing"); // tab expanded to spaces
	});

	it("renders the empty state before any run exists", () => {
		const empty = createAutoresearchExperimentConfig({
			name: "fresh",
			primaryMetric: "latency_ms",
			metricUnit: "ms",
		});
		const state = buildAutoresearchExperimentState(empty, []);
		const input: AutoresearchDashboardInput = { state, runtime: { modeOn: true } };
		expect(renderCollapsedLine(input)).toContain("baseline pending");
		const lines = renderDashboardLines(input);
		expect(lines.join("\n")).toContain("Baseline: pending");
		expect(lines.join("\n")).toContain("run and log the baseline experiment");
	});

	it("excludes flagged keep runs from the rendered best result", () => {
		const config = createAutoresearchExperimentConfig({
			name: "flagged",
			primaryMetric: "latency_ms",
			direction: "lower",
		});
		for (const [baseline, candidate] of [
			[10, 1],
			[1, 10],
		] as const) {
			const direction = baseline < candidate ? "higher" : "lower";
			const state = buildAutoresearchExperimentState({ ...config, direction }, [
				runRecord({ runNumber: 1, metric: baseline, status: "keep", description: "baseline" }),
				runRecord({ runNumber: 2, metric: candidate, status: "keep", flagged: true, description: "flagged" }),
			]);
			expect(renderDashboardLines({ state }, 120).join("\n")).toContain(`Best: ${baseline}`);
		}
	});

	it("renderExpandedDashboard combines header and body", () => {
		const text = renderExpandedDashboard({ state: sampleState() }, 120, 0);
		expect(text).toContain("autoresearch: tokenizer bench");
		expect(text).toContain("Current segment: 4 runs");
		expect(text).toContain("Best: 6ms (#4)");
	});
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AutoresearchMode,
	autoresearchBranchIsolation,
	autoresearchDashboardText,
	autoresearchDataContext,
	autoresearchHarnessOutput,
	autoresearchIssueVerdict,
	autoresearchIteratePrompt,
	autoresearchMissionPythonTool,
	autoresearchMissionReport,
	autoresearchRunsStore,
	autoresearchSetupPrompt,
	autoresearchWrite,
} from "../../src/gjc-runtime/autoresearch-runtime";

const TEST_SESSION_ID = "capabilities-test-session";
const tempRoots: string[] = [];
let previousGjcSessionId: string | undefined;

beforeAll(() => {
	previousGjcSessionId = process.env.GJC_SESSION_ID;
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
});

afterAll(() => {
	if (previousGjcSessionId === undefined) {
		delete process.env.GJC_SESSION_ID;
	} else {
		process.env.GJC_SESSION_ID = previousGjcSessionId;
	}
});

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-autoresearch-capabilities-"));
	tempRoots.push(dir);
	return dir;
}

async function seedMissionWithRuns(root: string, mode: AutoresearchMode): Promise<void> {
	await autoresearchWrite({
		cwd: root,
		objective: "Optimize the tokenizer hot path",
		mode,
		deliverables: ["Benchmark report"],
		constraints: ["No public API change"],
		slug: "tokenizer-mission",
	});
	const store = await autoresearchRunsStore(root, TEST_SESSION_ID);
	if (!store.config) throw new Error("expected a mission-derived experiment config");
	store.config.primaryMetric = "latency_ms";
	store.config.metricUnit = "ms";
	await store.saveConfig(store.config);
	const first = await store.startRun({ command: "bash autoresearch.sh" });
	await store.completeRun(first.runId, { exitCode: 0, timedOut: false, durationMs: 1000 });
	await store.logRun(first.runId, { status: "keep", description: "baseline", metric: 14 });
	const second = await store.startRun({ command: "bash autoresearch.sh" });
	await store.completeRun(second.runId, { exitCode: 0, timedOut: false, durationMs: 800 });
	await store.logRun(second.runId, { status: "keep", description: "vectorized", metric: 12 });
}

describe("autoresearch capability surface reachable from the runtime", () => {
	it("1: branch isolation is reachable and degrades gracefully without a repo", async () => {
		const root = await tempDir();
		const result = await autoresearchBranchIsolation(root, "Optimize the tokenizer");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.branchName).toBeNull();
			expect(result.warning).toContain("Not in a git repository");
		}
	});

	it("2: harness output parsing is reachable from the runtime", () => {
		const parsed = autoresearchHarnessOutput("noise\nMETRIC latency_ms=9.4\nASI tip=keep going", "latency_ms");
		expect(parsed.primary).toBe(9.4);
		expect(parsed.asi).toEqual({ tip: "keep going" });
	});

	it("3+4: run storage feeds the dashboard render through the runtime", async () => {
		const root = await tempDir();
		await seedMissionWithRuns(root, "data");

		const dashboard = await autoresearchDashboardText(root, TEST_SESSION_ID, 120);
		expect(dashboard).toContain("autoresearch: tokenizer-mission");
		expect(dashboard).toContain("2 runs");
		expect(dashboard).toContain("2 kept");
		expect(dashboard).toContain("Baseline: 14ms (#1)");
		expect(dashboard).toContain("Best: 12ms (#2)");
	});

	it("5: the mission python tool + notebook writer are reachable from the runtime", async () => {
		const root = await tempDir();
		await seedMissionWithRuns(root, "data");
		const handle = await autoresearchMissionPythonTool(root, TEST_SESSION_ID);
		expect(handle).not.toBeNull();
		expect(handle!.tool.name).toBe("python");
		expect(path.basename(handle!.paths.notebookPath)).toBe("notebook.ipynb");
		expect(handle!.notebook.cellCount).toBe(0);
		expect(handle!.mission.slug).toBe("tokenizer-mission");
	});

	it("6: the mission report is reachable and carries the verdict", async () => {
		const root = await tempDir();
		await seedMissionWithRuns(root, "mixed");
		await autoresearchIssueVerdict({
			cwd: root,
			status: { verdict: "best_effort", confidence: 0.8 },
			evidence: ["latency down 14%"],
			caveats: [],
			evaluator: "mission-agent",
			slug: "tokenizer-mission",
		});

		const report = await autoresearchMissionReport(root, "Final summary", TEST_SESSION_ID);
		expect(report).toContain("# Autoresearch report: Optimize the tokenizer hot path");
		expect(report).toContain("Final summary");
		expect(report).toContain("## Verdict");
		expect(report).toContain("- Evaluator: mission-agent");
		expect(report).toContain("latency down 14%");
	});

	it("7: data context is gated by mission mode through the runtime", async () => {
		const root = await tempDir();
		await fs.writeFile(path.join(root, "DATA.md"), "# dataset\n", "utf-8");

		await autoresearchWrite({
			cwd: root,
			objective: "Web research",
			mode: "web",
			slug: "web-mission",
		});
		expect(await autoresearchDataContext(root, undefined, TEST_SESSION_ID)).toBeNull();

		await autoresearchWrite({
			cwd: root,
			objective: "Data research",
			mode: "data",
			slug: "data-mission",
		});
		const context = await autoresearchDataContext(root, undefined, TEST_SESSION_ID);
		expect(context).not.toBeNull();
		expect(context!.content).toContain("# dataset");
	});

	it("8: both phase prompts are reachable from the runtime", async () => {
		const root = await tempDir();
		await seedMissionWithRuns(root, "data");

		const setup = await autoresearchSetupPrompt("BASE", root, "Optimize the tokenizer", TEST_SESSION_ID);
		expect(setup).toContain("Phase 1: Harness Setup");
		expect(setup).toContain("autoresearch.sh");

		const iterate = await autoresearchIteratePrompt("BASE", root, TEST_SESSION_ID);
		expect(iterate).toContain("Autoresearch Mode");
		expect(iterate).toContain("baseline `latency_ms`");
		expect(iterate).toContain("run `#1`: `keep`");
	});
});

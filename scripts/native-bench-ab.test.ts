import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	assessLatencyCase,
	assessLatencyRound,
	finalVerdictAfterReruns,
	assertBaselineIdentity,
	parseNativeBenchOptions,
	parseRssCapture,
	validateBenchAdapter,
	withDetachedWorktree,
	BenchError,
	formatBenchError,
	BENCH_SCHEMA,
} from "./native-bench-ab";

const tempRoots: string[] = [];
afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function gitFixture(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-ab-test-"));
	tempRoots.push(root);
	for (const args of [["init", "-q"], ["config", "user.email", "native-ab@test.invalid"], ["config", "user.name", "Native AB Test"]]) {
		const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	}
	await fs.writeFile(path.join(root, "README.txt"), "fixture\n");
	const add = Bun.spawnSync(["git", "add", "README.txt"], { cwd: root, stdout: "pipe", stderr: "pipe" });
	if (add.exitCode !== 0) throw new Error(add.stderr.toString());
	const commit = Bun.spawnSync(["git", "commit", "-qm", "test fixture"], { cwd: root, stdout: "pipe", stderr: "pipe" });
	if (commit.exitCode !== 0) throw new Error(commit.stderr.toString());
	return root;
}

const declaredEditCases = ["H01", "H02", "H06"];
const report = (cases: unknown[]) => ({ schema: BENCH_SCHEMA, suite: "edit-hotspots", cases });

describe("native bench A/B contract", () => {
	test("parses the documented suite, base, calibration and RSS flags", () => {
		expect(parseNativeBenchOptions(["--suite", "edit-hotspots", "--base", "HEAD", "--calibrate", "--json"])).toMatchObject({
			suite: "edit-hotspots",
			base: "HEAD",
			calibrate: true,
			blocks: 15,
			iterations: 200,
		});
		expect(parseNativeBenchOptions(["--suite", "grep", "--base", "main", "--rss", "S1,S3,S7", "--allow-baseline-drift"]).rss).toEqual(["S1", "S3", "S7"]);
		expect(parseNativeBenchOptions(["--suite", "rss", "--base", "HEAD", "--calibrate"]).suite).toBe("rss");
		expect(() => parseNativeBenchOptions(["--suite", "edit-hotspots"])).toThrow("--base");
	});
	test("surfaces BaselineIdentityMismatch unless baseline drift is explicit", () => {
		expect(() => assertBaselineIdentity("base-sha", "head-sha", false, false)).toThrow();
		expect(() => assertBaselineIdentity("base-sha", "head-sha", true, false)).not.toThrow();
		expect(() => assertBaselineIdentity("base-sha", "head-sha", true, true)).toThrow("--calibrate requires");
		expect(formatBenchError(new BenchError("BaselineIdentityMismatch", "drift not authorized"))).toMatchObject({ verdict: "ERROR", error: "BaselineIdentityMismatch" });
		expect(formatBenchError(new BenchError("RssScenarioNotMeasured", "scenario deferred")).verdict).toBe("FAIL");
		expect(formatBenchError(new BenchError("MissingCase", "case omitted")).verdict).toBe("FAIL");
		expect(formatBenchError(new BenchError("SkippedCase", "case skipped")).verdict).toBe("FAIL");
	});

	test("validates adapter schema and requires every declared measured case", () => {
		const valid = report(declaredEditCases.map(id => ({ id, status: "measured", samples: [0.5, 0.6] })));
		expect(validateBenchAdapter(valid, "edit-hotspots", declaredEditCases).cases).toHaveLength(3);
		expect(() => validateBenchAdapter(report(declaredEditCases.slice(0, 2).map(id => ({ id, status: "measured", samples: [1] }))), "edit-hotspots", declaredEditCases)).toThrow("omitted declared case");
		expect(() => validateBenchAdapter(report(declaredEditCases.map((id, index) => ({ id, status: index === 2 ? "skipped" : "measured", samples: index === 2 ? [] : [1] }))), "edit-hotspots", declaredEditCases)).toThrow("status=skipped");
		expect(() => validateBenchAdapter(report(declaredEditCases.map(id => ({ id, status: "measured", samples: [] }))), "edit-hotspots", declaredEditCases)).toThrow("zero samples");
		expect(() => validateBenchAdapter({ schema: "wrong", suite: "edit-hotspots", cases: [] }, "edit-hotspots", declaredEditCases)).toThrow("must use");
	});

	test("case verdicts distinguish PASS, FAIL, and INCONCLUSIVE with bounded reruns", () => {
		const pass = assessLatencyCase("same", Array(15).fill(1), Array(15).fill(1));
		expect(pass.verdict).toBe("PASS");
		const fail = assessLatencyCase("slow", Array(15).fill(1), Array(15).fill(1.2));
		expect(fail.verdict).toBe("FAIL");
		const uncertainHead = Array(14).fill(1).concat(2);
		const inconclusive = assessLatencyCase("noisy", Array(15).fill(1), uncertainHead);
		expect(inconclusive.verdict).toBe("INCONCLUSIVE");
		expect(assessLatencyRound([pass, inconclusive])).toBe("INCONCLUSIVE");
		expect(finalVerdictAfterReruns(["INCONCLUSIVE", "INCONCLUSIVE", "INCONCLUSIVE"])).toBe("FAIL");
		expect(finalVerdictAfterReruns(["INCONCLUSIVE", "PASS"])).toBe("PASS");
	});

	test("an RSS checkpoint only passes when every selected scenario is measured", () => {
		const valid = JSON.stringify({ scenarios: [{ id: "S1", status: "measured", rssBytes: { stableTree: { median: 4_000_000 } } }, { id: "S2", status: "measured", rssBytes: { stableTree: { median: 5_000_000 } } }] });
		expect(parseRssCapture(valid, ["S1", "S2"])).toEqual({ S1: 4_000_000, S2: 5_000_000 });
		const deferred = JSON.stringify({ scenarios: [{ id: "S1", status: "deferred" }] });
		expect(() => parseRssCapture(deferred, ["S1"])).toThrow("status must be measured");
		expect(() => parseRssCapture("{}", ["S1"])).toThrow("missing a scenarios array");
	});

	test("removes a detached base worktree when benchmark callback fails", async () => {
		const root = await gitFixture();
		const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe" }).stdout.toString().trim();
		await expect(withDetachedWorktree(root, sha, async () => {
			throw new Error("injected adapter failure");
		}, { prepare: false })).rejects.toThrow("injected adapter failure");
		const worktrees = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], { cwd: root, stdout: "pipe" }).stdout.toString();
		expect(worktrees).toContain(root);
		expect(worktrees).not.toContain(`${path.sep}base\n`);
	});
});

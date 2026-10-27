import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AB_ADAPTER_SUPPORT,
	assessLatencyCase,
	assessLatencyRound,
	finalVerdictAfterReruns,
	assertBaselineIdentity,
	assertCpuLoadWithinLimit,
	benchExitCode,
	parseNativeBenchOptions,
	parseRssCapture,
	requireRssBuildArtifact,
	retryRssSampler,
	validateBenchAdapter,
	installHeadAdapter,
	withDetachedWorktree,
	BenchError,
	formatBenchError,
	BENCH_SCHEMA,
	MAX_RSS_SAMPLER_ATTEMPTS,
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

const declaredEditCases = ["H01", "H02", "H03", "H06"];
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
		expect(parseNativeBenchOptions(["--suite", "word-diff", "--base", "HEAD"]).suite).toBe("word-diff");
		expect(() => parseNativeBenchOptions(["--suite", "edit-hotspots"])).toThrow("--base");
	});
	test("uses a suite's default iterations unless --iterations is explicit", () => {
		expect(parseNativeBenchOptions(["--suite", "builtins", "--base", "HEAD"]).iterations).toBe(20);
		expect(parseNativeBenchOptions(["--suite", "builtins", "--base", "HEAD", "--iterations", "50"]).iterations).toBe(50);
		expect(parseNativeBenchOptions(["--suite", "grep", "--base", "HEAD"]).iterations).toBe(200);
		expect(parseNativeBenchOptions(["--suite", "word-diff", "--base", "HEAD"]).iterations).toBe(20);
		expect(() => parseNativeBenchOptions(["--suite", "builtins", "--base", "HEAD", "--iterations", "0"])).toThrow(
			"--iterations",
		);
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

	test("CPU load saturation reports HostTooNoisy with a distinct exit code", () => {
		expect(assertCpuLoadWithinLimit(2, 4)).toBeUndefined();
		expect(() => assertCpuLoadWithinLimit(2.01, 4)).toThrow("exceeds 50% of 4 physical cores");
		expect(formatBenchError(new BenchError("HostTooNoisy", "load limit exceeded"))).toMatchObject({
			verdict: "HostTooNoisy",
			error: "HostTooNoisy",
		});
		expect(benchExitCode("HostTooNoisy")).toBe(3);
		expect(benchExitCode("FAIL")).toBe(2);
	});

	test("reports BuildArtifactMissing when the RSS binary is absent for a side", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-ab-artifact-test-"));
		tempRoots.push(root);
		const error = await requireRssBuildArtifact(root, "base").catch(value => value);
		expect(error).toMatchObject({
			code: "BuildArtifactMissing",
			message: expect.stringContaining("Compiled RSS artifact for base is missing"),
		});
	});

	test("retries transient zero RSS readings and uses the later measurement", async () => {
		let attempts = 0;
		const capture = await retryRssSampler(async () => {
			attempts += 1;
			if (attempts < 3) throw new BenchError("RssSamplerUnavailable", "zero RSS reading");
			return { S1: 4_000_000 };
		});
		expect(attempts).toBe(3);
		expect(capture).toEqual({ S1: 4_000_000 });
	});

	test("exhausted zero RSS retries return HostTooNoisy, not FAIL", async () => {
		let attempts = 0;
		const zero = JSON.stringify({ scenarios: [{ id: "S1", status: "measured", rssBytes: { stableTree: { median: 0 } } }] });
		const error = await retryRssSampler(async () => {
			attempts += 1;
			return parseRssCapture(zero, ["S1"]);
		}).catch(value => value);
		expect(attempts).toBe(MAX_RSS_SAMPLER_ATTEMPTS);
		expect(formatBenchError(error)).toMatchObject({ verdict: "HostTooNoisy", error: "HostTooNoisy" });
	});

	test("validates adapter schema and requires every declared measured case", () => {
		const valid = report(declaredEditCases.map(id => ({ id, status: "measured", samples: [0.5, 0.6] })));
		expect(validateBenchAdapter(valid, "edit-hotspots", declaredEditCases).cases).toHaveLength(declaredEditCases.length);
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
		const uncertainHead = Array(8).fill(1).concat(Array(7).fill(1.2));
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

	test("installs the head adapter bytes into the base worktree before timing", async () => {
		const root = await gitFixture();
		const adapter = "bench/adapter.ts";
		await fs.mkdir(path.join(root, "bench"));
		await fs.writeFile(path.join(root, adapter), "export const side = 'base';\n");
		for (const args of [["add", adapter], ["commit", "-qm", "base adapter"]]) {
			Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
		}
		const baseSha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe" }).stdout.toString().trim();
		const headBytes = "export const side = 'head';\n";
		await fs.writeFile(path.join(root, adapter), headBytes);
		const installed = await withDetachedWorktree(root, baseSha, async baseRoot => {
			const digest = await installHeadAdapter(root, baseRoot, adapter);
			return { digest, text: await Bun.file(path.join(baseRoot, adapter)).text() };
		}, { prepare: false });
		expect(installed.text).toBe(headBytes);
		expect(installed.digest).toBe(new Bun.CryptoHasher("sha256").update(headBytes).digest("hex"));
	});

	test("installs the shared adapter driver next to the adapter when the head has one", async () => {
		const root = await gitFixture();
		const adapter = "packages/natives/bench/suite.ts";
		await fs.mkdir(path.join(root, "packages/natives/bench"), { recursive: true });
		const baseSha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe" }).stdout.toString().trim();
		const adapterBytes = "import { runAbSuite } from './ab-adapter';\n";
		const supportBytes = "export function runAbSuite() {}\n";
		await fs.writeFile(path.join(root, adapter), adapterBytes);
		await fs.writeFile(path.join(root, AB_ADAPTER_SUPPORT), supportBytes);
		const installed = await withDetachedWorktree(root, baseSha, async baseRoot => ({
			digest: await installHeadAdapter(root, baseRoot, adapter),
			support: await Bun.file(path.join(baseRoot, AB_ADAPTER_SUPPORT)).text(),
		}), { prepare: false });
		expect(installed.support).toBe(supportBytes);
		expect(installed.digest).toBe(new Bun.CryptoHasher("sha256").update(adapterBytes).update(supportBytes).digest("hex"));
	});
});

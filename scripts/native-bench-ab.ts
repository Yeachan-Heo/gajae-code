#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { platform } from "node:os";

export const BENCH_SCHEMA = "gjc.native-bench-ab/1";
export const RSS_SCENARIOS = ["S1", "S2", "S3", "S4", "S5", "S7"] as const;
export const DEFAULT_BLOCKS = 15;
export const DEFAULT_ITERATIONS = 200;
export const BOOTSTRAP_RESAMPLES = 10_000;

export type BenchStatus = "measured" | "skipped" | "error";
export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE";
export interface BenchCase {
	id: string;
	status: BenchStatus;
	samples: number[];
}
export interface BenchAdapterReport {
	schema: string;
	suite: string;
	cases: BenchCase[];
}
export interface ConfidenceInterval {
	lower: number;
	upper: number;
}
export interface LatencyCaseResult {
	id: string;
	verdict: Verdict;
	p50: ConfidenceInterval;
	p95: ConfidenceInterval;
	baseSamples: number[];
	headSamples: number[];
}
export interface ParsedOptions {
	suite: string;
	base: string;
	calibrate: boolean;
	allowBaselineDrift: boolean;
	blocks: number;
	iterations: number;
	rss: string[];
}

const SUITES: Record<string, { adapter: string; actualSuite: string; cases: string[] }> = {
	"edit-hotspots": { adapter: "packages/natives/bench/edit-hotspots.ts", actualSuite: "edit-hotspots", cases: ["H01", "H02", "H06"] },
	grep: { adapter: "packages/natives/bench/grep.ts", actualSuite: "grep", cases: ["G01", "G02", "G03", "G04", "G05", "G06", "G07", "G08"] },
	"natives-grep": { adapter: "packages/natives/bench/grep.ts", actualSuite: "grep", cases: ["G01", "G02", "G03", "G04", "G05", "G06", "G07", "G08"] },
	rss: { adapter: "", actualSuite: "rss", cases: [] },
};

export class BenchError extends Error {
	constructor(readonly code: string, message: string, readonly details?: unknown) {
		super(message);
		this.name = code;
	}
}

export function parseNativeBenchOptions(args: readonly string[]): ParsedOptions {
	let suite = "";
	let base = "";
	let calibrate = false;
	let allowBaselineDrift = false;
	let blocks = DEFAULT_BLOCKS;
	let iterations = DEFAULT_ITERATIONS;
	let rss: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		const value = args[index + 1];
		if (arg === "--suite" && value) {
			suite = value;
			index += 1;
		} else if (arg === "--base" && value) {
			base = value;
			index += 1;
		} else if (arg === "--blocks" && value) {
			blocks = Number(value);
			index += 1;
		} else if (arg === "--iterations" && value) {
			iterations = Number(value);
			index += 1;
		} else if (arg === "--rss" && value) {
			rss = value.split(",").map(item => item.trim()).filter(Boolean);
			index += 1;
		} else if (arg === "--calibrate") calibrate = true;
		else if (arg === "--allow-baseline-drift") allowBaselineDrift = true;
		else if (arg === "--json") continue;
		else throw new BenchError("InvalidArguments", `unknown option or missing value: ${arg}`);
	}
	if (!suite || !SUITES[suite]) throw new BenchError("InvalidSuite", `--suite must be one of: ${Object.keys(SUITES).join(", ")}`);
	if (!base) throw new BenchError("MissingBase", "--base <git-ref> is required");
	if (!Number.isInteger(blocks) || blocks < 1) throw new BenchError("InvalidBlocks", "--blocks must be a positive integer");
	if (!Number.isInteger(iterations) || iterations < 1) throw new BenchError("InvalidIterations", "--iterations must be a positive integer");
	const invalidRss = rss.filter(id => !(RSS_SCENARIOS as readonly string[]).includes(id));
	if (invalidRss.length) throw new BenchError("InvalidRssScenario", `unsupported RSS scenarios: ${invalidRss.join(", ")}`);
	if (new Set(rss).size !== rss.length) throw new BenchError("InvalidRssScenario", "RSS scenario list must not contain duplicates");
	return { suite, base, calibrate, allowBaselineDrift, blocks, iterations, rss };
}

export function validateBenchAdapter(value: unknown, suite: string, expectedCaseIds: readonly string[]): BenchAdapterReport {
	if (value === null || typeof value !== "object") throw new BenchError("AdapterSchema", "adapter output must be a JSON object");
	const record = value as Record<string, unknown>;
	if (record.schema !== BENCH_SCHEMA || record.suite !== suite || !Array.isArray(record.cases)) {
		throw new BenchError("AdapterSchema", `adapter output must use ${BENCH_SCHEMA} for suite ${suite}`);
	}
	const cases: BenchCase[] = [];
	const seen = new Set<string>();
	for (const raw of record.cases) {
		if (raw === null || typeof raw !== "object") throw new BenchError("AdapterSchema", "adapter case must be an object");
		const item = raw as Record<string, unknown>;
		if (typeof item.id !== "string" || !["measured", "skipped", "error"].includes(String(item.status)) || !Array.isArray(item.samples)) {
			throw new BenchError("AdapterSchema", "adapter case must contain id, measured/skipped/error status, and samples[]");
		}
		if (seen.has(item.id)) throw new BenchError("AdapterSchema", `duplicate adapter case id ${item.id}`);
		seen.add(item.id);
		const samples = item.samples;
		if (samples.some(sample => typeof sample !== "number" || !Number.isFinite(sample) || sample <= 0)) {
			throw new BenchError("AdapterSchema", `case ${item.id} samples must be finite positive numbers`);
		}
		cases.push({ id: item.id, status: item.status as BenchStatus, samples: samples as number[] });
	}
	const missing = expectedCaseIds.filter(id => !seen.has(id));
	if (missing.length) throw new BenchError("MissingCase", `adapter omitted declared case(s): ${missing.join(", ")}`);
	const unexpected = [...seen].filter(id => !expectedCaseIds.includes(id));
	if (unexpected.length) throw new BenchError("UnexpectedCase", `adapter emitted undeclared case(s): ${unexpected.join(", ")}`);
	for (const item of cases) {
		if (item.status !== "measured") throw new BenchError("SkippedCase", `${item.id} status=${item.status}`);
		if (item.samples.length === 0) throw new BenchError("EmptySamples", `${item.id} returned zero samples`);
	}
	return { schema: BENCH_SCHEMA, suite, cases };
}

function quantile(values: readonly number[], probability: number): number {
	if (values.length === 0) throw new BenchError("EmptySamples", "cannot calculate a quantile without samples");
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(probability * sorted.length) - 1));
	return sorted[index] ?? 0;
}

function randomIndex(seedState: { value: number }, length: number): number {
	let value = seedState.value;
	value ^= value << 13;
	value ^= value >>> 17;
	value ^= value << 5;
	seedState.value = value >>> 0;
	return seedState.value % length;
}

export function pairedBootstrapRatio(
	base: readonly number[],
	head: readonly number[],
	probability: number,
	seed = 0x6a09e667,
	resamples = BOOTSTRAP_RESAMPLES,
): ConfidenceInterval {
	if (base.length === 0 || base.length !== head.length) throw new BenchError("SamplePairMismatch", "base and head require the same non-zero number of paired blocks");
	if (base.some(value => !Number.isFinite(value) || value <= 0) || head.some(value => !Number.isFinite(value) || value <= 0)) {
		throw new BenchError("InvalidSamples", "latency samples must be finite and positive");
	}
	const state = { value: seed >>> 0 || 1 };
	const ratios: number[] = [];
	for (let run = 0; run < resamples; run += 1) {
		const baseResample: number[] = [];
		const headResample: number[] = [];
		for (let sample = 0; sample < base.length; sample += 1) {
			const index = randomIndex(state, base.length);
			baseResample.push(base[index] ?? 0);
			headResample.push(head[index] ?? 0);
		}
		ratios.push(quantile(headResample, probability) / quantile(baseResample, probability));
	}
	return { lower: quantile(ratios, 0.025), upper: quantile(ratios, 0.975) };
}

/** Bootstrap the mean block statistic, keeping each base/head block paired. */
export function pairedBootstrapMeanRatio(
	base: readonly number[],
	head: readonly number[],
	seed = 0x6a09e667,
	resamples = BOOTSTRAP_RESAMPLES,
): ConfidenceInterval {
	if (base.length === 0 || base.length !== head.length) throw new BenchError("SamplePairMismatch", "base and head require the same non-zero number of paired blocks");
	if (base.some(value => !Number.isFinite(value) || value <= 0) || head.some(value => !Number.isFinite(value) || value <= 0)) {
		throw new BenchError("InvalidSamples", "latency samples must be finite and positive");
	}
	const state = { value: seed >>> 0 || 1 };
	const ratios: number[] = [];
	for (let run = 0; run < resamples; run += 1) {
		let baseSum = 0;
		let headSum = 0;
		for (let block = 0; block < base.length; block += 1) {
			const index = randomIndex(state, base.length);
			baseSum += base[index] ?? 0;
			headSum += head[index] ?? 0;
		}
		ratios.push(headSum / baseSum);
	}
	return { lower: quantile(ratios, 0.025), upper: quantile(ratios, 0.975) };
}

export function assertBaselineIdentity(baseSha: string, headSha: string, allowBaselineDrift: boolean, calibrate: boolean): void {
	if (baseSha !== headSha && !allowBaselineDrift) {
		throw new BenchError("BaselineIdentityMismatch", `base ${baseSha} differs from head ${headSha}; use --allow-baseline-drift to compare revisions`);
	}
	if (calibrate && baseSha !== headSha) throw new BenchError("BaselineIdentityMismatch", "--calibrate requires --base to resolve to HEAD");
}
export function assessLatencyCase(
	id: string,
	baseBlocks: readonly number[],
	headBlocks: readonly number[],
): LatencyCaseResult {
	const p50 = pairedBootstrapMeanRatio(baseBlocks, headBlocks, 0x6a09e667);
	const p95 = pairedBootstrapMeanRatio(baseBlocks, headBlocks, 0xbb67ae85);
	let verdict: Verdict = "INCONCLUSIVE";
	if (p50.upper <= 1.03 && p95.upper <= 1.10) verdict = "PASS";
	else if (p50.lower > 1.03 || p95.lower > 1.10) verdict = "FAIL";
	return { id, verdict, p50, p95, baseSamples: [...baseBlocks], headSamples: [...headBlocks] };
}

export function assessLatencyRound(caseResults: readonly LatencyCaseResult[]): Verdict {
	if (caseResults.length === 0 || caseResults.some(result => result.verdict === "FAIL")) return "FAIL";
	if (caseResults.some(result => result.verdict === "INCONCLUSIVE")) return "INCONCLUSIVE";
	return "PASS";
}

export function finalVerdictAfterReruns(rounds: readonly Verdict[]): Verdict {
	if (rounds.length === 0) return "FAIL";
	for (const verdict of rounds) {
		if (verdict !== "INCONCLUSIVE") return verdict;
	}
	return "FAIL";
}

export function summarizeBlock(samples: readonly number[]): { p50: number; p95: number } {
	return { p50: quantile(samples, 0.5), p95: quantile(samples, 0.95) };
}

function getCase(report: BenchAdapterReport, id: string): BenchCase {
	const match = report.cases.find(item => item.id === id);
	if (!match) throw new BenchError("MissingCase", `missing declared case ${id}`);
	return match;
}

async function readJsonStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	return new Response(stream).text();
}

async function runJsonCommand(command: string[], cwd: string, timeoutMs = 10 * 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
	const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, timeoutMs);
	const [stdout, stderr, code] = await Promise.all([readJsonStream(child.stdout), readJsonStream(child.stderr), child.exited]);
	clearTimeout(timer);
	if (timedOut) return { code: 124, stdout, stderr: stderr || `command timed out after ${timeoutMs}ms` };
	return { code, stdout, stderr };
}

export async function runBenchAdapter(root: string, suite: string, iterations: number): Promise<BenchAdapterReport> {
	const config = SUITES[suite];
	if (!config) throw new BenchError("InvalidSuite", `unknown suite ${suite}`);
	const result = await runJsonCommand([
		process.execPath,
		config.adapter,
		"--json",
		"--strict",
		"--iterations",
		String(iterations),
	], root);
	let output: unknown;
	try {
		output = JSON.parse(result.stdout.trim());
	} catch {
		throw new BenchError("AdapterError", `benchmark adapter did not emit JSON (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
	}
	return validateBenchAdapter(output, config.actualSuite, config.cases);
}

async function git(root: string, args: string[]): Promise<string> {
	const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new BenchError("GitError", result.stderr.toString().trim() || `git ${args.join(" ")} failed`);
	return result.stdout.toString().trim();
}

export async function resolveCommit(root: string, ref: string): Promise<string> {
	return git(root, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

export async function withDetachedWorktree<T>(
	repoRoot: string,
	commit: string,
	callback: (worktreePath: string) => Promise<T>,
	options: { prepare?: boolean } = {},
): Promise<T> {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-ab-"));
	const worktreePath = path.join(tempRoot, "base");
	let added = false;
	try {
		await git(repoRoot, ["worktree", "add", "--detach", worktreePath, commit]);
		added = true;
		if (options.prepare !== false) {
			const prepared = await runJsonCommand(["bun", "run", "setup:worktree"], worktreePath);
			if (prepared.code !== 0) throw new BenchError("WorktreeSetupFailed", prepared.stderr || prepared.stdout);
		}
		return await callback(worktreePath);
	} finally {
		if (added) {
			const removed = Bun.spawnSync(["git", "worktree", "remove", "--force", worktreePath], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
			if (removed.exitCode !== 0) throw new BenchError("WorktreeCleanupFailed", removed.stderr.toString().trim() || `failed to remove base worktree ${worktreePath}`);
		}
		await fs.rm(tempRoot, { recursive: true, force: true });
	}
}

export interface RssCapture {
	metadata?: Record<string, unknown>;
	scenarios: Array<{ id: string; status?: string; rssBytes?: { stableTree?: { median?: number } } }>;
}

export function parseRssCapture(json: string, scenarioIds: readonly string[]): Record<string, number> {
	let report: RssCapture;
	try {
		report = JSON.parse(json) as RssCapture;
	} catch {
		throw new BenchError("RssCaptureInvalid", "verify-rss-checkpoints did not emit JSON");
	}
	if (!report || typeof report !== "object" || !Array.isArray(report.scenarios)) {
		throw new BenchError("RssCaptureInvalid", "RSS report is missing a scenarios array");
	}
	const byId = new Map(report.scenarios.map(scenario => [scenario.id, scenario]));
	const values: Record<string, number> = {};
	for (const id of scenarioIds) {
		const scenario = byId.get(id);
		if (!scenario || scenario.status !== "measured") throw new BenchError("RssScenarioNotMeasured", `${id} status must be measured`);
		const median = scenario.rssBytes?.stableTree?.median;
		if (typeof median !== "number" || !Number.isFinite(median) || median <= 0) throw new BenchError("RssMetricMissing", `${id} stableTree median is missing or invalid`);
		values[id] = median;
	}
	return values;
}

function makeLatencyResult(baseReports: BenchAdapterReport[], headReports: BenchAdapterReport[], caseIds: readonly string[]): LatencyCaseResult[] {
	return caseIds.map(id => {
		const baseP50: number[] = [];
		const headP50: number[] = [];
		const baseP95: number[] = [];
		const headP95: number[] = [];
		for (const report of baseReports) {
			const block = summarizeBlock(getCase(report, id).samples);
			baseP50.push(block.p50);
			baseP95.push(block.p95);
		}
		for (const report of headReports) {
			const block = summarizeBlock(getCase(report, id).samples);
			headP50.push(block.p50);
			headP95.push(block.p95);
		}
		const p50 = pairedBootstrapMeanRatio(baseP50, headP50, 0x6a09e667);
		const p95 = pairedBootstrapMeanRatio(baseP95, headP95, 0xbb67ae85);
		let verdict: Verdict = "INCONCLUSIVE";
		if (p50.upper <= 1.03 && p95.upper <= 1.10) verdict = "PASS";
		else if (p50.lower > 1.03 || p95.lower > 1.10) verdict = "FAIL";
		return { id, verdict, p50, p95, baseSamples: baseP50, headSamples: headP50 };
	});
}

async function collectLatencyRound(
	baseRoot: string,
	headRoot: string,
	suite: string,
	caseIds: readonly string[],
	blocks: number,
	iterations: number,
): Promise<{ base: BenchAdapterReport[]; head: BenchAdapterReport[]; cases: LatencyCaseResult[]; verdict: Verdict }> {
	const base: BenchAdapterReport[] = [];
	const head: BenchAdapterReport[] = [];
	for (let block = 0; block < blocks; block += 1) {
		const baseFirst = block % 2 === 0;
		const first = await runBenchAdapter(baseFirst ? baseRoot : headRoot, suite, iterations);
		const second = await runBenchAdapter(baseFirst ? headRoot : baseRoot, suite, iterations);
		if (baseFirst) {
			base.push(first);
			head.push(second);
		} else {
			head.push(first);
			base.push(second);
		}
	}
	const cases = makeLatencyResult(base, head, caseIds);
	return { base, head, cases, verdict: assessLatencyRound(cases) };
}

async function captureRssOnce(root: string, ids: readonly string[]): Promise<Record<string, number>> {
	const result = await runJsonCommand(["bun", "scripts/verify-rss-checkpoints.ts", "--all", "--json"], root);
	if (result.code !== 0) throw new BenchError("RssCaptureFailed", result.stderr || result.stdout);
	return parseRssCapture(result.stdout, ids);
}

async function runRssGate(baseRoot: string, headRoot: string, ids: readonly string[]): Promise<{ verdict: Verdict; scenarios: Record<string, { verdict: Verdict; ci: ConfidenceInterval; base: number[]; head: number[] }>; legacyEnvelope: { baselinePath: string; regressions: number } }> {
	if (ids.length === 0) return { verdict: "PASS", scenarios: {}, legacyEnvelope: { baselinePath: "", regressions: 0 } };
	const baseBuild = await runJsonCommand(["bun", "--cwd=packages/coding-agent", "run", "build"], baseRoot);
	if (baseBuild.code !== 0) throw new BenchError("RssBuildFailed", `base: ${baseBuild.stderr || baseBuild.stdout}`);
	const headBuild = await runJsonCommand(["bun", "--cwd=packages/coding-agent", "run", "build"], headRoot);
	if (headBuild.code !== 0) throw new BenchError("RssBuildFailed", `head: ${headBuild.stderr || headBuild.stdout}`);
	let count = 5;
	let result: ReturnType<typeof compareRssCaptures> | undefined;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const base: Record<string, number[]> = Object.fromEntries(ids.map(id => [id, [] as number[]]));
		const head: Record<string, number[]> = Object.fromEntries(ids.map(id => [id, [] as number[]]));
		for (let capture = 0; capture < count; capture += 1) {
			const baseCapture = await captureRssOnce(baseRoot, ids);
			const headCapture = await captureRssOnce(headRoot, ids);
			for (const id of ids) {
				base[id]?.push(baseCapture[id] ?? 0);
				head[id]?.push(headCapture[id] ?? 0);
			}
		}
		result = compareRssCaptures(ids, base, head);
		if (result.verdict !== "INCONCLUSIVE") break;
		count = 10;
	}
	if (!result) throw new BenchError("RssCaptureFailed", "RSS gate produced no measurements");
	const legacyEnvelope = await runLegacyRssEnvelope(baseRoot, headRoot);
	const verdict: Verdict = result.verdict === "INCONCLUSIVE" || legacyEnvelope.regressions > 0 ? "FAIL" : result.verdict;
	return { ...result, verdict, legacyEnvelope };
}

async function runLegacyRssEnvelope(baseRoot: string, headRoot: string): Promise<{ baselinePath: string; regressions: number }> {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-ab-rss-"));
	try {
		const baseRun = await runJsonCommand(["bun", "scripts/verify-rss-checkpoints.ts", "--all", "--write-baseline", "--json"], baseRoot);
		if (baseRun.code !== 0) throw new BenchError("RssBaselineFailed", baseRun.stderr || baseRun.stdout);
		const baseReport = JSON.parse(baseRun.stdout) as { outputPath?: string; metadata?: { gitCommit?: string } };
		if (!baseReport.outputPath || !baseReport.metadata?.gitCommit) throw new BenchError("RssBaselineInvalid", "base RSS baseline report lacks outputPath or commit identity");
		const baselinePath = path.join(tempRoot, "rss-base.json");
		await fs.copyFile(baseReport.outputPath, baselinePath);
		const headRun = await runJsonCommand([
			"bun", "scripts/verify-rss-checkpoints.ts", "--all", "--compare", "--baseline", baselinePath, "--allow-baseline-drift", "--json",
		], headRoot);
		if (headRun.code !== 0) throw new BenchError("RssLegacyCompareFailed", headRun.stderr || headRun.stdout);
		const headReport = JSON.parse(headRun.stdout) as { regressions?: unknown[] };
		const regressions = headReport.regressions?.length;
		if (regressions === undefined) throw new BenchError("RssLegacyCompareInvalid", "head RSS compare report is missing regressions");
		return { baselinePath, regressions };
	} finally {
		await fs.rm(tempRoot, { recursive: true, force: true });
	}
}
function compareRssCaptures(ids: readonly string[], base: Record<string, number[]>, head: Record<string, number[]>): { verdict: Verdict; scenarios: Record<string, { verdict: Verdict; ci: ConfidenceInterval; base: number[]; head: number[] }> } {
	const scenarios: Record<string, { verdict: Verdict; ci: ConfidenceInterval; base: number[]; head: number[] }> = {};
	let overall: Verdict = "PASS";
	for (const id of ids) {
		const baseSamples = base[id] ?? [];
		const headSamples = head[id] ?? [];
		const ci = pairedBootstrapRatio(baseSamples, headSamples, 0.5, 0x3c6ef372);
		const verdict: Verdict = ci.upper <= 1.05 ? "PASS" : ci.lower > 1.05 ? "FAIL" : "INCONCLUSIVE";
		scenarios[id] = { verdict, ci, base: baseSamples, head: headSamples };
		if (verdict === "FAIL") overall = "FAIL";
		else if (verdict === "INCONCLUSIVE" && overall !== "FAIL") overall = "INCONCLUSIVE";
	}
	return { verdict: overall, scenarios };
}

async function buildNative(root: string): Promise<void> {
	const build = await runJsonCommand(["bun", "run", "build:native"], root);
	if (build.code !== 0) throw new BenchError("NativeBuildFailed", build.stderr || build.stdout);
}

export async function runNativeBenchAb(repoRoot: string, options: ParsedOptions): Promise<Record<string, unknown>> {
	const config = SUITES[options.suite];
	if (!config) throw new BenchError("InvalidSuite", `unknown suite ${options.suite}`);
	const baseSha = await resolveCommit(repoRoot, options.base);
	const headSha = await resolveCommit(repoRoot, "HEAD");
	assertBaselineIdentity(baseSha, headSha, options.allowBaselineDrift, options.calibrate);
	await buildNative(repoRoot);
	if (options.suite === "rss") {
		const scenarios = options.rss.length ? options.rss : [...RSS_SCENARIOS];
		const runRss = (baseRoot: string) => runRssGate(baseRoot, repoRoot, scenarios);
		if (options.calibrate) {
			return {
				schema: BENCH_SCHEMA,
				mode: "A/A calibration",
				suite: options.suite,
				baseSha,
				headSha,
				host: { platform: platform(), arch: process.arch, bun: Bun.version },
				...(await runRss(repoRoot)),
			};
		}
		return withDetachedWorktree(repoRoot, baseSha, async baseRoot => ({
			schema: BENCH_SCHEMA,
			mode: "A/B",
			suite: options.suite,
			baseSha,
			headSha,
			host: { platform: platform(), arch: process.arch, bun: Bun.version },
			...(await runRss(baseRoot)),
		}));
	}
	const run = async (baseRoot: string) => {
		const rounds: Array<Record<string, unknown>> = [];
		const summary: Array<{ blocks: number; verdict: Verdict; cases: Array<Pick<LatencyCaseResult, "id" | "verdict" | "p50" | "p95">> }> = [];
		let verdict: Verdict = "INCONCLUSIVE";
		let currentBlocks = options.blocks;
		let finalCases: LatencyCaseResult[] = [];
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const measured = await collectLatencyRound(baseRoot, repoRoot, options.suite, config.cases, currentBlocks, options.iterations);
			finalCases = measured.cases;
			verdict = measured.verdict;
			rounds.push({ blocks: currentBlocks, verdict, cases: measured.cases, baseReports: measured.base, headReports: measured.head });
			summary.push({ blocks: currentBlocks, verdict, cases: measured.cases.map(({ id, verdict: caseVerdict, p50, p95 }) => ({ id, verdict: caseVerdict, p50, p95 })) });
			if (verdict !== "INCONCLUSIVE") break;
			currentBlocks *= 2;
		}
		if (verdict === "INCONCLUSIVE") verdict = "FAIL";
		const rss = options.rss.length ? await runRssGate(baseRoot, repoRoot, options.rss) : undefined;
		if (rss && rss.verdict !== "PASS") verdict = "FAIL";
		return { verdict, summary, rounds, cases: finalCases, rss };
	};
	if (options.calibrate) {
		const result = await run(repoRoot);
		return {
			schema: BENCH_SCHEMA,
			mode: "A/A calibration",
			suite: options.suite,
			baseSha,
			headSha,
			host: { platform: platform(), arch: process.arch, bun: Bun.version },
			...result,
		};
	}
	return withDetachedWorktree(repoRoot, baseSha, async baseRoot => ({
		schema: BENCH_SCHEMA,
		mode: "A/B",
		suite: options.suite,
		baseSha,
		headSha,
		host: { platform: platform(), arch: process.arch, bun: Bun.version },
		...(await run(baseRoot)),
	}));
}

export function formatBenchError(error: unknown): { schema: string; verdict: "FAIL" | "ERROR"; error: string; message: string } {
	const code = error instanceof BenchError ? error.code : "UnexpectedError";
	const failCodes = new Set(["SkippedCase", "MissingCase", "UnexpectedCase", "EmptySamples", "RssScenarioNotMeasured"]);
	return {
		schema: BENCH_SCHEMA,
		verdict: failCodes.has(code) ? "FAIL" : "ERROR",
		error: code,
		message: error instanceof Error ? error.message : String(error),
	};
}

export async function main(args = process.argv.slice(2)): Promise<number> {
	const repoRoot = path.resolve(import.meta.dir, "..");
	try {
		const options = parseNativeBenchOptions(args);
		const report = await runNativeBenchAb(repoRoot, options);
		console.log(JSON.stringify(report));
		return report.verdict === "PASS" ? 0 : 2;
	} catch (error) {
		const report = formatBenchError(error);
		console.log(JSON.stringify(report));
		return 2;
	}
}

if (import.meta.main) process.exit(await main());

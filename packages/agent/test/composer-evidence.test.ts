import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildEvidenceReport, scanTextForPublishSecrets } from "../bench/composer-evidence";
import {
	COMPOSER_SCENARIOS,
	COMPOSER_SCENARIOS_V1_COUNT,
	COMPOSER_SCENARIOS_VERSION,
	composerScenariosForVersion,
	L2_MIN_SCENARIO_COVERAGE,
	TOTAL_SCENARIO_COUNT,
} from "../bench/composer-scenarios";
import type { TraceRecord, TrialResult } from "../bench/composer-stability-v3";
import "../bench/composer-evidence-ab-compare";
import "../bench/composer-evidence-report";

describe("composer-scenarios SoT", () => {
	it("exports versioned scenarios with userPrompt", () => {
		expect(COMPOSER_SCENARIOS).toHaveLength(TOTAL_SCENARIO_COUNT);
		for (const s of COMPOSER_SCENARIOS) {
			expect(s.userPrompt.length).toBeGreaterThan(20);
		}
	});

	it("bumps v2 with hard-guard and recovery scenarios", () => {
		expect(COMPOSER_SCENARIOS_VERSION).toBe("v2");
		expect(COMPOSER_SCENARIOS.map(scenario => scenario.id)).toEqual(
			expect.arrayContaining([
				"hard-guard-feedback",
				"legitimate-bash-after-tools",
				"wrong-target-disambiguation",
				"malformed-edit-recovery",
				"cost-safe-timeout",
			]),
		);
	});

	it("keeps v1 historical reports on the v1 scenario denominator", () => {
		const v1Scenarios = composerScenariosForVersion("v1");
		const trials: TrialResult[] = [];
		for (const scenario of [
			...v1Scenarios,
			composerScenariosForVersion("v2").find(candidate => candidate.id === "hard-guard-feedback")!,
		]) {
			trials.push({
				scenarioId: scenario.id,
				modelRole: "candidate",
				model: "grok-build/grok-composer-2.5-fast",
				trial: trials.length,
				status: "passed",
				evidence: "ok",
			});
			trials.push({
				scenarioId: scenario.id,
				modelRole: "baseline",
				model: "openai-codex/gpt-5.5:low",
				trial: trials.length,
				status: "passed",
				evidence: "ok",
			});
		}

		const report = buildEvidenceReport(trials, {
			capture_mode: "trace-replay",
			comparison_kind: "historical-frozen-trace",
			composer_scenarios_version: "v1",
			planned_records: trials.length,
			captured_records: trials.length,
			trace_sha256: "trace-hash",
			manifest_sha256: "manifest-hash",
		});

		expect(v1Scenarios).toHaveLength(COMPOSER_SCENARIOS_V1_COUNT);
		expect(report.composer_scenarios_version).toBe("v1");
		expect(report.scenario_coverage).toBe(COMPOSER_SCENARIOS_V1_COUNT);
		expect(report.scenario_coverage_ratio).toBe(`${COMPOSER_SCENARIOS_V1_COUNT}/${COMPOSER_SCENARIOS_V1_COUNT}`);
		expect(report.k_per_scenario_role["hard-guard-feedback"]).toBeUndefined();
	});
});

describe("composer-evidence report", () => {
	function passingMatrixTrials(k: number): TrialResult[] {
		const trials: TrialResult[] = [];
		let trial = 0;
		for (const scenario of COMPOSER_SCENARIOS) {
			for (let i = 0; i < k; i++) {
				trials.push({
					scenarioId: scenario.id,
					modelRole: "candidate",
					model: "grok-build/grok-composer-2.5-fast",
					trial: trial++,
					status: "passed",
					evidence: "ok",
				});
				trials.push({
					scenarioId: scenario.id,
					modelRole: "baseline",
					model: "openai-codex/gpt-5.5:low",
					trial: trial++,
					status: "passed",
					evidence: "ok",
				});
			}
		}
		return trials;
	}

	it("l2Eligible false below L2_MIN coverage", () => {
		const trials: TrialResult[] = [
			{
				scenarioId: "bash-discipline",
				modelRole: "candidate",
				model: "grok-build/grok-composer-2.5-fast",
				trial: 0,
				status: "passed",
				evidence: "ok",
			},
			{
				scenarioId: "bash-discipline",
				modelRole: "baseline",
				model: "openai-codex/gpt-5.5:low",
				trial: 1,
				status: "passed",
				evidence: "ok",
			},
		];
		const report = buildEvidenceReport(trials);
		expect(report.scenario_coverage).toBe(1);
		expect(L2_MIN_SCENARIO_COVERAGE).toBe(10);
		expect(report.l2Eligible).toBe(false);
		expect(report.ladderMaxClaim).not.toBe("L2");
	});

	it("reports L3 refusal reasons for K=1 trace replay", () => {
		const trials: TrialResult[] = [
			{
				scenarioId: "bash-discipline",
				modelRole: "candidate",
				model: "grok-build/grok-composer-2.5-fast",
				trial: 0,
				status: "passed",
				evidence: "ok",
			},
			{
				scenarioId: "bash-discipline",
				modelRole: "baseline",
				model: "openai-codex/gpt-5.5:low",
				trial: 1,
				status: "passed",
				evidence: "ok",
			},
		];
		const report = buildEvidenceReport(trials, {
			capture_mode: "trace-replay",
			comparison_kind: "historical-frozen-trace",
			planned_records: 2,
			captured_records: 2,
			trace_sha256: "trace-hash",
			manifest_sha256: "manifest-hash",
		});

		expect(report.l3Eligible).toBe(false);
		expect(report.l3RefusalReasons).toEqual(
			expect.arrayContaining(["k_lt_3", "missing_scenario", "trace_replay_not_l3", "p1_not_passed"]),
		);
		expect(report.planned_records).toBe(2);
		expect(report.captured_records).toBe(2);
		expect(report.min_k_per_scenario_role).toBe(0);
		expect(report.model_ids.candidate).toEqual(["grok-build/grok-composer-2.5-fast"]);
		expect(report.candidate_model).toBe("grok-build/grok-composer-2.5-fast");
	});

	it("marks full K>=3 live print evidence L3 eligible", () => {
		const trials = passingMatrixTrials(3);
		const report = buildEvidenceReport(
			trials,
			{
				capture_mode: "print",
				planned_records: trials.length,
				captured_records: trials.length,
				expected_k_per_scenario_role: 3,
				trace_sha256: "trace-hash",
				manifest_sha256: "manifest-hash",
			},
			'{"schemaVersion":1,"trace_sha256":"trace-hash"}',
		);

		expect(report.l3Eligible).toBe(true);
		expect(report.ladderMaxClaim).toBe("L3");
		expect(report.l3RefusalReasons).toEqual([]);
		expect(report.min_k_per_scenario_role).toBe(3);
		expect(report.role_counts).toEqual({ candidate: 54, baseline: 54 });
		expect(report.planned_records).toBe(108);
		expect(report.captured_records).toBe(108);
		expect(report.trace_sha256).toBe("trace-hash");
		expect(report.manifest_sha256).toBe("manifest-hash");
	});

	it("refuses L3 for mixed model ids and partial captures", () => {
		const trials = passingMatrixTrials(3);
		trials[0] = { ...trials[0]!, model: "grok-build/grok-composer-2.5-slow" };
		const report = buildEvidenceReport(trials, {
			capture_mode: "print",
			planned_records: trials.length + 1,
			captured_records: trials.length,
			expected_k_per_scenario_role: 3,
			trace_sha256: "trace-hash",
			manifest_sha256: "manifest-hash",
		});

		expect(report.l3Eligible).toBe(false);
		expect(report.l3RefusalReasons).toEqual(expect.arrayContaining(["mixed_model_ids", "partial_capture"]));
		expect(report.candidate_model).toBe("mixed");
		expect(report.model_ids.candidate).toEqual([
			"grok-build/grok-composer-2.5-fast",
			"grok-build/grok-composer-2.5-slow",
		]);
	});

	it("manifest linter rejects local paths and credential-shaped values", () => {
		const mac = scanTextForPublishSecrets('{"path":"/Users/mac/secret"}');
		const linux = scanTextForPublishSecrets('{"path":"/home/alice/project"}');
		const windows = scanTextForPublishSecrets('{"path":"C:\\\\Users\\\\alice\\\\project"}');
		const temp = scanTextForPublishSecrets('{"path":"/tmp/composer-artifact/summary.json"}');
		const token = scanTextForPublishSecrets('{"auth":"Bearer abcdefghijklmnopqrstuvwxyz"}');
		const oauthJson = scanTextForPublishSecrets('{"OPENAI_OAUTH_TOKEN":"oauth-token-value-12345"}');

		expect(mac.findings).toContain("home_path");
		expect(linux.findings).toContain("linux_home_path");
		expect(windows.findings).toContain("windows_home_path");
		expect(temp.findings).toContain("temp_path");
		expect(token.findings).toContain("bearer_token");
		expect(oauthJson.findings).toContain("oauth_env_value");
		expect([mac, linux, windows, temp, token, oauthJson].every(result => !result.ok)).toBe(true);
	});

	it("A/B compare keeps arm labels out of capture_mode metadata", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "composer-ab-compare-"));
		const traceDir = path.join(tempDir, "traces");
		await fs.mkdir(traceDir, { recursive: true });
		const armA = path.join(traceDir, "arm-a.json");
		const armB = path.join(traceDir, "arm-b.json");
		const outPath = path.join(tempDir, "ab-report.json");
		const records = (candidateEvents: TraceRecord["events"]): TraceRecord[] => [
			{
				scenarioId: "bash-discipline",
				modelRole: "candidate",
				model: "grok-build/grok-composer-2.5-fast",
				trial: 0,
				events: candidateEvents,
				expected: {},
			},
			{
				scenarioId: "bash-discipline",
				modelRole: "baseline",
				model: "openai-codex/gpt-5.5:low",
				trial: 0,
				events: [],
				expected: {},
			},
		];

		await fs.writeFile(
			armA,
			JSON.stringify(
				records([
					{
						type: "tool_execution_end",
						toolName: "bash",
						status: "success",
						arguments: { command: "cat src/secret.ts" },
					},
				]),
			),
		);
		await fs.writeFile(armB, JSON.stringify(records([])));
		await fs.writeFile(
			path.join(tempDir, "provenance-manifest.json"),
			JSON.stringify({ schemaVersion: 1, composer_scenarios_version: "v1", record_count: 2 }),
		);

		const proc = Bun.spawn(
			[
				process.execPath,
				"packages/agent/bench/composer-evidence-ab-compare.ts",
				"--arm-a",
				armA,
				"--arm-a-version",
				"0.5.3",
				"--arm-b",
				armB,
				"--arm-b-version",
				"0.6.4",
				"--out",
				outPath,
			],
			{ cwd: path.resolve(import.meta.dir, "../../..") },
		);
		const stderr = await new Response(proc.stderr).text();
		const stdout = await new Response(proc.stdout).text();
		expect(await proc.exited).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).toContain('"reportArtifact": "ab-report.json"');
		expect(stdout).not.toContain(tempDir);

		const payloadText = await fs.readFile(outPath, "utf8");
		const payload = JSON.parse(payloadText) as {
			comparison_kind: string;
			disclaimer: string;
			arm_a: { composer_scenarios_version: string; scenario_coverage_ratio: string; trace_sha256?: string };
			arm_b: { composer_scenarios_version: string; scenario_coverage_ratio: string; trace_sha256?: string };
			comparison: { candidate_failure_count_delta_a_minus_b: number };
		};
		expect(payload.comparison.candidate_failure_count_delta_a_minus_b).toBe(0);
		expect(payload.comparison_kind).toBe("historical-frozen-trace");
		expect(payload.disclaimer).toContain("frozen trace corpora");
		expect(payload.disclaimer).toContain("same versioned Composer scenario prompts");
		expect(payload.disclaimer).not.toContain("composer-scenarios-v1");
		expect(payload.arm_a.scenario_coverage_ratio).toBe("1/13");
		expect(payload.arm_a.composer_scenarios_version).toBe("v1");
		expect(payload.arm_b.composer_scenarios_version).toBe("v1");
		expect(payload.arm_b.scenario_coverage_ratio).toBe("1/13");
		expect(payloadText).not.toContain("ab-arm-a");
		expect(payloadText).not.toContain("ab-arm-b");
	});
	it("A/B compare rejects publish-secret values in public payload fields", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "composer-ab-compare-lint-"));
		const traceDir = path.join(tempDir, "traces");
		await fs.mkdir(traceDir, { recursive: true });
		const armA = path.join(traceDir, "arm-a.json");
		const armB = path.join(traceDir, "arm-b.json");
		const outPath = path.join(tempDir, "ab-report.json");
		const records: TraceRecord[] = [
			{
				scenarioId: "bash-discipline",
				modelRole: "candidate",
				model: "grok-build/grok-composer-2.5-fast",
				trial: 0,
				events: [],
				expected: {},
			},
			{
				scenarioId: "bash-discipline",
				modelRole: "baseline",
				model: "openai-codex/gpt-5.5:low",
				trial: 0,
				events: [],
				expected: {},
			},
		];

		await fs.writeFile(armA, JSON.stringify(records));
		await fs.writeFile(armB, JSON.stringify(records));
		await fs.writeFile(
			path.join(tempDir, "provenance-manifest.json"),
			JSON.stringify({
				schemaVersion: 1,
				composer_scenarios_version: "/home/alice/scenarios",
				trace_sha256: "trace-hash",
				manifest_sha256: "manifest-hash",
				record_count: 2,
			}),
		);

		const proc = Bun.spawn(
			[
				process.execPath,
				"packages/agent/bench/composer-evidence-ab-compare.ts",
				"--arm-a",
				armA,
				"--arm-a-version",
				"Bearer abcdefghijklmnopqrstuvwxyz",
				"--arm-b",
				armB,
				"--arm-b-version",
				"0.6.4",
				"--out",
				outPath,
			],
			{
				cwd: path.resolve(import.meta.dir, "../../.."),
				env: { ...Bun.env, EVIDENCE_REPO_COMMIT: "/home/alice/worktree" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const stderr = await new Response(proc.stderr).text();
		const stdout = await new Response(proc.stdout).text();
		expect(await proc.exited).toBe(3);
		expect(stdout).toBe("");
		expect(stderr).toContain("composer-evidence-ab-compare: report linter failed");
		expect(stderr).toContain("linux_home_path");
		expect(stderr).toContain("bearer_token");
		expect(
			await fs.stat(outPath).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});
});

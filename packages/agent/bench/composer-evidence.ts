import {
	COMPOSER_SCENARIOS_VERSION,
	DEFAULT_CODEX_BASELINE_MODEL,
	DEFAULT_COMPOSER_CANDIDATE_MODEL,
	L2_MIN_SCENARIO_COVERAGE,
	type ScenarioDefinition,
	type ScenarioId,
	composerScenarioCountForVersion,
	composerScenariosForVersion,
} from "./composer-scenarios";
import type { P1Summary, TrialResult } from "./composer-stability-v3";
import { createP1Summary } from "./composer-stability-v3";

export type CaptureMode = "print" | "tmux" | "hermes-mcp" | "trace-replay";
export type ComparisonKind = "historical-frozen-trace" | "live-ab";

export type L3RefusalReason =
	| "k_lt_3"
	| "missing_baseline"
	| "missing_scenario"
	| "trace_replay_not_l3"
	| "manifest_linter_failed"
	| "mixed_scenario_versions"
	| "mixed_model_ids"
	| "partial_capture"
	| "p1_not_passed";

type ModelRoleCounts = {
	candidate: number;
	baseline: number;
};

type ModelIdsByRole = {
	candidate: string[];
	baseline: string[];
};

export type EvidenceReportMeta = {
	gjc_version?: string;
	git_sha?: string;
	capture_mode?: CaptureMode;
	comparison_kind?: ComparisonKind;
	composer_scenarios_version?: string;
	scenario_versions?: string[];
	discipline_injection_verified?: boolean;
	trace_artifacts?: string[];
	trace_sha256?: string;
	manifest_sha256?: string;
	planned_records?: number;
	captured_records?: number;
	expected_k_per_scenario_role?: number;
	actual_model_ids?: ModelIdsByRole;
};

export type PerScenarioEvidence = {
	id: ScenarioId;
	candidate_failures: number;
	baseline_failures: number;
	failure_classes: string[];
};

export type EvidenceReport = {
	schemaVersion: 1;
	generatedAt: string;
	ladderMaxClaim: "L0" | "L1" | "L2" | "L2-H" | "L3" | "none";
	p1: P1Summary;
	l2Eligible: boolean;
	l3Eligible: boolean;
	l3RefusalReasons: L3RefusalReason[];
	scenario_coverage: number;
	scenario_coverage_ratio: string;
	planned_records: number | null;
	captured_records: number;
	role_counts: ModelRoleCounts;
	k_per_scenario_role: Record<ScenarioId, ModelRoleCounts>;
	min_k_per_scenario_role: number;
	model_ids: ModelIdsByRole;
	composer_harness_failure_rate: number;
	baseline_failure_rate: number;
	parityDelta: number;
	per_scenario: PerScenarioEvidence[];
	composer_scenarios_version: string;
	candidate_model: string;
	baseline_model: string;
	trace_sha256?: string;
	manifest_sha256?: string;
	meta: EvidenceReportMeta;
	manifest_linter_ok: boolean;
	manifest_linter_findings: string[];
};

const SECRET_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
	{ id: "authorization_header", pattern: /\bAuthorization\s*:\s*Bearer\s+/i },
	{ id: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
	{ id: "openai_sk", pattern: /\bsk-[A-Za-z0-9]{20,}/ },
	{ id: "grok_env_value", pattern: /GROK_CLI_OAUTH_TOKEN\s*=\s*\S+/ },
	{
		id: "oauth_env_value",
		pattern: /\b(?:GROK_CLI_OAUTH_TOKEN|OPENAI(?:_CODEX)?_OAUTH_TOKEN|CODEX_OAUTH_TOKEN|OPENAI_API_KEY)["']?\s*[:=]\s*["']?[A-Za-z0-9._-]{12,}/i,
	},
	{ id: "home_path", pattern: /\/Users\/[^/\s"'`]+/ },
	{ id: "linux_home_path", pattern: /\/home\/[^/\s"'`]+/ },
	{ id: "windows_home_path", pattern: /[A-Za-z]:\\+Users\\+[^\\\s"'`]+/ },
	{ id: "temp_path", pattern: /(?:\/private)?\/tmp\/[^\s"'`]+/ },
	{ id: "tilde_home", pattern: /~\/\.[^\s'"]+/ },
];

export function scanTextForPublishSecrets(text: string): { ok: boolean; findings: string[] } {
	const findings: string[] = [];
	for (const { id, pattern } of SECRET_PATTERNS) {
		if (pattern.test(text)) findings.push(id);
	}
	return { ok: findings.length === 0, findings };
}

export function countScenarioCoverage(
	trialResults: TrialResult[],
	scenarios: readonly ScenarioDefinition[] = composerScenariosForVersion(COMPOSER_SCENARIOS_VERSION),
): number {
	const scenarioIds = new Set(scenarios.map(scenario => scenario.id));
	const candidateIds = new Set(
		trialResults.filter(r => scenarioIds.has(r.scenarioId) && r.modelRole === "candidate").map(r => r.scenarioId),
	);
	const baselineIds = new Set(
		trialResults.filter(r => scenarioIds.has(r.scenarioId) && r.modelRole === "baseline").map(r => r.scenarioId),
	);
	return Array.from(candidateIds).filter(id => baselineIds.has(id)).length;
}

export function buildPerScenarioEvidence(trialResults: TrialResult[]): PerScenarioEvidence[] {
	const byScenario = new Map<ScenarioId, PerScenarioEvidence>();
	for (const result of trialResults) {
		const existing = byScenario.get(result.scenarioId) ?? {
			id: result.scenarioId,
			candidate_failures: 0,
			baseline_failures: 0,
			failure_classes: [],
		};
		if (result.modelRole === "candidate" && result.status === "failed") {
			existing.candidate_failures += 1;
			for (const fc of result.failureClasses ?? []) {
				if (!existing.failure_classes.includes(fc)) existing.failure_classes.push(fc);
			}
		}
		if (result.modelRole === "baseline" && result.status === "failed") {
			existing.baseline_failures += 1;
			for (const fc of result.failureClasses ?? []) {
				if (!existing.failure_classes.includes(fc)) existing.failure_classes.push(fc);
			}
		}
		byScenario.set(result.scenarioId, existing);
	}
	return Array.from(byScenario.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function uniqueSorted(values: string[]): string[] {
	return Array.from(new Set(values.filter(value => value.trim().length > 0))).sort();
}

function buildRoleCounts(trialResults: TrialResult[]): ModelRoleCounts {
	return {
		candidate: trialResults.filter(result => result.modelRole === "candidate").length,
		baseline: trialResults.filter(result => result.modelRole === "baseline").length,
	};
}

function buildModelIds(trialResults: TrialResult[]): ModelIdsByRole {
	return {
		candidate: uniqueSorted(trialResults.filter(result => result.modelRole === "candidate").map(result => result.model)),
		baseline: uniqueSorted(trialResults.filter(result => result.modelRole === "baseline").map(result => result.model)),
	};
}

function modelLabel(models: string[], fallback: string): string {
	if (models.length === 0) return fallback;
	if (models.length === 1) return models[0]!;
	return "mixed";
}

function buildKPerScenarioRole(
	trialResults: TrialResult[],
	scenarios: readonly ScenarioDefinition[],
): Record<ScenarioId, ModelRoleCounts> {
	const counts = Object.fromEntries(
		scenarios.map(scenario => [scenario.id, { candidate: 0, baseline: 0 }]),
	) as Record<ScenarioId, ModelRoleCounts>;
	for (const result of trialResults) {
		const existing = counts[result.scenarioId];
		if (!existing) continue;
		existing[result.modelRole] += 1;
	}
	return counts;
}

function minKPerScenarioRole(kPerScenarioRole: Record<ScenarioId, ModelRoleCounts>): number {
	return Math.min(...Object.values(kPerScenarioRole).flatMap(counts => [counts.candidate, counts.baseline]));
}

function computeL3RefusalReasons(input: {
	p1: P1Summary;
	meta: EvidenceReportMeta;
	linterOk: boolean;
	plannedRecords: number | null;
	capturedRecords: number;
	kPerScenarioRole: Record<ScenarioId, ModelRoleCounts>;
	minK: number;
	modelIds: ModelIdsByRole;
}): L3RefusalReason[] {
	const reasons: L3RefusalReason[] = [];
	const hasMissingScenario = Object.values(input.kPerScenarioRole).some(
		counts => counts.candidate === 0 && counts.baseline === 0,
	);
	const hasMissingBaseline = Object.values(input.kPerScenarioRole).some(
		counts => counts.candidate > 0 && counts.baseline === 0,
	);
	const scenarioVersions = uniqueSorted([
		input.meta.composer_scenarios_version ?? COMPOSER_SCENARIOS_VERSION,
		...(input.meta.scenario_versions ?? []),
	]);

	if (input.minK < 3) reasons.push("k_lt_3");
	if (hasMissingBaseline) reasons.push("missing_baseline");
	if (hasMissingScenario) reasons.push("missing_scenario");
	if (input.meta.capture_mode === "trace-replay" || !input.meta.capture_mode) reasons.push("trace_replay_not_l3");
	if (!input.linterOk) reasons.push("manifest_linter_failed");
	if (scenarioVersions.length > 1) reasons.push("mixed_scenario_versions");
	if (input.modelIds.candidate.length > 1 || input.modelIds.baseline.length > 1) reasons.push("mixed_model_ids");
	if (
		(input.plannedRecords !== null && input.plannedRecords !== input.capturedRecords) ||
		(input.meta.capture_mode !== "trace-replay" && (!input.meta.trace_sha256 || !input.meta.manifest_sha256))
	) {
		reasons.push("partial_capture");
	}
	if (!input.p1.passed) reasons.push("p1_not_passed");

	return reasons;
}

export function resolveLadderMaxClaim(
	p1: P1Summary,
	l2Eligible: boolean,
	l3Eligible = false,
): EvidenceReport["ladderMaxClaim"] {
	if (!p1.applicable) return "L1";
	if (l3Eligible) return "L3";
	if (l2Eligible && p1.passed && p1.parityDelta <= 0) return "L2";
	if (p1.passed) return "L1";
	return "none";
}

export function buildEvidenceReport(
	trialResults: TrialResult[],
	meta: EvidenceReportMeta = {},
	manifestText = "",
): EvidenceReport {
	const p1 = createP1Summary(trialResults);
	const reportScenarioVersion = meta.composer_scenarios_version ?? COMPOSER_SCENARIOS_VERSION;
	const reportScenarios = composerScenariosForVersion(reportScenarioVersion);
	const reportScenarioCount = composerScenarioCountForVersion(reportScenarioVersion);
	const coverage = countScenarioCoverage(trialResults, reportScenarios);
	const l2Eligible = coverage >= L2_MIN_SCENARIO_COVERAGE && p1.applicable && p1.passed && p1.parityDelta <= 0;
	const roleCounts = buildRoleCounts(trialResults);
	const modelIds = meta.actual_model_ids ?? buildModelIds(trialResults);
	const candidateCount = roleCounts.candidate;
	const baselineCount = roleCounts.baseline;
	const candidateFailures = p1.candidateFailureCount;
	const baselineFailures = p1.baselineFailureCount;
	const linter = scanTextForPublishSecrets(manifestText);
	const plannedRecords = meta.planned_records ?? null;
	const capturedRecords = meta.captured_records ?? trialResults.length;
	const kPerScenarioRole = buildKPerScenarioRole(trialResults, reportScenarios);
	const minK = minKPerScenarioRole(kPerScenarioRole);
	const l3RefusalReasons = computeL3RefusalReasons({
		p1,
		meta,
		linterOk: linter.ok,
		plannedRecords,
		capturedRecords,
		kPerScenarioRole,
		minK,
		modelIds,
	});

	return {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		ladderMaxClaim: resolveLadderMaxClaim(p1, l2Eligible, l3RefusalReasons.length === 0),
		p1,
		l2Eligible,
		l3Eligible: l3RefusalReasons.length === 0,
		l3RefusalReasons,
		scenario_coverage: coverage,
		scenario_coverage_ratio: `${coverage}/${reportScenarioCount}`,
		planned_records: plannedRecords,
		captured_records: capturedRecords,
		role_counts: roleCounts,
		k_per_scenario_role: kPerScenarioRole,
		min_k_per_scenario_role: minK,
		model_ids: modelIds,
		composer_harness_failure_rate: candidateCount > 0 ? candidateFailures / candidateCount : 0,
		baseline_failure_rate: baselineCount > 0 ? baselineFailures / baselineCount : 0,
		parityDelta: p1.parityDelta,
		per_scenario: buildPerScenarioEvidence(trialResults),
		composer_scenarios_version: reportScenarioVersion,
		candidate_model: modelLabel(modelIds.candidate, DEFAULT_COMPOSER_CANDIDATE_MODEL),
		baseline_model: modelLabel(modelIds.baseline, DEFAULT_CODEX_BASELINE_MODEL),
		trace_sha256: meta.trace_sha256,
		manifest_sha256: meta.manifest_sha256,
		meta,
		manifest_linter_ok: linter.ok,
		manifest_linter_findings: linter.findings,
	};
}
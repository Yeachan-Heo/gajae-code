#!/usr/bin/env bun
/**
 * Compare two scored trace corpora (e.g. gjc v0.5.3 vs v0.6.4 live captures).
 * Point estimate only — not a statistical hypothesis test.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildEvidenceReport, scanTextForPublishSecrets, type EvidenceReport } from "./composer-evidence";
import { classifyTraceRecord, type TraceRecord } from "./composer-stability-v3";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

async function loadRecords(filePath: string): Promise<TraceRecord[]> {
	const raw = await fs.readFile(filePath, "utf8");
	const parsed = JSON.parse(raw) as unknown;
	if (Array.isArray(parsed)) return parsed as TraceRecord[];
	if (typeof parsed === "object" && parsed !== null && "records" in parsed) {
		return (parsed as { records: TraceRecord[] }).records;
	}
	return [parsed as TraceRecord];
}

type ProvenanceManifest = {
	composer_scenarios_version?: string;
	record_count?: number;
	captured_records?: number;
	trace_sha256?: string;
	manifest_sha256?: string;
};

function parseManifest(text: string): ProvenanceManifest | undefined {
	try {
		const parsed = JSON.parse(text) as unknown;
		return typeof parsed === "object" && parsed !== null ? (parsed as ProvenanceManifest) : undefined;
	} catch {
		return undefined;
	}
}

function manifestPathForTraceFile(traceFile: string): string {
	const resolved = path.resolve(traceFile);
	return path.join(path.dirname(path.dirname(resolved)), "provenance-manifest.json");
}

async function loadManifest(traceFile: string): Promise<ProvenanceManifest | undefined> {
	try {
		return parseManifest(await fs.readFile(manifestPathForTraceFile(traceFile), "utf8"));
	} catch {
		return undefined;
	}
}

function trialsFromRecords(records: TraceRecord[]) {
	return records.map(record => {
		const c = classifyTraceRecord(record);
		return {
			scenarioId: record.scenarioId,
			modelRole: record.modelRole,
			model: record.model,
			trial: record.trial,
			status: c.status,
			failureClass: c.failureClasses[0],
			failureClasses: c.failureClasses,
			evidence: c.evidence,
			tracePath: record.tracePath,
		};
	});
}

function scenarioFailureMap(report: EvidenceReport): Map<string, { candidate: number; baseline: number; classes: string[] }> {
	return new Map(
		report.per_scenario.map(row => [
			row.id,
			{
				candidate: row.candidate_failures,
				baseline: row.baseline_failures,
				classes: row.failure_classes,
			},
		]),
	);
}

function perScenarioDelta(aReport: EvidenceReport, bReport: EvidenceReport) {
	const a = scenarioFailureMap(aReport);
	const b = scenarioFailureMap(bReport);
	const ids = [...new Set([...a.keys(), ...b.keys()])].sort();
	return ids.map(id => {
		const aRow = a.get(id) ?? { candidate: 0, baseline: 0, classes: [] };
		const bRow = b.get(id) ?? { candidate: 0, baseline: 0, classes: [] };
		return {
			id,
			candidate_failure_delta_a_minus_b: aRow.candidate - bRow.candidate,
			baseline_failure_delta_a_minus_b: aRow.baseline - bRow.baseline,
			arm_a_failure_classes: aRow.classes,
			arm_b_failure_classes: bRow.classes,
		};
	});
}

function armSummary(label: string, gjcVersion: string, report: EvidenceReport) {
	return {
		label,
		gjc_version: gjcVersion,
		composer_scenarios_version: report.composer_scenarios_version,
		trace_sha256: report.trace_sha256,
		manifest_sha256: report.manifest_sha256,
		candidate_failure_count: report.p1.candidateFailureCount,
		baseline_failure_count: report.p1.baselineFailureCount,
		parity_delta: report.p1.parityDelta,
		scenario_coverage: report.scenario_coverage,
		scenario_coverage_ratio: report.scenario_coverage_ratio,
		l2_eligible: report.l2Eligible,
		ladder_max_claim: report.ladderMaxClaim,
		p1_passed: report.p1.passed,
	};
}

async function main(): Promise<void> {
	const aArg = process.argv.find((_, i, a) => a[i - 1] === "--arm-a");
	const bArg = process.argv.find((_, i, a) => a[i - 1] === "--arm-b");
	const aVer = process.argv.find((_, i, a) => a[i - 1] === "--arm-a-version") ?? "unknown";
	const bVer = process.argv.find((_, i, a) => a[i - 1] === "--arm-b-version") ?? "unknown";
	const outArg = process.argv.find((_, i, a) => a[i - 1] === "--out");

	if (!aArg || !bArg) {
		process.stderr.write(
			"usage: composer-evidence-ab-compare.ts --arm-a <trace.json> --arm-a-version 0.5.3 --arm-b <trace.json> --arm-b-version 0.6.4 [--out report.json]\n",
		);
		process.exit(1);
	}

	const aTracePath = path.resolve(aArg);
	const bTracePath = path.resolve(bArg);
	const aRecords = await loadRecords(aTracePath);
	const bRecords = await loadRecords(bTracePath);
	const aManifest = await loadManifest(aTracePath);
	const bManifest = await loadManifest(bTracePath);
	const aReport = buildEvidenceReport(trialsFromRecords(aRecords), {
		capture_mode: "trace-replay",
		comparison_kind: "historical-frozen-trace",
		composer_scenarios_version: aManifest?.composer_scenarios_version,
		gjc_version: aVer,
		trace_sha256: aManifest?.trace_sha256,
		manifest_sha256: aManifest?.manifest_sha256,
		captured_records: aManifest?.captured_records ?? aManifest?.record_count ?? aRecords.length,
	});
	const bReport = buildEvidenceReport(trialsFromRecords(bRecords), {
		capture_mode: "trace-replay",
		comparison_kind: "historical-frozen-trace",
		composer_scenarios_version: bManifest?.composer_scenarios_version,
		gjc_version: bVer,
		trace_sha256: bManifest?.trace_sha256,
		manifest_sha256: bManifest?.manifest_sha256,
		captured_records: bManifest?.captured_records ?? bManifest?.record_count ?? bRecords.length,
	});

	const candidateDelta = aReport.p1.candidateFailureCount - bReport.p1.candidateFailureCount;
	const baselineDelta = aReport.p1.baselineFailureCount - bReport.p1.baselineFailureCount;
	const parityDeltaChange = aReport.p1.parityDelta - bReport.p1.parityDelta;

	const payload = {
		schemaVersion: 1,
		comparison_kind: "historical-frozen-trace",
		disclaimer:
			"Point estimate from paired harness failure counts on frozen trace corpora. Not a statistical hypothesis test. Live A/B requires separate captures with each gjc binary on the same versioned Composer scenario prompts.",
		repo_commit: process.env.EVIDENCE_REPO_COMMIT ?? "dev-evidence",
		arm_a: armSummary("v0.5.3-or-baseline-arm", aVer, aReport),
		arm_b: armSummary("v0.6.4-or-candidate-arm", bVer, bReport),
		comparison: {
			candidate_failure_count_delta_a_minus_b: candidateDelta,
			baseline_failure_count_delta_a_minus_b: baselineDelta,
			parity_delta_change_a_minus_b: parityDeltaChange,
			interpretation:
				candidateDelta > 0
					? "Arm B (typically 0.6.4) shows fewer candidate failures than arm A by count delta."
					: candidateDelta < 0
						? "Arm A shows fewer candidate failures than arm B."
						: "Candidate failure counts tie on this corpus.",
		},
		per_scenario_delta: perScenarioDelta(aReport, bReport),
		per_scenario_a: aReport.per_scenario,
		per_scenario_b: bReport.per_scenario,
	};

	const payloadText = `${JSON.stringify(payload, null, 2)}\n`;
	const payloadLint = scanTextForPublishSecrets(payloadText);
	if (!payloadLint.ok) {
		process.stderr.write(`composer-evidence-ab-compare: report linter failed: ${payloadLint.findings.join(", ")}\n`);
		process.exit(3);
	}

	const outPath = outArg ? path.resolve(outArg) : path.join(REPO_ROOT, "evidence-ab-compare.json");
	await fs.writeFile(outPath, payloadText);
	process.stdout.write(
		`${JSON.stringify({ ok: true, reportArtifact: path.basename(outPath), comparison: payload.comparison }, null, 2)}\n`,
	);
}

if (import.meta.main) {
	await main();
}
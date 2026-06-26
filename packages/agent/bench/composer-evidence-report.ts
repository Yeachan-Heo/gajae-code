#!/usr/bin/env bun
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildEvidenceReport, scanTextForPublishSecrets, type CaptureMode, type EvidenceReportMeta } from "./composer-evidence";
import { classifyTraceRecord, type TraceRecord } from "./composer-stability-v3";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

async function loadTraceFile(filePath: string): Promise<TraceRecord[]> {
	const raw = await fs.readFile(filePath, "utf8");
	const parsed = JSON.parse(raw) as unknown;
	if (Array.isArray(parsed)) return parsed as TraceRecord[];
	if (typeof parsed === "object" && parsed !== null && "records" in parsed) {
		return (parsed as { records: TraceRecord[] }).records;
	}
	return [parsed as TraceRecord];
}

type ProvenanceManifest = {
	schemaVersion?: number;
	composer_scenarios_version?: string;
	capture_mode?: CaptureMode;
	gjc_version?: string;
	git_sha?: string;
	tracePath?: string;
	trace_sha256?: string;
	manifest_sha256?: string;
	planned_records?: number;
	record_count?: number;
	captured_records?: number;
	k?: number;
	candidate_model?: string;
	baseline_model?: string;
};

function isCaptureMode(value: unknown): value is CaptureMode {
	return value === "print" || value === "tmux" || value === "hermes-mcp" || value === "trace-replay";
}

function parseManifest(text: string): ProvenanceManifest | undefined {
	if (!text.trim()) return undefined;
	try {
		const parsed = JSON.parse(text) as unknown;
		return typeof parsed === "object" && parsed !== null ? (parsed as ProvenanceManifest) : undefined;
	} catch {
		return undefined;
	}
}

function sha256Text(text: string): string {
	return crypto.createHash("sha256").update(text).digest("hex");
}

async function sha256File(filePath: string): Promise<string | undefined> {
	try {
		const data = await fs.readFile(filePath);
		return crypto.createHash("sha256").update(data).digest("hex");
	} catch {
		return undefined;
	}
}

function manifestPathForTraceFile(traceFileArg: string | undefined): string {
	if (!traceFileArg) return "";
	const resolved = path.resolve(traceFileArg);
	return path.join(path.dirname(path.dirname(resolved)), "provenance-manifest.json");
}

function publicArtifactLabel(filePath: string): string {
	const resolved = path.resolve(filePath);
	return `${path.basename(path.dirname(resolved))}/${path.basename(resolved)}`;
}

function metaFromManifest(input: {
	records: TraceRecord[];
	traceFileArg?: string;
	traceDirArg?: string;
	manifest?: ProvenanceManifest;
	manifestText: string;
}): EvidenceReportMeta {
	const traceArtifacts = [
		input.traceFileArg ? publicArtifactLabel(input.traceFileArg) : undefined,
		input.traceDirArg ? publicArtifactLabel(input.traceDirArg) : undefined,
	].filter((value): value is string => Boolean(value));
	const captureMode = isCaptureMode(input.manifest?.capture_mode) ? input.manifest.capture_mode : "trace-replay";
	const actualModelIds = {
		candidate: [...new Set(input.records.filter(record => record.modelRole === "candidate").map(record => record.model))].sort(),
		baseline: [...new Set(input.records.filter(record => record.modelRole === "baseline").map(record => record.model))].sort(),
	};

	return {
		capture_mode: captureMode,
		composer_scenarios_version: input.manifest?.composer_scenarios_version,
		gjc_version: input.manifest?.gjc_version,
		git_sha: input.manifest?.git_sha,
		trace_artifacts: traceArtifacts,
		trace_sha256: input.manifest?.trace_sha256,
		manifest_sha256: input.manifestText ? sha256Text(input.manifestText) : input.manifest?.manifest_sha256,
		planned_records: input.manifest?.planned_records,
		captured_records: input.manifest?.captured_records ?? input.manifest?.record_count ?? input.records.length,
		expected_k_per_scenario_role: input.manifest?.k,
		actual_model_ids: actualModelIds,
	};
}

async function main(): Promise<void> {
	const traceDirArg = process.argv.find((_, i, a) => a[i - 1] === "--trace-dir");
	const traceFileArg = process.argv.find((_, i, a) => a[i - 1] === "--trace-file");
	const outArg = process.argv.find((_, i, a) => a[i - 1] === "--out");

	const records: TraceRecord[] = [];
	if (traceFileArg) {
		records.push(...(await loadTraceFile(path.resolve(traceFileArg))));
	}
	if (traceDirArg) {
		const dir = path.resolve(traceDirArg);
		const entries = await fs.readdir(dir);
		for (const name of entries) {
			if (!name.endsWith(".json")) continue;
			records.push(...(await loadTraceFile(path.join(dir, name))));
		}
	}

	const trials = records.map(record => {
		const classified = classifyTraceRecord(record);
		return {
			scenarioId: record.scenarioId,
			modelRole: record.modelRole,
			model: record.model,
			trial: record.trial,
			status: classified.status,
			failureClass: classified.failureClasses[0],
			failureClasses: classified.failureClasses,
			evidence: classified.evidence,
			tracePath: record.tracePath ? publicArtifactLabel(record.tracePath) : undefined,
		};
	});

	const manifestPath = traceDirArg
		? path.join(path.resolve(traceDirArg), "..", "provenance-manifest.json")
		: manifestPathForTraceFile(traceFileArg);
	let manifestText = "";
	try {
		manifestText = await fs.readFile(manifestPath, "utf8");
	} catch {
		manifestText = "";
	}
	const manifest = parseManifest(manifestText);
	const meta = metaFromManifest({ records, traceFileArg, traceDirArg, manifest, manifestText });
	if (!meta.trace_sha256 && traceFileArg) {
		meta.trace_sha256 = await sha256File(path.resolve(traceFileArg));
	}

	const report = buildEvidenceReport(trials, meta, manifestText);
	const reportText = `${JSON.stringify(report, null, 2)}\n`;
	const reportLint = scanTextForPublishSecrets(reportText);
	if (!reportLint.ok) {
		process.stderr.write(`composer-evidence-report: report linter failed: ${reportLint.findings.join(", ")}\n`);
		process.exit(3);
	}
	const outPath = outArg ? path.resolve(outArg) : path.join(REPO_ROOT, "evidence-report.json");
	await fs.writeFile(outPath, reportText);
	process.stdout.write(
		`${JSON.stringify(
			{
				ok: true,
				reportArtifact: path.basename(outPath),
				ladderMaxClaim: report.ladderMaxClaim,
				l2Eligible: report.l2Eligible,
			},
			null,
			2,
		)}\n`,
	);
}

if (import.meta.main) {
	await main();
}
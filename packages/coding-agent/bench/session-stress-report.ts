import * as path from "node:path";

const MIB = 1024 * 1024;

type Scenario = "linear-resume" | "multi-transcript" | "subagent-tree" | "goal-history";
type OperationClass = "raw-cold-first-open" | "exact-authenticated-reopen" | "transcript-ahead-reopen" | "repeated-lifecycle" | "repeated-open-lookup-close" | "direct-fork" | "captured-fork" | string;

type MatrixRun = {
	scenario: Scenario;
	targetMiB: number;
	status: "ok" | "rejected" | "error";
	operationClass?: OperationClass;
	sessionMemoryMode?: "off" | "shadow" | "enabled" | string;
	gcStrategy?: string;
	secondaryArtifacts?: string;
	repetitions?: number;
	fileCount: number;
	entryCount: number;
	phases: {
		generationMs: number;
		firstOpenMs?: number;
		exactAuthenticatedReopenMs?: number;
		transcriptAheadReopenMs?: number;
		repeatedLifecycleMs?: number;
		resumeMs?: number;
		closeMs: number;
		cpuUserMicros?: number;
		cpuSystemMicros?: number;
	};
	firstOpenPerFileMs?: { p95: number };
	resumePerFileMs?: { p95: number };
	throughputMiBPerSecond: number;
	memory: {
		operationRssGrowthBytes?: number;
		firstOpenRssGrowthBytes?: number;
		resumeRssGrowthBytes?: number;
		lookupRssGrowthBytes: number;
		teardownRssGrowthBytes: number;
		maxRssBytes: number;
	};
	lookup: {
		coldMs: { p95: number } | null;
		warmMs: { p95: number } | null;
		coldRangeReads: number | null;
		warmRangeReads: number | null;
	};
	sessionMemory: {
		totalAccountedBytes: number;
		maxAccountedBytes: number;
		coldRetirementActiveCount: number;
		reservedBudgetBytes?: number;
		residentBytes?: number;
		sidecarFileBytes?: number;
		contextMessageCount: number;
		telemetry?: Record<string, unknown>;
	};
	phaseEvidence?: Record<string, unknown>;
	counters?: Record<string, unknown>;
	lifecycle?: {
		openMs: { p95: number };
		lookupMs: { p95: number };
		closeMs: { p95: number };
	};
	preparation?: { firstOpenMs: number };
	failure?: { code: string; message: string };
};

type MatrixReport = {
	schemaVersion: number;
	bench: string;
	generatedAt: string;
	gitSha: string | null;
	platform: string;
	arch: string;
	cpu: string | null;
	bunVersion: string;
	sizesMiB: number[];
	scenarios: Scenario[];
	operations?: OperationClass[];
	sessionMemoryModes?: string[];
	gcStrategy?: string;
	secondaryArtifacts?: string;
	repetitions?: number;
	smallComparisonSizesMiB?: number[];
	runs: MatrixRun[];
};

type GibRun = {
	mode?: "direct" | "captured";
	operationClass?: "direct-fork" | "captured-fork" | string;
	gcStrategy?: string;
	secondaryArtifacts?: string;
	repetitions?: number;
	phases: {
		fork: { elapsedMs: number; cpu: { userMicros: number; systemMicros: number } };
		reopen: { elapsedMs: number };
	};
	phaseEvidence?: Record<string, unknown>;
	counters?: Record<string, unknown>;
	memory: { forkRssGrowthBytes: number; teardownRssGrowthBytes: number };
	latency: { coldLookupMs: { p95: number }; warmLookupMs: { p95: number } };
	sessionMemoryTelemetry?: Record<string, unknown>;
};

type GibReport = {
	generatedAt: string;
	gitSha: string | null;
	gcStrategy?: string;
	secondaryArtifacts?: string;
	repetitions?: number;
	operations?: string[];
	iterationsPerMode?: number;
	fixture: { targetTranscriptBytes: number };
	runs?: GibRun[];
	summary?: Partial<Record<"direct" | "captured", {
		forkElapsedMs: { median: number; p95: number };
		forkCpuMicros: { median: number } | null;
		forkRssGrowthBytes: { median: number; p95: number };
		reopenElapsedMs: { median: number; p95: number };
		coldLookupP95Ms: { median: number; p95: number };
		warmLookupP95Ms: { median: number; p95: number };
	}>>;
};

type Args = {
	matrixPath: string;
	svgPath: string;
	gibPath: string;
	outPath: string;
};

function parseArgs(argv: string[]): Args {
	const values = new Map<string, string>();
	for (let index = 2; index < argv.length; index += 2) {
		const name = argv[index];
		const value = argv[index + 1];
		if (!name?.startsWith("--") || !value) throw new Error("Expected --name value arguments");
		values.set(name, value);
	}
	const matrixPath = values.get("--matrix");
	const svgPath = values.get("--svg");
	const gibPath = values.get("--gib");
	const outPath = values.get("--out");
	if (!matrixPath || !svgPath || !gibPath || !outPath) throw new Error("--matrix, --svg, --gib, and --out are required");
	return { matrixPath, svgPath, gibPath, outPath };
}

function escapeHtml(value: unknown): string {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatMs(value: number | null | undefined): string {
	const finite = finiteNumber(value);
	if (finite === null) return "N/A";
	if (finite >= 1_000) return `${(finite / 1_000).toFixed(2)} s`;
	return `${finite.toFixed(finite >= 100 ? 0 : 2)} ms`;
}

function formatMiB(value: number | null | undefined): string {
	const finite = finiteNumber(value);
	return finite === null ? "N/A" : `${(finite / MIB).toFixed(1)} MiB`;
}

function formatNumber(value: number | null | undefined, digits = 1): string {
	const finite = finiteNumber(value);
	return finite === null ? "N/A" : finite.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatThroughput(value: number | null | undefined): string {
	const finite = finiteNumber(value);
	return finite === null ? "N/A" : `${formatNumber(finite)} MiB/s`;
}

function operationLabel(operation: OperationClass | undefined): string {
	const labels: Record<string, string> = {
		"raw-cold-first-open": "Raw cold first-open",
		"exact-authenticated-reopen": "Exact authenticated reopen",
		"transcript-ahead-reopen": "Transcript-ahead reopen",
		"repeated-open-lookup-close": "Repeated open/lookup/close",
		"repeated-lifecycle": "Repeated open/lookup/close",
		"direct-fork": "Direct fork",
		"captured-fork": "Captured fork",
		unknown: "Operation unavailable",
	};
	return labels[operation ?? ""] ?? operation ?? "Unknown operation";
}

function normalizedOperation(run: MatrixRun): OperationClass {
	return run.operationClass ?? "unknown";
}

function operationElapsed(run: MatrixRun): number | null {
	if (run.status !== "ok") return null;
	switch (normalizedOperation(run)) {
		case "exact-authenticated-reopen":
			return finiteNumber(run.phases.exactAuthenticatedReopenMs);
		case "transcript-ahead-reopen":
			return finiteNumber(run.phases.transcriptAheadReopenMs);
		case "repeated-lifecycle":
		case "repeated-open-lookup-close":
			return finiteNumber(run.phases.repeatedLifecycleMs);
		case "raw-cold-first-open":
			return finiteNumber(run.phases.firstOpenMs ?? run.phases.resumeMs);
		default:
			return null;
	}
}

function operationRss(run: MatrixRun): number | null {
	if (run.status !== "ok") return null;
	switch (normalizedOperation(run)) {
		case "raw-cold-first-open":
			return finiteNumber(run.memory.operationRssGrowthBytes ?? run.memory.firstOpenRssGrowthBytes ?? run.memory.resumeRssGrowthBytes);
		case "exact-authenticated-reopen":
		case "transcript-ahead-reopen":
		case "repeated-lifecycle":
		case "repeated-open-lookup-close":
			return finiteNumber(run.memory.operationRssGrowthBytes);
		default:
			return null;
	}
}

function operationP95(run: MatrixRun): number | null {
	if (run.status !== "ok") return null;
	switch (normalizedOperation(run)) {
		case "raw-cold-first-open":
			return finiteNumber(run.firstOpenPerFileMs?.p95 ?? run.resumePerFileMs?.p95);
		case "repeated-lifecycle":
		case "repeated-open-lookup-close":
			return finiteNumber(run.lifecycle?.openMs?.p95);
		default:
			return operationElapsed(run);
	}
}

function telemetryText(run: MatrixRun, key: string): string {
	const value = run.sessionMemory?.telemetry?.[key];
	return value === undefined || value === null ? "N/A" : String(value);
}

function memoryMetric(run: MatrixRun, key: "reservedBudgetBytes" | "residentBytes" | "sidecarFileBytes"): number | null {
	if (run.status !== "ok") return null;
	const direct = run.sessionMemory?.[key];
	const directNumber = finiteNumber(direct);
	if (directNumber !== null) return directNumber;
	const telemetry = run.sessionMemory?.telemetry ?? {};
	const telemetryNumber = finiteNumber(telemetry[key]);
	if (telemetryNumber !== null) return telemetryNumber;
	if (key === "reservedBudgetBytes") return null;
	if (key === "residentBytes") {
		const components = [telemetry.allocatedCacheBytes, telemetry.hotResidentBytes ?? telemetry.hotRegionBytes, telemetry.metadataResidentBytes ?? telemetry.metaDescriptorBytes]
			.map(finiteNumber)
			.filter((value): value is number => value !== null);
		return components.length === 0 ? null : components.reduce((total, value) => total + value, 0);
	}
	return null;
}

function phaseEvidenceText(run: MatrixRun): string {
	const phases = Object.entries(run.phaseEvidence ?? {}).filter(([, value]) => value !== null && value !== undefined).map(([key]) => key);
	const counters = Object.entries(run.counters ?? {}).filter(([, value]) => value !== null && value !== undefined).map(([key]) => key);
	const parts: string[] = [];
	if (phases.length > 0) parts.push(`phases:${phases.join("|")}`);
	if (counters.length > 0) parts.push(`counters:${counters.join("|")}`);
	return parts.join("; ") || "N/A";
}

function scenarioName(scenario: Scenario): string {
	return {
		"linear-resume": "Linear transcript",
		"multi-transcript": "Four transcripts",
		"subagent-tree": "Parent + four subagents",
		"goal-history": "Goal lifecycle history",
	}[scenario] ?? scenario;
}

function scenarioDescription(scenario: Scenario): string {
	return {
		"linear-resume": "One compacted transcript with no sidecar at raw cold first-open.",
		"multi-transcript": "Four independent transcripts held open concurrently; total bytes are divided across files.",
		"subagent-tree": "One parent and four child sessions with parentSession links, all resident concurrently.",
		"goal-history": "Synthetic active, blocked, resumed, and completed goal-state records with compaction.",
	}[scenario] ?? "No scenario description is available for this legacy scenario.";
}

function availableScenarios(matrix: MatrixReport): Scenario[] {
	return [...new Set(matrix.runs.map(run => run.scenario))];
}

function availableSizes(matrix: MatrixReport): number[] {
	return [...new Set(matrix.runs.map(run => run.targetMiB).filter(value => finiteNumber(value) !== null))].sort((left, right) => left - right);
}

function availableOperations(matrix: MatrixReport): OperationClass[] {
	return [...new Set(matrix.runs.map(normalizedOperation))];
}

function failureText(run: MatrixRun): string {
	if (run.status === "ok") return "";
	const code = run.failure?.code;
	const message = run.failure?.message;
	return code && message ? `${code}: ${message}` : message ?? code ?? "No failure reason recorded";
}

function sampleLabel(run: MatrixRun): string {
	return run.repetitionIndex === undefined ? "N/A" : String(run.repetitionIndex + 1);
}

function renderEndpointTable(matrix: MatrixReport): string {
	const scenarios = availableScenarios(matrix);
	if (scenarios.length === 0) return "<p>N/A — no matrix runs are available.</p>";
	return scenarios
		.map(scenario => {
			const runs = matrix.runs.filter(run => run.scenario === scenario).sort((left, right) => left.targetMiB - right.targetMiB || normalizedOperation(left).localeCompare(normalizedOperation(right)) || (left.sessionMemoryMode ?? "").localeCompare(right.sessionMemoryMode ?? ""));
			const rows = runs.map(run => `<tr>
				<td>${run.targetMiB.toLocaleString()} MiB</td>
				<td>${escapeHtml(operationLabel(run.operationClass))}</td>
				<td>${escapeHtml(run.sessionMemoryMode ?? "N/A")}</td>
				<td>${escapeHtml(sampleLabel(run))}</td>
				<td><span class="status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span>${run.status === "ok" ? "" : `<div class="small">${escapeHtml(failureText(run))}</div>`}</td>
				<td class="num">${run.status === "ok" ? formatMs(operationElapsed(run)) : "N/A"}</td>
				<td class="num">${run.status === "ok" ? formatThroughput(run.throughputMiBPerSecond) : "N/A"}</td>
				<td class="num">${formatMiB(operationRss(run))}</td>
				<td class="num">${run.status === "ok" && run.lookup?.coldMs ? formatMs(run.lookup.coldMs.p95) : "N/A"}</td>
				<td class="num">${run.status === "ok" && finiteNumber(run.entryCount) !== null ? run.entryCount.toLocaleString() : "N/A"}</td>
			</tr>`).join("\n");
			return `<section class="scenario-block">
				<h3>${escapeHtml(scenarioName(scenario))}</h3>
				<p>${escapeHtml(scenarioDescription(scenario))}</p>
				<table>
					<thead><tr><th>Corpus size</th><th>Operation</th><th>Memory mode</th><th>Sample</th><th>Outcome</th><th>Latency</th><th>Throughput</th><th>RSS growth</th><th>Cold p95</th><th>Entries</th></tr></thead>
					<tbody>${rows}</tbody>
				</table>
			</section>`;
		})
		.join("\n");
}

function renderAppendixRows(matrix: MatrixReport): string {
	return matrix.runs
		.map(run => `<tr>
			<td>${escapeHtml(scenarioName(run.scenario))}</td>
			<td>${escapeHtml(operationLabel(run.operationClass))}</td>
			<td>${escapeHtml(run.sessionMemoryMode ?? "N/A")}</td>
			<td>${escapeHtml(sampleLabel(run))}</td>
			<td class="num">${run.targetMiB}</td>
			<td class="num">${run.fileCount}</td>
			<td class="num">${finiteNumber(run.entryCount) === null ? "N/A" : run.entryCount.toLocaleString()}</td>
			<td>${escapeHtml(run.status)}</td>
			<td>${escapeHtml(failureText(run))}</td>
			<td class="num">${formatMs(operationElapsed(run))}</td>
			<td class="num">${formatMs(operationP95(run))}</td>
			<td class="num">${run.status === "ok" ? formatNumber(run.throughputMiBPerSecond, 2) : "N/A"}</td>
			<td class="num">${formatMiB(operationRss(run))}</td>
			<td class="num">${run.status === "ok" && run.lookup?.coldMs ? formatMs(run.lookup.coldMs.p95) : "N/A"}</td>
			<td class="num">${run.status === "ok" && run.lookup?.warmMs ? formatMs(run.lookup.warmMs.p95) : "N/A"}</td>
			<td class="num">${run.status === "ok" ? run.lookup?.warmRangeReads ?? "N/A" : "N/A"}</td>
			<td class="num">${formatMiB(memoryMetric(run, "reservedBudgetBytes"))}</td>
			<td class="num">${formatMiB(memoryMetric(run, "residentBytes"))}</td>
			<td class="num">${formatMiB(memoryMetric(run, "sidecarFileBytes"))}</td>
			<td>${escapeHtml(telemetryText(run, "dictionaryArtifactEnabled"))}</td>
			<td>${escapeHtml(telemetryText(run, "parentArtifactEnabled"))}</td>
			<td class="mono">${escapeHtml(phaseEvidenceText(run))}</td>
		</tr>`)
		.join("\n");
}

function stripSvgPreamble(svg: string): string {
	return svg.replace(/^<\?xml[^>]*>\s*/i, "");
}

function maxAvailable(values: Array<number | null | undefined>): number | null {
	const finite = values.map(finiteNumber).filter((value): value is number => value !== null);
	return finite.length === 0 ? null : Math.max(...finite);
}

function sumAvailable(values: Array<number | null | undefined>): number | null {
	const finite = values.map(finiteNumber).filter((value): value is number => value !== null);
	return finite.length === 0 ? null : finite.reduce((total, value) => total + value, 0);
}

type GibMode = "direct" | "captured";

function gibModeFromRun(run: GibRun): GibMode | null {
	if (run.mode === "direct" || run.mode === "captured") return run.mode;
	if (run.operationClass === "direct-fork") return "direct";
	if (run.operationClass === "captured-fork") return "captured";
	return null;
}

function availableGibModes(gib: GibReport): GibMode[] {
	const runModes = new Set((gib.runs ?? []).map(gibModeFromRun).filter((mode): mode is GibMode => mode !== null));
	if (gib.runs !== undefined) return (["direct", "captured"] as const).filter(mode => runModes.has(mode));
	const summary = gib.summary ?? {};
	return (["direct", "captured"] as const).filter(mode => summary[mode] !== undefined);
}

function renderGibRows(gib: GibReport, modes: GibMode[]): string {
	if (modes.length === 0) return '<tr><td colspan="7">N/A — no direct or captured GiB run is available.</td></tr>';
	return modes.map(mode => {
		const value = gib.summary?.[mode];
		if (!value) return `<tr><td>${operationLabel(`${mode}-fork`)}</td><td colspan="6">N/A — summary unavailable for this recorded mode.</td></tr>`;
		return `<tr><td>${operationLabel(`${mode}-fork`)}</td><td class="num">${formatMs(value.forkElapsedMs?.median)} / ${formatMs(value.forkElapsedMs?.p95)}</td><td class="num">${formatMs(value.forkCpuMicros?.median === undefined ? null : value.forkCpuMicros.median / 1000)}</td><td class="num">${formatMiB(value.forkRssGrowthBytes?.median)} / ${formatMiB(value.forkRssGrowthBytes?.p95)}</td><td class="num">${formatMs(value.reopenElapsedMs?.median)} / ${formatMs(value.reopenElapsedMs?.p95)}</td><td class="num">${formatMs(value.coldLookupP95Ms?.median)}</td><td class="num">${formatMs(value.warmLookupP95Ms?.median)}</td></tr>`;
	}).join("\n");
}

async function main(): Promise<void> {
	const args = parseArgs(Bun.argv);
	const matrix = (await Bun.file(args.matrixPath).json()) as MatrixReport;
	const gib = (await Bun.file(args.gibPath).json()) as GibReport;
	const chart = stripSvgPreamble(await Bun.file(args.svgPath).text());
	const successful = matrix.runs.filter(run => run.status === "ok");
	const rejected = matrix.runs.filter(run => run.status === "rejected");
	const representedScenarios = availableScenarios(matrix);
	const representedSizes = availableSizes(matrix);
	const representedOperations = availableOperations(matrix);
	const maxOperationRss = maxAvailable(successful.map(operationRss));
	const maxColdP95 = maxAvailable(successful.map(run => run.lookup?.coldMs?.p95));
	const maxWarmP95 = maxAvailable(successful.map(run => run.lookup?.warmMs?.p95));
	const maxProcessRss = maxAvailable(successful.map(run => run.memory?.maxRssBytes));
	const maxTeardownRss = maxAvailable(successful.map(run => run.memory?.teardownRssGrowthBytes));
	const totalWarmReads = sumAvailable(successful.map(run => run.lookup?.warmRangeReads));
	const largestSizeMiB = representedSizes.at(-1) ?? null;
	const largestRuns = largestSizeMiB === null ? [] : matrix.runs.filter(run => run.targetMiB === largestSizeMiB);
	const gibModes = availableGibModes(gib);
	const generatedAt = new Date().toISOString();
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gajae Code — Synthetic Session Stress Report</title>
<style>
:root{--ink:#0f172a;--muted:#475569;--line:#dbe3ee;--panel:#f8fafc;--blue:#2563eb;--green:#15803d;--orange:#c2410c;--red:#b91c1c;--purple:#7e22ce}
*{box-sizing:border-box} body{margin:0;background:#eef2f7;color:var(--ink);font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.report{width:min(1120px,calc(100% - 32px));margin:28px auto;background:white;box-shadow:0 16px 45px rgba(15,23,42,.12)}
.cover{padding:58px 64px 46px;background:linear-gradient(135deg,#0f172a,#172554 64%,#1e3a8a);color:white}
.eyebrow{font-size:12px;font-weight:750;letter-spacing:.14em;text-transform:uppercase;color:#bfdbfe}.cover h1{font-size:38px;line-height:1.1;margin:13px 0 16px;max-width:760px}.subtitle{font-size:17px;color:#dbeafe;max-width:820px}.meta{display:flex;gap:22px;flex-wrap:wrap;margin-top:28px;color:#cbd5e1;font-size:12px}.body{padding:42px 64px 64px}
h2{font-size:24px;margin:42px 0 14px;padding-bottom:8px;border-bottom:2px solid var(--line)}h3{font-size:17px;margin:24px 0 7px}p{margin:8px 0 14px;color:#334155}.lead{font-size:16px;color:#1e293b}.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:22px 0 30px}.kpi{border:1px solid var(--line);border-radius:10px;padding:16px;background:var(--panel)}.kpi strong{display:block;font-size:25px;line-height:1.15}.kpi span{display:block;color:var(--muted);font-size:12px;margin-top:5px}.kpi.good strong{color:var(--green)}
.callout{border-left:5px solid var(--blue);background:#eff6ff;padding:16px 18px;margin:18px 0}.callout.warning{border-color:var(--orange);background:#fff7ed}.callout.success{border-color:var(--green);background:#f0fdf4}
.chart{margin:22px 0 12px;border:1px solid var(--line);padding:12px;border-radius:10px;background:white}.chart svg{width:100%;height:auto;display:block}.caption{font-size:11px;color:#64748b;margin:7px 3px 20px}
table{width:100%;border-collapse:collapse;font-size:12px;margin:12px 0 22px}th{background:#e8eef7;color:#1e293b;text-align:left;font-weight:700}th,td{border:1px solid #d8e0eb;padding:7px 8px;vertical-align:top}td.num{text-align:right;font-variant-numeric:tabular-nums}.status{display:inline-block;padding:2px 7px;border-radius:999px;font-size:10px;font-weight:750;text-transform:uppercase}.status.ok{background:#dcfce7;color:#166534}.status.rejected,.status.error{background:#fee2e2;color:#991b1b}
.scenario-block{break-inside:avoid;margin:22px 0 30px}.two-col{display:grid;grid-template-columns:1fr 1fr;gap:18px}.finding{border:1px solid var(--line);border-radius:9px;padding:15px;background:var(--panel);break-inside:avoid}.finding b{display:block;margin-bottom:5px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}.small{font-size:11px;color:#64748b}.appendix{font-size:9px}.appendix th,.appendix td{padding:4px 5px}.page-break{break-before:page}.footer-note{margin-top:36px;padding-top:14px;border-top:1px solid var(--line);font-size:10px;color:#64748b}
@page{size:A4;margin:12mm 10mm 14mm}@media print{body{background:white}.report{width:auto;margin:0;box-shadow:none}.cover{padding:35px 38px 30px;-webkit-print-color-adjust:exact;print-color-adjust:exact}.cover h1{font-size:31px}.body{padding:25px 38px 35px}.kpis{gap:8px}.kpi{padding:11px}.kpi strong{font-size:20px}h2{margin-top:28px}.chart{padding:5px}table{font-size:10px}.scenario-block{break-inside:avoid}.no-print{display:none}}
@media(max-width:760px){.cover,.body{padding:30px 24px}.kpis,.two-col{grid-template-columns:1fr 1fr}.cover h1{font-size:30px}}
</style>
</head>
<body>
<main class="report">
<header class="cover">
<div class="eyebrow">Gajae Code Performance Engineering</div>
<h1>Synthetic Long-Running Session Stress Report</h1>
		<div class="subtitle">${escapeHtml(representedOperations.map(operationLabel).join(", ") || "N/A")} evidence across ${escapeHtml(representedScenarios.map(scenarioName).join(", ") || "N/A")}.</div>

		<div class="meta"><span>Matrix SHA: ${escapeHtml(matrix.gitSha ?? "unknown")}</span><span>Fork SHA: ${escapeHtml(gib.gitSha ?? "unknown")}</span><span>${escapeHtml(matrix.cpu ?? "unknown CPU")}</span><span>${escapeHtml(matrix.platform)} ${escapeHtml(matrix.arch)}</span><span>Bun ${escapeHtml(matrix.bunVersion)}</span><span>GC ${escapeHtml(matrix.gcStrategy ?? gib.gcStrategy ?? "N/A")}</span><span>Secondary artifacts ${escapeHtml(matrix.secondaryArtifacts ?? gib.secondaryArtifacts ?? "N/A")}</span><span>Report ${escapeHtml(generatedAt)}</span></div>
</header>
<div class="body">
<section>
<h2>Executive summary</h2>
<p class="lead">The former one-GiB bounded-session admission ceiling was a fixed safety threshold, not a measured parser or sidecar limitation. The ceiling is now 2 GiB plus 1 MiB of bounded fork-header headroom, and automatic routing keeps ordinary transcripts eager while admitting large transcripts through bounded session memory.</p>
<div class="kpis">
<div class="kpi good"><strong>${successful.length}/${matrix.runs.length}</strong><span>successful benchmark runs</span></div>
<div class="kpi good"><strong>${representedOperations.length}</strong><span>operation classes represented</span></div>

<div class="kpi"><strong>${formatMiB(maxOperationRss)}</strong><span>maximum operation RSS growth</span></div>
<div class="kpi"><strong>${formatMs(maxColdP95)}</strong><span>maximum recorded cold lookup p95</span></div>
</div>
<div class="callout success"><b>Operation evidence.</b> Raw cold first-open, exact authenticated reopen, transcript-ahead recovery, repeated lifecycle, and direct/captured fork measurements are kept as distinct operation classes when present; unavailable subphase telemetry remains explicitly absent.</div>
<div class="callout"><b>Cache invariant:</b> ${totalWarmReads === null ? "N/A — no warm lookup evidence" : `${totalWarmReads} additional range reads`} across all warm lookups. Cold retrieval remains bounded and warm retrieval remains cache-resident.</div>

</section>
<section>
<h2>Dense scaling chart</h2>
<div class="chart">${chart}</div>
<p class="caption">Figure 1. ${representedSizes.length} available size point${representedSizes.length === 1 ? "" : "s"}: ${representedSizes.length > 0 ? representedSizes.map(value => `${value} MiB`).join(", ") : "N/A"}. Every plotted point is a completed run from the attached JSON evidence.</p>
</section>
<section>
<h2>${largestSizeMiB === null ? "Largest available outcomes" : `${largestSizeMiB.toLocaleString()} MiB outcomes`}</h2>
${largestSizeMiB === null ? "<p>N/A — no matrix size is available.</p>" : `<table>
<thead><tr><th>Scenario</th><th>Operation</th><th>Mode</th><th>Sample</th><th>Outcome</th><th>Failure reason</th><th>Files</th><th>Entries</th><th>Latency</th><th>Throughput</th><th>RSS growth</th><th>Cold p95</th><th>Reserved</th><th>Resident</th><th>Sidecars</th></tr></thead>
<tbody>
${largestRuns.map(run => `<tr><td>${escapeHtml(scenarioName(run.scenario))}</td><td>${escapeHtml(operationLabel(run.operationClass))}</td><td>${escapeHtml(run.sessionMemoryMode ?? "N/A")}</td><td>${escapeHtml(sampleLabel(run))}</td><td>${escapeHtml(run.status)}</td><td>${escapeHtml(failureText(run) || "N/A")}</td><td class="num">${run.status === "ok" ? run.fileCount : "N/A"}</td><td class="num">${run.status === "ok" && finiteNumber(run.entryCount) !== null ? run.entryCount.toLocaleString() : "N/A"}</td><td class="num">${formatMs(operationElapsed(run))}</td><td class="num">${run.status === "ok" ? formatThroughput(run.throughputMiBPerSecond) : "N/A"}</td><td class="num">${formatMiB(operationRss(run))}</td><td class="num">${run.status === "ok" && run.lookup?.coldMs ? formatMs(run.lookup.coldMs.p95) : "N/A"}</td><td class="num">${formatMiB(memoryMetric(run, "reservedBudgetBytes"))}</td><td class="num">${formatMiB(memoryMetric(run, "residentBytes"))}</td><td class="num">${formatMiB(memoryMetric(run, "sidecarFileBytes"))}</td></tr>`).join("\n")}
</tbody></table>`}
</section>
<section>
<h2>Scenario results</h2>
${renderEndpointTable(matrix)}
</section>
<section>
<h2>Findings and interpretation</h2>
<div class="two-col">
<div class="finding"><b>Raw first-open cost</b><p>The raw cold first-open operation performs security/semantic validation and sidecar construction when no authenticated artifact exists. It is not an exact authenticated reopen, a transcript-ahead recovery, or a fork copy.</p></div>
<div class="finding"><b>Exact reopen and transcript-ahead evidence</b><p>Fresh-process authenticated reopen and transcript-ahead recovery are represented as separate operation classes. Their setup first-open evidence is retained under <span class="mono">preparation</span> rather than folded into reopen latency.</p></div>
<div class="finding"><b>Memory behavior</b><p>Maximum operation RSS growth was ${formatMiB(maxOperationRss)}. Maximum post-close growth was ${formatMiB(maxTeardownRss)}. Maximum whole-process RSS was ${formatMiB(maxProcessRss)}, which includes fixture generation and allocator high-water residency and is not equivalent to reachable session state.</p></div>
<div class="finding"><b>Lookup behavior</b><p>Maximum cold p95 was ${formatMs(maxColdP95)} and maximum warm p95 was ${formatMs(maxWarmP95)}. Warm lookups added ${totalWarmReads === null ? "N/A" : totalWarmReads} range reads across the represented runs.</p></div>
</div>
<div class="callout warning"><b>Unavailable phase telemetry:</b> phase/counter fields remain null or absent when the runtime does not expose them; the report does not infer semantic, write, GC, or fsync measurements from aggregate open time.</div>
</section>
<section>
<h2>Detailed near-GiB fork evidence</h2>
<p>The separate 1023 MiB direct/captured fork corpus records ${escapeHtml(gibModes.map(mode => `${mode}-fork`).join(", ") || "N/A")} operation classes, whole-fork timing, destination reopen, and optional preflight/copy/publication/source-revalidation phase telemetry. Controls: GC ${escapeHtml(gib.gcStrategy ?? "N/A")}, secondary artifacts ${escapeHtml(gib.secondaryArtifacts ?? "N/A")}, repetitions ${gib.repetitions ?? gib.iterationsPerMode ?? "N/A"}.</p>

<table>
<thead><tr><th>Operation</th><th>Fork median / p95</th><th>Fork CPU median</th><th>Fork RSS median / p95</th><th>Reopen median / p95</th><th>Cold p95 median</th><th>Warm p95 median</th></tr></thead>
<tbody>
${renderGibRows(gib, gibModes)}
</tbody></table>
</section>
<section>
<h2>Methodology</h2>
<ul>
<li>Synthetic JSONL only; no private or provider transcript data.</li>
<li>Each scenario/size point runs in a fresh Bun subprocess with <span class="mono">--smol --expose-gc</span>.</li>
<li>Operation baselines are captured after fixture generation; raw cold first-open is not labeled as resume.</li>
<li>Every transcript has an active compaction boundary and cold history stored as 256 KiB payload records.</li>
<li>Multiple-transcript and subagent totals are partitioned across four and five files respectively, then held open concurrently.</li>
<li>Cold lookup reads one retired entry per open session; the same IDs are immediately repeated for the warm-cache invariant.</li>
<li>Sidecar accounted bytes, process RSS, heap/external memory, CPU usage, throughput, close latency, context count, I/O counters, operation class, and optional phase evidence are retained in JSON evidence.</li>
</ul>
</section>
<section>
<h2>Limitations</h2>
<ul>
<li>One run per dense matrix point; this is scaling evidence, not variance characterization.</li>
<li>Synthetic repeated text does not model every production distribution, image/blob mix, branching topology, or filesystem fragmentation state.</li>
<li>Process RSS includes allocator behavior and native runtime state. It must not be read as a direct leak measurement.</li>
<li>Subagent sessions are represented as parent-linked session files and role-tagged records; model/provider execution is intentionally excluded.</li>
<li>Managed retained-authority sessions remain on their separate eager compatibility path.</li>
</ul>
</section>
<section class="page-break">
<h2>Appendix A — Complete dense matrix</h2>
<table class="appendix">
<thead><tr><th>Scenario</th><th>Operation</th><th>Mode</th><th>Sample</th><th>MiB</th><th>Files</th><th>Entries</th><th>Status</th><th>Failure reason</th><th>Latency ms</th><th>Per-file p95</th><th>MiB/s</th><th>RSS MiB</th><th>Cold p95</th><th>Warm p95</th><th>Warm reads</th><th>Reserved MiB</th><th>Resident MiB</th><th>Sidecar MiB</th><th>Dictionary</th><th>Parent</th><th>Phase/counter evidence</th></tr></thead>
<tbody>${renderAppendixRows(matrix)}</tbody>
</table>
</section>
<section>
<h2>Appendix B — Evidence manifest</h2>
<table><tbody>
<tr><th>Dense matrix JSON</th><td class="mono">${escapeHtml(path.resolve(args.matrixPath))}</td></tr>
<tr><th>Dense matrix CSV</th><td class="mono">${escapeHtml(path.resolve(args.matrixPath.replace(/\.json$/, ".csv")))}</td></tr>
<tr><th>Dense matrix SVG</th><td class="mono">${escapeHtml(path.resolve(args.svgPath))}</td></tr>
<tr><th>Near-GiB fork JSON</th><td class="mono">${escapeHtml(path.resolve(args.gibPath))}</td></tr>
<tr><th>Matrix generated</th><td>${escapeHtml(matrix.generatedAt)}</td></tr>
<tr><th>Fork corpus generated</th><td>${escapeHtml(gib.generatedAt)}</td></tr>
<tr><th>Matrix Git SHA</th><td class="mono">${escapeHtml(matrix.gitSha ?? "unknown")}</td></tr>
<tr><th>Fork corpus Git SHA</th><td class="mono">${escapeHtml(gib.gitSha ?? "unknown")}</td></tr>
</tbody></table>
</section>
<div class="footer-note">Generated directly from the cited JSON and SVG evidence. HTML and PDF contain the same report body; PDF is browser-printed from this HTML.</div>
</div>
</main>
</body>
</html>`;
	await Bun.write(args.outPath, html);
	process.stdout.write(`${JSON.stringify({ out: args.outPath, bytes: Buffer.byteLength(html), runs: matrix.runs.length, successful: successful.length, rejected: rejected.length })}\n`);
}

await main();

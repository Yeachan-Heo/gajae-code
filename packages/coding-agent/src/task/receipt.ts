import type { SingleResult, TaskToolDetails } from "./types";

export interface TaskRoi {
	tokens: number;
	contextTokens?: number;
	clonedTokens?: number;
	costTotal?: number;
	outputBytes?: number;
	outputLines?: number;
	producedChanges: boolean;
	materialContribution: boolean;
	lowRoi: boolean;
}
export interface TaskResultReceipt {
	index: number;
	id: string;
	agent: string;
	agentSource: SingleResult["agentSource"];
	task: string;
	assignment?: string;
	description?: string;
	status: "completed" | "failed" | "aborted" | "merge_failed" | "paused";
	exitCode: number;
	aborted?: boolean;
	paused?: boolean;
	truncated: boolean;
	durationMs: number;
	tokens: number;
	contextTokens?: number;
	contextWindow?: number;
	modelOverride?: string | string[];
	modelSubstitutionWarning?: SingleResult["modelSubstitutionWarning"];
	usage?: SingleResult["usage"];
	cost?: number;
	branchName?: string;
	retryFailure?: { attempt: number; errorSummary: string };
	errorSummary?: string;
	abortSummary?: string;
	preview: string;
	previewTruncated: boolean;
	outputRef?: { uri: string; sizeBytes: number; lineCount: number; sha256?: string };
	outputUnavailable?: boolean;
	review?: {
		overallCorrectness?: string;
		findingCount: number;
		findings?: Array<{ severity?: string; summary: string }>;
	};
	extractedToolCounts?: Record<string, number>;
	forkContext?: SingleResult["forkContext"];
	forkContextAdvisory?: SingleResult["forkContextAdvisory"];
	roi?: TaskRoi;
}

const BANNED_RAW_TASK_KEYS = new Set([
	"output",
	"stderr",
	"extractedToolData",
	"resultText",
	"errorText",
	"artifactPayload",
	"rawResult",
	"rawResults",
	"rawNestedResults",
	"fullOutput",
	"full_result",
	"toolOutput",
	"toolResultRaw",
	"stdout",
	"rawOutput",
	"recentOutput",
	"currentToolArgs",
	"inflightTaskDetails",
]);

function truncateText(value: string | undefined, maxChars: number): string | undefined {
	if (!value) return undefined;
	return value.length > maxChars ? value.slice(0, maxChars) : value;
}

function buildSafeSynopsis(raw: SingleResult, outputRef: TaskResultReceipt["outputRef"]): string {
	const status = getStatus(raw);
	if (raw.modelSubstitutionWarning) {
		return `Task ${status}; requested model substituted from ${raw.modelSubstitutionWarning.requested} to ${raw.modelSubstitutionWarning.effective}.`;
	}
	if (raw.retryFailure) {
		return `Task ${status}; retry stopped after attempt ${raw.retryFailure.attempt}.`;
	}
	if (raw.abortReason) {
		return `Task ${status}; abort reason recorded.`;
	}
	if (raw.error) {
		return `Task ${status}; error recorded.`;
	}
	if (outputRef) {
		return `Task ${status}; output stored in ${outputRef.uri} (${outputRef.lineCount} lines, ${outputRef.sizeBytes} bytes).`;
	}
	return `Task ${status}; output artifact unavailable.`;
}

function getStatus(raw: SingleResult): TaskResultReceipt["status"] {
	if (raw.paused) return "paused";
	if (raw.aborted) return "aborted";
	if (raw.exitCode === 0 && raw.error) return "merge_failed";
	if (raw.exitCode !== 0 || raw.error) return "failed";
	return "completed";
}

function buildReview(raw: SingleResult): TaskResultReceipt["review"] | undefined {
	const data = raw.extractedToolData;
	if (!data) return undefined;
	const yields = Array.isArray(data.yield) ? data.yield : [];
	const reviewYield = yields
		.map(item => (item && typeof item === "object" ? (item as { data?: unknown }).data : undefined))
		.findLast(item => item && typeof item === "object" && "overall_correctness" in item) as
		| { overall_correctness?: unknown }
		| undefined;
	const rawFindings = Array.isArray(data.report_finding) ? data.report_finding : [];
	const findings = rawFindings.slice(0, 20).map(item => {
		const value = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
		const severity =
			typeof value.severity === "string"
				? value.severity
				: typeof value.priority === "string"
					? value.priority
					: undefined;
		const summaryValue = value.summary ?? value.title ?? value.message ?? value.body ?? "finding";
		return { severity, summary: truncateText(String(summaryValue), 200) ?? "finding" };
	});
	if (!reviewYield && findings.length === 0) return undefined;
	return {
		overallCorrectness:
			typeof reviewYield?.overall_correctness === "string" ? reviewYield.overall_correctness : undefined,
		findingCount: rawFindings.length,
		findings: findings.length > 0 ? findings : undefined,
	};
}

function hasReviewFindings(raw: SingleResult): boolean {
	const findings = raw.extractedToolData?.report_finding;
	return Array.isArray(findings) && findings.length > 0;
}

function hasNonEmptyPreview(raw: SingleResult): boolean {
	return Boolean((raw.output.trim() || raw.stderr.trim()).trim());
}

/**
 * Heuristic task ROI signal built only from receipt-safe accounting fields.
 * Advisory only: these flags never change task success/failure semantics.
 */
export function buildTaskRoi(raw: SingleResult): TaskRoi {
	const outputBytes = raw.outputMeta?.byteSize ?? (raw.outputMeta ? Buffer.byteLength(raw.output, "utf8") : undefined);
	const outputLines = raw.outputMeta?.lineCount;
	const producedChanges =
		raw.producedChanges ??
		Boolean(raw.branchName || (Array.isArray(raw.nestedPatches) && raw.nestedPatches.length > 0));
	const status = getStatus(raw);
	const terminal = status !== "paused" && !raw.aborted;
	const materialContribution = Boolean(
		producedChanges ||
			(outputBytes !== undefined && outputBytes > 0) ||
			hasReviewFindings(raw) ||
			(status === "completed" && raw.tokens > 0 && hasNonEmptyPreview(raw)),
	);
	const lowRoi = terminal && raw.tokens > 0 && !materialContribution;
	return {
		tokens: raw.tokens,
		contextTokens: raw.contextTokens,
		clonedTokens: raw.forkContext?.clonedTokens,
		costTotal: raw.usage?.cost.total,
		outputBytes,
		outputLines,
		producedChanges,
		materialContribution,
		lowRoi,
	};
}

export function buildTaskRoiSummary(receipts: readonly TaskResultReceipt[]): TaskToolDetails["roiSummary"] {
	const totalCostTotal = receipts.reduce((total, receipt) => total + (receipt.roi?.costTotal ?? 0), 0);
	const totalClonedTokens = receipts.reduce((total, receipt) => total + (receipt.roi?.clonedTokens ?? 0), 0);
	return {
		childCount: receipts.length,
		totalTokens: receipts.reduce((total, receipt) => total + (receipt.roi?.tokens ?? receipt.tokens), 0),
		totalCostTotal: totalCostTotal > 0 ? totalCostTotal : undefined,
		totalClonedTokens: totalClonedTokens > 0 ? totalClonedTokens : undefined,
		lowRoiChildIds: receipts.filter(receipt => receipt.roi?.lowRoi).map(receipt => receipt.id),
	};
}

export function buildTaskReceipt(raw: SingleResult): TaskResultReceipt {
	const outputRef = raw.outputMeta
		? {
				uri: `agent://${raw.id}`,
				sizeBytes: raw.outputMeta.byteSize ?? Buffer.byteLength(raw.output, "utf8"),
				lineCount: raw.outputMeta.lineCount,
				sha256: raw.outputMeta.sha256,
			}
		: undefined;
	const preview = buildSafeSynopsis(raw, outputRef);
	const extractedToolCounts = raw.extractedToolData
		? Object.fromEntries(
				Object.entries(raw.extractedToolData).map(([tool, values]) => [
					tool,
					Array.isArray(values) ? values.length : 0,
				]),
			)
		: undefined;
	return {
		index: raw.index,
		id: raw.id,
		agent: raw.agent,
		agentSource: raw.agentSource,
		task: raw.task,
		assignment: raw.assignment,
		description: raw.description,
		status: getStatus(raw),
		exitCode: raw.exitCode,
		aborted: raw.aborted,
		paused: raw.paused,
		truncated: raw.truncated,
		durationMs: raw.durationMs,
		tokens: raw.tokens,
		contextTokens: raw.contextTokens,
		contextWindow: raw.contextWindow,
		modelOverride: raw.modelOverride,
		modelSubstitutionWarning: raw.modelSubstitutionWarning,
		usage: raw.usage,
		cost: raw.usage?.cost.total,
		branchName: raw.branchName,
		retryFailure: raw.retryFailure
			? { attempt: raw.retryFailure.attempt, errorSummary: "Retry failure recorded." }
			: undefined,
		errorSummary: raw.error ? "Error recorded." : undefined,
		abortSummary: raw.abortReason ? "Abort reason recorded." : undefined,
		preview,
		previewTruncated: false,
		outputRef,
		outputUnavailable: outputRef ? undefined : true,
		review: buildReview(raw),
		extractedToolCounts,
		forkContext: raw.forkContext,
		forkContextAdvisory: raw.forkContextAdvisory,
		roi: buildTaskRoi(raw),
	};
}

/**
 * Raw, pre-sanitization task details: the internal shape produced during task
 * execution, where `results` are full `SingleResult` objects. The public
 * `TaskToolDetails` exposes only receipts.
 */
export interface RawTaskToolDetails {
	projectAgentsDir: string | null;
	results: SingleResult[];
	totalDurationMs: number;
	usage?: TaskToolDetails["usage"];
	async?: TaskToolDetails["async"];
	forkContextClonedTokens?: number;
	roiSummary?: TaskToolDetails["roiSummary"];
}

/** Central converter from raw task details to receipt-only public details. */
export function sanitizeTaskToolDetails(raw: RawTaskToolDetails): TaskToolDetails {
	return {
		projectAgentsDir: raw.projectAgentsDir,
		results: raw.results.map(buildTaskReceipt),
		totalDurationMs: raw.totalDurationMs,
		usage: raw.usage,
		forkContextClonedTokens: raw.forkContextClonedTokens,
		roiSummary: raw.roiSummary ?? buildTaskRoiSummary(raw.results.map(buildTaskReceipt)),
		async: raw.async,
	};
}

export function findRawTaskLeakKeys(value: unknown): string[] {
	const found = new Set<string>();
	const seen = new WeakSet<object>();
	const visit = (current: unknown) => {
		if (!current || typeof current !== "object") return;
		if (seen.has(current)) return;
		seen.add(current);
		if (Array.isArray(current)) {
			for (const item of current) visit(item);
			return;
		}
		for (const [key, child] of Object.entries(current)) {
			// Banned keys only leak when they carry text or structure. A numeric
			// value (e.g. the `output` token count on a canonical `Usage` record,
			// whose shape is `input/output/cacheRead/cacheWrite/totalTokens`) is safe.
			if (BANNED_RAW_TASK_KEYS.has(key) && typeof child !== "number") found.add(key);
			visit(child);
		}
	};
	visit(value);
	return [...found].sort();
}

export function assertNoRawTaskFields(value: unknown, surface: string): void {
	const keys = findRawTaskLeakKeys(value);
	if (keys.length > 0) {
		throw new Error(`${surface} contains raw task fields: ${keys.join(", ")}`);
	}
}

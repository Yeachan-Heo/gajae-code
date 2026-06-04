import type { SingleResult, TaskToolDetails } from "./types";

export const TASK_PREVIEW_MAX_BYTES = 2000;
export const TASK_PREVIEW_MAX_LINES = 12;

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
	usage?: SingleResult["usage"];
	cost?: number;
	patchPath?: string;
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

function boundedPreview(value: string): { preview: string; truncated: boolean } {
	const lines = value.split("\n");
	let preview = lines.slice(0, TASK_PREVIEW_MAX_LINES).join("\n");
	let truncated = lines.length > TASK_PREVIEW_MAX_LINES;
	while (Buffer.byteLength(preview, "utf8") > TASK_PREVIEW_MAX_BYTES) {
		preview = preview.slice(0, Math.max(0, preview.length - 1));
		truncated = true;
	}
	return { preview, truncated };
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

export function buildTaskReceipt(raw: SingleResult): TaskResultReceipt {
	const sourceOutput = raw.output.trim() ? raw.output : raw.stderr;
	const { preview, truncated: previewTruncated } = boundedPreview(sourceOutput.trim() || "(no output)");
	const extractedToolCounts = raw.extractedToolData
		? Object.fromEntries(
				Object.entries(raw.extractedToolData).map(([tool, values]) => [
					tool,
					Array.isArray(values) ? values.length : 0,
				]),
			)
		: undefined;
	const outputRef = raw.outputMeta
		? {
				uri: `agent://${raw.id}`,
				sizeBytes: raw.outputMeta.byteSize ?? Buffer.byteLength(raw.output, "utf8"),
				lineCount: raw.outputMeta.lineCount,
				sha256: raw.outputMeta.sha256,
			}
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
		usage: raw.usage,
		cost: raw.usage?.cost.total,
		patchPath: raw.patchPath,
		branchName: raw.branchName,
		retryFailure: raw.retryFailure
			? { attempt: raw.retryFailure.attempt, errorSummary: truncateText(raw.retryFailure.errorMessage, 300) ?? "" }
			: undefined,
		errorSummary: truncateText(raw.error, 300),
		abortSummary: truncateText(raw.abortReason, 300),
		preview,
		previewTruncated: previewTruncated || raw.truncated,
		outputRef,
		outputUnavailable: outputRef ? undefined : true,
		review: buildReview(raw),
		extractedToolCounts,
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
	outputPaths?: string[];
	async?: TaskToolDetails["async"];
}

/** Central converter from raw task details to receipt-only public details. */
export function sanitizeTaskToolDetails(raw: RawTaskToolDetails): TaskToolDetails {
	return {
		projectAgentsDir: raw.projectAgentsDir,
		results: raw.results.map(buildTaskReceipt),
		totalDurationMs: raw.totalDurationMs,
		usage: raw.usage,
		outputPaths: raw.outputPaths,
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

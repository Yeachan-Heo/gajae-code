/**
 * Live tool-result A/B accounting (issue #5945).
 *
 * Pure measurement and verdict logic over live transcripts from `tool-result-ab-live.ts`;
 * deterministic so the verdict rules are unit-testable.
 */

export const TOOL_RESULT_AB_SCHEMA_VERSION = 1;

/** Minimal structural view of a session message; matches `ToolResultMessage` from `@gajae-code/ai`. */
export interface TranscriptMessage {
	role: string;
	toolName?: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

export interface ToolResultVolume {
	calls: number;
	chars: number;
}

export interface TaskRun {
	taskId: string;
	arm: string;
	repeat: number;
	success: boolean;
	toolResultChars: number;
	byTool: Record<string, ToolResultVolume>;
	totalTokens: number;
	error?: string;
}

export interface ArmSummary {
	arm: string;
	runs: number;
	successes: number;
	successRate: number;
	/** Runs that never produced a usable transcript (provider/harness failure, not a wrong answer). */
	errored: number;
	toolResultCharsPerTask: number;
	totalTokensPerTask: number;
	byTool: Record<string, ToolResultVolume>;
}

export interface ToolResultAbVerdict {
	outcome: "candidate-wins" | "no-improvement" | "success-regressed" | "inconclusive";
	charsPerTaskDelta: number;
	charsPerTaskReduction: number;
	successRateDelta: number;
	reasons: string[];
}

export interface ToolResultAbReport {
	schemaVersion: number;
	model: string;
	repeats: number;
	arms: Record<string, Record<string, unknown>>;
	baseline: ArmSummary;
	candidate: ArmSummary;
	verdict: ToolResultAbVerdict;
	runs: TaskRun[];
}

function textLength(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content) {
		if (typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block) {
			const text = block.text;
			if (typeof text === "string") chars += text.length;
		}
	}
	return chars;
}

/** Sum the text characters every tool returned to the model, grouped by tool name. */
export function measureToolResults(messages: readonly TranscriptMessage[]): {
	chars: number;
	byTool: Record<string, ToolResultVolume>;
} {
	const byTool: Record<string, ToolResultVolume> = {};
	let chars = 0;
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const name = message.toolName ?? "unknown";
		const length = textLength(message.content);
		const entry = byTool[name] ?? { calls: 0, chars: 0 };
		entry.calls += 1;
		entry.chars += length;
		byTool[name] = entry;
		chars += length;
	}
	return { chars, byTool };
}

/** First provider error in the transcript; such a run measures the provider, not the settings. */
export function transcriptError(messages: readonly TranscriptMessage[]): string | undefined {
	for (const message of messages) {
		if (message.role === "assistant" && message.stopReason === "error") {
			return message.errorMessage ?? "assistant turn ended with an error";
		}
	}
	return undefined;
}

export function summarizeArm(arm: string, runs: readonly TaskRun[]): ArmSummary {
	const armRuns = runs.filter(run => run.arm === arm);
	if (armRuns.length === 0) throw new Error(`No runs recorded for arm ${arm}`);
	const byTool: Record<string, ToolResultVolume> = {};
	let chars = 0;
	let tokens = 0;
	let successes = 0;
	let errored = 0;
	for (const run of armRuns) {
		if (run.error !== undefined) errored += 1;
		chars += run.toolResultChars;
		tokens += run.totalTokens;
		if (run.success) successes += 1;
		for (const [tool, volume] of Object.entries(run.byTool)) {
			const entry = byTool[tool] ?? { calls: 0, chars: 0 };
			entry.calls += volume.calls;
			entry.chars += volume.chars;
			byTool[tool] = entry;
		}
	}
	return {
		arm,
		runs: armRuns.length,
		successes,
		successRate: successes / armRuns.length,
		errored,
		toolResultCharsPerTask: chars / armRuns.length,
		totalTokensPerTask: tokens / armRuns.length,
		byTool,
	};
}

/**
 * The acceptance rule from #5945: the candidate must lower tool-result chars per
 * task while task success stays unchanged (never lower than baseline).
 */
export function compareArms(baseline: ArmSummary, candidate: ArmSummary): ToolResultAbVerdict {
	const charsPerTaskDelta = candidate.toolResultCharsPerTask - baseline.toolResultCharsPerTask;
	const charsPerTaskReduction =
		baseline.toolResultCharsPerTask === 0 ? 0 : -charsPerTaskDelta / baseline.toolResultCharsPerTask;
	const successRateDelta = candidate.successRate - baseline.successRate;
	const reasons: string[] = [];
	if (baseline.errored > 0 || candidate.errored > 0) {
		reasons.push(
			`errored runs (baseline ${baseline.errored}/${baseline.runs}, candidate ${candidate.errored}/${candidate.runs}) cannot count as task outcomes`,
		);
		return { outcome: "inconclusive", charsPerTaskDelta, charsPerTaskReduction, successRateDelta, reasons };
	}
	if (successRateDelta < 0) {
		reasons.push(
			`candidate success ${candidate.successes}/${candidate.runs} is below baseline ${baseline.successes}/${baseline.runs}`,
		);
		return { outcome: "success-regressed", charsPerTaskDelta, charsPerTaskReduction, successRateDelta, reasons };
	}
	if (charsPerTaskDelta >= 0) {
		reasons.push("candidate did not lower tool-result chars per task");
		return { outcome: "no-improvement", charsPerTaskDelta, charsPerTaskReduction, successRateDelta, reasons };
	}
	return { outcome: "candidate-wins", charsPerTaskDelta, charsPerTaskReduction, successRateDelta, reasons };
}

function formatInt(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

function formatPct(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

export function renderToolResultAbMarkdown(report: ToolResultAbReport): string {
	const tools = [...new Set([...Object.keys(report.baseline.byTool), ...Object.keys(report.candidate.byTool)])].sort();
	const toolRows = tools
		.map(tool => {
			const before = report.baseline.byTool[tool] ?? { calls: 0, chars: 0 };
			const after = report.candidate.byTool[tool] ?? { calls: 0, chars: 0 };
			return `| ${tool} | ${before.calls} | ${formatInt(before.chars)} | ${after.calls} | ${formatInt(after.chars)} |`;
		})
		.join("\n");
	return `# Live tool-result A/B (#5945)

- Model: ${report.model}
- Repeats per task: ${report.repeats}
- Baseline overrides: \`${JSON.stringify(report.arms[report.baseline.arm])}\`
- Candidate overrides: \`${JSON.stringify(report.arms[report.candidate.arm])}\`

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| Task success | ${report.baseline.successes}/${report.baseline.runs} | ${report.candidate.successes}/${report.candidate.runs} |
| Errored runs | ${report.baseline.errored} | ${report.candidate.errored} |
| Tool-result chars / task | ${formatInt(report.baseline.toolResultCharsPerTask)} | ${formatInt(report.candidate.toolResultCharsPerTask)} |
| Total tokens / task | ${formatInt(report.baseline.totalTokensPerTask)} | ${formatInt(report.candidate.totalTokensPerTask)} |

| Tool | Baseline calls | Baseline chars | Candidate calls | Candidate chars |
| --- | ---: | ---: | ---: | ---: |
${toolRows}

Verdict: **${report.verdict.outcome}** (chars/task reduction ${formatPct(report.verdict.charsPerTaskReduction)}, success delta ${formatPct(report.verdict.successRateDelta)})${report.verdict.reasons.length > 0 ? `\n\nReasons: ${report.verdict.reasons.join("; ")}` : ""}
`;
}

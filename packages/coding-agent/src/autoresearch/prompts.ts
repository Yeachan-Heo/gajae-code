/**
 * Two-phase autoresearch prompts (ported from the deleted extension's
 * `prompt-setup.md` / `prompt.md`): static `.md` files rendered with the
 * shared `prompt` template engine.
 *
 * Phase 1 (`prompt-setup.md`) drives harness construction; phase 2
 * (`prompt.md`) drives the iterate loop. Every reference to the deleted
 * `/autoresearch` slash command, the old `init_experiment` /
 * `run_experiment` / `log_experiment` / `update_notes` tool names, and the old
 * `~/.gjc/autoresearch` state locations has been scrubbed — the prompts speak
 * to the native command, the mission `python` tool, and the session-scoped
 * state under `.gjc/_session-{id}/autoresearch/`.
 */
import { prompt } from "@gajae-code/utils";
import iteratePromptTemplate from "./prompts/prompt.md" with { type: "text" };
import setupPromptTemplate from "./prompts/prompt-setup.md" with { type: "text" };

export interface AutoresearchSetupPromptInput {
	baseSystemPrompt: string;
	goal: string;
	workingDir: string;
	branch: string | null;
	/** Dirty-worktree / no-repo degradation warning shown during Phase 1. */
	baselineWarning?: string | null;
}

/** Phase 1: harness-setup prompt. */
export function renderAutoresearchSetupPrompt(input: AutoresearchSetupPromptInput): string {
	const goal = input.goal.trim();
	const baselineWarning = input.baselineWarning?.trim();
	return prompt.render(setupPromptTemplate, {
		base_system_prompt: input.baseSystemPrompt,
		has_goal: goal.length > 0,
		goal,
		working_dir: input.workingDir,
		has_branch: Boolean(input.branch),
		branch: input.branch ?? "",
		has_baseline_warning: Boolean(baselineWarning),
		baseline_warning: baselineWarning ?? "",
	});
}

export interface AutoresearchRecentRunPrompt {
	run_number: number;
	status: string;
	metric_display: string;
	description: string;
	has_asi_summary: boolean;
	asi_summary: string;
	has_deviations: boolean;
	deviations: string;
	justified: boolean;
	flagged: boolean;
	flagged_reason: string;
}

export interface AutoresearchIteratePromptInput {
	baseSystemPrompt: string;
	goal: string;
	workingDir: string;
	branch: string | null;
	baselineCommit: string | null;
	metricName: string;
	metricUnit: string;
	notes: string;
	currentSegment: number;
	currentSegmentRunCount: number;
	baselineMetric: number | null;
	bestMetric: number | null;
	bestRunNumber: number | null;
	recentRuns: AutoresearchRecentRunPrompt[];
	unjustifiedRuns: Array<{ run_number: number; paths: string }>;
	pendingRun: {
		runNumber: number;
		command: string;
		parsedPrimary: number | null;
		passed: boolean;
	} | null;
}

/** Phase 2: iterate-loop prompt. */
export function renderAutoresearchIteratePrompt(input: AutoresearchIteratePromptInput): string {
	const goal = input.goal.trim();
	const notes = input.notes.trim();
	const recentRuns = input.recentRuns;
	const unjustifiedRuns = input.unjustifiedRuns;
	return prompt.render(iteratePromptTemplate, {
		base_system_prompt: input.baseSystemPrompt,
		has_goal: goal.length > 0,
		goal,
		working_dir: input.workingDir,
		has_branch: Boolean(input.branch),
		branch: input.branch ?? "",
		has_baseline_commit: Boolean(input.baselineCommit),
		baseline_commit: input.baselineCommit ? input.baselineCommit.slice(0, 12) : "",
		has_notes: notes.length > 0,
		notes,
		metric_name: input.metricName,
		current_segment: input.currentSegment,
		current_segment_run_count: input.currentSegmentRunCount,
		has_baseline_metric: input.baselineMetric !== null,
		baseline_metric_display: formatPromptMetric(input.baselineMetric, input.metricUnit),
		has_best_result: input.bestMetric !== null,
		best_metric_display: formatPromptMetric(input.bestMetric, input.metricUnit),
		best_run_number: input.bestRunNumber,
		has_recent_results: recentRuns.length > 0,
		recent_results: recentRuns,
		has_unjustified_runs: unjustifiedRuns.length > 0,
		unjustified_runs: unjustifiedRuns,
		has_pending_run: input.pendingRun !== null,
		pending_run_number: input.pendingRun?.runNumber,
		pending_run_command: input.pendingRun?.command,
		pending_run_passed: input.pendingRun?.passed ?? false,
		has_pending_run_metric: input.pendingRun?.parsedPrimary !== null && input.pendingRun?.parsedPrimary !== undefined,
		pending_run_metric_display:
			input.pendingRun?.parsedPrimary !== null && input.pendingRun?.parsedPrimary !== undefined
				? formatPromptMetric(input.pendingRun.parsedPrimary, input.metricUnit)
				: null,
	});
}

function formatPromptMetric(value: number | null, unit: string): string {
	if (value === null) return "-";
	if (Number.isInteger(value)) return `${value}${unit}`;
	return `${value.toFixed(2)}${unit}`;
}

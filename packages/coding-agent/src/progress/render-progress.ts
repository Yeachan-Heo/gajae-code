/**
 * Human-readable `/progress` view. It renders the machine-facing
 * `session.progress` snapshot, so the TUI, text mode, and ACP (which reads the
 * snapshot over the SDK) show exactly what an orchestrator receives.
 *
 * Like `progress-contract.ts`, this module must stay a dependency leaf: the ACP
 * agent imports it, and the ACP entrypoint may not reach the session graph.
 */
import {
	boundSnapshotText,
	type ProgressBasisKind,
	type ProgressHeadline,
	type ProjectProgressSnapshot,
} from "./progress-contract";

/** ACP palette copy for `/progress`, shared by the builtin registry and the production ACP agent. */
export const PROGRESS_COMMAND_ACP_DESCRIPTION = "Show read-only project progress overview";

export const PROGRESS_HEADLINE_LABELS: Record<ProgressHeadline, string> = {
	complete: "Complete",
	"awaiting-completion": "Tracked work done, awaiting completion",
	blocked: "Blocked",
	"in-progress": "In progress",
	"not-started": "Not started",
	paused: "Paused",
	dropped: "Dropped",
	"no-tracked-work": "No tracked work",
};

const BASIS_UNIT_LABELS: Record<Exclude<ProgressBasisKind, "none">, string> = {
	"ultragoal-stories": "ultragoal stories complete",
	todos: "todo items completed",
	"goal-status": "session goal complete",
};

/** Styling hooks so the TUI can colour output while ACP/text mode stays plain. */
export interface ProgressRenderStyle {
	bold(text: string): string;
	fg(color: "accent" | "success" | "warning" | "error" | "dim" | "muted", text: string): string;
}

export interface ProgressRenderOptions {
	style?: ProgressRenderStyle;
	/**
	 * Sanitizes and bounds durable text to one display line of at most `max` columns.
	 * Defaults to a character-bounded plain-text clip for ACP and text mode.
	 */
	clip?: (text: string, max: number) => string;
	barWidth?: number;
}

const PLAIN_STYLE: ProgressRenderStyle = { bold: text => text, fg: (_color, text) => text };

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

function headlineColor(headline: ProgressHeadline): "success" | "warning" | "error" | "accent" | "muted" {
	switch (headline) {
		case "complete":
			return "success";
		case "blocked":
			return "error";
		case "awaiting-completion":
		case "paused":
			return "warning";
		case "dropped":
		case "no-tracked-work":
			return "muted";
		default:
			return "accent";
	}
}

function formatElapsed(seconds: number): string {
	const minutes = Math.floor(Math.max(0, seconds) / 60);
	if (minutes < 1) return "<1m";
	const hours = Math.floor(minutes / 60);
	return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** Human-readable verification lines; the structured form is `snapshot.verification`. */
function verificationLines(verification: ProjectProgressSnapshot["verification"]): string[] {
	const lines: string[] = [];
	const receipts = verification.storyReceipts;
	if (receipts) {
		lines.push(
			`${receipts.withReceipt} of ${plural(receipts.complete, "complete story", "complete stories")} carry a recorded quality-gate receipt`,
		);
	}
	for (const { skill, verdict } of verification.reviewVerdicts) lines.push(`${skill} review verdict: ${verdict}`);
	return lines;
}

/** Render the overview as display lines (no trailing newline). */
export function renderProgressSnapshot(
	snapshot: ProjectProgressSnapshot,
	options: ProgressRenderOptions = {},
): string[] {
	const style = options.style ?? PLAIN_STYLE;
	const clip = options.clip ?? boundSnapshotText;
	const width = options.barWidth ?? 24;
	const label = (text: string) => style.fg("dim", text.padEnd(14));
	const lines: string[] = [];
	const color = headlineColor(snapshot.state);

	lines.push(`${style.bold("Project progress")}  ${style.fg(color, PROGRESS_HEADLINE_LABELS[snapshot.state])}`);
	const { completion } = snapshot;
	if (completion.percent === null || completion.basis === "none") {
		lines.push(`${style.fg("dim", `[${"·".repeat(width)}]`)} unknown`);
	} else {
		const filled = Math.round((completion.percent / 100) * width);
		const bar = `${style.fg(color, "█".repeat(filled))}${style.fg("dim", "░".repeat(width - filled))}`;
		const unit = BASIS_UNIT_LABELS[completion.basis];
		lines.push(
			`[${bar}] ~${completion.percent}%  ${style.fg("muted", `${completion.done} of ${completion.total} ${unit}`)}`,
		);
	}
	lines.push(style.fg("dim", `Basis: ${completion.explanation}`));
	lines.push("");

	const { goal, ultragoal, todos } = snapshot.execution;
	const activeWork = snapshot.activeWork;
	if (goal) {
		lines.push(
			`${label("Goal")}${goal.status} · ${formatElapsed(goal.timeUsedSeconds)} · ${clip(goal.objective, 100)}`,
		);
	}
	if (ultragoal) {
		const s = ultragoal.counts;
		const parts = [`${s.complete}/${s.total} complete`];
		if (s.active > 0) parts.push(`${s.active} active`);
		if (s.pending > 0) parts.push(`${s.pending} pending`);
		if (s.blocked > 0) parts.push(style.fg("error", `${s.blocked} blocked`));
		if (s.superseded > 0) parts.push(`${s.superseded} superseded`);
		lines.push(`${label("Ultragoal")}${parts.join(" · ")}`);
		if (activeWork.story) {
			lines.push(`${label("")}next: ${clip(activeWork.story.id, 24)} ${clip(activeWork.story.title, 90)}`);
		}
	}
	if (todos) {
		const t = todos.counts;
		const parts = [`${t.completed}/${t.total} completed`];
		if (t.inProgress > 0) parts.push(`${t.inProgress} in progress`);
		if (t.pending > 0) parts.push(`${t.pending} pending`);
		if (t.abandoned > 0) parts.push(`${t.abandoned} abandoned`);
		lines.push(`${label("Todos")}${parts.join(" · ")}`);
		if (activeWork.todo) lines.push(`${label("")}now: ${clip(activeWork.todo, 90)}`);
	}
	if (activeWork.workflows.length === 0 && snapshot.sources.unreadable.includes("workflow-state")) {
		lines.push(`${label("Workflows")}${style.fg("warning", "unknown: workflow state could not be read")}`);
	} else if (activeWork.workflows.length === 0 && snapshot.sources.unresolved.includes("workflow-state")) {
		lines.push(`${label("Workflows")}${style.fg("warning", "unknown: workflow state could not be reconciled")}`);
	} else if (activeWork.workflows.length === 0 && activeWork.omittedWorkflows === 0) {
		lines.push(`${label("Workflows")}${style.fg("dim", "none active")}`);
	} else {
		activeWork.workflows.forEach((workflow, index) => {
			const chips = workflow.chips
				.filter(chip => chip.value)
				.slice(0, 4)
				.map(chip => `${chip.label} ${clip(chip.value ?? "", 40)}`);
			const detail = [workflow.phase, ...chips].join(" · ");
			lines.push(`${label(index === 0 ? "Workflows" : "")}${clip(workflow.skill, 24)}: ${clip(detail, 110)}`);
			if (workflow.summary) lines.push(`${label("")}${style.fg("muted", clip(workflow.summary, 100))}`);
		});
		if (activeWork.omittedWorkflows > 0) {
			lines.push(
				`${label(activeWork.workflows.length === 0 ? "Workflows" : "")}${style.fg("dim", `… ${plural(activeWork.omittedWorkflows, "more active workflow")} not shown`)}`,
			);
		}
	}
	const a = activeWork.agents;
	if (a.total === 0) {
		lines.push(`${label("Agents")}${style.fg("dim", "no subagents this session")}`);
	} else {
		const parts: string[] = [];
		if (a.running > 0) parts.push(`${a.running} running`);
		if (a.waiting > 0) parts.push(`${a.waiting} queued/paused`);
		if (a.completed > 0) parts.push(`${a.completed} completed`);
		if (a.failed > 0) parts.push(style.fg("error", `${a.failed} failed`));
		if (a.cancelled > 0) parts.push(`${a.cancelled} cancelled`);
		lines.push(`${label("Agents")}${parts.join(" · ")}`);
	}
	const verification = verificationLines(snapshot.verification);
	if (verification.length === 0) {
		lines.push(`${label("Verification")}${style.fg("dim", "no durable verification evidence recorded")}`);
	} else {
		verification.forEach((line, index) => {
			lines.push(`${label(index === 0 ? "Verification" : "")}${clip(line, 110)}`);
		});
	}

	if (snapshot.attention.length > 0 || snapshot.omittedAttention > 0) {
		lines.push("", style.bold("Attention"));
		for (const item of snapshot.attention) {
			const marker =
				item.kind === "blocker"
					? style.fg("error", "✖")
					: item.kind === "pending"
						? style.fg("warning", "…")
						: style.fg("dim", "·");
			lines.push(`  ${marker} ${clip(item.text, 140)}`);
		}
		if (snapshot.omittedAttention > 0) {
			lines.push(`  ${style.fg("dim", `… ${plural(snapshot.omittedAttention, "more attention item")} not shown`)}`);
		}
	}
	return lines;
}

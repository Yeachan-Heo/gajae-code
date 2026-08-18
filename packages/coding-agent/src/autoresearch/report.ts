/**
 * Autoresearch synthesized report: reuses `src/rlm/report.ts` to render the
 * mission report from executed notebook cells plus the final summary, and
 * carries the mission verdict from the runtime's verdict receipt.
 */
import type { AutoresearchLedgerEvent, AutoresearchVerdictReceipt } from "../gjc-runtime/autoresearch-runtime";
import { writeRlmReport } from "../rlm/complete-research-tool";
import type { RlmNotebookWriter } from "../rlm/notebook";
import type { RlmArtifactPaths } from "../rlm/types";

/** Latest `verdict_issued` receipt in the ledger, or null when none exists. */
export function extractVerdictFromLedger(
	ledger: readonly AutoresearchLedgerEvent[],
): AutoresearchVerdictReceipt | null {
	for (let index = ledger.length - 1; index >= 0; index -= 1) {
		const event = ledger[index];
		if (event.event === "verdict_issued" && event.verdictReceipt) {
			return event.verdictReceipt as AutoresearchVerdictReceipt;
		}
	}
	return null;
}

export interface AutoresearchReportInput {
	paths: RlmArtifactPaths;
	notebook: RlmNotebookWriter;
	mission: { objective: string; slug: string; mode: string };
	/** Optional final summary; when omitted the report is notebook-only. */
	summary?: string;
	/** The mission verdict receipt to embed (latest from the ledger, typically). */
	verdict?: AutoresearchVerdictReceipt | null;
	dataPath?: string | null;
}

function renderBullets(items: readonly string[]): string {
	if (items.length === 0) return "- (none)";
	return items.map(item => `- ${item}`).join("\n");
}

function renderStatusBlock(status: Record<string, unknown>): string {
	return `\`\`\`json\n${JSON.stringify(status, null, 2)}\n\`\`\``;
}

function renderVerdictSection(verdict: AutoresearchVerdictReceipt): string {
	const lines = [
		"## Verdict",
		"",
		`- Evaluator: ${verdict.evaluator}`,
		`- Issued: ${verdict.issuedAt}`,
		"",
		"### Status",
		"",
		renderStatusBlock(verdict.status),
		"",
		"### Evidence",
		"",
		renderBullets(verdict.evidence),
		"",
		"### Caveats",
		"",
		renderBullets(verdict.caveats),
	];
	if (verdict.criticReceipt) {
		const critic = verdict.criticReceipt;
		lines.push("", "### Critic review", "");
		lines.push(`- Critic evaluator: ${critic.evaluator}`);
		lines.push(`- Recorded: ${critic.recordedAt}`);
		lines.push("", renderStatusBlock(critic.status), "");
		lines.push("Critic evidence:", "", renderBullets(critic.evidence), "");
		lines.push("Critic caveats:", "", renderBullets(critic.caveats));
	}
	return lines.join("\n");
}

/**
 * Synthesize and persist the mission report: base report from the executed
 * notebook cells plus the final summary (via the RLM report writer), then the
 * verdict section appended on top when a verdict receipt is supplied.
 * Returns the full report text.
 */
export async function synthesizeAutoresearchReport(input: AutoresearchReportInput): Promise<string> {
	const title = `Autoresearch report: ${input.mission.objective}`;
	const base = await writeRlmReport({
		paths: input.paths,
		notebook: input.notebook,
		title,
		summary: input.summary,
		dataPath: input.dataPath,
	});
	if (!input.verdict) {
		return base;
	}
	const report = `${base.trimEnd()}\n\n${renderVerdictSection(input.verdict)}\n`;
	await Bun.write(input.paths.reportPath, report);
	return report;
}

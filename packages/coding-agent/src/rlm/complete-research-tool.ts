/**
 * RLM completion/report tool.
 *
 * This is the model-facing stop/report seam for autonomous research mode. It
 * writes the deterministic report from the live notebook and, for final
 * completion, marks the RLM controller complete so the existing agent loop can
 * pause through CreateAgentSessionOptions.shouldPause.
 */
import * as z from "zod/v4";
import type { NotebookCell, NotebookDocument } from "../edit/notebook";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { ToolError } from "../tools/tool-errors";
import type { RlmNotebookWriter } from "./notebook";
import { synthesizeRlmReport } from "./report";
import type { RlmArtifactPaths } from "./types";

export const RLM_COMPLETE_RESEARCH_TOOL_NAME = "complete_research";

const paramsSchema = z.object({
	summary: z
		.string()
		.min(1)
		.describe("Concise final report summary grounded in notebook outputs and cited observations."),
	final: z
		.boolean()
		.optional()
		.describe("Set false to synthesize a draft report without ending the research session."),
});

export interface RlmReportWriteInput {
	paths: RlmArtifactPaths;
	notebook: RlmNotebookWriter;
	title: string;
	summary?: string;
	dataPath?: string | null;
}

export interface RlmCompleteResearchContext extends RlmReportWriteInput {
	minSuccessfulRuns?: number;
	getGoalStatus?: () => string | undefined;
	markCompleted?: (summary: string) => void;
}

function cellText(value: string | string[] | undefined): string {
	if (value === undefined) return "";
	return Array.isArray(value) ? value.join("") : value;
}

function isErrorOutput(output: unknown): boolean {
	if (!output || typeof output !== "object") return false;
	const record = output as Record<string, unknown>;
	return record.output_type === "error" || (record.output_type === "stream" && record.name === "stderr");
}

function hasAnyOutput(cell: NotebookCell): boolean {
	return Array.isArray(cell.outputs) && cell.outputs.length > 0;
}

export function countSuccessfulNotebookRuns(notebook: NotebookDocument): number {
	return notebook.cells.filter(cell => {
		if (cell.cell_type !== "code") return false;
		if (!hasAnyOutput(cell)) return true;
		return !(cell.outputs ?? []).some(isErrorOutput);
	}).length;
}

export function summarizeNotebookForReplay(notebook: NotebookDocument, maxChars: number = 12_000): string {
	const parts: string[] = [];
	let codeIndex = 0;
	for (const cell of notebook.cells) {
		if (cell.cell_type === "markdown") {
			const text = cellText(cell.source).trim();
			if (text.length > 0) parts.push(`Markdown:\n${text}`);
			continue;
		}
		if (cell.cell_type !== "code") continue;
		codeIndex += 1;
		const source = cellText(cell.source).trimEnd();
		const outputs = (cell.outputs ?? [])
			.map(output => {
				if (!output || typeof output !== "object") return "";
				const record = output as Record<string, unknown>;
				if (record.output_type === "stream")
					return cellText(record.text as string | string[] | undefined).trimEnd();
				if (record.output_type === "error") return [record.ename, record.evalue].filter(Boolean).join(": ");
				return "";
			})
			.filter(Boolean)
			.join("\n");
		parts.push(
			[`Cell ${codeIndex}:`, "```python", source, "```", outputs ? `Output:\n${outputs}` : undefined]
				.filter(Boolean)
				.join("\n"),
		);
	}
	const text = parts.join("\n\n---\n\n");
	return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n...[prior notebook replay truncated]` : text;
}

export async function writeRlmReport(input: RlmReportWriteInput): Promise<string> {
	await input.notebook.flush();
	const report = synthesizeRlmReport({
		title: input.title,
		summary: input.summary,
		notebook: input.notebook.document,
		dataPath: input.dataPath,
	});
	await Bun.write(input.paths.reportPath, report);
	return report;
}

export function createRlmCompleteResearchTool(context: RlmCompleteResearchContext): CustomTool<typeof paramsSchema> {
	return {
		name: RLM_COMPLETE_RESEARCH_TOOL_NAME,
		label: "Complete Research",
		description:
			'Synthesize the RLM report from the live notebook. For final completion, call goal({op:"complete"}) first, then call this tool with final=true (default). Use final=false for a draft /report without ending the session.',
		parameters: paramsSchema,
		strict: true,
		concurrency: "exclusive",
		async execute(_toolCallId, params) {
			const final = params.final ?? true;
			const minRuns = Math.max(0, Math.floor(context.minSuccessfulRuns ?? 0));
			const successfulRuns = countSuccessfulNotebookRuns(context.notebook.document);
			if (final && minRuns > 0 && successfulRuns < minRuns) {
				throw new ToolError(
					`complete_research requires at least ${minRuns} successful Python run(s); current successful runs: ${successfulRuns}.`,
				);
			}

			if (final) {
				const goalStatus = context.getGoalStatus?.();
				if (goalStatus !== undefined && goalStatus !== "complete") {
					throw new ToolError(
						`complete_research finalization requires goal({op:"complete"}) first; current RLM goal status is ${goalStatus}.`,
					);
				}
			}

			await writeRlmReport({
				paths: context.paths,
				notebook: context.notebook,
				title: context.title,
				summary: params.summary,
				dataPath: context.dataPath,
			});

			if (final) {
				context.markCompleted?.(params.summary);
			}

			const action = final ? "Final report synthesized" : "Draft report synthesized";
			return {
				content: [
					{
						type: "text",
						text: `${action}: ${context.paths.reportPath}\nSuccessful Python runs: ${successfulRuns}`,
					},
				],
			};
		},
	};
}

/**
 * RLM `python` tool: the model-facing research execution tool. Wraps the shared
 * persistent Python kernel executor and records every call as a notebook cell.
 */
import type { AgentToolResult } from "@gajae-code/agent-core";
import { type Static, z } from "@gajae-code/ai";
import { executePython } from "../eval/py/executor";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { RlmNotebookWriter } from "./notebook";
import type { RlmCellResult } from "./types";

export const RLM_PYTHON_TOOL_NAME = "python";

export interface RlmPythonToolContext {
	cwd: string;
	sessionId: string;
	artifactsDir: string;
	notebook: RlmNotebookWriter;
}

const paramsSchema = z.object({
	code: z
		.string()
		.describe("Python source to execute in the persistent research kernel. State persists across calls."),
});

export function createRlmPythonTool(rlm: RlmPythonToolContext): CustomTool<typeof paramsSchema> {
	return {
		name: RLM_PYTHON_TOOL_NAME,
		label: "Python",
		description:
			"Execute Python in the persistent research kernel. Variables, imports, and loaded data persist across calls like notebook cells. Every call is recorded as a cell in the session notebook.",
		parameters: paramsSchema,
		async execute(
			_toolCallId: string,
			params: Static<typeof paramsSchema>,
			_onUpdate,
			_ctx,
			signal?: AbortSignal,
		): Promise<AgentToolResult> {
			const result = await executePython(params.code, {
				cwd: rlm.cwd,
				kernelMode: "session",
				sessionId: `rlm:${rlm.sessionId}`,
				kernelOwnerId: `rlm:${rlm.sessionId}`,
				artifactsDir: rlm.artifactsDir,
				signal,
			});
			const cell: RlmCellResult = {
				output: result.output,
				exitCode: result.exitCode,
				cancelled: result.cancelled,
				truncated: result.truncated,
				displayOutputs: result.displayOutputs,
			};
			await rlm.notebook.appendCode(params.code, cell);
			const text = result.output.length > 0 ? result.output : "(no output)";
			return { content: [{ type: "text", text }] };
		},
	};
}

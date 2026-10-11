import type { AgentTool } from "@gajae-code/agent-core";
import { assertWorkflowMutationAllowed } from "../skill-state/workflow-mutation-guard";

const bashShapedTool = {
	name: "bash",
	label: "bash",
	description: "bash",
	parameters: {},
	execute: async () => ({ content: [] }),
} as AgentTool;

/**
 * Judge a monitor command with the same mutation rules as bash. Monitor is a
 * background shell, so a planning-phase mutation must fail before the job starts.
 */
export async function assertMonitorMutationAllowed(input: {
	cwd: string;
	sessionId?: string;
	command: string;
}): Promise<void> {
	await assertWorkflowMutationAllowed({
		cwd: input.cwd,
		sessionId: input.sessionId,
		tool: bashShapedTool,
		args: { command: input.command },
	});
}

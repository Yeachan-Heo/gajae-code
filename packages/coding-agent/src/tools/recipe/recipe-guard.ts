import type { AgentTool } from "@gajae-code/agent-core";
import { assertWorkflowMutationAllowed } from "../../skill-state/workflow-mutation-guard";

const BASH_GUARD_TOOL = { name: "bash" } as AgentTool;

/** Apply the session bash planning guard to a recipe command before it runs. */
export async function assertRecipeCommandAllowed(input: {
	cwd: string;
	sessionId?: string;
	command: string;
	commandCwd?: string;
}): Promise<void> {
	await assertWorkflowMutationAllowed({
		cwd: input.cwd,
		sessionId: input.sessionId,
		tool: BASH_GUARD_TOOL,
		args: { command: input.command, cwd: input.commandCwd },
	});
}

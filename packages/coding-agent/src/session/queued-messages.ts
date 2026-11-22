import type { AgentMessage } from "@gajae-code/agent-core";

/** Whether a hidden queued message is a companion of an adjacent user prompt. */
export function isHiddenUserCompanion(message: AgentMessage): boolean {
	return message.role === "custom" && message.display === false;
}

/** Whether a queued user prompt was authored by the user rather than handed off by an agent. */
export function isUserAuthoredQueuedMessage(message: AgentMessage): boolean {
	return (
		(message.role === "user" || (message.role === "custom" && message.attribution === "user")) &&
		!("attribution" in message && message.attribution === "agent")
	);
}

import type { AgentSession } from "./agent-session";

/** Private SDK-to-session projection; deliberately absent from ExtensionContext. */
export interface CommittedPromptFailure {
	code: "prompt_deadline_exceeded";
	message: "Prompt deadline exceeded.";
}

export type CommittedPromptFailureWriter = (
	executionHandle: string,
	failure: CommittedPromptFailure,
	isCurrent: () => boolean,
) => Promise<"persisted" | "stale">;

const writers = new WeakMap<AgentSession, CommittedPromptFailureWriter>();

/** Installed by AgentSession with its private immutable run ownership resolver. */
export function registerCommittedPromptFailureWriter(
	session: AgentSession,
	writer: CommittedPromptFailureWriter,
): void {
	writers.set(session, writer);
}

export async function recordCommittedPromptFailure(
	session: AgentSession,
	executionHandle: string,
	failure: CommittedPromptFailure,
	isCurrent: () => boolean,
): Promise<"persisted" | "stale"> {
	if (!isCurrent()) return "stale";
	const writer = writers.get(session);
	if (!writer)
		throw Object.assign(new Error("Committed prompt failure persistence is unavailable."), {
			code: "prompt_failure_projection_unavailable",
		});
	if (failure.code !== "prompt_deadline_exceeded" || failure.message !== "Prompt deadline exceeded.")
		throw new Error("Unsupported committed prompt failure.");
	return writer(
		executionHandle,
		{ code: "prompt_deadline_exceeded", message: "Prompt deadline exceeded." },
		isCurrent,
	);
}

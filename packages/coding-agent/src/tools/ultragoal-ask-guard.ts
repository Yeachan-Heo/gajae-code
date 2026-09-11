import type { AgentTool } from "@gajae-code/agent-core";
import {
	consumeUltragoalAskNudge,
	isUltragoalAskBlocked,
	type UltragoalAskBlockDiagnostic,
} from "../gjc-runtime/ultragoal-guard";
import { ToolError } from "./tool-errors";

const ULTRAGOAL_ASK_GUARD = Symbol.for("gajae-code.ultragoalAskGuard");

type GuardedTool = AgentTool & { [ULTRAGOAL_ASK_GUARD]?: true };

export interface UltragoalAskGuardContext {
	/**
	 * GJC session id of the session asking the question. This is the guard's only
	 * identity input: durable Ultragoal state and the nudge budget are bound to it
	 * exclusively. Active-skill metadata is deliberately NOT part of this context —
	 * a snapshot restored from another session carries that session's id, and
	 * treating it as the caller's identity leaked a foreign run into the guard.
	 */
	sessionId?: string | null;
}

export function formatUltragoalAskBlockMessage(diagnostic: UltragoalAskBlockDiagnostic): string {
	return [
		diagnostic.message,
		`Ultragoal ask guard blocked ask (source: ${diagnostic.source}; reason: ${diagnostic.reason}).`,
		"Use `gjc ultragoal record-review-blockers` to record the blocker instead of asking the user.",
	].join("\n");
}

export async function assertUltragoalAskAllowed(
	cwd: string,
	context: UltragoalAskGuardContext = {},
	agentDir?: string,
): Promise<void> {
	// Durable Ultragoal state is session-scoped, so only the caller's own run may
	// block `ask`. An anonymous caller has no run attributable to it, so the guard
	// fails open instead of falling back to GJC_SESSION_ID or an auto-detected
	// session: either can name another (possibly dead) session's abandoned run and
	// would make `ask` unusable for every session in the repository.
	const sessionId = context.sessionId?.trim();
	if (!sessionId) return;
	const diagnostic = await isUltragoalAskBlocked(cwd, { sessionId });
	if (!diagnostic.active) return;
	const nudge = await consumeUltragoalAskNudge(cwd, sessionId, agentDir);
	if (nudge.nudged) throw new ToolError(nudge.message);
	throw new ToolError(formatUltragoalAskBlockMessage(diagnostic));
}

export function guardToolForUltragoalAsk<T extends AgentTool>(
	tool: T,
	getCwd: () => string,
	getContext: () => UltragoalAskGuardContext = () => ({}),
	getSessionAgentDir: () => string | undefined = () => undefined,
): T {
	if (tool.name !== "ask") return tool;
	const candidate = tool as GuardedTool;
	if (candidate[ULTRAGOAL_ASK_GUARD]) return tool;
	const wrapped = new Proxy(tool, {
		get(target, prop) {
			if (prop === ULTRAGOAL_ASK_GUARD) return true;
			if (prop !== "execute") return Reflect.get(target, prop);
			return async (...args: unknown[]): Promise<unknown> => {
				// The wrapper runs BEFORE AskTool.execute(): resolve the nudge
				// budget against the SESSION profile, never the process-global one.
				// The caller session id is the only binding, so a foreign session's
				// durable run can never gate this ask.
				await assertUltragoalAskAllowed(getCwd(), getContext(), getSessionAgentDir());
				return Reflect.apply(target.execute, target, args);
			};
		},
	}) as T & GuardedTool;
	wrapped[ULTRAGOAL_ASK_GUARD] = true;
	return wrapped as T;
}

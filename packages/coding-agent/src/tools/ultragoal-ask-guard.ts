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
	activeSkillState?: { skill?: string; session_id?: string } | null;
	sessionId?: string | null;
}

const UPSTREAM_PLANNING_ASK_SKILLS = new Set(["deep-interview", "ralplan"]);

function normalizedActiveSkill(context?: UltragoalAskGuardContext): string | undefined {
	const skill = context?.activeSkillState?.skill?.trim();
	return skill || undefined;
}

function sessionScopedAskGuardId(
	context: UltragoalAskGuardContext,
	activeSkill: string | undefined,
): string | undefined {
	if (activeSkill !== "ultragoal" && !UPSTREAM_PLANNING_ASK_SKILLS.has(activeSkill ?? "")) return undefined;
	const activeSessionId = context.activeSkillState?.session_id?.trim();
	if (activeSessionId) return activeSessionId;
	const sessionId = context.sessionId?.trim();
	return sessionId || undefined;
}

export function formatUltragoalAskBlockMessage(diagnostic: UltragoalAskBlockDiagnostic): string {
	return [
		diagnostic.message,
		`Ultragoal ask guard blocked ask (source: ${diagnostic.source}; reason: ${diagnostic.reason}).`,
		"Use `gjc ultragoal record-review-blockers` to record the blocker instead of asking the user.",
	].join("\n");
}

export async function assertUltragoalAskAllowed(cwd: string, context: UltragoalAskGuardContext = {}): Promise<void> {
	const activeSkill = normalizedActiveSkill(context);
	// Deep-interview and ralplan are upstream planning workflows whose core gates
	// are `ask` calls. Scope their Ultragoal check to the current session so stale
	// or ambiguous Ultragoal durable state from another session cannot hijack those
	// prompts; same-session active Ultragoal state still falls through to the
	// blocker/nudge checks below.
	const sessionId = sessionScopedAskGuardId(context, activeSkill);
	const diagnostic = await isUltragoalAskBlocked(cwd, { sessionId });
	if (!diagnostic.active) return;
	const nudge = await consumeUltragoalAskNudge(cwd, sessionId);
	if (nudge.nudged) throw new ToolError(nudge.message);
	throw new ToolError(formatUltragoalAskBlockMessage(diagnostic));
}

export function guardToolForUltragoalAsk<T extends AgentTool>(
	tool: T,
	getCwd: () => string,
	getContext: () => UltragoalAskGuardContext = () => ({}),
): T {
	if (tool.name !== "ask") return tool;
	const candidate = tool as GuardedTool;
	if (candidate[ULTRAGOAL_ASK_GUARD]) return tool;
	const wrapped = new Proxy(tool, {
		get(target, prop, receiver) {
			if (prop === ULTRAGOAL_ASK_GUARD) return true;
			if (prop !== "execute") return Reflect.get(target, prop, receiver);
			return async (...args: unknown[]): Promise<unknown> => {
				await assertUltragoalAskAllowed(getCwd(), getContext());
				return Reflect.apply(target.execute, target, args);
			};
		},
	}) as T & GuardedTool;
	wrapped[ULTRAGOAL_ASK_GUARD] = true;
	return wrapped as T;
}

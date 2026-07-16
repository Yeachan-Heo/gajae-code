import type { AgentTool } from "@gajae-code/agent-core";
import { workflowTransactionLockPath } from "../gjc-runtime/session-layout";
import { withWorkflowStateLock } from "../gjc-runtime/state-writer";
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
	const activeSessionId = context.activeSkillState?.session_id?.trim();
	if (activeSessionId && (activeSkill === "ultragoal" || UPSTREAM_PLANNING_ASK_SKILLS.has(activeSkill ?? ""))) {
		return activeSessionId;
	}
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

async function throwUltragoalAskBlocked(
	cwd: string,
	sessionId: string | undefined,
	diagnostic: UltragoalAskBlockDiagnostic,
): Promise<never> {
	const nudge = await consumeUltragoalAskNudge(cwd, sessionId);
	if (nudge.nudged) throw new ToolError(nudge.message);
	throw new ToolError(formatUltragoalAskBlockMessage(diagnostic));
}

export async function assertUltragoalAskAllowed(cwd: string, context: UltragoalAskGuardContext = {}): Promise<void> {
	const activeSkill = normalizedActiveSkill(context);
	// Deep-interview and ralplan are upstream planning workflows whose core gates
	// are `ask` calls. Scope their Ultragoal check to the current session so stale
	// or ambiguous Ultragoal durable state from another session cannot hijack those
	// prompts; same-session active Ultragoal state still falls through to the
	// blocker/nudge checks below.
	const sessionId = sessionScopedAskGuardId(context, activeSkill);
	const diagnostic = sessionId
		? await withWorkflowStateLock(
				workflowTransactionLockPath(cwd, sessionId),
				() => isUltragoalAskBlocked(cwd, { sessionId }),
				{ cwd },
			)
		: await isUltragoalAskBlocked(cwd, { sessionId });
	if (!diagnostic.active) return;
	await throwUltragoalAskBlocked(cwd, sessionId, diagnostic);
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
				const cwd = getCwd();
				const context = getContext();
				const sessionId = sessionScopedAskGuardId(context, normalizedActiveSkill(context));
				if (!sessionId) {
					await assertUltragoalAskAllowed(cwd, context);
					return Reflect.apply(target.execute, target, args);
				}

				let execution: unknown;
				let started = false;
				const diagnostic = await withWorkflowStateLock(
					workflowTransactionLockPath(cwd, sessionId),
					async () => {
						const result = await isUltragoalAskBlocked(cwd, { sessionId });
						if (!result.active) {
							// Start the tool synchronously while the exact authorization
							// snapshot is still protected. Store its returned promise
							// without awaiting it so the interactive lifetime is unlocked.
							execution = Reflect.apply(target.execute, target, args);
							started = true;
						}
						return result;
					},
					{ cwd },
				);
				if (started) return execution;
				await throwUltragoalAskBlocked(cwd, sessionId, diagnostic);
			};
		},
	}) as T & GuardedTool;
	wrapped[ULTRAGOAL_ASK_GUARD] = true;
	return wrapped as T;
}

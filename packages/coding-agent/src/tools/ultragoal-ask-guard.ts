import type { AgentTool } from "@gajae-code/agent-core";
import { resolveRalplanCurrentFinal, selectsRalplanApprovalGate } from "../gjc-runtime/ralplan-current-final";
import {
	consumeUltragoalAskNudge,
	isUltragoalAskBlocked,
	isUltragoalPauseBlocked,
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

/**
 * Whether a human-blocked receipt still names the current verified human-only
 * blocker: no newer classification, a fresh clean pause verdict against the
 * current plan, and its single ask unspent. Re-run under the ledger lock when
 * the ask is reserved, so a receipt superseded after the guard ran is refused.
 */
export async function isHumanBlockedAskReceiptCurrent(
	cwd: string,
	receipt: { sessionId: string; classificationEventId: string },
): Promise<boolean> {
	const pause = await isUltragoalPauseBlocked(cwd, { sessionId: receipt.sessionId });
	return !pause.blocked && !pause.askSpent && pause.classificationEventId === receipt.classificationEventId;
}

/** Why the guard let an `ask` through, for the caller that has to settle it. */
export interface UltragoalAskAdmission {
	/**
	 * Set when a verified human-only blocker admitted the ask. Each `human_blocked`
	 * classification admits one question: the caller reserves it with
	 * `recordUltragoalHumanBlockedAskReserved` before asking, then records the
	 * answer or releases the reservation.
	 */
	humanBlockedReceipt?: { sessionId: string; classificationEventId: string };
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
	pendingQuestions?: unknown,
): Promise<UltragoalAskAdmission | undefined> {
	// Durable Ultragoal state is session-scoped, so only the caller's own run may
	// block `ask`. An anonymous caller has no run attributable to it, so the guard
	// fails open instead of falling back to GJC_SESSION_ID or an auto-detected
	// session: either can name another (possibly dead) session's abandoned run and
	// would make `ask` unusable for every session in the repository.
	const sessionId = context.sessionId?.trim();
	if (!sessionId) return;
	const diagnostic = await isUltragoalAskBlocked(cwd, { sessionId });
	if (!diagnostic.active) return;
	// The one ask that may proceed while a goal is blocked is the execution
	// approval for an authenticated current ralplan final (issue #6578). The
	// request must select that gate and the final must validate on disk; a
	// caller-declared tag alone never lifts the guard. AskTool still captures and
	// authenticates the publication it records consent against.
	if (selectsRalplanApprovalGate(pendingQuestions)) {
		const resolution = await resolveRalplanCurrentFinal({ cwd, sessionId, agentDir });
		if (resolution.ok) return;
		throw new ToolError(`Ultragoal ask guard refused the ralplan execution approval: ${resolution.refusal.reason}`);
	}
	// A verified human-only blocker is the other ask that may proceed. The pause
	// gate already proves it: the latest classification is `human_blocked` and a
	// fresh clean terminal-critic verdict is bound to it. Once the run may park
	// for the user, refusing the question that states what the user must provide
	// only forces the same request into unstructured prose. The receipt is the
	// whole authority: it goes stale on any required-goal change or newer
	// classification, and unreadable state still fails closed. Unlike the pause
	// surface, no try-harder nudge is spent first: a nudge would only delay the
	// question the receipt already proves is the user's to answer.
	//
	// One `human_blocked` classification admits one answered question. The guard
	// cannot judge whether a question is about the blocker, so it bounds the
	// count instead: a single-question ask only, and AskTool records the answer
	// against the classification, which then stops admitting. A cancelled ask
	// leaves it unspent; a spent one is refused like any other ask.
	if (diagnostic.source !== "durable_state_unreadable") {
		const pause = await isUltragoalPauseBlocked(cwd, { sessionId });
		if (!pause.blocked) {
			if (!pause.classificationEventId) return;
			if (!pause.askSpent) {
				const questions = (pendingQuestions as { questions?: unknown } | undefined)?.questions;
				if (!Array.isArray(questions) || questions.length !== 1) {
					throw new ToolError(
						"Ultragoal ask guard: a verified human-only blocker admits exactly one question. Ask the single question that states what the user must provide.",
					);
				}
				return { humanBlockedReceipt: { sessionId, classificationEventId: pause.classificationEventId } };
			}
		}
	}
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
				await assertUltragoalAskAllowed(getCwd(), getContext(), getSessionAgentDir(), args[1]);
				return Reflect.apply(target.execute, target, args);
			};
		},
	}) as T & GuardedTool;
	wrapped[ULTRAGOAL_ASK_GUARD] = true;
	return wrapped as T;
}

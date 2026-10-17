import type { AgentTool } from "@gajae-code/agent-core";
import { captureExecutionApprovalPresentation, type ExecutionApprovalPresentation } from "../gjc-runtime/state-runtime";
import {
	consumeUltragoalAskNudge,
	isUltragoalAskBlocked,
	type UltragoalAskBlockDiagnostic,
} from "../gjc-runtime/ultragoal-guard";
import { ToolError } from "./tool-errors";

const ULTRAGOAL_ASK_GUARD = Symbol.for("gajae-code.ultragoalAskGuard");
const RALPLAN_ULTRAGOAL_APPROVAL_OPTIONS = ["Refine further", "Approve execution via ultragoal", "Stop here"] as const;

type GuardedTool = AgentTool & { [ULTRAGOAL_ASK_GUARD]?: true };
const builtinAskTools = new WeakSet<object>();

export function markBuiltinAskTool<T extends object>(tool: T): T {
	builtinAskTools.add(tool);
	return tool;
}

export function formatRalplanUltragoalApprovalQuestion(
	presentation: ExecutionApprovalPresentation,
): string | undefined {
	if (!presentation.run_id || !/^[a-f0-9]{64}$/.test(presentation.artifact_sha256)) return undefined;
	return `Approve execution via ultragoal for the current Ralplan final at ${JSON.stringify(presentation.artifact_path)} (run_id=${JSON.stringify(presentation.run_id)}, sha256=${presentation.artifact_sha256})?`;
}

export function isAcceptedRalplanApprovalResponse(
	selectedOptions: string[],
	customInput: string | undefined,
	clarificationQuestion: string | undefined,
	timedOut: boolean,
): boolean {
	return (
		!timedOut &&
		selectedOptions.length === 1 &&
		RALPLAN_ULTRAGOAL_APPROVAL_OPTIONS.some(option => option === selectedOptions[0]) &&
		customInput === undefined &&
		clarificationQuestion === undefined
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSingleRalplanUltragoalApproval(params: unknown, expectedQuestion?: string): boolean {
	if (!isRecord(params) || !Array.isArray(params.questions) || params.questions.length !== 1) return false;
	const question = params.questions[0];
	if (
		!isRecord(question) ||
		typeof question.question !== "string" ||
		question.multi !== false ||
		question.recommended !== 1 ||
		!isRecord(question.workflowGate)
	)
		return false;
	if (expectedQuestion !== undefined && question.question !== expectedQuestion) return false;
	if (question.workflowGate.stage !== "ralplan" || question.workflowGate.kind !== "approval") return false;
	if (!Array.isArray(question.options) || question.options.length !== RALPLAN_ULTRAGOAL_APPROVAL_OPTIONS.length)
		return false;
	return question.options.every(
		(option, index) => isRecord(option) && option.label === RALPLAN_ULTRAGOAL_APPROVAL_OPTIONS[index],
	);
}

export function isCanonicalRalplanUltragoalApproval(
	params: unknown,
	presentation: ExecutionApprovalPresentation,
): boolean {
	const expectedQuestion = formatRalplanUltragoalApprovalQuestion(presentation);
	return expectedQuestion !== undefined && isSingleRalplanUltragoalApproval(params, expectedQuestion);
}

async function isVerifiedRalplanUltragoalApproval(
	cwd: string,
	sessionId: string,
	diagnostic: UltragoalAskBlockDiagnostic,
	params: unknown,
): Promise<ExecutionApprovalPresentation | undefined> {
	if (
		diagnostic.source !== "goals_json" ||
		(!diagnostic.reason.includes("recorded review blockers") &&
			!diagnostic.reason.includes("incomplete required goals")) ||
		!isSingleRalplanUltragoalApproval(params)
	)
		return undefined;
	try {
		// The public workflowGate fields are routing hints only. The narrowly exempt
		// ask must identify the runtime-verified current final publication visibly.
		const presentation = await captureExecutionApprovalPresentation(cwd, sessionId, "ralplan");
		return isCanonicalRalplanUltragoalApproval(params, presentation) ? presentation : undefined;
	} catch {
		return undefined;
	}
}

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
	params?: unknown,
	allowRalplanApproval = false,
): Promise<ExecutionApprovalPresentation | undefined> {
	// Durable Ultragoal state is session-scoped, so only the caller's own run may
	// block `ask`. An anonymous caller has no run attributable to it, so the guard
	// fails open instead of falling back to GJC_SESSION_ID or an auto-detected
	// session: either can name another (possibly dead) session's abandoned run and
	// would make `ask` unusable for every session in the repository.
	const sessionId = context.sessionId?.trim();
	if (!sessionId) return undefined;
	const diagnostic = await isUltragoalAskBlocked(cwd, { sessionId });
	if (!diagnostic.active) return undefined;
	const presentation = allowRalplanApproval
		? await isVerifiedRalplanUltragoalApproval(cwd, sessionId, diagnostic, params)
		: undefined;
	if (presentation) return presentation;
	const nudge = await consumeUltragoalAskNudge(cwd, sessionId, agentDir);
	if (nudge.nudged) throw new ToolError(nudge.message);
	throw new ToolError(formatUltragoalAskBlockMessage(diagnostic));
}

export function guardToolForUltragoalAsk<T extends AgentTool>(
	tool: T,
	getCwd: () => string,
	getContext: () => UltragoalAskGuardContext = () => ({}),
	getSessionAgentDir: () => string | undefined = () => undefined,
	builtinAskProvenance = false,
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
				await assertUltragoalAskAllowed(
					getCwd(),
					getContext(),
					getSessionAgentDir(),
					args[1],
					builtinAskTools.has(tool) || builtinAskProvenance,
				);
				return Reflect.apply(target.execute, target, args);
			};
		},
	}) as T & GuardedTool;
	wrapped[ULTRAGOAL_ASK_GUARD] = true;
	return wrapped as T;
}

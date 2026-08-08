import type { RawArgumentValidationResult } from "@gajae-code/ai/types";
import type { ToolSession } from ".";
import { askSchema, intentContract, intentReview, recoverRoundZeroIntentContract } from "./ask-contract";
import { validateRawTodoArguments } from "./todo-contract";

export const deferredAskParameters = askSchema;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * The deferred registry and the loaded TodoWriteTool must reject and accept the
 * same payloads: a divergence here fails the call before the tool can load, and
 * the model has no way to see which rule it broke.
 */
export const validateDeferredTodoArguments = validateRawTodoArguments;

export const validateDeferredAskArguments = (
	arguments_: Record<string, unknown>,
	session?: ToolSession,
): RawArgumentValidationResult => recoverRoundZeroIntentContract(arguments_, session?.getDeepInterviewAskStage?.());

export type DeferredIntentPolicy = (arguments_: Record<string, unknown>) => string | undefined;

export const deferredIntentPolicies: Readonly<Record<string, DeferredIntentPolicy>> = {
	bisect: arguments_ =>
		typeof arguments_.run === "string" && arguments_.run ? `bisecting: ${arguments_.run}` : "bisecting regression",
	checkpoint: arguments_ =>
		typeof arguments_.goal === "string" && arguments_.goal ? `checkpointing: ${arguments_.goal}` : "checkpointing",
	rewind: () => "rewinding",
	eval: arguments_ => {
		const cells = Array.isArray(arguments_.cells) ? arguments_.cells : [];
		const first = cells.find(cell => isPlainRecord(cell));
		if (!first) return "evaluating";
		const title = typeof first.title === "string" ? first.title : undefined;
		const language = typeof first.language === "string" ? first.language : "?";
		const label = title || `running ${language}`;
		return cells.length > 1 ? `${label} (+${cells.length - 1})` : label;
	},
};

export { intentContract, intentReview };

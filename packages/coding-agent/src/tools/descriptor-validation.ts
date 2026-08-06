import type { RawArgumentValidationResult } from "@gajae-code/ai/types";
import type { ToolSession } from ".";
import { askSchema, intentContract, intentReview, recoverRoundZeroIntentContract } from "./ask-contract";

export const deferredAskParameters = askSchema;

const TODO_WRITE_KEYS = new Set(["ops"]);
const TODO_OP_KEYS = new Set(["op", "list", "task", "phase", "items", "text"]);
const TODO_INIT_ENTRY_KEYS = new Set(["phase", "items"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasUnknownKeys(value: object, allowed: Set<string>): boolean {
	return Object.keys(value).some(key => !allowed.has(key));
}

export function validateDeferredTodoArguments(arguments_: Record<string, unknown>): RawArgumentValidationResult {
	if (hasUnknownKeys(arguments_, TODO_WRITE_KEYS)) return { outcome: "reject" };
	if (!Array.isArray(arguments_.ops)) return { outcome: "passthrough" };
	for (const entry of arguments_.ops) {
		if (!isPlainRecord(entry)) continue;
		if (hasUnknownKeys(entry, TODO_OP_KEYS)) return { outcome: "reject" };
		if ((entry.op === "done" || entry.op === "drop") && !entry.task && !entry.phase) return { outcome: "reject" };
		if (!Array.isArray(entry.list)) continue;
		for (const item of entry.list) {
			if (isPlainRecord(item) && hasUnknownKeys(item, TODO_INIT_ENTRY_KEYS)) return { outcome: "reject" };
		}
	}
	return { outcome: "passthrough" };
}

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

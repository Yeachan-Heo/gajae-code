/** Canonical thinking transport used by a model, without provider/runtime imports. */
export type ThinkingControlMode =
	| "effort"
	| "budget"
	| "google-level"
	| "anthropic-adaptive"
	| "anthropic-budget-effort";

export const THINKING_CONTROL_MODES = [
	"effort",
	"budget",
	"google-level",
	"anthropic-adaptive",
	"anthropic-budget-effort",
] as const satisfies readonly ThinkingControlMode[];

type _CheckThinkingControlModes = [
	Exclude<ThinkingControlMode, (typeof THINKING_CONTROL_MODES)[number]>,
	Exclude<(typeof THINKING_CONTROL_MODES)[number], ThinkingControlMode>,
] extends [never, never]
	? true
	: false;
true satisfies _CheckThinkingControlModes;

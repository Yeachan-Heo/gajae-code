/**
 * Deep-interview gate mapping (#316).
 *
 * Converts deep-interview `ask`-tool questions into machine-addressable
 * `workflow_gate` { kind: "question" } events (option set + free-text shape
 * encoded in `schema`/`options`) and decodes a `workflow_gate_response` answer
 * back into the exact QuestionResult shape the human path produces, so ambiguity
 * scoring/state updates proceed identically whether a human or an agent answers.
 *
 * This is the pure mapping primitive. Routing the ask tool through it (instead of
 * the interactive select/editor UI) when an unattended controller + gate broker
 * are attached is wired with the transport in #321 and exercised by #323.
 */
import type { RpcJsonSchema, RpcWorkflowGateKind, RpcWorkflowStage } from "../../rpc/rpc-types";
import type { OpenGateInput } from "./workflow-gate-broker";

/** "Other (type your own)" sentinel, mirroring the interactive ask tool. */
export const GATE_OTHER_OPTION = "Other (type your own)";

/** Optional structured deep-interview round metadata supplied by the agent. */
export interface AskGateDeepInterviewState {
	round_id?: string;
	round: number;
	component: string;
	dimension: string;
	ambiguity: number;
}

export interface AskGateWorkflowGateMeta {
	stage: RpcWorkflowStage;
	kind: RpcWorkflowGateKind;
}

export interface AskGateQuestion {
	id: string;
	question: string;
	options: Array<{ label: string }>;
	multi?: boolean;
	recommended?: number;
	/**
	 * Structured round metadata. When present it is the authoritative source for gate
	 * `stage_state`; when absent, the question text is regex-parsed as a fallback.
	 */
	deepInterview?: AskGateDeepInterviewState;
	/** Override the emitted workflow gate address for non-deep-interview ask prompts. */
	workflowGate?: AskGateWorkflowGateMeta;
}

export interface AskGateResult {
	id: string;
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
}

/**
 * The answer shape an agent returns for a deep-interview question gate.
 *
 * `selected` are picked option labels; free text is conveyed by `other: true`
 * plus `custom`, encoded separately from `selected` so a real option whose label
 * happens to equal the display sentinel can never collide with the free-text path.
 */
export interface DeepInterviewGateAnswer {
	selected: string[];
	other?: boolean;
	custom?: string;
}

export class DeepInterviewGateError extends Error {
	constructor(
		readonly code:
			| "invalid_answer_shape"
			| "unknown_option"
			| "multi_not_allowed"
			| "missing_custom"
			| "empty_selection"
			| "duplicate_selection",
		message: string,
	) {
		super(message);
		this.name = "DeepInterviewGateError";
	}
}

function deepInterviewQuestionState(questionText: string): Record<string, unknown> {
	const roundMatch = /^Round\s+(\d+)\s+\|\s+([^|]+?)\s+\|\s+Ambiguity:\s*(.+?)\s*$/im.exec(questionText);
	const state: Record<string, unknown> = {};
	if (roundMatch) {
		const round = Number(roundMatch[1]);
		if (Number.isFinite(round)) state.round = round;
		const mode = roundMatch[2]?.trim();
		if (mode) {
			state.mode = mode;
			const normalized = mode.toLowerCase();
			if (normalized.includes("topology")) state.topology_gate = true;
			if (/(contrarian|simplifier|ontologist)/u.test(normalized)) state.challenge_mode = normalized;
		}
		const ambiguity = roundMatch[3]?.trim();
		if (ambiguity) state.ambiguity = ambiguity;
	}
	if (/Round\s+0\s+\|\s+Topology confirmation/im.test(questionText)) {
		state.round = 0;
		state.mode = "Topology confirmation";
		state.topology_gate = true;
	}
	return state;
}

function questionAnswerSchema(question: AskGateQuestion, labels: string[]): RpcJsonSchema {
	const multi = question.multi ?? false;
	const selectedItems: RpcJsonSchema = { type: "string", enum: labels };
	const selectedBase: RpcJsonSchema = { type: "array", items: selectedItems, uniqueItems: true };
	const selectedOnly: RpcJsonSchema = {
		...selectedBase,
		minItems: 1,
		...(multi ? {} : { maxItems: 1 }),
	};
	const selectedWithOther: RpcJsonSchema = {
		...selectedBase,
		...(multi ? {} : { maxItems: 0 }),
	};
	return {
		type: "object",
		properties: {
			selected: selectedBase,
			other: { type: "boolean", description: "set true to provide a free-text answer in `custom`" },
			custom: { type: "string", minLength: 1, description: "free-text answer; required when `other` is true" },
		},
		required: ["selected"],
		additionalProperties: false,
		anyOf: [
			{
				type: "object",
				properties: { selected: selectedOnly, other: { const: false } },
				required: ["selected"],
				additionalProperties: false,
			},
			{
				type: "object",
				properties: {
					selected: selectedWithOther,
					other: { const: true },
					custom: { type: "string", minLength: 1 },
				},
				required: ["selected", "other", "custom"],
				additionalProperties: false,
			},
		],
	};
}

/** Build `stage_state` round metadata from the structured param (authoritative when present). */
function structuredDeepInterviewState(meta: AskGateDeepInterviewState): Record<string, unknown> {
	const state: Record<string, unknown> = {
		deep_interview_metadata: true,
		round: meta.round,
		component: meta.component,
		dimension: meta.dimension,
		ambiguity: meta.ambiguity,
	};
	if (meta.round_id !== undefined) state.round_id = meta.round_id;
	return state;
}

/** Build the `workflow_gate` open-input for one ask question. */
export function questionToGate(question: AskGateQuestion): OpenGateInput {
	const labels = question.options.map(o => o.label);
	const schema = questionAnswerSchema(question, labels);
	return {
		stage: question.workflowGate?.stage ?? "deep-interview",
		kind: question.workflowGate?.kind ?? "question",
		schema,
		options: question.options.map((o, i) => ({
			value: o.label,
			label: o.label,
			description: i === question.recommended ? "recommended" : undefined,
		})),
		context: {
			title: question.question,
			prompt: question.question,
			stage_state: {
				question_id: question.id,
				multi: question.multi ?? false,
				options: labels,
				other_option: GATE_OTHER_OPTION,
				...(question.deepInterview
					? structuredDeepInterviewState(question.deepInterview)
					: deepInterviewQuestionState(question.question)),
			},
		},
	};
}

function isAnswer(value: unknown): value is DeepInterviewGateAnswer {
	if (typeof value !== "object" || value === null) return false;
	const v = value as DeepInterviewGateAnswer;
	return (
		Array.isArray(v.selected) &&
		v.selected.every(s => typeof s === "string") &&
		(v.other === undefined || typeof v.other === "boolean") &&
		(v.custom === undefined || typeof v.custom === "string")
	);
}

/**
 * Decode a gate answer into the QuestionResult the interactive path produces.
 * Selections are de-duplicated (the interactive UI stores them in a Set), and
 * free text is taken from `other`/`custom`. Throws DeepInterviewGateError on a
 * semantically invalid answer.
 */
export function gateAnswerToResult(question: AskGateQuestion, answer: unknown): AskGateResult {
	if (!isAnswer(answer)) {
		throw new DeepInterviewGateError(
			"invalid_answer_shape",
			"answer must be { selected: string[]; other?: boolean; custom?: string }",
		);
	}
	const labels = question.options.map(o => o.label);
	const multi = question.multi ?? false;
	const valid = new Set(labels);
	for (const sel of answer.selected) {
		if (!valid.has(sel)) throw new DeepInterviewGateError("unknown_option", `unknown option: ${sel}`);
	}
	// Mirror the interactive UI, which stores selections in a Set (no duplicates).
	const deduped = [...new Set(answer.selected)];
	if (deduped.length !== answer.selected.length) {
		throw new DeepInterviewGateError("duplicate_selection", "selected options must be unique");
	}
	const other = answer.other === true;
	const totalPicks = deduped.length + (other ? 1 : 0);
	if (totalPicks === 0) {
		throw new DeepInterviewGateError(
			"empty_selection",
			"at least one option (or the free-text other) must be selected",
		);
	}
	if (!multi && totalPicks > 1) {
		throw new DeepInterviewGateError("multi_not_allowed", "this question accepts a single selection");
	}
	if (other && (answer.custom === undefined || answer.custom.trim() === "")) {
		throw new DeepInterviewGateError("missing_custom", "custom text is required when `other` is true");
	}
	return {
		id: question.id,
		question: question.question,
		options: labels,
		multi,
		selectedOptions: deduped,
		customInput: other ? answer.custom : undefined,
	};
}

/** Convenience: map a batch of ask questions to gate open-inputs. */
export function questionsToGates(questions: AskGateQuestion[]): OpenGateInput[] {
	return questions.map(questionToGate);
}

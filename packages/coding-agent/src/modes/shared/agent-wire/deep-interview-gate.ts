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
import type { RpcJsonSchema } from "../../rpc/rpc-types";
import type { OpenGateInput } from "./workflow-gate-broker";

/** "Other (type your own)" sentinel, mirroring the interactive ask tool. */
export const GATE_OTHER_OPTION = "Other (type your own)";

export interface AskGateQuestion {
	id: string;
	question: string;
	options: Array<{ label: string }>;
	multi?: boolean;
	recommended?: number;
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

/** Build the `workflow_gate` open-input for one deep-interview question. */
export function questionToGate(question: AskGateQuestion): OpenGateInput {
	const labels = question.options.map(o => o.label);
	const schema: RpcJsonSchema = {
		type: "object",
		properties: {
			selected: {
				type: "array",
				items: { type: "string", enum: labels },
			},
			other: { type: "boolean", description: "set true to provide a free-text answer in `custom`" },
			custom: { type: "string", description: "free-text answer; required when `other` is true" },
		},
		required: ["selected"],
		additionalProperties: false,
	};
	return {
		stage: "deep-interview",
		kind: "question",
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

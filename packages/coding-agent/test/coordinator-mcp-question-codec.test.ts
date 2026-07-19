import { describe, expect, it } from "bun:test";
import {
	answerBindingMatches,
	createAnswerBinding,
	decodeAskGateV1,
	projectAskGateQuestion,
	translateCoordinatorAskAnswer,
	validateCoordinatorAskAnswer,
} from "../src/coordinator-mcp/question-gate-codec";
import { schemaHash } from "../src/modes/shared/agent-wire/workflow-gate-schema";
import {
	buildAskGateAnswerSchema,
	GATE_OTHER_OPTION,
	type WorkflowGate,
} from "../src/modes/shared/agent-wire/workflow-gate-types";

function askSchema(labels: string[], multi: boolean, allowEmpty: boolean) {
	return buildAskGateAnswerSchema({ multi, allowEmpty }, labels);
}

function gate(): WorkflowGate {
	const labels = ["Keep current plan", "Revise scope"];
	return {
		type: "workflow_gate",
		gate_id: "wg_issue_2550_deep-interview_000001",
		stage: "deep-interview",
		kind: "question",
		schema: askSchema(labels, false, false),
		schema_hash: schemaHash(askSchema(labels, false, false)),
		required: true,
		created_at: "2026-07-17T00:00:00.000Z",
		context: {
			title: "Which plan should be used?",
			prompt: "Which plan should be used?",
			stage_state: {
				question_id: "q-12",
				multi: false,
				allow_empty: false,
				options: labels,
				other_option: GATE_OTHER_OPTION,
				clarification_action: "clarify",
			},
		},
		options: labels.map(label => ({ value: label, label })),
	};
}

describe("coordinator MCP ask-gate codec", () => {
	it("projects a pending Q12 ask without exposing the private codec or binding after it is answered", () => {
		const codec = decodeAskGateV1(gate());
		if (!codec) throw new Error("expected a valid deep-interview ask gate");
		const binding = createAnswerBinding();
		const pending = projectAskGateQuestion({
			question_id: "q-12",
			session_id: "session-2550",
			turn_id: "turn-2550",
			status: "pending",
			stage: "deep-interview",
			kind: "question",
			prompt: "Which plan should be used?",
			codec,
			created_at: "2026-07-17T00:00:00.000Z",
			updated_at: "2026-07-17T00:00:00.000Z",
			answered_at: null,
			reason: null,
			answer_binding: binding,
		});
		expect(pending).toMatchObject({
			question_id: "q-12",
			status: "pending",
			answer_binding: binding,
		});
		expect(pending.options[0]).toEqual({ id: "opt_0", label: "Keep current plan", recommended: false });
		expect(JSON.stringify(pending)).not.toContain("labels");

		const answered = projectAskGateQuestion({
			...pending,
			codec,
			status: "answered",
			answered_at: "2026-07-17T00:01:00.000Z",
		});
		expect(answered.answer_binding).toBeUndefined();
	});

	it("validates bounded public answers and translates only option ids to private gate labels", () => {
		const codec = decodeAskGateV1(gate());
		if (!codec) throw new Error("expected a valid deep-interview ask gate");
		const answer = validateCoordinatorAskAnswer(codec, { selected: ["opt_1"] });
		expect(answer).toEqual({ selected: ["opt_1"] });
		expect(translateCoordinatorAskAnswer(codec, answer!)).toEqual({ selected: ["Revise scope"] });
		expect(validateCoordinatorAskAnswer(codec, { selected: ["opt_9"] })).toBeNull();
		expect(validateCoordinatorAskAnswer(codec, { selected: ["opt_0", "opt_1"] })).toBeNull();
	});

	it("uses opaque, exact answer bindings", () => {
		const binding = createAnswerBinding();
		expect(binding).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(answerBindingMatches(binding, binding)).toBe(true);
		expect(answerBindingMatches(`${binding}x`, binding)).toBe(false);
	});
});

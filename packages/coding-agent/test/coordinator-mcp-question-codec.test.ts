import { describe, expect, it } from "bun:test";
import {
	answerBindingMatches,
	createAnswerBinding,
	decodeAskGateV1,
	projectAskGateQuestion,
	translateCoordinatorAskAnswer,
	validateCoordinatorAskAnswer,
} from "../src/coordinator-mcp/question-gate-codec";
import { approvalGate } from "../src/modes/shared/agent-wire/approval-gate";
import { type AskGateQuestion, questionToGate } from "../src/modes/shared/agent-wire/deep-interview-gate";
import { schemaHash } from "../src/modes/shared/agent-wire/workflow-gate-schema";
import {
	buildAskGateAnswerSchema,
	GATE_OTHER_OPTION,
	type WorkflowGate,
} from "../src/modes/shared/agent-wire/workflow-gate-types";

function askSchema(
	labels: string[],
	multi: boolean,
	allowEmpty: boolean,
	allowOther = true,
	allowClarification = true,
) {
	return buildAskGateAnswerSchema({ multi, allowEmpty, allowOther, allowClarification }, labels);
}

function gate(stage: WorkflowGate["stage"] = "deep-interview", kind: WorkflowGate["kind"] = "question"): WorkflowGate {
	const labels = ["Keep current plan", "Revise scope"];
	const approvalGate = stage === "ralplan" && kind === "approval";
	const schema = askSchema(labels, false, false, !approvalGate, !approvalGate);
	return {
		type: "workflow_gate",
		gate_id: "wg_issue_2550_deep-interview_000001",
		stage,
		kind,
		schema,
		schema_hash: schemaHash(schema),
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

function lifecycleApprovalGate(): WorkflowGate {
	const input = approvalGate({ title: "Approve the plan?" });
	return {
		...gate("ralplan", "approval"),
		...input,
		gate_id: "wg_ralplan_approval_lifecycle_000001",
		schema_hash: schemaHash(input.schema),
	};
}

describe("coordinator MCP ask-gate codec", () => {
	it("decodes exactly the supported stage/kind pairs", () => {
		const positivePairs = [
			["deep-interview", "question"],
			["ralplan", "question"],
			["ultragoal", "question"],
			["ralplan", "approval"],
		] as const;
		for (const [stage, kind] of positivePairs) {
			expect(decodeAskGateV1(gate(stage, kind)), `${stage}/${kind}`).not.toBeNull();
		}

		const negativePairs = [
			["deep-interview", "approval"],
			["deep-interview", "execution"],
			["ralplan", "execution"],
			["ultragoal", "approval"],
			["ultragoal", "execution"],
		] as const;
		for (const [stage, kind] of negativePairs) {
			expect(decodeAskGateV1(gate(stage, kind)), `${stage}/${kind}`).toBeNull();
		}
	});

	it("rejects the ralplan approval lifecycle-decision schema", () => {
		expect(decodeAskGateV1(lifecycleApprovalGate())).toBeNull();
	});

	it("preserves the no-custom Ralplan approval policy through Coordinator projection and validation", () => {
		const question: AskGateQuestion = {
			id: "ralplan-approval",
			question: "Approve the current Ralplan final?",
			options: [{ label: "Refine further" }, { label: "Approve execution via ultragoal" }, { label: "Stop here" }],
			multi: false,
			recommended: 1,
			workflowGate: { stage: "ralplan", kind: "approval" },
		};
		const emitted = questionToGate(question);
		if (!emitted.context) throw new Error("expected questionToGate to emit context");
		const codec = decodeAskGateV1({
			type: "workflow_gate",
			gate_id: "wg_ralplan_approval_000001",
			stage: emitted.stage,
			kind: emitted.kind,
			schema: emitted.schema,
			schema_hash: schemaHash(emitted.schema),
			required: true,
			created_at: "2026-07-17T00:00:00.000Z",
			context: emitted.context,
			options: emitted.options,
		});
		if (!codec) throw new Error("expected a valid restricted Ralplan approval gate");
		const projected = projectAskGateQuestion({
			question_id: question.id,
			session_id: "session-approval",
			turn_id: "turn-approval",
			status: "pending",
			stage: "ralplan",
			kind: "approval",
			prompt: question.question,
			codec,
			created_at: "2026-07-17T00:00:00.000Z",
			updated_at: "2026-07-17T00:00:00.000Z",
			answered_at: null,
			reason: null,
		});

		expect(projected.other_allowed).toBe(false);
		expect(projected.clarification_allowed).toBe(false);
		expect(projected.answer_schema.properties?.custom).toBeUndefined();
		expect(projected.answer_schema.properties?.question).toBeUndefined();
		expect(validateCoordinatorAskAnswer(codec, { selected: [], other: true, custom: "Postgres" })).toBeNull();
		expect(validateCoordinatorAskAnswer(codec, { action: "clarify", question: "Why?" })).toBeNull();

		const answer = validateCoordinatorAskAnswer(codec, { selected: ["opt_1"] });
		expect(answer).toEqual({ selected: ["opt_1"] });
		expect(translateCoordinatorAskAnswer(codec, answer!)).toEqual({
			selected: ["Approve execution via ultragoal"],
		});
	});

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

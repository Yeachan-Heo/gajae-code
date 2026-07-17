import { describe, expect, it } from "bun:test";
import {
	type AskGateQuestion,
	DeepInterviewGateError,
	gateAnswerToResult,
	questionsToGates,
	questionToGate,
} from "../src/modes/shared/agent-wire/deep-interview-gate";
import {
	type GateContinuation,
	MemoryGateStore,
	WorkflowGateBroker,
} from "../src/modes/shared/agent-wire/workflow-gate-broker";

function activeContinuation(): GateContinuation {
	let active = true;
	return {
		activate: () => {},
		terminalProof: "not_published",
		isLive: () => active,
		release: () => {
			active = false;
		},
	};
}

const singleQ: AskGateQuestion = {
	id: "q1",
	question: "Which auth method?",
	options: [{ label: "JWT" }, { label: "OAuth2" }, { label: "Session cookies" }],
	recommended: 0,
};

const multiQ: AskGateQuestion = {
	id: "q2",
	question: "Which storages?",
	options: [{ label: "SQLite" }, { label: "Postgres" }],
	multi: true,
};

describe("questionToGate", () => {
	it("emits a deep-interview question gate with option set + free-text schema", () => {
		const gate = questionToGate(singleQ);
		expect(gate.stage).toBe("deep-interview");
		expect(gate.kind).toBe("question");
		expect(gate.options?.map(o => o.label)).toEqual(["JWT", "OAuth2", "Session cookies"]);
		expect(gate.options?.[0]?.description).toBe("recommended");
		// schema is the documented subset and accepts answers or clarification.
		expect(gate.schema.properties?.selected?.items?.enum).toEqual(["JWT", "OAuth2", "Session cookies"]);
		expect(gate.schema.properties?.other?.type).toBe("boolean");
		expect(gate.schema.properties?.action?.enum).toEqual(["answer", "clarify"]);
		expect(gate.schema.properties?.custom?.pattern).toBe("\\S");
		expect(gate.context?.stage_state).toMatchObject({
			question_id: "q1",
			multi: false,
			other_option: "Other (type your own)",
		});
	});

	it("maps a batch", () => {
		expect(questionsToGates([singleQ, multiQ])).toHaveLength(2);
	});
});

describe("gateAnswerToResult (human-path parity)", () => {
	it("decodes a single selection", () => {
		expect(gateAnswerToResult(singleQ, { selected: ["OAuth2"] })).toEqual({
			id: "q1",
			question: "Which auth method?",
			options: ["JWT", "OAuth2", "Session cookies"],
			multi: false,
			selectedOptions: ["OAuth2"],
			customInput: undefined,
		});
	});

	it("decodes multi selections", () => {
		const r = gateAnswerToResult(multiQ, { selected: ["SQLite", "Postgres"] });
		expect(r.selectedOptions).toEqual(["SQLite", "Postgres"]);
		expect(r.multi).toBe(true);
	});

	it("handles the Other free-text option", () => {
		const r = gateAnswerToResult(singleQ, { selected: [], other: true, custom: "Passkeys" });
		expect(r.selectedOptions).toEqual([]);
		expect(r.customInput).toBe("Passkeys");
	});
	it("handles clarification as a non-answer", () => {
		const r = gateAnswerToResult(singleQ, { action: "clarify", question: "How are JWT and OAuth2 different?" });
		expect(r.selectedOptions).toEqual([]);
		expect(r.customInput).toBeUndefined();
		expect(r.clarificationQuestion).toBe("How are JWT and OAuth2 different?");
	});

	it("rejects invalid answers", () => {
		expect(() => gateAnswerToResult(singleQ, { selected: [] })).toThrow(DeepInterviewGateError);
		expect(() => gateAnswerToResult(singleQ, { selected: ["Nope"] })).toThrow(/unknown option/);
		expect(() => gateAnswerToResult(singleQ, { selected: ["JWT", "OAuth2"] })).toThrow(/single selection/);
		expect(() => gateAnswerToResult(singleQ, { selected: [], other: true })).toThrow(/custom text is required/);
		expect(() => gateAnswerToResult(singleQ, { foo: 1 })).toThrow(/answer must be/);
		expect(() => gateAnswerToResult(singleQ, { action: "clarify", question: " \t\n " })).toThrow(
			/clarification question is required/,
		);
		expect(() =>
			gateAnswerToResult(singleQ, { action: "clarify", question: "Which one?", selected: ["JWT"] }),
		).toThrow(/answer must be/);
		expect(() =>
			gateAnswerToResult(singleQ, { action: "clarify", question: "Which one?", selected: [], other: false }),
		).toThrow(/answer must be/);
	});
});

describe("end-to-end via the broker", () => {
	it("emits the question gate and validates the answer against the advertised schema", async () => {
		const advanced: unknown[] = [];
		const broker = new WorkflowGateBroker("run-di", new MemoryGateStore(), {
			advance: (_gate, answer) => {
				advanced.push(answer);
			},
		});
		const gate = broker.openGate(questionToGate(singleQ), activeContinuation());
		expect(broker.listPendingGates()).toEqual([gate]);

		// A schema-invalid answer (selected not an array) is rejected, gate stays pending.
		const bad = await broker.resolve({ gate_id: gate.gate_id, answer: { selected: "OAuth2" } });
		expect(bad.status).toBe("rejected");
		// A schema-invalid single-select answer cannot combine a normal option and Other.
		const combined = await broker.resolve({
			gate_id: gate.gate_id,
			answer: { selected: ["JWT"], other: true, custom: "Passkeys" },
		});
		expect(combined.status).toBe("rejected");
		expect(combined.error?.errors.some(e => e.keyword === "anyOf")).toBe(true);
		const blankOther = await broker.resolve({
			gate_id: gate.gate_id,
			answer: { selected: [], other: true, custom: " \t\n " },
		});
		expect(blankOther.status).toBe("rejected");
		expect(blankOther.error?.errors.some(e => e.keyword === "pattern")).toBe(true);
		const blankClarification = await broker.resolve({
			gate_id: gate.gate_id,
			answer: { action: "clarify", question: " \t\n " },
		});
		expect(blankClarification.status).toBe("rejected");
		expect(blankClarification.error?.errors.some(e => e.keyword === "pattern")).toBe(true);
		// A schema-valid answer is accepted and decodes to the human-path result.
		const good = await broker.resolve({ gate_id: gate.gate_id, answer: { selected: ["JWT"] } });
		expect(good.status).toBe("accepted");
		expect(advanced).toEqual([{ selected: ["JWT"] }]);
		expect(gateAnswerToResult(singleQ, { selected: ["JWT"] }).selectedOptions).toEqual(["JWT"]);
	});

	it("accepts single-select normal selection, Other-only, and clarification paths", async () => {
		const advanced: unknown[] = [];
		const broker = new WorkflowGateBroker("run-di-valid", new MemoryGateStore(), {
			advance: (_gate, answer) => {
				advanced.push(answer);
			},
		});
		const selectionGate = broker.openGate(questionToGate(singleQ), activeContinuation());
		expect(broker.listPendingGates()).toEqual([selectionGate]);

		const selection = await broker.resolve({ gate_id: selectionGate.gate_id, answer: { selected: ["JWT"] } });
		expect(selection.status).toBe("accepted");

		const otherGate = broker.openGate(questionToGate(singleQ), activeContinuation());

		const other = await broker.resolve({
			gate_id: otherGate.gate_id,
			answer: { selected: [], other: true, custom: "Passkeys" },
		});
		expect(other.status).toBe("accepted");

		const clarifyGate = broker.openGate(questionToGate(singleQ), activeContinuation());

		const clarify = await broker.resolve({
			gate_id: clarifyGate.gate_id,
			answer: { action: "clarify", question: "What does OAuth2 imply here?" },
		});
		expect(clarify.status).toBe("accepted");
		expect(advanced).toEqual([
			{ selected: ["JWT"] },
			{ selected: [], other: true, custom: "Passkeys" },
			{ action: "clarify", question: "What does OAuth2 imply here?" },
		]);
	});
});

describe("questionToGate structured deep-interview metadata", () => {
	it("uses structured metadata for stage_state when present", () => {
		const gate = questionToGate({
			id: "q-struct",
			question: "Round 1 | Component: Conflict Detection | Targeting: Goal | Ambiguity: 66%\n\nWhich triggers?",
			options: [{ label: "A only" }, { label: "All four" }],
			deepInterview: {
				round_id: "r-1",
				round: 1,
				component: "conflict-detection",
				dimension: "goal",
				ambiguity: 0.66,
			},
		});
		const state = gate.context?.stage_state as Record<string, unknown>;
		expect(state.deep_interview_metadata).toBe(true);
		expect(state.round).toBe(1);
		expect(state.component).toBe("conflict-detection");
		expect(state.dimension).toBe("goal");
		expect(state.ambiguity).toBe(0.66);
		expect(state.round_id).toBe("r-1");
	});

	it("structured metadata wins over conflicting question text", () => {
		const gate = questionToGate({
			id: "q-conflict",
			question: "Round 99 | Topology confirmation | Ambiguity: 80%",
			options: [{ label: "x" }],
			deepInterview: { round: 2, component: "bidirectional-ambiguity", dimension: "constraints", ambiguity: 0.4 },
		});
		const state = gate.context?.stage_state as Record<string, unknown>;
		expect(state.round).toBe(2);
		expect(state.deep_interview_metadata).toBe(true);
		// The regex would have parsed round 99 / topology_gate from the text; metadata overrides it.
		expect(state.topology_gate).toBeUndefined();
	});

	it("falls back to regex parsing when metadata is absent (unchanged behavior)", () => {
		const gate = questionToGate({
			id: "q-regex",
			question: "Round 3 | Targeting: Constraints | Ambiguity: 40%",
			options: [{ label: "x" }],
		});
		const state = gate.context?.stage_state as Record<string, unknown>;
		expect(state.round).toBe(3);
		expect(state.deep_interview_metadata).toBeUndefined();
	});
});

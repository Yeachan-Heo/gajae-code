import { describe, expect, it } from "bun:test";
import {
	type AskGateQuestion,
	DeepInterviewGateError,
	gateAnswerToResult,
	questionsToGates,
	questionToGate,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/deep-interview-gate";
import {
	MemoryGateStore,
	WorkflowGateBroker,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/workflow-gate-broker";

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
		// schema is the documented subset and accepts {selected, custom?}
		expect(gate.schema.properties?.selected?.items?.enum).toEqual(["JWT", "OAuth2", "Session cookies"]);
		expect(gate.schema.properties?.other?.type).toBe("boolean");
		expect(gate.schema.required).toEqual(["selected"]);
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

	it("rejects invalid answers", () => {
		expect(() => gateAnswerToResult(singleQ, { selected: [] })).toThrow(DeepInterviewGateError);
		expect(() => gateAnswerToResult(singleQ, { selected: ["Nope"] })).toThrow(/unknown option/);
		expect(() => gateAnswerToResult(singleQ, { selected: ["JWT", "OAuth2"] })).toThrow(/single selection/);
		expect(() => gateAnswerToResult(singleQ, { selected: [], other: true })).toThrow(/custom text is required/);
		expect(() => gateAnswerToResult(singleQ, { foo: 1 })).toThrow(/answer must be/);
	});
});

describe("end-to-end via the broker", () => {
	it("emits the question gate and validates the answer against the advertised schema", async () => {
		const broker = new WorkflowGateBroker("run-di", new MemoryGateStore());
		const gate = broker.openGate(questionToGate(singleQ));
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
		// A schema-valid answer is accepted and decodes to the human-path result.
		const good = await broker.resolve({ gate_id: gate.gate_id, answer: { selected: ["JWT"] } });
		expect(good.status).toBe("accepted");
		expect(gateAnswerToResult(singleQ, { selected: ["JWT"] }).selectedOptions).toEqual(["JWT"]);
	});

	it("accepts single-select normal selection and Other-only paths", async () => {
		const broker = new WorkflowGateBroker("run-di-valid", new MemoryGateStore());
		const selectionGate = broker.openGate(questionToGate(singleQ));
		const selection = await broker.resolve({ gate_id: selectionGate.gate_id, answer: { selected: ["JWT"] } });
		expect(selection.status).toBe("accepted");

		const otherGate = broker.openGate(questionToGate(singleQ));
		const other = await broker.resolve({
			gate_id: otherGate.gate_id,
			answer: { selected: [], other: true, custom: "Passkeys" },
		});
		expect(other.status).toBe("accepted");
	});
});

import { describe, expect, it } from "bun:test";
import {
	type AskGateQuestion,
	DeepInterviewGateError,
	gateAnswerToResult,
	questionToGate,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/deep-interview-gate";
import {
	MemoryGateStore,
	WorkflowGateBroker,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/workflow-gate-broker";
import { schemaHash } from "@gajae-code/coding-agent/modes/shared/agent-wire/workflow-gate-schema";

const singleQ: AskGateQuestion = {
	id: "single-auth",
	question: "Which auth method should we use?",
	options: [{ label: "JWT" }, { label: "OAuth2" }, { label: "Session cookies" }],
	recommended: 1,
};

const multiQ: AskGateQuestion = {
	id: "multi-storage",
	question: "Which storage backends should be supported?",
	options: [{ label: "SQLite" }, { label: "Postgres" }, { label: "S3" }],
	multi: true,
};

const freeTextQ: AskGateQuestion = {
	id: "free-text",
	question: "Which deployment target did we miss?",
	options: [{ label: "Vercel" }, { label: "Fly.io" }],
};

async function resolveQuestion(question: AskGateQuestion, answer: unknown) {
	const broker = new WorkflowGateBroker(`run-${question.id}`, new MemoryGateStore());
	const gate = broker.openGate(questionToGate(question));
	const resolution = await broker.resolve({ gate_id: gate.gate_id, answer });
	return { gate, resolution };
}

describe("deep-interview question gates red-team", () => {
	it("round-trips single, multi, and Other free-text answers through the broker to the human-path QuestionResult", async () => {
		const single = await resolveQuestion(singleQ, { selected: ["JWT"] });
		expect(single.resolution.status).toBe("accepted");
		expect(gateAnswerToResult(singleQ, { selected: ["JWT"] })).toEqual({
			id: "single-auth",
			question: "Which auth method should we use?",
			options: ["JWT", "OAuth2", "Session cookies"],
			multi: false,
			selectedOptions: ["JWT"],
			customInput: undefined,
		});

		const multi = await resolveQuestion(multiQ, { selected: ["SQLite", "S3"] });
		expect(multi.resolution.status).toBe("accepted");
		expect(gateAnswerToResult(multiQ, { selected: ["SQLite", "S3"] })).toEqual({
			id: "multi-storage",
			question: "Which storage backends should be supported?",
			options: ["SQLite", "Postgres", "S3"],
			multi: true,
			selectedOptions: ["SQLite", "S3"],
			customInput: undefined,
		});

		const otherAnswer = { selected: [], other: true, custom: "Bare metal" };
		const other = await resolveQuestion(freeTextQ, otherAnswer);
		expect(other.resolution.status).toBe("accepted");
		expect(gateAnswerToResult(freeTextQ, otherAnswer)).toEqual({
			id: "free-text",
			question: "Which deployment target did we miss?",
			options: ["Vercel", "Fly.io"],
			multi: false,
			selectedOptions: [],
			customInput: "Bare metal",
		});
	});

	it("rejects malformed answers against the advertised schema via the broker", async () => {
		const cases: Array<{ name: string; answer: unknown; keyword: string }> = [
			{ name: "selected not an array", answer: { selected: "JWT" }, keyword: "type" },
			{ name: "selected item outside enum", answer: { selected: ["Password"] }, keyword: "enum" },
			{
				name: "additional unexpected property",
				answer: { selected: ["JWT"], surprise: true },
				keyword: "additionalProperties",
			},
			{ name: "missing selected", answer: { custom: "JWT" }, keyword: "required" },
			{ name: "custom not a string", answer: { selected: [], other: true, custom: 42 }, keyword: "type" },
		];

		for (const c of cases) {
			const { gate, resolution } = await resolveQuestion(singleQ, c.answer);
			expect(resolution.status, c.name).toBe("rejected");
			expect(resolution.error?.code, c.name).toBe("invalid_workflow_gate_answer");
			expect(resolution.error?.schema_hash, c.name).toBe(gate.schema_hash);
			expect(
				resolution.error?.errors.some(e => e.keyword === c.keyword),
				c.name,
			).toBe(true);
		}
	});

	it("rejects semantically invalid but schema-shaped answers during decoding", () => {
		const cases: Array<{ name: string; answer: unknown; code: DeepInterviewGateError["code"] }> = [
			{ name: "empty selected", answer: { selected: [] }, code: "empty_selection" },
			{ name: "unknown option", answer: { selected: ["Password"] }, code: "unknown_option" },
			{
				name: "two selections on single question",
				answer: { selected: ["JWT", "OAuth2"] },
				code: "multi_not_allowed",
			},
			{ name: "Other without custom", answer: { selected: [], other: true }, code: "missing_custom" },
			{ name: "Other with empty custom", answer: { selected: [], other: true, custom: "" }, code: "missing_custom" },
			{
				name: "Other with whitespace custom",
				answer: { selected: [], other: true, custom: " \t\n " },
				code: "missing_custom",
			},
		];

		for (const c of cases) {
			expect(() => gateAnswerToResult(singleQ, c.answer), c.name).toThrow(DeepInterviewGateError);
			try {
				gateAnswerToResult(singleQ, c.answer);
			} catch (error) {
				expect(error).toMatchObject({ code: c.code });
			}
		}
	});

	it("marks the recommended option description", () => {
		const gate = questionToGate(singleQ);
		expect(gate.options?.map(o => ({ label: o.label, description: o.description }))).toEqual([
			{ label: "JWT", description: undefined },
			{ label: "OAuth2", description: "recommended" },
			{ label: "Session cookies", description: undefined },
		]);
	});

	it("supports zero-option questions as Other-only gates", async () => {
		const zeroQ: AskGateQuestion = {
			id: "zero-options",
			question: "What constraint is missing?",
			options: [],
		};
		const gate = questionToGate(zeroQ);
		expect(gate.options).toEqual([]);
		expect(gate.schema.properties?.selected?.items?.enum).toEqual([]);

		const answer = { selected: [], other: true, custom: "No cloud dependencies" };
		const broker = new WorkflowGateBroker("run-zero-options", new MemoryGateStore());
		const emitted = broker.openGate(questionToGate(zeroQ));
		const resolution = await broker.resolve({ gate_id: emitted.gate_id, answer });
		expect(resolution.status).toBe("accepted");
		expect(gateAnswerToResult(zeroQ, answer)).toEqual({
			id: "zero-options",
			question: "What constraint is missing?",
			options: [],
			multi: false,
			selectedOptions: [],
			customInput: "No cloud dependencies",
		});
	});

	it("advertises the same schema_hash the broker uses for validation", async () => {
		const broker = new WorkflowGateBroker("run-schema-agreement", new MemoryGateStore());
		const gate = broker.openGate(questionToGate(singleQ));
		expect(gate.schema_hash).toBe(schemaHash(gate.schema));

		const rejected = await broker.resolve({ gate_id: gate.gate_id, answer: { selected: ["Password"] } });
		expect(rejected.status).toBe("rejected");
		expect(rejected.error?.schema_hash).toBe(gate.schema_hash);
	});
});

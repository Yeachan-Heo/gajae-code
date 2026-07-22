import { describe, expect, it } from "bun:test";
import { askSchema } from "@gajae-code/coding-agent/tools/ask";
import {
	type AskGateQuestion,
	DeepInterviewGateError,
	gateAnswerToResult,
	questionToGate,
} from "../src/modes/shared/agent-wire/deep-interview-gate";
import {
	type GateContinuation,
	MemoryGateStore,
	WorkflowGateBroker,
} from "../src/modes/shared/agent-wire/workflow-gate-broker";
import { schemaHash } from "../src/modes/shared/agent-wire/workflow-gate-schema";

function activeContinuation(): GateContinuation {
	const activeGateIds = new Set<string>();
	return {
		activate: gate => activeGateIds.add(gate.gate_id),
		terminalProof: "not_published",
		isLive: gateId => activeGateIds.has(gateId),
		release: gateId => activeGateIds.delete(gateId),
	};
}

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
	const advanced: unknown[] = [];
	const broker = new WorkflowGateBroker(`run-${question.id}`, new MemoryGateStore(), {
		advance: (_gate, acceptedAnswer) => {
			advanced.push(acceptedAnswer);
		},
	});
	const gate = broker.openGate(questionToGate(question), activeContinuation());
	const resolution = await broker.resolve({ gate_id: gate.gate_id, answer });
	return { advanced, gate, resolution };
}

describe("deep-interview question gates red-team", () => {
	it("round-trips single, multi, and Other free-text answers through the broker to the human-path QuestionResult", async () => {
		const single = await resolveQuestion(singleQ, { selected: ["JWT"] });
		expect(single.resolution.status).toBe("accepted");
		expect(single.advanced).toEqual([{ selected: ["JWT"] }]);
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
		expect(multi.advanced).toEqual([{ selected: ["SQLite", "S3"] }]);
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
		expect(other.advanced).toEqual([otherAnswer]);
		expect(gateAnswerToResult(freeTextQ, otherAnswer)).toEqual({
			id: "free-text",
			question: "Which deployment target did we miss?",
			options: ["Vercel", "Fly.io"],
			multi: false,
			selectedOptions: [],
			customInput: "Bare metal",
		});

		const multiOtherAnswer = { selected: ["SQLite"], other: true, custom: "S3-compatible" };
		const multiOther = await resolveQuestion(multiQ, multiOtherAnswer);
		expect(multiOther.resolution.status).toBe("accepted");
		expect(multiOther.advanced).toEqual([multiOtherAnswer]);
		expect(gateAnswerToResult(multiQ, multiOtherAnswer)).toEqual({
			id: "multi-storage",
			question: "Which storage backends should be supported?",
			options: ["SQLite", "Postgres", "S3"],
			multi: true,
			selectedOptions: ["SQLite"],
			customInput: "S3-compatible",
		});
		const clarificationAnswer = { action: "clarify", question: "What is the difference between JWT and OAuth2?" };
		const clarification = await resolveQuestion(singleQ, clarificationAnswer);
		expect(clarification.resolution.status).toBe("accepted");
		expect(clarification.advanced).toEqual([clarificationAnswer]);
		expect(gateAnswerToResult(singleQ, clarificationAnswer)).toEqual({
			id: "single-auth",
			question: "Which auth method should we use?",
			options: ["JWT", "OAuth2", "Session cookies"],
			multi: false,
			selectedOptions: [],
			clarificationQuestion: "What is the difference between JWT and OAuth2?",
		});
	});

	it("rejects malformed answers against the advertised schema via the broker", async () => {
		const cases: Array<{ name: string; answer: unknown; keyword: string }> = [
			{ name: "selected not an array", answer: { selected: "JWT" }, keyword: "type" },
			{ name: "selected item outside enum", answer: { selected: ["Password"] }, keyword: "enum" },
			{
				name: "single-select combines option and Other",
				answer: { selected: ["JWT"], other: true, custom: "Passkeys" },
				keyword: "anyOf",
			},
			{
				name: "additional unexpected property",
				answer: { selected: ["JWT"], surprise: true },
				keyword: "additionalProperties",
			},
			{ name: "missing selected", answer: { custom: "JWT" }, keyword: "anyOf" },
			{ name: "custom not a string", answer: { selected: [], other: true, custom: 42 }, keyword: "type" },
			{
				name: "clarification combines selected option",
				answer: { action: "clarify", question: "Which one?", selected: ["JWT"] },
				keyword: "anyOf",
			},
			{
				name: "clarification with empty question",
				answer: { action: "clarify", question: "" },
				keyword: "minLength",
			},
		];

		for (const c of cases) {
			const { advanced, gate, resolution } = await resolveQuestion(singleQ, c.answer);
			expect(resolution.status, c.name).toBe("rejected");
			expect(advanced, c.name).toEqual([]);
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
			{
				name: "clarification with whitespace question",
				answer: { action: "clarify", question: " \t\n " },
				code: "missing_clarification",
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
		expect(gate.options?.map(o => ({ value: o.value, label: o.label, description: o.description }))).toEqual([
			{ value: "JWT", label: "JWT", description: undefined },
			{ value: "OAuth2", label: "OAuth2", description: "recommended" },
			{ value: "Session cookies", label: "Session cookies", description: undefined },
		]);
		expect(gate.context?.stage_state).toMatchObject({ other_option: "Other (type your own)" });
	});

	it("supports zero-option questions as free-text gates without advertising Other as a selectable option", async () => {
		const zeroQ: AskGateQuestion = {
			id: "zero-options",
			question: "What constraint is missing?",
			options: [],
		};
		const gate = questionToGate(zeroQ);
		expect(gate.options).toEqual([]);
		expect(gate.context?.stage_state).toMatchObject({
			question_id: "zero-options",
			options: [],
			other_option: "Other (type your own)",
		});
		expect(gate.schema.properties?.selected?.items?.enum).toEqual([]);

		const answer = { selected: [], other: true, custom: "No cloud dependencies" };
		const advanced: unknown[] = [];
		const broker = new WorkflowGateBroker("run-zero-options", new MemoryGateStore(), {
			advance: (_gate, acceptedAnswer) => {
				advanced.push(acceptedAnswer);
			},
		});
		const emitted = broker.openGate(questionToGate(zeroQ), activeContinuation());
		const resolution = await broker.resolve({ gate_id: emitted.gate_id, answer });
		expect(resolution.status).toBe("accepted");
		expect(advanced).toEqual([answer]);
		expect(gateAnswerToResult(zeroQ, answer)).toEqual({
			id: "zero-options",
			question: "What constraint is missing?",
			options: [],
			multi: false,
			selectedOptions: [],
			customInput: "No cloud dependencies",
		});
	});

	it("keeps generic pick-first SDK workflow-gate consumers safe for zero-option questions", async () => {
		const zeroQ: AskGateQuestion = {
			id: "zero-options-generic",
			question: "What constraint is missing?",
			options: [],
		};
		const gate = questionToGate(zeroQ);
		const first = gate.options?.[0]?.value;
		expect(first).toBeUndefined();
		expect(typeof first).not.toBe("object");

		const genericAnswer =
			first !== undefined
				? { selected: [first], other: false }
				: { selected: [], other: true, custom: "memory-derived answer" };
		const advanced: unknown[] = [];
		const broker = new WorkflowGateBroker("run-zero-options-generic", new MemoryGateStore(), {
			advance: (_gate, acceptedAnswer) => {
				advanced.push(acceptedAnswer);
			},
		});
		const emitted = broker.openGate(gate, activeContinuation());
		const resolution = await broker.resolve({ gate_id: emitted.gate_id, answer: genericAnswer });
		expect(resolution.status).toBe("accepted");
		expect(advanced).toEqual([genericAnswer]);
		expect(gateAnswerToResult(zeroQ, genericAnswer).customInput).toBe("memory-derived answer");
	});

	it("advertises the same schema_hash the broker uses for validation", async () => {
		const advanced: unknown[] = [];
		const broker = new WorkflowGateBroker("run-schema-agreement", new MemoryGateStore(), {
			advance: (_gate, acceptedAnswer) => {
				advanced.push(acceptedAnswer);
			},
		});
		const gate = broker.openGate(questionToGate(singleQ), activeContinuation());
		expect(gate.schema_hash).toBe(schemaHash(gate.schema));

		const rejected = await broker.resolve({ gate_id: gate.gate_id, answer: { selected: ["Password"] } });
		expect(rejected.status).toBe("rejected");
		expect(advanced).toEqual([]);
		expect(rejected.error?.schema_hash).toBe(gate.schema_hash);
	});
});

describe("deep-interview structured metadata red-team", () => {
	it("does not alter selection or free-text decoding when metadata is present", async () => {
		const withMeta: AskGateQuestion = {
			...singleQ,
			deepInterview: { round: 1, component: "conflict-detection", dimension: "goal", ambiguity: 0.6 },
		};
		const selection = await resolveQuestion(withMeta, { selected: ["JWT"] });
		expect(selection.resolution.status).toBe("accepted");
		expect(gateAnswerToResult(withMeta, { selected: ["JWT"] }).selectedOptions).toEqual(["JWT"]);

		const free = await resolveQuestion(withMeta, { selected: [], other: true, custom: "Passkeys" });
		expect(free.resolution.status).toBe("accepted");
		expect(gateAnswerToResult(withMeta, { selected: [], other: true, custom: "Passkeys" }).customInput).toBe(
			"Passkeys",
		);
	});

	it("rejects invalid deepInterview metadata at the ask schema boundary", () => {
		const base = { id: "q1", question: "Q?", options: [{ label: "A" }] };
		// ambiguity out of range
		expect(
			askSchema.safeParse({
				questions: [{ ...base, deepInterview: { round: 1, component: "c", dimension: "goal", ambiguity: 1.5 } }],
			}).success,
		).toBe(false);
		// missing required round
		expect(
			askSchema.safeParse({
				questions: [{ ...base, deepInterview: { component: "c", dimension: "goal", ambiguity: 0.5 } }],
			}).success,
		).toBe(false);
		// empty component
		expect(
			askSchema.safeParse({
				questions: [{ ...base, deepInterview: { round: 1, component: "", dimension: "goal", ambiguity: 0.5 } }],
			}).success,
		).toBe(false);
		// valid metadata accepted
		expect(
			askSchema.safeParse({
				questions: [
					{
						...base,
						deepInterview: { round_id: "r1", round: 1, component: "c", dimension: "goal", ambiguity: 0.5 },
					},
				],
			}).success,
		).toBe(true);
		// absent metadata still valid (backward compatible)
		expect(askSchema.safeParse({ questions: [base] }).success).toBe(true);
	});

	it("accepts emoji adapter metadata using the schema's code-point limits", () => {
		const term = "😀".repeat(256);
		const longText = "😀".repeat(2048);
		const parsed = askSchema.safeParse({
			questions: [
				{
					id: "q-emoji-boundary",
					question: "Q?",
					options: [{ label: "A" }],
					deepInterview: {
						round_id: "😀".repeat(128),
						round: 1,
						component: "😀".repeat(128),
						dimension: "😀".repeat(128),
						ambiguity: 0.5,
						confused_terms: [term],
						references: [{ reference_id: term, label: term, origin: term, url: longText, excerpt: longText }],
					},
				},
			],
		});

		expect(parsed.success).toBe(true);
	});

	it("rejects emoji deep-interview core metadata beyond 128 code points", () => {
		const base = { id: "q-core-overflow", question: "Q?", options: [{ label: "A" }] };
		for (const field of ["round_id", "component", "dimension"] as const) {
			const deepInterview = {
				round_id: "r1",
				round: 1,
				component: "c",
				dimension: "goal",
				ambiguity: 0.5,
				[field]: "😀".repeat(129),
			};
			expect(askSchema.safeParse({ questions: [{ ...base, deepInterview }] }).success).toBe(false);
		}
	});

	it("rejects emoji reference URL and excerpt values one code point beyond their limits", () => {
		const base = { id: "q-reference-overflow", question: "Q?", options: [{ label: "A" }] };
		for (const field of ["url", "excerpt"] as const) {
			const parsed = askSchema.safeParse({
				questions: [
					{
						...base,
						deepInterview: {
							round: 1,
							component: "intake",
							dimension: "goal",
							ambiguity: 0.5,
							references: [{ reference_id: "r1", label: "label", origin: "user", [field]: "😀".repeat(2049) }],
						},
					},
				],
			});
			expect(parsed.success).toBe(false);
		}
	});

	describe("Round-0 locked intent contracts", () => {
		const base = { id: "intent-q", question: "Confirm intent", options: [{ label: "Confirm" }] };
		const validContract = {
			items: [{ id: "artifact:report", category: "artifact", statement: "Produce an audit report" }],
			confirmation_options: ["Confirm"],
		};
		function parsed(contract: unknown, round = 0) {
			return askSchema.safeParse({
				questions: [
					{
						...base,
						deepInterview: {
							round,
							component: "review-topology",
							dimension: "topology",
							ambiguity: 0.5,
							intent_contract: contract,
						},
					},
				],
			}).success;
		}

		it("accepts a valid Round-0 contract and rejects invalid contract shapes at the ask boundary", () => {
			expect(parsed(validContract)).toBe(true);
			expect(parsed(validContract, 1)).toBe(false);
			expect(
				askSchema.safeParse({
					questions: [
						{
							...base,
							deepInterview: {
								round: 0,
								component: "unrelated-component",
								dimension: "topology",
								ambiguity: 0.5,
								intent_contract: validContract,
							},
						},
					],
				}).success,
			).toBe(false);
			expect(
				parsed({ items: [{ id: "artifact:report", category: "unknown", statement: "Produce an audit report" }] }),
			).toBe(false);
			expect(
				parsed({ items: [{ id: "surface:report", category: "artifact", statement: "Produce an audit report" }] }),
			).toBe(false);
			expect(parsed({ items: [{ id: "artifact:report", category: "artifact", statement: "" }] })).toBe(false);
			expect(
				parsed({ items: [{ id: "artifact:report", category: "artifact", statement: "x".repeat(1_001) }] }),
			).toBe(false);
			expect(
				parsed({ items: [{ id: "artifact:report", category: "artifact", statement: "Produce", extra: true }] }),
			).toBe(false);
			expect(
				parsed({
					items: Array.from({ length: 65 }, (_, index) => ({
						id: `artifact:report-${index}`,
						category: "artifact",
						statement: "Produce",
					})),
				}),
			).toBe(false);
		});

		it("accepts bounded post-Round-0 reduction review metadata", () => {
			const intentReview = {
				observed_items: [{ id: "artifact:report", category: "artifact", statement: "Produce a report" }],
				supporting_substitutions: [
					{
						removed_id: "surface:review",
						replacement_ids: ["artifact:report"],
						rationale: "Report replaces review",
					},
				],
				approval_options: ["Approve reduction"],
			};
			const question = (round: number, review: unknown) => ({
				...base,
				options: [{ label: "Approve reduction" }, { label: "Revise spec" }],
				deepInterview: {
					round,
					component: "locked-intent",
					dimension: "constraints",
					ambiguity: 0.2,
					intent_review: review,
				},
			});
			expect(askSchema.safeParse({ questions: [question(2, intentReview)] }).success).toBe(true);
			expect(askSchema.safeParse({ questions: [question(0, intentReview)] }).success).toBe(false);
			expect(
				askSchema.safeParse({ questions: [question(2, { ...intentReview, approval_options: [] })] }).success,
			).toBe(false);
			expect(
				askSchema.safeParse({
					questions: [
						question(2, {
							...intentReview,
							supporting_substitutions: [{ ...intentReview.supporting_substitutions[0], extra: true }],
						}),
					],
				}).success,
			).toBe(false);
		});
	});
});
